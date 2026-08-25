'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

function stopProcessTree(pid) {
  const targetPid = Number(pid);
  if (!Number.isInteger(targetPid) || targetPid <= 0) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill.exe', ['/PID', String(targetPid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } else {
      process.kill(targetPid, 'SIGKILL');
    }
  } catch {}
}

function readPidFile(pidPath) {
  try {
    const pid = Number(fs.readFileSync(pidPath, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function processAlive(pid) {
  const targetPid = Number(pid);
  if (!Number.isInteger(targetPid) || targetPid <= 0) return false;
  try { process.kill(targetPid, 0); return true; } catch { return false; }
}

describe('Team Room typewriter browser behavior', () => {
  test('types only new agent replies, supports skip, bounds duration, and respects reduced motion', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-team-room-typewriter-jest-'));
    const outputPath = path.join(tempRoot, 'result.json');
    const pidPath = path.join(tempRoot, 'electron.pid');
    const electronPackageRoot = path.dirname(require.resolve('electron/package.json'));
    const dependencyRoot = path.dirname(electronPackageRoot);
    const electronPath = process.platform === 'win32'
      ? path.join(electronPackageRoot, 'dist', 'electron.exe')
      : require('electron');
    const childPath = path.join(__dirname, 'fixtures', 'team-room-typewriter-browser-child.js');
    const { ELECTRON_RUN_AS_NODE: _ignored, NODE_PATH: _ignoredNodePath, ...baseEnv } = process.env;
    let childPid = null;
    try {
      const child = spawnSync(electronPath, ['--disable-error-dialogs', childPath], {
        cwd: path.resolve(__dirname, '..'),
        env: {
          ...baseEnv,
          NODE_PATH: dependencyRoot,
          TEAM_ROOM_TYPEWRITER_OUTPUT: outputPath,
          TEAM_ROOM_TYPEWRITER_PID: pidPath,
        },
        encoding: 'utf8',
        timeout: 60_000,
        windowsHide: true,
      });
      childPid = readPidFile(pidPath) || child.pid || null;
      if (child.status === null) stopProcessTree(childPid);
      const outputDeadline = Date.now() + (child.status === null ? 0 : 50_000);
      let output = '';
      let parsedOutput = null;
      while (Date.now() < outputDeadline) {
        if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
          output = fs.readFileSync(outputPath, 'utf8');
          try { parsedOutput = JSON.parse(output); } catch {}
          if (parsedOutput?.complete === true) break;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
      expect({ status: child.status, stdout: child.stdout, output }).toEqual(expect.objectContaining({
        status: 0,
      }));
      const result = parsedOutput || JSON.parse(output);
      const boundedSmokePrefix = `${path.join(os.tmpdir(), 'squidrun-team-room-typewriter-browser-')}`;
      if (typeof result.smokeRoot === 'string' && result.smokeRoot.startsWith(boundedSmokePrefix)) {
        const cleanupDeadline = Date.now() + 5_000;
        while (fs.existsSync(result.smokeRoot) && Date.now() < cleanupDeadline) {
          try { fs.rmSync(result.smokeRoot, { recursive: true, force: true }); } catch {}
          if (fs.existsSync(result.smokeRoot)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        }
        result.smokeRootRemoved = !fs.existsSync(result.smokeRoot);
      }
      expect(result).toEqual(expect.objectContaining({
        ok: true,
        electron: '28.3.3',
        node: '18.18.2',
        smokeRootRemoved: true,
        consoleErrors: [],
        history: expect.objectContaining({ full: true, active: false, activeCount: 0 }),
        james: expect.objectContaining({ full: true, active: false }),
        partial: expect.objectContaining({ active: true }),
        skipped: true,
        reduced: expect.objectContaining({ mediaMatches: true, active: false, full: true }),
        bounded: expect.objectContaining({ partial: true }),
      }));
      expect(result.bounded.elapsedMs).toBeLessThan(2_800);
    } finally {
      if (processAlive(childPid)) stopProcessTree(childPid);
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 80_000);
});
