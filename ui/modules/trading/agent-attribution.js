'use strict';

const fs = require('fs');
const path = require('path');

const { resolveCoordPath } = require('../../config');

const DEFAULT_AGENT_ATTRIBUTION_STATE_PATH = resolveCoordPath(path.join('runtime', 'agent-attribution-state.json'), { forWrite: true });
const SUPPORTED_DIRECTIONS = new Set(['BUY', 'SELL', 'HOLD']);

function toText(value, fallback = '') {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function toTicker(value) {
  return toText(value).toUpperCase();
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toIsoTimestamp(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return date.toISOString();
}

function normalizeAgentId(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) {
    throw new Error('agentId is required');
  }
  return normalized;
}

function normalizeDirection(value, fallback = 'HOLD') {
  const normalized = String(value || '').trim().toUpperCase();
  if (!normalized) return fallback;
  if (!SUPPORTED_DIRECTIONS.has(normalized)) {
    throw new Error(`Unsupported direction: ${value}`);
  }
  return normalized;
}

function normalizeAssetClass(value, fallback = 'us_equity') {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return fallback;
  if (['crypto', 'solana_token', 'us_equity'].includes(normalized)) {
    return normalized;
  }
  return fallback;
}

function normalizeMarketType(value, assetClass = 'us_equity') {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized) return normalized;
  if (assetClass === 'crypto') return 'crypto';
  if (assetClass === 'solana_token') return 'solana';
  return 'stocks';
}

function defaultAttributionState() {
  return {
    pendingPredictions: [],
    settledPredictions: [],
    updatedAt: null,
  };
}

function normalizePredictionRecord(record = {}) {
  const assetClass = normalizeAssetClass(record.assetClass || record.asset_class);
  return {
    agentId: normalizeAgentId(record.agentId || record.agent),
    ticker: toTicker(record.ticker),
    direction: normalizeDirection(record.direction),
    confidence: Math.max(0, Math.min(1, toNumber(record.confidence, 0))),
    timestamp: toIsoTimestamp(record.timestamp, new Date().toISOString()),
    assetClass,
    marketType: normalizeMarketType(record.marketType || record.market_type, assetClass),
    reasoning: toText(record.reasoning),
    source: toText(record.source),
  };
}

function normalizeSettledRecord(record = {}) {
  const assetClass = normalizeAssetClass(record.assetClass || record.asset_class);
  return {
    agentId: normalizeAgentId(record.agentId || record.agent),
    ticker: toTicker(record.ticker),
    predictedDirection: normalizeDirection(record.predictedDirection || record.direction),
    actualDirection: normalizeDirection(record.actualDirection),
    confidence: Math.max(0, Math.min(1, toNumber(record.confidence, 0))),
    actualReturn: toNumber(record.actualReturn, 0),
    signedReturn: toNumber(record.signedReturn, 0),
    correct: Boolean(record.correct),
    score: toNumber(record.score, 0),
    timestamp: toIsoTimestamp(record.timestamp, new Date().toISOString()),
    outcomeTimestamp: toIsoTimestamp(record.outcomeTimestamp, new Date().toISOString()),
    assetClass,
    marketType: normalizeMarketType(record.marketType || record.market_type, assetClass),
    source: toText(record.source),
  };
}

function normalizeAttributionState(state = {}) {
  return {
    ...defaultAttributionState(),
    ...state,
    pendingPredictions: Array.isArray(state.pendingPredictions)
      ? state.pendingPredictions.map((record) => normalizePredictionRecord(record))
      : [],
    settledPredictions: Array.isArray(state.settledPredictions)
      ? state.settledPredictions.map((record) => normalizeSettledRecord(record))
      : [],
    updatedAt: toIsoTimestamp(state.updatedAt, null),
  };
}

function readAttributionState(statePath = DEFAULT_AGENT_ATTRIBUTION_STATE_PATH) {
  try {
    return normalizeAttributionState(JSON.parse(fs.readFileSync(statePath, 'utf8')));
  } catch {
    return defaultAttributionState();
  }
}

