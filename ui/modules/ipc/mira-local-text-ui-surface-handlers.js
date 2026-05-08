'use strict';

const { getProjectRoot } = require('../../config');
const {
  LOCAL_TEXT_UI_CHANNEL,
  buildMiraLocalTextUiSurface,
} = require('../mira-local-text-ui-surface');

async function buildMiraLocalTextUiSurfaceResponse(payload = {}, options = {}) {
  return buildMiraLocalTextUiSurface(payload, {
    ...options,
    projectRoot: options.projectRoot || getProjectRoot(),
  });
}

function registerMiraLocalTextUiSurfaceHandlers(ctx, deps = {}) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerMiraLocalTextUiSurfaceHandlers requires ctx.ipcMain');
  }
  const ipcMain = ctx.ipcMain;
  ipcMain.handle(LOCAL_TEXT_UI_CHANNEL, (_event, payload = {}) =>
    buildMiraLocalTextUiSurfaceResponse(payload, deps));
}

function unregisterMiraLocalTextUiSurfaceHandlers(ctx) {
  const ipcMain = ctx && ctx.ipcMain;
  if (!ipcMain || typeof ipcMain.removeHandler !== 'function') return;
  ipcMain.removeHandler(LOCAL_TEXT_UI_CHANNEL);
}

registerMiraLocalTextUiSurfaceHandlers.unregister = unregisterMiraLocalTextUiSurfaceHandlers;

module.exports = {
  LOCAL_TEXT_UI_CHANNEL,
  buildMiraLocalTextUiSurfaceResponse,
  registerMiraLocalTextUiSurfaceHandlers,
  unregisterMiraLocalTextUiSurfaceHandlers,
};
