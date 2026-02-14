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

const log = require('../logger');
const workerClient = require('./evidence-ledger-worker-client');
const runtime = require('./evidence-ledger-runtime');

const EVIDENCE_LEDGER_CHANNEL_ACTIONS = new Map([
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

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function shouldUseWorker(options = {}) {
  const opts = asObject(options);
  const deps = asObject(opts.deps);

  if (process.env.HIVEMIND_EVIDENCE_LEDGER_FORCE_IN_PROCESS === '1') {
    return false;
  }
  if (opts.useWorker === false || deps.useWorker === false) {
    return false;
  }
  // Tests inject non-serializable runtime factories via deps.
  if (typeof deps.createEvidenceLedgerRuntime === 'function') {
    return false;
  }
  return true;
}

function extractWorkerOptions(options = {}) {
  const opts = asObject(options);
  const deps = asObject(opts.deps);
  return {
    runtimeOptions: opts.runtimeOptions || deps.runtimeOptions,
    forceRuntimeRecreate: opts.forceRuntimeRecreate === true || deps.forceRuntimeRecreate === true,
    recreateUnavailable: opts.recreateUnavailable !== false && deps.recreateUnavailable !== false,
  };
}

async function initializeEvidenceLedgerRuntime(options = {}) {
  if (!shouldUseWorker(options)) {
    return runtime.initializeEvidenceLedgerRuntime(options);
  }

  try {
    return await workerClient.initializeRuntime(extractWorkerOptions(options));
  } catch (err) {
    log.warn('EvidenceLedger', `Worker init failed, degraded to unavailable: ${err.message}`);
    return {
      ok: false,
      initResult: {
        ok: false,
        reason: 'worker_error',
        error: err.message,
      },
      seedResult: null,
      status: {
        driver: 'worker',
        degradedReason: err.message,
      },
    };
  }
}

async function executeEvidenceLedgerOperation(action, payload = {}, options = {}) {
  if (!shouldUseWorker(options)) {
    return runtime.executeEvidenceLedgerOperation(action, payload, options);
  }

  try {
    return await workerClient.executeOperation(action, payload, {
      ...extractWorkerOptions(options),
      source: asObject(options.source),
    });
  } catch (err) {
    return {
      ok: false,
      reason: 'worker_error',
      error: err.message,
      action: String(action || '').toLowerCase() || action || null,
    };
  }
}

function closeSharedRuntime(options = {}) {
  runtime.closeSharedRuntime();

  workerClient.closeRuntime({
    killTimeoutMs: asObject(options).killTimeoutMs,
  }).catch((err) => {
    log.warn('EvidenceLedger', `Worker close failed: ${err.message}`);
  });
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

  for (const [channel, action] of EVIDENCE_LEDGER_CHANNEL_ACTIONS.entries()) {
    ipcMain.handle(channel, (event, payload = {}) => execute(action, payload));
  }
}

function unregisterEvidenceLedgerHandlers(ctx) {
  const deps = arguments.length > 1 ? arguments[1] : {};
  const { ipcMain } = ctx || {};
  if (!ipcMain) return;

  for (const channel of EVIDENCE_LEDGER_CHANNEL_ACTIONS.keys()) {
    ipcMain.removeHandler(channel);
  }
  const isReregister = asObject(deps).__hivemindHandlerReregister === true;
  if (!isReregister) {
    closeSharedRuntime();
  }
}

registerEvidenceLedgerHandlers.unregister = unregisterEvidenceLedgerHandlers;

module.exports = {
  registerEvidenceLedgerHandlers,
  unregisterEvidenceLedgerHandlers,
  createEvidenceLedgerRuntime: runtime.createEvidenceLedgerRuntime,
  initializeEvidenceLedgerRuntime,
  executeEvidenceLedgerOperation,
  closeSharedRuntime,
};
