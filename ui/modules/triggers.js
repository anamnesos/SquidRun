/**
 * Trigger handling and agent notification functions
 * Extracted from main.js for modularization
 *
 * SDK integration: When SDK mode is enabled, triggers route
 * through sdk-bridge instead of PTY keyboard injection.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { TRIGGER_TARGETS, WORKSPACE_PATH, PANE_IDS } = require('../config');
const log = require('./logger');
const diagnosticLog = require('./diagnostic-log');
const smartRouting = require('./smart-routing');
const { formatDuration } = require('./formatters');

// Memory system for trigger logging
let memory = null;
try {
  memory = require('./memory');
} catch (e) {
  // Memory system not available - continue without logging
}

// Module state (set by init)
let mainWindow = null;
let agentRunning = null;  // Renamed from claudeRunning - agents can be Claude, Codex, or Gemini
let watcher = null; // Reference to watcher module for state checks
let logActivityFn = null; // Activity log function from main.js
let selfHealing = null; // Optional self-healing manager
let pluginManager = null; // Optional plugin manager

// SDK Integration
let sdkBridge = null;
let sdkModeEnabled = false;

// ============================================================
// MESSAGE SEQUENCING - Prevents duplicate/out-of-order messages
// ============================================================

const MESSAGE_STATE_PATH = path.join(WORKSPACE_PATH, 'message-state.json');
const DELIVERY_ACK_TIMEOUT_MS = 65000;
const pendingDeliveries = new Map();

// ============================================================
// RELIABILITY METRICS (Task #8)
// ============================================================

const ROLLING_WINDOW_15M = 15 * 60 * 1000;
const ROLLING_WINDOW_1H = 60 * 60 * 1000;

// Event log for time-windowed analysis
const metricsEventLog = [];
const MAX_METRICS_EVENTS = 2000;

// Aggregate stats since app start
const reliabilityStats = {
  startTime: Date.now(),
  aggregate: {
    sent: 0,
    delivered: 0,
    failed: 0,
    timedOut: 0,
    skipped: 0,  // duplicates
    retries: 0,
  },
  byMode: {
    sdk: { sent: 0, delivered: 0, failed: 0 },
    pty: { sent: 0, delivered: 0, failed: 0, timedOut: 0 },
  },
  byPane: {},  // paneId -> { sent, delivered, failed }
  byType: {
    trigger: { sent: 0, delivered: 0, failed: 0 },
    broadcast: { sent: 0, delivered: 0, failed: 0 },
    direct: { sent: 0, delivered: 0, failed: 0 },
  },
  latency: {
    samples: [],  // { queuedAt, sentAt, ackedAt }
    maxSamples: 100,
  },
};

// Initialize per-pane stats
PANE_IDS.forEach(id => {
  reliabilityStats.byPane[id] = { sent: 0, delivered: 0, failed: 0 };
});

/**
 * Record a metrics event for time-windowed analysis
 */
function recordMetricsEvent(type, data) {
  const event = {
    timestamp: Date.now(),
    type,
    ...data,
  };
  metricsEventLog.push(event);
  if (metricsEventLog.length > MAX_METRICS_EVENTS) {
    metricsEventLog.shift();
  }
}

/**
 * Get events within a time window
 */
function getEventsInWindow(windowMs) {
  const cutoff = Date.now() - windowMs;
  return metricsEventLog.filter(e => e.timestamp >= cutoff);
}

/**
 * Calculate stats from events in a window
 */
function calculateWindowStats(windowMs) {
  const events = getEventsInWindow(windowMs);
  const stats = { sent: 0, delivered: 0, failed: 0, timedOut: 0, skipped: 0 };

  events.forEach(e => {
    if (e.type === 'sent') stats.sent++;
    else if (e.type === 'delivered') stats.delivered++;
    else if (e.type === 'failed') stats.failed++;
    else if (e.type === 'timeout') stats.timedOut++;
    else if (e.type === 'skipped') stats.skipped++;
  });

  return stats;
}

/**
 * Record message sent
 */
function recordSent(mode, msgType, panes, queuedAt = null) {
  const sentAt = Date.now();
  reliabilityStats.aggregate.sent++;

  if (reliabilityStats.byMode[mode]) {
    reliabilityStats.byMode[mode].sent++;
  }
  if (reliabilityStats.byType[msgType]) {
    reliabilityStats.byType[msgType].sent++;
  }

  panes.forEach(paneId => {
    if (reliabilityStats.byPane[paneId]) {
      reliabilityStats.byPane[paneId].sent++;
    }
  });

  recordMetricsEvent('sent', { mode, msgType, panes, queuedAt, sentAt });

  return { sentAt, queuedAt };
}

/**
 * Record successful delivery
 */
function recordDelivered(mode, msgType, paneId, sentAt = null) {
  const ackedAt = Date.now();
  reliabilityStats.aggregate.delivered++;

  if (reliabilityStats.byMode[mode]) {
    reliabilityStats.byMode[mode].delivered++;
  }
  if (reliabilityStats.byType[msgType]) {
    reliabilityStats.byType[msgType].delivered++;
  }
  if (reliabilityStats.byPane[paneId]) {
    reliabilityStats.byPane[paneId].delivered++;
  }

  // Track latency if we have sentAt
  if (sentAt) {
    const latency = ackedAt - sentAt;
    reliabilityStats.latency.samples.push({ sentAt, ackedAt, latency });
    if (reliabilityStats.latency.samples.length > reliabilityStats.latency.maxSamples) {
      reliabilityStats.latency.samples.shift();
    }
  }

  recordMetricsEvent('delivered', { mode, msgType, paneId, sentAt, ackedAt });
}

/**
 * Record failed delivery
 */
function recordFailed(mode, msgType, paneId, reason) {
  reliabilityStats.aggregate.failed++;

  if (reliabilityStats.byMode[mode]) {
    reliabilityStats.byMode[mode].failed++;
  }
  if (reliabilityStats.byType[msgType]) {
    reliabilityStats.byType[msgType].failed++;
  }
  if (reliabilityStats.byPane[paneId]) {
    reliabilityStats.byPane[paneId].failed++;
  }

  recordMetricsEvent('failed', { mode, msgType, paneId, reason });
}

/**
 * Record delivery timeout
 */
function recordTimeout(mode, msgType, panes) {
  reliabilityStats.aggregate.timedOut++;

  if (reliabilityStats.byMode[mode]) {
    reliabilityStats.byMode[mode].timedOut++;
  }

  recordMetricsEvent('timeout', { mode, msgType, panes });
}

/**
 * Record skipped (duplicate) message
 */
function recordSkipped(sender, seq, recipient) {
  reliabilityStats.aggregate.skipped++;
  recordMetricsEvent('skipped', { sender, seq, recipient });
}

/**
 * Get comprehensive reliability statistics
 */
function getReliabilityStats() {
  const now = Date.now();
  const uptime = now - reliabilityStats.startTime;

  // Calculate average latency
  const latencySamples = reliabilityStats.latency.samples;
  let avgLatency = 0;
  let minLatency = 0;
  let maxLatency = 0;

  if (latencySamples.length > 0) {
    const latencies = latencySamples.map(s => s.latency);
    avgLatency = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
    minLatency = Math.min(...latencies);
    maxLatency = Math.max(...latencies);
  }

  // Calculate success rate
  const { sent, delivered, failed, timedOut, skipped } = reliabilityStats.aggregate;
  const successRate = sent > 0 ? Math.round((delivered / sent) * 100) : 100;

  return {
    uptime,
    uptimeFormatted: formatDuration(uptime),
    aggregate: { ...reliabilityStats.aggregate, successRate },
    byMode: { ...reliabilityStats.byMode },
    byPane: { ...reliabilityStats.byPane },
    byType: { ...reliabilityStats.byType },
    latency: {
      avg: avgLatency,
      min: minLatency,
      max: maxLatency,
      sampleCount: latencySamples.length,
    },
    windows: {
      last15m: calculateWindowStats(ROLLING_WINDOW_15M),
      last1h: calculateWindowStats(ROLLING_WINDOW_1H),
    },
  };
}

