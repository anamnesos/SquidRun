'use strict';

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toText(value, fallback = '') {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function toTicker(value) {
  return toText(value).toUpperCase();
}

function toConfidence(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(1, numeric));
}

function extractAssetFromTicker(ticker = '') {
  const normalized = toTicker(ticker);
  return normalized.includes('/') ? normalized.split('/')[0] : normalized;
}

function isBrakeDecision(value) {
  const normalized = toTicker(value);
  return normalized === 'CAUTION' || normalized === 'DEGRADED' || normalized === 'VETO';
}

function normalizePosition(position = {}) {
  const size = toNumber(position.size ?? position.szi, 0);
  const side = toText(position.side, '').toLowerCase() || (size < 0 ? 'short' : (size > 0 ? 'long' : 'flat'));
  const coin = toText(position.coin || position.asset, '').toUpperCase();
  const ticker = coin ? `${coin}/USD` : '';
  const entryPx = toNumber(position.entryPx, 0);
  const markPrice = toNumber(position.markPrice, 0);
  const stopLossPrice = toNumber(position.stopLossPrice, 0) || null;
  const peakUnrealizedPnl = toNumber(position.peakUnrealizedPnl, 0);
  const unrealizedPnl = toNumber(position.unrealizedPnl, 0);
  const warningLevel = toText(position.warningLevel, '').toLowerCase() || null;
  const drawdownFromPeakPct = toNumber(position.drawdownFromPeakPct, 0);
  const timeOpenMs = Math.max(0, toNumber(position.timeOpenMs, 0));
  const notionalUsd = markPrice > 0 ? Number((Math.abs(size) * markPrice).toFixed(4)) : 0;
  const returnPct = entryPx > 0 && markPrice > 0
    ? Number((((side === 'short' ? (entryPx - markPrice) : (markPrice - entryPx)) / entryPx)).toFixed(4))
    : 0;
  return {
    ...position,
    coin,
    ticker,
    side,
    size,
    entryPx,
    markPrice,
    stopLossPrice,
    peakUnrealizedPnl,
    unrealizedPnl,
    warningLevel,
    drawdownFromPeakPct,
    timeOpenMs,
    notionalUsd,
    returnPct,
  };
}

function buildResultsByTicker(results = []) {
  const map = new Map();
  for (const result of Array.isArray(results) ? results : []) {
    const ticker = toTicker(result?.ticker);
    if (!ticker) continue;
    map.set(ticker, result);
  }
  return map;
}

function buildApprovedByTicker(approvedTrades = []) {
  const map = new Map();
  for (const trade of Array.isArray(approvedTrades) ? approvedTrades : []) {
    const ticker = toTicker(trade?.ticker);
    if (!ticker) continue;
    map.set(ticker, trade);
  }
  return map;
}

function classifyThesis(position, consensusResult = null) {
  const decision = toTicker(consensusResult?.decision || '');
  if (!decision || decision === 'HOLD') {
    return {
      state: 'neutral',
      opposing: false,
      aligned: false,
      direction: 'HOLD',
    };
  }
  if (position.side === 'short') {
    if (decision === 'SELL' || decision === 'SHORT') {
      return { state: 'aligned', aligned: true, opposing: false, direction: decision };
    }
    if (decision === 'BUY' || decision === 'COVER') {
      return { state: 'invalidated', aligned: false, opposing: true, direction: decision };
    }
  }
  if (position.side === 'long') {
    if (decision === 'BUY') {
      return { state: 'aligned', aligned: true, opposing: false, direction: decision };
    }
    if (decision === 'SELL' || decision === 'SHORT') {
      return { state: 'invalidated', aligned: false, opposing: true, direction: decision };
    }
  }
  return {
    state: 'neutral',
    opposing: false,
    aligned: false,
    direction: decision,
  };
}

function computeTightenedStop(position, urgency = 'warning') {
  const entryPx = toNumber(position.entryPx, 0);
  const markPrice = toNumber(position.markPrice, 0);
  if (entryPx <= 0 || markPrice <= 0) return null;

  const isLong = position.side === 'long';
  const profitDistance = isLong ? (markPrice - entryPx) : (entryPx - markPrice);
  if (!Number.isFinite(profitDistance) || profitDistance <= 0) return null;

  const retainRatio = urgency === 'urgent' ? 0.7 : 0.45;
  const proposed = isLong
    ? entryPx + (profitDistance * retainRatio)
    : entryPx - (profitDistance * retainRatio);
  const rounded = Number(proposed.toFixed(4));
  if (isLong) {
    if (rounded <= markPrice && rounded > 0) {
      return rounded;
    }
    return null;
  }
  if (rounded >= markPrice && rounded > 0) {
    return rounded;
  }
  return null;
}

