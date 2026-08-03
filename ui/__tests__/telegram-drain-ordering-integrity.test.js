/**
 * S491 — THE ORDER INVARIANT, tested through the production drain loop.
 *
 * These are integration tests on purpose. Twice in this lane a guard was proved
 * correct in isolation while nothing proved the drain actually consulted it, and
 * both times a stub-out mutant stayed green and the work was reverted. So every
 * test here drives a REAL coordinator over a REAL spool directory and asserts on
 * what the pane would have been shown.
 *
 * The bodies are the live ones from the incident, because they are the argument:
 *
 *   808499317  "Kristine muller approved job... change job to invoice"
 *   808499318  "Not the tankless job the other one"
 *
 * 318 is a CORRECTION. Alone it does not merely lose context, it inverts the
 * instruction and points James's business at the wrong job. That is why the
 * bypass shipped as 40ff94f7 was reverted, and why "hold" is the whole design
 * rather than a limitation of it.
 *
 * Zero network, zero timers, zero outbound sends.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const queue = require('../modules/telegram-inbound-durable-queue');
const spool = require('../modules/main/telegram-ingress-spool');
const { createDrainCoordinator } = require('../modules/main/telegram-ingress-drain');

const tempRoots = [];
function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-order-'));
  tempRoots.push(root);
  return root;
}
afterEach(() => {
  while (tempRoots.length) fs.rmSync(tempRoots.pop(), { recursive: true, force: true });
});

const CHAT = 6543210;
const GENERATION = 'gen-session-491';
const silentLog = { info() {}, warn() {}, error() {} };

const INCIDENT = [
  { updateId: 808499317, text: 'Kristine muller approved job... change job to invoice' },
  { updateId: 808499318, text: 'Not the tankless job the other one' },
  { updateId: 808499319, text: 'Hello?' },
];

function seedIncident(base, updates = INCIDENT) {
  let dir = null;
  for (const { updateId, text } of updates) {
    const res = spool.acceptInbound({
      dataRoot: base,
      routeKey: 'main',
      text,
      from: 'james',
      metadata: { updateId, chatId: CHAT, messageId: updateId },
      targetProfile: 'main',
      targetWindow: 'main',
      targetSession: 'session-at-append',
    });
    expect(res.ok).toBe(true);
    dir = res.dir;
  }
  return dir;
}

/** A delivery adapter that knows what it delivered, as the real boundary does. */
function provenFor(job, atMs) {
  return {
    messageId: job.messageId,
    routeKey: job.routeKey,
    windowKey: job.windowKey,
    profile: job.profile,
    chatId: job.chatId,
    generation: GENERATION,
    status: 'delivered.verified',
    verified: true,
    provedAtMs: atMs,
  };
}

const UNPROVEN = { status: 'accepted.daemon_pty_unverified', accepted: true };

function coordinator(overrides = {}) {
  return createDrainCoordinator({
    queue,
    log: silentLog,
    resolveRoute: () => ({ ok: true, profile: 'main', windowKey: 'main' }),
    currentSessionFor: () => 'session-now',
    sessionGeneration: () => GENERATION,
    // A pane runtime that demonstrably produces proof, unless a test says
    // otherwise. `nowMs` is supplied by the coordinator's clock.
    paneRuntimeFor: () => 'claude',
    receiptActivity: () => ({ claude: Date.now() }),
    deliver: async (job) => provenFor(job, Date.now()),
    ...overrides,
  });
}

