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
let sdkBridge = null;
let sdkModeEnabled = false;

// Shared constants
const TRIGGER_PREFIX = '\x1b[1;33m[TRIGGER]\x1b[0m ';
const WORKER_PANES = ['2'];
const SYNC_DEBOUNCE_MS = 3000;
const SYNC_COALESCE_WINDOW_MS = 5000;
const STAGGER_BASE_DELAY_MS = 150;
const STAGGER_RANDOM_MS = 100;
const PRIORITY_KEYWORDS = ['STOP', 'URGENT', 'BLOCKING', 'ERROR'];

// Local state
const lastSyncTime = new Map();
let lastGlobalSyncTime = 0;

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
    sendAmbientUpdate,
    isSDKModeEnabled
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

function setSDKBridge(bridge) {
  sdkBridge = bridge;
  log.info('Triggers', 'SDK bridge set');
}

function setSDKMode(enabled) {
  sdkModeEnabled = enabled;
  log.info('Triggers', `SDK mode ${enabled ? 'ENABLED' : 'DISABLED'}`);
}

function isSDKModeEnabled() {
  return sdkModeEnabled && sdkBridge !== null;
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
  // War Room ambient updates only in SDK mode (renders in War Room UI).
  // In PTY mode this injects noisy text blocks into terminals — skip it.
  if (!isSDKModeEnabled()) return;
  paneIds.forEach(paneId => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('sdk-message', { paneId, message: { type: 'system', content: message } });
    }
    try { sdkBridge.sendMessage(paneId, message); } catch (err) { log.error('WarRoom', `SDK ambient update failed: ${err.message}`); }
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

function notifyAgents(agents, message) {
  if (!message) return;
  let targets = Array.isArray(agents) ? [...agents] : [];
  const beforePayload = applyPluginHookSync('message:beforeSend', { type: 'notify', targets, message, mode: isSDKModeEnabled() ? 'sdk' : 'pty' });
  if (beforePayload && beforePayload.cancel) return [];
  if (beforePayload && typeof beforePayload.message === 'string') message = beforePayload.message;
  if (beforePayload && Array.isArray(beforePayload.targets)) targets = beforePayload.targets;

  if (isSDKModeEnabled()) {
    if (targets.length === 0) return [];
    let successCount = 0;
    for (const paneId of targets) {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('sdk-message', { paneId, message: { type: 'user', content: message } });
      try {
        if (sdkBridge.sendMessage(paneId, message)) { successCount++; metrics.recordDelivered('sdk', 'trigger', paneId); }
        else metrics.recordFailed('sdk', 'trigger', paneId, 'SDK send false');
      } catch (err) { metrics.recordFailed('sdk', 'trigger', paneId, err.message); }
    }
    logTriggerActivity('Sent (SDK)', targets, message, { mode: 'sdk', delivered: successCount });
    return targets;
  }

  const notified = [];
  for (const paneId of targets) { if (agentRunning && agentRunning.get(paneId) === 'running') notified.push(paneId); }
  if (notified.length > 0) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('inject-message', { panes: notified, message: formatTriggerMessage(message) + '\r' });
    logTriggerActivity('Sent (PTY)', notified, message, { mode: 'pty' });
  }
  return notified;
}

