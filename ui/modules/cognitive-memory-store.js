const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getDatabaseSync } = require('./sqlite-compat');
const DatabaseSync = getDatabaseSync();
const {
  getActiveProfile,
  getProjectRoot,
  resolveCoordPath,
} = require('../config');
const { isMainProfile, namespaceCoordRelPath, normalizeProfileName } = require('../profile');

/** @typedef {import('../types/contracts').MemoryPrCandidate} MemoryPrCandidate */
/** @typedef {import('../types/contracts').MemoryPrRow} MemoryPrRow */
/** @typedef {import('../types/contracts').TransactiveMetaRow} TransactiveMetaRow */
/** @typedef {import('../types/contracts').WorkspacePaths} WorkspacePaths */
/** @typedef {import('../types/contracts').AntibodyQueueRow} AntibodyQueueRow */
/** @typedef {import('../types/contracts').AgentDomainTrustRow} AgentDomainTrustRow */

/**
 * @param {string} targetPath
 * @returns {void}
 */
function ensureDir(targetPath) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
}

function sqlStringLiteral(value) {
  return `'${String(value || '').replace(/'/g, "''")}'`;
}

function fileSize(targetPath) {
  try {
    return fs.statSync(targetPath).size;
  } catch {
    return 0;
  }
}

function fileExists(targetPath) {
  try {
    return fs.existsSync(targetPath);
  } catch {
    return false;
  }
}

function isPathInside(childPath, parentPath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return Boolean(relative && !relative.startsWith('..') && !path.isAbsolute(relative))
    || relative === '';
}

function resolveDefaultCognitiveMemoryDbPath(options = {}) {
  if (options.projectRoot) {
    const profileName = normalizeProfileName(options.profileName || getActiveProfile());
    const relPath = namespaceCoordRelPath(path.join('runtime', 'cognitive-memory.db'), profileName);
    return path.resolve(path.join(path.resolve(String(options.projectRoot)), '.squidrun', relPath));
  }
  return path.resolve(resolveCoordPath(path.join('runtime', 'cognitive-memory.db'), { forWrite: true }));
}

function resolveLegacyCognitiveMemoryDbPath(projectRoot) {
  return path.resolve(path.join(projectRoot, 'workspace', 'memory', 'cognitive-memory.db'));
}

function resolveDefaultPendingPrPath(options = {}) {
  if (options.projectRoot) {
    const profileName = normalizeProfileName(options.profileName || getActiveProfile());
    const relPath = namespaceCoordRelPath(path.join('memory', 'pending-pr.json'), profileName);
    return path.resolve(path.join(path.resolve(String(options.projectRoot)), '.squidrun', relPath));
  }
  return path.resolve(resolveCoordPath(path.join('memory', 'pending-pr.json'), { forWrite: true }));
}

/**
 * @param {Record<string, unknown>} [options]
 * @returns {WorkspacePaths & { profileName: string, coordRoot: string, expectedDbPath: string, legacyDbPath: string, explicitDbPath: boolean, allowUnscopedDbPath: boolean }}
 */
function resolveWorkspacePaths(options = {}) {
  const projectRoot = path.resolve(String(options.projectRoot || getProjectRoot() || process.cwd()));
  const workspaceDir = path.resolve(String(options.workspaceDir || path.join(projectRoot, 'workspace')));
  const profileName = normalizeProfileName(options.profileName || getActiveProfile());
  const coordRoot = path.resolve(String(options.coordRoot || path.join(projectRoot, '.squidrun')));
  const expectedDbPath = path.resolve(String(options.expectedDbPath || resolveDefaultCognitiveMemoryDbPath({
    projectRoot,
    profileName,
  })));
  const legacyDbPath = path.resolve(String(options.legacyDbPath || resolveLegacyCognitiveMemoryDbPath(projectRoot)));
  const explicitDbPath = options.dbPath != null;
  const dbPath = path.resolve(String(options.dbPath || expectedDbPath));
  const memoryDir = path.resolve(String(options.memoryDir || path.dirname(dbPath)));
  const pendingPrPath = path.resolve(String(options.pendingPrPath || resolveDefaultPendingPrPath({
    projectRoot,
    profileName,
  })));
  return {
    projectRoot,
    workspaceDir,
    memoryDir,
    dbPath,
    pendingPrPath,
    profileName,
    coordRoot,
    expectedDbPath,
    legacyDbPath,
    explicitDbPath,
    allowUnscopedDbPath: options.allowUnscopedDbPath === true,
  };
}

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
 * @param {number} [fallback]
 * @returns {number}
 */
function asNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

/**
 * @param {unknown} value
 * @param {number} [fallback]
 * @returns {number}
 */
function clampConfidence(value, fallback = 0.5) {
  const numeric = asNumber(value, fallback);
  return Math.max(0, Math.min(1, numeric));
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

class CognitiveMemoryStore {
  /**
   * @param {Record<string, unknown>} [options]
   */
  constructor(options = {}) {
    this.paths = resolveWorkspacePaths(options);
    this.dbPath = this.paths.dbPath;
    this.pendingPrPath = this.paths.pendingPrPath;
    this.db = null;
    this.writeAssertionLabel = `profile=${this.paths.profileName} db=${this.dbPath}`;
  }

  assertProfileScopedWrite(operation = 'write') {
    const expected = path.resolve(this.paths.expectedDbPath);
    const actual = path.resolve(this.dbPath);
    if (this.paths.allowUnscopedDbPath === true) return;
    if (actual !== expected) {
      throw new Error(
        `Cognitive memory ${operation} blocked: dbPath is not profile-scoped (${this.writeAssertionLabel}; expected=${expected}).`
      );
    }
    if (!isPathInside(actual, this.paths.coordRoot)) {
      throw new Error(
        `Cognitive memory ${operation} blocked: dbPath is outside coord root (${this.writeAssertionLabel}; coordRoot=${this.paths.coordRoot}).`
      );
    }
  }

  seedMainRuntimeDbFromLegacyIfNeeded() {
    if (!isMainProfile(this.paths.profileName)) return;
    if (this.paths.allowUnscopedDbPath === true) return;
    const targetPath = path.resolve(this.dbPath);
    const legacyPath = path.resolve(this.paths.legacyDbPath);
    if (targetPath === legacyPath) return;
    const targetSize = fileSize(targetPath);
    if (targetSize > 0 || fileSize(legacyPath) <= 0) return;
    ensureDir(targetPath);
    if (fileExists(targetPath) && targetSize === 0) {
      try { fs.rmSync(targetPath, { force: true }); } catch {}
    }
    const sourceDb = new DatabaseSync(legacyPath);
    try {
      sourceDb.exec(`VACUUM INTO ${sqlStringLiteral(targetPath)};`);
    } finally {
      try { sourceDb.close(); } catch {}
    }
  }

  init() {
    if (this.db) return this.db;
    this.assertProfileScopedWrite('init');
    this.seedMainRuntimeDbFromLegacyIfNeeded();
    ensureDir(this.dbPath);
    ensureDir(this.pendingPrPath);
    const db = new DatabaseSync(this.dbPath);
    db.exec('PRAGMA journal_mode=WAL;');
    db.exec('PRAGMA synchronous=NORMAL;');
    db.exec('PRAGMA temp_store=MEMORY;');
    db.exec('PRAGMA foreign_keys=ON;');
    db.exec('PRAGMA busy_timeout=5000;');
    db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        node_id TEXT PRIMARY KEY,
        category TEXT,
        content TEXT,
        confidence_score REAL DEFAULT 0.5,
        access_count INTEGER DEFAULT 0,
        last_accessed_at TEXT,
        last_reconsolidated_at TEXT,
        is_immune INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS edges (
        source_node_id TEXT,
        target_node_id TEXT,
        relation_type TEXT,
        weight REAL DEFAULT 1.0
      );

      CREATE TABLE IF NOT EXISTS traces (
        node_id TEXT,
        trace_id TEXT,
        extracted_at TEXT
      );

      CREATE TABLE IF NOT EXISTS transactive_meta (
        domain TEXT PRIMARY KEY,
        primary_agent_id TEXT,
        expertise_score REAL DEFAULT 0,
        last_proven_at TEXT,
        last_pane_id TEXT,
        proof_count INTEGER DEFAULT 0,
        updated_at_ms INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS memory_pr_queue (
        pr_id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        statement TEXT NOT NULL,
        normalized_statement TEXT NOT NULL,
        source_trace TEXT,
        source_payload_json TEXT NOT NULL DEFAULT '{}',
        confidence_score REAL DEFAULT 0.5,
        review_count INTEGER DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        domain TEXT,
        proposed_by TEXT,
        correction_of TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        UNIQUE(normalized_statement, category, status)
      );

      CREATE INDEX IF NOT EXISTS idx_memory_pr_status ON memory_pr_queue(status, updated_at_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_pr_domain ON memory_pr_queue(domain, updated_at_ms DESC);

      CREATE TABLE IF NOT EXISTS antibody_queue (
        queue_id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL,
        conflicting_node_id TEXT,
        request_type TEXT NOT NULL DEFAULT 'classification',
        status TEXT NOT NULL DEFAULT 'pending',
        classifier_strategy TEXT,
        classifier_request_id TEXT,
        heuristic_label TEXT,
        heuristic_score REAL DEFAULT 0,
        payload_json TEXT NOT NULL DEFAULT '{}',
        result_json TEXT NOT NULL DEFAULT '{}',
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        last_attempt_at_ms INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_antibody_queue_status ON antibody_queue(status, updated_at_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_antibody_queue_node ON antibody_queue(node_id, updated_at_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_antibody_queue_conflict ON antibody_queue(conflicting_node_id, updated_at_ms DESC);

      CREATE TABLE IF NOT EXISTS agent_domain_trust (
        agent_id TEXT NOT NULL,
        domain TEXT NOT NULL,
        trust_score REAL NOT NULL DEFAULT 0.5,
        suspicion_score REAL NOT NULL DEFAULT 0,
        accepted_count INTEGER NOT NULL DEFAULT 0,
        rejected_count INTEGER NOT NULL DEFAULT 0,
        updated_at_ms INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (agent_id, domain)
      );

      CREATE INDEX IF NOT EXISTS idx_agent_domain_trust_suspicion
      ON agent_domain_trust(domain, suspicion_score DESC, updated_at_ms DESC);
    `);
    ensureColumn(db, 'nodes', 'is_immune', 'INTEGER DEFAULT 0');
    ensureColumn(db, 'nodes', 'antibody_status', "TEXT DEFAULT 'clear'");
    ensureColumn(db, 'nodes', 'antibody_score', 'REAL DEFAULT 0');
    ensureColumn(db, 'nodes', 'conflicts_with_memory_id', 'TEXT');
    ensureColumn(db, 'nodes', 'classified_by', 'TEXT');
    ensureColumn(db, 'nodes', 'classified_at', 'INTEGER DEFAULT 0');
    ensureColumn(db, 'nodes', 'adjudication_status', 'TEXT');
    ensureColumn(db, 'nodes', 'quarantined_at', 'INTEGER DEFAULT 0');
    db.prepare(`
      UPDATE nodes
      SET antibody_status = COALESCE(NULLIF(TRIM(antibody_status), ''), 'clear'),
          antibody_score = COALESCE(antibody_score, 0),
          classified_at = COALESCE(classified_at, 0),
          quarantined_at = COALESCE(quarantined_at, 0)
    `).run();
    this.db = db;
    return db;
  }

  close() {
    if (!this.db) return;
    try { this.db.close(); } catch {}
    this.db = null;
  }

  /**
   * @param {{ status?: string, limit?: number | string }} [options]
   * @returns {MemoryPrRow[]}
   */
  listPendingPRs(options = {}) {
    const db = this.init();
    const status = String(options.status || 'pending');
    const limit = Math.max(1, Math.min(500, Number.parseInt(options.limit || '100', 10) || 100));
    return db.prepare(`
      SELECT * FROM memory_pr_queue
      WHERE status = ?
      ORDER BY updated_at_ms DESC
      LIMIT ?
    `).all(status, limit);
  }

  /**
   * @param {string[] | string} [ids]
   * @returns {MemoryPrRow[]}
   */
  getMemoryPRsByIds(ids = []) {
    const normalizedIds = Array.from(new Set(
      (Array.isArray(ids) ? ids : [ids])
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    ));
    if (!normalizedIds.length) return [];
    const db = this.init();
    const placeholders = normalizedIds.map(() => '?').join(', ');
    return db.prepare(`
      SELECT * FROM memory_pr_queue
      WHERE pr_id IN (${placeholders})
      ORDER BY updated_at_ms DESC
    `).all(...normalizedIds);
  }

  /**
   * @param {MemoryPrCandidate[]} [candidates]
   * @param {Record<string, unknown>} [options]
   * @returns {{ ok: true, staged: string[], merged: string[], pendingCount: number }}
   */
  stageMemoryPRs(candidates = [], options = {}) {
    this.assertProfileScopedWrite('stageMemoryPRs');
    const db = this.init();
    const nowMs = Date.now();
    const staged = [];
    const merged = [];

    db.exec('BEGIN IMMEDIATE;');
    try {
      for (const candidate of candidates) {
        const statement = String(candidate.statement || '').trim();
        const category = String(candidate.category || 'fact').trim().toLowerCase();
        if (!statement) continue;
        const normalizedStatement = statement.toLowerCase();
        const confidenceScore = clampConfidence(candidate.confidence_score, 0.5);
        const reviewCount = Math.max(0, Number.parseInt(candidate.review_count || '0', 10) || 0);
        const existing = db.prepare(`
          SELECT * FROM memory_pr_queue
          WHERE normalized_statement = ?
            AND category = ?
            AND status = 'pending'
          LIMIT 1
        `).get(normalizedStatement, category);

        if (existing) {
          const nextConfidence = Math.max(existing.confidence_score || 0, confidenceScore);
          db.prepare(`
            UPDATE memory_pr_queue
            SET confidence_score = ?,
                review_count = ?,
                updated_at_ms = ?,
                source_payload_json = ?,
                source_trace = ?
            WHERE pr_id = ?
          `).run(
            nextConfidence,
            Number(existing.review_count || 0) + reviewCount,
            nowMs,
            JSON.stringify(candidate.source_payload || {}),
            candidate.source_trace || existing.source_trace || null,
            existing.pr_id
          );
          merged.push(existing.pr_id);
          continue;
        }

        const prId = String(candidate.pr_id || generateId('pr'));
        db.prepare(`
          INSERT INTO memory_pr_queue (
            pr_id,
            category,
            statement,
            normalized_statement,
            source_trace,
            source_payload_json,
            confidence_score,
            review_count,
            status,
            domain,
            proposed_by,
            correction_of,
            created_at_ms,
            updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          prId,
          category,
          statement,
          normalizedStatement,
          candidate.source_trace || null,
          JSON.stringify(candidate.source_payload || {}),
          confidenceScore,
          reviewCount,
          String(candidate.status || 'pending'),
          candidate.domain ? String(candidate.domain) : null,
          candidate.proposed_by ? String(candidate.proposed_by) : null,
          candidate.correction_of ? String(candidate.correction_of) : null,
          nowMs,
          nowMs
        );
        staged.push(prId);
      }
      db.exec('COMMIT;');
    } catch (err) {
      try { db.exec('ROLLBACK;'); } catch {}
      throw err;
    }

    this.syncPendingPrFile();
    return {
      ok: true,
      staged,
      merged,
      pendingCount: this.listPendingPRs({ limit: 500 }).length,
    };
  }

  /**
   * @returns {{ version: number, updatedAt: string, items: Array<Record<string, unknown>> }}
   */
  syncPendingPrFile() {
    this.assertProfileScopedWrite('syncPendingPrFile');
    const payload = {
      version: 1,
      updatedAt: new Date().toISOString(),
      items: this.listPendingPRs({ limit: 1000 }).map((row) => ({
        pr_id: row.pr_id,
        category: row.category,
        statement: row.statement,
        source_trace: row.source_trace,
        source_payload: JSON.parse(row.source_payload_json || '{}'),
        confidence_score: row.confidence_score,
        review_count: row.review_count,
        status: row.status,
        domain: row.domain,
        proposed_by: row.proposed_by,
        correction_of: row.correction_of,
        created_at_ms: row.created_at_ms,
        updated_at_ms: row.updated_at_ms,
      })),
    };
    ensureDir(this.pendingPrPath);
    fs.writeFileSync(this.pendingPrPath, JSON.stringify(payload, null, 2));
    return payload;
  }

  /**
   * @param {{ domain?: string, agent_id?: string, primary_agent_id?: string, expertise_delta?: number, pane_id?: string }} [input]
   * @returns {Record<string, unknown>}
   */
  recordTransactiveUse(input = {}) {
    this.assertProfileScopedWrite('recordTransactiveUse');
    const db = this.init();
    const domain = String(input.domain || '').trim();
    const agentId = String(input.agent_id || input.primary_agent_id || '').trim();
    if (!domain || !agentId) {
      return { ok: false, reason: 'domain_and_agent_required' };
    }

    const expertiseDelta = Math.max(0.01, Math.min(1, asNumber(input.expertise_delta, 0.1)));
    const nowIso = new Date().toISOString();
    const nowMs = Date.now();
    const paneId = input.pane_id ? String(input.pane_id) : null;
    const existing = db.prepare(`
      SELECT * FROM transactive_meta WHERE domain = ? LIMIT 1
    `).get(domain);

    if (existing) {
      const nextScore = Math.max(0, Math.min(1, Number(existing.expertise_score || 0) + expertiseDelta));
      db.prepare(`
        UPDATE transactive_meta
        SET primary_agent_id = ?,
            expertise_score = ?,
            last_proven_at = ?,
            last_pane_id = ?,
            proof_count = proof_count + 1,
            updated_at_ms = ?
        WHERE domain = ?
      `).run(agentId, nextScore, nowIso, paneId, nowMs, domain);
      return { ok: true, status: 'updated', domain, primary_agent_id: agentId, expertise_score: nextScore };
    }

    db.prepare(`
      INSERT INTO transactive_meta (
        domain,
        primary_agent_id,
        expertise_score,
        last_proven_at,
        last_pane_id,
        proof_count,
        updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(domain, agentId, expertiseDelta, nowIso, paneId, 1, nowMs);
    return { ok: true, status: 'inserted', domain, primary_agent_id: agentId, expertise_score: expertiseDelta };
  }

  /**
   * @param {{ limit?: number | string }} [options]
   * @returns {TransactiveMetaRow[]}
   */
  listTransactiveMeta(options = {}) {
    const db = this.init();
    const limit = Math.max(1, Math.min(500, Number.parseInt(options.limit || '100', 10) || 100));
    return db.prepare(`
      SELECT * FROM transactive_meta
      ORDER BY expertise_score DESC, updated_at_ms DESC
      LIMIT ?
    `).all(limit);
  }

  /**
   * @param {{ node_id?: string, conflicting_node_id?: string | null, request_type?: string, status?: string, classifier_strategy?: string | null, classifier_request_id?: string | null, heuristic_label?: string | null, heuristic_score?: number, payload?: Record<string, unknown>, result?: Record<string, unknown> }} [input]
   * @returns {{ ok: boolean, reason?: string, queue_id?: string, status?: string }}
   */
  enqueueAntibodyJob(input = {}) {
    this.assertProfileScopedWrite('enqueueAntibodyJob');
    const db = this.init();
    const nodeId = String(input.node_id || '').trim();
    if (!nodeId) {
      return { ok: false, reason: 'node_id_required' };
    }

    const conflictingNodeId = input.conflicting_node_id ? String(input.conflicting_node_id).trim() : null;
    const requestType = String(input.request_type || 'classification').trim() || 'classification';
    const classifierStrategy = input.classifier_strategy ? String(input.classifier_strategy).trim() : null;
    const nowMs = Date.now();
    const existing = db.prepare(`
      SELECT queue_id
      FROM antibody_queue
      WHERE node_id = ?
        AND COALESCE(conflicting_node_id, '') = COALESCE(?, '')
        AND request_type = ?
        AND status IN ('pending', 'dispatched', 'responses_pending', 'awaiting_adjudication')
      ORDER BY updated_at_ms DESC
      LIMIT 1
    `).get(nodeId, conflictingNodeId, requestType);

    if (existing?.queue_id) {
      db.prepare(`
        UPDATE antibody_queue
        SET classifier_strategy = COALESCE(?, classifier_strategy),
            heuristic_label = COALESCE(?, heuristic_label),
            heuristic_score = MAX(COALESCE(heuristic_score, 0), ?),
            payload_json = ?,
            updated_at_ms = ?
        WHERE queue_id = ?
      `).run(
        classifierStrategy,
        input.heuristic_label ? String(input.heuristic_label) : null,
        Math.max(0, Math.min(1, asNumber(input.heuristic_score, 0))),
        JSON.stringify(input.payload || {}),
        nowMs,
        existing.queue_id
      );
      return { ok: true, queue_id: existing.queue_id, status: 'merged' };
    }

    const queueId = generateId('antibody');
    db.prepare(`
      INSERT INTO antibody_queue (
        queue_id,
        node_id,
        conflicting_node_id,
        request_type,
        status,
        classifier_strategy,
        classifier_request_id,
        heuristic_label,
        heuristic_score,
        payload_json,
        result_json,
        created_at_ms,
        updated_at_ms,
        last_attempt_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      queueId,
      nodeId,
      conflictingNodeId,
      requestType,
      String(input.status || 'pending'),
      classifierStrategy,
      input.classifier_request_id ? String(input.classifier_request_id) : null,
      input.heuristic_label ? String(input.heuristic_label) : null,
      Math.max(0, Math.min(1, asNumber(input.heuristic_score, 0))),
      JSON.stringify(input.payload || {}),
      JSON.stringify(input.result || {}),
      nowMs,
      nowMs,
      null
    );
    return { ok: true, queue_id: queueId, status: 'queued' };
  }

  /**
   * @param {{ status?: string | string[], limit?: number | string }} [options]
   * @returns {AntibodyQueueRow[]}
   */
  listAntibodyQueue(options = {}) {
    const db = this.init();
    const limit = Math.max(1, Math.min(500, Number.parseInt(options.limit || '100', 10) || 100));
    const statuses = Array.isArray(options.status) ? options.status : [options.status || 'pending'];
    const normalizedStatuses = Array.from(new Set(statuses.map((value) => String(value || '').trim()).filter(Boolean)));
    if (normalizedStatuses.length === 0) {
      return db.prepare(`
        SELECT *
        FROM antibody_queue
        ORDER BY updated_at_ms DESC
        LIMIT ?
      `).all(limit);
    }
    const placeholders = normalizedStatuses.map(() => '?').join(', ');
    return db.prepare(`
      SELECT *
      FROM antibody_queue
      WHERE status IN (${placeholders})
      ORDER BY updated_at_ms DESC
      LIMIT ?
    `).all(...normalizedStatuses, limit);
  }

  /**
   * @param {string} queueId
   * @returns {AntibodyQueueRow | null}
   */
  getAntibodyQueueItem(queueId) {
    const normalizedQueueId = String(queueId || '').trim();
    if (!normalizedQueueId) return null;
    return this.init().prepare(`
      SELECT *
      FROM antibody_queue
      WHERE queue_id = ?
      LIMIT 1
    `).get(normalizedQueueId) || null;
  }

  /**
   * @param {string} queueId
   * @param {{ status?: string, classifier_request_id?: string | null, payload?: Record<string, unknown>, result?: Record<string, unknown>, heuristic_label?: string | null, heuristic_score?: number, last_attempt_at_ms?: number | null }} [patch]
   * @returns {{ ok: boolean, reason?: string }}
   */
  updateAntibodyJob(queueId, patch = {}) {
    this.assertProfileScopedWrite('updateAntibodyJob');
    const normalizedQueueId = String(queueId || '').trim();
    if (!normalizedQueueId) {
      return { ok: false, reason: 'queue_id_required' };
    }
    const existing = this.getAntibodyQueueItem(normalizedQueueId);
    if (!existing) {
      return { ok: false, reason: 'queue_item_not_found' };
    }

    const nowMs = Date.now();
    this.init().prepare(`
      UPDATE antibody_queue
      SET status = COALESCE(?, status),
          classifier_request_id = COALESCE(?, classifier_request_id),
          payload_json = ?,
          result_json = ?,
          heuristic_label = COALESCE(?, heuristic_label),
          heuristic_score = COALESCE(?, heuristic_score),
          last_attempt_at_ms = COALESCE(?, last_attempt_at_ms),
          updated_at_ms = ?
      WHERE queue_id = ?
    `).run(
      patch.status ? String(patch.status) : null,
      patch.classifier_request_id ? String(patch.classifier_request_id) : null,
      JSON.stringify(patch.payload || JSON.parse(existing.payload_json || '{}')),
      JSON.stringify(patch.result || JSON.parse(existing.result_json || '{}')),
      patch.heuristic_label ? String(patch.heuristic_label) : null,
      patch.heuristic_score == null ? null : Math.max(0, Math.min(1, asNumber(patch.heuristic_score, 0))),
      patch.last_attempt_at_ms == null ? null : asNumber(patch.last_attempt_at_ms, 0),
      nowMs,
      normalizedQueueId
    );
    return { ok: true };
  }

  /**
   * @param {{ agent_id?: string, domain?: string, trust_delta?: number, suspicion_delta?: number, accepted_delta?: number | string, rejected_delta?: number | string }} [input]
   * @returns {{ ok: boolean, reason?: string, row?: AgentDomainTrustRow }}
   */
  updateAgentDomainTrust(input = {}) {
    this.assertProfileScopedWrite('updateAgentDomainTrust');
    const db = this.init();
    const agentId = String(input.agent_id || '').trim();
    const domain = String(input.domain || '').trim().toLowerCase();
    if (!agentId || !domain) {
      return { ok: false, reason: 'agent_id_and_domain_required' };
    }

    const existing = db.prepare(`
      SELECT *
      FROM agent_domain_trust
      WHERE agent_id = ? AND domain = ?
      LIMIT 1
    `).get(agentId, domain);
    const nowMs = Date.now();
    const trustDelta = asNumber(input.trust_delta, 0);
    const suspicionDelta = asNumber(input.suspicion_delta, 0);
    const acceptedDelta = Math.max(0, Number.parseInt(input.accepted_delta || '0', 10) || 0);
    const rejectedDelta = Math.max(0, Number.parseInt(input.rejected_delta || '0', 10) || 0);

    if (existing) {
      const nextTrust = Math.max(0, Math.min(1, asNumber(existing.trust_score, 0.5) + trustDelta));
      const nextSuspicion = Math.max(0, Math.min(1, asNumber(existing.suspicion_score, 0) + suspicionDelta));
      db.prepare(`
        UPDATE agent_domain_trust
        SET trust_score = ?,
            suspicion_score = ?,
            accepted_count = accepted_count + ?,
            rejected_count = rejected_count + ?,
            updated_at_ms = ?
        WHERE agent_id = ? AND domain = ?
      `).run(
        nextTrust,
        nextSuspicion,
        acceptedDelta,
        rejectedDelta,
        nowMs,
        agentId,
        domain
      );
    } else {
      db.prepare(`
        INSERT INTO agent_domain_trust (
          agent_id,
          domain,
          trust_score,
          suspicion_score,
          accepted_count,
          rejected_count,
          updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        agentId,
        domain,
        Math.max(0, Math.min(1, 0.5 + trustDelta)),
        Math.max(0, Math.min(1, suspicionDelta)),
        acceptedDelta,
        rejectedDelta,
        nowMs
      );
    }

    return {
      ok: true,
      row: db.prepare(`
        SELECT *
        FROM agent_domain_trust
        WHERE agent_id = ? AND domain = ?
        LIMIT 1
      `).get(agentId, domain),
    };
  }

  /**
   * @param {{ ids?: string[] | string, status?: string, review_increment?: number | string }} [input]
   * @returns {{ ok: boolean, reason?: string, updated: number, rows: MemoryPrRow[] }}
   */
  reviewMemoryPRs(input = {}) {
    this.assertProfileScopedWrite('reviewMemoryPRs');
    const db = this.init();
    const ids = Array.from(new Set(
      (Array.isArray(input.ids) ? input.ids : [input.ids])
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    ));
    const status = String(input.status || 'pending').trim().toLowerCase();
    const reviewIncrement = Math.max(0, Number.parseInt(input.review_increment || '1', 10) || 0);
    if (!ids.length) {
      return { ok: false, reason: 'ids_required', updated: 0, rows: [] };
    }

    const allowedStatuses = new Set(['pending', 'promoted', 'rejected', 'archived']);
    if (!allowedStatuses.has(status)) {
      return { ok: false, reason: 'invalid_status', updated: 0, rows: [] };
    }

    const nowMs = Date.now();
    db.exec('BEGIN IMMEDIATE;');
    try {
      const updateStmt = db.prepare(`
        UPDATE memory_pr_queue
        SET status = ?,
            review_count = review_count + ?,
            updated_at_ms = ?
        WHERE pr_id = ?
      `);
      for (const id of ids) {
        updateStmt.run(status, reviewIncrement, nowMs, id);
      }
      db.exec('COMMIT;');
    } catch (err) {
      try { db.exec('ROLLBACK;'); } catch {}
      throw err;
    }

    const rows = this.getMemoryPRsByIds(ids);
    this.syncPendingPrFile();
    return { ok: true, updated: rows.length, rows };
  }
}

module.exports = {
  CognitiveMemoryStore,
  resolveDefaultCognitiveMemoryDbPath,
  resolveDefaultPendingPrPath,
  resolveLegacyCognitiveMemoryDbPath,
  resolveWorkspacePaths,
};
