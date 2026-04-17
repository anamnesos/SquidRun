'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const { resolveCoordPath } = require('../../config');

const DEFAULT_SMART_MONEY_SCANNER_STATE_PATH = resolveCoordPath(
  path.join('runtime', 'smart-money-scanner-state.json'),
  { forWrite: true }
);
const DEFAULT_POLL_MS = 60_000;
const DEFAULT_MIN_USD_VALUE = 50_000;
const DEFAULT_MIN_WALLET_COUNT = 2;
const DEFAULT_CONVERGENCE_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_TRIGGER_COOLDOWN_MS = 15 * 60 * 1000;
const DEFAULT_MAX_RECENT_TRANSFERS = 500;
const DEFAULT_MAX_SEEN_TRANSFER_IDS = 2_000;
const HYPERLIQUID_INFO_URL = 'https://api.hyperliquid.xyz/info';

function toText(value, fallback = '') {
  const normalized = String(value ?? '').trim();
  return normalized || fallback;
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toIsoTimestamp(value, fallback = null) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const normalized = value > 10_000_000_000 ? value : value * 1000;
    return new Date(normalized).toISOString();
  }
  const numericString = String(value).trim();
  if (/^\d{10,13}$/.test(numericString)) {
    const numericValue = Number.parseInt(numericString, 10);
    if (Number.isFinite(numericValue)) {
      const normalized = numericString.length >= 13 ? numericValue : numericValue * 1000;
      return new Date(normalized).toISOString();
    }
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return date.toISOString();
}

function normalizeChain(value, fallback = 'ethereum') {
  const normalized = toText(value, fallback).toLowerCase();
  return normalized || fallback;
}

function normalizeSide(value, fallback = 'buy') {
  const normalized = toText(value, fallback).toLowerCase();
  if (normalized === 'sell') return 'sell';
  if (normalized === 'unknown') return 'unknown';
  return 'buy';
}

function normalizeAddress(value) {
  const normalized = toText(value).toLowerCase();
  return normalized || '';
}

function buildDataFreshness({
  source,
  observedAt = null,
  fetchedAt = null,
  stale = false,
  staleReason = null,
} = {}) {
  return {
    source: toText(source, 'unknown'),
    observedAt: toIsoTimestamp(observedAt, null),
    fetchedAt: toIsoTimestamp(fetchedAt, new Date().toISOString()),
    stale: stale === true,
    staleReason: staleReason ? toText(staleReason) : null,
  };
}

async function fetchHyperliquidAllMids(fetchFn) {
  const response = await fetchFn(HYPERLIQUID_INFO_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ type: 'allMids' }),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`hyperliquid_mids_http_${response.status}: ${text.slice(0, 160)}`);
  }
  return text ? JSON.parse(text) : {};
}

async function resolveTrackedTokenPricing({ fetchFn, nowIso, options = {} } = {}) {
  const prices = {
    USDC: {
      value: 1,
      ...buildDataFreshness({
        source: 'static_peg_assumption',
        observedAt: nowIso,
        fetchedAt: nowIso,
      }),
    },
    USDT: {
      value: 1,
      ...buildDataFreshness({
        source: 'static_peg_assumption',
        observedAt: nowIso,
        fetchedAt: nowIso,
      }),
    },
  };

  const injectedWethPrice = toNumber(options.priceUsdBySymbol?.WETH ?? options.wethPriceUsd, NaN);
  if (Number.isFinite(injectedWethPrice) && injectedWethPrice > 0) {
    prices.WETH = {
      value: injectedWethPrice,
      ...buildDataFreshness({
        source: 'injected_weth_price',
        observedAt: nowIso,
        fetchedAt: nowIso,
      }),
    };
    return prices;
  }

  try {
    const mids = await fetchHyperliquidAllMids(fetchFn);
    const ethPrice = toNumber(mids?.ETH, NaN);
    if (Number.isFinite(ethPrice) && ethPrice > 0) {
      prices.WETH = {
        value: ethPrice,
        ...buildDataFreshness({
          source: 'hyperliquid:allMids',
          observedAt: nowIso,
          fetchedAt: nowIso,
        }),
      };
      return prices;
    }
  } catch {
    // Fall through to explicit unavailable metadata.
  }

  prices.WETH = {
    value: null,
    ...buildDataFreshness({
      source: 'unavailable',
      observedAt: null,
      fetchedAt: nowIso,
      stale: true,
      staleReason: 'weth_price_unavailable',
    }),
  };
  return prices;
}

