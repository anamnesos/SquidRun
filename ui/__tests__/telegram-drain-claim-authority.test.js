/**
 * B5 — THE DRAIN'S DECISION LAYER MOVES ONTO THE DB CLAIM.
 *
 * These drive the REAL drain coordinator, the REAL durable queue on a temp
 * directory, and the REAL admission sequence on a temp SQLite ledger. The only
 * fakes are the pane (an array of writes) and the terminal-proof lookup, which
 * has its own suite.
 *
 * What each group defends:
 *
 *  - ONE LATCH PER ATTEMPT. No JSONL attempt is written before delivery any
 *    more, and the claim the sequence creates is what the next pass reads.
 *  - THE LEGACY LATCH STILL RULES ITS OWN RECORDS. 808499316's shape keeps its
 *    old diagnosis and never grows a claim.
 *  - EVERY CRASH WINDOW. Before source, source only, claimed before D, after D
 *    before pane, after pane before proof, proof before ack, ack failure.
 *  - RESTART. A dead generation's unsent claim is released; a dead generation's
 *    STARTED claim is never released, and never re-delivered.
 *  - CANNOT-TELL IS A HOLD. An unreadable claim store never delivers.
 *
 * TEMP DATABASES ONLY. The live evidence ledger is never opened here.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const queue = require('../modules/telegram-inbound-durable-queue');
const {
  CLAIM_STATES,
  TELEGRAM_CUTOVER_ID,
  applyTelegramAdmissionSchema,
  closeUnsentClaim,
  readTransportClaim,
} = require('../modules/main/telegram-admission-store');
const {
  generateLaunchId,
  recordPaneLaunch,
  completePaneLaunch,
  bindConsumerSession,
} = require('../modules/main/telegram-launch-registry');
const { TelegramAdmissionWriter } = require('../modules/main/telegram-admission-writer');
const { findTransportClaim } = require('../modules/main/telegram-claim-lookup');
const {
  classifyClaimantLiveness,
  claimAttemptView,
  decideClaimDisposition,
} = require('../modules/main/telegram-attempt-authority');
const { runTelegramAdmissionSequence, MODES } = require('../modules/main/telegram-admission-sequence');
const { createDrainCoordinator } = require('../modules/main/telegram-ingress-drain');

const BASE_MS = 1785870000000;
const GEN_A = 'app-session-491';
const GEN_B = 'app-session-492';
const CHAT_ID = REDACTED;

const tempRoots = [];
const openWriters = [];
const coordinators = [];

function tempRoot(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function freshLedger(generations = [GEN_A, GEN_B]) {
  const root = tempRoot('tg-b5-db-');
  const writer = new TelegramAdmissionWriter({ dbPath: path.join(root, 'ledger.db') });
  const opened = writer.open();
  if (!opened.ok) throw new Error(`writer open failed: ${JSON.stringify(opened)}`);
  openWriters.push(writer);
  applyTelegramAdmissionSchema(writer.db);
  // A REAL, BOUND, COMPLETE launch per generation — exactly what SessionStart
  // leaves behind. `findActivePaneLaunch` refuses anything less, so without
  // these the sequence would refuse at B and every test below would pass for
  // the wrong reason.
  for (const appGeneration of generations) {
    const launchId = generateLaunchId();
    recordPaneLaunch(writer.db, {
      launchId,
      appGeneration,
      paneId: '1',
      role: 'architect',
      consumerRuntime: 'codex',
      daemonProcessId: '4242',
      launchedAtMs: BASE_MS - 9000,
    });
    bindConsumerSession(writer.db, {
      consumerSessionId: `sess-${launchId}`,
      launchId,
      consumerRuntime: 'codex',
      boundAtMs: BASE_MS - 8000,
    });
    completePaneLaunch(writer.db, { launchId, atMs: BASE_MS - 7000 });
  }
  return writer;
}

function queueRecord(updateId, text = 'is the water heater quote ready') {
  return {
    updateId,
    messageId: 22000 + (updateId % 1000),
    text,
    from: 'James',
    chatId: CHAT_ID,
    profile: 'main',
    route: 'main',
    targetProfile: 'main',
    targetWindow: 'main',
    targetSession: 'app-session-490',
    timestampMs: BASE_MS - 60000,
    rawMetadata: { chatId: CHAT_ID },
  };
}

function seedQueue(records) {
  const root = tempRoot('tg-b5-queue-');
  const dir = path.join(root, 'main');
  fs.mkdirSync(dir, { recursive: true });
  for (const record of records) queue.append(dir, record);
  return dir;
}

/**
 * The harness. `deliver` runs the REAL A-B-C-D sequence against the temp
 * ledger and then "writes the pane" by pushing the authorised bytes onto an
 * array, which is exactly the production shape: nothing between D and E may
 * touch the string.
 */
