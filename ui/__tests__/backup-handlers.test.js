/**
 * Backup IPC Handler Tests
 * Target: Full coverage of backup-handlers.js
 */

const {
  createIpcHarness,
  createDefaultContext,
} = require('./helpers/ipc-harness');

// Mock backup-manager module
jest.mock('../modules/backup-manager', () => ({
  createBackupManager: jest.fn(),
}));

// Mock config
jest.mock('../config', () => require('./helpers/mock-config').mockWorkspaceOnly);

const backupModule = require('../modules/backup-manager');
const { registerBackupHandlers } = require('../modules/ipc/backup-handlers');

describe('Backup Handlers', () => {
  let harness;
  let ctx;
  let mockBackupManager;

  beforeEach(() => {
    jest.clearAllMocks();
    harness = createIpcHarness();
    ctx = createDefaultContext({ ipcMain: harness.ipcMain });

    // Create mock backup manager
    mockBackupManager = {
      init: jest.fn(),
      listBackups: jest.fn(() => [
        { id: 'backup-1', timestamp: '2026-01-30T10:00:00Z', files: 5 },
        { id: 'backup-2', timestamp: '2026-01-29T10:00:00Z', files: 3 },
      ]),
      createBackup: jest.fn(() => ({ success: true, id: 'backup-3', files: 10 })),
      restoreBackup: jest.fn(() => ({ success: true, restored: 5 })),
      deleteBackup: jest.fn(() => ({ success: true })),
      getConfig: jest.fn(() => ({ maxBackups: 10, autoBackup: true })),
      updateConfig: jest.fn((patch) => ({ maxBackups: 10, ...patch })),
      pruneBackups: jest.fn(() => 2),
    };

    backupModule.createBackupManager.mockReturnValue(mockBackupManager);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('registration', () => {
    test('throws when ctx is null', () => {
      expect(() => registerBackupHandlers(null)).toThrow('requires ctx.ipcMain');
    });

    test('throws when ctx.ipcMain is missing', () => {
      expect(() => registerBackupHandlers({})).toThrow('requires ctx.ipcMain');
    });

    test('creates backup manager if not present', () => {
      registerBackupHandlers(ctx);

      expect(backupModule.createBackupManager).toHaveBeenCalled();
      expect(mockBackupManager.init).toHaveBeenCalled();
    });

    test('uses existing backup manager if present', () => {
      ctx.backupManager = mockBackupManager;

      registerBackupHandlers(ctx);

      expect(backupModule.createBackupManager).not.toHaveBeenCalled();
    });
  });

  describe('backup-list', () => {
    beforeEach(() => {
      registerBackupHandlers(ctx);
    });

    test('returns list of backups', async () => {
      const result = await harness.invoke('backup-list');

      expect(result.success).toBe(true);
      expect(result.backups.length).toBe(2);
      expect(result.backups[0].id).toBe('backup-1');
    });
  });

  describe('backup-create', () => {
    beforeEach(() => {
      registerBackupHandlers(ctx);
    });

    test('creates backup with options', async () => {
      const result = await harness.invoke('backup-create', { label: 'test' });

      expect(result.success).toBe(true);
      expect(result.id).toBe('backup-3');
      expect(mockBackupManager.createBackup).toHaveBeenCalledWith({ label: 'test' });
    });

    test('creates backup with default options', async () => {
      const result = await harness.invoke('backup-create');

      expect(result.success).toBe(true);
      expect(mockBackupManager.createBackup).toHaveBeenCalledWith({});
    });
  });

  describe('backup-restore', () => {
    beforeEach(() => {
      registerBackupHandlers(ctx);
    });

    test('restores backup', async () => {
      const result = await harness.invoke('backup-restore', 'backup-1', { force: true });

      expect(result.success).toBe(true);
      expect(result.restored).toBe(5);
      expect(mockBackupManager.restoreBackup).toHaveBeenCalledWith('backup-1', { force: true });
    });

    test('returns error when backupId missing', async () => {
      const result = await harness.invoke('backup-restore', null);

      expect(result.success).toBe(false);
      expect(result.error).toBe('backupId required');
    });

    test('converts numeric backupId to string', async () => {
      await harness.invoke('backup-restore', 123, {});

      expect(mockBackupManager.restoreBackup).toHaveBeenCalledWith('123', {});
    });
  });

  describe('backup-delete', () => {
    beforeEach(() => {
      registerBackupHandlers(ctx);
    });

    test('deletes backup', async () => {
      const result = await harness.invoke('backup-delete', 'backup-1');

      expect(result.success).toBe(true);
      expect(mockBackupManager.deleteBackup).toHaveBeenCalledWith('backup-1');
    });

    test('returns error when backupId missing', async () => {
      const result = await harness.invoke('backup-delete', null);

      expect(result.success).toBe(false);
      expect(result.error).toBe('backupId required');
    });
  });

  describe('backup-get-config', () => {
    beforeEach(() => {
      registerBackupHandlers(ctx);
    });

    test('returns backup config', async () => {
      const result = await harness.invoke('backup-get-config');

      expect(result.success).toBe(true);
      expect(result.config.maxBackups).toBe(10);
      expect(result.config.autoBackup).toBe(true);
    });
  });

  describe('backup-update-config', () => {
    beforeEach(() => {
      registerBackupHandlers(ctx);
    });

    test('updates backup config', async () => {
      const result = await harness.invoke('backup-update-config', { autoBackup: false });

      expect(result.success).toBe(true);
      expect(mockBackupManager.updateConfig).toHaveBeenCalledWith({ autoBackup: false });
    });

    test('updates with empty patch', async () => {
      const result = await harness.invoke('backup-update-config');

      expect(result.success).toBe(true);
      expect(mockBackupManager.updateConfig).toHaveBeenCalledWith({});
    });
  });

  describe('backup-prune', () => {
    beforeEach(() => {
      registerBackupHandlers(ctx);
    });

    test('prunes old backups', async () => {
      const result = await harness.invoke('backup-prune');

      expect(result.success).toBe(true);
      expect(result.removed).toBe(2);
    });
  });
});
