/**
 * Session History IPC Handlers
 * Channels: get-session-history
 */

function registerSessionHistoryHandlers(ctx) {
  const { ipcMain, PANE_ROLES } = ctx;

  ipcMain.handle('get-session-history', (event, limit = 50) => {
    const formatDuration = (ms) => {
      const seconds = Math.floor(ms / 1000);
      const minutes = Math.floor(seconds / 60);
      const hours = Math.floor(minutes / 60);
      if (hours > 0) return `${hours}h ${minutes % 60}m`;
      if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
      return `${seconds}s`;
    };

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
