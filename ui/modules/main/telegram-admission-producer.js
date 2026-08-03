/**
 * THE ADMISSION PRODUCER — and, critically, one that is actually CALLED.
 *
 * =====================================================================
 * WHY THIS IS NOT `telegram-consumer-receipt-adapter.js`
 * =====================================================================
 * That adapter was hardened across two checkpoints. It was never invoked by
 * anything. `.codex/hooks.json` and `.claude/settings.json` both run
 * `model-prompt-receipt-adapter.js`, which contains no reference to Telegram at
 * all — so every guard added to the other adapter defended a code path that no
 * configured hook could reach.
 *
 * That was the third instance of one shape inside a single checkpoint: a store
 * that WROTE tables nothing read, a store that READ an identity nothing wrote,
 * and a producer nothing CALLED. Each had a green suite, because each suite
 * exercised only the side that existed.
 *
 * So this module is reached from the ALREADY-CONFIGURED adapter. The rule it
 * exists to enforce: the thing under test must be the thing that runs.
 *
 * =====================================================================
 * FAIL OPEN FOR THE PROMPT, FAIL CLOSED FOR THE RECEIPT
 * =====================================================================
 * A hook that can wedge James's pane is a worse bug than a missing receipt, so
 * every path here returns rather than throws and the caller always exits 0. But
 * a receipt is never written on partial information: no launch binding, no
 * session, no typed submission identity means NO RECEIPT, recorded with a
 * reason. Silence and refusal must stay distinguishable — reading silence as
 * "this runtime cannot prove consumption" is what cost 8.6 hours.
 */
const {
  buildAdmissionRecord,
  canonicalQueuedPayloadDigest,
} = require('./telegram-consumed-proof');
const { parseConsumeMarker } = require('./telegram-consume-marker');
const { TelegramAdmissionWriter } = require('./telegram-admission-writer');
const {
  SUBMISSION_KINDS,
  ENV_LAUNCH_ID,
  recordAdmissionReceipt,
  bindConsumerSession,
  completePaneLaunch,
} = require('./telegram-launch-registry');
const { CLAIM_STATES, applyTelegramAdmissionSchema } = require('./telegram-admission-store');

/**
 * THE SCHEMA IS ENSURED ON EVERY ENTRY, not assumed from another component.
 *
 * The binder and the producer run in short-lived hook processes that may be the
 * FIRST Telegram-lane writer this database has ever seen. Assuming the daemon
 * already applied the schema made both silently no-op against a fresh ledger:
 * the missing-table error is thrown inside the writer transaction, caught by
 * the adapter's fail-open wrapper, and the prompt sails through with no receipt
 * and no complaint. A verified effect, not an assumed one.
 */
