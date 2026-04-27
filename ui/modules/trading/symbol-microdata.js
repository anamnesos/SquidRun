'use strict';

const cryptoMechBoard = require('./crypto-mech-board');
const hyperliquidClient = require('./hyperliquid-client');

const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_BOOK_NOTIONAL_USD = 1_000;
const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

const CACHE = new Map();

function toText(value, fallback = '') {
  const normalized = String(value ?? '').trim();
  return normalized || fallback;
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

function round(value, digits = 6) {
  if (value == null) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Number(numeric.toFixed(digits));
}

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, toNumber(value, min)));
}

function normalizeTicker(symbol) {
  const normalized = toText(symbol).toUpperCase();
  if (!normalized) return '';
  return normalized.endsWith('/USD') ? normalized : `${normalized}/USD`;
}

function normalizeCoin(symbol) {
  const normalized = normalizeTicker(symbol);
  return normalized.endsWith('/USD') ? normalized.slice(0, -4) : normalized;
}

function cacheKey(kind, symbol, parts = []) {
  return [kind, normalizeTicker(symbol), ...parts.map((part) => String(part))].join('|');
}

function getCached(key, options = {}) {
  const ttlMs = Math.max(0, toNumber(options.cacheTtlMs, DEFAULT_CACHE_TTL_MS));
  if (ttlMs <= 0) return null;
  const entry = CACHE.get(key);
  const nowMs = toNumber(options.nowMs, Date.now());
  if (!entry || (nowMs - entry.storedAtMs) > ttlMs) {
    CACHE.delete(key);
    return null;
  }
  return JSON.parse(JSON.stringify(entry.value));
}

function setCached(key, value, options = {}) {
  const ttlMs = Math.max(0, toNumber(options.cacheTtlMs, DEFAULT_CACHE_TTL_MS));
  if (ttlMs <= 0) return value;
  CACHE.set(key, {
    storedAtMs: toNumber(options.nowMs, Date.now()),
    value: JSON.parse(JSON.stringify(value)),
  });
  return value;
}

function clearMicrodataCache() {
  CACHE.clear();
}

async function resolveCoin(symbol, options = {}) {
  const fallback = normalizeCoin(symbol);
  if (options.coin) return toText(options.coin, fallback);
  return hyperliquidClient.resolveCanonicalCoinSymbol(symbol, options).catch(() => fallback);
}

async function getInfoClient(options = {}) {
  if (options.infoClient) return options.infoClient;
  return hyperliquidClient.createInfoClient(options);
}

async function readCandleSnapshot(coin, startTime, endTime, options = {}) {
  const client = await getInfoClient(options);
  if (client && typeof client.candleSnapshot === 'function') {
    return client.candleSnapshot({
      coin,
      interval: '4h',
      startTime,
      endTime,
    });
  }
  return hyperliquidClient.postInfoRequest({
    type: 'candleSnapshot',
    req: {
      coin,
      interval: '4h',
      startTime,
      endTime,
    },
  }, options);
}

function normalizeCandle(symbol, candle = {}) {
  const open = toNumber(candle.o ?? candle.open, NaN);
  const high = toNumber(candle.h ?? candle.high, NaN);
  const low = toNumber(candle.l ?? candle.low, NaN);
  const close = toNumber(candle.c ?? candle.close, NaN);
  const volume = toNumber(candle.v ?? candle.volume, 0);
  const timestampMs = toNumber(candle.t ?? candle.time ?? candle.timestamp, NaN);
  const endTimestampMs = toNumber(candle.T ?? candle.closeTime ?? candle.endTime, NaN);
  return {
    symbol: normalizeTicker(symbol),
    timestamp: Number.isFinite(timestampMs) ? new Date(timestampMs).toISOString() : null,
    endTimestamp: Number.isFinite(endTimestampMs) ? new Date(endTimestampMs).toISOString() : null,
    open: Number.isFinite(open) ? open : null,
    high: Number.isFinite(high) ? high : null,
    low: Number.isFinite(low) ? low : null,
    close: Number.isFinite(close) ? close : null,
    volume,
    tradeCount: Number.isFinite(Number(candle.n)) ? Number(candle.n) : null,
    changePct: Number.isFinite(open) && open !== 0 && Number.isFinite(close)
      ? round((close - open) / open, 6)
      : null,
    rangePct: Number.isFinite(low) && low !== 0 && Number.isFinite(high)
      ? round((high - low) / low, 6)
      : null,
  };
}

