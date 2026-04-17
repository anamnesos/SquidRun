'use strict';

const dataIngestion = require('./data-ingestion');
const executor = require('./executor');
const hyperliquidClient = require('./hyperliquid-client');
const ibkrClient = require('./ibkr-client');

function normalizeBrokerType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized || 'alpaca';
}

function createAlpacaBroker() {
  return {
    type: 'alpaca',
    connect: async () => null,
    disconnect: async () => null,
    getAccount: (options = {}) => executor.getAlpacaAccountSnapshot(options),
    getPositions: (options = {}) => executor.getAlpacaOpenPositions(options),
    submitOrder: (input = {}, options = {}) => executor.submitAlpacaOrder(input, options),
    getSnapshots: (options = {}) => dataIngestion.getAlpacaWatchlistSnapshots(options),
    getLatestBars: (options = {}) => dataIngestion.getAlpacaLatestBars(options),
    getHistoricalBars: (options = {}) => dataIngestion.getAlpacaHistoricalBars(options),
    getNews: (options = {}) => dataIngestion.getAlpacaNews(options),
  };
}

function createIbkrBroker() {
  return {
    type: 'ibkr',
    connect: ibkrClient.connect,
    disconnect: ibkrClient.disconnect,
    getAccount: ibkrClient.getAccount,
    getPositions: ibkrClient.getPositions,
    submitOrder: ibkrClient.submitOrder,
    getSnapshots: ibkrClient.getSnapshots,
    getNews: ibkrClient.getNews,
  };
}

function createHyperliquidBroker() {
  return {
    type: 'hyperliquid',
    connect: async () => null,
    disconnect: async () => null,
    getAccount: (options = {}) => hyperliquidClient.getAccountSnapshot(options),
    getPositions: (options = {}) => hyperliquidClient.getOpenPositions(options),
    submitOrder: (input = {}, options = {}) => executor.submitHyperliquidOrder(input, options),
    getSnapshots: (options = {}) => hyperliquidClient.getSnapshots(options),
    getLatestBars: (options = {}) => hyperliquidClient.getLatestBars(options),
    getHistoricalBars: (options = {}) => hyperliquidClient.getHistoricalBars(options),
    getNews: async () => [],
  };
}

function createBroker(type) {
  const normalized = normalizeBrokerType(type);
  if (normalized === 'alpaca') {
    return createAlpacaBroker();
  }
  if (normalized === 'hyperliquid') {
    return createHyperliquidBroker();
  }
  if (normalized === 'ibkr') {
    return createIbkrBroker();
  }
  throw new Error(`Unsupported broker type: ${type}`);
}

module.exports = {
  createBroker,
  normalizeBrokerType,
};
