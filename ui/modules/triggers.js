/**
 * Trigger handling and agent notification functions
 * Extracted from main.js for modularization
 *
 * Main module that coordinates sub-modules:
 * - war-room.js (message log + ambient awareness)
 * - sequencing.js (duplicate prevention + sequencing)
 * - metrics.js (reliability stats)
 * - routing.js (smart routing + handoff)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { TRIGGER_TARGETS, WORKSPACE_PATH, PANE_IDS, ROLE_ID_MAP, LEGACY_ROLE_ALIASES } = require('../config');
const log = require('./logger');
const diagnosticLog = require('./diagnostic-log');
const organicUI = require('./ipc/organic-ui-handlers');

// Sub-modules
const metrics = require('./triggers/metrics');
const sequencing = require('./triggers/sequencing');
const warRoom = require('./triggers/war-room');
const routing = require('./triggers/routing');

// Memory system for trigger logging
let memory = null;
try {
  memory = require('./memory');
} catch (e) {
  // Memory system not available
}

// Module state
let mainWindow = null;
let agentRunning = null;
let watcher = null;
let logActivityFn = null;
let selfHealing = null;
let pluginManager = null;

// Shared constants
const TRIGGER_PREFIX = '\x1b[1;33m[TRIGGER]\x1b[0m ';
const WORKER_PANES = ['2'];
const SYNC_DEBOUNCE_MS = 3000;
const SYNC_COALESCE_WINDOW_MS = 5000;
const STAGGER_BASE_DELAY_MS = 150;
const STAGGER_RANDOM_MS = 100;
const DELIVERY_VERIFY_TIMEOUT_MS = Number.parseInt(process.env.HIVEMIND_DELIVERY_VERIFY_TIMEOUT_MS || '5000', 10);
const PRIORITY_KEYWORDS = ['STOP', 'URGENT', 'BLOCKING', 'ERROR'];
const TRIGGER_MESSAGE_ID_PREFIX = '[HM-MESSAGE-ID:';
const TRIGGER_MESSAGE_ID_REGEX = /^\[HM-MESSAGE-ID:([^\]\r\n]+)\]\r?\n?/;
const RECENT_TRIGGER_ID_TTL_MS = Number.parseInt(process.env.HIVEMIND_TRIGGER_DEDUPE_TTL_MS || String(5 * 60 * 1000), 10);
const RECENT_TRIGGER_ID_LIMIT = Number.parseInt(process.env.HIVEMIND_TRIGGER_DEDUPE_MAX || '2000', 10);

// Local state
const lastSyncTime = new Map();
let lastGlobalSyncTime = 0;
const deliveryAckListeners = new Set();
const recentTriggerIds = new Map();

function generateTraceToken(prefix = 'trc') {
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

function normalizeTraceContext(traceContext = null, fallback = {}) {
  const ctx = (traceContext && typeof traceContext === 'object') ? traceContext : {};
  const traceId = toNonEmptyString(ctx.traceId)
    || toNonEmptyString(ctx.correlationId)
    || toNonEmptyString(fallback.traceId)
    || toNonEmptyString(fallback.correlationId)
    || generateTraceToken('trc');
  const parentEventId = toNonEmptyString(ctx.parentEventId)
    || toNonEmptyString(ctx.causationId)
    || toNonEmptyString(fallback.parentEventId)
    || toNonEmptyString(fallback.causationId)
    || null;
  const eventId = toNonEmptyString(ctx.eventId)
    || toNonEmptyString(fallback.eventId)
    || generateTraceToken('evt');

  return {
    ...ctx,
    traceId,
    parentEventId,
    eventId,
    correlationId: traceId,
    causationId: parentEventId,
  };
}

// Connect sub-modules
sequencing.setMetricsFunctions(metrics.recordTimeout, metrics.recordDelivered);

/**
 * Initialize the triggers module
 */
