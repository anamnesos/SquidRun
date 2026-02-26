/**
 * Trigger handling and agent notification functions
 * Extracted from main.js for modularization
 *
 * Main module that coordinates sub-modules:
 * - sequencing.js (duplicate prevention + sequencing)
 * - metrics.js (reliability stats)
 * - routing.js (smart routing + handoff)
 */

const fs = require('fs');
const crypto = require('crypto');
const {
  TRIGGER_TARGETS,
  PANE_IDS,
  ROLE_ID_MAP,
  BACKWARD_COMPAT_ROLE_ALIASES,
} = require('../config');
const log = require('./logger');
const organicUI = require('./ipc/organic-ui-handlers');

// Sub-modules
const metrics = require('./triggers/metrics');
const sequencing = require('./triggers/sequencing');
const routing = require('./triggers/routing');

// Module state
let mainWindow = null;
let agentRunning = null;
let watcher = null;
let logActivityFn = null;
let selfHealing = null;
let pluginManager = null;
let injectMessageRouter = null;

// Shared constants
const TRIGGER_PREFIX = '\x1b[1;33m[TRIGGER]\x1b[0m ';
const WORKER_PANES = ['2'];
const SYNC_DEBOUNCE_MS = 3000;
const SYNC_COALESCE_WINDOW_MS = 5000;
const STAGGER_BASE_DELAY_MS = 150;
const STAGGER_RANDOM_MS = 100;
const DELIVERY_VERIFY_TIMEOUT_MS = Number.parseInt(process.env.SQUIDRUN_DELIVERY_VERIFY_TIMEOUT_MS || '7000', 10);
const PRIORITY_KEYWORDS = ['STOP', 'URGENT', 'BLOCKING', 'ERROR'];
const TRIGGER_MESSAGE_ID_PREFIX = '[HM-MESSAGE-ID:';
const TRIGGER_MESSAGE_ID_REGEX = /^\[HM-MESSAGE-ID:([^\]\r\n]+)\]\r?\n?/;
const RECENT_TRIGGER_ID_TTL_MS = Number.parseInt(process.env.SQUIDRUN_TRIGGER_DEDUPE_TTL_MS || String(5 * 60 * 1000), 10);
const RECENT_TRIGGER_ID_LIMIT = Number.parseInt(process.env.SQUIDRUN_TRIGGER_DEDUPE_MAX || '2000', 10);
const STALE_PROCESSING_MAX_AGE_MS = Number.parseInt(process.env.SQUIDRUN_STALE_PROCESSING_MAX_AGE_MS || '60000', 10);

// Local state
const lastSyncTime = new Map();
let lastGlobalSyncTime = 0;
const deliveryAckListeners = new Set();
const recentTriggerIds = new Map();

