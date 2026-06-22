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
});

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

// Ledger contract (Builder's shadow runner emits these; Architect tags spoke rows' review):
//   ledger = { shadowStartedAtMs, rows: [...] }
//   spoke row    = { ts, type:'spoke', signalClass, key, claim, verify:{...}, review:{ verdict, by, at } }
//   swallowed row= { ts, type:'swallowed', signalClass, key, reason }
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
    const promotable = durationOk && allReviewed && zeroFalseAlarm && hasUseful;

    const blockers = [];
    if (!durationOk) blockers.push(`shadow_${shadowDays.toFixed(1)}d_under_${minDays}d`);
    if (!allReviewed) blockers.push(`${counts.pending}_unreviewed_spoke_rows`);
    if (!zeroFalseAlarm) blockers.push(`${counts.falseAlarm}_false_alarms_in_window`);
    if (!hasUseful) blockers.push('no_useful_catch_in_window');

    perClass[cls] = { promotable, criteria: { durationOk, allReviewed, zeroFalseAlarm, hasUseful }, counts, blockers };
  }

  // our-concept classes that surfaced in shadow but have NO app-truth oracle: explicitly NOT promotable here.
  const nonOracleClasses = [...new Set(
    rows.filter((r) => r.type === 'spoke' && !classes.includes(r.signalClass)).map((r) => r.signalClass),
  )];

  return {
    shadowDays: Number(shadowDays.toFixed(2)),
    durationOk,
    perClass,
    promote: Object.keys(perClass).filter((c) => perClass[c].promotable),
    blockedNoOracle: nonOracleClasses,
  };
}

module.exports = { PROMOTION, evaluatePromotionGate };
