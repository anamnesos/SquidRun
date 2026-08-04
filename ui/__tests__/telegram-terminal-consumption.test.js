/**
 * S492 — the TERMINAL half of the two-phase proof, against a real database.
 *
 * =====================================================================
 * WHAT THIS SUITE IS FOR
 * =====================================================================
 * `telegram_consumed.v1` existed for one checkpoint as a NAME: a constant in
 * `telegram-consumed-proof.js` declaring that some future record would carry
 * retirement authority. Nothing built one, nothing stored one, nothing read
 * one. Downstream, that reads exactly like a two-phase design — which is how
 * the live queue ended up with an admission path, no terminal path, and a head
 * of line that could not move.
 *
 * So every assertion here is a DATABASE EFFECT on a real temp ledger carrying
 * the real schema, and the negative cases are the point: an admission record
 * offered as terminal proof, a turn that ended before it was admitted, a
 * terminal write from a process that did not witness the turn, and the same
 * turn terminated twice. Each of those must be refused by something other than
 * the caller's good manners.
 *
 * The live evidence ledger is never opened. Temp roots only.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  sha256,
  applyTelegramAdmissionSchema,
  recordImmutableSource,
  claimTransportAttempt,
  recordDeliveryStarted,
} = require('../modules/main/telegram-admission-store');
const {
  SUBMISSION_KINDS,
  generateLaunchId,
  deriveConsumedId,
  recordPaneLaunch,
  completePaneLaunch,
  bindConsumerSession,
  recordAdmissionReceipt,
  recordConsumedReceipt,
  findConsumedReceipt,
} = require('../modules/main/telegram-launch-registry');
const { TelegramAdmissionWriter } = require('../modules/main/telegram-admission-writer');
const {
  TERMINAL_SCHEMA,
  buildAdmissionRecord,
  buildConsumedRecord,
  validateConsumedRecord,
} = require('../modules/main/telegram-consumed-proof');

const GENERATION = 'app-session-492';
const CUTOVER = 'cutover-s492';
const RUNTIME = 'codex';
const ROLE = 'architect';
const PANE_ID = '1';
const CHAT_ID = 6543210;
const BODY = 'Kristine muller approved job. change job to invoice';

const tempRoots = [];
const writers = [];

afterAll(() => {
  for (const writer of writers) {
    try { writer.close(); } catch { /* already closed */ }
  }
  for (const root of tempRoots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function freshWriter() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-terminal-'));
  fs.mkdirSync(path.join(root, '.squidrun', 'runtime'), { recursive: true });
  tempRoots.push(root);
  const writer = new TelegramAdmissionWriter({
    dbPath: path.join(root, '.squidrun', 'runtime', 'evidence-ledger.db'),
  });
  const opened = writer.open();
  if (!opened.ok) throw new Error(`writer open failed: ${JSON.stringify(opened)}`);
  writers.push(writer);
  const applied = applyTelegramAdmissionSchema(writer.db);
  if (!applied.ok) throw new Error(`schema failed: ${JSON.stringify(applied)}`);
  return writer;
}

/**
 * One complete admitted delivery: launch, bound session, immutable source,
 * transport claim, delivery-started bytes, and the stored admission receipt.
 *
 * This is deliberately the FULL chain rather than a hand-inserted admission
 * row. A terminal receipt whose admission was fabricated proves the terminal
 * writer works against fabrications.
 */
