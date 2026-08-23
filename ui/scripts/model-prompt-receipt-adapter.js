#!/usr/bin/env node

const {
  appendModelPromptReceipt,
  appendTrustCheckBreadcrumb,
  installModelPromptReceiptHooks,
} = require('../modules/model-prompt-receipt');

/**
 * TELEGRAM ADMISSION LIVES HERE BECAUSE THIS FILE IS THE ONE THAT RUNS.
 *
 * `.codex/hooks.json` and `.claude/settings.json` both invoke this adapter and
 * only this adapter. A separate `telegram-consumer-receipt-adapter.js` was
 * hardened over two checkpoints while no configured hook could reach it, so its
 * guards defended nothing. Folding the production in here — rather than adding
 * a second hook definition — keeps the set of things that run and the set of
 * things that are tested identical.
 */
const {
  produceAdmissionReceipt,
  produceTerminalReceipt,
  bindSessionAtStart,
  isTerminalHookEvent,
} = require('../modules/main/telegram-admission-producer');
const hookLogger = require('../modules/logger');

// stdout is the hook protocol channel, not a console. The shared logger sends
// info/debug messages to stdout, so a perfectly valid JSON acknowledgement can
// become invalid the moment a dependency opens the Evidence Ledger and logs
// its selected SQLite driver. Keep warnings/errors on stderr while this
// short-lived adapter runs; only emitHookResponse may write to stdout.
hookLogger.setLevel('warn');

function parseArgs(argv) {
  const parsed = {
    command: null,
    runtime: null,
    event: null,
    projectRoot: null,
    trustCheckOnly: false,
  };
  if (argv[0] && !argv[0].startsWith('--')) {
    parsed.command = argv[0];
    argv = argv.slice(1);
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--runtime') {
      parsed.runtime = argv[index + 1] || null;
      index += 1;
    } else if (arg === '--event' || arg === '--hook-event') {
      parsed.event = argv[index + 1] || null;
      index += 1;
    } else if (arg === '--project-root') {
      parsed.projectRoot = argv[index + 1] || null;
      index += 1;
    } else if (arg === '--trust-check-only') {
      parsed.trustCheckOnly = true;
    }
  }
  return parsed;
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.resume();
  });
}

function parsePayload(raw) {
  if (!raw || !raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (_err) {
    return { prompt: raw };
  }
}

function normalizeRuntime(value) {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null;
}

/**
 * NEVER LET THE TELEGRAM LANE WEDGE A PROMPT.
 *
 * This adapter sits in front of every prompt James types. A throw here — a
 * locked database, a missing table on an older build — would block the pane,
 * and a hook that fails a prompt is a worse bug than a missing receipt. The
 * admission path fails CLOSED on its own record (no receipt is written on
 * partial information) while failing OPEN for the user.
 */
function runTelegramStep(step) {
  try {
    return step();
  } catch (err) {
    try {
      process.stderr.write(`[model-prompt-receipt-adapter] telegram_admission_error: ${err.message}\n`);
    } catch { /* stderr is best-effort inside a hook */ }
    return null;
  }
}

/**
 * THE OUTCOME OF THE TELEGRAM STEP, WRITTEN DOWN.
 *
 * It used to be returned and dropped on the floor. That mattered most for the
 * one case we already know about: `produceTerminalReceipt` refuses Claude with
 * `terminal_claude_submission_id_unsupported` — a correct, deliberate refusal —
 * and the adapter discarded it and emitted the generic receipt status. So a
 * runtime that CANNOT produce terminal proof looked exactly like one that
 * simply had not yet, and the only evidence a hook had run at all was a
 * debugging breadcrumb that proves invocation, not outcome.
 *
 * Append-only, one line, best-effort, and never in the prompt's way: a hook
 * that fails a prompt is a worse bug than a missing diagnostic. Nothing here
 * decides anything — it exists so health can say "this runtime refuses" out
 * loud instead of everyone inferring silence.
 */
function recordTelegramStepOutcome(phase, runtime, outcome) {
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    const { resolveCoordPath } = require('../config');
    const target = resolveCoordPath(
      path.join('runtime', 'telegram-step-outcomes.jsonl'),
      { forWrite: true }
    );
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, `${JSON.stringify({
      atMs: Date.now(),
      phase,
      runtime: runtime || null,
      // `handled` distinguishes "this was not a Telegram delivery" — the
      // overwhelming majority — from "it was, and here is what happened".
      handled: outcome?.handled === true,
      ok: outcome?.ok === true,
      written: outcome?.written === true,
      reason: typeof outcome?.reason === 'string' ? outcome.reason : null,
    })}\n`, 'utf8');
  } catch { /* diagnostics never block a prompt */ }
}