async function get4hCandles(symbol, hoursBack = 72, options = {}) {
  const ticker = normalizeTicker(symbol);
  const lookbackHours = Math.max(4, toNumber(hoursBack, 72));
  const key = cacheKey('candles4h', ticker, [lookbackHours]);
  const cached = getCached(key, options);
  if (cached) return cached;

  const endTime = toNumber(options.endTimeMs, Date.now());
  const startTime = Math.max(0, endTime - (lookbackHours * 60 * 60 * 1000));
  const limit = Math.ceil(lookbackHours / 4) + 2;
  const coin = await resolveCoin(ticker, options);
  const candles = await readCandleSnapshot(coin, startTime, endTime, options);
  const normalized = (Array.isArray(candles) ? candles : [])
    .map((candle) => normalizeCandle(ticker, candle))
    .filter((candle) => candle.timestamp && candle.close != null)
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp))
    .slice(-limit);

  return setCached(key, {
    ok: true,
    source: 'hyperliquid_info.candleSnapshot',
    ticker,
    coin,
    interval: '4h',
    hoursBack: lookbackHours,
    startTime: new Date(startTime).toISOString(),
    endTime: new Date(endTime).toISOString(),
    candleCount: normalized.length,
    candles: normalized,
  }, options);
}

async function readFundingHistory(coin, startTime, endTime, options = {}) {
  const client = await getInfoClient(options);
  if (client && typeof client.fundingHistory === 'function') {
    return client.fundingHistory({ coin, startTime, endTime });
  }
  return hyperliquidClient.postInfoRequest({
    type: 'fundingHistory',
    coin,
    startTime,
    endTime,
  }, options);
}

function normalizeFundingEntry(entry = {}, firstFundingRate = null, previousFundingRate = null) {
  const fundingRate = toNumber(entry.fundingRate, NaN);
  const premium = toNumber(entry.premium, NaN);
  const time = toNumber(entry.time ?? entry.timestamp, NaN);
  return {
    timestamp: Number.isFinite(time) ? new Date(time).toISOString() : null,
    fundingRate: Number.isFinite(fundingRate) ? fundingRate : null,
    fundingRateBps: Number.isFinite(fundingRate) ? round(fundingRate * 10_000, 4) : null,
    premium: Number.isFinite(premium) ? premium : null,
    deltaFromFirst: Number.isFinite(fundingRate) && Number.isFinite(firstFundingRate)
      ? round(fundingRate - firstFundingRate, 8)
      : null,
    deltaFromPrevious: Number.isFinite(fundingRate) && Number.isFinite(previousFundingRate)
      ? round(fundingRate - previousFundingRate, 8)
      : null,
  };
}

