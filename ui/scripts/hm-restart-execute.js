#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');

const { getProjectRoot } = require('../config');

const DEFAULT_INSTANCE_ID = 'james-main';
const PREFLIGHT_MAX_AGE_MS = 5 * 60 * 1000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;
const DEFAULT_RELAUNCH_VERIFY_TIMEOUT_MS = 60_000;
const DEFAULT_RELAUNCH_VERIFY_POLL_MS = 500;

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    instance: DEFAULT_INSTANCE_ID,
    reason: '',
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '').trim();
    if (token === '--instance' && argv[index + 1]) {
      args.instance = String(argv[index + 1]).trim() || DEFAULT_INSTANCE_ID;
      index += 1;
      continue;
    }
    if (token === '--reason' && argv[index + 1]) {
      args.reason = String(argv[index + 1]).trim();
      index += 1;
      continue;
    }
    if (token === '--json') {
      args.json = true;
    }
    if (token === '--verify-timeout-ms' && argv[index + 1]) {
      args.relaunchVerifyTimeoutMs = Number(argv[index + 1]);
      index += 1;
    }
  }
  if (!args.reason) {
    throw new Error('Missing required --reason <text>');
  }
  return args;
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function appendJsonLine(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
}

function readJsonLines(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function findInstance(registry = {}, instanceId = DEFAULT_INSTANCE_ID) {
  const entries = Array.isArray(registry?.instances) ? registry.instances : [];
  return entries.find((entry) => String(entry?.id || '') === instanceId) || null;
}

function resolveProjectPath(projectRoot, value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return path.isAbsolute(raw) ? raw : path.resolve(projectRoot, raw);
}

function loadInstanceConfig(projectRoot, instanceId = DEFAULT_INSTANCE_ID) {
  const livePath = path.join(projectRoot, '.squidrun', 'operator-registry.json');
  const templatePath = path.join(projectRoot, '.squidrun', 'operator-registry.template.json');
  const live = readJson(livePath, {});
  const template = readJson(templatePath, {});
  const templateInstance = findInstance(template, instanceId) || {};
  const liveInstance = findInstance(live, instanceId) || {};
  const merged = {
    ...templateInstance,
    ...liveInstance,
    notifyPolicy: {
      ...(templateInstance.notifyPolicy || {}),
      ...(liveInstance.notifyPolicy || {}),
    },
    launchCommand: {
      ...(templateInstance.launchCommand || {}),
      ...(liveInstance.launchCommand || {}),
    },
  };
  if (!merged.id) throw new Error(`Operator registry instance not found: ${instanceId}`);
  return {
    instance: merged,
    coordPath: resolveProjectPath(projectRoot, merged.coordPath || '.squidrun/coord'),
    architectInboxPath: resolveProjectPath(projectRoot, merged.architectInbox || '.squidrun/coord/architect-inbox.jsonl'),
    appStatusPath: resolveProjectPath(projectRoot, merged.appStatusPath || '.squidrun/app-status.json'),
    launchCommand: merged.launchCommand,
  };
}

function resolveMessageTimeMs(message = {}) {
  const value = message.timestampUtc || message.createdAt || message.checkedAt || message.ts || null;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function isGreenPreflightMessage(message = {}, instanceId = DEFAULT_INSTANCE_ID) {
  if (message.instance && String(message.instance) !== instanceId) return false;
  if (message.type === 'preflight_result') {
    const status = String(message.status || '').trim().toLowerCase();
    return status === 'approved' || status === 'green';
  }
  if (message.type === 'audit_grade') {
    const grade = String(message.grade || '').trim().toLowerCase();
    const status = String(message.status || '').trim().toLowerCase();
    return grade === 'green' || status.startsWith('cleared');
  }
  if (message.type === 'restart_preflight') {
    const grade = String(message.grade || message.status || '').trim().toLowerCase();
    return grade === 'green' || grade === 'approved';
  }
  return false;
}

function findLatestGreenPreflight(instanceConfig, instanceId = DEFAULT_INSTANCE_ID, nowMs = Date.now()) {
  const messages = readJsonLines(instanceConfig.architectInboxPath)
    .filter((message) => isGreenPreflightMessage(message, instanceId))
    .map((message) => ({ message, atMs: resolveMessageTimeMs(message) }))
    .filter((entry) => Number.isFinite(entry.atMs))
    .sort((left, right) => right.atMs - left.atMs);
  const latest = messages[0] || null;
  if (!latest) {
    return { ok: false, reason: 'missing_green_preflight', latest: null };
  }
  const ageMs = nowMs - latest.atMs;
  if (ageMs > PREFLIGHT_MAX_AGE_MS) {
    return {
      ok: false,
      reason: 'stale_green_preflight',
      latest: latest.message,
      ageMs,
      maxAgeMs: PREFLIGHT_MAX_AGE_MS,
    };
  }
  if (ageMs < -60_000) {
    return {
      ok: false,
      reason: 'future_green_preflight',
      latest: latest.message,
      ageMs,
    };
  }
  return {
    ok: true,
    latest: latest.message,
    ageMs,
    maxAgeMs: PREFLIGHT_MAX_AGE_MS,
  };
}

function defaultLaunchCommand(projectRoot, instanceConfig) {
  const appStatus = readJson(instanceConfig.appStatusPath, {});
  const cwd = instanceConfig.launchCommand?.cwd
    || appStatus?.settingsPersistence?.cwd
    || path.join(projectRoot, 'ui');
  const command = instanceConfig.launchCommand?.command
    || (process.platform === 'win32' ? 'npm.cmd' : 'npm');
  const args = Array.isArray(instanceConfig.launchCommand?.args)
    ? instanceConfig.launchCommand.args
    : ['start'];
  return {
    command,
    args,
    cwd: resolveProjectPath(projectRoot, cwd),
    env: instanceConfig.launchCommand?.env || {},
  };
}

function normalizeForProcessMatch(value = '') {
  return String(value || '')
    .replace(/\\/g, '/')
    .toLowerCase();
}

function asProcessRow(raw = {}) {
  const pid = Number(raw.ProcessId ?? raw.PID ?? raw.pid);
  const parentPid = Number(raw.ParentProcessId ?? raw.ParentPID ?? raw.parentPid);
  return {
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    parentPid: Number.isInteger(parentPid) && parentPid > 0 ? parentPid : null,
    name: raw.Name || raw['Image Name'] || raw.ImageName || raw.name || null,
    executablePath: raw.ExecutablePath || raw.Path || raw.executablePath || null,
    commandLine: raw.CommandLine || raw.commandLine || null,
    windowTitle: raw.WindowTitle || raw['Window Title'] || raw.windowTitle || null,
  };
}

function parseCsvLine(line = '') {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      index += 1;
      continue;
    }
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (char === ',' && !inQuotes) {
      fields.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  fields.push(current);
  return fields;
}

function parseTasklistCsv(output = '') {
  const lines = String(output || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return headers.reduce((row, header, index) => {
      row[header] = values[index] || '';
      return row;
    }, {});
  });
}

function queryWindowsProcessRows(projectRoot, options = {}) {
  if (Array.isArray(options.processRows)) return options.processRows;
  if (typeof options.tasklistOutput === 'string') return parseTasklistCsv(options.tasklistOutput);
  const script = [
    '$items = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine',
    '$items | ConvertTo-Json -Depth 3',
  ].join('; ');
  try {
    const stdout = execFileSync('powershell', ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    });
    const parsed = JSON.parse(String(stdout || '[]').trim() || '[]');
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function processText(row = {}) {
  return [
    row.name,
    row.executablePath,
    row.commandLine,
    row.windowTitle,
  ].map((value) => normalizeForProcessMatch(value)).join(' ');
}

function isElectronProcess(row = {}) {
  const name = normalizeForProcessMatch(row.name);
  const executablePath = normalizeForProcessMatch(row.executablePath);
  const commandLine = normalizeForProcessMatch(row.commandLine);
  return (
    name.includes('electron')
    || name.includes('squidrun')
    || executablePath.includes('electron')
    || executablePath.includes('squidrun')
    || commandLine.includes('electron')
  );
}

function isPrimaryElectronProcess(row = {}) {
  if (!isElectronProcess(row)) return false;
  const commandLine = normalizeForProcessMatch(row.commandLine);
  const windowTitle = normalizeForProcessMatch(row.windowTitle);
  if (!commandLine) {
    return !windowTitle || (windowTitle !== 'n/a' && windowTitle.includes('squidrun'));
  }
  if (commandLine.includes(' --type=')) return false;
  if (commandLine.includes('/modules/')) return false;
  if (commandLine.includes('--standalone-window')) return false;
  if (commandLine.includes('--profile=') && !commandLine.includes('--profile=main')) return false;
  return true;
}

function isProjectRelatedProcess(row = {}, projectRoot = '') {
  const text = processText(row);
  const root = normalizeForProcessMatch(projectRoot);
  return Boolean(
    (root && text.includes(root))
    || text.includes('/squidrun/')
    || text.includes('squidrun-ui')
    || text.includes('squidrun')
  );
}

function selectSquidRunElectronProcesses(projectRoot, rawRows = []) {
  const rows = rawRows.map(asProcessRow).filter((row) => row.pid);
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const selected = new Map();
  const select = (row, matchReason) => {
    if (!row || !row.pid || !isPrimaryElectronProcess(row)) return;
    if (selected.has(row.pid)) return;
    selected.set(row.pid, {
      pid: row.pid,
      parentPid: row.parentPid,
      name: row.name,
      executablePath: row.executablePath,
      commandLine: row.commandLine,
      windowTitle: row.windowTitle,
      matchReason,
    });
  };

  for (const row of rows) {
    if (isPrimaryElectronProcess(row) && isProjectRelatedProcess(row, projectRoot)) {
      select(row, 'direct_project_match');
    }
  }

  for (const row of rows) {
    if (!isProjectRelatedProcess(row, projectRoot)) continue;
    let parent = byPid.get(row.parentPid);
    const seen = new Set([row.pid]);
    while (parent && !seen.has(parent.pid)) {
      if (isElectronProcess(parent)) {
        select(parent, 'project_descendant_parent');
        break;
      }
      seen.add(parent.pid);
      parent = byPid.get(parent.parentPid);
    }
  }

  return Array.from(selected.values()).sort((left, right) => left.pid - right.pid);
}

function listElectronProcesses(projectRoot, options = {}) {
  if (process.platform !== 'win32' && !options.processRows && !options.tasklistOutput) return [];
  return selectSquidRunElectronProcesses(projectRoot, queryWindowsProcessRows(projectRoot, options));
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

async function shutdownElectronProcesses(projectRoot, options = {}) {
  const listProcesses = options.listElectronProcesses || ((root) => listElectronProcesses(root, options));
  const exists = options.processExists || processExists;
  const killProcess = options.killProcess || ((pid) => process.kill(pid, 'SIGTERM'));
  const sleepFn = options.sleep || sleep;
  const timeoutMs = Math.max(1000, Number(options.shutdownTimeoutMs || DEFAULT_SHUTDOWN_TIMEOUT_MS));
  const processes = listProcesses(projectRoot);
  const killed = [];
  if (processes.length === 0) {
    return {
      ok: false,
      reason: 'no_target_found',
      processes,
      killed,
    };
  }
  for (const proc of processes) {
    try {
      killProcess(proc.pid, proc);
      killed.push(proc);
    } catch (error) {
      return {
        ok: false,
        reason: 'kill_failed',
        error: error?.message || String(error),
        processes,
        killed,
      };
    }
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const stillAlive = killed.filter((proc) => exists(proc.pid));
    if (stillAlive.length === 0) {
      return { ok: true, processes, killed };
    }
    await sleepFn(Math.min(250, Math.max(0, deadline - Date.now())));
  }
  return {
    ok: false,
    reason: 'shutdown_timeout',
    processes,
    killed,
    stillAlive: killed.filter((proc) => exists(proc.pid)),
  };
}

function statusTimestampMs(status = {}) {
  const candidates = [
    status.lastUpdated,
    status.started,
    status.timestampUtc,
    status.ts,
  ];
  for (const value of candidates) {
    const parsed = Date.parse(String(value || ''));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function statusSessionValue(status = {}) {
  const value = status.session_id ?? status.sessionId ?? status.session ?? status.sessionNumber;
  if (value === null || value === undefined || value === '') return null;
  return String(value);
}

function statusPidValue(status = {}) {
  const value = status.pid ?? status.processId ?? status.mainPid ?? status.electronPid;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function captureAppStatus(instanceConfig) {
  const statusPath = instanceConfig.appStatusPath;
  const status = readJson(statusPath, null);
  let mtimeMs = null;
  try {
    mtimeMs = fs.statSync(statusPath).mtimeMs;
  } catch {
    mtimeMs = null;
  }
  return {
    exists: Boolean(status && typeof status === 'object'),
    path: statusPath,
    status,
    mtimeMs,
    timestampMs: statusTimestampMs(status || {}),
    session: statusSessionValue(status || {}),
    pid: statusPidValue(status || {}),
  };
}

function isFreshAppStatus(previous = {}, current = {}, launchStartedMs = Date.now()) {
  if (!current.exists) return false;
  const floorMs = launchStartedMs - 1000;
  if (!previous.exists && current.timestampMs && current.timestampMs >= floorMs) return true;
  if (
    current.session
    && previous.session
    && current.session !== previous.session
    && (!current.timestampMs || current.timestampMs >= floorMs)
  ) {
    return true;
  }
  if (
    current.pid
    && previous.pid
    && current.pid !== previous.pid
    && (!current.timestampMs || current.timestampMs >= floorMs)
  ) {
    return true;
  }
  if (
    Number.isFinite(current.timestampMs)
    && Number.isFinite(previous.timestampMs)
    && current.timestampMs !== previous.timestampMs
    && current.timestampMs >= floorMs
  ) {
    return true;
  }
  return Boolean(
    Number.isFinite(current.mtimeMs)
    && Number.isFinite(previous.mtimeMs)
    && current.mtimeMs > previous.mtimeMs
    && current.timestampMs
    && current.timestampMs >= floorMs
  );
}

async function waitForFreshAppStatus(instanceConfig, previousSnapshot, options = {}) {
  const capture = options.captureAppStatus || captureAppStatus;
  const sleepFn = options.sleep || sleep;
  const nowFn = options.now || Date.now;
  const timeoutMs = Math.max(1000, Number(options.relaunchVerifyTimeoutMs || DEFAULT_RELAUNCH_VERIFY_TIMEOUT_MS));
  const pollMs = Math.max(25, Number(options.relaunchVerifyPollMs || DEFAULT_RELAUNCH_VERIFY_POLL_MS));
  const launchStartedMs = Number(options.launchStartedMs || nowFn());
  const deadline = launchStartedMs + timeoutMs;
  let latest = null;
  while (nowFn() <= deadline) {
    latest = capture(instanceConfig);
    if (isFreshAppStatus(previousSnapshot, latest, launchStartedMs)) {
      return {
        ok: true,
        appStatus: latest,
        previous: previousSnapshot,
        launchStartedMs,
      };
    }
    await sleepFn(Math.min(pollMs, Math.max(0, deadline - nowFn())));
  }
  return {
    ok: false,
    reason: 'relaunch_unverified',
    appStatus: latest,
    previous: previousSnapshot,
    launchStartedMs,
    timeoutMs,
  };
}

function relaunchSquidRun(projectRoot, instanceConfig, options = {}) {
  const launch = options.launchCommand || defaultLaunchCommand(projectRoot, instanceConfig);
  const spawnFn = options.spawn || spawn;
  const child = spawnFn(launch.command, launch.args || [], {
    cwd: launch.cwd || path.join(projectRoot, 'ui'),
    env: {
      ...process.env,
      SQUIDRUN_PROJECT_ROOT: projectRoot,
      ...(launch.env || {}),
    },
    detached: true,
    shell: launch.shell ?? (process.platform === 'win32'),
    windowsHide: true,
    stdio: 'ignore',
  });
  if (child && typeof child.unref === 'function') child.unref();
  return {
    ok: true,
    pid: Number(child?.pid) || null,
    launch,
  };
}

function logStep(instanceConfig, step, details = {}) {
  const logPath = path.join(instanceConfig.coordPath, 'restart-execute-log.jsonl');
  const payload = {
    ts: new Date().toISOString(),
    step,
    ...details,
  };
  appendJsonLine(logPath, payload);
  return payload;
}

function recordFailureAnomaly(projectRoot, details = {}, options = {}, type = 'restart_execute_failure') {
  const scriptPath = path.join(projectRoot, 'ui', 'scripts', 'hm-anomaly.js');
  const run = options.runNodeScript || ((script, args) => spawnSync(process.execPath, [script, ...args], {
    cwd: projectRoot,
    env: process.env,
    encoding: 'utf8',
    timeout: 30_000,
  }));
  return run(scriptPath, [
    `type=${type}`,
    'src=hm-restart-execute',
    'sev=high',
    `details=${JSON.stringify(details)}`,
    '--json',
  ]);
}

async function executeRestart(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || getProjectRoot());
  const instanceId = options.instance || DEFAULT_INSTANCE_ID;
  const reason = String(options.reason || '').trim();
  if (!reason) throw new Error('Missing restart reason');
  const nowMs = Number(options.nowMs || Date.now());
  const instanceConfig = loadInstanceConfig(projectRoot, instanceId);
  const capture = options.captureAppStatus || captureAppStatus;
  const previousAppStatus = capture(instanceConfig);
  const preflight = findLatestGreenPreflight(instanceConfig, instanceId, nowMs);
  logStep(instanceConfig, 'preflight_check', { ok: preflight.ok, reason: preflight.reason || null, preflight });
  if (!preflight.ok) {
    const failure = {
      ok: false,
      stage: 'preflight',
      reason: preflight.reason,
      preflight,
    };
    recordFailureAnomaly(projectRoot, failure, options);
    return failure;
  }

  logStep(instanceConfig, 'shutdown_start', { reason, instance: instanceId });
  const shutdown = await shutdownElectronProcesses(projectRoot, options);
  logStep(instanceConfig, 'shutdown_complete', shutdown);
  if (!shutdown.ok) {
    const failure = { ok: false, stage: 'shutdown', reason: shutdown.reason || 'shutdown_failed', shutdown };
    const anomalyType = shutdown.reason === 'no_target_found'
      ? 'restart_execute_no_target_found'
      : 'restart_execute_failure';
    recordFailureAnomaly(projectRoot, failure, options, anomalyType);
    return failure;
  }

  try {
    const launchStartedMs = Number(options.launchStartedMs || Date.now());
    const relaunch = relaunchSquidRun(projectRoot, instanceConfig, options);
    logStep(instanceConfig, 'relaunch_started', relaunch);
    const verification = await waitForFreshAppStatus(instanceConfig, previousAppStatus, {
      ...options,
      launchStartedMs,
    });
    logStep(instanceConfig, 'relaunch_verification_complete', verification);
    if (!verification.ok) {
      const failure = {
        ok: false,
        stage: 'relaunch_verification',
        reason: verification.reason || 'relaunch_unverified',
        relaunch,
        verification,
      };
      recordFailureAnomaly(projectRoot, failure, options, 'restart_execute_relaunch_unverified');
      return failure;
    }
    return {
      ok: true,
      instance: instanceId,
      reason,
      preflight,
      shutdown,
      relaunch,
      verification,
    };
  } catch (error) {
    const failure = {
      ok: false,
      stage: 'relaunch',
      reason: 'relaunch_failed',
      error: error?.message || String(error),
    };
    logStep(instanceConfig, 'relaunch_failed', failure);
    recordFailureAnomaly(projectRoot, failure, options);
    return failure;
  }
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const result = await executeRestart(args);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.ok ? 0 : 1;
  return result;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Error: ${error?.message || String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_INSTANCE_ID,
  PREFLIGHT_MAX_AGE_MS,
  DEFAULT_RELAUNCH_VERIFY_TIMEOUT_MS,
  parseArgs,
  readJson,
  readJsonLines,
  loadInstanceConfig,
  isGreenPreflightMessage,
  findLatestGreenPreflight,
  defaultLaunchCommand,
  parseTasklistCsv,
  selectSquidRunElectronProcesses,
  listElectronProcesses,
  shutdownElectronProcesses,
  captureAppStatus,
  isFreshAppStatus,
  waitForFreshAppStatus,
  relaunchSquidRun,
  executeRestart,
  main,
};
