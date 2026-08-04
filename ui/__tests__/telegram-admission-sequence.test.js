/**
 * B4b — THE PRODUCTION ADMISSION SEQUENCE.
 *
 * What these tests are actually defending, in one sentence each:
 *
 *  - ONE OWNER. The generic comms upsert may never create, repair or rewrite a
 *    `telegram-in-N` row, in either order, from any caller.
 *  - THE ORDER IS AWAITED. Fail any step and NOTHING after it may have run, and
 *    above all no pane bytes may exist.
 *  - THE DIGEST IS THE DELIVERED BYTES. Not an earlier string that later helpers
 *    decorate — the exact final text including the consume marker.
 *  - THE PROJECTION IS NARROW. `recorded -> brokered` moves three columns and
 *    touches nothing else, ever.
 *
 * TEMP DATABASES ONLY. The live evidence ledger is never opened here.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  CLAIM_STATES,
  TELEGRAM_CUTOVER_ID,
  sha256,
  applyTelegramAdmissionSchema,
} = require('../modules/main/telegram-admission-store');
const {
  generateLaunchId,
  recordPaneLaunch,
  completePaneLaunch,
  bindConsumerSession,
  findActivePaneLaunch,
} = require('../modules/main/telegram-launch-registry');
const { TelegramAdmissionWriter } = require('../modules/main/telegram-admission-writer');
const { parseConsumeMarker, MARKER_PREFIX } = require('../modules/main/telegram-consume-marker');
const { canonicalQueuedPayloadDigest } = require('../modules/main/telegram-consumed-proof');
const {
  MODES,
  runTelegramAdmissionSequence,
  evaluatePaneReadinessAnswer,
} = require('../modules/main/telegram-admission-sequence');
const { PROOF_CAPABILITY_WINDOW_MS } = require('../modules/main/telegram-consumption-proof');

const NOW = 1785860000000;
const UPDATE_ID = 900000501;
const MESSAGE_ID = `telegram-in-${UPDATE_ID}`;
const APP_GENERATION = 'app-session-492-seq';

/**
 * A pane with observed proof flow. The B_readiness gate refuses anything less,
 * so FULL-mode tests must say it explicitly; SOURCE_ONLY never reaches the gate
 * because it returns at A.
 */
const READY = Object.freeze({
  attainable: true, reason: 'runtime_proof_observed', runtime: 'codex', lastProofAtMs: NOW - 1000,
});

const tempRoots = [];
const openWriters = [];

function freshDb() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-admission-seq-'));
  tempRoots.push(root);
  const writer = new TelegramAdmissionWriter({ dbPath: path.join(root, 'ledger.db') });
  const opened = writer.open();
  if (!opened.ok) throw new Error(`writer open failed: ${JSON.stringify(opened)}`);
  openWriters.push(writer);
  const db = writer.db;
  applyTelegramAdmissionSchema(db);
  seedLaunch(db);
  return db;
}

/** A REAL launch, bound and completed, exactly as SessionStart would leave it. */
function seedLaunch(db, { complete = true, appGeneration = APP_GENERATION } = {}) {
  const launchId = generateLaunchId();
  recordPaneLaunch(db, {
    launchId,
    appGeneration,
    paneId: '1',
    role: 'architect',
    consumerRuntime: 'codex',
    daemonProcessId: '4242',
    launchedAtMs: NOW - 5000,
  });
  if (complete) {
    bindConsumerSession(db, {
      consumerSessionId: `sess-${launchId}`,
      launchId,
      consumerRuntime: 'codex',
      boundAtMs: NOW - 4000,
    });
    completePaneLaunch(db, { launchId, atMs: NOW - 3500 });
  }
  return launchId;
}

const QUEUE_RECORD = Object.freeze({
  updateId: UPDATE_ID,
  text: 'Hello? are you there',
  chatId: REDACTED,
  from: 'James',
  messageId: 22999,
  routeKey: 'main',
  targetProfile: 'main',
  targetWindow: 'main',
});

