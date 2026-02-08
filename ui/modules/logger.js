/**
 * Structured logger for Hivemind
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
const { WORKSPACE_PATH } = require('../config');

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
let minLevel = LEVELS.info;

const LOG_DIR = path.join(WORKSPACE_PATH, 'logs');
const LOG_FILE_PATH = path.join(LOG_DIR, 'app.log');
let logDirReady = false;

function ensureLogDir() {
  if (logDirReady) return;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    logDirReady = true;
  } catch (err) {
    // If file logging fails, keep console logging working
  }
}

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
    fs.appendFileSync(LOG_FILE_PATH, `${line}\n`);
  } catch (err) {
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
};

module.exports = logger;
