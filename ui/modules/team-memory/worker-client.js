const path = require('path');
const { fork } = require('child_process');
const log = require('../logger');

const WORKER_PATH = path.join(__dirname, 'worker.js');
const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_CLOSE_TIMEOUT_MS = 2000;

let workerProcess = null;
let requestCounter = 0;
const pendingRequests = new Map();

function nextRequestId() {
  requestCounter += 1;
  return `team-memory-${Date.now()}-${requestCounter}`;
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

function handleWorkerMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type !== 'response' || !msg.reqId) return;

  const entry = clearPendingRequest(msg.reqId);
  if (!entry) return;

  if (msg.ok) {
    entry.resolve(msg.result);
    return;
  }

  const err = new Error(msg.error || 'team-memory worker request failed');
  err.code = msg.code || 'TEAM_MEMORY_WORKER_ERROR';
  entry.reject(err);
}

function attachWorkerListeners(worker) {
  worker.on('message', handleWorkerMessage);

  worker.on('error', (err) => {
    log.error('TeamMemoryWorker', `Worker process error: ${err.message}`);
  });

  worker.on('exit', (code, signal) => {
    const intentional = worker.__squidrunIntentionalStop === true;
    if (workerProcess === worker) {
      workerProcess = null;
    }
    rejectAllPending(new Error(`team-memory worker exited (code=${code}, signal=${signal || 'none'})`));

    if (intentional) {
      log.info('TeamMemoryWorker', `Worker stopped (${signal || code || 'exit'})`);
    } else {
      log.error('TeamMemoryWorker', `Worker exited unexpectedly (code=${code}, signal=${signal || 'none'})`);
    }
  });
}

function ensureWorkerProcess() {
  if (workerProcess && workerProcess.connected) {
    return workerProcess;
  }

  const worker = fork(WORKER_PATH, [], {
    env: {
      ...process.env,
      HIVEMIND_TEAM_MEMORY_WORKER: '1',
    },
  });
  attachWorkerListeners(worker);
  workerProcess = worker;
  return workerProcess;
}

function sendRequestWithWorker(worker, type, payload = {}, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
  if (!worker || typeof worker.send !== 'function') {
    return Promise.reject(new Error('team-memory worker unavailable'));
  }

  return new Promise((resolve, reject) => {
    const reqId = nextRequestId();
    const timer = setTimeout(() => {
      const entry = clearPendingRequest(reqId);
      if (!entry) return;
      const timeoutError = new Error(`team-memory worker timeout (${type})`);
      timeoutError.code = 'TEAM_MEMORY_WORKER_TIMEOUT';
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
  const worker = workerProcess;
  if (!worker) return;

  worker.__squidrunIntentionalStop = true;
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
  await closeRuntime({ killTimeoutMs: 100 });
  workerProcess = null;
  requestCounter = 0;
}

module.exports = {
  initializeRuntime,
  executeOperation,
  closeRuntime,
  resetForTests,
};
