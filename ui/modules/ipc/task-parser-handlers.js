/**
 * Task Parser IPC Handlers
 * Channels: parse-task-input, route-task-input
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const log = require('../logger');
const taskParser = require('../task-parser');

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

  const workspacePath = ctx.WORKSPACE_PATH;
  const PERFORMANCE_FILE_PATH = workspacePath
    ? path.join(workspacePath, 'performance.json')
    : null;

  const DEFAULT_PERFORMANCE = {
    agents: {
      '1': { completions: 0, errors: 0, totalResponseTime: 0, responseCount: 0 },
      '2': { completions: 0, errors: 0, totalResponseTime: 0, responseCount: 0 },
      '5': { completions: 0, errors: 0, totalResponseTime: 0, responseCount: 0 },
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
      log.error('TaskParser', 'Error loading performance:', err.message);
    }
    return { ...DEFAULT_PERFORMANCE };
  }

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
