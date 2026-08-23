#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const { getProjectRoot } = require('../config');
const {
  RESTART_LAUNCH_PROBE_ENV,
  RESTART_LAUNCH_PROBE_RESULT_ENV,
  RESTART_LAUNCH_PROBE_SCHEMA,
} = require('../modules/main/restart-launch-probe');

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_PROCESS_EXIT_TIMEOUT_MS = 3_000;
const PROBE_ROOT_PREFIX = 'squidrun-restart-launch-probe-';

function parseArgs(argv = process.argv.slice(2)) {
  const args = { projectRoot: '', json: false, help: false, timeoutMs: DEFAULT_TIMEOUT_MS };
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '').trim();
    if (token === '--project-root' && argv[index + 1]) {
      args.projectRoot = String(argv[index + 1]).trim();
      index += 1;
      continue;
    }
    if (token === '--timeout-ms' && argv[index + 1]) {
      args.timeoutMs = Math.max(5_000, Number(argv[index + 1]) || DEFAULT_TIMEOUT_MS);
      index += 1;
      continue;
    }
    if (token === '--json') args.json = true;
    if (token === '--help' || token === '-h') args.help = true;
  }
  return args;
}

function usage() {
  return [
    'Usage: node ui/scripts/hm-restart-launch-probe.js [options]',
    '',
    '  --project-root <path>  SquidRun source root (defaults to the linked project)',
    '  --timeout-ms <ms>      Bound the isolated Electron launch (minimum 5000)',
    '  --json                 Pretty-print the result',
    '  --help, -h             Show this help without launching Electron',
  ].join('\n');
}

