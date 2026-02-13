const crypto = require('crypto');
const { normalizeRole } = require('./claims');

const GUARD_ACTIONS = new Set(['warn', 'block', 'suggest', 'escalate']);

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

function asTimestamp(value, fallback = Date.now()) {
  const numeric = asNumber(value, fallback);
  if (!Number.isFinite(numeric) || numeric < 0) return Math.floor(fallback);
  return Math.floor(numeric);
}

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function asBoolean(value, fallback = null) {
  if (value === true || value === false) return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
    if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  }
  return fallback;
}

function normalizePatternType(value) {
  const normalized = asString(value, '').toLowerCase();
  if (!normalized) return null;
  if (normalized === 'stall') return 'failure';
  if (normalized === 'handoff_loop') return 'coordination';
  if (normalized === 'escalation_spiral') return 'success';
  return normalized;
}

function normalizeAction(value) {
  const action = asString(value, '').toLowerCase();
  if (!action) return null;
  if (action === 'notify') return 'warn';
  if (action === 'recommend') return 'suggest';
  return GUARD_ACTIONS.has(action) ? action : null;
}

function normalizeStringList(value) {
  const source = Array.isArray(value) ? value : [];
  const seen = new Set();
  const output = [];
  for (const entry of source) {
    const text = asString(entry, '');
    if (!text) continue;
    const normalized = text.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(text);
  }
  return output;
}

