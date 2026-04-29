#!/usr/bin/env node
'use strict';

/**
 * Append one contract-compliant request to .squidrun/coord/codex-inbox.jsonl.
 *
 * Contract: stable id, to=codex, priority, instance, optional contextFile, and
 * exactly one requested Codex action. Long content belongs in contextFile.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const COORD_DIR = path.resolve(__dirname, '../../.squidrun/coord');
const DEFAULT_INBOX_PATH = path.join(COORD_DIR, 'codex-inbox.jsonl');

function parseArgs(argv = process.argv.slice(2)) {
  const opts = {
    id: '',
    from: 'builder',
    priority: 'normal',
    instance: 'james-main',
    contextFile: '',
    action: '',
    type: 'current_objective_request',
    inboxPath: DEFAULT_INBOX_PATH,
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '').trim();
    if (token === '--id') opts.id = String(argv[++index] || '').trim();
    else if (token === '--from') opts.from = String(argv[++index] || '').trim();
    else if (token === '--priority') opts.priority = String(argv[++index] || '').trim();
    else if (token === '--instance') opts.instance = String(argv[++index] || '').trim();
    else if (token === '--context-file') opts.contextFile = String(argv[++index] || '').trim();
    else if (token === '--action') opts.action = String(argv[++index] || '').trim();
    else if (token === '--type') opts.type = String(argv[++index] || '').trim();
    else if (token === '--inbox') opts.inboxPath = path.resolve(String(argv[++index] || '').trim());
    else if (token === '--json') opts.json = true;
    else if (token === '-h' || token === '--help') opts.help = true;
  }

  return opts;
}

function usage() {
  console.log(`hm-codex-inbox-append — append one Codex bridge request

Usage:
  hm-codex-inbox-append.js --id <stable-id> --action "<one requested action>" [--context-file <path>] [--priority normal|urgent]

Required:
  --id       Stable, caller-chosen id for de-duping.
  --action   Exactly one requested Codex action. Put long context in --context-file.
`);
}

function validate(opts) {
  const errors = [];
  if (!opts.id) errors.push('--id is required');
  if (!opts.action) errors.push('--action is required');
  if (!opts.instance) errors.push('--instance is required');
  if (!['low', 'normal', 'urgent'].includes(opts.priority)) {
    errors.push('--priority must be low, normal, or urgent');
  }
  if (!opts.type) errors.push('--type is required');
  return errors;
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function buildEntry(opts) {
  return {
    id: opts.id,
    createdAt: new Date().toISOString(),
    type: opts.type,
    from: opts.from || 'builder',
    to: 'codex',
    priority: opts.priority || 'normal',
    instance: opts.instance || 'james-main',
    contextFile: opts.contextFile || null,
    neededCodexAction: opts.action,
  };
}

function appendEntry(opts) {
  const errors = validate(opts);
  if (errors.length > 0) {
    throw new Error(errors.join('; '));
  }
  const existing = readJsonl(opts.inboxPath);
  if (existing.some((entry) => entry?.id === opts.id)) {
    return {
      ok: true,
      skipped: true,
      reason: 'duplicate_id',
      inboxPath: opts.inboxPath,
      id: opts.id,
    };
  }
  const entry = buildEntry(opts);
  fs.mkdirSync(path.dirname(opts.inboxPath), { recursive: true });
  fs.appendFileSync(opts.inboxPath, `${JSON.stringify(entry)}\n`, 'utf8');
  return { ok: true, skipped: false, inboxPath: opts.inboxPath, entry };
}

function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    usage();
    return { ok: true };
  }
  const result = appendEntry(opts);
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.skipped) {
    console.log(`codex inbox already has ${result.id}; skipped duplicate`);
  } else {
    console.log(`appended ${result.entry.id} -> ${result.inboxPath}`);
  }
  return result;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`hm-codex-inbox-append error: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  parseArgs,
  validate,
  buildEntry,
  appendEntry,
  main,
  DEFAULT_INBOX_PATH,
};