function makeHarness(options = {}) {
  const writer = options.writer || freshLedger();
  const dir = options.dir || seedQueue(options.records || [queueRecord(900000601)]);
  const paneWrites = [];
  const state = {
    generation: options.generation || GEN_B,
    nowMs: options.nowMs || BASE_MS,
    // Where the delivery is told to stop, so a crash window can be placed
    // exactly: 'before_source' | 'before_claim' | 'after_claim' | null.
    failAt: options.failAt || null,
    receipt: options.receipt || null,
    lookupThrows: options.lookupThrows || false,
    failAck: options.failAck || false,
    deliveries: 0,
  };

  async function deliver(job) {
    state.deliveries += 1;
    const identity = {
      messageId: job.messageId,
      routeKey: job.routeKey,
      windowKey: job.windowKey,
      profile: job.profile,
    };
    if (state.failAt === 'before_source') {
      // A refusal before A: nothing recorded, nothing latched, retryable.
      return { ok: false, status: 'admission_refused:writer_unavailable', ...identity };
    }
    const result = await runTelegramAdmissionSequence({
      db: writer.db,
      job: {
        messageId: job.messageId,
        updateId: job.updateId,
        chatId: job.chatId,
        routeKey: job.routeKey,
        profile: job.profile,
        windowKey: job.windowKey,
        rawBody: job.text,
        sessionId: job.record?.targetSession || null,
        sentAtMs: job.record?.timestampMs,
      },
      record: job.record || {},
      appGeneration: state.generation,
      mode: state.failAt === 'source_only' ? MODES.SOURCE_ONLY : MODES.FULL,
      composeFinalBody: async () => {
        if (state.failAt === 'after_claim') throw new Error('compose exploded');
        return `[Telegram from ${job.from}]: ${job.text}`;
      },
      now: () => state.nowMs,
      // A FRESH NONCE PER ATTEMPT, exactly as production mints one. A
      // deterministic nonce made a re-claim after a close hash to the SAME
      // claim id and collide with the closed row — a test artefact that would
      // otherwise read as the kernel refusing a legitimate retry.
      nonce: () => `n_${job.updateId}_${state.generation}_${state.deliveries}`,
      // eslint-disable-next-line no-nested-ternary
      steps: state.failAt === 'before_claim'
        ? { claimTransportAttempt: () => ({ ok: false, reason: 'claim_refused_by_test' }) }
        // A CRASH, not a refusal: the claim is written and then the process
        // dies. Nothing hands the drain a receipt, so nothing closes the claim
        // on first-hand evidence, and it is left exactly as a killed boot would
        // leave it. This is the only way to reach the dead-generation rule.
        : state.failAt === 'crash_after_claim'
          ? { recordDeliveryStarted: () => { throw new Error('crash after claim'); } }
          : {},
    });
    if (!result.ok) {
      return {
        ok: false,
        status: `admission_refused:${result.reason}`,
        admissionStage: result.stage,
        admissionPhase: result.phase,
        ...identity,
      };
    }
    if (state.failAt === 'after_delivery_started') {
      // D committed, the pane write never happened. AMBIGUOUS by construction:
      // this process cannot prove the bytes did not land.
      return { ok: false, accepted: true, ambiguous: true, status: 'main_pane_runtime_error', ...identity };
    }
    paneWrites.push({ updateId: job.updateId, text: result.authorized.text, generation: state.generation });
    return {
      ok: true,
      status: 'delivered.verified',
      verified: true,
      ...identity,
    };
  }

  function build(overrides = {}) {
    const coordinator = createDrainCoordinator({
      // ACK IS FAILABLE ON PURPOSE. "Delivered but never retired" is the crash
      // window that produced the duplicate, and it cannot be reached with a
      // queue that always acks.
      queue: {
        ...queue,
        ack: (...args) => (state.failAck ? { ok: false, reason: 'test_ack_failure' } : queue.ack(...args)),
      },
      resolveRoute: () => ({ ok: true, profile: 'main', windowKey: 'main' }),
      currentSessionFor: () => 'app-session-492',
      deliver,
      findExistingReceipt: overrides.findExistingReceipt || (async () => state.receipt),
      lookupTransportClaim: overrides.lookupTransportClaim || (async (query) => {
        if (state.lookupThrows) throw new Error('claim store unavailable: EIO');
        return findTransportClaim({
          updateId: query.updateId,
          routeKey: query.routeKey,
          // A FRESH HANDLE PER LOOKUP, exactly as `resolveAdmissionWriter`
          // mints one per admission. The lookup closes what it opens, so
          // handing it a shared writer would close the harness's own db
          // underneath the sequence — which is how the first run of this suite
          // reported `sequence_no_durable_handle` for 13 unrelated reasons.
          writerFactory: () => new TelegramAdmissionWriter({ dbPath: writer.dbPath }),
        });
      }),
      closeUnsentTransportClaim: overrides.closeUnsentTransportClaim
        || (async (input) => closeUnsentClaim(writer.db, input)),
      sessionGeneration: () => state.generation,
      paneRuntimeFor: () => 'codex',
      receiptActivity: () => null,
      now: () => state.nowMs,
      log: { info() {}, warn() {}, error() {} },
      ...overrides.deps,
    });
    coordinators.push(coordinator);
    return coordinator;
  }

  return { writer, dir, paneWrites, state, deliver, build };
}

