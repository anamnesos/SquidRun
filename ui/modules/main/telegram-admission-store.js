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

const BINDING_STATES = Object.freeze({
  OPEN: 'open',
  LAPSED: 'lapsed',
  ANSWERED: 'answered',
  RELEASED: 'released',
});

const WORK_CLAIM_STATES = Object.freeze({
  ACTIVE: 'work_active',
  CLOSED_ABORTED: 'work_closed_aborted',
  CLOSED_FULFILLED: 'work_closed_fulfilled',
});

/**
 * NAMED TRANSITIONS. The set IS the state machine.
 *
 * A2b put legal STATES in a CHECK constraint, which stops a nonsense value but
 * says nothing about legal MOVEMENT: `answered -> open` satisfies every CHECK
 * ever written. And the transitions themselves were plain `UPDATE`s, so two
 * coordinators could both read `open`, both decide to advance, and both
 * succeed — last writer wins, no conflict, no event, no trace that a decision
 * was overwritten.
 *
 * Every mover below is a compare-and-set on the state it believes it saw, plus
 * one append-only event. A losing coordinator gets a named conflict carrying
 * the state it actually found, which is a fact it can act on rather than a
 * silent no-op.
 */
const BINDING_TRANSITIONS = Object.freeze({
  binding_lapsed: { from: [BINDING_STATES.OPEN], to: BINDING_STATES.LAPSED },
  binding_answered: {
    from: [BINDING_STATES.OPEN, BINDING_STATES.LAPSED], to: BINDING_STATES.ANSWERED,
  },
  binding_released: {
    from: [BINDING_STATES.OPEN, BINDING_STATES.LAPSED], to: BINDING_STATES.RELEASED,
  },
});

const QUEUE_ACK_TRANSITIONS = Object.freeze({
  queue_ack_appended: {
    from: [QUEUE_ACK_STATES.PENDING], to: QUEUE_ACK_STATES.APPENDED,
  },
});

const WORK_CLAIM_TRANSITIONS = Object.freeze({
  work_aborted: {
    from: [WORK_CLAIM_STATES.ACTIVE], to: WORK_CLAIM_STATES.CLOSED_ABORTED,
  },
  work_fulfilled: {
    from: [WORK_CLAIM_STATES.ACTIVE], to: WORK_CLAIM_STATES.CLOSED_FULFILLED,
  },
});

const SHA256_RE = /^[0-9a-f]{64}$/;

/**
 * THE CUTOVER. One constant, deliberately not a timestamp and not a session.
 *
 * It names the regime in which the DB claim is the authoritative attempt latch.
 * Records that predate it — 808499316 above all — were attempted under the
 * legacy `delivery-attempts.jsonl` latch and can never grow a claim
 * retroactively; they are resolved by explicit pinned recovery, not by this
 * kernel deciding they look close enough.
 *
 * IT IS NOT DERIVED FROM ANYTHING MUTABLE ON PURPOSE. A cutover computed from
 * the clock, the generation or the schema version would silently change
 * identity across a restart, and the claim's uniqueness key (cutover, route,
 * update) would stop meaning "one attempt per message" the moment it moved.
 */
const TELEGRAM_CUTOVER_ID = 'tg-cutover-v1';

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
  ['telegram_queue_ack_outbox', 'ack_intent_key'],
  ['telegram_obligation_bindings', "state IN ('open', 'lapsed'"],
  ['telegram_source_identity', 'canonical_payload_sha256'],
  ['telegram_source_identity', 'source_session_id'],
  ['trg_tg_source_obligor_not_james', 'telegram_source_obligor_james_forbidden'],
  ['trg_tg_source_identity_immutable', 'telegram_source_identity_immutable'],
  ['trg_tg_source_identity_no_delete', 'telegram_source_identity_delete_forbidden'],
  // A2b proved schema shape but not schema ENFORCEMENT. A database carrying the
  // right columns and none of the triggers accepts every adversarial raw-SQL
  // rewrite below, so absence of a trigger is a stale schema, not a nicety.
  ['trg_tg_binding_identity_immutable', 'telegram_binding_identity_immutable'],
  ['trg_tg_binding_no_delete', 'telegram_binding_delete_forbidden'],
  ['trg_tg_binding_events_no_update', 'telegram_binding_events_append_only'],
  ['trg_tg_binding_events_no_delete', 'telegram_binding_events_append_only'],
  ['trg_tg_transport_events_no_update', 'telegram_transport_events_append_only'],
  ['trg_tg_transport_events_no_delete', 'telegram_transport_events_append_only'],
  ['trg_tg_work_events_no_update', 'telegram_work_claim_events_append_only'],
  ['trg_tg_work_events_no_delete', 'telegram_work_claim_events_append_only'],
  ['trg_tg_claim_identity_immutable', 'telegram_claim_identity_immutable'],
  // STATE MAY NOT MOVE BACKWARDS, AND NOTHING MAY CLOSE PAST A STORED D EVENT.
  // A build carrying the claim tables without these two is a build in which the
  // append-only event is advisory, which is the state Oracle #13 exploited.
  ['trg_tg_claim_state_monotonic', 'telegram_claim_state_not_monotonic'],
  ['trg_tg_claim_close_requires_no_delivery', 'telegram_claim_close_after_delivery_started'],
  // AND THE TUPLE MAY NOT BE RE-CLAIMED PAST A STORED D EVENT. Without this a
  // build reads a legacy closed_unsent+D slot as never-attempted and delivers a
  // second copy; the exclusive index cannot see it, because it ignores closed
  // rows on purpose.
  ['trg_tg_claim_insert_requires_no_prior_delivery', 'telegram_claim_insert_after_delivery_started'],
  ['trg_tg_work_identity_immutable', 'telegram_work_claim_identity_immutable'],
  ['trg_tg_work_no_delete', 'telegram_work_claim_delete_forbidden'],
  ['trg_tg_ack_identity_immutable', 'telegram_queue_ack_identity_immutable'],
  ['trg_tg_ack_no_delete', 'telegram_queue_ack_delete_forbidden'],
  ['telegram_work_claims', "state IN ('work_active'"],
  ['idx_tg_work_active', "WHERE state = 'work_active'"],
  ['telegram_work_claim_events', 'work_claim_id'],
  // The identity tables promotion now joins. A build that predates them must
  // read as STALE rather than silently admitting with the tuple unchecked.
  ['telegram_pane_launches', "state IN ('launching', 'complete')"],
  ['telegram_consumer_sessions', 'launch_id'],
  ['telegram_admission_receipts', "schema_name = 'telegram_admission.v1'"],
  ['telegram_admission_receipts', 'record_json'],
  ['trg_tg_launch_identity_immutable', 'telegram_launch_identity_immutable'],
  ['trg_tg_launch_no_delete', 'telegram_launch_delete_forbidden'],
  ['trg_tg_session_immutable', 'telegram_consumer_session_immutable'],
  ['trg_tg_session_no_delete', 'telegram_consumer_session_delete_forbidden'],
  ['trg_tg_receipt_immutable', 'telegram_admission_receipt_immutable'],
  ['trg_tg_receipt_no_delete', 'telegram_admission_receipt_delete_forbidden'],
  // THE TERMINAL TABLE. A build that predates it has an admission path and no
  // retirement authority at all, which is exactly the state that wedged the
  // live queue — so it must read as STALE here rather than as a database that
  // simply has not been written to yet.
  ['telegram_consumed_receipts', "schema_name = 'telegram_consumed.v1'"],
  // The duplicate-suppression constraint itself, not merely the column. This
  // table declares exactly one UNIQUE column, so its presence in the installed
  // SQL is a true fingerprint for "one admission may be terminated once".
  ['telegram_consumed_receipts', 'NOT NULL UNIQUE'],
  ['telegram_consumed_receipts', 'terminal_hook_parent_process_id'],
  ['telegram_consumed_receipts', "terminal_event IN ('turn_completed')"],
  ['trg_tg_consumed_immutable', 'telegram_consumed_receipt_immutable'],
  ['trg_tg_consumed_no_delete', 'telegram_consumed_receipt_delete_forbidden'],
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
function verifyInstalledSchema(db, names = null) {
  // A NAMED SUBSET, FILTERED FROM THE SAME TABLE. A reader that only needs the
  // claim tables must not be held to the whole kernel's shape — but it must not
  // hand-write its own fingerprints either, or the two copies drift and the
  // narrower one silently stops checking anything real.
  const required = Array.isArray(names)
    ? REQUIRED_SCHEMA_SHAPE.filter(([name]) => names.includes(name))
    : REQUIRED_SCHEMA_SHAPE;
  if (Array.isArray(names)) {
    const covered = new Set(required.map(([name]) => name));
    const unknown = names.filter((name) => !covered.has(name));
    // Asking about an object this table does not describe would verify nothing
    // while returning ok. Refuse the question instead of answering it emptily.
    if (unknown.length > 0) return fail('schema_probe_unknown_objects', { unknown });
  }
  const missing = [];
  for (const [name, fingerprint] of required) {
    let row;
    try {
      row = db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(name);
    } catch (err) {
      return fail(`schema_probe_failed:${err.message}`);
    }
    if (!row || !row.sql) { missing.push(`${name}:absent`); continue; }
    if (!String(row.sql).includes(fingerprint)) missing.push(`${name}:stale`);
  }
  if (missing.length > 0) {
    return fail('schema_shape_mismatch', {
      missing,
      // ABSENT AND STALE ARE DIFFERENT FACTS. Absent everywhere means this
      // kernel has never written here — a reader may honestly conclude the
      // record it is looking for does not exist. Anything stale means a table
      // is present in a shape we cannot trust, and a read over it would return
      // confident nonsense.
      allAbsent: missing.every((entry) => entry.endsWith(':absent')),
    });
  }
  return { ok: true };
}

