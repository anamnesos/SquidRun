const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const {
  buildKnowledgeSources,
  resolveWorkspacePaths,
} = require('./memory-search');
const REQUIRED_NODE_COLUMNS = Object.freeze([
  'node_id',
  'source_type',
  'source_path',
  'heading',
  'content',
]);

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function hashKnowledgeNodeIdentity(input = {}) {
  const sourceType = normalizeWhitespace(input.sourceType || input.source_type || 'knowledge');
  const sourcePath = normalizeWhitespace(input.sourcePath || input.source_path || '');
  const heading = normalizeWhitespace(input.heading || '');
  const content = normalizeWhitespace(input.content || '');
  return crypto.createHash('sha256').update(`${sourceType}|${sourcePath}|${heading}|${content}`, 'utf8').digest('hex');
}

function resolveCognitiveMemoryDbPath(options = {}, paths = resolveWorkspacePaths(options)) {
  return path.resolve(String(options.dbPath || options.cognitiveDbPath || path.join(paths.memoryDir, 'cognitive-memory.db')));
}

function listNodeColumns(db) {
  return db.prepare('PRAGMA table_info(nodes)').all().map((row) => String(row.name || ''));
}

function collectKnowledgeEntries(paths, options = {}) {
  return buildKnowledgeSources(paths, options).map((entry) => ({
    sourceKey: entry.sourceKey,
    sourceGroup: entry.sourceGroup,
    sourceType: entry.sourceType,
    sourcePath: entry.sourcePath,
    title: entry.title,
    heading: entry.heading,
    content: entry.content,
    metadata: entry.metadata || {},
    lastModifiedMs: Number(entry.lastModifiedMs || 0),
    contentHash: hashKnowledgeNodeIdentity(entry),
  }));
}

function buildSample(rows = [], limit = 10) {
  return rows.slice(0, Math.max(1, limit)).map((entry) => ({ ...entry }));
}

