const mcpBridge = require('../mcp-bridge');

function registerMcpHandlers(ctx) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerMcpHandlers requires ctx.ipcMain');
  }

  const { ipcMain } = ctx;

  ipcMain.handle('mcp-register-agent', (event, sessionId, paneId) => {
    return mcpBridge.registerAgent(sessionId, paneId);
  });

  ipcMain.handle('mcp-unregister-agent', (event, sessionId) => {
    return mcpBridge.unregisterAgent(sessionId);
  });

  ipcMain.handle('mcp-get-connected-agents', () => {
    return { success: true, agents: mcpBridge.getConnectedAgents() };
  });

  ipcMain.handle('mcp-tool-call', (event, sessionId, toolName, args) => {
    return mcpBridge.handleToolCall(sessionId, toolName, args);
  });

  ipcMain.handle('mcp-get-tool-definitions', () => {
    return { success: true, tools: mcpBridge.getMCPToolDefinitions() };
  });

  ipcMain.handle('mcp-validate-session', (event, sessionId) => {
    return mcpBridge.validateSession(sessionId);
  });

  ipcMain.handle('get-mcp-health', () => {
    return mcpBridge.getMCPHealth();
  });

  ipcMain.handle('get-mcp-status', () => {
    const health = mcpBridge.getMCPHealth();
    const agents = mcpBridge.getConnectedAgents();
    const status = {};

    for (const paneId of ctx.PANE_IDS) {
      const agent = agents.find(a => a.paneId === paneId);
      status[paneId] = {
        connected: !!agent,
        role: ctx.PANE_ROLES[paneId],
        lastSeen: agent?.lastSeen || null,
        connectedAt: agent?.connectedAt || null,
      };
    }

    return {
      success: true,
      status,
      health,
      connectedCount: agents.length,
    };
  });
}


function unregisterMcpHandlers(ctx) {
  const { ipcMain } = ctx || {};
  if (!ipcMain) return;
    ipcMain.removeHandler('mcp-register-agent');
    ipcMain.removeHandler('mcp-unregister-agent');
    ipcMain.removeHandler('mcp-get-connected-agents');
    ipcMain.removeHandler('mcp-tool-call');
    ipcMain.removeHandler('mcp-get-tool-definitions');
    ipcMain.removeHandler('mcp-validate-session');
    ipcMain.removeHandler('get-mcp-health');
    ipcMain.removeHandler('get-mcp-status');
}

registerMcpHandlers.unregister = unregisterMcpHandlers;
module.exports = {
  registerMcpHandlers,
};
