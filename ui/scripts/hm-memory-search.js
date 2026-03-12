#!/usr/bin/env node

const path = require('path');
const { MemorySearchIndex } = require('../modules/memory-search');
const { CognitiveMemoryStore } = require('../modules/cognitive-memory-store');

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
    '  node scripts/hm-memory-search.js <query> [--limit <n>] [--json] [--db-path <path>] [--workspace-dir <path>]',
    '',
  ].join('\n'));
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  // First positional arg may be the subcommand 'search' — strip it so it
  // does not pollute the query (e.g. 'search' matching 'research').
  const queryArgs = positional.length > 0 && positional[0] === 'search'
    ? positional.slice(1)
    : positional;
  const query = queryArgs.join(' ').trim();
  if (!query || flags.help) {
    printUsage();
    process.exit(query ? 0 : 1);
  }

  const index = new MemorySearchIndex({
    dbPath: flags['db-path'] ? path.resolve(String(flags['db-path'])) : undefined,
    workspaceDir: flags['workspace-dir'] ? path.resolve(String(flags['workspace-dir'])) : undefined,
  });

  try {
    const result = await index.search(query, { limit: flags.limit });
    if (result.ok && result.results && result.results.length > 0 && flags.agent && flags.domain) {
      const store = new CognitiveMemoryStore();
      try {
        store.recordTransactiveUse({
          domain: flags.domain,
          agent_id: flags.agent,
          pane_id: flags['pane-id'] || null,
          expertise_delta: flags['expertise-delta'] || 0.1,
        });
      } finally {
        store.close();
      }
    }
    if (flags.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }

    process.stdout.write(`Query: ${query}\n`);
    if (!result.results || result.results.length === 0) {
      process.stdout.write('No results.\n');
      return;
    }

    result.results.forEach((entry, indexNumber) => {
      process.stdout.write([
        `${indexNumber + 1}. [${entry.sourceType}] ${entry.title || entry.sourcePath}`,
        `   heading: ${entry.heading || '-'}`,
        `   path: ${entry.sourcePath || '-'}`,
        `   score: ${entry.score}`,
        `   excerpt: ${entry.excerpt}`,
      ].join('\n') + '\n');
    });
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
