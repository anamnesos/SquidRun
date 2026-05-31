#!/usr/bin/env node
'use strict';

/**
 * hm-codex-capability-status: report discoverable Codex Desktop, app-control,
 * attention inbox, desktop transport, and heartbeat-check capability status.
 *
 * Usage:
 *   node ui/scripts/hm-codex-capability-status.js [status] [--json|--markdown] [--write-report] [--out <path>]
 */

const {
  buildCodexDesktopCapabilityStatus,
  renderCodexDesktopCapabilityMarkdown,
  writeStatusReport,
} = require('../modules/main/codex-desktop-capability-awareness');

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
    const token = String(argv[index] || '').trim();
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
  return {
    command: positional[0] || 'status',
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

function usage() {
  return [
    'Usage:',
    '  node ui/scripts/hm-codex-capability-status.js [status] [--json|--markdown] [--write-report] [--out <path>]',
    '',
    'Reports Codex Desktop/process availability separately from heartbeat and attention-inbox freshness.',
    '',
  ].join('\n');
}

function main(argv = process.argv.slice(2), dependencies = {}) {
  const { command, options } = parseArgs(argv);
  const normalized = String(command || '').toLowerCase();
  const stdout = dependencies.stdout || process.stdout;
  const stderr = dependencies.stderr || process.stderr;

  if (normalized === 'help' || normalized === '--help' || normalized === '-h') {
    stdout.write(usage());
    return 0;
  }
  if (normalized !== 'status') {
    stderr.write(`Unknown command: ${normalized}\n\n${usage()}`);
    return 1;
  }

  const status = buildCodexDesktopCapabilityStatus({
    projectRoot: getOption(options, 'project-root', 'projectRoot'),
    instance: getOption(options, 'instance'),
    now: getOption(options, 'now'),
    nowMs: getOption(options, 'now-ms', 'nowMs'),
    generatedAt: getOption(options, 'generated-at', 'generatedAt'),
    outPath: getOption(options, 'out', 'output', 'report-path'),
    runner: dependencies.runner,
  });

  const writeReport = optionIsTrue(options, 'write-report')
    || getOption(options, 'out', 'output', 'report-path');
  const payload = writeReport
    ? { ...status, report: writeStatusReport(status, { outPath: getOption(options, 'out', 'output', 'report-path') }) }
    : status;

  if (optionIsTrue(options, 'markdown')) {
    stdout.write(renderCodexDesktopCapabilityMarkdown(payload));
  } else {
    stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  }
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (err) {
    process.stderr.write(`${err.message || String(err)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  main,
  parseArgs,
};
