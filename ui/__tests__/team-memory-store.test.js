const fs = require('fs');
const os = require('os');
const path = require('path');

const { TeamMemoryStore, loadSqliteDriver } = require('../modules/team-memory/store');
const { LATEST_MIGRATION_VERSION, MIGRATIONS, runMigrations } = require('../modules/team-memory/migrations');

const LEGACY_MEMORY_CLASS_CHECK = "'user_preference', 'environment_quirk', 'procedural_rule', 'architecture_decision', 'solution_trace', 'historical_outcome', 'active_task_state', 'cross_device_handoff'";

function createLegacyV12MemoryClassSchema(db) {
  db.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL,
      description TEXT
    );

    CREATE TABLE memory_ingest_journal (
      ingest_id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL,
      memory_class TEXT NOT NULL CHECK (memory_class IN (${LEGACY_MEMORY_CLASS_CHECK})),
      content_hash TEXT NOT NULL,
      dedupe_key TEXT,
      time_bucket TEXT NOT NULL,
      route_tier TEXT CHECK (route_tier IN ('tier1', 'tier3', 'tier4')),
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

    CREATE TABLE memory_dedupe_keys (
      memory_class TEXT NOT NULL CHECK (memory_class IN (${LEGACY_MEMORY_CLASS_CHECK})),
      dedupe_key TEXT NOT NULL,
      time_bucket TEXT NOT NULL,
      ingest_id TEXT NOT NULL,
      memory_id TEXT,
      result_refs_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (memory_class, dedupe_key, time_bucket)
    );

    CREATE TABLE memory_objects (
      memory_id TEXT PRIMARY KEY,
      ingest_id TEXT NOT NULL UNIQUE REFERENCES memory_ingest_journal(ingest_id) ON DELETE CASCADE,
      memory_class TEXT NOT NULL CHECK (memory_class IN (${LEGACY_MEMORY_CLASS_CHECK})),
      tier TEXT NOT NULL CHECK (tier IN ('tier1', 'tier3', 'tier4')),
      status TEXT NOT NULL CHECK (status IN ('active', 'pending', 'stale', 'superseded', 'corrected', 'rejected', 'expired')),
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

    CREATE TABLE memory_promotion_queue (
      candidate_id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL REFERENCES memory_objects(memory_id) ON DELETE CASCADE,
      ingest_id TEXT NOT NULL REFERENCES memory_ingest_journal(ingest_id) ON DELETE CASCADE,
      memory_class TEXT NOT NULL CHECK (memory_class IN (${LEGACY_MEMORY_CLASS_CHECK})),
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

    CREATE TABLE memory_access_log (
      access_id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL REFERENCES memory_objects(memory_id) ON DELETE CASCADE,
      access_kind TEXT NOT NULL,
      session_ordinal INTEGER,
      detail_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE memory_conflict_queue (
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

    CREATE TABLE memory_injection_events (
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

    CREATE TABLE memory_compaction_survival (
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
  `);

  const insertMigration = db.prepare(`
    INSERT INTO schema_migrations (version, applied_at, description)
    VALUES (?, ?, ?)
  `);
  for (let version = 1; version <= 12; version += 1) {
    insertMigration.run(version, 1000 + version, `legacy v${version}`);
  }
}

function getTableSql(db, tableName) {
  return db.prepare(`
    SELECT sql
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(tableName)?.sql || '';
}

test('team-memory migrations are contiguous through the latest version', () => {
  const expectedVersions = Array.from({ length: LATEST_MIGRATION_VERSION }, (_, index) => index + 1);
  expect(MIGRATIONS.map((migration) => migration.version)).toEqual(expectedVersions);
});

const maybeDescribe = loadSqliteDriver() ? describe : describe.skip;

maybeDescribe('team-memory store', () => {
  let tempDir;
  let store;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-team-memory-'));
    store = new TeamMemoryStore({
      dbPath: path.join(tempDir, 'team-memory.sqlite'),
    });
  });

  afterEach(() => {
    if (store) store.close();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('initializes and applies migrations and core tables', () => {
    const result = store.init();
    expect(result.ok).toBe(true);
    expect(store.isAvailable()).toBe(true);

    const migration = store.db.prepare('SELECT version FROM schema_migrations ORDER BY version ASC').all();
    expect(migration.map((row) => row.version)).toEqual(
      Array.from({ length: LATEST_MIGRATION_VERSION }, (_, index) => index + 1)
    );

    const claimsTable = store.db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = 'claims'
    `).get();
    expect(claimsTable.name).toBe('claims');

    const expectedTables = [
      'claim_scopes',
      'claim_evidence',
      'claim_status_history',
      'decisions',
      'decision_alternatives',
      'consensus',
      'belief_snapshots',
      'belief_contradictions',
      'patterns',
      'guards',
      'claim_search',
      'pattern_mining_state',
      'experiments',
      'memory_ingest_journal',
      'memory_dedupe_keys',
      'memory_objects',
      'memory_promotion_queue',
      'memory_ingest_runtime_state',
      'memory_access_log',
      'memory_conflict_queue',
      'memory_injection_events',
      'memory_injection_suppressions',
      'memory_handoff_packets',
      'memory_compaction_survival',
    ];

    for (const tableName of expectedTables) {
      const table = store.db.prepare(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = ?
      `).get(tableName);
      expect(table?.name).toBe(tableName);
    }
  });

  test('upgrades legacy v12 memory-class constraints through migration v13', () => {
    const driver = loadSqliteDriver();
    const dbPath = path.join(tempDir, 'legacy-v12-team-memory.sqlite');
    const db = driver.create(dbPath);

    try {
      createLegacyV12MemoryClassSchema(db);

      const result = runMigrations(db, { nowMs: 1700000000000 });
      expect(result.ok).toBe(true);
      expect(result.appliedVersions).toEqual([13, 14, 15]);

      const migrationRows = db.prepare('SELECT version FROM schema_migrations ORDER BY version ASC').all();
      expect(migrationRows.map((row) => row.version)).toEqual(
        Array.from({ length: LATEST_MIGRATION_VERSION }, (_, index) => index + 1)
      );

      for (const tableName of [
        'memory_ingest_journal',
        'memory_dedupe_keys',
        'memory_objects',
        'memory_promotion_queue',
      ]) {
        const sql = getTableSql(db, tableName);
        expect(sql).toContain('codebase_inventory');
        expect(sql).toContain('system_health_state');
      }

      for (const tableName of [
        'memory_access_log',
        'memory_conflict_queue',
        'memory_injection_events',
        'memory_compaction_survival',
      ]) {
        expect(getTableSql(db, tableName)).not.toContain('_legacy');
      }

      db.prepare(`
        INSERT INTO memory_ingest_journal (
          ingest_id, memory_id, memory_class, content_hash, time_bucket, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('ingest-1', 'memory-1', 'codebase_inventory', 'hash-1', 'bucket-1', 1, 1);
      db.prepare(`
        INSERT INTO memory_objects (
          memory_id, ingest_id, memory_class, tier, status, authority_level, content,
          content_hash, source_trace, confidence, freshness_at, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'memory-1',
        'ingest-1',
        'codebase_inventory',
        'tier3',
        'active',
        'observed',
        'content',
        'hash-1',
        'test',
        0.9,
        1,
        1,
        1
      );
      db.prepare(`
        INSERT INTO memory_promotion_queue (
          candidate_id, memory_id, ingest_id, memory_class, target_file, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('candidate-1', 'memory-1', 'ingest-1', 'codebase_inventory', 'MEMORY.md', 1, 1);
      db.prepare(`
        INSERT INTO memory_access_log (access_id, memory_id, access_kind, created_at)
        VALUES (?, ?, ?, ?)
      `).run('access-1', 'memory-1', 'retrieval', 1);
      db.prepare(`
        INSERT INTO memory_conflict_queue (
          conflict_id, candidate_id, memory_id, target_file, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('conflict-1', 'candidate-1', 'memory-1', 'MEMORY.md', 1, 1);
      db.prepare(`
        INSERT INTO memory_injection_events (
          injection_id, pane_id, trigger_type, memory_id, injection_reason, source_tier, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('injection-1', 'pane-1', 'startup', 'memory-1', 'test', 'tier3', 1, 1);
      db.prepare(`
        INSERT INTO memory_compaction_survival (
          survival_id, note_memory_id, created_at, updated_at
        )
        VALUES (?, ?, ?, ?)
      `).run('survival-1', 'memory-1', 1, 1);
    } finally {
      db.close();
    }
  });

  test('reuses the same sqlite connection on repeated init calls', () => {
    const first = store.init();
    const firstDb = store.db;
    const second = store.init();

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(store.db).toBe(firstDb);
    expect(second.driver).toBe(first.driver);
  });
});
