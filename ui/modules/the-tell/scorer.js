'use strict';

// THE TELL — regret-of-silence scorer (the MIND), v0 slice: Hyperliquid position vs its stop.
// Pure functions: inputs (already-parsed position/mark/stop/priceHist/glance) -> contract object.
// READ-ONLY. v0 action is dry-run (confirm logs, never executes). Spec: workspace/specs/the-tell-scorer-v0.md
// Oracle owns scoring/thresholds/gates/ledger. Builder consumes the emitted contract; renders the surface.

const SCORER_SCHEMA_VERSION = 'squidrun.the_tell.scorer_v0';

// Thresholds — biased SEVERE toward silence. v1 numbers; tunable at runtime, not in render.
const THRESHOLDS = Object.freeze({
  NOTLOOK_MIN: 10,            // HL must be unlooked >= this to be "he can't see it" (gate 2)
  TENSION_HORIZON_MIN: 45,   // edge-tension starts BUILDING here (silent) so the "tell" feels earned, not a jump-cut
  ETA_CLIFF_MIN: 20,         // stop must be <= this many min away on current pace to be speak-eligible (gate 1)
  ACT_WINDOW_MIN: 2,         // ...but >= this, or it's too late to act, let the stop work (gate 3)
  MOTION_BASELINE_MULT: 2,   // adverse velocity must be >= 2x the coin's own 30-min baseline
  SEVERITY_USD_FLOOR: 40,    // risk_usd must clear this (OR the pct floor below) to be eligible — necessary, not sufficient
  SEVERITY_PCT_FLOOR: 0.08,  // ...or >= 8% of account value, whichever is smaller for his economy
  SEVERITY_REF_USD: 100,     // severity SATURATES here: a stop losing ~$100 is fully severe for his small account
                             // (anchored to his real single-loss pain, NOT the $200 daily quota — two different things)
  SPEAK: 0.80,               // regretScore >= this AND all gates pass AND not in cooldown
  COOLDOWN_MIN: 60,          // per-coin silence after a spoke OR a dismissal
  EPS: 1e-9,
});

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

// Honesty fail-safe: only an explicit, exact "live" counts as live. Everything else (blank, missing,
// a scenario tag, garbage) is non-live and MUST be badged. Mislabeling a replay as his live money is
// made structurally impossible — you cannot reach "live" by forgetting to set it.
function normalizeSource(source) {
  if (typeof source !== 'string') return 'unverified';
  const s = source.trim();
  if (!s) return 'unverified';
  return s === 'live' ? 'live' : s; // 'live' only when asserted exactly; scenario tags pass through verbatim
}

// AND-like combiner: any factor == 0 -> 0 (structural silence), but calibratable in the mid-range
// (a raw product is too punishing — realistic-but-real risks could never cross the speak bar).
function geomean(vals) {
  if (!vals.length) return 0;
  const prod = vals.reduce((p, x) => p * clamp01(x), 1);
  return prod <= 0 ? 0 : Math.pow(prod, 1 / vals.length);
}

// --- derived metrics off real HL fields -------------------------------------
function deriveMetrics(input) {
  const { position, mark, stop, priceHist = [], glanceAtMs, nowMs } = input;
  const szi = Number(position.szi);
  const entryPx = Number(position.entryPx);
  const direction = szi > 0 ? 'long' : 'short';
  const absSz = Math.abs(szi);

  // adverse distance mark -> stop, as % of mark (long: stop below; short: stop above)
  let dist_to_stop_pct = null;
  if (isNum(stop) && isNum(mark) && mark > 0) {
    dist_to_stop_pct = direction === 'long' ? (mark - stop) / mark : (stop - mark) / mark;
  }

  // adverse velocity (%/min toward the stop) over the price window + the coin's own baseline
  const { velocity, baseline } = adverseVelocity(priceHist, direction);

  // eta to stop at current adverse pace
  let eta_to_stop_min = null;
  if (isNum(dist_to_stop_pct) && velocity > THRESHOLDS.EPS) {
    eta_to_stop_min = dist_to_stop_pct / velocity;
  } else if (isNum(dist_to_stop_pct)) {
    eta_to_stop_min = Infinity; // not moving toward it
  }

  // dollars at risk between here and the stop
  let risk_usd = null;
  if (isNum(stop) && isNum(entryPx)) risk_usd = absSz * Math.abs(entryPx - stop);

  // worst cliff: distance to liquidation (used by the naked-position branch)
  let dist_to_liq_pct = null;
  const liq = Number(position.liquidationPx);
  if (isNum(liq) && isNum(mark) && mark > 0) {
    dist_to_liq_pct = direction === 'long' ? (mark - liq) / mark : (liq - mark) / mark;
  }

  const notLookingMin = isNum(glanceAtMs) ? (nowMs - glanceAtMs) / 60000 : Infinity;

  // max loss if a naked position runs all the way to liquidation (the naked-branch severity measure)
  const risk_to_liq_usd = isNum(liq) && isNum(entryPx) ? absSz * Math.abs(entryPx - liq) : null;

  return {
    coin: position.coin, direction, absSz, entryPx, mark, stop, liquidationPx: liq,
    dist_to_stop_pct, velocity, baseline, eta_to_stop_min, risk_usd, risk_to_liq_usd, dist_to_liq_pct, notLookingMin,
  };
}

