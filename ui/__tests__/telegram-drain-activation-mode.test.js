/**
 * v7 §3 PHASE L — THE ACTIVATION MODE AS THE PRODUCTION DRAIN ACTUALLY RUNS IT.
 *
 * =====================================================================
 * THE THING THIS SUITE EXISTS TO MAKE IMPOSSIBLE
 * =====================================================================
 * A mode that only the tests set. `telegram-activation-mode.test.js` proves the
 * resolver is correct, and a resolver nobody consults is exactly the shape this
 * lane already shipped once: `readLegacyJournalSnapshot` was 20/20 green while
 * the production drain called neither it nor its gate.
 *
 * So every behavioural test here drives the REAL coordinator over a REAL spool
 * and asserts on COUNTERS — sidecar reads, claim lookups, receipt lookups,
 * deliveries, the decision-seam boundary, acks, and legacy-attempt writes —
 * and the structural tests read the production wiring itself.
 *
 * The legacy-attempt append needs both kinds of proof, deliberately. A static
 * reachability scan alone can be defeated by a dynamic call it cannot see; a
 * dynamic counter alone only proves the paths a test happened to exercise. Each
 * covers the other's blind spot, so neither can silently stand in for it.
 *
 * Zero network, zero timers, zero live queue/latch/ledger/process/Telegram.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const queue = require('../modules/telegram-inbound-durable-queue');
const spool = require('../modules/main/telegram-ingress-spool');
const { createDrainCoordinator } = require('../modules/main/telegram-ingress-drain');
const { LEGACY_SETTLEMENT } = require('../modules/main/telegram-activation-mode');
const { summarizeBacklog } = require('../modules/main/telegram-consumption-proof');
const { scoreBacklogHealth, scoreTelegramChannel } = require('../modules/main/telegram-backlog-health');
const { classifySourceRecord, SOURCE_PROTOCOLS } = require('../modules/main/telegram-source-protocol');
const { createClaimLatchDouble } = require('./helpers/telegram-claim-latch-double');

const MODULES_DIR = path.join(__dirname, '..', 'modules');
const APP_PATH = path.join(MODULES_DIR, 'main', 'squidrun-app.js');
const QUEUE_PATH = path.join(MODULES_DIR, 'telegram-inbound-durable-queue.js');

const tempRoots = [];
function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mode-'));
  tempRoots.push(root);
  return root;
}
afterEach(() => {
  while (tempRoots.length) fs.rmSync(tempRoots.pop(), { recursive: true, force: true });
});

const CHAT = 4242;
const GENERATION = 'app-session-492';
const silentLog = { info() {}, warn() {}, error() {} };
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
function liveLatchLine(updateId) {
  return JSON.stringify({ updateId, state: 'attempted' });
}
function sidecarBytes(dir) {
  const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
  return { attempts: read(queue.attemptsPath(dir)), dispositions: read(queue.dispositionsPath(dir)) };
}

// ------------------------------------------------------------------ counters

function harness(dir, overrides = {}) {
  const counts = {
    attemptsRead: 0,
    dispositionsRead: 0,
    claimLookup: 0,
    claimClose: 0,
    receiptLookup: 0,
    deliver: 0,
    decisionSeam: 0,
    ack: 0,
    attemptAppend: 0,
    dispositionAppend: 0,
    modeAsks: 0,
  };
  const delivered = [];
  const latch = createClaimLatchDouble({ generation: () => GENERATION });
  const { deliver, activationMode, ...rest } = overrides;
  const mode = Object.prototype.hasOwnProperty.call(overrides, 'activationMode')
    ? activationMode
    : () => LEGACY_SETTLEMENT;

  const drain = createDrainCoordinator({
    queue: {
      ...queue,
      ack: (...args) => { counts.ack += 1; return queue.ack(...args); },
      appendAttempt: (...args) => { counts.attemptAppend += 1; return queue.appendAttempt(...args); },
      appendDisposition: (...args) => { counts.dispositionAppend += 1; return queue.appendDisposition(...args); },
    },
    log: silentLog,
    resolveRoute: () => ({ ok: true, profile: 'main', windowKey: 'main' }),
    currentSessionFor: () => 'session-now',
    sessionGeneration: () => GENERATION,
    now: () => Date.now(),
    paneRuntimeFor: () => 'codex',
    receiptActivity: () => ({ receiptsEverProduced: 5, lastReceiptAtMs: Date.now() }),
    activationMode: () => { counts.modeAsks += 1; return typeof mode === 'function' ? mode() : mode; },
    readJournalFile: (file) => {
      if (file === queue.attemptsPath(dir)) counts.attemptsRead += 1;
      else if (file === queue.dispositionsPath(dir)) counts.dispositionsRead += 1;
      else throw new Error(`unexpected journal read: ${file}`);
      return fs.readFileSync(file, 'utf8');
    },
    lookupTransportClaim: async (input) => { counts.claimLookup += 1; return latch.lookupTransportClaim(input); },
    closeUnsentTransportClaim: async (input) => { counts.claimClose += 1; return latch.closeUnsentTransportClaim(input); },
    findExistingReceipt: async () => { counts.receiptLookup += 1; return null; },
    ...rest,
    deliver: latch.wrapDeliver(async (job) => {
      counts.deliver += 1;
      counts.decisionSeam += 1;
      delivered.push(job.updateId);
      return deliver ? deliver(job) : {
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

/** Everything an unhealthy mode is forbidden to have done. */
function expectTouchedNothing(counts) {
  expect(counts.attemptsRead).toBe(0);
  expect(counts.dispositionsRead).toBe(0);
  expect(counts.claimLookup).toBe(0);
  expect(counts.claimClose).toBe(0);
  expect(counts.receiptLookup).toBe(0);
  expect(counts.deliver).toBe(0);
  expect(counts.decisionSeam).toBe(0);
  expect(counts.ack).toBe(0);
  expect(counts.attemptAppend).toBe(0);
  expect(counts.dispositionAppend).toBe(0);
}

