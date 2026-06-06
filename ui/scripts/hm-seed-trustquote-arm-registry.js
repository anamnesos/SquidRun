#!/usr/bin/env node
'use strict';

const {
  TRUSTQUOTE_ARM_REGISTRY_SEED_SCHEMA,
  seedTrustQuoteArmRegistry,
} = require('../modules/main/trustquote-arm-registry-seed');
const { closeArmRegistryStores } = require('../modules/main/arm-registry');
const { closeArmApplyQueueStores } = require('../modules/main/arm-apply-queue');
const log = require('../modules/logger');

function setOption(options, key, value) {
  options[key] = value;
}

function parseArgs(argv = []) {
  const options = {
    command: 'seed',
    json: false,
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '');
    if (!token) continue;
    if (!token.startsWith('--') && options.command === 'seed') {
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
    if (key === 'dry-run') {
      options.dryRun = true;
      continue;
    }
    if (key === 'no-evaluate') {
      options.evaluate = false;
      continue;
    }
    if (['db', 'session', 'main-session', 'session-number', 'project-root', 'app-status', 'now-ms'].includes(key)) {
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
    schema: TRUSTQUOTE_ARM_REGISTRY_SEED_SCHEMA,
    usage: [
      'node ui/scripts/hm-seed-trustquote-arm-registry.js seed --json',
      'node ui/scripts/hm-seed-trustquote-arm-registry.js seed --session app-session-406:trustquote --db <path> --json',
      'node ui/scripts/hm-seed-trustquote-arm-registry.js seed --dry-run --json',
    ],
    writes: ['arm_registries', 'arm_registry_arms'],
    doesNotWrite: ['arm_checkin_proofs', 'arm_apply_requests', 'arm_missing_watchdogs'],
  };
}

function buildSeedOptions(options = {}) {
  return {
    ...(options.db ? { dbPath: options.db } : {}),
    ...(options.session ? { sessionId: options.session } : {}),
    ...(options['main-session'] ? { mainSessionId: options['main-session'] } : {}),
    ...(options['session-number'] ? { sessionNumber: Number(options['session-number']) } : {}),
    ...(options['project-root'] ? { projectRoot: options['project-root'] } : {}),
    ...(options['app-status'] ? { appStatusPath: options['app-status'] } : {}),
    ...(options['now-ms'] ? { nowMs: Number(options['now-ms']) } : {}),
    dryRun: options.dryRun === true,
    evaluate: options.evaluate !== false,
  };
}

function printJson(payload) {
  console.log(JSON.stringify(payload, null, 2));
}

function printText(result) {
  if (!result.ok) {
    console.log(`TrustQuote arm seed failed: ${result.reason || result.status || 'unknown'}`);
    return;
  }
  const registry = result.registry || result.manifest || {};
  console.log(`TrustQuote arm seed: ${result.status}`);
  console.log(`Room/session: ${registry.appRoomId || 'trustquote'} / ${registry.sessionId || 'unknown'}`);
  console.log(`Desired/ready/missing: ${registry.desiredCount || 3}/${registry.readyCount || 0}/${registry.missingCount || 3}`);
  console.log('Desired arms: Lead, Work + Schedule, Money + Documents');
  console.log('Dev/QA remains build-mode metadata only; no check-ins, apply requests, watchdogs, or dispatches created.');
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.command === 'help') {
    printJson(usage());
    return 0;
  }
  if (options.command !== 'seed') {
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
    result = seedTrustQuoteArmRegistry(buildSeedOptions(options));
  } finally {
    console.log = originalConsole.log;
    console.info = originalConsole.info;
    console.warn = originalConsole.warn;
    closeArmRegistryStores();
    closeArmApplyQueueStores();
  }

  if (options.json) printJson(result);
  else printText(result);
  return result.ok ? 0 : 1;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (err) {
    printJson({ ok: false, reason: err.message || String(err), schema: TRUSTQUOTE_ARM_REGISTRY_SEED_SCHEMA });
    process.exitCode = 1;
  }
}

module.exports = {
  buildSeedOptions,
  main,
  parseArgs,
};
