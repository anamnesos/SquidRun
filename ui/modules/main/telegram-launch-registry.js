/**
 * THE LAUNCH / SESSION / ADMISSION REGISTRY — the identities that had no writer.
 *
 * =====================================================================
 * WHY THIS FILE EXISTS
 * =====================================================================
 * `telegram-admission-store` READ `pane_launch_id`, `consumer_session_id`,
 * `hook_process_id` and `runtime_submission_id` and refused an admission
 * without them. Production wrote none of them. The only place `pane_launch_id`
 * appeared in the whole source tree was inside the store that consumed it, and
 * the tests supplied `launch-1` and `pid-4242` — values nothing could ever
 * produce. So the store's strictest checks were unfalsifiable: no real caller
 * could pass them and no real caller could fail them.
 *
 * That is the mirror image of this checkpoint's first defect. A1 WROTE to
 * private tables nothing read; this READ an identity nothing wrote. Both had
 * green suites, because a suite only ever exercises the side that exists.
 *
 * So the identities get BUILT rather than declared unsupported:
 *
 *   telegram_pane_launches      the daemon owns it, one row per pane launch,
 *                               id generated from CSPRNG bytes at spawn
 *   telegram_consumer_sessions  the runtime's SessionStart binds its session id
 *                               to that launch, durably
 *   telegram_admission_receipts the configured UserPromptSubmit hook writes the
 *                               verbatim `telegram_admission.v1` record
 *
 * Every table here has a real producer and a real consumer. A table with only
 * one of those is the defect this file is repairing.
 *
 * =====================================================================
 * WHY THE LAUNCH ID IS RANDOM AND NOT DERIVED
 * =====================================================================
 * A derived id (generation + pane + start time, say) can be RECOMPUTED by
 * anything that knows those inputs — including a stale process, a replayed
 * receipt, or a test fixture. Then "this receipt names our launch" degrades to
 * "this receipt can do arithmetic". Random bytes cannot be recomputed; a
 * receipt can only carry this launch id by having been handed it by this
 * launch. That is the difference between an identity and a checksum.
 */
const crypto = require('node:crypto');
const {
  TERMINAL_SCHEMA,
  TERMINAL_EVENTS,
  REQUIRED_FIELDS: ADMISSION_REQUIRED_FIELDS,
} = require('./telegram-consumed-proof');

const RECEIPT_SCHEMA = 'telegram_admission.v1';

/** Typed submission identity. The runtime's own unit of prompt admission. */
const SUBMISSION_KINDS = Object.freeze({
  CODEX_TURN: 'codex_turn',
  CLAUDE_PROMPT: 'claude_prompt',
});

const LAUNCH_STATES = Object.freeze({ LAUNCHING: 'launching', COMPLETE: 'complete' });

const ENV_LAUNCH_ID = 'SQUIDRUN_PANE_LAUNCH_ID';
const ENV_APP_GENERATION = 'SQUIDRUN_APP_GENERATION';

