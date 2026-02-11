/**
 * Evidence Ledger IPC Handlers
 * Channels:
 * - evidence-ledger:create-incident
 * - evidence-ledger:add-assertion
 * - evidence-ledger:bind-evidence
 * - evidence-ledger:record-verdict
 * - evidence-ledger:get-summary
 * - evidence-ledger:list-incidents
 */

const { EvidenceLedgerStore } = require('../main/evidence-ledger-store');
const { EvidenceLedgerInvestigator } = require('../main/evidence-ledger-investigator');

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
  return {
    store,
    investigator,
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
  const source = asObject(options.source);

  if (!investigator) {
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

  ipcMain.handle('evidence-ledger:create-incident', (event, payload = {}) => {
    return execute('create-incident', payload);
  });

  ipcMain.handle('evidence-ledger:add-assertion', (event, payload = {}) => {
    return execute('add-assertion', payload);
  });

  ipcMain.handle('evidence-ledger:bind-evidence', (event, payload = {}) => {
    return execute('bind-evidence', payload);
  });

  ipcMain.handle('evidence-ledger:record-verdict', (event, payload = {}) => {
    return execute('record-verdict', payload);
  });

  ipcMain.handle('evidence-ledger:get-summary', (event, payload = {}) => {
    return execute('get-summary', payload);
  });

  ipcMain.handle('evidence-ledger:list-incidents', (event, payload = {}) => {
    return execute('list-incidents', payload);
  });
}

function unregisterEvidenceLedgerHandlers(ctx) {
  const { ipcMain } = ctx || {};
  if (!ipcMain) return;
  ipcMain.removeHandler('evidence-ledger:create-incident');
  ipcMain.removeHandler('evidence-ledger:add-assertion');
  ipcMain.removeHandler('evidence-ledger:bind-evidence');
  ipcMain.removeHandler('evidence-ledger:record-verdict');
  ipcMain.removeHandler('evidence-ledger:get-summary');
  ipcMain.removeHandler('evidence-ledger:list-incidents');
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
