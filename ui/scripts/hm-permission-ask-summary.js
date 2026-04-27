#!/usr/bin/env node
'use strict';

const {
  summarizePermissionAskViolations,
  DEFAULT_PERMISSION_ASK_VIOLATIONS_PATH,
} = require('./hm-send-permission-guard');

function parseCliArgs(argv = process.argv.slice(2)) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2).trim();
    const next = argv[index + 1];
    const value = (!next || next.startsWith('--')) ? true : next;
    if (value !== true) index += 1;
    options.set(key, value);
  }
  return options;
}

function toNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function main() {
  const options = parseCliArgs();
  const logPath = options.get('log-path') || DEFAULT_PERMISSION_ASK_VIOLATIONS_PATH;
  const hours = toNumber(options.get('hours'), 24);
  const summary = summarizePermissionAskViolations({ logPath, hours });
  console.log(JSON.stringify(summary, null, 2));
}

main();