describe('318 can never surface alone', () => {
  test('AN UNPROVABLE 317 HOLDS 318 — the correction never arrives without its referent', async () => {
    const base = tempRoot();
    const dir = seedIncident(base);
    const shown = [];
    const drain = coordinator({
      deliver: async (job) => {
        shown.push(job.text);
        return UNPROVEN; // accepted, never proved — the S491 shape exactly
      },
    });

    const res = await drain.schedule(dir, 'main');

    // 317 was attempted once. 318 and 319 were never even offered to the pane.
    expect(shown).toEqual(['Kristine muller approved job... change job to invoice']);
    expect(shown).not.toContain('Not the tankless job the other one');
    expect(res.delivered).toBe(0);
    expect(res.stoppedAt.updateId).toBe(808499317);
    // All three are still durably queued: held, not lost.
    expect(queue.readPending(dir).map((r) => r.updateId)).toEqual([808499317, 808499318, 808499319]);
  });

  test('NO NUMBER OF PASSES lets 318 pass an unretired 317', async () => {
    // The reverted fix turned "wait longer" into "go around". Time must not be
    // a key that opens this door, so drive many passes and a wide clock jump.
    const base = tempRoot();
    const dir = seedIncident(base);
    const shown = [];
    let clock = 1_000_000;
    const drain = coordinator({
      now: () => clock,
      deliver: async (job) => { shown.push(job.updateId); return UNPROVEN; },
    });

    for (let pass = 0; pass < 5; pass += 1) {
      clock += 60 * 60 * 1000; // an hour per pass; 5 hours total
      await drain.schedule(dir, 'main');
    }

    expect(shown.every((id) => id === 808499317)).toBe(true);
    expect(shown).not.toContain(808499318);
    expect(queue.readPending(dir)).toHaveLength(3);
  });

  test('ACROSS A RESTART, a fresh coordinator still refuses to surface 318', async () => {
    const base = tempRoot();
    const dir = seedIncident(base);

    const firstShown = [];
    const before = coordinator({
      deliver: async (job) => { firstShown.push(job.updateId); return UNPROVEN; },
    });
    await before.schedule(dir, 'main');
    expect(firstShown).toEqual([808499317]);

    // "Restart": a brand new coordinator with no in-memory latch at all. The
    // only thing carrying the ambiguity across the process boundary is the
    // durable attempt journal.
    const afterShown = [];
    const restarted = coordinator({
      deliver: async (job) => { afterShown.push(job.updateId); return UNPROVEN; },
    });
    const res = await restarted.schedule(dir, 'main');

    expect(afterShown).toEqual([]); // 317 not re-injected...
    expect(afterShown).not.toContain(808499318); // ...and 318 still never shown
    expect(res.stoppedAt.updateId).toBe(808499317);
    expect(queue.readPending(dir)).toHaveLength(3);
  });

  test('ONCE 317 IS PROVEN, 318 and 319 follow in ascending order and the queue empties', async () => {
    const base = tempRoot();
    const dir = seedIncident(base);
    const shown = [];
    const drain = coordinator({
      deliver: async (job) => { shown.push(job.updateId); return provenFor(job, Date.now()); },
    });

    const res = await drain.schedule(dir, 'main');

    expect(shown).toEqual([808499317, 808499318, 808499319]);
    expect(res.delivered).toBe(3);
    expect(res.stoppedAt).toBeNull();
    expect(queue.readPending(dir)).toHaveLength(0);
  });

  test('EXACTLY ONCE: a proven message is not re-delivered on a later pass', async () => {
    const base = tempRoot();
    const dir = seedIncident(base);
    const shown = [];
    const drain = coordinator({
      deliver: async (job) => { shown.push(job.updateId); return provenFor(job, Date.now()); },
    });

    await drain.schedule(dir, 'main');
    await drain.schedule(dir, 'main');
    await drain.schedule(dir, 'main');

    expect(shown).toEqual([808499317, 808499318, 808499319]);
  });
});

