/**
 * THE TERMINAL PRODUCER, EXECUTED — not inspected, not mocked, not grepped.
 *
 * =====================================================================
 * WHY THIS FILE HAD TO EXIST
 * =====================================================================
 * `produceTerminalReceipt` is the only function in the system that can write
 * the only row that can retire a Telegram record. It shipped calling
 * `buildConsumedRecord` without importing it, so the moment a Stop payload
 * actually matched an admission it threw ReferenceError — and from the queue's
 * side a throw there is indistinguishable from a turn that never proved
 * anything. Eight and a half hours of "patience" is what that looks like.
 *
 * Every test it already had stopped BEFORE that line: they end at
 * `no_telegram_admission_for_turn`, at a missing launch binding, or at the
 * Claude submission-id refusal. The happy path — a real marker, a real claim, a
 * real admission receipt, then a real Stop for that exact turn — had never once
 * been run. That is the born-blind seam in its purest form: a producer nobody
 * had ever watched produce.
 *
 * So this drives the WHOLE chain on a temp ledger: the real admission sequence
 * mints the marked bytes, the real admission producer parses them back, the
 * real terminal producer promotes them, and the real drain-side lookup reads
 * the result. No step is stubbed. If any link is undefined, misnamed, or
 * unreachable, this goes red instead of the queue going quiet.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { TelegramAdmissionWriter } = require('../modules/main/telegram-admission-writer');
const { applyTelegramAdmissionSchema } = require('../modules/main/telegram-admission-store');
const {
  ENV_LAUNCH_ID,
  generateLaunchId,
  recordPaneLaunch,
  bindConsumerSession,
  completePaneLaunch,
} = require('../modules/main/telegram-launch-registry');
const { runTelegramAdmissionSequence, MODES } = require('../modules/main/telegram-admission-sequence');
const {
  produceAdmissionReceipt,
  produceTerminalReceipt,
} = require('../modules/main/telegram-admission-producer');
const { findTerminalConsumptionEvidence } = require('../modules/main/telegram-terminal-lookup');
const { evaluateConsumptionProof } = require('../modules/main/telegram-consumption-proof');

const GENERATION = 'app-terminal-exec-1';
const UPDATE_ID = 909100501;
const MESSAGE_ID = `telegram-in-${UPDATE_ID}`;
const CHAT_ID = REDACTED;
const NOW = 1785870000000;

let tempRoot = null;
let dbPath = null;

function newWriter() {
  return new TelegramAdmissionWriter({ dbPath });
}

/** One open handle for direct setup/assertion reads. */
function withDb(fn) {
  const writer = newWriter();
  const opened = writer.open();
  if (!opened.ok) throw new Error(`writer open failed: ${JSON.stringify(opened)}`);
  try {
    return fn(writer.db);
  } finally {
    writer.close();
  }
}

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-terminal-exec-'));
  dbPath = path.join(tempRoot, 'ledger.db');
});

afterEach(() => {
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = null;
  dbPath = null;
});

/** A completed pane launch plus its bound consumer session, on this ledger. */
function seedLaunch(sessionId) {
  return withDb((db) => {
    const applied = applyTelegramAdmissionSchema(db);
    expect(applied.ok).toBe(true);
    const launchId = generateLaunchId();
    expect(recordPaneLaunch(db, {
      launchId,
      appGeneration: GENERATION,
      paneId: '1',
      role: 'architect',
      consumerRuntime: 'codex',
      daemonProcessId: '4242',
      launchedAtMs: NOW - 5000,
    }).ok).toBe(true);
    expect(bindConsumerSession(db, {
      consumerSessionId: sessionId,
      launchId,
      consumerRuntime: 'codex',
      boundAtMs: NOW - 4000,
    }).ok).toBe(true);
    expect(completePaneLaunch(db, { launchId, atMs: NOW - 3500 }).ok).toBe(true);
    return launchId;
  });
}

/** The REAL A-B-C-D sequence. Its `authorized.text` is what a pane receives. */
async function runSequence() {
  const writer = newWriter();
  const opened = writer.open();
  expect(opened.ok).toBe(true);
  try {
    return await runTelegramAdmissionSequence({
      db: writer.db,
      job: {
        messageId: MESSAGE_ID,
        updateId: UPDATE_ID,
        chatId: CHAT_ID,
        routeKey: 'main',
        profile: 'main',
        windowKey: 'main',
        rawBody: 'terminal execution body',
        sessionId: 'app-session-490',
        sentAtMs: NOW - 1000,
      },
      // This chain exists to prove a terminal receipt CAN come back, so the
      // pane it delivers to is by definition one with observed proof flow.
      paneReadiness: () => ({
        attainable: true, reason: 'runtime_proof_observed', runtime: 'codex', lastProofAtMs: NOW - 5000,
      }),
      record: {
        updateId: UPDATE_ID,
        chatId: CHAT_ID,
        text: 'terminal execution body',
        from: 'james',
        targetSession: 'app-session-490',
      },
      appGeneration: GENERATION,
      paneId: '1',
      role: 'architect',
      obligorAddress: 'architect',
      mode: MODES.FULL,
      composeFinalBody: async () => '[Telegram from james]: terminal execution body',
      now: () => NOW,
      nonce: () => 'n_terminal_exec',
    });
  } finally {
    writer.close();
  }
}

