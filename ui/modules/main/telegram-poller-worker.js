/**
 * Child-process owner for Telegram inbound polling.
 *
 * The parent process must not start its own Telegram getUpdates loop while this
 * worker is active. Messages cross back to SquidRunApp through IPC only.
 */

const fs = require('fs');
const path = require('path');
const telegramPoller = require('../telegram-poller');
const { waitForStandaloneLaneExit } = require('../telegram-poller-handoff');
const log = require('../logger');

function resolveCrashLogPath() {
  // Walk up until we find the install's .squidrun/runtime. The depth differs
  // between source checkouts, asar.unpacked builds, and overlay bundles.
  let dir = __dirname;
  for (let i = 0; i < 8; i += 1) {
    const candidate = path.join(dir, '.squidrun', 'runtime');
    if (fs.existsSync(candidate)) {
      return path.join(candidate, 'telegram-poller-worker-crash.log');
    }
    dir = path.dirname(dir);
  }
  return null;
}

function reportFatalWorkerError(kind, err) {
  // The shared logger buffers file writes, so logging and immediately exiting
  // can lose the stack. Persist synchronously before shutdown.
  const detail = err && err.stack ? err.stack : String(err);
  const line = `${new Date().toISOString()} [telegram-poller-worker] ${kind}: ${detail}\n`;
  try { fs.writeSync(2, line); } catch { /* stderr may be closed */ }
  try {
    const crashLog = resolveCrashLogPath();
    if (crashLog) fs.appendFileSync(crashLog, line);
  } catch { /* diagnostics must not block shutdown */ }
  try {
    log.error('Telegram', `Telegram poller worker ${kind}: ${err && err.message ? err.message : String(err)}`);
  } catch { /* logger itself may be the failure */ }
}

function send(message) {
  if (typeof process.send === 'function') {
    process.send(message);
  }
}

const DEFAULT_ACK_TIMEOUT_MS = 15000;
const pendingAcks = new Map();

function ackKeyFor(updateId) {
  return `telegram-in-${updateId}`;
}

/**
 * Await the parent's durable acceptance of one update.
 *
 * The poller awaits this callback, and since 345c4311 a rejection HOLDS the
 * Telegram cursor. So every path that cannot prove durable acceptance must
 * reject: no updateId to correlate on, no IPC channel, a negative ack, a
 * timeout, or the parent going away. Resolving on anything weaker would make
 * the ack a decoration on the same fire-and-forget send it replaced.
 */
function awaitParentAck(updateId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const key = ackKeyFor(updateId);
    if (pendingAcks.has(key)) {
      // Same update already in flight: correlating two waiters on one key would
      // make "settle once" ambiguous. The poller is serial, so this is a bug.
      reject(new Error(`duplicate in-flight ack for ${key}`));
      return;
    }

    let settled = false;
    let timer = null;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      pendingAcks.delete(key);
      fn(value);
    };

    const entry = {
      resolve: () => settle(resolve, undefined),
      reject: (err) => settle(reject, err instanceof Error ? err : new Error(String(err))),
    };
    pendingAcks.set(key, entry);

    timer = setTimeout(
      () => entry.reject(new Error(`ack timeout for ${key}`)),
      timeoutMs
    );
    if (typeof timer.unref === 'function') timer.unref();
  });
}

/** Reject everything still outstanding. Called BEFORE the process can exit. */
function rejectAllPendingAcks(reason) {
  for (const [key, entry] of Array.from(pendingAcks.entries())) {
    pendingAcks.delete(key);
    entry.reject(new Error(`${reason} (${key})`));
  }
}

