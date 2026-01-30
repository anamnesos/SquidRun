const DEFAULT_STATE_KEYS = [
  'mainWindow',
  'daemonClient',
  'claudeRunning',
  'currentSettings',
  'watcher',
  'triggers',
  'recoveryManager',
  'pluginManager',
  'backupManager',
  'usageStats',
  'sessionStartTimes',
  'costAlertSent',
  'backgroundProcesses',
  'processIdCounter',
];

function createIpcContext(state, extras = {}) {
  const ctx = { ...extras };
  if (!state || typeof state !== 'object') {
    return ctx;
  }

  for (const key of DEFAULT_STATE_KEYS) {
    Object.defineProperty(ctx, key, {
      enumerable: true,
      get: () => state[key],
      set: (value) => {
        state[key] = value;
      },
    });
  }

  ctx.state = state;
  return ctx;
}

function createIpcRegistry() {
  const modules = [];

  return {
    register(registerFn) {
      if (typeof registerFn === 'function') {
        modules.push(registerFn);
      }
    },
    setup(ctx, deps) {
      for (const registerFn of modules) {
        registerFn(ctx, deps);
      }
    },
    list() {
      return modules.map(fn => fn.name || 'anonymous');
    },
  };
}

module.exports = {
  createIpcContext,
  createIpcRegistry,
  DEFAULT_STATE_KEYS,
};
