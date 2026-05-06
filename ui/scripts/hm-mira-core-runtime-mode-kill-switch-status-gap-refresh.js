#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const {
  buildMiraCoreRuntimeModeKillSwitchStatusGapRefresh,
} = require('../modules/mira-core/runtime-mode-kill-switch-status-gap-refresh');

function parseArgs(argv = []) {
  const parsed = {
    fixturePath: path.resolve(
      __dirname,
      '..',
      '__tests__',
      'fixtures',
      'mira-core-runtime-mode-kill-switch-status-gap-refresh-contract.json',
    ),
    pretty: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '');
    if (token === '--pretty') {
      parsed.pretty = true;
    } else if (token === '--fixture') {
      parsed.fixturePath = argv[index + 1] || parsed.fixturePath;
      index += 1;
    } else if (token.startsWith('--fixture=')) {
      parsed.fixturePath = token.slice('--fixture='.length);
    } else if (token === '--out') {
      index += 1;
    } else if (token.startsWith('--out=')) {
      // Phase 41 is stdout-only. Output-file flags are deliberately ignored.
    } else if (token && !token.startsWith('-')) {
      parsed.fixturePath = token;
    }
  }
  return parsed;
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function main(argv = process.argv.slice(2), stdinText = null) {
  const args = parseArgs(argv);
  const inputText = stdinText === null ? readStdin() : String(stdinText || '');
  const inputSignals = inputText.trim() ? JSON.parse(inputText) : {};
  const contract = JSON.parse(fs.readFileSync(path.resolve(args.fixturePath), 'utf8'));
  const output = buildMiraCoreRuntimeModeKillSwitchStatusGapRefresh({ inputSignals, contract });
  process.stdout.write(`${JSON.stringify(output, null, args.pretty ? 2 : 0)}\n`);
  return output;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  main,
  parseArgs,
  readStdin,
};
