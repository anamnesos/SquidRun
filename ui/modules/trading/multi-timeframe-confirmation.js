'use strict';

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toText(value, fallback = '') {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, toNumber(value, min)));
}

function round(value, digits = 4) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Number(numeric.toFixed(digits));
}

function pickReferencePrice(snapshot = {}, fallback = 0) {
  const candidates = [
    snapshot?.tradePrice,
    snapshot?.askPrice,
    snapshot?.bidPrice,
    snapshot?.minuteClose,
    snapshot?.dailyClose,
    snapshot?.previousClose,
    fallback,
  ].map((value) => Number(value));
  return candidates.find((value) => Number.isFinite(value) && value > 0) || 0;
}

function computeWindowMomentumPct(bars = [], currentPrice = 0, lookback = 6) {
  const closes = (Array.isArray(bars) ? bars : [])
    .map((bar) => toNumber(bar?.close, 0))
    .filter((value) => value > 0);
  const window = closes.slice(-lookback);
  if (window.length === 0 || currentPrice <= 0) return 0;
  const baseline = window.reduce((sum, value) => sum + value, 0) / window.length;
  return baseline > 0 ? (currentPrice - baseline) / baseline : 0;
}

function computeSeriesTrendPct(bars = [], lookback = 6) {
  const closes = (Array.isArray(bars) ? bars : [])
    .map((bar) => toNumber(bar?.close, 0))
    .filter((value) => value > 0)
    .slice(-lookback);
  return closes.length >= 2 && closes[0] > 0
    ? (closes[closes.length - 1] - closes[0]) / closes[0]
    : 0;
}

function getDirectionalBias(value, threshold = 0.0025) {
  if (value > threshold) return 1;
  if (value < -threshold) return -1;
  return 0;
}

function buildDirectionalState(desiredBias, biases = {}, strengths = {}) {
  const label = desiredBias > 0 ? 'BUY' : 'SELL';
  const higherAligned = biases.bias4h === desiredBias && biases.bias1d === desiredBias;
  const oneHigherAligned = biases.bias4h === desiredBias || biases.bias1d === desiredBias;
  const oneHigherOpposed = biases.bias4h === -desiredBias || biases.bias1d === -desiredBias;
  const higherOpposed = biases.bias4h === -desiredBias && biases.bias1d === -desiredBias;
  const lowerAligned = biases.bias1h === desiredBias;
  const lowerOpposed = biases.bias1h === -desiredBias;
  const reasons = [];

  if (higherOpposed || (oneHigherOpposed && !oneHigherAligned)) {
    reasons.push(`${label} blocked because 4h and/or daily trends are leaning the other way.`);
    return {
      direction: label,
      status: 'block',
      sizeMultiplier: 0,
      reasons,
    };
  }

  if (higherAligned && !lowerOpposed) {
    reasons.push(`${label} confirmed by aligned 4h and daily trend.`);
    if (lowerAligned) {
      reasons.push('1h momentum is aligned too.');
    } else {
      reasons.push('1h is neutral, so keep size slightly below max.');
    }
    return {
      direction: label,
      status: 'confirm',
      sizeMultiplier: lowerAligned ? 1 : 0.85,
      reasons,
    };
  }

  if (higherAligned && lowerOpposed) {
    reasons.push(`${label} has higher-timeframe backing, but 1h is fighting the move.`);
    return {
      direction: label,
      status: 'downgrade',
      sizeMultiplier: 0.6,
      reasons,
    };
  }

  if (oneHigherAligned && !oneHigherOpposed) {
    reasons.push(`${label} only has partial higher-timeframe support.`);
    return {
      direction: label,
      status: 'downgrade',
      sizeMultiplier: 0.65,
      reasons,
    };
  }

  if (Math.max(strengths.strength4h, strengths.strength1d) < 0.2) {
    reasons.push(`${label} lacks enough higher-timeframe strength to trust.`);
    return {
      direction: label,
      status: 'downgrade',
      sizeMultiplier: 0.5,
      reasons,
    };
  }

  reasons.push(`${label} is not confirmed by the current timeframe structure.`);
  return {
    direction: label,
    status: 'block',
    sizeMultiplier: 0,
    reasons,
  };
}

function resolveRegime(biases = {}) {
  if (biases.bias1h > 0 && biases.bias4h > 0 && biases.bias1d > 0) return 'full_bull_alignment';
  if (biases.bias1h < 0 && biases.bias4h < 0 && biases.bias1d < 0) return 'full_bear_alignment';
  if (biases.bias4h > 0 && biases.bias1d > 0 && biases.bias1h < 0) return 'bullish_pullback';
  if (biases.bias4h < 0 && biases.bias1d < 0 && biases.bias1h > 0) return 'bearish_bounce';
  if (biases.bias4h === 0 && biases.bias1d === 0) return 'higher_timeframe_neutral';
  return 'mixed';
}

