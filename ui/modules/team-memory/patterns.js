const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { resolveCoordPath } = require('../../config');
const { normalizeRole } = require('./claims');

function resolveDefaultPatternSpoolPath() {
  if (typeof resolveCoordPath !== 'function') {
    throw new Error('resolveCoordPath unavailable; cannot resolve runtime/team-memory-pattern-spool.jsonl');
  }
  return resolveCoordPath(path.join('runtime', 'team-memory-pattern-spool.jsonl'), { forWrite: true });
}

const DEFAULT_PATTERN_SPOOL_PATH = resolveDefaultPatternSpoolPath();
const INTERNAL_PATTERN_TYPES = new Set(['handoff_loop', 'stall', 'escalation_spiral']);
const EXTERNAL_PATTERN_TYPES = new Set(['coordination', 'failure', 'success']);

const EXTERNAL_TO_INTERNAL = Object.freeze({
  coordination: 'handoff_loop',
  failure: 'stall',
  success: 'escalation_spiral',
});

const INTERNAL_TO_EXTERNAL = Object.freeze({
  handoff_loop: 'coordination',
  stall: 'failure',
  escalation_spiral: 'success',
});

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
  const text = asString(value, '');
  return text || null;
}

function asNumber(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp01(value, fallback = 0.5) {
  const numeric = asNumber(value, fallback);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(1, numeric));
}

function asTimestamp(value, fallback = Date.now()) {
  const numeric = asNumber(value, fallback);
  if (!Number.isFinite(numeric) || numeric < 0) return Math.floor(fallback);
  return Math.floor(numeric);
}

function normalizePatternType(type) {
  const raw = asString(type, '').toLowerCase();
  if (!raw) return null;
  if (EXTERNAL_PATTERN_TYPES.has(raw)) return EXTERNAL_TO_INTERNAL[raw];
  if (INTERNAL_PATTERN_TYPES.has(raw)) return raw;
  return null;
}

function toExternalPatternType(internalType) {
  const normalized = asString(internalType, '').toLowerCase();
  return INTERNAL_TO_EXTERNAL[normalized] || normalized || null;
}

function normalizeAgents(value) {
  const source = Array.isArray(value) ? value : [];
  const seen = new Set();
  const agents = [];
  for (const entry of source) {
    const normalized = normalizeRole(entry, '');
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    agents.push(normalized);
  }
  return agents.sort();
}

function normalizeEventActor(entry = {}) {
  return normalizeRole(entry.agent || entry.owner || entry.actor || entry.by, '');
}

function normalizeEventOutcome(entry = {}) {
  const rawOutcome = asString(entry.outcome, '').toLowerCase();
  if (rawOutcome === 'failure' || rawOutcome === 'error') return 'failure';
  if (rawOutcome === 'success') return 'success';

  const rawStatus = asString(entry.status, '').toLowerCase();
  if (
    rawStatus === 'failed'
    || rawStatus === 'failure'
    || rawStatus === 'error'
    || rawStatus === 'contested'
    || rawStatus === 'pending_proof'
  ) {
    return 'failure';
  }
  if (
    rawStatus === 'completed'
    || rawStatus === 'complete'
    || rawStatus === 'success'
    || rawStatus === 'confirmed'
  ) {
    return 'success';
  }

  return '';
}

function normalizePatternEvent(entry = {}) {
  const actor = normalizeEventActor(entry);
  const claimType = asString(entry.claimType || entry.claim_type, '').toLowerCase();
  const outcome = normalizeEventOutcome(entry);
  const status = asString(entry.status, '').toLowerCase();
  const session = asString(entry.session || entry.session_id || entry.sessionId, '');

  return {
    ...entry,
    agent: actor || null,
    owner: actor || null,
    claimType: claimType || null,
    claim_type: claimType || null,
    outcome: outcome || null,
    status: status || null,
    session: session || null,
  };
}

function toSessionOrdinal(session) {
  const text = asString(session, '');
  if (!text) return null;
  const match = text.match(/(\d+)(?!.*\d)/);
  if (!match) return null;
  const numeric = Number(match[1]);
  return Number.isFinite(numeric) ? numeric : null;
}

class TeamMemoryPatterns {
  constructor(db, options = {}) {
    this.db = db;
    this.defaultSpoolPath = options.spoolPath || DEFAULT_PATTERN_SPOOL_PATH;
  }

