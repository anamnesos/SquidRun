/**
 * THE WEDGE MUST DESCRIBE ITSELF CORRECTLY, ALL THE WAY OUT.
 *
 * =====================================================================
 * WHY THIS IS A SEPARATE SUITE
 * =====================================================================
 * `processRecord` learned to say "this record's own attempt can never be
 * resolved by any receipt" - and then `runPass` dropped that on the floor when
 * it built `stoppedAt`, so the health JSON, the startup summary and the error
 * log all still said "the pane runtime cannot produce delivery proof... this is
 * a configuration defect". Which is a true sentence about the runtime and the
 * wrong instruction for the record: it sends the reader to repair hooks, they
 * do, and ten of James's messages stay exactly where they were.
 *
 * A correct diagnosis that is discarded one layer above where it was computed is
 * indistinguishable from never having computed it. These tests drive the REAL
 * coordinator through `schedule` and assert what actually reaches the outside.
 *
 * Isolated temp roots, synthetic messages. No live queue, sidecar, ledger,
 * process or Telegram.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const queue = require('../modules/telegram-inbound-durable-queue');
const spool = require('../modules/main/telegram-ingress-spool');
const { createDrainCoordinator } = require('../modules/main/telegram-ingress-drain');
const { createClaimLatchDouble } = require('./helpers/telegram-claim-latch-double');

const tempRoots = [];
function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-orphan-'));
  tempRoots.push(root);
  return root;
}
afterEach(() => {
  while (tempRoots.length) fs.rmSync(tempRoots.pop(), { recursive: true, force: true });
});

const CHAT = 4242;
const GENERATION = 'app-session-492';

function seed(base, updateIds) {
  let dir = null;
  for (const updateId of updateIds) {
    const res = spool.acceptInbound({
      dataRoot: base,
      routeKey: 'main',
      text: `body ${updateId}`,
      from: 'james',
      metadata: { updateId, chatId: CHAT, messageId: updateId * 10 },
      targetProfile: 'main',
      targetWindow: 'main',
      targetSession: 'session-at-append',
      producerAppGeneration: 'app-session-test',
      producerSessionId: 'sess-test',
    });
    expect(res.ok).toBe(true);
    dir = res.dir;
  }
  return dir;
}

/** The live 808499316 latch shape: attempted, no timestamp, no generation. */
function writeLegacyLatch(dir, updateId) {
  fs.writeFileSync(
    path.join(dir, 'delivery-attempts.jsonl'),
    `${JSON.stringify({ updateId, state: 'attempted' })}\n`,
    'utf8'
  );
}

function collectingLog() {
  const lines = { info: [], warn: [], error: [] };
  return {
    lines,
    info: (_scope, message) => lines.info.push(String(message)),
    warn: (_scope, message) => lines.warn.push(String(message)),
    error: (_scope, message) => lines.error.push(String(message)),
  };
}

/** The post-cutover attempt latch; see helpers/telegram-claim-latch-double. */
let latch;
beforeEach(() => {
  latch = createClaimLatchDouble({ generation: () => GENERATION });
});

function coordinator(log, overrides = {}) {
  const { deliver, sessionGeneration, now, ...rest } = overrides;
  const generation = sessionGeneration || (() => GENERATION);
  const clock = now || (() => Date.now());
  return createDrainCoordinator({
    queue,
    log,
    resolveRoute: () => ({ ok: true, profile: 'main', windowKey: 'main' }),
    currentSessionFor: () => 'session-now',
    sessionGeneration: generation,
    now: clock,
    paneRuntimeFor: () => 'codex',
    receiptActivity: () => ({ receiptsEverProduced: 0 }),
    lookupTransportClaim: latch.lookupTransportClaim,
    closeUnsentTransportClaim: latch.closeUnsentTransportClaim,
    ...rest,
    deliver: latch.wrapDeliver(
      deliver || (async () => { throw new Error('deliver must not be reached for a held record'); }),
      { generation, now: clock }
    ),
  });
}

