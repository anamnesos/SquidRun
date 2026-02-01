/**
 * Session History IPC Handlers
 * Channels: get-session-history
 */

const { formatDuration } = require('../formatters');

function registerSessionHistoryHandlers(ctx) {
  const { ipcMain, PANE_ROLES } = ctx;

  ipcMain.handle('get-session-history', (event, limit = 50) => {
    // formatDuration imported from ../formatters

    const history = (ctx.usageStats.history || [])
      .slice(-limit)
      .reverse()
      .map((entry, index) => ({
        id: `session-${index}`,
        pane: entry.pane,
        role: PANE_ROLES[entry.pane] || `Pane ${entry.pane}`,
        duration: entry.duration,
        durationFormatted: formatDuration(entry.duration),
        timestamp: entry.timestamp,
        date: new Date(entry.timestamp).toLocaleDateString(),
        time: new Date(entry.timestamp).toLocaleTimeString(),
      }));

    return {
      success: true,
      history,
      total: ctx.usageStats.history ? ctx.usageStats.history.length : 0,
    };
  });
}

module.exports = { registerSessionHistoryHandlers };