// adverse %/min over the recent window + a trailing baseline for "is this acceleration?"
function adverseVelocity(priceHist, direction) {
  if (!Array.isArray(priceHist) || priceHist.length < 2) return { velocity: 0, baseline: 0 };
  const pts = priceHist.filter((p) => isNum(p.px) && isNum(p.tMs)).sort((a, b) => a.tMs - b.tMs);
  if (pts.length < 2) return { velocity: 0, baseline: 0 };
  const adverse = (from, to) => {
    const dPx = direction === 'long' ? from.px - to.px : to.px - from.px; // positive = moved toward stop
    const dMin = (to.tMs - from.tMs) / 60000;
    if (dMin <= THRESHOLDS.EPS || from.px <= 0) return 0;
    return (dPx / from.px) / dMin; // %/min toward the stop (can be negative if moving away)
  };
  // recent velocity = last leg; baseline = mean |adverse| over the window's earlier legs
  const recent = adverse(pts[pts.length - 2], pts[pts.length - 1]);
  let sum = 0, n = 0;
  for (let i = 1; i < pts.length - 1; i += 1) { sum += Math.abs(adverse(pts[i - 1], pts[i])); n += 1; }
  const baseline = n > 0 ? sum / n : Math.abs(recent);
  return { velocity: Math.max(0, recent), baseline };
}

// --- the four factors (multiplicative -> structural silence) ----------------
function factors(m, accountValue) {
  // S severity: dollars at risk vs his real single-loss pain reference
  const S = isNum(m.risk_usd) ? clamp01(m.risk_usd / THRESHOLDS.SEVERITY_REF_USD) : 0;
  // B blindness: 0 if looking now, ramps to 1 past NOTLOOK_MIN
  const B = clamp01(m.notLookingMin / THRESHOLDS.NOTLOOK_MIN);
  // W window: ~0 too far AND ~0 too close; peak in the actionable band [ACT_WINDOW_MIN, ETA_CLIFF_MIN]
  const W = windowFactor(m.eta_to_stop_min);
  // M motion: 0 for chop, ramps once velocity >= MULT x baseline
  const M = motionFactor(m.velocity, m.baseline);
  return { S, B, W, M };
}

// Continuous, no jump-cuts. Tension builds smoothly on approach (silent), peaks in the actionable
// band (where it can speak), then RELEASES as it goes futile and the stop takes over. The smoothness
// is what lets the edge-light animate an EARNED build rather than popping into an alert.
const APPROACH_PEAK = 0.7;
function windowFactor(eta) {
  if (!isNum(eta) || eta <= 0) return 0;
  const { ACT_WINDOW_MIN: lo, ETA_CLIFF_MIN: hi, TENSION_HORIZON_MIN: far } = THRESHOLDS;
  if (eta >= far) return 0;                                   // beyond the horizon: at rest
  if (eta >= hi) return APPROACH_PEAK * (far - eta) / (far - hi);   // approach [hi,far): 0 -> 0.7 (building, silent — gate1 still blocks speak)
  if (eta >= lo) return APPROACH_PEAK + (1 - APPROACH_PEAK) * (hi - eta) / (hi - lo); // band [lo,hi]: 0.7 -> 1.0 (peak; closer = hotter)
  return eta / lo;                                            // futile (0,lo): 1.0 -> 0 (too late, release; gate3 blocks speak)
}

function motionFactor(velocity, baseline) {
  if (!(velocity > 0)) return 0;
  const ref = Math.max(baseline, THRESHOLDS.EPS) * THRESHOLDS.MOTION_BASELINE_MULT;
  return clamp01(velocity / ref);
}

// --- gates (eligibility) ----------------------------------------------------
function gateResults(m, f, accountValue) {
  const severityOk = isNum(m.risk_usd) && (
    m.risk_usd >= THRESHOLDS.SEVERITY_USD_FLOOR ||
    (isNum(accountValue) && accountValue > 0 && m.risk_usd / accountValue >= THRESHOLDS.SEVERITY_PCT_FLOOR)
  );
  const gate1 = isNum(m.eta_to_stop_min) && m.eta_to_stop_min <= THRESHOLDS.ETA_CLIFF_MIN && m.velocity > 0;
  const gate2 = m.notLookingMin >= THRESHOLDS.NOTLOOK_MIN;
  const gate3 = isNum(m.eta_to_stop_min) && m.eta_to_stop_min >= THRESHOLDS.ACT_WINDOW_MIN;
  return { severityOk, gate1, gate2, gate3 };
}

// --- per-position scoring ---------------------------------------------------
function scorePosition(input) {
  const m = deriveMetrics(input);
  const accountValue = Number(input.accountValue);
  const naked = !isNum(m.stop);

  if (naked) return scoreNakedPosition(m, input, accountValue);

  const f = factors(m, accountValue);
  const g = gateResults(m, f, accountValue);
  const regretScore = geomean([f.S, f.B, f.W, f.M]);

  const gatesPass = g.gate1 && g.gate2 && g.gate3 && g.severityOk;
  const eligible = gatesPass && regretScore >= THRESHOLDS.SPEAK;

  const reason = !eligible ? topGateFailed({ g, regretScore }) : null;
  return { coin: m.coin, metrics: m, factors: f, gates: g, regretScore, eligible, reason, naked: false, input };
}

