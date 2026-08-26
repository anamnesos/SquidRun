/**
 * Team Memory schema migration v2.
 * Compatibility patch for DBs created by early Phase 0 scaffold.
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
    // Duplicate-column and similar no-op errors are expected in mixed environments.
    if (/duplicate column name/i.test(err.message)) return;
    throw err;
  }
}

function up(db) {
  if (!hasColumn(db, 'claim_evidence', 'added_by')) {
    runAlter(db, `ALTER TABLE claim_evidence ADD COLUMN added_by TEXT NOT NULL DEFAULT 'system'`);
  }

  if (!hasColumn(db, 'decisions', 'decided_by')) {
    runAlter(db, `ALTER TABLE decisions ADD COLUMN decided_by TEXT NOT NULL DEFAULT 'system'`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS consensus (
      id TEXT PRIMARY KEY,
      claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
      agent TEXT NOT NULL,
      position TEXT NOT NULL CHECK (position IN ('support', 'challenge', 'abstain')),
      reason TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(claim_id, agent)
    );

    CREATE INDEX IF NOT EXISTS idx_consensus_claim ON consensus(claim_id);

    CREATE TABLE IF NOT EXISTS belief_snapshots (
      id TEXT PRIMARY KEY,
      agent TEXT NOT NULL,
      session TEXT NOT NULL,
      snapshot_at INTEGER NOT NULL,
      beliefs TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_agent ON belief_snapshots(agent);
    CREATE INDEX IF NOT EXISTS idx_snapshots_session ON belief_snapshots(session);

    CREATE TABLE IF NOT EXISTS belief_contradictions (
      id TEXT PRIMARY KEY,
      snapshot_id TEXT NOT NULL REFERENCES belief_snapshots(id) ON DELETE CASCADE,
      claim_a TEXT NOT NULL REFERENCES claims(id),
      claim_b TEXT NOT NULL REFERENCES claims(id),
      agent TEXT NOT NULL,
      session TEXT NOT NULL,
      detected_at INTEGER NOT NULL,
      reason TEXT,
      resolved_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_contradictions_agent ON belief_contradictions(agent);
    CREATE INDEX IF NOT EXISTS idx_contradictions_session ON belief_contradictions(session);
    CREATE INDEX IF NOT EXISTS idx_contradictions_claim_a ON belief_contradictions(claim_a);
    CREATE INDEX IF NOT EXISTS idx_contradictions_claim_b ON belief_contradictions(claim_b);
    CREATE INDEX IF NOT EXISTS idx_contradictions_resolved_at ON belief_contradictions(resolved_at);

    CREATE TABLE IF NOT EXISTS patterns (
      id TEXT PRIMARY KEY,
      pattern_type TEXT NOT NULL CHECK (pattern_type IN ('handoff_loop', 'escalation_spiral', 'stall', 'contradiction_cluster')),
      agents TEXT NOT NULL,
      scope TEXT,
      frequency INTEGER DEFAULT 1,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      risk_score REAL CHECK (risk_score BETWEEN 0.0 AND 1.0),
      resolution TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_patterns_type ON patterns(pattern_type);
    CREATE INDEX IF NOT EXISTS idx_patterns_risk ON patterns(risk_score);

    CREATE TABLE IF NOT EXISTS guards (
      id TEXT PRIMARY KEY,
      trigger_condition TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('warn', 'escalate')),
      source_claim TEXT REFERENCES claims(id),
      source_pattern TEXT REFERENCES patterns(id),
      active INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL,
      expires_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_guards_active ON guards(active) WHERE active = 1;
  `);
}

module.exports = {
  version: 2,
  description: 'Phase 1 compatibility patch (columns + consensus/belief/pattern/guard tables)',
  up,
};
