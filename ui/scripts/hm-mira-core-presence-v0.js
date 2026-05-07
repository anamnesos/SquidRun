#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const { buildMiraCorePresenceV0 } = require('../modules/mira-core/presence-v0');

function parseArgs(argv = []) {
  const parsed = {
    fixturePath: path.resolve(__dirname, '..', '__tests__', 'fixtures', 'mira-core-presence-v0-contract.json'),
    pretty: false,
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
    } else if (token === '--profile') {
      parsed.inputSignals.profile = argv[index + 1] || parsed.inputSignals.profile;
      index += 1;
    } else if (token.startsWith('--profile=')) {
      parsed.inputSignals.profile = token.slice('--profile='.length);
    } else if (token === '--window-key') {
      parsed.inputSignals.windowKey = argv[index + 1] || parsed.inputSignals.windowKey;
      index += 1;
    } else if (token.startsWith('--window-key=')) {
      parsed.inputSignals.windowKey = token.slice('--window-key='.length);
    } else if (token === '--session') {
      parsed.inputSignals.sessionId = argv[index + 1] || parsed.inputSignals.sessionId;
      index += 1;
    } else if (token.startsWith('--session=')) {
      parsed.inputSignals.sessionId = token.slice('--session='.length);
    } else if (token === '--device') {
      parsed.inputSignals.deviceId = argv[index + 1] || parsed.inputSignals.deviceId;
      index += 1;
    } else if (token.startsWith('--device=')) {
      parsed.inputSignals.deviceId = token.slice('--device='.length);
    } else if (token === '--role') {
      parsed.inputSignals.role = argv[index + 1] || parsed.inputSignals.role;
      index += 1;
    } else if (token.startsWith('--role=')) {
      parsed.inputSignals.role = token.slice('--role='.length);
    } else if (token === '--pane') {
      parsed.inputSignals.paneId = argv[index + 1] || parsed.inputSignals.paneId;
      index += 1;
    } else if (token.startsWith('--pane=')) {
      parsed.inputSignals.paneId = token.slice('--pane='.length);
    } else if (token === '--project-root') {
      parsed.inputSignals.projectPath = argv[index + 1] || parsed.inputSignals.projectPath;
      index += 1;
    } else if (token.startsWith('--project-root=')) {
      parsed.inputSignals.projectPath = token.slice('--project-root='.length);
    } else if (token === '--out') {
      index += 1;
    } else if (token.startsWith('--out=')) {
      // Presence v0 is stdout-only. Output-file flags are deliberately ignored.
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

function mergeInputSignals(stdinSignals = {}, argSignals = {}) {
  const merged = {
    ...stdinSignals,
    ...argSignals,
  };
  if (stdinSignals.profile && typeof stdinSignals.profile === 'object') {
    merged.profile = {
      ...stdinSignals.profile,
      ...(typeof argSignals.profile === 'object' ? argSignals.profile : {}),
    };
    if (typeof argSignals.profile === 'string') {
      merged.profile.name = argSignals.profile;
    }
  }
  return merged;
}

function main(argv = process.argv.slice(2), stdinText = null) {
  const args = parseArgs(argv);
  const inputText = stdinText === null ? readStdin() : String(stdinText || '');
  const stdinSignals = inputText.trim() ? JSON.parse(inputText) : {};
  const contract = JSON.parse(fs.readFileSync(path.resolve(args.fixturePath), 'utf8'));
  const output = buildMiraCorePresenceV0({
    contract,
    inputSignals: mergeInputSignals(stdinSignals, args.inputSignals),
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
  mergeInputSignals,
  parseArgs,
  readStdin,
};
