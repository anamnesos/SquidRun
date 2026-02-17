const fs = require('fs');
const path = require('path');
const log = require('../logger');
const { WORKSPACE_PATH, resolveCoordPath } = require('../../config');
const { runMigrations } = require('./migrations');

function resolveDefaultDbPath() {
  if (typeof resolveCoordPath === 'function') {
    return resolveCoordPath(path.join('runtime', 'team-memory.sqlite'), { forWrite: true });
  }
  return path.join(WORKSPACE_PATH, 'runtime', 'team-memory.sqlite');
}

const DEFAULT_DB_PATH = resolveDefaultDbPath();

function loadSqliteDriver() {
  try {
    // eslint-disable-next-line global-require
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
    // eslint-disable-next-line global-require
    const BetterSqlite3 = require('better-sqlite3');
    return {
      name: 'better-sqlite3',
      create: (filename) => new BetterSqlite3(filename),
    };
  } catch {
    return null;
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
      return {
        ok: true,
        driver: this.driverName,
        dbPath: this.dbPath,
        migrationResult,
      };
    } catch (err) {
      this.available = false;
      this.degradedReason = `open_failed:${err.message}`;
      this.close();
      return { ok: false, reason: this.degradedReason };
    }
  }

  _applyPragmas() {
    if (!this.db) return;
    this.db.exec('PRAGMA journal_mode=WAL;');
    this.db.exec('PRAGMA synchronous=NORMAL;');
    this.db.exec('PRAGMA temp_store=MEMORY;');
    this.db.exec('PRAGMA foreign_keys=ON;');
    this.db.exec('PRAGMA busy_timeout=5000;');
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
