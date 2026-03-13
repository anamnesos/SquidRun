/**
 * Team Memory schema migration v10.
 * Adds replay metadata to the shared memory ingest journal and a small runtime state table.
 */

function addColumnIfMissing(db, tableName, columnName, columnSql) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  if (columns.some((column) => String(column?.name || '').trim() === columnName)) {
    return;
  }
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnSql};`);
}

function up(db) {
  addColumnIfMissing(
    db,
    'memory_ingest_journal',
    'attempt_count',
    'attempt_count INTEGER NOT NULL DEFAULT 0'
  );
  addColumnIfMissing(
    db,
    'memory_ingest_journal',
    'last_attempt_at',
    'last_attempt_at INTEGER'
  );
  addColumnIfMissing(
    db,
    'memory_ingest_journal',
    'next_attempt_at',
    'next_attempt_at INTEGER'
  );
  addColumnIfMissing(
    db,
    'memory_ingest_journal',
    'queue_reason',
    'queue_reason TEXT'
  );

  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_ingest_runtime_state (
      state_key TEXT PRIMARY KEY,
      state_json TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memory_ingest_replay
    ON memory_ingest_journal(status, next_attempt_at, updated_at DESC);
  `);
}

module.exports = {
  version: 10,
  description: 'Phase 8 shared memory ingest recovery metadata + runtime state',
  up,
};
