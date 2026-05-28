#!/usr/bin/env node
'use strict';

const {
  materializeTrustQuoteWorkRoomPrerequisites,
} = require('../modules/trustquote-work-room-prerequisites');

function parseArgs(argv = []) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '');
    if (token === '--write') {
      options.write = true;
      continue;
    }
    if (token === '--json') {
      options.json = true;
      continue;
    }
    if (token === '--session' || token === '--main-session') {
      options.mainSessionScopeId = String(argv[index + 1] || '');
      index += 1;
      continue;
    }
    if (token.startsWith('--session=')) {
      options.mainSessionScopeId = token.slice('--session='.length);
      continue;
    }
    if (token === '--project-path') {
      options.projectPath = String(argv[index + 1] || '');
      index += 1;
      continue;
    }
    if (token.startsWith('--project-path=')) {
      options.projectPath = token.slice('--project-path='.length);
      continue;
    }
    if (token === '--squidrun-root') {
      options.squidrunRoot = String(argv[index + 1] || '');
      index += 1;
      continue;
    }
    if (token.startsWith('--squidrun-root=')) {
      options.squidrunRoot = token.slice('--squidrun-root='.length);
    }
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = materializeTrustQuoteWorkRoomPrerequisites(options);
  const summary = {
    ok: result.ok,
    write: result.write,
    roomId: result.artifacts.roomId,
    sessionScopeId: result.artifacts.sessionScopeId,
    projectPath: result.artifacts.projectPath,
    results: result.results,
  };
  console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err?.stack || err?.message || String(err));
    process.exitCode = 1;
  }
}

module.exports = {
  parseArgs,
};
