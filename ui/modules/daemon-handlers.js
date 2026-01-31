/**
 * Daemon handlers module
 * Handles IPC events from daemon and state changes
 *
 * SDK integration: When SDK mode is enabled, processQueue
 * routes messages through SDK instead of terminal PTY.
 */

const { ipcRenderer } = require('electron');
const path = require('path');
const { INSTANCE_DIRS } = require('../config');
const log = require('./logger');
const diagnosticLog = require('./diagnostic-log');

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

// Pane IDs
const PANE_IDS = ['1', '2', '3', '4', '5', '6'];

// Message queue to prevent trigger flood UI glitch
const messageQueues = new Map(); // paneId -> array of messages
const processingPanes = new Set(); // panes currently being processed
const MESSAGE_DELAY = 150; // ms between messages per pane

// SDK integration
let sdkModeEnabled = false;

// Sync indicator (shared_context/blockers/errors)
const SYNC_FILES = {
  'shared_context.md': { label: 'CTX' },
  'blockers.md': { label: 'BLK' },
  'errors.md': { label: 'ERR' },
};
const syncState = new Map();
let syncIndicatorSetup = false;

// State display helpers
const STATE_DISPLAY_NAMES = {
  'idle': 'IDLE',
  'project_selected': 'PROJECT SELECTED',
  'planning': 'PLANNING',
  'plan_review': 'PLAN REVIEW',
  'plan_revision': 'PLAN REVISION',
  'executing': 'EXECUTING',
  'checkpoint': 'CHECKPOINT',
  'checkpoint_review': 'CHECKPOINT REVIEW',
  'checkpoint_fix': 'CHECKPOINT FIX',
  'friction_logged': 'FRICTION LOGGED',
  'friction_sync': 'FRICTION SYNC',
  'friction_resolution': 'FRICTION RESOLUTION',
  'complete': 'COMPLETE',
  'error': 'ERROR',
  'paused': 'PAUSED',
};

// Pane roles for display
const PANE_ROLES = {
  '1': 'Architect',
  '2': 'Infra',
  '3': 'Frontend',
  '4': 'Backend',
  '5': 'Analyst',
  '6': 'Reviewer'
};

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

// U2: Flash pane header when trigger is received
function flashPaneHeader(paneId) {
  const pane = document.querySelector(`.pane[data-pane-id="${paneId}"]`);
  if (pane) {
    const header = pane.querySelector('.pane-header');
    if (header) {
      header.classList.remove('trigger-flash');
      // Force reflow to restart animation
      void header.offsetWidth;
      header.classList.add('trigger-flash');
      // Remove class after animation completes
      setTimeout(() => {
        header.classList.remove('trigger-flash');
      }, 300);
    }
  }
}

// Message Delivery Visibility (#2) - Show delivery status indicator in pane header
function showDeliveryIndicator(paneId, status = 'delivered') {
  const deliveryEl = document.getElementById(`delivery-${paneId}`);
  const headerEl = document.querySelector(`.pane[data-pane-id="${paneId}"] .pane-header`);

  if (deliveryEl) {
    deliveryEl.textContent = status === 'delivered' ? '✓' : status === 'failed' ? '✗' : '…';
    deliveryEl.className = `delivery-indicator visible ${status}`;

    // Auto-hide after 3 seconds
    setTimeout(() => {
      deliveryEl.classList.remove('visible');
    }, 3000);
  }

  // Flash header on successful delivery
  if (headerEl && status === 'delivered') {
    headerEl.classList.remove('delivery-flash');
    void headerEl.offsetWidth; // Force reflow
    headerEl.classList.add('delivery-flash');
  }
}

// Show delivery failed with toast notification
function showDeliveryFailed(paneId, reason) {
  showDeliveryIndicator(paneId, 'failed');
  showToast(`Delivery to pane ${paneId} failed: ${reason}`, 'error');
}

// ============================================================
// SYNC INDICATOR (#7)
// ============================================================

function ensureStatusLeftGroup() {
  const statusBar = document.querySelector('.status-bar');
  if (!statusBar) return null;

  let leftGroup = statusBar.querySelector('.status-left');
  if (!leftGroup) {
    leftGroup = document.createElement('div');
    leftGroup.className = 'status-left';

    const connectionEl = document.getElementById('connectionStatus');
    const heartbeatEl = document.getElementById('heartbeatIndicator');

    if (connectionEl) leftGroup.appendChild(connectionEl);
    if (heartbeatEl) leftGroup.appendChild(heartbeatEl);

    const firstChild = statusBar.firstElementChild;
    if (firstChild) {
      statusBar.insertBefore(leftGroup, firstChild);
    } else {
      statusBar.appendChild(leftGroup);
    }
  }

  return leftGroup;
}

