const { contextBridge, ipcRenderer } = require('electron');

// Build the API object
const hivemindApi = {
  // PTY operations
  pty: {
    create: (paneId, workingDir) => ipcRenderer.invoke('pty-create', paneId, workingDir),
    write: (paneId, data) => ipcRenderer.invoke('pty-write', paneId, data),
    pause: (paneId) => ipcRenderer.invoke('pty-pause', paneId),
    resume: (paneId) => ipcRenderer.invoke('pty-resume', paneId),
    codexExec: (paneId, prompt) => ipcRenderer.invoke('codex-exec', paneId, prompt),
    resize: (paneId, cols, rows) => ipcRenderer.invoke('pty-resize', paneId, cols, rows),
    kill: (paneId) => ipcRenderer.invoke('pty-kill', paneId),
    onData: (paneId, callback) => {
      ipcRenderer.on(`pty-data-${paneId}`, (event, data) => callback(data));
    },
    onExit: (paneId, callback) => {
      ipcRenderer.on(`pty-exit-${paneId}`, (event, code) => callback(code));
    },
  },

  // Claude operations
  claude: {
    spawn: (paneId, workingDir) => ipcRenderer.invoke('spawn-claude', paneId, workingDir),
    injectContext: (paneId, model, delay) => ipcRenderer.invoke('inject-context', paneId, model, delay),
  },

  // Shared context operations
  context: {
    read: () => ipcRenderer.invoke('read-shared-context'),
    write: (content) => ipcRenderer.invoke('write-shared-context', content),
    getPath: () => ipcRenderer.invoke('get-shared-context-path'),
  },

  // Agent memory system
  memory: {
    // Logging
    logInput: (paneId, content, metadata = {}) =>
      ipcRenderer.invoke('memory:log-input', paneId, content, metadata),
    logOutput: (paneId, content, metadata = {}) =>
      ipcRenderer.invoke('memory:log-output', paneId, content, metadata),
    logToolUse: (paneId, toolName, params = {}) =>
      ipcRenderer.invoke('memory:log-tool-use', paneId, toolName, params),
    logDecision: (paneId, action, rationale = '') =>
      ipcRenderer.invoke('memory:log-decision', paneId, action, rationale),
    logError: (paneId, message, errorData = null) =>
      ipcRenderer.invoke('memory:log-error', paneId, message, errorData),
    logTrigger: (sourcePaneId, targetPaneId, content) =>
      ipcRenderer.invoke('memory:log-trigger', sourcePaneId, targetPaneId, content),

    // Context
    recordLearning: (paneId, topic, content, confidence = 0.8) =>
      ipcRenderer.invoke('memory:record-learning', paneId, topic, content, confidence),
    recordFileAccess: (paneId, filePath, action) =>
      ipcRenderer.invoke('memory:record-file-access', paneId, filePath, action),
    getContextSummary: (paneId) =>
      ipcRenderer.invoke('memory:get-context-summary', paneId),
    getContextInjection: (paneId, options = {}) =>
      ipcRenderer.invoke('memory:get-context-injection', paneId, options),

    // Session
    startSession: (paneId, sessionId = null) =>
      ipcRenderer.invoke('memory:start-session', paneId, sessionId),
    endSession: (paneId) =>
      ipcRenderer.invoke('memory:end-session', paneId),
    setTask: (paneId, task) =>
      ipcRenderer.invoke('memory:set-task', paneId, task),
    completeTask: (paneId, outcome, details = {}) =>
      ipcRenderer.invoke('memory:complete-task', paneId, outcome, details),

    // Query
    getTranscript: (paneId, limit = 50) =>
      ipcRenderer.invoke('memory:get-transcript', paneId, limit),
    getSummary: (paneId) =>
      ipcRenderer.invoke('memory:get-summary', paneId),
    search: (query, options = {}) =>
      ipcRenderer.invoke('memory:search', query, options),
    searchAll: (query, options = {}) =>
      ipcRenderer.invoke('memory:search-all', query, options),

    // Team
    getTeamSummary: () =>
      ipcRenderer.invoke('memory:get-team-summary'),
    getSharedLearnings: (limit = 50) =>
      ipcRenderer.invoke('memory:get-shared-learnings', limit),
    getSharedDecisions: (limit = 50) =>
      ipcRenderer.invoke('memory:get-shared-decisions', limit),

    // Analytics
    getTranscriptStats: (paneId) =>
      ipcRenderer.invoke('memory:get-transcript-stats', paneId),
    getTaskHistory: (paneId, limit = 10) =>
      ipcRenderer.invoke('memory:get-task-history', paneId, limit),
    getCollaborationStats: (paneId) =>
      ipcRenderer.invoke('memory:get-collaboration-stats', paneId),
    getExpertFiles: (paneId, minInteractions = 3) =>
      ipcRenderer.invoke('memory:get-expert-files', paneId, minInteractions),
    analyzeToolUsage: (toolName = null, options = {}) =>
      ipcRenderer.invoke('memory:analyze-tool-usage', toolName, options),
  },

  // Broadcast to all panes (will be implemented in renderer)
  broadcast: null, // Placeholder, implemented in renderer

  // Workflow Builder operations
  workflow: {
    list: () => ipcRenderer.invoke('workflow-list'),
    save: (name, workflow, overwrite) => ipcRenderer.invoke('workflow-save', { name, workflow, overwrite }),
    load: (name) => ipcRenderer.invoke('workflow-load', { name }),
    delete: (name) => ipcRenderer.invoke('workflow-delete', { name }),
    duplicate: (name, newName) => ipcRenderer.invoke('workflow-duplicate', { name, newName }),
    validate: (workflow, options) => ipcRenderer.invoke('workflow-validate', { workflow, options }),
    generatePlan: (workflow) => ipcRenderer.invoke('workflow-generate-plan', { workflow }),
    exportFile: (workflow, defaultName) => ipcRenderer.invoke('workflow-export-file', { workflow, defaultName }),
    importFile: () => ipcRenderer.invoke('workflow-import-file'),
    getNodeTypes: () => ipcRenderer.invoke('workflow-get-node-types'),
    getTemplates: () => ipcRenderer.invoke('workflow-get-templates'),
    applyTemplate: (templateId) => ipcRenderer.invoke('workflow-apply-template', { templateId }),
  },

  // Knowledge Graph operations
  graph: {
    query: (query, options) => ipcRenderer.invoke('graph-query', { query, ...options }),
    visualize: (filter) => ipcRenderer.invoke('graph-visualize', { filter }),
    stats: () => ipcRenderer.invoke('graph-stats'),
    related: (nodeId, depth) => ipcRenderer.invoke('graph-related', { nodeId, depth }),
    recordConcept: (name, description, relatedTo) => ipcRenderer.invoke('graph-record-concept', { name, description, relatedTo }),
    save: () => ipcRenderer.invoke('graph-save'),
    getNodesByType: (type) => ipcRenderer.invoke('graph-nodes-by-type', { type }),
  },
};

// Expose to renderer: use contextBridge when contextIsolation is enabled,
// fall back to direct window assignment when it's disabled
if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('hivemind', hivemindApi);
} else {
  window.hivemind = hivemindApi;
}
