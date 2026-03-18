/**
 * Watchlist Manager — Manages the set of stocks we actively monitor and trade.
 *
 * Initial list curated for swing trading on a small account:
 * high liquidity, large-cap, sector-diverse.
 */

'use strict';

const DEFAULT_WATCHLIST = [
  { ticker: 'AAPL',  name: 'Apple',          sector: 'Tech/Consumer' },
  { ticker: 'MSFT',  name: 'Microsoft',      sector: 'Tech/Cloud' },
  { ticker: 'NVDA',  name: 'NVIDIA',         sector: 'Semiconductors/AI' },
  { ticker: 'TSLA',  name: 'Tesla',          sector: 'Auto/Tech' },
  { ticker: 'AMZN',  name: 'Amazon',         sector: 'E-commerce/Cloud' },
  { ticker: 'META',  name: 'Meta Platforms',  sector: 'Communication' },
  { ticker: 'GOOGL', name: 'Alphabet',       sector: 'Search/AI' },
  { ticker: 'AMD',   name: 'AMD',            sector: 'Semiconductors' },
  { ticker: 'AVGO',  name: 'Broadcom',       sector: 'Semiconductors/Net' },
  { ticker: 'JPM',   name: 'JPMorgan Chase', sector: 'Financials' },
];

let _watchlist = [...DEFAULT_WATCHLIST];

/**
 * Get the current watchlist.
 * @returns {Array<{ticker: string, name: string, sector: string}>}
 */
function getWatchlist() {
  return [..._watchlist];
}

/**
 * Get just the ticker symbols.
 * @returns {string[]}
 */
function getTickers() {
  return _watchlist.map(w => w.ticker);
}

/**
 * Add a stock to the watchlist.
 * @param {string} ticker
 * @param {string} name
 * @param {string} sector
 * @returns {boolean} true if added, false if already exists
 */
function addToWatchlist(ticker, name, sector) {
  const upper = ticker.toUpperCase();
  if (_watchlist.some(w => w.ticker === upper)) return false;
  _watchlist.push({ ticker: upper, name, sector });
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
  _watchlist = _watchlist.filter(w => w.ticker !== upper);
  return _watchlist.length < before;
}

/**
 * Reset to default watchlist.
 */
function resetWatchlist() {
  _watchlist = [...DEFAULT_WATCHLIST];
}

/**
 * Check if a ticker is on the watchlist.
 * @param {string} ticker
 * @returns {boolean}
 */
function isWatched(ticker) {
  return _watchlist.some(w => w.ticker === ticker.toUpperCase());
}

module.exports = { getWatchlist, getTickers, addToWatchlist, removeFromWatchlist, resetWatchlist, isWatched, DEFAULT_WATCHLIST };
