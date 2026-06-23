'use strict';

// THE TELL — Rung-2 promotion gate (Oracle). Trust-ladder: shadow -> screen, EVIDENCE-forced.
// A pure, checkable function over the shadow silence-ledger. NO gut at promotion time: the human
// judgment is baked into each spoke row's review verdict (Architect tags it during shadow); this gate
// only TALLIES. Promotion is forced when the evidence clears, so shadow can't rot into parking.
// READ-ONLY: evaluates a ledger object, runs nothing, touches no bus/screen/restart.
//
// Promotes ONLY the oracle-backed classes (overdue, tasks-incomplete) — they're machine-verified against
// TrustQuote's own functions, so the human is already out of their common case. The our-concept classes
// (margin floor, collision) have NO app-truth oracle and require a separate, higher bar — never promoted here.

const PROMOTION = Object.freeze({
  MIN_SHADOW_DAYS: 7,
  ORACLE_BACKED_CLASSES: Object.freeze(['trustquote:invoice-aging', 'trustquote:job-tasks-incomplete']),
  // a spoke row's review.verdict, set by Architect during shadow (Architect's exact 3 + pending):
  //   'useful'      = correct AND genuinely valuable  -> satisfies the >=1-useful bar
  //   'real_catch'  = correct but not notable          -> neutral (doesn't block, doesn't satisfy useful)
  //   'false_alarm' = WRONG, Architect would have caught it -> BLOCKS (it cried wolf)
  //   'pending'     = not yet reviewed                 -> BLOCKS (could hide a false_alarm)
  VERDICTS: Object.freeze(['useful', 'real_catch', 'false_alarm', 'pending']),
  // OBSERVATION CONTINUITY (the HIGH audit finding): the gate must not certify trust on DEAD time.
  // A healthy honestly-silent runner and a dead runner produce the same spoke/swallowed rows (none),
  // so wall-clock elapsed != observed. The runner appends a 'tick' liveness row EVERY tick (incl. silent
  // ones). The gate requires the window was CONTINUOUSLY OBSERVED: no gap between ticks (or window-edge
  // to nearest tick) longer than MAX_OBSERVATION_GAP_MS. Tolerates an overnight machine sleep; catches a
  // multi-day stall. Then "silence the gate trusts" == "silence we KNOW was watched."
  MAX_OBSERVATION_GAP_MS: 25 * 60 * 60 * 1000,
});

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

// Ledger contract (Builder's shadow runner emits these; Architect tags spoke rows' review):
//   ledger = { shadowStartedAtMs, rows: [...] }
//   tick row     = { ts, type:'tick', intervalMs }   <- appended EVERY tick incl. silent (liveness proof)
//   spoke row    = { ts, type:'spoke', signalClass, key, claim, verify:{...}, review:{ verdict, by, at } }
//   swallowed row= { ts, type:'swallowed', signalClass, key, reason }

