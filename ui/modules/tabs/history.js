/**
 * Session History Tab Module
 * Handles display of past agent sessions
 */

const { ipcRenderer } = require('electron');
const log = require('../logger');
const { formatDuration } = require('../formatters');
const { PANE_ROLES } = require('../../config');

let sessionHistory = [];

function formatHistoryTime(isoString) {
  const date = new Date(isoString);
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function renderHistoryList() {
  const listEl = document.getElementById('historyList');
  if (!listEl) return;

  if (sessionHistory.length === 0) {
    listEl.innerHTML = '<div class="history-empty">No sessions recorded yet</div>';
    return;
  }

  const sorted = [...sessionHistory].reverse();

  listEl.innerHTML = sorted.map(session => `
    <div class="history-item" data-timestamp="${session.timestamp}">
      <div class="history-item-header">
        <span class="history-item-agent">${PANE_ROLES[session.pane] || `Pane ${session.pane}`}</span>
        <span class="history-item-duration">${session.durationFormatted || formatDuration(session.duration)}</span>
      </div>
      <div class="history-item-time">${formatHistoryTime(session.timestamp)}</div>
    </div>
  `).join('');

  listEl.querySelectorAll('.history-item').forEach(item => {
    item.addEventListener('click', () => {
      const timestamp = item.dataset.timestamp;
      const session = sessionHistory.find(s => s.timestamp === timestamp);
      if (session) {
        const details = [
          `Agent: ${PANE_ROLES[session.pane] || `Pane ${session.pane}`}`,
          `Duration: ${session.durationFormatted || formatDuration(session.duration)}`,
          `Started: ${formatHistoryTime(session.timestamp)}`,
        ];
        if (session.filesModified) {
          details.push(`Files Modified: ${session.filesModified.join(', ')}`);
        }
        if (session.commandsRun) {
          details.push(`Commands: ${session.commandsRun}`);
        }
        alert(`Session Details\n\n${details.join('\n')}`);
      }
    });
  });
}

async function loadSessionHistory() {
  try {
    const stats = await ipcRenderer.invoke('get-usage-stats');
    if (stats && stats.recentSessions) {
      sessionHistory = stats.recentSessions;
      renderHistoryList();
    }
  } catch (err) {
    log.error('History', 'Error loading session history', err);
  }
}

function setupHistoryTab() {
  const refreshBtn = document.getElementById('refreshHistoryBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', loadSessionHistory);
  }
  loadSessionHistory();
}

module.exports = {
  setupHistoryTab,
  loadSessionHistory
};
