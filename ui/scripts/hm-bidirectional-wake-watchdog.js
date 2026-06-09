#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });

const { resolveCoordPath } = require('../config');
const { queryCommsJournalEntries } = require('../modules/main/comms-journal');
const {
  buildAlertDeliverySignals,
  runAgentPaneAutoRecoveryCycle,
} = require('../modules/main/agent-pane-auto-recovery');
const { sendAgentAlert } = require('./hm-agent-alert');
const { buildOracleWakeMessage } = require('./hm-oracle-wake-context');

const DEFAULT_INTERVAL_MS = 60 * 1000;
const DEFAULT_STATE_PATH = resolveCoordPath(path.join('runtime', 'bidirectional-wake-state.json'), { forWrite: true });
const DEFAULT_PID_PATH = resolveCoordPath(path.join('runtime', 'bidirectional-wake-watchdog.pid'), { forWrite: true });
const DEFAULT_STATUS_PATH = resolveCoordPath(path.join('runtime', 'bidirectional-wake-watchdog-status.json'), { forWrite: true });
const DEFAULT_LOG_PATH = resolveCoordPath(path.join('runtime', 'bidirectional-wake-watchdog.log'), { forWrite: true });
const DEFAULT_START_LOCK_PATH = resolveCoordPath(path.join('runtime', 'bidirectional-wake-watchdog-start.lock'), { forWrite: true });
const DEFAULT_ARCHITECT_SILENCE_MS = 8 * 60 * 1000;
const DEFAULT_ORACLE_SILENCE_MS = 10 * 60 * 1000;
const CHILD_START_GRACE_MS = 10_000;
const MIN_STATUS_STALE_AFTER_MS = 90_000;
const START_LOCK_STALE_AFTER_MS = 15_000;

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

function appendLog(filePath, message) {
  ensureDir(filePath);
  fs.appendFileSync(filePath, `${new Date().toISOString()} ${message}\n`, 'utf8');
}

function readPidInfo(pidPath = DEFAULT_PID_PATH) {
  try {
    const stat = fs.statSync(pidPath);
    return {
      pid: Number.parseInt(fs.readFileSync(pidPath, 'utf8').trim(), 10),
      mtimeMs: Number(stat.mtimeMs || 0),
    };
  } catch {
    return { pid: null, mtimeMs: 0 };
  }
}

function readStatusInfo(statusPath = DEFAULT_STATUS_PATH) {
  try {
    const stat = fs.statSync(statusPath);
    return {
      value: JSON.parse(fs.readFileSync(statusPath, 'utf8')),
      mtimeMs: Number(stat.mtimeMs || 0),
    };
  } catch {
    return { value: null, mtimeMs: 0 };
  }
}

function isPidAlive(pid) {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) return false;
  try {
    process.kill(numeric, 0);
    return true;
  } catch {
    return false;
  }
}

