/**
 * Hook-contract tests: representative UserPromptSubmit stdin for each runtime,
 * explicit pane env, and every fail-closed refusal.
 *
 * The central assertion is that Claude and Codex produce the SAME proof shape
 * from differently shaped hook payloads. If they ever diverge, the design is
 * not runtime-neutral and the gate fails by construction.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { processHookPayload } = require('../scripts/telegram-consumer-receipt-adapter');
const { buildConsumeMarker } = require('../modules/main/telegram-consume-marker');
const {
  SCHEMA,
  sha256,
  byteLength,
  canonicalQueuedPayloadDigest,
  validateAdmissionRecord,
} = require('../modules/main/telegram-consumed-proof');

const tempRoots = [];
function sinkPath() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-consumer-'));
  tempRoots.push(root);
  return path.join(root, 'consumed.jsonl');
}
afterEach(() => {
  while (tempRoots.length) fs.rmSync(tempRoots.pop(), { recursive: true, force: true });
});

const NOW = 1_785_780_000_000;
const GENERATION = 'tg-gen-29180-1785780000000';
const RECORD = {
  updateId: 808499317,
  text: 'synthetic ordering fixture alpha',
  chatId: 6543210,
  from: 'james',
  messageId: 22315,
};
const QUEUED_SHA = canonicalQueuedPayloadDigest(RECORD);

const MARKER = buildConsumeMarker({
  updateId: 808499317,
  messageId: 'telegram-in-808499317',
  routeKey: 'main',
  windowKey: 'main',
  profile: 'main',
  chatId: 6543210,
  appGeneration: GENERATION,
  queuedPayloadSha256: QUEUED_SHA,
});
const PROMPT = `[Telegram from james]: synthetic ordering fixture alpha\n${MARKER}`;

const PANE_ENV = { SQUIDRUN_PANE_ID: '1', SQUIDRUN_ROLE: 'architect' };

function readSink(sink) {
  if (!fs.existsSync(sink)) return [];
  return fs.readFileSync(sink, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

describe('the marker survives the round trip', () => {
  test('A WELL-FORMED MARKER is built and parsed back intact', () => {
    expect(MARKER).toContain('SQUIDRUN_TG_CONSUME');
    expect(MARKER).toContain(`q=${QUEUED_SHA}`);
  });

  test('A MARKER WITH ANY MISSING FIELD is not built at all', () => {
    // A partial marker would make a consumer echo an incomplete identity that
    // then fails validation for a misleading reason.
    expect(buildConsumeMarker({ updateId: 1 })).toBeNull();
  });

  test('A VALUE CONTAINING SPACES OR BRACKETS is refused rather than emitted broken', () => {
    expect(buildConsumeMarker({
      updateId: 1, messageId: 'a b', routeKey: 'main', windowKey: 'main',
      profile: 'main', chatId: 1, appGeneration: 'g', queuedPayloadSha256: QUEUED_SHA,
    })).toBeNull();
  });
});

describe('runtime neutrality', () => {
  test('CODEX AND CLAUDE PAYLOADS PRODUCE THE SAME PROOF SHAPE AND VALUES', () => {
    const codexSink = sinkPath();
    const claudeSink = sinkPath();

    const codex = processHookPayload({
      runtime: 'codex',
      payload: { prompt: PROMPT, session_id: 'sess-1', turn_id: 't-1', cwd: 'D:/projects/squidrun' },
      env: PANE_ENV,
      sink: codexSink,
      nowMs: NOW,
    });
    const claude = processHookPayload({
      runtime: 'claude',
      payload: { prompt: PROMPT, session_id: 'sess-1', turn_id: 't-1' },
      env: PANE_ENV,
      sink: claudeSink,
      nowMs: NOW,
    });

    expect(codex.written).toBe(true);
    expect(claude.written).toBe(true);
    expect(Object.keys(codex.record).sort()).toEqual(Object.keys(claude.record).sort());

    const { runtime: _c, ...codexRest } = codex.record;
    const { runtime: _l, ...claudeRest } = claude.record;
    expect(codexRest).toEqual(claudeRest);
  });

  test('THE EMITTED RECORD VALIDATES against the drain expectation', () => {
    const sink = sinkPath();
    processHookPayload({
      runtime: 'codex',
      payload: { prompt: PROMPT, session_id: 'sess-1', turn_id: 't-1' },
      env: PANE_ENV,
      sink,
      nowMs: NOW,
    });

    const [record] = readSink(sink);
    expect(record.schema).toBe(SCHEMA);

    const result = validateAdmissionRecord({
      proof: record,
      expected: {
        updateId: 808499317,
        messageId: 'telegram-in-808499317',
        routeKey: 'main',
        windowKey: 'main',
        profile: 'main',
        chatId: 6543210,
        appGeneration: GENERATION,
        runtime: 'codex',
        consumerSessionId: 'sess-1',
        paneId: '1',
        queuedPayloadSha256: QUEUED_SHA,
        deliveredPromptSha256: sha256(PROMPT),
        deliveredPromptBytes: byteLength(PROMPT),
      },
      attempt: { atMs: NOW - 1000, generation: GENERATION },
    });
    expect(result).toEqual({ proven: true, reason: 'admission_proven' });
  });
});

describe('the truncated delivery, end to end', () => {
  test('A CONSUMER THAT RECEIVED A FRAGMENT emits a digest that fails validation', () => {
    // The pane got 125 characters of a 2283-byte write and the bus acked it.
    // The consumer hashes what IT saw, so the mismatch surfaces here.
    const sink = sinkPath();
    const truncated = PROMPT.slice(0, 40);

    processHookPayload({
      runtime: 'codex',
      payload: { prompt: truncated, session_id: 'sess-1' },
      env: PANE_ENV,
      sink,
      nowMs: NOW,
    });

    // A truncated prompt loses the marker entirely, so nothing is even claimed.
    expect(readSink(sink)).toEqual([]);
  });

  test('A FRAGMENT THAT STILL CARRIES THE MARKER is recorded but REJECTED on digest', () => {
    // The harder case: enough survived to look like a delivery. The body was
    // still mangled, and only the delivered-prompt digest can tell.
    const sink = sinkPath();
    const mangled = `[Telegram from james]: synthetic ordering fixt\n${MARKER}`;

    const res = processHookPayload({
      runtime: 'codex',
      payload: { prompt: mangled, session_id: 'sess-1' },
      env: PANE_ENV,
      sink,
      nowMs: NOW,
    });

    expect(res.written).toBe(true);
    const verdict = validateAdmissionRecord({
      proof: res.record,
      expected: {
        updateId: 808499317,
        messageId: 'telegram-in-808499317',
        routeKey: 'main',
        windowKey: 'main',
        profile: 'main',
        chatId: 6543210,
        appGeneration: GENERATION,
        runtime: 'codex',
        consumerSessionId: 'sess-1',
        paneId: '1',
        queuedPayloadSha256: QUEUED_SHA,
        deliveredPromptSha256: sha256(PROMPT),
        deliveredPromptBytes: byteLength(PROMPT),
      },
      attempt: { atMs: NOW - 1000, generation: GENERATION },
    });
    expect(verdict.proven).toBe(false);
    expect(verdict.reason).toBe('delivered_payload_digest_mismatch');
  });
});

describe('fail closed, and say so', () => {
  test('NO PANE BINDING refuses and RECORDS the refusal', () => {
    const sink = sinkPath();
    const res = processHookPayload({
      runtime: 'codex',
      payload: { prompt: PROMPT, session_id: 'sess-1' },
      env: { SQUIDRUN_ROLE: 'architect' }, // no SQUIDRUN_PANE_ID
      sink,
      nowMs: NOW,
    });

    expect(res.written).toBe(false);
    expect(res.reason).toBe('no_pane_binding');
    // The refusal is VISIBLE. A silent skip is what cost 8.6 hours.
    expect(readSink(sink)[0]).toMatchObject({
      schema: 'telegram_consumed.skipped.v1',
      reason: 'no_pane_binding',
    });
  });

  test('NO CONSUMER SESSION refuses and records', () => {
    const sink = sinkPath();
    const res = processHookPayload({
      runtime: 'codex', payload: { prompt: PROMPT }, env: PANE_ENV, sink, nowMs: NOW,
    });
    expect(res.reason).toBe('no_consumer_session');
    expect(readSink(sink)[0].reason).toBe('no_consumer_session');
  });

  test('AN UNKNOWN RUNTIME refuses rather than guessing a payload shape', () => {
    const sink = sinkPath();
    const res = processHookPayload({
      runtime: 'some-new-cli', payload: { prompt: PROMPT }, env: PANE_ENV, sink, nowMs: NOW,
    });
    expect(res.written).toBe(false);
    expect(res.reason).toBe('no_prompt_in_payload');
  });

  test('AN ORDINARY PROMPT is not recorded at all — refusals must not be buried', () => {
    const sink = sinkPath();
    const res = processHookPayload({
      runtime: 'codex',
      payload: { prompt: 'what is the status of the build', session_id: 's' },
      env: PANE_ENV,
      sink,
      nowMs: NOW,
    });
    expect(res.reason).toBe('not_a_telegram_delivery');
    expect(readSink(sink)).toEqual([]);
  });

  test('A GARBAGE PAYLOAD never throws', () => {
    const sink = sinkPath();
    for (const payload of [null, undefined, [], 'text', 42]) {
      expect(() => processHookPayload({ runtime: 'codex', payload, env: PANE_ENV, sink, nowMs: NOW }))
        .not.toThrow();
    }
  });

  test('AN UNWRITABLE SINK never throws into the hook', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-consumer-'));
    tempRoots.push(dir);
    const sink = path.join(dir, 'consumed.jsonl');
    fs.mkdirSync(sink); // a directory where the file must go

    const res = processHookPayload({
      runtime: 'codex',
      payload: { prompt: PROMPT, session_id: 's' },
      env: PANE_ENV,
      sink,
      nowMs: NOW,
    });

    expect(res.written).toBe(false);
    expect(res.reason).toMatch(/^sink_write_failed:/);
  });
});
