/**
 * Settings IPC Handler Tests
 * Target: Full coverage of settings-handlers.js
 */

const {
  createIpcHarness,
  createDefaultContext,
  createDepsMock,
} = require('./helpers/ipc-harness');

const { registerSettingsHandlers } = require('../modules/ipc/settings-handlers');

describe('Settings Handlers', () => {
  let harness;
  let ctx;
  let deps;

  beforeEach(() => {
    harness = createIpcHarness();
    ctx = createDefaultContext({ ipcMain: harness.ipcMain });
    deps = createDepsMock();
    registerSettingsHandlers(ctx, deps);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('get-settings', () => {
    test('returns loaded settings', async () => {
      const mockSettings = { dryRun: true, watcherEnabled: false };
      deps.loadSettings.mockReturnValue(mockSettings);

      const result = await harness.invoke('get-settings');

      expect(deps.loadSettings).toHaveBeenCalled();
      expect(result).toEqual(mockSettings);
    });

    test('returns empty object when no settings', async () => {
      deps.loadSettings.mockReturnValue({});

      const result = await harness.invoke('get-settings');

      expect(result).toEqual({});
    });
  });

  describe('set-setting', () => {
    test('updates setting and saves', async () => {
      deps.loadSettings.mockReturnValue({ existing: true });

      const result = await harness.invoke('set-setting', 'newKey', 'newValue');

      expect(deps.loadSettings).toHaveBeenCalled();
      expect(deps.saveSettings).toHaveBeenCalledWith({ existing: true, newKey: 'newValue' });
      expect(result).toEqual({ existing: true, newKey: 'newValue' });
    });

    test('starts watcher when watcherEnabled set to true', async () => {
      deps.loadSettings.mockReturnValue({});

      await harness.invoke('set-setting', 'watcherEnabled', true);

      expect(ctx.watcher.startWatcher).toHaveBeenCalled();
    });

    test('stops watcher when watcherEnabled set to false', async () => {
      deps.loadSettings.mockReturnValue({});

      await harness.invoke('set-setting', 'watcherEnabled', false);

      expect(ctx.watcher.stopWatcher).toHaveBeenCalled();
    });

    test('does not affect watcher for other settings', async () => {
      deps.loadSettings.mockReturnValue({});

      await harness.invoke('set-setting', 'someOtherKey', true);

      expect(ctx.watcher.startWatcher).not.toHaveBeenCalled();
      expect(ctx.watcher.stopWatcher).not.toHaveBeenCalled();
    });

    test('overwrites existing setting', async () => {
      deps.loadSettings.mockReturnValue({ existing: 'old' });

      const result = await harness.invoke('set-setting', 'existing', 'new');

      expect(deps.saveSettings).toHaveBeenCalledWith({ existing: 'new' });
      expect(result.existing).toBe('new');
    });
  });

  describe('get-all-settings', () => {
    test('returns all settings', async () => {
      const mockSettings = { a: 1, b: 2, c: 3 };
      deps.loadSettings.mockReturnValue(mockSettings);

      const result = await harness.invoke('get-all-settings');

      expect(deps.loadSettings).toHaveBeenCalled();
      expect(result).toEqual(mockSettings);
    });
  });
});
