'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

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

describe('main renderer hidden-window policy', () => {
  test('a task channel drains xterm writes without keeping hidden animation frames alive', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-background-throttling-jest-'));
    const outputPath = path.join(tempRoot, 'result.json');
    const electronPackageRoot = path.dirname(require.resolve('electron/package.json'));
    const electronPath = process.platform === 'win32'
      ? path.join(electronPackageRoot, 'dist', 'electron.exe')
      : require('electron');
    const childPath = path.join(__dirname, 'fixtures', 'window-background-throttling-child.js');
    const { ELECTRON_RUN_AS_NODE: _ignored, ...baseEnv } = process.env;
    let probeRoot = null;
    try {
      const child = spawnSync(electronPath, [childPath], {
        cwd: path.resolve(__dirname, '..'),
        env: { ...baseEnv, SQUIDRUN_BACKGROUND_THROTTLING_OUTPUT: outputPath },
        encoding: 'utf8',
        timeout: 30_000,
        windowsHide: true,
      });
      const deadline = Date.now() + 12_000;
      while ((!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) && Date.now() < deadline) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
      }
      const output = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '';
      expect({ status: child.status, stderr: child.stderr, output }).toEqual(expect.objectContaining({
        status: 0,
        stderr: '',
      }));
      const result = JSON.parse(output);
      probeRoot = result.probeRoot;
      result.mainProcessExited = waitForProcessExit(result.mainPid);
      result.electronProcessesExited = waitForProcessesExit(result.processPids || [result.mainPid]);
      expect(result).toEqual(expect.objectContaining({
        complete: true,
        ok: true,
        electron: require('electron/package.json').version,
        mainProcessExited: true,
        electronProcessesExited: true,
        throttledTimer: expect.objectContaining({
          backgroundThrottling: true,
          schedulerMode: 'timer',
          hidden: true,
          minimized: true,
          visible: false,
          visibilityState: 'hidden',
        }),
        throttledTask: expect.objectContaining({
          backgroundThrottling: true,
          schedulerMode: 'message-channel',
          hidden: true,
          minimized: true,
          visible: false,
          visibilityState: 'hidden',
        }),
        unthrottledTimer: expect.objectContaining({
          backgroundThrottling: false,
          schedulerMode: 'timer',
          hidden: false,
          minimized: true,
          visibilityState: 'visible',
        }),
        coveredTimer: expect.objectContaining({
          backgroundThrottling: true,
          schedulerMode: 'timer',
          focused: false,
          targetVisible: true,
          targetMinimized: false,
        }),
        coveredTask: expect.objectContaining({
          backgroundThrottling: true,
          schedulerMode: 'message-channel',
          focused: false,
          writes: 180,
          targetVisible: true,
          targetMinimized: false,
        }),
      }));
    } finally {
      const boundedProbePrefix = `${path.join(os.tmpdir(), 'squidrun-background-throttling-')}`;
      if (typeof probeRoot === 'string' && probeRoot.startsWith(boundedProbePrefix)) {
        fs.rmSync(probeRoot, { recursive: true, force: true });
      }
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 40_000);
});
