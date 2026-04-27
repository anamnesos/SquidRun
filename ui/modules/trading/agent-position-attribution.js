'use strict';

const fs = require('fs');
const path = require('path');

const { resolveCoordPath } = require('../../config');

const DEFAULT_POSITION_ATTRIBUTION_STATE_PATH = resolveCoordPath(
  path.join('runtime', 'agent-position-attribution.json'),
  { forWrite: true }
);
const DEFAULT_AGENT_ATTRIBUTION_STATE_PATH = resolveCoordPath(
  path.join('runtime', 'agent-attribution-state.json'),
  { forWrite: true }
);
const DEFAULT_LOOKBACK_MS = 48 * 60 * 60 * 1000;
const AGENT_PRIORITY = ['architect', 'oracle', 'builder'];

function toText(value, fallback = '') {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeTicker(value) {
  const raw = toText(value).toUpperCase().replace('-', '/');
  if (!raw) return '';
  return raw.endsWith('/USD') ? raw : `${raw}/USD`;
}

function normalizeAgentId(value, fallback = '') {
  const normalized = toText(value, fallback).toLowerCase();
  return ['architect', 'oracle', 'builder'].includes(normalized) ? normalized : fallback;
}

function toIsoTimestamp(value, fallback = null) {
  const raw = value == null ? fallback : value;
  if (!raw) return fallback;
  const date = raw instanceof Date ? raw : new Date(raw);
  if (Number.isNaN(date.getTime())) return fallback;
  return date.toISOString();
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function defaultPositionAttributionState() {
  return {
    version: 2,
    positions: {},
    closedPositions: [],
    quarantinedPositions: [],
    updatedAt: null,
  };
}

function normalizePositionRecord(record = {}) {
  return {
    ticker: normalizeTicker(record.ticker || record.asset || record.coin),
    agentId: normalizeAgentId(record.agentId || record.originatingAgentId || record.ownerAgentId || ''),
    direction: toText(record.direction).toUpperCase(),
    entryPrice: toNumber(record.entryPrice, 0),
    exitPrice: record.exitPrice == null ? null : toNumber(record.exitPrice, 0),
    currentSize: toNumber(record.currentSize, 0),
    initialSize: toNumber(record.initialSize, toNumber(record.currentSize, 0)),
    closedSize: toNumber(record.closedSize, 0),
    realizedPnlUsd: record.realizedPnlUsd == null ? null : toNumber(record.realizedPnlUsd, 0),
    marginUsd: toNumber(record.marginUsd, 0),
    leverage: toNumber(record.leverage, 0),
    liquidationPx: record.liquidationPx == null ? null : toNumber(record.liquidationPx, 0),
    markPrice: record.markPrice == null ? null : toNumber(record.markPrice, 0),
    strategyLane: toText(record.strategyLane),
    clientOrderId: toText(record.clientOrderId) || null,
    closeOrderId: toText(record.closeOrderId) || null,
    source: toText(record.source || record.attributionSource || 'hm-defi-execute'),
    reasoning: toText(record.reasoning || record.attributionReasoning),
    openedAt: toIsoTimestamp(record.openedAt, null),
    closedAt: toIsoTimestamp(record.closedAt, null),
    lastLiveSeenAt: toIsoTimestamp(record.lastLiveSeenAt, null),
    quarantinedAt: toIsoTimestamp(record.quarantinedAt, null),
    quarantineReason: toText(record.quarantineReason),
    updatedAt: toIsoTimestamp(record.updatedAt, new Date().toISOString()),
    walletAddress: toText(record.walletAddress) || null,
  };
}

function loadPositionAttributionState(options = {}) {
  const statePath = options.statePath || DEFAULT_POSITION_ATTRIBUTION_STATE_PATH;
  const parsed = readJson(statePath, defaultPositionAttributionState());
  const positions = {};
  for (const [ticker, record] of Object.entries(parsed?.positions || {})) {
    const normalized = normalizePositionRecord({ ticker, ...record });
    if (normalized.ticker) {
      positions[normalized.ticker] = normalized;
    }
  }
  return {
    path: statePath,
    version: toNumber(parsed?.version, 2),
    positions,
    closedPositions: Array.isArray(parsed?.closedPositions)
      ? parsed.closedPositions.map((record) => normalizePositionRecord(record)).filter((record) => record.ticker)
      : [],
    quarantinedPositions: Array.isArray(parsed?.quarantinedPositions)
      ? parsed.quarantinedPositions.map((record) => normalizePositionRecord(record)).filter((record) => record.ticker)
      : [],
    updatedAt: toIsoTimestamp(parsed?.updatedAt, null),
  };
}

function writePositionAttributionState(state = {}, options = {}) {
  const statePath = options.statePath || DEFAULT_POSITION_ATTRIBUTION_STATE_PATH;
  const positions = {};
  for (const [ticker, record] of Object.entries(state?.positions || {})) {
    const normalized = normalizePositionRecord({ ticker, ...record });
    if (normalized.ticker) {
      positions[normalized.ticker] = normalized;
    }
  }
  const closedPositions = Array.isArray(state?.closedPositions)
    ? state.closedPositions.map((record) => normalizePositionRecord(record)).filter((record) => record.ticker)
    : [];
  const quarantinedPositions = Array.isArray(state?.quarantinedPositions)
    ? state.quarantinedPositions.map((record) => normalizePositionRecord(record)).filter((record) => record.ticker)
    : [];
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({
    version: 2,
    positions,
    closedPositions,
    quarantinedPositions,
    updatedAt: new Date().toISOString(),
  }, null, 2));
  return statePath;
}

function normalizeLivePosition(position = {}, options = {}) {
  const raw = position?.raw && typeof position.raw === 'object' ? position.raw : position;
  const ticker = normalizeTicker(position?.ticker || raw?.ticker || raw?.coin || position?.coin || position?.asset);
  const size = toNumber(position?.size ?? position?.szi ?? raw?.szi ?? raw?.size, 0);
  const absoluteSize = Math.abs(size);
  if (!ticker || absoluteSize <= 0) return null;
  const side = toText(position?.side || raw?.side).toLowerCase();
  const direction = size < 0 || side === 'short' || side === 'sell'
    ? 'SHORT'
    : 'LONG';
  return {
    ticker,
    direction,
    entryPrice: toNumber(position?.entryPx ?? position?.avgPrice ?? raw?.entryPx, 0),
    currentSize: absoluteSize,
    initialSize: absoluteSize,
    marginUsd: toNumber(position?.marginUsd ?? raw?.marginUsed ?? raw?.positionValue, 0),
    leverage: toNumber(position?.leverage?.value ?? position?.leverage ?? raw?.leverage?.value ?? raw?.leverage, 0),
    liquidationPx: toNumber(position?.liquidationPx ?? raw?.liquidationPx, 0) || null,
    markPrice: toNumber(position?.markPrice ?? position?.midPx ?? raw?.markPx ?? raw?.markPrice, 0) || null,
    walletAddress: toText(options.walletAddress || position?.walletAddress) || null,
  };
}

function reconcilePositionAttributionWithLivePositions(livePositions = [], options = {}) {
  const state = loadPositionAttributionState(options);
  const nowIso = toIsoTimestamp(options.nowIso || options.nowMs || new Date(), new Date().toISOString());
  const walletAddress = toText(options.walletAddress) || null;
  const liveByTicker = new Map();
  for (const position of Array.isArray(livePositions) ? livePositions : []) {
    const normalized = normalizeLivePosition(position, { walletAddress });
    if (normalized?.ticker) {
      liveByTicker.set(normalized.ticker, normalized);
    }
  }

  const previousOpenTickers = Object.keys(state.positions || {});
  if (
    liveByTicker.size === 0
    && previousOpenTickers.length > 0
    && options.allowEmptyLiveSnapshotQuarantine !== true
  ) {
    return {
      ok: false,
      skipped: true,
      status: 'stale_snapshot',
      reason: 'empty_live_snapshot_with_existing_attributions',
      path: state.path,
      checkedAt: nowIso,
      liveCount: 0,
      previousOpenCount: previousOpenTickers.length,
      previousOpenTickers,
      updatedCount: 0,
      createdCount: 0,
      quarantinedCount: 0,
      liveTickers: [],
      updated: [],
      created: [],
      quarantined: [],
    };
  }

  const quarantined = [];
  const updated = [];
  const created = [];
  const nextPositions = {};
  for (const [ticker, record] of Object.entries(state.positions || {})) {
    const live = liveByTicker.get(ticker);
    if (!live) {
      const quarantinedRecord = normalizePositionRecord({
        ...record,
        ticker,
        currentSize: 0,
        quarantinedAt: nowIso,
        quarantineReason: 'not_in_live_hyperliquid_snapshot',
        updatedAt: nowIso,
        walletAddress: record.walletAddress || walletAddress,
      });
      quarantined.push(quarantinedRecord);
      continue;
    }
    nextPositions[ticker] = normalizePositionRecord({
      ...record,
      ...live,
      ticker,
      agentId: record.agentId || '',
      source: record.source || 'hm-defi-execute',
      strategyLane: record.strategyLane || '',
      openedAt: record.openedAt || nowIso,
      lastLiveSeenAt: nowIso,
      updatedAt: nowIso,
      walletAddress: record.walletAddress || live.walletAddress || walletAddress,
    });
    updated.push(ticker);
  }

  for (const [ticker, live] of liveByTicker.entries()) {
    if (nextPositions[ticker]) continue;
    nextPositions[ticker] = normalizePositionRecord({
      ...live,
      ticker,
      agentId: '',
      source: 'live_snapshot_reconciliation',
      strategyLane: 'manual_unattributed',
      reasoning: 'Created from live Hyperliquid snapshot because no agent attribution record existed.',
      openedAt: nowIso,
      lastLiveSeenAt: nowIso,
      updatedAt: nowIso,
      walletAddress: live.walletAddress || walletAddress,
    });
    created.push(ticker);
  }

  state.positions = nextPositions;
  state.quarantinedPositions = [
    ...(Array.isArray(state.quarantinedPositions) ? state.quarantinedPositions : []),
    ...quarantined,
  ];
  writePositionAttributionState(state, options);
  return {
    ok: true,
    path: state.path,
    checkedAt: nowIso,
    liveCount: liveByTicker.size,
    updatedCount: updated.length,
    createdCount: created.length,
    quarantinedCount: quarantined.length,
    liveTickers: Array.from(liveByTicker.keys()),
    updated,
    created,
    quarantined: quarantined.map((record) => record.ticker),
  };
}

function pickPreferredAgent(agentIds = []) {
  const normalized = Array.from(new Set(
    (Array.isArray(agentIds) ? agentIds : [])
      .map((entry) => normalizeAgentId(entry))
      .filter(Boolean)
  ));
  for (const preferred of AGENT_PRIORITY) {
    if (normalized.includes(preferred)) return preferred;
  }
  return normalized[0] || '';
}

function loadRecentPredictionOwnership(options = {}) {
  const statePath = options.attributionStatePath || DEFAULT_AGENT_ATTRIBUTION_STATE_PATH;
  const lookbackMs = Math.max(60_000, toNumber(options.lookbackMs, DEFAULT_LOOKBACK_MS));
  const nowMs = toNumber(options.nowMs, Date.now());
  const parsed = readJson(statePath, { pendingPredictions: [] });
  const byTicker = new Map();

  for (const prediction of Array.isArray(parsed?.pendingPredictions) ? parsed.pendingPredictions : []) {
    if (toText(prediction?.assetClass).toLowerCase() !== 'crypto') continue;
    const ticker = normalizeTicker(prediction?.ticker);
    if (!ticker) continue;
    const timestampMs = new Date(prediction?.timestamp || 0).getTime();
    if (!Number.isFinite(timestampMs) || (nowMs - timestampMs) > lookbackMs) continue;
    const agentId = normalizeAgentId(prediction?.agentId || prediction?.agent);
    if (!agentId) continue;
    const existing = byTicker.get(ticker) || [];
    existing.push(agentId);
    byTicker.set(ticker, existing);
  }

  const owners = new Map();
  for (const [ticker, agentIds] of byTicker.entries()) {
    const preferred = pickPreferredAgent(agentIds);
    if (preferred) owners.set(ticker, preferred);
  }
  return owners;
}

function resolveTrackedAgentAssets(options = {}) {
  const sources = [
    ...(Array.isArray(options.trackedAssets) ? options.trackedAssets : []),
    ...(Array.isArray(options.trackedTickers) ? options.trackedTickers : []),
  ];
  const tracked = new Set(
    sources
      .map((entry) => normalizeTicker(entry))
      .filter(Boolean)
  );
  const attributionState = loadPositionAttributionState(options);
  for (const ticker of Object.keys(attributionState.positions || {})) {
    const normalized = normalizeTicker(ticker);
    if (normalized) tracked.add(normalized);
  }
  return Array.from(tracked);
}

function resolveAgentPositionOwnership(positions = [], options = {}) {
  const explicitTracked = new Set(resolveTrackedAgentAssets(options));
  const attributionState = loadPositionAttributionState(options);
  const predictionOwners = loadRecentPredictionOwnership(options);
  const tickers = new Set();
  const ownersByTicker = {};

  for (const position of Array.isArray(positions) ? positions : []) {
    const ticker = normalizeTicker(position?.ticker || position?.asset || position?.coin);
    if (!ticker) continue;
    const persistedRecord = attributionState.positions?.[ticker] || null;
    const persistedOwner = normalizeAgentId(
      persistedRecord?.agentId
      || persistedRecord?.originatingAgentId
      || persistedRecord?.ownerAgentId
      || ''
    );
    const inlineOwner = normalizeAgentId(position?.owner || position?.source || position?.agentId || '');
    const predictedOwner = normalizeAgentId(predictionOwners.get(ticker) || '');
    const owner = persistedOwner || inlineOwner || predictedOwner;
    if (explicitTracked.has(ticker) || owner) {
      tickers.add(ticker);
      if (owner) {
        ownersByTicker[ticker] = owner;
      }
    }
  }

  return {
    tickers: Array.from(tickers),
    ownersByTicker,
  };
}

function upsertOpenPosition(record = {}, options = {}) {
  const state = loadPositionAttributionState(options);
  const normalized = normalizePositionRecord(record);
  if (!normalized.ticker) return null;
  const existing = state.positions[normalized.ticker] || {};
  state.positions[normalized.ticker] = {
    ...existing,
    ...normalized,
    ticker: normalized.ticker,
    agentId: normalized.agentId || existing.agentId || '',
    openedAt: normalized.openedAt || existing.openedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  writePositionAttributionState(state, options);
  return state.positions[normalized.ticker];
}

function recordClosedPosition(record = {}, options = {}) {
  const state = loadPositionAttributionState(options);
  const normalized = normalizePositionRecord(record);
  if (!normalized.ticker) return null;
  const existing = state.positions[normalized.ticker] || {};
  const closedRecord = {
    ...existing,
    ...normalized,
    ticker: normalized.ticker,
    agentId: normalized.agentId || existing.agentId || '',
    openedAt: normalized.openedAt || existing.openedAt || null,
    closedAt: normalized.closedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  delete state.positions[normalized.ticker];
  state.closedPositions.push(closedRecord);
  writePositionAttributionState(state, options);
  return closedRecord;
}

module.exports = {
  DEFAULT_POSITION_ATTRIBUTION_STATE_PATH,
  DEFAULT_AGENT_ATTRIBUTION_STATE_PATH,
  loadPositionAttributionState,
  resolveTrackedAgentAssets,
  resolveAgentPositionOwnership,
  normalizeLivePosition,
  reconcilePositionAttributionWithLivePositions,
  upsertOpenPosition,
  recordClosedPosition,
};
