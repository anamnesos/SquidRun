#!/usr/bin/env node
'use strict';

/**
 * hm-defi-execute.js - DeFi execution pipeline
 *
 * Bridges ETH from mainnet to Arbitrum, swaps to USDC, deposits to Hyperliquid,
 * and opens a leveraged perp position.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });
const { resolveCoordPath } = require('../config');
const { withManualHyperliquidActivity } = require('../modules/trading/hyperliquid-manual-activity');
const bracketManager = require('../modules/trading/bracket-manager');
const agentPositionAttribution = require('../modules/trading/agent-position-attribution');

// ── Contract addresses ──────────────────────────────────────────────
const CONTRACTS = {
  ARB_INBOX: '0x4Dbd4fc535Ac27206064B68FfCf827b0A60BAB3f',
  USDC_ARBITRUM: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  HL_BRIDGE: '0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7',
  UNISWAP_ROUTER: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
  WETH_ARBITRUM: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
};

const TRADE_CONFIG = {
  direction: 'SHORT',
  asset: 'ETH',
  leverage: 5,
  margin: null,
  reserveUsdc: 5,
  stopLossPct: 0.15,
  takeProfitPct1: 0.07,
  takeProfitPct2: 0.12,
  signalConfidence: 0.7,
  minRiskPct: 0.0035,
  maxRiskPct: 0.015,
  rewardToRiskRatio: 2.2,
  volatilityLookbackBars: 40,
  volatilityAtrPeriod: 14,
};
const HYPERLIQUID_MIN_ORDER_NOTIONAL_USD = 10;
const FRESH_CLEARINGHOUSE_STATE_MAX_AGE_MS = 10 * 1000;

const isDryRun = process.argv.includes('--dry-run');
const noStopLoss = process.argv.includes('--no-stop');
const DEFAULT_HYPERLIQUID_CALL_TIMEOUT_MS = Math.max(
  5000,
  Number.parseInt(process.env.SQUIDRUN_HYPERLIQUID_CALL_TIMEOUT_MS || '45000', 10) || 45000
);
const TRADING_WRITES_LOG_PATH = resolveCoordPath(
  path.join('runtime', 'trading-writes.log'),
  { forWrite: true }
);
function resolveWalletAddress(env = process.env) {
  return String(
    env.HYPERLIQUID_WALLET_ADDRESS
    || env.HYPERLIQUID_ADDRESS
    || ''
  ).trim();
}

function ensureDeFiSecrets() {
  const privateKey = process.env.HYPERLIQUID_PRIVATE_KEY;
  const walletAddress = resolveWalletAddress(process.env);
  if (!privateKey || !walletAddress) {
    throw new Error('Missing HYPERLIQUID_PRIVATE_KEY or Hyperliquid wallet address in .env');
  }
  return { privateKey, walletAddress };
}

function log(msg) {
  console.log(`[defi] ${msg}`);
}

function warn(msg) {
  console.log(`[defi][WARN] ${msg}`);
}

function err(msg) {
  console.error(`[defi][ERROR] ${msg}`);
}

function appendTradingWriteAudit(entry = {}) {
  try {
    fs.mkdirSync(path.dirname(TRADING_WRITES_LOG_PATH), { recursive: true });
    fs.appendFileSync(
      TRADING_WRITES_LOG_PATH,
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        pid: process.pid,
        ...entry,
      })}\n`,
      'utf8'
    );
    return true;
  } catch {
    return false;
  }
}

function captureCallerStack(options = {}) {
  const explicit = typeof options.stack === 'string' ? options.stack.trim() : '';
  if (explicit) return explicit;
  const stack = new Error().stack || '';
  return stack
    .split('\n')
    .slice(2)
    .join('\n')
    .trim();
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toNonNegativeInteger(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return fallback;
  return Math.floor(numeric);
}

function isRateLimitError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return (
    message.includes('429')
    || message.includes('too many connections')
    || message.includes('too many requests')
    || message.includes('rate limit')
    || message.includes('rate-limited')
  );
}

async function paceHyperliquidOrder(executionOptions = {}) {
  const retryDelayMs = toNonNegativeInteger(executionOptions.retryDelayMs, 0);
  if (retryDelayMs <= 0) return;
  const state = executionOptions.state || (executionOptions.state = {});
  const lastOrderAt = toNonNegativeInteger(state.lastOrderAt, 0);
  if (lastOrderAt <= 0) return;
  const elapsedMs = Date.now() - lastOrderAt;
  const waitMs = retryDelayMs - elapsedMs;
  if (waitMs > 0) {
    await sleep(waitMs);
  }
}

async function withTimeout(promise, ms = DEFAULT_HYPERLIQUID_CALL_TIMEOUT_MS, label = 'hyperliquid_call') {
  const timeoutMs = Math.max(1, Number(ms) || DEFAULT_HYPERLIQUID_CALL_TIMEOUT_MS);
  let timeoutId = null;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          timeoutId = null;
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        timeoutId?.unref?.();
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  }
}

function resolveRateLimitBackoffMs(executionOptions = {}, attempt = 0) {
  const baseDelayMs = toNonNegativeInteger(executionOptions.retryDelayMs, 500) || 500;
  const jitterMs = toNonNegativeInteger(executionOptions.jitterMs, 250);
  // Increased from 5000ms to 15000ms: observed HL rate-limit windows run 10-30s+;
  // 5s cap meant all retries drained inside the window and bailed.
  const maxDelayMs = toNonNegativeInteger(executionOptions.maxDelayMs, 15000) || 15000;
  const randomValue = typeof executionOptions.randomFn === 'function'
    ? Number(executionOptions.randomFn())
    : Math.random();
  const safeRandom = Number.isFinite(randomValue) ? Math.min(Math.max(randomValue, 0), 1) : 0;
  const exponentialDelayMs = Math.min(baseDelayMs * (2 ** Math.max(0, attempt)), maxDelayMs);
  const jitterDelayMs = jitterMs > 0 ? Math.round(safeRandom * jitterMs) : 0;
  return exponentialDelayMs + jitterDelayMs;
}

async function executeHyperliquidInfoCall(factory, executionOptions = {}) {
  if (typeof factory !== 'function') {
    throw new Error('executeHyperliquidInfoCall requires a call factory function');
  }
  const timeoutMs = toNonNegativeInteger(
    executionOptions.timeoutMs,
    DEFAULT_HYPERLIQUID_CALL_TIMEOUT_MS
  ) || DEFAULT_HYPERLIQUID_CALL_TIMEOUT_MS;
  const label = String(executionOptions.label || 'hyperliquidInfo');
  // Increased from 3 to 7: 8 attempts with exp backoff+jitter up to 15s cap gives
  // ~75s total retry window, enough for a typical HL rate-limit window to clear.
  const maxRetries = toNonNegativeInteger(executionOptions.maxRetries, 7);
  const callerStack = captureCallerStack(executionOptions);

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    appendTradingWriteAudit({
      type: 'hyperliquid_info_attempt',
      label,
      attempt,
      maxRetries,
      timeoutMs,
      callerStack,
    });
    try {
      const result = await withTimeout(factory(), timeoutMs, label);
      appendTradingWriteAudit({
        type: 'hyperliquid_info_result',
        label,
        attempt,
        callerStack,
      });
      return result;
    } catch (error) {
      appendTradingWriteAudit({
        type: 'hyperliquid_info_error',
        label,
        attempt,
        error: error?.message || String(error),
        callerStack,
      });
      if (!isRateLimitError(error) || attempt >= maxRetries) {
        throw error;
      }
      const backoffMs = resolveRateLimitBackoffMs(executionOptions, attempt);
      warn(`${label} rate-limited; retrying in ${backoffMs}ms (attempt ${attempt + 1}/${maxRetries + 1})`);
      await sleep(backoffMs);
    }
  }

  throw new Error(`${label} failed without returning a result`);
}

async function executeHyperliquidOrder(exchange, payload, executionOptions = {}) {
  const state = executionOptions.state || (executionOptions.state = {});
  const retryDelayMs = toNonNegativeInteger(executionOptions.retryDelayMs, 0);
  const timeoutMs = toNonNegativeInteger(
    executionOptions.timeoutMs,
    DEFAULT_HYPERLIQUID_CALL_TIMEOUT_MS
  ) || DEFAULT_HYPERLIQUID_CALL_TIMEOUT_MS;
  const label = String(executionOptions.label || 'exchangeOrder');
  // Bumped 4 -> 7: same reasoning as executeHyperliquidInfoCall — 5s backoff cap
  // was too short to outlast a real HL rate-limit window.
  const maxRetries = toNonNegativeInteger(executionOptions.maxRetries, 7);
  const callerStack = captureCallerStack(executionOptions);

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    await paceHyperliquidOrder({ retryDelayMs, state });
    appendTradingWriteAudit({
      type: 'hyperliquid_order_attempt',
      label,
      attempt,
      maxRetries,
      retryDelayMs,
      timeoutMs,
      payload,
      callerStack,
    });
    try {
      const result = await withTimeout(exchange.order(payload), timeoutMs, label);
      state.lastOrderAt = Date.now();
      appendTradingWriteAudit({
        type: 'hyperliquid_order_result',
        label,
        attempt,
        payload,
        result,
        callerStack,
      });
      return result;
    } catch (error) {
      state.lastOrderAt = Date.now();
      appendTradingWriteAudit({
        type: 'hyperliquid_order_error',
        label,
        attempt,
        payload,
        error: error?.message || String(error),
        callerStack,
      });
      if (!isRateLimitError(error) || attempt >= maxRetries) {
        throw error;
      }
      const backoffMs = retryDelayMs > 0 ? retryDelayMs : 750;
      warn(`${label} rate-limited; retrying in ${backoffMs}ms (attempt ${attempt + 1}/${maxRetries + 1})`);
      await sleep(backoffMs);
    }
  }

  throw new Error(`${label} failed without returning a result`);
}

async function executeHyperliquidCancel(exchange, payload, executionOptions = {}) {
  const timeoutMs = toNonNegativeInteger(
    executionOptions.timeoutMs,
    DEFAULT_HYPERLIQUID_CALL_TIMEOUT_MS
  ) || DEFAULT_HYPERLIQUID_CALL_TIMEOUT_MS;
  const label = String(executionOptions.label || 'exchangeCancel');
  const maxRetries = toNonNegativeInteger(executionOptions.maxRetries, 7);
  const callerStack = captureCallerStack(executionOptions);
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    appendTradingWriteAudit({
      type: 'hyperliquid_cancel_attempt',
      label,
      attempt,
      maxRetries,
      timeoutMs,
      payload,
      callerStack,
    });
    try {
      const result = await withTimeout(exchange.cancel(payload), timeoutMs, label);
      appendTradingWriteAudit({
        type: 'hyperliquid_cancel_result',
        label,
        attempt,
        payload,
        result,
        callerStack,
      });
      return result;
    } catch (error) {
      appendTradingWriteAudit({
        type: 'hyperliquid_cancel_error',
        label,
        attempt,
        payload,
        error: error?.message || String(error),
        callerStack,
      });
      if (!isRateLimitError(error) || attempt >= maxRetries) {
        throw error;
      }
      const backoffMs = resolveRateLimitBackoffMs(executionOptions, attempt);
      warn(`${label} rate-limited; retrying in ${backoffMs}ms (attempt ${attempt + 1}/${maxRetries + 1})`);
      await sleep(backoffMs);
    }
  }
  throw new Error(`${label} exhausted ${maxRetries + 1} attempts on rate-limit`);
}

async function executeHyperliquidLeverageUpdate(exchange, payload, executionOptions = {}) {
  const timeoutMs = toNonNegativeInteger(
    executionOptions.timeoutMs,
    DEFAULT_HYPERLIQUID_CALL_TIMEOUT_MS
  ) || DEFAULT_HYPERLIQUID_CALL_TIMEOUT_MS;
  const label = String(executionOptions.label || 'updateLeverage');
  const maxRetries = toNonNegativeInteger(executionOptions.maxRetries, 3);
  const callerStack = captureCallerStack(executionOptions);

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    appendTradingWriteAudit({
      type: 'hyperliquid_leverage_attempt',
      label,
      attempt,
      maxRetries,
      timeoutMs,
      payload,
      callerStack,
    });
    try {
      const result = await withTimeout(exchange.updateLeverage(payload), timeoutMs, label);
      appendTradingWriteAudit({
        type: 'hyperliquid_leverage_result',
        label,
        attempt,
        payload,
        result,
        callerStack,
      });
      return result;
    } catch (error) {
      appendTradingWriteAudit({
        type: 'hyperliquid_leverage_error',
        label,
        attempt,
        payload,
        error: error?.message || String(error),
        callerStack,
      });
      if (!isRateLimitError(error) || attempt >= maxRetries) {
        throw error;
      }
      const backoffMs = resolveRateLimitBackoffMs(executionOptions, attempt);
      warn(`${label} rate-limited; retrying in ${backoffMs}ms (attempt ${attempt + 1}/${maxRetries + 1})`);
      await sleep(backoffMs);
    }
  }

  throw new Error(`${label} failed without returning a result`);
}

function parseCliArgs(argv = process.argv.slice(2)) {
  const positional = [];
  const options = new Map();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '-h') {
      options.set('help', true);
      continue;
    }
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }

    const rawKey = token.slice(2).trim();
    const key = rawKey === 'usage' ? 'help' : rawKey;
    const next = argv[i + 1];
    const value = (!next || next.startsWith('--')) ? true : next;
    if (value !== true) i += 1;
    options.set(key, value);
  }

  return { positional, options };
}

const parsedArgs = parseCliArgs();
const command = parsedArgs.positional[0] || 'status';

function getOption(options, key, fallback = null) {
  if (!options || typeof options.has !== 'function' || !options.has(key)) return fallback;
  return options.get(key);
}

function normalizeAssetName(value, fallback = TRADE_CONFIG.asset) {
  const raw = typeof value === 'string' ? value.trim() : '';
  return (raw || fallback || '').toUpperCase();
}

function normalizeDirection(value, fallback = TRADE_CONFIG.direction) {
  const raw = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (raw === 'BUY') return 'LONG';
  if (raw === 'SELL') return 'SELL';
  if (raw === 'LONG' || raw === 'SHORT') return raw;
  return fallback;
}

function toPositiveNumber(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return numeric;
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toTimestampMs(value) {
  if (value == null || value === '') return 0;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function resolveClearinghouseSnapshotCachedAtMs(executionSnapshot = {}) {
  return toTimestampMs(
    executionSnapshot?.clearinghouseStateCachedAt
    || executionSnapshot?.clearinghouseState?.cachedAt
    || executionSnapshot?.cachedAt
  );
}

function isClearinghouseSnapshotFresh(executionSnapshot = {}, {
  nowMs = Date.now(),
  maxAgeMs = FRESH_CLEARINGHOUSE_STATE_MAX_AGE_MS,
} = {}) {
  if (!executionSnapshot?.clearinghouseState) return false;
  const cachedAtMs = resolveClearinghouseSnapshotCachedAtMs(executionSnapshot);
  if (!cachedAtMs) return false;
  const ageMs = Number(nowMs) - cachedAtMs;
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= maxAgeMs;
}

async function resolveFreshClearinghouseState({
  info,
  walletAddress,
  executionSnapshot = {},
  infoExecutionOptions = {},
  maxAgeMs = FRESH_CLEARINGHOUSE_STATE_MAX_AGE_MS,
  nowMs = Date.now(),
} = {}) {
  if (isClearinghouseSnapshotFresh(executionSnapshot, { nowMs, maxAgeMs })) {
    return executionSnapshot.clearinghouseState;
  }
  if (executionSnapshot?.clearinghouseState) {
    const cachedAtMs = resolveClearinghouseSnapshotCachedAtMs(executionSnapshot);
    warn(
      'Ignoring stale executionSnapshot.clearinghouseState before order placement'
      + `${cachedAtMs ? `; cachedAt=${new Date(cachedAtMs).toISOString()}` : '; missing cachedAt'}`
    );
  }
  try {
    return await executeHyperliquidInfoCall(
      () => info.clearinghouseState({ user: walletAddress }),
      {
        ...infoExecutionOptions,
        label: 'freshClearinghouseState',
      }
    );
  } catch (error) {
    throw new Error(`Fresh clearinghouseState required before Hyperliquid order placement: ${error?.message || error}`);
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, toNumber(value, min)));
}

function normalizeConfidence(value, fallback = TRADE_CONFIG.signalConfidence) {
  return clamp(toNumber(value, fallback), 0.5, 0.99);
}

function stripTrailingZeros(numericString) {
  const value = String(numericString || '').trim();
  if (!value.includes('.')) {
    return value;
  }
  return value.replace(/(\.\d*?[1-9])0+$/u, '$1').replace(/\.0*$/u, '');
}

function countSignificantFigures(value) {
  const normalized = stripTrailingZeros(String(value || '').trim()).replace('-', '');
  if (!normalized) return 0;
  const digits = normalized.replace('.', '');
  const trimmed = digits.replace(/^0+/u, '');
  return trimmed.length;
}

function resolvePerpPriceDecimals(referencePrice, szDecimals = 0) {
  const maxDecimals = clamp(6 - Math.max(0, Number(szDecimals) || 0), 0, 6);
  const numeric = Math.abs(toNumber(referencePrice, 0));
  if (!Number.isFinite(numeric) || numeric === 0) {
    return maxDecimals;
  }
  for (let decimals = maxDecimals; decimals >= 0; decimals -= 1) {
    const candidate = stripTrailingZeros(numeric.toFixed(decimals));
    if (!candidate.includes('.')) {
      return decimals;
    }
    if (countSignificantFigures(candidate) <= 5) {
      return decimals;
    }
  }
  return 0;
}

function resolvePricePrecision(referencePrice, szDecimals = 0) {
  return resolvePerpPriceDecimals(referencePrice, szDecimals);
}

function resolveSafeStopDistancePct(stopDistancePct, leverageValue) {
  const normalizedStopDistancePct = clamp(toNumber(stopDistancePct, 0), 0.003, 0.25);
  const normalizedLeverage = Math.max(1, toPositiveNumber(leverageValue, TRADE_CONFIG.leverage) || TRADE_CONFIG.leverage);
  const approximateLiquidationDistancePct = 1 / normalizedLeverage;
  const bufferedMaxStopDistancePct = clamp(
    approximateLiquidationDistancePct * 0.6,
    0.003,
    0.18
  );
  return Math.min(normalizedStopDistancePct, bufferedMaxStopDistancePct);
}

function assertStopLossBeforeLiquidation({
  stopPrice,
  liquidationPx,
  isLong,
  referencePrice = stopPrice,
  szDecimals = 0,
  asset = 'position',
} = {}) {
  const normalizedStopPrice = toNumber(stopPrice, NaN);
  const normalizedLiquidationPx = toNumber(liquidationPx, NaN);
  if (!Number.isFinite(normalizedStopPrice) || !Number.isFinite(normalizedLiquidationPx) || normalizedLiquidationPx <= 0) {
    return true;
  }
  const stopLabel = formatPrice(normalizedStopPrice, referencePrice, szDecimals);
  const liquidationLabel = formatPrice(normalizedLiquidationPx, referencePrice, szDecimals);
  const assetLabel = String(asset || 'position').trim() || 'position';
  if (isLong && normalizedStopPrice <= normalizedLiquidationPx) {
    throw new Error(`${assetLabel} long stop loss ${stopLabel} is at or below liquidation ${liquidationLabel}; refusing unsafe stop`);
  }
  if (!isLong && normalizedStopPrice >= normalizedLiquidationPx) {
    throw new Error(`${assetLabel} short stop loss ${stopLabel} is at or above liquidation ${liquidationLabel}; refusing unsafe stop`);
  }
  return true;
}

function constrainStopPriceWithinLiquidationBuffer({
  stopPrice,
  entryPrice,
  liquidationPx,
  isLong,
  referencePrice = entryPrice,
  szDecimals = 0,
} = {}) {
  const normalizedStopPrice = toNumber(stopPrice, NaN);
  const normalizedEntryPrice = toNumber(entryPrice, NaN);
  const normalizedLiquidationPx = toNumber(liquidationPx, NaN);
  if (!Number.isFinite(normalizedStopPrice) || !Number.isFinite(normalizedLiquidationPx) || normalizedLiquidationPx <= 0) {
    return normalizedStopPrice;
  }
  const assertSafeStop = (candidateStopPrice) => assertStopLossBeforeLiquidation({
    stopPrice: candidateStopPrice,
    liquidationPx: normalizedLiquidationPx,
    isLong,
    referencePrice,
    szDecimals,
  });
  if (!Number.isFinite(normalizedEntryPrice)) {
    assertSafeStop(normalizedStopPrice);
    return normalizedStopPrice;
  }
  const liquidationGap = Math.abs(normalizedLiquidationPx - normalizedEntryPrice);
  if (!Number.isFinite(liquidationGap) || liquidationGap <= 0) {
    assertSafeStop(normalizedStopPrice);
    return normalizedStopPrice;
  }

  const minBufferGap = Math.max(
    Math.abs(normalizedEntryPrice) * 0.0025,
    liquidationGap * 0.12
  );
  if (isLong) {
    const floor = normalizedLiquidationPx + minBufferGap;
    const ceiling = normalizedEntryPrice * 0.9995;
    if (floor >= ceiling) {
      assertSafeStop(normalizedStopPrice);
      return normalizedStopPrice;
    }
    const constrainedStopPrice = roundPrice(
      clamp(normalizedStopPrice, floor, ceiling),
      referencePrice,
      szDecimals
    );
    assertSafeStop(constrainedStopPrice);
    return constrainedStopPrice;
  }

  const floor = normalizedEntryPrice * 1.0005;
  const ceiling = normalizedLiquidationPx - minBufferGap;
  if (ceiling <= floor) {
    assertSafeStop(normalizedStopPrice);
    return normalizedStopPrice;
  }
  const constrainedStopPrice = roundPrice(
    clamp(normalizedStopPrice, floor, ceiling),
    referencePrice,
    szDecimals
  );
  assertSafeStop(constrainedStopPrice);
  return constrainedStopPrice;
}

function roundPrice(value, referencePrice = value, szDecimals = 0) {
  const numeric = toNumber(value, NaN);
  if (!Number.isFinite(numeric)) return NaN;
  return Number(formatPrice(numeric, referencePrice, szDecimals));
}

function formatPrice(value, referencePrice = value, szDecimals = 0) {
  const numeric = toNumber(value, NaN);
  if (!Number.isFinite(numeric)) {
    throw new Error('price must be finite');
  }
  let decimals = resolvePerpPriceDecimals(referencePrice, szDecimals);
  let candidate = stripTrailingZeros(numeric.toFixed(decimals));
  // Hyperliquid enforces max 5 significant figures per price tick rule
  while (candidate && countSignificantFigures(candidate) > 5 && decimals > 0) {
    decimals--;
    candidate = stripTrailingZeros(numeric.toFixed(decimals));
  }
  if (!candidate) {
    throw new Error('price formatting failed');
  }
  return candidate;
}

function roundDown(value, decimals = 6) {
  const numeric = toNumber(value, 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  const factor = 10 ** Math.max(0, Number(decimals) || 0);
  return Math.floor(numeric * factor) / factor;
}

function normalizeHistoricalBars(bars = []) {
  return (Array.isArray(bars) ? bars : [])
    .map((bar) => ({
      open: toNumber(bar?.open ?? bar?.o, 0),
      high: toNumber(bar?.high ?? bar?.h, 0),
      low: toNumber(bar?.low ?? bar?.l, 0),
      close: toNumber(bar?.close ?? bar?.c, 0),
    }))
    .filter((bar) => bar.high > 0 && bar.low > 0 && bar.close > 0);
}

function calculateAtr(bars = [], period = TRADE_CONFIG.volatilityAtrPeriod) {
  const normalizedBars = normalizeHistoricalBars(bars);
  if (normalizedBars.length === 0) return null;
  const trValues = normalizedBars.map((bar, index) => {
    const previousClose = index > 0 ? normalizedBars[index - 1].close : bar.close;
    return Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - previousClose),
      Math.abs(bar.low - previousClose)
    );
  }).filter((value) => Number.isFinite(value) && value > 0);
  if (trValues.length === 0) return null;
  const window = trValues.slice(-Math.max(1, Number(period) || TRADE_CONFIG.volatilityAtrPeriod));
  const atr = window.reduce((sum, value) => sum + value, 0) / window.length;
  return Number.isFinite(atr) && atr > 0 ? atr : null;
}

function buildVolatilitySnapshot({
  historicalBars = [],
  midPrice,
  stopLossPct = TRADE_CONFIG.stopLossPct,
  takeProfitPct2 = TRADE_CONFIG.takeProfitPct2,
} = {}) {
  const entryPrice = toNumber(midPrice, 0);
  const normalizedBars = normalizeHistoricalBars(historicalBars);
  const atr = calculateAtr(normalizedBars);
  const averageRangePct = normalizedBars.length > 0
    ? normalizedBars.reduce((sum, bar) => {
      const denominator = bar.close > 0 ? bar.close : entryPrice;
      return sum + ((bar.high - bar.low) / Math.max(denominator, 0.0000001));
    }, 0) / normalizedBars.length
    : null;
  const atrPct = atr && entryPrice > 0 ? atr / entryPrice : null;
  const fallbackStopDistancePct = clamp(toPositiveNumber(stopLossPct, TRADE_CONFIG.stopLossPct) || TRADE_CONFIG.stopLossPct, 0.01, 0.2);
  const fallbackTakeProfitDistancePct = clamp(
    toPositiveNumber(takeProfitPct2, TRADE_CONFIG.takeProfitPct2) || TRADE_CONFIG.takeProfitPct2,
    0.02,
    0.4
  );
  const computedStopDistancePct = atrPct
    ? clamp(
      Math.max(
        atrPct * 1.35,
        toNumber(averageRangePct, 0) * 1.1,
        fallbackStopDistancePct * 0.45
      ),
      0.01,
      0.18
    )
    : fallbackStopDistancePct;
  const computedTakeProfitDistancePct = clamp(
    Math.max(
      computedStopDistancePct * TRADE_CONFIG.rewardToRiskRatio,
      atrPct ? atrPct * 2.4 : 0,
      fallbackTakeProfitDistancePct * 0.75
    ),
    computedStopDistancePct * 1.25,
    0.4
  );
  return {
    source: normalizedBars.length > 0 ? 'recent_hyperliquid_bars' : 'fallback_percentages',
    barCount: normalizedBars.length,
    atr,
    atrPct: atrPct ? Number(atrPct.toFixed(6)) : null,
    averageRangePct: averageRangePct ? Number(averageRangePct.toFixed(6)) : null,
    stopDistancePct: Number(computedStopDistancePct.toFixed(6)),
    takeProfitDistancePct: Number(computedTakeProfitDistancePct.toFixed(6)),
  };
}

function getHyperliquidClientModule() {
  return require('../modules/trading/hyperliquid-client');
}

async function resolveVolatilitySnapshot(options = {}) {
  if (options.volatilitySnapshot && typeof options.volatilitySnapshot === 'object') {
    return options.volatilitySnapshot;
  }
  if (Array.isArray(options.historicalBars)) {
    return buildVolatilitySnapshot({
      historicalBars: options.historicalBars,
      midPrice: options.midPrice,
      stopLossPct: options.stopLossPct,
      takeProfitPct2: options.takeProfitPct2,
    });
  }
  if (!options.infoClient || !options.asset) {
    return buildVolatilitySnapshot({
      historicalBars: [],
      midPrice: options.midPrice,
      stopLossPct: options.stopLossPct,
      takeProfitPct2: options.takeProfitPct2,
    });
  }
  if (typeof options.infoClient.candleSnapshot !== 'function') {
    return buildVolatilitySnapshot({
      historicalBars: [],
      midPrice: options.midPrice,
      stopLossPct: options.stopLossPct,
      takeProfitPct2: options.takeProfitPct2,
    });
  }

  const barsBySymbol = await getHyperliquidClientModule().getHistoricalBars({
    infoClient: options.infoClient,
    symbols: [`${normalizeAssetName(options.asset)}/USD`],
    timeframe: '1Hour',
    limit: Math.max(20, Number(options.volatilityLookbackBars) || TRADE_CONFIG.volatilityLookbackBars),
  }).catch(() => new Map());
  const historicalBars = barsBySymbol instanceof Map
    ? (barsBySymbol.get(`${normalizeAssetName(options.asset)}/USD`) || [])
    : [];
  return buildVolatilitySnapshot({
    historicalBars,
    midPrice: options.midPrice,
    stopLossPct: options.stopLossPct,
    takeProfitPct2: options.takeProfitPct2,
  });
}

function parseTradeOptions(argv = parsedArgs) {
  const options = argv?.options instanceof Map ? argv.options : new Map();
  const rawDirection = String(getOption(options, 'direction', TRADE_CONFIG.direction) || '').trim().toUpperCase();
  return {
    asset: normalizeAssetName(getOption(options, 'asset', TRADE_CONFIG.asset), TRADE_CONFIG.asset),
    directionInput: rawDirection || String(TRADE_CONFIG.direction || '').trim().toUpperCase(),
    direction: normalizeDirection(rawDirection || TRADE_CONFIG.direction, TRADE_CONFIG.direction),
    leverage: toPositiveNumber(getOption(options, 'leverage', TRADE_CONFIG.leverage), TRADE_CONFIG.leverage),
    margin: toPositiveNumber(getOption(options, 'margin', TRADE_CONFIG.margin), TRADE_CONFIG.margin),
    stopLossPrice: toPositiveNumber(getOption(options, 'stop-loss', null), null),
    takeProfitPrice: toPositiveNumber(getOption(options, 'take-profit', null), null),
    signalConfidence: normalizeConfidence(getOption(options, 'confidence', TRADE_CONFIG.signalConfidence)),
    notional: toPositiveNumber(getOption(options, 'notional', null), null),
    maxNotional: toPositiveNumber(getOption(options, 'max-notional', null), null),
    retryDelayMs: toNonNegativeInteger(getOption(options, 'retry-delay', 0), 0),
    clientOrderId: normalizeClientOrderId(getOption(options, 'client-order-id', null)),
    reserveUsdc: TRADE_CONFIG.reserveUsdc,
    stopLossPct: TRADE_CONFIG.stopLossPct,
    takeProfitPct1: TRADE_CONFIG.takeProfitPct1,
    takeProfitPct2: TRADE_CONFIG.takeProfitPct2,
    dryRun: Boolean(getOption(options, 'dry-run', false) || isDryRun),
  };
}

function formatHelpText() {
  return [
    'hm-defi-execute.js - Hyperliquid DeFi execution pipeline.',
    '',
    'Usage:',
    '  node ui/scripts/hm-defi-execute.js [status|bridge|swap|deposit|trade|stop-loss|full-send] [options]',
    '  node ui/scripts/hm-defi-execute.js --help',
    '  node ui/scripts/hm-defi-execute.js -h',
    '  node ui/scripts/hm-defi-execute.js --usage',
    '',
    'Trade options:',
    '  --asset <ASSET>',
    '  --direction LONG|SHORT|BUY|SELL',
    '  --leverage <N>',
    '  --margin <USD>',
    '  --notional <USD>',
    '  --max-notional <USD>',
    '  --confidence <0.0-1.0>',
    '  --stop-loss <PRICE>',
    '  --take-profit <PRICE>',
    '  --retry-delay <MS>',
    '  --client-order-id <KEY>',
    '  --dry-run',
    '  --no-stop',
    '',
    'Safety:',
    '  Help/usage exits before any wallet, client, or live execution path is initialized.',
  ].join('\n');
}

function normalizeClientOrderId(value) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!raw) return null;
  if (/^0x[a-f0-9]{32}$/i.test(raw)) {
    return raw;
  }
  const hashed = crypto.createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 32);
  return `0x${hashed}`;
}

function buildClientOrderIdFingerprint(parts = []) {
  return normalizeClientOrderId(parts.map((part) => String(part || '').trim()).filter(Boolean).join('|'));
}

function resolveTradeClientOrderId(tradeRequest = {}, tradePlan = {}, options = {}) {
  const explicit = normalizeClientOrderId(
    tradeRequest.clientOrderId
    || options.clientOrderId
    || options.idempotencyKey
    || null
  );
  if (explicit) return explicit;
  return null;
}

function buildAllMidsFromUniverseMarketData(marketData = []) {
  const mids = {};
  for (const entry of Array.isArray(marketData) ? marketData : []) {
    const coin = normalizeAssetName(entry?.coin || entry?.ticker || '', '');
    const price = Number(entry?.price);
    if (!coin || !Number.isFinite(price) || price <= 0) continue;
    mids[coin] = String(price);
  }
  return mids;
}

function normalizeHyperliquidOrderStatus(value) {
  return String(value || '').trim().toLowerCase();
}

function isBlockingExistingHyperliquidOrder(status = '') {
  const normalized = normalizeHyperliquidOrderStatus(status);
  if (!normalized || normalized === 'unknownoid') return false;
  if ([
    'canceled',
    'rejected',
    'scheduledcancel',
    'margincanceled',
    'vaultwithdrawalcanceled',
    'openinterestcapcanceled',
    'selftradecanceled',
    'reduceonlycanceled',
    'siblingfilledcanceled',
    'delistedcanceled',
    'liquidatedcanceled',
    'tickrejected',
    'mintradentlrejected',
    'perpmarginrejected',
    'reduceonlyrejected',
    'badalopxrejected',
    'ioccancelrejected',
    'badtriggerpxrejected',
    'marketordernoliquidityrejected',
    'positionincreaseatopeninterestcaprejected',
    'positionflipatopeninterestcaprejected',
    'tooaggressiveatopeninterestcaprejected',
    'openinterestincreaserejected',
    'insufficientspotbalancerejected',
    'oraclerejected',
    'perpmaxpositionrejected',
  ].includes(normalized)) {
    return false;
  }
  return true;
}

function extractHyperliquidOrderId(result = null) {
  const queue = [result];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== 'object') continue;

    if (current.resting?.oid != null) return current.resting.oid;
    if (current.filled?.oid != null) return current.filled.oid;
    if (current.order?.oid != null) return current.order.oid;
    if (current.oid != null && (typeof current.oid === 'string' || typeof current.oid === 'number')) {
      return current.oid;
    }

    if (Array.isArray(current.statuses)) queue.push(...current.statuses);
    if (Array.isArray(current.responses)) queue.push(...current.responses);
    if (Array.isArray(current.orders)) queue.push(...current.orders);
    if (current.response) queue.push(current.response);
    if (current.data) queue.push(current.data);
  }
  return null;
}

function readTradingWriteAuditEntries(logPath = TRADING_WRITES_LOG_PATH, limit = 500) {
  const resolvedPath = String(logPath || TRADING_WRITES_LOG_PATH || '').trim();
  if (!resolvedPath || !fs.existsSync(resolvedPath)) {
    return [];
  }
  try {
    const content = fs.readFileSync(resolvedPath, 'utf8');
    const lines = content.split(/\r?\n/u).filter(Boolean);
    const sliced = limit > 0 ? lines.slice(-limit) : lines;
    return sliced.map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function isSuccessfulHyperliquidAuditResult(result = null) {
  const normalizedStatus = normalizeHyperliquidOrderStatus(result?.status);
  return !normalizedStatus || normalizedStatus === 'ok' || normalizedStatus === 'success';
}

function findLatestActiveHyperliquidTriggerOrderFromAudit({
  logPath = TRADING_WRITES_LOG_PATH,
  entries = null,
  assetIndex = null,
  tpsl = 'sl',
  limit = 500,
} = {}) {
  const normalizedTpsl = String(tpsl || '').trim().toLowerCase();
  const resolvedEntries = Array.isArray(entries) ? entries : readTradingWriteAuditEntries(logPath, limit);
  const canceledOrderIds = new Set();

  for (let index = resolvedEntries.length - 1; index >= 0; index -= 1) {
    const entry = resolvedEntries[index];
    if (!entry || typeof entry !== 'object') continue;

    if (entry.type === 'hyperliquid_cancel_result' && isSuccessfulHyperliquidAuditResult(entry.result)) {
      const cancels = Array.isArray(entry?.payload?.cancels) ? entry.payload.cancels : [];
      for (const cancel of cancels) {
        if (assetIndex != null && Number(cancel?.a) !== Number(assetIndex)) continue;
        if (cancel?.o != null) {
          canceledOrderIds.add(String(cancel.o).trim());
        }
      }
      continue;
    }

    if (entry.type !== 'hyperliquid_order_result' || !isSuccessfulHyperliquidAuditResult(entry.result)) {
      continue;
    }

    const orders = Array.isArray(entry?.payload?.orders) ? entry.payload.orders : [];
    const matchingOrder = orders.find((order) => {
      if (assetIndex != null && Number(order?.a) !== Number(assetIndex)) return false;
      const triggerType = String(order?.t?.trigger?.tpsl || '').trim().toLowerCase();
      return normalizedTpsl ? triggerType === normalizedTpsl : true;
    });
    if (!matchingOrder) continue;

    const oid = extractHyperliquidOrderId(entry.result);
    if (oid == null) continue;
    const normalizedOid = String(oid).trim();
    if (!normalizedOid || canceledOrderIds.has(normalizedOid)) continue;

    return {
      oid,
      label: entry.label || null,
      timestamp: entry.timestamp || null,
      order: matchingOrder,
      entry,
    };
  }

  return null;
}

async function getExistingHyperliquidOrderByCloid(info, walletAddress, cloid) {
  if (!info || typeof info.orderStatus !== 'function' || !walletAddress || !cloid) {
    return null;
  }
  try {
    const status = await executeHyperliquidInfoCall(
      () => info.orderStatus({ user: walletAddress, oid: cloid }),
      {
        label: 'orderStatus',
      }
    );
    if (!status || status.status === 'unknownOid') {
      return null;
    }
    return {
      cloid,
      status: normalizeHyperliquidOrderStatus(status?.order?.status || status?.status || ''),
      order: status?.order?.order || null,
      statusTimestamp: Number(status?.order?.statusTimestamp || 0) || null,
      raw: status,
    };
  } catch {
    return null;
  }
}

function extractFilledHyperliquidOrder(result = null) {
  const queue = [result];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== 'object') continue;

    if (current.filled && typeof current.filled === 'object') {
      const size = Number(current.filled.totalSz || current.filled.sz || 0);
      const entryPx = Number(current.filled.avgPx || current.filled.px || 0);
      if (Number.isFinite(size) && size > 0 && Number.isFinite(entryPx) && entryPx > 0) {
        return {
          absSize: size,
          entryPx,
          oid: current.filled.oid != null ? current.filled.oid : null,
        };
      }
    }

    if (Array.isArray(current.statuses)) queue.push(...current.statuses);
    if (Array.isArray(current.responses)) queue.push(...current.responses);
    if (Array.isArray(current.orders)) queue.push(...current.orders);
    if (current.response) queue.push(current.response);
    if (current.data) queue.push(current.data);
  }
  return null;
}

function findAssetMeta(meta, assetName) {
  const normalized = normalizeAssetName(assetName);
  const universe = Array.isArray(meta?.universe) ? meta.universe : [];
  const asset = universe.find((entry) => normalizeAssetName(entry?.name, '') === normalized);
  if (!asset) return null;
  return {
    asset,
    assetIndex: universe.indexOf(asset),
  };
}

function resolveAssetMaxLeverage(assetMeta = null, fallback = TRADE_CONFIG.leverage) {
  const maxLeverage = toPositiveNumber(
    assetMeta?.asset?.maxLeverage ?? assetMeta?.maxLeverage,
    null
  );
  const fallbackLeverage = toPositiveNumber(fallback, TRADE_CONFIG.leverage);
  if (!maxLeverage) {
    return fallbackLeverage;
  }
  return Math.max(1, Math.floor(maxLeverage));
}

function resolveAssetSzDecimals(assetMeta = null, fallback = 4) {
  const szDecimals = assetMeta?.asset?.szDecimals ?? assetMeta?.szDecimals;
  if (!Number.isFinite(Number(szDecimals))) {
    return Math.max(0, Number(fallback) || 4);
  }
  return Math.max(0, Number(szDecimals));
}

function extractOpenHyperliquidPosition(clearinghouse = {}, assetName = '') {
  const normalizedAsset = normalizeAssetName(assetName, '');
  const assetPositions = Array.isArray(clearinghouse?.assetPositions) ? clearinghouse.assetPositions : [];
  const position = assetPositions
    .map((entry) => entry?.position || {})
    .find((entry) => normalizeAssetName(entry?.coin, '') === normalizedAsset && Math.abs(Number(entry?.szi || 0)) > 0);
  if (!position) {
    return null;
  }
  const signedSize = Number(position?.szi || 0);
  const absSize = Math.abs(signedSize);
  return {
    ...position,
    coin: normalizedAsset,
    signedSize,
    absSize,
    isLong: signedSize > 0,
    side: signedSize > 0 ? 'LONG' : 'SHORT',
    entryPx: Number(position?.entryPx || 0),
  };
}

function shouldCloseAgainstExistingPosition(directionInput, position = null) {
  if (!position) return false;
  const normalizedDirectionInput = String(directionInput || '').trim().toUpperCase();
  if (normalizedDirectionInput === 'BUY') {
    return position.side === 'SHORT';
  }
  if (normalizedDirectionInput === 'SELL') {
    return position.side === 'LONG';
  }
  return false;
}

function buildCloseOrderPlan({ size, midPrice, szDecimals = 0 }) {
  const numericSize = Number(size);
  const numericMidPrice = Number(midPrice);
  if (!Number.isFinite(numericSize) || numericSize === 0) {
    throw new Error('Position size must be non-zero');
  }
  if (!Number.isFinite(numericMidPrice) || numericMidPrice <= 0) {
    throw new Error('Mid price must be positive');
  }

  const isBuy = numericSize < 0;
  const absSize = Math.abs(numericSize);
  const rawLimitPrice = isBuy
    ? numericMidPrice * 1.01
    : numericMidPrice * 0.99;
  const limitPrice = formatPrice(rawLimitPrice, numericMidPrice, szDecimals);

  return {
    isBuy,
    absSize,
    limitPrice,
    sideLabel: isBuy ? 'BUY' : 'SELL',
  };
}

async function cancelAssetOrders({
  info,
  exchange,
  walletAddress,
  asset,
  assetIndex,
} = {}) {
  if (typeof info?.openOrders !== 'function') {
    return [];
  }
  const openOrders = await getHyperliquidClientModule().getOpenOrders({
    walletAddress,
    infoClient: info,
  });
  const cancelled = [];
  for (const order of Array.isArray(openOrders) ? openOrders : []) {
    if (normalizeAssetName(order?.coin, '') !== normalizeAssetName(asset, '')) {
      continue;
    }
    try {
      await executeHyperliquidCancel(exchange, { cancels: [{ a: assetIndex, o: order.oid }] }, {
        label: `cancel_${asset}_${order.oid}`,
      });
      cancelled.push(order.oid);
    } catch (cancelError) {
      warn(`Failed to cancel ${asset} order ${order.oid}: ${cancelError?.message || cancelError}`);
    }
  }
  return cancelled;
}

async function closeExistingHyperliquidPosition({
  info,
  exchange,
  walletAddress,
  asset,
  assetIndex,
  position,
  midPrice,
  szDecimals = 0,
  retryDelayMs = 0,
  timeoutMs,
} = {}) {
  const orderPlan = buildCloseOrderPlan({
    size: position?.signedSize,
    midPrice,
    szDecimals,
  });

  log(`Close intent detected: ${orderPlan.sideLabel} will reduce-only close the existing ${position.side} ${asset} position instead of opening a reverse trade.`);
  log(`Closing ${asset}: ${orderPlan.sideLabel} ${orderPlan.absSize} ${asset} @ limit $${orderPlan.limitPrice} (IOC, reduce-only)`);

  await cancelAssetOrders({
    info,
    exchange,
    walletAddress,
    asset,
    assetIndex,
  });

  const result = await executeHyperliquidOrder(exchange, {
    orders: [{
      a: assetIndex,
      b: orderPlan.isBuy,
      p: orderPlan.limitPrice,
      s: orderPlan.absSize.toString(),
      r: true,
      t: { limit: { tif: 'Ioc' } },
    }],
    grouping: 'na',
  }, {
    retryDelayMs,
    timeoutMs,
    state: { lastOrderAt: 0 },
    label: `close_${asset}`,
  });
  log(`Close order result: ${JSON.stringify(result)}`);

  const updatedClearinghouse = await withTimeout(
    info.clearinghouseState({ user: walletAddress }),
    timeoutMs,
    'postCloseClearinghouseState'
  );
  const remainingPosition = extractOpenHyperliquidPosition(updatedClearinghouse, asset);
  const remainingSize = remainingPosition?.absSize || 0;
  const closedCompletely = remainingSize === 0;
  if (closedCompletely) {
    log(`${asset} close complete. No remaining position.`);
  } else {
    warn(`${asset} close was partial. Remaining ${remainingPosition.side} size: ${remainingSize}`);
  }

  return {
    asset,
    direction: position.side,
    requestedDirection: position.isLong ? 'SELL' : 'BUY',
    closeOnly: true,
    size: position.absSize,
    closedSize: position.absSize - remainingSize,
    remainingSize,
    price: Number(position.entryPx || midPrice || 0),
    closedCompletely,
    warnings: closedCompletely ? [] : ['partial_close_remaining_position'],
  };
}

async function resolveHyperliquidRuntime(options = {}) {
  const credentials = options.credentials || ensureDeFiSecrets();
  if (options.hyperliquidRuntime?.info && options.hyperliquidRuntime?.exchange) {
    return {
      privateKey: credentials.privateKey,
      walletAddress: options.hyperliquidRuntime.walletAddress || credentials.walletAddress,
      info: options.hyperliquidRuntime.info,
      exchange: options.hyperliquidRuntime.exchange,
      privateKeyToAccount: options.hyperliquidRuntime.privateKeyToAccount || null,
    };
  }

  const { HttpTransport, ExchangeClient, InfoClient } = await import('@nktkas/hyperliquid');
  const { privateKeyToAccount } = require('viem/accounts');
  const wallet = privateKeyToAccount(credentials.privateKey);
  const transport = new HttpTransport();

  return {
    ...credentials,
    wallet,
    info: new InfoClient({ transport }),
    exchange: new ExchangeClient({ transport, wallet }),
    privateKeyToAccount,
  };
}

function buildTradePlan({
  asset,
  direction,
  leverage,
  margin,
  notional,
  maxNotional,
  reserveUsdc,
  availableBalance,
  midPrice,
  szDecimals,
  stopLossPrice,
  takeProfitPrice,
  signalConfidence,
  volatilitySnapshot,
  stopLossPct,
  takeProfitPct1,
  takeProfitPct2,
}) {
  const normalizedAsset = normalizeAssetName(asset);
  const normalizedDirection = normalizeDirection(direction);
  const leverageValue = toPositiveNumber(leverage, TRADE_CONFIG.leverage);
  const reserveValue = toPositiveNumber(reserveUsdc, TRADE_CONFIG.reserveUsdc) || TRADE_CONFIG.reserveUsdc;
  const maxCollateral = Math.max(0, Number(availableBalance) - reserveValue);
  const requestedCollateral = toPositiveNumber(margin, null);
  const exactNotional = toPositiveNumber(notional, null);
  const resolvedMaxNotional = toPositiveNumber(maxNotional, null);
  const exactCollateral = exactNotional && leverageValue > 0
    ? exactNotional / leverageValue
    : null;
  if (exactCollateral !== null && exactCollateral > maxCollateral && maxCollateral > 0) {
    throw new Error(`Requested notional ${exactNotional.toFixed(2)} exceeds available collateral ${maxCollateral.toFixed(2)} at ${leverageValue}x leverage`);
  }
  if (exactCollateral === null && requestedCollateral !== null && requestedCollateral > maxCollateral && maxCollateral > 0) {
    throw new Error(`Requested margin ${requestedCollateral} exceeds available collateral ${maxCollateral.toFixed(2)}`);
  }
  const confidence = normalizeConfidence(signalConfidence, TRADE_CONFIG.signalConfidence);
  const entryPrice = toNumber(midPrice, 0);
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    throw new Error('Entry price must be greater than 0');
  }

  const normalizedVolatilitySnapshot = volatilitySnapshot && typeof volatilitySnapshot === 'object'
    ? volatilitySnapshot
    : buildVolatilitySnapshot({
      historicalBars: [],
      midPrice: entryPrice,
      stopLossPct,
      takeProfitPct2,
    });
  const fallbackStopDistancePct = clamp(
    toPositiveNumber(stopLossPct, TRADE_CONFIG.stopLossPct) || TRADE_CONFIG.stopLossPct,
    0.01,
    0.2
  );
  const stopDistancePctFromExplicit = stopLossPrice
    ? Math.abs(entryPrice - Number(stopLossPrice)) / entryPrice
    : null;
  const stopDistancePct = resolveSafeStopDistancePct(
    stopDistancePctFromExplicit || normalizedVolatilitySnapshot.stopDistancePct || fallbackStopDistancePct,
    leverageValue
  );
  const takeProfitDistancePctFromExplicit = takeProfitPrice
    ? Math.abs(Number(takeProfitPrice) - entryPrice) / entryPrice
    : null;
  const takeProfitDistancePct = clamp(
    takeProfitDistancePctFromExplicit
      || normalizedVolatilitySnapshot.takeProfitDistancePct
      || Math.max(stopDistancePct * TRADE_CONFIG.rewardToRiskRatio, takeProfitPct2 || TRADE_CONFIG.takeProfitPct2),
    stopDistancePct * 1.25,
    0.5
  );

  const confidenceOffset = (confidence - 0.5) / 0.49;
  const fixedFractionalRiskPct = clamp(
    TRADE_CONFIG.minRiskPct + (Math.max(0, confidenceOffset) * (TRADE_CONFIG.maxRiskPct - TRADE_CONFIG.minRiskPct) * 0.7),
    TRADE_CONFIG.minRiskPct,
    TRADE_CONFIG.maxRiskPct
  );
  const rawKellyFraction = Math.max(0, confidence - ((1 - confidence) / TRADE_CONFIG.rewardToRiskRatio));
  const kellyRiskPct = clamp(rawKellyFraction * 0.0125, 0, TRADE_CONFIG.maxRiskPct);
  const effectiveRiskPct = clamp(
    (fixedFractionalRiskPct + kellyRiskPct) / 2,
    TRADE_CONFIG.minRiskPct,
    TRADE_CONFIG.maxRiskPct
  );
  const riskBudget = availableBalance * effectiveRiskPct;
  const riskBasedNotional = riskBudget / stopDistancePct;
  const sizingMode = exactCollateral !== null
    ? 'exact_notional'
    : requestedCollateral !== null
      ? 'exact_margin'
      : 'risk_model';
  const riskBasedCollateral = riskBasedNotional / leverageValue;
  const maxCollateralFromNotional = !exactCollateral && resolvedMaxNotional && leverageValue > 0
    ? resolvedMaxNotional / leverageValue
    : null;
  let collateral = exactCollateral !== null
    ? exactCollateral
    : requestedCollateral !== null
      ? requestedCollateral
      : riskBasedCollateral;
  collateral = Math.min(collateral, maxCollateral);

  if (!Number.isFinite(collateral) || collateral <= 0) {
    throw new Error('Collateral must be greater than 0 after risk sizing');
  }

  const requestedNotional = exactNotional
    || (requestedCollateral !== null ? requestedCollateral * leverageValue : riskBasedNotional);
  let maxNotionalApplied = false;
  if (maxCollateralFromNotional !== null && collateral > maxCollateralFromNotional) {
    collateral = maxCollateralFromNotional;
    maxNotionalApplied = true;
  }

  const plannedNotional = collateral * leverageValue;
  const rawSize = plannedNotional / entryPrice;
  const decimals = Number.isFinite(Number(szDecimals)) ? Math.max(0, Number(szDecimals)) : 4;
  const size = roundDown(rawSize, decimals);
  const actualNotional = size * entryPrice;
  const priceDecimals = resolvePricePrecision(entryPrice, decimals);

  if (!Number.isFinite(size) || size <= 0) {
    throw new Error('Position size too small after rounding');
  }
  if (!Number.isFinite(actualNotional) || actualNotional < HYPERLIQUID_MIN_ORDER_NOTIONAL_USD) {
    throw new Error(`Order notional ${actualNotional.toFixed(2)} is below Hyperliquid minimum $${HYPERLIQUID_MIN_ORDER_NOTIONAL_USD.toFixed(2)}`);
  }

  const isLong = normalizedDirection === 'LONG';
  const limitPrice = roundPrice(entryPrice * (isLong ? 1.01 : 0.99), entryPrice, decimals);
  const defaultStopPrice = roundPrice(
    entryPrice * (isLong ? (1 - stopDistancePct) : (1 + stopDistancePct)),
    entryPrice,
    decimals
  );
  const stopPrice = roundPrice(
    toPositiveNumber(stopLossPrice, defaultStopPrice) || defaultStopPrice,
    entryPrice,
    decimals
  );
  const tp1DistancePct = clamp(
    Math.min(takeProfitDistancePct * 0.65, stopDistancePct * Math.max(1.1, toPositiveNumber(takeProfitPct1, TRADE_CONFIG.takeProfitPct1) / Math.max(stopDistancePct, 0.000001))),
    stopDistancePct * 1.1,
    takeProfitDistancePct
  );
  const takeProfitPrice1 = roundPrice(
    entryPrice * (isLong ? (1 + tp1DistancePct) : (1 - tp1DistancePct)),
    entryPrice,
    decimals
  );
  const takeProfitPrice2 = roundPrice(
    toPositiveNumber(takeProfitPrice, null)
      || (entryPrice * (isLong ? (1 + takeProfitDistancePct) : (1 - takeProfitDistancePct))),
    entryPrice,
    decimals
  );

  if (isLong && stopPrice >= entryPrice) {
    throw new Error(`Long stop loss ${formatPrice(stopPrice, entryPrice, decimals)} must be below entry ${formatPrice(entryPrice, entryPrice, decimals)}`);
  }
  if (!isLong && stopPrice <= entryPrice) {
    throw new Error(`Short stop loss ${formatPrice(stopPrice, entryPrice, decimals)} must be above entry ${formatPrice(entryPrice, entryPrice, decimals)}`);
  }

  return {
    asset: normalizedAsset,
    direction: normalizedDirection,
    leverage: leverageValue,
    collateral: Number(collateral.toFixed(2)),
    riskBudget: Number(riskBudget.toFixed(2)),
    riskPct: Number(effectiveRiskPct.toFixed(6)),
    signalConfidence: Number(confidence.toFixed(4)),
    requestedNotional: Number(requestedNotional.toFixed(2)),
    riskTargetNotional: Number(riskBasedNotional.toFixed(2)),
    notionalOverride: exactNotional ? Number(exactNotional.toFixed(2)) : null,
    notionalOverrideApplied: Boolean(exactNotional),
    maxNotional: resolvedMaxNotional ? Number(resolvedMaxNotional.toFixed(2)) : null,
    maxNotionalApplied,
    notional: Number(plannedNotional.toFixed(2)),
    actualNotional: Number(actualNotional.toFixed(2)),
    size,
    szDecimals: decimals,
    priceDecimals,
    entryPrice,
    limitPrice,
    stopPrice,
    takeProfitPrice1,
    takeProfitPrice2,
    stopDistancePct: Number(stopDistancePct.toFixed(6)),
    takeProfitDistancePct: Number(takeProfitDistancePct.toFixed(6)),
    isLong,
    reserveUsdc: reserveValue,
    volatilitySnapshot: normalizedVolatilitySnapshot,
    sizingMode,
    sizingModel: sizingMode === 'risk_model' ? 'confidence_weighted_fractional_kelly' : 'operator_override',
  };
}

function buildHyperliquidTriggerOrder({ assetIndex, isBuy, size, triggerPrice, referencePrice = triggerPrice, szDecimals = 0, tpsl = 'sl' }) {
  const normalizedTriggerPrice = Number(triggerPrice);
  const normalizedSize = Number(size);
  if (!Number.isFinite(assetIndex) || assetIndex < 0) {
    throw new Error('assetIndex is required for Hyperliquid trigger orders');
  }
  if (!Number.isFinite(normalizedTriggerPrice) || normalizedTriggerPrice <= 0) {
    throw new Error('triggerPrice must be positive');
  }
  if (!Number.isFinite(normalizedSize) || normalizedSize <= 0) {
    throw new Error('size must be positive');
  }
  return {
    a: assetIndex,
    b: Boolean(isBuy),
    p: formatPrice(normalizedTriggerPrice, referencePrice, szDecimals),
    s: normalizedSize.toString(),
    r: true,
    t: { trigger: { triggerPx: formatPrice(normalizedTriggerPrice, referencePrice, szDecimals), isMarket: true, tpsl } },
  };
}

async function submitHyperliquidTriggerOrder(exchange, order, executionOptions = {}) {
  return executeHyperliquidOrder(exchange, {
    orders: [order],
    grouping: 'na',
  }, executionOptions);
}

async function placeHyperliquidStopLoss({ exchange, assetIndex, isLong, size, stopPrice, referencePrice = stopPrice, szDecimals = 0, executionOptions = {} }) {
  return submitHyperliquidTriggerOrder(
    exchange,
    buildHyperliquidTriggerOrder({
      assetIndex,
      isBuy: !isLong,
      size,
      triggerPrice: stopPrice,
      referencePrice,
      szDecimals,
      tpsl: 'sl',
    }),
    executionOptions
  );
}

async function placeHyperliquidTakeProfit({ exchange, assetIndex, isLong, size, takeProfitPrice, referencePrice = takeProfitPrice, szDecimals = 0, executionOptions = {} }) {
  return submitHyperliquidTriggerOrder(
    exchange,
    buildHyperliquidTriggerOrder({
      assetIndex,
      isBuy: !isLong,
      size,
      triggerPrice: takeProfitPrice,
      referencePrice,
      szDecimals,
      tpsl: 'tp',
    }),
    executionOptions
  );
}

async function setHyperliquidStopLoss(options = {}) {
  const { privateKey, walletAddress } = ensureDeFiSecrets();
  const { HttpTransport, ExchangeClient, InfoClient } = await import('@nktkas/hyperliquid');
  const { privateKeyToAccount } = require('viem/accounts');

  const tradeRequest = {
    ...parseTradeOptions(),
    ...options,
  };
  tradeRequest.asset = normalizeAssetName(tradeRequest.asset, TRADE_CONFIG.asset);
  tradeRequest.stopLossPrice = toPositiveNumber(tradeRequest.stopLossPrice, null);
  if (!tradeRequest.stopLossPrice) {
    throw new Error('stop-loss command requires --stop-loss PRICE');
  }

  const wallet = privateKeyToAccount(privateKey);
  const transport = new HttpTransport();
  const info = new InfoClient({ transport });
  const exchange = new ExchangeClient({ transport, wallet });

  const [meta, clearinghouse] = await Promise.all([
    info.meta(),
    info.clearinghouseState({ user: walletAddress }),
  ]);
  const resolvedAsset = findAssetMeta(meta, tradeRequest.asset);
  if (!resolvedAsset) {
    throw new Error(`${tradeRequest.asset} not found in Hyperliquid universe`);
  }

  const currentPosition = (Array.isArray(clearinghouse?.assetPositions) ? clearinghouse.assetPositions : [])
    .map((entry) => entry?.position || {})
    .find((position) => normalizeAssetName(position?.coin, '') === tradeRequest.asset && Math.abs(Number(position?.szi || 0)) > 0);
  if (!currentPosition) {
    throw new Error(`No open ${tradeRequest.asset} position found on Hyperliquid`);
  }

  const size = Math.abs(Number(currentPosition.szi || 0));
  const isLong = Number(currentPosition.szi || 0) > 0;
  const entryPrice = Number(currentPosition.entryPx || 0);
  const stopPrice = constrainStopPriceWithinLiquidationBuffer({
    stopPrice: roundPrice(
      tradeRequest.stopLossPrice,
      Number(currentPosition.entryPx || tradeRequest.stopLossPrice || 0),
      resolveAssetSzDecimals(resolvedAsset, 0)
    ),
    entryPrice,
    liquidationPx: Number(currentPosition.liquidationPx || 0),
    isLong,
    referencePrice: entryPrice || tradeRequest.stopLossPrice,
    szDecimals: resolveAssetSzDecimals(resolvedAsset, 0),
  });
  if (isLong && stopPrice >= entryPrice) {
    throw new Error(`Long stop loss ${stopPrice} must be below entry ${entryPrice.toFixed(1)}`);
  }
  if (!isLong && stopPrice <= entryPrice) {
    throw new Error(`Short stop loss ${stopPrice} must be above entry ${entryPrice.toFixed(1)}`);
  }

  log(`Setting standalone stop loss: ${isLong ? 'SELL' : 'BUY'} ${size} ${tradeRequest.asset} @ $${formatPrice(stopPrice, entryPrice || stopPrice, resolveAssetSzDecimals(resolvedAsset, 0))}...`);
  if (isDryRun || tradeRequest.dryRun === true) {
    log('[DRY RUN] Would place stop-market order');
    return {
      asset: tradeRequest.asset,
      stopPrice,
      size,
      direction: isLong ? 'LONG' : 'SHORT',
    };
  }

  const result = await placeHyperliquidStopLoss({
    exchange,
    assetIndex: resolvedAsset.assetIndex,
    isLong,
    size,
    stopPrice,
    referencePrice: entryPrice || stopPrice,
    szDecimals: resolveAssetSzDecimals(resolvedAsset, 0),
  });
  log(`Stop loss result: ${JSON.stringify(result)}`);
  return {
    asset: tradeRequest.asset,
    stopPrice,
    size,
    direction: isLong ? 'LONG' : 'SHORT',
    result,
  };
}

async function checkStatus() {
  const { walletAddress } = ensureDeFiSecrets();
  const { createPublicClient, http, formatEther, formatUnits } = require('viem');
  const { mainnet, arbitrum } = require('viem/chains');

  const ethClient = createPublicClient({ chain: mainnet, transport: http('https://ethereum-rpc.publicnode.com') });
  const arbClient = createPublicClient({ chain: arbitrum, transport: http('https://arbitrum-one-rpc.publicnode.com') });

  const ethBalance = await ethClient.getBalance({ address: walletAddress });
  const ethBalanceFormatted = formatEther(ethBalance);

  const arbEthBalance = await arbClient.getBalance({ address: walletAddress });
  const arbEthFormatted = formatEther(arbEthBalance);

  let usdcBalance = 0n;
  try {
    usdcBalance = await arbClient.readContract({
      address: CONTRACTS.USDC_ARBITRUM,
      abi: [{
        name: 'balanceOf',
        type: 'function',
        stateMutability: 'view',
        inputs: [{ name: 'account', type: 'address' }],
        outputs: [{ name: '', type: 'uint256' }],
      }],
      functionName: 'balanceOf',
      args: [walletAddress],
    });
  } catch (_) {
    /* no USDC */
  }
  const usdcFormatted = formatUnits(usdcBalance, 6);

  const ethPriceEstimate = 2100;

  log('=== Wallet Status ===');
  log(`Address: ${walletAddress}`);
  log(`Mainnet ETH:  ${ethBalanceFormatted} ETH (~$${(parseFloat(ethBalanceFormatted) * ethPriceEstimate).toFixed(2)})`);
  log(`Arbitrum ETH: ${arbEthFormatted} ETH (~$${(parseFloat(arbEthFormatted) * ethPriceEstimate).toFixed(2)})`);
  log(`Arbitrum USDC: ${usdcFormatted} USDC`);
  log(`ETH price est: ~$${ethPriceEstimate}`);

  return {
    mainnetEth: parseFloat(ethBalanceFormatted),
    arbEth: parseFloat(arbEthFormatted),
    arbUsdc: parseFloat(usdcFormatted),
    ethPrice: ethPriceEstimate,
  };
}

