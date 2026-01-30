/**
 * Security Manager - Task #25
 *
 * Provides encryption, authentication, and permission management for Hivemind.
 *
 * Features:
 * - AES-256-GCM encryption for sensitive data
 * - Secure key derivation using PBKDF2
 * - Session-based authentication
 * - Role-based permission system
 * - Secure credential storage
 * - Audit logging for security events
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Encryption constants
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 16;  // 128 bits for GCM
const SALT_LENGTH = 32;
const TAG_LENGTH = 16;
const PBKDF2_ITERATIONS = 100000;
const PBKDF2_DIGEST = 'sha512';

// Permission levels
const PERMISSION_LEVELS = {
  NONE: 0,
  READ: 1,
  WRITE: 2,
  EXECUTE: 3,
  ADMIN: 4,
};

// Resource types
const RESOURCE_TYPES = {
  SETTINGS: 'settings',
  CREDENTIALS: 'credentials',
  AGENTS: 'agents',
  TERMINALS: 'terminals',
  FILES: 'files',
  SYSTEM: 'system',
};

// Default role definitions
const DEFAULT_ROLES = {
  viewer: {
    name: 'Viewer',
    permissions: {
      [RESOURCE_TYPES.SETTINGS]: PERMISSION_LEVELS.READ,
      [RESOURCE_TYPES.AGENTS]: PERMISSION_LEVELS.READ,
      [RESOURCE_TYPES.TERMINALS]: PERMISSION_LEVELS.READ,
      [RESOURCE_TYPES.FILES]: PERMISSION_LEVELS.READ,
    },
  },
  operator: {
    name: 'Operator',
    permissions: {
      [RESOURCE_TYPES.SETTINGS]: PERMISSION_LEVELS.READ,
      [RESOURCE_TYPES.AGENTS]: PERMISSION_LEVELS.EXECUTE,
      [RESOURCE_TYPES.TERMINALS]: PERMISSION_LEVELS.EXECUTE,
      [RESOURCE_TYPES.FILES]: PERMISSION_LEVELS.WRITE,
    },
  },
  admin: {
    name: 'Administrator',
    permissions: {
      [RESOURCE_TYPES.SETTINGS]: PERMISSION_LEVELS.ADMIN,
      [RESOURCE_TYPES.CREDENTIALS]: PERMISSION_LEVELS.ADMIN,
      [RESOURCE_TYPES.AGENTS]: PERMISSION_LEVELS.ADMIN,
      [RESOURCE_TYPES.TERMINALS]: PERMISSION_LEVELS.ADMIN,
      [RESOURCE_TYPES.FILES]: PERMISSION_LEVELS.ADMIN,
      [RESOURCE_TYPES.SYSTEM]: PERMISSION_LEVELS.ADMIN,
    },
  },
};

/**
 * SecurityManager class
 * Manages encryption, authentication, and permissions
 */
class SecurityManager {
  constructor(options = {}) {
    this.dataPath = options.dataPath || path.join(process.cwd(), 'workspace', 'memory');
    this.credentialsFile = path.join(this.dataPath, '_credentials.enc');
    this.sessionsFile = path.join(this.dataPath, '_sessions.json');
    this.auditFile = path.join(this.dataPath, '_security-audit.json');

    // Master key (derived from passphrase or machine-specific)
    this.masterKey = null;
    this.masterKeySalt = null;

    // Active sessions
    this.sessions = new Map();

    // Roles and permissions
    this.roles = { ...DEFAULT_ROLES };
    this.userRoles = new Map(); // userId -> roleId

    // Audit log (in-memory buffer)
    this.auditLog = [];
    this.auditLogMaxSize = options.auditLogMaxSize || 1000;

    // Initialize
    this._initialize();
  }

  /**
   * Initialize security manager
   */
  _initialize() {
    // Ensure data directory exists
    if (!fs.existsSync(this.dataPath)) {
      fs.mkdirSync(this.dataPath, { recursive: true });
    }

    // Load or generate master key salt
    this._initMasterKey();

    // Load existing sessions
    this._loadSessions();

    // Load audit log
    this._loadAuditLog();

    console.log('[SecurityManager] Initialized');
  }

  /**
   * Initialize master key from machine-specific data
   * In production, this should use a proper key management system
   */
  _initMasterKey() {
    const saltFile = path.join(this.dataPath, '_key.salt');

    if (fs.existsSync(saltFile)) {
      this.masterKeySalt = fs.readFileSync(saltFile);
    } else {
      this.masterKeySalt = crypto.randomBytes(SALT_LENGTH);
      fs.writeFileSync(saltFile, this.masterKeySalt);
    }

    // Derive key from machine-specific identifier
    // In production, use a proper secret or hardware security module
    const machineId = this._getMachineIdentifier();
    this.masterKey = crypto.pbkdf2Sync(
      machineId,
      this.masterKeySalt,
      PBKDF2_ITERATIONS,
      KEY_LENGTH,
      PBKDF2_DIGEST
    );
  }