describe('proof that arrives after the attempt', () => {
  test('LATE PROOF RETIRES 317 WITHOUT RE-INJECTING IT, and releases the rest', async () => {
    // The record was attempted and accepted but unproved. Later the receipt
    // lands. 317 must retire on that evidence alone — never by being sent again,
    // which would put the same instruction in front of James twice.
    const base = tempRoot();
    const dir = seedIncident(base);
    let clock = 5_000_000;
    const shown = [];

    const first = coordinator({
      now: () => clock,
      deliver: async (job) => { shown.push(job.updateId); return UNPROVEN; },
    });
    await first.schedule(dir, 'main');
    expect(shown).toEqual([808499317]);

    clock += 30_000;
    const proofAtMs = clock;
    const second = coordinator({
      now: () => clock,
      findExistingReceipt: async (identity) => (
        identity.messageId === 'telegram-in-808499317'
          ? {
            messageId: identity.messageId,
            routeKey: identity.routeKey,
            windowKey: identity.windowKey,
            profile: identity.profile,
            chatId: identity.chatId,
            generation: identity.generation,
            status: 'delivered.verified',
            verified: true,
            provedAtMs: proofAtMs,
          }
          : null
      ),
      deliver: async (job) => { shown.push(job.updateId); return provenFor(job, clock); },
    });
    const res = await second.schedule(dir, 'main');

    // 317 was NOT shown a second time; 318 and 319 then went in order.
    expect(shown).toEqual([808499317, 808499318, 808499319]);
    expect(res.delivered).toBe(3);
    expect(queue.readPending(dir)).toHaveLength(0);
  });

  test('PROOF THAT PREDATES THE ATTEMPT does not release the queue', async () => {
    const base = tempRoot();
    const dir = seedIncident(base);
    let clock = 5_000_000;
    const shown = [];

    const first = coordinator({
      now: () => clock,
      deliver: async (job) => { shown.push(job.updateId); return UNPROVEN; },
    });
    await first.schedule(dir, 'main');

    const stale = clock - 60_000; // a receipt from BEFORE this delivery
    clock += 30_000;
    const second = coordinator({
      now: () => clock,
      findExistingReceipt: async (identity) => ({
        messageId: identity.messageId,
        routeKey: identity.routeKey,
        windowKey: identity.windowKey,
        profile: identity.profile,
        chatId: identity.chatId,
        generation: identity.generation,
        status: 'delivered.verified',
        verified: true,
        provedAtMs: stale,
      }),
      deliver: async (job) => { shown.push(job.updateId); return provenFor(job, clock); },
    });
    const res = await second.schedule(dir, 'main');

    expect(shown).toEqual([808499317]); // nothing new was shown
    expect(res.delivered).toBe(0);
    expect(res.stoppedAt.updateId).toBe(808499317);
  });

  test('PROOF FROM ANOTHER GENERATION does not release the queue', async () => {
    const base = tempRoot();
    const dir = seedIncident(base);
    let clock = 5_000_000;
    const shown = [];

    await coordinator({
      now: () => clock,
      deliver: async (job) => { shown.push(job.updateId); return UNPROVEN; },
    }).schedule(dir, 'main');

    clock += 30_000;
    const res = await coordinator({
      now: () => clock,
      findExistingReceipt: async (identity) => ({
        ...identity,
        generation: 'gen-some-older-process',
        status: 'delivered.verified',
        verified: true,
        provedAtMs: clock,
      }),
      deliver: async (job) => { shown.push(job.updateId); return provenFor(job, clock); },
    }).schedule(dir, 'main');

    expect(shown).toEqual([808499317]);
    expect(res.delivered).toBe(0);
  });
});

