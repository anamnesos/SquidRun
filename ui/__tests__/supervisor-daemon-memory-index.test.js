const fs = require('fs');
const os = require('os');
const path = require('path');

const { SupervisorDaemon } = require('../supervisor-daemon');

function makeLogger() {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

function makeDaemon(options = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-supervisor-memory-index-'));
  const indexAll = jest.fn().mockResolvedValue({
    ok: true,
    indexedGroups: 0,
    skippedGroups: 1,
    status: { document_count: 1 },
  });
  const daemon = new SupervisorDaemon({
    projectRoot: tempDir,
    dbPath: path.join(tempDir, 'supervisor.db'),
    logPath: options.logPath || path.join(tempDir, '.squidrun', 'runtime', 'supervisor.log'),
    statusPath: options.statusPath || path.join(tempDir, '.squidrun', 'runtime', 'supervisor-status.json'),
    pidPath: options.pidPath || path.join(tempDir, '.squidrun', 'runtime', 'supervisor.pid'),
    logger: makeLogger(),
    memorySearchIndex: {
      indexAll,
      close: jest.fn(),
    },
    memoryIndexDebounceMs: options.memoryIndexDebounceMs ?? 10,
    memoryIndexMinRefreshIntervalMs: options.memoryIndexMinRefreshIntervalMs,
    env: options.env || {},
  });
  return { daemon, tempDir, indexAll };
}

afterEach(() => {
  jest.useRealTimers();
});

describe('SupervisorDaemon memory index refresh scheduling', () => {
  test('defaults scoped profile supervisors to a minimum refresh interval', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-scoped-supervisor-'));
    const daemon = new SupervisorDaemon({
      projectRoot: tempDir,
      dbPath: path.join(tempDir, 'supervisor.db'),
      logPath: path.join(tempDir, '.squidrun', 'runtime-eunbyeol', 'supervisor.log'),
      statusPath: path.join(tempDir, '.squidrun', 'runtime-eunbyeol', 'supervisor-status.json'),
      pidPath: path.join(tempDir, '.squidrun', 'runtime-eunbyeol', 'supervisor.pid'),
      logger: makeLogger(),
      memorySearchIndex: { indexAll: jest.fn(), close: jest.fn() },
      env: { SQUIDRUN_PROFILE: 'scoped' },
    });

    expect(daemon.memoryIndexMinRefreshIntervalMs).toBeGreaterThanOrEqual(60_000);
  });

  test('skips watcher refresh when a small file is rewritten with unchanged content', () => {
    const { daemon, tempDir } = makeDaemon();
    const handoffPath = path.join(tempDir, 'session.md');
    fs.writeFileSync(handoffPath, 'same handoff\n');

    expect(daemon.shouldScheduleMemoryIndexRefreshForChange('change', handoffPath)).toMatchObject({
      schedule: true,
    });

    fs.writeFileSync(handoffPath, 'same handoff\n');

    expect(daemon.shouldScheduleMemoryIndexRefreshForChange('change', handoffPath)).toMatchObject({
      schedule: false,
      reason: 'unchanged_file',
    });
  });

  test('coalesces watcher refreshes inside the minimum refresh interval', () => {
    jest.useFakeTimers();
    const { daemon, indexAll } = makeDaemon({
      memoryIndexDebounceMs: 10,
      memoryIndexMinRefreshIntervalMs: 60_000,
    });
    daemon.lastMemoryIndexRefreshAtMs = 1_000;

    const result = daemon.scheduleMemoryIndexRefresh('change:session.md', { nowMs: 1_500 });

    expect(result).toMatchObject({
      deferred: true,
      reason: 'memory_index_min_interval_active',
    });
    expect(daemon.memoryIndexDebounceTimer).toBeNull();
    expect(indexAll).not.toHaveBeenCalled();

    daemon.stopMemoryIndexWatcher();
  });

  test('startup refresh is not throttled by the minimum interval', () => {
    jest.useFakeTimers();
    const { daemon } = makeDaemon({
      memoryIndexDebounceMs: 10,
      memoryIndexMinRefreshIntervalMs: 60_000,
    });
    daemon.lastMemoryIndexRefreshAtMs = 1_000;

    const result = daemon.scheduleMemoryIndexRefresh('startup', { nowMs: 1_500 });

    expect(result).toMatchObject({ scheduled: true });
    expect(daemon.memoryIndexDebounceTimer).toBeTruthy();

    daemon.stopMemoryIndexWatcher();
  });
});
