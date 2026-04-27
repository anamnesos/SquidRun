'use strict';

const fs = require('fs');
const path = require('path');

const { resolveCoordPath } = require('../../config');
const hyperliquidClient = require('./hyperliquid-client');

const DEFAULT_MARKET_SCANNER_STATE_PATH = resolveCoordPath(
  path.join('runtime', 'market-scanner-state.json'),
  { forWrite: true }
);
const DEFAULT_MOVE_4H_THRESHOLD_PCT = 0.015;
const DEFAULT_MOVE_24H_THRESHOLD_PCT = 0.025;
const DEFAULT_TOP_MOVER_LIMIT = 8;
const DEFAULT_HISTORY_RETENTION_MS = 48 * 60 * 60 * 1000;
const DEFAULT_MARKET_SCANNER_MIN_UNIVERSE_SIZE = 180;
const DEFAULT_MARKET_SCANNER_MAX_UNIVERSE_DROP_RATIO = 0.8;
const FOUR_HOUR_MS = 4 * 60 * 60 * 1000;
const TWENTY_FOUR_HOUR_MS = 24 * 60 * 60 * 1000;
const LOOKBACK_TOLERANCE_MS = 90 * 60 * 1000;
const HISTORY_LIMIT = 160;

function toText(value, fallback = '') {
  const normalized = String(value ?? '').trim();
  return normalized || fallback;
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function round(value, digits = 4) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Number(numeric.toFixed(digits));
}

function toIsoTimestamp(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return date.toISOString();
}

function pctChange(current, baseline) {
  const currentNumber = toNumber(current, NaN);
  const baselineNumber = toNumber(baseline, NaN);
  if (!Number.isFinite(currentNumber) || !Number.isFinite(baselineNumber) || baselineNumber === 0) {
    return null;
  }
  return round((currentNumber - baselineNumber) / baselineNumber, 4);
}

function ensureDirectoryForFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function normalizeTicker(value) {
  const normalized = toText(value).toUpperCase();
  if (!normalized) return '';
  return normalized.endsWith('/USD') ? normalized : `${normalized}/USD`;
}

function normalizeCoin(value) {
  const ticker = normalizeTicker(value);
  return ticker ? ticker.slice(0, -4) : '';
}

function defaultMarketScannerState() {
  return {
    updatedAt: null,
    lastProcessedAt: null,
    lastScanAt: null,
    nextEvent: null,
    lastResult: null,
    lastScan: null,
    assetCount: 0,
    assets: [],
    flaggedMovers: [],
    topMovers: [],
    history: {},
  };
}

function normalizeHistoryPoint(point = {}) {
  return {
    recordedAt: toIsoTimestamp(point.recordedAt, null),
    price: toNumber(point.price, NaN),
    openInterest: toNumber(point.openInterest, NaN),
    volumeUsd24h: toNumber(point.volumeUsd24h, NaN),
    fundingRate: toNumber(point.fundingRate, NaN),
  };
}

function pruneHistory(entries = [], nowMs = Date.now(), retentionMs = DEFAULT_HISTORY_RETENTION_MS) {
  return (Array.isArray(entries) ? entries : [])
    .map(normalizeHistoryPoint)
    .filter((entry) => {
      const recordedAtMs = Date.parse(entry.recordedAt || '');
      return Number.isFinite(recordedAtMs) && (nowMs - recordedAtMs) <= retentionMs;
    })
    .sort((left, right) => Date.parse(left.recordedAt || 0) - Date.parse(right.recordedAt || 0))
    .slice(-HISTORY_LIMIT);
}

function appendHistoryPoint(entries = [], point = {}, options = {}) {
  const recordedAtMs = Date.parse(point.recordedAt || Date.now());
  return pruneHistory(
    [...(Array.isArray(entries) ? entries : []), normalizeHistoryPoint(point)],
    Number.isFinite(recordedAtMs) ? recordedAtMs : Date.now(),
    Math.max(FOUR_HOUR_MS, toNumber(options.retentionMs, DEFAULT_HISTORY_RETENTION_MS))
  );
}

function findLookbackPoint(entries = [], targetMs, toleranceMs = LOOKBACK_TOLERANCE_MS) {
  let best = null;
  let bestDistance = Infinity;
  for (const entry of Array.isArray(entries) ? entries : []) {
    const recordedAtMs = Date.parse(entry.recordedAt || '');
    if (!Number.isFinite(recordedAtMs)) continue;
    const distance = Math.abs(recordedAtMs - targetMs);
    if (distance > toleranceMs) continue;
    if (distance < bestDistance) {
      best = entry;
      bestDistance = distance;
    }
  }
  return best;
}

