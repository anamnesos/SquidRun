/**
 * State IPC Handlers
 * Channels: get-state, set-state, trigger-sync, broadcast-message, start-planning
 */

function registerStateHandlers(ctx) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerStateHandlers requires ctx.ipcMain');
  }

  const { ipcMain } = ctx;

  ipcMain.handle('get-state', () => {
    return ctx.watcher.readState();
  });

  ipcMain.handle('set-state', (event, newState) => {
    ctx.watcher.transition(newState);
    return ctx.watcher.readState();
  });

  ipcMain.handle('trigger-sync', (event, file = 'shared_context.md') => {
    ctx.triggers.notifyAllAgentsSync(file);
    return { success: true, file };
  });

  ipcMain.handle('broadcast-message', (event, message) => {
    return ctx.triggers.broadcastToAllAgents(message);
  });

  ipcMain.handle('start-planning', (event, project) => {
    const state = ctx.watcher.readState();
    state.project = project;
    ctx.watcher.writeState(state);
    ctx.watcher.transition(ctx.watcher.States.PLANNING);
    return ctx.watcher.readState();
  });
}

module.exports = { registerStateHandlers };
