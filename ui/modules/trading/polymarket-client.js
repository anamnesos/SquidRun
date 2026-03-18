'use strict';

const path = require('path');
const dotenv = require('dotenv');

const { getProjectRoot } = require('../../config');

const DEFAULT_POLYMARKET_HOST = 'https://clob.polymarket.com';
const DEFAULT_CHAIN_ID = 137;
const DEFAULT_SIGNATURE_TYPE = 0;
const DEFAULT_DRY_RUN = true;
const MARKET_PAGE_LIMIT = 5;

let envLoaded = false;
let clientState = null;

function ensureEnvLoaded() {
  if (envLoaded) return;
  try {
    dotenv.config({ path: path.join(getProjectRoot(), '.env'), quiet: true });
  } catch {
    // Best effort only.
  }
  envLoaded = true;
}

function toNonEmptyString(value, fallback = '') {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function normalizePrivateKey(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return '';
  return normalized.startsWith('0x') ? normalized : `0x${normalized}`;
}

function normalizeSide(value, options = {}) {
  const { Side } = requirePolymarketSdk();
  const normalized = String(value || '').trim().toUpperCase();
  if (normalized === 'BUY' || normalized === Side.BUY) return Side.BUY;
  if (normalized === 'SELL' || normalized === Side.SELL) return Side.SELL;
  throw new Error(`Unsupported Polymarket side: ${value}${options.context ? ` (${options.context})` : ''}`);
}

function requirePolymarketSdk() {
  try {
    return require('@polymarket/clob-client');
  } catch (err) {
    const wrapped = new Error(
      '@polymarket/clob-client is not installed in ui/node_modules yet. Run npm install in ui/ before enabling Polymarket trading.'
    );
    wrapped.code = 'POLYMARKET_SDK_UNAVAILABLE';
    wrapped.cause = err;
    throw wrapped;
  }
}

function requireEthersWallet() {
  try {
    return require('ethers').Wallet;
  } catch (err) {
    const wrapped = new Error('ethers is not installed in ui/node_modules yet. Run npm install in ui/ before enabling Polymarket trading.');
    wrapped.code = 'POLYMARKET_ETHERS_UNAVAILABLE';
    wrapped.cause = err;
    throw wrapped;
  }
}

function resolvePolymarketConfig(env = process.env) {
  ensureEnvLoaded();
  const privateKey = normalizePrivateKey(env.POLYMARKET_PRIVATE_KEY);
  const funderAddress = toNonEmptyString(env.POLYMARKET_FUNDER_ADDRESS);
  const host = toNonEmptyString(env.POLYMARKET_HOST, DEFAULT_POLYMARKET_HOST);
  const chainId = Number.parseInt(toNonEmptyString(env.POLYMARKET_CHAIN_ID, String(DEFAULT_CHAIN_ID)), 10) || DEFAULT_CHAIN_ID;
  const dryRun = toBoolean(env.POLYMARKET_DRY_RUN, DEFAULT_DRY_RUN);

  return {
    privateKey,
    funderAddress,
    host,
    chainId,
    dryRun,
    signatureType: DEFAULT_SIGNATURE_TYPE,
    configured: Boolean(privateKey && funderAddress),
  };
}

function buildSigner(privateKey) {
  if (!privateKey) {
    throw new Error('Polymarket private key is missing. Set POLYMARKET_PRIVATE_KEY in .env.');
  }
  const Wallet = requireEthersWallet();
  return new Wallet(privateKey);
}

function normalizePrice(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function pickMarketField(raw, keys, fallback = null) {
  for (const key of keys) {
    if (raw?.[key] !== undefined && raw?.[key] !== null && raw[key] !== '') {
      return raw[key];
    }
  }
  return fallback;
}

function normalizeToken(token = {}) {
  return {
    tokenId: toNonEmptyString(token.token_id || token.tokenId || token.asset_id),
    outcome: toNonEmptyString(token.outcome || token.name),
    price: normalizePrice(token.price),
    winner: token.winner === true,
  };
}

function normalizeMarket(raw = {}) {
  const tokens = Array.isArray(raw.tokens) ? raw.tokens.map(normalizeToken) : [];
  const question = toNonEmptyString(raw.question || raw.title || raw.market_question);
  const category = toNonEmptyString(raw.category || raw.category_slug || raw.topic || 'general').toLowerCase();
  const active = raw.active !== false && raw.closed !== true && raw.archived !== true;
  const conditionId = toNonEmptyString(raw.condition_id || raw.conditionId || raw.id);

  return {
    conditionId,
    question,
    description: toNonEmptyString(raw.description || raw.subtitle),
    active,
    closed: Boolean(raw.closed),
    archived: Boolean(raw.archived),
    acceptingOrders: raw.accepting_orders !== false && raw.acceptingOrders !== false,
    category,
    volume24h: toNumber(pickMarketField(raw, ['volume_24h', 'volume24h', 'one_day_volume', 'oneDayVolume'], 0), 0),
    volume: toNumber(pickMarketField(raw, ['volume', 'volume_num', 'volumeNum'], 0), 0),
    liquidity: toNumber(pickMarketField(raw, ['liquidity', 'liquidity_num', 'liquidityNum'], 0), 0),
    endDate: normalizeDate(pickMarketField(raw, ['end_date_iso', 'endDate', 'resolution_date', 'resolutionDate'])),
    startDate: normalizeDate(pickMarketField(raw, ['start_date_iso', 'startDate'])),
    slug: toNonEmptyString(raw.market_slug || raw.slug),
    icon: toNonEmptyString(raw.icon || raw.image),
    tokens,
    tickSize: toNonEmptyString(raw.minimum_tick_size || raw.tick_size || raw.tickSize),
    negRisk: raw.neg_risk === true || raw.negRisk === true,
    raw,
  };
}

function normalizeOrderBook(book = {}) {
  const bids = Array.isArray(book.bids) ? book.bids : [];
  const asks = Array.isArray(book.asks) ? book.asks : [];
  const bestBid = bids.length > 0 ? normalizePrice(bids[0]?.price) : null;
  const bestAsk = asks.length > 0 ? normalizePrice(asks[0]?.price) : null;
  const midpoint = bestBid != null && bestAsk != null
    ? Number(((bestBid + bestAsk) / 2).toFixed(4))
    : (bestAsk ?? bestBid ?? normalizePrice(book.last_trade_price));

  return {
    tokenId: toNonEmptyString(book.asset_id || book.assetId),
    market: toNonEmptyString(book.market || book.condition_id),
    bids: bids.map((entry) => ({
      price: normalizePrice(entry.price),
      size: toNumber(entry.size, 0),
    })),
    asks: asks.map((entry) => ({
      price: normalizePrice(entry.price),
      size: toNumber(entry.size, 0),
    })),
    bestBid,
    bestAsk,
    midpoint,
    tickSize: toNonEmptyString(book.tick_size || book.tickSize),
    minOrderSize: toNonEmptyString(book.min_order_size || book.minOrderSize),
    negRisk: book.neg_risk === true || book.negRisk === true,
    lastTradePrice: normalizePrice(book.last_trade_price),
    raw: book,
  };
}

function normalizeOpenOrder(order = {}) {
  return {
    id: toNonEmptyString(order.id || order.orderID),
    status: toNonEmptyString(order.status),
    market: toNonEmptyString(order.market),
    tokenId: toNonEmptyString(order.asset_id || order.assetId),
    side: toNonEmptyString(order.side).toUpperCase(),
    size: toNumber(order.original_size || order.size, 0),
    sizeMatched: toNumber(order.size_matched, 0),
    price: normalizePrice(order.price),
    outcome: toNonEmptyString(order.outcome),
    expiration: toNonEmptyString(order.expiration),
    createdAt: order.created_at || null,
    orderType: toNonEmptyString(order.order_type),
    raw: order,
  };
}

function normalizeTrade(trade = {}) {
  return {
    id: toNonEmptyString(trade.id),
    market: toNonEmptyString(trade.market),
    tokenId: toNonEmptyString(trade.asset_id || trade.assetId),
    side: toNonEmptyString(trade.side).toUpperCase(),
    size: toNumber(trade.size, 0),
    price: normalizePrice(trade.price),
    outcome: toNonEmptyString(trade.outcome),
    status: toNonEmptyString(trade.status),
    matchTime: toNonEmptyString(trade.match_time || trade.matchTime),
    raw: trade,
  };
}

async function connect(options = {}) {
  if (options.client) return options.client;
  if (clientState?.client) return clientState.client;

  const sdk = requirePolymarketSdk();
  const config = {
    ...resolvePolymarketConfig(options.env || process.env),
    ...(options.host ? { host: toNonEmptyString(options.host) } : {}),
    ...(options.chainId ? { chainId: Number.parseInt(String(options.chainId), 10) || DEFAULT_CHAIN_ID } : {}),
    ...(options.privateKey ? { privateKey: normalizePrivateKey(options.privateKey) } : {}),
    ...(options.funderAddress ? { funderAddress: toNonEmptyString(options.funderAddress) } : {}),
    ...(options.dryRun !== undefined ? { dryRun: Boolean(options.dryRun) } : {}),
  };

  if (!config.configured && !(config.privateKey && config.funderAddress)) {
    throw new Error('Polymarket credentials are missing. Set POLYMARKET_PRIVATE_KEY and POLYMARKET_FUNDER_ADDRESS in .env.');
  }

  const signer = buildSigner(config.privateKey);
  const bootstrap = new sdk.ClobClient(
    config.host,
    config.chainId,
    signer,
    undefined,
    sdk.SignatureType.EOA,
    config.funderAddress,
    undefined,
    undefined,
    undefined,
    undefined,
    true,
    undefined,
    true
  );
  const creds = await bootstrap.createOrDeriveApiKey();
  const client = new sdk.ClobClient(
    config.host,
    config.chainId,
    signer,
    creds,
    sdk.SignatureType.EOA,
    config.funderAddress,
    undefined,
    undefined,
    undefined,
    undefined,
    true,
    undefined,
    true
  );

  clientState = {
    client,
    signer,
    creds,
    config,
  };

  return client;
}

async function disconnect() {
  clientState = null;
  return { ok: true };
}

function getActiveConfig(options = {}) {
  if (options.client) return { config: resolvePolymarketConfig(options.env || process.env) };
  return clientState || { config: resolvePolymarketConfig(options.env || process.env) };
}

async function getBalance(options = {}) {
  const client = await connect(options);
  const sdk = requirePolymarketSdk();
  const response = await client.getBalanceAllowance({
    asset_type: sdk.AssetType.COLLATERAL,
  });
  const balance = toNumber(response?.balance, 0);
  const allowance = toNumber(response?.allowance, 0);

  return {
    currency: 'USDC.e',
    network: 'Polygon',
    balance,
    allowance,
    available: Math.min(balance, allowance || balance),
    raw: response,
  };
}

async function getMarkets(filters = {}, options = {}) {
  const client = await connect(options);
  const limitPages = Math.max(1, Number.parseInt(String(filters.limitPages || MARKET_PAGE_LIMIT), 10) || MARKET_PAGE_LIMIT);
  const results = [];
  let cursor = undefined;

  for (let page = 0; page < limitPages; page += 1) {
    const payload = await client.getMarkets(cursor);
    const data = Array.isArray(payload?.data) ? payload.data : [];
    results.push(...data.map(normalizeMarket));
    cursor = payload?.next_cursor;
    if (!cursor || cursor === 'LTE=' || data.length === 0) {
      break;
    }
  }

  const minLiquidity = toNumber(filters.minLiquidity, 0);
  const minVolume = toNumber(filters.minVolume, 0);

  return results.filter((market) => {
    if (filters.activeOnly !== false && !market.active) return false;
    if (filters.acceptingOrdersOnly !== false && !market.acceptingOrders) return false;
    if (minLiquidity > 0 && market.liquidity < minLiquidity) return false;
    if (minVolume > 0 && Math.max(market.volume24h, market.volume) < minVolume) return false;
    return true;
  });
}

async function getMarketBook(tokenId, options = {}) {
  const client = await connect(options);
  const book = await client.getOrderBook(String(tokenId || '').trim());
  return normalizeOrderBook(book);
}

async function getPrice(tokenId, options = {}) {
  const book = await getMarketBook(tokenId, options);
  if (options.side) {
    const side = normalizeSide(options.side, { context: 'getPrice' });
    return side === requirePolymarketSdk().Side.BUY
      ? (book.bestAsk ?? book.midpoint)
      : (book.bestBid ?? book.midpoint);
  }
  return book.midpoint;
}

async function createOrder(tokenId, side, price, size, options = {}) {
  const sdk = requirePolymarketSdk();
  const client = await connect(options);
  const { config } = getActiveConfig(options);
  const normalizedSide = normalizeSide(side, { context: 'createOrder' });
  const numericPrice = normalizePrice(price);
  const numericSize = toNumber(size, 0);
  if (numericPrice == null || numericPrice <= 0) {
    throw new Error('Polymarket order price must be a positive number');
  }
  if (numericSize <= 0) {
    throw new Error('Polymarket order size must be a positive number');
  }

  const tickSize = toNonEmptyString(options.tickSize) || await client.getTickSize(String(tokenId || '').trim());
  const negRisk = options.negRisk !== undefined ? Boolean(options.negRisk) : await client.getNegRisk(String(tokenId || '').trim());
  const payload = {
    tokenID: String(tokenId || '').trim(),
    price: numericPrice,
    side: normalizedSide,
    size: numericSize,
  };

  if (options.dryRun !== false && config.dryRun !== false) {
    return {
      ok: true,
      status: 'dry_run',
      payload,
      orderType: sdk.OrderType.GTC,
      options: { tickSize, negRisk },
    };
  }

  const response = await client.createAndPostOrder(
    payload,
    { tickSize, negRisk },
    sdk.OrderType.GTC
  );

  return {
    ok: true,
    status: toNonEmptyString(response?.status, 'submitted'),
    orderId: toNonEmptyString(response?.orderID || response?.orderId),
    payload,
    options: { tickSize, negRisk },
    raw: response,
  };
}

async function cancelOrder(orderId, options = {}) {
  const client = await connect(options);
  const response = await client.cancelOrder({ orderID: String(orderId || '').trim() });
  return {
    ok: true,
    orderId: String(orderId || '').trim(),
    raw: response,
  };
}

async function getOpenOrders(options = {}) {
  const client = await connect(options);
  const orders = await client.getOpenOrders(options.params || {});
  return Array.isArray(orders) ? orders.map(normalizeOpenOrder) : [];
}

function aggregateTradesToPosition(positions, trade) {
  const key = trade.tokenId;
  const signedSize = trade.side === 'BUY' ? trade.size : -trade.size;
  if (!positions.has(key)) {
    positions.set(key, {
      tokenId: trade.tokenId,
      market: trade.market,
      outcome: trade.outcome,
      size: 0,
      avgEntryPrice: 0,
      costBasis: 0,
      realizedPnl: 0,
      trades: [],
    });
  }

  const position = positions.get(key);
  position.trades.push(trade);

  if (signedSize > 0) {
    position.costBasis += signedSize * trade.price;
    position.size += signedSize;
    position.avgEntryPrice = position.size > 0 ? position.costBasis / position.size : 0;
    return;
  }

  const sellSize = Math.min(position.size, Math.abs(signedSize));
  position.realizedPnl += sellSize * (trade.price - position.avgEntryPrice);
  position.size = Math.max(0, position.size - sellSize);
  position.costBasis = position.size * position.avgEntryPrice;
}

async function getPositions(options = {}) {
  const client = await connect(options);
  const { config } = getActiveConfig(options);
  const trades = (await client.getTrades({
    maker_address: options.address || config.funderAddress,
  }, false)).map(normalizeTrade);
  const positions = new Map();

  for (const trade of trades) {
    aggregateTradesToPosition(positions, trade);
  }

  const currentPrices = await Promise.all(Array.from(positions.values()).map(async (position) => {
    const currentPrice = await getPrice(position.tokenId, options).catch(() => null);
    return [position.tokenId, currentPrice];
  }));

  return Array.from(positions.values())
    .filter((position) => position.size > 0)
    .map((position) => {
      const currentPrice = new Map(currentPrices).get(position.tokenId);
      const unrealizedPnl = currentPrice != null
        ? position.size * (currentPrice - position.avgEntryPrice)
        : null;

      return {
        tokenId: position.tokenId,
        market: position.market,
        outcome: position.outcome,
        size: Number(position.size.toFixed(4)),
        avgEntryPrice: Number(position.avgEntryPrice.toFixed(4)),
        currentPrice,
        marketValue: currentPrice != null ? Number((position.size * currentPrice).toFixed(4)) : null,
        unrealizedPnl,
        realizedPnl: Number(position.realizedPnl.toFixed(4)),
        trades: position.trades,
      };
    });
}

module.exports = {
  DEFAULT_POLYMARKET_HOST,
  DEFAULT_CHAIN_ID,
  resolvePolymarketConfig,
  connect,
  disconnect,
  getBalance,
  getMarkets,
  getMarketBook,
  getPrice,
  createOrder,
  cancelOrder,
  getOpenOrders,
  getPositions,
};
