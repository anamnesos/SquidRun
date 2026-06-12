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
const MIRROR_STATE_KEY = Symbol.for('squidrun.logger.mirrorState');
let loggerBlackoutMarkerEmitted = false;

function resolveLoggerBlackoutMarkerPath() {
  if (typeof resolveCoordPath === 'function') {
    try {
      return resolveCoordPath(path.join('runtime', 'logger-blackout.jsonl'), { forWrite: true });
    } catch (_err) {
      // Fall back below when coord resolution is unavailable.
    }
  }
  if (!WORKSPACE_PATH) return null;
  return path.join(WORKSPACE_PATH, '.squidrun', 'runtime', 'logger-blackout.jsonl');
}

function normalizeError(err) {
  if (!err) return { message: 'unknown', code: null, stack: null };
  if (err instanceof Error) {
    return {
      message: err.message || String(err),
      code: err.code || null,
      stack: err.stack || null,
    };
  }
  return {
    message: String(err),
    code: err && typeof err === 'object' ? err.code || null : null,
    stack: null,
  };
}

function emitLoggerBlackoutMarker(reason, err) {
  if (loggerBlackoutMarkerEmitted) return false;
  loggerBlackoutMarkerEmitted = true;
  const error = normalizeError(err);
  const marker = {
    schema: 'squidrun.logger_blackout.v1',
    t: Date.now(),
    iso: new Date().toISOString(),
    pid: process.pid,
    reason: String(reason || 'logger_failure'),
    error,
  };
  try {
    process.stderr.write(
      `[LOGGER BLACKOUT] ${marker.iso} ${marker.reason}: ${error.message}\n`
    );
  } catch (_stderrErr) {
    // If stderr is gone too, the sync marker below is the remaining channel.
  }

  const markerPath = resolveLoggerBlackoutMarkerPath();
  if (!markerPath) return true;
  try {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.appendFileSync(markerPath, `${JSON.stringify(marker)}\n`, 'utf8');
  } catch (_markerErr) {
    // Never let diagnostic fallback take the app down.
  }
  return true;
}

function ensureLogDir() {
  if (logDirReady || !LOG_DIR) return;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    logDirReady = true;
  } catch (err) {
    emitLoggerBlackoutMarker('ensure_log_dir_failed', err);
    // If file logging fails, keep console logging working
  }
}

const bufferedWriter = createBufferedFileWriter({
  filePath: LOG_FILE_PATH,
  flushIntervalMs: LOG_FLUSH_INTERVAL_MS,
  ensureDir: ensureLogDir,
  onError: (err) => emitLoggerBlackoutMarker('buffered_log_write_failed', err),
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

function createMirrorWriter(stream, streamName = 'unknown') {
  if (!stream || typeof stream.write !== 'function') {
    return () => {};
  }
  const state = stream[MIRROR_STATE_KEY] || {
    disabled: false,
    listenerAttached: false,
  };
  stream[MIRROR_STATE_KEY] = state;
  const markBroken = (err = null) => {
    state.disabled = true;
    emitLoggerBlackoutMarker(`${streamName}_stream_broken`, err);
    if (state.listenerAttached) {
      try { stream.removeListener('error', markBroken); } catch {}
      state.listenerAttached = false;
    }
  };
  if (!state.listenerAttached) {
    try {
      stream.on('error', markBroken);
      state.listenerAttached = true;
    } catch {
      state.disabled = true;
    }
  }
  return (line) => {
    if (state.disabled || !line || stream.destroyed || stream.writable === false) return;
    try {
      stream.write(line, (error) => {
        if (error) markBroken(error);
      });
    } catch (err) {
      markBroken(err);
    }
  };
}

const writeStdout = createMirrorWriter(process.stdout, 'stdout');
const writeStderr = createMirrorWriter(process.stderr, 'stderr');

function write(level, subsystem, message, extra) {
  if (LEVELS[level] < minLevel) return;
  const parts = formatMsg(level, subsystem, message, extra);
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
  const lineWithNewline = `${line}\n`;
  if (level === 'error' || level === 'warn') {
    writeStderr(lineWithNewline);
  } else {
    writeStdout(lineWithNewline);
  }

  ensureLogDir();
  try {
    bufferedWriter.write(lineWithNewline);
  } catch (err) {
    emitLoggerBlackoutMarker('buffered_log_write_throw', err);
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