function notifyAllAgentsSync(triggerFile) {
  const now = Date.now();
  if (now - lastGlobalSyncTime < SYNC_COALESCE_WINDOW_MS) return [];
  lastGlobalSyncTime = now;
  const message = `[HIVEMIND SYNC] ${triggerFile} was updated. [FYI] Context updated. Do not respond.`;

  if (isSDKModeEnabled()) {
    const eligiblePanes = [];
    for (const paneId of PANE_IDS) {
      if (now - (lastSyncTime.get(paneId) || 0) > SYNC_DEBOUNCE_MS) { eligiblePanes.push(paneId); lastSyncTime.set(paneId, now); }
    }
    eligiblePanes.forEach(paneId => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('sdk-message', { paneId, message: { type: 'user', content: message } });
      try { if (!sdkBridge.sendMessage(paneId, message)) metrics.recordFailed('sdk', 'trigger', paneId, 'SDK send false'); }
      catch (err) { metrics.recordFailed('sdk', 'trigger', paneId, err.message); }
    });
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('sync-triggered', { file: triggerFile, notified: eligiblePanes, mode: 'sdk' });
    return eligiblePanes;
  }

  const runningPanes = [];
  if (agentRunning) {
    for (const [paneId, status] of agentRunning) {
      if (status === 'running' && (now - (lastSyncTime.get(paneId) || 0) > SYNC_DEBOUNCE_MS)) { runningPanes.push(paneId); lastSyncTime.set(paneId, now); }
    }
  }
  if (runningPanes.length > 0) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('inject-message', { panes: runningPanes, message: formatTriggerMessage(message) + '\r' });
  }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('sync-triggered', { file: triggerFile, notified: runningPanes });
  return runningPanes;
}

