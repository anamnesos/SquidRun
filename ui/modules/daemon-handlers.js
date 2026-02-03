/**
 * Daemon handlers module
 * Handles IPC events from daemon and state changes
 *
 * MESSAGE QUEUE SYSTEM (Two-Queue Architecture):
 * 1. THROTTLE QUEUE (this file): Rate-limits messages (150ms between sends per pane)
 *    - Entry: enqueueForThrottle() called by IPC inject-message handler
 *    - Exit: processThrottleQueue() calls terminal.sendToPane()
 *    - Handles: SDK vs PTY routing, special commands (UNSTICK, AGGRESSIVE_NUDGE)
 *
 * 2. IDLE QUEUE (injection.js): Waits for pane to be idle before injection
 *    - Entry: terminal.sendToPane() calls injection.processIdleQueue()
 *    - Exit: doSendToPane() performs actual PTY write + keyboard Enter
 *    - Handles: Focus management, idle detection, Enter verification
 *
 * SDK integration: When SDK mode is enabled, processThrottleQueue
 * routes messages through SDK instead of terminal PTY.
 */

const { ipcRenderer } = require('electron');
const path = require('path');
const { INSTANCE_DIRS, PANE_IDS } = require('../config');
const log = require('./logger');
const diagnosticLog = require('./diagnostic-log');
const { showToast } = require('./notifications');
const uiView = require('./ui-view');

// SDK renderer for immediate message display
let sdkRenderer = null;
try {
  sdkRenderer = require('./sdk-renderer');
} catch (e) {
  // SDK renderer not available - will be loaded later
}

// Terminal module for health handlers (lazy loaded)
let terminal = null;
function getTerminal() {
  if (!terminal) {
    try {
      terminal = require('./terminal');
    } catch (e) {
      // Terminal not available yet
    }
  }
  return terminal;
}

// THROTTLE QUEUE: Rate-limits message injection to prevent UI glitches
const throttleQueues = new Map(); // paneId -> array of messages
const throttlingPanes = new Set(); // panes currently being processed
const MESSAGE_DELAY = 150; // ms between messages per pane

// SDK integration
let sdkModeEnabled = false;

// Sync indicator state
const syncState = new Map();
let syncIndicatorSetup = false;

// Session timers
const sessionStartTimes = new Map();
let timerInterval = null;

// Callbacks
let onConnectionStatusUpdate = null;
let onPaneStatusUpdate = null;

function setStatusCallbacks(connectionCb, paneCb) {
  onConnectionStatusUpdate = connectionCb;
  onPaneStatusUpdate = paneCb;
}

/**
 * Enable/disable SDK mode for message routing
 * @param {boolean} enabled - Whether SDK mode is active
 */
function setSDKMode(enabled) {
  sdkModeEnabled = enabled;
  log.info('Daemon Handlers', `SDK mode ${enabled ? 'ENABLED' : 'DISABLED'}`);
}

/**
 * Check if SDK mode is active
 * @returns {boolean}
 */
function isSDKModeEnabled() {
  return sdkModeEnabled;
}

function updateConnectionStatus(status) {
  if (onConnectionStatusUpdate) {
    onConnectionStatusUpdate(status);
  }
}

function updatePaneStatus(paneId, status) {
  if (onPaneStatusUpdate) {
    onPaneStatusUpdate(paneId, status);
  }
}

function normalizePath(value) {
  if (!value) return '';
  return path.normalize(String(value)).replace(/\\/g, '/').toLowerCase();
}

// ============================================================
// SYNC STATE MANAGEMENT
// ============================================================

function setSyncState(file, nextState) {
  const current = syncState.get(file) || {};
  const merged = { ...current, ...nextState };
  syncState.set(file, merged);
  uiView.updateSyncChip(file, merged);
}

function handleSyncFileChanged(payload = {}) {
  const file = payload.file;
  if (!uiView.SYNC_FILES[file]) return;
  setSyncState(file, {
    status: 'dirty',
    changedAt: payload.changedAt || Date.now(),
    source: 'watcher'
  });
}

function handleSyncTriggered(payload = {}) {
  const file = payload.file;
  if (!uiView.SYNC_FILES[file]) return;
  const notified = Array.isArray(payload.notified) ? payload.notified : [];
  setSyncState(file, {
    status: notified.length > 0 ? 'synced' : 'skipped',
    syncedAt: Date.now(),
    notified,
    mode: payload.mode || 'pty',
    source: 'auto-sync'
  });
}

function _reg(evt, cb) { ipcRenderer.on(evt, cb); }