async function bridgeToArbitrum() {
  const { privateKey, walletAddress } = ensureDeFiSecrets();
  const { createPublicClient, createWalletClient, http, formatEther, parseEther } = require('viem');
  const { mainnet } = require('viem/chains');
  const { privateKeyToAccount } = require('viem/accounts');

  const account = privateKeyToAccount(privateKey);
  const publicClient = createPublicClient({ chain: mainnet, transport: http('https://ethereum-rpc.publicnode.com') });
  const walletClient = createWalletClient({ account, chain: mainnet, transport: http('https://ethereum-rpc.publicnode.com') });

  const balance = await publicClient.getBalance({ address: walletAddress });
  const ethBal = parseFloat(formatEther(balance));
  log(`Mainnet ETH balance: ${ethBal.toFixed(6)} ETH`);

  if (ethBal < 0.005) {
    err('Not enough ETH on mainnet to bridge (need at least 0.005 ETH)');
    return null;
  }

  const gasReserve = 0.005;
  const bridgeAmount = ethBal - gasReserve;
  const bridgeWei = parseEther(bridgeAmount.toFixed(18));

  log(`Bridging ${bridgeAmount.toFixed(6)} ETH to Arbitrum (keeping ${gasReserve} ETH for gas)`);

  if (isDryRun) {
    log('[DRY RUN] Would call Arbitrum Inbox depositEth()');
    log(`[DRY RUN] Amount: ${bridgeAmount.toFixed(6)} ETH`);
    return bridgeAmount;
  }

  const INBOX_ABI = [{
    name: 'depositEth',
    type: 'function',
    stateMutability: 'payable',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  }];

  try {
    const hash = await walletClient.writeContract({
      address: CONTRACTS.ARB_INBOX,
      abi: INBOX_ABI,
      functionName: 'depositEth',
      value: bridgeWei,
    });
    log(`Bridge TX submitted: ${hash}`);
    log('Waiting for confirmation...');
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    log(`Bridge TX confirmed in block ${receipt.blockNumber}`);
    log('ETH will arrive on Arbitrum in ~10-15 minutes');
    return bridgeAmount;
  } catch (e) {
    err(`Bridge failed: ${e.message}`);
    return null;
  }
}

