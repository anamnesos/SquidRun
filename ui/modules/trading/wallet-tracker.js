'use strict';

const fs = require('fs');
const path = require('path');

const { resolveCoordPath } = require('../../config');

const DEFAULT_WALLET_TRACKER_STATE_PATH = resolveCoordPath(path.join('runtime', 'wallet-tracker-state.json'), { forWrite: true });
const SUPPORTED_CHAINS = new Set(['solana', 'ethereum']);

function toText(value, fallback = '') {
  const normalized = String(value || '').trim();
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

function normalizeChain(value, fallback = 'solana') {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return fallback;
  if (!SUPPORTED_CHAINS.has(normalized)) {
    throw new Error(`Unsupported chain: ${value}`);
  }
  return normalized;
}

function normalizeAddress(value, chain = 'solana') {
  const normalized = toText(value);
  if (!normalized) {
    throw new Error('address is required');
  }
  return chain === 'ethereum' ? normalized.toLowerCase() : normalized;
}

function defaultWalletTrackerState() {
  return {
    trackedWallets: [],
    updatedAt: null,
  };
}

function normalizeTrackedWallet(record = {}) {
  const chain = normalizeChain(record.chain);
  return {
    address: normalizeAddress(record.address, chain),
    chain,
    label: toText(record.label, record.address),
    pnlScore: Math.max(0, toNumber(record.pnlScore, 0)),
    source: toText(record.source, 'manual'),
    notes: toText(record.notes),
    addedAt: toIsoTimestamp(record.addedAt, null),
    updatedAt: toIsoTimestamp(record.updatedAt, null),
  };
}

function normalizeMove(record = {}) {
  const chain = normalizeChain(record.chain);
  const side = toText(record.side || record.direction, 'buy').toLowerCase();
  return {
    address: normalizeAddress(record.address, chain),
    chain,
    token: toText(record.token || record.symbol || record.mint || record.contract).toUpperCase(),
    symbol: toText(record.symbol || record.token || record.mint || record.contract).toUpperCase(),
    tokenAddress: toText(record.tokenAddress || record.token_address || record.mint || record.contract).toLowerCase(),
    side: side === 'sell' ? 'sell' : 'buy',
    usdValue: Math.max(0, toNumber(record.usdValue ?? record.valueUsd ?? record.value_usd, 0)),
    quantity: Math.max(0, toNumber(record.quantity ?? record.amount ?? record.size, 0)),
    price: Math.max(0, toNumber(record.price, 0)),
    timestamp: toIsoTimestamp(record.timestamp, new Date().toISOString()),
    txHash: toText(record.txHash || record.tx_hash || record.signature || record.hash),
    source: toText(record.source, 'mock'),
    raw: record.raw || record,
  };
}

function normalizeWalletTrackerState(state = {}) {
  return {
    ...defaultWalletTrackerState(),
    ...state,
    trackedWallets: Array.isArray(state.trackedWallets)
      ? state.trackedWallets.map(normalizeTrackedWallet)
      : [],
    updatedAt: toIsoTimestamp(state.updatedAt, null),
  };
}

function readWalletTrackerState(statePath = DEFAULT_WALLET_TRACKER_STATE_PATH) {
  try {
    return normalizeWalletTrackerState(JSON.parse(fs.readFileSync(statePath, 'utf8')));
  } catch {
    return defaultWalletTrackerState();
  }
}

function writeWalletTrackerState(statePath = DEFAULT_WALLET_TRACKER_STATE_PATH, state = {}) {
  const normalized = normalizeWalletTrackerState(state);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({
    ...normalized,
    updatedAt: new Date().toISOString(),
  }, null, 2));
}

function resolveWalletTrackerConfig(env = process.env) {
  const heliusApiKey = toText(env.HELIUS_API_KEY);
  const birdeyeApiKey = toText(env.BIRDEYE_API_KEY);
  const mockMode = !heliusApiKey || !birdeyeApiKey;
  return {
    heliusApiKey,
    birdeyeApiKey,
    configured: Boolean(heliusApiKey || birdeyeApiKey),
    mockMode,
    availableChains: {
      solana: Boolean(heliusApiKey || birdeyeApiKey),
      ethereum: false,
    },
  };
}

function persistStateIfNeeded(statePath, state, persist) {
  if (persist === false) return;
  writeWalletTrackerState(statePath, state);
}

function resolveState(options = {}) {
  const statePath = options.statePath || DEFAULT_WALLET_TRACKER_STATE_PATH;
  const state = options.state
    ? normalizeWalletTrackerState(options.state)
    : readWalletTrackerState(statePath);
  return { statePath, state };
}

function trackWallet(address, details = {}) {
  const chain = normalizeChain(details.chain);
  const { statePath, state } = resolveState(details);
  const wallet = normalizeTrackedWallet({
    address,
    chain,
    label: details.label,
    pnlScore: details.pnlScore,
    source: details.source,
    notes: details.notes,
    addedAt: details.addedAt || new Date().toISOString(),
    updatedAt: details.updatedAt || new Date().toISOString(),
  });
  const nextWallets = state.trackedWallets.filter((entry) => {
    return !(entry.chain === wallet.chain && entry.address === wallet.address);
  });
  nextWallets.push(wallet);
  nextWallets.sort((left, right) => right.pnlScore - left.pnlScore || left.label.localeCompare(right.label));
  persistStateIfNeeded(statePath, {
    ...state,
    trackedWallets: nextWallets,
  }, details.persist);
  return wallet;
}

function getTrackedWallets(options = {}) {
  const { state } = resolveState(options);
  const chain = options.chain ? normalizeChain(options.chain) : null;
  return state.trackedWallets
    .filter((wallet) => !chain || wallet.chain === chain)
    .map((wallet) => ({ ...wallet }));
}

