const {
  setupAllHandlers,
  unregisterAllHandlers,
} = require('../modules/ipc/handler-registry');

describe('IPC handler registry lifecycle', () => {
  test('setupAllHandlers runs unsetup before setup to prevent duplicate registrations', () => {
    const registry = {
      setup: jest.fn(),
      unsetup: jest.fn(),
    };
    const ctx = { ipcMain: {} };
    const deps = { test: true };

    setupAllHandlers(registry, ctx, deps);

    expect(registry.unsetup).toHaveBeenCalledWith(ctx, deps);
    expect(registry.setup).toHaveBeenCalledWith(ctx, deps);
    expect(registry.unsetup.mock.invocationCallOrder[0]).toBeLessThan(
      registry.setup.mock.invocationCallOrder[0]
    );
  });

  test('unregisterAllHandlers forwards ctx/deps to registry.unsetup', () => {
    const registry = {
      unsetup: jest.fn(),
    };
    const ctx = { ipcMain: {} };
    const deps = { test: true };

    unregisterAllHandlers(registry, ctx, deps);

    expect(registry.unsetup).toHaveBeenCalledWith(ctx, deps);
  });
});
