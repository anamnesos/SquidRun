#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

try { require('../modules/logger').setLevel('warn'); } catch {}

const COMMON_FLAGS = Object.freeze([
  'project-root',
  'db',
  'db-path',
  'spool',
  'spool-path',
  'actor',
]);
const COMMAND_FLAGS = Object.freeze({
  create: ['from-row', 'creditor', 'obligor', 'class', 'staleness', 'lease', 'lease-id'],
  list: ['address', 'status', 'perspective', 'limit'],
  fulfill: ['id', 'obligation-id', 'by-row'],
  release: ['id', 'obligation-id', 'reason'],
  'lapse-scan': ['beat-row', 'address'],
  lapsescan: ['beat-row', 'address'],
});

function parseArgs(argv = []) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = String(argv[index] || '');
    if (!value.startsWith('--')) {
      positional.push(value);
      continue;
    }
    const key = value.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !String(next).startsWith('--')) {
      flags[key] = String(next);
      index += 1;
    } else {
      flags[key] = true;
    }
  }
  return { positional, flags };
}

function printUsage(stream = process.stderr) {
  stream.write([
    'Usage:',
    '  node ui/scripts/hm-obligations.js create --from-row <row-id> --creditor <address> --obligor <address> --class <class> --staleness <class> [--lease <id>]',
    '  node ui/scripts/hm-obligations.js list --address <address> [--status open,lapsed] [--perspective owe|owed]',
    '  node ui/scripts/hm-obligations.js fulfill --id <obligation-id> --by-row <row-id> [--actor <address>]',
    '  node ui/scripts/hm-obligations.js release --id <obligation-id> --reason <text> [--actor <address>]',
    '  node ui/scripts/hm-obligations.js lapse-scan [--beat-row <row-id>] [--address <address>]',
    '',
    'Common: --project-root <path> --db <evidence-ledger.db>',
    '',
  ].join('\n'));
}

function validateCommandFlags(command, flags = {}) {
  const commandFlags = COMMAND_FLAGS[command];
  if (!commandFlags) return { ok: false, status: 'invalid', reason: 'command_invalid' };
  const allowed = new Set([...COMMON_FLAGS, ...commandFlags]);
  const supplied = Object.keys(flags);
  const unknownFlags = supplied.filter((flag) => !allowed.has(flag));
  if (unknownFlags.length > 0) {
    return {
      ok: false,
      status: 'invalid',
      reason: 'unknown_flag',
      flags: unknownFlags.sort(),
    };
  }
  const missingValues = supplied.filter((flag) => flags[flag] === true);
  if (missingValues.length > 0) {
    return {
      ok: false,
      status: 'invalid',
      reason: 'flag_value_required',
      flags: missingValues.sort(),
    };
  }
  return { ok: true };
}

function resolveRuntime(argv = process.argv.slice(2), env = process.env) {
  const parsed = parseArgs(argv);
  const projectRoot = path.resolve(
    parsed.flags['project-root'] || env.SQUIDRUN_PROJECT_ROOT || process.cwd()
  );
  const config = require('../config');
  config.setProjectRoot(projectRoot);
  const dbPath = path.resolve(
    parsed.flags.db
      || parsed.flags['db-path']
      || config.resolveCoordPath(path.join('runtime', 'evidence-ledger.db'), { forWrite: true })
  );
  const spoolPath = path.resolve(
    parsed.flags.spool
      || parsed.flags['spool-path']
      || path.join(projectRoot, '.squidrun', 'runtime', 'next-session-notices')
  );
  return { ...parsed, projectRoot, dbPath, spoolPath };
}

function executeCommand(runtime, env = process.env) {
  const command = String(runtime.positional[0] || '').trim().toLowerCase();
  const flags = runtime.flags;
  const flagValidation = validateCommandFlags(command, flags);
  if (!flagValidation.ok) return flagValidation;

  const { EvidenceLedgerStore } = require('../modules/main/evidence-ledger-store');
  const { validateNoticePayload } = require('./hm-next-session-notices');
  const store = new EvidenceLedgerStore({ dbPath: runtime.dbPath, enabled: true });
  const init = store.init();
  if (!init.ok) return { ok: false, status: 'unavailable', reason: init.reason || 'store_init_failed' };

  const actor = flags.actor || env.SQUIDRUN_ROLE || null;
  try {
    if (command === 'create') {
      return store.createObligation({
        fromRowId: flags['from-row'],
        creditor: flags.creditor,
        obligor: flags.obligor,
        class: flags.class,
        staleness: flags.staleness,
        leaseId: flags.lease || flags['lease-id'] || null,
        actor,
      });
    }
    if (command === 'list') {
      return store.queryObligations({
        address: flags.address || actor,
        status: flags.status || 'open,lapsed',
        perspective: flags.perspective || null,
        limit: flags.limit,
      });
    }
    if (command === 'fulfill') {
      return store.fulfillObligation({
        obligationId: flags.id || flags['obligation-id'] || runtime.positional[1],
        byRowId: flags['by-row'],
        actor,
      });
    }
    if (command === 'release') {
      return store.releaseObligation({
        obligationId: flags.id || flags['obligation-id'] || runtime.positional[1],
        reason: flags.reason,
        actor,
      });
    }
    if (command === 'lapse-scan' || command === 'lapsescan') {
      const address = flags.address || actor || null;
      let beatRowId = flags['beat-row'] || null;
      let naturalBeat = null;
      if (!beatRowId) {
        let appStatus = {};
        try {
          appStatus = JSON.parse(
            fs.readFileSync(path.join(runtime.projectRoot, '.squidrun', 'app-status.json'), 'utf8')
          );
        } catch {}
        const rawSessionId = appStatus?.session_id
          || appStatus?.sessionId
          || appStatus?.session
          || env.SQUIDRUN_SESSION_SCOPE_ID
          || env.SQUIDRUN_SESSION_ID
          || null;
        const sessionId = Number.isInteger(Number(rawSessionId)) && Number(rawSessionId) > 0
          ? `app-session-${Number(rawSessionId)}`
          : rawSessionId;
        naturalBeat = store.recordObligationNaturalBeat({
          role: address,
          sessionId,
          kind: 'manual-cli',
        });
        if (!naturalBeat.ok) return naturalBeat;
        beatRowId = naturalBeat.naturalBeatRowId;
      }
      const lapseScan = store.lapseObligations({
        beatRowId,
        address,
        spoolPath: runtime.spoolPath,
      }, {
        validateNotice: validateNoticePayload,
      });
      return { ...lapseScan, naturalBeat };
    }
    return { ok: false, status: 'invalid', reason: 'command_invalid' };
  } finally {
    store.close();
  }
}

function main(argv = process.argv.slice(2), options = {}) {
  const output = options.output || process.stdout;
  const errorOutput = options.errorOutput || process.stderr;
  const env = options.env || process.env;
  const runtime = resolveRuntime(argv, env);
  if (!runtime.positional[0]) {
    printUsage(errorOutput);
    return 2;
  }
  let result;
  try {
    result = executeCommand(runtime, env);
  } catch (error) {
    result = { ok: false, status: 'error', reason: error.message || String(error) };
  }
  output.write(`${JSON.stringify({ ...result, dbPath: runtime.dbPath }, null, 2)}\n`);
  if (!result.ok && result.reason === 'command_invalid') printUsage(errorOutput);
  return result.ok ? 0 : 1;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  COMMON_FLAGS,
  COMMAND_FLAGS,
  parseArgs,
  printUsage,
  validateCommandFlags,
  resolveRuntime,
  executeCommand,
  main,
};
