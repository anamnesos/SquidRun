/**
 * Smoke tests for squidrun-app.js
 * Tests basic initialization and core functions of the main application controller
 *
 * Session 72: Added per audit finding - 650 lines of core code had ZERO tests
 */

/* global afterEach, beforeEach, describe, expect, it, jest */

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
      reloadIgnoringCache: jest.fn(),
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
    getTitle: jest.fn().mockReturnValue(''),
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
  DaemonClient: jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(true),
    disconnect: jest.fn(),
    on: jest.fn(),
    off: jest.fn(),
    getTerminals: jest.fn().mockReturnValue([]),
    connected: true,
  })),
  getDaemonClient: jest.fn().mockReturnValue({
    connect: jest.fn().mockResolvedValue(),
    disconnect: jest.fn(),
    isConnected: jest.fn().mockReturnValue(false),
  }),
}));

jest.mock('../modules/trustquote-work-room-prerequisites', () => ({
  materializeTrustQuoteWorkRoomPrerequisites: jest.fn().mockReturnValue({
    ok: true,
    write: true,
    results: [],
    artifacts: {
      sessionScopeId: 'app-session-384:trustquote',
      paths: {
        startupBundlePath: '/test/workspace/.squidrun/runtime/window-teams/trustquote/startup-bundle.md',
        linkPath: '/test/trustquote/.squidrun/link.json',
        agentsPath: '/test/trustquote/.squidrun/work-rooms/trustquote/startup/AGENTS.md',
        rolesPath: '/test/trustquote/.squidrun/work-rooms/trustquote/startup/ROLES.md',
      },
      startupBundle: '# TrustQuote Startup Bundle\n',
    },
  }),
}));

