'use strict';

const scanner = require('./polymarket-scanner');

const AGENT_PROFILES = Object.freeze({
  architect: Object.freeze({
    followWeight: 0.28,
    timeWeight: 0.12,
    reversionWeight: 0.1,
    spreadPenaltyWeight: 0.22,
    liquidityWeight: 0.06,
    categoryBiases: Object.freeze({
      politics: -0.01,
      crypto: -0.015,
      finance: 0.01,
      sports: 0,
      world: -0.005,
    }),
  }),
  builder: Object.freeze({
    followWeight: 0.42,
    timeWeight: 0.16,
    reversionWeight: 0.04,
    spreadPenaltyWeight: 0.14,
    liquidityWeight: 0.08,
    categoryBiases: Object.freeze({
      politics: -0.005,
      crypto: 0.02,
      finance: 0.012,
      sports: 0.01,
      world: 0,
    }),
  }),
  oracle: Object.freeze({
    followWeight: 0.22,
    timeWeight: 0.1,
    reversionWeight: 0.14,
    spreadPenaltyWeight: 0.2,
    liquidityWeight: 0.05,
    categoryBiases: Object.freeze({
      politics: 0.012,
      crypto: -0.01,
      finance: 0.008,
      sports: 0,
      world: 0.015,
    }),
  }),
});

