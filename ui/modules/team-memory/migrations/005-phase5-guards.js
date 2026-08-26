/**
 * Team Memory schema migration v5.
 * Expands guards action support and adds control-plane indexes.
 */

function getTableSql(db, tableName) {
  try {
    const row = db.prepare(`
      SELECT sql
      FROM sqlite_master
      WHERE type = 'table' AND name = ?
    `).get(tableName);
    return String(row?.sql || '');
  } catch {
    return '';
  }
}

function supportsExtendedGuardActions(db) {
  const sql = getTableSql(db, 'guards').toLowerCase();
  if (!sql) return false;
  return sql.includes("'block'") && sql.includes("'suggest'");
}

function createGuardsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS guards (
      id TEXT PRIMARY KEY,
      trigger_condition TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('warn', 'block', 'suggest', 'escalate')),
      source_claim TEXT REFERENCES claims(id),
      source_pattern TEXT REFERENCES patterns(id),
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      created_at INTEGER NOT NULL,
      expires_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_guards_active ON guards(active) WHERE active = 1;
    CREATE INDEX IF NOT EXISTS idx_guards_action ON guards(action);
    CREATE INDEX IF NOT EXISTS idx_guards_source_pattern ON guards(source_pattern);
    CREATE INDEX IF NOT EXISTS idx_guards_source_claim ON guards(source_claim);
  `);
}

function migrateLegacyGuardsTable(db) {
  db.exec(`
    ALTER TABLE guards RENAME TO guards_legacy_v5;
  `);

  createGuardsTable(db);

  db.exec(`
    INSERT INTO guards (
      id, trigger_condition, action, source_claim, source_pattern, active, created_at, expires_at
    )
    SELECT
      id,
      trigger_condition,
      CASE
        WHEN LOWER(action) IN ('warn', 'escalate', 'block', 'suggest') THEN LOWER(action)
        ELSE 'warn'
      END AS action,
      source_claim,
      source_pattern,
      CASE
        WHEN active IS NULL THEN 1
        WHEN active IN (0, 1) THEN active
        ELSE 1
      END AS active,
      COALESCE(created_at, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
      expires_at
    FROM guards_legacy_v5;
  `);

  db.exec('DROP TABLE guards_legacy_v5;');
}

function up(db) {
  if (!getTableSql(db, 'guards')) {
    createGuardsTable(db);
    return;
  }

  if (!supportsExtendedGuardActions(db)) {
    migrateLegacyGuardsTable(db);
  } else {
    createGuardsTable(db);
  }
}

module.exports = {
  version: 5,
  description: 'Phase 5 control plane guard actions + indexes',
  up,
};
