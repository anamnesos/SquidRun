#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const {
  buildMiraCoreGrowthLoopV0,
} = require('../modules/mira-core/growth-loop-v0');

function parseArgs(argv = []) {
  const parsed = {
    fixturePath: path.resolve(
      __dirname,
      '..',
      '__tests__',
      'fixtures',
      'mira-core-growth-loop-v0-contract.json',
    ),
    pretty: false,
    projectRoot: process.cwd(),
    apply: false,
    inputSignals: {},
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
    } else if (token === '--project-root') {
      parsed.projectRoot = argv[index + 1] || parsed.projectRoot;
      index += 1;
    } else if (token.startsWith('--project-root=')) {
      parsed.projectRoot = token.slice('--project-root='.length);
    } else if (token === '--apply') {
      parsed.apply = true;
    } else if (token === '--reflection-summary') {
      parsed.inputSignals.reflection = {
        ...(parsed.inputSignals.reflection || {}),
        summary: argv[index + 1] || null,
      };
      index += 1;
    } else if (token.startsWith('--reflection-summary=')) {
      parsed.inputSignals.reflection = {
        ...(parsed.inputSignals.reflection || {}),
        summary: token.slice('--reflection-summary='.length),
      };
    } else if (token === '--reason') {
      parsed.inputSignals.reflection = {
        ...(parsed.inputSignals.reflection || {}),
        reasons: [
          ...((parsed.inputSignals.reflection || {}).reasons || []),
          argv[index + 1] || '',
        ],
      };
      index += 1;
    } else if (token.startsWith('--reason=')) {
      parsed.inputSignals.reflection = {
        ...(parsed.inputSignals.reflection || {}),
        reasons: [
          ...((parsed.inputSignals.reflection || {}).reasons || []),
          token.slice('--reason='.length),
        ],
      };
    } else if (token === '--profile') {
      parsed.inputSignals.profileName = argv[index + 1] || null;
      index += 1;
    } else if (token.startsWith('--profile=')) {
      parsed.inputSignals.profileName = token.slice('--profile='.length);
    } else if (token === '--session') {
      parsed.inputSignals.sessionId = argv[index + 1] || null;
      index += 1;
    } else if (token.startsWith('--session=')) {
      parsed.inputSignals.sessionId = token.slice('--session='.length);
    } else if (token === '--out') {
      index += 1;
    } else if (token.startsWith('--out=')) {
      // Growth Loop v0 emits the proof to stdout. Output-file flags do not authorize arbitrary writes.
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

function mergeDeep(base = {}, override = {}) {
  const result = { ...base };
  for (const [key, value] of Object.entries(override || {})) {
    if (
      value
      && typeof value === 'object'
      && !Array.isArray(value)
      && base[key]
      && typeof base[key] === 'object'
      && !Array.isArray(base[key])
    ) {
      result[key] = mergeDeep(base[key], value);
    } else if (value !== undefined && value !== null) {
      result[key] = value;
    }
  }
  return result;
}

function main(argv = process.argv.slice(2), stdinText = null) {
  const args = parseArgs(argv);
  const inputText = stdinText === null ? readStdin() : String(stdinText || '');
  const stdinSignals = inputText.trim() ? JSON.parse(inputText) : {};
  const contract = JSON.parse(fs.readFileSync(path.resolve(args.fixturePath), 'utf8'));
  const output = buildMiraCoreGrowthLoopV0({
    contract,
    projectRoot: args.projectRoot,
    apply: args.apply,
    inputSignals: mergeDeep(stdinSignals, args.inputSignals),
  });
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
  mergeDeep,
  parseArgs,
  readStdin,
};
