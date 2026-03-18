'use strict';

const path = require('path');
const dotenv = require('dotenv');

const { getProjectRoot } = require('../../config');
const log = require('../logger');
const watchlist = require('./watchlist');

const SEC_TICKER_MAP_URL = 'https://www.sec.gov/files/company_tickers.json';
const SEC_SUBMISSIONS_BASE_URL = 'https://data.sec.gov/submissions';
const YAHOO_CHART_BASE_URL = 'https://query1.finance.yahoo.com/v8/finance/chart';
const DEFAULT_SEC_USER_AGENT = 'SquidRun trading module (contact: trading@squidrun.local)';
const DEFAULT_NEWS_LIMIT = 25;
const DEFAULT_FILINGS_LIMIT = 10;

let envLoaded = false;
let secTickerMapCache = null;

function ensureEnvLoaded() {
  if (envLoaded) return;
  try {
    dotenv.config({ path: path.join(getProjectRoot(), '.env') });
  } catch (_err) {
    // Best effort only. The app may already have process.env hydrated.
  }
  envLoaded = true;
}

function toNonEmptyString(value, fallback = '') {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function normalizeSymbols(symbols = []) {
  const list = Array.isArray(symbols) ? symbols : [symbols];
  return Array.from(
    new Set(
      list
        .map((value) => String(value || '').trim().toUpperCase())
        .filter(Boolean)
    )
  );
}

function resolveAssetClass(value, fallback = 'us_equity') {
  return watchlist.normalizeAssetClass(value, fallback);
}

function formatDateParam(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const asDate = new Date(value);
  if (Number.isNaN(asDate.getTime())) return null;
  return asDate.toISOString().slice(0, 10);
}

function formatIsoParam(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const asDate = new Date(value);
  if (Number.isNaN(asDate.getTime())) return null;
  return asDate.toISOString();
}

function resolveAlpacaCredentials(env = process.env) {
  ensureEnvLoaded();
  const keyId = toNonEmptyString(env.ALPACA_API_KEY || env.APCA_API_KEY_ID);
  const secretKey = toNonEmptyString(env.ALPACA_API_SECRET || env.APCA_API_SECRET_KEY);
  const paper = toBoolean(env.ALPACA_PAPER, true);
  const feed = toNonEmptyString(env.ALPACA_FEED || '', '');
  const baseUrl = toNonEmptyString(env.APCA_API_BASE_URL || '', '');

  return {
    keyId,
    secretKey,
    paper,
    feed,
    baseUrl,
    configured: Boolean(keyId && secretKey),
  };
}

function requireAlpacaSdk() {
  try {
    return require('@alpacahq/alpaca-trade-api');
  } catch (err) {
    const wrapped = new Error(
      'Alpaca SDK not installed in node_modules yet. Restart the app and run npm install to activate @alpacahq/alpaca-trade-api.'
    );
    wrapped.code = 'ALPACA_SDK_UNAVAILABLE';
    wrapped.cause = err;
    throw wrapped;
  }
}

function createAlpacaClient(options = {}) {
  if (options.client) return options.client;

  const credentials = {
    ...resolveAlpacaCredentials(options.env || process.env),
    ...(options.keyId ? { keyId: String(options.keyId).trim() } : {}),
    ...(options.secretKey ? { secretKey: String(options.secretKey).trim() } : {}),
    ...(options.paper !== undefined ? { paper: Boolean(options.paper) } : {}),
    ...(options.feed ? { feed: String(options.feed).trim() } : {}),
    ...(options.baseUrl ? { baseUrl: String(options.baseUrl).trim() } : {}),
  };

  if (!credentials.configured && !(credentials.keyId && credentials.secretKey)) {
    throw new Error('Alpaca credentials are missing. Set ALPACA_API_KEY and ALPACA_API_SECRET in .env.');
  }

  const Alpaca = requireAlpacaSdk();
  const clientOptions = {
    keyId: credentials.keyId,
    secretKey: credentials.secretKey,
    paper: credentials.paper,
  };
  if (credentials.feed) clientOptions.feed = credentials.feed;
  if (credentials.baseUrl) clientOptions.baseUrl = credentials.baseUrl;
  return new Alpaca(clientOptions);
}

function normalizeSnapshot(snapshot = {}) {
  const latestTrade = snapshot.LatestTrade || {};
  const latestQuote = snapshot.LatestQuote || {};
  const minuteBar = snapshot.MinuteBar || {};
  const dailyBar = snapshot.DailyBar || {};
  const prevDailyBar = snapshot.PrevDailyBar || {};

  return {
    symbol: toNonEmptyString(snapshot.symbol || latestTrade.Symbol || latestQuote.Symbol),
    tradePrice: Number(latestTrade.Price || minuteBar.ClosePrice || dailyBar.ClosePrice || 0) || null,
    bidPrice: Number(latestQuote.BidPrice || 0) || null,
    askPrice: Number(latestQuote.AskPrice || 0) || null,
    minuteClose: Number(minuteBar.ClosePrice || 0) || null,
    dailyClose: Number(dailyBar.ClosePrice || 0) || null,
    previousClose: Number(prevDailyBar.ClosePrice || 0) || null,
    dailyVolume: Number(dailyBar.Volume || minuteBar.Volume || 0) || null,
    tradeTimestamp: latestTrade.Timestamp || null,
    quoteTimestamp: latestQuote.Timestamp || null,
    raw: snapshot,
  };
}

function normalizeSnapshotCollection(rawSnapshots, symbols = []) {
  const normalized = new Map();

  if (rawSnapshots instanceof Map) {
    for (const [symbol, snapshot] of rawSnapshots.entries()) {
      normalized.set(String(symbol).toUpperCase(), normalizeSnapshot(snapshot));
    }
  } else if (Array.isArray(rawSnapshots)) {
    for (const snapshot of rawSnapshots) {
      const normalizedSnapshot = normalizeSnapshot(snapshot);
      if (normalizedSnapshot.symbol) {
        normalized.set(normalizedSnapshot.symbol, normalizedSnapshot);
      }
    }
  } else if (rawSnapshots && typeof rawSnapshots === 'object') {
    for (const [symbol, snapshot] of Object.entries(rawSnapshots)) {
      normalized.set(String(symbol).toUpperCase(), normalizeSnapshot(snapshot));
    }
  }

  for (const symbol of normalizeSymbols(symbols)) {
    if (!normalized.has(symbol)) {
      normalized.set(symbol, createEmptySnapshot(symbol));
    }
  }

  return normalized;
}

function createEmptySnapshot(symbol) {
  return {
    symbol,
    tradePrice: null,
    bidPrice: null,
    askPrice: null,
    minuteClose: null,
    dailyClose: null,
    previousClose: null,
    dailyVolume: null,
    tradeTimestamp: null,
    quoteTimestamp: null,
    raw: null,
  };
}

function normalizeNewsItem(item = {}) {
  return {
    id: item.ID || item.id || null,
    headline: item.Headline || item.headline || '',
    summary: item.Summary || item.summary || '',
    source: item.Source || item.source || '',
    author: item.Author || item.author || '',
    createdAt: item.CreatedAt || item.created_at || null,
    updatedAt: item.UpdatedAt || item.updated_at || null,
    url: item.URL || item.url || '',
    images: Array.isArray(item.Images) ? item.Images : (Array.isArray(item.images) ? item.images : []),
    symbols: normalizeSymbols(item.Symbols || item.symbols || []),
    raw: item,
  };
}

function normalizeBarRecord(symbol, bar = {}) {
  return {
    symbol,
    timestamp: bar.Timestamp || bar.timestamp || null,
    open: Number(bar.OpenPrice || bar.open || 0) || null,
    high: Number(bar.HighPrice || bar.high || 0) || null,
    low: Number(bar.LowPrice || bar.low || 0) || null,
    close: Number(bar.ClosePrice || bar.close || 0) || null,
    volume: Number(bar.Volume || bar.volume || 0) || null,
    tradeCount: Number(bar.TradeCount || bar.tradeCount || 0) || null,
    vwap: Number(bar.VWAP || bar.vwap || 0) || null,
  };
}

function normalizeBarsMap(rawBars, symbols = []) {
  const result = new Map();

  if (rawBars instanceof Map) {
    for (const [symbol, bars] of rawBars.entries()) {
      result.set(
        String(symbol).toUpperCase(),
        Array.isArray(bars) ? bars.map((bar) => normalizeBarRecord(String(symbol).toUpperCase(), bar)) : []
      );
    }
  } else if (rawBars && typeof rawBars === 'object') {
    for (const [symbol, bars] of Object.entries(rawBars)) {
      result.set(
        String(symbol).toUpperCase(),
        Array.isArray(bars) ? bars.map((bar) => normalizeBarRecord(String(symbol).toUpperCase(), bar)) : []
      );
    }
  }

  for (const symbol of normalizeSymbols(symbols)) {
    if (!result.has(symbol)) result.set(symbol, []);
  }

  return result;
}

function resolveTimeframe(client, timeframe = '1Day') {
  const raw = String(timeframe || '1Day').trim();
  const match = raw.match(/^(\d+)\s*(min|minute|minutes|hour|hours|day|days|week|weeks|month|months)$/i);
  if (!match || typeof client?.newTimeframe !== 'function' || !client?.timeframeUnit) {
    return raw;
  }

  const amount = Number.parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const unitMap = {
    min: client.timeframeUnit.MIN,
    minute: client.timeframeUnit.MIN,
    minutes: client.timeframeUnit.MIN,
    hour: client.timeframeUnit.HOUR || client.timeframeUnit.HR,
    hours: client.timeframeUnit.HOUR || client.timeframeUnit.HR,
    day: client.timeframeUnit.DAY,
    days: client.timeframeUnit.DAY,
    week: client.timeframeUnit.WEEK,
    weeks: client.timeframeUnit.WEEK,
    month: client.timeframeUnit.MONTH,
    months: client.timeframeUnit.MONTH,
  };

  return unitMap[unit] ? client.newTimeframe(amount, unitMap[unit]) : raw;
}

async function getMarketClock(options = {}) {
  const client = createAlpacaClient(options);
  return client.getClock();
}

async function getMarketCalendar(options = {}) {
  const client = createAlpacaClient(options);
  const params = {};
  const start = formatDateParam(options.start);
  const end = formatDateParam(options.end);
  if (start) params.start = start;
  if (end) params.end = end;
  return client.getCalendar(params);
}

function resolveWatchlistEntries(symbols, options = {}) {
  const normalizedSymbols = normalizeSymbols(
    symbols || watchlist.getTickers({
      assetClass: options.assetClass || options.asset_class,
      includeAll: options.includeAll === true,
    })
  );
  return normalizedSymbols.map((ticker) => {
    return watchlist.getEntry(ticker) || watchlist.normalizeWatchlistEntry({ ticker });
  });
}

function groupEntriesByBroker(entries = []) {
  const grouped = new Map();
  for (const entry of entries) {
    const brokerType = String(entry?.broker || 'alpaca').trim().toLowerCase() || 'alpaca';
    if (!grouped.has(brokerType)) grouped.set(brokerType, []);
    grouped.get(brokerType).push(entry);
  }
  return grouped;
}

function groupEntriesByAssetClass(entries = []) {
  const grouped = new Map();
  for (const entry of entries) {
    const assetClass = resolveAssetClass(entry?.assetClass || entry?.asset_class);
    if (!grouped.has(assetClass)) grouped.set(assetClass, []);
    grouped.get(assetClass).push(entry);
  }
  return grouped;
}

function isNormalizedSnapshot(snapshot) {
  return Boolean(
    snapshot
    && typeof snapshot === 'object'
    && (
      Object.prototype.hasOwnProperty.call(snapshot, 'tradePrice')
      || Object.prototype.hasOwnProperty.call(snapshot, 'bidPrice')
      || Object.prototype.hasOwnProperty.call(snapshot, 'askPrice')
      || Object.prototype.hasOwnProperty.call(snapshot, 'minuteClose')
    )
  );
}

function mergeSnapshotMaps(collections = [], symbols = []) {
  const merged = new Map();
  for (const collection of collections) {
    if (collection instanceof Map) {
      for (const [symbol, snapshot] of collection.entries()) {
        const upperSymbol = String(symbol).toUpperCase();
        merged.set(upperSymbol, isNormalizedSnapshot(snapshot)
          ? { ...createEmptySnapshot(upperSymbol), ...snapshot, symbol: upperSymbol }
          : normalizeSnapshot(snapshot));
      }
      continue;
    }

    const normalized = normalizeSnapshotCollection(collection);
    for (const [symbol, snapshot] of normalized.entries()) {
      merged.set(symbol, snapshot);
    }
  }

  for (const symbol of normalizeSymbols(symbols)) {
    if (!merged.has(symbol)) {
      merged.set(symbol, createEmptySnapshot(symbol));
    }
  }

  return merged;
}

async function getAlpacaWatchlistSnapshots(options = {}) {
  const client = createAlpacaClient(options);
  const entries = Array.isArray(options.watchlistEntries) && options.watchlistEntries.length > 0
    ? options.watchlistEntries
    : resolveWatchlistEntries(options.symbols, options);
  const grouped = groupEntriesByAssetClass(entries);
  const collections = await Promise.all(Array.from(grouped.entries()).map(async ([assetClass, assetEntries]) => {
    const symbols = normalizeSymbols(assetEntries.map((entry) => entry.ticker));
    if (symbols.length === 0) return new Map();
    if (assetClass === 'crypto' && typeof client.getCryptoSnapshots === 'function') {
      return normalizeSnapshotCollection(await client.getCryptoSnapshots(symbols), symbols);
    }
    return normalizeSnapshotCollection(await client.getSnapshots(symbols), symbols);
  }));

  return mergeSnapshotMaps(collections, entries.map((entry) => entry.ticker));
}

async function getWatchlistSnapshots(options = {}) {
  const { createBroker } = require('./broker-adapter');
  const entries = resolveWatchlistEntries(options.symbols, options);
  const grouped = groupEntriesByBroker(entries);
  const snapshots = await Promise.all(Array.from(grouped.entries()).map(async ([brokerType, brokerEntries]) => {
    const broker = createBroker(brokerType);
    return broker.getSnapshots({
      ...options,
      broker: brokerType,
      symbols: brokerEntries.map((entry) => entry.ticker),
      watchlistEntries: brokerEntries,
    });
  }));

  return mergeSnapshotMaps(snapshots, entries.map((entry) => entry.ticker));
}

async function getLatestBars(options = {}) {
  const client = createAlpacaClient(options);
  const normalized = new Map();
  const entries = Array.isArray(options.watchlistEntries) && options.watchlistEntries.length > 0
    ? options.watchlistEntries
    : resolveWatchlistEntries(options.symbols, options);
  const grouped = groupEntriesByAssetClass(entries);

  for (const [assetClass, assetEntries] of grouped.entries()) {
    const symbols = normalizeSymbols(assetEntries.map((entry) => entry.ticker));
    if (symbols.length === 0) continue;
    const rawBars = assetClass === 'crypto' && typeof client.getLatestCryptoBars === 'function'
      ? await client.getLatestCryptoBars(symbols)
      : await client.getLatestBars(symbols);

    if (rawBars instanceof Map) {
      for (const [symbol, bar] of rawBars.entries()) {
        normalized.set(String(symbol).toUpperCase(), normalizeBarRecord(String(symbol).toUpperCase(), bar));
      }
    }
  }

  for (const symbol of normalizeSymbols(entries.map((entry) => entry.ticker))) {
    if (!normalized.has(symbol)) normalized.set(symbol, null);
  }

  return normalized;
}

async function getHistoricalBars(options = {}) {
  const client = createAlpacaClient(options);
  const entries = Array.isArray(options.watchlistEntries) && options.watchlistEntries.length > 0
    ? options.watchlistEntries
    : resolveWatchlistEntries(options.symbols, options);
  const params = {
    limit: Number.parseInt(options.limit || '30', 10) || 30,
    timeframe: resolveTimeframe(client, options.timeframe || '1Day'),
  };
  const start = formatIsoParam(options.start);
  const end = formatIsoParam(options.end);
  if (start) params.start = start;
  if (end) params.end = end;
  const grouped = groupEntriesByAssetClass(entries);
  const collections = await Promise.all(Array.from(grouped.entries()).map(async ([assetClass, assetEntries]) => {
    const symbols = normalizeSymbols(assetEntries.map((entry) => entry.ticker));
    if (symbols.length === 0) return new Map();
    if (assetClass === 'crypto' && typeof client.getCryptoBars === 'function') {
      return normalizeBarsMap(await client.getCryptoBars(symbols, params), symbols);
    }

    const rawBars = symbols.length === 1
      ? new Map([[symbols[0], await collectAsyncBars(client.getBarsV2(symbols[0], params))]])
      : await client.getMultiBarsV2(symbols, params);
    return normalizeBarsMap(rawBars, symbols);
  }));

  const merged = new Map();
  for (const collection of collections) {
    for (const [symbol, bars] of collection.entries()) {
      merged.set(symbol, bars);
    }
  }

  for (const symbol of normalizeSymbols(entries.map((entry) => entry.ticker))) {
    if (!merged.has(symbol)) merged.set(symbol, []);
  }

  return merged;
}

async function collectAsyncBars(asyncIterable) {
  const bars = [];
  for await (const bar of asyncIterable) {
    bars.push(bar);
  }
  return bars;
}

async function getAlpacaNews(options = {}) {
  const client = createAlpacaClient(options);
  const entries = Array.isArray(options.watchlistEntries) && options.watchlistEntries.length > 0
    ? options.watchlistEntries
    : resolveWatchlistEntries(options.symbols, options);
  const symbols = normalizeSymbols(
    entries
      .filter((entry) => resolveAssetClass(entry?.assetClass || entry?.asset_class) !== 'crypto')
      .map((entry) => entry.ticker)
  );
  if (symbols.length === 0) {
    return [];
  }
  const params = {
    totalLimit: Number.parseInt(options.limit || `${DEFAULT_NEWS_LIMIT}`, 10) || DEFAULT_NEWS_LIMIT,
  };
  if (symbols.length > 0) {
    params.symbols = symbols;
  }
  const start = formatIsoParam(options.start);
  const end = formatIsoParam(options.end);
  if (start) params.start = start;
  if (end) params.end = end;

  const items = await client.getNews(params);
  return Array.isArray(items) ? items.map(normalizeNewsItem) : [];
}

async function getNews(options = {}) {
  const { createBroker } = require('./broker-adapter');
  const entries = resolveWatchlistEntries(options.symbols, options);
  const grouped = groupEntriesByBroker(entries);
  const newsLists = await Promise.all(Array.from(grouped.entries()).map(async ([brokerType, brokerEntries]) => {
    const broker = createBroker(brokerType);
    return broker.getNews({
      ...options,
      broker: brokerType,
      symbols: brokerEntries.map((entry) => entry.ticker),
      watchlistEntries: brokerEntries,
    });
  }));

  return newsLists.flat().map(normalizeNewsItem);
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const error = new Error(`Request failed: ${response.status} ${response.statusText}`);
    error.status = response.status;
    error.url = url;
    throw error;
  }
  return response.json();
}