async function swapEthToUsdc() {
  const { privateKey, walletAddress } = ensureDeFiSecrets();
  const { createPublicClient, createWalletClient, http, formatEther, formatUnits, parseEther } = require('viem');
  const { arbitrum } = require('viem/chains');
  const { privateKeyToAccount } = require('viem/accounts');

  const account = privateKeyToAccount(privateKey);
  const publicClient = createPublicClient({ chain: arbitrum, transport: http('https://arbitrum-one-rpc.publicnode.com') });
  const walletClient = createWalletClient({ account, chain: arbitrum, transport: http('https://arbitrum-one-rpc.publicnode.com') });

  const balance = await publicClient.getBalance({ address: walletAddress });
  const ethBal = parseFloat(formatEther(balance));
  log(`Arbitrum ETH balance: ${ethBal.toFixed(6)} ETH`);

  if (ethBal < 0.005) {
    err('Not enough ETH on Arbitrum to swap (need at least 0.005 ETH)');
    return null;
  }

  const arbGasReserve = 0.001;
  const swapAmount = ethBal - arbGasReserve;
  const swapWei = parseEther(swapAmount.toFixed(18));
  log(`Swapping ${swapAmount.toFixed(6)} ETH → USDC on Uniswap V3`);

  if (isDryRun) {
    log('[DRY RUN] Would call Uniswap V3 exactInputSingle()');
    log(`[DRY RUN] Input: ${swapAmount.toFixed(6)} ETH`);
    log('[DRY RUN] Output: ~USDC (market rate, 0.5% slippage tolerance)');
    return swapAmount * 2100;
  }

  const SWAP_ABI = [{
    name: 'exactInputSingle',
    type: 'function',
    stateMutability: 'payable',
    inputs: [{
      name: 'params',
      type: 'tuple',
      components: [
        { name: 'tokenIn', type: 'address' },
        { name: 'tokenOut', type: 'address' },
        { name: 'fee', type: 'uint24' },
        { name: 'recipient', type: 'address' },
        { name: 'amountIn', type: 'uint256' },
        { name: 'amountOutMinimum', type: 'uint256' },
        { name: 'sqrtPriceLimitX96', type: 'uint160' },
      ],
    }],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  }];

  const minOutUsdc = BigInt(Math.floor(swapAmount * 2000 * 0.995 * 1e6));

  try {
    const hash = await walletClient.writeContract({
      address: CONTRACTS.UNISWAP_ROUTER,
      abi: SWAP_ABI,
      functionName: 'exactInputSingle',
      args: [{
        tokenIn: CONTRACTS.WETH_ARBITRUM,
        tokenOut: CONTRACTS.USDC_ARBITRUM,
        fee: 500,
        recipient: walletAddress,
        amountIn: swapWei,
        amountOutMinimum: minOutUsdc,
        sqrtPriceLimitX96: 0n,
      }],
      value: swapWei,
    });

    log(`Swap TX submitted: ${hash}`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    log(`Swap confirmed in block ${receipt.blockNumber}`);

    const usdcBal = await publicClient.readContract({
      address: CONTRACTS.USDC_ARBITRUM,
      abi: [{
        name: 'balanceOf',
        type: 'function',
        stateMutability: 'view',
        inputs: [{ name: 'account', type: 'address' }],
        outputs: [{ name: '', type: 'uint256' }],
      }],
      functionName: 'balanceOf',
      args: [walletAddress],
    });
    const usdcFormatted = parseFloat(formatUnits(usdcBal, 6));
    log(`USDC balance after swap: ${usdcFormatted.toFixed(2)} USDC`);
    return usdcFormatted;
  } catch (e) {
    err(`Swap failed: ${e.message}`);
    return null;
  }
}

async function depositToHyperliquid() {
  const { privateKey, walletAddress } = ensureDeFiSecrets();
  const { createPublicClient, createWalletClient, http, formatUnits } = require('viem');
  const { arbitrum } = require('viem/chains');
  const { privateKeyToAccount } = require('viem/accounts');

  const account = privateKeyToAccount(privateKey);
  const publicClient = createPublicClient({ chain: arbitrum, transport: http('https://arbitrum-one-rpc.publicnode.com') });
  const walletClient = createWalletClient({ account, chain: arbitrum, transport: http('https://arbitrum-one-rpc.publicnode.com') });

  const ERC20_ABI = [
    {
      name: 'balanceOf',
      type: 'function',
      stateMutability: 'view',
      inputs: [{ name: 'account', type: 'address' }],
      outputs: [{ name: '', type: 'uint256' }],
    },
    {
      name: 'transfer',
      type: 'function',
      stateMutability: 'nonpayable',
      inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }],
      outputs: [{ name: '', type: 'bool' }],
    },
  ];

  const usdcBal = await publicClient.readContract({
    address: CONTRACTS.USDC_ARBITRUM,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [walletAddress],
  });
  const usdcAmount = parseFloat(formatUnits(usdcBal, 6));
  log(`Arbitrum USDC balance: ${usdcAmount.toFixed(2)} USDC`);

  if (usdcAmount < 5) {
    err('Less than 5 USDC - below Hyperliquid minimum deposit. Aborting.');
    return null;
  }

  log(`Depositing ${usdcAmount.toFixed(2)} USDC to Hyperliquid bridge`);

  if (isDryRun) {
    log('[DRY RUN] Would transfer USDC to Hyperliquid bridge');
    log(`[DRY RUN] Amount: ${usdcAmount.toFixed(2)} USDC`);
    return usdcAmount;
  }

  try {
    const hash = await walletClient.writeContract({
      address: CONTRACTS.USDC_ARBITRUM,
      abi: ERC20_ABI,
      functionName: 'transfer',
      args: [CONTRACTS.HL_BRIDGE, usdcBal],
    });
    log(`Deposit TX submitted: ${hash}`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    log(`Deposit confirmed in block ${receipt.blockNumber}`);
    log('USDC should appear on Hyperliquid within 1-2 minutes');
    return usdcAmount;
  } catch (e) {
    err(`Deposit failed: ${e.message}`);
    return null;
  }
}

