'use strict';

const crypto = require('crypto');

const { createAlpacaClient } = require('./data-ingestion');
const { checkTrade, DEFAULT_LIMITS } = require('./risk-engine');
const journal = require('./journal');
const watchlist = require('./watchlist');

function toPositiveInteger(value) {
  const numeric = Math.floor(Number(value));
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

function roundPrice(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Number(numeric.toFixed(2));
}

function normalizeDirection(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (normalized === 'BUY' || normalized === 'SELL' || normalized === 'HOLD') {
    return normalized;
  }
  throw new Error(`Unsupported trade direction: ${value}`);
}

function generateClientOrderId(prefix = 'sq') {
  const suffix = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().slice(0, 12)
    : Math.random().toString(36).slice(2, 14);
  return `${prefix}-${suffix}`;
}

function buildOrderPayload(input = {}) {
  const direction = normalizeDirection(input.direction);
  const quantity = toPositiveInteger(input.shares || input.qty);
  if (direction === 'HOLD') {
    throw new Error('Cannot build an order payload for HOLD');
  }
  if (quantity < 1) {
    throw new Error('Order quantity must be at least 1 whole share');
  }

  const payload = {
    symbol: String(input.ticker || input.symbol || '').trim().toUpperCase(),
    qty: quantity,
    side: direction === 'BUY' ? 'buy' : 'sell',
    type: input.orderType || 'market',
    time_in_force: input.timeInForce || 'day',
    client_order_id: input.clientOrderId || generateClientOrderId('trade'),
  };

  if (!payload.symbol) {
    throw new Error('ticker is required');
  }

  if (direction === 'BUY' && Number(input.stopLossPrice) > 0) {
    payload.order_class = 'bracket';
    payload.stop_loss = {
      stop_price: roundPrice(input.stopLossPrice),
    };
  }

  if (input.limitPrice != null) {
    payload.limit_price = roundPrice(input.limitPrice);
  }

  if (input.extendedHours === true) {
    payload.extended_hours = true;
  }

  return payload;
}

function normalizeAccount(account = {}) {
  return {
    id: account.id || account.account_number || null,
    status: account.status || null,
    equity: Number(account.equity || 0) || 0,
    cash: Number(account.cash || 0) || 0,
    buyingPower: Number(account.buying_power || account.buyingPower || 0) || 0,
    daytradeCount: Number(account.daytrade_count || account.daytradeCount || 0) || 0,
    patternDayTrader: Boolean(account.pattern_day_trader || account.patternDayTrader),
    raw: account,
  };
}

function normalizePosition(position = {}) {
  return {
    ticker: String(position.symbol || position.ticker || '').trim().toUpperCase(),
    shares: Number(position.qty || position.shares || 0) || 0,
    avgPrice: Number(position.avg_entry_price || position.avgPrice || 0) || 0,
    marketValue: Number(position.market_value || position.marketValue || 0) || 0,
    side: position.side || 'long',
    raw: position,
  };
}

function normalizeOrder(order = {}) {
  return {
    id: order.id || null,
    clientOrderId: order.client_order_id || order.clientOrderId || null,
    status: order.status || null,
    symbol: String(order.symbol || '').trim().toUpperCase(),
    side: order.side || null,
    qty: Number(order.qty || 0) || 0,
    filledQty: Number(order.filled_qty || order.filledQty || 0) || 0,
    filledAvgPrice: Number(order.filled_avg_price || order.filledAvgPrice || 0) || null,
    type: order.type || null,
    raw: order,
  };
}

async function submitOrder(input = {}, options = {}) {
  const brokerType = resolveBrokerType(input, options);
  if (brokerType !== 'alpaca') {
    const broker = getBrokerAdapter(brokerType);
    const result = await broker.submitOrder({ ...input, broker: brokerType }, { ...options, broker: brokerType });
    if (options.recordJournal !== false) {
      recordTradeSubmission(result, input, options);
    }
    return result;
  }

  return submitAlpacaOrder(input, options);
}

async function submitAlpacaOrder(input = {}, options = {}) {
  const client = createAlpacaClient(options);
  const payload = buildOrderPayload(input);

  if (options.dryRun === true) {
    return {
      ok: true,
      status: 'dry_run',
      payload,
      order: null,
    };
  }

  const rawOrder = await client.createOrder(payload);
  const order = normalizeOrder(rawOrder);

  if (options.recordJournal !== false) {
    const db = options.journalDb || journal.getDb(options.journalPath);
    journal.recordTrade(db, {
      ticker: payload.symbol,
      direction: payload.side.toUpperCase(),
      shares: payload.qty,
      price: order.filledAvgPrice || Number(input.referencePrice || input.price || 0) || 0,
      stopLossPrice: payload.stop_loss?.stop_price || null,
      consensusDetail: input.consensusDetail || null,
      riskCheckDetail: input.riskCheckDetail || null,
      status: (order.status || 'PENDING').toUpperCase(),
      alpacaOrderId: order.id,
      notes: input.notes || null,
    });
  }

  return {
    ok: true,
    status: order.status || 'accepted',
    payload,
    order,
  };
}

async function executeConsensusTrade(input = {}, options = {}) {
  const consensus = input.consensus || {};
  const direction = normalizeDirection(consensus.decision || input.direction || 'HOLD');
  if (!consensus.consensus || direction === 'HOLD') {
    return {
      ok: false,
      status: 'no_action',
      reason: 'Consensus did not authorize a BUY/SELL trade',
    };
  }

  const trade = {
    ticker: consensus.ticker || input.ticker,
    direction,
    price: Number(input.price || input.referencePrice || 0) || 0,
    marketCap: input.marketCap ?? null,
  };

  const account = input.account || {
    equity: 0,
    peakEquity: 0,
    dayStartEquity: 0,
    tradesToday: 0,
    openPositions: [],
  };
  const limits = input.limits || DEFAULT_LIMITS;
  const riskCheck = checkTrade(trade, account, limits);
  if (!riskCheck.approved) {
    return {
      ok: false,
      status: 'rejected',
      riskCheck,
    };
  }

  const quantityCap = toPositiveInteger(riskCheck.maxShares);
  const requestedShares = toPositiveInteger(input.requestedShares || quantityCap);
  const shares = Math.min(quantityCap, requestedShares || quantityCap);
  if (shares < 1) {
    return {
      ok: false,
      status: 'rejected',
      reason: 'Risk engine did not allow at least one share',
      riskCheck,
    };
  }

  return submitOrder({
    ticker: trade.ticker,
    direction,
    shares,
    stopLossPrice: riskCheck.stopLossPrice,
    referencePrice: trade.price,
    consensusDetail: consensus,
    riskCheckDetail: riskCheck,
    notes: input.notes || null,
  }, options);
}

async function getAccountSnapshot(options = {}) {
  const brokerTypes = resolveBrokerTypes(options);
  if (brokerTypes.length === 1) {
    return getBrokerAdapter(brokerTypes[0]).getAccount({ ...options, broker: brokerTypes[0] });
  }

  const accounts = await Promise.all(brokerTypes.map((brokerType) => {
    return getBrokerAdapter(brokerType).getAccount({ ...options, broker: brokerType });
  }));
  return mergeAccountSnapshots(accounts);
}

async function getAlpacaAccountSnapshot(options = {}) {
  const client = createAlpacaClient(options);
  const account = await client.getAccount();
  return normalizeAccount(account);
}

async function getOpenPositions(options = {}) {
  const brokerTypes = resolveBrokerTypes(options);
  const positions = await Promise.all(brokerTypes.map((brokerType) => {
    return getBrokerAdapter(brokerType).getPositions({ ...options, broker: brokerType });
  }));
  return positions.flat();
}

async function getAlpacaOpenPositions(options = {}) {
  const client = createAlpacaClient(options);
  const positions = await client.getPositions();
  return Array.isArray(positions)
    ? positions.map((position) => ({ ...normalizePosition(position), broker: 'alpaca' }))
    : [];
}

async function syncJournalPositions(options = {}) {
  const db = options.journalDb || journal.getDb(options.journalPath);
  const positions = await getOpenPositions(options);
  const seen = new Set();

  for (const position of positions) {
    seen.add(position.ticker);
    journal.upsertPosition(db, {
      ticker: position.ticker,
      shares: position.shares,
      avgPrice: position.avgPrice,
      stopLossPrice: null,
    });
  }

  if (typeof journal.getOpenPositions === 'function') {
    const currentRows = journal.getOpenPositions(db);
    for (const row of currentRows) {
      const ticker = String(row.ticker || '').trim().toUpperCase();
      if (ticker && !seen.has(ticker)) {
        journal.closePosition(db, ticker);
      }
    }
  }

  return positions;
}

async function cancelOrder(orderId, options = {}) {
  if (String(options.broker || '').trim().toLowerCase() && String(options.broker || '').trim().toLowerCase() !== 'alpaca') {
    throw new Error('cancelOrder is currently only implemented for Alpaca');
  }

  return cancelAlpacaOrder(orderId, options);
}

async function cancelAlpacaOrder(orderId, options = {}) {
  const client = createAlpacaClient(options);
  await client.cancelOrder(orderId);
  return { ok: true, orderId };
}

async function liquidateAllPositions(options = {}) {
  const brokerTypes = resolveBrokerTypes(options);
  const results = await Promise.all(brokerTypes.map((brokerType) => {
    if (brokerType === 'alpaca') {
      return liquidateAllAlpacaPositions({ ...options, broker: brokerType });
    }
    return liquidateBrokerPositions(brokerType, options);
  }));

  return {
    ok: results.every((result) => result?.ok !== false),
    mode: brokerTypes.length > 1 ? 'multi-broker' : (results[0]?.mode || brokerTypes[0] || 'none'),
    results,
  };
}

async function liquidateAllAlpacaPositions(options = {}) {
  const client = createAlpacaClient(options);
  if (typeof client.closeAllPositions === 'function') {
    await client.closeAllPositions();
    return { ok: true, mode: 'closeAllPositions' };
  }

  const positions = await getAlpacaOpenPositions(options);
  const orders = [];
  for (const position of positions) {
    const order = await client.createOrder({
      symbol: position.ticker,
      qty: toPositiveInteger(position.shares),
      side: 'sell',
      type: 'market',
      time_in_force: 'day',
      client_order_id: generateClientOrderId('liq'),
    });
    orders.push(normalizeOrder(order));
  }

  return {
    ok: true,
    mode: 'manual',
    orders,
  };
}

async function liquidateBrokerPositions(brokerType, options = {}) {
  const broker = getBrokerAdapter(brokerType);
  const positions = await broker.getPositions({ ...options, broker: brokerType });
  const orders = [];

  for (const position of positions) {
    const orderResult = await broker.submitOrder({
      ticker: position.ticker,
      exchange: position.exchange,
      broker: brokerType,
      direction: 'SELL',
      shares: toPositiveInteger(position.shares),
      orderType: 'market',
    }, { ...options, broker: brokerType, recordJournal: false });
    orders.push(orderResult);
  }

  return {
    ok: true,
    mode: `manual-${brokerType}`,
    orders,
  };
}

function resolveBrokerType(input = {}, options = {}) {
  const explicit = String(options.broker || input.broker || '').trim().toLowerCase();
  if (explicit) return explicit;
  const ticker = String(input.ticker || input.symbol || '').trim().toUpperCase();
  return ticker ? watchlist.getBrokerForTicker(ticker, 'alpaca') : 'alpaca';
}

function resolveBrokerTypes(options = {}) {
  const explicit = String(options.broker || '').trim().toLowerCase();
  if (explicit) return [explicit];

  const symbols = Array.isArray(options.symbols) ? options.symbols : [];
  if (symbols.length > 0) {
    return Array.from(new Set(symbols.map((ticker) => watchlist.getBrokerForTicker(ticker, 'alpaca'))));
  }

  const brokers = watchlist.getWatchlist().map((entry) => entry.broker || 'alpaca');
  return Array.from(new Set(brokers.length > 0 ? brokers : ['alpaca']));
}

function getBrokerAdapter(brokerType) {
  const { createBroker } = require('./broker-adapter');
  return createBroker(brokerType);
}

function mergeAccountSnapshots(accounts = []) {
  return accounts.reduce((summary, account) => {
    if (!account) return summary;
    summary.id = summary.id || account.id || null;
    summary.status = summary.status || account.status || null;
    summary.equity += Number(account.equity || 0) || 0;
    summary.cash += Number(account.cash || 0) || 0;
    summary.buyingPower += Number(account.buyingPower || 0) || 0;
    summary.daytradeCount += Number(account.daytradeCount || 0) || 0;
    summary.patternDayTrader = summary.patternDayTrader || Boolean(account.patternDayTrader);
    summary.raw.push(account.raw || account);
    return summary;
  }, {
    id: null,
    status: null,
    equity: 0,
    cash: 0,
    buyingPower: 0,
    daytradeCount: 0,
    patternDayTrader: false,
    raw: [],
  });
}

function recordTradeSubmission(result, input = {}, options = {}) {
  const db = options.journalDb || journal.getDb(options.journalPath);
  journal.recordTrade(db, {
    ticker: String(input.ticker || input.symbol || '').trim().toUpperCase(),
    direction: String(input.direction || '').trim().toUpperCase(),
    shares: toPositiveInteger(input.shares || input.qty),
    price: Number(result?.order?.filledAvgPrice || input.referencePrice || input.price || 0) || 0,
    stopLossPrice: Number(input.stopLossPrice || 0) || null,
    consensusDetail: input.consensusDetail || null,
    riskCheckDetail: input.riskCheckDetail || null,
    status: String(result?.status || 'PENDING').trim().toUpperCase(),
    alpacaOrderId: result?.order?.id != null ? String(result.order.id) : null,
    notes: input.notes || null,
  });
}

module.exports = {
  buildOrderPayload,
  normalizeAccount,
  normalizePosition,
  normalizeOrder,
  submitAlpacaOrder,
  submitOrder,
  executeConsensusTrade,
  getAlpacaAccountSnapshot,
  getAccountSnapshot,
  getAlpacaOpenPositions,
  getOpenPositions,
  syncJournalPositions,
  cancelAlpacaOrder,
  cancelOrder,
  liquidateAllAlpacaPositions,
  liquidateAllPositions,
};
