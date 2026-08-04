/**
 * EXACT CONSUMPTION PROOF for Telegram ingress, and the honest answer to
 * "could this message ever be proven at all?".
 *
 * WHY THIS MODULE EXISTS (S491). The ordered drain retires a record only on
 * proven downstream ownership. That is right. What went wrong is that the proof
 * bar was, for one pane runtime, STRUCTURALLY UNREACHABLE — and nothing in the
 * system could tell the difference between "proof has not arrived yet" and
 * "proof can never arrive here". Update 808499316 latched `attempted`, waited
 * for a receipt that no component was capable of writing, and silently held six
 * of James's messages — including live plumbing job instructions — for 8.6
 * hours while poller health read 100/100.
 *
 * THE FIX IS NOT A LOWER BAR. An earlier attempt (40ff94f7, reverted at
 * 152e1a46) let an unprovable record be bypassed so later messages could pass.
 * That was wrong on the merits: inbound messages are NOT independent. Live
 * update 808499318 is "Not the tankless job the other one" — a correction whose
 * entire meaning lives in 808499317. Delivering it alone does not degrade the
 * message, it INVERTS it, and points James's business at the wrong job. Order
 * is load-bearing here, so holding stays holding.
 *
 * What changes is that a hold now knows WHY it is holding, and says so loudly
 * enough that nobody waits eight hours to find out.
 *
 * =====================================================================
 * ATTAINABILITY IS MEASURED, NEVER ASSUMED FROM CONFIGURATION
 * =====================================================================
 * The obvious probe — "is the receipt hook configured for this runtime?" — is
 * a trap, and this repo contains the proof that it is. At the time of writing:
 *
 *   .codex/hooks.json      UserPromptSubmit -> model-prompt-receipt-adapter  ✓
 *   ~/.codex/hooks.json    SessionStart, Stop only                           ✗
 *   receipts.jsonl         2194 receipts, runtime=claude for 2194 of them    ✗ codex
 *
 * The codex hook is CONFIGURED and has produced exactly zero receipts, ever.
 * A config-reading probe would have called that runtime "provable" and
 * reproduced the outage with more confidence. So attainability is decided by
 * OBSERVED RECEIPT FLOW: has this runtime actually written a receipt recently?
 * Execution beats metadata. A mechanism that has never fired is not a mechanism.
 *
 * This is also what makes the module runtime-NEUTRAL. It privileges no runtime
 * and hardcodes no hook layout; every runtime faces the identical evidentiary
 * test, and a runtime nobody has integrated yet fails it the same way codex
 * does — loudly, not silently.
 */

/**
 * How recently a runtime must have produced ANY receipt before we will believe
 * it is capable of producing one now.
 *
 * Deliberately generous. This is not a liveness check on the current message;
 * it answers the much coarser question "is this proof channel wired up at all".
 * A pane that has been idle all morning is still perfectly provable, so the
 * window has to comfortably exceed a quiet stretch without going so wide that a
 * channel broken days ago still reads as healthy.
 */
const PROOF_CAPABILITY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Every field that must be present AND equal for evidence to be proof of THIS
 * message's consumption.
 *
 * `chatId` and `generation` are the two S491 additions. chatId because a route
 * can be re-pointed between append and delivery, and proof for a chat we no
 * longer deliver to proves nothing about where the message actually went.
 * generation because an in-memory latch dies with the process and a receipt
 * that predates the attempt it supposedly proves is not proof — it is an older
 * receipt for an older delivery of the same id.
 */
const EXACT_PROOF_FIELDS = Object.freeze([
  'messageId',
  'routeKey',
  'windowKey',
  'profile',
  'chatId',
  'generation',
]);

/** Reasons a hold is a CONFIGURATION DEFECT rather than ordinary waiting. */
const UNATTAINABLE_REASONS = Object.freeze(new Set([
  'runtime_unknown',
  'runtime_never_produced_proof',
  'runtime_proof_stale',
]));

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Compare two identity values without letting type coercion decide it.
 *
 * chatId arrives as a number from Telegram and as a string from some journal
 * rows, so an === on the raw values would reject correct proof; == would accept
 * `0` for `''`. Normalising both sides to trimmed strings and requiring both to
 * be present is the narrow middle that neither over- nor under-matches.
 */
function identityEquals(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if (typeof a === 'object' || typeof b === 'object') return false;
  const left = String(a).trim();
  const right = String(b).trim();
  if (!left || !right) return false;
  return left === right;
}

/**
 * Is exact consumption proof even POSSIBLE for this pane runtime right now?
 *
 * @param {object} input
 *   runtime          the pane runtime name, e.g. 'claude' | 'codex'
 *   receiptActivity  Map|object of runtime -> last receipt timestamp in ms.
 *                    Built from the receipt store's OWN records, never config.
 *   nowMs
 *   windowMs         optional override of PROOF_CAPABILITY_WINDOW_MS
 * @returns {{attainable: boolean, reason: string, runtime: string|null, lastProofAtMs: number|null}}
 */
