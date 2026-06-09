const fs = require('fs');
const os = require('os');
const path = require('path');
let childProcess;

jest.mock('child_process', () => ({
  spawn: jest.fn(() => ({
    pid: 9876,
    unref: jest.fn(),
  })),
}));

describe('hm-bidirectional-wake-watchdog runner control', () => {
  let tempRoot;
  let moduleUnderTest;

  beforeEach(() => {
    jest.resetModules();
    childProcess = require('child_process');
    childProcess.spawn.mockClear();
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-bidir-wake-runner-'));
    jest.doMock('../config', () => ({
      getProjectRoot: () => tempRoot,
      resolveCoordPath: (relPath) => path.join(
        tempRoot,
        '.squidrun',
        String(relPath || '')
          .replace(/^[/\\]+/, '')
          .replace(/[/\\]+/g, path.sep)
      ),
    }));
    moduleUnderTest = require('../scripts/hm-bidirectional-wake-watchdog');
  });

  afterEach(() => {
    jest.dontMock('../config');
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test('startRunner no-ops when a fresh matching runner is already live', () => {
    const statusPath = path.join(tempRoot, '.squidrun', 'runtime', 'bidirectional-wake-watchdog-status.json');
    const pidPath = path.join(tempRoot, '.squidrun', 'runtime', 'bidirectional-wake-watchdog.pid');
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    fs.writeFileSync(pidPath, String(process.pid), 'utf8');
    fs.writeFileSync(statusPath, JSON.stringify({
      version: 1,
      role: 'bidirectional-wake-watchdog',
      pid: process.pid,
      running: true,
      intervalMs: 60_000,
      heartbeatAt: new Date().toISOString(),
    }, null, 2), 'utf8');

    const result = moduleUnderTest.startRunner({ projectRoot: tempRoot });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      alreadyRunning: true,
      running: true,
      pid: process.pid,
    }));
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  test('startRunner spawns a singleton child when no fresh runner exists', () => {
    const result = moduleUnderTest.startRunner({ projectRoot: tempRoot });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      started: true,
      pid: 9876,
      statePath: path.join(tempRoot, '.squidrun', 'runtime', 'bidirectional-wake-state.json'),
    }));
    expect(childProcess.spawn).toHaveBeenCalledTimes(1);
    expect(childProcess.spawn).toHaveBeenCalledWith(
      expect.any(String),
      [
        expect.stringContaining('hm-bidirectional-wake-watchdog.js'),
        'run',
        '--state',
        path.join(tempRoot, '.squidrun', 'runtime', 'bidirectional-wake-state.json'),
        '--interval-ms',
        '60000',
      ],
      expect.objectContaining({
        cwd: tempRoot,
        detached: true,
        windowsHide: true,
        env: expect.objectContaining({
          SQUIDRUN_PROJECT_ROOT: tempRoot,
        }),
      })
    );
  });
});
