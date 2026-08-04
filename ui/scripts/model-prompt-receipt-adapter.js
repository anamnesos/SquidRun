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

function emitHookResponse(result = {}) {
  const response = {
    hookSpecificOutput: {
      hookEventName: result.hookEventName || undefined,
    },
  };
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
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
    runTelegramStep(() => bindSessionAtStart({
      runtime: normalizeRuntime(args.runtime),
      payload,
    }));
    emitHookResponse({ hookEventName: args.event, record });
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
    runTelegramStep(() => produceTerminalReceipt({
      runtime: normalizeRuntime(args.runtime),
      payload,
    }));
  } else {
    // TELEGRAM ADMISSION. Returns `handled:false` for the overwhelming majority
    // of prompts, which are not Telegram deliveries.
    runTelegramStep(() => produceAdmissionReceipt({
      runtime: normalizeRuntime(args.runtime),
      payload,
    }));
  }

  emitHookResponse({
    hookEventName: args.event,
    status: result.status,
  });
}

main().catch((err) => {
  process.stderr.write(`[model-prompt-receipt-adapter] ${err.stack || err.message}\n`);
  emitHookResponse({ hookEventName: null, status: 'adapter_error' });
  process.exitCode = 0;
});