function probeRuntimeProofCapability(input = {}) {
  const runtime = isNonEmptyString(input.runtime) ? input.runtime.trim().toLowerCase() : null;
  if (!runtime) {
    return { attainable: false, reason: 'runtime_unknown', runtime: null, lastProofAtMs: null };
  }
  const windowMs = Number.isFinite(Number(input.windowMs)) && Number(input.windowMs) > 0
    ? Number(input.windowMs)
    : PROOF_CAPABILITY_WINDOW_MS;
  const nowMs = Number(input.nowMs);
  if (!Number.isFinite(nowMs)) {
    // No clock, no judgement. Claiming capability here would be a guess in the
    // one direction that retires messages.
    return { attainable: false, reason: 'runtime_unknown', runtime, lastProofAtMs: null };
  }

  const activity = input.receiptActivity;
  let lastProofAtMs = null;
  if (activity instanceof Map) {
    lastProofAtMs = activity.get(runtime) ?? null;
  } else if (activity && typeof activity === 'object') {
    lastProofAtMs = Object.prototype.hasOwnProperty.call(activity, runtime)
      ? activity[runtime]
      : null;
  }

  const last = Number(lastProofAtMs);
  if (!Number.isFinite(last) || last <= 0) {
    // THE CODEX CASE. Configured, plausible, and it has never once produced a
    // receipt. Holding here is correct; holding SILENTLY is what cost 8 hours.
    return { attainable: false, reason: 'runtime_never_produced_proof', runtime, lastProofAtMs: null };
  }
  if ((nowMs - last) > windowMs) {
    return { attainable: false, reason: 'runtime_proof_stale', runtime, lastProofAtMs: last };
  }
  return { attainable: true, reason: 'runtime_proof_observed', runtime, lastProofAtMs: last };
}

/** Did this hold happen because the proof channel is broken, not merely slow? */
function isUnattainableReason(reason) {
  return UNATTAINABLE_REASONS.has(String(reason || ''));
}

/**
 * Does this evidence prove that THIS message was consumed, on THIS route, by a
 * delivery no older than the attempt it claims to prove?
 *
 * Fail-closed at every branch. The failure mode being defended against is not
 * "we hold too long" — it is "we retire a message James never saw", which is
 * unrecoverable and invisible.
 *
 * @param {object} input
 *   evidence  the candidate proof (already class-checked by the caller)
 *   expected  identity built from the STORED queue record + live route
 *   attempt   {atMs, generation} from the durable attempt latch, or null
 *   nowMs
 * @returns {{proven: boolean, reason: string}}
 */
function evaluateConsumptionProof(input = {}) {
  const { evidence, expected, attempt } = input;
  if (!evidence || typeof evidence !== 'object') {
    return { proven: false, reason: 'no_evidence' };
  }
  if (!expected || typeof expected !== 'object') {
    return { proven: false, reason: 'no_expected_identity' };
  }

  // EVERY field, from the evidence's OWN body. Never merge expected into the
  // candidate before checking it: a previous version of the correlation check
  // did exactly that and a bare {verified:true} with no identity sailed through.
  for (const field of EXACT_PROOF_FIELDS) {
    const want = expected[field];
    if (want === null || want === undefined || String(want).trim() === '') {
      return { proven: false, reason: `expected_identity_missing:${field}` };
    }
    if (!identityEquals(evidence[field], want)) {
      return { proven: false, reason: `identity_mismatch:${field}` };
    }
  }

  // ORDERING. A receipt that predates the attempt is proof of an EARLIER
  // delivery of this id, not of the one currently outstanding.
  const provedAtMs = Number(evidence.provedAtMs);
  if (!Number.isFinite(provedAtMs) || provedAtMs <= 0) {
    return { proven: false, reason: 'proof_time_unknown' };
  }
  if (attempt) {
    const attemptedAtMs = Number(attempt.atMs);
    if (!Number.isFinite(attemptedAtMs) || attemptedAtMs <= 0) {
      // A v0 latch entry, written before attempts carried a timestamp. We
      // cannot order proof against it, so the automatic path must not retire
      // it. This is exactly update 808499316's situation, and it is resolved by
      // the explicit one-shot recovery, never by a timer.
      return { proven: false, reason: 'attempt_time_unknown' };
    }
    if (provedAtMs < attemptedAtMs) {
      return { proven: false, reason: 'proof_predates_attempt' };
    }

    // THE GENERATION MUST MATCH THE ATTEMPT, NOT THE PROCESS ASKING.
    //
    // =====================================================================
    // WHAT THIS FIXES, AND WHAT IT DELIBERATELY ALLOWS
    // =====================================================================
    // `EXACT_PROOF_FIELDS` compares `evidence.generation` against
    // `expected.generation`, which the drain fills from the CURRENT process.
    // That is wrong in both directions at once:
    //
    //   TOO LOOSE - the attempt's own generation was never compared to
    //   anything, so a receipt minted by a live generation could retire a
    //   delivery attempted by a generation that is long dead. Measured, not
    //   inferred: an attempt carrying `app-session-491` was proven by a
    //   `app-session-492` receipt.
    //
    //   TOO STRICT - after a restart, a durable terminal receipt written by
    //   generation G can no longer retire G's own attempt, because `expected`
    //   now says G+1. The one case that SHOULD survive a restart is the one
    //   that stopped working.
    //
    // Both fall out of asking the process who it is instead of asking the
    // durable record what it was waiting for. The attempt names the delivery;
    // proof must answer THAT delivery.
    if (isNonEmptyString(attempt.generation)) {
      if (!isNonEmptyString(evidence.generation)) {
        return { proven: false, reason: 'proof_generation_unknown' };
      }
      if (!identityEquals(evidence.generation, attempt.generation)) {
        return {
          proven: false,
          reason: 'proof_generation_does_not_match_attempt',
          detail: { attemptGeneration: attempt.generation, proofGeneration: evidence.generation },
        };
      }
    }
  }

  return { proven: true, reason: 'exact_consumption_proof' };
}

