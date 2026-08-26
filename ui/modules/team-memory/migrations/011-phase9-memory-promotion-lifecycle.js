/**
 * Team Memory schema migration v11.
 * Adds Phase 3 promotion metadata, lifecycle tracking, access logs, and conflict queue state.
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
    'memory_objects',
    'claim_type',
    'claim_type TEXT'
  );
  addColumnIfMissing(
    db,
    'memory_objects',
    'lifecycle_state',
    "lifecycle_state TEXT NOT NULL DEFAULT 'active'"
  );
  addColumnIfMissing(
    db,
    'memory_objects',
    'session_ordinal',
    'session_ordinal INTEGER'
  );
  addColumnIfMissing(
    db,
    'memory_objects',
    'last_access_session',
    'last_access_session INTEGER'
  );
  addColumnIfMissing(
    db,
    'memory_objects',
    'stale_since_session',
    'stale_since_session INTEGER'
  );
  addColumnIfMissing(
    db,
    'memory_objects',
    'stale_window_until_session',
    'stale_window_until_session INTEGER'
  );
  addColumnIfMissing(
    db,
    'memory_objects',
    'archived_at',
    'archived_at INTEGER'
  );
  addColumnIfMissing(
    db,
    'memory_objects',
    'promoted_at',
    'promoted_at INTEGER'
  );
  addColumnIfMissing(
    db,
    'memory_objects',
    'useful_marked_at',
    'useful_marked_at INTEGER'
  );

  addColumnIfMissing(
    db,
    'memory_promotion_queue',
    'claim_type',
    'claim_type TEXT'
  );
  addColumnIfMissing(
    db,
    'memory_promotion_queue',
    'target_heading',
    'target_heading TEXT'
  );
  addColumnIfMissing(
    db,
    'memory_promotion_queue',
    'review_notes',
    'review_notes TEXT'
  );
  addColumnIfMissing(
    db,
    'memory_promotion_queue',
    'reviewed_by',
    'reviewed_by TEXT'
  );
  addColumnIfMissing(
    db,
    'memory_promotion_queue',
    'reviewed_at',
    'reviewed_at INTEGER'
  );
  addColumnIfMissing(
    db,
    'memory_promotion_queue',
    'conflict_artifact_path',
    'conflict_artifact_path TEXT'
  );

  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_access_log (
      access_id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL REFERENCES memory_objects(memory_id) ON DELETE CASCADE,
      access_kind TEXT NOT NULL,
      session_ordinal INTEGER,
      detail_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memory_access_memory
    ON memory_access_log(memory_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_memory_access_window
    ON memory_access_log(memory_id, access_kind, session_ordinal DESC, created_at DESC);

    CREATE TABLE IF NOT EXISTS memory_conflict_queue (
      conflict_id TEXT PRIMARY KEY,
      candidate_id TEXT NOT NULL REFERENCES memory_promotion_queue(candidate_id) ON DELETE CASCADE,
      memory_id TEXT NOT NULL REFERENCES memory_objects(memory_id) ON DELETE CASCADE,
      target_file TEXT NOT NULL,
      base_sha TEXT,
      current_sha TEXT,
      patch_text TEXT,
      artifact_path TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memory_conflict_status
    ON memory_conflict_queue(status, updated_at DESC);

    CREATE INDEX IF NOT EXISTS idx_memory_objects_lifecycle
    ON memory_objects(lifecycle_state, last_access_session, updated_at DESC);
  `);
}

module.exports = {
  version: 11,
  description: 'Phase 9 memory promotion, lifecycle, and conflict state',
  up,
};