async function getSecTickerMap(options = {}) {
  if (secTickerMapCache && !options.forceRefresh) {
    return secTickerMapCache;
  }

  const headers = {
    'User-Agent': toNonEmptyString(options.userAgent || process.env.SEC_API_USER_AGENT, DEFAULT_SEC_USER_AGENT),
    Accept: 'application/json',
  };
  const payload = await fetchJson(SEC_TICKER_MAP_URL, { headers });
  const map = new Map();

  for (const value of Object.values(payload || {})) {
    const ticker = toNonEmptyString(value.ticker).toUpperCase();
    if (!ticker) continue;
    map.set(ticker, {
      cik: String(value.cik_str || '').padStart(10, '0'),
      ticker,
      title: value.title || '',
    });
  }

  secTickerMapCache = map;
  return map;
}

async function getSecFilings(options = {}) {
  const symbol = toNonEmptyString(options.symbol || options.ticker).toUpperCase();
  if (!symbol) throw new Error('ticker is required for SEC filings');

  const tickerMap = await getSecTickerMap(options);
  const company = tickerMap.get(symbol);
  if (!company) {
    return [];
  }

  const headers = {
    'User-Agent': toNonEmptyString(options.userAgent || process.env.SEC_API_USER_AGENT, DEFAULT_SEC_USER_AGENT),
    Accept: 'application/json',
  };
  const payload = await fetchJson(`${SEC_SUBMISSIONS_BASE_URL}/CIK${company.cik}.json`, { headers });
  const recent = payload?.filings?.recent || {};
  const forms = Array.isArray(recent.form) ? recent.form : [];
  const filingDates = Array.isArray(recent.filingDate) ? recent.filingDate : [];
  const accessionNumbers = Array.isArray(recent.accessionNumber) ? recent.accessionNumber : [];
  const primaryDocuments = Array.isArray(recent.primaryDocument) ? recent.primaryDocument : [];
  const limit = Number.parseInt(options.limit || `${DEFAULT_FILINGS_LIMIT}`, 10) || DEFAULT_FILINGS_LIMIT;
  const acceptedForms = new Set(normalizeSymbols(options.forms || ['8-K', '10-Q', '10-K']));

  const filings = [];
  for (let index = 0; index < forms.length; index += 1) {
    const form = toNonEmptyString(forms[index]).toUpperCase();
    if (!acceptedForms.has(form)) continue;

    const accessionNumber = toNonEmptyString(accessionNumbers[index]);
    const accessionWithoutHyphens = accessionNumber.replace(/-/g, '');
    const primaryDocument = toNonEmptyString(primaryDocuments[index]);
    const filingDate = toNonEmptyString(filingDates[index]);

    filings.push({
      ticker: symbol,
      cik: company.cik,
      companyName: company.title,
      form,
      filingDate,
      accessionNumber,
      primaryDocument,
      filingUrl: accessionWithoutHyphens && primaryDocument
        ? `https://www.sec.gov/Archives/edgar/data/${Number(company.cik)}/${accessionWithoutHyphens}/${primaryDocument}`
        : '',
    });

    if (filings.length >= limit) break;
  }

  return filings;
}

