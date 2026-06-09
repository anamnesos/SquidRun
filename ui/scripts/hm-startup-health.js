#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  main,
  normalizeProjectRoot,
} = require('./hm-health-snapshot');
const { DEFAULT_PROFILE, normalizeProfileName } = require('../profile');

const VALUE_OPTIONS = new Set([
  '--output',
  '--profile',
  '--telegram-poller-stale-threshold-ms',
]);

function hasFormatFlag(argv = []) {
  return argv.some((arg) => arg === '--json' || arg === '--markdown');
}

function hasHelpFlag(argv = []) {
  return argv.some((arg) => arg === '--help' || arg === '-h');
}

function getOptionValue(argv = [], name) {
  const inlinePrefix = `${name}=`;
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '');
    if (token.startsWith(inlinePrefix)) {
      return token.slice(inlinePrefix.length);
    }
    if (token === name) {
      return argv[index + 1] || null;
    }
  }
  return null;
}

function resolveProfileFromArgs(argv = []) {
  return normalizeProfileName(getOptionValue(argv, '--profile') || DEFAULT_PROFILE);
}

function resolveProjectRootFromArgs(argv = []) {
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '');
    if (!token) continue;
    if (token.startsWith('--')) {
      const optionName = token.includes('=') ? token.slice(0, token.indexOf('=')) : token;
      if (VALUE_OPTIONS.has(optionName) && !token.includes('=')) {
        index += 1;
      }
      continue;
    }
    return normalizeProjectRoot(token);
  }
  return normalizeProjectRoot(null);
}

function stripWrapperFlags(argv = []) {
  return argv.filter((arg) => {
    const token = String(arg || '');
    return token !== '--no-telegram-poller-auto-recover'
      && token !== '--no-bidirectional-wake-watchdog-auto-start';
  });
}

function writeRuntimeJson(projectRoot, filename, payload) {
  const outputPath = path.join(projectRoot, '.squidrun', 'runtime', filename);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return outputPath;
}

function writeWatchdogLast(projectRoot, payload) {
  return writeRuntimeJson(projectRoot, 'telegram-poller-watchdog-last.json', payload);
}

function runTelegramPollerAutoRecover(argv = []) {
  if (hasHelpFlag(argv) || argv.includes('--no-telegram-poller-auto-recover')) {
    return { ok: true, skipped: true, reason: 'disabled_or_help' };
  }
  if (resolveProfileFromArgs(argv) !== DEFAULT_PROFILE) {
    return { ok: true, skipped: true, reason: 'profile_not_owner' };
  }

  const projectRoot = resolveProjectRootFromArgs(argv);
  const threshold = getOptionValue(argv, '--telegram-poller-stale-threshold-ms');
  const watchdogPath = path.join(__dirname, 'hm-telegram-poller-watchdog.js');
  const args = [
    watchdogPath,
    'recover',
    `--project-root=${projectRoot}`,
  ];
  if (threshold) {
    args.push(`--threshold-ms=${threshold}`);
  }

  const startedAt = new Date().toISOString();
  const result = spawnSync(process.execPath, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  });
  let parsed = null;
  try {
    parsed = result.stdout ? JSON.parse(result.stdout) : null;
  } catch {
    parsed = null;
  }

  const payload = {
    ok: result.status === 0 && result.error === undefined,
    startedAt,
    completedAt: new Date().toISOString(),
    projectRoot,
    command: args,
    status: result.status,
    error: result.error ? result.error.message : null,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    result: parsed,
  };
  payload.outputPath = writeWatchdogLast(projectRoot, payload);
  return payload;
}

function writeBidirectionalWakeWatchdogStartLast(projectRoot, payload) {
  return writeRuntimeJson(projectRoot, 'bidirectional-wake-watchdog-start-last.json', payload);
}

function runBidirectionalWakeWatchdogAutoStart(argv = []) {
  if (hasHelpFlag(argv) || argv.includes('--no-bidirectional-wake-watchdog-auto-start')) {
    return { ok: true, skipped: true, reason: 'disabled_or_help' };
  }
  if (resolveProfileFromArgs(argv) !== DEFAULT_PROFILE) {
    return { ok: true, skipped: true, reason: 'profile_not_owner' };
  }

  const projectRoot = resolveProjectRootFromArgs(argv);
  const watchdogPath = path.join(__dirname, 'hm-bidirectional-wake-watchdog.js');
  const args = [
    watchdogPath,
    'start',
  ];

  const startedAt = new Date().toISOString();
  const result = spawnSync(process.execPath, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
    env: {
      ...process.env,
      SQUIDRUN_PROJECT_ROOT: projectRoot,
    },
  });
  let parsed = null;
  try {
    parsed = result.stdout ? JSON.parse(result.stdout) : null;
  } catch {
    parsed = null;
  }

  const payload = {
    ok: result.status === 0 && result.error === undefined && parsed?.ok !== false,
    startedAt,
    completedAt: new Date().toISOString(),
    projectRoot,
    command: args,
    status: result.status,
    error: result.error ? result.error.message : null,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    result: parsed,
  };
  payload.outputPath = writeBidirectionalWakeWatchdogStartLast(projectRoot, payload);
  return payload;
}

function runStartupHealth(argv = process.argv.slice(2), io = {}) {
  const effectiveArgv = [...argv];
  const stderr = io.stderr || process.stderr;
  if (!hasFormatFlag(effectiveArgv)) {
    effectiveArgv.push('--markdown');
  }

  const telegramRecovery = runTelegramPollerAutoRecover(effectiveArgv);
  if (telegramRecovery?.ok === false) {
    stderr.write(`Telegram poller watchdog preflight failed: ${telegramRecovery.error || telegramRecovery.stderr || 'unknown'}\n`);
  }

  const bidirectionalWakeWatchdog = runBidirectionalWakeWatchdogAutoStart(effectiveArgv);
  if (bidirectionalWakeWatchdog?.ok === false) {
    stderr.write(`Bidirectional wake watchdog auto-start failed: ${bidirectionalWakeWatchdog.error || bidirectionalWakeWatchdog.stderr || 'unknown'}\n`);
  }

  return main(stripWrapperFlags(effectiveArgv));
}

if (require.main === module) {
  process.exitCode = runStartupHealth(process.argv.slice(2));
}

module.exports = {
  hasFormatFlag,
  hasHelpFlag,
  resolveProfileFromArgs,
  resolveProjectRootFromArgs,
  runBidirectionalWakeWatchdogAutoStart,
  runStartupHealth,
  runTelegramPollerAutoRecover,
  stripWrapperFlags,
};
