'use strict';

const fs = require('fs');
const path = require('path');

const { resolveCoordPath } = require('../../config');

const DEFAULT_DYNAMIC_WATCHLIST_STATE_PATH = resolveCoordPath(path.join('runtime', 'dynamic-watchlist-state.json'), { forWrite: true });

function toText(value, fallback = '') {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function toTicker(value) {
  return toText(value).toUpperCase();
}

function toIsoTimestamp(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return date.toISOString();
}

function normalizeBroker(value, fallback = 'ibkr') {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized || fallback;
}

function normalizeSource(value, fallback = 'manual') {
  const normalized = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return normalized || fallback;
}

function normalizeWatchlistSource(value, fallback = 'manual') {
  const normalized = normalizeSource(value, fallback);
  if (normalized === 'market_scanner') return 'market_scanner';
  return normalized;
}

function normalizeCryptoTicker(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (!normalized) return '';
  return normalized.endsWith('/USD') ? normalized : `${normalized}/USD`;
}

function normalizeAssetClass(value, fallback = 'us_equity') {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return fallback;
  if (['crypto', 'solana_token', 'us_equity'].includes(normalized)) {
    return normalized;
  }
  return fallback;
}

function normalizeExchange(value, fallback = 'SMART') {
  const normalized = String(value || '').trim().toUpperCase();
  return normalized || fallback;
}

function defaultExchangeForAssetClass(assetClass = 'us_equity') {
  if (assetClass === 'crypto') return 'CRYPTO';
  if (assetClass === 'solana_token') return 'SOLANA';
  return 'SMART';
}

function defaultBrokerForAssetClass(assetClass = 'us_equity') {
  if (assetClass === 'crypto') return 'hyperliquid';
  return 'ibkr';
}

function normalizeWatchlistEntry(entryOrTicker, options = {}) {
  const baseInput = typeof entryOrTicker === 'object' && entryOrTicker != null
    ? entryOrTicker
    : { ticker: entryOrTicker };
  const input = {
    ...options,
    ...baseInput,
  };
  const ticker = toTicker(input.ticker);
  if (!ticker) {
    throw new Error('ticker is required');
  }

  const assetClass = normalizeAssetClass(input.assetClass || input.asset_class, options.assetClass || 'us_equity');
  const fallbackSource = options.source || 'manual';

  return {
    ticker,
    name: toText(input.name, ticker),
    sector: toText(input.sector, 'Unspecified'),
    exchange: normalizeExchange(input.exchange, defaultExchangeForAssetClass(assetClass)),
    broker: normalizeBroker(input.broker, defaultBrokerForAssetClass(assetClass)),
    assetClass,
    source: normalizeWatchlistSource(input.source, fallbackSource),
    reason: toText(input.reason),
    addedAt: toIsoTimestamp(input.addedAt, null),
    expiry: toIsoTimestamp(input.expiry || input.expiresAt, null),
  };
}

function cloneEntry(entry = {}) {
  return { ...entry };
}

const DEFAULT_WATCHLIST = [
  { ticker: 'SPY',   name: 'SPDR S&P 500 ETF Trust', sector: 'Index ETF' },
  { ticker: 'QQQ',   name: 'Invesco QQQ Trust', sector: 'Index ETF/Tech' },
  { ticker: 'AAPL',  name: 'Apple',           sector: 'Tech/Consumer' },
  { ticker: 'MSFT',  name: 'Microsoft',       sector: 'Tech/Cloud' },
  { ticker: 'NVDA',  name: 'NVIDIA',          sector: 'Semiconductors/AI' },
  { ticker: 'TSLA',  name: 'Tesla',           sector: 'Auto/Tech' },
  { ticker: 'AMZN',  name: 'Amazon',          sector: 'E-commerce/Cloud' },
  { ticker: 'META',  name: 'Meta Platforms',  sector: 'Communication' },
  { ticker: 'GOOGL', name: 'Alphabet',        sector: 'Search/AI' },
  { ticker: 'AMD',   name: 'AMD',             sector: 'Semiconductors' },
  { ticker: 'AVGO',  name: 'Broadcom',        sector: 'Semiconductors/Net' },
  { ticker: 'JPM',   name: 'JPMorgan Chase',  sector: 'Financials' },
  { ticker: 'SQQQ',  name: 'ProShares UltraPro Short QQQ', sector: 'Crisis/Inverse ETF' },
  { ticker: 'BITI',  name: 'ProShares Short Bitcoin ETF', sector: 'Crisis/Crypto Hedge' },
  { ticker: 'PSQ',   name: 'ProShares Short QQQ', sector: 'Crisis/Inverse ETF' },
  { ticker: 'SH',    name: 'ProShares Short S&P500', sector: 'Crisis/Inverse ETF' },
  { ticker: 'UVXY',  name: 'ProShares Ultra VIX Short-Term Futures ETF', sector: 'Crisis/Volatility' },
  { ticker: 'XLE',   name: 'Energy Select Sector SPDR Fund', sector: 'Crisis/Energy' },
  { ticker: 'ITA',   name: 'iShares U.S. Aerospace & Defense ETF', sector: 'Crisis/Defense' },
  { ticker: 'GLD',   name: 'SPDR Gold Shares', sector: 'Macro/Gold Hedge' },
  { ticker: 'TLT',   name: 'iShares 20+ Year Treasury Bond ETF', sector: 'Macro/Bond Hedge' },
  { ticker: 'UUP',   name: 'Invesco DB US Dollar Index Bullish Fund', sector: 'Crisis/USD Hedge' },
].map((entry) => {
  const normalized = normalizeWatchlistEntry(entry, { source: 'static', assetClass: 'us_equity' });
  normalized.addedAt = null;
  return normalized;
});

const DEFAULT_CRYPTO_WATCHLIST = [
  { ticker: 'BTC/USD',  name: 'Bitcoin',   sector: 'Crypto', exchange: 'CRYPTO', broker: 'hyperliquid', assetClass: 'crypto' },
  { ticker: 'ETH/USD',  name: 'Ethereum',  sector: 'Crypto', exchange: 'CRYPTO', broker: 'hyperliquid', assetClass: 'crypto' },
  { ticker: 'SOL/USD',  name: 'Solana',    sector: 'Crypto', exchange: 'CRYPTO', broker: 'hyperliquid', assetClass: 'crypto' },
].map((entry) => {
  const normalized = normalizeWatchlistEntry(entry, { source: 'static', assetClass: 'crypto' });
  normalized.addedAt = null;
  return normalized;
});

function createDefaultEntries() {
  return [...DEFAULT_WATCHLIST, ...DEFAULT_CRYPTO_WATCHLIST].map(cloneEntry);
}

function defaultDynamicState() {
  return {
    dynamicEntries: [],
    disabledTickers: [],
    updatedAt: null,
  };
}

function resolveExpiryFromTtl(now = new Date(), ttlMs = 4 * 60 * 60 * 1000) {
  const base = now instanceof Date ? now : new Date(now);
  const normalizedTtlMs = Math.max(60 * 1000, Number(ttlMs) || 0);
  if (Number.isNaN(base.getTime())) {
    return toIsoTimestamp(Date.now() + normalizedTtlMs, null);
  }
  return new Date(base.getTime() + normalizedTtlMs).toISOString();
}

function normalizeMarketScannerMover(mover = {}) {
  const ticker = normalizeCryptoTicker(mover.ticker || mover.symbol || mover.coin);
  if (!ticker) {
    throw new Error('ticker is required');
  }
  return {
    ticker,
    name: toText(mover.name, ticker),
    sector: toText(mover.sector, 'Crypto'),
    exchange: normalizeExchange(mover.exchange, defaultExchangeForAssetClass('crypto')),
    broker: normalizeBroker(mover.broker, defaultBrokerForAssetClass('crypto')),
    assetClass: normalizeAssetClass(mover.assetClass || mover.asset_class, 'crypto'),
    source: 'market_scanner',
    reason: toText(mover.reason, 'Market scanner mover'),
    addedAt: toIsoTimestamp(mover.addedAt, null),
    expiry: toIsoTimestamp(mover.expiry || mover.expiresAt, null),
  };
}

function normalizeDynamicState(state = {}) {
  const dynamicEntries = Array.isArray(state.dynamicEntries)
    ? state.dynamicEntries.map((entry) => normalizeWatchlistEntry(entry, { source: entry?.source || 'manual' }))
    : [];
  const disabledTickers = Array.isArray(state.disabledTickers)
    ? Array.from(new Set(state.disabledTickers.map((ticker) => toTicker(ticker)).filter(Boolean)))
    : [];

  return {
    ...defaultDynamicState(),
    ...state,
    dynamicEntries,
    disabledTickers,
    updatedAt: toIsoTimestamp(state.updatedAt, null),
  };
}

function readDynamicState(statePath = DEFAULT_DYNAMIC_WATCHLIST_STATE_PATH) {
  try {
    return normalizeDynamicState(JSON.parse(fs.readFileSync(statePath, 'utf8')));
  } catch {
    return defaultDynamicState();
  }
}

function writeDynamicState(statePath = DEFAULT_DYNAMIC_WATCHLIST_STATE_PATH, state = {}) {
  const normalized = normalizeDynamicState(state);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({
    ...normalized,
    updatedAt: new Date().toISOString(),
  }, null, 2));
}

