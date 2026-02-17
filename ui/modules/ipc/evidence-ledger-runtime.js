/**
 * Evidence Ledger runtime execution (in-process).
 * This module contains the local SQLite runtime and operation dispatch logic.
 */

const fs = require('fs');
const path = require('path');
const { EvidenceLedgerStore } = require('../main/evidence-ledger-store');
const { EvidenceLedgerInvestigator } = require('../main/evidence-ledger-investigator');
const { EvidenceLedgerMemory } = require('../main/evidence-ledger-memory');
const { seedDecisionMemory } = require('../main/evidence-ledger-memory-seed');
const log = require('../logger');
const { resolveCoordPath } = require('../../config');

let sharedRuntime = null;
function resolveDefaultContextSnapshotPath() {
  if (typeof resolveCoordPath === 'function') {
    return resolveCoordPath(path.join('context-snapshots', '1.md'));
  }
  return null;
}

function resolveDefaultEvidenceLedgerDbPath() {
  if (typeof resolveCoordPath === 'function') {
    return resolveCoordPath(path.join('runtime', 'evidence-ledger.db'), { forWrite: true });
  }
  return null;
}

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function asString(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function toNumberOrFallback(value, fallback = null) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return numeric;
}

function isRuntimeAvailable(runtime) {
  return Boolean(runtime?.store && typeof runtime.store.isAvailable === 'function' && runtime.store.isAvailable());
}

function normalizeRuntimeOptions(runtimeOptions = {}) {
  const options = asObject(runtimeOptions);
  const storeOptions = asObject(options.storeOptions);
  const seedOptions = asObject(options.seedOptions);

  if (!storeOptions.dbPath) {
    const defaultDbPath = resolveDefaultEvidenceLedgerDbPath();
    if (defaultDbPath) {
      storeOptions.dbPath = defaultDbPath;
    }
  }
  if (!seedOptions.contextSnapshotPath) {
    const defaultSnapshotPath = resolveDefaultContextSnapshotPath();
    if (defaultSnapshotPath) {
      seedOptions.contextSnapshotPath = defaultSnapshotPath;
    }
  }

  return {
    ...options,
    storeOptions,
    seedOptions,
  };
}

function getExplicitStoreDbPath(runtimeOptions = {}) {
  const options = asObject(runtimeOptions);
  const storeOptions = asObject(options.storeOptions);
  return asString(storeOptions.dbPath, '');
}

function shouldSeedRuntime(runtime) {
  if (!isRuntimeAvailable(runtime)) return false;
  const db = runtime?.store?.db;
  if (!db || typeof db.prepare !== 'function') return false;
  try {
    const decisionCount = Number(db.prepare('SELECT COUNT(*) AS count FROM ledger_decisions').get()?.count || 0);
    const sessionCount = Number(db.prepare('SELECT COUNT(*) AS count FROM ledger_sessions').get()?.count || 0);
    return decisionCount === 0 && sessionCount === 0;
  } catch {
    return false;
  }
}

