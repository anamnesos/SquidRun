#!/usr/bin/env node
'use strict';

const fs = require('fs');

const { buildMiraCorePulse } = require('../modules/mira-core/pulse');

function parseArgs(argv = []) {
  const parsed = {
    cadence: 'manual',
    pretty: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '');
    if (token === '--pretty') {
      parsed.pretty = true;
    } else if (token === '--cadence') {
      parsed.cadence = argv[index + 1] || parsed.cadence;
      index += 1;
    } else if (token.startsWith('--cadence=')) {
      parsed.cadence = token.slice('--cadence='.length);
    } else if (token === '--out') {
      index += 1;
    } else if (token.startsWith('--out=')) {
      // Pulse v0 is stdout-only. Ignore output-file flags deliberately.
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
  const pulse = buildMiraCorePulse({
    inputSignals,
    cadence: args.cadence,
  });
  process.stdout.write(`${JSON.stringify(pulse, null, args.pretty ? 2 : 0)}\n`);
  return pulse;
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
