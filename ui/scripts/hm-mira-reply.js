#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const route = require('../modules/mira-core/mira-architect-route-v0');

const PROJECT_ROOT = process.env.SQUIDRUN_PROJECT_ROOT
  || path.resolve(__dirname, '..', '..');
const RUNTIME_DIR = path.join(PROJECT_ROOT, '.squidrun', 'runtime');
const DEFAULT_EVENT_QUEUE_PATH = path.join(RUNTIME_DIR, 'mira-event-queue.jsonl');

function printHelp() {
  process.stdout.write([
    'Usage: hm-mira-reply.js <mira_intent_id> --stdin',
    '       hm-mira-reply.js <mira_intent_id> --text "<reply>"',
    '',
    'Writes a single architect_reply row to the Mira event queue with target_role: "mira"',
    'and sender_role: "architect" (hardcoded — this helper is Architect-only by contract).',
    '',
    'Options:',
    '  --stdin                   Read reply text from stdin.',
    '  --text <reply>            Reply text inline.',
    '  --queue-path <file>       Override event queue JSONL path.',
    '  --lint                    Print Mira visible-reply lint violations to stderr (does not block write).',
    '',
  ].join('\n'));
}

function parseArgs(argv) {
  const args = {
    miraIntentId: null,
    fromStdin: false,
    text: null,
    queuePath: DEFAULT_EVENT_QUEUE_PATH,
    lint: false,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--help' || token === '-h') { printHelp(); process.exit(0); }
    else if (token === '--stdin') args.fromStdin = true;
    else if (token === '--text') args.text = argv[++i];
    else if (token === '--queue-path') args.queuePath = argv[++i];
    else if (token === '--lint') args.lint = true;
    else if (token.startsWith('--')) {
      process.stderr.write(`Unknown flag: ${token}\n`);
      process.exit(2);
    } else {
      positional.push(token);
    }
  }
  if (positional.length > 0) args.miraIntentId = positional[0];
  return args;
}

async function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { buf += chunk; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.miraIntentId) {
    printHelp();
    process.exit(2);
  }
  let replyText = args.text;
  if (args.fromStdin) {
    replyText = (await readStdin());
  }
  const built = route.buildArchitectReplyRow({
    miraIntentId: args.miraIntentId,
    replyText,
  });
  if (!built.ok) {
    process.stderr.write(`Reply build failed: ${built.reason}\n`);
    process.exit(1);
  }
  if (args.lint) {
    const evaluation = route.evaluateMiraVisibleReply(built.row.reply_text);
    if (!evaluation.ok) {
      process.stderr.write(`Lint violations (informational): ${evaluation.violations.join(',')}\n`);
    }
  }
  try {
    route.appendJsonlRow({ filePath: args.queuePath, row: built.row });
  } catch (err) {
    process.stderr.write(`Append failed: ${err && err.message ? err.message : err}\n`);
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    mira_intent_id: built.row.mira_intent_id,
    target_role: built.row.target_role,
    sender_role: built.row.sender_role,
    occurred_at_ms: built.row.occurred_at_ms,
    queue_path: args.queuePath,
  }) + '\n');
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err && err.message ? err.message : err}\n`);
  process.exit(1);
});
