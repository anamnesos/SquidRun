'use strict';

const watchlist = require('./watchlist');

const SEC_TICKER_MAP_URL = 'https://www.sec.gov/files/company_tickers.json';
const SEC_SUBMISSIONS_BASE_URL = 'https://data.sec.gov/submissions';
const YAHOO_CHART_BASE_URL = 'https://query1.finance.yahoo.com/v8/finance/chart';
const DEFAULT_SEC_USER_AGENT = 'SquidRun trading module (contact: trading@squidrun.local)';
const DEFAULT_NEWS_LIMIT = 25;
const DEFAULT_FILINGS_LIMIT = 10;

let secTickerMapCache = null;

function toNonEmptyString(value, fallback = '') {
  const normalized = String(value || '').trim();
  return normalized || fallback;
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

function normalizeSnapshot(snapshot = {}) {
  const latestTrade = snapshot.LatestTrade || {};
  const latestQuote = snapshot.LatestQuote || {};
  const minuteBar = snapshot.MinuteBar || {};
  const dailyBar = snapshot.DailyBar || {};
  const prevDailyBar = snapshot.PrevDailyBar || {};

  return {
    symbol: toNonEmptyString(snapshot.symbol || latestTrade.Symbol || latestQuote.Symbol),
    tradePrice: Number(latestTrade.Price || latestTrade.p || minuteBar.ClosePrice || minuteBar.Close || dailyBar.ClosePrice || dailyBar.Close || 0) || null,
    bidPrice: Number(latestQuote.BidPrice || latestQuote.bp || 0) || null,
    askPrice: Number(latestQuote.AskPrice || latestQuote.ap || 0) || null,
    minuteClose: Number(minuteBar.ClosePrice || minuteBar.Close || 0) || null,
    dailyClose: Number(dailyBar.ClosePrice || dailyBar.Close || 0) || null,
    previousClose: Number(prevDailyBar.ClosePrice || prevDailyBar.Close || 0) || null,
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
    open: Number(bar.OpenPrice || bar.Open || bar.open || 0) || null,
    high: Number(bar.HighPrice || bar.High || bar.high || 0) || null,
    low: Number(bar.LowPrice || bar.Low || bar.low || 0) || null,
    close: Number(bar.ClosePrice || bar.Close || bar.close || 0) || null,
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

async function getMarketClock(options = {}) {
  return options.clock || null;
}

async function getMarketCalendar(options = {}) {
  return Array.isArray(options.calendar) ? options.calendar : [];
}

function resolveWatchlistEntries(symbols, options = {}) {
  const normalizedSymbols = normalizeSymbols(
    symbols || watchlist.getTickers({
      assetClass: options.assetClass || options.asset_class,
      includeAll: options.includeAll === true,
    })
  );
  return normalizedSymbols.map((ticker) => {
    const existingEntry = watchlist.getEntry(ticker);
    if (existingEntry) {
      return existingEntry;
    }
    const inferredAssetClass = watchlist.getAssetClassForTicker(
      ticker,
      options.assetClass || options.asset_class || undefined
    );
    return watchlist.normalizeWatchlistEntry({
      ticker,
      assetClass: inferredAssetClass,
      broker: watchlist.getBrokerForTicker(ticker),
      exchange: watchlist.getExchangeForTicker(ticker),
    });
  });
}

function groupEntriesByBroker(entries = []) {
  const grouped = new Map();
  for (const entry of entries) {
    const brokerType = String(entry?.broker || 'ibkr').trim().toLowerCase() || 'ibkr';
    if (!grouped.has(brokerType)) grouped.set(brokerType, []);
    grouped.get(brokerType).push(entry);
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
  const { createBroker } = require('./broker-adapter');
  const entries = Array.isArray(options.watchlistEntries) && options.watchlistEntries.length > 0
    ? options.watchlistEntries
    : resolveWatchlistEntries(options.symbols, options);
  const grouped = groupEntriesByBroker(entries);
  const barCollections = await Promise.all(Array.from(grouped.entries()).map(async ([brokerType, brokerEntries]) => {
    const broker = createBroker(brokerType);
    if (typeof broker.getLatestBars === 'function') {
      return broker.getLatestBars({
        ...options,
        broker: brokerType,
        symbols: brokerEntries.map((entry) => entry.ticker),
        watchlistEntries: brokerEntries,
      });
    }
    return new Map(normalizeSymbols(brokerEntries.map((entry) => entry.ticker)).map((symbol) => [symbol, null]));
  }));

  const merged = new Map();
  for (const collection of barCollections) {
    for (const [symbol, bar] of collection.entries()) {
      merged.set(symbol, bar);
    }
  }
  for (const symbol of normalizeSymbols(entries.map((entry) => entry.ticker))) {
    if (!merged.has(symbol)) merged.set(symbol, null);
  }
  return merged;
}

async function getHistoricalBars(options = {}) {
  const { createBroker } = require('./broker-adapter');
  const entries = Array.isArray(options.watchlistEntries) && options.watchlistEntries.length > 0
    ? options.watchlistEntries
    : resolveWatchlistEntries(options.symbols, options);
  const grouped = groupEntriesByBroker(entries);
  const barCollections = await Promise.all(Array.from(grouped.entries()).map(async ([brokerType, brokerEntries]) => {
    const broker = createBroker(brokerType);
    if (typeof broker.getHistoricalBars === 'function') {
      return broker.getHistoricalBars({
        ...options,
        broker: brokerType,
        symbols: brokerEntries.map((entry) => entry.ticker),
        watchlistEntries: brokerEntries,
      });
    }
    return new Map(normalizeSymbols(brokerEntries.map((entry) => entry.ticker)).map((symbol) => [symbol, []]));
  }));

  const merged = new Map();
  for (const collection of barCollections) {
    for (const [symbol, bars] of collection.entries()) {
      merged.set(symbol, bars);
    }
  }
  for (const symbol of normalizeSymbols(entries.map((entry) => entry.ticker))) {
    if (!merged.has(symbol)) merged.set(symbol, []);
  }
  return merged;
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
  normalizeSymbols,
  normalizeSnapshot,
  normalizeSnapshotCollection,
  normalizeNewsItem,
  normalizeBarRecord,
  normalizeBarsMap,
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
