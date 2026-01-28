/**
 * Smart Routing IPC Handlers
 * Channels: route-task, get-best-agent, get-agent-roles
 */

const fs = require('fs');
const path = require('path');

function registerSmartRoutingHandlers(ctx) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerSmartRoutingHandlers requires ctx.ipcMain');
  }

  const { ipcMain, WORKSPACE_PATH } = ctx;
  const PERFORMANCE_FILE_PATH = path.join(WORKSPACE_PATH, 'performance.json');

  const DEFAULT_PERFORMANCE = {
    agents: {
      '1': { completions: 0, errors: 0, totalResponseTime: 0, responseCount: 0 },
      '2': { completions: 0, errors: 0, totalResponseTime: 0, responseCount: 0 },
      '3': { completions: 0, errors: 0, totalResponseTime: 0, responseCount: 0 },
      '4': { completions: 0, errors: 0, totalResponseTime: 0, responseCount: 0 },
    },
    lastUpdated: null,
  };

  function loadPerformance() {
    try {
      if (fs.existsSync(PERFORMANCE_FILE_PATH)) {
        const content = fs.readFileSync(PERFORMANCE_FILE_PATH, 'utf-8');
        return { ...DEFAULT_PERFORMANCE, ...JSON.parse(content) };
      }
    } catch (err) {
      console.error('[Performance] Error loading:', err.message);
    }
    return { ...DEFAULT_PERFORMANCE };
  }

  ipcMain.handle('route-task', (event, taskType, message) => {
    const perf = loadPerformance();
    return ctx.triggers.routeTask(taskType, message, perf);
  });

  ipcMain.handle('get-best-agent', (event, taskType) => {
    const perf = loadPerformance();
    return ctx.triggers.getBestAgent(taskType, perf);
  });

  ipcMain.handle('get-agent-roles', () => {
    return ctx.triggers.AGENT_ROLES;
  });
}

module.exports = { registerSmartRoutingHandlers };