function timestampMs(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function buildRunnerStatusSnapshot({
  pid = null,
  pidAlive = false,
  pidMtimeMs = 0,
  statusFile = null,
  statusMtimeMs = 0,
  nowMs = Date.now(),
} = {}) {
  const numericPid = Number(pid);
  const validPid = Number.isInteger(numericPid) && numericPid > 0 ? numericPid : null;
  const statusPid = Number(statusFile?.pid);
  const statusMatchesPid = Boolean(
    validPid
    && statusFile
    && Number.isInteger(statusPid)
    && statusPid === validPid
  );
  const pidAgeMs = pidMtimeMs > 0 ? Math.max(0, nowMs - pidMtimeMs) : Infinity;
  const intervalMs = Math.max(30_000, toNumber(statusFile?.intervalMs, DEFAULT_INTERVAL_MS));
  const statusStaleAfterMs = Math.max(MIN_STATUS_STALE_AFTER_MS, intervalMs * 3);
  const statusUpdatedAtMs = timestampMs(statusFile?.heartbeatAt || statusFile?.updatedAt) || Number(statusMtimeMs) || 0;
  const statusAgeMs = statusUpdatedAtMs > 0 ? Math.max(0, nowMs - statusUpdatedAtMs) : Infinity;
  const statusFresh = Boolean(statusMatchesPid && statusAgeMs <= statusStaleAfterMs);
  const starting = Boolean(validPid && pidAlive && !statusMatchesPid && pidAgeMs <= CHILD_START_GRACE_MS);
  const running = Boolean(pidAlive && statusMatchesPid && statusFresh && statusFile?.running !== false);
  const staleHeartbeat = Boolean(pidAlive && statusMatchesPid && statusFile?.running !== false && !statusFresh);
  const stalePid = Boolean(validPid && !pidAlive);
  const unknownLivePid = Boolean(validPid && pidAlive && !statusMatchesPid && !starting);
  const reason = running
    ? null
    : (starting ? 'bidirectional_wake_watchdog_starting'
      : (staleHeartbeat ? 'stale_bidirectional_wake_watchdog_status'
        : (unknownLivePid ? 'unknown_live_bidirectional_wake_watchdog_pid'
          : (stalePid ? 'stale_bidirectional_wake_watchdog_pid' : 'not_running'))));

  return {
    ok: true,
    running,
    starting,
    pid: running || starting || staleHeartbeat ? validPid : null,
    stalePid: stalePid ? validPid : null,
    staleHeartbeat,
    unknownLivePid: unknownLivePid ? validPid : null,
    statusFresh,
    statusAgeMs: Number.isFinite(statusAgeMs) ? statusAgeMs : null,
    statusStaleAfterMs,
    reason,
    pidPath: DEFAULT_PID_PATH,
    statusPath: DEFAULT_STATUS_PATH,
    logPath: DEFAULT_LOG_PATH,
    runner: statusFile || null,
  };
}

function readRunnerStatus() {
  const pidInfo = readPidInfo();
  const statusInfo = readStatusInfo();
  return buildRunnerStatusSnapshot({
    pid: pidInfo.pid,
    pidAlive: isPidAlive(pidInfo.pid),
    pidMtimeMs: pidInfo.mtimeMs,
    statusFile: statusInfo.value,
    statusMtimeMs: statusInfo.mtimeMs,
  });
}

function cleanupRunnerMetadata() {
  try {
    fs.rmSync(DEFAULT_PID_PATH, { force: true });
  } catch {
    // Best effort stale metadata cleanup.
  }
  try {
    fs.rmSync(DEFAULT_STATUS_PATH, { force: true });
  } catch {
    // Best effort stale metadata cleanup.
  }
}

function readLockSnapshot(lockPath = DEFAULT_START_LOCK_PATH, nowMs = Date.now()) {
  try {
    const stat = fs.statSync(lockPath);
    const mtimeMs = Number(stat.mtimeMs || 0);
    return {
      lockPath,
      mtimeMs,
      size: Number(stat.size || 0),
      raw: fs.readFileSync(lockPath, 'utf8'),
      ageMs: mtimeMs > 0 ? Math.max(0, nowMs - mtimeMs) : null,
    };
  } catch {
    return null;
  }
}

function sameLockSnapshot(left = null, right = null) {
  return Boolean(
    left
    && right
    && Number(left.mtimeMs) === Number(right.mtimeMs)
    && Number(left.size) === Number(right.size)
    && String(left.raw || '') === String(right.raw || '')
  );
}

function claimStaleStartLock(lockPath = DEFAULT_START_LOCK_PATH, observedSnapshot = null, options = {}) {
  const latest = readLockSnapshot(lockPath, options.nowMs);
  if (!sameLockSnapshot(observedSnapshot, latest)) {
    return {
      claimed: false,
      reason: 'stale_lock_changed',
      lockPath,
      lockAgeMs: latest?.ageMs ?? null,
    };
  }
  const claimPath = `${lockPath}.stale-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    fs.renameSync(lockPath, claimPath);
    const claimedSnapshot = readLockSnapshot(claimPath, options.nowMs);
    if (!sameLockSnapshot(observedSnapshot, claimedSnapshot)) {
      try {
        fs.renameSync(claimPath, lockPath);
      } catch {
        // Best effort restore; returning start_in_progress prevents this process from spawning.
      }
      return {
        claimed: false,
        reason: 'stale_lock_claim_mismatch',
        lockPath,
        lockAgeMs: claimedSnapshot?.ageMs ?? null,
      };
    }
    return {
      claimed: true,
      lockPath,
      claimPath,
      lockAgeMs: latest?.ageMs ?? null,
    };
  } catch (error) {
    return {
      claimed: false,
      reason: 'stale_lock_claim_lost',
      error: error.message,
      code: error.code || null,
      lockPath,
      lockAgeMs: latest?.ageMs ?? null,
    };
  }
}

function buildStartLockOwnerToken(nowMs = Date.now()) {
  return `${process.pid}-${nowMs}-${Math.random().toString(36).slice(2)}`;
}

function acquireStartLock(lockPath = DEFAULT_START_LOCK_PATH, options = {}) {
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const staleAfterMs = Math.max(1_000, toNumber(options.staleAfterMs, START_LOCK_STALE_AFTER_MS));
  ensureDir(lockPath);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(fd, JSON.stringify({
        pid: process.pid,
        createdAt: new Date(nowMs).toISOString(),
        ownerToken: buildStartLockOwnerToken(nowMs),
      }));
      fs.closeSync(fd);
      return { acquired: true, lockPath };
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        return { acquired: false, reason: 'start_lock_failed', error: error.message, lockPath };
      }
      const lockSnapshot = readLockSnapshot(lockPath, nowMs);
      if (attempt === 0 && lockSnapshot?.ageMs !== null && lockSnapshot?.ageMs >= staleAfterMs) {
        const claim = claimStaleStartLock(lockPath, lockSnapshot, { nowMs });
        if (claim.claimed) {
          try {
            fs.rmSync(claim.claimPath, { force: true });
          } catch {
            // Best effort quarantine cleanup; the original lock path was already atomically claimed.
          }
          appendLog(DEFAULT_LOG_PATH, `[cleanup] claimed stale start lock ageMs=${claim.lockAgeMs}`);
          continue;
        }
        return {
          acquired: false,
          reason: 'start_in_progress',
          claimReason: claim.reason || 'stale_lock_claim_lost',
          error: claim.error || null,
          code: claim.code || null,
          lockAgeMs: claim.lockAgeMs,
          lockPath,
        };
      }
      return {
        acquired: false,
        reason: 'start_in_progress',
        lockAgeMs: lockSnapshot?.ageMs ?? null,
        lockPath,
      };
    }
  }
  return { acquired: false, reason: 'start_lock_not_acquired', lockPath };
}

function releaseStartLock(lockPath = DEFAULT_START_LOCK_PATH) {
  try {
    fs.rmSync(lockPath, { force: true });
    return { ok: true, lockPath };
  } catch (error) {
    return { ok: false, error: error.message, lockPath };
  }
}

function summarizeHeartbeatResult(result = {}) {
  const recoveryActions = Array.isArray(result?.agentPaneRecovery?.actions)
    ? result.agentPaneRecovery.actions
    : [];
  return {
    ok: result?.ok === true,
    statePath: result?.statePath || null,
    stateUpdatedAt: result?.state?.updatedAt || null,
    alertCount: Array.isArray(result?.alerts) ? result.alerts.length : 0,
    alerts: Array.isArray(result?.alerts)
      ? result.alerts.map((entry) => ({
        target: entry?.target || null,
        ok: entry?.result?.ok === true,
      }))
      : [],
    agentPaneRecovery: result?.agentPaneRecovery ? {
      ok: result.agentPaneRecovery.ok === true,
      status: result.agentPaneRecovery.status || null,
      actionCount: recoveryActions.length,
      actions: recoveryActions.map((action) => ({
        kind: action?.kind || null,
        paneId: action?.paneId || null,
        role: action?.role || null,
        reason: action?.reason || null,
      })),
    } : null,
  };
}

function writeRunnerStatus(payload = {}) {
  const now = new Date().toISOString();
  writeJson(DEFAULT_STATUS_PATH, {
    version: 1,
    role: 'bidirectional-wake-watchdog',
    pid: process.pid,
    updatedAt: now,
    heartbeatAt: now,
    ...payload,
  });
}

function resolveLaunchExecutable(env = process.env) {
  const override = toText(env.SQUIDRUN_BIDIRECTIONAL_WAKE_NODE_PATH || env.SQUIDRUN_NODE_PATH, '');
  if (override) return override;
  const npmNodeExecPath = toText(env.npm_node_execpath, '');
  if (npmNodeExecPath && /(?:^|[\\/])node(?:\.exe)?$/i.test(npmNodeExecPath)) {
    return npmNodeExecPath;
  }
  return process.execPath || (process.platform === 'win32' ? 'node.exe' : 'node');
}

function cleanNodeChildEnv(env = process.env) {
  const childEnv = { ...env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  return childEnv;
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
  const agentPaneDeliverySignals = [];

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
    agentPaneDeliverySignals.push(...buildAlertDeliverySignals({
      paneId: '1',
      role: 'architect',
      alertResult: result,
      message,
      nowMs,
    }));
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
    agentPaneDeliverySignals.push(...buildAlertDeliverySignals({
      paneId: '3',
      role: 'oracle',
      alertResult: result,
      message,
      nowMs,
    }));
    state.oracle.lastPokeAt = nowIso;
    alerts.push({ target: 'oracle', result, message });
  }

  let agentPaneRecovery = null;
  const recoveryOptions = options.agentPaneAutoRecovery && typeof options.agentPaneAutoRecovery === 'object'
    ? options.agentPaneAutoRecovery
    : {};
  const recoveryEnabled = options.agentPaneAutoRecovery !== false
    && String(process.env.SQUIDRUN_AGENT_PANE_AUTO_RECOVERY || '').trim().toLowerCase() !== '0'
    && String(process.env.SQUIDRUN_AGENT_PANE_AUTO_RECOVERY || '').trim().toLowerCase() !== 'false';
  if (recoveryEnabled) {
    agentPaneRecovery = await runAgentPaneAutoRecoveryCycle({
      nowMs,
      ...recoveryOptions,
      deliverySignals: [
        ...agentPaneDeliverySignals,
        ...(Array.isArray(recoveryOptions.deliverySignals) ? recoveryOptions.deliverySignals : []),
      ],
    });
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
    agentPaneRecovery,
  };
}

async function runScheduledLoop(options = {}) {
  const statePath = path.resolve(toText(options.statePath, DEFAULT_STATE_PATH));
  const intervalMs = Math.max(30_000, toNumber(options.intervalMs, DEFAULT_INTERVAL_MS));
  const agentPaneAutoRecovery = options.agentPaneAutoRecovery;
  let runCount = 0;
  let stopping = false;

  ensureDir(DEFAULT_PID_PATH);
  fs.writeFileSync(DEFAULT_PID_PATH, String(process.pid), 'utf8');
  appendLog(DEFAULT_LOG_PATH, `[start] pid=${process.pid} intervalMs=${intervalMs} statePath=${statePath}`);

  const writeStatus = (extra = {}) => {
    writeRunnerStatus({
      running: !stopping,
      intervalMs,
      statePath,
      runCount,
      ...extra,
    });
  };

  const shutdown = (signal = 'shutdown') => {
    if (stopping) return;
    stopping = true;
    appendLog(DEFAULT_LOG_PATH, `[stop] pid=${process.pid} signal=${signal}`);
    writeStatus({
      running: false,
      status: 'stopped',
      stoppedAt: new Date().toISOString(),
      stopReason: signal,
    });
    try {
      const currentPid = Number.parseInt(fs.readFileSync(DEFAULT_PID_PATH, 'utf8').trim(), 10);
      if (currentPid === process.pid) {
        fs.rmSync(DEFAULT_PID_PATH, { force: true });
      }
    } catch {
      // Best effort pid cleanup.
    }
  };

  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
    process.exit(0);
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
    process.exit(0);
  });

  while (!stopping) {
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    writeStatus({
      status: 'running_cycle',
      currentRunStartedAt: startedAt,
      lastError: null,
    });

    try {
      const result = await runHeartbeatCycle({ statePath, intervalMs, agentPaneAutoRecovery });
      runCount += 1;
      const finishedAtMs = Date.now();
      const nextRunAtMs = finishedAtMs + intervalMs;
      const summary = summarizeHeartbeatResult(result);
      writeStatus({
        status: 'waiting',
        lastRunStartedAt: startedAt,
        lastRunFinishedAt: new Date(finishedAtMs).toISOString(),
        nextRunAt: new Date(nextRunAtMs).toISOString(),
        lastResult: summary,
      });
      appendLog(
        DEFAULT_LOG_PATH,
        `[cycle] runCount=${runCount} ok=${summary.ok} stateUpdatedAt=${summary.stateUpdatedAt || 'null'}`
      );
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      runCount += 1;
      const finishedAtMs = Date.now();
      const nextRunAtMs = finishedAtMs + intervalMs;
      const message = error?.stack || error?.message || String(error);
      writeStatus({
        status: 'waiting_after_error',
        lastRunStartedAt: startedAt,
        lastRunFinishedAt: new Date(finishedAtMs).toISOString(),
        nextRunAt: new Date(nextRunAtMs).toISOString(),
        lastError: message,
      });
      appendLog(DEFAULT_LOG_PATH, `[error] runCount=${runCount} ${message}`);
      console.error(message);
    }

    if (!stopping) {
      await sleep(intervalMs);
    }
  }
}

function startRunner(options = {}) {
  const current = readRunnerStatus();
  if (current.running) {
    return { ok: true, alreadyRunning: true, ...current };
  }
  if (current.starting) {
    return { ok: true, alreadyStarting: true, ...current };
  }
  if (current.staleHeartbeat && current.pid) {
    try {
      process.kill(current.pid, 'SIGTERM');
      appendLog(DEFAULT_LOG_PATH, `[cleanup] stopped stale runner pid=${current.pid}`);
    } catch (error) {
      appendLog(DEFAULT_LOG_PATH, `[cleanup-warning] failed to stop stale runner pid=${current.pid}: ${error.message}`);
    }
  }
  if (current.stalePid || current.staleHeartbeat || current.unknownLivePid) {
    cleanupRunnerMetadata();
  }

  const lock = acquireStartLock(DEFAULT_START_LOCK_PATH, options.startLock);
  if (!lock.acquired) {
    return {
      ok: lock.reason === 'start_in_progress',
      alreadyStarting: lock.reason === 'start_in_progress',
      startInProgress: lock.reason === 'start_in_progress',
      ...lock,
    };
  }

  try {
    const rechecked = readRunnerStatus();
    if (rechecked.running) {
      return { ok: true, alreadyRunning: true, ...rechecked };
    }
    if (rechecked.starting) {
      return { ok: true, alreadyStarting: true, ...rechecked };
    }

    const statePath = path.resolve(toText(options.statePath, DEFAULT_STATE_PATH));
    const intervalMs = Math.max(30_000, toNumber(options.intervalMs, DEFAULT_INTERVAL_MS));
    const childArgs = [
      __filename,
      'run',
      '--state',
      statePath,
      '--interval-ms',
      String(intervalMs),
    ];
    if (options.agentPaneAutoRecovery === false) {
      childArgs.push('--no-agent-pane-auto-recovery');
    }

    ensureDir(DEFAULT_LOG_PATH);
    const out = fs.openSync(DEFAULT_LOG_PATH, 'a');
    const executable = resolveLaunchExecutable();
    const projectRoot = path.resolve(
      toText(options.projectRoot, '')
      || process.env.SQUIDRUN_PROJECT_ROOT
      || path.join(__dirname, '..', '..')
    );
    const child = spawn(executable, childArgs, {
      cwd: projectRoot,
      detached: true,
      stdio: ['ignore', out, out],
      env: {
        ...cleanNodeChildEnv(process.env),
        SQUIDRUN_PROJECT_ROOT: projectRoot,
      },
      windowsHide: true,
    });
    child.unref();
    fs.writeFileSync(DEFAULT_PID_PATH, String(child.pid), 'utf8');
    appendLog(DEFAULT_LOG_PATH, `[spawn] pid=${child.pid} executable=${executable} intervalMs=${intervalMs}`);
    return {
      ok: true,
      started: true,
      pid: child.pid,
      intervalMs,
      statePath,
      pidPath: DEFAULT_PID_PATH,
      statusPath: DEFAULT_STATUS_PATH,
      logPath: DEFAULT_LOG_PATH,
      executable,
    };
  } finally {
    releaseStartLock(DEFAULT_START_LOCK_PATH);
  }
}

function stopRunner() {
  const current = readRunnerStatus();
  const pid = current.pid || current.stalePid;
  if (pid && isPidAlive(pid)) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch (error) {
      return { ok: false, reason: 'stop_failed', error: error.message, ...current };
    }
  }
  cleanupRunnerMetadata();
  return {
    ok: true,
    stopped: Boolean(pid),
    pid: pid || null,
    previousStatus: current,
  };
}

async function runCli(argv = parseCliArgs()) {
  const command = toText(argv.positional[0], 'run').toLowerCase();
  const statePath = path.resolve(toText(getOption(argv.options, 'state', DEFAULT_STATE_PATH)));
  const intervalMs = Math.max(30_000, toNumber(getOption(argv.options, 'interval-ms', DEFAULT_INTERVAL_MS), DEFAULT_INTERVAL_MS));
  const agentPaneAutoRecovery = getOption(argv.options, 'no-agent-pane-auto-recovery', false) === true
    ? false
    : undefined;

  if (command === 'once') {
    const result = await runHeartbeatCycle({ statePath, intervalMs, agentPaneAutoRecovery });
    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  if (command === 'status') {
    const result = readRunnerStatus();
    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  if (command === 'start') {
    const result = startRunner({ statePath, intervalMs, agentPaneAutoRecovery });
    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  if (command === 'stop') {
    const result = stopRunner();
    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  if (command === 'restart') {
    stopRunner();
    const result = startRunner({ statePath, intervalMs, agentPaneAutoRecovery });
    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  return runScheduledLoop({ statePath, intervalMs, agentPaneAutoRecovery });
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
  DEFAULT_LOG_PATH,
  DEFAULT_PID_PATH,
  DEFAULT_STATUS_PATH,
  DEFAULT_STATE_PATH,
  buildRunnerStatusSnapshot,
  defaultState,
  isActiveWindow,
  readRunnerStatus,
  loadState,
  persistState,
  runCli,
  runHeartbeatCycle,
  runScheduledLoop,
  startRunner,
  stopRunner,
  summarizeHeartbeatResult,
};
