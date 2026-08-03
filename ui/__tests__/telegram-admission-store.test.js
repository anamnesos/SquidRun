/**
 * S491 v3 checkpoint A — storage foundation.
 *
 * TEMP DATABASES ONLY. The live evidence ledger is not a test fixture, and
 * nothing here opens it.
 *
 * The theme of every test: an identity that could be silently rewritten is not
 * an identity, and an exclusive claim that can be stolen is not exclusive.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  CLAIM_STATES,
  SOURCE_STATES,
  QUEUE_ACK_STATES,
  sha256,
  applyTelegramAdmissionSchema,
  verifyInstalledSchema,
  recordImmutableSource,
  claimTransportAttempt,
  recordDeliveryStarted,
  closeUnsentClaim,
  promoteToAdmittedOwned,
} = require('../modules/main/telegram-admission-store');

function createDatabase(filePath) {
  try {
    const { DatabaseSync } = require('node:sqlite');
    return new DatabaseSync(filePath);
  } catch (_) {
    const BetterSqlite3 = require('better-sqlite3');
    return new BetterSqlite3(filePath);
  }
}

const tempRoots = [];
const openDbs = [];
const openStores = [];
/**
 * THE REAL EVIDENCE-LEDGER SCHEMA, in a temp database.
 *
 * A1's fixture created only the private Telegram tables, so its 56 green tests
 * proved nothing about comms_journal, obligations or ledger_events — the very
 * authorities the state machine is supposed to move. Instantiating the real
 * store class runs its real migrations, so these tests can query all four.
 */
function openRealLedger(dbPath) {
  const { EvidenceLedgerStore } = require('../modules/main/evidence-ledger-store');
  const store = new EvidenceLedgerStore({ dbPath, enabled: true });
  const init = store.init();
  if (!init || init.ok !== true) throw new Error(`real ledger init failed: ${JSON.stringify(init)}`);
  const db = store.db;
  // The gate requires the PRODUCTION WRITER HANDLE to assert durable commit;
  // the ledger opens with synchronous=NORMAL, so the fixture raises it to FULL
  // exactly as production wiring will have to. See the durability tests below.
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec('PRAGMA synchronous=FULL;');
  openStores.push(store);
  return db;
}

function freshDb() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-admission-store-'));
  tempRoots.push(root);
  const db = openRealLedger(path.join(root, 'ledger.db'));
  applyTelegramAdmissionSchema(db);
  return db;
}
afterEach(() => {
  while (openStores.length) { try { openStores.pop().close(); } catch { /* already closed */ } }
  while (openDbs.length) { try { openDbs.pop().close(); } catch { /* already closed */ } }
  while (tempRoots.length) fs.rmSync(tempRoots.pop(), { recursive: true, force: true });
});

const NOW = 1_785_780_000_000;
const CUTOVER = 'cutover-s491';

function sourceInput(overrides = {}) {
  return {
    messageId: 'telegram-in-900000001',
    updateId: 900000001,
    chatId: 6543210,
    routeKey: 'main',
    profile: 'main',
    windowKey: 'main',
    rawBody: 'synthetic checkpoint A fixture',
    canonicalPayloadSha256: sha256('canonical-a'),
    mediaIdentitySha256: sha256('media-a'),
    cutoverId: CUTOVER,
    obligorAddress: 'architect',
    recordedAtMs: NOW,
    ...overrides,
  };
}

function claimInput(sourceRowId, overrides = {}) {
  return {
    cutoverId: CUTOVER,
    routeKey: 'main',
    updateId: 900000001,
    sourceRowId,
    appGeneration: 'tg-gen-1',
    paneLaunchId: 'launch-1',
    paneId: '1',
    role: 'architect',
    consumerRuntime: 'codex',
    attemptNonce: 'nonce-1',
    attemptAtMs: NOW,
    ...overrides,
  };
}

function ownedInput(claimId, overrides = {}) {
  return {
    messageId: 'telegram-in-900000001',
    claimId,
    admissionId: 'adm-1',
    consumerSessionId: 'sess-1',
    runtimeSubmissionId: 'turn-1',
    runtimeSubmissionKind: 'codex_turn_id',
    obligorAddress: 'architect',
    queueAckIntent: 'ack-intent-1',
    hookProcessId: 'pid-4242',
    hookParentProcessId: 'ppid-1111',
    atMs: NOW + 1000,
    ...overrides,
  };
}

/** Drive a record all the way to a delivery-started claim. */
function seedToDeliveryStarted(db) {
  const src = recordImmutableSource(db, sourceInput());
  const claim = claimTransportAttempt(db, claimInput(src.sourceRowId));
  recordDeliveryStarted(db, { claimId: claim.claimId, atMs: NOW + 10 });
  return { src, claim };
}

describe('immutable source row', () => {
  test('IT RECORDS ONCE and returns a deterministic obligation id', () => {
    const db = freshDb();
    const result = recordImmutableSource(db, sourceInput());

    expect(result.ok).toBe(true);
    expect(result.created).toBe(true);
    expect(result.sourceRowId).toBeGreaterThan(0);
    expect(result.obligationId).toMatch(/^obl_[0-9a-f]{64}$/);
  });

  test('THE OBLIGATION ID IS STABLE across re-recording — it is computed before the prompt', () => {
    const db = freshDb();
    const first = recordImmutableSource(db, sourceInput());
    const second = recordImmutableSource(db, sourceInput());

    expect(second.created).toBe(false);
    expect(second.obligationId).toBe(first.obligationId);
    expect(second.sourceRowId).toBe(first.sourceRowId);
  });

  test('THE SOURCE IS A REAL comms_journal ROW, not a private table', () => {
    const db = freshDb();
    const result = recordImmutableSource(db, sourceInput());

    const row = db.prepare('SELECT * FROM comms_journal WHERE row_id = ?').get(result.sourceRowId);
    expect(row.channel).toBe('telegram');
    expect(row.direction).toBe('inbound');
    expect(row.status).toBe(SOURCE_STATES.RECORDED);
    expect(row.message_id).toBe('telegram-in-900000001');
    // And the private table A1 invented no longer exists at all.
    const shadow = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='telegram_source_rows'"
    ).get();
    expect(shadow).toBeUndefined();
  });

  test('IT CREATES NO DEBT — recording a source is not an obligation', () => {
    const db = freshDb();
    recordImmutableSource(db, sourceInput());
    const bindings = db.prepare('SELECT COUNT(*) n FROM telegram_obligation_bindings').get();
    expect(Number(bindings.n)).toBe(0);
  });

  test.each([
    ['a changed body', { rawBody: 'transfer the deposit somewhere else' }],
    ['a changed canonical digest', { canonicalPayloadSha256: sha256('different') }],
    ['a changed media identity', { mediaIdentitySha256: sha256('other-photo') }],
    ['a changed chat', { chatId: 999 }],
    ['a changed route', { routeKey: 'sideprofile' }],
    ['a changed profile', { profile: 'sideprofile' }],
    ['a changed window', { windowKey: 'sideprofile' }],
    ['a changed update id', { updateId: 900000002 }],
    ['a changed cutover', { cutoverId: 'cutover-other' }],
  ])('SAME MESSAGE ID WITH %s is a HARD CONFLICT, never a merge', (_label, patch) => {
    const db = freshDb();
    recordImmutableSource(db, sourceInput());

    const result = recordImmutableSource(db, sourceInput(patch));

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('source_identity_conflict');
    // And the stored row is untouched — a rejected write leaves no trace.
    const row = db.prepare('SELECT * FROM comms_journal').get();
    expect(row.raw_body).toBe('synthetic checkpoint A fixture');
    expect(Number(db.prepare('SELECT COUNT(*) n FROM comms_journal').get().n)).toBe(1);
  });

  test.each([
    'messageId', 'chatId', 'routeKey', 'profile', 'windowKey', 'rawBody',
    'canonicalPayloadSha256', 'cutoverId', 'obligorAddress',
  ])('A MISSING %s fails closed', (field) => {
    const db = freshDb();
    const input = sourceInput();
    delete input[field];
    expect(recordImmutableSource(db, input).ok).toBe(false);
  });
});

