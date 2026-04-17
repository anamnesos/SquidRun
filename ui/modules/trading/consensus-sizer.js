'use strict';

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, toNumber(value, min)));
}

function averageConfidence(signals = []) {
  if (!Array.isArray(signals) || signals.length === 0) return 0;
  return signals.reduce((sum, signal) => sum + clamp(signal?.confidence, 0, 1), 0) / signals.length;
}

function getMechanicalEntry(mechanicalBoard = null, ticker = '') {
  if (!mechanicalBoard || typeof mechanicalBoard !== 'object') return null;
  return mechanicalBoard?.symbols?.[ticker] || null;
}

function scoreDisagreement(consensus = {}) {
  if (!consensus?.consensus || consensus?.decision === 'HOLD') {
    return 1;
  }
  const agreeing = Array.isArray(consensus.agreeing) ? consensus.agreeing : [];
  const dissenting = Array.isArray(consensus.dissenting) ? consensus.dissenting : [];
  if (agreeing.length === 3) {
    return 0;
  }
  const averageAgree = averageConfidence(agreeing);
  const averageDissent = averageConfidence(dissenting);
  return clamp(
    0.45
    + ((1 - averageAgree) * 0.35)
    + (averageDissent * 0.2),
    0,
    1
  );
}

function scoreMechanicalAlignment(consensus = {}, mechanical = null) {
  if (!mechanical) return 0.5;
  const bias = String(mechanical.mechanicalDirectionBias || 'neutral').trim().toLowerCase();
  const tradeFlag = String(mechanical.tradeFlag || 'watch').trim().toLowerCase();
  const decision = String(consensus?.decision || '').trim().toUpperCase();

  let base = 0.5;
  if (decision === 'BUY') {
    if (bias === 'bullish') base = 0.9;
    else if (bias === 'bearish') base = 0.1;
  } else if (decision === 'SELL') {
    if (bias === 'bearish') base = 0.9;
    else if (bias === 'bullish') base = 0.1;
  }

  if (tradeFlag === 'trade') base += 0.1;
  if (tradeFlag === 'no-trade') base -= 0.25;
  return clamp(base, 0, 1);
}

function resolveEventCap(eventVeto = null, ticker = '') {
  const decision = String(eventVeto?.decision || 'CLEAR').trim().toUpperCase();
  const affectedAssets = Array.isArray(eventVeto?.affectedAssets) ? eventVeto.affectedAssets : [];
  const inScope = affectedAssets.length === 0 || affectedAssets.includes(ticker);
  if (!inScope) return { mode: 'normal', multiplier: null };
  if (decision === 'VETO') {
    return {
      mode: 'tiny',
      multiplier: clamp(eventVeto?.sizeMultiplier ?? 0.25, 0.05, 1),
    };
  }
  if (decision === 'CAUTION' || decision === 'DEGRADED') {
    return {
      mode: 'tiny',
      multiplier: clamp(eventVeto?.sizeMultiplier ?? 0.5, 0.05, 1),
    };
  }
  return { mode: 'normal', multiplier: null };
}

function combineSizeMultipliers(...multipliers) {
  const resolved = multipliers
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (resolved.length === 0) return null;
  return clamp(Math.min(...resolved), 0.05, 1);
}

function resolveAppliedSizeMultiplier(bucket = 'normal', assetClass = 'us_equity', sizeMultiplier = null) {
  if (bucket === 'block') return 0;
  if (bucket !== 'tiny') return 1;
  if (sizeMultiplier != null) {
    return clamp(sizeMultiplier, 0.05, 1);
  }
  return assetClass === 'crypto' ? 0.33 : 0.5;
}

function resolveNativeDecisionGate(nativeSignals = null) {
  const mtf = nativeSignals?.multiTimeframe || null;
  const decisionState = mtf?.decisionState || null;
  if (!decisionState) {
    return { mode: 'normal', multiplier: null, reasons: [] };
  }
  if (decisionState.status === 'block') {
    return {
      mode: 'block',
      multiplier: 0,
      reasons: ['mtf_block'],
    };
  }
  const explicitMultiplier = Number.isFinite(Number(decisionState.sizeMultiplier))
    ? clamp(decisionState.sizeMultiplier, 0.05, 1)
    : null;
  if (decisionState.status === 'downgrade' || (explicitMultiplier != null && explicitMultiplier < 0.9999)) {
    return {
      mode: 'scaled',
      multiplier: explicitMultiplier,
      reasons: [decisionState.status === 'downgrade' ? 'mtf_downgrade' : 'mtf_scaled'],
    };
  }
  return { mode: 'normal', multiplier: explicitMultiplier, reasons: [] };
}