  isAvailable() {
    return Boolean(this.db && typeof this.db.prepare === 'function');
  }

  mapPatternRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      patternType: toExternalPatternType(row.pattern_type),
      internalType: row.pattern_type,
      agents: (() => {
        try {
          const parsed = JSON.parse(row.agents || '[]');
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      })(),
      scope: row.scope || null,
      frequency: Number(row.frequency || 0),
      confidence: clamp01(row.confidence, clamp01(row.risk_score, 0.5)),
      riskScore: clamp01(row.risk_score, 0.0),
      active: Number(row.active || 0) === 1,
      firstSeen: Number(row.first_seen || 0),
      lastSeen: Number(row.last_seen || 0),
      resolution: row.resolution || null,
    };
  }

  upsertPattern(input = {}) {
    if (!this.isAvailable()) return { ok: false, reason: 'unavailable' };

    const internalType = normalizePatternType(input.patternType || input.pattern_type || input.type);
    if (!internalType) {
      return { ok: false, reason: 'invalid_pattern_type', patternType: input.patternType || input.pattern_type || input.type || null };
    }

    const scope = asNullableString(input.scope);
    const agents = normalizeAgents(input.agents);
    const agentsKey = JSON.stringify(agents);
    const nowMs = asTimestamp(input.nowMs);
    const frequencyDelta = Math.max(1, Math.floor(asNumber(input.frequencyDelta, asNumber(input.frequency, 1)) || 1));
    const confidence = clamp01(input.confidence, clamp01(input.riskScore, 0.5));
    const riskScore = clamp01(input.riskScore, internalType === 'stall' ? confidence : Math.min(confidence, 0.5));
    const active = input.active === false ? 0 : 1;
    const resolution = asNullableString(input.resolution);

    const existing = this.db.prepare(`
      SELECT id, frequency, confidence, first_seen
      FROM patterns
      WHERE pattern_type = ? AND IFNULL(scope, '') = IFNULL(?, '') AND IFNULL(agents, '[]') = ?
      LIMIT 1
    `).get(internalType, scope, agentsKey);

    if (existing?.id) {
      const currentFrequency = Number(existing.frequency || 0);
      const nextFrequency = currentFrequency + frequencyDelta;
      const existingConfidence = clamp01(existing.confidence, confidence);
      const blendedConfidence = clamp01(
        ((existingConfidence * Math.max(currentFrequency, 1)) + (confidence * frequencyDelta)) / Math.max(nextFrequency, 1),
        confidence
      );
      this.db.prepare(`
        UPDATE patterns
        SET frequency = ?,
            confidence = ?,
            risk_score = ?,
            active = ?,
            last_seen = ?,
            resolution = COALESCE(?, resolution)
        WHERE id = ?
      `).run(
        nextFrequency,
        blendedConfidence,
        clamp01(riskScore, blendedConfidence),
        active,
        nowMs,
        resolution,
        existing.id
      );

      return {
        ok: true,
        status: 'updated',
        pattern: this.getPattern(existing.id),
      };
    }

    const patternId = asString(input.id, toId('pat'));
    this.db.prepare(`
      INSERT INTO patterns (
        id, pattern_type, agents, scope, frequency, first_seen, last_seen,
        risk_score, confidence, active, resolution
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      patternId,
      internalType,
      agentsKey,
      scope,
      frequencyDelta,
      nowMs,
      nowMs,
      riskScore,
      confidence,
      active,
      resolution
    );

    return {
      ok: true,
      status: 'created',
      pattern: this.getPattern(patternId),
    };
  }

  createPattern(input = {}) {
    return this.upsertPattern(input);
  }

  getPattern(patternId) {
    const id = asString(patternId, '');
    if (!id || !this.isAvailable()) return null;
    const row = this.db.prepare(`SELECT * FROM patterns WHERE id = ?`).get(id);
    return this.mapPatternRow(row);
  }

  queryPatterns(filters = {}) {
    if (!this.isAvailable()) return { ok: false, reason: 'unavailable', patterns: [] };

    const clauses = ['1 = 1'];
    const params = [];
    const internalType = normalizePatternType(filters.patternType || filters.pattern_type || filters.type);
    const scope = asString(filters.scope, '');
    const active = filters.active;
    const since = asNumber(filters.since ?? filters.sinceMs, null);
    const until = asNumber(filters.until ?? filters.untilMs, null);
    const limit = Math.max(1, Math.min(1000, asNumber(filters.limit, 100)));

    if (internalType) {
      clauses.push('pattern_type = ?');
      params.push(internalType);
    }
    if (scope) {
      clauses.push('scope = ?');
      params.push(scope);
    }
    if (active === true || active === false) {
      clauses.push('active = ?');
      params.push(active ? 1 : 0);
    }
    if (Number.isFinite(since)) {
      clauses.push('last_seen >= ?');
      params.push(Math.floor(since));
    }
    if (Number.isFinite(until)) {
      clauses.push('last_seen <= ?');
      params.push(Math.floor(until));
    }

    const rows = this.db.prepare(`
      SELECT *
      FROM patterns
      WHERE ${clauses.join(' AND ')}
      ORDER BY frequency DESC, confidence DESC, last_seen DESC, id ASC
      LIMIT ?
    `).all(...params, limit);

    return {
      ok: true,
      patterns: rows.map((row) => this.mapPatternRow(row)).filter(Boolean),
      total: rows.length,
    };
  }

  setPatternActive(patternId, active, changedAt = Date.now()) {
    if (!this.isAvailable()) return { ok: false, reason: 'unavailable' };
    const id = asString(patternId, '');
    if (!id) return { ok: false, reason: 'pattern_id_required' };
    const existing = this.getPattern(id);
    if (!existing) return { ok: false, reason: 'pattern_not_found', patternId: id };

    this.db.prepare(`
      UPDATE patterns
      SET active = ?, last_seen = ?
      WHERE id = ?
    `).run(active ? 1 : 0, asTimestamp(changedAt), id);

    return {
      ok: true,
      status: active ? 'activated' : 'deactivated',
      pattern: this.getPattern(id),
    };
  }

  activatePattern(patternId, changedAt = Date.now()) {
    return this.setPatternActive(patternId, true, changedAt);
  }

  deactivatePattern(patternId, changedAt = Date.now()) {
    return this.setPatternActive(patternId, false, changedAt);
  }

  processPatternSpool(options = {}) {
    if (!this.isAvailable()) return { ok: false, reason: 'unavailable' };

    const spoolPath = asString(options.spoolPath, this.defaultSpoolPath);
    const events = this.readAndRotateSpool(spoolPath);
    const detected = this.detectRecurringPatterns(events, options);

    this.db.prepare(`
      UPDATE pattern_mining_state
      SET last_processed_at = ?, processed_events = processed_events + ?
      WHERE id = 1
    `).run(Date.now(), events.length);

    return {
      ok: true,
      processedEvents: events.length,
      detectedPatterns: detected.length,
      patterns: detected,
      events,
      spoolPath,
    };
  }

  readAndRotateSpool(spoolPath) {
    try {
      fs.mkdirSync(path.dirname(spoolPath), { recursive: true });
    } catch {
      return [];
    }

    if (!fs.existsSync(spoolPath)) return [];
    const processingPath = `${spoolPath}.processing.${Date.now()}.${process.pid}`;

    try {
      fs.renameSync(spoolPath, processingPath);
    } catch {
      return [];
    }

    let content = '';
    try {
      content = fs.readFileSync(processingPath, 'utf-8');
    } catch {
      content = '';
    }

    try {
      fs.unlinkSync(processingPath);
    } catch {
      // best effort
    }

    if (!content.trim()) return [];

    const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const events = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === 'object') events.push(parsed);
      } catch {
        // ignore malformed event
      }
    }
    return events;
  }

  detectRecurringPatterns(events = [], options = {}) {
    const nowMs = asTimestamp(options.nowMs);
    const results = [];
    const byScope = new Map();

    for (const event of events) {
      const scope = asString(event.scope || event.file || event.path, '');
      if (!scope) continue;
      if (!byScope.has(scope)) byScope.set(scope, []);
      byScope.get(scope).push(normalizePatternEvent(event));
    }

    const claimRows = this.db.prepare(`
      SELECT c.id, c.claim_type, c.status, c.session, c.confidence, c.owner, c.created_at, cs.scope
      FROM claims c
      LEFT JOIN claim_scopes cs ON cs.claim_id = c.id
      WHERE cs.scope IS NOT NULL AND TRIM(cs.scope) <> ''
      ORDER BY c.created_at DESC
      LIMIT 5000
    `).all();

    for (const row of claimRows) {
      const scope = asString(row.scope, '');
      if (!scope) continue;
      if (!byScope.has(scope)) byScope.set(scope, []);
      byScope.get(scope).push(normalizePatternEvent({
        claimId: row.id,
        agent: row.owner,
        claimType: row.claim_type,
        status: row.status,
        session: row.session,
        confidence: row.confidence,
        timestamp: row.created_at,
      }));
    }

    for (const [scope, scopeEvents] of byScope.entries()) {
      const normalizedScopeEvents = scopeEvents.map((entry) => normalizePatternEvent(entry));
      const agents = normalizeAgents(normalizedScopeEvents.map((entry) => entry.agent || entry.owner));
      const failures = normalizedScopeEvents.filter((entry) => {
        const outcome = asString(entry.outcome, '').toLowerCase();
        const claimType = asString(entry.claimType || entry.claim_type, '').toLowerCase();
        const status = asString(entry.status, '').toLowerCase();
        return outcome === 'failure'
          || outcome === 'error'
          || status === 'failed'
          || status === 'failure'
          || status === 'error'
          || status === 'pending_proof'
          || claimType === 'negative'
          || status === 'contested';
      });
      const successes = normalizedScopeEvents.filter((entry) => {
        const outcome = asString(entry.outcome, '').toLowerCase();
        const claimType = asString(entry.claimType || entry.claim_type, '').toLowerCase();
        const status = asString(entry.status, '').toLowerCase();
        return outcome === 'success'
          || status === 'completed'
          || status === 'complete'
          || claimType === 'decision'
          || status === 'confirmed'
          || claimType === 'fact';
      });

      if (agents.length >= 2 && normalizedScopeEvents.length >= 3) {
        const frequencyDelta = Math.max(1, Math.floor(normalizedScopeEvents.length / 2));
        const confidence = clamp01(0.45 + Math.min(0.4, frequencyDelta * 0.08), 0.5);
        const created = this.upsertPattern({
          patternType: 'coordination',
          scope,
          agents,
          frequencyDelta,
          confidence,
          riskScore: Math.min(0.6, confidence),
          nowMs,
        });
        if (created.ok && created.pattern) {
          results.push(created.pattern);
        }
      }

      if (failures.length >= 2 && this.hasTightSessionCluster(failures)) {
        const failureAgents = normalizeAgents(failures.map((entry) => entry.agent || entry.owner));
        const frequencyDelta = Math.max(1, failures.length - 1);
        const confidence = clamp01(0.55 + Math.min(0.4, frequencyDelta * 0.1), 0.6);
        const created = this.upsertPattern({
          patternType: 'failure',
          scope,
          agents: failureAgents,
          frequencyDelta,
          confidence,
          riskScore: confidence,
          nowMs,
        });
        if (created.ok && created.pattern) {
          results.push(created.pattern);
        }
      }

      if (successes.length >= 2) {
        const successAgents = normalizeAgents(successes.map((entry) => entry.agent || entry.owner));
        const frequencyDelta = Math.max(1, Math.floor(successes.length / 2));
        const confidence = clamp01(0.5 + Math.min(0.45, frequencyDelta * 0.1), 0.6);
        const created = this.upsertPattern({
          patternType: 'success',
          scope,
          agents: successAgents,
          frequencyDelta,
          confidence,
          riskScore: Math.max(0.05, 1 - confidence),
          nowMs,
        });
        if (created.ok && created.pattern) {
          results.push(created.pattern);
        }
      }
    }

    return results;
  }

  hasTightSessionCluster(events = []) {
    const ordinals = events
      .map((entry) => toSessionOrdinal(entry.session))
      .filter((value) => Number.isFinite(value))
      .sort((a, b) => a - b);
    if (ordinals.length < 2) return true;
    for (let i = 1; i < ordinals.length; i += 1) {
      if ((ordinals[i] - ordinals[i - 1]) <= 2) return true;
    }
    return false;
  }
}

module.exports = {
  TeamMemoryPatterns,
  DEFAULT_PATTERN_SPOOL_PATH,
  resolveDefaultPatternSpoolPath,
};
