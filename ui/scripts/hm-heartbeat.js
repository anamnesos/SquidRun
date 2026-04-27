#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { getProjectRoot, resolveCoordPath } = require('../config');
const { appendJsonLine, buildAnomaly, DEFAULT_ANOMALY_PATH } = require('./hm-anomaly');

const DEFAULT_HEARTBEAT_PATH = resolveCoordPath('coord/heartbeat.json', { forWrite: true });
const HEARTBEAT_GAP_MS = 18 * 60 * 1000;
const MAX_CACHED_HL_AGE_MS = 5 * 60 * 1000;

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    json: false,
    captureHl: true,
    topPriority: '',
    heartbeatPath: DEFAULT_HEARTBEAT_PATH,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '').trim();
    if (!token) continue;
    if (token === '--json') {
      args.json = true;
      continue;
    }
    if (token === '--skip-hl') {
      args.captureHl = false;
      continue;
    }
    if (token === '--top-priority' && argv[index + 1]) {
      args.topPriority = String(argv[index + 1]);
      index += 1;
      continue;
    }
    if (token === '--path' && argv[index + 1]) {
      args.heartbeatPath = path.resolve(argv[index + 1]);
      index += 1;
    }
  }

  return args;
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function runGit(projectRoot, args, fallback = '') {
  try {
    return execFileSync('git', args, {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    }).trim();
  } catch (_) {
    return fallback;
  }
}

function md5File(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const hash = crypto.createHash('md5');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function capture[private-live-ops]Snapshot(projectRoot, enabled = true) {
  if (!enabled) {
    return {
      ok: false,
      skipped: true,
      checkedAt: new Date().toISOString(),
      accountValue: null,
      positions: [],
      error: 'Skipped by --skip-hl.',
    };
  }

  const scriptPath = path.join(projectRoot, 'ui', 'scripts', 'hm-defi-status.js');
  const result = spawnSync(process.execPath, [scriptPath, '--json'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      SQUIDRUN_PROJECT_ROOT: projectRoot,
      SQUIDRUN_LIVE_OPS_CALLER: 'heartbeat',
    },
    encoding: 'utf8',
    timeout: 45_000,
  });

  const parsed = readJsonFromString(result.stdout);
  if (parsed?.ok) return parsed;

  const cached = readCached[private-live-ops]Snapshot(projectRoot);
  if (cached) {
    return {
      ...cached,
      ok: cached.ageMs <= MAX_CACHED_HL_AGE_MS,
      fallbackReason: parsed?.error || String(result.stderr || result.error?.message || 'hm-defi-status failed').trim(),
    };
  }

  return {
    ok: false,
    checkedAt: new Date().toISOString(),
    accountValue: null,
    positions: [],
    error: parsed?.error || String(result.stderr || result.error?.message || 'hm-defi-status failed').trim(),
  };
}

function readJsonFromString(value) {
  try {
    return JSON.parse(String(value || '').trim());
  } catch (_) {
    return null;
  }
}

