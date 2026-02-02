const DEFAULT_STATE_KEYS = [
  'mainWindow',
  'daemonClient',
  'agentRunning',  // Renamed from claudeRunning - agents can be Claude, Codex, or Gemini
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

  // Backward compatibility alias: claudeRunning -> agentRunning
  if (!ctx.claudeRunning && ctx.agentRunning !== undefined) {
    Object.defineProperty(ctx, 'claudeRunning', {
      enumerable: false,
      get: () => ctx.agentRunning,
      set: (value) => {
        ctx.agentRunning = value;
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