describe('the hold explains itself', () => {
  test('AN UNWIRED PANE RUNTIME is reported as a defect, not as patience', async () => {
    // The codex case: proof is not late, it is impossible. Health has to be
    // able to tell those apart or an 8-hour wedge looks like a 30-second one.
    const base = tempRoot();
    const dir = seedIncident(base);
    const drain = coordinator({
      paneRuntimeFor: () => 'codex',
      receiptActivity: () => ({ claude: Date.now() }), // codex has never produced one
      deliver: async () => UNPROVEN,
    });

    await drain.schedule(dir, 'main');
    const res = await drain.schedule(dir, 'main');

    expect(res.stoppedAt.unattainable).toBe(true);
    expect(res.stoppedAt.reason).toBe('unprovable_pane:runtime_never_produced_proof');
    expect(res.stoppedAt.proofRuntime).toBe('codex');
  });

  test('A WIRED PANE THAT IS MERELY SLOW is NOT reported as a defect', async () => {
    const base = tempRoot();
    const dir = seedIncident(base);
    const drain = coordinator({ deliver: async () => UNPROVEN });

    await drain.schedule(dir, 'main');
    const res = await drain.schedule(dir, 'main');

    expect(res.stoppedAt.unattainable).toBe(false);
    expect(res.stoppedAt.reason).toMatch(/^unresolved_delivery_attempt:/);
  });

  test('THE WEDGE IS LOGGED AT ERROR, because a warn among warns is invisible', async () => {
    const base = tempRoot();
    const dir = seedIncident(base);
    const errors = [];
    const drain = coordinator({
      log: { info() {}, warn() {}, error: (...args) => errors.push(args.join(' ')) },
      paneRuntimeFor: () => 'codex',
      receiptActivity: () => ({}),
      deliver: async () => UNPROVEN,
    });

    await drain.schedule(dir, 'main');
    await drain.schedule(dir, 'main');

    expect(errors.join('\n')).toMatch(/TELEGRAM INGRESS WEDGED at update 808499317/);
    expect(errors.join('\n')).toMatch(/configuration defect/);
  });

  test('THE BACKLOG SNAPSHOT reaches the caller on a held pass', async () => {
    const base = tempRoot();
    const dir = seedIncident(base);
    let clock = 9_000_000;
    const drain = coordinator({ now: () => clock, deliver: async () => UNPROVEN });

    await drain.schedule(dir, 'main');
    clock += 8 * 60 * 60 * 1000; // the 8-hour silence
    const res = await drain.schedule(dir, 'main');

    expect(res.backlog.pendingCount).toBe(3);
    expect(res.backlog.oldestPendingUpdateId).toBe(808499317);
    expect(res.backlog.blockedUpdateId).toBe(808499317);
    expect(res.backlog.attemptedCount).toBe(1);
  });

  test('THE BACKLOG SNAPSHOT is present on a CLEAN pass too, or health cannot tell healthy from silent', async () => {
    const base = tempRoot();
    const dir = seedIncident(base);
    const drain = coordinator();

    const res = await drain.schedule(dir, 'main');

    expect(res.backlog).toBeDefined();
    expect(res.backlog.pendingCount).toBe(0);
    expect(res.backlog.blockedUpdateId).toBeNull();
    expect(res.backlog.lastRetirementAtMs).not.toBeNull();
  });
});

