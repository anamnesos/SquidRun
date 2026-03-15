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

function createCognitiveSchema(db) {
  db.exec(`
    CREATE TABLE nodes (
      node_id TEXT PRIMARY KEY,
      category TEXT,
      content TEXT,
      confidence_score REAL DEFAULT 0.5,
      access_count INTEGER DEFAULT 0,
      last_accessed_at TEXT,
      last_reconsolidated_at TEXT,
      source_type TEXT,
      source_path TEXT,
      title TEXT,
      heading TEXT,
      content_hash TEXT,
      current_version INTEGER DEFAULT 1,
      salience_score REAL DEFAULT 0,
      embedding_json TEXT DEFAULT '[]',
      metadata_json TEXT DEFAULT '{}',
      created_at_ms INTEGER DEFAULT 0,
      updated_at_ms INTEGER DEFAULT 0
    );

    CREATE TABLE edges (
      source_node_id TEXT,
      target_node_id TEXT,
      relation_type TEXT,
      weight REAL DEFAULT 1.0
    );

    CREATE TABLE traces (
      node_id TEXT,
      trace_id TEXT,
      extracted_at TEXT
    );

    CREATE TABLE memory_leases (
      lease_id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      query_text TEXT,
      expires_at_ms INTEGER NOT NULL,
      version_at_lease INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
  `);
}