describe('exclusive transport claim', () => {
  test('THE FIRST CLAIMANT WINS and the claim is recorded', () => {
    const db = freshDb();
    const src = recordImmutableSource(db, sourceInput());
    const claim = claimTransportAttempt(db, claimInput(src.sourceRowId));

    expect(claim.ok).toBe(true);
    expect(claim.created).toBe(true);
    expect(claim.state).toBe(CLAIM_STATES.CLAIMED);
  });

  test('TWO SEQUENTIAL CLAIMANTS ON TWO DATABASE HANDLES: the second is refused', () => {
    // NOT A RACE, and deliberately no longer named as one. These calls are
    // sequential and BEGIN IMMEDIATE would serialize them even if they were
    // not, so this proves the refusal path across handles and nothing more.
    // The true two-coordinator one-pane-write race belongs in checkpoint B.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-admission-race-'));
    tempRoots.push(root);
    const dbPath = path.join(root, 'ledger.db');
    const dbA = openRealLedger(dbPath);
    applyTelegramAdmissionSchema(dbA);
    const dbB = openRealLedger(dbPath);

    const src = recordImmutableSource(dbA, sourceInput());
    const a = claimTransportAttempt(dbA, claimInput(src.sourceRowId, { attemptNonce: 'nonce-A' }));
    const b = claimTransportAttempt(dbB, claimInput(src.sourceRowId, { attemptNonce: 'nonce-B' }));

    const winners = [a, b].filter((r) => r.ok);
    const losers = [a, b].filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0].reason).toBe('claim_held_by_other');
    expect(Number(dbA.prepare('SELECT COUNT(*) n FROM telegram_transport_claims').get().n)).toBe(1);
  });

  test('THE EXACT SAME CLAIMANT IS IDEMPOTENT — a retry gets its own claim back', () => {
    const db = freshDb();
    const src = recordImmutableSource(db, sourceInput());
    const first = claimTransportAttempt(db, claimInput(src.sourceRowId));
    const retry = claimTransportAttempt(db, claimInput(src.sourceRowId));

    expect(retry.ok).toBe(true);
    expect(retry.created).toBe(false);
    expect(retry.claimId).toBe(first.claimId);
  });

  test.each([
    ['a different attempt nonce', { attemptNonce: 'nonce-2' }],
    ['a different app generation', { appGeneration: 'tg-gen-2' }],
    ['a different pane launch', { paneLaunchId: 'launch-2' }],
    ['a different pane', { paneId: '3' }],
    ['a different role', { role: 'builder' }],
    ['a different runtime', { consumerRuntime: 'claude' }],
  ])('A CLAIMANT DIFFERING BY %s is refused, never treated as the same attempt', (_label, patch) => {
    const db = freshDb();
    const src = recordImmutableSource(db, sourceInput());
    claimTransportAttempt(db, claimInput(src.sourceRowId));

    const other = claimTransportAttempt(db, claimInput(src.sourceRowId, patch));

    expect(other.ok).toBe(false);
    expect(other.reason).toBe('claim_held_by_other');
  });

  test('AN OUTSTANDING AMBIGUOUS CLAIM IS NEVER STOLEN, however old it looks', () => {
    // No timer, no grace, no age heuristic. This is the irreducible ambiguous
    // interval and it stays with its owner until a human reconciles it.
    const db = freshDb();
    const src = recordImmutableSource(db, sourceInput());
    const first = claimTransportAttempt(db, claimInput(src.sourceRowId));
    recordDeliveryStarted(db, { claimId: first.claimId, atMs: NOW + 10 });

    const muchLater = claimTransportAttempt(db, claimInput(src.sourceRowId, {
      attemptNonce: 'nonce-much-later',
      attemptAtMs: NOW + 9 * 60 * 60 * 1000,
    }));

    expect(muchLater.ok).toBe(false);
    expect(muchLater.reason).toBe('claim_held_by_other');
    expect(muchLater.detail.heldState).toBe(CLAIM_STATES.DELIVERY_STARTED);
  });

  test('A PROVABLY UNSENT CLAIM may be closed and the key reused', () => {
    const db = freshDb();
    const src = recordImmutableSource(db, sourceInput());
    const first = claimTransportAttempt(db, claimInput(src.sourceRowId));

    const closed = closeUnsentClaim(db, {
      claimId: first.claimId, reason: 'daemon_not_connected', atMs: NOW + 5,
    });
    expect(closed.ok).toBe(true);

    const second = claimTransportAttempt(db, claimInput(src.sourceRowId, { attemptNonce: 'nonce-2' }));
    expect(second.ok).toBe(true);
    expect(second.created).toBe(true);
  });

  test('A CLAIM PAST delivery_started CANNOT be closed as unsent', () => {
    const db = freshDb();
    const { claim } = seedToDeliveryStarted(db);

    const closed = closeUnsentClaim(db, {
      claimId: claim.claimId, reason: 'wishful thinking', atMs: NOW + 20,
    });

    expect(closed.ok).toBe(false);
    expect(closed.reason).toBe('claim_not_provably_unsent');
  });

  test('delivery_started IS DURABLE AND MONOTONIC', () => {
    const db = freshDb();
    const src = recordImmutableSource(db, sourceInput());
    const claim = claimTransportAttempt(db, claimInput(src.sourceRowId));

    recordDeliveryStarted(db, { claimId: claim.claimId, atMs: NOW + 10 });
    recordDeliveryStarted(db, { claimId: claim.claimId, atMs: NOW + 20 });

    const events = db.prepare(
      "SELECT * FROM telegram_transport_events WHERE kind = 'delivery_started'"
    ).all();
    expect(events).toHaveLength(1); // idempotent, never rewound or duplicated
  });

  test('THE CLAIM CREATES NO OBLIGATION — debt comes later or not at all', () => {
    const db = freshDb();
    seedToDeliveryStarted(db);
    expect(Number(db.prepare('SELECT COUNT(*) n FROM telegram_obligation_bindings').get().n)).toBe(0);
  });
});