function sizeConsensusTrade(input = {}) {
  const consensus = input.consensus || {};
  const ticker = String(consensus?.ticker || input.ticker || '').trim().toUpperCase();
  const mechanical = input.mechanicalBoard ? getMechanicalEntry(input.mechanicalBoard, ticker) : (input.mechanical || null);
  const eventCap = resolveEventCap(input.eventVeto, ticker);
  const nativeGate = resolveNativeDecisionGate(input.nativeSignals || null);
  const disagreementScore = scoreDisagreement(consensus);
  const mechanicalAlignment = scoreMechanicalAlignment(consensus, mechanical);
  const tradeFlag = mechanical ? String(mechanical?.tradeFlag || 'watch').trim().toLowerCase() : 'unknown';

  if (!consensus?.consensus || consensus?.decision === 'HOLD') {
    return {
      bucket: 'block',
      disagreementScore,
      mechanicalAlignment,
      reasons: ['no_consensus'],
    };
  }

  const reasons = [];
  if (eventCap.mode === 'tiny') {
    const eventDecision = String(input.eventVeto?.decision || '').trim().toUpperCase();
    if (eventDecision === 'VETO') {
      reasons.push(`event_veto:${String(input.eventVeto?.eventSummary || 'active_veto')}`);
      reasons.push('event_veto');
    } else if (eventDecision === 'DEGRADED') {
      reasons.push('event_degraded');
    } else {
      reasons.push('event_caution');
    }
  }
  reasons.push(...nativeGate.reasons);
  if (tradeFlag === 'no-trade') {
    reasons.push('mechanical_no_trade');
  } else if (tradeFlag === 'watch') {
    reasons.push('mechanical_watch');
  }
  if (disagreementScore >= 0.75) {
    reasons.push('high_model_disagreement');
  }
  if (mechanicalAlignment <= 0.2) {
    reasons.push('mechanical_bias_conflict');
  }

  let bucket = 'normal';
  if (eventCap.mode === 'block' || nativeGate.mode === 'block' || tradeFlag === 'no-trade' || mechanicalAlignment <= 0.2) {
    bucket = 'block';
  } else if (eventCap.mode === 'tiny' || nativeGate.mode === 'scaled' || tradeFlag === 'watch' || disagreementScore >= 0.45) {
    bucket = 'tiny';
  }

  return {
    bucket,
    sizeMultiplier: bucket === 'tiny'
      ? combineSizeMultipliers(eventCap.multiplier, nativeGate.multiplier)
      : null,
    disagreementScore: Number(disagreementScore.toFixed(4)),
    mechanicalAlignment: Number(mechanicalAlignment.toFixed(4)),
    reasons,
  };
}

function applySizeBucketToRiskCheck(riskCheck = {}, bucket = 'normal', assetClass = 'us_equity', sizeMultiplier = null) {
  if (!riskCheck || riskCheck.approved !== true || riskCheck.maxShares == null) {
    return riskCheck;
  }
  if (bucket === 'normal') {
    return { ...riskCheck };
  }
  if (bucket === 'block') {
    return {
      approved: false,
      violations: [...(Array.isArray(riskCheck.violations) ? riskCheck.violations : []), 'CONSENSUS_SIZER: size bucket blocked execution'],
      maxShares: null,
      stopLossPrice: riskCheck.stopLossPrice ?? null,
    };
  }

  const multiplier = resolveAppliedSizeMultiplier(bucket, assetClass, sizeMultiplier);
  const rawShares = toNumber(riskCheck.maxShares, 0) * multiplier;
  const roundedShares = assetClass === 'crypto'
    ? Math.floor(rawShares * 1_000_000) / 1_000_000
    : Math.max(0, Math.floor(rawShares));
  if (roundedShares <= 0) {
    return {
      approved: false,
      violations: [...(Array.isArray(riskCheck.violations) ? riskCheck.violations : []), 'CONSENSUS_SIZER: tiny bucket reduced size below minimum'],
      maxShares: null,
      stopLossPrice: riskCheck.stopLossPrice ?? null,
    };
  }
  return {
    ...riskCheck,
    maxShares: roundedShares,
    positionNotional: Number.isFinite(Number(riskCheck.positionNotional))
      ? Number((toNumber(riskCheck.positionNotional, 0) * multiplier).toFixed(2))
      : riskCheck.positionNotional ?? null,
    margin: Number.isFinite(Number(riskCheck.margin))
      ? Number((toNumber(riskCheck.margin, 0) * multiplier).toFixed(2))
      : riskCheck.margin ?? null,
  };
}

module.exports = {
  applySizeBucketToRiskCheck,
  resolveAppliedSizeMultiplier,
  sizeConsensusTrade,
};
