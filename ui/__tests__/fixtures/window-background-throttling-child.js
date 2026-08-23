'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const outputPath = path.resolve(String(process.env.SQUIDRUN_BACKGROUND_THROTTLING_OUTPUT || ''));
const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-background-throttling-'));
app.setPath('userData', path.join(probeRoot, 'user-data'));
app.commandLine.appendSwitch('disable-gpu');
app.on('window-all-closed', () => {});

function electronProcessIds() {
  try {
    return [...new Set([
      process.pid,
      ...app.getAppMetrics()
        .map((metric) => Number(metric.pid))
        .filter(Number.isInteger),
    ])];
  } catch {
    return [process.pid];
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDocumentVisibility(windowRef, expectedState, timeoutMs = 2_500) {
  const startedAt = Date.now();
  let observed = null;
  while (Date.now() - startedAt < timeoutMs) {
    observed = await windowRef.webContents.executeJavaScript(`({
      hidden: document.hidden,
      visibilityState: document.visibilityState,
    })`);
    if (observed.visibilityState === expectedState
      && observed.hidden === (expectedState === 'hidden')) {
      return { ...observed, settledAfterMs: Date.now() - startedAt };
    }
    await wait(25);
  }
  throw new Error(`background_throttling_visibility_timeout:${expectedState}:${JSON.stringify(observed)}`);
}

async function measureHiddenWindow(backgroundThrottling, schedulerMode) {
  const windowRef = new BrowserWindow({
    show: false,
    x: 0,
    y: 0,
    width: 640,
    height: 420,
    skipTaskbar: true,
    focusable: false,
    opacity: 0,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling,
    },
  });
  await windowRef.loadFile(path.join(__dirname, 'window-background-throttling.html'));
  windowRef.showInactive();
  await wait(120);
  windowRef.minimize();
  if (!windowRef.isMinimized()) throw new Error('background_throttling_probe_minimize_failed');
  // Windows can report the native window minimized before Chromium applies
  // occlusion. Hide the throttled probe as well so the renderer boundary is
  // deterministic; the separate covered-window cases prove the visible but
  // unfocused path used when another window sits above SquidRun.
  if (backgroundThrottling) windowRef.hide();
  const visibility = backgroundThrottling
    ? await waitForDocumentVisibility(windowRef, 'hidden')
    : await waitForDocumentVisibility(windowRef, 'visible');
  const before = await windowRef.webContents.executeJavaScript(`(() => {
    globalThis.__startWriteProbe(180, ${JSON.stringify(schedulerMode)});
    return { ...globalThis.__probe, hidden: document.hidden, visibilityState: document.visibilityState };
  })()`);
  await wait(1_600);
  const after = await windowRef.webContents.executeJavaScript('({ ...globalThis.__probe })');
  const windowState = {
    minimized: windowRef.isMinimized(),
    visible: windowRef.isVisible(),
  };
  windowRef.destroy();
  return {
    backgroundThrottling,
    schedulerMode,
    ticks: Number(after.ticks) - Number(before.ticks),
    frames: Number(after.frames) - Number(before.frames),
    writes: Number(after.writes) - Number(before.writes),
    writeDurationMs: Number(after.writeFinishedAt) > 0
      ? Number(after.writeFinishedAt) - Number(after.writeStartedAt)
      : null,
    maxGapMs: Number(after.maxGapMs),
    elapsedMs: 1_600,
    hidden: Boolean(before.hidden),
    visibilityState: String(before.visibilityState),
    visibilitySettledAfterMs: visibility.settledAfterMs,
    ...windowState,
  };
}

async function measureCoveredWindow(schedulerMode) {
  const target = new BrowserWindow({
    show: false,
    x: 16,
    y: 16,
    width: 320,
    height: 240,
    skipTaskbar: true,
    focusable: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: true,
    },
  });
  await target.loadFile(path.join(__dirname, 'window-background-throttling.html'));
  const cover = new BrowserWindow({
    show: false,
    x: 16,
    y: 16,
    width: 320,
    height: 240,
    skipTaskbar: true,
    focusable: false,
    backgroundColor: '#050505',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: true,
    },
  });
  await cover.loadURL('data:text/html,<body style="margin:0;background:%23050505"></body>');
  target.showInactive();
  cover.showInactive();
  cover.moveTop();
  await wait(1_800);
  const before = await target.webContents.executeJavaScript(`(() => {
    globalThis.__startWriteProbe(180, ${JSON.stringify(schedulerMode)});
    return {
      ...globalThis.__probe,
      hidden: document.hidden,
      focused: document.hasFocus(),
      visibilityState: document.visibilityState,
    };
  })()`);
  await wait(1_600);
  const after = await target.webContents.executeJavaScript('({ ...globalThis.__probe })');
  const result = {
    backgroundThrottling: true,
    schedulerMode,
    ticks: Number(after.ticks) - Number(before.ticks),
    frames: Number(after.frames) - Number(before.frames),
    writes: Number(after.writes) - Number(before.writes),
    writeDurationMs: Number(after.writeFinishedAt) > 0
      ? Number(after.writeFinishedAt) - Number(after.writeStartedAt)
      : null,
    maxGapMs: Number(after.maxGapMs),
    elapsedMs: 1_600,
    hidden: Boolean(before.hidden),
    focused: Boolean(before.focused),
    visibilityState: String(before.visibilityState),
    targetVisible: target.isVisible(),
    targetMinimized: target.isMinimized(),
  };
  cover.destroy();
  target.destroy();
  return result;
}

async function run() {
  if (!outputPath) throw new Error('SQUIDRUN_BACKGROUND_THROTTLING_OUTPUT_required');
  let result;
  try {
    const throttledTimer = await measureHiddenWindow(true, 'timer');
    const throttledTask = await measureHiddenWindow(true, 'message-channel');
    const unthrottledTimer = await measureHiddenWindow(false, 'timer');
    const coveredTimer = await measureCoveredWindow('timer');
    const coveredTask = await measureCoveredWindow('message-channel');
    result = {
      complete: true,
      ok: throttledTimer.writes < 20
        && throttledTask.writes >= 180
        && throttledTask.frames < 8
        && throttledTask.ticks < 12
        && unthrottledTimer.writes >= 140
        && unthrottledTimer.ticks >= 100
        && unthrottledTimer.ticks < 400
        && coveredTimer.focused === false
        && coveredTask.writes >= 180,
      electron: process.versions.electron,
      throttledTimer,
      throttledTask,
      unthrottledTimer,
      coveredTimer,
      coveredTask,
      mainPid: process.pid,
      probeRoot,
    };
  } catch (error) {
    result = { complete: true, ok: false, reason: error?.stack || String(error), mainPid: process.pid, probeRoot };
  } finally {
    const processPids = electronProcessIds();
    for (const windowRef of BrowserWindow.getAllWindows()) {
      try { windowRef.destroy(); } catch {}
    }
    if (result) result.processPids = processPids;
  }
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  app.quit();
}

app.whenReady().then(run);