describe('admitted_owned promotion', () => {
  test('ALL OF IT COMMITS: source brokered, binding, event, outbox, work generation', () => {
    const db = freshDb();
    const { src, claim } = seedToDeliveryStarted(db);

    const owned = promoteToAdmittedOwned(db, ownedInput(claim.claimId));

    expect(owned.ok).toBe(true);
    expect(owned.obligationId).toBe(src.obligationId);
    expect(owned.workGeneration).toBe(1);
    expect(owned.workLeaseToken).toMatch(/^tgl_/);

    expect(db.prepare('SELECT status FROM comms_journal').get().status)
      .toBe(SOURCE_STATES.BROKERED);
    expect(Number(db.prepare('SELECT COUNT(*) n FROM telegram_obligation_bindings').get().n)).toBe(1);
    expect(Number(db.prepare("SELECT COUNT(*) n FROM telegram_binding_events WHERE transition='created'").get().n)).toBe(1);
    expect(Number(db.prepare('SELECT COUNT(*) n FROM telegram_queue_ack_outbox').get().n)).toBe(1);
    expect(db.prepare('SELECT state FROM telegram_transport_claims').get().state)
      .toBe(CLAIM_STATES.ADMITTED);
  });

  test('OR NONE DOES: a failed promotion leaves the source unbrokered and no binding', () => {
    const db = freshDb();
    const { claim } = seedToDeliveryStarted(db);

    const failed = promoteToAdmittedOwned(db, ownedInput(claim.claimId, {
      canonicalPayloadSha256: sha256('a digest that does not match'),
    }));

    expect(failed.ok).toBe(false);
    expect(failed.reason).toBe('source_payload_digest_mismatch');
    expect(db.prepare('SELECT status FROM comms_journal').get().status)
      .toBe(SOURCE_STATES.RECORDED);
    expect(Number(db.prepare('SELECT COUNT(*) n FROM telegram_obligation_bindings').get().n)).toBe(0);
    expect(Number(db.prepare('SELECT COUNT(*) n FROM telegram_queue_ack_outbox').get().n)).toBe(0);
  });

  test('A CLAIM THAT NEVER STARTED DELIVERY cannot be promoted', () => {
    // Debt for words nobody sent is worse than no debt.
    const db = freshDb();
    const src = recordImmutableSource(db, sourceInput());
    const claim = claimTransportAttempt(db, claimInput(src.sourceRowId));

    const owned = promoteToAdmittedOwned(db, ownedInput(claim.claimId));

    expect(owned.ok).toBe(false);
    expect(owned.reason).toBe('claim_not_delivery_started');
  });

  test('AN EXACT REPLAY IS IDEMPOTENT — one obligation, not two', () => {
    const db = freshDb();
    const { claim } = seedToDeliveryStarted(db);

    const first = promoteToAdmittedOwned(db, ownedInput(claim.claimId));
    const replay = promoteToAdmittedOwned(db, ownedInput(claim.claimId));

    expect(replay.ok).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.obligationId).toBe(first.obligationId);
    expect(Number(db.prepare('SELECT COUNT(*) n FROM telegram_obligation_bindings').get().n)).toBe(1);
    expect(Number(db.prepare('SELECT COUNT(*) n FROM telegram_binding_events').get().n)).toBe(1);
  });

  test.each([
    ['a different admission id', { admissionId: 'adm-2' }],
    ['a different consumer session', { consumerSessionId: 'sess-2' }],
    ['a different submission id', { runtimeSubmissionId: 'turn-2' }],
    ['a different submission kind', { runtimeSubmissionKind: 'claude_prompt_id' }],
    ['a different queue ack intent', { queueAckIntent: 'ack-intent-2' }],
  ])('A SECOND PROMOTION WITH %s FAILS CLOSED — identity never rewrites', (_label, patch) => {
    const db = freshDb();
    const { claim } = seedToDeliveryStarted(db);
    promoteToAdmittedOwned(db, ownedInput(claim.claimId));

    const conflicting = promoteToAdmittedOwned(db, ownedInput(claim.claimId, patch));

    expect(conflicting.ok).toBe(false);
    expect(conflicting.reason).toBe('binding_identity_conflict');
  });

  test('THE BINDING CARRIES THE FULL IMMUTABLE IDENTITY the gate names', () => {
    const db = freshDb();
    const { claim } = seedToDeliveryStarted(db);
    promoteToAdmittedOwned(db, ownedInput(claim.claimId, {
      predecessorManifestSha256: sha256('predecessor-manifest'),
    }));

    const binding = db.prepare('SELECT * FROM telegram_obligation_bindings').get();
    expect(binding).toMatchObject({
      cutover_id: CUTOVER,
      update_id: 900000001,
      message_id: 'telegram-in-900000001',
      route_key: 'main',
      profile: 'main',
      window_key: 'main',
      admission_id: 'adm-1',
      attempt_nonce: 'nonce-1',
      app_generation: 'tg-gen-1',
      pane_launch_id: 'launch-1',
      consumer_session_id: 'sess-1',
      runtime_submission_id: 'turn-1',
      runtime_submission_kind: 'codex_turn_id',
      queue_ack_intent: 'ack-intent-1',
      obligor_address: 'architect',
      work_generation: 1,
    });
    expect(binding.predecessor_manifest_sha256).toBe(sha256('predecessor-manifest'));
    expect(binding.raw_body_sha256).toBe(sha256('synthetic checkpoint A fixture'));
  });

  test('THE WORK GENERATION IS CREATED AT ADMISSION, not lazily by the next message', () => {
    // N+1 must not be the only recovery trigger. A message admitted and then
    // abandoned has an owner from the moment it is admitted.
    const db = freshDb();
    const { claim } = seedToDeliveryStarted(db);
    const owned = promoteToAdmittedOwned(db, ownedInput(claim.claimId));

    const binding = db.prepare('SELECT work_generation, work_lease_token, state FROM telegram_obligation_bindings').get();
    expect(binding.work_generation).toBe(1);
    expect(binding.work_lease_token).toBe(owned.workLeaseToken);
    expect(binding.state).toBe('open');
  });

  test('A MISSING SOURCE OR CLAIM fails closed', () => {
    const db = freshDb();
    expect(promoteToAdmittedOwned(db, ownedInput('tgc_nonexistent')).ok).toBe(false);
  });

  test('A CLAIM WHOSE cutover/route/update DISAGREES WITH ITS SOURCE is refused AT ACQUISITION', () => {
    // A1 accepted this and only caught it later, because a foreign key proves
    // the row EXISTS and says nothing about whether it CORRELATES. The claim
    // now joins the source's own recorded identity, so the mismatch never gets
    // a claim at all.
    const db = freshDb();
    const srcA = recordImmutableSource(db, sourceInput());
    const srcB = recordImmutableSource(db, sourceInput({
      messageId: 'telegram-in-900000002', updateId: 900000002,
    }));
    expect(srcB.ok).toBe(true);

    const claim = claimTransportAttempt(db, claimInput(srcA.sourceRowId, {
      updateId: 900000002, attemptNonce: 'nonce-b',
    }));

    expect(claim.ok).toBe(false);
    expect(claim.reason).toBe('claim_source_correlation_mismatch');
    expect(claim.detail.sourceUpdateId).toBe(900000001);
    expect(Number(db.prepare('SELECT COUNT(*) n FROM telegram_transport_claims').get().n)).toBe(0);
  });

  test('A CLAIM ON A DIFFERENT ROUTE THAN ITS SOURCE is refused', () => {
    const db = freshDb();
    const src = recordImmutableSource(db, sourceInput());
    const claim = claimTransportAttempt(db, claimInput(src.sourceRowId, { routeKey: 'sideprofile' }));
    expect(claim.ok).toBe(false);
    expect(claim.reason).toBe('claim_source_correlation_mismatch');
  });

  test('A CLAIM UNDER A DIFFERENT CUTOVER THAN ITS SOURCE is refused', () => {
    const db = freshDb();
    const src = recordImmutableSource(db, sourceInput());
    const claim = claimTransportAttempt(db, claimInput(src.sourceRowId, { cutoverId: 'cutover-other' }));
    expect(claim.ok).toBe(false);
    expect(claim.reason).toBe('claim_source_correlation_mismatch');
  });
});

