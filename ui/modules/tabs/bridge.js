/**
 * Bridge Tab — System dashboard showing agent status, metrics, and event stream
 * Subscribes to event bus for live updates.
 */

const { PANE_IDS, PANE_ROLES, SHORT_AGENT_NAMES } = require('../../config');
const { escapeHtml } = require('./utils');

const MAX_STREAM_ENTRIES = 100;
const MAX_ACK_LATENCY_SAMPLES = 24;
const SPARKLINE_CHARS = '._:-=+*#%@';

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
let transportState = null;

function defaultTransportState() {
  return {
    daemonConnected: true,
    wakeState: 'awake',
    recoveryState: 'idle',
    ackSamples: [],
    ackLastMs: null,
    ackAvgMs: null,
    retries: 0,
    dedupeHits: 0,
    lastResumeAt: null,
  };
}

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

function toFiniteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildAsciiSparkline(samples) {
  if (!Array.isArray(samples) || samples.length === 0) return '(no ack samples)';
  const min = Math.min(...samples);
  const max = Math.max(...samples);
  const range = Math.max(1, max - min);
  return samples.map((value) => {
    const normalized = Math.max(0, Math.min(1, (value - min) / range));
    const index = Math.min(SPARKLINE_CHARS.length - 1, Math.floor(normalized * (SPARKLINE_CHARS.length - 1)));
    return SPARKLINE_CHARS[index];
  }).join('');
}

function addAckSample(latencyMs) {
  if (!transportState) return;
  transportState.ackSamples.push(latencyMs);
  if (transportState.ackSamples.length > MAX_ACK_LATENCY_SAMPLES) {
    transportState.ackSamples.shift();
  }
  transportState.ackLastMs = latencyMs;
  const sum = transportState.ackSamples.reduce((acc, sample) => acc + sample, 0);
  transportState.ackAvgMs = transportState.ackSamples.length > 0
    ? Math.round(sum / transportState.ackSamples.length)
    : null;
}

function classifyAckLatency(latencyMs) {
  if (!Number.isFinite(latencyMs)) return 'warn';
  if (latencyMs <= 300) return 'good';
  if (latencyMs <= 1200) return 'warn';
  return 'bad';
}

function classifyRecoveryState(state) {
  if (state === 'completed' || state === 'idle') return 'good';
  if (state === 'failed') return 'bad';
  return 'warn';
}

function trackTransportEvent(event) {
  if (!transportState || !event || typeof event.type !== 'string') return;
  const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};

  if (event.type === 'bridge.connected') {
    transportState.daemonConnected = true;
    return;
  }
  if (event.type === 'bridge.disconnected') {
    transportState.daemonConnected = false;
    return;
  }

  if (event.type === 'comms.retry.attempted') {
    transportState.retries += 1;
    return;
  }
  if (event.type === 'comms.dedupe.hit') {
    transportState.dedupeHits += 1;
    return;
  }
  if (event.type === 'comms.ack.latency') {
    const ackLatencyMs = toFiniteNumber(payload.ackLatencyMs);
    if (Number.isFinite(ackLatencyMs)) {
      addAckSample(Math.max(0, Math.round(ackLatencyMs)));
    }
    return;
  }

  if (event.type === 'comms.system.suspend') {
    transportState.wakeState = 'sleeping';
    return;
  }
  if (event.type === 'comms.system.resume') {
    transportState.wakeState = 'awake';
    transportState.lastResumeAt = Number.isFinite(event.ts) ? event.ts : Date.now();
    return;
  }

  if (event.type === 'comms.transport.recovery.started') {
    transportState.recoveryState = 'running';
    return;
  }
  if (event.type === 'comms.transport.recovery.completed') {
    transportState.recoveryState = 'completed';
    return;
  }
  if (event.type === 'comms.transport.recovery.failed') {
    transportState.recoveryState = 'failed';
  }
}

function renderTransportHealth() {
  const container = document.getElementById('bridgeTransport');
  if (!container) return;

  const state = transportState || defaultTransportState();
  const daemonClass = state.daemonConnected ? 'good' : 'bad';
  const wakeClass = state.wakeState === 'sleeping' ? 'warn' : 'good';
  const ackClass = classifyAckLatency(state.ackLastMs);
  const recoveryClass = classifyRecoveryState(state.recoveryState);
  const lastResume = Number.isFinite(state.lastResumeAt) ? formatTimestamp(state.lastResumeAt) : '-';
  const ackLast = Number.isFinite(state.ackLastMs) ? `${state.ackLastMs}ms` : '-';
  const ackAvg = Number.isFinite(state.ackAvgMs) ? `${state.ackAvgMs}ms` : '-';
  const sparkline = buildAsciiSparkline(state.ackSamples);

  container.innerHTML = `
    <div class="bridge-transport-row">
      <div class="bridge-transport-kv">
        <span class="bridge-transport-key">Daemon</span>
        <span class="bridge-transport-value ${daemonClass}">${state.daemonConnected ? 'connected' : 'disconnected'}</span>
      </div>
      <div class="bridge-transport-kv">
        <span class="bridge-transport-key">Wake</span>
        <span class="bridge-transport-value ${wakeClass}">${escapeHtml(state.wakeState)}</span>
      </div>
      <div class="bridge-transport-kv">
        <span class="bridge-transport-key">Recovery</span>
        <span class="bridge-transport-value ${recoveryClass}">${escapeHtml(state.recoveryState)}</span>
      </div>
      <div class="bridge-transport-kv">
        <span class="bridge-transport-key">Last Resume</span>
        <span class="bridge-transport-value">${lastResume}</span>
      </div>
    </div>
    <div class="bridge-transport-row">
      <div class="bridge-transport-kv">
        <span class="bridge-transport-key">ACK Last</span>
        <span class="bridge-transport-value ${ackClass}">${ackLast}</span>
      </div>
      <div class="bridge-transport-kv">
        <span class="bridge-transport-key">ACK Avg</span>
        <span class="bridge-transport-value">${ackAvg}</span>
      </div>
      <div class="bridge-transport-kv">
        <span class="bridge-transport-key">Retries</span>
        <span class="bridge-transport-value">${state.retries}</span>
      </div>
      <div class="bridge-transport-kv">
        <span class="bridge-transport-key">Dedupe</span>
        <span class="bridge-transport-value">${state.dedupeHits}</span>
      </div>
    </div>
    <div class="bridge-transport-sparkline" title="Recent ACK latency samples (older -> newer)">
      ack ${escapeHtml(sparkline)}
    </div>
  `;
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
  transportState = defaultTransportState();

  renderAgentCards(bus);
  renderMetrics(bus);
  renderTransportHealth();

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
    trackTransportEvent(event);
    renderTransportHealth();
    if (isNoisyEvent(event.type)) return;
    addStreamEntry(event);
    renderMetrics(bus);
  };

  for (const pattern of patterns) {
    bus.on(pattern, streamHandler);
    handlers.push({ type: pattern, fn: streamHandler });
  }

  const bridgeTransportHandler = (event) => {
    trackTransportEvent(event);
    renderTransportHealth();
    addStreamEntry(event);
    renderMetrics(bus);
  };
  bus.on('bridge.*', bridgeTransportHandler);
  handlers.push({ type: 'bridge.*', fn: bridgeTransportHandler });
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
  const transport = document.getElementById('bridgeTransport');
  if (transport) transport.innerHTML = '';
  transportState = null;
}

module.exports = { setupBridgeTab, destroy };