// formatDuration now imported from ./formatters

// In-memory sequence tracking (loaded from file on init)
let messageState = {
  version: 1,
  sequences: {
    'architect': { outbound: 0, lastSeen: {} },
    'infra': { outbound: 0, lastSeen: {} },
    'frontend': { outbound: 0, lastSeen: {} },
    'backend': { outbound: 0, lastSeen: {} },
    'analyst': { outbound: 0, lastSeen: {} },
    'reviewer': { outbound: 0, lastSeen: {} },
  },
};

/**
 * Load message state from disk
 */
function loadMessageState() {
  try {
    // Reset lastSeen on app startup to prevent stale sequence blocking
    // New agent instances start from #1, so old "lastSeen" values would block all messages
    // We keep the structure but clear lastSeen so fresh sessions work immediately
    log.info('MessageSeq', 'Resetting message state for fresh session');
    messageState = {
      version: 1,
      sequences: {
        'architect': { outbound: 0, lastSeen: {} },
        'infra': { outbound: 0, lastSeen: {} },
        'frontend': { outbound: 0, lastSeen: {} },
        'backend': { outbound: 0, lastSeen: {} },
        'analyst': { outbound: 0, lastSeen: {} },
        'reviewer': { outbound: 0, lastSeen: {} },
      }
    };
    saveMessageState();
    log.info('MessageSeq', 'Fresh state initialized');
  } catch (err) {
    log.error('MessageSeq', 'Error initializing state:', err);
  }
}

/**
 * Save message state to disk (atomic write)
 */
function saveMessageState() {
  try {
    messageState.lastUpdated = new Date().toISOString();
    const tempPath = MESSAGE_STATE_PATH + '.tmp';
    fs.writeFileSync(tempPath, JSON.stringify(messageState, null, 2), 'utf-8');
    fs.renameSync(tempPath, MESSAGE_STATE_PATH);
  } catch (err) {
    log.error('MessageSeq', 'Error saving state:', err);
  }
}

/**
 * Parse sequence info from message
 * Format: "(ROLE #SEQ): message" per Reviewer spec
 * @param {string} message - Raw message content
 * @returns {{ seq: number|null, sender: string|null, content: string }}
 */
function parseMessageSequence(message) {
  // Primary format: "(ROLE #N): message" - per Reviewer spec
  // Regex: /^\((\w+(?:-\w+)?)\s*#(\d+)\):\s*(.*)$/s
  const seqMatch = message.match(/^\((\w+(?:-\w+)?)\s*#(\d+)\):\s*(.*)$/s);
  if (seqMatch) {
    return {
      seq: parseInt(seqMatch[2], 10),
      sender: seqMatch[1].toLowerCase(),
      content: `(${seqMatch[1]}): ${seqMatch[3]}`, // Strip seq for display
    };
  }

  // Backwards compat: "(ROLE): message" - no sequence (treated as seq=0)
  const roleMatch = message.match(/^\((\w+(?:-\w+)?)\):\s*(.*)$/s);
  if (roleMatch) {
    return {
      seq: null, // null = seq 0, always process for backwards compat
      sender: roleMatch[1].toLowerCase(),
      content: message,
    };
  }

  // No recognizable format
  return { seq: null, sender: null, content: message };
}

/**
 * Check if message is a duplicate (already seen this seq from this sender)
 * @param {string} sender - Sender role (lowercase, hyphenated)
 * @param {number} seq - Sequence number
 * @param {string} recipient - Recipient role
 * @returns {boolean} true if duplicate
 */
function isDuplicateMessage(sender, seq, recipient) {
  if (seq === null || !sender) return false;

  const recipientState = messageState.sequences[recipient];
  if (!recipientState) return false;

  const lastSeen = recipientState.lastSeen[sender] || 0;
  return seq <= lastSeen;
}

/**
 * Record that we've seen a message sequence
 * @param {string} sender - Sender role
 * @param {number} seq - Sequence number
 * @param {string} recipient - Recipient role
 */
function recordMessageSeen(sender, seq, recipient) {
  if (seq === null || !sender) return;

  if (!messageState.sequences[recipient]) {
    messageState.sequences[recipient] = { outbound: 0, lastSeen: {} };
  }

  const currentLast = messageState.sequences[recipient].lastSeen[sender] || 0;
  if (seq > currentLast) {
    messageState.sequences[recipient].lastSeen[sender] = seq;
    saveMessageState();
  }
}

function createDeliveryId(sender, seq, recipient) {
  if (crypto.randomUUID) {
    return crypto.randomUUID();
  }
  const safeSender = sender || 'unknown';
  const safeSeq = Number.isInteger(seq) ? String(seq) : 'na';
  const safeRecipient = recipient || 'unknown';
  return `${safeSender}-${safeSeq}-${safeRecipient}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function startDeliveryTracking(deliveryId, sender, seq, recipient, targets, msgType = 'trigger', mode = 'pty') {
  if (!deliveryId) return;
  const expected = new Set((targets || []).map(paneId => String(paneId)));
  const sentAt = Date.now();
  const pending = {
    sender,
    seq,
    recipient,
    expected,
    received: new Set(),
    timeoutId: null,
    sentAt,
    msgType,
    mode,
  };

  pending.timeoutId = setTimeout(() => {
    pendingDeliveries.delete(deliveryId);
    log.warn('Trigger', `Delivery timeout for ${sender} #${seq} -> ${recipient} (received ${pending.received.size}/${pending.expected.size})`);
    // Record timeout metric
    recordTimeout(mode, msgType, Array.from(expected));
  }, DELIVERY_ACK_TIMEOUT_MS);

  pendingDeliveries.set(deliveryId, pending);
}

function handleDeliveryAck(deliveryId, paneId) {
  if (!deliveryId) return;
  const pending = pendingDeliveries.get(deliveryId);
  if (!pending) return;

  const paneKey = String(paneId);
  pending.received.add(paneKey);

  // Record per-pane delivery metric
  recordDelivered(pending.mode, pending.msgType, paneKey, pending.sentAt);

  if (pending.received.size < pending.expected.size) {
    return;
  }

  clearTimeout(pending.timeoutId);
  pendingDeliveries.delete(deliveryId);
  recordMessageSeen(pending.sender, pending.seq, pending.recipient);
  log.info('Trigger', `Recorded delivery: ${pending.sender} #${pending.seq} -> ${pending.recipient}`);
}

/**
 * Get next outbound sequence number for a sender
 * @param {string} sender - Sender role
 * @returns {number}
 */
function getNextSequence(sender) {
  if (!messageState.sequences[sender]) {
    messageState.sequences[sender] = { outbound: 0, lastSeen: {} };
  }
  messageState.sequences[sender].outbound++;
  saveMessageState();
  return messageState.sequences[sender].outbound;
}

/**
 * Get current sequence state (for debugging/UI)
 */
function getSequenceState() {
  return { ...messageState };
}

// Worker pane IDs that require reviewer approval before triggering
// Note: Analyst (pane 5) excluded - they handle debugging/analysis, not implementation
const WORKER_PANES = ['3', '4'];

// Track last sync time per pane to prevent self-sync
const lastSyncTime = new Map(); // paneId -> timestamp
const SYNC_DEBOUNCE_MS = 3000; // Skip sync if pane was synced within 3 seconds

