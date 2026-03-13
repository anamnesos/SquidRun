/**
 * Team Memory schema migration v13.
 * Expands memory-class CHECK constraints so startup health and codebase inventory
 * records can be stored in existing databases created before Session 223.
 */

const MEMORY_CLASS_CHECK = "'user_preference', 'environment_quirk', 'procedural_rule', 'architecture_decision', 'solution_trace', 'historical_outcome', 'active_task_state', 'cross_device_handoff', 'codebase_inventory', 'system_health_state'";
const MEMORY_TIER_CHECK = "'tier1', 'tier3', 'tier4'";
const MEMORY_STATUS_CHECK = "'active', 'pending', 'stale', 'superseded', 'corrected', 'rejected', 'expired'";

function up(db) {
  db.exec('PRAGMA foreign_keys=OFF;');
  db.exec('BEGIN IMMEDIATE;');

  try {
    db.exec(`
      ALTER TABLE memory_ingest_journal RENAME TO memory_ingest_journal_legacy;
      CREATE TABLE memory_ingest_journal (
        ingest_id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL,
        memory_class TEXT NOT NULL CHECK (memory_class IN (${MEMORY_CLASS_CHECK})),
        content_hash TEXT NOT NULL,
        dedupe_key TEXT,
        time_bucket TEXT NOT NULL,
        route_tier TEXT CHECK (route_tier IN (${MEMORY_TIER_CHECK})),
        promotion_required INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded', 'deduped', 'routed', 'failed')),
        payload_json TEXT NOT NULL DEFAULT '{}',
        result_refs_json TEXT NOT NULL DEFAULT '[]',
        error_code TEXT,
        error_message TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_attempt_at INTEGER,
        next_attempt_at INTEGER,
        queue_reason TEXT
      );
      INSERT INTO memory_ingest_journal (
        ingest_id, memory_id, memory_class, content_hash, dedupe_key, time_bucket,
        route_tier, promotion_required, status, payload_json, result_refs_json,
        error_code, error_message, created_at, updated_at, attempt_count,
        last_attempt_at, next_attempt_at, queue_reason
      )
      SELECT
        ingest_id, memory_id, memory_class, content_hash, dedupe_key, time_bucket,
        route_tier, promotion_required, status, payload_json, result_refs_json,
        error_code, error_message, created_at, updated_at, attempt_count,
        last_attempt_at, next_attempt_at, queue_reason
      FROM memory_ingest_journal_legacy;
      DROP TABLE memory_ingest_journal_legacy;

      CREATE INDEX IF NOT EXISTS idx_memory_ingest_status
      ON memory_ingest_journal(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_ingest_class_bucket
      ON memory_ingest_journal(memory_class, time_bucket, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_ingest_replay
      ON memory_ingest_journal(status, next_attempt_at, updated_at DESC);

      ALTER TABLE memory_dedupe_keys RENAME TO memory_dedupe_keys_legacy;
      CREATE TABLE memory_dedupe_keys (
        memory_class TEXT NOT NULL CHECK (memory_class IN (${MEMORY_CLASS_CHECK})),
        dedupe_key TEXT NOT NULL,
        time_bucket TEXT NOT NULL,
        ingest_id TEXT NOT NULL,
        memory_id TEXT,
        result_refs_json TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (memory_class, dedupe_key, time_bucket)
      );
      INSERT INTO memory_dedupe_keys (
        memory_class, dedupe_key, time_bucket, ingest_id, memory_id,
        result_refs_json, created_at, updated_at
      )
      SELECT
        memory_class, dedupe_key, time_bucket, ingest_id, memory_id,
        result_refs_json, created_at, updated_at
      FROM memory_dedupe_keys_legacy;
      DROP TABLE memory_dedupe_keys_legacy;

      CREATE INDEX IF NOT EXISTS idx_memory_dedupe_recent
      ON memory_dedupe_keys(memory_class, dedupe_key, created_at DESC);

      ALTER TABLE memory_objects RENAME TO memory_objects_legacy;
      CREATE TABLE memory_objects (
        memory_id TEXT PRIMARY KEY,
        ingest_id TEXT NOT NULL UNIQUE REFERENCES memory_ingest_journal(ingest_id) ON DELETE CASCADE,
        memory_class TEXT NOT NULL CHECK (memory_class IN (${MEMORY_CLASS_CHECK})),
        tier TEXT NOT NULL CHECK (tier IN (${MEMORY_TIER_CHECK})),
        status TEXT NOT NULL CHECK (status IN (${MEMORY_STATUS_CHECK})),
        authority_level TEXT NOT NULL,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        provenance_json TEXT NOT NULL DEFAULT '{}',
        source_trace TEXT NOT NULL,
        confidence REAL NOT NULL CHECK (confidence BETWEEN 0.0 AND 1.0),
        scope_json TEXT,
        device_id TEXT,
        session_id TEXT,
        correction_of TEXT,
        supersedes TEXT,
        expires_at INTEGER,
        result_refs_json TEXT NOT NULL DEFAULT '[]',
        freshness_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        claim_type TEXT,
        lifecycle_state TEXT NOT NULL DEFAULT 'active',
        session_ordinal INTEGER,
        last_access_session INTEGER,
        stale_since_session INTEGER,
        stale_window_until_session INTEGER,
        archived_at INTEGER,
        promoted_at INTEGER,
        useful_marked_at INTEGER,
        injection_count INTEGER NOT NULL DEFAULT 0,
        last_injected_at INTEGER
      );
      INSERT INTO memory_objects (
        memory_id, ingest_id, memory_class, tier, status, authority_level, content,
        content_hash, provenance_json, source_trace, confidence, scope_json,
        device_id, session_id, correction_of, supersedes, expires_at,
        result_refs_json, freshness_at, created_at, updated_at, claim_type,
        lifecycle_state, session_ordinal, last_access_session, stale_since_session,
        stale_window_until_session, archived_at, promoted_at, useful_marked_at,
        injection_count, last_injected_at
      )
      SELECT
        memory_id, ingest_id, memory_class, tier, status, authority_level, content,
        content_hash, provenance_json, source_trace, confidence, scope_json,
        device_id, session_id, correction_of, supersedes, expires_at,
        result_refs_json, freshness_at, created_at, updated_at, claim_type,
        lifecycle_state, session_ordinal, last_access_session, stale_since_session,
        stale_window_until_session, archived_at, promoted_at, useful_marked_at,
        injection_count, last_injected_at
      FROM memory_objects_legacy;
      DROP TABLE memory_objects_legacy;

      CREATE INDEX IF NOT EXISTS idx_memory_objects_tier
      ON memory_objects(tier, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_objects_class
      ON memory_objects(memory_class, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_objects_session
      ON memory_objects(session_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_objects_lifecycle
      ON memory_objects(lifecycle_state, last_access_session, updated_at DESC);

      ALTER TABLE memory_promotion_queue RENAME TO memory_promotion_queue_legacy;
      CREATE TABLE memory_promotion_queue (
        candidate_id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL REFERENCES memory_objects(memory_id) ON DELETE CASCADE,
        ingest_id TEXT NOT NULL REFERENCES memory_ingest_journal(ingest_id) ON DELETE CASCADE,
        memory_class TEXT NOT NULL CHECK (memory_class IN (${MEMORY_CLASS_CHECK})),
        target_file TEXT NOT NULL,
        base_sha TEXT,
        patch_text TEXT,
        review_required INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        claim_type TEXT,
        target_heading TEXT,
        review_notes TEXT,
        reviewed_by TEXT,
        reviewed_at INTEGER,
        conflict_artifact_path TEXT
      );
      INSERT INTO memory_promotion_queue (
        candidate_id, memory_id, ingest_id, memory_class, target_file, base_sha,
        patch_text, review_required, status, created_at, updated_at, claim_type,
        target_heading, review_notes, reviewed_by, reviewed_at, conflict_artifact_path
      )
      SELECT
        candidate_id, memory_id, ingest_id, memory_class, target_file, base_sha,
        patch_text, review_required, status, created_at, updated_at, claim_type,
        target_heading, review_notes, reviewed_by, reviewed_at, conflict_artifact_path
      FROM memory_promotion_queue_legacy;
      DROP TABLE memory_promotion_queue_legacy;

      CREATE INDEX IF NOT EXISTS idx_memory_promotion_status
      ON memory_promotion_queue(status, updated_at DESC);
    `);

    db.exec('COMMIT;');
  } catch (err) {
    try { db.exec('ROLLBACK;'); } catch {}
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys=ON;');
  }
}

module.exports = {
  version: 13,
  description: 'Expand memory-class constraints for startup health memory objects',
  up,
};
