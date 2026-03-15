const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getDatabaseSync } = require('./sqlite-compat');
const DatabaseSync = getDatabaseSync();
const { resolveCoordPath, getProjectRoot } = require('../config');

function ensureDir(targetPath) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
}

function resolveWorkspacePaths(options = {}) {
  const projectRoot = path.resolve(String(options.projectRoot || getProjectRoot() || process.cwd()));
  const workspaceDir = path.resolve(String(options.workspaceDir || path.join(projectRoot, 'workspace')));
  const memoryDir = path.resolve(String(options.memoryDir || path.join(workspaceDir, 'memory')));
  const dbPath = path.resolve(String(options.dbPath || path.join(memoryDir, 'cognitive-memory.db')));
  const pendingPrPath = path.resolve(String(options.pendingPrPath || resolveCoordPath(path.join('memory', 'pending-pr.json'), { forWrite: true })));
  return { projectRoot, workspaceDir, memoryDir, dbPath, pendingPrPath };
}

function generateId(prefix = 'mem') {
  try {
    return `${prefix}-${crypto.randomUUID()}`;
  } catch {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

function asNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clampConfidence(value, fallback = 0.5) {
  const numeric = asNumber(value, fallback);
  return Math.max(0, Math.min(1, numeric));
}

function ensureColumn(db, tableName, columnName, definition) {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all();
  const exists = rows.some((row) => String(row.name) === String(columnName));
  if (!exists) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

class CognitiveMemoryStore {
  constructor(options = {}) {
    this.paths = resolveWorkspacePaths(options);
    this.dbPath = this.paths.dbPath;
    this.pendingPrPath = this.paths.pendingPrPath;
    this.db = null;
  }

  init() {
    if (this.db) return this.db;
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
    `);
    ensureColumn(db, 'nodes', 'is_immune', 'INTEGER DEFAULT 0');
    this.db = db;
    return db;
  }

  close() {
    if (!this.db) return;
    try { this.db.close(); } catch {}
    this.db = null;
  }

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

  stageMemoryPRs(candidates = [], options = {}) {
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

  syncPendingPrFile() {
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

  recordTransactiveUse(input = {}) {
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

  listTransactiveMeta(options = {}) {
    const db = this.init();
    const limit = Math.max(1, Math.min(500, Number.parseInt(options.limit || '100', 10) || 100));
    return db.prepare(`
      SELECT * FROM transactive_meta
      ORDER BY expertise_score DESC, updated_at_ms DESC
      LIMIT ?
    `).all(limit);
  }

  reviewMemoryPRs(input = {}) {
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
  resolveWorkspacePaths,
};
