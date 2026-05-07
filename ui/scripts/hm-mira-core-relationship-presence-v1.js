#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const {
  buildMiraCoreRelationshipPresenceV1,
  readRelationshipPresenceV1LocalSources,
} = require('../modules/mira-core/relationship-presence-v1');

function parseArgs(argv = []) {
  const parsed = {
    fixturePath: path.resolve(
      __dirname,
      '..',
      '__tests__',
      'fixtures',
      'mira-core-relationship-presence-v1-contract.json',
    ),
    pretty: false,
    projectRoot: process.cwd(),
    readLocal: true,
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
    } else if (token === '--self-name') {
      parsed.inputSignals.self_profile = {
        ...(parsed.inputSignals.self_profile || {}),
        name: argv[index + 1] || null,
      };
      index += 1;
    } else if (token.startsWith('--self-name=')) {
      parsed.inputSignals.self_profile = {
        ...(parsed.inputSignals.self_profile || {}),
        name: token.slice('--self-name='.length),
      };
    } else if (token === '--james-state') {
      parsed.inputSignals.james_relationship_state = {
        ...(parsed.inputSignals.james_relationship_state || {}),
        current_focus: argv[index + 1] || null,
      };
      index += 1;
    } else if (token.startsWith('--james-state=')) {
      parsed.inputSignals.james_relationship_state = {
        ...(parsed.inputSignals.james_relationship_state || {}),
        current_focus: token.slice('--james-state='.length),
      };
    } else if (token === '--memory-summary') {
      parsed.inputSignals.prior_context_memory = {
        ...(parsed.inputSignals.prior_context_memory || {}),
        summary: argv[index + 1] || null,
      };
      index += 1;
    } else if (token.startsWith('--memory-summary=')) {
      parsed.inputSignals.prior_context_memory = {
        ...(parsed.inputSignals.prior_context_memory || {}),
        summary: token.slice('--memory-summary='.length),
      };
    } else if (token === '--project-root') {
      parsed.projectRoot = argv[index + 1] || parsed.projectRoot;
      index += 1;
    } else if (token.startsWith('--project-root=')) {
      parsed.projectRoot = token.slice('--project-root='.length);
    } else if (token === '--no-read-local') {
      parsed.readLocal = false;
    } else if (token === '--out') {
      index += 1;
    } else if (token.startsWith('--out=')) {
      // Relationship Presence v1 is stdout-only. Output-file flags are deliberately ignored.
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
  const localSignals = args.readLocal
    ? readRelationshipPresenceV1LocalSources({ projectRoot: args.projectRoot })
    : {};
  const output = buildMiraCoreRelationshipPresenceV1({
    contract,
    inputSignals: mergeDeep(mergeDeep(localSignals, stdinSignals), args.inputSignals),
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