function writeAttributionState(statePath = DEFAULT_AGENT_ATTRIBUTION_STATE_PATH, state = {}) {
  const normalized = normalizeAttributionState(state);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({
    ...normalized,
    updatedAt: new Date().toISOString(),
  }, null, 2));
}

function predictionKey(record = {}) {
  return [
    normalizeAgentId(record.agentId || record.agent),
    toTicker(record.ticker),
    normalizeAssetClass(record.assetClass || record.asset_class),
    normalizeMarketType(record.marketType || record.market_type, normalizeAssetClass(record.assetClass || record.asset_class)),
  ].join('::');
}

function resolveState(options = {}) {
  const statePath = options.statePath || DEFAULT_AGENT_ATTRIBUTION_STATE_PATH;
  const state = options.state
    ? normalizeAttributionState(options.state)
    : readAttributionState(statePath);
  return {
    statePath,
    state,
  };
}

function persistStateIfNeeded(statePath, state, persist) {
  if (persist === false) return;
  writeAttributionState(statePath, state);
}

function deriveActualDirection(actualReturn, options = {}) {
  if (options.actualDirection || options.direction) {
    return normalizeDirection(options.actualDirection || options.direction);
  }

  const assetClass = normalizeAssetClass(options.assetClass || options.asset_class);
  const numericReturn = toNumber(actualReturn, 0);
  if (numericReturn > 0) return 'BUY';
  if (numericReturn < 0) return 'SELL';
  return 'HOLD';
}

function computeSignedReturn(predictedDirection, actualReturn, actualDirection) {
  if (predictedDirection === 'BUY') {
    return actualReturn;
  }
  if (predictedDirection === 'SELL') {
    return -actualReturn;
  }
  if (predictedDirection === 'HOLD' && actualDirection === 'HOLD') {
    return 0;
  }
  return -Math.abs(actualReturn);
}

function isPredictionCorrect(predictedDirection, actualDirection) {
  return normalizeDirection(predictedDirection) === normalizeDirection(actualDirection);
}

function recordPrediction(agentId, ticker, direction, confidence, timestamp, options = {}) {
  const { statePath, state } = resolveState(options);
  const prediction = normalizePredictionRecord({
    agentId,
    ticker,
    direction,
    confidence,
    timestamp,
    ...options,
  });
  const pending = state.pendingPredictions.filter((entry) => predictionKey(entry) !== predictionKey(prediction));
  pending.push(prediction);
  persistStateIfNeeded(statePath, {
    ...state,
    pendingPredictions: pending,
  }, options.persist);
  return prediction;
}

function recordOutcome(ticker, actualDirection, actualReturn, timestamp, options = {}) {
  const assetClass = normalizeAssetClass(options.assetClass || options.asset_class);
  const marketType = normalizeMarketType(options.marketType || options.market_type, assetClass);
  const normalizedOutcome = {
    ticker: toTicker(ticker),
    actualDirection: deriveActualDirection(actualReturn, { ...options, actualDirection }),
    actualReturn: toNumber(actualReturn, 0),
    timestamp: toIsoTimestamp(timestamp, new Date().toISOString()),
    assetClass,
    marketType,
  };
  const { statePath, state } = resolveState(options);
  const settled = [];
  const pending = [];

  for (const prediction of state.pendingPredictions) {
    if (
      prediction.ticker === normalizedOutcome.ticker
      && prediction.assetClass === normalizedOutcome.assetClass
      && prediction.marketType === normalizedOutcome.marketType
    ) {
      const correct = isPredictionCorrect(prediction.direction, normalizedOutcome.actualDirection);
      const signedReturn = computeSignedReturn(prediction.direction, normalizedOutcome.actualReturn, normalizedOutcome.actualDirection);
      settled.push(normalizeSettledRecord({
        agentId: prediction.agentId,
        ticker: prediction.ticker,
        predictedDirection: prediction.direction,
        actualDirection: normalizedOutcome.actualDirection,
        confidence: prediction.confidence,
        actualReturn: normalizedOutcome.actualReturn,
        signedReturn,
        correct,
        score: signedReturn * prediction.confidence,
        timestamp: prediction.timestamp,
        outcomeTimestamp: normalizedOutcome.timestamp,
        assetClass: prediction.assetClass,
        marketType: prediction.marketType,
        source: prediction.source,
      }));
      continue;
    }

    pending.push(prediction);
  }

  const nextState = {
    ...state,
    pendingPredictions: pending,
    settledPredictions: [...state.settledPredictions, ...settled],
  };
  persistStateIfNeeded(statePath, nextState, options.persist);

  return {
    ticker: normalizedOutcome.ticker,
    actualDirection: normalizedOutcome.actualDirection,
    actualReturn: normalizedOutcome.actualReturn,
    assetClass: normalizedOutcome.assetClass,
    marketType: normalizedOutcome.marketType,
    settled,
  };
}

