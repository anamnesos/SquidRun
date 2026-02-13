const { getSDKBridge } = require('../sdk-bridge');
const log = require('../logger');

function registerSdkHandlers(ctx) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerSdkHandlers requires ctx.ipcMain');
  }

  const { ipcMain } = ctx;
  const sdkBridge = getSDKBridge();
  sdkBridge.setMainWindow(ctx.mainWindow);

  ipcMain.handle('sdk-start', async (event, prompt, options = {}) => {
    log.info('SDK', 'Starting with prompt:', prompt?.substring(0, 50) + '...');
    try {
      sdkBridge.start(prompt, {
        broadcast: options.broadcast || false,
        workspace: options.workspace || process.cwd(),
      });
      return { success: true };
    } catch (err) {
      log.error('SDK', 'Start error:', err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('sdk-stop', () => {
    log.info('SDK', 'Stopping');
    sdkBridge.stop();
    return { success: true };
  });

  ipcMain.handle('sdk-write', (event, input) => {
    log.info('SDK', 'Writing input');
    sdkBridge.write(input);
    return { success: true };
  });

  ipcMain.handle('sdk-status', () => {
    return {
      active: sdkBridge.isActive(),
      sessions: sdkBridge.getSessions(),
    };
  });

  ipcMain.handle('sdk-broadcast', async (event, prompt) => {
    log.info('SDK', 'Broadcasting to all agents:', prompt?.substring(0, 50) + '...');
    try {
      if (!sdkBridge.isActive()) {
        await sdkBridge.startSessions({ workspace: process.cwd() });
      }
      const sent = sdkBridge.broadcast(prompt);
      if (!sent) {
        return {
          success: false,
          error: 'SDK bridge did not accept broadcast',
        };
      }
      return { success: true };
    } catch (err) {
      log.error('SDK', 'Broadcast error:', err);
      return { success: false, error: err.message };
    }
  });
}


function unregisterSdkHandlers(ctx) {
  const { ipcMain } = ctx || {};
  if (!ipcMain) return;
    ipcMain.removeHandler('sdk-start');
    ipcMain.removeHandler('sdk-stop');
    ipcMain.removeHandler('sdk-write');
    ipcMain.removeHandler('sdk-status');
    ipcMain.removeHandler('sdk-broadcast');
}

registerSdkHandlers.unregister = unregisterSdkHandlers;
module.exports = {
  registerSdkHandlers,
};
