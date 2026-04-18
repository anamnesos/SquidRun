#!/usr/bin/env node
'use strict';

installProcessDiagnostics();

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });

const { resolveCoordPath } = require('../config');
const { sendAgentAlert } = require('./hm-agent-alert');
const {
  DEFAULT_CONFIG_PATH,
  DEFAULT_STATE_PATH,
  HEARTBEAT_STALE_AFTER_MS,
  computeHeartbeatStale,
} = require('./hm-architect-quiet-watch');

const DEFAULT_WATCHDOG_STATE_PATH = resolveCoordPath(path.join('runtime', 'architect-quiet-watchdog-state.json'), { forWrite: true });
const DEFAULT_WATCHDOG_INTERVAL_MS = 60 * 1000;
const WATCHER_SCRIPT_PATH = path.resolve(__dirname, 'hm-architect-quiet-watch.js');
const WATCHER_LOG_PATH = resolveCoordPath(path.join('runtime', 'architect-quiet-watch.log'), { forWrite: true });
const WATCHER_ERR_LOG_PATH = resolveCoordPath(path.join('runtime', 'architect-quiet-watch.err.log'), { forWrite: true });

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

function escapeRegexLiteral(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function writeJson(filePath, payload) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
}

function formatErrorForLog(error) {
  if (error && typeof error === 'object') {
    return error.stack || error.message || JSON.stringify(error);
  }
  return String(error);
}