async function getFundingHistory(symbol, hoursBack = 24, options = {}) {
  const ticker = normalizeTicker(symbol);
  const lookbackHours = Math.max(1, toNumber(hoursBack, 24));
  const key = cacheKey('fundingHistory', ticker, [lookbackHours]);
  const cached = getCached(key, options);
  if (cached) return cached;

  const endTime = toNumber(options.endTimeMs, Date.now());
  const startTime = Math.max(0, endTime - (lookbackHours * 60 * 60 * 1000));
  const coin = await resolveCoin(ticker, options);
  const history = await readFundingHistory(coin, startTime, endTime, options);
  const sorted = (Array.isArray(history) ? history : [])
    .slice()
    .sort((left, right) => toNumber(left?.time ?? left?.timestamp, 0) - toNumber(right?.time ?? right?.timestamp, 0));
  const firstFundingRate = sorted.length > 0 ? toNumber(sorted[0]?.fundingRate, NaN) : NaN;
  let previousFundingRate = NaN;
  const entries = sorted.map((entry) => {
    const normalized = normalizeFundingEntry(entry, firstFundingRate, previousFundingRate);
    previousFundingRate = toNumber(entry?.fundingRate, NaN);
    return normalized;
  }).filter((entry) => entry.timestamp);
  const rates = entries.map((entry) => entry.fundingRate).filter((value) => Number.isFinite(value));
  const latest = entries[entries.length - 1] || null;

  return setCached(key, {
    ok: true,
    source: 'hyperliquid_info.fundingHistory',
    ticker,
    coin,
    hoursBack: lookbackHours,
    startTime: new Date(startTime).toISOString(),
    endTime: new Date(endTime).toISOString(),
    sampleCount: entries.length,
    latest,
    averageFundingRate: rates.length ? round(rates.reduce((sum, value) => sum + value, 0) / rates.length, 8) : null,
    minFundingRate: rates.length ? round(Math.min(...rates), 8) : null,
    maxFundingRate: rates.length ? round(Math.max(...rates), 8) : null,
    entries,
  }, options);
}

function buildCtxByCoin(metaAndAssetCtxs = []) {
  const [meta, assetCtxs] = Array.isArray(metaAndAssetCtxs) ? metaAndAssetCtxs : [null, []];
  const universe = Array.isArray(meta?.universe) ? meta.universe : [];
  const contexts = Array.isArray(assetCtxs) ? assetCtxs : [];
  const byCoin = new Map();
  universe.forEach((asset, index) => {
    const coin = normalizeCoin(asset?.name || asset?.coin || asset);
    if (coin) byCoin.set(coin, contexts[index] || null);
  });
  return byCoin;
}

async function getCurrentAssetContext(coin, options = {}) {
  const metaAndAssetCtxs = options.metaAndAssetCtxs || await hyperliquidClient.getMetaAndAssetCtxs(options).catch(() => null);
  const byCoin = buildCtxByCoin(metaAndAssetCtxs);
  return byCoin.get(normalizeCoin(coin)) || null;
}

function normalizeOiPoint(point = {}, firstOpenInterest = null, previousOpenInterest = null) {
  const openInterest = toNumber(point.openInterest ?? point.oi, NaN);
  const markPx = toNumber(point.markPx ?? point.markPrice, NaN);
  const timestamp = toIsoTimestamp(point.recordedAt ?? point.timestamp ?? point.time, null);
  return {
    timestamp,
    openInterest: Number.isFinite(openInterest) ? openInterest : null,
    markPx: Number.isFinite(markPx) ? markPx : null,
    openInterestUsd: Number.isFinite(openInterest) && Number.isFinite(markPx) ? round(openInterest * markPx, 2) : null,
    fundingRate: Number.isFinite(Number(point.fundingRate)) ? Number(point.fundingRate) : null,
    changePctFromFirst: Number.isFinite(openInterest) && Number.isFinite(firstOpenInterest) && firstOpenInterest !== 0
      ? round((openInterest - firstOpenInterest) / firstOpenInterest, 6)
      : null,
    changePctFromPrevious: Number.isFinite(openInterest) && Number.isFinite(previousOpenInterest) && previousOpenInterest !== 0
      ? round((openInterest - previousOpenInterest) / previousOpenInterest, 6)
      : null,
  };
}

