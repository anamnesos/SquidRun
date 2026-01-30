/**
 * Security IPC Handlers - Task #25
 *
 * Channels:
 * - security-get-status: Get security system status
 * - security-create-session: Create a new session
 * - security-validate-session: Validate a session token
 * - security-invalidate-session: Invalidate a session
 * - security-check-permission: Check if session has permission
 * - security-store-credential: Store an encrypted credential
 * - security-get-credential: Retrieve a credential
 * - security-delete-credential: Delete a credential
 * - security-list-credentials: List all credential keys
 * - security-encrypt: Encrypt arbitrary data
 * - security-decrypt: Decrypt data
 * - security-hash-password: Hash a password
 * - security-verify-password: Verify a password against hash
 * - security-get-roles: Get available roles
 * - security-assign-role: Assign role to user
 * - security-get-audit-log: Get security audit log
 * - security-mask-data: Mask sensitive data in object
 * - security-sanitize-input: Sanitize user input
 * - security-cleanup: Run security cleanup
 * - security-export: Export security state
 */

const path = require('path');

function registerSecurityHandlers(ctx) {
  const { ipcMain, WORKSPACE_PATH } = ctx;
  if (!ipcMain || !WORKSPACE_PATH) return;

  // Lazy load security manager
  let securityModule = null;
  let securityManager = null;

  function getSecurityManager() {
    if (!securityModule) {
      securityModule = require('../security/security-manager');
    }
    if (!securityManager) {
      securityManager = securityModule.getSecurityManager({
        dataPath: path.join(WORKSPACE_PATH, 'memory'),
      });
    }
    return securityManager;
  }

  /**
   * Get security system status
   */
  ipcMain.handle('security-get-status', async () => {
    try {
      const sm = getSecurityManager();
      const exported = sm.export();

      return {
        success: true,
        status: {
          initialized: true,
          sessionCount: exported.sessionCount,
          roleCount: Object.keys(exported.roles).length,
          auditLogCount: exported.auditLogCount,
          credentialCount: sm.listCredentials().length,
        },
      };
    } catch (err) {
      console.error('[Security] Get status error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Create a new session
   */
  ipcMain.handle('security-create-session', async (event, payload = {}) => {
    const { userId, role, ttl, metadata } = payload;

    if (!userId) {
      return { success: false, error: 'userId required' };
    }

    try {
      const sm = getSecurityManager();
      const session = sm.createSession(userId, { role, ttl, metadata });

      // Notify renderer of new session
      if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
        ctx.mainWindow.webContents.send('security-session-created', {
          sessionId: session.sessionId,
          userId,
          expiresAt: session.expiresAt,
        });
      }

      return { success: true, session };
    } catch (err) {
      console.error('[Security] Create session error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Validate a session token
   */
  ipcMain.handle('security-validate-session', async (event, payload = {}) => {
    const { sessionId, token } = payload;

    if (!sessionId || !token) {
      return { success: false, error: 'sessionId and token required' };
    }

    try {
      const sm = getSecurityManager();
      const session = sm.validateSession(sessionId, token);

      return {
        success: true,
        valid: !!session,
        session: session || null,
      };
    } catch (err) {
      console.error('[Security] Validate session error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Invalidate a session
   */
  ipcMain.handle('security-invalidate-session', async (event, payload = {}) => {
    const { sessionId } = payload;

    if (!sessionId) {
      return { success: false, error: 'sessionId required' };
    }

    try {
      const sm = getSecurityManager();
      const result = sm.invalidateSession(sessionId);

      if (result && ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
        ctx.mainWindow.webContents.send('security-session-invalidated', { sessionId });
      }

      return { success: true, invalidated: result };
    } catch (err) {
      console.error('[Security] Invalidate session error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Check if session has permission
   */
  ipcMain.handle('security-check-permission', async (event, payload = {}) => {
    const { sessionId, resource, level } = payload;

    if (!sessionId || !resource || level === undefined) {
      return { success: false, error: 'sessionId, resource, and level required' };
    }

    try {
      const sm = getSecurityManager();
      const hasPermission = sm.sessionHasPermission(sessionId, resource, level);

      return { success: true, hasPermission };
    } catch (err) {
      console.error('[Security] Check permission error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Store an encrypted credential
   */
  ipcMain.handle('security-store-credential', async (event, payload = {}) => {
    const { key, value, metadata } = payload;

    if (!key || !value) {
      return { success: false, error: 'key and value required' };
    }

    try {
      const sm = getSecurityManager();
      sm.storeCredential(key, value, metadata);

      return { success: true, key };
    } catch (err) {
      console.error('[Security] Store credential error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Retrieve a credential
   */
  ipcMain.handle('security-get-credential', async (event, payload = {}) => {
    const { key } = payload;

    if (!key) {
      return { success: false, error: 'key required' };
    }

    try {
      const sm = getSecurityManager();
      const value = sm.getCredential(key);

      return {
        success: true,
        found: value !== null,
        value: value || undefined,
      };
    } catch (err) {
      console.error('[Security] Get credential error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Delete a credential
   */
  ipcMain.handle('security-delete-credential', async (event, payload = {}) => {
    const { key } = payload;

    if (!key) {
      return { success: false, error: 'key required' };
    }

    try {
      const sm = getSecurityManager();
      const deleted = sm.deleteCredential(key);

      return { success: true, deleted };
    } catch (err) {
      console.error('[Security] Delete credential error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * List all credential keys
   */
  ipcMain.handle('security-list-credentials', async () => {
    try {
      const sm = getSecurityManager();
      const credentials = sm.listCredentials();

      return { success: true, credentials };
    } catch (err) {
      console.error('[Security] List credentials error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Encrypt arbitrary data
   */
  ipcMain.handle('security-encrypt', async (event, payload = {}) => {
    const { data } = payload;

    if (!data) {
      return { success: false, error: 'data required' };
    }

    try {
      const sm = getSecurityManager();
      const encrypted = sm.encryptString(typeof data === 'string' ? data : JSON.stringify(data));

      return { success: true, encrypted };
    } catch (err) {
      console.error('[Security] Encrypt error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Decrypt data
   */
  ipcMain.handle('security-decrypt', async (event, payload = {}) => {
    const { encrypted } = payload;

    if (!encrypted) {
      return { success: false, error: 'encrypted data required' };
    }

    try {
      const sm = getSecurityManager();
      const decrypted = sm.decryptString(encrypted);

      return { success: true, decrypted };
    } catch (err) {
      console.error('[Security] Decrypt error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Hash a password
   */
  ipcMain.handle('security-hash-password', async (event, payload = {}) => {
    const { password } = payload;

    if (!password) {
      return { success: false, error: 'password required' };
    }

    try {
      const sm = getSecurityManager();
      const hash = sm.hashPassword(password);

      return { success: true, hash };
    } catch (err) {
      console.error('[Security] Hash password error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Verify a password against hash
   */
  ipcMain.handle('security-verify-password', async (event, payload = {}) => {
    const { password, hash } = payload;

    if (!password || !hash) {
      return { success: false, error: 'password and hash required' };
    }

    try {
      const sm = getSecurityManager();
      const valid = sm.verifyPassword(password, hash);

      return { success: true, valid };
    } catch (err) {
      console.error('[Security] Verify password error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Get available roles
   */
  ipcMain.handle('security-get-roles', async () => {
    try {
      const sm = getSecurityManager();
      const roles = sm.getRoles();

      // Also get permission level constants
      if (!securityModule) {
        securityModule = require('../security/security-manager');
      }

      return {
        success: true,
        roles,
        permissionLevels: securityModule.PERMISSION_LEVELS,
        resourceTypes: securityModule.RESOURCE_TYPES,
      };
    } catch (err) {
      console.error('[Security] Get roles error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Assign role to user
   */
  ipcMain.handle('security-assign-role', async (event, payload = {}) => {
    const { userId, roleId } = payload;

    if (!userId || !roleId) {
      return { success: false, error: 'userId and roleId required' };
    }

    try {
      const sm = getSecurityManager();
      sm.assignRole(userId, roleId);

      return { success: true, userId, roleId };
    } catch (err) {
      console.error('[Security] Assign role error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Get security audit log
   */
  ipcMain.handle('security-get-audit-log', async (event, payload = {}) => {
    const { action, since, limit } = payload;

    try {
      const sm = getSecurityManager();
      const entries = sm.getAuditLog({ action, since, limit: limit || 100 });

      return { success: true, entries, total: entries.length };
    } catch (err) {
      console.error('[Security] Get audit log error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Mask sensitive data in object
   */
  ipcMain.handle('security-mask-data', async (event, payload = {}) => {
    const { data, sensitiveKeys } = payload;

    if (!data) {
      return { success: false, error: 'data required' };
    }

    try {
      const sm = getSecurityManager();
      const masked = sm.maskSensitiveData(data, sensitiveKeys);

      return { success: true, masked };
    } catch (err) {
      console.error('[Security] Mask data error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Sanitize user input
   */
  ipcMain.handle('security-sanitize-input', async (event, payload = {}) => {
    const { input, options } = payload;

    if (input === undefined) {
      return { success: false, error: 'input required' };
    }

    try {
      const sm = getSecurityManager();
      const sanitized = sm.sanitizeInput(input, options || {});

      return { success: true, sanitized };
    } catch (err) {
      console.error('[Security] Sanitize input error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Run security cleanup
   */
  ipcMain.handle('security-cleanup', async () => {
    try {
      const sm = getSecurityManager();
      const result = sm.cleanup();

      return { success: true, ...result };
    } catch (err) {
      console.error('[Security] Cleanup error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Export security state
   */
  ipcMain.handle('security-export', async () => {
    try {
      const sm = getSecurityManager();
      const data = sm.export();

      return { success: true, data };
    } catch (err) {
      console.error('[Security] Export error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Generate a secure token
   */
  ipcMain.handle('security-generate-token', async (event, payload = {}) => {
    const { length } = payload;

    try {
      const sm = getSecurityManager();
      const token = sm.generateToken(length || 32);

      return { success: true, token };
    } catch (err) {
      console.error('[Security] Generate token error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Get user sessions
   */
  ipcMain.handle('security-get-user-sessions', async (event, payload = {}) => {
    const { userId } = payload;

    if (!userId) {
      return { success: false, error: 'userId required' };
    }

    try {
      const sm = getSecurityManager();
      const sessions = sm.getUserSessions(userId);

      return { success: true, sessions };
    } catch (err) {
      console.error('[Security] Get user sessions error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Extend session expiration
   */
  ipcMain.handle('security-extend-session', async (event, payload = {}) => {
    const { sessionId, ttl } = payload;

    if (!sessionId) {
      return { success: false, error: 'sessionId required' };
    }

    try {
      const sm = getSecurityManager();
      const result = sm.extendSession(sessionId, ttl);

      return { success: true, extended: result };
    } catch (err) {
      console.error('[Security] Extend session error:', err);
      return { success: false, error: err.message };
    }
  });
}

module.exports = { registerSecurityHandlers };
