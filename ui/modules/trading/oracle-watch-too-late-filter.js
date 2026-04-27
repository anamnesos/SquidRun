'use strict';

// Pre-fire filter for bearish lose_fail_retest rules ("too late to short").
// Rejects fires that match patterns from the MEGA/AR/FARTCOIN post-mortems:
// shorts entered after the dump has exhausted and the retest is holding as
// support. Oracle-sharpened thresholds (see session 290 handoff).
//
// Pure module. All inputs explicit, no I/O. Caller prepares the context.

const DEFAULT_THRESHOLDS = {
  crowdedFundingMax: -0.00015,        // funding <= this AND oi1h <= 0 -> crowded
  staleBreakdownMinutes: 30,          // minutes since lose without new low
  depthFromLowMaxRetracePct: 0.35,    // retrace > 35% of (dumpHigh->dumpLow) -> late
  momentumVolumeDeclineBars: 3,       // bars to test volume decline
  retestWickCountMin: 3,              // >=N 1m wicks into retest without flush
  btcUpTrendMinChangePct: 0.001,      // BTC 5m close > open by >= this -> UP
};

function toNumber(value, fallback = NaN) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function getLatestBar(bars) {
  return Array.isArray(bars) && bars.length > 0 ? bars[bars.length - 1] : null;
}

// Crowded short / squeeze fuel.
// funding <= -0.00015 AND openInterestChange1hPct <= 0.
// If oi1h unavailable, fall back to sign of openInterestChange24hPct.
function checkCrowded(market, thresholds) {
  const funding = toNumber(market?.fundingRate, NaN);
  if (!Number.isFinite(funding)) return { flagged: false, reason: null };
  if (funding > thresholds.crowdedFundingMax) return { flagged: false, reason: null };

  const oi1h = toNumber(market?.openInterestChange1hPct, NaN);
  if (Number.isFinite(oi1h)) {
    if (oi1h <= 0) {
      return {
        flagged: true,
        reason: 'crowded_short',
        detail: { funding, oi1hPct: oi1h, source: '1h' },
      };
    }
    return { flagged: false, reason: null };
  }

  const oi24h = toNumber(market?.openInterestChange24hPct, NaN);
  if (Number.isFinite(oi24h) && oi24h <= 0) {
    return {
      flagged: true,
      reason: 'crowded_short',
      detail: { funding, oi24hPct: oi24h, source: '24h_fallback' },
    };
  }
  return { flagged: false, reason: null };
}

// Stale breakdown. minutes since first 1m close < loseLevel > threshold AND
// no lower low since. bars1m expected sorted oldest->newest with .time (ms)
// or .t, .close, .low.
function checkStaleBreakdown(rule, bars1m, nowMs, thresholds) {
  const loseLevel = toNumber(rule?.loseLevel, NaN);
  if (!Number.isFinite(loseLevel) || !Array.isArray(bars1m) || bars1m.length < 3) {
    return { flagged: false, reason: null };
  }
  let firstBreakIdx = -1;
  for (let i = 0; i < bars1m.length; i += 1) {
    if (toNumber(bars1m[i]?.close, NaN) < loseLevel) {
      firstBreakIdx = i;
      break;
    }
  }
  if (firstBreakIdx < 0) return { flagged: false, reason: null };

  const breakBar = bars1m[firstBreakIdx];
  const breakTimeMs = toNumber(breakBar?.time ?? breakBar?.t, nowMs);
  const minutesSince = (nowMs - breakTimeMs) / 60000;
  if (minutesSince < thresholds.staleBreakdownMinutes) {
    return { flagged: false, reason: null };
  }

  const breakLow = toNumber(breakBar?.low, toNumber(breakBar?.close, Infinity));
  let newLowerLow = false;
  for (let i = firstBreakIdx + 1; i < bars1m.length; i += 1) {
    if (toNumber(bars1m[i]?.low, Infinity) < breakLow) {
      newLowerLow = true;
      break;
    }
  }
  if (newLowerLow) return { flagged: false, reason: null };

  return {
    flagged: true,
    reason: 'stale_breakdown',
    detail: { minutesSinceBreak: Math.round(minutesSince), newLowerLow: false },
  };
}

