'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_TOKENOMIST_SOURCE_PATH = path.resolve(__dirname, '..', '..', 'tokenomist-current.yml');
const TOKENOMIST_SOURCE_WARN_MS = 6 * 60 * 60 * 1000;
const TOKENOMIST_SOURCE_STALE_MS = 12 * 60 * 60 * 1000;

function toText(value, fallback = '') {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toTimestampMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const normalized = toText(value);
  if (!normalized) return null;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function inspectTokenomistSource(sourcePath = DEFAULT_TOKENOMIST_SOURCE_PATH, options = {}) {
  const resolvedPath = path.resolve(String(sourcePath || DEFAULT_TOKENOMIST_SOURCE_PATH));
  const nowMs = toTimestampMs(options.now) || Date.now();
  const warnAfterMs = Math.max(1, toNumber(options.tokenomistSourceWarnMs, TOKENOMIST_SOURCE_WARN_MS));
  const staleAfterMs = Math.max(warnAfterMs, toNumber(options.tokenomistSourceStaleMs, TOKENOMIST_SOURCE_STALE_MS));

  if (!fs.existsSync(resolvedPath)) {
    return {
      ok: false,
      exists: false,
      path: resolvedPath,
      ageMs: null,
      ageHours: null,
      stale: true,
      warn: true,
      warning: {
        kind: 'missing_tokenomist_source',
        path: resolvedPath,
      },
    };
  }

  const stats = fs.statSync(resolvedPath);
  const ageMs = Math.max(0, nowMs - stats.mtimeMs);
  const ageHours = Math.round(ageMs / (60 * 60 * 1000));
  if (ageMs > staleAfterMs) {
    return {
      ok: true,
      exists: true,
      path: resolvedPath,
      mtimeMs: stats.mtimeMs,
      mtimeIso: new Date(stats.mtimeMs).toISOString(),
      ageMs,
      ageHours,
      stale: true,
      warn: true,
      warning: {
        kind: 'stale_tokenomist_source',
        path: resolvedPath,
        ageHours,
      },
    };
  }

  if (ageMs > warnAfterMs) {
    return {
      ok: true,
      exists: true,
      path: resolvedPath,
      mtimeMs: stats.mtimeMs,
      mtimeIso: new Date(stats.mtimeMs).toISOString(),
      ageMs,
      ageHours,
      stale: false,
      warn: true,
      warning: {
        kind: 'aging_tokenomist_source',
        path: resolvedPath,
        ageHours,
      },
    };
  }

  return {
    ok: true,
    exists: true,
    path: resolvedPath,
    mtimeMs: stats.mtimeMs,
    mtimeIso: new Date(stats.mtimeMs).toISOString(),
    ageMs,
    ageHours,
    stale: false,
    warn: false,
    warning: null,
  };
}

module.exports = {
  DEFAULT_TOKENOMIST_SOURCE_PATH,
  TOKENOMIST_SOURCE_WARN_MS,
  TOKENOMIST_SOURCE_STALE_MS,
  inspectTokenomistSource,
};
