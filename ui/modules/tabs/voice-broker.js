'use strict';

const { invokeBridge } = require('../renderer-bridge');
const { escapeHtml } = require('./utils');

const IDS = Object.freeze({
  panel: 'voiceBrokerPanel',
  state: 'voiceBrokerState',
  readiness: 'voiceBrokerReadiness',
  endpoint: 'voiceBrokerEndpoint',
  model: 'voiceBrokerModel',
  journal: 'voiceBrokerJournal',
  error: 'voiceBrokerError',
  refresh: 'voiceBrokerRefreshBtn',
  start: 'voiceBrokerStartBtn',
  stop: 'voiceBrokerStopBtn',
  restart: 'voiceBrokerRestartBtn',
});

let cleanupFns = [];
let lastStatus = null;

function getEl(id) {
  if (typeof document === 'undefined') return null;
  return document.getElementById(id);
}

function getStateLabel(status) {
  const state = status?.state || (status?.running ? 'running' : 'stopped');
  if (state === 'running') return 'Running';
  if (state === 'not_ready') return 'Not ready';
  if (state === 'stopped') return 'Stopped';
  return 'Unavailable';
}

function getReadinessLabel(status) {
  if (!status || status.ok === false) return 'Unavailable';
  const reasons = Array.isArray(status.notReadyReasons) ? status.notReadyReasons : [];
  if (reasons.includes('openai_api_key_missing')) return 'OPENAI_API_KEY missing';
  if (reasons.includes('voice_broker_disabled')) return 'Disabled';
  return status.ready ? 'Ready' : 'Not ready';
}

function getEndpointLabel(status) {
  const shape = status?.config?.endpointShape?.clientSecret;
  const address = status?.lane?.broker?.address || status?.lane?.address || null;
  const host = address?.address || status?.config?.host || '127.0.0.1';
  const port = address?.port || status?.config?.port || 0;
  const base = port ? `http://${host}:${port}` : `${status?.config?.host || '127.0.0.1'}:auto`;
  if (!shape) return base;
  return `${shape.method} ${base}${shape.path}`;
}

function getModelLabel(status) {
  const model = status?.config?.model || 'gpt-realtime';
  const voice = status?.config?.voice || 'marin';
  return `${model} / ${voice}`;
}

function renderText(id, text) {
  const el = getEl(id);
  if (el) el.textContent = text;
}

function setError(message) {
  const el = getEl(IDS.error);
  if (!el) return;
  if (!message) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.textContent = message;
}

function setButtonState(status) {
  const ready = Boolean(status?.ready);
  const running = Boolean(status?.running);
  const start = getEl(IDS.start);
  const stop = getEl(IDS.stop);
  const restart = getEl(IDS.restart);
  if (start) start.disabled = running || !ready;
  if (stop) stop.disabled = !running;
  if (restart) restart.disabled = !ready;
}

function renderVoiceBrokerStatus(status) {
  lastStatus = status;
  const panel = getEl(IDS.panel);
  if (panel) panel.dataset.state = status?.state || 'unavailable';

  renderText(IDS.state, getStateLabel(status));
  renderText(IDS.readiness, getReadinessLabel(status));
  renderText(IDS.endpoint, getEndpointLabel(status));
  renderText(IDS.model, getModelLabel(status));
  renderText(IDS.journal, status?.config?.transcriptJournalPath || status?.lane?.logPath || 'Not configured');
  setButtonState(status);
  setError(status?.ok === false ? status.reason || 'Voice broker unavailable' : null);
}

function renderVoiceBrokerPanelHtml(status) {
  return [
    `<div class="voice-broker-pill" data-state="${escapeHtml(status?.state || 'unavailable')}">${escapeHtml(getStateLabel(status))}</div>`,
    `<div class="voice-broker-readiness">${escapeHtml(getReadinessLabel(status))}</div>`,
    `<div class="voice-broker-endpoint">${escapeHtml(getEndpointLabel(status))}</div>`,
  ].join('');
}

async function refreshVoiceBrokerStatus() {
  try {
    const status = await invokeBridge('voice-broker:status');
    renderVoiceBrokerStatus(status);
    return status;
  } catch (err) {
    const status = {
      ok: false,
      state: 'unavailable',
      ready: false,
      running: false,
      reason: err.message,
      notReadyReasons: ['ipc_unavailable'],
      config: {},
    };
    renderVoiceBrokerStatus(status);
    setError(err.message);
    return status;
  }
}

async function controlVoiceBroker(action) {
  setError(null);
  try {
    const result = await invokeBridge('voice-broker:control', { action });
    renderVoiceBrokerStatus(result?.status || lastStatus || {});
    if (result?.ok === false) {
      setError(result.reason || 'Voice broker command failed');
    }
    return result;
  } catch (err) {
    setError(err.message);
    throw err;
  }
}

function bindButton(id, handler) {
  const button = getEl(id);
  if (!button) return;
  button.addEventListener('click', handler);
  cleanupFns.push(() => button.removeEventListener('click', handler));
}

function setupVoiceBrokerTab() {
  destroyVoiceBrokerTab();
  bindButton(IDS.refresh, () => { void refreshVoiceBrokerStatus(); });
  bindButton(IDS.start, () => { void controlVoiceBroker('start'); });
  bindButton(IDS.stop, () => { void controlVoiceBroker('stop'); });
  bindButton(IDS.restart, () => { void controlVoiceBroker('restart'); });
  void refreshVoiceBrokerStatus();
}

function destroyVoiceBrokerTab() {
  for (const fn of cleanupFns) {
    try { fn(); } catch (_) {}
  }
  cleanupFns = [];
}

module.exports = {
  controlVoiceBroker,
  destroyVoiceBrokerTab,
  getReadinessLabel,
  getStateLabel,
  refreshVoiceBrokerStatus,
  renderVoiceBrokerPanelHtml,
  renderVoiceBrokerStatus,
  setupVoiceBrokerTab,
};
