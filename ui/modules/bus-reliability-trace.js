const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { resolveCoordPath } = require('../config');

const TRACE_PATH_ENV_NAMES = [
  'SQUIDRUN_BUS_RELIABILITY_TRACE_PATH',
  'SQUIDRUN_BUS_TRACE_PATH',
];

const TRACE_MAX_BYTES_ENV_NAME = 'SQUIDRUN_BUS_TRACE_MAX_BYTES';
const TRACE_MAX_EVENT_BYTES_ENV_NAME = 'SQUIDRUN_BUS_TRACE_MAX_EVENT_BYTES';
const TRACE_ROTATED_FILE_LIMIT_ENV_NAME = 'SQUIDRUN_BUS_TRACE_ROTATED_FILE_LIMIT';
const DEFAULT_TRACE_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_TRACE_MAX_EVENT_BYTES = 64 * 1024;
const DEFAULT_TRACE_ROTATED_FILE_LIMIT = 3;

function getUtf8ByteLength(value) {
  return Buffer.byteLength(String(value ?? ''), 'utf8');
}

function readPositiveIntegerEnv(envName, fallback) {
  const raw = process.env[envName];
  const parsed = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function resolveTraceRotationConfig(options = {}) {
  return {
    maxBytes: Number.isFinite(Number(options.maxBytes)) && Number(options.maxBytes) > 0
      ? Math.floor(Number(options.maxBytes))
      : readPositiveIntegerEnv(TRACE_MAX_BYTES_ENV_NAME, DEFAULT_TRACE_MAX_BYTES),
    maxEventBytes: Number.isFinite(Number(options.maxEventBytes)) && Number(options.maxEventBytes) > 0
      ? Math.floor(Number(options.maxEventBytes))
      : readPositiveIntegerEnv(TRACE_MAX_EVENT_BYTES_ENV_NAME, DEFAULT_TRACE_MAX_EVENT_BYTES),
    rotatedFileLimit: Number.isFinite(Number(options.rotatedFileLimit)) && Number(options.rotatedFileLimit) >= 0
      ? Math.floor(Number(options.rotatedFileLimit))
      : readPositiveIntegerEnv(TRACE_ROTATED_FILE_LIMIT_ENV_NAME, DEFAULT_TRACE_ROTATED_FILE_LIMIT),
  };
}

function createPayloadFingerprint(value, options = {}) {
  const text = String(value ?? '');
  const headChars = Number.isFinite(Number(options.headChars)) ? Number(options.headChars) : 64;
  const tailChars = Number.isFinite(Number(options.tailChars)) ? Number(options.tailChars) : 64;
  return {
    byteLength: getUtf8ByteLength(text),
    charLength: text.length,
    sha256: crypto.createHash('sha256').update(text, 'utf8').digest('hex'),
    head: text.slice(0, Math.max(0, headChars)),
    tail: text.slice(Math.max(0, text.length - Math.max(0, tailChars))),
  };
}

function resolveTracePath() {
  for (const envName of TRACE_PATH_ENV_NAMES) {
    const value = process.env[envName];
    if (typeof value === 'string' && value.trim()) {
      return path.resolve(value.trim());
    }
  }
  return resolveCoordPath(path.join('coord', 'bus-reliability-trace.jsonl'), { forWrite: true });
}

function sanitizeTraceEvent(event = {}) {
  const safeEvent = {};
  for (const [key, value] of Object.entries(event || {})) {
    if (value === undefined) continue;
    if (value instanceof Error) {
      safeEvent[key] = value.message;
      continue;
    }
    safeEvent[key] = value;
  }
  return {
    ts: new Date().toISOString(),
    ...safeEvent,
  };
}

function serializeTraceEvent(event = {}, config = resolveTraceRotationConfig()) {
  const sanitized = sanitizeTraceEvent(event);
  const line = `${JSON.stringify(sanitized)}\n`;
  if (getUtf8ByteLength(line) <= config.maxEventBytes) {
    return line;
  }
  return `${JSON.stringify(sanitizeTraceEvent({
    eventType: 'bus_trace_event_oversize',
    originalEventType: sanitized.eventType || null,
    originalPayloadFingerprint: createPayloadFingerprint(line, { headChars: 32, tailChars: 32 }),
    omittedByteLength: getUtf8ByteLength(line),
  }))}\n`;
}

function createRotationSuffix(nowMs = Date.now()) {
  const timestamp = new Date(nowMs).toISOString().replace(/[-:.]/g, '').replace('T', 'T');
  const random = crypto.randomBytes(4).toString('hex');
  return `${timestamp}.${process.pid}.${random}.rotated.jsonl`;
}

function getRotatedTraceStem(tracePath) {
  const baseName = path.basename(tracePath);
  return baseName.endsWith('.jsonl') ? baseName.slice(0, -'.jsonl'.length) : baseName;
}

function truncateFileToTail(filePath, maxBytes) {
  const stat = fs.statSync(filePath);
  if (stat.size <= maxBytes) {
    return false;
  }
  const bytesToKeep = Math.max(0, Math.min(maxBytes, stat.size));
  const buffer = Buffer.alloc(bytesToKeep);
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.readSync(fd, buffer, 0, bytesToKeep, stat.size - bytesToKeep);
  } finally {
    fs.closeSync(fd);
  }
  fs.writeFileSync(filePath, buffer);
  return true;
}

