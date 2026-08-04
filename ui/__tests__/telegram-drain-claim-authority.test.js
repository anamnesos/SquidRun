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
  claimTransportAttempt,
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
const { claimReleaseFor } = require('../modules/main/telegram-admission-delivery');
const { createDrainCoordinator } = require('../modules/main/telegram-ingress-drain');

const BASE_MS = 1785870000000;
const GEN_A = 'app-session-491';
const GEN_B = 'app-session-492';
const CHAT_ID = REDACTED;

/**
 * A pane that has demonstrably answered before. The readiness gate above B
 * refuses on anything short of this, so every delivering test has to say it -
 * which is the point: a test that delivers into a pane which could never
 * produce a receipt was testing a permanent hold and calling it a delivery.
 */
const READY = Object.freeze({
  attainable: true, reason: 'runtime_proof_observed', runtime: 'codex', lastProofAtMs: BASE_MS - 1000,
});

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
    // Overridden only by the readiness tests, which need a pane that cannot
    // answer, throws, or lies about its shape.
    paneReadiness: options.paneReadiness || null,
    receipt: options.receipt || null,
    lookupThrows: options.lookupThrows || false,
    failAck: options.failAck || false,
    deliveries: 0,
    // COMPOSE IS COUNTED, not inferred from the claim count. A refusal above B
    // must mean the final bytes were never even built; asserting the effect is
    // the whole discipline here (Oracle #54).
    composes: 0,
    // The typed refusal the sequence returned, so a test can prove a shape was
    // REFUSED BY NAME rather than having escaped as an exception that merely
    // happened to leave the tables empty.
    lastRefusal: null,
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
      // The pane can answer, unless a test says otherwise. Production derives
      // this from observed receipt flow; the harness states it outright so a
      // readiness refusal in these tests is always the one the test asked for.
      paneReadiness: state.paneReadiness || (() => READY),
      mode: state.failAt === 'source_only' ? MODES.SOURCE_ONLY : MODES.FULL,
      composeFinalBody: async () => {
        state.composes += 1;
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
      state.lastRefusal = { stage: result.stage, reason: result.reason, phase: result.phase };
      return {
        ok: false,
        status: `admission_refused:${result.reason}`,
        admissionStage: result.stage,
        admissionPhase: result.phase,
        // THE PRODUCTION MAPPING, not a test-local guess. If this harness
        // invented its own ownership answer it would prove the drain works
        // against a receipt production never sends.
        claimRelease: claimReleaseFor(result),
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

// =====================================================================
// 5. THE APPEND-ONLY EVENT OUTRANKS THE STATUS COLUMN (Oracle #13, blocker 1)
//
// Oracle drove this on a real ledger: take a claim to delivery_started, move
// the permitted mutable `state` column back to `claimed`, and the whole stack
// agreed the message had never been sent — disposition said close_then_attempt,
// the close succeeded, and the record became eligible for a second delivery
// while a durable delivery_started event sat in the events table saying
// otherwise. Three independent guards now, because any one of them is code a
// future writer can forget to call.
// =====================================================================
describe('a stored delivery_started event dominates the state column', () => {
  test('DISPOSITION: a reverted state with a D event holds and names the contradiction', () => {
    const decision = decideClaimDisposition({
      claim: {
        claimId: 'tgc_reverted',
        state: CLAIM_STATES.CLAIMED,
        appGeneration: GEN_A,
        attemptAtMs: BASE_MS,
        deliveryStartedAtMs: BASE_MS + 1,
        eventKinds: ['delivery_started'],
      },
      currentGeneration: GEN_B,
    });
    // The dead generation would otherwise make this close_then_attempt, which
    // is exactly how the second delivery got authorised.
    expect(decision.action).toBe('hold');
    expect(decision.reason).toBe('claim_state_contradicts_delivery_started');
    expect(decision.resolutionRequired).toBe(true);
    expect(decision.detail).toMatchObject({
      storedState: CLAIM_STATES.CLAIMED,
      deliveryStartedAtMs: BASE_MS + 1,
    });
  });

  test('DISPOSITION: an event-only D with no timestamp still holds', () => {
    const decision = decideClaimDisposition({
      claim: {
        claimId: 'tgc_event_only',
        state: CLAIM_STATES.CLOSED_UNSENT,
        appGeneration: GEN_B,
        attemptAtMs: BASE_MS,
        deliveryStartedAtMs: null,
        eventKinds: ['delivery_started', 'claim_closed_unsent'],
      },
      currentGeneration: GEN_B,
    });
    // A closed_unsent claim normally means "retry is safe". Carrying a D event
    // it should never have been closed past, it does not.
    expect(decision.action).toBe('hold');
    expect(decision.reason).toBe('claim_state_contradicts_delivery_started');
  });

  test('THE DATABASE REFUSES THE REVERT ITSELF', async () => {
    const harness = makeHarness({ records: [queueRecord(900000801)] });
    await harness.build().drainOnce(harness.dir, 'main');
    const claim = readClaim(harness.writer, 900000801).claim;
    expect(claim.state).toBe(CLAIM_STATES.DELIVERY_STARTED);

    expect(() => harness.writer.db
      .prepare('UPDATE telegram_transport_claims SET state = ? WHERE claim_id = ?')
      .run(CLAIM_STATES.CLAIMED, claim.claimId)).toThrow(/telegram_claim_state_not_monotonic/);

    // Forward-but-illegal is refused too: closed_unsent is reachable only from
    // claimed, and this claim is past it.
    expect(() => harness.writer.db
      .prepare('UPDATE telegram_transport_claims SET state = ? WHERE claim_id = ?')
      .run(CLAIM_STATES.CLOSED_UNSENT, claim.claimId)).toThrow();
  });

  test('CLOSE REFUSES ON THE EVENT, not merely on the column', async () => {
    const harness = makeHarness({ records: [queueRecord(900000802)] });
    await harness.build().drainOnce(harness.dir, 'main');
    const claim = readClaim(harness.writer, 900000802).claim;

    const closed = closeUnsentClaim(harness.writer.db, {
      claimId: claim.claimId,
      reason: 'test_attempt_to_close_a_started_delivery',
      atMs: BASE_MS + 5,
    });
    expect(closed.ok).toBe(false);
    expect(closed.reason).toBe('claim_delivery_started_recorded');
    expect(readClaim(harness.writer, 900000802).claim.state)
      .toBe(CLAIM_STATES.DELIVERY_STARTED);
  });

  test('ORACLE EXPLOIT, END TO END: an incoherent row cannot be closed or re-delivered', async () => {
    const harness = makeHarness({ records: [queueRecord(900000803)], failAck: true });
    await harness.build().drainOnce(harness.dir, 'main');
    expect(harness.paneWrites).toHaveLength(1);
    const claim = readClaim(harness.writer, 900000803).claim;

    // SIMULATE THE LEDGER OF A BUILD THAT NEVER HAD THE MONOTONIC GUARD, which
    // is the only honest way to produce the incoherent pair now: drop the
    // trigger, revert the column. The append-only event is untouched
    // throughout — that is the whole point.
    harness.writer.db.exec('DROP TRIGGER trg_tg_claim_state_monotonic');
    harness.writer.db
      .prepare('UPDATE telegram_transport_claims SET state = ? WHERE claim_id = ?')
      .run(CLAIM_STATES.CLAIMED, claim.claimId);
    const incoherent = readClaim(harness.writer, 900000803).claim;
    expect(incoherent.state).toBe(CLAIM_STATES.CLAIMED);
    expect(incoherent.deliveryStartedAtMs).toBe(BASE_MS);

    // A RAW close is still refused, by the second trigger, which asks the
    // events table rather than the column.
    expect(() => harness.writer.db
      .prepare('UPDATE telegram_transport_claims SET state = ? WHERE claim_id = ?')
      .run(CLAIM_STATES.CLOSED_UNSENT, claim.claimId))
      .toThrow(/telegram_claim_close_after_delivery_started/);

    // And the drain, on a fresh boot, holds instead of delivering a second copy.
    harness.state.failAck = false;
    harness.state.generation = 'app-session-493';
    harness.state.nowMs = BASE_MS + 120000;
    const second = await harness.build().drainOnce(harness.dir, 'main');

    expect(harness.paneWrites).toHaveLength(1);
    expect(second.delivered).toBe(0);
    expect(second.stoppedAt.failureClass).toBe('awaiting_proof');
    expect(readClaim(harness.writer, 900000803).claim.state).toBe(CLAIM_STATES.CLAIMED);
  });
});

// =====================================================================
// 5b. THE SLOT REMEMBERS THE DELIVERY, NOT JUST THE ROW (Oracle #21).
//
// Blocker 1 defended the row being moved and left the TUPLE open. On a ledger
// that already held the incoherent pair — closed_unsent state, append-only
// delivery_started event — the reader filtered the closed row out before
// looking at any events, returned claim: null, the disposition read that as
// "never attempted", and acquisition minted a second claim because the
// exclusive index ignores closed rows on purpose. Oracle drove all four steps
// on a real temp ledger at 95b12a44 and got created: true.
//
// The tests below refuse to hand-inject the closed claim. Every one of them
// starts from a real delivery, produces the bad pair the only honest way (a
// build without the guards), puts the CURRENT schema back on top of it, and
// then asks the production surfaces.
// =====================================================================
describe('a closed slot that already delivered may never be re-claimed', () => {
  /**
   * The ledger an older build leaves behind: both close guards absent, the
   * state column moved to closed_unsent, the D event untouched underneath it.
   * Then the current schema is applied in place, exactly as the next boot does,
   * so the row survives into a build that would never have created it.
   */
  function legacyClosePastDelivery(writer, claimId, atMs) {
    writer.db.exec('DROP TRIGGER trg_tg_claim_state_monotonic');
    writer.db.exec('DROP TRIGGER trg_tg_claim_close_requires_no_delivery');
    writer.db.exec('DROP TRIGGER trg_tg_claim_insert_requires_no_prior_delivery');
    writer.db
      .prepare('UPDATE telegram_transport_claims SET state = ?, closed_at_ms = ? WHERE claim_id = ?')
      .run(CLAIM_STATES.CLOSED_UNSENT, atMs, claimId);
    writer.db
      .prepare('INSERT INTO telegram_transport_events (claim_id, kind, at_ms, detail) VALUES (?, ?, ?, ?)')
      .run(claimId, 'claim_closed_unsent', atMs, 'legacy_build_close');
    // REAPPLY, AND VERIFY. applyTelegramAdmissionSchema returns the installed
    // shape check, so this also proves the new trigger is actually named in
    // REQUIRED_SCHEMA_SHAPE rather than merely created.
    const reapplied = applyTelegramAdmissionSchema(writer.db);
    expect(reapplied.ok).toBe(true);
    return claimId;
  }

  async function deliveredThenLegacyClosed(updateId) {
    const harness = makeHarness({ records: [queueRecord(updateId)], failAck: true });
    await harness.build().drainOnce(harness.dir, 'main');
    expect(harness.paneWrites).toHaveLength(1);
    const claim = readClaim(harness.writer, updateId).claim;
    expect(claim.state).toBe(CLAIM_STATES.DELIVERY_STARTED);
    legacyClosePastDelivery(harness.writer, claim.claimId, BASE_MS + 30);
    return { harness, claimId: claim.claimId, updateId };
  }

  test('THE READER: a closed row is asked for its events, so the D still surfaces', async () => {
    const { harness, claimId, updateId } = await deliveredThenLegacyClosed(900000821);

    const read = readTransportClaim(harness.writer.db, {
      cutoverId: TELEGRAM_CUTOVER_ID, routeKey: 'main', updateId,
    });
    expect(read.ok).toBe(true);
    // Still null — the row IS closed, and inventing a live claim would be a
    // different lie. The evidence rides on the closed slot instead.
    expect(read.claim).toBeNull();
    expect(read.closedClaims).toHaveLength(1);
    expect(read.closedClaims[0]).toMatchObject({
      claimId,
      deliveryStartedAtMs: BASE_MS,
      closedAtMs: BASE_MS + 30,
    });
    expect(read.closedClaims[0].eventKinds)
      .toEqual(['delivery_started', 'claim_closed_unsent']);
  });

  test('THE DISPOSITION: the real read holds, and names the contradiction', async () => {
    const { harness, claimId, updateId } = await deliveredThenLegacyClosed(900000822);

    // FED FROM THE PRODUCTION READ, not a literal. The old test hand-built a
    // closed claim object and passed the reader's filter without touching it,
    // which is exactly why this hole survived a green suite.
    const read = readTransportClaim(harness.writer.db, {
      cutoverId: TELEGRAM_CUTOVER_ID, routeKey: 'main', updateId,
    });
    const decision = decideClaimDisposition({
      claim: read.claim,
      closedClaims: read.closedClaims,
      currentGeneration: 'app-session-493',
    });
    expect(decision.action).toBe('hold');
    expect(decision.reason).toBe('claim_closed_after_delivery_started');
    expect(decision.resolutionRequired).toBe(true);
    expect(decision.detail).toMatchObject({
      claimId,
      deliveryStartedAtMs: BASE_MS,
      liveClaimId: null,
    });
  });

  test('ACQUISITION: the tuple refuses a second claim, and the DB refuses it too', async () => {
    const { harness, claimId, updateId } = await deliveredThenLegacyClosed(900000823);
    const row = harness.writer.db
      .prepare('SELECT * FROM telegram_transport_claims WHERE claim_id = ?').get(claimId);

    const second = claimTransportAttempt(harness.writer.db, {
      cutoverId: row.cutover_id,
      routeKey: row.route_key,
      updateId: Number(row.update_id),
      sourceRowId: Number(row.source_row_id),
      appGeneration: 'app-session-493',
      paneLaunchId: row.pane_launch_id,
      paneId: row.pane_id,
      role: row.role,
      consumerRuntime: row.consumer_runtime,
      attemptNonce: 'nonce-after-a-legacy-close',
      attemptAtMs: BASE_MS + 120000,
    });
    expect(second.ok).toBe(false);
    expect(second.created).toBeUndefined();
    expect(second.reason).toBe('claim_tuple_delivery_started');
    expect(second.detail).toMatchObject({
      deliveredClaimId: claimId,
      deliveredClaimState: CLAIM_STATES.CLOSED_UNSENT,
      deliveryStartedAtMs: BASE_MS,
    });

    // AND WITHOUT THE FUNCTION. A writer that never calls the store still
    // cannot insert, because the guard is in the schema.
    expect(() => harness.writer.db.prepare(`
      INSERT INTO telegram_transport_claims (
        claim_id, cutover_id, route_key, update_id, source_row_id,
        app_generation, pane_launch_id, pane_id, role, consumer_runtime,
        attempt_nonce, attempt_at_ms, state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'tgc_raw_second', row.cutover_id, row.route_key, Number(row.update_id),
      Number(row.source_row_id), 'app-session-493', row.pane_launch_id, row.pane_id,
      row.role, row.consumer_runtime, 'raw-nonce', BASE_MS + 120001, CLAIM_STATES.CLAIMED
    )).toThrow(/telegram_claim_insert_after_delivery_started/);

    expect(harness.writer.db
      .prepare('SELECT COUNT(*) AS n FROM telegram_transport_claims WHERE update_id = ?')
      .get(updateId).n).toBe(1);
  });

  test('END TO END: a fresh boot over the legacy pair writes the pane ZERO more times', async () => {
    const { harness, updateId } = await deliveredThenLegacyClosed(900000824);

    // The boot that used to duplicate: new generation, ack working, clock moved
    // well past any backoff.
    harness.state.failAck = false;
    harness.state.generation = 'app-session-493';
    harness.state.nowMs = BASE_MS + 120000;
    const second = await harness.build().drainOnce(harness.dir, 'main');

    expect(harness.paneWrites).toHaveLength(1);
    expect(second.delivered).toBe(0);
    expect(second.stoppedAt.failureClass).toBe('awaiting_proof');
    expect(second.stoppedAt.reason).toBe('claim_closed_after_delivery_started');
    expect(harness.writer.db
      .prepare('SELECT COUNT(*) AS n FROM telegram_transport_claims WHERE update_id = ?')
      .get(updateId).n).toBe(1);
  });

  test('AND IT DOES NOT OVER-FIRE: a close with no D still releases the slot', async () => {
    // The guard must poison a delivered tuple WITHOUT freezing every closed
    // slot — a refusal before D is the one lawful way an attempt becomes
    // retryable, and killing it would wedge the queue in the other direction.
    const harness = makeHarness({ records: [queueRecord(900000825)], failAt: 'after_claim' });
    await harness.build().drainOnce(harness.dir, 'main');
    expect(harness.paneWrites).toHaveLength(0);

    const read = readTransportClaim(harness.writer.db, {
      cutoverId: TELEGRAM_CUTOVER_ID, routeKey: 'main', updateId: 900000825,
    });
    expect(read.claim).toBeNull();
    expect(read.closedClaims).toHaveLength(1);
    expect(read.closedClaims[0].deliveryStartedAtMs).toBeNull();
    expect(decideClaimDisposition({
      claim: null, closedClaims: read.closedClaims, currentGeneration: GEN_B,
    })).toMatchObject({ action: 'attempt', reason: 'no_claim' });

    harness.state.failAt = null;
    harness.state.nowMs = BASE_MS + 120000;
    const retry = await harness.build().drainOnce(harness.dir, 'main');
    expect(retry.delivered).toBe(1);
    expect(harness.paneWrites).toHaveLength(1);
  });
});

// =====================================================================
// 5c. A PANE THAT CANNOT ANSWER IS NOT DELIVERED TO (Oracle #7).
//
// Every claim latched for a runtime that has never produced a terminal receipt
// becomes a permanent hold: B latches, D authorises, bytes go out, and no proof
// can ever retire it. That is the live diagnosis on this queue right now. The
// gate asks before B, where "nothing happened" is still true and the record can
// simply stay queued.
//
// The assertion that matters in all of these is not the refusal - it is that
// the claims table is EMPTY afterwards.
// =====================================================================
describe('readiness is proven before anything is latched', () => {
  const claimRows = (harness, updateId) => harness.writer.db
    .prepare('SELECT COUNT(*) AS n FROM telegram_transport_claims WHERE update_id = ?')
    .get(updateId).n;

  // EVERY EFFECT, NOT JUST THE CLAIM COUNT (Oracle #54).
  //
  // A refusal above B must mean: no claim row, no delivery_started event, the
  // final bytes were never composed, no pane write - AND the refusal was TYPED.
  // That last one is the difference between "the gate said no" and "something
  // threw and happened to leave the tables empty"; Oracle found exactly that
  // second shape on the reflection-throwing Proxy.
  const startedEvents = (harness, updateId) => harness.writer.db
    .prepare(`SELECT COUNT(*) AS n FROM telegram_transport_events e
              JOIN telegram_transport_claims c ON c.claim_id = e.claim_id
              WHERE c.update_id = ? AND e.kind = 'delivery_started'`)
    .get(updateId).n;

  async function refusedBy(updateId, paneReadiness) {
    const harness = makeHarness({ records: [queueRecord(updateId)], paneReadiness });
    const result = await harness.build().drainOnce(harness.dir, 'main');
    expect(harness.paneWrites).toHaveLength(0);
    expect(result.delivered).toBe(0);
    expect(claimRows(harness, updateId)).toBe(0);
    expect(startedEvents(harness, updateId)).toBe(0);
    expect(harness.state.composes).toBe(0);
    // TYPED, and refused at the readiness gate specifically.
    expect(harness.state.lastRefusal).toMatchObject({ stage: 'B_readiness' });
    expect(harness.state.lastRefusal.reason).toEqual(expect.stringMatching(/^pane_readiness_/));
    return { harness, result };
  }

  test('a runtime that has never proved anything never gets a claim', async () => {
    await refusedBy(900000831, () => ({
      attainable: false, reason: 'runtime_never_produced_proof', runtime: 'codex', lastProofAtMs: null,
    }));
  });

  test('an unknown runtime is not a ready one', async () => {
    await refusedBy(900000832, () => ({ attainable: false, reason: 'runtime_unknown', runtime: null }));
  });

  test('stale proof is not proof', async () => {
    await refusedBy(900000833, () => ({
      attainable: false, reason: 'runtime_proof_stale', runtime: 'codex', lastProofAtMs: BASE_MS - 99999999,
    }));
  });

  test('a probe that throws fails closed', async () => {
    await refusedBy(900000834, () => { throw new Error('probe exploded'); });
  });

  test('a malformed answer is not a yes', async () => {
    // Every one of these is falsy-or-shapeless in a different way, and a gate
    // that reads any of them as ready is a gate that delivers on a shrug.
    await refusedBy(900000835, () => null);
    await refusedBy(900000836, () => undefined);
    await refusedBy(900000837, () => 'ready');
    await refusedBy(900000838, () => ({}));
    await refusedBy(900000839, () => ({ attainable: 'true' }));
    await refusedBy(900000840, () => ({ ready: 1 }));
  });

  test('THE SEQUENCE ITSELF: no probe at all refuses, and names why', async () => {
    const harness = makeHarness({ records: [queueRecord(900000841)] });
    const writer = harness.writer;
    const record = queueRecord(900000841);
    const result = await runTelegramAdmissionSequence({
      db: writer.db,
      job: {
        messageId: 'telegram-in-900000841',
        updateId: 900000841,
        chatId: CHAT_ID,
        routeKey: 'main',
        profile: 'main',
        windowKey: 'main',
        rawBody: record.text,
        sessionId: record.targetSession,
        sentAtMs: record.timestampMs,
      },
      record,
      appGeneration: GEN_B,
      mode: MODES.FULL,
      composeFinalBody: async () => 'body',
      now: () => BASE_MS,
      nonce: () => 'n_no_probe',
      // paneReadiness deliberately absent.
    });
    expect(result.ok).toBe(false);
    expect(result.stage).toBe('B_readiness');
    expect(result.reason).toBe('sequence_no_pane_readiness_probe');
    // NOTHING TO CLEAN UP. A refusal above B owns no claim, so the drain may
    // not close anything on its behalf.
    expect(result.ownedClaimId).toBeNull();
    expect(result.ownedClaimUnsent).toBe(false);
    expect(claimRows(harness, 900000841)).toBe(0);
  });

  test('the refusal carries the probe reason, and the pane is asked about its OWN runtime', async () => {
    const asked = [];
    const harness = makeHarness({
      records: [queueRecord(900000842)],
      paneReadiness: (input) => {
        asked.push(input);
        return { attainable: false, reason: 'runtime_never_produced_proof', runtime: input.runtime };
      },
    });
    await harness.build().drainOnce(harness.dir, 'main');
    // The runtime comes from the LAUNCH REGISTRY row, not from the caller: a
    // probe that could be handed any runtime string could answer for a pane
    // other than the one about to be written.
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      runtime: 'codex', appGeneration: GEN_B, paneId: '1', routeKey: 'main', updateId: 900000842,
    });
    expect(asked[0].launchId).toEqual(expect.any(String));
    expect(claimRows(harness, 900000842)).toBe(0);
  });

  // ===================================================================
  // ORACLE #37: THE OR GATE VALIDATED ONE TRUE BIT AND NOTHING ELSE.
  //
  // `ready === true || attainable === true` let all three of these reach
  // D_delivery_started and create a claim on a real ledger. Each is a different
  // way of being wrong, and none of them is malformed - that is the point. They
  // are well-formed answers that the old gate had no way to disbelieve:
  //
  //   1. the answer argues with itself (ready yes, attainable no, stale)
  //   2. the answer is about a DIFFERENT PANE than the one being written
  //   3. the true bit is explained by a reason that means the opposite
  //
  // The assertion in every one is the claims table, not the refusal string.
  // ===================================================================
  test('ORACLE #37 shape 1: an answer that contradicts itself never gets a claim', async () => {
    await refusedBy(900000850, () => ({
      ready: true,
      attainable: false,
      reason: 'runtime_proof_stale',
      runtime: 'codex',
      lastProofAtMs: BASE_MS - 99999999,
    }));
  });

  test('ORACLE #37 shape 2: a perfect answer about ANOTHER pane never gets a claim', async () => {
    // Every field is well-formed and positive. It is simply not about the pane
    // the launch registry bound, which is `codex`.
    await refusedBy(900000851, () => ({
      attainable: true,
      reason: 'runtime_proof_observed',
      runtime: 'claude',
      lastProofAtMs: BASE_MS - 1000,
    }));
  });

  test('ORACLE #37 shape 3: attainable carrying an unattainable reason never gets a claim', async () => {
    await refusedBy(900000852, () => ({
      attainable: true,
      reason: 'runtime_proof_stale',
      runtime: 'codex',
      lastProofAtMs: BASE_MS - 1000,
    }));
  });

  test('`ready` is not an alternate path, in either direction', async () => {
    // ready:false alongside an otherwise-perfect answer is a contradiction.
    await refusedBy(900000853, () => ({
      ready: false,
      attainable: true,
      reason: 'runtime_proof_observed',
      runtime: 'codex',
      lastProofAtMs: BASE_MS - 1000,
    }));
    // ready:true alone - the old gate's other acceptance path - is now nothing.
    await refusedBy(900000854, () => ({ ready: true }));
    await refusedBy(900000855, () => ({ ready: true, runtime: 'codex', reason: 'runtime_proof_observed' }));
  });

  test('the proof timestamp has to be a real past instant', async () => {
    const base = {
      attainable: true, reason: 'runtime_proof_observed', runtime: 'codex',
    };
    await refusedBy(900000856, () => ({ ...base }));                              // absent
    await refusedBy(900000857, () => ({ ...base, lastProofAtMs: null }));
    await refusedBy(900000858, () => ({ ...base, lastProofAtMs: 0 }));
    await refusedBy(900000859, () => ({ ...base, lastProofAtMs: -1 }));
    await refusedBy(900000860, () => ({ ...base, lastProofAtMs: 'yesterday' }));
    await refusedBy(900000861, () => ({ ...base, lastProofAtMs: 1.5 }));
    await refusedBy(900000862, () => ({ ...base, lastProofAtMs: Number.NaN }));
    // FROM THE FUTURE. A clock that runs ahead would otherwise read as the
    // freshest possible proof.
    await refusedBy(900000863, () => ({ ...base, lastProofAtMs: BASE_MS + 60000 }));
  });

  test('a coherent-looking answer the REAL probe would call stale never gets a claim', async () => {
    // THIS IS THE ONE THAT IS NOT A SHAPE CHECK. Every clause the gate states
    // for itself passes: attainable true, reason observed, right runtime, a
    // real past timestamp. It is refused because the gate re-runs
    // probeRuntimeProofCapability over the evidence the answer itself states
    // and the production window disagrees with the verdict.
    await refusedBy(900000864, () => ({
      attainable: true,
      reason: 'runtime_proof_observed',
      runtime: 'codex',
      lastProofAtMs: BASE_MS - (30 * 24 * 60 * 60 * 1000),
    }));
  });

  // ===================================================================
  // ORACLE #47: TWO MORE SHAPES CROSSED D ON THE REPAIRED GATE.
  //
  // Neither is malformed in any way the previous version could see. The first
  // is a good answer whose timestamp merely COERCES to fresh; the second reads
  // identically to a good answer through every property access and owns
  // nothing. Both created a real claim on a real writer.
  // ===================================================================
  const GOOD_ANSWER = Object.freeze({
    attainable: true, reason: 'runtime_proof_observed', runtime: 'codex', lastProofAtMs: BASE_MS - 1000,
  });

  test('ORACLE #47 shape 4: a numeric-string timestamp never gets a claim', async () => {
    await refusedBy(900000870, () => ({ ...GOOD_ANSWER, lastProofAtMs: String(BASE_MS - 1000) }));
  });

  test('ORACLE #47 shape 5: an inherited-shape answer never gets a claim', async () => {
    await refusedBy(900000871, () => Object.create(GOOD_ANSWER));
  });

  test('a valueOf/Date timestamp never gets a claim', async () => {
    await refusedBy(900000872, () => ({ ...GOOD_ANSWER, lastProofAtMs: { valueOf: () => BASE_MS - 1000 } }));
    await refusedBy(900000873, () => ({ ...GOOD_ANSWER, lastProofAtMs: new Date(BASE_MS - 1000) }));
  });

  test('an answer carrying a foreign field never gets a claim', async () => {
    await refusedBy(900000874, () => ({ ...GOOD_ANSWER, ready: true }));
    await refusedBy(900000875, () => ({ ...GOOD_ANSWER, note: 'looks fine to me' }));
  });

  test('ARCH #77: an accessor answer never gets a claim', async () => {
    const getterAnswer = { ...GOOD_ANSWER };
    Object.defineProperty(getterAnswer, 'lastProofAtMs', {
      get: () => BASE_MS - 1000, enumerable: true, configurable: true,
    });
    await refusedBy(900000877, () => getterAnswer);

    // The read-once shape: correct runtime on the first touch, another pane on
    // every touch after it.
    let reads = 0;
    const flipping = { ...GOOD_ANSWER };
    Object.defineProperty(flipping, 'runtime', {
      get: () => { reads += 1; return reads === 1 ? 'codex' : 'claude'; },
      enumerable: true,
      configurable: true,
    });
    await refusedBy(900000878, () => flipping);
  });

  test('ARCH #77: symbol and non-enumerable extras never get a claim', async () => {
    await refusedBy(900000879, () => ({ ...GOOD_ANSWER, [Symbol('smuggled')]: 'x' }));
    const hidden = { ...GOOD_ANSWER };
    Object.defineProperty(hidden, 'ready', { value: true, enumerable: false, configurable: true });
    await refusedBy(900000880, () => hidden);
  });

  test('ARCH #77/#89: a Proxy never gets a claim, and never runs a trap', async () => {
    await refusedBy(900000881, () => new Proxy({ ...GOOD_ANSWER }, {
      ownKeys() { throw new Error('ownKeys trap exploded'); },
    }));
    await refusedBy(900000882, () => new Proxy({ ...GOOD_ANSWER }, { get: (t, k) => t[k] }));

    // A REVOKED Proxy, through the real drain: reflection and Array.isArray
    // both throw on it, so this is the shape that proves the Proxy gate really
    // is above every one of them.
    const revocable = Proxy.revocable({ ...GOOD_ANSWER }, {});
    revocable.revoke();
    await refusedBy(900000885, () => revocable.proxy);

    // ZERO TRAP EXECUTIONS, asserted through the production path rather than
    // only at the unit boundary.
    const traps = { get: 0, ownKeys: 0, getOwnPropertyDescriptor: 0, getPrototypeOf: 0 };
    const counted = new Proxy({ ...GOOD_ANSWER }, {
      get(t, k) { traps.get += 1; return t[k]; },
      ownKeys(t) { traps.ownKeys += 1; return Reflect.ownKeys(t); },
      getOwnPropertyDescriptor(t, k) {
        traps.getOwnPropertyDescriptor += 1; return Reflect.getOwnPropertyDescriptor(t, k);
      },
      getPrototypeOf(t) { traps.getPrototypeOf += 1; return Reflect.getPrototypeOf(t); },
    });
    const { harness } = await refusedBy(900000886, () => counted);
    expect(harness.state.lastRefusal.reason).toBe('pane_readiness_not_a_plain_record');
    expect(traps).toEqual({
      get: 0, ownKeys: 0, getOwnPropertyDescriptor: 0, getPrototypeOf: 0,
    });

    // ZERO IS NOW REACHABLE ON EVERY PATH, because nothing is awaited at all
    // (ARCH #93). A Proxy handed over inside a promise used to take one
    // `get('then')` from the language's own resolution procedure; the async
    // callback is refused before it is ever invoked, so its Proxy is never even
    // constructed into the path.
    const promiseTraps = { get: 0, ownKeys: 0, getOwnPropertyDescriptor: 0, getPrototypeOf: 0 };
    const viaPromise = new Proxy({ ...GOOD_ANSWER }, {
      get(t, k) { promiseTraps.get += 1; return t[k]; },
      ownKeys(t) { promiseTraps.ownKeys += 1; return Reflect.ownKeys(t); },
      getOwnPropertyDescriptor(t, k) {
        promiseTraps.getOwnPropertyDescriptor += 1; return Reflect.getOwnPropertyDescriptor(t, k);
      },
      getPrototypeOf(t) { promiseTraps.getPrototypeOf += 1; return Reflect.getPrototypeOf(t); },
    });
    const { harness: promiseHarness } = await refusedBy(900000887, async () => viaPromise);
    expect(promiseHarness.state.lastRefusal.reason).toBe('pane_readiness_probe_not_synchronous');
    expect(promiseTraps).toEqual({
      get: 0, ownKeys: 0, getOwnPropertyDescriptor: 0, getPrototypeOf: 0,
    });
  });

  test('ARCH #93: readiness is synchronous, and an async probe is never invoked', async () => {
    // NOT INVOKED. The counter is the assertion: refusing after running an
    // async callback would still have run it, and its promise would still have
    // been awaited somewhere.
    let asyncCalls = 0;
    await refusedBy(900000888, async () => { asyncCalls += 1; return { ...GOOD_ANSWER }; });
    expect(asyncCalls).toBe(0);

    let generatorCalls = 0;
    // eslint-disable-next-line require-yield
    await refusedBy(900000889, function* () { generatorCalls += 1; return { ...GOOD_ANSWER }; });
    expect(generatorCalls).toBe(0);

    let asyncGenCalls = 0;
    // eslint-disable-next-line require-yield
    await refusedBy(900000890, async function* () { asyncGenCalls += 1; return { ...GOOD_ANSWER }; });
    expect(asyncGenCalls).toBe(0);

    // A PROXY CALLBACK is refused without its apply trap firing.
    let applyCalls = 0;
    const proxiedProbe = new Proxy(() => ({ ...GOOD_ANSWER }), {
      apply(t, thisArg, args) { applyCalls += 1; return Reflect.apply(t, thisArg, args); },
    });
    await refusedBy(900000891, proxiedProbe);
    expect(applyCalls).toBe(0);

    // An ORDINARY callback that returns a promise IS invoked - we cannot know
    // what it returns without calling it - but the promise is refused on an
    // internal-slot check, never awaited.
    let ordinaryCalls = 0;
    const { harness } = await refusedBy(900000892, () => {
      ordinaryCalls += 1;
      return Promise.resolve({ ...GOOD_ANSWER });
    });
    expect(ordinaryCalls).toBe(1);
    expect(harness.state.lastRefusal.reason).toBe('pane_readiness_probe_not_synchronous');
  });

  test('ARCH #93: a plain thenable is refused structurally, without calling then', async () => {
    // `then` is a foreign field on a four-key record, so it never gets called.
    // A thenable that resolved to a good answer would otherwise be able to
    // substitute an entirely different value for the one the probe returned.
    let thenCalls = 0;
    await refusedBy(900000893, () => ({
      ...GOOD_ANSWER,
      then(resolve) { thenCalls += 1; resolve({ ...GOOD_ANSWER }); },
    }));
    expect(thenCalls).toBe(0);

    // And as an ACCESSOR, which is the shape that would run on a mere read.
    let thenGetterCalls = 0;
    const withThenGetter = { ...GOOD_ANSWER };
    Object.defineProperty(withThenGetter, 'then', {
      get() { thenGetterCalls += 1; return undefined; },
      enumerable: true,
      configurable: true,
    });
    await refusedBy(900000894, () => withThenGetter);
    expect(thenGetterCalls).toBe(0);
  });

  test('ARCH #93: a hostile thrown value gets a constant typed refusal', async () => {
    // The refusal used to interpolate err.message, which is a property read on
    // whatever the probe chose to throw.
    const hostileThrow = {};
    Object.defineProperty(hostileThrow, 'message', {
      get() { throw new Error('message getter exploded'); },
    });
    const { harness } = await refusedBy(900000895, () => { throw hostileThrow; });
    expect(harness.state.lastRefusal.reason).toBe('pane_readiness_threw');
  });

  test('ARCH #84: a hostile diagnostic value never gets a claim, and never escapes', async () => {
    // The refusal path itself used to read `err.message` and
    // `proto.constructor.name`. Both are property reads on values we have just
    // decided not to trust, and both escaped as exceptions instead of refusing.
    const hostileError = {};
    Object.defineProperty(hostileError, 'message', {
      get() { throw new Error('message getter exploded'); },
    });
    await refusedBy(900000883, () => new Proxy({ ...GOOD_ANSWER }, {
      ownKeys() { throw hostileError; },
    }));

    const hostileProto = {};
    Object.defineProperty(hostileProto, 'constructor', {
      get() { throw new Error('constructor getter exploded'); },
    });
    await refusedBy(900000884, () => Object.assign(Object.create(hostileProto), GOOD_ANSWER));
  });

  test('a null-prototype record is still the probe\'s record, and delivers', async () => {
    // The strictness is about OWNERSHIP and shape, not about ceremony. If this
    // refused, the rule would be superstition rather than a contract.
    const harness = makeHarness({
      records: [queueRecord(900000876)],
      paneReadiness: () => Object.assign(Object.create(null), GOOD_ANSWER),
    });
    const result = await harness.build().drainOnce(harness.dir, 'main');
    expect(harness.paneWrites).toHaveLength(1);
    expect(result.delivered).toBe(1);
    expect(claimRows(harness, 900000876)).toBe(1);
  });

  test('THE POSITIVE CONTROL: the one coherent answer still delivers, exactly once', async () => {
    // Without this, refusing everything would pass every test above it.
    const harness = makeHarness({ records: [queueRecord(900000865)] });
    const result = await harness.build().drainOnce(harness.dir, 'main');
    expect(harness.paneWrites).toHaveLength(1);
    expect(result.delivered).toBe(1);
    expect(claimRows(harness, 900000865)).toBe(1);
  });

  test('the runtime match normalizes case and spacing rather than failing on it', async () => {
    // The probe lowercases and trims its own answer; a launch row carrying
    // `codex` and an answer carrying ` CODEX ` are the same pane, and refusing
    // that would be a gate that breaks on formatting instead of on identity.
    const harness = makeHarness({
      records: [queueRecord(900000866)],
      paneReadiness: () => ({
        attainable: true,
        reason: 'runtime_proof_observed',
        runtime: '  CODEX  ',
        lastProofAtMs: BASE_MS - 1000,
      }),
    });
    const result = await harness.build().drainOnce(harness.dir, 'main');
    expect(harness.paneWrites).toHaveLength(1);
    expect(result.delivered).toBe(1);
    expect(claimRows(harness, 900000866)).toBe(1);
  });

  test('a SOURCE_ONLY route never reaches the gate, because it never claims', async () => {
    // Scoped windows return at A. Gating them on a readiness probe they can
    // never satisfy would refuse to record identity for a message that is
    // legitimately handed to another process.
    const harness = makeHarness({
      records: [queueRecord(900000843)],
      failAt: 'source_only',
      paneReadiness: () => { throw new Error('must not be asked'); },
    });
    await harness.build().drainOnce(harness.dir, 'main');
    expect(claimRows(harness, 900000843)).toBe(0);
    expect(harness.writer.db
      .prepare('SELECT COUNT(*) AS n FROM telegram_source_identity WHERE update_id = ?')
      .get(900000843).n).toBe(1);
  });
});

// =====================================================================
// 6. CLEANUP CLOSES THE CLAIM IT OWNS, AND NOTHING ELSE (Oracle #13, blocker 2)
// =====================================================================
describe('rejection cleanup is bound to the claim the delivery made', () => {
  test('a typed after-B refusal closes ITS OWN claim, named by the receipt', async () => {
    const closeCalls = [];
    const harness = makeHarness({ records: [queueRecord(900000811)], failAt: 'after_claim' });
    const result = await harness.build({
      closeUnsentTransportClaim: async (input) => {
        closeCalls.push(input);
        return closeUnsentClaim(harness.writer.db, input);
      },
    }).drainOnce(harness.dir, 'main');

    expect(harness.paneWrites).toHaveLength(0);
    expect(result.stoppedAt.reason).toMatch(/^delivery_rejected:/);
    expect(closeCalls).toHaveLength(1);

    const read = readClaim(harness.writer, 900000811);
    expect(read.claim).toBeNull();
    expect(read.closedClaims).toHaveLength(1);
    // The id the drain closed is the id the sequence created — not one it went
    // looking for.
    expect(closeCalls[0].claimId).toBe(read.closedClaims[0].claimId);
  });

  test('A LOST RACE AT B CLOSES NOTHING: the other claimant is left alone', async () => {
    const harness = makeHarness({ records: [queueRecord(900000812)] });

    // ANOTHER ATTEMPT ALREADY HOLDS THE TUPLE. Built by the real sequence from
    // the SAME queued record — anything else refuses at A on
    // source_identity_conflict and never reaches B, which is the immutable
    // source doing its job and not the race we are trying to reproduce.
    const competingRecord = queueRecord(900000812);
    const competing = await runTelegramAdmissionSequence({
      db: harness.writer.db,
      job: {
        messageId: 'telegram-in-900000812',
        updateId: 900000812,
        chatId: CHAT_ID,
        routeKey: 'main',
        profile: 'main',
        windowKey: 'main',
        rawBody: competingRecord.text,
        sessionId: competingRecord.targetSession,
        sentAtMs: competingRecord.timestampMs,
      },
      record: competingRecord,
      appGeneration: GEN_B,
      mode: MODES.FULL,
      paneReadiness: () => READY,
      composeFinalBody: async () => 'competing body',
      now: () => BASE_MS - 10,
      nonce: () => 'n_competing_owner',
      steps: { recordDeliveryStarted: () => ({ ok: false, reason: 'held_at_claimed_for_test' }) },
    });
    expect(competing.ok).toBe(false);
    expect(competing.ownedClaimId).toEqual(expect.any(String));
    const competingClaimId = competing.ownedClaimId;
    expect(readClaim(harness.writer, 900000812).claim.claimId).toBe(competingClaimId);

    // THE RACE: our pre-delivery lookup saw nothing, and the claim appeared
    // before we reached B. Without the override the drain would hold at the
    // disposition and never exercise the cleanup path at all — this is Oracle's
    // exact probe.
    const closeCalls = [];
    const result = await harness.build({
      lookupTransportClaim: async () => null,
      closeUnsentTransportClaim: async (input) => {
        closeCalls.push(input);
        return closeUnsentClaim(harness.writer.db, input);
      },
    }).drainOnce(harness.dir, 'main');

    expect(result.delivered).toBe(0);
    expect(harness.paneWrites).toHaveLength(0);
    expect(result.stoppedAt.reason).toContain('claim_held_by_other');
    // THE INVARIANT: not one close was attempted, and the live claim is
    // untouched. Closing it would have released a delivery this process does
    // not own.
    expect(closeCalls).toEqual([]);
    const after = readClaim(harness.writer, 900000812);
    expect(after.claim.claimId).toBe(competingClaimId);
    expect(after.claim.state).toBe(CLAIM_STATES.CLAIMED);
    expect(after.closedClaims).toEqual([]);
  });

  test('AN UNKNOWN BOUNDARY HOLDS: no close, and never a definite retry', async () => {
    const closeCalls = [];
    const harness = makeHarness({ records: [queueRecord(900000813)] });
    const result = await harness.build({
      deps: {
        deliver: async () => ({
          ok: false,
          status: 'admission_runtime_error',
          claimRelease: { kind: 'unknown' },
          messageId: 'telegram-in-900000813',
          routeKey: 'main',
          windowKey: 'main',
          profile: 'main',
        }),
      },
      closeUnsentTransportClaim: async (input) => {
        closeCalls.push(input);
        return closeUnsentClaim(harness.writer.db, input);
      },
    }).drainOnce(harness.dir, 'main');

    expect(closeCalls).toEqual([]);
    expect(result.delivered).toBe(0);
    expect(result.stoppedAt.failureClass).toBe('awaiting_proof');
    expect(result.stoppedAt.reason).toMatch(/^claim_release_boundary_unknown:/);
  });

  test('a receipt claiming ownership without an id holds rather than hunting for one', async () => {
    const closeCalls = [];
    const harness = makeHarness({ records: [queueRecord(900000814)] });
    const result = await harness.build({
      deps: {
        deliver: async () => ({
          ok: false,
          status: 'admission_refused:broken_producer',
          claimRelease: { kind: 'owned_unsent', claimId: '   ' },
          messageId: 'telegram-in-900000814',
          routeKey: 'main',
          windowKey: 'main',
          profile: 'main',
        }),
      },
      closeUnsentTransportClaim: async (input) => {
        closeCalls.push(input);
        return closeUnsentClaim(harness.writer.db, input);
      },
    }).drainOnce(harness.dir, 'main');

    expect(closeCalls).toEqual([]);
    expect(result.stoppedAt.reason).toBe('claim_release_owned_without_id');
    expect(result.stoppedAt.failureClass).toBe('awaiting_proof');
  });

  test('THE SEQUENCE NAMES OWNERSHIP HONESTLY: null before B, its own id after', async () => {
    const writer = freshLedger();
    const job = {
      messageId: 'telegram-in-900000815',
      updateId: 900000815,
      chatId: CHAT_ID,
      routeKey: 'main',
      profile: 'main',
      windowKey: 'main',
      rawBody: 'body',
      sessionId: 'app-session-490',
      sentAtMs: BASE_MS - 1000,
    };
    const base = {
      db: writer.db,
      job,
      record: { updateId: 900000815, chatId: CHAT_ID, targetSession: 'app-session-490' },
      appGeneration: GEN_B,
      mode: MODES.FULL,
      paneReadiness: () => READY,
      now: () => BASE_MS,
    };

    const beforeB = await runTelegramAdmissionSequence({
      ...base,
      composeFinalBody: async () => 'body',
      nonce: () => 'n_before_b',
      steps: { claimTransportAttempt: () => ({ ok: false, reason: 'claim_held_by_other' }) },
    });
    expect(beforeB.ok).toBe(false);
    expect(beforeB.ownedClaimId).toBeNull();
    expect(beforeB.ownedClaimUnsent).toBe(false);
    expect(claimReleaseFor(beforeB)).toEqual({ kind: 'none' });

    const afterB = await runTelegramAdmissionSequence({
      ...base,
      nonce: () => 'n_after_b',
      composeFinalBody: async () => { throw new Error('compose exploded'); },
    });
    expect(afterB.ok).toBe(false);
    expect(afterB.stage).toBe('C_compose');
    expect(afterB.ownedClaimUnsent).toBe(true);
    expect(afterB.ownedClaimId).toBe(readClaim(writer, 900000815).claim.claimId);
    expect(claimReleaseFor(afterB)).toEqual({
      kind: 'owned_unsent', claimId: afterB.ownedClaimId,
    });
  });
});
