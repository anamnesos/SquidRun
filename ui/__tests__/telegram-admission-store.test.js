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
  sha256,
  applyTelegramAdmissionSchema,
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
function freshDb() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-admission-store-'));
  tempRoots.push(root);
  const db = createDatabase(path.join(root, 'ledger.db'));
  openDbs.push(db);
  applyTelegramAdmissionSchema(db);
  return db;
}
afterEach(() => {
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

  test('NO ROW IS EVER OBSERVABLE WITHOUT ITS OBLIGATION ID', () => {
    const db = freshDb();
    recordImmutableSource(db, sourceInput());
    const row = db.prepare('SELECT obligation_id, status FROM telegram_source_rows').get();
    expect(row.obligation_id).toMatch(/^obl_/);
    expect(row.status).toBe(SOURCE_STATES.RECORDED);
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
    const row = db.prepare('SELECT * FROM telegram_source_rows').get();
    expect(row.raw_body).toBe('synthetic checkpoint A fixture');
    expect(Number(db.prepare('SELECT COUNT(*) n FROM telegram_source_rows').get().n)).toBe(1);
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

  test('TWO COORDINATORS ON TWO DATABASE HANDLES: exactly one may write to a pane', () => {
    // The whole reason exclusivity is a UNIQUE constraint and not a JSONL
    // latch — a file cannot arbitrate between two handles.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-admission-race-'));
    tempRoots.push(root);
    const dbPath = path.join(root, 'ledger.db');
    const dbA = createDatabase(dbPath);
    const dbB = createDatabase(dbPath);
    openDbs.push(dbA, dbB);
    applyTelegramAdmissionSchema(dbA);

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

    expect(db.prepare('SELECT status FROM telegram_source_rows').get().status)
      .toBe(SOURCE_STATES.BROKERED);
    expect(Number(db.prepare('SELECT COUNT(*) n FROM telegram_obligation_bindings').get().n)).toBe(1);
    expect(Number(db.prepare("SELECT COUNT(*) n FROM telegram_binding_events WHERE transition='created'").get().n)).toBe(1);
    expect(Number(db.prepare('SELECT COUNT(*) n FROM telegram_outbound_intents').get().n)).toBe(1);
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
    expect(db.prepare('SELECT status FROM telegram_source_rows').get().status)
      .toBe(SOURCE_STATES.RECORDED);
    expect(Number(db.prepare('SELECT COUNT(*) n FROM telegram_obligation_bindings').get().n)).toBe(0);
    expect(Number(db.prepare('SELECT COUNT(*) n FROM telegram_outbound_intents').get().n)).toBe(0);
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

  test('A CLAIM BOUND TO A DIFFERENT SOURCE ROW is refused', () => {
    const db = freshDb();
    const srcA = recordImmutableSource(db, sourceInput());
    const srcB = recordImmutableSource(db, sourceInput({
      messageId: 'telegram-in-900000002', updateId: 900000002,
    }));
    // Claim keyed to update B but pointed at source row A.
    const claim = claimTransportAttempt(db, claimInput(srcA.sourceRowId, {
      updateId: 900000002, attemptNonce: 'nonce-b',
    }));
    recordDeliveryStarted(db, { claimId: claim.claimId, atMs: NOW + 10 });

    const owned = promoteToAdmittedOwned(db, ownedInput(claim.claimId, {
      messageId: 'telegram-in-900000002',
    }));

    expect(owned.ok).toBe(false);
    expect(owned.reason).toBe('claim_source_mismatch');
    expect(srcB.ok).toBe(true);
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