function setupSyncIndicator() {
  if (syncIndicatorSetup) return;
  syncIndicatorSetup = true;

  uiView.init();

  _reg('sync-file-changed', (event, payload) => {
    handleSyncFileChanged(payload);
  });

  _reg('sync-triggered', (event, payload) => {
    handleSyncTriggered(payload);
  });
}

function markManualSync(file) {
  if (!uiView.SYNC_FILES[file]) return;
  setSyncState(file, {
    status: 'synced',
    syncedAt: Date.now(),
    notified: ['manual'],
    mode: 'manual',
    source: 'manual'
  });
}

// ============================================================
// DAEMON LISTENERS
// ============================================================

function setupDaemonListeners(initTerminalsFn, reattachTerminalFn, setReconnectedFn, onTerminalsReadyFn) {       
  // Handle initial daemon connection with existing terminals
  ipcRenderer.on('daemon-connected', async (event, data) => {
    const { terminals: existingTerminals, sdkMode } = data;
    log.info('Daemon', 'Connected, existing terminals:', existingTerminals, 'SDK mode:', sdkMode);

    if (sdkMode) {
      setSDKMode(true);
      log.info('Daemon', 'SDK mode enabled - skipping PTY terminal creation');
      updateConnectionStatus('SDK Mode - initializing agents...');
      if (onTerminalsReadyFn) {
        onTerminalsReadyFn(true);
      }
      return;
    }

    if (existingTerminals && existingTerminals.length > 0) {
      updateConnectionStatus('Reconnecting to existing sessions...');
      setReconnectedFn(true);

      const existingPaneIds = new Set();
      for (const term of existingTerminals) {
        if (term.alive) {
          const paneId = String(term.paneId);
          const expectedDir = INSTANCE_DIRS[paneId];
          const cwd = term.cwd;
          const hasMismatch = expectedDir && cwd &&
            normalizePath(expectedDir) !== normalizePath(cwd);

          if (hasMismatch) {
            log.warn('Reattach', `Pane ${paneId} cwd mismatch (expected: ${expectedDir}, got: ${cwd}) - updating session state to correct cwd`);
            term.cwd = expectedDir;
          }

          existingPaneIds.add(paneId);
          await reattachTerminalFn(paneId, term.scrollback);
        }
      }

      const missingPanes = PANE_IDS.filter(id => !existingPaneIds.has(id));
      if (missingPanes.length > 0) {
        log.info('Daemon', 'Creating missing terminals for panes:', missingPanes);
        for (const paneId of missingPanes) {
          const terminal = require('./terminal');
          await terminal.initTerminal(paneId);
        }
      }

      updateConnectionStatus(`Restored ${existingTerminals.length} terminal(s)${missingPanes.length > 0 ? `, created ${missingPanes.length} new` : ''}`);
    } else {
      log.info('Daemon', 'No existing terminals, creating new ones...');
      updateConnectionStatus('Creating terminals...');
      await initTerminalsFn();
      updateConnectionStatus('Ready');
    }

    if (onTerminalsReadyFn) {
      onTerminalsReadyFn(false);
    }
  });

  ipcRenderer.on('daemon-reconnected', (event) => {
    log.info('Daemon', 'Reconnected after disconnect');
    updateConnectionStatus('Daemon reconnected');
  });

  ipcRenderer.on('daemon-disconnected', (event) => {
    log.info('Daemon', 'Disconnected');
    updateConnectionStatus('Daemon disconnected - terminals may be stale');
  });

  ipcRenderer.on('inject-message', (event, data) => {
    const { panes, message, deliveryId } = data || {};
    for (const paneId of panes || []) {
      log.info('Inject', `Received inject-message for pane ${paneId}`);
      diagnosticLog.write('Inject', `Received inject-message for pane ${paneId}`);
      enqueueForThrottle(String(paneId), message, deliveryId);
    }
  });

  ipcRenderer.on('nudge-pane', (event, data) => {
    const { paneId } = data || {};
    const term = getTerminal();
    if (paneId && typeof term?.nudgePane === 'function') {
      log.info('Health', `Nudging pane ${paneId}`);
      term.nudgePane(String(paneId));
    }
  });

  ipcRenderer.on('restart-pane', (event, data) => {
    const { paneId } = data || {};
    const term = getTerminal();
    if (paneId && typeof term?.restartPane === 'function') {
      log.info('Health', `Restarting pane ${paneId}`);
      term.restartPane(String(paneId));
    }
  });

  ipcRenderer.on('restart-all-panes', () => {
    log.info('Health', 'Restarting all panes');
    const term = getTerminal();
    if (typeof term?.freshStartAll === 'function') {
      term.freshStartAll();
    }
  });
}

