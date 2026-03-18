'use strict';

const fs = require('fs');
const path = require('path');

const { resolveCoordPath } = require('../../config');
const executor = require('./executor');
const ibkrClient = require('./ibkr-client');
const polymarketClient = require('./polymarket-client');
const riskEngine = require('./risk-engine');

const DEFAULT_PORTFOLIO_STATE_PATH = resolveCoordPath(path.join('runtime', 'portfolio-tracker-state.json'), { forWrite: true });
const MARKET_TIME_ZONE = 'America/Los_Angeles';

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toText(value, fallback = '') {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function toDateKeyInZone(value = new Date(), timeZone = MARKET_TIME_ZONE) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(value instanceof Date ? value : new Date(value));
}

function defaultPortfolioState() {
  return {
    dayStartDate: null,
    dayStartEquity: null,
    peakEquity: null,
    updatedAt: null,
  };
}

function readPortfolioState(statePath = DEFAULT_PORTFOLIO_STATE_PATH) {
  try {
    return {
      ...defaultPortfolioState(),
      ...JSON.parse(fs.readFileSync(statePath, 'utf8')),
    };
  } catch {
    return defaultPortfolioState();
  }
}

function writePortfolioState(statePath = DEFAULT_PORTFOLIO_STATE_PATH, state = {}) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({
    ...defaultPortfolioState(),
    ...state,
    updatedAt: new Date().toISOString(),
  }, null, 2));
}

function createMarketSnapshot(key, overrides = {}) {
  return {
    key,
    label: key,
    equity: 0,
    cash: 0,
    marketValue: 0,
    liquidCapital: 0,
    lockedCapital: 0,
    pnl: 0,
    buyingPower: 0,
    positions: [],
    deposits: [],
    sourceErrors: [],
    ...overrides,
  };
}

function createEmptySnapshot() {
  return {
    totalEquity: 0,
    totalCash: 0,
    totalMarketValue: 0,
    liquidCapital: 0,
    lockedCapital: 0,
    totalPnl: 0,
    markets: {
      alpaca_stocks: createMarketSnapshot('alpaca_stocks', { label: 'Alpaca Stocks' }),
      alpaca_crypto: createMarketSnapshot('alpaca_crypto', { label: 'Alpaca Crypto' }),
      ibkr_global: createMarketSnapshot('ibkr_global', { label: 'IBKR Global' }),
      polymarket: createMarketSnapshot('polymarket', { label: 'Polymarket' }),
      defi_yield: createMarketSnapshot('defi_yield', { label: 'DeFi Yield' }),
      solana_tokens: createMarketSnapshot('solana_tokens', { label: 'Solana Tokens' }),
      cash_reserve: createMarketSnapshot('cash_reserve', { label: 'Cash Reserve' }),
    },
    positions: [],
    warnings: [],
    sourceErrors: [],
    risk: {
      totalDrawdownPct: 0,
      dailyLossPct: 0,
      killSwitchTriggered: false,
      peakEquity: 0,
      dayStartEquity: 0,
      statePath: DEFAULT_PORTFOLIO_STATE_PATH,
    },
    asOf: new Date().toISOString(),
  };
}

function normalizeEquityPosition(position = {}, defaults = {}) {
  const ticker = toText(position.ticker || position.symbol).toUpperCase();
  return {
    ticker,
    broker: toText(position.broker, defaults.broker),
    assetClass: toText(position.assetClass || position.asset_class, defaults.assetClass || 'us_equity'),
    exchange: toText(position.exchange, defaults.exchange),
    shares: toNumber(position.shares || position.qty, 0),
    avgPrice: toNumber(position.avgPrice || position.avg_entry_price, 0),
    marketValue: toNumber(position.marketValue || position.market_value, 0),
    unrealizedPnl: toNumber(position.unrealizedPnl ?? position.raw?.unrealized_pl, 0),
    side: toText(position.side, 'long'),
    raw: position.raw || position,
  };
}

function normalizePolymarketPosition(position = {}) {
  return {
    ticker: toText(position.market || position.tokenId || position.token_id),
    broker: 'polymarket',
    assetClass: 'prediction_market',
    exchange: 'POLYMARKET',
    tokenId: toText(position.tokenId || position.token_id),
    outcome: toText(position.outcome),
    shares: toNumber(position.size, 0),
    avgPrice: toNumber(position.avgEntryPrice, 0),
    marketValue: toNumber(position.marketValue, 0),
    unrealizedPnl: toNumber(position.unrealizedPnl, 0),
    realizedPnl: toNumber(position.realizedPnl, 0),
    side: 'long',
    raw: position.raw || position,
  };
}

