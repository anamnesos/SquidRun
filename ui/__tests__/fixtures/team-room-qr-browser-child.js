'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const { TeamRoomRuntime } = require('../../modules/main/team-room-runtime');
const { createTeamRoomWindow } = require('../../modules/main/team-room-window');

const outputPath = path.resolve(String(process.env.TEAM_ROOM_QR_OUTPUT || ''));
const screenshotPath = String(process.env.TEAM_ROOM_QR_SCREENSHOT || '').trim();
const headerScreenshotPath = String(process.env.TEAM_ROOM_QR_HEADER_SCREENSHOT || '').trim();
const maximizedHeaderScreenshotPath = String(process.env.TEAM_ROOM_QR_MAXIMIZED_HEADER_SCREENSHOT || '').trim();
const nativeHeaderScreenshotPath = String(process.env.TEAM_ROOM_QR_NATIVE_HEADER_SCREENSHOT || '').trim();
const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-team-room-qr-browser-'));
app.setPath('userData', path.join(smokeRoot, 'user-data'));
app.commandLine.appendSwitch('disable-gpu');

function checkpoint(stage, details = {}) {
  if (!process.env.TEAM_ROOM_QR_OUTPUT) return;
  fs.writeFileSync(outputPath, `${JSON.stringify({ complete: false, stage, smokeRoot, ...details }, null, 2)}\n`, 'utf8');
}

checkpoint('module-loaded');

function bindings(appGeneration) {
  return {
    ok: true,
    bindings: Object.fromEntries(['architect', 'builder', 'oracle'].map((role, index) => [role, {
      role,
      paneId: String(index + 1),
      profileName: 'main',
      paneLaunchId: `pl_${String(index + 1).repeat(32)}`,
      appGeneration,
    }])),
  };
}

async function waitForRenderer(windowRef, predicate, timeoutMs = 12_000, label = 'unnamed') {
  return windowRef.webContents.executeJavaScript(`(async () => {
    const deadline = Date.now() + ${Number(timeoutMs)};
    while (Date.now() < deadline) {
      const value = (${predicate})();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 35));
    }
    throw new Error('team_room_qr_wait_timeout:${String(label)}');
  })()`);
}

async function readHeaderGeometry(windowRef) {
  return windowRef.webContents.executeJavaScript(`(async () => {
    const overflow = document.querySelector('#roomOverflow');
    overflow.open = true;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const logo = document.querySelector('.room-mark-logo');
    const header = document.querySelector('.room-header');
    const brandRect = document.querySelector('.room-brand').getBoundingClientRect();
    const triggerRect = document.querySelector('#roomOverflowTrigger').getBoundingClientRect();
    const panelRect = document.querySelector('.room-overflow-panel').getBoundingClientRect();
    const overlayRect = navigator.windowControlsOverlay?.getTitlebarAreaRect?.() || null;
    return {
      desktopShell: document.documentElement.dataset.roomShell,
      chromeMode: document.documentElement.dataset.roomChrome,
      headerPaddingRight: Number.parseFloat(getComputedStyle(header).paddingRight),
      captionHeight: Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--room-caption-height')),
      overlayVisible: navigator.windowControlsOverlay?.visible ?? null,
      overlayRect: overlayRect ? {
        left: overlayRect.left,
        right: overlayRect.right,
        top: overlayRect.top,
        bottom: overlayRect.bottom,
        width: overlayRect.width,
        height: overlayRect.height,
      } : null,
      logoCanonical: logo instanceof HTMLImageElement
        && logo.complete
        && logo.naturalWidth > 0
        && new URL(logo.src).pathname === '/squidrun-favicon.ico',
      logoNaturalWidth: logo instanceof HTMLImageElement ? logo.naturalWidth : 0,
      viewportWidth: window.innerWidth,
      brandRect: { left: brandRect.left, right: brandRect.right, top: brandRect.top, bottom: brandRect.bottom },
      triggerRightGap: window.innerWidth - triggerRect.right,
      triggerRect: { left: triggerRect.left, right: triggerRect.right, top: triggerRect.top, bottom: triggerRect.bottom },
      panelRect: { left: panelRect.left, right: panelRect.right, top: panelRect.top, bottom: panelRect.bottom },
    };
  })()`);
}

