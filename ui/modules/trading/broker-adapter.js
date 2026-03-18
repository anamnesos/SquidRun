'use strict';

const dataIngestion = require('./data-ingestion');
const executor = require('./executor');
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

function createBroker(type) {
  const normalized = normalizeBrokerType(type);
  if (normalized === 'alpaca') {
    return createAlpacaBroker();
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
