/**
 * WebSocket Server for Agent Communication
 * Provides low-latency message delivery bypassing file-based triggers
 */

const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const log = require('./logger');
const {
  LEGACY_ROLE_ALIASES,
  ROLE_ID_MAP,
  WORKSPACE_PATH,
  resolveCoordPath,
  resolveBackgroundBuilderAlias,
  resolveBackgroundBuilderPaneId,
} = require('../config');

const DEFAULT_PORT = 9900;
const MESSAGE_ACK_TTL_MS = 60000;
const ROUTING_STALE_MS = 60000;
const RATE_LIMIT_WINDOW_MS = 1000;  // 1-second sliding window
const RATE_LIMIT_MAX_MESSAGES = 50; // max messages per window per client
const MAX_MESSAGE_SIZE = 256 * 1024; // 256KB max message size
const CONTENT_DEDUPE_TTL_MS = Number.parseInt(process.env.SQUIDRUN_COMMS_CONTENT_DEDUPE_TTL_MS || '15000', 10);
const OUTBOUND_QUEUE_MAX_ENTRIES = Number.parseInt(process.env.SQUIDRUN_COMMS_QUEUE_MAX_ENTRIES || '500', 10);
const OUTBOUND_QUEUE_MAX_AGE_MS = Number.parseInt(process.env.SQUIDRUN_COMMS_QUEUE_MAX_AGE_MS || String(30 * 60 * 1000), 10);
const OUTBOUND_QUEUE_FLUSH_INTERVAL_MS = Number.parseInt(process.env.SQUIDRUN_COMMS_QUEUE_FLUSH_INTERVAL_MS || '30000', 10);
const DEFAULT_QUEUE_SESSION_SCOPE = 'default';
const CANONICAL_ROLE_IDS = ['architect', 'builder', 'oracle'];
const CANONICAL_ROLE_TO_PANE = new Map(
  CANONICAL_ROLE_IDS
    .map((role) => [role, String(ROLE_ID_MAP?.[role] || '')])
    .filter(([, paneId]) => Boolean(paneId))
);
const PANE_TO_CANONICAL_ROLE = new Map(
  Array.from(CANONICAL_ROLE_TO_PANE.entries()).map(([role, paneId]) => [paneId, role])
);
let wss = null;
let clients = new Map(); // clientId -> { ws, paneId, role }
let clientIdCounter = 0;
let messageHandler = null; // External handler for incoming messages
let recentMessageAcks = new Map(); // messageId -> { ackPayload, expiresAt }
let pendingMessageAcks = new Map(); // messageId -> Promise<ackPayload>
let recentDispatchAcks = new Map(); // dedupeKey -> { ackPayload, expiresAt }
let pendingDispatchAcks = new Map(); // dedupeKey -> Promise<ackPayload>
let outboundQueue = []; // [{ id, target, content, meta, createdAt, attempts, lastAttemptAt, queuedBy }]
let outboundQueueFlushTimer = null;
let outboundQueueFlushInProgress = false;
let queueSessionScopeId = DEFAULT_QUEUE_SESSION_SCOPE;
let startInFlightPromise = null;