// SYNC Coalescing: Max 1 auto-sync per 5s window (Session 61 optimization)
// Additional syncs during window are DROPPED (lossy > late)
// Agent-to-agent messages bypass coalescing (only auto-sync affected)
let lastGlobalSyncTime = 0;
const SYNC_COALESCE_WINDOW_MS = 5000; // 5 second coalescing window

// Stagger delays to avoid thundering herd when multiple panes receive messages
const STAGGER_BASE_DELAY_MS = 150; // Base delay between panes
const STAGGER_RANDOM_MS = 100; // Random jitter added to base delay

// Priority keywords that bypass stagger delay (urgent messages)
const PRIORITY_KEYWORDS = ['STOP', 'URGENT', 'BLOCKING', 'ERROR'];

/**
 * Check if message contains priority keywords requiring immediate delivery
 * @param {string} message - Message content
 * @returns {boolean} true if message should bypass stagger delay
 */
function isPriorityMessage(message) {
  if (!message) return false;
  const upperMessage = message.toUpperCase();
  return PRIORITY_KEYWORDS.some(keyword => upperMessage.includes(keyword));
}

// Reverse map: role name -> pane ID (for sender exclusion)
const ROLE_TO_PANE = {
  'architect': '1',
  'infra': '2',
  'frontend': '3',
  'backend': '4',
  'analyst': '5',
  'reviewer': '6',
  // Legacy role names (backwards compat)
  'lead': '1',
  'orchestrator': '2',
  'worker-a': '3',
  'worker-b': '4',
  'investigator': '5',
};

/**
 * Initialize the triggers module with shared state
 * @param {BrowserWindow} window - The main Electron window
 * @param {Map} agentState - Map tracking agent running state per pane (Claude, Codex, or Gemini)
 * @param {Function} logActivity - Activity logging function from main.js
 */
function init(window, agentState, logActivity) {
  mainWindow = window;
  agentRunning = agentState;
  logActivityFn = logActivity || null;
  // Load message sequence state from disk
  loadMessageState();
}

/**
 * Attach self-healing manager for task recovery context
 * @param {object} manager - Self-healing manager instance
 */
function setSelfHealing(manager) {
  selfHealing = manager || null;
}

function setPluginManager(manager) {
  pluginManager = manager || null;
}

function applyPluginHookSync(eventName, payload) {
  if (!pluginManager || !pluginManager.hasHook(eventName)) {
    return payload;
  }
  return pluginManager.applyHookSync(eventName, payload);
}

function dispatchPluginEvent(eventName, payload) {
  if (!pluginManager || !pluginManager.hasHook(eventName)) {
    return;
  }
  pluginManager.dispatch(eventName, payload).catch(() => {});
}

function recordSelfHealingMessage(paneId, message, meta = {}) {
  if (!selfHealing || typeof selfHealing.recordTask !== 'function') return;
  selfHealing.recordTask(paneId, message, meta);
}

/**
 * Log trigger activity to activity log
 * @param {string} action - Action type (sent, received, routed, handoff)
 * @param {Array|string} panes - Target pane(s)
 * @param {string} message - Message content
 * @param {object} extra - Additional details (sender, source, etc.)
 */
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

/**
 * SDK: Set SDK bridge reference for direct message delivery
 * @param {SDKBridge} bridge - The SDK bridge instance
 */
function setSDKBridge(bridge) {
  sdkBridge = bridge;
  log.info('Triggers', 'SDK bridge set');
}

/**
 * SDK: Enable/disable SDK mode for message delivery
 * @param {boolean} enabled - Whether SDK mode is active
 */
function setSDKMode(enabled) {
  sdkModeEnabled = enabled;
  log.info('Triggers', `SDK mode ${enabled ? 'ENABLED' : 'DISABLED'}`);
}

/**
 * SDK: Check if SDK mode is active
 * @returns {boolean}
 */
function isSDKModeEnabled() {
  return sdkModeEnabled && sdkBridge !== null;
}

const TRIGGER_PREFIX = '\x1b[1;33m[TRIGGER]\x1b[0m ';

function formatTriggerMessage(message) {
  if (!message) return message;
  if (message.startsWith(TRIGGER_PREFIX)) return message;
  return `${TRIGGER_PREFIX}${message}`;
}

/**
 * Set watcher reference for state checks (called after watcher.init)
 * @param {Object} watcherModule - The watcher module
 */
function setWatcher(watcherModule) {
  watcher = watcherModule;
}

/**
 * Check if workflow gate allows triggering workers
 * Workers can only be triggered when state is EXECUTING
 * @param {string[]} targets - Pane IDs being triggered
 * @returns {{ allowed: boolean, reason?: string }}
 */
function checkWorkflowGate(targets) {
  // Check if any targets are workers
  const hasWorkerTargets = targets.some(t => WORKER_PANES.includes(t));
  if (!hasWorkerTargets) {
    return { allowed: true }; // Not targeting workers, allow
  }

  // Workers targeted - check state
  if (!watcher) {
    log.warn('Workflow Gate', 'Watcher not initialized, allowing trigger');
    return { allowed: true };
  }

  const state = watcher.readState();
  const currentState = state.state;

  // Workers can be triggered in these states (includes planning states for coordination)
  const allowedStates = [
    'executing',
    'checkpoint_fix',
    'idle',
    'project_selected',
    'planning',
    'friction_sync',
    'friction_logged'
  ];
  if (allowedStates.includes(currentState)) {
    return { allowed: true };
  }

  // BLOCKED: Only during review/verification phases
  return {
    allowed: false,
    reason: `Workers blocked during '${currentState}' - wait for review phase to complete`
  };
}

/**
 * Send context message to active agents
 * NOTE: Only works when Claude is running in terminal, not raw shell
 * Routes through SDK when SDK mode is enabled
 * @param {string[]} agents - Array of pane IDs to notify
 * @param {string} message - Message to send
 */
function notifyAgents(agents, message) {
  if (!message) return;
  let targets = Array.isArray(agents) ? [...agents] : [];
  const beforePayload = applyPluginHookSync('message:beforeSend', {
    type: 'notify',
    targets,
    message,
    mode: isSDKModeEnabled() ? 'sdk' : 'pty',
  });
  if (beforePayload && beforePayload.cancel) {
    return [];
  }
  if (beforePayload && typeof beforePayload.message === 'string') {
    message = beforePayload.message;
  }
  if (beforePayload && Array.isArray(beforePayload.targets)) {
    targets = beforePayload.targets;
  }

  // SDK MODE: Route through SDK bridge (no running check needed - SDK manages sessions)
  if (isSDKModeEnabled()) {
    if (targets.length === 0) return [];
    log.info('notifyAgents SDK', `Sending to ${targets.length} pane(s) via SDK: ${message.substring(0, 50)}...`);
    let successCount = 0;
    for (const paneId of targets) {
      // Display incoming message in pane UI so user can see agent-to-agent messages
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('sdk-message', {
          paneId: paneId,
          message: { type: 'user', content: message }
        });
      }
      try {
        const sent = sdkBridge.sendMessage(paneId, message);
        if (sent) {
          successCount++;
        } else {
          recordFailed('sdk', 'trigger', paneId, 'SDK send returned false');
        }
      } catch (err) {
        log.error('Triggers', 'SDK send failed', { paneId, error: err.message });
        recordFailed('sdk', 'trigger', paneId, `SDK exception: ${err.message}`);
      }
    }
    log.info('notifyAgents SDK', `Delivered to ${successCount}/${targets.length} panes`);
    logTriggerActivity('Sent (SDK)', targets, message, { mode: 'sdk', delivered: successCount });
    dispatchPluginEvent('message:afterSend', {
      type: 'notify',
      targets,
      message,
      mode: 'sdk',
      success: successCount === targets.length,
    });
    return targets; // SDK mode doesn't filter by running state
  }

  // PTY MODE (legacy): Only send to panes where agent is confirmed running
  const notified = [];
  for (const paneId of targets) {
    if (agentRunning && agentRunning.get(paneId) === 'running') {
      notified.push(paneId);
    }
  }

  if (notified.length > 0) {
    const triggerMessage = formatTriggerMessage(message);
    log.info('notifyAgents', `Sent to panes ${notified.join(', ')}: ${message.substring(0, 50)}...`);
    // Send to renderer which uses terminal.paste() for proper execution
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('inject-message', { panes: notified, message: triggerMessage + '\r' });
    }
    logTriggerActivity('Sent (PTY)', notified, message, { mode: 'pty' });
  } else {
    log.info('notifyAgents', `Skipped (no Claude running): ${targets.join(', ')}`);
  }

  dispatchPluginEvent('message:afterSend', {
    type: 'notify',
    targets: notified,
    message,
    mode: 'pty',
    success: notified.length > 0,
  });

  return notified;
}

