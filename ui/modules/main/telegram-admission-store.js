/**
 * S491 v3 CHECKPOINT A — the narrow storage foundation for Telegram admission.
 *
 * A separate module rather than more of `evidence-ledger-store.js`, per the
 * gate's "prefer narrow modules over growing already-large files". It takes a
 * caller-supplied SQLite handle so the ATOMIC BOUNDARY IS PRESERVED: the
 * ownership promotion below is one transaction on one connection, and nothing
 * here fragments a transaction to satisfy a line count.
 *
 * =====================================================================
 * WHAT THIS IS FOR
 * =====================================================================
 * v3 reframes the inbound JSONL queue as a TRANSPORT SPOOL. Retiring a record
 * means the exact marked prompt reached the consumer boundary and a durable
 * room obligation now owns James's unanswered message. It does NOT mean the
 * model turn completed or that any business effect happened.
 *
 * The old design used one queue record to mean transport, model work, AND
 * reply at once — so a failure in the last two blocked all later transport,
 * including the correction that gave the earlier instruction its meaning. That
 * is precisely how "Not the tankless job the other one" ended up stuck behind
 * the message it was correcting.
 *
 * Three durable facts are recorded here, in strict order, and each is useless
 * on its own:
 *   1. an IMMUTABLE SOURCE ROW    — what James actually said
 *   2. an EXCLUSIVE TRANSPORT CLAIM — who is allowed to write it to a pane
 *   3. an ADMITTED-OWNED PROMOTION  — the obligation that now owes him an answer
 *
 * =====================================================================
 * WHY THE CLAIM IS A DATABASE CONSTRAINT AND NOT A FILE
 * =====================================================================
 * The attempt journal is an AUDIT PROJECTION, not the exclusivity primitive.
 * A JSONL latch cannot arbitrate between two coordinators holding two database
 * handles; a UNIQUE index can. So exclusivity is `UNIQUE(cutover_id, route_key,
 * update_id)` and the loser of the race is told it lost rather than quietly
 * writing a second copy of James's message into a pane.
 *
 * An OUTSTANDING AMBIGUOUS CLAIM IS NEVER STOLEN — not on a timer, not after a
 * grace, not because it looks old. The one irreducible ambiguous interval in
 * the crash table stays visible and manually recoverable. Stealing it is how a
 * duplicate becomes invisible to us.
 */
const crypto = require('node:crypto');

const SCHEMA_VERSION = 'telegram_admission_store.v1';

/**
 * Deterministic obligation identity uses the KERNEL'S OWN builder with a fixed
 * null lease. `buildObligationId` folds `leaseId || ''` into its canonical
 * string, so passing no lease is the fixed-null form the gate requires — and
 * later Telegram work leases/generations live only in the binding subsystem
 * below, where they can never alter the exposed obligation id.
 *
 * Mirroring the derivation by hand would be the "verify against the source of
 * truth" mistake; we call the kernel's function so the two cannot drift.
 */
const { buildObligationId } = require('./obligation-kernel');

const CLAIM_STATES = Object.freeze({
  CLAIMED: 'claimed',
  DELIVERY_STARTED: 'delivery_started',
  CLOSED_UNSENT: 'closed_unsent',
  ADMITTED: 'admitted',
});

/** States from which a claim may still be closed as provably unsent. */
const CLOSEABLE_UNSENT_STATES = Object.freeze(new Set([CLAIM_STATES.CLAIMED]));

const SOURCE_STATES = Object.freeze({ RECORDED: 'recorded', BROKERED: 'brokered' });

/**
 * Every field of the source row that is IDENTITY. A later insert differing in
 * ANY of these for the same message id is a hard conflict, never a merge — the
 * gate is explicit that same-id-with-changed-body must fail rather than
 * silently update, because an updated source row would rewrite what James said
 * after the fact.
 */
const SOURCE_IDENTITY_COLUMNS = Object.freeze([
  'update_id',
  'chat_id',
  'route_key',
  'profile',
  'window_key',
  'raw_body',
  'raw_body_sha256',
  'canonical_payload_sha256',
  'media_identity_sha256',
  'cutover_id',
]);

/** Binding columns that may never merge or be rewritten once written. */
const BINDING_IDENTITY_COLUMNS = Object.freeze([
  'cutover_id', 'update_id', 'message_id', 'chat_id', 'route_key', 'profile', 'window_key',
  'raw_body_sha256', 'canonical_payload_sha256', 'predecessor_manifest_sha256',
  'admission_id', 'attempt_nonce', 'app_generation', 'pane_launch_id',
  'consumer_session_id', 'runtime_submission_id', 'runtime_submission_kind',
  'queue_ack_intent',
]);

