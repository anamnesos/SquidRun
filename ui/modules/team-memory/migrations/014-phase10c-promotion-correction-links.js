/**
 * Team Memory schema migration v14.
 * Adds correction linkage columns to the live promotion queue so correction approvals
 * can supersede the original memory they amend.
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
    'memory_promotion_queue',
    'correction_of',
    'correction_of TEXT'
  );
  addColumnIfMissing(
    db,
    'memory_promotion_queue',
    'supersedes',
    'supersedes TEXT'
  );
}

module.exports = {
  version: 14,
  description: 'Phase 10c promotion correction linkage columns',
  up,
};