describe('an orphaned attempt reports itself as needing recovery, not a runtime repair', () => {
  test('stoppedAt CARRIES the orphan detail instead of dropping it', async () => {
    const base = tempRoot();
    const dir = seed(base, [816, 817]);
    writeLegacyLatch(dir, 816);

    const log = collectingLog();
    const res = await coordinator(log).schedule(dir, 'main');

    expect(res.ok).toBe(true);
    expect(res.delivered).toBe(0);
    expect(res.stoppedAt.updateId).toBe(816);
    expect(res.stoppedAt.reason).toMatch(/^orphaned_attempt:/);

    // The fields runPass used to discard.
    expect(res.stoppedAt.resolutionRequired).toBe(true);
    expect(res.stoppedAt.orphanedAttempt).toBeTruthy();
    expect(res.stoppedAt.orphanedAttempt.reason).toBe('attempt_time_unknown');
    // Runtime capability survives ALONGSIDE it - both facts are true and the
    // second decides whether 817 can drain once 816 is resolved.
    expect(res.stoppedAt.proofRuntime).toBe('codex');
    expect(typeof res.stoppedAt.runtimeProofAttainable).toBe('boolean');
  });

  test('the EXTERNAL backlog health distinguishes the two kinds of unattainable', async () => {
    const base = tempRoot();
    const dir = seed(base, [816, 817]);
    writeLegacyLatch(dir, 816);

    const res = await coordinator(collectingLog()).schedule(dir, 'main');

    expect(res.backlog.pendingCount).toBe(2);
    expect(res.backlog.blockedUpdateId).toBe(816);
    expect(res.backlog.proofUnattainable).toBe(true);
    // `proofUnattainable` alone cannot tell a reader which repair to make.
    expect(res.backlog.recoveryRequired).toBe(true);
    expect(res.backlog.orphanedAttemptReason).toBe('attempt_time_unknown');
    expect(res.backlog.blockedProofRuntime).toBe('codex');
  });

  test('the ERROR LOG names explicit recovery and does NOT blame the runtime for this record', async () => {
    const base = tempRoot();
    const dir = seed(base, [816, 817]);
    writeLegacyLatch(dir, 816);

    const log = collectingLog();
    await coordinator(log).schedule(dir, 'main');

    const wedged = log.lines.error.filter((line) => line.includes('TELEGRAM INGRESS WEDGED'));
    expect(wedged).toHaveLength(1);
    const message = wedged[0];

    // What it must say.
    expect(message).toContain('EXPLICIT recorded recovery');
    expect(message).toContain('attempt_time_unknown');
    // TWO, not one: the count is everything still undelivered INCLUDING the
    // blocked record. My first assertion said one, and the message said
    // "behind it" - both were describing a different number than the code
    // computes, which is how a log line starts lying by a small amount.
    expect(message).toContain('2 message(s) are undelivered, this one included');

    // What it must NOT say for THIS record. The old branch told the reader the
    // pane runtime could not produce proof and called it a configuration
    // defect - and they would have repaired hooks for a record no hook repair
    // can reach.
    expect(message).not.toContain('cannot produce delivery proof, so this queue');
    expect(message).not.toContain('This is a configuration defect');
  });

  test('a record that is merely WAITING still takes the ordinary branch', async () => {
    // The mirror image: if every hold reported "needs explicit recovery", the
    // new message would be as useless as the old one.
    const base = tempRoot();
    const dir = seed(base, [820]);
    fs.writeFileSync(
      path.join(dir, 'delivery-attempts.jsonl'),
      `${JSON.stringify({ updateId: 820, state: 'attempted', atMs: Date.now(), generation: GENERATION })}\n`,
      'utf8'
    );

    const log = collectingLog();
    const res = await coordinator(log, { receiptActivity: () => ({ receiptsEverProduced: 5, lastReceiptAtMs: Date.now() }) })
      .schedule(dir, 'main');

    expect(res.stoppedAt.updateId).toBe(820);
    expect(res.stoppedAt.resolutionRequired).toBe(false);
    expect(res.stoppedAt.orphanedAttempt).toBe(null);
    expect(res.backlog.recoveryRequired).toBe(false);
    expect(res.backlog.orphanedAttemptReason).toBe(null);
    expect(log.lines.error.filter((l) => l.includes('EXPLICIT recorded recovery'))).toHaveLength(0);
  });
});
