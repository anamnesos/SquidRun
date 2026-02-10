/**
 * Conflict Detection IPC Handlers
 * Channels: get-file-conflicts, check-file-conflicts
 */

function registerConflictDetectionHandlers(ctx) {
  const { ipcMain } = ctx;

  ipcMain.handle('get-file-conflicts', () => ctx.watcher.getLastConflicts());
  ipcMain.handle('check-file-conflicts', () => ctx.watcher.checkFileConflicts());
}


function unregisterConflictDetectionHandlers(ctx) {
  const { ipcMain } = ctx || {};
  if (!ipcMain) return;
    ipcMain.removeHandler('get-file-conflicts');
    ipcMain.removeHandler('check-file-conflicts');
}

registerConflictDetectionHandlers.unregister = unregisterConflictDetectionHandlers;
module.exports = { registerConflictDetectionHandlers };
