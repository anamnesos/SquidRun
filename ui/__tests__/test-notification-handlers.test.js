/**
 * Test Notification IPC Handler Tests
 * Target: Full coverage of test-notification-handlers.js
 */

const {
  createIpcHarness,
  createDefaultContext,
} = require('./helpers/ipc-harness');

// Mock fs
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
}));

// Mock logger
jest.mock('../modules/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
}));

const fs = require('fs');
const { registerTestNotificationHandlers } = require('../modules/ipc/test-notification-handlers');

describe('Test Notification Handlers', () => {
  let harness;
  let ctx;
  let deps;

  beforeEach(() => {
    jest.clearAllMocks();
    harness = createIpcHarness();
    ctx = createDefaultContext({ ipcMain: harness.ipcMain });
    ctx.WORKSPACE_PATH = '/test/workspace';
    ctx.mainWindow.isDestroyed = jest.fn(() => false);

    deps = {
      logActivity: jest.fn(),
    };

    fs.existsSync.mockReturnValue(false);

    registerTestNotificationHandlers(ctx, deps);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('registration', () => {
    test('throws if ctx is missing', () => {
      expect(() => registerTestNotificationHandlers(null)).toThrow('requires ctx.ipcMain');
    });

    test('throws if ipcMain is missing', () => {
      expect(() => registerTestNotificationHandlers({})).toThrow('requires ctx.ipcMain');
    });
  });

  describe('notify-test-failure', () => {
    test('sends notification for failures', async () => {
      const results = {
        failed: 3,
        failures: [
          { test: 'test1', message: 'Failed assertion' },
          { test: 'test2', message: 'Timeout' },
          { test: 'test3', message: 'Error' },
        ],
      };

      const result = await harness.invoke('notify-test-failure', results);

      expect(result.success).toBe(true);
      expect(result.notified).toBe(true);
      expect(result.title).toContain('3 Tests Failed');
      expect(ctx.mainWindow.webContents.send).toHaveBeenCalledWith(
        'test-failure-notification',
        expect.objectContaining({ failedCount: 3 })
      );
    });

    test('singular test failed message', async () => {
      const results = { failed: 1, failures: [{ test: 'one' }] };

      const result = await harness.invoke('notify-test-failure', results);

      expect(result.title).toBe('1 Test Failed');
    });

    test('truncates to 3 failures in body', async () => {
      const results = {
        failed: 5,
        failures: [
          { test: 'test1' },
          { test: 'test2' },
          { test: 'test3' },
          { test: 'test4' },
          { test: 'test5' },
        ],
      };

      const result = await harness.invoke('notify-test-failure', results);

      expect(result.body).toContain('test1');
      expect(result.body).toContain('test2');
      expect(result.body).toContain('test3');
      expect(result.body).toContain('and 2 more');
    });

    test('flashes tab on failure', async () => {
      await harness.invoke('notify-test-failure', { failed: 1, failures: [] });

      expect(ctx.mainWindow.webContents.send).toHaveBeenCalledWith('flash-tab', {
        tab: 'tests',
        color: 'red',
      });
    });

    test('logs activity when logActivity available', async () => {
      await harness.invoke('notify-test-failure', { failed: 2, failures: [] });

      expect(deps.logActivity).toHaveBeenCalledWith(
        'error',
        null,
        expect.stringContaining('2 tests failed'),
        expect.any(Object)
      );
    });

    test('sends external notification when externalNotifier available', async () => {
      const mockNotify = jest.fn().mockResolvedValue({});
      ctx.externalNotifier = { notify: mockNotify };

      await harness.invoke('notify-test-failure', { failed: 2, failures: [] });

      expect(mockNotify).toHaveBeenCalledWith({
        category: 'alert',
        title: '2 tests failed',
        message: expect.any(String),
      });
    });

    test('handles missing mainWindow', async () => {
      ctx.mainWindow.isDestroyed.mockReturnValue(true);

      const result = await harness.invoke('notify-test-failure', { failed: 1, failures: [] });

      expect(result.notified).toBe(true);
      expect(ctx.mainWindow.webContents.send).not.toHaveBeenCalled();
    });
  });

  describe('get-test-notification-settings', () => {
    test('returns default settings', async () => {
      const result = await harness.invoke('get-test-notification-settings');

      expect(result.success).toBe(true);
      expect(result.settings.enabled).toBe(true);
      expect(result.settings.flashTab).toBe(true);
      expect(result.settings.blockTransitions).toBe(false);
    });
  });

  describe('set-test-notification-settings', () => {
    test('updates settings', async () => {
      const result = await harness.invoke('set-test-notification-settings', {
        enabled: false,
        soundEnabled: true,
      });

      expect(result.success).toBe(true);
      expect(result.settings.enabled).toBe(false);
      expect(result.settings.soundEnabled).toBe(true);
    });

    test('preserves other settings', async () => {
      await harness.invoke('set-test-notification-settings', { enabled: false });
      const result = await harness.invoke('get-test-notification-settings');

      expect(result.settings.flashTab).toBe(true); // Preserved
      expect(result.settings.enabled).toBe(false); // Changed
    });
  });

  describe('should-block-on-test-failure', () => {
    test('returns no block when blocking disabled', async () => {
      const result = await harness.invoke('should-block-on-test-failure');

      expect(result.success).toBe(true);
      expect(result.block).toBe(false);
      expect(result.reason).toContain('disabled');
    });

    test('returns no block when no results file', async () => {
      await harness.invoke('set-test-notification-settings', { blockTransitions: true });
      fs.existsSync.mockReturnValue(false);

      const result = await harness.invoke('should-block-on-test-failure');

      expect(result.block).toBe(false);
    });

    test('returns block when tests failing', async () => {
      await harness.invoke('set-test-notification-settings', { blockTransitions: true });
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({ failed: 2 }));

      const result = await harness.invoke('should-block-on-test-failure');

      expect(result.block).toBe(true);
      expect(result.reason).toContain('2 test(s) failing');
    });

    test('returns no block when tests passing', async () => {
      await harness.invoke('set-test-notification-settings', { blockTransitions: true });
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({ failed: 0, passed: 10 }));

      const result = await harness.invoke('should-block-on-test-failure');

      expect(result.block).toBe(false);
    });

    test('handles read error gracefully', async () => {
      await harness.invoke('set-test-notification-settings', { blockTransitions: true });
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockImplementation(() => {
        throw new Error('Read error');
      });

      const result = await harness.invoke('should-block-on-test-failure');

      expect(result.block).toBe(false);
    });
  });

  describe('test-run-complete event', () => {
    test('notifies on failure', () => {
      const results = { failed: 2, failures: [{ test: 'a' }] };

      harness.emit('test-run-complete', results);

      expect(ctx.mainWindow.webContents.send).toHaveBeenCalledWith(
        'test-failure-notification',
        expect.any(Object)
      );
    });

    test('does not notify on success', () => {
      const results = { failed: 0, passed: 10 };

      harness.emit('test-run-complete', results);

      expect(ctx.mainWindow.webContents.send).not.toHaveBeenCalledWith(
        'test-failure-notification',
        expect.any(Object)
      );
    });
  });

  describe('notifications disabled', () => {
    test('returns not notified when disabled', async () => {
      await harness.invoke('set-test-notification-settings', { enabled: false });

      const result = await harness.invoke('notify-test-failure', { failed: 5, failures: [] });

      expect(result.notified).toBe(false);
      expect(result.reason).toContain('disabled');
    });
  });
});
