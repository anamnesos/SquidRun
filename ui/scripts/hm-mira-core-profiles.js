#!/usr/bin/env node
'use strict';

const { buildMiraCoreProfiles } = require('../modules/mira-core/profiles');

function parseArgs(argv = []) {
  const parsed = {
    projectRoot: null,
    profileName: null,
    pretty: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '');
    if (token === '--pretty') {
      parsed.pretty = true;
    } else if (token === '--out') {
      index += 1;
    } else if (token.startsWith('--out=')) {
      // Profiles v0 is stdout-only; ignore output-file flags deliberately.
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
    } else if (!parsed.projectRoot && token && !token.startsWith('-')) {
      parsed.projectRoot = token;
    }
  }

  return parsed;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const profiles = buildMiraCoreProfiles({
    projectRoot: args.projectRoot || process.cwd(),
    profileName: args.profileName || process.env.SQUIDRUN_PROFILE || 'main',
  });
  process.stdout.write(`${JSON.stringify(profiles, null, args.pretty ? 2 : 0)}\n`);
  return profiles;
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