/**
 * AUTO-SYNC: Notify ALL agents when trigger files change
 * This enables the autonomous improvement loop
 * Routes through SDK when SDK mode is enabled
 *
 * COALESCING (Session 61): Max 1 sync per 5s window.
 * Additional syncs during window are DROPPED (lossy > late).
 * Agent-to-agent messages bypass coalescing (only auto-sync affected).
 *
 * @param {string} triggerFile - Name of the file that changed
 */
function notifyAllAgentsSync(triggerFile) {
  const now = Date.now();

  // SYNC COALESCING: Drop syncs within 5s window (lossy > late)
  const timeSinceLastSync = now - lastGlobalSyncTime;
  if (timeSinceLastSync < SYNC_COALESCE_WINDOW_MS) {
    log.info('AUTO-SYNC', `DROPPED (coalescing): ${triggerFile} - only ${timeSinceLastSync}ms since last sync, window is ${SYNC_COALESCE_WINDOW_MS}ms`);
    return [];
  }

  // Update global sync time for coalescing window
  lastGlobalSyncTime = now;

  const message = `[HIVEMIND SYNC] ${triggerFile} was updated. [FYI] Context updated. Do not respond.`;

  // SDK MODE: Broadcast through SDK bridge (no running check - SDK manages sessions)
  if (isSDKModeEnabled()) {
    // Still apply debounce to prevent sync storms
    const eligiblePanes = [];
    for (const paneId of PANE_IDS) {
      const lastSync = lastSyncTime.get(paneId) || 0;
      if (now - lastSync > SYNC_DEBOUNCE_MS) {
        eligiblePanes.push(paneId);
        lastSyncTime.set(paneId, now);
      }
    }

    if (eligiblePanes.length > 0) {
      log.info('AUTO-SYNC SDK', `Notifying panes ${eligiblePanes.join(', ')}: ${triggerFile} changed`);
      for (const paneId of eligiblePanes) {
        // Display incoming message in pane UI so user can see agent-to-agent messages
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('sdk-message', {
            paneId: paneId,
            message: { type: 'user', content: message }
          });
        }
        try {
          const sent = sdkBridge.sendMessage(paneId, message);
          if (!sent) {
            recordFailed('sdk', 'trigger', paneId, 'SDK send returned false');
          }
        } catch (err) {
          log.error('Triggers', 'SDK send failed', { paneId, error: err.message });
          recordFailed('sdk', 'trigger', paneId, `SDK exception: ${err.message}`);
        }
      }
    } else {
      log.info('AUTO-SYNC SDK', 'All panes recently synced, skipping');
    }

    // Notify renderer for UI update
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('sync-triggered', { file: triggerFile, notified: eligiblePanes, mode: 'sdk' });
    }

    if (eligiblePanes.length > 0) {
      logTriggerActivity('Auto-sync (SDK)', eligiblePanes, message, { file: triggerFile, mode: 'sdk' });
    }
    return eligiblePanes;
  }

  // PTY mode (legacy): get list of running agent panes, excluding recently synced
  const runningPanes = [];
  const skippedPanes = [];
  if (agentRunning) {
    for (const [paneId, status] of agentRunning) {
      if (status === 'running') {
        const lastSync = lastSyncTime.get(paneId) || 0;
        if (now - lastSync > SYNC_DEBOUNCE_MS) {
          runningPanes.push(paneId);
          lastSyncTime.set(paneId, now);
        } else {
          skippedPanes.push(paneId);
        }
      }
    }
  }

  if (skippedPanes.length > 0) {
    log.info('AUTO-SYNC', `Skipped panes (recently synced): ${skippedPanes.join(', ')}`);
  }

  if (runningPanes.length > 0) {
    const triggerMessage = formatTriggerMessage(message);
    log.info('AUTO-SYNC', `Notifying panes ${runningPanes.join(', ')}: ${triggerFile} changed`);
    // Send to renderer which uses terminal.paste() for proper execution
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('inject-message', { panes: runningPanes, message: triggerMessage + '\r' });
    }
  } else {
    log.info('AUTO-SYNC', `No Claude instances to notify about ${triggerFile}`);
  }

  // Also notify renderer for UI update
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('sync-triggered', { file: triggerFile, notified: runningPanes });
  }

  if (runningPanes.length > 0) {
    logTriggerActivity('Auto-sync (PTY)', runningPanes, message, { file: triggerFile, mode: 'pty' });
  }
  return runningPanes;
}

/**
 * Send message to panes with staggered timing to avoid thundering herd
 * Routes through SDK when SDK mode is enabled
 * Priority messages (STOP, URGENT, BLOCKING, ERROR) bypass stagger delay
 * @param {string[]} panes - Target pane IDs
 * @param {string} message - Message to send
 */
function sendStaggered(panes, message, meta = {}) {
  // Priority messages bypass stagger delay entirely
  const isPriority = isPriorityMessage(message);
  if (isPriority) {
    log.info('Stagger', `PRIORITY message detected - bypassing stagger delay`);
  }

  // Route through SDK if enabled
  if (isSDKModeEnabled()) {
    log.info('Stagger', `Sending to ${panes.length} panes via SDK${isPriority ? ' (PRIORITY)' : ''}`);
    panes.forEach((paneId, index) => {
      // Priority messages get no delay, others get staggered
      const delay = isPriority ? 0 : (index * STAGGER_BASE_DELAY_MS + Math.random() * STAGGER_RANDOM_MS);
      setTimeout(() => {
        // Remove trailing \r - SDK doesn't need it
        const cleanMessage = message.endsWith('\r') ? message.slice(0, -1) : message;

        // Display incoming message in pane UI so user can see agent-to-agent messages
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('sdk-message', {
            paneId: paneId,
            message: { type: 'user', content: cleanMessage }
          });
        }

        sdkBridge.sendMessage(paneId, cleanMessage);
      }, delay);
    });
    return;
  }

  // Legacy PTY mode
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const deliveryId = meta && meta.deliveryId ? meta.deliveryId : null;

  // Single pane - no stagger needed
  if (panes.length === 1) {
    const payload = { panes, message };
    if (deliveryId) payload.deliveryId = deliveryId;
    log.info('Stagger', `Sending inject-message to pane ${panes[0]}`);
    diagnosticLog.write('Stagger', `Sending inject-message to pane ${panes[0]}`);
    mainWindow.webContents.send('inject-message', payload);
    return;
  }

  // Multiple panes - stagger to avoid thundering herd (unless priority)
  log.info('Stagger', `Sending to ${panes.length} panes${isPriority ? ' (PRIORITY - no delay)' : ' with staggered timing'}`);
  diagnosticLog.write('Stagger', `Sending to ${panes.length} panes`, { panes, isPriority });
  panes.forEach((paneId, index) => {
    // Priority messages get no delay, others get staggered
    const delay = isPriority ? 0 : (index * STAGGER_BASE_DELAY_MS + Math.random() * STAGGER_RANDOM_MS);
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        const payload = { panes: [paneId], message };
        if (deliveryId) payload.deliveryId = deliveryId;
        mainWindow.webContents.send('inject-message', payload);
      }
    }, delay);
  });
}

