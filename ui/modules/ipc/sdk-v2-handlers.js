const { getSDKBridge } = require('../sdk-bridge');

function registerSdkV2Handlers(ctx) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerSdkV2Handlers requires ctx.ipcMain');
  }

  const { ipcMain } = ctx;
  const sdkBridge = getSDKBridge();

  ipcMain.handle('sdk-send-message', async (event, paneId, message) => {
    console.log(`[SDK V2] Sending to pane ${paneId}:`, message?.substring(0, 50) + '...');
    try {
      const sent = sdkBridge.sendMessage(paneId, message);
      return { success: sent };
    } catch (err) {
      console.error('[SDK V2] Send error:', err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('sdk-subscribe', (event, paneId) => {
    console.log(`[SDK V2] Subscribing to pane ${paneId}`);
    return { success: sdkBridge.subscribe(paneId) };
  });

  ipcMain.handle('sdk-unsubscribe', (event, paneId) => {
    console.log(`[SDK V2] Unsubscribing from pane ${paneId}`);
    return { success: sdkBridge.unsubscribe(paneId) };
  });

  ipcMain.handle('sdk-get-session-ids', () => {
    console.log('[SDK V2] Getting session IDs');
    return sdkBridge.getSessionIds();
  });

  ipcMain.handle('sdk-start-sessions', async (event, options = {}) => {
    console.log('[SDK V2] Starting all sessions');
    try {
      await sdkBridge.startSessions({
        workspace: options.workspace || process.cwd(),
        resumeIds: options.resumeIds,
      });
      return { success: true };
    } catch (err) {
      console.error('[SDK V2] Start sessions error:', err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('sdk-stop-sessions', async () => {
    console.log('[SDK V2] Stopping all sessions');
    try {
      const sessionIds = await sdkBridge.stopSessions();
      return { success: true, sessionIds };
    } catch (err) {
      console.error('[SDK V2] Stop sessions error:', err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('sdk-pane-status', (event, paneId) => {
    return sdkBridge.getPaneStatus(paneId);
  });

  ipcMain.handle('sdk-interrupt', (event, paneId) => {
    console.log(`[SDK V2] Interrupting pane ${paneId}`);
    return { success: sdkBridge.interrupt(paneId) };
  });
}

module.exports = {
  registerSdkV2Handlers,
};
