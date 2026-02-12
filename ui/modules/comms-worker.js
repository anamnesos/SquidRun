/**
 * Comms worker process.
 * Owns WebSocket I/O, protocol handling, heartbeat/ACK bookkeeping off main thread.
 */

const log = require('./logger');
const websocketRuntime = require('./websocket-runtime');

const DEFAULT_PARENT_CALLBACK_TIMEOUT_MS = 15000;
let callbackCounter = 0;
const pendingCallbacks = new Map();

function nextCallbackId() {
  callbackCounter += 1;
  return `comms-cb-${Date.now()}-${callbackCounter}`;
}

function sendToParent(payload) {
  if (typeof process.send === 'function') {
    process.send(payload);
  }
}

function clearPendingCallback(reqId) {
  const entry = pendingCallbacks.get(reqId);
  if (!entry) return null;
  pendingCallbacks.delete(reqId);
  clearTimeout(entry.timer);
  return entry;
}

function requestParent(action, payload = {}, timeoutMs = DEFAULT_PARENT_CALLBACK_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const reqId = nextCallbackId();
    const timer = setTimeout(() => {
      const entry = clearPendingCallback(reqId);
      if (!entry) return;
      entry.reject(new Error(`parent callback timeout (${action})`));
    }, timeoutMs);

    pendingCallbacks.set(reqId, { resolve, reject, timer });
    sendToParent({
      kind: 'callback',
      reqId,
      action,
      payload,
    });
  });
}

function sendResponse(reqId, ok, result = null, error = null, code = null) {
  sendToParent({
    kind: 'response',
    reqId,
    ok,
    ...(ok ? { result } : { error, ...(code ? { code } : {}) }),
  });
}

async function handleAction(action, payload = {}) {
  switch (action) {
    case 'start': {
      const options = payload.options || {};
      await websocketRuntime.start({
        port: options.port,
        onMessage: async (data) => requestParent('onMessage', { data }, options.callbackTimeoutMs || DEFAULT_PARENT_CALLBACK_TIMEOUT_MS),
      });
      return {
        ok: true,
        port: websocketRuntime.getPort(),
      };
    }
    case 'stop': {
      await websocketRuntime.stop();
      return { ok: true };
    }
    case 'shutdown': {
      await websocketRuntime.stop();
      return { ok: true, shutdown: true };
    }
    case 'isRunning':
      return websocketRuntime.isRunning();
    case 'getPort':
      return websocketRuntime.getPort();
    case 'getClients':
      return websocketRuntime.getClients();
    case 'getRoutingHealth':
      return websocketRuntime.getRoutingHealth(payload.target, payload.staleAfterMs, payload.now);
    case 'sendToTarget':
      return websocketRuntime.sendToTarget(payload.target, payload.content, payload.meta || {});
    case 'sendToPane':
      return websocketRuntime.sendToPane(payload.paneId, payload.content, payload.meta || {});
    case 'broadcast':
      return websocketRuntime.broadcast(payload.content, payload.options || {});
    default:
      throw new Error(`unknown comms worker action: ${action || 'none'}`);
  }
}

async function handleMessage(message) {
  if (!message || typeof message !== 'object') return;

  if (message.kind === 'callback-response' && message.reqId) {
    const entry = clearPendingCallback(message.reqId);
    if (!entry) return;
    if (message.ok) {
      entry.resolve(message.result);
    } else {
      const err = new Error(message.error || 'parent callback failed');
      err.code = message.code || 'PARENT_CALLBACK_ERROR';
      entry.reject(err);
    }
    return;
  }

  if (message.kind !== 'request' || !message.reqId) return;

  try {
    const result = await handleAction(message.action, message.payload || {});
    sendResponse(message.reqId, true, result);
    if (message.action === 'shutdown') {
      setImmediate(() => process.exit(0));
    }
  } catch (err) {
    sendResponse(message.reqId, false, null, err.message, 'WORKER_ACTION_ERROR');
  }
}

async function shutdown(exitCode = 0) {
  try {
    await websocketRuntime.stop();
  } catch (err) {
    log.warn('CommsWorker', `Shutdown stop failed: ${err.message}`);
  }
  process.exit(exitCode);
}

process.on('message', (msg) => {
  handleMessage(msg).catch((err) => {
    log.error('CommsWorker', `Failed handling message: ${err.message}`);
  });
});
process.on('disconnect', () => { shutdown(0); });
process.on('SIGTERM', () => { shutdown(0); });
process.on('SIGINT', () => { shutdown(0); });
process.on('uncaughtException', (err) => {
  log.error('CommsWorker', `Uncaught exception: ${err.message}`);
  shutdown(1);
});
process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  log.error('CommsWorker', `Unhandled rejection: ${message}`);
  shutdown(1);
});
