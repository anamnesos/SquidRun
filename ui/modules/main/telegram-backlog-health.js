/**
 * TELEGRAM BACKLOG HEALTH — the check that would have caught S491 in minutes.
 *
 * On 2026-08-03 James said "telegram not working". Six of his messages had been
 * sitting in the durable queue for up to 8.6 hours, including live plumbing job
 * instructions, behind one head-of-line record that could never be proven.
 * Throughout, startup health scored 100/100.
 *
 * It was not lying. It was answering a different question. Poller freshness
 * asks "are we still RECEIVING", and the poller was genuinely fine — it kept
 * accepting James's messages and writing them durably to disk. Nothing anywhere
 * asked "is anything being DELIVERED". A channel can be perfectly fresh and
 * perfectly mute at the same time, and that combination is precisely the outage
 * shape, not an edge case around it.
 *
 * So the rule this module exists to enforce: FRESH POLLING PLUS AN AGED
 * UNRESOLVED HEAD MUST NOT SCORE OK. Freshness may never contribute a passing
 * grade to a queue that is not moving.
 */

const { isRecognizedActivationMode } = require('./telegram-activation-mode');

/** Past this, a held head has stopped being "the pane is busy". */
const DEGRADED_HEAD_AGE_MS = 10 * 60 * 1000;

/**
 * Past this, it is an outage. Deliberately well under the 8.6 hours it actually
 * took someone to notice, and comfortably over a slow but real turn.
 */
const CRITICAL_HEAD_AGE_MS = 30 * 60 * 1000;

const SEVERITY_ORDER = Object.freeze({ ok: 0, degraded: 1, critical: 2 });

function worst(a, b) {
  return SEVERITY_ORDER[b] > SEVERITY_ORDER[a] ? b : a;
}

/**
 * Score one route's backlog snapshot.
 *
 * @param {object} snapshot  as produced by summarizeBacklog
 * @param {object} options   nowMs, degradedAfterMs, criticalAfterMs
 * @returns {{severity: 'ok'|'degraded'|'critical', ok: boolean, reasons: string[], headAgeMs: number|null}}
 */
