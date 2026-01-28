/**
 * Auto-Nudge IPC Handlers
 * Channels: nudge-agent, nudge-all-stuck
 */

const log = require('../logger');

function registerAutoNudgeHandlers(ctx) {
  const { ipcMain } = ctx;

  ipcMain.handle('nudge-agent', (event, paneId, message) => {
    if (!ctx.daemonClient || !ctx.daemonClient.connected) {
      return { success: false, error: 'Daemon not connected' };
    }

    const nudgeMessage = message || '[HIVEMIND] Are you still working? Please respond with your current status.';

    if (ctx.claudeRunning.get(paneId) !== 'running') {
      return { success: false, error: 'Agent not running in this pane' };
    }

    if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
      ctx.mainWindow.webContents.send('inject-message', {
        panes: [paneId],
        message: nudgeMessage + '\r'
      });
    }

    log.info('Auto-Nudge', `Sent to pane ${paneId}: ${nudgeMessage.substring(0, 50)}...`);

    return { success: true, pane: paneId };
  });

  ipcMain.handle('nudge-all-stuck', () => {
    const stuckThreshold = ctx.currentSettings.stuckThreshold || 60000;
    const now = Date.now();
    const nudged = [];

    for (const [paneId, status] of ctx.claudeRunning) {
      if (status === 'running') {
        const lastActivity = ctx.daemonClient.getLastActivity(paneId);
        if (lastActivity && (now - lastActivity) > stuckThreshold) {
          if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
            ctx.mainWindow.webContents.send('inject-message', {
              panes: [paneId],
              message: '[HIVEMIND] No activity detected. Please respond with your current status.\r'
            });
          }
          nudged.push(paneId);
        }
      }
    }

    log.info('Auto-Nudge', `Nudged ${nudged.length} stuck agents: ${nudged.join(', ')}`);
    return { success: true, nudged };
  });
}

module.exports = { registerAutoNudgeHandlers };
