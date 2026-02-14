/**
 * Smoke tests for hivemind-app.js
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

// Mock memory
jest.mock('../modules/memory', () => ({
  init: jest.fn().mockResolvedValue(),
  shutdown: jest.fn(),
}));

// Mock memory ipc-handlers
jest.mock('../modules/memory/ipc-handlers', () => ({
  registerHandlers: jest.fn(),
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

// Mock team-memory service
jest.mock('../modules/team-memory', () => ({
  initializeTeamMemoryRuntime: jest.fn(async () => ({ ok: true, status: { driver: 'better-sqlite3' } })),
  executeTeamMemoryOperation: jest.fn(async () => ({ ok: true, status: 'updated' })),
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
const HivemindApp = require('../modules/main/hivemind-app');

describe('HivemindApp', () => {
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
    };
  });

  describe('constructor', () => {
    it('should create instance without throwing', () => {
      expect(() => {
        new HivemindApp(mockAppContext, mockManagers);
      }).not.toThrow();
    });

    it('should store context and managers', () => {
      const app = new HivemindApp(mockAppContext, mockManagers);

      expect(app.ctx).toBe(mockAppContext);
      expect(app.settings).toBe(mockManagers.settings);
      expect(app.activity).toBe(mockManagers.activity);
      expect(app.usage).toBe(mockManagers.usage);
    });

    it('should initialize forwarder flags to false', () => {
      const app = new HivemindApp(mockAppContext, mockManagers);

      expect(app.cliIdentityForwarderRegistered).toBe(false);
      expect(app.triggerAckForwarderRegistered).toBe(false);
    });
  });

  describe('resolveTargetToPane', () => {
    let app;

    beforeEach(() => {
      app = new HivemindApp(mockAppContext, mockManagers);
    });

    it('should return null for null/undefined input', () => {
      expect(app.resolveTargetToPane(null)).toBeNull();
      expect(app.resolveTargetToPane(undefined)).toBeNull();
    });

    it('should return paneId for direct numeric strings 1, 2, 5', () => {
      expect(app.resolveTargetToPane('1')).toBe('1');
      expect(app.resolveTargetToPane('2')).toBe('2');
      expect(app.resolveTargetToPane('5')).toBe('5');
    });

    it('should resolve role names to paneIds', () => {
      expect(app.resolveTargetToPane('architect')).toBe('1');
      expect(app.resolveTargetToPane('devops')).toBe('2');
      expect(app.resolveTargetToPane('backend')).toBe('2');
      expect(app.resolveTargetToPane('analyst')).toBe('5');
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
      expect(app.resolveTargetToPane('investigator')).toBe('5');
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
      app = new HivemindApp(mockAppContext, mockManagers);
    });

    it('should not throw when called', () => {
      expect(() => {
        app.shutdown();
      }).not.toThrow();
    });

    it('should call cleanup functions', () => {
      const memory = require('../modules/memory');
      const websocketServer = require('../modules/websocket-server');
      const watcher = require('../modules/watcher');
      const smsPoller = require('../modules/sms-poller');
      const { closeSharedRuntime } = require('../modules/ipc/evidence-ledger-handlers');
      const teamMemory = require('../modules/team-memory');
      const experiment = require('../modules/experiment');

      app.shutdown();

      expect(memory.shutdown).toHaveBeenCalled();
      expect(closeSharedRuntime).toHaveBeenCalled();
      expect(experiment.closeExperimentRuntime).toHaveBeenCalled();
      expect(teamMemory.stopIntegritySweep).toHaveBeenCalled();
      expect(teamMemory.stopBeliefSnapshotSweep).toHaveBeenCalled();
      expect(teamMemory.stopPatternMiningSweep).toHaveBeenCalled();
      expect(teamMemory.closeTeamMemoryRuntime).toHaveBeenCalled();
      expect(websocketServer.stop).toHaveBeenCalled();
      expect(smsPoller.stop).toHaveBeenCalled();
      expect(watcher.stopWatcher).toHaveBeenCalled();
      expect(watcher.stopTriggerWatcher).toHaveBeenCalled();
      expect(watcher.stopMessageWatcher).toHaveBeenCalled();
    });

    it('should disconnect daemon client if present', () => {
      const mockDaemonClient = { disconnect: jest.fn() };
      mockAppContext.daemonClient = mockDaemonClient;
      app = new HivemindApp(mockAppContext, mockManagers);

      app.shutdown();

      expect(mockDaemonClient.disconnect).toHaveBeenCalled();
    });

    it('shuts down cleanly in PTY mode', () => {
      expect(() => app.shutdown()).not.toThrow();
    });
  });

  describe('handleTeamMemoryGuardExperiment', () => {
    let app;

    beforeEach(() => {
      app = new HivemindApp(mockAppContext, mockManagers);
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
          agent: 'analyst',
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
      const app = new HivemindApp(ctx, mockManagers);

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
    it('should export HivemindApp class', () => {
      expect(HivemindApp).toBeDefined();
      expect(typeof HivemindApp).toBe('function');
    });

    it('should have expected methods', () => {
      const app = new HivemindApp(mockAppContext, mockManagers);

      expect(typeof app.init).toBe('function');
      expect(typeof app.shutdown).toBe('function');
      expect(typeof app.resolveTargetToPane).toBe('function');
    });
  });

  describe('SMS poller wiring', () => {
    let app;

    beforeEach(() => {
      app = new HivemindApp(mockAppContext, mockManagers);
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
});
