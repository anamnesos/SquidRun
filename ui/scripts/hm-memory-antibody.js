#!/usr/bin/env node

const { CognitiveMemoryApi } = require('../modules/cognitive-memory-api');

function usage() {
  process.stdout.write([
    'Usage:',
    '  node ui/scripts/hm-memory-antibody.js migrate',
    '  node ui/scripts/hm-memory-antibody.js run-once [--limit <n>]',
    '  node ui/scripts/hm-memory-antibody.js adjudicate --node <id> --decision <accepted_correction|rejected_hallucination|coexistence> [--conflicting-node <id>] [--actor <id>] [--reason <text>]',
    '',
  ].join('\n'));
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] || '');
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !String(next).startsWith('--')) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return { positional, flags };
}

async function main(argv = process.argv.slice(2)) {
  const { positional, flags } = parseArgs(argv);
  const command = positional[0] || 'run-once';
  const api = new CognitiveMemoryApi();
  try {
    if (command === 'migrate') {
      api.init();
      const db = api.init();
      const summary = db.prepare(`
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN COALESCE(NULLIF(TRIM(antibody_status), ''), 'clear') = 'clear' THEN 1 ELSE 0 END) AS clear_count
        FROM nodes
      `).get();
      process.stdout.write(`${JSON.stringify({
        ok: true,
        totalNodes: Number(summary?.total || 0),
        clearNodes: Number(summary?.clear_count || 0),
      }, null, 2)}\n`);
      return;
    }

    if (command === 'run-once') {
      const result = await api.antibodyWorker.runOnce({
        limit: flags.limit,
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }

    if (command === 'adjudicate') {
      const result = api.adjudicateAntibodyConflict({
        nodeId: flags.node,
        conflictingNodeId: flags['conflicting-node'] || null,
        decision: flags.decision,
        actorId: flags.actor || 'architect',
        reason: flags.reason || null,
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }

    usage();
    process.exitCode = 1;
  } finally {
    api.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  main,
  parseArgs,
};