async function openHyperliquidPosition(options = {}) {
  const tradeRequest = {
    ...parseTradeOptions(),
    ...options,
  };
  tradeRequest.directionInput = String(
    options.directionInput
    || options.requestedDirection
    || options.direction
    || tradeRequest.directionInput
    || tradeRequest.requestedDirection
    || tradeRequest.direction
    || TRADE_CONFIG.direction
  ).trim().toUpperCase();
  tradeRequest.asset = normalizeAssetName(tradeRequest.asset, TRADE_CONFIG.asset);
  tradeRequest.direction = normalizeDirection(tradeRequest.directionInput, TRADE_CONFIG.direction);
  tradeRequest.leverage = toPositiveNumber(tradeRequest.leverage, TRADE_CONFIG.leverage);
  tradeRequest.margin = toPositiveNumber(tradeRequest.margin, TRADE_CONFIG.margin);
  tradeRequest.notional = toPositiveNumber(tradeRequest.notional, null);
  tradeRequest.stopLossPrice = toPositiveNumber(tradeRequest.stopLossPrice, null);
  tradeRequest.takeProfitPrice = toPositiveNumber(tradeRequest.takeProfitPrice, null);
  tradeRequest.signalConfidence = normalizeConfidence(
    tradeRequest.signalConfidence ?? tradeRequest.confidence ?? tradeRequest.consensusConfidence,
    TRADE_CONFIG.signalConfidence
  );
  tradeRequest.maxNotional = toPositiveNumber(tradeRequest.maxNotional, null);
  tradeRequest.retryDelayMs = toNonNegativeInteger(tradeRequest.retryDelayMs, 0);
  tradeRequest.reserveUsdc = toPositiveNumber(tradeRequest.reserveUsdc, TRADE_CONFIG.reserveUsdc) || TRADE_CONFIG.reserveUsdc;

  const runtime = await resolveHyperliquidRuntime(options);
  const { walletAddress, info, exchange } = runtime;
  const tradeTicker = `${tradeRequest.asset}/USD`;
  const executionSnapshot = options.executionSnapshot && typeof options.executionSnapshot === 'object'
    ? options.executionSnapshot
    : {};
  const infoExecutionOptions = {
    timeoutMs: options.hyperliquidCallTimeoutMs,
    retryDelayMs: options.infoRetryDelayMs,
    jitterMs: options.infoJitterMs,
    maxDelayMs: options.infoMaxDelayMs,
    maxRetries: options.infoMaxRetries,
  };

  let clearinghouse;
  try {
    clearinghouse = await resolveFreshClearinghouseState({
      info,
      walletAddress,
      executionSnapshot,
      infoExecutionOptions,
      maxAgeMs: options.freshClearinghouseMaxAgeMs,
      nowMs: options.nowMs,
    });
  } catch (error) {
    err(error?.message || String(error));
    return null;
  }
  const availableBalance = parseFloat(clearinghouse.marginSummary.accountValue);
  log(`Hyperliquid account value: $${availableBalance.toFixed(2)}`);

  if (availableBalance < 10) {
    err(`Only $${availableBalance.toFixed(2)} on Hyperliquid - need at least $10. Deposit may still be arriving.`);
    return null;
  }

  const meta = executionSnapshot.meta || null;
  const resolvedAsset = executionSnapshot.resolvedAsset
    || findAssetMeta(meta, tradeRequest.asset)
    || findAssetMeta(await executeHyperliquidInfoCall(
      () => info.meta(),
      {
        ...infoExecutionOptions,
        label: 'meta',
      }
    ), tradeRequest.asset);
  if (!resolvedAsset) {
    err(`${tradeRequest.asset} not found in Hyperliquid universe`);
    return null;
  }
  const { asset, assetIndex } = resolvedAsset;
  const requestedLeverage = toPositiveNumber(tradeRequest.leverage, TRADE_CONFIG.leverage);
  const maxAllowedLeverage = resolveAssetMaxLeverage(resolvedAsset, requestedLeverage);
  const executionLeverage = Math.min(requestedLeverage, maxAllowedLeverage);
  const assetSzDecimals = resolveAssetSzDecimals(resolvedAsset, 4);

  const mids = executionSnapshot.allMids || await executeHyperliquidInfoCall(
    () => info.allMids(),
    {
      ...infoExecutionOptions,
      label: 'allMids',
    }
  );
  const assetPrice = parseFloat(mids[tradeRequest.asset]);
  if (!Number.isFinite(assetPrice) || assetPrice <= 0) {
    err(`Could not resolve ${tradeRequest.asset} market price`);
    return null;
  }

  const existingPosition = extractOpenHyperliquidPosition(clearinghouse, tradeRequest.asset);
  if (shouldCloseAgainstExistingPosition(tradeRequest.directionInput, existingPosition)) {
    return closeExistingHyperliquidPosition({
      info,
      exchange,
      walletAddress,
      asset: tradeRequest.asset,
      assetIndex,
      position: existingPosition,
      midPrice: assetPrice,
      szDecimals: assetSzDecimals,
      retryDelayMs: tradeRequest.retryDelayMs,
      timeoutMs: options.hyperliquidCallTimeoutMs,
    });
  }

  const volatilitySnapshot = await withTimeout(
    resolveVolatilitySnapshot({
      asset: tradeRequest.asset,
      midPrice: assetPrice,
      infoClient: info,
      historicalBars: options.historicalBars,
      volatilitySnapshot: options.volatilitySnapshot,
      volatilityLookbackBars: options.volatilityLookbackBars,
      stopLossPct: TRADE_CONFIG.stopLossPct,
      takeProfitPct2: TRADE_CONFIG.takeProfitPct2,
    }),
    options.hyperliquidCallTimeoutMs,
    'volatilitySnapshot'
  );

  const tradePlan = buildTradePlan({
    asset: tradeRequest.asset,
    direction: tradeRequest.direction,
    leverage: executionLeverage,
    margin: tradeRequest.margin,
    notional: tradeRequest.notional,
    maxNotional: tradeRequest.maxNotional,
    reserveUsdc: tradeRequest.reserveUsdc,
    stopLossPrice: tradeRequest.stopLossPrice,
    takeProfitPrice: tradeRequest.takeProfitPrice,
    signalConfidence: tradeRequest.signalConfidence,
    volatilitySnapshot,
    availableBalance,
    midPrice: assetPrice,
    szDecimals: assetSzDecimals,
    stopLossPct: TRADE_CONFIG.stopLossPct,
    takeProfitPct1: TRADE_CONFIG.takeProfitPct1,
    takeProfitPct2: TRADE_CONFIG.takeProfitPct2,
  });
  const clientOrderId = resolveTradeClientOrderId(tradeRequest, tradePlan, options);

  log('Trade plan:');
  log(`  Asset: ${tradePlan.asset}`);
  log(`  Direction: ${tradePlan.direction}`);
  log(`  Collateral: $${tradePlan.collateral.toFixed(2)}`);
  log(`  Leverage: ${tradePlan.leverage}x`);
  log(`  Sizing mode: ${tradePlan.sizingMode}`);
  if (executionLeverage < requestedLeverage) {
    log(`  Venue leverage cap: clamped requested ${requestedLeverage}x to ${executionLeverage}x`);
  }
  log(`  Notional: $${tradePlan.actualNotional.toFixed(2)}`);
  if (tradePlan.notionalOverrideApplied && tradePlan.notionalOverride) {
    log(`  Exact notional override: targeting ~$${tradePlan.notionalOverride.toFixed(2)}`);
  }
  log(`  Risk budget: $${tradePlan.riskBudget.toFixed(2)} (${(tradePlan.riskPct * 100).toFixed(2)}% of equity @ confidence ${tradePlan.signalConfidence.toFixed(2)})`);
  if (tradePlan.maxNotionalApplied && tradePlan.maxNotional) {
    log(`  Safety cap: capped from $${tradePlan.requestedNotional.toFixed(2)} to $${tradePlan.maxNotional.toFixed(2)} notional`);
  }
  log(`  Size: ${tradePlan.size} ${tradePlan.asset}`);
  if (clientOrderId) {
    log(`  Client order id: ${clientOrderId}`);
  }
  log(`  Volatility source: ${tradePlan.volatilitySnapshot?.source || 'unknown'} (${tradePlan.volatilitySnapshot?.barCount || 0} bars, ATR ${tradePlan.volatilitySnapshot?.atrPct != null ? `${(tradePlan.volatilitySnapshot.atrPct * 100).toFixed(2)}%` : 'n/a'})`);
  log(`  Stop loss: $${tradePlan.stopPrice.toFixed(2)}`);
  log(`  TP1: $${tradePlan.takeProfitPrice1.toFixed(2)}`);
  log(`  TP2: $${tradePlan.takeProfitPrice2.toFixed(2)}`);

  const plannedBracket = bracketManager.buildBracketPlan({
    asset: tradePlan.asset,
    direction: tradePlan.direction,
    entryPrice: tradePlan.entryPrice,
    stopPrice: tradePlan.stopPrice,
    takeProfitPrice1: tradePlan.takeProfitPrice1,
    takeProfitPrice2: tradePlan.takeProfitPrice2,
    size: tradePlan.size,
    szDecimals: tradePlan.szDecimals,
  });

  if (isDryRun || tradeRequest.dryRun === true) {
    log('[DRY RUN] Would set leverage and open position');
    return {
      size: tradePlan.size,
      price: tradePlan.entryPrice,
      collateral: tradePlan.collateral,
      asset: tradePlan.asset,
      direction: tradePlan.direction,
      stopPrice: tradePlan.stopPrice,
      takeProfitPrice: tradePlan.takeProfitPrice2,
      riskBudget: tradePlan.riskBudget,
      riskPct: tradePlan.riskPct,
      signalConfidence: tradePlan.signalConfidence,
      clientOrderId,
      bracketPlan: plannedBracket,
    };
  }

  try {
    const orderExecutionOptions = {
      retryDelayMs: tradeRequest.retryDelayMs,
      timeoutMs: options.hyperliquidCallTimeoutMs,
      state: { lastOrderAt: 0 },
    };
    if (clientOrderId) {
      const existingOrder = options.skipDuplicateCheck === true
        ? null
        : await withTimeout(
          getExistingHyperliquidOrderByCloid(info, walletAddress, clientOrderId),
          options.hyperliquidCallTimeoutMs,
          'orderStatus'
        );
      if (existingOrder && isBlockingExistingHyperliquidOrder(existingOrder.status)) {
        warn(`Existing Hyperliquid order found for ${clientOrderId} with status ${existingOrder.status}; skipping duplicate entry broadcast.`);
        const updatedClearinghouse = await executeHyperliquidInfoCall(
          () => info.clearinghouseState({ user: walletAddress }),
          {
            ...infoExecutionOptions,
            label: 'duplicateCheckClearinghouseState',
          }
        );
        const existingPosition = extractOpenHyperliquidPosition(updatedClearinghouse, tradePlan.asset);
        return {
          size: existingPosition?.absSize || 0,
          price: existingPosition?.entryPx || tradePlan.entryPrice,
          collateral: tradePlan.collateral,
          asset: tradePlan.asset,
          direction: existingPosition?.side || tradePlan.direction,
          stopPrice: tradePlan.stopPrice,
          takeProfitPrice: tradePlan.takeProfitPrice2,
          partialFill: existingPosition ? existingPosition.absSize < Number(tradePlan.size) : false,
          stopLossConfigured: false,
          takeProfitConfigured: false,
          clientOrderId,
          duplicatePrevented: true,
          existingOrderStatus: existingOrder.status,
          warnings: [`duplicate_entry_blocked:${existingOrder.status}`],
        };
      }
    }

    log(`Setting ${tradePlan.leverage}x isolated leverage on ${tradePlan.asset}...`);
    await executeHyperliquidLeverageUpdate(exchange, {
      asset: assetIndex,
      isCross: false,
      leverage: tradePlan.leverage,
    }, {
      timeoutMs: options.hyperliquidCallTimeoutMs,
      label: 'updateLeverage',
      maxRetries: 3,
      retryDelayMs: toNonNegativeInteger(tradeRequest.retryDelayMs, 750) || 750,
      jitterMs: 350,
      maxDelayMs: 4000,
    });
    log('Leverage set');

    log(`Opening ${tradePlan.direction.toLowerCase()}: ${tradePlan.size} ${tradePlan.asset} @ limit $${formatPrice(tradePlan.limitPrice, tradePlan.entryPrice, tradePlan.szDecimals)} (IOC)...`);
    const result = await executeHyperliquidOrder(exchange, {
      orders: [{
        a: assetIndex,
        b: tradePlan.isLong,
        p: formatPrice(tradePlan.limitPrice, tradePlan.entryPrice, tradePlan.szDecimals),
        s: tradePlan.size.toString(),
        r: false,
        t: { limit: { tif: 'Ioc' } },
        ...(clientOrderId ? { c: clientOrderId } : {}),
      }],
      grouping: 'na',
    }, {
      ...orderExecutionOptions,
      label: 'entryOrder',
    });
    log(`Order result: ${JSON.stringify(result)}`);

    const filledOrder = extractFilledHyperliquidOrder(result);
    let filledPosition = null;
    if (filledOrder) {
      filledPosition = {
        coin: tradePlan.asset,
        absSize: filledOrder.absSize,
        entryPx: filledOrder.entryPx,
        isLong: tradePlan.isLong,
        side: tradePlan.direction,
        signedSize: tradePlan.isLong ? filledOrder.absSize : -filledOrder.absSize,
        liquidationPx: null,
      };
    }
    if (!filledPosition) {
      const updatedClearinghouse = await executeHyperliquidInfoCall(
        () => info.clearinghouseState({ user: walletAddress }),
        {
          ...infoExecutionOptions,
          label: 'postEntryClearinghouseState',
        }
      );
      filledPosition = extractOpenHyperliquidPosition(updatedClearinghouse, tradePlan.asset);
    }
    if (!filledPosition || filledPosition.absSize <= 0) {
      warn(`No ${tradePlan.asset} fill detected after entry IOC. Skipping stop/TP placement.`);
      return null;
    }

    const warnings = [];
    const actualSize = filledPosition.absSize;
    const actualDirection = filledPosition.side;
    const liveEntryPrice = filledPosition.entryPx || tradePlan.entryPrice;
    const actualNotional = actualSize * liveEntryPrice;
    if (!Number.isFinite(actualNotional) || actualNotional < HYPERLIQUID_MIN_ORDER_NOTIONAL_USD) {
      warn(
        `Rejecting undersized live fill on ${tradePlan.asset}: actual notional $${Number.isFinite(actualNotional) ? actualNotional.toFixed(4) : '0.0000'} is below minimum $${HYPERLIQUID_MIN_ORDER_NOTIONAL_USD.toFixed(2)}.`
      );
      try {
        await closeExistingHyperliquidPosition({
          info,
          exchange,
          walletAddress,
          asset: tradePlan.asset,
          assetIndex,
          position: filledPosition,
          midPrice: liveEntryPrice,
          szDecimals: tradePlan.szDecimals,
          retryDelayMs: toNonNegativeInteger(tradeRequest.retryDelayMs, 750) || 750,
          timeoutMs: options.hyperliquidCallTimeoutMs,
        });
      } catch (dustCloseError) {
        warn(`Failed to auto-close undersized ${tradePlan.asset} fill: ${dustCloseError?.message || dustCloseError}`);
      }
      return null;
    }
    const attributedOwner = String(
      options.originatingAgentId
      || agentPositionAttribution.resolveAgentPositionOwnership([
        { ticker: tradeTicker, coin: tradePlan.asset },
      ]).ownersByTicker[tradeTicker]
      || ''
    ).trim().toLowerCase();
    if (attributedOwner) {
      agentPositionAttribution.upsertOpenPosition({
        ticker: tradeTicker,
        agentId: attributedOwner,
        direction: actualDirection,
        entryPrice: liveEntryPrice,
        currentSize: actualSize,
        initialSize: actualSize,
        marginUsd: tradePlan.collateral,
        leverage: tradePlan.leverage,
        strategyLane: String(options.strategyLane || '').trim(),
        clientOrderId,
        source: String(options.attributionSource || 'hm-defi-execute').trim(),
        reasoning: String(options.attributionReasoning || '').trim(),
        openedAt: new Date().toISOString(),
        walletAddress,
      });
    }
    const liveBracket = bracketManager.buildBracketPlan({
      asset: tradePlan.asset,
      direction: actualDirection,
      entryPrice: liveEntryPrice,
      stopPrice: tradePlan.stopPrice,
      takeProfitPrice1: tradePlan.takeProfitPrice1,
      takeProfitPrice2: tradePlan.takeProfitPrice2,
      size: actualSize,
      szDecimals: tradePlan.szDecimals,
    });
    const partialFill = actualSize < Number(tradePlan.size);
    if (partialFill) {
      warn(`Entry partially filled: planned ${tradePlan.size} ${tradePlan.asset}, actual ${actualSize} ${tradePlan.asset}`);
    }

    let stopLossConfigured = false;
    if (!noStopLoss) {
      try {
        const liveStopPrice = constrainStopPriceWithinLiquidationBuffer({
          stopPrice: tradePlan.stopPrice,
          entryPrice: filledPosition.entryPx || tradePlan.entryPrice,
          liquidationPx: Number(filledPosition.liquidationPx || 0),
          isLong: filledPosition.isLong,
          referencePrice: tradePlan.entryPrice,
          szDecimals: tradePlan.szDecimals,
        });
        log(`Setting stop loss: ${filledPosition.isLong ? 'SELL' : 'BUY'} ${actualSize} ${tradePlan.asset} @ $${formatPrice(liveStopPrice, tradePlan.entryPrice)}...`);
        await withTimeout(placeHyperliquidStopLoss({
          exchange,
          assetIndex,
          isLong: filledPosition.isLong,
          size: actualSize,
          stopPrice: liveStopPrice,
          referencePrice: tradePlan.entryPrice,
          szDecimals: tradePlan.szDecimals,
          executionOptions: {
            ...orderExecutionOptions,
            label: 'placeStopLoss',
          },
        }), options.hyperliquidCallTimeoutMs, 'placeStopLoss');
        stopLossConfigured = true;
        tradePlan.stopPrice = liveStopPrice;
        log('Stop loss set');
      } catch (stopError) {
        const message = stopError?.message || String(stopError);
        warnings.push(`stop_loss_failed:${message}`);
        warn(`Stop loss placement failed after entry fill: ${message}`);
      }
    } else {
      log('Stop loss SKIPPED (--no-stop)');
    }

    let takeProfitConfigured = false;
    if (!noStopLoss) {
      try {
        log(`Setting first take profit: ${filledPosition.isLong ? 'SELL' : 'BUY'} ${liveBracket.firstTakeProfitSize} ${tradePlan.asset} @ $${formatPrice(liveBracket.firstTakeProfitPrice, tradePlan.entryPrice)}...`);
        const takeProfitResult = await withTimeout(placeHyperliquidTakeProfit({
          exchange,
          assetIndex,
          isLong: filledPosition.isLong,
          size: liveBracket.firstTakeProfitSize,
          takeProfitPrice: liveBracket.firstTakeProfitPrice,
          referencePrice: tradePlan.entryPrice,
          szDecimals: tradePlan.szDecimals,
          executionOptions: {
            ...orderExecutionOptions,
            label: 'placeTakeProfit1',
          },
        }), options.hyperliquidCallTimeoutMs, 'placeTakeProfit');
        takeProfitConfigured = true;
        liveBracket.firstTakeProfitOrderId = extractHyperliquidOrderId(takeProfitResult);
        log('First take profit set');
      } catch (tpError) {
        const message = tpError?.message || String(tpError);
        warnings.push(`take_profit_failed:${message}`);
        warn(`First take profit placement failed after entry fill: ${message}`);
      }
    } else {
      log('Take profit SKIPPED (--no-stop)');
    }

    return {
      size: actualSize,
      price: filledPosition.entryPx || tradePlan.entryPrice,
      collateral: tradePlan.collateral,
      asset: tradePlan.asset,
      direction: actualDirection,
      stopPrice: tradePlan.stopPrice,
      takeProfitPrice: liveBracket.firstTakeProfitPrice,
      firstTakeProfitPrice: liveBracket.firstTakeProfitPrice,
      runnerTakeProfitPrice: liveBracket.runnerTakeProfitPrice,
      riskBudget: tradePlan.riskBudget,
      riskPct: tradePlan.riskPct,
      signalConfidence: tradePlan.signalConfidence,
      partialFill,
      stopLossConfigured,
      takeProfitConfigured,
      bracketPlan: liveBracket,
      clientOrderId,
      warnings,
    };
  } catch (e) {
    err(`Trade failed: ${e.message}`);
    if (e.response) err(`Response: ${JSON.stringify(e.response)}`);
    return null;
  }
}