function buildTransferId(record = {}) {
  const explicit = toText(record.transferId || record.id);
  if (explicit) return explicit;
  const txHash = normalizeAddress(record.txHash || record.hash);
  const logIndex = toText(record.logIndex, '0');
  const walletAddress = normalizeAddress(record.walletAddress || record.address || record.wallet);
  const tokenAddress = normalizeAddress(record.tokenAddress || record.contractAddress || record.token);
  const timestamp = toIsoTimestamp(record.timestamp, '') || '';
  return [txHash, logIndex, walletAddress, tokenAddress, timestamp].join(':');
}

function normalizeTransfer(record = {}) {
  const chain = normalizeChain(record.chain, 'ethereum');
  const symbol = toText(record.symbol || record.tokenSymbol || record.ticker).toUpperCase();
  const tokenAddress = normalizeAddress(record.tokenAddress || record.contractAddress || record.token);
  const walletAddress = normalizeAddress(record.walletAddress || record.address || record.wallet);
  const timestamp = toIsoTimestamp(record.timestamp, new Date().toISOString());
  const transferId = buildTransferId({ ...record, chain, symbol, tokenAddress, walletAddress, timestamp });

  return {
    transferId,
    chain,
    symbol,
    tokenAddress,
    walletAddress,
    counterparty: normalizeAddress(record.counterparty || record.from || record.to),
    side: normalizeSide(record.side || record.direction),
    usdValue: Math.max(0, toNumber(record.usdValue ?? record.valueUsd ?? record.value_usd, 0)),
    quantity: Math.max(0, toNumber(record.quantity ?? record.amount ?? record.value, 0)),
    price: Math.max(0, toNumber(record.price, 0)),
    txHash: normalizeAddress(record.txHash || record.hash),
    timestamp,
    observedAt: toIsoTimestamp(record.observedAt, timestamp),
    fetchedAt: toIsoTimestamp(record.fetchedAt, timestamp),
    stale: record.stale === true,
    staleReason: toText(record.staleReason, '') || null,
    priceSource: toText(record.priceSource, '') || null,
    priceObservedAt: toIsoTimestamp(record.priceObservedAt, null),
    priceFetchedAt: toIsoTimestamp(record.priceFetchedAt, null),
    priceStale: record.priceStale === true,
    priceStaleReason: toText(record.priceStaleReason, '') || null,
    source: toText(record.source, 'provider'),
    raw: record.raw || record,
  };
}

function defaultScannerState() {
  return {
    lastPollAt: null,
    cursor: null,
    recentTransfers: [],
    convergenceSignals: [],
    recentSignalKeys: [],
    seenTransferIds: [],
    health: 'idle',
    lastError: null,
    lastResult: null,
    updatedAt: null,
  };
}

function normalizeScannerResult(result = null) {
  if (!result || typeof result !== 'object') return null;
  return {
    ok: result.ok !== false,
    chain: normalizeChain(result.chain, 'ethereum'),
    startedAt: toIsoTimestamp(result.startedAt, null),
    completedAt: toIsoTimestamp(result.completedAt, null),
    error: toText(result.error, '') || null,
    degraded: result.degraded === true,
    reason: toText(result.reason, '') || null,
    newTransferCount: Math.max(0, Math.floor(toNumber(result.newTransferCount ?? result.newTransfers?.length, 0))),
    signalCount: Math.max(0, Math.floor(toNumber(result.signalCount ?? result.signals?.length, 0))),
    freshSignalCount: Math.max(0, Math.floor(toNumber(result.freshSignalCount ?? result.freshSignals?.length, 0))),
  };
}

function normalizeSignalHistoryEntry(record = {}) {
  return {
    key: toText(record.key),
    emittedAt: toIsoTimestamp(record.emittedAt, null),
  };
}

