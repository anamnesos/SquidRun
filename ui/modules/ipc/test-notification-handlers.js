const fs = require('fs');
const path = require('path');
const log = require('../logger');

function registerTestNotificationHandlers(ctx, deps = {}) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerTestNotificationHandlers requires ctx.ipcMain');
  }

  const { ipcMain } = ctx;
  const TEST_RESULTS_PATH = path.join(ctx.WORKSPACE_PATH, 'test-results.json');

  const TEST_NOTIFICATION_SETTINGS = {
    enabled: true,
    flashTab: true,
    blockTransitions: false,
    soundEnabled: false,
  };

  function notifyTestFailure(results) {
    if (!TEST_NOTIFICATION_SETTINGS.enabled) {
      return { success: true, notified: false, reason: 'Notifications disabled' };
    }

    const failedCount = results.failed || 0;
    const failures = results.failures || [];

    const title = `${failedCount} Test${failedCount !== 1 ? 's' : ''} Failed`;
    const body = failures.slice(0, 3).map(f => f.test || f.name).join('\n') +
                 (failures.length > 3 ? `\n...and ${failures.length - 3} more` : '');

    if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
      ctx.mainWindow.webContents.send('test-failure-notification', {
        title,
        body,
        failedCount,
        failures: failures.slice(0, 5),
        timestamp: new Date().toISOString(),
      });

      if (TEST_NOTIFICATION_SETTINGS.flashTab) {
        ctx.mainWindow.webContents.send('flash-tab', { tab: 'tests', color: 'red' });
      }
    }

    if (typeof deps.logActivity === 'function') {
      deps.logActivity('error', null, `Test failure: ${failedCount} tests failed`, {
        failedCount,
        failures: failures.slice(0, 5),
      });
    }

    log.info('Test Notification', title);

    return { success: true, notified: true, title, body };
  }

  ipcMain.handle('notify-test-failure', (event, results) => {
    return notifyTestFailure(results);
  });

  ipcMain.handle('get-test-notification-settings', () => {
    return { success: true, settings: TEST_NOTIFICATION_SETTINGS };
  });

  ipcMain.handle('set-test-notification-settings', (event, settings) => {
    Object.assign(TEST_NOTIFICATION_SETTINGS, settings);
    log.info('Test Notification', 'Settings updated:', TEST_NOTIFICATION_SETTINGS);
    return { success: true, settings: TEST_NOTIFICATION_SETTINGS };
  });

  ipcMain.handle('should-block-on-test-failure', () => {
    if (!TEST_NOTIFICATION_SETTINGS.blockTransitions) {
      return { success: true, block: false, reason: 'Blocking disabled' };
    }

    try {
      if (fs.existsSync(TEST_RESULTS_PATH)) {
        const content = fs.readFileSync(TEST_RESULTS_PATH, 'utf-8');
        const results = JSON.parse(content);

        if (results.failed > 0) {
          return {
            success: true,
            block: true,
            reason: `${results.failed} test(s) failing`,
            results,
          };
        }
      }
    } catch (err) {
      // Ignore errors reading results
    }

    return { success: true, block: false, reason: 'Tests passing or no results' };
  });

  ipcMain.on('test-run-complete', (event, results) => {
    if (results && results.failed > 0) {
      notifyTestFailure(results);
    }
  });
}

module.exports = {
  registerTestNotificationHandlers,
};
