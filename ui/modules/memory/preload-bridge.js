/**
 * Memory Preload Bridge
 *
 * Provides secure access to memory system from renderer process.
 * This should be included in the main preload.js file.
 */

const { ipcRenderer } = require('electron');

/**
 * Memory API exposed to renderer
 */
const memoryAPI = {
  // ============================================================
  // LOGGING
  // ============================================================

  /**
   * Log an input message
   * @param {string} paneId
   * @param {string} content
   * @param {Object} [metadata]
   * @returns {Promise<Object>}
   */
  logInput: (paneId, content, metadata = {}) =>
    ipcRenderer.invoke('memory:log-input', paneId, content, metadata),

  /**
   * Log an output message
   * @param {string} paneId
   * @param {string} content
   * @param {Object} [metadata]
   * @returns {Promise<Object>}
   */
  logOutput: (paneId, content, metadata = {}) =>
    ipcRenderer.invoke('memory:log-output', paneId, content, metadata),

  /**
   * Log tool usage
   * @param {string} paneId
   * @param {string} toolName
   * @param {Object} [params]
   * @returns {Promise<Object>}
   */
  logToolUse: (paneId, toolName, params = {}) =>
    ipcRenderer.invoke('memory:log-tool-use', paneId, toolName, params),

  /**
   * Log a decision
   * @param {string} paneId
   * @param {string} action
   * @param {string} [rationale]
   * @returns {Promise<Object>}
   */
  logDecision: (paneId, action, rationale = '') =>
    ipcRenderer.invoke('memory:log-decision', paneId, action, rationale),

  /**
   * Log an error
   * @param {string} paneId
   * @param {string} message
   * @param {Object} [errorData]
   * @returns {Promise<Object>}
   */
  logError: (paneId, message, errorData = null) =>
    ipcRenderer.invoke('memory:log-error', paneId, message, errorData),

  /**
   * Log a trigger message
   * @param {string} sourcePaneId
   * @param {string} targetPaneId
   * @param {string} content
   * @returns {Promise<Object>}
   */
  logTrigger: (sourcePaneId, targetPaneId, content) =>
    ipcRenderer.invoke('memory:log-trigger', sourcePaneId, targetPaneId, content),

  // ============================================================
  // CONTEXT
  // ============================================================

  /**
   * Record a learning
   * @param {string} paneId
   * @param {string} topic
   * @param {string} content
   * @param {number} [confidence=0.8]
   * @returns {Promise<Object>}
   */
  recordLearning: (paneId, topic, content, confidence = 0.8) =>
    ipcRenderer.invoke('memory:record-learning', paneId, topic, content, confidence),

  /**
   * Record file access
   * @param {string} paneId
   * @param {string} filePath
   * @param {string} action
   * @returns {Promise<Object>}
   */
  recordFileAccess: (paneId, filePath, action) =>
    ipcRenderer.invoke('memory:record-file-access', paneId, filePath, action),

  /**
   * Get context summary
   * @param {string} paneId
   * @returns {Promise<Object>}
   */
  getContextSummary: (paneId) =>
    ipcRenderer.invoke('memory:get-context-summary', paneId),

  /**
   * Get context injection string
   * @param {string} paneId
   * @param {Object} [options]
   * @returns {Promise<Object>}
   */
  getContextInjection: (paneId, options = {}) =>
    ipcRenderer.invoke('memory:get-context-injection', paneId, options),
  getContextOptimization: (paneId, options = {}) =>
    ipcRenderer.invoke('memory:get-context-optimization', paneId, options),

  // ============================================================
  // SESSION
  // ============================================================

  /**
   * Start session
   * @param {string} paneId
   * @param {string} [sessionId]
   * @returns {Promise<Object>}
   */
  startSession: (paneId, sessionId = null) =>
    ipcRenderer.invoke('memory:start-session', paneId, sessionId),

  /**
   * End session
   * @param {string} paneId
   * @returns {Promise<Object>}
   */
  endSession: (paneId) =>
    ipcRenderer.invoke('memory:end-session', paneId),

  /**
   * Set current task
   * @param {string} paneId
   * @param {Object} task
   * @returns {Promise<Object>}
   */
  setTask: (paneId, task) =>
    ipcRenderer.invoke('memory:set-task', paneId, task),

  /**
   * Complete task
   * @param {string} paneId
   * @param {string} outcome
   * @param {Object} [details]
   * @returns {Promise<Object>}
   */
  completeTask: (paneId, outcome, details = {}) =>
    ipcRenderer.invoke('memory:complete-task', paneId, outcome, details),

  // ============================================================
  // QUERY
  // ============================================================

  /**
   * Get recent transcript
   * @param {string} paneId
   * @param {number} [limit=50]
   * @returns {Promise<Object>}
   */
  getTranscript: (paneId, limit = 50) =>
    ipcRenderer.invoke('memory:get-transcript', paneId, limit),

  /**
   * Get summary
   * @param {string} paneId
   * @returns {Promise<Object>}
   */
  getSummary: (paneId) =>
    ipcRenderer.invoke('memory:get-summary', paneId),

  /**
   * Search memory
   * @param {string} query
   * @param {Object} [options]
   * @returns {Promise<Object>}
   */
  search: (query, options = {}) =>
    ipcRenderer.invoke('memory:search', query, options),

  /**
   * Search all agents
   * @param {string} query
   * @param {Object} [options]
   * @returns {Promise<Object>}
   */
  searchAll: (query, options = {}) =>
    ipcRenderer.invoke('memory:search-all', query, options),

  // ============================================================
  // TEAM
  // ============================================================

  /**
   * Get team summary
   * @returns {Promise<Object>}
   */
  getTeamSummary: () =>
    ipcRenderer.invoke('memory:get-team-summary'),

  /**
   * Get shared learnings
   * @param {number} [limit=50]
   * @returns {Promise<Object>}
   */
  getSharedLearnings: (limit = 50) =>
    ipcRenderer.invoke('memory:get-shared-learnings', limit),

  /**
   * Get shared decisions
   * @param {number} [limit=50]
   * @returns {Promise<Object>}
   */
  getSharedDecisions: (limit = 50) =>
    ipcRenderer.invoke('memory:get-shared-decisions', limit),

  // ============================================================
  // ANALYTICS
  // ============================================================

  /**
   * Get transcript stats
   * @param {string} paneId
   * @returns {Promise<Object>}
   */
  getTranscriptStats: (paneId) =>
    ipcRenderer.invoke('memory:get-transcript-stats', paneId),

  /**
   * Get task history
   * @param {string} paneId
   * @param {number} [limit=10]
   * @returns {Promise<Object>}
   */
  getTaskHistory: (paneId, limit = 10) =>
    ipcRenderer.invoke('memory:get-task-history', paneId, limit),

  /**
   * Get collaboration stats
   * @param {string} paneId
   * @returns {Promise<Object>}
   */
  getCollaborationStats: (paneId) =>
    ipcRenderer.invoke('memory:get-collaboration-stats', paneId),

  /**
   * Get expert files
   * @param {string} paneId
   * @param {number} [minInteractions=3]
   * @returns {Promise<Object>}
   */
  getExpertFiles: (paneId, minInteractions = 3) =>
    ipcRenderer.invoke('memory:get-expert-files', paneId, minInteractions),

  /**
   * Analyze tool usage
   * @param {string} [toolName]
   * @param {Object} [options]
   * @returns {Promise<Object>}
   */
  analyzeToolUsage: (toolName = null, options = {}) =>
    ipcRenderer.invoke('memory:analyze-tool-usage', toolName, options)
};

module.exports = { memoryAPI };
