#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolveRuntimeUiScriptPath } = require('./runtime-ui-paths');

const { getProjectRoot } = require('../config');

const DEFAULT_STALE_THRESHOLD_MS = 10 * 60 * 1000;
const POLLER_STATE_REL_PATH = path.join('.squidrun', 'runtime', 'telegram-poller-state.json');
const WATCHDOG_LOG_REL_PATH = path.join('.squidrun', 'runtime', 'telegram-poller-watchdog.log');
const MAIN_TELEGRAM_WORKER_PATTERN = /modules[\\/]+main[\\/]+telegram-poller-worker\.js/i;
const STANDALONE_RESTART_WAIT_MS = 3000;

function asPositiveMs(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function resolveProjectRoot(projectRoot = null) {
  return path.resolve(String(projectRoot || getProjectRoot() || process.cwd()));
}

function resolvePollerStatePath(projectRoot = null) {
  return path.join(resolveProjectRoot(projectRoot), POLLER_STATE_REL_PATH);
}

function resolveWatchdogLogPath(projectRoot = null) {
  return path.join(resolveProjectRoot(projectRoot), WATCHDOG_LOG_REL_PATH);
}

function readJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return { ok: false, exists: false, value: null, error: null };
    return {
      ok: true,
      exists: true,
      value: JSON.parse(fs.readFileSync(filePath, 'utf8')),
      error: null,
    };
  } catch (err) {
    return { ok: false, exists: true, value: null, error: err.message };
  }
}

function readAppUp(projectRoot = null) {
  const appStatusPath = path.join(resolveProjectRoot(projectRoot), '.squidrun', 'app-status.json');
  const result = readJsonFile(appStatusPath);
  if (!result.ok) {
    return {
      appUp: false,
      appStatusPath,
      reason: result.exists ? 'app_status_read_error' : 'app_status_missing',
    };
  }
  return {
    appUp: true,
    appStatusPath,
    session: result.value?.session ?? result.value?.sessionNumber ?? null,
    started: result.value?.started || null,
  };
}