function sendStaggered(panes, message, meta = {}) {
  const isPriority = isPriorityMessage(message);
  if (isSDKModeEnabled()) {
    panes.forEach((paneId, index) => {
      const delay = isPriority ? 0 : (index * STAGGER_BASE_DELAY_MS + Math.random() * STAGGER_RANDOM_MS);
      setTimeout(() => {
        const cleanMsg = message.endsWith('\r') ? message.slice(0, -1) : message;
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('sdk-message', { paneId, message: { type: 'user', content: cleanMsg } });
        sdkBridge.sendMessage(paneId, cleanMsg);
      }, delay);
    });
    return;
  }
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const deliveryId = meta?.deliveryId;
  panes.forEach((paneId, index) => {
    const delay = panes.length === 1 || isPriority ? 0 : (index * STAGGER_BASE_DELAY_MS + Math.random() * STAGGER_RANDOM_MS);
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('inject-message', { panes: [paneId], message, deliveryId });
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

  emitOrganicMessageRoute(parsed.sender, targets);
  warRoom.recordWarRoomMessage({ fromRole: parsed.sender, targets, message: stripRolePrefix(parsed.content || message), type: getTriggerMessageType(filename, targets), source: 'trigger' });

  if (isSDKModeEnabled()) {
    metrics.recordSent('sdk', 'trigger', targets);
    let allSuccess = true;
    for (const paneId of targets) {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('sdk-message', { paneId, message: { type: 'user', content: message } });
      try { if (sdkBridge.sendMessage(paneId, message)) metrics.recordDelivered('sdk', 'trigger', paneId); else { allSuccess = false; metrics.recordFailed('sdk', 'trigger', paneId, 'sdk_fail'); } }
      catch (e) { allSuccess = false; metrics.recordFailed('sdk', 'trigger', paneId, e.message); }
    }
    try { fs.unlinkSync(processingPath); } catch (e) {}
    return { success: allSuccess, notified: targets, mode: 'sdk' };
  }

  metrics.recordSent('pty', 'trigger', targets);
  let deliveryId = null;
  if (parsed.seq !== null && parsed.sender) {
    deliveryId = sequencing.createDeliveryId(parsed.sender, parsed.seq, recipientRole);
    sequencing.startDeliveryTracking(deliveryId, parsed.sender, parsed.seq, recipientRole, targets, 'trigger', 'pty');
  }
  sendStaggered(targets, formatTriggerMessage(message) + '\r', { deliveryId });
  try { fs.unlinkSync(processingPath); } catch (e) {}
  logTriggerActivity('Trigger file (PTY)', targets, message, { file: filename, sender: parsed.sender, mode: 'pty' });
  return { success: true, notified: targets, mode: 'pty', deliveryId };
}

function broadcastToAllAgents(message, fromRole = 'user') {
  let targets = [...PANE_IDS];
  const parsed = sequencing.parseMessageSequence(message);
  if ((!fromRole || fromRole === 'user' || fromRole === 'unknown') && parsed.sender) fromRole = parsed.sender;

  warRoom.recordWarRoomMessage({ fromRole, targets, message, type: 'broadcast', source: 'broadcast' });

  if (isSDKModeEnabled()) {
    metrics.recordSent('sdk', 'broadcast', targets);
    try { sdkBridge.broadcast(`[BROADCAST] ${message}`); targets.forEach(p => metrics.recordDelivered('sdk', 'broadcast', p)); }
    catch (e) { targets.forEach(p => metrics.recordFailed('sdk', 'broadcast', p, e.message)); }
    return { success: true, notified: targets, mode: 'sdk' };
  }

  const notified = [];
  if (agentRunning) { for (const [p, s] of agentRunning) { if (s === 'running' && targets.includes(p)) notified.push(p); } }
  if (notified.length > 0) { metrics.recordSent('pty', 'broadcast', notified); sendStaggered(notified, `[BROADCAST] ${message}\r`); notified.forEach(p => metrics.recordDelivered('pty', 'broadcast', p)); }
  return { success: true, notified, mode: 'pty' };
}

function sendDirectMessage(targetPanes, message, fromRole = null) {
  if (!message) return { success: false, error: 'No message' };
  const parsed = sequencing.parseMessageSequence(message);
  if (!fromRole && parsed.sender) fromRole = parsed.sender;
  let targets = Array.isArray(targetPanes) ? [...targetPanes] : [];

  warRoom.recordWarRoomMessage({ fromRole, targets, message, type: 'direct', source: 'direct' });
  const fullMessage = (fromRole ? `[MSG from ${fromRole}]: ` : '') + message;

  if (isSDKModeEnabled()) {
    metrics.recordSent('sdk', 'direct', targets);
    emitOrganicMessageRoute(fromRole, targets);
    let allSuccess = true;
    for (const paneId of targets) {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('sdk-message', { paneId, message: { type: 'user', content: fullMessage } });
      try { if (sdkBridge.sendMessage(paneId, fullMessage)) metrics.recordDelivered('sdk', 'direct', paneId); else { allSuccess = false; metrics.recordFailed('sdk', 'direct', paneId, 'sdk_fail'); } }
      catch (e) { allSuccess = false; metrics.recordFailed('sdk', 'direct', paneId, e.message); }
    }
    return { success: allSuccess, notified: targets, mode: 'sdk' };
  }

  const notified = [];
  if (agentRunning) { for (const paneId of targets) { if (agentRunning.get(paneId) === 'running') notified.push(paneId); } }
  if (notified.length > 0) { metrics.recordSent('pty', 'direct', notified); sendStaggered(notified, fullMessage + '\r'); notified.forEach(p => metrics.recordDelivered('pty', 'direct', p)); }
  return { success: true, notified, mode: 'pty' };
}

module.exports = {
  init, setSelfHealing, setPluginManager, setSDKBridge, setSDKMode, isSDKModeEnabled, setWatcher,
  notifyAgents, notifyAllAgentsSync, handleTriggerFile, broadcastToAllAgents, sendDirectMessage,
  checkWorkflowGate,
  getReliabilityStats: metrics.getReliabilityStats,
  getSequenceState: sequencing.getSequenceState,
  handleDeliveryAck: sequencing.handleDeliveryAck,
  getNextSequence: sequencing.getNextSequence,
  parseMessageSequence: sequencing.parseMessageSequence,
  recordMessageSeen: sequencing.recordMessageSeen,
  isDuplicateMessage: sequencing.isDuplicateMessage,
  routeTask: routing.routeTask,
  triggerAutoHandoff: routing.triggerAutoHandoff,
  formatAuxEvent: routing.formatAuxEvent,
};