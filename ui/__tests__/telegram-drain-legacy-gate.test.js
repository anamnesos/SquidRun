/**
 * v7 §2 STEP 2A — THE GATE, WIRED INTO THE PRODUCTION ORDERED PASS.
 *
 * =====================================================================
 * WHY THIS SUITE EXISTS SEPARATELY FROM telegram-legacy-journal.test.js
 * =====================================================================
 * That suite proves the parser and the pure gate are correct in isolation, and
 * it proved them 20/20 while the production drain called neither. Twice in this
 * lane a guard was verified as a function while nothing verified that the code
 * which decides James's messages actually consults it, and both times a
 * stub-out mutant stayed green.
 *
 * So every test here drives the REAL `createDrainCoordinator(...).drainOnce`
 * over a REAL spool directory and asserts on COUNTERS: how many times each
 * sidecar was read, how many claim lookups, receipt lookups, deliveries, acks
 * and journal writes happened. A hold that is described correctly but performs
 * one claim lookup on the way is not a hold — it is a side effect with good
 * manners — and only a counter can tell the difference.
 *
 * Zero network, zero timers, zero live queue/latch/ledger/process/Telegram.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const queue = require('../modules/telegram-inbound-durable-queue');
const spool = require('../modules/main/telegram-ingress-spool');
const { createDrainCoordinator } = require('../modules/main/telegram-ingress-drain');
const legacyJournal = require('../modules/main/telegram-legacy-journal');
const { classifySourceRecord, SOURCE_PROTOCOLS } = require('../modules/main/telegram-source-protocol');
const { LEGACY_SETTLEMENT } = require('../modules/main/telegram-activation-mode');
const { createClaimLatchDouble } = require('./helpers/telegram-claim-latch-double');

const tempRoots = [];
function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-gate-'));
  tempRoots.push(root);
  return root;
}
afterEach(() => {
  while (tempRoots.length) fs.rmSync(tempRoots.pop(), { recursive: true, force: true });
});

const CHAT = 4242;
const GENERATION = 'app-session-492';
const silentLog = { info() {}, warn() {}, error() {} };

/** The exact live latch: attempted, no timestamp, no generation. */
const LIVE_LATCH = 808499316;

// ------------------------------------------------------------------ fixtures

function legacyRecord(updateId, overrides = {}) {
  return {
    updateId,
    text: `body ${updateId}`,
    from: 'james',
    chatId: CHAT,
    messageId: updateId * 10,
    routeKey: 'main',
    rawMetadata: { updateId, chatId: CHAT },
    profile: 'main',
    targetProfile: 'main',
    targetWindow: 'main',
    targetSession: 'session-at-append',
    ...overrides,
  };
}

/** Unstamped, exactly as the twelve live records were written. */
function seedLegacy(base, updateIds, overrides = {}) {
  const resolved = spool.resolveSpoolDir(base, 'main');
  expect(resolved.ok).toBe(true);
  for (const updateId of updateIds) {
    expect(queue.append(resolved.dir, legacyRecord(updateId, overrides)).ok).toBe(true);
  }
  for (const record of queue.readPending(resolved.dir)) {
    expect(classifySourceRecord(record).protocol).toBe(SOURCE_PROTOCOLS.LEGACY);
  }
  return resolved.dir;
}

/**
 * Straight to the journal file, for values `queue.append` normalises away.
 *
 * `append` coerces a non-string `terminalDisposition` to null, which is exactly
 * the fail-open normalisation the drain must refuse — so a fixture that went
 * through it could not express the attack at all.
 */
function seedRawRecord(base, record) {
  const resolved = spool.resolveSpoolDir(base, 'main');
  expect(resolved.ok).toBe(true);
  fs.mkdirSync(resolved.dir, { recursive: true });
  fs.appendFileSync(queue.journalPath(resolved.dir), `${JSON.stringify(record)}\n`, 'utf8');
  return resolved.dir;
}

/** The production door, which always stamps `decision_v1` (v7 §1). */
function seedDecisionV1(base, updateIds) {
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
  for (const record of queue.readPending(dir)) {
    expect(classifySourceRecord(record).protocol).toBe(SOURCE_PROTOCOLS.DECISION_V1);
  }
  return dir;
}

function writeAttempts(dir, lines) {
  fs.writeFileSync(queue.attemptsPath(dir), lines.map((l) => `${l}\n`).join(''), 'utf8');
}
function writeDispositions(dir, lines) {
  fs.writeFileSync(queue.dispositionsPath(dir), lines.map((l) => `${l}\n`).join(''), 'utf8');
}
/** The v0 latch shape that wedged the live channel. */
function liveLatchLine(updateId) {
  return JSON.stringify({ updateId, state: 'attempted' });
}

// ------------------------------------------------------------------ counters

/**
 * Every seam a hold is forbidden to touch, counted.
 *
 * `deliver` is wrapped by the claim-latch double exactly as the other drain
 * suites wrap it, so a delivery that happened cannot be hidden behind an
 * unlatched fixture.
 */
