/**
 * S491 v3 checkpoint A2 — Telegram admission storage, on the REAL authorities.
 *
 * =====================================================================
 * WHAT A1 GOT WRONG, BECAUSE IT IS THE POINT OF THIS FILE
 * =====================================================================
 * The first version wrote a private `telegram_source_rows` table and a private
 * binding, and its 56 tests passed. They were green about tables nothing else
 * reads. After `promoteToAdmittedOwned` returned `admitted_owned`, the general
 * Obligation Kernel still held ZERO debt — so James's unanswered message had
 * no owner anywhere the room can see.
 *
 * That is this session's own failure pattern arriving in the foundation built
 * to end it: a subsystem certifying itself without touching the layer that
 * matters. The shadow runner said running:true while dead; health scored
 * 100/100 over six rotting messages; the bus certified 2417 bytes for a
 * 125-char tail; a receipt adapter was declared and never executed. This was
 * the fifth, and it was structural rather than a coercion bug.
 *
 * So the authorities here are the REAL ones and there is no competing source:
 *   comms_journal   — the immutable inbound row IS the source of record
 *   obligations     — the actual kernel debt, keyed to comms_journal.row_id
 *   ledger_events   — the created event
 *   telegram_*      — bindings that REFERENCE those, never replace them
 *
 * The obligation id therefore hashes `comms_journal.row_id`, which is what the
 * kernel's own foreign key points at. A local row id could never match it.
 */
const crypto = require('node:crypto');

const {
  buildObligationId,
} = require('./obligation-kernel');
const {
  applyLaunchRegistrySchema,
  loadAdmissionReceipt,
  LAUNCH_STATES,
  SUBMISSION_KINDS,
} = require('./telegram-launch-registry');
const { validateAdmissionRecord } = require('./telegram-consumed-proof');

const SCHEMA_VERSION = 'telegram_admission_store.v2';
/** Versioned key under `comms_journal.metadata_json`. Identity, not decoration. */
const SOURCE_METADATA_KEY = 'telegramAdmissionSource.v1';

const CLAIM_STATES = Object.freeze({
  CLAIMED: 'claimed',
  DELIVERY_STARTED: 'delivery_started',
  CLOSED_UNSENT: 'closed_unsent',
  ADMITTED: 'admitted',
});

const SOURCE_STATES = Object.freeze({ RECORDED: 'recorded', BROKERED: 'brokered' });

/** Queue-ack outbox states. NOT reply intent — that begins in checkpoint C. */
const QUEUE_ACK_STATES = Object.freeze({
  PENDING: 'queue_ack_pending',
  APPENDED: 'queue_ack_appended',
});

const SHA256_RE = /^[0-9a-f]{64}$/;

/**
 * Telegram identity carried in the source row's metadata. Every one of these
 * is verified on re-record: a differing value is a hard conflict, never a
 * merge, because the row is what James said and it does not get edited
 * because a second caller disagrees.
 *
 * `obligorAddress` is here BECAUSE IT FEEDS THE OBLIGATION ID. A1 hashed it
 * but did not store it, so the same message with a changed obligor re-recorded
 * as idempotent while pointing at a different debt.
 */
const SOURCE_IDENTITY_FIELDS = Object.freeze([
  'updateId', 'chatId', 'routeKey', 'profile', 'windowKey',
  'canonicalPayloadSha256', 'mediaIdentitySha256', 'cutoverId', 'obligorAddress',
]);

/** Binding columns that may never merge or be rewritten once written. */
const BINDING_IDENTITY_COLUMNS = Object.freeze([
  'cutover_id', 'update_id', 'message_id', 'chat_id', 'route_key', 'profile', 'window_key',
  'raw_body_sha256', 'canonical_payload_sha256', 'predecessor_manifest_sha256',
  'admission_id', 'attempt_nonce', 'app_generation', 'pane_launch_id', 'pane_id', 'role',
  'consumer_runtime', 'hook_process_id', 'hook_parent_process_id',
  'consumer_session_id', 'runtime_submission_id', 'runtime_submission_kind',
  'obligor_address', 'queue_ack_intent',
]);

/**
 * LENGTH-PREFIXED CANONICAL JOIN.
 *
 * A1 joined hash inputs with a literal NUL byte, which made this production
 * file BINARY to ripgrep — so the source scans that find problems could not
 * see the file at all. Self-inflicted blindness, and the exact class of defect
 * this lane exists to hunt.
 *
 * The replacement is ASCII and unambiguous: each part is prefixed with its
 * byte length, so no field content can forge a delimiter and two different
 * field lists can never collide.
 */
