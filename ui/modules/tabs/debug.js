/**
 * Debug and Inspector Tab Module
 * Task #3 - Task Queue Dashboard
 * Task #21 - Debug Replay
 */

const { ipcRenderer } = require('electron');
const log = require('../logger');
const { escapeHtml } = require('./utils');
const { SHORT_AGENT_NAMES } = require('../../config');

// ============================================================
// MESSAGE INSPECTOR
// ============================================================

let inspectorEvents = [];
let inspectorFilter = 'all';
let inspectorAutoScroll = true;
let inspectorPaused = false;
const MAX_INSPECTOR_EVENTS = 500;

const INSPECTOR_STATS = {
  total: 0,
  delivered: 0,
  pending: 0,
  skipped: 0
};

function formatInspectorTime(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function getAgentShortName(id) {
  if (!id) return '?';
  const strId = String(id);
  return SHORT_AGENT_NAMES[strId] || SHORT_AGENT_NAMES[strId.toLowerCase()] || strId;
}

function addInspectorEvent(event) {
  if (inspectorPaused) return;

  const entry = {
    id: Date.now() + Math.random(),
    timestamp: new Date().toISOString(),
    ...event
  };

  inspectorEvents.push(entry);

  if (inspectorEvents.length > MAX_INSPECTOR_EVENTS) {
    inspectorEvents = inspectorEvents.slice(-MAX_INSPECTOR_EVENTS);
  }

  INSPECTOR_STATS.total++;
  if (event.status === 'delivered' || event.status === 'success') {
    INSPECTOR_STATS.delivered++;
  } else if (event.status === 'pending') {
    INSPECTOR_STATS.pending++;
  } else if (event.status === 'skipped' || event.status === 'blocked') {
    INSPECTOR_STATS.skipped++;
  }

  renderInspectorStats();
  renderInspectorLog();
}

function renderInspectorStats() {
  const totalEl = document.getElementById('inspectorTotalEvents');
  const deliveredEl = document.getElementById('inspectorDelivered');
  const pendingEl = document.getElementById('inspectorPending');
  const skippedEl = document.getElementById('inspectorSkipped');

  if (totalEl) totalEl.textContent = INSPECTOR_STATS.total;
  if (deliveredEl) deliveredEl.textContent = INSPECTOR_STATS.delivered;
  if (pendingEl) pendingEl.textContent = INSPECTOR_STATS.pending;
  if (skippedEl) skippedEl.textContent = INSPECTOR_STATS.skipped;
}

function renderInspectorLog() {
  const logEl = document.getElementById('inspectorLog');
  if (!logEl) return;

  let filtered = inspectorEvents;
  if (inspectorFilter !== 'all') {
    filtered = inspectorEvents.filter(e => e.type === inspectorFilter);
  }

  if (filtered.length === 0) {
    logEl.innerHTML = '<div class="inspector-empty">No events captured yet. Trigger files or send messages to see activity.</div>';
    return;
  }

  logEl.innerHTML = filtered.map(event => {
    const time = formatInspectorTime(event.timestamp);
    const from = getAgentShortName(event.from);
    const to = getAgentShortName(event.to);
    const seq = event.seq ? `#${event.seq}` : '';
    const statusIcon = event.status === 'delivered' || event.status === 'success' ? '✓' :
                       event.status === 'pending' ? '⏳' :
                       event.status === 'skipped' || event.status === 'blocked' ? '✗' : '';
    const statusClass = event.status === 'delivered' || event.status === 'success' ? 'success' :
                        event.status === 'pending' ? 'pending' : 'failed';
    const msgStr = typeof event.message === 'string' ? event.message :
                   event.message ? JSON.stringify(event.message) : '';
    const msgPreview = msgStr ? msgStr.substring(0, 60) + (msgStr.length > 60 ? '...' : '') : '';

    return `
      <div class="inspector-event" data-id="${event.id}" title="${escapeHtml(msgStr || '')}">
        <span class="inspector-event-time">${time}</span>
        <span class="inspector-event-type ${event.type}">${event.type}</span>
        <span class="inspector-event-route">
          ${from}<span class="arrow">→</span>${to}
        </span>
        <span class="inspector-event-seq">${seq}</span>
        <span class="inspector-event-status ${statusClass}">${statusIcon}</span>
        <span class="inspector-event-message">${escapeHtml(msgPreview)}</span>
      </div>
    `;
  }).join('');

  if (inspectorAutoScroll) {
    logEl.scrollTop = logEl.scrollHeight;
  }
}

async function loadSequenceState() {
  try {
    const result = await ipcRenderer.invoke('get-message-state');
    if (result && result.success && result.state) {
      const sequences = result.state.sequences || {};

      for (const agent of ['lead', 'orchestrator', 'worker-a', 'worker-b', 'investigator', 'reviewer']) {
        const el = document.getElementById(`seq-${agent}`);
        if (el) {
          const agentState = sequences[agent];
          if (agentState && agentState.lastSeen) {
            const lastSeenEntries = Object.entries(agentState.lastSeen);
            if (lastSeenEntries.length > 0) {
              el.textContent = lastSeenEntries.map(([sender, seq]) => `${getAgentShortName(sender)}:#${seq}`).join(', ');
            } else {
              el.textContent = 'clean';
            }
          } else {
            el.textContent = 'clean';
          }
        }
      }
    }
  } catch (err) {
    log.error('Debug', 'Error loading sequence state', err);
  }
}

async function loadReliabilityStats() {
  try {
    const result = await ipcRenderer.invoke('get-reliability-stats');
    if (result && result.success && result.stats) {
      const stats = result.stats;

      const successRateEl = document.getElementById('reliabilitySuccessRate');
      if (successRateEl) successRateEl.textContent = `${stats.aggregate.successRate}%`;

      const uptimeEl = document.getElementById('reliabilityUptime');
      if (uptimeEl) uptimeEl.textContent = stats.uptimeFormatted || '--';

      const latencyEl = document.getElementById('reliabilityLatency');
      if (latencyEl) latencyEl.textContent = stats.latency.avg > 0 ? `${stats.latency.avg}ms` : '--';

      const sentEl = document.getElementById('reliabilitySent');
      if (sentEl) sentEl.textContent = stats.aggregate.sent;

      const deliveredEl = document.getElementById('reliabilityDelivered');
      if (deliveredEl) deliveredEl.textContent = stats.aggregate.delivered;

      const failedEl = document.getElementById('reliabilityFailed');
      if (failedEl) failedEl.textContent = stats.aggregate.failed;

      const timedOutEl = document.getElementById('reliabilityTimedOut');
      if (timedOutEl) timedOutEl.textContent = stats.aggregate.timedOut;

      const skippedEl = document.getElementById('reliabilitySkipped');
      if (skippedEl) skippedEl.textContent = stats.aggregate.skipped;
    }
  } catch (err) {
    log.error('Debug', 'Error loading reliability stats', err);
  }
}

function setupInspectorTab() {
  document.querySelectorAll('.inspector-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.inspector-filter').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      inspectorFilter = btn.dataset.filter;
      renderInspectorLog();
    });
  });

  const autoScrollCheck = document.getElementById('inspectorAutoScroll');
  if (autoScrollCheck) {
    autoScrollCheck.addEventListener('change', () => {
      inspectorAutoScroll = autoScrollCheck.checked;
    });
  }

  const pauseCheck = document.getElementById('inspectorPaused');
  if (pauseCheck) {
    pauseCheck.addEventListener('change', () => {
      inspectorPaused = pauseCheck.checked;
    });
  }

  const refreshBtn = document.getElementById('refreshInspectorBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', loadSequenceState);

  const clearBtn = document.getElementById('clearInspectorBtn');
  if (clearBtn) clearBtn.addEventListener('click', () => {
    inspectorEvents = [];
    renderInspectorStats();
    renderInspectorLog();
  });

  const reliabilityRefreshBtn = document.getElementById('refreshReliabilityBtn');
  if (reliabilityRefreshBtn) reliabilityRefreshBtn.addEventListener('click', loadReliabilityStats);

  loadReliabilityStats();

  ipcRenderer.on('inject-message', (event, data) => {
    const panes = data.panes || [];
    panes.forEach(paneId => {
      addInspectorEvent({
        type: 'pty',
        from: 'system',
        to: paneId,
        message: data.message ? data.message.replace(/\r/g, '') : '',
        status: 'delivered'
      });
    });
  });

  ipcRenderer.on('sdk-message', (event, data) => {
    addInspectorEvent({
      type: 'sdk',
      from: data.from || 'system',
      to: data.paneId || data.to,
      message: data.message || data.content,
      seq: data.seq,
      status: 'delivered'
    });
  });

  ipcRenderer.on('sync-triggered', (event, data) => {
    addInspectorEvent({
      type: 'trigger',
      from: 'system',
      to: data.notified ? data.notified.join(',') : 'all',
      message: `Sync: ${data.file || 'shared_context.md'}`,
      status: 'delivered'
    });
  });

  ipcRenderer.on('trigger-blocked', (event, data) => {
    addInspectorEvent({
      type: 'blocked',
      from: data.sender || 'unknown',
      to: data.recipient || data.target,
      message: data.reason || 'Duplicate or blocked',
      seq: data.seq,
      status: 'skipped'
    });
    if (INSPECTOR_STATS.delivered > 0) INSPECTOR_STATS.delivered--;
  });

  loadSequenceState();
  renderInspectorStats();
}