function harness(dir, overrides = {}) {
  const counts = {
    attemptsRead: 0,
    dispositionsRead: 0,
    claimLookup: 0,
    claimClose: 0,
    receiptLookup: 0,
    deliver: 0,
    // THE DECISION SEAM, NAMED (v11 line 59, Architect #131).
    //
    // v7's symmetric pane|mira decision is Step 4 and does not exist in this
    // build, so there is no decision module to count and inventing one to have
    // something to point at would be the fake proof. What DOES exist is a
    // boundary: production passes exactly one outbound routing seam to the
    // coordinator - `deliver`, which is
    // `deliverTelegramInboundJob(buildTelegramInboundJob(job))` in
    // squidrun-app.js - and any transport choice lives behind it. So the
    // decision seam is counted AT that boundary, and the structural test below
    // proves the coordinator has no second door. Zero deliver is zero decision
    // because there is nowhere else a decision could be taken.
    decisionSeam: 0,
    ack: 0,
    attemptAppend: 0,
    dispositionAppend: 0,
  };
  const delivered = [];
  const latch = createClaimLatchDouble({ generation: () => GENERATION });
  const {
    deliver, ack, journalReadThrows, ...rest
  } = overrides;

  const countedQueue = {
    ...queue,
    ack: (...args) => {
      counts.ack += 1;
      return ack ? ack(...args) : queue.ack(...args);
    },
    appendAttempt: (...args) => { counts.attemptAppend += 1; return queue.appendAttempt(...args); },
    appendDisposition: (...args) => { counts.dispositionAppend += 1; return queue.appendDisposition(...args); },
  };

  const drain = createDrainCoordinator({
    queue: countedQueue,
    log: silentLog,
    resolveRoute: () => ({ ok: true, profile: 'main', windowKey: 'main' }),
    currentSessionFor: () => 'session-now',
    sessionGeneration: () => GENERATION,
    now: () => Date.now(),
    paneRuntimeFor: () => 'codex',
    receiptActivity: () => ({ receiptsEverProduced: 5, lastReceiptAtMs: Date.now() }),
    readJournalFile: (file) => {
      if (file === queue.attemptsPath(dir)) counts.attemptsRead += 1;
      else if (file === queue.dispositionsPath(dir)) counts.dispositionsRead += 1;
      else throw new Error(`unexpected journal read: ${file}`);
      if (journalReadThrows && journalReadThrows(file)) {
        const err = new Error('EACCES: permission denied');
        err.code = 'EACCES';
        throw err;
      }
      return fs.readFileSync(file, 'utf8');
    },
    lookupTransportClaim: async (input) => {
      counts.claimLookup += 1;
      return latch.lookupTransportClaim(input);
    },
    closeUnsentTransportClaim: async (input) => {
      counts.claimClose += 1;
      return latch.closeUnsentTransportClaim(input);
    },
    findExistingReceipt: async () => { counts.receiptLookup += 1; return null; },
    // v7 §3 Phase L. Every test in THIS file is about the legacy gate, so the
    // operating state is healthy unless a test overrides it; the mode's own
    // attacks live in telegram-drain-activation-mode.test.js.
    activationMode: () => LEGACY_SETTLEMENT,
    ...rest,
    deliver: latch.wrapDeliver(async (job) => {
      counts.deliver += 1;
      // Same call, deliberately: this IS where a transport decision would be
      // taken in production, so the two counters cannot drift apart.
      counts.decisionSeam += 1;
      delivered.push(job.updateId);
      return deliver
        ? deliver(job)
        : {
          messageId: job.messageId,
          routeKey: job.routeKey,
          windowKey: job.windowKey,
          profile: job.profile,
          chatId: job.chatId,
          generation: GENERATION,
          provedAtMs: Date.now(),
          status: 'delivered.verified',
          verified: true,
        };
    }, { generation: () => GENERATION, now: () => Date.now() }),
  });

  return { drain, counts, delivered };
}

/** The exact bytes of both sidecars, so "zero writes" is measured, not assumed. */
function sidecarBytes(dir) {
  const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
  return { attempts: read(queue.attemptsPath(dir)), dispositions: read(queue.dispositionsPath(dir)) };
}

/** Everything a hold must not have done. */
function expectNoSideEffects(counts) {
  expect(counts.claimLookup).toBe(0);
  expect(counts.claimClose).toBe(0);
  expect(counts.receiptLookup).toBe(0);
  expect(counts.deliver).toBe(0);
  expect(counts.decisionSeam).toBe(0);
  expect(counts.ack).toBe(0);
  expect(counts.attemptAppend).toBe(0);
  expect(counts.dispositionAppend).toBe(0);
}

// -------------------------------------------------------- one read per pass

describe('exactly one read of each sidecar per ordered pass', () => {
  test('three pending records, one attempts read and one dispositions read', async () => {
    const base = tempRoot();
    const dir = seedLegacy(base, [700, 701, 702]);
    const { drain, counts, delivered } = harness(dir);

    await drain.drainOnce(dir, 'main');

    expect(delivered).toEqual([700, 701, 702]);
    // NOT ONCE PER RECORD. A pass that re-read between updates could watch the
    // journal change underneath it and decide two records from two worlds.
    expect(counts.attemptsRead).toBe(1);
    expect(counts.dispositionsRead).toBe(1);
  });

  test('the DISPOSITIONS file is still read exactly once when the ATTEMPTS read throws', async () => {
    const base = tempRoot();
    const dir = seedLegacy(base, [710, 711]);
    const { drain, counts } = harness(dir, {
      journalReadThrows: (file) => file === queue.attemptsPath(dir),
    });

    const res = await drain.drainOnce(dir, 'main');

    // "Once per ordered pass" has to mean ONCE, not at-most-once, or the read
    // counters stop being evidence about the pass and start being evidence
    // about which error happened first.
    expect(counts.attemptsRead).toBe(1);
    expect(counts.dispositionsRead).toBe(1);
    expect(res.stoppedAt.reason).toBe('legacy_journal_gate:journal_unreadable');
    expectNoSideEffects(counts);
  });
});