describe('ordering across two records', () => {
  test('TWO RECORDS GET DISTINCT OBLIGATIONS AND DISTINCT CLAIMS', () => {
    const db = freshDb();
    const a = recordImmutableSource(db, sourceInput());
    const b = recordImmutableSource(db, sourceInput({
      messageId: 'telegram-in-900000002',
      updateId: 900000002,
      rawBody: 'Not the tankless job the other one',
      canonicalPayloadSha256: sha256('canonical-b'),
    }));

    expect(b.obligationId).not.toBe(a.obligationId);

    const claimA = claimTransportAttempt(db, claimInput(a.sourceRowId));
    const claimB = claimTransportAttempt(db, claimInput(b.sourceRowId, {
      updateId: 900000002, attemptNonce: 'nonce-b',
    }));
    expect(claimA.ok).toBe(true);
    expect(claimB.ok).toBe(true);
    expect(claimB.claimId).not.toBe(claimA.claimId);
  });
});

describe('the exclusivity constraint itself, not just the code path above it', () => {
  test('THE DATABASE REFUSES a second live claim even when the application check is bypassed', () => {
    // A3: claimTransportAttempt uses BEGIN IMMEDIATE, which serializes two
    // handles so the application-level SELECT catches the loser. That means a
    // passing race test does NOT prove the index exists. Insert straight into
    // the table to test the constraint on its own terms.
    const db = freshDb();
    const src = recordImmutableSource(db, sourceInput());
    claimTransportAttempt(db, claimInput(src.sourceRowId));

    const raw = () => db.prepare(`
      INSERT INTO telegram_transport_claims (
        claim_id, cutover_id, route_key, update_id, source_row_id,
        app_generation, pane_launch_id, pane_id, role, consumer_runtime,
        attempt_nonce, attempt_at_ms, state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'tgc_forced', CUTOVER, 'main', 900000001, src.sourceRowId,
      'tg-gen-2', 'launch-2', '3', 'builder', 'claude',
      'nonce-forced', NOW + 1, CLAIM_STATES.CLAIMED
    );

    expect(raw).toThrow(/UNIQUE|constraint/i);
    expect(Number(db.prepare('SELECT COUNT(*) n FROM telegram_transport_claims').get().n)).toBe(1);
  });

  test('A CLOSED-UNSENT CLAIM RELEASES THE SLOT WITHOUT LOSING ITS AUDIT TRAIL', () => {
    const db = freshDb();
    const src = recordImmutableSource(db, sourceInput());
    const first = claimTransportAttempt(db, claimInput(src.sourceRowId));
    closeUnsentClaim(db, { claimId: first.claimId, reason: 'pane_missing', atMs: NOW + 5 });
    claimTransportAttempt(db, claimInput(src.sourceRowId, { attemptNonce: 'nonce-2' }));

    // Both rows survive: the closed one is evidence a delivery was attempted
    // and rejected, which deleting it would destroy.
    expect(Number(db.prepare('SELECT COUNT(*) n FROM telegram_transport_claims').get().n)).toBe(2);
    expect(Number(db.prepare(
      "SELECT COUNT(*) n FROM telegram_transport_events WHERE kind='claim_closed_unsent'"
    ).get().n)).toBe(1);
  });
});

describe('the obligation id is the kernel\'s, with the fixed null lease', () => {
  test('IT EQUALS buildObligationId COMPUTED WITH NO LEASE — not merely stable', () => {
    // A12: stability across re-recording is satisfied by returning the stored
    // id, so it cannot detect a wrong derivation at first creation. Compare
    // against the kernel's own function rather than a hand-written expectation.
    const { buildObligationId } = require('../modules/main/obligation-kernel');
    const db = freshDb();

    const result = recordImmutableSource(db, sourceInput());

    expect(result.obligationId).toBe(buildObligationId({
      createdFromRowId: result.sourceRowId,
      creditorAddress: 'james',
      obligorAddress: 'architect',
      expectedClass: 'answer',
      stalenessClass: 'turn',
    }));
  });

  test('A LEASE-BEARING DERIVATION WOULD DIFFER, so the assertion above has teeth', () => {
    const { buildObligationId } = require('../modules/main/obligation-kernel');
    const base = {
      createdFromRowId: 1,
      creditorAddress: 'james',
      obligorAddress: 'architect',
      expectedClass: 'answer',
      stalenessClass: 'turn',
    };
    expect(buildObligationId({ ...base, leaseId: 'lease-1' })).not.toBe(buildObligationId(base));
  });
});

describe('the ownership transaction is ONE transaction', () => {
  test('EXACTLY ONE BEGIN AND ONE COMMIT — "all commit or none does" is structural', () => {
    // A failure-injection test cannot catch a transaction SPLIT on the happy
    // path: if every step succeeds, a split leaves identical end state. The
    // boundary itself has to be asserted, or "atomic" is only true until
    // someone adds a commit in the middle.
    const db = freshDb();
    const { claim } = seedToDeliveryStarted(db);

    const realExec = db.exec.bind(db);
    const statements = [];
    db.exec = (sql) => { statements.push(String(sql).trim().toUpperCase()); return realExec(sql); };

    const owned = promoteToAdmittedOwned(db, ownedInput(claim.claimId));
    db.exec = realExec;

    expect(owned.ok).toBe(true);
    expect(statements.filter((s) => s.startsWith('BEGIN'))).toHaveLength(1);
    expect(statements.filter((s) => s.startsWith('COMMIT'))).toHaveLength(1);
    expect(statements.filter((s) => s.startsWith('ROLLBACK'))).toHaveLength(0);
  });

  test('A FAILED PROMOTION ROLLS BACK ONCE and commits nothing', () => {
    const db = freshDb();
    const { claim } = seedToDeliveryStarted(db);

    const realExec = db.exec.bind(db);
    const statements = [];
    db.exec = (sql) => { statements.push(String(sql).trim().toUpperCase()); return realExec(sql); };

    const failed = promoteToAdmittedOwned(db, ownedInput(claim.claimId, {
      canonicalPayloadSha256: sha256('mismatch'),
    }));
    db.exec = realExec;

    expect(failed.ok).toBe(false);
    expect(statements.filter((s) => s.startsWith('COMMIT'))).toHaveLength(0);
    expect(statements.filter((s) => s.startsWith('ROLLBACK'))).toHaveLength(1);
  });
});

describe('THE GENERAL KERNEL ACTUALLY HOLDS THE DEBT (blocker 1)', () => {
  // A1's whole failure: after admitted_owned, the real kernel had zero debt.
  // These query all four authorities, not the private bindings.
  test('AFTER PROMOTION all four authorities agree', () => {
    const db = freshDb();
    const { src, claim } = seedToDeliveryStarted(db);
    const owned = promoteToAdmittedOwned(db, ownedInput(claim.claimId));
    expect(owned.ok).toBe(true);

    // 1. REAL obligations row, keyed to the REAL comms row id.
    const obligation = db.prepare('SELECT * FROM obligations WHERE obligation_id = ?')
      .get(owned.obligationId);
    expect(obligation).toBeDefined();
    expect(obligation.created_from_row_id).toBe(src.sourceRowId);
    expect(obligation.creditor_address).toBe('james');
    expect(obligation.obligor_address).toBe('architect');
    expect(obligation.expected_class).toBe('answer');
    expect(obligation.staleness_class).toBe('turn');
    expect(obligation.status).toBe('open');
    expect(obligation.lease_id).toBeNull();

    // 2. REAL ledger created event, referenced by the obligation.
    const event = db.prepare('SELECT * FROM ledger_events WHERE event_id = ?')
      .get(obligation.created_event_id);
    expect(event).toBeDefined();
    expect(event.type).toBe('obligation.created');

    // 3. REAL comms row promoted.
    expect(db.prepare('SELECT status FROM comms_journal WHERE row_id = ?')
      .get(src.sourceRowId).status).toBe(SOURCE_STATES.BROKERED);

    // 4. Telegram binding + queue-ack outbox reference, never replace.
    const binding = db.prepare('SELECT * FROM telegram_obligation_bindings WHERE obligation_id = ?')
      .get(owned.obligationId);
    expect(binding.source_row_id).toBe(src.sourceRowId);
    expect(db.prepare('SELECT state FROM telegram_queue_ack_outbox WHERE obligation_id = ?')
      .get(owned.obligationId).state).toBe(QUEUE_ACK_STATES.PENDING);
  });

  test('THE OBLIGATION ID RESOLVES THE KERNEL FOREIGN KEY - it hashes comms_journal.row_id', () => {
    const { buildObligationId } = require('../modules/main/obligation-kernel');
    const db = freshDb();
    const src = recordImmutableSource(db, sourceInput());

    expect(src.obligationId).toBe(buildObligationId({
      createdFromRowId: src.sourceRowId,
      creditorAddress: 'james',
      obligorAddress: 'architect',
      expectedClass: 'answer',
      stalenessClass: 'turn',
    }));
  });

  test('A FAILED PROMOTION ROLLS BACK ALL FOUR AUTHORITIES', () => {
    const db = freshDb();
    const { src, claim } = seedToDeliveryStarted(db);

    const failed = promoteToAdmittedOwned(db, ownedInput(claim.claimId, {
      canonicalPayloadSha256: sha256('a digest that does not match'),
    }));
    expect(failed.ok).toBe(false);

    expect(Number(db.prepare('SELECT COUNT(*) n FROM obligations').get().n)).toBe(0);
    expect(Number(db.prepare("SELECT COUNT(*) n FROM ledger_events WHERE type='obligation.created'").get().n)).toBe(0);
    expect(db.prepare('SELECT status FROM comms_journal WHERE row_id = ?')
      .get(src.sourceRowId).status).toBe(SOURCE_STATES.RECORDED);
    expect(Number(db.prepare('SELECT COUNT(*) n FROM telegram_obligation_bindings').get().n)).toBe(0);
    expect(Number(db.prepare('SELECT COUNT(*) n FROM telegram_queue_ack_outbox').get().n)).toBe(0);
  });

  test('RECORDING A SOURCE CREATES NO KERNEL DEBT', () => {
    const db = freshDb();
    recordImmutableSource(db, sourceInput());
    expect(Number(db.prepare('SELECT COUNT(*) n FROM obligations').get().n)).toBe(0);
    // And no `expects` metadata that a kernel sweep could read as debt.
    const meta = db.prepare('SELECT metadata_json FROM comms_journal').get().metadata_json;
    expect(meta).not.toMatch(/"expects"/);
  });

  test('A CLAIM CREATES NO KERNEL DEBT', () => {
    const db = freshDb();
    seedToDeliveryStarted(db);
    expect(Number(db.prepare('SELECT COUNT(*) n FROM obligations').get().n)).toBe(0);
  });
});

describe('obligor identity is stored, not merely hashed (blocker 3)', () => {
  test('THE SAME MESSAGE WITH A CHANGED OBLIGOR is a hard conflict', () => {
    const db = freshDb();
    recordImmutableSource(db, sourceInput());
    const result = recordImmutableSource(db, sourceInput({ obligorAddress: 'builder' }));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('source_identity_conflict');
    expect(result.detail.column).toBe('obligorAddress');
  });

  test('PROMOTION CANNOT OFFER A DIFFERENT OBLIGOR than the one that hashed the id', () => {
    const db = freshDb();
    const { claim } = seedToDeliveryStarted(db);
    const owned = promoteToAdmittedOwned(db, ownedInput(claim.claimId, { obligorAddress: 'builder' }));
    expect(owned.ok).toBe(false);
    expect(owned.reason).toBe('obligor_mismatch');
    expect(Number(db.prepare('SELECT COUNT(*) n FROM obligations').get().n)).toBe(0);
  });
});

describe('delivery_started state table (blocker 5)', () => {
  test('AN ALREADY-ADMITTED CLAIM IS REFUSED, never told delivery started', () => {
    // A1 fell through to a fabricated success here, which would authorise a
    // SECOND pane write for a message already delivered.
    const db = freshDb();
    const { claim } = seedToDeliveryStarted(db);
    promoteToAdmittedOwned(db, ownedInput(claim.claimId));

    const again = recordDeliveryStarted(db, { claimId: claim.claimId, atMs: NOW + 5000 });

    expect(again.ok).toBe(false);
    expect(again.reason).toBe('claim_already_admitted');
    expect(Number(db.prepare(
      "SELECT COUNT(*) n FROM telegram_transport_events WHERE kind='delivery_started'"
    ).get().n)).toBe(1);
  });

  test('A CLOSED CLAIM IS REFUSED', () => {
    const db = freshDb();
    const src = recordImmutableSource(db, sourceInput());
    const claim = claimTransportAttempt(db, claimInput(src.sourceRowId));
    closeUnsentClaim(db, { claimId: claim.claimId, reason: 'pane_missing', atMs: NOW + 5 });

    const started = recordDeliveryStarted(db, { claimId: claim.claimId, atMs: NOW + 10 });
    expect(started.ok).toBe(false);
    expect(started.reason).toBe('claim_closed');
  });

  test('THE DATABASE ITSELF REFUSES AN ILLEGAL STATE', () => {
    // Legal states are now a CHECK constraint, not only an application
    // convention, so an illegal state cannot be written at all.
    const db = freshDb();
    const src = recordImmutableSource(db, sourceInput());
    const claim = claimTransportAttempt(db, claimInput(src.sourceRowId));

    expect(() => db.prepare('UPDATE telegram_transport_claims SET state = ? WHERE claim_id = ?')
      .run('some_future_state', claim.claimId)).toThrow(/CHECK constraint/i);

    // And the claim is untouched, so the state machine never saw a bad value.
    expect(db.prepare('SELECT state FROM telegram_transport_claims').get().state)
      .toBe(CLAIM_STATES.CLAIMED);
  });
});

describe('durability is asserted on the handle we were given', () => {
  test('A HANDLE WITHOUT synchronous=FULL IS REFUSED, not silently accepted', () => {
    const db = freshDb();
    db.exec('PRAGMA synchronous=NORMAL;');

    const result = recordImmutableSource(db, sourceInput());

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('durability_not_full');
    expect(Number(db.prepare('SELECT COUNT(*) n FROM comms_journal').get().n)).toBe(0);
  });

  test('EVERY MUTATING ENTRY POINT asserts durability', () => {
    const db = freshDb();
    const src = recordImmutableSource(db, sourceInput());
    const claim = claimTransportAttempt(db, claimInput(src.sourceRowId));
    db.exec('PRAGMA synchronous=NORMAL;');

    expect(claimTransportAttempt(db, claimInput(src.sourceRowId)).reason).toBe('durability_not_full');
    expect(recordDeliveryStarted(db, { claimId: claim.claimId, atMs: NOW }).reason).toBe('durability_not_full');
    expect(closeUnsentClaim(db, { claimId: claim.claimId, reason: 'x', atMs: NOW }).reason).toBe('durability_not_full');
    expect(promoteToAdmittedOwned(db, ownedInput(claim.claimId)).reason).toBe('durability_not_full');
  });
});

describe('canonical encoding is scannable and unambiguous (blocker 6)', () => {
  test('THE PRODUCTION SOURCE CONTAINS NO NUL BYTES', () => {
    // A1 joined hash inputs with a literal NUL, which made this file BINARY to
    // ripgrep - the source scans that find problems could not see it.
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'modules', 'main', 'telegram-admission-store.js')
    );
    expect(source.includes(0)).toBe(false);
  });

  test('LENGTH PREFIXING MAKES DELIMITERS UNFORGEABLE', () => {
    const { canonicalJoin } = require('../modules/main/telegram-admission-store');
    // Without length prefixes these two field lists would collide.
    expect(canonicalJoin(['a|b', 'c'])).not.toBe(canonicalJoin(['a', 'b|c']));
    expect(canonicalJoin(['', 'x'])).not.toBe(canonicalJoin(['x', '']));
  });
});

describe('digests are validated at the storage boundary (blocker 8)', () => {
  test.each([
    ['too short', 'abc'],
    ['non-hex', 'z'.repeat(64)],
    ['uppercase', 'A'.repeat(64)],
    ['empty', ''],
  ])('A MALFORMED canonical digest (%s) is refused', (_label, value) => {
    const db = freshDb();
    const result = recordImmutableSource(db, sourceInput({ canonicalPayloadSha256: value }));
    expect(result.ok).toBe(false);
  });

  test('A MALFORMED media digest is refused', () => {
    const db = freshDb();
    expect(recordImmutableSource(db, sourceInput({ mediaIdentitySha256: 'nope' })).ok).toBe(false);
  });

  test('A MALFORMED predecessor manifest digest is refused at promotion', () => {
    const db = freshDb();
    const { claim } = seedToDeliveryStarted(db);
    const owned = promoteToAdmittedOwned(db, ownedInput(claim.claimId, {
      predecessorManifestSha256: 'not-a-digest',
    }));
    expect(owned.ok).toBe(false);
    expect(owned.reason).toBe('owned_digest_malformed:predecessorManifestSha256');
  });
});

describe('promotion re-verifies correlation even for a forged claim row', () => {
  test('A CLAIM ROW POINTING AT A DIFFERENT SOURCE is refused at promotion', () => {
    // Unreachable through the public API now that acquisition correlates, so
    // this forges the row directly — the same technique used for the UNIQUE
    // index. Defence in depth is only depth if something proves it fires.
    const db = freshDb();
    const srcA = recordImmutableSource(db, sourceInput());
    const srcB = recordImmutableSource(db, sourceInput({
      messageId: 'telegram-in-900000002', updateId: 900000002,
    }));
    const claim = claimTransportAttempt(db, claimInput(srcB.sourceRowId, {
      updateId: 900000002, attemptNonce: 'nonce-b',
    }));
    recordDeliveryStarted(db, { claimId: claim.claimId, atMs: NOW + 10 });

    // Repoint the committed claim at the WRONG source row.
    db.prepare('UPDATE telegram_transport_claims SET source_row_id = ? WHERE claim_id = ?')
      .run(srcA.sourceRowId, claim.claimId);

    const owned = promoteToAdmittedOwned(db, ownedInput(claim.claimId, {
      messageId: 'telegram-in-900000002',
    }));

    expect(owned.ok).toBe(false);
    expect(owned.reason).toBe('claim_source_mismatch');
    expect(Number(db.prepare('SELECT COUNT(*) n FROM obligations').get().n)).toBe(0);
  });
});

describe('installed schema is VERIFIED, not assumed (Oracle #29)', () => {
  test('A STALE TABLE IS DETECTED — CREATE IF NOT EXISTS silently does nothing', () => {
    // This is the day's pattern in schema form: the statement does not compare,
    // it just returns, so an older table passes as a fresh one and every test
    // above it runs green against the wrong structure.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-stale-schema-'));
    tempRoots.push(root);
    const db = openRealLedger(path.join(root, 'ledger.db'));

    // A pre-existing table of the RIGHT NAME and the WRONG SHAPE.
    db.exec(`CREATE TABLE telegram_transport_claims (
      claim_id TEXT PRIMARY KEY,
      state TEXT
    );`);

    const applied = applyTelegramAdmissionSchema(db);

    expect(applied.ok).toBe(false);
    // Either diagnosis is correct and both are structural rather than a throw:
    // a stale table may fail at DDL time (dependent columns absent) or survive
    // creation and be caught by the installed-shape check.
    expect(['schema_apply_failed', 'schema_shape_mismatch']).toContain(applied.reason);
  });

  test('A MISSING OBJECT IS DETECTED', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-missing-schema-'));
    tempRoots.push(root);
    const db = openRealLedger(path.join(root, 'ledger.db'));
    applyTelegramAdmissionSchema(db);
    db.exec('DROP TABLE telegram_queue_ack_outbox;');

    const verified = verifyInstalledSchema(db);
    expect(verified.ok).toBe(false);
    expect(verified.detail.missing.join()).toMatch(/telegram_queue_ack_outbox:absent/);
  });

  test('A CORRECTLY INSTALLED SCHEMA VERIFIES — the check is not always-fail', () => {
    const db = freshDb();
    expect(verifyInstalledSchema(db).ok).toBe(true);
  });
});

describe('claim identity binds source and time (Oracle #29 item 4)', () => {
  test('THE SAME NONCE WITH A DIFFERENT SOURCE ROW IS NOT THE SAME CLAIM', () => {
    // claim_id previously omitted source_row_id, so a reused key pointing at a
    // different source hashed identically and was called idempotent.
    const db = freshDb();
    const a = recordImmutableSource(db, sourceInput());
    const b = recordImmutableSource(db, sourceInput({
      messageId: 'telegram-in-900000002', updateId: 900000002,
    }));

    const claimA = claimTransportAttempt(db, claimInput(a.sourceRowId));
    const claimB = claimTransportAttempt(db, claimInput(b.sourceRowId, {
      updateId: 900000002,
    }));

    expect(claimA.ok).toBe(true);
    expect(claimB.ok).toBe(true);
    expect(claimB.claimId).not.toBe(claimA.claimId);
  });

  test('THE SAME NONCE AT A DIFFERENT ATTEMPT TIME IS NOT THE SAME CLAIM', () => {
    const db = freshDb();
    const src = recordImmutableSource(db, sourceInput());
    const first = claimTransportAttempt(db, claimInput(src.sourceRowId));

    const later = claimTransportAttempt(db, claimInput(src.sourceRowId, {
      attemptAtMs: NOW + 60_000,
    }));

    expect(later.ok).toBe(false);
    expect(later.reason).toBe('claim_held_by_other');
    expect(later.detail.heldClaimId).toBe(first.claimId);
  });

  test('THE EXACT SAME CLAIMANT, source and time IS still idempotent', () => {
    const db = freshDb();
    const src = recordImmutableSource(db, sourceInput());
    const first = claimTransportAttempt(db, claimInput(src.sourceRowId));
    const retry = claimTransportAttempt(db, claimInput(src.sourceRowId));
    expect(retry.ok).toBe(true);
    expect(retry.created).toBe(false);
    expect(retry.claimId).toBe(first.claimId);
  });
});

describe('constraint failures are classified specifically (Oracle #29)', () => {
  test('A FOREIGN KEY VIOLATION is not reported as a lost race', () => {
    // A1 mapped every constraint error onto claim_held_by_other, so a broken
    // reference told the caller to wait for a claim that does not exist.
    const db = freshDb();
    const result = claimTransportAttempt(db, {
      ...claimInput(999999), // no such comms row
    });
    // Correlation rejects before the FK can fire, which is the stronger answer.
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('source_row_missing');
  });

  test('THE CLAIM CATCH DISTINGUISHES foreign key from unique', () => {
    const { canonicalJoin: cj } = require('../modules/main/telegram-admission-store');
    // Exercised structurally: the classifier must have distinct branches.
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'modules', 'main', 'telegram-admission-store.js'), 'utf8'
    );
    expect(src).toMatch(/claim_foreign_key_violation/);
    expect(src).toMatch(/claim_check_constraint_violation/);
    expect(src).toMatch(/UNIQUE constraint/);
    expect(typeof cj).toBe('function');
  });
});

describe('causal ordering (Oracle #29)', () => {
  test('AN ATTEMPT THAT PREDATES ITS SOURCE is refused at promotion', () => {
    const db = freshDb();
    const src = recordImmutableSource(db, sourceInput());
    const claim = claimTransportAttempt(db, claimInput(src.sourceRowId, {
      attemptAtMs: NOW - 60_000, // before the message existed
    }));
    recordDeliveryStarted(db, { claimId: claim.claimId, atMs: NOW - 50_000 });

    const owned = promoteToAdmittedOwned(db, ownedInput(claim.claimId));

    expect(owned.ok).toBe(false);
    expect(owned.reason).toBe('causal_order_violation:attempt_before_source');
    expect(Number(db.prepare('SELECT COUNT(*) n FROM obligations').get().n)).toBe(0);
  });

  test('AN ADMISSION THAT PREDATES ITS DELIVERY is refused', () => {
    const db = freshDb();
    const { claim } = seedToDeliveryStarted(db);
    const owned = promoteToAdmittedOwned(db, ownedInput(claim.claimId, { atMs: NOW + 1 }));

    expect(owned.ok).toBe(false);
    expect(owned.reason).toBe('causal_order_violation:admission_before_delivery');
  });

  test('A CAUSALLY ORDERED PROMOTION still succeeds — the check is not always-fail', () => {
    const db = freshDb();
    const { claim } = seedToDeliveryStarted(db);
    expect(promoteToAdmittedOwned(db, ownedInput(claim.claimId)).ok).toBe(true);
  });
});

describe('binding carries claim and admission provenance (Oracle #29)', () => {
  test('THE BINDING NAMES THE CLAIM IT CAME FROM', () => {
    const db = freshDb();
    const { claim } = seedToDeliveryStarted(db);
    const owned = promoteToAdmittedOwned(db, ownedInput(claim.claimId));

    const binding = db.prepare('SELECT claim_id FROM telegram_obligation_bindings WHERE obligation_id = ?')
      .get(owned.obligationId);
    expect(binding.claim_id).toBe(claim.claimId);
  });

  test('ONE ADMISSION ID CANNOT OWN TWO BINDINGS', () => {
    const db = freshDb();
    const { claim } = seedToDeliveryStarted(db);
    promoteToAdmittedOwned(db, ownedInput(claim.claimId));

    // A second source, promoted with the SAME admission id, must be refused by
    // the UNIQUE constraint rather than quietly creating a second debt.
    const b = recordImmutableSource(db, sourceInput({
      messageId: 'telegram-in-900000002', updateId: 900000002,
    }));
    const claimB = claimTransportAttempt(db, claimInput(b.sourceRowId, {
      updateId: 900000002, attemptNonce: 'nonce-b',
    }));
    recordDeliveryStarted(db, { claimId: claimB.claimId, atMs: NOW + 10 });

    const owned = promoteToAdmittedOwned(db, ownedInput(claimB.claimId, {
      messageId: 'telegram-in-900000002',
      admissionId: 'adm-1', // reused
    }));

    expect(owned.ok).toBe(false);
    expect(Number(db.prepare('SELECT COUNT(*) n FROM obligations').get().n)).toBe(1);
  });
});

describe('the surviving-mutant closures', () => {
  test('A DDL-COMPATIBLE BUT STALE INDEX is caught by apply, not only by DDL failure', () => {
    // A25: the stale test passed via schema_apply_failed, so nothing exercised
    // verifyInstalledSchema THROUGH apply. This stale shape survives DDL.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-stale-idx-'));
    tempRoots.push(root);
    const db = openRealLedger(path.join(root, 'ledger.db'));
    expect(applyTelegramAdmissionSchema(db).ok).toBe(true);

    // Replace the partial UNIQUE index with a plain one of the same name.
    db.exec('DROP INDEX idx_tg_claims_exclusive;');
    db.exec('CREATE INDEX idx_tg_claims_exclusive ON telegram_transport_claims (cutover_id);');

    // CREATE UNIQUE INDEX IF NOT EXISTS now silently does nothing.
    const reapplied = applyTelegramAdmissionSchema(db);

    expect(reapplied.ok).toBe(false);
    expect(reapplied.reason).toBe('schema_shape_mismatch');
    expect(reapplied.detail.missing.join()).toMatch(/idx_tg_claims_exclusive:stale/);
  });

  test('THE CLAIM ID ITSELF CHANGES with the source row', () => {
    // A26: behavioural tests could not see this because the refusal came from
    // a different check. Assert the derivation directly, as with the
    // obligation id.
    const dbA = freshDb();
    const dbB = freshDb();
    const srcA = recordImmutableSource(dbA, sourceInput());
    // A second source in the other DB, forced to a different row id.
    dbB.prepare(`INSERT INTO comms_journal (message_id, channel, direction, status, updated_at_ms)
                 VALUES ('filler', 'telegram', 'inbound', 'recorded', 1)`).run();
    const srcB = recordImmutableSource(dbB, sourceInput());
    expect(srcB.sourceRowId).not.toBe(srcA.sourceRowId);

    const a = claimTransportAttempt(dbA, claimInput(srcA.sourceRowId));
    const b = claimTransportAttempt(dbB, claimInput(srcB.sourceRowId));

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(b.claimId).not.toBe(a.claimId);
  });

  test('THE CLAIM ID ITSELF CHANGES with the attempt time', () => {
    const dbA = freshDb();
    const dbB = freshDb();
    const srcA = recordImmutableSource(dbA, sourceInput());
    const srcB = recordImmutableSource(dbB, sourceInput());
    expect(srcA.sourceRowId).toBe(srcB.sourceRowId); // same row id, so time is the only variable

    const a = claimTransportAttempt(dbA, claimInput(srcA.sourceRowId, { attemptAtMs: NOW }));
    const b = claimTransportAttempt(dbB, claimInput(srcB.sourceRowId, { attemptAtMs: NOW + 1 }));

    expect(a.claimId).not.toBe(b.claimId);
  });

  test('A CLAIMANT WITH THE SAME KEY BUT A DIFFERENT SOURCE ROW is not idempotent', () => {
    // A27: sameClaimant must compare the source row. Two comms rows can share
    // an updateId under different message ids, which is exactly the shape that
    // would otherwise be waved through as "the same attempt".
    const db = freshDb();
    const a = recordImmutableSource(db, sourceInput());
    const b = recordImmutableSource(db, sourceInput({
      messageId: 'telegram-in-900000001-dup',
    }));
    expect(b.ok).toBe(true);
    expect(b.sourceRowId).not.toBe(a.sourceRowId);

    claimTransportAttempt(db, claimInput(a.sourceRowId));
    const other = claimTransportAttempt(db, claimInput(b.sourceRowId));

    expect(other.ok).toBe(false);
    expect(other.reason).toBe('claim_held_by_other');
  });
});