async function getOpenInterestHistory(symbol, hoursBack = 72, options = {}) {
  const ticker = normalizeTicker(symbol);
  const lookbackHours = Math.max(1, toNumber(hoursBack, 72));
  const key = cacheKey('openInterestHistory', ticker, [lookbackHours, options.cryptoMechBoardStatePath || 'default']);
  const cached = getCached(key, options);
  if (cached) return cached;

  const endTime = toNumber(options.endTimeMs, Date.now());
  const startTime = Math.max(0, endTime - (lookbackHours * 60 * 60 * 1000));
  const coin = await resolveCoin(ticker, options);
  const statePath = options.cryptoMechBoardStatePath || cryptoMechBoard.DEFAULT_CRYPTO_MECH_BOARD_STATE_PATH;
  const state = cryptoMechBoard.readBoardState(statePath);
  const retained = Array.isArray(state.history?.[normalizeCoin(coin)]) ? state.history[normalizeCoin(coin)] : [];
  const currentCtx = await getCurrentAssetContext(coin, options);
  const currentOpenInterest = toNumber(currentCtx?.openInterest ?? currentCtx?.openInterestSz, NaN);
  const currentMarkPx = toNumber(currentCtx?.markPx ?? currentCtx?.midPx, NaN);
  const currentFundingRate = toNumber(currentCtx?.funding, NaN);
  const entries = retained
    .filter((entry) => {
      const recordedAtMs = Date.parse(entry.recordedAt || '');
      return Number.isFinite(recordedAtMs) && recordedAtMs >= startTime && recordedAtMs <= endTime;
    })
    .map((entry) => ({ ...entry }));
  if (Number.isFinite(currentOpenInterest) && currentOpenInterest > 0) {
    entries.push({
      recordedAt: new Date(endTime).toISOString(),
      openInterest: currentOpenInterest,
      markPx: Number.isFinite(currentMarkPx) ? currentMarkPx : 0,
      fundingRate: Number.isFinite(currentFundingRate) ? currentFundingRate : 0,
    });
  }
  entries.sort((left, right) => Date.parse(left.recordedAt || 0) - Date.parse(right.recordedAt || 0));
  const firstOpenInterest = entries.length > 0 ? toNumber(entries[0]?.openInterest, NaN) : NaN;
  let previousOpenInterest = NaN;
  const normalized = entries.map((entry) => {
    const point = normalizeOiPoint(entry, firstOpenInterest, previousOpenInterest);
    previousOpenInterest = toNumber(entry.openInterest, NaN);
    return point;
  }).filter((point) => point.timestamp);

  return setCached(key, {
    ok: true,
    source: 'crypto_mech_board_local_history_plus_hyperliquid_current',
    ticker,
    coin,
    hoursBack: lookbackHours,
    startTime: new Date(startTime).toISOString(),
    endTime: new Date(endTime).toISOString(),
    sampleCount: normalized.length,
    latest: normalized[normalized.length - 1] || null,
    entries: normalized,
  }, options);
}

function sumUsd(levels = [], limit = 5) {
  return round(levels.slice(0, limit).reduce((sum, level) => sum + toNumber(level.usd, 0), 0), 2);
}

function estimateImpact(levels = [], mid, notionalUsd, side) {
  const target = Math.max(0, toNumber(notionalUsd, DEFAULT_BOOK_NOTIONAL_USD));
  const midPx = toNumber(mid, NaN);
  if (!Number.isFinite(midPx) || midPx <= 0 || target <= 0) return null;
  let remaining = target;
  let filledQty = 0;
  let spentUsd = 0;
  for (const level of levels) {
    const px = toNumber(level.px, 0);
    const sz = toNumber(level.sz, 0);
    if (px <= 0 || sz <= 0) continue;
    const levelUsd = px * sz;
    const takeUsd = Math.min(remaining, levelUsd);
    filledQty += takeUsd / px;
    spentUsd += takeUsd;
    remaining -= takeUsd;
    if (remaining <= 0.000001) break;
  }
  if (filledQty <= 0 || spentUsd <= 0) {
    return {
      fillable: false,
      notionalUsd: target,
      filledUsd: round(spentUsd, 2),
      averagePx: null,
      impactBps: null,
    };
  }
  const averagePx = spentUsd / filledQty;
  const signedImpact = side === 'sell'
    ? ((midPx - averagePx) / midPx) * 10_000
    : ((averagePx - midPx) / midPx) * 10_000;
  return {
    fillable: remaining <= 0.000001,
    notionalUsd: target,
    filledUsd: round(spentUsd, 2),
    averagePx: round(averagePx, 8),
    impactBps: round(Math.max(0, signedImpact), 4),
  };
}

