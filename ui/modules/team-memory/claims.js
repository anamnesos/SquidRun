const crypto = require('crypto');

const CLAIM_TYPES = new Set(['fact', 'decision', 'hypothesis', 'negative']);
const CLAIM_STATUS = new Set(['proposed', 'confirmed', 'contested', 'deprecated']);
const EVIDENCE_RELATIONS = new Set(['supports', 'contradicts', 'caused_by']);
const DECISION_OUTCOMES = new Set(['success', 'partial', 'failure', 'unknown']);
const CONSENSUS_POSITIONS = new Set(['support', 'challenge', 'abstain']);
const DEFAULT_ACTIVE_AGENTS = Object.freeze(['architect', 'devops', 'analyst']);

const ROLE_ALIASES = new Map([
  ['arch', 'architect'],
  ['architect', 'architect'],
  ['ana', 'analyst'],
  ['analyst', 'analyst'],
  ['infra', 'devops'],
  ['backend', 'devops'],
  ['devops', 'devops'],
  ['frontend', 'frontend'],
  ['reviewer', 'reviewer'],
  ['system', 'system'],
  ['user', 'user'],
]);

const ALLOWED_TRANSITIONS = new Map([
  ['proposed', new Set(['confirmed', 'contested', 'deprecated'])],
  ['confirmed', new Set(['contested', 'deprecated'])],
  ['contested', new Set(['confirmed', 'deprecated'])],
  ['deprecated', new Set([])],
]);

function toId(prefix) {
  try {
    return `${prefix}_${crypto.randomUUID()}`;
  } catch {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }
}

function asString(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function asNullableString(value) {
  const normalized = asString(value, '');
  return normalized || null;
}

function asNumber(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function asTimestamp(value, fallback = Date.now()) {
  const numeric = asNumber(value, fallback);
  if (!Number.isFinite(numeric) || numeric < 0) return Math.floor(fallback);
  return Math.floor(numeric);
}

function normalizeRole(value, fallback = 'system') {
  const raw = asString(value, '').toLowerCase();
  if (!raw) return fallback;
  return ROLE_ALIASES.get(raw) || raw;
}

function normalizeConsensusPosition(value) {
  const raw = asString(value, '').toLowerCase();
  if (!raw) return null;
  if (raw === 'agree' || raw === 'support') return 'support';
  if (raw === 'disagree' || raw === 'challenge') return 'challenge';
  if (raw === 'abstain') return 'abstain';
  return null;
}

function toPublicConsensusPosition(value) {
  if (value === 'support') return 'agree';
  if (value === 'challenge') return 'disagree';
  return 'abstain';
}

function normalizeActiveAgents(value) {
  if (!Array.isArray(value) || value.length === 0) {
    return [...DEFAULT_ACTIVE_AGENTS];
  }
  const seen = new Set();
  const normalized = [];
  for (const entry of value) {
    const role = normalizeRole(entry, '');
    if (!role || seen.has(role)) continue;
    seen.add(role);
    normalized.push(role);
  }
  return normalized.length > 0 ? normalized : [...DEFAULT_ACTIVE_AGENTS];
}

function normalizeConfidence(value, fallback = 1.0) {
  const numeric = asNumber(value, fallback);
  if (!Number.isFinite(numeric)) return fallback;
  if (numeric < 0) return 0;
  if (numeric > 1) return 1;
  return numeric;
}

function normalizeScopes(value) {
  if (!Array.isArray(value)) return [];
  const scopes = new Set();
  for (const entry of value) {
    const scope = asString(entry, '');
    if (!scope) continue;
    scopes.add(scope);
  }
  return [...scopes];
}

function asPositiveInt(value, fallback = null) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  if (numeric <= 0) return fallback;
  return Math.floor(numeric);
}

function parseFtsQuery(raw) {
  const text = asString(raw, '');
  if (!text) return '';
  const tokens = text
    .split(/\s+/)
    .map((token) => token.replace(/[^A-Za-z0-9_./:\-]/g, '').trim())
    .filter(Boolean)
    .slice(0, 20)
    .map((token) => `${token}*`);
  if (tokens.length > 0) {
    return tokens.join(' ');
  }
  return `"${text.replace(/"/g, '""')}"`;
}

function mapClaimRow(row, scopes = [], evidence = []) {
  if (!row) return null;
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key || null,
    statement: row.statement,
    claimType: row.claim_type,
    owner: row.owner,
    confidence: Number(row.confidence),
    status: row.status,
    supersedes: row.supersedes || null,
    session: row.session || null,
    ttlHours: row.ttl_hours === null || row.ttl_hours === undefined ? null : Number(row.ttl_hours),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    scopes,
    evidence,
  };
}