async function fullSend(tradeOptions = parseTradeOptions()) {
  log(`=== FULL SEND: ETH → Arbitrum → USDC → Hyperliquid → ${tradeOptions.direction} ${tradeOptions.asset} ===`);
  if (isDryRun) log('*** DRY RUN MODE - no transactions will be sent ***');

  const status = await checkStatus();

  if (status.arbUsdc >= 10) {
    log('Already have USDC on Arbitrum - skipping bridge and swap');
    const deposited = await depositToHyperliquid();
    if (!deposited && !isDryRun) return null;
    if (!isDryRun) {
      log('Waiting 90s for Hyperliquid to credit deposit...');
      await sleep(90000);
    }
    return openHyperliquidPosition(tradeOptions);
  }

  if (status.arbEth >= 0.005) {
    log('Already have ETH on Arbitrum - skipping bridge');
    const swapped = await swapEthToUsdc();
    if (!swapped && !isDryRun) return null;
    const deposited = await depositToHyperliquid();
    if (!deposited && !isDryRun) return null;
    if (!isDryRun) {
      log('Waiting 90s for Hyperliquid to credit deposit...');
      await sleep(90000);
    }
    return openHyperliquidPosition(tradeOptions);
  }

  if (status.mainnetEth < 0.01) {
    err('Not enough ETH anywhere to proceed');
    return null;
  }

  log('\n--- Step 1/4: Bridge ETH to Arbitrum ---');
  const bridged = await bridgeToArbitrum();
  if (!bridged && !isDryRun) return null;

  if (!isDryRun) {
    log('Waiting for bridge confirmation (~10-15 min)...');
    const { createPublicClient, http, formatEther } = require('viem');
    const { arbitrum } = require('viem/chains');
    const { walletAddress } = ensureDeFiSecrets();
    const arbClient = createPublicClient({ chain: arbitrum, transport: http('https://arbitrum-one-rpc.publicnode.com') });

    for (let i = 0; i < 40; i += 1) {
      await sleep(30000);
      const bal = await arbClient.getBalance({ address: walletAddress });
      const ethBal = parseFloat(formatEther(bal));
      log(`[poll ${i + 1}/40] Arbitrum ETH: ${ethBal.toFixed(6)}`);
      if (ethBal >= 0.005) {
        log('ETH arrived on Arbitrum!');
        break;
      }
    }
  }

  log('\n--- Step 2/4: Swap ETH → USDC ---');
  const swapped = await swapEthToUsdc();
  if (!swapped && !isDryRun) return null;

  log('\n--- Step 3/4: Deposit USDC to Hyperliquid ---');
  const deposited = await depositToHyperliquid();
  if (!deposited && !isDryRun) return null;

  if (!isDryRun) {
    log('Waiting 90s for Hyperliquid to credit deposit...');
    await sleep(90000);
  }

  log('\n--- Step 4/4: Open Position ---');
  const trade = await openHyperliquidPosition(tradeOptions);
  if (trade) {
    log('\n=== FULL SEND COMPLETE ===');
    log(`${trade.direction === 'LONG' ? 'Bought' : 'Shorted'} ${trade.size} ${trade.asset} @ ~$${trade.price.toFixed(2)}, ${tradeOptions.leverage}x leverage`);
    log(`Collateral: $${trade.collateral.toFixed(2)}`);
    log('Stop loss set, take profit set. Swing trade - check back in 1-3 days.');
  }
  return trade;
}