function scoreBacklogHealth(snapshot, options = {}) {
  const reasons = [];
  let severity = 'ok';

  if (!snapshot || typeof snapshot !== 'object') {
    // NOT reporting is not the same as healthy. A route whose drain never
    // produced a snapshot is a route nobody is watching.
    return { severity: 'critical', ok: false, reasons: ['no_backlog_snapshot'], headAgeMs: null };
  }

  // ===================================================================
  // AN UNHEALTHY OPERATING STATE IS CRITICAL BEFORE ANYTHING IS COUNTED
  // ===================================================================
  // Checked ahead of the empty-queue early return, and that order is the whole
  // value of the check. An install that has not been told which transport
  // activation state it is in will refuse every message that arrives from now
  // on — and until the first one arrives its queue is EMPTY, which is the one
  // shape this function used to answer `ok: true` to immediately. That is S491
  // again in a new place: a true statement about the backlog standing in for a
  // question nobody asked about the channel.
  //
  // MISSING IS NOT HEALTHY, same as `pollerFresh`. A snapshot with no
  // activation fields was produced by something that cannot say what state it
  // was in, and the honest grade for that is not ok.
  // AND THE BOOLEAN IS NOT THE AUTHORITY (Architect #153). This scores a
  // snapshot read back from DISK, so `activationModeHealthy: true` is a claim
  // by whatever last wrote that file — a corrupted, stale or forged document
  // could otherwise assert health next to a mode this build cannot operate in,
  // on an empty queue, and be believed. Membership is re-derived from the one
  // predicate that owns it, and the three fields must agree with each other.
  if (snapshot.activationModeHealthy !== true) {
    return {
      severity: 'critical',
      ok: false,
      reasons: [`activation_mode_unhealthy:${snapshot.activationModeReason || 'activation_mode_unreported'}`],
      headAgeMs: null,
    };
  }
  if (!isRecognizedActivationMode(snapshot.activationMode)) {
    return {
      severity: 'critical',
      ok: false,
      reasons: [`activation_mode_incoherent:healthy_without_recognized_mode:${String(snapshot.activationMode)}`],
      headAgeMs: null,
    };
  }
  // EXACTLY null, not merely absent. A persisted document that omits the field
  // was written by something that did not know it owed one, and omission is
  // not a statement of success (Architect #156).
  if (snapshot.activationModeReason !== null) {
    // Healthy AND carrying a failure reason is a document that disagrees with
    // itself. Refusing beats picking whichever half looks more convenient.
    return {
      severity: 'critical',
      ok: false,
      reasons: [`activation_mode_incoherent:healthy_with_failure_reason:${String(snapshot.activationModeReason)}`],
      headAgeMs: null,
    };
  }

  const degradedAfterMs = Number.isFinite(Number(options.degradedAfterMs))
    ? Number(options.degradedAfterMs)
    : DEGRADED_HEAD_AGE_MS;
  const criticalAfterMs = Number.isFinite(Number(options.criticalAfterMs))
    ? Number(options.criticalAfterMs)
    : CRITICAL_HEAD_AGE_MS;

  // A MALFORMED COUNT IS NOT ZERO. `Number(x) || 0` turned undefined, null,
  // NaN and "seven" into a clean bill of health — corrupt data producing the
  // one answer that ends the function early with severity ok. That is the
  // exact class this module exists to eliminate, sitting inside it.
  // `typeof` FIRST: Number(null) is 0 and Number([]) is 0, so a finite-check
  // alone still lets absent and nonsense values read as a healthy empty queue.
  // A NON-NEGATIVE SAFE INTEGER, nothing looser. `Number.isFinite` alone let
  // 1.5 and 2.7 through as plausible counts — a fractional number of queued
  // messages is not a small inaccuracy, it is evidence the producer is broken.
  const rawPendingCount = typeof snapshot.pendingCount === 'number'
    ? snapshot.pendingCount
    : NaN;
  if (!Number.isSafeInteger(rawPendingCount) || rawPendingCount < 0) {
    return {
      severity: 'critical',
      ok: false,
      reasons: [`pending_count_unreadable:${String(snapshot.pendingCount)}`],
      headAgeMs: null,
    };
  }
  const pendingCount = rawPendingCount;
  if (pendingCount === 0) {
    return { severity: 'ok', ok: true, reasons: [], headAgeMs: null };
  }

  // A queue that cannot say how old its head is cannot be shown to be healthy.
  if (snapshot.oldestPendingAgeUnknown) {
    severity = worst(severity, 'degraded');
    reasons.push('oldest_pending_age_unknown');
  }

  // `Number(null)` is 0 and `Number.isFinite(0)` is true, so the obvious
  // coercion turned an explicitly UNKNOWN age into the freshest possible
  // reading. Third instance of this exact bug class in this lane; the typeof
  // guard is the only thing that actually distinguishes absent from zero.
  const headAgeMs = typeof snapshot.oldestPendingAgeMs === 'number'
    && Number.isFinite(snapshot.oldestPendingAgeMs)
    ? snapshot.oldestPendingAgeMs
    : null;

  if (headAgeMs !== null) {
    if (headAgeMs >= criticalAfterMs) {
      severity = worst(severity, 'critical');
      reasons.push(`head_of_line_aged_critical:${snapshot.oldestPendingUpdateId}:${headAgeMs}ms`);
    } else if (headAgeMs >= degradedAfterMs) {
      severity = worst(severity, 'degraded');
      reasons.push(`head_of_line_aged:${snapshot.oldestPendingUpdateId}:${headAgeMs}ms`);
    }
  }

  // PROOF THAT CANNOT ARRIVE is critical at any age. Waiting does not fix a
  // pane whose runtime has never once written a receipt, so the usual "give it
  // a few minutes" grace is not merely generous here, it is wrong.
  if (snapshot.proofUnattainable) {
    severity = 'critical';
    reasons.push(`proof_unattainable:${snapshot.blockedReason || 'unknown'}`);
  } else if (snapshot.blockedReason) {
    severity = worst(severity, 'degraded');
    reasons.push(`blocked:${snapshot.blockedUpdateId}:${snapshot.blockedReason}`);
  }

  return { severity, ok: severity === 'ok', reasons, headAgeMs };
}

/**
 * Combine backlog health with poller freshness into ONE verdict.
 *
 * THE WHOLE POINT: `pollerFresh` may only ever make this worse, never better.
 * The S491 reading was "poller fresh -> 100/100" while the queue was frozen, so
 * freshness is accepted as an input and given no power to raise a grade.
 */
function scoreTelegramChannel(input = {}) {
  const backlog = scoreBacklogHealth(input.backlog, input);
  const reasons = [...backlog.reasons];
  let severity = backlog.severity;

  // MISSING FRESHNESS IS NOT FRESH. `!== false` reported an absent or
  // unreadable poller reading as pollerFresh:true — an unasked question
  // answered optimistically, which is how this incident started.
  const pollerFresh = input.pollerFresh === true ? true
    : (input.pollerFresh === false ? false : null);
  if (pollerFresh === false) {
    severity = worst(severity, 'degraded');
    reasons.push('poller_stale');
  } else if (pollerFresh === null) {
    severity = worst(severity, 'degraded');
    reasons.push('poller_freshness_unknown');
  }

  return {
    severity,
    ok: severity === 'ok',
    reasons,
    headAgeMs: backlog.headAgeMs,
    // Reported for operators, and deliberately NOT able to raise the grade.
    // null means "we do not know", which is never the same as fresh.
    pollerFresh,
  };
}

module.exports = {
  DEGRADED_HEAD_AGE_MS,
  CRITICAL_HEAD_AGE_MS,
  scoreBacklogHealth,
  scoreTelegramChannel,
};
