/**
 * Team Memory schema migration v12.
 * Adds Phase 4 delivery state for proactive injections, handoff packets, and compaction survival artifacts.
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
    'injection_count',
    'injection_count INTEGER NOT NULL DEFAULT 0'
  );
  addColumnIfMissing(
    db,
    'memory_objects',
    'last_injected_at',
    'last_injected_at INTEGER'
  );

  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_injection_events (
      injection_id TEXT PRIMARY KEY,
      pane_id TEXT NOT NULL,
      agent_role TEXT,
      session_id TEXT,
      trigger_type TEXT NOT NULL,
      trigger_event_id TEXT,
      memory_id TEXT REFERENCES memory_objects(memory_id) ON DELETE CASCADE,
      memory_class TEXT,
      cluster_key TEXT,
      context_key TEXT,
      injection_reason TEXT NOT NULL,
      source_tier TEXT NOT NULL,
      authoritative INTEGER NOT NULL DEFAULT 0,
      confidence REAL NOT NULL DEFAULT 0.0,
      freshness_at INTEGER,
      status TEXT NOT NULL DEFAULT 'delivered',
      referenced_at INTEGER,
      dismissed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memory_injection_window
    ON memory_injection_events(pane_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_memory_injection_trigger
    ON memory_injection_events(pane_id, trigger_event_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_memory_injection_memory
    ON memory_injection_events(memory_id, session_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS memory_injection_suppressions (
      pane_id TEXT NOT NULL,
      cluster_key TEXT NOT NULL,
      context_key TEXT NOT NULL,
      dismissed_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (pane_id, cluster_key)
    );

    CREATE TABLE IF NOT EXISTS memory_handoff_packets (
      packet_id TEXT PRIMARY KEY,
      ingest_id TEXT,
      source_memory_id TEXT,
      session_id TEXT NOT NULL,
      source_device TEXT NOT NULL,
      target_device TEXT,
      packet_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'built',
      expires_at_session INTEGER,
      sent_at INTEGER,
      received_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memory_handoff_status
    ON memory_handoff_packets(status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS memory_compaction_survival (
      survival_id TEXT PRIMARY KEY,
      pane_id TEXT,
      session_id TEXT,
      note_memory_id TEXT REFERENCES memory_objects(memory_id) ON DELETE SET NULL,
      summary_json TEXT NOT NULL DEFAULT '{}',
      tier1_snapshot_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'prepared',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memory_compaction_survival
    ON memory_compaction_survival(pane_id, session_id, updated_at DESC);
  `);
}

module.exports = {
  version: 12,
  description: 'Phase 10 memory delivery, handoff, and compaction survival state',
  up,
};
