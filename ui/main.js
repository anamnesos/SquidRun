/**
 * SquidRun - Electron Main Process
 * Refactored to modular architecture (Session 60, Finding #4)
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const { app, Menu } = require('electron');

require('./modules/noise-bootstrap').installNoiseGuards();

// Occlusion/throttling policy is window-scoped. Pane-host windows opt out in
// pane-host-window-manager.js; visual/side windows use normal Chromium pause
// semantics and receive explicit visibility IPC from the main process.
// LIVE EYES (James's tooling-freedom mandate): localhost-only CDP endpoint
// so agents can attach playwright/puppeteer to the RUNNING app - live DOM,
// console, FPS profiling, burst/video capture of motion instead of stills.
// Chromium binds this to 127.0.0.1 by default. Activates on next restart.
// GHOST-SQUATTING FIX (S467): a dead app's socket can hold the fixed port
// in LISTEN forever (pid 39200 squatted 9223 across a relaunch and the
// LISTEN state faked criterion #4 of the v1.1 proof). The port now rotates
// per-process and the TRUTH lives in a runtime file tools must read -
// checking netstat for a fixed port is exactly the stale-evidence class
// the verdict ledger exists to kill.
const cdpPort = process.env.SQUIDRUN_CDP_PORT
  || String(9223 + (process.pid % 89)); // 9223-9311, collision-unlikely
app.commandLine.appendSwitch('remote-debugging-port', cdpPort);
// NOTE: cdp-port.json is written AFTER the single-instance lock is won (see
// below) - at the 16:54 S467 boundary, dying twin instances wrote the file
// then lost the lock, poisoning it with stillborn ports (last-writer-wins).
// The switch must be appended here (pre-ready); the TRUTH file must not.

if (process.env.NODE_PATH) {
  try {
    require('module').Module._initPaths();
  } catch (_) {
    // Best effort: Electron app mode can skip NODE_PATH initialization.
  }
}

const { parseLaunchIntent } = require('./modules/main/launch-intent');
const {
  applyProfileEnv,
  getActiveProfileName,
  getProfileProjectRootOverride,
  isMainProfile,
} = require('./profile');
const {
  applyInstalledElectronUserDataPath,
  resolveExplicitDataRoot,
  resolveInstalledDataRoot,
} = require('./modules/installed-data-root');

const initialLaunchIntent = parseLaunchIntent(process.argv.slice(1));
const activeProfileName = applyProfileEnv(initialLaunchIntent.profileName || 'main');
const packagedDataRootOptions = {
  cwd: process.cwd(),
  execPath: process.execPath,
  homePath: typeof app.getPath === 'function' ? app.getPath('home') : os.homedir(),
  resourcesPath: process.resourcesPath,
};
const explicitDataRoot = resolveExplicitDataRoot(process.env);
const installedDataRoot = (explicitDataRoot || app.isPackaged === true)
  ? resolveInstalledDataRoot(packagedDataRootOptions)
  : null;
const pinnedInstalledDataRoot = installedDataRoot?.path
  && installedDataRoot.source !== 'default-external-workspace'
  ? installedDataRoot
  : null;
if (pinnedInstalledDataRoot?.path && !process.env.SQUIDRUN_DATA_ROOT) {
  process.env.SQUIDRUN_DATA_ROOT = pinnedInstalledDataRoot.path;
}
const profileProjectRoot = getProfileProjectRootOverride(activeProfileName);
if (pinnedInstalledDataRoot?.path) {
  process.env.SQUIDRUN_PROJECT_ROOT = pinnedInstalledDataRoot.path;
} else if (profileProjectRoot) {
  process.env.SQUIDRUN_PROJECT_ROOT = profileProjectRoot;
} else if (explicitDataRoot?.path) {
  process.env.SQUIDRUN_PROJECT_ROOT = explicitDataRoot.path;
} else if (!process.env.SQUIDRUN_PROJECT_ROOT && app.isPackaged === true && installedDataRoot?.path) {
  process.env.SQUIDRUN_PROJECT_ROOT = installedDataRoot.path;
}

const installedUserData = applyInstalledElectronUserDataPath(app, installedDataRoot);

if (
  !installedUserData.applied
  && !isMainProfile(activeProfileName)
  && typeof app?.getPath === 'function'
  && typeof app?.setPath === 'function'
) {
  try {
    const defaultUserDataPath = app.getPath('userData');
    if (defaultUserDataPath) {
      app.setPath('userData', path.join(defaultUserDataPath, activeProfileName));
    }
  } catch (_) {
    // Best effort only; packaged profile isolation can still fall back to file-level scoping.
  }
}

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const fallbackEnvPath = process.env.SQUIDRUN_PROJECT_ROOT
  ? path.join(process.env.SQUIDRUN_PROJECT_ROOT, '.env')
  : (process.platform === 'darwin'
      && (__dirname.includes('.app/Contents/') || __dirname.includes('app.asar'))
      ? path.join(os.homedir(), 'SquidRun', '.env')
      : null);
// Fill missing env vars from an external path when packaged mac builds cannot persist bundle .env.
if (fallbackEnvPath) {
  require('dotenv').config({ path: fallbackEnvPath, quiet: true });
}

// Installed builds keep their credentials in <dataRoot>/.squidrun/settings/ files;
// the overlay only fills env keys the .env loads above left unset (explicit env
// always wins) and enforces the wallet-class deny as the second wall behind the
// scrub-launch wrapper.
try {
  const overlayDataRoot = installedDataRoot || resolveInstalledDataRoot();
  if (overlayDataRoot.source !== 'default-external-workspace') {
    require('./modules/install-credentials').applyInstallCredentialEnvOverlay({ dataRoot: overlayDataRoot.path });
  }
} catch (_) {
  // Credential overlay is best effort; a missing or unreadable settings file must never block boot.
}

// Enforce single-instance ownership to prevent duplicate watcher/process
// trees from racing on .squidrun trigger files.
const singleInstanceLock = isMainProfile(activeProfileName)
  ? app.requestSingleInstanceLock({ profile: getActiveProfileName() })
  : true;
if (singleInstanceLock === false) {
  app.quit();
  process.exit(0);
}

// LOCK WON (or non-main profile): only now may this instance claim the CDP
// truth file - a loser twin can no longer poison it (ceremony purge item 5).
try {
  const cdpPortFile = path.join(__dirname, '..', '.squidrun', 'runtime', 'cdp-port.json');
  fs.mkdirSync(path.dirname(cdpPortFile), { recursive: true });
  fs.writeFileSync(cdpPortFile, JSON.stringify({
    port: Number(cdpPort),
    pid: process.pid,
    startedAt: new Date().toISOString(),
  }));
} catch (_) { /* CDP discovery degrades to probing; never block launch */ }