function ensureSyncIndicator() {
  const leftGroup = ensureStatusLeftGroup();
  if (!leftGroup) return null;

  let indicator = document.getElementById('syncIndicator');
  if (!indicator) {
    indicator = document.createElement('div');
    indicator.id = 'syncIndicator';
    indicator.className = 'sync-indicator';

    const label = document.createElement('span');
    label.className = 'sync-label';
    label.textContent = 'SYNC';
    indicator.appendChild(label);

    Object.entries(SYNC_FILES).forEach(([file, meta]) => {
      const chip = document.createElement('span');
      chip.className = 'sync-chip';
      chip.dataset.file = file;
      chip.textContent = meta.label;
      chip.title = `${file} not synced`;
      indicator.appendChild(chip);
    });

    leftGroup.appendChild(indicator);
  }

  return indicator;
}

function formatTime(ts) {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleTimeString();
  } catch (err) {
    return '';
  }
}

function updateSyncChip(file) {
  const indicator = ensureSyncIndicator();
  if (!indicator) return;

  const chip = indicator.querySelector(`.sync-chip[data-file="${file}"]`);
  if (!chip) return;

  const state = syncState.get(file) || {};
  const status = state.status || 'idle';

  chip.classList.remove('dirty', 'synced', 'skipped');
  if (status === 'dirty') chip.classList.add('dirty');
  if (status === 'synced') chip.classList.add('synced');
  if (status === 'skipped') chip.classList.add('skipped');

  const parts = [file];
  if (state.changedAt) {
    parts.push(`changed ${formatTime(state.changedAt)}`);
  }
  if (state.syncedAt) {
    const notifiedCount = Array.isArray(state.notified) ? state.notified.length : 0;
    const notifiedLabel = notifiedCount > 0 ? `${notifiedCount} panes` : 'no panes';
    parts.push(`synced ${formatTime(state.syncedAt)} (${notifiedLabel})`);
  }
  if (state.mode) {
    parts.push(`mode ${state.mode}`);
  }
  if (state.source) {
    parts.push(`source ${state.source}`);
  }

  chip.title = parts.join(' | ');
}

function setSyncState(file, nextState) {
  const current = syncState.get(file) || {};
  const merged = { ...current, ...nextState };
  syncState.set(file, merged);
  updateSyncChip(file);
}

function handleSyncFileChanged(payload = {}) {
  const file = payload.file;
  if (!SYNC_FILES[file]) return;
  setSyncState(file, {
    status: 'dirty',
    changedAt: payload.changedAt || Date.now(),
    source: 'watcher'
  });
}

function handleSyncTriggered(payload = {}) {
  const file = payload.file;
  if (!SYNC_FILES[file]) return;
  const notified = Array.isArray(payload.notified) ? payload.notified : [];
  setSyncState(file, {
    status: notified.length > 0 ? 'synced' : 'skipped',
    syncedAt: Date.now(),
    notified,
    mode: payload.mode || 'pty',
    source: 'auto-sync'
  });
}

function setupSyncIndicator() {
  if (syncIndicatorSetup) return;
  syncIndicatorSetup = true;

  ensureSyncIndicator();

  ipcRenderer.on('sync-file-changed', (event, payload) => {
    handleSyncFileChanged(payload);
  });

  ipcRenderer.on('sync-triggered', (event, payload) => {
    handleSyncTriggered(payload);
  });
}

function markManualSync(file) {
  if (!SYNC_FILES[file]) return;
  setSyncState(file, {
    status: 'synced',
    syncedAt: Date.now(),
    notified: ['manual'],
    mode: 'manual',
    source: 'manual'
  });
}