function setupRollbackListener() {
  ipcRenderer.on('rollback-available', (event, data) => {
    uiView.showRollbackUI(data, async (checkpointId, files) => {
      try {
        const result = await (typeof ipcRenderer.invoke === 'function' ? ipcRenderer.invoke('apply-rollback', checkpointId) : Promise.resolve({success:true, filesRestored:1}));
        if (result && result.success) {
          showToast(`Rolled back ${result.filesRestored} file(s)`, 'info');
          uiView.hideRollbackUI();
        } else {
          showToast(`Rollback failed: ${result?.error || 'Unknown error'}`, 'warning');
        }
      } catch (err) {
        showToast(`Rollback error: ${err.message}`, 'warning');
      }
    });
  });

  ipcRenderer.on('rollback-cleared', () => {
    uiView.hideRollbackUI();
  });
}

function setupHandoffListener() {
  ipcRenderer.on('task-handoff', (event, data) => {
    uiView.showHandoffNotification(data);
  });

  ipcRenderer.on('auto-handoff', (event, data) => {
    uiView.showHandoffNotification({ ...data, reason: data.reason || 'Auto-handoff triggered' });
  });
}

function setupConflictResolutionListener() {
  ipcRenderer.on('file-conflict', (event, data) => {
    uiView.showConflictNotification(data);
  });

  ipcRenderer.on('conflict-resolved', (event, data) => {
    uiView.showConflictNotification({ ...data, status: 'resolved' });
  });
}

function setupAutoTriggerListener() {
  ipcRenderer.on('auto-trigger', (event, data) => {
    uiView.showAutoTriggerFeedback(data);
  });

  ipcRenderer.on('completion-detected', (event, data) => {
    const { paneId, pattern } = data;
    log.info('Completion', `Pane ${paneId} completed: ${pattern}`);
    showToast(`${uiView.PANE_ROLES[paneId] || `Pane ${paneId}`} completed task`, 'info');
  });
}

function setupStateListener() {
  ipcRenderer.on('state-changed', (event, state) => {
    log.info('State', 'Received state change:', state);
    uiView.updateStateDisplay(state);
    updateConnectionStatus(`State: ${uiView.STATE_DISPLAY_NAMES[state.state] || state.state}`);
  });
}

function setupProjectListener() {
  ipcRenderer.on('project-changed', (event, projectPath) => {
    log.info('Project', 'Changed to:', projectPath);
    uiView.updateProjectDisplay(projectPath);
  });
}

function setupCostAlertListener() {
  ipcRenderer.on('cost-alert', (event, data) => {
    uiView.showCostAlert(data);
    showToast(data.message, 'warning');
  });
}

function setupClaudeStateListener(handleTimerStateFn) {
  ipcRenderer.on('claude-state-changed', (event, states) => {
    log.info('Agent State', 'Received:', states);
    for (const [paneId, state] of Object.entries(states)) {
      uiView.updateAgentStatus(paneId, state);
      if (handleTimerStateFn) {
        handleTimerStateFn(paneId, state);
      } else {
        handleSessionTimerState(paneId, state);
      }
    }
  });
}

function setupRefreshButtons(sendToPaneFn) {
  // This still needs direct DOM access as it sets up event listeners on specific buttons
  document.querySelectorAll('.pane-refresh-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const paneId = btn.dataset.paneId;
      sendToPaneFn(paneId, '/read workspace/shared_context.md\r');
      updatePaneStatus(paneId, 'Refreshed');
      setTimeout(() => {
        // This is a small UI update, could be moved to uiView but okay for now
        const statusEl = document.getElementById(`status-${paneId}`);
        if (statusEl && statusEl.textContent === 'Refreshed') {
          statusEl.textContent = 'Ready';
        }
      }, 2000);
    });
  });
}

function setupPaneProjectClicks() {
  for (const paneId of PANE_IDS) {
    const el = document.getElementById(`project-${paneId}`);
    if (el) {
      el.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          const result = await ipcRenderer.invoke('select-pane-project', paneId);
          if (result && result.success) {
            uiView.updatePaneProject(paneId, result.path);
          }
        } catch (err) {
          log.error('MP2', `Error selecting project for pane ${paneId}:`, err);
        }
      });
    }
  }
}

