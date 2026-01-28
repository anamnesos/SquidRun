/**
 * State IPC Handlers
 * Channels: get-state, set-state, trigger-sync, broadcast-message, start-planning
 */

function registerStateHandlers(ctx) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerStateHandlers requires ctx.ipcMain');
  }

  const { ipcMain } = ctx;
  const missingDependency = (name, fallback = {}) => ({
    success: false,
    error: `${name} not available`,
    ...fallback,
  });

  const getWatcher = () => {
    const watcher = ctx.watcher;
    if (!watcher) {
      return { ok: false, error: 'state watcher' };
    }
    return { ok: true, watcher };
  };

  const getTriggers = () => {
    const triggers = ctx.triggers;
    if (!triggers) {
      return { ok: false, error: 'triggers' };
    }
    return { ok: true, triggers };
  };

  ipcMain.handle('get-state', () => {
    const { ok, watcher } = getWatcher();
    if (!ok) {
      return missingDependency('state watcher', { state: 'idle', agent_claims: {} });
    }
    return watcher.readState();
  });

  ipcMain.handle('set-state', (event, newState) => {
    const { ok, watcher, error } = getWatcher();
    if (!ok) {
      return missingDependency(error);
    }
    watcher.transition(newState);
    return watcher.readState();
  });

  ipcMain.handle('trigger-sync', (event, file = 'shared_context.md') => {
    const { ok, triggers, error } = getTriggers();
    if (!ok) {
      return missingDependency(error);
    }
    triggers.notifyAllAgentsSync(file);
    return { success: true, file };
  });

  ipcMain.handle('broadcast-message', (event, message) => {
    const { ok, triggers, error } = getTriggers();
    if (!ok) {
      return missingDependency(error);
    }
    return triggers.broadcastToAllAgents(message);
  });

  ipcMain.handle('start-planning', (event, project) => {
    const { ok, watcher, error } = getWatcher();
    if (!ok) {
      return missingDependency(error);
    }
    if (!watcher.States || !watcher.States.PLANNING) {
      return missingDependency('state definitions');
    }
    const state = watcher.readState();
    state.project = project;
    watcher.writeState(state);
    watcher.transition(watcher.States.PLANNING);
    return watcher.readState();
  });
}

module.exports = { registerStateHandlers };
