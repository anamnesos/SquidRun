/**
 * Friction Panel IPC Handler Tests
 * Target: Full coverage of friction-handlers.js
 */

const {
  createIpcHarness,
  createDefaultContext,
} = require('./helpers/ipc-harness');

// Mock fs
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  mkdirSync: jest.fn(),
  readdirSync: jest.fn(),
  statSync: jest.fn(),
  readFileSync: jest.fn(),
  unlinkSync: jest.fn(),
}));

const fs = require('fs');
const { registerFrictionHandlers } = require('../modules/ipc/friction-handlers');

describe('Friction Handlers', () => {
  let harness;
  let ctx;

  beforeEach(() => {
    jest.clearAllMocks();
    harness = createIpcHarness();
    ctx = createDefaultContext({ ipcMain: harness.ipcMain });
    ctx.FRICTION_DIR = '/test/friction';

    // Add watcher mocks for clear-friction (must be set before registerFrictionHandlers)
    ctx.watcher.readState = jest.fn(() => ({ friction_count: 5 }));
    ctx.watcher.writeState = jest.fn();

    registerFrictionHandlers(ctx);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('list-friction', () => {
    test('creates directory and returns empty list when dir does not exist', async () => {
      fs.existsSync.mockReturnValue(false);

      const result = await harness.invoke('list-friction');

      expect(fs.mkdirSync).toHaveBeenCalledWith('/test/friction', { recursive: true });
      expect(result).toEqual({ success: true, files: [] });
    });

    test('returns list of .md files sorted by modification time', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readdirSync.mockReturnValue(['old.md', 'new.md', 'other.txt']);
      fs.statSync.mockImplementation((path) => {
        if (path.includes('old.md')) {
          return { mtime: new Date('2026-01-01T10:00:00Z') };
        }
        if (path.includes('new.md')) {
          return { mtime: new Date('2026-01-02T10:00:00Z') };
        }
        return { mtime: new Date('2026-01-01T05:00:00Z') };
      });

      const result = await harness.invoke('list-friction');

      expect(result.success).toBe(true);
      expect(result.files.length).toBe(2); // Only .md files
      expect(result.files[0].name).toBe('new.md'); // Sorted newest first
      expect(result.files[1].name).toBe('old.md');
    });

    test('includes path and modified timestamp in file info', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readdirSync.mockReturnValue(['test.md']);
      fs.statSync.mockReturnValue({ mtime: new Date('2026-01-15T12:00:00Z') });

      const result = await harness.invoke('list-friction');

      expect(result.files[0]).toEqual({
        name: 'test.md',
        path: expect.stringContaining('test.md'),
        modified: '2026-01-15T12:00:00.000Z',
      });
    });

    test('filters out non-.md files', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readdirSync.mockReturnValue(['file.md', 'file.txt', 'file.json', 'file.js']);
      fs.statSync.mockReturnValue({ mtime: new Date() });

      const result = await harness.invoke('list-friction');

      expect(result.files.length).toBe(1);
      expect(result.files[0].name).toBe('file.md');
    });

    test('handles readdir error', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readdirSync.mockImplementation(() => {
        throw new Error('Read directory failed');
      });

      const result = await harness.invoke('list-friction');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Read directory failed');
    });

    test('handles statSync error', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readdirSync.mockReturnValue(['file.md']);
      fs.statSync.mockImplementation(() => {
        throw new Error('Stat failed');
      });

      const result = await harness.invoke('list-friction');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Stat failed');
    });
  });

  describe('read-friction', () => {
    test('returns file content when file exists', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('# Friction Report\n\nSome content here');

      const result = await harness.invoke('read-friction', 'report.md');

      expect(result).toEqual({
        success: true,
        content: '# Friction Report\n\nSome content here',
      });
    });

    test('returns error when file does not exist', async () => {
      fs.existsSync.mockReturnValue(false);

      const result = await harness.invoke('read-friction', 'missing.md');

      expect(result).toEqual({ success: false, error: 'File not found' });
    });

    test('handles read error', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockImplementation(() => {
        throw new Error('Permission denied');
      });

      const result = await harness.invoke('read-friction', 'locked.md');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Permission denied');
    });

    test('constructs correct file path', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('content');

      await harness.invoke('read-friction', 'subdir/file.md');

      expect(fs.readFileSync).toHaveBeenCalledWith(
        expect.stringContaining('subdir'),
        'utf-8'
      );
    });
  });

  describe('delete-friction', () => {
    test('deletes file when it exists', async () => {
      fs.existsSync.mockReturnValue(true);

      const result = await harness.invoke('delete-friction', 'old-report.md');

      expect(fs.unlinkSync).toHaveBeenCalled();
      expect(result).toEqual({ success: true });
    });

    test('succeeds silently when file does not exist', async () => {
      fs.existsSync.mockReturnValue(false);

      const result = await harness.invoke('delete-friction', 'missing.md');

      expect(fs.unlinkSync).not.toHaveBeenCalled();
      expect(result).toEqual({ success: true });
    });

    test('handles delete error', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.unlinkSync.mockImplementation(() => {
        throw new Error('Cannot delete');
      });

      const result = await harness.invoke('delete-friction', 'locked.md');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Cannot delete');
    });
  });

  describe('clear-friction', () => {
    test('deletes all .md files in friction directory', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readdirSync.mockReturnValue(['file1.md', 'file2.md', 'file3.txt']);
      fs.unlinkSync.mockReturnValue(undefined);

      const result = await harness.invoke('clear-friction');

      expect(result.success).toBe(true);
      expect(fs.unlinkSync).toHaveBeenCalledTimes(2); // Only .md files
    });

    test('resets friction_count in state', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readdirSync.mockReturnValue(['file.md']);
      fs.unlinkSync.mockReturnValue(undefined);

      const result = await harness.invoke('clear-friction');

      expect(result.success).toBe(true);
      expect(ctx.watcher.readState).toHaveBeenCalled();
      expect(ctx.watcher.writeState).toHaveBeenCalledWith(
        expect.objectContaining({ friction_count: 0 })
      );
    });

    test('succeeds when directory does not exist', async () => {
      fs.existsSync.mockReturnValue(false);

      const result = await harness.invoke('clear-friction');

      // Still calls readState and writeState
      expect(ctx.watcher.readState).toHaveBeenCalled();
      expect(result).toEqual({ success: true });
    });

    test('handles delete error', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readdirSync.mockReturnValue(['file.md']);
      fs.unlinkSync.mockImplementation(() => {
        throw new Error('Delete failed');
      });

      const result = await harness.invoke('clear-friction');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Delete failed');
    });

    test('handles state write error', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readdirSync.mockReturnValue([]);
      ctx.watcher.writeState.mockImplementation(() => {
        throw new Error('State write failed');
      });

      const result = await harness.invoke('clear-friction');

      expect(result.success).toBe(false);
      expect(result.error).toBe('State write failed');
    });
  });
});