function readMarketScannerState(statePath = DEFAULT_MARKET_SCANNER_STATE_PATH) {
  try {
    return normalizeMarketScannerState(JSON.parse(fs.readFileSync(statePath, 'utf8')));
  } catch {
    return defaultMarketScannerState();
  }
}

function writeMarketScannerState(statePath = DEFAULT_MARKET_SCANNER_STATE_PATH, state = {}) {
  const normalized = normalizeMarketScannerState(state);
  ensureDirectoryForFile(statePath);
  fs.writeFileSync(statePath, JSON.stringify(normalized, null, 2));
  return normalized;
}

function normalizeMover(entry = {}) {
  const coin = normalizeCoin(entry.coin || entry.ticker);
  const ticker = normalizeTicker(entry.ticker || coin);
  return {
    coin,
    ticker,
    price: toNumber(entry.price, NaN),
    change4hPct: entry.change4hPct == null ? null : toNumber(entry.change4hPct, NaN),
    change24hPct: entry.change24hPct == null ? null : toNumber(entry.change24hPct, NaN),
    direction: toText(entry.direction).toUpperCase() || 'FLAT',
    volumeUsd24h: entry.volumeUsd24h == null ? null : toNumber(entry.volumeUsd24h, NaN),
    fundingRate: entry.fundingRate == null ? null : toNumber(entry.fundingRate, NaN),
    openInterest: entry.openInterest == null ? null : toNumber(entry.openInterest, NaN),
    openInterestChange24hPct: entry.openInterestChange24hPct == null ? null : toNumber(entry.openInterestChange24hPct, NaN),
    flagged: entry.flagged === true,
    triggerWindow: toText(entry.triggerWindow, ''),
    score: toNumber(entry.score, 0),
  };
}

function buildMoverMap(entries = []) {
  const map = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const normalized = normalizeMover(entry);
    if (!normalized.coin) continue;
    map.set(normalized.coin, normalized);
  }
  return map;
}

function normalizeMarketScannerState(state = {}) {
  const historyReferenceNowMs = Date.parse(
    state?.updatedAt
    || state?.lastScanAt
    || state?.lastProcessedAt
    || ''
  ) || Date.now();
  const history = state && typeof state.history === 'object' && state.history
    ? Object.fromEntries(
      Object.entries(state.history).map(([coin, entries]) => ([
        normalizeCoin(coin),
        pruneHistory(entries, historyReferenceNowMs),
      ])).filter(([coin]) => Boolean(coin))
    )
    : {};
  const normalizeMovers = (entries) => (Array.isArray(entries) ? entries.map(normalizeMover).filter((entry) => entry.coin) : []);
  return {
    ...defaultMarketScannerState(),
    ...state,
    updatedAt: toIsoTimestamp(state.updatedAt, null),
    lastProcessedAt: toIsoTimestamp(state.lastProcessedAt, null),
    lastScanAt: toIsoTimestamp(state.lastScanAt, null),
    history,
    assets: normalizeMovers(state.assets),
    flaggedMovers: normalizeMovers(state.flaggedMovers),
    topMovers: normalizeMovers(state.topMovers),
  };
}

function buildFallback4hChangeMap(barsBySymbol) {
  const fallback = new Map();
  for (const [ticker, bars] of barsBySymbol.entries()) {
    const coin = normalizeCoin(ticker);
    const normalizedBars = Array.isArray(bars) ? bars.filter(Boolean) : [];
    if (!coin || normalizedBars.length < 2) continue;
    const baseline = toNumber(normalizedBars[0]?.open ?? normalizedBars[0]?.close, NaN);
    const latest = toNumber(
      normalizedBars[normalizedBars.length - 1]?.close ?? normalizedBars[normalizedBars.length - 1]?.open,
      NaN
    );
    if (!Number.isFinite(baseline) || !Number.isFinite(latest) || baseline === 0) continue;
    fallback.set(coin, pctChange(latest, baseline));
  }
  return fallback;
}

