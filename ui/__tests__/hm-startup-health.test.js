const fs = require('fs');
const os = require('os');
const path = require('path');
let childProcess;

jest.mock('child_process', () => ({
  spawnSync: jest.fn(() => ({
    status: 0,
    stdout: '{"ok":true,"alreadyRunning":true,"running":true,"pid":1234}',
    stderr: '',
  })),
}));

jest.mock('../scripts/hm-health-snapshot', () => ({
  main: jest.fn(() => 0),
  normalizeProjectRoot: jest.fn((value) => value || process.cwd()),
}));

jest.mock('../profile', () => ({
  DEFAULT_PROFILE: 'main',
  normalizeProfileName: jest.fn((value) => String(value || 'main').trim().toLowerCase() || 'main'),
}));

describe('hm-startup-health wrapper preflights', () => {
  let startupHealth;
  let tempRoot;

  beforeEach(() => {
    jest.resetModules();
    childProcess = require('child_process');
    childProcess.spawnSync.mockClear();
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-startup-health-'));
    startupHealth = require('../scripts/hm-startup-health');
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test('auto-starts the bidirectional wake watchdog before rendering startup health', () => {
    const exitCode = startupHealth.runStartupHealth([tempRoot, '--json'], {
      stderr: { write: jest.fn() },
    });
    const healthSnapshot = require('../scripts/hm-health-snapshot');

    expect(exitCode).toBe(0);
    expect(childProcess.spawnSync).toHaveBeenCalledWith(
      process.execPath,
      [
        expect.stringContaining('hm-telegram-poller-watchdog.js'),
        'recover',
        `--project-root=${tempRoot}`,
      ],
      expect.objectContaining({
        cwd: tempRoot,
        windowsHide: true,
      })
    );
    expect(childProcess.spawnSync).toHaveBeenCalledWith(
      process.execPath,
      [
        expect.stringContaining('hm-bidirectional-wake-watchdog.js'),
        'start',
      ],
      expect.objectContaining({
        cwd: tempRoot,
        windowsHide: true,
        env: expect.objectContaining({
          SQUIDRUN_PROJECT_ROOT: tempRoot,
        }),
      })
    );
    expect(healthSnapshot.main).toHaveBeenCalledWith([tempRoot, '--json']);
    expect(fs.existsSync(path.join(tempRoot, '.squidrun', 'runtime', 'bidirectional-wake-watchdog-start-last.json'))).toBe(true);
  });

  test('skips wake watchdog auto-start for side profiles and strips wrapper flags', () => {
    const exitCode = startupHealth.runStartupHealth([
      tempRoot,
      '--profile',
      'client',
      '--no-bidirectional-wake-watchdog-auto-start',
    ], {
      stderr: { write: jest.fn() },
    });
    const healthSnapshot = require('../scripts/hm-health-snapshot');

    expect(exitCode).toBe(0);
    expect(childProcess.spawnSync).not.toHaveBeenCalledWith(
      process.execPath,
      [expect.stringContaining('hm-bidirectional-wake-watchdog.js'), 'start'],
      expect.any(Object)
    );
    expect(healthSnapshot.main).toHaveBeenCalledWith([tempRoot, '--profile', 'client', '--markdown']);
  });

  test('does not mistake value-taking wrapper options for the project root', () => {
    startupHealth.runBidirectionalWakeWatchdogAutoStart([
      '--telegram-poller-stale-threshold-ms',
      '600000',
      tempRoot,
      '--json',
    ]);

    expect(childProcess.spawnSync).toHaveBeenCalledWith(
      process.execPath,
      [expect.stringContaining('hm-bidirectional-wake-watchdog.js'), 'start'],
      expect.objectContaining({
        cwd: tempRoot,
        env: expect.objectContaining({
          SQUIDRUN_PROJECT_ROOT: tempRoot,
        }),
      })
    );
  });

  test('reports a parsed watchdog ownership conflict without fallback start', () => {
    childProcess.spawnSync
      .mockImplementationOnce(() => ({
        status: 0,
        stdout: '{"ok":true,"recovery":{"ok":true}}',
        stderr: '',
      }))
      .mockImplementationOnce(() => ({
        status: 0,
        stdout: JSON.stringify({
          ok: false,
          status: 'ownership_conflict',
          reason: 'ownership_conflict',
          blocked: true,
          retryable: false,
        }),
        stderr: '',
      }));
    const stderr = { write: jest.fn() };

    const exitCode = startupHealth.runStartupHealth([tempRoot, '--json'], { stderr });
    const watchdogCalls = childProcess.spawnSync.mock.calls.filter(
      ([, args]) => String(args?.[0] || '').includes('hm-bidirectional-wake-watchdog.js')
    );

    expect(exitCode).toBe(0);
    expect(watchdogCalls).toHaveLength(1);
    expect(watchdogCalls[0][1]).toEqual([
      expect.stringContaining('hm-bidirectional-wake-watchdog.js'),
      'start',
    ]);
    expect(stderr.write).toHaveBeenCalledWith(
      expect.stringContaining('ownership_conflict')
    );
    const lastPath = path.join(
      tempRoot,
      '.squidrun',
      'runtime',
      'bidirectional-wake-watchdog-start-last.json'
    );
    expect(JSON.parse(fs.readFileSync(lastPath, 'utf8'))).toEqual(expect.objectContaining({
      ok: false,
      error: 'ownership_conflict',
      result: expect.objectContaining({
        ok: false,
        status: 'ownership_conflict',
      }),
    }));
  });
});
