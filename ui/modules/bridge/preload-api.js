'use strict';

const { createSafeIpc } = require('./safe-ipc');

function toPaneChannel(prefix, paneId) {
  const normalizedPaneId = String(paneId || '').trim();
  if (!normalizedPaneId || !/^[A-Za-z0-9_-]+$/.test(normalizedPaneId)) {
    throw new Error(`[preload bridge] Invalid pane id: ${String(paneId)}`);
  }
  return `${prefix}${normalizedPaneId}`;
}

function createPreloadApi(ipcRenderer) {
  const ipc = createSafeIpc(ipcRenderer);

  const api = {
    invoke: ipc.invoke,
    send: ipc.send,
    on: ipc.on,
    removeListener: ipc.removeListener,

    ipc: {
      invoke: ipc.invoke,
      send: ipc.send,
      on: ipc.on,
      removeListener: ipc.removeListener,
    },

    util: {
      isInvokeChannelAllowed: ipc.isInvokeChannelAllowed,
      isSendChannelAllowed: ipc.isSendChannelAllowed,
      isOnChannelAllowed: ipc.isOnChannelAllowed,
    },

    pty: {
      create: (paneId, workingDir) => ipc.invoke('pty-create', paneId, workingDir),
      write: (paneId, data, kernelMeta = null) => ipc.invoke('pty-write', paneId, data, kernelMeta),
      writeChunked: (paneId, fullText, options = {}, kernelMeta = null) =>
        ipc.invoke('pty-write-chunked', paneId, fullText, options, kernelMeta),
      sendTrustedEnter: () => ipc.invoke('send-trusted-enter'),
      clipboardPasteText: (text) => ipc.invoke('clipboard-paste-text', text),
      pause: (paneId) => ipc.invoke('pty-pause', paneId),
      resume: (paneId) => ipc.invoke('pty-resume', paneId),
      resize: (paneId, cols, rows, kernelMeta = null) => ipc.invoke('pty-resize', paneId, cols, rows, kernelMeta),
      kill: (paneId) => ipc.invoke('pty-kill', paneId),
      onData: (paneId, callback) => {
        const channel = toPaneChannel('pty-data-', paneId);
        return ipc.on(channel, callback);
      },
      removeAllDataListeners: (paneId) => {
        const channel = toPaneChannel('pty-data-', paneId);
        ipc.removeAllListeners(channel);
      },
      onExit: (paneId, callback) => {
        const channel = toPaneChannel('pty-exit-', paneId);
        return ipc.on(channel, callback);
      },
      removeAllExitListeners: (paneId) => {
        const channel = toPaneChannel('pty-exit-', paneId);
        ipc.removeAllListeners(channel);
      },
      onKernelBridgeEvent: (callback) => ipc.on('kernel:bridge-event', callback),
      onKernelBridgeStats: (callback) => ipc.on('kernel:bridge-stats', callback),
    },

    claude: {
      spawn: (paneId, workingDir) => ipc.invoke('spawn-claude', paneId, workingDir),
    },

    paneHost: {
      inject: (paneId, payload = {}) => ipc.invoke('pane-host-inject', paneId, payload),
      dispatchEnter: (paneId) => ipc.invoke('pane-host-dispatch-enter', paneId),
      ready: (payload = {}) => ipc.send('pane-host-ready', payload),
    },

    context: {
      read: () => ipc.invoke('read-shared-context'),
      write: (content) => ipc.invoke('write-shared-context', content),
      getPath: () => ipc.invoke('get-shared-context-path'),
    },

    intent: {
      update: (payload = {}) => ipc.invoke('intent-update', payload),
    },

    voice: {
      transcribe: (audioBuffer) => ipc.invoke('voice:transcribe', audioBuffer),
    },

    broadcast: null,

    workflow: {
      list: () => ipc.invoke('workflow-list'),
      save: (name, workflow, overwrite) => ipc.invoke('workflow-save', { name, workflow, overwrite }),
      load: (name) => ipc.invoke('workflow-load', { name }),
      delete: (name) => ipc.invoke('workflow-delete', { name }),
      duplicate: (name, newName) => ipc.invoke('workflow-duplicate', { name, newName }),
      validate: (workflow, options) => ipc.invoke('workflow-validate', { workflow, options }),
      generatePlan: (workflow) => ipc.invoke('workflow-generate-plan', { workflow }),
      exportFile: (workflow, defaultName) => ipc.invoke('workflow-export-file', { workflow, defaultName }),
      importFile: () => ipc.invoke('workflow-import-file'),
      getNodeTypes: () => ipc.invoke('workflow-get-node-types'),
      getTemplates: () => ipc.invoke('workflow-get-templates'),
      applyTemplate: (templateId) => ipc.invoke('workflow-apply-template', { templateId }),
    },

    contractPromotion: {
      list: (payload = {}) => ipc.invoke('contract-promotion:list', payload),
      approve: (payload = {}) => ipc.invoke('contract-promotion:approve', payload),
      reject: (payload = {}) => ipc.invoke('contract-promotion:reject', payload),
    },

    graph: {
      query: (query, options) => ipc.invoke('graph-query', { query, ...options }),
      visualize: (filter) => ipc.invoke('graph-visualize', { filter }),
      stats: () => ipc.invoke('graph-stats'),
      related: (nodeId, depth) => ipc.invoke('graph-related', { nodeId, depth }),
      recordConcept: (name, description, relatedTo) => ipc.invoke('graph-record-concept', { name, description, relatedTo }),
      save: () => ipc.invoke('graph-save'),
      getNodesByType: (type) => ipc.invoke('graph-nodes-by-type', { type }),
    },

    project: {
      select: () => ipc.invoke('select-project'),
      get: () => ipc.invoke('get-project'),
    },

    friction: {
      list: () => ipc.invoke('list-friction'),
      read: (filename) => ipc.invoke('read-friction', filename),
      delete: (filename) => ipc.invoke('delete-friction', filename),
      clear: () => ipc.invoke('clear-friction'),
    },

    screenshot: {
      save: (base64Data, originalName) => ipc.invoke('save-screenshot', base64Data, originalName),
      list: (options = null) => ipc.invoke('list-screenshots', options),
      delete: (filename) => ipc.invoke('delete-screenshot', filename),
      getPath: (filename) => ipc.invoke('get-screenshot-path', filename),
    },

    process: {
      spawn: (command, args, cwd) => ipc.invoke('spawn-process', command, args, cwd),
      list: () => ipc.invoke('list-processes'),
      kill: (processId) => ipc.invoke('kill-process', processId),
      getOutput: (processId) => ipc.invoke('get-process-output', processId),
    },
  };

  return api;
}

module.exports = {
  createPreloadApi,
};