function toNumber(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function readCached[private-live-ops]Snapshot(projectRoot) {
  const statePath = path.join(projectRoot, '.squidrun', 'runtime', 'crypto-trading-supervisor-state.json');
  const state = readJson(statePath, null);
  const account = state?.lastResult?.preMarket?.accountSnapshot;
  if (!account) return null;
  const raw = account.raw || {};
  const checkedAt = state.lastProcessedAt || new Date(toNumber(raw?.mainState?.time, Date.now())).toISOString();
  const checkedAtMs = Date.parse(checkedAt);
  const positions = Array.isArray(raw?.mainState?.assetPositions) ? raw.mainState.assetPositions : [];
  return {
    ok: false,
    cached: true,
    checkedAt,
    ageMs: Number.isFinite(checkedAtMs) ? Date.now() - checkedAtMs : null,
    accountValue: toNumber(account.equity, toNumber(raw?.marginSummary?.accountValue, null)),
    withdrawable: toNumber(account.cash, toNumber(raw?.withdrawable, null)),
    positions,
    sourcePath: statePath,
    error: null,
  };
}

function readSessionId() {
  const status = readJson(resolveCoordPath('app-status.json'), {});
  const session = Number(status?.session);
  return Number.isInteger(session) ? session : null;
}

function buildHeartbeat(projectRoot, args = {}) {
  const hlSnapshot = capture[private-live-ops]Snapshot(projectRoot, args.captureHl);
  const statusPath = resolveCoordPath('app-status.json');
  const appStatus = readJson(statusPath, {});
  const dirtyOutput = runGit(projectRoot, ['status', '--porcelain'], '');
  const memoryPath = path.join(projectRoot, 'CLAUDE.md');

  return {
    schemaVersion: 1,
    ts: new Date().toISOString(),
    src: 'architect',
    profile: process.env.SQUIDRUN_PROFILE || 'main',
    sessionId: readSessionId(),
    appStatusPath: statusPath,
    paneHost: appStatus?.paneHost || null,
    headCommit: runGit(projectRoot, ['rev-parse', 'HEAD'], null),
    branch: runGit(projectRoot, ['rev-parse', '--abbrev-ref', 'HEAD'], null),
    dirtyTree: Boolean(dirtyOutput.trim()),
    dirtyCount: dirtyOutput.split(/\r?\n/).filter((line) => line.trim()).length,
    hlSnapshotOk: Boolean(hlSnapshot.ok),
    hlSnapshotCached: Boolean(hlSnapshot.cached),
    hlSnapshotAgeMs: Number.isFinite(Number(hlSnapshot.ageMs)) ? Number(hlSnapshot.ageMs) : null,
    hlPositionCount: Array.isArray(hlSnapshot.positions) ? hlSnapshot.positions.length : 0,
    hlAccountValue: Number.isFinite(Number(hlSnapshot.accountValue)) ? Number(hlSnapshot.accountValue) : null,
    hlCheckedAt: hlSnapshot.checkedAt || null,
    hlError: hlSnapshot.error || null,
    memoryChecksum: md5File(memoryPath),
    memoryPath: path.relative(projectRoot, memoryPath).replace(/\\/g, '/'),
    topPriority: args.topPriority || null,
    restartBeingConsidered: false,
  };
}

function maybeRecordHeartbeatGap(previous, nextHeartbeat) {
  if (!previous?.ts) return null;
  const previousMs = Date.parse(previous.ts);
  if (!Number.isFinite(previousMs)) return null;
  const gapMs = Date.now() - previousMs;
  if (gapMs <= HEARTBEAT_GAP_MS) return null;

  const anomaly = buildAnomaly({
    type: 'heartbeat_gap',
    src: 'hm-heartbeat',
    severity: 'medium',
    sessionId: nextHeartbeat.sessionId,
    details: {
      previousTs: previous.ts,
      currentTs: nextHeartbeat.ts,
      gapMinutes: Math.round(gapMs / 60_000),
    },
  });
  appendJsonLine(DEFAULT_ANOMALY_PATH, anomaly);
  return anomaly;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const projectRoot = getProjectRoot();
  const previous = readJson(args.heartbeatPath, null);
  const heartbeat = buildHeartbeat(projectRoot, args);
  const gapAnomaly = maybeRecordHeartbeatGap(previous, heartbeat);

  fs.mkdirSync(path.dirname(args.heartbeatPath), { recursive: true });
  fs.writeFileSync(args.heartbeatPath, `${JSON.stringify(heartbeat, null, 2)}\n`, 'utf8');

  const result = { ok: true, path: args.heartbeatPath, heartbeat, gapAnomaly };
  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    console.log(`Heartbeat written: ${args.heartbeatPath}`);
    console.log(`  branch=${heartbeat.branch} dirty=${heartbeat.dirtyTree} hlPositions=${heartbeat.hlPositionCount}`);
  }
  return result;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error('Error:', error?.message || String(error));
    process.exitCode = 1;
  }
}

module.exports = {
  parseArgs,
  buildHeartbeat,
  maybeRecordHeartbeatGap,
  main,
};
