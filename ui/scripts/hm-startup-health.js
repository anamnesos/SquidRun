#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  main,
  normalizeProjectRoot,
} = require('./hm-health-snapshot');
const { DEFAULT_PROFILE, normalizeProfileName } = require('../profile');

const VALUE_OPTIONS = new Set(['--output', '--profile']);

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
    return token !== '--no-telegram-poller-auto-recover';
  });
}

function writeWatchdogLast(projectRoot, payload) {
  const outputPath = path.join(projectRoot, '.squidrun', 'runtime', 'telegram-poller-watchdog-last.json');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return outputPath;
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

const argv = process.argv.slice(2);
if (!hasFormatFlag(argv)) {
  argv.push('--markdown');
}

const recovery = runTelegramPollerAutoRecover(argv);
if (recovery?.ok === false) {
  process.stderr.write(`Telegram poller watchdog preflight failed: ${recovery.error || recovery.stderr || 'unknown'}\n`);
}

process.exitCode = main(stripWrapperFlags(argv));