function buildAssetSummary(asset = {}, historyEntries = [], options = {}) {
  const nowMs = Number(options.nowMs) || Date.now();
  const move4hThresholdPct = Math.abs(toNumber(options.move4hThresholdPct, DEFAULT_MOVE_4H_THRESHOLD_PCT));
  const move24hThresholdPct = Math.abs(toNumber(options.move24hThresholdPct, DEFAULT_MOVE_24H_THRESHOLD_PCT));
  const coin = normalizeCoin(asset.coin || asset.ticker);
  const ticker = normalizeTicker(asset.ticker || coin);
  const price = toNumber(asset.price, NaN);
  const fourHourPoint = findLookbackPoint(historyEntries, nowMs - FOUR_HOUR_MS);
  const dayPoint = findLookbackPoint(historyEntries, nowMs - TWENTY_FOUR_HOUR_MS, 6 * 60 * 60 * 1000);
  const change4hPct = fourHourPoint ? pctChange(price, fourHourPoint.price) : null;
  const change24hPct = Number.isFinite(toNumber(asset.prevDayPx, NaN))
    ? pctChange(price, asset.prevDayPx)
    : (dayPoint ? pctChange(price, dayPoint.price) : null);
  const openInterestChange24hPct = dayPoint ? pctChange(asset.openInterest, dayPoint.openInterest) : null;
  const magnitude4h = Math.abs(toNumber(change4hPct, 0));
  const magnitude24h = Math.abs(toNumber(change24hPct, 0));
  const direction = magnitude4h >= magnitude24h
    ? (toNumber(change4hPct, 0) > 0 ? 'UP' : (toNumber(change4hPct, 0) < 0 ? 'DOWN' : 'FLAT'))
    : (toNumber(change24hPct, 0) > 0 ? 'UP' : (toNumber(change24hPct, 0) < 0 ? 'DOWN' : 'FLAT'));
  const flagged4h = magnitude4h >= move4hThresholdPct;
  const flagged24h = magnitude24h >= move24hThresholdPct;
  return {
    coin,
    ticker,
    price: round(price, 6),
    change4hPct,
    change24hPct,
    direction,
    volumeUsd24h: round(asset.volumeUsd24h, 2),
    fundingRate: round(asset.fundingRate, 8),
    openInterest: round(asset.openInterest, 4),
    openInterestChange24hPct,
    flagged: flagged4h || flagged24h,
    triggerWindow: flagged4h && flagged24h
      ? '4h_and_24h'
      : (flagged4h ? '4h' : (flagged24h ? '24h' : 'none')),
    score: round(Math.max(magnitude4h, magnitude24h), 4) || 0,
  };
}

function validateMarketScanResult({ state = {}, assetCount = 0 } = {}, options = {}) {
  const previousAssetCount = Math.max(0, toNumber(state?.assetCount, 0));
  const currentAssetCount = Math.max(0, toNumber(assetCount, 0));
  const minUniverseSize = Math.max(
    1,
    Number.parseInt(options.minUniverseSize || `${DEFAULT_MARKET_SCANNER_MIN_UNIVERSE_SIZE}`, 10)
    || DEFAULT_MARKET_SCANNER_MIN_UNIVERSE_SIZE
  );
  const maxDropRatio = Math.min(
    1,
    Math.max(
      0.1,
      Number(options.maxUniverseDropRatio) || DEFAULT_MARKET_SCANNER_MAX_UNIVERSE_DROP_RATIO
    )
  );
  if (previousAssetCount >= minUniverseSize && currentAssetCount < Math.floor(previousAssetCount * maxDropRatio)) {
    return {
      ok: false,
      reason: 'universe_regressed',
      previousAssetCount,
      currentAssetCount,
      minExpectedCount: Math.floor(previousAssetCount * maxDropRatio),
    };
  }
  return {
    ok: true,
    previousAssetCount,
    currentAssetCount,
  };
}

