const fs = require('fs');
const path = require('path');
const log = require('../logger');
const { WORKSPACE_PATH } = require('../../config');
const workerClient = require('./worker-client');
const runtime = require('./runtime');
const { upsertIntegrityReport } = require('./integrity-checker');
const { DEFAULT_PATTERN_SPOOL_PATH } = require('./patterns');

const DEFAULT_ERRORS_PATH = path.join(WORKSPACE_PATH, 'build', 'errors.md');
const DEFAULT_INTEGRITY_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BELIEF_SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_PATTERN_MINING_INTERVAL_MS = 60 * 1000;
const DEFAULT_BELIEF_AGENTS = Object.freeze(['architect', 'devops', 'analyst']);

let integritySweepTimer = null;
let beliefSnapshotTimer = null;
let patternMiningTimer = null;

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
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
  return {
    runtimeOptions: opts.runtimeOptions || deps.runtimeOptions,
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
  const entry = {
    ...payload,
    timestamp: Number(payload.timestamp || Date.now()),
  };

  try {
    fs.mkdirSync(path.dirname(spoolPath), { recursive: true });
    await fs.promises.appendFile(spoolPath, `${JSON.stringify(entry)}\n`, 'utf-8');
    return {
      ok: true,
      queued: true,
      spoolPath,
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
  runtime.closeSharedRuntime();
  return workerClient.closeRuntime({
    killTimeoutMs: asObject(options).killTimeoutMs,
  });
}

async function resetForTests() {
  stopIntegritySweep();
  stopBeliefSnapshotSweep();
  stopPatternMiningSweep();
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