const JOB = Object.freeze({
  messageId: MESSAGE_ID,
  updateId: UPDATE_ID,
  chatId: REDACTED,
  routeKey: 'main',
  profile: 'main',
  windowKey: 'main',
  rawBody: 'Hello? are you there',
  sessionId: 'app-session-492',
  sentAtMs: NOW - 1000,
});

/**
 * The composer stands in for the app's real one: it decorates, exactly as
 * recall and the reply-target guard do, so the tests can prove the digest
 * covers the decoration rather than the string handed in.
 */
function decoratingComposer(calls) {
  return async () => {
    calls.push('compose');
    return '[SQUIDRUN REPLY TARGET: TELEGRAM REQUIRED]\n\n[Telegram from James]: Hello? are you there';
  };
}

function runSequence(db, overrides = {}) {
  const calls = overrides.calls || [];
  return runTelegramAdmissionSequence({
    db,
    job: JOB,
    record: QUEUE_RECORD,
    appGeneration: APP_GENERATION,
    paneId: '1',
    role: 'architect',
    mode: MODES.FULL,
    composeFinalBody: overrides.composeFinalBody || decoratingComposer(calls),
    paneReadiness: overrides.paneReadiness || (() => READY),
    now: () => NOW,
    nonce: () => 'nonce-fixed-1',
    ...overrides.extra,
  });
}