async function loadInitialAgentTasks() {
  try {
    const state = await ipcRenderer.invoke('get-state');
    if (state) {
      uiView.updateAgentTasks(state.agent_claims || {});
    }
  } catch (err) {
    log.error('CB1', 'Error loading initial agent tasks:', err);
  }
}

async function loadPaneProjects() {
  try {
    const result = await ipcRenderer.invoke('get-all-pane-projects');
    if (result && result.success) {
      for (const [paneId, projectPath] of Object.entries(result.paneProjects || {})) {
        uiView.updatePaneProject(paneId, projectPath);
      }
    }
  } catch (err) {
    log.error('MP2', 'Error loading pane projects:', err);
  }
}

// ============================================================
// THROTTLE QUEUE
// ============================================================

function enqueueForThrottle(paneId, message, deliveryId) {
  if (!throttleQueues.has(paneId)) {
    throttleQueues.set(paneId, []);
  }
  throttleQueues.get(paneId).push({
    message,
    deliveryId: deliveryId || null,
  });
  log.info('ThrottleQueue', `Queued for pane ${paneId}, queue length: ${throttleQueues.get(paneId).length}`);    
  diagnosticLog.write('ThrottleQueue', `Queued for pane ${paneId}, queue length: ${throttleQueues.get(paneId).length}`);
  processThrottleQueue(paneId);
}

function processThrottleQueue(paneId) {
  if (throttlingPanes.has(paneId)) return;

  const queue = throttleQueues.get(paneId);
  if (!queue || queue.length === 0) return;

  throttlingPanes.add(paneId);

  const item = queue.shift();
  const message = typeof item === 'string' ? item : item.message;
  const deliveryId = item && typeof item === 'object' ? item.deliveryId : null;

  const terminal = require('./terminal');

  if (message.trim() === '(UNSTICK)') {
    if (sdkModeEnabled) {
      log.info('Daemon SDK', `Interrupting pane ${paneId} via SDK`);
      ipcRenderer.invoke('sdk-interrupt', paneId).catch(err => {
        log.error('Daemon SDK', `Interrupt failed for pane ${paneId}:`, err);
      });
    } else {
      log.info('Daemon', `Sending UNSTICK (ESC) to pane ${paneId}`);
      terminal.sendUnstick(paneId);
    }
    uiView.flashPaneHeader(paneId);
    throttlingPanes.delete(paneId);
    if (queue.length > 0) {
      setTimeout(() => processThrottleQueue(paneId), MESSAGE_DELAY);
    }
    return;
  }

  if (message.trim() === '(AGGRESSIVE_NUDGE)') {
    if (sdkModeEnabled) {
      log.info('Daemon SDK', `Interrupting pane ${paneId} via SDK (aggressive)`);
      ipcRenderer.invoke('sdk-interrupt', paneId).catch(err => {
        log.error('Daemon SDK', `Interrupt (aggressive) failed for pane ${paneId}:`, err);
      });
    } else {
      log.info('Daemon', `Sending AGGRESSIVE_NUDGE (ESC + Enter) to pane ${paneId}`);
      terminal.aggressiveNudge(paneId);
    }
    uiView.flashPaneHeader(paneId);
    throttlingPanes.delete(paneId);
    if (queue.length > 0) {
      setTimeout(() => processThrottleQueue(paneId), MESSAGE_DELAY);
    }
    return;
  }

  if (sdkModeEnabled) {
    const cleanMessage = message.endsWith('\r') ? message.slice(0, -1) : message;
    log.info('Daemon SDK', `Sending to pane ${paneId} via SDK: ${cleanMessage.substring(0, 50)}...`);

    let messageId = null;
    if (sdkRenderer) {
      messageId = sdkRenderer.appendMessage(paneId, { type: 'user', content: cleanMessage }, {
        trackDelivery: true,
        isOutgoing: true
      });
    }

    uiView.flashPaneHeader(paneId);

    ipcRenderer.invoke('sdk-send-message', paneId, cleanMessage).then(() => {
      if (messageId && sdkRenderer) {
        sdkRenderer.updateDeliveryState(messageId, 'delivered');
      }
      if (deliveryId) {
        ipcRenderer.send('trigger-delivery-ack', { deliveryId, paneId });
      }
      uiView.showDeliveryIndicator(paneId, 'delivered');
    }).catch(err => {
      log.error('Daemon SDK', `Send failed for pane ${paneId}:`, err);
      uiView.showDeliveryFailed(paneId, err.message || 'Send failed');
    }).finally(() => {
      throttlingPanes.delete(paneId);
      if (queue.length > 0) {
        setTimeout(() => processThrottleQueue(paneId), MESSAGE_DELAY);
      }
    });
    return;
  }

  uiView.flashPaneHeader(paneId);

  terminal.sendToPane(paneId, message, {
    onComplete: (result) => {
      if (result && result.success === false) {
        log.warn('Daemon', `Trigger delivery failed for pane ${paneId}: ${result.reason || 'unknown'}`);
        uiView.showDeliveryFailed(paneId, result.reason || 'Delivery failed');
      } else {
        uiView.showDeliveryIndicator(paneId, 'delivered');
        if (deliveryId) {
          ipcRenderer.send('trigger-delivery-ack', { deliveryId, paneId });
        }
      }

      throttlingPanes.delete(paneId);
      if (queue.length > 0) {
        setTimeout(() => processThrottleQueue(paneId), MESSAGE_DELAY);
      }
    }
  });
}

