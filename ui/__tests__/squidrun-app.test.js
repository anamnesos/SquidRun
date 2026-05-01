/**
 * Smoke tests for squidrun-app.js
 * Tests basic initialization and core functions of the main application controller
 *
 * Session 72: Added per audit finding - 650 lines of core code had ZERO tests
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveRuntimeInt } = require('../modules/runtime-config');

jest.mock('child_process', () => {
  const actual = jest.requireActual('child_process');
  return {
    ...actual,
    spawn: jest.fn(() => ({
      pid: 4321,
      unref: jest.fn(),
    })),
  };
});

// Mock electron (main process APIs)
jest.mock('electron', () => ({
  app: {
    getPath: jest.fn().mockReturnValue('/mock/app/path'),
    isPackaged: false,
    on: jest.fn(),
    quit: jest.fn(),
  },
  BrowserWindow: jest.fn().mockImplementation(() => ({
    loadFile: jest.fn().mockResolvedValue(),
    on: jest.fn(),
    webContents: {
      send: jest.fn(),
      on: jest.fn(),
      openDevTools: jest.fn(),
    },
    isDestroyed: jest.fn().mockReturnValue(false),
    isMinimized: jest.fn().mockReturnValue(false),
    isVisible: jest.fn().mockReturnValue(true),
    restore: jest.fn(),
    moveTop: jest.fn(),
    focus: jest.fn(),
    show: jest.fn(),
    hide: jest.fn(),
    close: jest.fn(),
  })),
  ipcMain: {
    handle: jest.fn(),
    on: jest.fn(),
    removeHandler: jest.fn(),
  },
  session: {
    defaultSession: {
      webRequest: {
        onHeadersReceived: jest.fn(),
      },
    },
  },
  shell: {
    writeShortcutLink: jest.fn(() => true),
  },
}));

// Mock logger
jest.mock('../modules/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('../modules/runtime-config', () => ({
  resolveRuntimeInt: jest.fn((key, fallback) => fallback),
}));

// Mock daemon-client
jest.mock('../daemon-client', () => ({
  getDaemonClient: jest.fn().mockReturnValue({
    connect: jest.fn().mockResolvedValue(),
    disconnect: jest.fn(),
    isConnected: jest.fn().mockReturnValue(false),
  }),
}));

// Mock config
jest.mock('../config', () => require('./helpers/mock-config').mockDefaultConfig);

// Mock plugins
jest.mock('../modules/plugins', () => ({
  createPluginManager: jest.fn().mockReturnValue({
    loadPlugins: jest.fn().mockResolvedValue([]),
    getPlugins: jest.fn().mockReturnValue([]),
  }),
}));

// Mock backup-manager
jest.mock('../modules/backup-manager', () => ({
  createBackupManager: jest.fn().mockReturnValue({
    init: jest.fn().mockResolvedValue(),
    createBackup: jest.fn().mockResolvedValue(),
  }),
}));

// Mock recovery-manager
jest.mock('../modules/recovery-manager', () => ({
  createRecoveryManager: jest.fn().mockReturnValue({
    init: jest.fn().mockResolvedValue(),
  }),
}));

// Mock external-notifications
jest.mock('../modules/external-notifications', () => ({
  createExternalNotifier: jest.fn().mockReturnValue({
    notify: jest.fn(),
  }),
}));

jest.mock('../modules/main/background-agent-manager', () => ({
  createBackgroundAgentManager: jest.fn().mockReturnValue({
    start: jest.fn(),
    stop: jest.fn(),
    handleSessionScopeChange: jest.fn().mockResolvedValue(),
    getTargetMap: jest.fn().mockReturnValue({}),
    listAgents: jest.fn().mockReturnValue([]),
    spawnAgent: jest.fn().mockResolvedValue({ ok: true }),
    killAgent: jest.fn().mockResolvedValue({ ok: true }),
    killAll: jest.fn().mockResolvedValue({ ok: true }),
    isBackgroundPaneId: jest.fn().mockReturnValue(false),
    sendMessageToAgent: jest.fn().mockResolvedValue({ ok: true }),
    handleDaemonData: jest.fn(),
    handleDaemonExit: jest.fn(),
    handleDaemonKilled: jest.fn(),
    syncWithDaemonTerminals: jest.fn(),
  }),
}));

jest.mock('../modules/main/pane-host-window-manager', () => ({
  createPaneHostWindowManager: jest.fn().mockReturnValue({
    ensurePaneWindows: jest.fn().mockResolvedValue(),
    getPaneWindow: jest.fn().mockReturnValue({
      isDestroyed: jest.fn().mockReturnValue(false),
      webContents: { send: jest.fn() },
    }),
    sendToPaneWindow: jest.fn().mockReturnValue(true),
    closeAllPaneWindows: jest.fn(),
    getWindowDiagnostics: jest.fn().mockReturnValue({ panes: [] }),
  }),
}));

jest.mock('../modules/bridge-client', () => {
  const actual = jest.requireActual('../modules/bridge-client');
  return {
    ...actual,
    createBridgeClient: jest.fn().mockReturnValue({
      start: jest.fn().mockReturnValue(true),
      stop: jest.fn(),
      isReady: jest.fn().mockReturnValue(true),
      discoverDevices: jest.fn().mockResolvedValue({ ok: true, devices: [], fetchedAt: Date.now() }),
      initiatePairing: jest.fn().mockResolvedValue({ ok: true }),
      completePairing: jest.fn().mockResolvedValue({ ok: true }),
      sendMessage: jest.fn().mockResolvedValue({ ok: true }),
      getStatusSnapshot: jest.fn().mockReturnValue({ state: 'connected', running: true }),
    }),
  };
});

// Mock triggers
jest.mock('../modules/triggers', () => ({
  init: jest.fn(),
  setWatcher: jest.fn(),
  setSelfHealing: jest.fn(),
  setPluginManager: jest.fn(),
  startTriggerWatcher: jest.fn(),
  stopTriggerWatcher: jest.fn(),
  broadcastToAllAgents: jest.fn(),
  sendDirectMessage: jest.fn(() => ({ success: true })),
}));

// Mock watcher
jest.mock('../modules/watcher', () => ({
  startWatcher: jest.fn(),
  stopWatcher: jest.fn(),
  startTriggerWatcher: jest.fn(),
  stopTriggerWatcher: jest.fn(),
  startMessageWatcher: jest.fn(),
  stopMessageWatcher: jest.fn(),
  setExternalNotifier: jest.fn(),
}));

// Mock ipc-handlers
jest.mock('../modules/ipc-handlers', () => ({
  registerHandlers: jest.fn(),
  setupIPCHandlers: jest.fn(),
  setDaemonClient: jest.fn(),
  setExternalNotifier: jest.fn(),
  cleanupProcesses: jest.fn(),
  cleanup: jest.fn(),
}));

// Mock websocket-server
jest.mock('../modules/websocket-server', () => ({
  start: jest.fn().mockResolvedValue(),
  stop: jest.fn(),
  sendToTarget: jest.fn(),
  DEFAULT_PORT: 9900,
}));

// Mock sms-poller
jest.mock('../modules/sms-poller', () => ({
  start: jest.fn(() => false),
  stop: jest.fn(),
  isRunning: jest.fn(() => false),
}));

// Mock telegram-poller
jest.mock('../modules/telegram-poller', () => ({
  start: jest.fn(() => false),
  stop: jest.fn(),
  isRunning: jest.fn(() => false),
}));

// Mock Telegram sender
jest.mock('../scripts/hm-telegram', () => ({
  sendTelegram: jest.fn(async () => ({
    ok: true,
    chatId: 123456789,
    messageId: 42,
  })),
  normalizeChatId: jest.fn((value) => {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    return /^-?\d+$/.test(text) ? text : null;
  }),
}));

jest.mock('../scripts/hm-telegram-routing', () => ({
  sendRoutedTelegramMessage: jest.fn(async (_message, _env, options = {}) => ({
    ok: true,
    chatId: options.chatId ? Number(options.chatId) : 123456789,
    messageId: 42,
    method: options.chatId === '2222222222' ? 'send-long-telegram' : 'hm-send-telegram',
  })),
}));

// Mock organic-ui-handlers
jest.mock('../modules/ipc/organic-ui-handlers', () => ({
  registerHandlers: jest.fn(),
  getAgentState: jest.fn(() => 'online'),
  agentActive: jest.fn(),
  agentOnline: jest.fn(),
  agentOffline: jest.fn(),
}));

// Mock evidence-ledger handlers
jest.mock('../modules/ipc/evidence-ledger-handlers', () => ({
  executeEvidenceLedgerOperation: jest.fn(),
  initializeEvidenceLedgerRuntime: jest.fn(() => ({ ok: true, status: { driver: 'better-sqlite3' } })),
  closeSharedRuntime: jest.fn(),
}));

// Mock cognitive-memory handlers
jest.mock('../modules/ipc/cognitive-memory-handlers', () => ({
  executeCognitiveMemoryOperation: jest.fn(async () => ({ ok: true, results: [] })),
  closeSharedCognitiveMemoryRuntime: jest.fn(),
}));

// Mock transition-ledger handlers
jest.mock('../modules/ipc/transition-ledger-handlers', () => ({
  executeTransitionLedgerOperation: jest.fn(async () => ({ ok: true, count: 0, items: [] })),
}));

// Mock github handlers
jest.mock('../modules/ipc/github-handlers', () => ({
  executeGitHubOperation: jest.fn(async () => ({ ok: true, action: 'status' })),
}));

// Mock team-memory service
jest.mock('../modules/team-memory', () => ({
  initializeTeamMemoryRuntime: jest.fn(async () => ({ ok: true, status: { driver: 'better-sqlite3' } })),
  executeTeamMemoryOperation: jest.fn(async () => ({ ok: true, status: 'updated' })),
  appendPatternHookEvent: jest.fn(async () => ({ ok: true, queued: true })),
  runBackfill: jest.fn(async () => ({ ok: true, scannedEvents: 0, insertedClaims: 0, duplicateClaims: 0 })),
  runIntegrityCheck: jest.fn(async () => ({ ok: true, orphanCount: 0 })),
  startIntegritySweep: jest.fn(),
  stopIntegritySweep: jest.fn(),
  startBeliefSnapshotSweep: jest.fn(),
  stopBeliefSnapshotSweep: jest.fn(),
  startPatternMiningSweep: jest.fn(),
  stopPatternMiningSweep: jest.fn(),
  closeTeamMemoryRuntime: jest.fn(async () => undefined),
}));

// Mock experiment service
jest.mock('../modules/experiment', () => ({
  initializeExperimentRuntime: jest.fn(async () => ({ ok: true, status: { driver: 'worker' } })),
  executeExperimentOperation: jest.fn(async () => ({ ok: true, runId: 'exp_mock', queued: false })),
  closeExperimentRuntime: jest.fn(),
}));

jest.mock('../scripts/hm-health-snapshot', () => ({
  createHealthSnapshot: jest.fn(() => ({
    generatedAt: '2026-03-13T00:00:00.000Z',
    tests: {
      testFileCount: 194,
      jestList: { ok: true, count: 195 },
    },
    modules: {
      moduleFileCount: 300,
      keyModules: {
        recovery_manager: { exists: true },
        background_agent_manager: { exists: true },
        scheduler: { exists: true },
      },
    },
    databases: {
      evidenceLedger: { exists: true, rowCount: 100 },
      cognitiveMemory: { exists: true, rowCount: 4 },
    },
    bridge: {
      enabled: true,
      configured: true,
      mode: 'connected',
      running: true,
      relayUrl: 'wss://relay.example.test',
      deviceId: 'LOCAL',
      state: 'connected',
    },
    status: { level: 'ok', warnings: [] },
  })),
  renderStartupHealthMarkdown: jest.fn(() => [
    'STARTUP HEALTH',
    '- Overall: OK',
    '- Tests: 194 files, 195 Jest-discoverable suites',
    '',
    'BRIDGE HEALTH',
    '- Connection: connected',
  ].join('\n')),
}));

jest.mock('../scripts/hm-session-summary', () => ({
  generateSessionSummary: jest.fn(async () => ({
    ok: true,
    sessionNumber: 147,
    messageCount: 3,
    summaryText: '# Session 147 Summary\n\n## Findings\n- Shipped continuity fix.\n',
    memoryResult: { ok: true, nodeId: 'node-session-147' },
    fallbackResult: { ok: true, path: 'D:\\projects\\squidrun\\.squidrun\\handoffs\\last-session-summary.md' },
  })),
}));

jest.mock('../modules/startup-ai-briefing', () => ({
  generateStartupBriefing: jest.fn(async () => ({
    ok: true,
    outputPath: '/test/.squidrun/handoffs/ai-briefing.md',
    transcriptFiles: [],
  })),
  readStartupBriefing: jest.fn(() => '# AI Startup Briefing'),
}));

jest.mock('../modules/local-model-capabilities', () => ({
  buildSystemCapabilitiesSnapshot: jest.fn((options = {}) => ({
    generatedAt: '2026-03-17T10:15:00.000Z',
    projectRoot: options.projectRoot || 'D:\\projects\\squidrun',
    path: 'D:\\projects\\squidrun\\.squidrun\\runtime\\system-capabilities.json',
    localModels: {
      enabled: options.settings?.localModelEnabled === true,
      sleepExtraction: {
        enabled: true,
        available: true,
        model: 'claude-opus-4-6',
        path: 'anthropic-api',
        command: '"node" "claude-extract.js" --model "claude-opus-4-6"',
      },
    },
  })),
  writeSystemCapabilitiesSnapshot: jest.fn(),
  resolveSleepExtractionCommandFromSnapshot: jest.fn((snapshot) => snapshot?.localModels?.sleepExtraction?.command || ''),
}));

// Now require the module under test
const { spawn } = require('child_process');
const SquidRunApp = require('../modules/main/squidrun-app');

describe('SquidRunApp', () => {
  let mockAppContext;
  let mockManagers;

  beforeEach(() => {
    jest.clearAllMocks();
    const windows = new Map();

    // Create mock app context
    mockAppContext = {
      mainWindow: null,
      windows,
      daemonClient: null,
      currentSettings: {},
      externalNotifier: null,
      setMainWindow: jest.fn((window) => {
        mockAppContext.mainWindow = window || null;
        if (window) {
          windows.set('main', window);
        } else {
          windows.delete('main');
        }
      }),
      setWindow: jest.fn((key, window) => {
        windows.set(key, window);
        if (key === 'main') {
          mockAppContext.mainWindow = window;
        }
      }),
      getWindow: jest.fn((key = 'main') => {
        if (key === 'main') return mockAppContext.mainWindow;
        return windows.get(key) || null;
      }),
      deleteWindow: jest.fn((key = 'main') => {
        windows.delete(key);
        if (key === 'main') {
          mockAppContext.mainWindow = null;
        }
      }),
      getWindows: jest.fn(() => new Map(windows)),
      setDaemonClient: jest.fn(),
      setExternalNotifier: jest.fn(),
    };

    // Create mock managers
    mockManagers = {
      settings: {
        loadSettings: jest.fn(),
        saveSettings: jest.fn((patch) => Object.assign(mockAppContext.currentSettings, patch)),
        readPersistedSettingsSnapshot: jest.fn(() => ({})),
        ensureCodexConfig: jest.fn(),
        writeAppStatus: jest.fn(),
        readAppStatus: jest.fn().mockReturnValue({ session: 147 }),
        getSettings: jest.fn().mockReturnValue({}),
      },
      activity: {
        loadActivityLog: jest.fn(),
        logActivity: jest.fn(),
      },
      usage: {
        loadUsageStats: jest.fn(),
        recordUsage: jest.fn(),
        recordSessionEnd: jest.fn(),
      },
      cliIdentity: {
        getIdentity: jest.fn().mockReturnValue(null),
      },
      contextInjection: {
        inject: jest.fn().mockResolvedValue(),
      },
      firmwareManager: {
        ensureStartupFirmwareIfEnabled: jest.fn(() => ({ ok: true, skipped: true })),
      },
    };
  });

  describe('constructor', () => {
    it('should create instance without throwing', () => {
      expect(() => {
        new SquidRunApp(mockAppContext, mockManagers);
      }).not.toThrow();
    });

    it('should store context and managers', () => {
      const app = new SquidRunApp(mockAppContext, mockManagers);

      expect(app.ctx).toBe(mockAppContext);
      expect(app.settings).toBe(mockManagers.settings);
      expect(app.activity).toBe(mockManagers.activity);
      expect(app.usage).toBe(mockManagers.usage);
    });

    it('should initialize forwarder flags to false', () => {
      const app = new SquidRunApp(mockAppContext, mockManagers);

      expect(app.cliIdentityForwarderRegistered).toBe(false);
      expect(app.triggerAckForwarderRegistered).toBe(false);
    });
  });

  describe('fresh install marker persistence', () => {
    it('writes fresh-install marker under .squidrun', () => {
      const app = new SquidRunApp(mockAppContext, mockManagers);
      const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-fresh-marker-'));

      const markerPath = app.writeFreshInstallMarker(workspace);
      expect(markerPath).toBe(path.join(workspace, '.squidrun', 'fresh-install.json'));
      expect(fs.existsSync(markerPath)).toBe(true);

      const payload = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
      expect(payload).toEqual(expect.objectContaining({
        fresh_install: true,
        workspace_path: path.resolve(workspace),
      }));
      fs.rmSync(workspace, { recursive: true, force: true });
    });

    it('clears fresh-install marker when onboarding completes', () => {
      const app = new SquidRunApp(mockAppContext, mockManagers);
      const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-fresh-marker-clear-'));
      const markerPath = app.writeFreshInstallMarker(workspace);

      expect(fs.existsSync(markerPath)).toBe(true);
      app.clearFreshInstallMarker(workspace);
      expect(fs.existsSync(markerPath)).toBe(false);
      fs.rmSync(workspace, { recursive: true, force: true });
    });
  });

  describe('getCurrentAppStatusSessionNumber', () => {
    it('reads session from canonical session field', () => {
      const app = new SquidRunApp(mockAppContext, mockManagers);
      mockManagers.settings.readAppStatus.mockReturnValue({ session: 147 });
      expect(app.getCurrentAppStatusSessionNumber()).toBe(147);
    });

    it('accepts legacy snake_case session_number field', () => {
      const app = new SquidRunApp(mockAppContext, mockManagers);
      mockManagers.settings.readAppStatus.mockReturnValue({ session_number: 148 });
      expect(app.getCurrentAppStatusSessionNumber()).toBe(148);
    });
  });

  describe('routeInjectMessage', () => {
    it('pre-chunks oversized inject messages before visible-window delivery', () => {
      const app = new SquidRunApp(mockAppContext, mockManagers);
      const sendToVisibleWindow = jest.spyOn(app, 'sendToVisibleWindow').mockReturnValue(true);
      const message = 'main-route-🙂-'.repeat(700);

      const routed = app.routeInjectMessage({
        panes: ['1'],
        message,
        deliveryId: 'delivery-route-1',
      });

      expect(routed).toBe(true);
      expect(sendToVisibleWindow).toHaveBeenCalled();

      const payloads = sendToVisibleWindow.mock.calls
        .filter(([channel]) => channel === 'inject-message')
        .map(([, payload]) => payload);

      expect(payloads.length).toBeGreaterThan(1);
      const reconstructed = payloads
        .slice()
        .sort((left, right) => left.ipcChunk.index - right.ipcChunk.index)
        .map((payload) => payload.message)
        .join('');

      expect(reconstructed).toBe(message);
      for (const payload of payloads) {
        expect(payload.messageBytes).toBe(Buffer.byteLength(payload.message, 'utf8'));
        expect(payload.meta).toEqual(expect.objectContaining({
          ipcChunked: true,
          ipcOriginalBytes: Buffer.byteLength(message, 'utf8'),
        }));
      }
      expect(payloads[0].ipcChunk).toEqual(expect.objectContaining({
        index: 0,
        count: payloads.length,
        totalBytes: Buffer.byteLength(message, 'utf8'),
      }));
    });

    it('routes pane-host inject IPC through the shared inject router and chunks long payloads', async () => {
      const { ipcMain } = require('electron');
      const watcher = require('../modules/watcher');
      const ipcHandlers = require('../modules/ipc-handlers');
      const pipeline = require('../modules/pipeline');
      const sharedState = require('../modules/shared-state');
      const contextCompressor = require('../modules/context-compressor');
      const app = new SquidRunApp(mockAppContext, mockManagers);
      app.ctx.currentSettings.hiddenPaneHostsEnabled = true;
      watcher.init = jest.fn();
      ipcHandlers.init = jest.fn();
      jest.spyOn(pipeline, 'init').mockImplementation(() => {});
      jest.spyOn(sharedState, 'init').mockImplementation(() => {});
      jest.spyOn(contextCompressor, 'init').mockImplementation(() => {});
      mockAppContext.setRecoveryManager = jest.fn((manager) => {
        mockAppContext.recoveryManager = manager;
      });
      mockAppContext.setPluginManager = jest.fn((manager) => {
        mockAppContext.pluginManager = manager;
      });
      mockAppContext.setBackupManager = jest.fn((manager) => {
        mockAppContext.backupManager = manager;
      });
      mockAppContext.mainWindow = {
        webContents: {
          send: jest.fn(),
          on: jest.fn(),
          openDevTools: jest.fn(),
        },
      };
      jest.spyOn(app, 'initRecoveryManager').mockReturnValue({});
      jest.spyOn(app, 'initPluginManager').mockReturnValue({ loadAll: jest.fn() });
      jest.spyOn(app, 'initBackupManager').mockReturnValue({});
      const sendPaneHostBridgeEvent = jest.spyOn(app, 'sendPaneHostBridgeEvent').mockReturnValue(true);
      const message = 'pane-host-route-🙂-'.repeat(700);
      const traceContext = { traceId: 'hm-pane-host-1' };
      const meta = { source: 'test' };
      app.paneHostReady = new Set(['1']);
      app.paneHostWindowManager.getPaneWindow = jest.fn(() => ({
        isDestroyed: jest.fn(() => false),
        webContents: {
          isDestroyed: jest.fn(() => false),
          isLoadingMainFrame: jest.fn(() => false),
        },
      }));

      app.initModules();

      const paneHostInjectHandler = ipcMain.handle.mock.calls
        .find(([channel]) => channel === 'pane-host-inject')?.[1];

      expect(typeof paneHostInjectHandler).toBe('function');

      const result = await paneHostInjectHandler({}, '1', {
        message,
        deliveryId: 'delivery-pane-host-1',
        traceContext,
        meta,
      });

      expect(result).toEqual({
        success: true,
        paneId: '1',
        mode: 'routed-inject',
      });

      const hostPayloads = sendPaneHostBridgeEvent.mock.calls
        .filter(([paneId, type]) => paneId === '1' && type === 'inject-message')
        .map(([, , payload]) => payload);

      expect(hostPayloads.length).toBeGreaterThan(1);
      const reconstructed = hostPayloads
        .slice()
        .sort((left, right) => left.ipcChunk.index - right.ipcChunk.index)
        .map((payload) => payload.message)
        .join('');
      expect(reconstructed).toBe(message);
      expect(hostPayloads[0]).toEqual(expect.objectContaining({
        deliveryId: 'delivery-pane-host-1',
        traceContext,
        meta: expect.objectContaining({
          source: 'test',
          ipcChunked: true,
          ipcOriginalBytes: Buffer.byteLength(message, 'utf8'),
        }),
      }));
    });
  });

  describe('createWindow startup ordering', () => {
    let app;

    beforeEach(() => {
      app = new SquidRunApp(mockAppContext, mockManagers);
      jest.spyOn(app, 'installMainWindowSendInterceptor').mockImplementation(() => {});
      jest.spyOn(app, 'ensurePaneHostReadyForwarder').mockImplementation(() => {});
      jest.spyOn(app, 'setupPermissions').mockImplementation(() => {});
      jest.spyOn(app, 'initModules').mockImplementation(() => {});
      jest.spyOn(app, 'setupWindowListeners').mockImplementation(() => {});
    });

    it('loads main window after core startup hooks are installed', async () => {
      await app.createWindow();

      const loadFile = app.ctx.mainWindow.loadFile;
      expect(loadFile).toHaveBeenCalledWith(
        expect.stringContaining('index.html'),
        expect.objectContaining({
          query: expect.objectContaining({
            windowKey: 'main',
            windowTeam: 'main',
          }),
        })
      );
      expect(app.initModules.mock.invocationCallOrder[0]).toBeLessThan(loadFile.mock.invocationCallOrder[0]);
      expect(app.setupWindowListeners.mock.invocationCallOrder[0]).toBeLessThan(loadFile.mock.invocationCallOrder[0]);
    });

    it('does not block createWindow on hidden pane host bootstrap', async () => {
      jest.useFakeTimers();
      const ensurePaneHostWindows = jest
        .spyOn(app, 'ensurePaneHostWindows')
        .mockImplementation(() => new Promise(() => {}));

      await expect(app.createWindow()).resolves.toBeUndefined();

      // Bootstrap is deferred; no pane-host startup should run until timer tick.
      expect(ensurePaneHostWindows).not.toHaveBeenCalled();
      jest.runOnlyPendingTimers();
      expect(ensurePaneHostWindows).toHaveBeenCalledTimes(1);
      jest.useRealTimers();
    });

    it('creates a second top-level window without replacing the main window', async () => {
      await app.createWindow();
      const primaryWindow = app.ctx.mainWindow;

      await app.createWindow({ windowKey: 'scoped', title: 'SquidRun - Scoped' });

      expect(app.ctx.mainWindow).toBe(primaryWindow);
      expect(app.ctx.setWindow).toHaveBeenCalledWith('scoped', expect.any(Object));
      const secondaryWindow = app.ctx.getWindow('scoped');
      expect(secondaryWindow).toBeTruthy();
      expect(secondaryWindow).not.toBe(primaryWindow);
      expect(secondaryWindow.loadFile).toHaveBeenCalledWith(
        expect.stringContaining('index.html'),
        expect.objectContaining({
          query: expect.objectContaining({
            windowKey: 'scoped',
            windowTeam: 'scoped',
          }),
        })
      );
    });

    it('routes visible-window sends to the requested secondary window without clobbering main', async () => {
      await app.createWindow();
      const primaryWindow = app.ctx.mainWindow;
      await app.createWindow({ windowKey: 'scoped', title: 'SquidRun - Scoped' });
      const secondaryWindow = app.ctx.getWindow('scoped');

      primaryWindow.webContents.send.mockClear();
      secondaryWindow.webContents.send.mockClear();

      const delivered = app.sendToVisibleWindow('inject-message', {
        panes: ['1'],
        message: 'case-only message',
        meta: {
          windowKey: 'scoped',
        },
      });

      expect(delivered).toBe(true);
      expect(secondaryWindow.webContents.send).toHaveBeenCalledWith(
        'inject-message',
        expect.objectContaining({
          message: 'case-only message',
        })
      );
      expect(primaryWindow.webContents.send).not.toHaveBeenCalled();
    });

    it('does not route scoped secondary-window injection through the main hidden pane host', async () => {
      app.ctx.currentSettings.hiddenPaneHostsEnabled = true;
      await app.createWindow();
      const primaryWindow = app.ctx.mainWindow;
      await app.createWindow({ windowKey: 'scoped', title: 'SquidRun - Scoped' });
      const secondaryWindow = app.ctx.getWindow('scoped');
      const sendPaneHostBridgeEvent = jest.spyOn(app, 'sendPaneHostBridgeEvent').mockReturnValue(true);

      app.paneHostReady = new Set(['1']);
      app.paneHostWindowManager.getPaneWindow = jest.fn(() => ({
        isDestroyed: jest.fn(() => false),
        webContents: {
          isDestroyed: jest.fn(() => false),
          isLoadingMainFrame: jest.fn(() => false),
        },
      }));
      primaryWindow.webContents.send.mockClear();
      secondaryWindow.webContents.send.mockClear();

      const routed = app.routeInjectMessage({
        panes: ['1'],
        message: '[Telegram from scoped]: hello',
        meta: {
          windowKey: 'scoped',
        },
      });

      expect(routed).toBe(true);
      expect(sendPaneHostBridgeEvent).not.toHaveBeenCalled();
      expect(app.paneHostWindowManager.getPaneWindow).not.toHaveBeenCalled();
      expect(secondaryWindow.webContents.send).toHaveBeenCalledWith(
        'inject-message',
        expect.objectContaining({
          message: '[Telegram from scoped]: hello',
          meta: expect.objectContaining({
            windowKey: 'scoped',
          }),
        })
      );
      expect(primaryWindow.webContents.send).not.toHaveBeenCalled();
    });

    it('launches only Scoped for standalone launch intent', async () => {
      await app.launchWindowsForProfile({
        windowKey: 'scoped',
        includeMainWindow: false,
      });

      const scopedWindow = app.ctx.getWindow('scoped');
      expect(scopedWindow).toBeTruthy();
      expect(app.ctx.getWindow('main')).toBe(scopedWindow);
      expect(scopedWindow.focus).toHaveBeenCalled();
    });

    it('broadcasts daemon lifecycle events to every open top-level window', async () => {
      await app.createWindow();
      await app.createWindow({ windowKey: 'scoped', title: 'SquidRun - Scoped' });
      const primaryWindow = app.ctx.getWindow('main');
      const secondaryWindow = app.ctx.getWindow('scoped');

      primaryWindow.webContents.send.mockClear();
      secondaryWindow.webContents.send.mockClear();

      const delivered = app.sendToAllWindows('daemon-connected', { terminals: [{ paneId: '1' }] });

      expect(delivered).toBe(true);
      expect(primaryWindow.webContents.send).toHaveBeenCalledWith(
        'daemon-connected',
        expect.objectContaining({
          terminals: [{ paneId: '1' }],
        })
      );
      expect(secondaryWindow.webContents.send).toHaveBeenCalledWith(
        'daemon-connected',
        expect.objectContaining({
          terminals: [{ paneId: '1' }],
        })
      );
    });

    it('closing the Scoped window does not trigger full shutdown while main stays alive', async () => {
      app.setupWindowListeners.mockRestore();
      const shutdownSpy = jest.spyOn(app, 'performFullShutdown').mockResolvedValue({ success: true });

      await app.createWindow();
      const primaryWindow = app.ctx.mainWindow;
      await app.createWindow({ windowKey: 'scoped', title: 'SquidRun - Scoped' });
      const secondaryWindow = app.ctx.getWindow('scoped');
      const closeHandler = secondaryWindow.on.mock.calls.find(([eventName]) => eventName === 'close')?.[1];
      const closedHandler = secondaryWindow.on.mock.calls.find(([eventName]) => eventName === 'closed')?.[1];

      expect(typeof closeHandler).toBe('function');
      expect(typeof closedHandler).toBe('function');

      const event = { preventDefault: jest.fn() };
      closeHandler(event);

      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(shutdownSpy).not.toHaveBeenCalled();

      closedHandler();

      expect(app.ctx.deleteWindow).toHaveBeenCalledWith('scoped');
      expect(app.ctx.mainWindow).toBe(primaryWindow);
    });

    it('replays daemon state to the Scoped window after load so the renderer can mount existing terminals', async () => {
      app.setupWindowListeners.mockRestore();
      mockAppContext.daemonClient = {
        connected: true,
        getTerminals: jest.fn(() => [{ paneId: '1', alive: true, scrollback: 'ready' }]),
      };
      jest.spyOn(app, 'injectScopedStartupBundle').mockResolvedValue({
        bundlePath: '/tmp/scoped-startup-bundle.md',
        sourcePaths: ['/tmp/case-operations.md'],
      });

      await app.createWindow();
      await app.createWindow({ windowKey: 'scoped', title: 'SquidRun - Scoped' });
      const secondaryWindow = app.ctx.getWindow('scoped');
      const didFinishLoad = secondaryWindow.webContents.on.mock.calls.find(([eventName]) => eventName === 'did-finish-load')?.[1];

      expect(typeof didFinishLoad).toBe('function');

      await didFinishLoad();

      expect(secondaryWindow.webContents.send).toHaveBeenCalledWith(
        'daemon-connected',
        expect.objectContaining({
          terminals: [{ paneId: '1', alive: true, scrollback: 'ready' }],
          windowKey: 'scoped',
        })
      );
    });

    it('still seeds Scoped runtime state when startup bundle materialization fails', async () => {
      app.setupWindowListeners.mockRestore();
      mockAppContext.daemonClient = {
        connected: true,
        getTerminals: jest.fn(() => [{ paneId: '1', alive: true, scrollback: 'ready' }]),
      };
      jest.spyOn(app, 'injectScopedStartupBundle').mockRejectedValue(new Error('bundle_missing'));

      await app.createWindow();
      await app.createWindow({ windowKey: 'scoped', title: 'SquidRun - Scoped' });
      const secondaryWindow = app.ctx.getWindow('scoped');
      const didFinishLoad = secondaryWindow.webContents.on.mock.calls.find(([eventName]) => eventName === 'did-finish-load')?.[1];

      expect(typeof didFinishLoad).toBe('function');

      await didFinishLoad();

      expect(secondaryWindow.webContents.send).toHaveBeenCalledWith(
        'window-context',
        expect.objectContaining({
          windowKey: 'scoped',
          startupBundlePath: null,
          startupSourceFiles: [],
        })
      );
      expect(secondaryWindow.webContents.send).toHaveBeenCalledWith(
        'daemon-connected',
        expect.objectContaining({
          terminals: [{ paneId: '1', alive: true, scrollback: 'ready' }],
          windowKey: 'scoped',
        })
      );
    });

    it('can register Scoped as the lifecycle root for standalone launch mode', async () => {
      await app.createWindow({
        windowKey: 'scoped',
        title: 'SquidRun - Scoped',
        lifecycleRoot: true,
      });

      expect(app.ctx.setMainWindow).toHaveBeenCalledWith(expect.any(Object));
      expect(app.ctx.mainWindow).toBe(app.ctx.getWindow('scoped'));
    });
  });

  describe('pane host bootstrap verification', () => {
    let app;

    beforeEach(() => {
      jest.useFakeTimers();
      app = new SquidRunApp(mockAppContext, mockManagers);
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('waits while the hidden pane host is still loading', () => {
      app.ctx.currentSettings.hiddenPaneHostsEnabled = true;
      app.paneHostWindowManager.getWindowDiagnostics = jest.fn(() => ({
        loading: true,
        paneIds: ['1', '2', '3'],
        lastLoadStartedAt: Date.now(),
      }));
      app.paneHostWindowManager.getPaneWindow = jest.fn(() => ({ webContents: {} }));
      const degradedSpy = jest.spyOn(app, 'reportPaneHostDegraded');

      app.verifyPaneHostWindowsAfterBootstrap('test_loading');

      expect(degradedSpy).not.toHaveBeenCalled();
      expect(app.paneHostBootstrapVerifyTimer).toBeTruthy();
    });

    it('gives the hidden pane host a short post-load grace window for ready signals', () => {
      app.ctx.currentSettings.hiddenPaneHostsEnabled = true;
      app.paneHostWindowManager.getWindowDiagnostics = jest.fn(() => ({
        loading: false,
        paneIds: ['1', '2', '3'],
        lastDidFinishLoadAt: Date.now(),
      }));
      app.paneHostWindowManager.getPaneWindow = jest.fn(() => ({ webContents: {} }));
      const degradedSpy = jest.spyOn(app, 'reportPaneHostDegraded');

      app.verifyPaneHostWindowsAfterBootstrap('test_ready_wait');

      expect(degradedSpy).not.toHaveBeenCalled();
      expect(app.paneHostBootstrapVerifyTimer).toBeTruthy();
    });

    it('clears stale degraded pane-host status once verification succeeds', () => {
      app.ctx.currentSettings.hiddenPaneHostsEnabled = true;
      app.paneHostMissingPanes = new Set(['1', '2', '3']);
      app.paneHostLastErrorReason = 'bootstrap_ready_signal_missing';
      app.paneHostLastErrorAt = '2026-04-03T00:00:00.000Z';
      app.paneHostReady = new Set(['1', '2', '3']);
      app.paneHostWindowManager.getWindowDiagnostics = jest.fn(() => ({
        loading: false,
        paneIds: ['1', '2', '3'],
      }));
      app.paneHostWindowManager.getPaneWindow = jest.fn(() => ({ webContents: {} }));

      app.verifyPaneHostWindowsAfterBootstrap('test_verified');

      expect(Array.from(app.paneHostMissingPanes)).toEqual([]);
      expect(app.paneHostLastErrorReason).toBeNull();
      expect(app.paneHostLastErrorAt).toBeNull();
    });
  });

  describe('Scoped window startup bundle', () => {
    let app;

    beforeEach(() => {
      app = new SquidRunApp(mockAppContext, mockManagers);
      jest.spyOn(app, 'installMainWindowSendInterceptor').mockImplementation(() => {});
      jest.spyOn(app, 'ensurePaneHostReadyForwarder').mockImplementation(() => {});
      jest.spyOn(app, 'setupPermissions').mockImplementation(() => {});
      jest.spyOn(app, 'initModules').mockImplementation(() => {});
      jest.spyOn(app, 'initPostLoad').mockResolvedValue();
    });

    it('injects the Scoped startup bundle only into the Scoped window panes with a scoped session id', async () => {
      const routeSpy = jest.spyOn(app, 'routeInjectMessage').mockReturnValue(true);
      const bundleSpy = jest.spyOn(app, 'writeScopedStartupBundle').mockReturnValue({
        bundlePath: 'D:\\projects\\squidrun\\.squidrun\\runtime\\window-teams\\scoped\\startup-bundle.md',
        sourcePaths: ['D:\\projects\\squidrun\\workspace\\knowledge\\case-operations.md'],
        text: 'Scoped startup bundle',
        sessionScopeId: 'app-test:scoped',
      });

      await app.createWindow({ windowKey: 'scoped', title: 'SquidRun - Scoped' });
      const secondaryWindow = app.ctx.getWindow('scoped');
      const didFinishLoad = secondaryWindow.webContents.on.mock.calls.find(([eventName]) => eventName === 'did-finish-load')?.[1];

      expect(typeof didFinishLoad).toBe('function');

      await didFinishLoad();

      expect(bundleSpy).toHaveBeenCalledTimes(1);
      expect(routeSpy).toHaveBeenCalledTimes(3);
      expect(routeSpy).toHaveBeenNthCalledWith(1, expect.objectContaining({
        panes: ['1'],
        startupInjection: true,
        meta: expect.objectContaining({
          windowKey: 'scoped',
          session_id: 'app-test:scoped',
          contextBundle: 'scoped',
        }),
      }));
      expect(routeSpy).toHaveBeenNthCalledWith(2, expect.objectContaining({ panes: ['2'] }));
      expect(routeSpy).toHaveBeenNthCalledWith(3, expect.objectContaining({ panes: ['3'] }));
      expect(secondaryWindow.webContents.send).toHaveBeenCalledWith(
        'window-context',
        expect.objectContaining({
          windowKey: 'scoped',
          sessionScopeId: app.getWindowSessionScopeId('scoped'),
          startupBundlePath: 'D:\\projects\\squidrun\\.squidrun\\runtime\\window-teams\\scoped\\startup-bundle.md',
          autoBootAgents: true,
        })
      );
    });

    it('does not inject the Scoped startup bundle on the main window load path', async () => {
      const bundleSpy = jest.spyOn(app, 'writeScopedStartupBundle').mockReturnValue({
        bundlePath: 'ignored',
        sourcePaths: [],
        text: 'ignored',
        sessionScopeId: 'ignored',
      });

      await app.createWindow();
      const primaryWindow = app.ctx.mainWindow;
      const didFinishLoad = primaryWindow.webContents.on.mock.calls.find(([eventName]) => eventName === 'did-finish-load')?.[1];

      expect(typeof didFinishLoad).toBe('function');

      await didFinishLoad();

      expect(bundleSpy).not.toHaveBeenCalled();
    });
  });

  describe('lazy worker initialization', () => {
    it('does not prewarm non-critical runtimes during init', async () => {
      const app = new SquidRunApp(mockAppContext, mockManagers);
      const evidenceLedger = require('../modules/ipc/evidence-ledger-handlers');
      const teamMemory = require('../modules/team-memory');
      const experiment = require('../modules/experiment');

      app.initDaemonClient = jest.fn().mockResolvedValue();
      app.createWindow = jest.fn().mockResolvedValue();
      app.startSmsPoller = jest.fn();
      app.startTelegramPoller = jest.fn();
      app.initializeStartupSessionScope = jest.fn().mockResolvedValue(null);

      await app.init();

      expect(evidenceLedger.initializeEvidenceLedgerRuntime).not.toHaveBeenCalled();
      expect(teamMemory.initializeTeamMemoryRuntime).not.toHaveBeenCalled();
      expect(experiment.initializeExperimentRuntime).not.toHaveBeenCalled();
      // initializeStartupSessionScope is always called now (session always increments on app launch)
    });

    it('writes startup health artifacts without forcing team memory init', async () => {
      const app = new SquidRunApp(mockAppContext, mockManagers);
      const evidenceLedger = require('../modules/ipc/evidence-ledger-handlers');
      const { createHealthSnapshot } = require('../scripts/hm-health-snapshot');
      const teamMemory = require('../modules/team-memory');
      createHealthSnapshot.mockReturnValueOnce({
        generatedAt: '2026-03-13T00:00:00.000Z',
        appStatus: {
          sessionNumber: 147,
          sessionId: 'app-session-147',
        },
        tests: {
          testFileCount: 194,
          jestList: { ok: true, count: 195 },
        },
        modules: {
          moduleFileCount: 300,
          keyModules: {
            recovery_manager: { exists: true },
            background_agent_manager: { exists: true },
            scheduler: { exists: true },
          },
        },
        databases: {
          evidenceLedger: { exists: true, rowCount: 100 },
          cognitiveMemory: { exists: true, rowCount: 4 },
        },
        bridge: {
          enabled: true,
          configured: true,
          mode: 'connected',
          running: true,
          relayUrl: 'wss://relay.example.test',
          deviceId: 'LOCAL',
          state: 'connected',
        },
        status: { level: 'ok', warnings: [] },
      });
      evidenceLedger.executeEvidenceLedgerOperation.mockResolvedValueOnce({
        session: 147,
        status: 'ACTIVE',
        mode: 'APP',
        completed: ['Shipped memory v0.1.31'],
        roadmap: ['Wire startup truth'],
        important_notes: ['Regression coverage exists'],
      });
      const writeFileAtomic = jest.spyOn(app, 'writeFileAtomic').mockReturnValue(true);

      const result = await app.refreshStartupHealthArtifacts({
        sessionNumber: 147,
      });

      expect(result).toEqual(expect.objectContaining({
        ok: true,
        ingestResult: expect.objectContaining({
          skipped: true,
          reason: 'team_memory_not_initialized',
        }),
      }));
      expect(writeFileAtomic).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('startup-health.md'),
        expect.stringContaining('Snapshot status: refreshing current-session startup health...')
      );
      expect(writeFileAtomic).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('startup-health.md'),
        expect.stringContaining('STARTUP LEDGER')
      );
      expect(createHealthSnapshot).toHaveBeenCalledWith(expect.objectContaining({
        projectRoot: '/test',
        jestTimeoutMs: undefined,
        bridgeStatus: expect.any(Object),
        nowMs: expect.any(Number),
        generatedAt: expect.any(String),
      }));
      expect(createHealthSnapshot.mock.calls[0][0].bridgeStatus).toEqual(expect.objectContaining({
        state: expect.any(String),
      }));
      expect(teamMemory.initializeTeamMemoryRuntime).not.toHaveBeenCalled();
    });

    it('anchors startup ledger session context to app-status when ledger context is stale', async () => {
      const app = new SquidRunApp(mockAppContext, mockManagers);
      const evidenceLedger = require('../modules/ipc/evidence-ledger-handlers');
      const { createHealthSnapshot } = require('../scripts/hm-health-snapshot');
      createHealthSnapshot.mockReturnValueOnce({
        generatedAt: '2026-03-13T00:00:00.000Z',
        appStatus: {
          sessionNumber: 230,
          sessionId: 'app-session-230',
        },
        tests: {
          testFileCount: 194,
          jestList: { ok: true, count: 195 },
        },
        modules: {
          moduleFileCount: 300,
          keyModules: {
            recovery_manager: { exists: true },
          },
        },
        databases: {
          evidenceLedger: { exists: true, rowCount: 100 },
          cognitiveMemory: { exists: true, rowCount: 4 },
        },
        bridge: {
          enabled: true,
          configured: true,
          mode: 'connected',
          running: true,
          relayUrl: 'wss://relay.example.test',
          deviceId: 'LOCAL',
          state: 'connected',
        },
        status: { level: 'ok', warnings: [] },
      });
      evidenceLedger.executeEvidenceLedgerOperation.mockResolvedValueOnce({
        session: 228,
        status: 'ACTIVE',
        mode: 'APP',
        completed: ['Old completion'],
      });
      const writeFileAtomic = jest.spyOn(app, 'writeFileAtomic').mockReturnValue(true);

      await app.refreshStartupHealthArtifacts({
        sessionNumber: 230,
      });

      expect(evidenceLedger.executeEvidenceLedgerOperation).toHaveBeenCalledWith(
        'get-context',
        { sessionNumber: 230 },
        expect.any(Object)
      );
      expect(writeFileAtomic).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('startup-health.md'),
        expect.stringContaining('Session context: session 230 ACTIVE (APP)')
      );
      expect(writeFileAtomic).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('startup-health.md'),
        expect.stringContaining('Session context: session 230 ACTIVE (APP)')
      );
    });

    it('writes a fresh current-session placeholder before probing startup health', async () => {
      const app = new SquidRunApp(mockAppContext, mockManagers);
      const { createHealthSnapshot } = require('../scripts/hm-health-snapshot');
      createHealthSnapshot.mockImplementationOnce(() => {
        throw new Error('snapshot probe failed');
      });
      const writeFileAtomic = jest.spyOn(app, 'writeFileAtomic').mockReturnValue(true);

      await expect(app.refreshStartupHealthArtifacts({
        sessionNumber: 234,
        nowMs: Date.parse('2026-03-17T07:50:00.000Z'),
      })).rejects.toThrow('snapshot probe failed');

      expect(writeFileAtomic).toHaveBeenCalledTimes(1);
      expect(writeFileAtomic).toHaveBeenCalledWith(
        expect.stringContaining('startup-health.md'),
        expect.stringContaining('Generated: 2026-03-17T07:50:00.000Z')
      );
      expect(writeFileAtomic).toHaveBeenCalledWith(
        expect.stringContaining('startup-health.md'),
        expect.stringContaining('App Session: session 234')
      );
    });

    it('parses autonomous smoke JSON summaries even with surrounding stdout noise', async () => {
      const app = new SquidRunApp(mockAppContext, mockManagers);
      app.resolveAutonomousSmokeProjectPath = jest.fn(() => '/tmp/project');
      app.runAutonomousSmokeSidecar = jest.fn().mockResolvedValue({
        ok: true,
        status: 'ok',
        code: 0,
        signal: null,
        timedOut: false,
        stdout: [
          '[dotenv@17.2.3] injecting env (0) from .env',
          '{',
          '  "ok": true,',
          '  "runId": "run-99",',
          '  "url": "http://localhost:3000"',
          '}',
          'post-run note',
        ].join('\n'),
        stderr: '',
      });
      app.reportAutonomousSmokeSummary = jest.fn().mockResolvedValue({ ok: true });

      app.runAutonomousSmokeInBackground({
        runId: 'run-99',
        senderRole: 'builder',
      });

      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(app.reportAutonomousSmokeSummary).toHaveBeenCalledWith(
        expect.objectContaining({
          ok: true,
          runId: 'run-99',
          url: 'http://localhost:3000',
          runner: expect.objectContaining({
            status: 'ok',
            exitCode: 0,
          }),
        }),
        expect.objectContaining({
          runId: 'run-99',
          senderRole: 'builder',
        })
      );
    });

    it('suppresses autonomous smoke injection noise when runner returns no structured JSON', async () => {
      const app = new SquidRunApp(mockAppContext, mockManagers);
      app.resolveAutonomousSmokeProjectPath = jest.fn(() => '/tmp/project');
      app.runAutonomousSmokeSidecar = jest.fn().mockResolvedValue({
        ok: false,
        status: 'runner_failed',
        code: 1,
        signal: null,
        timedOut: false,
        stdout: '[dotenv@17.2.3] injecting env (0) from .env',
        stderr: 'no runnable smoke target',
      });
      app.reportAutonomousSmokeSummary = jest.fn().mockResolvedValue({ ok: true });

      app.runAutonomousSmokeInBackground({
        runId: 'run-100',
        senderRole: 'builder',
      });

      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(app.reportAutonomousSmokeSummary).not.toHaveBeenCalled();
    });

    it('runs firmware startup generation hook during init', async () => {
      const app = new SquidRunApp(mockAppContext, mockManagers);

      app.initDaemonClient = jest.fn().mockResolvedValue();
      app.createWindow = jest.fn().mockResolvedValue();
      app.startSmsPoller = jest.fn();
      app.startTelegramPoller = jest.fn();
      app.initializeStartupSessionScope = jest.fn().mockResolvedValue(null);

      await app.init();

      expect(mockManagers.firmwareManager.ensureStartupFirmwareIfEnabled).toHaveBeenCalledTimes(1);
      expect(mockManagers.firmwareManager.ensureStartupFirmwareIfEnabled).toHaveBeenCalledWith({ preflight: true });
    });

    it('kicks off startup ai briefing generation during init', async () => {
      const app = new SquidRunApp(mockAppContext, mockManagers);
      const startupBriefing = require('../modules/startup-ai-briefing');

      app.initDaemonClient = jest.fn().mockResolvedValue();
      app.createWindow = jest.fn().mockResolvedValue();
      app.startSmsPoller = jest.fn();
      app.startTelegramPoller = jest.fn();
      app.initializeStartupSessionScope = jest.fn().mockResolvedValue(null);

      await app.init();

      expect(startupBriefing.generateStartupBriefing).toHaveBeenCalledWith(expect.objectContaining({
        projectRoot: '/test',
        source: 'app-init',
      }));
    });

    it('always increments session and initializes startup scope on app launch', async () => {
      const app = new SquidRunApp(mockAppContext, mockManagers);

      app.initDaemonClient = jest.fn().mockImplementation(async () => {
        mockAppContext.daemonClient = {};
      });
      app.createWindow = jest.fn().mockResolvedValue();
      app.startSmsPoller = jest.fn();
      app.startTelegramPoller = jest.fn();
      app.initializeStartupSessionScope = jest.fn().mockResolvedValue(null);

      await app.init();

      expect(mockManagers.settings.writeAppStatus).toHaveBeenCalledWith(
        expect.objectContaining({ incrementSession: true })
      );
      expect(app.initializeStartupSessionScope).toHaveBeenCalledWith(
        expect.objectContaining({ sessionNumber: 147 })
      );
    });

    it('initializes team memory lazily on first pattern append', async () => {
      const app = new SquidRunApp(mockAppContext, mockManagers);
      const teamMemory = require('../modules/team-memory');

      await app.appendTeamMemoryPatternEvent({ eventType: 'test.pattern' }, 'test');

      expect(teamMemory.initializeTeamMemoryRuntime).toHaveBeenCalledTimes(1);
      expect(teamMemory.appendPatternHookEvent).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'test.pattern' })
      );
    });

    it('initializes experiment lazily for guard block dispatch', async () => {
      const app = new SquidRunApp(mockAppContext, mockManagers);
      const experiment = require('../modules/experiment');

      const result = await app.handleTeamMemoryGuardExperiment({
        action: 'block',
        guardId: 'grd_lazy',
        event: {
          claimId: 'claim_lazy',
          status: 'contested',
          session: 's_lazy',
        },
      });

      expect(result.ok).toBe(true);
      expect(experiment.initializeExperimentRuntime).toHaveBeenCalledTimes(1);
      expect(experiment.executeExperimentOperation).toHaveBeenCalledWith(
        'run-experiment',
        expect.objectContaining({
          claimId: 'claim_lazy',
        })
      );
    });
  });

  describe('supervisor bootstrap', () => {
    function createSupervisorRuntimeFixture() {
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-supervisor-'));
      const runtimeDir = path.join(tempRoot, 'runtime');
      fs.mkdirSync(runtimeDir, { recursive: true });
      const daemonScriptPath = path.join(tempRoot, 'supervisor-daemon.js');
      fs.writeFileSync(daemonScriptPath, '// supervisor fixture\n');
      return {
        tempRoot,
        daemonScriptPath,
        pidPath: path.join(runtimeDir, 'supervisor.pid'),
        statusPath: path.join(runtimeDir, 'supervisor-status.json'),
        logPath: path.join(runtimeDir, 'supervisor.log'),
      };
    }

    it('spawns the detached supervisor during init when none is healthy', async () => {
      const app = new SquidRunApp(mockAppContext, mockManagers);
      const runtimePaths = createSupervisorRuntimeFixture();

      jest.spyOn(app, 'getSupervisorRuntimePaths').mockReturnValue(runtimePaths);
      jest.spyOn(app, 'isProcessAlive').mockReturnValue(false);
      app.initDaemonClient = jest.fn().mockResolvedValue();
      app.createWindow = jest.fn().mockResolvedValue();
      app.startSmsPoller = jest.fn();
      app.startTelegramPoller = jest.fn();
      app.initializeStartupSessionScope = jest.fn().mockResolvedValue(null);

      await app.init();

      expect(spawn).toHaveBeenCalledTimes(1);
      const [spawnPath, spawnArgs, spawnOptions] = spawn.mock.calls[0];
      expect(spawnPath).toBe(process.execPath);
      expect(spawnArgs).toEqual([
        runtimePaths.daemonScriptPath,
        '--pid-path',
        runtimePaths.pidPath,
        '--status-path',
        runtimePaths.statusPath,
        '--log-path',
        runtimePaths.logPath,
      ]);
      expect(spawnOptions).toMatchObject({
        cwd: '/test',
        detached: true,
        windowsHide: true,
        stdio: 'ignore',
      });

      fs.rmSync(runtimePaths.tempRoot, { recursive: true, force: true });
    });

    it('uses system node instead of electron to launch the supervisor daemon', () => {
      const app = new SquidRunApp(mockAppContext, mockManagers);
      const runtimePaths = createSupervisorRuntimeFixture();
      const originalExecPath = process.execPath;
      const originalVersions = process.versions;

      jest.spyOn(app, 'getSupervisorRuntimePaths').mockReturnValue(runtimePaths);

      Object.defineProperty(process, 'execPath', {
        configurable: true,
        writable: true,
        value: 'D:\\projects\\squidrun\\ui\\node_modules\\electron\\dist\\electron.exe',
      });
      Object.defineProperty(process, 'versions', {
        configurable: true,
        value: {
          ...originalVersions,
          electron: '35.0.0',
        },
      });

      try {
        const result = app.spawnSupervisorDaemon('test-electron-runtime');

        expect(result).toEqual(expect.objectContaining({
          ok: true,
          spawned: true,
        }));
        expect(spawn).toHaveBeenCalledWith(
          process.platform === 'win32' ? 'node.exe' : 'node',
          [
            runtimePaths.daemonScriptPath,
            '--pid-path',
            runtimePaths.pidPath,
            '--status-path',
            runtimePaths.statusPath,
            '--log-path',
            runtimePaths.logPath,
          ],
          expect.objectContaining({
            cwd: '/test',
            detached: true,
            windowsHide: true,
            stdio: 'ignore',
          })
        );
        expect(spawn.mock.calls[0][2].env.ELECTRON_RUN_AS_NODE).toBeUndefined();
      } finally {
        Object.defineProperty(process, 'execPath', {
          configurable: true,
          writable: true,
          value: originalExecPath,
        });
        Object.defineProperty(process, 'versions', {
          configurable: true,
          value: originalVersions,
        });
        fs.rmSync(runtimePaths.tempRoot, { recursive: true, force: true });
      }
    });

    it('cleans stale supervisor pid and status artifacts before respawn', async () => {
      const app = new SquidRunApp(mockAppContext, mockManagers);
      const runtimePaths = createSupervisorRuntimeFixture();
      const stalePid = 9876;
      const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true);

      fs.writeFileSync(runtimePaths.pidPath, JSON.stringify({ pid: stalePid }, null, 2));
      fs.writeFileSync(runtimePaths.statusPath, JSON.stringify({
        heartbeatAtMs: Date.now() - 120000,
        pollMs: 4000,
      }, null, 2));

      jest.spyOn(app, 'getSupervisorRuntimePaths').mockReturnValue(runtimePaths);
      jest.spyOn(app, 'isProcessAlive').mockImplementation((pid) => Number(pid) === stalePid);

      const result = await app.ensureSupervisorDaemonRunning('test-stale');

      expect(result).toEqual(expect.objectContaining({
        ok: true,
        spawned: true,
        cleaned: expect.objectContaining({
          processKilled: true,
          pidFileRemoved: true,
          statusFileRemoved: true,
        }),
      }));
      expect(killSpy).toHaveBeenCalledWith(stalePid, 'SIGTERM');
      expect(fs.existsSync(runtimePaths.pidPath)).toBe(false);
      expect(fs.existsSync(runtimePaths.statusPath)).toBe(false);
      expect(spawn).toHaveBeenCalledTimes(1);

      killSpy.mockRestore();
      fs.rmSync(runtimePaths.tempRoot, { recursive: true, force: true });
    });

    it('does not respawn a healthy supervisor with a fresh heartbeat', async () => {
      const app = new SquidRunApp(mockAppContext, mockManagers);
      const runtimePaths = createSupervisorRuntimeFixture();
      const livePid = 2468;

      fs.writeFileSync(runtimePaths.pidPath, JSON.stringify({ pid: livePid }, null, 2));
      fs.writeFileSync(runtimePaths.statusPath, JSON.stringify({
        heartbeatAtMs: Date.now() - 1000,
        pollMs: 4000,
      }, null, 2));

      jest.spyOn(app, 'getSupervisorRuntimePaths').mockReturnValue(runtimePaths);
      jest.spyOn(app, 'isProcessAlive').mockImplementation((pid) => Number(pid) === livePid);

      const result = await app.ensureSupervisorDaemonRunning('test-healthy');

      expect(result).toEqual(expect.objectContaining({
        ok: true,
        alreadyRunning: true,
        pid: livePid,
      }));
      expect(spawn).not.toHaveBeenCalled();

      fs.rmSync(runtimePaths.tempRoot, { recursive: true, force: true });
    });
  });

  describe('cognitive memory runtime integration', () => {
    it('routes websocket cognitive-memory messages into the runtime handler', async () => {
      const app = new SquidRunApp(mockAppContext, mockManagers);
      const websocketServer = require('../modules/websocket-server');
      const { executeCognitiveMemoryOperation } = require('../modules/ipc/cognitive-memory-handlers');

      app.initDaemonClient = jest.fn().mockResolvedValue();
      app.createWindow = jest.fn().mockResolvedValue();
      app.startSmsPoller = jest.fn();
      app.startTelegramPoller = jest.fn();
      app.initializeStartupSessionScope = jest.fn().mockResolvedValue(null);
      jest.spyOn(app, 'ensureSupervisorDaemonRunning').mockResolvedValue({ ok: true, alreadyRunning: true });

      await app.init();

      const startCall = websocketServer.start.mock.calls[0];
      expect(startCall).toBeTruthy();
      const options = startCall[0];

      await options.onMessage({
        role: 'builder',
        paneId: '2',
        message: {
          type: 'cognitive-memory',
          action: 'retrieve',
          payload: {
            query: 'ServiceTitan auth endpoint',
            limit: 2,
          },
        },
      });

      expect(executeCognitiveMemoryOperation).toHaveBeenCalledWith(
        'retrieve',
        expect.objectContaining({
          query: 'ServiceTitan auth endpoint',
          limit: 2,
        }),
        expect.objectContaining({
          source: expect.objectContaining({
            via: 'websocket',
            role: 'builder',
            paneId: '2',
          }),
        })
      );
    });
  });

  describe('websocket local delivery journaling', () => {
    async function initWebSocketApp() {
      const app = new SquidRunApp(mockAppContext, mockManagers);
      const websocketServer = require('../modules/websocket-server');
      const triggers = require('../modules/triggers');
      const evidenceLedger = require('../modules/ipc/evidence-ledger-handlers');

      app.initDaemonClient = jest.fn().mockResolvedValue();
      app.createWindow = jest.fn().mockResolvedValue();
      app.startSmsPoller = jest.fn();
      app.startTelegramPoller = jest.fn();
      app.initializeStartupSessionScope = jest.fn().mockResolvedValue(null);
      jest.spyOn(app, 'ensureSupervisorDaemonRunning').mockResolvedValue({ ok: true, alreadyRunning: true });

      evidenceLedger.executeEvidenceLedgerOperation.mockResolvedValue({ ok: true });

      await app.init();

      const options = websocketServer.start.mock.calls.at(-1)?.[0];
      expect(typeof options?.onMessage).toBe('function');

      return { app, options, triggers, evidenceLedger };
    }

    it('finalizes comms journal rows as acked after verified local pane delivery', async () => {
      const { options, triggers, evidenceLedger } = await initWebSocketApp();
      triggers.sendDirectMessage.mockResolvedValueOnce({
        accepted: true,
        queued: true,
        verified: true,
        status: 'delivered.verified',
        deliveryId: 'delivery-acked-1',
        mode: 'pty',
        notified: ['1'],
      });

      await options.onMessage({
        role: 'oracle',
        paneId: '3',
        traceContext: { traceId: 'hm-acked-1' },
        message: {
          type: 'send',
          target: 'architect',
          content: '(ORACLE #1): verified delivery test',
          messageId: 'hm-acked-1',
        },
      });

      const commsJournalCalls = evidenceLedger.executeEvidenceLedgerOperation.mock.calls
        .filter((call) => call[0] === 'upsert-comms-journal');
      expect(commsJournalCalls[0]).toEqual([
        'upsert-comms-journal',
        expect.objectContaining({
          messageId: 'hm-acked-1',
          status: 'brokered',
        }),
        expect.any(Object),
      ]);
      expect(commsJournalCalls[1]).toEqual([
        'upsert-comms-journal',
        expect.objectContaining({
          messageId: 'hm-acked-1',
          status: 'acked',
          ackStatus: 'delivered.verified',
          errorCode: null,
          metadata: expect.objectContaining({
            source: 'websocket-local-trigger-delivery',
            paneId: '1',
            deliveryId: 'delivery-acked-1',
            finalOutcome: 'delivered.verified',
            deliveryAccepted: true,
            deliveryVerified: true,
          }),
        }),
        expect.any(Object),
      ]);
    });

    it('finalizes comms journal rows as routed for accepted but unverified local delivery timeouts', async () => {
      const { options, triggers, evidenceLedger } = await initWebSocketApp();
      triggers.sendDirectMessage.mockResolvedValueOnce({
        accepted: true,
        queued: true,
        verified: false,
        status: 'routed_unverified_timeout',
        deliveryId: 'delivery-routed-1',
        mode: 'pty',
        notified: ['1'],
        details: {
          failureReason: 'accepted.unverified',
        },
      });

      await options.onMessage({
        role: 'oracle',
        paneId: '3',
        traceContext: { traceId: 'hm-routed-1' },
        message: {
          type: 'send',
          target: 'architect',
          content: '(ORACLE #2): timeout delivery test',
          messageId: 'hm-routed-1',
        },
      });

      const commsJournalCalls = evidenceLedger.executeEvidenceLedgerOperation.mock.calls
        .filter((call) => call[0] === 'upsert-comms-journal');
      expect(commsJournalCalls[1]).toEqual([
        'upsert-comms-journal',
        expect.objectContaining({
          messageId: 'hm-routed-1',
          status: 'routed',
          ackStatus: 'routed_unverified_timeout',
          errorCode: null,
          metadata: expect.objectContaining({
            source: 'websocket-local-trigger-delivery',
            deliveryId: 'delivery-routed-1',
            finalOutcome: 'routed_unverified_timeout',
            deliveryAccepted: true,
            deliveryVerified: false,
            failureReason: 'accepted.unverified',
          }),
        }),
        expect.any(Object),
      ]);
    });

    it('finalizes comms journal rows as failed when local pane delivery is rejected', async () => {
      const { options, triggers, evidenceLedger } = await initWebSocketApp();
      triggers.sendDirectMessage.mockResolvedValueOnce({
        accepted: false,
        queued: false,
        verified: false,
        status: 'window_unavailable',
        reason: 'main_window_unavailable',
        deliveryId: 'delivery-failed-1',
        mode: 'pty',
        notified: [],
      });

      await options.onMessage({
        role: 'oracle',
        paneId: '3',
        traceContext: { traceId: 'hm-failed-1' },
        message: {
          type: 'send',
          target: 'architect',
          content: '(ORACLE #3): failed delivery test',
          messageId: 'hm-failed-1',
        },
      });

      const commsJournalCalls = evidenceLedger.executeEvidenceLedgerOperation.mock.calls
        .filter((call) => call[0] === 'upsert-comms-journal');
      expect(commsJournalCalls[1]).toEqual([
        'upsert-comms-journal',
        expect.objectContaining({
          messageId: 'hm-failed-1',
          status: 'failed',
          ackStatus: 'window_unavailable',
          errorCode: 'main_window_unavailable',
          metadata: expect.objectContaining({
            source: 'websocket-local-trigger-delivery',
            deliveryId: 'delivery-failed-1',
            finalOutcome: 'window_unavailable',
            deliveryAccepted: false,
            deliveryVerified: false,
          }),
        }),
        expect.any(Object),
      ]);
    });

    it('injects a watchdog alert when architect gets no response from builder within 90 seconds', () => {
      jest.useFakeTimers();
      resolveRuntimeInt.mockImplementation((key, fallback) => (
        key === 'agentResponseWatchdogMs' ? 90 * 1000 : fallback
      ));
      const app = new SquidRunApp(mockAppContext, mockManagers);
      const triggers = require('../modules/triggers');

      app.scheduleAgentResponseWatchdog({
        senderRole: 'architect',
        targetRole: 'builder',
        content: '[TASK] Fix the delivery pipeline.',
        sentAtMs: new Date('2026-03-28T10:15:00').getTime(),
      });

      jest.advanceTimersByTime(90 * 1000);

      expect(spawn).toHaveBeenCalledWith(
        'node',
        expect.arrayContaining([
          expect.stringContaining(path.join('scripts', 'hm-send.js')),
          'architect',
          expect.stringContaining('(SYSTEM WATCHDOG): [WATCHDOG] No response from builder for task sent at 10:15. Check if task was received.'),
          '--role',
          'system',
        ]),
        expect.objectContaining({
          windowsHide: true,
        })
      );
      expect(triggers.sendDirectMessage).not.toHaveBeenCalled();

      jest.useRealTimers();
    });

    it('uses hot-reloaded runtime config for the agent response watchdog timeout', () => {
      jest.useFakeTimers();
      resolveRuntimeInt.mockImplementation((key, fallback) => (
        key === 'agentResponseWatchdogMs' ? 45 * 1000 : fallback
      ));
      const app = new SquidRunApp(mockAppContext, mockManagers);
      const triggers = require('../modules/triggers');

      app.scheduleAgentResponseWatchdog({
        senderRole: 'architect',
        targetRole: 'builder',
        content: '[TASK] Fix the delivery pipeline.',
        sentAtMs: new Date('2026-03-28T10:15:00').getTime(),
      });

      jest.advanceTimersByTime(44 * 1000);
      expect(triggers.sendDirectMessage).not.toHaveBeenCalled();

      jest.advanceTimersByTime(1000);
      expect(spawn).toHaveBeenCalledWith(
        'node',
        expect.arrayContaining([
          expect.stringContaining(path.join('scripts', 'hm-send.js')),
          'architect',
          expect.stringContaining('(SYSTEM WATCHDOG): [WATCHDOG] No response from builder for task sent at 10:15. Check if task was received.'),
          '--role',
          'system',
        ]),
        expect.objectContaining({
          windowsHide: true,
        })
      );

      jest.useRealTimers();
    });

    it('cancels the watchdog after an accepted builder response to architect', () => {
      jest.useFakeTimers();
      const app = new SquidRunApp(mockAppContext, mockManagers);
      const triggers = require('../modules/triggers');

      app.scheduleAgentResponseWatchdog({
        senderRole: 'architect',
        targetRole: 'builder',
        content: '[TASK] Fix the delivery pipeline.',
        sentAtMs: new Date('2026-03-28T10:15:00').getTime(),
      });
      app.maybeResolveAgentResponseWatchdog({
        senderRole: 'builder',
        targetRole: 'architect',
        deliveryAccepted: true,
      });

      jest.advanceTimersByTime(90 * 1000);

      expect(triggers.sendDirectMessage).not.toHaveBeenCalled();

      jest.useRealTimers();
    });

    it('watches builder-to-oracle task handoffs and alerts both builder and architect on silence', () => {
      jest.useFakeTimers();
      resolveRuntimeInt.mockImplementation((key, fallback) => (
        key === 'agentResponseWatchdogMs' ? 30 * 1000 : fallback
      ));
      const app = new SquidRunApp(mockAppContext, mockManagers);

      app.scheduleAgentResponseWatchdog({
        senderRole: 'builder',
        targetRole: 'oracle',
        content: '[TASK] Investigate the invalidation level and reply with evidence.',
        sentAtMs: new Date('2026-03-28T10:15:00').getTime(),
      });

      jest.advanceTimersByTime(30 * 1000);

      expect(spawn).toHaveBeenCalledWith(
        'node',
        expect.arrayContaining([
          expect.stringContaining(path.join('scripts', 'hm-send.js')),
          'builder',
          expect.stringContaining('(SYSTEM WATCHDOG): [WATCHDOG] No response from oracle to builder for task sent at 10:15. Check if task was received.'),
          '--role',
          'system',
        ]),
        expect.objectContaining({
          windowsHide: true,
        })
      );
      expect(spawn).toHaveBeenCalledWith(
        'node',
        expect.arrayContaining([
          expect.stringContaining(path.join('scripts', 'hm-send.js')),
          'architect',
          expect.stringContaining('(SYSTEM WATCHDOG): [WATCHDOG] No response from oracle to builder for task sent at 10:15. Check if task was received.'),
          '--role',
          'system',
        ]),
        expect.objectContaining({
          windowsHide: true,
        })
      );

      jest.useRealTimers();
    });

    it('does not watchdog messages that explicitly say no reply is needed', () => {
      jest.useFakeTimers();
      const app = new SquidRunApp(mockAppContext, mockManagers);

      expect(app.scheduleAgentResponseWatchdog({
        senderRole: 'builder',
        targetRole: 'oracle',
        content: 'Status only. No further acknowledgment needed.',
        sentAtMs: new Date('2026-03-28T10:15:00').getTime(),
      })).toBe(false);

      jest.advanceTimersByTime(5 * 60 * 1000);
      expect(spawn).not.toHaveBeenCalled();

      jest.useRealTimers();
    });

    it('does not watchdog machine-readable consultation JSON payloads', () => {
      jest.useFakeTimers();
      const app = new SquidRunApp(mockAppContext, mockManagers);

      expect(app.scheduleAgentResponseWatchdog({
        senderRole: 'builder',
        targetRole: 'architect',
        content: JSON.stringify({
          requestId: 'consultation-123',
          agentId: 'builder',
          signals: [
            {
              ticker: 'BTC/USD',
              direction: 'HOLD',
              confidence: 0.86,
              reasoning: 'VETO keeps this watch-only.',
            },
          ],
        }),
        sentAtMs: new Date('2026-03-28T10:15:00').getTime(),
      })).toBe(false);

      jest.advanceTimersByTime(5 * 60 * 1000);
      expect(spawn).not.toHaveBeenCalled();

      jest.useRealTimers();
    });

    it('does not watchdog consultation JSON payloads wrapped in agent-prefixed text', () => {
      jest.useFakeTimers();
      const app = new SquidRunApp(mockAppContext, mockManagers);

      expect(app.scheduleAgentResponseWatchdog({
        senderRole: 'builder',
        targetRole: 'architect',
        content: '(BUILDER #99): {"requestId":"consultation-1776880824458-80tl7e","agentId":"builder","signals":[{"ticker":"BTC/USD","direction":"BUY","confidence":0.63,"reasoning":"BTC is the only clear long."}]}',
        sentAtMs: new Date('2026-03-28T11:01:00').getTime(),
      })).toBe(false);

      jest.advanceTimersByTime(5 * 60 * 1000);
      expect(spawn).not.toHaveBeenCalled();

      jest.useRealTimers();
    });

    it('does not watchdog acknowledgement-only alignment notes', () => {
      jest.useFakeTimers();
      const app = new SquidRunApp(mockAppContext, mockManagers);

      expect(app.scheduleAgentResponseWatchdog({
        senderRole: 'builder',
        targetRole: 'architect',
        content: '(BUILDER #42): Copy. I’ve updated my working read: XPL hold remains valid while OI stays firm around 0.1044 support and price holds above 0.103, TP1 should fire immediately on green recovery, and the real target is the doubled daily quota path (~$33).',
        sentAtMs: new Date('2026-03-28T10:15:00').getTime(),
      })).toBe(false);

      jest.advanceTimersByTime(5 * 60 * 1000);
      expect(spawn).not.toHaveBeenCalled();

      jest.useRealTimers();
    });

    it('does not watchdog acknowledgement-only notes that mention pre-fix or post-fix noise', () => {
      jest.useFakeTimers();
      const app = new SquidRunApp(mockAppContext, mockManagers);

      expect(app.scheduleAgentResponseWatchdog({
        senderRole: 'builder',
        targetRole: 'architect',
        content: '(BUILDER #51): Copy. Treating the 10:09 watchdog hit as pre-fix queue noise, not a fresh miss. I will watch for any new post-fix false positives and only reopen if they reproduce after #49.',
        sentAtMs: new Date('2026-03-28T10:24:00').getTime(),
      })).toBe(false);

      jest.advanceTimersByTime(5 * 60 * 1000);
      expect(spawn).not.toHaveBeenCalled();

      jest.useRealTimers();
    });

    it('does not watchdog multiline status updates that do not ask for action', () => {
      jest.useFakeTimers();
      const app = new SquidRunApp(mockAppContext, mockManagers);

      expect(app.scheduleAgentResponseWatchdog({
        senderRole: 'builder',
        targetRole: 'architect',
        content: [
          '(BUILDER #52): Fresh watchdog hit traced and patched.',
          'Root cause was narrower than the original compaction issue.',
          'I removed the false-positive trigger, added a regression test, and reran the focused watchdog slice: 8 passed.',
        ].join('\n'),
        sentAtMs: new Date('2026-03-28T10:42:00').getTime(),
      })).toBe(false);

      jest.advanceTimersByTime(5 * 60 * 1000);
      expect(spawn).not.toHaveBeenCalled();

      jest.useRealTimers();
    });

    it('still watchdogs explicit consultation-style task requests', () => {
      jest.useFakeTimers();
      const app = new SquidRunApp(mockAppContext, mockManagers);

      expect(app.scheduleAgentResponseWatchdog({
        senderRole: 'architect',
        targetRole: 'builder',
        content: 'Analyze ALL 5 symbols in consultation request consultation-123. Deadline: 2026-03-28T10:45:00Z. Reply via hm-send architect with JSON containing a signal for every symbol.',
        sentAtMs: new Date('2026-03-28T10:15:00').getTime(),
      })).toBe(true);

      jest.useRealTimers();
    });

    it('cancels the watchdog after an accepted oracle response to builder', () => {
      jest.useFakeTimers();
      const app = new SquidRunApp(mockAppContext, mockManagers);

      app.scheduleAgentResponseWatchdog({
        senderRole: 'builder',
        targetRole: 'oracle',
        content: '[TASK] Investigate the invalidation level and reply with evidence.',
        sentAtMs: new Date('2026-03-28T10:15:00').getTime(),
      });
      app.maybeResolveAgentResponseWatchdog({
        senderRole: 'oracle',
        targetRole: 'builder',
        deliveryAccepted: true,
      });

      jest.advanceTimersByTime(90 * 1000);
      expect(spawn).not.toHaveBeenCalled();

      jest.useRealTimers();
    });
  });

  describe('runtime lifecycle startup', () => {
    let app;
    let watcher;

    beforeEach(() => {
      app = new SquidRunApp(mockAppContext, mockManagers);
      watcher = require('../modules/watcher');
    });

    it('awaits successful message watcher startup before reporting running', async () => {
      watcher.startMessageWatcher.mockResolvedValueOnce({ success: true, path: '/test/queue' });

      const result = await app.startRuntimeServices('test-start');

      expect(watcher.startWatcher).toHaveBeenCalledTimes(1);
      expect(watcher.startTriggerWatcher).toHaveBeenCalledTimes(1);
      expect(watcher.startMessageWatcher).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ ok: true, state: 'running' });
      expect(app.runtimeLifecycleState).toBe('running');
    });

    it('returns failure when message watcher startup resolves unsuccessful', async () => {
      watcher.startMessageWatcher.mockResolvedValueOnce({ success: false, reason: 'stopped' });

      const result = await app.startRuntimeServices('test-start');

      expect(result).toEqual({ ok: false, state: 'stopped', error: 'stopped' });
      expect(app.runtimeLifecycleState).toBe('stopped');
      expect(watcher.stopMessageWatcher).toHaveBeenCalledTimes(1);
      expect(watcher.stopTriggerWatcher).toHaveBeenCalledTimes(1);
      expect(watcher.stopWatcher).toHaveBeenCalledTimes(1);
    });

    it('returns failure when message watcher startup throws', async () => {
      watcher.startMessageWatcher.mockRejectedValueOnce(new Error('watcher crashed'));

      const result = await app.startRuntimeServices('test-start');

      expect(result).toEqual({ ok: false, state: 'stopped', error: 'watcher crashed' });
      expect(app.runtimeLifecycleState).toBe('stopped');
      expect(watcher.stopMessageWatcher).toHaveBeenCalledTimes(1);
      expect(watcher.stopTriggerWatcher).toHaveBeenCalledTimes(1);
      expect(watcher.stopWatcher).toHaveBeenCalledTimes(1);
    });
  });

  describe('dispatchPaneHostEnter', () => {
    it('returns success when daemon accepts enter write', () => {
      const app = new SquidRunApp(mockAppContext, mockManagers);
      app.ctx.daemonClient = {
        connected: true,
        write: jest.fn(() => true),
      };

      const result = app.dispatchPaneHostEnter('2');

      expect(app.ctx.daemonClient.write).toHaveBeenCalledWith('2', '\r');
      expect(result).toEqual({ success: true, paneId: '2' });
    });

    it('returns daemon_write_failed when daemon rejects enter write', () => {
      const app = new SquidRunApp(mockAppContext, mockManagers);
      app.ctx.daemonClient = {
        connected: true,
        write: jest.fn(() => false),
      };

      const result = app.dispatchPaneHostEnter('2');

      expect(app.ctx.daemonClient.write).toHaveBeenCalledWith('2', '\r');
      expect(result).toEqual({ success: false, reason: 'daemon_write_failed', paneId: '2' });
    });
  });

  describe('initializeStartupSessionScope', () => {
    let app;

    beforeEach(() => {
      app = new SquidRunApp(mockAppContext, mockManagers);
    });

    it('records next evidence-ledger session at startup and snapshots it', async () => {
      const { executeEvidenceLedgerOperation } = require('../modules/ipc/evidence-ledger-handlers');
      executeEvidenceLedgerOperation
        .mockResolvedValueOnce([{ sessionNumber: 128, sessionId: 'ses-128' }])
        .mockResolvedValueOnce({ ok: true, sessionId: 'ses-129' })
        .mockResolvedValueOnce({ ok: true, snapshotId: 'snp-129' });

      const result = await app.initializeStartupSessionScope();

      expect(result).toEqual({ sessionId: 'ses-129', sessionNumber: 129 });
      expect(app.commsSessionScopeId).toBe('app-session-129-ses-129');
      expect(executeEvidenceLedgerOperation).toHaveBeenNthCalledWith(
        1,
        'list-sessions',
        expect.objectContaining({ limit: 1, order: 'desc' }),
        expect.objectContaining({
          source: expect.objectContaining({ via: 'app-startup' }),
        })
      );
      expect(executeEvidenceLedgerOperation).toHaveBeenNthCalledWith(
        2,
        'record-session-start',
        expect.objectContaining({ sessionNumber: 129, mode: 'APP' }),
        expect.any(Object)
      );
      expect(executeEvidenceLedgerOperation).toHaveBeenNthCalledWith(
        3,
        'snapshot-context',
        expect.objectContaining({ sessionId: 'ses-129', trigger: 'session_start' }),
        expect.any(Object)
      );
    });

    it('uses provided session number from app-status when available', async () => {
      const { executeEvidenceLedgerOperation } = require('../modules/ipc/evidence-ledger-handlers');
      executeEvidenceLedgerOperation
        .mockResolvedValueOnce({ ok: true, sessionId: 'ses-147' })
        .mockResolvedValueOnce({ ok: true, snapshotId: 'snp-147' });

      const result = await app.initializeStartupSessionScope({ sessionNumber: 147 });

      expect(result).toEqual({ sessionId: 'ses-147', sessionNumber: 147 });
      expect(app.commsSessionScopeId).toBe('app-session-147');
      expect(executeEvidenceLedgerOperation).toHaveBeenCalledTimes(2);
      expect(executeEvidenceLedgerOperation).toHaveBeenNthCalledWith(
        1,
        'record-session-start',
        expect.objectContaining({ sessionNumber: 147, mode: 'APP' }),
        expect.any(Object)
      );
      expect(executeEvidenceLedgerOperation).toHaveBeenNthCalledWith(
        2,
        'snapshot-context',
        expect.objectContaining({ sessionId: 'ses-147', trigger: 'session_start' }),
        expect.any(Object)
      );
    });

    it('keeps provided app-status scope when startup session number conflicts', async () => {
      const { executeEvidenceLedgerOperation } = require('../modules/ipc/evidence-ledger-handlers');
      executeEvidenceLedgerOperation
        .mockResolvedValueOnce({ ok: false, reason: 'conflict' });

      const result = await app.initializeStartupSessionScope({ sessionNumber: 186 });

      expect(result).toEqual({ sessionId: null, sessionNumber: 186 });
      expect(app.commsSessionScopeId).toBe('app-session-186');
      expect(executeEvidenceLedgerOperation).toHaveBeenCalledTimes(1);
      expect(executeEvidenceLedgerOperation).toHaveBeenNthCalledWith(
        1,
        'record-session-start',
        expect.objectContaining({ sessionNumber: 186, mode: 'APP' }),
        expect.any(Object)
      );
    });

    it('retries startup session numbers on conflict', async () => {
      const { executeEvidenceLedgerOperation } = require('../modules/ipc/evidence-ledger-handlers');
      executeEvidenceLedgerOperation
        .mockResolvedValueOnce([{ sessionNumber: 128 }])
        .mockResolvedValueOnce({ ok: false, reason: 'conflict' })
        .mockResolvedValueOnce({ ok: true, sessionId: 'ses-130' })
        .mockResolvedValueOnce({ ok: true, snapshotId: 'snp-130' });

      const result = await app.initializeStartupSessionScope();

      expect(result).toEqual({ sessionId: 'ses-130', sessionNumber: 130 });
      expect(executeEvidenceLedgerOperation).toHaveBeenNthCalledWith(
        2,
        'record-session-start',
        expect.objectContaining({ sessionNumber: 129 }),
        expect.any(Object)
      );
      expect(executeEvidenceLedgerOperation).toHaveBeenNthCalledWith(
        3,
        'record-session-start',
        expect.objectContaining({ sessionNumber: 130 }),
        expect.any(Object)
      );
    });
  });

  describe('resolveTargetToPane', () => {
    let app;

    beforeEach(() => {
      app = new SquidRunApp(mockAppContext, mockManagers);
    });

    it('should return null for null/undefined input', () => {
      expect(app.resolveTargetToPane(null)).toBeNull();
      expect(app.resolveTargetToPane(undefined)).toBeNull();
    });

    it('should return paneId for direct numeric strings 1, 2, 3', () => {
      expect(app.resolveTargetToPane('1')).toBe('1');
      expect(app.resolveTargetToPane('2')).toBe('2');
      expect(app.resolveTargetToPane('3')).toBe('3');
    });

    it('should resolve role names to paneIds', () => {
      expect(app.resolveTargetToPane('architect')).toBe('1');
      expect(app.resolveTargetToPane('builder')).toBe('2');
      expect(app.resolveTargetToPane('backend')).toBe('2');
      expect(app.resolveTargetToPane('oracle')).toBe('3');
    });

    it('should be case-insensitive for role names', () => {
      expect(app.resolveTargetToPane('ARCHITECT')).toBe('1');
      expect(app.resolveTargetToPane('Architect')).toBe('1');
      expect(app.resolveTargetToPane('BACKEND')).toBe('2');
    });

    it('should resolve legacy aliases', () => {
      expect(app.resolveTargetToPane('lead')).toBe('1');
      expect(app.resolveTargetToPane('orchestrator')).toBe('2');
      expect(app.resolveTargetToPane('worker-b')).toBe('2');
      expect(app.resolveTargetToPane('investigator')).toBe('3');
    });

    it('should resolve background builder aliases and synthetic pane ids', () => {
      expect(app.resolveTargetToPane('builder-bg-1')).toBe('bg-2-1');
      expect(app.resolveTargetToPane('builder-bg-2')).toBe('bg-2-2');
      expect(app.resolveTargetToPane('bg-2-3')).toBe('bg-2-3');
    });

    it('should return null for invalid targets', () => {
      expect(app.resolveTargetToPane('invalid')).toBeNull();
      expect(app.resolveTargetToPane('7')).toBeNull();
      expect(app.resolveTargetToPane('0')).toBeNull();
      expect(app.resolveTargetToPane('')).toBeNull();
    });
  });

  describe('shutdown', () => {
    let app;

    beforeEach(() => {
      app = new SquidRunApp(mockAppContext, mockManagers);
    });

    it('should not throw when called', async () => {
      await expect(app.shutdown()).resolves.toBeUndefined();
    });

    it('should call cleanup functions', async () => {
      const websocketServer = require('../modules/websocket-server');
      const watcher = require('../modules/watcher');
      const smsPoller = require('../modules/sms-poller');
      const telegramPoller = require('../modules/telegram-poller');
      const { closeSharedRuntime } = require('../modules/ipc/evidence-ledger-handlers');
      const teamMemory = require('../modules/team-memory');
      const experiment = require('../modules/experiment');

      await app.shutdown();

      expect(closeSharedRuntime).toHaveBeenCalled();
      expect(experiment.closeExperimentRuntime).toHaveBeenCalled();
      expect(teamMemory.stopIntegritySweep).toHaveBeenCalled();
      expect(teamMemory.stopBeliefSnapshotSweep).toHaveBeenCalled();
      expect(teamMemory.stopPatternMiningSweep).toHaveBeenCalled();
      expect(teamMemory.closeTeamMemoryRuntime).toHaveBeenCalled();
      expect(websocketServer.stop).toHaveBeenCalled();
      expect(smsPoller.stop).toHaveBeenCalled();
      expect(telegramPoller.stop).toHaveBeenCalled();
      expect(watcher.stopWatcher).toHaveBeenCalled();
      expect(watcher.stopTriggerWatcher).toHaveBeenCalled();
      expect(watcher.stopMessageWatcher).toHaveBeenCalled();
    });

    it('should disconnect daemon client if present', async () => {
      const mockDaemonClient = { disconnect: jest.fn() };
      mockAppContext.daemonClient = mockDaemonClient;
      app = new SquidRunApp(mockAppContext, mockManagers);

      await app.shutdown();

      expect(mockDaemonClient.disconnect).toHaveBeenCalled();
    });

    it('shuts down cleanly in PTY mode', async () => {
      await expect(app.shutdown()).resolves.toBeUndefined();
    });

    it('captures session-end state before tearing down runtimes', async () => {
      const evidenceLedger = require('../modules/ipc/evidence-ledger-handlers');
      const teamMemory = require('../modules/team-memory');
      const { generateSessionSummary } = require('../scripts/hm-session-summary');
      app.teamMemoryInitialized = true;
      app.ledgerAppSession = {
        sessionId: 'ses-147',
        sessionNumber: 147,
      };
      app.commsSessionScopeId = 'app-session-147';
      mockManagers.settings.readAppStatus.mockReturnValue({ session: 147 });
      evidenceLedger.executeEvidenceLedgerOperation.mockImplementation(async (action, payload) => {
        if (action === 'record-session-end') {
          return { ok: true, sessionId: payload.sessionId };
        }
        if (action === 'snapshot-context') {
          return { ok: true, snapshotId: 'snap-147' };
        }
        if (action === 'list-sessions') {
          return [{ sessionId: 'ses-147', sessionNumber: 147 }];
        }
        return { ok: true };
      });

      await app.shutdown();

      expect(generateSessionSummary).toHaveBeenCalledWith(expect.objectContaining({
        sessionNumber: 147,
        includeSummaryText: true,
      }));
      expect(teamMemory.executeTeamMemoryOperation).toHaveBeenCalledWith(
        'capture-precompact-memory',
        expect.objectContaining({
          session_id: 'app-session-147',
          session_ordinal: 147,
          reason: 'session_end',
        })
      );
      expect(evidenceLedger.executeEvidenceLedgerOperation).toHaveBeenCalledWith(
        'record-session-end',
        expect.objectContaining({
          sessionId: 'ses-147',
          summary: 'Session 147 captured 3 messages before shutdown.',
          stats: {
            messageCount: 3,
          },
        }),
        expect.any(Object)
      );
      expect(evidenceLedger.executeEvidenceLedgerOperation).toHaveBeenCalledWith(
        'snapshot-context',
        expect.objectContaining({
          sessionId: 'ses-147',
          trigger: 'session_end',
          content: expect.objectContaining({
            summary: 'Session 147 captured 3 messages before shutdown.',
            summaryMarkdown: '# Session 147 Summary\n\n## Findings\n- Shipped continuity fix.\n',
            sessionSummary: expect.objectContaining({
              sessionNumber: 147,
              messageCount: 3,
            }),
          }),
        }),
        expect.any(Object)
      );
    });

    it('performFullShutdown drains shutdown and stops the supervisor pid before exit', async () => {
      const electron = require('electron');
      electron.app.exit = jest.fn();
      const supervisorPid = 6543;
      const app = new SquidRunApp(mockAppContext, mockManagers);
      const shutdownSpy = jest.spyOn(app, 'shutdown').mockResolvedValue();
      const killSpy = jest.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (signal === 0) {
          throw new Error('process_gone');
        }
        return true;
      });
      jest.spyOn(app, 'readTextFileSafe').mockReturnValue(JSON.stringify({ pid: supervisorPid }));

      const result = await app.performFullShutdown('test-full-restart');

      expect(result).toEqual(expect.objectContaining({
        success: true,
        supervisorStopResult: expect.objectContaining({
          ok: true,
          pid: supervisorPid,
        }),
      }));
      expect(shutdownSpy).toHaveBeenCalled();
      expect(killSpy).toHaveBeenCalledWith(supervisorPid, 'SIGTERM');
      expect(electron.app.exit).toHaveBeenCalledWith(0);

      killSpy.mockRestore();
    });
  });

  describe('handleTeamMemoryGuardExperiment', () => {
    let app;

    beforeEach(() => {
      app = new SquidRunApp(mockAppContext, mockManagers);
      app.experimentInitialized = true;
    });

    it('queues experiment and marks contested claim as pending_proof for block guards', async () => {
      const teamMemory = require('../modules/team-memory');
      const experiment = require('../modules/experiment');

      const result = await app.handleTeamMemoryGuardExperiment({
        action: 'block',
        guardId: 'grd_1',
        event: {
          claimId: 'clm_1',
          status: 'contested',
          session: 's_1',
          scope: 'ui/modules/triggers.js',
          agent: 'oracle',
        },
      });

      expect(result.ok).toBe(true);
      expect(experiment.executeExperimentOperation).toHaveBeenCalledWith(
        'run-experiment',
        expect.objectContaining({
          claimId: 'clm_1',
          profileId: expect.any(String),
          guardContext: expect.objectContaining({
            guardId: 'grd_1',
            action: 'block',
            blocking: true,
          }),
        })
      );
      expect(teamMemory.executeTeamMemoryOperation).toHaveBeenCalledWith(
        'update-claim-status',
        expect.objectContaining({
          claimId: 'clm_1',
          status: 'pending_proof',
        })
      );
    });

    it('ignores non-block actions', async () => {
      const experiment = require('../modules/experiment');
      const result = await app.handleTeamMemoryGuardExperiment({
        action: 'warn',
        event: { claimId: 'clm_1', status: 'contested' },
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toBe('not_block_action');
      expect(experiment.executeExperimentOperation).not.toHaveBeenCalled();
    });

    it('accepts pending_proof claims for block-guard experiment dispatch', async () => {
      const experiment = require('../modules/experiment');
      const teamMemory = require('../modules/team-memory');

      const result = await app.handleTeamMemoryGuardExperiment({
        action: 'block',
        guardId: 'grd_2',
        event: {
          claimId: 'clm_2',
          status: 'pending_proof',
          session: 's_2',
          scope: 'ui/modules/injection.js',
        },
      });

      expect(result.ok).toBe(true);
      expect(experiment.executeExperimentOperation).toHaveBeenCalledWith(
        'run-experiment',
        expect.objectContaining({
          claimId: 'clm_2',
          guardContext: expect.objectContaining({
            guardId: 'grd_2',
            action: 'block',
            blocking: true,
          }),
        })
      );
      expect(teamMemory.executeTeamMemoryOperation).toHaveBeenCalledWith(
        'update-claim-status',
        expect.objectContaining({
          claimId: 'clm_2',
          status: 'pending_proof',
        })
      );
    });
  });

  describe('team memory daily integration hooks', () => {
    let app;

    beforeEach(() => {
      app = new SquidRunApp(mockAppContext, mockManagers);
      app.teamMemoryInitialized = true;
    });

    it('preflight evaluation reports blocked guards', async () => {
      const teamMemory = require('../modules/team-memory');
      teamMemory.executeTeamMemoryOperation.mockResolvedValueOnce({
        ok: true,
        blocked: true,
        actions: [
          {
            guardId: 'grd_block',
            action: 'block',
            scope: 'ui/modules/triggers.js',
            message: 'Blocked by guard',
            event: { status: 'preflight' },
          },
        ],
      });

      const result = await app.evaluateTeamMemoryGuardPreflight({
        target: 'builder',
        content: 'run risky operation',
        fromRole: 'architect',
      });

      expect(result.blocked).toBe(true);
      expect(result.actions).toHaveLength(1);
      expect(teamMemory.executeTeamMemoryOperation).toHaveBeenCalledWith(
        'evaluate-guards',
        expect.objectContaining({
          events: expect.any(Array),
        })
      );
      expect(teamMemory.appendPatternHookEvent).toHaveBeenCalled();
    });

    it('records delivery failure patterns for unverified sends', async () => {
      const teamMemory = require('../modules/team-memory');
      await app.recordDeliveryFailurePattern({
        channel: 'send',
        target: '2',
        fromRole: 'architect',
        result: {
          accepted: true,
          queued: true,
          verified: false,
          status: 'routed_unverified_timeout',
          notified: ['2'],
        },
      });

      expect(teamMemory.appendPatternHookEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'delivery.failed',
          channel: 'send',
          target: '2',
        })
      );
    });

    it('records delivery outcome patterns for verified sends', async () => {
      const teamMemory = require('../modules/team-memory');
      await app.recordDeliveryOutcomePattern({
        channel: 'send',
        target: '1',
        fromRole: 'builder',
        result: {
          accepted: true,
          queued: true,
          verified: true,
          status: 'delivered.verified',
          notified: ['1'],
        },
      });

      expect(teamMemory.appendPatternHookEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'delivery.outcome',
          channel: 'send',
          target: '1',
          outcome: 'delivered',
        })
      );
      expect(teamMemory.appendPatternHookEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'delivery.failed',
          channel: 'send',
          target: '1',
        })
      );
    });

    it('records session lifecycle events without firing rollover injection on started', async () => {
      const teamMemory = require('../modules/team-memory');
      const triggerProactiveMemoryInjection = jest
        .spyOn(app, 'triggerProactiveMemoryInjection')
        .mockResolvedValue({ ok: true });
      await app.recordSessionLifecyclePattern({
        paneId: '2',
        status: 'started',
        reason: 'spawn_requested',
      });

      expect(teamMemory.appendPatternHookEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'session.lifecycle',
          paneId: '2',
          status: 'started',
        })
      );
      expect(triggerProactiveMemoryInjection).not.toHaveBeenCalled();
    });
  });

  describe('initDaemonClient', () => {
    it('waits for PTY kernel classification before visible fanout and flushes visible output before exit', async () => {
      jest.useFakeTimers();
      try {
        const { getDaemonClient } = require('../daemon-client');
        const sharedDaemonClient = {
          on: jest.fn(),
          off: jest.fn(),
          connect: jest.fn().mockResolvedValue(),
          disconnect: jest.fn(),
        };
        getDaemonClient.mockReturnValue(sharedDaemonClient);

        const mainWindow = {
          isDestroyed: jest.fn().mockReturnValue(false),
          webContents: {
            send: jest.fn(),
            isDestroyed: jest.fn().mockReturnValue(false),
          },
        };

        const ctx = {
          ...mockAppContext,
          mainWindow,
          daemonClient: sharedDaemonClient,
          agentRunning: new Map([['1', 'running']]),
          getWindow: jest.fn((key = 'main') => (key === 'main' ? mainWindow : null)),
          getWindows: jest.fn(() => new Map([['main', mainWindow]])),
        };
        const app = new SquidRunApp(ctx, mockManagers);

        await app.initDaemonClient();

        const dataListener = sharedDaemonClient.on.mock.calls.find(([eventName]) => eventName === 'data')?.[1];
        const exitListener = sharedDaemonClient.on.mock.calls.find(([eventName]) => eventName === 'exit')?.[1];
        const kernelListener = sharedDaemonClient.on.mock.calls.find(([eventName]) => eventName === 'kernel-event')?.[1];

        expect(typeof dataListener).toBe('function');
        expect(typeof exitListener).toBe('function');
        expect(typeof kernelListener).toBe('function');

        mainWindow.webContents.send.mockClear();

        dataListener('1', 'hel');
        dataListener('1', 'lo');
        dataListener('2', 'x');

        expect(mainWindow.webContents.send).not.toHaveBeenCalled();

        jest.advanceTimersByTime(16);

        expect(mainWindow.webContents.send).not.toHaveBeenCalledWith('pty-data-1', 'hello');
        expect(mainWindow.webContents.send).not.toHaveBeenCalledWith('pty-data-2', 'x');

        kernelListener({
          type: 'pty.data.received',
          paneId: '1',
          payload: { paneId: '1', byteLen: Buffer.byteLength('hello', 'utf8') },
          kernelMeta: null,
        });
        kernelListener({
          type: 'pty.data.received',
          paneId: '2',
          payload: { paneId: '2', byteLen: Buffer.byteLength('x', 'utf8') },
          kernelMeta: null,
        });

        expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty-data-1', 'hello');
        expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty-data-2', 'x');

        mainWindow.webContents.send.mockClear();

        dataListener('1', 'secret');
        jest.advanceTimersByTime(16);
        kernelListener({
          type: 'pty.data.received',
          paneId: '1',
          payload: { paneId: '1', byteLen: Buffer.byteLength('secret', 'utf8') },
          kernelMeta: { meta: { visibility: 'internal' } },
        });

        expect(mainWindow.webContents.send).not.toHaveBeenCalledWith('pty-data-1', 'secret');

        mainWindow.webContents.send.mockClear();

        dataListener('1', 'tail');
        exitListener('1', 0);

        const ptyDataCallIndex = mainWindow.webContents.send.mock.calls.findIndex(
          ([channel, payload]) => channel === 'pty-data-1' && payload === 'tail'
        );
        const ptyExitCallIndex = mainWindow.webContents.send.mock.calls.findIndex(
          ([channel, payload]) => channel === 'pty-exit-1' && payload === 0
        );

        expect(ptyDataCallIndex).toBeGreaterThanOrEqual(0);
        expect(ptyExitCallIndex).toBeGreaterThan(ptyDataCallIndex);
      } finally {
        jest.useRealTimers();
      }
    });

    it('cleans up existing daemon client listeners before re-attaching on re-init', async () => {
      const { getDaemonClient } = require('../daemon-client');
      const ipcHandlers = require('../modules/ipc-handlers');
      const sharedDaemonClient = {
        on: jest.fn(),
        off: jest.fn(),
        connect: jest.fn().mockResolvedValue(),
        disconnect: jest.fn(),
      };
      getDaemonClient.mockReturnValue(sharedDaemonClient);

      const ctx = {
        ...mockAppContext,
        daemonClient: sharedDaemonClient,
        agentRunning: new Map(),
      };
      const app = new SquidRunApp(ctx, mockManagers);

      await app.initDaemonClient();
      const firstAttachCount = sharedDaemonClient.on.mock.calls.length;
      expect(firstAttachCount).toBeGreaterThanOrEqual(10);
      expect(ipcHandlers.setDaemonClient).toHaveBeenCalled();

      await app.initDaemonClient();

      expect(sharedDaemonClient.off).toHaveBeenCalledTimes(firstAttachCount);
      expect(sharedDaemonClient.on.mock.calls.length).toBe(firstAttachCount * 2);
    });

    it('fires session rollover injection only after the pane reaches running', async () => {
      const { getDaemonClient } = require('../daemon-client');
      const sharedDaemonClient = {
        on: jest.fn(),
        off: jest.fn(),
        connect: jest.fn().mockResolvedValue(),
        disconnect: jest.fn(),
      };
      getDaemonClient.mockReturnValue(sharedDaemonClient);

      const ctx = {
        ...mockAppContext,
        daemonClient: sharedDaemonClient,
        agentRunning: new Map([['2', 'starting']]),
        pluginManager: {
          hasHook: jest.fn().mockReturnValue(false),
          dispatch: jest.fn().mockResolvedValue(),
        },
      };
      const app = new SquidRunApp(ctx, mockManagers);
      const triggerProactiveMemoryInjection = jest
        .spyOn(app, 'triggerProactiveMemoryInjection')
        .mockResolvedValue({ ok: true, delivered: true });

      await app.initDaemonClient();

      const dataListener = sharedDaemonClient.on.mock.calls.find(([eventName]) => eventName === 'data')?.[1];
      expect(typeof dataListener).toBe('function');

      dataListener('2', 'codex> ready');

      expect(ctx.agentRunning.get('2')).toBe('running');
      expect(triggerProactiveMemoryInjection).toHaveBeenCalledWith(expect.objectContaining({
        paneId: '2',
        triggerType: 'session_rollover',
        payload: expect.objectContaining({
          session_ordinal: 147,
          trigger_event_id: expect.stringContaining('session-rollover:2:'),
        }),
      }));
    });

    it('does not treat a shell-echoed launch command as prompt-ready', async () => {
      const { getDaemonClient } = require('../daemon-client');
      const sharedDaemonClient = {
        on: jest.fn(),
        off: jest.fn(),
        connect: jest.fn().mockResolvedValue(),
        disconnect: jest.fn(),
      };
      getDaemonClient.mockReturnValue(sharedDaemonClient);

      const ctx = {
        ...mockAppContext,
        daemonClient: sharedDaemonClient,
        agentRunning: new Map([['1', 'starting']]),
        pluginManager: {
          hasHook: jest.fn().mockReturnValue(false),
          dispatch: jest.fn().mockResolvedValue(),
        },
      };
      const app = new SquidRunApp(ctx, mockManagers);
      const triggerProactiveMemoryInjection = jest
        .spyOn(app, 'triggerProactiveMemoryInjection')
        .mockResolvedValue({ ok: true, delivered: true });

      await app.initDaemonClient();

      const dataListener = sharedDaemonClient.on.mock.calls.find(([eventName]) => eventName === 'data')?.[1];
      expect(typeof dataListener).toBe('function');

      dataListener('1', 'PS D:\\projects\\squidrun> claude --model opus --permission-mode acceptEdits');

      expect(ctx.agentRunning.get('1')).toBe('starting');
      expect(triggerProactiveMemoryInjection).not.toHaveBeenCalled();

      dataListener('1', '\n> ');

      expect(ctx.agentRunning.get('1')).toBe('running');
      expect(triggerProactiveMemoryInjection).toHaveBeenCalledTimes(1);
    });
  });

  describe('smoke test - full module loads', () => {
    it('should export SquidRunApp class', () => {
      expect(SquidRunApp).toBeDefined();
      expect(typeof SquidRunApp).toBe('function');
    });

    it('should have expected methods', () => {
      const app = new SquidRunApp(mockAppContext, mockManagers);

      expect(typeof app.init).toBe('function');
      expect(typeof app.shutdown).toBe('function');
      expect(typeof app.resolveTargetToPane).toBe('function');
    });
  });

  describe('SMS poller wiring', () => {
    let app;

    beforeEach(() => {
      app = new SquidRunApp(mockAppContext, mockManagers);
    });

    it('wires inbound SMS callback to pane 1 trigger injection', () => {
      const smsPoller = require('../modules/sms-poller');
      const triggers = require('../modules/triggers');
      smsPoller.start.mockReturnValue(true);

      app.startSmsPoller();

      expect(smsPoller.start).toHaveBeenCalledTimes(1);
      const options = smsPoller.start.mock.calls[0][0];
      expect(typeof options.onMessage).toBe('function');

      options.onMessage('build passed', '+15557654321');
      expect(triggers.sendDirectMessage).toHaveBeenCalledWith(
        ['1'],
        '[SMS from +15557654321]: build passed',
        null,
        expect.objectContaining({
          awaitDelivery: true,
        })
      );
    });
  });

  describe('Telegram poller wiring', () => {
    let app;

    beforeEach(() => {
      app = new SquidRunApp(mockAppContext, mockManagers);
    });

    it('wires inbound Telegram callback to pane 1 trigger injection', async () => {
      const telegramPoller = require('../modules/telegram-poller');
      telegramPoller.start.mockReturnValue(true);
      const deliverySpy = jest.spyOn(app, 'deliverHumanMessageWithRecall').mockResolvedValue({
        accepted: true,
        queued: true,
        verified: true,
      });

      app.startTelegramPoller();

      expect(telegramPoller.start).toHaveBeenCalledTimes(1);
      const options = telegramPoller.start.mock.calls[0][0];
      expect(typeof options.onMessage).toBe('function');

      options.onMessage('build passed', 'james');
      await new Promise((resolve) => setImmediate(resolve));
      expect(deliverySpy).toHaveBeenCalledWith(
        '[Telegram from james]: build passed',
        expect.objectContaining({
          paneId: '1',
          role: 'architect',
          windowKey: 'main',
          channel: 'telegram',
          sender: 'james',
          metadata: expect.objectContaining({
            windowKey: 'main',
          }),
        }),
        'Telegram'
      );
      expect(app.telegramInboundContext).toEqual(
        expect.objectContaining({
          sender: 'james',
          windowKey: 'main',
        })
      );
      expect(app.telegramInboundContext.lastInboundAtMs).toBeGreaterThan(0);
    });

    it('does not start Telegram polling from a secondary profile', () => {
      const telegramPoller = require('../modules/telegram-poller');
      app.activeProfileName = 'scoped';

      app.startTelegramPoller();

      expect(telegramPoller.start).not.toHaveBeenCalled();
    });

    it('starts the main Telegram owner with scoped chat routing enabled', () => {
      const telegramPoller = require('../modules/telegram-poller');
      telegramPoller.start.mockReturnValue(true);

      app.startTelegramPoller();

      const options = telegramPoller.start.mock.calls[0][0];
      expect(options.env).toEqual(expect.objectContaining({
        SQUIDRUN_PROFILE: 'main',
        SQUIDRUN_TELEGRAM_ACCEPT_SCOPED_CHATS: '1',
        TELEGRAM_SCOPED_CHAT_IDS: '2222222222',
      }));
    });

    it('captures inbound Telegram chatId for reply routing', () => {
      const telegramPoller = require('../modules/telegram-poller');
      telegramPoller.start.mockReturnValue(true);

      app.registerAppWindow('scoped', {
        isDestroyed: jest.fn().mockReturnValue(false),
        webContents: {
          isDestroyed: jest.fn().mockReturnValue(false),
          send: jest.fn(),
        },
      });
      app.startTelegramPoller();

      const options = telegramPoller.start.mock.calls[0][0];
      options.onMessage('hi there', 'scoped', { chatId: 2222222222 });

      expect(app.telegramInboundContext).toEqual(
        expect.objectContaining({
          sender: 'scoped',
          chatId: '2222222222',
          windowKey: 'scoped',
        })
      );
    });

    it('routes main Telegram chat inbound to the main window scope', async () => {
      const telegramPoller = require('../modules/telegram-poller');
      telegramPoller.start.mockReturnValue(true);
      const deliverySpy = jest.spyOn(app, 'deliverHumanMessageWithRecall').mockResolvedValue({
        accepted: true,
        queued: true,
        verified: true,
      });

      app.startTelegramPoller();

      const options = telegramPoller.start.mock.calls[0][0];
      options.onMessage('main hello', 'james', { chatId: 5613428850, updateId: 101 });

      await new Promise((resolve) => setImmediate(resolve));
      expect(deliverySpy).toHaveBeenCalledWith(
        '[Telegram from james]: main hello',
        expect.objectContaining({
          paneId: '1',
          role: 'architect',
          windowKey: 'main',
          chatId: 5613428850,
          metadata: expect.objectContaining({
            chatId: 5613428850,
            windowKey: 'main',
          }),
        }),
        'Telegram'
      );
    });

    it('routes scoped Telegram chat inbound to the side window scope', async () => {
      const telegramPoller = require('../modules/telegram-poller');
      telegramPoller.start.mockReturnValue(true);
      const deliverySpy = jest.spyOn(app, 'deliverHumanMessageWithRecall').mockResolvedValue({
        accepted: true,
        queued: true,
        verified: true,
      });

      app.registerAppWindow('scoped', {
        isDestroyed: jest.fn().mockReturnValue(false),
        webContents: {
          isDestroyed: jest.fn().mockReturnValue(false),
          send: jest.fn(),
        },
      });
      app.startTelegramPoller();

      const options = telegramPoller.start.mock.calls[0][0];
      options.onMessage('side hello', 'scoped', { chatId: 2222222222, updateId: 102 });

      await new Promise((resolve) => setImmediate(resolve));
      expect(deliverySpy).toHaveBeenCalledWith(
        '[Telegram from scoped]: side hello',
        expect.objectContaining({
          paneId: '1',
          role: 'architect',
          windowKey: 'scoped',
          chatId: 2222222222,
          metadata: expect.objectContaining({
            chatId: 2222222222,
            windowKey: 'scoped',
          }),
        }),
        'Telegram'
      );
    });

    it('forwards scoped Telegram chat inbound to Scoped profile triggers when side window is standalone', async () => {
      const telegramPoller = require('../modules/telegram-poller');
      telegramPoller.start.mockReturnValue(true);
      const deliverySpy = jest.spyOn(app, 'deliverHumanMessageWithRecall').mockResolvedValue({
        accepted: true,
        queued: true,
        verified: true,
      });
      const forwardSpy = jest.spyOn(app, 'forwardScopedTelegramInboundToProfileWindow').mockReturnValue(true);

      app.startTelegramPoller();

      const options = telegramPoller.start.mock.calls[0][0];
      options.onMessage('standalone hello', 'scoped', { chatId: 2222222222, updateId: 103 });

      await new Promise((resolve) => setImmediate(resolve));
      expect(forwardSpy).toHaveBeenCalledWith(
        'scoped',
        '[Telegram from scoped]: standalone hello'
      );
      expect(deliverySpy).not.toHaveBeenCalled();
    });

    it('writes standalone scoped Telegram forwarding into the scoped profile trigger root', () => {
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-scoped-root-'));
      const previousRoot = process.env.SQUIDRUN_SCOPED_PROJECT_ROOT;
      process.env.SQUIDRUN_SCOPED_PROJECT_ROOT = tempRoot;

      try {
        const forwarded = app.forwardScopedTelegramInboundToProfileWindow(
          'scoped',
          '[Telegram from scoped]: root test'
        );
        const scopedTriggerPath = path.join(
          tempRoot,
          '.squidrun',
          'triggers-scoped',
          'architect.txt'
        );
        const mainTriggerPath = path.join(
          require('../config').getProjectRoot(),
          '.squidrun',
          'triggers-scoped',
          'architect.txt'
        );

        expect(app.getScopedTelegramTriggerPaths('scoped')).toEqual([scopedTriggerPath]);
        expect(forwarded).toBe(true);
        expect(fs.readFileSync(scopedTriggerPath, 'utf8')).toBe('[Telegram from scoped]: root test');
        expect(app.getScopedTelegramTriggerPaths('scoped')).not.toContain(mainTriggerPath);
      } finally {
        if (previousRoot === undefined) {
          delete process.env.SQUIDRUN_SCOPED_PROJECT_ROOT;
        } else {
          process.env.SQUIDRUN_SCOPED_PROJECT_ROOT = previousRoot;
        }
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    });

    it('includes saved file path in pane injection for inbound Telegram photos', async () => {
      const telegramPoller = require('../modules/telegram-poller');
      telegramPoller.start.mockReturnValue(true);
      const deliverySpy = jest.spyOn(app, 'deliverHumanMessageWithRecall').mockResolvedValue({
        accepted: true,
        queued: true,
        verified: true,
      });

      app.registerAppWindow('scoped', {
        isDestroyed: jest.fn().mockReturnValue(false),
        webContents: {
          isDestroyed: jest.fn().mockReturnValue(false),
          send: jest.fn(),
        },
      });
      app.startTelegramPoller();

      const options = telegramPoller.start.mock.calls[0][0];
      options.onMessage('[Photo received]', '@ScopedContact', {
        chatId: 2222222222,
        media: {
          kind: 'photo',
          localPath: 'D:\\projects\\Example Case\\telegram-photos\\photo-11.jpg',
          latestScreenshotPath: 'D:\\projects\\squidrun\\.squidrun\\screenshots\\latest.png',
        },
      });

      await new Promise((resolve) => setImmediate(resolve));
      expect(deliverySpy).toHaveBeenCalledWith(
        '[Telegram from @ScopedContact]: [Photo received] | saved: D:\\projects\\Example Case\\telegram-photos\\photo-11.jpg',
        expect.objectContaining({
          paneId: '1',
          role: 'architect',
          windowKey: 'scoped',
          channel: 'telegram',
          sender: '@ScopedContact',
          metadata: expect.objectContaining({
            windowKey: 'scoped',
          }),
        }),
        'Telegram'
      );
    });

    it('synthesizes photo display text when poller passes empty body with photo metadata', async () => {
      const telegramPoller = require('../modules/telegram-poller');
      telegramPoller.start.mockReturnValue(true);
      const deliverySpy = jest.spyOn(app, 'deliverHumanMessageWithRecall').mockResolvedValue({
        accepted: true,
        queued: true,
        verified: true,
      });

      app.registerAppWindow('scoped', {
        isDestroyed: jest.fn().mockReturnValue(false),
        webContents: {
          isDestroyed: jest.fn().mockReturnValue(false),
          send: jest.fn(),
        },
      });
      app.startTelegramPoller();

      const options = telegramPoller.start.mock.calls[0][0];
      options.onMessage('', '@ScopedContact', {
        updateId: 808489706,
        messageId: 555,
        chatId: 2222222222,
        photo: {
          file_id: 'photo-xyz',
        },
      });

      await new Promise((resolve) => setImmediate(resolve));
      expect(deliverySpy).toHaveBeenCalledWith(
        '[Telegram from @ScopedContact]: [Photo received]',
        expect.objectContaining({
          paneId: '1',
          role: 'architect',
          channel: 'telegram',
          sender: '@ScopedContact',
        }),
        'Telegram'
      );
    });

    it('queues inbound human delivery for replay when pane delivery stays unverified', async () => {
      const triggers = require('../modules/triggers');
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-pending-pane-'));
      const queuePath = path.join(tempRoot, 'pending-pane-deliveries.json');
      jest.spyOn(app, 'getPendingPaneDeliveryQueuePath').mockReturnValue(queuePath);
      triggers.sendDirectMessage.mockResolvedValueOnce({
        accepted: true,
        queued: true,
        verified: false,
        status: 'accepted.unverified',
      });

      try {
        const result = await app.deliverHumanMessageWithRecall(
          '[Telegram from scoped]: hello',
          {
            paneId: '1',
            channel: 'telegram',
            sender: 'scoped',
            messageId: 'telegram-in-123',
          },
          'Telegram'
        );

        expect(result).toEqual(expect.objectContaining({
          pendingQueued: true,
        }));
        const persisted = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
        expect(persisted.items).toEqual([
          expect.objectContaining({
            messageId: 'telegram-in-123',
            paneId: '1',
            channel: 'telegram',
            sender: 'scoped',
          }),
        ]);
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    });

    it('does not crash when the pending delivery queue directory is unwritable', async () => {
      const triggers = require('../modules/triggers');
      const queuePath = path.join('/test/workspace/.squidrun/runtime', 'pending-pane-deliveries.json');
      const realMkdirSync = fs.mkdirSync.bind(fs);
      const mkdirSpy = jest.spyOn(fs, 'mkdirSync').mockImplementation((targetPath, options) => {
        if (String(targetPath).includes('test') && String(targetPath).includes('runtime')) {
          const err = new Error(`EACCES: permission denied, mkdir '${targetPath}'`);
          err.code = 'EACCES';
          throw err;
        }
        return realMkdirSync(targetPath, options);
      });
      jest.spyOn(app, 'getPendingPaneDeliveryQueuePath').mockReturnValue(queuePath);
      triggers.sendDirectMessage.mockResolvedValueOnce({
        accepted: true,
        queued: true,
        verified: false,
        status: 'accepted.unverified',
      });

      try {
        const result = await app.deliverHumanMessageWithRecall(
          '[Telegram from scoped]: hello',
          {
            paneId: '1',
            channel: 'telegram',
            sender: 'scoped',
            messageId: 'telegram-in-123',
          },
          'Telegram'
        );

        expect(result).toEqual(expect.objectContaining({
          pendingQueued: false,
          pendingFailureReason: 'accepted.unverified',
        }));
      } finally {
        mkdirSpy.mockRestore();
      }
    });

    it('delivers pane-1 human messages without injecting recall blocks', async () => {
      const triggers = require('../modules/triggers');
      triggers.sendDirectMessage.mockResolvedValueOnce({
        accepted: true,
        queued: true,
        verified: true,
        status: 'delivered.verified',
      });

      const result = await app.deliverHumanMessageWithRecall(
        '[Telegram from james]: plain inbound message',
        {
          paneId: '1',
          channel: 'telegram',
          sender: 'james',
          messageId: 'telegram-in-plain-1',
        },
        'Telegram'
      );

      expect(result).toEqual(expect.objectContaining({
        verified: true,
      }));
      expect(triggers.sendDirectMessage).toHaveBeenCalledWith(
        ['1'],
        '[Telegram from james]: plain inbound message',
        null,
        expect.any(Object)
      );
      expect(triggers.sendDirectMessage.mock.calls[0][1]).not.toContain('[SQUIDRUN RECALL START]');
    });

    it('replays queued pane deliveries and clears them once pane delivery verifies', async () => {
      const triggers = require('../modules/triggers');
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-pending-replay-'));
      const queuePath = path.join(tempRoot, 'pending-pane-deliveries.json');
      jest.spyOn(app, 'getPendingPaneDeliveryQueuePath').mockReturnValue(queuePath);
      fs.writeFileSync(queuePath, JSON.stringify({
        items: [
          {
            queueKey: 'telegram-in-123',
            paneId: '1',
            message: '[Telegram from scoped]: hello',
            messageId: 'telegram-in-123',
            channel: 'telegram',
            sender: 'scoped',
          },
        ],
      }));
      triggers.sendDirectMessage.mockResolvedValueOnce({
        accepted: true,
        queued: true,
        verified: true,
        status: 'delivered.verified',
      });

      try {
        const result = await app.flushPendingPaneDeliveries({ paneId: '1', reason: 'test-replay' });

        expect(result).toEqual(expect.objectContaining({
          ok: true,
          deliveredCount: 1,
          remainingCount: 0,
        }));
        const persisted = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
        expect(persisted.items).toEqual([]);
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    });

    it('stores pending pane deliveries in the canonical runtime directory', () => {
      expect(app.getPendingPaneDeliveryQueuePath()).toBe('/test/workspace/runtime/pending-pane-deliveries.json');
      expect(app.getPendingPaneDeliveryQueuePath()).not.toContain('/.squidrun/runtime/');
    });
  });

  describe('Telegram auto-reply routing', () => {
    let app;

    beforeEach(() => {
      app = new SquidRunApp(mockAppContext, mockManagers);
    });

    it('routes user target to Telegram when inbound context is recent', async () => {
      const { sendRoutedTelegramMessage } = require('../scripts/hm-telegram-routing');
      app.markTelegramInboundContext('james');

      const result = await app.routeTelegramReply({
        target: 'user',
        content: 'Build passed.',
        messageId: 'telegram-route-1',
      });

      expect(sendRoutedTelegramMessage).toHaveBeenCalledWith(
        'Build passed.',
        process.env,
        expect.objectContaining({
          messageId: 'telegram-route-1',
          senderRole: 'system',
          sessionId: expect.any(String),
          metadata: expect.objectContaining({
            routeKind: 'telegram',
            targetRaw: 'user',
          }),
        })
      );
      expect(result).toEqual(
        expect.objectContaining({
          handled: true,
          ok: true,
          status: 'telegram_delivered',
          routeMethod: 'hm-send-telegram',
        })
      );
    });

    it('does not route user target when inbound context is stale', async () => {
      const { sendRoutedTelegramMessage } = require('../scripts/hm-telegram-routing');
      app.telegramInboundContext = {
        sender: 'james',
        lastInboundAtMs: Date.now() - (6 * 60 * 1000),
      };

      const result = await app.routeTelegramReply({
        target: 'user',
        content: 'Build passed.',
      });

      expect(sendRoutedTelegramMessage).not.toHaveBeenCalled();
      expect(result).toEqual(
        expect.objectContaining({
          handled: true,
          ok: false,
          status: 'telegram_context_stale',
        })
      );
    });

    it('routes explicit telegram target even without recent inbound context', async () => {
      const { sendRoutedTelegramMessage } = require('../scripts/hm-telegram-routing');
      app.telegramInboundContext = {
        sender: null,
        lastInboundAtMs: 0,
        chatId: null,
      };

      const result = await app.routeTelegramReply({
        target: 'telegram',
        content: 'Direct ping.',
        messageId: 'telegram-route-2',
      });

      expect(sendRoutedTelegramMessage).toHaveBeenCalledWith(
        'Direct ping.',
        process.env,
        expect.objectContaining({
          messageId: 'telegram-route-2',
          senderRole: 'system',
          sessionId: expect.any(String),
          metadata: expect.objectContaining({
            routeKind: 'telegram',
            targetRaw: 'telegram',
          }),
          chatId: null,
        })
      );
      expect(result).toEqual(
        expect.objectContaining({
          handled: true,
          ok: true,
          status: 'telegram_delivered',
          routeMethod: 'hm-send-telegram',
        })
      );
    });

    it('does not inherit recent inbound chat context for explicit telegram target', async () => {
      const { sendRoutedTelegramMessage } = require('../scripts/hm-telegram-routing');
      app.telegramInboundContext = {
        sender: '@ScopedContact',
        lastInboundAtMs: Date.now(),
        chatId: '2222222222',
      };

      const result = await app.routeTelegramReply({
        target: 'telegram',
        content: 'Direct ping.',
        messageId: 'telegram-route-default-chat',
      });

      expect(sendRoutedTelegramMessage).toHaveBeenCalledWith(
        'Direct ping.',
        process.env,
        expect.objectContaining({
          messageId: 'telegram-route-default-chat',
          chatId: null,
          metadata: expect.objectContaining({
            routeKind: 'telegram',
            targetRaw: 'telegram',
          }),
        })
      );
      expect(result).toEqual(
        expect.objectContaining({
          handled: true,
          ok: true,
          status: 'telegram_delivered',
          routeMethod: 'hm-send-telegram',
        })
      );
    });

    it('passes chatId override through routeTelegramReply', async () => {
      const { sendRoutedTelegramMessage } = require('../scripts/hm-telegram-routing');

      const result = await app.routeTelegramReply({
        target: 'telegram',
        content: 'Direct ping to Scoped.',
        messageId: 'telegram-route-3',
        chatId: '2222222222',
      });

      expect(sendRoutedTelegramMessage).toHaveBeenCalledWith(
        'Direct ping to Scoped.',
        process.env,
        expect.objectContaining({
          messageId: 'telegram-route-3',
          chatId: '2222222222',
        })
      );
      expect(result).toEqual(
        expect.objectContaining({
          handled: true,
          ok: true,
          status: 'telegram_delivered',
          routeMethod: 'send-long-telegram',
        })
      );
    });
  });

  describe('phase 4 delivery helpers', () => {
    let app;

    beforeEach(() => {
      app = new SquidRunApp(mockAppContext, mockManagers);
      app.teamMemoryInitialized = true;
    });

    it('routes proactive memory injections into the target pane', async () => {
      const teamMemory = require('../modules/team-memory');
      const routeInjectMessage = jest.spyOn(app, 'routeInjectMessage').mockReturnValue(true);
      teamMemory.executeTeamMemoryOperation.mockResolvedValueOnce({
        ok: true,
        injected: true,
        status: 'delivered',
        injection: {
          injection_id: 'inject-1',
          source_tier: 'tier3',
          injection_reason: 'error_signature_match:solution_trace',
          authoritative: false,
          message: '[MEMORY][assistive] error_signature_match\nreason=error_signature_match tier=tier3 confidence=0.90 freshness=2026-03-12T00:00:00.000Z\nReact error #418',
        },
      });

      const result = await app.triggerProactiveMemoryInjection({
        paneId: '2',
        triggerType: 'error_signature_match',
        payload: {
          error_signature: 'React error #418',
          trigger_event_id: 'err-1',
        },
      });

      expect(result).toEqual(expect.objectContaining({
        ok: true,
        injected: true,
        delivered: true,
      }));
      expect(teamMemory.executeTeamMemoryOperation).toHaveBeenCalledWith(
        'trigger-memory-injection',
        expect.objectContaining({
          pane_id: '2',
          trigger_type: 'error_signature_match',
          trigger_event_id: 'err-1',
        })
      );
      expect(routeInjectMessage).toHaveBeenCalledWith(expect.objectContaining({
        panes: ['2'],
        deliveryId: 'inject-1',
        meta: expect.objectContaining({
          memoryInjection: true,
          triggerType: 'error_signature_match',
          sourceTier: 'tier3',
        }),
      }));
    });

    it('advances lifecycle and reviews stale memories during session rollover injection', async () => {
      const teamMemory = require('../modules/team-memory');
      const routeInjectMessage = jest.spyOn(app, 'routeInjectMessage').mockReturnValue(true);
      teamMemory.executeTeamMemoryOperation
        .mockResolvedValueOnce({ ok: true, staleCount: 1, archivedCount: 0, expiredCount: 0 })
        .mockResolvedValueOnce({ ok: true, review_candidates: [] })
        .mockResolvedValueOnce({
          ok: true,
          injected: true,
          status: 'delivered',
          injection: {
            injection_id: 'inject-rollover-1',
            source_tier: 'tier3',
            injection_reason: 'session_rollover:solution_trace',
            authoritative: false,
            message: '[MEMORY][assistive] session_rollover\nreason=session_rollover tier=tier3 confidence=0.90 freshness=2026-03-12T00:00:00.000Z\nResume relay work.',
          },
        });

      const result = await app.triggerProactiveMemoryInjection({
        paneId: '2',
        triggerType: 'session_rollover',
        payload: {
          trigger_event_id: 'rollover-1',
          session_ordinal: 147,
        },
      });

      expect(result).toEqual(expect.objectContaining({
        ok: true,
        injected: true,
        delivered: true,
        lifecycleAdvance: expect.objectContaining({ ok: true, staleCount: 1 }),
        staleReview: expect.objectContaining({ ok: true, review_candidates: [] }),
      }));
      expect(teamMemory.executeTeamMemoryOperation).toHaveBeenNthCalledWith(
        1,
        'advance-memory-lifecycle',
        expect.objectContaining({
          session_ordinal: 147,
        })
      );
      expect(teamMemory.executeTeamMemoryOperation).toHaveBeenNthCalledWith(
        2,
        'review-stale-memories',
        expect.objectContaining({
          limit: 10,
        })
      );
      expect(teamMemory.executeTeamMemoryOperation).toHaveBeenNthCalledWith(
        3,
        'trigger-memory-injection',
        expect.objectContaining({
          pane_id: '2',
          trigger_type: 'session_rollover',
          trigger_event_id: 'rollover-1',
          session_ordinal: 147,
        })
      );
      expect(routeInjectMessage).toHaveBeenCalledWith(expect.objectContaining({
        panes: ['2'],
        deliveryId: 'inject-rollover-1',
        meta: expect.objectContaining({
          memoryInjection: true,
          triggerType: 'session_rollover',
          sourceTier: 'tier3',
        }),
      }));
    });

    it('resumes compaction survival by injecting the survival note back into the pane', async () => {
      const teamMemory = require('../modules/team-memory');
      const routeInjectMessage = jest.spyOn(app, 'routeInjectMessage').mockReturnValue(true);
      teamMemory.executeTeamMemoryOperation.mockResolvedValueOnce({
        ok: true,
        resumed: true,
        injection: {
          message: '[COMPACTION RESUME] Pane 2 context restored\nTier 1 re-read: ARCHITECTURE.md',
        },
      });

      const result = await app.resumeCompactionSurvivalForPane({
        paneId: '2',
      });

      expect(result).toEqual(expect.objectContaining({
        ok: true,
        resumed: true,
      }));
      expect(teamMemory.executeTeamMemoryOperation).toHaveBeenCalledWith(
        'resume-compaction-survival',
        expect.objectContaining({
          pane_id: '2',
        })
      );
      expect(routeInjectMessage).toHaveBeenCalledWith(expect.objectContaining({
        panes: ['2'],
        meta: expect.objectContaining({
          triggerType: 'compaction_survival_resume',
        }),
      }));
    });

    it('sends a cross-device handoff packet and marks it sent after relay delivery', async () => {
      const teamMemory = require('../modules/team-memory');
      const routeBridgeMessage = jest.spyOn(app, 'routeBridgeMessage').mockResolvedValue({
        ok: true,
        accepted: true,
        queued: true,
        verified: true,
        status: 'bridge_delivered',
      });
      teamMemory.executeTeamMemoryOperation.mockImplementation(async (action) => {
        if (action === 'build-cross-device-handoff') {
          return {
            ok: true,
            packet_id: 'handoff-1',
            packet: {
              packet_id: 'handoff-1',
              session_id: 'app-session-test',
              source_device: 'LOCAL',
              target_device: 'PEER',
              active_workstreams: ['Ship Phase 4'],
              unresolved_blockers: ['None'],
            },
            result_refs: [],
          };
        }
        if (action === 'mark-cross-device-handoff-sent') {
          return {
            ok: true,
            packet_id: 'handoff-1',
          };
        }
        return { ok: true, status: 'updated' };
      });

      const result = await app.sendCrossDeviceHandoffPacket({
        targetDevice: 'PEER',
        paneId: '1',
        payload: {
          session_id: 'app-session-test',
          active_workstreams: ['Ship Phase 4'],
          unresolved_blockers: ['None'],
        },
      });

      expect(result).toEqual(expect.objectContaining({
        ok: true,
        packet_id: 'handoff-1',
      }));
      expect(routeBridgeMessage).toHaveBeenCalledWith(expect.objectContaining({
        targetDevice: 'PEER',
        structuredMessage: {
          type: 'handoffpacket',
          payload: {
            packet: expect.objectContaining({
              packet_id: 'handoff-1',
            }),
          },
        },
      }));
      expect(teamMemory.executeTeamMemoryOperation).toHaveBeenCalledWith(
        'mark-cross-device-handoff-sent',
        expect.objectContaining({
          packet_id: 'handoff-1',
        })
      );
    });
  });

  describe('bridge structured message types', () => {
    let app;

    beforeEach(() => {
      app = new SquidRunApp(mockAppContext, mockManagers);
      app.bridgeEnabled = true;
      app.bridgeRuntimeConfig = {
        relayUrl: 'wss://relay.example.test',
        deviceId: 'LOCAL',
      };
      app.bridgeDeviceId = 'LOCAL';
    });

    it('uses profile-specific bridge IDs so Scoped cannot replace the main relay identity', () => {
      const envKeys = [
        'SQUIDRUN_CROSS_DEVICE',
        'SQUIDRUN_RELAY_URL',
        'SQUIDRUN_RELAY_SECRET',
        'SQUIDRUN_DEVICE_ID',
        'SQUIDRUN_PROFILE',
      ];
      const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
      try {
        process.env.SQUIDRUN_CROSS_DEVICE = '1';
        process.env.SQUIDRUN_RELAY_URL = 'wss://relay.example.test';
        process.env.SQUIDRUN_RELAY_SECRET = 'shared';
        process.env.SQUIDRUN_DEVICE_ID = 'VIGIL';
        process.env.SQUIDRUN_PROFILE = 'scoped';

        const config = app.resolveEnvBridgeRuntimeConfig();

        expect(config).toEqual(expect.objectContaining({
          source: 'env',
          deviceId: 'VIGIL-SCOPED',
          relayUrl: 'wss://relay.example.test',
        }));
      } finally {
        for (const key of envKeys) {
          if (previousEnv[key] === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = previousEnv[key];
          }
        }
      }
    });

    it('does not start the cross-device bridge from scoped side profiles', () => {
      const { createBridgeClient } = require('../modules/bridge-client');
      createBridgeClient.mockClear();
      app.activeProfileName = 'scoped';
      app.bridgeEnabled = true;
      app.bridgeRuntimeConfig = {
        relayUrl: 'wss://relay.example.test',
        deviceId: 'VIGIL-SCOPED',
        sharedSecret: 'shared',
      };

      const started = app.startBridgeClient();

      expect(started).toBe(false);
      expect(createBridgeClient).not.toHaveBeenCalled();
      expect(app.bridgeRelayStatus).toEqual(expect.objectContaining({
        running: false,
        state: 'skipped',
        status: 'profile_scope_skipped',
      }));
    });

    it('tracks bridge lifecycle status for reconnect visibility', () => {
      app.kernelBridge.emitBridgeEvent = jest.fn();

      app.handleBridgeClientStatusUpdate({
        type: 'relay.connected',
        state: 'connected',
        status: 'relay_connected',
      });
      app.handleBridgeClientStatusUpdate({
        type: 'relay.reconnecting',
        state: 'connecting',
        status: 'relay_reconnecting',
        reconnectAttempt: 2,
        reconnectDelayMs: 1500,
        reconnectAt: 1234567890,
      });
      app.handleBridgeClientStatusUpdate({
        type: 'relay.disconnected',
        state: 'disconnected',
        status: 'relay_disconnected',
        reason: 'network_lost',
        code: 1006,
      });

      expect(app.getBridgeStatus()).toEqual(expect.objectContaining({
        enabled: true,
        configured: true,
        mode: 'connecting',
        running: false,
        relayUrl: 'wss://relay.example.test',
        deviceId: 'LOCAL',
        state: 'disconnected',
        status: 'relay_disconnected',
        reconnectAttempt: 2,
        nextReconnectDelayMs: 1500,
        nextReconnectAt: 1234567890,
        disconnectCount: 1,
        flapCount: 1,
        lastDisconnectReason: 'network_lost',
        lastDisconnectCode: 1006,
      }));
      expect(app.kernelBridge.emitBridgeEvent).toHaveBeenCalledWith(
        'bridge.relay.status',
        expect.objectContaining({
          flapCount: 1,
          disconnectCount: 1,
          reconnectAttempt: 2,
        })
      );
    });

    it('normalizes outbound structured type and keeps plain content fallback', async () => {
      app.bridgeClient = {
        isReady: jest.fn(() => true),
        sendToDevice: jest.fn(async () => ({
          ok: true,
          accepted: true,
          queued: true,
          verified: true,
          status: 'bridge_delivered',
        })),
      };

      await app.routeBridgeMessage({
        targetDevice: 'peer_a',
        content: 'Approval result: approved by architect.',
        fromRole: 'architect',
        messageId: 'bridge-structured-1',
        traceContext: { traceId: 'trace-structured-1' },
        structuredMessage: {
          type: 'approvalresult',
          payload: {
            requestMessageId: 'bridge-approval-1',
            approved: true,
            approverRole: 'architect',
          },
        },
      });

      expect(app.bridgeClient.sendToDevice).toHaveBeenCalledWith(expect.objectContaining({
        content: 'Approval result: approved by architect.',
        metadata: expect.objectContaining({
          traceId: 'trace-structured-1',
          structured: {
            type: 'ApprovalResult',
            payload: {
              requestMessageId: 'bridge-approval-1',
              approved: true,
              approverRole: 'architect',
            },
          },
        }),
      }));
    });

    it('downgrades unknown outbound structured type to FYI', async () => {
      app.bridgeClient = {
        isReady: jest.fn(() => true),
        sendToDevice: jest.fn(async () => ({
          ok: true,
          accepted: true,
          queued: true,
          verified: true,
          status: 'bridge_delivered',
        })),
      };

      await app.routeBridgeMessage({
        targetDevice: 'peer_a',
        content: 'Unknown structured message fallback',
        fromRole: 'architect',
        messageId: 'bridge-structured-2',
        structuredMessage: {
          type: 'customType',
          payload: {
            detail: 'non-standard structured payload',
          },
        },
      });

      expect(app.bridgeClient.sendToDevice).toHaveBeenCalledWith(expect.objectContaining({
        metadata: expect.objectContaining({
          structured: {
            type: 'FYI',
            payload: {
              category: 'status',
              detail: 'non-standard structured payload',
              impact: 'context-only',
              originalType: 'customType',
            },
          },
        }),
      }));
    });

    it('waits for bridge readiness before sending outbound bridge messages', async () => {
      const readyStates = [false, false, true];
      app.bridgeClient = {
        isReady: jest.fn(() => (readyStates.length > 0 ? readyStates.shift() : true)),
        sendToDevice: jest.fn(async () => ({
          ok: true,
          accepted: true,
          queued: true,
          verified: true,
          status: 'bridge_delivered',
        })),
      };

      const result = await app.routeBridgeMessage({
        targetDevice: 'peer_a',
        content: 'Bridge ready-wait test',
        fromRole: 'architect',
        messageId: 'bridge-ready-wait-1',
      });

      expect(result).toEqual(expect.objectContaining({
        ok: true,
        status: 'bridge_delivered',
      }));
      expect(app.bridgeClient.isReady).toHaveBeenCalled();
      expect(app.bridgeClient.sendToDevice).toHaveBeenCalledTimes(1);
    });

    it('journals and injects inbound structured type with bridge prefix', async () => {
      const triggers = require('../modules/triggers');
      const evidenceLedger = require('../modules/ipc/evidence-ledger-handlers');
      evidenceLedger.executeEvidenceLedgerOperation.mockResolvedValue({ ok: true });

      const result = await app.handleBridgeInboundMessage({
        messageId: 'bridge-in-1',
        fromDevice: 'peer_a',
        content: 'Potential auth file conflict.',
        metadata: {
          structured: {
            type: 'ConflictCheck',
            payload: {
              resource: 'ui/modules/auth.js',
              action: 'write',
              reason: 'updating auth handshake',
            },
          },
        },
      });

      expect(result).toEqual(expect.objectContaining({
        ok: true,
        status: 'bridge_delivered',
      }));
      expect(triggers.sendDirectMessage).toHaveBeenCalledWith(
        ['1'],
        '[Bridge ConflictCheck from PEER_A]: Potential auth file conflict.',
        null
      );
      expect(evidenceLedger.executeEvidenceLedgerOperation).toHaveBeenCalledWith(
        'upsert-comms-journal',
        expect.objectContaining({
          metadata: expect.objectContaining({
            structuredType: 'ConflictCheck',
            structured: {
              type: 'ConflictCheck',
              payload: {
                resource: 'ui/modules/auth.js',
                action: 'write',
                reason: 'updating auth handshake',
              },
            },
          }),
        }),
        expect.any(Object)
      );
    });

    it('formats HandoffPacket bridge messages using the handoff note when available', async () => {
      const triggers = require('../modules/triggers');
      const evidenceLedger = require('../modules/ipc/evidence-ledger-handlers');
      evidenceLedger.executeEvidenceLedgerOperation.mockResolvedValue({ ok: true });
      app.handleInboundHandoffPacket = jest.fn().mockResolvedValue({
        ok: true,
        injection: {
          message: '[HANDOFF PEER_A] Ship Phase 4\nBlockers: none\nSurfaced memories: 1',
        },
      });

      const result = await app.handleBridgeInboundMessage({
        messageId: 'bridge-in-handoff',
        fromDevice: 'peer_a',
        content: 'Cross-device handoff inbound',
        metadata: {
          structured: {
            type: 'HandoffPacket',
            payload: {
              packet: {
                packet_id: 'handoff-1',
              },
            },
          },
        },
      });

      expect(result).toEqual(expect.objectContaining({
        ok: true,
        status: 'bridge_delivered',
      }));
      expect(app.handleInboundHandoffPacket).toHaveBeenCalledWith(
        expect.objectContaining({
          packet_id: 'handoff-1',
        }),
        expect.objectContaining({
          paneId: '1',
        })
      );
      expect(triggers.sendDirectMessage).toHaveBeenCalledWith(
        ['1'],
        '[Bridge HandoffPacket from PEER_A]\n[HANDOFF PEER_A] Ship Phase 4\nBlockers: none\nSurfaced memories: 1',
        null
      );
    });
  });
});