function generateTraceToken(prefix = 'trc') {
  try {
    return `${prefix}-${crypto.randomUUID()}`;
  } catch {
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

function setInjectMessageRouter(routerFn) {
  injectMessageRouter = typeof routerFn === 'function' ? routerFn : null;
}

function dispatchInjectMessage(payload) {
  if (!payload || typeof payload !== 'object') return false;

  if (injectMessageRouter) {
    try {
      const handled = injectMessageRouter(payload);
      if (handled === true) return true;
    } catch (err) {
      log.warn('Trigger', `Inject router failed: ${err.message}`);
    }
  }

  const targetWindow = mainWindow;
  if (targetWindow && !targetWindow.isDestroyed()) {
    try {
      // Tag payload so the send-interceptor in squidrun-app (squidrun-app.js)
      // knows routeInjectMessage was already attempted and skips re-routing.
      targetWindow.webContents.send('inject-message', { ...payload, _routerAttempted: true });
      return true;
    } catch (err) {
      log.warn('Trigger', `Inject message dispatch failed: ${err.message}`);
    }
  }

  return false;
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

const CANONICAL_ROLE_TO_PANE = Object.freeze({
  architect: String(ROLE_ID_MAP?.architect || '1'),
  builder: String(ROLE_ID_MAP?.builder || '2'),
  oracle: String(ROLE_ID_MAP?.oracle || '3'),
});
const PANE_TO_CANONICAL_ROLE = Object.freeze(
  Object.fromEntries(
    Object.entries(CANONICAL_ROLE_TO_PANE).map(([role, paneId]) => [String(paneId), role])
  )
);
const TRIGGER_FILENAME_ALIASES = Object.freeze({
  'implementers.txt': 'workers.txt',
});

function normalizeRoleId(role) {
  if (!role) return null;
  const raw = String(role).trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!raw) return null;
  if (CANONICAL_ROLE_TO_PANE[raw]) return raw;
  return BACKWARD_COMPAT_ROLE_ALIASES?.[raw] || null;
}

function normalizeTriggerFilename(filename) {
  if (typeof filename !== 'string') return '';
  const normalized = filename.trim().toLowerCase();
  if (!normalized) return normalized;
  if (TRIGGER_TARGETS[normalized]) return normalized;
  if (TRIGGER_FILENAME_ALIASES[normalized]) return TRIGGER_FILENAME_ALIASES[normalized];

  if (normalized.startsWith('others-') && normalized.endsWith('.txt')) {
    const roleName = normalized.slice('others-'.length, -4);
    const canonicalRole = normalizeRoleId(roleName);
    if (canonicalRole) return `others-${canonicalRole}.txt`;
  }

  if (normalized.endsWith('.txt')) {
    const roleName = normalized.slice(0, -4);
    const canonicalRole = normalizeRoleId(roleName);
    if (canonicalRole) return `${canonicalRole}.txt`;
  }

  return normalized;
}

function resolvePaneIdFromRole(role) {
  if (!role) return null;
  const raw = String(role).trim().toLowerCase();
  if (/^\d+$/.test(raw)) return raw;
  const canonicalRole = normalizeRoleId(raw);
  if (!canonicalRole) return null;
  return CANONICAL_ROLE_TO_PANE[canonicalRole] || null;
}

function resolveRoleFromPaneId(paneId) {
  const targetPane = String(paneId || '').trim();
  if (!targetPane) return null;
  return PANE_TO_CANONICAL_ROLE[targetPane] || null;
}

function getDeliveryVerifyTimeoutMs() {
  return Number.isFinite(DELIVERY_VERIFY_TIMEOUT_MS) && DELIVERY_VERIFY_TIMEOUT_MS > 0
    ? DELIVERY_VERIFY_TIMEOUT_MS
    : 7000;
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
      unverifiedPanes: [],
      failedPanes: [],
      missingPanes: Array.from(expected),
      failureReason: null,
      timeoutMs,
    });
  }

  return new Promise((resolve) => {
    const acked = new Set();
    const unverified = new Set();
    const failed = new Set();
    const failureByPane = new Map();
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

    const disposeListener = onDeliveryAck((ackDeliveryId, paneId, outcome = null) => {
      if (ackDeliveryId !== deliveryId) return;
      const paneKey = String(paneId);
      if (!expected.has(paneKey)) return;

      const accepted = outcome?.accepted !== false;
      const explicitlyVerified = outcome?.verified === true;
      const statusLower = String(outcome?.status || '').toLowerCase();
      const isUnverifiedSignal = (
        outcome?.verified === false
        || statusLower.includes('unverified')
        || statusLower === 'delivered.enter_sent'
      );
      const isVerified = accepted && explicitlyVerified && !isUnverifiedSignal;

      if (isVerified) {
        acked.add(paneKey);
        unverified.delete(paneKey);
        failed.delete(paneKey);
        failureByPane.delete(paneKey);
      } else if (accepted) {
        acked.delete(paneKey);
        unverified.add(paneKey);
        failed.delete(paneKey);
        failureByPane.set(paneKey, {
          status: outcome?.status || 'accepted.unverified',
          reason: outcome?.reason || null,
        });
      } else {
        acked.delete(paneKey);
        unverified.delete(paneKey);
        failed.add(paneKey);
        failureByPane.set(paneKey, {
          status: outcome?.status || outcome?.reason || 'delivery_failed',
          reason: outcome?.reason || null,
        });
      }

      if (acked.size + unverified.size + failed.size >= expected.size) {
        const firstUnverifiedPane = Array.from(unverified)[0] || null;
        const firstFailedPane = Array.from(failed)[0] || null;
        const firstFailure = firstFailedPane
          ? failureByPane.get(firstFailedPane)
          : (firstUnverifiedPane ? failureByPane.get(firstUnverifiedPane) : null);
        finish({
          verified: failed.size === 0 && unverified.size === 0 && acked.size >= expected.size,
          ackedPanes: Array.from(acked),
          unverifiedPanes: Array.from(unverified),
          failedPanes: Array.from(failed),
          missingPanes: Array.from(expected).filter((candidate) => !acked.has(candidate) && !unverified.has(candidate) && !failed.has(candidate)),
          failureReason: firstFailure?.status || firstFailure?.reason || null,
          failureByPane: Object.fromEntries(failureByPane.entries()),
          timeoutMs,
        });
      }
    });

    const timeoutId = setTimeout(() => {
      const missingPanes = Array.from(expected).filter((paneId) => !acked.has(paneId) && !unverified.has(paneId) && !failed.has(paneId));
      const firstUnverifiedPane = Array.from(unverified)[0] || null;
      const firstFailedPane = Array.from(failed)[0] || null;
      const firstFailure = firstFailedPane
        ? failureByPane.get(firstFailedPane)
        : (firstUnverifiedPane ? failureByPane.get(firstUnverifiedPane) : null);
      finish({
        verified: false,
        ackedPanes: Array.from(acked),
        unverifiedPanes: Array.from(unverified),
        failedPanes: Array.from(failed),
        missingPanes,
        failureReason: firstFailure?.status || firstFailure?.reason || null,
        failureByPane: Object.fromEntries(failureByPane.entries()),
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
    const payload = { panes: notified, message: formatTriggerMessage(message) };
    if (deliveryId) payload.deliveryId = deliveryId;
    if (traceContext) payload.traceContext = traceContext;
    const dispatched = dispatchInjectMessage(payload);
    if (!dispatched) {
      log.warn('Trigger', `notifyAgents dispatch failed for panes: ${notified.join(',')}`);
      return [];
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
      listener(deliveryId, paneId, {
        accepted: true,
        verified: true,
        status: 'delivered.verified',
        reason: null,
      });
    } catch (err) {
      log.warn('Trigger', `Delivery ack listener failed: ${err.message}`);
    }
  }
}

function handleDeliveryOutcome(deliveryId, paneId, outcome = {}) {
  if (!deliveryId) return;
  sequencing.handleDeliveryOutcome(deliveryId, paneId, outcome);
  if (deliveryAckListeners.size === 0) return;
  const normalizedOutcome = {
    accepted: outcome?.accepted !== false,
    verified: outcome?.verified === true,
    status: outcome?.status || (
      outcome?.accepted === false
        ? 'delivery_failed'
        : (outcome?.verified === true ? 'delivered.verified' : 'accepted.unverified')
    ),
    reason: outcome?.reason || null,
  };
  for (const listener of deliveryAckListeners) {
    try {
      listener(deliveryId, paneId, normalizedOutcome);
    } catch (err) {
      log.warn('Trigger', `Delivery outcome listener failed: ${err.message}`);
    }
  }
}

function notifyAllAgentsSync(triggerFile) {
  const now = Date.now();
  if (now - lastGlobalSyncTime < SYNC_COALESCE_WINDOW_MS) return [];
  lastGlobalSyncTime = now;
  const message = `[SQUIDRUN SYNC] ${triggerFile} was updated. [FYI] Context updated. Do not respond.`;

  const runningPanes = [];
  if (agentRunning) {
    for (const [paneId, status] of agentRunning) {
      if (status === 'running' && (now - (lastSyncTime.get(paneId) || 0) > SYNC_DEBOUNCE_MS)) { runningPanes.push(paneId); lastSyncTime.set(paneId, now); }
    }
  }
  if (runningPanes.length > 0) {
    dispatchInjectMessage({ panes: runningPanes, message: formatTriggerMessage(message) });
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
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const deliveryId = meta?.deliveryId;
  let immediateDispatchCount = 0;
  panes.forEach((paneId, index) => {
    const delay = panes.length === 1 || isPriority ? 0 : (index * STAGGER_BASE_DELAY_MS + Math.random() * STAGGER_RANDOM_MS);
    if (delay === 0) {
      const targetWindow = mainWindow;
      if (!targetWindow || targetWindow.isDestroyed()) return;
      const dispatched = dispatchInjectMessage({
        panes: [paneId],
        message,
        deliveryId,
        traceContext,
      });
      if (dispatched) {
        immediateDispatchCount += 1;
      } else {
        log.warn('Trigger', `sendStaggered immediate dispatch failed for pane ${paneId}`);
      }
      return;
    }
    setTimeout(() => {
      const targetWindow = mainWindow;
      if (!targetWindow || targetWindow.isDestroyed()) return;
      const dispatched = dispatchInjectMessage({
        panes: [paneId],
        message,
        deliveryId,
        traceContext,
      });
      if (!dispatched) {
        log.warn('Trigger', `sendStaggered delayed dispatch failed for pane ${paneId}`);
      }
    }, delay);
  });
  if (panes.length === 1 || isPriority) {
    return immediateDispatchCount > 0;
  }
  return true;
}

function resolveRecipientRole(filename) {
  const normalizedFilename = normalizeTriggerFilename(filename);
  const role = normalizedFilename.replace('.txt', '').toLowerCase();
  if (role.startsWith('others-')) {
    const aliasRole = role.slice('others-'.length);
    const canonicalRole = normalizeRoleId(aliasRole);
    return canonicalRole ? `others-${canonicalRole}` : role;
  }
  const canonicalRole = normalizeRoleId(role);
  return canonicalRole || role;
}

function handleTriggerFile(filePath, filename) {
  const resolvedFilename = normalizeTriggerFilename(filename);
  let targets = TRIGGER_TARGETS[resolvedFilename];
  if (!targets) return { success: false, reason: 'unknown' };

  const gateCheck = checkWorkflowGate(targets);
  if (!gateCheck.allowed) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('trigger-blocked', { file: filename, resolvedFile: resolvedFilename, targets, reason: gateCheck.reason });
    }
    return { success: false, reason: 'workflow_gate' };
  }

  const processingPath = filePath + '.processing';
  try {
    if (fs.existsSync(processingPath)) {
      const processingStats = fs.statSync(processingPath);
      const ageMs = Date.now() - Number(processingStats?.mtimeMs || 0);
      if (Number.isFinite(ageMs) && ageMs >= STALE_PROCESSING_MAX_AGE_MS) {
        fs.unlinkSync(processingPath);
        log.warn('Trigger', `Removed stale processing file ${processingPath} (age ${Math.round(ageMs)}ms)`);
      } else {
        return { success: false, reason: 'already_processing' };
      }
    }
  } catch (err) {
    log.warn('Trigger', `Failed stale processing recovery for ${processingPath}: ${err.message}`);
    return { success: false, reason: 'rename_error' };
  }
  try { fs.renameSync(filePath, processingPath); }
  catch (err) {
    const reason = err.code === 'ENOENT' || err.code === 'EEXIST' ? 'already_processing' : 'rename_error';
    return { success: false, reason };
  }

  const cleanupProcessingFile = (stage) => {
    try {
      fs.unlinkSync(processingPath);
    } catch (err) {
      log.warn('Trigger', `Failed to clean up processing file ${processingPath} during ${stage}: ${err.message}`);
    }
  };

  let message;
  try {
    const raw = fs.readFileSync(processingPath);
    if (raw.length >= 2 && raw[0] === 0xFF && raw[1] === 0xFE) message = raw.slice(2).toString('utf16le').trim();
    else if (raw.length >= 3 && raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF) message = raw.slice(3).toString('utf-8').trim();
    else message = raw.toString('utf-8').trim();
    message = message.replace(/\0/g, '').replace(/[\x01-\x08\x0B\x0C\x0E-\x1F]/g, '');
  } catch {
    cleanupProcessingFile('read_error');
    return { success: false, reason: 'read_error' };
  }

  try {
    const extracted = extractTriggerMessageId(message);
    const fallbackMessageId = extracted.messageId;
    message = extracted.content;

    if (fallbackMessageId) {
      if (isRecentTriggerId(fallbackMessageId)) {
        log.warn('Trigger', `Skipping duplicate fallback messageId ${fallbackMessageId}`);
        return { success: false, reason: 'duplicate_message_id' };
      }
      markRecentTriggerId(fallbackMessageId);
    }

    if (!message) return { success: false, reason: 'empty' };

    let parsed = sequencing.parseMessageSequence(message);
    const recipientRole = resolveRecipientRole(resolvedFilename);
    if (parsed.seq !== null && parsed.sender) {
      if (!sequencing.messageState.sequences[recipientRole]) {
        sequencing.messageState.sequences[recipientRole] = { outbound: 0, lastSeen: {} };
      }
      if (parsed.seq === 1 && message.includes('# SQUIDRUN SESSION:')) {
        if (!sequencing.messageState.sequences[recipientRole].lastSeen) {
          sequencing.messageState.sequences[recipientRole].lastSeen = {};
        }
        sequencing.messageState.sequences[recipientRole].lastSeen[parsed.sender] = 0;
        log.info('Trigger', `Reset lastSeen for ${parsed.sender} -> ${recipientRole} (Session Reset)`);
      }
      if (sequencing.isDuplicateMessage(parsed.sender, parsed.seq, recipientRole)) {
        metrics.recordSkipped(parsed.sender, parsed.seq, recipientRole);
        return { success: false, reason: 'duplicate' };
      }
    }

    if (resolvedFilename === 'all.txt' && parsed.sender) {
      const senderPaneId = resolvePaneIdFromRole(parsed.sender);
      if (senderPaneId) targets = targets.filter(t => t !== senderPaneId);
    }

    let deliveryId = null;
    if (parsed.seq !== null && parsed.sender) {
      deliveryId = sequencing.createDeliveryId(parsed.sender, parsed.seq, recipientRole);
      sequencing.startDeliveryTracking(deliveryId, parsed.sender, parsed.seq, recipientRole, targets, 'trigger', 'pty');
    }
    const traceContext = normalizeTraceContext(null, { traceId: deliveryId || fallbackMessageId || null });
    emitOrganicMessageRoute(parsed.sender, targets);

    metrics.recordSent('pty', 'trigger', targets);
    sendStaggered(targets, formatTriggerMessage(message), { deliveryId, traceContext });
    logTriggerActivity('Trigger file (PTY)', targets, message, {
      file: filename,
      resolvedFile: resolvedFilename,
      sender: parsed.sender,
      mode: 'pty',
      messageId: fallbackMessageId || null,
    });
    return { success: true, notified: targets, mode: 'pty', deliveryId };
  } finally {
    cleanupProcessingFile('post_read_processing');
  }
}

function broadcastToAllAgents(message, fromRole = 'user', options = {}) {
  let targets = [...PANE_IDS];
  const parsed = sequencing.parseMessageSequence(message);
  if ((!fromRole || fromRole === 'cli' || fromRole === 'user' || fromRole === 'unknown') && parsed.sender) fromRole = parsed.sender;
  const traceContext = normalizeTraceContext(options?.traceContext);

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
    ).then((verification) => {
      if (verification?.failedPanes?.length) {
        return buildDeliveryResult({
          accepted: false,
          queued: false,
          verified: false,
          status: verification.failureReason || 'delivery_failed',
          notified,
          mode: 'pty',
          deliveryId,
          details: verification,
        });
      }
      return buildDeliveryResult({
        accepted: true,
        queued: true,
        verified: verification.verified,
        status: verification.verified
          ? 'delivered.verified'
          : (verification?.unverifiedPanes?.length ? 'accepted.unverified' : 'broadcast_unverified_timeout'),
        notified,
        mode: 'pty',
        deliveryId,
        details: verification,
      });
    });
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

  if (!mainWindow || mainWindow.isDestroyed()) {
    return buildDeliveryResult({
      accepted: false,
      queued: false,
      verified: false,
      status: 'window_unavailable',
      notified: [],
      mode: 'pty',
      details: { error: 'main_window_unavailable' },
    });
  }

  const recipientRole = (notified.length === 1)
    ? (resolveRoleFromPaneId(notified[0]) || String(notified[0]))
    : 'direct_multi';
  const senderRole = parsed.sender || (typeof fromRole === 'string' ? fromRole.toLowerCase() : null);
  const deliveryId = sequencing.createDeliveryId(senderRole || 'unknown', parsed.seq, recipientRole);
  const queued = sendStaggered(notified, fullMessage, { traceContext, deliveryId });
  if (!queued) {
    return buildDeliveryResult({
      accepted: false,
      queued: false,
      verified: false,
      status: 'window_unavailable',
      notified: [],
      mode: 'pty',
      deliveryId,
      details: { error: 'main_window_unavailable' },
    });
  }
  sequencing.startDeliveryTracking(deliveryId, senderRole, parsed.seq, recipientRole, notified, 'direct', 'pty');
  metrics.recordSent('pty', 'direct', notified);

  if (options?.awaitDelivery) {
    return waitForDeliveryVerification(
      deliveryId,
      notified,
      Number(options?.deliveryTimeoutMs) || getDeliveryVerifyTimeoutMs()
    ).then((verification) => {
      if (verification?.failedPanes?.length) {
        return buildDeliveryResult({
          accepted: false,
          queued: false,
          verified: false,
          status: verification.failureReason || 'delivery_failed',
          notified,
          mode: 'pty',
          deliveryId,
          details: verification,
        });
      }
      return buildDeliveryResult({
        accepted: true,
        queued: true,
        verified: verification.verified,
        status: verification.verified
          ? 'delivered.verified'
          : (verification?.unverifiedPanes?.length ? 'accepted.unverified' : 'routed_unverified_timeout'),
        notified,
        mode: 'pty',
        deliveryId,
        details: verification,
      });
    });
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
  setInjectMessageRouter,
  notifyAgents, notifyAllAgentsSync, handleTriggerFile, broadcastToAllAgents, sendDirectMessage,
  checkWorkflowGate,
  getReliabilityStats: metrics.getReliabilityStats,
  getSequenceState: sequencing.getSequenceState,
  handleDeliveryAck,
  handleDeliveryOutcome,
  onDeliveryAck,
  getNextSequence: sequencing.getNextSequence,
  parseMessageSequence: sequencing.parseMessageSequence,
  recordMessageSeen: sequencing.recordMessageSeen,
  isDuplicateMessage: sequencing.isDuplicateMessage,
  routeTask: routing.routeTask,
  triggerAutoHandoff: routing.triggerAutoHandoff,
  formatAuxEvent: routing.formatAuxEvent,
};