function isExpired(entry = {}, now = new Date()) {
  if (!entry?.expiry) return false;
  const expiresAt = new Date(entry.expiry);
  const compareAt = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(expiresAt.getTime()) || Number.isNaN(compareAt.getTime())) return false;
  return expiresAt.getTime() <= compareAt.getTime();
}

function matchesAssetClass(entry, assetClass) {
  if (!assetClass || assetClass === 'all') return true;
  return normalizeAssetClass(entry?.assetClass) === normalizeAssetClass(assetClass);
}

function matchesSource(entry, source) {
  if (!source || source === 'all') return true;
  return normalizeSource(entry?.source, 'manual') === normalizeSource(source);
}

function persistStateIfNeeded(statePath, state, persist) {
  if (persist === false) return;
  writeDynamicState(statePath, state);
}

function resolveState(options = {}) {
  const statePath = options.statePath || DEFAULT_DYNAMIC_WATCHLIST_STATE_PATH;
  const now = options.now || new Date();
  const originalState = options.state
    ? normalizeDynamicState(options.state)
    : readDynamicState(statePath);
  const activeDynamicEntries = [];
  const removedTickers = [];

  for (const entry of originalState.dynamicEntries) {
    if (isExpired(entry, now)) {
      removedTickers.push(entry.ticker);
      continue;
    }
    activeDynamicEntries.push(entry);
  }

  const nextState = {
    ...originalState,
    dynamicEntries: activeDynamicEntries,
  };

  if (removedTickers.length > 0) {
    persistStateIfNeeded(statePath, nextState, options.persist);
  }

  return {
    statePath,
    state: nextState,
    removedTickers,
  };
}