// Test helper - reset internal state
function _resetForTesting() {
  syncIndicatorSetup = false;
  syncState.clear();
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
// DAEMON LISTENERS
// ============================================================

function setupDaemonListeners(initTerminalsFn, reattachTerminalFn, setReconnectedFn, onTerminalsReadyFn) {
  // Handle initial daemon connection with existing terminals
  ipcRenderer.on('daemon-connected', async (event, data) => {
    const { terminals: existingTerminals, sdkMode } = data;
    log.info('Daemon', 'Connected, existing terminals:', existingTerminals, 'SDK mode:', sdkMode);

    // SDK Mode Check: Skip PTY terminal creation if SDK mode is enabled
    // sdkMode from event is authoritative (from main process currentSettings)
    if (sdkMode) {
      setSDKMode(true); // Use setter instead of direct assignment
      log.info('Daemon', 'SDK mode enabled - skipping PTY terminal creation');
      updateConnectionStatus('SDK Mode - initializing agents...');
      // Notify ready so SDK init can proceed
      if (onTerminalsReadyFn) {
        onTerminalsReadyFn(true); // Pass true to indicate SDK mode
      }
      return;
    }

    if (existingTerminals && existingTerminals.length > 0) {
      updateConnectionStatus('Reconnecting to existing sessions...');
      setReconnectedFn(true);

      // Track which panes have existing terminals
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
          // U1: Pass scrollback for session restoration
          await reattachTerminalFn(paneId, term.scrollback);
        }
      }

      // Create terminals for any missing panes
      const missingPanes = PANE_IDS.filter(id => !existingPaneIds.has(id));
      if (missingPanes.length > 0) {
        log.info('Daemon', 'Creating missing terminals for panes:', missingPanes);
        for (const paneId of missingPanes) {
          // Use dynamic import to avoid circular dependency
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

    // Notify that terminals are ready (for init sequencing)
    if (onTerminalsReadyFn) {
      onTerminalsReadyFn(false); // Pass false to indicate PTY mode
    }
  });

  // Handle daemon reconnection after disconnect
  ipcRenderer.on('daemon-reconnected', (event) => {
    log.info('Daemon', 'Reconnected after disconnect');
    updateConnectionStatus('Daemon reconnected');
  });

  // Handle daemon disconnect
  ipcRenderer.on('daemon-disconnected', (event) => {
    log.info('Daemon', 'Disconnected');
    updateConnectionStatus('Daemon disconnected - terminals may be stale');
  });

  // Handle message injection from main process (throttled queue)
  ipcRenderer.on('inject-message', (event, data) => {
    const { panes, message, deliveryId } = data || {};
    for (const paneId of panes || []) {
      log.info('Inject', `Received inject-message for pane ${paneId}`);
      diagnosticLog.write('Inject', `Received inject-message for pane ${paneId}`);
      queueMessage(String(paneId), message, deliveryId);
    }
  });

  // Task #29: Health tab - nudge single pane
  ipcRenderer.on('nudge-pane', (event, data) => {
    const { paneId } = data || {};
    const term = getTerminal();
    if (paneId && typeof term?.nudgePane === 'function') {
      log.info('Health', `Nudging pane ${paneId}`);
      term.nudgePane(String(paneId));
    }
  });

  // Task #29: Health tab - restart single pane
  ipcRenderer.on('restart-pane', (event, data) => {
    const { paneId } = data || {};
    const term = getTerminal();
    if (paneId && typeof term?.restartPane === 'function') {
      log.info('Health', `Restarting pane ${paneId}`);
      term.restartPane(String(paneId));
    }
  });

  // Task #29: Health tab - restart all panes
  ipcRenderer.on('restart-all-panes', () => {
    log.info('Health', 'Restarting all panes');
    const term = getTerminal();
    if (typeof term?.freshStartAll === 'function') {
      term.freshStartAll();
    }
  });
}

// Queue a message for throttled delivery
function queueMessage(paneId, message, deliveryId) {
  if (!messageQueues.has(paneId)) {
    messageQueues.set(paneId, []);
  }
  messageQueues.get(paneId).push({
    message,
    deliveryId: deliveryId || null,
  });
  log.info('Queue', `Queued for pane ${paneId}, queue length: ${messageQueues.get(paneId).length}`);
  diagnosticLog.write('Queue', `Queued for pane ${paneId}, queue length: ${messageQueues.get(paneId).length}`);
  processQueue(paneId);
}

// Process message queue for a pane with throttling
// Restore Enter for messages that include it (triggers, broadcasts)
// Routes through SDK when SDK mode is enabled
function processQueue(paneId) {
  // Already processing this pane, let it continue
  if (processingPanes.has(paneId)) return;

  const queue = messageQueues.get(paneId);
  if (!queue || queue.length === 0) return;

  processingPanes.add(paneId);

  const item = queue.shift();
  const message = typeof item === 'string' ? item : item.message;
  const deliveryId = item && typeof item === 'object' ? item.deliveryId : null;

  const terminal = require('./terminal');

  // Special (UNSTICK) command sends ESC keyboard event to unstick agent
  // Note: UNSTICK only works in PTY mode - SDK has its own interrupt mechanism
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
    flashPaneHeader(paneId);
    processingPanes.delete(paneId);
    if (queue.length > 0) {
      setTimeout(() => processQueue(paneId), MESSAGE_DELAY);
    }
    return;
  }

  // Special (AGGRESSIVE_NUDGE) command sends ESC + Enter for forceful unstick
  // Note: In SDK mode, we just interrupt - no need for aggressive nudge
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
    flashPaneHeader(paneId);
    processingPanes.delete(paneId);
    if (queue.length > 0) {
      setTimeout(() => processQueue(paneId), MESSAGE_DELAY);
    }
    return;
  }

  // SDK mode: Route through SDK instead of PTY
  if (sdkModeEnabled) {
    // Remove trailing \r - SDK doesn't need it
    const cleanMessage = message.endsWith('\r') ? message.slice(0, -1) : message;
    log.info('Daemon SDK', `Sending to pane ${paneId} via SDK: ${cleanMessage.substring(0, 50)}...`);

    // UX-7: Optimistic UI - show message immediately with delivery tracking
    // The message appears instantly with "sending" state, then transitions to "sent" → "delivered"
    let messageId = null;
    if (sdkRenderer) {
      messageId = sdkRenderer.appendMessage(paneId, { type: 'user', content: cleanMessage }, {
        trackDelivery: true,
        isOutgoing: true
      });
    }

    // Send to SDK and track delivery confirmation
    ipcRenderer.invoke('sdk-send-message', paneId, cleanMessage).then(() => {
      // UX-7: Message accepted by SDK - mark as delivered
      if (messageId && sdkRenderer) {
        sdkRenderer.updateDeliveryState(messageId, 'delivered');
      }
      if (deliveryId) {
        ipcRenderer.send('trigger-delivery-ack', { deliveryId, paneId });
      }
      // #2: Show delivery indicator in pane header
      showDeliveryIndicator(paneId, 'delivered');
    }).catch(err => {
      log.error('Daemon SDK', `Send failed for pane ${paneId}:`, err);
      // #2: Show delivery failed in pane header
      showDeliveryFailed(paneId, err.message || 'Send failed');
    });

    flashPaneHeader(paneId);
    processingPanes.delete(paneId);
    if (queue.length > 0) {
      setTimeout(() => processQueue(paneId), MESSAGE_DELAY);
    }
    return;
  }

  // PTY MODE (legacy): Normal message handling
  terminal.sendToPane(paneId, message, {
    onComplete: (result) => {
      // #2: Show delivery status in pane header
      if (result && result.success === false) {
        log.warn('Daemon', `Trigger delivery failed for pane ${paneId}: ${result.reason || 'unknown'}`);
        showDeliveryFailed(paneId, result.reason || 'Delivery failed');
        return;
      }
      // Success - show delivery indicator
      showDeliveryIndicator(paneId, 'delivered');
      if (deliveryId) {
        ipcRenderer.send('trigger-delivery-ack', { deliveryId, paneId });
      }
    }
  });

  // Flash pane header (U2)
  flashPaneHeader(paneId);

  // Process next message after delay
  processingPanes.delete(paneId);
  if (queue.length > 0) {
    setTimeout(() => processQueue(paneId), MESSAGE_DELAY);
  }
}

