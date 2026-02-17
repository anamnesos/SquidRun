const fs = require('fs');
const path = require('path');
const log = require('../logger');
const { WORKSPACE_PATH, resolveCoordPath } = require('../../config');
const workerClient = require('./worker-client');
const runtime = require('./runtime');
const { EvidenceLedgerStore } = require('../main/evidence-ledger-store');
const { upsertIntegrityReport } = require('./integrity-checker');
const { DEFAULT_PATTERN_SPOOL_PATH } = require('./patterns');

function resolveDefaultErrorsPath() {
  if (typeof resolveCoordPath === 'function') {
    return resolveCoordPath(path.join('build', 'errors.md'), { forWrite: true });
  }
  return path.join(WORKSPACE_PATH, 'build', 'errors.md');
}

function resolveDefaultEvidenceLedgerDbPath() {
  if (typeof resolveCoordPath === 'function') {
    return resolveCoordPath(path.join('runtime', 'evidence-ledger.db'), { forWrite: true });
  }
  return path.join(WORKSPACE_PATH, 'runtime', 'evidence-ledger.db');
}

function resolveDefaultTeamMemoryDbPath() {
  if (typeof resolveCoordPath === 'function') {
    return resolveCoordPath(path.join('runtime', 'team-memory.sqlite'), { forWrite: true });
  }
  return path.join(WORKSPACE_PATH, 'runtime', 'team-memory.sqlite');
}

function resolveDefaultPatternSpoolPath() {
  if (typeof resolveCoordPath === 'function') {
    return resolveCoordPath(path.join('runtime', 'team-memory-pattern-spool.jsonl'), { forWrite: true });
  }
  return DEFAULT_PATTERN_SPOOL_PATH;
}

const DEFAULT_ERRORS_PATH = resolveDefaultErrorsPath();
const DEFAULT_INTEGRITY_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BELIEF_SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_PATTERN_MINING_INTERVAL_MS = 60 * 1000;
const DEFAULT_BELIEF_AGENTS = Object.freeze(['architect', 'builder', 'oracle']);
const DEFAULT_EVIDENCE_LEDGER_DB_PATH = resolveDefaultEvidenceLedgerDbPath();

let integritySweepTimer = null;
let beliefSnapshotTimer = null;
let patternMiningTimer = null;
let patternHookLedgerStore = null;
let patternHookLedgerStorePath = null;

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function asString(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function asFiniteNumber(value, fallback = null) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return numeric;
}

function normalizePatternHookRole(entry = {}) {
  const role = asString(entry.actor || entry.owner || entry.by || entry.role || '', '').toLowerCase();
  if (role === 'infra' || role === 'backend' || role === 'devops') return 'builder';
  if (role === 'arch') return 'architect';
  if (role === 'ana' || role === 'analyst') return 'oracle';
  return role || 'system';
}

function normalizePatternHookPane(entry = {}) {
  const paneId = asString(String(entry.paneId || entry.pane_id || ''), '');
  if (paneId) return paneId;

  const role = normalizePatternHookRole(entry);
  if (role === 'architect') return '1';
  if (role === 'builder') return '2';
  if (role === 'oracle') return '5';
  return 'system';
}

function normalizePatternHookEventType(entry = {}) {
  const eventType = asString(entry.eventType || entry.type || '', '').toLowerCase();
  return eventType || 'team-memory.pattern-hook';
}

function toPatternHookEnvelope(entry = {}, nowMs = Date.now()) {
  const eventType = normalizePatternHookEventType(entry);
  const ts = asFiniteNumber(entry.timestamp, null);
  const traceHint = asString(entry.traceId || entry.trace_id || entry.correlationId || entry.correlation_id || '', '');

  return {
    eventId: asString(entry.eventId || entry.event_id || '', ''),
    traceId: traceHint || `tm-pattern-${eventType}-${Math.floor(nowMs)}`,
    parentEventId: asString(entry.parentEventId || entry.parent_event_id || entry.causationId || entry.causation_id || '', '') || null,
    correlationId: traceHint || null,
    causationId: asString(entry.causationId || entry.causation_id || '', '') || null,
    type: eventType,
    stage: asString(entry.stage || '', 'team_memory'),
    source: asString(entry.source || '', 'team-memory.pattern-hook'),
    paneId: normalizePatternHookPane(entry),
    role: normalizePatternHookRole(entry),
    ts: Number.isFinite(ts) && ts > 0 ? Math.floor(ts) : Math.floor(nowMs),
    direction: asString(entry.direction || '', 'internal'),
    payload: entry,
    evidenceRefs: Array.isArray(entry.evidenceRefs) ? entry.evidenceRefs : [],
    meta: {
      ingestSource: 'team-memory-pattern-hook',
      spoolMirrored: true,
      eventType,
    },
  };
}