function buildActiveEntries(options = {}) {
  const { state } = resolveState(options);
  const active = new Map();

  for (const entry of createDefaultEntries()) {
    if (state.disabledTickers.includes(entry.ticker)) continue;
    active.set(entry.ticker, entry);
  }

  for (const entry of state.dynamicEntries) {
    const merged = active.has(entry.ticker)
      ? { ...active.get(entry.ticker), ...entry }
      : entry;
    active.set(entry.ticker, merged);
  }

  const entries = Array.from(active.values());
  return entries
    .filter((entry) => matchesAssetClass(entry, options.assetClass || options.asset_class || 'all'))
    .filter((entry) => matchesSource(entry, options.source))
    .map(cloneEntry);
}

function getActiveEntries(options = {}) {
  return buildActiveEntries(options);
}

function getActiveTickers(options = {}) {
  return getActiveEntries(options).map((entry) => entry.ticker);
}

function getEntry(ticker, options = {}) {
  const normalizedTicker = toTicker(ticker);
  if (!normalizedTicker) return null;
  return getActiveEntries({ ...options, assetClass: 'all' }).find((entry) => entry.ticker === normalizedTicker) || null;
}

function isWatched(ticker, options = {}) {
  return Boolean(getEntry(ticker, options));
}

function addTicker(ticker, details = {}) {
  const statePath = details.statePath || DEFAULT_DYNAMIC_WATCHLIST_STATE_PATH;
  const nowIso = toIsoTimestamp(details.now, new Date().toISOString());
  const { state } = resolveState(details);
  const entry = normalizeWatchlistEntry(ticker, {
    ...details,
    source: details.source || 'manual',
    addedAt: details.addedAt || nowIso,
  });
  const dynamicEntries = state.dynamicEntries.filter((item) => item.ticker !== entry.ticker);
  dynamicEntries.push(entry);
  const disabledTickers = state.disabledTickers.filter((value) => value !== entry.ticker);
  const nextState = {
    ...state,
    dynamicEntries,
    disabledTickers,
  };
  persistStateIfNeeded(statePath, nextState, details.persist);
  return true;
}

