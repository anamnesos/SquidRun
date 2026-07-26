'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_RUNTIME_ROTATE_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_RUNTIME_ROTATE_MAX_FILES = 3;

function toPositiveInteger(value, fallback) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.floor(numeric);
  }
  return fallback;
}

function buildRotationOptions(options = {}) {
  return {
    maxBytes: toPositiveInteger(
      options.maxBytes ?? process.env.SQUIDRUN_RUNTIME_JSONL_ROTATE_MAX_BYTES,
      DEFAULT_RUNTIME_ROTATE_MAX_BYTES
    ),
    maxFiles: toPositiveInteger(
      options.maxFiles ?? process.env.SQUIDRUN_RUNTIME_JSONL_ROTATE_MAX_FILES,
      DEFAULT_RUNTIME_ROTATE_MAX_FILES
    ),
    consumer: String(options.consumer || 'runtime_jsonl_retention').trim() || 'runtime_jsonl_retention',
  };
}

function removeIfExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) return false;
    fs.unlinkSync(filePath);
    return true;
  } catch (err) {
    if (err?.code === 'ENOENT') return false;
    throw err;
  }
}

function renameIfExists(sourcePath, targetPath) {
  try {
    if (!fs.existsSync(sourcePath)) return false;
    fs.renameSync(sourcePath, targetPath);
    return true;
  } catch (err) {
    if (err?.code === 'ENOENT') return false;
    throw err;
  }
}

function rotateFileIfNeeded(filePath, incomingText = '', options = {}) {
  const resolvedPath = path.resolve(String(filePath || ''));
  const { maxBytes, maxFiles, consumer } = buildRotationOptions(options);
  if (!resolvedPath || maxBytes <= 0 || maxFiles <= 0) {
    return { rotated: false, deletedCount: 0, reason: 'rotation_disabled', maxBytes, maxFiles, consumer };
  }

  let currentSize = 0;
  try {
    currentSize = fs.existsSync(resolvedPath) ? fs.statSync(resolvedPath).size : 0;
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }

  const incomingBytes = Buffer.byteLength(String(incomingText || ''), 'utf8');
  if ((currentSize + incomingBytes) <= maxBytes) {
    return { rotated: false, deletedCount: 0, reason: 'under_cap', currentSize, incomingBytes, maxBytes, maxFiles, consumer };
  }

  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  const deletedCount = removeIfExists(`${resolvedPath}.${maxFiles}`) ? 1 : 0;
  for (let index = maxFiles - 1; index >= 1; index -= 1) {
    renameIfExists(`${resolvedPath}.${index}`, `${resolvedPath}.${index + 1}`);
  }
  const rotated = renameIfExists(resolvedPath, `${resolvedPath}.1`);

  return {
    rotated,
    deletedCount,
    reason: rotated ? 'rotated_oldest_segment_deleted_if_present' : 'no_source_file',
    currentSize,
    incomingBytes,
    maxBytes,
    maxFiles,
    consumer,
    rotatedPath: rotated ? `${resolvedPath}.1` : null,
  };
}

/**
 * COPY-TRUNCATE rotation, for logs whose writer HOLDS AN OPEN HANDLE
 * (fs.openSync(path,'a') handed to spawn() as child stdio).
 *
 * Proven on Windows before writing this (S483): renaming such a file does NOT
 * throw - the rename silently succeeds, the holder keeps appending into the
 * RENAMED file, the live path stops existing, and rotation reclaims zero bytes
 * forever. Truncating in place keeps the holder's handle valid and its offset
 * pointing at the same (now empty) file, so space is actually reclaimed.
 *
 * Use rotateFileIfNeeded() for appendFile-style writers; use this one whenever
 * any writer may hold the file open across the rotation.
 */
function rotateHeldFileIfNeeded(filePath, incomingText = '', options = {}) {
  const resolvedPath = path.resolve(String(filePath || ''));
  const { maxBytes, maxFiles, consumer } = buildRotationOptions(options);
  if (!resolvedPath || maxBytes <= 0 || maxFiles <= 0) {
    return { rotated: false, reason: 'rotation_disabled', maxBytes, maxFiles, consumer };
  }

  let currentSize = 0;
  try {
    currentSize = fs.existsSync(resolvedPath) ? fs.statSync(resolvedPath).size : 0;
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
    return { rotated: false, reason: 'no_source_file', maxBytes, maxFiles, consumer };
  }

  const incomingBytes = Buffer.byteLength(String(incomingText || ''), 'utf8');
  if ((currentSize + incomingBytes) <= maxBytes) {
    return { rotated: false, reason: 'under_cap', currentSize, maxBytes, maxFiles, consumer };
  }

  try {
    removeIfExists(`${resolvedPath}.${maxFiles}`);
    for (let index = maxFiles - 1; index >= 1; index -= 1) {
      renameIfExists(`${resolvedPath}.${index}`, `${resolvedPath}.${index + 1}`);
    }
    // COPY then TRUNCATE - never rename the live file out from under a holder.
    fs.copyFileSync(resolvedPath, `${resolvedPath}.1`);
    fs.truncateSync(resolvedPath, 0);
    return {
      rotated: true,
      reason: 'copy_truncate_live_handle_safe',
      currentSize,
      maxBytes,
      maxFiles,
      consumer,
      rotatedPath: `${resolvedPath}.1`,
    };
  } catch (err) {
    // Never let logging break its caller.
    return { rotated: false, reason: `copy_truncate_failed:${err.code || err.message}`, currentSize, maxBytes, maxFiles, consumer };
  }
}

function appendJsonlWithRotation(filePath, entry, options = {}) {
  const line = `${JSON.stringify(entry)}\n`;
  const rotation = rotateFileIfNeeded(filePath, line, options);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, line, 'utf8');
  return { ok: true, path: filePath, rotation };
}

/**
 * Append a plain text line with the correct rotation strategy for the writer
 * shape. `heldHandle: true` selects copy-truncate (spawn-stdio logs).
 */
function appendTextWithRotation(filePath, text, options = {}) {
  const line = String(text || '');
  const rotation = options.heldHandle === true
    ? rotateHeldFileIfNeeded(filePath, line, options)
    : rotateFileIfNeeded(filePath, line, options);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, line, 'utf8');
  return { ok: true, path: filePath, rotation };
}

module.exports = {
  DEFAULT_RUNTIME_ROTATE_MAX_BYTES,
  DEFAULT_RUNTIME_ROTATE_MAX_FILES,
  buildRotationOptions,
  rotateFileIfNeeded,
  rotateHeldFileIfNeeded,
  appendJsonlWithRotation,
  appendTextWithRotation,
};