/**
 * Handle trigger file changes - sends content to target pane(s)
 * When SDK mode enabled, routes through SDK bridge instead of PTY
 * @param {string} filePath - Full path to the trigger file
 * @param {string} filename - Just the filename (e.g., 'worker-b.txt')
 */
function handleTriggerFile(filePath, filename) {
  let targets = TRIGGER_TARGETS[filename];
  if (!targets) {
    log.info('Trigger', `Unknown trigger file: ${filename}`);
    return { success: false, reason: 'unknown' };
  }
  if (filename === 'lead.txt') {
    log.info('Trigger:DEBUG', `[lead.txt] Detected change at ${filePath}`);
  }

  // WORKFLOW GATE: Check if workers can be triggered
  const gateCheck = checkWorkflowGate(targets);
  if (!gateCheck.allowed) {
    log.warn('Trigger', `BLOCKED by workflow gate: ${gateCheck.reason}`);
    // Notify UI about blocked trigger
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('trigger-blocked', {
        file: filename,
        targets,
        reason: gateCheck.reason
      });
    }
    return { success: false, reason: 'workflow_gate', message: gateCheck.reason };
  }

  // ATOMIC RENAME PATTERN: Prevents race condition on rapid writes
  // 1. Rename file to .processing (atomic, captures current content)
  // 2. Read from .processing file
  // 3. Process the message
  // 4. Delete .processing file
  // New writes create fresh file, separate watcher event, no loss
  const processingPath = filePath + '.processing';
  try {
    fs.renameSync(filePath, processingPath);
    log.info('Trigger', `Renamed ${filename} to .processing for atomic handling`);
  } catch (renameErr) {
    // File may have been already renamed by concurrent handler, or deleted
    if (renameErr.code === 'ENOENT') {
      log.info('Trigger', `File already gone (concurrent handler?): ${filename}`);
      return { success: false, reason: 'already_processing' };
    }
    log.error('Trigger', `Failed to rename ${filename}: ${renameErr.message}`);
    return { success: false, reason: 'rename_error' };
  }

  // Read trigger file content with encoding normalization
  // Windows agents may write UTF-16LE (PowerShell default), UTF-8 with BOM,
  // or OEM codepage (cmd.exe echo). Normalize to clean UTF-8.
  let message;
  try {
    const raw = fs.readFileSync(processingPath);

    // Detect UTF-16LE BOM (FF FE)
    if (raw.length >= 2 && raw[0] === 0xFF && raw[1] === 0xFE) {
      message = raw.slice(2).toString('utf16le').trim();
      log.info('Trigger', `Decoded UTF-16LE BOM file: ${filename}`);
    }
    // Detect UTF-8 BOM (EF BB BF)
    else if (raw.length >= 3 && raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF) {
      message = raw.slice(3).toString('utf-8').trim();
      log.info('Trigger', `Stripped UTF-8 BOM from: ${filename}`);
    }
    // Default: UTF-8
    else {
      message = raw.toString('utf-8').trim();
    }

    // Strip null bytes and other control chars that slip through encoding issues
    message = message.replace(/\0/g, '').replace(/[\x01-\x08\x0B\x0C\x0E-\x1F]/g, '');
  } catch (err) {
    log.info('Trigger', `Could not read ${filename}: ${err.message}`);
    // Clean up .processing file on read error
    try { fs.unlinkSync(processingPath); } catch (e) { /* ignore */ }
    return { success: false, reason: 'read_error' };
  }

  if (!message) {
    log.info('Trigger', `Empty trigger file: ${filename}`);
    // Clean up .processing file for empty files
    try { fs.unlinkSync(processingPath); } catch (e) { /* ignore */ }
    return { success: false, reason: 'empty' };
  }
  if (filename === 'lead.txt') {
    log.info('Trigger:DEBUG', `[lead.txt] Read ${message.length} chars`);
  }

  const preParsed = parseMessageSequence(message);

  dispatchPluginEvent('trigger:received', {
    file: filename,
    targets,
    message,
    sender: preParsed.sender,
    seq: preParsed.seq,
    mode: isSDKModeEnabled() ? 'sdk' : 'pty',
  });

  const beforePayload = applyPluginHookSync('message:beforeSend', {
    type: 'trigger',
    targets,
    message,
    file: filename,
    sender: preParsed.sender,
    seq: preParsed.seq,
    mode: isSDKModeEnabled() ? 'sdk' : 'pty',
  });
  if (beforePayload && beforePayload.cancel) {
    try {
      fs.unlinkSync(processingPath);
    } catch (err) {
      log.info('Trigger', `Could not delete ${filename}.processing: ${err.message}`);
    }
    dispatchPluginEvent('message:afterSend', {
      type: 'trigger',
      targets,
      message,
      file: filename,
      sender: preParsed.sender,
      seq: preParsed.seq,
      mode: isSDKModeEnabled() ? 'sdk' : 'pty',
      success: false,
      reason: 'plugin_cancelled',
    });
    return { success: false, reason: 'plugin_cancelled' };
  }
  if (beforePayload && typeof beforePayload.message === 'string') {
    message = beforePayload.message;
  }
  if (beforePayload && Array.isArray(beforePayload.targets)) {
    targets = beforePayload.targets;
  }

  // MESSAGE SEQUENCING: Parse and check for duplicates
  let parsed = parseMessageSequence(message);
  if ((parsed.seq === null || !parsed.sender) && (preParsed.seq !== null && preParsed.sender)) {
    parsed = preParsed;
  }
  const recipientRole = filename.replace('.txt', '').toLowerCase();
  const hasSequence = parsed.seq !== null && parsed.sender;
  if (filename === 'lead.txt') {
    log.info('Trigger:DEBUG', `[lead.txt] Parsed sender=${parsed.sender || 'n/a'} seq=${parsed.seq ?? 'n/a'}`);
  }

  if (hasSequence) {
    if (!messageState.sequences[recipientRole]) {
      messageState.sequences[recipientRole] = { outbound: 0, lastSeen: {} };
    }
    const lastSeen = messageState.sequences[recipientRole].lastSeen[parsed.sender] || 0;
    const hasSessionBanner = message.includes('# HIVEMIND SESSION:');

    if (parsed.seq === 1 && hasSessionBanner) {
      messageState.sequences[recipientRole].lastSeen[parsed.sender] = 0;
      saveMessageState();
      log.info('Trigger', `Reset lastSeen for sender restart: ${parsed.sender} -> ${recipientRole}`);
    } else if (parsed.seq < lastSeen - 5) {
      // Large sequence regression implies agent restart/compaction; accept and reset baseline.
      messageState.sequences[recipientRole].lastSeen[parsed.sender] = Math.max(parsed.seq - 1, 0);
      saveMessageState();
      log.info('Trigger', `Reset lastSeen for sender regression: ${parsed.sender} -> ${recipientRole} (lastSeen=${lastSeen}, seq=${parsed.seq})`);
    }
    // Check for duplicate
    if (isDuplicateMessage(parsed.sender, parsed.seq, recipientRole)) {
      log.info('Trigger', `SKIPPED duplicate: ${parsed.sender} #${parsed.seq} → ${recipientRole}`);
      recordSkipped(parsed.sender, parsed.seq, recipientRole);
      // Delete the .processing file but don't deliver
      try {
        fs.unlinkSync(processingPath);
      } catch (e) { /* ignore */ }
      return { success: false, reason: 'duplicate', seq: parsed.seq, sender: parsed.sender };
    }

    // NOTE: recordMessageSeen() moved to AFTER delivery (SDK/PTY paths below)
    // This prevents marking messages as "seen" before they're actually sent
    log.info('Trigger', `Accepted: ${parsed.sender} #${parsed.seq} → ${recipientRole}`);
  }

  // SENDER EXCLUSION: For all.txt broadcasts, exclude sender's own pane
  // Prevents echo - agent shouldn't receive their own broadcast
  if (filename === 'all.txt' && parsed.sender) {
    const senderPaneId = ROLE_TO_PANE[parsed.sender];
    if (senderPaneId && targets.includes(senderPaneId)) {
      targets = targets.filter(t => t !== senderPaneId);
      log.info('Trigger', `Excluded sender ${parsed.sender} (pane ${senderPaneId}) from all.txt broadcast`);
    }
  }

  log.info('Trigger', `${filename} → panes ${targets.join(', ')}: ${message.substring(0, 50)}...`);

  // SDK MODE: Route through SDK bridge (no keyboard events needed)
  if (isSDKModeEnabled()) {
    log.info('Trigger SDK', `Using SDK mode for ${targets.length} target(s)`);
    recordSent('sdk', 'trigger', targets);
    let allSuccess = true;

    for (const paneId of targets) {
      // Display incoming message in pane UI so user can see agent-to-agent messages
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('sdk-message', {
          paneId: paneId,
          message: { type: 'user', content: message }
        });
      }
      try {
        const sent = sdkBridge.sendMessage(paneId, message);
        if (sent) {
          recordDelivered('sdk', 'trigger', paneId);
        } else {
          log.warn('Trigger SDK', `Failed to send to pane ${paneId}`);
          recordFailed('sdk', 'trigger', paneId, 'sdk_send_failed');
          allSuccess = false;
        }
      } catch (err) {
        log.error('Triggers', 'SDK send failed', { paneId, error: err.message });
        recordFailed('sdk', 'trigger', paneId, `SDK exception: ${err.message}`);
        allSuccess = false;
      }
    }

    // Delete .processing file after SDK calls (even partial success)
    try {
      fs.unlinkSync(processingPath);
      log.info('Trigger SDK', `Deleted ${filename}.processing after delivery`);
    } catch (err) {
      log.info('Trigger SDK', `Could not delete ${filename}.processing: ${err.message}`);
    }

    // Notify UI about trigger sent
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('trigger-sent-sdk', {
        file: filename,
        targets,
        success: allSuccess
      });
    }

    // Record message as seen AFTER successful SDK delivery
    if (allSuccess && hasSequence) {
      recordMessageSeen(parsed.sender, parsed.seq, recipientRole);
      log.info('Trigger', `Recorded seen after SDK delivery: ${parsed.sender} #${parsed.seq} → ${recipientRole}`);
    } else if (!allSuccess && hasSequence) {
      log.warn('Trigger', `NOT recording seen (SDK delivery failed): ${parsed.sender} #${parsed.seq} → ${recipientRole}`);
    }

    logTriggerActivity('Trigger file (SDK)', targets, message, { file: filename, sender: parsed.sender, mode: 'sdk' });

    if (allSuccess) {
      for (const targetPaneId of targets) {
        recordSelfHealingMessage(targetPaneId, message, {
          source: 'trigger',
          file: filename,
          sender: parsed.sender,
          mode: 'sdk',
        });
      }
    }

    // Log trigger to memory system
    if (memory && allSuccess) {
      for (const targetPaneId of targets) {
        // Find source pane ID from sender role
        const senderRole = parsed.sender || 'unknown';
        const sourcePaneId = Object.entries(TRIGGER_TARGETS)
          .find(([file]) => file.replace('.txt', '').toLowerCase() === senderRole)?.[1]?.[0] || '0';
        memory.logTriggerMessage(sourcePaneId, targetPaneId, message);
      }
    }

    dispatchPluginEvent('message:afterSend', {
      type: 'trigger',
      targets,
      message,
      file: filename,
      sender: parsed.sender,
      seq: parsed.seq,
      mode: 'sdk',
      success: allSuccess,
    });
    return { success: allSuccess, notified: targets, mode: 'sdk' };
  }

  // PTY MODE (legacy): Use staggered send via inject-message IPC
  if (filename === 'lead.txt') {
    log.info('Trigger:DEBUG', `[lead.txt] Targets: ${targets.join(', ')}, SDK mode: ${isSDKModeEnabled()}`);
  }
  const triggerMessage = formatTriggerMessage(message);
  recordSent('pty', 'trigger', targets);
  let deliveryId = null;
  if (hasSequence) {
    deliveryId = createDeliveryId(parsed.sender, parsed.seq, recipientRole);
    startDeliveryTracking(deliveryId, parsed.sender, parsed.seq, recipientRole, targets, 'trigger', 'pty');
  }
  sendStaggered(targets, triggerMessage + '\r', { deliveryId });
  if (filename === 'lead.txt') {
    log.info('Trigger:DEBUG', '[lead.txt] Sent via inject-message (PTY mode)');
  }
  // Sequence is recorded after renderer confirms delivery (trigger-delivery-ack)

  // Delete the .processing file after sending
  try {
    fs.unlinkSync(processingPath);
    log.info('Trigger', `Deleted ${filename}.processing after PTY dispatch`);
  } catch (err) {
    log.info('Trigger', `Could not delete ${filename}.processing: ${err.message}`);
  }

  logTriggerActivity('Trigger file (PTY)', targets, message, { file: filename, sender: parsed.sender, mode: 'pty' });

  for (const targetPaneId of targets) {
    recordSelfHealingMessage(targetPaneId, message, {
      source: 'trigger',
      file: filename,
      sender: parsed.sender,
      mode: 'pty',
    });
  }

  // Log trigger to memory system
  if (memory) {
    for (const targetPaneId of targets) {
      const senderRole = parsed.sender || 'unknown';
      const sourcePaneId = Object.entries(TRIGGER_TARGETS)
        .find(([file]) => file.replace('.txt', '').toLowerCase() === senderRole)?.[1]?.[0] || '0';
      memory.logTriggerMessage(sourcePaneId, targetPaneId, message);
    }
  }

  dispatchPluginEvent('message:afterSend', {
    type: 'trigger',
    targets,
    message,
    file: filename,
    sender: parsed.sender,
    seq: parsed.seq,
    mode: 'pty',
    success: true,
    deliveryId,
  });
  return { success: true, notified: targets, mode: 'pty', deliveryId };
}