describe('the terminal receipt path, driven end to end', () => {
  test('a Stop for the admitted turn writes a consumed receipt the drain can read', async () => {
    const sessionId = 'codex-session-terminal-exec';
    const launchId = seedLaunch(sessionId);

    const admission = await runSequence();
    expect(admission.ok).toBe(true);
    expect(admission.stage).toBe('D_delivery_started');
    const prompt = admission.authorized.text;

    const env = {
      SQUIDRUN_PANE_ID: '1',
      SQUIDRUN_ROLE: 'architect',
      [ENV_LAUNCH_ID]: launchId,
    };

    // PHASE 1. The consumer parses back the marker the sequence appended.
    const admitted = produceAdmissionReceipt({
      runtime: 'codex',
      payload: { prompt, session_id: sessionId, turn_id: 'turn-terminal-exec' },
      env,
      nowMs: NOW + 30,
      writerFactory: () => newWriter(),
      hookProcessId: '9001',
      hookParentProcessId: '9000',
    });
    expect(admitted).toEqual(expect.objectContaining({ ok: true, written: true }));

    // PHASE 2. THE LINE THAT USED TO THROW. Reaching an assertion past here at
    // all is the regression this file exists for.
    const terminal = produceTerminalReceipt({
      runtime: 'codex',
      payload: { session_id: sessionId, turn_id: 'turn-terminal-exec' },
      env,
      nowMs: NOW + 60,
      writerFactory: () => newWriter(),
      // SAME PANE DAEMON, DIFFERENT HOOK INVOCATION. The parent must match the
      // admission hook's parent — both fire inside the one pane process tree,
      // and a terminal write from somewhere else is exactly what the producer
      // refuses. Only the hook's own process id differs.
      hookProcessId: '9101',
      hookParentProcessId: '9000',
    });
    expect(terminal).toEqual(expect.objectContaining({ ok: true, written: true }));

    // The row exists, and it carries the TERMINAL hook's own process id rather
    // than reusing the admission hook's — the borrowed-identity shape the two
    // separate columns exist to close.
    const stored = withDb((db) => db.prepare(`
      SELECT admission_id, terminal_event, terminal_hook_process_id,
             terminal_hook_parent_process_id, app_generation, terminal_at_ms
      FROM telegram_consumed_receipts
    `).all());
    expect(stored).toHaveLength(1);
    expect(stored[0]).toEqual(expect.objectContaining({
      terminal_event: 'turn_completed',
      terminal_hook_process_id: '9101',
      terminal_hook_parent_process_id: '9000',
      app_generation: GENERATION,
    }));

    // AND THE DRAIN CAN ACTUALLY USE IT. A row nobody's lookup can read would
    // be the same wedge one table over.
    const evidence = findTerminalConsumptionEvidence({
      messageId: MESSAGE_ID,
      routeKey: 'main',
      dbPath,
    });
    expect(evidence).toEqual(expect.objectContaining({
      status: 'delivered.verified',
      verified: true,
      messageId: MESSAGE_ID,
      routeKey: 'main',
      generation: GENERATION,
    }));
    expect(Number(evidence.provedAtMs)).toBeGreaterThan(0);

    // THE STRICT GATE, against the attempt this delivery actually made. This is
    // the assertion that would have exposed the whole wedge: before the terminal
    // producer could run, no input existed that made this return proven:true.
    const verdict = evaluateConsumptionProof({
      evidence,
      expected: {
        messageId: MESSAGE_ID,
        routeKey: 'main',
        windowKey: 'main',
        profile: 'main',
        chatId: CHAT_ID,
        generation: GENERATION,
      },
      attempt: { atMs: NOW, generation: GENERATION },
    });
    expect(verdict.proven).toBe(true);
  });

  test('a Stop for a turn with no Telegram admission writes nothing and is not an error', async () => {
    const sessionId = 'codex-session-terminal-exec';
    const launchId = seedLaunch(sessionId);

    const terminal = produceTerminalReceipt({
      runtime: 'codex',
      payload: { session_id: sessionId, turn_id: 'turn-unrelated' },
      env: { [ENV_LAUNCH_ID]: launchId },
      nowMs: NOW + 60,
      writerFactory: () => newWriter(),
      // SAME PANE DAEMON, DIFFERENT HOOK INVOCATION. The parent must match the
      // admission hook's parent — both fire inside the one pane process tree,
      // and a terminal write from somewhere else is exactly what the producer
      // refuses. Only the hook's own process id differs.
      hookProcessId: '9101',
      hookParentProcessId: '9000',
    });
    expect(terminal.handled).toBe(false);
    expect(terminal.reason).toBe('no_telegram_admission_for_turn');
    expect(withDb((db) => db.prepare('SELECT COUNT(*) AS n FROM telegram_consumed_receipts').get().n))
      .toBe(0);
  });
});
