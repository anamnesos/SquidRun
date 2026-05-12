'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDatabase } = require('../modules/sqlite-compat');
const {
  MIRA_MEMORY_CURIOSITY_SCHEMA,
  readMiraMemoryCuriosity,
} = require('../modules/mira-memory-curiosity');

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mira-memory-curiosity-'));
}

function seedMemoryDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openDatabase(dbPath);
  try {
    db.exec(`
      CREATE TABLE nodes (
        node_id TEXT PRIMARY KEY,
        category TEXT,
        title TEXT,
        source_type TEXT,
        source_path TEXT,
        content TEXT,
        confidence_score REAL DEFAULT 0.5,
        access_count INTEGER DEFAULT 0,
        updated_at_ms INTEGER DEFAULT 0
      );
    `);
    db.prepare(`
      INSERT INTO nodes (
        node_id, category, title, source_type, source_path, content, confidence_score, access_count, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'node-mira-memory',
      'mira',
      'Mira source/action substrate continuity',
      'test',
      'fixture',
      'Mira should use memory retrieval for current lane continuity before asking James to restate the source action substrate context.',
      0.9,
      3,
      100,
    );
    db.prepare(`
      INSERT INTO nodes (
        node_id, category, title, source_type, source_path, content, confidence_score, access_count, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'node-unrelated',
      'misc',
      'Unrelated',
      'test',
      'fixture',
      'A note about something else.',
      0.2,
      0,
      90,
    );
  } finally {
    db.close();
  }
}

describe('Mira memory curiosity read adapter', () => {
  test('reads cognitive memory rows for the active lane without creating writes or leases', () => {
    const projectRoot = tempProject();
    const dbPath = path.join(projectRoot, '.squidrun', 'runtime', 'cognitive-memory.db');
    seedMemoryDb(dbPath);

    const result = readMiraMemoryCuriosity({
      query: 'Mira source action substrate continuity',
      limit: 2,
    }, { projectRoot, dbPath });

    expect(result.schema).toBe(MIRA_MEMORY_CURIOSITY_SCHEMA);
    expect(result.decision).toBe('memory_retrieved_read_only');
    expect(result.no_mutation_performed).toBe(true);
    expect(result.consequence_controls).toEqual(expect.objectContaining({
      read_only: true,
      memory_write_performed: false,
      lease_created: false,
      access_log_updated: false,
      external_send_performed: false,
    }));
    expect(result.results[0]).toEqual(expect.objectContaining({
      nodeId: 'node-mira-memory',
      sourceType: 'test',
      title: 'Mira source/action substrate continuity',
      contentExcerpt: expect.stringContaining('Mira should use memory retrieval'),
    }));
    expect(JSON.stringify(result.results[0])).not.toMatch(/embedding/i);
    expect(result.results[0].source_type).toBeUndefined();
  });

  test('reports unavailable instead of creating a missing memory database', () => {
    const projectRoot = tempProject();
    const dbPath = path.join(projectRoot, '.squidrun', 'runtime', 'missing-memory.db');

    const result = readMiraMemoryCuriosity({ query: 'anything' }, { projectRoot, dbPath });

    expect(result.ok).toBe(false);
    expect(result.decision).toBe('unavailable_in_this_runtime');
    expect(result.reason).toBe('memory_db_missing');
    expect(fs.existsSync(dbPath)).toBe(false);
  });
});
