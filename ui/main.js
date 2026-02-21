/**
 * SquidRun - Electron Main Process
 * Refactored to modular architecture (Session 60, Finding #4)
 */

const path = require('path');
const { app } = require('electron');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// Enforce single-instance ownership to prevent duplicate watcher/process
// trees from racing on .squidrun trigger files.
const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
  process.exit(0);
}

// Suppress EPIPE errors on stdout/stderr — broken pipes from console.log
// must not crash the app (common when renderer disconnects or pipes close)
process.stdout.on('error', (err) => { if (err.code !== 'EPIPE') throw err; });
process.stderr.on('error', (err) => { if (err.code !== 'EPIPE') throw err; });

// Global error handlers — prevent main process crash on unhandled errors
const log = require('./modules/logger');
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

app.on('second-instance', () => {
  const win = appContext.mainWindow;
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) {
    win.restore();
  }
  win.focus();
});

// 3. Electron Lifecycle Hooks
app.whenReady().then(() => {
  squidrunApp.init().catch((err) => {
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
    squidrunApp.createWindow();
  }
});

// Export context for debugging or other modules if needed
module.exports = { appContext, squidrunApp };