// ------------------------------------------------------- snapshot failure

describe('snapshot failure stops the head and everything behind it', () => {
  const CORRUPTIONS = [
    ['unparseable record', (dir) => writeAttempts(dir, ['not json at all']), 'attempt_unparseable_record'],
    ['torn tail', (dir) => fs.writeFileSync(queue.attemptsPath(dir), '{"updateId":1,"state":"retryable"}\n{"upda', 'utf8'), 'attempt_torn_tail'],
    ['duplicate updateId', (dir) => writeAttempts(dir, [liveLatchLine(720), liveLatchLine(720)]), 'attempt_duplicate_update_id'],
    ['unknown attempt state', (dir) => writeAttempts(dir, ['{"updateId":1,"state":"delivered"}']), 'attempt_unknown_state'],
    ['unknown key', (dir) => writeAttempts(dir, ['{"updateId":1,"state":"attempted","who":"me"}']), 'attempt_schema_mismatch'],
    ['interior blank line', (dir) => fs.writeFileSync(queue.attemptsPath(dir), '{"updateId":1,"state":"retryable"}\n\n{"updateId":2,"state":"retryable"}\n', 'utf8'), 'attempt_blank_record'],
    ['unrecognized disposition', (dir) => writeDispositions(dir, ['{"updateId":1,"disposition":"looks_fine","evidence":"e"}']), 'disposition_unrecognized'],
    ['disposition without evidence', (dir) => writeDispositions(dir, ['{"updateId":1,"disposition":"empty_body","evidence":"  "}']), 'disposition_missing_evidence'],
  ];

  test.each(CORRUPTIONS)('%s stops N and N+1 with no claim, deliver, ack or write', async (_label, corrupt, reason) => {
    const base = tempRoot();
    const dir = seedLegacy(base, [720, 721]);
    corrupt(dir);
    const before = sidecarBytes(dir);
    const { drain, counts, delivered } = harness(dir);

    const res = await drain.drainOnce(dir, 'main');

    expect(delivered).toEqual([]);
    expect(res.stoppedAt).toMatchObject({
      updateId: 720,
      reason: `legacy_journal_gate:${reason}`,
      failureClass: 'awaiting_proof',
      resolutionRequired: true,
    });
    // N+1 NEVER PASSES N — and here nothing passed at all.
    expect(queue.readPending(dir).map((r) => r.updateId)).toEqual([720, 721]);
    expectNoSideEffects(counts);
    expect(sidecarBytes(dir)).toEqual(before);
  });

  test('a failed snapshot does not report zero attempts as health', async () => {
    const base = tempRoot();
    const dir = seedLegacy(base, [730]);
    writeAttempts(dir, ['not json at all']);
    const { drain } = harness(dir);

    const res = await drain.drainOnce(dir, 'main');

    expect(res.backlog.pendingCount).toBe(1);
    expect(res.backlog.blockedUpdateId).toBe(730);
    expect(res.backlog.recoveryRequired).toBe(true);
  });
});

// ------------------------------------------------------------ legacy source

