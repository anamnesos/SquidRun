'use strict';

const fs = require('fs');
const path = require('path');

const { resolveCoordPath } = require('../config');

const DEFAULT_RUNTIME_CONFIG_PATH = resolveCoordPath(
  path.join('runtime', 'runtime-config.json'),
  { forWrite: true }
);
const CACHE_TTL_MS = 2000;

let cachedConfig = null;
let cachedAtMs = 0;
let cachedMtimeMs = 0;

function toPositiveInt(value, fallback) {
  const numeric = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return numeric;
}

function readRuntimeConfig(options = {}) {
  const configPath = options.configPath || DEFAULT_RUNTIME_CONFIG_PATH;
  const nowMs = Date.now();
  if (cachedConfig && (nowMs - cachedAtMs) <= CACHE_TTL_MS) {
    return cachedConfig;
  }

  try {
    const stat = fs.statSync(configPath);
    if (cachedConfig && stat.mtimeMs === cachedMtimeMs) {
      cachedAtMs = nowMs;
      return cachedConfig;
    }
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    cachedConfig = (parsed && typeof parsed === 'object') ? parsed : {};
    cachedAtMs = nowMs;
    cachedMtimeMs = stat.mtimeMs;
    return cachedConfig;
  } catch {
    cachedConfig = {};
    cachedAtMs = nowMs;
    cachedMtimeMs = 0;
    return cachedConfig;
  }
}

function resolveRuntimeInt(key, fallback, options = {}) {
  const config = readRuntimeConfig(options);
  return toPositiveInt(config?.[key], fallback);
}

module.exports = {
  DEFAULT_RUNTIME_CONFIG_PATH,
  readRuntimeConfig,
  resolveRuntimeInt,
};
