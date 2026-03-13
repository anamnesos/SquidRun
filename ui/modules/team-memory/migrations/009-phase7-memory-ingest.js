/**
 * Team Memory schema migration v9.
 * Adds shared memory ingest journal, dedupe keys, routed memory objects, and Tier 1 promotion queue.
 */

const MEMORY_CLASS_CHECK = "'user_preference', 'environment_quirk', 'procedural_rule', 'architecture_decision', 'solution_trace', 'historical_outcome', 'active_task_state', 'cross_device_handoff'";
const MEMORY_TIER_CHECK = "'tier1', 'tier3', 'tier4'";
const MEMORY_STATUS_CHECK = "'active', 'pending', 'stale', 'superseded', 'corrected', 'rejected', 'expired'";

function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_ingest_journal (
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
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memory_ingest_status
    ON memory_ingest_journal(status, updated_at DESC);

    CREATE INDEX IF NOT EXISTS idx_memory_ingest_class_bucket
    ON memory_ingest_journal(memory_class, time_bucket, created_at DESC);

    CREATE TABLE IF NOT EXISTS memory_dedupe_keys (
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

    CREATE INDEX IF NOT EXISTS idx_memory_dedupe_recent
    ON memory_dedupe_keys(memory_class, dedupe_key, created_at DESC);

    CREATE TABLE IF NOT EXISTS memory_objects (
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
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memory_objects_tier
    ON memory_objects(tier, updated_at DESC);

    CREATE INDEX IF NOT EXISTS idx_memory_objects_class
    ON memory_objects(memory_class, updated_at DESC);

    CREATE INDEX IF NOT EXISTS idx_memory_objects_session
    ON memory_objects(session_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS memory_promotion_queue (
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
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memory_promotion_status
    ON memory_promotion_queue(status, updated_at DESC);
  `);
}

module.exports = {
  version: 9,
  description: 'Phase 7 shared memory ingest journal + dedupe + promotion queue',
  up,
};
