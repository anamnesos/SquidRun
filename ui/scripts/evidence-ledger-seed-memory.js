#!/usr/bin/env node
/**
 * Seed decision memory from context snapshot markdown or JSON.
 * Idempotent via deterministic IDs + conflict-tolerant inserts.
 */

const fs = require('fs');
const path = require('path');
const { WORKSPACE_PATH, resolveCoordPath } = require('../config');
const { EvidenceLedgerStore } = require('../modules/main/evidence-ledger-store');
const { EvidenceLedgerMemory } = require('../modules/main/evidence-ledger-memory');
const { seedDecisionMemory } = require('../modules/main/evidence-ledger-memory-seed');

function usage() {
  console.log('Usage: node evidence-ledger-seed-memory.js [options]');
  console.log('Options:');
  console.log('  --context <path>            Input context file (JSON or markdown; default: .squidrun/context-snapshots/1.md)');
  console.log('  --handoff <path>            Deprecated alias for --context');
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

function parseList(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseSnapshotMarkdown(raw) {
  const text = String(raw || '');
  const sessionMatch = text.match(/(?:Session:\s*|\|\s*Session\s+)(\d+)/i);
  const testsMatch = text.match(/Tests:\s*(\d+)\s+suites,\s*(\d+)\s+tests/i);
  const completedMatch = text.match(/^Completed:\s*(.+)$/im);
  const nextMatch = text.match(/^Next:\s*(.+)$/im);
  const session = sessionMatch ? Number.parseInt(sessionMatch[1], 10) : null;

  if (!Number.isInteger(session) || session <= 0) {
    throw new Error('snapshot markdown missing Session number');
  }

  return {
    session,
    mode: 'PTY',
    completed: completedMatch ? parseList(completedMatch[1]) : [],
    roadmap: nextMatch ? parseList(nextMatch[1]) : [],
    not_yet_done: nextMatch ? parseList(nextMatch[1]) : [],
    stats: testsMatch
      ? {
          test_suites: Number.parseInt(testsMatch[1], 10) || 0,
          tests_passed: Number.parseInt(testsMatch[2], 10) || 0,
        }
      : {},
  };
}

function readContextFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const trimmed = content.trim();
  if (trimmed.startsWith('{')) {
    return JSON.parse(trimmed);
  }
  return parseSnapshotMarkdown(trimmed);
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
  const defaultContextPath = typeof resolveCoordPath === 'function'
    ? resolveCoordPath(path.join('context-snapshots', '1.md'))
    : path.join(WORKSPACE_PATH, 'context-snapshots', '1.md');
  const contextPath = resolvePath(
    options.get('context') || options.get('handoff'),
    defaultContextPath
  );
  const dbPath = asString(options.get('db'), '');

  let contextSnapshot;
  try {
    contextSnapshot = readContextFile(contextPath);
  } catch (err) {
    console.error(`Failed to read context file at ${contextPath}: ${err.message}`);
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

  const result = seedDecisionMemory(memory, contextSnapshot, {
    sessionId: asString(options.get('session-id'), ''),
    markSessionEnded: options.get('mark-ended') === true,
    summary: asString(options.get('summary'), ''),
  });

  store.close();
  console.log(JSON.stringify({
    contextPath,
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