function normalizeScannerState(state = {}) {
  return {
    ...defaultScannerState(),
    ...state,
    lastPollAt: toIsoTimestamp(state.lastPollAt, null),
    recentTransfers: Array.isArray(state.recentTransfers)
      ? state.recentTransfers.map(normalizeTransfer)
      : [],
    convergenceSignals: Array.isArray(state.convergenceSignals)
      ? state.convergenceSignals.map((signal) => ({
        chain: normalizeChain(signal?.chain, 'ethereum'),
        symbol: toText(signal?.symbol || signal?.ticker).toUpperCase(),
        tokenAddress: normalizeAddress(signal?.tokenAddress || signal?.token),
        walletCount: Math.max(0, Math.floor(toNumber(signal?.walletCount, 0))),
        transferCount: Math.max(0, Math.floor(toNumber(signal?.transferCount, 0))),
        totalUsdValue: Math.max(0, toNumber(signal?.totalUsdValue, 0)),
        confidence: Math.max(0, Math.min(1, toNumber(signal?.confidence, 0))),
        strength: Math.max(0, Math.min(1, toNumber(signal?.strength, 0))),
        earliestTimestamp: toIsoTimestamp(signal?.earliestTimestamp, null),
        latestTimestamp: toIsoTimestamp(signal?.latestTimestamp, null),
      }))
      : [],
    recentSignalKeys: Array.isArray(state.recentSignalKeys)
      ? state.recentSignalKeys.map(normalizeSignalHistoryEntry).filter((entry) => entry.key && entry.emittedAt)
      : [],
    seenTransferIds: Array.isArray(state.seenTransferIds)
      ? state.seenTransferIds.map((value) => toText(value)).filter(Boolean)
      : [],
    health: ['idle', 'ok', 'degraded', 'error'].includes(String(state.health || '').toLowerCase())
      ? String(state.health || '').toLowerCase()
      : 'idle',
    lastError: toText(state.lastError, '') || null,
    lastResult: normalizeScannerResult(state.lastResult),
    updatedAt: toIsoTimestamp(state.updatedAt, null),
  };
}

function readScannerState(statePath = DEFAULT_SMART_MONEY_SCANNER_STATE_PATH) {
  try {
    return normalizeScannerState(JSON.parse(fs.readFileSync(statePath, 'utf8')));
  } catch {
    return defaultScannerState();
  }
}

function writeScannerState(statePath = DEFAULT_SMART_MONEY_SCANNER_STATE_PATH, state = {}) {
  const normalized = normalizeScannerState(state);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({
    ...normalized,
    updatedAt: new Date().toISOString(),
  }, null, 2));
}

function pruneRecentTransfers(transfers = [], nowMs = Date.now(), maxAgeMs = DEFAULT_CONVERGENCE_WINDOW_MS * 2, maxItems = DEFAULT_MAX_RECENT_TRANSFERS) {
  return transfers
    .filter((transfer) => {
      const timestampMs = Date.parse(transfer.timestamp || '');
      return Number.isFinite(timestampMs) && (nowMs - timestampMs) <= maxAgeMs;
    })
    .sort((left, right) => Date.parse(right.timestamp || 0) - Date.parse(left.timestamp || 0))
    .slice(0, Math.max(1, Math.floor(toNumber(maxItems, DEFAULT_MAX_RECENT_TRANSFERS))));
}

function pruneSignalHistory(entries = [], nowMs = Date.now(), cooldownMs = DEFAULT_TRIGGER_COOLDOWN_MS) {
  return entries.filter((entry) => {
    const emittedAtMs = Date.parse(entry.emittedAt || '');
    return Number.isFinite(emittedAtMs) && (nowMs - emittedAtMs) <= (cooldownMs * 2);
  });
}

function buildSignalKey(signal = {}, cooldownMs = DEFAULT_TRIGGER_COOLDOWN_MS) {
  const latestTimestampMs = Date.parse(signal.latestTimestamp || '') || 0;
  const bucket = cooldownMs > 0 ? Math.floor(latestTimestampMs / cooldownMs) : latestTimestampMs;
  return [
    normalizeChain(signal.chain, 'ethereum'),
    normalizeAddress(signal.tokenAddress || signal.symbol),
    Array.isArray(signal.wallets) ? signal.wallets.map((wallet) => normalizeAddress(wallet.walletAddress)).sort().join(',') : '',
    bucket,
  ].join('|');
}

