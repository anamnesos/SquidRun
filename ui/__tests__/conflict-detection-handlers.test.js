/**
 * Conflict Detection IPC Handler Tests
 * Target: Full coverage of conflict-detection-handlers.js
 */

const {
  createIpcHarness,
  createDefaultContext,
} = require('./helpers/ipc-harness');

const { registerConflictDetectionHandlers } = require('../modules/ipc/conflict-detection-handlers');

describe('Conflict Detection Handlers', () => {
  let harness;
  let ctx;

  beforeEach(() => {
    harness = createIpcHarness();
    ctx = createDefaultContext({ ipcMain: harness.ipcMain });

    // Add missing watcher mocks
    ctx.watcher = {
      ...ctx.watcher,
      getLastConflicts: jest.fn(() => []),
      checkFileConflicts: jest.fn(() => ({ conflicts: [], count: 0 })),
    };

    registerConflictDetectionHandlers(ctx);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('get-file-conflicts', () => {
    test('returns last conflicts from watcher', async () => {
      const conflicts = [
        { file: 'test.js', panes: ['1', '2'], timestamp: Date.now() },
      ];
      ctx.watcher.getLastConflicts.mockReturnValue(conflicts);

      const result = await harness.invoke('get-file-conflicts');

      expect(ctx.watcher.getLastConflicts).toHaveBeenCalled();
      expect(result).toEqual(conflicts);
    });

    test('returns empty array when no conflicts', async () => {
      const result = await harness.invoke('get-file-conflicts');

      expect(result).toEqual([]);
    });
  });

  describe('check-file-conflicts', () => {
    test('checks for file conflicts', async () => {
      const checkResult = {
        conflicts: [{ file: 'main.js', panes: ['1', '3'] }],
        count: 1,
      };
      ctx.watcher.checkFileConflicts.mockReturnValue(checkResult);

      const result = await harness.invoke('check-file-conflicts');

      expect(ctx.watcher.checkFileConflicts).toHaveBeenCalled();
      expect(result).toEqual(checkResult);
    });

    test('returns empty result when no conflicts detected', async () => {
      const result = await harness.invoke('check-file-conflicts');

      expect(result).toEqual({ conflicts: [], count: 0 });
    });
  });
});
