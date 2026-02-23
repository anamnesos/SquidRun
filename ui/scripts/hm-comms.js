#!/usr/bin/env node
/**
 * hm-comms: Read comms history from Evidence Ledger (comms_journal) via node:sqlite.
 *
 * Commands:
 *   history
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_LAST = 20;
const MAX_LAST = 5000;
const DEFAULT_EXCERPT_LENGTH = 140;

function usage() {
  console.log('Usage: node hm-comms.js history [options]');
  console.log('Commands: history');
  console.log('Options:');
  console.log(`  --last <n>                 Show the latest N messages (default: ${DEFAULT_LAST})`);
  console.log('  --session <n|id>          Filter by session number (e.g. 174) or session id (e.g. app-session-174)');
  console.log('  --between <a> <b>         Filter bidirectionally between roles a and b');
  console.log('  --json                    Output machine-readable JSON');
  console.log('  --db <path>               Override DB path (default: .squidrun/runtime/evidence-ledger.db)');
  console.log('Examples:');
  console.log('  node hm-comms.js history --last 15');
  console.log('  node hm-comms.js history --session 174');
  console.log('  node hm-comms.js history --between architect builder --last 10');
  console.log('  node hm-comms.js history --between builder oracle --last 25 --json');
}

function parseArgs(argv) {
  const positional = [];
  const options = new Map();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }

    const key = token.slice(2).trim();
    if (key === 'between') {
      const left = argv[i + 1];
      const right = argv[i + 2];
      if (!left || !right || left.startsWith('--') || right.startsWith('--')) {
        throw new Error('--between requires two role values');
      }
      options.set('between', [left, right]);
      i += 2;
      continue;
    }

    const next = argv[i + 1];
    const value = (!next || next.startsWith('--')) ? true : next;
    if (value !== true) i += 1;
    options.set(key, value);
  }

  return { positional, options };
}

function getOption(options, key, fallback = null) {
  if (!options.has(key)) return fallback;
  return options.get(key);
}

function asString(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function asPositiveInt(value, fallback) {
  if (value === null || value === undefined) return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function normalizeRole(value) {
  const role = asString(value, '').toLowerCase();
  if (!role) return '';
  return role;
}

function normalizeSessionId(value) {
  const raw = asString(value, '');
  if (!raw) return '';
  if (/^\d+$/.test(raw)) return `app-session-${raw}`;
  return raw;
}

function resolveDefaultDbPath() {
  // When running from the extracted .squidrun/bin/ layout, __dirname-based resolution
  // produces a double-nested path. Use SQUIDRUN_PROJECT_ROOT if the launcher set it.
  const envRoot = process.env.SQUIDRUN_PROJECT_ROOT;
  if (envRoot && fs.existsSync(envRoot)) {
    return path.join(envRoot, '.squidrun', 'runtime', 'evidence-ledger.db');
  }
  // Walk up from cwd to find .squidrun/link.json (same pattern as hm-send.js).
  let dir = path.resolve(process.cwd());
  while (true) {
    const candidate = path.join(dir, '.squidrun', 'runtime', 'evidence-ledger.db');
    if (fs.existsSync(path.join(dir, '.squidrun', 'link.json')) || fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Final fallback: original __dirname-based resolution (works in dev layout).
  return path.resolve(__dirname, '..', '..', '.squidrun', 'runtime', 'evidence-ledger.db');
}

function resolveDbPath(options) {
  const override = asString(getOption(options, 'db', ''), '');
  return override ? path.resolve(override) : resolveDefaultDbPath();
}

function readNodeSqlite() {
  try {
    const mod = require('node:sqlite');
    if (!mod || typeof mod.DatabaseSync !== 'function') {
      throw new Error('node:sqlite DatabaseSync is unavailable');
    }
    return mod;
  } catch (err) {
    throw new Error(`node:sqlite unavailable: ${err.message}`);
  }
}

function buildHistoryQuery(options) {
  const clauses = [];
  const params = [];

  const sessionId = normalizeSessionId(getOption(options, 'session', ''));
  if (sessionId) {
    clauses.push('session_id = ?');
    params.push(sessionId);
  }

  const between = getOption(options, 'between', null);
  if (Array.isArray(between) && between.length === 2) {
    const left = normalizeRole(between[0]);
    const right = normalizeRole(between[1]);
    if (!left || !right) {
      throw new Error('--between roles must be non-empty');
    }
    clauses.push('((sender_role = ? AND target_role = ?) OR (sender_role = ? AND target_role = ?))');
    params.push(left, right, right, left);
  }

  const limitRaw = asPositiveInt(getOption(options, 'last', DEFAULT_LAST), DEFAULT_LAST);
  const limit = Math.max(1, Math.min(MAX_LAST, limitRaw));

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const sql = `
    SELECT
      row_id,
      message_id,
      session_id,
      sender_role,
      target_role,
      status,
      raw_body,
      sent_at_ms,
      brokered_at_ms,
      updated_at_ms,
      COALESCE(brokered_at_ms, sent_at_ms, updated_at_ms) AS ts_ms
    FROM comms_journal
    ${where}
    ORDER BY ts_ms DESC, row_id DESC
    LIMIT ?
  `;

  return { sql, params: [...params, limit], limit };
}

function formatTimestamp(ms) {
  const numeric = Number(ms);
  if (!Number.isFinite(numeric) || numeric <= 0) return '-';
  return new Date(numeric).toISOString().replace('T', ' ').replace('Z', '');
}

function formatExcerpt(rawBody, maxLength = DEFAULT_EXCERPT_LENGTH) {
  const normalized = String(rawBody || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return '(empty)';
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function renderRows(rows) {
  if (!rows || rows.length === 0) {
    console.log('No messages found.');
    return;
  }

  const stampWidth = 19;
  const senderWidth = 10;
  const targetWidth = 10;

  rows.forEach((row) => {
    const stamp = formatTimestamp(row.ts_ms).padEnd(stampWidth, ' ');
    const sender = asString(row.sender_role, '-').padEnd(senderWidth, ' ');
    const target = asString(row.target_role, '-').padEnd(targetWidth, ' ');
    const excerpt = formatExcerpt(row.raw_body);
    console.log(`${stamp} ${sender} -> ${target} ${excerpt}`);
  });
}

function toJsonRows(rows) {
  return rows.map((row) => ({
    rowId: row.row_id,
    messageId: row.message_id,
    sessionId: row.session_id,
    sender: row.sender_role,
    target: row.target_role,
    status: row.status,
    timestampMs: row.ts_ms,
    timestamp: formatTimestamp(row.ts_ms),
    excerpt: formatExcerpt(row.raw_body),
    rawBody: row.raw_body || '',
  }));
}

function runHistory(options) {
  const dbPath = resolveDbPath(options);
  if (!fs.existsSync(dbPath)) {
    throw new Error(`DB not found: ${dbPath}`);
  }

  const { DatabaseSync } = readNodeSqlite();
  const db = new DatabaseSync(dbPath);

  try {
    const { sql, params, limit } = buildHistoryQuery(options);
    const rows = db.prepare(sql).all(...params);
    const isJson = getOption(options, 'json', false) === true;

    if (isJson) {
      console.log(JSON.stringify({
        ok: true,
        dbPath,
        count: rows.length,
        limit,
        rows: toJsonRows(rows),
      }, null, 2));
      return;
    }

    renderRows(rows);
    console.log('');
    console.log(`Rows: ${rows.length}`);
  } finally {
    db.close();
  }
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    usage();
    process.exit(0);
  }

  const { positional, options } = parseArgs(argv);
  const command = asString(positional[0], '').toLowerCase();
  if (!command) {
    usage();
    process.exit(1);
  }

  if (command !== 'history') {
    console.error(`Unsupported command: ${command}`);
    usage();
    process.exit(1);
  }

  runHistory(options);
}

try {
  main();
} catch (err) {
  console.error(`hm-comms failed: ${err.message}`);
  process.exit(1);
}