function scoreNakedPosition(m, input, accountValue) {
  // No stop at all: scored on distance-to-liquidation; eligible at longer ETA because there's NO safety net.
  // MUST still clear a materiality floor — a naked $3 dust/ghost position is NOT grab-your-arm. Without this,
  // the escalator cries wolf on stale attributions exactly like the XYZ:HOOD case. (Caught at integration.)
  const severityOk = isNum(m.risk_to_liq_usd) && (
    m.risk_to_liq_usd >= THRESHOLDS.SEVERITY_USD_FLOOR ||
    (isNum(accountValue) && accountValue > 0 && m.risk_to_liq_usd / accountValue >= THRESHOLDS.SEVERITY_PCT_FLOOR)
  );
  const hasRisk = isNum(m.dist_to_liq_pct) && m.dist_to_liq_pct > 0;
  const adverse = m.velocity > 0;
  const blind = m.notLookingMin >= THRESHOLDS.NOTLOOK_MIN;
  // regret proxy: proximity-to-liq * blindness * motion (no W window — a naked runaway is always actionable: set a stop)
  const proximity = hasRisk ? clamp01(1 - m.dist_to_liq_pct / 0.5) : 0; // within 50% of liq ramps up
  const B = clamp01(m.notLookingMin / THRESHOLDS.NOTLOOK_MIN);
  const M = motionFactor(m.velocity, m.baseline);
  // severity also damps the regret itself, so a sub-floor ghost never even glows the edge
  const regretScore = severityOk ? geomean([proximity, B, M]) : 0;
  const eligible = hasRisk && adverse && blind && severityOk && regretScore >= THRESHOLDS.SPEAK;
  const reason = eligible ? null : (!severityOk ? 'severity_below_floor' : 'naked_below_threshold');
  return {
    coin: m.coin, metrics: m, factors: { proximity, B, M, naked: true }, gates: { naked: true, severityOk },
    regretScore, eligible, reason, naked: true, input,
  };
}

function topGateFailed({ g, regretScore }) {
  if (!g.severityOk) return 'severity_below_floor';
  if (!g.gate2) return 'gate2_he_was_looking';
  if (!g.gate1) return 'gate1_near_but_no_motion';
  if (!g.gate3) return 'gate3_too_late_let_stop_work';
  if (regretScore < THRESHOLDS.SPEAK) return 'gate4_regret_below_speak';
  return 'below_threshold';
}

// =====================================================================================
// SIGNAL GENERALIZATION — non-trading regret-of-silence types (TrustQuote + promises).
// The spine is universal: regretScore = geomean([S, B, W, C]) behind a materiality floor.
//   S = severity (how bad if I stay silent), B = blindness (can he see it right now?),
//   W = window (still time to act?), C = trigger-confidence (is this ACTUALLY true, not maybe?).
// C is the per-type ANTI-CRY-WOLF lever: trading=motion, job-margin=enough-history+imminence,
// collision=real-hours-impossibility. Any factor 0 -> silence (structural). Same SPEAK bar.
// A false collision-alarm or a wrong margin-read on his REAL obligations burns trust faster than
// a trading miss — so every type defaults SILENT when its trigger-confidence input is soft/unknown.
// =====================================================================================

const SIGNAL_THRESHOLDS = Object.freeze({
  MARGIN_MIN_HISTORY: 3,        // need >=3 comparable past jobs before asserting a floor (anti wrong-read)
  MATERIALITY_USD_FLOOR: 40,    // don't speak on a trivial $ discrepancy (his economy)
  INVOICE_OVERDUE_DAYS: 14,     // MIRROR TrustQuote canonical: dashboard-workflows.ts OVERDUE_DAYS=14 (don't reinvent)
  INVOICE_WRITEOFF_DAYS: 90,    // beyond this, collection is moot -> window closed
  COLLISION_BUFFER_MIN: 30,     // required time must overflow available by this margin to call it impossible
  COLLISION_MIN_LEAD_MIN: 30,   // at least one side still renegotiable this far out, or it's too late
  RELATIONSHIP_FLOOR: 0.5,      // a collision must touch someone/something that actually matters
});

function scoreTypedSignal(sig, ctx) {
  const facts = sig?.facts || {};
  // Defense-in-depth (Builder's feed filters parked customers first; the MIND honors them too):
  // a parked/under-review customer id is NEVER surfaced, even if a signal slips through. Keyed by id, not name.
  const custId = facts.customerId ?? sig?.rawRefs?.customerId ?? facts.customerIdentityKey;
  if (custId != null && ctx?.parked?.has(String(custId))) {
    return finalizeSignal(sig, { gateReason: 'parked_customer' });
  }
  switch (sig?.type) {
    case 'promise:collision': return scorePromiseCollision(sig, facts, ctx.nowMs);
    case 'trustquote:job-margin': return scoreTrustQuoteJobMargin(sig, facts, ctx.nowMs);
    case 'trustquote:invoice-aging': return scoreTrustQuoteInvoiceAging(sig, facts, ctx.nowMs);
    case 'trustquote:job-proof-stale': return scoreTrustQuoteJobProof(sig, facts, ctx.nowMs);
    default: return finalizeSignal(sig, { gateReason: 'unknown_signal_type' });
  }
}

