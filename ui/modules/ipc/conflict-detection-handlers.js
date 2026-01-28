/**
 * Conflict Detection IPC Handlers
 * Channels: get-file-conflicts, check-file-conflicts
 */

function registerConflictDetectionHandlers(ctx) {
  const { ipcMain } = ctx;

  ipcMain.handle('get-file-conflicts', () => ctx.watcher.getLastConflicts());
  ipcMain.handle('check-file-conflicts', () => ctx.watcher.checkFileConflicts());
}

module.exports = { registerConflictDetectionHandlers };
