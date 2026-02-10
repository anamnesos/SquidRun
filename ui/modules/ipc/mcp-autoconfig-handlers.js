const path = require('path');
const { exec } = require('child_process');
const log = require('../logger');

const MCP_SERVER_PATH = path.join(__dirname, '..', 'mcp-server.js');

function registerMcpAutoconfigHandlers(ctx) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerMcpAutoconfigHandlers requires ctx.ipcMain');
  }

  const { ipcMain } = ctx;

  function configureAgent(paneId) {
    try {
      const serverName = `hivemind-${paneId}`;
      const serverCommand = `node "${MCP_SERVER_PATH}" --pane ${paneId}`;
      const configCmd = `claude mcp add ${serverName} --command "${serverCommand}"`;

      return new Promise((resolve) => {
        exec(configCmd, { timeout: 10000 }, (error) => {
          if (error) {
            log.error('MCP', `MCP config error for pane ${paneId}:`, error);
            ctx.mainWindow?.webContents.send('mcp-agent-error', {
              paneId,
              error: error.message || 'Configuration failed'
            });
            resolve({ success: false, error: error.message });
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
      const serverName = `hivemind-${paneId}`;
      const removeCmd = `claude mcp remove ${serverName}`;

      return new Promise((resolve) => {
        exec(removeCmd, { timeout: 10000 }, (error) => {
          if (error) {
            resolve({ success: false, error: error.message });
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
