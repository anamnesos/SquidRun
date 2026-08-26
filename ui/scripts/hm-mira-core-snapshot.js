#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const { buildMiraCoreSnapshot } = require('../modules/mira-core/snapshot');

function parseArgs(argv = []) {
  const parsed = {
    projectRoot: null,
    profileName: null,
    pretty: false,
    outPath: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '');
    if (token === '--pretty') {
      parsed.pretty = true;
    } else if (token === '--project-root') {
      parsed.projectRoot = argv[index + 1] || null;
      index += 1;
    } else if (token.startsWith('--project-root=')) {
      parsed.projectRoot = token.slice('--project-root='.length);
    } else if (token === '--profile') {
      parsed.profileName = argv[index + 1] || null;
      index += 1;
    } else if (token.startsWith('--profile=')) {
      parsed.profileName = token.slice('--profile='.length);
    } else if (token === '--out') {
      parsed.outPath = argv[index + 1] || null;
      index += 1;
    } else if (token.startsWith('--out=')) {
      parsed.outPath = token.slice('--out='.length);
    } else if (!parsed.projectRoot && token && !token.startsWith('-')) {
      parsed.projectRoot = token;
    }
  }

  return parsed;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const snapshot = buildMiraCoreSnapshot({
    projectRoot: args.projectRoot || process.cwd(),
    profileName: args.profileName || process.env.SQUIDRUN_PROFILE || 'main',
  });
  const json = JSON.stringify(snapshot, null, args.pretty ? 2 : 0);
  if (args.outPath) {
    const resolvedOut = path.resolve(args.outPath);
    fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
    fs.writeFileSync(resolvedOut, `${json}\n`);
  } else {
    process.stdout.write(`${json}\n`);
  }
  return snapshot;
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