function finalizeSignal(sig, parts) {
  const { S = 0, B = 0, W = 0, C = 0, materialityOk = false, gateReason = null, speech = null, snapshot = {} } = parts;
  const regretScore = materialityOk ? geomean([S, B, W, C]) : 0;
  const eligible = materialityOk && [S, B, W, C].every((x) => x > 0) && regretScore >= THRESHOLDS.SPEAK;
  const reason = eligible ? null
    : (gateReason || (!materialityOk ? 'below_materiality_floor' : 'regret_below_speak'));
  return {
    kind: 'signal', key: sig?.id, coin: undefined, type: sig?.type,
    context: sig?.context || sig?.type, factors: { S, B, W, C },
    regretScore, eligible, reason, snapshot, speech, _sig: sig,
  };
}

// --- promise:collision — the sharp one. Fires ONLY on real-hours impossibility, never vague overlap.
function scorePromiseCollision(sig, facts, nowMs) {
  const all = Array.isArray(facts.commitments) ? facts.commitments : [];
  // Only HARD, still-future commitments with CONCRETE durations can establish impossibility.
  const hard = all.filter((c) => c && c.hardness === 'hard' && isNum(c.dueMs) && c.dueMs > nowMs && isNum(c.durationMin) && c.durationMin > 0);
  const softInPlay = all.some((c) => c && c.hardness === 'hard' && (!isNum(c.durationMin) || !isNum(c.dueMs)));

  const feas = collisionFeasibility(hard, facts.availableWindows || [], Number(facts.existingBusyMin) || 0, nowMs);
  const overflow = feas.overflowMin;

  // C: real impossibility ONLY, and ONLY when the colliding set is fully concrete. A guessed duration
  // can never assert "these don't fit" — that's the false-collision that burns trust. Soft -> C 0 -> silent.
  const concrete = !softInPlay;
  const C = (concrete && hard.length >= 2 && overflow >= SIGNAL_THRESHOLDS.COLLISION_BUFFER_MIN)
    ? clamp01(0.6 + overflow / (SIGNAL_THRESHOLDS.COLLISION_BUFFER_MIN * 6)) : 0;

  // B blindness: commitments made in SEPARATE contexts = he physically never saw them together.
  const contexts = new Set(hard.map((c) => c.madeInContextRef).filter(Boolean));
  const B = contexts.size >= 2 ? 1 : (hard.length >= 2 ? 0.3 : 0);

  // W window: at least one side still renegotiable (enough lead to tell someone "tomorrow").
  const leadMin = hard.length ? Math.max(...hard.map((c) => (c.dueMs - nowMs) / 60000)) : 0;
  const W = clamp01(leadMin / (SIGNAL_THRESHOLDS.COLLISION_MIN_LEAD_MIN * 2));

  // S severity: the worst relationship/stakes among the colliding hard commitments.
  const weights = hard.map((c) => clamp01(Number(c.relationshipWeight) || 0));
  const S = weights.length ? Math.max(...weights) : 0;

  const materialityOk = hard.length >= 2 && overflow >= SIGNAL_THRESHOLDS.COLLISION_BUFFER_MIN
    && concrete && S >= SIGNAL_THRESHOLDS.RELATIONSHIP_FLOOR;

  const gateReason = !concrete ? 'collision_inputs_soft_unknown'
    : hard.length < 2 ? 'no_two_hard_commitments'
    : overflow < SIGNAL_THRESHOLDS.COLLISION_BUFFER_MIN ? 'fits_real_hours_no_collision'
    : S < SIGNAL_THRESHOLDS.RELATIONSHIP_FLOOR ? 'below_materiality_floor'
    : W <= 0 ? 'too_late_to_renegotiate' : null;

  // name the binding pair (two highest-weight colliding commitments) for the message
  const pair = hard.slice().sort((a, b) => (Number(b.relationshipWeight) || 0) - (Number(a.relationshipWeight) || 0)).slice(0, 2);
  const a = pair[0] || {}, b = pair[1] || {};
  const reqH = (hard.reduce((s, c) => s + c.durationMin, 0) / 60).toFixed(1);
  const speech = {
    claim: `You told ${a.who} you'd ${a.what} and committed ${b.what} for ${b.who} — they don't both fit your real hours. One has to move.`,
    whyNow: `~${reqH}h of hard commitments due in this window, and the hours don't cover it (${Math.round(overflow)} min short). Each was set in a separate conversation, so the clash was invisible to you.`,
    receipts: [
      ...hard.map((c) => ({ label: c.who, value: `${c.what} — ${fmtMin(c.durationMin)} by ${new Date(c.dueMs).toISOString().slice(11, 16)}`, source: c.madeInContextRef || 'commitments' })),
      { label: 'Real hours', value: `short by ${Math.round(overflow)} min`, source: 'calendar/working-hours' },
    ],
    proposedAction: {
      text: `Tell ${b.who} you'll move ${b.what}`, reversible: true, executionMode: 'dry-run',
      dryRunLabel: `Draft the reschedule to ${b.who} — I'll write it for your okay, I don't send anything on my own.`,
      alt: `Move ${a.what} instead`,
    },
    pushback: `If you've already squared this with them, say so and I'll drop it.`,
    verify: {
      commitments: hard.map((c) => ({ contextRef: c.madeInContextRef, dueMs: c.dueMs, durationMin: c.durationMin, relationshipWeight: c.relationshipWeight })),
      overflowMin: Math.round(overflow),
    },
  };
  return finalizeSignal(sig, {
    S, B, W, C, materialityOk, gateReason, speech,
    snapshot: { hardCount: hard.length, overflowMin: Math.round(overflow), leadMin: Math.round(leadMin), worstWeight: S, distinctContexts: contexts.size },
  });
}

