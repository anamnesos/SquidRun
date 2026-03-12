#!/usr/bin/env node

const path = require('path');
const { MemorySearchIndex } = require('../modules/memory-search');

function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const positional = [];
  const flags = {};

  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i] || '');
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = args[i + 1];
    if (next && !String(next).startsWith('--')) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }

  return { positional, flags };
}

function printUsage() {
  process.stdout.write([
    'Usage:',
    '  node scripts/hm-memory-index.js [--force] [--json] [--db-path <path>] [--workspace-dir <path>]',
    '',
  ].join('\n'));
}

async function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  if (flags.help) {
    printUsage();
    return;
  }

  const index = new MemorySearchIndex({
    dbPath: flags['db-path'] ? path.resolve(String(flags['db-path'])) : undefined,
    workspaceDir: flags['workspace-dir'] ? path.resolve(String(flags['workspace-dir'])) : undefined,
  });

  try {
    const result = await index.indexAll({ force: flags.force === true });
    if (flags.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }

    process.stdout.write([
      'Memory index updated.',
      `db: ${result.dbPath}`,
      `source_groups: ${result.sourceGroups}`,
      `indexed_groups: ${result.indexedGroups}`,
      `skipped_groups: ${result.skippedGroups}`,
      `removed_groups: ${result.removedGroups}`,
      `indexed_chunks: ${result.indexedChunks}`,
      `documents: ${result.status.document_count}`,
    ].join('\n') + '\n');
  } finally {
    index.close();
  }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`${err.stack || err.message}\n`);
    process.exit(1);
  });
}
