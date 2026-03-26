const watcherRecords = [];

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
      provider: 'ollama',
      sleepExtraction: {
        enabled: true,
        available: true,
        model: 'llama3:8b',
        path: 'local-ollama',
        command: '"node" "ollama-extract.js" --model "llama3:8b"',
      },
    },
  })),
  resolveSleepExtractionCommandFromSnapshot: jest.fn((snapshot) => snapshot?.localModels?.sleepExtraction?.command || ''),
}));

const chokidar = require('chokidar');
const fs = require('fs');
const { runMemoryConsistencyCheck } = require('../modules/memory-consistency-check');
const executor = require('../modules/trading/executor');
const macroRiskGate = require('../modules/trading/macro-risk-gate');
const { SupervisorDaemon } = require('../supervisor-daemon');

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

  beforeEach(() => {
    jest.useFakeTimers();
    watcherRecords.length = 0;

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
      tradingEnabled: false,
      polymarketTradingEnabled: false,
      pidPath: '/tmp/supervisor.pid',
      statusPath: '/tmp/supervisor-status.json',
      logPath: '/tmp/supervisor.log',
      taskLogDir: '/tmp/supervisor-tasks',
      wakeSignalPath: '/tmp/supervisor-wake.signal',
    });
    daemon.getMemoryIndexWatchTargets = jest.fn(() => ['/tmp/knowledge/**/*.md']);
  });

  afterEach(async () => {
    if (daemon) {
      await daemon.stop('test-cleanup');
    }
    jest.restoreAllMocks();
    jest.useRealTimers();
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

  test('runs sleep consolidation when idle and no workers are active', async () => {
    mockSleepConsolidator.shouldRun.mockReturnValue({
      ok: true,
      activity: { idleMs: 1900000, isIdle: true },
      enoughGap: true,
    });

    await daemon.tick();

    expect(mockSleepConsolidator.runOnce).toHaveBeenCalledTimes(1);
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
    expect(mockSleepConsolidator.extractionCommand).toContain('ollama-extract.js');
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
    const wakeWatcher = getWatcherByTarget('/tmp/supervisor-wake.signal');
    expect(memoryWatcher.close).toHaveBeenCalledTimes(1);
    expect(wakeWatcher.close).toHaveBeenCalledTimes(1);
    expect(mockMemorySearchIndex.close).toHaveBeenCalled();
    expect(mockSleepConsolidator.close).toHaveBeenCalled();
    expect(mockLeaseJanitor.close).toHaveBeenCalled();
  });

  test('backs off when idle and wakes immediately on demand', async () => {
    daemon.memoryIndexEnabled = false;

    const startResult = daemon.start();
    expect(startResult).toEqual({ ok: true });

    await jest.advanceTimersByTimeAsync(0);

    expect(daemon.store.claimNextTask).toHaveBeenCalledTimes(1);
    expect(daemon.currentBackoffMs).toBe(daemon.pollMs * 2);

    daemon.requestTick('manual');
    await jest.advanceTimersByTimeAsync(0);

    expect(daemon.store.claimNextTask).toHaveBeenCalledTimes(2);
    expect(daemon.currentBackoffMs).toBe(daemon.pollMs * 2);
  });

  test('wake signal watcher requests an immediate tick', () => {
    const requestTickSpy = jest.spyOn(daemon, 'requestTick');

    daemon.startWakeSignalWatcher();
    const wakeWatcher = getWatcherByTarget('/tmp/supervisor-wake.signal');
    wakeWatcher.handlers.all('change', '/tmp/supervisor-wake.signal');

    expect(requestTickSpy).toHaveBeenCalledWith('wake-signal:change');
  });

  test('prunes expired memory leases during tick housekeeping', async () => {
    mockLeaseJanitor.pruneExpiredLeases.mockReturnValue({
      ok: true,
      pruned: 3,
    });

    await daemon.tick();

    expect(mockLeaseJanitor.pruneExpiredLeases).toHaveBeenCalledTimes(1);
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

    await daemon.tick();

    expect(daemon.store.pruneExpiredPendingTasks).toHaveBeenCalledWith(
      expect.objectContaining({
        maxAgeMs: 60000,
      })
    );
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

    await daemon.tick();

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

  test('reconciles pending trades on a 5-minute cadence while pending orders remain', async () => {
    const tradingOrchestrator = {
      getPendingReconciliationTrades: jest.fn()
        .mockReturnValueOnce([{ id: 1, ticker: 'AAPL', alpaca_order_id: 'alpaca-1' }])
        .mockReturnValueOnce([{ id: 1, ticker: 'AAPL', alpaca_order_id: 'alpaca-1' }])
        .mockReturnValueOnce([{ id: 1, ticker: 'AAPL', alpaca_order_id: 'alpaca-1' }])
        .mockReturnValueOnce([{ id: 1, ticker: 'AAPL', alpaca_order_id: 'alpaca-1' }])
        .mockReturnValueOnce([]),
      runReconciliation: jest.fn()
        .mockResolvedValueOnce({
          phase: 'reconciliation',
          marketDate: '2026-03-19',
          orderUpdates: [{ tradeId: 1, status: 'FILLED' }],
          recordedOutcomes: [],
          asOf: '2026-03-19T14:35:00.000Z',
        })
        .mockResolvedValueOnce({
          phase: 'reconciliation',
          marketDate: '2026-03-19',
          orderUpdates: [],
          recordedOutcomes: [],
          asOf: '2026-03-19T14:40:01.000Z',
        }),
    };
    const tradingDaemon = new SupervisorDaemon({
      store: createMockStore(),
      logger: createMockLogger(),
      memoryIndexEnabled: false,
      sleepEnabled: false,
      tradingEnabled: true,
      cryptoTradingEnabled: false,
      polymarketTradingEnabled: false,
      tradingOrchestrator,
      tradingStatePath: '/tmp/trade-reconcile-cadence-trading-state.json',
      pidPath: '/tmp/trade-reconcile-cadence.pid',
      statusPath: '/tmp/trade-reconcile-cadence-status.json',
      logPath: '/tmp/trade-reconcile-cadence.log',
      taskLogDir: '/tmp/trade-reconcile-cadence-tasks',
      wakeSignalPath: '/tmp/trade-reconcile-cadence-wake.signal',
    });

    const first = await tradingDaemon.maybeRunTradeReconciliation(new Date('2026-03-19T14:35:00.000Z'));
    expect(first).toEqual(expect.objectContaining({
      ok: true,
      skipped: false,
      marketDate: '2026-03-19',
      pendingCount: 1,
      remainingPendingCount: 1,
    }));

    const second = await tradingDaemon.maybeRunTradeReconciliation(new Date('2026-03-19T14:39:00.000Z'));
    expect(second).toEqual(expect.objectContaining({
      ok: false,
      skipped: true,
      reason: 'interval_guard',
      marketDate: '2026-03-19',
      pendingCount: 1,
    }));

    const third = await tradingDaemon.maybeRunTradeReconciliation(new Date('2026-03-19T14:40:01.000Z'));
    expect(third).toEqual(expect.objectContaining({
      ok: true,
      skipped: false,
      marketDate: '2026-03-19',
      pendingCount: 1,
      remainingPendingCount: 0,
    }));

    expect(tradingOrchestrator.runReconciliation).toHaveBeenCalledTimes(2);
    expect(tradingOrchestrator.runReconciliation).toHaveBeenNthCalledWith(1, expect.objectContaining({ date: '2026-03-19' }));
    expect(tradingOrchestrator.runReconciliation).toHaveBeenNthCalledWith(2, expect.objectContaining({ date: '2026-03-19' }));

    await tradingDaemon.stop('test-cleanup-trade-reconcile-cadence');
  });

  test('runs reconciliation from the supervisor tick without waiting for end of day', async () => {
    jest.setSystemTime(new Date('2026-03-19T21:10:00.000Z'));

    const tradingOrchestrator = {
      getPendingReconciliationTrades: jest.fn()
        .mockReturnValueOnce([{ id: 1, ticker: 'AAPL', alpaca_order_id: 'alpaca-1' }])
        .mockReturnValueOnce([]),
      runReconciliation: jest.fn().mockResolvedValue({
        phase: 'reconciliation',
        marketDate: '2026-03-19',
        orderUpdates: [{ tradeId: 1, status: 'FILLED' }],
        recordedOutcomes: [],
        asOf: '2026-03-19T21:10:00.000Z',
      }),
      runPreMarket: jest.fn(),
      runConsensusRound: jest.fn(),
      runMarketOpen: jest.fn(),
      runMidDayCheck: jest.fn(),
      runMarketClose: jest.fn(),
      runEndOfDay: jest.fn(),
    };
    const tradingDaemon = new SupervisorDaemon({
      store: createMockStore(),
      logger: createMockLogger(),
      memoryIndexEnabled: false,
      sleepEnabled: false,
      tradingEnabled: true,
      cryptoTradingEnabled: false,
      polymarketTradingEnabled: false,
      tradingOrchestrator,
      tradingStatePath: '/tmp/trade-reconcile-tick-trading-state.json',
      pidPath: '/tmp/trade-reconcile-tick.pid',
      statusPath: '/tmp/trade-reconcile-tick-status.json',
      logPath: '/tmp/trade-reconcile-tick.log',
      taskLogDir: '/tmp/trade-reconcile-tick-tasks',
      wakeSignalPath: '/tmp/trade-reconcile-tick-wake.signal',
    });
    jest.spyOn(tradingDaemon, 'getTradingDaySchedule').mockResolvedValue(null);
    jest.spyOn(tradingDaemon, 'getNextTradingEvent').mockResolvedValue(null);

    const result = await tradingDaemon.tick();

    expect(result.tradeReconciliationResult).toEqual(expect.objectContaining({
      ok: true,
      skipped: false,
      marketDate: '2026-03-19',
      pendingCount: 1,
      remainingPendingCount: 0,
    }));
    expect(tradingOrchestrator.runReconciliation).toHaveBeenCalledWith(expect.objectContaining({
      date: '2026-03-19',
    }));
    expect(tradingOrchestrator.runEndOfDay).not.toHaveBeenCalled();

    await tradingDaemon.stop('test-cleanup-trade-reconcile-tick');
  });

  test('opens a Hyperliquid ETH short after approved crypto SELL consensus', async () => {
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
          consensus: { decision: 'SELL' },
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
      tradingEnabled: false,
      cryptoTradingEnabled: true,
      cryptoMonitorOnly: false,
      hyperliquidExecutionEnabled: true,
      cryptoTradingOrchestrator,
      hyperliquidExecutor,
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
        ok: false,
        skipped: true,
        phase: 'hyperliquid_execution',
        reason: 'hyperliquid_disabled',
      }),
      summary: expect.objectContaining({
        hyperliquidAction: 'none',
        hyperliquidExecuted: false,
      }),
    }));
    expect(cryptoTradingOrchestrator.runMarketOpen).toHaveBeenCalledWith(expect.objectContaining({
      assetClass: 'crypto',
      approvedTrades: expect.arrayContaining([
        expect.objectContaining({ ticker: 'ETH/USD' }),
      ]),
    }));
    expect(hyperliquidExecutor.openEthShort).not.toHaveBeenCalled();
    expect(hyperliquidExecutor.closeEthPosition).not.toHaveBeenCalled();

    await tradingDaemon.stop('test-cleanup-hyperliquid-open');
  });

  test('still opens a Hyperliquid ETH short when crypto execution is monitor-only', async () => {
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
          consensus: { decision: 'SELL' },
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
      tradingEnabled: false,
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
        ok: false,
        skipped: true,
        phase: 'hyperliquid_execution',
        reason: 'hyperliquid_disabled',
      }),
      summary: expect.objectContaining({
        approvedTrades: 1,
        executedTrades: 0,
        hyperliquidAction: 'none',
        hyperliquidExecuted: false,
        monitorOnly: true,
      }),
    }));
    expect(cryptoTradingOrchestrator.runMarketOpen).not.toHaveBeenCalled();
    expect(hyperliquidExecutor.openEthShort).not.toHaveBeenCalled();

    await tradingDaemon.stop('test-cleanup-hyperliquid-monitor-only');
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
      tradingEnabled: false,
      cryptoTradingEnabled: true,
      cryptoMonitorOnly: false,
      hyperliquidExecutionEnabled: true,
      cryptoTradingOrchestrator,
      hyperliquidExecutor,
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
        ok: false,
        skipped: true,
        phase: 'hyperliquid_execution',
        reason: 'hyperliquid_disabled',
      }),
      summary: expect.objectContaining({
        approvedTrades: 0,
        executedTrades: 0,
        hyperliquidAction: 'none',
        hyperliquidExecuted: false,
      }),
    }));
    expect(cryptoTradingOrchestrator.runMarketOpen).not.toHaveBeenCalled();
    expect(hyperliquidExecutor.closeEthPosition).not.toHaveBeenCalled();
    expect(hyperliquidExecutor.openEthShort).not.toHaveBeenCalled();

    await tradingDaemon.stop('test-cleanup-hyperliquid-close');
  });

  test('runs Polymarket scan through orchestrator consensus and execution', async () => {
    const consensusPhase = {
      markets: [
        {
          conditionId: 'market-1',
          question: 'Will BTC close above $120k by June 30?',
        },
      ],
      approvedTrades: [
        {
          ticker: 'market-1',
          consensus: { decision: 'BUY_YES', consensus: true },
        },
      ],
      rejectedTrades: [],
    };
    const executionPhase = {
      executions: [
        { ticker: 'market-1', execution: { ok: true, status: 'dry_run' } },
        { ticker: 'market-2', execution: { ok: false, status: 'rejected' } },
      ],
    };
    const polymarketTradingOrchestrator = {
      runPolymarketConsensusRound: jest.fn().mockResolvedValue(consensusPhase),
      runPolymarketMarketOpen: jest.fn().mockResolvedValue(executionPhase),
      getUnifiedPortfolioSnapshot: jest.fn(),
    };
    const polymarketDaemon = new SupervisorDaemon({
      store: createMockStore(),
      logger: createMockLogger(),
      memoryIndexEnabled: false,
      sleepEnabled: false,
      tradingEnabled: false,
      cryptoTradingEnabled: false,
      polymarketTradingEnabled: true,
      polymarketTradingOrchestrator,
      polymarketClient: {
        getBalance: jest.fn().mockResolvedValue({ balance: 162, available: 162 }),
        getPositions: jest.fn().mockResolvedValue([]),
        createOrder: jest.fn().mockResolvedValue({ ok: true, status: 'dry_run' }),
      },
      polymarketScanner: {
        scanMarkets: jest.fn().mockResolvedValue([
          {
            conditionId: 'market-1',
            question: 'Will BTC close above $120k by June 30?',
            tokens: { yes: 'yes-token', no: 'no-token' },
            currentPrices: { yes: 0.61, no: 0.39 },
          },
        ]),
      },
      polymarketSignals: {
        produceSignals: jest.fn(() => new Map([
          ['architect', [{ conditionId: 'market-1', probability: 0.74, confidence: 0.84, marketPrice: 0.61 }]],
          ['builder', [{ conditionId: 'market-1', probability: 0.76, confidence: 0.86, marketPrice: 0.61 }]],
          ['oracle', [{ conditionId: 'market-1', probability: 0.58, confidence: 0.7, marketPrice: 0.61 }]],
        ])),
        buildConsensus: jest.fn(() => ({
          conditionId: 'market-1',
          decision: 'BUY_YES',
          consensus: true,
          agreementCount: 2,
          probability: 0.72,
          edge: 0.11,
        })),
      },
      polymarketSizer: {
        positionSize: jest.fn().mockReturnValue({
          executable: true,
          stake: 24.3,
          shares: 39.836,
          reasons: [],
        }),
        shouldExit: jest.fn().mockReturnValue({ exit: false, reason: 'Hold', stopPrice: 0.48, adverseMovePct: 0 }),
      },
      pidPath: '/tmp/polymarket-supervisor.pid',
      statusPath: '/tmp/polymarket-supervisor-status.json',
      logPath: '/tmp/polymarket-supervisor.log',
      taskLogDir: '/tmp/polymarket-supervisor-tasks',
      wakeSignalPath: '/tmp/polymarket-supervisor-wake.signal',
    });

    const result = await polymarketDaemon.runPolymarketPhase({
      key: 'polymarket_scan',
      marketDate: '2026-03-18',
      scheduledAt: '2026-03-18T08:10:00.000Z',
      windowKey: '2026-03-18T08:00:00.000Z',
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      phase: 'polymarket_scan',
      summary: expect.objectContaining({
        markets: 1,
        actionable: 1,
        executions: 1,
      }),
    }));
    expect(polymarketTradingOrchestrator.runPolymarketConsensusRound).toHaveBeenCalledWith(expect.objectContaining({
      date: '2026-03-18',
      broker: 'polymarket',
      assetClass: 'prediction_market',
      includePolymarket: true,
    }));
    expect(polymarketTradingOrchestrator.runPolymarketMarketOpen).toHaveBeenCalledWith(expect.objectContaining({
      date: '2026-03-18',
      broker: 'polymarket',
      assetClass: 'prediction_market',
      includePolymarket: true,
      consensusPhase,
    }));
    expect(polymarketDaemon.polymarketTradingState.lastExecution).toEqual(expect.objectContaining({
      executions: expect.arrayContaining([
        expect.objectContaining({
          ticker: 'market-1',
        }),
      ]),
    }));

    await polymarketDaemon.stop('test-cleanup-polymarket');
  });

  test('runs Polymarket monitor exits with unified portfolio gates', async () => {
    const submitOrderSpy = jest.spyOn(executor, 'submitOrder').mockResolvedValue({
      ok: true,
      status: 'dry_run',
      orderId: 'pm-exit-1',
    });
    const polymarketTradingOrchestrator = {
      runPolymarketConsensusRound: jest.fn(),
      runPolymarketMarketOpen: jest.fn(),
      getUnifiedPortfolioSnapshot: jest.fn().mockResolvedValue({
        equity: 1000,
        totalEquity: 1000,
        peakEquity: 1000,
        dayStartEquity: 1000,
        markets: {
          polymarket: {
            equity: 160,
            positions: [],
          },
        },
      }),
    };
    const polymarketDaemon = new SupervisorDaemon({
      store: createMockStore(),
      logger: createMockLogger(),
      memoryIndexEnabled: false,
      sleepEnabled: false,
      tradingEnabled: false,
      cryptoTradingEnabled: false,
      polymarketTradingEnabled: true,
      polymarketTradingOrchestrator,
      polymarketClient: {
        getBalance: jest.fn().mockResolvedValue({ balance: 162, available: 162 }),
        getPositions: jest.fn().mockResolvedValue([
          {
            tokenId: 'yes-token',
            market: 'market-1',
            size: 12.5,
            avgEntryPrice: 0.61,
            currentPrice: 0.44,
          },
          {
            tokenId: 'no-token',
            market: 'market-2',
            size: 5,
            avgEntryPrice: 0.38,
            currentPrice: 0.41,
          },
        ]),
        createOrder: jest.fn(),
      },
      polymarketSizer: {
        positionSize: jest.fn(),
        shouldExit: jest.fn((position) => {
          if (position.tokenId === 'yes-token') {
            return { exit: true, reason: 'Stop loss triggered', stopPrice: 0.488, adverseMovePct: 27.87 };
          }
          return { exit: false, reason: 'Hold', stopPrice: 0.304, adverseMovePct: -7.89 };
        }),
      },
      pidPath: '/tmp/polymarket-monitor.pid',
      statusPath: '/tmp/polymarket-monitor-status.json',
      logPath: '/tmp/polymarket-monitor.log',
      taskLogDir: '/tmp/polymarket-monitor-tasks',
      wakeSignalPath: '/tmp/polymarket-monitor-wake.signal',
    });

    const result = await polymarketDaemon.runPolymarketPhase({
      key: 'polymarket_monitor',
      marketDate: '2026-03-18',
      scheduledAt: '2026-03-18T08:30:00.000Z',
      windowKey: '2026-03-18T08:30:00.000Z',
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      phase: 'polymarket_monitor',
      summary: expect.objectContaining({
        positions: 2,
        exits: 1,
        killSwitch: false,
        dailyPause: false,
      }),
    }));
    expect(polymarketTradingOrchestrator.getUnifiedPortfolioSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      date: '2026-03-18',
      includePolymarket: true,
      broker: 'polymarket',
      assetClass: 'prediction_market',
    }));
    expect(polymarketDaemon.polymarketSizer.shouldExit).toHaveBeenCalledTimes(2);
    expect(submitOrderSpy).toHaveBeenCalledWith(expect.objectContaining({
      ticker: 'market-1',
      broker: 'polymarket',
      assetClass: 'prediction_market',
      direction: 'SELL',
      shares: 12.5,
      tokenId: 'yes-token',
      price: 0.44,
    }), expect.objectContaining({
      broker: 'polymarket',
    }));
    expect(polymarketDaemon.polymarketTradingState.lastMonitor).toEqual(expect.objectContaining({
      exits: [
        expect.objectContaining({
          tokenId: 'yes-token',
          market: 'market-1',
        }),
      ],
    }));

    await polymarketDaemon.stop('test-cleanup-polymarket-monitor');
  });

  test('schedules only Polymarket scan and monitor phases for automation', async () => {
    const consensusPhase = {
      markets: [{ conditionId: 'market-1' }],
      approvedTrades: [],
      rejectedTrades: [],
    };
    const executionPhase = {
      executions: [],
    };
    const polymarketTradingOrchestrator = {
      runPolymarketConsensusRound: jest.fn().mockResolvedValue(consensusPhase),
      runPolymarketMarketOpen: jest.fn().mockResolvedValue(executionPhase),
      getUnifiedPortfolioSnapshot: jest.fn().mockResolvedValue({
        equity: 1000,
        totalEquity: 1000,
        peakEquity: 1000,
        dayStartEquity: 1000,
        markets: { polymarket: { equity: 1000, positions: [] } },
      }),
    };
    const polymarketDaemon = new SupervisorDaemon({
      store: createMockStore(),
      logger: createMockLogger(),
      memoryIndexEnabled: false,
      sleepEnabled: false,
      tradingEnabled: false,
      cryptoTradingEnabled: false,
      polymarketTradingEnabled: true,
      polymarketTradingOrchestrator,
      polymarketClient: {
        getBalance: jest.fn().mockResolvedValue({ balance: 162, available: 162 }),
        getPositions: jest.fn().mockResolvedValue([]),
        createOrder: jest.fn(),
      },
      polymarketSizer: {
        positionSize: jest.fn(),
        shouldExit: jest.fn().mockReturnValue({ exit: false, reason: 'Hold', stopPrice: 0.48, adverseMovePct: 0 }),
      },
      pidPath: '/tmp/polymarket-schedule.pid',
      statusPath: '/tmp/polymarket-schedule-status.json',
      logPath: '/tmp/polymarket-schedule.log',
      taskLogDir: '/tmp/polymarket-schedule-tasks',
      wakeSignalPath: '/tmp/polymarket-schedule-wake.signal',
    });
    polymarketDaemon.polymarketTradingState.lastProcessedAt = '2026-03-18T10:30:00.000Z';

    const result = await polymarketDaemon.maybeRunPolymarketTradingAutomation(new Date('2026-03-18T11:00:00.000Z'));

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      skipped: false,
    }));
    expect(result.executed.map((entry) => entry.phase)).toEqual(['polymarket_scan', 'polymarket_monitor']);
    expect(result.executed.map((entry) => entry.phase)).not.toContain('polymarket_consensus');
    expect(result.executed.map((entry) => entry.phase)).not.toContain('polymarket_execute');

    await polymarketDaemon.stop('test-cleanup-polymarket-schedule');
  });

  test('runs launch radar scans through the supervisor phase wiring', async () => {
    const qualified = [
      {
        chain: 'solana',
        symbol: 'SQD',
        name: 'Squid Launch',
        address: 'SoLaunch11111111111111111111111111111111111',
        liquidityUsd: 12500,
        holders: 44,
        audit: { recommendation: 'proceed' },
      },
    ];
    const launchRadarInstance = {
      pollNow: jest.fn().mockResolvedValue({
        ok: true,
        launches: qualified,
        qualified,
        rejected: [],
      }),
      stop: jest.fn(),
    };
    const launchRadarOrchestrator = {
      getUnifiedPortfolioSnapshot: jest.fn().mockResolvedValue({
        equity: 1000,
        totalEquity: 1000,
        peakEquity: 1200,
        dayStartEquity: 1000,
        positions: [],
      }),
      syncLaunchRadarWatchlist: jest.fn().mockResolvedValue({
        ok: true,
        qualifiedTokens: qualified,
        added: ['SQD'],
        refreshed: [],
      }),
    };
    const launchRadarDaemon = new SupervisorDaemon({
      store: createMockStore(),
      logger: createMockLogger(),
      memoryIndexEnabled: false,
      sleepEnabled: false,
      tradingEnabled: false,
      cryptoTradingEnabled: false,
      launchRadarEnabled: true,
      launchRadarDryRun: true,
      launchRadar: launchRadarInstance,
      launchRadarOrchestrator,
      pidPath: '/tmp/launch-radar.pid',
      statusPath: '/tmp/launch-radar-status.json',
      logPath: '/tmp/launch-radar.log',
      taskLogDir: '/tmp/launch-radar-tasks',
      wakeSignalPath: '/tmp/launch-radar-wake.signal',
    });

    const result = await launchRadarDaemon.runLaunchRadarPhase({
      key: 'launch_radar_scan',
      marketDate: '2026-03-19',
      scheduledAt: '2026-03-19T21:00:00.000Z',
      windowKey: '2026-03-19T21:00:00.000Z',
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      phase: 'launch_radar_scan',
      summary: expect.objectContaining({
        launches: 1,
        qualified: 1,
        rejected: 0,
        added: 1,
        refreshed: 0,
        killSwitch: false,
        dryRun: true,
      }),
    }));
    expect(launchRadarInstance.pollNow).toHaveBeenCalledWith({ reason: 'launch_radar_scan' });
    expect(launchRadarOrchestrator.syncLaunchRadarWatchlist).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'launch_radar_scan',
      date: '2026-03-19',
      launchRadar: launchRadarInstance,
      launchRadarQualifiedTokens: qualified,
      launchRadarExpiryDays: 7,
      persistDynamicWatchlist: false,
    }));
    expect(launchRadarDaemon.launchRadarState.lastScan).toEqual(expect.objectContaining({
      syncResult: expect.objectContaining({
        added: ['SQD'],
      }),
    }));

    await launchRadarDaemon.stop('test-cleanup-launch-radar');
  });

  test('skips launch radar watchlist sync when the kill switch is triggered', async () => {
    const launchRadarInstance = {
      pollNow: jest.fn().mockResolvedValue({
        ok: true,
        launches: [
          {
            chain: 'solana',
            symbol: 'RISK',
            address: 'SoRisk111111111111111111111111111111111111',
            liquidityUsd: 9000,
            holders: 22,
            audit: { recommendation: 'proceed' },
          },
        ],
        qualified: [
          {
            chain: 'solana',
            symbol: 'RISK',
            address: 'SoRisk111111111111111111111111111111111111',
            liquidityUsd: 9000,
            holders: 22,
            audit: { recommendation: 'proceed' },
          },
        ],
        rejected: [],
      }),
      stop: jest.fn(),
    };
    const launchRadarOrchestrator = {
      getUnifiedPortfolioSnapshot: jest.fn().mockResolvedValue({
        equity: 700,
        totalEquity: 700,
        peakEquity: 1000,
        dayStartEquity: 1000,
        positions: [],
      }),
      syncLaunchRadarWatchlist: jest.fn(),
    };
    const launchRadarDaemon = new SupervisorDaemon({
      store: createMockStore(),
      logger: createMockLogger(),
      memoryIndexEnabled: false,
      sleepEnabled: false,
      tradingEnabled: false,
      cryptoTradingEnabled: false,
      launchRadarEnabled: true,
      launchRadar: launchRadarInstance,
      launchRadarOrchestrator,
      pidPath: '/tmp/launch-radar-kill.pid',
      statusPath: '/tmp/launch-radar-kill-status.json',
      logPath: '/tmp/launch-radar-kill.log',
      taskLogDir: '/tmp/launch-radar-kill-tasks',
      wakeSignalPath: '/tmp/launch-radar-kill-wake.signal',
    });

    const result = await launchRadarDaemon.runLaunchRadarPhase({
      key: 'launch_radar_scan',
      marketDate: '2026-03-19',
      scheduledAt: '2026-03-19T21:15:00.000Z',
      windowKey: '2026-03-19T21:15:00.000Z',
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      summary: expect.objectContaining({
        qualified: 1,
        added: 0,
        killSwitch: true,
      }),
    }));
    expect(launchRadarOrchestrator.syncLaunchRadarWatchlist).not.toHaveBeenCalled();

    await launchRadarDaemon.stop('test-cleanup-launch-radar-kill');
  });

  test('schedules launch radar scans every 15 minutes', async () => {
    const qualified = [
      {
        chain: 'solana',
        symbol: 'SQD',
        address: 'SoLaunch11111111111111111111111111111111111',
        liquidityUsd: 12500,
        holders: 44,
        audit: { recommendation: 'proceed' },
      },
    ];
    const launchRadarInstance = {
      pollNow: jest.fn().mockResolvedValue({
        ok: true,
        launches: qualified,
        qualified,
        rejected: [],
      }),
      stop: jest.fn(),
    };
    const launchRadarOrchestrator = {
      getUnifiedPortfolioSnapshot: jest.fn().mockResolvedValue({
        equity: 1000,
        totalEquity: 1000,
        peakEquity: 1000,
        dayStartEquity: 1000,
        positions: [],
      }),
      syncLaunchRadarWatchlist: jest.fn().mockResolvedValue({
        ok: true,
        qualifiedTokens: qualified,
        added: ['SQD'],
        refreshed: [],
      }),
    };
    const launchRadarDaemon = new SupervisorDaemon({
      store: createMockStore(),
      logger: createMockLogger(),
      memoryIndexEnabled: false,
      sleepEnabled: false,
      tradingEnabled: false,
      cryptoTradingEnabled: false,
      launchRadarEnabled: true,
      launchRadar: launchRadarInstance,
      launchRadarOrchestrator,
      pidPath: '/tmp/launch-radar-schedule.pid',
      statusPath: '/tmp/launch-radar-schedule-status.json',
      logPath: '/tmp/launch-radar-schedule.log',
      taskLogDir: '/tmp/launch-radar-schedule-tasks',
      wakeSignalPath: '/tmp/launch-radar-schedule-wake.signal',
    });
    launchRadarDaemon.launchRadarState.lastProcessedAt = '2026-03-19T10:45:00.000Z';

    const result = await launchRadarDaemon.maybeRunLaunchRadarAutomation(new Date('2026-03-19T11:00:00.000Z'));

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      skipped: false,
    }));
    expect(result.executed.map((entry) => entry.phase)).toEqual(['launch_radar_scan']);
    expect(launchRadarDaemon.launchRadarState.nextEvent).toEqual(expect.objectContaining({
      key: 'launch_radar_scan',
    }));

    await launchRadarDaemon.stop('test-cleanup-launch-radar-schedule');
  });

  test('runs yield rebalances through the supervisor phase wiring', async () => {
    const yieldRouter = {
      requestCapital: jest.fn(),
      returnCapital: jest.fn(),
    };
    const yieldRouterOrchestrator = {
      getUnifiedPortfolioSnapshot: jest.fn().mockResolvedValue({
        totalEquity: 1000,
        markets: {
          alpaca_stocks: { equity: 400 },
          alpaca_crypto: { equity: 0 },
          ibkr_global: { equity: 0 },
          polymarket: { equity: 0 },
          defi_yield: { equity: 100 },
          solana_tokens: { equity: 0 },
          cash_reserve: { cash: 500, equity: 500 },
        },
        risk: {
          killSwitchTriggered: false,
        },
      }),
      getCapitalAllocation: jest.fn().mockReturnValue({
        totalEquity: 1000,
        excess: { idleCapital: 250 },
        gaps: { yield: 250, activeTrading: 0 },
      }),
      returnIdleCapital: jest.fn().mockResolvedValue({
        ok: true,
        action: 'return_idle',
        amount: 250,
        deposit: { deposited: 250, venue: 'Morpho' },
      }),
    };
    const yieldDaemon = new SupervisorDaemon({
      store: createMockStore(),
      logger: createMockLogger(),
      memoryIndexEnabled: false,
      sleepEnabled: false,
      tradingEnabled: false,
      cryptoTradingEnabled: false,
      polymarketTradingEnabled: false,
      yieldRouterEnabled: true,
      yieldRouter,
      yieldRouterOrchestrator,
      pidPath: '/tmp/yield-router.pid',
      statusPath: '/tmp/yield-router-status.json',
      logPath: '/tmp/yield-router.log',
      taskLogDir: '/tmp/yield-router-tasks',
      wakeSignalPath: '/tmp/yield-router-wake.signal',
    });

    const result = await yieldDaemon.runYieldRebalancePhase({
      key: 'yield_rebalance',
      marketDate: '2026-03-19',
      scheduledAt: '2026-03-19T18:00:00.000Z',
      windowKey: '2026-03-19T18:00:00.000Z',
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      phase: 'yield_rebalance',
      summary: expect.objectContaining({
        action: 'return_idle',
        deposited: 250,
        withdrawn: 0,
        idleCapital: 250,
        yieldGap: 250,
        killSwitch: false,
      }),
    }));
    expect(yieldRouterOrchestrator.getUnifiedPortfolioSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      date: '2026-03-19',
      includePolymarket: true,
      yieldRouter,
    }));
    expect(yieldRouterOrchestrator.returnIdleCapital).toHaveBeenCalledWith(expect.objectContaining({
      portfolioSnapshot: expect.objectContaining({
        totalEquity: 1000,
      }),
      yieldRouter,
      dryRun: false,
      killSwitchTriggered: false,
    }));
    expect(yieldDaemon.yieldRouterState.lastRebalance).toEqual(expect.objectContaining({
      rebalanceResult: expect.objectContaining({
        amount: 250,
      }),
    }));

    await yieldDaemon.stop('test-cleanup-yield-router');
  });

  test('withdraws all yield positions when the kill switch is triggered during rebalance', async () => {
    const yieldRouter = {
      requestCapital: jest.fn(),
      returnCapital: jest.fn(),
    };
    const yieldRouterOrchestrator = {
      getUnifiedPortfolioSnapshot: jest.fn().mockResolvedValue({
        totalEquity: 700,
        markets: {
          alpaca_stocks: { equity: 250 },
          alpaca_crypto: { equity: 0 },
          ibkr_global: { equity: 0 },
          polymarket: { equity: 0 },
          defi_yield: { equity: 180 },
          solana_tokens: { equity: 0 },
          cash_reserve: { cash: 270, equity: 270 },
        },
        risk: {
          killSwitchTriggered: true,
        },
      }),
      getCapitalAllocation: jest.fn().mockReturnValue({
        totalEquity: 700,
        excess: { idleCapital: 0 },
        gaps: { yield: 65, activeTrading: 0 },
      }),
      returnIdleCapital: jest.fn().mockResolvedValue({
        ok: true,
        action: 'withdraw_all',
        withdrawal: {
          ok: true,
          withdrawn: 180,
          sources: [{ venue: { protocol: 'Aave' }, amount: 180 }],
        },
      }),
    };
    const yieldDaemon = new SupervisorDaemon({
      store: createMockStore(),
      logger: createMockLogger(),
      memoryIndexEnabled: false,
      sleepEnabled: false,
      tradingEnabled: false,
      cryptoTradingEnabled: false,
      polymarketTradingEnabled: false,
      yieldRouterEnabled: true,
      yieldRouter,
      yieldRouterOrchestrator,
      pidPath: '/tmp/yield-router-kill.pid',
      statusPath: '/tmp/yield-router-kill-status.json',
      logPath: '/tmp/yield-router-kill.log',
      taskLogDir: '/tmp/yield-router-kill-tasks',
      wakeSignalPath: '/tmp/yield-router-kill-wake.signal',
    });

    const result = await yieldDaemon.runYieldRebalancePhase({
      key: 'yield_rebalance',
      marketDate: '2026-03-19',
      scheduledAt: '2026-03-19T19:00:00.000Z',
      windowKey: '2026-03-19T19:00:00.000Z',
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      summary: expect.objectContaining({
        action: 'withdraw_all',
        withdrawn: 180,
        killSwitch: true,
      }),
    }));
    expect(yieldRouterOrchestrator.returnIdleCapital).toHaveBeenCalledWith(expect.objectContaining({
      killSwitchTriggered: true,
    }));

    await yieldDaemon.stop('test-cleanup-yield-router-kill');
  });

  test('runs yield rebalance after market close review and on the 6-hour schedule', async () => {
    const tradingOrchestrator = {
      runMarketClose: jest.fn().mockResolvedValue({
        phase: 'market_close',
        marketDate: '2026-03-19',
        openPositions: [],
      }),
      runPreMarket: jest.fn(),
      runConsensusRound: jest.fn(),
      runMarketOpen: jest.fn(),
      runMidDayCheck: jest.fn(),
      runEndOfDay: jest.fn(),
    };
    const yieldRouter = {
      requestCapital: jest.fn(),
      returnCapital: jest.fn(),
    };
    const yieldRouterOrchestrator = {
      getUnifiedPortfolioSnapshot: jest.fn().mockResolvedValue({
        totalEquity: 1000,
        markets: {
          alpaca_stocks: { equity: 400 },
          alpaca_crypto: { equity: 0 },
          ibkr_global: { equity: 0 },
          polymarket: { equity: 0 },
          defi_yield: { equity: 150 },
          solana_tokens: { equity: 0 },
          cash_reserve: { cash: 450, equity: 450 },
        },
        risk: {
          killSwitchTriggered: false,
        },
      }),
      getCapitalAllocation: jest.fn().mockReturnValue({
        totalEquity: 1000,
        excess: { idleCapital: 200 },
        gaps: { yield: 200, activeTrading: 0 },
      }),
      returnIdleCapital: jest.fn().mockResolvedValue({
        ok: true,
        action: 'return_idle',
        amount: 200,
        deposit: { deposited: 200 },
      }),
    };
    const yieldDaemon = new SupervisorDaemon({
      store: createMockStore(),
      logger: createMockLogger(),
      memoryIndexEnabled: false,
      sleepEnabled: false,
      tradingEnabled: true,
      cryptoTradingEnabled: false,
      polymarketTradingEnabled: false,
      tradingOrchestrator,
      yieldRouterEnabled: true,
      yieldRouter,
      yieldRouterOrchestrator,
      pidPath: '/tmp/yield-router-trigger.pid',
      statusPath: '/tmp/yield-router-trigger-status.json',
      logPath: '/tmp/yield-router-trigger.log',
      taskLogDir: '/tmp/yield-router-trigger-tasks',
      wakeSignalPath: '/tmp/yield-router-trigger-wake.signal',
    });

    const tradingResult = await yieldDaemon.runTradingPhase({
      key: 'market_close_review',
      scheduledAt: '2026-03-19T20:00:00.000Z',
      windowKey: '2026-03-19T20:00:00.000Z',
    }, {
      marketDate: '2026-03-19',
    });

    expect(tradingResult).toEqual(expect.objectContaining({
      ok: true,
      phase: 'market_close_review',
    }));
    expect(yieldRouterOrchestrator.returnIdleCapital).toHaveBeenCalledWith(expect.objectContaining({
      killSwitchTriggered: false,
    }));
    expect(yieldDaemon.yieldRouterState.lastRebalance).toEqual(expect.objectContaining({
      triggerSource: 'market_close_review',
    }));

    yieldDaemon.yieldRouterState.lastProcessedAt = '2026-03-19T06:00:00.000Z';
    const scheduledResult = await yieldDaemon.maybeRunYieldRouterAutomation(new Date('2026-03-19T12:00:00.000Z'));

    expect(scheduledResult).toEqual(expect.objectContaining({
      ok: true,
      skipped: false,
    }));
    expect(scheduledResult.executed.map((entry) => entry.phase)).toEqual(['yield_rebalance']);
    expect(yieldDaemon.yieldRouterState.nextEvent).toEqual(expect.objectContaining({
      key: 'yield_rebalance',
    }));

    await yieldDaemon.stop('test-cleanup-yield-router-trigger');
  });

  test('keeps Polymarket automation disabled by default until explicitly opted in', async () => {
    const originalPrivateKey = process.env.POLYMARKET_PRIVATE_KEY;
    const originalFunder = process.env.POLYMARKET_FUNDER_ADDRESS;
    const originalAutomation = process.env.SQUIDRUN_POLYMARKET_AUTOMATION;

    try {
      process.env.POLYMARKET_PRIVATE_KEY = '0xabc123';
      process.env.POLYMARKET_FUNDER_ADDRESS = '0xfunder';
      delete process.env.SQUIDRUN_POLYMARKET_AUTOMATION;

      const polymarketDaemon = new SupervisorDaemon({
        store: createMockStore(),
        logger: createMockLogger(),
        memoryIndexEnabled: false,
        sleepEnabled: false,
        tradingEnabled: false,
        cryptoTradingEnabled: false,
        pidPath: '/tmp/polymarket-default-off.pid',
        statusPath: '/tmp/polymarket-default-off-status.json',
        logPath: '/tmp/polymarket-default-off.log',
        taskLogDir: '/tmp/polymarket-default-off-tasks',
        wakeSignalPath: '/tmp/polymarket-default-off-wake.signal',
      });

      expect(polymarketDaemon.polymarketTradingEnabled).toBe(false);
      expect(polymarketDaemon.lastPolymarketTradingSummary).toEqual(expect.objectContaining({
        enabled: false,
        status: 'disabled',
        reason: 'manual_opt_in_required',
      }));

      await polymarketDaemon.stop('test-cleanup-polymarket-default-off');
    } finally {
      if (originalPrivateKey == null) {
        delete process.env.POLYMARKET_PRIVATE_KEY;
      } else {
        process.env.POLYMARKET_PRIVATE_KEY = originalPrivateKey;
      }
      if (originalFunder == null) {
        delete process.env.POLYMARKET_FUNDER_ADDRESS;
      } else {
        process.env.POLYMARKET_FUNDER_ADDRESS = originalFunder;
      }
      if (originalAutomation == null) {
        delete process.env.SQUIDRUN_POLYMARKET_AUTOMATION;
      } else {
        process.env.SQUIDRUN_POLYMARKET_AUTOMATION = originalAutomation;
      }
    }
  });
});