const DEFAULT_MIN_EDGE = 0.1;
const MIN_EDGE_FLOOR = 0.06;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toText(value, fallback = '') {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function normalizeAgentId(value) {
  const normalized = toText(value).toLowerCase();
  if (!AGENT_PROFILES[normalized]) {
    throw new Error(`Unsupported Polymarket agentId: ${value}`);
  }
  return normalized;
}

function getMarketPrice(marketContext = {}) {
  const explicit = toNumber(marketContext.marketPrice, NaN);
  if (Number.isFinite(explicit)) {
    return clamp(explicit, 0.01, 0.99);
  }
  return clamp(toNumber(marketContext.currentPrices?.yes, 0.5), 0.01, 0.99);
}

function getCategoryBias(profile, category) {
  return toNumber(profile.categoryBiases?.[String(category || '').toLowerCase()], 0);
}

function confidenceThreshold(confidence, options = {}) {
  const base = toNumber(options.minEdge, DEFAULT_MIN_EDGE);
  const confidenceAdjustment = clamp((toNumber(confidence, 0.5) - 0.5) * 0.12, -0.02, 0.04);
  return clamp(base - confidenceAdjustment, MIN_EDGE_FLOOR, base + 0.02);
}

function classifyProbability(probability, marketPrice, confidence, options = {}) {
  const edge = toNumber(probability, 0.5) - toNumber(marketPrice, 0.5);
  const threshold = confidenceThreshold(confidence, options);
  if (edge >= threshold) return 'BUY_YES';
  if (edge <= -threshold) return 'BUY_NO';
  return 'HOLD';
}

function describeAssessment(context, estimate, marketPrice) {
  const liquidity = Math.round(toNumber(context.liquidity, 0)).toLocaleString('en-US');
  const spread = toNumber(context.spread, 0);
  const days = toNumber(context.daysToResolution, 0);
  const direction = estimate > marketPrice ? 'above' : estimate < marketPrice ? 'below' : 'near';
  return `${toText(context.question)} | estimate ${direction} market (${(estimate * 100).toFixed(1)}% vs ${(marketPrice * 100).toFixed(1)}%), liquidity $${liquidity}, spread ${(spread * 100).toFixed(1)}c, resolves in ${days.toFixed(1)}d.`;
}

function assessMarket(agentId, marketContext = {}, options = {}) {
  const normalizedAgent = normalizeAgentId(agentId);
  const profile = AGENT_PROFILES[normalizedAgent];
  const marketPrice = getMarketPrice(marketContext);
  const imbalance = marketPrice - 0.5;
  const liquidity = Math.max(1, toNumber(marketContext.liquidity, 0));
  const liquidityScore = clamp(Math.log10(liquidity / 10000 + 1) / 0.7, 0, 1);
  const spread = clamp(toNumber(marketContext.spread, 0), 0, 0.3);
  const spreadPenalty = spread / 0.12;
  const daysToResolution = clamp(toNumber(marketContext.daysToResolution, 45), 1, 120);
  const horizonScore = clamp((45 - daysToResolution) / 45, -1, 1);
  const categoryBias = getCategoryBias(profile, marketContext.category);

  const followAdjustment = imbalance * (profile.followWeight + (liquidityScore * profile.liquidityWeight));
  const timeAdjustment = imbalance * horizonScore * profile.timeWeight;
  const reversionAdjustment = -imbalance * (1 - liquidityScore) * profile.reversionWeight;
  const spreadAdjustment = spreadPenalty * profile.spreadPenaltyWeight * 0.05;
  const estimate = clamp(
    marketPrice + followAdjustment + timeAdjustment + reversionAdjustment + categoryBias - spreadAdjustment,
    0.02,
    0.98
  );
  const divergence = Math.abs(estimate - marketPrice);
  const confidence = clamp(
    0.52
    + (liquidityScore * 0.16)
    + (Math.max(horizonScore, 0) * 0.08)
    + (divergence * 1.2)
    - (spreadPenalty * 0.08),
    0.4,
    0.92
  );

  return {
    marketId: toText(marketContext.conditionId),
    conditionId: toText(marketContext.conditionId),
    probability: Number(estimate.toFixed(4)),
    confidence: Number(confidence.toFixed(2)),
    marketPrice: Number(marketPrice.toFixed(4)),
    direction: classifyProbability(estimate, marketPrice, confidence, options),
    reasoning: describeAssessment(marketContext, estimate, marketPrice),
    context: {
      question: toText(marketContext.question),
      category: toText(marketContext.category),
      resolutionDate: marketContext.resolutionDate || null,
    },
    agent: normalizedAgent,
  };
}

function normalizeMarkets(markets = []) {
  return markets.map((market) => {
    const context = scanner.getMarketContext(market);
    return {
      ...market,
      context,
      currentPrices: market.currentPrices || context.currentPrices,
    };
  });
}

function produceSignals(markets = [], options = {}) {
  const normalizedMarkets = normalizeMarkets(markets);
  const agentIds = Array.isArray(options.agentIds) && options.agentIds.length > 0
    ? options.agentIds.map(normalizeAgentId)
    : null;

  if (agentIds) {
    return new Map(agentIds.map((agentId) => [
      agentId,
      normalizedMarkets.map((market) => assessMarket(agentId, market.context, options)),
    ]));
  }

  const agentId = normalizeAgentId(options.agentId);
  return normalizedMarkets.map((market) => assessMarket(agentId, market.context, options));
}

function summarizeConsensus(conditionId, decision, agreementCount, weightedProbability, marketPrice, threshold) {
  const edgePct = ((weightedProbability - marketPrice) * 100).toFixed(1);
  if (decision === 'BUY_YES') {
    return `${conditionId}: BUY YES with ${agreementCount}/3 support; consensus ${(weightedProbability * 100).toFixed(1)}% vs market ${(marketPrice * 100).toFixed(1)}% (edge ${edgePct} pts, threshold ${(threshold * 100).toFixed(1)} pts).`;
  }
  if (decision === 'BUY_NO') {
    return `${conditionId}: BUY NO with ${agreementCount}/3 support; consensus ${(weightedProbability * 100).toFixed(1)}% vs market ${(marketPrice * 100).toFixed(1)}% (edge ${edgePct} pts, threshold ${(threshold * 100).toFixed(1)} pts).`;
  }
  return `${conditionId}: HOLD; weighted consensus ${(weightedProbability * 100).toFixed(1)}% stays inside the ${(threshold * 100).toFixed(1)} pt edge threshold around market ${(marketPrice * 100).toFixed(1)}%.`;
}

function buildConsensus(agentSignals = [], options = {}) {
  if (!Array.isArray(agentSignals) || agentSignals.length !== 3) {
    throw new Error(`Polymarket consensus requires exactly 3 signals, got ${agentSignals?.length}`);
  }

  const conditionId = toText(agentSignals[0]?.conditionId || agentSignals[0]?.marketId);
  if (!conditionId || !agentSignals.every((signal) => toText(signal?.conditionId || signal?.marketId) === conditionId)) {
    throw new Error('All Polymarket signals must reference the same conditionId');
  }

  const marketPrice = getMarketPrice(agentSignals[0]);
  const normalizedSignals = agentSignals.map((signal) => ({
    ...signal,
    direction: classifyProbability(signal.probability, marketPrice, signal.confidence, options),
  }));
  const votes = {
    BUY_YES: [],
    BUY_NO: [],
    HOLD: [],
  };

  for (const signal of normalizedSignals) {
    votes[signal.direction].push(signal);
  }

  const weightedProbability = normalizedSignals.reduce((sum, signal) => {
    return sum + (toNumber(signal.probability, 0.5) * toNumber(signal.confidence, 0.5));
  }, 0) / normalizedSignals.reduce((sum, signal) => sum + toNumber(signal.confidence, 0.5), 0);
  const averageConfidence = normalizedSignals.reduce((sum, signal) => sum + toNumber(signal.confidence, 0.5), 0) / normalizedSignals.length;
  const threshold = confidenceThreshold(averageConfidence, options);
  const edge = Number((weightedProbability - marketPrice).toFixed(4));

  let decision = 'HOLD';
  let agreeing = [];
  let dissenting = normalizedSignals;
  if (votes.BUY_YES.length >= 2 && edge >= threshold) {
    decision = 'BUY_YES';
    agreeing = votes.BUY_YES;
    dissenting = normalizedSignals.filter((signal) => !agreeing.includes(signal));
  } else if (votes.BUY_NO.length >= 2 && edge <= -threshold) {
    decision = 'BUY_NO';
    agreeing = votes.BUY_NO;
    dissenting = normalizedSignals.filter((signal) => !agreeing.includes(signal));
  }

  return {
    conditionId,
    marketPrice: Number(marketPrice.toFixed(4)),
    probability: Number(weightedProbability.toFixed(4)),
    averageConfidence: Number(averageConfidence.toFixed(2)),
    edge: Number(edge.toFixed(4)),
    threshold: Number(threshold.toFixed(4)),
    decision,
    consensus: agreeing.length >= 2 && decision !== 'HOLD',
    agreementCount: agreeing.length,
    agreeing,
    dissenting,
    summary: summarizeConsensus(conditionId, decision, agreeing.length, weightedProbability, marketPrice, threshold),
  };
}

module.exports = {
  AGENT_PROFILES,
  DEFAULT_MIN_EDGE,
  assessMarket,
  produceSignals,
  buildConsensus,
};