function resolveDecisionState(confirmation = {}, decision = null) {
  const desiredDecision = toText(decision || confirmation?.decision).toUpperCase();
  if (!desiredDecision) return null;
  const state = confirmation?.directionalStates?.[desiredDecision];
  if (!state) return null;
  return {
    decision: desiredDecision,
    status: state.status || null,
    sizeMultiplier: Number.isFinite(Number(state.sizeMultiplier)) ? Number(state.sizeMultiplier) : null,
    reasons: Array.isArray(state.reasons) ? state.reasons : [],
  };
}

function buildMultiTimeframeConfirmation(options = {}) {
  const ticker = toText(options.ticker).toUpperCase();
  const snapshot = options.snapshot || {};
  const timeframeBars = options.timeframeBars || {};
  const hourlyBars = Array.isArray(timeframeBars.hourly) ? timeframeBars.hourly : [];
  const fourHourBars = Array.isArray(timeframeBars.fourHour) ? timeframeBars.fourHour : [];
  const dailyBars = Array.isArray(timeframeBars.daily) ? timeframeBars.daily : [];
  const currentPrice = pickReferencePrice(snapshot, toNumber(hourlyBars[hourlyBars.length - 1]?.close, 0));
  const hourlyMomentumPct = computeWindowMomentumPct(hourlyBars, currentPrice, 6);
  const fourHourTrendPct = computeSeriesTrendPct(fourHourBars, 6);
  const dailyTrendPct = computeSeriesTrendPct(dailyBars, 5);
  const intradayReference = toNumber(snapshot?.previousClose, 0) || toNumber(snapshot?.dailyClose, 0);
  const intradayPct = intradayReference > 0 ? (currentPrice - intradayReference) / intradayReference : 0;
  const bias1h = getDirectionalBias(hourlyMomentumPct);
  const bias4h = getDirectionalBias(fourHourTrendPct);
  const bias1d = getDirectionalBias(dailyTrendPct);
  const strength1h = clamp(Math.abs(hourlyMomentumPct) / 0.045);
  const strength4h = clamp(Math.abs(fourHourTrendPct) / 0.06);
  const strength1d = clamp(Math.abs(dailyTrendPct) / 0.06);
  const directionalStates = {
    BUY: buildDirectionalState(1, { bias1h, bias4h, bias1d }, { strength1h, strength4h, strength1d }),
    SELL: buildDirectionalState(-1, { bias1h, bias4h, bias1d }, { strength1h, strength4h, strength1d }),
  };
  const desiredDecision = toText(options.decision).toUpperCase();
  const chosenState = directionalStates[desiredDecision] || null;
  const dominantBias = bias4h !== 0 ? bias4h : (bias1d !== 0 ? bias1d : bias1h);
  const aligned = bias1h !== 0 && bias1h === bias4h && bias4h === bias1d;
  const reasons = chosenState?.reasons
    || [
    aligned
        ? '1h, 4h, and daily are aligned.'
        : 'Timeframes are mixed and should be treated carefully.',
    ];
  const tapeStatus = aligned && dominantBias !== 0 ? 'confirm' : 'downgrade';
  const tapeSizeMultiplier = aligned && dominantBias !== 0 ? 1 : 0.65;

  return {
    ticker,
    asOf: toText(options.asOf, new Date().toISOString()),
    hourlyMomentumPct: round(hourlyMomentumPct, 6),
    fourHourTrendPct: round(fourHourTrendPct, 6),
    dailyTrendPct: round(dailyTrendPct, 6),
    intradayPct: round(intradayPct, 6),
    bias1h,
    bias4h,
    bias1d,
    strength1h: round(strength1h, 4),
    strength4h: round(strength4h, 4),
    strength1d: round(strength1d, 4),
    aligned,
    dominantBias,
    regime: resolveRegime({ bias1h, bias4h, bias1d }),
    decision: desiredDecision || null,
    status: chosenState?.status || null,
    sizeMultiplier: chosenState?.sizeMultiplier ?? null,
    tapeStatus,
    tapeSizeMultiplier,
    statusBasis: chosenState ? 'decision' : 'tape_state',
    reasons,
    directionalStates,
  };
}

module.exports = {
  buildMultiTimeframeConfirmation,
  computeSeriesTrendPct,
  computeWindowMomentumPct,
  getDirectionalBias,
  resolveDecisionState,
};
