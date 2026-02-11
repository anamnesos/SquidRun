#!/usr/bin/env node
/**
 * Seed decision memory from workspace/session-handoff.json.
 * Idempotent via deterministic IDs + conflict-tolerant inserts.
 */

const fs = require('fs');
const path = require('path');
const { WORKSPACE_PATH } = require('../config');
const { EvidenceLedgerStore } = require('../modules/main/evidence-ledger-store');
const { EvidenceLedgerMemory } = require('../modules/main/evidence-ledger-memory');
const { seedDecisionMemory } = require('../modules/main/evidence-ledger-memory-seed');

function usage() {
  console.log('Usage: node evidence-ledger-seed-memory.js [options]');
  console.log('Options:');
  console.log('  --handoff <path>            Input handoff JSON (default: workspace/session-handoff.json)');
  console.log('  --db <path>                 Ledger DB path override');
  console.log('  --session-id <id>           Override deterministic seeded session id');
  console.log('  --mark-ended                Mark seeded session as ended');
  console.log('  --summary <text>            Session-end summary when --mark-ended is used');
}

function parseArgs(argv) {
  const options = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2).trim();
    const next = argv[i + 1];
    const value = (!next || next.startsWith('--')) ? true : next;
    if (value !== true) i += 1;
    options.set(key, value);
  }
  return options;
}

function asString(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function readJson(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(content);
}

function resolvePath(input, fallback) {
  const raw = asString(input, fallback);
  if (path.isAbsolute(raw)) return raw;
  return path.resolve(raw);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    usage();
    process.exit(0);
  }

  const options = parseArgs(args);
  const handoffPath = resolvePath(
    options.get('handoff'),
    path.join(WORKSPACE_PATH, 'session-handoff.json')
  );
  const dbPath = asString(options.get('db'), '');

  let handoff;
  try {
    handoff = readJson(handoffPath);
  } catch (err) {
    console.error(`Failed to read handoff JSON at ${handoffPath}: ${err.message}`);
    process.exit(1);
  }

  const store = new EvidenceLedgerStore({
    ...(dbPath ? { dbPath: resolvePath(dbPath, dbPath) } : {}),
  });

  const init = store.init();
  if (!init.ok) {
    console.error(`Failed to initialize evidence ledger store: ${init.reason || 'unknown'}`);
    process.exit(1);
  }

  const memory = new EvidenceLedgerMemory(store);

  const result = seedDecisionMemory(memory, handoff, {
    sessionId: asString(options.get('session-id'), ''),
    markSessionEnded: options.get('mark-ended') === true,
    summary: asString(options.get('summary'), ''),
  });

  store.close();
  console.log(JSON.stringify({
    handoffPath,
    dbPath: init.dbPath,
    ...result,
  }, null, 2));

  if (!result.ok || result.failed > 0) {
    process.exit(1);
  }
}

try {
  main();
} catch (err) {
  console.error(`Seed failed: ${err.message}`);
  process.exit(1);
}