  /**
   * Get machine-specific identifier for key derivation
   * This provides basic protection - not suitable for high-security scenarios
   */
  _getMachineIdentifier() {
    const os = require('os');
    const components = [
      os.hostname(),
      os.platform(),
      os.arch(),
      os.cpus()[0]?.model || 'unknown',
      __dirname, // Installation path
    ];
    return components.join('|');
  }

  // ==================== ENCRYPTION ====================

  /**
   * Encrypt data using AES-256-GCM
   * @param {string|Buffer} data - Data to encrypt
   * @param {Buffer} key - Optional custom key (uses master key if not provided)
   * @returns {Buffer} - Encrypted data with IV and auth tag prepended
   */
  encrypt(data, key = null) {
    const encryptionKey = key || this.masterKey;
    if (!encryptionKey) {
      throw new Error('Encryption key not available');
    }

    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, encryptionKey, iv);

    const dataBuffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const encrypted = Buffer.concat([cipher.update(dataBuffer), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // Format: IV (16) + AuthTag (16) + Encrypted Data
    return Buffer.concat([iv, authTag, encrypted]);
  }

  /**
   * Decrypt data encrypted with encrypt()
   * @param {Buffer} encryptedData - Data to decrypt
   * @param {Buffer} key - Optional custom key
   * @returns {Buffer} - Decrypted data
   */
  decrypt(encryptedData, key = null) {
    const decryptionKey = key || this.masterKey;
    if (!decryptionKey) {
      throw new Error('Decryption key not available');
    }

    if (encryptedData.length < IV_LENGTH + TAG_LENGTH) {
      throw new Error('Invalid encrypted data format');
    }

    const iv = encryptedData.slice(0, IV_LENGTH);
    const authTag = encryptedData.slice(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const encrypted = encryptedData.slice(IV_LENGTH + TAG_LENGTH);

    const decipher = crypto.createDecipheriv(ALGORITHM, decryptionKey, iv);
    decipher.setAuthTag(authTag);

    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  }

  /**
   * Encrypt a string and return base64-encoded result
   * @param {string} plaintext - Text to encrypt
   * @returns {string} - Base64-encoded encrypted data
   */
  encryptString(plaintext) {
    const encrypted = this.encrypt(plaintext);
    return encrypted.toString('base64');
  }

  /**
   * Decrypt a base64-encoded encrypted string
   * @param {string} ciphertext - Base64-encoded encrypted data
   * @returns {string} - Decrypted text
   */
  decryptString(ciphertext) {
    const encrypted = Buffer.from(ciphertext, 'base64');
    const decrypted = this.decrypt(encrypted);
    return decrypted.toString('utf8');
  }

  /**
   * Derive a key from a passphrase
   * @param {string} passphrase - User passphrase
   * @param {Buffer} salt - Optional salt (generates new if not provided)
   * @returns {{ key: Buffer, salt: Buffer }}
   */
  deriveKey(passphrase, salt = null) {
    const keySalt = salt || crypto.randomBytes(SALT_LENGTH);
    const key = crypto.pbkdf2Sync(
      passphrase,
      keySalt,
      PBKDF2_ITERATIONS,
      KEY_LENGTH,
      PBKDF2_DIGEST
    );
    return { key, salt: keySalt };
  }

  /**
   * Generate a secure random token
   * @param {number} length - Token length in bytes
   * @returns {string} - Hex-encoded token
   */
  generateToken(length = 32) {
    return crypto.randomBytes(length).toString('hex');
  }

  /**
   * Hash a password using bcrypt-like approach with PBKDF2
   * @param {string} password - Password to hash
   * @returns {string} - Hashed password with salt
   */
  hashPassword(password) {
    const salt = crypto.randomBytes(SALT_LENGTH);
    const hash = crypto.pbkdf2Sync(
      password,
      salt,
      PBKDF2_ITERATIONS,
      KEY_LENGTH,
      PBKDF2_DIGEST
    );
    // Format: salt$hash (both base64)
    return `${salt.toString('base64')}$${hash.toString('base64')}`;
  }

  /**
   * Verify a password against a hash
   * @param {string} password - Password to verify
   * @param {string} storedHash - Stored hash from hashPassword()
   * @returns {boolean}
   */
  verifyPassword(password, storedHash) {
    try {
      const [saltB64, hashB64] = storedHash.split('$');
      const salt = Buffer.from(saltB64, 'base64');
      const expectedHash = Buffer.from(hashB64, 'base64');

      const actualHash = crypto.pbkdf2Sync(
        password,
        salt,
        PBKDF2_ITERATIONS,
        KEY_LENGTH,
        PBKDF2_DIGEST
      );

      return crypto.timingSafeEqual(actualHash, expectedHash);
    } catch (err) {
      return false;
    }
  }

  // ==================== CREDENTIAL STORAGE ====================

  /**
   * Store a credential securely
   * @param {string} key - Credential identifier
   * @param {string} value - Credential value
   * @param {object} metadata - Optional metadata
   */
  storeCredential(key, value, metadata = {}) {
    const credentials = this._loadCredentials();

    credentials[key] = {
      value: this.encryptString(value),
      metadata: {
        ...metadata,
        createdAt: metadata.createdAt || Date.now(),
        updatedAt: Date.now(),
      },
    };

    this._saveCredentials(credentials);
    this._audit('credential_store', { key, hasMetadata: !!metadata });
  }

  /**
   * Retrieve a credential
   * @param {string} key - Credential identifier
   * @returns {string|null} - Decrypted credential value or null
   */
  getCredential(key) {
    const credentials = this._loadCredentials();
    const entry = credentials[key];

    if (!entry) return null;

    try {
      this._audit('credential_access', { key });
      return this.decryptString(entry.value);
    } catch (err) {
      console.error('[SecurityManager] Failed to decrypt credential:', key);
      this._audit('credential_access_failed', { key, error: err.message });
      return null;
    }
  }

  /**
   * Delete a credential
   * @param {string} key - Credential identifier
   * @returns {boolean}
   */
  deleteCredential(key) {
    const credentials = this._loadCredentials();

    if (!credentials[key]) return false;

    delete credentials[key];
    this._saveCredentials(credentials);
    this._audit('credential_delete', { key });
    return true;
  }

  /**
   * List all credential keys (not values)
   * @returns {Array<{key: string, metadata: object}>}
   */
  listCredentials() {
    const credentials = this._loadCredentials();
    return Object.entries(credentials).map(([key, entry]) => ({
      key,
      metadata: entry.metadata,
    }));
  }

  /**
   * Load credentials from encrypted file
   */
  _loadCredentials() {
    try {
      if (!fs.existsSync(this.credentialsFile)) {
        return {};
      }

      const encrypted = fs.readFileSync(this.credentialsFile);
      const decrypted = this.decrypt(encrypted);
      return JSON.parse(decrypted.toString('utf8'));
    } catch (err) {
      console.error('[SecurityManager] Failed to load credentials:', err.message);
      return {};
    }
  }

  /**
   * Save credentials to encrypted file
   */
  _saveCredentials(credentials) {
    const json = JSON.stringify(credentials);
    const encrypted = this.encrypt(json);
    fs.writeFileSync(this.credentialsFile, encrypted);
  }

  // ==================== SESSION MANAGEMENT ====================

  /**
   * Create a new session
   * @param {string} userId - User identifier
   * @param {object} options - Session options
   * @returns {object} - Session info with token
   */
  createSession(userId, options = {}) {
    const token = this.generateToken(48);
    const session = {
      id: this.generateToken(16),
      userId,
      token: this.hashPassword(token), // Store hashed token
      createdAt: Date.now(),
      expiresAt: Date.now() + (options.ttl || 24 * 60 * 60 * 1000), // Default 24h
      role: options.role || 'operator',
      metadata: options.metadata || {},
    };

    this.sessions.set(session.id, session);
    this._saveSessions();
    this._audit('session_create', { sessionId: session.id, userId });

    return {
      sessionId: session.id,
      token, // Return plaintext token (only time it's available)
      expiresAt: session.expiresAt,
    };
  }

  /**
   * Validate a session token
   * @param {string} sessionId - Session ID
   * @param {string} token - Session token
   * @returns {object|null} - Session info or null if invalid
   */
  validateSession(sessionId, token) {
    const session = this.sessions.get(sessionId);

    if (!session) {
      this._audit('session_validate_failed', { sessionId, reason: 'not_found' });
      return null;
    }

    if (Date.now() > session.expiresAt) {
      this.sessions.delete(sessionId);
      this._saveSessions();
      this._audit('session_expired', { sessionId, userId: session.userId });
      return null;
    }

    if (!this.verifyPassword(token, session.token)) {
      this._audit('session_validate_failed', { sessionId, reason: 'invalid_token' });
      return null;
    }

    this._audit('session_validate', { sessionId, userId: session.userId });
    return {
      sessionId: session.id,
      userId: session.userId,
      role: session.role,
      expiresAt: session.expiresAt,
    };
  }

  /**
   * Invalidate a session
   * @param {string} sessionId - Session ID
   * @returns {boolean}
   */
  invalidateSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    this.sessions.delete(sessionId);
    this._saveSessions();
    this._audit('session_invalidate', { sessionId, userId: session.userId });
    return true;
  }

  /**
   * Extend a session's expiration
   * @param {string} sessionId - Session ID
   * @param {number} ttl - Additional time in milliseconds
   * @returns {boolean}
   */
  extendSession(sessionId, ttl = 60 * 60 * 1000) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    session.expiresAt = Date.now() + ttl;
    this._saveSessions();
    this._audit('session_extend', { sessionId, userId: session.userId });
    return true;
  }

