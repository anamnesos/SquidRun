/**
 * WebSocket Server for Agent Communication
 * Provides low-latency message delivery bypassing file-based triggers
 */

const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const log = require('./logger');
const { LEGACY_ROLE_ALIASES, ROLE_ID_MAP, WORKSPACE_PATH } = require('../config');

const DEFAULT_PORT = 9900;
const MESSAGE_ACK_TTL_MS = 60000;
const HEARTBEAT_INTERVAL_MS = 30000;
const HEARTBEAT_STALE_MS = 60000;
const OUTBOUND_QUEUE_MAX_ENTRIES = Number.parseInt(process.env.HIVEMIND_COMMS_QUEUE_MAX_ENTRIES || '500', 10);
const OUTBOUND_QUEUE_MAX_AGE_MS = Number.parseInt(process.env.HIVEMIND_COMMS_QUEUE_MAX_AGE_MS || String(30 * 60 * 1000), 10);
const OUTBOUND_QUEUE_FLUSH_INTERVAL_MS = Number.parseInt(process.env.HIVEMIND_COMMS_QUEUE_FLUSH_INTERVAL_MS || '30000', 10);
const OUTBOUND_QUEUE_PATH = process.env.HIVEMIND_COMMS_QUEUE_FILE
  || path.join(WORKSPACE_PATH, 'state', 'comms-outbound-queue.json');
const CANONICAL_ROLE_IDS = ['architect', 'devops', 'analyst'];
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
let roleHeartbeats = new Map(); // role -> { role, paneId, lastSeen, clientId, source }
let paneHeartbeats = new Map(); // paneId -> { role, paneId, lastSeen, clientId, source }
let outboundQueue = []; // [{ id, target, content, meta, createdAt, attempts, lastAttemptAt, queuedBy }]
let outboundQueueFlushTimer = null;
let outboundQueueFlushInProgress = false;

function generateTraceToken(prefix = 'evt') {
  try {
    return `${prefix}-${crypto.randomUUID()}`;
  } catch (err) {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

function toNonEmptyString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
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

function touchHeartbeat(role, paneId, clientId, source = 'heartbeat', now = Date.now()) {
  const normalizedRole = normalizeRoleId(role);
  const normalizedPaneId = normalizePaneId(paneId);

  if (normalizedRole) {
    const resolvedPaneId = normalizedPaneId || getPaneIdForRole(normalizedRole);
    const roleEntry = {
      role: normalizedRole,
      paneId: resolvedPaneId || null,
      lastSeen: now,
      clientId,
      source,
    };
    roleHeartbeats.set(normalizedRole, roleEntry);
    if (resolvedPaneId) {
      paneHeartbeats.set(String(resolvedPaneId), roleEntry);
    }
    return roleEntry;
  }

  if (normalizedPaneId) {
    const inferredRole = getRoleForPaneId(normalizedPaneId);
    const paneEntry = {
      role: inferredRole || null,
      paneId: normalizedPaneId,
      lastSeen: now,
      clientId,
      source,
    };
    paneHeartbeats.set(normalizedPaneId, paneEntry);
    if (inferredRole) {
      roleHeartbeats.set(inferredRole, paneEntry);
    }
    return paneEntry;
  }

  return null;
}

function markClientSeen(clientId, source = 'message', now = Date.now()) {
  const clientInfo = clients.get(clientId);
  if (!clientInfo) return null;
  clientInfo.lastSeen = now;
  return touchHeartbeat(clientInfo.role, clientInfo.paneId, clientId, source, now);
}

function coerceStaleAfterMs(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return HEARTBEAT_STALE_MS;
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

function getRoutingHealth(target, staleAfterMs = HEARTBEAT_STALE_MS, now = Date.now()) {
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
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      source: null,
    };
  }

  const fromRole = identity.role ? roleHeartbeats.get(identity.role) : null;
  const fromPane = identity.paneId ? paneHeartbeats.get(identity.paneId) : null;
  const heartbeat = fromRole || fromPane;

  if (!heartbeat || !Number.isFinite(heartbeat.lastSeen)) {
    return {
      healthy: false,
      status: 'no_heartbeat',
      role: identity.role || heartbeat?.role || null,
      paneId: identity.paneId || heartbeat?.paneId || null,
      lastSeen: null,
      ageMs: null,
      staleThresholdMs,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      source: null,
    };
  }

  const ageMs = Math.max(0, now - heartbeat.lastSeen);
  const healthy = ageMs <= staleThresholdMs;

  return {
    healthy,
    status: healthy ? 'healthy' : 'stale',
    role: identity.role || heartbeat.role || null,
    paneId: identity.paneId || heartbeat.paneId || null,
    lastSeen: heartbeat.lastSeen,
    ageMs,
    staleThresholdMs,
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    source: heartbeat.source || null,
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
  return path.dirname(OUTBOUND_QUEUE_PATH);
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
      queuedBy: typeof item.queuedBy === 'string' ? item.queuedBy : 'runtime',
    });
  }
  const maxEntries = getQueueMaxEntries();
  return normalized.slice(Math.max(0, normalized.length - maxEntries));
}

function persistOutboundQueue() {
  try {
    ensureQueueDir();
    const payload = JSON.stringify(outboundQueue, null, 2);
    const tmpPath = `${OUTBOUND_QUEUE_PATH}.tmp`;
    fs.writeFileSync(tmpPath, payload, 'utf-8');
    fs.renameSync(tmpPath, OUTBOUND_QUEUE_PATH);
  } catch (err) {
    log.error('WebSocket', `Failed to persist outbound queue: ${err.message}`);
  }
}

