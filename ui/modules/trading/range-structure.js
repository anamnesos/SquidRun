'use strict';

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, toNumber(value, min)));
}

function mean(values = []) {
  const numeric = (Array.isArray(values) ? values : [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
  if (numeric.length === 0) return 0;
  return numeric.reduce((sum, value) => sum + value, 0) / numeric.length;
}

function normalizeBars(bars = []) {
  return (Array.isArray(bars) ? bars : [])
    .map((bar) => ({
      open: toNumber(bar?.open ?? bar?.o, 0),
      high: toNumber(bar?.high ?? bar?.h, 0),
      low: toNumber(bar?.low ?? bar?.l, 0),
      close: toNumber(bar?.close ?? bar?.c, 0),
      volume: toNumber(bar?.volume ?? bar?.v, 0),
      timestamp: bar?.timestamp || bar?.t || null,
    }))
    .filter((bar) => bar.high > 0 && bar.low > 0 && bar.close > 0);
}

function percentile(values = [], ratio = 0.5) {
  const numeric = (Array.isArray(values) ? values : [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  if (numeric.length === 0) return null;
  const index = Math.min(numeric.length - 1, Math.max(0, Math.round((numeric.length - 1) * clamp(ratio, 0, 1))));
  return numeric[index];
}

function countBoundaryRejections(bars = [], boundary, tolerancePct, side = 'ceiling') {
  if (!Number.isFinite(boundary) || boundary <= 0) return 0;
  return normalizeBars(bars).reduce((count, bar) => {
    const tolerance = boundary * tolerancePct;
    if (side === 'ceiling') {
      const touched = Math.abs(bar.high - boundary) <= tolerance || bar.high >= (boundary - tolerance);
      const rejected = bar.close <= (bar.high - ((bar.high - bar.low) * 0.45));
      return touched && rejected ? count + 1 : count;
    }
    const touched = Math.abs(bar.low - boundary) <= tolerance || bar.low <= (boundary + tolerance);
    const rejected = bar.close >= (bar.low + ((bar.high - bar.low) * 0.45));
    return touched && rejected ? count + 1 : count;
  }, 0);
}

function resolveCurrentPrice(series = {}) {
  const latestFive = normalizeBars(series.bars5m).slice(-1)[0];
  const latestFifteen = normalizeBars(series.bars15m).slice(-1)[0];
  const latestHour = normalizeBars(series.bars1h).slice(-1)[0];
  return toNumber(
    latestFive?.close,
    toNumber(latestFifteen?.close, toNumber(latestHour?.close, 0))
  );
}

function analyzeRangeStructure(input = {}) {
  const bars5m = normalizeBars(input.bars5m);
  const bars15m = normalizeBars(input.bars15m);
  const bars1h = normalizeBars(input.bars1h);
  const merged = [...bars5m.slice(-48), ...bars15m.slice(-36), ...bars1h.slice(-24)];
  const highs = merged.map((bar) => bar.high).filter((value) => value > 0);
  const lows = merged.map((bar) => bar.low).filter((value) => value > 0);
  const closes = merged.map((bar) => bar.close).filter((value) => value > 0);
  const currentPrice = toNumber(input.currentPrice, resolveCurrentPrice({ bars5m, bars15m, bars1h }));

  if (highs.length < 8 || lows.length < 8 || currentPrice <= 0) {
    return {
      ok: false,
      regime: 'insufficient_data',
      confidence: 0,
      floor: null,
      ceiling: null,
      mid: null,
      invalidation: { long: null, short: null },
      setups: { long: null, short: null },
    };
  }

  const ceiling = toNumber(input.ceiling, percentile(highs, 0.87));
  const floor = toNumber(input.floor, percentile(lows, 0.13));
  const mid = Number(((ceiling + floor) / 2).toFixed(6));
  const width = Math.max(0, ceiling - floor);
  const widthPct = mid > 0 ? width / mid : 0;
  const tolerancePct = clamp(widthPct * 0.18, 0.0025, 0.0125);
  const breakoutBufferPct = clamp(widthPct * 0.12, 0.003, 0.02);
  const latestClose = closes[closes.length - 1] || currentPrice;
  const priorClose = closes[closes.length - 2] || latestClose;
  const hourlySlopePct = closes.length >= 6 && closes[0] > 0
    ? (latestClose - closes[Math.max(0, closes.length - 6)]) / closes[Math.max(0, closes.length - 6)]
    : 0;

  const ceilingRejections = countBoundaryRejections(bars15m.slice(-24), ceiling, tolerancePct, 'ceiling');
  const floorRejections = countBoundaryRejections(bars15m.slice(-24), floor, tolerancePct, 'floor');
  const distanceToCeilingPct = ceiling > 0 ? Math.abs(ceiling - currentPrice) / ceiling : 1;
  const distanceToFloorPct = floor > 0 ? Math.abs(currentPrice - floor) / floor : 1;
  const aboveCeilingPct = ceiling > 0 ? Math.max(0, (currentPrice - ceiling) / ceiling) : 0;
  const belowFloorPct = floor > 0 ? Math.max(0, (floor - currentPrice) / floor) : 0;
  const nearCeiling = distanceToCeilingPct <= Math.max(tolerancePct * 1.6, 0.006);
  const nearFloor = distanceToFloorPct <= Math.max(tolerancePct * 1.6, 0.006);
  const breakoutUp = latestClose >= ceiling * (1 + breakoutBufferPct) && priorClose >= mid;
  const breakoutDown = latestClose <= floor * (1 - breakoutBufferPct) && priorClose <= mid;
  const rangeConfidence = clamp(
    ((Math.min(ceilingRejections, 4) + Math.min(floorRejections, 4)) / 8)
    + clamp(widthPct / 0.04, 0, 0.35)
    - clamp(Math.abs(hourlySlopePct) / 0.12, 0, 0.25),
    0,
    1
  );

  let regime = 'chop';
  if (breakoutUp) {
    regime = 'breakout_up';
  } else if (breakoutDown) {
    regime = 'breakout_down';
  } else if (rangeConfidence >= 0.45 && ceilingRejections >= 2 && floorRejections >= 2) {
    regime = 'range';
  } else if (hourlySlopePct >= 0.025) {
    regime = 'trend_up';
  } else if (hourlySlopePct <= -0.025) {
    regime = 'trend_down';
  }

  const longInvalidation = Number((floor * (1 - breakoutBufferPct)).toFixed(6));
  const shortInvalidation = Number((ceiling * (1 + breakoutBufferPct)).toFixed(6));
  const longTarget = Number((regime === 'range' ? ceiling : (mid + ((ceiling - mid) * 1.1))).toFixed(6));
  const shortTarget = Number((regime === 'range' ? floor : (mid - ((mid - floor) * 1.1))).toFixed(6));
  const longEntryEligible = nearFloor
    && floorRejections >= 2
    && !breakoutDown
    && regime !== 'trend_down'
    && currentPrice >= floor
    && belowFloorPct <= Math.max(breakoutBufferPct * 0.5, tolerancePct);
  const shortEntryEligible = nearCeiling
    && ceilingRejections >= 2
    && !breakoutUp
    && regime !== 'trend_up'
    && currentPrice <= ceiling
    && aboveCeilingPct <= Math.max(breakoutBufferPct * 0.5, tolerancePct);

  const longSetup = longEntryEligible
    ? {
      direction: 'BUY',
      entryPrice: currentPrice,
      invalidationPrice: longInvalidation,
      targetPrice: longTarget,
      edgeDistancePct: Number(distanceToFloorPct.toFixed(6)),
      confidence: Number(clamp(rangeConfidence + 0.12, 0, 1).toFixed(4)),
      rationale: `Price is pressing the floor with ${floorRejections} floor rejections.`,
    }
    : null;
  const shortSetup = shortEntryEligible
    ? {
      direction: 'SELL',
      entryPrice: currentPrice,
      invalidationPrice: shortInvalidation,
      targetPrice: shortTarget,
      edgeDistancePct: Number(distanceToCeilingPct.toFixed(6)),
      confidence: Number(clamp(rangeConfidence + 0.12, 0, 1).toFixed(4)),
      rationale: `Price is pressing the ceiling with ${ceilingRejections} ceiling rejections.`,
    }
    : null;

  return {
    ok: true,
    currentPrice: Number(currentPrice.toFixed(6)),
    floor: Number(floor.toFixed(6)),
    ceiling: Number(ceiling.toFixed(6)),
    mid,
    widthPct: Number(widthPct.toFixed(6)),
    tolerancePct: Number(tolerancePct.toFixed(6)),
    breakoutBufferPct: Number(breakoutBufferPct.toFixed(6)),
    ceilingRejections,
    floorRejections,
    distanceToCeilingPct: Number(distanceToCeilingPct.toFixed(6)),
    distanceToFloorPct: Number(distanceToFloorPct.toFixed(6)),
    breakoutUp,
    breakoutDown,
    hourlySlopePct: Number(hourlySlopePct.toFixed(6)),
    regime,
    confidence: Number(rangeConfidence.toFixed(4)),
    invalidation: {
      long: longInvalidation,
      short: shortInvalidation,
    },
    targets: {
      long: longTarget,
      short: shortTarget,
    },
    setups: {
      long: longSetup,
      short: shortSetup,
    },
  };
}

module.exports = {
  analyzeRangeStructure,
  normalizeBars,
};