jest.mock('../modules/trustquote-work-room-route-owner-supervisor', () => ({
  probeTrustQuoteRouteOwner: jest.fn().mockResolvedValue({
    ok: true,
    reachable: true,
    routeHealth: {},
    contract: {
      status: 'proven',
      canRouteTask: true,
      blockers: [],
    },
  }),
  readRouteOwnerStatus: jest.fn().mockReturnValue({
    running: false,
    plan: {},
  }),
  startTrustQuoteRouteOwner: jest.fn().mockReturnValue({
    ok: true,
    started: true,
    status: {
      running: true,
      state: 'running',
      plan: {
        mainSessionScopeId: 'app-session-384',
        sessionScopeId: 'app-session-384:trustquote',
        projectPath: 'D:/projects/TrustQuote',
      },
    },
  }),
  stopTrustQuoteRouteOwner: jest.fn().mockResolvedValue({
    ok: true,
    stopped: true,
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

jest.mock('../modules/main/comms-journal', () => ({
  closeCommsJournalStores: jest.fn(),
  queryCommsJournalEntries: jest.fn(() => []),
}));

jest.mock('../modules/main/telegram-reply-obligations', () => ({
  openTelegramReplyObligation: jest.fn(() => ({
    ok: true,
    status: 'inserted',
    obligation: { obligationId: 'telegram-reply-test' },
  })),
  queryTelegramReplyObligations: jest.fn(() => []),
  satisfyTelegramReplyObligation: jest.fn(() => ({
    ok: true,
    status: 'satisfied',
    obligation: { status: 'satisfied' },
  })),
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
  resolveTelegramInboundRoute: jest.fn(({ chatId } = {}) => {
    const text = chatId === null || chatId === undefined ? null : String(chatId).trim();
    if (!text || text === '1111111111' || (text !== '2222222222' && text !== '3333333333' && text !== '4444444444' && text !== '9999999999')) {
      return { ok: true, chatId: text, windowKey: 'main', profile: 'main', reason: 'owner_chat' };
    }
    if (text === '2222222222') {
      return { ok: true, chatId: text, windowKey: 'scoped', profile: 'scoped', reason: 'explicit_non_owner_route' };
    }
    if (text === '3333333333') {
      return { ok: true, chatId: text, windowKey: 'client-profile', profile: 'client-profile', reason: 'explicit_non_owner_route' };
    }
    if (text === '4444444444') {
      return { ok: true, chatId: text, windowKey: 'eunbyeol', profile: 'eunbyeol', reason: 'explicit_non_owner_route' };
    }
    return { ok: false, blocked: true, chatId: text, reason: 'unknown_non_owner_chat' };
  }),
  sendRoutedTelegramMessage: jest.fn(async (_message, _env, options = {}) => ({
    ok: true,
    chatId: options.chatId ? Number(options.chatId) : 123456789,
    messageId: 42,
    method: options.chatId === '2222222222' ? 'send-long-telegram' : 'hm-send-telegram',
  })),
}));

jest.mock('../modules/mira-live-entrypoint', () => ({
  MIRA_LIVE_PROMPT_REPLY_CHANNEL: 'mira:lab-prompt-reply',
  sendMiraLivePrompt: jest.fn(async () => ({
    ok: true,
    state: 'ready',
    message: 'Mira visible reply from Telegram.',
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

jest.mock('../scripts/hm-telegram-poller-watchdog', () => ({
  checkAndRecoverTelegramPoller: jest.fn(async () => ({
    ok: true,
    freshness: { wedged: false, status: 'fresh' },
    recovery: { ok: true, action: 'none', recovered: false, reason: 'not_wedged' },
  })),
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
const { queryCommsJournalEntries } = require('../modules/main/comms-journal');
const {
  openTelegramReplyObligation,
  queryTelegramReplyObligations,
  satisfyTelegramReplyObligation,
} = require('../modules/main/telegram-reply-obligations');
const {
  attachProof,
  closeWorkItem,
  openWorkItem,
} = require('../modules/main/work-item-ledger');
const {
  buildNewMiraTelegramTurnCandidate,
} = require('../modules/mira-telegram-turn-candidate');
const SquidRunApp = require('../modules/main/squidrun-app');
const trustQuotePrerequisites = require('../modules/trustquote-work-room-prerequisites');
const trustQuoteRouteOwnerSupervisor = require('../modules/trustquote-work-room-route-owner-supervisor');

function resetTrustQuoteWorkRoomMocks() {
  trustQuotePrerequisites.materializeTrustQuoteWorkRoomPrerequisites.mockReturnValue({
    ok: true,
    write: true,
    results: [],
    artifacts: {
      sessionScopeId: 'app-session-384:trustquote',
      paths: {
        startupBundlePath: '/test/workspace/.squidrun/runtime/window-teams/trustquote/startup-bundle.md',
        linkPath: '/test/trustquote/.squidrun/link.json',
        agentsPath: '/test/trustquote/.squidrun/work-rooms/trustquote/startup/AGENTS.md',
        rolesPath: '/test/trustquote/.squidrun/work-rooms/trustquote/startup/ROLES.md',
      },
      startupBundle: '# TrustQuote Startup Bundle\n',
    },
  });
  trustQuoteRouteOwnerSupervisor.readRouteOwnerStatus.mockReturnValue({
    running: false,
    plan: {},
  });
  trustQuoteRouteOwnerSupervisor.probeTrustQuoteRouteOwner.mockResolvedValue({
    ok: true,
    reachable: true,
    routeHealth: {},
    contract: {
      status: 'proven',
      canRouteTask: true,
      blockers: [],
    },
  });
  trustQuoteRouteOwnerSupervisor.startTrustQuoteRouteOwner.mockReturnValue({
    ok: true,
    started: true,
    status: {
      running: true,
      state: 'running',
      plan: {
        mainSessionScopeId: 'app-session-384',
        sessionScopeId: 'app-session-384:trustquote',
        projectPath: 'D:/projects/TrustQuote',
      },
    },
  });
  trustQuoteRouteOwnerSupervisor.stopTrustQuoteRouteOwner.mockResolvedValue({
    ok: true,
    stopped: true,
  });
}

function createReadyTrustQuoteWindow(overrides = {}) {
  const { webContents: webContentsOverrides = {}, ...windowOverrides } = overrides;
  return {
    webContents: {
      send: jest.fn(),
      executeJavaScript: jest.fn().mockResolvedValue({
        ok: true,
        reason: null,
        blockers: [],
        overlayVisible: false,
        startupText: '',
        startupStage: '',
        startupPercent: '100%',
        panes: [
          { paneId: 'trustquote-builder', effectivePaneId: 'trustquote-builder', paneVisible: true, terminalVisible: true, hasTerminalShell: true },
          { paneId: 'trustquote-oracle', effectivePaneId: 'trustquote-oracle', paneVisible: true, terminalVisible: true, hasTerminalShell: true },
        ],
      }),
      ...webContentsOverrides,
    },
    isDestroyed: jest.fn().mockReturnValue(false),
    isVisible: jest.fn().mockReturnValue(true),
    getTitle: jest.fn().mockReturnValue('SquidRun - Trustquote'),
    ...windowOverrides,
  };
}

describe('SquidRunApp', () => {
  let mockAppContext;
  let mockManagers;

  beforeEach(() => {
    jest.clearAllMocks();
    resetTrustQuoteWorkRoomMocks();
    queryCommsJournalEntries.mockReturnValue([]);
    openTelegramReplyObligation.mockReturnValue({
      ok: true,
      status: 'inserted',
      obligation: { obligationId: 'telegram-reply-test' },
    });
    queryTelegramReplyObligations.mockReturnValue([]);
    satisfyTelegramReplyObligation.mockReturnValue({
      ok: true,
      status: 'satisfied',
      obligation: { status: 'satisfied' },
    });
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

  describe('TrustQuote workspace routing', () => {
    it('uses the live route-owner session scope for the TrustQuote window', () => {
      const { readRouteOwnerStatus } = require('../modules/trustquote-work-room-route-owner-supervisor');
      readRouteOwnerStatus.mockReturnValue({
        running: true,
        state: 'running',
        plan: {
          mainSessionScopeId: 'app-session-384',
          sessionScopeId: 'app-session-384:trustquote',
          projectPath: 'D:/projects/TrustQuote',
        },
      });
      const app = new SquidRunApp(mockAppContext, mockManagers);

      expect(app.getWindowSessionScopeId('trustquote')).toBe('app-session-384:trustquote');
    });

    it('syncs TrustQuote artifacts from the already-running route owner before opening', async () => {
      const { DaemonClient } = require('../daemon-client');
      const { materializeTrustQuoteWorkRoomPrerequisites } = require('../modules/trustquote-work-room-prerequisites');
      const { readRouteOwnerStatus } = require('../modules/trustquote-work-room-route-owner-supervisor');
      mockManagers.settings.readAppStatus.mockReturnValue({ session: 384 });
      readRouteOwnerStatus.mockReturnValue({
        running: true,
        state: 'running',
        plan: {
          mainSessionScopeId: 'app-session-384',
          sessionScopeId: 'app-session-384:trustquote',
          projectPath: 'D:/projects/TrustQuote',
        },
      });
      const app = new SquidRunApp(mockAppContext, mockManagers);
      app.commsSessionScopeId = 'app-session-384';
      app.getTrustQuoteMainSessionScopeId = jest.fn(() => 'app-session-384');
      const trustQuoteWindow = createReadyTrustQuoteWindow();
      app.createWindow = jest.fn(async () => {
        mockAppContext.setWindow('trustquote', trustQuoteWindow);
      });
      app.focusAppWindow = jest.fn().mockReturnValue(true);

      const result = await app.openAppWindow('trustquote');

      expect(materializeTrustQuoteWorkRoomPrerequisites).toHaveBeenCalledWith(expect.objectContaining({
        write: true,
        mainSessionScopeId: 'app-session-384',
        projectPath: 'D:/projects/TrustQuote',
      }));
      expect(DaemonClient).toHaveBeenCalledWith({ profileName: 'trustquote' });
      expect(app.createWindow).toHaveBeenCalledWith(expect.objectContaining({
        windowKey: 'trustquote',
        profileName: 'trustquote',
        autoBootAgents: false,
      }));
      expect(result).toEqual(expect.objectContaining({
        ok: true,
        windowKey: 'trustquote',
        visible: true,
        trustQuoteSessionScopeId: 'app-session-384:trustquote',
      }));
    });

    it('refreshes TrustQuote link and workstream proof before probing an already-current route owner', async () => {
      const { materializeTrustQuoteWorkRoomPrerequisites } = require('../modules/trustquote-work-room-prerequisites');
      const {
        probeTrustQuoteRouteOwner,
        readRouteOwnerStatus,
      } = require('../modules/trustquote-work-room-route-owner-supervisor');
      mockManagers.settings.readAppStatus.mockReturnValue({ session: 406 });
      readRouteOwnerStatus.mockReturnValue({
        running: true,
        state: 'running',
        plan: {
          mainSessionScopeId: 'app-session-406',
          sessionScopeId: 'app-session-406:trustquote',
          projectPath: 'D:/projects/TrustQuote',
        },
      });
      materializeTrustQuoteWorkRoomPrerequisites.mockReturnValue({
        ok: true,
        write: true,
        results: [],
        artifacts: {
          sessionScopeId: 'app-session-406:trustquote',
          paths: {
            startupBundlePath: '/test/workspace/.squidrun/runtime/window-teams/trustquote/startup-bundle.md',
            linkPath: '/test/trustquote/.squidrun/link.json',
            agentsPath: '/test/trustquote/.squidrun/work-rooms/trustquote/startup/AGENTS.md',
            rolesPath: '/test/trustquote/.squidrun/work-rooms/trustquote/startup/ROLES.md',
          },
          startupBundle: '# TrustQuote Startup Bundle\n',
        },
      });
      probeTrustQuoteRouteOwner.mockImplementation(() => {
        const refreshedBeforeProbe = materializeTrustQuoteWorkRoomPrerequisites.mock.calls.length > 0;
        return Promise.resolve(refreshedBeforeProbe
          ? {
              ok: true,
              reachable: true,
              routeHealth: {
                builder: { healthy: true, source: 'client_activity' },
                oracle: { healthy: true, source: 'client_activity' },
              },
              contract: {
                status: 'proven',
                canRouteTask: true,
                blockers: [],
              },
            }
          : {
              ok: true,
              reachable: true,
              contract: {
                status: 'blocked',
                canRouteTask: false,
                blockers: [
                  'profile_link_not_current',
                  'workstream_evidence_stale_or_mismatched',
                ],
              },
            });
      });
      const app = new SquidRunApp(mockAppContext, mockManagers);
      app.commsSessionScopeId = 'app-session-406';
      app.getTrustQuoteMainSessionScopeId = jest.fn(() => 'app-session-406');
      const trustQuoteWindow = createReadyTrustQuoteWindow();
      app.createWindow = jest.fn(async () => {
        mockAppContext.setWindow('trustquote', trustQuoteWindow);
      });

      const result = await app.openAppWindow('trustquote');

      expect(materializeTrustQuoteWorkRoomPrerequisites).toHaveBeenCalledWith(expect.objectContaining({
        write: true,
        mainSessionScopeId: 'app-session-406',
        projectPath: 'D:/projects/TrustQuote',
      }));
      expect(probeTrustQuoteRouteOwner).toHaveBeenCalledWith(expect.objectContaining({
        mainSessionScopeId: 'app-session-406',
        projectPath: 'D:/projects/TrustQuote',
      }));
      expect(materializeTrustQuoteWorkRoomPrerequisites.mock.invocationCallOrder[0])
        .toBeLessThan(probeTrustQuoteRouteOwner.mock.invocationCallOrder[0]);
      expect(result).toEqual(expect.objectContaining({
        ok: true,
        windowKey: 'trustquote',
        trustQuoteSessionScopeId: 'app-session-406:trustquote',
      }));
    });

    it('checks TrustQuote window readiness against the retargeted room pane ids', () => {
      const source = fs.readFileSync(path.join(__dirname, '..', 'modules', 'main', 'squidrun-app.js'), 'utf8');

      expect(source).toContain("{ id: 'trustquote-builder', fallbackId: '2' }");
      expect(source).toContain("{ id: 'trustquote-oracle', fallbackId: '3' }");
      expect(source).toContain("document.getElementById('terminal-' + effectivePaneId)");
      expect(source).not.toContain("const paneIds = ['2', '3'];");
    });

    it('resynchronizes a stale TrustQuote route owner to the current session without launching duplicate agents', async () => {
      const {
        readRouteOwnerStatus,
        startTrustQuoteRouteOwner,
        stopTrustQuoteRouteOwner,
      } = require('../modules/trustquote-work-room-route-owner-supervisor');
      mockManagers.settings.readAppStatus.mockReturnValue({ session: 394 });
      const staleStatus = {
        running: true,
        state: 'running',
        plan: {
          mainSessionScopeId: 'app-session-393',
          sessionScopeId: 'app-session-393:trustquote',
          projectPath: 'D:/projects/TrustQuote',
        },
      };
      const currentStatus = {
        running: true,
        state: 'running',
        plan: {
          mainSessionScopeId: 'app-session-394',
          sessionScopeId: 'app-session-394:trustquote',
          projectPath: 'D:/projects/TrustQuote',
        },
      };
      const stoppedStatus = {
        running: false,
        state: 'stopped',
        plan: {
          mainSessionScopeId: 'app-session-394',
          sessionScopeId: 'app-session-394:trustquote',
          projectPath: 'D:/projects/TrustQuote',
        },
      };
      readRouteOwnerStatus.mockImplementation(() => {
        if (startTrustQuoteRouteOwner.mock.calls.length > 0) return currentStatus;
        if (stopTrustQuoteRouteOwner.mock.calls.length > 0) return stoppedStatus;
        return staleStatus;
      });
      const app = new SquidRunApp(mockAppContext, mockManagers);
      app.commsSessionScopeId = 'app-session-394';
      app.getTrustQuoteMainSessionScopeId = jest.fn(() => 'app-session-394');
      const trustQuoteWindow = createReadyTrustQuoteWindow();
      app.createWindow = jest.fn(async () => {
        mockAppContext.setWindow('trustquote', trustQuoteWindow);
      });

      const result = await app.openAppWindow('trustquote');

      expect(stopTrustQuoteRouteOwner).toHaveBeenCalledWith(expect.objectContaining({
        mainSessionScopeId: 'app-session-394',
        attachExistingTerminals: true,
        killTerminalsOnStop: false,
        launchAgents: false,
        reason: 'session_scope_changed',
      }));
      expect(startTrustQuoteRouteOwner).toHaveBeenCalledWith(expect.objectContaining({
        mainSessionScopeId: 'app-session-394',
        attachExistingTerminals: true,
        killTerminalsOnStop: false,
        launchAgents: false,
      }));
      expect(result).toEqual(expect.objectContaining({
        ok: true,
        windowKey: 'trustquote',
        trustQuoteSessionScopeId: 'app-session-394:trustquote',
      }));
    });

    it('restarts a same-session route owner that is still starting before opening TrustQuote', async () => {
      const {
        readRouteOwnerStatus,
        startTrustQuoteRouteOwner,
        stopTrustQuoteRouteOwner,
      } = require('../modules/trustquote-work-room-route-owner-supervisor');
      mockManagers.settings.readAppStatus.mockReturnValue({ session: 394 });
      const startingStatus = {
        running: true,
        state: 'starting',
        plan: {
          mainSessionScopeId: 'app-session-394',
          sessionScopeId: 'app-session-394:trustquote',
          projectPath: 'D:/projects/TrustQuote',
        },
      };
      const stoppedStatus = {
        running: false,
        state: 'stopped',
        plan: startingStatus.plan,
      };
      const runningStatus = {
        running: true,
        state: 'running',
        plan: startingStatus.plan,
      };
      readRouteOwnerStatus.mockImplementation(() => {
        if (startTrustQuoteRouteOwner.mock.calls.length > 0) return runningStatus;
        if (stopTrustQuoteRouteOwner.mock.calls.length > 0) return stoppedStatus;
        return startingStatus;
      });
      const app = new SquidRunApp(mockAppContext, mockManagers);
      app.commsSessionScopeId = 'app-session-394';
      app.getTrustQuoteMainSessionScopeId = jest.fn(() => 'app-session-394');
      const trustQuoteWindow = createReadyTrustQuoteWindow();
      app.createWindow = jest.fn(async () => {
        mockAppContext.setWindow('trustquote', trustQuoteWindow);
      });

      const result = await app.openAppWindow('trustquote');

      expect(stopTrustQuoteRouteOwner).toHaveBeenCalledWith(expect.objectContaining({
        mainSessionScopeId: 'app-session-394',
        attachExistingTerminals: true,
        killTerminalsOnStop: false,
        launchAgents: false,
        reason: 'route_owner_not_ready',
      }));
      expect(startTrustQuoteRouteOwner).toHaveBeenCalledWith(expect.objectContaining({
        mainSessionScopeId: 'app-session-394',
        attachExistingTerminals: true,
        killTerminalsOnStop: false,
        launchAgents: false,
      }));
      expect(result).toEqual(expect.objectContaining({
        ok: true,
        windowKey: 'trustquote',
      }));
    });

    it('fails before opening TrustQuote when route owner is running but unreachable', async () => {
      const {
        probeTrustQuoteRouteOwner,
        readRouteOwnerStatus,
      } = require('../modules/trustquote-work-room-route-owner-supervisor');
      mockManagers.settings.readAppStatus.mockReturnValue({ session: 394 });
      readRouteOwnerStatus.mockReturnValue({
        running: true,
        state: 'running',
        plan: {
          mainSessionScopeId: 'app-session-394',
          sessionScopeId: 'app-session-394:trustquote',
          projectPath: 'D:/projects/TrustQuote',
        },
      });
      probeTrustQuoteRouteOwner.mockResolvedValue({
        ok: false,
        reachable: false,
        error: 'connect ECONNREFUSED 127.0.0.1:9979',
      });
      const app = new SquidRunApp(mockAppContext, mockManagers);
      app.commsSessionScopeId = 'app-session-394';
      app.getTrustQuoteMainSessionScopeId = jest.fn(() => 'app-session-394');
      app.createWindow = jest.fn();

      const result = await app.openAppWindow('trustquote');

      expect(result).toEqual(expect.objectContaining({
        ok: false,
        windowKey: 'trustquote',
        reason: 'trustquote_route_owner_probe_unreachable',
        details: expect.objectContaining({
          probe: expect.objectContaining({
            reachable: false,
          }),
        }),
      }));
      expect(app.createWindow).not.toHaveBeenCalled();
    });

    it('fails before opening TrustQuote when route owner lacks terminal ownership proof', async () => {
      const {
        probeTrustQuoteRouteOwner,
        readRouteOwnerStatus,
      } = require('../modules/trustquote-work-room-route-owner-supervisor');
      mockManagers.settings.readAppStatus.mockReturnValue({ session: 394 });
      readRouteOwnerStatus.mockReturnValue({
        running: true,
        state: 'running',
        plan: {
          mainSessionScopeId: 'app-session-394',
          sessionScopeId: 'app-session-394:trustquote',
          projectPath: 'D:/projects/TrustQuote',
        },
      });
      probeTrustQuoteRouteOwner.mockResolvedValue({
        ok: true,
        reachable: true,
        routeHealth: {
          builder: { healthy: true },
          oracle: { healthy: true },
        },
        contract: {
          status: 'blocked',
          canRouteTask: false,
          blockers: [
            'route_owner_proof_agent_process_not_started:builder',
            'route_owner_proof_agent_process_not_started:oracle',
          ],
        },
      });
      const app = new SquidRunApp(mockAppContext, mockManagers);
      app.commsSessionScopeId = 'app-session-394';
      app.getTrustQuoteMainSessionScopeId = jest.fn(() => 'app-session-394');
      app.createWindow = jest.fn();

      const result = await app.openAppWindow('trustquote');

      expect(result).toEqual(expect.objectContaining({
        ok: false,
        windowKey: 'trustquote',
        reason: 'trustquote_route_owner_probe_blocked',
        details: expect.objectContaining({
          probe: expect.objectContaining({
            contract: expect.objectContaining({
              blockers: expect.arrayContaining([
                'route_owner_proof_agent_process_not_started:builder',
                'route_owner_proof_agent_process_not_started:oracle',
              ]),
            }),
          }),
        }),
      }));
      expect(app.createWindow).not.toHaveBeenCalled();
    });

    it('does not return ok when the TrustQuote window is visible but still bootstrapping with unusable panes', async () => {
      const { readRouteOwnerStatus } = require('../modules/trustquote-work-room-route-owner-supervisor');
      mockManagers.settings.readAppStatus.mockReturnValue({ session: 394 });
      readRouteOwnerStatus.mockReturnValue({
        running: true,
        state: 'running',
        plan: {
          mainSessionScopeId: 'app-session-394',
          sessionScopeId: 'app-session-394:trustquote',
          projectPath: 'D:/projects/TrustQuote',
        },
      });
      const app = new SquidRunApp(mockAppContext, mockManagers);
      app.commsSessionScopeId = 'app-session-394';
      app.getTrustQuoteMainSessionScopeId = jest.fn(() => 'app-session-394');
      const trustQuoteWindow = createReadyTrustQuoteWindow();
      app.createWindow = jest.fn(async () => {
        mockAppContext.setWindow('trustquote', trustQuoteWindow);
      });
      app.focusAppWindow = jest.fn().mockReturnValue(true);
      app.waitForTrustQuoteWindowReadiness = jest.fn().mockResolvedValue({
        ok: false,
        reason: 'trustquote_workroom_unusable',
        blockers: [
          'startup_overlay_visible',
          'startup_progress_zero',
          'pane_trustquote-builder_terminal_unusable',
          'pane_trustquote-oracle_terminal_unusable',
        ],
        overlayVisible: true,
        startupText: 'Starting SquidRun...',
        startupStage: 'Bootstrapping workspace...',
        startupPercent: '0%',
        panes: [
          { paneId: 'trustquote-builder', effectivePaneId: 'trustquote-builder', paneVisible: true, terminalVisible: false, hasTerminalShell: false },
          { paneId: 'trustquote-oracle', effectivePaneId: 'trustquote-oracle', paneVisible: true, terminalVisible: false, hasTerminalShell: false },
        ],
      });

      await expect(app.openAppWindow('trustquote')).resolves.toEqual(expect.objectContaining({
        ok: false,
        windowKey: 'trustquote',
        reason: 'trustquote_workroom_unusable',
        status: 'open_unusable',
        details: expect.objectContaining({
          workroomReadiness: expect.objectContaining({
            startupPercent: '0%',
            blockers: expect.arrayContaining([
              'startup_overlay_visible',
              'startup_progress_zero',
              'pane_trustquote-builder_terminal_unusable',
              'pane_trustquote-oracle_terminal_unusable',
            ]),
          }),
        }),
      }));
    });

    it('does not return ok when TrustQuote window creation fails to register a visible window', async () => {
      const { readRouteOwnerStatus } = require('../modules/trustquote-work-room-route-owner-supervisor');
      mockManagers.settings.readAppStatus.mockReturnValue({ session: 394 });
      readRouteOwnerStatus.mockReturnValue({
        running: true,
        state: 'running',
        plan: {
          mainSessionScopeId: 'app-session-394',
          sessionScopeId: 'app-session-394:trustquote',
          projectPath: 'D:/projects/TrustQuote',
        },
      });
      const app = new SquidRunApp(mockAppContext, mockManagers);
      app.commsSessionScopeId = 'app-session-394';
      app.getTrustQuoteMainSessionScopeId = jest.fn(() => 'app-session-394');
      app.createWindow = jest.fn().mockResolvedValue();
      app.focusAppWindow = jest.fn().mockReturnValue(false);

      await expect(app.openAppWindow('trustquote')).resolves.toEqual(expect.objectContaining({
        ok: false,
        windowKey: 'trustquote',
        reason: 'trustquote_window_not_registered',
        status: 'open_unverified',
      }));
    });

    it('blocks TrustQuote open when startup bundle materialization fails', async () => {
      const { materializeTrustQuoteWorkRoomPrerequisites } = require('../modules/trustquote-work-room-prerequisites');
      const { readRouteOwnerStatus } = require('../modules/trustquote-work-room-route-owner-supervisor');
      mockManagers.settings.readAppStatus.mockReturnValue({ session: 394 });
      readRouteOwnerStatus.mockReturnValue({
        running: true,
        state: 'running',
        plan: {
          mainSessionScopeId: 'app-session-394',
          sessionScopeId: 'app-session-394:trustquote',
          projectPath: 'D:/projects/TrustQuote',
        },
      });
      materializeTrustQuoteWorkRoomPrerequisites.mockImplementation(() => {
        throw new Error('bundle write failed');
      });
      const app = new SquidRunApp(mockAppContext, mockManagers);
      app.commsSessionScopeId = 'app-session-394';
      app.getTrustQuoteMainSessionScopeId = jest.fn(() => 'app-session-394');
      app.createWindow = jest.fn();

      await expect(app.openAppWindow('trustquote')).resolves.toEqual(expect.objectContaining({
        ok: false,
        reason: 'trustquote_workspace_artifact_sync_failed',
      }));
      expect(app.createWindow).not.toHaveBeenCalled();
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
    it('dedupes repeated side-profile visible-window injections by messageId', () => {
      const app = new SquidRunApp(mockAppContext, mockManagers);
      const sendToVisibleWindow = jest.spyOn(app, 'sendToVisibleWindow').mockReturnValue(true);

      const payload = {
        panes: ['2'],
        message: 'Eunbyeol scoped Architect -> Builder message',
        deliveryId: 'delivery-eunbyeol-replay-1',
        traceContext: {
          messageId: 'hm-eunbyeol-visible-replay-1',
        },
        meta: {
          windowKey: 'eunbyeol',
          profileName: 'eunbyeol',
        },
      };

      expect(app.routeInjectMessage(payload)).toBe(true);
      expect(app.routeInjectMessage(payload)).toBe(true);

      const injectCalls = sendToVisibleWindow.mock.calls.filter(([channel]) => channel === 'inject-message');
      expect(injectCalls).toHaveLength(1);
      expect(injectCalls[0][2]).toEqual(expect.objectContaining({ windowKey: 'eunbyeol' }));
      expect(injectCalls[0][1]).toEqual(expect.objectContaining({
        panes: ['2'],
        message: payload.message,
        _ipcPacketized: true,
        _routerAttempted: true,
        meta: expect.objectContaining({
          windowKey: 'eunbyeol',
          profileName: 'eunbyeol',
        }),
      }));
      expect(app.visibleInjectDeliveryCache.size).toBe(1);
    });

    it('does not cache failed side-profile visible-window handoffs', () => {
      const app = new SquidRunApp(mockAppContext, mockManagers);
      const sendToVisibleWindow = jest
        .spyOn(app, 'sendToVisibleWindow')
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(true);

      const payload = {
        panes: ['2'],
        message: 'retry after failed scoped visible handoff',
        traceContext: {
          messageId: 'hm-eunbyeol-visible-retry-1',
        },
        meta: {
          windowKey: 'eunbyeol',
          profileName: 'eunbyeol',
        },
      };

      expect(app.routeInjectMessage(payload)).toBe(false);
      expect(app.routeInjectMessage(payload)).toBe(true);
      expect(sendToVisibleWindow.mock.calls.filter(([channel]) => channel === 'inject-message')).toHaveLength(2);
      expect(app.visibleInjectDeliveryCache.size).toBe(1);
    });

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
        expect(payload._ipcPacketized).toBe(true);
        expect(payload._routerAttempted).toBe(true);
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

    it('prefers the visible main window over hidden pane-host delivery for normal injections', () => {
      const app = new SquidRunApp(mockAppContext, mockManagers);
      app.ctx.currentSettings.hiddenPaneHostsEnabled = true;
      const mainWindow = {
        isDestroyed: jest.fn(() => false),
        webContents: {
          isDestroyed: jest.fn(() => false),
          send: jest.fn(),
        },
      };
      app.registerAppWindow('main', mainWindow);
      const sendPaneHostBridgeEvent = jest.spyOn(app, 'sendPaneHostBridgeEvent').mockReturnValue(true);
      app.paneHostReady = new Set(['1']);
      app.paneHostWindowManager.getPaneWindow = jest.fn(() => ({
        isDestroyed: jest.fn(() => false),
        webContents: {
          isDestroyed: jest.fn(() => false),
          isLoadingMainFrame: jest.fn(() => false),
        },
      }));

      const routed = app.routeInjectMessage({
        panes: ['1'],
        message: 'visible-main-before-hidden-host',
        traceContext: {
          messageId: 'hm-visible-main-before-hidden-host',
        },
      });

      expect(routed).toBe(true);
      expect(sendPaneHostBridgeEvent).not.toHaveBeenCalled();
      expect(app.paneHostWindowManager.getPaneWindow).not.toHaveBeenCalled();
      expect(mainWindow.webContents.send).toHaveBeenCalledWith(
        'inject-message',
        expect.objectContaining({
          panes: ['1'],
          message: 'visible-main-before-hidden-host',
          _ipcPacketized: true,
          _routerAttempted: true,
        })
      );
    });

    it('still routes visible-renderer hidden pane-host handoff after visible-window delivery', () => {
      const app = new SquidRunApp(mockAppContext, mockManagers);
      app.ctx.currentSettings.hiddenPaneHostsEnabled = true;
      const mainWindow = {
        isDestroyed: jest.fn(() => false),
        webContents: {
          isDestroyed: jest.fn(() => false),
          send: jest.fn(),
        },
      };
      app.registerAppWindow('main', mainWindow);
      const sendPaneHostBridgeEvent = jest.spyOn(app, 'sendPaneHostBridgeEvent').mockReturnValue(true);
      app.paneHostReady = new Set(['1']);
      app.paneHostWindowManager.getPaneWindow = jest.fn(() => ({
        isDestroyed: jest.fn(() => false),
        webContents: {
          isDestroyed: jest.fn(() => false),
          isLoadingMainFrame: jest.fn(() => false),
        },
      }));
      const traceContext = { messageId: 'hm-visible-then-hidden-echo' };

      expect(app.routeInjectMessage({
        panes: ['1'],
        message: 'visible first payload',
        traceContext,
      })).toBe(true);

      mainWindow.webContents.send.mockClear();
      expect(app.routeInjectMessage({
        panes: ['1'],
        message: 'same message after renderer stripping prefix',
        traceContext,
        meta: {
          preferHiddenPaneHost: true,
        },
      })).toBe(true);

      expect(sendPaneHostBridgeEvent).toHaveBeenCalledWith(
        '1',
        'inject-message',
        expect.objectContaining({
          message: 'same message after renderer stripping prefix',
          traceContext,
        })
      );
      expect(mainWindow.webContents.send).not.toHaveBeenCalled();
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
        verified: false,
        status: 'pane_host_route_pending',
        reason: 'hidden_pane_host_delivery_pending',
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
          disableVisibleFallback: true,
          ipcChunked: true,
          ipcOriginalBytes: Buffer.byteLength(message, 'utf8'),
        }),
      }));
    });

    it('binds Mira Lab sendAgentMessage as a Mira-authored Architect pane route with metadata', async () => {
      const watcher = require('../modules/watcher');
      const ipcHandlers = require('../modules/ipc-handlers');
      const pipeline = require('../modules/pipeline');
      const sharedState = require('../modules/shared-state');
      const contextCompressor = require('../modules/context-compressor');
      const triggers = require('../modules/triggers');
      const app = new SquidRunApp(mockAppContext, mockManagers);
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
      triggers.sendDirectMessage.mockReturnValueOnce({ accepted: true, queued: true, status: 'routed_unverified' });

      app.initModules();

      const setupDeps = ipcHandlers.setupIPCHandlers.mock.calls.at(-1)[0];
      const result = await setupDeps.sendAgentMessage(
        'architect',
        '(MIRA/NEW-MIRA CAPABILITY NOTE): I can inject to Architect now.',
        {
          source: 'new_mira_typed_capability_roundtable',
          senderRole: 'mira',
          senderIdentity: 'new_mira',
          routeKind: 'internal_pane_message',
          sessionScopeId: 'app-session-372',
        }
      );

      expect(result).toEqual({ accepted: true, queued: true, status: 'routed_unverified' });
      expect(triggers.sendDirectMessage).toHaveBeenCalledWith(
        ['1'],
        '(MIRA/NEW-MIRA CAPABILITY NOTE): I can inject to Architect now.',
        'mira',
        expect.objectContaining({
          meta: expect.objectContaining({
            source: 'new_mira_typed_capability_roundtable',
            senderRole: 'mira',
            senderIdentity: 'new_mira',
            routeKind: 'internal_pane_message',
            deliverySource: 'new_mira_typed_capability_roundtable',
            targetRole: 'architect',
            sessionScopeId: 'app-session-372',
          }),
        })
      );
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

    it('opens Squid Room as display-only without TrustQuote preparation or startup bundle materialization', async () => {
      const prepareTrustQuote = jest.spyOn(app, 'prepareTrustQuoteWorkspaceOpen');
      const writeBundle = jest.spyOn(app, 'writeProfileStartupBundle');

      await expect(app.openAppWindow('squid-room')).resolves.toEqual(expect.objectContaining({
        ok: true,
        windowKey: 'squid-room',
        title: 'SquidRun - Squid Room',
      }));

      expect(prepareTrustQuote).not.toHaveBeenCalled();
      expect(writeBundle).not.toHaveBeenCalled();
      const squidRoomWindow = app.ctx.getWindow('squid-room');
      expect(squidRoomWindow.loadFile).toHaveBeenCalledWith(
        expect.stringContaining('index.html'),
        expect.objectContaining({
          query: expect.objectContaining({
            windowKey: 'squid-room',
            windowTeam: 'squid-room',
            profileName: 'main',
            profileLabel: 'Main',
            startupBundlePath: '',
            startupBundleReady: 'false',
            autoBootAgents: 'false',
            displayOnly: 'true',
            skipStartupBundle: 'true',
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
          _ipcPacketized: true,
          _routerAttempted: true,
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

    it('openAppWindow("mira-lab") creates the standalone Mira Lab window, registers it, suppresses menu chrome, and focuses it', async () => {
      const enforceMenuSpy = jest.spyOn(app, 'enforceMenuSuppression');
      const result = await app.openAppWindow('mira-lab');

      expect(result).toEqual(expect.objectContaining({
        ok: true,
        windowKey: 'mira-lab',
        title: 'Mira Lab',
      }));
      expect(result.htmlPath).toMatch(/mira-lab\.html$/);
      expect(result.preloadPath).toMatch(/preload\.js$/);

      expect(app.ctx.setWindow).toHaveBeenCalledWith('mira-lab', expect.any(Object));
      const miraLabWindow = app.ctx.getWindow('mira-lab');
      expect(miraLabWindow).toBeTruthy();
      expect(miraLabWindow).not.toBe(app.ctx.mainWindow);
      expect(miraLabWindow.loadFile).toHaveBeenCalledWith(expect.stringMatching(/mira-lab\.html$/));
      expect(miraLabWindow.focus).toHaveBeenCalled();
      expect(enforceMenuSpy).toHaveBeenCalledWith(miraLabWindow);
      expect(app.setupWindowListeners).toHaveBeenCalledWith(
        miraLabWindow,
        expect.objectContaining({ windowKey: 'mira-lab', lifecycleRoot: false }),
      );
    });

    it('openAppWindow("mira-lab") cleans the registry through the shared closed-window pipeline', async () => {
      app.setupWindowListeners.mockRestore();

      await app.openAppWindow('mira-lab');
      const miraLabWindow = app.ctx.getWindow('mira-lab');
      const closedHandler = miraLabWindow.on.mock.calls.find(([eventName]) => eventName === 'closed')?.[1];

      expect(typeof closedHandler).toBe('function');
      closedHandler();

      expect(app.ctx.deleteWindow).toHaveBeenCalledWith('mira-lab');
      expect(app.ctx.getWindow('mira-lab')).toBeNull();
    });

    it('openAppWindow("mira-lab") reuses an already-open Mira Lab window instead of duplicating it', async () => {
      const first = await app.openAppWindow('mira-lab');
      const miraLabWindow = app.ctx.getWindow('mira-lab');
      miraLabWindow.focus.mockClear();

      const second = await app.openAppWindow('mira-lab');

      expect(second).toEqual(expect.objectContaining({
        ok: true,
        windowKey: 'mira-lab',
        status: 'reused_existing',
      }));
      expect(miraLabWindow.focus).toHaveBeenCalled();
      expect(app.ctx.getWindow('mira-lab')).toBe(miraLabWindow);
      expect(first.htmlPath).toMatch(/mira-lab\.html$/);
    });

    it('openAppWindow("mira-lab") returns a structured failure when the factory yields no window', async () => {
      const factoryModule = require('../modules/main/mira-lab-window');
      const originalFactory = factoryModule.createMiraLabWindow;
      factoryModule.createMiraLabWindow = jest.fn(() => ({}));
      try {
        const result = await app.openAppWindow('mira-lab');
        expect(result).toEqual(expect.objectContaining({
          ok: false,
          windowKey: 'mira-lab',
          reason: expect.stringContaining('mira_lab_window_factory_returned_no_window'),
        }));
        expect(app.ctx.setWindow).not.toHaveBeenCalledWith('mira-lab', expect.anything());
      } finally {
        factoryModule.createMiraLabWindow = originalFactory;
      }
    });

    it('openAppWindow("live-task-audit-sidecar") creates the standalone task audit sidecar', async () => {
      const enforceMenuSpy = jest.spyOn(app, 'enforceMenuSuppression');
      const result = await app.openAppWindow('live-task-audit-sidecar');

      expect(result).toEqual(expect.objectContaining({
        ok: true,
        windowKey: 'live-task-audit-sidecar',
        title: 'SquidRun Task Audit',
      }));
      expect(result.htmlPath).toMatch(/live-task-audit-sidecar\.html$/);
      expect(result.preloadPath).toMatch(/preload\.js$/);

      expect(app.ctx.setWindow).toHaveBeenCalledWith('live-task-audit-sidecar', expect.any(Object));
      const sidecarWindow = app.ctx.getWindow('live-task-audit-sidecar');
      expect(sidecarWindow).toBeTruthy();
      expect(sidecarWindow).not.toBe(app.ctx.mainWindow);
      expect(sidecarWindow.loadFile).toHaveBeenCalledWith(expect.stringMatching(/live-task-audit-sidecar\.html$/));
      expect(sidecarWindow.focus).toHaveBeenCalled();
      expect(enforceMenuSpy).toHaveBeenCalledWith(sidecarWindow);
      expect(app.setupWindowListeners).toHaveBeenCalledWith(
        sidecarWindow,
        expect.objectContaining({ windowKey: 'live-task-audit-sidecar', lifecycleRoot: false }),
      );
    });

    it('openAppWindow("live-task-audit-sidecar") reloads a reused sidecar before focusing it', async () => {
      await app.openAppWindow('live-task-audit-sidecar');
      const sidecarWindow = app.ctx.getWindow('live-task-audit-sidecar');
      sidecarWindow.focus.mockClear();
      sidecarWindow.webContents.reloadIgnoringCache.mockClear();

      const result = await app.openAppWindow('live-task-audit-sidecar');

      expect(result).toEqual(expect.objectContaining({
        ok: true,
        windowKey: 'live-task-audit-sidecar',
        status: 'reused_existing_reloaded',
      }));
      expect(sidecarWindow.webContents.reloadIgnoringCache).toHaveBeenCalledTimes(1);
      expect(sidecarWindow.focus).toHaveBeenCalled();
      expect(app.ctx.getWindow('live-task-audit-sidecar')).toBe(sidecarWindow);
    });

    it('closing a standalone Scoped profile window quits that profile process cleanly', async () => {
      app.setupWindowListeners.mockRestore();
      const shutdownSpy = jest.spyOn(app, 'performFullShutdown').mockResolvedValue({ success: true });

      await app.launchWindowsForProfile({
        windowKey: 'scoped',
        includeMainWindow: false,
      });
      const scopedWindow = app.ctx.getWindow('scoped');
      const closeHandler = scopedWindow.on.mock.calls.find(([eventName]) => eventName === 'close')?.[1];

      expect(app.isStandaloneProfileWindow('scoped')).toBe(true);
      expect(typeof closeHandler).toBe('function');

      const event = { preventDefault: jest.fn() };
      closeHandler(event);

      expect(event.preventDefault).toHaveBeenCalled();
      expect(shutdownSpy).toHaveBeenCalledWith('profile-window-close:scoped');
    });

    it('refuses close-window IPC for main so callers use the quit flow', async () => {
      await app.createWindow();

      await expect(app.closeAppWindow('main')).resolves.toEqual({
        ok: false,
        reason: 'main_window_requires_quit',
        windowKey: 'main',
      });
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
          startupBundlePath: '/test/workspace/runtime/window-teams/scoped/startup-bundle.md',
          startupSourceFiles: [],
          startupBundleReady: false,
          standaloneWindow: false,
          lifecycleMode: 'secondary-window',
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

    it('does not write a startup bundle when Squid Room finishes loading', async () => {
      app.setupWindowListeners.mockRestore();
      const bundleSpy = jest.spyOn(app, 'writeProfileStartupBundle').mockResolvedValue({
        bundlePath: '/test/workspace/runtime/window-teams/squid-room/startup-bundle.md',
        sourcePaths: ['/test/profile/AGENTS.md'],
        text: 'should not be written',
      });

      await app.createWindow({
        windowKey: 'squid-room',
        windowTeam: 'squid-room',
        profileName: 'main',
        autoBootAgents: false,
        displayOnly: true,
        skipStartupBundle: true,
      });
      const squidRoomWindow = app.ctx.getWindow('squid-room');
      const didFinishLoad = squidRoomWindow.webContents.on.mock.calls.find(([eventName]) => eventName === 'did-finish-load')?.[1];

      expect(typeof didFinishLoad).toBe('function');

      await didFinishLoad();

      expect(bundleSpy).not.toHaveBeenCalled();
      expect(squidRoomWindow.webContents.send).toHaveBeenCalledWith(
        'window-context',
        expect.objectContaining({
          windowKey: 'squid-room',
          windowTeam: 'squid-room',
          profileName: 'main',
          startupBundlePath: null,
          startupSourceFiles: [],
          startupBundleReady: false,
          autoBootAgents: false,
          displayOnly: true,
          skipStartupBundle: true,
          standaloneWindow: false,
          lifecycleMode: 'secondary-window',
        })
      );
    });

    it('auto-boots agents for standalone non-main profile windows', async () => {
      app.setupWindowListeners.mockRestore();
      jest.spyOn(app, 'initPostLoad').mockResolvedValue();
      const bundleSpy = jest.spyOn(app, 'writeProfileStartupBundle').mockResolvedValue({
        bundlePath: '/test/workspace/runtime/window-teams/eunbyeol/startup-bundle.md',
        sourcePaths: ['/test/profile/AGENTS.md', '/test/profile/CLAUDE.md', '/test/profile/ROLES.md'],
        text: 'Eunbyeol startup bundle',
        sessionScopeId: 'app-test:eunbyeol',
      });
      app.activeProfileName = 'eunbyeol';

      await app.launchWindowsForProfile({
        profileName: 'eunbyeol',
        windowKey: 'eunbyeol',
        includeMainWindow: false,
      });
      const profileWindow = app.ctx.getWindow('eunbyeol');
      const didFinishLoad = profileWindow.webContents.on.mock.calls.find(([eventName]) => eventName === 'did-finish-load')?.[1];

      expect(typeof didFinishLoad).toBe('function');
      expect(profileWindow.loadFile).toHaveBeenCalledWith(
        expect.stringContaining('index.html'),
        expect.objectContaining({
          query: expect.objectContaining({
            windowKey: 'eunbyeol',
            windowTeam: 'eunbyeol',
            profileName: 'eunbyeol',
            profileLabel: 'Eunbyeol',
            startupBundleReady: 'true',
            autoBootAgents: 'true',
            standaloneWindow: 'true',
            lifecycleMode: 'standalone-profile-app',
            contextReady: 'true',
          }),
        })
      );

      await didFinishLoad();

      expect(bundleSpy).toHaveBeenCalledWith('eunbyeol');
      expect(profileWindow.webContents.send).toHaveBeenCalledWith(
        'window-context',
        expect.objectContaining({
          windowKey: 'eunbyeol',
          windowTeam: 'eunbyeol',
          profileName: 'eunbyeol',
          profileLabel: 'Eunbyeol',
          startupBundlePath: '/test/workspace/runtime/window-teams/eunbyeol/startup-bundle.md',
          startupBundleReady: true,
          autoBootAgents: true,
          standaloneWindow: true,
          lifecycleMode: 'standalone-profile-app',
        })
      );
    });

    it('writes profile-local link metadata so side agents keep the profile workspace identity', () => {
      const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-eunbyeol-profile-'));
      try {
        app.commsSessionScopeId = 'app-test';
        const linkPath = app.ensureProfileWorkspaceLink('eunbyeol', profileRoot);
        const payload = JSON.parse(fs.readFileSync(linkPath, 'utf8'));

        expect(payload).toEqual(expect.objectContaining({
          workspace: profileRoot.replace(/\\/g, '/'),
          session_id: 'app-test:eunbyeol',
          profile: 'eunbyeol',
          version: 1,
        }));
        expect(payload.comms.hm_send).toContain('/ui/scripts/hm-send.js');
      } finally {
        fs.rmSync(profileRoot, { recursive: true, force: true });
      }
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
      const { checkAndRecoverTelegramPoller } = require('../scripts/hm-telegram-poller-watchdog');
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
      expect(checkAndRecoverTelegramPoller).toHaveBeenCalledWith(expect.objectContaining({
        projectRoot: '/test',
        staleThresholdMs: undefined,
      }));
      expect(checkAndRecoverTelegramPoller.mock.invocationCallOrder[0])
        .toBeLessThan(createHealthSnapshot.mock.invocationCallOrder[0]);
      expect(createHealthSnapshot.mock.calls[0][0].bridgeStatus).toEqual(expect.objectContaining({
        state: expect.any(String),
      }));
      expect(teamMemory.initializeTeamMemoryRuntime).not.toHaveBeenCalled();
    });

    it('skips Telegram poller recovery for side-profile startup health artifacts', async () => {
      const app = new SquidRunApp(mockAppContext, mockManagers);
      const evidenceLedger = require('../modules/ipc/evidence-ledger-handlers');
      const { checkAndRecoverTelegramPoller } = require('../scripts/hm-telegram-poller-watchdog');
      evidenceLedger.executeEvidenceLedgerOperation.mockResolvedValueOnce({
        session: 777,
        status: 'ACTIVE',
        mode: 'APP',
      });
      const writeFileAtomic = jest.spyOn(app, 'writeFileAtomic').mockReturnValue(true);

      const result = await app.refreshStartupHealthArtifacts({
        profileName: 'eunbyeol',
        sessionNumber: 777,
      });

      expect(result.telegramPollerRecovery).toEqual({
        ok: true,
        skipped: true,
        reason: 'profile_not_owner',
      });
      expect(checkAndRecoverTelegramPoller).not.toHaveBeenCalled();
      expect(writeFileAtomic).toHaveBeenCalledWith(
        expect.stringContaining('startup-health-eunbyeol.md'),
        expect.any(String)
      );
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

    it('writes side-profile startup health to scoped artifact without overwriting main report', async () => {
      const app = new SquidRunApp(mockAppContext, mockManagers);
      const evidenceLedger = require('../modules/ipc/evidence-ledger-handlers');
      const { createHealthSnapshot } = require('../scripts/hm-health-snapshot');
      createHealthSnapshot.mockReturnValueOnce({
        generatedAt: '2026-03-13T00:00:00.000Z',
        profileName: 'eunbyeol',
        appStatus: {
          sessionNumber: 777,
          sessionId: 'app-session-777-eunbyeol',
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
          evidenceLedger: { exists: true, rowCount: 7 },
          cognitiveMemory: { exists: true, rowCount: 11 },
        },
        bridge: {
          enabled: true,
          configured: true,
          mode: 'connected',
          running: true,
          relayUrl: 'wss://relay.example.test',
          deviceId: 'EUNBYEOL',
          state: 'connected',
        },
        memoryConsistency: {
          status: 'in_sync',
          synced: true,
          summary: {},
        },
        status: { level: 'ok', warnings: [] },
      });
      evidenceLedger.executeEvidenceLedgerOperation.mockResolvedValueOnce({
        session: 999,
        status: 'ACTIVE',
        mode: 'APP',
      });
      const writeFileAtomic = jest.spyOn(app, 'writeFileAtomic').mockReturnValue(true);

      const result = await app.refreshStartupHealthArtifacts({
        profileName: 'eunbyeol',
      });

      expect(result.outputPath).toContain('startup-health-eunbyeol.md');
      expect(result.outputPath).not.toContain('startup-health.md');
      expect(writeFileAtomic).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('startup-health-eunbyeol.md'),
        expect.stringContaining('App Session: unknown')
      );
      expect(writeFileAtomic).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('startup-health-eunbyeol.md'),
        expect.stringContaining('Session context: session 777 ACTIVE (APP)')
      );
      expect(createHealthSnapshot).toHaveBeenCalledWith(expect.objectContaining({
        projectRoot: '/test',
        profileName: 'eunbyeol',
      }));
      expect(evidenceLedger.executeEvidenceLedgerOperation).toHaveBeenCalledWith(
        'get-context',
        { sessionNumber: 777 },
        expect.objectContaining({
          source: expect.objectContaining({
            via: 'startup-health',
            profileName: 'eunbyeol',
          }),
        })
      );
    });

    it('keeps explicit side-profile session fields consistent across placeholder, snapshot, and ledger', async () => {
      const app = new SquidRunApp(mockAppContext, mockManagers);
      const evidenceLedger = require('../modules/ipc/evidence-ledger-handlers');
      const { createHealthSnapshot } = require('../scripts/hm-health-snapshot');
      createHealthSnapshot.mockReturnValueOnce({
        generatedAt: '2026-03-13T00:00:00.000Z',
        profileName: 'eunbyeol',
        appStatus: {
          sessionNumber: 777,
          sessionId: 'app-session-777-eunbyeol',
        },
        tests: {
          testFileCount: 1,
          jestList: { ok: true, count: 1 },
        },
        modules: {
          moduleFileCount: 1,
          keyModules: {},
        },
        databases: {
          evidenceLedger: { exists: true, rowCount: 7 },
          cognitiveMemory: { exists: true, rowCount: 11 },
        },
        bridge: {
          enabled: false,
          configured: false,
          mode: 'disabled',
          running: false,
        },
        memoryConsistency: {
          status: 'in_sync',
          synced: true,
          summary: {},
        },
        status: { level: 'ok', warnings: [] },
      });
      evidenceLedger.executeEvidenceLedgerOperation.mockResolvedValueOnce({
        session: 312,
        status: 'ACTIVE',
        mode: 'APP',
      });
      const writeFileAtomic = jest.spyOn(app, 'writeFileAtomic').mockReturnValue(true);

      await app.refreshStartupHealthArtifacts({
        profileName: 'eunbyeol',
        sessionNumber: 777,
      });

      expect(writeFileAtomic).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('startup-health-eunbyeol.md'),
        expect.stringContaining('App Session: session 777')
      );
      expect(writeFileAtomic).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('startup-health-eunbyeol.md'),
        expect.stringContaining('Session context: session 777 ACTIVE (APP)')
      );
      const writeTargets = writeFileAtomic.mock.calls.map(([targetPath]) => String(targetPath).replace(/\\/g, '/'));
      expect(writeTargets.some((targetPath) => targetPath.endsWith('/build/startup-health.md'))).toBe(false);
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

    it('emits pending visibility events for unverified Oracle verdict delivery', async () => {
      const { app, options, triggers } = await initWebSocketApp();
      app.kernelBridge.emitBridgeEvent = jest.fn();
      triggers.sendDirectMessage.mockResolvedValueOnce({
        accepted: true,
        queued: true,
        verified: false,
        status: 'accepted.daemon_pty_unverified',
        deliveryId: 'delivery-verdict-pending-1',
        mode: 'pty',
        notified: ['1'],
      });

      await options.onMessage({
        role: 'oracle',
        paneId: '3',
        traceContext: { traceId: 'hm-oracle-79' },
        message: {
          type: 'send',
          target: 'architect',
          content: '(ORACLE 79): PASS',
          messageId: 'hm-oracle-79',
        },
      });

      expect(app.kernelBridge.emitBridgeEvent).toHaveBeenCalledWith(
        'comms.verdict.pending',
        expect.objectContaining({
          kind: 'oracle_verdict_visibility_pending',
          messageId: 'hm-oracle-79',
          sourceRef: 'oracle#79',
          verdict: 'PASS',
          status: 'routed',
          ackStatus: 'accepted.daemon_pty_unverified',
          senderRole: 'oracle',
          targetRole: 'architect',
        }),
        'system'
      );
      expect(triggers.sendDirectMessage).toHaveBeenCalledTimes(1);
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

    it('suppresses a stale watchdog when later comms quote back the timed-out task', () => {
      jest.useFakeTimers();
      resolveRuntimeInt.mockImplementation((key, fallback) => (
        key === 'agentResponseWatchdogMs' ? 30 * 1000 : fallback
      ));
      queryCommsJournalEntries.mockReturnValue([
        {
          messageId: 'm-builder-ack',
          senderRole: 'builder',
          targetRole: 'architect',
          channel: 'ws',
          direction: 'outbound',
          status: 'brokered',
          rawBody: '(BUILDER #5): ACK ARCHITECT #12. Proceeding on the focused patch.',
          brokeredAtMs: new Date('2026-03-28T10:10:15').getTime(),
        },
        {
          messageId: 'm-builder-cleanup',
          senderRole: 'builder',
          targetRole: 'architect',
          channel: 'ws',
          direction: 'outbound',
          status: 'brokered',
          rawBody: '(BUILDER #7): ACK ARCHITECT #17. Cleanup complete; patch reverted.',
          brokeredAtMs: new Date('2026-03-28T10:12:00').getTime(),
        },
      ]);
      const app = new SquidRunApp(mockAppContext, mockManagers);
      app.commsSessionScopeId = 'app-session-336';

      app.scheduleAgentResponseWatchdog({
        senderRole: 'architect',
        targetRole: 'builder',
        content: '(ARCHITECT #12): TASK: startup-health bridge probe accuracy.',
        sentAtMs: new Date('2026-03-28T10:10:00').getTime(),
      });

      jest.advanceTimersByTime(30 * 1000);

      expect(queryCommsJournalEntries).toHaveBeenCalledWith({
        sessionId: 'app-session-336',
        sinceMs: new Date('2026-03-28T10:10:00').getTime(),
        order: 'asc',
        limit: 500,
      });
      expect(spawn).not.toHaveBeenCalled();
      expect(app.pendingAgentResponseWatchdogs.size).toBe(0);

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

    it('suppresses architect-to-oracle watchdog when the matching work item is terminal', () => {
      jest.useFakeTimers();
      resolveRuntimeInt.mockImplementation((key, fallback) => (
        key === 'agentResponseWatchdogMs' ? 30 * 1000 : fallback
      ));
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-watchdog-work-item-terminal-'));
      const workItemRoot = path.join(tempRoot, 'runtime', 'work-items');
      try {
        openWorkItem({
          id: 'wi-watchdog-terminal',
          session: 'app-session-389',
          profile: 'main',
          window: 'main',
          sourceMessageIds: ['m-architect-oracle-terminal'],
          objective: 'Oracle verify the terminal watchdog suppression patch',
          ownerRoles: ['builder', 'oracle'],
        }, {
          workItemRoot,
          now: '2026-05-30T10:00:00.000Z',
        });
        closeWorkItem({
          id: 'wi-watchdog-terminal',
          verdict: 'passed',
          reason: 'terminal before stale watchdog fired',
        }, {
          workItemRoot,
          now: '2026-05-30T10:01:00.000Z',
        });
        const app = new SquidRunApp(mockAppContext, mockManagers);
        app.commsSessionScopeId = 'app-session-389';
        app.agentResponseWatchdogWorkItemRoot = workItemRoot;

        app.scheduleAgentResponseWatchdog({
          senderRole: 'architect',
          targetRole: 'oracle',
          sourceMessageId: 'm-architect-oracle-terminal',
          content: '(ARCHITECT #200): Verify wi-watchdog-terminal and report.',
          sentAtMs: new Date('2026-05-30T10:00:30').getTime(),
        });

        jest.advanceTimersByTime(30 * 1000);
        expect(spawn).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
        jest.useRealTimers();
      }
    });

    it('suppresses architect-to-oracle watchdog when oracle_verify proof is already attached', () => {
      jest.useFakeTimers();
      resolveRuntimeInt.mockImplementation((key, fallback) => (
        key === 'agentResponseWatchdogMs' ? 30 * 1000 : fallback
      ));
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-watchdog-work-item-proof-'));
      const workItemRoot = path.join(tempRoot, 'runtime', 'work-items');
      try {
        openWorkItem({
          id: 'wi-watchdog-acknowledged',
          session: 'app-session-389',
          profile: 'main',
          window: 'main',
          sourceMessageIds: ['m-architect-oracle-acknowledged'],
          objective: 'Oracle verify the acknowledged watchdog suppression patch',
          ownerRoles: ['builder', 'oracle'],
          requiredProof: ['oracle_verify'],
        }, {
          workItemRoot,
          now: '2026-05-30T10:02:00.000Z',
        });
        attachProof({
          id: 'wi-watchdog-acknowledged',
          role: 'oracle_verify',
          ref: 'oracle:watchdog-pass',
          hash: 'sha256:oracle-watchdog-pass',
          summary: 'Oracle verification already attached',
        }, {
          workItemRoot,
          now: '2026-05-30T10:03:00.000Z',
        });
        const app = new SquidRunApp(mockAppContext, mockManagers);
        app.commsSessionScopeId = 'app-session-389';
        app.agentResponseWatchdogWorkItemRoot = workItemRoot;

        app.scheduleAgentResponseWatchdog({
          senderRole: 'architect',
          targetRole: 'oracle',
          sourceMessageId: 'm-architect-oracle-acknowledged',
          content: '(ARCHITECT #201): Verify wi-watchdog-acknowledged and report.',
          sentAtMs: new Date('2026-05-30T10:03:30').getTime(),
        });

        jest.advanceTimersByTime(30 * 1000);
        expect(spawn).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
        jest.useRealTimers();
      }
    });

    it('suppresses architect-to-oracle watchdog when current-lane evidence is terminal', () => {
      jest.useFakeTimers();
      resolveRuntimeInt.mockImplementation((key, fallback) => (
        key === 'agentResponseWatchdogMs' ? 30 * 1000 : fallback
      ));
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-watchdog-current-lane-'));
      const currentLanePath = path.join(tempRoot, 'handoffs', 'current-lane.json');
      try {
        fs.mkdirSync(path.dirname(currentLanePath), { recursive: true });
        fs.writeFileSync(currentLanePath, JSON.stringify({
          version: 1,
          source: 'comms_journal',
          status: 'none',
          activeLane: {
            laneId: 'app-session-389:architect-202:m-architect-current-lane-terminal',
            sourceMessageId: 'm-architect-current-lane-terminal',
            sourceRef: 'architect#202',
            objective: 'Oracle verify current-lane terminal suppression',
            status: 'resolved_or_superseded',
          },
        }, null, 2));
        const app = new SquidRunApp(mockAppContext, mockManagers);
        app.commsSessionScopeId = 'app-session-389';
        app.agentResponseWatchdogCurrentLanePath = currentLanePath;

        app.scheduleAgentResponseWatchdog({
          senderRole: 'architect',
          targetRole: 'oracle',
          sourceMessageId: 'm-architect-current-lane-terminal',
          content: '(ARCHITECT #202): Verify current-lane terminal suppression.',
          sentAtMs: new Date('2026-05-30T10:04:30').getTime(),
        });

        jest.advanceTimersByTime(30 * 1000);
        expect(spawn).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
        jest.useRealTimers();
      }
    });

    it('reports exact correlation blockers before architect-to-oracle watchdog fires', () => {
      jest.useFakeTimers();
      resolveRuntimeInt.mockImplementation((key, fallback) => (
        key === 'agentResponseWatchdogMs' ? 30 * 1000 : fallback
      ));
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-watchdog-blocker-'));
      try {
        const app = new SquidRunApp(mockAppContext, mockManagers);
        app.commsSessionScopeId = 'app-session-389';
        app.agentResponseWatchdogWorkItemRoot = path.join(tempRoot, 'runtime', 'work-items');
        app.agentResponseWatchdogCurrentLanePath = path.join(tempRoot, 'handoffs', 'current-lane.json');

        app.scheduleAgentResponseWatchdog({
          senderRole: 'architect',
          targetRole: 'oracle',
          sourceMessageId: 'm-architect-oracle-blocked',
          content: '(ARCHITECT #203): Verify the watchdog blocker report and reply.',
          sentAtMs: new Date('2026-05-30T10:05:30').getTime(),
        });

        jest.advanceTimersByTime(30 * 1000);

        expect(spawn).toHaveBeenCalledWith(
          'node',
          expect.arrayContaining([
            expect.stringContaining(path.join('scripts', 'hm-send.js')),
            'architect',
            expect.stringContaining('Closure correlation blockers: comms_journal:no_later_resolution; work_items:no_correlating_work_item; current_lane:missing.'),
            '--role',
            'system',
          ]),
          expect.objectContaining({ windowsHide: true })
        );
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
        jest.useRealTimers();
      }
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

    it('writes Codex paste terminator before enter for Codex pane commands', () => {
      const app = new SquidRunApp(mockAppContext, mockManagers);
      app.ctx.currentSettings = {
        paneCommands: {
          1: 'codex',
        },
      };
      app.ctx.daemonClient = {
        connected: true,
        write: jest.fn(() => true),
      };

      const result = app.dispatchPaneHostEnter('1');

      expect(app.ctx.daemonClient.write.mock.calls).toEqual([
        ['1', '\u001b[201~'],
        ['1', '\r'],
      ]);
      expect(result).toEqual({ success: true, paneId: '1' });
    });

    it('falls back to persisted settings when current settings lack pane commands', () => {
      const app = new SquidRunApp(mockAppContext, mockManagers);
      app.ctx.currentSettings = {};
      mockManagers.settings.loadSettings.mockReturnValue({
        paneCommands: {
          1: 'codex',
        },
      });
      app.ctx.daemonClient = {
        connected: true,
        write: jest.fn(() => true),
      };

      const result = app.dispatchPaneHostEnter('1');

      expect(mockManagers.settings.loadSettings).toHaveBeenCalled();
      expect(app.ctx.daemonClient.write.mock.calls).toEqual([
        ['1', '\u001b[201~'],
        ['1', '\r'],
      ]);
      expect(result).toEqual({ success: true, paneId: '1' });
    });

    it('uses persisted settings when current pane command is stale non-Codex', () => {
      const app = new SquidRunApp(mockAppContext, mockManagers);
      app.ctx.currentSettings = {
        paneCommands: {
          1: 'claude',
        },
      };
      mockManagers.settings.loadSettings.mockReturnValue({
        paneCommands: {
          1: 'codex',
        },
      });
      app.ctx.daemonClient = {
        connected: true,
        write: jest.fn(() => true),
      };

      const result = app.dispatchPaneHostEnter('1');

      expect(mockManagers.settings.loadSettings).toHaveBeenCalled();
      expect(app.ctx.daemonClient.write.mock.calls).toEqual([
        ['1', '\u001b[201~'],
        ['1', '\r'],
      ]);
      expect(result).toEqual({ success: true, paneId: '1' });
    });

    it('fails closed when Codex paste terminator write is rejected', () => {
      const app = new SquidRunApp(mockAppContext, mockManagers);
      app.ctx.currentSettings = {
        paneCommands: {
          1: 'codex --yolo',
        },
      };
      app.ctx.daemonClient = {
        connected: true,
        write: jest.fn((_paneId, data) => data !== '\u001b[201~'),
      };

      const result = app.dispatchPaneHostEnter('1');

      expect(app.ctx.daemonClient.write).toHaveBeenCalledWith('1', '\u001b[201~');
      expect(app.ctx.daemonClient.write).not.toHaveBeenCalledWith('1', '\r');
      expect(result).toEqual({
        success: false,
        reason: 'daemon_paste_end_write_failed',
        paneId: '1',
      });
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

  describe('deliverPaneMessageViaDaemonPty', () => {
    it('writes Codex paste terminator before Enter on the direct daemon route', async () => {
      const app = new SquidRunApp(mockAppContext, mockManagers);
      app.ctx.currentSettings = {
        paneCommands: {
          1: 'codex',
        },
      };
      app.ctx.daemonClient = {
        connected: true,
        write: jest.fn(() => true),
      };

      const result = await app.deliverPaneMessageViaDaemonPty({
        paneId: '1',
        message: 'hello architect',
        messageId: 'direct-codex-1',
      });

      expect(app.ctx.daemonClient.write.mock.calls.map((call) => call.slice(0, 2))).toEqual([
        ['1', 'hello architect'],
        ['1', '\u001b[201~'],
        ['1', '\r'],
      ]);
      expect(result).toEqual(expect.objectContaining({
        accepted: true,
        verified: false,
        status: 'accepted.daemon_pty_unverified',
        mode: 'daemon-pty',
        paneId: '1',
      }));
    });

    it('does not duplicate accepted direct daemon delivery through the trigger path', async () => {
      const triggers = require('../modules/triggers');
      triggers.sendDirectMessage.mockClear();
      const app = new SquidRunApp(mockAppContext, mockManagers);
      app.ctx.currentSettings = {
        paneCommands: {
          2: 'claude',
        },
      };
      app.ctx.daemonClient = {
        connected: true,
        write: jest.fn(() => true),
      };

      const result = await app.deliverPaneMessageReliably({
        paneId: '2',
        message: 'short direct message',
        fromRole: 'architect',
        messageId: 'direct-no-duplicate-1',
      });

      expect(app.ctx.daemonClient.write.mock.calls.map((call) => call.slice(0, 2))).toEqual([
        ['2', 'short direct message'],
        ['2', '\r'],
      ]);
      expect(triggers.sendDirectMessage).not.toHaveBeenCalled();
      expect(result).toEqual(expect.objectContaining({
        accepted: true,
        verified: false,
        status: 'accepted.daemon_pty_unverified',
        mode: 'daemon-pty',
        paneId: '2',
      }));
    });

    it('passes delivery metadata through the direct daemon PTY route', async () => {
      const app = new SquidRunApp(mockAppContext, mockManagers);
      app.ctx.currentSettings = {
        paneCommands: {
          1: 'codex',
        },
      };
      app.ctx.daemonClient = {
        connected: true,
        write: jest.fn(() => true),
      };

      await app.deliverPaneMessageViaDaemonPty({
        paneId: '1',
        message: 'telegram inbound',
        messageId: 'direct-meta-1',
        meta: {
          channel: 'telegram',
          replyTarget: 'telegram',
          replyTargetRequired: true,
        },
      });

      expect(app.ctx.daemonClient.write.mock.calls[0][2]).toEqual(expect.objectContaining({
        source: 'squidrun-app.direct-pane-delivery',
        meta: expect.objectContaining({
          channel: 'telegram',
          replyTarget: 'telegram',
          replyTargetRequired: true,
        }),
      }));
    });

    it('does not write Codex paste terminator for non-Codex direct daemon route', async () => {
      const app = new SquidRunApp(mockAppContext, mockManagers);
      app.ctx.currentSettings = {
        paneCommands: {
          2: 'claude',
        },
      };
      app.ctx.daemonClient = {
        connected: true,
        write: jest.fn(() => true),
      };

      await app.deliverPaneMessageViaDaemonPty({
        paneId: '2',
        message: 'hello builder',
        messageId: 'direct-claude-1',
      });

      expect(app.ctx.daemonClient.write.mock.calls.map((call) => call.slice(0, 2))).toEqual([
        ['2', 'hello builder'],
        ['2', '\r'],
      ]);
    });

    it('skips direct PTY writes for payloads that require chunked verified injection', async () => {
      const app = new SquidRunApp(mockAppContext, mockManagers);
      app.ctx.currentSettings = {
        paneCommands: {
          1: 'codex --yolo',
        },
      };
      app.ctx.daemonClient = {
        connected: true,
        write: jest.fn(() => true),
      };

      const result = await app.deliverPaneMessageViaDaemonPty({
        paneId: '1',
        message: 'x'.repeat(256),
        messageId: 'direct-codex-long-1',
      });

      expect(app.ctx.daemonClient.write).not.toHaveBeenCalled();
      expect(result).toEqual(expect.objectContaining({
        accepted: false,
        verified: false,
        status: 'skipped.chunked_payload',
        mode: 'daemon-pty',
        paneId: '1',
        paneRuntime: 'codex',
      }));
    });

    it('skips direct PTY writes for long Claude payloads instead of one-shotting the pane', async () => {
      const app = new SquidRunApp(mockAppContext, mockManagers);
      app.ctx.currentSettings = {
        paneCommands: {
          1: 'claude',
        },
      };
      app.ctx.daemonClient = {
        connected: true,
        write: jest.fn(() => true),
      };

      const result = await app.deliverPaneMessageViaDaemonPty({
        paneId: '1',
        message: 'x'.repeat(256),
        messageId: 'direct-claude-long-1',
      });

      expect(app.ctx.daemonClient.write).not.toHaveBeenCalled();
      expect(result).toEqual(expect.objectContaining({
        accepted: false,
        verified: false,
        status: 'skipped.chunked_payload',
        mode: 'daemon-pty',
        paneId: '1',
        paneRuntime: 'non-codex',
      }));
    });

    it('routes long Claude pane messages through the verified trigger path instead of direct PTY', async () => {
      const triggers = require('../modules/triggers');
      triggers.sendDirectMessage.mockClear();
      triggers.sendDirectMessage.mockResolvedValueOnce({
        accepted: true,
        queued: true,
        verified: true,
        status: 'delivered.verified',
      });
      const app = new SquidRunApp(mockAppContext, mockManagers);
      app.ctx.currentSettings = {
        paneCommands: {
          1: 'claude',
        },
      };
      app.ctx.daemonClient = {
        connected: true,
        write: jest.fn(() => true),
      };
      const message = 'x'.repeat(256);

      const result = await app.deliverPaneMessageReliably({
        paneId: '1',
        message,
        fromRole: 'oracle',
        messageId: 'claude-long-fallback-1',
      });

      expect(app.ctx.daemonClient.write).not.toHaveBeenCalled();
      expect(triggers.sendDirectMessage).toHaveBeenCalledWith(
        ['1'],
        message,
        'oracle',
        expect.objectContaining({ awaitDelivery: true })
      );
      expect(result).toEqual(expect.objectContaining({
        accepted: true,
        verified: true,
        status: 'delivered.verified',
      }));
    });

    it('fails closed when direct Codex paste terminator write is rejected', async () => {
      const app = new SquidRunApp(mockAppContext, mockManagers);
      app.ctx.currentSettings = {
        paneCommands: {
          1: 'codex --yolo',
        },
      };
      app.ctx.daemonClient = {
        connected: true,
        write: jest.fn((_paneId, data) => data !== '\u001b[201~'),
      };

      const result = await app.deliverPaneMessageViaDaemonPty({
        paneId: '1',
        message: 'hello architect',
        messageId: 'direct-codex-reject-1',
      });

      expect(app.ctx.daemonClient.write.mock.calls.map((call) => call.slice(0, 2))).toEqual([
        ['1', 'hello architect'],
        ['1', '\u001b[201~'],
      ]);
      expect(result).toEqual(expect.objectContaining({
        accepted: true,
        verified: false,
        status: 'daemon_paste_end_failed',
        mode: 'daemon-pty',
        paneId: '1',
      }));
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

    it('keeps TrustQuote work-room owner terminals out of visible pane recovery', async () => {
      const { getDaemonClient } = require('../daemon-client');
      const routeOwnerTerminal = {
        paneId: 'trustquote-oracle',
        pid: 44123,
        alive: true,
        workRoomRouteOwner: true,
        routeOwner: 'trustquote-work-room-route-owner',
        roomId: 'trustquote',
      };
      const sharedDaemonClient = {
        on: jest.fn(),
        off: jest.fn(),
        connect: jest.fn().mockResolvedValue(),
        disconnect: jest.fn(),
        getTerminal: jest.fn((paneId) => (paneId === 'trustquote-oracle' ? routeOwnerTerminal : null)),
      };
      getDaemonClient.mockReturnValue(sharedDaemonClient);

      const mainWindow = {
        isDestroyed: jest.fn().mockReturnValue(false),
        webContents: {
          send: jest.fn(),
          isDestroyed: jest.fn().mockReturnValue(false),
        },
      };
      const recoveryManager = {
        handleExit: jest.fn(),
        recordActivity: jest.fn(),
        recordPtyOutput: jest.fn(),
      };
      const ctx = {
        ...mockAppContext,
        mainWindow,
        daemonClient: sharedDaemonClient,
        agentRunning: new Map(),
        recoveryManager,
        pluginManager: {
          hasHook: jest.fn().mockReturnValue(false),
          dispatch: jest.fn().mockResolvedValue(),
        },
        getWindow: jest.fn((key = 'main') => (key === 'main' ? mainWindow : null)),
        getWindows: jest.fn(() => new Map([['main', mainWindow]])),
      };
      const app = new SquidRunApp(ctx, mockManagers);

      await app.initDaemonClient();

      const dataListener = sharedDaemonClient.on.mock.calls.find(([eventName]) => eventName === 'data')?.[1];
      const exitListener = sharedDaemonClient.on.mock.calls.find(([eventName]) => eventName === 'exit')?.[1];
      const spawnedListener = sharedDaemonClient.on.mock.calls.find(([eventName]) => eventName === 'spawned')?.[1];
      const connectedListener = sharedDaemonClient.on.mock.calls.find(([eventName]) => eventName === 'connected')?.[1];

      dataListener('trustquote-oracle', 'oracle output');
      exitListener('trustquote-oracle', -1073741510, routeOwnerTerminal);
      spawnedListener('trustquote-oracle', 44123, false, routeOwnerTerminal);
      connectedListener([{ ...routeOwnerTerminal, alive: false }]);

      expect(recoveryManager.handleExit).not.toHaveBeenCalled();
      expect(recoveryManager.recordActivity).not.toHaveBeenCalledWith('trustquote-oracle');
      expect(recoveryManager.recordPtyOutput).not.toHaveBeenCalledWith('trustquote-oracle', 'oracle output');
      expect(ctx.agentRunning.has('trustquote-oracle')).toBe(false);
      expect(mainWindow.webContents.send).not.toHaveBeenCalledWith('pty-data-trustquote-oracle', expect.anything());
      expect(mainWindow.webContents.send).not.toHaveBeenCalledWith('pty-exit-trustquote-oracle', expect.anything());
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('daemon-connected', { terminals: [], windowKey: 'main' });
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

    it('wires inbound SMS callback to reliable pane delivery', async () => {
      const smsPoller = require('../modules/sms-poller');
      smsPoller.start.mockReturnValue(true);
      const deliverySpy = jest.spyOn(app, 'deliverHumanMessageWithRecall').mockResolvedValue({
        accepted: true,
        queued: true,
        verified: true,
      });

      app.startSmsPoller();

      expect(smsPoller.start).toHaveBeenCalledTimes(1);
      const options = smsPoller.start.mock.calls[0][0];
      expect(typeof options.onMessage).toBe('function');

      options.onMessage('build passed', '+15557654321');
      await new Promise((resolve) => setImmediate(resolve));
      expect(deliverySpy).toHaveBeenCalledWith(
        '[SMS from +15557654321]: build passed',
        expect.objectContaining({
          paneId: '1',
          role: 'architect',
          channel: 'sms',
          sender: '+15557654321',
        }),
        'SMS'
      );
    });
  });

  describe('Telegram poller wiring', () => {
    let app;

    beforeEach(() => {
      app = new SquidRunApp(mockAppContext, mockManagers);
    });

    it('wires Telegram command callbacks to pane 1 trigger injection', async () => {
      const telegramPoller = require('../modules/telegram-poller');
      const { sendMiraLivePrompt } = require('../modules/mira-live-entrypoint');
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

      options.onMessage('/task build passed', 'james', {
        chatId: 5613428850,
        updateId: 808498637,
        messageId: 20580,
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(sendMiraLivePrompt).not.toHaveBeenCalled();
      expect(deliverySpy).toHaveBeenCalledWith(
        '[Telegram from james]: /task build passed',
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
          messageId: 'telegram-in-808498637',
          inboundMessageId: 'telegram-in-808498637',
          updateId: 808498637,
          telegramMessageId: 20580,
          chatId: '5613428850',
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

    it('does not capture scoped inbound Telegram chatId for main reply routing', () => {
      const telegramPoller = require('../modules/telegram-poller');
      telegramPoller.start.mockReturnValue(true);
      jest.spyOn(app, 'deliverScopedTelegramInboundToProfileWindow').mockResolvedValue({
        ok: true,
        accepted: true,
        queued: true,
        verified: true,
        userVisible: true,
        status: 'delivered.verified',
      });
      const previousContext = { ...app.telegramInboundContext };

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

      expect(app.telegramInboundContext).toEqual(previousContext);
    });

    it('routes main Telegram chat inbound to the active Architect lane by default, not Mira live', async () => {
      const telegramPoller = require('../modules/telegram-poller');
      const { sendRoutedTelegramMessage } = require('../scripts/hm-telegram-routing');
      const { sendMiraLivePrompt } = require('../modules/mira-live-entrypoint');
      telegramPoller.start.mockReturnValue(true);
      const deliverySpy = jest.spyOn(app, 'deliverHumanMessageWithRecall').mockResolvedValue({
        accepted: true,
        queued: true,
        verified: true,
      });
      const previousFlag = process.env.SQUIDRUN_TELEGRAM_MAIN_MIRA_LIVE_ENABLED;
      delete process.env.SQUIDRUN_TELEGRAM_MAIN_MIRA_LIVE_ENABLED;

      try {
        app.startTelegramPoller();

        const options = telegramPoller.start.mock.calls[0][0];
        options.onMessage('main hello', 'james', { chatId: 5613428850, updateId: 101 });

        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        expect(sendMiraLivePrompt).not.toHaveBeenCalled();
        expect(sendRoutedTelegramMessage).not.toHaveBeenCalled();
        expect(deliverySpy).toHaveBeenCalledWith(
          '[Telegram from james]: main hello',
          expect.objectContaining({
            paneId: '1',
            role: 'architect',
            windowKey: 'main',
            channel: 'telegram',
            sender: 'james',
            messageId: 'telegram-in-101',
            chatId: 5613428850,
            telegramChatId: 5613428850,
          }),
          'Telegram'
        );
        expect(app.telegramInboundContext).toEqual(expect.objectContaining({
          sender: 'james',
          chatId: '5613428850',
          windowKey: 'main',
          profile: 'main',
          lastInboundBody: 'main hello',
        }));
      } finally {
        if (previousFlag === undefined) {
          delete process.env.SQUIDRUN_TELEGRAM_MAIN_MIRA_LIVE_ENABLED;
        } else {
          process.env.SQUIDRUN_TELEGRAM_MAIN_MIRA_LIVE_ENABLED = previousFlag;
        }
      }
    });

    it('compares current Mira Live and New Mira dry-run candidates for allowed owner Telegram text without sending', async () => {
      const { sendRoutedTelegramMessage } = require('../scripts/hm-telegram-routing');
      const { sendMiraLivePrompt } = require('../modules/mira-live-entrypoint');
      const previousFlag = process.env.SQUIDRUN_TELEGRAM_MAIN_MIRA_LIVE_ENABLED;
      process.env.SQUIDRUN_TELEGRAM_MAIN_MIRA_LIVE_ENABLED = '1';
      const body = 'what are we doing next?';
      const metadata = { chatId: '5613428850', updateId: 167, messageId: 7001 };
      const sessionId = 'app-session-377:main';

      try {
        const inboundRoute = app.resolveTelegramInboundRoute(metadata.chatId);
        expect(inboundRoute).toEqual(expect.objectContaining({
          ok: true,
          chatId: '5613428850',
          windowKey: 'main',
          profile: 'main',
          reason: 'owner_chat',
        }));
        expect(app.shouldRouteMainTelegramInboundToMira({
          body,
          inboundWindowKey: 'main',
        })).toBe(true);

        const currentMiraLiveReply = await app.buildTelegramMiraLiveReply(body, {
          sessionId,
          sender: 'james',
          metadata,
          inboundMessageId: 'telegram-in-167',
        });
        const newMiraCandidate = buildNewMiraTelegramTurnCandidate({
          body,
          sender: 'james',
          metadata,
          inboundRoute,
          inboundSessionScopeId: sessionId,
        });

        expect(currentMiraLiveReply).toEqual(expect.objectContaining({
          ok: true,
          state: 'ready',
          message: 'Mira visible reply from Telegram.',
        }));
        expect(sendMiraLivePrompt).toHaveBeenCalledTimes(1);
        expect(sendMiraLivePrompt).toHaveBeenCalledWith(
          {
            prompt: body,
            sessionId,
            source: 'telegram-mira-live',
          },
          expect.objectContaining({
            invoke: expect.any(Function),
          })
        );

        expect(newMiraCandidate).toEqual(expect.objectContaining({
          ok: true,
          status: 'new_mira_telegram_turn_candidate_ready',
          dryRun: true,
        }));
        expect(newMiraCandidate.route).toEqual(expect.objectContaining({
          currentOwner: 'squidrun-telegram-guard-stack',
          routeOwnerChange: false,
          liveRouteChanged: false,
        }));
        expect(newMiraCandidate.candidate).toEqual({
          endpoint: '/turn',
          method: 'POST',
          body: {
            text: body,
            sessionId,
            messageId: 'telegram-in-167',
            requestId: 'telegram-in-167-new-mira-dry-run',
            useModel: false,
          },
        });
        expect(newMiraCandidate.sideEffects).toEqual(expect.objectContaining({
          telegramSendFunctionCall: false,
          liveTelegramSend: false,
          routeOwnerChange: false,
          runtimeExecutes: false,
          runtimeActions: false,
          toolsEnabled: false,
          sendsEnabled: false,
          store: false,
          modelInvoked: false,
          modelProviderCall: false,
          telegramRouteControl: false,
          uiSurfaceControl: false,
        }));
        expect(sendRoutedTelegramMessage).not.toHaveBeenCalled();
      } finally {
        if (previousFlag === undefined) {
          delete process.env.SQUIDRUN_TELEGRAM_MAIN_MIRA_LIVE_ENABLED;
        } else {
          process.env.SQUIDRUN_TELEGRAM_MAIN_MIRA_LIVE_ENABLED = previousFlag;
        }
      }
    });

    it('answers Telegram status prompts from direct-channel evidence without model or pane confusion', async () => {
      const { sendRoutedTelegramMessage } = require('../scripts/hm-telegram-routing');
      const { sendMiraLivePrompt } = require('../modules/mira-live-entrypoint');
      const triggers = require('../modules/triggers');
      const deliverySpy = jest.spyOn(app, 'deliverHumanMessageWithRecall').mockResolvedValue({
        accepted: true,
        queued: true,
        verified: true,
      });
      jest.spyOn(app, 'shouldOrientMiraTelegramChannel').mockReturnValue(false);
      queryCommsJournalEntries.mockReturnValue([
        {
          messageId: 'architect-160',
          sessionId: 'app-session-382',
          senderRole: 'architect',
          targetRole: 'builder',
          direction: 'outbound',
          status: 'routed',
          brokeredAtMs: Date.parse('2026-05-27T09:09:00.000Z'),
          rawBody: '(ARCHITECT #160): ACK Builder #38. No Builder action pending unless Oracle objects.',
          metadata: { windowKey: 'main' },
        },
        {
          messageId: 'architect-161',
          sessionId: 'app-session-382',
          senderRole: 'architect',
          targetRole: 'builder',
          direction: 'outbound',
          status: 'routed',
          brokeredAtMs: Date.parse('2026-05-27T09:10:00.000Z'),
          rawBody: '(ARCHITECT #161): New current-session task: Direct Channel Reachability checkpoint. Objective: make the current James-facing channel path evidence-bound and understandable. Return a small patch/proof packet or blocker.',
          metadata: { windowKey: 'main' },
        },
      ]);

      const result = await app.routeMainTelegramInboundToMira({
        body: 'status',
        sender: 'james',
        metadata: { chatId: '5613428850', updateId: 201, messageId: 9001 },
        inboundMessageId: 'telegram-in-201',
        inboundSessionScopeId: 'app-session-382',
        nowMs: Date.parse('2026-05-27T09:12:00.000Z'),
        progressReport: {
          computed_total_percent: 73,
          status: 'BLOCKED',
          warnings: [],
          source_refs: {
            head: { short_sha: '84d70b21' },
            progress_proof_inputs: {
              source_ref: '.squidrun/runtime/mira-progress-proof-inputs-v0.json',
              status: 'loaded',
            },
          },
        },
      });

      expect(result).toEqual(expect.objectContaining({
        ok: true,
        handled: true,
        status: 'telegram_delivered',
      }));
      expect(result.reply).toEqual(expect.objectContaining({
        source: 'mira_direct_channel_status_v0',
      }));
      expect(result.directChannelStatusAnswer).toEqual(expect.objectContaining({
        ok: true,
        james_action_line_count: 1,
        route: expect.objectContaining({
          currentOwner: 'squidrun-telegram-guard-stack',
          miraOwnsTelegram: false,
          routeOwnerChange: false,
          liveRouteChanged: false,
        }),
      }));
      expect(sendMiraLivePrompt).not.toHaveBeenCalled();
      expect(deliverySpy).not.toHaveBeenCalled();
      expect(triggers.sendDirectMessage).not.toHaveBeenCalled();
      expect(sendRoutedTelegramMessage).toHaveBeenCalledTimes(1);
      const sentText = sendRoutedTelegramMessage.mock.calls[0][0];
      expect(sentText).toContain('Direct channel: Telegram is reachable through squidrun-telegram-guard-stack');
      expect(sentText).toContain('official progress 73% BLOCKED at HEAD 84d70b21');
      expect(sentText).toContain('Current lane: Direct Channel Reachability checkpoint');
      expect(sentText).toContain('source architect#161');
      expect(sentText).toContain('JAMES ACTION: NONE');
      expect(sentText).not.toMatch(/\[(?:AGENT MSG|CURRENT PROJECT)\]|\((?:ARCHITECT|BUILDER|ORACLE)\s+#\d+\):|\[Telegram from/i);
      expect(sendRoutedTelegramMessage.mock.calls[0][2]).toEqual(expect.objectContaining({
        messageId: 'telegram-in-201-mira-direct-status-reply',
        senderRole: 'mira',
        chatId: '5613428850',
        metadata: expect.objectContaining({
          routeKind: 'telegram',
          windowKey: 'main',
          profile: 'main',
        }),
      }));
    });

    it('suppresses duplicate direct-channel status replies and keeps scoped status off the main Mira route', async () => {
      const telegramPoller = require('../modules/telegram-poller');
      const { sendRoutedTelegramMessage } = require('../scripts/hm-telegram-routing');
      const { sendMiraLivePrompt } = require('../modules/mira-live-entrypoint');
      jest.spyOn(app, 'shouldOrientMiraTelegramChannel').mockReturnValue(false);
      queryCommsJournalEntries.mockReturnValue([]);

      const first = await app.routeMainTelegramInboundToMira({
        body: 'continue',
        sender: 'james',
        metadata: { chatId: '5613428850' },
        inboundMessageId: 'telegram-in-continue-1',
        inboundSessionScopeId: 'app-session-382',
        nowMs: Date.parse('2026-05-27T09:12:00.000Z'),
        progressReport: {
          computed_total_percent: 73,
          status: 'BLOCKED',
          warnings: [],
          source_refs: {
            head: { short_sha: '84d70b21' },
            progress_proof_inputs: { source_ref: '.squidrun/runtime/mira-progress-proof-inputs-v0.json', status: 'loaded' },
          },
        },
      });
      const duplicate = await app.routeMainTelegramInboundToMira({
        body: 'continue',
        sender: 'james',
        metadata: { chatId: '5613428850' },
        inboundMessageId: 'telegram-in-continue-2',
        inboundSessionScopeId: 'app-session-382',
        nowMs: Date.parse('2026-05-27T09:12:00.000Z'),
        progressReport: {
          computed_total_percent: 73,
          status: 'BLOCKED',
          warnings: [],
          source_refs: {
            head: { short_sha: '84d70b21' },
            progress_proof_inputs: { source_ref: '.squidrun/runtime/mira-progress-proof-inputs-v0.json', status: 'loaded' },
          },
        },
      });

      expect(first.status).toBe('telegram_delivered');
      expect(duplicate.status).toBe('telegram_duplicate_suppressed');
      expect(sendRoutedTelegramMessage).toHaveBeenCalledTimes(1);
      expect(sendMiraLivePrompt).not.toHaveBeenCalled();

      const previousFlag = process.env.SQUIDRUN_TELEGRAM_MAIN_MIRA_LIVE_ENABLED;
      process.env.SQUIDRUN_TELEGRAM_MAIN_MIRA_LIVE_ENABLED = '1';
      telegramPoller.start.mockReturnValue(true);
      sendRoutedTelegramMessage.mockClear();
      const scopedDelivery = jest.spyOn(app, 'deliverScopedTelegramInboundToProfileWindow').mockResolvedValue({
        ok: true,
        accepted: true,
        queued: true,
        verified: true,
        userVisible: true,
        status: 'delivered.verified',
      });

      try {
        app.startTelegramPoller();
        const options = telegramPoller.start.mock.calls[0][0];
        options.onMessage('status', 'scoped', { chatId: 2222222222, updateId: 202 });
        await new Promise((resolve) => setImmediate(resolve));

        expect(scopedDelivery).toHaveBeenCalled();
        expect(sendRoutedTelegramMessage).not.toHaveBeenCalled();
        expect(sendMiraLivePrompt).not.toHaveBeenCalled();
      } finally {
        if (previousFlag === undefined) {
          delete process.env.SQUIDRUN_TELEGRAM_MAIN_MIRA_LIVE_ENABLED;
        } else {
          process.env.SQUIDRUN_TELEGRAM_MAIN_MIRA_LIVE_ENABLED = previousFlag;
        }
      }
    });

    it('contains angry Telegram meta-repair replies before egress', async () => {
      const { sendRoutedTelegramMessage } = require('../scripts/hm-telegram-routing');
      const { sendMiraLivePrompt } = require('../modules/mira-live-entrypoint');
      jest.spyOn(app, 'shouldOrientMiraTelegramChannel').mockReturnValue(false);
      sendMiraLivePrompt.mockResolvedValueOnce({
        ok: true,
        state: 'ready',
        message: 'Yeah. Fair. I just said "no machinery" and then pointed at the machinery in nicer clothes. Bad turn. I should have said it sooner instead of wasting your time.',
      });

      await app.routeMainTelegramInboundToMira({
        body: 'wtf worthless chat gpt output again',
        sender: 'james',
        metadata: { chatId: '5613428850' },
        inboundMessageId: 'telegram-in-meta-loop',
      });

      const sentText = sendRoutedTelegramMessage.mock.calls[0][0];
      expect(sentText).toBe("No. I'm stopping here.");
      expect(sentText).not.toMatch(/yeah|fair|model|persona|output|voice|machinery|assistant|chat\s*gpt|team|routing|rules|because|failed|should have/i);
    });

    it('does not repeat Mira Telegram first-contact orientation after channel state is marked', async () => {
      const { sendRoutedTelegramMessage } = require('../scripts/hm-telegram-routing');
      jest.spyOn(app, 'shouldOrientMiraTelegramChannel').mockReturnValue(false);

      await app.routeMainTelegramInboundToMira({
        body: 'second hello',
        sender: 'james',
        metadata: { chatId: '5613428850' },
        inboundMessageId: 'telegram-in-102',
      });

      expect(sendRoutedTelegramMessage).toHaveBeenCalledWith(
        'Mira visible reply from Telegram.',
        process.env,
        expect.objectContaining({
          messageId: 'telegram-in-102-mira-reply',
          senderRole: 'mira',
          chatId: '5613428850',
        })
      );
    });

    it('suppresses duplicate successful Telegram replies without suppressing failed retries', async () => {
      const { sendRoutedTelegramMessage } = require('../scripts/hm-telegram-routing');
      jest.spyOn(app, 'shouldOrientMiraTelegramChannel').mockReturnValue(false);

      await expect(app.routeTelegramReply({
        target: 'telegram',
        content: 'Same reply.',
        fromRole: 'mira',
        messageId: 'telegram-dedupe-1',
        chatId: '5613428850',
      })).resolves.toEqual(expect.objectContaining({
        ok: true,
        status: 'telegram_delivered',
      }));

      await expect(app.routeTelegramReply({
        target: 'telegram',
        content: 'Same reply.',
        fromRole: 'mira',
        messageId: 'telegram-dedupe-2',
        chatId: '5613428850',
      })).resolves.toEqual(expect.objectContaining({
        ok: true,
        status: 'telegram_duplicate_suppressed',
        queued: false,
      }));

      expect(sendRoutedTelegramMessage).toHaveBeenCalledTimes(1);

      sendRoutedTelegramMessage.mockClear();
      app.telegramReplyDedupe.clear();
      sendRoutedTelegramMessage
        .mockResolvedValueOnce({ ok: false, error: 'read ECONNRESET' })
        .mockResolvedValueOnce({
          ok: true,
          chatId: 5613428850,
          messageId: 42,
          method: 'hm-send-telegram',
        });

      await expect(app.routeTelegramReply({
        target: 'telegram',
        content: 'Retryable reply.',
        fromRole: 'mira',
        messageId: 'telegram-retry-1',
        chatId: '5613428850',
      })).resolves.toEqual(expect.objectContaining({
        ok: false,
        status: 'telegram_send_failed',
      }));

      await expect(app.routeTelegramReply({
        target: 'telegram',
        content: 'Retryable reply.',
        fromRole: 'mira',
        messageId: 'telegram-retry-2',
        chatId: '5613428850',
      })).resolves.toEqual(expect.objectContaining({
        ok: true,
        status: 'telegram_delivered',
      }));

      expect(sendRoutedTelegramMessage).toHaveBeenCalledTimes(2);
    });

    it('coalesces stale clarify and verdict replies after a short stray Telegram negation', async () => {
      const { sendRoutedTelegramMessage } = require('../scripts/hm-telegram-routing');
      const nowMs = Date.now();
      app.telegramInboundContext = {
        sender: 'james',
        lastInboundAtMs: nowMs,
        chatId: '5613428850',
        windowKey: 'main',
        profile: 'main',
        sessionScopeId: 'app-test:main',
        lastInboundBody: 'wtf idk why it said Blake Keller',
        previousInboundBody: 'Blake Keller',
        previousInboundAtMs: nowMs - 10000,
      };

      await expect(app.routeTelegramReply({
        target: 'telegram',
        content: 'I got "Blake Keller." Send me the action or context for that name.',
        fromRole: 'architect',
        messageId: 'telegram-stray-clarify',
        chatId: '5613428850',
      })).resolves.toEqual(expect.objectContaining({
        ok: true,
        status: 'telegram_stray_clarification_suppressed',
        queued: false,
      }));
      expect(sendRoutedTelegramMessage).not.toHaveBeenCalled();

      await expect(app.routeTelegramReply({
        target: 'telegram',
        content: 'Got it. I am treating "Blake Keller" as stray text, not an instruction. I will check the inbound route so it does not become a ghost action.',
        fromRole: 'architect',
        messageId: 'telegram-stray-contain',
        chatId: '5613428850',
      })).resolves.toEqual(expect.objectContaining({
        ok: true,
        status: 'telegram_delivered',
      }));

      await expect(app.routeTelegramReply({
        target: 'telegram',
        content: 'I checked it. SquidRun received "Blake Keller" as a fresh real Telegram text, not a stale replay or wrong-window route. Looks upstream of SquidRun, so I am treating it as stray and taking no action on the name.',
        fromRole: 'architect',
        messageId: 'telegram-stray-verdict',
        chatId: '5613428850',
      })).resolves.toEqual(expect.objectContaining({
        ok: true,
        status: 'telegram_stray_correction_coalesced',
        queued: false,
      }));

      expect(sendRoutedTelegramMessage).toHaveBeenCalledTimes(1);
      expect(sendRoutedTelegramMessage.mock.calls[0][0]).toContain('Got it.');
    });

    it('does not coalesce urgent Telegram replies after a short stray negation', async () => {
      const { sendRoutedTelegramMessage } = require('../scripts/hm-telegram-routing');
      const nowMs = Date.now();
      app.telegramInboundContext = {
        sender: 'james',
        lastInboundAtMs: nowMs,
        chatId: '5613428850',
        windowKey: 'main',
        profile: 'main',
        sessionScopeId: 'app-test:main',
        lastInboundBody: 'wtf idk why it said Blake Keller',
        previousInboundBody: 'Blake Keller',
        previousInboundAtMs: nowMs - 10000,
      };

      await expect(app.routeTelegramReply({
        target: 'telegram',
        content: 'I got "Blake Keller." Send me the action or context for that name.',
        fromRole: 'architect',
        messageId: 'telegram-stray-request-clarify',
        chatId: '5613428850',
      })).resolves.toEqual(expect.objectContaining({
        ok: true,
        status: 'telegram_stray_clarification_suppressed',
        queued: false,
      }));

      await expect(app.routeTelegramReply({
        target: 'telegram',
        content: 'Got it. I am treating "Blake Keller" as stray text, not an instruction.',
        fromRole: 'architect',
        messageId: 'telegram-stray-urgent-state',
        chatId: '5613428850',
      })).resolves.toEqual(expect.objectContaining({
        ok: true,
        status: 'telegram_delivered',
      }));

      await expect(app.routeTelegramReply({
        target: 'telegram',
        content: 'Urgent: the Telegram route shows a security issue and you need to act now.',
        fromRole: 'architect',
        messageId: 'telegram-stray-urgent',
        chatId: '5613428850',
      })).resolves.toEqual(expect.objectContaining({
        ok: true,
        status: 'telegram_delivered',
      }));

      expect(sendRoutedTelegramMessage).toHaveBeenCalledTimes(2);
    });

    it('does not coalesce replies when James explicitly asks for the stray-route result', async () => {
      const { sendRoutedTelegramMessage } = require('../scripts/hm-telegram-routing');
      const nowMs = Date.now();
      app.telegramInboundContext = {
        sender: 'james',
        lastInboundAtMs: nowMs,
        chatId: '5613428850',
        windowKey: 'main',
        profile: 'main',
        sessionScopeId: 'app-test:main',
        lastInboundBody: 'wtf idk why it said Blake Keller, can you check and tell me?',
        previousInboundBody: 'Blake Keller',
        previousInboundAtMs: nowMs - 10000,
      };

      await expect(app.routeTelegramReply({
        target: 'telegram',
        content: 'Got it. I am treating "Blake Keller" as stray text, not an instruction.',
        fromRole: 'architect',
        messageId: 'telegram-stray-request-state',
        chatId: '5613428850',
      })).resolves.toEqual(expect.objectContaining({
        ok: true,
        status: 'telegram_delivered',
      }));

      await expect(app.routeTelegramReply({
        target: 'telegram',
        content: 'I checked it. SquidRun received "Blake Keller" as a fresh real Telegram text.',
        fromRole: 'architect',
        messageId: 'telegram-stray-request-result',
        chatId: '5613428850',
      })).resolves.toEqual(expect.objectContaining({
        ok: true,
        status: 'telegram_delivered',
      }));

      expect(sendRoutedTelegramMessage).toHaveBeenCalledTimes(2);
    });

    it('does not coalesce when James asks what happened without can-you-check phrasing', async () => {
      const { sendRoutedTelegramMessage } = require('../scripts/hm-telegram-routing');
      const nowMs = Date.now();
      app.telegramInboundContext = {
        sender: 'james',
        lastInboundAtMs: nowMs,
        chatId: '5613428850',
        windowKey: 'main',
        profile: 'main',
        sessionScopeId: 'app-test:main',
        lastInboundBody: 'I need you to check what happened.',
        previousInboundBody: 'Blake Keller',
        previousInboundAtMs: nowMs - 10000,
      };

      await expect(app.routeTelegramReply({
        target: 'telegram',
        content: 'I got "Blake Keller." Send me the action or context for that name.',
        fromRole: 'architect',
        messageId: 'telegram-stray-what-happened-clarify',
        chatId: '5613428850',
      })).resolves.toEqual(expect.objectContaining({
        ok: true,
        status: 'telegram_stray_clarification_suppressed',
        queued: false,
      }));

      await expect(app.routeTelegramReply({
        target: 'telegram',
        content: 'Got it. I am treating "Blake Keller" as stray text, not an instruction.',
        fromRole: 'architect',
        messageId: 'telegram-stray-what-happened-state',
        chatId: '5613428850',
      })).resolves.toEqual(expect.objectContaining({
        ok: true,
        status: 'telegram_delivered',
      }));

      await expect(app.routeTelegramReply({
        target: 'telegram',
        content: 'I checked it. SquidRun received "Blake Keller" as a fresh real Telegram text.',
        fromRole: 'architect',
        messageId: 'telegram-stray-what-happened-result',
        chatId: '5613428850',
      })).resolves.toEqual(expect.objectContaining({
        ok: true,
        status: 'telegram_delivered',
      }));

      expect(sendRoutedTelegramMessage).toHaveBeenCalledTimes(2);
    });

    it('does not coalesce a neutral result when the latest stray correction flags risk', async () => {
      const { sendRoutedTelegramMessage } = require('../scripts/hm-telegram-routing');
      const nowMs = Date.now();
      app.telegramInboundContext = {
        sender: 'james',
        lastInboundAtMs: nowMs,
        chatId: '5613428850',
        windowKey: 'main',
        profile: 'main',
        sessionScopeId: 'app-test:main',
        lastInboundBody: 'Is this a security issue?',
        previousInboundBody: 'Blake Keller',
        previousInboundAtMs: nowMs - 10000,
      };

      await expect(app.routeTelegramReply({
        target: 'telegram',
        content: 'Got it. I am treating "Blake Keller" as stray text, not an instruction.',
        fromRole: 'architect',
        messageId: 'telegram-stray-risk-state',
        chatId: '5613428850',
      })).resolves.toEqual(expect.objectContaining({
        ok: true,
        status: 'telegram_delivered',
      }));

      await expect(app.routeTelegramReply({
        target: 'telegram',
        content: 'I checked it. SquidRun received "Blake Keller" as a fresh real Telegram text.',
        fromRole: 'architect',
        messageId: 'telegram-stray-risk-result',
        chatId: '5613428850',
      })).resolves.toEqual(expect.objectContaining({
        ok: true,
        status: 'telegram_delivered',
      }));

      expect(sendRoutedTelegramMessage).toHaveBeenCalledTimes(2);
    });

    it('keeps Telegram commands on the existing Architect pane route', async () => {
      const telegramPoller = require('../modules/telegram-poller');
      const { sendRoutedTelegramMessage } = require('../scripts/hm-telegram-routing');
      const { sendMiraLivePrompt } = require('../modules/mira-live-entrypoint');
      telegramPoller.start.mockReturnValue(true);
      const deliverySpy = jest.spyOn(app, 'deliverHumanMessageWithRecall').mockResolvedValue({
        accepted: true,
        queued: true,
        verified: true,
      });

      app.startTelegramPoller();

      const options = telegramPoller.start.mock.calls[0][0];
      options.onMessage('/task fix the route', 'james', { chatId: 5613428850, updateId: 108 });

      await new Promise((resolve) => setImmediate(resolve));
      expect(sendMiraLivePrompt).not.toHaveBeenCalled();
      expect(sendRoutedTelegramMessage).not.toHaveBeenCalled();
      expect(deliverySpy).toHaveBeenCalledWith(
        '[Telegram from james]: /task fix the route',
        expect.objectContaining({
          paneId: '1',
          role: 'architect',
          windowKey: 'main',
          channel: 'telegram',
          messageId: 'telegram-in-108',
        }),
        'Telegram'
      );
    });

    it('keeps Telegram agent ops envelopes on the existing Architect pane route', async () => {
      const telegramPoller = require('../modules/telegram-poller');
      const { sendRoutedTelegramMessage } = require('../scripts/hm-telegram-routing');
      const { sendMiraLivePrompt } = require('../modules/mira-live-entrypoint');
      telegramPoller.start.mockReturnValue(true);
      const deliverySpy = jest.spyOn(app, 'deliverHumanMessageWithRecall').mockResolvedValue({
        accepted: true,
        queued: true,
        verified: true,
      });

      app.startTelegramPoller();

      const options = telegramPoller.start.mock.calls[0][0];
      options.onMessage('(ARCHITECT #1): route Builder this check', 'james', { chatId: 5613428850, updateId: 109 });

      await new Promise((resolve) => setImmediate(resolve));
      expect(sendMiraLivePrompt).not.toHaveBeenCalled();
      expect(sendRoutedTelegramMessage).not.toHaveBeenCalled();
      expect(deliverySpy).toHaveBeenCalledWith(
        '[Telegram from james]: (ARCHITECT #1): route Builder this check',
        expect.objectContaining({
          paneId: '1',
          role: 'architect',
          windowKey: 'main',
          channel: 'telegram',
          messageId: 'telegram-in-109',
        }),
        'Telegram'
      );
    });

    it('routes scoped Telegram chat inbound through the scoped runtime even when a side window is registered', async () => {
      const telegramPoller = require('../modules/telegram-poller');
      telegramPoller.start.mockReturnValue(true);
      const deliverySpy = jest.spyOn(app, 'deliverHumanMessageWithRecall').mockResolvedValue({
        accepted: true,
        queued: true,
        verified: true,
      });
      const scopedRuntimeSpy = jest.spyOn(app, 'deliverScopedTelegramInboundToProfileWindow').mockResolvedValue({
        ok: true,
        accepted: true,
        queued: true,
        verified: true,
        userVisible: true,
        status: 'delivered.daemon_pty',
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
      await new Promise((resolve) => setImmediate(resolve));
      expect(scopedRuntimeSpy).toHaveBeenCalledWith(
        'scoped',
        '[Telegram from scoped]: side hello',
        expect.objectContaining({
          chatId: 2222222222,
          messageId: 'telegram-in-102',
          sender: 'scoped',
          sessionScopeId: expect.stringContaining(':scoped'),
          updateId: 102,
        })
      );
      expect(deliverySpy).not.toHaveBeenCalled();
    });

    it('injects scoped Telegram chat inbound through the standalone profile runtime first', async () => {
      const telegramPoller = require('../modules/telegram-poller');
      telegramPoller.start.mockReturnValue(true);
      const deliverySpy = jest.spyOn(app, 'deliverHumanMessageWithRecall').mockResolvedValue({
        accepted: true,
        queued: true,
        verified: true,
      });
      const forwardSpy = jest.spyOn(app, 'forwardScopedTelegramInboundToProfileWindow').mockReturnValue(true);
      const scopedRuntimeSpy = jest.spyOn(app, 'deliverScopedTelegramInboundToProfileWindow').mockResolvedValue({
        ok: true,
        accepted: true,
        queued: true,
        verified: true,
        userVisible: true,
        status: 'delivered.verified',
      });

      app.startTelegramPoller();

      const options = telegramPoller.start.mock.calls[0][0];
      options.onMessage('standalone hello', 'scoped', { chatId: 2222222222, updateId: 103 });

      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(scopedRuntimeSpy).toHaveBeenCalledWith(
        'scoped',
        '[Telegram from scoped]: standalone hello',
        expect.objectContaining({
          chatId: 2222222222,
          messageId: 'telegram-in-103',
          sender: 'scoped',
          sessionScopeId: expect.stringContaining(':scoped'),
          updateId: 103,
        })
      );
      expect(forwardSpy).not.toHaveBeenCalled();
      expect(deliverySpy).not.toHaveBeenCalled();
    });

    it('routes configured non-owner Telegram inbound to the scoped profile pane runtime instead of main Architect', async () => {
      const telegramPoller = require('../modules/telegram-poller');
      telegramPoller.start.mockReturnValue(true);
      const deliverySpy = jest.spyOn(app, 'deliverHumanMessageWithRecall').mockResolvedValue({
        accepted: true,
        queued: true,
        verified: true,
      });
      const forwardSpy = jest.spyOn(app, 'forwardScopedTelegramInboundToProfileWindow').mockReturnValue(true);
      const scopedRuntimeSpy = jest.spyOn(app, 'deliverScopedTelegramInboundToProfileWindow').mockResolvedValue({
        ok: true,
        accepted: true,
        queued: true,
        verified: true,
        userVisible: true,
        status: 'delivered.verified',
      });

      app.startTelegramPoller();

      const options = telegramPoller.start.mock.calls[0][0];
      options.onMessage('hello client lane', '@ClientProfile', { chatId: 3333333333, updateId: 104 });

      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(scopedRuntimeSpy).toHaveBeenCalledWith(
        'client-profile',
        '[Telegram from @ClientProfile]: hello client lane',
        expect.objectContaining({
          chatId: 3333333333,
          messageId: 'telegram-in-104',
          sender: '@ClientProfile',
          sessionScopeId: expect.stringContaining(':client-profile'),
          updateId: 104,
        })
      );
      expect(forwardSpy).not.toHaveBeenCalled();
      expect(deliverySpy).not.toHaveBeenCalled();
      expect(app.telegramInboundContext).toEqual(expect.objectContaining({
        lastInboundAtMs: 0,
        chatId: null,
      }));
    });

    it('writes scoped Telegram triggers only as a fallback when pane runtime delivery is not verified', async () => {
      const telegramPoller = require('../modules/telegram-poller');
      telegramPoller.start.mockReturnValue(true);
      const deliverySpy = jest.spyOn(app, 'deliverHumanMessageWithRecall').mockResolvedValue({
        accepted: true,
        queued: true,
        verified: true,
      });
      const forwardSpy = jest.spyOn(app, 'forwardScopedTelegramInboundToProfileWindow').mockReturnValue(true);
      jest.spyOn(app, 'deliverScopedTelegramInboundWithRetry').mockResolvedValue({
        ok: false,
        accepted: false,
        queued: false,
        verified: false,
        userVisible: false,
        status: 'scoped_runtime_unavailable',
      });

      app.startTelegramPoller();

      const options = telegramPoller.start.mock.calls[0][0];
      options.onMessage('fallback hello', 'scoped', { chatId: 2222222222, updateId: 107 });

      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(forwardSpy).toHaveBeenCalledWith(
        'scoped',
        '[Telegram from scoped]: fallback hello'
      );
      expect(deliverySpy).not.toHaveBeenCalled();
    });

    it('routes Eunbyeol Telegram inbound through the Eunbyeol scoped runtime even when the window is registered', async () => {
      const telegramPoller = require('../modules/telegram-poller');
      telegramPoller.start.mockReturnValue(true);
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-telegram-context-'));
      const contextPath = path.join(tempRoot, 'telegram-reply-context.json');
      const previousPersistedContext = {
        chatId: '1111111111',
        defaultChatId: '1111111111',
        sender: 'james',
        windowKey: 'main',
        profile: 'main',
        sessionScopeId: 'app-test:main',
        lastInboundAtMs: 1700000000000,
        updatedAt: '2026-05-07T00:00:00.000Z',
      };
      fs.writeFileSync(contextPath, JSON.stringify(previousPersistedContext, null, 2));
      jest.spyOn(app, 'getTelegramReplyContextPath').mockReturnValue(contextPath);
      app.telegramInboundContext = {
        lastInboundAtMs: previousPersistedContext.lastInboundAtMs,
        sender: previousPersistedContext.sender,
        chatId: previousPersistedContext.chatId,
        windowKey: 'main',
        profile: 'main',
        sessionScopeId: previousPersistedContext.sessionScopeId,
      };
      const previousContext = { ...app.telegramInboundContext };
      const deliverySpy = jest.spyOn(app, 'deliverHumanMessageWithRecall').mockResolvedValue({
        accepted: true,
        queued: true,
        verified: true,
      });
      const forwardSpy = jest.spyOn(app, 'forwardScopedTelegramInboundToProfileWindow').mockReturnValue(true);
      const scopedRuntimeSpy = jest.spyOn(app, 'deliverScopedTelegramInboundToProfileWindow').mockResolvedValue({
        ok: true,
        accepted: true,
        queued: true,
        verified: true,
        userVisible: true,
        status: 'delivered.daemon_pty',
      });
      const launchSpy = jest.spyOn(app, 'launchWindowsForProfile').mockResolvedValue();
      app.registerAppWindow('eunbyeol', {
        isDestroyed: jest.fn().mockReturnValue(false),
        webContents: {
          isDestroyed: jest.fn().mockReturnValue(false),
          send: jest.fn(),
        },
      });

      try {
        app.startTelegramPoller();

        const options = telegramPoller.start.mock.calls[0][0];
        options.onMessage('hello Eunbyeol lane', '@Eunbyeol', { chatId: 4444444444, updateId: 106 });

        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        expect(scopedRuntimeSpy).toHaveBeenCalledWith(
          'eunbyeol',
          '[Telegram from @Eunbyeol]: hello Eunbyeol lane',
          expect.objectContaining({
            chatId: 4444444444,
            messageId: 'telegram-in-106',
            sender: '@Eunbyeol',
            sessionScopeId: expect.stringContaining(':eunbyeol'),
            updateId: 106,
          })
        );
        expect(forwardSpy).not.toHaveBeenCalled();
        expect(deliverySpy).not.toHaveBeenCalled();
        expect(launchSpy).not.toHaveBeenCalled();
        expect(app.telegramInboundContext).toEqual(previousContext);
        expect(JSON.parse(fs.readFileSync(contextPath, 'utf8'))).toEqual(previousPersistedContext);
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    });

    it('fails closed for unknown non-owner Telegram chats before updating reply context', async () => {
      const telegramPoller = require('../modules/telegram-poller');
      telegramPoller.start.mockReturnValue(true);
      const deliverySpy = jest.spyOn(app, 'deliverHumanMessageWithRecall').mockResolvedValue({
        accepted: true,
        queued: true,
        verified: true,
      });
      const forwardSpy = jest.spyOn(app, 'forwardScopedTelegramInboundToProfileWindow').mockReturnValue(true);
      const previousContext = app.telegramInboundContext;

      app.startTelegramPoller();

      const options = telegramPoller.start.mock.calls[0][0];
      options.onMessage('private message', '@Unknown', { chatId: 9999999999, updateId: 105 });

      await new Promise((resolve) => setImmediate(resolve));
      expect(forwardSpy).not.toHaveBeenCalled();
      expect(deliverySpy).not.toHaveBeenCalled();
      expect(app.telegramInboundContext).toEqual(previousContext);
    });

    it('appends standalone scoped Telegram forwarding into scoped profile and compatibility trigger roots', () => {
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-scoped-root-'));
      const compatRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-scoped-compat-'));
      const scopedTriggerPath = path.join(tempRoot, '.squidrun', 'triggers-scoped', 'architect.txt');
      const compatTriggerPath = path.join(compatRoot, '.squidrun', 'triggers-scoped', 'architect.txt');
      jest.spyOn(app, 'getScopedTelegramTriggerPaths').mockReturnValue([scopedTriggerPath, compatTriggerPath]);

      try {
        const forwarded = app.forwardScopedTelegramInboundToProfileWindow(
          'scoped',
          '[Telegram from scoped]: root test 1'
        );
        const forwardedAgain = app.forwardScopedTelegramInboundToProfileWindow(
          'scoped',
          '[Telegram from scoped]: root test 2'
        );

        expect(forwarded).toBe(true);
        expect(forwardedAgain).toBe(true);
        expect(fs.readFileSync(scopedTriggerPath, 'utf8')).toBe(
          '[Telegram from scoped]: root test 1\n[Telegram from scoped]: root test 2\n'
        );
        expect(fs.readFileSync(compatTriggerPath, 'utf8')).toBe(
          '[Telegram from scoped]: root test 1\n[Telegram from scoped]: root test 2\n'
        );
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
        fs.rmSync(compatRoot, { recursive: true, force: true });
      }
    });

    it('keeps scoped Telegram trigger overwrite mode behind the hardening rollback flag', () => {
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-scoped-overwrite-'));
      const previousHardening = process.env.SQUIDRUN_INJECT_BUSY_PANE_HARDENING;
      process.env.SQUIDRUN_INJECT_BUSY_PANE_HARDENING = '0';
      const triggerPath = path.join(tempRoot, '.squidrun', 'triggers-scoped', 'architect.txt');
      jest.spyOn(app, 'getScopedTelegramTriggerPaths').mockReturnValue([triggerPath]);

      try {
        expect(app.forwardScopedTelegramInboundToProfileWindow('scoped', 'first')).toBe(true);
        expect(app.forwardScopedTelegramInboundToProfileWindow('scoped', 'second')).toBe(true);
        expect(fs.readFileSync(triggerPath, 'utf8')).toBe('second');
      } finally {
        if (previousHardening === undefined) {
          delete process.env.SQUIDRUN_INJECT_BUSY_PANE_HARDENING;
        } else {
          process.env.SQUIDRUN_INJECT_BUSY_PANE_HARDENING = previousHardening;
        }
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    });

    it('retries scoped Telegram runtime delivery until user-visible verification', async () => {
      jest.useFakeTimers();
      const previousAttempts = process.env.SQUIDRUN_SCOPED_TELEGRAM_MAX_ATTEMPTS;
      const previousBackoff = process.env.SQUIDRUN_SCOPED_TELEGRAM_RETRY_BASE_MS;
      process.env.SQUIDRUN_SCOPED_TELEGRAM_MAX_ATTEMPTS = '3';
      process.env.SQUIDRUN_SCOPED_TELEGRAM_RETRY_BASE_MS = '1';
      const firstFailure = {
        ok: false,
        accepted: true,
        queued: true,
        verified: false,
        userVisible: false,
        status: 'accepted.unverified',
      };
      const success = {
        ok: true,
        accepted: true,
        queued: true,
        verified: true,
        userVisible: true,
        status: 'delivered.daemon_pty',
      };
      const scopedRuntimeSpy = jest.spyOn(app, 'deliverScopedTelegramInboundToProfileWindow')
        .mockResolvedValueOnce(firstFailure)
        .mockResolvedValueOnce(firstFailure)
        .mockResolvedValueOnce(success);

      try {
        const delivery = app.deliverScopedTelegramInboundWithRetry('scoped', 'retry payload', { messageId: 'telegram-in-retry' });
        await Promise.resolve();
        await jest.advanceTimersByTimeAsync(250);
        await Promise.resolve();
        await jest.advanceTimersByTimeAsync(500);

        await expect(delivery).resolves.toBe(success);
        expect(scopedRuntimeSpy).toHaveBeenCalledTimes(3);
      } finally {
        if (previousAttempts === undefined) {
          delete process.env.SQUIDRUN_SCOPED_TELEGRAM_MAX_ATTEMPTS;
        } else {
          process.env.SQUIDRUN_SCOPED_TELEGRAM_MAX_ATTEMPTS = previousAttempts;
        }
        if (previousBackoff === undefined) {
          delete process.env.SQUIDRUN_SCOPED_TELEGRAM_RETRY_BASE_MS;
        } else {
          process.env.SQUIDRUN_SCOPED_TELEGRAM_RETRY_BASE_MS = previousBackoff;
        }
        jest.useRealTimers();
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
      const scopedRuntimeSpy = jest.spyOn(app, 'deliverScopedTelegramInboundToProfileWindow').mockResolvedValue({
        ok: true,
        accepted: true,
        queued: true,
        verified: true,
        userVisible: true,
        status: 'delivered.verified',
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
        updateId: 808489705,
        media: {
          kind: 'photo',
          localPath: 'D:\\projects\\Example Case\\telegram-photos\\photo-11.jpg',
          latestScreenshotPath: 'D:\\projects\\squidrun\\.squidrun\\screenshots\\latest.png',
        },
      });

      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(scopedRuntimeSpy).toHaveBeenCalledWith(
        'scoped',
        '[Telegram from @ScopedContact]: [Photo received] | saved: D:\\projects\\Example Case\\telegram-photos\\photo-11.jpg',
        expect.objectContaining({
          chatId: 2222222222,
          messageId: 'telegram-in-808489705',
          sender: '@ScopedContact',
        }),
      );
      expect(deliverySpy).not.toHaveBeenCalled();
    });

    it('synthesizes photo display text for scoped runtime delivery when poller passes empty body with photo metadata', async () => {
      const telegramPoller = require('../modules/telegram-poller');
      telegramPoller.start.mockReturnValue(true);
      const deliverySpy = jest.spyOn(app, 'deliverHumanMessageWithRecall').mockResolvedValue({
        accepted: true,
        queued: true,
        verified: true,
      });
      const scopedRuntimeSpy = jest.spyOn(app, 'deliverScopedTelegramInboundToProfileWindow').mockResolvedValue({
        ok: true,
        accepted: true,
        queued: true,
        verified: true,
        userVisible: true,
        status: 'delivered.verified',
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
      await new Promise((resolve) => setImmediate(resolve));
      expect(scopedRuntimeSpy).toHaveBeenCalledWith(
        'scoped',
        '[Telegram from @ScopedContact]: [Photo received]',
        expect.objectContaining({
          chatId: 2222222222,
          messageId: 'telegram-in-808489706',
          sender: '@ScopedContact',
        }),
      );
      expect(deliverySpy).not.toHaveBeenCalled();
    });

    it('synthesizes video display text and includes saved file path for inbound Telegram videos', async () => {
      const telegramPoller = require('../modules/telegram-poller');
      telegramPoller.start.mockReturnValue(true);
      const deliverySpy = jest.spyOn(app, 'deliverHumanMessageWithRecall').mockResolvedValue({
        accepted: true,
        queued: true,
        verified: true,
      });

      app.startTelegramPoller();

      const options = telegramPoller.start.mock.calls[0][0];
      options.onMessage('', '@VideoSender', {
        updateId: 808489707,
        messageId: 556,
        chatId: 5613428850,
        video: {
          file_id: 'video-xyz',
        },
        media: {
          kind: 'video',
          telegramKind: 'video',
          fileId: 'video-xyz',
          mimeType: 'video/mp4',
          localPath: 'D:\\projects\\squidrun\\.squidrun\\runtime\\telegram-inbound-media\\video-556.mp4',
        },
      });

      await new Promise((resolve) => setImmediate(resolve));
      expect(deliverySpy).toHaveBeenCalledWith(
        '[Telegram from @VideoSender]: [Video received] | saved: D:\\projects\\squidrun\\.squidrun\\runtime\\telegram-inbound-media\\video-556.mp4',
        expect.objectContaining({
          paneId: '1',
          role: 'architect',
          channel: 'telegram',
          sender: '@VideoSender',
          metadata: expect.objectContaining({
            media: expect.objectContaining({
              kind: 'video',
              fileId: 'video-xyz',
              localPath: 'D:\\projects\\squidrun\\.squidrun\\runtime\\telegram-inbound-media\\video-556.mp4',
            }),
          }),
        }),
        'Telegram'
      );
    });

    it('restarts the Telegram poller without reloading app panes', () => {
      app.inboundPollerService.stopTelegram = jest.fn();
      app.startTelegramPoller = jest.fn(() => true);
      const reloadEunbyeol = jest.fn();
      const launchSpy = jest.spyOn(app, 'launchWindowsForProfile').mockResolvedValue();
      const createWindowSpy = jest.spyOn(app, 'createWindow').mockResolvedValue();
      app.registerAppWindow('eunbyeol', {
        isDestroyed: jest.fn().mockReturnValue(false),
        webContents: {
          isDestroyed: jest.fn().mockReturnValue(false),
          reloadIgnoringCache: reloadEunbyeol,
          send: jest.fn(),
        },
      });

      const result = app.restartTelegramPoller({ reason: 'test-reload' });

      expect(result).toEqual(expect.objectContaining({
        success: true,
        started: true,
        reason: 'test-reload',
      }));
      expect(app.inboundPollerService.stopTelegram).toHaveBeenCalledTimes(1);
      expect(app.startTelegramPoller).toHaveBeenCalledTimes(1);
      expect(reloadEunbyeol).not.toHaveBeenCalled();
      expect(launchSpy).not.toHaveBeenCalled();
      expect(createWindowSpy).not.toHaveBeenCalled();
    });

    it('does not queue accepted-unverified Telegram inbound for replay', async () => {
      const triggers = require('../modules/triggers');
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-pending-pane-'));
      const queuePath = path.join(tempRoot, 'pending-pane-deliveries.json');
      jest.spyOn(app, 'getPendingPaneDeliveryQueuePath').mockReturnValue(queuePath);
      triggers.sendDirectMessage.mockResolvedValueOnce({
        accepted: true,
        queued: true,
        verified: false,
        status: 'routed_unverified_timeout',
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
          accepted: true,
          queued: true,
          verified: false,
          status: 'routed_unverified_timeout',
        }));
        expect(result.pendingQueued).not.toBe(true);
        expect(fs.existsSync(queuePath)).toBe(false);
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    });

    it('queues Telegram inbound delivery for replay on hard pane delivery failure', async () => {
      const triggers = require('../modules/triggers');
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-pending-pane-hard-failure-'));
      const queuePath = path.join(tempRoot, 'pending-pane-deliveries.json');
      jest.spyOn(app, 'getPendingPaneDeliveryQueuePath').mockReturnValue(queuePath);
      triggers.sendDirectMessage.mockResolvedValueOnce({
        accepted: false,
        queued: false,
        verified: false,
        status: 'window_unavailable',
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
          pendingFailureReason: 'window_unavailable',
        }));
        const persisted = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
        expect(persisted.items).toEqual([
          expect.objectContaining({
            messageId: 'telegram-in-123',
            paneId: '1',
            channel: 'telegram',
            sender: 'scoped',
            lastFailureReason: 'window_unavailable',
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
        accepted: false,
        queued: false,
        verified: false,
        status: 'window_unavailable',
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
          pendingFailureReason: 'window_unavailable',
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
        expect.stringContaining('[Telegram from james]: plain inbound message'),
        null,
        expect.any(Object)
      );
      expect(triggers.sendDirectMessage.mock.calls[0][1]).toContain('[SQUIDRUN REPLY TARGET: TELEGRAM REQUIRED]');
      expect(triggers.sendDirectMessage.mock.calls[0][1]).toContain('Do not answer only in this pane');
      expect(triggers.sendDirectMessage.mock.calls[0][1]).not.toContain('[SQUIDRUN RECALL START]');
    });

    it('carries actionable Telegram reply-target metadata on pane delivery', async () => {
      const triggers = require('../modules/triggers');
      triggers.sendDirectMessage.mockResolvedValueOnce({
        accepted: true,
        queued: true,
        verified: true,
        status: 'delivered.verified',
      });

      await app.deliverHumanMessageWithRecall(
        '[Telegram from james]: route this back',
        {
          paneId: '1',
          channel: 'telegram',
          sender: 'james',
          messageId: 'telegram-in-reply-target-1',
          chatId: '1111111111',
          metadata: {
            source: 'telegram-poller',
            updateId: 123,
          },
        },
        'Telegram'
      );

      expect(triggers.sendDirectMessage.mock.calls[0][3]).toEqual(expect.objectContaining({
        meta: expect.objectContaining({
          source: 'telegram-poller',
          channel: 'telegram',
          replyTarget: 'telegram',
          reply_target: 'telegram',
          replyTargetRequired: true,
          replyTargetReason: 'telegram_origin_user_message',
          telegramRequiresEgress: true,
          chatId: '1111111111',
          telegramChatId: '1111111111',
          replyToMessageId: 'telegram-in-reply-target-1',
        }),
      }));
      expect(app.pendingTelegramReplyGuards.get('1')).toEqual(expect.objectContaining({
        messageId: 'telegram-in-reply-target-1',
        chatId: '1111111111',
        status: 'pending_telegram_egress',
        requiresTelegramEgress: true,
        durableObligationOk: true,
        durableObligationId: 'telegram-reply-test',
      }));
      expect(openTelegramReplyObligation).toHaveBeenCalledWith(
        expect.objectContaining({
          inboundMessageId: 'telegram-in-reply-target-1',
          chatId: '1111111111',
          sessionId: expect.any(String),
          paneId: '1',
          windowKey: 'main',
          profileName: 'main',
          senderRole: 'james',
          targetRole: 'architect',
          metadata: expect.objectContaining({
            source: 'squidrun-app.telegram-reply-guard',
            requiresTelegramEgress: true,
            status: 'pending_telegram_egress',
          }),
        }),
        expect.objectContaining({
          nowMs: expect.any(Number),
        })
      );
    });

    it('hydrates pending Telegram reply guards from durable open obligations without auto-nagging', () => {
      const nowMs = Date.now();
      app.commsSessionScopeId = 'app-session-hydrate';
      queryTelegramReplyObligations.mockReturnValue([
        {
          obligationId: 'telegram-reply-hydrate-1',
          inboundMessageId: 'telegram-in-hydrate-1',
          chatId: '1111111111',
          sessionId: 'app-session-hydrate',
          paneId: '2',
          windowKey: 'main',
          profileName: 'main',
          senderRole: 'james',
          status: 'open',
          openedAtMs: nowMs - 1000,
          deadlineAtMs: nowMs + 60_000,
        },
        {
          obligationId: 'telegram-reply-expired-1',
          inboundMessageId: 'telegram-in-expired-1',
          chatId: '1111111111',
          sessionId: 'app-session-hydrate',
          paneId: '3',
          windowKey: 'main',
          profileName: 'main',
          senderRole: 'james',
          status: 'open',
          openedAtMs: nowMs - 120_000,
          deadlineAtMs: nowMs - 1,
        },
      ]);

      const result = app.hydratePendingTelegramReplyGuardsFromObligations({ nowMs });

      expect(queryTelegramReplyObligations).toHaveBeenCalledWith(expect.objectContaining({
        status: 'open',
        sessionId: 'app-session-hydrate',
        order: 'asc',
      }));
      expect(result).toEqual(expect.objectContaining({
        ok: true,
        status: 'telegram_reply_obligations_hydrated',
        hydratedCount: 2,
        skippedCount: 0,
        sessionId: 'app-session-hydrate',
        autoEscalationScheduledCount: 0,
        autoEscalationSuppressedCount: 2,
      }));
      expect(app.pendingTelegramReplyGuards.get('2')).toEqual(expect.objectContaining({
        paneId: '2',
        messageId: 'telegram-in-hydrate-1',
        chatId: '1111111111',
        sessionScopeId: 'app-session-hydrate',
        status: 'pending_telegram_egress',
        requiresTelegramEgress: true,
        durableObligationOk: true,
        durableObligationId: 'telegram-reply-hydrate-1',
        hydratedFromDurableObligation: true,
        autoEscalationSuppressed: true,
        durableDeadlineElapsedAtHydration: false,
      }));
      expect(app.pendingTelegramReplyGuards.get('3')).toEqual(expect.objectContaining({
        paneId: '3',
        messageId: 'telegram-in-expired-1',
        sessionScopeId: 'app-session-hydrate',
        status: 'pending_telegram_egress',
        hydratedFromDurableObligation: true,
        autoEscalationSuppressed: true,
        durableDeadlineElapsedAtHydration: true,
      }));
      expect(app.pendingTelegramReplyGuardTimers.size).toBe(0);
      expect(spawn).not.toHaveBeenCalled();
      expect(mockManagers.activity.logActivity).not.toHaveBeenCalledWith(
        'agent_response_debt',
        expect.any(String),
        expect.stringContaining('TELEGRAM REPLY REQUIREMENT UNRESOLVED'),
        expect.any(Object)
      );
    });

    it('does not auto-alert after restart hydration even when the rebuilt guard deadline passes', async () => {
      const nowMs = Date.parse('2026-06-06T12:00:00.000Z');
      jest.useFakeTimers({ now: nowMs });
      try {
        app.commsSessionScopeId = 'app-session-restart-no-nag';
        queryTelegramReplyObligations.mockReturnValue([
          {
            obligationId: 'telegram-reply-restart-no-nag-1',
            inboundMessageId: 'telegram-in-restart-no-nag-1',
            chatId: '1111111111',
            sessionId: 'app-session-restart-no-nag',
            paneId: '1',
            windowKey: 'main',
            profileName: 'main',
            senderRole: 'james',
            status: 'open',
            openedAtMs: nowMs - 30_000,
            deadlineAtMs: nowMs + 1000,
          },
        ]);

        const result = app.hydratePendingTelegramReplyGuardsFromObligations({ nowMs });
        mockManagers.activity.logActivity.mockClear();
        spawn.mockClear();

        jest.advanceTimersByTime(2000);
        await Promise.resolve();

        expect(result).toEqual(expect.objectContaining({
          ok: true,
          hydratedCount: 1,
          autoEscalationScheduledCount: 0,
          autoEscalationSuppressedCount: 1,
        }));
        expect(app.getPendingTelegramReplyRequirement('1')).toEqual(expect.objectContaining({
          messageId: 'telegram-in-restart-no-nag-1',
          status: 'pending_telegram_egress',
          autoEscalationSuppressed: true,
        }));
        expect(mockManagers.activity.logActivity).not.toHaveBeenCalledWith(
          'agent_response_debt',
          '1',
          expect.stringContaining('TELEGRAM REPLY REQUIREMENT UNRESOLVED'),
          expect.any(Object)
        );
        expect(spawn).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    it('prepends unified memory broker recall when ranked context exists', async () => {
      const triggers = require('../modules/triggers');
      mockManagers.memoryBroker = {
        recall: jest.fn(async () => ({
          ok: true,
          results: [
            {
              rank: 1,
              sourceKind: 'vector_cognitive',
              title: 'Communication preference',
              excerpt: 'James wants non-jargon plain English updates.',
              ref: 'memory:plain-english',
            },
          ],
        })),
      };
      app = new SquidRunApp(mockAppContext, mockManagers);
      triggers.sendDirectMessage.mockResolvedValueOnce({
        accepted: true,
        queued: true,
        verified: true,
        status: 'delivered.verified',
      });

      await app.deliverHumanMessageWithRecall(
        '[Telegram from james]: what did you do?',
        {
          paneId: '1',
          channel: 'telegram',
          sender: 'james',
          messageId: 'telegram-in-recall-1',
        },
        'Telegram'
      );

      expect(mockManagers.memoryBroker.recall).toHaveBeenCalledWith(
        '[Telegram from james]: what did you do?',
        expect.objectContaining({
          channel: 'telegram',
          paneId: '1',
          windowKey: 'main',
          profileName: 'main',
          sessionScopeId: null,
        }),
        expect.objectContaining({ limit: 4, providerLimit: 3 })
      );
      expect(triggers.sendDirectMessage.mock.calls[0][1]).toContain('[SQUIDRUN MEMORY RECALL]');
      expect(triggers.sendDirectMessage.mock.calls[0][1]).toContain('James wants non-jargon plain English updates.');
      expect(triggers.sendDirectMessage.mock.calls[0][1]).toContain('[Telegram from james]: what did you do?');
    });

    it('passes profile scope into recall and delivery metadata for scoped human messages', async () => {
      const triggers = require('../modules/triggers');
      mockManagers.memoryBroker = {
        recall: jest.fn(async () => ({
          ok: true,
          results: [
            {
              rank: 1,
              sourceKind: 'graph_team',
              title: 'Scoped context',
              excerpt: 'Only visible when profile scope matches.',
              ref: 'memory:scoped',
            },
          ],
        })),
      };
      app = new SquidRunApp(mockAppContext, mockManagers);
      triggers.sendDirectMessage.mockResolvedValueOnce({
        accepted: true,
        queued: true,
        verified: true,
        status: 'delivered.verified',
      });

      await app.deliverHumanMessageWithRecall(
        '[Telegram from eunbyeol]: status?',
        {
          paneId: '1',
          channel: 'telegram',
          sender: 'eunbyeol',
          messageId: 'telegram-in-eunbyeol-1',
          windowKey: 'eunbyeol',
          profileName: 'eunbyeol',
          sessionScopeId: 'app-test:eunbyeol',
        },
        'Telegram'
      );

      expect(mockManagers.memoryBroker.recall).toHaveBeenCalledWith(
        '[Telegram from eunbyeol]: status?',
        expect.objectContaining({
          channel: 'telegram',
          paneId: '1',
          windowKey: 'eunbyeol',
          profileName: 'eunbyeol',
          sessionScopeId: 'app-test:eunbyeol',
        }),
        expect.objectContaining({ limit: 4, providerLimit: 3 })
      );
      expect(triggers.sendDirectMessage.mock.calls[0][3]).toEqual(expect.objectContaining({
        meta: expect.objectContaining({
          windowKey: 'eunbyeol',
          profileName: 'eunbyeol',
          sessionScopeId: 'app-test:eunbyeol',
        }),
      }));
    });

    it('keeps Telegram reply requirements unresolved when a pane answers without Telegram egress', () => {
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
        getWindow: jest.fn((key = 'main') => (key === 'main' ? mainWindow : null)),
        getWindows: jest.fn(() => new Map([['main', mainWindow]])),
      };
      const guardedApp = new SquidRunApp(ctx, mockManagers);
      guardedApp.markPendingTelegramReplyGuard({
        paneId: '1',
        messageId: 'telegram-in-visible-output-1',
        chatId: '1111111111',
        sender: 'james',
      });

      const result = guardedApp.inspectPaneOutputForReplyGuards('1', 'I answered in the pane only.', {
        outputKind: 'agent_visible_output',
      });

      expect(result).toEqual(expect.objectContaining({
        ok: false,
        status: 'telegram_reply_requirement_unresolved',
        guard: expect.objectContaining({
          status: 'telegram_reply_required_unresolved',
          violationCount: 1,
          lastPaneOutputPreview: 'I answered in the pane only.',
        }),
      }));
      expect(mockManagers.activity.logActivity).toHaveBeenCalledWith(
        'agent_response_debt',
        '1',
        expect.stringContaining('TELEGRAM REPLY REQUIREMENT UNRESOLVED'),
        expect.objectContaining({
          source: 'telegram-reply-requirement',
          debtKind: 'telegram_reply_required',
          agentSideOnly: true,
          userFacingNoticeSuppressed: true,
          messageId: 'telegram-in-visible-output-1',
          chatId: '1111111111',
          status: 'telegram_reply_required_unresolved',
          requiresTelegramEgress: true,
          agentAlert: expect.objectContaining({
            ok: true,
            targetRoles: ['architect'],
          }),
        })
      );
      expect(mainWindow.webContents.send).not.toHaveBeenCalledWith(
        'project-warning',
        expect.anything()
      );
      expect(spawn).toHaveBeenCalledWith(
        'node',
        expect.arrayContaining([
          expect.stringContaining(path.join('scripts', 'hm-send.js')),
          'architect',
          expect.stringContaining('(SYSTEM RESPONSE-DEBT): TELEGRAM REPLY REQUIREMENT UNRESOLVED'),
          '--role',
          'system',
        ]),
        expect.objectContaining({
          windowsHide: true,
        })
      );
      expect(guardedApp.getPendingTelegramReplyRequirement('1')).toEqual(expect.objectContaining({
        messageId: 'telegram-in-visible-output-1',
        status: 'telegram_reply_required_unresolved',
        violationCount: 1,
        agentDebtNoticeTargetRoles: ['architect'],
      }));
    });

    it('keeps ignored Telegram reply warnings unresolved instead of treating pane output as satisfaction', () => {
      app.markPendingTelegramReplyGuard({
        paneId: '1',
        messageId: 'telegram-in-throttled-unresolved-1',
        chatId: '1111111111',
        sender: 'james',
      });

      app.inspectPaneOutputForReplyGuards('1', 'first pane-only answer', {
        outputKind: 'agent_visible_output',
      });
      const result = app.inspectPaneOutputForReplyGuards('1', 'second pane-only answer', {
        outputKind: 'agent_visible_output',
      });

      expect(result).toEqual(expect.objectContaining({
        ok: false,
        status: 'telegram_reply_requirement_unresolved_throttled',
        guard: expect.objectContaining({
          messageId: 'telegram-in-throttled-unresolved-1',
          status: 'telegram_reply_required_unresolved',
          violationCount: 2,
          lastPaneOutputPreview: 'second pane-only answer',
        }),
      }));
      expect(app.getPendingTelegramReplyRequirement('1')).toEqual(expect.objectContaining({
        messageId: 'telegram-in-throttled-unresolved-1',
        status: 'telegram_reply_required_unresolved',
        violationCount: 2,
      }));
    });

    it('routes unanswered Telegram reply requirements to agent lanes instead of James-facing notices', async () => {
      const { sendRoutedTelegramMessage } = require('../scripts/hm-telegram-routing');
      jest.useFakeTimers({ now: 1700000000000 });
      try {
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
          getWindow: jest.fn((key = 'main') => (key === 'main' ? mainWindow : null)),
          getWindows: jest.fn(() => new Map([['main', mainWindow]])),
        };
        const guardedApp = new SquidRunApp(ctx, mockManagers);
        guardedApp.markPendingTelegramReplyGuard({
          paneId: '1',
          messageId: 'telegram-in-expire-1',
          chatId: '1111111111',
          sender: 'james',
        });
        guardedApp.inspectPaneOutputForReplyGuards('1', 'RAW PANE HALF THOUGHT - do not text this', {
          outputKind: 'agent_visible_output',
        });

        jest.advanceTimersByTime((5 * 60 * 1000) + 1);
        await Promise.resolve();
        await Promise.resolve();

        expect(guardedApp.getPendingTelegramReplyRequirement('1')).toEqual(expect.objectContaining({
          messageId: 'telegram-in-expire-1',
          status: 'telegram_reply_required_expired_unresolved',
          unresolvedReason: 'reply_window_expired',
          agentDebtNoticeAttemptCount: 2,
          agentDebtNoticeTargetRoles: ['architect'],
          agentDebtNoticeError: null,
          requiresTelegramEgress: true,
        }));
        expect(sendRoutedTelegramMessage).not.toHaveBeenCalled();
        expect(mockManagers.activity.logActivity).toHaveBeenCalledWith(
          'agent_response_debt',
          '1',
          expect.stringContaining('TELEGRAM REPLY REQUIREMENT UNRESOLVED'),
          expect.objectContaining({
            source: 'telegram-reply-requirement',
            debtKind: 'telegram_reply_required',
            agentSideOnly: true,
            userFacingNoticeSuppressed: true,
            messageId: 'telegram-in-expire-1',
            status: 'telegram_reply_required_expired_unresolved',
            reason: 'reply_window_expired',
            requiresTelegramEgress: true,
            agentAlert: expect.objectContaining({
              ok: true,
              route: 'agent_hm_send',
              targetRoles: ['architect'],
            }),
          })
        );
        expect(mainWindow.webContents.send).not.toHaveBeenCalledWith(
          'project-warning',
          expect.anything()
        );
        expect(spawn).toHaveBeenCalledWith(
          'node',
          expect.arrayContaining([
            expect.stringContaining(path.join('scripts', 'hm-send.js')),
            'architect',
            expect.stringContaining('Pane 1 still owes Telegram egress for inbound telegram-in-expire-1.'),
            '--role',
            'system',
          ]),
          expect.objectContaining({
            windowsHide: true,
          })
        );
        const laterPaneOutput = guardedApp.inspectPaneOutputForReplyGuards('1', 'still pane-only later', {
          outputKind: 'agent_visible_output',
        });
        expect(laterPaneOutput).toEqual(expect.objectContaining({
          ok: false,
          status: 'telegram_reply_requirement_expired_unresolved',
          guard: expect.objectContaining({
            status: 'telegram_reply_required_expired_unresolved',
            agentDebtNoticeAttemptCount: 2,
          }),
        }));
        expect(sendRoutedTelegramMessage).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    it('stops periodic journal reconciliation after an unanswered Telegram guard expires without pane output', async () => {
      const createdAtMs = Date.parse('2026-06-01T20:40:00.000Z');
      jest.useFakeTimers({ now: createdAtMs });
      try {
        queryCommsJournalEntries.mockReturnValue([]);
        app.markPendingTelegramReplyGuard({
          paneId: '1',
          messageId: 'telegram-in-expire-zero-output-1',
          chatId: '1111111111',
          sender: 'james',
          sessionScopeId: 'app-session-expire-zero-output',
        });
        expect(app.pendingTelegramReplyGuardJournalReconcileTimer).not.toBeNull();

        jest.advanceTimersByTime((5 * 60 * 1000) + 1);
        await Promise.resolve();
        await Promise.resolve();

        expect(app.getPendingTelegramReplyRequirement('1')).toEqual(expect.objectContaining({
          messageId: 'telegram-in-expire-zero-output-1',
          status: 'telegram_reply_required_expired_unresolved',
          unresolvedReason: 'reply_window_expired',
          requiresTelegramEgress: true,
        }));
        expect(app.pendingTelegramReplyGuardJournalReconcileTimer).toBeNull();
        expect(queryCommsJournalEntries).toHaveBeenCalled();

        queryCommsJournalEntries.mockClear();
        mockManagers.activity.logActivity.mockClear();
        jest.advanceTimersByTime(60 * 1000);
        await Promise.resolve();

        expect(queryCommsJournalEntries).not.toHaveBeenCalled();
        expect(mockManagers.activity.logActivity).not.toHaveBeenCalled();
        expect(app.getPendingTelegramReplyRequirement('1')).toEqual(expect.objectContaining({
          messageId: 'telegram-in-expire-zero-output-1',
          status: 'telegram_reply_required_expired_unresolved',
        }));
      } finally {
        jest.useRealTimers();
      }
    });

    it('does not repeat agent-side response-debt alert spam for the same unresolved Telegram debt', async () => {
      const { sendRoutedTelegramMessage } = require('../scripts/hm-telegram-routing');
      app.markPendingTelegramReplyGuard({
        paneId: '1',
        messageId: 'telegram-in-no-spam-1',
        chatId: '1111111111',
        sender: 'james',
      });

      const first = await app.sendTelegramReplyRequirementAgentEscalation('1');
      const second = await app.sendTelegramReplyRequirementAgentEscalation('1');

      expect(first).toEqual(expect.objectContaining({
        ok: true,
        status: 'telegram_reply_requirement_agent_alerted',
      }));
      expect(second).toEqual(expect.objectContaining({
        ok: true,
        status: 'telegram_reply_requirement_agent_alert_already_sent',
      }));
      expect(sendRoutedTelegramMessage).not.toHaveBeenCalled();
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(app.getPendingTelegramReplyRequirement('1')).toEqual(expect.objectContaining({
        messageId: 'telegram-in-no-spam-1',
        status: 'telegram_reply_required_agent_alerted',
        agentDebtNoticeAttemptCount: 1,
        agentDebtNoticeTargetRoles: ['architect'],
        requiresTelegramEgress: true,
      }));
    });

    it('keeps the Telegram reply debt visible when agent-side alert routing fails', async () => {
      const { sendRoutedTelegramMessage } = require('../scripts/hm-telegram-routing');
      app.markPendingTelegramReplyGuard({
        paneId: '2',
        messageId: 'telegram-in-agent-alert-fail-1',
        chatId: '1111111111',
        sender: 'james',
      });
      jest.spyOn(app, 'sendInternalHmMessage').mockReturnValue(false);

      const result = await app.sendTelegramReplyRequirementAgentEscalation('2');

      expect(result).toEqual(expect.objectContaining({
        ok: false,
        status: 'telegram_reply_requirement_agent_alert_failed',
        error: 'agent_route_unavailable',
      }));
      expect(sendRoutedTelegramMessage).not.toHaveBeenCalled();
      expect(app.getPendingTelegramReplyRequirement('2')).toEqual(expect.objectContaining({
        messageId: 'telegram-in-agent-alert-fail-1',
        status: 'telegram_reply_required_agent_alert_failed',
        agentDebtNoticeAttemptCount: 1,
        agentDebtNoticeError: 'agent_route_unavailable',
        requiresTelegramEgress: true,
      }));
      expect(mockManagers.activity.logActivity).toHaveBeenCalledWith(
        'agent_response_debt',
        '2',
        expect.stringContaining('TELEGRAM REPLY REQUIREMENT UNRESOLVED'),
        expect.objectContaining({
          source: 'telegram-reply-requirement',
          messageId: 'telegram-in-agent-alert-fail-1',
          status: 'telegram_reply_required_agent_alerted',
          agentAlert: expect.objectContaining({
            ok: false,
            error: 'agent_route_unavailable',
            targetRoles: ['builder', 'architect'],
          }),
          requiresTelegramEgress: true,
        })
      );
    });

    it('routes scoped Telegram reply debt to agent lanes without sending user-facing phone notices', async () => {
      const { sendRoutedTelegramMessage } = require('../scripts/hm-telegram-routing');
      app.markPendingTelegramReplyGuard({
        paneId: '2',
        messageId: 'telegram-in-scoped-agent-alert-1',
        chatId: '2222222222',
        sender: 'scoped',
        windowKey: 'scoped',
        profileName: 'scoped',
      });

      const result = await app.sendTelegramReplyRequirementAgentEscalation('2');

      expect(result).toEqual(expect.objectContaining({
        ok: true,
        status: 'telegram_reply_requirement_agent_alerted',
      }));
      expect(sendRoutedTelegramMessage).not.toHaveBeenCalled();
      expect(spawn).toHaveBeenCalledWith(
        'node',
        expect.arrayContaining([
          expect.stringContaining(path.join('scripts', 'hm-send.js')),
          'builder',
          expect.stringContaining('(SYSTEM RESPONSE-DEBT): TELEGRAM REPLY REQUIREMENT UNRESOLVED'),
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
          expect.stringContaining('(SYSTEM RESPONSE-DEBT): TELEGRAM REPLY REQUIREMENT UNRESOLVED'),
          '--role',
          'system',
        ]),
        expect.objectContaining({
          windowsHide: true,
        })
      );
      expect(app.getPendingTelegramReplyRequirement('2')).toEqual(expect.objectContaining({
        messageId: 'telegram-in-scoped-agent-alert-1',
        status: 'telegram_reply_required_agent_alerted',
        agentDebtNoticeTargetRoles: ['builder', 'architect'],
        requiresTelegramEgress: true,
      }));
      expect(mockManagers.activity.logActivity).toHaveBeenCalledWith(
        'agent_response_debt',
        '2',
        expect.stringContaining('TELEGRAM REPLY REQUIREMENT UNRESOLVED'),
        expect.objectContaining({
          source: 'telegram-reply-requirement',
          messageId: 'telegram-in-scoped-agent-alert-1',
          agentSideOnly: true,
          userFacingNoticeSuppressed: true,
          agentAlert: expect.objectContaining({
            targetRoles: ['builder', 'architect'],
          }),
          requiresTelegramEgress: true,
        })
      );
    });

    it('does not agent-alert a Telegram reply debt after real Telegram egress clears it', async () => {
      const { sendRoutedTelegramMessage } = require('../scripts/hm-telegram-routing');
      jest.useFakeTimers({ now: 1700000000000 });
      try {
        app.markPendingTelegramReplyGuard({
          paneId: '1',
          messageId: 'telegram-in-clear-before-phone-1',
          chatId: '1111111111',
          sender: 'james',
        });

        const result = await app.routeTelegramReply({
          target: 'telegram',
          content: 'Actual answer through Telegram.',
          messageId: 'telegram-in-clear-before-phone-1-reply',
          chatId: '1111111111',
        });
        expect(result).toEqual(expect.objectContaining({
          ok: true,
          status: 'telegram_delivered',
        }));
        expect(app.getPendingTelegramReplyRequirement('1')).toBeNull();
        sendRoutedTelegramMessage.mockClear();

        jest.advanceTimersByTime((5 * 60 * 1000) + 1);
        await Promise.resolve();
        await Promise.resolve();

        expect(sendRoutedTelegramMessage).not.toHaveBeenCalled();
        expect(spawn).not.toHaveBeenCalled();
        expect(app.getPendingTelegramReplyRequirement('1')).toBeNull();
      } finally {
        jest.useRealTimers();
      }
    });

    it('ignores metadata-classified SquidRun injected Telegram prompt echoes for the response-side guard', () => {
      app.markPendingTelegramReplyGuard({
        paneId: '1',
        messageId: 'telegram-in-echo-1',
        chatId: '1111111111',
        sender: 'james',
      });

      const result = app.inspectPaneOutputForReplyGuards(
        '1',
        '[SQUIDRUN REPLY TARGET: TELEGRAM REQUIRED]\n\n[Telegram from james]: hello',
        { outputKind: 'squidrun_injected_echo' }
      );

      expect(result).toEqual(expect.objectContaining({
        ok: true,
        status: 'injected_echo_ignored',
      }));
      expect(mockManagers.activity.logActivity).not.toHaveBeenCalledWith(
        'warning',
        '1',
        expect.stringContaining('TELEGRAM REPLY REQUIREMENT UNRESOLVED'),
        expect.any(Object)
      );
      expect(app.pendingTelegramReplyGuards.has('1')).toBe(true);
    });

    it('classifies injected Telegram echoes from kernel metadata only', () => {
      expect(app.hasOnlySquidRunInjectedKernelMeta([
        {
          source: 'injection.js',
          meta: {
            replyTargetRequired: true,
            replyTarget: 'telegram',
          },
        },
      ])).toBe(true);
      expect(app.hasOnlySquidRunInjectedKernelMeta([
        {
          source: 'squidrun-app.direct-pane-delivery',
          meta: {
            replyTargetRequired: true,
            channel: 'telegram',
          },
        },
      ])).toBe(true);
      expect(app.hasOnlySquidRunInjectedKernelMeta([
        {
          source: 'injection.js',
          meta: {},
        },
      ])).toBe(false);
      expect(app.hasOnlySquidRunInjectedKernelMeta([])).toBe(false);
    });

    it('routes response debt when quoted inbound text lacks injected-echo metadata', () => {
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
        getWindow: jest.fn((key = 'main') => (key === 'main' ? mainWindow : null)),
        getWindows: jest.fn(() => new Map([['main', mainWindow]])),
      };
      const guardedApp = new SquidRunApp(ctx, mockManagers);
      guardedApp.markPendingTelegramReplyGuard({
        paneId: '1',
        messageId: 'telegram-in-marker-text-1',
        chatId: '1111111111',
        sender: 'james',
      });

      const result = guardedApp.inspectPaneOutputForReplyGuards(
        '1',
        '[Telegram from James]: yes, fixed it, deploying',
        { outputKind: 'agent_visible_output' }
      );

      expect(result).toEqual(expect.objectContaining({
        ok: false,
        status: 'telegram_reply_requirement_unresolved',
      }));
      expect(mainWindow.webContents.send).not.toHaveBeenCalledWith(
        'project-warning',
        expect.anything()
      );
      expect(mockManagers.activity.logActivity).toHaveBeenCalledWith(
        'agent_response_debt',
        '1',
        expect.stringContaining('TELEGRAM REPLY REQUIREMENT UNRESOLVED'),
        expect.objectContaining({
          source: 'telegram-reply-requirement',
          agentSideOnly: true,
        })
      );
    });

    it('routes response debt when quoted reply-target marker text lacks injected-echo metadata', () => {
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
        getWindow: jest.fn((key = 'main') => (key === 'main' ? mainWindow : null)),
        getWindows: jest.fn(() => new Map([['main', mainWindow]])),
      };
      const guardedApp = new SquidRunApp(ctx, mockManagers);
      guardedApp.markPendingTelegramReplyGuard({
        paneId: '1',
        messageId: 'telegram-in-marker-quote-1',
        chatId: '1111111111',
        sender: 'james',
      });

      const result = guardedApp.inspectPaneOutputForReplyGuards(
        '1',
        'Noting [SQUIDRUN REPLY TARGET: TELEGRAM REQUIRED]; the answer is X',
        { outputKind: 'agent_visible_output' }
      );

      expect(result).toEqual(expect.objectContaining({
        ok: false,
        status: 'telegram_reply_requirement_unresolved',
      }));
      expect(mainWindow.webContents.send).not.toHaveBeenCalledWith(
        'project-warning',
        expect.anything()
      );
      expect(mockManagers.activity.logActivity).toHaveBeenCalledWith(
        'agent_response_debt',
        '1',
        expect.stringContaining('TELEGRAM REPLY REQUIREMENT UNRESOLVED'),
        expect.objectContaining({
          source: 'telegram-reply-requirement',
          agentSideOnly: true,
        })
      );
    });

    it('clears the pending Telegram reply guard after real Telegram egress', async () => {
      const { sendRoutedTelegramMessage } = require('../scripts/hm-telegram-routing');
      app.markPendingTelegramReplyGuard({
        paneId: '1',
        messageId: 'telegram-in-clear-1',
        chatId: '1111111111',
        sender: 'james',
      });
      expect(app.inspectPaneOutputForReplyGuards('1', 'pane-only does not clear first', {
        outputKind: 'agent_visible_output',
      })).toEqual(expect.objectContaining({
        ok: false,
        status: 'telegram_reply_requirement_unresolved',
      }));

      const result = await app.routeTelegramReply({
        target: 'telegram',
        content: 'Back through Telegram.',
        messageId: 'telegram-in-clear-1-reply',
        chatId: '1111111111',
      });

      expect(sendRoutedTelegramMessage).toHaveBeenCalled();
      expect(result).toEqual(expect.objectContaining({
        ok: true,
        status: 'telegram_delivered',
        durableSatisfaction: expect.objectContaining({
          ok: true,
          status: 'satisfied',
        }),
      }));
      expect(satisfyTelegramReplyObligation).toHaveBeenCalledWith(
        expect.objectContaining({
          inboundMessageId: 'telegram-in-clear-1',
          satisfiedByMessageId: 'telegram-in-clear-1-reply',
          satisfactionSource: 'squidrun-app.route-telegram-reply',
          satisfaction: expect.objectContaining({
            reason: 'telegram_delivery_confirmed',
            chatId: '1111111111',
          }),
        }),
        expect.any(Object)
      );
      expect(app.pendingTelegramReplyGuards.has('1')).toBe(false);
      expect(app.inspectPaneOutputForReplyGuards('1', 'later pane output', {
        outputKind: 'agent_visible_output',
      })).toEqual(expect.objectContaining({
        ok: true,
        status: 'no_pending_guard',
      }));
    });

    it('clears pending Telegram reply debt from an acked hm-send Telegram journal row', () => {
      const sessionId = 'app-session-telegram-dedupe';
      const createdAtMs = Date.parse('2026-05-31T20:35:00.000Z');
      jest.useFakeTimers({ now: createdAtMs });
      try {
        app.commsSessionScopeId = sessionId;
        app.markPendingTelegramReplyGuard({
          paneId: '1',
          messageId: 'telegram-in-dedupe-1',
          chatId: '1111111111',
          sender: 'james',
          sessionScopeId: sessionId,
        });
        queryCommsJournalEntries.mockReturnValue([
          {
            messageId: 'hm-telegram-acked-1',
            sessionId,
            senderRole: 'architect',
            targetRole: 'user',
            channel: 'telegram',
            direction: 'outbound',
            sentAtMs: createdAtMs + 1000,
            status: 'acked',
            ackStatus: 'telegram_delivered',
            metadata: {
              directTarget: 'telegram',
              routeMethod: 'hm-send-telegram-direct',
              chatId: '1111111111',
              envelope: {
                session_id: sessionId,
                target: { raw: 'telegram', role: 'telegram' },
              },
            },
          },
        ]);

        const result = app.inspectPaneOutputForReplyGuards('1', 'later pane output after real Telegram ack', {
          outputKind: 'agent_visible_output',
        });

        expect(queryCommsJournalEntries).toHaveBeenCalledWith({
          sessionId,
          channel: 'telegram',
          direction: 'outbound',
          sinceMs: createdAtMs - 5000,
          order: 'asc',
          limit: 500,
        });
        expect(result).toEqual(expect.objectContaining({
          ok: true,
          status: 'telegram_reply_requirement_satisfied_by_journal',
          satisfaction: expect.objectContaining({
            inboundMessageId: 'telegram-in-dedupe-1',
            egressMessageId: 'hm-telegram-acked-1',
            chatId: '1111111111',
            sessionScopeId: sessionId,
            durableSatisfaction: expect.objectContaining({
              ok: true,
              status: 'satisfied',
            }),
          }),
        }));
        expect(satisfyTelegramReplyObligation).toHaveBeenCalledWith(
          expect.objectContaining({
            inboundMessageId: 'telegram-in-dedupe-1',
            satisfiedAtMs: createdAtMs + 1000,
            satisfiedByMessageId: 'hm-telegram-acked-1',
            satisfactionSource: 'squidrun-app.journal-reconcile',
            satisfaction: expect.objectContaining({
              reason: 'matched',
              chatId: '1111111111',
              sessionId,
            }),
          }),
          expect.any(Object)
        );
        expect(app.getPendingTelegramReplyRequirement('1')).toBeNull();
        expect(mockManagers.activity.logActivity).not.toHaveBeenCalledWith(
          'agent_response_debt',
          '1',
          expect.stringContaining('TELEGRAM REPLY REQUIREMENT UNRESOLVED'),
          expect.any(Object)
        );
      } finally {
        jest.useRealTimers();
      }
    });

    it('rebuilds a pending Telegram reply guard from durable state and satisfies it from journal egress', () => {
      const sessionId = 'app-session-telegram-restart-rebuild';
      const createdAtMs = Date.parse('2026-06-06T12:15:00.000Z');
      jest.useFakeTimers({ now: createdAtMs });
      try {
        app.commsSessionScopeId = sessionId;
        queryTelegramReplyObligations.mockReturnValue([
          {
            obligationId: 'telegram-reply-restart-rebuild-1',
            inboundMessageId: 'telegram-in-restart-rebuild-1',
            chatId: '1111111111',
            sessionId,
            paneId: '1',
            windowKey: 'main',
            profileName: 'main',
            senderRole: 'james',
            status: 'open',
            openedAtMs: createdAtMs - 20_000,
            deadlineAtMs: createdAtMs + 60_000,
          },
        ]);

        const hydration = app.hydratePendingTelegramReplyGuardsFromObligations({ nowMs: createdAtMs });
        expect(hydration).toEqual(expect.objectContaining({
          ok: true,
          status: 'telegram_reply_obligations_hydrated',
          hydratedCount: 1,
          autoEscalationSuppressedCount: 1,
        }));
        expect(app.getPendingTelegramReplyRequirement('1')).toEqual(expect.objectContaining({
          messageId: 'telegram-in-restart-rebuild-1',
          durableObligationId: 'telegram-reply-restart-rebuild-1',
          hydratedFromDurableObligation: true,
          autoEscalationSuppressed: true,
        }));

        queryCommsJournalEntries.mockReturnValue([
          {
            rowId: 67890,
            messageId: 'hm-telegram-restart-rebuild-egress-1',
            sessionId,
            senderRole: 'architect',
            targetRole: 'user',
            channel: 'telegram',
            direction: 'outbound',
            sentAtMs: createdAtMs + 1000,
            status: 'acked',
            ackStatus: 'telegram_delivered',
            metadata: {
              directTarget: 'telegram',
              chatId: '1111111111',
              replyToMessageId: 'telegram-in-restart-rebuild-1',
              envelope: {
                session_id: sessionId,
                target: { raw: 'telegram', role: 'telegram' },
              },
            },
          },
        ]);

        const result = app.reconcilePendingTelegramReplyGuardsWithJournal({
          reason: 'unit-test-restart-rebuild',
          logMisses: false,
        });

        expect(result).toEqual(expect.objectContaining({
          ok: true,
          status: 'telegram_reply_guards_reconciled_from_journal',
          reconciledCount: 1,
          pendingCount: 0,
          reconciled: [
            expect.objectContaining({
              inboundMessageId: 'telegram-in-restart-rebuild-1',
              egressMessageId: 'hm-telegram-restart-rebuild-egress-1',
              chatId: '1111111111',
              sessionScopeId: sessionId,
              durableSatisfaction: expect.objectContaining({
                ok: true,
                status: 'satisfied',
              }),
            }),
          ],
        }));
        expect(satisfyTelegramReplyObligation).toHaveBeenCalledWith(
          expect.objectContaining({
            inboundMessageId: 'telegram-in-restart-rebuild-1',
            satisfiedByMessageId: 'hm-telegram-restart-rebuild-egress-1',
            satisfiedByRowId: 67890,
            satisfactionSource: 'squidrun-app.journal-reconcile',
            satisfaction: expect.objectContaining({
              reason: 'matched',
              replyToMessageId: 'telegram-in-restart-rebuild-1',
            }),
          }),
          expect.any(Object)
        );
        expect(app.getPendingTelegramReplyRequirement('1')).toBeNull();
        expect(mockManagers.activity.logActivity).not.toHaveBeenCalledWith(
          'agent_response_debt',
          '1',
          expect.stringContaining('TELEGRAM REPLY REQUIREMENT UNRESOLVED'),
          expect.any(Object)
        );
      } finally {
        jest.useRealTimers();
      }
    });

    it('keeps rebuilt Telegram reply debt open when journal reconciliation query fails', () => {
      const sessionId = 'app-session-telegram-query-fail';
      const createdAtMs = Date.parse('2026-06-06T12:20:00.000Z');
      jest.useFakeTimers({ now: createdAtMs });
      try {
        app.commsSessionScopeId = sessionId;
        app.markPendingTelegramReplyGuard({
          paneId: '1',
          messageId: 'telegram-in-query-fail-1',
          chatId: '1111111111',
          sender: 'james',
          sessionScopeId: sessionId,
          persistDurable: false,
        });
        queryCommsJournalEntries.mockImplementation(() => {
          throw new Error('ledger temporarily unavailable');
        });

        const result = app.reconcilePendingTelegramReplyGuardsWithJournal({
          reason: 'unit-test-query-failure',
          logMisses: true,
        });

        expect(result).toEqual(expect.objectContaining({
          ok: true,
          status: 'telegram_reply_guards_checked_from_journal',
          reconciledCount: 0,
          pendingCount: 1,
          nonTerminalPendingCount: 1,
        }));
        expect(app.getPendingTelegramReplyRequirement('1')).toEqual(expect.objectContaining({
          messageId: 'telegram-in-query-fail-1',
          status: 'pending_telegram_egress',
          lastJournalReconcileReason: 'query_failed',
          lastJournalReconcileCandidateRowCount: 0,
        }));
        expect(satisfyTelegramReplyObligation).not.toHaveBeenCalled();
        expect(mockManagers.activity.logActivity).not.toHaveBeenCalledWith(
          'agent_response_debt',
          '1',
          expect.stringContaining('TELEGRAM REPLY REQUIREMENT UNRESOLVED'),
          expect.any(Object)
        );
      } finally {
        jest.useRealTimers();
      }
    });

    it('credits delivered target=user Telegram egress rows against pending reply debt', () => {
      const sessionId = 'app-session-telegram-target-user-row';
      const createdAtMs = Date.parse('2026-06-02T10:53:00.000Z');
      jest.useFakeTimers({ now: createdAtMs });
      try {
        app.commsSessionScopeId = sessionId;
        app.markPendingTelegramReplyGuard({
          paneId: '1',
          messageId: 'telegram-in-target-user-1',
          chatId: '1111111111',
          sender: 'james',
          sessionScopeId: sessionId,
        });
        queryCommsJournalEntries.mockReturnValue([
          {
            messageId: 'hm-telegram-target-user-1',
            sessionId,
            senderRole: 'architect',
            targetRole: 'user',
            channel: 'telegram',
            direction: 'outbound',
            sentAtMs: createdAtMs + 1000,
            status: 'acked',
            ackStatus: 'telegram_delivered',
            metadata: {
              chatId: '1111111111',
            },
          },
        ]);

        const result = app.reconcilePendingTelegramReplyGuardsWithJournal({
          reason: 'unit-test',
          logMisses: false,
        });

        expect(result).toEqual(expect.objectContaining({
          ok: true,
          status: 'telegram_reply_guards_reconciled_from_journal',
          reconciledCount: 1,
          pendingCount: 0,
          reconciled: [
            expect.objectContaining({
              inboundMessageId: 'telegram-in-target-user-1',
              egressMessageId: 'hm-telegram-target-user-1',
              chatId: '1111111111',
              sessionScopeId: sessionId,
            }),
          ],
        }));
        expect(app.getPendingTelegramReplyRequirement('1')).toBeNull();
      } finally {
        jest.useRealTimers();
      }
    });

    it('credits the raw delivered hm-send telegram row shape from session 399', () => {
      const sessionId = 'app-session-399';
      const guardCreatedAtMs = 1780422913433;
      jest.useFakeTimers({ now: guardCreatedAtMs });
      try {
        app.commsSessionScopeId = sessionId;
        app.markPendingTelegramReplyGuard({
          paneId: '1',
          messageId: 'telegram-in-808498637',
          chatId: '5613428850',
          sender: 'james',
          sessionScopeId: sessionId,
        });
        queryCommsJournalEntries.mockReturnValue([
          {
            rowId: 67315,
            messageId: 'hm-1780422928508-4rxl3m',
            sessionId,
            senderRole: 'architect',
            targetRole: 'user',
            channel: 'telegram',
            direction: 'outbound',
            sentAtMs: 1780422928536,
            brokeredAtMs: null,
            rawBody: 'Quiet and clean.',
            status: 'acked',
            ackStatus: 'telegram_delivered',
            attempt: 1,
            metadata: {
              envelope_version: 'hm-envelope-v1',
              envelope: {
                version: 'hm-envelope-v1',
                message_id: 'hm-1780422928508-4rxl3m',
                timestamp_ms: 1780422928535,
                sent_at: '2026-06-02T17:55:28.535Z',
                session_id: sessionId,
                sender: { role: 'architect' },
                target: { raw: 'telegram', role: 'telegram', pane_id: null },
              },
              session_id: sessionId,
              sender: { role: 'architect' },
              target: { raw: 'telegram', role: 'telegram', pane_id: null },
              directTarget: 'telegram',
              routeMethod: 'hm-send-telegram-direct',
              source: 'hm-telegram',
              mode: 'message',
              telegramMessageId: 20581,
              chatId: 5613428850,
            },
            updatedAtMs: 1780422929186,
          },
        ]);

        const result = app.reconcilePendingTelegramReplyGuardsWithJournal({
          reason: 'unit-test-raw-session-399-row',
          logMisses: false,
        });

        expect(queryCommsJournalEntries).toHaveBeenCalledWith({
          sessionId,
          channel: 'telegram',
          direction: 'outbound',
          sinceMs: guardCreatedAtMs - 5000,
          order: 'asc',
          limit: 500,
        });
        expect(result).toEqual(expect.objectContaining({
          ok: true,
          status: 'telegram_reply_guards_reconciled_from_journal',
          reconciledCount: 1,
          pendingCount: 0,
          reconciled: [
            expect.objectContaining({
              inboundMessageId: 'telegram-in-808498637',
              egressMessageId: 'hm-1780422928508-4rxl3m',
              chatId: '5613428850',
              sessionScopeId: sessionId,
            }),
          ],
        }));
        expect(app.getPendingTelegramReplyRequirement('1')).toBeNull();
      } finally {
        jest.useRealTimers();
      }
    });

    it('credits same-chat delivered Telegram egress from the session 400 rapid-burst shape', () => {
      const sessionId = 'app-session-400';
      const guardCreatedAtMs = 1780431576869;
      jest.useFakeTimers({ now: guardCreatedAtMs });
      try {
        app.commsSessionScopeId = sessionId;
        app.markPendingTelegramReplyGuard({
          paneId: '1',
          messageId: 'telegram-in-808498646',
          chatId: '5613428850',
          sender: 'james',
          sessionScopeId: sessionId,
        });
        queryCommsJournalEntries.mockReturnValue([
          {
            rowId: 67373,
            messageId: 'hm-1780431576782-bst8n4',
            sessionId,
            senderRole: 'architect',
            targetRole: 'user',
            channel: 'telegram',
            direction: 'outbound',
            sentAtMs: 1780431576810,
            rawBody: 'You are putting your finger right on the gap.',
            status: 'acked',
            ackStatus: 'telegram_delivered',
            metadata: {
              directTarget: 'telegram',
              telegramMessageId: 20598,
              replyToMessageId: 'telegram-in-808498645',
              inboundMessageId: 'telegram-in-808498645',
              chatId: 5613428850,
              source: 'hm-telegram',
              envelope: {
                session_id: sessionId,
                target: { raw: 'telegram', role: 'telegram', pane_id: null },
              },
            },
            updatedAtMs: 1780431577469,
          },
        ]);

        const result = app.inspectPaneOutputForReplyGuards('1', 'pane output after rapid Telegram burst', {
          outputKind: 'agent_visible_output',
        });

        expect(queryCommsJournalEntries).toHaveBeenCalledWith({
          sessionId,
          channel: 'telegram',
          direction: 'outbound',
          sinceMs: guardCreatedAtMs - 5000,
          order: 'asc',
          limit: 500,
        });
        expect(result).toEqual(expect.objectContaining({
          ok: true,
          status: 'telegram_reply_requirement_satisfied_by_journal',
          guard: null,
          satisfaction: expect.objectContaining({
            inboundMessageId: 'telegram-in-808498646',
            egressMessageId: 'hm-1780431576782-bst8n4',
            chatId: '5613428850',
            sessionScopeId: sessionId,
          }),
        }));
        expect(app.getPendingTelegramReplyRequirement('1')).toBeNull();
        expect(mockManagers.activity.logActivity).not.toHaveBeenCalledWith(
          'agent_response_debt',
          '1',
          expect.stringContaining('TELEGRAM REPLY REQUIREMENT UNRESOLVED'),
          expect.any(Object)
        );
      } finally {
        jest.useRealTimers();
      }
    });

    it('reconciles a pending Telegram guard with an injected matching journal query', () => {
      const sessionId = 'app-session-telegram-injected-query';
      const createdAtMs = Date.parse('2026-05-31T20:35:30.000Z');
      const queryFn = jest.fn(() => [
        {
          messageId: 'hm-telegram-injected-query-1',
          sessionId,
          senderRole: 'architect',
          targetRole: 'user',
          channel: 'telegram',
          direction: 'outbound',
          sentAtMs: createdAtMs + 1000,
          status: 'acked',
          ackStatus: 'telegram_delivered',
          metadata: {
            directTarget: 'telegram',
            chatId: '1111111111',
            envelope: {
              session_id: sessionId,
              target: { raw: 'telegram', role: 'telegram' },
            },
          },
        },
      ]);
      jest.useFakeTimers({ now: createdAtMs });
      try {
        app.markPendingTelegramReplyGuard({
          paneId: '1',
          messageId: 'telegram-in-injected-query-1',
          chatId: '1111111111',
          sender: 'james',
          sessionScopeId: sessionId,
        });

        const result = app.reconcilePendingTelegramReplyGuardsWithJournal({
          queryCommsJournalEntries: queryFn,
          reason: 'unit-test',
          logMisses: false,
        });

        expect(queryFn).toHaveBeenCalledWith({
          sessionId,
          channel: 'telegram',
          direction: 'outbound',
          sinceMs: createdAtMs - 5000,
          order: 'asc',
          limit: 500,
        });
        expect(result).toEqual(expect.objectContaining({
          ok: true,
          status: 'telegram_reply_guards_reconciled_from_journal',
          reconciledCount: 1,
          pendingCount: 0,
          reconciled: [
            expect.objectContaining({
              inboundMessageId: 'telegram-in-injected-query-1',
              egressMessageId: 'hm-telegram-injected-query-1',
              chatId: '1111111111',
              sessionScopeId: sessionId,
            }),
          ],
        }));
        expect(app.getPendingTelegramReplyRequirement('1')).toBeNull();
      } finally {
        jest.useRealTimers();
      }
    });

    it('reconciles a pending Telegram guard without a guard chat id when the journal row has one', () => {
      const sessionId = 'app-session-telegram-null-guard-chat';
      const createdAtMs = Date.parse('2026-05-31T20:35:45.000Z');
      const queryFn = jest.fn(() => [
        {
          messageId: 'hm-telegram-null-guard-chat-1',
          sessionId,
          senderRole: 'architect',
          targetRole: 'user',
          channel: 'telegram',
          direction: 'outbound',
          sentAtMs: createdAtMs + 1000,
          status: 'acked',
          ackStatus: 'telegram_delivered',
          metadata: {
            directTarget: 'telegram',
            chatId: '1111111111',
            envelope: {
              session_id: sessionId,
              target: { raw: 'telegram', role: 'telegram' },
            },
          },
        },
      ]);
      jest.useFakeTimers({ now: createdAtMs });
      try {
        app.markPendingTelegramReplyGuard({
          paneId: '1',
          messageId: 'telegram-in-null-guard-chat-1',
          sender: 'james',
          sessionScopeId: sessionId,
        });

        const result = app.reconcilePendingTelegramReplyGuardsWithJournal({
          queryCommsJournalEntries: queryFn,
          reason: 'unit-test',
          logMisses: false,
        });

        expect(result).toEqual(expect.objectContaining({
          ok: true,
          status: 'telegram_reply_guards_reconciled_from_journal',
          reconciledCount: 1,
          pendingCount: 0,
        }));
        expect(app.getPendingTelegramReplyRequirement('1')).toBeNull();
      } finally {
        jest.useRealTimers();
      }
    });

    it('periodically clears pending Telegram reply debt from an hm-send journal row without pane output', () => {
      const sessionId = 'app-session-telegram-periodic-reconcile';
      const createdAtMs = Date.parse('2026-05-31T20:35:55.000Z');
      jest.useFakeTimers({ now: createdAtMs });
      try {
        app.markPendingTelegramReplyGuard({
          paneId: '1',
          messageId: 'telegram-in-periodic-reconcile-1',
          chatId: '1111111111',
          sender: 'james',
          sessionScopeId: sessionId,
        });
        queryCommsJournalEntries.mockReturnValue([
          {
            messageId: 'hm-telegram-periodic-reconcile-1',
            sessionId,
            senderRole: 'architect',
            targetRole: 'user',
            channel: 'telegram',
            direction: 'outbound',
            sentAtMs: createdAtMs + 1000,
            status: 'acked',
            ackStatus: 'telegram_delivered',
            metadata: {
              directTarget: 'telegram',
              chatId: '1111111111',
              envelope: {
                session_id: sessionId,
                target: { raw: 'telegram', role: 'telegram' },
              },
            },
          },
        ]);

        jest.advanceTimersByTime(5000);

        expect(queryCommsJournalEntries).toHaveBeenCalledWith({
          sessionId,
          channel: 'telegram',
          direction: 'outbound',
          sinceMs: createdAtMs - 5000,
          order: 'asc',
          limit: 500,
        });
        expect(app.getPendingTelegramReplyRequirement('1')).toBeNull();
        expect(mockManagers.activity.logActivity).not.toHaveBeenCalledWith(
          'agent_response_debt',
          '1',
          expect.stringContaining('TELEGRAM REPLY REQUIREMENT UNRESOLVED'),
          expect.any(Object)
        );
      } finally {
        jest.useRealTimers();
      }
    });

    it('keeps reply debt unresolved when the acked Telegram journal row is for another chat', () => {
      const sessionId = 'app-session-telegram-cross-chat';
      const createdAtMs = Date.parse('2026-05-31T20:36:00.000Z');
      jest.useFakeTimers({ now: createdAtMs });
      try {
        app.commsSessionScopeId = sessionId;
        app.markPendingTelegramReplyGuard({
          paneId: '1',
          messageId: 'telegram-in-cross-chat-1',
          chatId: '1111111111',
          sender: 'james',
          sessionScopeId: sessionId,
        });
        queryCommsJournalEntries.mockReturnValue([
          {
            messageId: 'hm-telegram-other-chat',
            sessionId,
            senderRole: 'architect',
            targetRole: 'user',
            channel: 'telegram',
            direction: 'outbound',
            sentAtMs: createdAtMs + 1000,
            status: 'acked',
            ackStatus: 'telegram_delivered',
            metadata: {
              directTarget: 'telegram',
              chatId: '2222222222',
              envelope: {
                session_id: sessionId,
                target: { raw: 'telegram', role: 'telegram' },
              },
            },
          },
        ]);

        const result = app.inspectPaneOutputForReplyGuards('1', 'pane-only answer still owes Telegram', {
          outputKind: 'agent_visible_output',
        });

        expect(result).toEqual(expect.objectContaining({
          ok: false,
          status: 'telegram_reply_requirement_unresolved',
          guard: expect.objectContaining({
            messageId: 'telegram-in-cross-chat-1',
            status: 'telegram_reply_required_unresolved',
          }),
        }));
        expect(app.getPendingTelegramReplyRequirement('1')).toEqual(expect.objectContaining({
          messageId: 'telegram-in-cross-chat-1',
        }));
        expect(mockManagers.activity.logActivity).toHaveBeenCalledWith(
          'agent_response_debt',
          '1',
          expect.stringContaining('TELEGRAM REPLY REQUIREMENT UNRESOLVED'),
          expect.objectContaining({
            source: 'telegram-reply-requirement',
            reason: 'pane_output_without_telegram_egress',
          })
        );
      } finally {
        jest.useRealTimers();
      }
    });

    it('keeps reply debt unresolved when the acked Telegram journal row predates the inbound guard', () => {
      const sessionId = 'app-session-telegram-pre-inbound';
      const createdAtMs = Date.parse('2026-05-31T20:37:00.000Z');
      jest.useFakeTimers({ now: createdAtMs });
      try {
        app.commsSessionScopeId = sessionId;
        app.markPendingTelegramReplyGuard({
          paneId: '1',
          messageId: 'telegram-in-pre-inbound-1',
          chatId: '1111111111',
          sender: 'james',
          sessionScopeId: sessionId,
        });
        queryCommsJournalEntries.mockReturnValue([
          {
            messageId: 'hm-telegram-before-inbound',
            sessionId,
            senderRole: 'architect',
            targetRole: 'user',
            channel: 'telegram',
            direction: 'outbound',
            sentAtMs: createdAtMs - 6000,
            status: 'acked',
            ackStatus: 'telegram_delivered',
            metadata: {
              directTarget: 'telegram',
              chatId: '1111111111',
              envelope: {
                session_id: sessionId,
                target: { raw: 'telegram', role: 'telegram' },
              },
            },
          },
        ]);

        const result = app.inspectPaneOutputForReplyGuards('1', 'fresh inbound still needs an answer', {
          outputKind: 'agent_visible_output',
        });

        expect(result).toEqual(expect.objectContaining({
          ok: false,
          status: 'telegram_reply_requirement_unresolved',
          guard: expect.objectContaining({
            messageId: 'telegram-in-pre-inbound-1',
            status: 'telegram_reply_required_unresolved',
          }),
        }));
        expect(app.getPendingTelegramReplyRequirement('1')).toEqual(expect.objectContaining({
          messageId: 'telegram-in-pre-inbound-1',
        }));
      } finally {
        jest.useRealTimers();
      }
    });

    it('clears reply debt when a same-chat delivered Telegram row is tied to an adjacent inbound', () => {
      const sessionId = 'app-session-telegram-cross-inbound';
      const createdAtMs = Date.parse('2026-05-31T20:38:00.000Z');
      jest.useFakeTimers({ now: createdAtMs });
      try {
        app.commsSessionScopeId = sessionId;
        app.markPendingTelegramReplyGuard({
          paneId: '1',
          messageId: 'telegram-in-current-1',
          chatId: '1111111111',
          sender: 'james',
          sessionScopeId: sessionId,
        });
        queryCommsJournalEntries.mockReturnValue([
          {
            messageId: 'hm-telegram-other-inbound',
            sessionId,
            senderRole: 'architect',
            targetRole: 'user',
            channel: 'telegram',
            direction: 'outbound',
            sentAtMs: createdAtMs + 1000,
            status: 'acked',
            ackStatus: 'telegram_delivered',
            metadata: {
              directTarget: 'telegram',
              replyToMessageId: 'telegram-in-previous-1',
              chatId: '1111111111',
              envelope: {
                session_id: sessionId,
                target: { raw: 'telegram', role: 'telegram' },
              },
            },
          },
        ]);

        const result = app.inspectPaneOutputForReplyGuards('1', 'current inbound was answered on Telegram', {
          outputKind: 'agent_visible_output',
        });

        expect(result).toEqual(expect.objectContaining({
          ok: true,
          status: 'telegram_reply_requirement_satisfied_by_journal',
          guard: null,
          satisfaction: expect.objectContaining({
            inboundMessageId: 'telegram-in-current-1',
            egressMessageId: 'hm-telegram-other-inbound',
            chatId: '1111111111',
          }),
        }));
        expect(app.getPendingTelegramReplyRequirement('1')).toBeNull();
      } finally {
        jest.useRealTimers();
      }
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

    it('resolves accepted-unverified Telegram pending state without replaying it', async () => {
      const triggers = require('../modules/triggers');
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-pending-resolved-'));
      const queuePath = path.join(tempRoot, 'pending-pane-deliveries.json');
      jest.spyOn(app, 'getPendingPaneDeliveryQueuePath').mockReturnValue(queuePath);
      jest.spyOn(app, 'recordPendingPaneDeliveryDrop').mockImplementation(() => {});
      app.commsSessionScopeId = 'app-session-147';
      fs.writeFileSync(queuePath, JSON.stringify({
        items: [
          {
            queueKey: 'telegram-in-123',
            paneId: '1',
            message: '[Telegram from scoped]: hello',
            messageId: 'telegram-in-123',
            channel: 'telegram',
            sender: 'scoped',
            createdAt: '2026-05-16T07:26:50.776Z',
            lastFailureReason: 'routed_unverified_timeout',
            attemptCount: 1,
            meta: {
              updateId: 123,
              windowKey: 'main',
              sessionScopeId: 'app-session-147',
            },
          },
        ],
      }));

      try {
        const result = await app.flushPendingPaneDeliveries({ paneId: '1', reason: 'test-resolve' });

        expect(triggers.sendDirectMessage).not.toHaveBeenCalled();
        expect(result).toEqual(expect.objectContaining({
          ok: true,
          deliveredCount: 0,
          droppedCount: 0,
          resolvedCount: 1,
          remainingCount: 0,
        }));
        expect(app.recordPendingPaneDeliveryDrop).toHaveBeenCalledWith(
          expect.objectContaining({ queueKey: 'telegram-in-123' }),
          expect.objectContaining({
            reason: 'accepted_unverified_telegram_delivery_resolved',
            resolved: true,
            lastFailureReason: 'routed_unverified_timeout',
          })
        );
        const persisted = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
        expect(persisted.items).toEqual([]);
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    });

    it('drops prior-session Telegram pending deliveries instead of flushing them into the current session', async () => {
      const triggers = require('../modules/triggers');
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-pending-stale-session-'));
      const queuePath = path.join(tempRoot, 'pending-pane-deliveries.json');
      jest.spyOn(app, 'getPendingPaneDeliveryQueuePath').mockReturnValue(queuePath);
      jest.spyOn(app, 'recordPendingPaneDeliveryDrop').mockImplementation(() => {});
      app.commsSessionScopeId = 'app-session-330';
      fs.writeFileSync(queuePath, JSON.stringify({
        items: [
          {
            queueKey: 'telegram-in-808497185',
            paneId: '1',
            message: '[Telegram from @jaymz6435]: stale Tony Lu task',
            messageId: 'telegram-in-808497185',
            channel: 'telegram',
            sender: '@jaymz6435',
            createdAt: '2026-05-08T00:45:48.915Z',
            attemptCount: 3,
            meta: {
              updateId: 808497185,
              messageId: 17488,
              windowKey: 'main',
              sessionScopeId: 'app-session-329',
              media: {
                kind: 'photo',
                fileId: 'photo-file-id',
              },
            },
          },
        ],
      }));

      try {
        const result = await app.flushPendingPaneDeliveries({ paneId: '1', reason: 'startup-replay' });

        expect(triggers.sendDirectMessage).not.toHaveBeenCalled();
        expect(result).toEqual(expect.objectContaining({
          ok: true,
          deliveredCount: 0,
          droppedCount: 1,
          remainingCount: 0,
        }));
        expect(app.recordPendingPaneDeliveryDrop).toHaveBeenCalledWith(
          expect.objectContaining({ queueKey: 'telegram-in-808497185' }),
          expect.objectContaining({
            reason: 'stale_telegram_pending_session_scope',
            expectedSessionScopeId: 'app-session-330',
            itemSessionScopeId: 'app-session-329',
          })
        );
        const persisted = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
        expect(persisted.items).toEqual([]);
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    });

    it('drops old Telegram pending deliveries without session metadata before startup replay', async () => {
      const triggers = require('../modules/triggers');
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-pending-stale-age-'));
      const queuePath = path.join(tempRoot, 'pending-pane-deliveries.json');
      jest.spyOn(app, 'getPendingPaneDeliveryQueuePath').mockReturnValue(queuePath);
      jest.spyOn(app, 'recordPendingPaneDeliveryDrop').mockImplementation(() => {});
      mockManagers.settings.readAppStatus.mockReturnValue({
        session: 330,
        started: '2026-05-08T04:00:00.000Z',
      });
      fs.writeFileSync(queuePath, JSON.stringify({
        items: [
          {
            queueKey: 'telegram-in-no-scope',
            paneId: '1',
            message: '[Telegram from @jaymz6435]: stale no-scope task',
            messageId: 'telegram-in-no-scope',
            channel: 'telegram',
            sender: '@jaymz6435',
            createdAt: '2026-05-08T03:00:00.000Z',
            attemptCount: 1,
            meta: {
              updateId: 808497100,
              windowKey: 'main',
            },
          },
        ],
      }));

      try {
        const result = await app.flushPendingPaneDeliveries({ paneId: '1', reason: 'startup-replay' });

        expect(triggers.sendDirectMessage).not.toHaveBeenCalled();
        expect(result).toEqual(expect.objectContaining({
          deliveredCount: 0,
          droppedCount: 1,
          remainingCount: 0,
        }));
        expect(app.recordPendingPaneDeliveryDrop).toHaveBeenCalledWith(
          expect.objectContaining({ queueKey: 'telegram-in-no-scope' }),
          expect.objectContaining({
            reason: 'stale_telegram_pending_before_current_start',
          })
        );
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
            windowKey: 'main',
            profile: 'main',
            chatId: null,
            telegramChatId: null,
            sessionScopeId: expect.any(String),
          }),
        })
      );
      expect(result).toEqual(
        expect.objectContaining({
          handled: true,
          ok: true,
          status: 'telegram_delivered',
          routeMethod: 'hm-send-telegram',
          windowKey: 'main',
          profile: 'main',
          sessionScopeId: expect.any(String),
        })
      );
    });

    it('fails closed for user target when inherited reply context belongs to a scoped profile', async () => {
      const { sendRoutedTelegramMessage } = require('../scripts/hm-telegram-routing');
      app.telegramInboundContext = {
        sender: '@Eunbyeol',
        lastInboundAtMs: Date.now(),
        chatId: '4444444444',
        windowKey: 'eunbyeol',
        profile: 'eunbyeol',
        sessionScopeId: 'app-test:eunbyeol',
      };

      const result = await app.routeTelegramReply({
        target: 'user',
        content: 'Build passed.',
        messageId: 'telegram-route-cross-profile-context',
      });

      expect(sendRoutedTelegramMessage).not.toHaveBeenCalled();
      expect(result).toEqual(
        expect.objectContaining({
          handled: true,
          ok: false,
          status: 'telegram_privacy_route_cross_profile_context',
          windowKey: 'eunbyeol',
          profile: 'eunbyeol',
          chatId: '4444444444',
          sessionScopeId: 'app-test:eunbyeol',
        })
      );
    });

    it('fails closed for user target when the reply chat route resolves outside main', async () => {
      const { sendRoutedTelegramMessage } = require('../scripts/hm-telegram-routing');
      app.telegramInboundContext = {
        sender: 'james',
        lastInboundAtMs: Date.now(),
        chatId: '4444444444',
        windowKey: 'main',
        profile: 'main',
        sessionScopeId: 'app-test:main',
      };

      const result = await app.routeTelegramReply({
        target: 'user',
        content: 'Build passed.',
        messageId: 'telegram-route-cross-profile-chat',
      });

      expect(sendRoutedTelegramMessage).not.toHaveBeenCalled();
      expect(result).toEqual(
        expect.objectContaining({
          handled: true,
          ok: false,
          status: 'telegram_privacy_route_cross_profile_context',
          windowKey: 'eunbyeol',
          profile: 'eunbyeol',
          chatId: '4444444444',
          sessionScopeId: expect.stringContaining(':eunbyeol'),
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
        windowKey: 'scoped',
        profile: 'scoped',
        sessionScopeId: 'app-test:scoped',
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
            windowKey: 'main',
            profile: 'main',
            chatId: null,
            telegramChatId: null,
            sessionScopeId: expect.any(String),
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
          metadata: expect.objectContaining({
            routeKind: 'telegram',
            targetRaw: 'telegram',
            windowKey: 'scoped',
            profile: 'scoped',
            chatId: '2222222222',
            telegramChatId: '2222222222',
            sessionScopeId: expect.stringContaining(':scoped'),
          }),
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
