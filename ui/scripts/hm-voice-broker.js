#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { getProjectRoot, resolveCoordPath } = require('../config');
const { VoiceBrokerService, getVoiceBrokerConfig } = require('../modules/voice-broker');

const RUNTIME_DIR = resolveCoordPath('runtime', { forWrite: true });
const PID_PATH = path.join(RUNTIME_DIR, 'voice-broker.pid');
const LOG_PATH = path.join(RUNTIME_DIR, 'voice-broker.log');
const STATUS_PATH = path.join(RUNTIME_DIR, 'voice-broker-status.json');
const CHILD_START_GRACE_MS = 10000;
const STATUS_HEARTBEAT_INTERVAL_MS = 5000;
const STATUS_STALE_AFTER_MS = 30000;

function usage() {
  console.log('Usage: node ui/scripts/hm-voice-broker.js <start|stop|restart|status|run>');
  console.log('Starts the restartless voice broker boundary for future Realtime WebRTC UI.');
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

function trimText(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function isNodeExecutablePath(value) {
  const execPath = trimText(value);
  if (!execPath) return false;
  const candidates = [
    path.basename(execPath),
    path.win32.basename(execPath),
    path.posix.basename(execPath),
  ].map((item) => String(item || '').toLowerCase());
  return candidates.includes('node') || candidates.includes('node.exe');
}

function cleanNodeChildEnv(env = process.env) {
  const childEnv = { ...env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  return childEnv;
}

function resolveBrokerLaunchCommand(options = {}) {
  const env = options.env || process.env;
  const execPath = trimText(options.execPath) || process.execPath;
  const versions = options.versions || process.versions || {};
  const platform = options.platform || process.platform;
  const override = trimText(env.SQUIDRUN_VOICE_BROKER_NODE_PATH)
    || trimText(env.SQUIDRUN_NODE_PATH);
  if (override) {
    return {
      executable: override,
      env: cleanNodeChildEnv(env),
      source: 'override',
    };
  }

  const npmNodeExecPath = trimText(env.npm_node_execpath);
  if (isNodeExecutablePath(npmNodeExecPath)) {
    return {
      executable: npmNodeExecPath,
      env: cleanNodeChildEnv(env),
      source: 'npm_node_execpath',
    };
  }

  const runningInsideElectron = Boolean(versions.electron);
  if (!runningInsideElectron && isNodeExecutablePath(execPath)) {
    return {
      executable: execPath,
      env: cleanNodeChildEnv(env),
      source: 'process_exec_path',
    };
  }

  return {
    executable: platform === 'win32' ? 'node.exe' : 'node',
    env: cleanNodeChildEnv(env),
    source: runningInsideElectron ? 'electron_node_fallback' : 'path_node_fallback',
  };
}

function readPid() {
  try {
    return Number.parseInt(fs.readFileSync(PID_PATH, 'utf8').trim(), 10);
  } catch {
    return null;
  }
}

function readPidInfo() {
  try {
    const stat = fs.statSync(PID_PATH);
    return {
      pid: Number.parseInt(fs.readFileSync(PID_PATH, 'utf8').trim(), 10),
      mtimeMs: Number(stat.mtimeMs || 0),
    };
  } catch {
    return { pid: null, mtimeMs: 0 };
  }
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

function writeLog(message) {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${message}\n`, 'utf8');
}

function readStatusInfo() {
  try {
    const stat = fs.statSync(STATUS_PATH);
    return {
      value: JSON.parse(fs.readFileSync(STATUS_PATH, 'utf8')),
      mtimeMs: Number(stat.mtimeMs || 0),
    };
  } catch {
    return { value: null, mtimeMs: 0 };
  }
}

function timestampMs(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function buildStatusSnapshot({
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
  const statusUpdatedAtMs = timestampMs(statusFile?.heartbeatAt || statusFile?.updatedAt) || Number(statusMtimeMs) || 0;
  const statusAgeMs = statusUpdatedAtMs > 0 ? Math.max(0, nowMs - statusUpdatedAtMs) : Infinity;
  const statusFresh = Boolean(statusMatchesPid && statusAgeMs <= STATUS_STALE_AFTER_MS);
  const starting = Boolean(pidAlive && !statusMatchesPid && pidAgeMs <= CHILD_START_GRACE_MS);
  const running = Boolean(pidAlive && statusMatchesPid && statusFresh && statusFile?.running !== false);
  const stalePid = Boolean(pidAlive && !running && !starting);
  const staleStatus = Boolean(statusFile && !statusMatchesPid);
  const staleHeartbeat = Boolean(pidAlive && statusMatchesPid && statusFile?.running !== false && !statusFresh);
  const reason = running
    ? null
    : (starting ? 'broker_starting'
      : (staleHeartbeat ? 'stale_voice_broker_status'
        : (stalePid ? 'stale_voice_broker_pid' : 'not_running')));

  return {
    ok: true,
    running,
    starting,
    pid: running || starting ? validPid : null,
    stalePid: stalePid ? validPid : null,
    staleStatus,
    staleHeartbeat,
    statusFresh,
    statusAgeMs: Number.isFinite(statusAgeMs) ? statusAgeMs : null,
    statusStaleAfterMs: STATUS_STALE_AFTER_MS,
    reason,
    pidPath: PID_PATH,
    logPath: LOG_PATH,
    statusPath: STATUS_PATH,
    broker: running ? statusFile : null,
  };
}

function status() {
  const pidInfo = readPidInfo();
  const statusInfo = readStatusInfo();
  return buildStatusSnapshot({
    pid: pidInfo.pid,
    pidAlive: isPidAlive(pidInfo.pid),
    pidMtimeMs: pidInfo.mtimeMs,
    statusFile: statusInfo.value,
    statusMtimeMs: statusInfo.mtimeMs,
  });
}

async function runBroker() {
  require('dotenv').config({ path: path.join(getProjectRoot(), '.env') });
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  fs.writeFileSync(PID_PATH, String(process.pid), 'utf8');
  const broker = new VoiceBrokerService({
    config: getVoiceBrokerConfig(process.env),
  });

  let statusHeartbeatTimer = null;
  const writeStatus = (extra = {}) => {
    const now = new Date().toISOString();
    writeJson(STATUS_PATH, {
      pid: process.pid,
      updatedAt: now,
      heartbeatAt: now,
      ...broker.getStatus(),
      ...extra,
    });
  };

  try {
    const started = await broker.start();
    if (!started?.ok) {
      writeLog(`[error] start skipped: ${started?.reason || 'not_started'}`);
      writeStatus(started);
      process.exit(1);
    }
    writeLog(`[start] pid=${process.pid} address=${JSON.stringify(started.address)}`);
    writeStatus();
    statusHeartbeatTimer = setInterval(() => writeStatus(), STATUS_HEARTBEAT_INTERVAL_MS);
    statusHeartbeatTimer?.unref?.();
  } catch (err) {
    writeLog(`[error] start failed: ${err.message}`);
    writeStatus({ ok: false, lastError: err.message });
    process.exit(1);
  }

  const shutdown = async () => {
    if (statusHeartbeatTimer) {
      clearInterval(statusHeartbeatTimer);
      statusHeartbeatTimer = null;
    }
    try {
      await broker.stop();
      writeLog(`[stop] pid=${process.pid}`);
      writeStatus({ running: false });
    } catch (err) {
      writeLog(`[warn] stop failed: ${err.message}`);
    }
    try {
      if (readPid() === process.pid) fs.rmSync(PID_PATH, { force: true });
    } catch {
      // Best effort.
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => { void shutdown(); });
  process.on('SIGINT', () => { void shutdown(); });
}

function start() {
  const current = status();
  if (current.running) return { ok: true, alreadyRunning: true, ...current };
  if (current.starting) return { ok: true, alreadyStarting: true, ...current };
  if (current.stalePid) {
    try {
      process.kill(current.stalePid, 'SIGTERM');
    } catch {
      // Best effort stale child cleanup.
    }
    try {
      fs.rmSync(PID_PATH, { force: true });
      fs.rmSync(STATUS_PATH, { force: true });
    } catch {
      // Best effort stale metadata cleanup.
    }
  } else if (current.staleStatus) {
    try {
      fs.rmSync(PID_PATH, { force: true });
      fs.rmSync(STATUS_PATH, { force: true });
    } catch {
      // Best effort stale metadata cleanup.
    }
  }
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  const out = fs.openSync(LOG_PATH, 'a');
  const launch = resolveBrokerLaunchCommand();
  const child = spawn(launch.executable, [__filename, 'run'], {
    cwd: getProjectRoot(),
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...launch.env, SQUIDRUN_PROJECT_ROOT: getProjectRoot() },
    windowsHide: true,
  });
  child.unref();
  fs.writeFileSync(PID_PATH, String(child.pid), 'utf8');
  return {
    ok: true,
    started: true,
    pid: child.pid,
    pidPath: PID_PATH,
    logPath: LOG_PATH,
    statusPath: STATUS_PATH,
    executable: launch.executable,
    launchSource: launch.source,
  };
}

function stop() {
  const pid = readPid();
  if (!isPidAlive(pid)) {
    fs.rmSync(PID_PATH, { force: true });
    return { ok: true, stopped: false, reason: 'not_running', pidPath: PID_PATH };
  }
  process.kill(pid, 'SIGTERM');
  return { ok: true, stopped: true, pid, pidPath: PID_PATH };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPidExit(pid, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (isPidAlive(pid) && Date.now() - startedAt < timeoutMs) {
    await delay(100);
  }
  return !isPidAlive(pid);
}

async function restart() {
  const stopResult = stop();
  if (stopResult.pid) {
    await waitForPidExit(stopResult.pid);
  }
  return {
    ok: true,
    action: 'restart-voice-broker',
    stop: stopResult,
    start: start(),
    note: 'Voice broker restart requested without reloading panes or Electron.',
  };
}

async function main(argv = process.argv.slice(2)) {
  const command = String(argv[0] || 'status').trim().toLowerCase();
  if (command === '--help' || command === '-h') {
    usage();
    return 0;
  }
  if (command === 'run') {
    await runBroker();
    return 0;
  }
  let result;
  if (command === 'start') result = start();
  else if (command === 'stop') result = stop();
  else if (command === 'restart') result = await restart();
  else if (command === 'status') result = status();
  else {
    usage();
    return 1;
  }
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  CHILD_START_GRACE_MS,
  STATUS_HEARTBEAT_INTERVAL_MS,
  STATUS_STALE_AFTER_MS,
  buildStatusSnapshot,
  isPidAlive,
  isNodeExecutablePath,
  resolveBrokerLaunchCommand,
  start,
  status,
  stop,
  restart,
};
