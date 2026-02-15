/**
 * Activity Feed Tab Module
 * Chat-style feed for agent activity, messages, and events
 */

const { ipcRenderer } = require('electron');
const log = require('../logger');
const { PANE_ROLES } = require('../../config');
const { registerScopedIpcListener } = require('../renderer-ipc-registry');

let activityLog = [];
let activityFilter = 'all';
let activitySearchText = '';
let searchDebounceTimer = null;
const MAX_ACTIVITY_ENTRIES = 500;
const SEARCH_DEBOUNCE_MS = 100;

// Noise types to filter out
const NOISE_TYPES = new Set(['text_delta', 'content_block_delta']);

// Extend PANE_ROLES with system entry for activity log
const ACTIVITY_AGENT_NAMES = { ...PANE_ROLES, 'system': 'System' };

function formatActivityTime(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function addActivityEntry(entry) {
  // Filter out noise events
  if (entry && NOISE_TYPES.has(entry.type)) return;

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

  // Optimized: If no filters active, just append the DOM node
  const logEl = document.getElementById('activityLog');
  const isFiltered = activityFilter !== 'all' || activitySearchText !== '';

  if (logEl && !isFiltered) {
    // Remove empty placeholder if present
    const empty = logEl.querySelector('.activity-empty');
    if (empty) empty.remove();

    const node = createEntryNode(entryWithMeta);
    logEl.appendChild(node);

    // Auto-scroll to bottom
    logEl.scrollTop = logEl.scrollHeight;

    // Cap DOM children
    if (logEl.children.length > MAX_ACTIVITY_ENTRIES) {
      logEl.removeChild(logEl.firstChild);
    }
  } else {
    renderActivityLog();
  }

  // Check for awaiting human state
  if (entry.type === 'state' && entry.message && entry.message.includes('awaiting_human')) {
    showAwaitingHuman(true);
  } else if (entry.type === 'state' && entry.message && entry.message.includes('active')) {
    showAwaitingHuman(false);
  }
}

function showAwaitingHuman(visible) {
  const banner = document.getElementById('awaitingHumanBanner');
  if (banner) {
    banner.classList.toggle('hidden', !visible);
  }
}

function createEntryNode(entry) {
  const div = document.createElement('div');
  div.className = 'activity-entry';
  div.dataset.type = entry.type || '';

  const isMessage = entry.type === 'message';

  if (isMessage) {
    // Chat-style message rendering
    div.classList.add('activity-message-entry');
    const agentId = escapeHtml(entry.agent || '');
    div.innerHTML = `
      <div class="activity-chat-header">
        <span class="activity-agent" data-agent="${agentId}">${escapeHtml(ACTIVITY_AGENT_NAMES[entry.agent] || entry.agent || 'Unknown')}</span>
        <span class="activity-time">${formatActivityTime(entry.timestamp)}</span>
      </div>
      <div class="activity-chat-body">${escapeHtml(entry.message || '')}</div>
    `;
  } else {
    // Standard log-line rendering
    const agentId = escapeHtml(entry.agent || '');
    div.innerHTML = `
      <span class="activity-time">${formatActivityTime(entry.timestamp)}</span>
      <span class="activity-agent" data-agent="${agentId}">${escapeHtml(ACTIVITY_AGENT_NAMES[entry.agent] || entry.agent || '')}</span>
      <span class="activity-type ${escapeHtml(entry.type || '')}">${escapeHtml(entry.type || '')}</span>
      <span class="activity-msg">${escapeHtml(entry.message || '')}</span>
    `;
  }

  return div;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
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

  // Build with document fragment for performance
  const frag = document.createDocumentFragment();
  for (const entry of filtered) {
    frag.appendChild(createEntryNode(entry));
  }
  logEl.innerHTML = '';
  logEl.appendChild(frag);

  // Auto-scroll to bottom
  logEl.scrollTop = logEl.scrollHeight;
}

async function loadActivityLog() {
  try {
    const result = await ipcRenderer.invoke('get-activity-log');
    if (result && result.success) {
      activityLog = (result.entries || []).filter(e => !NOISE_TYPES.has(e.type));
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

// Track DOM listener cleanup functions
let domCleanupFns = [];

function setupActivityTab() {
  // Clean up previous DOM listeners before re-init
  destroyActivityTab();

  // Filter buttons
  document.querySelectorAll('.activity-filter').forEach(btn => {
    const handler = () => {
      document.querySelectorAll('.activity-filter').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activityFilter = btn.dataset.filter;
      renderActivityLog();
    };
    btn.addEventListener('click', handler);
    domCleanupFns.push(() => btn.removeEventListener('click', handler));
  });

  // Search box with debounce
  const searchInput = document.getElementById('activitySearch');
  if (searchInput) {
    const handler = () => {
      if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(() => {
        activitySearchText = searchInput.value;
        renderActivityLog();
      }, SEARCH_DEBOUNCE_MS);
    };
    searchInput.addEventListener('input', handler);
    domCleanupFns.push(() => searchInput.removeEventListener('input', handler));
  }

  // Action buttons
  const clearBtn = document.getElementById('clearActivityBtn');
  if (clearBtn) {
    clearBtn.addEventListener('click', clearActivityLog);
    domCleanupFns.push(() => clearBtn.removeEventListener('click', clearActivityLog));
  }

  const exportBtn = document.getElementById('exportActivityBtn');
  if (exportBtn) {
    exportBtn.addEventListener('click', exportActivityLog);
    domCleanupFns.push(() => exportBtn.removeEventListener('click', exportActivityLog));
  }

  // Listen for activity events
  registerScopedIpcListener('tab-activity', 'activity-logged', (event, entry) => {
    addActivityEntry(entry);
  });

  loadActivityLog();
}

function destroyActivityTab() {
  // Remove all DOM listeners
  for (const fn of domCleanupFns) {
    try { fn(); } catch (_) {}
  }
  domCleanupFns = [];

  // Clear scoped IPC listeners
  const { clearScopedIpcListeners } = require('../renderer-ipc-registry');
  clearScopedIpcListeners('tab-activity');

  // Clear debounce timer
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = null;
  }
}

module.exports = {
  setupActivityTab,
  destroyActivityTab,
  addActivityEntry,
  renderActivityLog
};
