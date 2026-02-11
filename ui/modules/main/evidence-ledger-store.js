/**
 * Evidence Ledger Store
 * Durable append/query store for canonical event envelopes.
 */

const fs = require('fs');
const path = require('path');
const log = require('../logger');
const { WORKSPACE_PATH, evidenceLedgerEnabled: CONFIG_EVIDENCE_LEDGER_ENABLED } = require('../../config');
const { prepareEventForStorage } = require('./evidence-ledger-ingest');

const DEFAULT_DB_PATH = path.join(WORKSPACE_PATH, 'runtime', 'evidence-ledger.db');
const DEFAULT_MAX_ROWS = 2_000_000;
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const LOGGED_DEGRADE_KEYS = new Set();

function logDegradedOnce(level, key, message) {
  if (LOGGED_DEGRADE_KEYS.has(key)) return;
  LOGGED_DEGRADE_KEYS.add(key);
  const logger = (level === 'error') ? log.error : (level === 'info' ? log.info : log.warn);
  logger('EvidenceLedger', message);
}

const SCHEMA_V1_SQL = `
CREATE TABLE IF NOT EXISTS ledger_events (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  trace_id TEXT NOT NULL,
  span_id TEXT,
  parent_event_id TEXT,
  correlation_id TEXT,
  causation_id TEXT,
  type TEXT NOT NULL,
  stage TEXT NOT NULL,
  source TEXT NOT NULL,
  pane_id TEXT,
  role TEXT,
  ts_ms INTEGER NOT NULL,
  seq INTEGER,
  direction TEXT,
  payload_json TEXT NOT NULL,
  payload_hash TEXT,
  evidence_refs_json TEXT,
  meta_json TEXT,
  ingested_at_ms INTEGER NOT NULL,
  session_id TEXT
);

CREATE TABLE IF NOT EXISTS ledger_edges (
  edge_id INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id TEXT NOT NULL,
  from_event_id TEXT NOT NULL,
  to_event_id TEXT NOT NULL,
  edge_type TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  UNIQUE(trace_id, from_event_id, to_event_id, edge_type)
);

CREATE TABLE IF NOT EXISTS ledger_spans (
  span_id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL,
  parent_span_id TEXT,
  stage TEXT NOT NULL,
  source TEXT NOT NULL,
  pane_id TEXT,
  role TEXT,
  started_at_ms INTEGER NOT NULL,
  ended_at_ms INTEGER,
  status TEXT NOT NULL,
  event_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_ledger_events_trace_ts
  ON ledger_events(trace_id, ts_ms, row_id);

CREATE INDEX IF NOT EXISTS idx_ledger_events_type_ts
  ON ledger_events(type, ts_ms);

CREATE INDEX IF NOT EXISTS idx_ledger_events_stage_ts
  ON ledger_events(stage, ts_ms);

CREATE INDEX IF NOT EXISTS idx_ledger_events_pane_ts
  ON ledger_events(pane_id, ts_ms);

CREATE INDEX IF NOT EXISTS idx_ledger_events_parent
  ON ledger_events(parent_event_id);

CREATE INDEX IF NOT EXISTS idx_ledger_edges_trace
  ON ledger_edges(trace_id, created_at_ms);
`;

