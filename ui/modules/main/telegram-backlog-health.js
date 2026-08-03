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

  const pendingCount = Number(snapshot.pendingCount) || 0;
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

  if (input.pollerFresh === false) {
    severity = worst(severity, 'degraded');
    reasons.push('poller_stale');
  }

  return {
    severity,
    ok: severity === 'ok',
    reasons,
    headAgeMs: backlog.headAgeMs,
    // Reported for operators, and deliberately NOT part of the grade when the
    // backlog is unhealthy.
    pollerFresh: input.pollerFresh !== false,
  };
}

module.exports = {
  DEGRADED_HEAD_AGE_MS,
  CRITICAL_HEAD_AGE_MS,
  scoreBacklogHealth,
  scoreTelegramChannel,
};
