#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const {
  buildMiraPresenceRuntimeStateV0,
  markInterruptedNotCaptured,
  readMiraPresenceRuntimeStartupSummary,
} = require('../modules/mira-core/mira-presence-runtime-state-v0');
const {
  refreshMiraPresenceCurrentScopeStateV0,
} = require('../modules/mira-core/mira-presence-current-scope-state-v0');

function parseArgs(argv) {
  const args = {
    projectRoot: null,
    apply: false,
    action: 'apply',
    statePath: null,
  };
  const list = Array.isArray(argv) ? argv.slice() : [];
  while (list.length > 0) {
    const token = list.shift();
    if (!token) continue;
    if (token === '--apply') { args.apply = true; continue; }
    if (token === '--read') { args.action = 'read'; continue; }
    if (token === '--mark-interrupted') { args.action = 'mark_interrupted'; continue; }
    if (token === '--refresh-current-scope') { args.action = 'refresh_current_scope'; continue; }
    if (token === '--project-root' || token === '--project') {
      args.projectRoot = list.shift();
      continue;
    }
    const eq = token.indexOf('=');
    if (eq > 0) {
      const key = token.slice(0, eq);
      const value = token.slice(eq + 1);
      if (key === '--project-root' || key === '--project') {
        args.projectRoot = value;
        continue;
      }
      if (key === '--state-file') {
        args.statePath = value;
        continue;
      }
    }
    if (token === '--state-file') {
      args.statePath = list.shift();
      continue;
    }
  }
  return args;
}

function loadStateFromStdinOrFile(args) {
  if (args.statePath) {
    return JSON.parse(fs.readFileSync(args.statePath, 'utf8'));
  }
  if (process.stdin.isTTY) return null;
  // Use synchronous fd 0 read so real piped input (echo … | node script) works.
  // The non-blocking process.stdin.read() loop misses data that has not yet
  // landed in the readable buffer at call time.
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch (err) {
    if (err && (err.code === 'EAGAIN' || err.code === 'ENOTCONN' || err.code === 'EBADF')) {
      return null;
    }
    throw err;
  }
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;
  return JSON.parse(trimmed);
}

function resolveProjectRoot(args) {
  if (args.projectRoot) return path.resolve(args.projectRoot);
  return path.resolve(process.cwd());
}

function main(argv, stdinJson) {
  const args = parseArgs(argv || process.argv.slice(2));
  const projectRoot = resolveProjectRoot(args);

  if (args.action === 'read') {
    const out = readMiraPresenceRuntimeStartupSummary({ projectRoot });
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return out;
  }

  if (args.action === 'mark_interrupted') {
    const out = markInterruptedNotCaptured({ projectRoot, apply: args.apply });
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return out;
  }

  if (args.action === 'refresh_current_scope') {
    const out = refreshMiraPresenceCurrentScopeStateV0({ projectRoot, apply: args.apply });
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return out;
  }

  let state;
  if (stdinJson != null) {
    state = typeof stdinJson === 'string' ? JSON.parse(stdinJson) : stdinJson;
  } else {
    state = loadStateFromStdinOrFile(args);
  }
  const out = buildMiraPresenceRuntimeStateV0({
    projectRoot,
    apply: args.apply,
    state,
  });
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  return out;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`hm-mira-presence-runtime-state-v0: ${err.message}\n`);
    process.exit(1);
  }
}

module.exports = { main, parseArgs };
