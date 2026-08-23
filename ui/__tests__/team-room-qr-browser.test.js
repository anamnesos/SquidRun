'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

describe('Team Room QR pairing browser flow', () => {
  test('renders the dialog and claims once from the scrubbed fragment in Electron 28', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-team-room-qr-jest-'));
    const outputPath = path.join(tempRoot, 'result.json');
    const screenshotPath = path.join(tempRoot, 'pair-dialog.png');
    const headerScreenshotPath = path.join(tempRoot, 'room-menu.png');
    const nativeHeaderScreenshotPath = path.join(tempRoot, 'native-room-menu.png');
    const electronPackageRoot = path.dirname(require.resolve('electron/package.json'));
    const electronPath = process.platform === 'win32'
      ? path.join(electronPackageRoot, 'dist', 'electron.exe')
      : require('electron');
    const childPath = path.join(__dirname, 'fixtures', 'team-room-qr-browser-child.js');
    const { ELECTRON_RUN_AS_NODE: _ignored, ...baseEnv } = process.env;
    try {
      const child = spawnSync(electronPath, [childPath], {
        cwd: path.resolve(__dirname, '..'),
        env: {
          ...baseEnv,
          TEAM_ROOM_QR_OUTPUT: outputPath,
          TEAM_ROOM_QR_SCREENSHOT: screenshotPath,
          TEAM_ROOM_QR_HEADER_SCREENSHOT: headerScreenshotPath,
          TEAM_ROOM_QR_NATIVE_HEADER_SCREENSHOT: nativeHeaderScreenshotPath,
        },
        encoding: 'utf8',
        timeout: 45_000,
        windowsHide: true,
      });
      const outputDeadline = Date.now() + 35_000;
      let output = '';
      let result = null;
      while (Date.now() < outputDeadline) {
        if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
          output = fs.readFileSync(outputPath, 'utf8');
          try { result = JSON.parse(output); } catch {}
          if (result?.complete === true) break;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
      const boundedSmokePrefix = `${path.join(os.tmpdir(), 'squidrun-team-room-qr-browser-')}`;
      if (typeof result?.smokeRoot === 'string' && result.smokeRoot.startsWith(boundedSmokePrefix)) {
        const cleanupDeadline = Date.now() + 5_000;
        while (fs.existsSync(result.smokeRoot) && Date.now() < cleanupDeadline) {
          try { fs.rmSync(result.smokeRoot, { recursive: true, force: true }); } catch {}
          if (fs.existsSync(result.smokeRoot)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        }
        result.smokeRootRemoved = !fs.existsSync(result.smokeRoot);
      }
      expect({ status: child.status, stderr: child.stderr, output }).toEqual(expect.objectContaining({
        status: 0,
        stderr: '',
      }));
      expect(result).toEqual(expect.objectContaining({
        ok: true,
        electron: '28.3.3',
        node: '18.18.2',
        smokeRootRemoved: true,
        consoleErrors: [],
      }));
      expect(result.dialog).toEqual(expect.objectContaining({
        pairButtonVisible: true,
        open: true,
        title: 'Pair your phone',
        qrNaturalWidth: 256,
        pairingCode: expect.stringMatching(/^\d{6}$/u),
      }));
      expect(result.headerDiagnostic).toEqual(expect.objectContaining({
        desktopShell: 'desktop',
        chromeMode: 'overlay',
        logoInline: true,
        memberStackAbsent: true,
        overflowVisible: true,
        overflowOpen: true,
        menuVisible: true,
        triggerLabel: 'Room options. Remote access on.',
        triggerStateHidden: false,
        remoteState: 'on',
        visibleActions: ['pairPhoneButton', 'remotePairButton', 'remoteAccessButton'],
        escapeClosed: true,
        outsideClosed: true,
      }));
      expect(result.remoteAccessDiagnostic).toEqual(expect.objectContaining({ actionClosed: true }));
      expect(result.nativeHeaderDiagnostic).toEqual(expect.objectContaining({
        desktopShell: 'desktop',
        chromeMode: 'native',
        logoInline: true,
      }));
      expect(result.nativeHeaderDiagnostic.headerPaddingRight).toBeLessThan(80);
      expect(result.nativeHeaderDiagnostic.triggerRightGap).toBeGreaterThanOrEqual(0);
      expect(result.nativeHeaderDiagnostic.triggerRightGap).toBeLessThanOrEqual(50);
      expect(result.nativeHeaderDiagnostic.panelRect.left).toBeGreaterThanOrEqual(0);
      expect(result.nativeHeaderDiagnostic.panelRect.right).toBeLessThanOrEqual(result.nativeHeaderDiagnostic.viewportWidth);
      expect(result.dialog).toEqual(expect.objectContaining({ actionClosed: true }));
      expect(result.phone).toEqual(expect.objectContaining({
        authenticated: true,
        connected: 'connected',
        hash: '',
      }));
      expect(result.pairedCookie).toEqual(expect.objectContaining({
        httpOnly: true,
        sameSite: 'strict',
      }));
      expect(fs.statSync(screenshotPath).size).toBeGreaterThan(10_000);
      expect(fs.statSync(headerScreenshotPath).size).toBeGreaterThan(10_000);
      expect(fs.statSync(nativeHeaderScreenshotPath).size).toBeGreaterThan(10_000);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 60_000);
});
