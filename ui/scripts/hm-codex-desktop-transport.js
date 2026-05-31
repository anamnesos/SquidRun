#!/usr/bin/env node
'use strict';

const {
  probeCodexDesktopInboundTransport,
  summonCodexDesktop,
  writeProbeReport,
} = require('../modules/main/codex-desktop-inbound-transport');

function setOption(options, key, value) {
  if (Object.prototype.hasOwnProperty.call(options, key)) {
    if (Array.isArray(options[key])) options[key].push(value);
    else options[key] = [options[key], value];
  } else {
    options[key] = value;
  }
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
    const eqIndex = token.indexOf('=');
    if (eqIndex > 2) {
      setOption(options, token.slice(2, eqIndex), token.slice(eqIndex + 1));
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
  return { command: positional[0] || 'probe', positional: positional.slice(1), options };
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
      'node ui/scripts/hm-codex-desktop-transport.js probe [--out <path>] [--json]',
      'node ui/scripts/hm-codex-desktop-transport.js study [--out <path>] [--json]',
      'node ui/scripts/hm-codex-desktop-transport.js summon --workspace <path> [--dry-run]',
    ],
  };
}

function maybeWriteReport(payload, options = {}) {
  const outPath = getOption(options, 'out', 'output', 'report-path');
  if (!outPath && getOption(options, 'write-report') !== true) return payload;
  const written = writeProbeReport(payload, { outPath });
  return {
    ...payload,
    report: written,
  };
}

function main(argv = process.argv.slice(2), dependencies = {}) {
  const { command, options } = parseArgs(argv);
  const normalized = String(command || '').toLowerCase();
  const logger = dependencies.logger || console.log;
  const runner = dependencies.runner;
  if (normalized === 'help' || normalized === '--help' || normalized === '-h') {
    printJson(usage(), logger);
    return 0;
  }

  let result;
  if (normalized === 'probe' || normalized === 'study') {
    result = maybeWriteReport(probeCodexDesktopInboundTransport({
      runner,
      now: getOption(options, 'now'),
    }), options);
  } else if (normalized === 'summon') {
    result = summonCodexDesktop({
      workspace: getOption(options, 'workspace', 'path', 'project-path'),
      dryRun: optionIsTrue(options, 'dry-run', 'dryRun'),
    }, {
      runner,
      now: getOption(options, 'now'),
    });
  } else {
    result = { ok: false, reason: 'unknown_command', command: normalized, ...usage() };
  }

  printJson(result, logger);
  return result.ok === true || normalized === 'probe' || normalized === 'study' ? 0 : 1;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (err) {
    printJson({ ok: false, reason: err.message || String(err) });
    process.exitCode = 1;
  }
}

module.exports = {
  main,
  parseArgs,
};
