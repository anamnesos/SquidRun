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
  const rawPendingCount = typeof snapshot.pendingCount === 'number'
    ? snapshot.pendingCount
    : NaN;
  if (!Number.isFinite(rawPendingCount) || rawPendingCount < 0) {
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

  const headAgeMs = Number.isFinite(Number(snapshot.oldestPendingAgeMs))
    ? Number(snapshot.oldestPendingAgeMs)
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
