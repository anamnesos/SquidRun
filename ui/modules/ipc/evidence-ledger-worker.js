/**
 * Evidence Ledger worker process.
 * Owns local runtime and executes SQLite-backed operations off the main thread.
 */

const log = require('../logger');
const {
  initializeEvidenceLedgerRuntime,
  executeEvidenceLedgerOperation,
  closeSharedRuntime,
} = require('./evidence-ledger-runtime');

function sendResponse(reqId, ok, result = null, error = null, extras = {}) {
  if (typeof process.send !== 'function') return;
  process.send({
    type: 'response',
    reqId,
    ok,
    ...(ok ? { result } : { error }),
    ...extras,
  });
}

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function handleRequest(message) {
  const msg = asObject(message);
  const reqId = msg.reqId;
  if (!reqId) return;

  try {
    if (msg.type === 'init') {
      const result = initializeEvidenceLedgerRuntime(asObject(msg.options));
      sendResponse(reqId, true, result);
      return;
    }

    if (msg.type === 'op') {
      const result = executeEvidenceLedgerOperation(
        msg.action,
        asObject(msg.payload),
        {
          ...asObject(msg.options),
          source: asObject(msg.options?.source),
        }
      );
      sendResponse(reqId, true, result);
      return;
    }

    if (msg.type === 'close') {
      closeSharedRuntime();
      sendResponse(reqId, true, { ok: true });
      setImmediate(() => process.exit(0));
      return;
    }

    sendResponse(reqId, false, null, `unknown worker message type: ${msg.type || 'none'}`, {
      code: 'UNKNOWN_WORKER_MESSAGE',
    });
  } catch (err) {
    sendResponse(reqId, false, null, err.message, {
      code: 'WORKER_HANDLER_ERROR',
    });
  }
}

function shutdown(exitCode = 0) {
  try {
    closeSharedRuntime();
  } catch (err) {
    log.warn('EvidenceLedgerWorker', `Failed to close runtime during shutdown: ${err.message}`);
  }
  process.exit(exitCode);
}

process.on('message', handleRequest);
process.on('disconnect', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
process.on('uncaughtException', (err) => {
  log.error('EvidenceLedgerWorker', `Uncaught exception: ${err.message}`);
  shutdown(1);
});
process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  log.error('EvidenceLedgerWorker', `Unhandled rejection: ${message}`);
  shutdown(1);
});
