/**
 * Auto-Handoff IPC Handlers
 * Channels: trigger-handoff, get-handoff-chain
 */

function registerAutoHandoffHandlers(ctx) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerAutoHandoffHandlers requires ctx.ipcMain');
  }

  const { ipcMain } = ctx;
  const missingDependency = (name) => ({
    success: false,
    error: `${name} not available`,
  });

  const getTriggers = () => {
    const triggers = ctx.triggers;
    if (!triggers) {
      return { ok: false, error: 'triggers' };
    }
    return { ok: true, triggers };
  };

  ipcMain.handle('trigger-handoff', (event, fromPaneId, message) => {
    const { ok, triggers, error } = getTriggers();
    if (!ok) {
      return missingDependency(error);
    }
    if (typeof triggers.triggerAutoHandoff !== 'function') {
      return missingDependency('triggers.triggerAutoHandoff');
    }
    return triggers.triggerAutoHandoff(fromPaneId, message);
  });

  ipcMain.handle('get-handoff-chain', () => {
    const { ok, triggers, error } = getTriggers();
    if (!ok) {
      return missingDependency(error);
    }
    return triggers.HANDOFF_CHAIN || [];
  });
}


function unregisterAutoHandoffHandlers(ctx) {
  const { ipcMain } = ctx || {};
  if (!ipcMain) return;
    ipcMain.removeHandler('trigger-handoff');
    ipcMain.removeHandler('get-handoff-chain');
}

registerAutoHandoffHandlers.unregister = unregisterAutoHandoffHandlers;
module.exports = { registerAutoHandoffHandlers };