function fail(reason, detail = null) {
  return detail === null ? { ok: false, reason } : { ok: false, reason, detail };
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/** CSPRNG, not a timestamp and not a counter. See the header. */
function generateLaunchId() {
  return `pl_${crypto.randomBytes(16).toString('hex')}`;
}

function generateAdmissionId() {
  return `adm_${crypto.randomBytes(16).toString('hex')}`;
}

/**
 * THE RECEIPT'S IDENTITY IS THE ATTEMPT IT DESCRIBES.
 *
 * Length-prefixed so no field's contents can forge a delimiter — the same
 * encoding the admission store uses, and for the same reason.
 */
function deriveAdmissionId(parts = {}) {
  const joined = [
    'telegram_admission_receipt.v1',
    parts.claimId,
    parts.attemptNonce,
    parts.deliveredPromptSha256,
    parts.runtimeSubmissionId,
  ]
    .map((part) => {
      const value = String(part ?? '');
      return `${Buffer.byteLength(value, 'utf8')}:${value}`;
    })
    .join('|');
  return `adm_${crypto.createHash('sha256').update(joined, 'utf8').digest('hex')}`;
}

/**
 * Schema for the three identity tables.
 *
 * `telegram_admission_receipts.record_json` holds the record VERBATIM. The
 * columns beside it are for joining and for DB-level constraints; the validator
 * re-reads the original bytes rather than a reconstruction, so a column drifting
 * from the record it was copied from cannot quietly become the thing we check.
 */
function applyLaunchRegistrySchema(db) {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS telegram_pane_launches (
        launch_id          TEXT    PRIMARY KEY,
        app_generation     TEXT    NOT NULL,
        pane_id            TEXT    NOT NULL,
        role               TEXT    NOT NULL,
        consumer_runtime   TEXT    NOT NULL,
        daemon_process_id  TEXT    NOT NULL,
        launched_at_ms     INTEGER NOT NULL,
        complete_at_ms     INTEGER,
        state              TEXT    NOT NULL CHECK (state IN ('launching', 'complete'))
      );

      CREATE TABLE IF NOT EXISTS telegram_consumer_sessions (
        consumer_session_id TEXT    PRIMARY KEY,
        launch_id           TEXT    NOT NULL REFERENCES telegram_pane_launches(launch_id),
        consumer_runtime    TEXT    NOT NULL,
        pane_id             TEXT    NOT NULL,
        role                TEXT    NOT NULL,
        app_generation      TEXT    NOT NULL,
        bound_at_ms         INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS telegram_admission_receipts (
        admission_id            TEXT    PRIMARY KEY,
        schema_name             TEXT    NOT NULL CHECK (schema_name = 'telegram_admission.v1'),
        source_row_id           INTEGER NOT NULL REFERENCES comms_journal(row_id),
        claim_id                TEXT    NOT NULL REFERENCES telegram_transport_claims(claim_id),
        launch_id               TEXT    NOT NULL REFERENCES telegram_pane_launches(launch_id),
        consumer_session_id     TEXT    NOT NULL REFERENCES telegram_consumer_sessions(consumer_session_id),
        pane_id                 TEXT    NOT NULL,
        role                    TEXT    NOT NULL,
        consumer_runtime        TEXT    NOT NULL,
        app_generation          TEXT    NOT NULL,
        hook_process_id         TEXT    NOT NULL,
        hook_parent_process_id  TEXT    NOT NULL,
        runtime_submission_id   TEXT    NOT NULL,
        runtime_submission_kind TEXT    NOT NULL CHECK (
          runtime_submission_kind IN ('codex_turn', 'claude_prompt')
        ),
        update_id               INTEGER NOT NULL,
        message_id              TEXT    NOT NULL,
        route_key               TEXT    NOT NULL,
        window_key              TEXT    NOT NULL,
        profile                 TEXT    NOT NULL,
        chat_id                 TEXT    NOT NULL,
        queued_payload_sha256   TEXT    NOT NULL,
        delivered_prompt_sha256 TEXT    NOT NULL,
        delivered_prompt_bytes  INTEGER NOT NULL,
        admitted_at_ms          INTEGER NOT NULL,
        record_json             TEXT    NOT NULL
      );

      -- ===================================================================
      -- THE TERMINAL RECEIPT. The only row in this database that may retire a
      -- Telegram ingress record on the automatic path.
      --
      -- admission_id is UNIQUE and is the whole duplicate-suppression story:
      -- one set of admitted bytes can be terminated exactly once, enforced by
      -- the database rather than by whichever caller remembers to check. A hook
      -- that fires twice for one turn collides here; a byte-identical replay is
      -- recognised as a replay, and a conflicting second account quarantines
      -- the route instead of overwriting the first.
      --
      -- THE TERMINAL HOOK'S OWN PROCESS IDENTITY IS SEPARATE, and deliberately
      -- so. record_json carries the ADMISSION hook's process identity because
      -- that is what the admitted evidence asserted; these two columns carry
      -- the identity of the process that witnessed the turn end. Collapsing
      -- them would let a terminal write describe itself using the admission's
      -- credentials, which is the same borrowed-identity shape the record
      -- fields exist to close.
      -- ===================================================================
      CREATE TABLE IF NOT EXISTS telegram_consumed_receipts (
        consumed_id                    TEXT    PRIMARY KEY,
        schema_name                    TEXT    NOT NULL CHECK (schema_name = 'telegram_consumed.v1'),
        admission_id                   TEXT    NOT NULL UNIQUE
                                         REFERENCES telegram_admission_receipts(admission_id),
        source_row_id                  INTEGER NOT NULL REFERENCES comms_journal(row_id),
        claim_id                       TEXT    NOT NULL REFERENCES telegram_transport_claims(claim_id),
        launch_id                      TEXT    NOT NULL REFERENCES telegram_pane_launches(launch_id),
        consumer_session_id            TEXT    NOT NULL
                                         REFERENCES telegram_consumer_sessions(consumer_session_id),
        pane_id                        TEXT    NOT NULL,
        role                           TEXT    NOT NULL,
        consumer_runtime               TEXT    NOT NULL,
        app_generation                 TEXT    NOT NULL,
        terminal_hook_process_id       TEXT    NOT NULL,
        terminal_hook_parent_process_id TEXT   NOT NULL,
        runtime_submission_id          TEXT    NOT NULL,
        runtime_submission_kind        TEXT    NOT NULL CHECK (
          runtime_submission_kind IN ('codex_turn', 'claude_prompt')
        ),
        terminal_event                 TEXT    NOT NULL CHECK (terminal_event IN ('turn_completed')),
        update_id                      INTEGER NOT NULL,
        message_id                     TEXT    NOT NULL,
        route_key                      TEXT    NOT NULL,
        window_key                     TEXT    NOT NULL,
        profile                        TEXT    NOT NULL,
        chat_id                        TEXT    NOT NULL,
        queued_payload_sha256          TEXT    NOT NULL,
        delivered_prompt_sha256        TEXT    NOT NULL,
        delivered_prompt_bytes         INTEGER NOT NULL,
        admitted_at_ms                 INTEGER NOT NULL,
        terminal_at_ms                 INTEGER NOT NULL,
        record_json                    TEXT    NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tg_receipts_claim ON telegram_admission_receipts(claim_id);
      CREATE INDEX IF NOT EXISTS idx_tg_sessions_launch ON telegram_consumer_sessions(launch_id);
      -- THE DRAIN'S LOOKUP KEY. It asks "is there terminal proof for THIS
      -- message on THIS route", which is exactly this pair and nothing wider.
      CREATE INDEX IF NOT EXISTS idx_tg_consumed_lookup
        ON telegram_consumed_receipts(route_key, message_id);

      -- ===================================================================
      -- IDENTITY IMMUTABILITY AT THE DATABASE BOUNDARY.
      --
      -- Every check in this file constrains one writer: the functions below.
      -- A receipt whose record_json can be rewritten after the fact is not
      -- evidence of what the consumer saw, it is evidence of what the last
      -- writer preferred — and validateAdmissionRecord would then be
      -- validating a forgery with complete rigour.
      --
      -- A LAUNCH MAY COMPLETE. Nothing else about it may move.
      -- ===================================================================
      CREATE TRIGGER IF NOT EXISTS trg_tg_launch_identity_immutable
      BEFORE UPDATE ON telegram_pane_launches
      FOR EACH ROW WHEN (
           OLD.launch_id         IS NOT NEW.launch_id
        OR OLD.app_generation    IS NOT NEW.app_generation
        OR OLD.pane_id           IS NOT NEW.pane_id
        OR OLD.role              IS NOT NEW.role
        OR OLD.consumer_runtime  IS NOT NEW.consumer_runtime
        OR OLD.daemon_process_id IS NOT NEW.daemon_process_id
        OR OLD.launched_at_ms    IS NOT NEW.launched_at_ms
      )
      BEGIN SELECT RAISE(ABORT, 'telegram_launch_identity_immutable'); END;

      CREATE TRIGGER IF NOT EXISTS trg_tg_launch_no_delete
      BEFORE DELETE ON telegram_pane_launches
      BEGIN SELECT RAISE(ABORT, 'telegram_launch_delete_forbidden'); END;

      -- A SESSION BINDING IS WHOLLY IMMUTABLE. Re-pointing one to another
      -- launch is how a stale pane would adopt a live session.
      CREATE TRIGGER IF NOT EXISTS trg_tg_session_immutable
      BEFORE UPDATE ON telegram_consumer_sessions
      BEGIN SELECT RAISE(ABORT, 'telegram_consumer_session_immutable'); END;

      CREATE TRIGGER IF NOT EXISTS trg_tg_session_no_delete
      BEFORE DELETE ON telegram_consumer_sessions
      BEGIN SELECT RAISE(ABORT, 'telegram_consumer_session_delete_forbidden'); END;

      -- THE RECEIPT IS THE EVIDENCE. It never changes and it is never removed.
      CREATE TRIGGER IF NOT EXISTS trg_tg_receipt_immutable
      BEFORE UPDATE ON telegram_admission_receipts
      BEGIN SELECT RAISE(ABORT, 'telegram_admission_receipt_immutable'); END;

      CREATE TRIGGER IF NOT EXISTS trg_tg_receipt_no_delete
      BEFORE DELETE ON telegram_admission_receipts
      BEGIN SELECT RAISE(ABORT, 'telegram_admission_receipt_delete_forbidden'); END;

      -- THE TERMINAL RECEIPT IS THE RETIREMENT AUTHORITY. If it can be edited,
      -- then anything that can write to this database can retire any of James's
      -- messages after the fact, and the validator would certify the edit.
      CREATE TRIGGER IF NOT EXISTS trg_tg_consumed_immutable
      BEFORE UPDATE ON telegram_consumed_receipts
      BEGIN SELECT RAISE(ABORT, 'telegram_consumed_receipt_immutable'); END;

      CREATE TRIGGER IF NOT EXISTS trg_tg_consumed_no_delete
      BEFORE DELETE ON telegram_consumed_receipts
      BEGIN SELECT RAISE(ABORT, 'telegram_consumed_receipt_delete_forbidden'); END;
    `);
  } catch (err) {
    return fail('launch_registry_schema_failed', { message: err.message });
  }
  return { ok: true };
}

/**
 * THE DAEMON'S OWN LAUNCH RECORD. Written at pane spawn, before the runtime
 * exists, by the only component that knows a launch is happening.
 *
 * Returns the id so the caller can put it in the pane's environment — that
 * hand-off is the entire mechanism by which a hook can later name its launch.
 */
function recordPaneLaunch(db, input = {}) {
  const required = ['appGeneration', 'paneId', 'role', 'consumerRuntime', 'daemonProcessId'];
  for (const field of required) {
    if (!isNonEmptyString(String(input[field] ?? ''))) {
      return fail(`launch_field_missing:${field}`);
    }
  }
  const launchedAtMs = Number(input.launchedAtMs);
  if (!Number.isSafeInteger(launchedAtMs) || launchedAtMs <= 0) {
    return fail('launch_field_missing:launchedAtMs');
  }
  const launchId = isNonEmptyString(input.launchId) ? input.launchId : generateLaunchId();

  try {
    db.prepare(`
      INSERT INTO telegram_pane_launches (
        launch_id, app_generation, pane_id, role, consumer_runtime,
        daemon_process_id, launched_at_ms, complete_at_ms, state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
    `).run(
      launchId, String(input.appGeneration), String(input.paneId), String(input.role),
      String(input.consumerRuntime), String(input.daemonProcessId), launchedAtMs,
      LAUNCH_STATES.LAUNCHING
    );
  } catch (err) {
    return fail('launch_insert_failed', { message: err.message });
  }
  return { ok: true, launchId, state: LAUNCH_STATES.LAUNCHING };
}

/**
 * THE COMPLETE MARKER. A launch that never completed cannot vouch for a
 * session: the pane may have died during startup, and a receipt naming a
 * half-built launch describes a consumer that was never ready to consume.
 */
function completePaneLaunch(db, input = {}) {
  if (!isNonEmptyString(input.launchId)) return fail('launch_field_missing:launchId');
  const atMs = Number(input.atMs);
  if (!Number.isSafeInteger(atMs) || atMs <= 0) return fail('launch_field_missing:atMs');

  const row = db.prepare('SELECT * FROM telegram_pane_launches WHERE launch_id = ?').get(input.launchId);
  if (!row) return fail('launch_not_found');
  if (row.state === LAUNCH_STATES.COMPLETE) {
    return { ok: true, launchId: input.launchId, state: LAUNCH_STATES.COMPLETE, created: false };
  }
  if (atMs < Number(row.launched_at_ms)) {
    return fail('launch_complete_before_launch', { atMs, launchedAtMs: row.launched_at_ms });
  }
  try {
    db.prepare('UPDATE telegram_pane_launches SET state = ?, complete_at_ms = ? WHERE launch_id = ?')
      .run(LAUNCH_STATES.COMPLETE, atMs, input.launchId);
  } catch (err) {
    return fail('launch_complete_failed', { message: err.message });
  }
  return { ok: true, launchId: input.launchId, state: LAUNCH_STATES.COMPLETE, created: true };
}

/**
 * DURABLE SESSION BINDING, written by the runtime's SessionStart hook.
 *
 * The runtime's session id is the only handle a UserPromptSubmit hook has on
 * "which consumer am I". Binding it to a launch here is what later lets an
 * admission receipt be attributed to a pane at all. Re-binding the same session
 * to a DIFFERENT launch is a hard conflict, never an update: one session cannot
 * belong to two launches, and quietly rewriting it would let a stale pane adopt
 * a live session.
 */
function bindConsumerSession(db, input = {}) {
  const required = ['consumerSessionId', 'launchId', 'consumerRuntime'];
  for (const field of required) {
    if (!isNonEmptyString(input[field])) return fail(`session_field_missing:${field}`);
  }
  const boundAtMs = Number(input.boundAtMs);
  if (!Number.isSafeInteger(boundAtMs) || boundAtMs <= 0) {
    return fail('session_field_missing:boundAtMs');
  }

  const launch = db.prepare('SELECT * FROM telegram_pane_launches WHERE launch_id = ?')
    .get(input.launchId);
  if (!launch) return fail('session_launch_unknown', { launchId: input.launchId });
  if (String(launch.consumer_runtime) !== String(input.consumerRuntime)) {
    return fail('session_runtime_mismatch', {
      launchRuntime: launch.consumer_runtime, offered: input.consumerRuntime,
    });
  }
  if (boundAtMs < Number(launch.launched_at_ms)) {
    return fail('session_bound_before_launch');
  }

  const existing = db.prepare(
    'SELECT * FROM telegram_consumer_sessions WHERE consumer_session_id = ?'
  ).get(input.consumerSessionId);
  if (existing) {
    if (String(existing.launch_id) !== String(input.launchId)) {
      return fail('session_launch_conflict', {
        stored: existing.launch_id, offered: input.launchId,
      });
    }
    return { ok: true, consumerSessionId: input.consumerSessionId, created: false };
  }

  try {
    db.prepare(`
      INSERT INTO telegram_consumer_sessions (
        consumer_session_id, launch_id, consumer_runtime, pane_id, role,
        app_generation, bound_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.consumerSessionId, input.launchId, String(input.consumerRuntime),
      String(launch.pane_id), String(launch.role), String(launch.app_generation), boundAtMs
    );
  } catch (err) {
    return fail('session_insert_failed', { message: err.message });
  }
  return { ok: true, consumerSessionId: input.consumerSessionId, created: true };
}

/**
 * STORE THE ADMISSION RECEIPT, written by the configured UserPromptSubmit hook.
 *
 * This is the durable `telegram_admission.v1` row that `promoteToAdmittedOwned`
 * later loads and validates. Before this existed, promotion accepted an
 * `admissionId` that was any non-empty string at all.
 *
 * The launch must be COMPLETE and the session must belong to it. Both are
 * checked here at write time AND re-checked at promotion — a producer-side
 * check alone would only constrain honest producers, and the raw-SQL adversarial
 * cases exist precisely because not every writer is this function.
 */
function recordAdmissionReceipt(db, input = {}) {
  const record = input.record;
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return fail('receipt_record_missing');
  }
  if (record.schema !== RECEIPT_SCHEMA) {
    return fail('receipt_wrong_schema', { schema: record.schema || null });
  }
  const required = [
    'claimId', 'launchId', 'consumerSessionId', 'hookProcessId',
    'hookParentProcessId', 'runtimeSubmissionId', 'runtimeSubmissionKind',
  ];
  for (const field of required) {
    if (!isNonEmptyString(String(input[field] ?? ''))) {
      return fail(`receipt_field_missing:${field}`);
    }
  }
  if (!Object.values(SUBMISSION_KINDS).includes(String(input.runtimeSubmissionKind))) {
    return fail('receipt_submission_kind_invalid', { kind: input.runtimeSubmissionKind });
  }
  if (!Number.isSafeInteger(Number(input.sourceRowId)) || Number(input.sourceRowId) <= 0) {
    return fail('receipt_field_missing:sourceRowId');
  }
  const admittedAtMs = Number(record.consumedAtMs);
  if (!Number.isSafeInteger(admittedAtMs) || admittedAtMs <= 0) {
    return fail('receipt_field_missing:consumedAtMs');
  }

  const launch = db.prepare('SELECT * FROM telegram_pane_launches WHERE launch_id = ?')
    .get(input.launchId);
  if (!launch) return fail('receipt_launch_unknown');
  if (launch.state !== LAUNCH_STATES.COMPLETE) {
    return fail('receipt_launch_incomplete', { state: launch.state });
  }
  const session = db.prepare(
    'SELECT * FROM telegram_consumer_sessions WHERE consumer_session_id = ?'
  ).get(input.consumerSessionId);
  if (!session) return fail('receipt_session_unknown');
  if (String(session.launch_id) !== String(input.launchId)) {
    return fail('receipt_session_launch_mismatch', {
      sessionLaunch: session.launch_id, offered: input.launchId,
    });
  }

  // ===================================================================
  // ONE ATTEMPT, ONE RECEIPT IDENTITY.
  //
  // This used to mint a fresh random id on every call, so a hook that fired
  // twice for one attempt produced two equally-valid receipts and nothing could
  // tell a byte-exact replay from a conflicting second account of the same
  // delivery. The id is now DERIVED from the attempt it describes, which makes
  // the primary key itself the idempotency check: an exact replay collides and
  // is compared; a conflicting one is refused and quarantines the route.
  //
  // `input.admissionId` is still accepted, and still checked against the
  // derivation, so a caller cannot name a receipt something the attempt would
  // not produce.
  // ===================================================================
  const derivedAdmissionId = deriveAdmissionId({
    claimId: input.claimId,
    attemptNonce: record.attemptNonce,
    deliveredPromptSha256: record.deliveredPromptSha256,
    runtimeSubmissionId: input.runtimeSubmissionId,
  });
  if (isNonEmptyString(input.admissionId) && String(input.admissionId) !== derivedAdmissionId) {
    return fail('receipt_admission_id_not_derivable', {
      offered: input.admissionId, recomputed: derivedAdmissionId,
    });
  }
  const admissionId = derivedAdmissionId;

  const priorReceipt = db.prepare('SELECT * FROM telegram_admission_receipts WHERE admission_id = ?')
    .get(admissionId);
  if (priorReceipt) {
    // BYTE-FOR-BYTE, on the verbatim record. Anything less would let a second
    // account of the same attempt pass as a replay of the first.
    if (String(priorReceipt.record_json) === JSON.stringify(record)
      && String(priorReceipt.claim_id) === String(input.claimId)
      && String(priorReceipt.consumer_session_id) === String(input.consumerSessionId)
      && String(priorReceipt.runtime_submission_id) === String(input.runtimeSubmissionId)
      && String(priorReceipt.hook_process_id) === String(input.hookProcessId)
      && String(priorReceipt.hook_parent_process_id) === String(input.hookParentProcessId)
      && Number(priorReceipt.source_row_id) === Number(input.sourceRowId)) {
      return { ok: true, admissionId, admittedAtMs, replayed: true };
    }
    return fail('receipt_conflicting_duplicate_quarantine', {
      admissionId,
      storedClaimId: priorReceipt.claim_id,
      storedSessionId: priorReceipt.consumer_session_id,
    });
  }

  try {
    db.prepare(`
      INSERT INTO telegram_admission_receipts (
        admission_id, schema_name, source_row_id, claim_id, launch_id,
        consumer_session_id, pane_id, role, consumer_runtime, app_generation,
        hook_process_id, hook_parent_process_id, runtime_submission_id,
        runtime_submission_kind, update_id, message_id, route_key, window_key,
        profile, chat_id, queued_payload_sha256, delivered_prompt_sha256,
        delivered_prompt_bytes, admitted_at_ms, record_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      admissionId, RECEIPT_SCHEMA, Number(input.sourceRowId), input.claimId,
      input.launchId, input.consumerSessionId, String(session.pane_id),
      String(session.role), String(session.consumer_runtime),
      String(session.app_generation), String(input.hookProcessId),
      String(input.hookParentProcessId), String(input.runtimeSubmissionId),
      String(input.runtimeSubmissionKind), Number(record.updateId),
      String(record.messageId), String(record.routeKey), String(record.windowKey),
      String(record.profile), String(record.chatId),
      String(record.queuedPayloadSha256), String(record.deliveredPromptSha256),
      Number(record.deliveredPromptBytes), admittedAtMs,
      JSON.stringify(record)
    );
  } catch (err) {
    return fail('receipt_insert_failed', { message: err.message });
  }
  return { ok: true, admissionId, admittedAtMs };
}

/** Load a receipt and its joined identity tuple. Consumed at promotion. */
function loadAdmissionReceipt(db, admissionId) {
  if (!isNonEmptyString(admissionId)) return fail('receipt_field_missing:admissionId');
  const row = db.prepare('SELECT * FROM telegram_admission_receipts WHERE admission_id = ?')
    .get(admissionId);
  if (!row) return fail('admission_receipt_not_found', { admissionId });

  let record = null;
  try {
    record = JSON.parse(row.record_json);
  } catch (err) {
    return fail('admission_receipt_unparsable', { message: err.message });
  }
  if (!record || typeof record !== 'object') return fail('admission_receipt_unparsable');

  const launch = db.prepare('SELECT * FROM telegram_pane_launches WHERE launch_id = ?')
    .get(row.launch_id);
  if (!launch) return fail('admission_launch_missing', { launchId: row.launch_id });
  const session = db.prepare(
    'SELECT * FROM telegram_consumer_sessions WHERE consumer_session_id = ?'
  ).get(row.consumer_session_id);
  if (!session) return fail('admission_session_missing', { sessionId: row.consumer_session_id });

  return { ok: true, row, record, launch, session };
}

/**
 * THE TERMINAL RECEIPT'S IDENTITY IS THE ADMISSION IT TERMINATES.
 *
 * Deliberately NOT keyed on the terminal timestamp. A hook that fires twice for
 * one turn — a retry, a supervisor re-run, a duplicated Stop event — would
 * otherwise mint two different ids for the same fact, and both would be equally
 * valid rows describing one delivery. Keying on the admission plus the typed
 * submission and the event kind makes the second write a COLLISION, which is
 * the only place idempotency can be decided honestly.
 */
function deriveConsumedId(parts = {}) {
  const joined = [
    'telegram_consumed_receipt.v1',
    parts.admissionId,
    parts.runtimeSubmissionId,
    parts.terminalEvent,
  ]
    .map((part) => {
      const value = String(part ?? '');
      return `${Buffer.byteLength(value, 'utf8')}:${value}`;
    })
    .join('|');
  return `con_${crypto.createHash('sha256').update(joined, 'utf8').digest('hex')}`;
}

/**
 * Store the terminal record for an admission whose turn has ended.
 *
 * WHAT THIS REFUSES, AND WHY EACH REFUSAL IS THE POINT:
 *  - no admission row: a terminal record with nothing under it is an assertion
 *    that some bytes were consumed, with no evidence that any bytes arrived;
 *  - any shared field differing from the admission record: the terminal record
 *    is a COPY, so a difference means one of the two is describing a different
 *    delivery and there is no safe rule for choosing;
 *  - a terminal hook whose parent process is not the runtime process that
 *    admitted: a different process cannot witness this turn ending.
 */
function recordConsumedReceipt(db, input = {}) {
  const record = input.record;
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return fail('consumed_record_missing');
  }
  if (record.schema !== TERMINAL_SCHEMA) {
    return fail('consumed_wrong_schema', { schema: record.schema || null });
  }
  if (!TERMINAL_EVENTS.has(String(record.terminalEvent))) {
    return fail('consumed_terminal_event_unrecognised', { event: record.terminalEvent || null });
  }
  for (const field of ['terminalHookProcessId', 'terminalHookParentProcessId']) {
    if (!isNonEmptyString(String(input[field] ?? ''))) {
      return fail(`consumed_field_missing:${field}`);
    }
  }
  const terminalAtMs = Number(record.terminalAtMs);
  if (!Number.isSafeInteger(terminalAtMs) || terminalAtMs <= 0) {
    return fail('consumed_field_missing:terminalAtMs');
  }

  const loaded = loadAdmissionReceipt(db, record.admissionId);
  if (!loaded.ok) return loaded;
  const admission = loaded.record;

  // FIELD-BY-FIELD AGAINST THE STORED ADMISSION RECORD. Driven by the schema's
  // own field list so a field added to admission tomorrow is compared here
  // automatically rather than silently exempted.
  for (const field of ADMISSION_REQUIRED_FIELDS) {
    if (field === 'schema' || field === 'proofClass') continue;
    if (String(record[field] ?? '') !== String(admission[field] ?? '')) {
      return fail('consumed_admission_field_mismatch', {
        field,
        admitted: admission[field] ?? null,
        terminal: record[field] ?? null,
      });
    }
  }
  if (terminalAtMs < Number(loaded.row.admitted_at_ms)) {
    return fail('consumed_predates_admission', {
      admittedAtMs: loaded.row.admitted_at_ms, terminalAtMs,
    });
  }
  // THE SAME RUNTIME PROCESS. The admission hook and the terminal hook are two
  // short-lived processes, but both are spawned BY the runtime, so they share a
  // parent. A terminal write from anywhere else is another process claiming to
  // have watched this turn end.
  if (String(input.terminalHookParentProcessId) !== String(loaded.row.hook_parent_process_id)) {
    return fail('consumed_hook_parent_mismatch', {
      admissionParent: loaded.row.hook_parent_process_id,
      terminalParent: input.terminalHookParentProcessId,
    });
  }

  const consumedId = deriveConsumedId({
    admissionId: record.admissionId,
    runtimeSubmissionId: loaded.row.runtime_submission_id,
    terminalEvent: record.terminalEvent,
  });

  // THE ADMISSION-LEVEL CHECK RUNS FIRST, AND EXPLICITLY.
  //
  // The UNIQUE index on admission_id is the real backstop, but relying on it
  // alone means the refusal arrives as a driver error MESSAGE — and this
  // repository runs two SQLite drivers (node:sqlite for CLI, better-sqlite3
  // inside Electron's Node 18). Deciding a safety invariant by substring-
  // matching an exception text is a check that can quietly stop matching after
  // a dependency bump, in the direction that retires a message twice. So the
  // condition is asked as a query, and the index stays as the thing that is
  // true even if this code is bypassed.
  const priorForAdmission = db.prepare(
    'SELECT consumed_id FROM telegram_consumed_receipts WHERE admission_id = ?'
  ).get(record.admissionId);
  if (priorForAdmission && String(priorForAdmission.consumed_id) !== consumedId) {
    return fail('consumed_admission_already_terminated', {
      admissionId: record.admissionId,
      storedConsumedId: priorForAdmission.consumed_id,
    });
  }

  const prior = db.prepare('SELECT * FROM telegram_consumed_receipts WHERE consumed_id = ?')
    .get(consumedId);
  if (prior) {
    if (String(prior.record_json) === JSON.stringify(record)
      && String(prior.admission_id) === String(record.admissionId)
      && String(prior.terminal_hook_process_id) === String(input.terminalHookProcessId)
      && String(prior.terminal_hook_parent_process_id) === String(input.terminalHookParentProcessId)) {
      return { ok: true, consumedId, terminalAtMs: Number(prior.terminal_at_ms), replayed: true };
    }
    return fail('consumed_conflicting_duplicate_quarantine', {
      consumedId, storedAdmissionId: prior.admission_id,
    });
  }

  try {
    db.prepare(`
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
      consumedId, TERMINAL_SCHEMA, String(record.admissionId),
      Number(loaded.row.source_row_id), String(loaded.row.claim_id),
      String(loaded.row.launch_id), String(loaded.row.consumer_session_id),
      String(loaded.row.pane_id), String(loaded.row.role),
      String(loaded.row.consumer_runtime), String(loaded.row.app_generation),
      String(input.terminalHookProcessId), String(input.terminalHookParentProcessId),
      String(loaded.row.runtime_submission_id), String(loaded.row.runtime_submission_kind),
      String(record.terminalEvent), Number(loaded.row.update_id),
      String(loaded.row.message_id), String(loaded.row.route_key),
      String(loaded.row.window_key), String(loaded.row.profile),
      String(loaded.row.chat_id), String(loaded.row.queued_payload_sha256),
      String(loaded.row.delivered_prompt_sha256), Number(loaded.row.delivered_prompt_bytes),
      Number(loaded.row.admitted_at_ms), terminalAtMs, JSON.stringify(record)
    );
  } catch (err) {
    // Reached only if the explicit check above was bypassed or raced. The
    // message is REPORTED, never parsed for a verdict.
    return fail('consumed_insert_failed', { message: err.message });
  }
  return { ok: true, consumedId, terminalAtMs };
}

/**
 * THE DRAIN'S READ. Returns the stored terminal record VERBATIM, or a structural
 * reason why there is none.
 *
 * It filters and it parses. It does not build, complete, or decorate: every
 * identity field the caller will go on to compare must already be inside
 * `record`, written by a consumer boundary that actually saw the bytes. That
 * restriction is the whole difference between this and the lookup it replaces.
 */
function findConsumedReceipt(db, query = {}) {
  const messageId = String(query.messageId ?? '').trim();
  const routeKey = String(query.routeKey ?? '').trim();
  if (!messageId) return fail('consumed_query_missing:messageId');
  if (!routeKey) return fail('consumed_query_missing:routeKey');

  // ABSENT TABLE IS NOT AN UNREADABLE TABLE, and the difference decides whether
  // a message is delivered or held forever.
  //
  // A ledger with no terminal table has never had a terminal receipt written to
  // it — on a fresh install that is every ledger, before the first admission.
  // Letting that surface as a query FAILURE would make the lookup throw, the
  // drain hold, and the very first Telegram message wedge the queue: the S491
  // outage, faithfully reproduced one layer over.
  //
  // Reading absence as "no proof yet" is safe here for a reason that is NOT
  // "probably fine": re-delivery is not gated by this store at all. The durable
  // attempt latch is what refuses to inject a record that was already attempted,
  // and it lives in its own sidecar. So a missing proof store can cost us a hold
  // for a genuinely-delivered message, which is recoverable and visible; it
  // cannot cost James a duplicate.
  let tableExists;
  try {
    tableExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'telegram_consumed_receipts'"
    ).get();
  } catch (err) {
    return fail('consumed_query_failed', { message: err.message });
  }
  if (!tableExists) return fail('consumed_receipt_absent', { messageId, routeKey, tableAbsent: true });

  let rows;
  try {
    rows = db.prepare(
      'SELECT * FROM telegram_consumed_receipts WHERE message_id = ? AND route_key = ?'
    ).all(messageId, routeKey);
  } catch (err) {
    return fail('consumed_query_failed', { message: err.message });
  }
  if (!rows || rows.length === 0) return fail('consumed_receipt_absent', { messageId, routeKey });
  // MORE THAN ONE is ambiguity, and ambiguity is refusal. Two terminal records
  // for one message on one route means two turns each claim to have consumed
  // it, and picking either would be picking which account of James's message to
  // believe.
  if (rows.length > 1) {
    return fail('consumed_receipt_ambiguous', { messageId, routeKey, count: rows.length });
  }

  let record = null;
  try {
    record = JSON.parse(rows[0].record_json);
  } catch (err) {
    return fail('consumed_receipt_unparsable', { message: err.message });
  }
  if (!record || typeof record !== 'object') return fail('consumed_receipt_unparsable');
  return { ok: true, row: rows[0], record };
}

module.exports = {
  RECEIPT_SCHEMA,
  SUBMISSION_KINDS,
  LAUNCH_STATES,
  ENV_LAUNCH_ID,
  ENV_APP_GENERATION,
  generateLaunchId,
  generateAdmissionId,
  deriveAdmissionId,
  deriveConsumedId,
  applyLaunchRegistrySchema,
  recordPaneLaunch,
  completePaneLaunch,
  bindConsumerSession,
  recordAdmissionReceipt,
  loadAdmissionReceipt,
  recordConsumedReceipt,
  findConsumedReceipt,
};
