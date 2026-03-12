#!/usr/bin/env node

const { CognitiveMemoryApi } = require('../modules/cognitive-memory-api');

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
    '  node scripts/hm-memory-api.js retrieve <query> [--agent <id>] [--limit <n>] [--lease-ms <ms>]',
    '  node scripts/hm-memory-api.js patch --lease <lease-id> --content <text> [--agent <id>] [--reason <text>]',
    '  node scripts/hm-memory-api.js salience --node <node-id> [--delta <n>] [--decay <n>] [--max-depth <n>]',
    '',
  ].join('\n'));
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional[0] || 'retrieve';
  const api = new CognitiveMemoryApi();
  try {
    if (command === 'retrieve') {
      const query = positional.slice(1).join(' ').trim();
      if (!query) throw new Error('retrieve requires a query');
      const result = await api.retrieve(query, {
        agentId: flags.agent || flags['agent-id'] || 'cli',
        limit: flags.limit,
        leaseMs: flags['lease-ms'],
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }

    if (command === 'patch') {
      if (!flags.lease || !flags.content) {
        throw new Error('patch requires --lease and --content');
      }
      const result = await api.patch(flags.lease, flags.content, {
        agentId: flags.agent || flags['agent-id'] || 'cli',
        reason: flags.reason || null,
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }

    if (command === 'salience') {
      if (!flags.node) {
        throw new Error('salience requires --node');
      }
      const result = api.applySalienceField({
        nodeId: flags.node,
        delta: flags.delta,
        decay: flags.decay,
        maxDepth: flags['max-depth'],
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }

    usage();
    throw new Error(`Unknown command: ${command}`);
  } finally {
    api.close();
  }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
}
