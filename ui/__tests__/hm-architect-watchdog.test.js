const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  HEARTBEAT_STALE_AFTER_MS,
  computeHeartbeatStale,
  writeHeartbeat,
} = require('../scripts/hm-architect-quiet-watch');
const {
  assessWatcherHealth,
} = require('../scripts/hm-architect-watchdog');

describe('architect quiet-watch / watchdog seam', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'architect-watchdog-'));
  });

  afterEach(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('quiet-watch writes a fresh heartbeat that the watchdog accepts', () => {
    const nowMs = Date.parse('2026-07-04T18:50:00.000Z');
    const statePath = path.join(tempDir, 'architect-quiet-watch-state.json');
    const configPath = path.join(tempDir, 'architect-quiet-watch-config.json');

    writeHeartbeat({
      configPath,
      statePath,
      nowMs,
      config: {
        intervalMs: 60_000,
        staleAfterMs: HEARTBEAT_STALE_AFTER_MS,
      },
    });

    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    expect(state.heartbeat.lastTickAt).toBe('2026-07-04T18:50:00.000Z');
    expect(computeHeartbeatStale(state.heartbeat.lastTickAt, nowMs + 1000, HEARTBEAT_STALE_AFTER_MS)).toBe(false);

    const assessment = assessWatcherHealth({
      watcherState: state,
      nowMs: nowMs + 1000,
      watchdogPid: 111,
      processes: [{
        ProcessId: 222,
        ParentProcessId: 111,
        CommandLine: `node ${path.join('ui', 'scripts', 'hm-architect-quiet-watch.js')}`,
      }],
    });

    expect(assessment).toEqual(expect.objectContaining({
      status: 'green',
      reason: 'healthy',
      shouldRestart: false,
    }));
  });

  test('watchdog marks missing heartbeat as stale and restartable', () => {
    expect(computeHeartbeatStale('', Date.parse('2026-07-04T18:50:00.000Z'), HEARTBEAT_STALE_AFTER_MS)).toBe(true);

    const assessment = assessWatcherHealth({
      watcherState: {},
      nowMs: Date.parse('2026-07-04T18:50:00.000Z'),
      watchdogPid: 111,
      processes: [],
    });

    expect(assessment).toEqual(expect.objectContaining({
      status: 'down',
      reason: 'process_missing',
      shouldRestart: true,
    }));
  });
});
