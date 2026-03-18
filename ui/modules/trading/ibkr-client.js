'use strict';

const path = require('path');
const dotenv = require('dotenv');

const { getProjectRoot } = require('../../config');

let envLoaded = false;
let apiSingleton = null;

const ACCOUNT_SUMMARY_TAGS = 'NetLiquidation,TotalCashValue,BuyingPower,DayTradesRemaining';
const IBKR_CONNECT_TIMEOUT_MS = 10000;
const IBKR_REQUEST_TIMEOUT_MS = 15000;

function ensureEnvLoaded() {
  if (envLoaded) return;
  try {
    dotenv.config({ path: path.join(getProjectRoot(), '.env') });
  } catch {
    // Best effort only.
  }
  envLoaded = true;
}

function requireIbkrSdk() {
  try {
    return require('@stoqey/ib');
  } catch (err) {
    const wrapped = new Error(
      '@stoqey/ib is not installed in ui/node_modules yet. Use the Windows-safe install workflow before enabling IBKR trading.'
    );
    wrapped.code = 'IBKR_SDK_UNAVAILABLE';
    wrapped.cause = err;
    throw wrapped;
  }
}

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function toNonEmptyString(value, fallback = '') {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function resolveIbkrConfig(env = process.env) {
  ensureEnvLoaded();
  const paper = toBoolean(env.IBKR_PAPER, true);
  const portFallback = paper ? 4002 : 7496;
  const host = toNonEmptyString(env.IBKR_HOST, '127.0.0.1');
  const port = Number.parseInt(toNonEmptyString(env.IBKR_PORT, `${portFallback}`), 10) || portFallback;
  const clientId = Number.parseInt(toNonEmptyString(env.IBKR_CLIENT_ID, '17'), 10) || 17;

  return {
    host,
    port,
    clientId,
    paper,
  };
}

function normalizeTicker(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeExchange(value) {
  const raw = String(value || '').trim().toUpperCase();
  if (!raw || raw === 'SMART') return 'SMART';
  if (raw === 'HKEX') return 'SEHK';
  if (raw === 'TSE' || raw === 'JPX') return 'TSEJ';
  return raw;
}

function resolveCurrency(exchange) {
  const normalized = normalizeExchange(exchange);
  if (normalized === 'TSEJ') return 'JPY';
  if (normalized === 'SEHK') return 'HKD';
  return 'USD';
}

function getClient(options = {}) {
  if (options.client) return options.client;
  if (apiSingleton) return apiSingleton;

  const { IBApiNext } = requireIbkrSdk();
  const config = resolveIbkrConfig(options.env || process.env);
  apiSingleton = new IBApiNext({
    host: config.host,
    port: config.port,
  });
  return apiSingleton;
}

function waitForConnection(api, timeoutMs = IBKR_CONNECT_TIMEOUT_MS) {
  if (api?.isConnected) {
    return Promise.resolve(api);
  }

  return new Promise((resolve, reject) => {
    let subscription = null;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`IBKR connection timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    subscription = api.connectionState.subscribe({
      next(state) {
        const { ConnectionState } = requireIbkrSdk();
        if (state === ConnectionState.Connected) {
          cleanup();
          resolve(api);
        }
      },
      error(err) {
        cleanup();
        reject(err);
      },
    });

    function cleanup() {
      clearTimeout(timer);
      if (subscription?.unsubscribe) {
        subscription.unsubscribe();
      }
    }
  });
}

function waitForFirstValue(observable, timeoutMs = IBKR_REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let subscription = null;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`IBKR request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    subscription = observable.subscribe({
      next(value) {
        cleanup();
        resolve(value);
      },
      error(err) {
        cleanup();
        reject(err);
      },
      complete() {
        cleanup();
        resolve(undefined);
      },
    });

    function cleanup() {
      clearTimeout(timer);
      if (subscription?.unsubscribe) {
        subscription.unsubscribe();
      }
    }
  });
}

function firstMapValue(mapLike) {
  if (!mapLike || typeof mapLike.values !== 'function') return null;
  const iterator = mapLike.values();
  const next = iterator.next();
  return next.done ? null : next.value;
}

function firstMapKey(mapLike) {
  if (!mapLike || typeof mapLike.keys !== 'function') return null;
  const iterator = mapLike.keys();
  const next = iterator.next();
  return next.done ? null : next.value;
}

function getAccountSummaryNumber(tagValues, tagName, preferredCurrency = 'USD') {
  const currencyMap = tagValues?.get?.(tagName);
  if (!currencyMap || typeof currencyMap.get !== 'function') return 0;
  const preferred = currencyMap.get(preferredCurrency);
  const value = preferred || firstMapValue(currencyMap);
  return toNumber(value?.value, 0);
}

function buildStockContract(entry = {}) {
  const { Stock } = requireIbkrSdk();
  return new Stock(
    normalizeTicker(entry.ticker || entry.symbol),
    normalizeExchange(entry.exchange),
    resolveCurrency(entry.exchange)
  );
}

async function connect(options = {}) {
  const config = resolveIbkrConfig(options.env || process.env);
  const client = getClient(options);
  if (!client.isConnected) {
    client.connect(options.clientId ?? config.clientId);
    await waitForConnection(client, options.connectTimeoutMs || IBKR_CONNECT_TIMEOUT_MS);
  }
  return client;
}

async function disconnect(options = {}) {
  const client = options.client || apiSingleton;
  if (client?.isConnected) {
    client.disconnect();
  }
  return { ok: true };
}

async function getAccount(options = {}) {
  const client = await connect(options);
  const [managedAccounts, summaryUpdate] = await Promise.all([
    client.getManagedAccounts(),
    waitForFirstValue(client.getAccountSummary('All', ACCOUNT_SUMMARY_TAGS), options.timeoutMs),
  ]);
  const summaries = summaryUpdate?.all;
  const accountId = Array.isArray(managedAccounts) && managedAccounts.length > 0
    ? managedAccounts[0]
    : firstMapKey(summaries);
  const tagValues = summaries?.get?.(accountId) || firstMapValue(summaries);

  return {
    id: accountId || null,
    status: client.isConnected ? 'connected' : 'disconnected',
    equity: getAccountSummaryNumber(tagValues, 'NetLiquidation'),
    cash: getAccountSummaryNumber(tagValues, 'TotalCashValue'),
    buyingPower: getAccountSummaryNumber(tagValues, 'BuyingPower'),
    daytradeCount: getAccountSummaryNumber(tagValues, 'DayTradesRemaining'),
    patternDayTrader: false,
    broker: 'ibkr',
    raw: {
      managedAccounts,
      summaryUpdate,
    },
  };
}

async function getPositions(options = {}) {
  const client = await connect(options);
  const update = await waitForFirstValue(client.getPositions(), options.timeoutMs);
  const positionsByAccount = update?.all;
  const positions = [];

  if (positionsByAccount && typeof positionsByAccount.entries === 'function') {
    for (const [account, accountPositions] of positionsByAccount.entries()) {
      for (const position of accountPositions || []) {
        const shares = toNumber(position?.pos, 0);
        positions.push({
          ticker: normalizeTicker(position?.contract?.symbol),
          exchange: normalizeExchange(position?.contract?.exchange),
          shares: Math.abs(shares),
          avgPrice: toNumber(position?.avgCost, 0),
          marketValue: toNumber(position?.marketValue, 0),
          side: shares >= 0 ? 'long' : 'short',
          broker: 'ibkr',
          account,
          raw: position,
        });
      }
    }
  }

  return positions;
}

function buildOrder(input = {}) {
  const { LimitOrder, MarketOrder, OrderAction } = requireIbkrSdk();
  const direction = String(input.direction || '').trim().toUpperCase();
  const shares = Math.floor(toNumber(input.shares || input.qty, 0));
  if (!['BUY', 'SELL'].includes(direction)) {
    throw new Error(`Unsupported IBKR order direction: ${input.direction}`);
  }
  if (shares < 1) {
    throw new Error('IBKR order quantity must be at least 1 whole share');
  }

  const action = direction === 'BUY' ? OrderAction.BUY : OrderAction.SELL;
  if (String(input.orderType || 'market').trim().toLowerCase() === 'limit') {
    const limitPrice = toNumber(input.limitPrice, 0);
    if (limitPrice <= 0) {
      throw new Error('limitPrice is required for IBKR limit orders');
    }
    return new LimitOrder(action, limitPrice, shares, true);
  }

  return new MarketOrder(action, shares, true);
}

async function submitOrder(input = {}, options = {}) {
  const client = await connect(options);
  const managedAccounts = await client.getManagedAccounts();
  const order = buildOrder(input);
  const accountId = input.accountId || managedAccounts?.[0];
  if (accountId) {
    order.account = accountId;
  }
  const orderId = await client.placeNewOrder(
    buildStockContract({
      ticker: input.ticker || input.symbol,
      exchange: input.exchange || options.exchange,
    }),
    order
  );

  return {
    ok: true,
    status: 'submitted',
    payload: {
      symbol: normalizeTicker(input.ticker || input.symbol),
      qty: Math.floor(toNumber(input.shares || input.qty, 0)),
      side: String(input.direction || '').trim().toUpperCase(),
      type: String(input.orderType || 'market').trim().toLowerCase(),
      broker: 'ibkr',
    },
    order: {
      id: orderId,
      clientOrderId: null,
      status: 'submitted',
      symbol: normalizeTicker(input.ticker || input.symbol),
      side: String(input.direction || '').trim().toUpperCase(),
      qty: Math.floor(toNumber(input.shares || input.qty, 0)),
      filledQty: 0,
      filledAvgPrice: null,
      type: String(input.orderType || 'market').trim().toLowerCase(),
      broker: 'ibkr',
      raw: {
        account: managedAccounts?.[0] || null,
        orderId,
      },
    },
  };
}

function extractTickValue(snapshot, ...tickTypes) {
  for (const tickType of tickTypes) {
    const entry = snapshot?.get?.(tickType);
    const numeric = toNumber(entry?.value, null);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

async function getSnapshots(options = {}) {
  const client = await connect(options);
  const symbols = Array.isArray(options.symbols) ? options.symbols : [];
  const entries = Array.isArray(options.watchlistEntries) && options.watchlistEntries.length > 0
    ? options.watchlistEntries
    : symbols.map((ticker) => ({ ticker, exchange: options.exchange }));
  const { TickType } = requireIbkrSdk();

  const snapshots = await Promise.all(entries.map(async (entry) => {
    const symbol = normalizeTicker(entry.ticker || entry.symbol);
    const snapshot = await client.getMarketDataSnapshot(buildStockContract(entry), '221,233', false);
    return [
      symbol,
      {
        symbol,
        tradePrice: extractTickValue(snapshot, TickType.LAST, TickType.DELAYED_LAST, TickType.MARK_PRICE),
        bidPrice: extractTickValue(snapshot, TickType.BID, TickType.DELAYED_BID),
        askPrice: extractTickValue(snapshot, TickType.ASK, TickType.DELAYED_ASK),
        minuteClose: extractTickValue(snapshot, TickType.LAST, TickType.DELAYED_LAST),
        dailyClose: extractTickValue(snapshot, TickType.CLOSE, TickType.DELAYED_CLOSE),
        previousClose: extractTickValue(snapshot, TickType.CLOSE, TickType.DELAYED_CLOSE),
        dailyVolume: extractTickValue(snapshot, TickType.VOLUME, TickType.DELAYED_VOLUME),
        tradeTimestamp: null,
        quoteTimestamp: null,
        raw: snapshot,
      },
    ];
  }));

  return new Map(snapshots);
}

async function getNews() {
  return [];
}

module.exports = {
  connect,
  disconnect,
  getAccount,
  getPositions,
  submitOrder,
  getSnapshots,
  getNews,
  resolveIbkrConfig,
};