// ============================================================
// SESSION TIMERS
// ============================================================

function handleSessionTimerState(paneId, state) {
  const timerEl = document.getElementById('sessionTimer');
  if (timerEl) timerEl.classList.add('active');
  if (state === 'running' && !sessionStartTimes.has(paneId)) {
    sessionStartTimes.set(paneId, Date.now());
    startTimerInterval();
  } else if (state === 'idle' && sessionStartTimes.has(paneId)) {
    sessionStartTimes.delete(paneId);
  }
}

function startTimerInterval() {
  if (!timerInterval) {
    timerInterval = setInterval(() => {
      if (sessionStartTimes.size === 0 && timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
      }
    }, 1000);
  }
}

function getTotalSessionTime() {
  let total = 0;
  const now = Date.now();
  for (const startTime of sessionStartTimes.values()) {
    total += Math.floor((now - startTime) / 1000);
  }
  return total;
}

// ============================================================
// PROJECT PICKER
// ============================================================

async function selectProject() {
  updateConnectionStatus('Selecting project...');
  try {
    const result = await window.hivemind.project.select();
    if (result.success) {
      uiView.updateProjectDisplay(result.path);
      updateConnectionStatus(`Project: ${result.path}`);
    } else if (result.canceled) {
      updateConnectionStatus('Project selection canceled');
    } else {
      updateConnectionStatus('Failed to select project');
    }
  } catch (err) {
    updateConnectionStatus(`Error: ${err.message}`);
  }
}

async function loadInitialProject() {
  try {
    const projectPath = await window.hivemind.project.get();
    if (projectPath) {
      uiView.updateProjectDisplay(projectPath);
    }
  } catch (err) {
    log.error('Daemon', 'Error loading initial project:', err);
  }
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  setStatusCallbacks,
  setupDaemonListeners,
  setupSyncIndicator,
  handleSessionTimerState,
  getTotalSessionTime,
  selectProject,
  loadInitialProject,
  setSDKMode,
  isSDKModeEnabled,
  markManualSync,
  // Individual listeners for renderer.js
  setupRollbackListener,
  setupHandoffListener,
  setupConflictResolutionListener,
  setupAutoTriggerListener,
  setupStateListener,
  setupProjectListener,
  setupCostAlertListener,
  setupClaudeStateListener,
  setupRefreshButtons,
  setupPaneProjectClicks,
  loadInitialAgentTasks,
  loadPaneProjects,
  // Re-export for backward compatibility (fixes tests)
  showConflictNotification: uiView.showConflictNotification,
  showDeliveryIndicator: uiView.showDeliveryIndicator,
  showToast,
  showDeliveryFailed: uiView.showDeliveryFailed,
  updatePaneProject: uiView.updatePaneProject,
  updateAllPaneProjects(projects) {
    if (!projects) return;
    Object.entries(projects).forEach(([id, path]) => uiView.updatePaneProject(id, path));
  },
  updateStateDisplay: uiView.updateStateDisplay,
  updateAgentTasks: uiView.updateAgentTasks,
  showHandoffNotification: uiView.showHandoffNotification,
  showAutoTriggerFeedback: uiView.showAutoTriggerFeedback,
  showRollbackUI: uiView.showRollbackUI,
  hideRollbackUI: uiView.hideRollbackUI,
  updateAgentStatus: uiView.updateAgentStatus,
  flashPaneHeader: uiView.flashPaneHeader,
  PANE_IDS,
  PANE_ROLES: uiView.PANE_ROLES,
  STATE_DISPLAY_NAMES: uiView.STATE_DISPLAY_NAMES,
  _resetForTesting: uiView._resetForTesting,
};