// single-machine EDF feasibility: can all hard commitments be done before their deadlines in the real windows?
function collisionFeasibility(hard, windows, existingBusyMin, nowMs) {
  if (hard.length < 2) return { feasible: true, overflowMin: 0 };
  const sorted = hard.slice().sort((x, y) => x.dueMs - y.dueMs);
  const capByMs = (deadline) => {
    let cap = 0;
    for (const w of windows) {
      if (!isNum(w.startMs) || !isNum(w.endMs)) continue;
      const s = Math.max(w.startMs, nowMs), e = Math.min(w.endMs, deadline);
      if (e > s) cap += (e - s) / 60000;
    }
    return Math.max(0, cap - existingBusyMin);
  };
  let cum = 0, overflow = 0, binding = null;
  for (const c of sorted) {
    cum += c.durationMin;
    const ov = cum - capByMs(c.dueMs);
    if (ov > overflow) { overflow = ov; binding = c.dueMs; }
  }
  return { feasible: overflow <= 0, overflowMin: Math.max(0, overflow), bindingDeadlineMs: binding };
}

// --- trustquote:job-margin — bid under his own historical floor. Silent without enough history.
function scoreTrustQuoteJobMargin(sig, facts, nowMs) {
  const bidAmount = Number(facts.bidAmount);
  const bidMarginPct = isNum(facts.bidMarginPct) ? facts.bidMarginPct
    : (isNum(facts.bidPrice) && isNum(facts.bidCost) && facts.bidPrice > 0 ? (facts.bidPrice - facts.bidCost) / facts.bidPrice : null);
  const hist = facts.historicalMargin || {};
  const floorPct = Number(hist.floorPct);
  const sampleCount = Number(hist.sampleCount) || 0;
  const underPct = (isNum(floorPct) && isNum(bidMarginPct)) ? Math.max(0, floorPct - bidMarginPct) : 0;
  const underUsd = underPct * (isNum(bidAmount) ? bidAmount : 0);
  const enoughHistory = sampleCount >= SIGNAL_THRESHOLDS.MARGIN_MIN_HISTORY;
  const sent = facts.bidStatus === 'sent';
  const imminence = facts.bidStatus === 'ready-to-send' ? 1 : facts.bidStatus === 'draft' ? 0.6 : 0;

  const S = clamp01(underUsd / THRESHOLDS.SEVERITY_REF_USD);
  const B = facts.bidStatus === 'ready-to-send' ? 1 : 0.5; // about to fire; the app never shows him his own floor
  const W = sent ? 0 : (facts.bidStatus === 'ready-to-send' ? 1 : 0.7);
  const C = enoughHistory ? imminence : 0; // NO floor can be asserted from <3 jobs -> silent
  const materialityOk = underUsd >= SIGNAL_THRESHOLDS.MATERIALITY_USD_FLOOR && enoughHistory && underPct > 0 && !sent;

  const gateReason = sent ? 'already_sent'
    : !enoughHistory ? 'insufficient_history_for_floor'
    : underPct <= 0 ? 'at_or_above_floor'
    : underUsd < SIGNAL_THRESHOLDS.MATERIALITY_USD_FLOOR ? 'below_materiality_floor' : null;

  const suggested = isNum(bidAmount) ? (bidAmount * (1 + underPct)).toFixed(0) : null;
  const speech = {
    claim: `This ${facts.jobType || 'job'} bid is ${(underPct * 100).toFixed(0)}% under your own floor — about $${underUsd.toFixed(0)} below what you usually clear on these.`,
    whyNow: `Your last ${sampleCount} ${facts.jobType || ''} jobs floored at ${(floorPct * 100).toFixed(0)}% margin; this one's at ${(bidMarginPct * 100).toFixed(0)}%. It's ${facts.bidStatus}.`,
    receipts: [
      { label: 'Firestore doc', value: `${sig.rawRefs?.collection || 'jobs'}/${sig.rawRefs?.docId || sig.id}`, source: 'TrustQuote Firestore' },
      { label: 'Bid', value: `$${bidAmount} @ ${(bidMarginPct * 100).toFixed(0)}% margin`, source: sig.rawRefs?.docId || 'TrustQuote jobs' },
      { label: 'Your floor', value: `${(floorPct * 100).toFixed(0)}% over ${sampleCount} past jobs`, source: 'TrustQuote history' },
      { label: 'Under by', value: `-$${underUsd.toFixed(0)}`, source: 'computed' },
    ],
    proposedAction: {
      text: suggested ? `Bump it to $${suggested}` : 'Raise the margin', reversible: true, executionMode: 'dry-run',
      dryRunLabel: `Re-price to your floor — I'll draft it for your okay, nothing goes to the customer on my own.`,
      alt: 'Send it as-is',
    },
    pushback: `If you're cutting margin on purpose for this customer, say so and I'll stop flagging these.`,
    // Architect fact-verifies these EXACT refs against Firestore (read-only) before James sees the claim.
    verify: {
      quoteDocId: sig.rawRefs?.docId ?? sig.id,
      comparableJobIds: Array.isArray(hist.jobIds) ? hist.jobIds : [],
      floorPct, bidMarginPct, sampleCount, underUsd: Math.round(underUsd),
    },
  };
  return finalizeSignal(sig, { S, B, W, C, materialityOk, gateReason, speech, snapshot: { underUsd: Math.round(underUsd), underPct, sampleCount, bidStatus: facts.bidStatus } });
}

