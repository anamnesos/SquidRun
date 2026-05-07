#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const {
  buildMiraCoreDurableStateSeedV0,
} = require('../modules/mira-core/durable-state-seed-v0');

function defaultFixturePath(name) {
  return path.resolve(__dirname, '..', '__tests__', 'fixtures', name);
}

function parseArgs(argv = []) {
  const parsed = {
    fixturePath: defaultFixturePath('mira-core-durable-state-seed-v0-contract.json'),
    relationshipFixturePath: defaultFixturePath('mira-core-relationship-presence-v1-contract.json'),
    growthFixturePath: defaultFixturePath('mira-core-growth-loop-v0-contract.json'),
    identityFixturePath: defaultFixturePath('mira-core-identity-anchor-v0-contract.json'),
    pretty: false,
    projectRoot: process.cwd(),
    apply: false,
    inputSignals: {},
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '');
    if (token === '--pretty') {
      parsed.pretty = true;
    } else if (token === '--apply') {
      parsed.apply = true;
    } else if (token === '--fixture') {
      parsed.fixturePath = argv[index + 1] || parsed.fixturePath;
      index += 1;
    } else if (token.startsWith('--fixture=')) {
      parsed.fixturePath = token.slice('--fixture='.length);
    } else if (token === '--relationship-fixture') {
      parsed.relationshipFixturePath = argv[index + 1] || parsed.relationshipFixturePath;
      index += 1;
    } else if (token.startsWith('--relationship-fixture=')) {
      parsed.relationshipFixturePath = token.slice('--relationship-fixture='.length);
    } else if (token === '--growth-fixture') {
      parsed.growthFixturePath = argv[index + 1] || parsed.growthFixturePath;
      index += 1;
    } else if (token.startsWith('--growth-fixture=')) {
      parsed.growthFixturePath = token.slice('--growth-fixture='.length);
    } else if (token === '--identity-fixture') {
      parsed.identityFixturePath = argv[index + 1] || parsed.identityFixturePath;
      index += 1;
    } else if (token.startsWith('--identity-fixture=')) {
      parsed.identityFixturePath = token.slice('--identity-fixture='.length);
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
    } else if (token === '--out') {
      index += 1;
    } else if (token.startsWith('--out=')) {
      // Durable State Seed v0 emits proof to stdout; --out remains inert.
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

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
}

function main(argv = process.argv.slice(2), stdinText = null) {
  const args = parseArgs(argv);
  const inputText = stdinText === null ? readStdin() : String(stdinText || '');
  const stdinSignals = inputText.trim() ? JSON.parse(inputText) : {};
  const output = buildMiraCoreDurableStateSeedV0({
    contract: readJson(args.fixturePath),
    relationshipContract: readJson(args.relationshipFixturePath),
    growthContract: readJson(args.growthFixturePath),
    identityContract: readJson(args.identityFixturePath),
    projectRoot: args.projectRoot,
    apply: args.apply,
    inputSignals: mergeDeep(stdinSignals.inputSignals || stdinSignals, args.inputSignals),
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