function detectConvergenceSignals(transfers = [], options = {}) {
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const minUsdValue = Math.max(0, toNumber(options.minUsdValue, DEFAULT_MIN_USD_VALUE));
  const minWalletCount = Math.max(2, Math.floor(toNumber(options.minWalletCount, DEFAULT_MIN_WALLET_COUNT)));
  const convergenceWindowMs = Math.max(60_000, Math.floor(toNumber(options.convergenceWindowMs, DEFAULT_CONVERGENCE_WINDOW_MS)));
  const recentTransfers = pruneRecentTransfers(transfers, nowMs, convergenceWindowMs, options.maxRecentTransfers || DEFAULT_MAX_RECENT_TRANSFERS);
  const grouped = new Map();

  for (const transfer of recentTransfers) {
    if (transfer.side !== 'buy') continue;
    if (transfer.usdValue < minUsdValue) continue;

    const key = `${transfer.chain}:${transfer.tokenAddress || transfer.symbol}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        chain: transfer.chain,
        symbol: transfer.symbol,
        tokenAddress: transfer.tokenAddress,
        walletMap: new Map(),
        transfers: [],
        totalUsdValue: 0,
        earliestTimestamp: transfer.timestamp,
        latestTimestamp: transfer.timestamp,
      });
    }

    const bucket = grouped.get(key);
    bucket.transfers.push(transfer);
    bucket.totalUsdValue += transfer.usdValue;
    if (!bucket.walletMap.has(transfer.walletAddress)) {
      bucket.walletMap.set(transfer.walletAddress, {
        walletAddress: transfer.walletAddress,
        totalUsdValue: 0,
        latestTimestamp: transfer.timestamp,
        transferCount: 0,
      });
    }
    const wallet = bucket.walletMap.get(transfer.walletAddress);
    wallet.totalUsdValue += transfer.usdValue;
    wallet.transferCount += 1;
    if (Date.parse(transfer.timestamp || 0) > Date.parse(wallet.latestTimestamp || 0)) {
      wallet.latestTimestamp = transfer.timestamp;
    }
    if (Date.parse(transfer.timestamp || 0) < Date.parse(bucket.earliestTimestamp || 0)) {
      bucket.earliestTimestamp = transfer.timestamp;
    }
    if (Date.parse(transfer.timestamp || 0) > Date.parse(bucket.latestTimestamp || 0)) {
      bucket.latestTimestamp = transfer.timestamp;
    }
  }

  return Array.from(grouped.values())
    .map((bucket) => {
      const wallets = Array.from(bucket.walletMap.values()).sort((left, right) => {
        if (right.totalUsdValue !== left.totalUsdValue) return right.totalUsdValue - left.totalUsdValue;
        return Date.parse(right.latestTimestamp || 0) - Date.parse(left.latestTimestamp || 0);
      });
      const walletCount = wallets.length;
      const transferCount = bucket.transfers.length;
      const averageUsdValue = walletCount > 0 ? bucket.totalUsdValue / walletCount : 0;
      const strength = Math.min(1, ((walletCount / 4) * 0.45) + (Math.min(bucket.totalUsdValue, 500_000) / 500_000 * 0.35) + (Math.min(transferCount, 6) / 6 * 0.2));
      const confidence = Math.min(0.99, ((walletCount / 5) * 0.5) + (Math.min(averageUsdValue, 250_000) / 250_000 * 0.3) + (Math.min(transferCount, 8) / 8 * 0.2));
      return {
        chain: bucket.chain,
        symbol: bucket.symbol,
        tokenAddress: bucket.tokenAddress,
        walletCount,
        transferCount,
        totalUsdValue: Number(bucket.totalUsdValue.toFixed(2)),
        averageUsdValue: Number(averageUsdValue.toFixed(2)),
        earliestTimestamp: bucket.earliestTimestamp,
        latestTimestamp: bucket.latestTimestamp,
        strength: Number(strength.toFixed(4)),
        confidence: Number(confidence.toFixed(4)),
        wallets,
        transfers: bucket.transfers.slice().sort((left, right) => Date.parse(right.timestamp || 0) - Date.parse(left.timestamp || 0)),
      };
    })
    .filter((signal) => signal.walletCount >= minWalletCount)
    .sort((left, right) => {
      if (right.confidence !== left.confidence) return right.confidence - left.confidence;
      if (right.walletCount !== left.walletCount) return right.walletCount - left.walletCount;
      return right.totalUsdValue - left.totalUsdValue;
    });
}

class SmartMoneyScanner extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = { ...options };
    this.chain = normalizeChain(options.chain, 'ethereum');
    this.pollMs = Math.max(15_000, Math.floor(toNumber(options.pollMs, DEFAULT_POLL_MS)));
    this.minUsdValue = Math.max(0, toNumber(options.minUsdValue, DEFAULT_MIN_USD_VALUE));
    this.minWalletCount = Math.max(2, Math.floor(toNumber(options.minWalletCount, DEFAULT_MIN_WALLET_COUNT)));
    this.convergenceWindowMs = Math.max(60_000, Math.floor(toNumber(options.convergenceWindowMs, DEFAULT_CONVERGENCE_WINDOW_MS)));
    this.triggerCooldownMs = Math.max(60_000, Math.floor(toNumber(options.triggerCooldownMs, DEFAULT_TRIGGER_COOLDOWN_MS)));
    this.maxRecentTransfers = Math.max(10, Math.floor(toNumber(options.maxRecentTransfers, DEFAULT_MAX_RECENT_TRANSFERS)));
    this.maxSeenTransferIds = Math.max(100, Math.floor(toNumber(options.maxSeenTransferIds, DEFAULT_MAX_SEEN_TRANSFER_IDS)));
    this.statePath = options.statePath || DEFAULT_SMART_MONEY_SCANNER_STATE_PATH;
    this.fetch = options.fetch || global.fetch;
    this.provider = typeof options.provider === 'function' ? options.provider : null;
    this.onTrigger = typeof options.onTrigger === 'function' ? options.onTrigger : null;
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.state = normalizeScannerState(options.state || readScannerState(this.statePath));
    this.timer = null;
    this.pollPromise = null;
    this.running = false;
  }

  getState() {
    return normalizeScannerState(this.state);
  }

  persistState() {
    if (this.options.persist === false) return;
    writeScannerState(this.statePath, this.state);
  }

  start(options = {}) {
    if (this.running) return this;
    this.running = true;
    if (options.immediate !== false) {
      void this.pollNow({ reason: 'startup' });
    }
    this.timer = setInterval(() => {
      void this.pollNow({ reason: 'interval' });
    }, this.pollMs);
    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
    return this;
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    return this;
  }

  async pollNow(options = {}) {
    if (this.pollPromise) return this.pollPromise;

    this.pollPromise = this.runPoll(options)
      .finally(() => {
        this.pollPromise = null;
      });
    return this.pollPromise;
  }

  async runPoll(options = {}) {
    const startedAt = new Date(this.now()).toISOString();
    try {
      const providerResult = await this.readTransfersFromProvider(options);
      const rawTransfers = Array.isArray(providerResult)
        ? providerResult
        : (Array.isArray(providerResult?.transfers) ? providerResult.transfers : []);
      const cursor = Array.isArray(providerResult) ? null : (providerResult?.cursor ?? this.state.cursor ?? null);
      const normalizedTransfers = rawTransfers.map(normalizeTransfer)
        .filter((transfer) => transfer.chain === this.chain && transfer.transferId && transfer.walletAddress)
        .sort((left, right) => Date.parse(right.timestamp || 0) - Date.parse(left.timestamp || 0));
      const seenIds = new Set(this.state.seenTransferIds);
      const batchSeenIds = new Set();
      const newTransfers = normalizedTransfers.filter((transfer) => {
        if (seenIds.has(transfer.transferId) || batchSeenIds.has(transfer.transferId)) {
          return false;
        }
        batchSeenIds.add(transfer.transferId);
        return true;
      });

      const nowMs = this.now();
      const recentTransfers = pruneRecentTransfers([
        ...newTransfers,
        ...this.state.recentTransfers,
      ], nowMs, this.convergenceWindowMs * 2, this.maxRecentTransfers);

      const nextSeenIds = Array.from(new Set([
        ...newTransfers.map((transfer) => transfer.transferId),
        ...this.state.seenTransferIds,
      ])).slice(0, this.maxSeenTransferIds);

      const recentSignalKeys = pruneSignalHistory(this.state.recentSignalKeys, nowMs, this.triggerCooldownMs);
      const emittedSignalKeySet = new Set(recentSignalKeys.map((entry) => entry.key));
      const signals = detectConvergenceSignals(recentTransfers, {
        nowMs,
        minUsdValue: this.minUsdValue,
        minWalletCount: this.minWalletCount,
        convergenceWindowMs: this.convergenceWindowMs,
        maxRecentTransfers: this.maxRecentTransfers,
      });

      const freshSignals = [];
      for (const signal of signals) {
        const signalKey = buildSignalKey(signal, this.triggerCooldownMs);
        if (emittedSignalKeySet.has(signalKey)) continue;
        freshSignals.push({ ...signal, signalKey });
        emittedSignalKeySet.add(signalKey);
        recentSignalKeys.push({
          key: signalKey,
          emittedAt: startedAt,
        });
      }

      this.state = normalizeScannerState({
        ...this.state,
        lastPollAt: startedAt,
        cursor,
        recentTransfers,
        convergenceSignals: signals,
        recentSignalKeys,
        seenTransferIds: nextSeenIds,
        health: 'ok',
        lastError: null,
        lastResult: {
          ok: true,
          chain: this.chain,
          startedAt,
          completedAt: new Date(this.now()).toISOString(),
          newTransferCount: newTransfers.length,
          signalCount: signals.length,
          freshSignalCount: freshSignals.length,
        },
      });
      this.persistState();

      const summary = {
        ok: true,
        chain: this.chain,
        startedAt,
        completedAt: new Date(this.now()).toISOString(),
        cursor,
        newTransfers,
        signals,
        freshSignals,
      };

      this.emit('poll', summary);
      if (newTransfers.length > 0) {
        this.emit('transfers', newTransfers);
      }
      for (const signal of freshSignals) {
        this.emit('convergence', signal);
        this.emit('trigger', {
          reason: 'smart_money_convergence',
          chain: signal.chain,
          ticker: signal.symbol || signal.tokenAddress,
          signal,
        });
        if (this.onTrigger) {
          await this.onTrigger({
            reason: 'smart_money_convergence',
            chain: signal.chain,
            ticker: signal.symbol || signal.tokenAddress,
            signal,
          });
        }
      }

      return summary;
    } catch (err) {
      const failure = {
        ok: false,
        chain: this.chain,
        startedAt,
        completedAt: new Date(this.now()).toISOString(),
        error: err.message,
        degraded: err?.providerResult?.degraded === true,
      };
      this.state = normalizeScannerState({
        ...this.state,
        lastPollAt: startedAt,
        health: err?.providerResult?.degraded === true ? 'degraded' : 'error',
        lastError: err.message,
        lastResult: failure,
      });
      this.persistState();
      if (this.listenerCount('error') > 0) {
        this.emit('error', failure);
      }
      return failure;
    }
  }

  async readTransfersFromProvider(options = {}) {
    if (Array.isArray(options.mockTransfers)) {
      return { transfers: options.mockTransfers, cursor: this.state.cursor ?? null };
    }
    if (!this.provider) {
      throw new Error('smart_money_provider_required');
    }
    const providerResult = await this.provider({
      chain: this.chain,
      cursor: this.state.cursor,
      since: this.state.lastPollAt,
      fetch: this.fetch,
      options: this.options,
      pollOptions: options,
    });
    if (providerResult && typeof providerResult === 'object' && (providerResult.error || providerResult.degraded === true)) {
      const providerError = new Error(toText(providerResult.error, 'smart_money_provider_failed'));
      providerError.providerResult = providerResult;
      throw providerError;
    }
    return providerResult;
  }
}

function createStaticSmartMoneyProvider(transfers = []) {
  const fixedTransfers = Array.isArray(transfers) ? transfers.slice() : [];
  return async function staticSmartMoneyProvider() {
    return {
      transfers: fixedTransfers,
      cursor: null,
    };
  };
}

/**
 * RPC-based provider — uses eth_getLogs to track large stablecoin/WETH transfers on-chain.
 * No API key needed. Uses any Ethereum JSON-RPC endpoint.
 */
function createEtherscanProvider(options = {}) {
  const rpcUrl = options.rpcUrl || process.env.ETH_RPC_URL || 'https://eth.llamarpc.com';
  const minUsdValue = options.minUsdValue || 50_000;
  const blocksPerPoll = options.blocksPerPoll || 25; // ~5 minutes of blocks

  const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

  const TRACKED_TOKENS = {
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { symbol: 'USDC', decimals: 6 },
    '0xdac17f958d2ee523a2206206994597c13d831ec7': { symbol: 'USDT', decimals: 6 },
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': { symbol: 'WETH', decimals: 18 },
  };
  const TOKEN_ADDRESSES = Object.keys(TRACKED_TOKENS);

  // Known whale/smart-money wallets — exchanges, market makers, funds
  const WHALE_WALLETS = new Set([
    '0x47ac0fb4f2d84898e4d9e7b4dab3c24507a6d503', // Binance 14
    '0xbe0eb53f46cd790cd13851d5eff43d12404d33e8', // Binance 7
    '0xf977814e90da44bfa03b6295a0616a897441acec', // Binance 8
    '0x28c6c06298d514db089934071355e5743bf21d60', // Binance 14
    '0x21a31ee1afc51d94c2efccaa2092ad1028285549', // Binance 15
    '0xdfd5293d8e347dfe59e90efd55b2956a1343963d', // Binance 16
    '0x56eddb7aa87536c09ccc2793473599fd21a8b17f', // Binance 17
    '0x8894e0a0c962cb723c1ef8a1b26b8b3f7f1e2e19', // Jump Trading
    '0x9696f59e4d72e237be84ffd425dcad154bf96976', // Jump Trading 2
    '0x7758e507850da48cd47df1fb5f875c23e3340c50', // Wintermute
    '0x00000000ae347930bd1e7b0f35588b92280f9e75', // Wintermute 2
    '0xd6216fc19db775df9774a6e33526131da7d19a2c', // Cumberland
    '0x267be1c1d684f78cb4f6a176c4911b741e4ffdc0', // Kraken 4
    '0x2faf487a4414fe77e2327f0bf4ae2a264a776ad2', // FTX Estate
    '0x1db92e2eebc8e0c075a02bea49a2935bcd2dfcf4', // Galaxy Digital
  ]);

  return async function rpcSmartMoneyProvider({ cursor, fetch: fetchFn }) {
    const _fetch = fetchFn || global.fetch;
    const fetchedAt = new Date().toISOString();

    const rpcCall = async (method, params) => {
      const resp = await _fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(20_000),
      });
      const rawText = await resp.text();
      let data = null;
      try {
        data = rawText ? JSON.parse(rawText) : null;
      } catch {
        if (!resp.ok) {
          const detail = toText(rawText, `HTTP ${resp.status}`);
          throw new Error(`rpc_http_${resp.status}: ${detail.slice(0, 160)}`);
        }
        throw new Error(`rpc_non_json_response: ${toText(rawText, 'empty response').slice(0, 160)}`);
      }
      if (!resp.ok) {
        const detail = toText(data?.error?.message, toText(rawText, `HTTP ${resp.status}`));
        throw new Error(`rpc_http_${resp.status}: ${detail.slice(0, 160)}`);
      }
      if (data.error) throw new Error(data.error.message || 'rpc_error');
      return data.result;
    };

    try {
      const blockHex = await rpcCall('eth_blockNumber', []);
      const currentBlock = parseInt(blockHex, 16);
      const lastBlock = typeof cursor === 'number' && cursor > 0 ? cursor : (currentBlock - blocksPerPoll);
      const fromBlock = '0x' + Math.max(lastBlock + 1, currentBlock - blocksPerPoll).toString(16);

      const logs = await rpcCall('eth_getLogs', [{
        fromBlock,
        toBlock: 'latest',
        address: TOKEN_ADDRESSES,
        topics: [TRANSFER_TOPIC],
      }]);
      const needsWethPricing = (Array.isArray(logs) ? logs : []).some((log) => normalizeAddress(log?.address) === '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2');
      const tokenPricing = needsWethPricing
        ? await resolveTrackedTokenPricing({
          fetchFn: _fetch,
          nowIso: fetchedAt,
          options,
        })
        : {
          USDC: {
            value: 1,
            ...buildDataFreshness({
              source: 'static_peg_assumption',
              observedAt: fetchedAt,
              fetchedAt,
            }),
          },
          USDT: {
            value: 1,
            ...buildDataFreshness({
              source: 'static_peg_assumption',
              observedAt: fetchedAt,
              fetchedAt,
            }),
          },
        };
      const blockTimestampCache = new Map();
      const blockTimestampByNumber = async (blockNumberHex) => {
        const normalizedBlock = toText(blockNumberHex).toLowerCase();
        if (!normalizedBlock) return null;
        if (blockTimestampCache.has(normalizedBlock)) {
          return blockTimestampCache.get(normalizedBlock);
        }
        const block = await rpcCall('eth_getBlockByNumber', [normalizedBlock, false]);
        const blockTimestamp = toIsoTimestamp(parseInt(block?.timestamp || '0x0', 16), null);
        blockTimestampCache.set(normalizedBlock, blockTimestamp);
        return blockTimestamp;
      };

      const transfers = [];
      for (const log of (logs || [])) {
        const tokenAddr = (log.address || '').toLowerCase();
        const tokenInfo = TRACKED_TOKENS[tokenAddr];
        if (!tokenInfo) continue;
        const tokenPriceMeta = tokenPricing[tokenInfo.symbol] || {
          value: null,
          ...buildDataFreshness({
            source: 'unavailable',
            observedAt: null,
            fetchedAt,
            stale: true,
            staleReason: 'token_price_unavailable',
          }),
        };
        const tokenPriceUsd = toNumber(tokenPriceMeta.value, NaN);
        if (!(Number.isFinite(tokenPriceUsd) && tokenPriceUsd > 0)) continue;

        const rawValue = BigInt(log.data || '0');
        const value = Number(rawValue) / (10 ** tokenInfo.decimals);
        const usdValue = value * tokenPriceUsd;
        if (usdValue < minUsdValue) continue;

        const from = '0x' + (log.topics[1] || '').slice(26).toLowerCase();
        const to = '0x' + (log.topics[2] || '').slice(26).toLowerCase();
        const isWhaleFrom = WHALE_WALLETS.has(from);
        const isWhaleTo = WHALE_WALLETS.has(to);
        if (!isWhaleFrom && !isWhaleTo) continue;

        const direction = isWhaleTo ? 'BUY' : 'SELL';
        const walletAddress = isWhaleFrom ? from : to;
        const blockTimestamp = await blockTimestampByNumber(log.blockNumber);

        transfers.push({
          transferId: `${log.transactionHash}:${parseInt(log.logIndex || '0x0', 16)}`,
          chain: 'ethereum',
          walletAddress,
          tokenAddress: tokenAddr,
          symbol: tokenInfo.symbol,
          direction,
          value,
          usdValue,
          timestamp: blockTimestamp || fetchedAt,
          observedAt: blockTimestamp || null,
          fetchedAt,
          stale: !blockTimestamp,
          staleReason: !blockTimestamp ? 'block_timestamp_unavailable' : null,
          priceSource: tokenPriceMeta.source,
          priceObservedAt: tokenPriceMeta.observedAt,
          priceFetchedAt: tokenPriceMeta.fetchedAt,
          priceStale: tokenPriceMeta.stale === true,
          priceStaleReason: tokenPriceMeta.staleReason || null,
          blockNumber: parseInt(log.blockNumber, 16),
          txHash: log.transactionHash,
        });
      }

      return { transfers, cursor: currentBlock };
    } catch (error) {
      return {
        transfers: [],
        cursor: typeof cursor === 'number' ? cursor : 0,
        degraded: true,
        error: error?.message || 'smart_money_provider_failed',
        reason: 'ethereum_rpc_failed',
      };
    }
  };
}

function createSmartMoneyScanner(options = {}) {
  return new SmartMoneyScanner(options);
}

module.exports = {
  DEFAULT_SMART_MONEY_SCANNER_STATE_PATH,
  DEFAULT_POLL_MS,
  DEFAULT_MIN_USD_VALUE,
  DEFAULT_MIN_WALLET_COUNT,
  DEFAULT_CONVERGENCE_WINDOW_MS,
  DEFAULT_TRIGGER_COOLDOWN_MS,
  SmartMoneyScanner,
  buildSignalKey,
  createEtherscanProvider,
  createSmartMoneyScanner,
  createStaticSmartMoneyProvider,
  defaultScannerState,
  detectConvergenceSignals,
  normalizeScannerState,
  normalizeTransfer,
  readScannerState,
  writeScannerState,
};
