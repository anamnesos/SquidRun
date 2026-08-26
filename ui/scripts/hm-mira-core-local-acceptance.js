#!/usr/bin/env node
'use strict';

const fs = require('fs');

const { buildMiraCoreLocalAcceptance } = require('../modules/mira-core/local-acceptance');

function parseArgs(argv = []) {
  const parsed = {
    pretty: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '');
    if (token === '--pretty') {
      parsed.pretty = true;
    } else if (token === '--out') {
      index += 1;
    } else if (token.startsWith('--out=')) {
      // Phase 9 is stdout-only. Output-file flags are deliberately ignored.
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
  const output = buildMiraCoreLocalAcceptance({ inputSignals });
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
