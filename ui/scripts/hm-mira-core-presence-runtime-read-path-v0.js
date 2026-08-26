#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const {
  buildMiraCorePresenceRuntimeReadPathV0,
} = require('../modules/mira-core/presence-runtime-read-path-v0');

function parseArgs(argv = []) {
  const parsed = {
    fixturePath: path.resolve(
      __dirname,
      '..',
      '__tests__',
      'fixtures',
      'mira-core-presence-runtime-read-path-v0-contract.json',
    ),
    pretty: false,
    projectRoot: process.cwd(),
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
    } else if (token === '--profile') {
      parsed.inputSignals.profileName = argv[index + 1] || null;
      index += 1;
    } else if (token.startsWith('--profile=')) {
      parsed.inputSignals.profileName = token.slice('--profile='.length);
    } else if (token === '--window-key') {
      parsed.inputSignals.windowKey = argv[index + 1] || null;
      index += 1;
    } else if (token.startsWith('--window-key=')) {
      parsed.inputSignals.windowKey = token.slice('--window-key='.length);
    } else if (token === '--session') {
      parsed.inputSignals.sessionId = argv[index + 1] || null;
      index += 1;
    } else if (token.startsWith('--session=')) {
      parsed.inputSignals.sessionId = token.slice('--session='.length);
    } else if (token === '--device') {
      parsed.inputSignals.deviceId = argv[index + 1] || null;
      index += 1;
    } else if (token.startsWith('--device=')) {
      parsed.inputSignals.deviceId = token.slice('--device='.length);
    } else if (token === '--now') {
      parsed.inputSignals.now = argv[index + 1] || null;
      index += 1;
    } else if (token.startsWith('--now=')) {
      parsed.inputSignals.now = token.slice('--now='.length);
    } else if (token === '--apply') {
      parsed.inputSignals.applyRequested = true;
    } else if (token === '--out') {
      parsed.inputSignals.outFlagIgnored = true;
      index += 1;
    } else if (token.startsWith('--out=')) {
      parsed.inputSignals.outFlagIgnored = true;
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
  const output = buildMiraCorePresenceRuntimeReadPathV0({
    contract,
    contracts: contract.gateContracts || {},
    projectRoot: args.projectRoot,
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
