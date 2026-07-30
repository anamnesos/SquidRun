#!/usr/bin/env node
'use strict';

const path = require('path');

const { getProjectRoot } = require('../config');
const {
  prepareCodexComputerUseNativeBridge,
  probeCodexComputerUseNativeBridge,
} = require('../modules/main/codex-computer-use-native-bridge');
const {
  EXACT_ORACLE_COMMAND,
  runStandaloneCodexComputerUseProof,
} = require('../modules/main/codex-computer-use-standalone-controller');

function setOption(options, key, value) {
  if (Object.prototype.hasOwnProperty.call(options, key)) {
    if (Array.isArray(options[key])) options[key].push(value);
    else options[key] = [options[key], value];
    return;
  }
  options[key] = value;
}

function parseArgs(argv = []) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '');
    if (!token) continue;
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const equalsIndex = token.indexOf('=');
    if (equalsIndex > 2) {
      setOption(options, token.slice(2, equalsIndex), token.slice(equalsIndex + 1));
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || String(next).startsWith('--')) {
      setOption(options, key, true);
      continue;
    }
    setOption(options, key, next);
    index += 1;
  }
  return {
    command: String(positional[0] || 'status').toLowerCase(),
    positional: positional.slice(1),
    options,
  };
}

function getOption(options, ...keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(options, key)) return options[key];
  }
  return null;
}

function optionIsTrue(options, ...keys) {
  return keys.some((key) => getOption(options, key) === true);
}

function printJson(payload, logger = console.log) {
  logger(JSON.stringify(payload, null, 2));
}

function usage() {
  return {
    ok: true,
    usage: [
      'node ui/scripts/hm-codex-computer-use-bridge.js status [--workspace <path>] [--pane-id <id>]',
      'node ui/scripts/hm-codex-computer-use-bridge.js prepare --workspace <path> --launch-owner [--dry-run] [--timeout-ms <ms>]',
      'node ui/scripts/hm-codex-computer-use-bridge.js activate --workspace <path> --profile main --launch-owner --execute-current-session-proof [--proof-timeout-ms <ms>]',
    ],
    safety: [
      'status is read-only',
      'prepare launches only the exact OpenAI Codex Desktop AUMID and only when --launch-owner is explicit',
      'activate connects only to the existing main daemon and creates a fresh lease-addressed verifier pane',
      'activate requires --execute-current-session-proof and cleans up only its exact verifier lease generation',
      'activate never recycles Architect, Builder, Oracle, Electron, the daemon, or a side-profile pane',
      'the script never starts codex-computer-use.exe or implements its pipe protocol',
      'the script never restarts or kills SquidRun, an existing pane, or a helper',
      'the script never retargets an existing node_repl process or claims an in-place rebind',
      'list_windows planning and verification require a server-held target-pane generation claim',
    ],
  };
}

function buildContext(options = {}, dependencies = {}) {
  const env = dependencies.env || process.env;
  const projectRoot = path.resolve(
    getOption(options, 'workspace', 'project-root', 'projectRoot')
      || dependencies.projectRoot
      || env.SQUIDRUN_PROJECT_ROOT
      || getProjectRoot()
  );
  return {
    env,
    projectRoot,
    workspace: projectRoot,
    paneId: String(
      getOption(options, 'pane-id', 'paneId')
        || dependencies.paneId
        || env.SQUIDRUN_PANE_ID
        || ''
    ).trim() || null,
    profile: String(
      getOption(options, 'profile')
        || dependencies.profile
        || env.SQUIDRUN_PROFILE
        || 'main'
    ).trim() || 'main',
  };
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const { command, options } = parseArgs(argv);
  const logger = dependencies.logger || console.log;
  if (command === 'help' || command === '-h' || command === '--help') {
    printJson(usage(), logger);
    return 0;
  }

  const context = buildContext(options, dependencies);
  const probe = dependencies.probe || probeCodexComputerUseNativeBridge;
  const prepare = dependencies.prepare || prepareCodexComputerUseNativeBridge;
  const activate = dependencies.activate || runStandaloneCodexComputerUseProof;
  let result;

  if (command === 'status') {
    result = await probe({
      ...context,
      now: getOption(options, 'now'),
    });
  } else if (command === 'prepare') {
    result = await prepare({
      ...context,
      launchOwner: optionIsTrue(options, 'launch-owner', 'launchOwner'),
      dryRun: optionIsTrue(options, 'dry-run', 'dryRun'),
      timeoutMs: getOption(options, 'timeout-ms', 'timeoutMs'),
      intervalMs: getOption(options, 'interval-ms', 'intervalMs'),
    }, dependencies);
  } else if (command === 'activate') {
    result = await activate({
      ...context,
      command: EXACT_ORACLE_COMMAND,
      launchOwner: optionIsTrue(options, 'launch-owner', 'launchOwner'),
      executeCurrentSessionProof: optionIsTrue(
        options,
        'execute-current-session-proof',
        'executeCurrentSessionProof'
      ),
      prepareTimeoutMs: getOption(options, 'timeout-ms', 'timeoutMs'),
      prepareIntervalMs: getOption(options, 'interval-ms', 'intervalMs'),
      proofTimeoutMs: getOption(options, 'proof-timeout-ms', 'proofTimeoutMs'),
      startupOutputTimeoutMs: getOption(
        options,
        'startup-output-timeout-ms',
        'startupOutputTimeoutMs'
      ),
      sourceMessageId: getOption(options, 'source-message-id', 'sourceMessageId'),
    }, dependencies);
  } else {
    result = {
      ok: false,
      reason: 'unknown_command',
      command,
      ...usage(),
    };
  }

  printJson(result, logger);
  return result.ok === true ? 0 : 1;
}

if (require.main === module) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    printJson({
      ok: false,
      reason: 'unhandled_error',
      error: error?.message || String(error),
    });
    process.exitCode = 1;
  });
}

module.exports = {
  buildContext,
  main,
  parseArgs,
  usage,
};
