'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

describe('Team Room typewriter browser behavior', () => {
  test('types only new agent replies, supports skip, bounds duration, and respects reduced motion', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-team-room-typewriter-jest-'));
    const outputPath = path.join(tempRoot, 'result.json');
    const electronPackageRoot = path.dirname(require.resolve('electron/package.json'));
    const electronPath = process.platform === 'win32'
      ? path.join(electronPackageRoot, 'dist', 'electron.exe')
      : require('electron');
    const childPath = path.join(__dirname, 'fixtures', 'team-room-typewriter-browser-child.js');
    const { ELECTRON_RUN_AS_NODE: _ignored, ...baseEnv } = process.env;
    try {
      const child = spawnSync(electronPath, [childPath], {
        cwd: path.resolve(__dirname, '..'),
        env: { ...baseEnv, TEAM_ROOM_TYPEWRITER_OUTPUT: outputPath },
        encoding: 'utf8',
        timeout: 60_000,
        windowsHide: true,
      });
      const outputDeadline = Date.now() + 50_000;
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
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 80_000);
});
