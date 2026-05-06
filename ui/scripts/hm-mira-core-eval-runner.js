#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const {
  defaultFixturePath,
  validateMiraCoreEvalFixture,
} = require('../modules/mira-core/eval-runner');

function parseArgs(argv = []) {
  const parsed = {
    fixturePath: defaultFixturePath(),
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
      // Eval runner v0 is stdout-only. Ignore output-file flags deliberately.
    } else if (token && !token.startsWith('-')) {
      parsed.fixturePath = token;
    }
  }

  return parsed;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const fixturePath = path.resolve(args.fixturePath);
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const report = validateMiraCoreEvalFixture(fixture);
  process.stdout.write(`${JSON.stringify(report, null, args.pretty ? 2 : 0)}\n`);
  return report;
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
};
