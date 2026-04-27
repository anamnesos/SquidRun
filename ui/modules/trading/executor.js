'use strict';

const crypto = require('crypto');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const { getProjectRoot } = require('../../config');
const { checkTrade, checkKillSwitch, checkDailyPause, DEFAULT_LIMITS } = require('./risk-engine');
const hyperliquidClient = require('./hyperliquid-client');
const journal = require('./journal');
const watchlist = require('./watchlist');
const { normalizeSignalDirection } = require('./crisis-mode');

const execFileAsync = promisify(execFile);
const DEFAULT_HYPERLIQUID_SCALP_LEVERAGE = 20;

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
  return toPositiveInteger(numeric);
}

function roundPrice(value, assetClass = 'us_equity') {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  const normalizedAssetClass = watchlist.normalizeAssetClass(assetClass);
  const decimals = normalizedAssetClass === 'crypto'
    ? 6
    : 2;
  return Number(numeric.toFixed(decimals));
}

function normalizeDirection(value) {
  const normalized = normalizeSignalDirection(value);
  if (normalized === 'BUY' || normalized === 'SELL' || normalized === 'HOLD' || normalized === 'SHORT' || normalized === 'COVER' || normalized === 'BUY_PUT') {
    return normalized;
  }
  throw new Error(`Unsupported trade direction: ${value}`);
}

function normalizeJournalDirection(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (normalized === 'LONG') return 'BUY';
  return normalizeDirection(normalized);
}

function resolveAssetClass(input = {}, options = {}) {
  const explicit = input.assetClass || input.asset_class || options.assetClass || options.asset_class;
  if (explicit) return watchlist.normalizeAssetClass(explicit);
  const ticker = String(input.ticker || input.symbol || '').trim().toUpperCase();
  return ticker ? watchlist.getAssetClassForTicker(ticker, 'us_equity') : 'us_equity';
}

function isHyperliquidCryptoTrade(input = {}, options = {}, assetClass = resolveAssetClass(input, options)) {
  return assetClass === 'crypto' && resolveBrokerType(input, options) === 'hyperliquid';
}

function normalizeHyperliquidExecutionDirection(direction, input = {}, options = {}, assetClass = resolveAssetClass(input, options)) {
  if (!isHyperliquidCryptoTrade(input, options, assetClass)) {
    return direction;
  }
  return direction;
}

function generateClientOrderId(prefix = 'sq') {
  const suffix = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().slice(0, 12)
    : Math.random().toString(36).slice(2, 14);
  return `${prefix}-${suffix}`;
}

function resolveProjectRootPath() {
  return path.resolve(String(getProjectRoot() || process.cwd()));
}

function resolveHyperliquidExecuteScriptPath(options = {}) {
  return path.resolve(String(
    options.hyperliquidExecuteScriptPath
    || path.join(resolveProjectRootPath(), 'ui', 'scripts', 'hm-defi-execute.js')
  ));
}

function resolveHyperliquidCloseScriptPath(options = {}) {
  return path.resolve(String(
    options.hyperliquidCloseScriptPath
    || path.join(resolveProjectRootPath(), 'ui', 'scripts', 'hm-defi-close.js')
  ));
}

function isHyperliquidScalpModeArmed(options = {}) {
  if (options.hyperliquidScalpModeArmed === true) return true;
  if (options.allowHyperliquidLiveExecution === true) return true;
  return String(options.hyperliquidExecutionEnv?.SQUIDRUN_HYPERLIQUID_SCALP_MODE || process.env.SQUIDRUN_HYPERLIQUID_SCALP_MODE || '').trim() === '1';
}

function resolveHyperliquidLeverage(input = {}, options = {}) {
  const candidates = [
    input.leverage,
    input.riskCheckDetail?.leverage,
    options.hyperliquidExecutionLeverage,
    options.hyperliquidExecutionEnv?.SQUIDRUN_HYPERLIQUID_DEFAULT_LEVERAGE,
    isHyperliquidScalpModeArmed(options) ? DEFAULT_HYPERLIQUID_SCALP_LEVERAGE : null,
  ];
  for (const candidate of candidates) {
    const numeric = Math.floor(Number(candidate));
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric;
    }
  }
  return isHyperliquidScalpModeArmed(options) ? DEFAULT_HYPERLIQUID_SCALP_LEVERAGE : 5;
}

