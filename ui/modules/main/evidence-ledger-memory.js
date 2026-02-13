/**
 * Evidence Ledger Memory
 * Cross-session decision memory on top of the Evidence Ledger store.
 */

const { generateId } = require('./evidence-ledger-ingest');

const DECISION_CATEGORIES = new Set([
  'architecture',
  'directive',
  'completion',
  'issue',
  'roadmap',
  'config',
]);

const DECISION_STATUSES = new Set([
  'active',
  'superseded',
  'archived',
]);

const DECISION_AUTHORS = new Set([
  'architect',
  'devops',
  'analyst',
  'user',
  'system',
]);

const SNAPSHOT_TRIGGERS = new Set([
  'session_start',
  'session_end',
  'manual',
  'periodic',
]);

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

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function parseJson(value, fallback) {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function clampLimit(value, fallback = 100, min = 1, max = 5000) {
  const numeric = asFiniteNumber(value, fallback);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(numeric)));
}

function toIsoDate(ms) {
  const ts = asFiniteNumber(ms, null);
  if (!Number.isFinite(ts)) return null;
  try {
    return new Date(ts).toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

function escapeLike(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
}

function decisionSummary(decision) {
  const title = asNonEmptyString(decision?.title, '(untitled decision)');
  const body = asNonEmptyString(decision?.body, '');
  return body ? `${title} — ${body}` : title;
}

class EvidenceLedgerMemory {
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

  _withReadTransaction(action) {
    const db = this._db();
    if (!db) return this._unavailable();
    try {
      db.exec('BEGIN;');
      const result = action(db);
      db.exec('COMMIT;');
      return result;
    } catch (err) {
      try { db.exec('ROLLBACK;'); } catch {}
      return { ok: false, reason: 'db_error', error: err.message };
    }
  }

  _mapDecision(row) {
    if (!row) return null;
    return {
      decisionId: row.decision_id,
      sessionId: row.session_id,
      category: row.category,
      title: row.title,
      body: row.body,
      author: row.author,
      status: row.status,
      supersededBy: row.superseded_by,
      incidentId: row.incident_id,
      tags: parseJson(row.tags_json, []),
      meta: parseJson(row.meta_json, {}),
      createdAtMs: row.created_at_ms,
      updatedAtMs: row.updated_at_ms,
    };
  }

  _mapSession(row) {
    if (!row) return null;
    return {
      sessionId: row.session_id,
      sessionNumber: Number(row.session_number),
      mode: row.mode,
      startedAtMs: row.started_at_ms,
      endedAtMs: row.ended_at_ms,
      summary: row.summary,
      stats: parseJson(row.stats_json, {}),
      team: parseJson(row.team_json, {}),
      meta: parseJson(row.meta_json, {}),
    };
  }

  _mapSnapshot(row) {
    if (!row) return null;
    return {
      snapshotId: row.snapshot_id,
      sessionId: row.session_id,
      content: parseJson(row.content_json, {}),
      createdAtMs: row.created_at_ms,
      trigger: row.trigger,
    };
  }

  recordDecision(opts = {}) {
    const db = this._db();
    if (!db) return this._unavailable();

    const title = asNonEmptyString(opts.title);
    const category = asNonEmptyString(opts.category);
    const author = asNonEmptyString(opts.author, 'system');
    const status = asNonEmptyString(opts.status, 'active');
    if (!title) return { ok: false, reason: 'title_required' };
    if (!DECISION_CATEGORIES.has(category)) return { ok: false, reason: 'invalid_category' };
    if (!DECISION_AUTHORS.has(author)) return { ok: false, reason: 'invalid_author' };
    if (!DECISION_STATUSES.has(status)) return { ok: false, reason: 'invalid_status' };

    const now = asMs(opts.nowMs, Date.now());
    const decisionId = asNonEmptyString(opts.decisionId, generateId('dec'));
    const tags = asArray(opts.tags);
    const meta = asObject(opts.meta);

    try {
      db.prepare(`
        INSERT INTO ledger_decisions (
          decision_id, session_id, category, title, body, author, status, superseded_by,
          incident_id, tags_json, meta_json, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        decisionId,
        asNonEmptyString(opts.sessionId, '') || null,
        category,
        title,
        asNonEmptyString(opts.body, '') || null,
        author,
        status,
        asNonEmptyString(opts.supersededBy, '') || null,
        asNonEmptyString(opts.incidentId, '') || null,
        JSON.stringify(tags),
        JSON.stringify(meta),
        now,
        now
      );
      return { ok: true, decisionId };
    } catch (err) {
      if (String(err.message || '').toLowerCase().includes('unique')) {
        return { ok: false, reason: 'conflict', error: err.message };
      }
      return { ok: false, reason: 'db_error', error: err.message };
    }
  }

  getDecision(decisionId) {
    const db = this._db();
    if (!db) return this._unavailable();
    const id = asNonEmptyString(decisionId);
    if (!id) return null;
    const row = db.prepare(`
      SELECT * FROM ledger_decisions
      WHERE decision_id = ?
      LIMIT 1
    `).get(id);
    return this._mapDecision(row);
  }

  updateDecision(decisionId, updates = {}) {
    const db = this._db();
    if (!db) return this._unavailable();
    const id = asNonEmptyString(decisionId);
    if (!id) return { ok: false, reason: 'decision_id_required' };

    const setClauses = [];
    const params = [];

    if (updates.category !== undefined) {
      const category = asNonEmptyString(updates.category);
      if (!DECISION_CATEGORIES.has(category)) return { ok: false, reason: 'invalid_category' };
      setClauses.push('category = ?');
      params.push(category);
    }
    if (updates.title !== undefined) {
      const title = asNonEmptyString(updates.title);
      if (!title) return { ok: false, reason: 'invalid_title' };
      setClauses.push('title = ?');
      params.push(title);
    }
    if (updates.body !== undefined) {
      setClauses.push('body = ?');
      params.push(asNonEmptyString(updates.body, '') || null);
    }
    if (updates.author !== undefined) {
      const author = asNonEmptyString(updates.author);
      if (!DECISION_AUTHORS.has(author)) return { ok: false, reason: 'invalid_author' };
      setClauses.push('author = ?');
      params.push(author);
    }
    if (updates.status !== undefined) {
      const status = asNonEmptyString(updates.status);
      if (!DECISION_STATUSES.has(status)) return { ok: false, reason: 'invalid_status' };
      setClauses.push('status = ?');
      params.push(status);
    }
    if (updates.supersededBy !== undefined) {
      const supersededBy = asNonEmptyString(updates.supersededBy, '') || null;
      if (supersededBy && supersededBy === id) return { ok: false, reason: 'invalid_superseded_by' };
      setClauses.push('superseded_by = ?');
      params.push(supersededBy);
    }
    if (updates.sessionId !== undefined) {
      setClauses.push('session_id = ?');
      params.push(asNonEmptyString(updates.sessionId, '') || null);
    }
    if (updates.incidentId !== undefined) {
      setClauses.push('incident_id = ?');
      params.push(asNonEmptyString(updates.incidentId, '') || null);
    }
    if (updates.tags !== undefined) {
      setClauses.push('tags_json = ?');
      params.push(JSON.stringify(asArray(updates.tags)));
    }
    if (updates.meta !== undefined) {
      setClauses.push('meta_json = ?');
      params.push(JSON.stringify(asObject(updates.meta)));
    }

    if (setClauses.length === 0) return { ok: false, reason: 'no_updates' };

    setClauses.push('updated_at_ms = ?');
    params.push(asMs(updates.nowMs, Date.now()));
    params.push(id);

    try {
      const result = db.prepare(`
        UPDATE ledger_decisions
        SET ${setClauses.join(', ')}
        WHERE decision_id = ?
      `).run(...params);
      if (Number(result?.changes || 0) === 0) return { ok: false, reason: 'not_found' };
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: 'db_error', error: err.message };
    }
  }

  supersedeDecision(decisionId, newOpts = {}) {
    const current = this.getDecision(decisionId);
    if (!current || current.ok === false) {
      return current && current.ok === false ? current : { ok: false, reason: 'not_found' };
    }

    const newTitle = asNonEmptyString(newOpts.title, current.title);
    if (!newTitle) return { ok: false, reason: 'title_required' };

    const newCategory = asNonEmptyString(newOpts.category, current.category);
    const newAuthor = asNonEmptyString(newOpts.author, current.author);
    const newStatus = asNonEmptyString(newOpts.status, 'active');
    if (!DECISION_CATEGORIES.has(newCategory)) return { ok: false, reason: 'invalid_category' };
    if (!DECISION_AUTHORS.has(newAuthor)) return { ok: false, reason: 'invalid_author' };
    if (!DECISION_STATUSES.has(newStatus)) return { ok: false, reason: 'invalid_status' };

    const now = asMs(newOpts.nowMs, Date.now());
    const newDecisionId = asNonEmptyString(newOpts.decisionId, generateId('dec'));

    return this._withTransaction((db) => {
      db.prepare(`
        INSERT INTO ledger_decisions (
          decision_id, session_id, category, title, body, author, status, superseded_by,
          incident_id, tags_json, meta_json, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        newDecisionId,
        asNonEmptyString(newOpts.sessionId, current.sessionId || '') || null,
        newCategory,
        newTitle,
        asNonEmptyString(newOpts.body, current.body || '') || null,
        newAuthor,
        newStatus,
        null,
        asNonEmptyString(newOpts.incidentId, current.incidentId || '') || null,
        JSON.stringify(newOpts.tags !== undefined ? asArray(newOpts.tags) : asArray(current.tags)),
        JSON.stringify(newOpts.meta !== undefined ? asObject(newOpts.meta) : asObject(current.meta)),
        now,
        now
      );

      db.prepare(`
        UPDATE ledger_decisions
        SET status = ?, superseded_by = ?, updated_at_ms = ?
        WHERE decision_id = ?
      `).run('superseded', newDecisionId, now, current.decisionId);

      return { ok: true, newDecisionId };
    });
  }

  listDecisions(filters = {}) {
    const db = this._db();
    if (!db) return this._unavailable();

    const clauses = [];
    const params = [];

    if (filters.category !== undefined) {
      clauses.push('category = ?');
      params.push(String(filters.category));
    }
    if (filters.status !== undefined) {
      clauses.push('status = ?');
      params.push(String(filters.status));
    }
    if (filters.author !== undefined) {
      clauses.push('author = ?');
      params.push(String(filters.author));
    }
    if (filters.sessionId !== undefined) {
      clauses.push('session_id = ?');
      params.push(String(filters.sessionId));
    }
    if (filters.incidentId !== undefined) {
      clauses.push('incident_id = ?');
      params.push(String(filters.incidentId));
    }
    if (filters.sinceMs !== undefined) {
      clauses.push('created_at_ms >= ?');
      params.push(asMs(filters.sinceMs, 0));
    }
    if (filters.untilMs !== undefined) {
      clauses.push('created_at_ms <= ?');
      params.push(asMs(filters.untilMs, Number.MAX_SAFE_INTEGER));
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const order = String(filters.order || 'desc').toLowerCase() === 'asc'
      ? 'ORDER BY created_at_ms ASC'
      : 'ORDER BY created_at_ms DESC';
    const limit = clampLimit(filters.limit, 250, 1, 10_000);

    const rows = db.prepare(`
      SELECT * FROM ledger_decisions
      ${where}
      ${order}
      LIMIT ?
    `).all(...params, limit);
    return rows.map((row) => this._mapDecision(row));
  }

  recordSessionStart(opts = {}) {
    const db = this._db();
    if (!db) return this._unavailable();

    const sessionNumber = asFiniteNumber(opts.sessionNumber, null);
    if (!Number.isInteger(sessionNumber) || sessionNumber <= 0) {
      return { ok: false, reason: 'session_number_required' };
    }

    const now = asMs(opts.startedAtMs, Date.now());
    const sessionId = asNonEmptyString(opts.sessionId, generateId('ses'));
    const mode = asNonEmptyString(opts.mode, 'PTY');

    try {
      db.prepare(`
        INSERT INTO ledger_sessions (
          session_id, session_number, mode, started_at_ms, ended_at_ms,
          summary, stats_json, team_json, meta_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        sessionId,
        sessionNumber,
        mode,
        now,
        null,
        asNonEmptyString(opts.summary, '') || null,
        JSON.stringify(asObject(opts.stats)),
        JSON.stringify(asObject(opts.team)),
        JSON.stringify(asObject(opts.meta))
      );
      return { ok: true, sessionId };
    } catch (err) {
      if (String(err.message || '').toLowerCase().includes('unique')) {
        return { ok: false, reason: 'conflict', error: err.message };
      }
      return { ok: false, reason: 'db_error', error: err.message };
    }
  }

  recordSessionEnd(sessionId, opts = {}) {
    const db = this._db();
    if (!db) return this._unavailable();
    const id = asNonEmptyString(sessionId);
    if (!id) return { ok: false, reason: 'session_id_required' };

    const setClauses = [];
    const params = [];

    setClauses.push('ended_at_ms = ?');
    params.push(asMs(opts.endedAtMs, Date.now()));

    if (opts.summary !== undefined) {
      setClauses.push('summary = ?');
      params.push(asNonEmptyString(opts.summary, '') || null);
    }
    if (opts.stats !== undefined) {
      setClauses.push('stats_json = ?');
      params.push(JSON.stringify(asObject(opts.stats)));
    }
    if (opts.team !== undefined) {
      setClauses.push('team_json = ?');
      params.push(JSON.stringify(asObject(opts.team)));
    }
    if (opts.meta !== undefined) {
      setClauses.push('meta_json = ?');
      params.push(JSON.stringify(asObject(opts.meta)));
    }

    params.push(id);
    try {
      const result = db.prepare(`
        UPDATE ledger_sessions
        SET ${setClauses.join(', ')}
        WHERE session_id = ?
      `).run(...params);
      if (Number(result?.changes || 0) === 0) return { ok: false, reason: 'not_found' };
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: 'db_error', error: err.message };
    }
  }

  getSession(sessionId) {
    const db = this._db();
    if (!db) return this._unavailable();
    const id = asNonEmptyString(sessionId);
    if (!id) return null;
    const row = db.prepare(`
      SELECT * FROM ledger_sessions
      WHERE session_id = ?
      LIMIT 1
    `).get(id);
    return this._mapSession(row);
  }

  listSessions(filters = {}) {
    const db = this._db();
    if (!db) return this._unavailable();

    const clauses = [];
    const params = [];
    if (filters.mode !== undefined) {
      clauses.push('mode = ?');
      params.push(String(filters.mode));
    }
    if (filters.sinceMs !== undefined) {
      clauses.push('started_at_ms >= ?');
      params.push(asMs(filters.sinceMs, 0));
    }
    if (filters.untilMs !== undefined) {
      clauses.push('started_at_ms <= ?');
      params.push(asMs(filters.untilMs, Number.MAX_SAFE_INTEGER));
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const order = String(filters.order || 'desc').toLowerCase() === 'asc'
      ? 'ORDER BY session_number ASC'
      : 'ORDER BY session_number DESC';
    const limit = clampLimit(filters.limit, 100, 1, 5000);

    const rows = db.prepare(`
      SELECT * FROM ledger_sessions
      ${where}
      ${order}
      LIMIT ?
    `).all(...params, limit);

    return rows.map((row) => this._mapSession(row));
  }

  getLatestSnapshot(opts = {}) {
    const db = this._db();
    if (!db) return this._unavailable();
    const sessionId = asNonEmptyString(opts.sessionId, '');
    let row;
    if (sessionId) {
      row = db.prepare(`
        SELECT * FROM ledger_context_snapshots
        WHERE session_id = ?
        ORDER BY created_at_ms DESC
        LIMIT 1
      `).get(sessionId);
    } else {
      row = db.prepare(`
        SELECT * FROM ledger_context_snapshots
        ORDER BY created_at_ms DESC
        LIMIT 1
      `).get();
    }
    return this._mapSnapshot(row);
  }

  _assembleSnapshotContent(sessionId, trigger, opts = {}) {
    const session = this.getSession(sessionId);
    if (session && session.ok === false) return session;

    const baseContext = this.getLatestContext({
      preferSnapshot: trigger === 'session_start',
      directiveLimit: opts.directiveLimit,
      issueLimit: opts.issueLimit,
      roadmapLimit: opts.roadmapLimit,
      completionLimit: opts.completionLimit,
      architectureLimit: opts.architectureLimit,
    });
    if (baseContext && baseContext.ok === false) return baseContext;
    if (!baseContext || typeof baseContext !== 'object') {
      return { ok: false, reason: 'context_unavailable' };
    }

    const assembled = {
      ...baseContext,
      source: trigger === 'session_start'
        ? 'ledger.session_start_snapshot'
        : asNonEmptyString(baseContext.source, 'ledger'),
    };

    if (session && typeof session === 'object') {
      assembled.session = session.sessionNumber;
      assembled.date = toIsoDate(session.startedAtMs);
      assembled.mode = asNonEmptyString(session.mode, asNonEmptyString(assembled.mode, 'PTY'));
      assembled.status = session.endedAtMs ? 'READY' : 'ACTIVE';

      if (Object.keys(session.stats || {}).length > 0 || !assembled.stats) {
        assembled.stats = asObject(session.stats);
      }
      if (Object.keys(session.team || {}).length > 0 || !assembled.team) {
        assembled.team = asObject(session.team);
      }
    }

    return assembled;
  }

  snapshotContext(sessionId, opts = {}) {
    const db = this._db();
    if (!db) return this._unavailable();
    const id = asNonEmptyString(sessionId);
    if (!id) return { ok: false, reason: 'session_id_required' };

    const trigger = asNonEmptyString(opts.trigger, 'manual');
    if (!SNAPSHOT_TRIGGERS.has(trigger)) return { ok: false, reason: 'invalid_trigger' };

    const content = opts.content && typeof opts.content === 'object'
      ? opts.content
      : this._assembleSnapshotContent(id, trigger, opts);
    if (!content || content.ok === false) {
      return content && content.ok === false ? content : { ok: false, reason: 'context_unavailable' };
    }

    const snapshotId = asNonEmptyString(opts.snapshotId, generateId('snp'));
    const now = asMs(opts.nowMs, Date.now());

    try {
      db.prepare(`
        INSERT INTO ledger_context_snapshots (
          snapshot_id, session_id, content_json, created_at_ms, trigger
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        snapshotId,
        id,
        JSON.stringify(content),
        now,
        trigger
      );
      return { ok: true, snapshotId };
    } catch (err) {
      if (String(err.message || '').toLowerCase().includes('unique')) {
        return { ok: false, reason: 'conflict', error: err.message };
      }
      return { ok: false, reason: 'db_error', error: err.message };
    }
  }

  getActiveDirectives(limit = 200) {
    return this.listDecisions({
      category: 'directive',
      status: 'active',
      order: 'desc',
      limit,
    });
  }

  getKnownIssues(status = undefined, limit = 500) {
    const filters = {
      category: 'issue',
      order: 'desc',
      limit,
    };
    if (status !== undefined && status !== null && status !== '') {
      filters.status = status;
    }
    return this.listDecisions(filters);
  }

  getRoadmap(limit = 500) {
    return this.listDecisions({
      category: 'roadmap',
      status: 'active',
      order: 'desc',
      limit,
    });
  }

  getRecentCompletions(limit = 50) {
    const db = this._db();
    if (!db) return this._unavailable();
    const rows = db.prepare(`
      SELECT * FROM ledger_decisions
      WHERE category = 'completion'
        AND status != 'superseded'
      ORDER BY created_at_ms DESC
      LIMIT ?
    `).all(clampLimit(limit, 50, 1, 1000));
    return rows.map((row) => this._mapDecision(row));
  }

  getArchitectureDecisions(limit = 300) {
    return this.listDecisions({
      category: 'architecture',
      status: 'active',
      order: 'desc',
      limit,
    });
  }

  searchDecisions(query, filters = {}) {
    const db = this._db();
    if (!db) return this._unavailable();
    const rawQuery = asNonEmptyString(query);
    if (!rawQuery) return [];

    const clauses = ['(title LIKE ? ESCAPE \'\\\' OR body LIKE ? ESCAPE \'\\\')'];
    const escaped = `%${escapeLike(rawQuery)}%`;
    const params = [escaped, escaped];

    if (filters.category) {
      clauses.push('category = ?');
      params.push(String(filters.category));
    }
    if (filters.status) {
      clauses.push('status = ?');
      params.push(String(filters.status));
    }
    if (filters.author) {
      clauses.push('author = ?');
      params.push(String(filters.author));
    }

    const limit = clampLimit(filters.limit, 100, 1, 1000);
    const rows = db.prepare(`
      SELECT * FROM ledger_decisions
      WHERE ${clauses.join(' AND ')}
      ORDER BY updated_at_ms DESC
      LIMIT ?
    `).all(...params, limit);
    return rows.map((row) => this._mapDecision(row));
  }

  getLatestContext(opts = {}) {
    return this._withReadTransaction(() => {
      const requestedSessionId = asNonEmptyString(opts.sessionId, '');
      const preferSnapshot = opts.preferSnapshot === true;
      const snapshot = this.getLatestSnapshot({ sessionId: requestedSessionId });
      if (snapshot && snapshot.ok === false) return snapshot;
      if (preferSnapshot && snapshot?.content && typeof snapshot.content === 'object') {
        return {
          ...snapshot.content,
          source: 'ledger.snapshot',
        };
      }

      let session = null;
      if (requestedSessionId) {
        const requestedSession = this.getSession(requestedSessionId);
        if (requestedSession && requestedSession.ok === false) return requestedSession;
        session = requestedSession || null;
      } else {
        const latestSession = this.listSessions({ limit: 1, order: 'desc' });
        if (latestSession && latestSession.ok === false) return latestSession;
        session = latestSession[0] || null;
      }
      const directives = this.getActiveDirectives(clampLimit(opts.directiveLimit, 200, 1, 2000));
      const issues = this.getKnownIssues(undefined, clampLimit(opts.issueLimit, 500, 1, 5000));
      const roadmap = this.getRoadmap(clampLimit(opts.roadmapLimit, 500, 1, 5000));
      const completions = this.getRecentCompletions(clampLimit(opts.completionLimit, 100, 1, 5000));
      const architectureDecisions = this.getArchitectureDecisions(clampLimit(opts.architectureLimit, 300, 1, 5000));

      if (directives?.ok === false) return directives;
      if (issues?.ok === false) return issues;
      if (roadmap?.ok === false) return roadmap;
      if (completions?.ok === false) return completions;
      if (architectureDecisions?.ok === false) return architectureDecisions;

      const knownIssues = {};
      for (const issue of issues) {
        const key = asNonEmptyString(issue.title, issue.decisionId || 'issue');
        const value = asNonEmptyString(issue.body, issue.status);
        knownIssues[key] = value;
      }

      const architecture = {
        decisions: architectureDecisions.map((item) => ({
          decisionId: item.decisionId,
          title: item.title,
          body: item.body,
          updatedAtMs: item.updatedAtMs,
        })),
      };

      const context = {
        session: session ? session.sessionNumber : null,
        date: session ? toIsoDate(session.startedAtMs) : null,
        mode: session?.mode || 'PTY',
        status: session?.endedAtMs ? 'READY' : 'ACTIVE',
        source: 'ledger',
        completed: completions.map((item) => decisionSummary(item)),
        architecture,
        not_yet_done: roadmap.map((item) => decisionSummary(item)),
        roadmap: roadmap.map((item) => decisionSummary(item)),
        known_issues: knownIssues,
        stats: session?.stats || {},
        important_notes: directives.map((item) => decisionSummary(item)),
        team: session?.team || {},
      };

      if (!session && snapshot?.content && typeof snapshot.content === 'object') {
        return {
          ...snapshot.content,
          source: 'ledger.snapshot',
        };
      }

      return context;
    });
  }
}

module.exports = {
  EvidenceLedgerMemory,
  DECISION_CATEGORIES,
  DECISION_STATUSES,
  DECISION_AUTHORS,
  SNAPSHOT_TRIGGERS,
};
