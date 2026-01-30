/**
 * Plugin Handlers Tests
 * Target: Full coverage of modules/ipc/plugin-handlers.js
 */

const { registerPluginHandlers } = require('../modules/ipc/plugin-handlers');

describe('plugin-handlers', () => {
  let mockIpcMain;
  let handlers;
  let mockPluginManager;

  beforeEach(() => {
    handlers = {};
    mockIpcMain = {
      handle: jest.fn((channel, handler) => {
        handlers[channel] = handler;
      }),
    };

    mockPluginManager = {
      listPlugins: jest.fn(() => [{ id: 'plugin-1', enabled: true }]),
      enablePlugin: jest.fn(() => ({ success: true })),
      disablePlugin: jest.fn(() => ({ success: true })),
      reloadPlugin: jest.fn(() => ({ success: true })),
      loadAll: jest.fn(() => [{ id: 'plugin-1' }, { id: 'plugin-2' }]),
      runCommand: jest.fn(() => ({ success: true, result: 'command output' })),
    };
  });

  describe('registerPluginHandlers', () => {
    test('throws if ctx.ipcMain is missing', () => {
      expect(() => registerPluginHandlers({})).toThrow('registerPluginHandlers requires ctx.ipcMain');
      expect(() => registerPluginHandlers(null)).toThrow('registerPluginHandlers requires ctx.ipcMain');
    });

    test('registers all plugin handlers', () => {
      registerPluginHandlers({ ipcMain: mockIpcMain }, { pluginManager: mockPluginManager });

      expect(mockIpcMain.handle).toHaveBeenCalledWith('list-plugins', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('enable-plugin', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('disable-plugin', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('reload-plugin', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('reload-plugins', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('run-plugin-command', expect.any(Function));
    });
  });

  describe('list-plugins handler', () => {
    test('returns plugins when manager available', () => {
      registerPluginHandlers({ ipcMain: mockIpcMain }, { pluginManager: mockPluginManager });

      const result = handlers['list-plugins']();

      expect(result).toEqual({
        success: true,
        plugins: [{ id: 'plugin-1', enabled: true }],
      });
      expect(mockPluginManager.listPlugins).toHaveBeenCalled();
    });

    test('returns error when manager unavailable', () => {
      registerPluginHandlers({ ipcMain: mockIpcMain }, {});

      const result = handlers['list-plugins']();

      expect(result).toEqual({
        success: false,
        error: 'Plugin manager unavailable',
      });
    });

    test('uses ctx.pluginManager as fallback', () => {
      registerPluginHandlers({ ipcMain: mockIpcMain, pluginManager: mockPluginManager });

      const result = handlers['list-plugins']();

      expect(result.success).toBe(true);
      expect(mockPluginManager.listPlugins).toHaveBeenCalled();
    });
  });

  describe('enable-plugin handler', () => {
    test('enables plugin when manager available', () => {
      registerPluginHandlers({ ipcMain: mockIpcMain }, { pluginManager: mockPluginManager });

      const result = handlers['enable-plugin']({}, 'plugin-1');

      expect(result).toEqual({ success: true });
      expect(mockPluginManager.enablePlugin).toHaveBeenCalledWith('plugin-1');
    });

    test('returns error when manager unavailable', () => {
      registerPluginHandlers({ ipcMain: mockIpcMain }, {});

      const result = handlers['enable-plugin']({}, 'plugin-1');

      expect(result).toEqual({
        success: false,
        error: 'Plugin manager unavailable',
      });
    });

    test('returns error when pluginId missing', () => {
      registerPluginHandlers({ ipcMain: mockIpcMain }, { pluginManager: mockPluginManager });

      const result = handlers['enable-plugin']({}, null);

      expect(result).toEqual({
        success: false,
        error: 'pluginId required',
      });
    });

    test('converts pluginId to string', () => {
      registerPluginHandlers({ ipcMain: mockIpcMain }, { pluginManager: mockPluginManager });

      handlers['enable-plugin']({}, 123);

      expect(mockPluginManager.enablePlugin).toHaveBeenCalledWith('123');
    });
  });

  describe('disable-plugin handler', () => {
    test('disables plugin when manager available', () => {
      registerPluginHandlers({ ipcMain: mockIpcMain }, { pluginManager: mockPluginManager });

      const result = handlers['disable-plugin']({}, 'plugin-1');

      expect(result).toEqual({ success: true });
      expect(mockPluginManager.disablePlugin).toHaveBeenCalledWith('plugin-1');
    });

    test('returns error when manager unavailable', () => {
      registerPluginHandlers({ ipcMain: mockIpcMain }, {});

      const result = handlers['disable-plugin']({}, 'plugin-1');

      expect(result).toEqual({
        success: false,
        error: 'Plugin manager unavailable',
      });
    });

    test('returns error when pluginId missing', () => {
      registerPluginHandlers({ ipcMain: mockIpcMain }, { pluginManager: mockPluginManager });

      const result = handlers['disable-plugin']({}, undefined);

      expect(result).toEqual({
        success: false,
        error: 'pluginId required',
      });
    });
  });

  describe('reload-plugin handler', () => {
    test('reloads plugin when manager available', () => {
      registerPluginHandlers({ ipcMain: mockIpcMain }, { pluginManager: mockPluginManager });

      const result = handlers['reload-plugin']({}, 'plugin-1');

      expect(result).toEqual({ success: true });
      expect(mockPluginManager.reloadPlugin).toHaveBeenCalledWith('plugin-1');
    });

    test('returns error when manager unavailable', () => {
      registerPluginHandlers({ ipcMain: mockIpcMain }, {});

      const result = handlers['reload-plugin']({}, 'plugin-1');

      expect(result).toEqual({
        success: false,
        error: 'Plugin manager unavailable',
      });
    });

    test('returns error when pluginId missing', () => {
      registerPluginHandlers({ ipcMain: mockIpcMain }, { pluginManager: mockPluginManager });

      const result = handlers['reload-plugin']({}, '');

      expect(result).toEqual({
        success: false,
        error: 'pluginId required',
      });
    });
  });

  describe('reload-plugins handler', () => {
    test('reloads all plugins when manager available', () => {
      registerPluginHandlers({ ipcMain: mockIpcMain }, { pluginManager: mockPluginManager });

      const result = handlers['reload-plugins']();

      expect(result).toEqual({
        success: true,
        plugins: [{ id: 'plugin-1' }, { id: 'plugin-2' }],
      });
      expect(mockPluginManager.loadAll).toHaveBeenCalled();
    });

    test('returns error when manager unavailable', () => {
      registerPluginHandlers({ ipcMain: mockIpcMain }, {});

      const result = handlers['reload-plugins']();

      expect(result).toEqual({
        success: false,
        error: 'Plugin manager unavailable',
      });
    });
  });

  describe('run-plugin-command handler', () => {
    test('runs command when manager available', async () => {
      registerPluginHandlers({ ipcMain: mockIpcMain }, { pluginManager: mockPluginManager });

      const result = await handlers['run-plugin-command']({}, 'plugin-1', 'my-command', { arg1: 'value1' });

      expect(result).toEqual({ success: true, result: 'command output' });
      expect(mockPluginManager.runCommand).toHaveBeenCalledWith('plugin-1', 'my-command', { arg1: 'value1' });
    });

    test('returns error when manager unavailable', async () => {
      registerPluginHandlers({ ipcMain: mockIpcMain }, {});

      const result = await handlers['run-plugin-command']({}, 'plugin-1', 'my-command');

      expect(result).toEqual({
        success: false,
        error: 'Plugin manager unavailable',
      });
    });

    test('returns error when pluginId missing', async () => {
      registerPluginHandlers({ ipcMain: mockIpcMain }, { pluginManager: mockPluginManager });

      const result = await handlers['run-plugin-command']({}, null, 'my-command');

      expect(result).toEqual({
        success: false,
        error: 'pluginId and commandId required',
      });
    });

    test('returns error when commandId missing', async () => {
      registerPluginHandlers({ ipcMain: mockIpcMain }, { pluginManager: mockPluginManager });

      const result = await handlers['run-plugin-command']({}, 'plugin-1', null);

      expect(result).toEqual({
        success: false,
        error: 'pluginId and commandId required',
      });
    });

    test('defaults args to empty object', async () => {
      registerPluginHandlers({ ipcMain: mockIpcMain }, { pluginManager: mockPluginManager });

      await handlers['run-plugin-command']({}, 'plugin-1', 'my-command');

      expect(mockPluginManager.runCommand).toHaveBeenCalledWith('plugin-1', 'my-command', {});
    });

    test('converts ids to strings', async () => {
      registerPluginHandlers({ ipcMain: mockIpcMain }, { pluginManager: mockPluginManager });

      await handlers['run-plugin-command']({}, 123, 456, {});

      expect(mockPluginManager.runCommand).toHaveBeenCalledWith('123', '456', {});
    });
  });
});