function parseList(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseContextSnapshotMarkdown(raw) {
  const text = String(raw || '');
  if (!text.trim()) return null;

  const sessionMatch = text.match(/(?:Session:\s*|\|\s*Session\s+)(\d+)/i);
  const testsMatch = text.match(/Tests:\s*(\d+)\s+suites,\s*(\d+)\s+tests/i);
  const completedMatch = text.match(/^Completed:\s*(.+)$/im);
  const nextMatch = text.match(/^Next:\s*(.+)$/im);

  const session = sessionMatch ? Number.parseInt(sessionMatch[1], 10) : null;
  if (!Number.isInteger(session) || session <= 0) return null;

  const context = {
    session,
    mode: 'PTY',
    completed: completedMatch ? parseList(completedMatch[1]) : [],
    roadmap: nextMatch ? parseList(nextMatch[1]) : [],
    not_yet_done: nextMatch ? parseList(nextMatch[1]) : [],
    stats: testsMatch
      ? {
          test_suites: Number.parseInt(testsMatch[1], 10) || 0,
          tests_passed: Number.parseInt(testsMatch[2], 10) || 0,
        }
      : {},
  };

  return context;
}

function maybeSeedDecisionMemory(runtime, options = {}) {
  const seedOptions = asObject(options);
  if (seedOptions.enabled === false) {
    return { ok: true, skipped: true, reason: 'seed_disabled' };
  }
  if (!shouldSeedRuntime(runtime)) {
    return { ok: true, skipped: true, reason: 'already_populated' };
  }

  const snapshotPath = asString(seedOptions.contextSnapshotPath, resolveDefaultContextSnapshotPath() || '');
  if (!snapshotPath || !fs.existsSync(snapshotPath)) {
    return { ok: true, skipped: true, reason: 'context_snapshot_missing', snapshotPath };
  }

  let contextSnapshot = null;
  try {
    const raw = fs.readFileSync(snapshotPath, 'utf8');
    contextSnapshot = parseContextSnapshotMarkdown(raw);
  } catch (err) {
    return {
      ok: false,
      reason: 'context_snapshot_read_failed',
      snapshotPath,
      error: err.message,
    };
  }
  if (!contextSnapshot) {
    return {
      ok: true,
      skipped: true,
      reason: 'context_snapshot_unparseable',
      snapshotPath,
    };
  }

  const seedResult = seedDecisionMemory(runtime.memory, contextSnapshot, {
    sessionId: asString(seedOptions.sessionId, ''),
    markSessionEnded: seedOptions.markSessionEnded === true,
    summary: asString(seedOptions.summary, ''),
  });
  if (!seedResult || seedResult.ok === false) {
    return {
      ok: false,
      reason: 'seed_failed',
      snapshotPath,
      ...(seedResult || {}),
    };
  }

  return {
    ok: true,
    snapshotPath,
    ...seedResult,
  };
}

function createEvidenceLedgerRuntime(options = {}) {
  const normalizedOptions = normalizeRuntimeOptions(options);
  const storeOptions = asObject(normalizedOptions.storeOptions);
  const store = new EvidenceLedgerStore(storeOptions);
  const initResult = store.init();
  const investigator = new EvidenceLedgerInvestigator(store);
  const memory = new EvidenceLedgerMemory(store);
  const seedResult = maybeSeedDecisionMemory({ store, investigator, memory }, asObject(normalizedOptions.seedOptions));
  if (seedResult && seedResult.ok === false) {
    log.warn('EvidenceLedger', `Startup seed skipped due to error: ${seedResult.reason || seedResult.error || 'unknown'}`);
  }
  return {
    store,
    investigator,
    memory,
    initResult,
    seedResult,
  };
}

function getSharedRuntime(deps = {}) {
  const factory = typeof deps.createEvidenceLedgerRuntime === 'function'
    ? deps.createEvidenceLedgerRuntime
    : createEvidenceLedgerRuntime;
  const runtimeOptionsRaw = asObject(deps.runtimeOptions);
  const explicitRequestedDbPath = getExplicitStoreDbPath(runtimeOptionsRaw);
  const runtimeOptions = normalizeRuntimeOptions(runtimeOptionsRaw);
  const forceRuntimeRecreate = deps.forceRuntimeRecreate === true;
  const recreateUnavailable = deps.recreateUnavailable !== false;

  if (forceRuntimeRecreate) {
    closeSharedRuntime();
  }

  if (sharedRuntime && recreateUnavailable && !isRuntimeAvailable(sharedRuntime)) {
    closeSharedRuntime();
  }

  const activeDbPath = asString(sharedRuntime?.store?.dbPath, '');
  if (
    sharedRuntime
    && explicitRequestedDbPath
    && activeDbPath
    && path.resolve(explicitRequestedDbPath) !== path.resolve(activeDbPath)
  ) {
    closeSharedRuntime();
  }

  if (sharedRuntime) return sharedRuntime;
  sharedRuntime = factory(runtimeOptions);
  return sharedRuntime;
}

function closeSharedRuntime() {
  if (!sharedRuntime) return;
  try {
    sharedRuntime.store?.close?.();
  } catch {
    // best effort
  }
  sharedRuntime = null;
}

function initializeEvidenceLedgerRuntime(options = {}) {
  const opts = asObject(options);
  const deps = asObject(opts.deps);
  const runtime = getSharedRuntime({
    ...deps,
    runtimeOptions: opts.runtimeOptions || deps.runtimeOptions,
    forceRuntimeRecreate: opts.forceRuntimeRecreate === true || deps.forceRuntimeRecreate === true,
    recreateUnavailable: opts.recreateUnavailable !== false && deps.recreateUnavailable !== false,
  });

  const status = runtime?.store && typeof runtime.store.getStatus === 'function'
    ? runtime.store.getStatus()
    : null;
  return {
    ok: isRuntimeAvailable(runtime),
    initResult: runtime?.initResult || null,
    seedResult: runtime?.seedResult || null,
    status,
  };
}

function normalizeAddAssertionPayload(input) {
  const payload = asObject(input);
  const incidentId = asString(payload.incidentId || payload.incident || payload.incident_id);
  const opts = { ...payload };
  delete opts.incidentId;
  delete opts.incident;
  delete opts.incident_id;
  return { incidentId, opts };
}

function normalizeBindEvidencePayload(input) {
  const payload = asObject(input);
  const assertionId = asString(payload.assertionId || payload.assertion || payload.assertion_id);
  const binding = payload.binding && typeof payload.binding === 'object'
    ? payload.binding
    : { ...payload };
  delete binding.assertionId;
  delete binding.assertion;
  delete binding.assertion_id;
  return { assertionId, binding };
}

function normalizeRecordVerdictPayload(input) {
  const payload = asObject(input);
  const incidentId = asString(payload.incidentId || payload.incident || payload.incident_id);
  const opts = { ...payload };
  delete opts.incidentId;
  delete opts.incident;
  delete opts.incident_id;
  if (opts.confidence !== undefined) {
    opts.confidence = toNumberOrFallback(opts.confidence, opts.confidence);
  }
  return { incidentId, opts };
}

function normalizeGetSummaryPayload(input) {
  const payload = asObject(input);
  return asString(payload.incidentId || payload.incident || payload.incident_id);
}

function normalizeListIncidentsPayload(input) {
  return asObject(input);
}

function normalizeRecordDecisionPayload(input) {
  return asObject(input);
}

function normalizeGetDecisionPayload(input) {
  const payload = asObject(input);
  return asString(payload.decisionId || payload.decision || payload.decision_id);
}

function normalizeListDecisionsPayload(input) {
  return asObject(input);
}

function normalizeListSessionsPayload(input) {
  return asObject(input);
}

function normalizeSearchDecisionsPayload(input) {
  const payload = asObject(input);
  const query = asString(payload.query || payload.q || payload.search);
  const filters = asObject(payload.filters);

  if (payload.category !== undefined) filters.category = payload.category;
  if (payload.status !== undefined) filters.status = payload.status;
  if (payload.author !== undefined) filters.author = payload.author;
  if (payload.limit !== undefined) filters.limit = payload.limit;

  return { query, filters };
}

function normalizeGetContextPayload(input) {
  return asObject(input);
}

function normalizeRecordSessionStartPayload(input) {
  const payload = asObject(input);
  const opts = { ...payload };

  const sessionNumber = toNumberOrFallback(
    payload.sessionNumber ?? payload.number ?? payload.session,
    undefined
  );
  if (sessionNumber !== undefined) {
    opts.sessionNumber = sessionNumber;
  }

  if (payload.startedAtMs === undefined && payload.startedAt !== undefined) {
    const startedAtMs = toNumberOrFallback(payload.startedAt, undefined);
    if (startedAtMs !== undefined) opts.startedAtMs = startedAtMs;
  }

  return opts;
}

function normalizeRecordSessionEndPayload(input) {
  const payload = asObject(input);
  const sessionId = asString(payload.sessionId || payload.session || payload.session_id);
  const opts = { ...payload };
  delete opts.sessionId;
  delete opts.session;
  delete opts.session_id;

  if (opts.endedAtMs === undefined && opts.endedAt !== undefined) {
    const endedAtMs = toNumberOrFallback(opts.endedAt, undefined);
    if (endedAtMs !== undefined) opts.endedAtMs = endedAtMs;
  }

  return { sessionId, opts };
}

function normalizeSnapshotContextPayload(input) {
  const payload = asObject(input);
  const sessionId = asString(payload.sessionId || payload.session || payload.session_id);
  const opts = { ...payload };
  delete opts.sessionId;
  delete opts.session;
  delete opts.session_id;
  return { sessionId, opts };
}

function normalizeGetLimitPayload(input, fallback = 100) {
  const payload = asObject(input);
  return toNumberOrFallback(payload.limit, fallback);
}

function normalizeGetIssuesPayload(input) {
  const payload = asObject(input);
  return {
    status: asString(payload.status, ''),
    limit: toNumberOrFallback(payload.limit, 500),
  };
}

function enrichPayloadForSource(payload = {}, source = {}) {
  const base = asObject(payload);
  if (!base.createdBy && source.role) {
    base.createdBy = source.role;
  }
  if (!base.author && source.role) {
    base.author = source.role;
  }
  return base;
}

function executeEvidenceLedgerOperation(action, payload = {}, options = {}) {
  const deps = asObject(options.deps);
  const runtime = getSharedRuntime({
    ...deps,
    runtimeOptions: options.runtimeOptions || deps.runtimeOptions,
    forceRuntimeRecreate: options.forceRuntimeRecreate === true || deps.forceRuntimeRecreate === true,
    recreateUnavailable: options.recreateUnavailable !== false && deps.recreateUnavailable !== false,
  });
  const investigator = runtime?.investigator;
  const memory = runtime?.memory;
  const source = asObject(options.source);

  if (!investigator && !memory) {
    return { ok: false, reason: 'unavailable' };
  }

  const normalizedAction = asString(action).toLowerCase();
  const enrichedPayload = enrichPayloadForSource(payload, source);

  try {
    switch (normalizedAction) {
      case 'create-incident': {
        return investigator.createIncident(enrichedPayload);
      }
      case 'add-assertion':
      case 'add-hypothesis': {
        const { incidentId, opts } = normalizeAddAssertionPayload(enrichedPayload);
        return investigator.addAssertion(incidentId, opts);
      }
      case 'bind-evidence': {
        const { assertionId, binding } = normalizeBindEvidencePayload(enrichedPayload);
        return investigator.bindEvidence(assertionId, binding);
      }
      case 'record-verdict': {
        const { incidentId, opts } = normalizeRecordVerdictPayload(enrichedPayload);
        return investigator.recordVerdict(incidentId, opts);
      }
      case 'get-summary': {
        const incidentId = normalizeGetSummaryPayload(enrichedPayload);
        return investigator.getIncidentSummary(incidentId);
      }
      case 'list-incidents': {
        const filters = normalizeListIncidentsPayload(enrichedPayload);
        return investigator.listIncidents(filters);
      }
      case 'record-decision': {
        if (!memory) return { ok: false, reason: 'unavailable' };
        const opts = normalizeRecordDecisionPayload(enrichedPayload);
        return memory.recordDecision(opts);
      }
      case 'get-decision': {
        if (!memory) return { ok: false, reason: 'unavailable' };
        const decisionId = normalizeGetDecisionPayload(enrichedPayload);
        return memory.getDecision(decisionId);
      }
      case 'list-decisions': {
        if (!memory) return { ok: false, reason: 'unavailable' };
        const filters = normalizeListDecisionsPayload(enrichedPayload);
        return memory.listDecisions(filters);
      }
      case 'list-sessions': {
        if (!memory) return { ok: false, reason: 'unavailable' };
        const filters = normalizeListSessionsPayload(enrichedPayload);
        return memory.listSessions(filters);
      }
      case 'search-decisions': {
        if (!memory) return { ok: false, reason: 'unavailable' };
        const { query, filters } = normalizeSearchDecisionsPayload(enrichedPayload);
        return memory.searchDecisions(query, filters);
      }
      case 'get-context': {
        if (!memory) return { ok: false, reason: 'unavailable' };
        const opts = normalizeGetContextPayload(enrichedPayload);
        return memory.getLatestContext(opts);
      }
      case 'record-session-start': {
        if (!memory) return { ok: false, reason: 'unavailable' };
        const opts = normalizeRecordSessionStartPayload(enrichedPayload);
        return memory.recordSessionStart(opts);
      }
      case 'record-session-end': {
        if (!memory) return { ok: false, reason: 'unavailable' };
        const { sessionId, opts } = normalizeRecordSessionEndPayload(enrichedPayload);
        return memory.recordSessionEnd(sessionId, opts);
      }
      case 'snapshot-context': {
        if (!memory) return { ok: false, reason: 'unavailable' };
        const { sessionId, opts } = normalizeSnapshotContextPayload(enrichedPayload);
        return memory.snapshotContext(sessionId, opts);
      }
      case 'get-directives': {
        if (!memory) return { ok: false, reason: 'unavailable' };
        const limit = normalizeGetLimitPayload(enrichedPayload, 200);
        return memory.getActiveDirectives(limit);
      }
      case 'get-issues': {
        if (!memory) return { ok: false, reason: 'unavailable' };
        const { status, limit } = normalizeGetIssuesPayload(enrichedPayload);
        return memory.getKnownIssues(status || undefined, limit);
      }
      case 'get-roadmap': {
        if (!memory) return { ok: false, reason: 'unavailable' };
        const limit = normalizeGetLimitPayload(enrichedPayload, 500);
        return memory.getRoadmap(limit);
      }
      case 'get-completions': {
        if (!memory) return { ok: false, reason: 'unavailable' };
        const limit = normalizeGetLimitPayload(enrichedPayload, 50);
        return memory.getRecentCompletions(limit);
      }
      default:
        return {
          ok: false,
          reason: 'unknown_action',
          action: normalizedAction || action || null,
        };
    }
  } catch (err) {
    return {
      ok: false,
      reason: 'handler_error',
      error: err.message,
      action: normalizedAction || action || null,
    };
  }
}

module.exports = {
  createEvidenceLedgerRuntime,
  initializeEvidenceLedgerRuntime,
  executeEvidenceLedgerOperation,
  closeSharedRuntime,
};
