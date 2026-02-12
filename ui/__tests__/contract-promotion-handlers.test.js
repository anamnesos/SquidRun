const mockExecuteContractPromotionAction = jest.fn();

jest.mock('../modules/contract-promotion-service', () => ({
  executeContractPromotionAction: (...args) => mockExecuteContractPromotionAction(...args),
}));

const {
  registerContractPromotionHandlers,
  unregisterContractPromotionHandlers,
  CONTRACT_PROMOTION_CHANNEL_ACTIONS,
} = require('../modules/ipc/contract-promotion-handlers');

describe('contract-promotion IPC handlers', () => {
  let ipcMain;
  let ctx;

  beforeEach(() => {
    mockExecuteContractPromotionAction.mockReset();
    mockExecuteContractPromotionAction.mockReturnValue({ ok: true });

    ipcMain = {
      handle: jest.fn(),
      removeHandler: jest.fn(),
    };
    ctx = { ipcMain };
  });

  test('registers all contract promotion channels', () => {
    registerContractPromotionHandlers(ctx);

    expect(ipcMain.handle).toHaveBeenCalledTimes(CONTRACT_PROMOTION_CHANNEL_ACTIONS.size);
    for (const [channel] of CONTRACT_PROMOTION_CHANNEL_ACTIONS.entries()) {
      expect(ipcMain.handle).toHaveBeenCalledWith(channel, expect.any(Function));
    }
  });

  test('routes channel payloads to executeContractPromotionAction', async () => {
    registerContractPromotionHandlers(ctx);

    const approveCall = ipcMain.handle.mock.calls.find(([channel]) => channel === 'contract-promotion:approve');
    expect(approveCall).toBeDefined();

    const approveHandler = approveCall[1];
    const payload = { contractId: 'overlay-fit-exclusion-shadow', agent: 'devops' };
    await approveHandler({}, payload);

    expect(mockExecuteContractPromotionAction).toHaveBeenCalledWith(
      'approve',
      payload,
      expect.objectContaining({
        source: expect.objectContaining({
          via: 'ipc',
          role: 'system',
        }),
      })
    );
  });

  test('unregister removes all contract promotion channels', () => {
    unregisterContractPromotionHandlers(ctx);
    for (const [channel] of CONTRACT_PROMOTION_CHANNEL_ACTIONS.entries()) {
      expect(ipcMain.removeHandler).toHaveBeenCalledWith(channel);
    }
  });
});
