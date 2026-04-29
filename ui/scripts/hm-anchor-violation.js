#!/usr/bin/env node
'use strict';

/**
 * hm-anchor-violation — log anchor violations cross-agent.
 *
 * The shape parallels Oracle's care-receipts.jsonl + taste-events.jsonl: an
 * append-only JSONL log of behavioral anchor failures. Lets the team formalize
 * the cross-agent enforcement that emerged organically (Oracle catching my
 * closed-lane-without-checkpoint, James catching the texture-file
 * "creepiness", Codex catching multi-revision dispatch chains).
 *
 * Architect anchors live at workspace/agent-mind/architect/anchors.json. Other
 * agents may have their own anchor files; this log is anchor-file-agnostic —
 * just point at any anchor id from any agent's anchor file.
 *
 * Usage:
 *   hm-anchor-violation.js record \
 *     --observer <agent>             (architect|builder|oracle|codex)
 *     --violator <agent>             (architect|builder|oracle|codex)
 *     --anchor <anchor-id>           (e.g., anchor-004)
 *     --pattern "<pattern-name>"     (e.g., "flattening-felt-vision")
 *     --evidence "<excerpt-or-id>"   (message id, file path, quote)
 *     [--correction "<text>"]        (what was corrected; optional)
 *     [--source "<file-or-msg-id>"]  (provenance)
 *     [--status open|closed]         (default: open)
 *
 *   hm-anchor-violation.js list [--agent <role>] [--anchor <id>] [--unresolved] [--json]
 *   hm-anchor-violation.js summary [--json]
 *   hm-anchor-violation.js close --id <violation-id> [--correction "<text>"]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const COORD_DIR = path.resolve(__dirname, '../../.squidrun/coord');
const LOG_PATH = path.join(COORD_DIR, 'anchor-violations.jsonl');

function genId() {
  try { return `viol-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`; }
  catch { return `viol-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`; }
}

function parseArgs(argv = process.argv.slice(2)) {
  const opts = {
    command: argv[0] || 'list',
    observer: '',
    violator: '',
    anchorId: '',
    pattern: '',
    evidence: '',
    correction: '',
    source: '',
    status: 'open',
    id: '',
    agent: '',
    unresolved: false,
    json: false,
    help: false,
  };
  for (let i = 1; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--observer') opts.observer = String(argv[++i] || '').trim().toLowerCase();
    else if (t === '--violator') opts.violator = String(argv[++i] || '').trim().toLowerCase();
    else if (t === '--anchor') opts.anchorId = String(argv[++i] || '').trim();
    else if (t === '--pattern') opts.pattern = String(argv[++i] || '').trim();
    else if (t === '--evidence') opts.evidence = String(argv[++i] || '').trim();
    else if (t === '--correction') opts.correction = String(argv[++i] || '').trim();
    else if (t === '--source') opts.source = String(argv[++i] || '').trim();
    else if (t === '--status') opts.status = String(argv[++i] || '').trim().toLowerCase();
    else if (t === '--id') opts.id = String(argv[++i] || '').trim();
    else if (t === '--agent') opts.agent = String(argv[++i] || '').trim().toLowerCase();
    else if (t === '--anchor-id') opts.anchorId = String(argv[++i] || '').trim();
    else if (t === '--unresolved') opts.unresolved = true;
    else if (t === '--json') opts.json = true;
    else if (t === '-h' || t === '--help') opts.help = true;
  }
  return opts;
}

function loadAll() {
  if (!fs.existsSync(LOG_PATH)) return [];
  const lines = fs.readFileSync(LOG_PATH, 'utf8').split(/\r?\n/).filter(Boolean);
  const out = [];
  for (const line of lines) {
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

function saveAll(entries) {
  const out = entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : '');
  fs.mkdirSync(COORD_DIR, { recursive: true });
  fs.writeFileSync(LOG_PATH, out, 'utf8');
}

function appendOne(entry) {
  fs.mkdirSync(COORD_DIR, { recursive: true });
  fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n', 'utf8');
}

function fmtEntry(e) {
  const lines = [
    `[${e.id}] ${e.ts}`,
    `  observer: ${e.observer}  violator: ${e.violator}  anchor: ${e.anchorId}  status: ${e.status}`,
    `  pattern: ${e.pattern}`,
  ];
  if (e.evidence) lines.push(`  evidence: ${e.evidence}`);
  if (e.correction) lines.push(`  correction: ${e.correction}`);
  if (e.source) lines.push(`  source: ${e.source}`);
  return lines.join('\n');
}

function cmdRecord(opts) {
  if (!opts.observer || !opts.violator || !opts.anchorId || !opts.pattern || !opts.evidence) {
    console.error('record requires --observer, --violator, --anchor, --pattern, --evidence');
    process.exit(1);
  }
  const entry = {
    id: genId(),
    ts: new Date().toISOString(),
    observer: opts.observer,
    violator: opts.violator,
    anchorId: opts.anchorId,
    pattern: opts.pattern,
    evidence: opts.evidence,
    correction: opts.correction || '',
    source: opts.source || '',
    status: opts.status === 'closed' ? 'closed' : 'open',
  };
  appendOne(entry);
  console.log(`recorded ${entry.id}`);
  console.log(fmtEntry(entry));
}

function cmdList(opts) {
  const all = loadAll();
  let list = all;
  if (opts.agent) list = list.filter((e) => e.violator === opts.agent || e.observer === opts.agent);
  if (opts.anchorId) list = list.filter((e) => e.anchorId === opts.anchorId);
  if (opts.unresolved) list = list.filter((e) => e.status !== 'closed');
  if (opts.json) {
    console.log(JSON.stringify(list, null, 2));
    return;
  }
  if (list.length === 0) {
    console.log('no matching anchor-violation entries');
    return;
  }
  console.log(`${list.length} anchor-violation entr${list.length === 1 ? 'y' : 'ies'}\n`);
  for (const e of list) {
    console.log(fmtEntry(e));
    console.log('');
  }
}

function cmdSummary(opts) {
  const all = loadAll();
  const byAnchor = {};
  const byViolator = {};
  let open = 0, closed = 0;
  for (const e of all) {
    byAnchor[e.anchorId] = (byAnchor[e.anchorId] || 0) + 1;
    byViolator[e.violator] = (byViolator[e.violator] || 0) + 1;
    if (e.status === 'closed') closed += 1; else open += 1;
  }
  const summary = { total: all.length, open, closed, byAnchor, byViolator };
  if (opts.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  console.log(`anchor-violations: ${summary.total} total (${open} open, ${closed} closed)`);
  console.log('by anchor:');
  for (const [k, v] of Object.entries(byAnchor).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${v}`);
  }
  console.log('by violator:');
  for (const [k, v] of Object.entries(byViolator).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${v}`);
  }
}

function cmdClose(opts) {
  if (!opts.id) {
    console.error('close requires --id');
    process.exit(1);
  }
  const all = loadAll();
  const target = all.find((e) => e.id === opts.id);
  if (!target) {
    console.error(`no entry with id ${opts.id}`);
    process.exit(1);
  }
  target.status = 'closed';
  if (opts.correction) target.correction = opts.correction;
  target.closedAt = new Date().toISOString();
  saveAll(all);
  console.log(`closed ${target.id}`);
}

function main() {
  const opts = parseArgs();
  if (opts.help) {
    console.log(`hm-anchor-violation — cross-agent anchor-violation log

Commands:
  record --observer <a> --violator <a> --anchor <id> --pattern "<name>" --evidence "<text>" [--correction <t>] [--source <s>] [--status open|closed]
  list [--agent <a>] [--anchor <id>] [--unresolved] [--json]
  summary [--json]
  close --id <viol-id> [--correction <t>]

Storage: .squidrun/coord/anchor-violations.jsonl (append-only)
`);
    process.exit(0);
  }
  switch (opts.command) {
    case 'record': cmdRecord(opts); break;
    case 'list': cmdList(opts); break;
    case 'summary': cmdSummary(opts); break;
    case 'close': cmdClose(opts); break;
    default:
      console.error(`unknown command: ${opts.command}`);
      process.exit(1);
  }
}

main();