async function runMarketScan(options = {}) {
  const statePath = options.statePath || DEFAULT_MARKET_SCANNER_STATE_PATH;
  const state = readMarketScannerState(statePath);
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const nowIso = now.toISOString();
  const nowMs = now.getTime();
  const marketData = await hyperliquidClient.getUniverseMarketData(options);
  const history = { ...state.history };
  const missingFallbackCoins = [];
  const assets = marketData.map((asset) => {
    const coin = normalizeCoin(asset.coin || asset.ticker);
    const historyEntries = appendHistoryPoint(history[coin], {
      recordedAt: nowIso,
      price: asset.price,
      openInterest: asset.openInterest,
      volumeUsd24h: asset.volumeUsd24h,
      fundingRate: asset.fundingRate,
    }, {
      retentionMs: options.historyRetentionMs,
    });
    history[coin] = historyEntries;
    const summary = buildAssetSummary(asset, historyEntries, {
      nowMs,
      move4hThresholdPct: options.move4hThresholdPct,
      move24hThresholdPct: options.move24hThresholdPct,
    });
    if (summary.change4hPct == null) {
      missingFallbackCoins.push(summary.coin);
    }
    return summary;
  });

  if (missingFallbackCoins.length > 0) {
    const barsBySymbol = await hyperliquidClient.getHistoricalBars({
      ...options,
      symbols: missingFallbackCoins.map((coin) => `${coin}/USD`),
      timeframe: '1Hour',
      limit: 5,
      start: new Date(nowMs - (5 * 60 * 60 * 1000)).toISOString(),
      end: nowIso,
    }).catch(() => new Map());
    const fallback4hByCoin = buildFallback4hChangeMap(barsBySymbol);
    for (const asset of assets) {
      if (asset.change4hPct != null) continue;
      const fallbackChange = fallback4hByCoin.get(asset.coin);
      if (fallbackChange == null) continue;
      asset.change4hPct = fallbackChange;
      const magnitude4h = Math.abs(toNumber(asset.change4hPct, 0));
      const threshold = Math.abs(toNumber(options.move4hThresholdPct, DEFAULT_MOVE_4H_THRESHOLD_PCT));
      if (magnitude4h >= threshold) {
        asset.flagged = true;
        asset.triggerWindow = asset.triggerWindow === '24h' ? '4h_and_24h' : '4h';
      }
      if (magnitude4h >= Math.abs(toNumber(asset.change24hPct, 0))) {
        asset.direction = asset.change4hPct > 0 ? 'UP' : (asset.change4hPct < 0 ? 'DOWN' : asset.direction);
      }
      asset.score = round(Math.max(magnitude4h, Math.abs(toNumber(asset.change24hPct, 0))), 4) || asset.score;
    }
  }

  const rankedAssets = assets
    .slice()
    .sort((left, right) => toNumber(right.score, 0) - toNumber(left.score, 0));
  const flaggedMovers = rankedAssets.filter((asset) => asset.flagged);
  const topMoverLimit = Math.max(1, Math.floor(Number(options.topMoverLimit) || DEFAULT_TOP_MOVER_LIMIT));
  const topMovers = (flaggedMovers.length > 0 ? flaggedMovers : rankedAssets).slice(0, topMoverLimit);
  const previousFlaggedCoins = new Set(
    (Array.isArray(state.flaggedMovers) ? state.flaggedMovers : [])
      .map((entry) => normalizeCoin(entry?.coin || entry?.ticker))
      .filter(Boolean)
  );
  const alerts = flaggedMovers
    .filter((mover) => !previousFlaggedCoins.has(mover.coin))
    .slice(0, topMoverLimit);
  const validation = validateMarketScanResult({
    state,
    assetCount: assets.length,
  }, options);

  if (!validation.ok) {
    return {
      ok: false,
      degraded: true,
      reason: validation.reason,
      assetCount: Number(state.assetCount || 0),
      flaggedMovers: Array.isArray(state.flaggedMovers) ? state.flaggedMovers : [],
      topMovers: Array.isArray(state.topMovers) ? state.topMovers : [],
      alerts: [],
      state,
      validation,
    };
  }

  const nextState = normalizeMarketScannerState({
    ...state,
    updatedAt: nowIso,
    lastScanAt: nowIso,
    assetCount: assets.length,
    assets: rankedAssets,
    flaggedMovers,
    topMovers,
    history,
  });
  writeMarketScannerState(statePath, nextState);
  return {
    ok: true,
    scannedAt: nowIso,
    assetCount: assets.length,
    flaggedMovers,
    topMovers,
    alerts,
    state: nextState,
  };
}

module.exports = {
  DEFAULT_MARKET_SCANNER_STATE_PATH,
  DEFAULT_MOVE_4H_THRESHOLD_PCT,
  DEFAULT_MOVE_24H_THRESHOLD_PCT,
  DEFAULT_TOP_MOVER_LIMIT,
  DEFAULT_MARKET_SCANNER_MIN_UNIVERSE_SIZE,
  DEFAULT_MARKET_SCANNER_MAX_UNIVERSE_DROP_RATIO,
  defaultMarketScannerState,
  normalizeMarketScannerState,
  normalizeMover,
  buildMoverMap,
  validateMarketScanResult,
  readMarketScannerState,
  writeMarketScannerState,
  runMarketScan,
};