// ============================================================
// TASK QUEUE DASHBOARD
// ============================================================

let queueStatus = null;
let conflictStatus = { locks: {}, queues: {}, lockCount: 0, queuedCount: 0 };
let queueEvents = [];
const MAX_QUEUE_EVENTS = 120;

function renderQueueSummary() {
  const totalEl = document.getElementById('queueTotalCount');
  const undeliveredEl = document.getElementById('queueUndeliveredCount');
  const lockEl = document.getElementById('queueLockCount');
  const queuedFilesEl = document.getElementById('queueFileCount');

  if (totalEl) totalEl.textContent = queueStatus?.totalMessages || 0;
  if (undeliveredEl) undeliveredEl.textContent = queueStatus?.undelivered || 0;
  if (lockEl) lockEl.textContent = conflictStatus?.lockCount || 0;
  if (queuedFilesEl) queuedFilesEl.textContent = conflictStatus?.queuedCount || 0;
}

async function loadQueueStatus() {
  try {
    const result = await ipcRenderer.invoke('get-queue-status');
    if (result && result.success) {
      queueStatus = result.status;
      renderQueueSummary();
    }
  } catch (err) {
    log.error('Debug', 'Error loading queue status', err);
  }
}

function setupQueueTab() {
  const refreshBtn = document.getElementById('refreshQueueBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', loadQueueStatus);
  loadQueueStatus();
}

module.exports = {
  setupInspectorTab,
  setupQueueTab,
  addInspectorEvent
};