function buildMarketPressure(position, context = {}) {
  const macroRisk = context.macroRisk || null;
  const eventVeto = context.eventVeto || null;
  const eventDecision = toTicker(eventVeto?.decision || 'CLEAR') || 'CLEAR';
  const macroRegime = toText(macroRisk?.regime || macroRisk?.strategyMode, '').toLowerCase() || null;
  const macroBlocksCurrentSide = position.side === 'long' && macroRisk?.constraints?.allowLongs === false;
  const eventBrakeActive = isBrakeDecision(eventDecision);
  const additiveBrake = eventDecision === 'VETO' || macroBlocksCurrentSide;
  return {
    macroRegime,
    eventDecision,
    macroBlocksCurrentSide,
    eventBrakeActive,
    additiveBrake,
  };
}

function chooseManagementAction(position, context = {}) {
  const consensusResult = context.consensusResult || null;
  const thesis = classifyThesis(position, consensusResult);
  const approvedTrade = context.approvedTrade || null;
  const warningLevel = position.warningLevel || null;
  const consensusConfidence = toConfidence(consensusResult?.confidence);
  const profitable = position.unrealizedPnl > 0 || position.peakUnrealizedPnl > 0;
  const marketPressure = buildMarketPressure(position, context);
  const hardRisk = warningLevel === 'critical' || position.drawdownFromPeakPct >= 0.5;

  if (hardRisk) {
    return {
      action: 'risk_loop_owner',
      executable: false,
      owner: 'supervisor_risk',
      priority: 'critical',
      rationale: 'Supervisor risk loop owns critical liquidation/giveback exits.',
      managementIntent: 'handoff_risk_loop',
      thesisState: thesis.state,
      proposedStopLossPrice: null,
      marketPressure,
    };
  }

  if (thesis.opposing && consensusConfidence >= 0.65) {
    return {
      action: 'close',
      executable: true,
      owner: 'position_management',
      priority: 'high',
      rationale: `Consensus ${thesis.direction} invalidates the current ${position.side} thesis.`,
      managementIntent: 'invalidate_thesis',
      thesisState: thesis.state,
      proposedStopLossPrice: null,
      marketPressure,
    };
  }

  if (warningLevel === 'urgent' || warningLevel === 'warning') {
    const proposedStopLossPrice = computeTightenedStop(position, warningLevel);
    if (Number.isFinite(proposedStopLossPrice) && proposedStopLossPrice > 0) {
      const currentStop = toNumber(position.stopLossPrice, 0);
      const improvesStop = position.side === 'short'
        ? (!currentStop || proposedStopLossPrice < currentStop)
        : (!currentStop || proposedStopLossPrice > currentStop);
      if (improvesStop) {
        return {
          action: 'tighten_stop',
          executable: true,
          owner: 'position_management',
          priority: warningLevel === 'urgent' ? 'high' : 'medium',
          rationale: `${warningLevel} giveback risk: tighten stop to preserve more of the open gain.`,
          managementIntent: 'protect_gain',
          thesisState: thesis.state,
          proposedStopLossPrice,
          marketPressure,
        };
      }
    }
  }

  const shouldReduceForPressure = profitable && (
    (thesis.opposing && consensusConfidence > 0)
    || marketPressure.additiveBrake
    || (position.drawdownFromPeakPct >= 0.25 && thesis.state !== 'aligned')
  );

  if (shouldReduceForPressure) {
    return {
      action: 'reduce',
      executable: false,
      owner: 'position_management',
      priority: thesis.opposing || marketPressure.additiveBrake ? 'medium' : 'low',
      rationale: thesis.opposing
        ? `Consensus is leaning ${thesis.direction} against the current ${position.side}; reduce exposure before the thesis fully breaks.`
        : (marketPressure.eventDecision === 'VETO'
          ? 'Event veto is active against fresh risk; reduce the existing position rather than adding through the brake.'
          : 'Macro or drawdown pressure argues for de-risking the open position instead of holding size unchanged.'),
      managementIntent: 'de_risk',
      thesisState: thesis.state,
      proposedStopLossPrice: null,
      marketPressure,
    };
  }

  if (thesis.aligned && approvedTrade && !marketPressure.additiveBrake) {
    return {
      action: 'add',
      executable: false,
      owner: 'position_management',
      priority: 'low',
      rationale: 'Consensus remains aligned with the open position, but additive execution is not automated yet.',
      managementIntent: 'scale_winner',
      thesisState: thesis.state,
      proposedStopLossPrice: null,
      marketPressure,
    };
  }

  return {
    action: 'hold',
    executable: false,
    owner: 'position_management',
    priority: 'low',
    rationale: marketPressure.additiveBrake && thesis.aligned
      ? 'Consensus is still aligned, but macro/event brakes argue against adding or reshaping the position right now.'
      : (thesis.aligned
        ? 'Consensus remains aligned with the current thesis.'
        : 'No strong management action is justified from the current context.'),
    managementIntent: marketPressure.additiveBrake && thesis.aligned ? 'respect_market_brake' : 'monitor',
    thesisState: thesis.state,
    proposedStopLossPrice: null,
    marketPressure,
  };
}