function readClaim(writer, updateId) {
  const read = readTransportClaim(writer.db, {
    cutoverId: TELEGRAM_CUTOVER_ID,
    routeKey: 'main',
    updateId,
  });
  if (!read.ok) throw new Error(`claim read failed: ${read.reason}`);
  return read;
}

afterEach(async () => {
  for (const coordinator of coordinators.splice(0)) {
    try { await coordinator.dispose(); } catch { /* already torn down */ }
  }
});

afterAll(() => {
  for (const writer of openWriters.splice(0)) {
    try { writer.close(); } catch { /* already closed */ }
  }
  for (const root of tempRoots.splice(0)) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// =====================================================================
// 1. THE DECISION LAYER, EXHAUSTIVELY, WITHOUT A DATABASE
// =====================================================================
describe('claim disposition', () => {
  const claim = (over = {}) => ({
    claimId: 'tgc_x',
    state: CLAIM_STATES.CLAIMED,
    appGeneration: GEN_A,
    attemptAtMs: BASE_MS - 1000,
    attemptNonce: 'n_1',
    deliveryStartedAtMs: null,
    ...over,
  });

  test('no claim is the only clean permission to deliver', () => {
    expect(decideClaimDisposition({ claim: null, currentGeneration: GEN_B }))
      .toMatchObject({ action: 'attempt', reason: 'no_claim' });
  });

  test('closed_unsent releases the slot', () => {
    expect(decideClaimDisposition({
      claim: claim({ state: CLAIM_STATES.CLOSED_UNSENT }),
      currentGeneration: GEN_B,
    })).toMatchObject({ action: 'attempt', reason: 'claim_closed_unsent' });
  });

  test('claimed by a superseded generation is provably unsent and closable', () => {
    const decision = decideClaimDisposition({ claim: claim(), currentGeneration: GEN_B });
    expect(decision.action).toBe('close_then_attempt');
    expect(decision.close).toMatchObject({ claimId: 'tgc_x', reason: `dead_generation:${GEN_A}` });
  });

  test('claimed by the CURRENT generation is never stolen', () => {
    expect(decideClaimDisposition({
      claim: claim({ appGeneration: GEN_B }),
      currentGeneration: GEN_B,
    })).toMatchObject({ action: 'hold', reason: 'claim_held_by_live_generation' });
  });

  test('unknown liveness holds instead of guessing dead', () => {
    // THE FAIL-OPEN THIS FORBIDS: an unnamed process concluding "not me, so
    // dead" and closing a claim another process is mid-sequence on.
    const decision = decideClaimDisposition({ claim: claim(), currentGeneration: '' });
    expect(decision.action).toBe('hold');
    expect(decision.reason).toBe('claim_liveness_unknown:current_generation_unpublished');
  });

  test('delivery_started holds even when the claimant is provably dead', () => {
    const decision = decideClaimDisposition({
      claim: claim({ state: CLAIM_STATES.DELIVERY_STARTED, deliveryStartedAtMs: BASE_MS }),
      currentGeneration: GEN_B,
    });
    expect(decision.action).toBe('hold');
    expect(decision.reason).toBe('claim_delivery_started_unproven');
    expect(decision.failureClass).toBe('awaiting_proof');
  });

  test('admitted without terminal proof demands explicit resolution', () => {
    const decision = decideClaimDisposition({
      claim: claim({ state: CLAIM_STATES.ADMITTED }),
      currentGeneration: GEN_B,
      proofOutcome: { proven: false, reason: 'no_evidence' },
    });
    expect(decision).toMatchObject({ action: 'hold', resolutionRequired: true });
  });

  test('an unrecognised state fails closed', () => {
    expect(decideClaimDisposition({ claim: claim({ state: 'weird' }), currentGeneration: GEN_B }))
      .toMatchObject({ action: 'hold', reason: 'claim_state_unknown:weird' });
  });

  test('liveness cannot be decided without both generations', () => {
    expect(classifyClaimantLiveness(GEN_A, GEN_A).live).toBe(true);
    expect(classifyClaimantLiveness(GEN_A, GEN_B).live).toBe(false);
    expect(classifyClaimantLiveness('', GEN_B).live).toBeNull();
    expect(classifyClaimantLiveness(GEN_A, '').live).toBeNull();
  });

  test('the attempt view projects the claim and invents nothing', () => {
    const view = claimAttemptView(claim());
    expect(view).toMatchObject({ state: 'attempted', atMs: BASE_MS - 1000, generation: GEN_A });
    expect(claimAttemptView(claim({ state: CLAIM_STATES.CLOSED_UNSENT }))).toBeNull();
    expect(claimAttemptView(null)).toBeNull();
  });
});

// =====================================================================
// 2. THE PRODUCTION SEAM
// =====================================================================
describe('drain over the real claim latch', () => {
  test('a first delivery writes the pane once, latches a claim, and writes NO jsonl attempt', async () => {
    const harness = makeHarness({ records: [queueRecord(900000601)] });
    const result = await harness.build().drainOnce(harness.dir, 'main');

    expect(result.delivered).toBe(1);
    expect(harness.paneWrites).toHaveLength(1);

    const claim = readClaim(harness.writer, 900000601).claim;
    expect(claim.state).toBe(CLAIM_STATES.DELIVERY_STARTED);
    expect(claim.appGeneration).toBe(GEN_B);
    expect(claim.deliveryStartedAtMs).toBe(BASE_MS);

    // THE SECOND LATCH IS GONE. Its existence was the whole defect: written
    // before the claim, it could survive a crash the claim never saw.
    expect(fs.existsSync(queue.attemptsPath(harness.dir))).toBe(false);
    expect(queue.readAttemptRecords(harness.dir).size).toBe(0);
  });

  test('the source session comes from the queued record, not the delivering session', async () => {
    const harness = makeHarness({ records: [queueRecord(900000602)] });
    await harness.build().drainOnce(harness.dir, 'main');
    const claim = readClaim(harness.writer, 900000602).claim;
    const row = harness.writer.db
      .prepare('SELECT source_session_id FROM telegram_source_identity WHERE source_row_id = ?')
      .get(claim.sourceRowId);
    expect(row.source_session_id).toBe('app-session-490');
    expect(row.source_session_id).not.toBe('app-session-492');
  });

  test('RESTART: a delivery_started claim from a dead generation holds and never re-delivers', async () => {
    // DELIVERED, THEN THE ACK FAILS: the record is still pending on disk while
    // the bytes are already on James's screen. This is the exact shape that put
    // a duplicate in front of him.
    const harness = makeHarness({
      records: [queueRecord(900000603)], generation: GEN_A, failAck: true,
    });
    const first = await harness.build().drainOnce(harness.dir, 'main');
    expect(harness.paneWrites).toHaveLength(1);
    expect(first.stoppedAt.reason).toBe('ack_failed');
    expect(queue.readPending(harness.dir)).toHaveLength(1);

    // The process ends. A new boot, a new generation, the same queue and the
    // same ledger.
    harness.state.failAck = false;
    harness.state.generation = GEN_B;
    harness.state.nowMs = BASE_MS + 60000;
    const second = await harness.build().drainOnce(harness.dir, 'main');

    expect(harness.paneWrites).toHaveLength(1);
    expect(second.delivered).toBe(0);
    // The reason uses the SAME vocabulary the legacy branch does, so health
    // keeps its runtime diagnosis across the cutover; the claim-specific fact
    // rides alongside it rather than replacing it.
    expect(second.stoppedAt.updateId).toBe(900000603);
    expect(second.stoppedAt.failureClass).toBe('awaiting_proof');
    expect(second.stoppedAt.reason).toMatch(/^(unprovable_pane|unresolved_delivery_attempt):/);
    expect(second.stoppedAt.claimDisposition).toMatchObject({
      state: 'delivery_started', claimGeneration: GEN_A,
    });
  });

  test('CRASH BEFORE SOURCE: nothing latched, and the next pass delivers normally', async () => {
    const harness = makeHarness({ records: [queueRecord(900000604)], failAt: 'before_source' });
    const first = await harness.build().drainOnce(harness.dir, 'main');
    expect(first.delivered).toBe(0);
    expect(readClaim(harness.writer, 900000604).claim).toBeNull();

    harness.state.failAt = null;
    const second = await harness.build().drainOnce(harness.dir, 'main');
    expect(second.delivered).toBe(1);
    expect(harness.paneWrites).toHaveLength(1);
  });

  test('CRASH AFTER SOURCE, BEFORE CLAIM: still retryable, and A is idempotent', async () => {
    const harness = makeHarness({ records: [queueRecord(900000605)], failAt: 'before_claim' });
    await harness.build().drainOnce(harness.dir, 'main');
    expect(readClaim(harness.writer, 900000605).claim).toBeNull();

    harness.state.failAt = null;
    harness.state.nowMs = BASE_MS + 1000;
    const second = await harness.build().drainOnce(harness.dir, 'main');
    expect(second.delivered).toBe(1);
    expect(harness.paneWrites).toHaveLength(1);
    // ONE source row for one message, across both attempts.
    const rows = harness.writer.db
      .prepare('SELECT COUNT(*) AS n FROM telegram_source_identity WHERE update_id = ?')
      .get(900000605);
    expect(rows.n).toBe(1);
  });

  test('A REFUSAL BEFORE D releases its own claim, so a compose failure is not a wedge', async () => {
    // The sequence refused at C. The transport told us, first-hand, that
    // nothing was written - so the claim is closed on that evidence instead of
    // being left for a dead-generation sweep that only a reboot can run.
    const harness = makeHarness({ records: [queueRecord(900000606)], failAt: 'after_claim' });
    const first = await harness.build().drainOnce(harness.dir, 'main');
    expect(first.delivered).toBe(0);
    expect(harness.paneWrites).toHaveLength(0);
    const afterRefusal = readClaim(harness.writer, 900000606);
    expect(afterRefusal.claim).toBeNull();
    expect(afterRefusal.closedClaims).toHaveLength(1);

    harness.state.failAt = null;
    const second = await harness.build().drainOnce(harness.dir, 'main');
    expect(second.delivered).toBe(1);
    expect(harness.paneWrites).toHaveLength(1);
  });

  test('A CRASH AFTER THE CLAIM under a LIVE generation is held, never stolen', async () => {
    const harness = makeHarness({ records: [queueRecord(900000616)], failAt: 'crash_after_claim' });
    const first = await harness.build().drainOnce(harness.dir, 'main');
    expect(first.stoppedAt.reason).toMatch(/^deliver_threw:/);
    expect(readClaim(harness.writer, 900000616).claim.state).toBe(CLAIM_STATES.CLAIMED);

    // Same generation: provably unsent, but a live claimant is never stolen.
    harness.state.failAt = null;
    const second = await harness.build().drainOnce(harness.dir, 'main');
    expect(second.stoppedAt.reason).toBe('claim_held_by_live_generation');
    expect(harness.paneWrites).toHaveLength(0);
  });

  test('CLAIMED BEFORE D by a dead generation: closed on the record, then delivered once', async () => {
    const harness = makeHarness({
      records: [queueRecord(900000607)], failAt: 'crash_after_claim', generation: GEN_A,
    });
    await harness.build().drainOnce(harness.dir, 'main');
    expect(readClaim(harness.writer, 900000607).claim.state).toBe(CLAIM_STATES.CLAIMED);

    harness.state.generation = GEN_B;
    harness.state.failAt = null;
    harness.state.nowMs = BASE_MS + 5000;
    const second = await harness.build().drainOnce(harness.dir, 'main');

    expect(second.delivered).toBe(1);
    expect(harness.paneWrites).toHaveLength(1);
    const read = readClaim(harness.writer, 900000607);
    expect(read.closedClaims).toHaveLength(1);
    expect(read.claim.state).toBe(CLAIM_STATES.DELIVERY_STARTED);
    expect(read.claim.appGeneration).toBe(GEN_B);
    // The close is a RECORD, not a side effect nobody can audit.
    const events = harness.writer.db
      .prepare('SELECT kind, detail FROM telegram_transport_events WHERE claim_id = ?')
      .all(read.closedClaims[0].claimId);
    expect(events.some((e) => e.kind === 'claim_closed_unsent' && e.detail.includes(GEN_A))).toBe(true);
  });

  test('AFTER D BEFORE PANE: ambiguous, and it stays ambiguous across a restart', async () => {
    const harness = makeHarness({
      records: [queueRecord(900000608)], failAt: 'after_delivery_started', generation: GEN_A,
    });
    const first = await harness.build().drainOnce(harness.dir, 'main');
    expect(first.stoppedAt.failureClass).toBe('awaiting_proof');
    expect(harness.paneWrites).toHaveLength(0);

    harness.state.generation = GEN_B;
    harness.state.failAt = null;
    const second = await harness.build().drainOnce(harness.dir, 'main');
    // NOT re-delivered even though no bytes ever reached a pane. We cannot
    // prove that from here, and guessing is how James reads it twice.
    expect(harness.paneWrites).toHaveLength(0);
    expect(second.stoppedAt.reason).toMatch(/^(unprovable_pane|unresolved_delivery_attempt):/);
    expect(second.stoppedAt.claimDisposition).toMatchObject({ state: 'delivery_started' });
  });

  test('a G attempt is retired by a G receipt observed under G+1, with exactly one ack', async () => {
    const harness = makeHarness({ records: [queueRecord(900000609)], generation: GEN_A });
    await harness.build().drainOnce(harness.dir, 'main');
    const acked = queue.readPending(harness.dir).length;
    expect(acked).toBe(0); // delivered and acked in the same pass

    // Now the harder shape: a record that was attempted under G and never
    // acked, whose proof arrives after the restart.
    const dir2 = seedQueue([queueRecord(900000610)]);
    const harness2 = makeHarness({ dir: dir2, generation: GEN_A, failAt: 'after_delivery_started' });
    await harness2.build().drainOnce(dir2, 'main');
    const claim = readClaim(harness2.writer, 900000610).claim;

    harness2.state.generation = GEN_B;
    harness2.state.failAt = null;
    harness2.state.receipt = {
      status: 'delivered.verified',
      verified: true,
      messageId: 'telegram-in-900000610',
      routeKey: 'main',
      windowKey: 'main',
      profile: 'main',
      chatId: String(CHAT_ID),
      // THE PROOF NAMES THE GENERATION THAT ATTEMPTED, not the one asking.
      generation: GEN_A,
      provedAtMs: claim.attemptAtMs + 10,
    };
    const result = await harness2.build().drainOnce(dir2, 'main');
    expect(result.delivered).toBe(1);
    expect(harness2.paneWrites).toHaveLength(0); // retired, never re-injected
    expect(queue.readPending(dir2)).toHaveLength(0);
  });

  test('a G+1 receipt may not retire a G attempt', async () => {
    const dir = seedQueue([queueRecord(900000611)]);
    const harness = makeHarness({ dir, generation: GEN_A, failAt: 'after_delivery_started' });
    await harness.build().drainOnce(dir, 'main');
    const claim = readClaim(harness.writer, 900000611).claim;

    harness.state.generation = GEN_B;
    harness.state.failAt = null;
    harness.state.receipt = {
      status: 'delivered.verified',
      verified: true,
      messageId: 'telegram-in-900000611',
      routeKey: 'main',
      windowKey: 'main',
      profile: 'main',
      chatId: String(CHAT_ID),
      generation: GEN_B,
      provedAtMs: claim.attemptAtMs + 10,
    };
    const result = await harness.build().drainOnce(dir, 'main');
    expect(result.delivered).toBe(0);
    expect(harness.paneWrites).toHaveLength(0);
    expect(queue.readPending(dir)).toHaveLength(1);
  });

  test('an unreadable claim store HOLDS and never delivers', async () => {
    const harness = makeHarness({ records: [queueRecord(900000612)], lookupThrows: true });
    const result = await harness.build().drainOnce(harness.dir, 'main');
    expect(result.delivered).toBe(0);
    expect(harness.paneWrites).toHaveLength(0);
    expect(result.stoppedAt.reason).toMatch(/^claim_lookup_failed:/);
    expect(result.stoppedAt.failureClass).toBe('awaiting_proof');
  });

  test('a coordinator wired without a claim lookup holds instead of delivering', async () => {
    const harness = makeHarness({ records: [queueRecord(900000613)] });
    const coordinator = harness.build({ deps: { lookupTransportClaim: undefined } });
    const result = await coordinator.drainOnce(harness.dir, 'main');
    expect(harness.paneWrites).toHaveLength(0);
    expect(result.stoppedAt.reason).toMatch(/claim_lookup_failed/);
  });

  test('a refused close never becomes a delivery', async () => {
    const harness = makeHarness({
      records: [queueRecord(900000614)], failAt: 'crash_after_claim', generation: GEN_A,
    });
    await harness.build().drainOnce(harness.dir, 'main');

    harness.state.generation = GEN_B;
    harness.state.failAt = null;
    const result = await harness.build({
      closeUnsentTransportClaim: async () => ({ ok: false, reason: 'claim_not_found' }),
    }).drainOnce(harness.dir, 'main');

    expect(harness.paneWrites).toHaveLength(0);
    expect(result.stoppedAt.reason).toBe('claim_close_refused:claim_not_found');
  });

  test('STRICT ORDER: N+1 never passes a held N', async () => {
    const harness = makeHarness({
      records: [queueRecord(900000620), queueRecord(900000621)],
      failAt: 'after_delivery_started',
      generation: GEN_A,
    });
    await harness.build().drainOnce(harness.dir, 'main');
    harness.state.failAt = null;
    harness.state.generation = GEN_B;
    const result = await harness.build().drainOnce(harness.dir, 'main');

    expect(result.stoppedAt.updateId).toBe(900000620);
    expect(harness.paneWrites).toHaveLength(0);
    expect(queue.readPending(harness.dir).map((r) => r.updateId)).toEqual([900000620, 900000621]);
  });

  test('CONCURRENT SCHEDULES: one claim, one pane write', async () => {
    const harness = makeHarness({ records: [queueRecord(900000622)] });
    const coordinator = harness.build();
    await Promise.all([
      coordinator.drainOnce(harness.dir, 'main'),
      coordinator.drainOnce(harness.dir, 'main'),
      coordinator.drainOnce(harness.dir, 'main'),
    ]);
    expect(harness.paneWrites).toHaveLength(1);
    const rows = harness.writer.db
      .prepare("SELECT COUNT(*) AS n FROM telegram_transport_claims WHERE update_id = ? AND state != 'closed_unsent'")
      .get(900000622);
    expect(rows.n).toBe(1);
  });
});

// =====================================================================
// 3. THE LEGACY LATCH KEEPS ITS OWN RECORDS
// =====================================================================
describe('pre-cutover records', () => {
  test("808499316's shape keeps its own diagnosis and is never asked about a claim", async () => {
    const harness = makeHarness({ records: [queueRecord(808499316)] });
    // The EXACT live latch: state only, no atMs, no generation.
    fs.writeFileSync(
      queue.attemptsPath(harness.dir),
      `${JSON.stringify({ updateId: 808499316, state: 'attempted' })}\n`,
      'utf8'
    );
    let claimAsked = 0;
    const result = await harness.build({
      lookupTransportClaim: async () => { claimAsked += 1; return null; },
    }).drainOnce(harness.dir, 'main');

    expect(claimAsked).toBe(0);
    expect(harness.paneWrites).toHaveLength(0);
    expect(result.stoppedAt).toMatchObject({
      reason: 'orphaned_attempt:attempt_time_unknown',
      resolutionRequired: true,
      unattainable: true,
    });
    // AND IT GREW NO CLAIM. A claim written for this record now would invent
    // the identity of a delivery that may already have reached James.
    expect(readClaim(harness.writer, 808499316).claim).toBeNull();
  });

  test('a RESOLVED legacy row is not an outstanding latch, so the claim decides', async () => {
    const harness = makeHarness({ records: [queueRecord(900000630)] });
    queue.appendAttempt(harness.dir, 900000630, 'retryable', {
      atMs: BASE_MS - 5000,
      generation: GEN_A,
    });
    const result = await harness.build().drainOnce(harness.dir, 'main');
    expect(result.delivered).toBe(1);
    expect(harness.paneWrites).toHaveLength(1);
  });

  test('an unreadable legacy journal still holds before anything else is read', async () => {
    const harness = makeHarness({ records: [queueRecord(900000631)] });
    fs.writeFileSync(queue.attemptsPath(harness.dir), 'not json at all\n', 'utf8');
    const result = await harness.build({
      lookupTransportClaim: async () => { throw new Error('should not be reached'); },
    }).drainOnce(harness.dir, 'main');
    expect(harness.paneWrites).toHaveLength(0);
    expect(result.stoppedAt.failureClass).toBe('awaiting_proof');
  });
});

// =====================================================================
// 4. THE LOOKUP ITSELF
// =====================================================================
describe('claim lookup', () => {
  test('an absent ledger has never claimed anything', () => {
    const root = tempRoot('tg-b5-absent-');
    expect(findTransportClaim({
      updateId: 1, routeKey: 'main', dbPath: path.join(root, 'nope.db'),
    })).toBeNull();
  });

  test('a ledger with no admission schema reads as no claim, not as an error', () => {
    const root = tempRoot('tg-b5-bare-');
    const writer = new TelegramAdmissionWriter({ dbPath: path.join(root, 'ledger.db') });
    writer.open();
    openWriters.push(writer);
    expect(findTransportClaim({
      updateId: 1, routeKey: 'main', writerFactory: () => writer,
    })).toBeNull();
  });

  test('a malformed question throws rather than answering safely-looking nonsense', () => {
    expect(() => findTransportClaim({ updateId: 0, routeKey: 'main' })).toThrow();
    expect(() => findTransportClaim({ updateId: 5, routeKey: '' })).toThrow();
  });

  test('two live claims for one update is ambiguous, never a pick', () => {
    const writer = freshLedger();
    const read = readTransportClaim(writer.db, {
      cutoverId: TELEGRAM_CUTOVER_ID, routeKey: 'main', updateId: 12345,
    });
    expect(read).toMatchObject({ ok: true, claim: null });
  });
});
