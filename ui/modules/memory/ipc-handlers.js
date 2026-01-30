/**
 * Memory System IPC Handlers
 *
 * Exposes memory system functionality to the renderer process
 * via Electron IPC channels.
 */

const { ipcMain } = require('electron');
const memory = require('./index');

let handlersRegistered = false;

/**
 * Register all memory-related IPC handlers
 * @param {Object} ctx - Context object with mainWindow reference
 */
function registerHandlers(ctx) {
  if (handlersRegistered) return;
  handlersRegistered = true;

  // ============================================================
  // LOGGING HANDLERS
  // ============================================================

  ipcMain.handle('memory:log-input', async (event, paneId, content, metadata) => {
    try {
      memory.logInput(paneId, content, metadata);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('memory:log-output', async (event, paneId, content, metadata) => {
    try {
      memory.logOutput(paneId, content, metadata);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('memory:log-tool-use', async (event, paneId, toolName, params) => {
    try {
      memory.logToolUse(paneId, toolName, params);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('memory:log-decision', async (event, paneId, action, rationale) => {
    try {
      memory.logDecision(paneId, action, rationale);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('memory:log-error', async (event, paneId, message, errorData) => {
    try {
      memory.logError(paneId, message, errorData);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('memory:log-trigger', async (event, sourcePaneId, targetPaneId, content) => {
    try {
      memory.logTriggerMessage(sourcePaneId, targetPaneId, content);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ============================================================
  // CONTEXT HANDLERS
  // ============================================================

  ipcMain.handle('memory:record-learning', async (event, paneId, topic, content, confidence, metadata = {}) => {
    try {
      const record = memory.recordLearning(paneId, topic, content, confidence, metadata);
      return { success: true, data: record };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('memory:record-file-access', async (event, paneId, filePath, action) => {
    try {
      memory.recordFileAccess(paneId, filePath, action);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('memory:get-context-summary', async (event, paneId) => {
    try {
      const summary = memory.getContextSummary(paneId);
      return { success: true, data: summary };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('memory:get-context-injection', async (event, paneId, options) => {
    try {
      const injection = memory.getContextInjection(paneId, options);
      return { success: true, data: injection };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('memory:get-context-optimization', async (event, paneId, options) => {
    try {
      const analysis = memory.getContextOptimization(paneId, options);
      return { success: true, data: analysis };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ============================================================
  // SESSION HANDLERS
  // ============================================================

  ipcMain.handle('memory:start-session', async (event, paneId, sessionId) => {
    try {
      memory.startSession(paneId, sessionId);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('memory:end-session', async (event, paneId) => {
    try {
      memory.endSession(paneId);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('memory:set-task', async (event, paneId, task) => {
    try {
      memory.setCurrentTask(paneId, task);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('memory:complete-task', async (event, paneId, outcome, details) => {
    try {
      memory.completeTask(paneId, outcome, details);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ============================================================
  // QUERY HANDLERS
  // ============================================================

  ipcMain.handle('memory:get-transcript', async (event, paneId, limit) => {
    try {
      const transcript = memory.getRecentTranscript(paneId, limit);
      return { success: true, data: transcript };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('memory:get-summary', async (event, paneId) => {
    try {
      const summary = memory.getSummary(paneId);
      return { success: true, data: summary };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('memory:search', async (event, query, options) => {
    try {
      const results = memory.search(query, options);
      return { success: true, data: results };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('memory:search-all', async (event, query, options) => {
    try {
      const results = memory.searchAllAgents(query, options);
      return { success: true, data: results };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ============================================================
  // TEAM HANDLERS
  // ============================================================

  ipcMain.handle('memory:get-team-summary', async (event) => {
    try {
      const summary = memory.getTeamSummary();
      return { success: true, data: summary };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('memory:get-shared-learnings', async (event, limit) => {
    try {
      const learnings = memory.getSharedLearnings(limit);
      return { success: true, data: learnings };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('memory:get-shared-decisions', async (event, limit) => {
    try {
      const decisions = memory.getSharedDecisions(limit);
      return { success: true, data: decisions };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ============================================================
  // ANALYTICS HANDLERS
  // ============================================================

  ipcMain.handle('memory:get-transcript-stats', async (event, paneId) => {
    try {
      const stats = memory.getTranscriptStats(paneId);
      return { success: true, data: stats };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('memory:get-task-history', async (event, paneId, limit) => {
    try {
      const history = memory.getTaskHistory(paneId, limit);
      return { success: true, data: history };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('memory:get-collaboration-stats', async (event, paneId) => {
    try {
      const stats = memory.getCollaborationStats(paneId);
      return { success: true, data: stats };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('memory:get-expert-files', async (event, paneId, minInteractions) => {
    try {
      const files = memory.getExpertFiles(paneId, minInteractions);
      return { success: true, data: files };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('memory:analyze-tool-usage', async (event, toolName, options) => {
    try {
      const analysis = memory.analyzeToolUsage(toolName, options);
      return { success: true, data: analysis };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  console.log('[Memory] IPC handlers registered');
}

/**
 * Unregister all memory-related IPC handlers
 */
function unregisterHandlers() {
  if (!handlersRegistered) return;

  const channels = [
    'memory:log-input',
    'memory:log-output',
    'memory:log-tool-use',
    'memory:log-decision',
    'memory:log-error',
    'memory:log-trigger',
    'memory:record-learning',
    'memory:record-file-access',
    'memory:get-context-summary',
    'memory:get-context-injection',
    'memory:get-context-optimization',
    'memory:start-session',
    'memory:end-session',
    'memory:set-task',
    'memory:complete-task',
    'memory:get-transcript',
    'memory:get-summary',
    'memory:search',
    'memory:search-all',
    'memory:get-team-summary',
    'memory:get-shared-learnings',
    'memory:get-shared-decisions',
    'memory:get-transcript-stats',
    'memory:get-task-history',
    'memory:get-collaboration-stats',
    'memory:get-expert-files',
    'memory:analyze-tool-usage'
  ];

  for (const channel of channels) {
    ipcMain.removeHandler(channel);
  }

  handlersRegistered = false;
  console.log('[Memory] IPC handlers unregistered');
}

module.exports = {
  registerHandlers,
  unregisterHandlers
};