async function getYahooHistoricalBars(options = {}) {
  const symbol = toNonEmptyString(options.symbol || options.ticker).toUpperCase();
  if (!symbol) throw new Error('ticker is required for Yahoo historical bars');

  const range = toNonEmptyString(options.range, '1mo');
  const interval = toNonEmptyString(options.interval, '1d');
  const includePrePost = options.includePrePost === true ? 'true' : 'false';
  const url = `${YAHOO_CHART_BASE_URL}/${encodeURIComponent(symbol)}?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}&includePrePost=${includePrePost}`;
  const payload = await fetchJson(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0',
    },
  });

  const result = payload?.chart?.result?.[0];
  if (!result) return [];

  const quote = result?.indicators?.quote?.[0] || {};
  const timestamps = Array.isArray(result.timestamp) ? result.timestamp : [];
  const bars = [];
  for (let index = 0; index < timestamps.length; index += 1) {
    bars.push({
      symbol,
      timestamp: new Date(Number(timestamps[index]) * 1000).toISOString(),
      open: Number(quote.open?.[index] || 0) || null,
      high: Number(quote.high?.[index] || 0) || null,
      low: Number(quote.low?.[index] || 0) || null,
      close: Number(quote.close?.[index] || 0) || null,
      volume: Number(quote.volume?.[index] || 0) || null,
    });
  }
  return bars;
}

