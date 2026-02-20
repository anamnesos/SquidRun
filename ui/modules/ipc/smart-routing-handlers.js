/**
 * Smart Routing IPC Handlers
 * Channels: route-task, get-best-agent, get-agent-roles
 */

const log = require('../logger');
const { createPerformanceLoader } = require('../performance-data');

function registerSmartRoutingHandlers(ctx) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerSmartRoutingHandlers requires ctx.ipcMain');
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

  const loadPerformance = createPerformanceLoader({
    workspacePath: ctx.WORKSPACE_PATH,
    log,
    logScope: 'Smart Routing',
    logMessage: 'Error loading performance:',
  });

  ipcMain.handle('route-task', async (event, taskType, message) => {
    const { ok, triggers, error } = getTriggers();
    if (!ok) {
      return missingDependency(error);
    }
    if (typeof triggers.routeTask !== 'function') {
      return missingDependency('triggers.routeTask');
    }
    const perf = await loadPerformance();
    return triggers.routeTask(taskType, message, perf);
  });

  ipcMain.handle('get-best-agent', async (event, taskType) => {
    const { ok, triggers, error } = getTriggers();
    if (!ok) {
      return missingDependency(error);
    }
    if (typeof triggers.getBestAgent !== 'function') {
      return missingDependency('triggers.getBestAgent');
    }
    const perf = await loadPerformance();
    return triggers.getBestAgent(taskType, perf);
  });

  ipcMain.handle('get-agent-roles', () => {
    const { ok, triggers, error } = getTriggers();
    if (!ok) {
      return missingDependency(error);
    }
    return triggers.AGENT_ROLES || {};
  });
}


function unregisterSmartRoutingHandlers(ctx) {
  const { ipcMain } = ctx || {};
  if (!ipcMain) return;
    ipcMain.removeHandler('route-task');
    ipcMain.removeHandler('get-best-agent');
    ipcMain.removeHandler('get-agent-roles');
}

registerSmartRoutingHandlers.unregister = unregisterSmartRoutingHandlers;
module.exports = { registerSmartRoutingHandlers };
