'use strict';

const voiceBrokerLane = require('../../scripts/hm-voice-broker');
const { getVoiceBrokerConfig } = require('../voice-broker');

const CHANNEL_STATUS = 'voice-broker:status';
const CHANNEL_CONTROL = 'voice-broker:control';
const CONTROL_ACTIONS = new Set(['start', 'stop', 'restart']);

function getNotReadyReasons(config) {
  const reasons = [];
  if (!config.enabled) reasons.push('voice_broker_disabled');
  if (!config.openaiApiKeyPresent) reasons.push('openai_api_key_missing');
  return reasons;
}

function sanitizeConfig(config) {
  return {
    enabled: config.enabled,
    host: config.host,
    port: config.port,
    model: config.model,
    voice: config.voice,
    openaiApiKeyPresent: config.openaiApiKeyPresent,
    transcriptJournalPath: config.transcriptJournalPath,
    endpointShape: config.endpointShape,
  };
}

function deriveState(laneStatus, ready) {
  if (!ready) return 'not_ready';
  return laneStatus?.running ? 'running' : 'stopped';
}

function buildVoiceBrokerStatus(options = {}) {
  const lane = options.lane || voiceBrokerLane;
  const env = options.env || process.env;
  const config = options.config || getVoiceBrokerConfig(env, options.configOverrides || {});
  const laneStatus = typeof lane.status === 'function'
    ? lane.status()
    : { ok: false, running: false, reason: 'status_unavailable' };
  const notReadyReasons = getNotReadyReasons(config);
  const ready = notReadyReasons.length === 0;

  return {
    ok: true,
    state: deriveState(laneStatus, ready),
    ready,
    running: Boolean(laneStatus?.running),
    notReadyReasons,
    lane: laneStatus,
    config: sanitizeConfig(config),
  };
}

async function executeVoiceBrokerControl(action, options = {}) {
  const normalizedAction = String(action || '').trim().toLowerCase();
  if (!CONTROL_ACTIONS.has(normalizedAction)) {
    return {
      ok: false,
      reason: 'invalid_voice_broker_action',
      action: normalizedAction || null,
      status: buildVoiceBrokerStatus(options),
    };
  }

  const before = buildVoiceBrokerStatus(options);
  if (!before.ready && normalizedAction !== 'stop') {
    return {
      ok: false,
      reason: 'voice_broker_not_ready',
      action: normalizedAction,
      notReadyReasons: before.notReadyReasons,
      status: before,
    };
  }

  const lane = options.lane || voiceBrokerLane;
  const command = lane[normalizedAction];
  if (typeof command !== 'function') {
    return {
      ok: false,
      reason: 'voice_broker_action_unavailable',
      action: normalizedAction,
      status: before,
    };
  }

  const result = await command();
  return {
    ok: result?.ok !== false,
    action: normalizedAction,
    result,
    status: buildVoiceBrokerStatus(options),
  };
}

function registerVoiceBrokerHandlers(ctx, deps = {}) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerVoiceBrokerHandlers requires ctx.ipcMain');
  }
  const ipcMain = ctx.ipcMain;
  ipcMain.handle(CHANNEL_STATUS, (_event, options = {}) => buildVoiceBrokerStatus({
    ...deps,
    ...options,
  }));
  ipcMain.handle(CHANNEL_CONTROL, async (_event, payload = {}) => executeVoiceBrokerControl(payload?.action, {
    ...deps,
    ...(payload?.options || {}),
  }));
}

function unregisterVoiceBrokerHandlers(ctx) {
  const ipcMain = ctx && ctx.ipcMain;
  if (!ipcMain || typeof ipcMain.removeHandler !== 'function') return;
  ipcMain.removeHandler(CHANNEL_STATUS);
  ipcMain.removeHandler(CHANNEL_CONTROL);
}

registerVoiceBrokerHandlers.unregister = unregisterVoiceBrokerHandlers;

module.exports = {
  CHANNEL_CONTROL,
  CHANNEL_STATUS,
  buildVoiceBrokerStatus,
  executeVoiceBrokerControl,
  registerVoiceBrokerHandlers,
  unregisterVoiceBrokerHandlers,
};