function listRotatedTraceFiles(tracePath) {
  const dir = path.dirname(tracePath);
  if (!fs.existsSync(dir)) return [];
  const stem = getRotatedTraceStem(tracePath);
  const prefix = `${stem}.`;
  return fs.readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.rotated.jsonl'))
    .map((name) => {
      const fullPath = path.join(dir, name);
      let stat = null;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        return null;
      }
      return {
        path: fullPath,
        mtimeMs: Number(stat.mtimeMs || 0),
        size: Number(stat.size || 0),
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.mtimeMs - left.mtimeMs || String(right.path).localeCompare(String(left.path)));
}

function pruneRotatedTraceFiles(tracePath, config = resolveTraceRotationConfig()) {
  const files = listRotatedTraceFiles(tracePath);
  const keepCount = Math.max(0, Number(config.rotatedFileLimit || 0));
  const removed = [];
  for (const file of files.slice(keepCount)) {
    try {
      fs.unlinkSync(file.path);
      removed.push(file.path);
    } catch {
      // Best effort telemetry cleanup.
    }
  }
  return removed;
}

function rotateTraceFileIfNeeded(tracePath, appendBytes = 0, options = {}) {
  const config = resolveTraceRotationConfig(options);
  if (!fs.existsSync(tracePath)) {
    pruneRotatedTraceFiles(tracePath, config);
    return {
      rotated: false,
      config,
    };
  }
  const stat = fs.statSync(tracePath);
  if ((Number(stat.size || 0) + Number(appendBytes || 0)) <= config.maxBytes) {
    pruneRotatedTraceFiles(tracePath, config);
    return {
      rotated: false,
      config,
      sizeBefore: Number(stat.size || 0),
    };
  }

  const dir = path.dirname(tracePath);
  fs.mkdirSync(dir, { recursive: true });
  const rotatedPath = path.join(dir, `${getRotatedTraceStem(tracePath)}.${createRotationSuffix(options.nowMs)}`);
  fs.renameSync(tracePath, rotatedPath);
  const tailTruncated = truncateFileToTail(rotatedPath, config.maxBytes);
  pruneRotatedTraceFiles(tracePath, config);
  return {
    rotated: true,
    config,
    rotatedPath,
    sizeBefore: Number(stat.size || 0),
    tailTruncated,
  };
}

function appendBusTraceEvent(event = {}, options = {}) {
  try {
    const tracePath = resolveTracePath();
    fs.mkdirSync(path.dirname(tracePath), { recursive: true });
    const config = resolveTraceRotationConfig(options);
    const line = serializeTraceEvent(event, config);
    const rotation = rotateTraceFileIfNeeded(tracePath, getUtf8ByteLength(line), config);
    if (rotation.rotated) {
      const marker = serializeTraceEvent({
        eventType: 'bus_trace_rotated',
        rotatedPath: rotation.rotatedPath,
        sizeBefore: rotation.sizeBefore,
        maxBytes: config.maxBytes,
        tailTruncated: rotation.tailTruncated,
      }, config);
      fs.appendFileSync(tracePath, marker, 'utf8');
    }
    fs.appendFileSync(tracePath, line, 'utf8');
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  appendBusTraceEvent,
  createPayloadFingerprint,
  getUtf8ByteLength,
  listRotatedTraceFiles,
  pruneRotatedTraceFiles,
  resolveTraceRotationConfig,
  resolveTracePath,
  rotateTraceFileIfNeeded,
  serializeTraceEvent,
};