function parseTriggerCondition(raw) {
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return { ...raw };
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function buildTriggerCondition(input = {}) {
  const source = parseTriggerCondition(input.triggerCondition || input.trigger_condition);
  const scopes = normalizeStringList([
    ...(Array.isArray(source.scopes) ? source.scopes : []),
    ...(Array.isArray(input.scopes) ? input.scopes : []),
    asString(source.scope, ''),
    asString(input.scope, ''),
  ]);
  const eventTypes = normalizeStringList([
    ...(Array.isArray(source.eventTypes) ? source.eventTypes : []),
    ...(Array.isArray(input.eventTypes) ? input.eventTypes : []),
    asString(source.eventType, ''),
    asString(input.eventType || input.event_type, ''),
    asString(input.type, ''),
  ]);

  const patternType = normalizePatternType(
    input.patternType || input.pattern_type || source.patternType || source.pattern_type
  );
  const patternId = asNullableString(input.patternId || input.pattern_id || source.patternId || source.pattern_id);
  const claimType = asNullableString(input.claimType || input.claim_type || source.claimType || source.claim_type);
  const status = asNullableString(input.status || source.status);
  const textIncludes = asNullableString(
    input.textIncludes
    || input.text_includes
    || input.contains
    || source.textIncludes
    || source.text_includes
    || source.contains
  );
  const suggestion = asNullableString(input.suggestion || source.suggestion);

  return {
    scope: scopes.length > 0 ? scopes[0] : null,
    scopes,
    patternType,
    patternId,
    eventType: eventTypes.length > 0 ? eventTypes[0] : null,
    eventTypes,
    claimType,
    status,
    textIncludes,
    suggestion,
  };
}

function hasMeaningfulCondition(condition = {}) {
  const scopes = Array.isArray(condition.scopes) ? condition.scopes : [];
  const eventTypes = Array.isArray(condition.eventTypes) ? condition.eventTypes : [];
  return Boolean(
    (condition.scope && String(condition.scope).trim())
    || scopes.length > 0
    || (condition.patternType && String(condition.patternType).trim())
    || (condition.patternId && String(condition.patternId).trim())
    || (condition.eventType && String(condition.eventType).trim())
    || eventTypes.length > 0
    || (condition.claimType && String(condition.claimType).trim())
    || (condition.status && String(condition.status).trim())
    || (condition.textIncludes && String(condition.textIncludes).trim())
  );
}

function mapGuardRow(row) {
  if (!row) return null;
  const condition = parseTriggerCondition(row.trigger_condition);
  return {
    id: row.id,
    triggerCondition: condition,
    action: row.action,
    sourceClaim: row.source_claim || null,
    sourcePattern: row.source_pattern || null,
    active: Number(row.active || 0) === 1,
    createdAt: Number(row.created_at || 0),
    expiresAt: row.expires_at === null || row.expires_at === undefined ? null : Number(row.expires_at),
  };
}

function getEventScope(event = {}) {
  return asString(event.scope || event.file || event.path, '');
}

function getEventPatternType(event = {}) {
  return normalizePatternType(event.patternType || event.pattern_type || event.type);
}

function getEventType(event = {}) {
  return asString(event.eventType || event.event_type || event.kind, '').toLowerCase();
}

function includesIgnoreCase(haystack, needle) {
  const left = asString(haystack, '').toLowerCase();
  const right = asString(needle, '').toLowerCase();
  if (!left || !right) return false;
  return left.includes(right);
}

class TeamMemoryGuards {
  constructor(db) {
    this.db = db;
  }

  isAvailable() {
    return Boolean(this.db && typeof this.db.prepare === 'function');
  }

  getGuard(guardId) {
    if (!this.isAvailable()) return null;
    const id = asString(guardId, '');
    if (!id) return null;
    const row = this.db.prepare(`SELECT * FROM guards WHERE id = ?`).get(id);
    return mapGuardRow(row);
  }

  createGuard(input = {}) {
    if (!this.isAvailable()) return { ok: false, reason: 'unavailable' };

    const action = normalizeAction(input.action);
    if (!action) {
      return { ok: false, reason: 'invalid_action', action: input.action || null };
    }

    const condition = buildTriggerCondition(input);
    if (!hasMeaningfulCondition(condition)) {
      return { ok: false, reason: 'trigger_condition_required' };
    }

    const guardId = asString(input.id, toId('grd'));
    const sourceClaim = asNullableString(input.sourceClaim || input.source_claim);
    const sourcePattern = asNullableString(input.sourcePattern || input.source_pattern);
    const active = input.active === false ? 0 : 1;
    const createdAt = asTimestamp(input.nowMs);
    const expiresAtRaw = asNumber(input.expiresAt ?? input.expires_at, null);
    const expiresAt = Number.isFinite(expiresAtRaw) ? Math.floor(expiresAtRaw) : null;

    try {
      this.db.prepare(`
        INSERT INTO guards (
          id, trigger_condition, action, source_claim, source_pattern, active, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        guardId,
        JSON.stringify(condition),
        action,
        sourceClaim,
        sourcePattern,
        active,
        createdAt,
        expiresAt
      );
    } catch (err) {
      return {
        ok: false,
        reason: 'db_error',
        error: err.message,
      };
    }

    return {
      ok: true,
      status: 'created',
      guard: this.getGuard(guardId),
    };
  }

  queryGuards(filters = {}) {
    if (!this.isAvailable()) return { ok: false, reason: 'unavailable', guards: [] };

    const clauses = ['1 = 1'];
    const params = [];
    const action = normalizeAction(filters.action);
    const active = asBoolean(filters.active, null);
    const sourcePattern = asString(filters.sourcePattern || filters.source_pattern, '');
    const sourceClaim = asString(filters.sourceClaim || filters.source_claim, '');
    const includeExpired = filters.includeExpired === true;
    const nowMs = asTimestamp(filters.nowMs);
    const limit = Math.max(1, Math.min(5000, asNumber(filters.limit, 100) || 100));

    if (action) {
      clauses.push('action = ?');
      params.push(action);
    }
    if (active === true || active === false) {
      clauses.push('active = ?');
      params.push(active ? 1 : 0);
    }
    if (sourcePattern) {
      clauses.push('source_pattern = ?');
      params.push(sourcePattern);
    }
    if (sourceClaim) {
      clauses.push('source_claim = ?');
      params.push(sourceClaim);
    }
    if (!includeExpired) {
      clauses.push('(expires_at IS NULL OR expires_at > ?)');
      params.push(nowMs);
    }

    const rows = this.db.prepare(`
      SELECT *
      FROM guards
      WHERE ${clauses.join(' AND ')}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(...params, limit);

    const scopeFilter = asString(filters.scope, '').toLowerCase();
    const patternFilter = normalizePatternType(filters.patternType || filters.pattern_type || filters.type);
    const eventTypeFilter = asString(filters.eventType || filters.event_type, '').toLowerCase();

    const guards = rows
      .map((row) => mapGuardRow(row))
      .filter(Boolean)
      .filter((guard) => {
        const condition = asObject(guard.triggerCondition);
        if (scopeFilter) {
          const scopes = normalizeStringList(condition.scopes || [condition.scope]).map((entry) => entry.toLowerCase());
          if (!scopes.some((scope) => scope === scopeFilter)) {
            return false;
          }
        }
        if (patternFilter) {
          const candidate = normalizePatternType(condition.patternType);
          if (candidate !== patternFilter) return false;
        }
        if (eventTypeFilter) {
          const eventTypes = normalizeStringList(condition.eventTypes || [condition.eventType]).map((entry) => entry.toLowerCase());
          if (!eventTypes.includes(eventTypeFilter)) return false;
        }
        return true;
      });

    return {
      ok: true,
      guards,
      total: guards.length,
    };
  }

  setGuardActive(guardId, active, changedAt = Date.now()) {
    if (!this.isAvailable()) return { ok: false, reason: 'unavailable' };

    const id = asString(guardId, '');
    if (!id) return { ok: false, reason: 'guard_id_required' };

    const existing = this.getGuard(id);
    if (!existing) return { ok: false, reason: 'guard_not_found', guardId: id };

    try {
      this.db.prepare(`
        UPDATE guards
        SET active = ?
        WHERE id = ?
      `).run(active ? 1 : 0, id);
    } catch (err) {
      return {
        ok: false,
        reason: 'db_error',
        error: err.message,
      };
    }

    return {
      ok: true,
      status: active ? 'activated' : 'deactivated',
      guard: this.getGuard(id),
    };
  }

  activateGuard(guardId, changedAt = Date.now()) {
    return this.setGuardActive(guardId, true, changedAt);
  }

  deactivateGuard(guardId, changedAt = Date.now()) {
    return this.setGuardActive(guardId, false, changedAt);
  }

  guardMatchesEvent(guard, event = {}) {
    if (!guard || guard.active !== true) return false;

    const condition = asObject(guard.triggerCondition);
    const scope = getEventScope(event).toLowerCase();
    const patternType = getEventPatternType(event);
    const patternId = asString(event.patternId || event.pattern_id || event.sourcePattern, '');
    const eventType = getEventType(event);
    const claimType = asString(event.claimType || event.claim_type, '').toLowerCase();
    const status = asString(event.status, '').toLowerCase();
    const message = asString(event.message || event.text || event.statement, '');

    const scopes = normalizeStringList(condition.scopes || [condition.scope]).map((entry) => entry.toLowerCase());
    if (scopes.length > 0) {
      const scopeMatched = scopes.some((candidate) => scope && (scope === candidate || scope.startsWith(`${candidate}/`) || scope.startsWith(`${candidate}\\`)));
      if (!scopeMatched) return false;
    }

    if (condition.patternType) {
      if (normalizePatternType(condition.patternType) !== patternType) return false;
    }

    if (condition.patternId) {
      if (asString(condition.patternId, '') !== patternId) return false;
    }

    const eventTypes = normalizeStringList(condition.eventTypes || [condition.eventType]).map((entry) => entry.toLowerCase());
    if (eventTypes.length > 0) {
      if (!eventTypes.includes(eventType)) return false;
    }

    if (condition.claimType) {
      if (asString(condition.claimType, '').toLowerCase() !== claimType) return false;
    }

    if (condition.status) {
      if (asString(condition.status, '').toLowerCase() !== status) return false;
    }

    if (condition.textIncludes) {
      if (!includesIgnoreCase(message, condition.textIncludes)) return false;
    }

    return true;
  }

  buildGuardActionResult(guard, event = {}, nowMs = Date.now()) {
    const scope = getEventScope(event) || guard?.triggerCondition?.scope || 'unknown_scope';
    const action = guard.action;
    const base = {
      guardId: guard.id,
      action,
      scope,
      sourcePattern: guard.sourcePattern || null,
      sourceClaim: guard.sourceClaim || null,
      event,
      firedAt: asTimestamp(nowMs),
      blocked: action === 'block',
    };

    if (action === 'warn') {
      return {
        ...base,
        level: 'warn',
        message: `Guard warning: ${scope}`,
      };
    }
    if (action === 'suggest') {
      return {
        ...base,
        level: 'info',
        message: guard.triggerCondition?.suggestion || `Guard suggestion for ${scope}`,
      };
    }
    if (action === 'escalate') {
      return {
        ...base,
        level: 'warn',
        message: `Guard escalation: ${scope}`,
      };
    }
    return {
      ...base,
      level: 'error',
      message: `Guard block: ${scope}`,
    };
  }

  evaluateHookEvents(events = [], options = {}) {
    if (!this.isAvailable()) return { ok: false, reason: 'unavailable', actions: [] };

    const eventList = Array.isArray(events) ? events : [];
    if (eventList.length === 0) {
      return {
        ok: true,
        evaluatedEvents: 0,
        matchedEvents: 0,
        blocked: false,
        blockedCount: 0,
        actions: [],
      };
    }

    const candidates = this.queryGuards({
      active: true,
      includeExpired: false,
      nowMs: options.nowMs,
      limit: Math.max(100, eventList.length * 10),
    });
    if (!candidates.ok) return candidates;

    const nowMs = asTimestamp(options.nowMs);
    const actions = [];
    let matchedEvents = 0;

    for (const event of eventList) {
      let eventMatched = false;
      for (const guard of candidates.guards) {
        if (!this.guardMatchesEvent(guard, event)) continue;
        eventMatched = true;
        actions.push(this.buildGuardActionResult(guard, event, nowMs));
      }
      if (eventMatched) matchedEvents += 1;
    }

    const blockedCount = actions.filter((entry) => entry.blocked).length;

    return {
      ok: true,
      evaluatedEvents: eventList.length,
      matchedEvents,
      blocked: blockedCount > 0,
      blockedCount,
      actions,
    };
  }

  autoCreateGuardsFromPatterns(input = {}, options = {}) {
    if (!this.isAvailable()) return { ok: false, reason: 'unavailable', created: [] };

    const patterns = Array.isArray(input.patterns) ? input.patterns : [];
    const threshold = Math.max(0, Math.min(1, asNumber(input.threshold ?? options.threshold, 0.8) || 0.8));
    const nowMs = asTimestamp(input.nowMs ?? options.nowMs);
    const created = [];
    const existing = [];
    const errors = [];

    for (const pattern of patterns) {
      const patternId = asString(pattern?.id, '');
      const patternType = normalizePatternType(pattern?.patternType || pattern?.pattern_type || pattern?.internalType);
      const confidence = asNumber(pattern?.confidence, null);
      const scope = asString(pattern?.scope, '');
      if (!patternId || !scope) continue;
      if (patternType !== 'failure') continue;
      if (!(Number.isFinite(confidence) && confidence >= threshold)) continue;

      const existingRow = this.db.prepare(`
        SELECT id, active
        FROM guards
        WHERE source_pattern = ? AND action = 'warn'
        ORDER BY created_at DESC
        LIMIT 1
      `).get(patternId);

      if (existingRow?.id) {
        existing.push(existingRow.id);
        if (Number(existingRow.active || 0) !== 1) {
          this.activateGuard(existingRow.id, nowMs);
        }
        continue;
      }

      const createdGuard = this.createGuard({
        action: 'warn',
        sourcePattern: patternId,
        active: true,
        nowMs,
        triggerCondition: {
          scope,
          patternType: 'failure',
          patternId,
          suggestion: `High-confidence failure pattern detected for ${scope}. Review before next change.`,
        },
      });
      if (createdGuard.ok && createdGuard.guard) {
        created.push(createdGuard.guard);
      } else {
        errors.push(createdGuard);
      }
    }

    return {
      ok: true,
      threshold,
      created,
      createdCount: created.length,
      existingCount: existing.length,
      errors,
    };
  }
}

module.exports = {
  TeamMemoryGuards,
  GUARD_ACTIONS,
};
