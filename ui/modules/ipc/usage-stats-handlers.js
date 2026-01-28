/**
 * Usage Stats IPC Handlers
 * Channels: get-usage-stats, reset-usage-stats
 */

const log = require('../logger');

function registerUsageStatsHandlers(ctx, deps) {
  const { ipcMain } = ctx;
  const { saveUsageStats } = deps;

  ipcMain.handle('get-usage-stats', () => {
    const formatDuration = (ms) => {
      const seconds = Math.floor(ms / 1000);
      const minutes = Math.floor(seconds / 60);
      const hours = Math.floor(minutes / 60);
      if (hours > 0) return `${hours}h ${minutes % 60}m`;
      if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
      return `${seconds}s`;
    };

    const COST_PER_MINUTE = 0.05;
    const totalMinutes = ctx.usageStats.totalSessionTimeMs / 60000;
    const estimatedCost = totalMinutes * COST_PER_MINUTE;
    const costStr = estimatedCost.toFixed(2);

    if (ctx.currentSettings.costAlertEnabled && !ctx.costAlertSent) {
      const threshold = ctx.currentSettings.costAlertThreshold || 5.00;
      if (parseFloat(costStr) >= threshold) {
        ctx.costAlertSent = true;
        log.info('Cost Alert', `Threshold exceeded: $${costStr} >= $${threshold}`);
        if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
          ctx.mainWindow.webContents.send('cost-alert', {
            cost: costStr,
            threshold: threshold,
            message: `Cost alert: Session cost ($${costStr}) has exceeded your threshold ($${threshold.toFixed(2)})`
          });
        }
      }
    }

    return {
      totalSpawns: ctx.usageStats.totalSpawns,
      spawnsPerPane: ctx.usageStats.spawnsPerPane,
      totalSessionTime: formatDuration(ctx.usageStats.totalSessionTimeMs),
      totalSessionTimeMs: ctx.usageStats.totalSessionTimeMs,
      sessionTimePerPane: Object.fromEntries(
        Object.entries(ctx.usageStats.sessionTimePerPane).map(([k, v]) => [k, formatDuration(v)])
      ),
      sessionsToday: ctx.usageStats.sessionsToday,
      lastResetDate: ctx.usageStats.lastResetDate,
      estimatedCost: costStr,
      estimatedCostPerPane: Object.fromEntries(
        Object.entries(ctx.usageStats.sessionTimePerPane).map(([k, v]) => [k, ((v / 60000) * COST_PER_MINUTE).toFixed(2)])
      ),
      recentSessions: ctx.usageStats.history.slice(-10).map(s => ({
        ...s,
        durationFormatted: formatDuration(s.duration),
      })),
      costAlertEnabled: ctx.currentSettings.costAlertEnabled,
      costAlertThreshold: ctx.currentSettings.costAlertThreshold,
      costAlertSent: ctx.costAlertSent,
    };
  });

  ipcMain.handle('reset-usage-stats', () => {
    ctx.usageStats.totalSpawns = 0;
    ctx.usageStats.spawnsPerPane = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0, '6': 0 };
    ctx.usageStats.totalSessionTimeMs = 0;
    ctx.usageStats.sessionTimePerPane = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0, '6': 0 };
    ctx.usageStats.sessionsToday = 0;
    ctx.usageStats.lastResetDate = new Date().toISOString().split('T')[0];
    ctx.usageStats.history = [];
    ctx.costAlertSent = false;
    saveUsageStats();
    return { success: true };
  });
}

module.exports = { registerUsageStatsHandlers };
