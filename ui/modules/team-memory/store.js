const fs = require('fs');
const path = require('path');
const log = require('../logger');
const { resolveCoordPath } = require('../../config');
const { runMigrations } = require('./migrations');

const DEFAULT_INIT_LOCK_RETRIES = 10;
const DEFAULT_INIT_LOCK_RETRY_DELAY_MS = 50;

/**
 * SQLite Driver Matrix:
 * - Electron runtime (Node 18 in this app): use better-sqlite3.
 * - CLI scripts (system Node 22+): use node:sqlite.
 * Why: node:sqlite is not available in Electron's current bundled Node runtime.
 */
function resolveDefaultDbPath() {
  if (typeof resolveCoordPath !== 'function') {
    throw new Error('resolveCoordPath unavailable; cannot resolve runtime/team-memory.sqlite');
  }
  return resolveCoordPath(path.join('runtime', 'team-memory.sqlite'), { forWrite: true });
}

const DEFAULT_DB_PATH = resolveDefaultDbPath();

function loadSqliteDriver() {
  try {
    // CLI path (Node 22+): prefer built-in sqlite.
    const mod = require('node:sqlite');
    if (mod && typeof mod.DatabaseSync === 'function') {
      return {
        name: 'node:sqlite',
        create: (filename) => new mod.DatabaseSync(filename),
      };
    }
  } catch {
    // fallthrough
  }

  try {
    // Electron runtime fallback (Node 18): native addon driver.
    const BetterSqlite3 = require('better-sqlite3');
    return {
      name: 'better-sqlite3',
      create: (filename) => new BetterSqlite3(filename),
    };
  } catch {
    return null;
  }
}

function isSqliteLockError(err) {
  const message = String(err?.message || '').toLowerCase();
  return message.includes('database is locked') || message.includes('database is busy') || message.includes('busy');
}

function sleepSync(delayMs) {
  const timeout = Math.max(0, Math.floor(Number(delayMs) || 0));
  if (!timeout) return;
  if (typeof SharedArrayBuffer === 'function' && typeof Atomics?.wait === 'function') {
    const signal = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(signal, 0, 0, timeout);
    return;
  }
  const endAt = Date.now() + timeout;
  while (Date.now() < endAt) {
    // Best-effort synchronous backoff for runtimes without Atomics.wait.
  }
}

class TeamMemoryStore {
  constructor(options = {}) {
    this.dbPath = options.dbPath || resolveDefaultDbPath();
    this.enabled = options.enabled !== false;
    this.db = null;
    this.driverName = null;
    this.available = false;
    this.degradedReason = null;
    this.migrationResult = null;
  }

  init(options = {}) {
    if (this.isAvailable()) {
      return {
        ok: true,
        driver: this.driverName,
        dbPath: this.dbPath,
        migrationResult: this.migrationResult,
      };
    }

    if (!this.enabled) {
      this.degradedReason = 'disabled';
      this.available = false;
      return { ok: false, reason: this.degradedReason };
    }

    try {
      fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    } catch (err) {
      this.degradedReason = `runtime_dir_error:${err.message}`;
      this.available = false;
      return { ok: false, reason: this.degradedReason };
    }

    const driver = loadSqliteDriver();
    if (!driver) {
      this.degradedReason = 'sqlite_driver_unavailable';
      this.available = false;
      return { ok: false, reason: this.degradedReason };
    }

    const retryCount = Number.isFinite(Number(options.lockRetryCount))
      ? Math.max(0, Math.floor(Number(options.lockRetryCount)))
      : DEFAULT_INIT_LOCK_RETRIES;
    const retryDelayMs = Number.isFinite(Number(options.lockRetryDelayMs))
      ? Math.max(0, Math.floor(Number(options.lockRetryDelayMs)))
      : DEFAULT_INIT_LOCK_RETRY_DELAY_MS;

    for (let attempt = 0; attempt <= retryCount; attempt += 1) {
      try {
        this.db = driver.create(this.dbPath);
        this.driverName = driver.name;
        this._applyPragmas();

        const migrationResult = runMigrations(this.db, { nowMs: options.nowMs });
        this.migrationResult = migrationResult;
        if (!migrationResult.ok) {
          throw new Error(migrationResult.error || migrationResult.reason || 'migration_failed');
        }

        this.available = true;
        this.degradedReason = null;
        log.info('TeamMemory', `SQLite driver selected: ${this.driverName} (Node ${process.versions.node})`);
        return {
          ok: true,
          driver: this.driverName,
          dbPath: this.dbPath,
          migrationResult,
        };
      } catch (err) {
        this.available = false;
        this.close();
        if (!isSqliteLockError(err) || attempt >= retryCount) {
          this.degradedReason = `open_failed:${err.message}`;
          return { ok: false, reason: this.degradedReason };
        }
        sleepSync(retryDelayMs * (attempt + 1));
      }
    }
  }

  _applyPragmas() {
    if (!this.db) return;
    this.db.exec('PRAGMA busy_timeout=5000;');
    const journalMode = this.db.prepare('PRAGMA journal_mode;').get()?.journal_mode;
    if (String(journalMode || '').toLowerCase() !== 'wal') {
      this.db.exec('PRAGMA journal_mode=WAL;');
    }
    this.db.exec('PRAGMA synchronous=NORMAL;');
    this.db.exec('PRAGMA temp_store=MEMORY;');
    this.db.exec('PRAGMA foreign_keys=ON;');
  }

  isAvailable() {
    return this.available && Boolean(this.db);
  }

  getStatus() {
    return {
      available: this.isAvailable(),
      driver: this.driverName,
      dbPath: this.dbPath,
      degradedReason: this.degradedReason,
      migrationResult: this.migrationResult,
    };
  }

  close() {
    if (!this.db) return;
    try {
      this.db.close();
    } catch (err) {
      log.warn('TeamMemory', `Error closing DB: ${err.message}`);
    }
    this.db = null;
    this.available = false;
  }
}

module.exports = {
  TeamMemoryStore,
  DEFAULT_DB_PATH,
  resolveDefaultDbPath,
  loadSqliteDriver,
};