function truncate(value, max = 4_000) {
  const text = String(value || '').trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function readJson(filePath, fsRef = fs) {
  try {
    return JSON.parse(fsRef.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function resolveElectronExecutable(uiRoot, options = {}) {
  const fsRef = options.fs || fs;
  const platform = options.platform || process.platform;
  const executableName = platform === 'win32' ? 'electron.exe' : 'electron';
  const executablePath = path.join(uiRoot, 'node_modules', 'electron', 'dist', executableName);
  try {
    if (fsRef.statSync(executablePath).isFile()) return executablePath;
  } catch {
    return null;
  }
  return null;
}

function createProbeSettings() {
  return {
    autoSpawn: false,
    devTools: false,
    dryRun: true,
    hiddenPaneHostsEnabled: false,
    paneFailureAlertsEnabled: false,
    voiceInputEnabled: false,
    voiceAutoSend: false,
  };
}

function prepareProbeRoot(projectRoot, options = {}) {
  const fsRef = options.fs || fs;
  const tempRoot = fsRef.mkdtempSync(path.join(options.tempDir || os.tmpdir(), PROBE_ROOT_PREFIX));
  const coordRoot = path.join(tempRoot, '.squidrun');
  const settingsDir = path.join(coordRoot, 'settings-restart-preflight');
  const runtimeDir = path.join(coordRoot, 'runtime');
  fsRef.mkdirSync(settingsDir, { recursive: true });
  fsRef.mkdirSync(runtimeDir, { recursive: true });
  fsRef.writeFileSync(path.join(coordRoot, 'link.json'), `${JSON.stringify({
    workspace: tempRoot,
    squidrun_root: path.resolve(projectRoot),
  }, null, 2)}\n`, 'utf8');
  fsRef.writeFileSync(
    path.join(settingsDir, 'settings.json'),
    `${JSON.stringify(createProbeSettings(), null, 2)}\n`,
    'utf8'
  );
  return {
    tempRoot,
    resultPath: path.join(runtimeDir, 'restart-launch-probe-result.json'),
  };
}

function buildProbeEnv(baseEnv, projectRoot, probeRoot, resultPath) {
  const env = { ...(baseEnv || process.env) };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  delete env.SQUIDRUN_INSTALL_MANIFEST;
  Object.assign(env, {
    [RESTART_LAUNCH_PROBE_ENV]: '1',
    [RESTART_LAUNCH_PROBE_RESULT_ENV]: resultPath,
    SQUIDRUN_DATA_ROOT: probeRoot,
    SQUIDRUN_PROJECT_ROOT: probeRoot,
    SQUIDRUN_RESTART_PREFLIGHT_PROJECT_ROOT: probeRoot,
    SQUIDRUN_PROFILE: 'restart-preflight',
    SQUIDRUN_BRIDGE_RELAY_MODE: 'off',
    SQUIDRUN_RELAY_MODE: 'off',
    SQUIDRUN_AUTO_HANDOFF_ENABLED: '0',
    SQUIDRUN_RESTART_PROBE_SOURCE_ROOT: path.resolve(projectRoot),
    TELEGRAM_BOT_TOKEN: '',
    TELEGRAM_CHAT_ID: '',
    TELEGRAM_AUTHORIZED_CHAT_IDS: '',
    TELEGRAM_CHAT_ALLOWLIST: '',
    TWILIO_ACCOUNT_SID: '',
    TWILIO_AUTH_TOKEN: '',
    TWILIO_PHONE_NUMBER: '',
    SMS_RECIPIENT: '',
  });
  return env;
}

function killProcessTree(pid, options = {}) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  if ((options.platform || process.platform) === 'win32') {
    try {
      (options.execFileSync || execFileSync)('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      return true;
    } catch {
      return false;
    }
  }
  try {
    process.kill(Number(pid), 'SIGKILL');
    return true;
  } catch {
    return false;
  }
}

function isProcessAlive(pid, options = {}) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try {
    (options.processKill || process.kill)(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProbeProcessesToExit(processIds, options = {}) {
  const ids = [...new Set((processIds || [])
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0))];
  const checkAlive = options.isProcessAlive || isProcessAlive;
  const timeoutMs = Math.max(0, Number(options.processExitTimeoutMs ?? DEFAULT_PROCESS_EXIT_TIMEOUT_MS));
  const pollMs = Math.max(10, Number(options.processExitPollMs) || 50);
  const sleep = options.sleep || ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  const deadline = Date.now() + timeoutMs;
  let remaining = ids.filter((pid) => checkAlive(pid, options));
  while (remaining.length > 0 && Date.now() < deadline) {
    await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
    remaining = remaining.filter((pid) => checkAlive(pid, options));
  }
  return {
    ok: remaining.length === 0,
    checked: ids,
    remaining,
  };
}

function runElectronProcess(command, args, options = {}) {
  const spawnImpl = options.spawn || spawn;
  const timeoutMs = Math.max(5_000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(command, args, {
        cwd: options.cwd,
        env: options.env,
        detached: false,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ ok: false, reason: 'spawn_failed', error: error?.message || String(error) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        ...result,
        pid: Number(child?.pid) || null,
        stdout: truncate(stdout),
        stderr: truncate(stderr),
      });
    };
    child.stdout?.on?.('data', (chunk) => { stdout += String(chunk || ''); });
    child.stderr?.on?.('data', (chunk) => { stderr += String(chunk || ''); });
    child.once?.('error', (error) => finish({
      ok: false,
      reason: 'spawn_failed',
      error: error?.message || String(error),
    }));
    child.once?.('exit', (code, signal) => finish({
      ok: code === 0,
      reason: code === 0 ? null : 'process_failed',
      exitCode: code,
      signal: signal || null,
    }));
    timer = setTimeout(() => {
      killProcessTree(Number(child?.pid), options);
      finish({ ok: false, reason: 'timeout', timeoutMs });
    }, timeoutMs);
  });
}

function findReparsePoint(rootPath, fsRef = fs) {
  const stack = [path.resolve(rootPath)];
  while (stack.length > 0) {
    const current = stack.pop();
    const stat = fsRef.lstatSync(current);
    if (stat.isSymbolicLink()) return current;
    if (!stat.isDirectory()) continue;
    for (const entry of fsRef.readdirSync(current, { withFileTypes: true })) {
      stack.push(path.join(current, entry.name));
    }
  }
  return null;
}

function cleanupOwnedProbeRoot(probeRoot, options = {}) {
  const fsRef = options.fs || fs;
  const tempDir = path.resolve(options.tempDir || os.tmpdir());
  const resolvedRoot = path.resolve(probeRoot);
  if (path.dirname(resolvedRoot) !== tempDir || !path.basename(resolvedRoot).startsWith(PROBE_ROOT_PREFIX)) {
    return { ok: false, reason: 'probe_root_not_owned', probeRoot: resolvedRoot };
  }
  if (!fsRef.existsSync(resolvedRoot)) return { ok: true, removed: false, probeRoot: resolvedRoot };
  const reparsePoint = findReparsePoint(resolvedRoot, fsRef);
  if (reparsePoint) {
    return { ok: false, reason: 'probe_root_contains_reparse_point', probeRoot: resolvedRoot, reparsePoint };
  }
  fsRef.rmSync(resolvedRoot, { recursive: true, force: true });
  return { ok: !fsRef.existsSync(resolvedRoot), removed: true, probeRoot: resolvedRoot };
}

async function runRestartLaunchProbe(projectRoot, options = {}) {
  const fsRef = options.fs || fs;
  const resolvedProjectRoot = path.resolve(projectRoot || getProjectRoot());
  const uiRoot = path.join(resolvedProjectRoot, 'ui');
  const electronPath = options.electronPath || resolveElectronExecutable(uiRoot, options);
  if (!electronPath) {
    return {
      ok: false,
      reason: 'electron_executable_missing',
      projectRoot: resolvedProjectRoot,
      uiRoot,
    };
  }

  let prepared;
  try {
    prepared = prepareProbeRoot(resolvedProjectRoot, options);
  } catch (error) {
    return {
      ok: false,
      reason: 'probe_root_prepare_failed',
      projectRoot: resolvedProjectRoot,
      error: error?.message || String(error),
    };
  }
  const { tempRoot, resultPath } = prepared;
  const env = buildProbeEnv(options.env || process.env, resolvedProjectRoot, tempRoot, resultPath);
  const runProcess = options.runElectronProcess || runElectronProcess;
  let processResult;
  try {
    processResult = await runProcess(
      electronPath,
      [uiRoot, '--profile=restart-preflight', '--window=main'],
      {
        ...options,
        cwd: uiRoot,
        env,
        timeoutMs: options.timeoutMs,
      }
    );
  } catch (error) {
    return {
      ok: false,
      reason: 'restart_launch_probe_runner_failed',
      projectRoot: resolvedProjectRoot,
      uiRoot,
      electronPath,
      probeRoot: tempRoot,
      error: error?.message || String(error),
    };
  }
  const reported = readJson(resultPath, fsRef);
  if (!processResult?.ok || processResult.exitCode !== 0) {
    return {
      ok: false,
      reason: processResult?.reason === 'timeout'
        ? 'restart_launch_probe_timeout'
        : 'restart_launch_probe_process_failed',
      projectRoot: resolvedProjectRoot,
      uiRoot,
      electronPath,
      probeRoot: tempRoot,
      process: processResult,
      reported,
    };
  }
  if (!reported || reported.schema !== RESTART_LAUNCH_PROBE_SCHEMA || reported.ok !== true) {
    return {
      ok: false,
      reason: reported?.reason || 'restart_launch_probe_result_missing_or_invalid',
      projectRoot: resolvedProjectRoot,
      uiRoot,
      electronPath,
      probeRoot: tempRoot,
      process: processResult,
      reported,
    };
  }
  if (
    path.resolve(reported.dataRoot || '') !== path.resolve(tempRoot)
    || reported.profile !== 'restart-preflight'
    || reported.stage !== 'renderer_ready'
    || reported.renderer?.visible !== false
    || reported.renderer?.focused !== false
  ) {
    return {
      ok: false,
      reason: 'restart_launch_probe_isolation_or_renderer_claim_invalid',
      projectRoot: resolvedProjectRoot,
      uiRoot,
      electronPath,
      probeRoot: tempRoot,
      process: processResult,
      reported,
    };
  }
  const processExit = await waitForProbeProcessesToExit([
    processResult.pid,
    ...(Array.isArray(reported.renderer?.processIds) ? reported.renderer.processIds : []),
  ], options);
  if (!processExit.ok) {
    return {
      ok: false,
      reason: 'restart_launch_probe_processes_remain',
      projectRoot: resolvedProjectRoot,
      uiRoot,
      electronPath,
      probeRoot: tempRoot,
      process: processResult,
      reported,
      processExit,
    };
  }
  const cleanup = cleanupOwnedProbeRoot(tempRoot, options);
  if (!cleanup.ok) {
    return {
      ok: false,
      reason: cleanup.reason || 'restart_launch_probe_cleanup_failed',
      projectRoot: resolvedProjectRoot,
      uiRoot,
      electronPath,
      probeRoot: tempRoot,
      process: processResult,
      reported,
      cleanup,
    };
  }
  return {
    ok: true,
    reason: null,
    projectRoot: resolvedProjectRoot,
    uiRoot,
    electronPath,
    process: {
      pid: processResult.pid || null,
      exitCode: processResult.exitCode,
      signal: processResult.signal || null,
    },
    renderer: reported.renderer,
    processExit,
    cleanup,
  };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return { ok: true, help: true };
  }
  const result = await runRestartLaunchProbe(args.projectRoot || getProjectRoot(), {
    timeoutMs: args.timeoutMs,
  });
  process.stdout.write(`${JSON.stringify(result, null, args.json ? 2 : 0)}\n`);
  process.exitCode = result.ok ? 0 : 1;
  return result;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_PROCESS_EXIT_TIMEOUT_MS,
  PROBE_ROOT_PREFIX,
  parseArgs,
  usage,
  readJson,
  resolveElectronExecutable,
  createProbeSettings,
  prepareProbeRoot,
  buildProbeEnv,
  killProcessTree,
  isProcessAlive,
  waitForProbeProcessesToExit,
  runElectronProcess,
  findReparsePoint,
  cleanupOwnedProbeRoot,
  runRestartLaunchProbe,
  main,
};
