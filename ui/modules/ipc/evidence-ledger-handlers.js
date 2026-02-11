/**
 * Evidence Ledger IPC Handlers
 * Channels:
 * - evidence-ledger:create-incident
 * - evidence-ledger:add-assertion
 * - evidence-ledger:bind-evidence
 * - evidence-ledger:record-verdict
 * - evidence-ledger:get-summary
 * - evidence-ledger:list-incidents
 * - evidence-ledger:record-decision
 * - evidence-ledger:list-decisions
 * - evidence-ledger:search-decisions
 * - evidence-ledger:get-context
 * - evidence-ledger:record-session-start
 * - evidence-ledger:record-session-end
 * - evidence-ledger:snapshot-context
 * - evidence-ledger:get-directives
 * - evidence-ledger:get-issues
 * - evidence-ledger:get-roadmap
 * - evidence-ledger:get-completions
 */

const { EvidenceLedgerStore } = require('../main/evidence-ledger-store');
const { EvidenceLedgerInvestigator } = require('../main/evidence-ledger-investigator');
const { EvidenceLedgerMemory } = require('../main/evidence-ledger-memory');

let sharedRuntime = null;

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

function createEvidenceLedgerRuntime(options = {}) {
  const storeOptions = asObject(options.storeOptions);
  const store = new EvidenceLedgerStore(storeOptions);
  const initResult = store.init();
  const investigator = new EvidenceLedgerInvestigator(store);
  const memory = new EvidenceLedgerMemory(store);
  return {
    store,
    investigator,
    memory,
    initResult,
  };
}

function getSharedRuntime(deps = {}) {
  if (sharedRuntime) return sharedRuntime;
  const factory = typeof deps.createEvidenceLedgerRuntime === 'function'
    ? deps.createEvidenceLedgerRuntime
    : createEvidenceLedgerRuntime;
  sharedRuntime = factory(deps.runtimeOptions || {});
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
  const runtime = getSharedRuntime(deps);
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

function registerEvidenceLedgerHandlers(ctx, deps = {}) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerEvidenceLedgerHandlers requires ctx.ipcMain');
  }

  const { ipcMain } = ctx;
  const execute = (action, payload) => executeEvidenceLedgerOperation(action, payload, {
    deps,
    source: { via: 'ipc', role: 'system' },
  });

  const channels = new Map([
    ['evidence-ledger:create-incident', 'create-incident'],
    ['evidence-ledger:add-assertion', 'add-assertion'],
    ['evidence-ledger:bind-evidence', 'bind-evidence'],
    ['evidence-ledger:record-verdict', 'record-verdict'],
    ['evidence-ledger:get-summary', 'get-summary'],
    ['evidence-ledger:list-incidents', 'list-incidents'],
    ['evidence-ledger:record-decision', 'record-decision'],
    ['evidence-ledger:get-decision', 'get-decision'],
    ['evidence-ledger:list-decisions', 'list-decisions'],
    ['evidence-ledger:search-decisions', 'search-decisions'],
    ['evidence-ledger:get-context', 'get-context'],
    ['evidence-ledger:record-session-start', 'record-session-start'],
    ['evidence-ledger:record-session-end', 'record-session-end'],
    ['evidence-ledger:snapshot-context', 'snapshot-context'],
    ['evidence-ledger:get-directives', 'get-directives'],
    ['evidence-ledger:get-issues', 'get-issues'],
    ['evidence-ledger:get-roadmap', 'get-roadmap'],
    ['evidence-ledger:get-completions', 'get-completions'],
  ]);

  for (const [channel, action] of channels.entries()) {
    ipcMain.handle(channel, (event, payload = {}) => execute(action, payload));
  }
}

function unregisterEvidenceLedgerHandlers(ctx) {
  const { ipcMain } = ctx || {};
  if (!ipcMain) return;
  const channels = [
    'evidence-ledger:create-incident',
    'evidence-ledger:add-assertion',
    'evidence-ledger:bind-evidence',
    'evidence-ledger:record-verdict',
    'evidence-ledger:get-summary',
    'evidence-ledger:list-incidents',
    'evidence-ledger:record-decision',
    'evidence-ledger:get-decision',
    'evidence-ledger:list-decisions',
    'evidence-ledger:search-decisions',
    'evidence-ledger:get-context',
    'evidence-ledger:record-session-start',
    'evidence-ledger:record-session-end',
    'evidence-ledger:snapshot-context',
    'evidence-ledger:get-directives',
    'evidence-ledger:get-issues',
    'evidence-ledger:get-roadmap',
    'evidence-ledger:get-completions',
  ];
  for (const channel of channels) {
    ipcMain.removeHandler(channel);
  }
  closeSharedRuntime();
}

registerEvidenceLedgerHandlers.unregister = unregisterEvidenceLedgerHandlers;

module.exports = {
  registerEvidenceLedgerHandlers,
  unregisterEvidenceLedgerHandlers,
  createEvidenceLedgerRuntime,
  executeEvidenceLedgerOperation,
  closeSharedRuntime,
};
