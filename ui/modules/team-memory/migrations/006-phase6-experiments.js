/**
 * Team Memory schema migration v6.
 * Adds Experiment Engine foundation table and indexes.
 */

function hasColumn(db, tableName, columnName) {
  try {
    const rows = db.prepare(`PRAGMA table_info(${tableName})`).all();
    return rows.some((row) => String(row?.name || '').toLowerCase() === String(columnName).toLowerCase());
  } catch {
    return false;
  }
}

function runAlter(db, sql) {
  try {
    db.exec(sql);
  } catch (err) {
    if (/duplicate column name/i.test(err.message)) return;
    throw err;
  }
}

function ensureColumns(db) {
  const missingColumnSql = [
    ['idempotency_key', `ALTER TABLE experiments ADD COLUMN idempotency_key TEXT`],
    ['claim_id', `ALTER TABLE experiments ADD COLUMN claim_id TEXT REFERENCES claims(id)`],
    ['profile', `ALTER TABLE experiments ADD COLUMN profile TEXT NOT NULL DEFAULT 'unknown'`],
    ['command', `ALTER TABLE experiments ADD COLUMN command TEXT NOT NULL DEFAULT ''`],
    ['requested_by', `ALTER TABLE experiments ADD COLUMN requested_by TEXT NOT NULL DEFAULT 'system'`],
    ['relation', `ALTER TABLE experiments ADD COLUMN relation TEXT CHECK (relation IN ('supports', 'contradicts', 'caused_by'))`],
    ['guard_context', `ALTER TABLE experiments ADD COLUMN guard_context TEXT`],
    ['status', `ALTER TABLE experiments ADD COLUMN status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'timed_out', 'canceled', 'attach_pending', 'attached'))`],
    ['exit_code', `ALTER TABLE experiments ADD COLUMN exit_code INTEGER`],
    ['duration_ms', `ALTER TABLE experiments ADD COLUMN duration_ms INTEGER`],
    ['stdout_hash', `ALTER TABLE experiments ADD COLUMN stdout_hash TEXT`],
    ['stderr_hash', `ALTER TABLE experiments ADD COLUMN stderr_hash TEXT`],
    ['git_sha', `ALTER TABLE experiments ADD COLUMN git_sha TEXT`],
    ['evidence_ref', `ALTER TABLE experiments ADD COLUMN evidence_ref TEXT`],
    ['session', `ALTER TABLE experiments ADD COLUMN session TEXT`],
    ['timeout_ms', `ALTER TABLE experiments ADD COLUMN timeout_ms INTEGER`],
    ['output_cap_bytes', `ALTER TABLE experiments ADD COLUMN output_cap_bytes INTEGER`],
    ['artifact_dir', `ALTER TABLE experiments ADD COLUMN artifact_dir TEXT`],
    ['cwd', `ALTER TABLE experiments ADD COLUMN cwd TEXT`],
    ['stdout_bytes', `ALTER TABLE experiments ADD COLUMN stdout_bytes INTEGER NOT NULL DEFAULT 0`],
    ['stderr_bytes', `ALTER TABLE experiments ADD COLUMN stderr_bytes INTEGER NOT NULL DEFAULT 0`],
    ['truncated', `ALTER TABLE experiments ADD COLUMN truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1))`],
    ['redacted', `ALTER TABLE experiments ADD COLUMN redacted INTEGER NOT NULL DEFAULT 0 CHECK (redacted IN (0, 1))`],
    ['error_message', `ALTER TABLE experiments ADD COLUMN error_message TEXT`],
    ['created_at', `ALTER TABLE experiments ADD COLUMN created_at INTEGER`],
    ['updated_at', `ALTER TABLE experiments ADD COLUMN updated_at INTEGER`],
    ['started_at', `ALTER TABLE experiments ADD COLUMN started_at INTEGER`],
    ['completed_at', `ALTER TABLE experiments ADD COLUMN completed_at INTEGER`],
  ];

  for (const [columnName, sql] of missingColumnSql) {
    if (!hasColumn(db, 'experiments', columnName)) {
      runAlter(db, sql);
    }
  }
}

function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS experiments (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT UNIQUE,
      claim_id TEXT REFERENCES claims(id),
      profile TEXT NOT NULL,
      command TEXT NOT NULL,
      requested_by TEXT NOT NULL,
      relation TEXT CHECK (relation IN ('supports', 'contradicts', 'caused_by')),
      guard_context TEXT,
      status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'timed_out', 'canceled', 'attach_pending', 'attached')),
      exit_code INTEGER,
      duration_ms INTEGER,
      stdout_hash TEXT,
      stderr_hash TEXT,
      git_sha TEXT,
      evidence_ref TEXT,
      session TEXT,
      timeout_ms INTEGER,
      output_cap_bytes INTEGER,
      artifact_dir TEXT,
      cwd TEXT,
      stdout_bytes INTEGER NOT NULL DEFAULT 0,
      stderr_bytes INTEGER NOT NULL DEFAULT 0,
      truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),
      redacted INTEGER NOT NULL DEFAULT 0 CHECK (redacted IN (0, 1)),
      error_message TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER,
      started_at INTEGER,
      completed_at INTEGER
    );
  `);

  ensureColumns(db);

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_experiments_idempotency
    ON experiments(idempotency_key)
    WHERE idempotency_key IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_experiments_claim ON experiments(claim_id);
    CREATE INDEX IF NOT EXISTS idx_experiments_status ON experiments(status);
    CREATE INDEX IF NOT EXISTS idx_experiments_session ON experiments(session);
    CREATE INDEX IF NOT EXISTS idx_experiments_created ON experiments(created_at DESC);
  `);
}

module.exports = {
  version: 6,
  description: 'Phase 6 experiment engine foundation schema',
  up,
};