function runMemoryConsistencyCheck(options = {}) {
  const sampleLimit = Math.max(1, Math.min(100, Number.parseInt(String(options.sampleLimit || '10'), 10) || 10));
  const paths = resolveWorkspacePaths(options);
  const cognitiveDbPath = resolveCognitiveMemoryDbPath(options, paths);
  const knowledgeDirExists = fs.existsSync(paths.knowledgeDir);
  const knowledgeEntries = knowledgeDirExists ? collectKnowledgeEntries(paths, options) : [];
  const result = {
    ok: true,
    checkedAt: new Date().toISOString(),
    status: 'in_sync',
    synced: true,
    workspaceDir: paths.workspaceDir,
    knowledgeDir: paths.knowledgeDir,
    cognitiveDbPath,
    summary: {
      knowledgeEntryCount: knowledgeEntries.length,
      knowledgeNodeCount: 0,
      missingInCognitiveCount: 0,
      orphanedNodeCount: 0,
      duplicateKnowledgeHashCount: 0,
      issueCount: 0,
    },
    drift: {
      missingKnowledgeEntries: [],
      orphanedKnowledgeNodes: [],
      duplicateKnowledgeHashes: [],
      issues: [],
    },
  };

  if (!knowledgeDirExists) {
    result.status = 'knowledge_missing';
    result.synced = false;
    result.drift.issues.push({
      code: 'knowledge_dir_missing',
      detail: `Knowledge directory not found: ${paths.knowledgeDir}`,
    });
  }

  if (!fs.existsSync(cognitiveDbPath)) {
    result.status = 'cognitive_memory_missing';
    result.synced = false;
    result.drift.issues.push({
      code: 'cognitive_memory_missing',
      detail: `Cognitive memory DB not found: ${cognitiveDbPath}`,
    });
    result.summary.issueCount = result.drift.issues.length;
    return result;
  }

  let db = null;
  try {
    db = new DatabaseSync(cognitiveDbPath);
    const hasNodesTable = db.prepare(`
      SELECT 1
      FROM sqlite_master
      WHERE type = 'table' AND name = 'nodes'
      LIMIT 1
    `).get();
    if (!hasNodesTable) {
      result.status = 'nodes_table_missing';
      result.synced = false;
      result.drift.issues.push({
        code: 'nodes_table_missing',
        detail: 'nodes table not found in cognitive-memory.db',
      });
      result.summary.issueCount = result.drift.issues.length;
      return result;
    }

    const availableColumns = listNodeColumns(db);
    const missingColumns = REQUIRED_NODE_COLUMNS.filter((column) => !availableColumns.includes(column));
    if (missingColumns.length > 0) {
      result.status = 'schema_incomplete';
      result.synced = false;
      result.drift.issues.push({
        code: 'missing_node_columns',
        detail: `nodes table is missing required columns: ${missingColumns.join(', ')}`,
      });
      result.summary.issueCount = result.drift.issues.length;
      return result;
    }

    const selectColumns = [
      'node_id',
      'source_type',
      'source_path',
      availableColumns.includes('title') ? 'title' : 'NULL AS title',
      'heading',
      'content',
      availableColumns.includes('content_hash') ? 'content_hash' : 'NULL AS content_hash',
      availableColumns.includes('updated_at_ms') ? 'updated_at_ms' : '0 AS updated_at_ms',
    ];
    const knowledgeNodes = db.prepare(`
      SELECT ${selectColumns.join(', ')}
      FROM nodes
      WHERE COALESCE(source_type, '') = 'knowledge'
      ORDER BY updated_at_ms DESC, node_id ASC
    `).all().map((row) => ({
      nodeId: row.node_id,
      sourceType: row.source_type,
      sourcePath: row.source_path,
      title: row.title || null,
      heading: row.heading || null,
      content: row.content || '',
      updatedAtMs: Number(row.updated_at_ms || 0),
      contentHash: normalizeWhitespace(row.content_hash || '') || hashKnowledgeNodeIdentity(row),
    }));

    result.summary.knowledgeNodeCount = knowledgeNodes.length;

    const expectedByHash = new Map();
    for (const entry of knowledgeEntries) {
      const list = expectedByHash.get(entry.contentHash) || [];
      list.push(entry);
      expectedByHash.set(entry.contentHash, list);
    }

    const nodesByHash = new Map();
    for (const node of knowledgeNodes) {
      const list = nodesByHash.get(node.contentHash) || [];
      list.push(node);
      nodesByHash.set(node.contentHash, list);
    }

    const missingKnowledgeEntries = knowledgeEntries
      .filter((entry) => !nodesByHash.has(entry.contentHash))
      .map((entry) => ({
        sourceKey: entry.sourceKey,
        sourcePath: entry.sourcePath,
        heading: entry.heading,
        contentHash: entry.contentHash,
      }));

    const orphanedKnowledgeNodes = knowledgeNodes
      .filter((node) => !expectedByHash.has(node.contentHash))
      .map((node) => ({
        nodeId: node.nodeId,
        sourcePath: node.sourcePath,
        heading: node.heading,
        contentHash: node.contentHash,
      }));

    const duplicateKnowledgeHashes = Array.from(nodesByHash.entries())
      .filter(([, entries]) => entries.length > 1)
      .map(([contentHash, entries]) => ({
        contentHash,
        count: entries.length,
        nodeIds: entries.map((entry) => entry.nodeId),
        sourcePaths: Array.from(new Set(entries.map((entry) => entry.sourcePath).filter(Boolean))),
      }));

    result.summary.missingInCognitiveCount = missingKnowledgeEntries.length;
    result.summary.orphanedNodeCount = orphanedKnowledgeNodes.length;
    result.summary.duplicateKnowledgeHashCount = duplicateKnowledgeHashes.length;
    result.drift.missingKnowledgeEntries = buildSample(missingKnowledgeEntries, sampleLimit);
    result.drift.orphanedKnowledgeNodes = buildSample(orphanedKnowledgeNodes, sampleLimit);
    result.drift.duplicateKnowledgeHashes = buildSample(duplicateKnowledgeHashes, sampleLimit);
    result.summary.issueCount = result.drift.issues.length;

    if (
      result.drift.issues.length > 0
      || missingKnowledgeEntries.length > 0
      || orphanedKnowledgeNodes.length > 0
      || duplicateKnowledgeHashes.length > 0
    ) {
      result.status = 'drift_detected';
      result.synced = false;
    }

    return result;
  } finally {
    try {
      db?.close();
    } catch {
      // Best effort.
    }
  }
}

module.exports = {
  REQUIRED_NODE_COLUMNS,
  collectKnowledgeEntries,
  hashKnowledgeNodeIdentity,
  resolveCognitiveMemoryDbPath,
  runMemoryConsistencyCheck,
};