describe('legacy source', () => {
  test('THE LIVE 808499316 SHAPE: reviewed disposition retires it with the old attempted latch still on disk', async () => {
    const base = tempRoot();
    const dir = seedLegacy(base, [LIVE_LATCH, 808499317]);
    writeAttempts(dir, [liveLatchLine(LIVE_LATCH)]);
    writeDispositions(dir, [JSON.stringify({
      updateId: LIVE_LATCH,
      disposition: 'consumed_verified_out_of_band',
      evidence: 'answered as Telegram 22314 / ledger 78453',
    })]);
    const before = sidecarBytes(dir);
    const { drain, counts, delivered } = harness(dir);

    const res = await drain.drainOnce(dir, 'main');

    // Retired without ever reaching a pane, and 317 drained behind it.
    expect(delivered).toEqual([808499317]);
    expect(res.delivered).toBe(2);
    expect(queue.readPending(dir)).toHaveLength(0);
    // ZERO DECISION for the retirement: the only claim lookup belongs to 317's
    // ordinary pane path, and nothing was written to either sidecar.
    expect(counts.claimLookup).toBe(1);
    expect(counts.attemptAppend).toBe(0);
    expect(counts.dispositionAppend).toBe(0);
    expect(sidecarBytes(dir)).toEqual(before);
  });

  test('ATTEMPTED WITH NO DISPOSITION HOLDS before any lookup at all', async () => {
    // Architect #119: v7 §2 line 45 wins over the old implementation. The
    // legacy attempted branch may not reach claim lookup, receipt lookup or
    // `evaluateConsumptionProof` on its way to holding - no receipt may retire
    // an unversioned v0 latch, so consulting one is pure risk with no upside.
    const base = tempRoot();
    const dir = seedLegacy(base, [LIVE_LATCH, 808499317]);
    writeAttempts(dir, [liveLatchLine(LIVE_LATCH)]);
    const before = sidecarBytes(dir);
    const { drain, counts, delivered } = harness(dir);

    const res = await drain.drainOnce(dir, 'main');

    expect(delivered).toEqual([]);
    expect(res.stoppedAt).toMatchObject({
      updateId: LIVE_LATCH,
      failureClass: 'awaiting_proof',
      resolutionRequired: true,
    });
    expect(res.stoppedAt.reason).toMatch(/^orphaned_attempt:/);
    // 808499318 is a correction that means the opposite of itself without 317
    // in front of it. N+1 does not pass.
    expect(queue.readPending(dir).map((r) => r.updateId)).toEqual([LIVE_LATCH, 808499317]);
    expectNoSideEffects(counts);
    expect(sidecarBytes(dir)).toEqual(before);
  });

  test('A WELL-FORMED attempt holds the same way, and still reaches no lookup', async () => {
    const base = tempRoot();
    const dir = seedLegacy(base, [740]);
    writeAttempts(dir, [JSON.stringify({
      updateId: 740, state: 'attempted', atMs: Date.now(), generation: GENERATION,
    })]);
    const { drain, counts } = harness(dir);

    const res = await drain.drainOnce(dir, 'main');

    expect(res.stoppedAt.reason).toBe('hold_legacy_attempted:awaiting_reviewed_disposition');
    expectNoSideEffects(counts);
  });

  test('RETRYABLE takes the ordinary pane path', async () => {
    const base = tempRoot();
    const dir = seedLegacy(base, [750]);
    writeAttempts(dir, [JSON.stringify({ updateId: 750, state: 'retryable' })]);
    const { drain, counts, delivered } = harness(dir);

    await drain.drainOnce(dir, 'main');

    expect(delivered).toEqual([750]);
    expect(counts.claimLookup).toBe(1);
    expect(queue.readPending(dir)).toHaveLength(0);
  });

  test('NO JOURNAL MATCH takes the ordinary pane path', async () => {
    const base = tempRoot();
    const dir = seedLegacy(base, [760]);
    writeAttempts(dir, [JSON.stringify({ updateId: 999, state: 'retryable' })]);
    const { drain, delivered } = harness(dir);

    await drain.drainOnce(dir, 'main');

    expect(delivered).toEqual([760]);
  });
});

// ------------------------------------------------------- decision_v1 source

describe('decision_v1 source is refused by this build', () => {
  test('ANY legacy journal match is a protocol conflict, before claim or deliver', async () => {
    const base = tempRoot();
    const dir = seedDecisionV1(base, [770, 771]);
    writeAttempts(dir, [liveLatchLine(770)]);
    const before = sidecarBytes(dir);
    const { drain, counts, delivered } = harness(dir);

    const res = await drain.drainOnce(dir, 'main');

    expect(delivered).toEqual([]);
    expect(res.stoppedAt).toMatchObject({
      updateId: 770,
      reason: 'legacy_journal_gate:protocol_conflict',
      resolutionRequired: true,
    });
    expect(res.stoppedAt.legacyGate.detail).toEqual({ attempt: true, disposition: false });
    expect(queue.readPending(dir).map((r) => r.updateId)).toEqual([770, 771]);
    expectNoSideEffects(counts);
    expect(sidecarBytes(dir)).toEqual(before);
  });

  test('A DISPOSITION match is a protocol conflict too, not a retirement', async () => {
    const base = tempRoot();
    const dir = seedDecisionV1(base, [775]);
    writeDispositions(dir, [JSON.stringify({
      updateId: 775, disposition: 'empty_body', evidence: 'nothing in the body',
    })]);
    const { drain, counts } = harness(dir);

    const res = await drain.drainOnce(dir, 'main');

    expect(res.stoppedAt.reason).toBe('legacy_journal_gate:protocol_conflict');
    expect(queue.readPending(dir)).toHaveLength(1);
    expectNoSideEffects(counts);
  });

  test('A CLEAN post-cutover source holds for the stable fence Step 3 has not built', async () => {
    const base = tempRoot();
    const dir = seedDecisionV1(base, [780, 781]);
    const { drain, counts, delivered } = harness(dir);

    const res = await drain.drainOnce(dir, 'main');

    expect(delivered).toEqual([]);
    expect(res.stoppedAt).toMatchObject({
      updateId: 780,
      reason: 'legacy_journal_gate:decision_requires_stable_fence',
      resolutionRequired: true,
    });
    expect(queue.readPending(dir).map((r) => r.updateId)).toEqual([780, 781]);
    expectNoSideEffects(counts);
  });
});

// ------------------------------------------- record vs sidecar reconciliation