// --- trustquote:invoice-aging — genuinely overdue (not a data lag), still collectable, not yet chased.
function scoreTrustQuoteInvoiceAging(sig, facts, nowMs) {
  const amount = Number(facts.invoiceAmount);
  const due = Number(facts.dueMs);
  const status = String(facts.status || '').toLowerCase();
  const proposalLike = facts.isProposal === true
    || String(facts.documentType || '').toLowerCase() === 'quote'
    || String(facts.invoiceLabel || '').toLowerCase().includes('quote');
  const pendingJob = facts.isPendingJob === true && !proposalLike && status !== 'draft';
  const paid = status === 'paid' || status === 'overpaid' || isNum(facts.paymentReceivedMs);
  const daysOverdue = isNum(due) ? (nowMs - due) / 86400000 : 0;
  const genuinelyOverdue = pendingJob && !paid && daysOverdue > SIGNAL_THRESHOLDS.INVOICE_OVERDUE_DAYS;
  const collectable = daysOverdue < SIGNAL_THRESHOLDS.INVOICE_WRITEOFF_DAYS && facts.customerReachable !== false;
  const chasedRecently = isNum(facts.lastChasedMs) && (nowMs - facts.lastChasedMs) < 7 * 86400000;

  const S = clamp01((isNum(amount) ? amount : 0) / THRESHOLDS.SEVERITY_REF_USD);
  const B = chasedRecently ? 0.2 : 1;
  const W = collectable ? 1 : 0;
  const C = genuinelyOverdue ? clamp01(daysOverdue / 30) : 0; // anti data-lag: paid/within-grace -> 0
  const materialityOk = genuinelyOverdue && isNum(amount) && amount >= SIGNAL_THRESHOLDS.MATERIALITY_USD_FLOOR;

  const gateReason = proposalLike ? 'proposal_not_receivable'
    : !pendingJob ? 'not_pending_job'
    : paid ? 'paid_or_payment_recorded'
    : !genuinelyOverdue ? 'within_grace_not_overdue'
    : !collectable ? 'past_collectable_window'
    : amount < SIGNAL_THRESHOLDS.MATERIALITY_USD_FLOOR ? 'below_materiality_floor' : null;

  const speech = {
    claim: `Invoice for $${amount} is ${Math.floor(daysOverdue)} days overdue and not chased.`,
    whyNow: `Due ${new Date(due).toISOString().slice(0, 10)}, still unpaid, no payment recorded. Still collectable.`,
    receipts: [
      { label: 'Firestore doc', value: `${sig.rawRefs?.collection || 'jobs'}/${sig.rawRefs?.docId || sig.id}`, source: 'TrustQuote Firestore' },
      { label: 'Amount', value: `$${amount}`, source: sig.rawRefs?.docId || 'TrustQuote invoices' },
      { label: 'Due date', value: new Date(due).toISOString().slice(0, 10), source: 'TrustQuote dueMs/date' },
      { label: 'Overdue', value: `${Math.floor(daysOverdue)} days`, source: 'computed' },
    ],
    proposedAction: { text: `Send the reminder`, reversible: true, executionMode: 'dry-run', dryRunLabel: `Draft the nudge — I'll write it for your okay, I don't send on my own.`, alt: 'Leave it' },
    pushback: `If you're holding this one on purpose, say so and I'll stop.`,
    verify: { invoiceDocId: sig.rawRefs?.docId ?? sig.id, amount, dueMs: due, daysOverdue: Math.floor(daysOverdue) },
  };
  return finalizeSignal(sig, { S, B, W, C, materialityOk, gateReason, speech, snapshot: { amount, daysOverdue: Math.floor(daysOverdue), pendingJob } });
}

