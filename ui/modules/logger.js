/**
 * Structured logger for SquidRun
 * Replaces raw console.* with leveled, timestamped, context-aware logging.
 *
 * Usage:
 *   const log = require('./modules/logger');
 *   log.info('Main', 'App started');
 *   log.warn('Daemon', `Pane ${id} timeout`);
 *   log.error('IPC', 'Handler failed', err);
 *
 *   // Or create a scoped logger:
 *   const log = require('./modules/logger').scope('Daemon');
 *   log.info('Connected');
 *   log.error('Disconnected', err);
 */

const fs = require('fs');
const path = require('path');
const { WORKSPACE_PATH, resolveCoordPath } = require('../config');
const { createBufferedFileWriter } = require('./buffered-file-writer');

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
let minLevel = LEVELS.info;

function resolveLogFilePath() {
  if (!WORKSPACE_PATH) return null;
  if (typeof resolveCoordPath === 'function') {
    try {
      return resolveCoordPath(path.join('logs', 'app.log'), { forWrite: true });
    } catch (_err) {
      // Fall back to workspace path when coord resolver is unavailable in tests.
    }
  }
  return path.join(WORKSPACE_PATH, 'logs', 'app.log');
}

const LOG_FILE_PATH = resolveLogFilePath();
const LOG_DIR = LOG_FILE_PATH ? path.dirname(LOG_FILE_PATH) : null;
let logDirReady = false;
const LOG_FLUSH_INTERVAL_MS = 500;
const LOG_ROTATE_MAX_BYTES = 10 * 1024 * 1024;
const LOG_ROTATE_MAX_FILES = 3;

function ensureLogDir() {
  if (logDirReady || !LOG_DIR) return;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    logDirReady = true;
  } catch (_err) {
    // If file logging fails, keep console logging working
  }
}

const bufferedWriter = createBufferedFileWriter({
  filePath: LOG_FILE_PATH,
  flushIntervalMs: LOG_FLUSH_INTERVAL_MS,
  ensureDir: ensureLogDir,
  rotateMaxBytes: LOG_ROTATE_MAX_BYTES,
  rotateMaxFiles: LOG_ROTATE_MAX_FILES,
});

function timestamp() {
  const d = new Date();
  return d.toISOString().slice(11, 23); // HH:mm:ss.SSS
}

function formatMsg(level, subsystem, message, extra) {
  const ts = timestamp();
  const prefix = `${ts} [${level.toUpperCase()}] [${subsystem}]`;
  if (extra !== undefined) {
    return [prefix, message, extra];
  }
  return [prefix, message];
}

function write(level, subsystem, message, extra) {
  if (LEVELS[level] < minLevel) return;
  const parts = formatMsg(level, subsystem, message, extra);
  try {
    if (level === 'error') {
      console.error(...parts);
    } else if (level === 'warn') {
      console.warn(...parts);
    } else {
      console.log(...parts);
    }
  } catch (_) {
    // EPIPE / broken stdout pipe — fall through to file logging
  }

  ensureLogDir();
  try {
    const line = parts
      .map((part) => {
        if (typeof part === 'string') return part;
        try {
          return JSON.stringify(part);
        } catch {
          return String(part);
        }
      })
      .join(' ');
    bufferedWriter.write(`${line}\n`);
  } catch (_err) {
    // Ignore file logging errors to avoid breaking runtime
  }
}

const logger = {
  debug(subsystem, message, extra) { write('debug', subsystem, message, extra); },
  info(subsystem, message, extra) { write('info', subsystem, message, extra); },
  warn(subsystem, message, extra) { write('warn', subsystem, message, extra); },
  error(subsystem, message, extra) { write('error', subsystem, message, extra); },

  /** Set minimum log level: 'debug' | 'info' | 'warn' | 'error' */
  setLevel(level) {
    if (LEVELS[level] !== undefined) minLevel = LEVELS[level];
  },

  /** Returns a logger scoped to a subsystem so you don't repeat it */
  scope(subsystem) {
    return {
      debug(msg, extra) { write('debug', subsystem, msg, extra); },
      info(msg, extra) { write('info', subsystem, msg, extra); },
      warn(msg, extra) { write('warn', subsystem, msg, extra); },
      error(msg, extra) { write('error', subsystem, msg, extra); },
    };
  },

  // Test-only helper to force buffered writes.
  _flushForTesting() {
    return bufferedWriter.flush();
  },
};

module.exports = logger;
