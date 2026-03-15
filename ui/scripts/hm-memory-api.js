#!/usr/bin/env node

const {
  CognitiveMemoryApi,
  DEFAULT_INGEST_CONFIDENCE,
} = require('../modules/cognitive-memory-api');

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
    '  node scripts/hm-memory-api.js ingest <content> --category <name> --agent <id> [--confidence <0..1>]',
    '  node scripts/hm-memory-api.js retrieve <query> [--agent <id>] [--limit <n>] [--lease-ms <ms>]',
    '  node scripts/hm-memory-api.js patch --lease <lease-id> --content <text> [--agent <id>] [--reason <text>]',
    '  node scripts/hm-memory-api.js salience --node <node-id> [--delta <n>] [--decay <n>] [--max-depth <n>]',
    '',
  ].join('\n'));
}

function clampConfidence(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_INGEST_CONFIDENCE;
  return Math.max(0, Math.min(1, numeric));
}

async function main(argv = process.argv.slice(2)) {
  const { positional, flags } = parseArgs(argv);
  const command = positional[0] || 'retrieve';
  const api = new CognitiveMemoryApi();
  try {
    if (command === 'ingest') {
      const content = positional.slice(1).join(' ').trim();
      const agentId = flags.agent || flags['agent-id'];
      const category = String(flags.category || '').trim();
      const confidence = clampConfidence(flags.confidence);
      if (!content) throw new Error('ingest requires content');
      if (!category) throw new Error('ingest requires --category');
      if (!agentId) throw new Error('ingest requires --agent');

      const result = await api.ingest({
        category,
        content,
        confidence,
        sourceType: 'agent-ingest',
        sourcePath: `agent:${agentId}`,
        title: `Agent ingest (${agentId})`,
        heading: category,
        metadata: {
          agentId,
          command: 'ingest',
          ingestedVia: 'hm-memory-api',
          confidence,
        },
      });
      if (!result?.ok || !result?.node) {
        throw new Error('ingest did not create a node');
      }
      process.stdout.write(`${JSON.stringify({
        ok: true,
        node: {
          ...result.node,
          confidenceScore: confidence,
        },
      }, null, 2)}\n`);
      return;
    }

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

module.exports = {
  DEFAULT_INGEST_CONFIDENCE,
  clampConfidence,
  main,
  parseArgs,
};
