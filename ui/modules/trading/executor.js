'use strict';

const crypto = require('crypto');

const { createAlpacaClient } = require('./data-ingestion');
const { checkTrade, checkKillSwitch, checkDailyPause, DEFAULT_LIMITS } = require('./risk-engine');
const journal = require('./journal');
const polymarketClient = require('./polymarket-client');
const watchlist = require('./watchlist');
const { normalizeSignalDirection } = require('./crisis-mode');

function toPositiveInteger(value) {
  const numeric = Math.floor(Number(value));
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

function toPositiveQuantity(value, assetClass = 'us_equity') {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  const normalizedAssetClass = watchlist.normalizeAssetClass(assetClass);
  if (normalizedAssetClass === 'crypto') {
    // Truncate (floor) to 6 decimals — never round up to avoid exceeding available balance
    const factor = 1e6;
    return Math.floor(numeric * factor) / factor;
  }
  if (normalizedAssetClass === 'prediction_market') {
    const factor = 1e4;
    return Math.floor(numeric * factor) / factor;
  }
  return toPositiveInteger(numeric);
}

function roundPrice(value, assetClass = 'us_equity') {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  const normalizedAssetClass = watchlist.normalizeAssetClass(assetClass);
  const decimals = normalizedAssetClass === 'crypto'
    ? 6
    : (normalizedAssetClass === 'prediction_market' ? 4 : 2);
  return Number(numeric.toFixed(decimals));
}

function normalizeDirection(value, options = {}) {
  const normalized = normalizeSignalDirection(value, { allowPolymarket: options.allowPolymarket === true });
  if (normalized === 'BUY' || normalized === 'SELL' || normalized === 'HOLD' || normalized === 'SHORT' || normalized === 'COVER' || normalized === 'BUY_PUT') {
    return normalized;
  }
  if (options.allowPolymarket === true && (normalized === 'BUY_YES' || normalized === 'BUY_NO')) {
    return normalized;
  }
  throw new Error(`Unsupported trade direction: ${value}`);
}

function normalizeJournalDirection(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (normalized === 'BUY_YES') return 'BUY';
  if (normalized === 'BUY_NO') return 'SELL';
  return normalizeDirection(normalized);
}

function resolveAssetClass(input = {}, options = {}) {
  const explicit = input.assetClass || input.asset_class || options.assetClass || options.asset_class;
  if (explicit) return watchlist.normalizeAssetClass(explicit);
  const ticker = String(input.ticker || input.symbol || '').trim().toUpperCase();
  return ticker ? watchlist.getAssetClassForTicker(ticker, 'us_equity') : 'us_equity';
}

function generateClientOrderId(prefix = 'sq') {
  const suffix = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().slice(0, 12)
    : Math.random().toString(36).slice(2, 14);
  return `${prefix}-${suffix}`;
}

function buildOrderPayload(input = {}) {
  const direction = normalizeDirection(input.direction);
  const assetClass = resolveAssetClass(input);
  const quantity = toPositiveQuantity(input.shares || input.qty, assetClass);
  if (direction === 'HOLD') {
    throw new Error('Cannot build an order payload for HOLD');
  }
  if (direction === 'SHORT' || direction === 'COVER' || direction === 'BUY_PUT') {
    throw new Error(`Order payload for ${direction} is not available until crisis mode phase 2`);
  }
  if (quantity <= 0) {
    const quantityLabel = assetClass === 'crypto' ? 'a positive crypto quantity' : 'at least 1 whole share';
    throw new Error(`Order quantity must be ${quantityLabel}`);
  }
  if (assetClass !== 'crypto' && quantity < 1) {
    throw new Error('Order quantity must be at least 1 whole share');
  }

  // Alpaca requires minimum $10 notional value for crypto orders
  const MIN_CRYPTO_NOTIONAL = 10;
  const referencePrice = Number(input.referencePrice || input.price || 0) || 0;
  if (assetClass === 'crypto' && referencePrice > 0 && quantity * referencePrice < MIN_CRYPTO_NOTIONAL) {
    throw new Error(`Order notional $${(quantity * referencePrice).toFixed(2)} below Alpaca minimum $${MIN_CRYPTO_NOTIONAL}`);
  }

  const payload = {
    symbol: String(input.ticker || input.symbol || '').trim().toUpperCase(),
    qty: quantity,
    side: direction === 'BUY' ? 'buy' : 'sell',
    type: input.orderType || 'market',
    time_in_force: input.timeInForce || (assetClass === 'crypto' ? 'gtc' : 'day'),
    client_order_id: input.clientOrderId || generateClientOrderId('trade'),
  };

  if (!payload.symbol) {
    throw new Error('ticker is required');
  }

  if (assetClass !== 'crypto' && direction === 'BUY' && Number(input.stopLossPrice) > 0) {
    payload.order_class = 'bracket';
    payload.stop_loss = {
      stop_price: roundPrice(input.stopLossPrice, assetClass),
    };
  }

  if (input.limitPrice != null) {
    payload.limit_price = roundPrice(input.limitPrice, assetClass);
  }

  if (input.extendedHours === true) {
    payload.extended_hours = true;
  }

  return payload;
}

function resolvePolymarketTokenId(input = {}, direction = 'BUY_YES') {
  const explicit = String(input.tokenId || input.assetId || '').trim();
  if (explicit) return explicit;

  if (direction === 'BUY_YES') {
    return String(input.yesTokenId || input.tokens?.yes || '').trim();
  }
  if (direction === 'BUY_NO') {
    return String(input.noTokenId || input.tokens?.no || '').trim();
  }
  return String(input.tokenId || '').trim();
}

function resolvePolymarketPrice(input = {}, direction = 'BUY_YES') {
  const candidates = direction === 'BUY_NO'
    ? [input.noPrice, input.currentPrices?.no, input.limitPrice, input.price, input.referencePrice]
    : [input.yesPrice, input.currentPrices?.yes, input.limitPrice, input.price, input.referencePrice];
  for (const candidate of candidates) {
    const price = roundPrice(candidate, 'prediction_market');
    if (price != null && price > 0) return price;
  }
  return null;
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
  const ticker = String(position.symbol || position.ticker || '').trim().toUpperCase();
  return {
    ticker,
    shares: Number(position.qty || position.shares || 0) || 0,
    avgPrice: Number(position.avg_entry_price || position.avgPrice || 0) || 0,
    marketValue: Number(position.market_value || position.marketValue || 0) || 0,
    side: position.side || 'long',
    assetClass: resolveAssetClass({ ticker, assetClass: position.asset_class || position.assetClass }),
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
  if (brokerType === 'polymarket') {
    return submitPolymarketOrder(input, options);
  }
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

async function submitPolymarketOrder(input = {}, options = {}) {
  const direction = normalizeDirection(input.direction, { allowPolymarket: true });
  const tokenId = resolvePolymarketTokenId(input, direction);
  const quantity = toPositiveQuantity(input.shares || input.qty, 'prediction_market');
  const price = resolvePolymarketPrice(input, direction);
  const side = direction === 'SELL' ? 'SELL' : 'BUY';

  if (!tokenId) {
    throw new Error('Polymarket orders require a tokenId');
  }
  if (quantity <= 0) {
    throw new Error('Polymarket order size must be positive');
  }
  if (price == null || price <= 0) {
    throw new Error('Polymarket order price must be positive');
  }

  const rawOrder = await polymarketClient.createOrder(tokenId, side, price, quantity, options);
  const order = {
    id: rawOrder?.orderId || null,
    clientOrderId: null,
    status: rawOrder?.status || null,
    symbol: String(input.ticker || input.conditionId || tokenId).trim().toUpperCase(),
    side: side.toLowerCase(),
    qty: quantity,
    filledQty: 0,
    filledAvgPrice: price,
    type: 'limit',
    tokenId,
    raw: rawOrder?.raw || rawOrder,
  };
  const result = {
    ok: true,
    status: rawOrder?.status || 'accepted',
    payload: {
      tokenId,
      size: quantity,
      price,
      side,
      direction,
      ticker: input.ticker || input.conditionId || null,
    },
    order,
    orderId: rawOrder?.orderId || null,
  };

  if (options.recordJournal !== false) {
    recordTradeSubmission(result, input, options);
  }

  return result;
}

async function executePredictionMarketConsensusTrade(input = {}, options = {}) {
  const consensus = input.consensus || {};
  const direction = normalizeDirection(consensus.decision || input.direction || 'HOLD', { allowPolymarket: true });
  if (!consensus.consensus || direction === 'HOLD') {
    return {
      ok: false,
      status: 'no_action',
      reason: 'Consensus did not authorize a Polymarket trade',
    };
  }

  const account = input.account || {};
  const limits = input.limits || DEFAULT_LIMITS;
  const killSwitch = checkKillSwitch(account, limits);
  if (killSwitch.triggered) {
    return {
      ok: false,
      status: 'rejected',
      reason: 'Kill switch triggered',
      riskCheck: killSwitch,
    };
  }

  const dailyPause = checkDailyPause(account, limits);
  if (dailyPause.paused) {
    return {
      ok: false,
      status: 'rejected',
      reason: 'Daily pause active',
      riskCheck: dailyPause,
    };
  }

  const shares = toPositiveQuantity(input.requestedShares || input.shares || input.qty, 'prediction_market');
  if (shares <= 0) {
    return {
      ok: false,
      status: 'rejected',
      reason: 'Polymarket sizing did not produce an executable quantity',
    };
  }

  return submitOrder({
    ticker: input.ticker || consensus.ticker || consensus.conditionId,
    conditionId: input.conditionId || consensus.conditionId || input.ticker || consensus.ticker,
    direction,
    shares,
    broker: 'polymarket',
    assetClass: 'prediction_market',
    tokenId: input.tokenId,
    yesTokenId: input.yesTokenId || consensus.market?.tokens?.yes,
    noTokenId: input.noTokenId || consensus.market?.tokens?.no,
    currentPrices: input.currentPrices || consensus.market?.currentPrices,
    yesPrice: input.yesPrice,
    noPrice: input.noPrice,
    referencePrice: input.referencePrice || input.price,
    price: input.price || input.referencePrice,
    consensusDetail: consensus,
    riskCheckDetail: {
      killSwitch,
      dailyPause,
      requestedShares: shares,
    },
    notes: input.notes || null,
  }, options);
}

async function executeConsensusTrade(input = {}, options = {}) {
  const consensus = input.consensus || {};
  const assetClass = resolveAssetClass({
    ticker: consensus.ticker || input.ticker,
    assetClass: input.assetClass || input.asset_class,
  }, options);
  const direction = normalizeDirection(consensus.decision || input.direction || 'HOLD', {
    allowPolymarket: assetClass === 'prediction_market'
      || String(input.broker || options.broker || '').trim().toLowerCase() === 'polymarket',
  });
  if (!consensus.consensus || direction === 'HOLD') {
    return {
      ok: false,
      status: 'no_action',
      reason: 'Consensus did not authorize a BUY/SELL trade',
    };
  }

  if (assetClass === 'prediction_market' || direction === 'BUY_YES' || direction === 'BUY_NO') {
    return executePredictionMarketConsensusTrade(input, options);
  }

  if (direction === 'SHORT' || direction === 'COVER' || direction === 'BUY_PUT') {
    return {
      ok: false,
      status: 'rejected',
      reason: `${direction} execution is not enabled until crisis mode phase 2`,
    };
  }

  const trade = {
    ticker: consensus.ticker || input.ticker,
    direction,
    price: Number(input.price || input.referencePrice || 0) || 0,
    marketCap: input.marketCap ?? null,
    assetClass,
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
    const debugInfo = {
      equity: account.equity,
      openPositionCount: account.openPositions?.length || 0,
      openTickers: (account.openPositions || []).map(p => p.ticker).join(', '),
      tradeTicker: trade.ticker,
      tradeDirection: trade.direction,
    };
    console.warn('[executor] Trade rejected at execution:', JSON.stringify(debugInfo), 'violations:', riskCheck.violations);
    return {
      ok: false,
      status: 'rejected',
      riskCheck,
    };
  }

  const quantityCap = toPositiveQuantity(riskCheck.maxShares, trade.assetClass);
  const requestedShares = toPositiveQuantity(input.requestedShares || quantityCap, trade.assetClass);
  let shares = Math.min(quantityCap, requestedShares || quantityCap);

  // For SELL orders, cap at actual broker position to avoid "insufficient balance" errors.
  // We fetch live position data because the account state may have stale quantities
  // (e.g. original order qty vs actual settled qty after fees/partial fills).
  if (direction === 'SELL') {
    const normTicker = (t) => String(t || '').replace(/[\/\-]/g, '').toUpperCase();
    try {
      const livePositions = await getOpenPositions(options);
      const livePosition = livePositions.find(p => normTicker(p.ticker) === normTicker(trade.ticker));
      if (livePosition?.shares > 0) {
        shares = Math.min(shares, toPositiveQuantity(livePosition.shares, trade.assetClass));
      }
    } catch (_) {
      // Fallback to account state if broker fetch fails
      const position = (account.openPositions || []).find(p => normTicker(p.ticker) === normTicker(trade.ticker));
      if (position?.shares > 0) {
        shares = Math.min(shares, toPositiveQuantity(position.shares, trade.assetClass));
      }
    }
  }
  if (shares <= 0) {
    return {
      ok: false,
      status: 'rejected',
      reason: 'Risk engine did not allow a tradable quantity',
      riskCheck,
    };
  }

  return submitOrder({
    ticker: trade.ticker,
    direction,
    shares,
    assetClass: trade.assetClass,
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

async function getPolymarketAccountSnapshot(options = {}) {
  const [balance, positions] = await Promise.all([
    polymarketClient.getBalance(options),
    polymarketClient.getPositions(options),
  ]);
  const available = Number(balance?.available ?? balance?.balance ?? 0) || 0;
  const marketValue = Array.isArray(positions)
    ? positions.reduce((sum, position) => sum + (Number(position?.marketValue || 0) || 0), 0)
    : 0;
  return normalizeAccount({
    id: 'polymarket',
    status: 'active',
    equity: Number((available + marketValue).toFixed(2)),
    cash: Number(available.toFixed(2)),
    buying_power: Number(available.toFixed(2)),
    raw: {
      balance,
      positions,
    },
  });
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

async function getPolymarketOpenPositions(options = {}) {
  const positions = await polymarketClient.getPositions(options);
  return Array.isArray(positions)
    ? positions.map((position) => ({
      ...normalizePosition({
        ticker: position.market || position.tokenId,
        qty: position.size,
        avgPrice: position.avgEntryPrice,
        marketValue: position.marketValue,
        assetClass: 'prediction_market',
      }),
      broker: 'polymarket',
      exchange: 'POLYMARKET',
      tokenId: position.tokenId,
      market: position.market,
      outcome: position.outcome,
      unrealizedPnl: Number(position.unrealizedPnl || 0) || 0,
      realizedPnl: Number(position.realizedPnl || 0) || 0,
      raw: position.raw || position,
    }))
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
      qty: toPositiveQuantity(position.shares, position.assetClass),
      side: 'sell',
      type: 'market',
      time_in_force: position.assetClass === 'crypto' ? 'gtc' : 'day',
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
      shares: toPositiveQuantity(position.shares, position.assetClass),
      assetClass: position.assetClass,
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

  const brokers = watchlist.getWatchlist({ includeAll: true }).map((entry) => entry.broker || 'alpaca');
  return Array.from(new Set(brokers.length > 0 ? brokers : ['alpaca']));
}

function getBrokerAdapter(brokerType) {
  if (brokerType === 'polymarket') {
    return {
      type: 'polymarket',
      connect: polymarketClient.connect,
      disconnect: polymarketClient.disconnect,
      getAccount: (options = {}) => getPolymarketAccountSnapshot(options),
      getPositions: (options = {}) => getPolymarketOpenPositions(options),
      submitOrder: (input = {}, options = {}) => submitPolymarketOrder(input, options),
    };
  }
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
    direction: normalizeJournalDirection(input.direction || 'BUY'),
    shares: toPositiveQuantity(input.shares || input.qty, resolveAssetClass(input, options)),
    price: Number(result?.order?.filledAvgPrice || input.referencePrice || input.price || 0) || 0,
    stopLossPrice: Number(input.stopLossPrice || 0) || null,
    consensusDetail: input.consensusDetail || null,
    riskCheckDetail: input.riskCheckDetail || null,
    status: String(result?.status || 'PENDING').trim().toUpperCase(),
    alpacaOrderId: result?.order?.id != null ? String(result.order.id) : (result?.orderId != null ? String(result.orderId) : null),
    notes: input.notes || null,
  });
}

module.exports = {
  buildOrderPayload,
  normalizeAccount,
  normalizePosition,
  normalizeOrder,
  submitAlpacaOrder,
  submitPolymarketOrder,
  submitOrder,
  executeConsensusTrade,
  getAlpacaAccountSnapshot,
  getPolymarketAccountSnapshot,
  getAccountSnapshot,
  getAlpacaOpenPositions,
  getPolymarketOpenPositions,
  getOpenPositions,
  syncJournalPositions,
  cancelAlpacaOrder,
  cancelOrder,
  liquidateAllAlpacaPositions,
  liquidateAllPositions,
};