function filterSettledRecords(records = [], options = {}) {
  const assetClass = options.assetClass || options.asset_class || 'all';
  const marketType = options.marketType || options.market_type || 'all';
  return records.filter((record) => {
    if (assetClass !== 'all' && normalizeAssetClass(record.assetClass) !== normalizeAssetClass(assetClass)) {
      return false;
    }
    if (marketType !== 'all' && normalizeMarketType(record.marketType, record.assetClass) !== normalizeMarketType(marketType, record.assetClass)) {
      return false;
    }
    return true;
  });
}

function summarizeStats(agentId, records = [], options = {}) {
  const filtered = filterSettledRecords(records, options).filter((record) => record.agentId === normalizeAgentId(agentId));
  const totalPredictions = filtered.length;
  const calledCorrectly = filtered.filter((record) => record.correct).length;
  const avgReturn = totalPredictions > 0
    ? filtered.reduce((sum, record) => sum + record.signedReturn, 0) / totalPredictions
    : 0;
  const avgConfidence = totalPredictions > 0
    ? filtered.reduce((sum, record) => sum + record.confidence, 0) / totalPredictions
    : 0;
  const weightedScore = filtered.reduce((sum, record) => sum + record.score, 0);

  return {
    agentId: normalizeAgentId(agentId),
    assetClass: options.assetClass || options.asset_class || 'all',
    marketType: options.marketType || options.market_type || 'all',
    winRate: totalPredictions > 0 ? calledCorrectly / totalPredictions : 0,
    avgReturn,
    avgConfidence,
    weightedScore,
    calledCorrectly,
    totalPredictions,
    lastOutcomeAt: filtered.length > 0 ? filtered[filtered.length - 1].outcomeTimestamp : null,
  };
}

function getAgentStats(agentId, options = {}) {
  const { state } = resolveState(options);
  return summarizeStats(agentId, state.settledPredictions, options);
}

function getLeaderboard(options = {}) {
  const { state } = resolveState(options);
  const filtered = filterSettledRecords(state.settledPredictions, options);
  const agentIds = Array.from(new Set(filtered.map((record) => record.agentId))).sort();
  return agentIds
    .map((agentId) => summarizeStats(agentId, filtered, options))
    .sort((left, right) => {
      if (right.weightedScore !== left.weightedScore) {
        return right.weightedScore - left.weightedScore;
      }
      if (right.winRate !== left.winRate) {
        return right.winRate - left.winRate;
      }
      return right.totalPredictions - left.totalPredictions;
    });
}

function getPendingPredictions(options = {}) {
  const { state } = resolveState(options);
  return state.pendingPredictions.map((record) => ({ ...record }));
}

module.exports = {
  DEFAULT_AGENT_ATTRIBUTION_STATE_PATH,
  defaultAttributionState,
  getAgentStats,
  getLeaderboard,
  getPendingPredictions,
  normalizeAssetClass,
  normalizeDirection,
  readAttributionState,
  recordOutcome,
  recordPrediction,
  writeAttributionState,
};