function handleParentAck(message) {
  const key = typeof message.ackKey === 'string' ? message.ackKey : null;
  if (!key) return;
  const entry = pendingAcks.get(key);
  if (!entry) return;
  if (message.ok === true && message.durable === true) {
    entry.resolve();
    return;
  }
  entry.reject(new Error(`parent nacked ${key}: ${message.reason || 'unspecified'}`));
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

async function start(options = {}) {
  send({
    type: 'starting',
    phase: 'standalone_lane_handoff',
  });
  const getLaneStatus = typeof options.getStandaloneLaneStatus === 'function'
    ? options.getStandaloneLaneStatus
    : () => {
      const lane = require('../../scripts/hm-telegram-poller-lane');
      return lane.status({ env: options.env || process.env });
    };
  const handoff = await waitForStandaloneLaneExit({
    getLaneStatus,
    timeoutMs: options.standaloneLaneHandoffTimeoutMs,
    retryMs: options.standaloneLaneHandoffRetryMs,
  });
  if (!handoff.ok) {
    send({
      type: 'started',
      started: false,
      reason: handoff.reason,
    });
    setImmediate(() => process.exit(0));
    return false;
  }

  send({
    type: 'starting',
    phase: 'poll_dispatch_lease',
  });
  const ackTimeoutMs = Number.isFinite(Number(options.ackTimeoutMs)) && Number(options.ackTimeoutMs) > 0
    ? Number(options.ackTimeoutMs)
    : DEFAULT_ACK_TIMEOUT_MS;
  const started = telegramPoller.start({
    ...options,
    onMessage: (text, from, metadata = {}) => {
      const updateId = Number(metadata && metadata.updateId);
      if (!Number.isFinite(updateId)) {
        // Without an updateId there is nothing to correlate an ack to, so we
        // could never learn whether this landed. Refuse rather than guess.
        return Promise.reject(new Error('inbound update missing updateId; cannot correlate ack'));
      }
      if (typeof process.send !== 'function') {
        return Promise.reject(new Error('no IPC channel to parent; cannot confirm durable acceptance'));
      }

      const waiter = awaitParentAck(updateId, ackTimeoutMs);
      send({
        type: 'message',
        ackKey: ackKeyFor(updateId),
        payload: {
          text,
          from,
          metadata,
        },
      });
      return waiter;
    },
  });

  send({
    type: 'started',
    started,
    reason: started ? null : 'missing_config',
  });

  if (!started) {
    setImmediate(() => process.exit(0));
  }
  return started;
}

function shutdown(exitCode = 0) {
  // Before anything can exit. A pending ack that never settles leaves the
  // poller awaiting a promise that dies with the process — correctness by exit
  // timing rather than by contract, which is exactly what Architect #45 ruled
  // out. Reject first so the hold is a decision.
  rejectAllPendingAcks(`worker shutting down (code ${exitCode})`);
  try {
    telegramPoller.stop();
  } catch (err) {
    log.warn('Telegram', `Failed stopping Telegram poller worker: ${err.message}`);
  }
  process.exit(exitCode);
}

process.on('message', (message) => {
  const msg = asObject(message);
  if (msg.type === 'start') {
    start(asObject(msg.options)).catch((err) => {
      reportFatalWorkerError('startup handoff failed', err);
      shutdown(1);
    });
    return;
  }

  if (msg.type === 'message-ack') {
    handleParentAck(msg);
    return;
  }

  if (msg.type === 'shutdown') {
    shutdown(0);
  }
});

process.on('disconnect', () => {
  rejectAllPendingAcks('parent disconnected');
  shutdown(0);
});
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
process.on('uncaughtException', (err) => {
  reportFatalWorkerError('uncaught exception', err);
  shutdown(1);
});
process.on('unhandledRejection', (reason) => {
  reportFatalWorkerError('unhandled rejection', reason);
  shutdown(1);
});

// Test seam only. This file is a script — requiring it registers the process
// handlers above and nothing else runs until the parent sends `start`.
module.exports = {
  _ackInternals: {
    pendingAcks,
    ackKeyFor,
    awaitParentAck,
    rejectAllPendingAcks,
    handleParentAck,
  },
};
