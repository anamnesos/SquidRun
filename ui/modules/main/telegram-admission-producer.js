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
  // THE TERMINAL RECORD BUILDER WAS NEVER IMPORTED. `produceTerminalReceipt`
  // called it by name at the one point in this file that writes a consumed
  // receipt, so the only path that can retire a Telegram record threw
  // ReferenceError the moment a turn actually matched an admission — which is
  // indistinguishable, from the queue's side, from a turn that simply never
  // proved anything. Every existing test stopped before that line: they end at
  // `no_telegram_admission_for_turn` or at the Claude refusal, so the happy
  // path had never once been executed. ESLint `no-undef` was reporting it the
  // whole time; the gate could not run in a worktree with no node_modules.
  buildConsumedRecord,
  canonicalQueuedPayloadDigest,
} = require('./telegram-consumed-proof');
const { parseConsumeMarker } = require('./telegram-consume-marker');
const { TelegramAdmissionWriter } = require('./telegram-admission-writer');
const {
  SUBMISSION_KINDS,
  ENV_LAUNCH_ID,
  recordAdmissionReceipt,
  loadAdmissionReceipt,
  recordConsumedReceipt,
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

/**
 * The hook events that mean A TURN ENDED.
 *
 * Deliberately a closed set of REAL runtime events, not a heuristic. There is
 * no entry for "the model emitted its last token", "the pane went quiet", or a
 * timer — each of those is an inference about consumption, and inferring
 * consumption is the family of bug that certified 2417 bytes for a 125-char
 * tail and scored poller health 100/100 over six rotting messages.
 */
const TERMINAL_HOOK_EVENTS = Object.freeze(new Set(['Stop']));

function isTerminalHookEvent(event) {
  return TERMINAL_HOOK_EVENTS.has(String(event || ''));
}

/**
 * PHASE 2 AT THE CONSUMER BOUNDARY: the turn that admitted these bytes has now
 * ended, so the admission may be promoted to terminal proof.
 *
 * =====================================================================
 * WHY THIS CANNOT BE "THE NEWEST ADMISSION FOR THIS SESSION"
 * =====================================================================
 * That is the tempting implementation and it is the same defect the admission
 * producer already had to fix once: binding a receipt to whichever claim
 * happened to be newest meant that after a retry the receipt attached to the
 * wrong attempt and passed every downstream check. A Stop event that cannot
 * name its own turn cannot say WHICH admission it terminates, and a turn is
 * exactly the unit at stake — Codex fires `UserPromptSubmit` on branches that
 * later abort, so "some turn in this session ended" is not evidence that THIS
 * turn ran.
 *
 * So a runtime whose terminal payload carries no submission identity is
 * declared unsupported here, loudly and on the record, rather than served by a
 * guess. Silence and refusal must stay distinguishable.
 */
function produceTerminalReceipt(input = {}) {
  const {
    runtime,
    payload = {},
    env = process.env,
    nowMs = Date.now(),
    writerFactory = null,
    hookProcessId = String(process.pid),
    hookParentProcessId = String(process.ppid ?? ''),
  } = input;

  const launchId = String(env[ENV_LAUNCH_ID] || '').trim();
  if (!launchId) return skip('no_launch_binding');
  const consumerSessionId = extractSessionId(runtime, payload);
  if (!consumerSessionId) return skip('no_consumer_session');

  const submission = extractSubmissionIdentity(runtime, payload);
  if (!submission.ok) return skip(`terminal_${submission.reason}`);

  if (!isNonEmptyString(hookProcessId) || !isNonEmptyString(hookParentProcessId)) {
    return skip('no_hook_process_identity');
  }

  const writer = writerFactory ? writerFactory() : new TelegramAdmissionWriter({});
  const opened = writer.open();
  if (!opened.ok) return skip('writer_unavailable', opened);

  try {
    return writer.transaction((db) => {
      const schema = ensureSchema(db);
      if (!schema.ok) return { ...schema, handled: true, written: false };

      // THE EXACT TURN. Session plus launch plus the runtime's own submission
      // id — three bindings, none of them "the latest one".
      const row = db.prepare(`
        SELECT admission_id FROM telegram_admission_receipts
        WHERE consumer_session_id = ? AND runtime_submission_id = ? AND launch_id = ?
      `).get(consumerSessionId, submission.submissionId, launchId);
      // NOT `handled`. The overwhelming majority of turns are not Telegram
      // deliveries at all, and logging every one of them as a refusal would
      // bury the refusals that matter.
      if (!row) return { handled: false, reason: 'no_telegram_admission_for_turn' };

      const loaded = loadAdmissionReceipt(db, row.admission_id);
      if (!loaded.ok) return { ...loaded, handled: true, written: false };

      const built = buildConsumedRecord({
        admissionRecord: loaded.record,
        admissionId: row.admission_id,
        terminalEvent: 'turn_completed',
        terminalAtMs: nowMs,
      });
      if (!built.ok) return { ok: false, handled: true, written: false, reason: built.reason };

      const stored = recordConsumedReceipt(db, {
        record: built.record,
        terminalHookProcessId: hookProcessId,
        terminalHookParentProcessId: hookParentProcessId,
      });
      if (!stored.ok) return { ...stored, handled: true, written: false };

      return {
        ok: true,
        handled: true,
        written: true,
        reason: stored.replayed ? 'terminal_replayed' : 'terminal_recorded',
        consumedId: stored.consumedId,
        admissionId: row.admission_id,
      };
    });
  } finally {
    writer.close();
  }
}

module.exports = {
  produceAdmissionReceipt,
  produceTerminalReceipt,
  bindSessionAtStart,
  extractSubmissionIdentity,
  extractSessionId,
  canonicalQueuedPayloadDigest,
  TERMINAL_HOOK_EVENTS,
  isTerminalHookEvent,
};