function inspectTelegramPollerFreshness(options = {}) {
  const projectRoot = resolveProjectRoot(options.projectRoot);
  const statePath = options.statePath ? path.resolve(String(options.statePath)) : resolvePollerStatePath(projectRoot);
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Math.floor(Number(options.nowMs)) : Date.now();
  const staleThresholdMs = asPositiveMs(options.staleThresholdMs, DEFAULT_STALE_THRESHOLD_MS);
  const appState = Object.prototype.hasOwnProperty.call(options, 'appUp')
    ? { appUp: options.appUp === true, appStatusPath: null }
    : readAppUp(projectRoot);

  const read = readJsonFile(statePath);
  if (!appState.appUp) {
    return {
      ok: true,
      status: 'app_not_up',
      wedged: false,
      statePath,
      staleThresholdMs,
      nowMs,
      ageMs: null,
      updatedAt: null,
      appUp: false,
      appState,
      reason: appState.reason || 'app_not_up',
    };
  }
  if (!read.ok) {
    return {
      ok: false,
      status: read.exists ? 'state_read_error' : 'state_missing',
      wedged: read.exists === false,
      statePath,
      staleThresholdMs,
      nowMs,
      ageMs: null,
      updatedAt: null,
      appUp: true,
      appState,
      error: read.error,
    };
  }

  const poller = read.value?.poller && typeof read.value.poller === 'object' && !Array.isArray(read.value.poller)
    ? read.value.poller
    : null;
  const lastPollAt = typeof poller?.lastPollAt === 'string' && poller.lastPollAt.trim()
    ? poller.lastPollAt.trim()
    : null;
  const updatedAt = typeof read.value?.updatedAt === 'string' && read.value.updatedAt.trim()
    ? read.value.updatedAt.trim()
    : null;
  const freshnessAt = lastPollAt || updatedAt;
  const freshnessSource = lastPollAt ? 'poller.lastPollAt' : 'state.updatedAt';
  const freshnessAtMs = freshnessAt ? Date.parse(freshnessAt) : NaN;
  if (!Number.isFinite(freshnessAtMs)) {
    return {
      ok: false,
      status: lastPollAt ? 'poller_invalid_last_poll_at' : 'state_invalid_timestamp',
      wedged: true,
      statePath,
      staleThresholdMs,
      nowMs,
      ageMs: null,
      lastPollAt,
      updatedAt,
      freshnessAt,
      freshnessSource,
      appUp: true,
      appState,
    };
  }

  const ageMs = Math.max(0, nowMs - freshnessAtMs);
  const wedged = ageMs > staleThresholdMs;
  return {
    ok: !wedged,
    status: wedged ? 'stale' : 'fresh',
    wedged,
    statePath,
    staleThresholdMs,
    nowMs,
    ageMs,
    lastPollAt,
    updatedAt,
    freshnessAt,
    freshnessSource,
    appUp: true,
    appState,
    poller,
    cursorCount: read.value?.cursors && typeof read.value.cursors === 'object'
      ? Object.keys(read.value.cursors).length
      : 0,
  };
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

function resolveExpectedDataRoot(projectRoot = null, env = process.env) {
  return normalizeRootPath(env.SQUIDRUN_DATA_ROOT)
    || normalizeRootPath(projectRoot)
    || normalizeRootPath(env.SQUIDRUN_PROJECT_ROOT)
    || resolveProjectRoot(projectRoot);
}

function fingerprintTelegramToken(token) {
  if (typeof token !== 'string' || !token.trim()) return null;
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(token.trim()).digest('hex').slice(0, 16);
}

function listMainTelegramWorkerProcesses(options = {}) {
  const processListText = typeof options.processListText === 'string'
    ? options.processListText
    : readProcessListText();
  if (!processListText) return [];
  return processListText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && MAIN_TELEGRAM_WORKER_PATTERN.test(line))
    .map((line) => {
      const match = line.match(/^(\d+)/);
      return {
        pid: match ? Number.parseInt(match[1], 10) : null,
        commandLine: line,
      };
    })
    .filter((entry) => !Number.isInteger(entry.pid) || entry.pid !== process.pid);
}

function readPollerOwnerState(options = {}) {
  const projectRoot = resolveProjectRoot(options.projectRoot);
  const statePath = options.statePath ? path.resolve(String(options.statePath)) : resolvePollerStatePath(projectRoot);
  const read = readJsonFile(statePath);
  const poller = read.value?.poller && typeof read.value.poller === 'object' && !Array.isArray(read.value.poller)
    ? read.value.poller
    : null;
  return {
    ok: read.ok,
    exists: read.exists,
    statePath,
    poller,
    error: read.error,
  };
}

function listOwnedMainTelegramWorkerProcesses(options = {}) {
  const projectRoot = resolveProjectRoot(options.projectRoot);
  const owner = options.ownerState || readPollerOwnerState({
    projectRoot,
    statePath: options.statePath,
  });
  const poller = owner.poller || null;
  const ownerPid = Number.parseInt(String(poller?.pid ?? ''), 10);
  if (!Number.isInteger(ownerPid) || ownerPid <= 0 || ownerPid === process.pid) return [];

  const expectedDataRoot = resolveExpectedDataRoot(projectRoot, options.env || process.env);
  const pollerDataRoot = normalizeRootPath(poller.dataRoot);
  if (pollerDataRoot && expectedDataRoot && pollerDataRoot.toLowerCase() !== expectedDataRoot.toLowerCase()) {
    return [];
  }

  const expectedTokenFingerprint = fingerprintTelegramToken((options.env || process.env).TELEGRAM_BOT_TOKEN);
  if (
    poller.tokenFingerprint
    && expectedTokenFingerprint
    && poller.tokenFingerprint !== expectedTokenFingerprint
  ) {
    return [];
  }

  const processes = Array.isArray(options.processes)
    ? options.processes
    : listMainTelegramWorkerProcesses(options);
  return processes.filter((entry) => Number.parseInt(String(entry?.pid ?? ''), 10) === ownerPid);
}

