/**
 * Backup Manager Unit Tests
 * Direct tests for modules/backup-manager.js
 */

const path = require('path');

// Mock fs module
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  mkdirSync: jest.fn(),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  renameSync: jest.fn(),
  statSync: jest.fn(),
  readdirSync: jest.fn(),
  copyFileSync: jest.fn(),
  rmSync: jest.fn(),
}));

// Mock crypto
jest.mock('crypto', () => ({
  randomBytes: jest.fn(() => ({ toString: () => 'abc123' })),
  createHash: jest.fn(() => {
    let payload = '';
    const chain = {
      update: jest.fn((value) => {
        payload += String(value ?? '');
        return chain;
      }),
      digest: jest.fn(() => (payload || 'hash').padEnd(40, '0').slice(0, 40)),
    };
    return chain;
  }),
}));

// Mock logger
jest.mock('../modules/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
}));

const fs = require('fs');
const log = require('../modules/logger');
const { GLOBAL_STATE_ROOT } = require('../config');
const { createBackupManager } = require('../modules/backup-manager');

describe('Backup Manager', () => {
  let manager;
  const mockWorkspacePath = '/test/workspace';
  const mockRepoRoot = '/test';

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    // Default mock implementations
    fs.existsSync.mockReturnValue(false);
    fs.readFileSync.mockReturnValue('{}');
    fs.writeFileSync.mockImplementation(() => {});
    fs.renameSync.mockImplementation(() => {});
    fs.statSync.mockReturnValue({
      isDirectory: () => false,
      isFile: () => true,
      size: 100,
      mtime: new Date('2026-01-30'),
    });
    fs.readdirSync.mockReturnValue([]);

    manager = createBackupManager({
      workspacePath: mockWorkspacePath,
      repoRoot: mockRepoRoot,
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  describe('init', () => {
    test('creates backup directory and loads config', () => {
      manager.init();

      expect(fs.mkdirSync).toHaveBeenCalled();
      expect(fs.writeFileSync).toHaveBeenCalled(); // saveConfig
    });

    test('handles missing config file gracefully', () => {
      fs.existsSync.mockReturnValue(false);

      manager.init();

      const config = manager.getConfig();
      expect(config.enabled).toBe(true);
      expect(config.maxBackups).toBe(5);
    });
  });

  describe('getConfig', () => {
    test('returns copy of config', () => {
      manager.init();
      const config = manager.getConfig();

      expect(config.enabled).toBe(true);
      expect(config.intervalMinutes).toBe(60);
    });
  });

  describe('updateConfig', () => {
    test('updates config and restarts scheduler', () => {
      manager.init();

      const result = manager.updateConfig({ maxBackups: 50 });

      expect(result.maxBackups).toBe(50);
      expect(fs.writeFileSync).toHaveBeenCalled();
    });
  });

  describe('listBackups', () => {
    test('returns empty array when no backups', () => {
      fs.existsSync.mockImplementation(p => p.includes('backups'));
      fs.readFileSync.mockReturnValue(JSON.stringify({ backups: [] }));

      const result = manager.listBackups();

      expect(result).toEqual([]);
    });

    test('returns array of backup summaries', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({
        backups: [
          { id: 'backup-1', createdAt: '2026-01-30', name: 'Test' },
        ],
      }));

      const result = manager.listBackups();

      expect(result.length).toBe(1);
      expect(result[0].id).toBe('backup-1');
    });

    test('handles invalid index file', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('not valid json');

      const result = manager.listBackups();

      expect(result).toEqual([]);
      expect(log.warn).toHaveBeenCalled();
    });
  });

  describe('createBackup', () => {
    test('creates backup with files', () => {
      // Backup root doesn't exist yet, so mkdirSync will be called
      fs.existsSync.mockImplementation(p => {
        if (p.includes('backups') && !p.includes('-')) return false; // backup root doesn't exist
        if (p.includes('app-status.json')) return true;
        return false;
      });
      fs.readFileSync.mockReturnValue(JSON.stringify({ backups: [] }));
      fs.statSync.mockReturnValue({
        isDirectory: () => false,
        isFile: () => true,
        size: 50,
        mtime: new Date(),
      });
      fs.readdirSync.mockReturnValue([]);

      const result = manager.createBackup({ name: 'Test Backup' });

      expect(result.success).toBe(true);
      expect(result.backup.name).toBe('Test Backup');
      expect(fs.mkdirSync).toHaveBeenCalled();
    });

    test('logs activity when logActivity callback provided', () => {
      const logActivity = jest.fn();
      const mgr = createBackupManager({
        workspacePath: mockWorkspacePath,
        repoRoot: mockRepoRoot,
        logActivity,
      });

      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({ backups: [] }));
      fs.statSync.mockReturnValue({
        isDirectory: () => false,
        isFile: () => true,
        size: 100,
        mtime: new Date(),
      });

      mgr.createBackup();

      expect(logActivity).toHaveBeenCalledWith(
        'backup',
        null,
        expect.stringContaining('Backup created'),
        expect.any(Object)
      );
    });

    test('warns about missing include paths', () => {
      fs.existsSync.mockReturnValue(false);

      manager.createBackup({ includePaths: ['/missing/path'] });

      expect(log.warn).toHaveBeenCalledWith('Backup', expect.stringContaining('missing'));
    });

    test('skips paths outside repo root', () => {
      fs.existsSync.mockImplementation(p => p === '/outside/repo');
      fs.statSync.mockReturnValue({
        isDirectory: () => false,
        isFile: () => true,
        size: 100,
        mtime: new Date(),
      });

      // Force a path that resolves outside repo root
      const mgr = createBackupManager({
        workspacePath: mockWorkspacePath,
        repoRoot: '/test',
      });

      mgr.createBackup({ includePaths: ['/completely/outside'] });

      expect(log.warn).toHaveBeenCalledWith('Backup', expect.stringContaining('outside'));
    });

    test('copies directory contents recursively', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({ backups: [] }));

      // First call returns directory entries, subsequent calls return empty
      let readDirCallCount = 0;
      fs.readdirSync.mockImplementation(() => {
        readDirCallCount++;
        if (readDirCallCount === 1) {
          return [
            { name: 'file1.txt' },
          ];
        }
        return [];
      });

      fs.statSync.mockImplementation((p) => {
        // app-status.json is a file
        if (p.includes('app-status.json')) {
          return {
            isDirectory: () => false,
            isFile: () => true,
            size: 100,
            mtime: new Date(),
          };
        }
        // Default to file
        return {
          isDirectory: () => false,
          isFile: () => true,
          size: 100,
          mtime: new Date(),
        };
      });

      manager.createBackup();

      expect(fs.copyFileSync).toHaveBeenCalled();
    });

    test('allows backing up files under GLOBAL_STATE_ROOT', () => {
      const globalFile = path.join(GLOBAL_STATE_ROOT, 'app-status.json');
      fs.existsSync.mockImplementation((targetPath) => {
        const normalized = String(targetPath);
        if (normalized === globalFile) return true;
        if (normalized.includes('backups')) return true;
        return false;
      });
      fs.readFileSync.mockReturnValue(JSON.stringify({ backups: [] }));
      fs.statSync.mockReturnValue({
        isDirectory: () => false,
        isFile: () => true,
        size: 24,
        mtime: new Date(),
      });
      fs.readdirSync.mockReturnValue([]);

      const result = manager.createBackup({ includePaths: [globalFile] });

      expect(result.success).toBe(true);
      expect(fs.copyFileSync).toHaveBeenCalled();
      const metadataWrite = fs.writeFileSync.mock.calls.find((call) => String(call[0]).includes('backup.json.tmp'));
      expect(metadataWrite).toBeDefined();
      const metadata = JSON.parse(metadataWrite[1]);
      expect(metadata.records[0].relativePath).toContain('__global__/');
      expect(metadata.records[0].sourcePath).toBe(path.resolve(globalFile));
    });

    test('returns failure and skips index update when metadata write fails', () => {
      fs.existsSync.mockImplementation((targetPath) => {
        if (String(targetPath).includes('app-status.json')) return true;
        return false;
      });
      fs.readFileSync.mockReturnValue(JSON.stringify({ backups: [] }));
      fs.statSync.mockReturnValue({
        isDirectory: () => false,
        isFile: () => true,
        size: 50,
        mtime: new Date(),
      });
      fs.renameSync.mockImplementationOnce((fromPath, toPath) => {
        if (String(toPath).includes('backup.json')) {
          throw new Error('disk full');
        }
      });

      const result = manager.createBackup({ name: 'Fails metadata write' });

      expect(result).toEqual({
        success: false,
        error: 'backup_metadata_write_failed',
      });
      const indexWrites = fs.writeFileSync.mock.calls.filter(([targetPath]) =>
        String(targetPath).includes('backup-index.json.tmp')
      );
      expect(indexWrites.length).toBe(0);
      expect(log.warn).toHaveBeenCalledWith('Backup', expect.stringContaining('Aborting backup'));
    });
  });

  describe('restoreBackup', () => {
    test('restores files from backup', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockImplementation(p => {
        if (p.includes('backup.json')) {
          return JSON.stringify({
            id: 'backup-1',
            records: [
              { relativePath: 'file1.txt' },
              { relativePath: 'subdir/file2.txt' },
            ],
          });
        }
        return JSON.stringify({ backups: [] });
      });

      const result = manager.restoreBackup('backup-1', { skipRestorePoint: true });

      expect(result.success).toBe(true);
      expect(result.filesRestored).toBe(2);
      expect(fs.copyFileSync).toHaveBeenCalled();
    });

    test('restores global-state backup records to original absolute path', () => {
      const globalFile = path.join(GLOBAL_STATE_ROOT, 'app-status.json');
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockImplementation((targetPath) => {
        if (String(targetPath).includes('backup.json')) {
          return JSON.stringify({
            id: 'backup-1',
            records: [
              { relativePath: '__global__/abc/app-status.json', sourcePath: globalFile },
            ],
          });
        }
        return JSON.stringify({ backups: [] });
      });

      const result = manager.restoreBackup('backup-1', { skipRestorePoint: true });

      expect(result.success).toBe(true);
      expect(result.filesRestored).toBe(1);
      expect(result.restored[0]).toBe(path.resolve(globalFile));
      expect(fs.copyFileSync).toHaveBeenCalledWith(
        expect.stringContaining(path.join('__global__', 'abc', 'app-status.json')),
        path.resolve(globalFile)
      );
    });

    test('returns error for non-existent backup', () => {
      fs.existsSync.mockReturnValue(false);

      const result = manager.restoreBackup('nonexistent');

      expect(result.success).toBe(false);
      expect(result.error).toBe('backup_not_found');
    });

    test('creates restore point by default', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockImplementation(p => {
        if (p.includes('backup.json')) {
          return JSON.stringify({ id: 'backup-1', records: [] });
        }
        return JSON.stringify({ backups: [] });
      });

      manager.restoreBackup('backup-1');

      // Should have created a pre-restore backup
      expect(log.info).toHaveBeenCalledWith('Backup', expect.stringContaining('Created backup'));
    });

    test('supports dry run mode', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockImplementation(p => {
        if (p.includes('backup.json')) {
          return JSON.stringify({
            id: 'backup-1',
            records: [{ relativePath: 'file.txt' }],
          });
        }
        return JSON.stringify({ backups: [] });
      });

      const result = manager.restoreBackup('backup-1', { dryRun: true, skipRestorePoint: true });

      expect(result.success).toBe(true);
      expect(result.dryRun).toBe(true);
      expect(fs.copyFileSync).not.toHaveBeenCalled();
    });

    test('skips paths with directory traversal', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockImplementation(p => {
        if (p.includes('backup.json')) {
          return JSON.stringify({
            id: 'backup-1',
            records: [
              { relativePath: '../../../etc/passwd' },
              { relativePath: 'safe/file.txt' },
            ],
          });
        }
        return JSON.stringify({ backups: [] });
      });

      const result = manager.restoreBackup('backup-1', { skipRestorePoint: true });

      // Should only restore the safe file
      expect(result.filesRestored).toBe(1);
    });

    test('logs activity when logActivity callback provided', () => {
      const logActivity = jest.fn();
      const mgr = createBackupManager({
        workspacePath: mockWorkspacePath,
        repoRoot: mockRepoRoot,
        logActivity,
      });

      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockImplementation(p => {
        if (p.includes('backup.json')) {
          return JSON.stringify({ id: 'backup-1', records: [{ relativePath: 'file.txt' }] });
        }
        return JSON.stringify({ backups: [] });
      });

      mgr.restoreBackup('backup-1', { skipRestorePoint: true });

      expect(logActivity).toHaveBeenCalledWith(
        'backup',
        null,
        expect.stringContaining('restored'),
        expect.any(Object)
      );
    });
  });

  describe('deleteBackup', () => {
    test('deletes backup directory and updates index', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({
        backups: [{ id: 'backup-1' }, { id: 'backup-2' }],
      }));

      const result = manager.deleteBackup('backup-1');

      expect(result.success).toBe(true);
      expect(fs.rmSync).toHaveBeenCalledWith(
        expect.stringContaining('backup-1'),
        { recursive: true, force: true }
      );
    });

    test('returns error for non-existent backup', () => {
      fs.existsSync.mockReturnValue(false);

      const result = manager.deleteBackup('nonexistent');

      expect(result.success).toBe(false);
      expect(result.error).toBe('not_found');
    });
  });

  describe('pruneBackups', () => {
    test('enforces a maximum of 5 backups even when config is higher', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockImplementation(p => {
        if (p.includes('config')) {
          return JSON.stringify({ maxBackups: 20, maxAgeDays: 0 });
        }
        return JSON.stringify({
          backups: [
            { id: 'backup-1', createdAt: '2026-01-30' },
            { id: 'backup-2', createdAt: '2026-01-29' },
            { id: 'backup-3', createdAt: '2026-01-28' },
            { id: 'backup-4', createdAt: '2026-01-27' },
            { id: 'backup-5', createdAt: '2026-01-26' },
            { id: 'backup-6', createdAt: '2026-01-25' },
            { id: 'backup-7', createdAt: '2026-01-24' },
          ],
        });
      });

      const removed = manager.pruneBackups();

      expect(removed).toBe(2);
      expect(fs.rmSync).toHaveBeenCalledTimes(2);
    });

    test('removes backups exceeding maxBackups', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockImplementation(p => {
        if (p.includes('config')) {
          return JSON.stringify({ maxBackups: 2, maxAgeDays: 0 });
        }
        return JSON.stringify({
          backups: [
            { id: 'backup-1', createdAt: '2026-01-30' },
            { id: 'backup-2', createdAt: '2026-01-29' },
            { id: 'backup-3', createdAt: '2026-01-28' },
            { id: 'backup-4', createdAt: '2026-01-27' },
          ],
        });
      });

      const removed = manager.pruneBackups();

      expect(removed).toBe(2);
      expect(fs.rmSync).toHaveBeenCalledTimes(2);
      expect(log.info).toHaveBeenCalledWith('Backup', expect.stringContaining('Pruned'));
    });

    test('removes backups older than maxAgeDays', () => {
      const now = new Date('2026-01-30');
      jest.setSystemTime(now);

      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockImplementation(p => {
        if (p.includes('config')) {
          return JSON.stringify({ maxBackups: 100, maxAgeDays: 7 });
        }
        return JSON.stringify({
          backups: [
            { id: 'recent', createdAt: '2026-01-29T00:00:00Z' },
            { id: 'old', createdAt: '2026-01-01T00:00:00Z' },
          ],
        });
      });

      const removed = manager.pruneBackups();

      expect(removed).toBe(1);
      expect(fs.rmSync).toHaveBeenCalledWith(
        expect.stringContaining('old'),
        { recursive: true, force: true }
      );
    });

    test('returns 0 when nothing to prune', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockImplementation(p => {
        if (p.includes('config')) {
          return JSON.stringify({ maxBackups: 100, maxAgeDays: 365 });
        }
        return JSON.stringify({
          backups: [{ id: 'backup-1', createdAt: '2026-01-30' }],
        });
      });

      const removed = manager.pruneBackups();

      expect(removed).toBe(0);
    });
  });

  describe('scheduler', () => {
    test('restarts scheduler when config updated', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({
        enabled: true,
        intervalMinutes: 1,
        backups: [],
      }));

      manager.init();
      manager.updateConfig({ intervalMinutes: 5 });

      // Should clear and restart timer
      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    test('does not start scheduler when disabled', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({
        enabled: false,
        backups: [],
      }));

      manager.init();

      // Advance time - no backup should be created
      jest.advanceTimersByTime(3600000);

      // Only init writes, no scheduled backup writes
      const writeCalls = fs.writeFileSync.mock.calls.length;
      jest.advanceTimersByTime(3600000);
      expect(fs.writeFileSync.mock.calls.length).toBe(writeCalls);
    });

    test('handles scheduled backup errors gracefully', () => {
      // Start with valid config for init
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({
        enabled: true,
        intervalMinutes: 1,
        backups: [],
      }));

      manager.init();

      // Now make statSync throw to cause backup to fail
      fs.statSync.mockImplementation(() => {
        throw new Error('Disk error');
      });

      // Trigger scheduled backup
      jest.advanceTimersByTime(60001);

      expect(log.error).toHaveBeenCalledWith('Backup', expect.stringContaining('Scheduled backup failed'));
    });
  });

  describe('safeReadJson error handling', () => {
    test('logs warning and returns null on parse error', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('invalid { json');

      const result = manager.listBackups();

      expect(log.warn).toHaveBeenCalled();
      expect(result).toEqual([]);
    });
  });

  describe('safeWriteJson error handling', () => {
    test('logs error on write failure', () => {
      fs.writeFileSync.mockImplementation(() => {
        throw new Error('Disk full');
      });

      manager.init();

      expect(log.error).toHaveBeenCalledWith('Backup', expect.stringContaining('Failed to write'));
    });
  });

  describe('path matching', () => {
    test('excludes paths matching patterns', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({ backups: [] }));
      fs.readdirSync.mockReturnValue([]);
      fs.statSync.mockReturnValue({
        isDirectory: () => false,
        isFile: () => true,
        size: 100,
        mtime: new Date(),
      });

      // Simply verify excludePatterns are applied by checking backup creation
      const result = manager.createBackup();

      expect(result.success).toBe(true);
      // The default config excludes node_modules, .git etc.
      expect(result.backup.excludePatterns).toContain('node_modules');
      expect(result.backup.excludePatterns).toContain('.git');
    });

    test('matches wildcard patterns', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockImplementation(p => {
        if (p.includes('config')) {
          return JSON.stringify({
            excludePatterns: ['*.tmp', '*.log'],
            backups: [],
          });
        }
        return JSON.stringify({ backups: [] });
      });
      fs.readdirSync.mockReturnValue([]);
      fs.statSync.mockReturnValue({
        isDirectory: () => false,
        isFile: () => true,
        size: 100,
        mtime: new Date(),
      });

      const result = manager.createBackup();

      // Verify patterns are in the backup metadata
      expect(result.success).toBe(true);
    });
  });
});
