/**
 * Processes Tab Module
 * Handles background processes list and management
 */

const { ipcRenderer } = require('electron');
const log = require('../logger');

let processList = [];

function renderProcessList() {
  const listEl = document.getElementById('processList');
  if (!listEl) return;

  if (processList.length === 0) {
    listEl.innerHTML = '<div class="process-empty">No processes running</div>';
    return;
  }

  listEl.innerHTML = processList.map(proc => `
    <div class="process-item" data-process-id="${proc.id}">
      <div class="process-status-dot ${proc.status}"></div>
      <div class="process-info">
        <div class="process-command">${proc.command} ${(proc.args || []).join(' ')}</div>
        <div class="process-details">PID: ${proc.pid || 'N/A'} | Status: ${proc.status}</div>
      </div>
      <button class="process-kill-btn" data-process-id="${proc.id}" ${proc.status !== 'running' ? 'disabled' : ''}>
        Kill
      </button>
    </div>
  `).join('');

  listEl.querySelectorAll('.process-kill-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const processId = btn.dataset.processId;
      try {
        const result = await ipcRenderer.invoke('kill-process', { processId });
        if (result.success) {
          loadProcessList();
        }
      } catch (err) {
        log.error('Processes', 'Error killing process', err);
      }
    });
  });
}

async function loadProcessList() {
  try {
    const result = await ipcRenderer.invoke('list-processes');
    if (result && result.success) {
      processList = result.processes || [];
      renderProcessList();
    }
  } catch (err) {
    log.error('Processes', 'Error loading processes', err);
  }
}

function setupProcessesTab() {
  const refreshBtn = document.getElementById('refreshProcessesBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', loadProcessList);
  }

  // Listen for process events
  ipcRenderer.on('process-started', () => loadProcessList());
  ipcRenderer.on('process-stopped', () => loadProcessList());

  loadProcessList();
}

module.exports = {
  setupProcessesTab,
  loadProcessList,
  renderProcessList
};