function seedAdmittedDelivery(db, {
  updateId,
  nowMs = 1_700_000_000_000,
  deliveredPrompt = `[Telegram from james]: ${BODY}`,
  consumerSessionId = 'cs-492-1',
  submissionId = 'turn-492-1',
  hookProcessId = '4242',
  hookParentProcessId = '4200',
  launchId = generateLaunchId(),
} = {}) {
  const messageId = `telegram-in-${updateId}`;

  const launch = recordPaneLaunch(db, {
    launchId,
    appGeneration: GENERATION,
    paneId: PANE_ID,
    role: ROLE,
    consumerRuntime: RUNTIME,
    daemonProcessId: '999',
    launchedAtMs: nowMs - 1000,
  });
  expect(launch.ok).toBe(true);
  expect(completePaneLaunch(db, { launchId, atMs: nowMs - 900 }).ok).toBe(true);
  expect(bindConsumerSession(db, {
    consumerSessionId,
    launchId,
    consumerRuntime: RUNTIME,
    boundAtMs: nowMs - 800,
  }).ok).toBe(true);

  const canonicalPayloadSha256 = sha256(`canonical-${updateId}`);
  const src = recordImmutableSource(db, {
    messageId,
    updateId,
    chatId: CHAT_ID,
    routeKey: 'main',
    profile: 'main',
    windowKey: 'main',
    rawBody: BODY,
    canonicalPayloadSha256,
    cutoverId: CUTOVER,
    obligorAddress: ROLE,
    recordedAtMs: nowMs,
  });
  expect(src.ok).toBe(true);

  const attemptNonce = `nonce-${updateId}`;
  const claim = claimTransportAttempt(db, {
    cutoverId: CUTOVER,
    routeKey: 'main',
    updateId,
    sourceRowId: src.sourceRowId,
    appGeneration: GENERATION,
    paneLaunchId: launchId,
    paneId: PANE_ID,
    role: ROLE,
    consumerRuntime: RUNTIME,
    attemptNonce,
    attemptAtMs: nowMs + 10,
  });
  expect(claim.ok).toBe(true);
  expect(recordDeliveryStarted(db, {
    claimId: claim.claimId,
    atMs: nowMs + 20,
    deliveredPromptSha256: sha256(deliveredPrompt),
    deliveredPromptBytes: Buffer.byteLength(deliveredPrompt, 'utf8'),
  }).ok).toBe(true);

  const record = buildAdmissionRecord({
    runtime: RUNTIME,
    updateId,
    messageId,
    routeKey: 'main',
    windowKey: 'main',
    profile: 'main',
    chatId: CHAT_ID,
    appGeneration: GENERATION,
    consumerSessionId,
    consumerTurnId: submissionId,
    paneId: PANE_ID,
    queuedPayloadSha256: canonicalPayloadSha256,
    deliveredPrompt,
    consumedAtMs: nowMs + 30,
    claimId: claim.claimId,
    attemptNonce,
    paneLaunchId: launchId,
    role: ROLE,
    hookProcessId,
    hookParentProcessId,
    runtimeSubmissionId: submissionId,
    runtimeSubmissionKind: SUBMISSION_KINDS.CODEX_TURN,
  });
  const stored = recordAdmissionReceipt(db, {
    record,
    sourceRowId: src.sourceRowId,
    claimId: claim.claimId,
    launchId,
    consumerSessionId,
    hookProcessId,
    hookParentProcessId,
    runtimeSubmissionId: submissionId,
    runtimeSubmissionKind: SUBMISSION_KINDS.CODEX_TURN,
  });
  expect(stored.ok).toBe(true);

  return {
    messageId,
    updateId,
    launchId,
    consumerSessionId,
    submissionId,
    hookProcessId,
    hookParentProcessId,
    claimId: claim.claimId,
    attemptNonce,
    canonicalPayloadSha256,
    deliveredPrompt,
    admissionId: stored.admissionId,
    admissionRecord: record,
    admittedAtMs: nowMs + 30,
    nowMs,
  };
}

function terminalFor(seed, overrides = {}) {
  const built = buildConsumedRecord({
    admissionRecord: seed.admissionRecord,
    admissionId: seed.admissionId,
    terminalEvent: 'turn_completed',
    terminalAtMs: seed.admittedAtMs + 5_000,
    ...overrides,
  });
  expect(built.ok).toBe(true);
  return built.record;
}

function countConsumed(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM telegram_consumed_receipts').get().n;
}

