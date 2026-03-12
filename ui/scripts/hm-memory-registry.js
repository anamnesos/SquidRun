#!/usr/bin/env node

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
    '  node scripts/hm-memory-registry.js list [--limit <n>]',
    '  node scripts/hm-memory-registry.js record --domain <domain> --agent <agent> [--pane-id <id>] [--expertise-delta <n>]',
    '',
  ].join('\n'));
}

function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional[0] || 'list';
  const store = new CognitiveMemoryStore();
  try {
    if (command === 'list') {
      process.stdout.write(`${JSON.stringify(store.listTransactiveMeta({ limit: flags.limit }), null, 2)}\n`);
      return;
    }

    if (command === 'record') {
      if (!flags.domain || !flags.agent) {
        throw new Error('record requires --domain and --agent');
      }
      const result = store.recordTransactiveUse({
        domain: flags.domain,
        agent_id: flags.agent,
        pane_id: flags['pane-id'] || null,
        expertise_delta: flags['expertise-delta'] || 0.1,
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }

    throw new Error(`Unknown command: ${command}`);
  } finally {
    store.close();
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}