async function getBookSnapshot(symbol, options = {}) {
  const ticker = normalizeTicker(symbol);
  const notionalUsd = Math.max(1, toNumber(options.notionalUsd, DEFAULT_BOOK_NOTIONAL_USD));
  const key = cacheKey('bookSnapshot', ticker, [notionalUsd]);
  const cached = getCached(key, options);
  if (cached) return cached;

  const coin = await resolveCoin(ticker, options);
  const book = await hyperliquidClient.getL2Book({
    ...options,
    ticker,
    coin,
  });
  const top5BidUsd = sumUsd(book.bids, 5);
  const top5AskUsd = sumUsd(book.asks, 5);
  const depthTotal = toNumber(top5BidUsd, 0) + toNumber(top5AskUsd, 0);
  const spreadBps = book.spreadPct != null ? round(book.spreadPct * 10_000, 4) : null;

  return setCached(key, {
    ok: true,
    source: 'hyperliquid_info.l2Book',
    ticker,
    coin,
    asOf: book.asOf || new Date().toISOString(),
    notionalUsd,
    bestBid: book.bestBid,
    bestAsk: book.bestAsk,
    mid: book.mid,
    spread: book.spread,
    spreadBps,
    top5BidUsd,
    top5AskUsd,
    depthImbalanceTop5: depthTotal > 0 ? round((top5BidUsd - top5AskUsd) / depthTotal, 4) : null,
    buyImpact: estimateImpact(book.asks, book.mid, notionalUsd, 'buy'),
    sellImpact: estimateImpact(book.bids, book.mid, notionalUsd, 'sell'),
    bidLevels: Array.isArray(book.bids) ? book.bids.slice(0, 10) : [],
    askLevels: Array.isArray(book.asks) ? book.asks.slice(0, 10) : [],
  }, options);
}

function mean(values = []) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stddev(values = [], average = mean(values)) {
  if (!values.length || !Number.isFinite(average)) return null;
  const variance = values.reduce((sum, value) => sum + ((value - average) ** 2), 0) / values.length;
  return Math.sqrt(variance);
}