function getPatternHookLedgerStore(options = {}) {
  if (options.useLedger === false) return null;
  const dbPath = asString(options.evidenceLedgerDbPath, DEFAULT_EVIDENCE_LEDGER_DB_PATH);
  const shouldRecreate = !patternHookLedgerStore
    || !patternHookLedgerStore.isAvailable()
    || patternHookLedgerStorePath !== dbPath;

  if (!shouldRecreate) return patternHookLedgerStore;

  try {
    if (patternHookLedgerStore) {
      patternHookLedgerStore.close();
    }
  } catch {
    // best effort
  }

  const store = new EvidenceLedgerStore({
    dbPath,
    enabled: true,
  });
  const init = store.init();
  if (!init.ok) {
    try { store.close(); } catch {}
    patternHookLedgerStore = null;
    patternHookLedgerStorePath = null;
    log.warn('TeamMemory', `Pattern hook ledger unavailable: ${init.reason || 'unknown'}`);
    return null;
  }

  patternHookLedgerStore = store;
  patternHookLedgerStorePath = dbPath;
  return patternHookLedgerStore;
}

function closePatternHookLedgerStore() {
  if (!patternHookLedgerStore) return;
  try {
    patternHookLedgerStore.close();
  } catch {
    // best effort
  }
  patternHookLedgerStore = null;
  patternHookLedgerStorePath = null;
}

function shouldUseWorker(options = {}) {
  const opts = asObject(options);
  const deps = asObject(opts.deps);

  if (process.env.HIVEMIND_TEAM_MEMORY_FORCE_IN_PROCESS === '1') {
    return false;
  }
  if (opts.useWorker === false || deps.useWorker === false) {
    return false;
  }
  if (typeof deps.createTeamMemoryRuntime === 'function') {
    return false;
  }
  return true;
}

function extractRuntimeOptions(options = {}) {
  const opts = asObject(options);
  const deps = asObject(opts.deps);
  const runtimeOptions = asObject(opts.runtimeOptions || deps.runtimeOptions);
  const storeOptions = asObject(runtimeOptions.storeOptions);
  const patternOptions = asObject(runtimeOptions.patternOptions);

  if (!storeOptions.dbPath) {
    storeOptions.dbPath = resolveDefaultTeamMemoryDbPath();
  }
  if (!patternOptions.spoolPath) {
    patternOptions.spoolPath = resolveDefaultPatternSpoolPath();
  }

  return {
    runtimeOptions: {
      ...runtimeOptions,
      storeOptions,
      patternOptions,
    },
    forceRuntimeRecreate: opts.forceRuntimeRecreate === true || deps.forceRuntimeRecreate === true,
    recreateUnavailable: opts.recreateUnavailable !== false && deps.recreateUnavailable !== false,
  };
}

async function initializeTeamMemoryRuntime(options = {}) {
  if (!shouldUseWorker(options)) {
    return runtime.initializeTeamMemoryRuntime(options);
  }
  return workerClient.initializeRuntime(extractRuntimeOptions(options));
}

async function executeTeamMemoryOperation(action, payload = {}, options = {}) {
  const opPayload = asObject(payload);
  if (!shouldUseWorker(options)) {
    return runtime.executeTeamMemoryOperation(action, opPayload, options);
  }
  return workerClient.executeOperation(action, opPayload, extractRuntimeOptions(options));
}

async function runBackfill(options = {}) {
  const payload = asObject(options.payload);
  return executeTeamMemoryOperation('run-backfill', payload, options);
}

async function runIntegrityCheck(options = {}) {
  const payload = asObject(options.payload);
  const result = await executeTeamMemoryOperation('run-integrity-check', payload, options);

  if (!result || result.ok === false) {
    return result;
  }

  const reportResult = upsertIntegrityReport(result, {
    errorsPath: options.errorsPath || DEFAULT_ERRORS_PATH,
    nowIso: options.nowIso,
  });

  return {
    ...result,
    report: reportResult,
  };
}