function init(window, agentState, logActivity) {
  mainWindow = window;
  agentRunning = agentState;
  logActivityFn = logActivity || null;

  sequencing.loadMessageState();
  warRoom.setTriggersState({
    mainWindow,
    agentRunning,
    sendAmbientUpdate
  });
  warRoom.loadWarRoomHistory();

  routing.setSharedState({
    mainWindow,
    agentRunning,
    logTriggerActivity,
    recordSelfHealingMessage,
    formatTriggerMessage,
    emitOrganicMessageRoute
  });
}

function setSelfHealing(manager) {
  selfHealing = manager || null;
}

function setPluginManager(manager) {
  pluginManager = manager || null;
}

function setWatcher(watcherModule) {
  watcher = watcherModule;
  routing.setSharedState({ watcher });
}

function formatTriggerMessage(message) {
  if (!message) return message;
  if (message.startsWith(TRIGGER_PREFIX)) return message;
  return `${TRIGGER_PREFIX}${message}`;
}

function logTriggerActivity(action, panes, message, extra = {}) {
  if (!logActivityFn) return;
  const paneList = Array.isArray(panes) ? panes.join(',') : panes;
  const preview = message ? message.substring(0, 80).replace(/[\r\n]+/g, ' ') : '';
  const truncated = message && message.length > 80 ? '...' : '';
  logActivityFn('trigger', paneList, `${action}: ${preview}${truncated}`, {
    panes: Array.isArray(panes) ? panes : [panes],
    preview: preview + truncated,
    ...extra,
  });
}

function recordSelfHealingMessage(paneId, message, meta = {}) {
  if (selfHealing && typeof selfHealing.recordTask === 'function') {
    selfHealing.recordTask(paneId, message, meta);
  }
}

function applyPluginHookSync(eventName, payload) {
  if (!pluginManager || !pluginManager.hasHook(eventName)) return payload;
  return pluginManager.applyHookSync(eventName, payload);
}

function dispatchPluginEvent(eventName, payload) {
  if (pluginManager && pluginManager.hasHook(eventName)) {
    pluginManager.dispatch(eventName, payload).catch(() => {});
  }
}

function isPriorityMessage(message) {
  if (!message) return false;
  const upperMessage = message.toUpperCase();
  return PRIORITY_KEYWORDS.some(keyword => upperMessage.includes(keyword));
}

function getTriggerDedupeTtlMs() {
  return Number.isFinite(RECENT_TRIGGER_ID_TTL_MS) && RECENT_TRIGGER_ID_TTL_MS > 0
    ? RECENT_TRIGGER_ID_TTL_MS
    : (5 * 60 * 1000);
}

function getTriggerDedupeLimit() {
  return Number.isFinite(RECENT_TRIGGER_ID_LIMIT) && RECENT_TRIGGER_ID_LIMIT > 0
    ? RECENT_TRIGGER_ID_LIMIT
    : 2000;
}

function pruneRecentTriggerIds(now = Date.now()) {
  const ttlMs = getTriggerDedupeTtlMs();
  for (const [messageId, seenAt] of recentTriggerIds.entries()) {
    if (!Number.isFinite(seenAt) || seenAt + ttlMs <= now) {
      recentTriggerIds.delete(messageId);
    }
  }
  const maxEntries = getTriggerDedupeLimit();
  while (recentTriggerIds.size > maxEntries) {
    const oldest = recentTriggerIds.keys().next().value;
    if (!oldest) break;
    recentTriggerIds.delete(oldest);
  }
}

function markRecentTriggerId(messageId, now = Date.now()) {
  if (!messageId) return;
  pruneRecentTriggerIds(now);
  const maxEntries = getTriggerDedupeLimit();
  if (recentTriggerIds.size >= maxEntries) {
    const oldest = recentTriggerIds.keys().next().value;
    if (oldest) {
      recentTriggerIds.delete(oldest);
    }
  }
  recentTriggerIds.set(messageId, now);
}

function isRecentTriggerId(messageId, now = Date.now()) {
  if (!messageId) return false;
  pruneRecentTriggerIds(now);
  return recentTriggerIds.has(messageId);
}

