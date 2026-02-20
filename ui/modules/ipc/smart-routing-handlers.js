/**
 * Smart Routing IPC Handlers
 * Channels: route-task, get-best-agent, get-agent-roles
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const log = require('../logger');

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

  const workspacePath = ctx.WORKSPACE_PATH;
  const PERFORMANCE_FILE_PATH = workspacePath
    ? path.join(workspacePath, 'performance.json')
    : null;

  const DEFAULT_PERFORMANCE = {
    agents: {
      '1': { completions: 0, errors: 0, totalResponseTime: 0, responseCount: 0 },
      '2': { completions: 0, errors: 0, totalResponseTime: 0, responseCount: 0 },
      '3': { completions: 0, errors: 0, totalResponseTime: 0, responseCount: 0 },
    },
    lastUpdated: null,
  };

  async function loadPerformance() {
    if (!PERFORMANCE_FILE_PATH) {
      return { ...DEFAULT_PERFORMANCE };
    }
    try {
      await fsp.access(PERFORMANCE_FILE_PATH, fs.constants.F_OK);
      const content = await fsp.readFile(PERFORMANCE_FILE_PATH, 'utf-8');
      return { ...DEFAULT_PERFORMANCE, ...JSON.parse(content) };
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        return { ...DEFAULT_PERFORMANCE };
      }
      log.error('Smart Routing', 'Error loading performance:', err.message);
    }
    return { ...DEFAULT_PERFORMANCE };
  }

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
