/**
 * Bridge Tab — System dashboard showing agent status, metrics, and event stream
 * Subscribes to event bus for live updates.
 */

const { PANE_IDS, PANE_ROLES, SHORT_AGENT_NAMES } = require('../../config');
const { escapeHtml } = require('./utils');

const MAX_STREAM_ENTRIES = 100;

const ACTIVITY_COLORS = {
  idle: '#4caf50',
  injecting: '#ffeb3b',
  resizing: '#2196f3',
  error: '#f44336',
  recovering: '#ff9800',
};

const GATE_LABELS = {
  focusLocked: 'L',
  compacting: 'C',
  safeMode: 'S',
};

const EVENT_CATEGORY_COLORS = {
  inject: '#ffeb3b',
  comms: '#2196f3',
  contract: '#ff9800',
  pane: '#4caf50',
  safemode: '#f44336',
};

const NOISY_PREFIXES = ['pty.data.', 'contract.checked', 'daemon.write.', 'bus.error'];

let busRef = null;
let handlers = [];
let streamEntries = 0;

function isNoisyEvent(type) {
  for (const prefix of NOISY_PREFIXES) {
    if (type === prefix || type.startsWith(prefix)) return true;
  }
  return false;
}

function getEventColor(type) {
  const category = type.split('.')[0];
  return EVENT_CATEGORY_COLORS[category] || '#9aa0ad';
}

