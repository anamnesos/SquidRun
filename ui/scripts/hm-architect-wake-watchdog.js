#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });

const { resolveCoordPath } = require('../config');
const { queryCommsJournalEntries } = require('../modules/main/comms-journal');
const { sendAgentAlert } = require('./hm-agent-alert');

const DEFAULT_STATE_PATH = resolveCoordPath(path.join('runtime', 'architect-wake-state.json'), { forWrite: true });
const DEFAULT_DIRECT_EXECUTOR_STATE_PATH = resolveCoordPath(path.join('runtime', 'oracle-direct-execution-state.json'), { forWrite: true });
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

function normalizeOracleScanBody(rawBody = '') {
  const normalized = String(rawBody || '').trim();
  return normalized || 'none';
}

function loadLatestOracleScan() {
  const rows = queryCommsJournalEntries({
    senderRole: 'oracle',
    sinceMs: Date.now() - (24 * 60 * 60 * 1000),
    order: 'desc',
    limit: 200,
  });
  return (Array.isArray(rows) ? rows : []).find((entry) => {
    const body = toText(entry.rawBody, '');
    return /Scan complete|Signal:/i.test(body);
  }) || null;
}

function summarizeDirectExecutor(state = {}) {
  const signals = Object.values(state.signals || {});
  if (signals.length === 0) {
    return `direct-executor lastScan=${toText(state.lastScanAt, 'never')} no signals`;
  }
  const latest = signals
    .slice()
    .sort((left, right) => Date.parse(toText(right.updatedAt, '')) - Date.parse(toText(left.updatedAt, '')))[0];
  const ticker = toText(latest.ticket?.ticker || latest.closeSignal?.ticker, 'unknown');
  return `direct-executor lastScan=${toText(state.lastScanAt, 'never')} latest=${ticker} status=${toText(latest.status, 'unknown')}`;
}

function buildWakeMessage(context = {}) {
  return [
    '(BUILDER ARCH-WAKE): status check.',
    `Latest Oracle scan:\n${context.oracleScanSummary || 'none'}`,
    context.directExecutorSummary || 'direct-executor unknown',
    'Any gaps?',
  ].join('\n\n');
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
  const directExecutorStatePath = path.resolve(toText(options.directExecutorStatePath, DEFAULT_DIRECT_EXECUTOR_STATE_PATH));
  const intervalMs = Math.max(60_000, toNumber(options.intervalMs, DEFAULT_INTERVAL_MS));
  const previousState = loadState(statePath);
  const latestOracleScan = loadLatestOracleScan();
  const directExecutorState = readJson(directExecutorStatePath, { signals: {}, lastScanAt: null }) || { signals: {}, lastScanAt: null };
  const context = {
    oracleScanSummary: latestOracleScan ? normalizeOracleScanBody(latestOracleScan.rawBody) : 'none',
    directExecutorSummary: summarizeDirectExecutor(directExecutorState),
  };
  const message = toText(options.message, buildWakeMessage(context));
  const alertResult = sendAgentAlert(message, {
    targets: ['architect'],
    role: 'architect-wake-watchdog',
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
    latestOracleScanAt: latestOracleScan
      ? new Date(toNumber(latestOracleScan.sentAtMs || latestOracleScan.brokeredAtMs, Date.now())).toISOString()
      : null,
    directExecutorLastScanAt: toText(directExecutorState.lastScanAt, null),
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
  DEFAULT_DIRECT_EXECUTOR_STATE_PATH,
  DEFAULT_INTERVAL_MS,
  DEFAULT_STATE_PATH,
  buildWakeMessage,
  defaultState,
  loadLatestOracleScan,
  loadState,
  normalizeOracleScanBody,
  persistState,
  runWakeCycle,
  runCli,
  summarizeDirectExecutor,
};
