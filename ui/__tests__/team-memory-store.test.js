const fs = require('fs');
const os = require('os');
const path = require('path');

const { TeamMemoryStore, loadSqliteDriver } = require('../modules/team-memory/store');

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
    expect(migration.map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

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
});