// --------------------------------------------------- unhealthy mode refuses

describe('an unhealthy activation mode refuses before it reads anything', () => {
  const BAD_MODES = [
    ['missing (null)', () => null, 'activation_mode_missing'],
    ['missing (undefined)', () => undefined, 'activation_mode_missing'],
    ['empty string', () => '', 'activation_mode_empty'],
    ['whitespace', () => '   ', 'activation_mode_empty'],
    ['a number', () => 7, 'activation_mode_not_a_string'],
    ['boolean true', () => true, 'activation_mode_not_a_string'],
    ['an unknown mode', () => 'decision_scheduling', 'activation_mode_unknown'],
    ['a near miss', () => ' legacy_settlement', 'activation_mode_unknown'],
  ];

  test.each(BAD_MODES)('%s holds the head with zero of everything', async (_label, mode, reason) => {
    const base = tempRoot();
    const dir = seedLegacy(base, [900, 901]);
    const before = sidecarBytes(dir);
    const { drain, counts, delivered } = harness(dir, { activationMode: mode });

    const res = await drain.drainOnce(dir, 'main');

    expect(delivered).toEqual([]);
    expect(res.stoppedAt).toMatchObject({
      updateId: 900,
      reason: `activation_mode_unhealthy:${reason}`,
      failureClass: 'awaiting_proof',
      resolutionRequired: true,
      unattainable: true,
    });
    expect(res.stoppedAt.activationMode).toMatchObject({ mode: null, reason });
    // N+1 never passes N, and here nothing passed at all.
    expect(queue.readPending(dir).map((r) => r.updateId)).toEqual([900, 901]);
    // NOT ONE SIDECAR READ. A process that cannot say which state it is in has
    // no business opening a journal to decide something it may not decide.
    expectTouchedNothing(counts);
    expect(sidecarBytes(dir)).toEqual(before);
  });

  test('an absent seam is a hold, not a default', async () => {
    // A coordinator built without the seam must wedge. A default of
    // `legacy_settlement` would let any caller that forgot the wiring quietly
    // claim Phase L; a default of "carry on" would hand `decision_v1` back to
    // the pane path before a fence exists.
    const base = tempRoot();
    const dir = seedLegacy(base, [910]);
    const { drain, counts, delivered } = harness(dir, { activationMode: undefined });
    // `activationMode: undefined` is an explicitly absent seam, distinct from
    // "not passed at all" — prove that one too, on a bare coordinator.
    const bare = createDrainCoordinator({
      queue, log: silentLog, resolveRoute: () => ({ ok: true, profile: 'main', windowKey: 'main' }),
      deliver: async () => { throw new Error('deliver must not be reached'); },
      lookupTransportClaim: async () => { throw new Error('claim lookup must not be reached'); },
    });

    const res = await drain.drainOnce(dir, 'main');
    const bareRes = await bare.drainOnce(dir, 'main');

    expect(delivered).toEqual([]);
    expect(res.stoppedAt.reason).toBe('activation_mode_unhealthy:activation_mode_missing');
    expect(bareRes.stoppedAt.reason).toBe(
      'activation_mode_unhealthy:activation_mode_threw:drain has no activation mode seam'
    );
    expectTouchedNothing(counts);
  });

  test('a THROWING seam holds with the throw named, and reads nothing', async () => {
    const base = tempRoot();
    const dir = seedLegacy(base, [911]);
    const { drain, counts } = harness(dir, {
      activationMode: () => { throw new Error('settings unreadable'); },
    });

    const res = await drain.drainOnce(dir, 'main');

    expect(res.stoppedAt.reason).toBe('activation_mode_unhealthy:activation_mode_threw:settings unreadable');
    expectTouchedNothing(counts);
  });

  test('THE MODE IS ASKED ONCE PER PASS, not once per record', async () => {
    const base = tempRoot();
    const dir = seedLegacy(base, [920, 921, 922]);
    const { drain, counts, delivered } = harness(dir);

    await drain.drainOnce(dir, 'main');

    expect(delivered).toEqual([920, 921, 922]);
    // Two records decided under two different operating states is the exact
    // incoherence the per-pass resolution exists to prevent.
    expect(counts.modeAsks).toBe(1);
    await drain.drainOnce(dir, 'main');
    expect(counts.modeAsks).toBe(2);
  });
});

