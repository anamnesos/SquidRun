#!/usr/bin/env node
/**
 * THE CONSUMER-SIDE PRODUCER. This is the thing that writes consumption proof.
 *
 * It runs as the runtime's own UserPromptSubmit-equivalent hook, INSIDE the
 * process that is about to consume the prompt. That is what makes it a
 * consumer boundary rather than another sender claiming success: it reports the
 * exact bytes the model received, and nothing upstream gets to speak for it.
 *
 *   node ui/scripts/telegram-consumer-receipt-adapter.js --runtime codex
 *   node ui/scripts/telegram-consumer-receipt-adapter.js --runtime claude
 *
 * RUNTIME-NEUTRAL BY SCHEMA, NOT BY PRODUCER. Each runtime hands its hook a
 * differently shaped stdin payload, so a single universal producer is not
 * possible — and the one component that DOES see every delivery (the PTY
 * layer) is exactly what certified 2417 bytes for a 125-character tail. So the
 * per-runtime part is confined to `extractPrompt`/`extractSession` below, a few
 * lines each, and everything after that is shared. Claude and Codex emit
 * byte-identical proof shapes; a new runtime adds one small extractor.
 *
 * FAIL CLOSED, AND LOUDLY. Every refusal is written to the sink as a
 * `skipped` line with a reason. That is deliberate and it is the S491 lesson:
 * the Codex receipt adapter was declared in .codex/hooks.json, was never
 * trusted in config.toml, ran zero times, and produced SILENCE — which every
 * layer downstream read as "this runtime cannot prove consumption". An adapter
 * that never fires must be distinguishable from a runtime that cannot prove.
 * A hook that runs and refuses says so; a hook that never runs says nothing,
 * and now that difference is visible in the sink.
 *
 * It NEVER blocks the prompt: it exits 0 on every path, including its own
 * internal errors. A proof producer that can wedge the pane it observes would
 * be a worse bug than the one it exists to fix.
 */
const fs = require('node:fs');
const path = require('node:path');

const { buildConsumedProof } = require('../modules/main/telegram-consumed-proof');
const { parseConsumeMarker } = require('../modules/main/telegram-consume-marker');

function parseArgs(argv) {
  const args = { runtime: null, sink: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--runtime') args.runtime = argv[++i];
    else if (argv[i] === '--sink') args.sink = argv[++i];
  }
  return args;
}

function defaultSink(env = process.env) {
  const explicit = env.SQUIDRUN_TG_CONSUME_SINK;
  if (explicit && explicit.trim()) return explicit.trim();
  const root = env.CLAUDE_PROJECT_DIR || env.SQUIDRUN_PROJECT_ROOT || process.cwd();
  return path.join(root, '.squidrun', 'runtime', 'telegram-consumed', 'consumed.jsonl');
}

/** The ONLY per-runtime knowledge in this file. */
function extractPrompt(runtime, payload) {
  if (!payload || typeof payload !== 'object') return null;
  // Both Claude's and Codex's UserPromptSubmit deliver the exact prompt under
  // `prompt`. Kept as an explicit switch anyway so a runtime that differs gets
  // an entry here rather than a silent undefined.
  switch (runtime) {
    case 'claude':
    case 'codex':
      return typeof payload.prompt === 'string' ? payload.prompt : null;
    default:
      return null;
  }
}

function extractSession(runtime, payload) {
  const p = payload || {};
  switch (runtime) {
    case 'codex':
      return { sessionId: p.session_id || null, turnId: p.turn_id || null };
    case 'claude':
      return { sessionId: p.session_id || p.sessionId || null, turnId: p.turn_id || p.turnId || null };
    default:
      return { sessionId: null, turnId: null };
  }
}

function writeLine(sink, record) {
  fs.mkdirSync(path.dirname(sink), { recursive: true });
  fs.appendFileSync(sink, `${JSON.stringify(record)}\n`, 'utf8');
}

/**
 * @returns {{written: boolean, reason: string, record: object|null}}
 */
function processHookPayload(input = {}) {
  const { runtime, payload, env = process.env, sink, nowMs = Date.now() } = input;
  const target = sink || defaultSink(env);

  const skip = (reason, extra = {}) => {
    const record = {
      schema: 'telegram_consumed.skipped.v1',
      reason,
      runtime: runtime || null,
      at: new Date(nowMs).toISOString(),
      ...extra,
    };
    try {
      writeLine(target, record);
    } catch {
      // Even the refusal could not be recorded. Nothing further is safe to do
      // from inside a hook, and exiting nonzero would block the user's prompt.
    }
    return { written: false, reason, record };
  };

  if (!runtime) return skip('no_runtime');

  const prompt = extractPrompt(runtime, payload);
  if (prompt === null) return skip('no_prompt_in_payload');

  const marker = parseConsumeMarker(prompt);
  // NOT a refusal worth recording: the overwhelming majority of prompts are not
  // Telegram deliveries, and logging every one would bury the real refusals.
  if (!marker) return { written: false, reason: 'not_a_telegram_delivery', record: null };

  // PANE BINDING, fail closed. Same-CWD Codex sessions run in panes 1 and 3, so
  // a receipt that cannot name its own pane cannot be attributed to a route.
  // Inferring it from CWD or the newest session is exactly what the gate forbids.
  const paneId = (env.SQUIDRUN_PANE_ID || '').trim();
  if (!paneId) return skip('no_pane_binding', { updateId: marker.updateId });

  const { sessionId, turnId } = extractSession(runtime, payload);
  if (!sessionId) return skip('no_consumer_session', { updateId: marker.updateId, paneId });

  const record = buildConsumedProof({
    runtime,
    updateId: marker.updateId,
    messageId: marker.messageId,
    routeKey: marker.routeKey,
    windowKey: marker.windowKey,
    profile: marker.profile,
    chatId: marker.chatId,
    appGeneration: marker.appGeneration,
    queuedPayloadSha256: marker.queuedPayloadSha256,
    consumerSessionId: sessionId,
    consumerTurnId: turnId,
    paneId,
    // THE EXACT BYTES THIS CONSUMER RECEIVED. Not what the sender believes it
    // wrote — that claim is what acked a 125-character tail as 2283 bytes.
    deliveredPrompt: prompt,
    consumedAtMs: nowMs,
  });

  try {
    writeLine(target, record);
  } catch (err) {
    return { written: false, reason: `sink_write_failed:${err.message}`, record };
  }
  return { written: true, reason: 'recorded', record };
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  let payload = null;
  try {
    payload = JSON.parse(readStdin() || '{}');
  } catch {
    payload = null;
  }
  processHookPayload({
    runtime: (args.runtime || '').trim().toLowerCase() || null,
    payload,
    sink: args.sink,
  });
  // ALWAYS 0. A hook that fails a prompt is worse than a missing receipt.
  process.exitCode = 0;
}

if (require.main === module) main();

module.exports = { processHookPayload, extractPrompt, extractSession, defaultSink, parseArgs };