// Was the [windowStart, now] window continuously observed by the runner? Largest gap (incl. leading gap
// from windowStart to first tick and trailing gap from last tick to now) must be <= the tolerance.
function observationContinuity(rows, windowStartMs, nowMs, maxGapMs) {
  const ticks = rows
    .filter((r) => r.type === 'tick' && isNum(Number(r.ts)))
    .map((r) => Number(r.ts))
    .filter((t) => t >= windowStartMs && t <= nowMs)
    .sort((a, b) => a - b);
  if (ticks.length === 0) {
    return { continuous: false, reason: 'no_observation_ticks_in_window', maxGapMin: null, toleranceMin: Math.round(maxGapMs / 60000) };
  }
  let prev = windowStartMs;
  let maxGap = 0;
  for (const t of ticks) { maxGap = Math.max(maxGap, t - prev); prev = t; }
  maxGap = Math.max(maxGap, nowMs - prev); // trailing gap: a runner dead since its last tick fails here
  return {
    continuous: maxGap <= maxGapMs,
    reason: maxGap <= maxGapMs ? null : 'observation_gap_exceeds_tolerance',
    maxGapMin: Math.round(maxGap / 60000),
    toleranceMin: Math.round(maxGapMs / 60000),
    tickCount: ticks.length,
  };
}
function evaluatePromotionGate(ledger = {}, opts = {}) {
  const nowMs = Number(opts.nowMs);
  const minDays = isNum(opts.minShadowDays) ? opts.minShadowDays : PROMOTION.MIN_SHADOW_DAYS;
  const classes = Array.isArray(opts.promotableClasses) ? opts.promotableClasses : PROMOTION.ORACLE_BACKED_CLASSES;
  const rows = Array.isArray(ledger.rows) ? ledger.rows : [];
  const shadowStartedAtMs = Number(ledger.shadowStartedAtMs);

  const shadowDays = (isNum(shadowStartedAtMs) && shadowStartedAtMs > 0 && isNum(nowMs))
    ? (nowMs - shadowStartedAtMs) / 86400000 : 0;
  const durationOk = shadowDays >= minDays;

  // quality bars evaluate the TRAILING window (last minDays): a false-positive blocks while it's in window,
  // then ages out after a fix + a clean window -> the class can promote. Not "zero false-positives ever".
  const windowStartMs = isNum(nowMs) ? nowMs - minDays * 86400000 : -Infinity;
  const inWindow = (r) => isNum(Number(r.ts)) && Number(r.ts) >= windowStartMs;
  const verdictOf = (r) => (r && r.review && r.review.verdict) || 'pending';

  // Was the window actually OBSERVED the whole time (vs the runner dead for part of it)? Gate-wide.
  const maxGapMs = isNum(opts.maxObservationGapMs) ? opts.maxObservationGapMs : PROMOTION.MAX_OBSERVATION_GAP_MS;
  const observation = observationContinuity(rows, windowStartMs, nowMs, maxGapMs);
  const continuouslyObserved = observation.continuous === true;

  const perClass = {};
  for (const cls of classes) {
    const spokes = rows.filter((r) => r.type === 'spoke' && r.signalClass === cls && inWindow(r));
    const counts = {
      spokeInWindow: spokes.length,
      pending: spokes.filter((r) => verdictOf(r) === 'pending').length,
      falseAlarm: spokes.filter((r) => verdictOf(r) === 'false_alarm').length,
      useful: spokes.filter((r) => verdictOf(r) === 'useful').length,
      realCatch: spokes.filter((r) => verdictOf(r) === 'real_catch').length,
    };
    const allReviewed = counts.pending === 0;
    const zeroFalseAlarm = counts.falseAlarm === 0;
    const hasUseful = counts.useful >= 1;
    // continuouslyObserved is REQUIRED: never certify trust on a window the runner was dead for part of.
    const promotable = durationOk && continuouslyObserved && allReviewed && zeroFalseAlarm && hasUseful;

    const blockers = [];
    if (!durationOk) blockers.push(`shadow_${shadowDays.toFixed(1)}d_under_${minDays}d`);
    if (!continuouslyObserved) blockers.push(`not_continuously_observed:${observation.reason}${observation.maxGapMin != null ? `:${observation.maxGapMin}m_gap_vs_${observation.toleranceMin}m_tol` : ''}`);
    if (!allReviewed) blockers.push(`${counts.pending}_unreviewed_spoke_rows`);
    if (!zeroFalseAlarm) blockers.push(`${counts.falseAlarm}_false_alarms_in_window`);
    if (!hasUseful) blockers.push('no_useful_catch_in_window');

    perClass[cls] = { promotable, criteria: { durationOk, continuouslyObserved, allReviewed, zeroFalseAlarm, hasUseful }, counts, blockers };
  }

  // our-concept classes that surfaced in shadow but have NO app-truth oracle: explicitly NOT promotable here.
  const nonOracleClasses = [...new Set(
    rows.filter((r) => r.type === 'spoke' && !classes.includes(r.signalClass)).map((r) => r.signalClass),
  )];

  return {
    shadowDays: Number(shadowDays.toFixed(2)),
    durationOk,
    continuouslyObserved,
    observation,
    perClass,
    promote: Object.keys(perClass).filter((c) => perClass[c].promotable),
    blockedNoOracle: nonOracleClasses,
  };
}

module.exports = { PROMOTION, evaluatePromotionGate, observationContinuity };
