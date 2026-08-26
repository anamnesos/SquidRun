#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const { getProjectRoot } = require('../config');
const { resolveDefaultCognitiveMemoryDbPath } = require('../modules/cognitive-memory-store');
const {
  freezeMemoryMetabolism,
  inspectMemoryMetabolismFreeze,
  unfreezeMemoryMetabolism,
} = require('../modules/memory-metabolism-freeze');

function parseArgs(argv = []) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = String(argv[index] || '');
    if (!value.startsWith('--')) {
      positional.push(value);
      continue;
    }
    const key = value.slice(2);
    const next = argv[index + 1];
    if (next != null && !String(next).startsWith('--')) {
      flags[key] = String(next);
      index += 1;
    } else {
      flags[key] = true;
    }
  }
  return { positional, flags };
}

function usage() {
  return [
    'Usage:',
    '  node ui/scripts/hm-memory-metabolism.js status [--db-path <path>] [--state-path <path>]',
    '  node ui/scripts/hm-memory-metabolism.js freeze [--artifact-dir <path>] [--expected-promoted <n>] [--evidence-window-days <n>] [--reason <text>]',
    '  node ui/scripts/hm-memory-metabolism.js unfreeze [--unfrozen-by <name>]',
    '',
    'Freeze is reversible. It exports promoted cognitive-memory PRs, creates a consistent SQLite snapshot,',
    'installs a live database write barrier for the already-running supervisor, and writes a hot-readable marker.',
    'This command has no delete or retire operation.',
  ].join('\n');
}

function readCurrentSession(projectRoot) {
  try {
    const statusPath = path.join(projectRoot, '.squidrun', 'app-status.json');
    const payload = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    return payload.session || payload.sessionNumber || null;
  } catch {
    return null;
  }
}

function safeOutput(result) {
  const payload = { ...result };
  if (payload.state && typeof payload.state === 'object') {
    payload.state = {
      active: payload.state.active === true,
      malformed: payload.state.malformed === true,
      reason: payload.state.reason || null,
      frozenAt: payload.state.frozenAt || null,
      reviewAfter: payload.state.reviewAfter || null,
      promotedCount: payload.state.promotedCount ?? null,
      artifacts: payload.state.artifacts || null,
    };
  }
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = String(positional[0] || 'status').toLowerCase();
  if (flags.help || command === 'help') {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const projectRoot = path.resolve(String(flags['project-root'] || getProjectRoot() || process.cwd()));
  const dbPath = path.resolve(String(flags['db-path'] || resolveDefaultCognitiveMemoryDbPath({
    projectRoot,
    profileName: flags.profile,
  })));
  const statePath = flags['state-path'] ? path.resolve(String(flags['state-path'])) : undefined;

  if (command === 'status') {
    safeOutput(inspectMemoryMetabolismFreeze({ dbPath, statePath }));
    return;
  }

  if (command === 'freeze') {
    const session = flags.session || readCurrentSession(projectRoot);
    const artifactDir = flags['artifact-dir']
      ? path.resolve(String(flags['artifact-dir']))
      : path.join(projectRoot, '.squidrun', 'coord', `memory-metabolism-freeze${session ? `-s${session}` : ''}`);
    safeOutput(freezeMemoryMetabolism({
      dbPath,
      statePath,
      artifactDir,
      session,
      expectedPromotedCount: flags['expected-promoted'],
      evidenceWindowDays: flags['evidence-window-days'],
      reason: flags.reason,
      force: flags.force === true,
    }));
    return;
  }

  if (command === 'unfreeze') {
    safeOutput(unfreezeMemoryMetabolism({
      dbPath,
      statePath,
      unfrozenBy: flags['unfrozen-by'] || process.env.SQUIDRUN_ROLE || 'manual',
    }));
    return;
  }

  throw new Error(`unknown_command:${command}\n${usage()}`);
}

try {
  main();
} catch (err) {
  process.stderr.write(`${err.stack || err.message}\n`);
  process.exitCode = 1;
}

module.exports = {
  main,
  parseArgs,
  readCurrentSession,
  safeOutput,
  usage,
};
