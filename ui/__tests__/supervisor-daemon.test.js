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
});