describe('gate 2 — retiring 808499316 without re-injecting it', () => {
  // The real shape: 316 was consumed and answered (Telegram 22314 / ledger
  // 78453) but its attempt predates attempt timestamps, so nothing automatic
  // can prove it. It must leave the queue without being sent again, and 317+
  // must then flow in order.
  const FULL_INCIDENT = [
    { updateId: 808499316, text: 'the message that was already answered' },
    ...INCIDENT,
  ];

  function wedge(dir) {
    fs.writeFileSync(
      queue.attemptsPath(dir),
      `${JSON.stringify({ updateId: 808499316, state: 'attempted' })}\n`,
      'utf8'
    );
  }

  test('BEFORE RECOVERY the whole queue is held at 316 and nothing is delivered', async () => {
    const base = tempRoot();
    const dir = seedIncident(base, FULL_INCIDENT);
    wedge(dir);
    const shown = [];
    const res = await coordinator({
      deliver: async (job) => { shown.push(job.updateId); return provenFor(job, Date.now()); },
    }).schedule(dir, 'main');

    expect(shown).toEqual([]);
    expect(res.stoppedAt.updateId).toBe(808499316);
    expect(queue.readPending(dir)).toHaveLength(4);
  });

  test('A RECORDED DISPOSITION retires 316 with ZERO delivery, then 317-319 flow in order', async () => {
    const base = tempRoot();
    const dir = seedIncident(base, FULL_INCIDENT);
    wedge(dir);

    queue.appendDisposition(
      dir,
      808499316,
      'consumed_verified_out_of_band',
      'answered as Telegram 22314 / ledger 78453'
    );

    const shown = [];
    const res = await coordinator({
      deliver: async (job) => { shown.push(job.updateId); return provenFor(job, Date.now()); },
    }).schedule(dir, 'main');

    // 316 never reached a pane. The rest went exactly once, ascending.
    expect(shown).toEqual([808499317, 808499318, 808499319]);
    expect(shown).not.toContain(808499316);
    expect(res.delivered).toBe(4); // 316 retired terminally + three delivered
    expect(queue.readPending(dir)).toHaveLength(0);
  });

  test('AN UNKNOWN DISPOSITION HOLDS rather than retiring something undelivered', async () => {
    const base = tempRoot();
    const dir = seedIncident(base, FULL_INCIDENT);
    queue.appendDisposition(dir, 808499316, 'looks_fine_to_me', 'a reason that is not a class');

    const shown = [];
    const res = await coordinator({
      deliver: async (job) => { shown.push(job.updateId); return provenFor(job, Date.now()); },
    }).schedule(dir, 'main');

    expect(shown).toEqual([]);
    expect(res.stoppedAt).toMatchObject({ updateId: 808499316, reason: 'unknown_terminal_disposition' });
  });

  test('A DISPOSITION WITHOUT EVIDENCE CANNOT BE WRITTEN AT ALL', () => {
    const base = tempRoot();
    const dir = seedIncident(base, FULL_INCIDENT);
    expect(() => queue.appendDisposition(dir, 808499316, 'consumed_verified_out_of_band', '   '))
      .toThrow(/evidence/);
    // Rejected before touching disk.
    expect(fs.existsSync(queue.dispositionsPath(dir))).toBe(false);
  });

  test('AN UNREADABLE DISPOSITION SIDECAR HOLDS — it never reads as "no disposition"', async () => {
    const base = tempRoot();
    const dir = seedIncident(base, FULL_INCIDENT);
    fs.writeFileSync(queue.dispositionsPath(dir), 'not json at all\n', 'utf8');

    const shown = [];
    const res = await coordinator({
      deliver: async (job) => { shown.push(job.updateId); return provenFor(job, Date.now()); },
    }).schedule(dir, 'main');

    expect(shown).toEqual([]);
    expect(res.stoppedAt.reason).toMatch(/unreadable/);
  });

  test('THE RECOVERY LEAVES THE INBOUND JOURNAL BYTE-FOR-BYTE UNCHANGED', () => {
    const base = tempRoot();
    const dir = seedIncident(base, FULL_INCIDENT);
    const before = fs.readFileSync(queue.journalPath(dir), 'utf8');

    queue.appendDisposition(dir, 808499316, 'consumed_verified_out_of_band', 'answered as 22314');

    expect(fs.readFileSync(queue.journalPath(dir), 'utf8')).toBe(before);
  });
});

describe('the attempt latch carries provenance', () => {
  test('AN ATTEMPT RECORDS WHEN AND BY WHICH GENERATION it was made', async () => {
    const base = tempRoot();
    const dir = seedIncident(base);
    const clock = 7_777_000;
    const drain = coordinator({ now: () => clock, deliver: async () => UNPROVEN });

    await drain.schedule(dir, 'main');

    const records = queue.readAttemptRecords(dir);
    expect(records.get(808499317)).toEqual({
      state: 'attempted',
      atMs: clock,
      generation: GENERATION,
    });
  });

  test('A v0 ENTRY WITH NO TIMESTAMP still parses, and still holds', async () => {
    // The live latch on disk predates provenance. It must remain readable, and
    // an attempt that cannot be placed in time must never be auto-retired.
    const base = tempRoot();
    const dir = seedIncident(base);
    fs.writeFileSync(
      queue.attemptsPath(dir),
      `${JSON.stringify({ updateId: 808499317, state: 'attempted' })}\n`,
      'utf8'
    );
    const shown = [];
    const drain = coordinator({
      findExistingReceipt: async (identity) => ({
        ...identity,
        status: 'delivered.verified',
        verified: true,
        provedAtMs: Date.now(),
      }),
      deliver: async (job) => { shown.push(job.updateId); return provenFor(job, Date.now()); },
    });

    const res = await drain.schedule(dir, 'main');

    // Correlated proof exists, but it cannot be ordered against an undated
    // attempt, so the record is neither retired nor re-sent.
    expect(shown).toEqual([]);
    expect(res.delivered).toBe(0);
    expect(res.stoppedAt.updateId).toBe(808499317);
    expect(queue.readPending(dir)).toHaveLength(3);
  });
});
