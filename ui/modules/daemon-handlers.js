/**
 * Daemon handlers module
 * Handles IPC events from daemon and state changes
 */

const { ipcRenderer } = require('electron');

// Pane IDs
const PANE_IDS = ['1', '2', '3', '4'];

// BUG2 FIX: Message queue to prevent trigger flood UI glitch
const messageQueues = new Map(); // paneId -> array of messages
const processingPanes = new Set(); // panes currently being processed
const MESSAGE_DELAY = 150; // ms between messages per pane

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
  '1': 'Lead',
  '2': 'Worker A',
  '3': 'Worker B',
  '4': 'Reviewer'
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

// ============================================================
// DAEMON LISTENERS
// ============================================================

function setupDaemonListeners(initTerminalsFn, reattachTerminalFn, setReconnectedFn) {
  // Handle initial daemon connection with existing terminals
  ipcRenderer.on('daemon-connected', async (event, data) => {
    const { terminals: existingTerminals } = data;
    console.log('[Daemon] Connected, existing terminals:', existingTerminals);

    if (existingTerminals && existingTerminals.length > 0) {
      updateConnectionStatus('Reconnecting to existing sessions...');
      setReconnectedFn(true);

      for (const term of existingTerminals) {
        if (term.alive) {
          // U1: Pass scrollback for session restoration
          await reattachTerminalFn(String(term.paneId), term.scrollback);
        }
      }

      updateConnectionStatus(`Restored ${existingTerminals.length} terminal(s)`);
    } else {
      console.log('[Daemon] No existing terminals, creating new ones...');
      updateConnectionStatus('Creating terminals...');
      await initTerminalsFn();
      updateConnectionStatus('Ready');
    }
  });

  // Handle daemon reconnection after disconnect
  ipcRenderer.on('daemon-reconnected', (event) => {
    console.log('[Daemon] Reconnected after disconnect');
    updateConnectionStatus('Daemon reconnected');
  });

  // Handle daemon disconnect
  ipcRenderer.on('daemon-disconnected', (event) => {
    console.log('[Daemon] Disconnected');
    updateConnectionStatus('Daemon disconnected - terminals may be stale');
  });

  // Handle message injection from main process (BUG2 FIX: throttled queue)
  ipcRenderer.on('inject-message', (event, data) => {
    const { panes, message } = data;
    for (const paneId of panes) {
      queueMessage(String(paneId), message);
    }
  });
}

// BUG2 FIX: Queue a message for throttled delivery
function queueMessage(paneId, message) {
  if (!messageQueues.has(paneId)) {
    messageQueues.set(paneId, []);
  }
  messageQueues.get(paneId).push(message);
  processQueue(paneId);
}

// BUG2 FIX: Process message queue for a pane with throttling
function processQueue(paneId) {
  // Already processing this pane, let it continue
  if (processingPanes.has(paneId)) return;

  const queue = messageQueues.get(paneId);
  if (!queue || queue.length === 0) return;

  processingPanes.add(paneId);

  const message = queue.shift();
  const text = message.replace(/\r$/, '');

  window.hivemind.pty.write(paneId, text);
  setTimeout(() => {
    window.hivemind.pty.write(paneId, '\r');
    // Flash pane header (U2)
    flashPaneHeader(paneId);

    // Process next message after delay
    processingPanes.delete(paneId);
    if (queue.length > 0) {
      setTimeout(() => processQueue(paneId), MESSAGE_DELAY);
    }
  }, 50);
}

// ============================================================
// RB2: ROLLBACK CONFIRMATION UI
// ============================================================

let pendingRollback = null;

function showRollbackUI(data) {
  const { checkpointId, files, timestamp } = data;
  pendingRollback = data;

  console.log(`[Rollback] Available: ${files.length} files from ${timestamp}`);

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

  console.log(`[Handoff] ${fromRole} → ${toRole}: ${reason}`);

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

  console.log(`[Conflict] File: ${file}, Agents: ${agents.join(', ')}, Status: ${status}`);

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
    const result = await ipcRenderer.invoke('get-pane-projects');
    if (result && result.success) {
      updateAllPaneProjects(result.projects || {});
    }
  } catch (err) {
    console.error('[MP2] Error loading pane projects:', err);
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
          console.error(`[MP2] Error selecting project for pane ${paneId}:`, err);
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
    console.error('[CB1] Error loading initial agent tasks:', err);
  }
}

// ============================================================
// AT2: AUTO-TRIGGER UI FEEDBACK
// ============================================================

function showAutoTriggerFeedback(data) {
  const { fromPane, toPane, reason } = data;
  const fromRole = PANE_ROLES[fromPane] || `Pane ${fromPane}`;
  const toRole = PANE_ROLES[toPane] || `Pane ${toPane}`;

  console.log(`[Auto-Trigger] ${fromRole} → ${toRole}: ${reason}`);

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
    console.log(`[Completion] Pane ${paneId} completed: ${pattern}`);
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
    console.log('[State] Received state change:', state);
    updateStateDisplay(state);
  });
}

// ============================================================
// CLAUDE STATE TRACKING
// ============================================================

function updateAgentStatus(paneId, state) {
  const statusEl = document.getElementById(`status-${paneId}`);
  if (statusEl) {
    const labels = {
      'idle': 'Idle',
      'starting': 'Starting Claude...',
      'running': 'Claude running',
    };
    statusEl.textContent = labels[state] || state;
    statusEl.classList.remove('idle', 'starting', 'running');
    statusEl.classList.add(state || 'idle');
  }
}

function setupClaudeStateListener(handleSessionTimerStateFn) {
  ipcRenderer.on('claude-state-changed', (event, states) => {
    console.log('[Claude State] Received:', states);
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
  console.log('[Cost Alert]', data.message);

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
    console.error('Error loading initial project:', err);
  }
}

function setupProjectListener() {
  ipcRenderer.on('project-changed', (event, projectPath) => {
    console.log('[Project] Changed to:', projectPath);
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
};
