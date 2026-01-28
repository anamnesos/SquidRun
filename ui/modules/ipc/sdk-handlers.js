const { getSDKBridge } = require('../sdk-bridge');

function registerSdkHandlers(ctx) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerSdkHandlers requires ctx.ipcMain');
  }

  const { ipcMain } = ctx;
  const sdkBridge = getSDKBridge();
  sdkBridge.setMainWindow(ctx.mainWindow);

  ipcMain.handle('sdk-start', async (event, prompt, options = {}) => {
    console.log('[SDK] Starting with prompt:', prompt?.substring(0, 50) + '...');
    try {
      sdkBridge.start(prompt, {
        broadcast: options.broadcast || false,
        workspace: options.workspace || process.cwd(),
      });
      return { success: true };
    } catch (err) {
      console.error('[SDK] Start error:', err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('sdk-stop', () => {
    console.log('[SDK] Stopping');
    sdkBridge.stop();
    return { success: true };
  });

  ipcMain.handle('sdk-write', (event, input) => {
    console.log('[SDK] Writing input');
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
    console.log('[SDK V2] Broadcasting to all agents:', prompt?.substring(0, 50) + '...');
    try {
      if (!sdkBridge.isActive()) {
        await sdkBridge.startSessions({ workspace: process.cwd() });
      }
      sdkBridge.broadcast(prompt);
      return { success: true };
    } catch (err) {
      console.error('[SDK V2] Broadcast error:', err);
      return { success: false, error: err.message };
    }
  });
}

module.exports = {
  registerSdkHandlers,
};