// ---------------------------------------------- legacy_settlement behaviour

describe('legacy_settlement settles legacy and schedules no decisions', () => {
  test('a reviewed disposition retires the live 316 shape with zero injection', async () => {
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

    expect(delivered).toEqual([808499317]);
    expect(res.delivered).toBe(2);
    expect(queue.readPending(dir)).toHaveLength(0);
    expect(counts.attemptAppend).toBe(0);
    expect(counts.dispositionAppend).toBe(0);
    expect(sidecarBytes(dir)).toEqual(before);
    expect(res.backlog.activationMode).toBe(LEGACY_SETTLEMENT);
    expect(res.backlog.activationModeHealthy).toBe(true);
  });

  test('a retryable legacy record still reaches ONLY the legacy pane path', async () => {
    const base = tempRoot();
    const dir = seedLegacy(base, [930]);
    writeAttempts(dir, [JSON.stringify({ updateId: 930, state: 'retryable' })]);
    const { drain, counts, delivered } = harness(dir);

    await drain.drainOnce(dir, 'main');

    expect(delivered).toEqual([930]);
    expect(counts.claimLookup).toBe(1);
    expect(counts.attemptAppend).toBe(0);
    expect(queue.readPending(dir)).toHaveLength(0);
  });

  test('a no-match legacy record takes the same pane path', async () => {
    const base = tempRoot();
    const dir = seedLegacy(base, [931]);
    const { drain, delivered, counts } = harness(dir);

    await drain.drainOnce(dir, 'main');

    expect(delivered).toEqual([931]);
    expect(counts.attemptAppend).toBe(0);
  });

  test('a VALID mode does not weaken the Step 2A gate: decision_v1 still holds for the fence', async () => {
    const base = tempRoot();
    const dir = seedDecisionV1(base, [940, 941]);
    const { drain, counts, delivered } = harness(dir);

    const res = await drain.drainOnce(dir, 'main');

    expect(delivered).toEqual([]);
    expect(res.stoppedAt.reason).toBe('legacy_journal_gate:decision_requires_stable_fence');
    expect(res.stoppedAt.resolutionRequired).toBe(true);
    // Durable and ordered, exactly as v7 §3 Phase L step 3 requires: queued
    // behind legacy work, never decided.
    expect(queue.readPending(dir).map((r) => r.updateId)).toEqual([940, 941]);
    expect(counts.claimLookup).toBe(0);
    expect(counts.deliver).toBe(0);
    expect(counts.decisionSeam).toBe(0);
    expect(counts.ack).toBe(0);
  });

  test('a VALID mode does not weaken protocol conflict either', async () => {
    const base = tempRoot();
    const dir = seedDecisionV1(base, [945]);
    writeAttempts(dir, [liveLatchLine(945)]);
    const { drain, counts } = harness(dir);

    const res = await drain.drainOnce(dir, 'main');

    expect(res.stoppedAt.reason).toBe('legacy_journal_gate:protocol_conflict');
    expect(counts.claimLookup).toBe(0);
    expect(counts.deliver).toBe(0);
    expect(counts.ack).toBe(0);
  });

  test('N+1 CANNOT PASS A HELD N across both source kinds', async () => {
    // A held legacy head in front of a queued decision_v1 source: neither
    // moves, and the decision_v1 record does not get to overtake because its
    // own hold is "later".
    const base = tempRoot();
    const dir = seedLegacy(base, [LIVE_LATCH]);
    // Appended through the PRODUCTION door so it is genuinely stamped, into the
    // same spool as the legacy head. `seedDecisionV1`'s blanket assertion does
    // not fit a mixed queue, so this one classifies the record it just added.
    const stamped = spool.acceptInbound({
      dataRoot: base,
      routeKey: 'main',
      text: 'the one behind the wedge',
      from: 'james',
      metadata: { updateId: LIVE_LATCH + 1, chatId: CHAT, messageId: (LIVE_LATCH + 1) * 10 },
      targetProfile: 'main',
      targetWindow: 'main',
      targetSession: 'session-at-append',
      producerAppGeneration: 'app-session-test',
      producerSessionId: 'sess-test',
    });
    expect(stamped.ok).toBe(true);
    const byId = new Map(queue.readPending(dir).map((r) => [r.updateId, r]));
    expect(classifySourceRecord(byId.get(LIVE_LATCH)).protocol).toBe(SOURCE_PROTOCOLS.LEGACY);
    expect(classifySourceRecord(byId.get(LIVE_LATCH + 1)).protocol).toBe(SOURCE_PROTOCOLS.DECISION_V1);
    writeAttempts(dir, [liveLatchLine(LIVE_LATCH)]);
    const { drain, counts, delivered } = harness(dir);

    const res = await drain.drainOnce(dir, 'main');

    expect(delivered).toEqual([]);
    expect(res.stoppedAt.updateId).toBe(LIVE_LATCH);
    expect(res.stoppedAt.reason).toMatch(/^orphaned_attempt:/);
    expect(queue.readPending(dir).map((r) => r.updateId)).toEqual([LIVE_LATCH, LIVE_LATCH + 1]);
    expect(counts.deliver).toBe(0);
    expect(counts.ack).toBe(0);
  });
});