function mapDecisionRow(row, alternatives = []) {
  if (!row) return null;
  return {
    id: row.id,
    claimId: row.claim_id,
    decidedBy: row.decided_by,
    context: row.context || null,
    rationale: row.rationale || null,
    outcome: row.outcome || null,
    outcomeNotes: row.outcome_notes || null,
    createdAt: Number(row.created_at),
    session: row.session || null,
    alternatives,
  };
}

class TeamMemoryClaims {
  constructor(db) {
    this.db = db;
  }

  isAvailable() {
    return Boolean(this.db && typeof this.db.prepare === 'function');
  }

  getClaim(claimId) {
    if (!this.isAvailable()) return null;
    const id = asString(claimId, '');
    if (!id) return null;

    const row = this.db.prepare('SELECT * FROM claims WHERE id = ?').get(id);
    if (!row) return null;

    const scopes = this.db.prepare(`
      SELECT scope
      FROM claim_scopes
      WHERE claim_id = ?
      ORDER BY scope ASC
    `).all(id).map((entry) => entry.scope);

    const evidence = this.db.prepare(`
      SELECT evidence_ref, added_by, relation, weight, created_at
      FROM claim_evidence
      WHERE claim_id = ?
      ORDER BY created_at ASC
    `).all(id).map((entry) => ({
      evidenceRef: entry.evidence_ref,
      addedBy: entry.added_by,
      relation: entry.relation,
      weight: Number(entry.weight),
      createdAt: Number(entry.created_at),
    }));

    return mapClaimRow(row, scopes, evidence);
  }

