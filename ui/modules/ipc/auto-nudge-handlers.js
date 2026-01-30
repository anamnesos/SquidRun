/**
 * Auto-Nudge and Health Monitoring IPC Handlers
 * Channels: nudge-agent, nudge-all-stuck, nudge-pane, restart-pane,
 *           restart-all-panes, get-agent-health
 */

const log = require('../logger');

function registerAutoNudgeHandlers(ctx, deps) {
  const { ipcMain } = ctx;
  const getRecoveryManager = () => deps?.recoveryManager || ctx.recoveryManager;

  // Task #29: Get agent health data for Health tab
  ipcMain.handle('get-agent-health', () => {
    if (!ctx.daemonClient || !ctx.daemonClient.connected) {
      return { success: false, error: 'Daemon not connected' };
    }

    const agents = {};
    const recoveryStatus = getRecoveryManager()?.getStatus?.() || {};

    for (let i = 1; i <= 6; i++) {
      const paneId = String(i);
      const status = ctx.claudeRunning?.get(paneId) || 'unknown';
      const lastActivity = ctx.daemonClient.getLastActivity?.(paneId);
      const terminal = ctx.daemonClient.terminals?.get(paneId);
      const recovery = recoveryStatus[paneId];
      const recoveryStep = recovery?.recoveryStep
        || (recovery?.status === 'restarting' ? 'restart' : recovery?.status === 'stuck' ? 'interrupt' : 'none');
      const recovering = recovery?.status === 'restarting' || recovery?.status === 'stuck';

      agents[paneId] = {
        alive: status === 'running',
        status,
        lastActivity: lastActivity || null,
        lastOutput: lastActivity || null,
        stuckCount: recovery?.stuckCount ?? terminal?.stuckCount ?? 0,
        recoveryStep,
        recovering
      };
    }

    return { success: true, agents };
  });

  // Task #29: Nudge single pane (simple Enter)
  ipcMain.handle('nudge-pane', (event, paneId) => {
    if (!ctx.daemonClient || !ctx.daemonClient.connected) {
      return { success: false, error: 'Daemon not connected' };
    }

    if (!paneId) {
      return { success: false, error: 'paneId required' };
    }

    // Send to renderer to use sendToPane (handles focus + keyboard Enter)
    if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
      ctx.mainWindow.webContents.send('nudge-pane', { paneId });
    }

    log.info('Health', `Nudge sent to pane ${paneId}`);
    return { success: true, paneId };
  });

  // Task #29: Restart single pane
  ipcMain.handle('restart-pane', (event, paneId) => {
    if (!ctx.daemonClient || !ctx.daemonClient.connected) {
      return { success: false, error: 'Daemon not connected' };
    }

    if (!paneId) {
      return { success: false, error: 'paneId required' };
    }

    const recoveryManager = getRecoveryManager();
    if (recoveryManager?.markExpectedExit) {
      recoveryManager.markExpectedExit(paneId, 'manual-restart');
    }

    // Send to renderer to use restartPane (handles kill + respawn)
    if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
      ctx.mainWindow.webContents.send('restart-pane', { paneId });
    }

    log.info('Health', `Restart requested for pane ${paneId}`);
    return { success: true, paneId };
  });

  // Task #29: Restart all panes
  ipcMain.handle('restart-all-panes', () => {
    if (!ctx.daemonClient || !ctx.daemonClient.connected) {
      return { success: false, error: 'Daemon not connected' };
    }

    const recoveryManager = getRecoveryManager();
    if (recoveryManager?.markExpectedExit) {
      for (let i = 1; i <= 6; i++) {
        recoveryManager.markExpectedExit(String(i), 'manual-restart-all');
      }
    }

    // Send to renderer to trigger restart all
    if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
      ctx.mainWindow.webContents.send('restart-all-panes', {});
    }

    log.info('Health', 'Restart all panes requested');
    return { success: true };
  });

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
