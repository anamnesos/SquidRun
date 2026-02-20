const { contextBridge, ipcRenderer } = require('electron');

// Build the API object
const squidrunApi = {
  // PTY operations
  pty: {
    create: (paneId, workingDir) => ipcRenderer.invoke('pty-create', paneId, workingDir),
    write: (paneId, data, kernelMeta = null) => ipcRenderer.invoke('pty-write', paneId, data, kernelMeta),
    writeChunked: (paneId, fullText, options = {}, kernelMeta = null) =>
      ipcRenderer.invoke('pty-write-chunked', paneId, fullText, options, kernelMeta),
    pause: (paneId) => ipcRenderer.invoke('pty-pause', paneId),
    resume: (paneId) => ipcRenderer.invoke('pty-resume', paneId),
    resize: (paneId, cols, rows, kernelMeta = null) => ipcRenderer.invoke('pty-resize', paneId, cols, rows, kernelMeta),
    kill: (paneId) => ipcRenderer.invoke('pty-kill', paneId),
    onData: (paneId, callback) => {
      const channel = `pty-data-${paneId}`;
      const handler = (event, data) => callback(data);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
    removeAllDataListeners: (paneId) => {
      const channel = `pty-data-${paneId}`;
      ipcRenderer.removeAllListeners(channel);
    },
    onExit: (paneId, callback) => {
      const channel = `pty-exit-${paneId}`;
      const handler = (event, code) => callback(code);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
    removeAllExitListeners: (paneId) => {
      const channel = `pty-exit-${paneId}`;
      ipcRenderer.removeAllListeners(channel);
    },
    onKernelBridgeEvent: (callback) => {
      ipcRenderer.on('kernel:bridge-event', (event, data) => callback(data));
    },
    onKernelBridgeStats: (callback) => {
      ipcRenderer.on('kernel:bridge-stats', (event, data) => callback(data));
    },
  },

  // Claude operations
  claude: {
    spawn: (paneId, workingDir) => ipcRenderer.invoke('spawn-claude', paneId, workingDir),
  },

  paneHost: {
    inject: (paneId, payload = {}) => ipcRenderer.invoke('pane-host-inject', paneId, payload),
  },

  // Shared context operations
  context: {
    read: () => ipcRenderer.invoke('read-shared-context'),
    write: (content) => ipcRenderer.invoke('write-shared-context', content),
    getPath: () => ipcRenderer.invoke('get-shared-context-path'),
  },

  // Intent board updates (app-process canonical write path)
  intent: {
    update: (payload = {}) => ipcRenderer.invoke('intent-update', payload),
  },

  // Voice input (Whisper transcription)
  voice: {
    transcribe: (audioBuffer) => ipcRenderer.invoke('voice:transcribe', audioBuffer),
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

  // Contract promotion operations
  contractPromotion: {
    list: (payload = {}) => ipcRenderer.invoke('contract-promotion:list', payload),
    approve: (payload = {}) => ipcRenderer.invoke('contract-promotion:approve', payload),
    reject: (payload = {}) => ipcRenderer.invoke('contract-promotion:reject', payload),
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
  contextBridge.exposeInMainWorld('squidrun', squidrunApi);
  contextBridge.exposeInMainWorld('hivemind', squidrunApi); // Legacy alias
} else {
  window.squidrun = squidrunApi;
  window.hivemind = squidrunApi; // Legacy alias
}
