#!/usr/bin/env node
'use strict';

const { buildStartupTranscriptContext } = require('../modules/startup-transcript-context');

function parseArgs(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2).trim();
    const next = argv[index + 1];
    const value = (!next || next.startsWith('--')) ? true : next;
    if (value !== true) index += 1;
    options.set(key, value);
  }
  return options;
}

function getOption(options, key, fallback = null) {
  return options.has(key) ? options.get(key) : fallback;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const result = buildStartupTranscriptContext({
    projectRoot: getOption(options, 'project-root', null),
    projectsDir: getOption(options, 'projects-dir', null),
    indexPath: getOption(options, 'index-path', null),
    metaPath: getOption(options, 'meta-path', null),
    evidenceLedgerDbPath: getOption(options, 'evidence-ledger-db-path', null),
    windowKey: getOption(options, 'window-key', null),
    recentCommsLimit: getOption(options, 'recent-comms-limit', null),
    maxResults: getOption(options, 'max-results', null),
    maxQueries: getOption(options, 'max-queries', null),
  });

  if (getOption(options, 'json', false) === true) {
    process.stdout.write(JSON.stringify(result, null, 2));
    return 0;
  }

  process.stdout.write(result.context || '');
  return 0;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  main,
};
