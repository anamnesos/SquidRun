/**
 * Checkpoint IPC Handler Tests
 * Target: Full coverage of checkpoint-handlers.js
 */

const {
  createIpcHarness,
  createDefaultContext,
} = require('./helpers/ipc-harness');

// Mock fs
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  mkdirSync: jest.fn(),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  readdirSync: jest.fn(),
  rmSync: jest.fn(),
}));

jest.mock('crypto', () => {
  const actual = jest.requireActual('crypto');
  return {
    ...actual,
    createHash: jest.fn((algorithm) => actual.createHash(algorithm)),
  };
});

// Mock logger
jest.mock('../modules/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
}));

const fs = require('fs');
const { registerCheckpointHandlers } = require('../modules/ipc/checkpoint-handlers');

describe('Checkpoint Handlers', () => {
  let harness;
  let ctx;

  beforeEach(() => {
    jest.clearAllMocks();
    harness = createIpcHarness();
    ctx = createDefaultContext({ ipcMain: harness.ipcMain });
    ctx.WORKSPACE_PATH = '/test/workspace';
    ctx.mainWindow.isDestroyed = jest.fn(() => false);

    // Default: rollback dir exists
    fs.existsSync.mockReturnValue(true);
    fs.readdirSync.mockReturnValue([]);
    fs.mkdirSync.mockImplementation(() => {});
    fs.readFileSync.mockReturnValue('');
    fs.writeFileSync.mockImplementation(() => {});
    fs.rmSync.mockImplementation(() => {});

    registerCheckpointHandlers(ctx);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('registration', () => {
    test('throws if ctx is missing', () => {
      expect(() => registerCheckpointHandlers(null)).toThrow('requires ctx.ipcMain');
    });

    test('throws if ipcMain is missing', () => {
      expect(() => registerCheckpointHandlers({})).toThrow('requires ctx.ipcMain');
    });
  });

  describe('create-checkpoint', () => {
    test('creates checkpoint with files', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('file content');
      fs.readdirSync.mockReturnValue([]);

      const result = await harness.invoke('create-checkpoint', ['/test/file1.js', '/test/file2.js'], 'Test checkpoint');

      expect(result.success).toBe(true);
      expect(result.checkpointId).toMatch(/^cp-\d+$/);
      expect(result.files).toBe(2);
      expect(fs.mkdirSync).toHaveBeenCalled();
      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    test('uses default label when not provided', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('content');
      fs.readdirSync.mockReturnValue([]);

      const result = await harness.invoke('create-checkpoint', ['/test/file.js']);

      expect(result.success).toBe(true);
    });

    test('skips non-existent files', async () => {
      fs.existsSync.mockImplementation(path => !path.includes('missing'));
      fs.readFileSync.mockReturnValue('content');
      fs.readdirSync.mockReturnValue([]);

      const result = await harness.invoke('create-checkpoint', ['/test/exists.js', '/test/missing.js']);

      expect(result.files).toBe(1);
    });

    test('limits checkpoints to MAX_CHECKPOINTS', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('content');
      fs.readdirSync.mockReturnValue([
        'cp-1', 'cp-2', 'cp-3', 'cp-4', 'cp-5',
        'cp-6', 'cp-7', 'cp-8', 'cp-9', 'cp-10', 'cp-11',
      ]);

      await harness.invoke('create-checkpoint', ['/test/file.js']);

      expect(fs.rmSync).toHaveBeenCalled();
    });

    test('returns error when rollback dir unavailable', async () => {
      fs.existsSync.mockReturnValue(false);
      fs.mkdirSync.mockImplementation(() => {
        throw new Error('Permission denied');
      });

      const result = await harness.invoke('create-checkpoint', ['/test/file.js']);

      expect(result.success).toBe(false);
      expect(result.error).toContain('unavailable');
    });

    test('handles file read error', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockImplementation(() => {
        throw new Error('Read failed');
      });
      fs.readdirSync.mockReturnValue([]);

      const result = await harness.invoke('create-checkpoint', ['/test/file.js']);

      expect(result.success).toBe(false);
    });

    test('stores unique backup paths for same basenames from different directories', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('file content');
      fs.readdirSync.mockReturnValue([]);

      const result = await harness.invoke('create-checkpoint', ['/test/a/config.json', '/test/b/config.json']);

      expect(result.success).toBe(true);
      const manifestWrite = fs.writeFileSync.mock.calls.find(([filePath]) => String(filePath).includes('manifest.json'));
      expect(manifestWrite).toBeDefined();
      const manifest = JSON.parse(manifestWrite[1]);
      expect(manifest.files).toHaveLength(2);
      expect(new Set(manifest.files.map((file) => file.backup)).size).toBe(2);
    });
  });

  describe('list-checkpoints', () => {
    test('returns empty list when no checkpoints', async () => {
      fs.readdirSync.mockReturnValue([]);

      const result = await harness.invoke('list-checkpoints');

      expect(result.success).toBe(true);
      expect(result.checkpoints).toEqual([]);
    });

    test('returns checkpoint summaries', async () => {
      fs.readdirSync.mockReturnValue(['cp-123', 'cp-456']);
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockImplementation(path => {
        if (path.includes('cp-123')) {
          return JSON.stringify({
            id: 'cp-123',
            label: 'First',
            createdAt: '2026-01-01T10:00:00Z',
            files: [{ original: '/test/a.js' }],
          });
        }
        return JSON.stringify({
          id: 'cp-456',
          label: 'Second',
          createdAt: '2026-01-02T10:00:00Z',
          files: [{ original: '/test/b.js' }, { original: '/test/c.js' }],
        });
      });

      const result = await harness.invoke('list-checkpoints');

      expect(result.checkpoints.length).toBe(2);
      expect(result.checkpoints[0].id).toBe('cp-456'); // Sorted by date desc
      expect(result.checkpoints[0].fileCount).toBe(2);
    });

    test('filters non-checkpoint directories', async () => {
      fs.readdirSync.mockReturnValue(['cp-123', 'other-dir', '.hidden']);
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({
        id: 'cp-123',
        label: 'Test',
        createdAt: '2026-01-01',
        files: [],
      }));

      const result = await harness.invoke('list-checkpoints');

      expect(result.checkpoints.length).toBe(1);
    });

    test('handles missing manifest', async () => {
      fs.readdirSync.mockReturnValue(['cp-123']);
      // Rollback dir exists, but manifest does not
      fs.existsSync.mockImplementation(path => {
        if (path.includes('manifest')) return false;
        return true; // rollback dir exists
      });

      const result = await harness.invoke('list-checkpoints');

      expect(result.checkpoints).toEqual([]);
    });
  });

  describe('get-checkpoint-diff', () => {
    test('returns diff for checkpoint files', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockImplementation(path => {
        if (path.includes('manifest')) {
          return JSON.stringify({
            id: 'cp-123',
            files: [
              { original: '/test/file.js', backup: '/rollbacks/cp-123/file.js' },
            ],
          });
        }
        if (path.includes('backup') || path.includes('cp-123')) {
          return 'old content';
        }
        return 'new content';
      });

      const result = await harness.invoke('get-checkpoint-diff', 'cp-123');

      expect(result.success).toBe(true);
      expect(result.diffs.length).toBe(1);
      expect(result.diffs[0].hasChanges).toBe(true);
    });

    test('returns error when checkpoint not found', async () => {
      // Rollback dir exists, but specific manifest does not
      fs.existsSync.mockImplementation(path => {
        if (path.includes('manifest')) return false;
        return true;
      });

      const result = await harness.invoke('get-checkpoint-diff', 'cp-unknown');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    test('rejects invalid checkpoint IDs', async () => {
      const result = await harness.invoke('get-checkpoint-diff', '../bad');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid checkpoint ID');
    });

    test('handles missing backup file', async () => {
      fs.existsSync.mockImplementation(path => {
        // Backup file doesn't exist - check this FIRST
        if (path.includes('file.js') && path.includes('cp-123')) return false;
        // Manifest exists
        if (path.includes('manifest')) return true;
        // Original file exists
        if (path.includes('/test/file')) return true;
        // Everything else exists (rollback dir)
        return true;
      });
      fs.readFileSync.mockImplementation(path => {
        if (path.includes('manifest')) {
          return JSON.stringify({
            id: 'cp-123',
            files: [{ original: '/test/file.js', backup: '/rollbacks/cp-123/file.js' }],
          });
        }
        return 'current content';
      });

      const result = await harness.invoke('get-checkpoint-diff', 'cp-123');

      expect(result.success).toBe(true);
      expect(result.diffs.length).toBe(1);
      expect(result.diffs[0].backupSize).toBe(0);
    });
  });

  describe('rollback-checkpoint / apply-rollback', () => {
    test('restores files from checkpoint', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockImplementation(path => {
        if (path.includes('manifest')) {
          return JSON.stringify({
            id: 'cp-123',
            files: [
              { original: '/test/file.js', backup: '/rollbacks/cp-123/file.js' },
            ],
          });
        }
        return 'backup content';
      });

      const result = await harness.invoke('rollback-checkpoint', 'cp-123');

      expect(result.success).toBe(true);
      expect(result.filesRestored).toBe(1);
      expect(result.restored).toContain('/test/file.js');
      expect(fs.writeFileSync).toHaveBeenCalledWith('/test/file.js', 'backup content', 'utf-8');
    });

    test('apply-rollback works same as rollback-checkpoint', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({
        id: 'cp-123',
        files: [],
      }));

      const result = await harness.invoke('apply-rollback', 'cp-123');

      expect(result.success).toBe(true);
    });

    test('sends rollback-complete event', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockImplementation(path => {
        if (path.includes('manifest')) {
          return JSON.stringify({
            id: 'cp-123',
            files: [{ original: '/test/f.js', backup: '/b.js' }],
          });
        }
        return 'content';
      });

      await harness.invoke('rollback-checkpoint', 'cp-123');

      expect(ctx.mainWindow.webContents.send).toHaveBeenCalledWith('rollback-complete', expect.any(Object));
    });

    test('returns error when checkpoint not found', async () => {
      // Rollback dir exists, but manifest does not
      fs.existsSync.mockImplementation(path => {
        if (path.includes('manifest')) return false;
        return true;
      });

      const result = await harness.invoke('rollback-checkpoint', 'cp-unknown');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    test('rejects invalid checkpoint ID for rollback', async () => {
      const result = await harness.invoke('rollback-checkpoint', '../bad');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid checkpoint ID');
    });

    test('handles destroyed mainWindow', async () => {
      ctx.mainWindow.isDestroyed.mockReturnValue(true);
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({ id: 'cp-1', files: [] }));

      const result = await harness.invoke('rollback-checkpoint', 'cp-1');

      expect(result.success).toBe(true);
      expect(ctx.mainWindow.webContents.send).not.toHaveBeenCalled();
    });
  });

  describe('delete-checkpoint', () => {
    test('deletes checkpoint directory', async () => {
      fs.existsSync.mockReturnValue(true);

      const result = await harness.invoke('delete-checkpoint', 'cp-123');

      expect(result.success).toBe(true);
      expect(fs.rmSync).toHaveBeenCalledWith(
        expect.stringContaining('cp-123'),
        { recursive: true, force: true }
      );
    });

    test('returns error when checkpoint not found', async () => {
      // Rollback dir exists, but specific checkpoint dir does not
      fs.existsSync.mockImplementation(path => {
        if (path.includes('cp-unknown')) return false;
        return true; // rollback dir exists
      });

      const result = await harness.invoke('delete-checkpoint', 'cp-unknown');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    test('rejects invalid checkpoint ID for delete', async () => {
      const result = await harness.invoke('delete-checkpoint', '..\\bad');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid checkpoint ID');
    });

    test('handles delete error', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.rmSync.mockImplementation(() => {
        throw new Error('Delete failed');
      });

      const result = await harness.invoke('delete-checkpoint', 'cp-123');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Delete failed');
    });
  });

  describe('edge cases for uncovered lines', () => {
    test('list-checkpoints returns error when mkdirSync fails', async () => {
      // ensureRollbackDir() fails because mkdirSync throws
      fs.existsSync.mockReturnValue(false);
      fs.mkdirSync.mockImplementation(() => {
        throw new Error('Cannot create rollback dir');
      });

      const result = await harness.invoke('list-checkpoints');

      expect(result.success).toBe(false);
      expect(result.error).toContain('unavailable');
    });

    test('list-checkpoints returns empty when rollback dir does not exist after ensure', async () => {
      // First check for workspace - true
      // Second check for rollback dir - false (but ensureRollbackDir succeeded)
      let callCount = 0;
      fs.existsSync.mockImplementation(() => {
        callCount++;
        // First call checks workspace for ensureRollbackDir
        if (callCount === 1) return true;
        // Second call checks ROLLBACK_DIR exists - return false to trigger line 94
        return false;
      });

      const result = await harness.invoke('list-checkpoints');

      expect(result.success).toBe(true);
      expect(result.checkpoints).toEqual([]);
    });

    test('list-checkpoints handles readdirSync error', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readdirSync.mockImplementation(() => {
        throw new Error('Cannot read directory');
      });

      const result = await harness.invoke('list-checkpoints');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Cannot read directory');
    });

    test('get-checkpoint-diff returns error when rollback dir unavailable', async () => {
      // Make ensureRollbackDir fail
      fs.existsSync.mockReturnValue(false);
      fs.mkdirSync.mockImplementation(() => {
        throw new Error('Cannot create dir');
      });

      const result = await harness.invoke('get-checkpoint-diff', 'cp-123');

      expect(result.success).toBe(false);
      expect(result.error).toContain('unavailable');
    });

    test('rollback-checkpoint returns error when rollback dir unavailable', async () => {
      fs.existsSync.mockReturnValue(false);
      fs.mkdirSync.mockImplementation(() => {
        throw new Error('Cannot create');
      });

      const result = await harness.invoke('rollback-checkpoint', 'cp-123');

      expect(result.success).toBe(false);
      expect(result.error).toContain('unavailable');
    });

    test('delete-checkpoint returns error when rollback dir unavailable', async () => {
      fs.existsSync.mockReturnValue(false);
      fs.mkdirSync.mockImplementation(() => {
        throw new Error('Cannot create');
      });

      const result = await harness.invoke('delete-checkpoint', 'cp-123');

      expect(result.success).toBe(false);
      expect(result.error).toContain('unavailable');
    });

    test('create-checkpoint returns error when rollback dir unavailable', async () => {
      fs.existsSync.mockReturnValue(false);
      fs.mkdirSync.mockImplementation(() => {
        throw new Error('Cannot create');
      });

      const result = await harness.invoke('create-checkpoint', ['/test/file.js'], 'test');

      expect(result.success).toBe(false);
      expect(result.error).toContain('unavailable');
    });
  });
});