/**
 * BROADCAST: Send message to ALL panes with clear broadcast indicator
 * Use this for user broadcasts so agents know it's going to everyone
 * When SDK mode enabled, uses SDK bridge for delivery
 * @param {string} message - Message to broadcast (will be prefixed)
 */
function broadcastToAllAgents(message) {
  let targets = [...PANE_IDS];
  const beforePayload = applyPluginHookSync('message:beforeSend', {
    type: 'broadcast',
    targets,
    message,
    mode: isSDKModeEnabled() ? 'sdk' : 'pty',
  });
  if (beforePayload && beforePayload.cancel) {
    return { success: false, notified: [], mode: isSDKModeEnabled() ? 'sdk' : 'pty' };
  }
  if (beforePayload && typeof beforePayload.message === 'string') {
    message = beforePayload.message;
  }
  if (beforePayload && Array.isArray(beforePayload.targets)) {
    targets = beforePayload.targets;
  }

  const broadcastMessage = `[BROADCAST TO ALL AGENTS] ${message}`;

  // SDK MODE: Broadcast through SDK bridge to all panes
  if (isSDKModeEnabled()) {
    if (targets.length === 0) {
      return { success: false, notified: [], mode: 'sdk' };
    }
    log.info('BROADCAST SDK', `Broadcasting to ${targets.length} pane(s)`);
    recordSent('sdk', 'broadcast', targets);
    if (targets.length === PANE_IDS.length) {
      try {
        sdkBridge.broadcast(broadcastMessage);
        PANE_IDS.forEach(paneId => recordDelivered('sdk', 'broadcast', paneId));
      } catch (err) {
        log.error('Triggers', 'SDK broadcast failed', { error: err.message });
        targets.forEach(paneId => recordFailed('sdk', 'broadcast', paneId, `SDK exception: ${err.message}`));
      }
    } else {
      targets.forEach(paneId => {
        try {
          const sent = sdkBridge.sendMessage(paneId, broadcastMessage);
          if (sent) {
            recordDelivered('sdk', 'broadcast', paneId);
          } else {
            recordFailed('sdk', 'broadcast', paneId, 'sdk_send_failed');
          }
        } catch (err) {
          log.error('Triggers', 'SDK send failed', { paneId, error: err.message });
          recordFailed('sdk', 'broadcast', paneId, `SDK exception: ${err.message}`);
        }
      });
    }

    // Notify renderer
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('broadcast-sent', {
        message,
        notified: targets,
        mode: 'sdk'
      });
    }

    logTriggerActivity('Broadcast (SDK)', targets, broadcastMessage, { mode: 'sdk' });
    dispatchPluginEvent('message:afterSend', {
      type: 'broadcast',
      targets,
      message,
      mode: 'sdk',
      success: true,
    });
    return { success: true, notified: targets, mode: 'sdk' };
  }

  // PTY MODE (legacy): Get list of running agent panes
  const notified = [];
  if (agentRunning) {
    for (const [paneId, status] of agentRunning) {
      if (status === 'running' && targets.includes(paneId)) {
        notified.push(paneId);
      }
    }
  }

  if (notified.length > 0) {
    recordSent('pty', 'broadcast', notified);
    // Use staggered send to avoid thundering herd
    sendStaggered(notified, broadcastMessage + '\r');
    // PTY broadcast without sequence tracking - record as delivered (best effort)
    notified.forEach(paneId => recordDelivered('pty', 'broadcast', paneId));
  }

  log.info('BROADCAST', `Sent to panes ${notified.join(', ')}: ${message.substring(0, 50)}...`);

  // Notify renderer
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('broadcast-sent', { message, notified, mode: 'pty' });
  }

  if (notified.length > 0) {
    logTriggerActivity('Broadcast (PTY)', notified, broadcastMessage, { mode: 'pty' });
  }
  dispatchPluginEvent('message:afterSend', {
    type: 'broadcast',
    targets: notified,
    message,
    mode: 'pty',
    success: notified.length > 0,
  });
  return { success: true, notified, mode: 'pty' };
}

