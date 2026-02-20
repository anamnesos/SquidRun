/**
 * External Notification IPC Handler Tests
 * Target: Full coverage of external-notification-handlers.js
 */

const {
  createIpcHarness,
  createDefaultContext,
} = require('./helpers/ipc-harness');

const { registerExternalNotificationHandlers } = require('../modules/ipc/external-notification-handlers');

describe('External Notification Handlers', () => {
  let harness;
  let ctx;

  beforeEach(() => {
    jest.clearAllMocks();
    harness = createIpcHarness();
    ctx = createDefaultContext({ ipcMain: harness.ipcMain });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('registration', () => {
    test('does nothing when ipcMain is missing', () => {
      expect(() => registerExternalNotificationHandlers({})).not.toThrow();
    });

    test('registers handler when ipcMain exists', () => {
      registerExternalNotificationHandlers(ctx);
      // Handler is registered if we can invoke it without "No handler registered" error
      ctx.externalNotifier = null;
      expect(harness.invoke('notify-external-test', {})).resolves.toEqual({
        success: false,
        error: 'external_notifier_unavailable',
      });
    });
  });

  describe('notify-external-test', () => {
    beforeEach(() => {
      registerExternalNotificationHandlers(ctx);
    });

    test('returns error when externalNotifier is unavailable', async () => {
      ctx.externalNotifier = null;

      const result = await harness.invoke('notify-external-test', {});

      expect(result.success).toBe(false);
      expect(result.error).toBe('external_notifier_unavailable');
    });

    test('returns error when externalNotifier.notify is not a function', async () => {
      ctx.externalNotifier = { notify: 'not-a-function' };

      const result = await harness.invoke('notify-external-test', {});

      expect(result.success).toBe(false);
      expect(result.error).toBe('external_notifier_unavailable');
    });

    test('sends notification with default values', async () => {
      const mockNotify = jest.fn().mockResolvedValue({ sent: true });
      ctx.externalNotifier = { notify: mockNotify };

      const result = await harness.invoke('notify-external-test');

      expect(result.success).toBe(true);
      expect(mockNotify).toHaveBeenCalledWith({
        category: 'alert',
        title: 'Test Notification',
        message: 'This is a test notification from SquidRun.',
        meta: { test: true },
      });
    });

    test('sends notification with custom payload', async () => {
      const mockNotify = jest.fn().mockResolvedValue({ sent: true, id: '123' });
      ctx.externalNotifier = { notify: mockNotify };

      const result = await harness.invoke('notify-external-test', {
        category: 'warning',
        title: 'Custom Title',
        message: 'Custom message content',
      });

      expect(result.success).toBe(true);
      expect(result.result).toEqual({ sent: true, id: '123' });
      expect(mockNotify).toHaveBeenCalledWith({
        category: 'warning',
        title: 'Custom Title',
        message: 'Custom message content',
        meta: { test: true },
      });
    });

    test('handles empty payload object', async () => {
      const mockNotify = jest.fn().mockResolvedValue({});
      ctx.externalNotifier = { notify: mockNotify };

      const result = await harness.invoke('notify-external-test', {});

      expect(result.success).toBe(true);
      expect(mockNotify).toHaveBeenCalledWith({
        category: 'alert',
        title: 'Test Notification',
        message: 'This is a test notification from SquidRun.',
        meta: { test: true },
      });
    });
  });
});