// --- trustquote:job-proof-stale — billable job missing required proof. Anti stale-sync false read.
function scoreTrustQuoteJobProof(sig, facts, nowMs) {
  const required = Array.isArray(facts.proofRequired) ? facts.proofRequired : [];
  const present = new Set(Array.isArray(facts.proofPresent) ? facts.proofPresent : []);
  const missing = required.filter((p) => !present.has(p));
  const jobValue = Number(facts.jobValue);
  const billable = facts.jobStatus === 'complete' || facts.jobStatus === 'billable';
  // anti stale-sync false read: only trust a "missing" verdict if the proof state synced recently;
  // a stale sync showing "missing" when proof was attached offline = the wrong-read that burns trust.
  const syncFresh = isNum(facts.proofSyncedAtMs) && (nowMs - facts.proofSyncedAtMs) < 24 * 3600000;

  const S = clamp01((isNum(jobValue) ? jobValue : 0) / THRESHOLDS.SEVERITY_REF_USD);
  const B = 1; // the app never surfaces the proof gap; he's blind unless told
  const W = (billable && facts.customerReachable !== false) ? 1 : 0; // still fixable
  const C = (missing.length > 0 && syncFresh) ? 1 : 0;
  const materialityOk = missing.length > 0 && billable && isNum(jobValue) && jobValue >= SIGNAL_THRESHOLDS.MATERIALITY_USD_FLOOR;

  const gateReason = missing.length === 0 ? 'proof_complete'
    : !syncFresh ? 'proof_state_stale_unverified'
    : !billable ? 'job_not_billable_yet'
    : jobValue < SIGNAL_THRESHOLDS.MATERIALITY_USD_FLOOR ? 'below_materiality_floor' : null;

  const speech = {
    claim: `Job is billable but missing proof: ${missing.join(', ')}.`,
    whyNow: `$${jobValue} job marked ${facts.jobStatus} with no ${missing.join('/')} on file — payment/dispute risk.`,
    receipts: [
      { label: 'Job', value: `$${jobValue} (${facts.jobStatus})`, source: facts?.rawRefs?.docId || 'TrustQuote jobs' },
      { label: 'Missing', value: missing.join(', '), source: 'computed' },
    ],
    proposedAction: { text: `Get the ${missing[0]} now`, reversible: true, executionMode: 'dry-run', dryRunLabel: `I'll flag what's missing for your okay — I don't contact the customer on my own.`, alt: 'Leave it' },
    pushback: `If you've got the proof elsewhere, say so and I'll stop.`,
    verify: { jobDocId: sig.rawRefs?.docId ?? sig.id, jobValue, missing, proofSyncedAtMs: facts.proofSyncedAtMs },
  };
  return finalizeSignal(sig, { S, B, W, C, materialityOk, gateReason, speech, snapshot: { jobValue, missing, syncFresh } });
}

// --- top-level evaluation: one-at-a-time + cooldown + contract emission (trading + signals) ---
// state: { cooldowns: { [key]: untilMs } } ; nowMs
function evaluate(input) {
  const { positions = [], signals = [], accountValue, nowMs, glanceAtMs, priceHistByCoin = {}, state = {} } = input;
  const cooldowns = state.cooldowns || {};
  const parked = new Set((input.parkedCustomerIds || []).map(String));
  // Trading is PARKED (James): The Tell no longer watches Hyperliquid. Scorer code stays (tests prove it),
  // production passes parkTrading:true so positions are never scored. Defense-in-depth, like Charles.
  const watchTrading = input.parkTrading !== true;
  const scored = [
    ...(watchTrading ? positions : []).map((position) => scorePosition({
      position,
      mark: position.markPx ?? input.markByCoin?.[position.coin],
      stop: position.stop ?? input.stopByCoin?.[position.coin] ?? null,
      priceHist: priceHistByCoin[position.coin] || [],
      glanceAtMs, nowMs, accountValue,
    })),
    ...signals.map((sig) => scoreTypedSignal(sig, { nowMs, parked })),
  ];
  const keyOf = (s) => s.key || s.coin;
  const contextOf = (s) => s.context || `trading:hyperliquid:${s.coin}`;

  const swallowed = [];
  const live = [];
  for (const s of scored) {
    const until = cooldowns[keyOf(s)];
    if (isNum(until) && nowMs < until) swallowed.push(buildSwallowedRecord(s, nowMs, 'cooldown_active'));
    else live.push(s);
  }

  const eligible = live.filter((s) => s.eligible).sort((a, b) => b.regretScore - a.regretScore);
  const winner = eligible[0] || null;

  for (const s of live) {
    if (s === winner) continue;
    const reason = s.eligible ? `lower_regret_than_${keyOf(winner)}` : s.reason;
    swallowed.push(buildSwallowedRecord(s, nowMs, reason));
  }

  // ambient edge-tension is the MAX regret across ALL live signals even when nobody speaks (the felt "tell")
  const ambient = live.reduce((mx, s) => Math.max(mx, s.regretScore), 0);
  const focus = live.slice().sort((a, b) => b.regretScore - a.regretScore)[0] || null;
  const speech = winner ? (winner.kind === 'signal' ? { ...winner.speech, _winner: winner } : buildSpeech(winner)) : null;

  return {
    schema: SCORER_SCHEMA_VERSION,
    // FAIL-SAFE source: only an explicit 'live' counts as live; anything else badges. (See normalizeSource.)
    source: normalizeSource(input.source),
    regretScore: winner ? winner.regretScore : ambient,
    context: focus ? contextOf(focus) : 'trading:hyperliquid',
    speak: Boolean(winner),
    ...(speech || {}),
    swallowed,
  };
}

