'use strict';

const { getProjectRoot } = require('../../config');
const {
  MIRA_LAB_EXPORT_CHANNEL,
  MIRA_LAB_PROMPT_REPLY_CHANNEL,
  MIRA_LAB_TURN_CHANNEL,
  buildMiraLabPromptReply,
  buildMiraLabTurn,
  exportMiraLabTranscript,
} = require('../mira-lab-surface');

const MIRA_LAB_OPEN_CHANNEL = 'mira:lab-open';

async function buildMiraLabTurnResponse(payload = {}, options = {}) {
  return buildMiraLabTurn(payload, {
    ...options,
    projectRoot: options.projectRoot || getProjectRoot(),
  });
}

async function buildMiraLabPromptReplyResponse(payload = {}, options = {}) {
  return buildMiraLabPromptReply(payload, {
    ...options,
    projectRoot: options.projectRoot || getProjectRoot(),
  });
}

function exportMiraLabTranscriptResponse(payload = {}, options = {}) {
  return exportMiraLabTranscript(payload, {
    ...options,
    projectRoot: options.projectRoot || getProjectRoot(),
  });
}

function openMiraLabWindowResponse(payload = {}, options = {}) {
  const factory = options.createMiraLabWindow || options.openWindow;
  if (typeof factory !== 'function') {
    return {
      ok: false,
      reason: 'mira_lab_window_factory_missing',
      channel: MIRA_LAB_OPEN_CHANNEL,
    };
  }
  try {
    const result = factory({
      ...options,
      requestedAt: new Date().toISOString(),
      payload,
    }) || {};
    return {
      ok: true,
      channel: MIRA_LAB_OPEN_CHANNEL,
      htmlPath: result.htmlPath || null,
      preloadPath: result.preloadPath || null,
    };
  } catch (err) {
    return {
      ok: false,
      reason: err?.message || 'mira_lab_window_open_failed',
      channel: MIRA_LAB_OPEN_CHANNEL,
    };
  }
}

function registerMiraLabHandlers(ctx, deps = {}) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerMiraLabHandlers requires ctx.ipcMain');
  }
  const ipcMain = ctx.ipcMain;
  ipcMain.handle(MIRA_LAB_TURN_CHANNEL, (_event, payload = {}) =>
    buildMiraLabTurnResponse(payload, deps));
  ipcMain.handle(MIRA_LAB_EXPORT_CHANNEL, (_event, payload = {}) =>
    exportMiraLabTranscriptResponse(payload, deps));
  ipcMain.handle(MIRA_LAB_OPEN_CHANNEL, (_event, payload = {}) =>
    openMiraLabWindowResponse(payload, deps));
  ipcMain.handle(MIRA_LAB_PROMPT_REPLY_CHANNEL, (_event, payload = {}) =>
    buildMiraLabPromptReplyResponse(payload, deps));
}

function unregisterMiraLabHandlers(ctx) {
  const ipcMain = ctx && ctx.ipcMain;
  if (!ipcMain || typeof ipcMain.removeHandler !== 'function') return;
  ipcMain.removeHandler(MIRA_LAB_TURN_CHANNEL);
  ipcMain.removeHandler(MIRA_LAB_EXPORT_CHANNEL);
  ipcMain.removeHandler(MIRA_LAB_OPEN_CHANNEL);
  ipcMain.removeHandler(MIRA_LAB_PROMPT_REPLY_CHANNEL);
}

registerMiraLabHandlers.unregister = unregisterMiraLabHandlers;

module.exports = {
  MIRA_LAB_EXPORT_CHANNEL,
  MIRA_LAB_OPEN_CHANNEL,
  MIRA_LAB_PROMPT_REPLY_CHANNEL,
  MIRA_LAB_TURN_CHANNEL,
  buildMiraLabPromptReplyResponse,
  buildMiraLabTurnResponse,
  exportMiraLabTranscriptResponse,
  openMiraLabWindowResponse,
  registerMiraLabHandlers,
  unregisterMiraLabHandlers,
};
