#!/usr/bin/env node
'use strict';

const {
  ARM_STATE_PROJECTION_SCHEMA,
  buildArmStateProjection,
  closeArmStateProjectionStores,
} = require('../modules/main/arm-state-projection');
const log = require('../modules/logger');

function setOption(options, key, value) {
  options[key] = value;
}

function parseArgs(argv = []) {
  const options = {
    command: 'status',
    json: false,
    includeRows: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '');
    if (!token) continue;
    if (!token.startsWith('--') && options.command === 'status') {
      options.command = token;
      continue;
    }
    const eqIndex = token.indexOf('=');
    if (eqIndex > 2) {
      setOption(options, token.slice(2, eqIndex), token.slice(eqIndex + 1));
      continue;
    }
    const key = token.replace(/^--/, '');
    if (key === 'json') {
      options.json = true;
      continue;
    }
    if (key === 'no-rows') {
      options.includeRows = false;
      continue;
    }
    if (['db', 'registry-id', 'app-room', 'room', 'session', 'now-ms'].includes(key)) {
      const next = argv[index + 1];
      if (!next || String(next).startsWith('--')) {
        throw new Error(`--${key} requires a value`);
      }
      setOption(options, key, next);
      index += 1;
      continue;
    }
    if (key === 'help' || key === 'h') {
      options.command = 'help';
      continue;
    }
    throw new Error(`unknown_option: --${key}`);
  }
  return options;
}

function usage() {
  return {
    ok: true,
    schema: ARM_STATE_PROJECTION_SCHEMA,
    usage: [
      'node ui/scripts/hm-arm-state.js status --app-room trustquote --session app-session-406:trustquote --json',
      'node ui/scripts/hm-arm-state.js status --registry-id <id> [--db <path>] [--no-rows]',
    ],
    readOnly: true,
    explicitInvocationRequired: true,
  };
}

function buildFilters(options = {}) {
  return {
    ...(options['registry-id'] ? { registryId: options['registry-id'] } : {}),
    ...(options['app-room'] || options.room ? { appRoomId: options['app-room'] || options.room } : {}),
    ...(options.session ? { sessionId: options.session } : {}),
  };
}

function buildOptions(options = {}) {
  return {
    ...(options.db ? { dbPath: options.db } : {}),
    ...(options['now-ms'] ? { nowMs: Number(options['now-ms']) } : {}),
    includeRows: options.includeRows !== false,
  };
}

function printJson(payload) {
  console.log(JSON.stringify(payload, null, 2));
}

function printText(result) {
  if (!result.ok) {
    console.log(`Arm state: ${result.status} (${result.reason || 'unknown'})`);
    return;
  }
  const registry = result.registry || {};
  const watchdogs = result.watchdogs?.summary || {};
  const queue = result.applyQueue?.summary || {};
  console.log(`Arm state: ${result.status}`);
  console.log(`Room/session: ${registry.appRoomId || 'unknown'} / ${registry.sessionId || 'unknown'}`);
  console.log(`Desired/ready/missing: ${registry.desiredCount}/${registry.readyCount}/${registry.missingCount}`);
  console.log(`Watchdogs: open=${watchdogs.open || 0} overdue=${watchdogs.overdue || 0} escalated=${watchdogs.escalated || 0}`);
  console.log(`Apply queue: total=${queue.total || 0} pendingApproval=${queue.pendingApproval || 0} executable=${queue.executable || 0}`);
  console.log('Read-only projection: no dispatch, no watchdog advance, no TrustQuote room behavior change.');
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.command === 'help') {
    printJson(usage());
    return 0;
  }
  if (options.command !== 'status') {
    printJson({ ok: false, reason: 'unknown_command', command: options.command, ...usage() });
    return 1;
  }

  const originalConsole = {
    log: console.log,
    info: console.info,
    warn: console.warn,
  };
  let result;
  try {
    if (options.json) {
      log.setLevel('warn');
      console.log = () => {};
      console.info = () => {};
      console.warn = () => {};
    }
    result = buildArmStateProjection(buildFilters(options), buildOptions(options));
  } finally {
    console.log = originalConsole.log;
    console.info = originalConsole.info;
    console.warn = originalConsole.warn;
  }
  if (options.json) printJson(result);
  else printText(result);
  closeArmStateProjectionStores();
  return result.ok ? 0 : 1;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (err) {
    printJson({ ok: false, reason: err.message || String(err), schema: ARM_STATE_PROJECTION_SCHEMA });
    process.exitCode = 1;
  }
}

module.exports = {
  buildFilters,
  buildOptions,
  main,
  parseArgs,
};