const SCHEMA_V2_SQL = `
CREATE TABLE IF NOT EXISTS ledger_incidents (
  incident_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  severity TEXT NOT NULL DEFAULT 'medium',
  created_by TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  closed_at_ms INTEGER,
  session_id TEXT,
  tags_json TEXT DEFAULT '[]',
  meta_json TEXT DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_incidents_status_updated
  ON ledger_incidents(status, updated_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_incidents_session
  ON ledger_incidents(session_id, created_at_ms DESC);

CREATE TABLE IF NOT EXISTS ledger_incident_traces (
  incident_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  linked_at_ms INTEGER NOT NULL,
  linked_by TEXT NOT NULL,
  note TEXT,
  PRIMARY KEY (incident_id, trace_id)
);

CREATE INDEX IF NOT EXISTS idx_incident_traces_trace
  ON ledger_incident_traces(trace_id);

CREATE TABLE IF NOT EXISTS ledger_assertions (
  assertion_id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL,
  claim TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'hypothesis',
  confidence REAL NOT NULL DEFAULT 0.5,
  status TEXT NOT NULL DEFAULT 'active',
  author TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  superseded_by TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  reasoning TEXT,
  meta_json TEXT DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_assertions_incident
  ON ledger_assertions(incident_id, updated_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_assertions_status
  ON ledger_assertions(status, confidence DESC);

CREATE TABLE IF NOT EXISTS ledger_evidence_bindings (
  binding_id TEXT PRIMARY KEY,
  assertion_id TEXT NOT NULL,
  incident_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  relation TEXT NOT NULL DEFAULT 'supports',
  event_id TEXT,
  trace_id TEXT,
  span_id TEXT,
  file_path TEXT,
  file_line INTEGER,
  file_column INTEGER,
  snapshot_hash TEXT,
  log_start_ms INTEGER,
  log_end_ms INTEGER,
  log_source TEXT,
  log_filter_json TEXT,
  query_json TEXT,
  query_result_hash TEXT,
  note TEXT,
  created_at_ms INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  stale INTEGER NOT NULL DEFAULT 0,
  meta_json TEXT DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_bindings_assertion
  ON ledger_evidence_bindings(assertion_id);

CREATE INDEX IF NOT EXISTS idx_bindings_incident
  ON ledger_evidence_bindings(incident_id);

CREATE INDEX IF NOT EXISTS idx_bindings_event
  ON ledger_evidence_bindings(event_id);

CREATE TABLE IF NOT EXISTS ledger_verdicts (
  verdict_id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL,
  value TEXT NOT NULL,
  confidence REAL NOT NULL,
  version INTEGER NOT NULL,
  reason TEXT,
  key_assertion_ids_json TEXT DEFAULT '[]',
  author TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  meta_json TEXT DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_verdicts_incident_version
  ON ledger_verdicts(incident_id, version DESC);
`;

const SCHEMA_V3_SQL = `
CREATE TABLE IF NOT EXISTS ledger_decisions (
  decision_id TEXT PRIMARY KEY,
  session_id TEXT,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  author TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  superseded_by TEXT,
  incident_id TEXT,
  tags_json TEXT DEFAULT '[]',
  meta_json TEXT DEFAULT '{}',
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_decisions_category_status
  ON ledger_decisions(category, status, updated_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_decisions_session
  ON ledger_decisions(session_id, created_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_decisions_status_updated
  ON ledger_decisions(status, updated_at_ms DESC);

CREATE TABLE IF NOT EXISTS ledger_sessions (
  session_id TEXT PRIMARY KEY,
  session_number INTEGER NOT NULL,
  mode TEXT NOT NULL DEFAULT 'PTY',
  started_at_ms INTEGER NOT NULL,
  ended_at_ms INTEGER,
  summary TEXT,
  stats_json TEXT DEFAULT '{}',
  team_json TEXT DEFAULT '{}',
  meta_json TEXT DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_sessions_number
  ON ledger_sessions(session_number DESC);

CREATE TABLE IF NOT EXISTS ledger_context_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  content_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  trigger TEXT NOT NULL DEFAULT 'manual'
);

CREATE INDEX IF NOT EXISTS idx_snapshots_session
  ON ledger_context_snapshots(session_id, created_at_ms DESC);
`;

function toMs(value, fallback) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 0) {
    return Math.floor(numeric);
  }
  return fallback;
}