function loadOutboundQueue() {
  try {
    if (!fs.existsSync(OUTBOUND_QUEUE_PATH)) {
      outboundQueue = [];
      return;
    }
    const raw = fs.readFileSync(OUTBOUND_QUEUE_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    outboundQueue = normalizeQueueEntries(parsed);
    if (!Array.isArray(parsed) || parsed.length !== outboundQueue.length) {
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
  return JSON.stringify({
    type: 'message',
    from: meta.from || 'system',
    priority: meta.priority || 'normal',
    content,
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

/**
 * Start the WebSocket server
 * @param {object} options - Configuration options
 * @param {number} options.port - Port to listen on (default: 9900)
 * @param {function} options.onMessage - Handler for incoming messages
 * @returns {Promise<WebSocketServer>}
 */
function start(options = {}) {
  const port = options.port ?? DEFAULT_PORT;
  messageHandler = options.onMessage || null;
  recentMessageAcks.clear();
  pendingMessageAcks.clear();
  roleHeartbeats.clear();
  paneHeartbeats.clear();
  loadOutboundQueue();
  stopOutboundQueueTimer();

  return new Promise((resolve, reject) => {
    try {
      wss = new WebSocketServer({ port, host: '127.0.0.1' });

      wss.on('listening', () => {
        log.info('WebSocket', `Server listening on ws://127.0.0.1:${port}`);
        startOutboundQueueTimer();
        resolve(wss);
      });

      wss.on('connection', (ws, req) => {
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

        ws.on('close', (code, reason) => {
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

      wss.on('error', (err) => {
        log.error('WebSocket', `Server error: ${err.message}`);
        if (err.code === 'EADDRINUSE') {
          stopOutboundQueueTimer();
          reject(new Error(`Port ${port} already in use`));
        }
      });

    } catch (err) {
      stopOutboundQueueTimer();
      reject(err);
    }
  });
}

/**
 * Handle incoming message from a client
 * @param {number} clientId - Client identifier
 * @param {Buffer|string} rawData - Raw message data
 */
async function handleMessage(clientId, rawData) {
  const clientInfo = clients.get(clientId);
  if (!clientInfo) return;

  let message;
  try {
    const str = rawData.toString();
    message = JSON.parse(str);
  } catch (err) {
    // Plain text message
    message = { type: 'text', content: rawData.toString() };
  }

  log.info('WebSocket', `Received from client ${clientId}: ${JSON.stringify(message).substring(0, 100)}`);
  // Refresh route health on any inbound frame so active panes stay fresh without heartbeat-only traffic.
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

  if (message.type === 'heartbeat') {
    const normalizedRole = normalizeRoleId(message.role);
    const normalizedPaneId = normalizePaneId(message.paneId);
    if (normalizedRole) {
      clientInfo.role = normalizedRole;
    }
    if (normalizedPaneId) {
      clientInfo.paneId = normalizedPaneId;
    } else if (!clientInfo.paneId && normalizedRole) {
      clientInfo.paneId = getPaneIdForRole(normalizedRole);
    }
    const heartbeat = markClientSeen(clientId, 'heartbeat');
    sendJson(clientInfo.ws, {
      type: 'heartbeat-ack',
      role: heartbeat?.role || null,
      paneId: heartbeat?.paneId || null,
      lastSeen: heartbeat?.lastSeen || Date.now(),
      staleThresholdMs: HEARTBEAT_STALE_MS,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      status: 'ok',
    });
    flushOutboundQueueForClient(clientId, 'heartbeat');
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

  let resolvePendingAck = null;
  let rejectPendingAck = null;
  if (ackEligible && messageId) {
    const pending = new Promise((resolve, reject) => {
      resolvePendingAck = resolve;
      rejectPendingAck = reject;
    });
    pendingMessageAcks.set(messageId, pending);
  }

  function finalizeAckTracking(ackPayload, err) {
    if (!ackEligible || !messageId) return;
    pendingMessageAcks.delete(messageId);
    if (ackPayload) {
      cacheMessageAck(messageId, ackPayload);
      if (resolvePendingAck) resolvePendingAck(ackPayload);
      return;
    }
    if (rejectPendingAck) {
      rejectPendingAck(err || new Error('ACK processing failed'));
    }
  }

  let wsDeliveryCount = 0;

  // Handle agent-to-agent messages
  if (message.type === 'send') {
    const { target, content, priority } = message;
    // Try WebSocket clients first (for future direct agent-to-agent)
    if (sendToTarget(target, content, {
      from: clientInfo.role || clientId,
      priority,
      traceContext: dispatchTraceContext,
      persistIfOffline: false,
    })) {
      wsDeliveryCount = 1;
    }
    // Don't return - let messageHandler also route to terminals
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
  if (messageHandler) {
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
function stop() {
  return new Promise((resolve) => {
    stopOutboundQueueTimer();
    if (!wss) {
      outboundQueueFlushInProgress = false;
      outboundQueue = [];
      resolve();
      return;
    }

    // Close all client connections
    for (const [clientId, info] of clients) {
      info.ws.close(1000, 'Server shutting down');
    }
    clients.clear();
    recentMessageAcks.clear();
    pendingMessageAcks.clear();
    roleHeartbeats.clear();
    paneHeartbeats.clear();
    outboundQueueFlushInProgress = false;
    outboundQueue = [];

    wss.close(() => {
      log.info('WebSocket', 'Server stopped');
      wss = null;
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
  getRoutingHealth,
  sendToTarget,
  sendToPane,
  broadcast,
  DEFAULT_PORT,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_STALE_MS,
};
