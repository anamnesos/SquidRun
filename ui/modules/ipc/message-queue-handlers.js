function registerMessageQueueHandlers(ctx) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerMessageQueueHandlers requires ctx.ipcMain');
  }

  const { ipcMain } = ctx;

  ipcMain.handle('init-message-queue', () => {
    return ctx.watcher.initMessageQueue();
  });

  ipcMain.handle('send-message', (event, fromPaneId, toPaneId, content, type = 'direct') => {
    return ctx.watcher.sendMessage(fromPaneId, toPaneId, content, type);
  });

  ipcMain.handle('send-broadcast-message', (event, fromPaneId, content) => {
    const results = [];
    for (const toPaneId of ctx.PANE_IDS) {
      if (toPaneId !== fromPaneId) {
        const result = ctx.watcher.sendMessage(fromPaneId, toPaneId, content, 'broadcast');
        results.push({ toPaneId, ...result });
      }
    }
    return { success: true, results };
  });

  ipcMain.handle('send-group-message', (event, fromPaneId, toPaneIds, content) => {
    const results = [];
    for (const toPaneId of toPaneIds) {
      if (toPaneId !== fromPaneId) {
        const result = ctx.watcher.sendMessage(fromPaneId, toPaneId, content, 'direct');
        results.push({ toPaneId, ...result });
      }
    }
    return { success: true, results };
  });

  ipcMain.handle('get-messages', (event, paneId, undeliveredOnly = false) => {
    const messages = ctx.watcher.getMessages(paneId, undeliveredOnly);
    return { success: true, messages, count: messages.length };
  });

  ipcMain.handle('get-all-messages', () => {
    const allMessages = {};
    for (const paneId of ctx.PANE_IDS) {
      allMessages[paneId] = ctx.watcher.getMessages(paneId);
    }
    return { success: true, messages: allMessages };
  });

  ipcMain.handle('mark-message-delivered', (event, paneId, messageId) => {
    return ctx.watcher.markMessageDelivered(paneId, messageId);
  });

  ipcMain.handle('clear-messages', (event, paneId, deliveredOnly = false) => {
    return ctx.watcher.clearMessages(paneId, deliveredOnly);
  });

  ipcMain.handle('get-message-queue-status', () => {
    return ctx.watcher.getMessageQueueStatus();
  });

  ipcMain.handle('start-message-watcher', () => {
    ctx.watcher.startMessageWatcher();
    return { success: true };
  });
}

function unregisterMessageQueueHandlers(ctx) {
  const { ipcMain } = ctx;
  if (ipcMain) {
    ipcMain.removeHandler('init-message-queue');
    ipcMain.removeHandler('send-message');
    ipcMain.removeHandler('send-broadcast-message');
    ipcMain.removeHandler('send-group-message');
    ipcMain.removeHandler('get-messages');
    ipcMain.removeHandler('get-all-messages');
    ipcMain.removeHandler('mark-message-delivered');
    ipcMain.removeHandler('clear-messages');
    ipcMain.removeHandler('get-message-queue-status');
    ipcMain.removeHandler('start-message-watcher');
  }
}

registerMessageQueueHandlers.unregister = unregisterMessageQueueHandlers;

module.exports = {
  registerMessageQueueHandlers,
};
