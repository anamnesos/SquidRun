const log = require('../logger');
const workerClient = require('./worker-client');
const runtime = require('./runtime');

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function shouldUseWorker(options = {}) {
  const opts = asObject(options);
  const deps = asObject(opts.deps);

  if (process.env.HIVEMIND_EXPERIMENT_FORCE_IN_PROCESS === '1') {
    return false;
  }
  if (opts.useWorker === false || deps.useWorker === false) {
    return false;
  }
  if (typeof deps.createExperimentRuntime === 'function') {
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

async function initializeExperimentRuntime(options = {}) {
  if (!shouldUseWorker(options)) {
    return runtime.initializeExperimentRuntime(options);
  }

  try {
    return await workerClient.initializeRuntime(extractWorkerOptions(options));
  } catch (err) {
    log.warn('Experiment', `Worker init failed, degraded to unavailable: ${err.message}`);
    return {
      ok: false,
      initResult: {
        ok: false,
        reason: 'worker_error',
        error: err.message,
      },
      status: {
        driver: 'worker',
        degradedReason: err.message,
      },
    };
  }
}

async function executeExperimentOperation(action, payload = {}, options = {}) {
  if (!shouldUseWorker(options)) {
    return runtime.executeExperimentOperation(action, payload, options);
  }

  try {
    return await workerClient.executeOperation(action, payload, extractWorkerOptions(options));
  } catch (err) {
    return {
      ok: false,
      reason: 'worker_error',
      error: err.message,
      action: String(action || '').toLowerCase() || action || null,
    };
  }
}

function closeExperimentRuntime(options = {}) {
  runtime.closeSharedRuntime();
  workerClient.closeRuntime({
    killTimeoutMs: asObject(options).killTimeoutMs,
  }).catch((err) => {
    log.warn('Experiment', `Worker close failed: ${err.message}`);
  });
}

module.exports = {
  initializeExperimentRuntime,
  executeExperimentOperation,
  closeExperimentRuntime,
  createExperimentRuntime: runtime.createExperimentRuntime,
};