// Depth-from-low. price retraced more than 35% from dumpLow toward dumpHigh.
// dumpHigh = max(high) of bars5m lookback; dumpLow = min(low) after dumpHigh.
function checkDepthFromLow(rule, bars5m, latestPrice, thresholds) {
  if (!Array.isArray(bars5m) || bars5m.length < 6 || !Number.isFinite(latestPrice)) {
    return { flagged: false, reason: null };
  }
  let dumpHighIdx = 0;
  let dumpHigh = -Infinity;
  for (let i = 0; i < bars5m.length; i += 1) {
    const h = toNumber(bars5m[i]?.high, -Infinity);
    if (h > dumpHigh) {
      dumpHigh = h;
      dumpHighIdx = i;
    }
  }
  let dumpLow = Infinity;
  for (let i = dumpHighIdx; i < bars5m.length; i += 1) {
    const l = toNumber(bars5m[i]?.low, Infinity);
    if (l < dumpLow) dumpLow = l;
  }
  if (!Number.isFinite(dumpHigh) || !Number.isFinite(dumpLow) || dumpHigh <= dumpLow) {
    return { flagged: false, reason: null };
  }
  const impulse = dumpHigh - dumpLow;
  const retrace = (latestPrice - dumpLow) / impulse;
  if (retrace > thresholds.depthFromLowMaxRetracePct) {
    return {
      flagged: true,
      reason: 'depth_from_low',
      detail: { retracePct: Number(retrace.toFixed(4)), dumpHigh, dumpLow, latestPrice },
    };
  }
  return { flagged: false, reason: null };
}

// 5m momentum flip. last 5m closes in upper half of its range AND
// volume declining across last N bars.
function checkMomentumFlip(bars5m, thresholds) {
  if (!Array.isArray(bars5m) || bars5m.length < thresholds.momentumVolumeDeclineBars + 1) {
    return { flagged: false, reason: null };
  }
  const last = getLatestBar(bars5m);
  const high = toNumber(last?.high, NaN);
  const low = toNumber(last?.low, NaN);
  const close = toNumber(last?.close, NaN);
  if (!Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close) || high <= low) {
    return { flagged: false, reason: null };
  }
  const mid = (high + low) / 2;
  if (close <= mid) return { flagged: false, reason: null };

  const nBars = thresholds.momentumVolumeDeclineBars;
  const tail = bars5m.slice(-nBars);
  const vols = tail.map((bar) => toNumber(bar?.volume ?? bar?.vol ?? bar?.v, NaN));
  if (vols.some((v) => !Number.isFinite(v))) return { flagged: false, reason: null };
  let declining = true;
  for (let i = 1; i < vols.length; i += 1) {
    if (vols[i] >= vols[i - 1]) {
      declining = false;
      break;
    }
  }
  if (!declining) return { flagged: false, reason: null };

  return {
    flagged: true,
    reason: 'momentum_flip',
    detail: { close, mid: Number(mid.toFixed(6)), volumes: vols },
  };
}

// Retest vigor. >=3 1m bars with high >= retestMin AND no downside flush
// (no 1m close < loseLevel) during the same window. Close above retestMax
// is caught by the engine's separate 'invalidated' check.
function checkRetestVigor(rule, bars1m, thresholds) {
  const retestMin = toNumber(rule?.retestMin, NaN);
  const loseLevel = toNumber(rule?.loseLevel, NaN);
  if (!Number.isFinite(retestMin) || !Number.isFinite(loseLevel) || !Array.isArray(bars1m)) {
    return { flagged: false, reason: null };
  }
  let wickCount = 0;
  let sawFlush = false;
  for (const bar of bars1m) {
    const high = toNumber(bar?.high, NaN);
    const close = toNumber(bar?.close, NaN);
    if (Number.isFinite(high) && high >= retestMin) wickCount += 1;
    if (Number.isFinite(close) && close < loseLevel) sawFlush = true;
  }
  if (wickCount >= thresholds.retestWickCountMin && !sawFlush) {
    return {
      flagged: true,
      reason: 'retest_vigor',
      detail: { wickCount, flushDetected: false },
    };
  }
  return { flagged: false, reason: null };
}

