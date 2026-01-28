/**
 * Friction Panel IPC Handlers
 * Channels: list-friction, read-friction, delete-friction, clear-friction
 */

const fs = require('fs');
const path = require('path');

function registerFrictionHandlers(ctx) {
  const { ipcMain, FRICTION_DIR } = ctx;

  ipcMain.handle('list-friction', () => {
    try {
      if (!fs.existsSync(FRICTION_DIR)) {
        fs.mkdirSync(FRICTION_DIR, { recursive: true });
        return { success: true, files: [] };
      }

      const files = fs.readdirSync(FRICTION_DIR)
        .filter(f => f.endsWith('.md'))
        .map(f => {
          const filePath = path.join(FRICTION_DIR, f);
          const stats = fs.statSync(filePath);
          return {
            name: f,
            path: filePath,
            modified: stats.mtime.toISOString(),
          };
        })
        .sort((a, b) => new Date(b.modified) - new Date(a.modified));

      return { success: true, files };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('read-friction', (event, filename) => {
    try {
      const filePath = path.join(FRICTION_DIR, filename);
      if (!fs.existsSync(filePath)) {
        return { success: false, error: 'File not found' };
      }
      const content = fs.readFileSync(filePath, 'utf-8');
      return { success: true, content };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('delete-friction', (event, filename) => {
    try {
      const filePath = path.join(FRICTION_DIR, filename);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('clear-friction', () => {
    try {
      if (fs.existsSync(FRICTION_DIR)) {
        const files = fs.readdirSync(FRICTION_DIR).filter(f => f.endsWith('.md'));
        for (const f of files) {
          fs.unlinkSync(path.join(FRICTION_DIR, f));
        }
      }
      const state = ctx.watcher.readState();
      state.friction_count = 0;
      ctx.watcher.writeState(state);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
}

module.exports = { registerFrictionHandlers };
