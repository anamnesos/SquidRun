'use strict';

const {
  queryShellV2TodayJournal,
  readTodayFullMessage,
} = require('../main/shell-v2-today-journal');

const SHELL_V2_TODAY_CHANNELS = Object.freeze([
  'shell-v2:today-journal',
  'shell-v2:today-full-message',
]);

function registerShellV2TodayHandlers(ctx, deps = {}) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerShellV2TodayHandlers requires ctx.ipcMain');
  }

  ctx.ipcMain.handle('shell-v2:today-journal', (_event, payload = {}) => (
    queryShellV2TodayJournal(payload, deps)
  ));
  ctx.ipcMain.handle('shell-v2:today-full-message', (_event, payload = {}) => (
    readTodayFullMessage(payload, deps)
  ));
}

function unregisterShellV2TodayHandlers(ctx) {
  const { ipcMain } = ctx || {};
  if (!ipcMain || typeof ipcMain.removeHandler !== 'function') return;
  for (const channel of SHELL_V2_TODAY_CHANNELS) {
    ipcMain.removeHandler(channel);
  }
}

registerShellV2TodayHandlers.unregister = unregisterShellV2TodayHandlers;

module.exports = {
  SHELL_V2_TODAY_CHANNELS,
  registerShellV2TodayHandlers,
  unregisterShellV2TodayHandlers,
};
