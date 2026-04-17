/**
 * Team Memory schema migration v15.
 * Adds recall feedback state so delivery-time recall can learn from use, ignore,
 * and correction signals over time.
 */

function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_recall_sets (
      result_set_id TEXT PRIMARY KEY,
      pane_id TEXT,
      agent_role TEXT,
      channel TEXT,
      sender TEXT,
      query TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'delivered',
      outcome_reason TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      resolved_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_memory_recall_sets_scope
    ON memory_recall_sets(pane_id, agent_role, channel, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_memory_recall_sets_status
    ON memory_recall_sets(status, created_at DESC);

    CREATE TABLE IF NOT EXISTS memory_recall_items (
      result_item_id TEXT PRIMARY KEY,
      result_set_id TEXT NOT NULL REFERENCES memory_recall_sets(result_set_id) ON DELETE CASCADE,
      identity_key TEXT NOT NULL,
      rank_index INTEGER NOT NULL DEFAULT 0,
      store_name TEXT NOT NULL,
      source_role TEXT,
      source_path TEXT,
      citation TEXT,
      title TEXT,
      excerpt TEXT,
      score REAL NOT NULL DEFAULT 0.0,
      rank_score REAL NOT NULL DEFAULT 0.0,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memory_recall_items_set
    ON memory_recall_items(result_set_id, rank_index ASC);

    CREATE INDEX IF NOT EXISTS idx_memory_recall_items_identity
    ON memory_recall_items(identity_key, created_at DESC);

    CREATE TABLE IF NOT EXISTS memory_recall_profiles (
      identity_key TEXT PRIMARY KEY,
      used_count INTEGER NOT NULL DEFAULT 0,
      ignored_count INTEGER NOT NULL DEFAULT 0,
      missing_count INTEGER NOT NULL DEFAULT 0,
      last_used_at INTEGER,
      last_ignored_at INTEGER,
      last_missing_at INTEGER,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_recall_feedback_events (
      event_id TEXT PRIMARY KEY,
      result_set_id TEXT REFERENCES memory_recall_sets(result_set_id) ON DELETE CASCADE,
      result_item_id TEXT REFERENCES memory_recall_items(result_item_id) ON DELETE CASCADE,
      identity_key TEXT,
      feedback_type TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 0.0,
      reason TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memory_recall_feedback_set
    ON memory_recall_feedback_events(result_set_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_memory_recall_feedback_identity
    ON memory_recall_feedback_events(identity_key, created_at DESC);
  `);
}

module.exports = {
  version: 15,
  description: 'Phase 11 recall feedback profiles and audit trail',
  up,
};