  /**
   * Get all active sessions for a user
   * @param {string} userId - User ID
   * @returns {Array}
   */
  getUserSessions(userId) {
    const sessions = [];
    for (const [id, session] of this.sessions) {
      if (session.userId === userId && Date.now() < session.expiresAt) {
        sessions.push({
          sessionId: id,
          createdAt: session.createdAt,
          expiresAt: session.expiresAt,
          role: session.role,
        });
      }
    }
    return sessions;
  }

  /**
   * Load sessions from file
   */
  _loadSessions() {
    try {
      if (!fs.existsSync(this.sessionsFile)) {
        return;
      }

      const data = JSON.parse(fs.readFileSync(this.sessionsFile, 'utf8'));
      const now = Date.now();

      // Load non-expired sessions
      for (const session of data) {
        if (session.expiresAt > now) {
          this.sessions.set(session.id, session);
        }
      }
    } catch (err) {
      console.error('[SecurityManager] Failed to load sessions:', err.message);
    }
  }

  /**
   * Save sessions to file
   */
  _saveSessions() {
    const sessions = Array.from(this.sessions.values());
    fs.writeFileSync(this.sessionsFile, JSON.stringify(sessions, null, 2));
  }

  // ==================== PERMISSION SYSTEM ====================

  /**
   * Check if a role has permission for a resource
   * @param {string} roleId - Role identifier
   * @param {string} resource - Resource type
   * @param {number} requiredLevel - Required permission level
   * @returns {boolean}
   */
  hasPermission(roleId, resource, requiredLevel) {
    const role = this.roles[roleId];
    if (!role) return false;

    const level = role.permissions[resource] ?? PERMISSION_LEVELS.NONE;
    return level >= requiredLevel;
  }