/**
 * The objects a claim READ depends on. Exported so the drain's lookup verifies
 * the shape it actually uses without maintaining a second fingerprint list.
 */
const CLAIM_READ_SCHEMA_OBJECTS = Object.freeze([
  'telegram_transport_claims',
  'idx_tg_claims_exclusive',
  'trg_tg_claim_identity_immutable',
  'trg_tg_transport_events_no_update',
  'trg_tg_transport_events_no_delete',
  'telegram_source_identity',
  'trg_tg_source_identity_immutable',
]);

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

    -- ===================================================================
    -- THE IMMUTABLE SOURCE IDENTITY. ITS OWN TABLE, BECAUSE A BLOB IS NOT AN
    -- AUTHORITY.
    --
    -- Until A3b-2 every one of these fields lived in
    -- comms_journal.metadata_json and was READ AS AUTHORITY from there.
    -- recordImmutableSource bypasses the generic comms upsert on its own path,
    -- which stopped exactly nothing: any other writer, or one raw UPDATE, could
    -- rewrite that blob and the immutable source would change underneath
    -- everything that had already trusted it. A protection implemented as a
    -- convention on one code path is not a protection; it is a habit, and it
    -- holds only while everyone remembers which door to use.
    --
    -- So identity moves here, where uniqueness and immutability are properties
    -- of the DATA. The generic metadata block stays, and is now DIAGNOSTIC
    -- ONLY: nothing reads it to make a decision.
    --
    -- STATUS IS DELIBERATELY ABSENT. Status moves (recorded -> brokered);
    -- identity does not. Keeping them in one row would force the immutability
    -- trigger to allow an UPDATE, and the exception would swallow the rule.
    -- ===================================================================
    CREATE TABLE IF NOT EXISTS telegram_source_identity (
      source_row_id            INTEGER PRIMARY KEY REFERENCES comms_journal(row_id),
      message_id               TEXT    NOT NULL UNIQUE,
      cutover_id               TEXT    NOT NULL,
      update_id                INTEGER NOT NULL,
      route_key                TEXT    NOT NULL,
      profile                  TEXT    NOT NULL,
      window_key               TEXT    NOT NULL,
      chat_id                  TEXT    NOT NULL,
      canonical_payload_sha256 TEXT    NOT NULL,
      media_identity_sha256    TEXT    NOT NULL,
      raw_body_sha256          TEXT    NOT NULL,
      body_bytes               INTEGER NOT NULL,
      obligor_address          TEXT    NOT NULL,
      obligation_id            TEXT    NOT NULL,
      -- THE CANONICAL SESSION, bound rather than ignored. Existing-source
      -- replay compared everything except this, so the same message recorded
      -- under a different session replayed as identical.
      source_session_id        TEXT,
      recorded_at_ms           INTEGER NOT NULL,
      UNIQUE (cutover_id, route_key, update_id)
    );

    -- JAMES IS THE CREDITOR AND IS REJECTED BEFORE THE ROW EXISTS. Promotion
    -- already refused him, but by then a source row had been exposed carrying a
    -- doomed obligation id. The database refuses him at the door.
    CREATE TRIGGER IF NOT EXISTS trg_tg_source_obligor_not_james
    BEFORE INSERT ON telegram_source_identity
    FOR EACH ROW WHEN lower(trim(NEW.obligor_address)) = 'james'
    BEGIN SELECT RAISE(ABORT, 'telegram_source_obligor_james_forbidden'); END;

    CREATE TRIGGER IF NOT EXISTS trg_tg_source_identity_immutable
    BEFORE UPDATE ON telegram_source_identity
    BEGIN SELECT RAISE(ABORT, 'telegram_source_identity_immutable'); END;

    CREATE TRIGGER IF NOT EXISTS trg_tg_source_identity_no_delete
    BEFORE DELETE ON telegram_source_identity
    BEGIN SELECT RAISE(ABORT, 'telegram_source_identity_delete_forbidden'); END;

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
      state                         TEXT    NOT NULL CHECK (
        state IN ('open', 'lapsed', 'answered', 'released')
      ),
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
      -- THE KEYED, TYPED INTENT. queue_ack_intent on the binding used to be
      -- whatever string the caller passed — 'ack-intent-a3' in the fixtures,
      -- and equally 'hello' in production. It named nothing, so the binding's
      -- claim to have an ack intent was unfalsifiable. This column carries the
      -- SAME derived key, so the binding and the actual outbox row are joined by
      -- a value neither side is free to choose.
      ack_intent_key  TEXT    NOT NULL UNIQUE,
      state           TEXT    NOT NULL CHECK (
        state IN ('queue_ack_pending', 'queue_ack_appended')
      ),
      created_at_ms   INTEGER NOT NULL,
      appended_at_ms  INTEGER
    );

    -- ===================================================================
    -- THE REAL INITIAL WORK CLAIM.
    --
    -- work_generation and work_lease_token were COLUMNS on the binding. A
    -- scalar cannot be heartbeat, cannot be closed, cannot carry its own event
    -- history, and cannot be raced: two coordinators both "holding" generation
    -- 1 is not a state the binding row can even express. So the claim is a ROW,
    -- with its own events and its own exclusivity constraint.
    -- ===================================================================
    CREATE TABLE IF NOT EXISTS telegram_work_claims (
      work_claim_id         TEXT    PRIMARY KEY,
      obligation_id         TEXT    NOT NULL REFERENCES telegram_obligation_bindings(obligation_id),
      work_generation       INTEGER NOT NULL,
      lease_token           TEXT    NOT NULL,
      claim_id              TEXT    NOT NULL REFERENCES telegram_transport_claims(claim_id),
      pane_launch_id        TEXT    NOT NULL,
      app_generation        TEXT    NOT NULL,
      consumer_session_id   TEXT    NOT NULL,
      runtime_submission_id TEXT    NOT NULL,
      state                 TEXT    NOT NULL CHECK (
        state IN ('work_active', 'work_closed_aborted', 'work_closed_fulfilled')
      ),
      claimed_at_ms         INTEGER NOT NULL,
      heartbeat_at_ms       INTEGER NOT NULL,
      closed_at_ms          INTEGER
    );

    -- EXACTLY ONE ACTIVE GENERATION PER DEBT. Partial, so a closed generation
    -- keeps its audit row while releasing the slot to a reconciled successor.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tg_work_active
      ON telegram_work_claims (obligation_id)
      WHERE state = 'work_active';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tg_work_generation
      ON telegram_work_claims (obligation_id, work_generation);

    CREATE TABLE IF NOT EXISTS telegram_work_claim_events (
      event_id      INTEGER PRIMARY KEY AUTOINCREMENT,
      work_claim_id TEXT    NOT NULL REFERENCES telegram_work_claims(work_claim_id),
      transition    TEXT    NOT NULL,
      at_ms         INTEGER NOT NULL,
      detail        TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_tg_claims_state ON telegram_transport_claims(state);
    CREATE INDEX IF NOT EXISTS idx_tg_bind_state   ON telegram_obligation_bindings(state);

    -- ===================================================================
    -- IMMUTABILITY AT THE DATABASE BOUNDARY, NOT BY CONVENTION.
    --
    -- Every identity guard in this file so far lived in JavaScript, which means
    -- it constrained exactly one writer: this one. A repair script, a future
    -- module, or a hand-run UPDATE could rewrite an obligor or delete a
    -- created event and every application-level check would still pass, because
    -- none of them were ever consulted. An invariant only one caller honours is
    -- a coding convention wearing an invariant's name.
    --
    -- These triggers are what make the raw-SQL adversarial tests below able to
    -- FAIL. Without them those tests would document the hole rather than close
    -- it.
    -- ===================================================================
    CREATE TRIGGER IF NOT EXISTS trg_tg_binding_identity_immutable
    BEFORE UPDATE ON telegram_obligation_bindings
    FOR EACH ROW WHEN (
         OLD.obligation_id               IS NOT NEW.obligation_id
      OR OLD.source_row_id               IS NOT NEW.source_row_id
      OR OLD.claim_id                    IS NOT NEW.claim_id
      OR OLD.cutover_id                  IS NOT NEW.cutover_id
      OR OLD.update_id                   IS NOT NEW.update_id
      OR OLD.message_id                  IS NOT NEW.message_id
      OR OLD.chat_id                     IS NOT NEW.chat_id
      OR OLD.route_key                   IS NOT NEW.route_key
      OR OLD.profile                     IS NOT NEW.profile
      OR OLD.window_key                  IS NOT NEW.window_key
      OR OLD.raw_body_sha256             IS NOT NEW.raw_body_sha256
      OR OLD.canonical_payload_sha256    IS NOT NEW.canonical_payload_sha256
      OR OLD.predecessor_manifest_sha256 IS NOT NEW.predecessor_manifest_sha256
      OR OLD.admission_id                IS NOT NEW.admission_id
      OR OLD.attempt_nonce               IS NOT NEW.attempt_nonce
      OR OLD.app_generation              IS NOT NEW.app_generation
      OR OLD.pane_launch_id              IS NOT NEW.pane_launch_id
      OR OLD.pane_id                     IS NOT NEW.pane_id
      OR OLD.role                        IS NOT NEW.role
      OR OLD.consumer_runtime            IS NOT NEW.consumer_runtime
      OR OLD.hook_process_id             IS NOT NEW.hook_process_id
      OR OLD.hook_parent_process_id      IS NOT NEW.hook_parent_process_id
      OR OLD.consumer_session_id         IS NOT NEW.consumer_session_id
      OR OLD.runtime_submission_id       IS NOT NEW.runtime_submission_id
      OR OLD.runtime_submission_kind     IS NOT NEW.runtime_submission_kind
      OR OLD.obligor_address             IS NOT NEW.obligor_address
      OR OLD.queue_ack_intent            IS NOT NEW.queue_ack_intent
      OR OLD.created_at_ms               IS NOT NEW.created_at_ms
    )
    BEGIN SELECT RAISE(ABORT, 'telegram_binding_identity_immutable'); END;

    CREATE TRIGGER IF NOT EXISTS trg_tg_binding_no_delete
    BEFORE DELETE ON telegram_obligation_bindings
    BEGIN SELECT RAISE(ABORT, 'telegram_binding_delete_forbidden'); END;

    -- APPEND-ONLY EVENTS. A history that can be edited is not a history.
    CREATE TRIGGER IF NOT EXISTS trg_tg_binding_events_no_update
    BEFORE UPDATE ON telegram_binding_events
    BEGIN SELECT RAISE(ABORT, 'telegram_binding_events_append_only'); END;

    CREATE TRIGGER IF NOT EXISTS trg_tg_binding_events_no_delete
    BEFORE DELETE ON telegram_binding_events
    BEGIN SELECT RAISE(ABORT, 'telegram_binding_events_append_only'); END;

    CREATE TRIGGER IF NOT EXISTS trg_tg_transport_events_no_update
    BEFORE UPDATE ON telegram_transport_events
    BEGIN SELECT RAISE(ABORT, 'telegram_transport_events_append_only'); END;

    CREATE TRIGGER IF NOT EXISTS trg_tg_transport_events_no_delete
    BEFORE DELETE ON telegram_transport_events
    BEGIN SELECT RAISE(ABORT, 'telegram_transport_events_append_only'); END;

    CREATE TRIGGER IF NOT EXISTS trg_tg_work_events_no_update
    BEFORE UPDATE ON telegram_work_claim_events
    BEGIN SELECT RAISE(ABORT, 'telegram_work_claim_events_append_only'); END;

    CREATE TRIGGER IF NOT EXISTS trg_tg_work_events_no_delete
    BEFORE DELETE ON telegram_work_claim_events
    BEGIN SELECT RAISE(ABORT, 'telegram_work_claim_events_append_only'); END;

    -- A CLAIM MAY ADVANCE ITS STATE. IT MAY NOT BECOME A DIFFERENT ATTEMPT.
    CREATE TRIGGER IF NOT EXISTS trg_tg_claim_identity_immutable
    BEFORE UPDATE ON telegram_transport_claims
    FOR EACH ROW WHEN (
         OLD.claim_id         IS NOT NEW.claim_id
      OR OLD.cutover_id       IS NOT NEW.cutover_id
      OR OLD.route_key        IS NOT NEW.route_key
      OR OLD.update_id        IS NOT NEW.update_id
      OR OLD.source_row_id    IS NOT NEW.source_row_id
      OR OLD.app_generation   IS NOT NEW.app_generation
      OR OLD.pane_launch_id   IS NOT NEW.pane_launch_id
      OR OLD.pane_id          IS NOT NEW.pane_id
      OR OLD.role             IS NOT NEW.role
      OR OLD.consumer_runtime IS NOT NEW.consumer_runtime
      OR OLD.attempt_nonce    IS NOT NEW.attempt_nonce
      OR OLD.attempt_at_ms    IS NOT NEW.attempt_at_ms
    )
    BEGIN SELECT RAISE(ABORT, 'telegram_claim_identity_immutable'); END;

    -- ===================================================================
    -- THE STATE COLUMN MAY ONLY GO FORWARD (Oracle #13, blocker 1).
    --
    -- The identity trigger above deliberately permits state updates, and it was
    -- the ONLY thing guarding this column — so state could be moved BACKWARDS
    -- from delivery_started to claimed while the append-only delivery_started
    -- event sat in the events table, untouched and
    -- unconsulted. Oracle drove it on a real temp ledger: the reader still
    -- reported deliveryStartedAtMs, the disposition still said
    -- close_then_attempt, and the close still succeeded. A later pass could
    -- then redeliver a message whose bytes had already been authorised.
    --
    -- The lawful moves are the sequence's own: a claim advances to
    -- delivery_started, is released as provably unsent from claimed, or is
    -- promoted to admitted on terminal proof. Nothing else, and nothing back.
    -- ===================================================================
    CREATE TRIGGER IF NOT EXISTS trg_tg_claim_state_monotonic
    BEFORE UPDATE ON telegram_transport_claims
    FOR EACH ROW WHEN OLD.state IS NOT NEW.state AND NOT (
         (OLD.state = 'claimed' AND NEW.state IN ('delivery_started', 'closed_unsent'))
      OR (OLD.state = 'delivery_started' AND NEW.state = 'admitted')
    )
    BEGIN SELECT RAISE(ABORT, 'telegram_claim_state_not_monotonic'); END;

    -- THE APPEND-ONLY EVENT OUTRANKS THE STATUS COLUMN, ABSOLUTELY.
    --
    -- Monotonicity alone is not enough: a ledger written by an older build may
    -- ALREADY hold the incoherent pair (state = claimed, delivery_started event
    -- present), and that row must not become closable just because its cheaper
    -- record says claimed. A closed_unsent state means "provably nothing was sent",
    -- and a stored D event is proof that the opposite may be true. This asks
    -- the events table directly, so no writer can close past it — including one
    -- that never read this file.
    CREATE TRIGGER IF NOT EXISTS trg_tg_claim_close_requires_no_delivery
    BEFORE UPDATE ON telegram_transport_claims
    FOR EACH ROW WHEN NEW.state = 'closed_unsent' AND EXISTS (
      SELECT 1 FROM telegram_transport_events
      WHERE claim_id = OLD.claim_id AND kind = 'delivery_started'
    )
    BEGIN SELECT RAISE(ABORT, 'telegram_claim_close_after_delivery_started'); END;

    -- THE SLOT REMEMBERS THE DELIVERY, NOT JUST THE ROW (Oracle #21).
    --
    -- The two triggers above defend the row being moved. Neither defends the
    -- TUPLE, and the tuple is what gets delivered twice. A ledger written by a
    -- build without them may ALREADY hold the incoherent pair
    -- (state = closed_unsent, delivery_started event present); the exclusive
    -- index deliberately ignores closed rows so that a genuinely released slot
    -- can be retried; so a fresh boot reads "no live claim", calls that
    -- "never attempted", and mints a SECOND claim for bytes that were already
    -- authorised. Oracle drove exactly that on a real temp ledger at 95b12a44:
    -- read claim null, disposition attempt, second claim created true.
    --
    -- Closing a claim says "provably nothing was sent". A stored D event on the
    -- same cutover/route/update says the opposite may be true, and it is the
    -- append-only one. So a D event anywhere on this tuple poisons the tuple for
    -- every future claim, including claims whose writer never read this file.
    CREATE TRIGGER IF NOT EXISTS trg_tg_claim_insert_requires_no_prior_delivery
    BEFORE INSERT ON telegram_transport_claims
    FOR EACH ROW WHEN EXISTS (
      SELECT 1 FROM telegram_transport_events e
      JOIN telegram_transport_claims c ON c.claim_id = e.claim_id
      WHERE e.kind = 'delivery_started'
        AND c.cutover_id = NEW.cutover_id
        AND c.route_key  = NEW.route_key
        AND c.update_id  = NEW.update_id
    )
    BEGIN SELECT RAISE(ABORT, 'telegram_claim_insert_after_delivery_started'); END;

    -- A WORK CLAIM'S IDENTITY IS ITS GENERATION AND LEASE. Only liveness moves.
    CREATE TRIGGER IF NOT EXISTS trg_tg_work_identity_immutable
    BEFORE UPDATE ON telegram_work_claims
    FOR EACH ROW WHEN (
         OLD.work_claim_id         IS NOT NEW.work_claim_id
      OR OLD.obligation_id         IS NOT NEW.obligation_id
      OR OLD.work_generation       IS NOT NEW.work_generation
      OR OLD.lease_token           IS NOT NEW.lease_token
      OR OLD.claim_id              IS NOT NEW.claim_id
      OR OLD.pane_launch_id        IS NOT NEW.pane_launch_id
      OR OLD.app_generation        IS NOT NEW.app_generation
      OR OLD.consumer_session_id   IS NOT NEW.consumer_session_id
      OR OLD.runtime_submission_id IS NOT NEW.runtime_submission_id
      OR OLD.claimed_at_ms         IS NOT NEW.claimed_at_ms
    )
    BEGIN SELECT RAISE(ABORT, 'telegram_work_claim_identity_immutable'); END;

    CREATE TRIGGER IF NOT EXISTS trg_tg_work_no_delete
    BEFORE DELETE ON telegram_work_claims
    BEGIN SELECT RAISE(ABORT, 'telegram_work_claim_delete_forbidden'); END;

    -- THE OUTBOX ROW IS KEYED TO ITS BINDING AND CANNOT BE REPOINTED.
    CREATE TRIGGER IF NOT EXISTS trg_tg_ack_identity_immutable
    BEFORE UPDATE ON telegram_queue_ack_outbox
    FOR EACH ROW WHEN (
         OLD.obligation_id  IS NOT NEW.obligation_id
      OR OLD.source_row_id  IS NOT NEW.source_row_id
      OR OLD.update_id      IS NOT NEW.update_id
      OR OLD.route_key      IS NOT NEW.route_key
      OR OLD.ack_intent_key IS NOT NEW.ack_intent_key
      OR OLD.created_at_ms  IS NOT NEW.created_at_ms
    )
    BEGIN SELECT RAISE(ABORT, 'telegram_queue_ack_identity_immutable'); END;

    CREATE TRIGGER IF NOT EXISTS trg_tg_ack_no_delete
    BEFORE DELETE ON telegram_queue_ack_outbox
    BEGIN SELECT RAISE(ABORT, 'telegram_queue_ack_delete_forbidden'); END;
  `);
  return { ok: true };
}

function begin(db) { db.exec('BEGIN IMMEDIATE'); }
function commit(db) { db.exec('COMMIT'); }
function rollback(db) { try { db.exec('ROLLBACK'); } catch { /* already unwound */ } }

/**
 * THE SOURCE IDENTITY, FROM ITS OWN IMMUTABLE ROW.
 *
 * This used to parse `comms_journal.metadata_json` and return whatever it
 * found. Every decision downstream — the obligation id, the claim correlation,
 * the payload digest promotion compares — rested on a JSON blob that any writer
 * could rewrite. Now it reads the specialized table, and the blob is diagnostic.
 *
 * Returns the same SHAPE the callers already expect, so the authority changed
 * without the call sites having to be re-reasoned one by one.
 */
function readSourceIdentity(db, row) {
  if (!row) return null;
  const stored = db.prepare('SELECT * FROM telegram_source_identity WHERE source_row_id = ?')
    .get(row.row_id);
  if (!stored) return null;
  return {
    updateId: Number(stored.update_id),
    chatId: String(stored.chat_id),
    routeKey: String(stored.route_key),
    profile: String(stored.profile),
    windowKey: String(stored.window_key),
    canonicalPayloadSha256: String(stored.canonical_payload_sha256),
    mediaIdentitySha256: String(stored.media_identity_sha256),
    cutoverId: String(stored.cutover_id),
    obligorAddress: String(stored.obligor_address),
    obligationId: String(stored.obligation_id),
    rawBodySha256: String(stored.raw_body_sha256),
    bodyBytes: Number(stored.body_bytes),
    sourceSessionId: stored.source_session_id === null ? null : String(stored.source_session_id),
    messageId: String(stored.message_id),
  };
}

/**
 * THE ONLY MUTATION THE KERNEL EVER MAKES TO AN INBOUND COMMS ROW.
 *
 * `brokered` is a PROJECTION of a durable transport fact, not a second source
 * of truth. The append-only claim plus its `delivery_started` event is the
 * authority; this column exists so an operator reading the journal sees the
 * same story. So it moves exactly one edge — `recorded -> brokered` — and
 * writes exactly three columns.
 *
 * WHAT IT REFUSES TO TOUCH IS THE POINT. The generic comms upsert this replaces
 * rewrote body, session, sender, target and the whole metadata blob on every
 * call, which is how a delivery-time writer could quietly redefine the identity
 * of the message it was delivering. Body, session, identity and metadata are
 * written once, by `recordImmutableSource`, and never again by anyone.
 */
function projectSourceBrokered(db, source, atMs) {
  const status = String(source.status ?? '');

  if (status === 'brokered') {
    // Idempotent only if it is THE SAME brokering. A different time means a
    // different delivery authorised this row, and silently accepting it would
    // erase the evidence that two of them existed.
    if (Number(source.brokered_at_ms) !== Number(atMs)) {
      return fail('comms_projection_time_conflict', {
        stored: source.brokered_at_ms, offered: atMs,
      });
    }
    return { ok: true, projection: { changed: false, status, brokeredAtMs: Number(atMs) } };
  }

  if (status !== 'recorded') {
    // No fall-through, no "best effort update anyway". An unexpected status is
    // an unexpected writer, and this row is supposed to have exactly one.
    return fail('comms_projection_state_unexpected', { status });
  }

  const updated = db.prepare(`
    UPDATE comms_journal
    SET status = 'brokered', brokered_at_ms = ?, updated_at_ms = ?
    WHERE row_id = ? AND status = 'recorded'
  `).run(atMs, atMs, source.row_id);

  // GUARDED BY THE WHERE CLAUSE, VERIFIED BY THE ROW COUNT. Under BEGIN
  // IMMEDIATE a concurrent writer cannot have moved it, so zero rows means the
  // premise this read was built on is already false — report that, never
  // assume it.
  const changes = Number(updated?.changes ?? 0);
  if (changes !== 1) {
    return fail('comms_projection_lost_race', { changes, status });
  }
  return { ok: true, projection: { changed: true, status: 'brokered', brokeredAtMs: Number(atMs) } };
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
      const storedIdentity = readSourceIdentity(db, existing);
      if (!storedIdentity) { rollback(db); return fail('source_identity_missing'); }
      for (const field of SOURCE_IDENTITY_FIELDS) {
        if (String(storedIdentity[field]) !== String(identity[field])) {
          rollback(db);
          return fail('source_identity_conflict', {
            column: field, stored: storedIdentity[field], offered: identity[field],
          });
        }
      }
      // THE CANONICAL SESSION IS PART OF THE IDENTITY. Replay compared every
      // other field and silently ignored this one, so the same message recorded
      // under a different session replayed as identical.
      const offeredSession = isNonEmptyString(input.sessionId) ? String(input.sessionId) : null;
      if (String(storedIdentity.sourceSessionId ?? '') !== String(offeredSession ?? '')) {
        rollback(db);
        return fail('source_identity_conflict', {
          column: 'sourceSessionId',
          stored: storedIdentity.sourceSessionId, offered: offeredSession,
        });
      }
      if (String(storedIdentity.rawBodySha256) !== rawBodySha256) {
        rollback(db);
        return fail('source_identity_conflict', { column: 'rawBodySha256' });
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

    // THE AUTHORITY ROW. Written before the diagnostic blob, so a failure here
    // cannot leave a source that LOOKS recorded to anything reading metadata.
    // The `james` trigger fires on this insert, which is why the obligor is
    // refused before any source exists rather than at promotion.
    db.prepare(`
      INSERT INTO telegram_source_identity (
        source_row_id, message_id, cutover_id, update_id, route_key, profile,
        window_key, chat_id, canonical_payload_sha256, media_identity_sha256,
        raw_body_sha256, body_bytes, obligor_address, obligation_id,
        source_session_id, recorded_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sourceRowId, input.messageId, identity.cutoverId, identity.updateId,
      identity.routeKey, identity.profile, identity.windowKey, identity.chatId,
      identity.canonicalPayloadSha256, identity.mediaIdentitySha256,
      rawBodySha256, Buffer.byteLength(String(input.rawBody), 'utf8'),
      identity.obligorAddress, obligationId,
      isNonEmptyString(input.sessionId) ? String(input.sessionId) : null,
      recordedAtMs
    );

    // DIAGNOSTIC ONLY from here on. Kept because operators read it; read by
    // nothing that decides anything.
    db.prepare('UPDATE comms_journal SET metadata_json = ? WHERE row_id = ?')
      .run(JSON.stringify({
        [SOURCE_METADATA_KEY]: { ...identity, obligationId, diagnosticOnly: true },
      }), sourceRowId);

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
    const identity = readSourceIdentity(db, source);
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

    // ===================================================================
    // NO LIVE CLAIM IS NOT THE SAME FACT AS NO DELIVERY (Oracle #21).
    //
    // The query above deliberately ignores `closed_unsent`, because a released
    // slot must be retryable. But a slot released by an older build may carry an
    // append-only `delivery_started` it should never have been closed past, and
    // then "no live claim" means "the bytes went out and the row lies about it".
    // Acquisition is the last moment before a second delivery is authorised, so
    // it asks the events table across the whole tuple rather than trusting the
    // state column of the rows it just skipped.
    //
    // The schema trigger enforces the same rule for writers that never call
    // this function; this branch exists so the caller gets a named refusal
    // instead of a constraint stack trace.
    // ===================================================================
    const tupleDelivered = db.prepare(`
      SELECT c.claim_id AS claim_id, c.state AS state, e.at_ms AS at_ms
      FROM telegram_transport_events e
      JOIN telegram_transport_claims c ON c.claim_id = e.claim_id
      WHERE e.kind = 'delivery_started'
        AND c.cutover_id = ? AND c.route_key = ? AND c.update_id = ?
      ORDER BY e.event_id ASC LIMIT 1
    `).get(input.cutoverId, input.routeKey, input.updateId);
    if (tupleDelivered) {
      rollback(db);
      return fail('claim_tuple_delivery_started', {
        deliveredClaimId: String(tupleDelivered.claim_id),
        deliveredClaimState: String(tupleDelivered.state),
        deliveryStartedAtMs: Number(tupleDelivered.at_ms),
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
    // THE TUPLE GUARD, when the trigger is what refused. A writer that reached
    // the INSERT without the branch above — an older caller, a raw statement —
    // must get the same named reason, not a generic failure a retry loop could
    // read as transient.
    if (/telegram_claim_insert_after_delivery_started/i.test(err.message)) {
      return fail('claim_tuple_delivery_started', { refusedBy: 'schema_trigger' });
    }
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

    // REJOIN THE CLAIM TO ITS IMMUTABLE SOURCE, HERE, INSIDE THE SAME
    // TRANSACTION THAT AUTHORISES THE PANE WRITE.
    //
    // Acquisition already joined them, but acquisition happened earlier and in
    // its own transaction. Between the two, the only thing standing behind
    // "this claim describes that message" is a foreign key — and a foreign key
    // proves a row exists, never that it still says the same thing. The
    // authorisation boundary is the one place where being wrong means James
    // sees the wrong message, so it re-derives rather than inherits.
    const source = db.prepare('SELECT * FROM comms_journal WHERE row_id = ?')
      .get(claim.source_row_id);
    if (!source) { rollback(db); return fail('source_row_missing'); }
    const identity = readSourceIdentity(db, source);
    if (!identity) { rollback(db); return fail('source_identity_missing'); }
    if (String(identity.cutoverId) !== String(claim.cutover_id)
      || String(identity.routeKey) !== String(claim.route_key)
      || Number(identity.updateId) !== Number(claim.update_id)) {
      rollback(db);
      return fail('delivery_source_correlation_mismatch', {
        sourceCutover: identity.cutoverId,
        sourceRoute: identity.routeKey,
        sourceUpdateId: identity.updateId,
      });
    }

    switch (claim.state) {
      case CLAIM_STATES.CLAIMED: {
        // THE ONE ALLOWED COMMS PROJECTION, and it happens BEFORE the claim
        // moves — so a refused projection cannot leave a delivery authorised
        // against a row that never advanced.
        const projected = projectSourceBrokered(db, source, atMs);
        if (!projected.ok) { rollback(db); return projected; }

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
        return {
          ok: true,
          claimId: input.claimId,
          state: CLAIM_STATES.DELIVERY_STARTED,
          created: true,
          sourceRowId: Number(source.row_id),
          commsProjection: projected.projection,
        };
      }

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
        // EXACT REPLAY MUST STILL SEE THE PROJECTION IT CLAIMS TO REPLAY. A
        // replay accepted over a comms row that is NOT brokered at this exact
        // time is not a replay of this delivery — it is a second one wearing
        // the first one's digest.
        const projected = projectSourceBrokered(db, source, atMs);
        if (!projected.ok) { rollback(db); return projected; }
        commit(db);
        return {
          ok: true,
          claimId: input.claimId,
          state: CLAIM_STATES.DELIVERY_STARTED,
          created: false,
          sourceRowId: Number(source.row_id),
          commsProjection: projected.projection,
        };
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

    // ===================================================================
    // THE EVENT IS ASKED FIRST, AND IT WINS (Oracle #13, blocker 1).
    //
    // `state` is mutable and `delivery_started` is append-only, so when the two
    // disagree the append-only one is the record of what happened. Checking
    // only `state = claimed` meant a row whose status had been moved back —
    // whether by a bug, an older build, or a hand-edit — read as provably
    // unsent while carrying durable evidence that bytes had been authorised.
    // Inside the same transaction as the close, so nothing can slip a D event
    // in between the question and the answer.
    // ===================================================================
    const deliveryStarted = db.prepare(`
      SELECT at_ms FROM telegram_transport_events
      WHERE claim_id = ? AND kind = 'delivery_started'
      ORDER BY event_id ASC LIMIT 1
    `).get(input.claimId);
    if (deliveryStarted) {
      rollback(db);
      return fail('claim_delivery_started_recorded', {
        state: claim.state,
        deliveryStartedAtMs: Number(deliveryStarted.at_ms),
      });
    }

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
 * THE DRAIN'S READ OF THE ATTEMPT LATCH. READ-ONLY, NO SYNTHESIS.
 *
 * =====================================================================
 * WHY THE DRAIN NEEDS THIS AT ALL
 * =====================================================================
 * Post-cutover the claim IS the attempt latch. Until now the only thing that
 * could see a claim was the process that had just made one; a restarted drain
 * asked `delivery-attempts.jsonl` — a file the delivery path no longer writes —
 * and got back "never attempted" for a message whose bytes may already be on
 * James's screen. That is the duplicate this whole lane exists to prevent, and
 * it would have been INTRODUCED by the fix.
 *
 * Every field returned comes out of a stored column. `delivery_started` is read
 * from the append-only event table rather than inferred from `state`, because
 * "which authority says the pane write was authorised" is exactly the question,
 * and answering it from a mutable status column would be answering it from the
 * cheaper of the two records.
 *
 * THE CLOSED SLOT IS STILL RETURNED, WITH ITS EVENTS. A `closed_unsent` claim
 * is evidence that an attempt was made, and the caller needs to see it to
 * distinguish that from "nothing ever happened here". Those two are NOT both
 * safe to attempt, which is what this comment used to say: a closed row that
 * carries a `delivery_started` event is an older build's incoherent pair, and
 * attempting it is a second copy in front of James.
 */
function readTransportClaim(db, input = {}) {
  const durable = assertDurableHandle(db);
  if (!durable.ok) return durable;

  for (const field of ['cutoverId', 'routeKey']) {
    if (!isNonEmptyString(input[field])) return fail(`claim_read_field_missing:${field}`);
  }
  const updateId = Number(input.updateId);
  if (!Number.isSafeInteger(updateId) || updateId <= 0) {
    return fail('claim_read_field_missing:updateId');
  }

  let rows;
  try {
    rows = db.prepare(`
      SELECT * FROM telegram_transport_claims
      WHERE cutover_id = ? AND route_key = ? AND update_id = ?
      ORDER BY attempt_at_ms ASC, claim_id ASC
    `).all(input.cutoverId, input.routeKey, updateId);
  } catch (err) {
    return fail(`claim_read_failed:${err.message}`);
  }
  if (!rows.length) return { ok: true, claim: null, closedClaims: [] };

  const live = rows.filter((row) => String(row.state) !== CLAIM_STATES.CLOSED_UNSENT);

  // ===================================================================
  // THE CLOSED ROWS ARE ASKED FOR THEIR EVENTS TOO (Oracle #21).
  //
  // This used to project a closed row from its columns alone and never open the
  // events table for it, so a legacy `closed_unsent` row carrying an append-only
  // `delivery_started` — the pair an older build could write — came back as a
  // bare closed slot. The caller then read {claim: null} as "nothing outstanding
  // here", and the tuple was delivered a second time. A closed row is exactly
  // where the contradiction hides, because closing is the act that CLAIMS
  // nothing was sent.
  // ===================================================================
  let closedClaims;
  try {
    const readEvents = db.prepare(`
      SELECT kind, at_ms FROM telegram_transport_events
      WHERE claim_id = ? ORDER BY event_id ASC
    `);
    closedClaims = rows
      .filter((row) => String(row.state) === CLAIM_STATES.CLOSED_UNSENT)
      .map((row) => {
        const closedEvents = readEvents.all(String(row.claim_id));
        const started = closedEvents.find((event) => String(event.kind) === 'delivery_started') || null;
        return {
          claimId: String(row.claim_id),
          closedAtMs: Number(row.closed_at_ms) || null,
          // FROM THE APPEND-ONLY EVENT, same authority as the live claim's.
          deliveryStartedAtMs: started ? Number(started.at_ms) : null,
          eventKinds: closedEvents.map((event) => String(event.kind)),
        };
      });
  } catch (err) {
    return fail(`claim_events_unreadable:${err.message}`);
  }

  // TWO LIVE CLAIMS IS NOT A STATE ANYONE MAY GUESS PAST. The partial unique
  // index forbids it, so seeing it means the index is gone or the file is
  // damaged, and picking either row would be picking which delivery to believe.
  if (live.length > 1) {
    return fail('claim_read_ambiguous', { liveClaimIds: live.map((row) => String(row.claim_id)) });
  }
  if (!live.length) return { ok: true, claim: null, closedClaims };

  const row = live[0];
  let events;
  try {
    events = db.prepare(`
      SELECT kind, at_ms, detail FROM telegram_transport_events
      WHERE claim_id = ? ORDER BY event_id ASC
    `).all(String(row.claim_id));
  } catch (err) {
    return fail(`claim_events_unreadable:${err.message}`);
  }
  const deliveryStarted = events.find((event) => String(event.kind) === 'delivery_started') || null;

  const sourceRow = db.prepare('SELECT * FROM comms_journal WHERE row_id = ?').get(row.source_row_id);
  const identity = readSourceIdentity(db, sourceRow);
  // A claim whose immutable source cannot be read is not a claim we can reason
  // about: the identity the proof gate compares against lives in that row.
  if (!identity) return fail('claim_source_identity_unreadable', { claimId: String(row.claim_id) });

  return {
    ok: true,
    closedClaims,
    claim: {
      claimId: String(row.claim_id),
      cutoverId: String(row.cutover_id),
      routeKey: String(row.route_key),
      updateId: Number(row.update_id),
      sourceRowId: Number(row.source_row_id),
      state: String(row.state),
      appGeneration: String(row.app_generation),
      paneLaunchId: String(row.pane_launch_id),
      paneId: String(row.pane_id),
      role: String(row.role),
      consumerRuntime: String(row.consumer_runtime),
      attemptNonce: String(row.attempt_nonce),
      attemptAtMs: Number(row.attempt_at_ms),
      closedAtMs: row.closed_at_ms === null ? null : Number(row.closed_at_ms),
      deliveredPromptSha256: row.delivered_prompt_sha256 === null ? null : String(row.delivered_prompt_sha256),
      deliveredPromptBytes: row.delivered_prompt_bytes === null ? null : Number(row.delivered_prompt_bytes),
      // FROM THE APPEND-ONLY EVENT, not from `state`.
      deliveryStartedAtMs: deliveryStarted ? Number(deliveryStarted.at_ms) : null,
      eventKinds: events.map((event) => String(event.kind)),
      source: {
        messageId: identity.messageId,
        chatId: identity.chatId,
        profile: identity.profile,
        windowKey: identity.windowKey,
        routeKey: identity.routeKey,
        updateId: identity.updateId,
        cutoverId: identity.cutoverId,
        canonicalPayloadSha256: identity.canonicalPayloadSha256,
        obligationId: identity.obligationId,
        status: sourceRow ? String(sourceRow.status ?? '') : null,
      },
    },
  };
}

/**
 * THE KEYED QUEUE-ACK INTENT.
 *
 * Derived, never supplied. The binding stored whatever `queueAckIntent` string
 * a caller handed it, so "this obligation has an ack intent" was a sentence the
 * caller wrote about itself; it correlated to no row and nothing could
 * contradict it. This key is computed from the obligation and the exact source
 * tuple, written to BOTH the binding and the outbox row, and UNIQUE on the
 * outbox — so the two are joined by a value neither side chose and a mismatch
 * is a detectable fact rather than a difference of opinion.
 */
function deriveQueueAckIntentKey(input = {}) {
  return `tgack_${sha256(canonicalJoin([
    'telegram_queue_ack.v1',
    input.obligationId,
    input.sourceRowId,
    input.updateId,
    input.routeKey,
  ]))}`;
}

/**
 * NAMED COMPARE-AND-SET over the Telegram binding, plus its append-only event.
 *
 * `expectedState` is REQUIRED. A mover that does not have to say what it
 * believed it saw is not a compare-and-set, it is an UPDATE with extra
 * ceremony, and it cannot tell "I advanced this" from "someone else already
 * did and I overwrote them".
 */
function casBindingState(db, input = {}) {
  const durable = assertDurableHandle(db);
  if (!durable.ok) return durable;

  const transition = String(input.transition || '');
  const spec = Object.prototype.hasOwnProperty.call(BINDING_TRANSITIONS, transition)
    ? BINDING_TRANSITIONS[transition] : null;
  if (!spec) return fail('binding_transition_unknown', { transition });
  if (!isNonEmptyString(input.obligationId)) return fail('binding_cas_field_missing:obligationId');
  if (!isNonEmptyString(input.expectedState)) return fail('binding_cas_field_missing:expectedState');
  const atMs = Number(input.atMs);
  if (!Number.isSafeInteger(atMs) || atMs <= 0) return fail('binding_cas_field_missing:atMs');
  if (!spec.from.includes(String(input.expectedState))) {
    return fail('binding_transition_illegal', {
      transition, from: input.expectedState, legalFrom: spec.from,
    });
  }

  const row = db.prepare('SELECT * FROM telegram_obligation_bindings WHERE obligation_id = ?')
    .get(input.obligationId);
  if (!row) return fail('binding_not_found', { obligationId: input.obligationId });

  const changed = db.prepare(
    'UPDATE telegram_obligation_bindings SET state = ? WHERE obligation_id = ? AND state = ?'
  ).run(spec.to, input.obligationId, String(input.expectedState)).changes;
  if (changed !== 1) {
    return fail('binding_cas_conflict', {
      transition, expected: input.expectedState, actual: row.state,
    });
  }
  db.prepare(
    'INSERT INTO telegram_binding_events (obligation_id, transition, at_ms, detail) VALUES (?, ?, ?, ?)'
  ).run(input.obligationId, transition, atMs, input.detail ? String(input.detail) : null);

  return { ok: true, obligationId: input.obligationId, transition, state: spec.to };
}

/** Named CAS over the queue-ack outbox row, with the same event discipline. */
function casQueueAckState(db, input = {}) {
  const durable = assertDurableHandle(db);
  if (!durable.ok) return durable;

  const transition = String(input.transition || '');
  const spec = Object.prototype.hasOwnProperty.call(QUEUE_ACK_TRANSITIONS, transition)
    ? QUEUE_ACK_TRANSITIONS[transition] : null;
  if (!spec) return fail('queue_ack_transition_unknown', { transition });
  if (!isNonEmptyString(input.obligationId)) return fail('queue_ack_cas_field_missing:obligationId');
  if (!isNonEmptyString(input.expectedState)) return fail('queue_ack_cas_field_missing:expectedState');
  const atMs = Number(input.atMs);
  if (!Number.isSafeInteger(atMs) || atMs <= 0) return fail('queue_ack_cas_field_missing:atMs');
  if (!spec.from.includes(String(input.expectedState))) {
    return fail('queue_ack_transition_illegal', {
      transition, from: input.expectedState, legalFrom: spec.from,
    });
  }

  const row = db.prepare('SELECT * FROM telegram_queue_ack_outbox WHERE obligation_id = ?')
    .get(input.obligationId);
  if (!row) return fail('queue_ack_row_not_found', { obligationId: input.obligationId });
  // THE INTENT KEY IS THE JOIN. An ack advancing against a row whose key does
  // not re-derive is acking something other than the debt it names.
  const expectedKey = deriveQueueAckIntentKey({
    obligationId: input.obligationId,
    sourceRowId: row.source_row_id,
    updateId: row.update_id,
    routeKey: row.route_key,
  });
  if (String(row.ack_intent_key) !== expectedKey) {
    return fail('queue_ack_intent_key_not_derivable', {
      stored: row.ack_intent_key, recomputed: expectedKey,
    });
  }

  const changed = db.prepare(
    'UPDATE telegram_queue_ack_outbox SET state = ?, appended_at_ms = ? WHERE obligation_id = ? AND state = ?'
  ).run(spec.to, atMs, input.obligationId, String(input.expectedState)).changes;
  if (changed !== 1) {
    return fail('queue_ack_cas_conflict', {
      transition, expected: input.expectedState, actual: row.state,
    });
  }
  db.prepare(
    'INSERT INTO telegram_binding_events (obligation_id, transition, at_ms, detail) VALUES (?, ?, ?, ?)'
  ).run(input.obligationId, transition, atMs, row.ack_intent_key);

  return { ok: true, obligationId: input.obligationId, transition, state: spec.to };
}

/**
 * A LIVE HEARTBEAT ON THE WORK CLAIM, fenced by its lease token.
 *
 * Health has to tell an aborted model turn from a long-running one, and a
 * process heartbeat cannot do it: a perfectly healthy consumer process says
 * nothing about whether the turn it launched is still alive. So the WORK claim
 * beats separately, and only the holder of the exact lease token may beat it.
 * A stale generation's beat is rejected rather than silently keeping a dead
 * claim looking live.
 */
function heartbeatWorkClaim(db, input = {}) {
  const durable = assertDurableHandle(db);
  if (!durable.ok) return durable;

  if (!isNonEmptyString(input.workClaimId)) return fail('work_heartbeat_field_missing:workClaimId');
  if (!isNonEmptyString(input.leaseToken)) return fail('work_heartbeat_field_missing:leaseToken');
  const atMs = Number(input.atMs);
  if (!Number.isSafeInteger(atMs) || atMs <= 0) return fail('work_heartbeat_field_missing:atMs');

  const row = db.prepare('SELECT * FROM telegram_work_claims WHERE work_claim_id = ?')
    .get(input.workClaimId);
  if (!row) return fail('work_claim_not_found', { workClaimId: input.workClaimId });
  if (String(row.lease_token) !== String(input.leaseToken)) {
    return fail('work_lease_token_stale', { workClaimId: input.workClaimId });
  }
  if (String(row.state) !== WORK_CLAIM_STATES.ACTIVE) {
    return fail('work_claim_not_active', { state: row.state });
  }
  // TIME ONLY MOVES FORWARD. A backdated beat would let a replayed message
  // reset the age that health degrades on.
  if (atMs < Number(row.heartbeat_at_ms)) {
    return fail('work_heartbeat_regressed', {
      stored: row.heartbeat_at_ms, offered: atMs,
    });
  }

  const changed = db.prepare(`
    UPDATE telegram_work_claims SET heartbeat_at_ms = ?
    WHERE work_claim_id = ? AND lease_token = ? AND state = ?
  `).run(atMs, input.workClaimId, input.leaseToken, WORK_CLAIM_STATES.ACTIVE).changes;
  if (changed !== 1) return fail('work_heartbeat_cas_conflict', { state: row.state });

  db.prepare(
    'INSERT INTO telegram_work_claim_events (work_claim_id, transition, at_ms, detail) VALUES (?, ?, ?, ?)'
  ).run(input.workClaimId, 'work_heartbeat', atMs, null);

  return { ok: true, workClaimId: input.workClaimId, heartbeatAtMs: atMs };
}

/** Named CAS closing a work generation, fenced by the same lease token. */
function casWorkClaimState(db, input = {}) {
  const durable = assertDurableHandle(db);
  if (!durable.ok) return durable;

  const transition = String(input.transition || '');
  const spec = Object.prototype.hasOwnProperty.call(WORK_CLAIM_TRANSITIONS, transition)
    ? WORK_CLAIM_TRANSITIONS[transition] : null;
  if (!spec) return fail('work_transition_unknown', { transition });
  if (!isNonEmptyString(input.workClaimId)) return fail('work_cas_field_missing:workClaimId');
  if (!isNonEmptyString(input.leaseToken)) return fail('work_cas_field_missing:leaseToken');
  const atMs = Number(input.atMs);
  if (!Number.isSafeInteger(atMs) || atMs <= 0) return fail('work_cas_field_missing:atMs');

  const row = db.prepare('SELECT * FROM telegram_work_claims WHERE work_claim_id = ?')
    .get(input.workClaimId);
  if (!row) return fail('work_claim_not_found', { workClaimId: input.workClaimId });
  if (String(row.lease_token) !== String(input.leaseToken)) {
    return fail('work_lease_token_stale', { workClaimId: input.workClaimId });
  }
  if (!spec.from.includes(String(row.state))) {
    return fail('work_transition_illegal', {
      transition, from: row.state, legalFrom: spec.from,
    });
  }

  const changed = db.prepare(`
    UPDATE telegram_work_claims SET state = ?, closed_at_ms = ?
    WHERE work_claim_id = ? AND lease_token = ? AND state = ?
  `).run(spec.to, atMs, input.workClaimId, input.leaseToken, String(row.state)).changes;
  if (changed !== 1) return fail('work_cas_conflict', { transition, actual: row.state });

  db.prepare(
    'INSERT INTO telegram_work_claim_events (work_claim_id, transition, at_ms, detail) VALUES (?, ?, ?, ?)'
  ).run(input.workClaimId, transition, atMs, input.detail ? String(input.detail) : null);

  return { ok: true, workClaimId: input.workClaimId, transition, state: spec.to };
}

/**
 * RE-PROVE EVERY DEPENDENT FACT OF AN EXISTING ADMISSION.
 *
 * Idempotent replay must be able to FAIL. The previous implementation compared
 * the binding's identity columns and then returned the stored generation and
 * lease — so deleting the kernel obligation, its created event, the outbox row
 * or the work claim left replay answering `ok:true` with the same confident id.
 * It re-returned; it never re-proved. That is the exact shape that let the A12
 * mutant survive, and it is the shape of every defect in this lane: a value
 * read back and presented as a verification.
 *
 * So each fact is looked up in its CANONICAL home — `obligations`,
 * `ledger_events`, the work-claim row, the outbox row — and a partial dependent
 * set is a hard conflict naming exactly what is missing.
 */
function reproveDependentFacts(db, input = {}) {
  const { obligationId, source, claim, binding, obligorAddress } = input;
  const reproved = [];

  // 0. THE IMMUTABLE SOURCE IDENTITY STILL EXISTS AND STILL SAYS THE SAME
  //    THING. Everything below is derived from it, so a replay that skipped it
  //    would re-prove six facts about an identity that had moved.
  const storedIdentity = db.prepare(
    'SELECT * FROM telegram_source_identity WHERE source_row_id = ?'
  ).get(source.row_id);
  if (!storedIdentity) return fail('replay_dependent_fact_missing:source_identity');
  if (String(storedIdentity.obligation_id) !== String(obligationId)
    || String(storedIdentity.obligor_address) !== String(obligorAddress)
    || String(storedIdentity.message_id) !== String(source.message_id)) {
    return fail('replay_dependent_fact_conflict:source_identity', {
      storedObligation: storedIdentity.obligation_id,
      storedObligor: storedIdentity.obligor_address,
    });
  }
  reproved.push('source_identity');

  // 1. THE SOURCE WAS BROKERED.
  if (String(source.status) !== SOURCE_STATES.BROKERED) {
    return fail('replay_dependent_fact_missing:source_not_brokered', { status: source.status });
  }
  reproved.push('source_brokered');

  // 2. THE TRANSPORT CLAIM WAS ADMITTED.
  if (String(claim.state) !== CLAIM_STATES.ADMITTED) {
    return fail('replay_dependent_fact_missing:claim_not_admitted', { state: claim.state });
  }
  reproved.push('claim_admitted');

  // 3. THE CANONICAL KERNEL OBLIGATION, in the general kernel's own table.
  const obligation = db.prepare('SELECT * FROM obligations WHERE obligation_id = ?').get(obligationId);
  if (!obligation) return fail('replay_dependent_fact_missing:obligation');
  if (Number(obligation.created_from_row_id) !== Number(source.row_id)) {
    return fail('replay_dependent_fact_conflict:obligation_source', {
      stored: obligation.created_from_row_id, expected: source.row_id,
    });
  }
  if (String(obligation.creditor_address) !== 'james'
    || String(obligation.obligor_address) !== String(obligorAddress)
    || String(obligation.expected_class) !== 'answer'
    || String(obligation.staleness_class) !== 'turn') {
    return fail('replay_dependent_fact_conflict:obligation_shape', {
      creditor: obligation.creditor_address,
      obligor: obligation.obligor_address,
      expectedClass: obligation.expected_class,
      stalenessClass: obligation.staleness_class,
    });
  }
  if (obligation.lease_id !== null) {
    return fail('replay_dependent_fact_conflict:obligation_lease_not_null', {
      leaseId: obligation.lease_id,
    });
  }
  reproved.push('obligation_canonical');

  // 4. THE CANONICAL CREATED EVENT — the KERNEL'S shape, not merely a row in
  //    the right table. A2 wrote `ledger_events` by hand and produced rows that
  //    were table-real and kernel-wrong: no `obligation:<id>` trace, no
  //    correlation, no edges. So the shape is what is checked.
  if (!isNonEmptyString(String(obligation.created_event_id ?? ''))) {
    return fail('replay_dependent_fact_missing:created_event_id');
  }
  const createdEvent = db.prepare('SELECT * FROM ledger_events WHERE event_id = ?')
    .get(obligation.created_event_id);
  if (!createdEvent) return fail('replay_dependent_fact_missing:created_event');
  const canonicalTrace = `obligation:${obligationId}`;
  if (String(createdEvent.type) !== 'obligation.created'
    || String(createdEvent.stage) !== 'obligation'
    || String(createdEvent.source) !== 'obligation-kernel'
    || String(createdEvent.trace_id) !== canonicalTrace
    || String(createdEvent.correlation_id) !== canonicalTrace) {
    return fail('replay_dependent_fact_conflict:created_event_not_canonical', {
      type: createdEvent.type,
      stage: createdEvent.stage,
      source: createdEvent.source,
      traceId: createdEvent.trace_id,
      correlationId: createdEvent.correlation_id,
    });
  }
  let createdPayload = null;
  try { createdPayload = JSON.parse(createdEvent.payload_json); } catch { createdPayload = null; }
  if (!createdPayload || String(createdPayload.obligationId) !== String(obligationId)
    || String(createdPayload.obligorAddress) !== String(obligorAddress)
    || String(createdPayload.creditorAddress) !== 'james') {
    return fail('replay_dependent_fact_conflict:created_event_payload');
  }
  reproved.push('created_event_canonical');

  // 5. THE BINDING'S OWN CREATED EVENT.
  const bindingCreated = db.prepare(`
    SELECT COUNT(*) AS n FROM telegram_binding_events
    WHERE obligation_id = ? AND transition = 'created'
  `).get(obligationId);
  if (!bindingCreated || Number(bindingCreated.n) < 1) {
    return fail('replay_dependent_fact_missing:binding_created_event');
  }
  reproved.push('binding_created_event');

  // 6. THE REAL WORK CLAIM ROW, its generation, its lease and its event.
  const workClaim = db.prepare(`
    SELECT * FROM telegram_work_claims
    WHERE obligation_id = ? ORDER BY work_generation DESC LIMIT 1
  `).get(obligationId);
  if (!workClaim) return fail('replay_dependent_fact_missing:work_claim');
  if (Number(workClaim.work_generation) !== Number(binding.work_generation)
    || String(workClaim.lease_token) !== String(binding.work_lease_token)) {
    return fail('replay_dependent_fact_conflict:work_claim_generation', {
      rowGeneration: workClaim.work_generation,
      bindingGeneration: binding.work_generation,
    });
  }
  if (String(workClaim.claim_id) !== String(claim.claim_id)) {
    return fail('replay_dependent_fact_conflict:work_claim_attempt', {
      stored: workClaim.claim_id, expected: claim.claim_id,
    });
  }
  const workClaimed = db.prepare(`
    SELECT COUNT(*) AS n FROM telegram_work_claim_events
    WHERE work_claim_id = ? AND transition = 'work_claimed'
  `).get(workClaim.work_claim_id);
  if (!workClaimed || Number(workClaimed.n) < 1) {
    return fail('replay_dependent_fact_missing:work_claim_event');
  }
  reproved.push('work_claim');

  // 7. THE QUEUE-ACK OUTBOX ROW, joined by the DERIVED key rather than by
  //    existence. A row that exists but whose key does not re-derive is an
  //    intent for something else.
  const outbox = db.prepare('SELECT * FROM telegram_queue_ack_outbox WHERE obligation_id = ?')
    .get(obligationId);
  if (!outbox) return fail('replay_dependent_fact_missing:queue_ack_outbox');
  const expectedKey = deriveQueueAckIntentKey({
    obligationId,
    sourceRowId: outbox.source_row_id,
    updateId: outbox.update_id,
    routeKey: outbox.route_key,
  });
  if (String(outbox.ack_intent_key) !== expectedKey
    || String(binding.queue_ack_intent) !== expectedKey) {
    return fail('replay_dependent_fact_conflict:queue_ack_intent_key', {
      outboxKey: outbox.ack_intent_key,
      bindingIntent: binding.queue_ack_intent,
      recomputed: expectedKey,
    });
  }
  if (Number(outbox.source_row_id) !== Number(source.row_id)) {
    return fail('replay_dependent_fact_conflict:queue_ack_source');
  }
  reproved.push('queue_ack_outbox');

  return { ok: true, reproved, workClaim, createdEventId: obligation.created_event_id };
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
  // `queueAckIntent` IS NO LONGER AN INPUT. It is derived below from the
  // obligation and source tuple, because a caller-chosen string named nothing
  // and could never disagree with reality. A caller may still OFFER one, and it
  // is then checked against the derivation rather than stored on trust.
  const required = ['messageId', 'claimId', 'admissionId', 'obligorAddress'];
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
    const identity = readSourceIdentity(db, source);
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
    // THE IMMUTABLE IDENTITY IS THE ARBITER. `comms_journal` can be rewritten by
    // any generic writer; `telegram_source_identity` cannot. So the mutable row
    // is checked AGAINST the immutable one, not the other way round.
    if (String(identity.rawBodySha256) !== String(source.body_hash)
      || Number(identity.bodyBytes) !== Number(source.body_bytes)) {
      rollback(db);
      return fail('source_body_diverged_from_immutable_identity', {
        immutable: identity.rawBodySha256, comms: source.body_hash,
      });
    }
    if (String(identity.sourceSessionId ?? '') !== String(source.session_id ?? '')) {
      rollback(db);
      return fail('source_session_diverged_from_immutable_identity', {
        immutable: identity.sourceSessionId, comms: source.session_id,
      });
    }
    if (String(identity.messageId) !== String(source.message_id)) {
      rollback(db); return fail('source_message_id_diverged_from_immutable_identity');
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
        // THE REST OF THE TUPLE, assembled from the CANONICAL authorities —
        // the claim the drain made, the launch the daemon owns, and the
        // receipt row's own account of the hook process and submission.
        claimId: claim.claim_id,
        attemptNonce: claim.attempt_nonce,
        paneLaunchId: launch.launch_id,
        role: claim.role,
        hookProcessId: receipt.hook_process_id,
        hookParentProcessId: receipt.hook_parent_process_id,
        runtimeSubmissionId: receipt.runtime_submission_id,
        runtimeSubmissionKind: receipt.runtime_submission_kind,
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

    // DERIVED, then compared against anything the caller offered.
    const queueAckIntentKey = deriveQueueAckIntentKey({
      obligationId,
      sourceRowId: source.row_id,
      updateId: identity.updateId,
      routeKey: identity.routeKey,
    });
    if (isNonEmptyString(input.queueAckIntent)
      && String(input.queueAckIntent) !== queueAckIntentKey) {
      rollback(db);
      return fail('queue_ack_intent_not_derivable', {
        offered: input.queueAckIntent, recomputed: queueAckIntentKey,
      });
    }

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
      queue_ack_intent: queueAckIntentKey,
    };

    // ===================================================================
    // REPLAY. RE-PROVE, DO NOT RE-RETURN.
    //
    // The previous version compared the identity columns and then handed back
    // the stored `work_generation` and `work_lease_token`. That is precisely
    // how the A12 mutant survived: a function that returns a value it read is
    // indistinguishable from one that verified anything. Delete the obligation,
    // the created event, the outbox row or the work claim and the old replay
    // still answered `ok:true` with a confident id — a receipt for a debt that
    // no longer existed.
    //
    // Every dependent fact is re-derived below against the CANONICAL
    // authorities. A partial dependent set is a hard conflict, never a success.
    // ===================================================================
    if (existingBinding) {
      for (const column of BINDING_IDENTITY_COLUMNS) {
        if (String(existingBinding[column]) !== String(offered[column])) {
          rollback(db);
          return fail('binding_identity_conflict', {
            column, stored: existingBinding[column], offered: offered[column],
          });
        }
      }
      const reproof = reproveDependentFacts(db, {
        obligationId,
        source,
        claim,
        binding: existingBinding,
        obligorAddress: input.obligorAddress,
      });
      if (!reproof.ok) { rollback(db); return reproof; }
      commit(db);
      return {
        ok: true,
        obligationId,
        sourceRowId: source.row_id,
        workGeneration: reproof.workClaim.work_generation,
        workLeaseToken: reproof.workClaim.lease_token,
        workClaimId: reproof.workClaim.work_claim_id,
        createdEventId: reproof.createdEventId,
        reproved: reproof.reproved,
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

    // 4. THE QUEUE-ACK OUTBOX INTENT (transport, not reply), carrying the SAME
    //    derived key the binding stores.
    db.prepare(`
      INSERT INTO telegram_queue_ack_outbox (
        obligation_id, source_row_id, update_id, route_key, ack_intent_key,
        state, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      obligationId, source.row_id, offered.update_id, offered.route_key,
      queueAckIntentKey, QUEUE_ACK_STATES.PENDING, atMs
    );

    // ===================================================================
    // 5. THE REAL INITIAL WORK CLAIM — a ROW, an EVENT, and a HEARTBEAT.
    //
    // This used to be two columns on the binding. The gate requires that
    // admission create the initial work generation bound exactly to the
    // admission's session, submission id, attempt and launch, and that the work
    // heartbeat be trackable separately from the consumer process. Neither is
    // expressible as a scalar: a column cannot be beaten, cannot be closed by a
    // fencing CAS, and cannot carry the event that proves when either happened.
    //
    // The binding keeps its scalars as a denormalised pointer to generation 1,
    // and every later authority reads the ROW.
    // ===================================================================
    const workClaimId = `twc_${sha256(canonicalJoin([obligationId, '1', workLeaseToken]))}`;
    db.prepare(`
      INSERT INTO telegram_work_claims (
        work_claim_id, obligation_id, work_generation, lease_token, claim_id,
        pane_launch_id, app_generation, consumer_session_id, runtime_submission_id,
        state, claimed_at_ms, heartbeat_at_ms, closed_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      workClaimId, obligationId, 1, workLeaseToken, input.claimId,
      claim.pane_launch_id, claim.app_generation, receipt.consumer_session_id,
      receipt.runtime_submission_id, WORK_CLAIM_STATES.ACTIVE, atMs, atMs
    );
    db.prepare(
      'INSERT INTO telegram_work_claim_events (work_claim_id, transition, at_ms, detail) VALUES (?, ?, ?, ?)'
    ).run(workClaimId, 'work_claimed', atMs, null);

    // 6. THE SOURCE IS ALREADY BROKERED, AND PROMOTION DOES NOT RE-BROKER IT.
    //
    // B4b moved that projection to the `delivery_started` authorisation
    // boundary, where the fact it projects actually becomes true. Writing it
    // again here would make promotion the second writer of the one column the
    // kernel is supposed to own — the same defect as the generic upsert, one
    // layer down — and it would move `brokered_at_ms` forward to promotion
    // time, quietly relabelling when James's message reached the pane.
    //
    // Verified rather than assumed: promotion of a source that was never
    // brokered means a receipt exists for a delivery nothing ever authorised.
    if (String(source.status) !== SOURCE_STATES.BROKERED) {
      rollback(db);
      return fail('source_not_brokered', { status: source.status });
    }

    db.prepare('UPDATE telegram_transport_claims SET state = ? WHERE claim_id = ?')
      .run(CLAIM_STATES.ADMITTED, input.claimId);

    commit(db);
    return {
      ok: true, obligationId, sourceRowId: source.row_id,
      workGeneration: 1, workLeaseToken, workClaimId,
      queueAckIntentKey, createdEventId, created: true,
    };
  } catch (err) {
    rollback(db);
    return fail(`owned_promotion_failed:${err.message}`);
  }
}

module.exports = {
  SCHEMA_VERSION,
  TELEGRAM_CUTOVER_ID,
  SOURCE_METADATA_KEY,
  CLAIM_STATES,
  SOURCE_STATES,
  QUEUE_ACK_STATES,
  BINDING_STATES,
  WORK_CLAIM_STATES,
  BINDING_TRANSITIONS,
  QUEUE_ACK_TRANSITIONS,
  WORK_CLAIM_TRANSITIONS,
  SOURCE_IDENTITY_FIELDS,
  BINDING_IDENTITY_COLUMNS,
  sha256,
  canonicalJoin,
  assertDurableHandle,
  verifyInstalledSchema,
  REQUIRED_SCHEMA_SHAPE,
  CLAIM_READ_SCHEMA_OBJECTS,
  applyTelegramAdmissionSchema,
  recordImmutableSource,
  claimTransportAttempt,
  recordDeliveryStarted,
  closeUnsentClaim,
  readTransportClaim,
  promoteToAdmittedOwned,
  deriveQueueAckIntentKey,
  casBindingState,
  casQueueAckState,
  heartbeatWorkClaim,
  casWorkClaimState,
  reproveDependentFacts,
};