// BTC 5m trend UP -> soft-block alt shorts.
function checkBtcGate(btcContext, thresholds) {
  const bar = btcContext?.bar5m;
  if (!bar) return { flagged: false, reason: null };
  const open = toNumber(bar?.open, NaN);
  const close = toNumber(bar?.close, NaN);
  if (!Number.isFinite(open) || !Number.isFinite(close) || open <= 0) {
    return { flagged: false, reason: null };
  }
  const changePct = (close - open) / open;
  if (changePct >= thresholds.btcUpTrendMinChangePct) {
    return {
      flagged: true,
      reason: 'btc_up_trend',
      detail: { btcChangePct: Number(changePct.toFixed(4)) },
    };
  }
  return { flagged: false, reason: null };
}

// Main evaluator. Applies to a bearish lose_fail_retest rule about to fire.
// Non-lose_fail_retest rules and non-short rules pass through as { decision: 'fire' }.
// Decision matrix:
//   BTC gate flagged: soft_block (reduce confidence, log).
//   0 feature flags: fire.
//   1 feature flag:  soft_block.
//   >=2 feature flags OR BTC gate + >=1 feature: hard_block.
function evaluateTooLateShortRule(input = {}) {
  const {
    rule = {},
    symbolContext = {},
    btcContext = null,
    thresholds: overrides = {},
    nowMs = Date.now(),
  } = input;

  const thresholds = { ...DEFAULT_THRESHOLDS, ...(overrides || {}) };

  if (rule?.trigger !== 'lose_fail_retest') {
    return { decision: 'fire', features: {}, reasons: [], skipped: 'not_lose_fail_retest' };
  }

  const market = symbolContext?.market || {};
  const bars1m = Array.isArray(symbolContext?.bars1m) ? symbolContext.bars1m : [];
  const bars5m = Array.isArray(symbolContext?.bars5m) ? symbolContext.bars5m : [];
  const latestPrice = toNumber(market?.price ?? symbolContext?.snapshot?.tradePrice, NaN);

  const crowded = checkCrowded(market, thresholds);
  const stale = checkStaleBreakdown(rule, bars1m, nowMs, thresholds);
  const depth = checkDepthFromLow(rule, bars5m, latestPrice, thresholds);
  const momentum = checkMomentumFlip(bars5m, thresholds);
  const vigor = checkRetestVigor(rule, bars1m, thresholds);
  const btc = checkBtcGate(btcContext, thresholds);

  const featureChecks = [crowded, stale, depth, momentum, vigor];
  const flaggedFeatures = featureChecks.filter((c) => c.flagged);
  const flaggedCount = flaggedFeatures.length;

  let decision = 'fire';
  if (flaggedCount >= 2) {
    decision = 'hard_block';
  } else if (btc.flagged && flaggedCount >= 1) {
    decision = 'hard_block';
  } else if (flaggedCount === 1 || btc.flagged) {
    decision = 'soft_block';
  }

  const reasons = [...flaggedFeatures.map((c) => c.reason), ...(btc.flagged ? [btc.reason] : [])];

  return {
    decision,
    reasons,
    flaggedFeatures: flaggedFeatures.map((c) => ({ reason: c.reason, detail: c.detail })),
    btcGate: btc.flagged ? { reason: btc.reason, detail: btc.detail } : null,
    features: {
      crowded,
      staleBreakdown: stale,
      depthFromLow: depth,
      momentumFlip: momentum,
      retestVigor: vigor,
      btc,
    },
    thresholds,
  };
}

module.exports = {
  evaluateTooLateShortRule,
  DEFAULT_THRESHOLDS,
  __testing: {
    checkCrowded,
    checkStaleBreakdown,
    checkDepthFromLow,
    checkMomentumFlip,
    checkRetestVigor,
    checkBtcGate,
  },
};
