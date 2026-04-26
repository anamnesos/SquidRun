#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });

const { resolveCoordPath } = require('../config');
const { queryCommsJournalEntries } = require('../modules/main/comms-journal');
const { sendAgentAlert } = require('./hm-agent-alert');
const { buildOracleWakeMessage } = require('./hm-oracle-wake-context');

const DEFAULT_STATE_PATH = resolveCoordPath(path.join('runtime', 'bidirectional-wake-state.json'), { forWrite: true });
const DEFAULT_INTERVAL_MS = 60 * 1000;
const DEFAULT_ARCHITECT_SILENCE_MS = 8 * 60 * 1000;
const DEFAULT_ORACLE_SILENCE_MS = 10 * 60 * 1000;

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
    architect: {
      lastSeenAt: null,
      lastPokeAt: null,
    },
    oracle: {
      lastSeenAt: null,
      lastPokeAt: null,
    },
    intervalMs: DEFAULT_INTERVAL_MS,
    updatedAt: null,
  };
}

function loadState(statePath = DEFAULT_STATE_PATH) {
  return {
    ...defaultState(),
    ...(readJson(statePath, defaultState()) || {}),
    architect: {
      ...defaultState().architect,
      ...((readJson(statePath, defaultState()) || {}).architect || {}),
    },
    oracle: {
      ...defaultState().oracle,
      ...((readJson(statePath, defaultState()) || {}).oracle || {}),
    },
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

function getPacificHour(nowMs = Date.now()) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: 'numeric',
    hour12: false,
  });
  return Number(formatter.format(new Date(nowMs)));
}

function isActiveWindow(nowMs = Date.now()) {
  const hour = getPacificHour(nowMs);
  return (hour >= 0 && hour < 3)
    || (hour >= 5 && hour < 9)
    || (hour >= 16 && hour < 20);
}

function latestSeenAt(filters = {}, nowMs = Date.now()) {
  const rows = queryCommsJournalEntries({
    ...filters,
    sinceMs: nowMs - (24 * 60 * 60 * 1000),
    order: 'desc',
    limit: 50,
  });
  const latest = Array.isArray(rows) ? rows[0] : null;
  if (!latest) return null;
  return new Date(toNumber(latest.sentAtMs || latest.brokeredAtMs, nowMs)).toISOString();
}

function shouldRepoke(lastPokeAt, nowMs, thresholdMs) {
  const lastPokeMs = new Date(toText(lastPokeAt, '')).getTime();
  if (!Number.isFinite(lastPokeMs) || lastPokeMs <= 0) return true;
  return (nowMs - lastPokeMs) >= thresholdMs;
}

async function runHeartbeatCycle(options = {}) {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const statePath = path.resolve(toText(options.statePath, DEFAULT_STATE_PATH));
  const intervalMs = Math.max(30_000, toNumber(options.intervalMs, DEFAULT_INTERVAL_MS));
  const architectSilenceMs = Math.max(30_000, toNumber(options.architectSilenceMs, DEFAULT_ARCHITECT_SILENCE_MS));
  const oracleSilenceMs = Math.max(60_000, toNumber(options.oracleSilenceMs, DEFAULT_ORACLE_SILENCE_MS));
  const architectSilenceMinutes = Math.round(architectSilenceMs / 60_000);
  const oracleSilenceMinutes = Math.round(oracleSilenceMs / 60_000);
  const state = loadState(statePath);

  const architectLastSeenAt = latestSeenAt({
    senderRole: 'architect',
    targetRole: 'oracle',
    direction: 'outbound',
  }, nowMs);
  const oracleLastSeenAt = latestSeenAt({
    senderRole: 'oracle',
    targetRole: 'architect',
    direction: 'outbound',
  }, nowMs);
  const architectLastSeenMs = new Date(toText(architectLastSeenAt, '')).getTime();
  const oracleLastSeenMs = new Date(toText(oracleLastSeenAt, '')).getTime();
  const alerts = [];

  if (isActiveWindow(nowMs)
    && Number.isFinite(architectLastSeenMs)
    && (nowMs - architectLastSeenMs) >= architectSilenceMs
    && shouldRepoke(state.architect?.lastPokeAt, nowMs, architectSilenceMs)) {
    const message = `(ORACLE PEER-WAKE): Architect silent >${architectSilenceMinutes}m during active window. Status check now.`;
    const result = sendAgentAlert(message, {
      targets: ['architect'],
      role: 'oracle-peer-wake',
      cwd: process.env.SQUIDRUN_PROJECT_ROOT || path.join(__dirname, '..', '..'),
      env: process.env,
    });
    state.architect.lastPokeAt = nowIso;
    alerts.push({ target: 'architect', result, message });
  }

  if (Number.isFinite(oracleLastSeenMs)
    && (nowMs - oracleLastSeenMs) >= oracleSilenceMs
    && shouldRepoke(state.oracle?.lastPokeAt, nowMs, oracleSilenceMs)) {
    const message = await buildOracleWakeMessage(
      `(ARCHITECT PEER-WAKE): Oracle silent >${oracleSilenceMinutes}m. Status check now.`,
      {
        watchRulesPath: options.watchRulesPath,
        watchStatePath: options.watchStatePath,
        marketScannerStatePath: options.marketScannerStatePath,
        staleDistancePct: options.staleDistancePct,
        nowMs,
      }
    );
    const result = sendAgentAlert(message, {
      targets: ['oracle'],
      role: 'architect-peer-wake',
      cwd: process.env.SQUIDRUN_PROJECT_ROOT || path.join(__dirname, '..', '..'),
      env: process.env,
    });
    state.oracle.lastPokeAt = nowIso;
    alerts.push({ target: 'oracle', result, message });
  }

  state.intervalMs = intervalMs;
  state.architect.lastSeenAt = architectLastSeenAt;
  state.oracle.lastSeenAt = oracleLastSeenAt;
  state.updatedAt = nowIso;
  persistState(statePath, state);

  return {
    ok: alerts.every((entry) => entry.result?.ok === true),
    statePath,
    state,
    alerts,
  };
}

async function runCli(argv = parseCliArgs()) {
  const command = toText(argv.positional[0], 'run').toLowerCase();
  const statePath = path.resolve(toText(getOption(argv.options, 'state', DEFAULT_STATE_PATH)));
  const intervalMs = Math.max(30_000, toNumber(getOption(argv.options, 'interval-ms', DEFAULT_INTERVAL_MS), DEFAULT_INTERVAL_MS));

  if (command === 'once') {
    const result = await runHeartbeatCycle({ statePath, intervalMs });
    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  while (true) {
    const result = await runHeartbeatCycle({ statePath, intervalMs });
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
  DEFAULT_ARCHITECT_SILENCE_MS,
  DEFAULT_INTERVAL_MS,
  DEFAULT_ORACLE_SILENCE_MS,
  DEFAULT_STATE_PATH,
  defaultState,
  isActiveWindow,
  loadState,
  persistState,
  runCli,
  runHeartbeatCycle,
};
