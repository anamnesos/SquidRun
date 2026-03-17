const crypto = require('crypto');
const { getDatabaseSync } = require('./sqlite-compat');
const DatabaseSync = getDatabaseSync();
const { CognitiveMemoryStore } = require('./cognitive-memory-store');
const { MemorySearchIndex } = require('./memory-search');

/** @typedef {import('../types/contracts').CognitiveMemoryNode} CognitiveMemoryNode */
/** @typedef {import('../types/contracts').MemoryLease} MemoryLease */
/** @typedef {import('../types/contracts').RankedMemoryNodeEntry} RankedMemoryNodeEntry */
/** @typedef {import('../types/contracts').RetrieveMemoryResult} RetrieveMemoryResult */
/** @typedef {import('../types/contracts').TransactiveExpertResult} TransactiveExpertResult */

const DEFAULT_LEASE_MS = Math.max(
  60_000,
  Number.parseInt(process.env.SQUIDRUN_MEMORY_LEASE_MS || '600000', 10) || 600000
);
const DEFAULT_SALIENCE_DELTA = Number.isFinite(Number(process.env.SQUIDRUN_SALIENCE_DELTA))
  ? Number(process.env.SQUIDRUN_SALIENCE_DELTA)
  : 0.25;
const DEFAULT_SALIENCE_DECAY = Number.isFinite(Number(process.env.SQUIDRUN_SALIENCE_DECAY))
  ? Number(process.env.SQUIDRUN_SALIENCE_DECAY)
  : 0.5;
const DEFAULT_INGEST_CONFIDENCE = 0.3;
const DEFAULT_RECENCY_HALF_LIFE_MS = Math.max(
  86_400_000,
  Number.parseInt(process.env.SQUIDRUN_MEMORY_RECENCY_HALF_LIFE_MS || `${30 * 86_400_000}`, 10) || (30 * 86_400_000)
);
const DEFAULT_MIN_RECENCY_MULTIPLIER = clamp(
  Number.isFinite(Number(process.env.SQUIDRUN_MEMORY_MIN_RECENCY_MULTIPLIER))
    ? Number(process.env.SQUIDRUN_MEMORY_MIN_RECENCY_MULTIPLIER)
    : 0.55,
  0.1,
  1
);
const DEFAULT_REACTIVATION_WINDOW_MS = Math.max(
  60_000,
  Number.parseInt(process.env.SQUIDRUN_MEMORY_REACTIVATION_WINDOW_MS || `${6 * 60 * 60 * 1000}`, 10) || (6 * 60 * 60 * 1000)
);

/**
 * @param {string} [prefix]
 * @returns {string}
 */
