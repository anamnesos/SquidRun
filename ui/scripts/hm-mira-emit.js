#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const route = require('../modules/mira-core/mira-architect-route-v0');

const PROJECT_ROOT = process.env.SQUIDRUN_PROJECT_ROOT
  || path.resolve(__dirname, '..', '..');
const RUNTIME_DIR = path.join(PROJECT_ROOT, '.squidrun', 'runtime');
const DEFAULT_PENDING_PATH = path.join(RUNTIME_DIR, 'mira-pending-intents.jsonl');
const DEFAULT_EVENT_QUEUE_PATH = path.join(RUNTIME_DIR, 'mira-event-queue.jsonl');
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_POLL_INTERVAL_MS = 750;

function printHelp() {
  process.stdout.write([
    'Usage: hm-mira-emit.js <intent text>',
    '       hm-mira-emit.js --stdin',
    '       hm-mira-emit.js --intent-file <path>',
    '',
    'Options:',
    '  --timeout <ms>            Reply wait timeout (default 30000).',
    '  --poll-interval <ms>      Event-queue poll interval (default 750).',
    '  --pending-path <file>     Override pending JSONL path.',
    '  --event-queue-path <file> Override event queue JSONL path.',
    '  --profile <name>          Mira profile (default "main").',
    '  --window-key <key>        Mira window key (default "main").',
    '  --session-id <id>         Mira session id.',
    '  --device-id <id>          Mira device id (default "VIGIL").',
    '  --dry-run                 Build envelope, validate, write pending row, but do not send.',
    '',
  ].join('\n'));
}