// Suppress EPIPE errors on stdout/stderr — broken pipes from console.log
// must not crash the app (common when renderer disconnects or pipes close)
process.stdout.on('error', (err) => { if (err.code !== 'EPIPE') throw err; });
process.stderr.on('error', (err) => { if (err.code !== 'EPIPE') throw err; });

// Global error handlers — prevent main process crash on unhandled errors
const log = require('./modules/logger');
const { resolveCoordPath } = require('./config');

function appendMainBootSequenceBreadcrumb(step, details = {}) {
  try {
    const filePath = resolveCoordPath(path.join('runtime', 'boot-sequence.jsonl'), { forWrite: true });
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(
      filePath,
      `${JSON.stringify({
        schema: 'squidrun.boot_sequence.v1',
        source: 'main.js',
        step,
        t: Date.now(),
        iso: new Date().toISOString(),
        pid: process.pid,
        ...(details && typeof details === 'object' ? details : {}),
      })}\n`,
      'utf8'
    );
  } catch {
    // This is a last-ditch breadcrumb path; never let diagnostics block boot.
  }
}

function enforceMenuSuppression(windowRef = null) {
  try {
    Menu.setApplicationMenu(null);
  } catch (err) {
    log.warn('[Main] Failed to clear application menu:', err?.message || err);
  }

  if (!windowRef || (typeof windowRef.isDestroyed === 'function' && windowRef.isDestroyed())) {
    return;
  }

  if (typeof windowRef.removeMenu === 'function') {
    windowRef.removeMenu();
  } else if (typeof windowRef.setMenu === 'function') {
    windowRef.setMenu(null);
  }
  if (typeof windowRef.setAutoHideMenuBar === 'function') {
    windowRef.setAutoHideMenuBar(true);
  }
  if (typeof windowRef.setMenuBarVisibility === 'function') {
    windowRef.setMenuBarVisibility(false);
  }
}