function resolveHyperliquidMargin(input = {}, leverage = 0, options = {}) {
  const explicit = Number(input.margin ?? input.riskCheckDetail?.margin ?? 0) || 0;
  if (explicit > 0) {
    return Number(explicit.toFixed(6));
  }
  const referencePrice = Number(input.referencePrice || input.price || 0) || 0;
  const quantity = toPositiveQuantity(input.shares || input.qty, resolveAssetClass(input, options));
  const normalizedLeverage = Math.max(1, Math.floor(Number(leverage) || 0));
  if (referencePrice <= 0 || quantity <= 0 || normalizedLeverage <= 0) {
    return null;
  }
  return Number(((referencePrice * quantity) / normalizedLeverage).toFixed(6));
}

function toCliNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return String(Number(numeric.toFixed(6)));
}

function buildHyperliquidScriptArgs(input = {}, options = {}) {
  const assetClass = resolveAssetClass(input, options);
  const direction = normalizeHyperliquidExecutionDirection(normalizeDirection(input.direction), input, options, assetClass);
  const ticker = String(input.ticker || input.symbol || '').trim().toUpperCase();
  if (!ticker) {
    throw new Error('ticker is required');
  }
  const asset = ticker.includes('/') ? ticker.split('/')[0] : ticker;
  const leverage = resolveHyperliquidLeverage(input, options);
  const margin = resolveHyperliquidMargin(input, leverage, options);
  if (!margin) {
    throw new Error('Hyperliquid live execution requires margin or risk-sized notional');
  }

  const args = options.dryRun === true
    ? ['--dry-run', 'trade', '--asset', asset, '--direction', direction]
    : ['trade', '--asset', asset, '--direction', direction];

  args.push('--leverage', String(leverage));
  args.push('--margin', toCliNumber(margin));

  const confidence = Number(
    input.confidence
    ?? input.signalConfidence
    ?? input.consensusDetail?.confidence
    ?? input.consensus?.confidence
    ?? 0
  ) || 0;
  if (confidence > 0) {
    args.push('--confidence', String(Math.max(0.5, Math.min(0.99, confidence))));
  }

  const stopLossPrice = Number(input.stopLossPrice ?? input.riskCheckDetail?.stopLossPrice ?? 0) || 0;
  const takeProfitPrice = Number(input.takeProfitPrice ?? input.riskCheckDetail?.takeProfitPrice ?? 0) || 0;
  if (stopLossPrice > 0) {
    args.push('--stop-loss', toCliNumber(stopLossPrice));
  }
  if (takeProfitPrice > 0) {
    args.push('--take-profit', toCliNumber(takeProfitPrice));
  }

  const maxNotional = Number(input.maxNotional ?? input.riskCheckDetail?.positionNotional ?? 0) || 0;
  if (maxNotional > 0) {
    args.push('--max-notional', toCliNumber(maxNotional));
  }

  const clientOrderId = String(
    input.clientOrderId
    || input.consensusDetail?.clientOrderId
    || input.consensus?.clientOrderId
    || generateClientOrderId('hl')
  ).trim();
  if (clientOrderId) {
    args.push('--client-order-id', clientOrderId);
  }

  return {
    asset,
    direction,
    leverage,
    margin,
    args,
  };
}

function normalizeTickerKey(value) {
  return String(value || '').replace(/[\/\-]/g, '').trim().toUpperCase();
}

function normalizePositionSide(value) {
  return String(value || '').trim().toLowerCase();
}

function findMatchingHyperliquidPosition(positions = [], ticker = '') {
  const tickerKey = normalizeTickerKey(ticker);
  return positions.find((position) => normalizeTickerKey(position?.ticker || position?.symbol || position?.coin) === tickerKey) || null;
}

