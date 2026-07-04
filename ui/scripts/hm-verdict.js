#!/usr/bin/env node
'use strict';

/**
 * hm-verdict: the verdict ledger's mouth (S468 — organ 2 gets consumers).
 *
 * The S468 seam audit found the resolve/supersede/sweep laws and the store
 * had ZERO production callers — verdicts froze 'open' forever and
 * credibility could never learn. This CLI is the missing production path.
 * All laws live in verdict-ledger.js; all durability in verdict-ledger-store.
 *
 *   node ui/scripts/hm-verdict.js list [--issuer X] [--status open]
 *   node ui/scripts/hm-verdict.js add --issuer X --kind claim --statement "..." --evidence "..." [--subject S] [--expires-at ISO] [--pends-on ID]
 *   node ui/scripts/hm-verdict.js resolve <id> --status held|failed|mixed --resolver X --note "..."
 *   node ui/scripts/hm-verdict.js supersede <old-id> --issuer X --kind claim --statement "..." --evidence "..."
 *   node ui/scripts/hm-verdict.js sweep
 *   node ui/scripts/hm-verdict.js standing [--issuer X]
 * All commands accept --store <path> (tests / non-default profiles).
 */

const ledger = require('../modules/verdict-ledger');
const store = require('../modules/verdict-ledger-store');

function parseFlags(rest) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token.startsWith('--')) {
      flags[token.slice(2)] = rest[i + 1];
      i += 1;
    } else {
      positional.push(token);
    }
  }
  return { flags, positional };
}

function storeOptions(flags) {
  const options = {};
  if (flags.store) options.storePath = flags.store;
  // A fresh store seeds from the s465 backfill by design; --backfill lets
  // tests and side profiles point elsewhere (or at nothing).
  if (flags.backfill) options.backfillPath = flags.backfill;
  return options;
}

function requireRecord(id, options) {
  const record = store.findRecordById(id, options);
  if (!record) throw new Error(`no verdict with id '${id}'`);
  return record;
}

function runVerdictCommand(argv, { nowIso = new Date().toISOString() } = {}) {
  const [cmd, ...rest] = argv;
  const { flags, positional } = parseFlags(rest);
  const options = storeOptions(flags);

  if (cmd === 'list') {
    let records = store.loadRecords(options);
    if (flags.issuer) records = records.filter((r) => r.issuer === flags.issuer);
    if (flags.status) records = records.filter((r) => r.outcome.status === flags.status);
    return {
      count: records.length,
      records: records.map((r) => ({
        id: r.id, issuer: r.issuer, kind: r.kind, status: r.outcome.status,
        statement: r.statement.slice(0, 100),
      })),
    };
  }

  if (cmd === 'add') {
    const record = ledger.createVerdict({
      issuer: flags.issuer,
      kind: flags.kind,
      subject: flags.subject || '',
      statement: flags.statement,
      evidence: flags.evidence,
      expiresAt: flags['expires-at'] || null,
      pendsOn: flags['pends-on'] || null,
      issuedAt: nowIso,
    });
    store.upsertRecord(record, options);
    return { added: record.id, status: record.outcome.status };
  }

  if (cmd === 'resolve') {
    const record = requireRecord(positional[0], options);
    ledger.resolveVerdict(record, {
      status: flags.status,
      resolver: flags.resolver,
      note: flags.note,
      resolvedAt: nowIso,
    });
    store.upsertRecord(record, options);
    return { resolved: record.id, status: record.outcome.status };
  }

  if (cmd === 'supersede') {
    const oldRecord = requireRecord(positional[0], options);
    const newRecord = ledger.createVerdict({
      issuer: flags.issuer,
      kind: flags.kind,
      subject: flags.subject || oldRecord.subject,
      statement: flags.statement,
      evidence: flags.evidence,
      issuedAt: nowIso,
    });
    ledger.supersedeVerdict(oldRecord, newRecord);
    store.upsertRecord(newRecord, options);
    store.upsertRecord(oldRecord, options);
    return { superseded: oldRecord.id, by: newRecord.id };
  }

  if (cmd === 'sweep') {
    const records = store.loadRecords(options);
    const swept = ledger.sweepExpired(records, nowIso);
    if (swept > 0) store.saveRecords(records, options);
    return { swept };
  }

  if (cmd === 'standing') {
    const records = store.loadRecords(options);
    const issuers = flags.issuer
      ? [flags.issuer]
      : [...new Set(records.map((r) => r.issuer))].sort();
    return { standings: issuers.map((issuer) => ledger.credibility(records, issuer)) };
  }

  throw new Error(
    'usage: hm-verdict.js list|add|resolve <id>|supersede <old-id>|sweep|standing [flags]'
  );
}

function main() {
  try {
    const result = runVerdictCommand(process.argv.slice(2));
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(`hm-verdict: ${err.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { runVerdictCommand, parseFlags };
