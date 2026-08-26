#!/usr/bin/env node
'use strict';

const {
  EXAMPLEAPP_ARM_REGISTRY_SEED_SCHEMA,
  seedExampleAppArmRegistry,
  resolveExampleAppManifestSessionId,
} = require('../modules/main/exampleapp-arm-registry-seed');
const {
  closeArmRegistryStores,
  migrateArmRegistryManifestScope,
} = require('../modules/main/arm-registry');
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
    if ([
      'db',
      'session',
      'main-session',
      'session-number',
      'project-root',
      'app-status',
      'now-ms',
      'from-session',
      'to-session',
    ].includes(key)) {
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
    schema: EXAMPLEAPP_ARM_REGISTRY_SEED_SCHEMA,
    usage: [
      'node ui/scripts/hm-seed-exampleapp-arm-registry.js seed --json',
      'node ui/scripts/hm-seed-exampleapp-arm-registry.js seed --session app-session-407:exampleapp --db <path> --json',
      'node ui/scripts/hm-seed-exampleapp-arm-registry.js migrate --from-session app-session-406:exampleapp --json',
      'node ui/scripts/hm-seed-exampleapp-arm-registry.js seed --dry-run --json',
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
    ...(options['from-session'] ? { fromSessionId: options['from-session'] } : {}),
    dryRun: options.dryRun === true,
    evaluate: options.evaluate !== false,
  };
}

function buildMigrationOptions(options = {}) {
  return {
    appRoomId: 'exampleapp',
    ...(options['from-session'] ? { fromSessionId: options['from-session'] } : {}),
    toSessionId: options['to-session'] || resolveExampleAppManifestSessionId(),
  };
}

function printJson(payload) {
  console.log(JSON.stringify(payload, null, 2));
}

function printText(result) {
  if (!result.ok) {
    console.log(`ExampleApp arm seed failed: ${result.reason || result.status || 'unknown'}`);
    return;
  }
  const registry = result.registry || result.manifest || {};
  console.log(`ExampleApp arm seed: ${result.status}`);
  console.log(`Room/manifest session: ${registry.appRoomId || 'exampleapp'} / ${registry.sessionId || 'unknown'}`);
  if (registry.metadata?.readinessSessionId || result.evaluation?.registry?.readinessSessionId) {
    console.log(`Readiness session: ${registry.metadata?.readinessSessionId || result.evaluation.registry.readinessSessionId}`);
  }
  console.log(`${registry.desiredCount || 3} arms`);
  console.log('Arms: Lead, Invoice, Schedule Dispatch');
  console.log('Dev/QA remains build-mode metadata only; no check-ins, apply requests, watchdogs, or dispatches created.');
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.command === 'help') {
    printJson(usage());
    return 0;
  }
  if (!['seed', 'migrate'].includes(options.command)) {
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
    if (options.command === 'migrate') {
      result = migrateArmRegistryManifestScope(buildMigrationOptions(options), {
        ...(options.db ? { dbPath: options.db } : {}),
        ...(options['now-ms'] ? { nowMs: Number(options['now-ms']) } : {}),
        role: 'builder',
        paneId: 'builder',
        source: 'hm-seed-exampleapp-arm-registry',
      });
    } else {
      result = seedExampleAppArmRegistry(buildSeedOptions(options));
    }
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
    printJson({ ok: false, reason: err.message || String(err), schema: EXAMPLEAPP_ARM_REGISTRY_SEED_SCHEMA });
    process.exitCode = 1;
  }
}

module.exports = {
  buildSeedOptions,
  main,
  parseArgs,
};