function startIntegritySweep(options = {}) {
  stopIntegritySweep();

  const intervalMsRaw = Number(options.intervalMs);
  const intervalMs = Number.isFinite(intervalMsRaw) && intervalMsRaw > 0
    ? Math.floor(intervalMsRaw)
    : DEFAULT_INTEGRITY_SWEEP_INTERVAL_MS;

  const runCheck = async () => {
    try {
      const result = await runIntegrityCheck(options);
      if (result?.ok === false) {
        log.warn('TeamMemory', `Integrity scan unavailable: ${result.reason || 'unknown'}`);
      } else if (Number(result?.orphanCount || 0) > 0) {
        log.warn('TeamMemory', `Integrity scan found ${result.orphanCount} orphan evidence_ref row(s)`);
      }
    } catch (err) {
      log.warn('TeamMemory', `Integrity scan failed: ${err.message}`);
    }
  };

  if (options.immediate !== false) {
    runCheck();
  }

  integritySweepTimer = setInterval(runCheck, intervalMs);
  if (typeof integritySweepTimer.unref === 'function') {
    integritySweepTimer.unref();
  }
}

function stopIntegritySweep() {
  if (!integritySweepTimer) return;
  clearInterval(integritySweepTimer);
  integritySweepTimer = null;
}

function isIntegritySweepRunning() {
  return Boolean(integritySweepTimer);
}

function startBeliefSnapshotSweep(options = {}) {
  stopBeliefSnapshotSweep();

  const intervalMsRaw = Number(options.intervalMs);
  const intervalMs = Number.isFinite(intervalMsRaw) && intervalMsRaw > 0
    ? Math.floor(intervalMsRaw)
    : DEFAULT_BELIEF_SNAPSHOT_INTERVAL_MS;

  const agents = Array.isArray(options.agents) && options.agents.length > 0
    ? options.agents
    : [...DEFAULT_BELIEF_AGENTS];

  const runSnapshots = async () => {
    for (const agent of agents) {
      try {
        const result = await executeTeamMemoryOperation('create-belief-snapshot', {
          agent,
          session: options.session || null,
          maxBeliefs: options.maxBeliefs,
        }, options);
        if (result?.ok === false) {
          log.warn('TeamMemory', `Belief snapshot unavailable for ${agent}: ${result.reason || 'unknown'}`);
          continue;
        }
        const contradictionCount = Number(result?.contradictions?.count || 0);
        if (contradictionCount > 0) {
          log.warn('TeamMemory', `Belief snapshot for ${agent} found ${contradictionCount} contradiction(s)`);
        }
      } catch (err) {
        log.warn('TeamMemory', `Belief snapshot failed for ${agent}: ${err.message}`);
      }
    }
  };

  if (options.immediate !== false) {
    runSnapshots();
  }

  beliefSnapshotTimer = setInterval(runSnapshots, intervalMs);
  if (typeof beliefSnapshotTimer.unref === 'function') {
    beliefSnapshotTimer.unref();
  }
}

function stopBeliefSnapshotSweep() {
  if (!beliefSnapshotTimer) return;
  clearInterval(beliefSnapshotTimer);
  beliefSnapshotTimer = null;
}

function isBeliefSnapshotSweepRunning() {
  return Boolean(beliefSnapshotTimer);
}

async function appendPatternHookEvent(event = {}, options = {}) {
  const payload = asObject(event);
  const spoolPath = options.spoolPath || DEFAULT_PATTERN_SPOOL_PATH;
  const nowMs = Date.now();
  const entry = {
    ...payload,
    timestamp: Number(payload.timestamp || nowMs),
  };

  try {
    fs.mkdirSync(path.dirname(spoolPath), { recursive: true });
    await fs.promises.appendFile(spoolPath, `${JSON.stringify(entry)}\n`, 'utf-8');

    let ledger = { ok: false, status: 'skipped' };
    const ledgerStore = getPatternHookLedgerStore(options);
    if (ledgerStore) {
      const appendResult = ledgerStore.appendEvent(toPatternHookEnvelope(entry, nowMs), {
        nowMs,
      });
      ledger = {
        ok: appendResult.ok === true,
        status: appendResult.status || (appendResult.ok ? 'inserted' : 'failed'),
        eventId: appendResult.eventId || null,
        traceId: appendResult.traceId || null,
        reason: appendResult.reason || null,
        errors: appendResult.errors || null,
      };
      if (appendResult.ok !== true) {
        log.warn('TeamMemory', `Pattern hook ledger append failed: ${appendResult.reason || appendResult.status || 'unknown'}`);
      }
    }

    return {
      ok: true,
      queued: true,
      spoolPath,
      ledger,
    };
  } catch (err) {
    return {
      ok: false,
      reason: 'spool_write_failed',
      error: err.message,
      spoolPath,
    };
  }
}