// ============================================================
// RB2: ROLLBACK CONFIRMATION UI
// ============================================================

let pendingRollback = null;

function showRollbackUI(data) {
  const { checkpointId, files, timestamp } = data;
  pendingRollback = data;

  log.info('Rollback', `Available: ${files.length} files from ${timestamp}`);

  // Remove existing rollback UI
  const existing = document.querySelector('.rollback-indicator');
  if (existing) existing.remove();

  const indicator = document.createElement('div');
  indicator.className = 'rollback-indicator';
  indicator.innerHTML = `
    <div class="rollback-header">
      <span class="rollback-icon">⏪</span>
      <span class="rollback-title">Rollback Available</span>
    </div>
    <div class="rollback-files">
      ${files.slice(0, 5).map(f => `<div class="rollback-file">${f}</div>`).join('')}
      ${files.length > 5 ? `<div class="rollback-file">... and ${files.length - 5} more</div>` : ''}
    </div>
    <div class="rollback-actions">
      <button class="rollback-btn dismiss">Dismiss</button>
      <button class="rollback-btn confirm">Rollback</button>
    </div>
  `;

  document.body.appendChild(indicator);

  // Dismiss button
  indicator.querySelector('.rollback-btn.dismiss').addEventListener('click', () => {
    hideRollbackUI();
  });

  // Confirm button
  indicator.querySelector('.rollback-btn.confirm').addEventListener('click', async () => {
    if (!confirm(`Rollback ${files.length} file(s) to checkpoint?\n\nThis will revert:\n${files.slice(0, 5).join('\n')}${files.length > 5 ? '\n...' : ''}`)) {
      return;
    }

    try {
      const result = await ipcRenderer.invoke('apply-rollback', checkpointId);
      if (result && result.success) {
        showToast(`Rolled back ${result.filesRestored} file(s)`, 'info');
        hideRollbackUI();
      } else {
        showToast(`Rollback failed: ${result?.error || 'Unknown error'}`, 'warning');
      }
    } catch (err) {
      showToast(`Rollback error: ${err.message}`, 'warning');
    }
  });
}