function sha256(value) {
  return crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/** A scalar that can serve as durable identity: non-empty string or a number. */
function isScalarIdentity(value) {
  if (typeof value === 'number') return Number.isFinite(value);
  return isNonEmptyString(value);
}

function fail(reason, detail = null) {
  return detail === null ? { ok: false, reason } : { ok: false, reason, detail };
}

/**
 * DURABILITY. `synchronous=FULL` is what makes a committed transaction survive
 * power loss; it is the SQLite equivalent of the fsync the gate demands around
 * `delivery_started`. WAL keeps readers concurrent without weakening that.
 * Set explicitly rather than inherited, because a caller-supplied handle may
 * have been opened with anything.
 */
function applyTelegramAdmissionSchema(db) {
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=FULL;
    PRAGMA foreign_keys=ON;

    CREATE TABLE IF NOT EXISTS telegram_source_rows (
      source_row_id             INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id                TEXT    NOT NULL UNIQUE,
      update_id                 INTEGER NOT NULL,
      chat_id                   TEXT    NOT NULL,
      route_key                 TEXT    NOT NULL,
      profile                   TEXT    NOT NULL,
      window_key                TEXT    NOT NULL,
      raw_body                  TEXT    NOT NULL,
      raw_body_sha256           TEXT    NOT NULL,
      canonical_payload_sha256  TEXT    NOT NULL,
      media_identity_sha256     TEXT    NOT NULL,
      cutover_id                TEXT    NOT NULL,
      obligation_id             TEXT    NOT NULL,
      status                    TEXT    NOT NULL DEFAULT 'recorded',
      recorded_at_ms            INTEGER NOT NULL,
      brokered_at_ms            INTEGER
    );

    -- THE EXCLUSIVITY PRIMITIVE. One claimant per (cutover, route, update)
    -- across every coordinator and every database handle.
    CREATE TABLE IF NOT EXISTS telegram_transport_claims (
      claim_id          TEXT    PRIMARY KEY,
      cutover_id        TEXT    NOT NULL,
      route_key         TEXT    NOT NULL,
      update_id         INTEGER NOT NULL,
      source_row_id     INTEGER NOT NULL REFERENCES telegram_source_rows(source_row_id),
      app_generation    TEXT    NOT NULL,
      pane_launch_id    TEXT    NOT NULL,
      pane_id           TEXT    NOT NULL,
      role              TEXT    NOT NULL,
      consumer_runtime  TEXT    NOT NULL,
      attempt_nonce     TEXT    NOT NULL,
      attempt_at_ms     INTEGER NOT NULL,
      state             TEXT    NOT NULL,
      closed_at_ms      INTEGER
    );

    -- PARTIAL unique index, not a table constraint. A claim closed as provably
    -- unsent must RELEASE the exclusivity slot while KEEPING its audit row and
    -- its events — deleting it would destroy the record that a delivery was
    -- attempted and rejected, and the event foreign keys would refuse anyway.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tg_claims_exclusive
      ON telegram_transport_claims (cutover_id, route_key, update_id)
      WHERE state != 'closed_unsent';

    CREATE TABLE IF NOT EXISTS telegram_transport_events (
      event_id   INTEGER PRIMARY KEY AUTOINCREMENT,
      claim_id   TEXT    NOT NULL REFERENCES telegram_transport_claims(claim_id),
      kind       TEXT    NOT NULL,
      at_ms      INTEGER NOT NULL,
      detail     TEXT
    );

    CREATE TABLE IF NOT EXISTS telegram_obligation_bindings (
      obligation_id                 TEXT    PRIMARY KEY,
      source_row_id                 INTEGER NOT NULL UNIQUE
                                      REFERENCES telegram_source_rows(source_row_id),
      cutover_id                    TEXT    NOT NULL,
      update_id                     INTEGER NOT NULL,
      message_id                    TEXT    NOT NULL,
      chat_id                       TEXT    NOT NULL,
      route_key                     TEXT    NOT NULL,
      profile                       TEXT    NOT NULL,
      window_key                    TEXT    NOT NULL,
      raw_body_sha256               TEXT    NOT NULL,
      canonical_payload_sha256      TEXT    NOT NULL,
      predecessor_manifest_sha256   TEXT    NOT NULL,
      admission_id                  TEXT    NOT NULL,
      attempt_nonce                 TEXT    NOT NULL,
      app_generation                TEXT    NOT NULL,
      pane_launch_id                TEXT    NOT NULL,
      consumer_session_id           TEXT    NOT NULL,
      runtime_submission_id         TEXT    NOT NULL,
      runtime_submission_kind       TEXT    NOT NULL,
      queue_ack_intent              TEXT    NOT NULL,
      obligor_address               TEXT    NOT NULL,
      work_generation               INTEGER NOT NULL,
      work_lease_token              TEXT    NOT NULL,
      state                         TEXT    NOT NULL,
      created_at_ms                 INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS telegram_binding_events (
      event_id       INTEGER PRIMARY KEY AUTOINCREMENT,
      obligation_id  TEXT    NOT NULL REFERENCES telegram_obligation_bindings(obligation_id),
      transition     TEXT    NOT NULL,
      at_ms          INTEGER NOT NULL,
      detail         TEXT
    );

    -- OUTBOX INTENT, created with the ownership transaction so a reply path can
    -- never invent one later without a committed obligation behind it.
    CREATE TABLE IF NOT EXISTS telegram_outbound_intents (
      intent_id       TEXT    PRIMARY KEY,
      obligation_id   TEXT    NOT NULL REFERENCES telegram_obligation_bindings(obligation_id),
      chat_id         TEXT    NOT NULL,
      route_key       TEXT    NOT NULL,
      state           TEXT    NOT NULL,
      created_at_ms   INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tg_source_update ON telegram_source_rows(update_id);
    CREATE INDEX IF NOT EXISTS idx_tg_claims_state  ON telegram_transport_claims(state);
    CREATE INDEX IF NOT EXISTS idx_tg_bind_state    ON telegram_obligation_bindings(state);
  `);
  return { ok: true, schemaVersion: SCHEMA_VERSION };
}

function begin(db) { db.exec('BEGIN IMMEDIATE'); }
function commit(db) { db.exec('COMMIT'); }
function rollback(db) { try { db.exec('ROLLBACK'); } catch { /* already unwound */ } }

/**
 * STEP 2 of the transport machine: record the immutable source row.
 *
 * NO GENERIC UPSERT AND NO `expects`. Both are deliberate: the generic comms
 * upsert would happily rewrite an existing row, and an `expects` field on a
 * merely-recorded source would create phantom debt for a message that has not
 * been admitted to anything yet. Debt is created exactly once, later, inside
 * the ownership transaction.
 *
 * @returns {{ok:true, sourceRowId:number, obligationId:string, created:boolean}}
 *          | {ok:false, reason:string, detail?:object}
 */
function recordImmutableSource(db, input = {}) {
  const required = [
    'messageId', 'routeKey', 'profile', 'windowKey', 'rawBody',
    'canonicalPayloadSha256', 'cutoverId', 'obligorAddress',
  ];
  for (const field of required) {
    if (!isNonEmptyString(input[field])) return fail(`source_field_missing:${field}`);
  }
  // chatId arrives as a NUMBER from Telegram and as a string from some journal
  // rows. Stored as TEXT either way; requiring a string here would have
  // rejected every real message.
  if (!isScalarIdentity(input.chatId)) return fail('source_field_missing:chatId');
  if (!Number.isSafeInteger(input.updateId) || input.updateId <= 0) {
    return fail('source_field_missing:updateId');
  }
  const recordedAtMs = Number(input.recordedAtMs);
  if (!Number.isSafeInteger(recordedAtMs) || recordedAtMs <= 0) {
    return fail('source_field_missing:recordedAtMs');
  }

  const candidate = {
    message_id: input.messageId,
    update_id: input.updateId,
    chat_id: String(input.chatId),
    route_key: input.routeKey,
    profile: input.profile,
    window_key: input.windowKey,
    raw_body: input.rawBody,
    raw_body_sha256: sha256(input.rawBody),
    canonical_payload_sha256: input.canonicalPayloadSha256,
    media_identity_sha256: isNonEmptyString(input.mediaIdentitySha256)
      ? input.mediaIdentitySha256
      : sha256(''),
    cutover_id: input.cutoverId,
  };

  begin(db);
  try {
    const existing = db.prepare('SELECT * FROM telegram_source_rows WHERE message_id = ?')
      .get(input.messageId);

    if (existing) {
      // VERIFY, NEVER MERGE. Any identity difference is a hard conflict on
      // every later path — the row is what James said, and it does not get
      // edited because a second caller disagrees.
      for (const column of SOURCE_IDENTITY_COLUMNS) {
        if (String(existing[column]) !== String(candidate[column])) {
          rollback(db);
          return fail('source_identity_conflict', {
            column,
            stored: existing[column],
            offered: candidate[column],
          });
        }
      }
      commit(db);
      return {
        ok: true,
        sourceRowId: existing.source_row_id,
        obligationId: existing.obligation_id,
        created: false,
      };
    }

    const insert = db.prepare(`
      INSERT INTO telegram_source_rows (
        message_id, update_id, chat_id, route_key, profile, window_key,
        raw_body, raw_body_sha256, canonical_payload_sha256, media_identity_sha256,
        cutover_id, obligation_id, status, recorded_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    // The obligation id needs the row id, and the row needs the obligation id.
    // Insert with a placeholder inside the SAME transaction, derive, then fill
    // it — so no reader can ever observe a source row without its future
    // obligation id, and no id is derived from a row that did not commit.
    insert.run(
      candidate.message_id, candidate.update_id, candidate.chat_id, candidate.route_key,
      candidate.profile, candidate.window_key, candidate.raw_body, candidate.raw_body_sha256,
      candidate.canonical_payload_sha256, candidate.media_identity_sha256,
      candidate.cutover_id, '', SOURCE_STATES.RECORDED, recordedAtMs
    );
    const sourceRowId = Number(
      db.prepare('SELECT source_row_id FROM telegram_source_rows WHERE message_id = ?')
        .get(input.messageId).source_row_id
    );

    // FIXED NULL KERNEL LEASE: no leaseId is passed, which the kernel folds as
    // the empty string. Telegram work leases never enter this derivation.
    const obligationId = buildObligationId({
      createdFromRowId: sourceRowId,
      creditorAddress: 'james',
      obligorAddress: input.obligorAddress,
      expectedClass: 'answer',
      stalenessClass: 'turn',
    });

    db.prepare('UPDATE telegram_source_rows SET obligation_id = ? WHERE source_row_id = ?')
      .run(obligationId, sourceRowId);

    commit(db);
    return { ok: true, sourceRowId, obligationId, created: true };
  } catch (err) {
    rollback(db);
    return fail(`source_insert_failed:${err.message}`);
  }
}

/**
 * STEP 3: acquire the one durable transport-attempt claim.
 *
 * The UNIQUE constraint is the arbiter. Two coordinators on two handles both
 * reach this; exactly one INSERT survives, and the loser is told
 * `claim_held_by_other` rather than being allowed to write a second copy of
 * James's message into a pane.
 *
 * IDEMPOTENT ONLY FOR THE EXACT SAME CLAIMANT. A retry from the same attempt
 * nonce, generation, launch, pane, role and runtime is the same attempt and
 * gets its claim back. Anything else is a different attempt wearing the same
 * key, and it is refused.
 */
function claimTransportAttempt(db, input = {}) {
  const required = [
    'cutoverId', 'routeKey', 'appGeneration', 'paneLaunchId', 'paneId', 'role',
    'consumerRuntime', 'attemptNonce',
  ];
  for (const field of required) {
    if (!isNonEmptyString(input[field])) return fail(`claim_field_missing:${field}`);
  }
  if (!Number.isSafeInteger(input.updateId) || input.updateId <= 0) {
    return fail('claim_field_missing:updateId');
  }
  if (!Number.isSafeInteger(input.sourceRowId) || input.sourceRowId <= 0) {
    return fail('claim_field_missing:sourceRowId');
  }
  const attemptAtMs = Number(input.attemptAtMs);
  if (!Number.isSafeInteger(attemptAtMs) || attemptAtMs <= 0) {
    return fail('claim_field_missing:attemptAtMs');
  }

  const claimId = `tgc_${sha256([
    input.cutoverId, input.routeKey, String(input.updateId), input.attemptNonce,
  ].join(' '))}`;

  begin(db);
  try {
    // Only a LIVE claim occupies the slot; closed-unsent rows stay for audit.
    const existing = db.prepare(`
      SELECT * FROM telegram_transport_claims
      WHERE cutover_id = ? AND route_key = ? AND update_id = ?
        AND state != '${CLAIM_STATES.CLOSED_UNSENT}'
    `).get(input.cutoverId, input.routeKey, input.updateId);

    if (existing) {
      const sameClaimant = existing.claim_id === claimId
        && existing.app_generation === input.appGeneration
        && existing.pane_launch_id === input.paneLaunchId
        && existing.pane_id === String(input.paneId)
        && existing.role === input.role
        && existing.consumer_runtime === input.consumerRuntime
        && existing.attempt_nonce === input.attemptNonce;

      if (sameClaimant) {
        commit(db);
        return { ok: true, claimId: existing.claim_id, state: existing.state, created: false };
      } else {
        // NEVER STOLEN. Not on a timer, not after a grace, not because it looks
        // old. An outstanding ambiguous claim stays with its owner and the
        // route holds visibly.
        rollback(db);
        return fail('claim_held_by_other', {
          heldClaimId: existing.claim_id,
          heldState: existing.state,
        });
      }
    }

    db.prepare(`
      INSERT INTO telegram_transport_claims (
        claim_id, cutover_id, route_key, update_id, source_row_id,
        app_generation, pane_launch_id, pane_id, role, consumer_runtime,
        attempt_nonce, attempt_at_ms, state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      claimId, input.cutoverId, input.routeKey, input.updateId, input.sourceRowId,
      input.appGeneration, input.paneLaunchId, String(input.paneId), input.role,
      input.consumerRuntime, input.attemptNonce, attemptAtMs, CLAIM_STATES.CLAIMED
    );

    commit(db);
    return { ok: true, claimId, state: CLAIM_STATES.CLAIMED, created: true };
  } catch (err) {
    rollback(db);
    // A UNIQUE violation here means another handle won the race between our
    // SELECT and INSERT. That is the constraint doing its job, not an error.
    if (/UNIQUE|constraint/i.test(err.message)) {
      return fail('claim_held_by_other', { raceLost: true });
    }
    return fail(`claim_failed:${err.message}`);
  }
}

/**
 * The durable `delivery_started` event. ONLY AFTER THIS MAY A PANE WRITE BEGIN.
 * Committing with synchronous=FULL is the fsync the gate requires: if this
 * returns, the intent survives power loss, so a crash mid-write is ambiguous
 * rather than invisible.
 */
function recordDeliveryStarted(db, input = {}) {
  if (!isNonEmptyString(input.claimId)) return fail('delivery_started_field_missing:claimId');
  const atMs = Number(input.atMs);
  if (!Number.isSafeInteger(atMs) || atMs <= 0) return fail('delivery_started_field_missing:atMs');

  begin(db);
  try {
    const claim = db.prepare('SELECT * FROM telegram_transport_claims WHERE claim_id = ?')
      .get(input.claimId);
    if (!claim) { rollback(db); return fail('claim_not_found'); }
    if (claim.state === CLAIM_STATES.CLOSED_UNSENT) {
      rollback(db); return fail('claim_closed');
    }
    // MONOTONIC. Re-announcing a delivery that already started is idempotent;
    // it never rewinds the claim to a pre-delivery state.
    if (claim.state === CLAIM_STATES.CLAIMED) {
      db.prepare('UPDATE telegram_transport_claims SET state = ? WHERE claim_id = ?')
        .run(CLAIM_STATES.DELIVERY_STARTED, input.claimId);
      db.prepare('INSERT INTO telegram_transport_events (claim_id, kind, at_ms, detail) VALUES (?, ?, ?, ?)')
        .run(input.claimId, 'delivery_started', atMs, input.detail ?? null);
    }
    commit(db);
    return { ok: true, claimId: input.claimId, state: CLAIM_STATES.DELIVERY_STARTED };
  } catch (err) {
    rollback(db);
    return fail(`delivery_started_failed:${err.message}`);
  }
}

/**
 * Close a claim that is PROVABLY UNSENT — a definite pre-delivery rejection,
 * where we know no bytes reached a pane. Permitted only from `claimed`: once
 * `delivery_started` is durable the attempt is ambiguous, and an ambiguous
 * attempt is exactly what must never be closed and retried.
 */
function closeUnsentClaim(db, input = {}) {
  if (!isNonEmptyString(input.claimId)) return fail('close_field_missing:claimId');
  if (!isNonEmptyString(input.reason)) return fail('close_field_missing:reason');
  const atMs = Number(input.atMs);
  if (!Number.isSafeInteger(atMs) || atMs <= 0) return fail('close_field_missing:atMs');

  begin(db);
  try {
    const claim = db.prepare('SELECT * FROM telegram_transport_claims WHERE claim_id = ?')
      .get(input.claimId);
    if (!claim) { rollback(db); return fail('claim_not_found'); }
    if (!CLOSEABLE_UNSENT_STATES.has(claim.state)) {
      rollback(db);
      return fail('claim_not_provably_unsent', { state: claim.state });
    }
    db.prepare('UPDATE telegram_transport_claims SET state = ?, closed_at_ms = ? WHERE claim_id = ?')
      .run(CLAIM_STATES.CLOSED_UNSENT, atMs, input.claimId);
    db.prepare('INSERT INTO telegram_transport_events (claim_id, kind, at_ms, detail) VALUES (?, ?, ?, ?)')
      .run(input.claimId, 'claim_closed_unsent', atMs, input.reason);
    commit(db);
    return { ok: true, claimId: input.claimId, state: CLAIM_STATES.CLOSED_UNSENT };
  } catch (err) {
    rollback(db);
    return fail(`close_failed:${err.message}`);
  }
}

/**
 * STEP 5: `admitted_owned`. ONE transaction, ALL COMMIT OR NONE DOES.
 *
 * Re-verifies the immutable source row and the claim, promotes the source to
 * `brokered`, and creates the obligation binding, its created event, the
 * outbound intent, and the INITIAL WORK GENERATION.
 *
 * The work generation is created HERE rather than lazily, because the gate is
 * explicit that N+1 cannot be the only recovery trigger: if nothing owns the
 * work from the moment of admission, a message that is admitted and then
 * abandoned has no owner until another message happens to arrive behind it.
 * That is the eight-hour silence in a new costume.
 *
 * Admission never creates an unbound background claim — the work claim is bound
 * to this admission's session, submission id, attempt and launch.
 */
function promoteToAdmittedOwned(db, input = {}) {
  const required = [
    'messageId', 'claimId', 'admissionId', 'consumerSessionId',
    'runtimeSubmissionId', 'runtimeSubmissionKind', 'obligorAddress', 'queueAckIntent',
  ];
  for (const field of required) {
    if (!isNonEmptyString(input[field])) return fail(`owned_field_missing:${field}`);
  }
  const atMs = Number(input.atMs);
  if (!Number.isSafeInteger(atMs) || atMs <= 0) return fail('owned_field_missing:atMs');

  begin(db);
  try {
    const source = db.prepare('SELECT * FROM telegram_source_rows WHERE message_id = ?')
      .get(input.messageId);
    if (!source) { rollback(db); return fail('source_row_missing'); }

    const claim = db.prepare('SELECT * FROM telegram_transport_claims WHERE claim_id = ?')
      .get(input.claimId);
    if (!claim) { rollback(db); return fail('claim_not_found'); }
    if (claim.source_row_id !== source.source_row_id) {
      rollback(db); return fail('claim_source_mismatch');
    }
    // Ownership may only follow a delivery that actually started. Promoting a
    // merely-claimed attempt would create debt for words nobody sent.
    //
    // ADMITTED is also accepted, and that is required rather than lenient: the
    // crash table's "after ownership transaction, before queue ack" row means a
    // restart re-runs this promotion, and it must reach the same committed
    // answer instead of refusing its own completed work. The identity check
    // below is what keeps that idempotent rather than permissive.
    if (claim.state !== CLAIM_STATES.DELIVERY_STARTED && claim.state !== CLAIM_STATES.ADMITTED) {
      rollback(db); return fail('claim_not_delivery_started', { state: claim.state });
    }

    // RE-VERIFY the immutable payload identity at promotion time. If the source
    // row no longer matches what the caller believes it delivered, the two have
    // diverged and nothing may be promoted.
    if (isNonEmptyString(input.canonicalPayloadSha256)
      && source.canonical_payload_sha256 !== input.canonicalPayloadSha256) {
      rollback(db); return fail('source_payload_digest_mismatch');
    }

    const existingBinding = db.prepare(
      'SELECT * FROM telegram_obligation_bindings WHERE obligation_id = ?'
    ).get(source.obligation_id);

    if (existingBinding) {
      // IDENTITY NEVER MERGES OR REWRITES. An exact replay is idempotent; any
      // difference fails closed rather than advancing the row.
      const offered = {
        cutover_id: source.cutover_id,
        update_id: source.update_id,
        message_id: source.message_id,
        chat_id: source.chat_id,
        route_key: source.route_key,
        profile: source.profile,
        window_key: source.window_key,
        raw_body_sha256: source.raw_body_sha256,
        canonical_payload_sha256: source.canonical_payload_sha256,
        predecessor_manifest_sha256: isNonEmptyString(input.predecessorManifestSha256)
          ? input.predecessorManifestSha256 : sha256(''),
        admission_id: input.admissionId,
        attempt_nonce: claim.attempt_nonce,
        app_generation: claim.app_generation,
        pane_launch_id: claim.pane_launch_id,
        consumer_session_id: input.consumerSessionId,
        runtime_submission_id: input.runtimeSubmissionId,
        runtime_submission_kind: input.runtimeSubmissionKind,
        queue_ack_intent: input.queueAckIntent,
      };
      for (const column of BINDING_IDENTITY_COLUMNS) {
        if (String(existingBinding[column]) !== String(offered[column])) {
          rollback(db);
          return fail('binding_identity_conflict', {
            column, stored: existingBinding[column], offered: offered[column],
          });
        }
      }
      commit(db);
      return {
        ok: true,
        obligationId: existingBinding.obligation_id,
        sourceRowId: source.source_row_id,
        workGeneration: existingBinding.work_generation,
        workLeaseToken: existingBinding.work_lease_token,
        created: false,
      };
    }

    const workLeaseToken = `tgl_${sha256([source.obligation_id, '1', input.admissionId].join(' '))}`;

    db.prepare(`
      INSERT INTO telegram_obligation_bindings (
        obligation_id, source_row_id, cutover_id, update_id, message_id, chat_id,
        route_key, profile, window_key, raw_body_sha256, canonical_payload_sha256,
        predecessor_manifest_sha256, admission_id, attempt_nonce, app_generation,
        pane_launch_id, consumer_session_id, runtime_submission_id,
        runtime_submission_kind, queue_ack_intent, obligor_address,
        work_generation, work_lease_token, state, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      source.obligation_id, source.source_row_id, source.cutover_id, source.update_id,
      source.message_id, source.chat_id, source.route_key, source.profile, source.window_key,
      source.raw_body_sha256, source.canonical_payload_sha256,
      isNonEmptyString(input.predecessorManifestSha256) ? input.predecessorManifestSha256 : sha256(''),
      input.admissionId, claim.attempt_nonce, claim.app_generation, claim.pane_launch_id,
      input.consumerSessionId, input.runtimeSubmissionId, input.runtimeSubmissionKind,
      input.queueAckIntent, input.obligorAddress, 1, workLeaseToken, 'open', atMs
    );

    db.prepare('INSERT INTO telegram_binding_events (obligation_id, transition, at_ms, detail) VALUES (?, ?, ?, ?)')
      .run(source.obligation_id, 'created', atMs, null);

    db.prepare(`
      INSERT INTO telegram_outbound_intents (intent_id, obligation_id, chat_id, route_key, state, created_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      `tgi_${sha256([source.obligation_id, 'initial'].join(' '))}`,
      source.obligation_id, source.chat_id, source.route_key, 'reserved_none', atMs
    );

    db.prepare('UPDATE telegram_source_rows SET status = ?, brokered_at_ms = ? WHERE source_row_id = ?')
      .run(SOURCE_STATES.BROKERED, atMs, source.source_row_id);

    db.prepare('UPDATE telegram_transport_claims SET state = ? WHERE claim_id = ?')
      .run(CLAIM_STATES.ADMITTED, input.claimId);

    commit(db);
    return {
      ok: true,
      obligationId: source.obligation_id,
      sourceRowId: source.source_row_id,
      workGeneration: 1,
      workLeaseToken,
      created: true,
    };
  } catch (err) {
    rollback(db);
    return fail(`owned_promotion_failed:${err.message}`);
  }
}

module.exports = {
  SCHEMA_VERSION,
  CLAIM_STATES,
  SOURCE_STATES,
  SOURCE_IDENTITY_COLUMNS,
  BINDING_IDENTITY_COLUMNS,
  sha256,
  applyTelegramAdmissionSchema,
  recordImmutableSource,
  claimTransportAttempt,
  recordDeliveryStarted,
  closeUnsentClaim,
  promoteToAdmittedOwned,
};
