'use strict';

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = {
    includeInternal: false,
    json: false,
    limit: 20,
    stateRoot: process.env.MIRA_STATE_ROOT || '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      args.json = true;
    } else if (arg === '--include-internal' || arg === '--internal' || arg === '--debug') {
      args.includeInternal = true;
    } else if (arg === '--limit') {
      args.limit = Number.parseInt(argv[index + 1] || '20', 10) || 20;
      index += 1;
    } else if (arg === '--state-root') {
      args.stateRoot = argv[index + 1] || '';
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else {
      throw Object.assign(new Error(`Unknown argument: ${arg}`), { code: 'unknown_argument' });
    }
  }
  args.limit = Math.max(1, Math.min(100, args.limit));
  return args;
}

function forbiddenRejectedTextKey(key) {
  const normalized = String(key || '').replace(/[_-]/g, '').toLowerCase();
  if (!normalized) return false;
  if (normalized === 'journalstoresrejectedtext' || normalized === 'rejectedtextvisible') return false;
  if (normalized === 'rawreply' || normalized === 'rawoutputtext') return true;
  return /(rejected|raw).*(generated|reply|response|text)|generated.*(rejected|raw).*text/.test(normalized);
}

function stripRejectedTextFields(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => stripRejectedTextFields(item));

  const output = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (forbiddenRejectedTextKey(key)) continue;
    output[key] = stripRejectedTextFields(nestedValue);
  }
  return output;
}

function buildVisibleReplyStatus(record) {
  const visibleReplyGate = record.visible_reply_gate && typeof record.visible_reply_gate === 'object' && !Array.isArray(record.visible_reply_gate)
    ? record.visible_reply_gate
    : null;
  const heldReplyAudit = record.held_reply_audit && typeof record.held_reply_audit === 'object' && !Array.isArray(record.held_reply_audit)
    ? record.held_reply_audit
    : null;
  const held = visibleReplyGate?.held === true || heldReplyAudit?.held === true;
  return {
    checked: visibleReplyGate?.checked === true || heldReplyAudit?.checked === true,
    held,
    reason: held ? 'held_for_visible_reply_quality' : null,
    visibleContentReplaced: heldReplyAudit?.visibleContentReplaced === true,
    rejectedTextVisible: false,
    violationIdsVisible: false,
    diagnosticsVisible: false,
  };
}

function publicJournalRecord(record) {
  const output = stripRejectedTextFields(record);
  delete output.visible_reply_gate;
  delete output.held_reply_audit;
  output.visible_reply_status = buildVisibleReplyStatus(record);
  return output;
}

function isInside(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function readRuntimeTurns(input) {
  if (!input.stateRoot) {
    throw Object.assign(new Error('MIRA_STATE_ROOT or --state-root is required.'), { code: 'missing_state_root' });
  }

  const stateRoot = path.resolve(input.stateRoot);
  if (stateRoot.split(path.sep).includes('.squidrun')) {
    throw Object.assign(new Error('Refusing to read SquidRun-owned .squidrun state as Mira continuity.'), { code: 'unsafe_state_root' });
  }

  const journalPath = path.resolve(stateRoot, 'conversation-evidence', 'runtime-turns.jsonl');
  if (!isInside(stateRoot, journalPath)) {
    throw Object.assign(new Error('Resolved journal path escapes MIRA_STATE_ROOT.'), { code: 'unsafe_journal_path' });
  }

  const records = fs.existsSync(journalPath)
    ? fs.readFileSync(journalPath, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    : [];

  const selectedRecords = records.slice(-input.limit).reverse();

  return {
    ok: true,
    protocol: 'mira.runtime_turn_journal_list.v0',
    path: journalPath,
    count: records.length,
    records: input.includeInternal
      ? selectedRecords.map((record) => stripRejectedTextFields(record))
      : selectedRecords.map((record) => publicJournalRecord(record)),
    external_send: false,
    tools_executed: false,
  };
}

function printText(result) {
  if (result.records.length === 0) {
    console.log('No runtime turns journaled yet.');
    return;
  }
  for (const record of result.records) {
    const model = record.model?.model || (record.model_invoked ? 'model' : 'deterministic');
    console.log(`${record.created_at} ${record.outcome} ${model}`);
    console.log(`prompt: ${record.prompt}`);
    console.log(`reply: ${record.response?.content || record.error?.message || ''}`);
    console.log('');
  }
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log('Usage: node mira/tools/read-runtime-turns.js [--json] [--include-internal] [--limit N] [--state-root PATH]');
      return;
    }
    const result = readRuntimeTurns(args);
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printText(result);
    }
  } catch (error) {
    const payload = {
      ok: false,
      error: {
        code: error.code || 'read_runtime_turns_failed',
        message: error.message || String(error),
      },
    };
    console.error(JSON.stringify(payload, null, 2));
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  buildVisibleReplyStatus,
  parseArgs,
  publicJournalRecord,
  readRuntimeTurns,
  stripRejectedTextFields,
};
