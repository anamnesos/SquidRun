/**
 * Activity Log IPC Handlers
 * Channels: get-activity-log, clear-activity-log, save-activity-log, log-activity
 */

function registerActivityLogHandlers(ctx, deps = {}) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerActivityLogHandlers requires ctx.ipcMain');
  }

  const { ipcMain } = ctx;
  const { logActivity, getActivityLog, clearActivityLog, saveActivityLog } = deps;
  const missingDependency = (name, fallback = {}) => ({
    success: false,
    error: `${name} not available`,
    ...fallback,
  });

  ipcMain.handle('get-activity-log', (event, filter = {}) => {
    if (typeof getActivityLog !== 'function') {
      return missingDependency('activity log provider', { entries: [], total: 0 });
    }
    const log = getActivityLog(filter);
    return {
      success: true,
      entries: log,
      total: log.length,
    };
  });

  ipcMain.handle('clear-activity-log', () => {
    if (typeof clearActivityLog !== 'function') {
      return missingDependency('activity log provider');
    }
    clearActivityLog();
    console.log('[Activity] Log cleared');
    return { success: true };
  });

  ipcMain.handle('save-activity-log', () => {
    if (typeof saveActivityLog !== 'function') {
      return missingDependency('activity log provider');
    }
    saveActivityLog();
    return { success: true };
  });

  ipcMain.handle('log-activity', (event, type, paneId, message, details = {}) => {
    if (typeof logActivity !== 'function') {
      return missingDependency('activity log provider');
    }
    logActivity(type, paneId, message, details);
    return { success: true };
  });
}

module.exports = { registerActivityLogHandlers };