async function buildWatchlistContext(options = {}) {
  const symbols = normalizeSymbols(
    options.symbols || watchlist.getTickers({ assetClass: options.assetClass || options.asset_class })
  );
  const isCryptoContext = resolveAssetClass(options.assetClass || options.asset_class) === 'crypto';
  const [clock, calendar, snapshots, news] = await Promise.all([
    isCryptoContext ? Promise.resolve(null) : getMarketClock(options),
    isCryptoContext
      ? Promise.resolve([])
      : getMarketCalendar({
        ...options,
        start: options.start || new Date(),
        end: options.end || options.start || new Date(),
      }),
    getWatchlistSnapshots({ ...options, symbols }),
    getNews({ ...options, symbols, limit: options.newsLimit || DEFAULT_NEWS_LIMIT }),
  ]);

  return {
    symbols,
    clock,
    calendar,
    snapshots,
    news,
  };
}

module.exports = {
  DEFAULT_NEWS_LIMIT,
  DEFAULT_FILINGS_LIMIT,
  resolveAlpacaCredentials,
  createAlpacaClient,
  getAlpacaWatchlistSnapshots,
  getAlpacaNews,
  normalizeSymbols,
  normalizeSnapshot,
  normalizeSnapshotCollection,
  normalizeNewsItem,
  normalizeBarRecord,
  getMarketClock,
  getMarketCalendar,
  getWatchlistSnapshots,
  getLatestBars,
  getHistoricalBars,
  getNews,
  getSecTickerMap,
  getSecFilings,
  getYahooHistoricalBars,
  buildWatchlistContext,
};
