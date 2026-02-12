const path = require('path');
const { fork } = require('child_process');
const log = require('./logger');

const WORKER_PATH = path.join(__dirname, 'comms-worker.js');
const REQUEST_TIMEOUT_MS = 15000;
const STOP_TIMEOUT_MS = 2000;

let workerProcess = null;
let requestCounter = 0;
let running = false;
let cachedPort = null;
let cachedClients = [];
const cachedHealthByTarget = new Map();
const pendingRequests = new Map();
let onMessageHandler = null;

function nextRequestId() {
  requestCounter += 1;
  return `comms-${Date.now()}-${requestCounter}`;
}

function clearPendingRequest(reqId) {
  const entry = pendingRequests.get(reqId);
  if (!entry) return null;
  pendingRequests.delete(reqId);
  clearTimeout(entry.timer);
  return entry;
}

function rejectAllPending(err) {
  for (const [reqId] of pendingRequests) {
    const entry = clearPendingRequest(reqId);
    if (entry) entry.reject(err);
  }
}

function ensureWorker() {
  if (workerProcess && workerProcess.connected) {
    return workerProcess;
  }

  const worker = fork(WORKER_PATH, [], {
    env: {
      ...process.env,
      HIVEMIND_COMMS_WORKER: '1',
    },
  });

  worker.on('message', (msg) => {
    handleWorkerMessage(worker, msg).catch((err) => {
      log.error('CommsWorker', `Failed handling worker message: ${err.message}`);
    });
  });

  worker.on('error', (err) => {
    log.error('CommsWorker', `Worker process error: ${err.message}`);
  });

  worker.on('exit', (code, signal) => {
    const intentional = worker.__hivemindIntentionalStop === true;
    if (workerProcess === worker) {
      workerProcess = null;
    }
    running = false;
    cachedPort = null;
    cachedClients = [];
    cachedHealthByTarget.clear();
    rejectAllPending(new Error(`comms worker exited (code=${code}, signal=${signal || 'none'})`));
    if (intentional) {
      log.info('CommsWorker', `Worker stopped (${signal || code || 'exit'})`);
    } else {
      log.error('CommsWorker', `Worker exited unexpectedly (code=${code}, signal=${signal || 'none'})`);
    }
  });

  workerProcess = worker;
  return workerProcess;
}

function sendRequest(action, payload = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const worker = ensureWorker();

  return new Promise((resolve, reject) => {
    const reqId = nextRequestId();
    const timer = setTimeout(() => {
      const entry = clearPendingRequest(reqId);
      if (!entry) return;
      entry.reject(new Error(`comms worker timeout (${action})`));
    }, timeoutMs);

    pendingRequests.set(reqId, { resolve, reject, timer });

    try {
      worker.send({
        kind: 'request',
        reqId,
        action,
        payload,
      });
    } catch (err) {
      const entry = clearPendingRequest(reqId);
      if (entry) entry.reject(err);
    }
  });
}

async function handleWorkerMessage(worker, msg) {
  if (!msg || typeof msg !== 'object') return;

  if (msg.kind === 'response' && msg.reqId) {
    const entry = clearPendingRequest(msg.reqId);
    if (!entry) return;
    if (msg.ok) {
      entry.resolve(msg.result);
    } else {
      const err = new Error(msg.error || 'comms worker request failed');
      err.code = msg.code || 'COMMS_WORKER_ERROR';
      entry.reject(err);
    }
    return;
  }

  if (msg.kind !== 'callback' || !msg.reqId) return;

  if (msg.action === 'onMessage') {
    try {
      const result = (typeof onMessageHandler === 'function')
        ? await onMessageHandler(msg.payload?.data)
        : null;
      worker.send({
        kind: 'callback-response',
        reqId: msg.reqId,
        ok: true,
        result,
      });
    } catch (err) {
      worker.send({
        kind: 'callback-response',
        reqId: msg.reqId,
        ok: false,
        error: err.message,
        code: 'ON_MESSAGE_HANDLER_ERROR',
      });
    }
  }
}