function startPatternMiningSweep(options = {}) {
  stopPatternMiningSweep();

  const intervalMsRaw = Number(options.intervalMs);
  const intervalMs = Number.isFinite(intervalMsRaw) && intervalMsRaw > 0
    ? Math.floor(intervalMsRaw)
    : DEFAULT_PATTERN_MINING_INTERVAL_MS;
  const spoolPath = options.spoolPath || DEFAULT_PATTERN_SPOOL_PATH;

  const runMining = async () => {
    try {
      const result = await executeTeamMemoryOperation('process-pattern-spool', {
        spoolPath,
      }, options);
      if (result?.ok === false) {
        log.warn('TeamMemory', `Pattern mining unavailable: ${result.reason || 'unknown'}`);
      } else if (Number(result?.detectedPatterns || 0) > 0) {
        log.info(
          'TeamMemory',
          `Pattern mining detected ${result.detectedPatterns} pattern(s) from ${result.processedEvents || 0} event(s)`
        );
      }

      const guardActions = Array.isArray(result?.guardActions) ? result.guardActions : [];
      if (guardActions.length > 0) {
        for (const action of guardActions) {
          const level = String(action?.level || '').toLowerCase();
          const message = String(action?.message || 'Guard action fired');
          if (level === 'error') {
            log.error('TeamMemoryGuard', message);
          } else if (level === 'warn') {
            log.warn('TeamMemoryGuard', message);
          } else {
            log.info('TeamMemoryGuard', message);
          }
          if (typeof options.onGuardAction === 'function') {
            try {
              options.onGuardAction(action);
            } catch (callbackError) {
              log.warn('TeamMemory', `Guard action callback failed: ${callbackError.message}`);
            }
          }
        }
      }
    } catch (err) {
      log.warn('TeamMemory', `Pattern mining failed: ${err.message}`);
    }
  };

  if (options.immediate !== false) {
    runMining();
  }

  patternMiningTimer = setInterval(runMining, intervalMs);
  if (typeof patternMiningTimer.unref === 'function') {
    patternMiningTimer.unref();
  }
}

function stopPatternMiningSweep() {
  if (!patternMiningTimer) return;
  clearInterval(patternMiningTimer);
  patternMiningTimer = null;
}

function isPatternMiningSweepRunning() {
  return Boolean(patternMiningTimer);
}

function closeTeamMemoryRuntime(options = {}) {
  stopIntegritySweep();
  stopBeliefSnapshotSweep();
  stopPatternMiningSweep();
  closePatternHookLedgerStore();
  runtime.closeSharedRuntime();
  return workerClient.closeRuntime({
    killTimeoutMs: asObject(options).killTimeoutMs,
  });
}

async function resetForTests() {
  stopIntegritySweep();
  stopBeliefSnapshotSweep();
  stopPatternMiningSweep();
  closePatternHookLedgerStore();
  runtime.closeSharedRuntime();
  await workerClient.resetForTests();
}

module.exports = {
  initializeTeamMemoryRuntime,
  executeTeamMemoryOperation,
  runBackfill,
  runIntegrityCheck,
  startIntegritySweep,
  stopIntegritySweep,
  isIntegritySweepRunning,
  startBeliefSnapshotSweep,
  stopBeliefSnapshotSweep,
  isBeliefSnapshotSweepRunning,
  appendPatternHookEvent,
  startPatternMiningSweep,
  stopPatternMiningSweep,
  isPatternMiningSweepRunning,
  closeTeamMemoryRuntime,
  resetForTests,
};
