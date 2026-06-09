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
    jest.restoreAllMocks();
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

  test('startRunner atomic lock prevents a concurrent double spawn before pid file exists', () => {
    let reentrantResult = null;
    childProcess.spawn.mockImplementationOnce(() => {
      reentrantResult = moduleUnderTest.startRunner({ projectRoot: tempRoot });
      return {
        pid: 9876,
        unref: jest.fn(),
      };
    });

    const result = moduleUnderTest.startRunner({ projectRoot: tempRoot });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      started: true,
      pid: 9876,
    }));
    expect(reentrantResult).toEqual(expect.objectContaining({
      ok: true,
      alreadyStarting: true,
      startInProgress: true,
      reason: 'start_in_progress',
    }));
    expect(childProcess.spawn).toHaveBeenCalledTimes(1);
  });

  test('startRunner stale-lock reclaim lets only one stale reclaimer spawn', () => {
    const lockPath = path.join(tempRoot, '.squidrun', 'runtime', 'bidirectional-wake-watchdog-start.lock');
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: 1111,
      createdAt: '2026-06-09T05:00:00.000Z',
      ownerToken: 'stale-owner',
    }), 'utf8');
    const staleDate = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, staleDate, staleDate);

    const originalRenameSync = fs.renameSync.bind(fs);
    let competitorResult = null;
    let reentered = false;
    const renameSpy = jest.spyOn(fs, 'renameSync').mockImplementation((src, dest) => {
      if (src === lockPath && !reentered) {
        reentered = true;
        renameSpy.mockImplementation(originalRenameSync);
        competitorResult = moduleUnderTest.startRunner({
          projectRoot: tempRoot,
          startLock: { staleAfterMs: 1_000 },
        });
        const error = new Error('stale lock already claimed');
        error.code = 'ENOENT';
        throw error;
      }
      return originalRenameSync(src, dest);
    });

    const result = moduleUnderTest.startRunner({
      projectRoot: tempRoot,
      startLock: { staleAfterMs: 1_000 },
    });

    expect(competitorResult).toEqual(expect.objectContaining({
      ok: true,
      started: true,
      pid: 9876,
    }));
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      alreadyStarting: true,
      startInProgress: true,
      reason: 'start_in_progress',
      claimReason: 'stale_lock_claim_lost',
    }));
    expect(childProcess.spawn).toHaveBeenCalledTimes(1);
  });

  test('startRunner does not spawn when stale claim captures a changed lock', () => {
    const lockPath = path.join(tempRoot, '.squidrun', 'runtime', 'bidirectional-wake-watchdog-start.lock');
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: 1111,
      createdAt: '2026-06-09T05:00:00.000Z',
      ownerToken: 'stale-owner',
    }), 'utf8');
    const staleDate = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, staleDate, staleDate);

    const originalRenameSync = fs.renameSync.bind(fs);
    let changed = false;
    jest.spyOn(fs, 'renameSync').mockImplementation((src, dest) => {
      if (src === lockPath && !changed) {
        changed = true;
        fs.writeFileSync(lockPath, JSON.stringify({
          pid: 2222,
          createdAt: new Date().toISOString(),
          ownerToken: 'fresh-owner',
        }), 'utf8');
      }
      return originalRenameSync(src, dest);
    });

    const result = moduleUnderTest.startRunner({
      projectRoot: tempRoot,
      startLock: { staleAfterMs: 1_000 },
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      alreadyStarting: true,
      startInProgress: true,
      reason: 'start_in_progress',
      claimReason: 'stale_lock_claim_mismatch',
    }));
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf8'))).toEqual(expect.objectContaining({
      ownerToken: 'fresh-owner',
    }));
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });
});