function formatTimestamp(ts) {
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function summarizePayload(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const keys = Object.keys(payload);
  if (keys.length === 0) return '';
  const parts = [];
  for (const key of keys.slice(0, 3)) {
    const val = payload[key];
    if (val === null || val === undefined) continue;
    if (typeof val === 'object' && val.redacted) {
      parts.push(`${key}:[${val.length}b]`);
    } else if (typeof val === 'object') {
      parts.push(`${key}:{...}`);
    } else {
      const str = String(val);
      parts.push(`${key}:${str.length > 20 ? str.slice(0, 20) + '...' : str}`);
    }
  }
  return parts.join(' ');
}

// --- Agent Status Cards ---

function renderAgentCards(bus) {
  const container = document.getElementById('bridgeAgents');
  if (!container) return;

  container.innerHTML = '';

  for (const paneId of PANE_IDS) {
    const state = bus.getState(paneId);
    const card = document.createElement('div');
    card.className = 'bridge-agent-card';
    card.dataset.paneId = paneId;

    const name = SHORT_AGENT_NAMES[paneId] || PANE_ROLES[paneId] || paneId;
    const actColor = ACTIVITY_COLORS[state.activity] || ACTIVITY_COLORS.idle;

    let gatesHtml = '';
    if (state.gates) {
      if (state.gates.focusLocked) gatesHtml += `<span class="bridge-gate" title="Focus Locked">${GATE_LABELS.focusLocked}</span>`;
      if (state.gates.compacting && state.gates.compacting !== 'none') gatesHtml += `<span class="bridge-gate pulse" title="Compacting: ${escapeHtml(String(state.gates.compacting))}">${GATE_LABELS.compacting}</span>`;
      if (state.gates.safeMode) gatesHtml += `<span class="bridge-gate" title="Safe Mode">${GATE_LABELS.safeMode}</span>`;
    }

    const bridgeColor = state.connectivity && state.connectivity.bridge === 'up' ? '#4caf50' : '#f44336';
    const ptyColor = state.connectivity && state.connectivity.pty === 'up' ? '#4caf50' : '#f44336';

    card.innerHTML = `
      <div class="bridge-agent-header">
        <span class="bridge-agent-dot" style="background:${actColor}" title="${escapeHtml(state.activity || 'idle')}"></span>
        <span class="bridge-agent-name">${escapeHtml(name)}</span>
        <span class="bridge-agent-gates">${gatesHtml}</span>
      </div>
      <div class="bridge-agent-conn">
        <span class="bridge-conn-dot" style="background:${bridgeColor}" title="Bridge: ${state.connectivity ? state.connectivity.bridge : 'unknown'}"></span>
        <span class="bridge-conn-dot" style="background:${ptyColor}" title="PTY: ${state.connectivity ? state.connectivity.pty : 'unknown'}"></span>
      </div>
    `;
    container.appendChild(card);
  }
}

function updateAgentCard(paneId, state) {
  const container = document.getElementById('bridgeAgents');
  if (!container) return;

  const card = container.querySelector(`.bridge-agent-card[data-pane-id="${paneId}"]`);
  if (!card) return;

  const name = SHORT_AGENT_NAMES[paneId] || PANE_ROLES[paneId] || paneId;
  const actColor = ACTIVITY_COLORS[state.activity] || ACTIVITY_COLORS.idle;

  let gatesHtml = '';
  if (state.gates) {
    if (state.gates.focusLocked) gatesHtml += `<span class="bridge-gate" title="Focus Locked">${GATE_LABELS.focusLocked}</span>`;
    if (state.gates.compacting && state.gates.compacting !== 'none') gatesHtml += `<span class="bridge-gate pulse" title="Compacting: ${escapeHtml(String(state.gates.compacting))}">${GATE_LABELS.compacting}</span>`;
    if (state.gates.safeMode) gatesHtml += `<span class="bridge-gate" title="Safe Mode">${GATE_LABELS.safeMode}</span>`;
  }

  const bridgeColor = state.connectivity && state.connectivity.bridge === 'up' ? '#4caf50' : '#f44336';
  const ptyColor = state.connectivity && state.connectivity.pty === 'up' ? '#4caf50' : '#f44336';

  card.innerHTML = `
    <div class="bridge-agent-header">
      <span class="bridge-agent-dot" style="background:${actColor}" title="${escapeHtml(state.activity || 'idle')}"></span>
      <span class="bridge-agent-name">${escapeHtml(name)}</span>
      <span class="bridge-agent-gates">${gatesHtml}</span>
    </div>
    <div class="bridge-agent-conn">
      <span class="bridge-conn-dot" style="background:${bridgeColor}" title="Bridge: ${state.connectivity ? state.connectivity.bridge : 'unknown'}"></span>
      <span class="bridge-conn-dot" style="background:${ptyColor}" title="PTY: ${state.connectivity ? state.connectivity.pty : 'unknown'}"></span>
    </div>
  `;
}

// --- System Metrics ---

function renderMetrics(bus) {
  const container = document.getElementById('bridgeMetrics');
  if (!container) return;

  const stats = bus.getStats();
  const bufStats = bus.getBufferStats();

  container.innerHTML = `
    <div class="bridge-metric" title="Total events emitted">
      <span class="bridge-metric-value">${stats.totalEmitted}</span>
      <span class="bridge-metric-label">emitted</span>
    </div>
    <div class="bridge-metric" title="Ring buffer size / max">
      <span class="bridge-metric-value">${bufStats.size}/${bufStats.maxSize}</span>
      <span class="bridge-metric-label">buffer</span>
    </div>
    <div class="bridge-metric" title="Contract violations">
      <span class="bridge-metric-value">${stats.contractViolations}</span>
      <span class="bridge-metric-label">violations</span>
    </div>
    <div class="bridge-metric" title="Dropped events">
      <span class="bridge-metric-value">${stats.totalDropped}</span>
      <span class="bridge-metric-label">dropped</span>
    </div>
  `;
}

// --- Event Stream ---

function addStreamEntry(event) {
  const streamContainer = document.getElementById('bridgeStream');
  if (!streamContainer) return;

  // Remove the empty state on first entry
  const empty = streamContainer.querySelector('.bridge-stream-empty');
  if (empty) empty.remove();

  const entry = document.createElement('div');
  entry.className = 'bridge-stream-entry';

  const color = getEventColor(event.type);
  const time = formatTimestamp(event.ts);
  const paneLabel = SHORT_AGENT_NAMES[event.paneId] || event.paneId || 'sys';
  const summary = summarizePayload(event.payload);

  entry.innerHTML = `<span class="bridge-stream-time">${time}</span> <span class="bridge-stream-type" style="color:${color}">${escapeHtml(event.type)}</span> <span class="bridge-stream-pane">[${escapeHtml(paneLabel)}]</span>${summary ? ` <span class="bridge-stream-payload">${escapeHtml(summary)}</span>` : ''}`;

  streamContainer.appendChild(entry);
  streamEntries++;

  // Cap at MAX_STREAM_ENTRIES
  while (streamEntries > MAX_STREAM_ENTRIES) {
    const first = streamContainer.querySelector('.bridge-stream-entry');
    if (first) {
      first.remove();
      streamEntries--;
    } else {
      break;
    }
  }

  // Auto-scroll
  streamContainer.scrollTop = streamContainer.scrollHeight;
}

// --- Setup & Destroy ---

function setupBridgeTab(bus) {
  if (!bus) return;
  busRef = bus;
  streamEntries = 0;

  renderAgentCards(bus);
  renderMetrics(bus);

  // State change handler
  const stateHandler = (event) => {
    if (event.paneId && event.payload && event.payload.next) {
      updateAgentCard(event.paneId, event.payload.next);
    }
    renderMetrics(bus);
  };
  bus.on('pane.state.changed', stateHandler);
  handlers.push({ type: 'pane.state.changed', fn: stateHandler });

  // Event stream — subscribe to significant event patterns
  const patterns = ['pane.state.changed', 'comms.*', 'contract.*', 'inject.*', 'safemode.*'];
  const streamHandler = (event) => {
    if (isNoisyEvent(event.type)) return;
    addStreamEntry(event);
    renderMetrics(bus);
  };

  for (const pattern of patterns) {
    bus.on(pattern, streamHandler);
    handlers.push({ type: pattern, fn: streamHandler });
  }
}

function destroy() {
  if (busRef) {
    for (const h of handlers) {
      busRef.off(h.type, h.fn);
    }
  }
  handlers = [];
  busRef = null;
  streamEntries = 0;

  const stream = document.getElementById('bridgeStream');
  if (stream) {
    stream.innerHTML = '<div class="bridge-stream-empty">Waiting for events...</div>';
  }
  const agents = document.getElementById('bridgeAgents');
  if (agents) agents.innerHTML = '';
  const metrics = document.getElementById('bridgeMetrics');
  if (metrics) metrics.innerHTML = '';
}

module.exports = { setupBridgeTab, destroy };