describe('telegram_consumed.v1 — the record that may retire a message', () => {
  test('a completed turn produces a stored terminal receipt the drain can find', () => {
    const writer = freshWriter();
    const seed = seedAdmittedDelivery(writer.db, { updateId: 808499401 });

    const result = recordConsumedReceipt(writer.db, {
      record: terminalFor(seed),
      terminalHookProcessId: '5151',
      terminalHookParentProcessId: seed.hookParentProcessId,
    });
    expect(result.ok).toBe(true);
    expect(countConsumed(writer.db)).toBe(1);

    const found = findConsumedReceipt(writer.db, {
      messageId: seed.messageId,
      routeKey: 'main',
    });
    expect(found.ok).toBe(true);
    // EVIDENCE-OWNED. Every field the drain will compare is inside the stored
    // record, not attached by the lookup.
    expect(found.record.schema).toBe(TERMINAL_SCHEMA);
    expect(found.record.messageId).toBe(seed.messageId);
    expect(found.record.chatId).toBe(CHAT_ID);
    expect(found.record.appGeneration).toBe(GENERATION);
    expect(found.record.claimId).toBe(seed.claimId);
    expect(found.record.attemptNonce).toBe(seed.attemptNonce);
    expect(found.record.admissionId).toBe(seed.admissionId);
    expect(found.record.terminalEvent).toBe('turn_completed');
    expect(found.row.terminal_hook_process_id).toBe('5151');
  });

  test('an admission alone leaves NO terminal receipt — the aborted-turn case', () => {
    const writer = freshWriter();
    const seed = seedAdmittedDelivery(writer.db, { updateId: 808499402 });

    // The turn admitted the bytes and then aborted: no Stop hook, no terminal
    // write. The database must be able to express that difference.
    expect(countConsumed(writer.db)).toBe(0);
    const found = findConsumedReceipt(writer.db, {
      messageId: seed.messageId,
      routeKey: 'main',
    });
    expect(found.ok).toBe(false);
    expect(found.reason).toBe('consumed_receipt_absent');
  });

  test('the admission record itself is refused as terminal proof', () => {
    const writer = freshWriter();
    const seed = seedAdmittedDelivery(writer.db, { updateId: 808499403 });

    const result = recordConsumedReceipt(writer.db, {
      record: seed.admissionRecord,
      terminalHookProcessId: '5151',
      terminalHookParentProcessId: seed.hookParentProcessId,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('consumed_wrong_schema');
    expect(countConsumed(writer.db)).toBe(0);
  });

  test('a terminal record whose identity drifts from its admission is refused', () => {
    const writer = freshWriter();
    const seed = seedAdmittedDelivery(writer.db, { updateId: 808499404 });

    // The one field a forger would most want to move: the bytes digest.
    const drifted = { ...terminalFor(seed), deliveredPromptSha256: sha256('something else') };
    const result = recordConsumedReceipt(writer.db, {
      record: drifted,
      terminalHookProcessId: '5151',
      terminalHookParentProcessId: seed.hookParentProcessId,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('consumed_admission_field_mismatch');
    expect(result.detail.field).toBe('deliveredPromptSha256');
    expect(countConsumed(writer.db)).toBe(0);
  });

  test('a terminal write from a different runtime process is refused', () => {
    const writer = freshWriter();
    const seed = seedAdmittedDelivery(writer.db, { updateId: 808499405 });

    const result = recordConsumedReceipt(writer.db, {
      record: terminalFor(seed),
      terminalHookProcessId: '5151',
      // A hook spawned by some OTHER runtime process cannot have watched this
      // turn end, however correct the record it carries.
      terminalHookParentProcessId: '9999',
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('consumed_hook_parent_mismatch');
    expect(countConsumed(writer.db)).toBe(0);
  });

  test('a turn that ends before it was admitted is refused at build AND at store', () => {
    const writer = freshWriter();
    const seed = seedAdmittedDelivery(writer.db, { updateId: 808499406 });

    const built = buildConsumedRecord({
      admissionRecord: seed.admissionRecord,
      admissionId: seed.admissionId,
      terminalEvent: 'turn_completed',
      terminalAtMs: seed.admittedAtMs - 1,
    });
    expect(built.ok).toBe(false);
    expect(built.reason).toBe('terminal_predates_admission');

    // And the store does not rely on the builder having been used: a
    // hand-assembled record with the same defect is refused on its own.
    const forged = { ...terminalFor(seed), terminalAtMs: seed.admittedAtMs - 1 };
    const result = recordConsumedReceipt(writer.db, {
      record: forged,
      terminalHookProcessId: '5151',
      terminalHookParentProcessId: seed.hookParentProcessId,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('consumed_predates_admission');
    expect(countConsumed(writer.db)).toBe(0);
  });

  test('DUPLICATE SUPPRESSION: a byte-identical re-fire replays, it does not double-write', () => {
    const writer = freshWriter();
    const seed = seedAdmittedDelivery(writer.db, { updateId: 808499407 });
    const record = terminalFor(seed);
    const args = {
      record,
      terminalHookProcessId: '5151',
      terminalHookParentProcessId: seed.hookParentProcessId,
    };

    const first = recordConsumedReceipt(writer.db, args);
    const second = recordConsumedReceipt(writer.db, args);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.replayed).toBe(true);
    expect(second.consumedId).toBe(first.consumedId);
    expect(countConsumed(writer.db)).toBe(1);
  });

  test('DUPLICATE SUPPRESSION: a conflicting second account quarantines instead of overwriting', () => {
    const writer = freshWriter();
    const seed = seedAdmittedDelivery(writer.db, { updateId: 808499408 });

    expect(recordConsumedReceipt(writer.db, {
      record: terminalFor(seed),
      terminalHookProcessId: '5151',
      terminalHookParentProcessId: seed.hookParentProcessId,
    }).ok).toBe(true);

    // Same admission, same submission, same event — a DIFFERENT account of when
    // the turn ended. The id collides, the bytes do not.
    const conflicting = terminalFor(seed, { terminalAtMs: seed.admittedAtMs + 60_000 });
    const result = recordConsumedReceipt(writer.db, {
      record: conflicting,
      terminalHookProcessId: '5252',
      terminalHookParentProcessId: seed.hookParentProcessId,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('consumed_conflicting_duplicate_quarantine');
    // The FIRST account survives, unmodified.
    expect(countConsumed(writer.db)).toBe(1);
    const found = findConsumedReceipt(writer.db, { messageId: seed.messageId, routeKey: 'main' });
    expect(found.record.terminalAtMs).toBe(seed.admittedAtMs + 5_000);
  });

  test('an admission already terminated under another id is refused by QUERY, not by error text', () => {
    const writer = freshWriter();
    const seed = seedAdmittedDelivery(writer.db, { updateId: 808499412 });
    const record = terminalFor(seed);

    // Hand-insert a terminal row for this admission under a DIFFERENT
    // consumed_id — the shape a raced or repaired database can really hold.
    // The UNIQUE index is the backstop; this asserts the code refuses before
    // reaching it, so the verdict never depends on which SQLite driver is
    // loaded or how it words a constraint violation.
    writer.db.prepare(`
      INSERT INTO telegram_consumed_receipts (
        consumed_id, schema_name, admission_id, source_row_id, claim_id, launch_id,
        consumer_session_id, pane_id, role, consumer_runtime, app_generation,
        terminal_hook_process_id, terminal_hook_parent_process_id,
        runtime_submission_id, runtime_submission_kind, terminal_event,
        update_id, message_id, route_key, window_key, profile, chat_id,
        queued_payload_sha256, delivered_prompt_sha256, delivered_prompt_bytes,
        admitted_at_ms, terminal_at_ms, record_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'con_handplanted', TERMINAL_SCHEMA, seed.admissionId, 1, seed.claimId,
      seed.launchId, seed.consumerSessionId, PANE_ID, ROLE, RUNTIME, GENERATION,
      '1', '1', seed.submissionId, SUBMISSION_KINDS.CODEX_TURN, 'turn_completed',
      seed.updateId, seed.messageId, 'main', 'main', 'main', String(CHAT_ID),
      seed.canonicalPayloadSha256, sha256(seed.deliveredPrompt),
      Buffer.byteLength(seed.deliveredPrompt, 'utf8'),
      seed.admittedAtMs, seed.admittedAtMs + 1, '{}'
    );

    const result = recordConsumedReceipt(writer.db, {
      record,
      terminalHookProcessId: '5151',
      terminalHookParentProcessId: seed.hookParentProcessId,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('consumed_admission_already_terminated');
    expect(result.detail.storedConsumedId).toBe('con_handplanted');
    expect(countConsumed(writer.db)).toBe(1);
  });

  test('the terminal receipt cannot be edited or deleted, even by raw SQL', () => {
    const writer = freshWriter();
    const seed = seedAdmittedDelivery(writer.db, { updateId: 808499409 });
    expect(recordConsumedReceipt(writer.db, {
      record: terminalFor(seed),
      terminalHookProcessId: '5151',
      terminalHookParentProcessId: seed.hookParentProcessId,
    }).ok).toBe(true);

    expect(() => writer.db
      .prepare('UPDATE telegram_consumed_receipts SET record_json = ? WHERE admission_id = ?')
      .run('{}', seed.admissionId)).toThrow(/telegram_consumed_receipt_immutable/);
    expect(() => writer.db
      .prepare('DELETE FROM telegram_consumed_receipts WHERE admission_id = ?')
      .run(seed.admissionId)).toThrow(/telegram_consumed_receipt_delete_forbidden/);
    expect(countConsumed(writer.db)).toBe(1);
  });

  test('two turns that each admitted the same bytes read as AMBIGUOUS, never as proof', () => {
    const writer = freshWriter();
    const seed = seedAdmittedDelivery(writer.db, { updateId: 808499410 });
    expect(recordConsumedReceipt(writer.db, {
      record: terminalFor(seed),
      terminalHookProcessId: '5151',
      terminalHookParentProcessId: seed.hookParentProcessId,
    }).ok).toBe(true);

    // A SECOND TURN over the SAME claim. This is reachable in production: the
    // pane's prompt, marker included, can be resubmitted, and the admission
    // hook fires again under a new turn id. `idx_tg_claims_exclusive` stops a
    // second transport CLAIM, but nothing stops a second consumer TURN, so two
    // terminal records for one message is a state this store can really hold.
    const secondSubmission = 'turn-492-resubmit';
    const secondAdmission = buildAdmissionRecord({
      ...seed.admissionRecord,
      runtime: RUNTIME,
      deliveredPrompt: seed.deliveredPrompt,
      consumedAtMs: seed.admittedAtMs + 60_000,
      consumerTurnId: secondSubmission,
      runtimeSubmissionId: secondSubmission,
    });
    const storedSecond = recordAdmissionReceipt(writer.db, {
      record: secondAdmission,
      sourceRowId: writer.db
        .prepare('SELECT source_row_id FROM telegram_source_identity WHERE message_id = ?')
        .get(seed.messageId).source_row_id,
      claimId: seed.claimId,
      launchId: seed.launchId,
      consumerSessionId: seed.consumerSessionId,
      hookProcessId: seed.hookProcessId,
      hookParentProcessId: seed.hookParentProcessId,
      runtimeSubmissionId: secondSubmission,
      runtimeSubmissionKind: SUBMISSION_KINDS.CODEX_TURN,
    });
    expect(storedSecond.ok).toBe(true);
    expect(storedSecond.admissionId).not.toBe(seed.admissionId);

    const secondTerminal = buildConsumedRecord({
      admissionRecord: secondAdmission,
      admissionId: storedSecond.admissionId,
      terminalEvent: 'turn_completed',
      terminalAtMs: seed.admittedAtMs + 65_000,
    });
    expect(secondTerminal.ok).toBe(true);
    expect(recordConsumedReceipt(writer.db, {
      record: secondTerminal.record,
      terminalHookProcessId: '6363',
      terminalHookParentProcessId: seed.hookParentProcessId,
    }).ok).toBe(true);
    expect(countConsumed(writer.db)).toBe(2);

    // Two accounts, no rule for choosing. Refusal, not a first-row win.
    const found = findConsumedReceipt(writer.db, {
      messageId: seed.messageId,
      routeKey: 'main',
    });
    expect(found.ok).toBe(false);
    expect(found.reason).toBe('consumed_receipt_ambiguous');
    expect(found.detail.count).toBe(2);
  });

  test('a stored terminal receipt satisfies the terminal validator end to end', () => {
    const writer = freshWriter();
    const seed = seedAdmittedDelivery(writer.db, { updateId: 808499411 });
    expect(recordConsumedReceipt(writer.db, {
      record: terminalFor(seed),
      terminalHookProcessId: '5151',
      terminalHookParentProcessId: seed.hookParentProcessId,
    }).ok).toBe(true);

    const found = findConsumedReceipt(writer.db, { messageId: seed.messageId, routeKey: 'main' });
    const expected = {
      updateId: seed.updateId,
      messageId: seed.messageId,
      routeKey: 'main',
      windowKey: 'main',
      profile: 'main',
      chatId: CHAT_ID,
      appGeneration: GENERATION,
      runtime: RUNTIME,
      consumerSessionId: seed.consumerSessionId,
      paneId: PANE_ID,
      claimId: seed.claimId,
      attemptNonce: seed.attemptNonce,
      paneLaunchId: seed.launchId,
      role: ROLE,
      hookProcessId: seed.hookProcessId,
      hookParentProcessId: seed.hookParentProcessId,
      runtimeSubmissionId: seed.submissionId,
      runtimeSubmissionKind: SUBMISSION_KINDS.CODEX_TURN,
      queuedPayloadSha256: seed.canonicalPayloadSha256,
      deliveredPromptSha256: sha256(seed.deliveredPrompt),
      deliveredPromptBytes: Buffer.byteLength(seed.deliveredPrompt, 'utf8'),
      admissionId: seed.admissionId,
    };
    const attempt = { atMs: seed.nowMs + 10, generation: GENERATION };
    expect(validateConsumedRecord({ proof: found.record, expected, attempt }))
      .toEqual({ proven: true, reason: 'terminal_consumption_proven' });
  });

  test('the id is derived from the admission, so it cannot be re-keyed to dodge a collision', () => {
    const seed = { admissionId: 'adm_abc', runtimeSubmissionId: 'turn-1', terminalEvent: 'turn_completed' };
    expect(deriveConsumedId(seed)).toBe(deriveConsumedId({ ...seed }));
    expect(deriveConsumedId(seed)).not.toBe(deriveConsumedId({ ...seed, admissionId: 'adm_abd' }));
  });
});

describe('installed schema', () => {
  test('a ledger carrying the admission tables but no terminal table reads as STALE', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-terminal-stale-'));
    tempRoots.push(root);
    fs.mkdirSync(path.join(root, '.squidrun', 'runtime'), { recursive: true });
    const writer = new TelegramAdmissionWriter({
      dbPath: path.join(root, '.squidrun', 'runtime', 'evidence-ledger.db'),
    });
    expect(writer.open().ok).toBe(true);
    writers.push(writer);

    // A build that predates the terminal half. Deliberately shaped so the DDL
    // does NOT throw — it carries the columns the index needs — because the
    // dangerous stale table is the one that installs cleanly and is missing
    // only the constraints. Here: no UNIQUE on admission_id (so one turn could
    // be terminated twice), no schema CHECK, no terminal_event CHECK. Every
    // test above would run green against it.
    writer.db.exec(`
      CREATE TABLE telegram_consumed_receipts (
        consumed_id   TEXT PRIMARY KEY,
        schema_name   TEXT NOT NULL,
        admission_id  TEXT NOT NULL,
        route_key     TEXT NOT NULL,
        message_id    TEXT NOT NULL,
        record_json   TEXT NOT NULL
      );
    `);

    const applied = applyTelegramAdmissionSchema(writer.db);
    expect(applied.ok).toBe(false);
    expect(applied.reason).toBe('schema_shape_mismatch');
    expect(applied.detail.missing).toEqual(
      expect.arrayContaining(['telegram_consumed_receipts:stale'])
    );
  });
});
