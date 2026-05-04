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

function readPid() {
  try {
    return Number.parseInt(fs.readFileSync(PID_PATH, 'utf8').trim(), 10);
  } catch {
    return null;
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

function readStatusFile() {
  try {
    return JSON.parse(fs.readFileSync(STATUS_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function status() {
  const pid = readPid();
  const running = isPidAlive(pid);
  return {
    ok: true,
    running,
    pid: running ? pid : null,
    pidPath: PID_PATH,
    logPath: LOG_PATH,
    statusPath: STATUS_PATH,
    broker: running ? readStatusFile() : null,
  };
}

async function runBroker() {
  require('dotenv').config({ path: path.join(getProjectRoot(), '.env') });
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  fs.writeFileSync(PID_PATH, String(process.pid), 'utf8');
  const broker = new VoiceBrokerService({
    config: getVoiceBrokerConfig(process.env),
  });

  const writeStatus = (extra = {}) => {
    writeJson(STATUS_PATH, {
      pid: process.pid,
      updatedAt: new Date().toISOString(),
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
  } catch (err) {
    writeLog(`[error] start failed: ${err.message}`);
    writeStatus({ ok: false, lastError: err.message });
    process.exit(1);
  }

  const shutdown = async () => {
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
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  const out = fs.openSync(LOG_PATH, 'a');
  const child = spawn(process.execPath, [__filename, 'run'], {
    cwd: getProjectRoot(),
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, SQUIDRUN_PROJECT_ROOT: getProjectRoot() },
    windowsHide: true,
  });
  child.unref();
  fs.writeFileSync(PID_PATH, String(child.pid), 'utf8');
  return { ok: true, started: true, pid: child.pid, pidPath: PID_PATH, logPath: LOG_PATH, statusPath: STATUS_PATH };
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
  isPidAlive,
  start,
  status,
  stop,
  restart,
};
