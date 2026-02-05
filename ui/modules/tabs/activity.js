/**
 * Activity Log Tab Module
 * Handles rendering and managing the activity log
 */

const { ipcRenderer } = require('electron');
const log = require('../logger');
const { PANE_ROLES } = require('../../config');

let activityLog = [];
let activityFilter = 'all';
let activitySearchText = '';
const MAX_ACTIVITY_ENTRIES = 500;

// Extend PANE_ROLES with system entry for activity log
const ACTIVITY_AGENT_NAMES = { ...PANE_ROLES, 'system': 'System' };

function formatActivityTime(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function addActivityEntry(entry) {
  const entryWithMeta = {
    id: Date.now(),
    timestamp: new Date().toISOString(),
    ...entry
  };
  
  activityLog.push(entryWithMeta);

  // Trim to max entries
  if (activityLog.length > MAX_ACTIVITY_ENTRIES) {
    activityLog = activityLog.slice(-MAX_ACTIVITY_ENTRIES);
  }

  // Optimized: If no filters active and tab is visible, just append
  const logEl = document.getElementById('activityLog');
  const isFiltered = activityFilter !== 'all' || activitySearchText !== '';
  
  if (logEl && !isFiltered) {
    // Only append if it's the latest and we aren't at max entries yet
    // Actually, simple is better for now: only re-render if needed, otherwise append
    const entryHtml = renderEntry(entryWithMeta);
    const div = document.createElement('div');
    div.innerHTML = entryHtml;
    logEl.appendChild(div.firstElementChild);
    
    // Auto-scroll to bottom
    logEl.scrollTop = logEl.scrollHeight;
    
    // If we exceeded max, remove the first one
    if (logEl.children.length > MAX_ACTIVITY_ENTRIES) {
      logEl.removeChild(logEl.firstChild);
    }
  } else {
    renderActivityLog();
  }
}

function renderEntry(entry) {
  return `
    <div class="activity-entry" data-type="${entry.type}">
      <span class="activity-time">${formatActivityTime(entry.timestamp)}</span>
      <span class="activity-agent" data-agent="${entry.agent}">${ACTIVITY_AGENT_NAMES[entry.agent] || entry.agent}</span>
      <span class="activity-type ${entry.type}">${entry.type}</span>
      <span class="activity-message">${entry.message}</span>
    </div>
  `;
}

function renderActivityLog() {
  const logEl = document.getElementById('activityLog');
  if (!logEl) return;

  // Apply filters
  let filtered = activityLog;

  if (activityFilter !== 'all') {
    filtered = filtered.filter(e => e.type === activityFilter);
  }

  if (activitySearchText) {
    const search = activitySearchText.toLowerCase();
    filtered = filtered.filter(e =>
      (e.message && e.message.toLowerCase().includes(search)) ||
      (e.agent && ACTIVITY_AGENT_NAMES[e.agent]?.toLowerCase().includes(search))
    );
  }

  if (filtered.length === 0) {
    logEl.innerHTML = '<div class="activity-empty">No matching activity</div>';
    return;
  }

  logEl.innerHTML = filtered.map(entry => renderEntry(entry)).join('');

  // Auto-scroll to bottom
  logEl.scrollTop = logEl.scrollHeight;
}

async function loadActivityLog() {
  try {
    const result = await ipcRenderer.invoke('get-activity-log');
    if (result && result.success) {
      activityLog = result.entries || [];
      renderActivityLog();
    }
  } catch (err) {
    log.error('ActivityLog', 'Error loading activity log', err);
  }
}

function clearActivityLog() {
  if (!confirm('Clear all activity entries?')) return;
  activityLog = [];
  renderActivityLog();
  ipcRenderer.invoke('clear-activity-log').catch(() => {});
}

function exportActivityLog() {
  const content = activityLog.map(e =>
    `[${e.timestamp}] [${ACTIVITY_AGENT_NAMES[e.agent] || e.agent}] [${e.type}] ${e.message}`
  ).join('\n');

  const blob = new Blob([content], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `activity-log-${new Date().toISOString().split('T')[0]}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

function setupActivityTab() {
  // Filter buttons
  document.querySelectorAll('.activity-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.activity-filter').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activityFilter = btn.dataset.filter;
      renderActivityLog();
    });
  });

  // Search box
  const searchInput = document.getElementById('activitySearch');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      activitySearchText = searchInput.value;
      renderActivityLog();
    });
  }

  // Action buttons
  const clearBtn = document.getElementById('clearActivityBtn');
  if (clearBtn) clearBtn.addEventListener('click', clearActivityLog);

  const exportBtn = document.getElementById('exportActivityBtn');
  if (exportBtn) exportBtn.addEventListener('click', exportActivityLog);

  // Listen for activity events
  ipcRenderer.on('activity-entry', (event, entry) => {
    addActivityEntry(entry);
  });

  loadActivityLog();
}

module.exports = {
  setupActivityTab,
  addActivityEntry,
  renderActivityLog
};