  /**
   * Check if a session has permission for a resource
   * @param {string} sessionId - Session ID
   * @param {string} resource - Resource type
   * @param {number} requiredLevel - Required permission level
   * @returns {boolean}
   */
  sessionHasPermission(sessionId, resource, requiredLevel) {
    const session = this.sessions.get(sessionId);
    if (!session || Date.now() > session.expiresAt) {
      return false;
    }

    return this.hasPermission(session.role, resource, requiredLevel);
  }

  /**
   * Assign a role to a user
   * @param {string} userId - User identifier
   * @param {string} roleId - Role identifier
   */
  assignRole(userId, roleId) {
    if (!this.roles[roleId]) {
      throw new Error(`Role not found: ${roleId}`);
    }

    this.userRoles.set(userId, roleId);
    this._audit('role_assign', { userId, roleId });
  }

  /**
   * Get user's role
   * @param {string} userId - User identifier
   * @returns {string|null}
   */
  getUserRole(userId) {
    return this.userRoles.get(userId) || null;
  }

  /**
   * Add a custom role
   * @param {string} roleId - Role identifier
   * @param {object} roleConfig - Role configuration
   */
  addRole(roleId, roleConfig) {
    this.roles[roleId] = {
      name: roleConfig.name || roleId,
      permissions: roleConfig.permissions || {},
    };
    this._audit('role_create', { roleId });
  }

  /**
   * Get all roles
   * @returns {object}
   */
  getRoles() {
    return { ...this.roles };
  }

  // ==================== AUDIT LOGGING ====================

  /**
   * Add an audit log entry
   * @param {string} action - Action type
   * @param {object} details - Action details
   */
  _audit(action, details = {}) {
    const entry = {
      timestamp: Date.now(),
      action,
      details,
    };

    this.auditLog.push(entry);

    // Trim log if too large
    if (this.auditLog.length > this.auditLogMaxSize) {
      this.auditLog = this.auditLog.slice(-this.auditLogMaxSize);
    }

    // Periodic save
    if (this.auditLog.length % 50 === 0) {
      this._saveAuditLog();
    }
  }

