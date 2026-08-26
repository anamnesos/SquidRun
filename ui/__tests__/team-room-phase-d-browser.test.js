'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const boundedSmokeName = /^squidrun-team-room-phase-d-browser-[A-Za-z0-9_-]+$/u;

function resolveBoundedSmokeRoot(candidate) {
  if (typeof candidate !== 'string' || !candidate.trim()) return null;
  const resolved = path.resolve(candidate);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir())) return null;
  return boundedSmokeName.test(path.basename(resolved)) ? resolved : null;
}

function removeBoundedSmokeRoot(candidate) {
  const resolved = resolveBoundedSmokeRoot(candidate);
  if (!resolved || !fs.existsSync(resolved)) return !resolved ? false : true;
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`phase_d_smoke_root_unsafe:${resolved}`);
  }
  const cleanupDeadline = Date.now() + 5_000;
  while (fs.existsSync(resolved) && Date.now() < cleanupDeadline) {
    try { fs.rmSync(resolved, { recursive: true, force: true }); } catch {}
    if (fs.existsSync(resolved)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  return !fs.existsSync(resolved);
}

function unexpectedElectronStderr(stderr) {
  const knownWidgetRejection = /^\[\d+:\d{4}\/\d{6}\.\d{3}:ERROR:(?:.*[\\/])?interface_endpoint_client\.cc(?::\d+|\(\d+\))\] Message \d+ rejected by interface blink\.mojom\.Widget(?:Host)?$/u;
  return String(stderr || '').split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !knownWidgetRejection.test(line));
}

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

function waitForProcessExit(pid, timeoutMs = 5_000) {
  const targetPid = Number(pid);
  if (!Number.isInteger(targetPid) || targetPid <= 0) return false;
  const alive = () => {
    try { process.kill(targetPid, 0); return true; } catch { return false; }
  };
  const deadline = Date.now() + timeoutMs;
  while (alive() && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  return !alive();
}

function waitForProcessesExit(pids, timeoutMs = 5_000) {
  const targets = [...new Set((Array.isArray(pids) ? pids : [])
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 0))];
  if (targets.length === 0) return false;
  const alive = (pid) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  };
  const deadline = Date.now() + timeoutMs;
  while (targets.some(alive) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  return targets.every((pid) => !alive(pid));
}

describe('Team Room Phase D browser recovery flow', () => {
  test('proves reconnect, restart, draft/upload recovery, PWA, scroll, and phone behavior in the installed Electron runtime', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-team-room-phase-d-jest-'));
    const outputPath = path.join(tempRoot, 'result.json');
    const electronPackageRoot = path.dirname(require.resolve('electron/package.json'));
    const electronPath = process.platform === 'win32'
      ? path.join(electronPackageRoot, 'dist', 'electron.exe')
      : require('electron');
    const childPath = path.join(__dirname, 'fixtures', 'team-room-phase-d-browser-child.js');
    const { ELECTRON_RUN_AS_NODE: _ignored, ...baseEnv } = process.env;
    let result = null;
    try {
      const child = spawnSync(electronPath, [childPath], {
        cwd: path.resolve(__dirname, '..'),
        env: { ...baseEnv, TEAM_ROOM_PHASE_D_OUTPUT: outputPath },
        encoding: 'utf8',
        timeout: 90_000,
        windowsHide: true,
      });
      // Windows launches Electron through a short-lived GUI parent. The real
      // main process can continue after spawnSync returns, so the artifact is
      // the completion boundary rather than the launcher process lifetime.
      const outputDeadline = Date.now() + 80_000;
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
      result = parsedOutput || JSON.parse(output);
      if (child.status === null) stopProcessTree(result.mainPid);
      result.mainProcessExited = waitForProcessExit(result.mainPid);
      result.electronProcessesExited = waitForProcessesExit(result.processPids || [result.mainPid]);
      result.smokeRootRemoved = removeBoundedSmokeRoot(result.smokeRoot);
      const unexpectedStderr = unexpectedElectronStderr(child.stderr);
      expect({ status: child.status, unexpectedStderr, stdout: child.stdout, output }).toEqual(expect.objectContaining({
        status: 0,
        unexpectedStderr: [],
      }));
      expect(result).toEqual(expect.objectContaining({
        ok: true,
        electron: require('electron/package.json').version,
        node: expect.stringMatching(/^\d+\.\d+\.\d+$/u),
        mainProcessExited: true,
        electronProcessesExited: true,
        temporaryPathCount: 0,
        smokeRootRemoved: true,
        consoleErrors: [],
      }));
      expect(result.afterResume).toEqual(expect.objectContaining({ unreadLabel: '1 new message' }));
      expect(result.paneRespawn).toEqual(expect.objectContaining({
        alreadyRunning: true,
        builderTokenRotated: true,
        webSocketStillConnected: true,
      }));
      expect(result.attachmentPresentation).toEqual(expect.objectContaining({
        fileName: 'phase-d-recovery.pdf',
        fileNameVisible: true,
      }));
      expect(result.singleChooser).toEqual(expect.objectContaining({
        directHitTarget: true,
        visibleSourceRect: true,
        alignedToButton: true,
        hiddenAttribute: false,
        customMenuCount: 0,
        captureInputCount: 0,
        multiple: true,
        cancelNoop: true,
      }));
      expect(result.outboxFlow).toEqual(expect.objectContaining({
        count: 0,
        connected: 'connected',
      }));
      expect(result.responseLoss).toEqual(expect.objectContaining({
        responseDropped: true,
        outboxCount: 0,
        canonicalCount: 1,
      }));
      expect(result.failedDrain).toEqual(expect.objectContaining({
        firstDrainFailed: true,
        canonicalCount: 1,
      }));
    } finally {
      if (!result && fs.existsSync(outputPath)) {
        try { result = JSON.parse(fs.readFileSync(outputPath, 'utf8')); } catch {}
      }
      if (result?.smokeRoot) removeBoundedSmokeRoot(result.smokeRoot);
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 120_000);
});
