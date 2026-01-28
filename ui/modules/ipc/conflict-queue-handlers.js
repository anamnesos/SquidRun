/**
 * Conflict Queue IPC Handlers
 * Channels: request-file-access, release-file-access, get-conflict-queue-status, clear-all-locks
 */

function registerConflictQueueHandlers(ctx) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerConflictQueueHandlers requires ctx.ipcMain');
  }

  const { ipcMain } = ctx;
  const missingDependency = (name) => ({
    success: false,
    error: `${name} not available`,
  });

  const getWatcher = () => {
    const watcher = ctx.watcher;
    if (!watcher) {
      return { ok: false, error: 'state watcher' };
    }
    return { ok: true, watcher };
  };

  ipcMain.handle('request-file-access', (event, filePath, paneId, operation) => {
    const { ok, watcher, error } = getWatcher();
    if (!ok) {
      return missingDependency(error);
    }
    return watcher.requestFileAccess(filePath, paneId, operation);
  });

  ipcMain.handle('release-file-access', (event, filePath, paneId) => {
    const { ok, watcher, error } = getWatcher();
    if (!ok) {
      return missingDependency(error);
    }
    return watcher.releaseFileAccess(filePath, paneId);
  });

  ipcMain.handle('get-conflict-queue-status', () => {
    const { ok, watcher, error } = getWatcher();
    if (!ok) {
      return missingDependency(error);
    }
    return watcher.getConflictQueueStatus();
  });

  ipcMain.handle('clear-all-locks', () => {
    const { ok, watcher, error } = getWatcher();
    if (!ok) {
      return missingDependency(error);
    }
    return watcher.clearAllLocks();
  });
}

module.exports = { registerConflictQueueHandlers };
