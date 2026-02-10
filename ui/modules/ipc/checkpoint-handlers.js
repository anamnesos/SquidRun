/**
 * Checkpoint IPC Handlers
 * Channels: create-checkpoint, list-checkpoints, get-checkpoint-diff, rollback-checkpoint, apply-rollback, delete-checkpoint
 */

const fs = require('fs');
const path = require('path');
const log = require('../logger');

function registerCheckpointHandlers(ctx) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerCheckpointHandlers requires ctx.ipcMain');
  }

  const { ipcMain, WORKSPACE_PATH } = ctx;
  const ROLLBACK_DIR = path.join(WORKSPACE_PATH, 'rollbacks');
  const MAX_CHECKPOINTS = 10;

  function ensureRollbackDir() {
    try {
      if (!fs.existsSync(ROLLBACK_DIR)) {
        fs.mkdirSync(ROLLBACK_DIR, { recursive: true });
      }
      return true;
    } catch (err) {
      log.error('Rollback', 'Failed to initialize rollback directory', err);
      return false;
    }
  }

  ipcMain.handle('create-checkpoint', (event, files, label = '') => {
    try {
      if (!ensureRollbackDir()) {
        return { success: false, error: 'Rollback directory unavailable' };
      }
      const checkpointId = `cp-${Date.now()}`;
      const checkpointDir = path.join(ROLLBACK_DIR, checkpointId);
      fs.mkdirSync(checkpointDir, { recursive: true });

      const manifest = {
        id: checkpointId,
        label: label || `Checkpoint ${new Date().toLocaleTimeString()}`,
        createdAt: new Date().toISOString(),
        files: [],
      };

      for (const filePath of files) {
        if (fs.existsSync(filePath)) {
          const content = fs.readFileSync(filePath, 'utf-8');
          const fileName = path.basename(filePath);
          const backupPath = path.join(checkpointDir, fileName);

          fs.writeFileSync(backupPath, content, 'utf-8');
          manifest.files.push({
            original: filePath,
            backup: backupPath,
            size: content.length,
          });
        }
      }

      fs.writeFileSync(
        path.join(checkpointDir, 'manifest.json'),
        JSON.stringify(manifest, null, 2),
        'utf-8'
      );

      const checkpoints = fs.readdirSync(ROLLBACK_DIR)
        .filter(d => d.startsWith('cp-'))
        .sort()
        .reverse();

      if (checkpoints.length > MAX_CHECKPOINTS) {
        for (const old of checkpoints.slice(MAX_CHECKPOINTS)) {
          const oldPath = path.join(ROLLBACK_DIR, old);
          fs.rmSync(oldPath, { recursive: true, force: true });
        }
      }

      log.info('Rollback', `Checkpoint created: ${checkpointId} (${manifest.files.length} files)`);

      return { success: true, checkpointId, files: manifest.files.length };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('list-checkpoints', () => {
    try {
      if (!ensureRollbackDir()) {
        return { success: false, error: 'Rollback directory unavailable', checkpoints: [] };
      }
      if (!fs.existsSync(ROLLBACK_DIR)) {
        return { success: true, checkpoints: [] };
      }

      const checkpoints = fs.readdirSync(ROLLBACK_DIR)
        .filter(d => d.startsWith('cp-'))
        .map(d => {
          const manifestPath = path.join(ROLLBACK_DIR, d, 'manifest.json');
          if (fs.existsSync(manifestPath)) {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
            return {
              id: manifest.id,
              label: manifest.label,
              createdAt: manifest.createdAt,
              fileCount: manifest.files.length,
            };
          }
          return null;
        })
        .filter(Boolean)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

      return { success: true, checkpoints };
    } catch (err) {
      return { success: false, error: err.message, checkpoints: [] };
    }
  });

  ipcMain.handle('get-checkpoint-diff', (event, checkpointId) => {
    try {
      if (!ensureRollbackDir()) {
        return { success: false, error: 'Rollback directory unavailable' };
      }
      const checkpointDir = path.join(ROLLBACK_DIR, checkpointId);
      const manifestPath = path.join(checkpointDir, 'manifest.json');

      if (!fs.existsSync(manifestPath)) {
        return { success: false, error: 'Checkpoint not found' };
      }

      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      const diffs = [];

      for (const file of manifest.files) {
        const backupContent = fs.existsSync(file.backup)
          ? fs.readFileSync(file.backup, 'utf-8')
          : null;
        const currentContent = fs.existsSync(file.original)
          ? fs.readFileSync(file.original, 'utf-8')
          : null;

        diffs.push({
          file: file.original,
          hasChanges: backupContent !== currentContent,
          backupSize: backupContent ? backupContent.length : 0,
          currentSize: currentContent ? currentContent.length : 0,
        });
      }

      return { success: true, checkpointId, diffs };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  function rollbackCheckpoint(checkpointId) {
    try {
      if (!ensureRollbackDir()) {
        return { success: false, error: 'Rollback directory unavailable' };
      }
      const checkpointDir = path.join(ROLLBACK_DIR, checkpointId);
      const manifestPath = path.join(checkpointDir, 'manifest.json');

      if (!fs.existsSync(manifestPath)) {
        return { success: false, error: 'Checkpoint not found' };
      }

      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      const restored = [];

      for (const file of manifest.files) {
        if (fs.existsSync(file.backup)) {
          const content = fs.readFileSync(file.backup, 'utf-8');
          fs.writeFileSync(file.original, content, 'utf-8');
          restored.push(file.original);
        }
      }

      log.info('Rollback', `Restored ${restored.length} files from ${checkpointId}`);

      if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
        ctx.mainWindow.webContents.send('rollback-complete', {
          checkpointId,
          restoredFiles: restored,
        });
      }

      return { success: true, checkpointId, restored, filesRestored: restored.length };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  ipcMain.handle('rollback-checkpoint', (event, checkpointId) => rollbackCheckpoint(checkpointId));
  ipcMain.handle('apply-rollback', (event, checkpointId) => rollbackCheckpoint(checkpointId));

  ipcMain.handle('delete-checkpoint', (event, checkpointId) => {
    try {
      if (!ensureRollbackDir()) {
        return { success: false, error: 'Rollback directory unavailable' };
      }
      const checkpointDir = path.join(ROLLBACK_DIR, checkpointId);

      if (!fs.existsSync(checkpointDir)) {
        return { success: false, error: 'Checkpoint not found' };
      }

      fs.rmSync(checkpointDir, { recursive: true, force: true });
      log.info('Rollback', `Deleted checkpoint: ${checkpointId}`);

      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
}


function unregisterCheckpointHandlers(ctx) {
  const { ipcMain } = ctx || {};
  if (!ipcMain) return;
    ipcMain.removeHandler('create-checkpoint');
    ipcMain.removeHandler('list-checkpoints');
    ipcMain.removeHandler('get-checkpoint-diff');
    ipcMain.removeHandler('rollback-checkpoint');
    ipcMain.removeHandler('apply-rollback');
    ipcMain.removeHandler('delete-checkpoint');
}

registerCheckpointHandlers.unregister = unregisterCheckpointHandlers;
module.exports = { registerCheckpointHandlers };
