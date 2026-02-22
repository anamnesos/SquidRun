/**
 * UI View module
 * Handles all DOM manipulation and UI updates for the SquidRun renderer
 * Separated from daemon-handlers.js (Session 60, Finding #5)
 */

const { PANE_ROLES, PANE_IDS } = require('../config');
const notifications = require('./notifications');

// Sync indicator files
const SYNC_FILES = {
  'shared_context.md': { label: 'CTX' },
  'blockers.md': { label: 'BLK' },
  'errors.md': { label: 'ERR' },
};

// Working animation state
let workingAnimationInjected = false;

/**
 * Flash pane header when trigger is received or message delivered
 * @param {string} paneId - Pane ID
 * @param {string} className - CSS class to add for flash animation
 */
function flashPaneHeader(paneId, className = 'trigger-flash') {
  const pane = document.querySelector(`.pane[data-pane-id="${paneId}"]`);
  if (pane && typeof pane.querySelector === 'function') {
    const header = pane.querySelector('.pane-header');
    if (header) {
      header.classList.remove(className);
      // Force reflow to restart animation
      void header.offsetWidth;
      header.classList.add(className);
      // Remove class after animation completes
      setTimeout(() => {
        header.classList.remove(className);
      }, 300);
    }
  }
}

/**
 * Flash pane header on delivery
 * @param {string} paneId - Pane ID
 * @param {string} status - 'delivered' | 'failed' | 'pending'
 */
function showDeliveryIndicator(paneId, status = 'delivered') {
  const headerEl = document.querySelector(`.pane[data-pane-id="${paneId}"] .pane-header`);

  // Flash header on successful delivery
  if (headerEl && status === 'delivered') {
    flashPaneHeader(paneId, 'delivery-flash');
  }
}

/**
 * Show delivery failed with toast notification
 * @param {string} paneId - Pane ID
 * @param {string} reason - Error message
 */
function showDeliveryFailed(paneId, reason) {
  showDeliveryIndicator(paneId, 'failed');
  notifications.showToast(`Delivery to pane ${paneId} failed: ${reason}`, 'error');
}

/**
 * Ensure status bar left group exists
 */
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

/**
 * Ensure sync indicator exists
 */
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

/**
 * Update sync chip state
 * @param {string} file - Filename
 * @param {object} state - Sync state
 */
