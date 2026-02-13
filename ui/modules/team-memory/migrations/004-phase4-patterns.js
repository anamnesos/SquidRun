/**
 * Team Memory schema migration v4.
 * Adds Pattern Engine compatibility columns/tables.
 */

function hasTable(db, tableName) {
  try {
    const row = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = ?
    `).get(tableName);
    return Boolean(row?.name);
  } catch {
    return false;
  }
}

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
  if (hasTable(db, 'patterns')) {
    if (!hasColumn(db, 'patterns', 'active')) {
      runAlter(db, `ALTER TABLE patterns ADD COLUMN active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))`);
    }
    if (!hasColumn(db, 'patterns', 'confidence')) {
      runAlter(db, `ALTER TABLE patterns ADD COLUMN confidence REAL NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0.0 AND 1.0)`);
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_patterns_active ON patterns(active);
      UPDATE patterns
      SET confidence = CASE
        WHEN risk_score IS NULL THEN confidence
        ELSE MAX(0.0, MIN(1.0, risk_score))
      END;
    `);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS pattern_mining_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_processed_at INTEGER,
      processed_events INTEGER NOT NULL DEFAULT 0
    );

    INSERT OR IGNORE INTO pattern_mining_state (id, last_processed_at, processed_events)
    VALUES (1, NULL, 0);
  `);
}

module.exports = {
  version: 4,
  description: 'Phase 4 pattern engine columns + mining state',
  up,
};
