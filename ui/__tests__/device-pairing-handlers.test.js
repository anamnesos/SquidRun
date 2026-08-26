const {
  createIpcHarness,
  createDefaultContext,
} = require('./helpers/ipc-harness');
const {
  registerDevicePairingHandlers,
  unregisterDevicePairingHandlers,
} = require('../modules/ipc/device-pairing-handlers');

describe('device-pairing handlers', () => {
  let harness;
  let ctx;

  beforeEach(() => {
    harness = createIpcHarness();
    ctx = createDefaultContext({ ipcMain: harness.ipcMain });
  });

  test('exposes bridge:get-status snapshot through IPC', async () => {
    const getBridgeStatus = jest.fn(() => ({
      enabled: true,
      configured: true,
      state: 'connected',
      flapCount: 2,
    }));

    registerDevicePairingHandlers(ctx, { getBridgeStatus });

    await expect(harness.invoke('bridge:get-status')).resolves.toEqual({
      ok: true,
      status: {
        enabled: true,
        configured: true,
        state: 'connected',
        flapCount: 2,
      },
    });
    expect(getBridgeStatus).toHaveBeenCalledTimes(1);
  });

  test('returns unsupported when bridge:get-status dependency is unavailable', async () => {
    registerDevicePairingHandlers(ctx, {});

    await expect(harness.invoke('bridge:get-status')).resolves.toEqual({
      ok: false,
      status: 'unsupported',
      error: 'Bridge status unavailable',
    });
  });

  test('unregister removes bridge:get-status handler', () => {
    registerDevicePairingHandlers(ctx, {
      getBridgeStatus: jest.fn(() => ({ state: 'connected' })),
    });

    unregisterDevicePairingHandlers(ctx);

    expect(ctx.ipcMain.removeHandler).toHaveBeenCalledWith('bridge:get-status');
  });
});
