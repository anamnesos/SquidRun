/**
 * Hivemind - Electron Main Process
 * Refactored to modular architecture (Session 60, Finding #4)
 */

const path = require('path');
const { app } = require('electron');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

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
const ContextInjectionManager = require('./modules/main/context-injection');
const FirmwareManager = require('./modules/main/firmware-manager');
const HivemindApp = require('./modules/main/hivemind-app');

// 1. Initialize managers with shared context
const settings = new SettingsManager(appContext);
const activity = new ActivityManager(appContext);
const usage = new UsageManager(appContext);
const cliIdentity = new CliIdentityManager(appContext);
const contextInjection = new ContextInjectionManager(appContext);
const firmwareManager = new FirmwareManager(appContext);

appContext.setContextInjection(contextInjection);
appContext.setFirmwareManager(firmwareManager);

// 2. Create main application controller
const hivemindApp = new HivemindApp(appContext, {
  settings,
  activity,
  usage,
  cliIdentity,
  contextInjection,
  firmwareManager,
});

// 3. Electron Lifecycle Hooks
app.whenReady().then(() => {
  hivemindApp.init().catch((err) => {
    log.error('[Main] App init failed:', err?.message || err);
    log.error('[Main] Stack:', err?.stack);
  });
});

app.on('window-all-closed', () => {
  hivemindApp.shutdown();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (appContext.mainWindow === null) {
    hivemindApp.createWindow();
  }
});

// Export context for debugging or other modules if needed
module.exports = { appContext, hivemindApp };
