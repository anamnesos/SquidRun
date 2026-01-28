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

  ipcMain.handle('get-activity-log', (event, filter = {}) => {
    const log = getActivityLog(filter);
    return {
      success: true,
      entries: log,
      total: log.length,
    };
  });

  ipcMain.handle('clear-activity-log', () => {
    clearActivityLog();
    console.log('[Activity] Log cleared');
    return { success: true };
  });

  ipcMain.handle('save-activity-log', () => {
    saveActivityLog();
    return { success: true };
  });

  ipcMain.handle('log-activity', (event, type, paneId, message, details = {}) => {
    logActivity(type, paneId, message, details);
    return { success: true };
  });
}

module.exports = { registerActivityLogHandlers };
