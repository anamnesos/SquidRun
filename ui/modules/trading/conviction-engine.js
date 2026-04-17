'use strict';

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, toNumber(value, min)));
}

function scoreSetup(entry = {}, options = {}) {
  const structure = entry.structure || null;
  const setup = entry.setup || null;
  if (!structure?.ok || !setup) return 0;
  const openPositionBoost = entry.hasOpenPosition ? 0.1 : 0;
  const rejectionStrength = Math.min(
    structure.ceilingRejections || 0,
    structure.floorRejections || 0
  ) * 0.04;
  const widthStrength = clamp(toNumber(structure.widthPct, 0) / 0.04, 0, 0.3);
  const edgeTightness = 1 - clamp(toNumber(setup.edgeDistancePct, 0) / 0.015, 0, 1);
  const moverBoost = clamp(Math.abs(toNumber(entry.change4hPct, 0)) / 0.08, 0, 0.15);
  return clamp(
    toNumber(setup.confidence, 0)
    + rejectionStrength
    + widthStrength
    + (edgeTightness * 0.2)
    + moverBoost
    + openPositionBoost
    - (options.penalty || 0),
    0,
    1.5
  );
}

function chooseDominantSetup(entries = [], options = {}) {
  const ranked = (Array.isArray(entries) ? entries : [])
    .map((entry) => {
      const structure = entry?.structure || null;
      const setups = [];
      if (structure?.setups?.long) {
        setups.push({
          ...entry,
          structure,
          setup: structure.setups.long,
          score: scoreSetup({ ...entry, structure, setup: structure.setups.long }, options),
        });
      }
      if (structure?.setups?.short) {
        setups.push({
          ...entry,
          structure,
          setup: structure.setups.short,
          score: scoreSetup({ ...entry, structure, setup: structure.setups.short }, options),
        });
      }
      return setups;
    })
    .flat()
    .sort((left, right) => toNumber(right.score, 0) - toNumber(left.score, 0));

  const dominant = ranked[0] || null;
  return {
    dominant,
    ranked,
    selectedTicker: dominant?.ticker || null,
    selectedDirection: dominant?.setup?.direction || null,
    strategyMode: 'range_conviction',
    confidence: Number(toNumber(dominant?.score, 0).toFixed(4)),
  };
}

function resolvePositionAction(selection = {}, openPosition = null, context = {}) {
  const dominant = selection?.dominant || null;
  const structure = context?.structure || dominant?.structure || null;
  const currentPrice = toNumber(context?.currentPrice, toNumber(structure?.currentPrice, 0));
  const ticker = String(context?.ticker || dominant?.ticker || '').trim().toUpperCase() || null;
  const targetTolerancePct = clamp(toNumber(context?.targetTolerancePct, 0.0035), 0.0015, 0.02);

  const positionSide = String(openPosition?.side || '').trim().toLowerCase();
  const isLong = positionSide === 'long';
  const isShort = positionSide === 'short';
  const setupDirection = String(dominant?.setup?.direction || '').trim().toUpperCase();
  const matchingSide = (setupDirection === 'BUY' && isLong)
    || (setupDirection === 'SELL' && isShort);
  const invalidationPrice = isLong
    ? toNumber(dominant?.setup?.invalidationPrice, toNumber(structure?.invalidation?.long, 0))
    : toNumber(dominant?.setup?.invalidationPrice, toNumber(structure?.invalidation?.short, 0));
  const targetPrice = isLong
    ? toNumber(dominant?.setup?.targetPrice, toNumber(structure?.targets?.long, toNumber(structure?.ceiling, 0)))
    : toNumber(dominant?.setup?.targetPrice, toNumber(structure?.targets?.short, toNumber(structure?.floor, 0)));
  const targetReached = currentPrice > 0 && targetPrice > 0 && (
    (isLong && currentPrice >= (targetPrice * (1 - targetTolerancePct)))
    || (isShort && currentPrice <= (targetPrice * (1 + targetTolerancePct)))
  );
  const invalidated = currentPrice > 0 && invalidationPrice > 0 && (
    (isLong && currentPrice <= invalidationPrice)
    || (isShort && currentPrice >= invalidationPrice)
  );
  const breakoutAgainstPosition = Boolean(
    structure?.ok
    && ((isLong && structure?.breakoutDown) || (isShort && structure?.breakoutUp))
  );
  const oppositeSetupActive = dominant && !matchingSide && toNumber(dominant?.setup?.confidence, 0) >= 0.64;
  const weakening = Boolean(
    structure?.ok
    && !dominant?.setup
    && currentPrice > 0
    && (
      (isLong && currentPrice < toNumber(structure?.mid, 0) && toNumber(structure?.hourlySlopePct, 0) <= -0.01)
      || (isShort && currentPrice > toNumber(structure?.mid, 0) && toNumber(structure?.hourlySlopePct, 0) >= 0.01)
    )
  );

  if (openPosition) {
    if (invalidated || breakoutAgainstPosition || oppositeSetupActive) {
      return {
        action: 'abort_thesis',
        ticker,
        invalidationPrice: invalidationPrice || null,
        targetPrice: targetPrice || null,
        rationale: invalidated
          ? 'Price crossed the thesis invalidation level.'
          : breakoutAgainstPosition
            ? 'Range structure broke against the current thesis.'
            : 'A stronger opposite-side conviction setup has replaced the current thesis.',
      };
    }
    if (targetReached) {
      return {
        action: 'take_profit',
        ticker,
        invalidationPrice: invalidationPrice || null,
        targetPrice: targetPrice || null,
        rationale: 'Price is at the planned range target, so the thesis should harvest profits.',
      };
    }
    if (weakening) {
      return {
        action: 'hold_watch',
        ticker,
        invalidationPrice: invalidationPrice || null,
        targetPrice: targetPrice || null,
        rationale: 'The thesis is still alive, but range momentum is weakening through the middle of the structure.',
      };
    }
    return {
      action: 'hold',
      ticker,
      invalidationPrice: invalidationPrice || null,
      targetPrice: targetPrice || null,
      rationale: matchingSide && dominant?.setup?.rationale
        ? dominant.setup.rationale
        : 'Open conviction position still sits inside its planned range thesis.',
    };
  }

  if (!dominant) {
    return {
      action: 'idle',
      ticker,
      rationale: 'No dominant range-conviction setup is active.',
    };
  }
  return {
    action: setupDirection === 'BUY' ? 'enter_long' : 'enter_short',
    ticker: dominant?.ticker || ticker,
    invalidationPrice: toNumber(dominant?.setup?.invalidationPrice, 0) || null,
    targetPrice: toNumber(dominant?.setup?.targetPrice, 0) || null,
    rationale: dominant?.setup?.rationale || 'Thesis still intact.',
  };
}

module.exports = {
  chooseDominantSetup,
  resolvePositionAction,
};
