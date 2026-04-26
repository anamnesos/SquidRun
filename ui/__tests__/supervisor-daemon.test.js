const watcherRecords = [];
const hyperliquidClient = require('../modules/trading/hyperliquid-client');

jest.mock('chokidar', () => ({
  watch: jest.fn((targets) => {
    const watcher = {
      targets,
      handlers: {},
      on: jest.fn((event, handler) => {
        watcher.handlers[event] = handler;
        return watcher;
      }),
      close: jest.fn().mockResolvedValue(),
    };
    watcherRecords.push(watcher);
    return watcher;
  }),
}));

jest.mock('../modules/memory-search', () => ({
  MemorySearchIndex: jest.fn(),
  resolveWorkspacePaths: jest.fn(() => ({
    knowledgeDir: '/tmp/knowledge',
    handoffPath: '/tmp/handoffs/session.md',
    caseEvidenceDirs: ['/tmp/cases/Korean Fraud/evidence'],
  })),
}));

jest.mock('../modules/cognitive-memory-sleep', () => ({
  SleepConsolidator: jest.fn(),
  DEFAULT_IDLE_THRESHOLD_MS: 1800000,
  DEFAULT_MIN_INTERVAL_MS: 300000,
  resolveSessionStatePath: jest.fn(() => '/tmp/session-state.json'),
}));

jest.mock('../modules/memory-consistency-check', () => ({
  runMemoryConsistencyCheck: jest.fn(() => ({
    ok: true,
    checkedAt: '2026-03-15T00:00:00.000Z',
    status: 'in_sync',
    synced: true,
    summary: {
      knowledgeEntryCount: 15,
      knowledgeNodeCount: 15,
      missingInCognitiveCount: 0,
      orphanedNodeCount: 0,
      duplicateKnowledgeHashCount: 0,
      issueCount: 0,
    },
  })),
}));

jest.mock('../modules/cognitive-memory-immunity', () => ({
  stageImmediateTaskExtraction: jest.fn(async () => ({ ok: true })),
}));

jest.mock('../modules/local-model-capabilities', () => ({
  readSystemCapabilitiesSnapshot: jest.fn(() => ({
    localModels: {
      enabled: true,
      sleepExtraction: {
        enabled: true,
        available: true,
        model: 'claude-opus-4-6',
        path: 'anthropic-api',
        command: '"node" "claude-extract.js" --model "claude-opus-4-6"',
      },
    },
  })),
  resolveSleepExtractionCommandFromSnapshot: jest.fn((snapshot) => snapshot?.localModels?.sleepExtraction?.command || ''),
}));

jest.mock('../modules/trading/hyperliquid-client', () => ({
  getAccountSnapshot: jest.fn().mockResolvedValue({}),
  getOpenPositions: jest.fn().mockResolvedValue([]),
  getSnapshots: jest.fn().mockResolvedValue(new Map()),
  getLatestBars: jest.fn().mockResolvedValue(new Map()),
  getHistoricalBars: jest.fn().mockResolvedValue(new Map()),
  getUniverseMarketData: jest.fn().mockResolvedValue([]),
}));

jest.mock('../modules/trading/spark-capture', () => ({
  DEFAULT_SPARK_STATE_PATH: '/tmp/spark-state.json',
  DEFAULT_SPARK_EVENTS_PATH: '/tmp/spark-events.jsonl',
  DEFAULT_SPARK_FIREPLANS_PATH: '/tmp/spark-fireplans.json',
  DEFAULT_SPARK_WATCHLIST_PATH: '/tmp/spark-watchlist.json',
  runSparkScan: jest.fn().mockResolvedValue({
    ok: true,
    scannedAt: '2026-04-23T09:00:00.000Z',
    upbitListingCount: 1,
    hyperliquidListingCount: 0,
    tokenUnlockCount: 1,
    newAlertEvents: [],
    firePlans: [],
    alertMessage: '',
  }),
}));

jest.mock('../modules/trading/hyperliquid-native-layer', () => ({
  buildNativeFeatureBundle: jest.fn().mockResolvedValue({
    ok: true,
    symbols: {},
  }),
}));

jest.mock('../modules/trading/prediction-tracker', () => ({
  logPrediction: jest.fn(),
  scorePredictions: jest.fn(() => 0),
  tagMiss: jest.fn(),
  getAccuracy: jest.fn(() => ({ total: 0, correct: 0, wrong: 0, skipped: 0, accuracy: 0, topMissReasons: [] })),
  macroHeader: jest.fn(() => 'macro-header'),
  checkOilPrice: jest.fn((currentOilPrice) => ({
    currentPrice: currentOilPrice,
    prevPrice: currentOilPrice - 1,
    delta: 1,
    alert: false,
  })),
  eventHeader: jest.fn(() => 'Next macro: None in 24h\nNext crypto catalyst: None flagged\nGeopolitical watch: None active'),
  getEventWatch: jest.fn(() => ({ nextMacro: null, nextCrypto: null, geopoliticalWatch: [], updatedAt: null })),
  setEventWatch: jest.fn(),
  PREDICTIONS_FILE: '/tmp/prediction-log.json',
}));

const chokidar = require('chokidar');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runMemoryConsistencyCheck } = require('../modules/memory-consistency-check');
const sparkCapture = require('../modules/trading/spark-capture');
const executor = require('../modules/trading/executor');
const macroRiskGate = require('../modules/trading/macro-risk-gate');
const tradingWatchlist = require('../modules/trading/watchlist');
const dynamicWatchlist = require('../modules/trading/dynamic-watchlist');
const hyperliquidNativeLayer = require('../modules/trading/hyperliquid-native-layer');
const predictionTracker = require('../modules/trading/prediction-tracker');
const { SupervisorDaemon, resolveProjectUiScriptPath } = require('../supervisor-daemon');

function createMockStore() {
  return {
    dbPath: '/tmp/supervisor.sqlite',
    init: jest.fn(() => ({ ok: true })),
    isAvailable: jest.fn(() => true),
    getStatus: jest.fn(() => ({ ok: true, driver: 'mock' })),
    getTaskCounts: jest.fn(() => ({ pending: 0, running: 0, complete: 0, failed: 0 })),
    requeueExpiredTasks: jest.fn(() => ({ ok: true })),
    pruneExpiredPendingTasks: jest.fn(() => ({ ok: true, pruned: 0, taskIds: [], tasks: [] })),
    claimNextTask: jest.fn(() => ({ ok: true, task: null })),
    close: jest.fn(),
  };
}