function updateSyncChip(file, state = {}) {
  const indicator = ensureSyncIndicator();
  if (!indicator) return;

  const chip = indicator.querySelector(`.sync-chip[data-file="${file}"]`);
  if (!chip) return;

  const status = state.status || 'idle';

  chip.classList.remove('dirty', 'synced', 'skipped');
  if (status === 'dirty') chip.classList.add('dirty');
  if (status === 'synced') chip.classList.add('synced');
  if (status === 'skipped') chip.classList.add('skipped');

  const formatTime = (ts) => {
    if (!ts) return '';
    try {
      return new Date(ts).toLocaleTimeString();
    } catch {
      return '';
    }
  };

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

/**
 * Inject working indicator CSS
 */
function injectWorkingAnimation() {
  if (workingAnimationInjected) return;
  const style = document.createElement('style');
  style.textContent = `
    @keyframes pulse-working {
      0%, 100% { opacity: 1; box-shadow: 0 0 5px #00f0ff; }
      50% { opacity: 0.6; box-shadow: 0 0 15px #00f0ff, 0 0 25px #00f0ff; }
    }
    .agent-badge.working {
      background: #00f0ff !important;
      animation: pulse-working 1s ease-in-out infinite;
    }
    .agent-badge.starting {
      background: #f0a000 !important;
      animation: pulse-working 0.5s ease-in-out infinite;
    }
  `;
  document.head.appendChild(style);
  workingAnimationInjected = true;
}

/**
 * Update agent status display in pane header
 * @param {string} paneId - Pane ID
 * @param {string} state - 'idle' | 'starting' | 'running'
 */
function updateAgentStatus(paneId, state) {
  injectWorkingAnimation();

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

/**
 * Show rollback confirmation UI
 * @param {object} data - Rollback details
 * @param {function} onConfirm - Callback on confirm
 * @param {function} onDismiss - Callback on dismiss
 */
function showRollbackUI(data, onConfirm, onDismiss) {
  const { checkpointId, files } = data;

  const existing = document.querySelector('.rollback-indicator');
  if (existing) existing.remove();

  const indicator = document.createElement('div');
  indicator.className = 'rollback-indicator';
  const header = document.createElement('div');
  header.className = 'rollback-header';

  const icon = document.createElement('span');
  icon.className = 'rollback-icon';
  icon.textContent = '⪚';

  const title = document.createElement('span');
  title.className = 'rollback-title';
  title.textContent = 'Rollback Available';

  header.appendChild(icon);
  header.appendChild(title);

  const filesContainer = document.createElement('div');
  filesContainer.className = 'rollback-files';
  const normalizedFiles = Array.isArray(files) ? files : [];
  normalizedFiles.slice(0, 5).forEach((f) => {
    const fileEl = document.createElement('div');
    fileEl.className = 'rollback-file';
    fileEl.textContent = String(f);
    filesContainer.appendChild(fileEl);
  });
  if (normalizedFiles.length > 5) {
    const moreEl = document.createElement('div');
    moreEl.className = 'rollback-file';
    moreEl.textContent = `... and ${normalizedFiles.length - 5} more`;
    filesContainer.appendChild(moreEl);
  }

  const actions = document.createElement('div');
  actions.className = 'rollback-actions';

  const dismissBtn = document.createElement('button');
  dismissBtn.className = 'rollback-btn dismiss';
  dismissBtn.textContent = 'Dismiss';

  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'rollback-btn confirm';
  confirmBtn.textContent = 'Rollback';

  actions.appendChild(dismissBtn);
  actions.appendChild(confirmBtn);

  indicator.appendChild(header);
  indicator.appendChild(filesContainer);
  indicator.appendChild(actions);

  document.body.appendChild(indicator);

  indicator.querySelector('.rollback-btn.dismiss').addEventListener('click', () => {
    indicator.remove();
    if (onDismiss) onDismiss();
  });

  indicator.querySelector('.rollback-btn.confirm').addEventListener('click', () => {
    if (onConfirm) onConfirm(checkpointId, files);
  });
}

/**
 * Hide rollback UI
 */
function hideRollbackUI() {
  const indicator = document.querySelector('.rollback-indicator');
  if (indicator) {
    indicator.remove();
  }
}

/**
 * Show task handoff notification
 * @param {object} data - Handoff details
 */
function showHandoffNotification(data) {
  const { fromPane, toPane, reason } = data;
  const fromRole = PANE_ROLES[fromPane] || `Pane ${fromPane}`;
  const toRole = PANE_ROLES[toPane] || `Pane ${toPane}`;

  const existing = document.querySelector('.handoff-notification');
  if (existing) existing.remove();

  const notification = document.createElement('div');
  notification.className = 'handoff-notification';
  const header = document.createElement('div');
  header.className = 'handoff-header';

  const icon = document.createElement('span');
  icon.className = 'handoff-icon';
  icon.textContent = '🔄';

  const title = document.createElement('span');
  title.className = 'handoff-title';
  title.textContent = 'Task Handoff';

  header.appendChild(icon);
  header.appendChild(title);

  const agents = document.createElement('div');
  agents.className = 'handoff-agents';

  const fromAgent = document.createElement('span');
  fromAgent.className = 'handoff-agent from';
  fromAgent.textContent = fromRole;

  const arrow = document.createElement('span');
  arrow.className = 'handoff-arrow';
  arrow.textContent = '→';

  const toAgent = document.createElement('span');
  toAgent.className = 'handoff-agent to';
  toAgent.textContent = toRole;

  agents.appendChild(fromAgent);
  agents.appendChild(arrow);
  agents.appendChild(toAgent);

  const reasonEl = document.createElement('div');
  reasonEl.className = 'handoff-reason';
  reasonEl.textContent = reason || 'Task completed';

  notification.appendChild(header);
  notification.appendChild(agents);
  notification.appendChild(reasonEl);
  document.body.appendChild(notification);

  setTimeout(() => {
    notification.classList.add('fade-out');
    setTimeout(() => notification.remove(), 400);
  }, 5000);
}

/**
 * Show conflict notification
 * @param {object} data - Conflict details
 */
function showConflictNotification(data) {
  const { file, agents, status, resolution } = data;

  const existing = document.querySelector('.conflict-notification');
  if (existing) existing.remove();

  const agentNames = agents.map(id => PANE_ROLES[id] || `Pane ${id}`);

  const notification = document.createElement('div');
  notification.className = 'conflict-notification';
  const header = document.createElement('div');
  header.className = 'conflict-header';

  const icon = document.createElement('span');
  icon.className = 'conflict-icon';
  icon.textContent = '⚠️';

  const title = document.createElement('span');
  title.className = 'conflict-title';
  title.textContent = 'File Conflict';

  header.appendChild(icon);
  header.appendChild(title);

  const fileEl = document.createElement('div');
  fileEl.className = 'conflict-file';
  fileEl.textContent = file || '';

  const agentsEl = document.createElement('div');
  agentsEl.className = 'conflict-agents';
  agentNames.forEach((name) => {
    const agentEl = document.createElement('span');
    agentEl.className = 'conflict-agent';
    agentEl.textContent = name;
    agentsEl.appendChild(agentEl);
  });

  const normalizedStatus = status === 'resolved' ? 'resolved' : 'pending';
  const statusEl = document.createElement('div');
  statusEl.className = `conflict-status ${normalizedStatus}`;
  statusEl.textContent = resolution || (normalizedStatus === 'resolved'
    ? 'Conflict resolved'
    : 'Waiting for resolution...');

  notification.appendChild(header);
  notification.appendChild(fileEl);
  notification.appendChild(agentsEl);
  notification.appendChild(statusEl);
  document.body.appendChild(notification);

  const timeout = normalizedStatus === 'resolved' ? 5000 : 10000;
  setTimeout(() => {
    notification.classList.add('fade-out');
    setTimeout(() => notification.remove(), 400);
  }, timeout);
}

/**
 * Update per-pane project indicator
 * @param {string} paneId - Pane ID
 * @param {string} projectPath - Path to project
 */
function updatePaneProject(paneId, projectPath) {
  const el = document.getElementById(`project-${paneId}`);
  if (el) {
    if (projectPath) {
      const parts = projectPath.replace(/\\/g, '/').split('/');
      const name = parts[parts.length - 1] || projectPath;
      el.textContent = name;
      el.title = `Project: ${projectPath}\nClick to change`;
      el.classList.add('has-project');
    } else {
      el.textContent = '';
      el.classList.remove('has-project');
    }
  }
}

/**
 * Update agent task display
 * @param {object} claims - Map of paneId -> task description
 */
function updateAgentTasks(claims = {}) {
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

/**
 * Show auto-trigger feedback
 * @param {object} data - Trigger details
 */
function showAutoTriggerFeedback(data) {
  const { fromPane, toPane } = data;
  const fromRole = PANE_ROLES[fromPane] || `Pane ${fromPane}`;
  const toRole = PANE_ROLES[toPane] || `Pane ${toPane}`;

  const targetPane = document.querySelector(`.pane[data-pane-id="${toPane}"]`);
  if (targetPane && typeof targetPane.querySelector === 'function') {
    const header = targetPane.querySelector('.pane-header');
    if (header) {
      header.classList.remove('auto-triggered');
      void header.offsetWidth;
      header.classList.add('auto-triggered');
      setTimeout(() => header.classList.remove('auto-triggered'), 500);
    }
  }

  const indicator = document.createElement('div');
  indicator.className = 'auto-trigger-indicator';
  const icon = document.createElement('span');
  icon.className = 'auto-trigger-icon';
  icon.textContent = '⚡';
  indicator.appendChild(icon);
  indicator.appendChild(document.createTextNode(`${fromRole} → ${toRole}`));
  document.body.appendChild(indicator);

  setTimeout(() => {
    indicator.classList.add('fade-out');
    setTimeout(() => indicator.remove(), 500);
  }, 3000);
}

/**
 * Update main project path display
 * @param {string} projectPath - Path to project
 */
function updateProjectDisplay(projectPath) {
  const projectPathEl = document.getElementById('projectPath');
  if (projectPathEl) {
    if (projectPath) {
      projectPathEl.textContent = projectPath;
      projectPathEl.classList.remove('no-project');
    } else {
      projectPathEl.textContent = 'Developer Mode';
      projectPathEl.classList.add('no-project');
    }
  }
}

/**
 * Update cost alert display
 * @param {object} data - Cost data
 */
function showCostAlert(data) {
  const costEl = document.getElementById('usageEstCost');
  if (costEl) {
    costEl.style.color = '#ff2040';
    costEl.textContent = `$${data.cost}`;
    const parent = costEl.closest('.usage-stat.cost-estimate');
    if (parent) {
      parent.classList.add('alert');
    }
  }

  // Update status bar cost indicator
  updateCostIndicator(data.cost, true);
}

function updateCostIndicator(cost, isAlert) {
  const indicator = document.getElementById('costIndicator');
  if (!indicator) return;
  if (cost == null || cost === 0) {
    indicator.textContent = '';
    return;
  }
  const formatted = typeof cost === 'number' ? cost.toFixed(2) : cost;
  indicator.textContent = `$${formatted}`;
  indicator.style.color = isAlert ? '#ff2040' : '';
}

/**
 * Set up initial UI state
 */
function init() {
  ensureSyncIndicator();
}

module.exports = {
  PANE_IDS,
  PANE_ROLES,
  SYNC_FILES,
  flashPaneHeader,
  showDeliveryIndicator,
  showDeliveryFailed,
  updateSyncChip,
  updateAgentStatus,
  showRollbackUI,
  hideRollbackUI,
  showHandoffNotification,
  showConflictNotification,
  updatePaneProject,
  updateAgentTasks,
  showAutoTriggerFeedback,
  updateProjectDisplay,
  showCostAlert,
  updateCostIndicator,
  init,
  _resetForTesting() { },
};