async function getRecentMoves(options = {}) {
  const trackedWallets = getTrackedWallets(options);
  const trackedByAddress = new Map(trackedWallets.map((wallet) => [`${wallet.chain}:${wallet.address}`, wallet]));
  const chain = options.chain ? normalizeChain(options.chain) : null;
  const minValue = Math.max(0, toNumber(options.minValue, 0));
  const since = toIsoTimestamp(options.since, null);
  const sinceTime = since ? new Date(since).getTime() : null;

  let rawMoves = [];
  if (Array.isArray(options.mockMoves)) {
    rawMoves = options.mockMoves;
  } else if (typeof options.provider === 'function') {
    rawMoves = await options.provider({
      wallets: trackedWallets,
      config: resolveWalletTrackerConfig(options.env || process.env),
      fetch: options.fetch,
      options,
    });
  } else {
    rawMoves = [];
  }

  const normalizedMoves = rawMoves.map(normalizeMove).filter((move) => {
    const wallet = trackedByAddress.get(`${move.chain}:${move.address}`);
    if (!wallet) return false;
    if (chain && move.chain !== chain) return false;
    if (move.usdValue < minValue) return false;
    if (sinceTime && new Date(move.timestamp).getTime() < sinceTime) return false;
    return true;
  }).map((move) => {
    const wallet = trackedByAddress.get(`${move.chain}:${move.address}`);
    return {
      ...move,
      walletLabel: wallet?.label || move.address,
      walletPnlScore: wallet?.pnlScore || 0,
    };
  });

  normalizedMoves.sort((left, right) => new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime());
  const limit = Math.max(0, Math.floor(toNumber(options.limit, normalizedMoves.length || 0)));
  return limit > 0 ? normalizedMoves.slice(0, limit) : normalizedMoves;
}

async function getConvergenceSignals(options = {}) {
  const moves = Array.isArray(options.moves) ? options.moves.map(normalizeMove) : await getRecentMoves(options);
  const trackedWallets = getTrackedWallets(options);
  const trackedByAddress = new Map(trackedWallets.map((wallet) => [`${wallet.chain}:${wallet.address}`, wallet]));
  const minWalletCount = Math.max(2, Math.floor(toNumber(options.minWalletCount, 2)));
  const minUsdValue = Math.max(0, toNumber(options.minUsdValue, 0));
  const sideFilter = toText(options.side, 'buy').toLowerCase();
  const grouped = new Map();

  for (const move of moves) {
    if (sideFilter !== 'all' && move.side !== sideFilter) continue;
    const key = `${move.chain}:${move.tokenAddress || move.token}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        token: move.token,
        symbol: move.symbol,
        tokenAddress: move.tokenAddress,
        chain: move.chain,
        walletSet: new Set(),
        wallets: [],
        totalUsdValue: 0,
        netUsdValue: 0,
        latestTimestamp: move.timestamp,
      });
    }

    const bucket = grouped.get(key);
    const wallet = trackedByAddress.get(`${move.chain}:${move.address}`);
    if (!bucket.walletSet.has(move.address)) {
      bucket.walletSet.add(move.address);
      bucket.wallets.push({
        address: move.address,
        label: wallet?.label || move.address,
        pnlScore: wallet?.pnlScore || 0,
      });
    }
    bucket.totalUsdValue += move.usdValue;
    bucket.netUsdValue += move.side === 'buy' ? move.usdValue : -move.usdValue;
    if (new Date(move.timestamp).getTime() > new Date(bucket.latestTimestamp).getTime()) {
      bucket.latestTimestamp = move.timestamp;
    }
  }

  return Array.from(grouped.values()).map((bucket) => {
    const walletCount = bucket.walletSet.size;
    const averagePnlScore = walletCount > 0
      ? bucket.wallets.reduce((sum, wallet) => sum + wallet.pnlScore, 0) / walletCount
      : 0;
    const strength = Math.min(1, ((walletCount / 4) * 0.5) + (Math.min(bucket.totalUsdValue, 50000) / 50000 * 0.25) + (Math.min(averagePnlScore, 100) / 100 * 0.25));
    const confidence = Math.min(1, ((walletCount / 5) * 0.5) + (Math.min(averagePnlScore, 100) / 100 * 0.3) + (Math.min(Math.max(bucket.netUsdValue, 0), 25000) / 25000 * 0.2));
    return {
      token: bucket.token,
      symbol: bucket.symbol,
      tokenAddress: bucket.tokenAddress,
      chain: bucket.chain,
      walletCount,
      wallets: bucket.wallets.sort((left, right) => right.pnlScore - left.pnlScore),
      averagePnlScore: Number(averagePnlScore.toFixed(2)),
      totalUsdValue: Number(bucket.totalUsdValue.toFixed(2)),
      netUsdValue: Number(bucket.netUsdValue.toFixed(2)),
      latestTimestamp: bucket.latestTimestamp,
      strength: Number(strength.toFixed(4)),
      confidence: Number(confidence.toFixed(4)),
    };
  }).filter((signal) => signal.walletCount >= minWalletCount && signal.totalUsdValue >= minUsdValue)
    .sort((left, right) => {
      if (right.strength !== left.strength) return right.strength - left.strength;
      if (right.walletCount !== left.walletCount) return right.walletCount - left.walletCount;
      return right.totalUsdValue - left.totalUsdValue;
    });
}

module.exports = {
  DEFAULT_WALLET_TRACKER_STATE_PATH,
  getConvergenceSignals,
  getRecentMoves,
  getTrackedWallets,
  normalizeChain,
  readWalletTrackerState,
  resolveWalletTrackerConfig,
  trackWallet,
  writeWalletTrackerState,
};