function parseJson(value, fallback) {
  if (!value || typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function loadSqliteDriver() {
  try {
    // Node 22+ built-in SQLite (experimental but available in this runtime).
    // eslint-disable-next-line global-require
    const mod = require('node:sqlite');
    if (mod && typeof mod.DatabaseSync === 'function') {
      return {
        name: 'node:sqlite',
        create: (filename) => new mod.DatabaseSync(filename),
      };
    }
  } catch {
    // Continue to external driver fallback.
  }

  try {
    // eslint-disable-next-line global-require
    const BetterSqlite3 = require('better-sqlite3');
    return {
      name: 'better-sqlite3',
      create: (filename) => new BetterSqlite3(filename),
    };
  } catch {
    return null;
  }
}

class EvidenceLedgerStore {
  constructor(options = {}) {
    this.dbPath = options.dbPath || DEFAULT_DB_PATH;
    this.maxRows = Math.max(1, Number(options.maxRows) || DEFAULT_MAX_ROWS);
    this.retentionMs = Math.max(1_000, Number(options.retentionMs) || DEFAULT_RETENTION_MS);
    this.sessionId = typeof options.sessionId === 'string' ? options.sessionId : null;
    this.configEnabled = CONFIG_EVIDENCE_LEDGER_ENABLED !== false;
    this.enabled = this.configEnabled && options.enabled !== false;

    this.db = null;
    this.driverName = null;
    this.available = false;
    this.degradedReason = null;
  }

  init() {
    if (!this.enabled) {
      this.degradedReason = 'disabled';
      logDegradedOnce('warn', 'disabled', 'Ledger disabled by config/flag; running in degraded mode');
      return { ok: false, reason: this.degradedReason };
    }

    try {
      const runtimeDir = path.dirname(this.dbPath);
      fs.mkdirSync(runtimeDir, { recursive: true });
    } catch (err) {
      this.degradedReason = `runtime_dir_error:${err.message}`;
      logDegradedOnce('error', 'runtime_dir_error', `Failed to create runtime dir: ${err.message}`);
      return { ok: false, reason: this.degradedReason };
    }

    const driver = loadSqliteDriver();
    if (!driver) {
      this.degradedReason = 'sqlite_driver_unavailable';
      logDegradedOnce('warn', 'sqlite_driver_unavailable', 'SQLite driver unavailable (node:sqlite/better-sqlite3 missing)');
      return { ok: false, reason: this.degradedReason };
    }

    try {
      this.db = driver.create(this.dbPath);
      this.driverName = driver.name;
      this._applyPragmas();
      this._migrate();
      this.available = true;
      this.degradedReason = null;
      return { ok: true, driver: this.driverName, dbPath: this.dbPath };
    } catch (err) {
      this.available = false;
      this.db = null;
      this.degradedReason = `open_failed:${err.message}`;
      logDegradedOnce('error', 'open_failed', `Failed to initialize store: ${err.message}`);
      return { ok: false, reason: this.degradedReason };
    }
  }

  _applyPragmas() {
    if (!this.db) return;
    this.db.exec('PRAGMA journal_mode=WAL;');
    this.db.exec('PRAGMA synchronous=NORMAL;');
    this.db.exec('PRAGMA temp_store=MEMORY;');
    this.db.exec('PRAGMA foreign_keys=ON;');
    this.db.exec('PRAGMA busy_timeout=5000;');
  }

  _migrate() {
    if (!this.db) return;
    this.db.exec(SCHEMA_V1_SQL);
    this.db.exec(SCHEMA_V2_SQL);
    this.db.exec(SCHEMA_V3_SQL);
  }

  isAvailable() {
    return this.available && Boolean(this.db);
  }

  getStatus() {
    return {
      available: this.isAvailable(),
      driver: this.driverName,
      dbPath: this.dbPath,
      maxRows: this.maxRows,
      retentionMs: this.retentionMs,
      configEnabled: this.configEnabled,
      degradedReason: this.degradedReason,
    };
  }

  appendEvent(event, options = {}) {
    if (!this.isAvailable()) {
      return { ok: false, status: 'unavailable', reason: this.degradedReason || 'store_unavailable' };
    }

    const prepared = prepareEventForStorage(event, {
      sessionId: options.sessionId || this.sessionId,
      ingestedAtMs: options.ingestedAtMs,
      nowMs: options.nowMs,
    });

    if (!prepared.validation.valid) {
      return {
        ok: false,
        status: 'invalid',
        errors: prepared.validation.errors,
        eventId: prepared.normalized.eventId,
      };
    }

    const inserted = this._insertPrepared(prepared);
    return {
      ok: true,
      status: inserted ? 'inserted' : 'duplicate',
      inserted,
      eventId: prepared.normalized.eventId,
      traceId: prepared.normalized.traceId,
      edgeCount: prepared.edges.length,
    };
  }

  appendBatch(events, options = {}) {
    if (!this.isAvailable()) {
      return { ok: false, status: 'unavailable', reason: this.degradedReason || 'store_unavailable' };
    }

    const list = Array.isArray(events) ? events : [];
    if (list.length === 0) {
      return { ok: true, status: 'no_events', requested: 0, inserted: 0, duplicates: 0, invalid: 0 };
    }

    const preparedList = list.map((event) => prepareEventForStorage(event, {
      sessionId: options.sessionId || this.sessionId,
      ingestedAtMs: options.ingestedAtMs,
      nowMs: options.nowMs,
    }));

    let inserted = 0;
    let duplicates = 0;
    let invalid = 0;

    try {
      this.db.exec('BEGIN IMMEDIATE;');
      for (const prepared of preparedList) {
        if (!prepared.validation.valid) {
          invalid += 1;
          continue;
        }
        if (this._insertPrepared(prepared)) {
          inserted += 1;
        } else {
          duplicates += 1;
        }
      }
      this.db.exec('COMMIT;');
      return {
        ok: true,
        status: 'committed',
        requested: list.length,
        inserted,
        duplicates,
        invalid,
      };
    } catch (err) {
      try { this.db.exec('ROLLBACK;'); } catch {}
      return {
        ok: false,
        status: 'db_error',
        error: err.message,
        requested: list.length,
        inserted,
        duplicates,
        invalid,
      };
    }
  }

  _insertPrepared(prepared) {
    const row = prepared.row;
    const insertEvent = this.db.prepare(`
      INSERT OR IGNORE INTO ledger_events (
        event_id, trace_id, span_id, parent_event_id, correlation_id, causation_id,
        type, stage, source, pane_id, role, ts_ms, seq, direction,
        payload_json, payload_hash, evidence_refs_json, meta_json, ingested_at_ms, session_id
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?
      )
    `);

    const eventResult = insertEvent.run(
      row.event_id,
      row.trace_id,
      row.span_id,
      row.parent_event_id,
      row.correlation_id,
      row.causation_id,
      row.type,
      row.stage,
      row.source,
      row.pane_id,
      row.role,
      row.ts_ms,
      row.seq,
      row.direction,
      row.payload_json,
      row.payload_hash,
      row.evidence_refs_json,
      row.meta_json,
      row.ingested_at_ms,
      row.session_id
    );

    if (Number(eventResult?.changes || 0) === 0) {
      return false;
    }

    if (prepared.edges.length > 0) {
      const insertEdge = this.db.prepare(`
        INSERT OR IGNORE INTO ledger_edges (
          trace_id, from_event_id, to_event_id, edge_type, created_at_ms
        ) VALUES (?, ?, ?, ?, ?)
      `);
      for (const edge of prepared.edges) {
        insertEdge.run(
          edge.trace_id,
          edge.from_event_id,
          edge.to_event_id,
          edge.edge_type,
          edge.created_at_ms
        );
      }
    }

    return true;
  }

  queryTrace(traceId, options = {}) {
    if (!this.isAvailable()) return { traceId, events: [], edges: [] };
    if (typeof traceId !== 'string' || !traceId.trim()) return { traceId, events: [], edges: [] };

    const limit = Math.max(1, Math.min(5000, Number(options.limit) || 1000));
    const includeEdges = options.includeEdges !== false;

    const stmt = this.db.prepare(`
      SELECT * FROM ledger_events
      WHERE trace_id = ?
      ORDER BY ts_ms ASC, row_id ASC
      LIMIT ?
    `);
    const rows = stmt.all(traceId.trim(), limit);
    const events = rows.map((row) => this._mapRowToEvent(row));

    let edges = [];
    if (includeEdges) {
      const edgeStmt = this.db.prepare(`
        SELECT * FROM ledger_edges
        WHERE trace_id = ?
        ORDER BY created_at_ms ASC, edge_id ASC
      `);
      edges = edgeStmt.all(traceId.trim());
    }

    return { traceId: traceId.trim(), events, edges };
  }

  queryEvents(filters = {}) {
    if (!this.isAvailable()) return [];

    const clauses = [];
    const params = [];

    if (filters.traceId) {
      clauses.push('trace_id = ?');
      params.push(String(filters.traceId));
    }
    if (filters.type) {
      clauses.push('type = ?');
      params.push(String(filters.type));
    }
    if (filters.stage) {
      clauses.push('stage = ?');
      params.push(String(filters.stage));
    }
    if (filters.paneId) {
      clauses.push('pane_id = ?');
      params.push(String(filters.paneId));
    }
    if (filters.role) {
      clauses.push('role = ?');
      params.push(String(filters.role));
    }
    if (filters.sinceMs !== undefined) {
      clauses.push('ts_ms >= ?');
      params.push(toMs(filters.sinceMs, 0));
    }
    if (filters.untilMs !== undefined) {
      clauses.push('ts_ms <= ?');
      params.push(toMs(filters.untilMs, Number.MAX_SAFE_INTEGER));
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const order = (String(filters.order || 'asc').toLowerCase() === 'desc')
      ? 'ORDER BY ts_ms DESC, row_id DESC'
      : 'ORDER BY ts_ms ASC, row_id ASC';
    const limit = Math.max(1, Math.min(10_000, Number(filters.limit) || 500));

    const sql = `
      SELECT * FROM ledger_events
      ${where}
      ${order}
      LIMIT ?
    `;

    const rows = this.db.prepare(sql).all(...params, limit);
    return rows.map((row) => this._mapRowToEvent(row));
  }

  prune(options = {}) {
    if (!this.isAvailable()) {
      return { ok: false, status: 'unavailable', reason: this.degradedReason || 'store_unavailable' };
    }

    const now = toMs(options.nowMs, Date.now());
    const retentionMs = Math.max(1_000, Number(options.retentionMs) || this.retentionMs);
    const maxRows = Math.max(1, Number(options.maxRows) || this.maxRows);
    const cutoff = now - retentionMs;

    let removedByAge = 0;
    let removedByCap = 0;
    let removedEdges = 0;

    try {
      this.db.exec('BEGIN IMMEDIATE;');

      const ageDelete = this.db.prepare('DELETE FROM ledger_events WHERE ts_ms < ?');
      const ageResult = ageDelete.run(cutoff);
      removedByAge = Number(ageResult?.changes || 0);

      const countRow = this.db.prepare('SELECT COUNT(*) AS count FROM ledger_events').get();
      const total = Number(countRow?.count || 0);
      if (total > maxRows) {
        const toDrop = total - maxRows;
        const capDelete = this.db.prepare(`
          DELETE FROM ledger_events
          WHERE row_id IN (
            SELECT row_id FROM ledger_events
            ORDER BY row_id ASC
            LIMIT ?
          )
        `);
        const capResult = capDelete.run(toDrop);
        removedByCap = Number(capResult?.changes || 0);
      }

      const edgeCleanup = this.db.prepare(`
        DELETE FROM ledger_edges
        WHERE from_event_id NOT IN (SELECT event_id FROM ledger_events)
           OR to_event_id NOT IN (SELECT event_id FROM ledger_events)
      `);
      const edgeResult = edgeCleanup.run();
      removedEdges = Number(edgeResult?.changes || 0);

      this.db.exec('COMMIT;');
      return {
        ok: true,
        status: 'pruned',
        removedByAge,
        removedByCap,
        removedEdges,
      };
    } catch (err) {
      try { this.db.exec('ROLLBACK;'); } catch {}
      return {
        ok: false,
        status: 'db_error',
        error: err.message,
      };
    }
  }

  close() {
    if (!this.db) return;
    try {
      this.db.close();
    } catch (err) {
      log.warn('EvidenceLedger', `Error closing DB: ${err.message}`);
    }
    this.db = null;
    this.available = false;
  }

  _mapRowToEvent(row) {
    return {
      eventId: row.event_id,
      traceId: row.trace_id,
      spanId: row.span_id,
      parentEventId: row.parent_event_id,
      correlationId: row.correlation_id || row.trace_id,
      causationId: row.causation_id ?? row.parent_event_id ?? null,
      type: row.type,
      stage: row.stage,
      source: row.source,
      paneId: row.pane_id,
      role: row.role,
      ts: row.ts_ms,
      seq: row.seq,
      direction: row.direction,
      payload: parseJson(row.payload_json, {}),
      evidenceRefs: parseJson(row.evidence_refs_json, []),
      meta: parseJson(row.meta_json, {}),
      payloadHash: row.payload_hash,
      ingestedAtMs: row.ingested_at_ms,
      sessionId: row.session_id,
      rowId: row.row_id,
    };
  }
}

module.exports = {
  EvidenceLedgerStore,
  DEFAULT_DB_PATH,
  DEFAULT_MAX_ROWS,
  DEFAULT_RETENTION_MS,
};