function insertKnowledgeNode(db, input = {}, helpers) {
  const nowMs = Number(input.updatedAtMs || Date.now());
  const sourceType = input.sourceType || 'knowledge';
  const contentHash = input.contentHash || helpers.hashKnowledgeNodeIdentity({
    sourceType,
    sourcePath: input.sourcePath,
    heading: input.heading,
    content: input.content,
  });
  db.prepare(`
    INSERT INTO nodes (
      node_id, category, content, confidence_score, access_count, last_accessed_at,
      last_reconsolidated_at, source_type, source_path, title, heading, content_hash,
      current_version, salience_score, embedding_json, metadata_json, created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.nodeId,
    'knowledge',
    input.content,
    Number(input.confidenceScore || 0.5),
    Number(input.accessCount || 0),
    input.lastAccessedAt || null,
    input.lastReconsolidatedAt || null,
    sourceType,
    input.sourcePath,
    input.title || null,
    input.heading || null,
    contentHash,
    Number(input.currentVersion || 1),
    Number(input.salienceScore || 0),
    input.embeddingJson || '[]',
    JSON.stringify(input.metadata || {}),
    Number(input.createdAtMs || nowMs),
    nowMs
  );
  return contentHash;
}

describe('memory consistency check', () => {
  let tempDir;
  let helpers;

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

    helpers = require('../modules/memory-consistency-check');
  });

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    jest.resetModules();
  });

  test('reports in-sync when knowledge-backed nodes match workspace knowledge', () => {
    const { collectKnowledgeEntries, runMemoryConsistencyCheck } = helpers;
    const { resolveWorkspacePaths } = require('../modules/memory-search');

    const paths = resolveWorkspacePaths({ projectRoot: tempDir });
    const entries = collectKnowledgeEntries(paths);
    const db = createDatabase(path.join(tempDir, 'workspace', 'memory', 'cognitive-memory.db'));
    createCognitiveSchema(db);

    entries.forEach((entry, index) => {
      insertKnowledgeNode(db, {
        nodeId: `node-${index + 1}`,
        sourcePath: entry.sourcePath,
        title: entry.title,
        heading: entry.heading,
        content: entry.content,
        contentHash: entry.contentHash,
        metadata: entry.metadata,
      }, helpers);
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

  test('dry-run plans safe repair actions without mutating the DB', () => {
    const {
      collectKnowledgeEntries,
      planMemoryConsistencyRepair,
    } = helpers;
    const { resolveWorkspacePaths } = require('../modules/memory-search');

    const paths = resolveWorkspacePaths({ projectRoot: tempDir });
    const entries = collectKnowledgeEntries(paths);
    const dbPath = path.join(tempDir, 'workspace', 'memory', 'cognitive-memory.db');
    const db = createDatabase(dbPath);
    createCognitiveSchema(db);

    insertKnowledgeNode(db, {
      nodeId: 'node-match',
      sourcePath: entries[0].sourcePath,
      title: entries[0].title,
      heading: entries[0].heading,
      content: entries[0].content,
      contentHash: entries[0].contentHash,
      metadata: entries[0].metadata,
    }, helpers);
    insertKnowledgeNode(db, {
      nodeId: 'node-orphan',
      sourcePath: entries[1].sourcePath,
      title: entries[1].title,
      heading: entries[1].heading,
      content: 'Old communication guidance.',
      metadata: { old: true },
    }, helpers);

    const beforeCount = Number(db.prepare('SELECT COUNT(*) AS count FROM nodes').get().count || 0);
    db.close();

    const result = planMemoryConsistencyRepair({ projectRoot: tempDir });

    expect(result.mode).toBe('dry_run');
    expect(result.summary.insertCount).toBe(1);
    expect(result.summary.orphanDeleteCount).toBe(1);
    expect(result.skipped).toEqual([]);

    const verifyDb = createDatabase(dbPath);
    const afterCount = Number(verifyDb.prepare('SELECT COUNT(*) AS count FROM nodes').get().count || 0);
    verifyDb.close();
    expect(afterCount).toBe(beforeCount);
  });

  test('repair inserts missing chunks, deletes safe revision-skew orphans, and writes audit events', () => {
    const {
      collectKnowledgeEntries,
      runMemoryConsistencyRepair,
    } = helpers;
    const { resolveWorkspacePaths } = require('../modules/memory-search');

    const paths = resolveWorkspacePaths({ projectRoot: tempDir });
    const entries = collectKnowledgeEntries(paths);
    const dbPath = path.join(tempDir, 'workspace', 'memory', 'cognitive-memory.db');
    const evidenceLedgerDbPath = path.join(tempDir, 'runtime', 'evidence-ledger.db');
    fs.mkdirSync(path.dirname(evidenceLedgerDbPath), { recursive: true });

    const db = createDatabase(dbPath);
    createCognitiveSchema(db);
    insertKnowledgeNode(db, {
      nodeId: 'node-match',
      sourcePath: entries[0].sourcePath,
      title: entries[0].title,
      heading: entries[0].heading,
      content: entries[0].content,
      contentHash: entries[0].contentHash,
      metadata: entries[0].metadata,
    }, helpers);
    insertKnowledgeNode(db, {
      nodeId: 'node-orphan',
      sourcePath: entries[1].sourcePath,
      title: entries[1].title,
      heading: entries[1].heading,
      content: 'Old communication guidance.',
      metadata: { old: true },
    }, helpers);
    db.close();

    const result = runMemoryConsistencyRepair({
      projectRoot: tempDir,
      evidenceLedgerDbPath,
    });

    expect(result.ok).toBe(true);
    expect(result.execution.insertedNodes).toBe(1);
    expect(result.execution.deletedNodes).toBe(1);
    expect(result.postCheck.status).toBe('in_sync');
    expect(result.postCheck.synced).toBe(true);

    const verifyDb = createDatabase(dbPath);
    const nodeCount = Number(verifyDb.prepare('SELECT COUNT(*) AS count FROM nodes').get().count || 0);
    verifyDb.close();
    expect(nodeCount).toBe(entries.length);

    const evidenceDb = createDatabase(evidenceLedgerDbPath);
    const auditCount = Number(evidenceDb.prepare('SELECT COUNT(*) AS count FROM ledger_events').get().count || 0);
    evidenceDb.close();
    expect(auditCount).toBe(2);
  });

  test('repair skips deleted-source orphans with an explanation', () => {
    const { runMemoryConsistencyRepair } = helpers;

    const db = createDatabase(path.join(tempDir, 'workspace', 'memory', 'cognitive-memory.db'));
    createCognitiveSchema(db);
    insertKnowledgeNode(db, {
      nodeId: 'deleted-orphan',
      sourcePath: 'knowledge/deleted.md',
      title: 'Deleted',
      heading: 'Removed Section',
      content: 'This file no longer exists.',
    }, helpers);
    db.close();

    const result = runMemoryConsistencyRepair({
      projectRoot: tempDir,
      evidenceLedgerDbPath: path.join(tempDir, 'runtime', 'evidence-ledger.db'),
    });

    expect(result.ok).toBe(true);
    expect(result.summary.insertCount).toBe(2);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toEqual(expect.objectContaining({
      driftType: 'deleted_source',
    }));
    expect(result.postCheck.summary.orphanedNodeCount).toBe(1);
  });

  test('repair skips orphan deletion when migration-worthy relational data is attached', () => {
    const {
      collectKnowledgeEntries,
      runMemoryConsistencyRepair,
    } = helpers;
    const { resolveWorkspacePaths } = require('../modules/memory-search');

    const paths = resolveWorkspacePaths({ projectRoot: tempDir });
    const entries = collectKnowledgeEntries(paths);
    const db = createDatabase(path.join(tempDir, 'workspace', 'memory', 'cognitive-memory.db'));
    createCognitiveSchema(db);
    insertKnowledgeNode(db, {
      nodeId: 'relational-orphan',
      sourcePath: entries[0].sourcePath,
      title: entries[0].title,
      heading: entries[0].heading,
      content: 'Older preference statement.',
      currentVersion: 2,
    }, helpers);
    insertKnowledgeNode(db, {
      nodeId: 'helper-node',
      sourcePath: entries[1].sourcePath,
      title: entries[1].title,
      heading: entries[1].heading,
      content: entries[1].content,
      contentHash: entries[1].contentHash,
      metadata: entries[1].metadata,
    }, helpers);
    db.prepare(`
      INSERT INTO edges (source_node_id, target_node_id, relation_type, weight)
      VALUES (?, ?, ?, ?)
    `).run('relational-orphan', 'helper-node', 'supports', 1.0);
    db.prepare(`
      INSERT INTO traces (node_id, trace_id, extracted_at)
      VALUES (?, ?, ?)
    `).run('relational-orphan', 'reconsolidation:lease-1', new Date().toISOString());
    db.close();

    const result = runMemoryConsistencyRepair({
      projectRoot: tempDir,
      evidenceLedgerDbPath: path.join(tempDir, 'runtime', 'evidence-ledger.db'),
    });

    expect(result.ok).toBe(true);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toEqual(expect.objectContaining({
      driftType: 'relational_migration_required',
    }));
    expect(result.actions.some((action) => action.kind === 'delete_revision_skew_orphan')).toBe(false);
  });

  test('repair consolidates duplicate hashes and preserves traces and edges on the survivor', () => {
    const {
      collectKnowledgeEntries,
      runMemoryConsistencyRepair,
    } = helpers;
    const { resolveWorkspacePaths } = require('../modules/memory-search');

    const paths = resolveWorkspacePaths({ projectRoot: tempDir });
    const entries = collectKnowledgeEntries(paths);
    const dbPath = path.join(tempDir, 'workspace', 'memory', 'cognitive-memory.db');
    const db = createDatabase(dbPath);
    createCognitiveSchema(db);

    insertKnowledgeNode(db, {
      nodeId: 'dup-survivor',
      sourcePath: entries[0].sourcePath,
      title: entries[0].title,
      heading: entries[0].heading,
      content: entries[0].content,
      contentHash: entries[0].contentHash,
      metadata: entries[0].metadata,
      accessCount: 5,
      lastAccessedAt: '2026-03-15T10:00:00.000Z',
    }, helpers);
    insertKnowledgeNode(db, {
      nodeId: 'dup-loser',
      sourcePath: entries[0].sourcePath,
      title: entries[0].title,
      heading: entries[0].heading,
      content: entries[0].content,
      contentHash: entries[0].contentHash,
      metadata: entries[0].metadata,
      accessCount: 1,
    }, helpers);
    insertKnowledgeNode(db, {
      nodeId: 'helper-node',
      sourcePath: entries[1].sourcePath,
      title: entries[1].title,
      heading: entries[1].heading,
      content: entries[1].content,
      contentHash: entries[1].contentHash,
      metadata: entries[1].metadata,
    }, helpers);
    db.prepare(`
      INSERT INTO traces (node_id, trace_id, extracted_at)
      VALUES (?, ?, ?)
    `).run('dup-loser', 'memory-document:42', '2026-03-15T10:00:00.000Z');
    db.prepare(`
      INSERT INTO edges (source_node_id, target_node_id, relation_type, weight)
      VALUES (?, ?, ?, ?)
    `).run('dup-loser', 'helper-node', 'supports', 2.0);
    db.close();

    const result = runMemoryConsistencyRepair({
      projectRoot: tempDir,
      evidenceLedgerDbPath: path.join(tempDir, 'runtime', 'evidence-ledger.db'),
    });

    expect(result.ok).toBe(true);
    expect(result.execution.mergedDuplicateGroups).toBe(1);
    expect(result.postCheck.status).toBe('in_sync');

    const verifyDb = createDatabase(dbPath);
    const duplicateCount = Number(verifyDb.prepare(`
      SELECT COUNT(*) AS count
      FROM nodes
      WHERE content_hash = ?
    `).get(entries[0].contentHash).count || 0);
    const traceCount = Number(verifyDb.prepare(`
      SELECT COUNT(*) AS count
      FROM traces
      WHERE node_id = ? AND trace_id = ?
    `).get('dup-survivor', 'memory-document:42').count || 0);
    const edgeCount = Number(verifyDb.prepare(`
      SELECT COUNT(*) AS count
      FROM edges
      WHERE source_node_id = ? AND target_node_id = ?
    `).get('dup-survivor', 'helper-node').count || 0);
    verifyDb.close();

    expect(duplicateCount).toBe(1);
    expect(traceCount).toBe(1);
    expect(edgeCount).toBe(1);
  });
});
