/**
 * Conflict Queue IPC Handler Tests
 * Target: Full coverage of conflict-queue-handlers.js
 */

const {
  createIpcHarness,
  createDefaultContext,
} = require('./helpers/ipc-harness');

const { registerConflictQueueHandlers } = require('../modules/ipc/conflict-queue-handlers');

describe('Conflict Queue Handlers', () => {
  let harness;
  let ctx;

  beforeEach(() => {
    harness = createIpcHarness();
    ctx = createDefaultContext({ ipcMain: harness.ipcMain });

    // Add missing watcher mocks
    ctx.watcher = {
      ...ctx.watcher,
      requestFileAccess: jest.fn(() => ({ granted: true, lockId: 'lock-123' })),
      releaseFileAccess: jest.fn(() => ({ success: true })),
      getConflictQueueStatus: jest.fn(() => ({ locks: 0, pending: 0 })),
      clearAllLocks: jest.fn(() => ({ success: true, cleared: 5 })),
    };

    registerConflictQueueHandlers(ctx);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('constructor validation', () => {
    test('throws when ctx is null', () => {
      expect(() => registerConflictQueueHandlers(null)).toThrow('registerConflictQueueHandlers requires ctx.ipcMain');
    });

    test('throws when ctx.ipcMain is missing', () => {
      expect(() => registerConflictQueueHandlers({})).toThrow('registerConflictQueueHandlers requires ctx.ipcMain');
    });
  });

  describe('request-file-access', () => {
    test('requests access to file', async () => {
      const result = await harness.invoke('request-file-access', '/path/to/file.js', '1', 'write');

      expect(ctx.watcher.requestFileAccess).toHaveBeenCalledWith('/path/to/file.js', '1', 'write');
      expect(result).toEqual({ granted: true, lockId: 'lock-123' });
    });

    test('returns error when watcher is null', async () => {
      ctx.watcher = null;

      const result = await harness.invoke('request-file-access', '/path/to/file.js', '1', 'write');

      expect(result).toEqual({ success: false, error: 'state watcher not available' });
    });

    test('returns error when requestFileAccess is not a function', async () => {
      ctx.watcher.requestFileAccess = undefined;

      const result = await harness.invoke('request-file-access', '/path/to/file.js', '1', 'write');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not available');
    });
  });

  describe('release-file-access', () => {
    test('releases file access', async () => {
      const result = await harness.invoke('release-file-access', '/path/to/file.js', '1');

      expect(ctx.watcher.releaseFileAccess).toHaveBeenCalledWith('/path/to/file.js', '1');
      expect(result).toEqual({ success: true });
    });

    test('returns error when watcher is null', async () => {
      ctx.watcher = null;

      const result = await harness.invoke('release-file-access', '/path/to/file.js', '1');

      expect(result).toEqual({ success: false, error: 'state watcher not available' });
    });

    test('returns error when releaseFileAccess is not a function', async () => {
      ctx.watcher.releaseFileAccess = undefined;

      const result = await harness.invoke('release-file-access', '/path/to/file.js', '1');

      expect(result.success).toBe(false);
    });
  });

  describe('get-conflict-queue-status', () => {
    test('returns conflict queue status', async () => {
      ctx.watcher.getConflictQueueStatus.mockReturnValue({
        locks: 3,
        pending: 2,
        files: ['/a.js', '/b.js'],
      });

      const result = await harness.invoke('get-conflict-queue-status');

      expect(ctx.watcher.getConflictQueueStatus).toHaveBeenCalled();
      expect(result).toEqual({
        locks: 3,
        pending: 2,
        files: ['/a.js', '/b.js'],
      });
    });

    test('returns error when watcher is null', async () => {
      ctx.watcher = null;

      const result = await harness.invoke('get-conflict-queue-status');

      expect(result).toEqual({ success: false, error: 'state watcher not available' });
    });

    test('returns error when getConflictQueueStatus is not a function', async () => {
      ctx.watcher.getConflictQueueStatus = undefined;

      const result = await harness.invoke('get-conflict-queue-status');

      expect(result.success).toBe(false);
    });
  });

  describe('clear-all-locks', () => {
    test('clears all locks', async () => {
      const result = await harness.invoke('clear-all-locks');

      expect(ctx.watcher.clearAllLocks).toHaveBeenCalled();
      expect(result).toEqual({ success: true, cleared: 5 });
    });

    test('returns error when watcher is null', async () => {
      ctx.watcher = null;

      const result = await harness.invoke('clear-all-locks');

      expect(result).toEqual({ success: false, error: 'state watcher not available' });
    });

    test('returns error when clearAllLocks is not a function', async () => {
      ctx.watcher.clearAllLocks = undefined;

      const result = await harness.invoke('clear-all-locks');

      expect(result.success).toBe(false);
    });
  });
});
