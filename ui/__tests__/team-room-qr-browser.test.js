'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function unexpectedElectronStderr(stderr) {
  const knownWidgetRejection = /^\[\d+:\d{4}\/\d{6}\.\d{3}:ERROR:(?:.*[\\/])?interface_endpoint_client\.cc(?::\d+|\(\d+\))\] Message \d+ rejected by interface blink\.mojom\.Widget(?:Host)?$/u;
  return String(stderr || '').split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !knownWidgetRejection.test(line));
}

describe('Team Room QR pairing browser flow', () => {
  test('renders the dialog and claims once from the scrubbed fragment in the installed Electron runtime', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-team-room-qr-jest-'));
    const outputPath = path.join(tempRoot, 'result.json');
    const screenshotPath = path.join(tempRoot, 'pair-dialog.png');
    const headerScreenshotPath = path.join(tempRoot, 'room-menu.png');
    const maximizedHeaderScreenshotPath = path.join(tempRoot, 'maximized-room-menu.png');
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
          TEAM_ROOM_QR_MAXIMIZED_HEADER_SCREENSHOT: maximizedHeaderScreenshotPath,
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
      const unexpectedStderr = unexpectedElectronStderr(child.stderr);
      expect({ status: child.status, unexpectedStderr, output }).toEqual(expect.objectContaining({
        status: 0,
        unexpectedStderr: [],
      }));
      expect(result).toEqual(expect.objectContaining({
        ok: true,
        electron: require('electron/package.json').version,
        node: expect.stringMatching(/^\d+\.\d+\.\d+$/u),
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
        logoCanonical: true,
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
      expect(result.headerDiagnostic.logoNaturalWidth).toBeGreaterThanOrEqual(128);
      expect(result.headerDiagnostic.triggerRightGap).toBeGreaterThanOrEqual(8);
      expect(result.headerDiagnostic.triggerRightGap).toBeLessThanOrEqual(24);
      expect(result.headerDiagnostic.triggerRect.top).toBeGreaterThanOrEqual(result.headerDiagnostic.overlayRect.bottom);
      expect(result.headerDiagnostic.brandRect.right).toBeLessThan(result.headerDiagnostic.triggerRect.left);
      expect(result.maximizedHeaderDiagnostic).toEqual(expect.objectContaining({
        windowMaximized: true,
        logoCanonical: true,
      }));
      expect(result.maximizedHeaderDiagnostic.triggerRightGap).toBeGreaterThanOrEqual(8);
      expect(result.maximizedHeaderDiagnostic.triggerRightGap).toBeLessThanOrEqual(24);
      expect(result.maximizedHeaderDiagnostic.triggerRect.top).toBeGreaterThanOrEqual(result.maximizedHeaderDiagnostic.overlayRect.bottom);
      expect(result.maximizedHeaderDiagnostic.brandRect.right).toBeLessThan(result.maximizedHeaderDiagnostic.triggerRect.left);
      expect(result.remoteAccessDiagnostic).toEqual(expect.objectContaining({
        label: 'Remote access: Error — Enable HTTPS Certificates in the Tailscale DNS settings, then try again.',
        title: 'Enable HTTPS Certificates in the Tailscale DNS settings, then try again. (tailscale_serve_enable_failed)',
        actionClosed: true,
      }));
      expect(result.externalManagedDiagnostic).toEqual(expect.objectContaining({
        label: 'Remote access: Error — Remote access for this window is managed outside SquidRun.',
        title: 'Remote access for this window is managed outside SquidRun. (team_room_remote_access_external_managed)',
      }));
      expect(result.externalManagedDiagnostic.panelRect.left).toBeGreaterThanOrEqual(0);
      expect(result.externalManagedDiagnostic.panelRect.right).toBeLessThanOrEqual(result.externalManagedDiagnostic.viewportWidth);
      expect(result.externalManagedDiagnostic.buttonRect.left).toBeGreaterThanOrEqual(result.externalManagedDiagnostic.panelRect.left);
      expect(result.externalManagedDiagnostic.buttonRect.right).toBeLessThanOrEqual(result.externalManagedDiagnostic.panelRect.right);
      expect(result.externalManagedDiagnostic.labelRect.left).toBeGreaterThanOrEqual(result.externalManagedDiagnostic.buttonRect.left);
      expect(result.externalManagedDiagnostic.labelRect.right).toBeLessThanOrEqual(result.externalManagedDiagnostic.buttonRect.right);
      expect(result.externalManagedDiagnostic.labelScrollWidth).toBeLessThanOrEqual(result.externalManagedDiagnostic.labelClientWidth);
      expect(result.nativeHeaderDiagnostic).toEqual(expect.objectContaining({
        desktopShell: 'desktop',
        chromeMode: 'native',
        logoCanonical: true,
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
      expect(fs.statSync(maximizedHeaderScreenshotPath).size).toBeGreaterThan(10_000);
      expect(fs.statSync(nativeHeaderScreenshotPath).size).toBeGreaterThan(10_000);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 60_000);
});