function canonicalJoin(parts) {
  return parts
    .map((part) => {
      const value = String(part ?? '');
      return `${Buffer.byteLength(value, 'utf8')}:${value}`;
    })
    .join('|');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isScalarIdentity(value) {
  if (typeof value === 'number') return Number.isFinite(value);
  return isNonEmptyString(value);
}

function fail(reason, detail = null) {
  return detail === null ? { ok: false, reason } : { ok: false, reason, detail };
}

/**
 * DURABILITY IS ASSERTED ON THE HANDLE WE WERE GIVEN, never assumed from a
 * pragma set somewhere else.
 *
 * The gate's fsync requirement resolves to a durable SQLite commit: in WAL
 * mode `synchronous=FULL` syncs the WAL on every commit. Asserting it here
 * means a caller who hands us a handle opened with `synchronous=NORMAL` is
 * REFUSED rather than quietly given weaker durability than this state machine
 * assumes. A claim we cannot make durable must not be made.
 */
function assertDurableHandle(db) {
  let journalMode = null;
  let synchronous = null;
  try {
    journalMode = String(db.prepare('PRAGMA journal_mode').get().journal_mode || '').toLowerCase();
    const row = db.prepare('PRAGMA synchronous').get();
    synchronous = Number(row.synchronous ?? Object.values(row)[0]);
  } catch (err) {
    return fail(`durability_probe_failed:${err.message}`);
  }
  if (journalMode !== 'wal') return fail('durability_not_wal', { journalMode });
  if (synchronous !== 2) return fail('durability_not_full', { synchronous });
  return { ok: true, journalMode, synchronous };
}

/**
 * Objects whose INSTALLED DEFINITION must be verified, not merely assumed to
 * exist. The fingerprint is a substring that must appear in the stored SQL.
 */
const REQUIRED_SCHEMA_SHAPE = Object.freeze([
  ['telegram_transport_claims', 'attempt_nonce'],
  ['telegram_transport_claims', "state IN ('claimed', 'delivery_started'"],
  ['telegram_transport_claims', 'delivered_prompt_sha256'],
  ['idx_tg_claims_exclusive', "WHERE state != 'closed_unsent'"],
  ['telegram_obligation_bindings', 'hook_parent_process_id'],
  ['telegram_obligation_bindings', 'claim_id'],
  ['telegram_queue_ack_outbox', 'appended_at_ms'],
  // The identity tables promotion now joins. A build that predates them must
  // read as STALE rather than silently admitting with the tuple unchecked.
  ['telegram_pane_launches', "state IN ('launching', 'complete')"],
  ['telegram_consumer_sessions', 'launch_id'],
  ['telegram_admission_receipts', "schema_name = 'telegram_admission.v1'"],
  ['telegram_admission_receipts', 'record_json'],
]);

/**
 * `CREATE TABLE IF NOT EXISTS` DOES NOTHING WHEN A TABLE ALREADY EXISTS WITH A
 * DIFFERENT SHAPE — it does not compare, it just returns.
 *
 * So a stale table from an older build passes silently and every test above it
 * runs green against the wrong structure. That is the same defect as
 * `!== undefined` letting an absent schema through, as `Number(null)` reading
 * as a fresh zero, and as A1's private tables passing 56/56 while the kernel
 * held no debt: A DECLARATION ACCEPTED IN PLACE OF A VERIFIED EFFECT.
 *
 * This reads `sqlite_master` and compares what is actually installed.
 */
function verifyInstalledSchema(db) {
  const missing = [];
  for (const [name, fingerprint] of REQUIRED_SCHEMA_SHAPE) {
    let row;
    try {
      row = db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(name);
    } catch (err) {
      return fail(`schema_probe_failed:${err.message}`);
    }
    if (!row || !row.sql) { missing.push(`${name}:absent`); continue; }
    if (!String(row.sql).includes(fingerprint)) missing.push(`${name}:stale`);
  }
  if (missing.length > 0) return fail('schema_shape_mismatch', { missing });
  return { ok: true };
}

/**
 * Telegram-specific tables only. The REAL evidence-ledger schema is the
 * caller's responsibility; these REFERENCE it rather than shadowing it.
 *
 * Returns a FAILURE if the installed shape does not match after creation, so a
 * pre-existing stale table cannot be mistaken for a fresh one.
 */
function applyTelegramAdmissionSchema(db) {
  // A STALE TABLE MAKES CREATION THROW, not merely no-op: the index and
  // dependent DDL reference columns the old shape does not have. Caught and
  // returned structurally so callers get a diagnosis instead of a stack trace,
  // and so "stale schema" is a reportable state rather than a crash.
  try {
    applyTelegramAdmissionSchemaDdl(db);
  } catch (err) {
    return fail('schema_apply_failed', { message: err.message });
  }
  // The launch/session/receipt identity tables are part of the SAME schema unit:
  // promotion joins them, so a database carrying one half is not usable.
  const registry = applyLaunchRegistrySchema(db);
  if (!registry.ok) return registry;
  const verified = verifyInstalledSchema(db);
  if (!verified.ok) return verified;
  return { ok: true, schemaVersion: SCHEMA_VERSION };
}

function applyTelegramAdmissionSchemaDdl(db) {
  db.exec(`
    PRAGMA foreign_keys=ON;

    CREATE TABLE IF NOT EXISTS telegram_transport_claims (
      claim_id               TEXT    PRIMARY KEY,
      cutover_id             TEXT    NOT NULL,
      route_key              TEXT    NOT NULL,
      update_id              INTEGER NOT NULL,
      source_row_id          INTEGER NOT NULL REFERENCES comms_journal(row_id),
      app_generation         TEXT    NOT NULL,
      pane_launch_id         TEXT    NOT NULL,
      pane_id                TEXT    NOT NULL,
      role                   TEXT    NOT NULL,
      consumer_runtime       TEXT    NOT NULL,
      attempt_nonce          TEXT    NOT NULL,
      attempt_at_ms          INTEGER NOT NULL,
      -- WHAT THE DRAIN ACTUALLY WROTE TO THE PANE, recorded at the moment the
      -- pane write is authorised. This is the SENDER half of the
      -- truncated-but-acked defence: the hook records what it RECEIVED, this
      -- records what we SENT, and promotion refuses unless they are the same
      -- bytes. Without it the consumer's digest has nothing to be compared to
      -- and deliveredPromptSha256 is a number we carry but never check.
      -- NULL until delivery starts; a claim is not yet a delivery.
      delivered_prompt_sha256 TEXT,
      delivered_prompt_bytes  INTEGER,
      -- LEGAL STATES ENFORCED BY THE DATABASE, not only by the code that
      -- writes them. An application-only state machine is a convention.
      state                  TEXT    NOT NULL CHECK (
        state IN ('claimed', 'delivery_started', 'closed_unsent', 'admitted')
      ),
      closed_at_ms           INTEGER
    );

    -- Partial unique index, not a table constraint: a claim closed as provably
    -- unsent must RELEASE the slot while KEEPING its audit row and events.
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
      obligation_id                 TEXT    PRIMARY KEY REFERENCES obligations(obligation_id),
      source_row_id                 INTEGER NOT NULL UNIQUE REFERENCES comms_journal(row_id),
      -- CLAIM PROVENANCE. The binding must name the attempt it came from, or
      -- there is no path from the debt back to the delivery that created it.
      claim_id                      TEXT    NOT NULL REFERENCES telegram_transport_claims(claim_id),
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
      -- UNIQUE: one admission receipt cannot own two bindings.
      admission_id                  TEXT    NOT NULL UNIQUE,
      attempt_nonce                 TEXT    NOT NULL,
      app_generation                TEXT    NOT NULL,
      pane_launch_id                TEXT    NOT NULL,
      pane_id                       TEXT    NOT NULL,
      role                          TEXT    NOT NULL,
      consumer_runtime              TEXT    NOT NULL,
      hook_process_id               TEXT    NOT NULL,
      hook_parent_process_id        TEXT    NOT NULL,
      consumer_session_id           TEXT    NOT NULL,
      runtime_submission_id         TEXT    NOT NULL,
      runtime_submission_kind       TEXT    NOT NULL,
      obligor_address               TEXT    NOT NULL,
      queue_ack_intent              TEXT    NOT NULL,
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

    -- THE QUEUE-ACK OUTBOX. This is the TRANSPORT ack intent, not a reply
    -- intent — A1 called it "telegram_outbound_intents / reserved_none", which
    -- read as a reply reservation that had not happened. Reply-group outbound
    -- intent begins in checkpoint C, before the API call.
    CREATE TABLE IF NOT EXISTS telegram_queue_ack_outbox (
      obligation_id   TEXT    PRIMARY KEY REFERENCES telegram_obligation_bindings(obligation_id),
      source_row_id   INTEGER NOT NULL UNIQUE REFERENCES comms_journal(row_id),
      update_id       INTEGER NOT NULL,
      route_key       TEXT    NOT NULL,
      state           TEXT    NOT NULL,
      created_at_ms   INTEGER NOT NULL,
      appended_at_ms  INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_tg_claims_state ON telegram_transport_claims(state);
    CREATE INDEX IF NOT EXISTS idx_tg_bind_state   ON telegram_obligation_bindings(state);
  `);
  return { ok: true };
}

function begin(db) { db.exec('BEGIN IMMEDIATE'); }
function commit(db) { db.exec('COMMIT'); }
function rollback(db) { try { db.exec('ROLLBACK'); } catch { /* already unwound */ } }

function readSourceIdentity(row) {
  let parsed = {};
  try { parsed = JSON.parse(row.metadata_json || '{}'); } catch { parsed = {}; }
  const block = parsed && typeof parsed === 'object' ? parsed[SOURCE_METADATA_KEY] : null;
  return block && typeof block === 'object' ? block : null;
}

/**
 * STEP 2: insert or verify the IMMUTABLE INBOUND COMMS ROW.
 *
 * Bypasses the generic comms upsert deliberately — that path would happily
 * rewrite an existing row — and writes NO `expects`, so recording a source
 * cannot create phantom debt. Debt is created exactly once, later, inside the
 * ownership transaction.
 *
 * Returns the REAL `comms_journal.row_id` and the obligation id derived from
 * it, which is the id the kernel's own foreign key will point at.
 */
function recordImmutableSource(db, input = {}) {
  const durable = assertDurableHandle(db);
  if (!durable.ok) return durable;

  const required = [
    'messageId', 'routeKey', 'profile', 'windowKey', 'rawBody',
    'canonicalPayloadSha256', 'cutoverId', 'obligorAddress',
  ];
  for (const field of required) {
    if (!isNonEmptyString(input[field])) return fail(`source_field_missing:${field}`);
  }
  if (!isScalarIdentity(input.chatId)) return fail('source_field_missing:chatId');
  if (!Number.isSafeInteger(input.updateId) || input.updateId <= 0) {
    return fail('source_field_missing:updateId');
  }
  const recordedAtMs = Number(input.recordedAtMs);
  if (!Number.isSafeInteger(recordedAtMs) || recordedAtMs <= 0) {
    return fail('source_field_missing:recordedAtMs');
  }
  // Digests validated AT THE STORAGE BOUNDARY. A malformed hash accepted here
  // becomes an identity that nothing can ever match.
  if (!SHA256_RE.test(String(input.canonicalPayloadSha256))) {
    return fail('source_digest_malformed:canonicalPayloadSha256');
  }
  if (input.mediaIdentitySha256 !== undefined && input.mediaIdentitySha256 !== null
    && !SHA256_RE.test(String(input.mediaIdentitySha256))) {
    return fail('source_digest_malformed:mediaIdentitySha256');
  }

  const identity = {
    updateId: input.updateId,
    chatId: String(input.chatId),
    routeKey: input.routeKey,
    profile: input.profile,
    windowKey: input.windowKey,
    canonicalPayloadSha256: input.canonicalPayloadSha256,
    mediaIdentitySha256: isNonEmptyString(input.mediaIdentitySha256)
      ? input.mediaIdentitySha256 : sha256(''),
    cutoverId: input.cutoverId,
    obligorAddress: input.obligorAddress,
  };
  const rawBodySha256 = sha256(input.rawBody);

  begin(db);
  try {
    const existing = db.prepare('SELECT * FROM comms_journal WHERE message_id = ?')
      .get(input.messageId);

    if (existing) {
      if (existing.channel !== 'telegram' || existing.direction !== 'inbound') {
        rollback(db);
        return fail('source_not_inbound_telegram', {
          channel: existing.channel, direction: existing.direction,
        });
      }
      if (String(existing.raw_body) !== String(input.rawBody)
        || String(existing.body_hash) !== rawBodySha256) {
        rollback(db);
        return fail('source_identity_conflict', { column: 'raw_body' });
      }
      const storedIdentity = readSourceIdentity(existing);
      if (!storedIdentity) { rollback(db); return fail('source_identity_missing'); }
      for (const field of SOURCE_IDENTITY_FIELDS) {
        if (String(storedIdentity[field]) !== String(identity[field])) {
          rollback(db);
          return fail('source_identity_conflict', {
            column: field, stored: storedIdentity[field], offered: identity[field],
          });
        }
      }
      commit(db);
      return {
        ok: true,
        sourceRowId: existing.row_id,
        obligationId: storedIdentity.obligationId,
        created: false,
      };
    }

    // NO `expects`: recording a source is not an obligation.
    db.prepare(`
      INSERT INTO comms_journal (
        message_id, session_id, sender_role, target_role, channel, direction,
        sent_at_ms, raw_body, body_hash, body_bytes, status, attempt,
        metadata_json, updated_at_ms
      ) VALUES (?, ?, ?, ?, 'telegram', 'inbound', ?, ?, ?, ?, 'recorded', 1, ?, ?)
    `).run(
      input.messageId,
      isNonEmptyString(input.sessionId) ? input.sessionId : null,
      'user',
      input.obligorAddress,
      recordedAtMs,
      input.rawBody,
      rawBodySha256,
      Buffer.byteLength(String(input.rawBody), 'utf8'),
      JSON.stringify({ [SOURCE_METADATA_KEY]: identity }),
      recordedAtMs
    );

    const sourceRowId = Number(
      db.prepare('SELECT row_id FROM comms_journal WHERE message_id = ?')
        .get(input.messageId).row_id
    );

    // FIXED NULL KERNEL LEASE, keyed to the REAL comms row id so the kernel's
    // own foreign key resolves. Telegram work leases never enter this.
    const obligationId = buildObligationId({
      createdFromRowId: sourceRowId,
      creditorAddress: 'james',
      obligorAddress: input.obligorAddress,
      expectedClass: 'answer',
      stalenessClass: 'turn',
    });

    db.prepare('UPDATE comms_journal SET metadata_json = ? WHERE row_id = ?')
      .run(JSON.stringify({ [SOURCE_METADATA_KEY]: { ...identity, obligationId } }), sourceRowId);

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
 * FK EXISTENCE IS NOT CORRELATION. A1 accepted a claim whose cutover/route/
 * update disagreed with the source row it pointed at, because a foreign key
 * only proves the row exists. The claim is now joined to the source's own
 * recorded identity at acquisition, and re-verified at promotion.
 */
function claimTransportAttempt(db, input = {}) {
  const durable = assertDurableHandle(db);
  if (!durable.ok) return durable;

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

  // THE CLAIM ID BINDS SOURCE ROW AND ATTEMPT TIME. Without them a reused key
  // or nonce pointing at a different source, or replayed at a different time,
  // hashed to the same id and was called idempotent.
  const claimId = `tgc_${sha256(canonicalJoin([
    input.cutoverId, input.routeKey, String(input.updateId), input.attemptNonce,
    String(input.sourceRowId), String(attemptAtMs),
  ]))}`;

  begin(db);
  try {
    const source = db.prepare('SELECT * FROM comms_journal WHERE row_id = ?')
      .get(input.sourceRowId);
    if (!source) { rollback(db); return fail('source_row_missing'); }
    const identity = readSourceIdentity(source);
    if (!identity) { rollback(db); return fail('source_identity_missing'); }
    // EXACT SOURCE JOIN, not mere referential existence.
    if (String(identity.cutoverId) !== String(input.cutoverId)
      || String(identity.routeKey) !== String(input.routeKey)
      || Number(identity.updateId) !== Number(input.updateId)) {
      rollback(db);
      return fail('claim_source_correlation_mismatch', {
        sourceCutover: identity.cutoverId,
        sourceRoute: identity.routeKey,
        sourceUpdateId: identity.updateId,
      });
    }

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
        && existing.attempt_nonce === input.attemptNonce
        && Number(existing.source_row_id) === Number(input.sourceRowId)
        && Number(existing.attempt_at_ms) === Number(attemptAtMs);

      if (sameClaimant) {
        commit(db);
        return { ok: true, claimId: existing.claim_id, state: existing.state, created: false };
      }
      // NEVER STOLEN. No timer, no grace, no age heuristic.
      rollback(db);
      return fail('claim_held_by_other', {
        heldClaimId: existing.claim_id, heldState: existing.state,
      });
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
    // CLASSIFY SPECIFICALLY. A1 mapped EVERY constraint failure — foreign key
    // violations included — onto `claim_held_by_other`, which would report a
    // broken reference as a lost race and send the caller to wait for a claim
    // that does not exist.
    if (/FOREIGN KEY/i.test(err.message)) {
      return fail('claim_foreign_key_violation', { message: err.message });
    }
    if (/CHECK constraint/i.test(err.message)) {
      return fail('claim_check_constraint_violation', { message: err.message });
    }
    if (/UNIQUE constraint/i.test(err.message)) {
      return fail('claim_held_by_other', { raceLost: true });
    }
    return fail(`claim_failed:${err.message}`);
  }
}

/**
 * The durable `delivery_started` event. ONLY AFTER THIS MAY A PANE WRITE BEGIN.
 *
 * EXPLICIT STATE TABLE, no fall-through. A1 mutated only from `claimed` and let
 * every other state fall out of the bottom as a fabricated success — so an
 * already-ADMITTED claim was told "delivery_started", which would authorise a
 * second pane write for a message already delivered. A fall-through returning
 * success is the fail-open shape in a state machine.
 */
function recordDeliveryStarted(db, input = {}) {
  const durable = assertDurableHandle(db);
  if (!durable.ok) return durable;

  if (!isNonEmptyString(input.claimId)) return fail('delivery_started_field_missing:claimId');
  const atMs = Number(input.atMs);
  if (!Number.isSafeInteger(atMs) || atMs <= 0) return fail('delivery_started_field_missing:atMs');

  // THE EXACT BYTES BEING WRITTEN TO THE PANE. Required, because promotion
  // compares them against what the consumer says it received, and a delivery
  // that cannot say what it sent can never be contradicted by the consumer.
  if (!isNonEmptyString(input.deliveredPromptSha256)) {
    return fail('delivery_started_field_missing:deliveredPromptSha256');
  }
  if (!SHA256_RE.test(String(input.deliveredPromptSha256))) {
    return fail('delivery_started_digest_malformed:deliveredPromptSha256');
  }
  const deliveredPromptBytes = Number(input.deliveredPromptBytes);
  if (!Number.isSafeInteger(deliveredPromptBytes) || deliveredPromptBytes < 0) {
    return fail('delivery_started_field_missing:deliveredPromptBytes');
  }

  begin(db);
  try {
    const claim = db.prepare('SELECT * FROM telegram_transport_claims WHERE claim_id = ?')
      .get(input.claimId);
    if (!claim) { rollback(db); return fail('claim_not_found'); }

    switch (claim.state) {
      case CLAIM_STATES.CLAIMED:
        db.prepare(`
          UPDATE telegram_transport_claims
          SET state = ?, delivered_prompt_sha256 = ?, delivered_prompt_bytes = ?
          WHERE claim_id = ?
        `).run(
          CLAIM_STATES.DELIVERY_STARTED, input.deliveredPromptSha256,
          deliveredPromptBytes, input.claimId
        );
        db.prepare('INSERT INTO telegram_transport_events (claim_id, kind, at_ms, detail) VALUES (?, ?, ?, ?)')
          .run(input.claimId, 'delivery_started', atMs, input.detail ?? null);
        commit(db);
        return { ok: true, claimId: input.claimId, state: CLAIM_STATES.DELIVERY_STARTED, created: true };

      case CLAIM_STATES.DELIVERY_STARTED: {
        // IDEMPOTENCY IS EXACT, NOT APPROXIMATE. A second delivery_started for
        // the same claim carrying DIFFERENT bytes is not a replay, it is a
        // second delivery — and silently keeping the first digest would let the
        // pane be written twice while promotion still validates against the
        // original. Conflicting time or detail is rejected for the same reason.
        if (String(claim.delivered_prompt_sha256) !== String(input.deliveredPromptSha256)
          || Number(claim.delivered_prompt_bytes) !== deliveredPromptBytes) {
          rollback(db);
          return fail('delivery_payload_conflict', {
            stored: claim.delivered_prompt_sha256,
            offered: input.deliveredPromptSha256,
          });
        }
        const priorRow = db.prepare(`
          SELECT at_ms, detail FROM telegram_transport_events
          WHERE claim_id = ? AND kind = 'delivery_started'
          ORDER BY event_id ASC LIMIT 1
        `).get(input.claimId);
        if (priorRow) {
          if (Number(priorRow.at_ms) !== atMs) {
            rollback(db);
            return fail('delivery_replay_time_conflict', {
              stored: priorRow.at_ms, offered: atMs,
            });
          }
          if (String(priorRow.detail ?? '') !== String(input.detail ?? '')) {
            rollback(db);
            return fail('delivery_replay_detail_conflict', {
              stored: priorRow.detail, offered: input.detail ?? null,
            });
          }
        }
        commit(db);
        return { ok: true, claimId: input.claimId, state: CLAIM_STATES.DELIVERY_STARTED, created: false };
      }

      case CLAIM_STATES.ADMITTED:
        // ALREADY ADMITTED MEANS NO PANE WRITE, reported explicitly rather than
        // dressed up as a fresh delivery.
        rollback(db);
        return fail('claim_already_admitted', { state: claim.state });

      case CLAIM_STATES.CLOSED_UNSENT:
        rollback(db);
        return fail('claim_closed', { state: claim.state });

      default:
        rollback(db);
        return fail('claim_state_unknown', { state: claim.state });
    }
  } catch (err) {
    rollback(db);
    return fail(`delivery_started_failed:${err.message}`);
  }
}

/** Close a claim that is PROVABLY UNSENT. Permitted only from `claimed`. */
function closeUnsentClaim(db, input = {}) {
  const durable = assertDurableHandle(db);
  if (!durable.ok) return durable;

  if (!isNonEmptyString(input.claimId)) return fail('close_field_missing:claimId');
  if (!isNonEmptyString(input.reason)) return fail('close_field_missing:reason');
  const atMs = Number(input.atMs);
  if (!Number.isSafeInteger(atMs) || atMs <= 0) return fail('close_field_missing:atMs');

  begin(db);
  try {
    const claim = db.prepare('SELECT * FROM telegram_transport_claims WHERE claim_id = ?')
      .get(input.claimId);
    if (!claim) { rollback(db); return fail('claim_not_found'); }
    if (claim.state !== CLAIM_STATES.CLAIMED) {
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
 * STEP 5: `admitted_owned`. ONE transaction across FOUR authorities.
 *
 * Promotes the real comms row to `brokered`, creates the REAL kernel
 * obligation, its REAL ledger created-event, the immutable Telegram binding,
 * the queue-ack outbox intent, and the initial work generation. All commit or
 * none does — and "all" now means the general kernel actually holds the debt,
 * which is the whole correction from A1.
 */
function promoteToAdmittedOwned(db, input = {}, store = null) {
  const durable = assertDurableHandle(db);
  if (!durable.ok) return durable;

  // THE CANONICAL KERNEL PRIMITIVE MUST RUN ON THIS EXACT HANDLE.
  //
  // A store pointed at the same FILE is not the same CONNECTION: its writes
  // would land in a different transaction, so a rollback here would leave the
  // obligation committed and the binding gone. Identity of the handle is the
  // only thing that makes "one atomic transition across four authorities" true,
  // so it is checked rather than assumed.
  if (!store || typeof store.createObligationInCallerTransaction !== 'function') {
    return fail('owned_store_required');
  }
  if (store.db !== db) return fail('owned_store_handle_mismatch');

  // NOTE WHAT IS NO LONGER ACCEPTED HERE. `consumerSessionId`,
  // `runtimeSubmissionId`, `runtimeSubmissionKind`, `hookProcessId` and
  // `hookParentProcessId` used to be caller-supplied strings, and any non-empty
  // value passed. They are now READ FROM THE DURABLE ADMISSION RECEIPT below.
  // A caller cannot assert who consumed the message; only the consumer's own
  // record can, which is the entire substance of this checkpoint.
  const required = ['messageId', 'claimId', 'admissionId', 'obligorAddress', 'queueAckIntent'];
  for (const field of required) {
    if (!isNonEmptyString(input[field])) return fail(`owned_field_missing:${field}`);
  }
  // JAMES IS THE CREDITOR, NEVER THE OBLIGOR, and it is refused HERE rather
  // than being left to the kernel's own CHECK further down: by then a source row
  // has already been exposed carrying a doomed obligation id.
  if (String(input.obligorAddress).trim().toLowerCase() === 'james') {
    return fail('james_obligor_forbidden');
  }
  const atMs = Number(input.atMs);
  if (!Number.isSafeInteger(atMs) || atMs <= 0) return fail('owned_field_missing:atMs');
  if (input.canonicalPayloadSha256 !== undefined && input.canonicalPayloadSha256 !== null
    && !SHA256_RE.test(String(input.canonicalPayloadSha256))) {
    return fail('owned_digest_malformed:canonicalPayloadSha256');
  }
  const predecessorManifestSha256 = isNonEmptyString(input.predecessorManifestSha256)
    ? input.predecessorManifestSha256 : sha256('');
  if (!SHA256_RE.test(predecessorManifestSha256)) {
    return fail('owned_digest_malformed:predecessorManifestSha256');
  }

  begin(db);
  try {
    const source = db.prepare('SELECT * FROM comms_journal WHERE message_id = ?')
      .get(input.messageId);
    if (!source) { rollback(db); return fail('source_row_missing'); }
    const identity = readSourceIdentity(source);
    if (!identity) { rollback(db); return fail('source_identity_missing'); }

    const claim = db.prepare('SELECT * FROM telegram_transport_claims WHERE claim_id = ?')
      .get(input.claimId);
    if (!claim) { rollback(db); return fail('claim_not_found'); }
    if (claim.source_row_id !== source.row_id) {
      rollback(db); return fail('claim_source_mismatch');
    }
    // RE-VERIFY correlation, not just the FK.
    if (String(claim.cutover_id) !== String(identity.cutoverId)
      || String(claim.route_key) !== String(identity.routeKey)
      || Number(claim.update_id) !== Number(identity.updateId)) {
      rollback(db); return fail('claim_source_correlation_mismatch');
    }
    if (claim.state !== CLAIM_STATES.DELIVERY_STARTED && claim.state !== CLAIM_STATES.ADMITTED) {
      rollback(db); return fail('claim_not_delivery_started', { state: claim.state });
    }
    // The obligor that hashed the id must be the obligor being promoted.
    if (String(identity.obligorAddress) !== String(input.obligorAddress)) {
      rollback(db);
      return fail('obligor_mismatch', {
        stored: identity.obligorAddress, offered: input.obligorAddress,
      });
    }
    if (isNonEmptyString(input.canonicalPayloadSha256)
      && identity.canonicalPayloadSha256 !== input.canonicalPayloadSha256) {
      rollback(db); return fail('source_payload_digest_mismatch');
    }

    // ===================================================================
    // CANONICAL SOURCE RE-VERIFICATION.
    //
    // The metadata block is DIAGNOSTIC. It lives under a generic
    // `metadata_json` key that the ordinary comms upsert can rewrite, so
    // trusting it as the sole authority means a mutated blob can mint an
    // obligation id the kernel would never derive. The canonical columns are
    // the authority, and they are checked against it here.
    // ===================================================================
    if (String(source.channel) !== 'telegram' || String(source.direction) !== 'inbound') {
      rollback(db);
      return fail('source_not_inbound_telegram', {
        channel: source.channel, direction: source.direction,
      });
    }
    if (String(source.sender_role) !== 'user') {
      rollback(db); return fail('source_sender_not_user', { senderRole: source.sender_role });
    }
    // CANONICAL TARGET IS THE OBLIGOR. Not a metadata field that agrees with one.
    if (String(source.target_role) !== String(input.obligorAddress)) {
      rollback(db);
      return fail('source_target_not_obligor', {
        targetRole: source.target_role, obligor: input.obligorAddress,
      });
    }
    if (String(source.status) !== SOURCE_STATES.RECORDED
      && String(source.status) !== SOURCE_STATES.BROKERED) {
      rollback(db); return fail('source_status_unexpected', { status: source.status });
    }
    if (String(source.body_hash) !== sha256(source.raw_body)) {
      rollback(db); return fail('source_body_hash_mismatch');
    }
    if (Number(source.body_bytes) !== Buffer.byteLength(String(source.raw_body ?? ''), 'utf8')) {
      rollback(db); return fail('source_body_bytes_mismatch');
    }
    // NO PHANTOM DEBT. Recording a source must never have declared an
    // expectation; the one obligation is created below, exactly once.
    let sourceMetadata = {};
    try { sourceMetadata = JSON.parse(source.metadata_json || '{}'); } catch { sourceMetadata = {}; }
    if (sourceMetadata && typeof sourceMetadata === 'object'
      && (sourceMetadata.expects || (sourceMetadata.envelope && sourceMetadata.envelope.expects))) {
      rollback(db); return fail('source_carries_expects');
    }
    // RECOMPUTE THE OBLIGATION ID from canonical inputs. A stored id that does
    // not re-derive is a mutated blob, not an identity.
    const recomputedObligationId = buildObligationId({
      createdFromRowId: source.row_id,
      creditorAddress: 'james',
      obligorAddress: String(source.target_role),
      expectedClass: 'answer',
      stalenessClass: 'turn',
    });
    if (String(identity.obligationId) !== recomputedObligationId) {
      rollback(db);
      return fail('source_obligation_id_not_derivable', {
        stored: identity.obligationId, recomputed: recomputedObligationId,
      });
    }
    // THE CLAIM'S ROLE IS THE CANONICAL TARGET. A claim held by some other role
    // cannot admit this message on that role's behalf.
    if (String(claim.role) !== String(source.target_role)) {
      rollback(db);
      return fail('claim_role_not_target', {
        claimRole: claim.role, targetRole: source.target_role,
      });
    }

    // ===================================================================
    // THE ADMISSION RECEIPT. THIS IS THE SUBSTANCE OF THE CHECKPOINT.
    //
    // `admissionId` used to be any non-empty string, and so did the session,
    // submission and process ids beside it. Promotion therefore asserted that a
    // consumer had admitted the message on the strength of the CALLER saying
    // so — the same shape as an ack that fires because a write returned, or a
    // runner that reports running because a status file says so.
    //
    // Now a REAL `telegram_admission.v1` row is loaded and the whole tuple is
    // joined: queue source, transport claim, pane-launch registry, session
    // binding, pane/role/runtime, hook process and parent, submission kind and
    // admission time. Then `validateAdmissionRecord` — which existed through
    // two checkpoints with no caller at all — actually runs on it.
    // ===================================================================
    const receiptLoad = loadAdmissionReceipt(db, input.admissionId);
    if (!receiptLoad.ok) { rollback(db); return receiptLoad; }
    const { row: receipt, record: admissionRecord, launch, session } = receiptLoad;

    if (Number(receipt.source_row_id) !== Number(source.row_id)) {
      rollback(db);
      return fail('admission_source_mismatch', {
        receiptSourceRowId: receipt.source_row_id, sourceRowId: source.row_id,
      });
    }
    if (String(receipt.claim_id) !== String(input.claimId)) {
      rollback(db);
      return fail('admission_claim_mismatch', {
        receiptClaimId: receipt.claim_id, claimId: input.claimId,
      });
    }
    // A HALF-BUILT LAUNCH CANNOT VOUCH FOR A CONSUMER.
    if (String(launch.state) !== LAUNCH_STATES.COMPLETE) {
      rollback(db); return fail('admission_launch_incomplete', { state: launch.state });
    }
    if (String(session.launch_id) !== String(launch.launch_id)) {
      rollback(db);
      return fail('admission_session_launch_mismatch', {
        sessionLaunch: session.launch_id, launch: launch.launch_id,
      });
    }
    // THE LAUNCH MUST BE THE ONE THE CLAIM WAS MADE UNDER. This is the join that
    // `launch-1` could never have failed, because nothing produced launch ids at
    // all and every value was equally fictional.
    if (String(claim.pane_launch_id) !== String(launch.launch_id)) {
      rollback(db);
      return fail('admission_launch_not_claimed', {
        claimLaunch: claim.pane_launch_id, receiptLaunch: launch.launch_id,
      });
    }
    for (const [column, claimValue, launchValue] of [
      ['pane_id', claim.pane_id, launch.pane_id],
      ['role', claim.role, launch.role],
      ['consumer_runtime', claim.consumer_runtime, launch.consumer_runtime],
      ['app_generation', claim.app_generation, launch.app_generation],
    ]) {
      if (String(claimValue) !== String(launchValue)) {
        rollback(db);
        return fail('admission_launch_identity_mismatch', {
          column, claim: claimValue, launch: launchValue,
        });
      }
    }
    if (!Object.values(SUBMISSION_KINDS).includes(String(receipt.runtime_submission_kind))) {
      rollback(db);
      return fail('admission_submission_kind_invalid', {
        kind: receipt.runtime_submission_kind,
      });
    }
    if (!isNonEmptyString(String(receipt.hook_process_id ?? ''))
      || !isNonEmptyString(String(receipt.hook_parent_process_id ?? ''))) {
      rollback(db); return fail('admission_hook_process_identity_missing');
    }

    // THE VALIDATOR, ON THE VERBATIM RECORD, AGAINST THE JOINED TUPLE.
    // `expected` is assembled from the CANONICAL authorities — never from the
    // record being judged, which would make the comparison self-satisfying.
    const proofCheck = validateAdmissionRecord({
      proof: admissionRecord,
      expected: {
        updateId: identity.updateId,
        messageId: source.message_id,
        routeKey: identity.routeKey,
        windowKey: identity.windowKey,
        profile: identity.profile,
        chatId: identity.chatId,
        appGeneration: claim.app_generation,
        runtime: claim.consumer_runtime,
        consumerSessionId: receipt.consumer_session_id,
        paneId: claim.pane_id,
        queuedPayloadSha256: identity.canonicalPayloadSha256,
        // WHAT THE DRAIN RECORDED SENDING, not what the receipt claims arrived.
        deliveredPromptSha256: claim.delivered_prompt_sha256,
        deliveredPromptBytes: claim.delivered_prompt_bytes,
      },
      attempt: { atMs: claim.attempt_at_ms, generation: claim.app_generation },
    });
    if (!proofCheck.proven) {
      rollback(db);
      return fail('admission_receipt_invalid', { reason: proofCheck.reason });
    }

    // CAUSAL ORDERING. A promotion cannot predate the attempt it promotes, and
    // an attempt cannot predate the message it delivers. Without this a receipt
    // dated before its own source passes every identity check and still
    // describes something that could not have happened.
    const sourceAtMs = Number(source.sent_at_ms);
    const startedRow = db.prepare(`
      SELECT MIN(at_ms) AS at_ms FROM telegram_transport_events
      WHERE claim_id = ? AND kind = 'delivery_started'
    `).get(input.claimId);
    const startedAtMs = Number(startedRow && startedRow.at_ms);
    if (Number.isFinite(sourceAtMs) && Number(claim.attempt_at_ms) < sourceAtMs) {
      rollback(db); return fail('causal_order_violation:attempt_before_source');
    }
    if (Number.isFinite(startedAtMs) && startedAtMs < Number(claim.attempt_at_ms)) {
      rollback(db); return fail('causal_order_violation:delivery_before_attempt');
    }
    if (Number.isFinite(startedAtMs) && atMs < startedAtMs) {
      rollback(db); return fail('causal_order_violation:admission_before_delivery');
    }
    // THE RECEIPT'S OWN TIME sits in the same causal chain. A consumer cannot
    // have admitted bytes before the drain began writing them, and the
    // promotion cannot predate the receipt it is promoting on.
    const admittedAtMs = Number(receipt.admitted_at_ms);
    if (Number.isFinite(startedAtMs) && admittedAtMs < startedAtMs) {
      rollback(db); return fail('causal_order_violation:admission_receipt_before_delivery');
    }
    if (atMs < admittedAtMs) {
      rollback(db); return fail('causal_order_violation:promotion_before_admission');
    }
    // The launch must predate the session it carries, and the session the
    // receipt written under it.
    if (Number(session.bound_at_ms) < Number(launch.launched_at_ms)) {
      rollback(db); return fail('causal_order_violation:session_before_launch');
    }
    if (admittedAtMs < Number(session.bound_at_ms)) {
      rollback(db); return fail('causal_order_violation:admission_before_session');
    }

    const obligationId = identity.obligationId;
    const existingBinding = db.prepare(
      'SELECT * FROM telegram_obligation_bindings WHERE obligation_id = ?'
    ).get(obligationId);

    const offered = {
      cutover_id: identity.cutoverId,
      update_id: identity.updateId,
      message_id: source.message_id,
      chat_id: identity.chatId,
      route_key: identity.routeKey,
      profile: identity.profile,
      window_key: identity.windowKey,
      raw_body_sha256: source.body_hash,
      canonical_payload_sha256: identity.canonicalPayloadSha256,
      predecessor_manifest_sha256: predecessorManifestSha256,
      admission_id: input.admissionId,
      attempt_nonce: claim.attempt_nonce,
      app_generation: claim.app_generation,
      pane_launch_id: claim.pane_launch_id,
      pane_id: claim.pane_id,
      role: claim.role,
      consumer_runtime: claim.consumer_runtime,
      // FROM THE RECEIPT, NOT FROM THE CALLER. These five columns are the
      // consumer's own account of itself; a caller offering them was the hole.
      hook_process_id: receipt.hook_process_id,
      hook_parent_process_id: receipt.hook_parent_process_id,
      consumer_session_id: receipt.consumer_session_id,
      runtime_submission_id: receipt.runtime_submission_id,
      runtime_submission_kind: receipt.runtime_submission_kind,
      obligor_address: input.obligorAddress,
      queue_ack_intent: input.queueAckIntent,
    };

    if (existingBinding) {
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
        obligationId,
        sourceRowId: source.row_id,
        workGeneration: existingBinding.work_generation,
        workLeaseToken: existingBinding.work_lease_token,
        created: false,
      };
    }

    const workLeaseToken = `tgl_${sha256(canonicalJoin([obligationId, '1', input.admissionId]))}`;

    // ===================================================================
    // 1+2. THE OBLIGATION AND ITS CREATED EVENT, THROUGH THE KERNEL'S OWN
    // PRIMITIVE.
    //
    // These were two hand-written INSERTs. The rows they produced were in the
    // right tables with the right columns, and they were still wrong: writing
    // `ledger_events` directly skips `validateObligationWritePayload`,
    // `prepareEventForStorage` and `_insertPrepared`, so the canonical
    // `obligation:<id>` trace and correlation, the evidence reference back to
    // the comms row, and the edge structure the kernel walks were all missing.
    // TABLE-REAL IS NOT KERNEL-CANONICAL, and a second copy of the SQL would
    // only re-create the divergence it was meant to fix.
    //
    // This runs on the caller's transaction — ours — so the four authorities
    // still commit or roll back together.
    // ===================================================================
    const creation = store.createObligationInCallerTransaction(
      { rowId: source.row_id, sessionId: source.session_id || null },
      {
        creditorAddress: 'james',
        obligorAddress: input.obligorAddress,
        expectedClass: 'answer',
        stalenessClass: 'turn',
        leaseId: null,
      },
      {
        creatorAddress: 'james',
        declarationMode: 'telegram-admission',
        nowMs: atMs,
      }
    );
    if (!creation || creation.ok !== true || !creation.obligation) {
      rollback(db);
      return fail('obligation_creation_failed', { status: creation && creation.status });
    }
    // THE KERNEL'S ID MUST BE THE ID WE BOUND TO. If these ever diverge, the
    // binding points at a debt that is not the one just created.
    if (String(creation.obligation.obligationId) !== String(obligationId)) {
      rollback(db);
      return fail('obligation_id_divergence', {
        kernel: creation.obligation.obligationId, source: obligationId,
      });
    }
    const createdEventId = creation.obligation.createdEventId;

    // 3. THE IMMUTABLE TELEGRAM BINDING.
    db.prepare(`
      INSERT INTO telegram_obligation_bindings (
        obligation_id, source_row_id, claim_id, cutover_id, update_id, message_id, chat_id,
        route_key, profile, window_key, raw_body_sha256, canonical_payload_sha256,
        predecessor_manifest_sha256, admission_id, attempt_nonce, app_generation,
        pane_launch_id, pane_id, role, consumer_runtime, hook_process_id,
        hook_parent_process_id, consumer_session_id, runtime_submission_id,
        runtime_submission_kind, obligor_address, queue_ack_intent,
        work_generation, work_lease_token, state, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      obligationId, source.row_id, input.claimId,
      offered.cutover_id, offered.update_id, offered.message_id,
      offered.chat_id, offered.route_key, offered.profile, offered.window_key,
      offered.raw_body_sha256, offered.canonical_payload_sha256,
      offered.predecessor_manifest_sha256, offered.admission_id, offered.attempt_nonce,
      offered.app_generation, offered.pane_launch_id, offered.pane_id, offered.role,
      offered.consumer_runtime, offered.hook_process_id, offered.hook_parent_process_id,
      offered.consumer_session_id, offered.runtime_submission_id,
      offered.runtime_submission_kind, offered.obligor_address, offered.queue_ack_intent,
      1, workLeaseToken, 'open', atMs
    );

    db.prepare('INSERT INTO telegram_binding_events (obligation_id, transition, at_ms, detail) VALUES (?, ?, ?, ?)')
      .run(obligationId, 'created', atMs, null);

    // 4. THE QUEUE-ACK OUTBOX INTENT (transport, not reply).
    db.prepare(`
      INSERT INTO telegram_queue_ack_outbox (
        obligation_id, source_row_id, update_id, route_key, state, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      obligationId, source.row_id, offered.update_id, offered.route_key,
      QUEUE_ACK_STATES.PENDING, atMs
    );

    // 5. PROMOTE THE REAL SOURCE ROW.
    db.prepare('UPDATE comms_journal SET status = ?, brokered_at_ms = ?, updated_at_ms = ? WHERE row_id = ?')
      .run(SOURCE_STATES.BROKERED, atMs, atMs, source.row_id);

    db.prepare('UPDATE telegram_transport_claims SET state = ? WHERE claim_id = ?')
      .run(CLAIM_STATES.ADMITTED, input.claimId);

    commit(db);
    return {
      ok: true, obligationId, sourceRowId: source.row_id,
      workGeneration: 1, workLeaseToken, createdEventId, created: true,
    };
  } catch (err) {
    rollback(db);
    return fail(`owned_promotion_failed:${err.message}`);
  }
}

module.exports = {
  SCHEMA_VERSION,
  SOURCE_METADATA_KEY,
  CLAIM_STATES,
  SOURCE_STATES,
  QUEUE_ACK_STATES,
  SOURCE_IDENTITY_FIELDS,
  BINDING_IDENTITY_COLUMNS,
  sha256,
  canonicalJoin,
  assertDurableHandle,
  verifyInstalledSchema,
  REQUIRED_SCHEMA_SHAPE,
  applyTelegramAdmissionSchema,
  recordImmutableSource,
  claimTransportAttempt,
  recordDeliveryStarted,
  closeUnsentClaim,
  promoteToAdmittedOwned,
};
