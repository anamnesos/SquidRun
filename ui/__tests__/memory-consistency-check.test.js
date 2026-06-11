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
      is_immune INTEGER DEFAULT 0,
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
      current_version, salience_score, is_immune, embedding_json, metadata_json, created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    input.isImmune ? 1 : 0,
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
  let originalProfile;

  beforeEach(() => {
    originalProfile = process.env.SQUIDRUN_PROFILE;
    process.env.SQUIDRUN_PROFILE = 'main';
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-memory-consistency-'));
    fs.mkdirSync(path.join(tempDir, 'workspace', 'knowledge'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'workspace', 'memory'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, '.squidrun', 'runtime'), { recursive: true });

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
    if (originalProfile === undefined) {
      delete process.env.SQUIDRUN_PROFILE;
    } else {
      process.env.SQUIDRUN_PROFILE = originalProfile;
    }
    jest.resetModules();
  });

  test('reports in-sync when knowledge-backed nodes match workspace knowledge', () => {
    const { collectKnowledgeEntries, runMemoryConsistencyCheck } = helpers;
    const { resolveWorkspacePaths } = require('../modules/memory-search');

    const paths = resolveWorkspacePaths({ projectRoot: tempDir });
    const entries = collectKnowledgeEntries(paths);
    const db = createDatabase(path.join(tempDir, '.squidrun', 'runtime', 'cognitive-memory.db'));
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

  test('side-profile shared workspace junction compares shared corpus against main DB', () => {
    const { collectKnowledgeEntries, runMemoryConsistencyCheck } = helpers;
    const { resolveWorkspacePaths } = require('../modules/memory-search');

    const mainRoot = path.join(tempDir, 'main-root');
    const profileRoot = path.join(tempDir, 'profiles', 'eunbyeol', 'workspace');
    const mainWorkspace = path.join(mainRoot, 'workspace');
    fs.mkdirSync(path.join(mainWorkspace, 'knowledge'), { recursive: true });
    fs.mkdirSync(path.join(mainWorkspace, 'memory'), { recursive: true });
    fs.mkdirSync(path.join(mainRoot, '.squidrun', 'runtime'), { recursive: true });
    fs.mkdirSync(path.join(profileRoot, '.squidrun', 'runtime-eunbyeol'), { recursive: true });
    fs.symlinkSync(mainWorkspace, path.join(profileRoot, 'workspace'), process.platform === 'win32' ? 'junction' : 'dir');

    fs.writeFileSync(
      path.join(mainWorkspace, 'knowledge', 'shared.md'),
      [
        '# Shared',
        '',
        '## Main Corpus',
        '',
        '- This corpus belongs to the main cognitive DB.',
      ].join('\n')
    );

    const mainPaths = resolveWorkspacePaths({ projectRoot: mainRoot });
    const entries = collectKnowledgeEntries(mainPaths);
    const mainDbPath = path.join(mainRoot, '.squidrun', 'runtime', 'cognitive-memory.db');
    const mainDb = createDatabase(mainDbPath);
    createCognitiveSchema(mainDb);
    entries.forEach((entry, index) => {
      insertKnowledgeNode(mainDb, {
        nodeId: `main-node-${index + 1}`,
        sourcePath: entry.sourcePath,
        title: entry.title,
        heading: entry.heading,
        content: entry.content,
        contentHash: entry.contentHash,
        metadata: entry.metadata,
      }, helpers);
    });
    mainDb.close();

    const profileDb = createDatabase(path.join(profileRoot, '.squidrun', 'runtime-eunbyeol', 'cognitive-memory.db'));
    createCognitiveSchema(profileDb);
    profileDb.close();

    const result = runMemoryConsistencyCheck({
      projectRoot: profileRoot,
      profileName: 'eunbyeol',
    });

    expect(result.status).toBe('in_sync');
    expect(result.synced).toBe(true);
    expect(result.evaluatedScope).toBe('shared-main');
    expect(result.scope).toEqual(expect.objectContaining({
      requestedProfile: 'eunbyeol',
      reason: 'profile_workspace_junction_to_shared_corpus',
      requestedProjectRoot: path.resolve(profileRoot),
      effectiveProjectRoot: path.resolve(mainRoot),
      profileCognitiveDbPath: path.resolve(profileRoot, '.squidrun', 'runtime-eunbyeol', 'cognitive-memory.db'),
      cognitiveDbPath: path.resolve(mainDbPath),
    }));
    expect(result.workspaceDir).toBe(fs.realpathSync.native(mainWorkspace));
    expect(result.cognitiveDbPath).toBe(path.resolve(mainDbPath));
    expect(result.summary.knowledgeEntryCount).toBe(entries.length);
    expect(result.summary.knowledgeNodeCount).toBe(entries.length);
  });

  test('dry-run plans safe repair actions without mutating the DB', () => {
    const {
      collectKnowledgeEntries,
      planMemoryConsistencyRepair,
    } = helpers;
    const { resolveWorkspacePaths } = require('../modules/memory-search');

    const paths = resolveWorkspacePaths({ projectRoot: tempDir });
    const entries = collectKnowledgeEntries(paths);
    const dbPath = path.join(tempDir, '.squidrun', 'runtime', 'cognitive-memory.db');
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

    const result = planMemoryConsistencyRepair({ projectRoot: tempDir, allowOrphanDeletes: true });

    expect(result.mode).toBe('dry_run');
    expect(result.summary.insertCount).toBe(0);
    expect(result.summary.resyncCount).toBe(1);
    expect(result.summary.orphanDeleteCount).toBe(0);
    expect(result.skipped).toEqual([]);

    const verifyDb = createDatabase(dbPath);
    const afterCount = Number(verifyDb.prepare('SELECT COUNT(*) AS count FROM nodes').get().count || 0);
    verifyDb.close();
    expect(afterCount).toBe(beforeCount);
  });

  test('repair resyncs same source-heading drift in place and writes audit events', () => {
    const {
      collectKnowledgeEntries,
      runMemoryConsistencyRepair,
    } = helpers;
    const { resolveWorkspacePaths } = require('../modules/memory-search');

    const paths = resolveWorkspacePaths({ projectRoot: tempDir });
    const entries = collectKnowledgeEntries(paths);
    const dbPath = path.join(tempDir, '.squidrun', 'runtime', 'cognitive-memory.db');
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
      allowOrphanDeletes: true,
    });

    expect(result.ok).toBe(true);
    expect(result.execution.insertedNodes).toBe(0);
    expect(result.execution.resyncedNodes).toBe(1);
    expect(result.execution.deletedNodes).toBe(0);
    expect(result.postCheck.status).toBe('in_sync');
    expect(result.postCheck.synced).toBe(true);

    const verifyDb = createDatabase(dbPath);
    const nodeCount = Number(verifyDb.prepare('SELECT COUNT(*) AS count FROM nodes').get().count || 0);
    verifyDb.close();
    expect(nodeCount).toBe(entries.length);

    const evidenceDb = createDatabase(evidenceLedgerDbPath);
    const auditCount = Number(evidenceDb.prepare('SELECT COUNT(*) AS count FROM ledger_events').get().count || 0);
    evidenceDb.close();
    expect(auditCount).toBe(1);
  });

  test('missing-only repair inserts canonical chunks without deleting orphans', () => {
    const {
      collectKnowledgeEntries,
      runMemoryConsistencyRepair,
    } = helpers;
    const { resolveWorkspacePaths } = require('../modules/memory-search');

    const paths = resolveWorkspacePaths({ projectRoot: tempDir });
    const entries = collectKnowledgeEntries(paths);
    const dbPath = path.join(tempDir, '.squidrun', 'runtime', 'cognitive-memory.db');
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
      repairScope: 'missing-only',
    });

    expect(result.ok).toBe(true);
    expect(result.repairScope).toBe('missing-only');
    expect(result.execution.insertedNodes).toBe(0);
    expect(result.execution.resyncedNodes).toBe(1);
    expect(result.execution.deletedNodes).toBe(0);
    expect(result.summary.deferredActionCount).toBe(0);
    expect(result.summary.deferredSkippedCount).toBe(0);
    expect(result.postCheck.summary.missingInCognitiveCount).toBe(0);
    expect(result.postCheck.summary.orphanedNodeCount).toBe(0);

    const verifyDb = createDatabase(dbPath);
    const orphan = verifyDb.prepare('SELECT node_id, content_hash FROM nodes WHERE node_id = ?').get('node-orphan');
    verifyDb.close();
    expect(orphan.node_id).toBe('node-orphan');
    expect(orphan.content_hash).toBe(entries[1].contentHash);
  });

  test('missing-only repair does not guess-resync ambiguous repeated headings', () => {
    const {
      collectKnowledgeEntries,
      runMemoryConsistencyRepair,
    } = helpers;
    const { resolveWorkspacePaths } = require('../modules/memory-search');

    fs.writeFileSync(
      path.join(tempDir, 'workspace', 'knowledge', 'user-context.md'),
      [
        '# User Context',
        '',
        '## Repeated',
        '',
        '- First canonical section.',
        '',
        '## Repeated',
        '',
        '- Second canonical section.',
      ].join('\n')
    );

    const paths = resolveWorkspacePaths({ projectRoot: tempDir });
    const entries = collectKnowledgeEntries(paths);
    const dbPath = path.join(tempDir, '.squidrun', 'runtime', 'cognitive-memory.db');
    const evidenceLedgerDbPath = path.join(tempDir, 'runtime', 'evidence-ledger.db');
    fs.mkdirSync(path.dirname(evidenceLedgerDbPath), { recursive: true });

    const db = createDatabase(dbPath);
    createCognitiveSchema(db);
    insertKnowledgeNode(db, {
      nodeId: 'ambiguous-heading-orphan',
      sourcePath: 'knowledge/user-context.md',
      title: 'User Context',
      heading: 'Repeated',
      content: 'Old ambiguous repeated-heading content.',
    }, helpers);
    db.close();

    const result = runMemoryConsistencyRepair({
      projectRoot: tempDir,
      evidenceLedgerDbPath,
      repairScope: 'missing-only',
    });

    expect(result.ok).toBe(true);
    expect(result.execution.insertedNodes).toBe(2);
    expect(result.execution.resyncedNodes).toBe(0);
    expect(result.summary.deferredSkippedCount).toBe(1);
    expect(result.postCheck.summary.missingInCognitiveCount).toBe(0);
    expect(result.postCheck.summary.orphanedNodeCount).toBe(1);

    const verifyDb = createDatabase(dbPath);
    const orphan = verifyDb.prepare('SELECT content_hash FROM nodes WHERE node_id = ?').get('ambiguous-heading-orphan');
    const canonicalCount = Number(verifyDb.prepare(`
      SELECT COUNT(*) AS count
      FROM nodes
      WHERE source_path = ? AND heading = ? AND node_id != ?
    `).get('knowledge/user-context.md', 'Repeated', 'ambiguous-heading-orphan').count || 0);
    verifyDb.close();

    expect(orphan.content_hash).not.toBe(entries[0].contentHash);
    expect(canonicalCount).toBe(2);
  });

  test('missing-only repair resyncs high-confidence content matches inside multi-chunk headings', () => {
    const {
      collectKnowledgeEntries,
      runMemoryConsistencyRepair,
    } = helpers;
    const { resolveWorkspacePaths } = require('../modules/memory-search');

    const filler = Array.from({ length: 80 }, (_, index) => (
      `- Filler preference ${index}: keep unrelated Mira wording and operating texture out of the channel-routing fact.`
    ));
    fs.writeFileSync(
      path.join(tempDir, 'workspace', 'knowledge', 'user-context.md'),
      [
        '# User Context',
        '',
        '## Communication Patterns',
        '',
        '- Channel + input basics: James uses Telegram when away from the PC; voice-transcribed messages are common, so preserve conversational context across the channel switch.',
        ...filler,
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(tempDir, 'workspace', 'knowledge', 'helper.md'),
      [
        '# Helper',
        '',
        '## Stable',
        '',
        '- Stable helper node.',
      ].join('\n')
    );

    const paths = resolveWorkspacePaths({ projectRoot: tempDir });
    const entries = collectKnowledgeEntries(paths);
    const helperEntry = entries.find((entry) => entry.sourcePath === 'knowledge/helper.md');
    const matchedEntry = entries.find((entry) => (
      entry.sourcePath === 'knowledge/user-context.md'
      && entry.heading === 'Communication Patterns'
      && entry.content.includes('Telegram when away from the PC')
    ));
    expect(matchedEntry).toBeTruthy();
    expect(helperEntry).toBeTruthy();
    expect(entries.filter((entry) => entry.heading === 'Communication Patterns').length).toBeGreaterThan(1);

    const dbPath = path.join(tempDir, '.squidrun', 'runtime', 'cognitive-memory.db');
    const db = createDatabase(dbPath);
    createCognitiveSchema(db);
    insertKnowledgeNode(db, {
      nodeId: 'rehome-node',
      sourcePath: 'knowledge/user-context.md',
      title: 'User Context',
      heading: 'Communication Patterns',
      content: 'Uses Telegram when away from PC. May send voice-transcribed messages. Expects agents to preserve context and continue with minimal friction.',
      metadata: { sectionIndex: 2, chunkIndex: 0, headingLevel: 2 },
      accessCount: 4,
    }, helpers);
    insertKnowledgeNode(db, {
      nodeId: 'helper-node',
      sourcePath: helperEntry.sourcePath,
      title: helperEntry.title,
      heading: helperEntry.heading,
      content: helperEntry.content,
      contentHash: helperEntry.contentHash,
      metadata: helperEntry.metadata,
    }, helpers);
    db.prepare(`
      INSERT INTO edges (source_node_id, target_node_id, relation_type, weight)
      VALUES (?, ?, ?, ?)
    `).run('rehome-node', 'helper-node', 'supports', 1.0);
    db.close();

    const result = runMemoryConsistencyRepair({
      projectRoot: tempDir,
      evidenceLedgerDbPath: path.join(tempDir, 'runtime', 'evidence-ledger.db'),
      repairScope: 'missing-only',
    });

    expect(result.ok).toBe(true);
    expect(result.execution.resyncedNodes).toBe(1);
    expect(result.postCheck.summary.orphanedNodeCount).toBe(0);

    const verifyDb = createDatabase(dbPath);
    const row = verifyDb.prepare('SELECT content_hash FROM nodes WHERE node_id = ?').get('rehome-node');
    const edgeCount = Number(verifyDb.prepare(`
      SELECT COUNT(*) AS count
      FROM edges
      WHERE source_node_id = ? AND target_node_id = ?
    `).get('rehome-node', 'helper-node').count || 0);
    verifyDb.close();

    expect(row.content_hash).toBe(matchedEntry.contentHash);
    expect(edgeCount).toBe(1);
  });

  test('repair skips deleted-source orphans with an explanation', () => {
    const { runMemoryConsistencyRepair } = helpers;

    const db = createDatabase(path.join(tempDir, '.squidrun', 'runtime', 'cognitive-memory.db'));
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

  test('repair resyncs same source-heading relational drift without dropping edges', () => {
    const {
      collectKnowledgeEntries,
      runMemoryConsistencyRepair,
    } = helpers;
    const { resolveWorkspacePaths } = require('../modules/memory-search');

    const paths = resolveWorkspacePaths({ projectRoot: tempDir });
    const entries = collectKnowledgeEntries(paths);
    const db = createDatabase(path.join(tempDir, '.squidrun', 'runtime', 'cognitive-memory.db'));
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
    expect(result.execution.resyncedNodes).toBe(1);
    expect(result.skipped).toHaveLength(0);
    expect(result.actions.some((action) => action.kind === 'delete_revision_skew_orphan')).toBe(false);

    const verifyDb = createDatabase(path.join(tempDir, '.squidrun', 'runtime', 'cognitive-memory.db'));
    const edgeCount = Number(verifyDb.prepare(`
      SELECT COUNT(*) AS count
      FROM edges
      WHERE source_node_id = ? AND target_node_id = ?
    `).get('relational-orphan', 'helper-node').count || 0);
    const row = verifyDb.prepare('SELECT content_hash, current_version FROM nodes WHERE node_id = ?').get('relational-orphan');
    verifyDb.close();

    expect(edgeCount).toBe(1);
    expect(row.content_hash).toBe(entries[0].contentHash);
    expect(Number(row.current_version || 0)).toBe(3);
  });

  test('repair resyncs immune source-heading drift while preserving immunity', () => {
    const {
      collectKnowledgeEntries,
      runMemoryConsistencyRepair,
    } = helpers;
    const { resolveWorkspacePaths } = require('../modules/memory-search');

    const paths = resolveWorkspacePaths({ projectRoot: tempDir });
    const entries = collectKnowledgeEntries(paths);
    const db = createDatabase(path.join(tempDir, '.squidrun', 'runtime', 'cognitive-memory.db'));
    createCognitiveSchema(db);
    insertKnowledgeNode(db, {
      nodeId: 'immune-orphan',
      sourcePath: entries[0].sourcePath,
      title: entries[0].title,
      heading: entries[0].heading,
      content: 'Older immune preference statement.',
      isImmune: true,
    }, helpers);
    db.close();

    const result = runMemoryConsistencyRepair({
      projectRoot: tempDir,
      evidenceLedgerDbPath: path.join(tempDir, 'runtime', 'evidence-ledger.db'),
    });

    expect(result.ok).toBe(true);
    expect(result.execution.resyncedNodes).toBe(1);
    expect(result.skipped).toEqual([]);
    expect(result.actions.some((action) => action.kind === 'delete_revision_skew_orphan')).toBe(false);

    const verifyDb = createDatabase(path.join(tempDir, '.squidrun', 'runtime', 'cognitive-memory.db'));
    const row = verifyDb.prepare('SELECT content_hash, is_immune FROM nodes WHERE node_id = ?').get('immune-orphan');
    verifyDb.close();

    expect(row.content_hash).toBe(entries[0].contentHash);
    expect(Number(row.is_immune || 0)).toBe(1);
  });

  test('repair consolidates duplicate hashes and preserves traces and edges on the survivor', () => {
    const {
      collectKnowledgeEntries,
      runMemoryConsistencyRepair,
    } = helpers;
    const { resolveWorkspacePaths } = require('../modules/memory-search');

    const paths = resolveWorkspacePaths({ projectRoot: tempDir });
    const entries = collectKnowledgeEntries(paths);
    const dbPath = path.join(tempDir, '.squidrun', 'runtime', 'cognitive-memory.db');
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

  test('repair preserves immunity when collapsing duplicate hashes', () => {
    const {
      collectKnowledgeEntries,
      runMemoryConsistencyRepair,
    } = helpers;
    const { resolveWorkspacePaths } = require('../modules/memory-search');

    const paths = resolveWorkspacePaths({ projectRoot: tempDir });
    const entries = collectKnowledgeEntries(paths);
    const dbPath = path.join(tempDir, '.squidrun', 'runtime', 'cognitive-memory.db');
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
      nodeId: 'dup-immune-loser',
      sourcePath: entries[0].sourcePath,
      title: entries[0].title,
      heading: entries[0].heading,
      content: entries[0].content,
      contentHash: entries[0].contentHash,
      metadata: entries[0].metadata,
      isImmune: true,
    }, helpers);
    db.close();

    const result = runMemoryConsistencyRepair({
      projectRoot: tempDir,
      evidenceLedgerDbPath: path.join(tempDir, 'runtime', 'evidence-ledger.db'),
    });

    expect(result.ok).toBe(true);

    const verifyDb = createDatabase(dbPath);
    const row = verifyDb.prepare(`
      SELECT is_immune
      FROM nodes
      WHERE node_id = ?
      LIMIT 1
    `).get('dup-survivor');
    verifyDb.close();

    expect(Number(row.is_immune || 0)).toBe(1);
  });

  test('orphan migration moves relations, dedups repeated edges, merges metadata, deletes mapped orphan, and audits', () => {
    const {
      collectKnowledgeEntries,
      runOrphanMigration,
    } = helpers;
    const { resolveWorkspacePaths } = require('../modules/memory-search');

    const paths = resolveWorkspacePaths({ projectRoot: tempDir });
    const entries = collectKnowledgeEntries(paths);
    const dbPath = path.join(tempDir, '.squidrun', 'runtime', 'cognitive-memory.db');
    const evidenceLedgerDbPath = path.join(tempDir, 'runtime', 'evidence-ledger.db');
    fs.mkdirSync(path.dirname(evidenceLedgerDbPath), { recursive: true });

    const db = createDatabase(dbPath);
    createCognitiveSchema(db);
    insertKnowledgeNode(db, {
      nodeId: 'target-node',
      sourcePath: entries[0].sourcePath,
      title: entries[0].title,
      heading: entries[0].heading,
      content: entries[0].content,
      contentHash: entries[0].contentHash,
      metadata: entries[0].metadata,
      accessCount: 3,
      lastAccessedAt: '2026-01-02T00:00:00.000Z',
      salienceScore: 0.4,
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
    insertKnowledgeNode(db, {
      nodeId: 'orphan-node',
      sourcePath: entries[0].sourcePath,
      title: entries[0].title,
      heading: entries[0].heading,
      content: 'Older preference guidance with relational state.',
      accessCount: 2,
      lastAccessedAt: '2026-02-03T00:00:00.000Z',
      salienceScore: 0.7,
      currentVersion: 4,
      isImmune: true,
    }, helpers);
    db.prepare(`
      INSERT INTO edges (source_node_id, target_node_id, relation_type, weight)
      VALUES (?, ?, ?, ?)
    `).run('target-node', 'helper-node', 'supports', 1.5);
    db.prepare(`
      INSERT INTO edges (source_node_id, target_node_id, relation_type, weight)
      VALUES (?, ?, ?, ?)
    `).run('orphan-node', 'helper-node', 'supports', 2.5);
    db.prepare(`
      INSERT INTO edges (source_node_id, target_node_id, relation_type, weight)
      VALUES (?, ?, ?, ?)
    `).run('orphan-node', 'helper-node', 'supports', 3.5);
    db.prepare(`
      INSERT INTO edges (source_node_id, target_node_id, relation_type, weight)
      VALUES (?, ?, ?, ?)
    `).run('helper-node', 'orphan-node', 'references', 0.5);
    db.prepare(`
      INSERT INTO traces (node_id, trace_id, extracted_at)
      VALUES (?, ?, ?)
    `).run('target-node', 'shared-trace', '2026-01-01T00:00:00.000Z');
    db.prepare(`
      INSERT INTO traces (node_id, trace_id, extracted_at)
      VALUES (?, ?, ?)
    `).run('orphan-node', 'shared-trace', '2026-02-01T00:00:00.000Z');
    db.prepare(`
      INSERT INTO traces (node_id, trace_id, extracted_at)
      VALUES (?, ?, ?)
    `).run('orphan-node', 'unique-trace', '2026-02-02T00:00:00.000Z');
    db.prepare(`
      INSERT INTO memory_leases (
        lease_id, node_id, agent_id, query_text, expires_at_ms, version_at_lease, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('lease-1', 'orphan-node', 'builder', 'preference', 2000, 1, 1000, 1000);
    db.close();

    const result = runOrphanMigration({
      projectRoot: tempDir,
      evidenceLedgerDbPath,
      dryRun: false,
      mappings: [{ oldNodeId: 'orphan-node', targetNodeId: 'target-node' }],
      nowMs: Date.parse('2026-05-08T20:00:00.000Z'),
    });

    expect(result.ok).toBe(true);
    expect(result.execution.appliedActions).toBe(1);
    expect(result.execution.deletedNodes).toBe(1);
    expect(result.execution.movedEdges).toBe(3);
    expect(result.execution.dedupedEdges).toBe(2);
    expect(result.execution.movedTraces).toBe(1);
    expect(result.execution.dedupedTraces).toBe(1);
    expect(result.execution.movedLeases).toBe(1);
    expect(result.execution.auditEventsWritten).toBe(1);

    const verifyDb = createDatabase(dbPath);
    const orphan = verifyDb.prepare('SELECT node_id FROM nodes WHERE node_id = ?').get('orphan-node');
    const target = verifyDb.prepare(`
      SELECT access_count, last_accessed_at, salience_score, is_immune, current_version
      FROM nodes
      WHERE node_id = ?
    `).get('target-node');
    const supportEdges = Number(verifyDb.prepare(`
      SELECT COUNT(*) AS count
      FROM edges
      WHERE source_node_id = ? AND target_node_id = ? AND relation_type = ?
    `).get('target-node', 'helper-node', 'supports').count || 0);
    const supportWeight = Number(verifyDb.prepare(`
      SELECT weight
      FROM edges
      WHERE source_node_id = ? AND target_node_id = ? AND relation_type = ?
    `).get('target-node', 'helper-node', 'supports').weight || 0);
    const reverseEdges = Number(verifyDb.prepare(`
      SELECT COUNT(*) AS count
      FROM edges
      WHERE source_node_id = ? AND target_node_id = ? AND relation_type = ?
    `).get('helper-node', 'target-node', 'references').count || 0);
    const sharedTraceCount = Number(verifyDb.prepare(`
      SELECT COUNT(*) AS count
      FROM traces
      WHERE node_id = ? AND trace_id = ?
    `).get('target-node', 'shared-trace').count || 0);
    const uniqueTraceCount = Number(verifyDb.prepare(`
      SELECT COUNT(*) AS count
      FROM traces
      WHERE node_id = ? AND trace_id = ?
    `).get('target-node', 'unique-trace').count || 0);
    const lease = verifyDb.prepare('SELECT node_id FROM memory_leases WHERE lease_id = ?').get('lease-1');
    verifyDb.close();

    expect(orphan).toBeUndefined();
    expect(Number(target.access_count || 0)).toBe(5);
    expect(target.last_accessed_at).toBe('2026-02-03T00:00:00.000Z');
    expect(Number(target.salience_score || 0)).toBeCloseTo(0.7);
    expect(Number(target.is_immune || 0)).toBe(1);
    expect(Number(target.current_version || 0)).toBe(4);
    expect(supportEdges).toBe(1);
    expect(supportWeight).toBeCloseTo(3.5);
    expect(reverseEdges).toBe(1);
    expect(sharedTraceCount).toBe(1);
    expect(uniqueTraceCount).toBe(1);
    expect(lease.node_id).toBe('target-node');

    const evidenceDb = createDatabase(evidenceLedgerDbPath);
    const auditCount = Number(evidenceDb.prepare(`
      SELECT COUNT(*) AS count
      FROM ledger_events
      WHERE type = ?
    `).get('memory.consistency.repair').count || 0);
    evidenceDb.close();
    expect(auditCount).toBe(1);
  });

  test('orphan migration review skips ambiguous, missing-target, and deleted-source nodes', () => {
    const {
      collectKnowledgeEntries,
      planOrphanMigration,
    } = helpers;
    const { resolveWorkspacePaths } = require('../modules/memory-search');

    const paths = resolveWorkspacePaths({ projectRoot: tempDir });
    const entries = collectKnowledgeEntries(paths);
    const db = createDatabase(path.join(tempDir, '.squidrun', 'runtime', 'cognitive-memory.db'));
    createCognitiveSchema(db);
    insertKnowledgeNode(db, {
      nodeId: 'target-one',
      sourcePath: entries[0].sourcePath,
      title: entries[0].title,
      heading: entries[0].heading,
      content: entries[0].content,
      contentHash: entries[0].contentHash,
      metadata: entries[0].metadata,
    }, helpers);
    insertKnowledgeNode(db, {
      nodeId: 'target-two',
      sourcePath: entries[0].sourcePath,
      title: entries[0].title,
      heading: entries[0].heading,
      content: entries[0].content,
      contentHash: entries[0].contentHash,
      metadata: entries[0].metadata,
    }, helpers);
    insertKnowledgeNode(db, {
      nodeId: 'ambiguous-orphan',
      sourcePath: entries[0].sourcePath,
      title: entries[0].title,
      heading: entries[0].heading,
      content: 'Older content needing review.',
    }, helpers);
    insertKnowledgeNode(db, {
      nodeId: 'mapped-no-target',
      sourcePath: entries[0].sourcePath,
      title: entries[0].title,
      heading: entries[0].heading,
      content: 'Older content with an invalid mapping.',
    }, helpers);
    insertKnowledgeNode(db, {
      nodeId: 'deleted-source-orphan',
      sourcePath: 'knowledge/deleted.md',
      title: 'Deleted',
      heading: 'Removed Section',
      content: 'This file no longer exists.',
    }, helpers);
    db.close();

    const result = planOrphanMigration({
      projectRoot: tempDir,
      mappings: [{ oldNodeId: 'mapped-no-target', targetNodeId: 'missing-target' }],
    });

    expect(result.actions).toEqual([]);
    expect(result.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'ambiguous_multi_target', nodeId: 'ambiguous-orphan' }),
      expect.objectContaining({ kind: 'no_target', nodeId: 'mapped-no-target' }),
      expect.objectContaining({ kind: 'deleted_source_review', nodeId: 'deleted-source-orphan' }),
    ]));
  });

  test('guarded orphan delete review plans unblocked explicit drops and escalates protected nodes', () => {
    const {
      planGuardedOrphanDeletes,
    } = helpers;

    const db = createDatabase(path.join(tempDir, '.squidrun', 'runtime', 'cognitive-memory.db'));
    createCognitiveSchema(db);
    insertKnowledgeNode(db, {
      nodeId: 'drop-node',
      sourcePath: 'knowledge/user-context.md',
      title: 'User Context',
      heading: 'Old Heading',
      content: 'Superseded old guidance.',
    }, helpers);
    insertKnowledgeNode(db, {
      nodeId: 'protected-node',
      sourcePath: 'knowledge/user-context.md',
      title: 'User Context',
      heading: 'Protected Heading',
      content: 'Superseded protected guidance.',
      currentVersion: 2,
    }, helpers);
    insertKnowledgeNode(db, {
      nodeId: 'helper-node',
      sourcePath: 'knowledge/user-context.md',
      title: 'User Context',
      heading: 'Helper Heading',
      content: 'Helper node for an edge.',
    }, helpers);
    db.prepare(`
      INSERT INTO edges (source_node_id, target_node_id, relation_type, weight)
      VALUES (?, ?, ?, ?)
    `).run('protected-node', 'helper-node', 'supports', 1.0);
    db.close();

    const result = planGuardedOrphanDeletes({
      projectRoot: tempDir,
      dropTargets: [
        {
          sourcePath: 'knowledge/user-context.md',
          heading: 'Old Heading',
          reason: 'Superseded by current file.',
        },
        {
          sourcePath: 'knowledge/user-context.md',
          heading: 'Protected Heading',
          reason: 'Superseded by current file; recommend purge.',
        },
      ],
    });

    expect(result.mode).toBe('guarded_delete_review');
    expect(result.summary.guardedDeleteCount).toBe(1);
    expect(result.summary.escalatedCount).toBe(1);
    expect(result.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'guarded_delete_orphan',
        node: expect.objectContaining({ nodeId: 'drop-node' }),
      }),
    ]));
    expect(result.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'guarded_delete_escalated',
        nodeId: 'protected-node',
        blockers: expect.arrayContaining(['edge_count=1', 'version=2']),
      }),
    ]));
  });

  test('guarded orphan delete collapses duplicate stable-key residuals before escalating the survivor', () => {
    const {
      runGuardedOrphanDeletes,
    } = helpers;
    const dbPath = path.join(tempDir, '.squidrun', 'runtime', 'cognitive-memory.db');
    const evidenceLedgerDbPath = path.join(tempDir, 'runtime', 'evidence-ledger.db');
    fs.mkdirSync(path.dirname(evidenceLedgerDbPath), { recursive: true });

    const db = createDatabase(dbPath);
    createCognitiveSchema(db);
    insertKnowledgeNode(db, {
      nodeId: 'protected-survivor',
      sourcePath: 'knowledge/user-context.md',
      title: 'User Context',
      heading: 'Old Heading',
      content: 'Superseded protected guidance v2.',
      metadata: { sectionIndex: 9, chunkIndex: 0 },
      accessCount: 10,
      currentVersion: 2,
    }, helpers);
    insertKnowledgeNode(db, {
      nodeId: 'duplicate-loser',
      sourcePath: 'knowledge/user-context.md',
      title: 'User Context',
      heading: 'Old Heading',
      content: 'Superseded protected guidance v1.',
      metadata: { sectionIndex: 9, chunkIndex: 0 },
    }, helpers);
    insertKnowledgeNode(db, {
      nodeId: 'helper-node',
      sourcePath: 'knowledge/user-context.md',
      title: 'User Context',
      heading: 'Helper',
      content: 'Helper content.',
    }, helpers);
    db.prepare(`
      INSERT INTO edges (source_node_id, target_node_id, relation_type, weight)
      VALUES (?, ?, ?, ?)
    `).run('duplicate-loser', 'helper-node', 'supports', 1.0);
    db.close();

    const result = runGuardedOrphanDeletes({
      projectRoot: tempDir,
      evidenceLedgerDbPath,
      dryRun: false,
      dropTargets: [
        {
          sourcePath: 'knowledge/user-context.md',
          heading: 'Old Heading',
          reason: 'Superseded by current file; recommend purge.',
        },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.summary.guardedStableKeyCollapseCount).toBe(1);
    expect(result.summary.escalatedCount).toBe(1);
    expect(result.execution.deletedNodes).toBe(1);

    const verifyDb = createDatabase(dbPath);
    const survivor = verifyDb.prepare('SELECT node_id FROM nodes WHERE node_id = ?').get('protected-survivor');
    const loser = verifyDb.prepare('SELECT node_id FROM nodes WHERE node_id = ?').get('duplicate-loser');
    const movedEdgeCount = Number(verifyDb.prepare(`
      SELECT COUNT(*) AS count
      FROM edges
      WHERE source_node_id = ? AND target_node_id = ?
    `).get('protected-survivor', 'helper-node').count || 0);
    verifyDb.close();

    expect(survivor.node_id).toBe('protected-survivor');
    expect(loser).toBeUndefined();
    expect(movedEdgeCount).toBe(1);
  });

  test('guarded orphan delete run deletes only unblocked nodes and writes audit events', () => {
    const {
      runGuardedOrphanDeletes,
    } = helpers;
    const dbPath = path.join(tempDir, '.squidrun', 'runtime', 'cognitive-memory.db');
    const evidenceLedgerDbPath = path.join(tempDir, 'runtime', 'evidence-ledger.db');
    fs.mkdirSync(path.dirname(evidenceLedgerDbPath), { recursive: true });

    const db = createDatabase(dbPath);
    createCognitiveSchema(db);
    insertKnowledgeNode(db, {
      nodeId: 'drop-node',
      sourcePath: 'knowledge/user-context.md',
      title: 'User Context',
      heading: 'Old Heading',
      content: 'Superseded old guidance.',
    }, helpers);
    insertKnowledgeNode(db, {
      nodeId: 'protected-node',
      sourcePath: 'knowledge/user-context.md',
      title: 'User Context',
      heading: 'Protected Heading',
      content: 'Superseded protected guidance.',
      isImmune: true,
    }, helpers);
    db.close();

    const result = runGuardedOrphanDeletes({
      projectRoot: tempDir,
      evidenceLedgerDbPath,
      dryRun: false,
      dropTargets: [
        {
          sourcePath: 'knowledge/user-context.md',
          heading: 'Old Heading',
          reason: 'Superseded by current file.',
        },
        {
          sourcePath: 'knowledge/user-context.md',
          heading: 'Protected Heading',
          reason: 'Superseded by current file; recommend purge.',
        },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.execution.appliedActions).toBe(1);
    expect(result.execution.deletedNodes).toBe(1);
    expect(result.summary.escalatedCount).toBe(1);

    const verifyDb = createDatabase(dbPath);
    const deletedNode = verifyDb.prepare('SELECT node_id FROM nodes WHERE node_id = ?').get('drop-node');
    const protectedNode = verifyDb.prepare('SELECT node_id FROM nodes WHERE node_id = ?').get('protected-node');
    verifyDb.close();

    expect(deletedNode).toBeUndefined();
    expect(protectedNode.node_id).toBe('protected-node');

    const evidenceDb = createDatabase(evidenceLedgerDbPath);
    const auditCount = Number(evidenceDb.prepare(`
      SELECT COUNT(*) AS count
      FROM ledger_events
      WHERE type = ?
    `).get('memory.consistency.repair').count || 0);
    evidenceDb.close();
    expect(auditCount).toBe(1);
  });

  describe('rekey_stale_stable_key', () => {
    function seedEntriesWithShiftedSection(db, entries, { staleIndex = 0, shift = 7 } = {}) {
      entries.forEach((entry, index) => {
        const metadata = index === staleIndex
          ? { ...entry.metadata, sectionIndex: Number(entry.metadata.sectionIndex || 0) + shift }
          : entry.metadata;
        insertKnowledgeNode(db, {
          nodeId: `node-${index + 1}`,
          sourcePath: entry.sourcePath,
          title: entry.title,
          heading: entry.heading,
          content: entry.content,
          contentHash: entry.contentHash,
          metadata,
        }, helpers);
      });
    }

    test('rekeys a shifted-section node in place with zero deletes and preserved edges', () => {
      const {
        collectKnowledgeEntries,
        planMemoryConsistencyRepair,
        runMemoryConsistencyRepair,
      } = helpers;
      const { resolveWorkspacePaths } = require('../modules/memory-search');

      const paths = resolveWorkspacePaths({ projectRoot: tempDir });
      const entries = collectKnowledgeEntries(paths);
      const dbPath = path.join(tempDir, '.squidrun', 'runtime', 'cognitive-memory.db');
      const evidenceLedgerDbPath = path.join(tempDir, 'runtime', 'evidence-ledger.db');
      fs.mkdirSync(path.dirname(evidenceLedgerDbPath), { recursive: true });

      const db = createDatabase(dbPath);
      createCognitiveSchema(db);
      seedEntriesWithShiftedSection(db, entries);
      db.prepare('INSERT INTO edges (source_node_id, target_node_id, relation_type, weight) VALUES (?, ?, ?, ?)')
        .run('node-1', 'node-2', 'related', 1.0);
      db.prepare('INSERT INTO edges (source_node_id, target_node_id, relation_type, weight) VALUES (?, ?, ?, ?)')
        .run('node-2', 'node-1', 'related', 1.0);
      const beforeNodeCount = Number(db.prepare('SELECT COUNT(*) AS count FROM nodes').get().count || 0);
      db.close();

      const plan = planMemoryConsistencyRepair({ projectRoot: tempDir });
      expect(plan.summary.rekeyCount).toBe(1);
      expect(plan.summary.deleteCount).toBe(0);
      expect(plan.actions).toEqual([
        expect.objectContaining({
          kind: 'rekey_stale_stable_key',
          nodeId: 'node-1',
          toStableKey: entries[0].stableKey,
          deleteCount: 0,
        }),
      ]);
      expect(plan.actions[0].fromStableKey).not.toBe(entries[0].stableKey);

      const result = runMemoryConsistencyRepair({
        projectRoot: tempDir,
        evidenceLedgerDbPath,
        repairScope: 'missing-only',
      });

      expect(result.ok).toBe(true);
      expect(result.execution.rekeyedNodes).toBe(1);
      expect(result.execution.deletedNodes).toBe(0);
      expect(result.execution.insertedNodes).toBe(0);
      expect(result.execution.failures).toEqual([]);
      expect(result.summary.deferredSkippedCount).toBe(0);
      expect(result.postCheck.status).toBe('in_sync');
      expect(result.postCheck.summary.duplicateSourceHeadingCount).toBe(0);

      const verifyDb = createDatabase(dbPath);
      const afterNodeCount = Number(verifyDb.prepare('SELECT COUNT(*) AS count FROM nodes').get().count || 0);
      const rekeyedNode = verifyDb.prepare('SELECT node_id, content_hash, metadata_json FROM nodes WHERE node_id = ?').get('node-1');
      const edgeRows = verifyDb.prepare('SELECT source_node_id, target_node_id FROM edges ORDER BY source_node_id').all();
      verifyDb.close();

      expect(afterNodeCount).toBe(beforeNodeCount);
      expect(rekeyedNode.content_hash).toBe(entries[0].contentHash);
      const metadata = JSON.parse(rekeyedNode.metadata_json);
      expect(metadata.sectionIndex).toBe(entries[0].metadata.sectionIndex);
      expect(metadata.repairMode).toBe('stale_stable_key_rekey');
      expect(edgeRows).toEqual([
        { source_node_id: 'node-1', target_node_id: 'node-2' },
        { source_node_id: 'node-2', target_node_id: 'node-1' },
      ]);

      const evidenceDb = createDatabase(evidenceLedgerDbPath);
      const auditCount = Number(evidenceDb.prepare(`
        SELECT COUNT(*) AS count
        FROM ledger_events
        WHERE type = ?
      `).get('memory.consistency.repair').count || 0);
      evidenceDb.close();
      expect(auditCount).toBe(1);
    });

    test('is idempotent: second run after rekey plans zero actions and zero rekey skips', () => {
      const {
        collectKnowledgeEntries,
        planMemoryConsistencyRepair,
        runMemoryConsistencyRepair,
      } = helpers;
      const { resolveWorkspacePaths } = require('../modules/memory-search');

      const paths = resolveWorkspacePaths({ projectRoot: tempDir });
      const entries = collectKnowledgeEntries(paths);
      const dbPath = path.join(tempDir, '.squidrun', 'runtime', 'cognitive-memory.db');
      const evidenceLedgerDbPath = path.join(tempDir, 'runtime', 'evidence-ledger.db');
      fs.mkdirSync(path.dirname(evidenceLedgerDbPath), { recursive: true });

      const db = createDatabase(dbPath);
      createCognitiveSchema(db);
      seedEntriesWithShiftedSection(db, entries);
      db.close();

      const firstRun = runMemoryConsistencyRepair({ projectRoot: tempDir, evidenceLedgerDbPath });
      expect(firstRun.ok).toBe(true);
      expect(firstRun.execution.rekeyedNodes).toBe(1);

      const secondPlan = planMemoryConsistencyRepair({ projectRoot: tempDir });
      expect(secondPlan.summary.actionCount).toBe(0);
      expect(secondPlan.summary.rekeyCount).toBe(0);
      expect(secondPlan.skipped.filter((entry) => String(entry.kind || '').startsWith('rekey_skipped'))).toEqual([]);
      expect(secondPlan.detection.status).toBe('in_sync');
    });

    test('skips with a visible reason when identical content maps to multiple live chunks', () => {
      const {
        collectKnowledgeEntries,
        planMemoryConsistencyRepair,
      } = helpers;
      const { resolveWorkspacePaths } = require('../modules/memory-search');

      fs.writeFileSync(
        path.join(tempDir, 'workspace', 'knowledge', 'ambiguous.md'),
        [
          '# Ambiguous',
          '',
          '## Repeated',
          '',
          '- Same canonical text.',
          '',
          '## Repeated',
          '',
          '- Same canonical text.',
        ].join('\n')
      );

      const paths = resolveWorkspacePaths({ projectRoot: tempDir });
      const entries = collectKnowledgeEntries(paths);
      const ambiguousEntries = entries.filter((entry) => entry.sourcePath.endsWith('ambiguous.md'));
      expect(ambiguousEntries.length).toBeGreaterThan(1);
      expect(new Set(ambiguousEntries.map((entry) => entry.contentHash)).size).toBe(1);

      const dbPath = path.join(tempDir, '.squidrun', 'runtime', 'cognitive-memory.db');
      const db = createDatabase(dbPath);
      createCognitiveSchema(db);
      entries
        .filter((entry) => !entry.sourcePath.endsWith('ambiguous.md'))
        .forEach((entry, index) => {
          insertKnowledgeNode(db, {
            nodeId: `node-clean-${index + 1}`,
            sourcePath: entry.sourcePath,
            title: entry.title,
            heading: entry.heading,
            content: entry.content,
            contentHash: entry.contentHash,
            metadata: entry.metadata,
          }, helpers);
        });
      insertKnowledgeNode(db, {
        nodeId: 'node-ambiguous-stale',
        sourcePath: ambiguousEntries[0].sourcePath,
        title: ambiguousEntries[0].title,
        heading: ambiguousEntries[0].heading,
        content: ambiguousEntries[0].content,
        contentHash: ambiguousEntries[0].contentHash,
        metadata: { ...ambiguousEntries[0].metadata, sectionIndex: 9 },
      }, helpers);
      db.close();

      const plan = planMemoryConsistencyRepair({ projectRoot: tempDir });

      expect(plan.summary.rekeyCount).toBe(0);
      expect(plan.actions.filter((action) => action.kind === 'rekey_stale_stable_key')).toEqual([]);
      const rekeySkips = plan.skipped.filter((entry) => entry.kind === 'rekey_skipped_ambiguous_content_hash');
      expect(rekeySkips).toEqual([
        expect.objectContaining({
          kind: 'rekey_skipped_ambiguous_content_hash',
          nodeId: 'node-ambiguous-stale',
          contentHash: ambiguousEntries[0].contentHash,
          blockers: ['ambiguous_content_hash'],
          reason: expect.stringContaining('ambiguous'),
        }),
      ]);
    });
  });
});
