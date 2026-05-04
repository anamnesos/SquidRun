'use strict';

const { buildOwnedWorkSummary } = require('../owned-work-summary');

function registerOwnedWorkHandlers(ctx) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerOwnedWorkHandlers requires ctx.ipcMain');
  }

  ctx.ipcMain.handle('get-owned-work-summary', (_event, options = {}) => {
    return buildOwnedWorkSummary(options);
  });
}

function unregisterOwnedWorkHandlers(ctx) {
  const { ipcMain } = ctx || {};
  if (!ipcMain || typeof ipcMain.removeHandler !== 'function') return;
  ipcMain.removeHandler('get-owned-work-summary');
}

registerOwnedWorkHandlers.unregister = unregisterOwnedWorkHandlers;

module.exports = {
  registerOwnedWorkHandlers,
  unregisterOwnedWorkHandlers,
};
