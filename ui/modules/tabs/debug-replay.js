/**
 * Debug Replay Tab Module
 * Task #21 - Debug Replay
 */

const { ipcRenderer } = require('electron');
const { escapeHtml } = require('./utils');

const debugState = {
  session: null,
  actions: [],
  filteredActions: [],
  currentIndex: -1,
  isPlaying: false,
  playSpeed: 1,
  filter: 'all',
  breakpoints: new Set(),
  typeBreakpoints: new Set(),
  searchQuery: '',
  searchResults: []
};

const ACTION_COLORS = {
  'message': '#8be9fd',
  'tool_call': '#50fa7b',
  'tool_result': '#6272a4',
  'error': '#ff5555',
  'state_change': '#ffb86c',
  'decision': '#bd93f9',
  'file_access': '#f1fa8c',
  'system': '#ff79c6'
};

async function loadDebugSession(role) {
  try {
    const result = await ipcRenderer.invoke('debug-load-session', { role });
    if (result.success) {
      debugState.actions = result.actions || [];
      debugState.filteredActions = [...debugState.actions];
      debugState.currentIndex = -1;
      renderDebugTimeline();
    }
  } catch (err) {
    console.error('DebugReplay', 'Load failed', err);
  }
}

function renderDebugTimeline() {
  const timeline = document.getElementById('debugTimeline');
  if (!timeline) return;
  timeline.innerHTML = debugState.filteredActions.map((action, idx) => `
    <div class="debug-action-item" data-index="${idx}">
      <span class="debug-action-marker" style="background: ${ACTION_COLORS[action.type] || '#6272a4'}"></span>
      <span class="debug-action-type">${action.type}</span>
      <span class="debug-action-preview">${(action.content || '').substring(0, 30)}</span>
    </div>
  `).join('');
}

function setupDebugTab() {
  const loadBtn = document.getElementById('debugLoadBtn');
  const sessionSelect = document.getElementById('debugSessionSelect');
  
  if (loadBtn) {
    loadBtn.addEventListener('click', () => {
      const role = sessionSelect?.value;
      if (role) loadDebugSession(role);
    });
  }
}

module.exports = {
  setupDebugTab,
  loadDebugSession
};