  /**
   * Get audit log entries
   * @param {object} options - Filter options
   * @returns {Array}
   */
  getAuditLog(options = {}) {
    let entries = [...this.auditLog];

    if (options.action) {
      entries = entries.filter(e => e.action === options.action);
    }

    if (options.since) {
      entries = entries.filter(e => e.timestamp >= options.since);
    }

    if (options.limit) {
      entries = entries.slice(-options.limit);
    }

    return entries;
  }

  /**
   * Load audit log from file
   */
  _loadAuditLog() {
    try {
      if (!fs.existsSync(this.auditFile)) {
        return;
      }

      this.auditLog = JSON.parse(fs.readFileSync(this.auditFile, 'utf8'));
    } catch (err) {
      console.error('[SecurityManager] Failed to load audit log:', err.message);
      this.auditLog = [];
    }
  }

  /**
   * Save audit log to file
   */
  _saveAuditLog() {
    try {
      fs.writeFileSync(this.auditFile, JSON.stringify(this.auditLog, null, 2));
    } catch (err) {
      console.error('[SecurityManager] Failed to save audit log:', err.message);
    }
  }

  // ==================== SENSITIVE DATA PROTECTION ====================

  /**
   * Mask sensitive data in an object
   * @param {object} obj - Object to mask
   * @param {Array<string>} sensitiveKeys - Keys to mask
   * @returns {object} - Masked object copy
   */
  maskSensitiveData(obj, sensitiveKeys = null) {
    const keys = sensitiveKeys || [
      'password', 'token', 'key', 'secret',
      'credential', 'auth', 'apiKey', 'api_key',
    ];

    const mask = (value) => {
      if (typeof value === 'string' && value.length > 4) {
        return value.slice(0, 2) + '*'.repeat(Math.min(value.length - 4, 20)) + value.slice(-2);
      }
      return '***';
    };

    const process = (input) => {
      if (Array.isArray(input)) {
        return input.map(process);
      }

      if (input && typeof input === 'object') {
        const result = {};
        for (const [key, value] of Object.entries(input)) {
          const isSecret = keys.some(k =>
            key.toLowerCase().includes(k.toLowerCase())
          );
          result[key] = isSecret ? mask(value) : process(value);
        }
        return result;
      }

      return input;
    };

    return process(obj);
  }

  /**
   * Sanitize user input to prevent injection
   * @param {string} input - User input
   * @param {object} options - Sanitization options
   * @returns {string}
   */
  sanitizeInput(input, options = {}) {
    if (typeof input !== 'string') return input;

    let sanitized = input;

    // Remove null bytes
    sanitized = sanitized.replace(/\0/g, '');

    // Limit length
    if (options.maxLength) {
      sanitized = sanitized.slice(0, options.maxLength);
    }

    // Remove control characters (except newline, tab)
    if (options.removeControlChars !== false) {
      sanitized = sanitized.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
    }

    // Escape HTML if requested
    if (options.escapeHtml) {
      sanitized = sanitized
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;');
    }

    return sanitized;
  }

  // ==================== CLEANUP ====================

  /**
   * Cleanup expired sessions and save state
   */
  cleanup() {
    const now = Date.now();
    let cleaned = 0;

    for (const [id, session] of this.sessions) {
      if (session.expiresAt < now) {
        this.sessions.delete(id);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this._saveSessions();
      this._audit('cleanup', { sessionsRemoved: cleaned });
    }

    this._saveAuditLog();
    return { sessionsRemoved: cleaned };
  }

  /**
   * Export security state (for backup, excluding sensitive data)
   */
  export() {
    return {
      roles: this.roles,
      userRoles: Object.fromEntries(this.userRoles),
      sessionCount: this.sessions.size,
      auditLogCount: this.auditLog.length,
      exportedAt: Date.now(),
    };
  }
}

// Singleton instance
let securityManagerInstance = null;

/**
 * Create or get the security manager instance
 * @param {object} options - Options for new instance
 * @returns {SecurityManager}
 */
function getSecurityManager(options = {}) {
  if (!securityManagerInstance) {
    securityManagerInstance = new SecurityManager(options);
  }
  return securityManagerInstance;
}

/**
 * Reset the security manager (for testing)
 */
function resetSecurityManager() {
  if (securityManagerInstance) {
    securityManagerInstance.cleanup();
  }
  securityManagerInstance = null;
}

module.exports = {
  SecurityManager,
  getSecurityManager,
  resetSecurityManager,
  PERMISSION_LEVELS,
  RESOURCE_TYPES,
  DEFAULT_ROLES,
};