function normalizeYieldDeposit(deposit = {}) {
  return {
    venue: toText(deposit.venue || deposit.protocol),
    amount: toNumber(deposit.amount, 0),
    currentValue: toNumber(deposit.currentValue ?? deposit.amount, 0),
    apy: toNumber(deposit.apy, 0),
    locked: deposit.locked !== false,
    depositedAt: deposit.depositedAt || null,
    raw: deposit.raw || deposit,
  };
}

function normalizeSolanaPosition(position = {}) {
  return {
    ticker: toText(position.ticker || position.symbol).toUpperCase(),
    broker: 'dex',
    assetClass: 'solana_token',
    exchange: toText(position.exchange, 'SOLANA'),
    shares: toNumber(position.shares || position.qty, 0),
    avgPrice: toNumber(position.avgPrice, 0),
    marketValue: toNumber(position.marketValue, 0),
    unrealizedPnl: toNumber(position.unrealizedPnl ?? position.pnl, 0),
    side: 'long',
    raw: position.raw || position,
  };
}

function appendSourceError(snapshot, source, err) {
  const message = `${source}: ${err?.message || err || 'unknown error'}`;
  snapshot.sourceErrors.push(message);
  snapshot.warnings.push(message);
}

function sumPositionValues(positions = []) {
  return positions.reduce((sum, position) => sum + toNumber(position.marketValue, 0), 0);
}

function sumPositionPnl(positions = []) {
  return positions.reduce((sum, position) => {
    return sum + toNumber(position.unrealizedPnl, 0) + toNumber(position.realizedPnl, 0);
  }, 0);
}

function summarizeRisk(totalEquity, openPositions, state = {}, limits = riskEngine.DEFAULT_LIMITS) {
  const peakEquity = Math.max(toNumber(state.peakEquity, totalEquity), totalEquity);
  const dayStartEquity = toNumber(state.dayStartEquity, totalEquity);
  const account = {
    equity: totalEquity,
    peakEquity,
    dayStartEquity,
    tradesToday: 0,
    openPositions,
  };
  const killSwitch = riskEngine.checkKillSwitch(account, limits);
  const dailyPause = riskEngine.checkDailyPause(account, limits);
  return {
    totalDrawdownPct: Number(killSwitch.drawdownPct.toFixed(6)),
    dailyLossPct: Number(dailyPause.dayLossPct.toFixed(6)),
    killSwitchTriggered: killSwitch.triggered,
    peakEquity,
    dayStartEquity,
  };
}

function resolvePersistentState(totalEquity, options = {}) {
  const statePath = options.statePath || DEFAULT_PORTFOLIO_STATE_PATH;
  const now = options.now || new Date();
  const todayKey = toDateKeyInZone(now);
  const previousState = options.state
    ? { ...defaultPortfolioState(), ...options.state }
    : readPortfolioState(statePath);
  const nextState = {
    ...previousState,
    peakEquity: Math.max(toNumber(previousState.peakEquity, totalEquity), totalEquity),
  };

  if (previousState.dayStartDate !== todayKey || previousState.dayStartEquity == null) {
    nextState.dayStartDate = todayKey;
    nextState.dayStartEquity = totalEquity;
  }

  if (options.persist !== false) {
    writePortfolioState(statePath, nextState);
  }

  return {
    statePath,
    state: nextState,
  };
}

async function collectAlpacaData(options = {}) {
  const account = options.alpacaAccount ?? await executor.getAlpacaAccountSnapshot(options);
  const positions = options.alpacaPositions ?? await executor.getAlpacaOpenPositions(options);
  return {
    account,
    positions: Array.isArray(positions) ? positions : [],
  };
}

async function collectIbkrData(options = {}) {
  const account = options.ibkrAccount ?? await ibkrClient.getAccount(options);
  const positions = options.ibkrPositions ?? await ibkrClient.getPositions(options);
  return {
    account,
    positions: Array.isArray(positions) ? positions : [],
  };
}

async function collectPolymarketData(options = {}) {
  const balance = options.polymarketBalance ?? await polymarketClient.getBalance(options);
  const positions = options.polymarketPositions ?? await polymarketClient.getPositions(options);
  return {
    balance,
    positions: Array.isArray(positions) ? positions : [],
  };
}

