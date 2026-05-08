'use strict';

const { getProjectRoot } = require('../../config');
const {
  MIRA_LAB_EXPORT_CHANNEL,
  MIRA_LAB_TURN_CHANNEL,
  buildMiraLabTurn,
  exportMiraLabTranscript,
} = require('../mira-lab-surface');

async function buildMiraLabTurnResponse(payload = {}, options = {}) {
  return buildMiraLabTurn(payload, {
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

function registerMiraLabHandlers(ctx, deps = {}) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerMiraLabHandlers requires ctx.ipcMain');
  }
  const ipcMain = ctx.ipcMain;
  ipcMain.handle(MIRA_LAB_TURN_CHANNEL, (_event, payload = {}) =>
    buildMiraLabTurnResponse(payload, deps));
  ipcMain.handle(MIRA_LAB_EXPORT_CHANNEL, (_event, payload = {}) =>
    exportMiraLabTranscriptResponse(payload, deps));
}

function unregisterMiraLabHandlers(ctx) {
  const ipcMain = ctx && ctx.ipcMain;
  if (!ipcMain || typeof ipcMain.removeHandler !== 'function') return;
  ipcMain.removeHandler(MIRA_LAB_TURN_CHANNEL);
  ipcMain.removeHandler(MIRA_LAB_EXPORT_CHANNEL);
}

registerMiraLabHandlers.unregister = unregisterMiraLabHandlers;

module.exports = {
  MIRA_LAB_EXPORT_CHANNEL,
  MIRA_LAB_TURN_CHANNEL,
  buildMiraLabTurnResponse,
  exportMiraLabTranscriptResponse,
  registerMiraLabHandlers,
  unregisterMiraLabHandlers,
};