describe('record-carried terminalDisposition is reconciled with the sidecar, not preferred over it', () => {
  test('RECORD ONLY retires, as it always did', async () => {
    const base = tempRoot();
    const dir = seedLegacy(base, [790], { terminalDisposition: 'empty_body' });
    const { drain, counts, delivered } = harness(dir);

    const res = await drain.drainOnce(dir, 'main');

    expect(delivered).toEqual([]);
    expect(res.delivered).toBe(1);
    expect(counts.ack).toBe(1);
    expect(queue.readPending(dir)).toHaveLength(0);
  });

  test('MATCHING record and sidecar retire ONCE', async () => {
    const base = tempRoot();
    const dir = seedLegacy(base, [791], { terminalDisposition: 'empty_body' });
    writeDispositions(dir, [JSON.stringify({
      updateId: 791, disposition: 'empty_body', evidence: 'nothing in the body',
    })]);
    const { drain, counts, delivered } = harness(dir);

    const res = await drain.drainOnce(dir, 'main');

    expect(delivered).toEqual([]);
    expect(res.delivered).toBe(1);
    // ONE ack, one retirement. Two authorities agreeing is still one record.
    expect(counts.ack).toBe(1);
    expect(queue.readPending(dir)).toHaveLength(0);
  });

  test('DIFFERING record and sidecar HOLD with zero side effects', async () => {
    // `record.terminalDisposition || overlaid.disposition` never compared these
    // at all: the record's value was returned and the sidecar's was not read,
    // under a comment claiming the record "wins" so history could not be
    // quietly reclassified. The disagreement is the finding.
    const base = tempRoot();
    const dir = seedLegacy(base, [792, 793], { terminalDisposition: 'empty_body' });
    writeDispositions(dir, [JSON.stringify({
      updateId: 792, disposition: 'consumed_verified_out_of_band', evidence: 'answered out of band',
    })]);
    const before = sidecarBytes(dir);
    const { drain, counts, delivered } = harness(dir);

    const res = await drain.drainOnce(dir, 'main');

    expect(delivered).toEqual([]);
    expect(res.stoppedAt).toMatchObject({
      updateId: 792,
      reason: 'terminal_disposition_conflict',
      resolutionRequired: true,
    });
    expect(res.stoppedAt.legacyGate.detail).toEqual({
      record: 'empty_body',
      sidecar: 'consumed_verified_out_of_band',
    });
    expect(queue.readPending(dir).map((r) => r.updateId)).toEqual([792, 793]);
    expectNoSideEffects(counts);
    expect(sidecarBytes(dir)).toEqual(before);
  });

  test('AN UNRECOGNISED record value HOLDS', async () => {
    const base = tempRoot();
    const dir = seedLegacy(base, [794], { terminalDisposition: 'looks_fine_to_me' });
    const { drain, counts } = harness(dir);

    const res = await drain.drainOnce(dir, 'main');

    expect(res.stoppedAt).toMatchObject({ updateId: 794, reason: 'unknown_terminal_disposition' });
    expect(queue.readPending(dir)).toHaveLength(1);
    expectNoSideEffects(counts);
  });

  test.each([
    ['empty string', ''],
    ['whitespace only', '   '],
    ['a number', 42],
    ['an object', { disposition: 'empty_body' }],
    ['an array', ['empty_body']],
    ['boolean false', false],
  ])('A PRESENT-BUT-INVALID record value is not absence: %s', async (_label, value) => {
    // Architect #122. The obvious guard —
    //   typeof x === 'string' && x.trim() ? x.trim() : null
    // — normalises every one of these INTO absence, so a record whose
    // disposition field is corrupt gets delivered as though it never had one.
    // Absent is `null`/`undefined`; anything else present is unreadable.
    const base = tempRoot();
    const dir = seedRawRecord(base, { ...legacyRecord(795), terminalDisposition: value });
    const { drain, counts, delivered } = harness(dir);

    const res = await drain.drainOnce(dir, 'main');

    expect(delivered).toEqual([]);
    expect(res.stoppedAt).toMatchObject({ updateId: 795, reason: 'unknown_record_terminal_disposition' });
    expect(queue.readPending(dir)).toHaveLength(1);
    expectNoSideEffects(counts);
  });

  test.each([
    ['null', null],
    ['undefined', undefined],
  ])('ABSENT really is absent: %s delivers normally', async (_label, value) => {
    const base = tempRoot();
    const dir = seedRawRecord(base, { ...legacyRecord(796), terminalDisposition: value });
    const { drain, delivered } = harness(dir);

    await drain.drainOnce(dir, 'main');

    expect(delivered).toEqual([796]);
  });

  test('A PROTOTYPE-BORROWED disposition is not the record\'s own', async () => {
    // The classifier reads own properties for the same reason: a
    // classification satisfiable through a prototype is one that can be
    // borrowed. Here the borrowed value is a RECOGNISED one, so a prototype
    // read would retire an undelivered message.
    const base = tempRoot();
    const dir = seedRawRecord(base, legacyRecord(797));
    const { drain, delivered } = harness(dir);
    // Records come off the journal as plain objects; poison the prototype to
    // prove the drain never consults it.
    // eslint-disable-next-line no-extend-native
    Object.defineProperty(Object.prototype, 'terminalDisposition', {
      value: 'empty_body', configurable: true, enumerable: false, writable: true,
    });
    try {
      await drain.drainOnce(dir, 'main');
    } finally {
      delete Object.prototype.terminalDisposition;
    }

    expect(delivered).toEqual([797]);
  });
});

// -------------------------------------------------------------- ordering