function buildDirectiveSummary(directives = []) {
  return directives.reduce((summary, directive) => {
    summary.total += 1;
    if (directive.executable) {
      summary.executable += 1;
    } else {
      summary.advisory += 1;
    }
    summary.byAction[directive.action] = (summary.byAction[directive.action] || 0) + 1;
    summary.byIntent[directive.managementIntent] = (summary.byIntent[directive.managementIntent] || 0) + 1;
    return summary;
  }, {
    total: 0,
    executable: 0,
    advisory: 0,
    byAction: {},
    byIntent: {},
  });
}

function buildPositionManagementContext(portfolioState = {}, marketContext = {}, riskState = {}) {
  const positions = (Array.isArray(portfolioState?.positions) ? portfolioState.positions : [])
    .map(normalizePosition)
    .filter((position) => position.coin && position.side !== 'flat' && Math.abs(position.size) > 0);

  return {
    contractVersion: 2,
    ownerModel: {
      strategicOwner: 'position_management',
      emergencyOwner: 'supervisor_risk',
    },
    portfolio_state: {
      checkedAt: portfolioState?.checkedAt || null,
      positions,
      accountValue: toNumber(portfolioState?.accountValue, 0),
      walletAddress: toText(portfolioState?.walletAddress, null),
      managedTickers: positions.map((position) => position.ticker),
    },
    market_context: {
      macroRisk: marketContext?.macroRisk || null,
      eventVeto: marketContext?.eventVeto || null,
      results: Array.isArray(marketContext?.results) ? marketContext.results : [],
    },
    risk_state: {
      warnings: Array.isArray(riskState?.warnings) ? riskState.warnings : [],
      approvedTrades: Array.isArray(riskState?.approvedTrades) ? riskState.approvedTrades : [],
      rejectedTrades: Array.isArray(riskState?.rejectedTrades) ? riskState.rejectedTrades : [],
    },
  };
}

function positionManagement(portfolioState = {}, marketContext = {}, riskState = {}) {
  const context = buildPositionManagementContext(portfolioState, marketContext, riskState);
  const resultsByTicker = buildResultsByTicker(context.market_context.results);
  const approvedByTicker = buildApprovedByTicker(context.risk_state.approvedTrades);

  const directives = context.portfolio_state.positions.map((position) => {
    const consensusResult = resultsByTicker.get(position.ticker) || null;
    const approvedTrade = approvedByTicker.get(position.ticker) || null;
    const decision = chooseManagementAction(position, {
      consensusResult,
      approvedTrade,
      macroRisk: context.market_context.macroRisk,
      eventVeto: context.market_context.eventVeto,
    });
    return {
      ticker: position.ticker,
      asset: extractAssetFromTicker(position.ticker),
      positionSide: position.side,
      positionValueUsd: position.notionalUsd,
      returnPct: position.returnPct,
      timeOpenMs: position.timeOpenMs,
      currentStopLossPrice: position.stopLossPrice,
      proposedStopLossPrice: decision.proposedStopLossPrice,
      warningLevel: position.warningLevel,
      drawdownFromPeakPct: position.drawdownFromPeakPct,
      consensusDecision: toText(consensusResult?.decision || 'HOLD', 'HOLD').toUpperCase(),
      consensusConfidence: toConfidence(consensusResult?.confidence),
      action: decision.action,
      executable: decision.executable,
      owner: decision.owner,
      contractOwner: 'position_management',
      emergencyOwner: 'supervisor_risk',
      priority: decision.priority,
      managementIntent: decision.managementIntent || 'monitor',
      thesisState: decision.thesisState,
      marketPressure: decision.marketPressure || null,
      rationale: decision.rationale,
    };
  });

  return {
    ok: true,
    contract: 'position_management',
    context,
    directives,
    managedTickers: directives.map((directive) => directive.ticker),
    summary: buildDirectiveSummary(directives),
    executableDirectives: directives.filter((directive) => directive.executable),
    advisoryDirectives: directives.filter((directive) => !directive.executable),
  };
}

module.exports = {
  buildPositionManagementContext,
  positionManagement,
  _internals: {
    classifyThesis,
    chooseManagementAction,
    computeTightenedStop,
    normalizePosition,
  },
};
