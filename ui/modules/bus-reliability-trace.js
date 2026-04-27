const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { resolveCoordPath } = require('../config');

const TRACE_PATH_ENV_NAMES = [
  'SQUIDRUN_BUS_RELIABILITY_TRACE_PATH',
  'SQUIDRUN_BUS_TRACE_PATH',
];

function getUtf8ByteLength(value) {
  return Buffer.byteLength(String(value ?? ''), 'utf8');
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

function appendBusTraceEvent(event = {}) {
  try {
    const tracePath = resolveTracePath();
    fs.mkdirSync(path.dirname(tracePath), { recursive: true });
    fs.appendFileSync(tracePath, `${JSON.stringify(sanitizeTraceEvent(event))}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  appendBusTraceEvent,
  createPayloadFingerprint,
  getUtf8ByteLength,
  resolveTracePath,
};
