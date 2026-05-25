#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const {
  buildMiraProgressReport,
  formatMiraProgressPlain,
} = require('../modules/mira-core/mira-progress-v0');

function parseArgs(argv = []) {
  const parsed = {
    projectRoot: null,
    contractPath: null,
    json: false,
    pretty: false,
    plain: false,
    proofFile: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '');
    if (token === '--json') {
      parsed.json = true;
    } else if (token === '--pretty') {
      parsed.pretty = true;
      parsed.json = true;
    } else if (token === '--plain') {
      parsed.plain = true;
    } else if (token === '--project-root' || token === '--project') {
      parsed.projectRoot = argv[index + 1] || null;
      index += 1;
    } else if (token.startsWith('--project-root=')) {
      parsed.projectRoot = token.slice('--project-root='.length);
    } else if (token.startsWith('--project=')) {
      parsed.projectRoot = token.slice('--project='.length);
    } else if (token === '--contract') {
      parsed.contractPath = argv[index + 1] || null;
      index += 1;
    } else if (token.startsWith('--contract=')) {
      parsed.contractPath = token.slice('--contract='.length);
    } else if (token === '--proof-file') {
      parsed.proofFile = argv[index + 1] || null;
      index += 1;
    } else if (token.startsWith('--proof-file=')) {
      parsed.proofFile = token.slice('--proof-file='.length);
    } else if (!parsed.projectRoot && token && !token.startsWith('-')) {
      parsed.projectRoot = token;
    }
  }

  if (!parsed.json && !parsed.plain) parsed.json = true;
  return parsed;
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function readInputSignals(args, stdinText = null) {
  if (args.proofFile) {
    return JSON.parse(fs.readFileSync(path.resolve(args.proofFile), 'utf8'));
  }
  const inputText = stdinText === null ? readStdin() : String(stdinText || '');
  return inputText.trim() ? JSON.parse(inputText) : {};
}

function main(argv = process.argv.slice(2), stdinText = null) {
  const args = parseArgs(argv);
  const inputSignals = readInputSignals(args, stdinText);
  const report = buildMiraProgressReport({
    projectRoot: args.projectRoot || process.cwd(),
    contractPath: args.contractPath || undefined,
    inputSignals,
  });
  const output = args.plain && !args.json
    ? formatMiraProgressPlain(report)
    : JSON.stringify(report, null, args.pretty ? 2 : 0);
  process.stdout.write(`${output}\n`);
  return report;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`hm-mira-progress: ${err.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  main,
  parseArgs,
  readInputSignals,
  readStdin,
};
