/**
 * Agent Claims IPC Handlers
 * Channels: claim-agent, release-agent, get-claims, clear-claims
 */

function registerAgentClaimsHandlers(ctx) {
  const { ipcMain } = ctx;

  ipcMain.handle('claim-agent', (event, paneId, taskId, description) => {
    return ctx.watcher.claimAgent(paneId, taskId, description);
  });

  ipcMain.handle('release-agent', (event, paneId) => {
    return ctx.watcher.releaseAgent(paneId);
  });

  ipcMain.handle('get-claims', () => {
    return ctx.watcher.getClaims();
  });

  ipcMain.handle('clear-claims', () => {
    return ctx.watcher.clearClaims();
  });
}


function unregisterAgentClaimsHandlers(ctx) {
  const { ipcMain } = ctx || {};
  if (!ipcMain) return;
    ipcMain.removeHandler('claim-agent');
    ipcMain.removeHandler('release-agent');
    ipcMain.removeHandler('get-claims');
    ipcMain.removeHandler('clear-claims');
}

registerAgentClaimsHandlers.unregister = unregisterAgentClaimsHandlers;
module.exports = { registerAgentClaimsHandlers };
