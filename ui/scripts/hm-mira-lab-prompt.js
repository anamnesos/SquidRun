#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = process.env.SQUIDRUN_PROJECT_ROOT
  || path.resolve(__dirname, '..', '..');

try {
  require(path.join(PROJECT_ROOT, 'node_modules', 'dotenv')).config({
    path: path.join(PROJECT_ROOT, '.env'),
  });
} catch (_err) {
  // dotenv optional; without it the model adapter may be unavailable and the
  // surface will return a blocked / degraded decision honestly.
}

const { buildMiraLabPromptReply } = require('../modules/mira-lab-surface');

// MODULE-LEVEL DIAGNOSTIC ONLY.
// This script invokes buildMiraLabPromptReply in-process from Node. It exercises
// the same surface module that the mira:lab-prompt-reply IPC handler invokes
// (gates, audit, transcript), and writes to the same on-disk audit + transcript
// files the running Electron writes to. It does NOT drive the running Electron
// renderer or its IPC channel — outside callers cannot reach the renderer's
// `ipcRenderer.invoke('mira:lab-prompt-reply', ...)` seam without a main-process
// change and an app restart. Use this script to reproduce / diagnose engine,
// gate, and audit behavior; use the in-app Mira Lab window for true renderer
// validation.

function printHelp() {
  process.stdout.write([
    'hm-mira-lab-prompt — module-level diagnostic for the Mira Lab prompt/reply',
    '  surface. NOT a live-renderer driver. Calls buildMiraLabPromptReply in',
    '  this Node process; writes audit + transcript exactly like the IPC',
    '  handler. Use the in-app Mira Lab window for renderer-path validation.',
    '',
    'Usage: hm-mira-lab-prompt.js --prompt "<text>" [options]',
    '       hm-mira-lab-prompt.js --stdin [options]',
    '',
    'Writes a transcript turn pair and an audit row, then prints the requester',
    'envelope and decision JSON. Exit codes: 0=pass 3=fail 4=blocked 1=error.',
    '',
    'Options:',
    '  --prompt <text>           Prompt text (required unless --stdin).',
    '  --stdin                   Read prompt text from stdin.',
    '  --session-id <id>         Lab session id (default: mira-lab-<YYYY-MM-DD>).',
    '  --speaker-role <role>     james|architect|builder|oracle (default: james).',
    '  --requester-pane <pane>   Optional dispatch target pane.',
    '  --project-root <path>     Override project root.',
    '  --json                    Print full decision JSON only.',
    '  --quiet                   Suppress info lines, print envelope on stdout.',
    '',
  ].join('\n'));
}

function parseArgs(argv) {
  const args = {
    prompt: null,
    fromStdin: false,
    sessionId: null,
    speakerRole: 'james',
    requesterPane: null,
    projectRoot: PROJECT_ROOT,
    json: false,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--help' || token === '-h') { printHelp(); process.exit(0); }
    else if (token === '--prompt') args.prompt = argv[++i];
    else if (token === '--stdin') args.fromStdin = true;
    else if (token === '--session-id') args.sessionId = argv[++i];
    else if (token === '--speaker-role') args.speakerRole = argv[++i];
    else if (token === '--requester-pane') args.requesterPane = argv[++i];
    else if (token === '--project-root') args.projectRoot = path.resolve(argv[++i]);
    else if (token === '--json') args.json = true;
    else if (token === '--quiet') args.quiet = true;
    else {
      process.stderr.write(`Unknown flag: ${token}\n`);
      process.exit(2);
    }
  }
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

function defaultSessionId(now = new Date()) {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  return `mira-lab-${yyyy}-${mm}-${dd}`;
}

async function runDriver(rawArgs, deps = {}) {
  const args = typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : parseArgs(rawArgs || []);
  let prompt = args.prompt;
  if (args.fromStdin) {
    prompt = (await (deps.readStdin || readStdin)()).trimEnd();
  }
  const sessionId = args.sessionId || defaultSessionId();
  const builder = deps.buildMiraLabPromptReply || buildMiraLabPromptReply;
  const result = await builder(
    {
      prompt: prompt || '',
      sessionId,
      speakerRole: args.speakerRole,
      requesterPane: args.requesterPane,
    },
    {
      projectRoot: args.projectRoot,
    },
  );
  return { args, sessionId, result };
}

function exitCodeFor(decision) {
  if (decision === 'pass') return 0;
  if (decision === 'fail') return 3;
  return 4;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.prompt && !args.fromStdin) {
    printHelp();
    process.exit(2);
  }
  const { result } = await runDriver(args);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (args.quiet) {
    process.stdout.write(`${result.requester_envelope}\n`);
  } else {
    process.stdout.write(`decision=${result.decision}\n`);
    if (result.gates && result.gates.reason_class) {
      process.stdout.write(`reason_class=${result.gates.reason_class}\n`);
    }
    process.stdout.write(`audit=${result.audit_path}\n`);
    process.stdout.write(`transcript=${result.transcript_path}\n`);
    process.stdout.write(`envelope=${result.requester_envelope}\n`);
    if (result.reply && result.reply.text) {
      process.stdout.write(`reply=${JSON.stringify(result.reply.text)}\n`);
    }
  }
  process.exit(exitCodeFor(result.decision));
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`hm-mira-lab-prompt error: ${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  defaultSessionId,
  runDriver,
  exitCodeFor,
};
