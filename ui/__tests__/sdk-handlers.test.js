/**
 * SDK IPC Handler Tests
 * Target: Full coverage of sdk-handlers.js
 */

const {
  createIpcHarness,
  createDefaultContext,
} = require('./helpers/ipc-harness');

// Create mock bridge object that persists
const mockBridgeObj = {
  setMainWindow: jest.fn(),
  start: jest.fn(),
  stop: jest.fn(),
  write: jest.fn(),
  isActive: jest.fn(() => false),
  getSessions: jest.fn(() => []),
  startSessions: jest.fn().mockResolvedValue({}),
  broadcast: jest.fn(() => true),
};

// Mock sdk-bridge to return the same object every time
jest.mock('../modules/sdk-bridge', () => ({
  getSDKBridge: () => mockBridgeObj,
}));

// Mock logger
jest.mock('../modules/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
}));

const { registerSdkHandlers } = require('../modules/ipc/sdk-handlers');

describe('SDK Handlers', () => {
  let harness;
  let ctx;

  beforeEach(() => {
    jest.clearAllMocks();
    harness = createIpcHarness();
    ctx = createDefaultContext({ ipcMain: harness.ipcMain });

    registerSdkHandlers(ctx);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('registration', () => {
    test('throws if ctx is missing', () => {
      expect(() => registerSdkHandlers(null)).toThrow('requires ctx.ipcMain');
    });

    test('throws if ipcMain is missing', () => {
      expect(() => registerSdkHandlers({})).toThrow('requires ctx.ipcMain');
    });

    test('sets main window on SDK bridge', () => {
      expect(mockBridgeObj.setMainWindow).toHaveBeenCalledWith(ctx.mainWindow);
    });
  });

  describe('sdk-start', () => {
    test('starts SDK with prompt', async () => {
      const result = await harness.invoke('sdk-start', 'Hello world', {});

      expect(result.success).toBe(true);
      expect(mockBridgeObj.start).toHaveBeenCalledWith('Hello world', expect.any(Object));
    });

    test('uses broadcast option', async () => {
      await harness.invoke('sdk-start', 'Test', { broadcast: true });

      expect(mockBridgeObj.start).toHaveBeenCalledWith('Test', expect.objectContaining({
        broadcast: true,
      }));
    });

    test('uses workspace option', async () => {
      await harness.invoke('sdk-start', 'Test', { workspace: '/custom/path' });

      expect(mockBridgeObj.start).toHaveBeenCalledWith('Test', expect.objectContaining({
        workspace: '/custom/path',
      }));
    });

    test('defaults to cwd for workspace', async () => {
      await harness.invoke('sdk-start', 'Test', {});

      expect(mockBridgeObj.start).toHaveBeenCalledWith('Test', expect.objectContaining({
        workspace: process.cwd(),
      }));
    });

    test('handles start error', async () => {
      mockBridgeObj.start.mockImplementation(() => {
        throw new Error('Start failed');
      });

      const result = await harness.invoke('sdk-start', 'Test', {});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Start failed');
    });
  });

  describe('sdk-stop', () => {
    test('stops SDK', async () => {
      const result = await harness.invoke('sdk-stop');

      expect(result.success).toBe(true);
      expect(mockBridgeObj.stop).toHaveBeenCalled();
    });
  });

  describe('sdk-write', () => {
    test('writes input to SDK', async () => {
      const result = await harness.invoke('sdk-write', 'user input');

      expect(result.success).toBe(true);
      expect(mockBridgeObj.write).toHaveBeenCalledWith('user input');
    });
  });

  describe('sdk-status', () => {
    test('returns inactive status', async () => {
      mockBridgeObj.isActive.mockReturnValue(false);
      mockBridgeObj.getSessions.mockReturnValue([]);

      const result = await harness.invoke('sdk-status');

      expect(result.active).toBe(false);
      expect(result.sessions).toEqual([]);
    });

    test('returns active status with sessions', async () => {
      mockBridgeObj.isActive.mockReturnValue(true);
      mockBridgeObj.getSessions.mockReturnValue([
        { paneId: '1', status: 'running' },
        { paneId: '2', status: 'idle' },
      ]);

      const result = await harness.invoke('sdk-status');

      expect(result.active).toBe(true);
      expect(result.sessions.length).toBe(2);
    });
  });

  describe('sdk-broadcast', () => {
    test('broadcasts to all agents when active', async () => {
      mockBridgeObj.isActive.mockReturnValue(true);

      const result = await harness.invoke('sdk-broadcast', 'Broadcast message');

      expect(result.success).toBe(true);
      expect(mockBridgeObj.broadcast).toHaveBeenCalledWith('Broadcast message');
    });

    test('starts sessions if not active', async () => {
      mockBridgeObj.isActive.mockReturnValue(false);
      mockBridgeObj.startSessions.mockResolvedValue({});

      await harness.invoke('sdk-broadcast', 'Test');

      expect(mockBridgeObj.startSessions).toHaveBeenCalled();
      expect(mockBridgeObj.broadcast).toHaveBeenCalledWith('Test');
    });

    test('handles broadcast error', async () => {
      mockBridgeObj.isActive.mockReturnValue(true);
      mockBridgeObj.broadcast.mockImplementation(() => {
        throw new Error('Broadcast failed');
      });

      const result = await harness.invoke('sdk-broadcast', 'Test');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Broadcast failed');
    });

    test('handles start sessions error', async () => {
      mockBridgeObj.isActive.mockReturnValue(false);
      mockBridgeObj.startSessions.mockRejectedValue(new Error('Start failed'));

      const result = await harness.invoke('sdk-broadcast', 'Test');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Start failed');
    });

    test('returns failure when SDK bridge does not accept broadcast', async () => {
      mockBridgeObj.isActive.mockReturnValue(true);
      mockBridgeObj.broadcast.mockReturnValue(false);

      const result = await harness.invoke('sdk-broadcast', 'Test');

      expect(result.success).toBe(false);
      expect(result.error).toBe('SDK bridge did not accept broadcast');
    });
  });
});