describe('strict ordering survives the gate', () => {
  test('a held head leaves every later record pending across repeated passes', async () => {
    const base = tempRoot();
    const dir = seedLegacy(base, [800, 801, 802]);
    writeAttempts(dir, [liveLatchLine(801)]);
    const { drain, counts, delivered } = harness(dir);

    await drain.drainOnce(dir, 'main');
    const res = await drain.drainOnce(dir, 'main');

    // 800 drained; 801 holds; 802 never moves, however many passes run.
    expect(delivered).toEqual([800]);
    expect(res.stoppedAt.updateId).toBe(801);
    expect(queue.readPending(dir).map((r) => r.updateId)).toEqual([801, 802]);
    // Two passes, two reads of each sidecar - one per pass, not per record.
    expect(counts.attemptsRead).toBe(2);
    expect(counts.dispositionsRead).toBe(2);
  });
});

// ----------------------------------------------------- the decision seam

describe('zero deliver is zero decision, because there is no second door', () => {
  test('PRODUCTION passes exactly one outbound routing seam to the coordinator', () => {
    // v11 line 59 lists a decision-seam counter. v7's symmetric pane|mira
    // decision is Step 4 and does not exist yet, so counting "the decision
    // module" would mean inventing one - and a counter over a module nobody
    // calls proves nothing. This is the honest substitute: enumerate what the
    // app ACTUALLY hands the coordinator, and show that only `deliver` can
    // route anything. If Step 4 adds a decision seam here, this test fails and
    // whoever adds it has to come back and count it.
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'modules', 'main', 'squidrun-app.js'), 'utf8'
    );
    const lines = source.split('\n');
    const start = lines.findIndex((l) => l.includes('telegramIngressDrain.createDrainCoordinator({'));
    expect(start).toBeGreaterThan(-1);
    const keys = [];
    for (let i = start + 1; i < lines.length; i += 1) {
      if (/^\s*\}\);\s*$/.test(lines[i])) break;
      // `key: value` and the shorthand `key,` are both properties; a regex
      // that only saw the first would silently under-count the seams.
      const match = lines[i].match(/^\s{8}([A-Za-z_]\w*)\s*(?::|,\s*$)/);
      if (match) keys.push(match[1]);
    }
    expect(keys.sort()).toEqual([
      // v7 §3 Phase L, added by Step 2B. It reads the operating state and
      // routes nothing, so it does not widen the outbound surface.
      'activationMode',
      'closeUnsentTransportClaim',
      'currentSessionFor',
      'deliver',
      'findExistingReceipt',
      'log',
      'lookupTransportClaim',
      'paneRuntimeFor',
      'receiptActivity',
      'resolveRoute',
      'sessionGeneration',
    ]);
    // The one seam that sends anything anywhere, and the transport choice lives
    // strictly behind it.
    expect(source).toContain('deliver: (job) => this.deliverTelegramInboundJob(this.buildTelegramInboundJob(job))');
  });

  test('THE COORDINATOR ITSELF imports no transport-decision surface', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'modules', 'main', 'telegram-ingress-drain.js'), 'utf8'
    );
    const required = [...source.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]).sort();
    expect(required).toEqual([
      './telegram-activation-mode',
      './telegram-attempt-authority',
      './telegram-consumption-proof',
      './telegram-ingress-spool',
      './telegram-legacy-journal',
      '../telegram-inbound-durable-queue',
      'path',
    ].sort());
    // `decision_v1` appears only as a SOURCE PROTOCOL name in prose and gate
    // comparisons; nothing here writes or reads a transport decision.
    expect(source).not.toMatch(/telegram_transport_decisions|transport:\s*'mira'|telegram-mira/);
  });

  test('every HOLD in this suite is also a zero-decision hold', async () => {
    // The counter, exercised on the path that matters most: the live shape.
    const base = tempRoot();
    const dir = seedLegacy(base, [LIVE_LATCH, 808499317]);
    writeAttempts(dir, [liveLatchLine(LIVE_LATCH)]);
    const { drain, counts } = harness(dir);

    await drain.drainOnce(dir, 'main');

    expect(counts.deliver).toBe(0);
    expect(counts.decisionSeam).toBe(0);
  });
});

// ------------------------------------------------------- the ack boundary

