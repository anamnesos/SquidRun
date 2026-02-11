/**
 * Evidence Ledger Investigator
 * Incident/assertion/verdict CRUD layer on top of EvidenceLedgerStore.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { generateId } = require('./evidence-ledger-ingest');

const INCIDENT_STATUSES = new Set(['open', 'investigating', 'resolved', 'closed', 'stale']);
const INCIDENT_SEVERITIES = new Set(['critical', 'high', 'medium', 'low', 'info']);
const ASSERTION_TYPES = new Set(['hypothesis', 'observation', 'conclusion', 'counterevidence']);
const ASSERTION_STATUSES = new Set(['active', 'superseded', 'retracted', 'confirmed']);
const BINDING_KINDS = new Set(['event_ref', 'file_line_ref', 'log_slice_ref', 'query_ref']);
const BINDING_RELATIONS = new Set(['supports', 'contradicts', 'context']);

function asNonEmptyString(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function asFiniteNumber(value, fallback = null) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return numeric;
}

function asMs(value, fallback = Date.now()) {
  const numeric = asFiniteNumber(value, fallback);
  if (!Number.isFinite(numeric) || numeric < 0) return fallback;
  return Math.floor(numeric);
}

function clampConfidence(value, fallback = 0.5) {
  const numeric = asFiniteNumber(value, fallback);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(1, numeric));
}

function parseJson(value, fallback) {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeHash(value) {
  const raw = asNonEmptyString(value, '').toLowerCase();
  if (!raw) return '';
  return raw.startsWith('sha256:') ? raw : `sha256:${raw}`;
}

class EvidenceLedgerInvestigator {
  constructor(store) {
    this.store = store || null;
  }

  _unavailable() {
    return { ok: false, reason: 'unavailable' };
  }

  _isAvailable() {
    return Boolean(this.store && typeof this.store.isAvailable === 'function' && this.store.isAvailable());
  }

  _db() {
    if (!this._isAvailable()) return null;
    return this.store.db || null;
  }

  _withTransaction(action) {
    const db = this._db();
    if (!db) return this._unavailable();
    try {
      db.exec('BEGIN IMMEDIATE;');
      const result = action(db);
      db.exec('COMMIT;');
      return result;
    } catch (err) {
      try { db.exec('ROLLBACK;'); } catch {}
      return { ok: false, reason: 'db_error', error: err.message };
    }
  }

  _mapIncident(row) {
    if (!row) return null;
    return {
      incidentId: row.incident_id,
      title: row.title,
      description: row.description,
      status: row.status,
      severity: row.severity,
      createdBy: row.created_by,
      createdAtMs: row.created_at_ms,
      updatedAtMs: row.updated_at_ms,
      closedAtMs: row.closed_at_ms,
      sessionId: row.session_id,
      tags: parseJson(row.tags_json, []),
      meta: parseJson(row.meta_json, {}),
    };
  }

  _mapAssertion(row) {
    if (!row) return null;
    return {
      assertionId: row.assertion_id,
      incidentId: row.incident_id,
      claim: row.claim,
      type: row.type,
      confidence: Number(row.confidence),
      status: row.status,
      author: row.author,
      createdAtMs: row.created_at_ms,
      updatedAtMs: row.updated_at_ms,
      supersededBy: row.superseded_by,
      version: Number(row.version),
      reasoning: row.reasoning,
      meta: parseJson(row.meta_json, {}),
    };
  }

  _mapBinding(row) {
    if (!row) return null;
    return {
      bindingId: row.binding_id,
      assertionId: row.assertion_id,
      incidentId: row.incident_id,
      kind: row.kind,
      relation: row.relation,
      eventId: row.event_id,
      traceId: row.trace_id,
      spanId: row.span_id,
      filePath: row.file_path,
      fileLine: row.file_line,
      fileColumn: row.file_column,
      snapshotHash: row.snapshot_hash,
      logStartMs: row.log_start_ms,
      logEndMs: row.log_end_ms,
      logSource: row.log_source,
      logFilter: parseJson(row.log_filter_json, null),
      query: parseJson(row.query_json, null),
      queryResultHash: row.query_result_hash,
      note: row.note,
      createdAtMs: row.created_at_ms,
      createdBy: row.created_by,
      stale: Number(row.stale) === 1,
      meta: parseJson(row.meta_json, {}),
    };
  }

  _mapVerdict(row) {
    if (!row) return null;
    return {
      verdictId: row.verdict_id,
      incidentId: row.incident_id,
      value: row.value,
      confidence: Number(row.confidence),
      version: Number(row.version),
      reason: row.reason,
      keyAssertionIds: parseJson(row.key_assertion_ids_json, []),
      author: row.author,
      createdAtMs: row.created_at_ms,
      meta: parseJson(row.meta_json, {}),
    };
  }

  createIncident(opts = {}) {
    const db = this._db();
    if (!db) return this._unavailable();

    const title = asNonEmptyString(opts.title);
    if (!title) return { ok: false, reason: 'title_required' };

    const now = asMs(opts.nowMs, Date.now());
    const incidentId = asNonEmptyString(opts.incidentId, generateId('inc'));
    const status = asNonEmptyString(opts.status, 'open');
    const severity = asNonEmptyString(opts.severity, 'medium');
    const createdBy = asNonEmptyString(opts.createdBy, 'system');
    const tags = asArray(opts.tags);
    const meta = asObject(opts.meta);

    if (!INCIDENT_STATUSES.has(status)) return { ok: false, reason: 'invalid_status' };
    if (!INCIDENT_SEVERITIES.has(severity)) return { ok: false, reason: 'invalid_severity' };

    try {
      const stmt = db.prepare(`
        INSERT INTO ledger_incidents (
          incident_id, title, description, status, severity, created_by,
          created_at_ms, updated_at_ms, closed_at_ms, session_id, tags_json, meta_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        incidentId,
        title,
        asNonEmptyString(opts.description, '') || null,
        status,
        severity,
        createdBy,
        now,
        now,
        null,
        asNonEmptyString(opts.sessionId, this.store?.sessionId || '') || null,
        JSON.stringify(tags),
        JSON.stringify(meta)
      );
      return { ok: true, incidentId };
    } catch (err) {
      if (String(err.message || '').toLowerCase().includes('unique')) {
        return { ok: false, reason: 'conflict', error: err.message };
      }
      return { ok: false, reason: 'db_error', error: err.message };
    }
  }

  getIncident(incidentId) {
    const db = this._db();
    if (!db) return this._unavailable();
    const id = asNonEmptyString(incidentId);
    if (!id) return null;
    const row = db.prepare('SELECT * FROM ledger_incidents WHERE incident_id = ? LIMIT 1').get(id);
    return this._mapIncident(row);
  }

  updateIncident(incidentId, updates = {}) {
    const db = this._db();
    if (!db) return this._unavailable();
    const id = asNonEmptyString(incidentId);
    if (!id) return { ok: false, reason: 'incident_id_required' };

    const setClauses = [];
    const params = [];

    if (updates.title !== undefined) {
      const title = asNonEmptyString(updates.title);
      if (!title) return { ok: false, reason: 'invalid_title' };
      setClauses.push('title = ?');
      params.push(title);
    }
    if (updates.description !== undefined) {
      setClauses.push('description = ?');
      params.push(asNonEmptyString(updates.description, '') || null);
    }
    if (updates.status !== undefined) {
      const status = asNonEmptyString(updates.status);
      if (!INCIDENT_STATUSES.has(status)) return { ok: false, reason: 'invalid_status' };
      setClauses.push('status = ?');
      params.push(status);
      if (status === 'closed' || status === 'resolved') {
        setClauses.push('closed_at_ms = ?');
        params.push(asMs(updates.closedAtMs, Date.now()));
      }
    }
    if (updates.severity !== undefined) {
      const severity = asNonEmptyString(updates.severity);
      if (!INCIDENT_SEVERITIES.has(severity)) return { ok: false, reason: 'invalid_severity' };
      setClauses.push('severity = ?');
      params.push(severity);
    }
    if (updates.tags !== undefined) {
      setClauses.push('tags_json = ?');
      params.push(JSON.stringify(asArray(updates.tags)));
    }
    if (updates.meta !== undefined) {
      setClauses.push('meta_json = ?');
      params.push(JSON.stringify(asObject(updates.meta)));
    }
    if (updates.closedAtMs !== undefined && updates.status === undefined) {
      setClauses.push('closed_at_ms = ?');
      params.push(asMs(updates.closedAtMs, Date.now()));
    }

    if (setClauses.length === 0) return { ok: false, reason: 'no_updates' };

    setClauses.push('updated_at_ms = ?');
    params.push(asMs(updates.nowMs, Date.now()));
    params.push(id);

    try {
      const stmt = db.prepare(`
        UPDATE ledger_incidents
        SET ${setClauses.join(', ')}
        WHERE incident_id = ?
      `);
      const result = stmt.run(...params);
      if (Number(result?.changes || 0) === 0) {
        return { ok: false, reason: 'not_found' };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: 'db_error', error: err.message };
    }
  }

  listIncidents(filters = {}) {
    const db = this._db();
    if (!db) return this._unavailable();

    const clauses = [];
    const params = [];

    if (filters.status) {
      clauses.push('status = ?');
      params.push(String(filters.status));
    }
    if (filters.severity) {
      clauses.push('severity = ?');
      params.push(String(filters.severity));
    }
    if (filters.sessionId) {
      clauses.push('session_id = ?');
      params.push(String(filters.sessionId));
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const order = String(filters.order || 'desc').toLowerCase() === 'asc'
      ? 'ORDER BY updated_at_ms ASC'
      : 'ORDER BY updated_at_ms DESC';
    const limit = Math.max(1, Math.min(500, Number(filters.limit) || 100));

    const rows = db.prepare(`
      SELECT * FROM ledger_incidents
      ${where}
      ${order}
      LIMIT ?
    `).all(...params, limit);

    return rows.map((row) => this._mapIncident(row));
  }

  linkTrace(incidentId, traceId, opts = {}) {
    const db = this._db();
    if (!db) return this._unavailable();
    const incident = asNonEmptyString(incidentId);
    const trace = asNonEmptyString(traceId);
    if (!incident) return { ok: false, reason: 'incident_id_required' };
    if (!trace) return { ok: false, reason: 'trace_id_required' };

    const existingIncident = db.prepare('SELECT incident_id FROM ledger_incidents WHERE incident_id = ? LIMIT 1').get(incident);
    if (!existingIncident) return { ok: false, reason: 'incident_not_found' };

    try {
      const stmt = db.prepare(`
        INSERT OR IGNORE INTO ledger_incident_traces (
          incident_id, trace_id, linked_at_ms, linked_by, note
        ) VALUES (?, ?, ?, ?, ?)
      `);
      const result = stmt.run(
        incident,
        trace,
        asMs(opts.linkedAtMs, Date.now()),
        asNonEmptyString(opts.linkedBy, 'system'),
        asNonEmptyString(opts.note, '') || null
      );
      return {
        ok: true,
        status: Number(result?.changes || 0) > 0 ? 'linked' : 'exists',
      };
    } catch (err) {
      return { ok: false, reason: 'db_error', error: err.message };
    }
  }

  closeIncident(incidentId, opts = {}) {
    return this.updateIncident(incidentId, {
      status: asNonEmptyString(opts.status, 'closed'),
      closedAtMs: asMs(opts.closedAtMs, Date.now()),
      nowMs: asMs(opts.nowMs, Date.now()),
    });
  }

  addAssertion(incidentId, opts = {}) {
    const db = this._db();
    if (!db) return this._unavailable();
    const incident = asNonEmptyString(incidentId);
    if (!incident) return { ok: false, reason: 'incident_id_required' };

    const claim = asNonEmptyString(opts.claim);
    const author = asNonEmptyString(opts.author, 'system');
    const type = asNonEmptyString(opts.type, 'hypothesis');
    const status = asNonEmptyString(opts.status, 'active');
    const rawConfidence = Number(opts.confidence === undefined ? 0.5 : opts.confidence);
    const confidence = clampConfidence(rawConfidence, 0.5);
    const reasoning = asNonEmptyString(opts.reasoning, '') || null;
    const evidence = asArray(opts.evidenceBindings || opts.evidence || opts.bindings);

    if (!claim) return { ok: false, reason: 'claim_required' };
    if (!ASSERTION_TYPES.has(type)) return { ok: false, reason: 'invalid_type' };
    if (!ASSERTION_STATUSES.has(status)) return { ok: false, reason: 'invalid_status' };
    if (!Number.isFinite(rawConfidence) || rawConfidence < 0 || rawConfidence > 1) {
      return { ok: false, reason: 'invalid_confidence' };
    }
    if (evidence.length === 0 && opts.allowWithoutEvidence !== true) {
      return { ok: false, reason: 'evidence_required' };
    }

    const existingIncident = db.prepare('SELECT incident_id FROM ledger_incidents WHERE incident_id = ? LIMIT 1').get(incident);
    if (!existingIncident) return { ok: false, reason: 'incident_not_found' };

    const now = asMs(opts.nowMs, Date.now());
    const assertionId = asNonEmptyString(opts.assertionId, generateId('ast'));
    const meta = asObject(opts.meta);
    const version = Math.max(1, Math.floor(asFiniteNumber(opts.version, 1)));

    return this._withTransaction((txDb) => {
      txDb.prepare(`
        INSERT INTO ledger_assertions (
          assertion_id, incident_id, claim, type, confidence, status, author,
          created_at_ms, updated_at_ms, superseded_by, version, reasoning, meta_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        assertionId,
        incident,
        claim,
        type,
        confidence,
        status,
        author,
        now,
        now,
        null,
        version,
        reasoning,
        JSON.stringify(meta)
      );

      let bindingCount = 0;
      for (const binding of evidence) {
        const inserted = this._insertBinding(txDb, assertionId, incident, binding, {
          nowMs: now,
          createdBy: author,
        });
        if (!inserted.ok) {
          throw new Error(inserted.error || inserted.reason || 'binding_insert_failed');
        }
        bindingCount += 1;
      }

      return { ok: true, assertionId, bindingCount };
    });
  }

  getAssertion(assertionId) {
    const db = this._db();
    if (!db) return this._unavailable();
    const id = asNonEmptyString(assertionId);
    if (!id) return null;
    const row = db.prepare('SELECT * FROM ledger_assertions WHERE assertion_id = ? LIMIT 1').get(id);
    return this._mapAssertion(row);
  }

  updateAssertion(assertionId, updates = {}) {
    const db = this._db();
    if (!db) return this._unavailable();
    const id = asNonEmptyString(assertionId);
    if (!id) return { ok: false, reason: 'assertion_id_required' };

    const setClauses = [];
    const params = [];

    if (updates.claim !== undefined) {
      const claim = asNonEmptyString(updates.claim);
      if (!claim) return { ok: false, reason: 'invalid_claim' };
      setClauses.push('claim = ?');
      params.push(claim);
    }
    if (updates.type !== undefined) {
      const type = asNonEmptyString(updates.type);
      if (!ASSERTION_TYPES.has(type)) return { ok: false, reason: 'invalid_type' };
      setClauses.push('type = ?');
      params.push(type);
    }
    if (updates.confidence !== undefined) {
      const confidenceNum = Number(updates.confidence);
      if (!Number.isFinite(confidenceNum) || confidenceNum < 0 || confidenceNum > 1) {
        return { ok: false, reason: 'invalid_confidence' };
      }
      setClauses.push('confidence = ?');
      params.push(confidenceNum);
    }
    if (updates.status !== undefined) {
      const status = asNonEmptyString(updates.status);
      if (!ASSERTION_STATUSES.has(status)) return { ok: false, reason: 'invalid_status' };
      setClauses.push('status = ?');
      params.push(status);
    }
    if (updates.reasoning !== undefined) {
      setClauses.push('reasoning = ?');
      params.push(asNonEmptyString(updates.reasoning, '') || null);
    }
    if (updates.meta !== undefined) {
      setClauses.push('meta_json = ?');
      params.push(JSON.stringify(asObject(updates.meta)));
    }
    if (updates.supersededBy !== undefined) {
      setClauses.push('superseded_by = ?');
      params.push(asNonEmptyString(updates.supersededBy, '') || null);
    }

    if (setClauses.length === 0) return { ok: false, reason: 'no_updates' };

    setClauses.push('updated_at_ms = ?');
    params.push(asMs(updates.nowMs, Date.now()));
    params.push(id);

    try {
      const stmt = db.prepare(`
        UPDATE ledger_assertions
        SET ${setClauses.join(', ')}
        WHERE assertion_id = ?
      `);
      const result = stmt.run(...params);
      if (Number(result?.changes || 0) === 0) {
        return { ok: false, reason: 'not_found' };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: 'db_error', error: err.message };
    }
  }

  supersedeAssertion(assertionId, newOpts = {}) {
    const db = this._db();
    if (!db) return this._unavailable();

    const current = this.getAssertion(assertionId);
    if (!current || current.ok === false) {
      return current && current.ok === false ? current : { ok: false, reason: 'not_found' };
    }

    const newClaim = asNonEmptyString(newOpts.claim);
    if (!newClaim) return { ok: false, reason: 'claim_required' };

    const evidence = asArray(newOpts.evidenceBindings || newOpts.evidence || newOpts.bindings);
    if (evidence.length === 0 && newOpts.allowWithoutEvidence !== true) {
      return { ok: false, reason: 'evidence_required' };
    }

    const now = asMs(newOpts.nowMs, Date.now());
    const newAssertionId = asNonEmptyString(newOpts.assertionId, generateId('ast'));
    const type = asNonEmptyString(newOpts.type, current.type);
    const confidence = newOpts.confidence === undefined
      ? current.confidence
      : Number(newOpts.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      return { ok: false, reason: 'invalid_confidence' };
    }
    if (!ASSERTION_TYPES.has(type)) return { ok: false, reason: 'invalid_type' };

    return this._withTransaction((txDb) => {
      txDb.prepare(`
        INSERT INTO ledger_assertions (
          assertion_id, incident_id, claim, type, confidence, status, author,
          created_at_ms, updated_at_ms, superseded_by, version, reasoning, meta_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        newAssertionId,
        current.incidentId,
        newClaim,
        type,
        confidence,
        asNonEmptyString(newOpts.status, 'active'),
        asNonEmptyString(newOpts.author, current.author),
        now,
        now,
        null,
        Number(current.version || 1) + 1,
        asNonEmptyString(newOpts.reasoning, '') || null,
        JSON.stringify(asObject(newOpts.meta))
      );

      txDb.prepare(`
        UPDATE ledger_assertions
        SET status = ?, superseded_by = ?, updated_at_ms = ?
        WHERE assertion_id = ?
      `).run('superseded', newAssertionId, now, current.assertionId);

      let bindingCount = 0;
      for (const binding of evidence) {
        const inserted = this._insertBinding(txDb, newAssertionId, current.incidentId, binding, {
          nowMs: now,
          createdBy: asNonEmptyString(newOpts.author, current.author),
        });
        if (!inserted.ok) {
          throw new Error(inserted.error || inserted.reason || 'binding_insert_failed');
        }
        bindingCount += 1;
      }

      return { ok: true, newAssertionId, bindingCount };
    });
  }

  listAssertions(incidentId, filters = {}) {
    const db = this._db();
    if (!db) return this._unavailable();
    const incident = asNonEmptyString(incidentId);
    if (!incident) return [];

    const clauses = ['incident_id = ?'];
    const params = [incident];

    if (filters.status) {
      clauses.push('status = ?');
      params.push(String(filters.status));
    }
    if (filters.type) {
      clauses.push('type = ?');
      params.push(String(filters.type));
    }

    const order = String(filters.order || 'desc').toLowerCase() === 'asc'
      ? 'ORDER BY updated_at_ms ASC'
      : 'ORDER BY updated_at_ms DESC';
    const limit = Math.max(1, Math.min(1000, Number(filters.limit) || 200));
    const where = `WHERE ${clauses.join(' AND ')}`;

    const rows = db.prepare(`
      SELECT * FROM ledger_assertions
      ${where}
      ${order}
      LIMIT ?
    `).all(...params, limit);
    return rows.map((row) => this._mapAssertion(row));
  }

  bindEvidence(assertionId, binding = {}) {
    const db = this._db();
    if (!db) return this._unavailable();
    const assertion = asNonEmptyString(assertionId);
    if (!assertion) return { ok: false, reason: 'assertion_id_required' };

    const existingAssertion = db.prepare(`
      SELECT assertion_id, incident_id, author
      FROM ledger_assertions
      WHERE assertion_id = ?
      LIMIT 1
    `).get(assertion);
    if (!existingAssertion) return { ok: false, reason: 'assertion_not_found' };

    return this._insertBinding(db, assertion, existingAssertion.incident_id, binding, {
      nowMs: asMs(binding.nowMs, Date.now()),
      createdBy: asNonEmptyString(binding.createdBy, existingAssertion.author || 'system'),
    });
  }

  listBindings(assertionId) {
    const db = this._db();
    if (!db) return this._unavailable();
    const assertion = asNonEmptyString(assertionId);
    if (!assertion) return [];
    const rows = db.prepare(`
      SELECT * FROM ledger_evidence_bindings
      WHERE assertion_id = ?
      ORDER BY created_at_ms ASC
    `).all(assertion);
    return rows.map((row) => this._mapBinding(row));
  }

  listBindingsForIncident(incidentId) {
    const db = this._db();
    if (!db) return this._unavailable();
    const incident = asNonEmptyString(incidentId);
    if (!incident) return [];
    const rows = db.prepare(`
      SELECT * FROM ledger_evidence_bindings
      WHERE incident_id = ?
      ORDER BY created_at_ms ASC
    `).all(incident);
    return rows.map((row) => this._mapBinding(row));
  }

  markBindingStale(bindingId) {
    const db = this._db();
    if (!db) return this._unavailable();
    const id = asNonEmptyString(bindingId);
    if (!id) return { ok: false, reason: 'binding_id_required' };

    const result = db.prepare(`
      UPDATE ledger_evidence_bindings
      SET stale = 1
      WHERE binding_id = ?
    `).run(id);

    if (Number(result?.changes || 0) === 0) return { ok: false, reason: 'not_found' };
    return { ok: true };
  }

  computeFileSnapshotHash(filePath, opts = {}) {
    const inputPath = asNonEmptyString(filePath);
    if (!inputPath) return { ok: false, reason: 'file_path_required' };

    const baseDir = asNonEmptyString(opts.baseDir, process.cwd());
    const resolvedPath = path.isAbsolute(inputPath)
      ? inputPath
      : path.resolve(baseDir, inputPath);
    const lineNumber = Number.isInteger(Number(opts.fileLine))
      ? Number(opts.fileLine)
      : null;

    let source;
    try {
      source = fs.readFileSync(resolvedPath, 'utf8');
    } catch (err) {
      return {
        ok: false,
        reason: 'read_failed',
        error: err.message,
        filePath: resolvedPath,
      };
    }

    let material = source;
    if (Number.isInteger(lineNumber) && lineNumber > 0) {
      const lines = source.split(/\r?\n/);
      material = lines[lineNumber - 1] ?? '';
    }

    const digest = crypto.createHash('sha256').update(material, 'utf8').digest('hex');
    return {
      ok: true,
      filePath: resolvedPath,
      hash: `sha256:${digest}`,
      mode: Number.isInteger(lineNumber) && lineNumber > 0 ? 'line' : 'file',
      bytes: Buffer.byteLength(material, 'utf8'),
    };
  }

  refreshFileLineBindingStaleness(options = {}) {
    const db = this._db();
    if (!db) return this._unavailable();

    const clauses = [
      "kind = 'file_line_ref'",
      'snapshot_hash IS NOT NULL',
      "TRIM(snapshot_hash) != ''",
    ];
    const params = [];

    if (options.bindingId) {
      clauses.push('binding_id = ?');
      params.push(String(options.bindingId));
    }
    if (options.incidentId) {
      clauses.push('incident_id = ?');
      params.push(String(options.incidentId));
    }
    if (options.assertionId) {
      clauses.push('assertion_id = ?');
      params.push(String(options.assertionId));
    }
    if (options.includeAlreadyStale !== true) {
      clauses.push('stale = 0');
    }

    const limit = Math.max(1, Math.min(10_000, Number(options.limit) || 1000));
    const rows = db.prepare(`
      SELECT binding_id, file_path, file_line, snapshot_hash, stale
      FROM ledger_evidence_bindings
      WHERE ${clauses.join(' AND ')}
      ORDER BY created_at_ms ASC
      LIMIT ?
    `).all(...params, limit);

    const staleIds = [];
    const unchangedIds = [];
    const missingFiles = [];
    const baseDir = asNonEmptyString(options.baseDir, process.cwd());

    for (const row of rows) {
      const hashResult = this.computeFileSnapshotHash(row.file_path, {
        baseDir,
        fileLine: row.file_line,
      });
      if (!hashResult.ok) {
        staleIds.push(row.binding_id);
        missingFiles.push({
          bindingId: row.binding_id,
          filePath: row.file_path,
          reason: hashResult.reason,
          error: hashResult.error || null,
        });
        continue;
      }

      const expected = normalizeHash(row.snapshot_hash);
      const actual = normalizeHash(hashResult.hash);
      if (!expected || expected !== actual) {
        staleIds.push(row.binding_id);
      } else {
        unchangedIds.push(row.binding_id);
      }
    }

    let markedStale = 0;
    if (staleIds.length > 0) {
      const placeholders = staleIds.map(() => '?').join(', ');
      const updateResult = db.prepare(`
        UPDATE ledger_evidence_bindings
        SET stale = 1
        WHERE binding_id IN (${placeholders})
      `).run(...staleIds);
      markedStale = Number(updateResult?.changes || 0);
    }

    return {
      ok: true,
      checked: rows.length,
      markedStale,
      staleBindingIds: staleIds,
      unchangedBindingIds: unchangedIds,
      missingFiles,
    };
  }

  recordVerdict(incidentId, opts = {}) {
    const db = this._db();
    if (!db) return this._unavailable();

    const incident = asNonEmptyString(incidentId);
    if (!incident) return { ok: false, reason: 'incident_id_required' };
    const value = asNonEmptyString(opts.value);
    const author = asNonEmptyString(opts.author, 'system');
    if (!value) return { ok: false, reason: 'value_required' };

    const confidence = Number(opts.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      return { ok: false, reason: 'invalid_confidence' };
    }

    const existingIncident = db.prepare(`
      SELECT incident_id
      FROM ledger_incidents
      WHERE incident_id = ?
      LIMIT 1
    `).get(incident);
    if (!existingIncident) return { ok: false, reason: 'incident_not_found' };

    const now = asMs(opts.nowMs, Date.now());
    const keyAssertionIds = asArray(opts.keyAssertionIds).map((id) => asNonEmptyString(id)).filter(Boolean);
    const verdictId = asNonEmptyString(opts.verdictId, generateId('vrd'));

    return this._withTransaction((txDb) => {
      const maxRow = txDb.prepare(`
        SELECT COALESCE(MAX(version), 0) AS max_version
        FROM ledger_verdicts
        WHERE incident_id = ?
      `).get(incident);
      const version = Number(maxRow?.max_version || 0) + 1;

      txDb.prepare(`
        INSERT INTO ledger_verdicts (
          verdict_id, incident_id, value, confidence, version, reason,
          key_assertion_ids_json, author, created_at_ms, meta_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        verdictId,
        incident,
        value,
        confidence,
        version,
        asNonEmptyString(opts.reason, '') || null,
        JSON.stringify(keyAssertionIds),
        author,
        now,
        JSON.stringify(asObject(opts.meta))
      );

      return { ok: true, verdictId, version };
    });
  }

  getCurrentVerdict(incidentId) {
    const db = this._db();
    if (!db) return this._unavailable();
    const incident = asNonEmptyString(incidentId);
    if (!incident) return null;
    const row = db.prepare(`
      SELECT * FROM ledger_verdicts
      WHERE incident_id = ?
      ORDER BY version DESC
      LIMIT 1
    `).get(incident);
    return this._mapVerdict(row);
  }

  getVerdictHistory(incidentId) {
    const db = this._db();
    if (!db) return this._unavailable();
    const incident = asNonEmptyString(incidentId);
    if (!incident) return [];
    const rows = db.prepare(`
      SELECT * FROM ledger_verdicts
      WHERE incident_id = ?
      ORDER BY version DESC, created_at_ms DESC
    `).all(incident);
    return rows.map((row) => this._mapVerdict(row));
  }

  getIncidentSummary(incidentId) {
    const db = this._db();
    if (!db) return this._unavailable();
    const incident = this.getIncident(incidentId);
    if (!incident || incident.ok === false) return incident;

    const traces = db.prepare(`
      SELECT trace_id, linked_at_ms, linked_by, note
      FROM ledger_incident_traces
      WHERE incident_id = ?
      ORDER BY linked_at_ms ASC
    `).all(incident.incidentId).map((row) => ({
      traceId: row.trace_id,
      linkedAtMs: row.linked_at_ms,
      linkedBy: row.linked_by,
      note: row.note,
    }));

    const assertions = this.listAssertions(incident.incidentId, { order: 'desc', limit: 1000 });
    const currentVerdict = this.getCurrentVerdict(incident.incidentId);
    const evidenceCountRow = db.prepare(`
      SELECT COUNT(*) AS count
      FROM ledger_evidence_bindings
      WHERE incident_id = ?
    `).get(incident.incidentId);

    return {
      incident,
      traces,
      assertions: Array.isArray(assertions) ? assertions : [],
      currentVerdict: currentVerdict && currentVerdict.ok === false ? null : currentVerdict,
      evidenceCount: Number(evidenceCountRow?.count || 0),
    };
  }

  getIncidentTimeline(incidentId) {
    const db = this._db();
    if (!db) return this._unavailable();
    const incident = asNonEmptyString(incidentId);
    if (!incident) return [];

    const timeline = [];

    const traceRows = db.prepare(`
      SELECT trace_id, linked_at_ms, linked_by, note
      FROM ledger_incident_traces
      WHERE incident_id = ?
    `).all(incident);
    for (const row of traceRows) {
      timeline.push({
        ts: row.linked_at_ms,
        kind: 'trace_link',
        traceId: row.trace_id,
        linkedBy: row.linked_by,
        note: row.note,
      });
    }

    const assertionRows = db.prepare(`
      SELECT assertion_id, claim, status, confidence, updated_at_ms
      FROM ledger_assertions
      WHERE incident_id = ?
    `).all(incident);
    for (const row of assertionRows) {
      timeline.push({
        ts: row.updated_at_ms,
        kind: 'assertion',
        assertionId: row.assertion_id,
        claim: row.claim,
        status: row.status,
        confidence: Number(row.confidence),
      });
    }

    const bindingRows = db.prepare(`
      SELECT binding_id, assertion_id, kind, relation, stale, created_at_ms
      FROM ledger_evidence_bindings
      WHERE incident_id = ?
    `).all(incident);
    for (const row of bindingRows) {
      timeline.push({
        ts: row.created_at_ms,
        kind: 'evidence_binding',
        bindingId: row.binding_id,
        assertionId: row.assertion_id,
        evidenceKind: row.kind,
        relation: row.relation,
        stale: Number(row.stale) === 1,
      });
    }

    const verdictRows = db.prepare(`
      SELECT verdict_id, value, confidence, version, created_at_ms
      FROM ledger_verdicts
      WHERE incident_id = ?
    `).all(incident);
    for (const row of verdictRows) {
      timeline.push({
        ts: row.created_at_ms,
        kind: 'verdict',
        verdictId: row.verdict_id,
        value: row.value,
        confidence: Number(row.confidence),
        version: Number(row.version),
      });
    }

    return timeline.sort((a, b) => Number(a.ts) - Number(b.ts));
  }

  _validateBinding(kind, binding) {
    const value = binding || {};
    switch (kind) {
      case 'event_ref': {
        const eventId = asNonEmptyString(value.eventId);
        if (!eventId) return { ok: false, reason: 'event_id_required' };
        return { ok: true };
      }
      case 'file_line_ref': {
        const filePath = asNonEmptyString(value.filePath);
        const fileLine = Number(value.fileLine);
        if (!filePath) return { ok: false, reason: 'file_path_required' };
        if (!Number.isInteger(fileLine) || fileLine <= 0) return { ok: false, reason: 'file_line_required' };
        return { ok: true };
      }
      case 'log_slice_ref': {
        const logSource = asNonEmptyString(value.logSource);
        const start = Number(value.logStartMs);
        const end = Number(value.logEndMs);
        if (!logSource) return { ok: false, reason: 'log_source_required' };
        if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
          return { ok: false, reason: 'invalid_log_window' };
        }
        return { ok: true };
      }
      case 'query_ref': {
        const query = asObject(value.query);
        if (Object.keys(query).length === 0) return { ok: false, reason: 'query_required' };
        return { ok: true };
      }
      default:
        return { ok: false, reason: 'invalid_kind' };
    }
  }

  _insertBinding(db, assertionId, incidentId, binding, opts = {}) {
    const kind = asNonEmptyString(binding.kind);
    const relation = asNonEmptyString(binding.relation, 'supports');
    if (!BINDING_KINDS.has(kind)) return { ok: false, reason: 'invalid_kind' };
    if (!BINDING_RELATIONS.has(relation)) return { ok: false, reason: 'invalid_relation' };

    const valid = this._validateBinding(kind, binding);
    if (!valid.ok) return valid;

    const bindingId = asNonEmptyString(binding.bindingId, generateId('evb'));
    const createdAtMs = asMs(opts.nowMs, Date.now());
    const createdBy = asNonEmptyString(binding.createdBy, opts.createdBy || 'system');

    try {
      db.prepare(`
        INSERT INTO ledger_evidence_bindings (
          binding_id, assertion_id, incident_id, kind, relation,
          event_id, trace_id, span_id,
          file_path, file_line, file_column, snapshot_hash,
          log_start_ms, log_end_ms, log_source, log_filter_json,
          query_json, query_result_hash, note,
          created_at_ms, created_by, stale, meta_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        bindingId,
        assertionId,
        incidentId,
        kind,
        relation,
        asNonEmptyString(binding.eventId, '') || null,
        asNonEmptyString(binding.traceId, '') || null,
        asNonEmptyString(binding.spanId, '') || null,
        asNonEmptyString(binding.filePath, '') || null,
        Number.isInteger(Number(binding.fileLine)) ? Number(binding.fileLine) : null,
        Number.isInteger(Number(binding.fileColumn)) ? Number(binding.fileColumn) : null,
        asNonEmptyString(binding.snapshotHash, '') || null,
        Number.isFinite(Number(binding.logStartMs)) ? Number(binding.logStartMs) : null,
        Number.isFinite(Number(binding.logEndMs)) ? Number(binding.logEndMs) : null,
        asNonEmptyString(binding.logSource, '') || null,
        binding.logFilter ? JSON.stringify(asObject(binding.logFilter)) : null,
        binding.query ? JSON.stringify(asObject(binding.query)) : null,
        asNonEmptyString(binding.queryResultHash, '') || null,
        asNonEmptyString(binding.note, '') || null,
        createdAtMs,
        createdBy,
        binding.stale ? 1 : 0,
        JSON.stringify(asObject(binding.meta))
      );
      return { ok: true, bindingId };
    } catch (err) {
      return { ok: false, reason: 'db_error', error: err.message };
    }
  }
}

module.exports = {
  EvidenceLedgerInvestigator,
};