function extractTriggerMessageId(message) {
  if (typeof message !== 'string' || !message.startsWith(TRIGGER_MESSAGE_ID_PREFIX)) {
    return { messageId: null, content: message };
  }

  const match = message.match(TRIGGER_MESSAGE_ID_REGEX);
  if (!match) {
    return { messageId: null, content: message };
  }

  const messageId = match[1] ? String(match[1]).trim() : null;
  const content = message.slice(match[0].length);
  return {
    messageId: messageId || null,
    content,
  };
}

// Role to Pane mapping (duplicate for local use)
const ROLE_TO_PANE = {
  'architect': '1', 'arch': '1',
  'devops': '2', 'infra': '2', 'infrastructure': '2', 'backend': '2', 'back': '2',
  'analyst': '5', 'ana': '5',
  'lead': '1', 'orchestrator': '2', 'worker-b': '2', 'investigator': '5',
};

function resolvePaneIdFromRole(role) {
  if (!role) return null;
  const raw = String(role).trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (/^\d+$/.test(raw)) return raw;
  return ROLE_TO_PANE[raw] || null;
}

function resolveRoleFromPaneId(paneId) {
  const targetPane = String(paneId || '').trim();
  if (!targetPane) return null;
  for (const [role, mappedPaneId] of Object.entries(ROLE_ID_MAP || {})) {
    if (String(mappedPaneId) === targetPane) {
      return role;
    }
  }
  for (const [alias, role] of Object.entries(LEGACY_ROLE_ALIASES || {})) {
    if (String(ROLE_ID_MAP?.[role] || '') === targetPane) {
      return role;
    }
    if (String(ROLE_TO_PANE?.[alias] || '') === targetPane) {
      return role;
    }
  }
  return null;
}

function getDeliveryVerifyTimeoutMs() {
  return Number.isFinite(DELIVERY_VERIFY_TIMEOUT_MS) && DELIVERY_VERIFY_TIMEOUT_MS > 0
    ? DELIVERY_VERIFY_TIMEOUT_MS
    : 5000;
}

function buildDeliveryResult({
  accepted,
  queued,
  verified,
  status,
  notified,
  mode = 'pty',
  deliveryId = null,
  details = null,
}) {
  return {
    success: Boolean(accepted),
    accepted: Boolean(accepted),
    queued: Boolean(queued),
    verified: Boolean(verified),
    status,
    notified: Array.isArray(notified) ? notified : [],
    mode,
    deliveryId: deliveryId || null,
    details: details || null,
  };
}

function waitForDeliveryVerification(deliveryId, expectedPanes, timeoutMs = getDeliveryVerifyTimeoutMs()) {
  const expected = new Set((expectedPanes || []).map((paneId) => String(paneId)));
  if (!deliveryId || expected.size === 0) {
    return Promise.resolve({
      verified: false,
      ackedPanes: [],
      missingPanes: Array.from(expected),
      timeoutMs,
    });
  }

  return new Promise((resolve) => {
    const acked = new Set();
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      disposeListener();
      resolve(result);
    };

    const disposeListener = onDeliveryAck((ackDeliveryId, paneId) => {
      if (ackDeliveryId !== deliveryId) return;
      const paneKey = String(paneId);
      if (!expected.has(paneKey)) return;
      acked.add(paneKey);
      if (acked.size >= expected.size) {
        finish({
          verified: true,
          ackedPanes: Array.from(acked),
          missingPanes: [],
          timeoutMs,
        });
      }
    });

    const timeoutId = setTimeout(() => {
      const missingPanes = Array.from(expected).filter((paneId) => !acked.has(paneId));
      finish({
        verified: false,
        ackedPanes: Array.from(acked),
        missingPanes,
        timeoutMs,
      });
    }, timeoutMs);
  });
}

