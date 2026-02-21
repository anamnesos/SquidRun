const path = require('path');
const { fork } = require('child_process');
const log = require('./logger');

const WORKER_PATH = path.join(__dirname, 'comms-worker.js');
const REQUEST_TIMEOUT_MS = 15000;
const STOP_TIMEOUT_MS = 2000;
const RESTART_BASE_DELAY_MS = Number.parseInt(process.env.SQUIDRUN_COMMS_WORKER_RESTART_BASE_MS || '500', 10);
const RESTART_MAX_DELAY_MS = Number.parseInt(process.env.SQUIDRUN_COMMS_WORKER_RESTART_MAX_MS || '10000', 10);

let workerProcess = null;
let requestCounter = 0;
let running = false;
let desiredRunning = false;
let cachedPort = null;
let cachedClients = [];
const pendingRequests = new Map();
let onMessageHandler = null;
let lastStartOptions = null;
let restartTimer = null;
let restartAttempt = 0;
let restartInFlightPromise = null;
let startInFlightPromise = null;

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

function parsePositiveInt(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function getRestartDelayMs(attempt) {
  const base = parsePositiveInt(RESTART_BASE_DELAY_MS, 500);
  const max = parsePositiveInt(RESTART_MAX_DELAY_MS, 10000);
  const exponent = Math.max(0, Number(attempt || 1) - 1);
  return Math.min(max, base * Math.pow(2, exponent));
}

function clearRestartTimer() {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
}

async function performRestart(attempt, reason = 'unexpected_exit') {
  if (!desiredRunning) return false;
  if (running && workerProcess) return true;

  const options = lastStartOptions || {};
  try {
    const result = await sendRequest('start', {
      options: {
        port: options.port,
        callbackTimeoutMs: options.callbackTimeoutMs,
        sessionScopeId: options.sessionScopeId,
      },
    });
    running = true;
    cachedPort = result?.port || cachedPort || null;
    restartAttempt = 0;
    log.info('CommsWorker', `Recovery restart succeeded (attempt ${attempt}, reason=${reason})`);
    return true;
  } catch (err) {
    running = false;
    cachedPort = null;
    cachedClients = [];
    log.warn('CommsWorker', `Recovery restart failed (attempt ${attempt}, reason=${reason}): ${err.message}`);
    return false;
  }
}

function scheduleRestart(reason = 'unexpected_exit') {
  if (!desiredRunning) return;
  if (restartTimer || restartInFlightPromise || startInFlightPromise) return;

  restartAttempt += 1;
  const attempt = restartAttempt;
  const delayMs = getRestartDelayMs(attempt);
  log.warn('CommsWorker', `Scheduling restart attempt ${attempt} in ${delayMs}ms (${reason})`);

  restartTimer = setTimeout(() => {
    restartTimer = null;
    restartInFlightPromise = performRestart(attempt, reason)
      .then((ok) => {
        if (!ok && desiredRunning) {
          scheduleRestart('retry_after_failure');
        }
      })
      .finally(() => {
        restartInFlightPromise = null;
      });
  }, delayMs);
}

async function ensureRunning(reason = 'request') {
  if (!desiredRunning) return false;
  if (running && workerProcess) return true;
  if (startInFlightPromise) {
    try {
      await startInFlightPromise;
      return true;
    } catch {
      return false;
    }
  }
  if (restartInFlightPromise) {
    return Boolean(await restartInFlightPromise);
  }

  clearRestartTimer();
  const attempt = Math.max(1, restartAttempt + 1);
  restartInFlightPromise = performRestart(attempt, reason)
    .then((ok) => {
      if (!ok && desiredRunning) {
        scheduleRestart('ensure_running_failed');
      }
      return ok;
    })
    .finally(() => {
      restartInFlightPromise = null;
    });
  return Boolean(await restartInFlightPromise);
}

function ensureWorker() {
  if (workerProcess && workerProcess.connected) {
    return workerProcess;
  }

  const worker = fork(WORKER_PATH, [], {
    env: {
      ...process.env,
      SQUIDRUN_COMMS_WORKER: '1',
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
    const intentional = worker.__squidrunIntentionalStop === true;
    if (workerProcess === worker) {
      workerProcess = null;
    }
    running = false;
    cachedPort = null;
    cachedClients = [];
    rejectAllPending(new Error(`comms worker exited (code=${code}, signal=${signal || 'none'})`));
    if (intentional) {
      log.info('CommsWorker', `Worker stopped (${signal || code || 'exit'})`);
      clearRestartTimer();
    } else {
      log.error('CommsWorker', `Worker exited unexpectedly (code=${code}, signal=${signal || 'none'})`);
      scheduleRestart('worker_exit');
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
  lastStartOptions = {
    port: options.port,
    callbackTimeoutMs: options.callbackTimeoutMs,
    sessionScopeId: options.sessionScopeId,
  };
  desiredRunning = true;
  clearRestartTimer();
  restartAttempt = 0;
  if (running && workerProcess) {
    return { port: cachedPort };
  }
  if (startInFlightPromise) {
    return startInFlightPromise;
  }

  startInFlightPromise = (async () => {
    try {
      const result = await sendRequest('start', {
        options: {
          port: options.port,
          callbackTimeoutMs: options.callbackTimeoutMs,
          sessionScopeId: options.sessionScopeId,
        },
      });
      running = true;
      cachedPort = result?.port || null;
      return result;
    } catch (err) {
      desiredRunning = false;
      throw err;
    } finally {
      startInFlightPromise = null;
    }
  })();

  return startInFlightPromise;
}

async function stop() {
  desiredRunning = false;
  clearRestartTimer();
  restartAttempt = 0;
  restartInFlightPromise = null;
  const pendingStart = startInFlightPromise;
  if (pendingStart) {
    try {
      await pendingStart;
    } catch {
      // Ignore startup error; continue shutdown cleanup.
    }
  }
  startInFlightPromise = null;

  const worker = workerProcess;
  if (!worker) {
    running = false;
    cachedPort = null;
    cachedClients = [];
    return;
  }

  worker.__squidrunIntentionalStop = true;
  const exitPromise = new Promise((resolve) => {
    worker.once('exit', () => resolve());
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

async function sendToTarget(target, content, meta = {}) {
  if ((!running || !workerProcess) && desiredRunning) {
    await ensureRunning('sendToTarget');
  }
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
  if ((!running || !workerProcess) && desiredRunning) {
    await ensureRunning('sendToPane');
  }
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
  if ((!running || !workerProcess) && desiredRunning) {
    await ensureRunning('broadcast');
  }
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
  desiredRunning = false;
  lastStartOptions = null;
  cachedPort = null;
  cachedClients = [];
  clearRestartTimer();
  restartAttempt = 0;
  restartInFlightPromise = null;
  startInFlightPromise = null;
  rejectAllPending(new Error('reset'));
}

module.exports = {
  start,
  stop,
  isRunning,
  getPort,
  getClients,
  sendToTarget,
  sendToPane,
  broadcast,
  resetForTests,
};