// ============================================================
// SMART ROUTING
// ============================================================

// Role definitions for routing
const AGENT_ROLES = {
  '1': { name: 'Architect', type: 'coordinator', skills: ['planning', 'coordination', 'architecture'] },
  '2': { name: 'Infra', type: 'coordinator', skills: ['routing', 'ci-cd', 'deployment', 'infrastructure'] },
  '3': { name: 'Frontend', type: 'worker', skills: ['ui', 'frontend', 'renderer', 'css'] },
  '4': { name: 'Backend', type: 'worker', skills: ['backend', 'daemon', 'ipc', 'processes'] },
  '5': { name: 'Analyst', type: 'analyst', skills: ['debugging', 'profiling', 'analysis', 'investigation'] },
  '6': { name: 'Reviewer', type: 'reviewer', skills: ['review', 'testing', 'verification'] },
};

/**
 * Smart routing: get best agent for a task based on performance and type
 * @param {string} taskType - Type of task (ui, backend, review, etc.)
 * @param {Object} performance - Performance data from get-performance
 * @returns {{ paneId: string, reason: string }}
 */
function getBestAgent(taskType, performance, message = '') {
  // TODO: Rename watcher.getClaudeRunning() to getAgentRunning() when updating watcher.js
  const runningMap = (watcher && typeof watcher.getClaudeRunning === 'function')
    ? watcher.getClaudeRunning()
    : (agentRunning || new Map());

  const decision = smartRouting.getBestAgent({
    taskType,
    message,
    roles: AGENT_ROLES,
    runningMap: runningMap || new Map(),
    performance,
    workspacePath: WORKSPACE_PATH,
  });

  return decision;
}

/**
 * Smart routing: route a task to the best agent
 * @param {string} taskType - Type of task
 * @param {string} message - Message to send
 * @param {Object} performance - Performance data
 */
function routeTask(taskType, message, performance) {
  const decision = getBestAgent(taskType, performance, message);
  const { paneId, reason, confidence } = decision;

  if (!paneId) {
    log.info('SmartRoute', `No agent available for ${taskType}`);
    return { success: false, reason: 'no_agent_available' };
  }

  const confidencePct = confidence != null ? Math.round(confidence * 100) : null;
  const confidenceNote = confidencePct !== null ? `, ${confidencePct}% confidence` : '';
  log.info('SmartRoute', `Routing ${taskType} task to pane ${paneId} (${reason}${confidenceNote})`);

  const routeMessage = `[ROUTED: ${taskType}] ${message}`;
  if (mainWindow && !mainWindow.isDestroyed()) {
    const triggerMessage = formatTriggerMessage(routeMessage);
    mainWindow.webContents.send('inject-message', {
      panes: [paneId],
      message: triggerMessage + '\r'
    });
    mainWindow.webContents.send('task-routed', {
      taskType,
      paneId,
      reason,
      confidence,
      scores: decision.scores ? decision.scores.slice(0, 3) : null,
      message: message.substring(0, 50)
    });
  }

  logTriggerActivity('Routed task', [paneId], routeMessage, { taskType, reason, confidence });
  recordSelfHealingMessage(paneId, message, { source: 'route', taskType, confidence });
  return { success: true, paneId, reason, confidence };
}

// ============================================================
// AUTO-HANDOFF
// ============================================================

// Handoff chain: who triggers who after completion
const HANDOFF_CHAIN = {
  '1': ['2'],          // Architect → Infra
  '2': ['3', '4', '5'],// Infra → Frontend + Backend + Analyst
  '3': ['6'],          // Frontend → Reviewer
  '4': ['6'],          // Backend → Reviewer
  '5': ['6'],          // Analyst → Reviewer
  '6': ['1'],          // Reviewer → Architect
};

/**
 * Auto-handoff: trigger when agent completes
 * @param {string} completedPaneId - Pane that just completed
 * @param {string} completionMessage - What was completed
 */
function triggerAutoHandoff(completedPaneId, completionMessage) {
  const nextPanes = HANDOFF_CHAIN[completedPaneId];

  if (!nextPanes || nextPanes.length === 0) {
    log.info('AutoHandoff', `No handoff chain for pane ${completedPaneId}`);
    return { success: false, reason: 'no_chain' };
  }

  // Find first running agent in chain
  const runningNext = nextPanes.find(paneId =>
    agentRunning && agentRunning.get(paneId) === 'running'
  );

  if (!runningNext) {
    log.info('AutoHandoff', `No running agents in handoff chain for pane ${completedPaneId}`);
    return { success: false, reason: 'no_running_next' };
  }

  const fromRole = AGENT_ROLES[completedPaneId]?.name || `Pane ${completedPaneId}`;
  const toRole = AGENT_ROLES[runningNext]?.name || `Pane ${runningNext}`;

  const handoffMessage = `[HANDOFF from ${fromRole}] ${completionMessage}`;

  log.info('AutoHandoff', `${fromRole} → ${toRole}: ${completionMessage.substring(0, 50)}...`);

  if (mainWindow && !mainWindow.isDestroyed()) {
    const triggerMessage = formatTriggerMessage(handoffMessage);
    mainWindow.webContents.send('inject-message', {
      panes: [runningNext],
      message: triggerMessage + '\r'
    });
    mainWindow.webContents.send('auto-handoff', {
      from: completedPaneId,
      to: runningNext,
      fromRole,
      toRole,
      message: completionMessage.substring(0, 100)
    });
  }

  logTriggerActivity('Auto-handoff', [runningNext], handoffMessage, { from: fromRole, to: toRole });
  return { success: true, from: completedPaneId, to: runningNext, fromRole, toRole };
}