function ensureSchema(db) {
  return applyTelegramAdmissionSchema(db);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function skip(reason, detail = null) {
  return detail === null
    ? { handled: true, written: false, reason }
    : { handled: true, written: false, reason, detail };
}

/**
 * THE TYPED SUBMISSION IDENTITY, per runtime.
 *
 * Codex hands its hook a real `turn_id` — the runtime's own unit of prompt
 * admission, which is exactly what this field is supposed to name.
 *
 * Claude's `UserPromptSubmit` payload carries `session_id` but NO per-submission
 * id. There is a tempting fix — hash the session with the pid and the clock and
 * call it a submission id — and it is the wrong one: that value is derived from
 * things we already record, so it identifies nothing new and cannot be
 * corroborated by the runtime. Inventing it would put a field in the database
 * that no real producer can emit, which is precisely the law this checkpoint
 * pinned. So Claude is declared UNSUPPORTED here, loudly and on the record,
 * until the runtime exposes a real one.
 */
function extractSubmissionIdentity(runtime, payload = {}) {
  switch (runtime) {
    case 'codex': {
      const turnId = payload.turn_id || payload.turnId || null;
      if (!isNonEmptyString(turnId)) return { ok: false, reason: 'codex_turn_id_missing' };
      return { ok: true, submissionId: String(turnId), submissionKind: SUBMISSION_KINDS.CODEX_TURN };
    }
    case 'claude': {
      // Only a REAL id from the runtime. No fallback, deliberately.
      const promptId = payload.prompt_id || payload.promptId || null;
      if (!isNonEmptyString(promptId)) {
        return { ok: false, reason: 'claude_submission_id_unsupported' };
      }
      return {
        ok: true,
        submissionId: String(promptId),
        submissionKind: SUBMISSION_KINDS.CLAUDE_PROMPT,
      };
    }
    default:
      return { ok: false, reason: `runtime_unsupported:${runtime || 'none'}` };
  }
}

function extractSessionId(runtime, payload = {}) {
  const value = payload.session_id || payload.sessionId || null;
  return isNonEmptyString(value) ? String(value) : null;
}

/**
 * Produce and durably store the admission receipt for a Telegram delivery.
 *
 * Returns `{handled:false}` for the overwhelming majority of prompts, which are
 * not Telegram deliveries at all and must not be logged.
 */
function produceAdmissionReceipt(input = {}) {
  const {
    runtime,
    payload = {},
    env = process.env,
    nowMs = Date.now(),
    writerFactory = null,
    hookProcessId = String(process.pid),
    hookParentProcessId = String(process.ppid ?? ''),
  } = input;

  const prompt = typeof payload.prompt === 'string' ? payload.prompt : null;
  if (prompt === null) return { handled: false, reason: 'no_prompt_in_payload' };

  const marker = parseConsumeMarker(prompt);
  if (!marker) return { handled: false, reason: 'not_a_telegram_delivery' };

  // PANE AND LAUNCH BINDING, both required. Same-CWD Codex sessions run in
  // panes 1 and 3, so a receipt that cannot name its pane cannot be attributed
  // to a route; and one that cannot name its LAUNCH cannot be told apart from
  // the previous process that had the same pane id.
  const paneId = String(env.SQUIDRUN_PANE_ID || '').trim();
  if (!paneId) return skip('no_pane_binding', { updateId: marker.updateId });
  const launchId = String(env[ENV_LAUNCH_ID] || '').trim();
  if (!launchId) return skip('no_launch_binding', { updateId: marker.updateId, paneId });

  const consumerSessionId = extractSessionId(runtime, payload);
  if (!consumerSessionId) return skip('no_consumer_session', { updateId: marker.updateId, paneId });

  const submission = extractSubmissionIdentity(runtime, payload);
  if (!submission.ok) return skip(submission.reason, { updateId: marker.updateId, paneId });

  if (!isNonEmptyString(hookProcessId) || !isNonEmptyString(hookParentProcessId)) {
    return skip('no_hook_process_identity', { updateId: marker.updateId });
  }

  // THE EXACT BYTES THIS CONSUMER RECEIVED — the whole prompt, marker included,
  // because that is literally what was written to the pane. Anything trimmed
  // here re-opens the truncated-but-acked hole from the other side.
  // THE ROLE THE DAEMON GAVE THIS PANE, lower-cased into the kernel's address
  // vocabulary exactly as the launch row stores it.
  const role = String(env.SQUIDRUN_ROLE || '').trim().toLowerCase();
  if (!role) return skip('no_role_binding', { updateId: marker.updateId, paneId });

  const record = buildAdmissionRecord({
    runtime,
    updateId: marker.updateId,
    messageId: marker.messageId,
    routeKey: marker.routeKey,
    windowKey: marker.windowKey,
    profile: marker.profile,
    chatId: marker.chatId,
    appGeneration: marker.appGeneration,
    queuedPayloadSha256: marker.queuedPayloadSha256,
    consumerSessionId,
    consumerTurnId: submission.submissionId,
    paneId,
    deliveredPrompt: prompt,
    consumedAtMs: nowMs,
    // FROM THE MARKER: the exact attempt this delivery belongs to.
    claimId: marker.claimId,
    attemptNonce: marker.attemptNonce,
    // FROM THE ENVIRONMENT THE DAEMON WROTE, and from this process itself.
    paneLaunchId: launchId,
    role,
    hookProcessId,
    hookParentProcessId,
    runtimeSubmissionId: submission.submissionId,
    runtimeSubmissionKind: submission.submissionKind,
  });

  const writer = writerFactory ? writerFactory() : new TelegramAdmissionWriter({});
  const opened = writer.open();
  if (!opened.ok) return skip('writer_unavailable', opened);

  try {
    return writer.transaction((db) => {
      const schema = ensureSchema(db);
      if (!schema.ok) return { ...schema, handled: true, written: false };
      const source = db.prepare('SELECT * FROM comms_journal WHERE message_id = ?')
        .get(marker.messageId);
      if (!source) return skip('source_row_missing', { messageId: marker.messageId });

      // THE EXACT CLAIM NAMED BY THE MARKER — not the newest live one.
      //
      // This used to be `ORDER BY attempt_at_ms DESC LIMIT 1`, which answers
      // "which attempt is current" rather than "which attempt wrote these
      // bytes". After a retry, or in a race, the receipt attached to the wrong
      // attempt and then passed every downstream check, because nothing else in
      // the chain knew which one it was supposed to be.
      const claim = db.prepare('SELECT * FROM telegram_transport_claims WHERE claim_id = ?')
        .get(marker.claimId);
      if (!claim) return skip('claim_not_found', { claimId: marker.claimId });
      if (Number(claim.source_row_id) !== Number(source.row_id)) {
        return skip('claim_source_mismatch', {
          claimSourceRowId: claim.source_row_id, sourceRowId: source.row_id,
        });
      }
      if (String(claim.attempt_nonce) !== String(marker.attemptNonce)) {
        return skip('claim_attempt_nonce_mismatch', {
          claimNonce: claim.attempt_nonce, markerNonce: marker.attemptNonce,
        });
      }
      if (String(claim.state) === CLAIM_STATES.CLOSED_UNSENT) {
        return skip('claim_closed_unsent', { claimId: marker.claimId });
      }
      if (String(claim.pane_launch_id) !== launchId) {
        return skip('claim_launch_mismatch', {
          claimLaunch: claim.pane_launch_id, hookLaunch: launchId,
        });
      }
      if (String(claim.role) !== role) {
        return skip('claim_role_mismatch', { claimRole: claim.role, hookRole: role });
      }

      const stored = recordAdmissionReceipt(db, {
        record,
        sourceRowId: source.row_id,
        claimId: claim.claim_id,
        launchId,
        consumerSessionId,
        hookProcessId,
        hookParentProcessId,
        runtimeSubmissionId: submission.submissionId,
        runtimeSubmissionKind: submission.submissionKind,
      });
      if (!stored.ok) return { ...stored, handled: true, written: false };

      return {
        ok: true,
        handled: true,
        written: true,
        reason: 'admission_recorded',
        admissionId: stored.admissionId,
        claimId: claim.claim_id,
        sourceRowId: source.row_id,
      };
    });
  } finally {
    writer.close();
  }
}

/**
 * SESSIONSTART: bind this runtime session to its pane launch, durably, and mark
 * the launch complete.
 *
 * The configured SessionStart hook previously wrote a shell trust breadcrumb
 * and nothing else, so no session was ever bound to any launch and every later
 * receipt had nothing to attach to.
 */
function bindSessionAtStart(input = {}) {
  const {
    runtime,
    payload = {},
    env = process.env,
    nowMs = Date.now(),
    writerFactory = null,
  } = input;

  const launchId = String(env[ENV_LAUNCH_ID] || '').trim();
  if (!launchId) return skip('no_launch_binding');
  const consumerSessionId = extractSessionId(runtime, payload);
  if (!consumerSessionId) return skip('no_consumer_session');
  if (!isNonEmptyString(runtime)) return skip('no_runtime');

  const writer = writerFactory ? writerFactory() : new TelegramAdmissionWriter({});
  const opened = writer.open();
  if (!opened.ok) return skip('writer_unavailable', opened);

  try {
    return writer.transaction((db) => {
      const schema = ensureSchema(db);
      if (!schema.ok) return { ...schema, handled: true, written: false };
      const bound = bindConsumerSession(db, {
        consumerSessionId,
        launchId,
        consumerRuntime: runtime,
        boundAtMs: nowMs,
      });
      if (!bound.ok) return { ...bound, handled: true, written: false };

      // THE COMPLETE MARKER. The runtime has started and bound itself, which is
      // the first moment the launch can be said to have finished launching.
      const completed = completePaneLaunch(db, { launchId, atMs: nowMs });
      if (!completed.ok) return { ...completed, handled: true, written: false };

      return {
        ok: true,
        handled: true,
        written: true,
        reason: 'session_bound',
        consumerSessionId,
        launchId,
      };
    });
  } finally {
    writer.close();
  }
}

module.exports = {
  produceAdmissionReceipt,
  bindSessionAtStart,
  extractSubmissionIdentity,
  extractSessionId,
  canonicalQueuedPayloadDigest,
};