function isMainTelegramWorkerAlive(options = {}) {
  return listOwnedMainTelegramWorkerProcesses(options).length > 0;
}

function writeWatchdogLog(projectRoot, message) {
  const logPath = resolveWatchdogLogPath(projectRoot);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`, 'utf8');
  return logPath;
}

function sleepMs(ms) {
  const waitMs = Number(ms);
  if (!Number.isFinite(waitMs) || waitMs <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.floor(waitMs));
}

function waitUntil(predicate, timeoutMs = STANDALONE_RESTART_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (predicate()) return true;
    sleepMs(100);
  }
  return Boolean(predicate());
}

function formatDurationMinutes(ageMs) {
  if (!Number.isFinite(Number(ageMs))) return 'unknown';
  return String(Math.max(1, Math.round(Number(ageMs) / 60_000)));
}

function notifyJames(projectRoot, freshness, options = {}) {
  const message = typeof options.message === 'string' && options.message.trim()
    ? options.message.trim()
    : `Telegram inbound was stale for about ${formatDurationMinutes(freshness?.ageMs)} min; I restarted the poller so inbound messages are flowing again.`;
  const resolvedRoot = resolveProjectRoot(projectRoot);
  const hmSendPath = resolveRuntimeUiScriptPath(resolvedRoot, 'hm-send.js');
  const result = spawnSync(process.execPath, [hmSendPath, 'telegram', '--stdin', '--role', 'system'], {
    cwd: resolvedRoot,
    env: { ...process.env, SQUIDRUN_PROJECT_ROOT: resolvedRoot },
    input: message,
    encoding: 'utf8',
    timeout: 20_000,
    windowsHide: true,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    message,
  };
}

function killMainTelegramWorkers(processes, options = {}) {
  const entries = Array.isArray(processes) ? processes : [];
  const killed = [];
  const skipped = [];
  for (const entry of entries) {
    const pid = Number(entry?.pid);
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
      skipped.push({ pid: entry?.pid ?? null, reason: 'invalid_pid' });
      continue;
    }
    if (options.dryRun) {
      killed.push({ pid, dryRun: true });
      continue;
    }
    try {
      process.kill(pid, 'SIGTERM');
      killed.push({ pid, signal: 'SIGTERM' });
    } catch (err) {
      skipped.push({ pid, reason: err.message });
    }
  }
  return { killed, skipped };
}

async function defaultRunAppRestart(projectRoot, reason) {
  const hmApp = require('./hm-app');
  return hmApp.run('restart-telegram-poller', {
    role: 'system',
    timeoutMs: 8_000,
    payload: { reason },
  });
}

function defaultStartStandaloneLane() {
  const lane = require('./hm-telegram-poller-lane');
  return lane.startLane();
}

function defaultStandaloneLaneStatus() {
  const lane = require('./hm-telegram-poller-lane');
  return lane.status();
}

function defaultRestartStandaloneLane() {
  const lane = require('./hm-telegram-poller-lane');
  const before = lane.status();
  const stopped = lane.stopLane();
  const stoppedCleanly = waitUntil(() => lane.status().running !== true);
  if (!stoppedCleanly) {
    return {
      ok: false,
      reason: 'standalone_lane_stop_timeout',
      before,
      stopped,
      afterStop: lane.status(),
    };
  }
  const started = lane.startLane();
  return {
    ok: started?.ok === true,
    before,
    stopped,
    started,
  };
}

async function recoverWedgedTelegramPoller(options = {}) {
  const projectRoot = resolveProjectRoot(options.projectRoot);
  const freshness = options.freshness || inspectTelegramPollerFreshness(options);
  if (!freshness.wedged) {
    return {
      ok: true,
      action: 'none',
      recovered: false,
      reason: 'not_wedged',
      freshness,
    };
  }

  const reason = `telegram-poller-freshness-stale:${formatDurationMinutes(freshness.ageMs)}m`;
  writeWatchdogLog(projectRoot, `[detect] status=${freshness.status} ageMs=${freshness.ageMs ?? 'unknown'} thresholdMs=${freshness.staleThresholdMs}`);

  const standaloneStatus = options.standaloneStatus
    || (typeof options.getStandaloneLaneStatus === 'function'
      ? options.getStandaloneLaneStatus()
      : defaultStandaloneLaneStatus());
  if (standaloneStatus?.running === true) {
    const restartStandaloneLane = typeof options.restartStandaloneLane === 'function'
      ? options.restartStandaloneLane
      : defaultRestartStandaloneLane;
    const standaloneRestart = options.dryRun === true
      ? { ok: true, dryRun: true, before: standaloneStatus, started: { dryRun: true } }
      : await Promise.resolve(restartStandaloneLane());
    const standaloneRestartSuccess = standaloneRestart?.ok === true;
    if (standaloneRestartSuccess) {
      writeWatchdogLog(projectRoot, `[recover] standalone lane restarted pid=${standaloneRestart?.started?.pid || standaloneStatus.pid || 'unknown'} reason=${reason}`);
    } else {
      writeWatchdogLog(projectRoot, `[recover] standalone lane restart failed reason=${standaloneRestart?.reason || 'unknown'}`);
    }
    const notice = standaloneRestartSuccess && options.dryRun !== true
      ? (typeof options.notifyJames === 'function'
        ? await Promise.resolve(options.notifyJames(projectRoot, freshness, { reason }))
        : notifyJames(projectRoot, freshness, { reason }))
      : null;
    return {
      ok: standaloneRestartSuccess,
      action: 'standalone_lane_restart',
      recovered: standaloneRestartSuccess,
      reason,
      freshness,
      standaloneStatus,
      standaloneRestart,
      notice,
    };
  }

  const runAppRestart = typeof options.runAppRestart === 'function'
    ? options.runAppRestart
    : defaultRunAppRestart;
  let appRestart = null;
  try {
    appRestart = await Promise.resolve(runAppRestart(projectRoot, reason));
  } catch (err) {
    appRestart = { ok: false, error: err.message };
  }

  const appRestartSuccess = appRestart?.ok !== false
    && (appRestart?.result?.success === true || appRestart?.success === true);
  if (appRestartSuccess) {
    const verifyDelayMs = asPositiveMs(options.appRestartVerifyMs, 15_000);
    if (options.dryRun !== true) {
      sleepMs(verifyDelayMs);
    }
    const postRestart = options.dryRun === true
      ? { wedged: false }
      : inspectTelegramPollerFreshness(options);
    if (!postRestart.wedged) {
      writeWatchdogLog(projectRoot, `[recover] app-control restart succeeded reason=${reason}`);
      const notice = options.dryRun === true
        ? null
        : (typeof options.notifyJames === 'function'
          ? await Promise.resolve(options.notifyJames(projectRoot, freshness, { reason }))
          : notifyJames(projectRoot, freshness, { reason }));
      return {
        ok: true,
        action: 'app_restart',
        recovered: true,
        reason,
        freshness,
        appRestart,
        notice,
      };
    }
    writeWatchdogLog(projectRoot, `[recover] app-control restart UNVERIFIED (still stale after ${verifyDelayMs}ms wait) reason=${reason}; falling through to lane recovery`);
  } else {
    writeWatchdogLog(projectRoot, `[recover] app-control restart failed reason=${reason} error=${appRestart?.error || appRestart?.result?.reason || appRestart?.reason || 'unknown'}`);
  }
  const workers = listMainTelegramWorkerProcesses({
    projectRoot,
    processListText: typeof options.processListText === 'string' ? options.processListText : undefined,
  });
  const ownedWorkers = listOwnedMainTelegramWorkerProcesses({
    projectRoot,
    processes: workers,
    env: options.env || process.env,
  });
  const killResult = killMainTelegramWorkers(ownedWorkers, {
    dryRun: options.dryRun === true,
  });
  if (killResult.killed.length > 0) {
    writeWatchdogLog(projectRoot, `[recover] killed stale main worker pids=${killResult.killed.map((entry) => entry.pid).join(',')}`);
  }

  const stillAlive = typeof options.isMainWorkerAlive === 'function'
    ? options.isMainWorkerAlive()
    : isMainTelegramWorkerAlive();
  if (stillAlive && options.dryRun !== true) {
    return {
      ok: false,
      action: 'blocked_main_worker_still_alive',
      recovered: false,
      reason,
      freshness,
      appRestart,
      killResult,
    };
  }

  const startStandaloneLane = typeof options.startStandaloneLane === 'function'
    ? options.startStandaloneLane
    : defaultStartStandaloneLane;
  const standalone = await Promise.resolve(startStandaloneLane());
  const standaloneSuccess = standalone?.ok === true;
  const notice = standaloneSuccess && options.dryRun !== true
    ? (typeof options.notifyJames === 'function'
      ? await Promise.resolve(options.notifyJames(projectRoot, freshness, { reason }))
      : notifyJames(projectRoot, freshness, { reason }))
    : null;

  if (standaloneSuccess) {
    writeWatchdogLog(projectRoot, `[recover] standalone lane started pid=${standalone.pid || 'unknown'} reason=${reason}`);
  }

  return {
    ok: standaloneSuccess,
    action: 'standalone_lane',
    recovered: standaloneSuccess,
    reason,
    freshness,
    appRestart,
    killResult,
    standalone,
    notice,
  };
}

async function checkAndRecoverTelegramPoller(options = {}) {
  const freshness = inspectTelegramPollerFreshness(options);
  if (!freshness.wedged) {
    return {
      ok: true,
      freshness,
      recovery: {
        ok: true,
        action: 'none',
        recovered: false,
        reason: 'not_wedged',
      },
    };
  }
  const recovery = await recoverWedgedTelegramPoller({
    ...options,
    freshness,
  });
  return {
    ok: recovery.ok === true,
    freshness,
    recovery,
  };
}

function printJson(result) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function main(argv = process.argv.slice(2)) {
  const command = String(argv[0] || 'status').trim().toLowerCase();
  const dryRun = argv.includes('--dry-run');
  const thresholdArg = argv.find((arg) => String(arg).startsWith('--threshold-ms='));
  const projectRootArg = argv.find((arg) => String(arg).startsWith('--project-root='));
  const staleThresholdMs = thresholdArg
    ? asPositiveMs(thresholdArg.slice('--threshold-ms='.length), DEFAULT_STALE_THRESHOLD_MS)
    : DEFAULT_STALE_THRESHOLD_MS;
  const projectRoot = projectRootArg
    ? projectRootArg.slice('--project-root='.length)
    : null;
  if (command === 'recover') {
    printJson(await checkAndRecoverTelegramPoller({ staleThresholdMs, dryRun, projectRoot }));
    return;
  }
  if (command === 'status') {
    printJson(inspectTelegramPollerFreshness({ staleThresholdMs, projectRoot }));
    return;
  }
  process.stderr.write('Usage: node ui/scripts/hm-telegram-poller-watchdog.js <status|recover> [--dry-run] [--threshold-ms=<ms>] [--project-root=<path>]\n');
  process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_STALE_THRESHOLD_MS,
  inspectTelegramPollerFreshness,
  isMainTelegramWorkerAlive,
  listMainTelegramWorkerProcesses,
  recoverWedgedTelegramPoller,
  checkAndRecoverTelegramPoller,
  resolvePollerStatePath,
};