// ============================================================
// DIRECT MESSAGE (GATE BYPASS)
// ============================================================

/**
 * Send direct message to agent(s) - BYPASSES WORKFLOW GATE
 * Use this for inter-agent chat that should always be delivered
 * When SDK mode enabled, uses SDK bridge for direct delivery
 * @param {string[]} targetPanes - Target pane IDs
 * @param {string} message - Message to send
 * @param {string} fromRole - Sender role name (optional)
 * @returns {{ success: boolean, notified: string[] }}
 */
function sendDirectMessage(targetPanes, message, fromRole = null) {
  if (!message) return { success: false, error: 'No message' };

  let targets = Array.isArray(targetPanes) ? [...targetPanes] : [];
  const beforePayload = applyPluginHookSync('message:beforeSend', {
    type: 'direct',
    targets,
    message,
    fromRole,
    mode: isSDKModeEnabled() ? 'sdk' : 'pty',
  });
  if (beforePayload && beforePayload.cancel) {
    dispatchPluginEvent('message:afterSend', {
      type: 'direct',
      targets,
      message,
      fromRole,
      mode: isSDKModeEnabled() ? 'sdk' : 'pty',
      success: false,
      reason: 'plugin_cancelled',
    });
    return { success: false, notified: [], reason: 'plugin_cancelled', mode: isSDKModeEnabled() ? 'sdk' : 'pty' };
  }
  if (beforePayload && typeof beforePayload.message === 'string') {
    message = beforePayload.message;
  }
  if (beforePayload && typeof beforePayload.fromRole === 'string') {
    fromRole = beforePayload.fromRole;
  }
  if (beforePayload && Array.isArray(beforePayload.targets)) {
    targets = beforePayload.targets;
  }

  if (targets.length === 0) {
    dispatchPluginEvent('message:afterSend', {
      type: 'direct',
      targets,
      message,
      fromRole,
      mode: isSDKModeEnabled() ? 'sdk' : 'pty',
      success: false,
      reason: 'no_targets',
    });
    return { success: false, notified: [], reason: 'no_targets', mode: isSDKModeEnabled() ? 'sdk' : 'pty' };
  }

  const prefix = fromRole ? `[MSG from ${fromRole}]: ` : '';
  const fullMessage = prefix + message;

  // SDK MODE: Direct delivery through SDK bridge (no running check needed)
  if (isSDKModeEnabled()) {
    log.info('DirectMessage SDK', `Sending to panes ${targets.join(', ')}: ${message.substring(0, 50)}...`);
    recordSent('sdk', 'direct', targets);

    let allSuccess = true;
    for (const paneId of targets) {
      // Display incoming message in pane UI so user can see agent-to-agent messages
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('sdk-message', {
          paneId: paneId,
          message: { type: 'user', content: fullMessage }
        });
      }
      try {
        const sent = sdkBridge.sendMessage(paneId, fullMessage);
        if (sent) {
          recordDelivered('sdk', 'direct', paneId);
        } else {
          log.warn('DirectMessage SDK', `Failed to send to pane ${paneId}`);
          recordFailed('sdk', 'direct', paneId, 'sdk_send_failed');
          allSuccess = false;
        }
      } catch (err) {
        log.error('Triggers', 'SDK send failed', { paneId, error: err.message });
        recordFailed('sdk', 'direct', paneId, `SDK exception: ${err.message}`);
        allSuccess = false;
      }
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('direct-message-sent', {
        to: targets,
        from: fromRole,
        message: message.substring(0, 100),
        mode: 'sdk'
      });
    }

    logTriggerActivity('Direct message (SDK)', targets, fullMessage, { from: fromRole, mode: 'sdk' });
    for (const paneId of targets) {
      recordSelfHealingMessage(paneId, fullMessage, { source: 'direct', from: fromRole, mode: 'sdk' });
    }
    dispatchPluginEvent('message:afterSend', {
      type: 'direct',
      targets,
      message,
      fromRole,
      mode: 'sdk',
      success: allSuccess,
    });
    return { success: allSuccess, notified: targets, mode: 'sdk' };
  }

  // PTY MODE (legacy): No workflow gate check - direct messages always allowed
  const notified = [];

  for (const paneId of targets) {
    if (agentRunning && agentRunning.get(paneId) === 'running') {
      notified.push(paneId);
    }
  }

  if (notified.length > 0) {
    log.info('DirectMessage', `Sent to panes ${notified.join(', ')}: ${message.substring(0, 50)}...`);
    recordSent('pty', 'direct', notified);

    if (mainWindow && !mainWindow.isDestroyed()) {
      const triggerMessage = formatTriggerMessage(fullMessage);
      mainWindow.webContents.send('inject-message', {
        panes: notified,
        message: triggerMessage + '\r'
      });
      mainWindow.webContents.send('direct-message-sent', {
        to: notified,
        from: fromRole,
        message: message.substring(0, 100),
        mode: 'pty'
      });
    }
    // Direct messages without sequence tracking - record as delivered (best effort)
    notified.forEach(paneId => recordDelivered('pty', 'direct', paneId));

    logTriggerActivity('Direct message (PTY)', notified, fullMessage, { from: fromRole, mode: 'pty' });
    for (const paneId of notified) {
      recordSelfHealingMessage(paneId, fullMessage, { source: 'direct', from: fromRole, mode: 'pty' });
    }
    dispatchPluginEvent('message:afterSend', {
      type: 'direct',
      targets: notified,
      message,
      fromRole,
      mode: 'pty',
      success: true,
    });
    return { success: true, notified, mode: 'pty' };
  }

  log.info('DirectMessage', `No running Claude in target panes: ${targets.join(', ')}`);
  dispatchPluginEvent('message:afterSend', {
    type: 'direct',
    targets,
    message,
    fromRole,
    mode: 'pty',
    success: false,
    reason: 'no_running_targets',
  });
  return { success: false, notified: [], reason: 'no_running_targets', mode: 'pty' };
}

/**
 * Check if direct messages are allowed (always true)
 * This exists for API consistency with checkWorkflowGate
 */
function checkDirectMessageGate() {
  // Direct messages always bypass workflow gate
  return { allowed: true, reason: 'Direct messages bypass workflow gate' };
}

module.exports = {
  init,
  setWatcher,
  notifyAgents,
  notifyAllAgentsSync,
  handleTriggerFile,
  broadcastToAllAgents,
  checkWorkflowGate,
  // Smart routing
  getBestAgent,
  routeTask,
  triggerAutoHandoff,
  AGENT_ROLES,
  HANDOFF_CHAIN,
  // Direct message
  sendDirectMessage,
  checkDirectMessageGate,
  // SDK Integration
  setSDKBridge,
  setSDKMode,
  isSDKModeEnabled,
  setSelfHealing,
  setPluginManager,
  // Message Sequencing
  parseMessageSequence,
  isDuplicateMessage,
  recordMessageSeen,
  getNextSequence,
  getSequenceState,
  handleDeliveryAck,
  // Reliability Metrics (Task #8)
  getReliabilityStats,
};