/**
 * What the backlog actually looks like, for health.
 *
 * THE FALSE GREEN THIS KILLS: on 2026-08-03 the Telegram poller was genuinely
 * fresh, so startup health scored 100/100 and stayed there while six messages
 * rotted behind a wedged head. Poller freshness answers "are we still receiving"
 * and says nothing at all about "is anything being delivered". A backlog that
 * cannot move is not a healthy channel no matter how new the last poll is.
 *
 * @param {object} input
 *   pending          array of queued records (unacked)
 *   attempts         Map<updateId, {state, atMs, generation}>
 *   blocked          {updateId, reason, failureClass, unattainable} | null
 *   lastRetirementAtMs
 *   nowMs
 */
function summarizeBacklog(input = {}) {
  const pending = Array.isArray(input.pending) ? input.pending : [];
  const nowMs = Number.isFinite(Number(input.nowMs)) ? Number(input.nowMs) : null;
  const attempts = input.attempts instanceof Map ? input.attempts : new Map();

  let oldest = null;
  for (const record of pending) {
    const updateId = Number(record?.updateId);
    if (!Number.isSafeInteger(updateId)) continue;
    const receivedAtMs = Number(record?.receivedAtMs);
    const usable = Number.isFinite(receivedAtMs) && receivedAtMs > 0 ? receivedAtMs : null;
    if (!oldest || updateId < oldest.updateId) {
      oldest = { updateId, receivedAtMs: usable };
    }
  }

  // Age is only reported when it is REAL. A record with no usable timestamp
  // reports null age rather than 0 — a fabricated zero would read as "brand
  // new" and re-create the false green in a new place.
  const oldestPendingAgeMs = oldest && oldest.receivedAtMs !== null && nowMs !== null
    ? Math.max(0, nowMs - oldest.receivedAtMs)
    : null;

  const blocked = input.blocked && typeof input.blocked === 'object' ? input.blocked : null;

  return {
    pendingCount: pending.length,
    oldestPendingUpdateId: oldest ? oldest.updateId : null,
    // The DURABLE input, carried alongside the derived age so a consumer can
    // recompute against its own clock instead of trusting an age this process
    // asserted at some earlier moment.
    oldestPendingReceivedAtMs: oldest ? oldest.receivedAtMs : null,
    oldestPendingAgeMs,
    oldestPendingAgeUnknown: Boolean(oldest) && oldestPendingAgeMs === null,
    blockedUpdateId: blocked ? (Number(blocked.updateId) || null) : null,
    blockedReason: blocked && isNonEmptyString(blocked.reason) ? blocked.reason : null,
    blockedFailureClass: blocked && isNonEmptyString(blocked.failureClass) ? blocked.failureClass : null,
    proofUnattainable: Boolean(blocked && blocked.unattainable),
    attemptedCount: Array.from(attempts.values()).filter((a) => a && a.state === 'attempted').length,
    lastRetirementAtMs: Number.isFinite(Number(input.lastRetirementAtMs))
      ? Number(input.lastRetirementAtMs)
      : null,
  };
}

module.exports = {
  PROOF_CAPABILITY_WINDOW_MS,
  EXACT_PROOF_FIELDS,
  UNATTAINABLE_REASONS,
  probeRuntimeProofCapability,
  isUnattainableReason,
  evaluateConsumptionProof,
  summarizeBacklog,
  identityEquals,
};