describe('the crash boundary at the activation action: terminal retirement whose ack fails', () => {
  function seedResolvedLiveShape(base) {
    const dir = seedLegacy(base, [LIVE_LATCH, 808499317]);
    writeAttempts(dir, [liveLatchLine(LIVE_LATCH)]);
    writeDispositions(dir, [JSON.stringify({
      updateId: LIVE_LATCH,
      disposition: 'consumed_verified_out_of_band',
      evidence: 'answered as Telegram 22314 / ledger 78453',
    })]);
    return dir;
  }

  test.each([
    ['ack returns false', () => ({ ok: false, reason: 'eio' })],
    ['ack throws', () => { throw new Error('EIO'); }],
  ])('%s: 316 stays head, 317 stays pending, and nothing was injected', async (_label, failingAck) => {
    // This is the exact action Step 2B will perform in production - apply the
    // reviewed disposition and retire 316 without showing it to anyone - so the
    // failure in the middle of it is the one that must not lose or duplicate.
    const base = tempRoot();
    const dir = seedResolvedLiveShape(base);
    const before = sidecarBytes(dir);
    const { drain, counts, delivered } = harness(dir, { ack: failingAck });

    const res = await drain.drainOnce(dir, 'main');

    expect(delivered).toEqual([]);
    expect(counts.deliver).toBe(0);
    expect(counts.decisionSeam).toBe(0);
    expect(counts.claimLookup).toBe(0);
    expect(counts.claimClose).toBe(0);
    expect(counts.receiptLookup).toBe(0);
    expect(counts.attemptAppend).toBe(0);
    expect(counts.dispositionAppend).toBe(0);
    // EXACTLY ONE ack attempt. A retry loop here would be a second attempt to
    // retire a record whose first attempt's outcome is unknown.
    expect(counts.ack).toBe(1);
    expect(res.stoppedAt).toMatchObject({ updateId: LIVE_LATCH, reason: 'ack_failed' });
    // Head unchanged, and 317 did not slip past it.
    expect(queue.readPending(dir).map((r) => r.updateId)).toEqual([LIVE_LATCH, 808499317]);
    expect(sidecarBytes(dir)).toEqual(before);
  });

  test('a RESTORED ack retires 316 without injection and only then reaches 317', async () => {
    const base = tempRoot();
    const dir = seedResolvedLiveShape(base);
    let acksFail = true;
    const { drain, counts, delivered } = harness(dir, {
      ack: (...args) => {
        if (acksFail) return { ok: false, reason: 'eio' };
        return queue.ack(...args);
      },
    });

    const first = await drain.drainOnce(dir, 'main');
    expect(first.stoppedAt.reason).toBe('ack_failed');
    expect(delivered).toEqual([]);

    acksFail = false;
    const second = await drain.drainOnce(dir, 'main');

    // 316 retired terminally on the second pass; 317 delivered behind it, once.
    expect(second.stoppedAt).toBe(null);
    expect(delivered).toEqual([808499317]);
    expect(queue.readPending(dir)).toHaveLength(0);
    // Three ack attempts total: the failed one, then 316 and 317.
    expect(counts.ack).toBe(3);
    expect(counts.deliver).toBe(1);
    expect(counts.decisionSeam).toBe(1);
  });
});

// -------------------------------------------------- storage-ownership attack

describe('the injected queue owns WHERE the sidecars are, and a useless answer reads nothing', () => {
  /** A coordinator whose queue path methods are hostile. */
  function withPaths(dir, paths) {
    const reads = [];
    const drain = createDrainCoordinator({
      queue: { ...queue, ...paths },
      log: silentLog,
      resolveRoute: () => ({ ok: true, profile: 'main', windowKey: 'main' }),
      currentSessionFor: () => 'session-now',
      sessionGeneration: () => GENERATION,
      activationMode: () => LEGACY_SETTLEMENT,
      readJournalFile: (file) => { reads.push(file); return fs.readFileSync(file, 'utf8'); },
      lookupTransportClaim: async () => { throw new Error('claim lookup must not be reached'); },
      deliver: async () => { throw new Error('deliver must not be reached'); },
    });
    return { drain, reads };
  }

  test.each([
    ['an empty string', ''],
    ['whitespace', '   '],
    ['null', null],
    ['a number', 7],
  ])('an ATTEMPTS path of %s fails the snapshot closed and reads nothing', async (_label, value) => {
    // The guard this replaces read `''` as "not supplied" and fell back to
    // joining `dir` itself — the half-owned storage bug, reopened by the check
    // written to close it (Architect #125).
    const base = tempRoot();
    const dir = seedLegacy(base, [850]);
    const { drain, reads } = withPaths(dir, { attemptsPath: () => value });

    const res = await drain.drainOnce(dir, 'main');

    expect(res.stoppedAt).toMatchObject({
      updateId: 850,
      reason: 'legacy_journal_gate:journal_path_unresolved',
      resolutionRequired: true,
    });
    expect(reads).toEqual([]);
    expect(queue.readPending(dir)).toHaveLength(1);
  });

  test('a DISPOSITIONS path that is unusable fails the same way', async () => {
    const base = tempRoot();
    const dir = seedLegacy(base, [851]);
    const { drain, reads } = withPaths(dir, { dispositionsPath: () => '' });

    const res = await drain.drainOnce(dir, 'main');

    expect(res.stoppedAt.reason).toBe('legacy_journal_gate:journal_path_unresolved');
    expect(reads).toEqual([]);
  });

  test('TWO JOURNALS COLLAPSED TO ONE PATH is refused, not read twice', async () => {
    // Both empty reads of one file would validate as a clean attempts journal
    // AND a clean dispositions journal, so every comparison below would be
    // made against an authority wearing both hats.
    const base = tempRoot();
    const dir = seedLegacy(base, [852]);
    const collapsed = queue.attemptsPath(dir);
    const { drain, reads } = withPaths(dir, { dispositionsPath: () => collapsed });

    const res = await drain.drainOnce(dir, 'main');

    expect(res.stoppedAt.reason).toBe('legacy_journal_gate:journal_path_collision');
    expect(reads).toEqual([]);
    expect(queue.readPending(dir)).toHaveLength(1);
  });

  test('a THROWING path method holds instead of falling back to our own derivation', async () => {
    const base = tempRoot();
    const dir = seedLegacy(base, [853]);
    const { drain, reads } = withPaths(dir, {
      attemptsPath: () => { throw new Error('storage offline'); },
    });

    const res = await drain.drainOnce(dir, 'main');

    expect(res.stoppedAt.reason).toBe('legacy_journal_gate:journal_snapshot_threw:storage offline');
    expect(reads).toEqual([]);
  });

  test('a queue missing the path API is refused at construction', () => {
    const { attemptsPath, ...withoutAttemptsPath } = queue;
    expect(() => createDrainCoordinator({ queue: withoutAttemptsPath, log: silentLog }))
      .toThrow(/attemptsPath/);
  });

  test('THE JOURNAL MODULE ITSELF refuses a present-but-empty override', () => {
    // Closed at both ends: the drain validates before calling, and the reader
    // will not silently derive its own path for a caller that named the key.
    // The `reader_` prefix names WHICH layer refused, so neither check can
    // silently cover for the other's deletion.
    const unresolved = legacyJournal.readLegacyJournalSnapshot('/nowhere', { attemptsFile: '' });
    expect(unresolved.ok).toBe(false);
    expect(unresolved.reason).toBe('reader_journal_path_unresolved');
    expect(unresolved.reads).toEqual({ attempts: 0, dispositions: 0 });

    const collided = legacyJournal.readLegacyJournalSnapshot('/nowhere', {
      attemptsFile: '/tmp/one.jsonl',
      dispositionsFile: '/tmp/one.jsonl',
    });
    expect(collided.ok).toBe(false);
    expect(collided.reason).toBe('reader_journal_path_collision');
    expect(collided.reads).toEqual({ attempts: 0, dispositions: 0 });
  });
});

