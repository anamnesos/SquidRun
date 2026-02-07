/**
 * Build Progress Tab Module
 * Handles workflow state and usage statistics
 */

const { ipcRenderer } = require('electron');
const log = require('../logger');
const { PANE_ROLES } = require('../../config');

function updateBuildProgress(state) {
  const stateEl = document.getElementById('progressState');
  if (stateEl) {
    const stateName = state.state || 'idle';
    stateEl.textContent = stateName.toUpperCase().replace(/_/g, ' ');
    stateEl.className = 'progress-state-badge ' + stateName.replace(/_/g, '_');
  }

  const checkpointFill = document.getElementById('checkpointFill');
  const checkpointText = document.getElementById('checkpointText');
  if (checkpointFill && checkpointText) {
    const current = state.current_checkpoint || 0;
    const total = state.total_checkpoints || 0;
    const percent = total > 0 ? (current / total) * 100 : 0;
    checkpointFill.style.width = `${percent}%`;
    checkpointText.textContent = `${current} / ${total}`;
  }

  const agentsEl = document.getElementById('activeAgentsList');
  if (agentsEl) {
    const agents = state.active_agents || [];
    if (agents.length === 0) {
      agentsEl.innerHTML = '<span class="no-agents">No agents active</span>';
    } else {
      agentsEl.innerHTML = agents.map(id =>
        `<span class="active-agent-badge">${PANE_ROLES[id] || `Agent ${id}`}</span>`
      ).join('');
    }
  }

  const frictionEl = document.getElementById('frictionCountDisplay');
  if (frictionEl) {
    frictionEl.textContent = state.friction_count || 0;
  }

  const errorSection = document.getElementById('errorSection');
  const errorDisplay = document.getElementById('errorDisplay');
  if (errorSection && errorDisplay) {
    if (state.error) {
      errorSection.style.display = 'block';
      errorDisplay.textContent = state.error;
    } else if (state.errors && state.errors.length > 0) {
      const lastError = state.errors[state.errors.length - 1];
      errorSection.style.display = 'block';
      errorDisplay.textContent = `${lastError.agent}: ${lastError.message}`;
    } else {
      errorSection.style.display = 'none';
    }
  }
}

async function updateUsageStats() {
  try {
    const stats = await ipcRenderer.invoke('get-usage-stats');
    if (stats) {
      const totalSpawnsEl = document.getElementById('usageTotalSpawns');
      const sessionsTodayEl = document.getElementById('usageSessionsToday');
      const totalTimeEl = document.getElementById('usageTotalTime');
      const estCostEl = document.getElementById('usageEstCost');

      if (totalSpawnsEl) totalSpawnsEl.textContent = stats.totalSpawns || 0;
      if (sessionsTodayEl) sessionsTodayEl.textContent = stats.sessionsToday || 0;
      if (totalTimeEl) totalTimeEl.textContent = stats.totalSessionTime || '0s';
      if (estCostEl) estCostEl.textContent = `$${stats.estimatedCost || '0.00'}`;
    }
  } catch (err) {
    log.error('Build', 'Error loading usage stats', err);
  }
}

async function refreshBuildProgress() {
  try {
    const state = await ipcRenderer.invoke('get-state');
    if (state) {
      updateBuildProgress(state);
    }
    await updateUsageStats();
  } catch (err) {
    log.error('Build', 'Error loading state', err);
  }
}

function displayConflicts(conflicts) {
  const errorSection = document.getElementById('errorSection');
  const errorDisplay = document.getElementById('errorDisplay');
  if (conflicts.length > 0 && errorSection && errorDisplay) {
    errorSection.style.display = 'block';
    errorDisplay.textContent = `Warning: File Conflict: ${conflicts.map(c => c.file).join(', ')}`;
    errorDisplay.style.color = '#f0a000';
  }
}

function setupBuildProgressTab() {
  const refreshBtn = document.getElementById('refreshProgressBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', refreshBuildProgress);
  
  ipcRenderer.on('file-conflicts-detected', (event, conflicts) => {
    displayConflicts(conflicts);
  });

  refreshBuildProgress();
}

module.exports = {
  setupBuildProgressTab,
  updateBuildProgress,
  refreshBuildProgress
};
