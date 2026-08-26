/**
 * Backup IPC Handlers
 * Channels: backup-create, backup-list, backup-restore, backup-delete,
 *           backup-get-config, backup-update-config, backup-prune
 */

const backupModule = require('../backup-manager');
const { WORKSPACE_PATH } = require('../../config');
const path = require('path');

function registerBackupHandlers(ctx) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerBackupHandlers requires ctx.ipcMain');
  }

  const { ipcMain } = ctx;

  if (!ctx.backupManager) {
    ctx.backupManager = backupModule.createBackupManager({
      workspacePath: WORKSPACE_PATH,
      repoRoot: path.join(WORKSPACE_PATH, '..'),
      logActivity: ctx.logActivity,
    });
    ctx.backupManager.init();
  }

  ipcMain.handle('backup-list', () => {
    return { success: true, backups: ctx.backupManager.listBackups() };
  });

  ipcMain.handle('backup-create', (event, options = {}) => {
    return ctx.backupManager.createBackup(options);
  });

  ipcMain.handle('backup-restore', (event, backupId, options = {}) => {
    if (!backupId) return { success: false, error: 'backupId required' };
    return ctx.backupManager.restoreBackup(String(backupId), options);
  });

  ipcMain.handle('backup-delete', (event, backupId) => {
    if (!backupId) return { success: false, error: 'backupId required' };
    return ctx.backupManager.deleteBackup(String(backupId));
  });

  ipcMain.handle('backup-get-config', () => {
    return { success: true, config: ctx.backupManager.getConfig() };
  });

  ipcMain.handle('backup-update-config', (event, patch = {}) => {
    return { success: true, config: ctx.backupManager.updateConfig(patch) };
  });

  ipcMain.handle('backup-prune', () => {
    const removed = ctx.backupManager.pruneBackups();
    return { success: true, removed };
  });
}

function unregisterBackupHandlers(ctx) {
  if (ctx.backupManager) {
    ctx.backupManager.stop();
    ctx.backupManager = null;
  }
  const { ipcMain } = ctx;
  if (ipcMain) {
    ipcMain.removeHandler('backup-list');
    ipcMain.removeHandler('backup-create');
    ipcMain.removeHandler('backup-restore');
    ipcMain.removeHandler('backup-delete');
    ipcMain.removeHandler('backup-get-config');
    ipcMain.removeHandler('backup-update-config');
    ipcMain.removeHandler('backup-prune');
  }
}

registerBackupHandlers.unregister = unregisterBackupHandlers;

module.exports = { registerBackupHandlers };
