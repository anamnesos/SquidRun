/**
 * Health Strip — Real-time pane status indicators
 * Subscribes to event bus pane.state.changed events and renders
 * a compact status strip showing activity, gates, and connectivity per pane.
 */

const { PANE_IDS, PANE_ROLES, SHORT_AGENT_NAMES } = require('../config');

let container = null;
let busRef = null;
let stateHandler = null;
let commsHandler = null;
let styleEl = null;
let paneElements = {};
let metricsElement = null;

const METRIC_WINDOW_MS = 5 * 60 * 1000;
const commsMetrics = {
  sendStarted: [],
  retry: [],
  failed: [],
  dedupe: [],
};

const ACTIVITY_COLORS = {
  idle: '#4caf50',       // green
  injecting: '#ffeb3b',  // yellow
  resizing: '#2196f3',   // blue
  error: '#f44336',      // red
  recovering: '#ff9800', // orange
};

const GATE_LABELS = {
  focusLocked: 'L',
  compacting: 'C',
  safeMode: 'S',
};

function injectStyles() {
  if (styleEl) return;
  styleEl = document.createElement('style');
  styleEl.textContent = `
    .health-strip {
      display: flex;
      flex-direction: row;
      align-items: center;
      gap: 12px;
      height: 24px;
      padding: 0 8px;
      background: rgba(0, 0, 0, 0.3);
      border-top: 1px solid rgba(255, 255, 255, 0.08);
      font-family: monospace;
      font-size: 11px;
      color: #aaa;
      flex-shrink: 0;
    }
    .health-strip-pane {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .health-strip-label {
      color: #888;
      margin-right: 2px;
    }
    .health-strip-pane[data-cli] .health-strip-label {
      color: var(--agent-color, #888);
    }
    .health-strip-dot {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #4caf50;
    }
    .health-strip-gates {
      display: flex;
      gap: 2px;
    }
    .health-strip-gate {
      display: inline-block;
      padding: 0 2px;
      font-size: 9px;
      font-weight: bold;
      border-radius: 2px;
      background: rgba(255, 152, 0, 0.3);
      color: #ff9800;
    }
    .health-strip-gate.pulse {
      animation: health-pulse 1.5s ease-in-out infinite;
    }
    .health-strip-conn {
      display: flex;
      gap: 2px;
    }
    .health-strip-conn-dot {
      display: inline-block;
      width: 6px;
      height: 6px;
      border-radius: 50%;
    }
    .health-strip-metrics {
      margin-left: auto;
      display: flex;
      gap: 8px;
      color: #9aa0ad;
      font-size: 10px;
      letter-spacing: 0.2px;
    }
    .health-strip-metric {
      opacity: 0.9;
    }
    @keyframes health-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }
  `;
  document.head.appendChild(styleEl);
}

function createPaneIndicator(paneId) {
  const wrapper = document.createElement('div');
  wrapper.className = 'health-strip-pane';
  wrapper.dataset.paneId = paneId;

  // Inherit data-cli from the corresponding pane element for color binding
  try {
    const paneEl = document.querySelector(`.pane[data-pane-id="${paneId}"]`);
    if (paneEl && paneEl.dataset && paneEl.dataset.cli) {
      wrapper.dataset.cli = paneEl.dataset.cli;
    }
  } catch (_) { /* safe in test environments without full DOM */ }

  const label = document.createElement('span');
  label.className = 'health-strip-label';
  label.textContent = SHORT_AGENT_NAMES[paneId] || PANE_ROLES[paneId] || paneId;

  const dot = document.createElement('span');
  dot.className = 'health-strip-dot';

  const gates = document.createElement('span');
  gates.className = 'health-strip-gates';

  const conn = document.createElement('span');
  conn.className = 'health-strip-conn';

  const bridgeDot = document.createElement('span');
  bridgeDot.className = 'health-strip-conn-dot';
  bridgeDot.title = 'Bridge';

  const ptyDot = document.createElement('span');
  ptyDot.className = 'health-strip-conn-dot';
  ptyDot.title = 'PTY';

  conn.appendChild(bridgeDot);
  conn.appendChild(ptyDot);

  wrapper.appendChild(label);
  wrapper.appendChild(dot);
  wrapper.appendChild(gates);
  wrapper.appendChild(conn);

  return { wrapper, dot, gates, conn, bridgeDot, ptyDot };
}

