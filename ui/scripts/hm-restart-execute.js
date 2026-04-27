#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');

const { getProjectRoot } = require('../config');

const DEFAULT_INSTANCE_ID = 'james-main';
const PREFLIGHT_MAX_AGE_MS = 5 * 60 * 1000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

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

function listElectronProcesses(projectRoot) {
  if (process.platform !== 'win32') return [];
  const script = [
    '$root = [System.IO.Path]::GetFullPath($args[0]).ToLowerInvariant()',
    '$items = Get-CimInstance Win32_Process | Where-Object {',
    "  ($_.Name -match '^(electron|SquidRun).*\\.exe$' -or $_.CommandLine -match 'electron') -and",
    '  ($_.CommandLine -and $_.CommandLine.ToLowerInvariant().Contains($root))',
    '} | Select-Object ProcessId,Name,CommandLine',
    '$items | ConvertTo-Json -Depth 3',
  ].join('; ');
  try {
    const stdout = execFileSync('powershell', ['-NoProfile', '-Command', script, projectRoot], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    });
    const parsed = JSON.parse(String(stdout || '[]').trim() || '[]');
    return (Array.isArray(parsed) ? parsed : [parsed])
      .filter((entry) => Number.isInteger(Number(entry?.ProcessId)))
      .map((entry) => ({
        pid: Number(entry.ProcessId),
        name: entry.Name || null,
        commandLine: entry.CommandLine || null,
      }));
  } catch {
    return [];
  }
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
  const listProcesses = options.listElectronProcesses || listElectronProcesses;
  const exists = options.processExists || processExists;
  const killProcess = options.killProcess || ((pid) => process.kill(pid, 'SIGTERM'));
  const sleepFn = options.sleep || sleep;
  const timeoutMs = Math.max(1000, Number(options.shutdownTimeoutMs || DEFAULT_SHUTDOWN_TIMEOUT_MS));
  const processes = listProcesses(projectRoot);
  const killed = [];
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

function recordFailureAnomaly(projectRoot, details = {}, options = {}) {
  const scriptPath = path.join(projectRoot, 'ui', 'scripts', 'hm-anomaly.js');
  const run = options.runNodeScript || ((script, args) => spawnSync(process.execPath, [script, ...args], {
    cwd: projectRoot,
    env: process.env,
    encoding: 'utf8',
    timeout: 30_000,
  }));
  return run(scriptPath, [
    'type=restart_execute_failure',
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
    recordFailureAnomaly(projectRoot, failure, options);
    return failure;
  }

  try {
    const relaunch = relaunchSquidRun(projectRoot, instanceConfig, options);
    logStep(instanceConfig, 'relaunch_complete', relaunch);
    return {
      ok: true,
      instance: instanceId,
      reason,
      preflight,
      shutdown,
      relaunch,
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
  parseArgs,
  readJson,
  readJsonLines,
  loadInstanceConfig,
  isGreenPreflightMessage,
  findLatestGreenPreflight,
  defaultLaunchCommand,
  listElectronProcesses,
  shutdownElectronProcesses,
  relaunchSquidRun,
  executeRestart,
  main,
};
