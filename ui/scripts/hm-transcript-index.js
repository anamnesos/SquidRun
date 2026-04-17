#!/usr/bin/env node
'use strict';

const {
  resolveClaudeTranscriptProjectsDir,
  buildTranscriptIndex,
  searchTranscriptIndex,
  readTranscriptIndex,
} = require('../modules/transcript-index');

function usage() {
  console.log('Usage: node ui/scripts/hm-transcript-index.js <command> [options]');
  console.log('Commands:');
  console.log('  build [--projects-dir <path>] [--index-path <path>] [--meta-path <path>]');
  console.log('  stats [--index-path <path>] [--meta-path <path>]');
  console.log('  search --query <text> [--limit <n>] [--index-path <path>] [--meta-path <path>]');
}

function parseArgs(argv) {
  const positional = [];
  const options = new Map();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }

    const key = token.slice(2).trim();
    const next = argv[index + 1];
    const value = (!next || next.startsWith('--')) ? true : next;
    if (value !== true) index += 1;
    options.set(key, value);
  }

  return { positional, options };
}

function getOption(options, key, fallback = null) {
  return options.has(key) ? options.get(key) : fallback;
}

function main(argv = process.argv.slice(2)) {
  const { positional, options } = parseArgs(argv);
  const command = positional[0] || 'build';
  const sharedOptions = {
    projectsDir: getOption(options, 'projects-dir', null),
    indexPath: getOption(options, 'index-path', null),
    metaPath: getOption(options, 'meta-path', null),
  };

  if (command === 'help' || command === '--help' || command === '-h') {
    usage();
    return 0;
  }

  if (command === 'build') {
    const result = buildTranscriptIndex(sharedOptions);
    process.stdout.write(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }

  if (command === 'stats') {
    const { meta } = readTranscriptIndex(sharedOptions);
    const output = meta || {
      ok: false,
      reason: 'index_missing',
      transcriptDir: resolveClaudeTranscriptProjectsDir(sharedOptions),
    };
    process.stdout.write(JSON.stringify(output, null, 2));
    return meta ? 0 : 1;
  }

  if (command === 'search') {
    const query = getOption(options, 'query', positional.slice(1).join(' '));
    if (!query) {
      usage();
      return 1;
    }
    const result = searchTranscriptIndex(query, {
      ...sharedOptions,
      limit: getOption(options, 'limit', 10),
    });
    process.stdout.write(JSON.stringify(result, null, 2));
    return 0;
  }

  usage();
  return 1;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  main,
};