async function main(argv = parseCliArgs()) {
  try {
    if (getOption(argv?.options, 'help', false)) {
      console.log(formatHelpText());
      return { ok: true, help: true };
    }

    const localCommand = argv?.positional?.[0] || 'status';
    const tradeOptions = parseTradeOptions(argv);
    let result;
    switch (localCommand) {
      case 'status':
        result = await checkStatus();
        break;
      case 'bridge':
        result = await bridgeToArbitrum();
        break;
      case 'swap':
        result = await swapEthToUsdc();
        break;
      case 'deposit':
        result = await depositToHyperliquid();
        break;
      case 'trade':
        result = await openHyperliquidPosition(tradeOptions);
        break;
      case 'stop-loss':
        result = await setHyperliquidStopLoss(tradeOptions);
        break;
      case 'full-send':
        result = await fullSend(tradeOptions);
        break;
      default:
        err(`Unknown command: ${localCommand}`);
        err(formatHelpText());
        process.exit(1);
    }

    if (result == null && localCommand !== 'status') {
      process.exitCode = 1;
    }
    return result;
  } catch (e) {
    err(`Fatal: ${e.message}`);
    console.error(e);
    process.exit(1);
  }
}

if (require.main === module) {
  withManualHyperliquidActivity(
    () => main(),
    {
      command: 'hm-defi-execute',
      caller: process.env.SQUIDRUN_HYPERLIQUID_CALLER || 'manual',
      metadata: {
        argv: process.argv.slice(2),
      },
    }
  );
}

