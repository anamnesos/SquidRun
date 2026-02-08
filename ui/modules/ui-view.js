/**
 * UI View module
 * Handles all DOM manipulation and UI updates for the Hivemind renderer
 * Separated from daemon-handlers.js (Session 60, Finding #5)
 */

const { PANE_ROLES, PANE_IDS } = require('../config');
const log = require('./logger');
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
    } catch (e) {
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

  const statusEl = document.getElementById(`status-${paneId}`);
  if (statusEl) {
    const hasActiveActivity = Array.from(statusEl.classList).some(c => c.startsWith('activity-'));
    const spinnerEl = statusEl.querySelector('.pane-spinner');

    if (hasActiveActivity && spinnerEl) {
      // Skip status text if activity indicator is active
    } else {
      const labels = {
        'idle': 'Ready',
        'starting': 'Starting...',
        'running': 'Working',
      };
      const statusText = labels[state] || state;
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
  const { checkpointId, files, timestamp } = data;

  const existing = document.querySelector('.rollback-indicator');
  if (existing) existing.remove();

  const indicator = document.createElement('div');
  indicator.className = 'rollback-indicator';
  indicator.innerHTML = `
    <div class="rollback-header">
      <span class="rollback-icon">⪚</span>
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
  notification.innerHTML = `
    <div class="conflict-header">
      <span class="conflict-icon">⚠️</span>
      <span class="conflict-title">File Conflict</span>
    </div>
    <div class="conflict-file">${file}</div>
    <div class="conflict-agents">
      ${agentNames.map(name => `<span class="conflict-agent">${name}</span>`).join('')}
    </div>
    <div class="conflict-status ${status}">${resolution || (status === 'resolved' ? 'Conflict resolved' : 'Waiting for resolution...')}</div>
  `;
  document.body.appendChild(notification);

  const timeout = status === 'resolved' ? 5000 : 10000;
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
        taskEl.innerText = task;
        taskEl.innerText = task;
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
  const { fromPane, toPane, reason } = data;
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
  indicator.innerHTML = `<span class="auto-trigger-icon">⚡</span>${fromRole} → ${toRole}`;
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
      projectPathEl.textContent = 'No project selected';
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


