const state = {
  mainWindow: null,
  daemonClient: null,
  agentRunning: null,  // Renamed from claudeRunning - agents can be Claude, Codex, or Gemini
  currentSettings: null,
  watcher: null,
  triggers: null,
  recoveryManager: null,
  pluginManager: null,
  backupManager: null,
  usageStats: null,
  sessionStartTimes: null,
  contextInjection: null,
  costAlertSent: false,
  backgroundProcesses: new Map(),
  processIdCounter: 1,
};

function initState(deps = {}) {
  const assign = (key) => {
    if (Object.prototype.hasOwnProperty.call(deps, key)) {
      state[key] = deps[key];
    }
  };

  assign('mainWindow');
  assign('daemonClient');
  assign('agentRunning');
  assign('currentSettings');
  assign('watcher');
  assign('triggers');
  assign('recoveryManager');
  assign('pluginManager');
  assign('backupManager');
  assign('usageStats');
  assign('sessionStartTimes');
  assign('contextInjection');
}

function setDaemonClient(client) {
  state.daemonClient = client;
}

// Backward compatibility alias: state.claudeRunning -> state.agentRunning
Object.defineProperty(state, 'claudeRunning', {
  enumerable: false,
  get: () => state.agentRunning,
  set: (value) => {
    state.agentRunning = value;
  },
});

module.exports = {
  state,
  initState,
  setDaemonClient,
};