process.on('uncaughtException', (err) => {
  log.error('[Main] Uncaught exception:', err?.message || err);
  log.error('[Main] Stack:', err?.stack);
});
process.on('unhandledRejection', (reason) => {
  log.error('[Main] Unhandled rejection:', reason?.message || reason);
});

const appContext = require('./modules/main/app-context');
const SettingsManager = require('./modules/main/settings-manager');
const ActivityManager = require('./modules/main/activity-manager');
const UsageManager = require('./modules/main/usage-manager');
const CliIdentityManager = require('./modules/main/cli-identity');
const FirmwareManager = require('./modules/main/firmware-manager');
const SquidRunApp = require('./modules/main/squidrun-app');

// 1. Initialize managers with shared context
appContext.electronApp = app;
const settings = new SettingsManager(appContext);
const activity = new ActivityManager(appContext);
const usage = new UsageManager(appContext);
const cliIdentity = new CliIdentityManager(appContext);
const firmwareManager = new FirmwareManager(appContext);

appContext.setFirmwareManager(firmwareManager);

// 2. Create main application controller
const squidrunApp = new SquidRunApp(appContext, {
  settings,
  activity,
  usage,
  cliIdentity,
  firmwareManager,
});
squidrunApp.setLaunchWindowProfile(initialLaunchIntent);

app.on('second-instance', (_event, commandLine = []) => {
  const launchProfile = squidrunApp.setLaunchWindowProfile(parseLaunchIntent(commandLine));
  const focusWindowKey = launchProfile?.focusWindowKey || launchProfile?.windowKey || 'main';
  const focusWindow = squidrunApp.getAppWindow(focusWindowKey);
  if (!focusWindow || focusWindow.isDestroyed()) {
    if (app.isReady()) {
      squidrunApp.launchWindowsForProfile(launchProfile).catch((err) => {
        log.error('[Main] Failed to restore window on second-instance:', err?.message || err);
      });
    }
    return;
  }
  squidrunApp.focusAppWindow(focusWindowKey);
});
app.on('browser-window-created', (_event, windowRef) => {
  enforceMenuSuppression(windowRef);
});

// 3. Electron Lifecycle Hooks
app.whenReady().then(() => {
  enforceMenuSuppression();
  appendMainBootSequenceBreadcrumb('main:when-ready:init-start');
  squidrunApp.init().catch((err) => {
    appendMainBootSequenceBreadcrumb('main:init-catch', {
      error: err?.message || String(err),
      stack: err?.stack || null,
    });
    log.error('[Main] App init failed:', err?.message || err);
    log.error('[Main] Stack:', err?.stack);
  });
});

app.on('window-all-closed', async () => {
  try {
    await squidrunApp.shutdown();
  } catch (err) {
    log.error('[Main] App shutdown failed:', err?.message || err);
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (appContext.mainWindow === null) {
    squidrunApp.launchWindowsForProfile();
  }
});

// Export context for debugging or other modules if needed
module.exports = { appContext, squidrunApp };
