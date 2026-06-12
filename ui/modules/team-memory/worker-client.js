const path = require('path');
const { fork } = require('child_process');
const log = require('../logger');
const { buildNodeWorkerForkOptions } = require('../node-worker-fork-options');

const WORKER_PATH = path.join(__dirname, 'worker.js');
const DEFAULT_REQUEST_TIMEOUT_MS = parsePositiveInt(
  Number.parseInt(process.env.SQUIDRUN_TEAM_MEMORY_WORKER_REQUEST_TIMEOUT_MS || '15000', 10),
  15000
);
const DEFAULT_CLOSE_TIMEOUT_MS = 2000;
const DEFAULT_IDLE_CLOSE_TIMEOUT_MS = parseNonNegativeInt(
  Number.parseInt(process.env.SQUIDRUN_TEAM_MEMORY_WORKER_IDLE_CLOSE_TIMEOUT_MS || '5000', 10),
  5000
);

let workerProcess = null;
let requestCounter = 0;
const pendingRequests = new Map();
let idleCloseTimer = null;
let idleClosePromise = null;

function parsePositiveInt(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function parseNonNegativeInt(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function nextRequestId() {
  requestCounter += 1;
  return `team-memory-${Date.now()}-${requestCounter}`;
}

function clearIdleCloseTimer() {
  if (!idleCloseTimer) return;
  clearTimeout(idleCloseTimer);
  idleCloseTimer = null;
}

function scheduleIdleClose(worker) {
  if (!worker || worker.__squidrunClosing === true || worker.__squidrunIntentionalStop === true) return;
  if (DEFAULT_IDLE_CLOSE_TIMEOUT_MS <= 0) return;
  if (workerProcess !== worker || pendingRequests.size > 0 || idleClosePromise) return;

  clearIdleCloseTimer();
  idleCloseTimer = setTimeout(() => {
    idleCloseTimer = null;
    if (workerProcess !== worker || pendingRequests.size > 0 || worker.__squidrunClosing === true) return;
    idleClosePromise = closeRuntime({
      killTimeoutMs: DEFAULT_CLOSE_TIMEOUT_MS,
      reason: 'idle',
    }).catch((err) => {
      log.warn('TeamMemoryWorker', `Idle close failed: ${err.message}`);
    }).finally(() => {
      idleClosePromise = null;
    });
  }, DEFAULT_IDLE_CLOSE_TIMEOUT_MS);
  if (typeof idleCloseTimer.unref === 'function') {
    idleCloseTimer.unref();
  }
}

function clearPendingRequest(reqId) {
  const entry = pendingRequests.get(reqId);
  if (!entry) return null;
  pendingRequests.delete(reqId);
  clearTimeout(entry.timer);
  return entry;
}

function rejectAllPending(error) {
  for (const [reqId] of pendingRequests) {
    const entry = clearPendingRequest(reqId);
    if (entry) entry.reject(error);
  }
}

function quarantineWorker(worker, reason = 'unresponsive') {
  if (!worker) return;
  clearIdleCloseTimer();
  if (workerProcess === worker) {
    workerProcess = null;
  }

  const err = new Error(`team-memory worker quarantined (${reason})`);
  err.code = 'TEAM_MEMORY_WORKER_QUARANTINED';
  rejectAllPending(err);

  worker.__squidrunIntentionalStop = true;
  try {
    if (typeof worker.kill === 'function') {
      worker.kill();
    }
  } catch (killErr) {
    log.warn('TeamMemoryWorker', `Failed to kill quarantined worker (${reason}): ${killErr.message}`);
  }
}

function drainWorkerStream(stream) {
  if (!stream) return;
  if (typeof stream.resume === 'function') {
    stream.resume();
    return;
  }
  if (typeof stream.on === 'function') {
    stream.on('data', () => {});
  }
}

function handleWorkerMessage(worker, msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type !== 'response' || !msg.reqId) return;

  const entry = clearPendingRequest(msg.reqId);
  if (!entry) return;

  if (msg.ok) {
    entry.resolve(msg.result);
    if (pendingRequests.size === 0) {
      scheduleIdleClose(worker);
    }
    return;
  }

  const err = new Error(msg.error || 'team-memory worker request failed');
  err.code = msg.code || 'TEAM_MEMORY_WORKER_ERROR';
  entry.reject(err);
  if (pendingRequests.size === 0) {
    scheduleIdleClose(worker);
  }
}

function attachWorkerListeners(worker) {
  // Packaged GUI parents do not provide reliable inherited stdio handles.
  // Keep the worker pipes drained so child logging cannot break the process.
  drainWorkerStream(worker.stdout);
  drainWorkerStream(worker.stderr);

  worker.on('message', (msg) => handleWorkerMessage(worker, msg));

  worker.on('error', (err) => {
    log.error('TeamMemoryWorker', `Worker process error: ${err.message}`);
  });

  worker.on('exit', (code, signal) => {
    const intentional = worker.__squidrunIntentionalStop === true;
    const wasCurrentWorker = workerProcess === worker;
    if (wasCurrentWorker) {
      workerProcess = null;
      rejectAllPending(new Error(`team-memory worker exited (code=${code}, signal=${signal || 'none'})`));
    }

    if (intentional) {
      log.info('TeamMemoryWorker', `Worker stopped (${signal || code || 'exit'})`);
    } else {
      log.error('TeamMemoryWorker', `Worker exited unexpectedly (code=${code}, signal=${signal || 'none'})`);
    }
  });
}

function ensureWorkerProcess() {
  if (workerProcess && workerProcess.connected && workerProcess.__squidrunClosing !== true) {
    return workerProcess;
  }

  clearIdleCloseTimer();
  const worker = fork(WORKER_PATH, [], buildNodeWorkerForkOptions({
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: {
      ...process.env,
      SQUIDRUN_TEAM_MEMORY_WORKER: '1',
    },
  }));
  attachWorkerListeners(worker);
  workerProcess = worker;
  return workerProcess;
}

function sendRequestWithWorker(worker, type, payload = {}, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
  if (!worker || typeof worker.send !== 'function') {
    return Promise.reject(new Error('team-memory worker unavailable'));
  }

  clearIdleCloseTimer();
  return new Promise((resolve, reject) => {
    const reqId = nextRequestId();
    const timer = setTimeout(() => {
      const entry = clearPendingRequest(reqId);
      if (!entry) return;
      const timeoutError = new Error(`team-memory worker timeout (${type})`);
      timeoutError.code = 'TEAM_MEMORY_WORKER_TIMEOUT';
      quarantineWorker(worker, `timeout:${type}`);
      entry.reject(timeoutError);
    }, timeoutMs);

    pendingRequests.set(reqId, { resolve, reject, timer });

    try {
      worker.send({
        type,
        reqId,
        ...payload,
      });
    } catch (err) {
      const entry = clearPendingRequest(reqId);
      quarantineWorker(worker, `send_failed:${type}`);
      if (entry) entry.reject(err);
    }
  });
}

function sendRequest(type, payload = {}, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
  const worker = ensureWorkerProcess();
  return sendRequestWithWorker(worker, type, payload, timeoutMs);
}

async function initializeRuntime(options = {}) {
  return sendRequest('init', { options });
}

async function executeOperation(action, payload = {}, options = {}) {
  return sendRequest('op', { action, payload, options });
}

async function closeRuntime(options = {}) {
  clearIdleCloseTimer();
  const worker = workerProcess;
  if (!worker) return;

  worker.__squidrunIntentionalStop = true;
  worker.__squidrunClosing = true;
  if (workerProcess === worker) {
    workerProcess = null;
  }
  const killTimeoutMs = Number(options.killTimeoutMs) || DEFAULT_CLOSE_TIMEOUT_MS;
  let exitHandler = null;
  const exitPromise = new Promise((resolve) => {
    exitHandler = () => resolve();
    worker.once('exit', exitHandler);
  });

  try {
    await sendRequestWithWorker(worker, 'close', {}, Math.min(killTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS));
  } catch (err) {
    log.warn('TeamMemoryWorker', `Close request failed: ${err.message}`);
  }

  const timeout = setTimeout(() => {
    try {
      worker.kill();
    } catch {
      // Best effort kill.
    }
  }, killTimeoutMs);

  await exitPromise;
  clearTimeout(timeout);
}

async function resetForTests() {
  clearIdleCloseTimer();
  await closeRuntime({ killTimeoutMs: 100 });
  workerProcess = null;
  requestCounter = 0;
  idleClosePromise = null;
}

module.exports = {
  initializeRuntime,
  executeOperation,
  closeRuntime,
  resetForTests,
};
