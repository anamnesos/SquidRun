/**
 * Recovery IPC Handlers
 * Channels: get-recovery-status, get-health-snapshot, trigger-recovery,
 *           reset-recovery-circuit, get-recovery-playbooks,
 *           retry-recovery-task, record-recovery-task
 */

function registerRecoveryHandlers(ctx, deps) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerRecoveryHandlers requires ctx.ipcMain');
  }

  const { ipcMain } = ctx;
  const getManager = () => deps?.recoveryManager || ctx.recoveryManager;

  ipcMain.handle('get-recovery-status', () => {
    const manager = getManager();
    if (!manager) {
      return { success: false, error: 'Recovery manager unavailable' };
    }
    return { success: true, status: manager.getStatus() };
  });

  ipcMain.handle('get-health-snapshot', () => {
    const manager = getManager();
    if (!manager) {
      return { success: false, error: 'Recovery manager unavailable' };
    }
    return { success: true, snapshot: manager.getHealthSnapshot() };
  });

  ipcMain.handle('get-recovery-playbooks', () => {
    const manager = getManager();
    if (!manager) {
      return { success: false, error: 'Recovery manager unavailable' };
    }
    return { success: true, playbooks: manager.getPlaybooks() };
  });

  ipcMain.handle('trigger-recovery', (event, paneId, reason = 'manual') => {
    const manager = getManager();
    if (!manager) {
      return { success: false, error: 'Recovery manager unavailable' };
    }
    if (!paneId) {
      return { success: false, error: 'paneId required' };
    }
    manager.scheduleRestart(paneId, reason);
    return { success: true };
  });

  ipcMain.handle('reset-recovery-circuit', (event, paneId) => {
    const manager = getManager();
    if (!manager) {
      return { success: false, error: 'Recovery manager unavailable' };
    }
    if (!paneId) {
      return { success: false, error: 'paneId required' };
    }
    manager.resetCircuit(paneId);
    return { success: true };
  });

  ipcMain.handle('retry-recovery-task', (event, paneId, reason = 'manual') => {
    const manager = getManager();
    if (!manager) {
      return { success: false, error: 'Recovery manager unavailable' };
    }
    if (!paneId) {
      return { success: false, error: 'paneId required' };
    }
    if (typeof manager.scheduleTaskRetry !== 'function') {
      return { success: false, error: 'Task retry unavailable' };
    }
    manager.scheduleTaskRetry(paneId, reason);
    return { success: true };
  });

  ipcMain.handle('record-recovery-task', (event, paneId, message, meta = {}) => {
    const manager = getManager();
    if (!manager) {
      return { success: false, error: 'Recovery manager unavailable' };
    }
    if (!paneId || !message) {
      return { success: false, error: 'paneId and message required' };
    }
    if (typeof manager.recordTask === 'function') {
      manager.recordTask(paneId, message, meta);
    }
    return { success: true };
  });
}

function unregisterRecoveryHandlers(ctx) {
  const manager = ctx.recoveryManager;
  if (manager && typeof manager.stop === 'function') {
    manager.stop();
  }
  const { ipcMain } = ctx;
  if (ipcMain) {
    ipcMain.removeHandler('get-recovery-status');
    ipcMain.removeHandler('get-health-snapshot');
    ipcMain.removeHandler('get-recovery-playbooks');
    ipcMain.removeHandler('trigger-recovery');
    ipcMain.removeHandler('reset-recovery-circuit');
    ipcMain.removeHandler('retry-recovery-task');
    ipcMain.removeHandler('record-recovery-task');
  }
}

registerRecoveryHandlers.unregister = unregisterRecoveryHandlers;

module.exports = { registerRecoveryHandlers };
