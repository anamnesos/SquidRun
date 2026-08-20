'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

describe('Team Room Phase D browser recovery flow', () => {
  test('proves reconnect, restart, draft/upload recovery, PWA, scroll, and phone behavior in Electron 28', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-team-room-phase-d-jest-'));
    const outputPath = path.join(tempRoot, 'result.json');
    const electronPackageRoot = path.dirname(require.resolve('electron/package.json'));
    const electronPath = process.platform === 'win32'
      ? path.join(electronPackageRoot, 'dist', 'electron.exe')
      : require('electron');
    const childPath = path.join(__dirname, 'fixtures', 'team-room-phase-d-browser-child.js');
    const { ELECTRON_RUN_AS_NODE: _ignored, ...baseEnv } = process.env;
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
      expect({ status: child.status, stderr: child.stderr, stdout: child.stdout, output }).toEqual(expect.objectContaining({
        status: 0,
        stderr: '',
      }));
      const result = parsedOutput || JSON.parse(output);
      const boundedSmokePrefix = `${path.join(os.tmpdir(), 'squidrun-team-room-phase-d-browser-')}`;
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
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 120_000);
});