function buildSpeech(s) {
  const m = s.metrics;
  const pct = (x) => (isNum(x) ? `${(x * 100).toFixed(2)}%` : 'n/a');
  const claim = s.naked
    ? `Your ${m.coin} ${m.direction} has NO stop and it's running against you, while HL isn't open.`
    : `Your ${m.coin} ${m.direction} stop is about to hit and HL isn't open.`;
  const whyNow = s.naked
    ? `No stop set. Mark ${m.mark} is ${pct(m.dist_to_liq_pct)} from liquidation, moving ${pct(m.velocity)}/min the wrong way. You haven't looked at HL in ${fmtMin(m.notLookingMin)}.`
    : `Mark ${m.mark} is ${pct(m.dist_to_stop_pct)} from your stop ${m.stop}, moving ${pct(m.velocity)}/min toward it — ~${fmtMin(m.eta_to_stop_min)} out. You haven't looked at HL in ${fmtMin(m.notLookingMin)}.`;
  const receipts = [
    { label: 'Position', value: `${m.coin} ${m.direction} ${m.absSz} @ ${m.entryPx}`, source: 'HL assetPositions' },
    { label: 'Stop', value: s.naked ? 'NONE SET' : String(m.stop), source: 'userOpenOrders/manual-overrides' },
    { label: 'Mark', value: String(m.mark), source: 'HL allMids' },
    { label: 'Distance', value: s.naked ? `${pct(m.dist_to_liq_pct)} to liq` : `${pct(m.dist_to_stop_pct)} (${fmtMin(m.eta_to_stop_min)} at pace)`, source: 'computed' },
    { label: 'At risk', value: isNum(m.risk_usd) ? `-$${m.risk_usd.toFixed(2)}`
      : (isNum(m.risk_to_liq_usd) ? `up to -$${m.risk_to_liq_usd.toFixed(2)} at liquidation` : 'unknown (no stop)'), source: 'computed' },
    { label: 'Last looked', value: `${fmtMin(m.notLookingMin)} ago`, source: 'desktop focus' },
  ];
  const proposedAction = {
    text: s.naked ? `Set a stop now, or cut it` : `Cut it now at market`,
    reversible: true,
    executionMode: 'dry-run',
    dryRunLabel: `${s.naked ? 'Set a stop' : 'Cut it'} — I'll log this call; I don't touch your money until you've seen my judgment land.`,
    alt: s.naked ? 'Tell me a stop price and I\'ll watch it' : `Move stop tighter`,
  };
  const pushback = s.naked
    ? `If running this one naked is on purpose, say so and I'll stop flagging it.`
    : `If this is a stop you're fine letting hit, say so and I'll shut up about it.`;
  return { claim, whyNow, receipts, proposedAction, pushback, _winner: s };
}

function fmtMin(x) {
  if (!isNum(x)) return x === Infinity ? '∞' : 'n/a';
  if (x === Infinity) return '∞';
  if (x < 1) return `${Math.round(x * 60)}s`;
  return `${x.toFixed(0)} min`;
}

// --- ledger record builders -------------------------------------------------
function buildSpokeRecord(emission, nowMs) {
  const s = emission._winner;
  const isTrading = s.kind !== 'signal';
  const snapshot = isTrading ? pickSnapshot(s.metrics) : (s.snapshot || {});
  return {
    ts: nowMs, type: 'spoke',
    key: s.key || s.coin, coin: isTrading ? s.metrics.coin : undefined,
    signalType: isTrading ? 'trading:hyperliquid:stop' : s.type,
    regretScore: emission.regretScore,
    gatesPassed: isTrading ? (s.naked ? ['naked-escalator'] : [1, 2, 3, 4]) : ['S', 'B', 'W', 'C'],
    snapshot, claim: emission.claim, proposedAction: emission.proposedAction,
    outcome: { jamesResponse: null, responseLatencySec: null, didStopHit: null, realizedVsIfActed: null },
  };
}

function buildSwallowedRecord(s, nowMs, reason) {
  const isTrading = s.kind !== 'signal';
  const surfaceable = s.eligible || reason.startsWith('lower_regret') || reason === 'cooldown_active';
  const wouldHaveSaid = !surfaceable ? null
    : (isTrading
      ? `${s.metrics.coin} ${s.metrics.direction}: ${s.naked ? 'no stop, ' : ''}${fmtPct(s.metrics.dist_to_stop_pct ?? s.metrics.dist_to_liq_pct)} from ${s.naked ? 'liq' : 'stop'}`
      : (s.speech?.claim || s.context));
  return {
    ts: nowMs, type: 'swallowed',
    key: s.key || s.coin, coin: isTrading ? s.metrics.coin : undefined,
    regretScore: s.regretScore, reason,
    signal: isTrading ? 'trading:hyperliquid:stop-proximity' : s.type,
    snapshot: isTrading ? pickSnapshot(s.metrics) : (s.snapshot || {}), wouldHaveSaid,
  };
}

function fmtPct(x) { return isNum(x) ? `${(x * 100).toFixed(2)}%` : 'n/a'; }
function pickSnapshot(m) {
  return {
    mark: m.mark, stop: m.stop, entryPx: m.entryPx, sz: m.absSz,
    velocity: m.velocity, eta: m.eta_to_stop_min, notLookingMin: m.notLookingMin, risk_usd: m.risk_usd,
  };
}

// after a spoke or a dismissal, silence the coin for COOLDOWN_MIN
function withCooldown(state, coin, nowMs) {
  const cooldowns = { ...(state.cooldowns || {}) };
  cooldowns[coin] = nowMs + THRESHOLDS.COOLDOWN_MIN * 60000;
  return { ...state, cooldowns };
}

module.exports = {
  SCORER_SCHEMA_VERSION,
  THRESHOLDS,
  SIGNAL_THRESHOLDS,
  evaluate,
  scorePosition,
  scoreTypedSignal,
  scorePromiseCollision,
  scoreTrustQuoteJobMargin,
  scoreTrustQuoteInvoiceAging,
  scoreTrustQuoteJobProof,
  collisionFeasibility,
  finalizeSignal,
  deriveMetrics,
  adverseVelocity,
  factors,
  windowFactor,
  motionFactor,
  buildSpokeRecord,
  buildSwallowedRecord,
  withCooldown,
  normalizeSource,
};