afterAll(() => {
  for (const writer of openWriters) {
    try { writer.close(); } catch { /* best effort */ }
  }
  for (const root of tempRoots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe('B4b admission sequence — the happy path is exact', () => {
  test('A-B-C-D run in order and authorise the EXACT final bytes', async () => {
    const db = freshDb();
    const result = await runSequence(db);

    expect(result.ok).toBe(true);
    expect(result.stage).toBe('D_delivery_started');

    // The digest is of the bytes INCLUDING the marker, not of what compose
    // returned. This is the whole point of composing inside the sequence.
    expect(result.authorized.sha256).toBe(sha256(result.authorized.text));
    expect(result.authorized.bytes).toBe(Buffer.byteLength(result.authorized.text, 'utf8'));
    expect(result.authorized.text).toContain(MARKER_PREFIX);
    expect(result.authorized.text.split('\n').pop()).toMatch(/^\[SQUIDRUN_TG_CONSUME /);

    // And what the store recorded is that same digest — a delivery that
    // recorded a different hash than it authorised could never be contradicted.
    const claim = db.prepare('SELECT * FROM telegram_transport_claims WHERE claim_id = ?')
      .get(result.claimId);
    expect(claim.state).toBe(CLAIM_STATES.DELIVERY_STARTED);
    expect(claim.delivered_prompt_sha256).toBe(result.authorized.sha256);
    expect(Number(claim.delivered_prompt_bytes)).toBe(result.authorized.bytes);
    expect(claim.cutover_id).toBe(TELEGRAM_CUTOVER_ID);
  });

  test('the marker carries the claim and nonce the consumer must echo', async () => {
    const db = freshDb();
    const result = await runSequence(db);
    const marker = parseConsumeMarker(result.authorized.text);

    expect(marker).not.toBeNull();
    expect(marker.claimId).toBe(result.claimId);
    expect(marker.attemptNonce).toBe('nonce-fixed-1');
    expect(marker.updateId).toBe(String(UPDATE_ID));
    expect(marker.messageId).toBe(MESSAGE_ID);
    expect(marker.appGeneration).toBe(APP_GENERATION);
    expect(marker.queuedPayloadSha256).toBe(canonicalQueuedPayloadDigest(QUEUE_RECORD));
  });

  test('the comms projection moves recorded -> brokered and NOTHING else', async () => {
    const db = freshDb();

    // Snapshot the row as `recordImmutableSource` left it, before D runs.
    const beforeSource = await runTelegramAdmissionSequence({
      db,
      job: JOB,
      record: QUEUE_RECORD,
      appGeneration: APP_GENERATION,
      mode: MODES.SOURCE_ONLY,
      now: () => NOW,
    });
    expect(beforeSource.ok).toBe(true);
    const before = db.prepare('SELECT * FROM comms_journal WHERE message_id = ?').get(MESSAGE_ID);
    expect(before.status).toBe('recorded');

    const result = await runSequence(db);
    expect(result.ok).toBe(true);
    const after = db.prepare('SELECT * FROM comms_journal WHERE message_id = ?').get(MESSAGE_ID);

    expect(after.status).toBe('brokered');
    expect(Number(after.brokered_at_ms)).toBe(NOW);
    expect(Number(after.updated_at_ms)).toBe(NOW);

    // EVERY OTHER COLUMN IS BYTE-IDENTICAL. Enumerated by difference rather
    // than by a hand-written list, so a column added later is covered without
    // anyone remembering to add it here.
    const changed = Object.keys(before).filter((key) => String(before[key]) !== String(after[key]));
    expect(changed.sort()).toEqual(['brokered_at_ms', 'status', 'updated_at_ms']);
  });
});

describe('B4b — one owner', () => {
  test('a generic-first upsert strands the source, and the sequence REFUSES', async () => {
    const db = freshDb();

    // Exactly what the deleted production code did: a generic row at the same
    // message_id, with no source-identity authority behind it.
    db.prepare(`
      INSERT INTO comms_journal (
        message_id, session_id, sender_role, target_role, channel, direction,
        sent_at_ms, raw_body, body_hash, body_bytes, status, attempt,
        metadata_json, updated_at_ms
      ) VALUES (?, ?, 'user', 'architect', 'telegram', 'inbound', ?, ?, ?, ?, 'brokered', 1, ?, ?)
    `).run(
      MESSAGE_ID, 'app-session-492', NOW - 1000, JOB.rawBody,
      sha256(JOB.rawBody), Buffer.byteLength(JOB.rawBody, 'utf8'),
      JSON.stringify({ source: 'telegram-poller' }), NOW - 900
    );

    const result = await runSequence(db);
    expect(result.ok).toBe(false);
    expect(result.stage).toBe('A_source');
    expect(result.reason).toBe('source_identity_missing');
    expect(result.phase).toBe('before_delivery');

    // NOTHING downstream exists.
    expect(db.prepare('SELECT COUNT(*) AS n FROM telegram_transport_claims').get().n).toBe(0);
  });

  test('source-first then a generic rewrite is detectable: identity columns survive', async () => {
    const db = freshDb();
    const first = await runSequence(db);
    expect(first.ok).toBe(true);

    const identity = db.prepare('SELECT * FROM telegram_source_identity WHERE message_id = ?')
      .get(MESSAGE_ID);
    expect(identity.raw_body_sha256).toBe(sha256(JOB.rawBody));
    expect(identity.update_id).toBe(UPDATE_ID);

    // Re-running the sequence with a DIFFERENT body under the same id is the
    // rewrite the old upsert performed silently. It is a hard conflict.
    const conflicting = await runTelegramAdmissionSequence({
      db,
      job: { ...JOB, rawBody: 'a different message entirely' },
      paneReadiness: () => READY,
      record: QUEUE_RECORD,
      appGeneration: APP_GENERATION,
      composeFinalBody: async () => 'body',
      now: () => NOW,
      nonce: () => 'nonce-fixed-2',
    });
    expect(conflicting.ok).toBe(false);
    expect(conflicting.stage).toBe('A_source');
    expect(conflicting.reason).toBe('source_identity_conflict');
  });

  test('STATIC: no production module outside the kernel writes a telegram-in row', () => {
    // The call-graph assertion. `deliverTelegramInboundJob` used to hand this
    // exact id to the generic upsert; if that ever comes back, this fails.
    const appSource = fs.readFileSync(
      path.join(__dirname, '..', 'modules', 'main', 'squidrun-app.js'), 'utf8'
    );
    const deliverStart = appSource.indexOf('async deliverTelegramInboundJob(');
    expect(deliverStart).toBeGreaterThan(0);

    // BRACE-MATCHED, not anchored on whatever method happens to follow. An
    // anchor that stops matching does not fail — it silently widens or narrows
    // the slice, and a guard that quietly stops covering its subject is worse
    // than no guard.
    // Start at the BODY brace. `indexOf('{')` lands on the default-parameter
    // object in `(job = {})` and closes one character later, which is exactly
    // the kind of plausible-but-wrong slice the shape check below catches.
    const signatureEnd = appSource.indexOf(') {', deliverStart);
    expect(signatureEnd).toBeGreaterThan(deliverStart);
    const open = signatureEnd + 2;
    let depth = 0;
    let end = -1;
    for (let i = open; i < appSource.length; i += 1) {
      const ch = appSource[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) { end = i; break; }
      }
    }
    expect(end).toBeGreaterThan(open);
    const body = appSource.slice(deliverStart, end);

    // The slice really is the method: a shape check, so a brace-matcher that
    // returned something plausible but wrong cannot pass by accident.
    expect(body).toContain('deliverMainTelegramToArchitect');

    // The generic upsert is gone from the inbound Telegram path...
    expect(body).not.toContain("'upsert-comms-journal'");
    // ...and BOTH routes go through the admission kernel instead.
    // Whitespace-normalised: line breaks and CRLF are formatting, and a guard
    // that a reformat can silently switch off is not a guard.
    const flat = body.replace(/\s+/g, ' ');
    expect(flat).toContain('telegramAdmissionDelivery.admitScopedTelegramSource');
    expect(flat).toContain('telegramAdmissionDelivery .deliverAdmittedMainTelegram');

    // And the module they route through is the one that runs the sequence —
    // otherwise "goes through the kernel" is a name, not a call.
    const deliverySource = fs.readFileSync(
      path.join(__dirname, '..', 'modules', 'main', 'telegram-admission-delivery.js'), 'utf8'
    );
    expect(deliverySource).toContain('runTelegramAdmissionSequence(');
    expect(deliverySource).not.toContain("'upsert-comms-journal'");
  });
});

describe('B4b — fail each stage, prove nothing after it ran', () => {
  test('A fails: no claim, no compose, no bytes', async () => {
    const db = freshDb();
    const calls = [];
    const result = await runSequence(db, {
      calls,
      extra: {
        steps: {
          recordImmutableSource: () => ({ ok: false, reason: 'source_insert_failed:disk' }),
        },
      },
      composeFinalBody: async () => { calls.push('compose'); return 'body'; },
    });

    expect(result.ok).toBe(false);
    expect(result.stage).toBe('A_source');
    expect(calls).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM telegram_transport_claims').get().n).toBe(0);
  });

  test('A reports ok but returns no row id: REFUSED rather than joined to nothing', async () => {
    const db = freshDb();
    const calls = [];
    const result = await runSequence(db, {
      calls,
      extra: { steps: { recordImmutableSource: () => ({ ok: true, created: true }) } },
      composeFinalBody: async () => { calls.push('compose'); return 'body'; },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('source_row_id_missing');
    expect(calls).toEqual([]);
  });

  test('B fails: source exists, compose never runs, no delivery_started', async () => {
    const db = freshDb();
    const calls = [];
    const result = await runSequence(db, {
      calls,
      extra: {
        steps: { claimTransportAttempt: () => ({ ok: false, reason: 'claim_held_by_other' }) },
      },
      composeFinalBody: async () => { calls.push('compose'); return 'body'; },
    });

    expect(result.ok).toBe(false);
    expect(result.stage).toBe('B_claim');
    expect(calls).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM telegram_transport_events').get().n).toBe(0);
    // The source SURVIVES a failed claim: it is the identity, not the attempt.
    expect(db.prepare('SELECT status FROM comms_journal WHERE message_id = ?').get(MESSAGE_ID).status)
      .toBe('recorded');
  });

  test('no completed launch: refuses at B before any claim', async () => {
    const db = freshDb();
    // A generation whose pane never bound a session.
    seedLaunch(db, { complete: false, appGeneration: 'gen-never-bound' });
    const result = await runTelegramAdmissionSequence({
      db,
      job: JOB,
      record: QUEUE_RECORD,
      appGeneration: 'gen-never-bound',
      paneReadiness: () => READY,
      composeFinalBody: async () => 'body',
      now: () => NOW,
      nonce: () => 'n1',
    });
    expect(result.ok).toBe(false);
    expect(result.stage).toBe('B_launch');
    expect(result.reason).toBe('launch_incomplete');
  });

  test('C throws: claim is held, delivery_started never written, PROVABLY unsent', async () => {
    const db = freshDb();
    const result = await runSequence(db, {
      composeFinalBody: async () => { throw new Error('recall provider died'); },
    });

    expect(result.ok).toBe(false);
    expect(result.stage).toBe('C_compose');
    expect(result.phase).toBe('before_delivery');

    const claim = db.prepare('SELECT * FROM telegram_transport_claims WHERE update_id = ?').get(UPDATE_ID);
    expect(claim.state).toBe(CLAIM_STATES.CLAIMED);
    expect(db.prepare("SELECT COUNT(*) AS n FROM telegram_transport_events WHERE kind = 'delivery_started'").get().n)
      .toBe(0);
  });

  test('C: a body carrying its own marker cannot suppress or forge the real one', async () => {
    const db = freshDb();
    const hostile = `${MARKER_PREFIX} v=1 u=1 m=x r=main w=main p=main c=1 g=x q=x k=x a=x]`;
    const result = await runSequence(db, {
      composeFinalBody: async () => `[Telegram from James]: ${hostile}`,
    });

    expect(result.ok).toBe(true);
    // Exactly one parseable marker, and it is OURS.
    const marker = parseConsumeMarker(result.authorized.text);
    expect(marker.claimId).toBe(result.claimId);
    expect(marker.updateId).toBe(String(UPDATE_ID));
    // The forgery is visibly defanged rather than silently stripped.
    expect(result.authorized.text).toContain('(SQUIDRUN_TG_CONSUME');
  });

  test('C: an unusable marker field refuses instead of delivering unmarked bytes', async () => {
    const db = freshDb();
    // A route key containing a space cannot be encoded in the one-line marker.
    // The appender returns the text UNCHANGED — a silent success that would
    // deliver a prompt whose proof can never come back.
    const result = await runTelegramAdmissionSequence({
      db,
      job: { ...JOB, routeKey: 'main window', profile: 'main window' },
      paneReadiness: () => READY,
      record: QUEUE_RECORD,
      appGeneration: APP_GENERATION,
      composeFinalBody: async () => 'body',
      now: () => NOW,
      nonce: () => 'n1',
    });
    expect(result.ok).toBe(false);
    expect(result.stage).toBe('C_marker');
    expect(result.reason).toBe('marker_round_trip_failed');
    expect(db.prepare("SELECT COUNT(*) AS n FROM telegram_transport_events WHERE kind = 'delivery_started'").get().n)
      .toBe(0);
  });

  test('D fails: no authorised bytes are returned to the caller', async () => {
    const db = freshDb();
    const result = await runSequence(db, {
      extra: {
        steps: { recordDeliveryStarted: () => ({ ok: false, reason: 'claim_already_admitted' }) },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.stage).toBe('D_delivery_started');
    expect(result.authorized).toBeUndefined();
  });

  test('stale schema stops before any write at all', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-admission-seq-stale-'));
    tempRoots.push(root);
    const writer = new TelegramAdmissionWriter({ dbPath: path.join(root, 'ledger.db') });
    expect(writer.open().ok).toBe(true);
    openWriters.push(writer);
    const db = writer.db;
    applyTelegramAdmissionSchema(db);
    seedLaunch(db);

    // A stale shape: the table exists but not as this kernel defines it.
    db.exec('DROP TABLE telegram_transport_claims');
    db.exec('CREATE TABLE telegram_transport_claims (claim_id TEXT PRIMARY KEY)');

    const calls = [];
    const result = await runTelegramAdmissionSequence({
      db,
      job: JOB,
      record: QUEUE_RECORD,
      appGeneration: APP_GENERATION,
      composeFinalBody: async () => { calls.push('compose'); return 'body'; },
      now: () => NOW,
      nonce: () => 'n1',
    });
    expect(result.ok).toBe(false);
    expect(result.stage).toBe('schema');
    expect(calls).toEqual([]);
  });
});

describe('B4b — concurrency and replay', () => {
  test('two schedules for one message: one claim, one authorisation', async () => {
    const db = freshDb();
    const composeCalls = [];

    // Sequential rather than Promise.all on purpose: `node:sqlite` is
    // synchronous, so a real second scheduler collides at the claim, which is
    // exactly what this asserts. Both callers are otherwise identical except
    // for their nonce, as two real passes would be.
    const first = await runSequence(db, { calls: composeCalls });
    const second = await runTelegramAdmissionSequence({
      db,
      job: JOB,
      record: QUEUE_RECORD,
      appGeneration: APP_GENERATION,
      composeFinalBody: async () => { composeCalls.push('compose'); return 'body'; },
      paneReadiness: () => READY,
      now: () => NOW,
      nonce: () => 'nonce-fixed-2',
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.stage).toBe('B_claim');
    expect(second.reason).toBe('claim_held_by_other');
    expect(db.prepare('SELECT COUNT(*) AS n FROM telegram_transport_claims').get().n).toBe(1);
    // The loser never composed, so no second set of pane bytes was ever built.
    expect(composeCalls).toEqual(['compose']);
  });

  test('exact replay of the same claim is idempotent and reports itself as a replay', async () => {
    const db = freshDb();
    const first = await runSequence(db);
    expect(first.ok).toBe(true);

    // Same nonce and same time reproduces the same claim id: the crash-restart
    // shape where the process died between D and E.
    const replay = await runSequence(db);
    expect(replay.ok).toBe(true);
    expect(replay.claimId).toBe(first.claimId);
    expect(replay.replayed).toBe(true);
    expect(replay.authorized.sha256).toBe(first.authorized.sha256);
    expect(db.prepare("SELECT COUNT(*) AS n FROM telegram_transport_events WHERE kind = 'delivery_started'").get().n)
      .toBe(1);
  });
});

describe('B4b — scoped routes record a source and stop', () => {
  test('source_only writes the row, takes no claim, and says so', async () => {
    const db = freshDb();
    const result = await runTelegramAdmissionSequence({
      db,
      job: { ...JOB, routeKey: 'sideprofile', profile: 'sideprofile', windowKey: 'sideprofile' },
      record: { ...QUEUE_RECORD, routeKey: 'sideprofile', targetProfile: 'sideprofile', targetWindow: 'sideprofile' },
      appGeneration: APP_GENERATION,
      mode: MODES.SOURCE_ONLY,
      now: () => NOW,
    });

    expect(result.ok).toBe(true);
    expect(result.mode).toBe(MODES.SOURCE_ONLY);
    // NO authorisation. A scoped delivery is not proven by this process.
    expect(result.authorized).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM telegram_transport_claims').get().n).toBe(0);
    expect(db.prepare('SELECT status FROM comms_journal WHERE message_id = ?').get(MESSAGE_ID).status)
      .toBe('recorded');
  });
});

// =====================================================================
// THE READINESS ANSWER IS ONE CONTRACT, AND EVERY CLAUSE IS NAMED.
//
// The claims-table regressions live in telegram-drain-claim-authority; these
// pin the VOCABULARY, so a future edit that keeps refusing but stops saying
// which clause failed is visible. A refusal nobody can diagnose is how a gate
// gets loosened by the next person to hit it.
// =====================================================================
describe('B_readiness — one coherent positive contract (Oracle #37)', () => {
  const GOOD = Object.freeze({
    attainable: true, reason: 'runtime_proof_observed', runtime: 'codex', lastProofAtMs: NOW - 1000,
  });
  const evaluate = (answer, overrides = {}) => evaluatePaneReadinessAnswer({
    answer, launchRuntime: 'codex', nowMs: NOW, ...overrides,
  });

  test('the exact production shape is accepted, and nothing else is', () => {
    expect(evaluate(GOOD)).toMatchObject({ ok: true, runtime: 'codex', lastProofAtMs: NOW - 1000 });
  });

  test('each clause refuses under its own name', () => {
    expect(evaluate(null).reason).toBe('pane_readiness_unreadable');
    expect(evaluate('ready').reason).toBe('pane_readiness_unreadable');
    expect(evaluate([]).reason).toBe('pane_readiness_unreadable');
    expect(evaluate({ ...GOOD, ready: false }).reason).toBe('pane_readiness_contradictory');
    expect(evaluate({ ...GOOD, attainable: false }).reason).toBe('pane_readiness_unproven');
    expect(evaluate({ ...GOOD, attainable: 'true' }).reason).toBe('pane_readiness_unproven');
    expect(evaluate({ ...GOOD, reason: 'runtime_proof_stale' }).reason).toBe('pane_readiness_reason_incoherent');
    expect(evaluate({ ...GOOD, reason: undefined }).reason).toBe('pane_readiness_reason_incoherent');
    expect(evaluate({ ...GOOD, runtime: 'claude' }).reason).toBe('pane_readiness_runtime_mismatch');
    expect(evaluate({ ...GOOD, runtime: null }).reason).toBe('pane_readiness_runtime_missing');
    expect(evaluate(GOOD, { launchRuntime: null }).reason).toBe('pane_readiness_launch_runtime_unknown');
    expect(evaluate({ ...GOOD, lastProofAtMs: 0 }).reason).toBe('pane_readiness_proof_time_invalid');
    expect(evaluate({ ...GOOD, lastProofAtMs: NOW + 1 }).reason).toBe('pane_readiness_proof_time_in_future');
    expect(evaluate(GOOD, { nowMs: Number.NaN }).reason).toBe('pane_readiness_clock_unknown');
  });

  test('THE FRESHNESS RULE IS THE PROBE\'S, NOT THIS FILE\'S', () => {
    // One millisecond either side of the production window, decided by
    // re-running probeRuntimeProofCapability rather than by a constant copied
    // into the gate. If the probe ever moves its window, this moves with it.
    const insideWindow = { ...GOOD, lastProofAtMs: NOW - (PROOF_CAPABILITY_WINDOW_MS - 1) };
    const outsideWindow = { ...GOOD, lastProofAtMs: NOW - (PROOF_CAPABILITY_WINDOW_MS + 1) };
    expect(evaluate(insideWindow).ok).toBe(true);
    const refused = evaluate(outsideWindow);
    expect(refused.ok).toBe(false);
    expect(refused.reason).toBe('pane_readiness_not_reproducible');
    // The refusal carries BOTH accounts, so the disagreement is diagnosable
    // instead of being a bare no.
    expect(refused.detail.offered.reason).toBe('runtime_proof_observed');
    expect(refused.detail.rederived.reason).toBe('runtime_proof_stale');
  });

  test('the sequence refuses at B_readiness with the clause name, and takes no claim', async () => {
    const db = freshDb();
    const result = await runSequence(db, {
      paneReadiness: () => ({ ...GOOD, runtime: 'claude' }),
    });
    expect(result.ok).toBe(false);
    expect(result.stage).toBe('B_readiness');
    expect(result.reason).toBe('pane_readiness_runtime_mismatch');
    expect(result.detail).toMatchObject({ launchRuntime: 'codex', answeredRuntime: 'claude' });
    expect(result.ownedClaimId).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM telegram_transport_claims').get().n).toBe(0);
  });
});

describe('findActivePaneLaunch', () => {
  test('ambiguity refuses rather than guessing a pane', () => {
    const db = freshDb();
    seedLaunch(db, { appGeneration: 'gen-dup' });
    seedLaunch(db, { appGeneration: 'gen-dup' });
    const found = findActivePaneLaunch(db, { appGeneration: 'gen-dup', paneId: '1' });
    expect(found.ok).toBe(false);
    expect(found.reason).toBe('launch_ambiguous');
  });

  test('a launch from another generation is not a fallback', () => {
    const db = freshDb();
    const found = findActivePaneLaunch(db, { appGeneration: 'gen-that-never-ran', paneId: '1' });
    expect(found.ok).toBe(false);
    expect(found.reason).toBe('launch_not_recorded');
  });
});
