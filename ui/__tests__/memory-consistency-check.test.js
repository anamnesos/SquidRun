const fs = require('fs');
const os = require('os');
const path = require('path');

function createDatabase(filePath) {
  try {
    const { DatabaseSync } = require('node:sqlite');
    return new DatabaseSync(filePath);
  } catch (_) {
    const BetterSqlite3 = require('better-sqlite3');
    return new BetterSqlite3(filePath);
  }
}

describe('memory consistency check', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-memory-consistency-'));
    fs.mkdirSync(path.join(tempDir, 'workspace', 'knowledge'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'workspace', 'memory'), { recursive: true });

    fs.writeFileSync(
      path.join(tempDir, 'workspace', 'knowledge', 'user-context.md'),
      [
        '# User Context',
        '',
        '## Preferences',
        '',
        '- Prefers terse execution.',
        '- Built SquidRun.',
        '',
        '## Communication',
        '',
        '- Expects direct updates.',
      ].join('\n')
    );
  });

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('reports in-sync when knowledge-backed nodes match workspace knowledge', () => {
    const {
      collectKnowledgeEntries,
      runMemoryConsistencyCheck,
    } = require('../modules/memory-consistency-check');
    const { resolveWorkspacePaths } = require('../modules/memory-search');

    const paths = resolveWorkspacePaths({ projectRoot: tempDir });
    const entries = collectKnowledgeEntries(paths);
    const db = createDatabase(path.join(tempDir, 'workspace', 'memory', 'cognitive-memory.db'));
    db.exec(`
      CREATE TABLE nodes (
        node_id TEXT PRIMARY KEY,
        source_type TEXT,
        source_path TEXT,
        title TEXT,
        heading TEXT,
        content TEXT,
        content_hash TEXT,
        updated_at_ms INTEGER DEFAULT 0,
        metadata_json TEXT DEFAULT '{}'
      );
    `);

    entries.forEach((entry, index) => {
      db.prepare(`
        INSERT INTO nodes (
          node_id, source_type, source_path, title, heading, content, content_hash, updated_at_ms, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        `node-${index + 1}`,
        entry.sourceType,
        entry.sourcePath,
        entry.title,
        entry.heading,
        entry.content,
        entry.contentHash,
        Date.now(),
        JSON.stringify(entry.metadata || {})
      );
    });
    db.close();

    const result = runMemoryConsistencyCheck({ projectRoot: tempDir });

    expect(result.ok).toBe(true);
    expect(result.status).toBe('in_sync');
    expect(result.synced).toBe(true);
    expect(result.summary.missingInCognitiveCount).toBe(0);
    expect(result.summary.orphanedNodeCount).toBe(0);
    expect(result.summary.duplicateKnowledgeHashCount).toBe(0);
  });

  test('detects missing and orphaned knowledge-backed nodes', () => {
    const {
      collectKnowledgeEntries,
      hashKnowledgeNodeIdentity,
      runMemoryConsistencyCheck,
    } = require('../modules/memory-consistency-check');
    const { resolveWorkspacePaths } = require('../modules/memory-search');

    const paths = resolveWorkspacePaths({ projectRoot: tempDir });
    const entries = collectKnowledgeEntries(paths);
    const db = createDatabase(path.join(tempDir, 'workspace', 'memory', 'cognitive-memory.db'));
    db.exec(`
      CREATE TABLE nodes (
        node_id TEXT PRIMARY KEY,
        source_type TEXT,
        source_path TEXT,
        title TEXT,
        heading TEXT,
        content TEXT,
        content_hash TEXT,
        updated_at_ms INTEGER DEFAULT 0,
        metadata_json TEXT DEFAULT '{}'
      );
    `);

    const first = entries[0];
    db.prepare(`
      INSERT INTO nodes (
        node_id, source_type, source_path, title, heading, content, content_hash, updated_at_ms, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'node-1',
      first.sourceType,
      first.sourcePath,
      first.title,
      first.heading,
      first.content,
      first.contentHash,
      Date.now(),
      JSON.stringify(first.metadata || {})
    );

    db.prepare(`
      INSERT INTO nodes (
        node_id, source_type, source_path, title, heading, content, content_hash, updated_at_ms, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'orphan-node',
      'knowledge',
      'knowledge/stale.md',
      'Stale',
      'Old Notes',
      'This node no longer has flat-file backing.',
      hashKnowledgeNodeIdentity({
        sourceType: 'knowledge',
        sourcePath: 'knowledge/stale.md',
        heading: 'Old Notes',
        content: 'This node no longer has flat-file backing.',
      }),
      Date.now(),
      '{}'
    );
    db.close();

    const result = runMemoryConsistencyCheck({ projectRoot: tempDir, sampleLimit: 5 });

    expect(result.ok).toBe(true);
    expect(result.status).toBe('drift_detected');
    expect(result.synced).toBe(false);
    expect(result.summary.missingInCognitiveCount).toBe(1);
    expect(result.summary.orphanedNodeCount).toBe(1);
    expect(result.drift.missingKnowledgeEntries[0]).toEqual(expect.objectContaining({
      sourcePath: 'knowledge/user-context.md',
    }));
    expect(result.drift.orphanedKnowledgeNodes[0]).toEqual(expect.objectContaining({
      nodeId: 'orphan-node',
      sourcePath: 'knowledge/stale.md',
    }));
  });
});
