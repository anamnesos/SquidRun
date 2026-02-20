/**
 * Task Parser IPC Handlers
 * Channels: parse-task-input, route-task-input
 */

const log = require('../logger');
const taskParser = require('../task-parser');
const { createPerformanceLoader } = require('../performance-data');

function registerTaskParserHandlers(ctx) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerTaskParserHandlers requires ctx.ipcMain');
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
    logScope: 'TaskParser',
    logMessage: 'Error loading performance:',
  });

  ipcMain.handle('parse-task-input', (event, input) => {
    const parsed = taskParser.parseTaskInput(input);
    if (!parsed.success) {
      return parsed;
    }
    return {
      success: true,
      ...parsed,
    };
  });

  ipcMain.handle('route-task-input', async (event, input, options = {}) => {
    const { ok, triggers, error } = getTriggers();
    if (!ok) {
      return missingDependency(error);
    }
    if (typeof triggers.routeTask !== 'function') {
      return missingDependency('triggers.routeTask');
    }

    const parsed = taskParser.parseTaskInput(input);
    if (!parsed.success) {
      return parsed;
    }

    if (parsed.ambiguity?.isAmbiguous && !options.force) {
      return {
        success: false,
        reason: 'ambiguous',
        ambiguity: parsed.ambiguity,
        subtasks: parsed.subtasks,
      };
    }

    const performance = await loadPerformance();
    const routed = [];
    let allSuccess = true;

    for (const task of parsed.subtasks) {
      const result = triggers.routeTask(task.taskType, task.text, performance);
      routed.push({
        ...task,
        routing: result,
      });
      if (!result.success) {
        allSuccess = false;
      }
    }

    return {
      success: allSuccess,
      routed,
      ambiguity: parsed.ambiguity,
    };
  });
}

function unregisterTaskParserHandlers(ctx) {
  const { ipcMain } = ctx;
  if (ipcMain) {
    ipcMain.removeHandler('parse-task-input');
    ipcMain.removeHandler('route-task-input');
  }
}

registerTaskParserHandlers.unregister = unregisterTaskParserHandlers;

module.exports = { registerTaskParserHandlers };
