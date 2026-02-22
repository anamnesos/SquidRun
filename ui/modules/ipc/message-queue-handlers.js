function registerMessageQueueHandlers(ctx) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerMessageQueueHandlers requires ctx.ipcMain');
  }

  const { ipcMain } = ctx;
  const sendMessageToTargets = async (fromPaneId, targetPaneIds, content, type) => {
    const results = [];
    const failedTargets = [];

    for (const toPaneId of targetPaneIds) {
      if (toPaneId === fromPaneId) {
        continue;
      }

      try {
        const sendResult = await ctx.watcher.sendMessage(fromPaneId, toPaneId, content, type);
        const resultPayload = (sendResult && typeof sendResult === 'object') ? sendResult : {};
        const success = resultPayload.success === true;
        results.push({ toPaneId, ...resultPayload, success });
        if (!success) {
          failedTargets.push(toPaneId);
        }
      } catch (err) {
        failedTargets.push(toPaneId);
        results.push({
          toPaneId,
          success: false,
          error: err?.message || String(err),
        });
      }
    }

    return {
      success: failedTargets.length === 0,
      results,
      failedTargets,
    };
  };

  ipcMain.handle('init-message-queue', async () => {
    return ctx.watcher.initMessageQueue();
  });

  ipcMain.handle('send-message', async (event, fromPaneId, toPaneId, content, type = 'direct') => {
    return ctx.watcher.sendMessage(fromPaneId, toPaneId, content, type);
  });

  ipcMain.handle('send-broadcast-message', async (event, fromPaneId, content) => {
    return sendMessageToTargets(fromPaneId, ctx.PANE_IDS, content, 'broadcast');
  });

  ipcMain.handle('send-group-message', async (event, fromPaneId, toPaneIds, content) => {
    return sendMessageToTargets(fromPaneId, toPaneIds, content, 'direct');
  });

  ipcMain.handle('get-messages', async (event, paneId, undeliveredOnly = false) => {
    const messages = await ctx.watcher.getMessages(paneId, undeliveredOnly);
    return { success: true, messages, count: messages.length };
  });

  ipcMain.handle('get-all-messages', async () => {
    const allMessages = {};
    for (const paneId of ctx.PANE_IDS) {
      allMessages[paneId] = await ctx.watcher.getMessages(paneId);
    }
    return { success: true, messages: allMessages };
  });

  ipcMain.handle('mark-message-delivered', async (event, paneId, messageId) => {
    return ctx.watcher.markMessageDelivered(paneId, messageId);
  });

  ipcMain.handle('clear-messages', async (event, paneId, deliveredOnly = false) => {
    return ctx.watcher.clearMessages(paneId, deliveredOnly);
  });

  ipcMain.handle('get-message-queue-status', async () => {
    return ctx.watcher.getMessageQueueStatus();
  });

  ipcMain.handle('start-message-watcher', async () => {
    try {
      const result = await ctx.watcher.startMessageWatcher();
      if (!result || result.success !== true) {
        return {
          success: false,
          error: result?.error || result?.reason || 'message_watcher_start_failed',
        };
      }
      return result;
    } catch (err) {
      return {
        success: false,
        error: err?.message || String(err),
      };
    }
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
