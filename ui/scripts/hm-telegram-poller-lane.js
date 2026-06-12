#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const { getProjectRoot, resolveCoordPath } = require('../config');
const { buildProfileTelegramEnv, getProfileProjectRootOverride } = require('../profile');
const telegramPoller = require('../modules/telegram-poller');
const { resolveTelegramInboundRoute } = require('./hm-telegram-routing');
const { resolveRuntimeUiScriptPath } = require('./runtime-ui-paths');

const RUNTIME_DIR = resolveCoordPath('runtime', { forWrite: true });
const PID_PATH = path.join(RUNTIME_DIR, 'telegram-poller-lane.pid');
const LOG_PATH = path.join(RUNTIME_DIR, 'telegram-poller-lane.log');
const KEEPALIVE_INTERVAL_MS = 60_000;
const MAIN_TELEGRAM_WORKER_PATTERN = /modules[\\/]+main[\\/]+telegram-poller-worker\.js/i;
const POLLER_STATE_REL_PATH = path.join('.squidrun', 'runtime', 'telegram-poller-state.json');

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

function readProcessListText() {
  try {
    if (process.platform === 'win32') {
      const result = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.CommandLine)\" }",
        ],
        {
          encoding: 'utf8',
          timeout: 10_000,
          windowsHide: true,
        }
      );
      return result.status === 0 ? String(result.stdout || '') : '';
    }
    const result = spawnSync('ps', ['-eo', 'pid=,command='], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    return result.status === 0 ? String(result.stdout || '') : '';
  } catch {
    return '';
  }
}

function normalizeRootPath(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return path.resolve(value.trim());
}

function resolveExpectedDataRoot(env = process.env) {
  return normalizeRootPath(env.SQUIDRUN_DATA_ROOT)
    || normalizeRootPath(getProjectRoot())
    || normalizeRootPath(env.SQUIDRUN_PROJECT_ROOT);
}

function readJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function resolvePollerStatePath(projectRoot = getProjectRoot()) {
  return path.join(path.resolve(String(projectRoot || getProjectRoot() || process.cwd())), POLLER_STATE_REL_PATH);
}

function readMainTelegramWorkerOwner(options = {}) {
  const statePath = options.statePath ? path.resolve(String(options.statePath)) : resolvePollerStatePath();
  const state = readJsonFile(statePath);
  const poller = state?.poller && typeof state.poller === 'object' && !Array.isArray(state.poller)
    ? state.poller
    : null;
  if (!poller) return null;
  const ownerPid = Number.parseInt(String(poller.pid ?? ''), 10);
  if (!Number.isInteger(ownerPid) || ownerPid <= 0 || ownerPid === process.pid) return null;

  const expectedDataRoot = resolveExpectedDataRoot(options.env || process.env);
  const pollerDataRoot = normalizeRootPath(poller.dataRoot);
  if (pollerDataRoot && expectedDataRoot && pollerDataRoot.toLowerCase() !== expectedDataRoot.toLowerCase()) {
    return null;
  }
  return {
    pid: ownerPid,
    dataRoot: pollerDataRoot || null,
    statePath,
  };
}

function listMainTelegramWorkerProcesses(options = {}) {
  const processListText = typeof options.processListText === 'string'
    ? options.processListText
    : readProcessListText();
  if (!processListText) return [];
  return processListText
    .split(/\r?\n/)
    .map((line) => {
      const text = line.trim();
      if (!text || !MAIN_TELEGRAM_WORKER_PATTERN.test(text)) return null;
      const match = text.match(/^\s*(\d+)/);
      const pid = match ? Number.parseInt(match[1], 10) : null;
      return { pid, commandLine: text };
    })
    .filter(Boolean)
    .filter((entry) => !Number.isInteger(entry.pid) || entry.pid !== process.pid);
}

function isMainTelegramWorkerAlive(options = {}) {
  const owner = options.owner || readMainTelegramWorkerOwner(options);
  if (!owner) return false;
  return listMainTelegramWorkerProcesses(options)
    .some((entry) => {
      const pid = Number.parseInt(String(entry?.pid ?? ''), 10);
      return pid === owner.pid;
    });
}

