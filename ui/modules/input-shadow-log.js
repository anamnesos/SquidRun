'use strict';

const path = require('path');

const { resolveCoordPath } = require('../config');
const { appendJsonlWithRotation } = require('./runtime-log-rotation');

const MAX_SHADOW_TEXT_BYTES = 8 * 1024;
const INPUT_SHADOW_RECOVERY_CONSUMER = 'workspace/knowledge/recovering-lost-user-input.md';
const DEFAULT_INPUT_SHADOW_ROTATE_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_INPUT_SHADOW_ROTATE_MAX_FILES = 7;
const DEFAULT_INPUT_SHADOW_LOG_PATH = resolveCoordPath(
  path.join('runtime', 'user-input-shadow.jsonl'),
  { forWrite: true }
);

function toText(value) {
  return typeof value === 'string' ? value : String(value ?? '');
}

function byteLength(value) {
  return Buffer.byteLength(toText(value), 'utf8');
}

function truncateTextForShadowLog(text, maxBytes = MAX_SHADOW_TEXT_BYTES) {
  const safeText = toText(text);
  const fullByteLen = byteLength(safeText);
  const limit = Math.max(0, Math.floor(Number(maxBytes) || MAX_SHADOW_TEXT_BYTES));
  if (fullByteLen <= limit) {
    return {
      text: safeText,
      truncated: false,
      truncationMarker: null,
    };
  }

  const marker = `\n[...truncated for shadow log at ${limit} bytes; fullByteLen=${fullByteLen}]`;
  const markerBytes = byteLength(marker);
  const textBudget = Math.max(0, limit - markerBytes);
  let used = 0;
  let clipped = '';

  for (const char of safeText) {
    const charBytes = byteLength(char);
    if (used + charBytes > textBudget) break;
    clipped += char;
    used += charBytes;
  }

  return {
    text: `${clipped}${marker}`,
    truncated: true,
    truncationMarker: marker.trim(),
  };
}

function appendInputShadowLog(input = {}, options = {}) {
  try {
    const rawText = toText(input.text);
    const originalByteLen = Number.isFinite(Number(input.byteLen))
      ? Number(input.byteLen)
      : byteLength(rawText);
    const truncated = truncateTextForShadowLog(
      rawText,
      Number.isFinite(Number(options.maxTextBytes)) ? Number(options.maxTextBytes) : MAX_SHADOW_TEXT_BYTES
    );
    const logPath = path.resolve(String(options.logPath || DEFAULT_INPUT_SHADOW_LOG_PATH));
    const entry = {
      ts: new Date().toISOString(),
      paneId: toText(input.paneId),
      source: toText(input.source),
      byteLen: originalByteLen,
      textLen: rawText.length,
      text: truncated.text,
    };

    if (truncated.truncated) {
      entry.truncated = true;
      entry.truncationMarker = truncated.truncationMarker;
    }

    const writeResult = appendJsonlWithRotation(logPath, entry, {
      maxBytes: Number.isFinite(Number(options.rotateMaxBytes))
        ? Number(options.rotateMaxBytes)
        : DEFAULT_INPUT_SHADOW_ROTATE_MAX_BYTES,
      maxFiles: Number.isFinite(Number(options.rotateMaxFiles))
        ? Number(options.rotateMaxFiles)
        : DEFAULT_INPUT_SHADOW_ROTATE_MAX_FILES,
      consumer: INPUT_SHADOW_RECOVERY_CONSUMER,
    });
    return { ok: true, path: logPath, entry, rotation: writeResult.rotation };
  } catch (_) {
    return { ok: false, dropped: true };
  }
}

module.exports = {
  MAX_SHADOW_TEXT_BYTES,
  INPUT_SHADOW_RECOVERY_CONSUMER,
  DEFAULT_INPUT_SHADOW_ROTATE_MAX_BYTES,
  DEFAULT_INPUT_SHADOW_ROTATE_MAX_FILES,
  DEFAULT_INPUT_SHADOW_LOG_PATH,
  appendInputShadowLog,
  _internals: {
    truncateTextForShadowLog,
  },
};