async function getExtensionRead(symbol, options = {}) {
  const ticker = normalizeTicker(symbol);
  const hoursBack = Math.max(24, toNumber(options.extensionHoursBack, 7 * 24));
  const maPeriods = Math.max(3, Math.floor(toNumber(options.extensionMaPeriods, 20)));
  const zThreshold = Math.max(0.5, toNumber(options.extensionZThreshold, 2));
  const maPctThreshold = Math.max(0.01, toNumber(options.extensionMaPctThreshold, 0.12));
  const key = cacheKey('extensionRead', ticker, [hoursBack, maPeriods, zThreshold, maPctThreshold]);
  const cached = getCached(key, options);
  if (cached) return cached;

  const candleRead = await get4hCandles(ticker, hoursBack, options);
  const closes = (candleRead.candles || [])
    .map((candle) => toNumber(candle.close, NaN))
    .filter((value) => Number.isFinite(value) && value > 0);
  const currentPrice = closes[closes.length - 1] || null;
  const average = mean(closes);
  const deviation = stddev(closes, average);
  const maWindow = closes.slice(-maPeriods);
  const ma = mean(maWindow);
  const zScore = currentPrice != null && Number.isFinite(average) && Number.isFinite(deviation) && deviation > 0
    ? (currentPrice - average) / deviation
    : null;
  const pctAboveMean = currentPrice != null && Number.isFinite(average) && average > 0
    ? (currentPrice - average) / average
    : null;
  const pctAboveMa = currentPrice != null && Number.isFinite(ma) && ma > 0
    ? (currentPrice - ma) / ma
    : null;
  const extendedByZ = Number.isFinite(zScore) && zScore >= zThreshold;
  const extendedByMa = Number.isFinite(pctAboveMa) && pctAboveMa >= maPctThreshold;
  const score = clamp(Math.max(
    Number.isFinite(zScore) ? zScore / Math.max(0.1, zThreshold + 1) : 0,
    Number.isFinite(pctAboveMa) ? pctAboveMa / Math.max(0.01, maPctThreshold * 1.5) : 0
  ));

  return setCached(key, {
    ok: true,
    source: 'hyperliquid_info.candleSnapshot.extension',
    ticker,
    coin: candleRead.coin,
    extended: Boolean(extendedByZ || extendedByMa),
    score: round(score, 4),
    zScore: round(zScore, 4),
    pctAboveMean: round(pctAboveMean, 6),
    pctAboveMa20: round(pctAboveMa, 6),
    currentPrice,
    meanClose: round(average, 8),
    stdClose: round(deviation, 8),
    ma20: round(ma, 8),
    lookbackCandles: closes.length,
    reason: extendedByZ
      ? `price ${round(zScore, 2)} std dev above 7-day mean`
      : extendedByMa
        ? `price ${round(pctAboveMa * 100, 2)}% above 20-candle MA`
        : 'not parabolic-extended versus 4h lookback',
  }, options);
}

async function settleField(name, promise) {
  try {
    return [name, await promise];
  } catch (error) {
    return [name, {
      ok: false,
      error: error?.message || String(error),
    }];
  }
}

async function getMicroDataForSymbol(symbol, options = {}) {
  const ticker = normalizeTicker(symbol);
  const [
    [, candles4h],
    [, openInterestHistory],
    [, fundingHistory],
    [, bookSnapshot],
    [, extensionRead],
  ] = await Promise.all([
    settleField('candles4h', get4hCandles(ticker, options.candleHoursBack || 72, options)),
    settleField('openInterestHistory', getOpenInterestHistory(ticker, options.oiHoursBack || 72, options)),
    settleField('fundingHistory', getFundingHistory(ticker, options.fundingHoursBack || 24, options)),
    settleField('bookSnapshot', getBookSnapshot(ticker, options)),
    settleField('extensionRead', getExtensionRead(ticker, options)),
  ]);
  return {
    ticker,
    ok: [candles4h, openInterestHistory, fundingHistory, bookSnapshot, extensionRead].every((entry) => entry?.ok !== false),
    candles4h,
    openInterestHistory,
    fundingHistory,
    bookSnapshot,
    extensionRead,
  };
}

async function getMicroDataForSymbols(symbols = [], options = {}) {
  const uniqueSymbols = Array.from(new Set((Array.isArray(symbols) ? symbols : [symbols]).map(normalizeTicker).filter(Boolean)));
  const entries = await Promise.all(uniqueSymbols.map(async (symbol) => [symbol, await getMicroDataForSymbol(symbol, options)]));
  return {
    ok: entries.every(([, value]) => value?.ok !== false),
    asOf: new Date(toNumber(options.nowMs, Date.now())).toISOString(),
    cacheTtlMs: Math.max(0, toNumber(options.cacheTtlMs, DEFAULT_CACHE_TTL_MS)),
    symbols: Object.fromEntries(entries),
  };
}

module.exports = {
  DEFAULT_BOOK_NOTIONAL_USD,
  DEFAULT_CACHE_TTL_MS,
  FOUR_HOURS_MS,
  clearMicrodataCache,
  get4hCandles,
  getOpenInterestHistory,
  getFundingHistory,
  getBookSnapshot,
  getExtensionRead,
  getMicroDataForSymbol,
  getMicroDataForSymbols,
};
