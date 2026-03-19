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
    source: toText(record.source, 'provider'),
    raw: record.raw || record,
  };
}

function defaultScannerState() {
  return {
    lastPollAt: null,
    cursor: null,
    recentTransfers: [],
    recentSignalKeys: [],
    seenTransferIds: [],
    updatedAt: null,
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
    recentSignalKeys: Array.isArray(state.recentSignalKeys)
      ? state.recentSignalKeys.map(normalizeSignalHistoryEntry).filter((entry) => entry.key && entry.emittedAt)
      : [],
    seenTransferIds: Array.isArray(state.seenTransferIds)
      ? state.seenTransferIds.map((value) => toText(value)).filter(Boolean)
      : [],
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
        recentSignalKeys,
        seenTransferIds: nextSeenIds,
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
      };
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
    return this.provider({
      chain: this.chain,
      cursor: this.state.cursor,
      since: this.state.lastPollAt,
      fetch: this.fetch,
      options: this.options,
      pollOptions: options,
    });
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
  createSmartMoneyScanner,
  createStaticSmartMoneyProvider,
  defaultScannerState,
  detectConvergenceSignals,
  normalizeScannerState,
  normalizeTransfer,
  readScannerState,
  writeScannerState,
};
