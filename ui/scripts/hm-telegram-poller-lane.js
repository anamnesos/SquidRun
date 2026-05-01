#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const { getProjectRoot, resolveCoordPath } = require('../config');
const { buildProfileTelegramEnv } = require('../profile');
const telegramPoller = require('../modules/telegram-poller');

const RUNTIME_DIR = resolveCoordPath('runtime', { forWrite: true });
const PID_PATH = path.join(RUNTIME_DIR, 'telegram-poller-lane.pid');
const LOG_PATH = path.join(RUNTIME_DIR, 'telegram-poller-lane.log');

function usage() {
  console.log('Usage: node ui/scripts/hm-telegram-poller-lane.js <start|stop|status|run>');
  console.log('Starts a single-owner Telegram poller lane outside Electron when the app worker is stale.');
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

function writeLog(message) {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${message}\n`, 'utf8');
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
  };
}

function sendToArchitect(message) {
  const projectRoot = getProjectRoot();
  const hmSendPath = path.join(projectRoot, 'ui', 'scripts', 'hm-send.js');
  const run = spawnSync(process.execPath, [hmSendPath, 'architect', '--stdin', '--role', 'system'], {
    cwd: projectRoot,
    env: { ...process.env, SQUIDRUN_PROJECT_ROOT: projectRoot },
    input: message,
    encoding: 'utf8',
    timeout: 20_000,
  });
  if (run.status !== 0) {
    writeLog(`[warn] hm-send failed: ${String(run.stderr || run.error?.message || 'unknown').trim()}`);
  }
}

function formatInbound(text, from, metadata = {}) {
  const sender = typeof from === 'string' && from.trim() ? from.trim() : 'unknown';
  const media = metadata?.media && typeof metadata.media === 'object' ? metadata.media : null;
  let body = typeof text === 'string' ? text.trim() : '';
  if (!body && media?.kind === 'photo') {
    body = '[Photo received]';
  } else if (!body && media?.kind === 'video') {
    body = '[Video received]';
  } else if (!body && media?.kind === 'document') {
    const fileName = typeof media.fileName === 'string' && media.fileName.trim()
      ? media.fileName.trim()
      : 'unknown';
    body = `[File: ${fileName}]`;
  }
  if (!body) return null;
  const archivePath = typeof media?.localPath === 'string' && media.localPath.trim()
    ? media.localPath.trim()
    : null;
  return `[Telegram from ${sender}]: ${archivePath ? `${body} | saved: ${archivePath}` : body}`;
}

function runLane() {
  require('dotenv').config({ path: path.join(getProjectRoot(), '.env') });
  fs.mkdirSync(path.dirname(PID_PATH), { recursive: true });
  fs.writeFileSync(PID_PATH, String(process.pid), 'utf8');
  writeLog(`[start] pid=${process.pid}`);

  const started = telegramPoller.start({
    env: {
      ...buildProfileTelegramEnv(process.env, 'main'),
      SQUIDRUN_TELEGRAM_ACCEPT_SCOPED_CHATS: '1',
    },
    onMessage: (text, from, metadata = {}) => {
      const formatted = formatInbound(text, from, metadata);
      if (!formatted) {
        writeLog(`[drop] empty inbound update=${metadata?.updateId ?? 'unknown'}`);
        return;
      }
      writeLog(`[inbound] update=${metadata?.updateId ?? 'unknown'} media=${metadata?.media?.kind || 'none'}`);
      sendToArchitect(formatted);
    },
  });

  if (!started) {
    writeLog('[error] Telegram poller did not start; missing config');
    process.exit(1);
  }

  const shutdown = () => {
    try {
      telegramPoller.stop();
    } catch {
      // Best effort.
    }
    try {
      if (readPid() === process.pid) fs.rmSync(PID_PATH, { force: true });
    } catch {
      // Best effort.
    }
    writeLog(`[stop] pid=${process.pid}`);
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

function startLane() {
  const current = status();
  if (current.running) return { ok: true, alreadyRunning: true, ...current };
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
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
  return { ok: true, started: true, pid: child.pid, pidPath: PID_PATH, logPath: LOG_PATH };
}

function stopLane() {
  const pid = readPid();
  if (!isPidAlive(pid)) {
    fs.rmSync(PID_PATH, { force: true });
    return { ok: true, stopped: false, reason: 'not_running', pidPath: PID_PATH };
  }
  process.kill(pid, 'SIGTERM');
  return { ok: true, stopped: true, pid, pidPath: PID_PATH };
}

function main(argv = process.argv.slice(2)) {
  const command = String(argv[0] || 'status').trim().toLowerCase();
  if (command === '--help' || command === '-h') {
    usage();
    return;
  }
  let result;
  if (command === 'run') {
    runLane();
    return;
  } else if (command === 'start') {
    result = startLane();
  } else if (command === 'stop') {
    result = stopLane();
  } else if (command === 'status') {
    result = status();
  } else {
    usage();
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  formatInbound,
  isPidAlive,
  status,
  startLane,
  stopLane,
};
