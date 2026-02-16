/**
 * Team Memory schema migration v8.
 * Adds contradiction resolution timestamp and backfills historical resolved rows.
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

function up(db) {
  if (!hasColumn(db, 'belief_contradictions', 'resolved_at')) {
    runAlter(db, 'ALTER TABLE belief_contradictions ADD COLUMN resolved_at INTEGER');
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_contradictions_resolved_at
    ON belief_contradictions(resolved_at);
  `);

  // Preserve history while marking already-resolved contradictions as resolved.
  db.exec(`
    UPDATE belief_contradictions
    SET resolved_at = COALESCE(
      resolved_at,
      CAST(strftime('%s', 'now') AS INTEGER) * 1000
    )
    WHERE resolved_at IS NULL
      AND (
        EXISTS (
          SELECT 1
          FROM claims c
          WHERE c.id = belief_contradictions.claim_a
            AND c.status = 'deprecated'
        )
        OR EXISTS (
          SELECT 1
          FROM claims c
          WHERE c.id = belief_contradictions.claim_b
            AND c.status = 'deprecated'
        )
        OR EXISTS (
          SELECT 1
          FROM claims c
          WHERE c.supersedes = belief_contradictions.claim_a
        )
        OR EXISTS (
          SELECT 1
          FROM claims c
          WHERE c.supersedes = belief_contradictions.claim_b
        )
      );
  `);
}

module.exports = {
  version: 8,
  description: 'Phase 6c contradiction resolved_at + historical backfill',
  up,
};
