#!/usr/bin/env node

const { main } = require('./hm-health-snapshot');

function hasFormatFlag(argv = []) {
  return argv.some((arg) => arg === '--json' || arg === '--markdown');
}

const argv = process.argv.slice(2);
if (!hasFormatFlag(argv)) {
  argv.push('--markdown');
}

process.exitCode = main(argv);
