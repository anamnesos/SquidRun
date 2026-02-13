/**
 * Team Memory schema migration v3.
 * Adds search index structures for Phase 2 retrieval.
 */

function createFtsOrFallback(db) {
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS claim_search USING fts5(
        claim_id UNINDEXED,
        statement,
        tokenize='unicode61'
      );
    `);
    return { fts: true };
  } catch {
    db.exec(`
      CREATE TABLE IF NOT EXISTS claim_search (
        claim_id TEXT PRIMARY KEY,
        statement TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_claim_search_statement ON claim_search(statement);
    `);
    return { fts: false };
  }
}

function up(db) {
  const { fts } = createFtsOrFallback(db);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS claim_search_ai
    AFTER INSERT ON claims
    BEGIN
      INSERT INTO claim_search (claim_id, statement)
      VALUES (NEW.id, NEW.statement);
    END;

    CREATE TRIGGER IF NOT EXISTS claim_search_au
    AFTER UPDATE OF id, statement ON claims
    BEGIN
      DELETE FROM claim_search WHERE claim_id = OLD.id;
      INSERT INTO claim_search (claim_id, statement)
      VALUES (NEW.id, NEW.statement);
    END;

    CREATE TRIGGER IF NOT EXISTS claim_search_ad
    AFTER DELETE ON claims
    BEGIN
      DELETE FROM claim_search WHERE claim_id = OLD.id;
    END;
  `);

  if (fts) {
    db.exec('DELETE FROM claim_search;');
    db.exec(`
      INSERT INTO claim_search (claim_id, statement)
      SELECT id, statement
      FROM claims;
    `);
  } else {
    db.exec(`
      INSERT OR REPLACE INTO claim_search (claim_id, statement)
      SELECT id, statement
      FROM claims;
    `);
  }
}

module.exports = {
  version: 3,
  description: 'Phase 2 search index (FTS5 + trigger sync)',
  up,
};
