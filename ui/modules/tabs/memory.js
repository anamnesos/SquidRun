/**
 * Memory Tab Module
 * Task #8: Conversation History Viewer
 */

const { ipcRenderer } = require('electron');
const { escapeHtml } = require('./utils');
const { PANE_ROLES, PANE_IDS } = require('../../config');

let memoryCurrentAgent = 'all';
let memoryCurrentView = 'transcript';

function formatMemoryTime(timestamp) {
  if (!timestamp) return '';
  try {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch (e) {
    return '';
  }
}

function formatMemoryDate(timestamp) {
  if (!timestamp) return '';
  try {
    const date = new Date(timestamp);
    return date.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' });
  } catch (e) {
    return '';
  }
}

function getEntryTypeClass(type) {
  const typeMap = {
    'input': 'input',
    'output': 'output',
    'tool_use': 'tool-use',
    'tool_result': 'tool-result',
    'decision': 'decision',
    'error': 'error',
    'trigger': 'trigger',
    'system': 'system',
    'state': 'state'
  };
  return typeMap[type] || '';
}

function renderTranscriptEntry(entry, showAgent = false) {
  const typeClass = getEntryTypeClass(entry.type);
  const time = formatMemoryTime(entry.timestamp);
  const isLong = entry.content && entry.content.length > 200;
  const agentLabel = showAgent && entry.paneId ? PANE_ROLES[entry.paneId] || `Pane ${entry.paneId}` : '';

  return `
    <div class="transcript-entry ${typeClass}" data-entry-id="${entry.id || ''}">
      <div class="transcript-header">
        <span class="transcript-type">${entry.type}${agentLabel ? ` (${agentLabel})` : ''}</span>
        <span class="transcript-time">${time}</span>
      </div>
      <div class="transcript-content ${isLong ? 'collapsed' : ''}">${escapeHtml(entry.content || '')}</div>
      ${isLong ? '<button class="transcript-expand">Show more</button>' : ''}
    </div>
  `;
}

async function loadMemoryTranscript(paneId = 'all', limit = 50) {
  const listEl = document.getElementById('transcriptList');
  if (!listEl) return;

  try {
    let entries = [];
    if (paneId === 'all') {
      const results = [];
      for (const id of PANE_IDS) {
        const result = await ipcRenderer.invoke('memory:get-transcript', id, Math.floor(limit / 6));
        if (result?.success && result.data) {
          results.push(...result.data.map(e => ({ ...e, paneId: id })));
        }
      }
      results.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      entries = results.slice(0, limit);
    } else {
      const result = await ipcRenderer.invoke('memory:get-transcript', paneId, limit);
      entries = (result?.success && result.data) ? result.data : [];
    }

    if (entries.length === 0) {
      listEl.innerHTML = '<div class="memory-empty">No conversation history found</div>';
      return;
    }

    listEl.innerHTML = entries.map(e => renderTranscriptEntry(e, paneId === 'all')).join('');
    listEl.querySelectorAll('.transcript-expand').forEach(btn => {
      btn.addEventListener('click', () => {
        const content = btn.previousElementSibling;
        content.classList.toggle('collapsed');
        btn.textContent = content.classList.contains('collapsed') ? 'Show more' : 'Show less';
      });
    });
  } catch (err) {
    listEl.innerHTML = `<div class="memory-empty">Error loading transcript: ${err.message}</div>`;
  }
}

function switchMemoryView(view) {
  memoryCurrentView = view;
  document.querySelectorAll('.memory-view-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.view === view);
  });
  document.querySelectorAll('.memory-view').forEach(pane => {
    pane.classList.toggle('active', pane.id === `memory-${view}`);
  });
  loadMemoryViewData(view, memoryCurrentAgent);
}

function loadMemoryViewData(view, agent) {
  if (view === 'transcript') loadMemoryTranscript(agent);
  // Other views (timeline, context, learnings, team) would go here
}

function setupMemoryTab() {
  const agentSelect = document.getElementById('memoryAgentSelect');
  if (agentSelect) {
    agentSelect.addEventListener('change', (e) => {
      memoryCurrentAgent = e.target.value;
      loadMemoryViewData(memoryCurrentView, memoryCurrentAgent);
    });
  }

  document.querySelectorAll('.memory-view-tab').forEach(tab => {
    tab.addEventListener('click', () => switchMemoryView(tab.dataset.view));
  });

  loadMemoryTranscript('all');
}

module.exports = {
  setupMemoryTab,
  loadMemoryTranscript
};
