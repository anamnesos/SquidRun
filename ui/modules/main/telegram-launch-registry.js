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

      CREATE INDEX IF NOT EXISTS idx_tg_receipts_claim ON telegram_admission_receipts(claim_id);
      CREATE INDEX IF NOT EXISTS idx_tg_sessions_launch ON telegram_consumer_sessions(launch_id);

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

  const admissionId = isNonEmptyString(input.admissionId)
    ? input.admissionId : generateAdmissionId();

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

module.exports = {
  RECEIPT_SCHEMA,
  SUBMISSION_KINDS,
  LAUNCH_STATES,
  ENV_LAUNCH_ID,
  ENV_APP_GENERATION,
  generateLaunchId,
  generateAdmissionId,
  applyLaunchRegistrySchema,
  recordPaneLaunch,
  completePaneLaunch,
  bindConsumerSession,
  recordAdmissionReceipt,
  loadAdmissionReceipt,
};
