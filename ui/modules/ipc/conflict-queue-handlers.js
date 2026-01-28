/**
 * Conflict Queue IPC Handlers
 * Channels: request-file-access, release-file-access, get-conflict-queue-status, clear-all-locks
 */

function registerConflictQueueHandlers(ctx) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerConflictQueueHandlers requires ctx.ipcMain');
  }

  const { ipcMain } = ctx;

  ipcMain.handle('request-file-access', (event, filePath, paneId, operation) => {
    return ctx.watcher.requestFileAccess(filePath, paneId, operation);
  });

  ipcMain.handle('release-file-access', (event, filePath, paneId) => {
    return ctx.watcher.releaseFileAccess(filePath, paneId);
  });

  ipcMain.handle('get-conflict-queue-status', () => {
    return ctx.watcher.getConflictQueueStatus();
  });

  ipcMain.handle('clear-all-locks', () => {
    return ctx.watcher.clearAllLocks();
  });
}

module.exports = { registerConflictQueueHandlers };
