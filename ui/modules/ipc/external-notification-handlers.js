/**
 * External Notification IPC Handlers
 * Channels: notify-external-test
 */

function registerExternalNotificationHandlers(ctx) {
  const { ipcMain } = ctx;
  if (!ipcMain) return;

  ipcMain.handle('notify-external-test', async (event, payload = {}) => {
    if (!ctx.externalNotifier || typeof ctx.externalNotifier.notify !== 'function') {
      return { success: false, error: 'external_notifier_unavailable' };
    }

    const category = payload.category || 'alert';
    const title = payload.title || 'Test Notification';
    const message = payload.message || 'This is a test notification from Hivemind.';

    const result = await ctx.externalNotifier.notify({
      category,
      title,
      message,
      meta: { test: true },
    });

    return { success: true, result };
  });
}


function unregisterExternalNotificationHandlers(ctx) {
  const { ipcMain } = ctx || {};
  if (!ipcMain) return;
    ipcMain.removeHandler('notify-external-test');
}

registerExternalNotificationHandlers.unregister = unregisterExternalNotificationHandlers;
module.exports = { registerExternalNotificationHandlers };
