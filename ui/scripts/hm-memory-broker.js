#!/usr/bin/env node

const {
  createDefaultMemoryBroker,
  formatRecallForPaneMessage,
} = require('../modules/memory-broker');

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

function usage() {
  process.stdout.write([
    'Usage:',
    '  node ui/scripts/hm-memory-broker.js recall <query> [--limit <n>] [--provider-limit <n>] [--timeout-ms <n>] [--include-knowledge-search] [--json]',
    '',
  ].join('\n'));
}

async function main(argv = process.argv.slice(2)) {
  const { positional, flags } = parseArgs(argv);
  const command = positional[0] || 'recall';
  if (command !== 'recall') {
    usage();
    throw new Error(`Unknown command: ${command}`);
  }
  const query = positional.slice(1).join(' ').trim() || String(flags.query || flags.q || '').trim();
  if (!query) {
    usage();
    throw new Error('recall requires a query');
  }
  if (flags.json) {
    try { require('../modules/logger').setLevel('error'); } catch {}
    try {
      process.removeAllListeners('warning');
      process.on('warning', () => {});
    } catch {}
  }

  const broker = createDefaultMemoryBroker({
    enableKnowledgeSearch: flags['include-knowledge-search'] === true,
    providerTimeoutMs: flags['timeout-ms'],
  });
  try {
    const result = await broker.recall(query, {
      role: flags.agent || flags.role || 'cli',
      channel: 'cli',
    }, {
      limit: flags.limit,
      providerLimit: flags['provider-limit'],
      timeoutMs: flags['timeout-ms'],
    });

    if (flags.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }

    const block = formatRecallForPaneMessage(result, { limit: flags.limit });
    process.stdout.write(`${block || '(no recall results)'}\n`);
  } finally {
    try { require('../modules/team-memory').closeTeamMemoryRuntime?.(); } catch {}
    try { require('../modules/ipc/evidence-ledger-handlers').closeSharedRuntime?.(); } catch {}
    try { require('../modules/ipc/cognitive-memory-handlers').closeSharedCognitiveMemoryRuntime?.(); } catch {}
  }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  main,
  parseArgs,
};