// ------------------------------------------------------------ health surface

describe('health can tell the four states apart', () => {
  function backlogFor(res) {
    expect(res.backlog).toBeTruthy();
    return res.backlog;
  }

  test('legacy_settlement with an empty queue scores ok and NAMES the mode', async () => {
    const base = tempRoot();
    const dir = seedLegacy(base, [950]);
    const { drain } = harness(dir);
    const res = await drain.drainOnce(dir, 'main');

    const backlog = backlogFor(res);
    expect(backlog).toMatchObject({
      activationMode: LEGACY_SETTLEMENT, activationModeHealthy: true, activationModeReason: null,
    });
    expect(scoreBacklogHealth(backlog).ok).toBe(true);
  });

  test('AN UNHEALTHY MODE IS CRITICAL EVEN WITH AN EMPTY QUEUE', async () => {
    // The trap: an install nobody configured refuses every message that will
    // ever arrive, and until the first one does its queue is empty — which the
    // scorer used to answer `ok: true` to immediately. S491 in a new place.
    const base = tempRoot();
    const emptyDir = spool.resolveSpoolDir(base, 'main');
    expect(emptyDir.ok).toBe(true);
    fs.mkdirSync(emptyDir.dir, { recursive: true });
    const { drain } = harness(emptyDir.dir, { activationMode: () => null });

    const res = await drain.drainOnce(emptyDir.dir, 'main');
    const backlog = backlogFor(res);

    expect(backlog.pendingCount).toBe(0);
    expect(backlog.activationModeHealthy).toBe(false);
    expect(backlog.activationModeReason).toBe('activation_mode_missing');
    const scored = scoreBacklogHealth(backlog);
    expect(scored.severity).toBe('critical');
    expect(scored.reasons).toContain('activation_mode_unhealthy:activation_mode_missing');
  });

  test('FRESH POLLING CANNOT RESCUE AN UNHEALTHY MODE', async () => {
    const base = tempRoot();
    const dir = seedLegacy(base, [951]);
    const { drain } = harness(dir, { activationMode: () => 'decision_scheduling' });
    const res = await drain.drainOnce(dir, 'main');

    const scored = scoreTelegramChannel({ pollerFresh: true, backlog: backlogFor(res) });
    expect(scored.severity).toBe('critical');
    expect(scored.ok).toBe(false);
    expect(scored.reasons).toContain('activation_mode_unhealthy:activation_mode_unknown');
  });

  test('a legacy head hold and a stable-fence hold stay DISTINGUISHABLE under a healthy mode', async () => {
    const legacyBase = tempRoot();
    const legacyDir = seedLegacy(legacyBase, [LIVE_LATCH]);
    writeAttempts(legacyDir, [liveLatchLine(LIVE_LATCH)]);
    const legacyRes = await harness(legacyDir).drain.drainOnce(legacyDir, 'main');

    const decisionBase = tempRoot();
    const decisionDir = seedDecisionV1(decisionBase, [960]);
    const decisionRes = await harness(decisionDir).drain.drainOnce(decisionDir, 'main');

    // Same severity, different cause, and the cause is readable from the
    // published document rather than only from the log.
    expect(legacyRes.backlog.activationModeHealthy).toBe(true);
    expect(decisionRes.backlog.activationModeHealthy).toBe(true);
    expect(legacyRes.backlog.blockedReason).toMatch(/^orphaned_attempt:/);
    expect(decisionRes.backlog.blockedReason).toBe('legacy_journal_gate:decision_requires_stable_fence');
    expect(scoreBacklogHealth(legacyRes.backlog).severity).toBe('critical');
    expect(scoreBacklogHealth(decisionRes.backlog).severity).toBe('critical');
  });

  test('THE PUBLISHED DOCUMENT carries the mode all the way to the health projection', async () => {
    // The 8.6-hour outage was not a missing check, it was a correct finding
    // that never reached a surface anyone read. So this follows the mode
    // through the real publication path: drain snapshot -> writeBacklogHealth
    // -> telegram-backlog-health.json -> the projection hm-startup-health
    // scores, including its own recompute step.
    const telegramDrainWiring = require('../modules/main/telegram-drain-wiring');
    const base = tempRoot();
    const dir = seedLegacy(base, [955]);
    const statePath = path.join(base, 'runtime', 'telegram-backlog-health.json');
    const { drain } = harness(dir, { activationMode: () => 'decision_scheduling' });

    const res = await drain.drainOnce(dir, 'main');
    const written = telegramDrainWiring.writeBacklogHealth({
      statePath, routeKey: 'main', backlog: res.backlog, nowMs: Date.now(),
    });
    expect(written.ok).toBe(true);

    const published = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    expect(published.routes.main).toMatchObject({
      activationMode: null,
      activationModeHealthy: false,
      activationModeReason: 'activation_mode_unknown',
    });

    // THE REAL READER, ON THE REAL FILE. Hand-spreading the stored route and
    // calling the scorer directly proves the scorer, not the projection — and
    // the projection is where a correct finding gets dropped (Architect #156).
    const { readTelegramBacklogHealth } = require('../scripts/hm-startup-health');
    const projected = readTelegramBacklogHealth(base, Date.now(), { statePath });

    expect(projected.severity).toBe('critical');
    expect(projected.reasons).toContain('main:activation_mode_unhealthy:activation_mode_unknown');
    // The three fields reach the projected route, so an operator reading the
    // document can see WHICH state the channel believes it is in without
    // reverse-engineering it from a reason code.
    expect(projected.routes.main).toMatchObject({
      severity: 'critical',
      activationMode: null,
      activationModeHealthy: false,
      activationModeReason: 'activation_mode_unknown',
    });
  });

  test('THE REAL READER refuses an OMITTED reason rather than projecting it as success', () => {
    // `?? null` in the projection would present a document that never wrote a
    // reason as the resolver's canonical success shape — erasing, one layer
    // later, the exact incoherence the scorer was just taught to reject. Absent
    // is named; explicit null is preserved (Architect #159).
    const { readTelegramBacklogHealth } = require('../scripts/hm-startup-health');
    const base = tempRoot();
    const statePath = path.join(base, 'runtime', 'telegram-backlog-health.json');
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const nowMs = Date.now();
    fs.writeFileSync(statePath, JSON.stringify({
      schema: 'telegramBacklogHealth.v0',
      updatedAtMs: nowMs,
      routes: {
        main: {
          pendingCount: 0,
          oldestPendingUpdateId: null,
          oldestPendingReceivedAtMs: null,
          blockedReason: null,
          proofUnattainable: false,
          attemptedCount: 0,
          observedAtMs: nowMs,
          // Healthy, a mode this build DOES recognise, and no reason field at
          // all. Everything reads clean except the omission.
          activationMode: LEGACY_SETTLEMENT,
          activationModeHealthy: true,
        },
      },
    }), 'utf8');

    const projected = readTelegramBacklogHealth(base, nowMs, { statePath });

    expect(projected.severity).toBe('critical');
    expect(projected.reasons).toContain(
      'main:activation_mode_incoherent:healthy_with_failure_reason:undefined'
    );
    // And the projected reason is NON-NULL, so the document itself shows the
    // omission rather than looking like a clean success.
    expect(projected.routes.main.activationModeReason).toBe('activation_mode_unreported');
  });

  test('THE REAL READER projects a HEALTHY mode too, not only the failures', async () => {
    const telegramDrainWiring = require('../modules/main/telegram-drain-wiring');
    const { readTelegramBacklogHealth } = require('../scripts/hm-startup-health');
    const base = tempRoot();
    const dir = seedLegacy(base, [956]);
    const statePath = path.join(base, 'runtime', 'telegram-backlog-health.json');
    const { drain } = harness(dir);

    const res = await drain.drainOnce(dir, 'main');
    telegramDrainWiring.writeBacklogHealth({
      statePath, routeKey: 'main', backlog: res.backlog, nowMs: Date.now(),
    });

    const projected = readTelegramBacklogHealth(base, Date.now(), { statePath });

    expect(projected.severity).toBe('ok');
    expect(projected.routes.main).toMatchObject({
      activationMode: LEGACY_SETTLEMENT,
      activationModeHealthy: true,
      activationModeReason: null,
    });
  });

  test.each([
    [
      'healthy true with an UNKNOWN mode',
      { activationModeHealthy: true, activationMode: 'decision_scheduling', activationModeReason: null },
      'activation_mode_incoherent:healthy_without_recognized_mode:decision_scheduling',
    ],
    [
      'healthy true with NO mode',
      { activationModeHealthy: true, activationMode: null, activationModeReason: null },
      'activation_mode_incoherent:healthy_without_recognized_mode:null',
    ],
    [
      'healthy true with a non-string mode',
      { activationModeHealthy: true, activationMode: 7, activationModeReason: null },
      'activation_mode_incoherent:healthy_without_recognized_mode:7',
    ],
    [
      'a VALID mode carrying a failure reason',
      { activationModeHealthy: true, activationMode: 'legacy_settlement', activationModeReason: 'activation_mode_unknown' },
      'activation_mode_incoherent:healthy_with_failure_reason:activation_mode_unknown',
    ],
    [
      'healthy false with a forged valid name',
      { activationModeHealthy: false, activationMode: 'legacy_settlement', activationModeReason: null },
      'activation_mode_unhealthy:activation_mode_unreported',
    ],
  ])('A HOSTILE PERSISTED SNAPSHOT fails closed: %s', (_label, fields, reason) => {
    // scoreBacklogHealth reads documents back from DISK, so
    // `activationModeHealthy: true` is a claim by whoever last wrote the file.
    // A corrupted, stale or forged snapshot must not be able to assert health
    // beside a mode this build cannot operate in — especially on an empty
    // queue, where every other signal reads clean (Architect #153).
    const scored = scoreBacklogHealth({
      pendingCount: 0,
      oldestPendingUpdateId: null,
      oldestPendingAgeMs: null,
      oldestPendingAgeUnknown: false,
      blockedReason: null,
      proofUnattainable: false,
      ...fields,
    });
    expect(scored.severity).toBe('critical');
    expect(scored.ok).toBe(false);
    expect(scored.reasons).toEqual([reason]);
  });

  test.each([
    ['ok with an unknown mode', { ok: true, mode: 'decision_scheduling', reason: null }],
    ['ok with no mode', { ok: true, mode: null, reason: null }],
    ['ok with a non-string mode', { ok: true, mode: 7, reason: null }],
    ['ok with a near-miss mode', { ok: true, mode: ' legacy_settlement', reason: null }],
    ['ok with a VALID mode but a failure reason', { ok: true, mode: 'legacy_settlement', reason: 'activation_mode_unknown' }],
    ['ok with a valid mode and an empty-string reason', { ok: true, mode: 'legacy_settlement', reason: '' }],
  ])('THE PRODUCER fails closed on a forged activation: %s', (_label, activation) => {
    // The boolean must not become a second authority at EITHER boundary, and
    // this is the producer end. `{ok: true}` beside a mode nobody recognises —
    // or beside a reason that says it failed — is an input disagreeing with
    // itself, and publishing it as healthy would erase the contradiction on the
    // way to the health document (Architect #153/#155).
    const forged = summarizeBacklog({ pending: [], nowMs: Date.now(), activation });
    expect(forged.activationModeHealthy).toBe(false);
    expect(forged.activationMode).toBe(null);
    expect(forged.activationModeReason).toBe('activation_mode_incoherent');
    // And it stays refused after a round trip through the disk scorer.
    expect(scoreBacklogHealth(forged).severity).toBe('critical');
    expect(scoreBacklogHealth(forged).reasons).toEqual(['activation_mode_unhealthy:activation_mode_incoherent']);
  });

  test('the resolver\'s own success shape is the one that publishes healthy', () => {
    const honest = summarizeBacklog({
      pending: [], nowMs: Date.now(), activation: { ok: true, mode: LEGACY_SETTLEMENT, reason: null },
    });
    expect(honest).toMatchObject({
      activationMode: LEGACY_SETTLEMENT, activationModeHealthy: true, activationModeReason: null,
    });
    expect(scoreBacklogHealth(honest).ok).toBe(true);
    // Exactly what the real resolver returns, threaded straight through.
    const { resolveActivationMode } = require('../modules/main/telegram-activation-mode');
    const real = summarizeBacklog({
      pending: [], nowMs: Date.now(), activation: resolveActivationMode(LEGACY_SETTLEMENT),
    });
    expect(real.activationModeHealthy).toBe(true);
  });

  test('a snapshot with NO activation fields is unhealthy, not healthy by omission', () => {
    // Same doctrine as `pollerFresh`: an unasked question is not answered
    // optimistically. A producer that cannot say what state it was in is not
    // evidence that the state was fine.
    const bare = summarizeBacklog({ pending: [], nowMs: Date.now() });
    expect(bare.activationModeHealthy).toBe(false);
    expect(bare.activationModeReason).toBe('activation_mode_unreported');
    expect(scoreBacklogHealth(bare).severity).toBe('critical');
  });
});

