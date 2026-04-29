#!/usr/bin/env node
'use strict';

/**
 * hm-inbox-read — list and ack inbox entries for an agent role.
 *
 * Modes:
 *   --list-unread (default)        — print unread entries
 *   --list-all                     — print all entries
 *   --summary                      — short startup summary (counts + most recent)
 *   --ack <id>                     — mark a single entry as read
 *   --ack-all                      — mark all currently-unread entries as read
 *
 * Examples:
 *   node hm-inbox-read.js architect
 *   node hm-inbox-read.js architect --summary
 *   node hm-inbox-read.js architect --list-all
 *   node hm-inbox-read.js architect --ack inbox-1719999999-abcd1234
 *   node hm-inbox-read.js architect --ack-all
 */

const fs = require('fs');
const path = require('path');

const COORD_DIR = path.resolve(__dirname, '../../.squidrun/coord');

function parseArgs(argv = process.argv.slice(2)) {
  const opts = {
    role: null,
    mode: 'list-unread',
    ackId: null,
    json: false,
    help: false,
  };
  if (argv.length === 0) { opts.help = true; return opts; }
  opts.role = argv[0];
  for (let i = 1; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--list-unread') opts.mode = 'list-unread';
    else if (t === '--list-all') opts.mode = 'list-all';
    else if (t === '--summary') opts.mode = 'summary';
    else if (t === '--ack') { opts.mode = 'ack'; opts.ackId = argv[++i]; }
    else if (t === '--ack-all') opts.mode = 'ack-all';
    else if (t === '--json') opts.json = true;
    else if (t === '-h' || t === '--help') opts.help = true;
  }
  return opts;
}

function loadInbox(role) {
  const p = path.join(COORD_DIR, `${role}-inbox.jsonl`);
  if (!fs.existsSync(p)) return { path: p, entries: [] };
  const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean);
  const entries = [];
  for (const line of lines) {
    try {
      const e = JSON.parse(line);
      // Backfill missing fields for legacy entries (created before read/readAt existed).
      if (e.read === undefined) e.read = false;
      if (e.readAt === undefined) e.readAt = null;
      entries.push(e);
    } catch {
      // skip malformed
    }
  }
  return { path: p, entries };
}

function saveInbox(p, entries) {
  const out = entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : '');
  fs.writeFileSync(p, out, 'utf8');
}

function fmtEntry(e) {
  const lines = [
    `[${e.id}] ${e.ts}`,
    `  from: ${e.from || '?'}  kind: ${e.kind || '?'}  priority: ${e.priority || 'normal'}${e.read ? '  (READ ' + e.readAt + ')' : ''}`,
  ];
  if (e.path) lines.push(`  path: ${e.path}`);
  if (e.summary) lines.push(`  summary: ${e.summary}`);
  if (e.ref) lines.push(`  ref: ${e.ref}`);
  return lines.join('\n');
}

function main() {
  const opts = parseArgs();
  if (opts.help || !opts.role) {
    console.log(`hm-inbox-read — list and ack inbox entries for an agent

Usage:
  hm-inbox-read.js <role> [--list-unread | --list-all | --summary | --ack <id> | --ack-all] [--json]

Roles: architect | builder | oracle | codex (or any with a <role>-inbox.jsonl)

Modes (default: --list-unread):
  --list-unread   print unread entries
  --list-all      print every entry
  --summary       short startup summary: total/unread counts + most recent unread
  --ack <id>      mark one entry read
  --ack-all       mark all currently-unread entries read
  --json          emit JSON instead of text
`);
    process.exit(0);
  }

  const inbox = loadInbox(opts.role);

  if (opts.mode === 'ack' || opts.mode === 'ack-all') {
    let acked = 0;
    const nowIso = new Date().toISOString();
    for (const e of inbox.entries) {
      if (e.read) continue;
      if (opts.mode === 'ack' && e.id !== opts.ackId) continue;
      e.read = true;
      e.readAt = nowIso;
      acked += 1;
    }
    saveInbox(inbox.path, inbox.entries);
    console.log(`acked ${acked} entr${acked === 1 ? 'y' : 'ies'} for ${opts.role}`);
    return;
  }

  const unread = inbox.entries.filter((e) => !e.read);

  if (opts.mode === 'summary') {
    const newest = unread[unread.length - 1];
    const summary = {
      role: opts.role,
      total: inbox.entries.length,
      unread: unread.length,
      newestUnread: newest ? {
        id: newest.id,
        ts: newest.ts,
        from: newest.from,
        kind: newest.kind,
        path: newest.path,
        summary: newest.summary,
      } : null,
    };
    if (opts.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(`${opts.role} inbox: ${summary.total} total, ${summary.unread} unread`);
      if (newest) {
        console.log(`  newest unread:`);
        console.log(`    [${newest.id}] from=${newest.from} kind=${newest.kind} ts=${newest.ts}`);
        if (newest.path) console.log(`    path: ${newest.path}`);
        if (newest.summary) console.log(`    summary: ${newest.summary}`);
      }
    }
    return;
  }

  const list = opts.mode === 'list-all' ? inbox.entries : unread;
  if (opts.json) {
    console.log(JSON.stringify(list, null, 2));
    return;
  }
  if (list.length === 0) {
    console.log(`${opts.role} inbox: no ${opts.mode === 'list-all' ? 'entries' : 'unread entries'}`);
    return;
  }
  console.log(`${opts.role} inbox: ${list.length} ${opts.mode === 'list-all' ? 'total' : 'unread'} entr${list.length === 1 ? 'y' : 'ies'}\n`);
  for (const e of list) {
    console.log(fmtEntry(e));
    console.log('');
  }
}

main();