function hasAnyMainTelegramWorkerProcess(options = {}) {
  const processListText = typeof options.processListText === 'string'
    ? options.processListText
    : readProcessListText();
  if (!processListText) return false;
  return processListText
    .split(/\r?\n/)
    .some((line) => {
      if (!MAIN_TELEGRAM_WORKER_PATTERN.test(line)) return false;
      const match = line.match(/^\s*(\d+)/);
      const pid = match ? Number.parseInt(match[1], 10) : null;
      return !Number.isInteger(pid) || pid !== process.pid;
    });
}

function allowsStandaloneLaneWithMainWorker(env = process.env) {
  return String(env.SQUIDRUN_ALLOW_STANDALONE_TELEGRAM_LANE || '').trim() === '1';
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
  const owner = readMainTelegramWorkerOwner();
  return {
    ok: true,
    running,
    pid: running ? pid : null,
    pidPath: PID_PATH,
    logPath: LOG_PATH,
    mainWorkerRunning: isMainTelegramWorkerAlive({ owner }),
    anyMainWorkerRunning: hasAnyMainTelegramWorkerProcess(),
    mainWorkerOwner: owner,
  };
}

function sendToArchitect(message) {
  const projectRoot = getProjectRoot();
  const hmSendPath = resolveRuntimeUiScriptPath(projectRoot, 'hm-send.js');
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

function getProfileTelegramTriggerPaths(windowKey = '', env = process.env) {
  const normalizedWindowKey = typeof windowKey === 'string' && windowKey.trim()
    ? windowKey.trim()
    : '';
  if (!normalizedWindowKey || normalizedWindowKey === 'main') return [];

  const profileRoot = getProfileProjectRootOverride(normalizedWindowKey, env);
  const roots = profileRoot
    ? [profileRoot]
    : [getProjectRoot()].filter(Boolean);

  return Array.from(new Set(roots.map((root) => path.resolve(root))))
    .map((root) => path.join(root, '.squidrun', `triggers-${normalizedWindowKey}`, 'architect.txt'));
}

function forwardToProfileTrigger(windowKey, message, env = process.env) {
  const normalizedMessage = typeof message === 'string' && message.trim() ? message : '';
  if (!normalizedMessage) return { ok: false, reason: 'empty_message' };

  const triggerPaths = getProfileTelegramTriggerPaths(windowKey, env);
  if (triggerPaths.length === 0) {
    return { ok: false, reason: 'missing_profile_trigger_path' };
  }

  const written = [];
  const errors = [];
  for (const triggerPath of triggerPaths) {
    try {
      fs.mkdirSync(path.dirname(triggerPath), { recursive: true });
      fs.writeFileSync(triggerPath, normalizedMessage, 'utf8');
      written.push(triggerPath);
    } catch (err) {
      errors.push({ path: triggerPath, error: err.message });
    }
  }

  return {
    ok: written.length > 0,
    written,
    errors,
    reason: written.length > 0 ? null : 'profile_trigger_write_failed',
  };
}

function dispatchInboundTelegramMessage(message, metadata = {}, options = {}) {
  const env = options.env || process.env;
  const resolver = typeof options.resolveInboundRoute === 'function'
    ? options.resolveInboundRoute
    : resolveTelegramInboundRoute;
  const route = resolver({ chatId: metadata?.chatId, env });
  const updateId = metadata?.updateId ?? 'unknown';
  const logEvent = typeof options.writeLog === 'function' ? options.writeLog : writeLog;

  if (!route?.ok) {
    const reason = route?.reason || 'telegram_inbound_route_blocked';
    logEvent(`[privacy-block] inbound update=${updateId} chat=${route?.chatId || 'unknown'} reason=${reason}`);
    return {
      ok: false,
      blocked: true,
      reason,
      route,
    };
  }

  const windowKey = route.windowKey || 'main';
  if (windowKey !== 'main') {
    const forward = typeof options.forwardToProfileTrigger === 'function'
      ? options.forwardToProfileTrigger(windowKey, message, env)
      : forwardToProfileTrigger(windowKey, message, env);
    if (forward?.ok) {
      logEvent(`[routed] inbound update=${updateId} chat=${route.chatId || 'unknown'} window=${windowKey}`);
      return {
        ok: true,
        target: 'profile-trigger',
        windowKey,
        route,
        forward,
      };
    }
    logEvent(`[privacy-block] inbound update=${updateId} chat=${route.chatId || 'unknown'} window=${windowKey} reason=${forward?.reason || 'profile_trigger_failed'}`);
    return {
      ok: false,
      blocked: true,
      reason: forward?.reason || 'profile_trigger_failed',
      route,
      forward,
    };
  }

  const send = typeof options.sendToArchitect === 'function' ? options.sendToArchitect : sendToArchitect;
  send(message);
  return {
    ok: true,
    target: 'architect',
    windowKey: 'main',
    route,
  };
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
  require('dotenv').config({ path: path.join(getProjectRoot(), '.env'), quiet: true });
  if (isMainTelegramWorkerAlive() && !allowsStandaloneLaneWithMainWorker()) {
    writeLog('[blocked] main telegram-poller-worker is already running; standalone lane would cause Telegram 409 conflicts');
    process.exit(2);
  }
  fs.mkdirSync(path.dirname(PID_PATH), { recursive: true });
  fs.writeFileSync(PID_PATH, String(process.pid), 'utf8');
  writeLog(`[start] pid=${process.pid}`);
  const keepAliveTimer = setInterval(() => {}, KEEPALIVE_INTERVAL_MS);

  const ownerEnv = {
    ...buildProfileTelegramEnv(process.env, 'main'),
    SQUIDRUN_TELEGRAM_ACCEPT_SCOPED_CHATS: '1',
  };
  const started = telegramPoller.start({
    env: ownerEnv,
    onMessage: (text, from, metadata = {}) => {
      const formatted = formatInbound(text, from, metadata);
      if (!formatted) {
        writeLog(`[drop] empty inbound update=${metadata?.updateId ?? 'unknown'}`);
        return;
      }
      writeLog(`[inbound] update=${metadata?.updateId ?? 'unknown'} media=${metadata?.media?.kind || 'none'}`);
      dispatchInboundTelegramMessage(formatted, metadata, { env: ownerEnv });
    },
  });

  if (!started) {
    writeLog('[error] Telegram poller did not start; missing config');
    process.exit(1);
  }

  const shutdown = () => {
    clearInterval(keepAliveTimer);
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

function startLane(options = {}) {
  const current = status();
  if (current.running) return { ok: true, alreadyRunning: true, ...current };
  if (current.mainWorkerRunning && !allowsStandaloneLaneWithMainWorker()) {
    return {
      ok: false,
      started: false,
      reason: 'main_telegram_worker_running',
      note: 'Refusing to start standalone Telegram lane while the app poller owns getUpdates; this prevents Telegram 409 conflicts.',
      pidPath: PID_PATH,
      logPath: LOG_PATH,
    };
  }
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
  const startupVerifyMs = Number.isFinite(options.startupVerifyMs) ? Math.max(0, options.startupVerifyMs) : 4000;
  if (startupVerifyMs > 0) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, startupVerifyMs);
  }
  const isAlive = typeof options.isPidAlive === 'function' ? options.isPidAlive(child.pid) : isPidAlive(child.pid);
  if (!isAlive) {
    return {
      ok: false,
      started: false,
      reason: 'lane_child_died_immediately',
      pid: child.pid,
      note: `Lane child exited within ${startupVerifyMs}ms of spawn; see ${LOG_PATH} for its output.`,
      pidPath: PID_PATH,
      logPath: LOG_PATH,
    };
  }
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
  dispatchInboundTelegramMessage,
  forwardToProfileTrigger,
  formatInbound,
  getProfileTelegramTriggerPaths,
  isMainTelegramWorkerAlive,
  isPidAlive,
  resolveRuntimeUiScriptPath,
  status,
  startLane,
  stopLane,
};
