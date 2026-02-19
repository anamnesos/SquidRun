const path = require('path');
const { execFile } = require('child_process');
const log = require('../logger');

const MCP_SERVER_PATH = path.join(__dirname, '..', 'mcp-server.js');

function runClaudeCommand(args = []) {
  return new Promise((resolve) => {
    execFile('claude', args, { timeout: 10000, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        if (error.stdout == null) error.stdout = stdout;
        if (error.stderr == null) error.stderr = stderr;
        resolve({ success: false, error });
        return;
      }
      resolve({ success: true, stdout, stderr });
    });
  });
}

function registerMcpAutoconfigHandlers(ctx) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerMcpAutoconfigHandlers requires ctx.ipcMain');
  }

  const { ipcMain } = ctx;

  function configureAgent(paneId) {
    try {
      const normalizedPaneId = String(paneId || '').trim();
      const serverName = `hivemind-${normalizedPaneId}`;
      const serverCommand = `node "${MCP_SERVER_PATH}" --pane ${normalizedPaneId}`;

      return new Promise((resolve) => {
        runClaudeCommand(['mcp', 'add', serverName, '--command', serverCommand]).then((result) => {
          if (!result.success) {
            log.error('MCP', `MCP config error for pane ${paneId}:`, result.error);
            ctx.mainWindow?.webContents.send('mcp-agent-error', {
              paneId,
              error: result.error.message || 'Configuration failed'
            });
            resolve({ success: false, error: result.error.message });
          } else {
            log.info('MCP', `MCP configured for pane ${paneId}`);
            ctx.mainWindow?.webContents.send('mcp-agent-connecting', { paneId });
            resolve({ success: true, paneId, serverName });
          }
        });
      });
    } catch (err) {
      log.error('MCP', 'MCP configure error:', err);
      return { success: false, error: err.message };
    }
  }

  ipcMain.handle('mcp-configure-agent', async (event, paneId) => {
    return configureAgent(paneId);
  });

  ipcMain.handle('mcp-reconnect-agent', async (event, paneId) => {
    try {
      return await configureAgent(paneId);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('mcp-remove-agent-config', async (event, paneId) => {
    try {
      const normalizedPaneId = String(paneId || '').trim();
      const serverName = `hivemind-${normalizedPaneId}`;

      return new Promise((resolve) => {
        runClaudeCommand(['mcp', 'remove', serverName]).then((result) => {
          if (!result.success) {
            resolve({ success: false, error: result.error.message });
          } else {
            ctx.mainWindow?.webContents.send('mcp-agent-disconnected', { paneId });
            resolve({ success: true, paneId });
          }
        });
      });
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
}


function unregisterMcpAutoconfigHandlers(ctx) {
  const { ipcMain } = ctx || {};
  if (!ipcMain) return;
    ipcMain.removeHandler('mcp-configure-agent');
    ipcMain.removeHandler('mcp-reconnect-agent');
    ipcMain.removeHandler('mcp-remove-agent-config');
}

registerMcpAutoconfigHandlers.unregister = unregisterMcpAutoconfigHandlers;
module.exports = {
  registerMcpAutoconfigHandlers,
};
