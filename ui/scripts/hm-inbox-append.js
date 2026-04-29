#!/usr/bin/env node
'use strict';

/**
 * hm-inbox-append — write a thread-update entry to <recipient>-inbox.jsonl
 *
 * Part of the file-first agent sidechannel protocol. Lets agents notify each
 * other about file-based thread updates without filling James's pane with
 * full message content via PTY injection.
 *
 * Usage:
 *   node hm-inbox-append.js <recipient> --kind <kind> --path <file> --summary "<text>" [--from <sender>] [--priority normal|urgent]
 *
 * Recipients map to:  .squidrun/coord/<recipient>-inbox.jsonl
 *
 * Kinds (free-form, but conventional):
 *   thread-update    — a coord file has new content
 *   review-request   — please look at this
 *   ack              — acknowledging a prior entry
 *   wake             — please pick this up now
 *
 * Example:
 *   node hm-inbox-append.js builder \
 *     --kind thread-update \
 *     --path .squidrun/coord/agent-sidechannel-protocol-2026-04-29.md \
 *     --summary "protocol proposal for review"
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const COORD_DIR = path.resolve(__dirname, '../../.squidrun/coord');

function parseArgs(argv = process.argv.slice(2)) {
  const opts = {
    recipient: null,
    kind: 'thread-update',
    path: null,
    summary: '',
    from: 'architect',
    priority: 'normal',
    refId: null,
    help: false,
  };
  if (argv.length === 0) { opts.help = true; return opts; }
  opts.recipient = argv[0];
  for (let i = 1; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--kind') opts.kind = argv[++i];
    else if (t === '--path') opts.path = argv[++i];
    else if (t === '--summary') opts.summary = argv[++i];
    else if (t === '--from') opts.from = argv[++i];
    else if (t === '--priority') opts.priority = argv[++i];
    else if (t === '--ref') opts.refId = argv[++i];
    else if (t === '-h' || t === '--help') opts.help = true;
  }
  return opts;
}

function genId() {
  try { return `inbox-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`; }
  catch { return `inbox-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`; }
}

function main() {
  const opts = parseArgs();
  if (opts.help) {
    console.log(`hm-inbox-append — file-first agent sidechannel writer

Usage: hm-inbox-append.js <recipient> --kind <kind> --path <file> --summary "<text>" [--from <sender>] [--priority normal|urgent] [--ref <prior-id>]

Recipients: architect | builder | oracle | codex (or any role with a <role>-inbox.jsonl)
Kinds: thread-update, review-request, ack, wake (free-form OK)
`);
    process.exit(0);
  }
  if (!opts.recipient) {
    console.error('recipient required');
    process.exit(1);
  }
  if (!opts.summary && !opts.path) {
    console.error('either --summary or --path required');
    process.exit(1);
  }

  const inboxPath = path.join(COORD_DIR, `${opts.recipient}-inbox.jsonl`);
  fs.mkdirSync(COORD_DIR, { recursive: true });

  const entry = {
    id: genId(),
    ts: new Date().toISOString(),
    from: opts.from,
    to: opts.recipient,
    kind: opts.kind,
    priority: opts.priority,
    path: opts.path || null,
    summary: opts.summary || '',
    ref: opts.refId || null,
    read: false,
    readAt: null,
  };

  fs.appendFileSync(inboxPath, JSON.stringify(entry) + '\n', 'utf8');
  console.log(`appended ${entry.id} → ${inboxPath}`);
}

main();