function hideRollbackUI() {
  const indicator = document.querySelector('.rollback-indicator');
  if (indicator) {
    indicator.remove();
  }
  pendingRollback = null;
}

function setupRollbackListener() {
  ipcRenderer.on('rollback-available', (event, data) => {
    showRollbackUI(data);
  });

  ipcRenderer.on('rollback-cleared', () => {
    hideRollbackUI();
  });
}

// ============================================================
// AH2: HANDOFF NOTIFICATION UI
// ============================================================

function showHandoffNotification(data) {
  const { fromPane, toPane, reason, taskId } = data;
  const fromRole = PANE_ROLES[fromPane] || `Pane ${fromPane}`;
  const toRole = PANE_ROLES[toPane] || `Pane ${toPane}`;

  log.info('Handoff', `${fromRole} → ${toRole}: ${reason}`);

  // Remove existing notification
  const existing = document.querySelector('.handoff-notification');
  if (existing) existing.remove();

  const notification = document.createElement('div');
  notification.className = 'handoff-notification';
  notification.innerHTML = `
    <div class="handoff-header">
      <span class="handoff-icon">🔄</span>
      <span class="handoff-title">Task Handoff</span>
    </div>
    <div class="handoff-agents">
      <span class="handoff-agent from">${fromRole}</span>
      <span class="handoff-arrow">→</span>
      <span class="handoff-agent to">${toRole}</span>
    </div>
    <div class="handoff-reason">${reason || 'Task completed'}</div>
  `;
  document.body.appendChild(notification);

  // Auto-remove after 5 seconds
  setTimeout(() => {
    notification.classList.add('fade-out');
    setTimeout(() => notification.remove(), 400);
  }, 5000);
}

function setupHandoffListener() {
  ipcRenderer.on('task-handoff', (event, data) => {
    showHandoffNotification(data);
  });

  // Also listen for auto-handoff events
  ipcRenderer.on('auto-handoff', (event, data) => {
    showHandoffNotification({ ...data, reason: data.reason || 'Auto-handoff triggered' });
  });
}

// ============================================================
// CR2: CONFLICT RESOLUTION UI
// ============================================================

let activeConflicts = [];

function showConflictNotification(data) {
  const { file, agents, status, resolution } = data;

  log.info('Conflict', `File: ${file}, Agents: ${agents.join(', ')}, Status: ${status}`);

  // Remove existing notification
  const existing = document.querySelector('.conflict-notification');
  if (existing) existing.remove();

  const agentNames = agents.map(id => PANE_ROLES[id] || `Pane ${id}`);

  const notification = document.createElement('div');
  notification.className = 'conflict-notification';
  notification.innerHTML = `
    <div class="conflict-header">
      <span class="conflict-icon">⚠️</span>
      <span class="conflict-title">File Conflict</span>
    </div>
    <div class="conflict-file">${file}</div>
    <div class="conflict-agents">
      ${agentNames.map(name => `<span class="conflict-agent">${name}</span>`).join('')}
    </div>
    <div class="conflict-status ${status}">${resolution || getConflictStatusText(status)}</div>
  `;
  document.body.appendChild(notification);

  // Auto-remove after 8 seconds for resolved, keep longer for pending
  const timeout = status === 'resolved' ? 5000 : 10000;
  setTimeout(() => {
    notification.classList.add('fade-out');
    setTimeout(() => notification.remove(), 400);
  }, timeout);
}

function getConflictStatusText(status) {
  switch (status) {
    case 'pending': return 'Waiting for resolution...';
    case 'queued': return 'Operations queued';
    case 'resolved': return 'Conflict resolved';
    default: return status;
  }
}

function setupConflictResolutionListener() {
  ipcRenderer.on('file-conflict', (event, data) => {
    activeConflicts.push(data);
    showConflictNotification(data);
  });

  ipcRenderer.on('conflict-resolved', (event, data) => {
    activeConflicts = activeConflicts.filter(c => c.file !== data.file);
    showConflictNotification({ ...data, status: 'resolved' });
  });

  ipcRenderer.on('conflict-queued', (event, data) => {
    showConflictNotification({ ...data, status: 'queued' });
  });
}

// ============================================================
// MP2: PER-PANE PROJECT INDICATOR
// ============================================================

// Store per-pane projects
const paneProjects = new Map();

function getProjectName(projectPath) {
  if (!projectPath) return '';
  const parts = projectPath.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || projectPath;
}