  createClaim(input = {}) {
    if (!this.isAvailable()) return { ok: false, reason: 'unavailable' };

    const statement = asString(input.statement, '');
    if (!statement) return { ok: false, reason: 'statement_required' };

    const claimType = asString(input.claimType || input.claim_type, 'fact').toLowerCase();
    if (!CLAIM_TYPES.has(claimType)) {
      return { ok: false, reason: 'invalid_claim_type', claimType };
    }

    const owner = normalizeRole(input.owner || input.createdBy || input.author, 'system');
    const status = asString(input.status, 'proposed').toLowerCase();
    if (!CLAIM_STATUS.has(status)) {
      return { ok: false, reason: 'invalid_status', status };
    }

    const id = asString(input.id, toId('clm'));
    const idempotencyKey = asNullableString(input.idempotencyKey || input.idempotency_key);
    const supersedes = asNullableString(input.supersedes);
    const session = asNullableString(input.session);
    const ttlHours = asNumber(input.ttlHours ?? input.ttl_hours, null);
    const confidence = normalizeConfidence(input.confidence, 1.0);
    const nowMs = asTimestamp(input.nowMs);
    const scopes = normalizeScopes(input.scopes);

    const insertClaim = this.db.prepare(`
      INSERT OR IGNORE INTO claims (
        id, idempotency_key, statement, claim_type, owner, confidence, status,
        supersedes, session, ttl_hours, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertScope = this.db.prepare(`
      INSERT OR IGNORE INTO claim_scopes (claim_id, scope)
      VALUES (?, ?)
    `);

    try {
      this.db.exec('BEGIN IMMEDIATE;');
      const result = insertClaim.run(
        id,
        idempotencyKey,
        statement,
        claimType,
        owner,
        confidence,
        status,
        supersedes,
        session,
        ttlHours,
        nowMs,
        nowMs
      );

      if (Number(result?.changes || 0) === 0) {
        this.db.exec('COMMIT;');
        if (idempotencyKey) {
          const existing = this.db.prepare('SELECT id FROM claims WHERE idempotency_key = ?').get(idempotencyKey);
          if (existing?.id) {
            return {
              ok: true,
              status: 'duplicate',
              claim: this.getClaim(existing.id),
            };
          }
        }
        const existingById = this.getClaim(id);
        if (existingById) {
          return {
            ok: true,
            status: 'duplicate',
            claim: existingById,
          };
        }
        return { ok: false, reason: 'insert_failed' };
      }

      for (const scope of scopes) {
        insertScope.run(id, scope);
      }

      this.db.exec('COMMIT;');
      return {
        ok: true,
        status: 'created',
        claim: this.getClaim(id),
      };
    } catch (err) {
      try { this.db.exec('ROLLBACK;'); } catch {}
      return {
        ok: false,
        reason: 'db_error',
        error: err.message,
      };
    }
  }

  queryClaims(filters = {}) {
    if (!this.isAvailable()) return { ok: false, reason: 'unavailable', claims: [] };

    const clauses = [];
    const params = [];
    const joins = ['LEFT JOIN claim_scopes cs ON cs.claim_id = c.id'];

    const scope = asString(filters.scope, '');
    const scopes = normalizeScopes(Array.isArray(filters.scopes) ? filters.scopes : (scope ? [scope] : []));
    const claimType = asString(filters.claimType || filters.claim_type || filters.type, '').toLowerCase();
    const status = asString(filters.status, '').toLowerCase();
    const owner = asString(filters.owner, '').toLowerCase();
    const session = asString(filters.session, '');
    const since = asNumber(filters.since ?? filters.sinceMs, null);
    const until = asNumber(filters.until ?? filters.untilMs, null);
    const sessionsBack = asPositiveInt(filters.sessionsBack ?? filters.lastSessions, null);
    const text = asString(filters.text ?? filters.query ?? filters.q ?? filters.search, '');
    const ftsQuery = parseFtsQuery(text);
    const hasFts = this.hasFtsSearch();
    const useFts = Boolean(ftsQuery && hasFts);

    if (useFts) {
      joins.push('JOIN claim_search ON claim_search.claim_id = c.id');
      clauses.push('claim_search.statement MATCH ?');
      params.push(ftsQuery);
    } else if (text) {
      clauses.push('c.statement LIKE ?');
      params.push(`%${text}%`);
    }

    if (scopes.length === 1) {
      clauses.push('cs.scope = ?');
      params.push(scopes[0]);
    } else if (scopes.length > 1) {
      clauses.push(`cs.scope IN (${scopes.map(() => '?').join(', ')})`);
      params.push(...scopes);
    }
    if (claimType) {
      clauses.push('c.claim_type = ?');
      params.push(claimType);
    }
    if (status) {
      clauses.push('c.status = ?');
      params.push(status);
    }
    if (owner) {
      clauses.push('LOWER(c.owner) = ?');
      params.push(owner);
    }
    if (session) {
      clauses.push('c.session = ?');
      params.push(session);
    } else if (sessionsBack) {
      const sessions = this.getRecentSessions(sessionsBack);
      if (sessions.length === 0) {
        return { ok: true, claims: [], total: 0 };
      }
      clauses.push(`c.session IN (${sessions.map(() => '?').join(', ')})`);
      params.push(...sessions);
    }
    if (Number.isFinite(since)) {
      clauses.push('c.created_at >= ?');
      params.push(Math.floor(since));
    }
    if (Number.isFinite(until)) {
      clauses.push('c.created_at <= ?');
      params.push(Math.floor(until));
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rankByConfidence = filters.rankByConfidence === true
      || asString(filters.rank, '').toLowerCase() === 'confidence'
      || Boolean(text);
    const order = this.buildOrderClause({
      requestedOrder: asString(filters.order, 'desc').toLowerCase(),
      rankByConfidence,
      useFts,
    });
    const limit = Math.max(1, Math.min(5000, asNumber(filters.limit, 100)));

    const sql = `
      SELECT DISTINCT c.*
      FROM claims c
      ${joins.join('\n      ')}
      ${where}
      ${order}
      LIMIT ?
    `;

    const rows = this.db.prepare(sql).all(...params, limit);
    const claims = rows.map((row) => this.getClaim(row.id)).filter(Boolean);
    return {
      ok: true,
      claims,
      total: claims.length,
    };
  }

  searchClaims(filters = {}) {
    return this.queryClaims({
      ...filters,
      rankByConfidence: filters.rankByConfidence !== false,
    });
  }

  hasFtsSearch() {
    if (!this.isAvailable()) return false;
    try {
      const row = this.db.prepare(`
        SELECT sql
        FROM sqlite_master
        WHERE type = 'table' AND name = 'claim_search'
      `).get();
      const sql = String(row?.sql || '').toLowerCase();
      return sql.includes('virtual table') && sql.includes('fts5');
    } catch {
      return false;
    }
  }

  getRecentSessions(limit = 3) {
    const amount = Math.max(1, Math.min(50, asPositiveInt(limit, 3)));
    const rows = this.db.prepare(`
      SELECT session
      FROM claims
      WHERE session IS NOT NULL AND TRIM(session) <> ''
      GROUP BY session
      ORDER BY MAX(created_at) DESC
      LIMIT ?
    `).all(amount);
    return rows
      .map((row) => asString(row?.session, ''))
      .filter(Boolean);
  }

  buildOrderClause({ requestedOrder = 'desc', rankByConfidence = false, useFts = false } = {}) {
    const ascending = requestedOrder === 'asc';
    const timeOrder = ascending
      ? 'c.created_at ASC, c.id ASC'
      : 'c.created_at DESC, c.id DESC';

    if (useFts) {
      if (rankByConfidence) {
        return `ORDER BY c.confidence DESC, bm25(claim_search), ${timeOrder}`;
      }
      return `ORDER BY bm25(claim_search), ${timeOrder}`;
    }

    if (rankByConfidence) {
      return `ORDER BY c.confidence DESC, ${timeOrder}`;
    }

    return `ORDER BY ${timeOrder}`;
  }

  getConsensus(claimId) {
    if (!this.isAvailable()) return { ok: false, reason: 'unavailable' };
    const id = asString(claimId, '');
    if (!id) return { ok: false, reason: 'claim_id_required' };

    const claim = this.getClaim(id);
    if (!claim) {
      return { ok: false, reason: 'claim_not_found', claimId: id };
    }

    const rows = this.db.prepare(`
      SELECT claim_id, agent, position, reason, created_at
      FROM consensus
      WHERE claim_id = ?
      ORDER BY agent ASC
    `).all(id);

    const consensus = rows.map((row) => ({
      claimId: row.claim_id,
      agent: row.agent,
      position: toPublicConsensusPosition(row.position),
      rawPosition: row.position,
      reason: row.reason || null,
      createdAt: Number(row.created_at),
    }));

    const summary = {
      agree: consensus.filter((entry) => entry.rawPosition === 'support').length,
      disagree: consensus.filter((entry) => entry.rawPosition === 'challenge').length,
      abstain: consensus.filter((entry) => entry.rawPosition === 'abstain').length,
      total: consensus.length,
    };

    return {
      ok: true,
      claimId: id,
      claimStatus: claim.status,
      consensus,
      summary,
    };
  }

  getConsensusRows(claimId) {
    return this.db.prepare(`
      SELECT claim_id, agent, position, reason, created_at
      FROM consensus
      WHERE claim_id = ?
      ORDER BY agent ASC
    `).all(claimId);
  }

  autoUpdateClaimStatusFromConsensus(claimId, options = {}) {
    const claim = this.getClaim(claimId);
    if (!claim) {
      return { ok: false, reason: 'claim_not_found', claimId };
    }
    if (claim.status === 'deprecated') {
      return { ok: true, status: 'no_change', claim };
    }

    const rows = this.getConsensusRows(claimId);
    if (rows.length === 0) {
      return { ok: true, status: 'no_consensus', claim };
    }

    const hasChallenge = rows.some((entry) => entry.position === 'challenge');
    const changedBy = normalizeRole(options.changedBy || options.changed_by || 'system', 'system');
    const changedAt = asTimestamp(options.nowMs);

    if (hasChallenge) {
      if (claim.status === 'contested') {
        return { ok: true, status: 'no_change', claim };
      }
      return this.updateClaimStatus(
        claimId,
        'contested',
        changedBy,
        'consensus_disagreement_detected',
        changedAt
      );
    }

    const activeAgents = normalizeActiveAgents(options.activeAgents);
    const supportingAgents = new Set(
      rows
        .filter((entry) => entry.position === 'support')
        .map((entry) => normalizeRole(entry.agent, ''))
        .filter(Boolean)
    );
    const allActiveAgree = activeAgents.every((agent) => supportingAgents.has(agent));

    if (allActiveAgree && activeAgents.length > 0) {
      if (claim.status === 'confirmed') {
        return { ok: true, status: 'no_change', claim };
      }
      return this.updateClaimStatus(
        claimId,
        'confirmed',
        changedBy,
        'consensus_all_active_agents_agree',
        changedAt
      );
    }

    return {
      ok: true,
      status: 'insufficient_consensus',
      claim,
      requiredAgents: activeAgents,
      supportingAgents: [...supportingAgents],
    };
  }

  recordConsensus(input = {}) {
    if (!this.isAvailable()) return { ok: false, reason: 'unavailable' };

    const claimId = asString(input.claimId || input.claim_id || input.id, '');
    if (!claimId) return { ok: false, reason: 'claim_id_required' };
    const claim = this.getClaim(claimId);
    if (!claim) return { ok: false, reason: 'claim_not_found', claimId };

    const agent = normalizeRole(input.agent || input.owner || input.changedBy || input.changed_by, '');
    if (!agent) return { ok: false, reason: 'agent_required' };

    const position = normalizeConsensusPosition(input.position);
    if (!position || !CONSENSUS_POSITIONS.has(position)) {
      return { ok: false, reason: 'invalid_position', position: input.position || null };
    }

    const reason = asNullableString(input.reason);
    const nowMs = asTimestamp(input.nowMs);

    const upsertConsensus = this.db.prepare(`
      INSERT INTO consensus (id, claim_id, agent, position, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(claim_id, agent)
      DO UPDATE SET
        position = excluded.position,
        reason = excluded.reason,
        created_at = excluded.created_at
    `);

    try {
      this.db.exec('BEGIN IMMEDIATE;');
      upsertConsensus.run(
        toId('con'),
        claimId,
        agent,
        position,
        reason,
        nowMs
      );
      this.db.exec('COMMIT;');
    } catch (err) {
      try { this.db.exec('ROLLBACK;'); } catch {}
      return {
        ok: false,
        reason: 'db_error',
        error: err.message,
      };
    }

    const statusUpdate = this.autoUpdateClaimStatusFromConsensus(claimId, {
      changedBy: agent,
      nowMs,
      activeAgents: input.activeAgents,
    });

    return {
      ok: true,
      status: 'recorded',
      claim: this.getClaim(claimId),
      consensus: this.getConsensus(claimId).consensus,
      statusUpdate,
    };
  }

  getBeliefRowsForAgent(agent, options = {}) {
    const normalizedAgent = normalizeRole(agent, '');
    if (!normalizedAgent) return [];
    const limit = Math.max(1, Math.min(5000, asNumber(options.maxBeliefs, 500)));

    return this.db.prepare(`
      SELECT DISTINCT c.id AS claim_id, c.confidence
      FROM claims c
      LEFT JOIN consensus cn ON cn.claim_id = c.id AND LOWER(cn.agent) = ?
      WHERE c.status <> 'deprecated'
        AND (LOWER(c.owner) = ? OR cn.position = 'support')
      ORDER BY c.confidence DESC, c.updated_at DESC, c.id ASC
      LIMIT ?
    `).all(normalizedAgent, normalizedAgent, limit);
  }

  getClaimDetailsForIds(claimIds = []) {
    if (!Array.isArray(claimIds) || claimIds.length === 0) return new Map();
    const uniqueIds = [...new Set(claimIds.map((id) => asString(id, '')).filter(Boolean))];
    if (uniqueIds.length === 0) return new Map();

    const placeholders = uniqueIds.map(() => '?').join(', ');
    const rows = this.db.prepare(`
      SELECT c.id, c.claim_type, c.statement, c.supersedes, cs.scope
      FROM claims c
      LEFT JOIN claim_scopes cs ON cs.claim_id = c.id
      WHERE c.id IN (${placeholders})
      ORDER BY c.id ASC
    `).all(...uniqueIds);

    const map = new Map();
    for (const row of rows) {
      const existing = map.get(row.id) || {
        id: row.id,
        claimType: row.claim_type,
        statement: row.statement || '',
        supersedes: row.supersedes || null,
        scopes: new Set(),
      };
      if (row.scope) existing.scopes.add(row.scope);
      map.set(row.id, existing);
    }
    return map;
  }

  findBeliefContradictions(beliefs = [], claimDetails = new Map()) {
    const contradictions = [];
    for (let i = 0; i < beliefs.length; i += 1) {
      for (let j = i + 1; j < beliefs.length; j += 1) {
        const left = claimDetails.get(beliefs[i].claimId);
        const right = claimDetails.get(beliefs[j].claimId);
        if (!left || !right) continue;
        const reason = this.getContradictionReason(left, right);
        if (!reason) continue;
        const [claimA, claimB] = left.id < right.id
          ? [left.id, right.id]
          : [right.id, left.id];
        contradictions.push({ claimA, claimB, reason });
      }
    }

    const dedup = new Map();
    for (const entry of contradictions) {
      const key = `${entry.claimA}::${entry.claimB}::${entry.reason}`;
      if (!dedup.has(key)) dedup.set(key, entry);
    }
    return [...dedup.values()];
  }

  getContradictionReason(left, right) {
    const leftScopes = left.scopes || new Set();
    const rightScopes = right.scopes || new Set();
    const scopeOverlap = [...leftScopes].some((scope) => rightScopes.has(scope));
    if (!scopeOverlap) return null;

    const leftNegative = left.claimType === 'negative';
    const rightNegative = right.claimType === 'negative';
    if (leftNegative !== rightNegative) {
      return 'negative_vs_non_negative_same_scope';
    }

    if (left.supersedes && left.supersedes === right.id) {
      return 'supersedes_conflict_same_scope';
    }
    if (right.supersedes && right.supersedes === left.id) {
      return 'supersedes_conflict_same_scope';
    }

    return null;
  }

  createBeliefSnapshot(input = {}) {
    if (!this.isAvailable()) return { ok: false, reason: 'unavailable' };

    const agent = normalizeRole(input.agent || input.owner, '');
    if (!agent) return { ok: false, reason: 'agent_required' };

    const nowMs = asTimestamp(input.nowMs);
    const session = asNullableString(input.session) || 'unknown';
    const beliefRows = this.getBeliefRowsForAgent(agent, input);
    const beliefs = beliefRows.map((row) => ({
      claimId: row.claim_id,
      confidence: normalizeConfidence(row.confidence, 1.0),
    }));
    const snapshotId = asString(input.snapshotId, toId('bls'));
    const contradictions = this.findBeliefContradictions(
      beliefs,
      this.getClaimDetailsForIds(beliefs.map((entry) => entry.claimId))
    );

    const insertSnapshot = this.db.prepare(`
      INSERT INTO belief_snapshots (id, agent, session, snapshot_at, beliefs)
      VALUES (?, ?, ?, ?, ?)
    `);
    const insertContradiction = this.db.prepare(`
      INSERT INTO belief_contradictions (
        id, snapshot_id, claim_a, claim_b, agent, session, detected_at, reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    try {
      this.db.exec('BEGIN IMMEDIATE;');
      insertSnapshot.run(
        snapshotId,
        agent,
        session,
        nowMs,
        JSON.stringify(beliefs)
      );
      for (const contradiction of contradictions) {
        insertContradiction.run(
          toId('bc'),
          snapshotId,
          contradiction.claimA,
          contradiction.claimB,
          agent,
          session,
          nowMs,
          contradiction.reason
        );
      }
      this.db.exec('COMMIT;');
    } catch (err) {
      try { this.db.exec('ROLLBACK;'); } catch {}
      return {
        ok: false,
        reason: 'db_error',
        error: err.message,
      };
    }

    return {
      ok: true,
      status: 'created',
      snapshot: {
        id: snapshotId,
        agent,
        session,
        snapshotAt: nowMs,
        beliefs,
      },
      contradictions: {
        count: contradictions.length,
        items: contradictions,
      },
    };
  }

  getAgentBeliefs(input = {}) {
    if (!this.isAvailable()) return { ok: false, reason: 'unavailable' };

    const agent = normalizeRole(input.agent || input.owner, '');
    if (!agent) return { ok: false, reason: 'agent_required' };

    const session = asNullableString(input.session);
    const limit = Math.max(1, Math.min(200, asNumber(input.limit, 20)));
    const latestOnly = input.latest !== false;

    const clauses = ['agent = ?'];
    const params = [agent];
    if (session) {
      clauses.push('session = ?');
      params.push(session);
    }

    const sql = `
      SELECT id, agent, session, snapshot_at, beliefs
      FROM belief_snapshots
      WHERE ${clauses.join(' AND ')}
      ORDER BY snapshot_at DESC
      LIMIT ?
    `;
    const rows = this.db.prepare(sql).all(...params, latestOnly ? 1 : limit);
    const snapshots = rows.map((row) => ({
      id: row.id,
      agent: row.agent,
      session: row.session,
      snapshotAt: Number(row.snapshot_at),
      beliefs: (() => {
        try {
          const parsed = JSON.parse(row.beliefs || '[]');
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      })(),
    }));

    return {
      ok: true,
      snapshots,
      total: snapshots.length,
      latest: snapshots[0] || null,
    };
  }

  getContradictions(filters = {}) {
    if (!this.isAvailable()) return { ok: false, reason: 'unavailable' };

    const clauses = ['1 = 1'];
    const params = [];
    const agent = asString(filters.agent, '');
    const session = asString(filters.session, '');
    const claimId = asString(filters.claimId || filters.claim_id, '');
    const since = asNumber(filters.since ?? filters.sinceMs, null);
    const until = asNumber(filters.until ?? filters.untilMs, null);
    const limit = Math.max(1, Math.min(1000, asNumber(filters.limit, 100)));

    if (agent) {
      clauses.push('bc.agent = ?');
      params.push(normalizeRole(agent, agent));
    }
    if (session) {
      clauses.push('bc.session = ?');
      params.push(session);
    }
    if (claimId) {
      clauses.push('(bc.claim_a = ? OR bc.claim_b = ?)');
      params.push(claimId, claimId);
    }
    if (Number.isFinite(since)) {
      clauses.push('bc.detected_at >= ?');
      params.push(Math.floor(since));
    }
    if (Number.isFinite(until)) {
      clauses.push('bc.detected_at <= ?');
      params.push(Math.floor(until));
    }

    const rows = this.db.prepare(`
      SELECT bc.id, bc.snapshot_id, bc.claim_a, bc.claim_b, bc.agent, bc.session, bc.detected_at, bc.reason
      FROM belief_contradictions bc
      WHERE ${clauses.join(' AND ')}
      ORDER BY bc.detected_at DESC, bc.id DESC
      LIMIT ?
    `).all(...params, limit);

    return {
      ok: true,
      contradictions: rows.map((row) => ({
        id: row.id,
        snapshotId: row.snapshot_id,
        claimA: row.claim_a,
        claimB: row.claim_b,
        agent: row.agent,
        session: row.session,
        detectedAt: Number(row.detected_at),
        reason: row.reason || null,
      })),
      total: rows.length,
    };
  }

  updateClaimStatus(claimId, newStatus, changedBy, reason = null, nowMs = Date.now()) {
    if (!this.isAvailable()) return { ok: false, reason: 'unavailable' };

    const id = asString(claimId, '');
    if (!id) return { ok: false, reason: 'claim_id_required' };
    const targetStatus = asString(newStatus, '').toLowerCase();
    if (!CLAIM_STATUS.has(targetStatus)) {
      return { ok: false, reason: 'invalid_status', status: targetStatus };
    }

    const claim = this.getClaim(id);
    if (!claim) return { ok: false, reason: 'claim_not_found', claimId: id };

    if (claim.status === targetStatus) {
      return { ok: true, status: 'no_change', claim };
    }

    const allowed = ALLOWED_TRANSITIONS.get(claim.status) || new Set();
    if (!allowed.has(targetStatus)) {
      return {
        ok: false,
        reason: 'invalid_transition',
        from: claim.status,
        to: targetStatus,
      };
    }

    const changedByRole = normalizeRole(changedBy, 'system');
    const changedAt = asTimestamp(nowMs);

    const updateStmt = this.db.prepare(`
      UPDATE claims
      SET status = ?, updated_at = ?
      WHERE id = ?
    `);
    const insertHistory = this.db.prepare(`
      INSERT INTO claim_status_history (
        id, claim_id, old_status, new_status, changed_by, reason, changed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    try {
      this.db.exec('BEGIN IMMEDIATE;');
      updateStmt.run(targetStatus, changedAt, id);
      insertHistory.run(
        toId('csh'),
        id,
        claim.status,
        targetStatus,
        changedByRole,
        asNullableString(reason),
        changedAt
      );
      this.db.exec('COMMIT;');
      return {
        ok: true,
        status: 'updated',
        claim: this.getClaim(id),
      };
    } catch (err) {
      try { this.db.exec('ROLLBACK;'); } catch {}
      return {
        ok: false,
        reason: 'db_error',
        error: err.message,
      };
    }
  }

  deprecateClaim(claimId, changedBy, reason = 'deprecated_by_user', nowMs = Date.now()) {
    return this.updateClaimStatus(claimId, 'deprecated', changedBy, reason, nowMs);
  }

  addEvidence(claimId, evidenceRef, relation = 'supports', options = {}) {
    if (!this.isAvailable()) return { ok: false, reason: 'unavailable' };

    const id = asString(claimId, '');
    if (!id) return { ok: false, reason: 'claim_id_required' };

    const claim = this.getClaim(id);
    if (!claim) return { ok: false, reason: 'claim_not_found', claimId: id };

    const ref = asString(evidenceRef, '');
    if (!ref) return { ok: false, reason: 'evidence_ref_required' };

    const normalizedRelation = asString(relation, 'supports').toLowerCase();
    if (!EVIDENCE_RELATIONS.has(normalizedRelation)) {
      return { ok: false, reason: 'invalid_relation', relation: normalizedRelation };
    }

    const addedBy = normalizeRole(options.addedBy || options.added_by || options.changedBy, claim.owner);
    const weight = asNumber(options.weight, 1.0);
    const createdAt = asTimestamp(options.nowMs);

    const result = this.db.prepare(`
      INSERT OR IGNORE INTO claim_evidence (
        claim_id, evidence_ref, added_by, relation, weight, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, ref, addedBy, normalizedRelation, weight, createdAt);

    return {
      ok: true,
      status: Number(result?.changes || 0) > 0 ? 'added' : 'duplicate',
      claim: this.getClaim(id),
    };
  }

  getDecision(decisionId) {
    if (!this.isAvailable()) return null;
    const id = asString(decisionId, '');
    if (!id) return null;

    const row = this.db.prepare('SELECT * FROM decisions WHERE id = ?').get(id);
    if (!row) return null;
    const alternatives = this.db.prepare(`
      SELECT alternative_id, rejection_reason
      FROM decision_alternatives
      WHERE decision_id = ?
      ORDER BY alternative_id ASC
    `).all(id).map((entry) => ({
      claimId: entry.alternative_id,
      rejectionReason: entry.rejection_reason || null,
    }));

    return mapDecisionRow(row, alternatives);
  }

  createDecision(input = {}) {
    if (!this.isAvailable()) return { ok: false, reason: 'unavailable' };

    const claimId = asString(input.claimId || input.claim_id, '');
    if (!claimId) return { ok: false, reason: 'claim_id_required' };
    if (!this.getClaim(claimId)) return { ok: false, reason: 'claim_not_found', claimId };

    const decisionId = asString(input.id, toId('dec'));
    const decidedBy = normalizeRole(input.decidedBy || input.decided_by || input.owner, 'system');
    const context = asNullableString(input.context);
    const rationale = asNullableString(input.rationale);
    const outcome = asNullableString(input.outcome);
    if (outcome && !DECISION_OUTCOMES.has(outcome)) {
      return { ok: false, reason: 'invalid_outcome', outcome };
    }
    const outcomeNotes = asNullableString(input.outcomeNotes || input.outcome_notes);
    const session = asNullableString(input.session);
    const createdAt = asTimestamp(input.nowMs);

    const alternatives = Array.isArray(input.alternatives) ? input.alternatives : [];
    const parsedAlternatives = alternatives
      .map((entry) => {
        if (typeof entry === 'string') {
          const claimIdValue = asString(entry, '');
          if (!claimIdValue) return null;
          return { claimId: claimIdValue, rejectionReason: null };
        }
        if (!entry || typeof entry !== 'object') return null;
        const claimIdValue = asString(entry.claimId || entry.claim_id, '');
        if (!claimIdValue) return null;
        return {
          claimId: claimIdValue,
          rejectionReason: asNullableString(entry.rejectionReason || entry.rejection_reason),
        };
      })
      .filter(Boolean);

    const insertDecision = this.db.prepare(`
      INSERT INTO decisions (
        id, claim_id, decided_by, context, rationale, outcome, outcome_notes, created_at, session
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertAlternative = this.db.prepare(`
      INSERT OR REPLACE INTO decision_alternatives (
        decision_id, alternative_id, rejection_reason
      ) VALUES (?, ?, ?)
    `);

    try {
      this.db.exec('BEGIN IMMEDIATE;');
      insertDecision.run(
        decisionId,
        claimId,
        decidedBy,
        context,
        rationale,
        outcome,
        outcomeNotes,
        createdAt,
        session
      );
      for (const alternative of parsedAlternatives) {
        insertAlternative.run(decisionId, alternative.claimId, alternative.rejectionReason);
      }
      this.db.exec('COMMIT;');
      return {
        ok: true,
        status: 'created',
        decision: this.getDecision(decisionId),
      };
    } catch (err) {
      try { this.db.exec('ROLLBACK;'); } catch {}
      return {
        ok: false,
        reason: 'db_error',
        error: err.message,
      };
    }
  }

  recordOutcome(decisionId, outcome, notes = null, options = {}) {
    if (!this.isAvailable()) return { ok: false, reason: 'unavailable' };
    const id = asString(decisionId, '');
    if (!id) return { ok: false, reason: 'decision_id_required' };
    const normalizedOutcome = asString(outcome, '').toLowerCase();
    if (!DECISION_OUTCOMES.has(normalizedOutcome)) {
      return { ok: false, reason: 'invalid_outcome', outcome: normalizedOutcome };
    }

    const existing = this.getDecision(id);
    if (!existing) return { ok: false, reason: 'decision_not_found', decisionId: id };

    const outcomeNotes = asNullableString(notes);
    this.db.prepare(`
      UPDATE decisions
      SET outcome = ?, outcome_notes = ?
      WHERE id = ?
    `).run(normalizedOutcome, outcomeNotes, id);

    return {
      ok: true,
      status: 'updated',
      decision: this.getDecision(id),
    };
  }
}

module.exports = {
  TeamMemoryClaims,
  CLAIM_TYPES,
  CLAIM_STATUS,
  CONSENSUS_POSITIONS,
  EVIDENCE_RELATIONS,
  DECISION_OUTCOMES,
  ALLOWED_TRANSITIONS,
  normalizeRole,
};
