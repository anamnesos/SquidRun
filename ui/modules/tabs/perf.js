/**
 * Performance Tab Module
 * PT2: PERFORMANCE DASHBOARD
 */

const { ipcRenderer } = require('electron');
const log = require('../logger');
const { PANE_IDS } = require('../../config');

let performanceData = {};

function formatAvgTime(ms) {
  if (!ms || ms <= 0) return '--';
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function formatSuccessRate(success, total) {
  if (!total || total === 0) return '--';
  const rate = (success / total) * 100;
  return `${rate.toFixed(0)}%`;
}

function renderPerformanceData() {
  for (const paneId of PANE_IDS) {
    const data = performanceData[paneId] || {};
    const completionsEl = document.getElementById(`perf-completions-${paneId}`);
    const avgtimeEl = document.getElementById(`perf-avgtime-${paneId}`);
    const successEl = document.getElementById(`perf-success-${paneId}`);

    if (completionsEl) completionsEl.textContent = data.completions || 0;
    if (avgtimeEl) avgtimeEl.textContent = formatAvgTime(data.avgResponseTime);
    if (successEl) successEl.textContent = formatSuccessRate(data.successes, data.completions);
  }
}

async function loadPerformanceData() {
  try {
    const result = await ipcRenderer.invoke('get-performance-stats');
    if (result && result.success) {
      performanceData = result.stats || {};
      renderPerformanceData();
    }
  } catch (err) {
    log.error('Perf', 'Error loading performance data', err);
  }
}

function setupPerformanceTab() {
  const refreshBtn = document.getElementById('refreshPerfBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', loadPerformanceData);
  loadPerformanceData();
}

module.exports = {
  setupPerformanceTab,
  loadPerformanceData
};
