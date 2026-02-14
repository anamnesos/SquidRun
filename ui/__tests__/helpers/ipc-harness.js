const path = require('path');
const {
  WORKSPACE_PATH,
  PANE_IDS,
  PANE_ROLES,
  TRIGGER_TARGETS,
} = require('../../config');

function createIpcHarness() {
  const handlers = new Map();
  const listeners = new Map();

  const ipcMain = {
    handle: jest.fn((channel, handler) => {
      handlers.set(channel, handler);
    }),
    on: jest.fn((channel, listener) => {
      listeners.set(channel, listener);
    }),
    removeHandler: jest.fn((channel) => {
      handlers.delete(channel);
    }),
  };

  async function invoke(channel, ...args) {
    const handler = handlers.get(channel);
    if (!handler) {
      throw new Error(`No handler registered for ${channel}`);
    }
    return handler({}, ...args);
  }

  function emit(channel, ...args) {
    const listener = listeners.get(channel);
    if (listener) {
      return listener({}, ...args);
    }
    return undefined;
  }

  return { ipcMain, handlers, listeners, invoke, emit };
}

function createDefaultContext(overrides = {}) {
  const mainWindow = {
    isDestroyed: () => false,
    webContents: {
      send: jest.fn(),
      sendInputEvent: jest.fn(),
    },
  };

  const ctx = {
    ipcMain: overrides.ipcMain,
    mainWindow,
    WORKSPACE_PATH,
    SHARED_CONTEXT_PATH: path.join(WORKSPACE_PATH, 'shared_context.md'),
    PANE_IDS,
    PANE_ROLES,
    TRIGGER_TARGETS,
    watcher: {
      startWatcher: jest.fn(),
      stopWatcher: jest.fn(),
      claimAgent: jest.fn(() => ({ success: true })),
      releaseAgent: jest.fn(() => ({ success: true })),
      getClaims: jest.fn(() => ({})),
      clearClaims: jest.fn(() => ({ success: true })),
    },
    triggers: {
      notifyAgents: jest.fn(),
      notifyAllAgentsSync: jest.fn(),
      handleTriggerFile: jest.fn(),
    },
    currentSettings: {
      paneCommands: {},
      dryRun: false,
    },
    agentRunning: new Map(),  // Renamed from claudeRunning - agents can be Claude, Codex, or Gemini
    daemonClient: {
      connected: false,
      spawn: jest.fn(),
      write: jest.fn(),
      resize: jest.fn(),
      kill: jest.fn(),
      getTerminals: jest.fn(() => []),
      codexExec: jest.fn(),
      shutdown: jest.fn(),
    },
    usageStats: { totalSpawns: 0, totalSessionTime: 0, sessionsToday: 0 },
    sessionStartTimes: new Map(),
    costAlertSent: new Set(),
    backgroundProcesses: new Map(),
    processIdCounter: 0,
  };

  return { ...ctx, ...overrides };
}

function createDepsMock(overrides = {}) {
  const base = { ...overrides };
  return new Proxy(base, {
    get(target, prop) {
      if (!(prop in target)) {
        target[prop] = jest.fn();
      }
      return target[prop];
    },
  });
}

module.exports = {
  createIpcHarness,
  createDefaultContext,
  createDepsMock,
};
