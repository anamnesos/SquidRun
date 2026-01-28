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

module.exports = { registerAgentClaimsHandlers };
