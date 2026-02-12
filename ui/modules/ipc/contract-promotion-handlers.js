const { executeContractPromotionAction } = require('../contract-promotion-service');

const CONTRACT_PROMOTION_CHANNEL_ACTIONS = new Map([
  ['contract-promotion:list', 'list'],
  ['contract-promotion:approve', 'approve'],
  ['contract-promotion:reject', 'reject'],
]);

function registerContractPromotionHandlers(ctx) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerContractPromotionHandlers requires ctx.ipcMain');
  }

  const { ipcMain } = ctx;

  for (const [channel, action] of CONTRACT_PROMOTION_CHANNEL_ACTIONS.entries()) {
    ipcMain.handle(channel, (event, payload = {}) => executeContractPromotionAction(action, payload, {
      source: {
        via: 'ipc',
        role: 'system',
      },
    }));
  }
}

function unregisterContractPromotionHandlers(ctx) {
  const { ipcMain } = ctx || {};
  if (!ipcMain) return;

  for (const channel of CONTRACT_PROMOTION_CHANNEL_ACTIONS.keys()) {
    ipcMain.removeHandler(channel);
  }
}

registerContractPromotionHandlers.unregister = unregisterContractPromotionHandlers;

module.exports = {
  registerContractPromotionHandlers,
  unregisterContractPromotionHandlers,
  CONTRACT_PROMOTION_CHANNEL_ACTIONS,
};