function updatePaneProject(paneId, projectPath) {
  paneProjects.set(paneId, projectPath);
  const el = document.getElementById(`project-${paneId}`);
  if (el) {
    if (projectPath) {
      const name = getProjectName(projectPath);
      el.textContent = name;
      el.title = `Project: ${projectPath}\nClick to change`;
      el.classList.add('has-project');
    } else {
      el.textContent = '';
      el.classList.remove('has-project');
    }
  }
}

function updateAllPaneProjects(paneProjectsData) {
  for (const [paneId, projectPath] of Object.entries(paneProjectsData)) {
    updatePaneProject(paneId, projectPath);
  }
}

async function loadPaneProjects() {
  try {
    const result = await ipcRenderer.invoke('get-all-pane-projects');
    if (result && result.success) {
      updateAllPaneProjects(result.paneProjects || {});
    }
  } catch (err) {
    log.error('MP2', 'Error loading pane projects:', err);
  }
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
            updatePaneProject(paneId, result.path);
          }
        } catch (err) {
          log.error('MP2', `Error selecting project for pane ${paneId}:`, err);
        }
      });
    }
  }
}

// ============================================================
// CB1: STARTUP STATE DISPLAY - Show who's doing what
// ============================================================

function updateAgentTasks(state) {
  // Update task display for each pane based on agent_claims in state
  const claims = state.agent_claims || {};

  for (const paneId of PANE_IDS) {
    const taskEl = document.getElementById(`task-${paneId}`);
    if (taskEl) {
      const task = claims[paneId];
      if (task) {
        taskEl.textContent = task;
        taskEl.classList.add('has-task');
        taskEl.title = `Current task: ${task}`;
      } else {
        taskEl.textContent = '';
        taskEl.classList.remove('has-task');
        taskEl.title = '';
      }
    }
  }
}

// Load initial agent tasks on startup
async function loadInitialAgentTasks() {
  try {
    const state = await ipcRenderer.invoke('get-state');
    if (state) {
      updateAgentTasks(state);
    }
  } catch (err) {
    log.error('CB1', 'Error loading initial agent tasks:', err);
  }
}

// ============================================================
// AT2: AUTO-TRIGGER UI FEEDBACK
// ============================================================

function showAutoTriggerFeedback(data) {
  const { fromPane, toPane, reason } = data;
  const fromRole = PANE_ROLES[fromPane] || `Pane ${fromPane}`;
  const toRole = PANE_ROLES[toPane] || `Pane ${toPane}`;

  log.info('Auto-Trigger', `${fromRole} → ${toRole}: ${reason}`);

  // Flash the target pane header
  const targetPane = document.querySelector(`.pane[data-pane-id="${toPane}"]`);
  if (targetPane) {
    const header = targetPane.querySelector('.pane-header');
    if (header) {
      header.classList.remove('auto-triggered');
      void header.offsetWidth; // Force reflow
      header.classList.add('auto-triggered');
      setTimeout(() => header.classList.remove('auto-triggered'), 500);
    }
  }

  // Show indicator notification
  const indicator = document.createElement('div');
  indicator.className = 'auto-trigger-indicator';
  indicator.innerHTML = `<span class="auto-trigger-icon">⚡</span>${fromRole} → ${toRole}`;
  document.body.appendChild(indicator);

  // Fade out and remove
  setTimeout(() => {
    indicator.classList.add('fade-out');
    setTimeout(() => indicator.remove(), 500);
  }, 3000);
}

function setupAutoTriggerListener() {
  ipcRenderer.on('auto-trigger', (event, data) => {
    showAutoTriggerFeedback(data);
  });

  // Also listen for completion detected events
  ipcRenderer.on('completion-detected', (event, data) => {
    const { paneId, pattern } = data;
    log.info('Completion', `Pane ${paneId} completed: ${pattern}`);
    showToast(`${PANE_ROLES[paneId]} completed task`, 'info');
  });
}

// ============================================================
// STATE DISPLAY
// ============================================================

function updateStateDisplay(state) {
  const stateDisplay = document.getElementById('stateDisplay');
  if (stateDisplay) {
    const stateName = state.state || 'idle';
    stateDisplay.textContent = STATE_DISPLAY_NAMES[stateName] || stateName.toUpperCase();
    stateDisplay.className = 'state-value ' + stateName.replace(/_/g, '_');
  }

  const progressFill = document.getElementById('progressFill');
  const progressText = document.getElementById('progressText');
  if (progressFill && progressText) {
    const current = state.current_checkpoint || 0;
    const total = state.total_checkpoints || 0;
    const percent = total > 0 ? (current / total) * 100 : 0;
    progressFill.style.width = `${percent}%`;
    progressText.textContent = `${current} / ${total}`;
  }

  const activeAgents = state.active_agents || [];
  for (const paneId of PANE_IDS) {
    const badge = document.getElementById(`badge-${paneId}`);
    if (badge) {
      const isActive = activeAgents.includes(paneId);
      badge.classList.toggle('active', isActive);
      badge.classList.toggle('idle', !isActive);
    }
  }

  // CB1: Update agent task display
  updateAgentTasks(state);

  updateConnectionStatus(`State: ${STATE_DISPLAY_NAMES[state.state] || state.state}`);
}

