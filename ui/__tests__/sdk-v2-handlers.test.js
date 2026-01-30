/**
 * SDK V2 IPC Handler Tests
 * Target: Full coverage of sdk-v2-handlers.js
 */

const {
  createIpcHarness,
  createDefaultContext,
} = require('./helpers/ipc-harness');

// Mock the logger
jest.mock('../modules/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
}));

// Mock the sdk-bridge module
const mockSdkBridge = {
  sendMessage: jest.fn(() => true),
  subscribe: jest.fn(() => true),
  unsubscribe: jest.fn(() => true),
  getSessionIds: jest.fn(() => ['sess-1', 'sess-2']),
  startSessions: jest.fn(() => Promise.resolve()),
  stopSessions: jest.fn(() => Promise.resolve(['sess-1', 'sess-2'])),
  getPaneStatus: jest.fn(() => ({ active: true, lastMessage: 'test' })),
  interrupt: jest.fn(() => true),
};

jest.mock('../modules/sdk-bridge', () => ({
  getSDKBridge: () => mockSdkBridge,
}));

const { registerSdkV2Handlers } = require('../modules/ipc/sdk-v2-handlers');

describe('SDK V2 Handlers', () => {
  let harness;
  let ctx;

  beforeEach(() => {
    jest.clearAllMocks();
    harness = createIpcHarness();
    ctx = createDefaultContext({ ipcMain: harness.ipcMain });
    registerSdkV2Handlers(ctx);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('constructor validation', () => {
    test('throws when ctx is null', () => {
      expect(() => registerSdkV2Handlers(null)).toThrow('registerSdkV2Handlers requires ctx.ipcMain');
    });

    test('throws when ctx.ipcMain is missing', () => {
      expect(() => registerSdkV2Handlers({})).toThrow('registerSdkV2Handlers requires ctx.ipcMain');
    });
  });

  describe('sdk-send-message', () => {
    test('sends message to pane', async () => {
      const result = await harness.invoke('sdk-send-message', '1', 'Hello agent');

      expect(mockSdkBridge.sendMessage).toHaveBeenCalledWith('1', 'Hello agent');
      expect(result).toEqual({ success: true });
    });

    test('returns false when send fails', async () => {
      mockSdkBridge.sendMessage.mockReturnValueOnce(false);

      const result = await harness.invoke('sdk-send-message', '1', 'Hello');

      expect(result).toEqual({ success: false });
    });

    test('returns error on exception', async () => {
      mockSdkBridge.sendMessage.mockImplementationOnce(() => {
        throw new Error('Send failed');
      });

      const result = await harness.invoke('sdk-send-message', '1', 'Hello');

      expect(result).toEqual({ success: false, error: 'Send failed' });
    });
  });

  describe('sdk-subscribe', () => {
    test('subscribes to pane', async () => {
      const result = await harness.invoke('sdk-subscribe', '1');

      expect(mockSdkBridge.subscribe).toHaveBeenCalledWith('1');
      expect(result).toEqual({ success: true });
    });

    test('returns false when subscribe fails', async () => {
      mockSdkBridge.subscribe.mockReturnValueOnce(false);

      const result = await harness.invoke('sdk-subscribe', '1');

      expect(result).toEqual({ success: false });
    });
  });

  describe('sdk-unsubscribe', () => {
    test('unsubscribes from pane', async () => {
      const result = await harness.invoke('sdk-unsubscribe', '1');

      expect(mockSdkBridge.unsubscribe).toHaveBeenCalledWith('1');
      expect(result).toEqual({ success: true });
    });

    test('returns false when unsubscribe fails', async () => {
      mockSdkBridge.unsubscribe.mockReturnValueOnce(false);

      const result = await harness.invoke('sdk-unsubscribe', '1');

      expect(result).toEqual({ success: false });
    });
  });

  describe('sdk-get-session-ids', () => {
    test('returns session IDs', async () => {
      const result = await harness.invoke('sdk-get-session-ids');

      expect(mockSdkBridge.getSessionIds).toHaveBeenCalled();
      expect(result).toEqual(['sess-1', 'sess-2']);
    });

    test('returns empty array when no sessions', async () => {
      mockSdkBridge.getSessionIds.mockReturnValueOnce([]);

      const result = await harness.invoke('sdk-get-session-ids');

      expect(result).toEqual([]);
    });
  });

  describe('sdk-start-sessions', () => {
    test('starts sessions with default options', async () => {
      const result = await harness.invoke('sdk-start-sessions');

      expect(mockSdkBridge.startSessions).toHaveBeenCalledWith({
        workspace: expect.any(String),
        resumeIds: undefined,
      });
      expect(result).toEqual({ success: true });
    });

    test('starts sessions with custom workspace', async () => {
      const result = await harness.invoke('sdk-start-sessions', { workspace: '/custom/path' });

      expect(mockSdkBridge.startSessions).toHaveBeenCalledWith({
        workspace: '/custom/path',
        resumeIds: undefined,
      });
      expect(result).toEqual({ success: true });
    });

    test('starts sessions with resumeIds', async () => {
      const result = await harness.invoke('sdk-start-sessions', { resumeIds: ['id1', 'id2'] });

      expect(mockSdkBridge.startSessions).toHaveBeenCalledWith({
        workspace: expect.any(String),
        resumeIds: ['id1', 'id2'],
      });
    });

    test('returns error on exception', async () => {
      mockSdkBridge.startSessions.mockRejectedValueOnce(new Error('Start failed'));

      const result = await harness.invoke('sdk-start-sessions');

      expect(result).toEqual({ success: false, error: 'Start failed' });
    });
  });

  describe('sdk-stop-sessions', () => {
    test('stops all sessions', async () => {
      const result = await harness.invoke('sdk-stop-sessions');

      expect(mockSdkBridge.stopSessions).toHaveBeenCalled();
      expect(result).toEqual({ success: true, sessionIds: ['sess-1', 'sess-2'] });
    });

    test('returns error on exception', async () => {
      mockSdkBridge.stopSessions.mockRejectedValueOnce(new Error('Stop failed'));

      const result = await harness.invoke('sdk-stop-sessions');

      expect(result).toEqual({ success: false, error: 'Stop failed' });
    });
  });

  describe('sdk-pane-status', () => {
    test('returns pane status', async () => {
      const result = await harness.invoke('sdk-pane-status', '1');

      expect(mockSdkBridge.getPaneStatus).toHaveBeenCalledWith('1');
      expect(result).toEqual({ active: true, lastMessage: 'test' });
    });
  });

  describe('sdk-interrupt', () => {
    test('interrupts pane', async () => {
      const result = await harness.invoke('sdk-interrupt', '1');

      expect(mockSdkBridge.interrupt).toHaveBeenCalledWith('1');
      expect(result).toEqual({ success: true });
    });

    test('returns false when interrupt fails', async () => {
      mockSdkBridge.interrupt.mockReturnValueOnce(false);

      const result = await harness.invoke('sdk-interrupt', '1');

      expect(result).toEqual({ success: false });
    });
  });
});
