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

function appendJsonlWithRotation(filePath, entry, options = {}) {
  const line = `${JSON.stringify(entry)}\n`;
  const rotation = rotateFileIfNeeded(filePath, line, options);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, line, 'utf8');
  return { ok: true, path: filePath, rotation };
}

module.exports = {
  DEFAULT_RUNTIME_ROTATE_MAX_BYTES,
  DEFAULT_RUNTIME_ROTATE_MAX_FILES,
  buildRotationOptions,
  rotateFileIfNeeded,
  appendJsonlWithRotation,
};