async function getPortfolioSnapshot(options = {}) {
  const snapshot = createEmptySnapshot();
  const includeIbkr = options.includeIbkr === true || options.ibkrAccount || options.ibkrPositions;
  const polymarketConfigured = polymarketClient.resolvePolymarketConfig(process.env).configured;
  const includePolymarket = options.includePolymarket === false
    ? false
    : options.includePolymarket === true
      || options.polymarketBalance
      || options.polymarketPositions
      || polymarketConfigured;

  try {
    const { account, positions } = await collectAlpacaData(options);
    const normalizedPositions = positions.map((position) => normalizeEquityPosition(position, { broker: 'alpaca' }));
    const stockPositions = normalizedPositions.filter((position) => position.assetClass !== 'crypto');
    const cryptoPositions = normalizedPositions.filter((position) => position.assetClass === 'crypto');
    const stockMarketValue = sumPositionValues(stockPositions);
    const cryptoMarketValue = sumPositionValues(cryptoPositions);
    const cash = toNumber(account?.cash, 0);
    const residual = toNumber(account?.equity, 0) - (cash + stockMarketValue + cryptoMarketValue);

    snapshot.markets.alpaca_stocks.positions = stockPositions;
    snapshot.markets.alpaca_stocks.marketValue = Number(stockMarketValue.toFixed(2));
    snapshot.markets.alpaca_stocks.pnl = Number(sumPositionPnl(stockPositions).toFixed(2));
    snapshot.markets.alpaca_stocks.equity = Number(stockMarketValue.toFixed(2));
    snapshot.markets.alpaca_stocks.liquidCapital = Number(stockMarketValue.toFixed(2));
    snapshot.markets.alpaca_stocks.buyingPower = toNumber(account?.buyingPower, 0);

    snapshot.markets.alpaca_crypto.positions = cryptoPositions;
    snapshot.markets.alpaca_crypto.marketValue = Number(cryptoMarketValue.toFixed(2));
    snapshot.markets.alpaca_crypto.pnl = Number(sumPositionPnl(cryptoPositions).toFixed(2));
    snapshot.markets.alpaca_crypto.equity = Number(cryptoMarketValue.toFixed(2));
    snapshot.markets.alpaca_crypto.liquidCapital = Number(cryptoMarketValue.toFixed(2));

    snapshot.markets.cash_reserve.cash += Number((cash + residual).toFixed(2));
    snapshot.markets.cash_reserve.equity += Number((cash + residual).toFixed(2));
    snapshot.markets.cash_reserve.liquidCapital += Number((cash + residual).toFixed(2));
    snapshot.positions.push(...normalizedPositions);
  } catch (err) {
    appendSourceError(snapshot, 'alpaca', err);
  }

  if (includeIbkr) {
    try {
      const { account, positions } = await collectIbkrData(options);
      const normalizedPositions = positions.map((position) => normalizeEquityPosition(position, { broker: 'ibkr' }));
      const marketValue = sumPositionValues(normalizedPositions);
      const cash = toNumber(account?.cash, 0);
      const residual = toNumber(account?.equity, 0) - (cash + marketValue);

      snapshot.markets.ibkr_global.positions = normalizedPositions;
      snapshot.markets.ibkr_global.marketValue = Number(marketValue.toFixed(2));
      snapshot.markets.ibkr_global.pnl = Number(sumPositionPnl(normalizedPositions).toFixed(2));
      snapshot.markets.ibkr_global.equity = Number(marketValue.toFixed(2));
      snapshot.markets.ibkr_global.liquidCapital = Number(marketValue.toFixed(2));
      snapshot.markets.ibkr_global.buyingPower = toNumber(account?.buyingPower, 0);
      snapshot.markets.cash_reserve.cash += Number((cash + residual).toFixed(2));
      snapshot.markets.cash_reserve.equity += Number((cash + residual).toFixed(2));
      snapshot.markets.cash_reserve.liquidCapital += Number((cash + residual).toFixed(2));
      snapshot.positions.push(...normalizedPositions);
    } catch (err) {
      appendSourceError(snapshot, 'ibkr', err);
      snapshot.markets.ibkr_global.sourceErrors.push(err.message);
    }
  }

  if (includePolymarket) {
    try {
      const { balance, positions } = await collectPolymarketData(options);
      const normalizedPositions = positions.map(normalizePolymarketPosition);
      const marketValue = sumPositionValues(normalizedPositions);
      const available = toNumber(balance?.available ?? balance?.balance, 0);

      snapshot.markets.polymarket.positions = normalizedPositions;
      snapshot.markets.polymarket.cash = Number(available.toFixed(2));
      snapshot.markets.polymarket.marketValue = Number(marketValue.toFixed(2));
      snapshot.markets.polymarket.pnl = Number(sumPositionPnl(normalizedPositions).toFixed(2));
      snapshot.markets.polymarket.equity = Number((available + marketValue).toFixed(2));
      snapshot.markets.polymarket.liquidCapital = Number((available + marketValue).toFixed(2));
      snapshot.positions.push(...normalizedPositions);
    } catch (err) {
      appendSourceError(snapshot, 'polymarket', err);
      snapshot.markets.polymarket.sourceErrors.push(err.message);
    }
  }

  const defiDeposits = Array.isArray(options.defiDeposits) ? options.defiDeposits.map(normalizeYieldDeposit) : [];
  snapshot.markets.defi_yield.deposits = defiDeposits;
  snapshot.markets.defi_yield.marketValue = Number(defiDeposits.reduce((sum, deposit) => sum + deposit.currentValue, 0).toFixed(2));
  snapshot.markets.defi_yield.equity = snapshot.markets.defi_yield.marketValue;
  snapshot.markets.defi_yield.pnl = Number(defiDeposits.reduce((sum, deposit) => sum + (deposit.currentValue - deposit.amount), 0).toFixed(2));
  snapshot.markets.defi_yield.lockedCapital = Number(defiDeposits
    .filter((deposit) => deposit.locked !== false)
    .reduce((sum, deposit) => sum + deposit.currentValue, 0)
    .toFixed(2));
  snapshot.markets.defi_yield.liquidCapital = Number(defiDeposits
    .filter((deposit) => deposit.locked === false)
    .reduce((sum, deposit) => sum + deposit.currentValue, 0)
    .toFixed(2));

  const solanaPositions = Array.isArray(options.solanaPositions) ? options.solanaPositions.map(normalizeSolanaPosition) : [];
  snapshot.markets.solana_tokens.positions = solanaPositions;
  snapshot.markets.solana_tokens.marketValue = Number(sumPositionValues(solanaPositions).toFixed(2));
  snapshot.markets.solana_tokens.equity = snapshot.markets.solana_tokens.marketValue;
  snapshot.markets.solana_tokens.pnl = Number(sumPositionPnl(solanaPositions).toFixed(2));
  snapshot.markets.solana_tokens.liquidCapital = snapshot.markets.solana_tokens.equity;
  snapshot.positions.push(...solanaPositions);

  snapshot.totalCash = Number(Object.values(snapshot.markets).reduce((sum, market) => sum + toNumber(market.cash, 0), 0).toFixed(2));
  snapshot.totalMarketValue = Number(Object.values(snapshot.markets).reduce((sum, market) => sum + toNumber(market.marketValue, 0), 0).toFixed(2));
  snapshot.liquidCapital = Number(Object.values(snapshot.markets).reduce((sum, market) => sum + toNumber(market.liquidCapital, 0), 0).toFixed(2));
  snapshot.lockedCapital = Number(Object.values(snapshot.markets).reduce((sum, market) => sum + toNumber(market.lockedCapital, 0), 0).toFixed(2));
  snapshot.totalPnl = Number(Object.values(snapshot.markets).reduce((sum, market) => sum + toNumber(market.pnl, 0), 0).toFixed(2));
  snapshot.totalEquity = Number(Object.values(snapshot.markets).reduce((sum, market) => sum + toNumber(market.equity, 0), 0).toFixed(2));

  const { statePath, state } = resolvePersistentState(snapshot.totalEquity, options);
  snapshot.risk = {
    ...summarizeRisk(snapshot.totalEquity, snapshot.positions, state, options.limits || riskEngine.DEFAULT_LIMITS),
    liquidCapital: snapshot.liquidCapital,
    lockedCapital: snapshot.lockedCapital,
    statePath,
  };
  snapshot.asOf = new Date().toISOString();
  return snapshot;
}

module.exports = {
  DEFAULT_PORTFOLIO_STATE_PATH,
  createEmptySnapshot,
  getPortfolioSnapshot,
  readPortfolioState,
  writePortfolioState,
};
