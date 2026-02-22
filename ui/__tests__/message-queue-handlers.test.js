/**
 * Message Queue IPC Handler Tests
 * Target: Full coverage of message-queue-handlers.js
 */

const {
  createIpcHarness,
  createDefaultContext,
} = require('./helpers/ipc-harness');

const { registerMessageQueueHandlers } = require('../modules/ipc/message-queue-handlers');

describe('Message Queue Handlers', () => {
  let harness;
  let ctx;

  beforeEach(() => {
    harness = createIpcHarness();
    ctx = createDefaultContext({ ipcMain: harness.ipcMain });

    // Add missing watcher mocks
    ctx.watcher = {
      ...ctx.watcher,
      initMessageQueue: jest.fn(() => ({ success: true })),
      sendMessage: jest.fn(() => ({ success: true, messageId: 'msg-123' })),
      getMessages: jest.fn(() => []),
      markMessageDelivered: jest.fn(() => ({ success: true })),
      clearMessages: jest.fn(() => ({ success: true, cleared: 5 })),
      getMessageQueueStatus: jest.fn(() => ({ pending: 0, delivered: 10 })),
      startMessageWatcher: jest.fn(async () => ({ success: true })),
    };

    registerMessageQueueHandlers(ctx);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('constructor validation', () => {
    test('throws when ctx is null', () => {
      expect(() => registerMessageQueueHandlers(null)).toThrow('registerMessageQueueHandlers requires ctx.ipcMain');
    });

    test('throws when ctx.ipcMain is missing', () => {
      expect(() => registerMessageQueueHandlers({})).toThrow('registerMessageQueueHandlers requires ctx.ipcMain');
    });
  });

  describe('init-message-queue', () => {
    test('initializes message queue', async () => {
      const result = await harness.invoke('init-message-queue');

      expect(ctx.watcher.initMessageQueue).toHaveBeenCalled();
      expect(result).toEqual({ success: true });
    });
  });

  describe('send-message', () => {
    test('sends direct message', async () => {
      const result = await harness.invoke('send-message', '1', '2', 'Hello', 'direct');

      expect(ctx.watcher.sendMessage).toHaveBeenCalledWith('1', '2', 'Hello', 'direct');
      expect(result).toEqual({ success: true, messageId: 'msg-123' });
    });

    test('uses default type when not specified', async () => {
      await harness.invoke('send-message', '1', '2', 'Hello');

      expect(ctx.watcher.sendMessage).toHaveBeenCalledWith('1', '2', 'Hello', 'direct');
    });
  });

  describe('send-broadcast-message', () => {
    test('sends message to all other panes', async () => {
      const result = await harness.invoke('send-broadcast-message', '1', 'Broadcast message');

      // Should call sendMessage for all panes except the sender
      const sendCalls = ctx.watcher.sendMessage.mock.calls;
      expect(sendCalls.length).toBe(ctx.PANE_IDS.length - 1);

      // Verify no message sent to self
      const sentToPanes = sendCalls.map(call => call[1]);
      expect(sentToPanes).not.toContain('1');

      expect(result.success).toBe(true);
      expect(result.results.length).toBe(ctx.PANE_IDS.length - 1);
    });

    test('includes toPaneId in results', async () => {
      const result = await harness.invoke('send-broadcast-message', '1', 'Broadcast');

      result.results.forEach(r => {
        expect(r.toPaneId).toBeDefined();
        expect(r.success).toBe(true);
      });
    });

    test('returns failure with failedTargets when some broadcasts fail', async () => {
      const recipients = ctx.PANE_IDS.filter((paneId) => paneId !== '1');
      const failedPaneId = recipients[0];
      ctx.watcher.sendMessage.mockImplementation((fromPaneId, toPaneId) => {
        if (toPaneId === failedPaneId) {
          return { success: false, error: 'send_failed' };
        }
        return { success: true, messageId: `msg-${toPaneId}` };
      });

      const result = await harness.invoke('send-broadcast-message', '1', 'Broadcast partial fail');

      expect(ctx.watcher.sendMessage).toHaveBeenCalledTimes(recipients.length);
      expect(result.success).toBe(false);
      expect(result.failedTargets).toEqual([failedPaneId]);
      expect(result.results).toEqual(expect.arrayContaining([
        expect.objectContaining({ toPaneId: failedPaneId, success: false, error: 'send_failed' }),
      ]));
    });

    test('returns failure with all failedTargets when all broadcasts fail', async () => {
      const recipients = ctx.PANE_IDS.filter((paneId) => paneId !== '1');
      ctx.watcher.sendMessage.mockReturnValue({ success: false, error: 'offline' });

      const result = await harness.invoke('send-broadcast-message', '1', 'Broadcast all fail');

      expect(ctx.watcher.sendMessage).toHaveBeenCalledTimes(recipients.length);
      expect(result.success).toBe(false);
      expect(result.failedTargets).toEqual(recipients);
      expect(result.results.every((entry) => entry.success === false)).toBe(true);
    });
  });

  describe('send-group-message', () => {
    test('sends message to specific panes', async () => {
      const result = await harness.invoke('send-group-message', '1', ['2', '3', '4'], 'Group message');

      expect(ctx.watcher.sendMessage).toHaveBeenCalledTimes(3);
      expect(ctx.watcher.sendMessage).toHaveBeenCalledWith('1', '2', 'Group message', 'direct');
      expect(ctx.watcher.sendMessage).toHaveBeenCalledWith('1', '3', 'Group message', 'direct');
      expect(ctx.watcher.sendMessage).toHaveBeenCalledWith('1', '4', 'Group message', 'direct');
      expect(result.success).toBe(true);
      expect(result.results.length).toBe(3);
    });

    test('excludes sender from recipients', async () => {
      const result = await harness.invoke('send-group-message', '1', ['1', '2', '3'], 'Group message');

      // Should only send to 2 and 3, not 1
      expect(ctx.watcher.sendMessage).toHaveBeenCalledTimes(2);
      expect(result.results.length).toBe(2);
    });

    test('returns failure with failedTargets when some group sends fail', async () => {
      const groupTargets = ctx.PANE_IDS.filter((paneId) => paneId !== '1');
      const failedPaneId = groupTargets[0];
      ctx.watcher.sendMessage.mockImplementation((fromPaneId, toPaneId) => {
        if (toPaneId === failedPaneId) {
          return { success: false, error: 'not_available' };
        }
        return { success: true, messageId: `msg-${toPaneId}` };
      });

      const result = await harness.invoke('send-group-message', '1', groupTargets, 'Group partial fail');

      expect(ctx.watcher.sendMessage).toHaveBeenCalledTimes(groupTargets.length);
      expect(result.success).toBe(false);
      expect(result.failedTargets).toEqual([failedPaneId]);
      expect(result.results).toEqual(expect.arrayContaining([
        expect.objectContaining({ toPaneId: failedPaneId, success: false, error: 'not_available' }),
      ]));
    });

    test('returns failure with all failedTargets when all group sends fail', async () => {
      const groupTargets = ctx.PANE_IDS.filter((paneId) => paneId !== '1');
      ctx.watcher.sendMessage.mockReturnValue({ success: false, error: 'down' });

      const result = await harness.invoke('send-group-message', '1', groupTargets, 'Group all fail');

      expect(ctx.watcher.sendMessage).toHaveBeenCalledTimes(groupTargets.length);
      expect(result.success).toBe(false);
      expect(result.failedTargets).toEqual(groupTargets);
      expect(result.results.every((entry) => entry.success === false)).toBe(true);
    });
  });

  describe('get-messages', () => {
    test('gets messages for pane', async () => {
      const messages = [
        { id: 'msg-1', content: 'Hello' },
        { id: 'msg-2', content: 'World' },
      ];
      ctx.watcher.getMessages.mockReturnValue(messages);

      const result = await harness.invoke('get-messages', '1');

      expect(ctx.watcher.getMessages).toHaveBeenCalledWith('1', false);
      expect(result).toEqual({
        success: true,
        messages,
        count: 2,
      });
    });

    test('gets only undelivered messages when specified', async () => {
      ctx.watcher.getMessages.mockReturnValue([]);

      await harness.invoke('get-messages', '1', true);

      expect(ctx.watcher.getMessages).toHaveBeenCalledWith('1', true);
    });
  });

  describe('get-all-messages', () => {
    test('gets messages for all panes', async () => {
      ctx.watcher.getMessages.mockImplementation((paneId) => {
        return [{ id: `msg-${paneId}`, content: `Message for ${paneId}` }];
      });

      const result = await harness.invoke('get-all-messages');

      expect(ctx.watcher.getMessages).toHaveBeenCalledTimes(ctx.PANE_IDS.length);
      expect(result.success).toBe(true);
      expect(Object.keys(result.messages).length).toBe(ctx.PANE_IDS.length);
    });
  });

  describe('mark-message-delivered', () => {
    test('marks message as delivered', async () => {
      const result = await harness.invoke('mark-message-delivered', '1', 'msg-123');

      expect(ctx.watcher.markMessageDelivered).toHaveBeenCalledWith('1', 'msg-123');
      expect(result).toEqual({ success: true });
    });
  });

  describe('clear-messages', () => {
    test('clears all messages for pane', async () => {
      const result = await harness.invoke('clear-messages', '1');

      expect(ctx.watcher.clearMessages).toHaveBeenCalledWith('1', false);
      expect(result).toEqual({ success: true, cleared: 5 });
    });

    test('clears only delivered messages when specified', async () => {
      await harness.invoke('clear-messages', '1', true);

      expect(ctx.watcher.clearMessages).toHaveBeenCalledWith('1', true);
    });
  });

  describe('get-message-queue-status', () => {
    test('returns message queue status', async () => {
      ctx.watcher.getMessageQueueStatus.mockReturnValue({
        pending: 5,
        delivered: 20,
        total: 25,
      });

      const result = await harness.invoke('get-message-queue-status');

      expect(ctx.watcher.getMessageQueueStatus).toHaveBeenCalled();
      expect(result).toEqual({
        pending: 5,
        delivered: 20,
        total: 25,
      });
    });
  });

  describe('start-message-watcher', () => {
    test('starts message watcher', async () => {
      const result = await harness.invoke('start-message-watcher');

      expect(ctx.watcher.startMessageWatcher).toHaveBeenCalled();
      expect(result).toEqual({ success: true });
    });

    test('waits for watcher startup resolution before reporting success', async () => {
      let resolveStart;
      const startPromise = new Promise((resolve) => {
        resolveStart = resolve;
      });
      ctx.watcher.startMessageWatcher.mockReturnValueOnce(startPromise);

      const pendingResult = harness.invoke('start-message-watcher');
      resolveStart({ success: true, path: '/test/queue' });

      await expect(pendingResult).resolves.toEqual({ success: true, path: '/test/queue' });
    });

    test('returns failure if watcher startup throws', async () => {
      ctx.watcher.startMessageWatcher.mockRejectedValueOnce(new Error('watcher failed'));

      const result = await harness.invoke('start-message-watcher');

      expect(result).toEqual({
        success: false,
        error: 'watcher failed',
      });
    });

    test('returns failure if watcher startup resolves unsuccessful', async () => {
      ctx.watcher.startMessageWatcher.mockResolvedValueOnce({ success: false, reason: 'stopped' });

      const result = await harness.invoke('start-message-watcher');

      expect(result).toEqual({
        success: false,
        error: 'stopped',
      });
    });
  });
});
