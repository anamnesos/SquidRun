/**
 * Diagnostic log writer for message delivery traces.
 * Writes to workspace/logs/diagnostic.log for easy agent access.
 */

const fs = require('fs');
const path = require('path');
const { WORKSPACE_PATH, resolveCoordPath } = require('../config');
const { createBufferedFileWriter } = require('./buffered-file-writer');

function resolveLogPath() {
  if (!WORKSPACE_PATH) return null;
  if (typeof resolveCoordPath === 'function') {
    try {
      return resolveCoordPath(path.join('logs', 'diagnostic.log'), { forWrite: true });
    } catch (_err) {
      // Fall back to workspace path when coord resolver is unavailable in tests.
    }
  }
  return path.join(WORKSPACE_PATH, 'logs', 'diagnostic.log');
}

const LOG_PATH = resolveLogPath();
const LOG_DIR = LOG_PATH ? path.dirname(LOG_PATH) : null;
let dirReady = false;
const DIAGNOSTIC_FLUSH_INTERVAL_MS = 500;

function ensureDir() {
  if (dirReady || !LOG_DIR) return;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    dirReady = true;
  } catch (_err) {
    // Ignore file logging errors to avoid breaking runtime
  }
}

const bufferedWriter = createBufferedFileWriter({
  filePath: LOG_PATH,
  flushIntervalMs: DIAGNOSTIC_FLUSH_INTERVAL_MS,
  ensureDir,
});

function timestamp() {
  return new Date().toISOString();
}

function formatLine(subsystem, message, extra) {
  const parts = [timestamp(), `[${subsystem}]`, message];
  if (extra !== undefined) {
    if (typeof extra === 'string') {
      parts.push(extra);
    } else {
      try {
        parts.push(JSON.stringify(extra));
      } catch {
        parts.push(String(extra));
      }
    }
  }
  return parts.join(' ');
}

function write(subsystem, message, extra) {
  try {
    bufferedWriter.write(`${formatLine(subsystem, message, extra)}\n`);
  } catch (_err) {
    // Ignore to keep runtime stable
  }
}

module.exports = {
  write,
  _flushForTesting: () => bufferedWriter.flush(),
  LOG_PATH,
};