function buildHookResponse(result = {}) {
  const runtime = normalizeRuntime(result.runtime);
  const hookEventName = typeof result.hookEventName === 'string'
    ? result.hookEventName.trim()
    : '';

  // Codex validates Stop output against a different contract than its other
  // hook events. `hookSpecificOutput` is valid for SessionStart and
  // UserPromptSubmit, but Codex 0.149 rejects that shape for Stop. Keep the
  // shared adapter's existing response for every other runtime/event and emit
  // the exact fail-open Stop acknowledgement Codex accepts here.
  if (runtime === 'codex' && hookEventName.toLowerCase() === 'stop') {
    return { continue: true };
  }

  return {
    hookSpecificOutput: {
      hookEventName: result.error === true ? undefined : (hookEventName || undefined),
    },
  };
}

function emitHookResponse(result = {}) {
  const response = buildHookResponse(result);
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

async function main(args = parseArgs(process.argv.slice(2))) {
  // DIAGNOSTIC BREADCRUMB (S468 receipt-store silence): prove whether the
  // pane hook EXECUTES and what payload shape it receives. Remove after the
  // silent-skip class is diagnosed.
  try {
    const fsDbg = require('fs');
    fsDbg.appendFileSync(
      'D:/squidrun-tmp/receipt-adapter-breadcrumbs.log',
      `${new Date().toISOString()} argv=${JSON.stringify(process.argv.slice(2))} stdinTTY=${process.stdin.isTTY === true}\n`,
      'utf8'
    );
  } catch { /* diagnostics never break the hook */ }
  if (args.command === 'install') {
    const result = installModelPromptReceiptHooks({ projectRoot: args.projectRoot || process.cwd() });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  const raw = await readStdin();
  const payload = parsePayload(raw);
  try {
    const fsDbg = require('fs');
    fsDbg.appendFileSync(
      'D:/squidrun-tmp/receipt-adapter-breadcrumbs.log',
      `${new Date().toISOString()} payloadKeys=${JSON.stringify(Object.keys(payload || {}))} hasMarker=${String(payload.prompt || '').includes('[SQUIDRUN_RECEIPT')}\n`,
      'utf8'
    );
  } catch { /* diagnostics never break the hook */ }

  if (args.trustCheckOnly) {
    const record = appendTrustCheckBreadcrumb({ payload });
    // SESSIONSTART ALSO BINDS THE RUNTIME SESSION TO ITS PANE LAUNCH. Without
    // this the launch registry has no session rows and every admission receipt
    // written later has nothing to attach itself to.
    const bound = runTelegramStep(() => bindSessionAtStart({
      runtime: normalizeRuntime(args.runtime),
      payload,
    }));
    recordTelegramStepOutcome('session_bind', normalizeRuntime(args.runtime), bound);
    emitHookResponse({ runtime: args.runtime, hookEventName: args.event, record });
    return;
  }

  const result = appendModelPromptReceipt({
    runtime: args.runtime,
    hookEventName: args.event,
    payload,
  });

  // TELEGRAM, PHASE 2: THE TURN ENDED.
  //
  // In this file for the same reason phase 1 is — it is the adapter the
  // configured hooks actually invoke. A separate terminal adapter would be the
  // fourth instance of the shape this lane keeps producing: a component
  // hardened over checkpoints that no configured hook could reach, with a green
  // suite proving only that the unreachable side works.
  //
  // Terminal runs INSTEAD of admission, not alongside it. A Stop payload
  // carries no prompt, so the admission path would parse no marker and return
  // `not_a_telegram_delivery` — harmless, but it would make the two phases look
  // like one path that sometimes does nothing, which is precisely the ambiguity
  // the split exists to remove.
  if (isTerminalHookEvent(args.event)) {
    // CAPTURED, NOT DISCARDED. `produceTerminalReceipt` refuses Claude with
    // `terminal_claude_submission_id_unsupported`; that refusal is the answer
    // to "can this runtime prove consumption at all", and it used to be thrown
    // away one line after being computed.
    const outcome = runTelegramStep(() => produceTerminalReceipt({
      runtime: normalizeRuntime(args.runtime),
      payload,
    }));
    recordTelegramStepOutcome('terminal', normalizeRuntime(args.runtime), outcome);
  } else {
    // TELEGRAM ADMISSION. Returns `handled:false` for the overwhelming majority
    // of prompts, which are not Telegram deliveries.
    const outcome = runTelegramStep(() => produceAdmissionReceipt({
      runtime: normalizeRuntime(args.runtime),
      payload,
    }));
    recordTelegramStepOutcome('admission', normalizeRuntime(args.runtime), outcome);
  }

  emitHookResponse({
    runtime: args.runtime,
    hookEventName: args.event,
    status: result.status,
  });
}

const startupArgs = parseArgs(process.argv.slice(2));

main(startupArgs).catch((err) => {
  process.stderr.write(`[model-prompt-receipt-adapter] ${err.stack || err.message}\n`);
  emitHookResponse({
    runtime: startupArgs.runtime,
    hookEventName: startupArgs.event,
    status: 'adapter_error',
    error: true,
  });
  process.exitCode = 0;
});