async function run() {
  if (!process.env.TEAM_ROOM_QR_OUTPUT) throw new Error('TEAM_ROOM_QR_OUTPUT_required');
  const appGeneration = `app-session-${Math.max(1, process.pid)}`;
  const runtime = new TeamRoomRuntime({
    appGeneration,
    projectRoot: smokeRoot,
    publicRoot: path.resolve(__dirname, '..', '..'),
    runtimeRoot: path.join(smokeRoot, '.squidrun', 'runtime', 'team-room'),
    host: '127.0.0.1',
    port: 0,
    lanEnabled: true,
    allowedOrigins: ['http://127.0.0.1:41321'],
    storeOptions: {
      dbPath: path.join(smokeRoot, 'room', 'room.db'),
      attachmentRoot: path.join(smokeRoot, 'room', 'attachments'),
    },
    deliverToPane: async () => ({ ok: true }),
    resolveCliBindings: ({ appGeneration }) => bindings(appGeneration),
    getRemoteAccessStatus: async () => ({ ok: true, enabled: true, origin: 'https://squidrun.test.ts.net' }),
    setRemoteAccessEnabled: async () => ({
      ok: false,
      enabled: false,
      reason: 'tailscale_serve_enable_failed',
      detail: '500 Internal Server Error: your Tailscale account does not support getting TLS certs',
    }),
  });
  let desktopWindow = null;
  let nativeWindow = null;
  let phoneWindow = null;
  let result = null;
  const consoleErrors = [];
  try {
    const started = await runtime.start();
    if (!started.ok) throw new Error(started.reason);
    checkpoint('runtime-started', { origin: started.origin });
    const electronCredential = runtime.issueElectronCredential();
    if (!electronCredential.ok) throw new Error(electronCredential.reason);
    const created = await createTeamRoomWindow({
      BrowserWindow,
      origin: started.origin,
      credentialToken: electronCredential.token,
      statePath: path.join(smokeRoot, 'window-state.json'),
      showOnReady: false,
      windowOptions: { width: 716, height: 1000, minWidth: 320, minHeight: 480 },
    });
    desktopWindow = created.window;
    desktopWindow.webContents.on('console-message', (_event, level, message) => {
      if (Number(level) >= 2) consoleErrors.push(`desktop:${message}`);
    });
    try {
      await waitForRenderer(desktopWindow, `() => document.querySelector('#connectionDot')?.dataset.state === 'connected'
        && !document.querySelector('#pairPhoneButton')?.hidden
        && document.querySelector('#remoteAccessLabel')?.textContent === 'Remote access: On'`, 12_000, 'desktop-ready');
    } catch (error) {
      error.result = await desktopWindow.webContents.executeJavaScript(`(() => ({
        stage: 'desktop-ready',
        connected: document.querySelector('#connectionDot')?.dataset.state || null,
        pairButtonHidden: document.querySelector('#pairPhoneButton')?.hidden ?? null,
        remoteButtonHidden: document.querySelector('#remoteAccessButton')?.hidden ?? null,
        remoteLabel: document.querySelector('#remoteAccessLabel')?.textContent || null,
        pairScreenHidden: document.querySelector('#pairScreen')?.hidden ?? null,
      }))()`);
      throw error;
    }
    checkpoint('desktop-ready');
    const headerDiagnostic = await readHeaderGeometry(desktopWindow);
    checkpoint('header-geometry-read', { headerDiagnostic });
    Object.assign(headerDiagnostic, await desktopWindow.webContents.executeJavaScript(`(async () => {
      const overflow = document.querySelector('#roomOverflow');
      const opened = {
        memberStackAbsent: !document.querySelector('.member-stack'),
        overflowVisible: !overflow.hidden,
        overflowOpen: overflow.open,
        menuVisible: getComputedStyle(document.querySelector('.room-overflow-panel')).display !== 'none',
        triggerLabel: document.querySelector('#roomOverflowTrigger').getAttribute('aria-label'),
        triggerStateHidden: document.querySelector('#roomOverflowState').hidden,
        remoteState: document.querySelector('#remoteAccessButton').dataset.state,
        visibleActions: [...document.querySelectorAll('.room-menu-item')]
          .filter((button) => !button.hidden)
          .map((button) => button.id),
      };
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      opened.escapeClosed = !overflow.open;
      document.querySelector('#roomOverflowTrigger').click();
      document.body.click();
      opened.outsideClosed = !overflow.open;
      document.querySelector('#roomOverflowTrigger').click();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return opened;
    })()`));
    if (headerScreenshotPath) {
      fs.mkdirSync(path.dirname(path.resolve(headerScreenshotPath)), { recursive: true });
      fs.writeFileSync(path.resolve(headerScreenshotPath), (await desktopWindow.webContents.capturePage()).toPNG());
    }
    checkpoint('header-captured');
    checkpoint('before-maximize');
    desktopWindow.maximize();
    checkpoint('after-maximize');
    await new Promise((resolve) => setTimeout(resolve, 250));
    const maximizedHeaderDiagnostic = {
      ...(await readHeaderGeometry(desktopWindow)),
      windowMaximized: desktopWindow.isMaximized(),
      windowBounds: desktopWindow.getBounds(),
    };
    checkpoint('maximized-header-read', { maximizedHeaderDiagnostic });
    if (maximizedHeaderScreenshotPath) {
      fs.mkdirSync(path.dirname(path.resolve(maximizedHeaderScreenshotPath)), { recursive: true });
      fs.writeFileSync(path.resolve(maximizedHeaderScreenshotPath), (await desktopWindow.webContents.capturePage()).toPNG());
    }
    checkpoint('maximized-header-captured');
    desktopWindow.restore();
    checkpoint('restore-called');
    await new Promise((resolve) => setTimeout(resolve, 250));
    await desktopWindow.webContents.executeJavaScript(`document.querySelector('#remoteAccessButton').click()`);
    await waitForRenderer(desktopWindow, `() => document.querySelector('#remoteAccessLabel')?.textContent.includes('Enable HTTPS Certificates')`, 12_000, 'remote-error');
    const remoteAccessDiagnostic = await desktopWindow.webContents.executeJavaScript(`(() => ({
      label: document.querySelector('#remoteAccessLabel').textContent,
      title: document.querySelector('#remoteAccessButton').title,
      pressed: document.querySelector('#remoteAccessButton').getAttribute('aria-pressed'),
      actionClosed: !document.querySelector('#roomOverflow').open,
    }))()`);
    await desktopWindow.webContents.executeJavaScript(`document.querySelector('#roomOverflowTrigger').click()`);
    await desktopWindow.webContents.executeJavaScript(`document.querySelector('#pairPhoneButton').click()`);
    await waitForRenderer(desktopWindow, `() => document.querySelector('#pairDialog')?.open
      && document.querySelector('#pairQrImage')?.complete
      && document.querySelector('#pairQrImage')?.naturalWidth > 0`, 12_000, 'dialog-ready');
    const dialog = await desktopWindow.webContents.executeJavaScript(`(() => ({
      pairButtonVisible: !document.querySelector('#pairPhoneButton').hidden,
      open: document.querySelector('#pairDialog').open,
      title: document.querySelector('#pairDialog h2').textContent,
      instruction: document.querySelector('#pairDialog .pair-dialog-card > p').textContent,
      qrSrc: document.querySelector('#pairQrImage').src,
      qrNaturalWidth: document.querySelector('#pairQrImage').naturalWidth,
      claimUrl: document.querySelector('#pairUrl').textContent,
      pairingCode: document.querySelector('#pairCodeDisplay').textContent.replace(/\\s/gu, ''),
      expiry: document.querySelector('#pairExpiry').textContent,
      actionClosed: !document.querySelector('#roomOverflow').open,
    }))()`);
    await desktopWindow.webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    checkpoint('dialog-ready', { dialog: { ...dialog, qrSrc: dialog.qrSrc.slice(0, 30) } });
    if (screenshotPath) {
      fs.mkdirSync(path.dirname(path.resolve(screenshotPath)), { recursive: true });
      fs.writeFileSync(path.resolve(screenshotPath), (await desktopWindow.webContents.capturePage()).toPNG());
    }
    checkpoint('dialog-captured', { screenshot: screenshotPath ? path.resolve(screenshotPath) : null });

    const pairingUrl = await desktopWindow.webContents.executeJavaScript(
      `document.querySelector('#pairQrImage').alt && document.querySelector('#pairUrl').textContent
        + '#pair=' + document.querySelector('#pairCodeDisplay').textContent.replace(/\\s/gu, '')`
    );
    phoneWindow = new BrowserWindow({
      show: false,
      width: 390,
      height: 844,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        partition: 'persist:squidrun-team-room-qr-phone',
        sandbox: true,
      },
    });
    phoneWindow.webContents.on('console-message', (_event, level, message) => {
      if (Number(level) >= 2) consoleErrors.push(`phone:${message}`);
    });
    await phoneWindow.loadURL(pairingUrl);
    checkpoint('phone-loaded');
    await waitForRenderer(phoneWindow, `() => document.querySelector('#connectionDot')?.dataset.state === 'connected'
      && document.querySelector('#pairScreen')?.hidden
      && location.hash === ''`, 12_000, 'phone-auto-claim');
    const phone = await phoneWindow.webContents.executeJavaScript(`(() => ({
      authenticated: document.querySelector('#pairScreen').hidden,
      connected: document.querySelector('#connectionDot').dataset.state,
      hash: location.hash,
      path: location.pathname,
    }))()`);
    const cookies = await phoneWindow.webContents.session.cookies.get({ url: `${started.origin}/` });
    const pairedCookie = cookies.find((cookie) => cookie.name === 'squidrun_team_room');
    checkpoint('phone-paired', { phone, pairedCookiePresent: Boolean(pairedCookie) });

    // James's currently running main process predates overlay chrome. It loads the
    // new static page at bare `/` inside a normal framed BrowserWindow, so prove
    // that exact mixed-version close/reopen path separately from the next-restart
    // `?chrome=overlay` path above.
    nativeWindow = new BrowserWindow({
      show: false,
      width: 716,
      height: 1000,
      title: 'SquidRun Team Room',
      backgroundColor: '#0c1014',
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: true,
        partition: 'persist:squidrun-team-room',
      },
    });
    nativeWindow.webContents.on('console-message', (_event, level, message) => {
      if (Number(level) >= 2) consoleErrors.push(`native:${message}`);
    });
    await nativeWindow.loadURL(`${started.origin}/`);
    await waitForRenderer(nativeWindow, `() => document.querySelector('#connectionDot')?.dataset.state === 'connected'
      && !document.querySelector('#roomOverflow')?.hidden`, 12_000, 'native-header-ready');
    const nativeHeaderDiagnostic = await readHeaderGeometry(nativeWindow);
    if (nativeHeaderScreenshotPath) {
      fs.mkdirSync(path.dirname(path.resolve(nativeHeaderScreenshotPath)), { recursive: true });
      fs.writeFileSync(path.resolve(nativeHeaderScreenshotPath), (await nativeWindow.webContents.capturePage()).toPNG());
    }

    result = {
      complete: true,
      ok: dialog.pairButtonVisible
        && headerDiagnostic.desktopShell === 'desktop'
        && headerDiagnostic.chromeMode === 'overlay'
        && headerDiagnostic.headerPaddingRight < 80
        && headerDiagnostic.triggerRightGap >= 8
        && headerDiagnostic.triggerRightGap <= 24
        && headerDiagnostic.logoCanonical
        && headerDiagnostic.logoNaturalWidth >= 128
        && headerDiagnostic.overlayVisible
        && headerDiagnostic.overlayRect?.height > 0
        && Math.abs(headerDiagnostic.captionHeight - headerDiagnostic.overlayRect.height) < 0.5
        && headerDiagnostic.triggerRect.top >= headerDiagnostic.overlayRect.bottom
        && headerDiagnostic.brandRect.right < headerDiagnostic.triggerRect.left
        && headerDiagnostic.memberStackAbsent
        && headerDiagnostic.overflowVisible
        && headerDiagnostic.overflowOpen
        && headerDiagnostic.menuVisible
        && headerDiagnostic.triggerLabel === 'Room options. Remote access on.'
        && !headerDiagnostic.triggerStateHidden
        && headerDiagnostic.remoteState === 'on'
        && headerDiagnostic.triggerRect.left >= 0
        && headerDiagnostic.triggerRect.right <= headerDiagnostic.viewportWidth
        && headerDiagnostic.panelRect.left >= 0
        && headerDiagnostic.panelRect.right <= headerDiagnostic.viewportWidth
        && maximizedHeaderDiagnostic.windowMaximized
        && maximizedHeaderDiagnostic.logoCanonical
        && maximizedHeaderDiagnostic.triggerRightGap >= 8
        && maximizedHeaderDiagnostic.triggerRightGap <= 24
        && maximizedHeaderDiagnostic.triggerRect.top >= maximizedHeaderDiagnostic.overlayRect.bottom
        && maximizedHeaderDiagnostic.brandRect.right < maximizedHeaderDiagnostic.triggerRect.left
        && maximizedHeaderDiagnostic.panelRect.left >= 0
        && maximizedHeaderDiagnostic.panelRect.right <= maximizedHeaderDiagnostic.viewportWidth
        && headerDiagnostic.visibleActions.join(',') === 'pairPhoneButton,remotePairButton,remoteAccessButton'
        && headerDiagnostic.escapeClosed
        && headerDiagnostic.outsideClosed
        && remoteAccessDiagnostic.label === 'Remote access: Error — Enable HTTPS Certificates in the Tailscale DNS settings, then try again.'
        && remoteAccessDiagnostic.title === 'Enable HTTPS Certificates in the Tailscale DNS settings, then try again.'
        && remoteAccessDiagnostic.pressed === 'false'
        && remoteAccessDiagnostic.actionClosed
        && dialog.open
        && dialog.actionClosed
        && dialog.title === 'Pair your phone'
        && /scan/iu.test(dialog.instruction)
        && dialog.qrSrc.startsWith('data:image/png;base64,')
        && dialog.qrNaturalWidth === 256
        && dialog.claimUrl === `${started.origin}/`
        && /^\d{6}$/u.test(dialog.pairingCode)
        && /One use/iu.test(dialog.expiry)
        && phone.authenticated
        && phone.connected === 'connected'
        && phone.hash === ''
        && pairedCookie?.httpOnly === true
        && pairedCookie?.sameSite === 'strict'
        && nativeHeaderDiagnostic.desktopShell === 'desktop'
        && nativeHeaderDiagnostic.chromeMode === 'native'
        && nativeHeaderDiagnostic.headerPaddingRight < 80
        && nativeHeaderDiagnostic.logoCanonical
        && nativeHeaderDiagnostic.triggerRightGap >= 0
        && nativeHeaderDiagnostic.triggerRightGap <= 50
        && nativeHeaderDiagnostic.triggerRect.left >= 0
        && nativeHeaderDiagnostic.triggerRect.right <= nativeHeaderDiagnostic.viewportWidth
        && nativeHeaderDiagnostic.panelRect.left >= 0
        && nativeHeaderDiagnostic.panelRect.right <= nativeHeaderDiagnostic.viewportWidth
        && consoleErrors.length === 0,
      electron: process.versions.electron,
      node: process.versions.node,
      origin: started.origin,
      remoteAccessDiagnostic,
      headerDiagnostic,
      maximizedHeaderDiagnostic,
      nativeHeaderDiagnostic,
      dialog: {
        ...dialog,
        qrSrc: dialog.qrSrc.slice(0, 30),
      },
      phone,
      pairedCookie: pairedCookie ? {
        httpOnly: pairedCookie.httpOnly,
        sameSite: pairedCookie.sameSite,
        expirationDate: pairedCookie.expirationDate,
      } : null,
      consoleErrors,
      screenshot: screenshotPath ? path.resolve(screenshotPath) : null,
      smokeRoot,
    };
  } finally {
    checkpoint('cleanup-started', { resultReady: Boolean(result) });
    try { phoneWindow?.destroy(); } catch {}
    try { nativeWindow?.destroy(); } catch {}
    try { desktopWindow?.destroy(); } catch {}
    for (const client of runtime.clients) {
      try { client.terminate(); } catch {}
    }
    try { runtime.server?.closeAllConnections?.(); } catch {}
    try {
      await Promise.race([
        runtime.stop(),
        new Promise((resolve) => setTimeout(resolve, 3_000)),
      ]);
    } catch {}
    try { fs.rmSync(smokeRoot, { recursive: true, force: true }); } catch {}
    if (result) result.smokeRootRemoved = !fs.existsSync(smokeRoot);
  }
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  if (!result?.ok) throw new Error('team_room_qr_browser_smoke_failed');
}

app.whenReady()
  .then(run)
  .then(() => app.quit())
  .catch((error) => {
    try {
      fs.writeFileSync(outputPath, `${JSON.stringify({
        ...(error.result || {}),
        complete: true,
        ok: false,
        error: error.stack || error.message,
        smokeRoot,
      }, null, 2)}\n`, 'utf8');
    } catch {}
    app.exit(1);
  });
