/**
 * Watchlist Manager — Manages the set of stocks we actively monitor and trade.
 *
 * Initial list curated for swing trading on a small account:
 * high liquidity, large-cap, sector-diverse.
 */

'use strict';

function normalizeBroker(value, fallback = 'alpaca') {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized || fallback;
}

function normalizeExchange(value, fallback = 'SMART') {
  const normalized = String(value || '').trim().toUpperCase();
  return normalized || fallback;
}

function normalizeWatchlistEntry(entryOrTicker, name, sector, exchange, broker) {
  const input = typeof entryOrTicker === 'object' && entryOrTicker != null
    ? entryOrTicker
    : { ticker: entryOrTicker, name, sector, exchange, broker };
  const ticker = String(input.ticker || '').trim().toUpperCase();
  if (!ticker) {
    throw new Error('ticker is required');
  }

  return {
    ticker,
    name: String(input.name || ticker).trim(),
    sector: String(input.sector || 'Unspecified').trim(),
    exchange: normalizeExchange(input.exchange),
    broker: normalizeBroker(input.broker),
  };
}

function cloneEntry(entry) {
  return { ...entry };
}

const DEFAULT_WATCHLIST = [
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
].map((entry) => normalizeWatchlistEntry(entry));

let _watchlist = DEFAULT_WATCHLIST.map(cloneEntry);

/**
 * Get the current watchlist.
 * @returns {Array<{ticker: string, name: string, sector: string}>}
 */
function getWatchlist() {
  return _watchlist.map(cloneEntry);
}

function getEntry(ticker) {
  const upper = String(ticker || '').trim().toUpperCase();
  const entry = _watchlist.find((item) => item.ticker === upper);
  return entry ? cloneEntry(entry) : null;
}

/**
 * Get just the ticker symbols.
 * @returns {string[]}
 */
function getTickers() {
  return _watchlist.map((w) => w.ticker);
}

function getBrokerForTicker(ticker, fallback = 'alpaca') {
  return getEntry(ticker)?.broker || normalizeBroker(fallback);
}

function getExchangeForTicker(ticker, fallback = 'SMART') {
  return getEntry(ticker)?.exchange || normalizeExchange(fallback);
}

/**
 * Add a stock to the watchlist.
 * @param {string|object} ticker
 * @param {string} name
 * @param {string} sector
 * @param {string} exchange
 * @param {string} broker
 * @returns {boolean} true if added, false if already exists
 */
function addToWatchlist(ticker, name, sector, exchange, broker) {
  const entry = normalizeWatchlistEntry(ticker, name, sector, exchange, broker);
  if (_watchlist.some((w) => w.ticker === entry.ticker)) return false;
  _watchlist.push(entry);
  return true;
}

/**
 * Remove a stock from the watchlist.
 * @param {string} ticker
 * @returns {boolean} true if removed
 */
function removeFromWatchlist(ticker) {
  const upper = ticker.toUpperCase();
  const before = _watchlist.length;
  _watchlist = _watchlist.filter((w) => w.ticker !== upper);
  return _watchlist.length < before;
}

/**
 * Reset to default watchlist.
 */
function resetWatchlist() {
  _watchlist = DEFAULT_WATCHLIST.map(cloneEntry);
}

/**
 * Check if a ticker is on the watchlist.
 * @param {string} ticker
 * @returns {boolean}
 */
function isWatched(ticker) {
  return _watchlist.some((w) => w.ticker === ticker.toUpperCase());
}

module.exports = {
  getWatchlist,
  getEntry,
  getTickers,
  getBrokerForTicker,
  getExchangeForTicker,
  addToWatchlist,
  removeFromWatchlist,
  resetWatchlist,
  isWatched,
  normalizeWatchlistEntry,
  DEFAULT_WATCHLIST,
};