// ------------------------------------------------------- mutation attack

describe('the recognised sets cannot be widened by a consumer', () => {
  test('the exported value lists refuse mutation', () => {
    // `Object.freeze(new Set([...]))` does NOT freeze the collection: .add(),
    // .delete() and .clear() all still work on a "frozen" Set, silently. A
    // frozen ARRAY does not have that hole (Architect #121).
    expect(() => legacyJournal.ATTEMPT_STATE_VALUES.push('delivered')).toThrow();
    expect(() => legacyJournal.TERMINAL_DISPOSITION_VALUES.push('looks_fine_to_me')).toThrow();
    expect(legacyJournal.ATTEMPT_STATE_VALUES).toEqual(['attempted', 'retryable']);
    expect(legacyJournal.TERMINAL_DISPOSITION_VALUES).toEqual(['empty_body', 'consumed_verified_out_of_band']);
  });

  test('THE EXPORTS OBJECT IS FROZEN, so require order is not a security assumption', () => {
    // Private Sets closed "widen the list". They left this open: mutating the
    // CACHED exports object hands the replacement to every module that
    // destructures afterwards. The drain loads early today, which makes the
    // hole invisible and turns "is this safe?" into a question about import
    // order (Architect #127).
    expect(Object.isFrozen(legacyJournal)).toBe(true);

    const original = legacyJournal.isRecognizedTerminalDisposition;
    // Sloppy mode: the assignment silently no-ops rather than throwing, which
    // is exactly why asserting the OUTCOME matters more than asserting a throw.
    try { legacyJournal.isRecognizedTerminalDisposition = () => true; } catch { /* strict callers throw */ }
    expect(legacyJournal.isRecognizedTerminalDisposition).toBe(original);
    expect(legacyJournal.isRecognizedTerminalDisposition('looks_fine_to_me')).toBe(false);
    expect(() => { legacyJournal.newlyAdded = 1; }).not.toThrow();
    expect(legacyJournal.newlyAdded).toBeUndefined();
  });

  test('a predicate replacement attempted BEFORE the drain runs still cannot retire an unknown value', async () => {
    // The attack in its real shape: mutate first, then drive the production
    // drain. A cached-lookup implementation would now retire an undelivered
    // message on a string nobody defined.
    try { legacyJournal.isRecognizedAttemptState = () => true; } catch { /* frozen */ }
    try { legacyJournal.isRecognizedTerminalDisposition = () => true; } catch { /* frozen */ }

    const base = tempRoot();
    const dir = seedLegacy(base, [810], { terminalDisposition: 'looks_fine_to_me' });
    writeAttempts(dir, ['{"updateId":810,"state":"delivered"}']);
    const { drain, counts, delivered } = harness(dir);

    const res = await drain.drainOnce(dir, 'main');

    // The unknown STATE still fails the snapshot, so nothing was retired.
    expect(delivered).toEqual([]);
    expect(res.stoppedAt.reason).toBe('legacy_journal_gate:attempt_unknown_state');
    expect(queue.readPending(dir)).toHaveLength(1);
    expectNoSideEffects(counts);
  });

  test('and the unknown RECORD disposition still holds under the same attack', async () => {
    try { legacyJournal.isRecognizedTerminalDisposition = () => true; } catch { /* frozen */ }

    const base = tempRoot();
    const dir = seedLegacy(base, [811], { terminalDisposition: 'looks_fine_to_me' });
    const { drain, counts, delivered } = harness(dir);

    const res = await drain.drainOnce(dir, 'main');

    expect(delivered).toEqual([]);
    expect(res.stoppedAt.reason).toBe('unknown_terminal_disposition');
    expect(queue.readPending(dir)).toHaveLength(1);
    expectNoSideEffects(counts);
  });
});