async function resolveHyperliquidPositionContext(input = {}, options = {}) {
  const candidateCollections = [
    options.hyperliquidOpenPositions,
    input.hyperliquidOpenPositions,
    input.account?.openPositions,
    options.account?.openPositions,
  ];
  const ticker = String(input.ticker || input.symbol || '').trim().toUpperCase();
  let sawExplicitCandidateCollection = false;
  for (const candidate of candidateCollections) {
    if (!Array.isArray(candidate)) continue;
    sawExplicitCandidateCollection = true;
    const match = findMatchingHyperliquidPosition(candidate, ticker);
    if (match) return match;
  }
  if (sawExplicitCandidateCollection) {
    return null;
  }
  const positions = await hyperliquidClient.getOpenPositions(options);
  return findMatchingHyperliquidPosition(positions, ticker);
}

function shouldRouteHyperliquidClose(direction, position = null) {
  if (!position) return false;
  const side = normalizePositionSide(position.side);
  return (direction === 'SELL' && side === 'long') || ((direction === 'BUY' || direction === 'COVER') && side === 'short');
}

function mayNeedHyperliquidPositionLookup(direction) {
  return direction === 'SELL' || direction === 'BUY' || direction === 'COVER';
}

function buildHyperliquidCloseScriptArgs(input = {}, position = null, options = {}) {
  const ticker = String(input.ticker || input.symbol || '').trim().toUpperCase();
  if (!ticker) {
    throw new Error('ticker is required');
  }
  const asset = ticker.includes('/') ? ticker.split('/')[0] : ticker;
  const requestedSize = toPositiveQuantity(
    input.shares || input.qty || position?.shares || position?.size,
    'crypto'
  );
  if (requestedSize <= 0) {
    throw new Error('Hyperliquid close execution requires a positive size');
  }
  const args = options.dryRun === true
    ? ['--dry-run', '--asset', asset, '--size', toCliNumber(requestedSize)]
    : ['--asset', asset, '--size', toCliNumber(requestedSize)];
  return {
    asset,
    closeSize: requestedSize,
    args,
  };
}

async function runHyperliquidScript(scriptPath, args = [], options = {}) {
  try {
    const { stdout = '', stderr = '' } = await execFileAsync(process.execPath, [scriptPath, ...args], {
      cwd: resolveProjectRootPath(),
      windowsHide: true,
      timeout: Math.max(1_000, Number(options.hyperliquidExecutionTimeoutMs || 120_000) || 120_000),
      env: options.hyperliquidExecutionEnv || process.env,
    });
    return {
      ok: true,
      status: options.dryRun === true ? 'dry_run' : 'accepted',
      stdout,
      stderr,
    };
  } catch (error) {
    return {
      ok: false,
      status: 'rejected',
      error: error?.message || String(error),
      stdout: error?.stdout || '',
      stderr: error?.stderr || '',
    };
  }
}

async function submitHyperliquidOrder(input = {}, options = {}) {
  const armed = isHyperliquidScalpModeArmed(options);
  if (options.dryRun !== true && armed !== true) {
    throw new Error('Hyperliquid live execution is blocked until scalp mode is explicitly armed.');
  }

  const normalizedDirection = normalizeDirection(input.direction);
  const positionContext = mayNeedHyperliquidPositionLookup(normalizedDirection)
    ? await resolveHyperliquidPositionContext(input, options)
    : null;

  let asset;
  let direction;
  let leverage = null;
  let margin = null;
  let args;
  let scriptPath;
  let closingPosition = false;

  if (shouldRouteHyperliquidClose(normalizedDirection, positionContext)) {
    const closeArgs = buildHyperliquidCloseScriptArgs(input, positionContext, options);
    asset = closeArgs.asset;
    direction = normalizedDirection === 'SELL' ? 'SELL' : 'BUY';
    args = closeArgs.args;
    scriptPath = resolveHyperliquidCloseScriptPath(options);
    closingPosition = true;
  } else {
    const openInput = normalizedDirection === 'SELL'
      ? { ...input, direction: 'SHORT' }
      : input;
    const openArgs = buildHyperliquidScriptArgs(openInput, options);
    asset = openArgs.asset;
    direction = openArgs.direction;
    leverage = openArgs.leverage;
    margin = openArgs.margin;
    args = openArgs.args;
    scriptPath = resolveHyperliquidExecuteScriptPath(options);
  }
  const result = await runHyperliquidScript(scriptPath, args, options);

  return {
    ...result,
    broker: 'hyperliquid',
    order: result.ok
      ? {
        id: input.clientOrderId || null,
        symbol: String(input.ticker || input.symbol || '').trim().toUpperCase(),
        side: direction === 'SHORT' || direction === 'SELL' ? 'sell' : 'buy',
        qty: toPositiveQuantity(input.shares || input.qty, 'crypto'),
        type: input.orderType || 'market',
      }
      : null,
    payload: {
      asset,
      direction,
      leverage,
      margin,
      closingPosition,
      args,
      scriptPath,
    },
  };
}

