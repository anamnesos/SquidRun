/**
 * Auto-Handoff IPC Handlers
 * Channels: trigger-handoff, get-handoff-chain
 */

function registerAutoHandoffHandlers(ctx) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerAutoHandoffHandlers requires ctx.ipcMain');
  }

  const { ipcMain } = ctx;

  ipcMain.handle('trigger-handoff', (event, fromPaneId, message) => {
    return ctx.triggers.triggerAutoHandoff(fromPaneId, message);
  });

  ipcMain.handle('get-handoff-chain', () => {
    return ctx.triggers.HANDOFF_CHAIN;
  });
}

module.exports = { registerAutoHandoffHandlers };
