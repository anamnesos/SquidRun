const migrationV1 = require('./migrations/001-initial-schema');
const migrationV2 = require('./migrations/002-phase1-compat');
const migrationV3 = require('./migrations/003-phase2-search');
const migrationV4 = require('./migrations/004-phase4-patterns');
const migrationV5 = require('./migrations/005-phase5-guards');

const MIGRATIONS = [migrationV1, migrationV2, migrationV3, migrationV4, migrationV5];

function toEpochMs(value = Date.now()) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 0) {
    return Math.floor(numeric);
  }
  return Date.now();
}

function ensureMigrationsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL,
      description TEXT
    );
  `);
}

function getAppliedVersions(db) {
  const stmt = db.prepare('SELECT version FROM schema_migrations ORDER BY version ASC');
  const rows = stmt.all();
  const versions = new Set();
  for (const row of rows) {
    const value = Number(row?.version);
    if (Number.isFinite(value)) versions.add(value);
  }
  return versions;
}

function runMigrations(db, options = {}) {
  if (!db || typeof db.exec !== 'function' || typeof db.prepare !== 'function') {
    return {
      ok: false,
      reason: 'invalid_db',
      appliedVersions: [],
      currentVersion: 0,
    };
  }

  ensureMigrationsTable(db);
  const applied = getAppliedVersions(db);
  const appliedVersions = [];
  const nowMs = toEpochMs(options.nowMs);

  try {
    for (const migration of MIGRATIONS) {
      const version = Number(migration?.version);
      if (!Number.isFinite(version)) continue;
      if (applied.has(version)) continue;

      db.exec('BEGIN IMMEDIATE;');
      try {
        if (typeof migration.up === 'function') {
          migration.up(db, options);
        } else {
          db.exec(String(migration.sql || '').trim());
        }
        db.prepare(`
          INSERT INTO schema_migrations (version, applied_at, description)
          VALUES (?, ?, ?)
        `).run(version, nowMs, migration.description || null);
        db.exec('COMMIT;');
        appliedVersions.push(version);
      } catch (err) {
        try { db.exec('ROLLBACK;'); } catch {}
        throw err;
      }
    }
  } catch (err) {
    const currentVersion = Number(
      db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get()?.v || 0
    );
    return {
      ok: false,
      reason: 'migration_failed',
      error: err.message,
      appliedVersions,
      currentVersion,
    };
  }

  const currentVersion = Number(
    db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get()?.v || 0
  );

  return {
    ok: true,
    appliedVersions,
    currentVersion,
    latestVersion: MIGRATIONS[MIGRATIONS.length - 1]?.version || 0,
  };
}

module.exports = {
  MIGRATIONS,
  runMigrations,
};