function buildHyperliquidDryRunPayload(input = {}, options = {}) {
  const assetClass = resolveAssetClass(input, options);
  const direction = normalizeHyperliquidExecutionDirection(normalizeDirection(input.direction), input, options, assetClass);
  const quantity = toPositiveQuantity(input.shares || input.qty, assetClass);
  if (quantity <= 0) {
    throw new Error('Hyperliquid order quantity must be positive');
  }
  const ticker = String(input.ticker || input.symbol || '').trim().toUpperCase();
  if (!ticker) {
    throw new Error('ticker is required');
  }
  const isShort = direction === 'SHORT';
  return {
    symbol: ticker,
    qty: quantity,
    side: isShort ? 'sell' : 'buy',
    type: input.orderType || 'market',
    time_in_force: input.timeInForce || 'ioc',
    broker: 'hyperliquid',
    asset_class: assetClass,
    direction,
    position_effect: isShort ? 'open_short' : 'open_long',
    reduce_only: direction === 'COVER',
    reference_price: roundPrice(input.referencePrice || input.price || 0, assetClass),
    stop_loss_price: roundPrice(input.stopLossPrice, assetClass),
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
  const broker = getBrokerAdapter(brokerType);
  const result = await broker.submitOrder({ ...input, broker: brokerType }, { ...options, broker: brokerType });
  if (options.recordJournal !== false) {
    recordTradeSubmission(result, input, options);
  }
  return result;
}

async function executeConsensusTrade(input = {}, options = {}) {
  const consensus = input.consensus || {};
  const assetClass = resolveAssetClass({
    ticker: consensus.ticker || input.ticker,
    assetClass: input.assetClass || input.asset_class,
  }, options);
  const brokerType = resolveBrokerType({
    ...input,
    ticker: consensus.ticker || input.ticker,
  }, options);
  const direction = normalizeDirection(consensus.decision || input.direction || 'HOLD');
  const executionDirection = normalizeHyperliquidExecutionDirection(direction, {
    ...input,
    ticker: consensus.ticker || input.ticker,
    assetClass,
    broker: brokerType,
  }, {
    ...options,
    broker: brokerType,
  }, assetClass);
  if (!consensus.consensus || direction === 'HOLD') {
    return {
      ok: false,
      status: 'no_action',
      reason: 'Consensus did not authorize a BUY/SELL trade',
    };
  }

  const allowHyperliquidShortExecution = brokerType === 'hyperliquid' && assetClass === 'crypto' && executionDirection === 'SHORT';
  if ((executionDirection === 'SHORT' && !allowHyperliquidShortExecution) || executionDirection === 'COVER' || executionDirection === 'BUY_PUT') {
    return {
      ok: false,
      status: 'rejected',
      reason: `${executionDirection} execution is not enabled until crisis mode phase 2`,
    };
  }

  const trade = {
    ticker: consensus.ticker || input.ticker,
    direction,
    price: Number(input.price || input.referencePrice || 0) || 0,
    marketCap: input.marketCap ?? null,
    assetClass,
    broker: brokerType,
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
  if (direction === 'SELL' && !(brokerType === 'hyperliquid' && assetClass === 'crypto')) {
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

  if (brokerType === 'hyperliquid') {
    return submitOrder({
      ticker: trade.ticker,
      direction: executionDirection,
      shares,
      account,
      hyperliquidOpenPositions: account.openPositions,
      assetClass: trade.assetClass,
      referencePrice: trade.price,
      stopLossPrice: input.riskCheckDetail?.stopLossPrice ?? riskCheck.stopLossPrice,
      takeProfitPrice: input.riskCheckDetail?.takeProfitPrice ?? riskCheck.takeProfitPrice,
      leverage: input.riskCheckDetail?.leverage ?? riskCheck.leverage ?? null,
      margin: input.riskCheckDetail?.margin ?? riskCheck.margin ?? null,
      maxNotional: input.riskCheckDetail?.positionNotional ?? riskCheck.positionNotional ?? null,
      clientOrderId: input.clientOrderId || null,
      consensusDetail: input.consensusDetail || consensus,
      riskCheckDetail: input.riskCheckDetail || riskCheck,
      notes: input.notes || null,
      broker: brokerType,
    }, options);
  }

  return submitOrder({
    ticker: trade.ticker,
    direction: executionDirection,
    shares,
    assetClass: trade.assetClass,
    stopLossPrice: riskCheck.stopLossPrice,
    referencePrice: trade.price,
    consensusDetail: input.consensusDetail || consensus,
    riskCheckDetail: input.riskCheckDetail || riskCheck,
    notes: input.notes || null,
    broker: brokerType,
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

async function getOpenPositions(options = {}) {
  const brokerTypes = resolveBrokerTypes(options);
  const positions = await Promise.all(brokerTypes.map((brokerType) => {
    return getBrokerAdapter(brokerType).getPositions({ ...options, broker: brokerType });
  }));
  return positions.flat();
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

async function liquidateAllPositions(options = {}) {
  const brokerTypes = resolveBrokerTypes(options);
  const results = await Promise.all(brokerTypes.map((brokerType) => {
    return liquidateBrokerPositions(brokerType, options);
  }));

  return {
    ok: results.every((result) => result?.ok !== false),
    mode: brokerTypes.length > 1 ? 'multi-broker' : (results[0]?.mode || brokerTypes[0] || 'none'),
    results,
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
  if (ticker.endsWith('/USD')) {
    return watchlist.getBrokerForTicker(ticker, 'hyperliquid');
  }
  return ticker ? watchlist.getBrokerForTicker(ticker, 'ibkr') : 'ibkr';
}

function resolveBrokerTypes(options = {}) {
  const explicit = String(options.broker || '').trim().toLowerCase();
  if (explicit) return [explicit];

  const symbols = Array.isArray(options.symbols) ? options.symbols : [];
  if (symbols.length > 0) {
    return Array.from(new Set(symbols.map((ticker) => watchlist.getBrokerForTicker(ticker, 'ibkr'))));
  }

  const brokers = watchlist.getWatchlist({ includeAll: true }).map((entry) => entry.broker || 'ibkr');
  return Array.from(new Set(brokers.length > 0 ? brokers : ['ibkr']));
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
  const journalResult = journal.recordTrade(db, {
    ticker: String(input.ticker || input.symbol || '').trim().toUpperCase(),
    direction: normalizeJournalDirection(input.direction || 'BUY'),
    shares: toPositiveQuantity(input.shares || input.qty, resolveAssetClass(input, options)),
    price: Number(result?.order?.filledAvgPrice || input.referencePrice || input.price || 0) || 0,
    stopLossPrice: Number(input.stopLossPrice || 0) || null,
    consensusDetail: input.consensusDetail || null,
    riskCheckDetail: input.riskCheckDetail || null,
    status: String(result?.status || 'PENDING').trim().toUpperCase(),
    brokerOrderId: result?.order?.id != null ? String(result.order.id) : (result?.orderId != null ? String(result.orderId) : null),
    notes: input.notes || null,
  });
  return Number(journalResult?.lastInsertRowid || 0) || null;
}

module.exports = {
  buildHyperliquidDryRunPayload,
  normalizeOrder,
  submitHyperliquidOrder,
  submitOrder,
  executeConsensusTrade,
  getAccountSnapshot,
  getOpenPositions,
  syncJournalPositions,
  liquidateAllPositions,
};