async function start(options = {}) {
  onMessageHandler = typeof options.onMessage === 'function' ? options.onMessage : null;
  const result = await sendRequest('start', {
    options: {
      port: options.port,
      callbackTimeoutMs: options.callbackTimeoutMs,
    },
  });
  running = true;
  cachedPort = result?.port || null;
  return result;
}

async function stop() {
  const worker = workerProcess;
  if (!worker) {
    running = false;
    cachedPort = null;
    cachedClients = [];
    cachedHealthByTarget.clear();
    return;
  }

  worker.__hivemindIntentionalStop = true;
  let exitHandler = null;
  const exitPromise = new Promise((resolve) => {
    exitHandler = () => resolve();
    worker.once('exit', exitHandler);
  });

  try {
    await sendRequest('shutdown', {}, REQUEST_TIMEOUT_MS);
  } catch (err) {
    log.warn('CommsWorker', `Shutdown request failed: ${err.message}`);
  }

  const killTimer = setTimeout(() => {
    try {
      worker.kill();
    } catch {
      // Best effort kill.
    }
  }, STOP_TIMEOUT_MS);

  await exitPromise;
  clearTimeout(killTimer);
  running = false;
  cachedPort = null;
  cachedClients = [];
  cachedHealthByTarget.clear();
}

function isRunning() {
  return running;
}

function getPort() {
  return cachedPort;
}

function refreshClients() {
  if (!running || !workerProcess) return;
  sendRequest('getClients')
    .then((result) => {
      if (Array.isArray(result)) {
        cachedClients = result;
      }
    })
    .catch(() => {
      // Best effort only.
    });
}

function getClients() {
  refreshClients();
  return cachedClients;
}

function refreshRoutingHealth(target, staleAfterMs, now) {
  if (!running || !workerProcess) return;
  const cacheKey = `${String(target)}::${Number(staleAfterMs || 0)}::${Number(now || 0)}`;
  sendRequest('getRoutingHealth', { target, staleAfterMs, now })
    .then((result) => {
      cachedHealthByTarget.set(cacheKey, result);
    })
    .catch(() => {
      // Best effort only.
    });
}

function getRoutingHealth(target, staleAfterMs, now) {
  const cacheKey = `${String(target)}::${Number(staleAfterMs || 0)}::${Number(now || 0)}`;
  refreshRoutingHealth(target, staleAfterMs, now);
  return cachedHealthByTarget.get(cacheKey) || {
    healthy: false,
    status: 'unknown',
    role: null,
    paneId: null,
    lastSeen: null,
    ageMs: null,
    staleThresholdMs: Number(staleAfterMs) || null,
    heartbeatIntervalMs: null,
    source: null,
  };
}

async function sendToTarget(target, content, meta = {}) {
  if (!running || !workerProcess) return false;
  try {
    const result = await sendRequest('sendToTarget', { target, content, meta });
    return Boolean(result);
  } catch (err) {
    log.warn('CommsWorker', `sendToTarget failed: ${err.message}`);
    return false;
  }
}

async function sendToPane(paneId, content, meta = {}) {
  if (!running || !workerProcess) return false;
  try {
    const result = await sendRequest('sendToPane', { paneId, content, meta });
    return Boolean(result);
  } catch (err) {
    log.warn('CommsWorker', `sendToPane failed: ${err.message}`);
    return false;
  }
}

async function broadcast(content, options = {}) {
  if (!running || !workerProcess) return 0;
  try {
    const result = await sendRequest('broadcast', { content, options });
    const count = Number(result);
    return Number.isFinite(count) ? count : 0;
  } catch (err) {
    log.warn('CommsWorker', `broadcast failed: ${err.message}`);
    return 0;
  }
}

async function resetForTests() {
  await stop();
  workerProcess = null;
  requestCounter = 0;
  onMessageHandler = null;
  running = false;
  cachedPort = null;
  cachedClients = [];
  cachedHealthByTarget.clear();
  rejectAllPending(new Error('reset'));
}

module.exports = {
  start,
  stop,
  isRunning,
  getPort,
  getClients,
  getRoutingHealth,
  sendToTarget,
  sendToPane,
  broadcast,
  resetForTests,
};