function updateIndicator(paneId, state) {
  const el = paneElements[paneId];
  if (!el) return;

  // Activity dot color
  const color = ACTIVITY_COLORS[state.activity] || ACTIVITY_COLORS.idle;
  el.dot.style.background = color;
  el.dot.title = state.activity || 'idle';

  // Gates
  el.gates.innerHTML = '';
  if (state.gates) {
    if (state.gates.focusLocked) {
      const badge = document.createElement('span');
      badge.className = 'health-strip-gate';
      badge.textContent = GATE_LABELS.focusLocked;
      badge.title = 'Focus Locked';
      el.gates.appendChild(badge);
    }
    if (state.gates.compacting && state.gates.compacting !== 'none') {
      const badge = document.createElement('span');
      badge.className = 'health-strip-gate pulse';
      badge.textContent = GATE_LABELS.compacting;
      badge.title = `Compacting: ${state.gates.compacting}`;
      el.gates.appendChild(badge);
    }
    if (state.gates.safeMode) {
      const badge = document.createElement('span');
      badge.className = 'health-strip-gate';
      badge.textContent = GATE_LABELS.safeMode;
      badge.title = 'Safe Mode';
      el.gates.appendChild(badge);
    }
  }

  // Connectivity
  if (state.connectivity) {
    el.bridgeDot.style.background = state.connectivity.bridge === 'up' ? '#4caf50' : '#f44336';
    el.ptyDot.style.background = state.connectivity.pty === 'up' ? '#4caf50' : '#f44336';
  }
}

function pruneMetricBuckets(now = Date.now()) {
  const cutoff = now - METRIC_WINDOW_MS;
  Object.keys(commsMetrics).forEach((key) => {
    commsMetrics[key] = commsMetrics[key].filter((ts) => ts >= cutoff);
  });
}

function metricRate(numerator, denominator) {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 100);
}

function renderCommsMetrics() {
  if (!metricsElement) return;
  pruneMetricBuckets();
  const sends = commsMetrics.sendStarted.length;
  const retryRate = metricRate(commsMetrics.retry.length, sends);
  const failRate = metricRate(commsMetrics.failed.length, sends);
  const dedupeRate = metricRate(commsMetrics.dedupe.length, sends);

  metricsElement.innerHTML = `
    <span class="health-strip-metric" title="Retry rate (5m): ${commsMetrics.retry.length}/${sends}">R:${retryRate}%</span>
    <span class="health-strip-metric" title="Fallback/failure rate (5m): ${commsMetrics.failed.length}/${sends}">F:${failRate}%</span>
    <span class="health-strip-metric" title="Dedup hit rate (5m): ${commsMetrics.dedupe.length}/${sends}">D:${dedupeRate}%</span>
  `;
}

function init(busInstance, containerElement) {
  if (!busInstance || !containerElement) return;

  busRef = busInstance;
  container = containerElement;

  injectStyles();

  // Create strip container
  const strip = document.createElement('div');
  strip.className = 'health-strip';

  // Create indicator for each pane
  for (const paneId of PANE_IDS) {
    const indicator = createPaneIndicator(paneId);
    paneElements[paneId] = indicator;
    strip.appendChild(indicator.wrapper);

    // Initialize with current state
    const currentState = busRef.getState(paneId);
    updateIndicator(paneId, currentState);
  }

  metricsElement = document.createElement('span');
  metricsElement.className = 'health-strip-metrics';
  strip.appendChild(metricsElement);
  renderCommsMetrics();

  container.appendChild(strip);

  // Subscribe to state changes
  stateHandler = (event) => {
    const paneId = event.paneId;
    if (paneId && event.payload && event.payload.next) {
      updateIndicator(paneId, event.payload.next);
    }
  };
  busRef.on('pane.state.changed', stateHandler);

  commsHandler = (event) => {
    const now = event?.ts || Date.now();
    switch (event?.type) {
      case 'comms.send.started':
        commsMetrics.sendStarted.push(now);
        break;
      case 'comms.retry.attempted':
        commsMetrics.retry.push(now);
        break;
      case 'comms.delivery.failed':
        commsMetrics.failed.push(now);
        break;
      case 'comms.dedupe.hit':
        commsMetrics.dedupe.push(now);
        break;
      default:
        return;
    }
    renderCommsMetrics();
  };
  busRef.on('comms.*', commsHandler);
}

function destroy() {
  if (busRef && stateHandler) {
    busRef.off('pane.state.changed', stateHandler);
  }
  if (busRef && commsHandler) {
    busRef.off('comms.*', commsHandler);
  }
  if (styleEl && styleEl.parentNode) {
    styleEl.parentNode.removeChild(styleEl);
  }
  if (container) {
    const strip = container.querySelector('.health-strip');
    if (strip) strip.remove();
  }
  container = null;
  busRef = null;
  stateHandler = null;
  commsHandler = null;
  styleEl = null;
  paneElements = {};
  metricsElement = null;
  commsMetrics.sendStarted = [];
  commsMetrics.retry = [];
  commsMetrics.failed = [];
  commsMetrics.dedupe = [];
}

module.exports = { init, destroy };