function setupStateListener() {
  ipcRenderer.on('state-changed', (event, state) => {
    log.info('State', 'Received state change:', state);
    updateStateDisplay(state);
  });
}

// ============================================================
// CLAUDE STATE TRACKING
// ============================================================

// CO1: Inject CSS for working indicator animation (once)
let workingAnimationInjected = false;
function injectWorkingAnimation() {
  if (workingAnimationInjected) return;
  const style = document.createElement('style');
  style.textContent = `
    @keyframes pulse-working {
      0%, 100% { opacity: 1; box-shadow: 0 0 5px #4ecca3; }
      50% { opacity: 0.6; box-shadow: 0 0 15px #4ecca3, 0 0 25px #4ecca3; }
    }
    .agent-badge.working {
      background: #4ecca3 !important;
      animation: pulse-working 1s ease-in-out infinite;
    }
    .agent-badge.starting {
      background: #ffc857 !important;
      animation: pulse-working 0.5s ease-in-out infinite;
    }
  `;
  document.head.appendChild(style);
  workingAnimationInjected = true;
}

function updateAgentStatus(paneId, state) {
  // CO1: Ensure animation CSS is injected
  injectWorkingAnimation();

  const statusEl = document.getElementById(`status-${paneId}`);
  if (statusEl) {
    // Check if codex activity indicator is active (has activity-* class)
    const hasActiveActivity = Array.from(statusEl.classList).some(c => c.startsWith('activity-'));
    const spinnerEl = statusEl.querySelector('.pane-spinner');

    // If codex activity is showing, don't override it with generic agent state
    if (hasActiveActivity && spinnerEl) {
      // Only update badge, skip status text/class changes
    } else {
      const labels = {
        'idle': 'Ready',
        'starting': 'Starting...',
        'running': 'Working',
      };
      const statusText = labels[state] || state;
      // Preserve activity spinner if present (Fix 4: prevent clobbering)
      if (spinnerEl) {
        statusEl.innerHTML = '';
        statusEl.appendChild(spinnerEl);
        statusEl.appendChild(document.createTextNode(statusText));
      } else {
        statusEl.textContent = statusText;
      }
      statusEl.classList.remove('idle', 'starting', 'running');
      statusEl.classList.add(state || 'idle');
    }
  }

  // CO1: Update badge with working indicator
  const badge = document.getElementById(`badge-${paneId}`);
  if (badge) {
    badge.classList.remove('idle', 'active', 'working', 'starting');
    if (state === 'running') {
      badge.classList.add('working');
    } else if (state === 'starting') {
      badge.classList.add('starting');
    } else {
      badge.classList.add('idle');
    }
  }
}

function setupClaudeStateListener(handleSessionTimerStateFn) {
  ipcRenderer.on('claude-state-changed', (event, states) => {
    log.info('Agent State', 'Received:', states);
    for (const [paneId, state] of Object.entries(states)) {
      updateAgentStatus(paneId, state);
      if (handleSessionTimerStateFn) {
        handleSessionTimerStateFn(paneId, state);
      }
    }
  });
}

// ============================================================
// COST ALERTS
// ============================================================

function showCostAlert(data) {
  log.info('Cost Alert', data.message);

  const costEl = document.getElementById('usageEstCost');
  if (costEl) {
    costEl.style.color = '#e94560';
    costEl.textContent = `$${data.cost}`;
    const parent = costEl.closest('.usage-stat.cost-estimate');
    if (parent) {
      parent.classList.add('alert');
    }
  }

  showToast(data.message, 'warning');

  const alertBadge = document.getElementById('costAlertBadge');
  if (alertBadge) {
    alertBadge.style.display = 'inline-block';
  }
}

