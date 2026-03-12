const handlers = {};
let mockWatcher;

jest.mock('chokidar', () => ({
  watch: jest.fn(() => mockWatcher),
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

const chokidar = require('chokidar');
const { SupervisorDaemon } = require('../supervisor-daemon');

function createMockStore() {
  return {
    dbPath: '/tmp/supervisor.sqlite',
    init: jest.fn(() => ({ ok: true })),
    isAvailable: jest.fn(() => true),
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

describe('supervisor-daemon integrations', () => {
  let mockMemorySearchIndex;
  let mockSleepConsolidator;
  let daemon;

  beforeEach(() => {
    jest.useFakeTimers();
    for (const key of Object.keys(handlers)) delete handlers[key];
    mockWatcher = {
      on: jest.fn((event, handler) => {
        handlers[event] = handler;
        return mockWatcher;
      }),
      close: jest.fn().mockResolvedValue(),
    };

    mockMemorySearchIndex = {
      indexAll: jest.fn().mockResolvedValue({
        indexedGroups: 1,
        skippedGroups: 0,
        status: { document_count: 3 },
      }),
      close: jest.fn(),
    };

    mockSleepConsolidator = {
      shouldRun: jest.fn(() => ({ ok: false, reason: 'not_idle', activity: { idleMs: 1000, isIdle: false } })),
      runOnce: jest.fn().mockResolvedValue({ ok: true, episodeCount: 2, extractedCount: 2, generatedPrCount: 1 }),
      readActivitySnapshot: jest.fn(() => ({ idleMs: 1000, isIdle: false })),
      close: jest.fn(),
    };

    daemon = new SupervisorDaemon({
      store: createMockStore(),
      logger: createMockLogger(),
      memoryIndexEnabled: true,
      memoryIndexDebounceMs: 10,
      memorySearchIndex: mockMemorySearchIndex,
      sleepConsolidator: mockSleepConsolidator,
      pidPath: '/tmp/supervisor.pid',
      statusPath: '/tmp/supervisor-status.json',
      logPath: '/tmp/supervisor.log',
      taskLogDir: '/tmp/supervisor-tasks',
    });
    daemon.getMemoryIndexWatchTargets = jest.fn(() => ['/tmp/knowledge/**/*.md']);
  });

  afterEach(async () => {
    if (daemon) {
      await daemon.stopMemoryIndexWatcher();
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
    await jest.runOnlyPendingTimersAsync();
    if (daemon.memoryIndexRefreshPromise) {
      await daemon.memoryIndexRefreshPromise;
    }
    mockMemorySearchIndex.indexAll.mockClear();

    handlers.all('change', '/tmp/knowledge/user-context.md');
    handlers.all('change', '/tmp/knowledge/workflows.md');

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

  test('closes watcher, memory index, and sleep consolidator on stop', async () => {
    daemon.startMemoryIndexWatcher();
    await daemon.stopMemoryIndexWatcher();
    await daemon.stop('test');

    expect(mockWatcher.close).toHaveBeenCalledTimes(1);
    expect(mockMemorySearchIndex.close).toHaveBeenCalled();
    expect(mockSleepConsolidator.close).toHaveBeenCalled();
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
});