function installProcessDiagnostics(prefix = 'ARCH WATCHDOG') {
  if (global.__ARCHITECT_WATCHDOG_PROCESS_DIAGNOSTICS_INSTALLED__) return;
  global.__ARCHITECT_WATCHDOG_PROCESS_DIAGNOSTICS_INSTALLED__ = true;

  process.on('unhandledRejection', (reason) => {
    console.error(`[${prefix}] unhandledRejection: ${formatErrorForLog(reason)}`);
  });

  process.on('uncaughtException', (error) => {
    console.error(`[${prefix}] uncaughtException: ${formatErrorForLog(error)}`);
    process.exit(1);
  });

  process.on('beforeExit', (code) => {
    console.error(`[${prefix}] beforeExit code=${code}`);
  });

  process.on('exit', (code) => {
    console.error(`[${prefix}] exit code=${code}`);
  });

  ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'].forEach((signalName) => {
    process.on(signalName, () => {
      console.error(`[${prefix}] signal=${signalName}`);
    });
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

function defaultWatchdogState() {
  return {
    version: 1,
    lastCheckAt: null,
    lastRestartAt: null,
    lastSpawnedWatcherPid: null,
    lastAssessment: null,
    lastNotificationKey: null,
  };
}

function loadWatchdogState(filePath = DEFAULT_WATCHDOG_STATE_PATH) {
  return {
    ...defaultWatchdogState(),
    ...(readJson(filePath, defaultWatchdogState()) || {}),
  };
}

function buildWatcherCommandPatterns(statePath = DEFAULT_STATE_PATH) {
  const normalizedScriptPath = WATCHER_SCRIPT_PATH;
  const normalizedStatePath = path.resolve(statePath);
  const scriptPattern = escapeRegexLiteral(normalizedScriptPath);
  const statePattern = escapeRegexLiteral(normalizedStatePath);
  return {
    scriptPattern,
    statePattern,
  };
}

function listWatcherProcesses(statePath = DEFAULT_STATE_PATH) {
  const { scriptPattern, statePattern } = buildWatcherCommandPatterns(statePath);
  const command = [
    '$ErrorActionPreference = "Stop"',
    `$scriptPattern = '${scriptPattern}'`,
    `$statePattern = '${statePattern}'`,
    "$rows = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match $scriptPattern -and $_.CommandLine -match $statePattern } | Select-Object ProcessId, ParentProcessId, CommandLine",
    'if ($rows) { $rows | ConvertTo-Json -Compress }',
  ].join('; ');
  try {
    const raw = childProcess.execFileSync('powershell', ['-NoProfile', '-Command', command], {
      cwd: process.env.SQUIDRUN_PROJECT_ROOT || path.join(__dirname, '..', '..'),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
    }).trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function stopWatcherProcess(pid) {
  const numericPid = Number(pid);
  if (!Number.isFinite(numericPid) || numericPid <= 0) return false;
  try {
    process.kill(numericPid);
    return true;
  } catch {
    return false;
  }
}

function spawnWatcher(configPath = DEFAULT_CONFIG_PATH, statePath = DEFAULT_STATE_PATH) {
  ensureDir(WATCHER_LOG_PATH);
  ensureDir(WATCHER_ERR_LOG_PATH);
  const stdoutFd = fs.openSync(WATCHER_LOG_PATH, 'a');
  const stderrFd = fs.openSync(WATCHER_ERR_LOG_PATH, 'a');
  const child = childProcess.spawn(process.execPath, [
    WATCHER_SCRIPT_PATH,
    'run',
    '--config',
    path.resolve(configPath),
    '--state',
    path.resolve(statePath),
  ], {
    cwd: process.env.SQUIDRUN_PROJECT_ROOT || path.join(__dirname, '..', '..'),
    detached: true,
    windowsHide: true,
    stdio: ['ignore', stdoutFd, stderrFd],
    env: process.env,
  });
  child.unref();
  return child.pid;
}

function assessWatcherHealth(input = {}) {
  const watcherState = input.watcherState || {};
  const processes = Array.isArray(input.processes) ? input.processes : [];
  const nowMs = Number(input.nowMs || Date.now());
  const watchdogPid = toNumber(input.watchdogPid, process.pid);
  const lastTickAt = toText(watcherState?.heartbeat?.lastTickAt, '');
  const stale = computeHeartbeatStale(lastTickAt, nowMs, HEARTBEAT_STALE_AFTER_MS);
  const processCount = processes.length;
  const normalizedProcesses = processes.map((row) => ({
    processId: toNumber(row?.ProcessId ?? row?.processId ?? null, null),
    parentProcessId: toNumber(row?.ParentProcessId ?? row?.parentProcessId ?? null, null),
    commandLine: toText(row?.CommandLine ?? row?.commandLine, ''),
  }));
  const ownedProcesses = normalizedProcesses.filter((row) => row.parentProcessId === watchdogPid);
  const foreignProcesses = normalizedProcesses.filter((row) => row.parentProcessId !== watchdogPid);
  const primaryProcess = ownedProcesses[0] || normalizedProcesses[0] || null;
  const primaryPid = toNumber(primaryProcess?.ProcessId ?? primaryProcess?.processId ?? null, null);

  if (processCount === 0) {
    return {
      status: 'down',
      reason: 'process_missing',
      stale: true,
      shouldRestart: true,
      processCount,
      primaryPid: null,
      lastTickAt,
    };
  }

  if (ownedProcesses.length === 0) {
    return {
      status: 'foreign',
      reason: 'foreign_watcher_process',
      stale: true,
      shouldRestart: true,
      processCount,
      ownedProcessCount: ownedProcesses.length,
      foreignProcessCount: foreignProcesses.length,
      primaryPid,
      lastTickAt,
    };
  }

  if (normalizedProcesses.length > 1 || ownedProcesses.length > 1 || foreignProcesses.length > 0) {
    return {
      status: 'duplicate',
      reason: 'duplicate_watcher_processes',
      stale: true,
      shouldRestart: true,
      processCount,
      ownedProcessCount: ownedProcesses.length,
      foreignProcessCount: foreignProcesses.length,
      primaryPid,
      lastTickAt,
    };
  }

  if (stale) {
    return {
      status: 'stale',
      reason: 'heartbeat_stale',
      stale: true,
      shouldRestart: true,
      processCount,
      ownedProcessCount: ownedProcesses.length,
      foreignProcessCount: foreignProcesses.length,
      primaryPid,
      lastTickAt,
    };
  }

  return {
    status: 'green',
    reason: 'healthy',
      stale: false,
      shouldRestart: false,
      processCount,
      ownedProcessCount: ownedProcesses.length,
      foreignProcessCount: foreignProcesses.length,
      primaryPid,
      lastTickAt,
    };
}

function writeWatcherHeartbeatState(statePath, assessment, nowMs = Date.now()) {
  const watcherState = readJson(statePath, {}) || {};
  const lastTickAt = toText(watcherState?.heartbeat?.lastTickAt, '');
  watcherState.heartbeat = {
    ...(watcherState.heartbeat || {}),
    staleAfterMs: HEARTBEAT_STALE_AFTER_MS,
    expiresAt: lastTickAt ? new Date(new Date(lastTickAt).getTime() + HEARTBEAT_STALE_AFTER_MS).toISOString() : null,
    pid: assessment.primaryPid ?? watcherState?.heartbeat?.pid ?? null,
    state: assessment.status,
    stale: assessment.stale === true,
    staleReason: assessment.stale ? assessment.reason : null,
    lastObservedAt: new Date(nowMs).toISOString(),
  };
  writeJson(statePath, watcherState);
  return watcherState;
}

function maybeNotifyArchitect(assessment, watchdogState, nowMs = Date.now()) {
  if (!assessment.shouldRestart) return watchdogState;
  const notificationKey = `${assessment.reason}:${assessment.lastTickAt || 'none'}:${assessment.primaryPid || 'none'}`;
  if (toText(watchdogState.lastNotificationKey, '') === notificationKey) {
    return watchdogState;
  }
  sendAgentAlert(
    [
      '(ARCH WATCHDOG): architect watcher incident detected',
      `reason=${assessment.reason}`,
      `last_tick=${assessment.lastTickAt || 'none'}`,
      `pid=${assessment.primaryPid || 'none'}`,
      'action=auto-restart watcher and mark heartbeat stale',
    ].join(' | '),
    {
      targets: ['architect'],
      role: 'architect-watchdog',
      cwd: process.env.SQUIDRUN_PROJECT_ROOT || path.join(__dirname, '..', '..'),
      env: process.env,
    }
  );
  return {
    ...watchdogState,
    lastNotificationKey: notificationKey,
  };
}

async function runWatchdogCycle(options = {}) {
  const nowMs = Date.now();
  const watcherConfigPath = path.resolve(toText(options.watcherConfigPath, DEFAULT_CONFIG_PATH));
  const watcherStatePath = path.resolve(toText(options.watcherStatePath, DEFAULT_STATE_PATH));
  const watchdogStatePath = path.resolve(toText(options.watchdogStatePath, DEFAULT_WATCHDOG_STATE_PATH));
  let watchdogState = loadWatchdogState(watchdogStatePath);
  const watcherState = readJson(watcherStatePath, {}) || {};
  const processes = listWatcherProcesses(watcherStatePath);
  const assessment = assessWatcherHealth({
    watcherState,
    processes,
    nowMs,
    watchdogPid: process.pid,
  });

  watchdogState = maybeNotifyArchitect(assessment, watchdogState, nowMs);
  writeWatcherHeartbeatState(watcherStatePath, assessment, nowMs);

  let restartedPid = null;
  if (assessment.shouldRestart) {
    for (const processRow of processes) {
      stopWatcherProcess(processRow?.ProcessId ?? processRow?.processId);
    }
    restartedPid = spawnWatcher(watcherConfigPath, watcherStatePath);
    watchdogState.lastRestartAt = new Date(nowMs).toISOString();
    watchdogState.lastSpawnedWatcherPid = restartedPid;
  }

  watchdogState.lastCheckAt = new Date(nowMs).toISOString();
  watchdogState.lastAssessment = {
    ...assessment,
    restartedPid,
  };
  writeJson(watchdogStatePath, watchdogState);

  return {
    ok: true,
    watcherConfigPath,
    watcherStatePath,
    watchdogStatePath,
    assessment,
    restartedPid,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runCli(argv = process.argv.slice(2)) {
  const parsed = parseCliArgs(argv);
  const command = parsed.positional[0] || 'run';
  const once = getOption(parsed.options, 'once', false) === true;
  const loopIntervalMs = Math.max(10_000, toNumber(getOption(parsed.options, 'loop-ms', DEFAULT_WATCHDOG_INTERVAL_MS), DEFAULT_WATCHDOG_INTERVAL_MS));
  const watcherConfigPath = toText(getOption(parsed.options, 'watcher-config', DEFAULT_CONFIG_PATH), DEFAULT_CONFIG_PATH);
  const watcherStatePath = toText(getOption(parsed.options, 'watcher-state', DEFAULT_STATE_PATH), DEFAULT_STATE_PATH);
  const watchdogStatePath = toText(getOption(parsed.options, 'watchdog-state', DEFAULT_WATCHDOG_STATE_PATH), DEFAULT_WATCHDOG_STATE_PATH);

  if (command !== 'run') {
    throw new Error(`Unknown command: ${command}`);
  }

  let result = await runWatchdogCycle({
    watcherConfigPath,
    watcherStatePath,
    watchdogStatePath,
  });
  console.log(JSON.stringify(result, null, 2));
  if (once) return result;

  while (true) {
    await sleep(loopIntervalMs);
    result = await runWatchdogCycle({
      watcherConfigPath,
      watcherStatePath,
      watchdogStatePath,
    });
    console.log(JSON.stringify(result, null, 2));
  }
}

if (require.main === module) {
  runCli().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_WATCHDOG_STATE_PATH,
  defaultWatchdogState,
  loadWatchdogState,
  buildWatcherCommandPatterns,
  listWatcherProcesses,
  assessWatcherHealth,
  writeWatcherHeartbeatState,
  runWatchdogCycle,
  runCli,
};
