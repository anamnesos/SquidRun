/**
 * Child-process owner for Telegram inbound polling.
 *
 * The parent process must not start its own Telegram getUpdates loop while this
 * worker is active. Messages cross back to SquidRunApp through IPC only.
 */

const fs = require('fs');
const path = require('path');
const telegramPoller = require('../telegram-poller');
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

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function start(options = {}) {
  const started = telegramPoller.start({
    ...options,
    onMessage: (text, from, metadata = {}) => {
      send({
        type: 'message',
        payload: {
          text,
          from,
          metadata,
        },
      });
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
}

function shutdown(exitCode = 0) {
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
    start(asObject(msg.options));
    return;
  }

  if (msg.type === 'shutdown') {
    shutdown(0);
  }
});

process.on('disconnect', () => shutdown(0));
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
