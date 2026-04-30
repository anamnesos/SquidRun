/**
 * Child-process owner for Telegram inbound polling.
 *
 * The parent process must not start its own Telegram getUpdates loop while this
 * worker is active. Messages cross back to SquidRunApp through IPC only.
 */

const telegramPoller = require('../telegram-poller');
const log = require('../logger');

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
  log.error('Telegram', `Telegram poller worker uncaught exception: ${err.message}`);
  shutdown(1);
});
process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  log.error('Telegram', `Telegram poller worker unhandled rejection: ${message}`);
  shutdown(1);
});
