/**
 * Team Memory schema migration v7.
 * Expands claims.status check constraint to include pending_proof.
 */

function hasPendingProofStatus(db) {
  try {
    const row = db.prepare(`
      SELECT sql
      FROM sqlite_master
      WHERE type = 'table' AND name = 'claims'
      LIMIT 1
    `).get();
    const sql = String(row?.sql || '').toLowerCase();
    return sql.includes('pending_proof');
  } catch {
    return false;
  }
}

function recreateClaimsTable(db) {
  db.exec(`
    CREATE TABLE claims_next_v7 (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT UNIQUE,
      statement TEXT NOT NULL,
      claim_type TEXT NOT NULL CHECK (claim_type IN ('fact', 'decision', 'hypothesis', 'negative')),
      owner TEXT NOT NULL,
      confidence REAL DEFAULT 1.0 CHECK (confidence BETWEEN 0.0 AND 1.0),
      status TEXT DEFAULT 'proposed' CHECK (status IN ('proposed', 'confirmed', 'contested', 'pending_proof', 'deprecated')),
      supersedes TEXT REFERENCES claims_next_v7(id),
      session TEXT,
      ttl_hours INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    INSERT INTO claims_next_v7 (
      id,
      idempotency_key,
      statement,
      claim_type,
      owner,
      confidence,
      status,
      supersedes,
      session,
      ttl_hours,
      created_at,
      updated_at
    )
    SELECT
      id,
      idempotency_key,
      statement,
      claim_type,
      owner,
      confidence,
      CASE
        WHEN status IN ('proposed', 'confirmed', 'contested', 'pending_proof', 'deprecated') THEN status
        ELSE 'proposed'
      END AS status,
      supersedes,
      session,
      ttl_hours,
      created_at,
      updated_at
    FROM claims;

    DROP TABLE claims;

    ALTER TABLE claims_next_v7 RENAME TO claims;

    CREATE INDEX IF NOT EXISTS idx_claims_status ON claims(status);
    CREATE INDEX IF NOT EXISTS idx_claims_owner ON claims(owner);
    CREATE INDEX IF NOT EXISTS idx_claims_type ON claims(claim_type);
    CREATE INDEX IF NOT EXISTS idx_claims_session ON claims(session);
    CREATE INDEX IF NOT EXISTS idx_claims_created ON claims(created_at);
  `);
}

function up(db) {
  if (hasPendingProofStatus(db)) return;

  db.exec('PRAGMA foreign_keys = OFF;');
  try {
    db.exec('BEGIN IMMEDIATE;');
    recreateClaimsTable(db);
    db.exec('COMMIT;');
  } catch (err) {
    try { db.exec('ROLLBACK;'); } catch {}
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON;');
  }
}

module.exports = {
  version: 7,
  description: 'Phase 6b pending_proof claim status',
  up,
};
