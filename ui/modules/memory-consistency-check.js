const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const {
  buildKnowledgeSources,
  resolveWorkspacePaths,
} = require('./memory-search');
const { EvidenceLedgerStore } = require('./main/evidence-ledger-store');

const REQUIRED_NODE_COLUMNS = Object.freeze([
  'node_id',
  'source_type',
  'source_path',
  'heading',
  'content',
]);

const DEFAULT_SAMPLE_LIMIT = 10;
const MAX_SAMPLE_LIMIT = 100;
const ROUTINE_TRACE_PREFIXES = Object.freeze([
  'memory-document:',
]);

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/').trim();
}

function safeJsonParse(value, fallback = {}) {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function parseIsoMs(value) {
  if (value == null || value === '') return 0;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.floor(numeric);
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function generateId(prefix = 'mem') {
  try {
    return `${prefix}-${crypto.randomUUID()}`;
  } catch {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
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

function listTables(db) {
  return new Set(
    db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
    `).all().map((row) => String(row.name || ''))
  );
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

function buildSample(rows = [], limit = DEFAULT_SAMPLE_LIMIT) {
  return rows.slice(0, Math.max(1, limit)).map((entry) => ({ ...entry }));
}

function createBaseResult(paths, cognitiveDbPath, knowledgeEntries) {
  return {
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
}

function mapKnowledgeNodeRow(row) {
  const mapped = {
    nodeId: String(row.node_id || ''),
    sourceType: String(row.source_type || 'knowledge'),
    sourcePath: normalizePath(row.source_path || ''),
    title: row.title || null,
    heading: row.heading || null,
    content: row.content || '',
    metadata: safeJsonParse(row.metadata_json, {}),
    updatedAtMs: Number(row.updated_at_ms || 0),
    createdAtMs: Number(row.created_at_ms || 0),
    accessCount: Number(row.access_count || 0),
    lastAccessedAt: row.last_accessed_at || null,
    currentVersion: Number(row.current_version || 1),
    salienceScore: Number(row.salience_score || 0),
    confidenceScore: Number(row.confidence_score || 0.5),
    lastReconsolidatedAt: row.last_reconsolidated_at || null,
    category: row.category || null,
  };
  mapped.contentHash = normalizeWhitespace(row.content_hash || '') || hashKnowledgeNodeIdentity(mapped);
  return mapped;
}

function loadKnowledgeNodes(db, availableColumns) {
  const selectColumns = [
    'node_id',
    availableColumns.includes('category') ? 'category' : 'NULL AS category',
    'source_type',
    'source_path',
    availableColumns.includes('title') ? 'title' : 'NULL AS title',
    'heading',
    'content',
    availableColumns.includes('content_hash') ? 'content_hash' : 'NULL AS content_hash',
    availableColumns.includes('metadata_json') ? 'metadata_json' : "'{}' AS metadata_json",
    availableColumns.includes('updated_at_ms') ? 'updated_at_ms' : '0 AS updated_at_ms',
    availableColumns.includes('created_at_ms') ? 'created_at_ms' : '0 AS created_at_ms',
    availableColumns.includes('access_count') ? 'access_count' : '0 AS access_count',
    availableColumns.includes('last_accessed_at') ? 'last_accessed_at' : 'NULL AS last_accessed_at',
    availableColumns.includes('current_version') ? 'current_version' : '1 AS current_version',
    availableColumns.includes('salience_score') ? 'salience_score' : '0 AS salience_score',
    availableColumns.includes('confidence_score') ? 'confidence_score' : '0.5 AS confidence_score',
    availableColumns.includes('last_reconsolidated_at') ? 'last_reconsolidated_at' : 'NULL AS last_reconsolidated_at',
  ];

  return db.prepare(`
    SELECT ${selectColumns.join(', ')}
    FROM nodes
    WHERE COALESCE(source_type, '') = 'knowledge'
    ORDER BY updated_at_ms DESC, node_id ASC
  `).all().map(mapKnowledgeNodeRow);
}

function finalizeAnalysisResult(result, missingKnowledgeEntries, orphanedKnowledgeNodes, duplicateKnowledgeHashes, sampleLimit) {
  result.summary.missingInCognitiveCount = missingKnowledgeEntries.length;
  result.summary.orphanedNodeCount = orphanedKnowledgeNodes.length;
  result.summary.duplicateKnowledgeHashCount = duplicateKnowledgeHashes.length;
  result.summary.issueCount = result.drift.issues.length;
  result.drift.missingKnowledgeEntries = buildSample(missingKnowledgeEntries, sampleLimit);
  result.drift.orphanedKnowledgeNodes = buildSample(orphanedKnowledgeNodes, sampleLimit);
  result.drift.duplicateKnowledgeHashes = buildSample(duplicateKnowledgeHashes, sampleLimit);

  if (
    result.drift.issues.length > 0
    || missingKnowledgeEntries.length > 0
    || orphanedKnowledgeNodes.length > 0
    || duplicateKnowledgeHashes.length > 0
  ) {
    result.status = 'drift_detected';
    result.synced = false;
  }
}

function analyzeMemoryConsistency(options = {}) {
  const sampleLimit = Math.max(
    1,
    Math.min(
      MAX_SAMPLE_LIMIT,
      Number.parseInt(String(options.sampleLimit || `${DEFAULT_SAMPLE_LIMIT}`), 10) || DEFAULT_SAMPLE_LIMIT
    )
  );
  const paths = resolveWorkspacePaths(options);
  const cognitiveDbPath = resolveCognitiveMemoryDbPath(options, paths);
  const knowledgeDirExists = fs.existsSync(paths.knowledgeDir);
  const knowledgeEntries = knowledgeDirExists ? collectKnowledgeEntries(paths, options) : [];
  const result = createBaseResult(paths, cognitiveDbPath, knowledgeEntries);
  const analysis = {
    ok: true,
    paths,
    sampleLimit,
    cognitiveDbPath,
    knowledgeEntries,
    knowledgeNodes: [],
    missingKnowledgeEntries: [],
    orphanedKnowledgeNodes: [],
    duplicateKnowledgeHashes: [],
    duplicateGroups: [],
    schema: {
      availableNodeColumns: [],
      availableTables: new Set(),
    },
    result,
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
    return analysis;
  }

  let db = null;
  try {
    db = new DatabaseSync(cognitiveDbPath);
    analysis.schema.availableTables = listTables(db);
    const hasNodesTable = analysis.schema.availableTables.has('nodes');
    if (!hasNodesTable) {
      result.status = 'nodes_table_missing';
      result.synced = false;
      result.drift.issues.push({
        code: 'nodes_table_missing',
        detail: 'nodes table not found in cognitive-memory.db',
      });
      result.summary.issueCount = result.drift.issues.length;
      return analysis;
    }

    analysis.schema.availableNodeColumns = listNodeColumns(db);
    const missingColumns = REQUIRED_NODE_COLUMNS.filter((column) => !analysis.schema.availableNodeColumns.includes(column));
    if (missingColumns.length > 0) {
      result.status = 'schema_incomplete';
      result.synced = false;
      result.drift.issues.push({
        code: 'missing_node_columns',
        detail: `nodes table is missing required columns: ${missingColumns.join(', ')}`,
      });
      result.summary.issueCount = result.drift.issues.length;
      return analysis;
    }

    analysis.knowledgeNodes = loadKnowledgeNodes(db, analysis.schema.availableNodeColumns);
    result.summary.knowledgeNodeCount = analysis.knowledgeNodes.length;

    const expectedByHash = new Map();
    for (const entry of knowledgeEntries) {
      const list = expectedByHash.get(entry.contentHash) || [];
      list.push(entry);
      expectedByHash.set(entry.contentHash, list);
    }

    const nodesByHash = new Map();
    for (const node of analysis.knowledgeNodes) {
      const list = nodesByHash.get(node.contentHash) || [];
      list.push(node);
      nodesByHash.set(node.contentHash, list);
    }

    analysis.missingKnowledgeEntries = knowledgeEntries
      .filter((entry) => !nodesByHash.has(entry.contentHash))
      .map((entry) => ({
        sourceKey: entry.sourceKey,
        sourcePath: entry.sourcePath,
        heading: entry.heading,
        title: entry.title,
        metadata: entry.metadata,
        contentHash: entry.contentHash,
        content: entry.content,
        lastModifiedMs: entry.lastModifiedMs,
      }));

    analysis.orphanedKnowledgeNodes = analysis.knowledgeNodes
      .filter((node) => !expectedByHash.has(node.contentHash))
      .map((node) => ({ ...node }));

    analysis.duplicateGroups = Array.from(nodesByHash.entries())
      .filter(([, entries]) => entries.length > 1)
      .map(([contentHash, entries]) => ({
        contentHash,
        nodes: entries.map((entry) => ({ ...entry })),
      }));

    analysis.duplicateKnowledgeHashes = analysis.duplicateGroups.map((group) => ({
      contentHash: group.contentHash,
      count: group.nodes.length,
      nodeIds: group.nodes.map((entry) => entry.nodeId),
      sourcePaths: Array.from(new Set(group.nodes.map((entry) => entry.sourcePath).filter(Boolean))),
    }));

    finalizeAnalysisResult(
      result,
      analysis.missingKnowledgeEntries.map((entry) => ({
        sourceKey: entry.sourceKey,
        sourcePath: entry.sourcePath,
        heading: entry.heading,
        contentHash: entry.contentHash,
      })),
      analysis.orphanedKnowledgeNodes.map((node) => ({
        nodeId: node.nodeId,
        sourcePath: node.sourcePath,
        heading: node.heading,
        contentHash: node.contentHash,
      })),
      analysis.duplicateKnowledgeHashes,
      sampleLimit
    );

    return analysis;
  } finally {
    try {
      db?.close();
    } catch {
      // Best effort.
    }
  }
}

function loadNodeEdgeCounts(db, availableTables) {
  if (!availableTables.has('edges')) return new Map();
  const rows = db.prepare(`
    SELECT node_id, SUM(edge_count) AS edge_count
    FROM (
      SELECT source_node_id AS node_id, COUNT(*) AS edge_count
      FROM edges
      GROUP BY source_node_id
      UNION ALL
      SELECT target_node_id AS node_id, COUNT(*) AS edge_count
      FROM edges
      GROUP BY target_node_id
    )
    GROUP BY node_id
  `).all();
  return new Map(rows.map((row) => [String(row.node_id || ''), Number(row.edge_count || 0)]));
}

function loadNodeTraceRows(db, availableTables) {
  if (!availableTables.has('traces')) return new Map();
  const rows = db.prepare(`
    SELECT rowid, node_id, trace_id, extracted_at
    FROM traces
    ORDER BY rowid ASC
  `).all();
  const traceMap = new Map();
  for (const row of rows) {
    const nodeId = String(row.node_id || '');
    const list = traceMap.get(nodeId) || [];
    list.push({
      rowId: Number(row.rowid || 0),
      nodeId,
      traceId: String(row.trace_id || ''),
      extractedAt: row.extracted_at || null,
    });
    traceMap.set(nodeId, list);
  }
  return traceMap;
}

function loadNodeLeaseCounts(db, availableTables) {
  if (!availableTables.has('memory_leases')) return new Map();
  const rows = db.prepare(`
    SELECT node_id, COUNT(*) AS lease_count
    FROM memory_leases
    GROUP BY node_id
  `).all();
  return new Map(rows.map((row) => [String(row.node_id || ''), Number(row.lease_count || 0)]));
}

function resolveKnowledgeSourceAbsolutePath(paths, sourcePath) {
  return path.resolve(paths.workspaceDir, normalizePath(sourcePath || ''));
}

function isRoutineTraceId(traceId, node) {
  const normalized = String(traceId || '').trim();
  if (!normalized) return true;
  if (normalized === String(node.contentHash || '').trim()) return true;
  return ROUTINE_TRACE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function buildNodeRelationalProfile(node, edgeCounts, traceRows, leaseCounts) {
  const traces = (traceRows.get(node.nodeId) || []).map((entry) => ({ ...entry }));
  const routineTraces = traces.filter((entry) => isRoutineTraceId(entry.traceId, node));
  const nonRoutineTraces = traces.filter((entry) => !isRoutineTraceId(entry.traceId, node));
  return {
    nodeId: node.nodeId,
    edgeCount: Number(edgeCounts.get(node.nodeId) || 0),
    leaseCount: Number(leaseCounts.get(node.nodeId) || 0),
    traceCount: traces.length,
    routineTraceCount: routineTraces.length,
    nonRoutineTraceCount: nonRoutineTraces.length,
    traces,
    routineTraces,
    nonRoutineTraces,
    currentVersion: Number(node.currentVersion || 1),
    salienceScore: Number(node.salienceScore || 0),
    accessCount: Number(node.accessCount || 0),
    lastAccessedAt: node.lastAccessedAt || null,
  };
}

function aggregateProfiles(profiles = []) {
  return profiles.reduce((summary, profile) => ({
    edgeCount: summary.edgeCount + Number(profile.edgeCount || 0),
    leaseCount: summary.leaseCount + Number(profile.leaseCount || 0),
    traceCount: summary.traceCount + Number(profile.traceCount || 0),
    routineTraceCount: summary.routineTraceCount + Number(profile.routineTraceCount || 0),
    nonRoutineTraceCount: summary.nonRoutineTraceCount + Number(profile.nonRoutineTraceCount || 0),
    currentVersion: Math.max(summary.currentVersion, Number(profile.currentVersion || 1)),
    salienceScore: Math.max(summary.salienceScore, Number(profile.salienceScore || 0)),
    accessCount: summary.accessCount + Number(profile.accessCount || 0),
    lastAccessedAtMs: Math.max(summary.lastAccessedAtMs, parseIsoMs(profile.lastAccessedAt)),
  }), {
    edgeCount: 0,
    leaseCount: 0,
    traceCount: 0,
    routineTraceCount: 0,
    nonRoutineTraceCount: 0,
    currentVersion: 1,
    salienceScore: 0,
    accessCount: 0,
    lastAccessedAtMs: 0,
  });
}

function buildReplacementIndex(entries = []) {
  const bySourcePath = new Map();
  for (const entry of entries) {
    const sourcePath = normalizePath(entry.sourcePath || '');
    const list = bySourcePath.get(sourcePath) || [];
    list.push(entry);
    bySourcePath.set(sourcePath, list);
  }
  return bySourcePath;
}

function chooseDuplicateSurvivor(nodes = []) {
  return nodes.slice().sort((left, right) => {
    const accessDelta = Number(right.accessCount || 0) - Number(left.accessCount || 0);
    if (accessDelta !== 0) return accessDelta;
    const lastAccessDelta = parseIsoMs(right.lastAccessedAt) - parseIsoMs(left.lastAccessedAt);
    if (lastAccessDelta !== 0) return lastAccessDelta;
    const salienceDelta = Number(right.salienceScore || 0) - Number(left.salienceScore || 0);
    if (salienceDelta !== 0) return salienceDelta;
    const updatedDelta = Number(right.updatedAtMs || 0) - Number(left.updatedAtMs || 0);
    if (updatedDelta !== 0) return updatedDelta;
    return String(left.nodeId || '').localeCompare(String(right.nodeId || ''));
  })[0] || null;
}

function classifyOrphanNode(node, paths, relationalProfile, replacementIndex) {
  const sourceAbsPath = resolveKnowledgeSourceAbsolutePath(paths, node.sourcePath);
  const sourceExists = fs.existsSync(sourceAbsPath);
  const replacementCandidates = (replacementIndex.get(normalizePath(node.sourcePath)) || []).map((entry) => ({
    sourcePath: entry.sourcePath,
    heading: entry.heading,
    contentHash: entry.contentHash,
  }));
  const blockers = [];
  if (Number(relationalProfile.edgeCount || 0) > 0) {
    blockers.push(`${relationalProfile.edgeCount} edge(s)`);
  }
  if (Number(relationalProfile.leaseCount || 0) > 0) {
    blockers.push(`${relationalProfile.leaseCount} active lease(s)`);
  }
  if (Number(relationalProfile.nonRoutineTraceCount || 0) > 0) {
    blockers.push(`${relationalProfile.nonRoutineTraceCount} non-routine trace(s)`);
  }
  if (Number(relationalProfile.currentVersion || 1) > 1) {
    blockers.push(`version=${relationalProfile.currentVersion}`);
  }
  if (Number(relationalProfile.salienceScore || 0) > 0) {
    blockers.push(`salience=${Number(relationalProfile.salienceScore || 0).toFixed(2)}`);
  }

  if (!sourceExists) {
    return {
      classification: 'deleted_source',
      repairable: false,
      reason: 'Source file is missing on disk; auto-purge is unsafe without explicit confirmation.',
      blockers: ['source_file_missing'],
      sourceExists,
      sourceAbsolutePath: sourceAbsPath,
      replacementCandidates,
      relationalProfile,
    };
  }

  if (blockers.length > 0) {
    return {
      classification: 'relational_migration_required',
      repairable: false,
      reason: `Orphan retains migration-worthy data: ${blockers.join(', ')}.`,
      blockers,
      sourceExists,
      sourceAbsolutePath: sourceAbsPath,
      replacementCandidates,
      relationalProfile,
    };
  }

  return {
    classification: 'revision_skew_orphan',
    repairable: true,
    reason: 'Source still exists and the orphan only looks like stale revision skew with no migration-worthy data.',
    blockers: [],
    sourceExists,
    sourceAbsolutePath: sourceAbsPath,
    replacementCandidates,
    relationalProfile,
  };
}

function buildPlanSummary(actions = [], skipped = []) {
  return {
    actionCount: actions.length,
    insertCount: actions.filter((action) => action.kind === 'insert_missing_chunk').length,
    duplicateMergeCount: actions.filter((action) => action.kind === 'collapse_duplicate_hash').length,
    orphanDeleteCount: actions.filter((action) => action.kind === 'delete_revision_skew_orphan').length,
    deleteCount: actions.reduce((sum, action) => sum + Number(action.deleteCount || 0), 0),
    skippedCount: skipped.length,
  };
}

function planMemoryConsistencyRepair(options = {}) {
  const analysis = analyzeMemoryConsistency(options);
  const plan = {
    ok: analysis.ok,
    mode: 'dry_run',
    dryRun: true,
    checkedAt: new Date().toISOString(),
    workspaceDir: analysis.paths.workspaceDir,
    knowledgeDir: analysis.paths.knowledgeDir,
    cognitiveDbPath: analysis.cognitiveDbPath,
    detection: analysis.result,
    actions: [],
    skipped: [],
    summary: {
      actionCount: 0,
      insertCount: 0,
      duplicateMergeCount: 0,
      orphanDeleteCount: 0,
      deleteCount: 0,
      skippedCount: 0,
    },
  };

  if (
    analysis.result.drift.issues.length > 0
    || analysis.result.status === 'cognitive_memory_missing'
    || analysis.result.status === 'nodes_table_missing'
    || analysis.result.status === 'schema_incomplete'
  ) {
    plan.summary = buildPlanSummary(plan.actions, plan.skipped);
    return plan;
  }

  let db = null;
  try {
    db = new DatabaseSync(analysis.cognitiveDbPath);
    const availableTables = listTables(db);
    const edgeCounts = loadNodeEdgeCounts(db, availableTables);
    const traceRows = loadNodeTraceRows(db, availableTables);
    const leaseCounts = loadNodeLeaseCounts(db, availableTables);
    const replacementIndex = buildReplacementIndex(analysis.knowledgeEntries);

    const duplicateLoserIds = new Set();
    const survivorProfileOverrides = new Map();

    analysis.duplicateGroups.forEach((group, groupIndex) => {
      const survivor = chooseDuplicateSurvivor(group.nodes);
      if (!survivor) return;
      const losers = group.nodes.filter((node) => node.nodeId !== survivor.nodeId);
      losers.forEach((node) => duplicateLoserIds.add(node.nodeId));
      const profiles = group.nodes.map((node) => buildNodeRelationalProfile(node, edgeCounts, traceRows, leaseCounts));
      survivorProfileOverrides.set(survivor.nodeId, aggregateProfiles(profiles));
      plan.actions.push({
        id: `action-${groupIndex + 1}`,
        kind: 'collapse_duplicate_hash',
        driftType: 'duplicate_hash',
        safe: true,
        contentHash: group.contentHash,
        survivorNodeId: survivor.nodeId,
        loserNodeIds: losers.map((node) => node.nodeId),
        deleteCount: losers.length,
        reason: `Duplicate content hash detected; consolidate ${losers.length} duplicate node(s) into ${survivor.nodeId}.`,
      });
    });

    const actionOffset = plan.actions.length;
    analysis.missingKnowledgeEntries.forEach((entry, index) => {
      plan.actions.push({
        id: `action-${actionOffset + index + 1}`,
        kind: 'insert_missing_chunk',
        driftType: 'missing_chunk',
        safe: true,
        deleteCount: 0,
        entry: {
          sourceKey: entry.sourceKey,
          sourcePath: entry.sourcePath,
          title: entry.title,
          heading: entry.heading,
          contentHash: entry.contentHash,
          content: entry.content,
          metadata: entry.metadata,
          lastModifiedMs: entry.lastModifiedMs,
        },
        reason: 'Canonical knowledge chunk exists on disk but is missing from cognitive memory.',
      });
    });

    const orphanActionOffset = plan.actions.length;
    analysis.orphanedKnowledgeNodes
      .filter((node) => !duplicateLoserIds.has(node.nodeId))
      .forEach((node, index) => {
        const relationalProfile = survivorProfileOverrides.get(node.nodeId)
          || buildNodeRelationalProfile(node, edgeCounts, traceRows, leaseCounts);
        const classification = classifyOrphanNode(node, analysis.paths, relationalProfile, replacementIndex);
        if (classification.repairable) {
          plan.actions.push({
            id: `action-${orphanActionOffset + index + 1}`,
            kind: 'delete_revision_skew_orphan',
            driftType: 'revision_skew_orphan',
            safe: true,
            deleteCount: 1,
            node: {
              nodeId: node.nodeId,
              sourcePath: node.sourcePath,
              heading: node.heading,
              contentHash: node.contentHash,
            },
            classification,
            reason: classification.reason,
          });
          return;
        }

        const skipReason = classification.classification === 'deleted_source'
          ? 'deleted_source_orphan'
          : 'relational_migration_required';
        plan.skipped.push({
          kind: skipReason,
          driftType: classification.classification,
          nodeId: node.nodeId,
          sourcePath: node.sourcePath,
          heading: node.heading,
          contentHash: node.contentHash,
          reason: classification.reason,
          blockers: classification.blockers,
        });
      });

    plan.summary = buildPlanSummary(plan.actions, plan.skipped);
    return plan;
  } finally {
    try {
      db?.close();
    } catch {
      // best effort
    }
  }
}

function buildAuditEvent(actionName, payload, nowMs, sessionId = null) {
  return {
    eventId: generateId('evt-memory-consistency'),
    traceId: generateId('trc-memory-consistency'),
    type: 'memory.consistency.repair',
    stage: 'memory_consistency',
    source: 'hm-memory-consistency',
    paneId: 'builder',
    role: 'builder',
    ts: nowMs,
    direction: 'internal',
    payload: {
      action: actionName,
      repairedAt: new Date(nowMs).toISOString(),
      ...payload,
    },
    meta: {
      automatedRepair: true,
      repairAction: actionName,
      driftType: payload?.driftType || null,
      sessionId,
    },
  };
}

function openEvidenceLedgerStore(options = {}) {
  const store = new EvidenceLedgerStore({
    dbPath: options.evidenceLedgerDbPath,
    enabled: true,
  });
  const init = store.init();
  if (!init?.ok) {
    store.close();
    return {
      ok: false,
      reason: init?.reason || 'evidence_ledger_unavailable',
      store: null,
    };
  }
  return {
    ok: true,
    store,
  };
}

function insertKnowledgeNode(db, availableNodeColumns, availableTables, entry, nowMs) {
  const nodeId = generateId('mem-knowledge');
  const metadata = {
    ...(entry.metadata && typeof entry.metadata === 'object' && !Array.isArray(entry.metadata) ? entry.metadata : {}),
    repairedBy: 'hm-memory-consistency',
    repairMode: 'auto',
    repairedAt: new Date(nowMs).toISOString(),
  };
  const columnValuePairs = [
    ['node_id', nodeId],
    ['category', 'knowledge'],
    ['content', entry.content],
    ['confidence_score', 0.5],
    ['access_count', 0],
    ['last_accessed_at', null],
    ['last_reconsolidated_at', null],
    ['content_hash', entry.contentHash],
    ['current_version', 1],
    ['salience_score', 0],
    ['embedding_json', '[]'],
    ['source_type', 'knowledge'],
    ['source_path', entry.sourcePath],
    ['title', entry.title || null],
    ['heading', entry.heading || null],
    ['metadata_json', JSON.stringify(metadata)],
    ['created_at_ms', nowMs],
    ['updated_at_ms', nowMs],
  ].filter(([column]) => availableNodeColumns.includes(column));

  const columns = columnValuePairs.map(([column]) => column);
  const placeholders = columns.map(() => '?');
  const values = columnValuePairs.map(([, value]) => value);
  db.prepare(`
    INSERT INTO nodes (${columns.join(', ')})
    VALUES (${placeholders.join(', ')})
  `).run(...values);

  if (availableTables.has('traces')) {
    const existing = db.prepare(`
      SELECT 1
      FROM traces
      WHERE node_id = ? AND trace_id = ?
      LIMIT 1
    `).get(nodeId, entry.contentHash);
    if (!existing) {
      db.prepare(`
        INSERT INTO traces (node_id, trace_id, extracted_at)
        VALUES (?, ?, ?)
      `).run(nodeId, entry.contentHash, new Date(nowMs).toISOString());
    }
  }

  return nodeId;
}

function moveDuplicateTraces(db, loserNodeId, survivorNodeId) {
  const rows = db.prepare(`
    SELECT rowid, trace_id, extracted_at
    FROM traces
    WHERE node_id = ?
    ORDER BY rowid ASC
  `).all(loserNodeId);
  let moved = 0;
  let removed = 0;
  for (const row of rows) {
    const duplicate = db.prepare(`
      SELECT rowid
      FROM traces
      WHERE node_id = ? AND trace_id = ?
      LIMIT 1
    `).get(survivorNodeId, row.trace_id);
    if (duplicate) {
      db.prepare('DELETE FROM traces WHERE rowid = ?').run(row.rowid);
      removed += 1;
      continue;
    }
    db.prepare('UPDATE traces SET node_id = ? WHERE rowid = ?').run(survivorNodeId, row.rowid);
    moved += 1;
  }
  return { moved, removed };
}

function moveDuplicateEdges(db, loserNodeId, survivorNodeId) {
  const rows = db.prepare(`
    SELECT rowid, source_node_id, target_node_id, relation_type, weight
    FROM edges
    WHERE source_node_id = ? OR target_node_id = ?
    ORDER BY rowid ASC
  `).all(loserNodeId, loserNodeId);
  let moved = 0;
  let removed = 0;
  for (const row of rows) {
    const nextSource = row.source_node_id === loserNodeId ? survivorNodeId : row.source_node_id;
    const nextTarget = row.target_node_id === loserNodeId ? survivorNodeId : row.target_node_id;
    if (nextSource === nextTarget) {
      db.prepare('DELETE FROM edges WHERE rowid = ?').run(row.rowid);
      removed += 1;
      continue;
    }

    const duplicate = db.prepare(`
      SELECT rowid, weight
      FROM edges
      WHERE source_node_id = ?
        AND target_node_id = ?
        AND relation_type = ?
        AND rowid != ?
      LIMIT 1
    `).get(nextSource, nextTarget, row.relation_type, row.rowid);

    if (duplicate) {
      const nextWeight = Math.max(Number(duplicate.weight || 0), Number(row.weight || 0));
      db.prepare('UPDATE edges SET weight = ? WHERE rowid = ?').run(nextWeight, duplicate.rowid);
      db.prepare('DELETE FROM edges WHERE rowid = ?').run(row.rowid);
      removed += 1;
      continue;
    }

    db.prepare(`
      UPDATE edges
      SET source_node_id = ?, target_node_id = ?
      WHERE rowid = ?
    `).run(nextSource, nextTarget, row.rowid);
    moved += 1;
  }
  return { moved, removed };
}

function moveDuplicateLeases(db, loserNodeId, survivorNodeId) {
  const result = db.prepare(`
    UPDATE memory_leases
    SET node_id = ?
    WHERE node_id = ?
  `).run(survivorNodeId, loserNodeId);
  return {
    moved: Number(result?.changes || 0),
  };
}

function deleteNodeWithRelations(db, availableTables, nodeId) {
  let traceDeletes = 0;
  let edgeDeletes = 0;
  let leaseDeletes = 0;

  if (availableTables.has('traces')) {
    traceDeletes = Number(db.prepare('DELETE FROM traces WHERE node_id = ?').run(nodeId)?.changes || 0);
  }
  if (availableTables.has('edges')) {
    edgeDeletes = Number(
      db.prepare('DELETE FROM edges WHERE source_node_id = ? OR target_node_id = ?').run(nodeId, nodeId)?.changes || 0
    );
  }
  if (availableTables.has('memory_leases')) {
    leaseDeletes = Number(db.prepare('DELETE FROM memory_leases WHERE node_id = ?').run(nodeId)?.changes || 0);
  }
  const nodeDeletes = Number(db.prepare('DELETE FROM nodes WHERE node_id = ?').run(nodeId)?.changes || 0);

  return {
    nodeDeletes,
    traceDeletes,
    edgeDeletes,
    leaseDeletes,
  };
}

function runMemoryConsistencyRepair(options = {}) {
  const dryRun = options.dryRun === true;
  const plan = planMemoryConsistencyRepair(options);
  if (dryRun) {
    return plan;
  }

  const result = {
    ...plan,
    mode: 'repair',
    dryRun: false,
    execution: {
      attemptedActions: plan.actions.length,
      appliedActions: 0,
      skippedActions: plan.skipped.length,
      insertedNodes: 0,
      deletedNodes: 0,
      mergedDuplicateGroups: 0,
      auditEventsWritten: 0,
      failures: [],
    },
    postCheck: null,
  };

  if (
    plan.detection.drift.issues.length > 0
    || plan.actions.length === 0
  ) {
    result.postCheck = runMemoryConsistencyCheck(options);
    return result;
  }

  const ledgerState = openEvidenceLedgerStore(options);
  if (!ledgerState.ok || !ledgerState.store) {
    return {
      ...result,
      ok: false,
      reason: ledgerState.reason || 'evidence_ledger_unavailable',
      postCheck: runMemoryConsistencyCheck(options),
    };
  }

  let db = null;
  let availableNodeColumns = [];
  let availableTables = new Set();
  const auditQueue = [];
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Math.floor(Number(options.nowMs)) : Date.now();

  try {
    db = new DatabaseSync(plan.cognitiveDbPath);
    availableNodeColumns = listNodeColumns(db);
    availableTables = listTables(db);
    db.exec('BEGIN IMMEDIATE;');

    for (const action of plan.actions) {
      if (action.kind === 'insert_missing_chunk') {
        const existing = db.prepare(`
          SELECT node_id
          FROM nodes
          WHERE content_hash = ?
          LIMIT 1
        `).get(action.entry.contentHash);
        if (existing) {
          result.execution.skippedActions += 1;
          continue;
        }

        const nodeId = insertKnowledgeNode(db, availableNodeColumns, availableTables, action.entry, nowMs);
        result.execution.insertedNodes += 1;
        result.execution.appliedActions += 1;
        auditQueue.push(buildAuditEvent('insert_missing_chunk', {
          driftType: action.driftType,
          nodeId,
          sourcePath: action.entry.sourcePath,
          heading: action.entry.heading,
          contentHash: action.entry.contentHash,
        }, nowMs, options.sessionId || null));
        continue;
      }

      if (action.kind === 'collapse_duplicate_hash') {
        for (const loserNodeId of action.loserNodeIds) {
          if (availableTables.has('traces')) {
            moveDuplicateTraces(db, loserNodeId, action.survivorNodeId);
          }
          if (availableTables.has('edges')) {
            moveDuplicateEdges(db, loserNodeId, action.survivorNodeId);
          }
          if (availableTables.has('memory_leases')) {
            moveDuplicateLeases(db, loserNodeId, action.survivorNodeId);
          }
          deleteNodeWithRelations(db, availableTables, loserNodeId);
          result.execution.deletedNodes += 1;
          auditQueue.push(buildAuditEvent('delete_duplicate_hash_node', {
            driftType: action.driftType,
            survivorNodeId: action.survivorNodeId,
            deletedNodeId: loserNodeId,
            contentHash: action.contentHash,
          }, nowMs, options.sessionId || null));
        }
        result.execution.mergedDuplicateGroups += 1;
        result.execution.appliedActions += 1;
        continue;
      }

      if (action.kind === 'delete_revision_skew_orphan') {
        const deleted = deleteNodeWithRelations(db, availableTables, action.node.nodeId);
        if (Number(deleted.nodeDeletes || 0) > 0) {
          result.execution.deletedNodes += 1;
          result.execution.appliedActions += 1;
          auditQueue.push(buildAuditEvent('delete_revision_skew_orphan', {
            driftType: action.driftType,
            nodeId: action.node.nodeId,
            sourcePath: action.node.sourcePath,
            heading: action.node.heading,
            contentHash: action.node.contentHash,
          }, nowMs, options.sessionId || null));
        } else {
          result.execution.skippedActions += 1;
        }
      }
    }

    db.exec('COMMIT;');

    for (const event of auditQueue) {
      const appendResult = ledgerState.store.appendEvent(event, {
        nowMs,
        sessionId: options.sessionId || null,
      });
      if (!appendResult?.ok) {
        result.execution.failures.push({
          action: event?.payload?.action || 'unknown',
          reason: appendResult?.reason || appendResult?.status || 'audit_write_failed',
        });
        continue;
      }
      result.execution.auditEventsWritten += 1;
    }

    result.postCheck = runMemoryConsistencyCheck(options);
    result.ok = result.execution.failures.length === 0;
    if (!result.ok) {
      result.reason = 'repair_completed_with_audit_failures';
    }
    return result;
  } catch (err) {
    try {
      db?.exec('ROLLBACK;');
    } catch {
      // best effort
    }
    result.ok = false;
    result.reason = err.message;
    result.execution.failures.push({
      action: 'repair',
      reason: err.message,
    });
    result.postCheck = runMemoryConsistencyCheck(options);
    return result;
  } finally {
    try {
      db?.close();
    } catch {
      // best effort
    }
    try {
      ledgerState.store?.close();
    } catch {
      // best effort
    }
  }
}

function runMemoryConsistencyCheck(options = {}) {
  return analyzeMemoryConsistency(options).result;
}

module.exports = {
  REQUIRED_NODE_COLUMNS,
  analyzeMemoryConsistency,
  collectKnowledgeEntries,
  hashKnowledgeNodeIdentity,
  planMemoryConsistencyRepair,
  resolveCognitiveMemoryDbPath,
  runMemoryConsistencyCheck,
  runMemoryConsistencyRepair,
};
