const state = {
  mainWindow: null,
  daemonClient: null,
  claudeRunning: null,
  currentSettings: null,
  watcher: null,
  triggers: null,
  usageStats: null,
  sessionStartTimes: null,
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
  assign('claudeRunning');
  assign('currentSettings');
  assign('watcher');
  assign('triggers');
  assign('usageStats');
  assign('sessionStartTimes');
}

function setDaemonClient(client) {
  state.daemonClient = client;
}

module.exports = {
  state,
  initState,
  setDaemonClient,
};