// --------------------------------------- legacy-attempt append reachability

describe('no production caller can append a legacy attempt row', () => {
  /**
   * EVERY production JS file, not a require-closure from one entry point.
   *
   * The first cut walked the graph from `squidrun-app.js`, and Architect #150
   * caught what that misses: `ui/scripts/hm-telegram-recover-inbound.js` is a
   * STANDALONE entry point that imports the queue directly, so a future
   * recovery `appendAttempt` call would have been invisible to it. Enumerating
   * every tracked production file instead of reasoning about reachability is
   * strictly broader and cannot be defeated by an entry point nobody listed.
   *
   * Excludes only `__tests__` (fixtures may legitimately append) and the owning
   * queue module, which is checked separately and more strictly below.
   */
  /**
   * THE WHOLE `ui/` PRODUCTION ROOT, with named exclusions.
   *
   * Two narrowings got caught here, and both were the same mistake. The first
   * cut walked a require-closure from `squidrun-app.js`, which misses
   * standalone entry points like `scripts/hm-telegram-recover-inbound.js`. The
   * second walked only `modules/` and `scripts/`, which misses `ui/main.js` and
   * anything else at the top level (Architect #150/#156). Enumerating the tree
   * and naming what is excluded cannot be defeated by a directory nobody
   * thought of; a reachability argument can.
   */
  const EXCLUDED_DIRS = new Set(['node_modules', '__tests__', 'dist', 'build', 'out', 'release', '.git', 'coverage']);

  function productionFiles() {
    const root = path.join(__dirname, '..');
    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js')) files.push(full);
      }
    };
    walk(root);
    return files;
  }

  /**
   * ANY EXECUTABLE REFERENCE, not just a call shape.
   *
   * Comments are stripped first, because a raw match fired on the doc comment
   * that explains the function — the false positive that gets a real check
   * deleted rather than fixed. But after that the detector deliberately looks
   * for the NAME rather than `name(`: `const write = queue.appendAttempt`,
   * `const { appendAttempt } = queue` and `queue['appendAttempt'](...)` are all
   * calls one indirection later, and a call-shape regex sees none of them
   * (Architect #156). In production code there is no legitimate reason to
   * mention this identifier at all outside the module that owns it.
   */
  function findAppendAttemptCalls(source) {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*)/.test(line))
      .filter((line) => /appendAttempt/.test(line))
      .map((line) => line.trim());
  }

  test('STATIC: no production file outside the owning module calls it', () => {
    const files = productionFiles();
    // Sanity: the sweep actually covers the files that matter. Without this an
    // empty list would pass the real assertion vacuously.
    expect(files).toContain(QUEUE_PATH);
    expect(files).toContain(APP_PATH);
    expect(files).toContain(path.join(MODULES_DIR, 'main', 'telegram-ingress-drain.js'));
    expect(files).toContain(path.join(MODULES_DIR, 'main', 'telegram-ingress-spool.js'));
    expect(files).toContain(path.join(__dirname, '..', 'scripts', 'hm-telegram-recover-inbound.js'));
    // Top-level entry points too, which a modules/+scripts/ walk missed.
    expect(files).toContain(path.join(__dirname, '..', 'main.js'));
    expect(files.length).toBeGreaterThan(50);

    const offenders = [];
    for (const file of files) {
      if (file === QUEUE_PATH) continue;
      const calls = findAppendAttemptCalls(fs.readFileSync(file, 'utf8'));
      if (calls.length) offenders.push(path.relative(path.join(__dirname, '..'), file));
    }
    expect(offenders).toEqual([]);

    // And inside the owning module it is DEFINED and EXPORTED only — a private
    // internal caller would be just as reachable and just as invisible to the
    // scan above, which skips this file by construction.
    const queueSource = fs.readFileSync(QUEUE_PATH, 'utf8');
    expect(queueSource).toMatch(/function appendAttempt\(/);
    expect(queueSource).toMatch(/^ {2}appendAttempt,$/m);
    // CODE LINES ONLY. Counting raw occurrences failed on the doc comment that
    // explains the function, which is exactly the kind of false positive that
    // gets a real check deleted rather than fixed.
    const codeReferences = queueSource
      .split('\n')
      // Trimmed: this file is checked out with CRLF endings on Windows, and a
      // comparison that fails on a stray `\r` is a check nobody keeps.
      .map((line) => line.replace(/\s+$/, ''))
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .filter((line) => /\bappendAttempt\b/.test(line));
    // Exactly two code lines: the definition and the export. Any third is a call.
    expect(codeReferences).toEqual([
      'function appendAttempt(dir, updateId, entryState, provenance = {}) {',
      '  appendAttempt,',
    ]);
    // The two-line assertion above IS the owner-module proof, and it is the
    // strict one: the sweep skips this file by construction, so a private
    // internal caller would be invisible to it, and a third code line here is
    // exactly what that caller would look like. (The shared detector is not
    // reused here — it deliberately matches any executable reference now,
    // including this module's own definition and export.)
  });

  test('STATIC: the SAME detector fires on a real recovery-script caller', () => {
    // A reachability test that cannot fail is a comment. This runs the detector
    // the previous test uses against the actual recovery script's bytes plus
    // one added call — the exact shape Architect #150 named — rather than
    // against an isolated string a weaker detector would also catch.
    const recoveryPath = path.join(__dirname, '..', 'scripts', 'hm-telegram-recover-inbound.js');
    const real = fs.readFileSync(recoveryPath, 'utf8');
    expect(findAppendAttemptCalls(real)).toEqual([]);

    // Every shape that is a call one indirection later, not just `name(`.
    for (const shape of [
      "queue.appendAttempt(args.dir, args.updateId, 'attempted');",
      "appendAttempt(dir, 1, 'attempted');",
      "const write = queue.appendAttempt;",
      "const { appendAttempt } = queue;",
      "queue['appendAttempt'](dir, 1, 'attempted');",
      'queue["appendAttempt"](dir, 1);',
      "const op = 'appendAttempt'; queue[op](dir, 1);",
    ]) {
      expect(findAppendAttemptCalls(`${real}\n${shape}\n`)).toEqual([shape]);
    }

    // ...and it does NOT fire on prose. The doc comment in the queue module is
    // what broke the first version of this check.
    expect(findAppendAttemptCalls('// appendAttempt(dir) is never called here\n')).toEqual([]);
    expect(findAppendAttemptCalls(' * appendAttempt writes JSON + newline as ONE record\n')).toEqual([]);
    expect(findAppendAttemptCalls('/* appendAttempt(x) */\n')).toEqual([]);
  });

  test('DYNAMIC: no drain path appends an attempt row, in any of the states above', async () => {
    // The counter's blind spot is the paths a test never drives; the static
    // scan's blind spot is a call it cannot see. Together they close.
    const base = tempRoot();
    const scenarios = [
      ['legacy delivered', () => seedLegacy(base, [970]), () => {}, () => LEGACY_SETTLEMENT],
      ['legacy held', () => seedLegacy(tempRoot(), [971]), (d) => writeAttempts(d, [liveLatchLine(971)]), () => LEGACY_SETTLEMENT],
      ['decision_v1 held', () => seedDecisionV1(tempRoot(), [972]), () => {}, () => LEGACY_SETTLEMENT],
      ['mode missing', () => seedLegacy(tempRoot(), [973]), () => {}, () => null],
      ['mode unknown', () => seedLegacy(tempRoot(), [974]), () => {}, () => 'decision_scheduling'],
    ];
    for (const [, seed, mutate, mode] of scenarios) {
      const dir = seed();
      mutate(dir);
      const { drain, counts } = harness(dir, { activationMode: mode });
      await drain.drainOnce(dir, 'main');
      expect(counts.attemptAppend).toBe(0);
      expect(fs.existsSync(queue.attemptsPath(dir)) ? 'checked' : 'absent').toBeTruthy();
    }
  });
});

