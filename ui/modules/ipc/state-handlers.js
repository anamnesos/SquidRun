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

  const getWatcher = (required = []) => {
    const watcher = ctx.watcher;
    if (!watcher) {
      return { ok: false, error: 'state watcher' };
    }
    for (const fn of required) {
      if (typeof watcher[fn] !== 'function') {
        return { ok: false, error: `state watcher.${fn}` };
      }
    }
    return { ok: true, watcher };
  };

  const getTriggers = (required = []) => {
    const triggers = ctx.triggers;
    if (!triggers) {
      return { ok: false, error: 'triggers' };
    }
    for (const fn of required) {
      if (typeof triggers[fn] !== 'function') {
        return { ok: false, error: `triggers.${fn}` };
      }
    }
    return { ok: true, triggers };
  };

  ipcMain.handle('get-state', () => {
    const { ok, watcher } = getWatcher(['readState']);
    if (!ok) {
      return missingDependency('state watcher', { state: 'idle', agent_claims: {} });
    }
    return watcher.readState();
  });

  ipcMain.handle('set-state', (event, newState) => {
    const { ok, watcher, error } = getWatcher(['transition', 'readState']);
    if (!ok) {
      return missingDependency(error);
    }
    watcher.transition(newState);
    return watcher.readState();
  });

  ipcMain.handle('trigger-sync', (event, file = 'shared_context.md') => {
    const { ok, triggers, error } = getTriggers(['notifyAllAgentsSync']);
    if (!ok) {
      return missingDependency(error);
    }
    triggers.notifyAllAgentsSync(file);
    return { success: true, file };
  });

  ipcMain.handle('broadcast-message', (event, message) => {
    const { ok, triggers, error } = getTriggers(['broadcastToAllAgents']);
    if (!ok) {
      return missingDependency(error);
    }
    return triggers.broadcastToAllAgents(message);
  });

  ipcMain.handle('start-planning', (event, project) => {
    const { ok, watcher, error } = getWatcher(['readState', 'writeState', 'transition']);
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

  // P2-5: Get message sequence state for Inspector
  ipcMain.handle('get-message-state', () => {
    const { ok, triggers, error } = getTriggers(['getSequenceState']);
    if (!ok) {
      return missingDependency(error);
    }
    return { success: true, state: triggers.getSequenceState() };
  });

  // Task #8: Get reliability analytics
  ipcMain.handle('get-reliability-stats', () => {
    const { ok, triggers, error } = getTriggers(['getReliabilityStats']);
    if (!ok) {
      return missingDependency(error);
    }
    return { success: true, stats: triggers.getReliabilityStats() };
  });
}

function unregisterStateHandlers(ctx) {
  const { ipcMain } = ctx;
  if (ipcMain) {
    ipcMain.removeHandler('get-state');
    ipcMain.removeHandler('set-state');
    ipcMain.removeHandler('trigger-sync');
    ipcMain.removeHandler('broadcast-message');
    ipcMain.removeHandler('start-planning');
    ipcMain.removeHandler('get-message-state');
    ipcMain.removeHandler('get-reliability-stats');
  }
}

registerStateHandlers.unregister = unregisterStateHandlers;

module.exports = { registerStateHandlers };
