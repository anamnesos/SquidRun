#!/usr/bin/env node

const {
  appendBulletToSection,
  resolvePromotionTarget,
} = require('../modules/memory-ingest/promotion');
const { executeOperation, closeRuntime } = require('../modules/team-memory/worker-client');

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
    '  node scripts/hm-memory-promote.js list [--status <status>] [--limit <n>] [--db-path <path>]',
    '  node scripts/hm-memory-promote.js approve --ids <id1,id2> | --all [--reviewer <name>] [--workspace-root <path>]',
    '  node scripts/hm-memory-promote.js reject --ids <id1,id2> | --all [--reviewer <name>]',
    '',
  ].join('\n'));
}

function parseIds(raw) {
  if (!raw) return [];
  return Array.from(new Set(String(raw)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)));
}

function buildRuntimeOptions(flags = {}) {
  if (!flags['db-path']) return {};
  return {
    runtimeOptions: {
      storeOptions: {
        dbPath: flags['db-path'],
      },
    },
  };
}

async function listCandidates(flags) {
  const result = await executeOperation('list-memory-promotions', {
    status: flags.status || 'pending',
    limit: flags.limit ? Number(flags.limit) : undefined,
  }, buildRuntimeOptions(flags));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result?.ok ? 0 : 1;
}

async function reviewCandidates(command, flags) {
  const runtimeOptions = buildRuntimeOptions(flags);
  const reviewer = flags.reviewer || 'architect';
  let candidates = [];

  if (flags.all) {
    const listed = await executeOperation('list-memory-promotions', {
      status: 'pending',
      limit: 1000,
    }, runtimeOptions);
    if (!listed?.ok) {
      process.stdout.write(`${JSON.stringify(listed, null, 2)}\n`);
      return listed?.ok ? 0 : 1;
    }
    candidates = (listed.candidates || []).map((entry) => entry.candidate_id);
  } else {
    candidates = parseIds(flags.ids);
  }

  if (!candidates.length) {
    process.stdout.write(`${JSON.stringify({ ok: true, command, updated: 0, results: [] }, null, 2)}\n`);
    return 0;
  }

  const action = command === 'approve' ? 'approve-memory-promotion' : 'reject-memory-promotion';
  const results = [];
  for (const candidateId of candidates) {
    results.push(await executeOperation(action, {
      candidate_id: candidateId,
      reviewer,
      review_notes: flags.note || null,
      project_root: flags['workspace-root'] || null,
    }, runtimeOptions));
  }

  process.stdout.write(`${JSON.stringify({
    ok: results.every((entry) => entry?.ok),
    command,
    updated: results.filter((entry) => entry?.ok).length,
    results,
  }, null, 2)}\n`);
  return results.every((entry) => entry?.ok) ? 0 : 1;
}

async function main(argv = process.argv.slice(2)) {
  const { positional, flags } = parseArgs(argv);
  const command = positional[0] || 'list';
  if (flags.help) {
    printUsage();
    return 0;
  }

  try {
    if (command === 'list') return listCandidates(flags);
    if (command === 'approve' || command === 'reject') return reviewCandidates(command, flags);
    printUsage();
    throw new Error(`Unknown command: ${command}`);
  } finally {
    await closeRuntime({ killTimeoutMs: 250 }).catch(() => {});
  }
}

if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = Number.isInteger(code) ? code : 0;
    })
    .catch((err) => {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    });
}

module.exports = {
  appendBulletToSection,
  main,
  parseArgs,
  parseIds,
  resolvePromotionTarget,
};
