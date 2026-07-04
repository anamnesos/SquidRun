#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });

const { resolveCoordPath } = require('../config');

const DEFAULT_CONFIG_PATH = resolveCoordPath(path.join('runtime', 'architect-quiet-watch-config.json'), { forWrite: true });
const DEFAULT_STATE_PATH = resolveCoordPath(path.join('runtime', 'architect-quiet-watch-state.json'), { forWrite: true });
const DEFAULT_INTERVAL_MS = 60 * 1000;
const HEARTBEAT_STALE_AFTER_MS = 3 * DEFAULT_INTERVAL_MS;

function toText(value, fallback = '') {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
}

function readJson(filePath, fallback = null) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, payload) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
}

function computeHeartbeatStale(lastTickAt, nowMs = Date.now(), staleAfterMs = HEARTBEAT_STALE_AFTER_MS) {
  const tickMs = Date.parse(toText(lastTickAt, ''));
  if (!Number.isFinite(tickMs)) return true;
  const thresholdMs = toNumber(staleAfterMs, HEARTBEAT_STALE_AFTER_MS);
  return nowMs - tickMs > thresholdMs;
}

function loadConfig(configPath = DEFAULT_CONFIG_PATH) {
  const config = readJson(configPath, {}) || {};
  return {
    intervalMs: Math.max(10_000, toNumber(config.intervalMs, DEFAULT_INTERVAL_MS)),
    staleAfterMs: Math.max(10_000, toNumber(config.staleAfterMs, HEARTBEAT_STALE_AFTER_MS)),
    note: toText(config.note, 'architect quiet heartbeat'),
  };
}

function writeHeartbeat(options = {}) {
  const nowMs = toNumber(options.nowMs, Date.now());
  const configPath = path.resolve(toText(options.configPath, DEFAULT_CONFIG_PATH));
  const statePath = path.resolve(toText(options.statePath, DEFAULT_STATE_PATH));
  const config = {
    ...loadConfig(configPath),
    ...(options.config || {}),
  };
  const prior = readJson(statePath, {}) || {};
  const nowIso = new Date(nowMs).toISOString();
  const heartbeat = {
    ...(prior.heartbeat || {}),
    pid: process.pid,
    lastTickAt: nowIso,
    staleAfterMs: config.staleAfterMs,
    expiresAt: new Date(nowMs + config.staleAfterMs).toISOString(),
    state: 'green',
    stale: false,
    staleReason: null,
    lastObservedAt: nowIso,
  };
  const next = {
    ...prior,
    version: 1,
    kind: 'architect_quiet_watch',
    configPath,
    statePath,
    note: config.note,
    intervalMs: config.intervalMs,
    heartbeat,
    updatedAt: nowIso,
  };
  writeJson(statePath, next);
  return next;
}

function parseCliArgs(argv = process.argv.slice(2)) {
  const positional = [];
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2).trim();
    const next = argv[index + 1];
    const value = (!next || next.startsWith('--')) ? true : next;
    if (value !== true) index += 1;
    options.set(key, value);
  }
  return { positional, options };
}

function getOption(options, key, fallback = null) {
  if (!options || typeof options.has !== 'function' || !options.has(key)) return fallback;
  return options.get(key);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runCli(argv = process.argv.slice(2)) {
  const parsed = parseCliArgs(argv);
  const command = toText(parsed.positional[0], 'run');
  if (command !== 'run' && command !== 'once') {
    throw new Error(`Unknown command: ${command}`);
  }
  const configPath = toText(getOption(parsed.options, 'config', DEFAULT_CONFIG_PATH), DEFAULT_CONFIG_PATH);
  const statePath = toText(getOption(parsed.options, 'state', DEFAULT_STATE_PATH), DEFAULT_STATE_PATH);
  const once = command === 'once' || getOption(parsed.options, 'once', false) === true;
  let result = writeHeartbeat({ configPath, statePath });
  console.log(JSON.stringify(result, null, 2));
  if (once) return result;

  while (true) {
    const intervalMs = toNumber(readJson(statePath, {})?.intervalMs, DEFAULT_INTERVAL_MS);
    await sleep(Math.max(10_000, intervalMs));
    result = writeHeartbeat({ configPath, statePath });
    console.log(JSON.stringify(result, null, 2));
  }
}

if (require.main === module) {
  runCli().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_CONFIG_PATH,
  DEFAULT_STATE_PATH,
  DEFAULT_INTERVAL_MS,
  HEARTBEAT_STALE_AFTER_MS,
  computeHeartbeatStale,
  loadConfig,
  writeHeartbeat,
  runCli,
};
