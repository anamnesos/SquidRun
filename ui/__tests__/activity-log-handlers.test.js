/**
 * Activity Log IPC Handler Tests
 * Target: Full coverage of activity-log-handlers.js
 */

const {
  createIpcHarness,
  createDefaultContext,
  createDepsMock,
} = require('./helpers/ipc-harness');

// Mock the logger
jest.mock('../modules/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
}));

const { registerActivityLogHandlers } = require('../modules/ipc/activity-log-handlers');

describe('Activity Log Handlers', () => {
  let harness;
  let ctx;
  let deps;

  beforeEach(() => {
    harness = createIpcHarness();
    ctx = createDefaultContext({ ipcMain: harness.ipcMain });
    deps = createDepsMock();
    registerActivityLogHandlers(ctx, deps);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('constructor validation', () => {
    test('throws when ctx is null', () => {
      expect(() => registerActivityLogHandlers(null)).toThrow('registerActivityLogHandlers requires ctx.ipcMain');
    });

    test('throws when ctx.ipcMain is missing', () => {
      expect(() => registerActivityLogHandlers({})).toThrow('registerActivityLogHandlers requires ctx.ipcMain');
    });
  });

  describe('get-activity-log', () => {
    test('returns activity log entries', async () => {
      const mockEntries = [
        { type: 'spawn', paneId: '1', message: 'Spawned' },
        { type: 'message', paneId: '2', message: 'Received' },
      ];
      deps.getActivityLog.mockReturnValue(mockEntries);

      const result = await harness.invoke('get-activity-log');

      expect(deps.getActivityLog).toHaveBeenCalled();
      expect(result).toEqual({
        success: true,
        entries: mockEntries,
        total: 2,
      });
    });

    test('passes filter to getActivityLog', async () => {
      deps.getActivityLog.mockReturnValue([]);
      const filter = { type: 'error', paneId: '1' };

      await harness.invoke('get-activity-log', filter);

      expect(deps.getActivityLog).toHaveBeenCalledWith(filter);
    });

    test('returns empty array when no entries', async () => {
      deps.getActivityLog.mockReturnValue([]);

      const result = await harness.invoke('get-activity-log');

      expect(result.entries).toEqual([]);
      expect(result.total).toBe(0);
    });

    test('returns error when getActivityLog is not a function', async () => {
      // Create new harness without getActivityLog
      const newHarness = createIpcHarness();
      const newCtx = createDefaultContext({ ipcMain: newHarness.ipcMain });
      registerActivityLogHandlers(newCtx, {});

      const result = await newHarness.invoke('get-activity-log');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not available');
      expect(result.entries).toEqual([]);
      expect(result.total).toBe(0);
    });
  });

  describe('clear-activity-log', () => {
    test('clears the activity log', async () => {
      const result = await harness.invoke('clear-activity-log');

      expect(deps.clearActivityLog).toHaveBeenCalled();
      expect(result).toEqual({ success: true });
    });

    test('returns error when clearActivityLog is not a function', async () => {
      const newHarness = createIpcHarness();
      const newCtx = createDefaultContext({ ipcMain: newHarness.ipcMain });
      registerActivityLogHandlers(newCtx, {});

      const result = await newHarness.invoke('clear-activity-log');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not available');
    });
  });

  describe('save-activity-log', () => {
    test('saves the activity log', async () => {
      const result = await harness.invoke('save-activity-log');

      expect(deps.saveActivityLog).toHaveBeenCalled();
      expect(result).toEqual({ success: true });
    });

    test('returns error when saveActivityLog is not a function', async () => {
      const newHarness = createIpcHarness();
      const newCtx = createDefaultContext({ ipcMain: newHarness.ipcMain });
      registerActivityLogHandlers(newCtx, {});

      const result = await newHarness.invoke('save-activity-log');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not available');
    });
  });

  describe('log-activity', () => {
    test('logs activity entry', async () => {
      const result = await harness.invoke('log-activity', 'spawn', '1', 'Agent spawned', { pid: 1234 });

      expect(deps.logActivity).toHaveBeenCalledWith('spawn', '1', 'Agent spawned', { pid: 1234 });
      expect(result).toEqual({ success: true });
    });

    test('uses empty details when not provided', async () => {
      await harness.invoke('log-activity', 'message', '2', 'Test message');

      expect(deps.logActivity).toHaveBeenCalledWith('message', '2', 'Test message', {});
    });

    test('returns error when logActivity is not a function', async () => {
      const newHarness = createIpcHarness();
      const newCtx = createDefaultContext({ ipcMain: newHarness.ipcMain });
      registerActivityLogHandlers(newCtx, {});

      const result = await newHarness.invoke('log-activity', 'error', '1', 'Error');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not available');
    });
  });
});
