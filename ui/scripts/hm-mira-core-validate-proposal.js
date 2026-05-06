#!/usr/bin/env node
'use strict';

const fs = require('fs');

const { validateMiraCoreProposal } = require('../modules/mira-core/proposal-validator');

function parseArgs(argv = []) {
  const parsed = {
    profileName: null,
    pretty: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '');
    if (token === '--pretty') {
      parsed.pretty = true;
    } else if (token === '--profile') {
      parsed.profileName = argv[index + 1] || null;
      index += 1;
    } else if (token.startsWith('--profile=')) {
      parsed.profileName = token.slice('--profile='.length);
    } else if (token === '--out') {
      index += 1;
    } else if (token.startsWith('--out=')) {
      // Validator v0 is stdout-only. Ignore output-file flags deliberately.
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
  const proposal = inputText.trim() ? JSON.parse(inputText) : {};
  const validation = validateMiraCoreProposal(proposal, {
    profileName: args.profileName || process.env.SQUIDRUN_PROFILE || 'main',
  });
  process.stdout.write(`${JSON.stringify(validation, null, args.pretty ? 2 : 0)}\n`);
  return validation;
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
