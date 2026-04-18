#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });

const { resolveCoordPath } = require('../config');
const { sendAgentAlert } = require('./hm-agent-alert');

const DEFAULT_STATE_PATH = resolveCoordPath(path.join('runtime', 'oracle-wake-state.json'), { forWrite: true });
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

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

function defaultState() {
  return {
    version: 1,
    lastWakeAt: null,
    lastResult: null,
    lastMessage: null,
    wakeCount: 0,
    intervalMs: DEFAULT_INTERVAL_MS,
    updatedAt: null,
  };
}

function buildWakeMessage() {
  return '(ARCHITECT ORACLE-WAKE): scan now and emit signal directly to architect if any name is armed.';
}

function loadState(statePath = DEFAULT_STATE_PATH) {
  return {
    ...defaultState(),
    ...(readJson(statePath, defaultState()) || {}),
  };
}

function persistState(statePath, state) {
  writeJson(statePath, {
    ...defaultState(),
    ...(state || {}),
  });
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

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runWakeCycle(options = {}) {
  const nowIso = new Date().toISOString();
  const statePath = path.resolve(toText(options.statePath, DEFAULT_STATE_PATH));
  const intervalMs = Math.max(60_000, toNumber(options.intervalMs, DEFAULT_INTERVAL_MS));
  const previousState = loadState(statePath);
  const message = toText(options.message, buildWakeMessage());
  const alertResult = sendAgentAlert(message, {
    targets: ['oracle'],
    role: 'oracle-wake-watchdog',
    cwd: process.env.SQUIDRUN_PROJECT_ROOT || path.join(__dirname, '..', '..'),
    env: process.env,
  });
  const nextState = {
    ...previousState,
    intervalMs,
    lastWakeAt: nowIso,
    lastMessage: message,
    wakeCount: toNumber(previousState.wakeCount, 0) + 1,
    lastResult: alertResult,
    updatedAt: nowIso,
  };
  persistState(statePath, nextState);
  return {
    ok: alertResult.ok === true,
    statePath,
    state: nextState,
    alertResult,
  };
}

async function runCli(argv = parseCliArgs()) {
  const command = toText(argv.positional[0], 'run').toLowerCase();
  const statePath = path.resolve(toText(getOption(argv.options, 'state', DEFAULT_STATE_PATH)));
  const intervalMs = Math.max(60_000, toNumber(getOption(argv.options, 'interval-ms', DEFAULT_INTERVAL_MS), DEFAULT_INTERVAL_MS));

  if (command === 'once') {
    const result = runWakeCycle({ statePath, intervalMs });
    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  while (true) {
    const result = runWakeCycle({ statePath, intervalMs });
    console.log(JSON.stringify(result, null, 2));
    await sleep(intervalMs);
  }
}

if (require.main === module) {
  runCli().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_INTERVAL_MS,
  DEFAULT_STATE_PATH,
  buildWakeMessage,
  defaultState,
  loadState,
  persistState,
  parseCliArgs,
  runWakeCycle,
  runCli,
};