module.exports = {
  resolveWalletAddress,
  ensureDeFiSecrets,
  parseCliArgs,
  normalizeAssetName,
  normalizeDirection,
  normalizeClientOrderId,
  buildClientOrderIdFingerprint,
  resolveTradeClientOrderId,
  extractHyperliquidOrderId,
  readTradingWriteAuditEntries,
  findLatestActiveHyperliquidTriggerOrderFromAudit,
  getExistingHyperliquidOrderByCloid,
  isBlockingExistingHyperliquidOrder,
  toPositiveNumber,
  toNumber,
  clamp,
  normalizeConfidence,
  toNonNegativeInteger,
  isRateLimitError,
  resolvePerpPriceDecimals,
  resolvePricePrecision,
  resolveSafeStopDistancePct,
  assertStopLossBeforeLiquidation,
  constrainStopPriceWithinLiquidationBuffer,
  roundPrice,
  formatPrice,
  roundDown,
  normalizeHistoricalBars,
  calculateAtr,
  buildVolatilitySnapshot,
  resolveVolatilitySnapshot,
  withTimeout,
  executeHyperliquidInfoCall,
  parseTradeOptions,
  formatHelpText,
  findAssetMeta,
  resolveAssetMaxLeverage,
  resolveAssetSzDecimals,
  buildTradePlan,
  buildHyperliquidTriggerOrder,
  appendTradingWriteAudit,
  captureCallerStack,
  executeHyperliquidOrder,
  executeHyperliquidCancel,
  extractOpenHyperliquidPosition,
  resolveHyperliquidRuntime,
  placeHyperliquidStopLoss,
  placeHyperliquidTakeProfit,
  setHyperliquidStopLoss,
  checkStatus,
  bridgeToArbitrum,
  swapEthToUsdc,
  depositToHyperliquid,
  openHyperliquidPosition,
  fullSend,
  main,
  TRADING_WRITES_LOG_PATH,
};