// ------------------------------------------------- production wiring proof

describe('the mode is production authority, frozen at startup', () => {
  function appSource() {
    return fs.readFileSync(APP_PATH, 'utf8');
  }

  test('the app FREEZES the mode in init, immediately after loadSettings', () => {
    const source = appSource();
    const lines = source.split('\n');
    const loadIndex = lines.findIndex((l) => l.includes('this.settings.loadSettings();'));
    expect(loadIndex).toBeGreaterThan(-1);
    // Within a few lines of the load, ahead of everything Telegram.
    const window = lines.slice(loadIndex, loadIndex + 10).join('\n');
    expect(window).toContain('this.captureTelegramActivationMode();');

    const captureIndex = lines.findIndex((l) => l.includes('this.captureTelegramActivationMode();'));
    const pollerIndex = lines.findIndex((l) => l.includes('this.startTelegramPoller();'));
    expect(captureIndex).toBeGreaterThan(-1);
    expect(pollerIndex).toBeGreaterThan(-1);
    // The freeze happens before anything can consume it.
    expect(captureIndex).toBeLessThan(pollerIndex);
  });

  /**
   * EXECUTABLE LINES ONLY, for the same reason the append detector strips
   * comments (Architect #150/#152): these methods DOCUMENT the authority they
   * deliberately do not consult, and an assertion that fired on the explanation
   * of a rule rather than a violation of it is a check that gets deleted.
   */
  function executableBody(source, startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    expect(start).toBeGreaterThan(-1);
    const end = endMarker ? source.indexOf(endMarker) : source.indexOf('\n  }', start) + 4;
    expect(end).toBeGreaterThan(start);
    return source
      .slice(start, end)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*)/.test(line))
      .join('\n');
  }

  test('there is exactly ONE authority, and it is the loaded startup settings', () => {
    const body = executableBody(
      appSource(), 'captureTelegramActivationMode() {', 'getTelegramActivationModeSetting() {'
    );
    expect(body).toContain('this.ctx.currentSettings');
    // A second mutable snapshot consulted when the field is absent would fire
    // in exactly the case that matters: an install nobody has configured.
    expect(body).not.toMatch(/loadSettings\s*\(/);
  });

  test('the getter does NOT capture, so a caller outside startup wedges', () => {
    const getter = executableBody(appSource(), 'getTelegramActivationModeSetting() {', null);
    expect(getter).toContain('never frozen at startup');
    // Lazy capture here would mean anything that mutated settings between
    // construction and the first drain still decided this generation's state.
    expect(getter).not.toContain('this.ctx.currentSettings');
  });

  test('the drain is wired to the frozen getter, not to live settings', () => {
    const source = appSource();
    expect(source).toContain('activationMode: () => this.getTelegramActivationModeSetting()');
    expect(source).not.toContain('activationMode: () => this.ctx.currentSettings');
  });

  test('the settings default is null, never a mode', () => {
    // A default of `legacy_settlement` would make every install claim to be
    // settling legacy without anyone deciding it — and the key must still EXIST
    // in the defaults or `pruneUnknownSettings` drops an operator's value.
    const settingsSource = fs.readFileSync(path.join(MODULES_DIR, 'main', 'settings-manager.js'), 'utf8');
    expect(settingsSource).toMatch(/telegramTransportActivationMode:\s*null,/);
    expect(settingsSource).not.toMatch(/telegramTransportActivationMode:\s*'legacy_settlement'/);
  });
});
