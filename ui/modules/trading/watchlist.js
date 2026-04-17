'use strict';

const dynamicWatchlist = require('./dynamic-watchlist');

function cloneEntry(entry) {
  return dynamicWatchlist.cloneEntry(entry);
}

function getWatchlist(options = {}) {
  const assetClass = options.includeAll === true
    ? 'all'
    : (options.assetClass || options.asset_class || 'us_equity');
  return dynamicWatchlist.getActiveEntries({
    ...options,
    assetClass,
  }).map(cloneEntry);
}

function getEntry(ticker, options = {}) {
  const entry = dynamicWatchlist.getEntry(ticker, options);
  return entry ? cloneEntry(entry) : null;
}

function getTickers(options = {}) {
  return getWatchlist(options).map((entry) => entry.ticker);
}

function getBrokerForTicker(ticker, fallback = 'alpaca') {
  const entry = getEntry(ticker);
  if (entry?.broker) {
    return entry.broker;
  }
  const normalizedTicker = String(ticker || '').trim().toUpperCase();
  if (normalizedTicker.endsWith('/USD')) {
    return 'hyperliquid';
  }
  return dynamicWatchlist.normalizeBroker(fallback);
}

function getExchangeForTicker(ticker, fallback = 'SMART') {
  return getEntry(ticker)?.exchange || dynamicWatchlist.normalizeExchange(fallback);
}

function getAssetClassForTicker(ticker, fallback = 'us_equity') {
  return getEntry(ticker)?.assetClass || (String(ticker || '').trim().toUpperCase().endsWith('/USD') ? 'crypto' : dynamicWatchlist.normalizeAssetClass(fallback));
}

function addToWatchlist(ticker, name, sector, exchange, broker, assetClass) {
  if (dynamicWatchlist.isWatched(ticker)) return false;
  return dynamicWatchlist.addTicker(ticker, {
    name,
    sector,
    exchange,
    broker,
    assetClass,
    source: 'manual',
  });
}

function removeFromWatchlist(ticker) {
  return dynamicWatchlist.removeTicker(ticker);
}

function resetWatchlist() {
  return dynamicWatchlist.resetWatchlist();
}

function isWatched(ticker) {
  return dynamicWatchlist.isWatched(ticker);
}

module.exports = {
  getWatchlist,
  getEntry,
  getTickers,
  getBrokerForTicker,
  getExchangeForTicker,
  getAssetClassForTicker,
  addToWatchlist,
  removeFromWatchlist,
  resetWatchlist,
  isWatched,
  normalizeAssetClass: dynamicWatchlist.normalizeAssetClass,
  normalizeWatchlistEntry: dynamicWatchlist.normalizeWatchlistEntry,
  DEFAULT_WATCHLIST: dynamicWatchlist.DEFAULT_WATCHLIST,
  DEFAULT_CRYPTO_WATCHLIST: dynamicWatchlist.DEFAULT_CRYPTO_WATCHLIST,
};