function showToast(message, type = 'info') {
  const existing = document.querySelector('.toast-notification');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = `toast-notification toast-${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('toast-fade');
    setTimeout(() => toast.remove(), 500);
  }, 5000);
}

function setupCostAlertListener() {
  ipcRenderer.on('cost-alert', (event, data) => {
    showCostAlert(data);
  });

  // Add click handler to badge - opens Progress tab when clicked
  const alertBadge = document.getElementById('costAlertBadge');
  if (alertBadge) {
    alertBadge.addEventListener('click', () => {
      // Show right panel if hidden
      const rightPanel = document.getElementById('rightPanel');
      if (rightPanel && !rightPanel.classList.contains('visible')) {
        rightPanel.classList.add('visible');
        const panelBtn = document.getElementById('panelBtn');
        if (panelBtn) panelBtn.classList.add('active');
      }
      // Switch to progress tab
      const progressTab = document.querySelector('[data-tab="progress"]');
      if (progressTab) progressTab.click();
    });
  }
}

// ============================================================
// SESSION TIMERS
// ============================================================

function formatTimer(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function handleSessionTimerState(paneId, state) {
  if (state === 'running' && !sessionStartTimes.has(paneId)) {
    sessionStartTimes.set(paneId, Date.now());
    startTimerInterval();
  } else if (state === 'idle' && sessionStartTimes.has(paneId)) {
    sessionStartTimes.delete(paneId);
  }
  updateTimerDisplay(paneId);
}

function updateTimerDisplay(paneId) {
  const timerEl = document.getElementById(`timer-${paneId}`);
  if (!timerEl) return;

  const startTime = sessionStartTimes.get(paneId);
  if (startTime) {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    timerEl.textContent = formatTimer(elapsed);
    timerEl.classList.add('active');
  } else {
    timerEl.textContent = '0:00';
    timerEl.classList.remove('active');
  }
}

function updateAllTimers() {
  for (const paneId of PANE_IDS) {
    updateTimerDisplay(paneId);
  }

  if (sessionStartTimes.size === 0 && timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

function startTimerInterval() {
  if (!timerInterval) {
    timerInterval = setInterval(updateAllTimers, 1000);
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

function updateProjectDisplay(projectPath) {
  const projectPathEl = document.getElementById('projectPath');
  if (projectPathEl) {
    if (projectPath) {
      projectPathEl.textContent = projectPath;
      projectPathEl.classList.remove('no-project');
    } else {
      projectPathEl.textContent = 'No project selected';
      projectPathEl.classList.add('no-project');
    }
  }
}

async function selectProject() {
  updateConnectionStatus('Selecting project...');
  try {
    const result = await window.hivemind.project.select();
    if (result.success) {
      updateProjectDisplay(result.path);
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
      updateProjectDisplay(projectPath);
    }
  } catch (err) {
    log.error('Daemon', 'Error loading initial project:', err);
  }
}

function setupProjectListener() {
  ipcRenderer.on('project-changed', (event, projectPath) => {
    log.info('Project', 'Changed to:', projectPath);
    updateProjectDisplay(projectPath);
  });
}

// ============================================================
// REFRESH BUTTONS
// ============================================================

function setupRefreshButtons(sendToPaneFn) {
  document.querySelectorAll('.pane-refresh-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const paneId = btn.dataset.paneId;
      sendToPaneFn(paneId, '/read workspace/shared_context.md\n');
      updatePaneStatus(paneId, 'Refreshed');
      setTimeout(() => {
        const statusEl = document.getElementById(`status-${paneId}`);
        if (statusEl && statusEl.textContent === 'Refreshed') {
          statusEl.textContent = 'Ready';
        }
      }, 2000);
    });
  });
}

module.exports = {
  PANE_IDS,
  PANE_ROLES,
  STATE_DISPLAY_NAMES,
  setStatusCallbacks,
  setupDaemonListeners,
  updateStateDisplay,
  setupStateListener,
  setupClaudeStateListener,
  setupCostAlertListener,
  setupRefreshButtons,
  setupProjectListener,
  handleSessionTimerState,
  getTotalSessionTime,
  selectProject,
  loadInitialProject,
  showToast,
  // CB1: Startup state display
  updateAgentTasks,
  loadInitialAgentTasks,
  // AT2: Auto-trigger feedback
  setupAutoTriggerListener,
  showAutoTriggerFeedback,
  // MP2: Per-pane project indicator
  updatePaneProject,
  updateAllPaneProjects,
  loadPaneProjects,
  setupPaneProjectClicks,
  // AH2: Handoff notification
  showHandoffNotification,
  setupHandoffListener,
  // CR2: Conflict resolution
  showConflictNotification,
  setupConflictResolutionListener,
  // RB2: Rollback UI
  showRollbackUI,
  hideRollbackUI,
  setupRollbackListener,
  // SDK integration
  setSDKMode,
  isSDKModeEnabled,
  // #2: Message Delivery Visibility
  showDeliveryIndicator,
  showDeliveryFailed,
  // #7: Sync indicator
  setupSyncIndicator,
  markManualSync,
  // Test helpers
  _resetForTesting,
};
