/**
 * Health Tab Module
 * Task #29: Self-Healing Error Recovery UI
 */

const { ipcRenderer } = require('electron');
const log = require('../logger');
const { PANE_IDS, PANE_ROLES } = require('../../config');

const healthState = {
  agents: new Map(),
  refreshInterval: null
};

function initHealthState() {
  for (const paneId of PANE_IDS) {
    healthState.agents.set(String(paneId), { status: 'unknown', lastOutput: null, stuckCount: 0, recoveryStep: 'none' });
  }
}

async function refreshHealthData() {
  try {
    const result = await ipcRenderer.invoke('get-agent-health');
    if (result?.success && result.agents) {
      Object.entries(result.agents).forEach(([paneId, data]) => {
        healthState.agents.set(paneId, data);
        renderAgentHealthItem(paneId);
      });
    }
  } catch (err) { log.error('Health', 'Refresh failed', err); }
}

function renderAgentHealthItem(paneId) {
  const data = healthState.agents.get(paneId);
  const statusEl = document.getElementById(`health-status-${paneId}`);
  if (statusEl) statusEl.textContent = data.status || 'unknown';
}

function setupHealthTab() {
  initHealthState();
  const refreshBtn = document.getElementById('healthRefreshBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', refreshHealthData);
  
  healthState.refreshInterval = setInterval(() => {
    const healthTab = document.getElementById('tab-health');
    if (healthTab?.classList.contains('active')) refreshHealthData();
  }, 5000);

  refreshHealthData();
}

module.exports = {
  setupHealthTab,
  refreshHealthData
};
