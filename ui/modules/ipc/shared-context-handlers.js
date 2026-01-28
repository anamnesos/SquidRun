/**
 * Shared Context IPC Handlers
 * Channels: read-shared-context, write-shared-context, get-shared-context-path
 */

const fs = require('fs');
const path = require('path');

function registerSharedContextHandlers(ctx) {
  const { ipcMain, SHARED_CONTEXT_PATH } = ctx;

  ipcMain.handle('read-shared-context', () => {
    try {
      if (fs.existsSync(SHARED_CONTEXT_PATH)) {
        const content = fs.readFileSync(SHARED_CONTEXT_PATH, 'utf-8');
        return { success: true, content };
      }
      return { success: false, error: 'File not found' };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('write-shared-context', (event, content) => {
    try {
      const dir = path.dirname(SHARED_CONTEXT_PATH);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(SHARED_CONTEXT_PATH, content, 'utf-8');
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('get-shared-context-path', () => {
    return SHARED_CONTEXT_PATH;
  });
}

module.exports = { registerSharedContextHandlers };
