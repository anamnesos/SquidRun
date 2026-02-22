/**
 * Smoke tests for squidrun-app.js
 * Tests basic initialization and core functions of the main application controller
 *
 * Session 72: Added per audit finding - 650 lines of core code had ZERO tests
 */

// Mock electron (main process APIs)
jest.mock('electron', () => ({
  app: {
    getPath: jest.fn().mockReturnValue('/mock/app/path'),
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
}));

// Mock logger
jest.mock('../modules/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
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
}));

// Mock organic-ui-handlers
jest.mock('../modules/ipc/organic-ui-handlers', () => ({
  registerHandlers: jest.fn(),
}));

// Mock evidence-ledger handlers
jest.mock('../modules/ipc/evidence-ledger-handlers', () => ({
  executeEvidenceLedgerOperation: jest.fn(),
  initializeEvidenceLedgerRuntime: jest.fn(() => ({ ok: true, status: { driver: 'better-sqlite3' } })),
  closeSharedRuntime: jest.fn(),
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

// Now require the module under test
const SquidRunApp = require('../modules/main/squidrun-app');

describe('SquidRunApp', () => {
  let mockAppContext;
  let mockManagers;

  beforeEach(() => {
    jest.clearAllMocks();

    // Create mock app context
    mockAppContext = {
      mainWindow: null,
      daemonClient: null,
      currentSettings: {},
      externalNotifier: null,
      setMainWindow: jest.fn(),
      setDaemonClient: jest.fn(),
      setExternalNotifier: jest.fn(),
    };

    // Create mock managers
    mockManagers = {
      settings: {
        loadSettings: jest.fn(),
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
      expect(loadFile).toHaveBeenCalledWith('index.html');
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
    });

    it('returns failure when message watcher startup throws', async () => {
      watcher.startMessageWatcher.mockRejectedValueOnce(new Error('watcher crashed'));

      const result = await app.startRuntimeServices('test-start');

      expect(result).toEqual({ ok: false, state: 'stopped', error: 'watcher crashed' });
      expect(app.runtimeLifecycleState).toBe('stopped');
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

    it('records session lifecycle events', async () => {
      const teamMemory = require('../modules/team-memory');
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
    });
  });

  describe('initDaemonClient', () => {
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
        null
      );
    });
  });

  describe('Telegram poller wiring', () => {
    let app;

    beforeEach(() => {
      app = new SquidRunApp(mockAppContext, mockManagers);
    });

    it('wires inbound Telegram callback to pane 1 trigger injection', () => {
      const telegramPoller = require('../modules/telegram-poller');
      const triggers = require('../modules/triggers');
      telegramPoller.start.mockReturnValue(true);

      app.startTelegramPoller();

      expect(telegramPoller.start).toHaveBeenCalledTimes(1);
      const options = telegramPoller.start.mock.calls[0][0];
      expect(typeof options.onMessage).toBe('function');

      options.onMessage('build passed', 'james');
      expect(triggers.sendDirectMessage).toHaveBeenCalledWith(
        ['1'],
        '[Telegram from james]: build passed',
        null
      );
      expect(app.telegramInboundContext).toEqual(
        expect.objectContaining({
          sender: 'james',
        })
      );
      expect(app.telegramInboundContext.lastInboundAtMs).toBeGreaterThan(0);
    });
  });

  describe('Telegram auto-reply routing', () => {
    let app;

    beforeEach(() => {
      app = new SquidRunApp(mockAppContext, mockManagers);
    });

    it('routes user target to Telegram when inbound context is recent', async () => {
      const { sendTelegram } = require('../scripts/hm-telegram');
      app.markTelegramInboundContext('james');

      const result = await app.routeTelegramReply({
        target: 'user',
        content: 'Build passed.',
      });

      expect(sendTelegram).toHaveBeenCalledWith(
        'Build passed.',
        process.env,
        expect.objectContaining({
          senderRole: 'system',
          sessionId: expect.any(String),
        })
      );
      expect(result).toEqual(
        expect.objectContaining({
          handled: true,
          ok: true,
          status: 'telegram_delivered',
        })
      );
    });

    it('does not route user target when inbound context is stale', async () => {
      const { sendTelegram } = require('../scripts/hm-telegram');
      app.telegramInboundContext = {
        sender: 'james',
        lastInboundAtMs: Date.now() - (6 * 60 * 1000),
      };

      const result = await app.routeTelegramReply({
        target: 'user',
        content: 'Build passed.',
      });

      expect(sendTelegram).not.toHaveBeenCalled();
      expect(result).toEqual(
        expect.objectContaining({
          handled: true,
          ok: false,
          status: 'telegram_context_stale',
        })
      );
    });

    it('routes explicit telegram target even without recent inbound context', async () => {
      const { sendTelegram } = require('../scripts/hm-telegram');
      app.telegramInboundContext = {
        sender: null,
        lastInboundAtMs: 0,
      };

      const result = await app.routeTelegramReply({
        target: 'telegram',
        content: 'Direct ping.',
      });

      expect(sendTelegram).toHaveBeenCalledWith(
        'Direct ping.',
        process.env,
        expect.objectContaining({
          senderRole: 'system',
          sessionId: expect.any(String),
        })
      );
      expect(result).toEqual(
        expect.objectContaining({
          handled: true,
          ok: true,
          status: 'telegram_delivered',
        })
      );
    });
  });
});