function generateId(prefix = 'mem') {
  try {
    return `${prefix}-${crypto.randomUUID()}`;
  } catch {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return min;
  return Math.max(min, Math.min(max, numeric));
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function tokenizeNormalized(value) {
  return normalizeWhitespace(value)
    .toLowerCase()
    .match(/[a-z0-9_]+/g) || [];
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function collapseNormalized(value) {
  return normalizeWhitespace(value)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '');
}

/**
 * @param {unknown} value
 * @returns {number[]}
 */
function normalizeVector(value) {
  const vector = Array.isArray(value) ? value.map((entry) => Number(entry || 0)) : [];
  const norm = Math.sqrt(vector.reduce((sum, entry) => sum + (entry * entry), 0)) || 1;
  return vector.map((entry) => entry / norm);
}

/**
 * @param {unknown} left
 * @param {unknown} right
 * @returns {number}
 */
function cosineDistance(left, right) {
  const a = normalizeVector(left);
  const b = normalizeVector(right);
  if (a.length === 0 || a.length !== b.length) return Number.POSITIVE_INFINITY;
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
  }
  return 1 - dot;
}

/**
 * @template T
 * @param {unknown} value
 * @param {T} fallback
 * @returns {T}
 */
function parseJson(value, fallback) {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/**
 * @param {import('node:sqlite').DatabaseSync | import('better-sqlite3').Database} db
 * @param {string} tableName
 * @param {string} columnName
 * @param {string} definition
 * @returns {void}
 */
function ensureColumn(db, tableName, columnName, definition) {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all();
  const exists = rows.some((row) => String(row.name) === String(columnName));
  if (!exists) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

/**
 * @param {number} [nowMs]
 * @returns {string}
 */
function isoNow(nowMs = Date.now()) {
  return new Date(nowMs).toISOString();
}

/**
 * @param {unknown} referenceMs
 * @param {number} [nowMs]
 * @returns {number}
 */
function computeRecencyMultiplier(referenceMs, nowMs = Date.now()) {
  const normalizedReferenceMs = Number(referenceMs || 0);
  if (!Number.isFinite(normalizedReferenceMs) || normalizedReferenceMs <= 0) {
    return DEFAULT_MIN_RECENCY_MULTIPLIER;
  }

  const ageMs = Math.max(0, Number(nowMs || Date.now()) - normalizedReferenceMs);
  if (ageMs === 0) return 1;

  const freshness = Math.exp((-Math.log(2) * ageMs) / DEFAULT_RECENCY_HALF_LIFE_MS);
  return DEFAULT_MIN_RECENCY_MULTIPLIER
    + ((1 - DEFAULT_MIN_RECENCY_MULTIPLIER) * freshness);
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function parseIsoMs(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * @param {Record<string, unknown>} [input]
 * @returns {string}
 */
function hashNodeContent(input = {}) {
  const sourceType = normalizeWhitespace(input.sourceType || input.category || 'fact');
  const sourcePath = normalizeWhitespace(input.sourcePath || '');
  const heading = normalizeWhitespace(input.heading || '');
  const content = normalizeWhitespace(input.content || '');
  return crypto.createHash('sha256').update(`${sourceType}|${sourcePath}|${heading}|${content}`, 'utf8').digest('hex');
}

class CognitiveMemoryApi {
  /**
   * @param {Record<string, unknown>} [options]
   */
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.cognitiveStore = options.cognitiveStore || new CognitiveMemoryStore(options.cognitiveStoreOptions || {});
    this.memorySearchIndex = options.memorySearchIndex || new MemorySearchIndex(options.memorySearchOptions || {});
    this.db = null;
  }

  init() {
    if (this.db) return this.db;
    this.cognitiveStore.init();
    this.db = new DatabaseSync(this.cognitiveStore.dbPath);
    this.db.exec('PRAGMA journal_mode=WAL;');
    this.db.exec('PRAGMA synchronous=NORMAL;');
    this.db.exec('PRAGMA foreign_keys=ON;');
    this.db.exec('PRAGMA busy_timeout=5000;');

    ensureColumn(this.db, 'nodes', 'content_hash', "TEXT DEFAULT ''");
    ensureColumn(this.db, 'nodes', 'current_version', 'INTEGER DEFAULT 1');
    ensureColumn(this.db, 'nodes', 'salience_score', 'REAL DEFAULT 0');
    ensureColumn(this.db, 'nodes', 'is_immune', 'INTEGER DEFAULT 0');
    ensureColumn(this.db, 'nodes', 'embedding_json', "TEXT DEFAULT '[]'");
    ensureColumn(this.db, 'nodes', 'source_type', 'TEXT');
    ensureColumn(this.db, 'nodes', 'source_path', 'TEXT');
    ensureColumn(this.db, 'nodes', 'title', 'TEXT');
    ensureColumn(this.db, 'nodes', 'heading', 'TEXT');
    ensureColumn(this.db, 'nodes', 'metadata_json', "TEXT DEFAULT '{}' ");
    ensureColumn(this.db, 'nodes', 'created_at_ms', 'INTEGER DEFAULT 0');
    ensureColumn(this.db, 'nodes', 'updated_at_ms', 'INTEGER DEFAULT 0');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_leases (
        lease_id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        query_text TEXT,
        expires_at_ms INTEGER NOT NULL,
        version_at_lease INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_memory_leases_node ON memory_leases(node_id, expires_at_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_leases_agent ON memory_leases(agent_id, expires_at_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_nodes_content_hash ON nodes(content_hash);
      CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_node_id, relation_type);
      CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_node_id, relation_type);
    `);

    return this.db;
  }

  close() {
    try { this.cognitiveStore.close(); } catch {}
    try { this.memorySearchIndex.close(); } catch {}
    if (this.db) {
      try { this.db.close(); } catch {}
      this.db = null;
    }
  }

  async embedText(text) {
    const embedder = await this.memorySearchIndex.getEmbedder();
    return normalizeVector(await embedder.embed(normalizeWhitespace(text)));
  }

  pruneExpiredLeases(nowMs = Date.now()) {
    this.init().prepare('DELETE FROM memory_leases WHERE expires_at_ms <= ?').run(nowMs);
  }

  /**
   * @param {Record<string, unknown> | undefined | null} row
   * @returns {CognitiveMemoryNode | null}
   */
  mapNode(row) {
    if (!row) return null;
    return {
      nodeId: row.node_id,
      category: row.category,
      content: row.content,
      contentHash: row.content_hash,
      confidenceScore: Number(row.confidence_score || 0),
      accessCount: Number(row.access_count || 0),
      lastAccessedAt: row.last_accessed_at || null,
      lastReconsolidatedAt: row.last_reconsolidated_at || null,
      currentVersion: Number(row.current_version || 1),
      salienceScore: Number(row.salience_score || 0),
      isImmune: Number(row.is_immune || 0) === 1,
      embedding: parseJson(row.embedding_json, []),
      sourceType: row.source_type || null,
      sourcePath: row.source_path || null,
      title: row.title || null,
      heading: row.heading || null,
      metadata: parseJson(row.metadata_json, {}),
      createdAtMs: Number(row.created_at_ms || 0),
      updatedAtMs: Number(row.updated_at_ms || 0),
    };
  }

  /**
   * @param {string} nodeId
   * @returns {CognitiveMemoryNode | null}
   */
  getNode(nodeId) {
    const row = this.init().prepare('SELECT * FROM nodes WHERE node_id = ? LIMIT 1').get(String(nodeId || ''));
    return this.mapNode(row);
  }

  /**
   * @param {string} nodeId
   * @returns {Array<Record<string, unknown>>}
   */
  listRelatedEdges(nodeId) {
    return this.init().prepare(`
      SELECT rowid, * FROM edges
      WHERE source_node_id = ? OR target_node_id = ?
    `).all(String(nodeId || ''), String(nodeId || ''));
  }

  /**
   * @param {string[]} [nodeIds]
   * @param {{ accessKind?: string, access_kind?: string, nowMs?: number }} [options]
   * @returns {{ ok: true, updated: number, reactivated: number }}
   */
  markNodesAccessed(nodeIds = [], options = {}) {
    const ids = Array.from(new Set((nodeIds || []).map((value) => String(value || '').trim()).filter(Boolean)));
    if (ids.length === 0) return { ok: true, updated: 0, reactivated: 0 };
    const db = this.init();
    const accessKind = normalizeWhitespace(options.accessKind || options.access_kind || 'retrieval').toLowerCase();
    const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
    const nowIso = isoNow(nowMs);
    const placeholders = ids.map(() => '?').join(', ');
    const rows = db.prepare(`
      SELECT node_id, last_accessed_at, updated_at_ms
      FROM nodes
      WHERE node_id IN (${placeholders})
    `).all(...ids);
    const rowById = new Map(rows.map((row) => [String(row.node_id), row]));
    let reactivated = 0;

    db.exec('BEGIN IMMEDIATE;');
    try {
      for (const nodeId of ids) {
        const row = rowById.get(nodeId);
        if (!row) continue;
        const previousAccessMs = parseIsoMs(row.last_accessed_at);
        const isExplicitUse = (
          accessKind === 'explicit_use'
          || accessKind === 'useful_mark'
          || accessKind === 'reactivate'
        );
        const isRepeatRetrieval = (
          accessKind === 'retrieval'
          && previousAccessMs > 0
          && (nowMs - previousAccessMs) <= DEFAULT_REACTIVATION_WINDOW_MS
        );
        const shouldReactivate = isExplicitUse || isRepeatRetrieval;
        const nextUpdatedAtMs = shouldReactivate
          ? nowMs
          : Number(row.updated_at_ms || 0);

        if (shouldReactivate) {
          reactivated += 1;
        }

        db.prepare(`
          UPDATE nodes
          SET access_count = access_count + 1,
              last_accessed_at = ?,
              updated_at_ms = ?
          WHERE node_id = ?
        `).run(nowIso, nextUpdatedAtMs, nodeId);
      }
      db.exec('COMMIT;');
    } catch (err) {
      try { db.exec('ROLLBACK;'); } catch {}
      throw err;
    }
    return { ok: true, updated: rows.length, reactivated };
  }

  /**
   * @param {string} nodeId
   * @param {string} traceId
   * @param {string} extractedAt
   * @returns {void}
   */
  upsertTrace(nodeId, traceId, extractedAt) {
    const normalizedTraceId = normalizeWhitespace(traceId);
    if (!nodeId || !normalizedTraceId) return;
    const db = this.init();
    const existing = db.prepare(`
      SELECT 1 FROM traces
      WHERE node_id = ? AND trace_id = ?
      LIMIT 1
    `).get(nodeId, normalizedTraceId);
    if (existing) return;
    db.prepare(`
      INSERT INTO traces (node_id, trace_id, extracted_at)
      VALUES (?, ?, ?)
    `).run(nodeId, normalizedTraceId, extractedAt || isoNow());
  }

  /**
   * @param {string} nodeId
   * @returns {number[]}
   */
  getNodeDocumentIds(nodeId) {
    if (!nodeId) return [];
    const rows = this.init().prepare(`
      SELECT trace_id
      FROM traces
      WHERE node_id = ?
        AND trace_id LIKE 'memory-document:%'
      ORDER BY extracted_at DESC
    `).all(String(nodeId || ''));
    const documentIds = [];
    const seen = new Set();
    for (const row of rows) {
      const match = String(row.trace_id || '').match(/^memory-document:(\d+)$/);
      if (!match) continue;
      const documentId = Number(match[1]);
      if (!Number.isFinite(documentId) || documentId <= 0 || seen.has(documentId)) continue;
      seen.add(documentId);
      documentIds.push(documentId);
    }
    return documentIds;
  }

  /**
   * @param {CognitiveMemoryNode | null | undefined} node
   * @returns {Promise<Record<string, unknown>>}
   */
  async syncNodeToSearchIndex(node) {
    const documentIds = this.getNodeDocumentIds(node?.nodeId);
    if (documentIds.length === 0) {
      return {
        ok: true,
        attempted: 0,
        updated: 0,
      };
    }

    let updated = 0;
    const failures = [];
    for (const documentId of documentIds) {
      try {
        const result = await this.memorySearchIndex.updateDocument(documentId, {
          content: node.content,
          title: node.title,
          heading: node.heading,
          sourceType: node.sourceType,
          sourcePath: node.sourcePath,
          metadata: {
            ...(node.metadata && typeof node.metadata === 'object' && !Array.isArray(node.metadata)
              ? node.metadata
              : {}),
            cognitiveNodeId: node.nodeId,
            cognitiveVersion: node.currentVersion,
          },
          confidence: node.confidenceScore,
          accessCount: node.accessCount,
          lastAccessedAtMs: node.lastAccessedAt ? parseIsoMs(node.lastAccessedAt) : null,
          lastModifiedMs: node.updatedAtMs,
          nowMs: node.updatedAtMs,
        });
        if (result?.ok) {
          updated += 1;
        } else {
          failures.push({
            documentId,
            reason: result?.reason || 'update_failed',
          });
        }
      } catch (err) {
        failures.push({
          documentId,
          reason: 'update_failed',
          error: err.message,
        });
      }
    }

    return {
      ok: failures.length === 0,
      attempted: documentIds.length,
      updated,
      failures,
    };
  }

  /**
   * @param {string} query
   * @param {{ limit?: number | string }} [options]
   * @returns {TransactiveExpertResult}
   */
  findTransactiveExperts(query, options = {}) {
    const normalizedQuery = normalizeWhitespace(query).toLowerCase();
    if (!normalizedQuery) {
      return {
        ok: true,
        matches: [],
        recommendedAgentId: null,
      };
    }

    const limit = Math.max(1, Math.min(10, Number.parseInt(options.limit || '3', 10) || 3));
    const queryTokens = Array.from(new Set(tokenizeNormalized(normalizedQuery)));
    const queryCollapsed = collapseNormalized(normalizedQuery);
    const candidates = this.cognitiveStore.listTransactiveMeta({ limit: Math.max(limit * 4, 25) });
    const matches = candidates
      .map((row) => {
        const domain = normalizeWhitespace(row.domain).toLowerCase();
        if (!domain) return null;
        const domainTokens = Array.from(new Set(tokenizeNormalized(domain)));
        const domainCollapsed = collapseNormalized(domain);
        const sharedTokenCount = domainTokens.filter((token) => queryTokens.includes(token)).length;
        const collapsedTokenMatches = queryTokens.filter((token) => (
          token.length >= 4 && domainCollapsed.includes(token)
        )).length;
        const hasDirectPhraseMatch = normalizedQuery.includes(domain) || domain.includes(normalizedQuery);
        const hasCollapsedPhraseMatch = Boolean(
          queryCollapsed
          && domainCollapsed
          && (queryCollapsed.includes(domainCollapsed) || domainCollapsed.includes(queryCollapsed))
        );
        const overlapRatio = queryTokens.length > 0
          ? ((sharedTokenCount + collapsedTokenMatches) / queryTokens.length)
          : 0;
        const score = (hasDirectPhraseMatch ? 1.5 : 0)
          + (hasCollapsedPhraseMatch ? 0.75 : 0)
          + overlapRatio
          + (Math.min(1, Number(row.expertise_score || 0)) * 0.6)
          + (Math.min(5, Number(row.proof_count || 0)) * 0.05);
        if (!hasDirectPhraseMatch && !hasCollapsedPhraseMatch && sharedTokenCount === 0 && collapsedTokenMatches === 0) return null;
        return {
          domain: row.domain,
          primaryAgentId: row.primary_agent_id || null,
          expertiseScore: Number(Number(row.expertise_score || 0).toFixed(8)),
          proofCount: Number(row.proof_count || 0),
          lastProvenAt: row.last_proven_at || null,
          lastPaneId: row.last_pane_id || null,
          matchScore: Number(score.toFixed(8)),
          sharedTokenCount: sharedTokenCount + collapsedTokenMatches,
          directMatch: hasDirectPhraseMatch || hasCollapsedPhraseMatch,
        };
      })
      .filter(Boolean)
      .sort((left, right) => right.matchScore - left.matchScore || right.expertiseScore - left.expertiseScore)
      .slice(0, limit);

    return {
      ok: true,
      matches,
      recommendedAgentId: matches[0]?.primaryAgentId || null,
    };
  }

  /**
   * @param {Record<string, unknown>} result
   * @returns {Promise<CognitiveMemoryNode | null>}
   */
  async ensureNodeFromSearchResult(result) {
    const db = this.init();
    const content = normalizeWhitespace(result.content || result.excerpt || '');
    if (!content) return null;

    const sourceType = normalizeWhitespace(result.sourceType || 'knowledge');
    const sourcePath = result.sourcePath || null;
    const heading = result.heading || null;
    const contentHash = hashNodeContent({
      sourceType,
      sourcePath,
      heading,
      content,
    });
    const nowMs = Date.now();
    const embedding = await this.embedText(content);
    const existing = db.prepare('SELECT node_id, is_immune FROM nodes WHERE content_hash = ? LIMIT 1').get(contentHash);
    const requestedImmune = result.isImmune === true || result.is_immune === 1;

    if (existing) {
      db.prepare(`
        UPDATE nodes
        SET category = ?,
            content = ?,
            confidence_score = ?,
            embedding_json = ?,
            source_type = ?,
            source_path = ?,
            title = ?,
            heading = ?,
            metadata_json = ?,
            is_immune = ?,
            updated_at_ms = ?
        WHERE node_id = ?
      `).run(
        result.category || sourceType || 'fact',
        content,
        clamp(result.confidence || 0.55, 0, 1),
        JSON.stringify(embedding),
        sourceType,
        sourcePath,
        result.title || null,
        heading,
        JSON.stringify(result.metadata || {}),
        requestedImmune ? 1 : Number(existing.is_immune || 0),
        nowMs,
        existing.node_id
      );
      this.upsertTrace(existing.node_id, result.documentId ? `memory-document:${result.documentId}` : contentHash, isoNow(nowMs));
      return this.getNode(existing.node_id);
    }

    const nodeId = generateId('node');
    db.prepare(`
      INSERT INTO nodes (
        node_id,
        category,
        content,
        confidence_score,
        access_count,
        last_accessed_at,
        last_reconsolidated_at,
        content_hash,
        current_version,
        salience_score,
        is_immune,
        embedding_json,
        source_type,
        source_path,
        title,
        heading,
        metadata_json,
        created_at_ms,
        updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      nodeId,
      result.category || sourceType || 'fact',
      content,
      clamp(result.confidence || 0.55, 0, 1),
      Number(result.accessCount || 0),
      result.lastAccessedAtMs ? new Date(result.lastAccessedAtMs).toISOString() : null,
      null,
      contentHash,
      1,
      0,
      requestedImmune ? 1 : 0,
      JSON.stringify(embedding),
      sourceType,
      sourcePath,
      result.title || null,
      heading,
      JSON.stringify(result.metadata || {}),
      nowMs,
      nowMs
    );
    this.upsertTrace(nodeId, result.documentId ? `memory-document:${result.documentId}` : contentHash, isoNow(nowMs));
    return this.getNode(nodeId);
  }

  /**
   * @param {number[]} queryVector
   * @param {number} [limit]
   * @returns {RankedMemoryNodeEntry[]}
   */
  searchExistingNodes(queryVector, limit = 5) {
    if (!Array.isArray(queryVector) || queryVector.length === 0) return [];
    const nowMs = Date.now();
    const rows = this.init().prepare('SELECT * FROM nodes').all();
    return rows
      .map((row) => {
        const node = this.mapNode(row);
        const distance = cosineDistance(queryVector, node.embedding);
        const baseScore = (1 - distance)
          + (node.salienceScore * 0.1)
          + (node.confidenceScore * 0.05);
        const recencyMultiplier = node.isImmune
          ? 1
          : computeRecencyMultiplier(
          Math.max(Number(node.updatedAtMs || 0), Number(node.createdAtMs || 0)),
          nowMs
        );
        const score = baseScore * recencyMultiplier;
        return {
          node,
          distance,
          score,
          baseScore,
          recencyMultiplier,
          freshnessPenaltyBypassed: node.isImmune,
        };
      })
      .filter((entry) => Number.isFinite(entry.distance))
      .sort((left, right) => right.score - left.score || left.distance - right.distance)
      .slice(0, Math.max(1, limit));
  }

  /**
   * @param {string[]} nodeIds
   * @param {string} [relationType]
   * @param {number} [weight]
   * @returns {{ ok: true, linked: number }}
   */
  linkRelatedNodes(nodeIds, relationType = 'related_to', weight = 1) {
    const ids = Array.from(new Set((nodeIds || []).map((value) => String(value || '').trim()).filter(Boolean)));
    if (ids.length < 2) return { ok: true, linked: 0 };
    const db = this.init();
    let linked = 0;

    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const pair = [ids[i], ids[j]].sort((left, right) => left.localeCompare(right));
        const [left, right] = pair;
        const existing = db.prepare(`
          SELECT 1 FROM edges
          WHERE ((source_node_id = ? AND target_node_id = ?) OR (source_node_id = ? AND target_node_id = ?))
            AND relation_type = ?
          LIMIT 1
        `).get(left, right, right, left, relationType);
        if (existing) continue;
        db.prepare(`
          INSERT INTO edges (source_node_id, target_node_id, relation_type, weight)
          VALUES (?, ?, ?, ?)
        `).run(left, right, relationType, weight);
        linked += 1;
      }
    }
    return { ok: true, linked };
  }

  /**
   * @param {string} nodeId
   * @param {string} agentId
   * @param {string} queryText
   * @param {number} versionAtLease
   * @param {number | string | undefined} leaseMs
   * @returns {MemoryLease}
   */
  createLease(nodeId, agentId, queryText, versionAtLease, leaseMs) {
    const nowMs = Date.now();
    const leaseId = generateId('lease');
    const expiresAtMs = nowMs + Math.max(60_000, Number.parseInt(leaseMs || DEFAULT_LEASE_MS, 10) || DEFAULT_LEASE_MS);
    this.init().prepare(`
      INSERT INTO memory_leases (
        lease_id, node_id, agent_id, query_text, expires_at_ms, version_at_lease, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(leaseId, nodeId, agentId, queryText || null, expiresAtMs, versionAtLease, nowMs, nowMs);
    return { leaseId, expiresAtMs, versionAtLease };
  }

  /**
   * @param {string} query
   * @param {{ limit?: number | string, agentId?: string, agent_id?: string, leaseMs?: number, transactiveLimit?: number | string, transactive_limit?: number | string }} [options]
   * @returns {Promise<RetrieveMemoryResult>}
   */
  async retrieve(query, options = {}) {
    const trimmedQuery = normalizeWhitespace(query);
    if (!trimmedQuery) {
      return { ok: false, reason: 'query_required', results: [] };
    }

    this.init();
    this.pruneExpiredLeases();
    const limit = Math.max(1, Math.min(12, Number.parseInt(options.limit || '5', 10) || 5));
    const agentId = normalizeWhitespace(options.agentId || options.agent_id || 'unknown-agent');
    const memoryResults = await this.memorySearchIndex.search(trimmedQuery, { limit: Math.max(limit * 2, 6) });

    const seededNodes = [];
    for (const result of memoryResults.results || []) {
      const node = await this.ensureNodeFromSearchResult(result);
      if (node) seededNodes.push(node);
    }

    const queryVector = await this.embedText(trimmedQuery);
    const rankedNodes = this.searchExistingNodes(queryVector, Math.max(limit * 2, 8));
    const deduped = [];
    const seen = new Set();
    for (const entry of rankedNodes) {
      if (seen.has(entry.node.nodeId)) continue;
      seen.add(entry.node.nodeId);
      deduped.push(entry);
      if (deduped.length >= limit) break;
    }

    const nodeIds = deduped.map((entry) => entry.node.nodeId);
    this.linkRelatedNodes(nodeIds);
    this.markNodesAccessed(nodeIds, { accessKind: 'retrieval' });

    const refreshedNodes = new Map(nodeIds.map((nodeId) => [nodeId, this.getNode(nodeId)]));
    const results = deduped.map((entry) => {
      const node = refreshedNodes.get(entry.node.nodeId) || entry.node;
      const lease = this.createLease(node.nodeId, agentId, trimmedQuery, node.currentVersion, options.leaseMs);
      return {
        leaseId: lease.leaseId,
        expiresAtMs: lease.expiresAtMs,
        score: Number(entry.score.toFixed(8)),
        distance: Number(entry.distance.toFixed(8)),
        ...node,
      };
    });

    return {
      ok: true,
      query: trimmedQuery,
      seededNodeCount: seededNodes.length,
      transactive: this.findTransactiveExperts(trimmedQuery, {
        limit: options.transactiveLimit || options.transactive_limit,
      }),
      results,
    };
  }

  /**
   * @param {Record<string, unknown>} [input]
   * @returns {Promise<{ ok: boolean, reason?: string, node?: CognitiveMemoryNode }>}
   */
  async ingest(input = {}) {
    const content = normalizeWhitespace(input.content || input.text || '');
    if (!content) {
      return { ok: false, reason: 'content_required' };
    }

    const category = normalizeWhitespace(input.category || input.sourceType || input.source_type || 'fact');
    const agentId = normalizeWhitespace(input.agentId || input.agent_id || input.agent || 'runtime');
    const confidence = clamp(
      Number.isFinite(Number(input.confidence)) ? Number(input.confidence) : DEFAULT_INGEST_CONFIDENCE,
      0,
      1
    );
    const result = await this.ensureNodeFromSearchResult({
      category,
      content,
      confidence,
      sourceType: normalizeWhitespace(input.sourceType || input.source_type || 'agent-ingest'),
      sourcePath: normalizeWhitespace(input.sourcePath || input.source_path || `agent:${agentId}`),
      title: normalizeWhitespace(input.title || '') || `Agent ingest (${agentId})`,
      heading: normalizeWhitespace(input.heading || '') || category,
      metadata: {
        ...(input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
          ? input.metadata
          : {}),
        agentId,
        command: input.command || 'ingest',
        ingestedVia: input.ingestedVia || 'runtime',
        confidence,
      },
      isImmune: input.isImmune === true || input.is_immune === 1,
    });

    if (!result) {
      return { ok: false, reason: 'node_not_created' };
    }

    return {
      ok: true,
      node: result,
    };
  }

  /**
   * @param {string} leaseId
   * @param {string} updatedContent
   * @param {{ agentId?: string, agent_id?: string, reason?: string | null }} [options]
   * @returns {Promise<Record<string, unknown>>}
   */
  async patch(leaseId, updatedContent, options = {}) {
    const db = this.init();
    this.pruneExpiredLeases();

    const content = normalizeWhitespace(updatedContent);
    if (!content) {
      return { ok: false, reason: 'content_required' };
    }

    const normalizedLeaseId = normalizeWhitespace(leaseId);
    if (!normalizedLeaseId) {
      return { ok: false, reason: 'lease_required' };
    }

    const vector = await this.embedText(content);
    const nowMs = Date.now();
    let response = null;

    db.exec('BEGIN IMMEDIATE;');
    try {
      const lease = db.prepare('SELECT * FROM memory_leases WHERE lease_id = ? LIMIT 1').get(normalizedLeaseId);
      if (!lease) {
        response = { ok: false, reason: 'lease_not_found' };
        db.exec('ROLLBACK;');
        return response;
      }
      if (Number(lease.expires_at_ms || 0) < nowMs) {
        db.prepare('DELETE FROM memory_leases WHERE lease_id = ?').run(normalizedLeaseId);
        response = { ok: false, reason: 'lease_expired' };
        db.exec('COMMIT;');
        return response;
      }

      const node = db.prepare('SELECT * FROM nodes WHERE node_id = ? LIMIT 1').get(lease.node_id);
      if (!node) {
        db.prepare('DELETE FROM memory_leases WHERE lease_id = ?').run(normalizedLeaseId);
        response = { ok: false, reason: 'node_not_found' };
        db.exec('COMMIT;');
        return response;
      }

      if (Number(node.current_version || 1) !== Number(lease.version_at_lease || 1)) {
        response = {
          ok: false,
          reason: 'conflict',
          nodeId: lease.node_id,
          currentVersion: Number(node.current_version || 1),
          leaseVersion: Number(lease.version_at_lease || 1),
        };
        db.exec('COMMIT;');
        return response;
      }

      const nextVersion = Number(node.current_version || 1) + 1;
      const nextConfidence = clamp(Number(node.confidence_score || 0.5) + 0.1, 0, 1);
      const nextSalience = clamp(Number(node.salience_score || 0) + DEFAULT_SALIENCE_DELTA, 0, 5);
      const metadata = {
        ...parseJson(node.metadata_json, {}),
        lastPatchBy: options.agentId || options.agent_id || lease.agent_id,
        lastPatchReason: options.reason || null,
        lastLeaseId: normalizedLeaseId,
      };

      db.prepare(`
        UPDATE nodes
        SET content = ?,
            content_hash = ?,
            embedding_json = ?,
            current_version = ?,
            confidence_score = ?,
            salience_score = ?,
            last_reconsolidated_at = ?,
            updated_at_ms = ?,
            metadata_json = ?
        WHERE node_id = ?
      `).run(
        content,
        hashNodeContent({
          sourceType: node.source_type,
          sourcePath: node.source_path,
          heading: node.heading,
          content,
        }),
        JSON.stringify(vector),
        nextVersion,
        nextConfidence,
        nextSalience,
        isoNow(nowMs),
        nowMs,
        JSON.stringify(metadata),
        node.node_id
      );
      db.prepare('DELETE FROM memory_leases WHERE lease_id = ?').run(normalizedLeaseId);
      this.upsertTrace(node.node_id, `reconsolidation:${normalizedLeaseId}`, isoNow(nowMs));
      db.exec('COMMIT;');

      const patchedNode = this.getNode(node.node_id);
      const searchIndexSync = await this.syncNodeToSearchIndex(patchedNode);
      response = {
        ok: true,
        node: patchedNode,
        searchIndexSync,
      };
      return response;
    } catch (err) {
      try { db.exec('ROLLBACK;'); } catch {}
      throw err;
    }
  }

  /**
   * @param {{ nodeId?: string, node_id?: string, delta?: number, decay?: number, maxDepth?: number | string, max_depth?: number | string }} [input]
   * @returns {{ ok: boolean, reason?: string, updates?: Array<Record<string, unknown>> }}
   */
  applySalienceField(input = {}) {
    const db = this.init();
    const nodeId = normalizeWhitespace(input.nodeId || input.node_id || '');
    if (!nodeId) return { ok: false, reason: 'node_id_required' };
    if (!this.getNode(nodeId)) return { ok: false, reason: 'node_not_found' };

    const delta = Number.isFinite(Number(input.delta)) ? Number(input.delta) : DEFAULT_SALIENCE_DELTA;
    const decay = Number.isFinite(Number(input.decay)) ? Number(input.decay) : DEFAULT_SALIENCE_DECAY;
    const maxDepth = Math.max(0, Math.min(5, Number.parseInt(input.maxDepth || input.max_depth || '2', 10) || 2));
    const visited = new Set();
    const queue = [{ nodeId, depth: 0 }];
    const updates = [];
    const nowMs = Date.now();

    db.exec('BEGIN IMMEDIATE;');
    try {
      while (queue.length > 0) {
        const current = queue.shift();
        if (!current || visited.has(current.nodeId)) continue;
        visited.add(current.nodeId);

        const node = this.getNode(current.nodeId);
        if (!node) continue;

        const increment = delta * Math.pow(decay, current.depth);
        const nextSalience = clamp(node.salienceScore + increment, 0, 5);
        db.prepare(`
          UPDATE nodes
          SET salience_score = ?,
              updated_at_ms = ?
          WHERE node_id = ?
        `).run(nextSalience, nowMs, current.nodeId);
        updates.push({
          nodeId: current.nodeId,
          depth: current.depth,
          increment: Number(increment.toFixed(8)),
          salienceScore: Number(nextSalience.toFixed(8)),
        });

        if (current.depth >= maxDepth) continue;
        const edges = this.listRelatedEdges(current.nodeId);
        for (const edge of edges) {
          const neighborId = edge.source_node_id === current.nodeId ? edge.target_node_id : edge.source_node_id;
          const nextWeight = clamp(Number(edge.weight || 1) + (increment * 0.1), 0, 10);
          db.prepare('UPDATE edges SET weight = ? WHERE rowid = ?').run(nextWeight, edge.rowid);
          if (!visited.has(neighborId)) {
            queue.push({ nodeId: neighborId, depth: current.depth + 1 });
          }
        }
      }

      db.exec('COMMIT;');
      return { ok: true, updates };
    } catch (err) {
      try { db.exec('ROLLBACK;'); } catch {}
      throw err;
    }
  }

  /**
   * @param {string} nodeId
   * @param {boolean | number | string} [value]
   * @param {{ agentId?: string, agent_id?: string, reason?: string | null }} [options]
   * @returns {{ ok: boolean, reason?: string, node?: CognitiveMemoryNode | null }}
   */
  setImmune(nodeId, value = true, options = {}) {
    const normalizedNodeId = normalizeWhitespace(nodeId);
    if (!normalizedNodeId) {
      return { ok: false, reason: 'node_id_required' };
    }
    const existing = this.getNode(normalizedNodeId);
    if (!existing) {
      return { ok: false, reason: 'node_not_found' };
    }

    const nextIsImmune = value === false || value === 0 || value === '0' ? 0 : 1;
    const nowMs = Date.now();
    const metadata = {
      ...(existing.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata)
        ? existing.metadata
        : {}),
      lastImmuneSetAt: isoNow(nowMs),
      lastImmuneSetBy: options.agentId || options.agent_id || 'runtime',
      lastImmuneSetReason: options.reason || null,
    };

    this.init().prepare(`
      UPDATE nodes
      SET is_immune = ?,
          metadata_json = ?,
          updated_at_ms = ?
      WHERE node_id = ?
    `).run(nextIsImmune, JSON.stringify(metadata), nowMs, normalizedNodeId);

    return {
      ok: true,
      node: this.getNode(normalizedNodeId),
    };
  }
}

module.exports = {
  CognitiveMemoryApi,
  DEFAULT_INGEST_CONFIDENCE,
  DEFAULT_LEASE_MS,
  DEFAULT_SALIENCE_DECAY,
  DEFAULT_SALIENCE_DELTA,
  cosineDistance,
};