function promoteMarketScannerMovers(movers = [], options = {}) {
  const statePath = options.statePath || DEFAULT_DYNAMIC_WATCHLIST_STATE_PATH;
  const now = options.now || new Date();
  const ttlMs = options.ttlMs || options.expiryMs || (4 * 60 * 60 * 1000);
  const { state } = resolveState({ ...options, statePath });
  const entries = Array.isArray(movers) ? movers : [movers];
  const promotedTickers = [];
  const dynamicEntries = state.dynamicEntries.filter((entry) => {
    const ticker = toTicker(entry?.ticker);
    return !entries.some((mover) => toTicker(mover?.ticker || mover?.symbol || mover?.coin) === ticker);
  });

  for (const mover of entries) {
    const normalizedMover = normalizeMarketScannerMover(mover);
    const promotedEntry = normalizeWatchlistEntry({
      ...normalizedMover,
      addedAt: options.addedAt || now,
      expiry: options.expiry || options.expiresAt || resolveExpiryFromTtl(now, ttlMs),
    }, {
      source: 'market_scanner',
    });
    dynamicEntries.push(promotedEntry);
    promotedTickers.push(promotedEntry.ticker);
  }

  const nextState = {
    ...state,
    dynamicEntries,
  };
  persistStateIfNeeded(statePath, nextState, options.persist);

  return {
    ok: true,
    promotedTickers,
    state: nextState,
  };
}

function removeTicker(ticker, options = {}) {
  const normalizedTicker = toTicker(ticker);
  if (!normalizedTicker) return false;
  const statePath = options.statePath || DEFAULT_DYNAMIC_WATCHLIST_STATE_PATH;
  const { state } = resolveState(options);
  const dynamicEntries = state.dynamicEntries.filter((entry) => entry.ticker !== normalizedTicker);
  const staticExists = createDefaultEntries().some((entry) => entry.ticker === normalizedTicker);
  const disabledTickers = staticExists
    ? Array.from(new Set([...state.disabledTickers, normalizedTicker]))
    : state.disabledTickers.filter((value) => value !== normalizedTicker);
  const changed = dynamicEntries.length !== state.dynamicEntries.length
    || disabledTickers.length !== state.disabledTickers.length;

  if (!changed) return false;

  persistStateIfNeeded(statePath, {
    ...state,
    dynamicEntries,
    disabledTickers,
  }, options.persist);
  return true;
}

function resetWatchlist(options = {}) {
  const statePath = options.statePath || DEFAULT_DYNAMIC_WATCHLIST_STATE_PATH;
  const emptyState = defaultDynamicState();
  if (options.persist === false) {
    return emptyState;
  }
  writeDynamicState(statePath, emptyState);
  return emptyState;
}

function pruneExpiredTickers(options = {}) {
  const { removedTickers } = resolveState(options);
  return removedTickers;
}

module.exports = {
  DEFAULT_DYNAMIC_WATCHLIST_STATE_PATH,
  DEFAULT_WATCHLIST,
  DEFAULT_CRYPTO_WATCHLIST,
  addTicker,
  cloneEntry,
  createDefaultEntries,
  defaultDynamicState,
  getActiveEntries,
  getActiveTickers,
  getEntry,
  isExpired,
  isWatched,
  normalizeAssetClass,
  normalizeBroker,
  normalizeExchange,
  normalizeMarketScannerMover,
  normalizeSource,
  normalizeWatchlistSource,
  normalizeWatchlistEntry,
  promoteMarketScannerMovers,
  resolveExpiryFromTtl,
  pruneExpiredTickers,
  readDynamicState,
  removeTicker,
  resetWatchlist,
  writeDynamicState,
};