function generateTraceToken(prefix = 'evt') {
  try {
    return `${prefix}-${crypto.randomUUID()}`;
  } catch (_err) {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

function toNonEmptyString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function getDefaultOutboundQueuePath() {
  if (typeof resolveCoordPath === 'function') {
    return resolveCoordPath(path.join('state', 'comms-outbound-queue.json'), { forWrite: true });
  }
  return path.join(WORKSPACE_PATH, 'state', 'comms-outbound-queue.json');
}

function getOutboundQueuePath() {
  const envPath = toNonEmptyString(process.env.SQUIDRUN_COMMS_QUEUE_FILE);
  if (envPath) {
    return path.resolve(envPath);
  }
  return getDefaultOutboundQueuePath();
}

function normalizePaneId(paneId) {
  if (paneId === null || paneId === undefined) return null;
  const normalized = String(paneId).trim();
  return normalized ? normalized : null;
}

function normalizeRoleId(role) {
  if (typeof role !== 'string') return null;
  const normalized = role.trim().toLowerCase();
  if (!normalized) return null;
  if (CANONICAL_ROLE_IDS.includes(normalized)) return normalized;
  if (LEGACY_ROLE_ALIASES?.[normalized]) {
    return LEGACY_ROLE_ALIASES[normalized];
  }
  const mappedPaneId = ROLE_ID_MAP?.[normalized];
  if (mappedPaneId) {
    return PANE_TO_CANONICAL_ROLE.get(String(mappedPaneId)) || null;
  }
  return null;
}

function getPaneIdForRole(role) {
  if (!role) return null;
  return CANONICAL_ROLE_TO_PANE.get(role) || null;
}

function getRoleForPaneId(paneId) {
  if (!paneId) return null;
  return PANE_TO_CANONICAL_ROLE.get(String(paneId)) || null;
}

function markClientSeen(clientId, source = 'message', now = Date.now()) {
  const clientInfo = clients.get(clientId);
  if (!clientInfo) return null;
  clientInfo.lastSeen = now;
  return {
    role: clientInfo.role || null,
    paneId: clientInfo.paneId || null,
    lastSeen: now,
    source,
  };
}

function coerceStaleAfterMs(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return ROUTING_STALE_MS;
  }
  return parsed;
}

function resolveTargetIdentity(target) {
  if (target === null || target === undefined) {
    return { role: null, paneId: null };
  }

  const rawTarget = String(target).trim().toLowerCase();
  if (!rawTarget) {
    return { role: null, paneId: null };
  }

  const backgroundPaneId = typeof resolveBackgroundBuilderPaneId === 'function'
    ? resolveBackgroundBuilderPaneId(rawTarget)
    : null;
  if (backgroundPaneId) {
    const backgroundAlias = typeof resolveBackgroundBuilderAlias === 'function'
      ? resolveBackgroundBuilderAlias(rawTarget)
      : null;
    return {
      role: backgroundAlias,
      paneId: backgroundPaneId,
    };
  }

  const paneId = normalizePaneId(rawTarget);
  if (paneId && PANE_TO_CANONICAL_ROLE.has(paneId)) {
    return {
      role: getRoleForPaneId(paneId),
      paneId,
    };
  }

  const role = normalizeRoleId(rawTarget);
  if (!role) {
    return { role: null, paneId: null };
  }

  return {
    role,
    paneId: getPaneIdForRole(role),
  };
}

function getRoutingHealth(target, staleAfterMs = ROUTING_STALE_MS, now = Date.now()) {
  const staleThresholdMs = coerceStaleAfterMs(staleAfterMs);
  const identity = resolveTargetIdentity(target);
  if (!identity.role && !identity.paneId) {
    return {
      healthy: false,
      status: 'invalid_target',
      role: null,
      paneId: null,
      lastSeen: null,
      ageMs: null,
      staleThresholdMs,
      source: null,
    };
  }

  let route = null;
  for (const info of clients.values()) {
    if (!info) continue;
    if (identity.role && info.role === identity.role) {
      route = info;
      break;
    }
    if (identity.paneId && info.paneId && String(info.paneId) === String(identity.paneId)) {
      route = info;
      break;
    }
  }

  if (!route || !Number.isFinite(route.lastSeen)) {
    return {
      healthy: false,
      status: 'no_route',
      role: identity.role || route?.role || null,
      paneId: identity.paneId || route?.paneId || null,
      lastSeen: null,
      ageMs: null,
      staleThresholdMs,
      source: null,
    };
  }

  const ageMs = Math.max(0, now - route.lastSeen);
  const healthy = ageMs <= staleThresholdMs;

  return {
    healthy,
    status: healthy ? 'healthy' : 'stale',
    role: identity.role || route.role || null,
    paneId: identity.paneId || route.paneId || null,
    lastSeen: route.lastSeen,
    ageMs,
    staleThresholdMs,
    source: 'client_activity',
  };
}

async function emitCommsMetric(clientId, clientInfo, eventType, payload = {}) {
  if (!messageHandler || !eventType) return;
  try {
    await messageHandler({
      clientId,
      paneId: clientInfo?.paneId,
      role: clientInfo?.role,
      message: {
        type: 'comms-metric',
        eventType,
        payload,
      },
    });
  } catch (err) {
    log.warn('WebSocket', `Failed to emit comms metric ${eventType}: ${err.message}`);
  }
}

function emitAckLatencyMetric(clientId, clientInfo, message, ackPayload, receivedAtMs) {
  if (!ackPayload || !Number.isFinite(receivedAtMs)) return;
  const ackLatencyMs = Math.max(0, Date.now() - receivedAtMs);
  ackPayload.ackLatencyMs = ackLatencyMs;
  void emitCommsMetric(clientId, clientInfo, 'comms.ack.latency', {
    ackLatencyMs,
    messageType: message?.type || null,
    messageId: message?.messageId || null,
    target: message?.target || null,
    status: ackPayload.status || null,
    verified: ackPayload.verified === true,
    wsDeliveryCount: Number(ackPayload.wsDeliveryCount) || 0,
  });
}

function sendJson(ws, payload) {
  if (!ws || ws.readyState !== 1) return false;
  try {
    ws.send(JSON.stringify(payload));
    return true;
  } catch (err) {
    log.error('WebSocket', `Failed to send JSON payload: ${err.message}`);
    return false;
  }
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeQueueSessionScopeId(value) {
  if (typeof value !== 'string') return DEFAULT_QUEUE_SESSION_SCOPE;
  const trimmed = value.trim();
  return trimmed || DEFAULT_QUEUE_SESSION_SCOPE;
}

function getQueueMaxEntries() {
  return parsePositiveInt(OUTBOUND_QUEUE_MAX_ENTRIES, 500);
}

function getQueueMaxAgeMs() {
  return parsePositiveInt(OUTBOUND_QUEUE_MAX_AGE_MS, 30 * 60 * 1000);
}

function getQueueFlushIntervalMs() {
  return parsePositiveInt(OUTBOUND_QUEUE_FLUSH_INTERVAL_MS, 30000);
}

function getQueueDirPath() {
  return path.dirname(getOutboundQueuePath());
}

function ensureQueueDir() {
  fs.mkdirSync(getQueueDirPath(), { recursive: true });
}

function makeQueueEntry(target, content, meta = {}, queuedBy = 'runtime', now = Date.now()) {
  return {
    id: `oq-${now}-${Math.random().toString(36).slice(2, 8)}`,
    target: String(target),
    content: String(content ?? ''),
    meta: (meta && typeof meta === 'object') ? meta : {},
    createdAt: now,
    attempts: 0,
    lastAttemptAt: null,
    sessionScopeId: queueSessionScopeId,
    queuedBy,
  };
}

function isQueueEntry(entry) {
  return Boolean(
    entry
    && typeof entry === 'object'
    && typeof entry.target === 'string'
    && typeof entry.content === 'string'
  );
}

function normalizeQueueEntries(rawEntries, now = Date.now()) {
  if (!Array.isArray(rawEntries)) return [];
  const maxAgeMs = getQueueMaxAgeMs();
  const normalized = [];
  for (const item of rawEntries) {
    if (!isQueueEntry(item)) continue;
    const createdAt = Number.isFinite(item.createdAt) ? item.createdAt : now;
    if (createdAt + maxAgeMs <= now) continue;
    normalized.push({
      id: typeof item.id === 'string' ? item.id : `oq-${createdAt}-${Math.random().toString(36).slice(2, 8)}`,
      target: item.target,
      content: item.content,
      meta: (item.meta && typeof item.meta === 'object') ? item.meta : {},
      createdAt,
      attempts: Number.isFinite(item.attempts) ? item.attempts : 0,
      lastAttemptAt: Number.isFinite(item.lastAttemptAt) ? item.lastAttemptAt : null,
      sessionScopeId: normalizeQueueSessionScopeId(item.sessionScopeId || queueSessionScopeId),
      queuedBy: typeof item.queuedBy === 'string' ? item.queuedBy : 'runtime',
    });
  }
  const maxEntries = getQueueMaxEntries();
  return normalized.slice(Math.max(0, normalized.length - maxEntries));
}

function persistOutboundQueue() {
  try {
    const queuePath = getOutboundQueuePath();
    ensureQueueDir();
    const payload = JSON.stringify({
      version: 2,
      sessionScopeId: queueSessionScopeId,
      entries: outboundQueue,
    }, null, 2);
    const tmpPath = `${queuePath}.tmp`;
    fs.writeFileSync(tmpPath, payload, 'utf-8');
    fs.renameSync(tmpPath, queuePath);
  } catch (err) {
    log.error('WebSocket', `Failed to persist outbound queue: ${err.message}`);
  }
}

function loadOutboundQueue() {
  try {
    const queuePath = getOutboundQueuePath();
    if (!fs.existsSync(queuePath)) {
      outboundQueue = [];
      return;
    }
    const raw = fs.readFileSync(queuePath, 'utf-8');
    const parsed = JSON.parse(raw);

    // Legacy v1 format: raw array. Discard on startup to avoid cross-session ghost replays.
    if (Array.isArray(parsed)) {
      outboundQueue = [];
      persistOutboundQueue();
      log.info('WebSocket', 'Discarded legacy outbound queue on startup (session scope enforced)');
      return;
    }

    const fileScopeId = normalizeQueueSessionScopeId(parsed?.sessionScopeId);
    const fileEntries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    if (fileScopeId !== queueSessionScopeId) {
      outboundQueue = [];
      persistOutboundQueue();
      log.info('WebSocket', `Discarded outbound queue from prior session scope (${fileScopeId} -> ${queueSessionScopeId})`);
      return;
    }

    outboundQueue = normalizeQueueEntries(fileEntries).filter(
      (entry) => normalizeQueueSessionScopeId(entry.sessionScopeId) === queueSessionScopeId
    );
    if (!Array.isArray(parsed?.entries) || fileEntries.length !== outboundQueue.length) {
      persistOutboundQueue();
    }
  } catch (err) {
    outboundQueue = [];
    log.warn('WebSocket', `Failed to load outbound queue. Resetting queue: ${err.message}`);
    persistOutboundQueue();
  }
}

function pruneOutboundQueue(now = Date.now()) {
  if (outboundQueue.length === 0) return;
  const maxAgeMs = getQueueMaxAgeMs();
  const maxEntries = getQueueMaxEntries();
  const previousLength = outboundQueue.length;
  outboundQueue = outboundQueue.filter((entry) => Number.isFinite(entry.createdAt) && (entry.createdAt + maxAgeMs > now));
  if (outboundQueue.length > maxEntries) {
    const dropCount = outboundQueue.length - maxEntries;
    outboundQueue = outboundQueue.slice(dropCount);
  }
  if (outboundQueue.length !== previousLength) {
    persistOutboundQueue();
  }
}

function queueOutboundMessage(target, content, meta = {}, queuedBy = 'runtime', now = Date.now()) {
  pruneOutboundQueue(now);
  const maxEntries = getQueueMaxEntries();
  if (outboundQueue.length >= maxEntries) {
    outboundQueue.shift();
  }
  outboundQueue.push(makeQueueEntry(target, content, meta, queuedBy, now));
  persistOutboundQueue();
}

function buildOutboundPayload(content, meta = {}) {
  const traceContext = meta?.traceContext || null;
  const messageMetadata = (meta?.metadata && typeof meta.metadata === 'object' && !Array.isArray(meta.metadata))
    ? meta.metadata
    : null;
  return JSON.stringify({
    type: 'message',
    from: meta.from || 'system',
    priority: meta.priority || 'normal',
    content,
    metadata: messageMetadata,
    traceId: traceContext?.traceId || null,
    parentEventId: traceContext?.parentEventId || null,
    eventId: traceContext?.eventId || null,
    timestamp: Date.now(),
  });
}

function matchClientsForTarget(target) {
  const targetStr = String(target);
  const targetRole = targetStr.toLowerCase();
  const matched = [];
  for (const [clientId, info] of clients) {
    const paneMatch = info.paneId !== null && String(info.paneId) === targetStr;
    const roleMatch = typeof info.role === 'string' && info.role.toLowerCase() === targetRole;
    if (paneMatch || roleMatch) {
      matched.push([clientId, info]);
    }
  }
  return matched;
}

function deliverToTargetNow(target, content, meta = {}) {
  const payload = buildOutboundPayload(content, meta);
  let sent = false;
  const matched = matchClientsForTarget(target);
  for (const [clientId, info] of matched) {
    if (info.ws.readyState !== 1) continue;
    try {
      info.ws.send(payload);
      sent = true;
      log.info('WebSocket', `Sent to ${target} (client ${clientId}): ${String(content).substring(0, 50)}...`);
    } catch (err) {
      log.warn('WebSocket', `Failed sending to ${target} (client ${clientId}): ${err.message}`);
    }
  }
  return sent;
}

function targetMatchesClient(target, info) {
  const targetStr = String(target);
  const targetRole = targetStr.toLowerCase();
  const paneMatch = info.paneId !== null && String(info.paneId) === targetStr;
  const roleMatch = typeof info.role === 'string' && info.role.toLowerCase() === targetRole;
  return paneMatch || roleMatch;
}

function flushOutboundQueueForClient(clientId, source = 'register') {
  const info = clients.get(clientId);
  if (!info || outboundQueue.length === 0) return 0;
  if (outboundQueueFlushInProgress) return 0;
  pruneOutboundQueue();
  if (outboundQueue.length === 0) return 0;

  outboundQueueFlushInProgress = true;
  let deliveredCount = 0;
  let queueChanged = false;
  try {
    const retained = [];
    for (const entry of outboundQueue) {
      if (!targetMatchesClient(entry.target, info)) {
        retained.push(entry);
        continue;
      }
      const sent = deliverToTargetNow(entry.target, entry.content, entry.meta);
      if (sent) {
        deliveredCount += 1;
        queueChanged = true;
      } else {
        entry.attempts = (entry.attempts || 0) + 1;
        entry.lastAttemptAt = Date.now();
        retained.push(entry);
      }
    }
    if (retained.length !== outboundQueue.length || queueChanged) {
      outboundQueue = retained;
      persistOutboundQueue();
    }
  } finally {
    outboundQueueFlushInProgress = false;
  }

  if (deliveredCount > 0) {
    log.info('WebSocket', `Flushed ${deliveredCount} queued message(s) for client ${clientId} via ${source}`);
  }
  return deliveredCount;
}

function flushOutboundQueue(source = 'timer') {
  if (outboundQueue.length === 0) return 0;
  if (outboundQueueFlushInProgress) return 0;
  pruneOutboundQueue();
  if (outboundQueue.length === 0) return 0;

  outboundQueueFlushInProgress = true;
  let deliveredCount = 0;
  let queueChanged = false;
  try {
    const retained = [];
    for (const entry of outboundQueue) {
      const sent = deliverToTargetNow(entry.target, entry.content, entry.meta);
      if (sent) {
        deliveredCount += 1;
        queueChanged = true;
      } else {
        entry.attempts = (entry.attempts || 0) + 1;
        entry.lastAttemptAt = Date.now();
        retained.push(entry);
      }
    }
    if (retained.length !== outboundQueue.length || queueChanged) {
      outboundQueue = retained;
      persistOutboundQueue();
    }
  } finally {
    outboundQueueFlushInProgress = false;
  }

  if (deliveredCount > 0) {
    log.info('WebSocket', `Flushed ${deliveredCount} queued message(s) via ${source}`);
  }
  return deliveredCount;
}

function stopOutboundQueueTimer() {
  if (outboundQueueFlushTimer) {
    clearInterval(outboundQueueFlushTimer);
    outboundQueueFlushTimer = null;
  }
}

function startOutboundQueueTimer() {
  stopOutboundQueueTimer();
  outboundQueueFlushTimer = setInterval(() => {
    flushOutboundQueue('interval');
  }, getQueueFlushIntervalMs());
  if (typeof outboundQueueFlushTimer.unref === 'function') {
    outboundQueueFlushTimer.unref();
  }
}

function coerceAckResult(result) {
  if (!result || typeof result !== 'object') return null;
  const accepted = Object.prototype.hasOwnProperty.call(result, 'accepted')
    ? Boolean(result.accepted)
    : (Object.prototype.hasOwnProperty.call(result, 'success') ? Boolean(result.success) : Boolean(result.ok));
  const queued = Object.prototype.hasOwnProperty.call(result, 'queued')
    ? Boolean(result.queued)
    : accepted;
  const verified = Object.prototype.hasOwnProperty.call(result, 'verified')
    ? Boolean(result.verified)
    : Boolean(result.ok);
  const ok = Object.prototype.hasOwnProperty.call(result, 'ok')
    ? Boolean(result.ok)
    : verified;
  const status = result.status
    || (verified ? 'delivered.verified' : (accepted ? 'accepted.unverified' : 'failed'));

  if (
    Object.prototype.hasOwnProperty.call(result, 'ok')
    || Object.prototype.hasOwnProperty.call(result, 'success')
    || Object.prototype.hasOwnProperty.call(result, 'accepted')
    || Object.prototype.hasOwnProperty.call(result, 'verified')
  ) {
    return {
      ok,
      accepted,
      queued,
      verified,
      status,
      details: result,
    };
  }
  return null;
}

function isAckEligibleMessage(message) {
  return Boolean(message?.ackRequired && (message.type === 'send' || message.type === 'broadcast'));
}

function getNormalizedMessageId(message) {
  if (!message || typeof message.messageId !== 'string') return null;
  const trimmed = message.messageId.trim();
  return trimmed ? trimmed : null;
}

function buildTraceContext(message = {}) {
  const nested = (message?.traceContext && typeof message.traceContext === 'object')
    ? message.traceContext
    : {};
  const messageId = getNormalizedMessageId(message);
  const traceId = toNonEmptyString(nested.traceId)
    || toNonEmptyString(nested.correlationId)
    || toNonEmptyString(message.traceId)
    || toNonEmptyString(message.correlationId)
    || messageId
    || generateTraceToken('trc');
  const parentEventId = toNonEmptyString(nested.parentEventId)
    || toNonEmptyString(nested.causationId)
    || toNonEmptyString(message.parentEventId)
    || toNonEmptyString(message.causationId)
    || null;
  const eventId = toNonEmptyString(nested.eventId)
    || toNonEmptyString(message.eventId)
    || generateTraceToken('evt');

  return {
    traceId,
    parentEventId,
    eventId,
    correlationId: traceId,
    causationId: parentEventId,
    messageId,
  };
}

function pruneExpiredMessageAcks(now = Date.now()) {
  for (const [messageId, entry] of recentMessageAcks.entries()) {
    if (!entry || entry.expiresAt <= now) {
      recentMessageAcks.delete(messageId);
    }
  }
}

function cacheMessageAck(messageId, ackPayload, now = Date.now()) {
  if (!messageId || !ackPayload) return;
  recentMessageAcks.set(messageId, {
    ackPayload,
    expiresAt: now + MESSAGE_ACK_TTL_MS,
  });
}

function getContentDedupeTtlMs() {
  return Number.isFinite(CONTENT_DEDUPE_TTL_MS) && CONTENT_DEDUPE_TTL_MS > 0
    ? CONTENT_DEDUPE_TTL_MS
    : 15000;
}

function pruneExpiredDispatchAcks(now = Date.now()) {
  for (const [key, entry] of recentDispatchAcks.entries()) {
    if (!entry || entry.expiresAt <= now) {
      recentDispatchAcks.delete(key);
    }
  }
}

function cacheDispatchAck(dedupeKey, ackPayload, now = Date.now()) {
  if (!dedupeKey || !ackPayload) return;
  recentDispatchAcks.set(dedupeKey, {
    ackPayload,
    expiresAt: now + getContentDedupeTtlMs(),
  });
}

function buildDispatchDedupeKey(clientInfo, message = {}) {
  if (!message || (message.type !== 'send' && message.type !== 'broadcast')) return null;
  const senderRole = toNonEmptyString(clientInfo?.role) || null;
  const senderPane = normalizePaneId(clientInfo?.paneId);
  const target = message.type === 'send' ? toNonEmptyString(message.target) : '__broadcast__';
  const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
  if (!senderRole && !senderPane) return null;
  if (!target || !content) return null;

  const normalizedTarget = target.toLowerCase();
  const normalizedPriority = toNonEmptyString(message.priority) || 'normal';
  const material = [
    `t:${message.type}`,
    `r:${senderRole || ''}`,
    `p:${senderPane || ''}`,
    `g:${normalizedTarget}`,
    `q:${normalizedPriority}`,
    `c:${content}`,
  ].join('|');

  return crypto.createHash('sha1').update(material).digest('hex');
}

function buildDedupeAckPayload(baseAck, messageId, traceContext, dedupeMode, dedupeKey) {
  if (!baseAck || typeof baseAck !== 'object') return null;
  return {
    ...baseAck,
    type: 'send-ack',
    messageId: messageId || null,
    traceId: traceContext?.traceId || baseAck.traceId || messageId || null,
    parentEventId: traceContext?.parentEventId || baseAck.parentEventId || null,
    timestamp: Date.now(),
    dedupe: {
      mode: dedupeMode,
      key: dedupeKey || null,
      sourceMessageId: baseAck.messageId || null,
    },
  };
}

function getDeliveryCheckResult(messageId) {
  const normalizedMessageId = toNonEmptyString(messageId);
  if (!normalizedMessageId) {
    return {
      known: false,
      status: 'invalid_message_id',
      messageId: null,
      ack: null,
      pending: false,
    };
  }

  pruneExpiredMessageAcks();
  const cached = recentMessageAcks.get(normalizedMessageId);
  if (cached?.ackPayload) {
    return {
      known: true,
      status: 'cached',
      messageId: normalizedMessageId,
      ack: cached.ackPayload,
      pending: false,
    };
  }

  if (pendingMessageAcks.has(normalizedMessageId)) {
    return {
      known: true,
      status: 'pending',
      messageId: normalizedMessageId,
      ack: null,
      pending: true,
    };
  }

  return {
    known: false,
    status: 'unknown',
    messageId: normalizedMessageId,
    ack: null,
    pending: false,
  };
}

function closeServerQuietly(server) {
  if (!server) return;
  try {
    if (typeof server.removeAllListeners === 'function') {
      server.removeAllListeners();
    }
  } catch {
    // Best effort cleanup.
  }
  try {
    if (typeof server.close === 'function') {
      server.close();
    }
  } catch {
    // Best effort cleanup.
  }
}

/**
 * Start the WebSocket server
 * @param {object} options - Configuration options
 * @param {number} options.port - Port to listen on (default: 9900)
 * @param {function} options.onMessage - Handler for incoming messages
 * @returns {Promise<WebSocketServer>}
 */
function start(options = {}) {
  if (wss) {
    if (typeof options.onMessage === 'function') {
      messageHandler = options.onMessage;
    }
    return Promise.resolve(wss);
  }

  if (startInFlightPromise) {
    return startInFlightPromise;
  }

  const port = options.port ?? DEFAULT_PORT;
  const nextMessageHandler = options.onMessage || null;
  const nextSessionScopeId = normalizeQueueSessionScopeId(options.sessionScopeId);

  startInFlightPromise = new Promise((resolve, reject) => {
    let settled = false;
    let server = null;

    const rejectStart = (err) => {
      if (settled) return;
      settled = true;
      stopOutboundQueueTimer();
      closeServerQuietly(server);
      if (wss === server) {
        wss = null;
      }
      reject(err);
    };

    try {
      messageHandler = nextMessageHandler;
      queueSessionScopeId = nextSessionScopeId;
      recentMessageAcks.clear();
      pendingMessageAcks.clear();
      recentDispatchAcks.clear();
      pendingDispatchAcks.clear();
      loadOutboundQueue();
      stopOutboundQueueTimer();

      server = new WebSocketServer({ port, host: '127.0.0.1' });

      server.on('listening', () => {
        if (settled) return;
        settled = true;
        wss = server;
        log.info('WebSocket', `Server listening on ws://127.0.0.1:${port}`);
        startOutboundQueueTimer();
        resolve(wss);
      });

      server.on('connection', (ws, req) => {
        const clientId = ++clientIdCounter;
        const now = Date.now();
        const clientInfo = { ws, paneId: null, role: null, connectedAt: now, lastSeen: now };
        clients.set(clientId, clientInfo);

        log.info('WebSocket', `Client ${clientId} connected from ${req.socket.remoteAddress}`);

        ws.on('message', (data) => {
          handleMessage(clientId, data).catch((err) => {
            log.error('WebSocket', `Unhandled message error for client ${clientId}: ${err.message}`);
          });
        });

        ws.on('close', (code, _reason) => {
          const info = clients.get(clientId);
          const roleInfo = info?.role ? ` (${info.role})` : '';
          log.info('WebSocket', `Client ${clientId}${roleInfo} disconnected: ${code}`);
          clients.delete(clientId);
        });

        ws.on('error', (err) => {
          log.error('WebSocket', `Client ${clientId} error: ${err.message}`);
        });

        // Send welcome message with client ID
        ws.send(JSON.stringify({ type: 'welcome', clientId }));
      });

      server.on('error', (err) => {
        log.error('WebSocket', `Server error: ${err.message}`);
        if (settled) return;
        if (err.code === 'EADDRINUSE') {
          rejectStart(new Error(`Port ${port} already in use`));
          return;
        }
        rejectStart(err);
      });

    } catch (err) {
      rejectStart(err);
    }
  }).finally(() => {
    startInFlightPromise = null;
  });

  return startInFlightPromise;
}

/**
 * Handle incoming message from a client
 * @param {number} clientId - Client identifier
 * @param {Buffer|string} rawData - Raw message data
 */
async function handleMessage(clientId, rawData) {
  const clientInfo = clients.get(clientId);
  if (!clientInfo) return;

  // Rate limiting: sliding window per client
  const now = Date.now();
  const receivedAtMs = now;
  if (!clientInfo._rateBucketStart || now - clientInfo._rateBucketStart > RATE_LIMIT_WINDOW_MS) {
    clientInfo._rateBucketStart = now;
    clientInfo._rateBucketCount = 0;
  }
  clientInfo._rateBucketCount++;
  if (clientInfo._rateBucketCount > RATE_LIMIT_MAX_MESSAGES) {
    log.warn('WebSocket', `Rate limit exceeded for client ${clientId} (${clientInfo._rateBucketCount}/${RATE_LIMIT_MAX_MESSAGES} per ${RATE_LIMIT_WINDOW_MS}ms)`);
    sendJson(clientInfo.ws, { type: 'error', message: 'Rate limit exceeded' });
    return;
  }

  // Message size limit
  const rawSize = typeof rawData === 'string' ? rawData.length : rawData.byteLength || 0;
  if (rawSize > MAX_MESSAGE_SIZE) {
    log.warn('WebSocket', `Oversized message from client ${clientId}: ${rawSize} bytes (max ${MAX_MESSAGE_SIZE})`);
    sendJson(clientInfo.ws, { type: 'error', message: 'Message too large' });
    return;
  }

  let message;
  try {
    const str = rawData.toString();
    message = JSON.parse(str);
  } catch (_err) {
    // Plain text message
    message = { type: 'text', content: rawData.toString() };
  }

  log.info('WebSocket', `Received from client ${clientId}: ${JSON.stringify(message).substring(0, 100)}`);
  // Refresh route health on any inbound frame.
  markClientSeen(clientId, 'message');

  // Handle registration messages
  if (message.type === 'register') {
    const normalizedRole = normalizeRoleId(message.role) || message.role || null;
    const normalizedPaneId = normalizePaneId(message.paneId) || getPaneIdForRole(normalizeRoleId(message.role));
    clientInfo.paneId = normalizedPaneId || null;
    clientInfo.role = normalizedRole || null;
    markClientSeen(clientId, 'register');
    log.info('WebSocket', `Client ${clientId} registered as pane=${clientInfo.paneId} role=${clientInfo.role}`);
    sendJson(clientInfo.ws, { type: 'registered', paneId: clientInfo.paneId, role: clientInfo.role });
    flushOutboundQueueForClient(clientId, 'register');
    return;
  }

  if (message.type === 'health-check') {
    const health = getRoutingHealth(message.target, message.staleAfterMs);
    sendJson(clientInfo.ws, {
      type: 'health-check-result',
      requestId: typeof message.requestId === 'string' ? message.requestId : null,
      target: message.target || null,
      timestamp: Date.now(),
      ...health,
    });
    return;
  }

  if (message.type === 'delivery-check') {
    const requestId = toNonEmptyString(message.requestId);
    const result = getDeliveryCheckResult(message.messageId);
    sendJson(clientInfo.ws, {
      type: 'delivery-check-result',
      requestId,
      timestamp: Date.now(),
      ...result,
    });
    return;
  }

  const traceEligible = (message.type === 'send' || message.type === 'broadcast');
  const ackEligible = isAckEligibleMessage(message);
  const messageId = ackEligible ? getNormalizedMessageId(message) : null;
  const requestId = toNonEmptyString(message.requestId);
  const ingressTraceContext = traceEligible ? buildTraceContext(message) : null;
  const dispatchTraceContext = ingressTraceContext
    ? {
      ...ingressTraceContext,
      parentEventId: ingressTraceContext.eventId,
      causationId: ingressTraceContext.eventId,
    }
    : null;

  if (ackEligible && messageId) {
    pruneExpiredMessageAcks();

    const cached = recentMessageAcks.get(messageId);
    if (cached?.ackPayload) {
      void emitCommsMetric(clientId, clientInfo, 'comms.dedupe.hit', {
        mode: 'cache',
        messageId,
        target: message?.target || null,
        status: cached.ackPayload?.status || null,
      });
      sendJson(clientInfo.ws, cached.ackPayload);
      return;
    }

    const pending = pendingMessageAcks.get(messageId);
    if (pending) {
      void emitCommsMetric(clientId, clientInfo, 'comms.dedupe.hit', {
        mode: 'pending',
        messageId,
        target: message?.target || null,
      });
      try {
        const pendingAck = await pending;
        if (pendingAck) {
          sendJson(clientInfo.ws, pendingAck);
        }
      } catch (err) {
        const failedAck = {
          type: 'send-ack',
          messageId,
          ok: false,
          accepted: false,
          queued: false,
          verified: false,
          status: 'handler_error',
          error: err.message,
          traceId: ingressTraceContext?.traceId || null,
          parentEventId: ingressTraceContext?.parentEventId || null,
          timestamp: Date.now(),
        };
        sendJson(clientInfo.ws, failedAck);
      }
      return;
    }
  }

  const dispatchDedupeKey = ackEligible ? buildDispatchDedupeKey(clientInfo, message) : null;
  if (ackEligible && dispatchDedupeKey) {
    pruneExpiredDispatchAcks();

    const cachedDispatch = recentDispatchAcks.get(dispatchDedupeKey);
    if (cachedDispatch?.ackPayload) {
      void emitCommsMetric(clientId, clientInfo, 'comms.dedupe.hit', {
        mode: 'signature_cache',
        dedupeKey: dispatchDedupeKey,
        messageId: messageId || null,
        target: message?.target || null,
        status: cachedDispatch.ackPayload?.status || null,
      });
      const dedupeAck = buildDedupeAckPayload(
        cachedDispatch.ackPayload,
        messageId,
        ingressTraceContext,
        'signature_cache',
        dispatchDedupeKey
      );
      if (dedupeAck) {
        sendJson(clientInfo.ws, dedupeAck);
        if (messageId) {
          cacheMessageAck(messageId, dedupeAck);
        }
        return;
      }
    }

    const pendingDispatch = pendingDispatchAcks.get(dispatchDedupeKey);
    if (pendingDispatch) {
      void emitCommsMetric(clientId, clientInfo, 'comms.dedupe.hit', {
        mode: 'signature_pending',
        dedupeKey: dispatchDedupeKey,
        messageId: messageId || null,
        target: message?.target || null,
      });
      try {
        const pendingAck = await pendingDispatch;
        const dedupeAck = buildDedupeAckPayload(
          pendingAck,
          messageId,
          ingressTraceContext,
          'signature_pending',
          dispatchDedupeKey
        );
        if (dedupeAck) {
          sendJson(clientInfo.ws, dedupeAck);
          if (messageId) {
            cacheMessageAck(messageId, dedupeAck);
          }
        }
      } catch (err) {
        const failedAck = {
          type: 'send-ack',
          messageId,
          ok: false,
          accepted: false,
          queued: false,
          verified: false,
          status: 'handler_error',
          error: err.message,
          traceId: ingressTraceContext?.traceId || null,
          parentEventId: ingressTraceContext?.parentEventId || null,
          timestamp: Date.now(),
          dedupe: {
            mode: 'signature_pending',
            key: dispatchDedupeKey,
          },
        };
        sendJson(clientInfo.ws, failedAck);
        if (messageId) {
          cacheMessageAck(messageId, failedAck);
        }
      }
      return;
    }
  }

  let resolvePendingAck = null;
  let rejectPendingAck = null;
  if (ackEligible && messageId) {
    const pending = new Promise((resolve, reject) => {
      resolvePendingAck = resolve;
      rejectPendingAck = reject;
    });
    pendingMessageAcks.set(messageId, pending);
  }

  let resolvePendingDispatchAck = null;
  let rejectPendingDispatchAck = null;
  if (ackEligible && dispatchDedupeKey) {
    const pendingDispatch = new Promise((resolve, reject) => {
      resolvePendingDispatchAck = resolve;
      rejectPendingDispatchAck = reject;
    });
    pendingDispatchAcks.set(dispatchDedupeKey, pendingDispatch);
  }

  function finalizeAckTracking(ackPayload, err) {
    if (!ackEligible) return;
    if (messageId) {
      pendingMessageAcks.delete(messageId);
    }
    if (dispatchDedupeKey) {
      pendingDispatchAcks.delete(dispatchDedupeKey);
    }

    if (ackPayload) {
      if (messageId) {
        cacheMessageAck(messageId, ackPayload);
      }
      if (dispatchDedupeKey) {
        cacheDispatchAck(dispatchDedupeKey, ackPayload);
      }
      if (resolvePendingAck) resolvePendingAck(ackPayload);
      if (resolvePendingDispatchAck) resolvePendingDispatchAck(ackPayload);
      return;
    }

    const trackingError = err || new Error('ACK processing failed');
    if (rejectPendingAck) {
      rejectPendingAck(trackingError);
    }
    if (rejectPendingDispatchAck) {
      rejectPendingDispatchAck(trackingError);
    }
  }

  let wsDeliveryCount = 0;
  let skipMessageHandler = false;

  // Handle agent-to-agent messages
  if (message.type === 'send') {
    const { target, content, priority, metadata } = message;
    // Try WebSocket clients first (for future direct agent-to-agent)
    if (sendToTarget(target, content, {
      from: clientInfo.role || clientId,
      priority,
      metadata: (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) ? metadata : null,
      traceContext: dispatchTraceContext,
      persistIfOffline: false,
    })) {
      wsDeliveryCount = 1;
      // Prevent duplicate delivery via both WebSocket route and terminal injection route.
      skipMessageHandler = true;
    }
  }

  // Handle broadcast
  if (message.type === 'broadcast') {
    wsDeliveryCount = broadcast(message.content, {
      from: clientInfo.role || clientId,
      excludeSender: clientId,
      traceContext: dispatchTraceContext,
    });
    // Don't return - let messageHandler also route to terminals/triggers
  }

  let handlerResult = null;

  // Pass to external handler if set
  if (messageHandler && !skipMessageHandler) {
    try {
      handlerResult = await messageHandler({
        clientId,
        paneId: clientInfo.paneId,
        role: clientInfo.role,
        message: dispatchTraceContext ? { ...message, traceContext: dispatchTraceContext } : message,
        traceContext: dispatchTraceContext,
      });
    } catch (err) {
      log.error('WebSocket', `messageHandler failed for client ${clientId}: ${err.message}`);
      if (requestId && !ackEligible) {
        sendJson(clientInfo.ws, {
          type: 'response',
          requestId,
          ok: false,
          error: err.message,
          timestamp: Date.now(),
        });
      }
      if (message.ackRequired && (message.type === 'send' || message.type === 'broadcast')) {
        const ackPayload = {
          type: 'send-ack',
          messageId: message.messageId || null,
          ok: false,
          accepted: false,
          queued: false,
          verified: false,
          status: 'handler_error',
          error: err.message,
          wsDeliveryCount,
          traceId: ingressTraceContext?.traceId || null,
          parentEventId: ingressTraceContext?.parentEventId || null,
          timestamp: Date.now(),
        };
        emitAckLatencyMetric(clientId, clientInfo, message, ackPayload, receivedAtMs);
        sendJson(clientInfo.ws, ackPayload);
        finalizeAckTracking(ackPayload, err);
      }
      else {
        finalizeAckTracking(null, err);
      }
      return;
    }
  }

  if (requestId && !ackEligible) {
    sendJson(clientInfo.ws, {
      type: 'response',
      requestId,
      ok: true,
      result: handlerResult,
      timestamp: Date.now(),
    });
    finalizeAckTracking(null);
    return;
  }

  if (message.ackRequired && (message.type === 'send' || message.type === 'broadcast')) {
    const handlerAck = coerceAckResult(handlerResult);
    const websocketDelivered = wsDeliveryCount > 0;
    const accepted = websocketDelivered || Boolean(handlerAck?.accepted || handlerAck?.ok);
    const queued = websocketDelivered || Boolean(handlerAck?.queued || handlerAck?.accepted || handlerAck?.ok);
    const verified = websocketDelivered || Boolean(handlerAck?.verified);
    const ok = verified;

    let status = verified
      ? (websocketDelivered ? 'delivered.websocket' : 'delivered.verified')
      : (accepted ? 'accepted.unverified' : 'unrouted');
    if (handlerAck?.status) {
      status = handlerAck.status;
      if (websocketDelivered && handlerAck.verified === false) {
        status = 'delivered.websocket';
      }
    }

    const ackPayload = {
      type: 'send-ack',
      messageId: message.messageId || null,
      ok,
      accepted,
      queued,
      verified,
      status,
      wsDeliveryCount,
      handlerResult: handlerAck?.details || null,
      traceId: ingressTraceContext?.traceId || null,
      parentEventId: ingressTraceContext?.parentEventId || null,
      timestamp: Date.now(),
    };
    emitAckLatencyMetric(clientId, clientInfo, message, ackPayload, receivedAtMs);
    sendJson(clientInfo.ws, ackPayload);
    finalizeAckTracking(ackPayload);
    return;
  }

  finalizeAckTracking(null);
}

/**
 * Send message to a specific target (paneId or role)
 * @param {string} target - Target paneId or role name
 * @param {string} content - Message content
 * @param {object} meta - Metadata (from, priority)
 */
function sendToTarget(target, content, meta = {}) {
  const sent = deliverToTargetNow(target, content, meta);
  if (sent) return true;

  const shouldPersistOffline = meta?.persistIfOffline !== false;
  if (shouldPersistOffline) {
    queueOutboundMessage(target, content, meta, 'sendToTarget');
    log.warn('WebSocket', `No connected client for target: ${target}. Queued for reconnect delivery.`);
  } else {
    log.warn('WebSocket', `No connected client for target: ${target}`);
  }

  return false;
}

/**
 * Broadcast message to all connected clients
 * @param {string} content - Message content
 * @param {object} options - Options (from, excludeSender)
 */
function broadcast(content, options = {}) {
  const traceContext = options?.traceContext || null;
  const payload = JSON.stringify({
    type: 'broadcast',
    from: options.from || 'system',
    content,
    traceId: traceContext?.traceId || null,
    parentEventId: traceContext?.parentEventId || null,
    eventId: traceContext?.eventId || null,
    timestamp: Date.now(),
  });

  let count = 0;
  for (const [clientId, info] of clients) {
    if (options.excludeSender && clientId === options.excludeSender) continue;
    if (info.ws.readyState === 1) { // WebSocket.OPEN
      info.ws.send(payload);
      count++;
    }
  }

  log.info('WebSocket', `Broadcast to ${count} clients: ${content.substring(0, 50)}...`);
  return count;
}

/**
 * Send message to a specific pane (convenience wrapper)
 * @param {string} paneId - Target pane ID
 * @param {string} content - Message content
 * @param {object} meta - Metadata
 */
function sendToPane(paneId, content, meta = {}) {
  return sendToTarget(paneId, content, meta);
}

/**
 * Get list of connected clients
 * @returns {Array} Client info array
 */
function getClients() {
  return Array.from(clients.entries()).map(([id, info]) => ({
    clientId: id,
    paneId: info.paneId,
    role: info.role,
    connectedAt: info.connectedAt,
    lastSeen: info.lastSeen || null,
    ready: info.ws.readyState === 1,
  }));
}

/**
 * Stop the WebSocket server
 */
async function stop() {
  stopOutboundQueueTimer();
  if (!wss && startInFlightPromise) {
    try {
      await startInFlightPromise;
    } catch {
      // Ignore startup failure; cleanup below will reset local state.
    }
    stopOutboundQueueTimer();
  }

  const server = wss;
  if (!server) {
    outboundQueueFlushInProgress = false;
    outboundQueue = [];
    return;
  }

  // Close all client connections
  for (const [, info] of clients) {
    info.ws.close(1000, 'Server shutting down');
  }
  clients.clear();
  recentMessageAcks.clear();
  pendingMessageAcks.clear();
  recentDispatchAcks.clear();
  pendingDispatchAcks.clear();
  outboundQueueFlushInProgress = false;
  outboundQueue = [];

  await new Promise((resolve) => {
    server.close(() => {
      log.info('WebSocket', 'Server stopped');
      if (wss === server) {
        wss = null;
      }
      resolve();
    });
  });
}

/**
 * Check if server is running
 * @returns {boolean}
 */
function isRunning() {
  return wss !== null;
}

/**
 * Get server port
 * @returns {number|null}
 */
function getPort() {
  if (!wss) return null;
  if (typeof wss.address === 'function') {
    const address = wss.address();
    if (address && typeof address === 'object' && address.port) {
      return address.port;
    }
  }
  return wss.options?.port || null;
}

module.exports = {
  start,
  stop,
  isRunning,
  getPort,
  getClients,
  sendToTarget,
  sendToPane,
  broadcast,
  DEFAULT_PORT,
};
