'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function unexpectedElectronStderr(stderr) {
  const knownWidgetRejection = /^\[\d+:\d{4}\/\d{6}\.\d{3}:ERROR:interface_endpoint_client\.cc\(702\)\] Message \d+ rejected by interface blink\.mojom\.Widget(?:Host)?$/u;
  return String(stderr || '').split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !knownWidgetRejection.test(line));
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

describe('Team Room production-size scroll and resize behavior', () => {
  test('keeps 875-message desktop and phone history responsive while Latest and local-send follow stay truthful', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-team-room-window-performance-jest-'));
    const outputPath = path.join(tempRoot, 'result.json');
    const electronPackageRoot = path.dirname(require.resolve('electron/package.json'));
    const dependencyRoot = path.dirname(electronPackageRoot);
    const electronPath = process.platform === 'win32'
      ? path.join(electronPackageRoot, 'dist', 'electron.exe')
      : require('electron');
    const childPath = path.join(__dirname, 'fixtures', 'team-room-window-performance-child.js');
    const { ELECTRON_RUN_AS_NODE: _ignored, NODE_PATH: _ignoredNodePath, ...baseEnv } = process.env;
    let smokeRoot = null;
    try {
      const child = spawnSync(electronPath, ['--disable-error-dialogs', childPath], {
        cwd: path.resolve(__dirname, '..'),
        env: {
          ...baseEnv,
          NODE_PATH: dependencyRoot,
          TEAM_ROOM_WINDOW_PERFORMANCE_OUTPUT: outputPath,
        },
        encoding: 'utf8',
        timeout: 90_000,
        windowsHide: true,
      });
      const deadline = Date.now() + 80_000;
      let output = '';
      let result = null;
      while (Date.now() < deadline) {
        if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
          output = fs.readFileSync(outputPath, 'utf8');
          try { result = JSON.parse(output); } catch {}
          if (result?.complete === true) break;
          if (child.status !== 0 && result?.stage) break;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
      smokeRoot = result?.smokeRoot || null;
      result.mainProcessExited = waitForProcessExit(result?.mainPid);
      result.electronProcessesExited = waitForProcessesExit(result?.processPids || [result?.mainPid]);
      const boundedSmokePrefix = `${path.join(os.tmpdir(), 'squidrun-team-room-window-performance-')}`;
      if (typeof smokeRoot === 'string' && smokeRoot.startsWith(boundedSmokePrefix)) {
        fs.rmSync(smokeRoot, { recursive: true, force: true });
        result.smokeRootRemoved = !fs.existsSync(smokeRoot);
      }
      const unexpectedStderr = unexpectedElectronStderr(child.stderr);
      expect({ status: child.status, unexpectedStderr, output }).toEqual(expect.objectContaining({
        status: 0,
        unexpectedStderr: [],
      }));
      expect(result).toEqual(expect.objectContaining({
        complete: true,
        ok: true,
        electron: '28.3.3',
        node: '18.18.2',
        dependencyRoot,
        mainProcessExited: true,
        electronProcessesExited: true,
        smokeRootRemoved: true,
        consoleErrors: [],
        desktopResize: expect.objectContaining({
          width: 1100,
          messageCount: 150,
          latestLabel: 'Latest',
        }),
        phoneResize: expect.objectContaining({
          width: 390,
          messageCount: 150,
          latestLabel: 'Latest',
        }),
        // 875 seeded, one bounded window rendered, older history reachable.
        historyBefore: 150,
        historyAfter: 300,
        historyLoad: expect.objectContaining({
          after: expect.objectContaining({ messageCount: 300 }),
        }),
        liveGrowth: expect.objectContaining({
          before: expect.objectContaining({ messageCount: 300 }),
          after: expect.objectContaining({
            messageCount: 300,
            historyCount: 150,
            liveCount: 150,
          }),
        }),
        duplicate: expect.objectContaining({ statusCode: 200 }),
      }));
    } finally {
      const boundedSmokePrefix = `${path.join(os.tmpdir(), 'squidrun-team-room-window-performance-')}`;
      if (typeof smokeRoot === 'string' && smokeRoot.startsWith(boundedSmokePrefix)) {
        fs.rmSync(smokeRoot, { recursive: true, force: true });
      }
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 120_000);
});
