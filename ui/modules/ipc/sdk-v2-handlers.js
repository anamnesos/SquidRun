const { getSDKBridge } = require('../sdk-bridge');
const log = require('../logger');

function registerSdkV2Handlers(ctx) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerSdkV2Handlers requires ctx.ipcMain');
  }

  const { ipcMain } = ctx;
  const sdkBridge = getSDKBridge();

  ipcMain.handle('sdk-send-message', async (event, paneId, message) => {
    log.info('SDK V2', `Sending to pane ${paneId}:`, message?.substring(0, 50) + '...');
    try {
      const sent = sdkBridge.sendMessage(paneId, message);
      return { success: sent };
    } catch (err) {
      log.error('SDK V2', 'Send error:', err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('sdk-subscribe', (event, paneId) => {
    log.info('SDK V2', `Subscribing to pane ${paneId}`);
    return { success: sdkBridge.subscribe(paneId) };
  });

  ipcMain.handle('sdk-unsubscribe', (event, paneId) => {
    log.info('SDK V2', `Unsubscribing from pane ${paneId}`);
    return { success: sdkBridge.unsubscribe(paneId) };
  });

  ipcMain.handle('sdk-get-session-ids', () => {
    log.info('SDK V2', 'Getting session IDs');
    return sdkBridge.getSessionIds();
  });

  ipcMain.handle('sdk-start-sessions', async (event, options = {}) => {
    log.info('SDK V2', 'Starting all sessions');
    try {
      await sdkBridge.startSessions({
        workspace: options.workspace || process.cwd(),
        resumeIds: options.resumeIds,
      });
      return { success: true };
    } catch (err) {
      log.error('SDK V2', 'Start sessions error:', err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('sdk-stop-sessions', async () => {
    log.info('SDK V2', 'Stopping all sessions');
    try {
      const sessionIds = await sdkBridge.stopSessions();
      return { success: true, sessionIds };
    } catch (err) {
      log.error('SDK V2', 'Stop sessions error:', err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('sdk-pane-status', (event, paneId) => {
    return sdkBridge.getPaneStatus(paneId);
  });

  ipcMain.handle('sdk-interrupt', (event, paneId) => {
    log.info('SDK V2', `Interrupting pane ${paneId}`);
    return { success: sdkBridge.interrupt(paneId) };
  });

  ipcMain.handle('sdk-restart-session', (event, paneId) => {
    log.info('SDK V2', `Restarting session for pane ${paneId}`);
    try {
      const sent = sdkBridge.restartSession(paneId);
      return { success: sent };
    } catch (err) {
      log.error('SDK V2', 'Restart error:', err);
      return { success: false, error: err.message };
    }
  });
}


function unregisterSdkV2Handlers(ctx) {
  const { ipcMain } = ctx || {};
  if (!ipcMain) return;
    ipcMain.removeHandler('sdk-send-message');
    ipcMain.removeHandler('sdk-subscribe');
    ipcMain.removeHandler('sdk-unsubscribe');
    ipcMain.removeHandler('sdk-get-session-ids');
    ipcMain.removeHandler('sdk-start-sessions');
    ipcMain.removeHandler('sdk-stop-sessions');
    ipcMain.removeHandler('sdk-pane-status');
    ipcMain.removeHandler('sdk-interrupt');
    ipcMain.removeHandler('sdk-restart-session');
}

registerSdkV2Handlers.unregister = unregisterSdkV2Handlers;
module.exports = {
  registerSdkV2Handlers,
};
