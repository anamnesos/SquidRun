/**
 * Security IPC Handler Tests
 * Target: Full coverage of security-handlers.js
 */

const {
  createIpcHarness,
  createDefaultContext,
} = require('./helpers/ipc-harness');

// Mock security-manager module
jest.mock('../modules/security/security-manager', () => ({
  getSecurityManager: jest.fn(),
  PERMISSION_LEVELS: { NONE: 0, READ: 1, WRITE: 2, EXECUTE: 3, ADMIN: 4 },
  RESOURCE_TYPES: { SETTINGS: 'settings', CREDENTIALS: 'credentials' },
}));

const { registerSecurityHandlers } = require('../modules/ipc/security-handlers');
const securityModule = require('../modules/security/security-manager');

describe('Security Handlers', () => {
  let harness;
  let ctx;
  let mockSecurityManager;

  beforeEach(() => {
    jest.clearAllMocks();
    harness = createIpcHarness();
    ctx = createDefaultContext({ ipcMain: harness.ipcMain });
    ctx.WORKSPACE_PATH = '/test/workspace';
    ctx.mainWindow.isDestroyed = jest.fn(() => false);

    // Create mock security manager
    mockSecurityManager = {
      export: jest.fn(() => ({ sessionCount: 5, roles: { admin: {} }, auditLogCount: 10 })),
      listCredentials: jest.fn(() => ['key1', 'key2']),
      createSession: jest.fn(() => ({ sessionId: 'sess-123', token: 'tok-456', expiresAt: '2026-01-30T12:00:00Z' })),
      validateSession: jest.fn(() => ({ userId: 'user1', role: 'admin' })),
      invalidateSession: jest.fn(() => true),
      sessionHasPermission: jest.fn(() => true),
      storeCredential: jest.fn(),
      getCredential: jest.fn(() => 'secret-value'),
      deleteCredential: jest.fn(() => true),
      encryptString: jest.fn(() => 'encrypted-data'),
      decryptString: jest.fn(() => 'decrypted-data'),
      hashPassword: jest.fn(() => 'hashed-password'),
      verifyPassword: jest.fn(() => true),
      getRoles: jest.fn(() => ({ admin: {}, viewer: {} })),
      assignRole: jest.fn(),
      getAuditLog: jest.fn(() => [{ action: 'login', timestamp: '2026-01-30' }]),
      maskSensitiveData: jest.fn((data) => ({ ...data, password: '***' })),
      sanitizeInput: jest.fn((input) => input.replace(/<script>/g, '')),
      cleanup: jest.fn(() => ({ sessionsRemoved: 2 })),
      generateToken: jest.fn(() => 'random-token-xyz'),
      getUserSessions: jest.fn(() => [{ sessionId: 'sess-1' }]),
      extendSession: jest.fn(() => true),
    };

    securityModule.getSecurityManager.mockReturnValue(mockSecurityManager);

    registerSecurityHandlers(ctx);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('registration', () => {
    test('does nothing when ipcMain is missing', () => {
      expect(() => registerSecurityHandlers({})).not.toThrow();
    });

    test('does nothing when WORKSPACE_PATH is missing', () => {
      const newHarness = createIpcHarness();
      expect(() => registerSecurityHandlers({ ipcMain: newHarness.ipcMain })).not.toThrow();
    });
  });

  describe('security-get-status', () => {
    test('returns security status', async () => {
      const result = await harness.invoke('security-get-status');

      expect(result.success).toBe(true);
      expect(result.status.initialized).toBe(true);
      expect(result.status.sessionCount).toBe(5);
      expect(result.status.roleCount).toBe(1);
      expect(result.status.credentialCount).toBe(2);
    });

    test('handles error', async () => {
      mockSecurityManager.export.mockImplementation(() => { throw new Error('Export failed'); });

      const result = await harness.invoke('security-get-status');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Export failed');
    });
  });

  describe('security-create-session', () => {
    test('creates session with userId', async () => {
      const result = await harness.invoke('security-create-session', {
        userId: 'user1',
        role: 'admin',
        ttl: 3600,
      });

      expect(result.success).toBe(true);
      expect(result.session.sessionId).toBe('sess-123');
      expect(ctx.mainWindow.webContents.send).toHaveBeenCalledWith('security-session-created', expect.any(Object));
    });

    test('returns error when userId missing', async () => {
      const result = await harness.invoke('security-create-session', {});

      expect(result.success).toBe(false);
      expect(result.error).toBe('userId required');
    });

    test('handles error', async () => {
      mockSecurityManager.createSession.mockImplementation(() => { throw new Error('Create failed'); });

      const result = await harness.invoke('security-create-session', { userId: 'user1' });

      expect(result.success).toBe(false);
    });
  });

  describe('security-validate-session', () => {
    test('validates session', async () => {
      const result = await harness.invoke('security-validate-session', {
        sessionId: 'sess-123',
        token: 'tok-456',
      });

      expect(result.success).toBe(true);
      expect(result.valid).toBe(true);
    });

    test('returns error when missing params', async () => {
      const result = await harness.invoke('security-validate-session', { sessionId: 'sess-123' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('sessionId and token required');
    });

    test('handles error', async () => {
      mockSecurityManager.validateSession.mockImplementation(() => { throw new Error('Validate failed'); });

      const result = await harness.invoke('security-validate-session', { sessionId: 'sess', token: 'tok' });

      expect(result.success).toBe(false);
    });
  });

  describe('security-invalidate-session', () => {
    test('invalidates session', async () => {
      const result = await harness.invoke('security-invalidate-session', { sessionId: 'sess-123' });

      expect(result.success).toBe(true);
      expect(result.invalidated).toBe(true);
      expect(ctx.mainWindow.webContents.send).toHaveBeenCalledWith('security-session-invalidated', { sessionId: 'sess-123' });
    });

    test('returns error when sessionId missing', async () => {
      const result = await harness.invoke('security-invalidate-session', {});

      expect(result.success).toBe(false);
      expect(result.error).toBe('sessionId required');
    });

    test('handles error', async () => {
      mockSecurityManager.invalidateSession.mockImplementation(() => { throw new Error('Invalidate failed'); });

      const result = await harness.invoke('security-invalidate-session', { sessionId: 'sess' });

      expect(result.success).toBe(false);
    });
  });

  describe('security-check-permission', () => {
    test('checks permission', async () => {
      const result = await harness.invoke('security-check-permission', {
        sessionId: 'sess-123',
        resource: 'settings',
        level: 2,
      });

      expect(result.success).toBe(true);
      expect(result.hasPermission).toBe(true);
    });

    test('returns error when params missing', async () => {
      const result = await harness.invoke('security-check-permission', { sessionId: 'sess' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('sessionId, resource, and level required');
    });

    test('handles error', async () => {
      mockSecurityManager.sessionHasPermission.mockImplementation(() => { throw new Error('Check failed'); });

      const result = await harness.invoke('security-check-permission', { sessionId: 's', resource: 'r', level: 1 });

      expect(result.success).toBe(false);
    });
  });

  describe('security-store-credential', () => {
    test('stores credential', async () => {
      const result = await harness.invoke('security-store-credential', {
        key: 'api-key',
        value: 'secret123',
      });

      expect(result.success).toBe(true);
      expect(result.key).toBe('api-key');
    });

    test('returns error when params missing', async () => {
      const result = await harness.invoke('security-store-credential', { key: 'k' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('key and value required');
    });

    test('handles error', async () => {
      mockSecurityManager.storeCredential.mockImplementation(() => { throw new Error('Store failed'); });

      const result = await harness.invoke('security-store-credential', { key: 'k', value: 'v' });

      expect(result.success).toBe(false);
    });
  });

  describe('security-get-credential', () => {
    test('gets credential', async () => {
      const result = await harness.invoke('security-get-credential', { key: 'api-key' });

      expect(result.success).toBe(true);
      expect(result.found).toBe(true);
      expect(result.value).toBe('secret-value');
    });

    test('returns error when key missing', async () => {
      const result = await harness.invoke('security-get-credential', {});

      expect(result.success).toBe(false);
      expect(result.error).toBe('key required');
    });

    test('handles error', async () => {
      mockSecurityManager.getCredential.mockImplementation(() => { throw new Error('Get failed'); });

      const result = await harness.invoke('security-get-credential', { key: 'k' });

      expect(result.success).toBe(false);
    });
  });

  describe('security-delete-credential', () => {
    test('deletes credential', async () => {
      const result = await harness.invoke('security-delete-credential', { key: 'api-key' });

      expect(result.success).toBe(true);
      expect(result.deleted).toBe(true);
    });

    test('returns error when key missing', async () => {
      const result = await harness.invoke('security-delete-credential', {});

      expect(result.success).toBe(false);
    });

    test('handles error', async () => {
      mockSecurityManager.deleteCredential.mockImplementation(() => { throw new Error('Delete failed'); });

      const result = await harness.invoke('security-delete-credential', { key: 'k' });

      expect(result.success).toBe(false);
    });
  });

  describe('security-list-credentials', () => {
    test('lists credentials', async () => {
      const result = await harness.invoke('security-list-credentials');

      expect(result.success).toBe(true);
      expect(result.credentials).toEqual(['key1', 'key2']);
    });

    test('handles error', async () => {
      mockSecurityManager.listCredentials.mockImplementation(() => { throw new Error('List failed'); });

      const result = await harness.invoke('security-list-credentials');

      expect(result.success).toBe(false);
    });
  });

  describe('security-encrypt', () => {
    test('encrypts data', async () => {
      const result = await harness.invoke('security-encrypt', { data: 'secret' });

      expect(result.success).toBe(true);
      expect(result.encrypted).toBe('encrypted-data');
    });

    test('encrypts object data', async () => {
      const result = await harness.invoke('security-encrypt', { data: { key: 'value' } });

      expect(result.success).toBe(true);
    });

    test('returns error when data missing', async () => {
      const result = await harness.invoke('security-encrypt', {});

      expect(result.success).toBe(false);
    });

    test('handles error', async () => {
      mockSecurityManager.encryptString.mockImplementation(() => { throw new Error('Encrypt failed'); });

      const result = await harness.invoke('security-encrypt', { data: 'x' });

      expect(result.success).toBe(false);
    });
  });

  describe('security-decrypt', () => {
    test('decrypts data', async () => {
      const result = await harness.invoke('security-decrypt', { encrypted: 'enc-data' });

      expect(result.success).toBe(true);
      expect(result.decrypted).toBe('decrypted-data');
    });

    test('returns error when encrypted missing', async () => {
      const result = await harness.invoke('security-decrypt', {});

      expect(result.success).toBe(false);
    });

    test('handles error', async () => {
      mockSecurityManager.decryptString.mockImplementation(() => { throw new Error('Decrypt failed'); });

      const result = await harness.invoke('security-decrypt', { encrypted: 'x' });

      expect(result.success).toBe(false);
    });
  });

  describe('security-hash-password', () => {
    test('hashes password', async () => {
      const result = await harness.invoke('security-hash-password', { password: 'secret' });

      expect(result.success).toBe(true);
      expect(result.hash).toBe('hashed-password');
    });

    test('returns error when password missing', async () => {
      const result = await harness.invoke('security-hash-password', {});

      expect(result.success).toBe(false);
    });

    test('handles error', async () => {
      mockSecurityManager.hashPassword.mockImplementation(() => { throw new Error('Hash failed'); });

      const result = await harness.invoke('security-hash-password', { password: 'x' });

      expect(result.success).toBe(false);
    });
  });

  describe('security-verify-password', () => {
    test('verifies password', async () => {
      const result = await harness.invoke('security-verify-password', {
        password: 'secret',
        hash: 'hashed',
      });

      expect(result.success).toBe(true);
      expect(result.valid).toBe(true);
    });

    test('returns error when params missing', async () => {
      const result = await harness.invoke('security-verify-password', { password: 'x' });

      expect(result.success).toBe(false);
    });

    test('handles error', async () => {
      mockSecurityManager.verifyPassword.mockImplementation(() => { throw new Error('Verify failed'); });

      const result = await harness.invoke('security-verify-password', { password: 'x', hash: 'y' });

      expect(result.success).toBe(false);
    });
  });

  describe('security-get-roles', () => {
    test('gets roles', async () => {
      const result = await harness.invoke('security-get-roles');

      expect(result.success).toBe(true);
      expect(result.roles).toEqual({ admin: {}, viewer: {} });
      expect(result.permissionLevels).toBeDefined();
    });

    test('handles error', async () => {
      mockSecurityManager.getRoles.mockImplementation(() => { throw new Error('Get roles failed'); });

      const result = await harness.invoke('security-get-roles');

      expect(result.success).toBe(false);
    });
  });

  describe('security-assign-role', () => {
    test('assigns role', async () => {
      const result = await harness.invoke('security-assign-role', {
        userId: 'user1',
        roleId: 'admin',
      });

      expect(result.success).toBe(true);
      expect(result.userId).toBe('user1');
    });

    test('returns error when params missing', async () => {
      const result = await harness.invoke('security-assign-role', { userId: 'u' });

      expect(result.success).toBe(false);
    });

    test('handles error', async () => {
      mockSecurityManager.assignRole.mockImplementation(() => { throw new Error('Assign failed'); });

      const result = await harness.invoke('security-assign-role', { userId: 'u', roleId: 'r' });

      expect(result.success).toBe(false);
    });
  });

  describe('security-get-audit-log', () => {
    test('gets audit log', async () => {
      const result = await harness.invoke('security-get-audit-log', { limit: 50 });

      expect(result.success).toBe(true);
      expect(result.entries.length).toBe(1);
    });

    test('handles error', async () => {
      mockSecurityManager.getAuditLog.mockImplementation(() => { throw new Error('Get audit failed'); });

      const result = await harness.invoke('security-get-audit-log', {});

      expect(result.success).toBe(false);
    });
  });

  describe('security-mask-data', () => {
    test('masks sensitive data', async () => {
      const result = await harness.invoke('security-mask-data', {
        data: { password: 'secret' },
        sensitiveKeys: ['password'],
      });

      expect(result.success).toBe(true);
      expect(result.masked.password).toBe('***');
    });

    test('returns error when data missing', async () => {
      const result = await harness.invoke('security-mask-data', {});

      expect(result.success).toBe(false);
    });

    test('handles error', async () => {
      mockSecurityManager.maskSensitiveData.mockImplementation(() => { throw new Error('Mask failed'); });

      const result = await harness.invoke('security-mask-data', { data: {} });

      expect(result.success).toBe(false);
    });
  });

  describe('security-sanitize-input', () => {
    test('sanitizes input', async () => {
      const result = await harness.invoke('security-sanitize-input', { input: '<script>alert(1)</script>' });

      expect(result.success).toBe(true);
    });

    test('returns error when input missing', async () => {
      const result = await harness.invoke('security-sanitize-input', {});

      expect(result.success).toBe(false);
    });

    test('handles error', async () => {
      mockSecurityManager.sanitizeInput.mockImplementation(() => { throw new Error('Sanitize failed'); });

      const result = await harness.invoke('security-sanitize-input', { input: 'x' });

      expect(result.success).toBe(false);
    });
  });

  describe('security-cleanup', () => {
    test('runs cleanup', async () => {
      const result = await harness.invoke('security-cleanup');

      expect(result.success).toBe(true);
      expect(result.sessionsRemoved).toBe(2);
    });

    test('handles error', async () => {
      mockSecurityManager.cleanup.mockImplementation(() => { throw new Error('Cleanup failed'); });

      const result = await harness.invoke('security-cleanup');

      expect(result.success).toBe(false);
    });
  });

  describe('security-export', () => {
    test('exports security state', async () => {
      const result = await harness.invoke('security-export');

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
    });

    test('handles error', async () => {
      mockSecurityManager.export.mockImplementation(() => { throw new Error('Export failed'); });

      const result = await harness.invoke('security-export');

      expect(result.success).toBe(false);
    });
  });

  describe('security-generate-token', () => {
    test('generates token', async () => {
      const result = await harness.invoke('security-generate-token', { length: 64 });

      expect(result.success).toBe(true);
      expect(result.token).toBe('random-token-xyz');
    });

    test('uses default length', async () => {
      const result = await harness.invoke('security-generate-token', {});

      expect(result.success).toBe(true);
    });

    test('handles error', async () => {
      mockSecurityManager.generateToken.mockImplementation(() => { throw new Error('Generate failed'); });

      const result = await harness.invoke('security-generate-token', {});

      expect(result.success).toBe(false);
    });
  });

  describe('security-get-user-sessions', () => {
    test('gets user sessions', async () => {
      const result = await harness.invoke('security-get-user-sessions', { userId: 'user1' });

      expect(result.success).toBe(true);
      expect(result.sessions.length).toBe(1);
    });

    test('returns error when userId missing', async () => {
      const result = await harness.invoke('security-get-user-sessions', {});

      expect(result.success).toBe(false);
    });

    test('handles error', async () => {
      mockSecurityManager.getUserSessions.mockImplementation(() => { throw new Error('Get sessions failed'); });

      const result = await harness.invoke('security-get-user-sessions', { userId: 'u' });

      expect(result.success).toBe(false);
    });
  });

  describe('security-extend-session', () => {
    test('extends session', async () => {
      const result = await harness.invoke('security-extend-session', { sessionId: 'sess-123', ttl: 3600 });

      expect(result.success).toBe(true);
      expect(result.extended).toBe(true);
    });

    test('returns error when sessionId missing', async () => {
      const result = await harness.invoke('security-extend-session', {});

      expect(result.success).toBe(false);
    });

    test('handles error', async () => {
      mockSecurityManager.extendSession.mockImplementation(() => { throw new Error('Extend failed'); });

      const result = await harness.invoke('security-extend-session', { sessionId: 's' });

      expect(result.success).toBe(false);
    });
  });
});