function createMockLogger() {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

function buildOrdiPatternBars() {
  const bars1h = Array.from({ length: 30 }, (_, index) => ({
    open: 1 + (index * 0.01),
    high: 1.08 + (index * 0.012),
    low: 0.98 + (index * 0.008),
    close: 1.02 + (index * 0.009),
  }));
  bars1h[12] = {
    open: 1.48,
    high: 1.5,
    low: 1.34,
    close: 1.39,
  };
  const bars5m = [
    { open: 1.34, high: 1.36, low: 1.31, close: 1.32 },
    { open: 1.32, high: 1.34, low: 1.29, close: 1.29 },
    { open: 1.29, high: 1.3, low: 1.25, close: 1.26 },
    { open: 1.26, high: 1.27, low: 1.22, close: 1.23 },
    { open: 1.23, high: 1.24, low: 1.2, close: 1.21 },
  ];
  const bars15m = [
    { open: 1.38, high: 1.4, low: 1.33, close: 1.35 },
    { open: 1.35, high: 1.36, low: 1.3, close: 1.31 },
    { open: 1.31, high: 1.32, low: 1.26, close: 1.27 },
    { open: 1.27, high: 1.28, low: 1.22, close: 1.23 },
    { open: 1.23, high: 1.24, low: 1.2, close: 1.21 },
  ];
  return { bars1h, bars5m, bars15m };
}

function mockOrdiPatternBars(ticker = 'ORDI/USD') {
  const bars = buildOrdiPatternBars();
  hyperliquidClient.getHistoricalBars.mockImplementation(async ({ timeframe }) => {
    const selected = timeframe === '5m'
      ? bars.bars5m
      : (timeframe === '15m' ? bars.bars15m : bars.bars1h);
    return new Map([[ticker, selected]]);
  });
}

function getWatcherByTarget(pattern) {
  return watcherRecords.find((watcher) => {
    const targets = Array.isArray(watcher.targets) ? watcher.targets : [watcher.targets];
    return targets.some((target) => String(target) === String(pattern));
  });
}

describe('supervisor-daemon integrations', () => {
  let mockMemorySearchIndex;
  let mockSleepConsolidator;
  let mockLeaseJanitor;
  let daemon;
  let tempRoot;
  let originalMarketScannerAutomation;

  beforeEach(() => {
    jest.useFakeTimers();
    watcherRecords.length = 0;
    hyperliquidClient.getOpenPositions.mockReset();
    hyperliquidClient.getOpenPositions.mockResolvedValue([]);
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-supervisor-test-'));
    originalMarketScannerAutomation = process.env.SQUIDRUN_MARKET_SCANNER_AUTOMATION;
    process.env.SQUIDRUN_MARKET_SCANNER_AUTOMATION = '0';

    mockMemorySearchIndex = {
      indexAll: jest.fn().mockResolvedValue({
        indexedGroups: 1,
        skippedGroups: 0,
        status: { document_count: 3 },
      }),
      close: jest.fn(),
    };

    mockSleepConsolidator = {
      init: jest.fn(() => ({ ok: true })),
      shouldRun: jest.fn(() => ({ ok: false, reason: 'not_idle', activity: { idleMs: 1000, isIdle: false } })),
      runOnce: jest.fn().mockResolvedValue({ ok: true, episodeCount: 2, extractedCount: 2, generatedPrCount: 1 }),
      readActivitySnapshot: jest.fn(() => ({ idleMs: 1000, isIdle: false })),
      close: jest.fn(),
    };

    mockLeaseJanitor = {
      pruneExpiredLeases: jest.fn(() => ({ ok: true, pruned: 0 })),
      close: jest.fn(),
    };

    daemon = new SupervisorDaemon({
      store: createMockStore(),
      logger: createMockLogger(),
      memoryIndexEnabled: true,
      memoryIndexDebounceMs: 10,
      memorySearchIndex: mockMemorySearchIndex,
      leaseJanitor: mockLeaseJanitor,
      sleepConsolidator: mockSleepConsolidator,
      smartMoneyScanner: null,
      cryptoTradingEnabled: false,
      pidPath: path.join(tempRoot, 'supervisor.pid'),
      statusPath: path.join(tempRoot, 'supervisor-status.json'),
      logPath: path.join(tempRoot, 'supervisor.log'),
      taskLogDir: path.join(tempRoot, 'supervisor-tasks'),
      wakeSignalPath: path.join(tempRoot, 'supervisor-wake.signal'),
      sessionStatePath: path.join(tempRoot, 'session-state.json'),
      agentTaskQueuePath: path.join(tempRoot, 'agent-task-queue.json'),
    });
    daemon.getMemoryIndexWatchTargets = jest.fn(() => ['/tmp/knowledge/**/*.md']);
  });

  afterEach(async () => {
    if (daemon) {
      await daemon.stop('test-cleanup');
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
    if (originalMarketScannerAutomation == null) {
      delete process.env.SQUIDRUN_MARKET_SCANNER_AUTOMATION;
    } else {
      process.env.SQUIDRUN_MARKET_SCANNER_AUTOMATION = originalMarketScannerAutomation;
    }
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  test('reconciles position attribution from the live Hyperliquid snapshot', async () => {
    const statePath = path.join(tempRoot, 'agent-position-attribution.json');
    fs.writeFileSync(statePath, JSON.stringify({
      version: 2,
      positions: {
        'AVAX/USD': {
          ticker: 'AVAX/USD',
          agentId: 'architect',
          direction: 'SHORT',
          entryPrice: 9.1,
          currentSize: 12,
        },
      },
      closedPositions: [],
      quarantinedPositions: [],
    }, null, 2));
    hyperliquidClient.getOpenPositions.mockResolvedValueOnce([
      {
        coin: 'AXS',
        size: -18,
        entryPx: 2.72,
        liquidationPx: 3.12,
        markPrice: 2.76,
      },
    ]);
    daemon.positionAttributionReconciliationEnabled = true;
    daemon.positionAttributionStatePath = statePath;
    daemon.runtimeEnv = { HYPERLIQUID_WALLET_ADDRESS: '0xabc' };

    const result = await daemon.maybeRunPositionAttributionReconciliation(
      new Date('2026-04-25T23:58:00.000Z').getTime()
    );

    expect(hyperliquidClient.getOpenPositions).toHaveBeenCalledWith(expect.objectContaining({
      walletAddress: '0xabc',
    }));
    expect(result).toEqual(expect.objectContaining({
      status: 'ok',
      liveCount: 1,
      createdCount: 1,
      quarantinedCount: 1,
      created: ['AXS/USD'],
      quarantined: ['AVAX/USD'],
    }));
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    expect(state.positions['AXS/USD']).toEqual(expect.objectContaining({
      agentId: '',
      source: 'live_snapshot_reconciliation',
      strategyLane: 'manual_unattributed',
      currentSize: 18,
      liquidationPx: 3.12,
    }));
    expect(state.quarantinedPositions).toEqual([
      expect.objectContaining({
        ticker: 'AVAX/USD',
        quarantineReason: 'not_in_live_hyperliquid_snapshot',
      }),
    ]);
  });

  test('tick runs position attribution reconciliation before crypto automation', async () => {
    const callOrder = [];
    const skippedLane = jest.fn(async () => ({ ok: true, skipped: true }));
    daemon.maybeRunAgentTaskQueue = jest.fn(async () => ({ ok: true, dispatched: 0, completed: 0 }));
    daemon.maybeRunPositionAttributionReconciliation = jest.fn(async () => {
      callOrder.push('position_attribution');
      return { ok: true, status: 'ok' };
    });
    daemon.maybeRunCryptoTradingAutomation = jest.fn(async () => {
      callOrder.push('crypto');
      return { ok: true, skipped: true };
    });
    daemon.maybeRunTradeReconciliation = skippedLane;
    daemon.maybeRunTokenomistAutomation = skippedLane;
    daemon.maybeRunSparkAutomation = skippedLane;
    daemon.maybeRunMarketScannerAutomation = skippedLane;
    daemon.maybeRunSaylorWatcher = skippedLane;
    daemon.maybeRunOracleWatchEngine = skippedLane;
    daemon.maybeRunHyperliquidSqueezeDetector = skippedLane;
    daemon.maybeRunSleepCycle = skippedLane;

    const result = await daemon.tick();

    expect(daemon.maybeRunPositionAttributionReconciliation).toHaveBeenCalledTimes(1);
    expect(result.positionAttributionReconciliationResult).toEqual({ ok: true, status: 'ok' });
    expect(callOrder).toEqual(['position_attribution', 'crypto']);
  });

  test('runs the oracle watch engine through the supervisor lane and reports status', async () => {
    const rulesPath = path.join(tempRoot, 'oracle-watch-rules.json');
    const statePath = path.join(tempRoot, 'oracle-watch-state.json');
    const scriptPath = path.join(tempRoot, 'oracle-watch-mock.js');

    fs.writeFileSync(rulesPath, JSON.stringify({
      mode: 'macro_release',
      pollIntervalMs: 10000,
      macroPollIntervalMs: 5000,
      targets: ['oracle'],
      symbols: ['BTC/USD', 'ETH/USD', 'SOL/USD'],
      hotSymbols: [],
      rules: [],
    }, null, 2));
    fs.writeFileSync(scriptPath, [
      "const args = process.argv.slice(2);",
      "const stateIndex = args.indexOf('--state');",
      "const rulesIndex = args.indexOf('--rules');",
      'console.log(JSON.stringify({',
      "  ok: true,",
      "  alertCount: 1,",
      "  tickers: ['BTC/USD', 'ETH/USD', 'SOL/USD'],",
      "  statePath: stateIndex >= 0 ? args[stateIndex + 1] : null,",
      "  rulesPath: rulesIndex >= 0 ? args[rulesIndex + 1] : null",
      '}));',
    ].join('\n'));

    daemon = new SupervisorDaemon({
      projectRoot: tempRoot,
      store: createMockStore(),
      logger: createMockLogger(),
      memoryIndexEnabled: true,
      memoryIndexDebounceMs: 10,
      memorySearchIndex: mockMemorySearchIndex,
      leaseJanitor: mockLeaseJanitor,
      sleepConsolidator: mockSleepConsolidator,
      smartMoneyScanner: null,
      cryptoTradingEnabled: false,
      pidPath: path.join(tempRoot, 'supervisor.pid'),
      statusPath: path.join(tempRoot, 'supervisor-status.json'),
      logPath: path.join(tempRoot, 'supervisor.log'),
      taskLogDir: path.join(tempRoot, 'supervisor-tasks'),
      wakeSignalPath: path.join(tempRoot, 'supervisor-wake.signal'),
      sessionStatePath: path.join(tempRoot, 'session-state.json'),
      agentTaskQueuePath: path.join(tempRoot, 'agent-task-queue.json'),
      hyperliquidManualActivityPath: path.join(tempRoot, 'hyperliquid-manual-activity.json'),
      oracleWatchEnabled: true,
      oracleWatchEngineScriptPath: scriptPath,
      oracleWatchRulesPath: rulesPath,
      oracleWatchStatePath: statePath,
      saylorWatcherEnabled: false,
      hyperliquidSqueezeDetectorEnabled: false,
    });

    const result = await daemon.maybeRunOracleWatchEngine();
    daemon.writeStatus();
    const status = JSON.parse(fs.readFileSync(daemon.statusPath, 'utf8'));

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      alertCount: 1,
      statePath,
      rulesPath,
    }));
    expect(daemon.lastOracleWatchSummary).toEqual(expect.objectContaining({
      enabled: true,
      status: 'alert_sent',
      rulesPath,
      statePath,
      lastSummary: expect.objectContaining({
        ok: true,
        alertCount: 1,
      }),
    }));
    expect(status.oracleWatch).toEqual(expect.objectContaining({
      enabled: true,
      scriptPath,
      rulesPath,
      statePath,
      intervalMs: 5000,
      heartbeat: expect.objectContaining({
        state: 'green',
        stale: false,
        intervalMs: 5000,
      }),
      lastSummary: expect.objectContaining({
        status: 'alert_sent',
      }),
    }));
    expect(status.dailyTargetProgress).toEqual(expect.objectContaining({
      targetUsd: 200,
    }));
  });

  test('alerts when the oracle watch heartbeat goes stale for more than sixty seconds and notifies recovery', () => {
    const statePath = path.join(tempRoot, 'oracle-watch-state.json');
    daemon = new SupervisorDaemon({
      projectRoot: tempRoot,
      store: createMockStore(),
      logger: createMockLogger(),
      memoryIndexEnabled: false,
      sleepEnabled: false,
      cryptoTradingEnabled: false,
      pidPath: path.join(tempRoot, 'oracle-watch-heartbeat.pid'),
      statusPath: path.join(tempRoot, 'oracle-watch-heartbeat-status.json'),
      logPath: path.join(tempRoot, 'oracle-watch-heartbeat.log'),
      taskLogDir: path.join(tempRoot, 'oracle-watch-heartbeat-tasks'),
      wakeSignalPath: path.join(tempRoot, 'oracle-watch-heartbeat-wake.signal'),
      oracleWatchEnabled: true,
      oracleWatchStatePath: statePath,
      saylorWatcherEnabled: false,
      hyperliquidSqueezeDetectorEnabled: false,
    });

    const notifySpy = jest.spyOn(daemon, 'notifyOracleWatchLane').mockImplementation(() => {});
    const staleAt = new Date(Date.now() - 120_000).toISOString();
    fs.writeFileSync(statePath, JSON.stringify({
      updatedAt: staleAt,
      heartbeat: {
        lastTickAt: staleAt,
        intervalMs: 10_000,
        stale: false,
        state: 'green',
      },
      counters: {},
    }, null, 2));

    daemon.writeStatus();
    expect(notifySpy).toHaveBeenCalledWith(expect.stringContaining('Oracle watch heartbeat stale'), 'stale');
    notifySpy.mockClear();

    const recoveredAt = new Date().toISOString();
    fs.writeFileSync(statePath, JSON.stringify({
      updatedAt: recoveredAt,
      heartbeat: {
        lastTickAt: recoveredAt,
        intervalMs: 10_000,
        stale: false,
        state: 'green',
      },
      counters: {},
    }, null, 2));

    daemon.writeStatus();
    expect(notifySpy).toHaveBeenCalledWith(expect.stringContaining('Oracle watch heartbeat recovered'), 'recovered');
  });

  test('keeps the next idle tick bounded to the oracle watch due time instead of sleeping through it', () => {
    jest.setSystemTime(new Date('2026-04-16T22:30:00.000Z'));
    daemon.oracleWatchEnabled = true;
    daemon.oracleWatchPromise = null;
    daemon.oracleWatchIntervalMs = 10_000;
    daemon.lastOracleWatchRunAtMs = Date.now() - 4_000;
    daemon.currentBackoffMs = daemon.maxIdleBackoffMs;

    const delayMs = daemon.computeNextTickDelay({
      claimedCount: 0,
      activeWorkerCount: 0,
      tradeReconciliationResult: { skipped: true },
      cryptoTradingResult: { skipped: true },
      saylorWatcherResult: { skipped: true },
      oracleWatchResult: { skipped: true },
      hyperliquidSqueezeDetectorResult: { skipped: true },
      sleepResult: { skipped: true },
      memoryConsistency: { skipped: true },
      agentTaskQueue: { dispatched: 0, completed: 0 },
      queueHousekeeping: { requeueResult: { requeued: 0 }, pruneResult: { pruned: 0 } },
      leaseHousekeeping: { pruned: 0 },
    });

    expect(delayMs).toBe(6_000);
  });

  test('forces an oracle watch relaunch when the heartbeat is stale even inside the normal cooldown', async () => {
    const rulesPath = path.join(tempRoot, 'oracle-watch-rules.json');
    const statePath = path.join(tempRoot, 'oracle-watch-state.json');
    const scriptPath = path.join(tempRoot, 'oracle-watch-force-relaunch.js');

    fs.writeFileSync(rulesPath, JSON.stringify({
      mode: 'normal',
      pollIntervalMs: 10000,
      macroPollIntervalMs: 5000,
      targets: ['oracle'],
      symbols: ['BTC/USD', 'ETH/USD', 'SOL/USD'],
      hotSymbols: [],
      rules: [],
    }, null, 2));
    fs.writeFileSync(statePath, JSON.stringify({
      updatedAt: '2026-04-16T22:27:00.000Z',
      heartbeat: {
        lastTickAt: '2026-04-16T22:27:00.000Z',
        intervalMs: 10000,
        stale: false,
        state: 'green',
      },
      counters: {},
    }, null, 2));
    fs.writeFileSync(scriptPath, [
      'console.log(JSON.stringify({ ok: true, alertCount: 0, alerts: [] }));',
    ].join('\n'));

    daemon = new SupervisorDaemon({
      projectRoot: tempRoot,
      store: createMockStore(),
      logger: createMockLogger(),
      memoryIndexEnabled: false,
      sleepEnabled: false,
      cryptoTradingEnabled: false,
      pidPath: path.join(tempRoot, 'oracle-watch-relaunch.pid'),
      statusPath: path.join(tempRoot, 'oracle-watch-relaunch-status.json'),
      logPath: path.join(tempRoot, 'oracle-watch-relaunch.log'),
      taskLogDir: path.join(tempRoot, 'oracle-watch-relaunch-tasks'),
      wakeSignalPath: path.join(tempRoot, 'oracle-watch-relaunch-wake.signal'),
      hyperliquidManualActivityPath: path.join(tempRoot, 'oracle-watch-relaunch-manual-activity.json'),
      oracleWatchEnabled: true,
      oracleWatchEngineScriptPath: scriptPath,
      oracleWatchRulesPath: rulesPath,
      oracleWatchStatePath: statePath,
      saylorWatcherEnabled: false,
      hyperliquidSqueezeDetectorEnabled: false,
    });
    daemon.lastOracleWatchRunAtMs = Date.now();

    const result = await daemon.maybeRunOracleWatchEngine(Date.now());

    expect(result).toEqual(expect.objectContaining({ ok: true, alertCount: 0 }));
    expect(daemon.lastOracleWatchSummary).toEqual(expect.objectContaining({
      status: 'ok',
      statePath,
      rulesPath,
    }));
    expect(daemon.logger.warn).toHaveBeenCalledWith(expect.stringContaining('forcing relaunch'));
  });

  test('restarts the oracle watch lane after an uncaught rejection leaves the state file frozen on green', async () => {
    const rulesPath = path.join(tempRoot, 'oracle-watch-rules.json');
    const statePath = path.join(tempRoot, 'oracle-watch-state.json');
    const scriptPath = path.join(tempRoot, 'oracle-watch-crash-then-recover.js');
    const counterPath = path.join(tempRoot, 'oracle-watch-crash-counter.txt');
    const staleAt = '2026-04-16T22:20:00.000Z';

    fs.writeFileSync(rulesPath, JSON.stringify({
      mode: 'normal',
      pollIntervalMs: 10000,
      macroPollIntervalMs: 5000,
      targets: ['oracle'],
      symbols: ['BTC/USD', 'ETH/USD', 'SOL/USD'],
      hotSymbols: [],
      rules: [],
    }, null, 2));
    fs.writeFileSync(statePath, JSON.stringify({
      updatedAt: staleAt,
      heartbeat: {
        lastTickAt: staleAt,
        intervalMs: 10000,
        stale: false,
        state: 'green',
      },
      counters: {},
    }, null, 2));
    fs.writeFileSync(counterPath, '0', 'utf8');
    fs.writeFileSync(scriptPath, [
      "const fs = require('fs');",
      "const path = require('path');",
      "const args = process.argv.slice(2);",
      "const statePath = args[args.indexOf('--state') + 1];",
      "const counterPath = process.env.SQUIDRUN_TEST_COUNTER_PATH;",
      "const count = Number(fs.readFileSync(counterPath, 'utf8') || '0');",
      "fs.writeFileSync(counterPath, String(count + 1));",
      "if (count === 0) {",
      "  Promise.reject(new Error('simulated_watch_rejection'));",
      "  setTimeout(() => {}, 25);",
      "  return;",
      "}",
      "const now = new Date().toISOString();",
      "fs.writeFileSync(statePath, JSON.stringify({",
      "  version: 2,",
      "  updatedAt: now,",
      "  mode: 'normal',",
      "  heartbeat: { lastTickAt: now, intervalMs: 10000, stale: false, state: 'green' },",
      "  counters: { triggersSeen: 0, triggersArmed: 0, triggersFired: 0, triggersInvalidated: 0, triggersActedOn: 0, alertsSent: 0, lastCycleSeen: 0, lastCycleFired: 0, lastCycleAlertCount: 0 },",
      "  marketByTicker: {},",
      "  rules: {},",
      "  lastError: null,",
      "  lastFailureAt: null",
      "}, null, 2));",
      "console.log(JSON.stringify({ ok: true, alertCount: 0, alerts: [] }));",
    ].join('\n'));

    daemon = new SupervisorDaemon({
      projectRoot: tempRoot,
      store: createMockStore(),
      logger: createMockLogger(),
      env: {
        ...process.env,
        SQUIDRUN_TEST_COUNTER_PATH: counterPath,
      },
      memoryIndexEnabled: false,
      sleepEnabled: false,
      cryptoTradingEnabled: false,
      pidPath: path.join(tempRoot, 'oracle-watch-crash-restart.pid'),
      statusPath: path.join(tempRoot, 'oracle-watch-crash-restart-status.json'),
      logPath: path.join(tempRoot, 'oracle-watch-crash-restart.log'),
      taskLogDir: path.join(tempRoot, 'oracle-watch-crash-restart-tasks'),
      wakeSignalPath: path.join(tempRoot, 'oracle-watch-crash-restart-wake.signal'),
      hyperliquidManualActivityPath: path.join(tempRoot, 'oracle-watch-crash-restart-manual-activity.json'),
      oracleWatchEnabled: true,
      oracleWatchEngineScriptPath: scriptPath,
      oracleWatchRulesPath: rulesPath,
      oracleWatchStatePath: statePath,
      saylorWatcherEnabled: false,
      hyperliquidSqueezeDetectorEnabled: false,
    });

    const failedResult = await daemon.maybeRunOracleWatchEngine(Date.now());

    expect(failedResult).toEqual(expect.objectContaining({ ok: false }));
    expect(daemon.oracleWatchPromise).toBeNull();
    expect(daemon.lastOracleWatchSummary).toEqual(expect.objectContaining({
      status: 'failed',
    }));

    const restartDelayMs = daemon.computeNextTickDelay({
      claimedCount: 0,
      activeWorkerCount: 0,
      tradeReconciliationResult: { skipped: true },
      cryptoTradingResult: { skipped: true },
      saylorWatcherResult: { skipped: true },
      oracleWatchResult: { skipped: true },
      hyperliquidSqueezeDetectorResult: { skipped: true },
      sleepResult: { skipped: true },
      memoryConsistency: { skipped: true },
      agentTaskQueue: { dispatched: 0, completed: 0 },
      queueHousekeeping: { requeueResult: { requeued: 0 }, pruneResult: { pruned: 0 } },
      leaseHousekeeping: { pruned: 0 },
    });

    expect(restartDelayMs).toBe(daemon.pollMs);

    daemon.lastOracleWatchRunAtMs = Date.now();
    daemon.lastOracleWatchRelaunchAtMs = 0;
    const recoveredResult = await daemon.maybeRunOracleWatchEngine(Date.now());
    const recoveredState = JSON.parse(fs.readFileSync(statePath, 'utf8'));

    expect(recoveredResult).toEqual(expect.objectContaining({ ok: true, alertCount: 0 }));
    expect(daemon.lastOracleWatchSummary).toEqual(expect.objectContaining({
      status: 'ok',
      statePath,
      rulesPath,
    }));
    expect(recoveredState.heartbeat).toEqual(expect.objectContaining({
      stale: false,
      state: 'green',
    }));
    expect(new Date(recoveredState.heartbeat.lastTickAt).getTime()).toBeGreaterThan(new Date(staleAt).getTime());
    expect(daemon.logger.warn).toHaveBeenCalledWith(expect.stringContaining('forcing relaunch'));
  });

  test('restarts the oracle watch lane after rate-limit backoff expires even if the state file still says backoff', async () => {
    const rulesPath = path.join(tempRoot, 'oracle-watch-rules.json');
    const statePath = path.join(tempRoot, 'oracle-watch-state.json');
    const scriptPath = path.join(tempRoot, 'oracle-watch-backoff-expired-recover.js');
    const staleAt = '2026-04-20T05:52:33.876Z';
    const expiredBackoffAt = '2026-04-20T06:04:25.574Z';

    fs.writeFileSync(rulesPath, JSON.stringify({
      mode: 'normal',
      pollIntervalMs: 120000,
      macroPollIntervalMs: 5000,
      targets: ['oracle'],
      symbols: ['BTC/USD', 'ETH/USD', 'SOL/USD'],
      hotSymbols: [],
      rules: [],
    }, null, 2));
    fs.writeFileSync(statePath, JSON.stringify({
      version: 2,
      updatedAt: '2026-04-20T16:30:07.245Z',
      heartbeat: {
        lastTickAt: staleAt,
        intervalMs: 120000,
        stale: false,
        state: 'backoff',
        lastErrorAt: '2026-04-20T06:00:25.574Z',
        backoffUntil: expiredBackoffAt,
      },
      rateLimit: {
        consecutive429s: 1,
        backoffUntil: expiredBackoffAt,
        last429At: '2026-04-20T06:00:25.574Z',
        lastBackoffMs: 240000,
        lastError: '429 Too Many Requests - null',
      },
      counters: {},
      rules: {},
    }, null, 2));
    fs.writeFileSync(scriptPath, [
      "const fs = require('fs');",
      "const args = process.argv.slice(2);",
      "const statePath = args[args.indexOf('--state') + 1];",
      "const now = new Date().toISOString();",
      "fs.writeFileSync(statePath, JSON.stringify({",
      "  version: 2,",
      "  updatedAt: now,",
      "  mode: 'normal',",
      "  heartbeat: { lastTickAt: now, intervalMs: 120000, stale: false, state: 'green' },",
      "  counters: { triggersSeen: 0, triggersArmed: 0, triggersFired: 0, triggersInvalidated: 0, triggersActedOn: 0, alertsSent: 0, lastCycleSeen: 0, lastCycleFired: 0, lastCycleAlertCount: 0 },",
      "  rateLimit: { consecutive429s: 0, backoffUntil: null, last429At: '2026-04-20T06:00:25.574Z', lastBackoffMs: 240000, lastError: null },",
      "  marketByTicker: {},",
      "  rules: {},",
      "  lastError: null,",
      "  lastFailureAt: null",
      "}, null, 2));",
      "console.log(JSON.stringify({ ok: true, alertCount: 0, alerts: [] }));",
    ].join('\n'));

    daemon = new SupervisorDaemon({
      projectRoot: tempRoot,
      store: createMockStore(),
      logger: createMockLogger(),
      env: process.env,
      memoryIndexEnabled: false,
      sleepEnabled: false,
      cryptoTradingEnabled: false,
      pidPath: path.join(tempRoot, 'oracle-watch-backoff-expired-restart.pid'),
      statusPath: path.join(tempRoot, 'oracle-watch-backoff-expired-status.json'),
      logPath: path.join(tempRoot, 'oracle-watch-backoff-expired.log'),
      taskLogDir: path.join(tempRoot, 'oracle-watch-backoff-expired-tasks'),
      wakeSignalPath: path.join(tempRoot, 'oracle-watch-backoff-expired-wake.signal'),
      oracleWatchEnabled: true,
      oracleWatchEngineScriptPath: scriptPath,
      oracleWatchRulesPath: rulesPath,
      oracleWatchStatePath: statePath,
      saylorWatcherEnabled: false,
      hyperliquidSqueezeDetectorEnabled: false,
    });

    const recoveredResult = await daemon.maybeRunOracleWatchEngine(Date.now());
    const recoveredState = JSON.parse(fs.readFileSync(statePath, 'utf8'));

    expect(recoveredResult).toEqual(expect.objectContaining({ ok: true, alertCount: 0 }));
    expect(daemon.lastOracleWatchSummary).toEqual(expect.objectContaining({
      status: 'ok',
      statePath,
      rulesPath,
    }));
    expect(recoveredState.heartbeat).toEqual(expect.objectContaining({
      stale: false,
      state: 'green',
    }));
    expect(new Date(recoveredState.heartbeat.lastTickAt).getTime()).toBeGreaterThan(new Date(staleAt).getTime());
    expect(daemon.logger.warn).toHaveBeenCalledWith(expect.stringContaining('forcing relaunch'));
  });

  test('does not let a hung crypto trading phase block oracle watch scheduling', async () => {
    daemon.cryptoTradingEnabled = true;
    daemon.cryptoTradingOrchestrator = {};
    daemon.cryptoTradingPhasePromise = new Promise(() => {});
    daemon.cryptoTradingState.nextEvent = {
      key: 'crypto_consensus',
      label: 'Crypto consensus round',
      scheduledAt: '2026-04-16T23:00:00.000Z',
    };
    const oracleWatchSpy = jest.spyOn(daemon, 'maybeRunOracleWatchEngine').mockResolvedValue({
      ok: true,
      skipped: false,
      reason: 'oracle_watch_ran',
    });

    const result = await daemon.tick();

    expect(result.cryptoTradingResult).toEqual(expect.objectContaining({
      skipped: true,
      reason: 'crypto_phase_running',
    }));
    expect(oracleWatchSpy).toHaveBeenCalled();
    expect(daemon.lastCryptoTradingSummary).toEqual(expect.objectContaining({
      status: 'running',
    }));
  });

  test('does not let a hung market scanner phase block oracle watch scheduling', async () => {
    daemon.marketScannerEnabled = true;
    daemon.marketScanner = { runMarketScan: jest.fn() };
    daemon.marketScannerPhasePromise = new Promise(() => {});
    daemon.marketScannerState.nextEvent = {
      key: 'market_scanner',
      label: 'Hyperliquid market scanner',
      scheduledAt: '2026-04-16T23:00:00.000Z',
    };
    const oracleWatchSpy = jest.spyOn(daemon, 'maybeRunOracleWatchEngine').mockResolvedValue({
      ok: true,
      skipped: false,
      reason: 'oracle_watch_ran',
    });

    const result = await daemon.tick();

    expect(result.marketScannerResult).toEqual(expect.objectContaining({
      skipped: true,
      reason: 'market_scanner_running',
    }));
    expect(oracleWatchSpy).toHaveBeenCalled();
    expect(daemon.lastMarketScannerSummary).toEqual(expect.objectContaining({
      status: 'running',
    }));
  });

  test('schedules a startup refresh when watcher starts', async () => {
    daemon.startMemoryIndexWatcher();

    expect(chokidar.watch).toHaveBeenCalledWith(
      ['/tmp/knowledge/**/*.md'],
      expect.objectContaining({ ignoreInitial: true })
    );

    await jest.runOnlyPendingTimersAsync();
    if (daemon.memoryIndexRefreshPromise) {
      await daemon.memoryIndexRefreshPromise;
    }

    expect(mockMemorySearchIndex.indexAll).toHaveBeenCalledTimes(1);
  });

  test('debounces file change events into a refresh', async () => {
    daemon.startMemoryIndexWatcher();
    const memoryWatcher = getWatcherByTarget('/tmp/knowledge/**/*.md');
    await jest.runOnlyPendingTimersAsync();
    if (daemon.memoryIndexRefreshPromise) {
      await daemon.memoryIndexRefreshPromise;
    }
    mockMemorySearchIndex.indexAll.mockClear();

    memoryWatcher.handlers.all('change', '/tmp/knowledge/user-context.md');
    memoryWatcher.handlers.all('change', '/tmp/knowledge/workflows.md');

    await jest.runOnlyPendingTimersAsync();
    if (daemon.memoryIndexRefreshPromise) {
      await daemon.memoryIndexRefreshPromise;
    }

    expect(mockMemorySearchIndex.indexAll).toHaveBeenCalledTimes(1);
  });

  test('memory index watch targets include case evidence directories', () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    const targets = SupervisorDaemon.prototype.getMemoryIndexWatchTargets
      .call({})
      .map((target) => String(target).replace(/\\/g, '/'));
    expect(targets).toEqual(expect.arrayContaining([
      '/tmp/knowledge/**/*.md',
      '/tmp/cases/Korean Fraud/evidence/**/*',
    ]));
  });

  test('runs sleep consolidation when idle and no workers are active', async () => {
    mockSleepConsolidator.shouldRun.mockReturnValue({
      ok: true,
      activity: { idleMs: 1900000, isIdle: true },
      enoughGap: true,
    });

    const result = await daemon.maybeRunSleepCycle();

    expect(mockSleepConsolidator.runOnce).toHaveBeenCalledTimes(1);
    expect(result).toEqual(expect.objectContaining({ generatedPrCount: 1 }));
    expect(daemon.lastSleepCycleSummary).toEqual(expect.objectContaining({ generatedPrCount: 1 }));
  });

  test('skips sleep consolidation while work is active', async () => {
    daemon.activeWorkers.set('task-1', { taskId: 'task-1' });

    const result = await daemon.maybeRunSleepCycle();

    expect(result).toEqual(expect.objectContaining({ skipped: true, reason: 'workers_active' }));
    expect(mockSleepConsolidator.runOnce).not.toHaveBeenCalled();
  });

  test('primes sleep consolidator state during supervisor init', () => {
    const result = daemon.init();

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      memoryConsistency: expect.objectContaining({
        status: 'in_sync',
        synced: true,
      }),
    }));
    expect(mockSleepConsolidator.init).toHaveBeenCalledTimes(1);
    expect(mockSleepConsolidator.extractionCommand).toContain('claude-extract.js');
    expect(mockLeaseJanitor.pruneExpiredLeases).toHaveBeenCalledTimes(1);
    expect(runMemoryConsistencyCheck).toHaveBeenCalledWith(expect.objectContaining({
      projectRoot: expect.any(String),
      sampleLimit: 5,
    }));
    expect(daemon.logger.info).toHaveBeenCalledWith(
      'Memory consistency (startup): status=in_sync entries=15 nodes=15 missing=0 orphans=0 duplicates=0'
    );
  });

  test('closes watcher, wake signal, memory index, and sleep consolidator on stop', async () => {
    daemon.startMemoryIndexWatcher();
    daemon.startWakeSignalWatcher();
    await daemon.stop('test');

    const memoryWatcher = getWatcherByTarget('/tmp/knowledge/**/*.md');
    const wakeWatcher = getWatcherByTarget(daemon.wakeSignalPath);
    expect(memoryWatcher.close).toHaveBeenCalledTimes(1);
    expect(wakeWatcher.close).toHaveBeenCalledTimes(1);
    expect(mockMemorySearchIndex.close).toHaveBeenCalled();
    expect(mockSleepConsolidator.close).toHaveBeenCalled();
    expect(mockLeaseJanitor.close).toHaveBeenCalled();
  });

  test('resolves packaged hm-send path through app.asar/ui/scripts instead of app.asar/scripts', () => {
    const asarRoot = path.join(tempRoot, 'resources', 'app.asar');
    const packagedScript = path.join(asarRoot, 'ui', 'scripts', 'hm-send.js');
    fs.mkdirSync(path.dirname(packagedScript), { recursive: true });
    fs.writeFileSync(packagedScript, 'module.exports = {};\n', 'utf8');

    expect(resolveProjectUiScriptPath('hm-send.js', asarRoot)).toBe(packagedScript);
  });

  test('resolves hm-send when the packaged project root is already the ui directory', () => {
    const packagedUiRoot = path.join(tempRoot, 'resources', 'app.asar', 'ui');
    const packagedScript = path.join(packagedUiRoot, 'scripts', 'hm-send.js');
    fs.mkdirSync(path.dirname(packagedScript), { recursive: true });
    fs.writeFileSync(packagedScript, 'module.exports = {};\n', 'utf8');

    expect(resolveProjectUiScriptPath('hm-send.js', packagedUiRoot)).toBe(packagedScript);
  });

  test('suppresses default hm-send side effects under Jest unless a capture script is provided', () => {
    daemon.logger.info.mockClear();

    daemon.notifyOracleWatchLane('(SUPERVISOR): test-only stale alert', 'stale');

    expect(daemon.logger.info).toHaveBeenCalledWith(
      'hm-send suppressed during stale: architect'
    );
    expect(daemon.logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('Oracle watch notify failed')
    );
  });

  test('uses the configured hm-send script path for trading Telegram notifications', async () => {
    const projectRoot = path.join(tempRoot, 'repo-root');
    const capturePath = path.join(tempRoot, 'hm-send-calls.jsonl');
    const captureScriptPath = path.join(tempRoot, 'capture-hm-send.js');
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.writeFileSync(
      captureScriptPath,
      [
        "const fs = require('fs');",
        "const payload = { args: process.argv.slice(2) };",
        "fs.appendFileSync(process.env.SQUIDRUN_TEST_CAPTURE, JSON.stringify(payload) + '\\n');",
      ].join('\n'),
      'utf8'
    );

    const notifyDaemon = new SupervisorDaemon({
      store: createMockStore(),
      logger: createMockLogger(),
      projectRoot,
      hmSendScriptPath: captureScriptPath,
      env: {
        ...process.env,
        TELEGRAM_CHAT_ID: '5613428850',
        SQUIDRUN_TEST_CAPTURE: capturePath,
      },
      memoryIndexEnabled: false,
      sleepEnabled: false,
      cryptoTradingEnabled: false,
      pidPath: path.join(tempRoot, 'notify.pid'),
      statusPath: path.join(tempRoot, 'notify-status.json'),
      logPath: path.join(tempRoot, 'notify.log'),
      taskLogDir: path.join(tempRoot, 'notify-tasks'),
      wakeSignalPath: path.join(tempRoot, 'notify-wake.signal'),
    });

    try {
      notifyDaemon.notifyTelegramTrading('Trading Day Summary - 2026-03-29');
    } finally {
      await notifyDaemon.stop('test-cleanup-notify-script-path');
    }

    const capturedCalls = fs.readFileSync(capturePath, 'utf8')
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0].args).toEqual(['telegram', 'Trading Day Summary - 2026-03-29', '--chat-id', '5613428850']);
  });

  test('runs a Hyperliquid monitor loop independent of consultations', async () => {
    const setIntervalSpy = jest.spyOn(global, 'setInterval');
    const hyperliquidMonitorOrchestrator = {
      runDefiMonitorCycle: jest.fn()
        .mockResolvedValueOnce({
          ok: true,
          checkedAt: '2026-03-28T20:00:00.000Z',
          positions: [],
          warnings: [],
          telegramAlerts: [],
          peakStatePath: '/tmp/defi-peak-pnl.json',
        })
        .mockResolvedValueOnce({
          ok: true,
          checkedAt: '2026-03-28T20:05:00.000Z',
          positions: [
            {
              coin: 'ETH',
              side: 'short',
              entryPx: 2100,
              unrealizedPnl: 57,
              liquidationPx: 2400,
              peakUnrealizedPnl: 150,
              retainedPeakRatio: 0.38,
              timeOpenMs: 300000,
            },
          ],
          warnings: [{ level: 'urgent', code: 'defi_profit_giveback_urgent' }],
          telegramAlerts: [{ level: 'urgent' }],
          peakStatePath: '/tmp/defi-peak-pnl.json',
        }),
    };
    const monitorDaemon = new SupervisorDaemon({
      store: createMockStore(),
      logger: createMockLogger(),
      memoryIndexEnabled: false,
      sleepEnabled: false,
      smartMoneyScanner: null,
      circuitBreaker: null,
      cryptoTradingEnabled: false,
      hyperliquidMonitorEnabled: true,
      hyperliquidMonitorPollMs: 50,
      hyperliquidExecutor: {},
      hyperliquidMonitorOrchestrator,
      pidPath: '/tmp/hyperliquid-monitor.pid',
      statusPath: '/tmp/hyperliquid-monitor-status.json',
      logPath: '/tmp/hyperliquid-monitor.log',
      taskLogDir: '/tmp/hyperliquid-monitor-tasks',
      wakeSignalPath: '/tmp/hyperliquid-monitor-wake.signal',
    });
    monitorDaemon.requestTick = jest.fn();
    monitorDaemon.writeStatus = jest.fn();

    try {
      const startResult = monitorDaemon.start();
      expect(startResult).toEqual({ ok: true });

      await Promise.resolve(monitorDaemon.hyperliquidMonitorPromise);
      await Promise.resolve();
      expect(hyperliquidMonitorOrchestrator.runDefiMonitorCycle).toHaveBeenNthCalledWith(1, expect.objectContaining({
        trigger: 'startup',
        sendTelegram: false,
      }));
      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 60000);
      expect(monitorDaemon.lastHyperliquidMonitorSummary).toEqual(expect.objectContaining({
        status: 'ok',
      }));
    } finally {
      await monitorDaemon.stop('test-cleanup-hyperliquid-monitor');
    }
  });

  test('pauses the Hyperliquid monitor while manual Hyperliquid activity is active', async () => {
    const hyperliquidMonitorOrchestrator = {
      runDefiMonitorCycle: jest.fn(),
    };
    const manualActivityPath = path.join(tempRoot, 'hyperliquid-manual-activity.json');
    fs.writeFileSync(manualActivityPath, JSON.stringify({
      ownerId: 'manual-lock',
      command: 'hm-defi-execute',
      caller: 'manual',
      pid: 4242,
      startedAt: '2026-04-23T00:00:00.000Z',
      lastHeartbeatAt: '2026-04-23T00:00:05.000Z',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      metadata: {
        argv: ['trade', '--asset', 'AAVE'],
      },
    }, null, 2));

    const monitorDaemon = new SupervisorDaemon({
      store: createMockStore(),
      logger: createMockLogger(),
      memoryIndexEnabled: false,
      sleepEnabled: false,
      smartMoneyScanner: null,
      circuitBreaker: null,
      cryptoTradingEnabled: false,
      hyperliquidMonitorEnabled: true,
      hyperliquidExecutor: {},
      hyperliquidManualActivityPath: manualActivityPath,
      hyperliquidMonitorOrchestrator,
      pidPath: path.join(tempRoot, 'hyperliquid-monitor-pause.pid'),
      statusPath: path.join(tempRoot, 'hyperliquid-monitor-pause-status.json'),
      logPath: path.join(tempRoot, 'hyperliquid-monitor-pause.log'),
      taskLogDir: path.join(tempRoot, 'hyperliquid-monitor-pause-tasks'),
      wakeSignalPath: path.join(tempRoot, 'hyperliquid-monitor-pause-wake.signal'),
    });
    monitorDaemon.writeStatus = jest.fn();

    const result = await monitorDaemon.runHyperliquidPositionMonitorCycle('manual');

    expect(hyperliquidMonitorOrchestrator.runDefiMonitorCycle).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      skipped: true,
      reason: 'manual_hyperliquid_activity',
      manualActivity: expect.objectContaining({
        command: 'hm-defi-execute',
        caller: 'manual',
      }),
    }));
    expect(monitorDaemon.lastHyperliquidMonitorSummary).toEqual(expect.objectContaining({
      status: 'paused_for_manual_activity',
      riskExit: expect.objectContaining({
        reason: 'manual_activity_pause',
      }),
    }));
  });

  test('enables the Hyperliquid monitor with HYPERLIQUID_WALLET_ADDRESS fallback', async () => {
    const hyperliquidMonitorOrchestrator = {
      runDefiMonitorCycle: jest.fn().mockResolvedValue({
        ok: true,
        checkedAt: '2026-03-31T00:00:00.000Z',
        positions: [],
        warnings: [],
        telegramAlerts: [],
        peakStatePath: path.join(tempRoot, 'defi-peak-pnl.json'),
      }),
    };
    const walletFallbackDaemon = new SupervisorDaemon({
      store: createMockStore(),
      logger: createMockLogger(),
      memoryIndexEnabled: false,
      sleepEnabled: false,
      smartMoneyScanner: null,
      circuitBreaker: null,
      cryptoTradingEnabled: false,
      hyperliquidMonitorOrchestrator,
      env: {
        ...process.env,
        HYPERLIQUID_PRIVATE_KEY: '0xabc123',
        HYPERLIQUID_WALLET_ADDRESS: '0xdef456',
      },
      pidPath: path.join(tempRoot, 'hl-wallet-fallback.pid'),
      statusPath: path.join(tempRoot, 'hl-wallet-fallback-status.json'),
      logPath: path.join(tempRoot, 'hl-wallet-fallback.log'),
      taskLogDir: path.join(tempRoot, 'hl-wallet-fallback-tasks'),
      wakeSignalPath: path.join(tempRoot, 'hl-wallet-fallback-wake.signal'),
    });

    try {
      expect(walletFallbackDaemon.hyperliquidMonitorEnabled).toBe(true);
      expect(walletFallbackDaemon.lastHyperliquidMonitorSummary.status).toBe('idle');

      const startResult = walletFallbackDaemon.start();
      expect(startResult).toEqual({ ok: true });
      await Promise.resolve(walletFallbackDaemon.hyperliquidMonitorPromise);

      expect(hyperliquidMonitorOrchestrator.runDefiMonitorCycle).toHaveBeenCalledWith(expect.objectContaining({
        trigger: 'startup',
        sendTelegram: false,
      }));
      expect(walletFallbackDaemon.lastHyperliquidMonitorSummary).toEqual(expect.objectContaining({
        status: 'ok',
        peakStatePath: path.join(tempRoot, 'defi-peak-pnl.json'),
      }));
    } finally {
      await walletFallbackDaemon.stop('test-cleanup-hyperliquid-wallet-fallback');
    }
  });

  test('syncs Hyperliquid peak state from the live execution snapshot even when no trade is taken', async () => {
    const hyperliquidMonitorOrchestrator = {
      syncDefiPeakStateFromStatus: jest.fn().mockResolvedValue({
        ok: true,
        checkedAt: '2026-03-29T01:00:00.000Z',
        positions: [
          expect.objectContaining({ coin: 'ETH' }),
        ],
        peakStatePath: '/tmp/defi-peak-pnl.json',
      }),
    };
    const hyperliquidExecutor = {
      getAccountState: jest.fn().mockResolvedValue({
        accountValue: 708.4,
        positions: [
          { coin: 'ETH', size: -1.7113, side: 'short', entryPx: 2008.1, unrealizedPnl: 17.46, liquidationPx: 2361.69 },
        ],
      }),
      openEthShort: jest.fn(),
      closeEthPosition: jest.fn(),
    };
    const tradingDaemon = new SupervisorDaemon({
      store: createMockStore(),
      logger: createMockLogger(),
      memoryIndexEnabled: false,
      sleepEnabled: false,
      cryptoTradingEnabled: true,
      hyperliquidExecutionEnabled: true,
      hyperliquidExecutor,
      hyperliquidMonitorOrchestrator,
      env: {
        ...process.env,
        SQUIDRUN_HYPERLIQUID_AUTOMATION: '1',
      },
      pidPath: '/tmp/hyperliquid-sync.pid',
      statusPath: '/tmp/hyperliquid-sync-status.json',
      logPath: '/tmp/hyperliquid-sync.log',
      taskLogDir: '/tmp/hyperliquid-sync-tasks',
      wakeSignalPath: '/tmp/hyperliquid-sync-wake.signal',
    });

    const result = await tradingDaemon.runHyperliquidExecutionPhase({
      scheduledAt: '2026-03-29T01:00:00.000Z',
      marketDate: '2026-03-28',
      consensusPhase: { results: [], approvedTrades: [] },
      approvedTrades: [],
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      skipped: true,
      action: 'none',
      position: expect.objectContaining({
        coin: 'ETH',
        side: 'short',
      }),
    }));
    expect(hyperliquidMonitorOrchestrator.syncDefiPeakStateFromStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        accountValue: 708.4,
        positions: [
          expect.objectContaining({
            coin: 'ETH',
            side: 'short',
          }),
        ],
      }),
      expect.objectContaining({
        trigger: 'hyperliquid_execution_none',
        sendTelegram: false,
      })
    );
  });

  test('creates a persistent agent task queue file during init', () => {
    const result = daemon.init();

    expect(result).toEqual(expect.objectContaining({ ok: true }));
    const savedQueue = JSON.parse(fs.readFileSync(daemon.agentTaskQueuePath, 'utf8'));
    expect(savedQueue).toEqual(expect.objectContaining({
      version: 1,
      agents: expect.objectContaining({
        architect: expect.objectContaining({ pending: [], active: null }),
        builder: expect.objectContaining({ pending: [], active: null }),
        oracle: expect.objectContaining({ pending: [], active: null }),
      }),
    }));
  });

  test('dispatches the next queued agent task for an alive pane', async () => {
    daemon.init();
    fs.writeFileSync(daemon.sessionStatePath, JSON.stringify({
      terminals: [
        {
          paneId: '2',
          alive: true,
          scrollback: 'Ready (squidrun)\n',
          lastActivity: 1000,
          lastInputTime: 1000,
        },
      ],
    }, null, 2));
    fs.writeFileSync(daemon.agentTaskQueuePath, JSON.stringify({
      version: 1,
      agents: {
        builder: {
          pending: [
            {
              taskId: 'task-1',
              message: '(ARCHITECT #1): First queued task.',
            },
          ],
          active: null,
          history: [],
        },
      },
    }, null, 2));
    jest.spyOn(daemon, 'dispatchAgentQueuedTask').mockResolvedValue({
      ok: true,
      status: 'delivered.verified',
      exitCode: 0,
    });

    const result = await daemon.maybeRunAgentTaskQueue(2000);
    const savedQueue = JSON.parse(fs.readFileSync(daemon.agentTaskQueuePath, 'utf8'));

    expect(result).toEqual(expect.objectContaining({
      dispatched: 1,
      pending: expect.objectContaining({ builder: 0 }),
    }));
    expect(daemon.dispatchAgentQueuedTask).toHaveBeenCalledWith('builder', expect.objectContaining({
      taskId: 'task-1',
    }));
    expect(savedQueue.agents.builder.active).toEqual(expect.objectContaining({
      taskId: 'task-1',
      status: 'dispatched',
      lastDispatchAtMs: 2000,
    }));
  });

  test('completes an active task on idle-ready and immediately dispatches the next queued task', async () => {
    daemon.init();
    daemon.agentTaskIdleCompletionMs = 1000;
    daemon.agentTaskReadyGraceMs = 2000;
    fs.writeFileSync(daemon.sessionStatePath, JSON.stringify({
      terminals: [
        {
          paneId: '2',
          alive: true,
          scrollback: 'work finished\nType your message or @path/to/file\n',
          lastActivity: 4000,
          lastInputTime: 2000,
        },
      ],
    }, null, 2));
    fs.writeFileSync(daemon.agentTaskQueuePath, JSON.stringify({
      version: 1,
      agents: {
        builder: {
          pending: [
            {
              taskId: 'task-2',
              message: '(ARCHITECT #2): Second queued task.',
            },
          ],
          active: {
            taskId: 'task-1',
            message: '(ARCHITECT #1): First queued task.',
            lastDispatchAtMs: 1000,
            firstActivityAtMs: 2000,
            status: 'running',
          },
          history: [],
        },
      },
    }, null, 2));
    jest.spyOn(daemon, 'dispatchAgentQueuedTask').mockResolvedValue({
      ok: true,
      status: 'delivered.verified',
      exitCode: 0,
    });

    const result = await daemon.maybeRunAgentTaskQueue(6000);
    const savedQueue = JSON.parse(fs.readFileSync(daemon.agentTaskQueuePath, 'utf8'));

    expect(result).toEqual(expect.objectContaining({
      completed: 1,
      dispatched: 1,
    }));
    expect(savedQueue.agents.builder.history).toEqual(expect.arrayContaining([
      expect.objectContaining({
        taskId: 'task-1',
        status: 'completed',
        completionReason: 'idle_ready',
      }),
    ]));
    expect(savedQueue.agents.builder.active).toEqual(expect.objectContaining({
      taskId: 'task-2',
      status: 'dispatched',
      lastDispatchAtMs: 6000,
    }));
  });

  test('re-engages the next queued task after five minutes of agent silence', async () => {
    daemon.init();
    daemon.agentTaskReengageIdleMs = 5 * 60 * 1000;
    fs.writeFileSync(daemon.sessionStatePath, JSON.stringify({
      terminals: [
        {
          paneId: '2',
          alive: true,
          scrollback: 'last finished output with no ready prompt yet\n',
          lastActivity: 2000,
          lastInputTime: 2000,
        },
      ],
    }, null, 2));
    fs.writeFileSync(daemon.agentTaskQueuePath, JSON.stringify({
      version: 1,
      agents: {
        builder: {
          pending: [
            {
              taskId: 'task-2',
              message: '(ARCHITECT #2): Second queued task.',
            },
          ],
          active: {
            taskId: 'task-1',
            message: '(ARCHITECT #1): First queued task.',
            lastDispatchAtMs: 1000,
            firstActivityAtMs: 2000,
            lastObservedActivityAtMs: 2000,
            status: 'running',
          },
          history: [],
        },
      },
    }, null, 2));
    jest.spyOn(daemon, 'dispatchAgentQueuedTask').mockResolvedValue({
      ok: true,
      status: 'delivered.verified',
      exitCode: 0,
    });

    const result = await daemon.maybeRunAgentTaskQueue((5 * 60 * 1000) + 4000);
    const savedQueue = JSON.parse(fs.readFileSync(daemon.agentTaskQueuePath, 'utf8'));

    expect(result).toEqual(expect.objectContaining({
      completed: 1,
      reengaged: 1,
      dispatched: 1,
    }));
    expect(savedQueue.agents.builder.history).toEqual(expect.arrayContaining([
      expect.objectContaining({
        taskId: 'task-1',
        status: 'completed',
        completionReason: 'reengage_next_task',
      }),
    ]));
    expect(savedQueue.agents.builder.active).toEqual(expect.objectContaining({
      taskId: 'task-2',
      status: 'dispatched',
    }));
  });

  test('completes an active task immediately when its sentinel appears in scrollback', async () => {
    daemon.init();
    fs.writeFileSync(daemon.sessionStatePath, JSON.stringify({
      terminals: [
        {
          paneId: '3',
          alive: true,
          scrollback: 'partial output\n__QUEUE_DONE__\n',
          lastActivity: 2500,
          lastInputTime: 2000,
        },
      ],
    }, null, 2));
    fs.writeFileSync(daemon.agentTaskQueuePath, JSON.stringify({
      version: 1,
      agents: {
        oracle: {
          pending: [],
          active: {
            taskId: 'oracle-task',
            message: '(ARCHITECT #3): Sentinel task.',
            lastDispatchAtMs: 1000,
            completionSentinel: '__QUEUE_DONE__',
            status: 'running',
          },
          history: [],
        },
      },
    }, null, 2));

    const result = await daemon.maybeRunAgentTaskQueue(3000);
    const savedQueue = JSON.parse(fs.readFileSync(daemon.agentTaskQueuePath, 'utf8'));

    expect(result).toEqual(expect.objectContaining({
      completed: 1,
    }));
    expect(savedQueue.agents.oracle.active).toBeNull();
    expect(savedQueue.agents.oracle.history).toEqual(expect.arrayContaining([
      expect.objectContaining({
        taskId: 'oracle-task',
        completionReason: 'sentinel',
      }),
    ]));
  });

  test('manual wake re-arms the idle loop for an immediate tick', async () => {
    daemon.memoryIndexEnabled = false;

    const startResult = daemon.start();
    expect(startResult).toEqual({ ok: true });

    await jest.advanceTimersByTimeAsync(0);

    expect(daemon.store.claimNextTask).toHaveBeenCalledTimes(1);
    expect(daemon.currentBackoffMs).toBe(daemon.pollMs);

    daemon.requestTick('manual');
    expect(daemon.currentBackoffMs).toBe(daemon.pollMs);
    expect(daemon.nextTickAtMs).toBeLessThanOrEqual(Date.now());
  });

  test('wake signal watcher requests an immediate tick', () => {
    const requestTickSpy = jest.spyOn(daemon, 'requestTick');

    daemon.startWakeSignalWatcher();
    const wakeWatcher = getWatcherByTarget(daemon.wakeSignalPath);
    wakeWatcher.handlers.all('change', daemon.wakeSignalPath);

    expect(requestTickSpy).toHaveBeenCalledWith('wake-signal:change');
  });

  test('prunes expired memory leases during tick housekeeping', async () => {
    mockLeaseJanitor.pruneExpiredLeases.mockReturnValue({
      ok: true,
      pruned: 3,
    });

    const result = daemon.runMemoryLeaseHousekeeping(Date.now(), 'tick');

    expect(mockLeaseJanitor.pruneExpiredLeases).toHaveBeenCalledTimes(1);
    expect(result).toEqual(expect.objectContaining({ pruned: 3 }));
    expect(daemon.logger.warn).toHaveBeenCalledWith('Pruned 3 expired memory lease(s) during tick');
  });

  test('kills expired active workers before launching replacements', async () => {
    daemon.maxWorkers = 1;
    daemon.activeWorkers.set('expired-task', {
      taskId: 'expired-task',
      child: { pid: 4242, kill: jest.fn() },
      taskLogPath: '/tmp/supervisor-tasks/expired-task.log',
    });
    daemon.store.requeueExpiredTasks.mockReturnValue({
      ok: true,
      requeued: 1,
      taskIds: ['expired-task'],
      tasks: [{ taskId: 'expired-task', workerPid: 4242 }],
    });
    daemon.store.claimNextTask
      .mockReturnValueOnce({
        ok: true,
        task: {
          taskId: 'replacement-task',
          objective: 'replacement',
          contextSnapshot: { kind: 'shell', shellCommand: 'echo replacement' },
        },
      })
      .mockReturnValueOnce({ ok: true, task: null });

    jest.spyOn(daemon, 'stopWorker').mockImplementation(async (taskId) => {
      daemon.activeWorkers.delete(taskId);
    });
    jest.spyOn(daemon, 'launchTask').mockResolvedValue();
    const skippedLane = jest.fn(async () => ({ ok: true, skipped: true }));
    daemon.maybeRunAgentTaskQueue = jest.fn(async () => ({ ok: true, dispatched: 0, completed: 0 }));
    daemon.maybeRunPositionAttributionReconciliation = skippedLane;
    daemon.maybeRunCryptoTradingAutomation = skippedLane;
    daemon.maybeRunTradeReconciliation = skippedLane;
    daemon.maybeRunTokenomistAutomation = skippedLane;
    daemon.maybeRunSparkAutomation = skippedLane;
    daemon.maybeRunMarketScannerAutomation = skippedLane;
    daemon.maybeRunSaylorWatcher = skippedLane;
    daemon.maybeRunOracleWatchEngine = skippedLane;
    daemon.maybeRunHyperliquidSqueezeDetector = skippedLane;
    daemon.maybeRunSleepCycle = skippedLane;

    await daemon.tick();

    expect(daemon.stopWorker).toHaveBeenCalledWith(
      'expired-task',
      expect.objectContaining({ taskId: 'expired-task' }),
      'lease_expired_requeue'
    );
    expect(daemon.launchTask).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'replacement-task' }),
      expect.objectContaining({ leaseOwner: expect.any(String) })
    );
  });

  test('prunes stale pending tasks during housekeeping when ttl is enabled', async () => {
    daemon.pendingTaskTtlMs = 60000;
    daemon.store.pruneExpiredPendingTasks.mockReturnValue({
      ok: true,
      pruned: 2,
      taskIds: ['task-1', 'task-2'],
      tasks: [{ taskId: 'task-1' }, { taskId: 'task-2' }],
    });

    const result = daemon.runQueueHousekeeping(Date.now(), 'tick');

    expect(daemon.store.pruneExpiredPendingTasks).toHaveBeenCalledWith(
      expect.objectContaining({
        maxAgeMs: 60000,
      })
    );
    expect(result.pruneResult).toEqual(expect.objectContaining({ pruned: 2 }));
    expect(daemon.logger.warn).toHaveBeenCalledWith('Pruned 2 stale pending supervisor task(s) during tick');
  });

  test('logs periodic memory consistency drift during tick once the poll interval elapses', async () => {
    runMemoryConsistencyCheck.mockReturnValueOnce({
      ok: true,
      checkedAt: '2026-03-15T00:05:00.000Z',
      status: 'drift_detected',
      synced: false,
      summary: {
        knowledgeEntryCount: 15,
        knowledgeNodeCount: 19,
        missingInCognitiveCount: 2,
        orphanedNodeCount: 6,
        duplicateKnowledgeHashCount: 0,
        issueCount: 0,
      },
    });
    daemon.lastMemoryConsistencyCheckAtMs = Date.now() - daemon.memoryConsistencyPollMs - 1;

    const result = daemon.maybeRunMemoryConsistencyAudit(Date.now(), 'tick');

    expect(result).toEqual(expect.objectContaining({ status: 'drift_detected' }));
    expect(daemon.lastMemoryConsistencySummary).toEqual(expect.objectContaining({
      status: 'drift_detected',
      synced: false,
      summary: expect.objectContaining({
        missingInCognitiveCount: 2,
        orphanedNodeCount: 6,
      }),
    }));
    expect(daemon.logger.warn).toHaveBeenCalledWith(
      'Memory consistency (tick): status=drift_detected entries=15 nodes=19 missing=2 orphans=6 duplicates=0'
    );
  });

  test('rate-limits repeated memory consistency drift while still logging state changes', () => {
    const drift = {
      ok: true,
      checkedAt: '2026-03-15T00:05:00.000Z',
      status: 'drift_detected',
      synced: false,
      summary: {
        knowledgeEntryCount: 15,
        knowledgeNodeCount: 19,
        missingInCognitiveCount: 2,
        orphanedNodeCount: 6,
        duplicateKnowledgeHashCount: 0,
        issueCount: 0,
      },
    };
    const changedDrift = {
      ...drift,
      summary: {
        ...drift.summary,
        missingInCognitiveCount: 3,
      },
    };
    runMemoryConsistencyCheck.mockReturnValue(drift);
    daemon.memoryConsistencyRepeatLogMs = 60_000;
    daemon.logger.warn.mockClear();

    daemon.runMemoryConsistencyAudit('tick', 100_000);
    daemon.runMemoryConsistencyAudit('tick', 110_000);

    expect(daemon.logger.warn).toHaveBeenCalledTimes(1);
    expect(daemon.logger.warn).toHaveBeenLastCalledWith(
      'Memory consistency (tick): status=drift_detected entries=15 nodes=19 missing=2 orphans=6 duplicates=0'
    );

    runMemoryConsistencyCheck.mockReturnValue(changedDrift);
    daemon.runMemoryConsistencyAudit('tick', 120_000);

    expect(daemon.logger.warn).toHaveBeenCalledTimes(2);
    expect(daemon.logger.warn).toHaveBeenLastCalledWith(
      'Memory consistency (tick): status=drift_detected entries=15 nodes=19 missing=3 orphans=6 duplicates=0'
    );
  });

  test('rate-limits steady-state memory index refresh completions', async () => {
    daemon.memoryIndexRepeatLogMs = 60_000;
    daemon.logger.info.mockClear();
    jest.spyOn(Date, 'now')
      .mockReturnValueOnce(100_000)
      .mockReturnValueOnce(110_000)
      .mockReturnValueOnce(170_001);

    await daemon.runMemoryIndexRefresh('change:session.md');
    await daemon.runMemoryIndexRefresh('change:session.md');
    await daemon.runMemoryIndexRefresh('change:session.md');

    expect(daemon.logger.info).toHaveBeenCalledTimes(2);
    expect(daemon.logger.info).toHaveBeenNthCalledWith(
      1,
      'Memory index refresh (change:session.md) complete: groups=1 skipped=0 docs=3'
    );
    expect(daemon.logger.info).toHaveBeenNthCalledWith(
      2,
      'Memory index refresh (change:session.md) complete: groups=1 skipped=0 docs=3 (suppressed 1 repeat)'
    );
  });

  test('writes memory consistency status into supervisor status payload', () => {
    const writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
    daemon.lastMemoryConsistencySummary = {
      enabled: true,
      checkedAt: '2026-03-15T00:00:00.000Z',
      status: 'in_sync',
      synced: true,
      error: null,
      summary: {
        knowledgeEntryCount: 15,
        knowledgeNodeCount: 15,
        missingInCognitiveCount: 0,
        orphanedNodeCount: 0,
        duplicateKnowledgeHashCount: 0,
        issueCount: 0,
      },
    };

    daemon.writeStatus();

    const [, payloadText] = writeSpy.mock.calls[writeSpy.mock.calls.length - 1];
    const payload = JSON.parse(payloadText);
    expect(payload.memoryConsistency).toEqual(expect.objectContaining({
      status: 'in_sync',
      synced: true,
      summary: expect.objectContaining({
        knowledgeEntryCount: 15,
        knowledgeNodeCount: 15,
      }),
    }));

    writeSpy.mockRestore();
  });

  test('opens a Hyperliquid ETH short after approved crypto SELL consensus', async () => {
    jest.spyOn(macroRiskGate, 'assessMacroRisk').mockResolvedValue({
      regime: 'red',
      score: 55,
      reason: 'defensive',
      constraints: {
        allowLongs: false,
        positionSizeMultiplier: 0.35,
      },
    });

    const consensusPhase = {
      results: [
        {
          ticker: 'ETH/USD',
          consensus: true,
          decision: 'SHORT',
          confidence: 0.86,
          agreementCount: 3,
        },
      ],
      approvedTrades: [
        {
          ticker: 'ETH/USD',
          consensus: { decision: 'SHORT' },
          riskCheck: { maxShares: 1.25 },
          referencePrice: 2100,
        },
      ],
      rejectedTrades: [],
      incompleteSignals: [],
    };
    const cryptoTradingOrchestrator = {
      clearSignals: jest.fn(),
      runPreMarket: jest.fn().mockResolvedValue({ phase: 'premarket' }),
      runConsensusRound: jest.fn().mockResolvedValue(consensusPhase),
      maybeAutoExecuteLiveConsensus: jest.fn().mockResolvedValue({
        enabled: true,
        attempted: 1,
        succeeded: 1,
        executions: [
          { ticker: 'ETH/USD', asset: 'ETH', action: 'open', ok: true },
        ],
        skipped: [],
      }),
      runMarketOpen: jest.fn().mockResolvedValue({ executions: [] }),
    };
    const hyperliquidExecutor = {
      getAccountState: jest.fn().mockResolvedValue({
        accountValue: 37,
        positions: [],
      }),
      openEthShort: jest.fn().mockResolvedValue({ ok: true, exitCode: 0, stdout: 'opened' }),
      closeEthPosition: jest.fn(),
    };
    const tradingDaemon = new SupervisorDaemon({
      store: createMockStore(),
      logger: createMockLogger(),
      memoryIndexEnabled: false,
      sleepEnabled: false,
      cryptoTradingEnabled: true,
      cryptoMonitorOnly: false,
      hyperliquidExecutionEnabled: true,
      cryptoTradingOrchestrator,
      hyperliquidExecutor,
      env: {
        ...process.env,
        SQUIDRUN_HYPERLIQUID_AUTOMATION: '1',
      },
      pidPath: '/tmp/hyperliquid-open.pid',
      statusPath: '/tmp/hyperliquid-open-status.json',
      logPath: '/tmp/hyperliquid-open.log',
      taskLogDir: '/tmp/hyperliquid-open-tasks',
      wakeSignalPath: '/tmp/hyperliquid-open-wake.signal',
    });
    jest.spyOn(tradingDaemon, 'getCryptoSymbols').mockReturnValue(['ETH/USD']);

    const result = await tradingDaemon.runCryptoConsensusPhase({
      key: 'crypto_consensus',
      marketDate: '2026-03-25',
      scheduledAt: '2026-03-25T20:00:00.000Z',
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      hyperliquidExecution: expect.objectContaining({
        enabled: true,
        attempted: 1,
        succeeded: 1,
      }),
      summary: expect.objectContaining({
        hyperliquidAction: 'open',
        hyperliquidExecuted: true,
      }),
    }));
    expect(cryptoTradingOrchestrator.runConsensusRound).toHaveBeenCalledWith(expect.objectContaining({
      autoExecuteLiveConsensus: false,
      hyperliquidExecutionDryRun: false,
      hyperliquidExecutionLeverage: 5,
    }));
    expect(cryptoTradingOrchestrator.maybeAutoExecuteLiveConsensus).toHaveBeenCalledWith(
      consensusPhase.results,
      [
        expect.objectContaining({
          ticker: 'ETH/USD',
          riskCheck: expect.objectContaining({
            maxShares: 0.4375,
          }),
        }),
      ],
      expect.any(Object),
      expect.objectContaining({
        autoExecuteLiveConsensus: false,
        hyperliquidExecutionLeverage: 5,
      })
    );
    expect(cryptoTradingOrchestrator.runMarketOpen).not.toHaveBeenCalled();
    expect(hyperliquidExecutor.getAccountState).toHaveBeenCalled();
    expect(hyperliquidExecutor.closeEthPosition).not.toHaveBeenCalled();
    expect(hyperliquidExecutor.openEthShort).not.toHaveBeenCalled();

    await tradingDaemon.stop('test-cleanup-hyperliquid-open');
  });

  test('uses the more restrictive of consensus sizing and macro sizing instead of multiplying them together', async () => {
    jest.spyOn(macroRiskGate, 'assessMacroRisk').mockResolvedValue({
      regime: 'red',
      score: 55,
      reason: 'defensive',
      constraints: {
        allowLongs: false,
        positionSizeMultiplier: 0.25,
      },
    });

    const consensusPhase = {
      results: [
        {
          ticker: 'WLD/USD',
          consensus: true,
          decision: 'SELL',
          confidence: 0.81,
          agreementCount: 2,
        },
      ],
      approvedTrades: [
        {
          ticker: 'WLD/USD',
          assetClass: 'crypto',
          consensus: { decision: 'SELL' },
          riskCheck: {
            maxShares: 1,
            positionNotional: 25,
            margin: 5,
          },
          sizeGuide: {
            bucket: 'tiny',
            sizeMultiplier: 0.25,
          },
          referencePrice: 0.25,
        },
      ],
      rejectedTrades: [],
      incompleteSignals: [],
      killSwitch: { triggered: false },
      defiStatus: {},
    };
    const cryptoTradingOrchestrator = {
      clearSignals: jest.fn(),
      runPreMarket: jest.fn().mockResolvedValue({ phase: 'premarket' }),
      runConsensusRound: jest.fn().mockResolvedValue(consensusPhase),
      maybeAutoExecuteLiveConsensus: jest.fn().mockResolvedValue({
        enabled: true,
        attempted: 1,
        succeeded: 1,
        executions: [{ ticker: 'WLD/USD', asset: 'WLD', action: 'open', ok: true }],
        skipped: [],
      }),
      runMarketOpen: jest.fn().mockResolvedValue({ executions: [] }),
    };
    const tradingDaemon = new SupervisorDaemon({
      store: createMockStore(),
      logger: createMockLogger(),
      memoryIndexEnabled: false,
      sleepEnabled: false,
      cryptoTradingEnabled: true,
      cryptoMonitorOnly: false,
      hyperliquidExecutionEnabled: true,
      cryptoTradingOrchestrator,
      env: {
        ...process.env,
        SQUIDRUN_HYPERLIQUID_AUTOMATION: '1',
      },
      pidPath: '/tmp/hyperliquid-size-cap.pid',
      statusPath: '/tmp/hyperliquid-size-cap-status.json',
      logPath: '/tmp/hyperliquid-size-cap.log',
      taskLogDir: '/tmp/hyperliquid-size-cap-tasks',
      wakeSignalPath: '/tmp/hyperliquid-size-cap-wake.signal',
    });
    jest.spyOn(tradingDaemon, 'getCryptoSymbols').mockReturnValue(['WLD/USD']);

    await tradingDaemon.runCryptoConsensusPhase({
      key: 'market_scanner_trigger',
      marketDate: '2026-04-05',
      scheduledAt: '2026-04-05T20:00:00.000Z',
    });

    expect(cryptoTradingOrchestrator.maybeAutoExecuteLiveConsensus).toHaveBeenCalledWith(
      consensusPhase.results,
      [
        expect.objectContaining({
          ticker: 'WLD/USD',
          riskCheck: expect.objectContaining({
            maxShares: 1,
            positionNotional: 25,
            margin: 5,
          }),
          sizeGuide: expect.objectContaining({
            sizeMultiplier: 0.25,
            macroSizeMultiplier: 0.25,
            effectiveSizeMultiplier: 0.25,
          }),
        }),
      ],
      expect.any(Object),
      expect.objectContaining({ autoExecuteLiveConsensus: false })
    );

    await tradingDaemon.stop('test-cleanup-hyperliquid-size-cap');
  });

  test('fails closed when macro risk assessment errors during crypto consensus', async () => {
    const cryptoTradingOrchestrator = {
      clearSignals: jest.fn(),
      runPreMarket: jest.fn().mockResolvedValue({ phase: 'premarket' }),
      runConsensusRound: jest.fn().mockResolvedValue({
        ok: true,
        approvedTrades: [],
        rejectedTrades: [],
        incompleteSignals: [],
        results: [],
        defiStatus: {},
      }),
      maybeAutoExecuteLiveConsensus: jest.fn().mockResolvedValue({
        enabled: false,
        attempted: 0,
        succeeded: 0,
        executions: [],
        skipped: [],
      }),
      runMarketOpen: jest.fn(),
    };
    const tradingDaemon = new SupervisorDaemon({
      store: createMockStore(),
      logger: createMockLogger(),
      memoryIndexEnabled: false,
      sleepEnabled: false,
      cryptoTradingEnabled: true,
      cryptoMonitorOnly: false,
      hyperliquidExecutionEnabled: true,
      cryptoTradingOrchestrator,
      pidPath: '/tmp/macro-fallback.pid',
      statusPath: '/tmp/macro-fallback-status.json',
      logPath: '/tmp/macro-fallback.log',
      taskLogDir: '/tmp/macro-fallback-tasks',
      wakeSignalPath: '/tmp/macro-fallback-wake.signal',
    });
    jest.spyOn(tradingDaemon, 'getCryptoSymbols').mockReturnValue(['BTC/USD']);
    jest.spyOn(macroRiskGate, 'assessMacroRisk').mockRejectedValue(new Error('macro offline'));

    const result = await tradingDaemon.runCryptoConsensusPhase({
      key: 'crypto_consensus',
      marketDate: '2026-04-05',
      scheduledAt: '2026-04-05T20:00:00.000Z',
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      summary: expect.objectContaining({
        approvedTrades: 0,
      }),
    }));
    expect(cryptoTradingOrchestrator.runConsensusRound).toHaveBeenCalledWith(expect.objectContaining({
      macroRisk: expect.objectContaining({
        regime: 'red',
        score: 100,
        reason: 'macro gate error defensive fallback',
        constraints: expect.objectContaining({
          allowLongs: false,
          blockNewPositions: true,
          positionSizeMultiplier: 0.25,
        }),
      }),
    }));

    await tradingDaemon.stop('test-cleanup-macro-fallback');
  });

  test('keeps Hyperliquid auto-execution disabled when crypto execution is monitor-only', async () => {
    jest.spyOn(macroRiskGate, 'assessMacroRisk').mockResolvedValue({
      regime: 'red',
      score: 55,
      reason: 'defensive',
      constraints: {
        allowLongs: false,
        positionSizeMultiplier: 1,
      },
    });

    const consensusPhase = {
      results: [
        {
          ticker: 'ETH/USD',
          consensus: true,
          decision: 'SELL',
          confidence: 0.86,
          agreementCount: 3,
        },
      ],
      approvedTrades: [
        {
          ticker: 'ETH/USD',
          consensus: { decision: 'SHORT' },
          riskCheck: { maxShares: 1.25 },
          referencePrice: 2100,
        },
      ],
      rejectedTrades: [],
      incompleteSignals: [],
    };
    const cryptoTradingOrchestrator = {
      clearSignals: jest.fn(),
      runPreMarket: jest.fn().mockResolvedValue({ phase: 'premarket' }),
      runConsensusRound: jest.fn().mockResolvedValue(consensusPhase),
      maybeAutoExecuteLiveConsensus: jest.fn().mockResolvedValue({
        enabled: false,
        attempted: 0,
        succeeded: 0,
        executions: [],
        skipped: [],
      }),
      runMarketOpen: jest.fn(),
    };
    const hyperliquidExecutor = {
      getAccountState: jest.fn().mockResolvedValue({
        accountValue: 37,
        positions: [],
      }),
      openEthShort: jest.fn().mockResolvedValue({ ok: true, exitCode: 0, stdout: 'opened' }),
      closeEthPosition: jest.fn(),
    };
    const tradingDaemon = new SupervisorDaemon({
      store: createMockStore(),
      logger: createMockLogger(),
      memoryIndexEnabled: false,
      sleepEnabled: false,
      cryptoTradingEnabled: true,
      cryptoMonitorOnly: true,
      hyperliquidExecutionEnabled: true,
      cryptoTradingOrchestrator,
      hyperliquidExecutor,
      pidPath: '/tmp/hyperliquid-monitor-only.pid',
      statusPath: '/tmp/hyperliquid-monitor-only-status.json',
      logPath: '/tmp/hyperliquid-monitor-only.log',
      taskLogDir: '/tmp/hyperliquid-monitor-only-tasks',
      wakeSignalPath: '/tmp/hyperliquid-monitor-only-wake.signal',
    });
    jest.spyOn(tradingDaemon, 'getCryptoSymbols').mockReturnValue(['ETH/USD']);

    const result = await tradingDaemon.runCryptoConsensusPhase({
      key: 'crypto_consensus',
      marketDate: '2026-03-25',
      scheduledAt: '2026-03-25T20:00:00.000Z',
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      execution: null,
      hyperliquidExecution: expect.objectContaining({
        enabled: false,
        attempted: 0,
      }),
      summary: expect.objectContaining({
        approvedTrades: 0,
        executedTrades: 0,
        hyperliquidAction: 'none',
        hyperliquidExecuted: false,
        monitorOnly: true,
      }),
    }));
    expect(cryptoTradingOrchestrator.runMarketOpen).not.toHaveBeenCalled();
    expect(cryptoTradingOrchestrator.runConsensusRound).toHaveBeenCalledWith(expect.objectContaining({
      autoExecuteLiveConsensus: false,
    }));
    expect(cryptoTradingOrchestrator.maybeAutoExecuteLiveConsensus).toHaveBeenCalledWith(
      consensusPhase.results,
      [],
      expect.any(Object),
      expect.objectContaining({
        autoExecuteLiveConsensus: false,
      })
    );
    expect(hyperliquidExecutor.openEthShort).not.toHaveBeenCalled();

    await tradingDaemon.stop('test-cleanup-hyperliquid-monitor-only');
  });

  test('does not auto-close a Hyperliquid position on profit giveback alone', async () => {
    const hyperliquidMonitorOrchestrator = {
      runDefiMonitorCycle: jest.fn().mockResolvedValue({
        ok: true,
        checkedAt: '2026-03-29T01:05:00.000Z',
        accountValue: 703.8,
        positions: [
          {
            coin: 'ETH',
            side: 'short',
            size: -1.7113,
            entryPx: 2008.1,
            unrealizedPnl: 12.83,
            liquidationPx: 2361.69,
            peakUnrealizedPnl: 24.98,
            retainedPeakRatio: 0.51,
            drawdownFromPeakPct: 0.5,
            previousGivebackAlertThreshold: 0.3,
            warningLevel: 'urgent',
          },
        ],
        warnings: [{ level: 'urgent', code: 'defi_profit_giveback_urgent' }],
        telegramAlerts: [{ level: 'urgent' }],
        peakStatePath: '/tmp/defi-peak-pnl.json',
      }),
      syncDefiPeakStateFromStatus: jest.fn().mockResolvedValue({
        ok: true,
        checkedAt: '2026-03-29T01:05:01.000Z',
        positions: [],
        peakStatePath: '/tmp/defi-peak-pnl.json',
      }),
    };
    const hyperliquidExecutor = {
      getAccountState: jest.fn().mockResolvedValue({ accountValue: 700, positions: [] }),
      openEthShort: jest.fn(),
      closePosition: jest.fn().mockResolvedValue({ ok: true, exitCode: 0, stdout: 'closed' }),
    };
    const monitorDaemon = new SupervisorDaemon({
      store: createMockStore(),
      logger: createMockLogger(),
      memoryIndexEnabled: false,
      sleepEnabled: false,
      cryptoTradingEnabled: true,
      circuitBreaker: null,
      hyperliquidMonitorEnabled: true,
      hyperliquidExecutionEnabled: true,
      hyperliquidExecutor,
      hyperliquidMonitorOrchestrator,
      env: {
        ...process.env,
        SQUIDRUN_HYPERLIQUID_AUTOMATION: '1',
      },
      pidPath: '/tmp/hyperliquid-risk-exit.pid',
      statusPath: '/tmp/hyperliquid-risk-exit-status.json',
      logPath: '/tmp/hyperliquid-risk-exit.log',
      taskLogDir: '/tmp/hyperliquid-risk-exit-tasks',
      wakeSignalPath: '/tmp/hyperliquid-risk-exit-wake.signal',
    });
    monitorDaemon.writeStatus = jest.fn();

    const result = await monitorDaemon.runHyperliquidPositionMonitorCycle('manual');

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      warnings: [{ level: 'urgent', code: 'defi_profit_giveback_urgent' }],
    }));
    expect(hyperliquidExecutor.closePosition).not.toHaveBeenCalled();
    expect(hyperliquidMonitorOrchestrator.syncDefiPeakStateFromStatus).not.toHaveBeenCalled();
    expect(monitorDaemon.lastHyperliquidMonitorSummary).toEqual(expect.objectContaining({
      riskExit: expect.objectContaining({
        attempted: false,
        reason: 'no_risk_exit_signal',
      }),
    }));
  });

  test('does not auto-close a Hyperliquid position during startup monitor pass', async () => {
    const hyperliquidMonitorOrchestrator = {
      runDefiMonitorCycle: jest.fn().mockResolvedValue({
        ok: true,
        checkedAt: '2026-03-29T01:05:00.000Z',
        accountValue: 703.8,
        positions: [
          {
            coin: 'ETH',
            side: 'short',
            size: -1.7113,
            entryPx: 2008.1,
            unrealizedPnl: -8.12,
            markPrice: 2080.5,
            liquidationPx: 2361.69,
            stopLossPrice: 2075,
            peakUnrealizedPnl: 17.46,
            retainedPeakRatio: -0.4651,
            drawdownFromPeakPct: 1,
            previousGivebackAlertThreshold: 0.5,
            warningLevel: 'critical',
          },
        ],
        warnings: [{ level: 'critical', code: 'defi_liquidation_risk_critical' }],
        telegramAlerts: [],
        peakStatePath: '/tmp/defi-peak-pnl.json',
      }),
    };
    const hyperliquidExecutor = {
      getAccountState: jest.fn(),
      closePosition: jest.fn(),
    };
    const monitorDaemon = new SupervisorDaemon({
      store: createMockStore(),
      logger: createMockLogger(),
      memoryIndexEnabled: false,
      sleepEnabled: false,
      cryptoTradingEnabled: true,
      hyperliquidMonitorEnabled: true,
      hyperliquidExecutionEnabled: true,
      hyperliquidExecutor,
      hyperliquidMonitorOrchestrator,
      env: {
        ...process.env,
        SQUIDRUN_HYPERLIQUID_AUTOMATION: '1',
      },
      pidPath: '/tmp/hyperliquid-startup-grace.pid',
      statusPath: '/tmp/hyperliquid-startup-grace-status.json',
      logPath: '/tmp/hyperliquid-startup-grace.log',
      taskLogDir: '/tmp/hyperliquid-startup-grace-tasks',
      wakeSignalPath: '/tmp/hyperliquid-startup-grace-wake.signal',
    });
    monitorDaemon.writeStatus = jest.fn();

    await monitorDaemon.runHyperliquidPositionMonitorCycle('startup');

    expect(hyperliquidExecutor.closePosition).not.toHaveBeenCalled();
    expect(monitorDaemon.lastHyperliquidMonitorSummary).toEqual(expect.objectContaining({
      riskExit: expect.objectContaining({
        attempted: false,
        reason: 'startup_grace',
      }),
    }));
  });

  test('sends a trading Telegram alert when a Hyperliquid position gives back 30% from peak', async () => {
    const hyperliquidMonitorOrchestrator = {
      runDefiMonitorCycle: jest.fn().mockResolvedValue({
        ok: true,
        checkedAt: '2026-03-29T01:05:00.000Z',
        accountValue: 703.8,
        positions: [
          {
            coin: 'LINK',
            side: 'short',
            size: -129.6,
            entryPx: 8.5616,
            unrealizedPnl: 11.5,
            markPrice: 8.49,
            liquidationPx: 9.78,
            peakUnrealizedPnl: 16.43,
            retainedPeakRatio: 0.7,
            drawdownFromPeakPct: 0.3,
            previousGivebackAlertThreshold: 0,
            warningLevel: 'warning',
          },
        ],
        warnings: [{ level: 'warning', code: 'defi_profit_giveback_warning' }],
        telegramAlerts: [],
        peakStatePath: '/tmp/defi-peak-pnl.json',
      }),
    };
    const hyperliquidExecutor = {
      getAccountState: jest.fn(),
      closePosition: jest.fn(),
    };
    const monitorDaemon = new SupervisorDaemon({
      store: createMockStore(),
      logger: createMockLogger(),
      memoryIndexEnabled: false,
      sleepEnabled: false,
      cryptoTradingEnabled: true,
      hyperliquidMonitorEnabled: true,
      hyperliquidExecutionEnabled: true,
      hyperliquidExecutor,
      hyperliquidMonitorOrchestrator,
      env: {
        ...process.env,
        SQUIDRUN_HYPERLIQUID_AUTOMATION: '1',
      },
      pidPath: '/tmp/hyperliquid-giveback-alert.pid',
      statusPath: '/tmp/hyperliquid-giveback-alert-status.json',
      logPath: '/tmp/hyperliquid-giveback-alert.log',
      taskLogDir: '/tmp/hyperliquid-giveback-alert-tasks',
      wakeSignalPath: '/tmp/hyperliquid-giveback-alert-wake.signal',
    });
    monitorDaemon.notifyTelegramTrading = jest.fn();
    monitorDaemon.writeStatus = jest.fn();

    await monitorDaemon.runHyperliquidPositionMonitorCycle('manual');

    expect(monitorDaemon.notifyTelegramTrading).toHaveBeenCalledWith(expect.stringContaining('LINK SHORT has given back 30% of peak PnL'));
    expect(hyperliquidExecutor.closePosition).not.toHaveBeenCalled();
  });

  test('auto-closes when mark price crosses the stored Hyperliquid stop loss', async () => {
    const hyperliquidMonitorOrchestrator = {
      runDefiMonitorCycle: jest.fn().mockResolvedValue({
        ok: true,
        checkedAt: '2026-03-29T01:05:00.000Z',
        accountValue: 703.8,
        positions: [
          {
            coin: 'ETH',
            side: 'short',
            size: -1.7113,
            entryPx: 2008.1,
            unrealizedPnl: -8.12,
            markPrice: 2080.5,
            liquidationPx: 2361.69,
            stopLossPrice: 2075,
            stopLossVerifiedAt: '2026-03-29T01:04:59.000Z',
            peakUnrealizedPnl: 17.46,
            retainedPeakRatio: -0.4651,
            drawdownFromPeakPct: 1,
            previousGivebackAlertThreshold: 0.5,
            warningLevel: 'warning',
          },
        ],
        warnings: [{ level: 'warning', code: 'defi_profit_giveback_warning' }],
        telegramAlerts: [],
        peakStatePath: '/tmp/defi-peak-pnl.json',
      }),
      syncDefiPeakStateFromStatus: jest.fn().mockResolvedValue({
        ok: true,
        checkedAt: '2026-03-29T01:05:01.000Z',
        positions: [],
        peakStatePath: '/tmp/defi-peak-pnl.json',
      }),
    };
    const hyperliquidExecutor = {
      getAccountState: jest.fn().mockResolvedValue({ accountValue: 700, positions: [] }),
      closePosition: jest.fn().mockResolvedValue({ ok: true, exitCode: 0, stdout: 'closed' }),
    };
    const monitorDaemon = new SupervisorDaemon({
      store: createMockStore(),
      logger: createMockLogger(),
      memoryIndexEnabled: false,
      sleepEnabled: false,
      cryptoTradingEnabled: true,
      hyperliquidMonitorEnabled: true,
      hyperliquidExecutionEnabled: true,
      hyperliquidExecutor,
      hyperliquidMonitorOrchestrator,
      env: {
        ...process.env,
        SQUIDRUN_HYPERLIQUID_AUTOMATION: '1',
      },
      pidPath: '/tmp/hyperliquid-stop-loss.pid',
      statusPath: '/tmp/hyperliquid-stop-loss-status.json',
      logPath: '/tmp/hyperliquid-stop-loss.log',
      taskLogDir: '/tmp/hyperliquid-stop-loss-tasks',
      wakeSignalPath: '/tmp/hyperliquid-stop-loss-wake.signal',
    });
    monitorDaemon.notifyTelegramTrading = jest.fn();
    monitorDaemon.writeStatus = jest.fn();

    await monitorDaemon.runHyperliquidPositionMonitorCycle('manual');

    expect(hyperliquidExecutor.closePosition).not.toHaveBeenCalled();
    expect(hyperliquidMonitorOrchestrator.syncDefiPeakStateFromStatus).not.toHaveBeenCalled();
    expect(monitorDaemon.notifyTelegramTrading).toHaveBeenCalledWith(expect.stringContaining('stop_loss_crossed'));
    expect(monitorDaemon.lastHyperliquidMonitorSummary).toEqual(expect.objectContaining({
      riskExit: expect.objectContaining({
        attempted: false,
        reason: 'manual_only_alerted',
      }),
    }));
  });

  test('auto-closes when a Hyperliquid position reaches critical liquidation warning level', async () => {
    const hyperliquidMonitorOrchestrator = {
      runDefiMonitorCycle: jest.fn().mockResolvedValue({
        ok: true,
        checkedAt: '2026-03-29T01:05:00.000Z',
        accountValue: 703.8,
        positions: [
          {
            coin: 'ETH',
            side: 'short',
            size: -1.7113,
            entryPx: 2008.1,
            unrealizedPnl: -11.4,
            markPrice: 2331.5,
            liquidationPx: 2361.69,
            peakUnrealizedPnl: 17.46,
            retainedPeakRatio: -0.6529,
            drawdownFromPeakPct: 1,
            previousGivebackAlertThreshold: 0.3,
            warningLevel: 'critical',
          },
        ],
        warnings: [{ level: 'critical', code: 'defi_liquidation_risk_critical' }],
        telegramAlerts: [],
        peakStatePath: '/tmp/defi-peak-pnl.json',
      }),
      syncDefiPeakStateFromStatus: jest.fn().mockResolvedValue({
        ok: true,
        checkedAt: '2026-03-29T01:05:01.000Z',
        positions: [],
        peakStatePath: '/tmp/defi-peak-pnl.json',
      }),
    };
    const hyperliquidExecutor = {
      getAccountState: jest.fn().mockResolvedValue({ accountValue: 700, positions: [] }),
      closePosition: jest.fn().mockResolvedValue({ ok: true, exitCode: 0, stdout: 'closed' }),
    };
    const monitorDaemon = new SupervisorDaemon({
      store: createMockStore(),
      logger: createMockLogger(),
      memoryIndexEnabled: false,
      sleepEnabled: false,
      cryptoTradingEnabled: true,
      hyperliquidMonitorEnabled: true,
      hyperliquidExecutionEnabled: true,
      hyperliquidExecutor,
      hyperliquidMonitorOrchestrator,
      env: {
        ...process.env,
        SQUIDRUN_HYPERLIQUID_AUTOMATION: '1',
      },
      pidPath: '/tmp/hyperliquid-critical-risk.pid',
      statusPath: '/tmp/hyperliquid-critical-risk-status.json',
      logPath: '/tmp/hyperliquid-critical-risk.log',
      taskLogDir: '/tmp/hyperliquid-critical-risk-tasks',
      wakeSignalPath: '/tmp/hyperliquid-critical-risk-wake.signal',
    });
    monitorDaemon.notifyTelegramTrading = jest.fn();
    monitorDaemon.writeStatus = jest.fn();

    await monitorDaemon.runHyperliquidPositionMonitorCycle('manual');

    expect(hyperliquidExecutor.closePosition).not.toHaveBeenCalled();
    expect(hyperliquidMonitorOrchestrator.syncDefiPeakStateFromStatus).not.toHaveBeenCalled();
    expect(monitorDaemon.notifyTelegramTrading).toHaveBeenCalledWith(expect.stringContaining('liquidation_risk'));
    expect(monitorDaemon.lastHyperliquidMonitorSummary).toEqual(expect.objectContaining({
      riskExit: expect.objectContaining({
        attempted: false,
        reason: 'manual_only_alerted',
      }),
    }));
  });

  test('closes an existing Hyperliquid ETH short on bullish consensus even when BUYs are macro-blocked', async () => {
    jest.spyOn(macroRiskGate, 'assessMacroRisk').mockResolvedValue({
      regime: 'red',
      score: 55,
      reason: 'defensive',
      constraints: {
        allowLongs: false,
        positionSizeMultiplier: 1,
      },
    });

    const consensusPhase = {
      results: [
        {
          ticker: 'ETH/USD',
          consensus: true,
          decision: 'BUY',
          confidence: 0.82,
          agreementCount: 3,
        },
      ],
      approvedTrades: [
        {
          ticker: 'ETH/USD',
          consensus: { decision: 'BUY' },
          riskCheck: { maxShares: 1.1 },
          referencePrice: 2050,
        },
      ],
      rejectedTrades: [],
      incompleteSignals: [],
    };
    const cryptoTradingOrchestrator = {
      clearSignals: jest.fn(),
      runPreMarket: jest.fn().mockResolvedValue({ phase: 'premarket' }),
      runConsensusRound: jest.fn().mockResolvedValue(consensusPhase),
      maybeAutoExecuteLiveConsensus: jest.fn().mockResolvedValue({
        enabled: true,
        attempted: 1,
        succeeded: 1,
        executions: [
          { ticker: 'ETH/USD', asset: 'ETH', action: 'close', ok: true },
        ],
        skipped: [],
      }),
      runMarketOpen: jest.fn(),
    };
    const hyperliquidExecutor = {
      getAccountState: jest.fn().mockResolvedValue({
        accountValue: 37,
        positions: [
          { coin: 'ETH', size: -0.12, side: 'short', entryPx: 2100, unrealizedPnl: 4.2, liquidationPx: 2400 },
        ],
      }),
      openEthShort: jest.fn(),
      closeEthPosition: jest.fn().mockResolvedValue({ ok: true, exitCode: 0, stdout: 'closed' }),
    };
    const tradingDaemon = new SupervisorDaemon({
      store: createMockStore(),
      logger: createMockLogger(),
      memoryIndexEnabled: false,
      sleepEnabled: false,
      cryptoTradingEnabled: true,
      cryptoMonitorOnly: false,
      hyperliquidExecutionEnabled: true,
      cryptoTradingOrchestrator,
      hyperliquidExecutor,
      env: {
        ...process.env,
        SQUIDRUN_HYPERLIQUID_AUTOMATION: '1',
      },
      pidPath: '/tmp/hyperliquid-close.pid',
      statusPath: '/tmp/hyperliquid-close-status.json',
      logPath: '/tmp/hyperliquid-close.log',
      taskLogDir: '/tmp/hyperliquid-close-tasks',
      wakeSignalPath: '/tmp/hyperliquid-close-wake.signal',
    });
    jest.spyOn(tradingDaemon, 'getCryptoSymbols').mockReturnValue(['ETH/USD']);

    const result = await tradingDaemon.runCryptoConsensusPhase({
      key: 'crypto_consensus',
      marketDate: '2026-03-25',
      scheduledAt: '2026-03-25T20:00:00.000Z',
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      hyperliquidExecution: expect.objectContaining({
        enabled: true,
        attempted: 1,
        succeeded: 1,
      }),
      summary: expect.objectContaining({
        approvedTrades: 1,
        executedTrades: 0,
        hyperliquidAction: 'close',
        hyperliquidExecuted: true,
      }),
    }));
    expect(cryptoTradingOrchestrator.runMarketOpen).not.toHaveBeenCalled();
    expect(cryptoTradingOrchestrator.runConsensusRound).toHaveBeenCalledWith(expect.objectContaining({
      autoExecuteLiveConsensus: false,
    }));
    expect(cryptoTradingOrchestrator.maybeAutoExecuteLiveConsensus).toHaveBeenCalledWith(
      consensusPhase.results,
      expect.arrayContaining([
        expect.objectContaining({
          ticker: 'ETH/USD',
        }),
      ]),
      expect.any(Object),
      expect.objectContaining({
        autoExecuteLiveConsensus: false,
      })
    );
    expect(hyperliquidExecutor.getAccountState).toHaveBeenCalled();
    expect(hyperliquidExecutor.closeEthPosition).not.toHaveBeenCalled();
    expect(hyperliquidExecutor.openEthShort).not.toHaveBeenCalled();

    await tradingDaemon.stop('test-cleanup-hyperliquid-close');
  });

  test('runs the Tokenomist unlock scan every 6 hours and stores the parsed result', async () => {
    const tokenomistScriptPath = path.join(tempRoot, 'hm-tokenomist-unlocks.js');
    fs.writeFileSync(tokenomistScriptPath, [
      'console.log(JSON.stringify({',
      '  ok: true,',
      '  sourcePath: "tokenomist-current.yml",',
      '  maxHours: 48,',
      '  unlockCount: 1,',
      '  unlocks: [{ token: "ARB", unlockAt: "2026-04-16T18:00:00.000Z", unlockSizeText: "$10.77M", recipientType: "unknown", hyperliquidVolumeUsd24h: 45678901 }]',
      '}));',
    ].join('\n'));

    const tokenomistDaemon = new SupervisorDaemon({
      store: createMockStore(),
      logger: createMockLogger(),
      memoryIndexEnabled: false,
      sleepEnabled: false,
      cryptoTradingEnabled: false,
      tokenomistEnabled: true,
      tokenomistIntervalMinutes: 360,
      tokenomistUnlocksScriptPath: tokenomistScriptPath,
      pidPath: path.join(tempRoot, 'tokenomist.pid'),
      statusPath: path.join(tempRoot, 'tokenomist-status.json'),
      logPath: path.join(tempRoot, 'tokenomist.log'),
      taskLogDir: path.join(tempRoot, 'tokenomist-tasks'),
      wakeSignalPath: path.join(tempRoot, 'tokenomist-wake.signal'),
      tokenomistStatePath: path.join(tempRoot, 'tokenomist-state.json'),
    });

    try {
      tokenomistDaemon.tokenomistState.lastProcessedAt = '2026-04-15T00:00:00.000Z';

      const result = await tokenomistDaemon.maybeRunTokenomistAutomation(Date.parse('2026-04-15T06:05:00.000Z'));

      expect(result).toEqual(expect.objectContaining({ ok: true, skipped: false }));
      expect(tokenomistDaemon.lastTokenomistSummary).toEqual(expect.objectContaining({
        status: 'scan_complete',
        lastProcessedAt: '2026-04-15T06:00:00.000Z',
      }));
      expect(tokenomistDaemon.tokenomistState.lastResult).toEqual(expect.objectContaining({
        ok: true,
        unlockCount: 1,
        unlocks: expect.arrayContaining([
          expect.objectContaining({ token: 'ARB' }),
        ]),
      }));
    } finally {
      await tokenomistDaemon.stop('test-cleanup-tokenomist');
    }
  });

  test('runs the spark monitor lane and alerts Architect and Telegram on new catalyst events', async () => {
    sparkCapture.runSparkScan.mockResolvedValueOnce({
      ok: true,
      scannedAt: '2026-04-23T09:01:00.000Z',
      upbitListingCount: 1,
      hyperliquidListingCount: 1,
      tokenUnlockCount: 1,
      newAlertEvents: [
        { eventKey: 'upbit:9999', tickers: ['CHIP/USD'] },
      ],
      firePlans: [],
      alertMessage: '[LIVE SPARK] New catalyst alerts\n- UPBIT Test notice | CHIP/USD | entry 0.1-0.101 stop 0.097 tp1 0.12',
    });

    const sparkDaemon = new SupervisorDaemon({
      store: createMockStore(),
      logger: createMockLogger(),
      memoryIndexEnabled: false,
      sleepEnabled: false,
      cryptoTradingEnabled: false,
      tokenomistEnabled: false,
      sparkMonitorEnabled: true,
      sparkMonitorIntervalMinutes: 1,
      pidPath: path.join(tempRoot, 'spark.pid'),
      statusPath: path.join(tempRoot, 'spark-status.json'),
      logPath: path.join(tempRoot, 'spark.log'),
      taskLogDir: path.join(tempRoot, 'spark-tasks'),
      wakeSignalPath: path.join(tempRoot, 'spark-wake.signal'),
      sparkMonitorStatePath: path.join(tempRoot, 'spark-monitor-state.json'),
      sparkMonitorDataStatePath: path.join(tempRoot, 'spark-state.json'),
      sparkMonitorEventsPath: path.join(tempRoot, 'spark-events.jsonl'),
      sparkMonitorFirePlansPath: path.join(tempRoot, 'spark-fireplans.json'),
      sparkMonitorWatchlistPath: path.join(tempRoot, 'spark-watchlist.json'),
    });

    try {
      sparkDaemon.sparkMonitorState.lastProcessedAt = '2026-04-23T08:58:00.000Z';
      sparkDaemon.notifyArchitectInternal = jest.fn();
      sparkDaemon.notifyTelegramTrading = jest.fn();

      const result = await sparkDaemon.maybeRunSparkAutomation(Date.parse('2026-04-23T09:01:30.000Z'));

      expect(result).toEqual(expect.objectContaining({ ok: true, skipped: false }));
      expect(sparkCapture.runSparkScan).toHaveBeenCalledWith(expect.objectContaining({
        statePath: path.join(tempRoot, 'spark-state.json'),
        eventsPath: path.join(tempRoot, 'spark-events.jsonl'),
        firePlansPath: path.join(tempRoot, 'spark-fireplans.json'),
        watchlistPath: path.join(tempRoot, 'spark-watchlist.json'),
      }));
      expect(sparkDaemon.lastSparkMonitorSummary).toEqual(expect.objectContaining({
        status: 'scan_complete',
        alertCount: 1,
        upbitListingCount: 1,
        hyperliquidListingCount: 1,
        tokenUnlockCount: 1,
      }));
      expect(sparkDaemon.notifyArchitectInternal).toHaveBeenCalledWith(
        '[LIVE SPARK] New catalyst alerts\n- UPBIT Test notice | CHIP/USD | entry 0.1-0.101 stop 0.097 tp1 0.12',
        'spark_monitor'
      );
      expect(sparkDaemon.notifyTelegramTrading).toHaveBeenCalledWith(
        expect.stringContaining('[LIVE SPARK] New catalyst alerts')
      );
    } finally {
      await sparkDaemon.stop('test-cleanup-spark-monitor');
    }
  });

  test('runs the market scanner loop and alerts Architect on ORDI-pattern movers', async () => {
    const originalScannerAutomation = process.env.SQUIDRUN_MARKET_SCANNER_AUTOMATION;
    process.env.SQUIDRUN_MARKET_SCANNER_AUTOMATION = '1';
    const scanDaemon = new SupervisorDaemon({
      store: createMockStore(),
      logger: createMockLogger(),
      memoryIndexEnabled: false,
      sleepEnabled: false,
      cryptoTradingEnabled: false,
      marketScannerEnabled: true,
      marketScannerImmediateConsultationEnabled: true,
      marketScannerIntervalMinutes: 30,
      marketScanner: {
        runMarketScan: jest.fn().mockResolvedValue({
          scannedAt: '2026-04-05T01:00:00.000Z',
          assetCount: 132,
          flaggedMovers: [{
            coin: 'ORDI',
            ticker: 'ORDI/USD',
            direction: 'DOWN',
            price: 1.21,
            change4hPct: -0.073,
            change24hPct: 0.22,
            volumeUsd24h: 185000000,
            fundingRate: -0.00004,
            flagged: true,
          }],
          topMovers: [{
            coin: 'ORDI',
            ticker: 'ORDI/USD',
            flagged: true,
          }],
          alerts: [{
            coin: 'ORDI',
            ticker: 'ORDI/USD',
            direction: 'DOWN',
            price: 1.21,
            change4hPct: -0.073,
            change24hPct: 0.22,
            volumeUsd24h: 185000000,
            fundingRate: -0.00004,
            flagged: true,
          }],
          state: {
            updatedAt: '2026-04-05T01:00:00.000Z',
            lastScanAt: '2026-04-05T01:00:00.000Z',
            assetCount: 132,
            topMovers: [{
              coin: 'ORDI',
              ticker: 'ORDI/USD',
              flagged: true,
            }],
            flaggedMovers: [{
              coin: 'ORDI',
              ticker: 'ORDI/USD',
              direction: 'DOWN',
              price: 1.21,
              change4hPct: -0.073,
              change24hPct: 0.22,
              volumeUsd24h: 185000000,
              fundingRate: -0.00004,
              flagged: true,
            }],
            history: {},
            lastAlertFingerprintByCoin: {
              ORDI: '{"direction":"DOWN"}',
            },
          },
        }),
      },
      pidPath: path.join(tempRoot, 'scanner.pid'),
      statusPath: path.join(tempRoot, 'scanner-status.json'),
      logPath: path.join(tempRoot, 'scanner.log'),
      taskLogDir: path.join(tempRoot, 'scanner-tasks'),
      wakeSignalPath: path.join(tempRoot, 'scanner-wake.signal'),
      marketScannerStatePath: path.join(tempRoot, 'market-scanner-state.json'),
    });

    try {
      const architectSpy = jest.spyOn(scanDaemon, 'notifyArchitectInternal').mockImplementation(() => {});
      jest.spyOn(scanDaemon, 'filterExecutableMarketScannerMovers').mockResolvedValue([]);
      mockOrdiPatternBars('ORDI/USD');
      scanDaemon.marketScannerState.lastProcessedAt = '2026-04-05T00:00:00.000Z';

      const started = await scanDaemon.maybeRunMarketScannerAutomation(Date.parse('2026-04-05T01:05:00.000Z'));
      const result = await scanDaemon.marketScannerPhasePromise;

      expect(started).toEqual(expect.objectContaining({ ok: true, skipped: false, started: true }));
      expect(result).toEqual(expect.objectContaining({ ok: true, skipped: false }));
      expect(scanDaemon.marketScanner.runMarketScan).toHaveBeenCalledTimes(1);
      expect(scanDaemon.lastMarketScannerSummary).toEqual(expect.objectContaining({
        status: 'alert_sent',
        lastProcessedAt: '2026-04-05T01:00:00.000Z',
      }));
      expect(scanDaemon.marketScannerState.lastResult).toEqual(expect.objectContaining({
        assetCount: 132,
        flaggedCount: 1,
      }));
      expect(architectSpy).toHaveBeenCalledTimes(1);
      expect(architectSpy.mock.calls[0][0]).toContain('[PROACTIVE][MARKET]');
      expect(architectSpy.mock.calls[0][0]).toContain('ORDI');
    } finally {
      if (originalScannerAutomation == null) {
        delete process.env.SQUIDRUN_MARKET_SCANNER_AUTOMATION;
      } else {
        process.env.SQUIDRUN_MARKET_SCANNER_AUTOMATION = originalScannerAutomation;
      }
      await scanDaemon.stop('test-cleanup-market-scanner');
    }
  }, 30000);

  test('suppresses market scanner alerts that fail the ORDI source gate', async () => {
    const scanDaemon = new SupervisorDaemon({
      store: createMockStore(),
      logger: createMockLogger(),
      memoryIndexEnabled: false,
      sleepEnabled: false,
      cryptoTradingEnabled: true,
      marketScannerEnabled: true,
      marketScanner: {
        runMarketScan: jest.fn().mockResolvedValue({
          scannedAt: '2026-04-05T01:00:00.000Z',
          assetCount: 132,
          flaggedMovers: [{
            coin: 'BOME',
            ticker: 'BOME/USD',
            direction: 'UP',
            price: 0.000382,
            change4hPct: 0.0409,
            change24hPct: 0.0026,
            volumeUsd24h: 8984.99,
            fundingRate: 0.0000125,
            flagged: true,
          }],
          topMovers: [{
            coin: 'BOME',
            ticker: 'BOME/USD',
            flagged: true,
          }],
          alerts: [{
            coin: 'BOME',
            ticker: 'BOME/USD',
            direction: 'UP',
            price: 0.000382,
            change4hPct: 0.0409,
            change24hPct: 0.0026,
            volumeUsd24h: 8984.99,
            fundingRate: 0.0000125,
            flagged: true,
          }],
          state: {
            updatedAt: '2026-04-05T01:00:00.000Z',
            lastScanAt: '2026-04-05T01:00:00.000Z',
            assetCount: 132,
            topMovers: [{ coin: 'BOME', ticker: 'BOME/USD', flagged: true }],
            flaggedMovers: [{ coin: 'BOME', ticker: 'BOME/USD', direction: 'UP', change4hPct: 0.0409, change24hPct: 0.0026, volumeUsd24h: 8984.99, flagged: true }],
            history: {},
          },
        }),
      },
      pidPath: path.join(tempRoot, 'scanner-suppress.pid'),
      statusPath: path.join(tempRoot, 'scanner-suppress-status.json'),
      logPath: path.join(tempRoot, 'scanner-suppress.log'),
      taskLogDir: path.join(tempRoot, 'scanner-suppress-tasks'),
      wakeSignalPath: path.join(tempRoot, 'scanner-suppress-wake.signal'),
      marketScannerStatePath: path.join(tempRoot, 'market-scanner-suppress-state.json'),
      oracleWatchRulesPath: path.join(tempRoot, 'scanner-suppress-oracle-rules.json'),
      oracleWatchStatePath: path.join(tempRoot, 'scanner-suppress-oracle-state.json'),
      oracleShortRegimeStatePath: path.join(tempRoot, 'scanner-suppress-short-regime.json'),
    });

    try {
      const architectSpy = jest.spyOn(scanDaemon, 'notifyArchitectInternal').mockImplementation(() => {});
      const result = await scanDaemon.runMarketScannerPhase({ key: 'market_scanner' });

      expect(result.alerts).toEqual([]);
      expect(result.alertGate).toEqual(expect.objectContaining({
        policy: 'ordi_pattern_source_gate',
        rawAlertCount: 1,
        qualifiedCount: 0,
        suppressedCount: 1,
      }));
      expect(architectSpy).not.toHaveBeenCalled();
    } finally {
      await scanDaemon.stop('test-cleanup-market-scanner-suppress');
    }
  });

  test('triggers an immediate crypto mini-consultation for ORDI-gated scanner movers and promotes them into the watchlist first', async () => {
    const originalScannerAutomation = process.env.SQUIDRUN_MARKET_SCANNER_AUTOMATION;
    process.env.SQUIDRUN_MARKET_SCANNER_AUTOMATION = '1';
    const scanDaemon = new SupervisorDaemon({
      store: createMockStore(),
      logger: createMockLogger(),
      memoryIndexEnabled: false,
      sleepEnabled: false,
      cryptoTradingEnabled: true,
      marketScannerEnabled: true,
      marketScannerImmediateConsultationEnabled: true,
      marketScannerIntervalMinutes: 30,
      marketScanner: {
        runMarketScan: jest.fn().mockResolvedValue({
          scannedAt: '2026-04-05T01:00:00.000Z',
          assetCount: 132,
          flaggedMovers: [{
            coin: 'ORDI',
            ticker: 'ORDI/USD',
            direction: 'DOWN',
            price: 1.21,
            change4hPct: -0.0409,
            change24hPct: 0.22,
            volumeUsd24h: 185000000,
            fundingRate: -0.0000125,
            flagged: true,
          }],
          topMovers: [{
            coin: 'ORDI',
            ticker: 'ORDI/USD',
            flagged: true,
          }],
          alerts: [{
            coin: 'ORDI',
            ticker: 'ORDI/USD',
            direction: 'DOWN',
            price: 1.21,
            change4hPct: -0.0409,
            change24hPct: 0.22,
            volumeUsd24h: 185000000,
            fundingRate: -0.0000125,
            flagged: true,
          }],
          state: {
            updatedAt: '2026-04-05T01:00:00.000Z',
            lastScanAt: '2026-04-05T01:00:00.000Z',
            assetCount: 132,
            topMovers: [{
              coin: 'ORDI',
              ticker: 'ORDI/USD',
              direction: 'DOWN',
              price: 1.21,
              change4hPct: -0.0409,
              change24hPct: 0.22,
              volumeUsd24h: 185000000,
              fundingRate: -0.0000125,
              flagged: true,
            }],
            flaggedMovers: [{
              coin: 'ORDI',
              ticker: 'ORDI/USD',
              direction: 'DOWN',
              price: 1.21,
              change4hPct: -0.0409,
              change24hPct: 0.22,
              volumeUsd24h: 185000000,
              fundingRate: -0.0000125,
              flagged: true,
            }],
            history: {},
            lastAlertFingerprintByCoin: {
              ORDI: '{"direction":"DOWN"}',
            },
          },
        }),
      },
      cryptoTradingOrchestrator: {
        runConsensusRound: jest.fn(),
      },
      pidPath: path.join(tempRoot, 'scanner-immediate.pid'),
      statusPath: path.join(tempRoot, 'scanner-immediate-status.json'),
      logPath: path.join(tempRoot, 'scanner-immediate.log'),
      taskLogDir: path.join(tempRoot, 'scanner-immediate-tasks'),
      wakeSignalPath: path.join(tempRoot, 'scanner-immediate-wake.signal'),
      marketScannerStatePath: path.join(tempRoot, 'market-scanner-immediate-state.json'),
      dynamicWatchlistStatePath: path.join(tempRoot, 'scanner-immediate-dynamic-watchlist.json'),
    });

    try {
      const architectSpy = jest.spyOn(scanDaemon, 'notifyArchitectInternal').mockImplementation(() => {});
      const immediateConsultSpy = jest.spyOn(scanDaemon, 'triggerImmediateCryptoConsensus').mockResolvedValue({
        ok: true,
        trigger: 'market_scanner',
      });
      mockOrdiPatternBars('ORDI/USD');
      scanDaemon.marketScannerState.lastProcessedAt = '2026-04-05T00:00:00.000Z';

      const started = await scanDaemon.maybeRunMarketScannerAutomation(Date.parse('2026-04-05T01:05:00.000Z'));
      const result = await scanDaemon.marketScannerPhasePromise;

      expect(started).toEqual(expect.objectContaining({ ok: true, skipped: false, started: true }));
      expect(result).toEqual(expect.objectContaining({ ok: true, skipped: false }));
      expect(result.executed?.[0]).toEqual(expect.objectContaining({
        urgentPromotedSymbols: expect.arrayContaining(['ORDI/USD']),
      }));
      expect(immediateConsultSpy).toHaveBeenCalledWith(expect.objectContaining({
        key: 'market_scanner_trigger',
        trigger: 'market_scanner',
        symbols: ['ORDI/USD'],
      }), expect.objectContaining({
        trigger: 'market_scanner',
      }));
      expect(architectSpy).toHaveBeenCalledTimes(1);
    } finally {
      if (originalScannerAutomation == null) {
        delete process.env.SQUIDRUN_MARKET_SCANNER_AUTOMATION;
      } else {
        process.env.SQUIDRUN_MARKET_SCANNER_AUTOMATION = originalScannerAutomation;
      }
      await scanDaemon.stop('test-cleanup-market-scanner-immediate');
    }
  }, 15000);

  test('triggers an immediate crypto mini-consultation from current ORDI-gated movers even when no new alerts are emitted', async () => {
    const originalScannerAutomation = process.env.SQUIDRUN_MARKET_SCANNER_AUTOMATION;
    process.env.SQUIDRUN_MARKET_SCANNER_AUTOMATION = '1';
    const scanDaemon = new SupervisorDaemon({
      store: createMockStore(),
      logger: createMockLogger(),
      memoryIndexEnabled: false,
      sleepEnabled: false,
      cryptoTradingEnabled: true,
      marketScannerEnabled: true,
      marketScannerImmediateConsultationEnabled: true,
      marketScannerIntervalMinutes: 30,
      marketScanner: {
        runMarketScan: jest.fn().mockResolvedValue({
          scannedAt: '2026-04-05T01:00:00.000Z',
          assetCount: 229,
          flaggedMovers: [{
            coin: 'ORDI',
            ticker: 'ORDI/USD',
            direction: 'DOWN',
            price: 1.21,
            change4hPct: -0.08,
            change24hPct: 0.22,
            volumeUsd24h: 185000000,
            fundingRate: -0.00112542,
            flagged: true,
          }],
          topMovers: [{
            coin: 'ORDI',
            ticker: 'ORDI/USD',
            flagged: true,
            change4hPct: -0.08,
            change24hPct: 0.22,
          }],
          alerts: [],
          state: {
            updatedAt: '2026-04-05T01:00:00.000Z',
            lastScanAt: '2026-04-05T01:00:00.000Z',
            assetCount: 229,
            topMovers: [{
              coin: 'ORDI',
              ticker: 'ORDI/USD',
              flagged: true,
              change4hPct: -0.08,
              change24hPct: 0.22,
            }],
            flaggedMovers: [{
              coin: 'ORDI',
              ticker: 'ORDI/USD',
              direction: 'DOWN',
              price: 1.21,
              flagged: true,
              change4hPct: -0.08,
              change24hPct: 0.22,
              volumeUsd24h: 185000000,
              fundingRate: -0.00112542,
            }],
            history: {},
          },
        }),
      },
      cryptoTradingOrchestrator: {
        runConsensusRound: jest.fn(),
      },
      pidPath: path.join(tempRoot, 'scanner-urgent-existing.pid'),
      statusPath: path.join(tempRoot, 'scanner-urgent-existing-status.json'),
      logPath: path.join(tempRoot, 'scanner-urgent-existing.log'),
      taskLogDir: path.join(tempRoot, 'scanner-urgent-existing-tasks'),
      wakeSignalPath: path.join(tempRoot, 'scanner-urgent-existing-wake.signal'),
      marketScannerStatePath: path.join(tempRoot, 'market-scanner-urgent-existing-state.json'),
      dynamicWatchlistStatePath: path.join(tempRoot, 'scanner-urgent-existing-dynamic-watchlist.json'),
    });

    try {
      const immediateConsultSpy = jest.spyOn(scanDaemon, 'triggerImmediateCryptoConsensus').mockResolvedValue({
        ok: true,
        trigger: 'market_scanner',
      });
      mockOrdiPatternBars('ORDI/USD');
      scanDaemon.marketScannerState.lastProcessedAt = '2026-04-05T00:00:00.000Z';

      const started = await scanDaemon.maybeRunMarketScannerAutomation(Date.parse('2026-04-05T01:05:00.000Z'));
      const result = await scanDaemon.marketScannerPhasePromise;

      expect(started).toEqual(expect.objectContaining({ ok: true, skipped: false, started: true }));
      expect(result).toEqual(expect.objectContaining({ ok: true, skipped: false }));
      expect(result.executed?.[0]).toEqual(expect.objectContaining({
        urgentMovers: expect.arrayContaining([
          expect.objectContaining({ ticker: 'ORDI/USD' }),
        ]),
        immediateConsultation: expect.objectContaining({ ok: true, trigger: 'market_scanner' }),
      }));
      expect(immediateConsultSpy).toHaveBeenCalledWith(expect.objectContaining({
        key: 'market_scanner_trigger',
        symbols: ['ORDI/USD'],
      }), expect.objectContaining({
        trigger: 'market_scanner',
      }));
    } finally {
      if (originalScannerAutomation == null) {
        delete process.env.SQUIDRUN_MARKET_SCANNER_AUTOMATION;
      } else {
        process.env.SQUIDRUN_MARKET_SCANNER_AUTOMATION = originalScannerAutomation;
      }
      await scanDaemon.stop('test-cleanup-market-scanner-urgent-existing');
    }
  });

  test('filters non-ORDI market-scanner movers before triggering immediate consultation', async () => {
    const originalScannerAutomation = process.env.SQUIDRUN_MARKET_SCANNER_AUTOMATION;
    process.env.SQUIDRUN_MARKET_SCANNER_AUTOMATION = '1';
    const scanDaemon = new SupervisorDaemon({
      store: createMockStore(),
      logger: createMockLogger(),
      memoryIndexEnabled: false,
      sleepEnabled: false,
      cryptoTradingEnabled: true,
      marketScannerEnabled: true,
      marketScannerImmediateConsultationEnabled: true,
      marketScannerIntervalMinutes: 30,
      marketScanner: {
        runMarketScan: jest.fn().mockResolvedValue({
          scannedAt: '2026-04-05T01:00:00.000Z',
          assetCount: 229,
          flaggedMovers: [
            { coin: 'BOME', ticker: 'BOME/USD', direction: 'UP', price: 0.000382, change4hPct: 0.0409, change24hPct: 0.0026, volumeUsd24h: 8984.99, fundingRate: 0.0000125, flagged: true },
            { coin: 'ORDI', ticker: 'ORDI/USD', direction: 'DOWN', price: 1.21, change4hPct: -0.073, change24hPct: 0.22, volumeUsd24h: 185000000, fundingRate: -0.00004, flagged: true },
          ],
          topMovers: [
            { coin: 'BOME', ticker: 'BOME/USD', flagged: true },
            { coin: 'ORDI', ticker: 'ORDI/USD', flagged: true },
          ],
          alerts: [
            { coin: 'BOME', ticker: 'BOME/USD', direction: 'UP', price: 0.000382, change4hPct: 0.0409, change24hPct: 0.0026, volumeUsd24h: 8984.99, fundingRate: 0.0000125, flagged: true },
            { coin: 'ORDI', ticker: 'ORDI/USD', direction: 'DOWN', price: 1.21, change4hPct: -0.073, change24hPct: 0.22, volumeUsd24h: 185000000, fundingRate: -0.00004, flagged: true },
          ],
          state: {
            updatedAt: '2026-04-05T01:00:00.000Z',
            lastScanAt: '2026-04-05T01:00:00.000Z',
            assetCount: 229,
            assets: [
              { coin: 'BOME', ticker: 'BOME/USD', flagged: true, change4hPct: 0.0409 },
              { coin: 'ORDI', ticker: 'ORDI/USD', flagged: true, change4hPct: -0.073, change24hPct: 0.22 },
            ],
            topMovers: [
              { coin: 'BOME', ticker: 'BOME/USD', flagged: true },
              { coin: 'ORDI', ticker: 'ORDI/USD', flagged: true },
            ],
            flaggedMovers: [
              { coin: 'BOME', ticker: 'BOME/USD', flagged: true, change4hPct: 0.0409 },
              { coin: 'ORDI', ticker: 'ORDI/USD', direction: 'DOWN', price: 1.21, flagged: true, change4hPct: -0.073, change24hPct: 0.22, volumeUsd24h: 185000000, fundingRate: -0.00004 },
            ],
            history: {},
          },
        }),
      },
      cryptoTradingOrchestrator: {
        runConsensusRound: jest.fn(),
      },
      pidPath: path.join(tempRoot, 'scanner-filter.pid'),
      statusPath: path.join(tempRoot, 'scanner-filter-status.json'),
      logPath: path.join(tempRoot, 'scanner-filter.log'),
      taskLogDir: path.join(tempRoot, 'scanner-filter-tasks'),
      wakeSignalPath: path.join(tempRoot, 'scanner-filter-wake.signal'),
      marketScannerStatePath: path.join(tempRoot, 'market-scanner-filter-state.json'),
      dynamicWatchlistStatePath: path.join(tempRoot, 'scanner-filter-dynamic-watchlist.json'),
    });

    try {
      const architectSpy = jest.spyOn(scanDaemon, 'notifyArchitectInternal').mockImplementation(() => {});
      const immediateConsultSpy = jest.spyOn(scanDaemon, 'triggerImmediateCryptoConsensus').mockResolvedValue({ ok: true });
      mockOrdiPatternBars('ORDI/USD');

      scanDaemon.marketScannerState.lastProcessedAt = '2026-04-05T00:00:00.000Z';
      await scanDaemon.maybeRunMarketScannerAutomation(Date.parse('2026-04-05T01:05:00.000Z'));
      await scanDaemon.marketScannerPhasePromise;

      expect(architectSpy).toHaveBeenCalledTimes(1);
      expect(architectSpy.mock.calls[0][0]).toContain('Tracked pairs: 229');
      expect(immediateConsultSpy).toHaveBeenCalledWith(expect.objectContaining({
        symbols: ['ORDI/USD'],
      }), expect.any(Object));
    } finally {
      if (originalScannerAutomation == null) {
        delete process.env.SQUIDRUN_MARKET_SCANNER_AUTOMATION;
      } else {
        process.env.SQUIDRUN_MARKET_SCANNER_AUTOMATION = originalScannerAutomation;
      }
      await scanDaemon.stop('test-cleanup-market-scanner-filter');
    }
  });

  test('runs event watch, oil monitor, and prediction scoring during market scanner phases', async () => {
    const scanDaemon = new SupervisorDaemon({
      store: createMockStore(),
      logger: createMockLogger(),
      memoryIndexEnabled: false,
      sleepEnabled: false,
      cryptoTradingEnabled: true,
      marketScannerEnabled: true,
      marketScanner: {
        runMarketScan: jest.fn().mockResolvedValue({
          scannedAt: '2026-04-05T01:00:00.000Z',
          assetCount: 2,
          flaggedMovers: [],
          topMovers: [],
          alerts: [],
          state: {
            updatedAt: '2026-04-05T01:00:00.000Z',
            lastScanAt: '2026-04-05T01:00:00.000Z',
            assetCount: 2,
            assets: [
              { coin: 'BTC', ticker: 'BTC/USD', price: 82000 },
              { coin: 'ETH', ticker: 'ETH/USD', price: 2100 },
            ],
            topMovers: [],
            flaggedMovers: [],
            history: {},
          },
        }),
      },
      pidPath: path.join(tempRoot, 'scanner-hooks.pid'),
      statusPath: path.join(tempRoot, 'scanner-hooks-status.json'),
      logPath: path.join(tempRoot, 'scanner-hooks.log'),
      taskLogDir: path.join(tempRoot, 'scanner-hooks-tasks'),
      wakeSignalPath: path.join(tempRoot, 'scanner-hooks-wake.signal'),
      marketScannerStatePath: path.join(tempRoot, 'scanner-hooks-state.json'),
    });

    try {
      jest.spyOn(macroRiskGate, 'assessMacroRisk').mockResolvedValue({
        regime: 'red',
        score: 52,
        indicators: {
          oilPrice: { value: 114.01 },
        },
      });
      predictionTracker.scorePredictions.mockReturnValue(3);

      const result = await scanDaemon.runMarketScannerPhase({ key: 'market_scanner' });

      expect(result.predictionsScored).toBe(3);
      expect(predictionTracker.eventHeader).toHaveBeenCalled();
      expect(predictionTracker.checkOilPrice).toHaveBeenLastCalledWith(
        114.01,
        expect.objectContaining({
          stale: false,
        })
      );
      expect(predictionTracker.scorePredictions).toHaveBeenCalledWith(expect.objectContaining({
        BTC: 82000,
        ETH: 2100,
      }));
      expect(scanDaemon.logger.info).toHaveBeenCalledWith(expect.stringContaining('[EVENT WATCH][market_scanner]'));
    } finally {
      await scanDaemon.stop('test-cleanup-market-scanner-hooks');
    }
  });

  test('persists immediate crypto mini-consultation results into crypto trading supervisor state', async () => {
    const daemon = new SupervisorDaemon({
      store: createMockStore(),
      logger: createMockLogger(),
      memoryIndexEnabled: false,
      sleepEnabled: false,
      cryptoTradingEnabled: true,
      marketScannerEnabled: false,
      cryptoTradingOrchestrator: {
        runConsensusRound: jest.fn(),
      },
      pidPath: path.join(tempRoot, 'scanner-immediate-persist.pid'),
      statusPath: path.join(tempRoot, 'scanner-immediate-persist-status.json'),
      logPath: path.join(tempRoot, 'scanner-immediate-persist.log'),
      taskLogDir: path.join(tempRoot, 'scanner-immediate-persist-tasks'),
      wakeSignalPath: path.join(tempRoot, 'scanner-immediate-persist-wake.signal'),
      cryptoTradingStatePath: path.join(tempRoot, 'scanner-immediate-persist-crypto-state.json'),
    });

    try {
      jest.spyOn(daemon, 'runCryptoConsensusPhase').mockResolvedValue({
        ok: true,
        phase: 'market_scanner_trigger',
        scheduledAt: '2026-04-05T01:05:00.000Z',
        summary: {
          trigger: 'market_scanner',
          approvedTrades: 1,
        },
      });

      const result = await daemon.triggerImmediateCryptoConsensus({
        key: 'market_scanner_trigger',
        scheduledAt: '2026-04-05T01:05:00.000Z',
        marketDate: '2026-04-05',
        symbols: ['WLD/USD'],
      }, {
        trigger: 'market_scanner',
      });

      expect(result).toEqual(expect.objectContaining({
        ok: true,
        phase: 'market_scanner_trigger',
      }));
      expect(daemon.cryptoTradingState.lastProcessedAt).toBe('2026-04-05T01:05:00.000Z');
      expect(daemon.cryptoTradingState.lastResult).toEqual(expect.objectContaining({
        ok: true,
        phase: 'market_scanner_trigger',
      }));
      expect(daemon.lastCryptoTradingSummary).toEqual(expect.objectContaining({
        trigger: 'market_scanner',
        lastProcessedAt: '2026-04-05T01:05:00.000Z',
      }));
    } finally {
      await daemon.stop('test-cleanup-market-scanner-immediate-persist');
    }
  });

  test('adds flagged market-scanner movers to the next crypto consultation universe', async () => {
    jest.spyOn(dynamicWatchlist, 'getActiveEntries').mockReturnValue([]);
    daemon.marketScannerState.topMovers = [
      { ticker: 'AVAX/USD', flagged: true },
      { ticker: 'APT/USD', flagged: true },
    ];
    daemon.marketScannerConsultationSymbolLimit = 1;
    daemon.cryptoConsultationSymbolMax = 4;
    jest.spyOn(daemon, 'getCurrentHyperliquidPositionSymbols').mockResolvedValue([]);

    await expect(daemon.getCryptoSymbols()).resolves.toEqual(['BTC/USD', 'ETH/USD', 'SOL/USD', 'AVAX/USD']);
  });

  test('keeps the crypto consultation basket focused on majors plus live positions instead of spraying scanner movers', async () => {
    jest.spyOn(dynamicWatchlist, 'getActiveEntries').mockReturnValue([]);
    const basketDaemon = new SupervisorDaemon({
      store: createMockStore(),
      logger: createMockLogger(),
      memoryIndexEnabled: false,
      sleepEnabled: false,
      cryptoTradingEnabled: true,
      hyperliquidExecutionEnabled: true,
      hyperliquidExecutor: {
        getAccountState: jest.fn().mockResolvedValue({
          accountValue: 1000,
          positions: [
            { coin: 'AVAX', size: -1.5, side: 'short' },
            { coin: 'LINK', size: 2.0, side: 'long' },
          ],
        }),
      },
      pidPath: path.join(tempRoot, 'basket.pid'),
      statusPath: path.join(tempRoot, 'basket-status.json'),
      logPath: path.join(tempRoot, 'basket.log'),
      taskLogDir: path.join(tempRoot, 'basket-tasks'),
      wakeSignalPath: path.join(tempRoot, 'basket-wake.signal'),
      marketScannerStatePath: path.join(tempRoot, 'basket-market-scanner-state.json'),
    });

    try {
      jest.spyOn(tradingWatchlist, 'getTickers').mockReturnValue(['BTC/USD', 'ETH/USD', 'SOL/USD']);
      basketDaemon.marketScannerConsultationSymbolLimit = 2;
      basketDaemon.cryptoConsultationSymbolMax = 5;
      basketDaemon.marketScannerState.topMovers = Array.from({ length: 16 }, (_, index) => ({
        coin: `M${String(index + 1).padStart(2, '0')}`,
        ticker: `M${String(index + 1).padStart(2, '0')}/USD`,
        flagged: true,
      }));

      const basket = await Promise.resolve(basketDaemon.getCryptoSymbols());

      expect(basket).toEqual(['AVAX/USD', 'LINK/USD', 'BTC/USD', 'ETH/USD', 'SOL/USD']);
      expect(basket).not.toContain('M01/USD');
      expect(basket.length).toBe(5);
    } finally {
      await basketDaemon.stop('test-cleanup-dynamic-basket');
    }
  });

  test('logs consultation predictions during crypto consensus phases', async () => {
    const consensusDaemon = new SupervisorDaemon({
      store: createMockStore(),
      logger: createMockLogger(),
      memoryIndexEnabled: false,
      sleepEnabled: false,
      cryptoTradingEnabled: true,
      marketScannerEnabled: false,
      cryptoTradingOrchestrator: {
        clearSignals: jest.fn(),
        runPreMarket: jest.fn().mockResolvedValue({ ok: true }),
        runConsensusRound: jest.fn().mockResolvedValue({
          results: [
            {
              ticker: 'ETH/USD',
              decision: 'SELL',
              confidence: 0.77,
              averageAgreeConfidence: 0.77,
              agreeing: [{ agent: 'builder', reasoning: 'breakdown from range high' }],
            },
          ],
          approvedTrades: [],
          rejectedTrades: [],
          defiStatus: {},
          macroRisk: { regime: 'red', score: 52, reason: 'test' },
          killSwitch: { triggered: false },
          incompleteSignals: [],
        }),
        maybeAutoExecuteLiveConsensus: jest.fn().mockResolvedValue({
          enabled: false,
          attempted: 0,
          succeeded: 0,
          executions: [],
          skipped: [],
        }),
      },
      pidPath: path.join(tempRoot, 'consensus-hooks.pid'),
      statusPath: path.join(tempRoot, 'consensus-hooks-status.json'),
      logPath: path.join(tempRoot, 'consensus-hooks.log'),
      taskLogDir: path.join(tempRoot, 'consensus-hooks-tasks'),
      wakeSignalPath: path.join(tempRoot, 'consensus-hooks-wake.signal'),
    });

    try {
      consensusDaemon.marketScannerState.assets = [
        { coin: 'ETH', ticker: 'ETH/USD', price: 2100 },
      ];
      jest.spyOn(consensusDaemon, 'getCryptoSymbols').mockResolvedValue(['ETH/USD']);
      jest.spyOn(macroRiskGate, 'assessMacroRisk').mockResolvedValue({
        regime: 'red',
        score: 52,
        reason: 'test',
        indicators: {
          oilPrice: { value: 114.01 },
        },
      });

      await consensusDaemon.runCryptoConsensusPhase({
        key: 'crypto_consensus',
        scheduledAt: '2026-04-05T01:00:00.000Z',
      });

      expect(predictionTracker.logPrediction).toHaveBeenCalledWith(expect.objectContaining({
        coin: 'ETH',
        direction: 'SHORT',
        entryPrice: 2100,
        confidence: 0.77,
      }));
      expect(predictionTracker.eventHeader).toHaveBeenCalled();
      expect(predictionTracker.checkOilPrice).toHaveBeenLastCalledWith(
        114.01,
        expect.objectContaining({
          stale: false,
        })
      );
    } finally {
      await consensusDaemon.stop('test-cleanup-consensus-hooks');
    }
  });

  test('boosts consultation mover ranking when cross-venue funding divergence is 25+ or 50+ bps', async () => {
    jest.spyOn(dynamicWatchlist, 'getActiveEntries').mockReturnValue([]);
    hyperliquidNativeLayer.buildNativeFeatureBundle.mockResolvedValueOnce({
      ok: true,
      asOf: new Date().toISOString(),
      symbols: {
        'ALT/USD': {
          crossVenueFunding: {
            strongestVsHl: { absoluteSpreadBps: 28.4 },
          },
        },
        'ZETA/USD': {
          crossVenueFunding: {
            strongestVsHl: { absoluteSpreadBps: 70.6 },
          },
        },
        'AVAX/USD': {
          crossVenueFunding: {
            strongestVsHl: { absoluteSpreadBps: 4.1 },
          },
        },
      },
    });
    daemon.marketScannerState.topMovers = [
      { ticker: 'AVAX/USD', flagged: true, score: 0.09, change4hPct: -0.09 },
      { ticker: 'ALT/USD', flagged: true, score: 0.08, change4hPct: -0.08 },
      { ticker: 'ZETA/USD', flagged: true, score: 0.05, change4hPct: -0.05 },
    ];
    daemon.marketScannerConsultationSymbolLimit = 3;
    daemon.cryptoConsultationSymbolMax = 6;
    jest.spyOn(daemon, 'getCurrentHyperliquidPositionSymbols').mockResolvedValue([]);

    await expect(daemon.getCryptoSymbols()).resolves.toEqual([
      'BTC/USD',
      'ETH/USD',
      'SOL/USD',
      'ZETA/USD',
      'ALT/USD',
      'AVAX/USD',
    ]);
    expect(daemon.lastCryptoCoverage.rankedMovers).toEqual([
      expect.objectContaining({
        ticker: 'ZETA/USD',
        fundingBoostEligible: true,
        fundingBoostTier: 'strong',
        fundingDivergenceBps: 70.6,
      }),
      expect.objectContaining({
        ticker: 'ALT/USD',
        fundingBoostEligible: true,
        fundingBoostTier: 'mild',
        fundingDivergenceBps: 28.4,
      }),
      expect.objectContaining({
        ticker: 'AVAX/USD',
        fundingBoostEligible: true,
        fundingBoostTier: 'none',
        fundingDivergenceBps: 4.1,
      }),
    ]);
  });

  test('disables funding-divergence boost when native funding data is stale or degraded', async () => {
    jest.spyOn(dynamicWatchlist, 'getActiveEntries').mockReturnValue([]);
    hyperliquidNativeLayer.buildNativeFeatureBundle.mockResolvedValueOnce({
      ok: true,
      asOf: '2026-04-05T00:00:00.000Z',
      degradedSources: ['predictedFundings:timeout'],
      symbols: {
        'ALT/USD': {
          crossVenueFunding: {
            strongestVsHl: { absoluteSpreadBps: 70.6 },
          },
        },
        'AVAX/USD': {
          crossVenueFunding: {
            strongestVsHl: { absoluteSpreadBps: 4.1 },
          },
        },
      },
    });
    daemon.marketScannerState.topMovers = [
      { ticker: 'AVAX/USD', flagged: true, score: 0.09, change4hPct: -0.09 },
      { ticker: 'ALT/USD', flagged: true, score: 0.08, change4hPct: -0.08 },
    ];
    daemon.marketScannerConsultationSymbolLimit = 2;
    daemon.cryptoConsultationSymbolMax = 5;
    jest.spyOn(daemon, 'getCurrentHyperliquidPositionSymbols').mockResolvedValue([]);

    await expect(daemon.getCryptoSymbols()).resolves.toEqual([
      'BTC/USD',
      'ETH/USD',
      'SOL/USD',
      'AVAX/USD',
      'ALT/USD',
    ]);
    expect(daemon.lastCryptoCoverage.rankedMovers).toEqual([
      expect.objectContaining({
        ticker: 'AVAX/USD',
        fundingBoostEligible: false,
        fundingBoostTier: 'none',
        consultationBoost: 0,
      }),
      expect.objectContaining({
        ticker: 'ALT/USD',
        fundingBoostEligible: false,
        fundingBoostTier: 'none',
        consultationBoost: 0,
      }),
    ]);
  });

  test('writes consultation coverage fields into supervisor status visibility', () => {
    const writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
    daemon.cryptoTradingEnabled = true;
    daemon.marketScannerState.assetCount = 229;
    daemon.marketScannerConsultationSymbolLimit = 15;
    daemon.getCryptoSymbols = jest.fn(() => [
      'BTC/USD',
      'ETH/USD',
      'SOL/USD',
      'AVAX/USD',
      'LINK/USD',
      'M01/USD',
      'M02/USD',
      'M03/USD',
    ]);
    daemon.lastCryptoTradingSummary = {
      enabled: true,
      status: 'scan_complete',
      lastProcessedAt: '2026-04-05T19:30:00.000Z',
      nextEvent: { key: 'crypto_consensus' },
    };
    daemon.lastCryptoCoverage = {
      symbolsConsulted: ['BTC/USD', 'ETH/USD', 'SOL/USD', 'AVAX/USD'],
      symbolsExecutable: ['BTC/USD', 'ETH/USD', 'SOL/USD', 'AVAX/USD'],
    };

    daemon.writeStatus();

    const [, payloadText] = writeSpy.mock.calls[writeSpy.mock.calls.length - 1];
    const payload = JSON.parse(payloadText);
    const rootCoverage = payload.pairsScanned != null
      || payload.symbolsConsulted != null
      || payload.symbolsExecutable != null;
    const cryptoCoverage = payload.cryptoTradingAutomation && (
      payload.cryptoTradingAutomation.pairsScanned != null
      || payload.cryptoTradingAutomation.symbolsConsulted != null
      || payload.cryptoTradingAutomation.symbolsExecutable != null
    );

    expect(rootCoverage || cryptoCoverage).toBe(true);
    expect(
      payload.pairsScanned
      ?? payload.cryptoTradingAutomation?.pairsScanned
    ).toBeGreaterThanOrEqual(229);
    expect(
      payload.symbolsConsulted
      ?? payload.cryptoTradingAutomation?.symbolsConsulted
    ).toEqual(expect.arrayContaining(['BTC/USD', 'ETH/USD', 'SOL/USD']));
    expect(payload.cryptoConsultationPolicy).toEqual(expect.objectContaining({
      coreSymbols: ['BTC/USD', 'ETH/USD', 'SOL/USD'],
      minAgreeConfidence: 0.6,
      autoExecuteMinConfidence: 0.6,
    }));
    expect(payload.cryptoRiskPolicy).toEqual(expect.objectContaining({
      configuredMaxPositionPct: 0.03,
      hardCapFloorPct: 0.35,
      effectiveHardCapPct: 0.35,
      configuredStopLossPct: 0.04,
      confidenceRiskFloorPct: 0.005,
      confidenceRiskCeilingPct: 0.02,
    }));

    writeSpy.mockRestore();
  });
});
