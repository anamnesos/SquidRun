/**
 * Hivemind - Electron Main Process
 * Refactored to modular architecture (Session 60, Finding #4)
 */

const path = require('path');
const { app } = require('electron');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const appContext = require('./modules/main/app-context');
const SettingsManager = require('./modules/main/settings-manager');
const ActivityManager = require('./modules/main/activity-manager');
const UsageManager = require('./modules/main/usage-manager');
const CliIdentityManager = require('./modules/main/cli-identity');
const ContextInjectionManager = require('./modules/main/context-injection');
const HivemindApp = require('./modules/main/hivemind-app');

// 1. Initialize managers with shared context
const settings = new SettingsManager(appContext);
const activity = new ActivityManager(appContext);
const usage = new UsageManager(appContext);
const cliIdentity = new CliIdentityManager(appContext);
const contextInjection = new ContextInjectionManager(appContext);

appContext.setContextInjection(contextInjection);

// 2. Create main application controller
const hivemindApp = new HivemindApp(appContext, {
  settings,
  activity,
  usage,
  cliIdentity,
  contextInjection,
});

// 3. Electron Lifecycle Hooks
app.whenReady().then(() => {
  hivemindApp.init();
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