function parseArgs(argv) {
  const args = {
    intentText: null,
    fromStdin: false,
    intentFile: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    pendingPath: DEFAULT_PENDING_PATH,
    eventQueuePath: DEFAULT_EVENT_QUEUE_PATH,
    profile: 'main',
    windowKey: 'main',
    sessionId: null,
    deviceId: 'VIGIL',
    dryRun: false,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--help' || token === '-h') { printHelp(); process.exit(0); }
    else if (token === '--stdin') args.fromStdin = true;
    else if (token === '--intent-file') args.intentFile = argv[++i];
    else if (token === '--timeout') args.timeoutMs = Number(argv[++i]);
    else if (token === '--poll-interval') args.pollIntervalMs = Number(argv[++i]);
    else if (token === '--pending-path') args.pendingPath = argv[++i];
    else if (token === '--event-queue-path') args.eventQueuePath = argv[++i];
    else if (token === '--profile') args.profile = argv[++i];
    else if (token === '--window-key') args.windowKey = argv[++i];
    else if (token === '--session-id') args.sessionId = argv[++i];
    else if (token === '--device-id') args.deviceId = argv[++i];
    else if (token === '--dry-run') args.dryRun = true;
    else if (token.startsWith('--')) {
      process.stderr.write(`Unknown flag: ${token}\n`);
      process.exit(2);
    } else {
      positional.push(token);
    }
  }
  if (positional.length > 0) args.intentText = positional.join(' ');
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

function writeTempEnvelopeFile(envelope) {
  const tmp = path.join(os.tmpdir(), `mira-intent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
  const body = `(MIRA #intent ${envelope.mira_intent_id}): ${envelope.content}\n\n`
    + `[mira_intent_id=${envelope.mira_intent_id}] reply route: append a JSONL row to .squidrun/runtime/mira-event-queue.jsonl with `
    + `{"mira_intent_id":"${envelope.mira_intent_id}","kind":"architect_reply","target_role":"mira","sender_role":"architect","reply_text":"<your reply>","occurred_at_ms":<Date.now()>}\n`
    + `Note: target_role must equal "mira" — rows missing or mistargeting that field are ignored by the Mira listener.\n`;
  fs.writeFileSync(tmp, body, 'utf8');
  return tmp;
}

function spawnHmSendArchitect(envelopeFilePath) {
  return new Promise((resolve) => {
    const hmSendPath = path.join(__dirname, 'hm-send.js');
    const child = spawn(process.execPath, [hmSendPath, 'architect', '--file', envelopeFilePath, '--role', 'mira'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.on('error', (err) => resolve({ code: -1, stdout, stderr: stderr + err.message }));
  });
}

function nowMs() { return Date.now(); }

async function pollForReply({ envelope, eventQueuePath, timeoutMs, pollIntervalMs, fsImpl }) {
  const started = nowMs();
  while (nowMs() - started < timeoutMs) {
    const rows = route.readJsonlRows({ filePath: eventQueuePath, fsImpl });
    const reply = route.findMiraReplyEvent({ rows, miraIntentId: envelope.mira_intent_id });
    if (reply) return { ok: true, reply };
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  return { ok: false, reason: 'timeout' };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.fromStdin) {
    args.intentText = (await readStdin()).trim();
  } else if (args.intentFile) {
    args.intentText = fs.readFileSync(args.intentFile, 'utf8').trim();
  }
  if (!args.intentText) {
    printHelp();
    process.exit(2);
  }

  const built = route.buildMiraIntentEnvelope({
    intentText: args.intentText,
    sessionId: args.sessionId,
    profile: args.profile,
    windowKey: args.windowKey,
    deviceId: args.deviceId,
  });
  if (!built.ok) {
    process.stderr.write(`Envelope build failed: ${built.reason}\n`);
    process.exit(1);
  }
  const shape = route.validateMiraEnvelopeShape(built.envelope);
  if (!shape.ok) {
    process.stderr.write(`Envelope shape invalid: ${shape.reason}\n`);
    process.exit(1);
  }

  const emittedRow = {
    mira_intent_id: built.envelope.mira_intent_id,
    kind: 'emitted',
    occurred_at_ms: nowMs(),
    envelope: built.envelope,
  };
  route.appendJsonlRow({ filePath: args.pendingPath, row: emittedRow });

  if (args.dryRun) {
    process.stdout.write(JSON.stringify({
      mira_intent_id: built.envelope.mira_intent_id,
      kind: 'dry_run',
      envelope: built.envelope,
    }) + '\n');
    process.exit(0);
  }

  const tmpFile = writeTempEnvelopeFile(built.envelope);
  let sendResult;
  try {
    sendResult = await spawnHmSendArchitect(tmpFile);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) { /* ignore */ }
  }
  if (sendResult.code !== 0) {
    const failedRow = {
      mira_intent_id: built.envelope.mira_intent_id,
      kind: 'failed',
      occurred_at_ms: nowMs(),
      reason: 'hm_send_architect_failed',
      hm_send_stderr: sendResult.stderr,
      hm_send_stdout: sendResult.stdout,
    };
    route.appendJsonlRow({ filePath: args.pendingPath, row: failedRow });
    process.stdout.write(JSON.stringify({
      mira_intent_id: built.envelope.mira_intent_id,
      kind: 'failed',
      reason: 'hm_send_architect_failed',
    }) + '\n');
    process.exit(1);
  }

  const polled = await pollForReply({
    envelope: built.envelope,
    eventQueuePath: args.eventQueuePath,
    timeoutMs: args.timeoutMs,
    pollIntervalMs: args.pollIntervalMs,
  });

  if (!polled.ok) {
    const timeoutRow = {
      mira_intent_id: built.envelope.mira_intent_id,
      kind: 'timeout',
      occurred_at_ms: nowMs(),
      timeout_ms: args.timeoutMs,
    };
    route.appendJsonlRow({ filePath: args.pendingPath, row: timeoutRow });
    process.stdout.write(JSON.stringify({
      mira_intent_id: built.envelope.mira_intent_id,
      kind: 'timeout',
      timeout_ms: args.timeoutMs,
    }) + '\n');
    process.exit(0);
  }

  const evaluation = route.evaluateMiraVisibleReply(polled.reply.reply_text || '');
  const resolutionKind = evaluation.ok ? 'resolved' : 'failed';
  const resolutionRow = {
    mira_intent_id: built.envelope.mira_intent_id,
    kind: resolutionKind,
    occurred_at_ms: nowMs(),
    reply_text: evaluation.text,
    contract_pass: evaluation.ok,
    violations: evaluation.violations,
    reason: evaluation.ok ? undefined : 'language_gate_failed',
  };
  route.appendJsonlRow({ filePath: args.pendingPath, row: resolutionRow });
  process.stdout.write(JSON.stringify({
    mira_intent_id: built.envelope.mira_intent_id,
    kind: resolutionKind,
    contract_pass: evaluation.ok,
    violations: evaluation.violations,
    reply_text: evaluation.text,
    reason: evaluation.ok ? undefined : 'language_gate_failed',
  }) + '\n');
  process.exit(evaluation.ok ? 0 : 3);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err && err.message ? err.message : err}\n`);
  process.exit(1);
});