function emitOrganicMessageRoute(fromRole, targets) {
  const fromPaneId = resolvePaneIdFromRole(fromRole);
  if (!fromPaneId || !Array.isArray(targets) || targets.length === 0) return;
  targets.forEach(target => {
    const targetPaneId = String(target);
    if (!targetPaneId || targetPaneId === fromPaneId) return;
    const messageId = `organic-${fromPaneId}-${targetPaneId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    organicUI.messageQueued(messageId, fromPaneId, targetPaneId);
    organicUI.messageDelivered(messageId);
  });
}

function stripRolePrefix(message) {
  if (!message) return '';
  return String(message).replace(/^\([^)]+\):\s*/i, '');
}

function getTriggerMessageType(filename, targets) {
  if (filename === 'all.txt' || (typeof filename === 'string' && filename.startsWith('others-'))) return 'broadcast';
  if (Array.isArray(targets) && targets.length > 1) return 'broadcast';
  return 'direct';
}

function sendAmbientUpdate(paneIds, message) {
  if (!message || !Array.isArray(paneIds) || paneIds.length === 0) return;
  // PTY mode: skip ambient updates to avoid noisy terminal injections.
}

function checkWorkflowGate(targets) {
  const hasWorkerTargets = targets.some(t => WORKER_PANES.includes(t));
  if (!hasWorkerTargets) return { allowed: true };
  if (!watcher) return { allowed: true };
  const state = watcher.readState();
  const allowedStates = ['executing', 'checkpoint_fix', 'idle', 'project_selected', 'planning', 'friction_sync', 'friction_logged'];
  if (allowedStates.includes(state.state)) return { allowed: true };
  return { allowed: false, reason: `Workers blocked during '${state.state}'` };
}

function notifyAgents(agents, message, options = {}) {
  if (!message) return;
  let targets = Array.isArray(agents) ? [...agents] : [];
  const beforePayload = applyPluginHookSync('message:beforeSend', {
    type: 'notify',
    targets,
    message,
    mode: 'pty',
  });
  if (beforePayload && beforePayload.cancel) return [];
  if (beforePayload && typeof beforePayload.message === 'string') message = beforePayload.message;
  if (beforePayload && Array.isArray(beforePayload.targets)) targets = beforePayload.targets;
  const deliveryId = typeof options.deliveryId === 'string' ? options.deliveryId : null;
  const traceContext = deliveryId || options.traceContext
    ? normalizeTraceContext(options.traceContext, { traceId: deliveryId || null })
    : null;

  const notified = [];
  for (const paneId of targets) { if (agentRunning && agentRunning.get(paneId) === 'running') notified.push(paneId); }
  if (notified.length > 0) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const payload = { panes: notified, message: formatTriggerMessage(message) };
      if (deliveryId) payload.deliveryId = deliveryId;
      if (traceContext) payload.traceContext = traceContext;
      mainWindow.webContents.send('inject-message', payload);
    }
    logTriggerActivity('Sent (PTY)', notified, message, { mode: 'pty' });
  }
  return notified;
}

function onDeliveryAck(listener) {
  if (typeof listener !== 'function') {
    return () => {};
  }
  deliveryAckListeners.add(listener);
  return () => {
    deliveryAckListeners.delete(listener);
  };
}

function handleDeliveryAck(deliveryId, paneId) {
  sequencing.handleDeliveryAck(deliveryId, paneId);
  if (deliveryAckListeners.size === 0) return;
  for (const listener of deliveryAckListeners) {
    try {
      listener(deliveryId, paneId);
    } catch (err) {
      log.warn('Trigger', `Delivery ack listener failed: ${err.message}`);
    }
  }
}

function notifyAllAgentsSync(triggerFile) {
  const now = Date.now();
  if (now - lastGlobalSyncTime < SYNC_COALESCE_WINDOW_MS) return [];
  lastGlobalSyncTime = now;
  const message = `[HIVEMIND SYNC] ${triggerFile} was updated. [FYI] Context updated. Do not respond.`;

  const runningPanes = [];
  if (agentRunning) {
    for (const [paneId, status] of agentRunning) {
      if (status === 'running' && (now - (lastSyncTime.get(paneId) || 0) > SYNC_DEBOUNCE_MS)) { runningPanes.push(paneId); lastSyncTime.set(paneId, now); }
    }
  }
  if (runningPanes.length > 0) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('inject-message', { panes: runningPanes, message: formatTriggerMessage(message) });
  }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('sync-triggered', { file: triggerFile, notified: runningPanes });
  return runningPanes;
}

function sendStaggered(panes, message, meta = {}) {
  const isPriority = isPriorityMessage(message);
  const traceContext = normalizeTraceContext(meta?.traceContext, {
    traceId: meta?.deliveryId || null,
    parentEventId: meta?.parentEventId || null,
  });
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const deliveryId = meta?.deliveryId;
  panes.forEach((paneId, index) => {
    const delay = panes.length === 1 || isPriority ? 0 : (index * STAGGER_BASE_DELAY_MS + Math.random() * STAGGER_RANDOM_MS);
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('inject-message', {
          panes: [paneId],
          message,
          deliveryId,
          traceContext,
        });
      }
    }, delay);
  });
}

function resolveRecipientRole(filename) {
  const role = filename.replace('.txt', '').toLowerCase();
  // Use localized versions to avoid ReferenceError if called before module-level destructuring
  const roleMap = {
    architect: '1', devops: '2', analyst: '5',
  };
  const legacyAliases = {
    lead: 'architect', orchestrator: 'devops', infra: 'devops', backend: 'devops', 'worker-b': 'devops', investigator: 'analyst',
  };
  
  if (roleMap[role]) return role;
  if (legacyAliases[role]) return legacyAliases[role];
  return role;
}

function handleTriggerFile(filePath, filename) {
  let targets = TRIGGER_TARGETS[filename];
  if (!targets) return { success: false, reason: 'unknown' };

  const gateCheck = checkWorkflowGate(targets);
  if (!gateCheck.allowed) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('trigger-blocked', { file: filename, targets, reason: gateCheck.reason });
    return { success: false, reason: 'workflow_gate' };
  }

  const processingPath = filePath + '.processing';
  try { fs.renameSync(filePath, processingPath); }
  catch (e) { return { success: false, reason: e.code === 'ENOENT' ? 'already_processing' : 'rename_error' }; }

  let message;
  try {
    const raw = fs.readFileSync(processingPath);
    if (raw.length >= 2 && raw[0] === 0xFF && raw[1] === 0xFE) message = raw.slice(2).toString('utf16le').trim();
    else if (raw.length >= 3 && raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF) message = raw.slice(3).toString('utf-8').trim();
    else message = raw.toString('utf-8').trim();
    message = message.replace(/\0/g, '').replace(/[\x01-\x08\x0B\x0C\x0E-\x1F]/g, '');
  } catch (e) { try { fs.unlinkSync(processingPath); } catch (ex) {} return { success: false, reason: 'read_error' }; }

  const extracted = extractTriggerMessageId(message);
  const fallbackMessageId = extracted.messageId;
  message = extracted.content;

  if (fallbackMessageId) {
    if (isRecentTriggerId(fallbackMessageId)) {
      log.warn('Trigger', `Skipping duplicate fallback messageId ${fallbackMessageId}`);
      try { fs.unlinkSync(processingPath); } catch (e) {}
      return { success: false, reason: 'duplicate_message_id' };
    }
    markRecentTriggerId(fallbackMessageId);
  }

  if (!message) { try { fs.unlinkSync(processingPath); } catch (e) {} return { success: false, reason: 'empty' }; }

  let parsed = sequencing.parseMessageSequence(message);
  const recipientRole = resolveRecipientRole(filename);
  if (parsed.seq !== null && parsed.sender) {
    if (!sequencing.messageState.sequences[recipientRole]) {
      sequencing.messageState.sequences[recipientRole] = { outbound: 0, lastSeen: {} };
    }
    if (parsed.seq === 1 && message.includes('# HIVEMIND SESSION:')) {
      if (!sequencing.messageState.sequences[recipientRole].lastSeen) {
        sequencing.messageState.sequences[recipientRole].lastSeen = {};
      }
      sequencing.messageState.sequences[recipientRole].lastSeen[parsed.sender] = 0;
      log.info('Trigger', `Reset lastSeen for ${parsed.sender} -> ${recipientRole} (Session Reset)`);
    }
    if (sequencing.isDuplicateMessage(parsed.sender, parsed.seq, recipientRole)) {
      metrics.recordSkipped(parsed.sender, parsed.seq, recipientRole);
      try { fs.unlinkSync(processingPath); } catch (e) {}
      return { success: false, reason: 'duplicate' };
    }
  }

  if (filename === 'all.txt' && parsed.sender) {
    const senderPaneId = ROLE_TO_PANE[parsed.sender];
    if (senderPaneId) targets = targets.filter(t => t !== senderPaneId);
  }

  let deliveryId = null;
  if (parsed.seq !== null && parsed.sender) {
    deliveryId = sequencing.createDeliveryId(parsed.sender, parsed.seq, recipientRole);
    sequencing.startDeliveryTracking(deliveryId, parsed.sender, parsed.seq, recipientRole, targets, 'trigger', 'pty');
  }
  const traceContext = normalizeTraceContext(null, { traceId: deliveryId || fallbackMessageId || null });
  emitOrganicMessageRoute(parsed.sender, targets);
  warRoom.recordWarRoomMessage({
    fromRole: parsed.sender,
    targets,
    message: stripRolePrefix(parsed.content || message),
    type: getTriggerMessageType(filename, targets),
    source: 'trigger',
    traceContext,
  });

  metrics.recordSent('pty', 'trigger', targets);
  sendStaggered(targets, formatTriggerMessage(message), { deliveryId, traceContext });
  try { fs.unlinkSync(processingPath); } catch (e) {}
  logTriggerActivity('Trigger file (PTY)', targets, message, {
    file: filename,
    sender: parsed.sender,
    mode: 'pty',
    messageId: fallbackMessageId || null,
  });
  return { success: true, notified: targets, mode: 'pty', deliveryId };
}

function broadcastToAllAgents(message, fromRole = 'user', options = {}) {
  let targets = [...PANE_IDS];
  const parsed = sequencing.parseMessageSequence(message);
  if ((!fromRole || fromRole === 'cli' || fromRole === 'user' || fromRole === 'unknown') && parsed.sender) fromRole = parsed.sender;
  const traceContext = normalizeTraceContext(options?.traceContext);

  warRoom.recordWarRoomMessage({
    fromRole,
    targets,
    message,
    type: 'broadcast',
    source: 'broadcast',
    traceContext,
  });

  const notified = [];
  if (agentRunning) { for (const [p, s] of agentRunning) { if (s === 'running' && targets.includes(p)) notified.push(p); } }
  if (notified.length === 0) {
    return buildDeliveryResult({
      accepted: false,
      queued: false,
      verified: false,
      status: 'no_targets',
      notified,
      mode: 'pty',
    });
  }

  const recipientRole = (notified.length === 1)
    ? (resolveRoleFromPaneId(notified[0]) || String(notified[0]))
    : 'broadcast';
  const senderRole = parsed.sender || (typeof fromRole === 'string' ? fromRole.toLowerCase() : null);
  const deliveryId = sequencing.createDeliveryId(senderRole || 'unknown', parsed.seq, recipientRole);
  sequencing.startDeliveryTracking(deliveryId, senderRole, parsed.seq, recipientRole, notified, 'broadcast', 'pty');

  metrics.recordSent('pty', 'broadcast', notified);
  sendStaggered(notified, `[BROADCAST] ${message}`, { traceContext, deliveryId });

  if (options?.awaitDelivery) {
    return waitForDeliveryVerification(
      deliveryId,
      notified,
      Number(options?.deliveryTimeoutMs) || getDeliveryVerifyTimeoutMs()
    ).then((verification) => buildDeliveryResult({
      accepted: true,
      queued: true,
      verified: verification.verified,
      status: verification.verified ? 'delivered.verified' : 'broadcast_unverified_timeout',
      notified,
      mode: 'pty',
      deliveryId,
      details: verification,
    }));
  }
  return buildDeliveryResult({
    accepted: true,
    queued: true,
    verified: false,
    status: 'broadcast_queued_unverified',
    notified,
    mode: 'pty',
    deliveryId,
  });
}

function sendDirectMessage(targetPanes, message, fromRole = null, options = {}) {
  if (!message) {
    return buildDeliveryResult({
      accepted: false,
      queued: false,
      verified: false,
      status: 'invalid_message',
      notified: [],
      mode: 'pty',
      details: { error: 'No message' },
    });
  }
  const parsed = sequencing.parseMessageSequence(message);
  if ((!fromRole || fromRole === 'cli' || fromRole === 'user' || fromRole === 'unknown') && parsed.sender) fromRole = parsed.sender;
  let targets = Array.isArray(targetPanes) ? [...targetPanes] : [];
  const traceContext = normalizeTraceContext(options?.traceContext);

  warRoom.recordWarRoomMessage({
    fromRole,
    targets,
    message,
    type: 'direct',
    source: 'direct',
    traceContext,
  });
  const fullMessage = (fromRole ? `[MSG from ${fromRole}]: ` : '') + message;

  // Direct agent-to-agent messages must not be dropped based on runtime state.
  // agentRunning can be stale during startup/reconnect and caused silent delivery loss.
  const notified = [...targets];
  if (notified.length === 0) {
    return buildDeliveryResult({
      accepted: false,
      queued: false,
      verified: false,
      status: 'no_targets',
      notified,
      mode: 'pty',
    });
  }

  const recipientRole = (notified.length === 1)
    ? (resolveRoleFromPaneId(notified[0]) || String(notified[0]))
    : 'direct_multi';
  const senderRole = parsed.sender || (typeof fromRole === 'string' ? fromRole.toLowerCase() : null);
  const deliveryId = sequencing.createDeliveryId(senderRole || 'unknown', parsed.seq, recipientRole);
  sequencing.startDeliveryTracking(deliveryId, senderRole, parsed.seq, recipientRole, notified, 'direct', 'pty');

  metrics.recordSent('pty', 'direct', notified);
  sendStaggered(notified, fullMessage, { traceContext, deliveryId });

  if (options?.awaitDelivery) {
    return waitForDeliveryVerification(
      deliveryId,
      notified,
      Number(options?.deliveryTimeoutMs) || getDeliveryVerifyTimeoutMs()
    ).then((verification) => buildDeliveryResult({
      accepted: true,
      queued: true,
      verified: verification.verified,
      status: verification.verified ? 'delivered.verified' : 'routed_unverified_timeout',
      notified,
      mode: 'pty',
      deliveryId,
      details: verification,
    }));
  }
  return buildDeliveryResult({
    accepted: true,
    queued: true,
    verified: false,
    status: 'routed_unverified',
    notified,
    mode: 'pty',
    deliveryId,
  });
}

module.exports = {
  init, setSelfHealing, setPluginManager, setWatcher,
  notifyAgents, notifyAllAgentsSync, handleTriggerFile, broadcastToAllAgents, sendDirectMessage,
  checkWorkflowGate,
  getReliabilityStats: metrics.getReliabilityStats,
  getSequenceState: sequencing.getSequenceState,
  handleDeliveryAck,
  onDeliveryAck,
  getNextSequence: sequencing.getNextSequence,
  parseMessageSequence: sequencing.parseMessageSequence,
  recordMessageSeen: sequencing.recordMessageSeen,
  isDuplicateMessage: sequencing.isDuplicateMessage,
  routeTask: routing.routeTask,
  triggerAutoHandoff: routing.triggerAutoHandoff,
  formatAuxEvent: routing.formatAuxEvent,
};
