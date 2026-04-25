'use strict';

const fs = require('fs');
const path = require('path');
const { resolveCoordPath } = require('../../config');

const DEFAULT_REQUEST_POOL_TTL_MS = Math.max(
  1000,
  Number.parseInt(process.env.SQUIDRUN_HYPERLIQUID_REQUEST_POOL_TTL_MS || '15000', 10) || 15000
);
const DEFAULT_MARKET_REQUEST_POOL_TTL_MS = Math.max(
  1000,
  Number.parseInt(process.env.SQUIDRUN_HYPERLIQUID_MARKET_REQUEST_POOL_TTL_MS || '8000', 10) || 8000
);
const DEFAULT_ACCOUNT_REQUEST_POOL_TTL_MS = Math.max(
  1000,
  Number.parseInt(process.env.SQUIDRUN_HYPERLIQUID_ACCOUNT_REQUEST_POOL_TTL_MS || '15000', 10) || 15000
);
const DEFAULT_REQUEST_POOL_PENDING_TTL_MS = Math.max(
  1000,
  Number.parseInt(process.env.SQUIDRUN_HYPERLIQUID_REQUEST_POOL_PENDING_TTL_MS || '15000', 10) || 15000
);
const DEFAULT_REQUEST_POOL_LOCK_TIMEOUT_MS = Math.max(
  250,
  Number.parseInt(process.env.SQUIDRUN_HYPERLIQUID_REQUEST_POOL_LOCK_TIMEOUT_MS || '5000', 10) || 5000
);
const DEFAULT_REQUEST_POOL_LOCK_STALE_MS = Math.max(
  250,
  Number.parseInt(process.env.SQUIDRUN_HYPERLIQUID_REQUEST_POOL_LOCK_STALE_MS || '10000', 10) || 10000
);
const DEFAULT_REQUEST_POOL_WAIT_POLL_MS = Math.max(
  25,
  Number.parseInt(process.env.SQUIDRUN_HYPERLIQUID_REQUEST_POOL_WAIT_POLL_MS || '100', 10) || 100
);
const DEFAULT_RATE_LIMIT_BACKOFF_BASE_MS = Math.max(
  1000,
  Number.parseInt(process.env.SQUIDRUN_HYPERLIQUID_RATE_LIMIT_BACKOFF_BASE_MS || '60000', 10) || 60000
);
const DEFAULT_RATE_LIMIT_BACKOFF_MAX_MS = Math.max(
  DEFAULT_RATE_LIMIT_BACKOFF_BASE_MS,
  Number.parseInt(process.env.SQUIDRUN_HYPERLIQUID_RATE_LIMIT_BACKOFF_MAX_MS || '900000', 10) || 900000
);
const DEFAULT_RATE_LIMIT_BUCKET_CAPACITY = Math.max(
  1,
  Number.parseInt(process.env.SQUIDRUN_HYPERLIQUID_RATE_LIMIT_BUCKET_CAPACITY || '20', 10) || 20
);
const DEFAULT_RATE_LIMIT_BUCKET_REFILL_PER_SEC = Math.max(
  1,
  Number.parseInt(process.env.SQUIDRUN_HYPERLIQUID_RATE_LIMIT_BUCKET_REFILL_PER_SEC || '4', 10) || 4
);
const DEFAULT_RATE_LIMIT_QUEUE_TIMEOUT_MS = Math.max(
  100,
  Number.parseInt(process.env.SQUIDRUN_HYPERLIQUID_RATE_LIMIT_QUEUE_TIMEOUT_MS || '5000', 10) || 5000
);
const DEFAULT_RATE_LIMIT_STATE_PATH = resolveCoordPath(
  path.join('runtime', 'hyperliquid-rate-limit-state.json'),
  { forWrite: true }
);
const DEFAULT_REQUEST_POOL_PATH = resolveCoordPath(
  path.join('runtime', 'hyperliquid-request-pool.json'),
  { forWrite: true }
);
const DEFAULT_REQUEST_POOL_LOCK_PATH = resolveCoordPath(
  path.join('runtime', 'hyperliquid-request-pool.lock'),
  { forWrite: true }
);
const REQUEST_POOL_STATE = {
  memory: new Map(),
  inflight: new Map(),
};
const RATE_LIMIT_STATE = {
  memory: null,
};
const RATE_LIMIT_BUCKET = {
  tokens: DEFAULT_RATE_LIMIT_BUCKET_CAPACITY,
  capacity: DEFAULT_RATE_LIMIT_BUCKET_CAPACITY,
  refillPerSec: DEFAULT_RATE_LIMIT_BUCKET_REFILL_PER_SEC,
  lastRefillMs: Date.now(),
  waiters: [],
  tickTimer: null,
};
let HYPERLIQUID_SDK_PROMISE = null;

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function normalizeSymbols(symbols = []) {
  const list = Array.isArray(symbols) ? symbols : [symbols];
  const seen = new Set();
  const normalized = [];
  for (const value of list) {
    const ticker = toText(value);
    if (!ticker) continue;
    const key = ticker.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(ticker);
  }
  return normalized;
}

function stripUsdSuffix(ticker) {
  const normalized = toText(ticker);
  if (!normalized) return '';
  return normalized.toUpperCase().endsWith('/USD')
    ? normalized.slice(0, -4)
    : normalized;
}

function normalizeCoinKey(ticker) {
  return stripUsdSuffix(ticker).toUpperCase();
}

function normalizeCoinSymbol(ticker) {
  return normalizeCoinKey(ticker);
}

async function loadHyperliquidSdk() {
  if (!HYPERLIQUID_SDK_PROMISE) {
    HYPERLIQUID_SDK_PROMISE = import('@nktkas/hyperliquid');
  }
  return HYPERLIQUID_SDK_PROMISE;
}

async function createInfoClient(options = {}) {
  if (options.infoClient) return options.infoClient;
  const { HttpTransport, InfoClient } = await loadHyperliquidSdk();
  const transport = options.transport || new HttpTransport();
  return new InfoClient({ transport });
}

function resolveRequestPoolTtlMs(options = {}, cacheKey = '') {
  const ttlMs = Number.parseInt(options.requestPoolTtlMs, 10);
  if (Number.isFinite(ttlMs)) {
    return Math.max(0, ttlMs);
  }
  if (cacheKey === 'info:allMids' || cacheKey === 'info:metaAndAssetCtxs') {
    return DEFAULT_MARKET_REQUEST_POOL_TTL_MS;
  }
  if (String(cacheKey).startsWith('info:clearinghouseState:')) {
    return DEFAULT_ACCOUNT_REQUEST_POOL_TTL_MS;
  }
  if (String(cacheKey).startsWith('info:openOrders:')) {
    return DEFAULT_ACCOUNT_REQUEST_POOL_TTL_MS;
  }
  if (cacheKey === 'info:perpDexs') {
    return DEFAULT_ACCOUNT_REQUEST_POOL_TTL_MS;
  }
  return DEFAULT_REQUEST_POOL_TTL_MS;
}

function resolveRequestPoolPath(options = {}) {
  return toText(options.requestPoolPath, DEFAULT_REQUEST_POOL_PATH);
}

function resolveRequestPoolLockPath(options = {}) {
  return toText(options.requestPoolLockPath, DEFAULT_REQUEST_POOL_LOCK_PATH);
}

function resolveRequestPoolPendingTtlMs(options = {}) {
  const ttlMs = Number.parseInt(options.requestPoolPendingTtlMs, 10);
  if (Number.isFinite(ttlMs)) {
    return Math.max(1000, ttlMs);
  }
  return DEFAULT_REQUEST_POOL_PENDING_TTL_MS;
}

function resolveRequestPoolLockTimeoutMs(options = {}) {
  const timeoutMs = Number.parseInt(options.requestPoolLockTimeoutMs, 10);
  if (Number.isFinite(timeoutMs)) {
    return Math.max(250, timeoutMs);
  }
  return DEFAULT_REQUEST_POOL_LOCK_TIMEOUT_MS;
}

function resolveRequestPoolLockStaleMs(options = {}) {
  const staleMs = Number.parseInt(options.requestPoolLockStaleMs, 10);
  if (Number.isFinite(staleMs)) {
    return Math.max(250, staleMs);
  }
  return DEFAULT_REQUEST_POOL_LOCK_STALE_MS;
}

function resolveRequestPoolWaitPollMs(options = {}) {
  const pollMs = Number.parseInt(options.requestPoolWaitPollMs, 10);
  if (Number.isFinite(pollMs)) {
    return Math.max(25, pollMs);
  }
  return DEFAULT_REQUEST_POOL_WAIT_POLL_MS;
}

function resolveRateLimitStatePath(options = {}) {
  return toText(options.rateLimitStatePath, DEFAULT_RATE_LIMIT_STATE_PATH);
}

function resolveRateLimitBackoffBaseMs(options = {}) {
  const backoffMs = Number.parseInt(options.rateLimitBackoffBaseMs, 10);
  if (Number.isFinite(backoffMs)) {
    return Math.max(1000, backoffMs);
  }
  return DEFAULT_RATE_LIMIT_BACKOFF_BASE_MS;
}

function resolveRateLimitBackoffMaxMs(options = {}) {
  const maxMs = Number.parseInt(options.rateLimitBackoffMaxMs, 10);
  if (Number.isFinite(maxMs)) {
    return Math.max(resolveRateLimitBackoffBaseMs(options), maxMs);
  }
  return DEFAULT_RATE_LIMIT_BACKOFF_MAX_MS;
}

function ensureDirectoryForFile(filePath) {
  if (!filePath) return;
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
}

function clonePooledValue(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function readRequestPoolFile(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      return {};
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) {
      return {};
    }
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeRateLimitState(state = {}) {
  const normalized = state && typeof state === 'object' ? state : {};
  return {
    consecutive429s: Math.max(0, toNumber(normalized.consecutive429s, 0)),
    backoffUntil: toIsoTimestamp(normalized.backoffUntil, null),
    last429At: toIsoTimestamp(normalized.last429At, null),
    lastBackoffMs: Math.max(0, toNumber(normalized.lastBackoffMs, 0)),
    lastError: toText(normalized.lastError, null),
    lastSuccessAt: toIsoTimestamp(normalized.lastSuccessAt, null),
    updatedAt: toIsoTimestamp(normalized.updatedAt, null),
  };
}

function readRateLimitStateFile(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      return normalizeRateLimitState({});
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) {
      return normalizeRateLimitState({});
    }
    return normalizeRateLimitState(JSON.parse(raw));
  } catch {
    return normalizeRateLimitState({});
  }
}

function getLatestRequestPoolCacheMs(options = {}) {
  const filePath = resolveRequestPoolPath(options);
  const payload = readRequestPoolFile(filePath);
  let latestCachedAtMs = NaN;
  for (const entry of Object.values(payload || {})) {
    const cachedAtMs = Number(entry?.cachedAt);
    if (Number.isFinite(cachedAtMs) && (!Number.isFinite(latestCachedAtMs) || cachedAtMs > latestCachedAtMs)) {
      latestCachedAtMs = cachedAtMs;
    }
  }
  return latestCachedAtMs;
}

function writeRateLimitStateFile(filePath, payload = {}) {
  if (!filePath) return;
  try {
    ensureDirectoryForFile(filePath);
    fs.writeFileSync(filePath, JSON.stringify(normalizeRateLimitState(payload), null, 2), 'utf8');
  } catch {
    // Ignore shared governor persistence failures and keep using memory state.
  }
}

function reconcileRateLimitStateWithFreshPool(state = {}, options = {}) {
  const normalized = normalizeRateLimitState(state);
  if (!hasActiveRateLimitBackoff(normalized)) {
    return normalized;
  }
  const latestCachedAtMs = getLatestRequestPoolCacheMs(options);
  if (!Number.isFinite(latestCachedAtMs)) {
    return normalized;
  }
  const last429AtMs = Date.parse(toText(normalized.last429At, ''));
  if (Number.isFinite(last429AtMs) && latestCachedAtMs <= last429AtMs) {
    return normalized;
  }
  return clearRateLimitBackoffState(normalized, latestCachedAtMs);
}

function readSharedRateLimitState(options = {}) {
  const filePath = resolveRateLimitStatePath(options);
  const sourceState = RATE_LIMIT_STATE.memory
    ? normalizeRateLimitState(RATE_LIMIT_STATE.memory)
    : readRateLimitStateFile(filePath);
  const reconciledState = reconcileRateLimitStateWithFreshPool(sourceState, options);
  RATE_LIMIT_STATE.memory = reconciledState;
  if (JSON.stringify(reconciledState) !== JSON.stringify(sourceState)) {
    writeRateLimitStateFile(filePath, reconciledState);
  }
  return normalizeRateLimitState(reconciledState);
}

function writeSharedRateLimitState(nextState = {}, options = {}) {
  const normalized = normalizeRateLimitState({
    ...nextState,
    updatedAt: new Date().toISOString(),
  });
  RATE_LIMIT_STATE.memory = normalized;
  writeRateLimitStateFile(resolveRateLimitStatePath(options), normalized);
  return normalized;
}

function hasActiveRateLimitBackoff(state = {}, nowMs = Date.now()) {
  const backoffUntilMs = Date.parse(toText(state?.backoffUntil, ''));
  return Number.isFinite(backoffUntilMs) && backoffUntilMs > nowMs;
}

function isRateLimitError(error) {
  const message = String(error?.stack || error?.message || error || '').toLowerCase();
  return (
    message.includes('429')
    || message.includes('too many requests')
    || message.includes('too many connections')
    || message.includes('rate limit')
    || message.includes('rate-limited')
  );
}

function buildRateLimitBackoffState(previousState = {}, options = {}, error = null, nowMs = Date.now()) {
  const consecutive429s = Math.max(0, toNumber(previousState?.consecutive429s, 0)) + 1;
  const baseBackoffMs = resolveRateLimitBackoffBaseMs(options);
  const maxBackoffMs = resolveRateLimitBackoffMaxMs(options);
  const nextBackoffMs = Math.min(
    maxBackoffMs,
    baseBackoffMs * (2 ** Math.max(0, consecutive429s - 1))
  );
  return {
    consecutive429s,
    backoffUntil: new Date(nowMs + nextBackoffMs).toISOString(),
    last429At: new Date(nowMs).toISOString(),
    lastBackoffMs: nextBackoffMs,
    lastError: toText(error?.message || error, '429'),
    lastSuccessAt: previousState?.lastSuccessAt || null,
  };
}

function clearRateLimitBackoffState(previousState = {}, nowMs = Date.now()) {
  return {
    ...normalizeRateLimitState(previousState),
    consecutive429s: 0,
    backoffUntil: null,
    lastBackoffMs: 0,
    lastError: null,
    lastSuccessAt: new Date(nowMs).toISOString(),
    updatedAt: new Date(nowMs).toISOString(),
  };
}

function buildActiveBackoffError(state = {}) {
  const backoffUntil = toText(state?.backoffUntil, '');
  const error = new Error(
    backoffUntil
      ? `Hyperliquid shared rate-limit backoff active until ${backoffUntil}`
      : 'Hyperliquid shared rate-limit backoff active'
  );
  error.code = 'HL_RATE_LIMIT_BACKOFF';
  error.rateLimitState = normalizeRateLimitState(state);
  return error;
}

function refillRateLimitBucket(now = Date.now()) {
  const elapsedMs = now - RATE_LIMIT_BUCKET.lastRefillMs;
  if (elapsedMs <= 0) return;
  const added = (elapsedMs / 1000) * RATE_LIMIT_BUCKET.refillPerSec;
  RATE_LIMIT_BUCKET.tokens = Math.min(
    RATE_LIMIT_BUCKET.capacity,
    RATE_LIMIT_BUCKET.tokens + added
  );
  RATE_LIMIT_BUCKET.lastRefillMs = now;
  while (RATE_LIMIT_BUCKET.waiters.length > 0 && RATE_LIMIT_BUCKET.tokens >= 1) {
    const waiter = RATE_LIMIT_BUCKET.waiters.shift();
    RATE_LIMIT_BUCKET.tokens -= 1;
    if (waiter.timer) clearTimeout(waiter.timer);
    waiter.resolve();
  }
}

function scheduleRateLimitBucketTick() {
  if (RATE_LIMIT_BUCKET.tickTimer) return;
  const tickMs = Math.max(50, Math.ceil(1000 / Math.max(1, RATE_LIMIT_BUCKET.refillPerSec)));
  RATE_LIMIT_BUCKET.tickTimer = setTimeout(() => {
    RATE_LIMIT_BUCKET.tickTimer = null;
    refillRateLimitBucket();
    if (RATE_LIMIT_BUCKET.waiters.length > 0) {
      scheduleRateLimitBucketTick();
    }
  }, tickMs);
  if (RATE_LIMIT_BUCKET.tickTimer && typeof RATE_LIMIT_BUCKET.tickTimer.unref === 'function') {
    RATE_LIMIT_BUCKET.tickTimer.unref();
  }
}

function acquireRateLimitToken(options = {}) {
  if (options.bypassRateLimitBucket === true) return Promise.resolve();
  if (options.disableRateLimitGovernor === true) return Promise.resolve();
  refillRateLimitBucket();
  if (RATE_LIMIT_BUCKET.tokens >= 1 && RATE_LIMIT_BUCKET.waiters.length === 0) {
    RATE_LIMIT_BUCKET.tokens -= 1;
    return Promise.resolve();
  }
  const timeoutMs = Number.isFinite(Number(options.rateLimitQueueTimeoutMs))
    ? Number(options.rateLimitQueueTimeoutMs)
    : DEFAULT_RATE_LIMIT_QUEUE_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject, timer: null };
    waiter.timer = setTimeout(() => {
      const idx = RATE_LIMIT_BUCKET.waiters.indexOf(waiter);
      if (idx >= 0) RATE_LIMIT_BUCKET.waiters.splice(idx, 1);
      const err = new Error(`Hyperliquid rate-limit queue timeout after ${timeoutMs}ms`);
      err.code = 'rate_limit_queue_timeout';
      reject(err);
    }, timeoutMs);
    RATE_LIMIT_BUCKET.waiters.push(waiter);
    scheduleRateLimitBucketTick();
  });
}

function resetRateLimitBucket() {
  while (RATE_LIMIT_BUCKET.waiters.length > 0) {
    const waiter = RATE_LIMIT_BUCKET.waiters.shift();
    if (waiter.timer) clearTimeout(waiter.timer);
    waiter.reject(new Error('rate_limit_bucket_reset'));
  }
  if (RATE_LIMIT_BUCKET.tickTimer) {
    clearTimeout(RATE_LIMIT_BUCKET.tickTimer);
    RATE_LIMIT_BUCKET.tickTimer = null;
  }
  RATE_LIMIT_BUCKET.tokens = RATE_LIMIT_BUCKET.capacity;
  RATE_LIMIT_BUCKET.lastRefillMs = Date.now();
}

async function executeSharedRateLimitedRequest(label, requestFactory, options = {}) {
  if (typeof requestFactory !== 'function') {
    throw new Error(`Hyperliquid request "${label}" is missing a request factory.`);
  }
  if (options.disableRateLimitGovernor !== true) {
    const currentState = readSharedRateLimitState(options);
    if (hasActiveRateLimitBackoff(currentState)) {
      throw buildActiveBackoffError(currentState);
    }
  }
  await acquireRateLimitToken(options);
  try {
    const payload = await requestFactory();
    if (options.disableRateLimitGovernor !== true) {
      writeSharedRateLimitState(clearRateLimitBackoffState(readSharedRateLimitState(options)), options);
    }
    return payload;
  } catch (error) {
    if (options.disableRateLimitGovernor !== true && isRateLimitError(error)) {
      const nextState = writeSharedRateLimitState(
        buildRateLimitBackoffState(readSharedRateLimitState(options), options, error),
        options
      );
      error.rateLimitState = nextState;
    }
    throw error;
  }
}

function writeRequestPoolFile(filePath, payload = {}) {
  if (!filePath) return;
  try {
    ensureDirectoryForFile(filePath);
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
  } catch {
    // Ignore pooling write failures and fall back to memory-only dedupe.
  }
}

async function withRequestPoolLock(options = {}, callback = async () => undefined) {
  const lockPath = resolveRequestPoolLockPath(options);
  const timeoutMs = resolveRequestPoolLockTimeoutMs(options);
  const staleMs = resolveRequestPoolLockStaleMs(options);
  const startedAt = Date.now();
  const retryDelayMs = resolveRequestPoolWaitPollMs(options);
  ensureDirectoryForFile(lockPath);

  while ((Date.now() - startedAt) <= timeoutMs) {
    let fd = null;
    try {
      fd = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(fd, String(process.pid), 'utf8');
      try {
        return await callback();
      } finally {
        try {
          if (fd != null) fs.closeSync(fd);
        } catch {}
        try {
          fs.unlinkSync(lockPath);
        } catch {}
      }
    } catch (error) {
      try {
        if (fd != null) fs.closeSync(fd);
      } catch {}
      if (error?.code !== 'EEXIST') {
        throw error;
      }
      try {
        const stats = fs.statSync(lockPath);
        if ((Date.now() - stats.mtimeMs) > staleMs) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {}
      await sleep(retryDelayMs);
    }
  }

  throw new Error(`Hyperliquid request pool lock timeout after ${timeoutMs}ms`);
}

function isFreshRequestPoolEntry(entry, ttlMs, now = Date.now()) {
  const cachedAt = Number(entry?.cachedAt);
  return Number.isFinite(cachedAt) && ttlMs > 0 && (now - cachedAt) <= ttlMs;
}

function isPendingRequestPoolEntry(entry, now = Date.now()) {
  const pendingUntil = Number(entry?.pendingUntilMs);
  return Number.isFinite(pendingUntil) && pendingUntil > now;
}

function buildPendingRequestPoolEntry(existingEntry = {}, options = {}) {
  const now = Date.now();
  return {
    ...((existingEntry && typeof existingEntry === 'object') ? existingEntry : {}),
    pendingAtMs: now,
    pendingUntilMs: now + resolveRequestPoolPendingTtlMs(options),
    pendingBy: process.pid,
  };
}

function clearPendingRequestPoolEntry(entry = {}) {
  if (!entry || typeof entry !== 'object') return entry;
  const next = { ...entry };
  delete next.pendingAtMs;
  delete next.pendingUntilMs;
  delete next.pendingBy;
  return next;
}

function readFreshRequestPoolEntry(cacheKey, options = {}) {
  const ttlMs = resolveRequestPoolTtlMs(options, cacheKey);
  if (ttlMs <= 0) return null;
  const now = Date.now();
  const memoryEntry = REQUEST_POOL_STATE.memory.get(cacheKey);
  if (isFreshRequestPoolEntry(memoryEntry, ttlMs, now)) {
    return clonePooledValue(memoryEntry.value);
  }
  REQUEST_POOL_STATE.memory.delete(cacheKey);
  const filePath = resolveRequestPoolPath(options);
  const payload = readRequestPoolFile(filePath);
  const fileEntry = payload?.[cacheKey];
  if (isFreshRequestPoolEntry(fileEntry, ttlMs, now)) {
    REQUEST_POOL_STATE.memory.set(cacheKey, fileEntry);
    return clonePooledValue(fileEntry.value);
  }
  if (fileEntry && !isPendingRequestPoolEntry(fileEntry, now)) {
    delete payload[cacheKey];
    writeRequestPoolFile(filePath, payload);
  }
  return null;
}

function readAnyRequestPoolEntry(cacheKey, options = {}) {
  const memoryEntry = REQUEST_POOL_STATE.memory.get(cacheKey);
  const maxStaleMs = Number.isFinite(Number(options.maxStaleMs)) ? Number(options.maxStaleMs) : 5 * 60 * 1000;
  const now = Date.now();

  if (memoryEntry && Object.prototype.hasOwnProperty.call(memoryEntry, 'value')) {
    const cachedAt = Number(memoryEntry.cachedAt);
    if (Number.isFinite(cachedAt) && (now - cachedAt) <= maxStaleMs) {
      return clonePooledValue(memoryEntry.value);
    }
  }
  const filePath = resolveRequestPoolPath(options);
  const payload = readRequestPoolFile(filePath);
  const fileEntry = payload?.[cacheKey];
  if (fileEntry && Object.prototype.hasOwnProperty.call(fileEntry, 'value')) {
    const cachedAt = Number(fileEntry.cachedAt);
    if (Number.isFinite(cachedAt) && (now - cachedAt) <= maxStaleMs) {
      REQUEST_POOL_STATE.memory.set(cacheKey, fileEntry);
      return clonePooledValue(fileEntry.value);
    }
  }
  return null;
}

function writeRequestPoolEntry(cacheKey, value, options = {}) {
  const ttlMs = resolveRequestPoolTtlMs(options, cacheKey);
  if (ttlMs <= 0) return;
  const entry = clearPendingRequestPoolEntry({
    cachedAt: Date.now(),
    value: clonePooledValue(value),
  });
  REQUEST_POOL_STATE.memory.set(cacheKey, entry);
  const filePath = resolveRequestPoolPath(options);
  const payload = readRequestPoolFile(filePath);
  payload[cacheKey] = entry;
  writeRequestPoolFile(filePath, payload);
  if (options.disableRateLimitGovernor !== true) {
    const currentRateLimitState = readSharedRateLimitState(options);
    if (hasActiveRateLimitBackoff(currentRateLimitState)) {
      writeSharedRateLimitState(clearRateLimitBackoffState(currentRateLimitState, entry.cachedAt), options);
    }
  }
}

async function reserveCrossProcessRequestPoolSlot(cacheKey, options = {}) {
  const filePath = resolveRequestPoolPath(options);
  const staleFallback = readAnyRequestPoolEntry(cacheKey, options);
  return withRequestPoolLock(options, async () => {
    const payload = readRequestPoolFile(filePath);
    const fileEntry = payload?.[cacheKey];
    const freshEntry = isFreshRequestPoolEntry(fileEntry, resolveRequestPoolTtlMs(options, cacheKey))
      ? fileEntry
      : null;
    if (freshEntry) {
      REQUEST_POOL_STATE.memory.set(cacheKey, freshEntry);
      return {
        action: 'cached',
        cachedValue: clonePooledValue(freshEntry.value),
      };
    }
    if (isPendingRequestPoolEntry(fileEntry)) {
      return {
        action: 'wait',
        staleFallback,
      };
    }
    payload[cacheKey] = buildPendingRequestPoolEntry(fileEntry, options);
    writeRequestPoolFile(filePath, payload);
    return {
      action: 'produce',
      staleFallback,
    };
  });
}

async function waitForCrossProcessRequestPoolResolution(cacheKey, options = {}, staleFallback = null) {
  const deadlineMs = Date.now() + resolveRequestPoolPendingTtlMs(options);
  const pollMs = resolveRequestPoolWaitPollMs(options);
  while (Date.now() <= deadlineMs) {
    const cached = readFreshRequestPoolEntry(cacheKey, options);
    if (cached != null) {
      return cached;
    }
    const filePath = resolveRequestPoolPath(options);
    const payload = readRequestPoolFile(filePath);
    const fileEntry = payload?.[cacheKey];
    if (!isPendingRequestPoolEntry(fileEntry)) {
      break;
    }
    await sleep(pollMs);
  }
  if (staleFallback != null) {
    return staleFallback;
  }
  return null;
}

async function clearCrossProcessPendingRequest(cacheKey, options = {}) {
  const filePath = resolveRequestPoolPath(options);
  await withRequestPoolLock(options, async () => {
    const payload = readRequestPoolFile(filePath);
    const fileEntry = payload?.[cacheKey];
    if (!fileEntry) {
      return;
    }
    if (Object.prototype.hasOwnProperty.call(fileEntry, 'value')) {
      payload[cacheKey] = clearPendingRequestPoolEntry(fileEntry);
    } else {
      delete payload[cacheKey];
    }
    writeRequestPoolFile(filePath, payload);
  }).catch(() => {});
}

async function getPooledRequest(cacheKey, producer, options = {}) {
  if (options.disableRequestPool) {
    return producer();
  }
  const staleFallback = readAnyRequestPoolEntry(cacheKey, options);
  if (options.disableRateLimitGovernor !== true) {
    const rateLimitState = readSharedRateLimitState(options);
    if (hasActiveRateLimitBackoff(rateLimitState)) {
      if (staleFallback != null && options.allowStaleOnRateLimit !== false) {
        return staleFallback;
      }
      throw buildActiveBackoffError(rateLimitState);
    }
  }
  const cached = readFreshRequestPoolEntry(cacheKey, options);
  if (cached != null) {
    return cached;
  }
  if (REQUEST_POOL_STATE.inflight.has(cacheKey)) {
    return REQUEST_POOL_STATE.inflight.get(cacheKey);
  }
  const pending = Promise.resolve()
    .then(async () => {
      const slot = await reserveCrossProcessRequestPoolSlot(cacheKey, options);
      if (slot?.action === 'cached') {
        return slot.cachedValue;
      }
      if (slot?.action === 'wait') {
        const resolvedValue = await waitForCrossProcessRequestPoolResolution(
          cacheKey,
          options,
          slot.staleFallback
        );
        if (resolvedValue != null) {
          return resolvedValue;
        }
      }
      try {
        const value = await producer();
        writeRequestPoolEntry(cacheKey, value, options);
        return clonePooledValue(value);
      } catch (error) {
        await clearCrossProcessPendingRequest(cacheKey, options);
        if (slot?.staleFallback != null) {
          return slot.staleFallback;
        }
        throw error;
      }
    })
    .then((value) => {
      return clonePooledValue(value);
    })
    .catch((error) => {
      if (staleFallback != null) {
        return staleFallback;
      }
      throw error;
    })
    .finally(() => {
      REQUEST_POOL_STATE.inflight.delete(cacheKey);
    });
  REQUEST_POOL_STATE.inflight.set(cacheKey, pending);
  return pending;
}

function countPositiveNumbers(values = []) {
  return (Array.isArray(values) ? values : []).reduce((count, value) => {
    return count + (Number.isFinite(Number(value)) && Number(value) > 0 ? 1 : 0);
  }, 0);
}

function isAllMidsPayloadHealthy(payload = {}) {
  const entries = payload && typeof payload === 'object' ? Object.values(payload) : [];
  if (entries.length === 0) return false;
  return countPositiveNumbers(entries) >= Math.min(entries.length, 25);
}

function isMetaAndAssetCtxsPayloadHealthy(payload = null) {
  const [meta, assetCtxs] = Array.isArray(payload) ? payload : [null, null];
  const universe = Array.isArray(meta?.universe) ? meta.universe : [];
  const contexts = Array.isArray(assetCtxs) ? assetCtxs : [];
  if (universe.length === 0 || contexts.length === 0) return false;
  const populatedContexts = contexts.filter((ctx) => {
    return countPositiveNumbers([
      ctx?.markPx,
      ctx?.midPx,
      ctx?.dayNtlVlm,
      ctx?.openInterest,
      ctx?.prevDayPx,
    ]) > 0;
  }).length;
  return populatedContexts >= Math.min(contexts.length, 25);
}

async function resolveCanonicalCoinSymbol(ticker, options = {}) {
  const requestedCoin = stripUsdSuffix(ticker);
  if (!requestedCoin) return '';
  const requestedKey = normalizeCoinKey(requestedCoin);
  const metaAndAssetCtxs = options.metaAndAssetCtxs || await getMetaAndAssetCtxs(options).catch(() => null);
  const [meta] = Array.isArray(metaAndAssetCtxs) ? metaAndAssetCtxs : [null];
  const universe = Array.isArray(meta?.universe) ? meta.universe : [];
  for (const asset of universe) {
    const assetCoin = toText(asset?.name || asset?.coin || asset);
    if (normalizeCoinKey(assetCoin) === requestedKey) {
      return assetCoin || requestedCoin;
    }
  }
  return requestedCoin;
}

async function postInfoRequest(payload = {}, options = {}) {
  const fetchImpl = options.fetch || global.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('Fetch implementation is unavailable for Hyperliquid info requests.');
  }
  return executeSharedRateLimitedRequest(
    `info:${toText(payload?.type, 'unknown')}`,
    async () => {
      const response = await fetchImpl(options.infoEndpoint || 'https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        throw new Error(`Hyperliquid info request failed with status ${response.status}`);
      }
      return response.json();
    },
    options
  );
}

async function getAllMids(options = {}) {
  const client = await createInfoClient(options);
  if (client && typeof client.allMids === 'function') {
    return getPooledRequest('info:allMids', async () => {
      const payload = await client.allMids();
      if (!isAllMidsPayloadHealthy(payload)) {
        throw new Error('Hyperliquid allMids payload was empty or zeroed.');
      }
      return payload;
    }, options);
  }
  return getPooledRequest('info:allMids', async () => {
    const payload = await postInfoRequest({ type: 'allMids' }, options);
    if (!isAllMidsPayloadHealthy(payload)) {
      throw new Error('Hyperliquid allMids payload was empty or zeroed.');
    }
    return payload;
  }, options);
}

async function getMetaAndAssetCtxs(options = {}) {
  const client = await createInfoClient(options);
  if (client && typeof client.metaAndAssetCtxs === 'function') {
    return getPooledRequest('info:metaAndAssetCtxs', async () => {
      const payload = await client.metaAndAssetCtxs();
      if (!isMetaAndAssetCtxsPayloadHealthy(payload)) {
        throw new Error('Hyperliquid metaAndAssetCtxs payload was empty or zeroed.');
      }
      return payload;
    }, options);
  }
  return getPooledRequest(
    'info:metaAndAssetCtxs',
    async () => {
      const payload = await postInfoRequest({ type: 'metaAndAssetCtxs' }, options);
      if (!isMetaAndAssetCtxsPayloadHealthy(payload)) {
        throw new Error('Hyperliquid metaAndAssetCtxs payload was empty or zeroed.');
      }
      return payload;
    },
    options
  );
}

async function getUserFees(options = {}) {
  const user = toText(
    options.user,
    toText(options.walletAddress, resolveWalletAddress(options.env || process.env))
  );
  if (!user) {
    throw new Error('Hyperliquid user address is missing. Set POLYMARKET_FUNDER_ADDRESS or HYPERLIQUID_WALLET_ADDRESS.');
  }
  const client = await createInfoClient(options);
  if (client && typeof client.userFees === 'function') {
    return executeSharedRateLimitedRequest(
      `info:userFees:${user.toLowerCase()}`,
      () => client.userFees({ user }),
      options
    );
  }
  return postInfoRequest({ type: 'userFees', user }, options);
}

function normalizeDexName(value, fallback = null) {
  const normalized = toText(value, '');
  return normalized || fallback;
}

async function getPerpDexs(options = {}) {
  if (options.perpDexs) {
    return Array.isArray(options.perpDexs) ? options.perpDexs : [];
  }
  const client = await createInfoClient(options);
  if (client && typeof client.perpDexs === 'function') {
    return getPooledRequest(
      'info:perpDexs',
      () => executeSharedRateLimitedRequest('info:perpDexs', () => client.perpDexs(), options),
      options
    );
  }
  return getPooledRequest('info:perpDexs', () => postInfoRequest({ type: 'perpDexs' }, options), options);
}

function resolveTrackedPerpDexNames(perpDexs = [], options = {}) {
  const explicitDex = normalizeDexName(options.dex, null);
  if (explicitDex) {
    return [explicitDex];
  }
  if (Array.isArray(options.dexNames) && options.dexNames.length > 0) {
    return Array.from(new Set(
      options.dexNames
        .map((entry) => normalizeDexName(entry, null))
        .filter(Boolean)
    ));
  }
  if (options.includePerpDexs === false) {
    return [];
  }
  return Array.from(new Set(
    (Array.isArray(perpDexs) ? perpDexs : [])
      .map((entry) => normalizeDexName(entry?.name || entry?.dex || entry, null))
      .filter(Boolean)
  ));
}

function resolveWatchlistEntries(options = {}) {
  if (Array.isArray(options.watchlistEntries) && options.watchlistEntries.length > 0) {
    return options.watchlistEntries;
  }
  return normalizeSymbols(options.symbols).map((ticker) => ({ ticker }));
}

function resolveCandleInterval(timeframe = '1Day') {
  const normalized = toText(timeframe, '1Day').toLowerCase();
  if (normalized === '1day' || normalized === '1d' || normalized === 'day') return '1d';
  if (normalized === '1hour' || normalized === '1h' || normalized === 'hour') return '1h';
  if (normalized === '30min' || normalized === '30m') return '30m';
  if (normalized === '15min' || normalized === '15m') return '15m';
  if (normalized === '5min' || normalized === '5m') return '5m';
  if (normalized === '3min' || normalized === '3m') return '3m';
  if (normalized === '1min' || normalized === '1m' || normalized === 'minute') return '1m';
  if (normalized === '1week' || normalized === '1w' || normalized === 'week') return '1w';
  if (normalized === '1month' || normalized === '1mth' || normalized === 'month') return '1M';
  return '1d';
}

function resolveIntervalMs(interval = '1d') {
  switch (interval) {
    case '1m': return 60_000;
    case '3m': return 3 * 60_000;
    case '5m': return 5 * 60_000;
    case '15m': return 15 * 60_000;
    case '30m': return 30 * 60_000;
    case '1h': return 60 * 60_000;
    case '2h': return 2 * 60 * 60_000;
    case '4h': return 4 * 60 * 60_000;
    case '8h': return 8 * 60 * 60_000;
    case '12h': return 12 * 60 * 60_000;
    case '1d': return 24 * 60 * 60_000;
    case '3d': return 3 * 24 * 60 * 60_000;
    case '1w': return 7 * 24 * 60 * 60_000;
    case '1M': return 30 * 24 * 60 * 60_000;
    default: return 24 * 60 * 60_000;
  }
}

function buildSnapshotFromMarketData(ticker, midPrice, candles = [], checkedAt = new Date().toISOString()) {
  const latest = candles[candles.length - 1] || null;
  const previous = candles[candles.length - 2] || null;
  const tradePrice = toNumber(midPrice, toNumber(latest?.c, 0)) || null;
  return {
    symbol: ticker,
    tradePrice,
    bidPrice: null,
    askPrice: null,
    minuteClose: toNumber(latest?.c, 0) || null,
    dailyClose: toNumber(latest?.c, 0) || null,
    previousClose: toNumber(previous?.c, 0) || null,
    dailyVolume: toNumber(latest?.v, 0) || null,
    tradeTimestamp: toIsoTimestamp(latest?.T, null),
    quoteTimestamp: checkedAt,
    raw: {
      midPrice: midPrice != null ? String(midPrice) : null,
      candles,
    },
  };
}

function normalizeBar(ticker, candle = {}) {
  return {
    symbol: ticker,
    timestamp: toIsoTimestamp(candle?.t, null),
    open: toNumber(candle?.o, 0) || null,
    high: toNumber(candle?.h, 0) || null,
    low: toNumber(candle?.l, 0) || null,
    close: toNumber(candle?.c, 0) || null,
    volume: toNumber(candle?.v, 0) || null,
    tradeCount: toNumber(candle?.n, 0) || null,
    vwap: null,
  };
}

function normalizePredictedFundingPayload(predictedFundings = [], asOf = new Date().toISOString()) {
  const byCoin = {};
  for (const entry of Array.isArray(predictedFundings) ? predictedFundings : []) {
    const coin = normalizeCoinSymbol(Array.isArray(entry) ? entry[0] : '');
    if (!coin) continue;
    const venues = Array.isArray(entry?.[1]) ? entry[1] : [];
    const normalizedVenues = {};
    for (const [venue, data] of venues) {
      const venueName = toText(venue);
      if (!venueName) continue;
      normalizedVenues[venueName] = {
        fundingRate: toNumber(data?.fundingRate, 0),
        nextFundingTime: toIsoTimestamp(data?.nextFundingTime, null),
        fundingIntervalHours: Number.isFinite(Number(data?.fundingIntervalHours))
          ? Number(data.fundingIntervalHours)
          : null,
      };
    }
    const primaryVenue = normalizedVenues.HlPerp || Object.values(normalizedVenues)[0] || null;
    byCoin[coin] = {
      venue: normalizedVenues.HlPerp ? 'HlPerp' : (Object.keys(normalizedVenues)[0] || null),
      fundingRate: primaryVenue?.fundingRate ?? null,
      nextFundingTime: primaryVenue?.nextFundingTime ?? null,
      fundingIntervalHours: primaryVenue?.fundingIntervalHours ?? null,
      venues: normalizedVenues,
      raw: entry,
    };
  }
  return {
    asOf,
    byCoin,
    raw: Array.isArray(predictedFundings) ? predictedFundings : [],
  };
}

function normalizeL2BookPayload(coin, book = {}, asOf = new Date().toISOString()) {
  const levels = Array.isArray(book?.levels) ? book.levels : [];
  const bids = Array.isArray(levels[0]) ? levels[0] : [];
  const asks = Array.isArray(levels[1]) ? levels[1] : [];
  const normalizeLevel = (level = {}) => {
    const px = toNumber(level?.px, 0);
    const sz = toNumber(level?.sz, 0);
    return {
      px: px || null,
      sz: sz || null,
      n: Number.isFinite(Number(level?.n)) ? Number(level.n) : null,
      usd: px > 0 && sz > 0 ? Number((px * sz).toFixed(2)) : null,
    };
  };
  const normalizedBids = bids.map(normalizeLevel).filter((level) => level.px > 0 && level.sz > 0);
  const normalizedAsks = asks.map(normalizeLevel).filter((level) => level.px > 0 && level.sz > 0);
  const bestBid = normalizedBids[0]?.px || null;
  const bestAsk = normalizedAsks[0]?.px || null;
  const mid = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : (bestBid || bestAsk || null);
  const spread = bestBid && bestAsk ? Number((bestAsk - bestBid).toFixed(8)) : null;
  const spreadPct = spread != null && mid > 0 ? Number((spread / mid).toFixed(8)) : null;
  const sumDepth = (entries = [], limit = 5) => entries
    .slice(0, limit)
    .reduce((sum, level) => sum + toNumber(level.usd, 0), 0);
  const top5BidUsd = Number(sumDepth(normalizedBids, 5).toFixed(2));
  const top5AskUsd = Number(sumDepth(normalizedAsks, 5).toFixed(2));
  const top10BidUsd = Number(sumDepth(normalizedBids, 10).toFixed(2));
  const top10AskUsd = Number(sumDepth(normalizedAsks, 10).toFixed(2));
  const imbalance = (bidUsd, askUsd) => {
    const total = bidUsd + askUsd;
    return total > 0 ? Number(((bidUsd - askUsd) / total).toFixed(4)) : null;
  };
  const depthImbalanceTop5 = imbalance(top5BidUsd, top5AskUsd);
  const depthImbalanceTop10 = imbalance(top10BidUsd, top10AskUsd);
  const nearTouchSkew = depthImbalanceTop5 == null
    ? 'balanced'
    : depthImbalanceTop5 >= 0.1
      ? 'bid_heavy'
      : depthImbalanceTop5 <= -0.1
        ? 'ask_heavy'
        : 'balanced';
  return {
    coin,
    asOf: toIsoTimestamp(book?.time, asOf),
    bestBid,
    bestAsk,
    mid,
    spread,
    spreadPct,
    top5BidUsd,
    top5AskUsd,
    top10BidUsd,
    top10AskUsd,
    depthImbalanceTop5,
    depthImbalanceTop10,
    nearTouchSkew,
    bids: normalizedBids,
    asks: normalizedAsks,
    raw: book,
  };
}

function normalizeVaultDetailsPayload(vaultAddress, payload, asOf = new Date().toISOString()) {
  return {
    vaultAddress: toText(vaultAddress).toLowerCase(),
    asOf,
    leader: toText(payload?.leader || payload?.owner || payload?.user, null),
    name: toText(payload?.name || payload?.displayName, null),
    accountValue: Number.isFinite(Number(payload?.accountValue)) ? Number(payload.accountValue) : null,
    apr: Number.isFinite(Number(payload?.apr)) ? Number(payload.apr) : null,
    raw: payload ?? null,
  };
}

function normalizeUserVaultEquitiesPayload(user, payload = [], asOf = new Date().toISOString()) {
  const entries = (Array.isArray(payload) ? payload : []).map((entry) => ({
    vaultAddress: toText(entry?.vaultAddress || entry?.vault, '').toLowerCase() || null,
    equity: Number.isFinite(Number(entry?.equity)) ? Number(entry.equity) : null,
    pnl: Number.isFinite(Number(entry?.pnl)) ? Number(entry.pnl) : null,
    raw: entry,
  }));
  return {
    user: toText(user).toLowerCase(),
    asOf,
    entries,
    raw: Array.isArray(payload) ? payload : [],
  };
}

async function getSnapshots(options = {}) {
  const entries = resolveWatchlistEntries(options);
  const client = await createInfoClient(options);
  const mids = await getAllMids(options);
  const metaAndAssetCtxs = await getMetaAndAssetCtxs(options).catch(() => null);
  const checkedAt = new Date().toISOString();
  const startTime = Date.now() - (3 * 24 * 60 * 60_000);
  const snapshots = await Promise.all(entries.map(async (entry) => {
    const ticker = toText(entry?.ticker);
    const coin = await resolveCanonicalCoinSymbol(ticker, { ...options, metaAndAssetCtxs });
    const coinKey = normalizeCoinKey(coin);
    if (!coin) return [ticker, buildSnapshotFromMarketData(ticker, null, [], checkedAt)];
    const candles = await executeSharedRateLimitedRequest(
      `info:candleSnapshot:${coin}:1d`,
      () => client.candleSnapshot({
        coin,
        interval: '1d',
        startTime,
        endTime: Date.now(),
      }),
      options
    ).catch(() => []);
    return [ticker, buildSnapshotFromMarketData(ticker, mids?.[coin] || mids?.[coinKey] || null, candles, checkedAt)];
  }));
  return new Map(snapshots);
}

async function getHistoricalBars(options = {}) {
  const client = await createInfoClient(options);
  const entries = resolveWatchlistEntries(options);
  const metaAndAssetCtxs = await getMetaAndAssetCtxs(options).catch(() => null);
  const interval = resolveCandleInterval(options.timeframe || '1Day');
  const intervalMs = resolveIntervalMs(interval);
  const limit = Math.max(1, Number.parseInt(options.limit || '30', 10) || 30);
  const endTime = options.end ? new Date(options.end).getTime() : Date.now();
  const startTime = options.start
    ? new Date(options.start).getTime()
    : Math.max(0, endTime - (limit * intervalMs));
  const collections = await Promise.all(entries.map(async (entry) => {
    const ticker = toText(entry?.ticker);
    const coin = await resolveCanonicalCoinSymbol(ticker, { ...options, metaAndAssetCtxs });
    if (!coin) return [ticker, []];
    const candles = await executeSharedRateLimitedRequest(
      `info:candleSnapshot:${coin}:${interval}`,
      () => client.candleSnapshot({
        coin,
        interval,
        startTime,
        endTime,
      }),
      options
    ).catch(() => []);
    const bars = Array.isArray(candles)
      ? candles.slice(-limit).map((candle) => normalizeBar(ticker, candle))
      : [];
    return [ticker, bars];
  }));
  return new Map(collections);
}

async function getLatestBars(options = {}) {
  const barsBySymbol = await getHistoricalBars({
    ...options,
    limit: 1,
  });
  const latest = new Map();
  for (const [ticker, bars] of barsBySymbol.entries()) {
    latest.set(ticker, Array.isArray(bars) && bars.length > 0 ? bars[bars.length - 1] : null);
  }
  return latest;
}

function normalizeUniverseAsset(asset = {}, ctx = {}, mids = {}, index = null) {
  const coin = toText(asset?.name || asset?.coin || asset);
  if (!coin) return null;
  const ticker = `${coin}/USD`;
  const coinKey = normalizeCoinKey(coin);
  const markPx = toNumber(ctx?.markPx, 0);
  const latestMid = toNumber(mids?.[coin], toNumber(mids?.[coinKey], 0));
  const midPx = toNumber(ctx?.midPx, markPx || latestMid);
  const tradePrice = midPx || markPx || latestMid;
  return {
    coin,
    ticker,
    coinKey,
    tickerKey: `${coinKey}/USD`,
    assetIndex: Number.isFinite(Number(index)) && Number(index) >= 0 ? Number(index) : null,
    sizeDecimals: Number.isFinite(Number(asset?.szDecimals)) ? Number(asset?.szDecimals) : null,
    price: tradePrice || null,
    midPx: midPx || null,
    markPx: markPx || null,
    oraclePx: toNumber(ctx?.oraclePx, 0) || null,
    prevDayPx: toNumber(ctx?.prevDayPx, 0) || null,
    fundingRate: toNumber(ctx?.funding, 0),
    openInterest: toNumber(ctx?.openInterest, 0) || null,
    volumeUsd24h: toNumber(ctx?.dayNtlVlm, 0) || null,
    volumeBase24h: toNumber(ctx?.dayBaseVlm, 0) || null,
    premium: toNumber(ctx?.premium, 0) || null,
    impactBidPx: Array.isArray(ctx?.impactPxs) ? toNumber(ctx.impactPxs[0], 0) || null : null,
    impactAskPx: Array.isArray(ctx?.impactPxs) ? toNumber(ctx.impactPxs[1], 0) || null : null,
    raw: {
      asset,
      ctx,
      mid: mids?.[coin] ?? mids?.[coinKey] ?? null,
    },
  };
}

async function getUniverseMarketData(options = {}) {
  const [mids, metaAndAssetCtxs] = await Promise.all([
    getAllMids(options).catch(() => ({})),
    getMetaAndAssetCtxs(options),
  ]);
  const [meta, assetCtxs] = Array.isArray(metaAndAssetCtxs) ? metaAndAssetCtxs : [null, []];
  const universe = Array.isArray(meta?.universe) ? meta.universe : [];
  const contexts = Array.isArray(assetCtxs) ? assetCtxs : [];
  return universe
    .map((asset, index) => normalizeUniverseAsset(asset, contexts[index] || {}, mids || {}, index))
    .filter(Boolean);
}

async function getPredictedFundings(options = {}) {
  const asOf = new Date().toISOString();
  const client = await createInfoClient(options);
  const payload = options.predictedFundings
    || (client && typeof client.predictedFundings === 'function'
      ? await getPooledRequest(
        'info:predictedFundings',
        () => executeSharedRateLimitedRequest('info:predictedFundings', () => client.predictedFundings(), options),
        options
      ).catch(() => null)
      : null)
    || await getPooledRequest(
      'info:predictedFundings',
      () => postInfoRequest({ type: 'predictedFundings' }, options),
      options
    );
  return normalizePredictedFundingPayload(payload, asOf);
}

async function getL2Book(options = {}) {
  const metaAndAssetCtxs = await getMetaAndAssetCtxs(options).catch(() => null);
  const coin = await resolveCanonicalCoinSymbol(options.coin || options.ticker, { ...options, metaAndAssetCtxs });
  if (!coin) {
    throw new Error('Hyperliquid l2Book request requires coin or ticker.');
  }
  const asOf = new Date().toISOString();
  const client = await createInfoClient(options);
  const params = {
    coin,
    ...(options.nSigFigs != null ? { nSigFigs: Number(options.nSigFigs) } : {}),
    ...(options.mantissa != null ? { mantissa: Number(options.mantissa) } : {}),
  };
  const payload = options.l2Book
    || (client && typeof client.l2Book === 'function'
      ? await executeSharedRateLimitedRequest(
        `info:l2Book:${coin}`,
        () => client.l2Book(params),
        options
      ).catch(() => null)
      : null)
    || await postInfoRequest({ type: 'l2Book', ...params }, options);
  return normalizeL2BookPayload(coin, payload, asOf);
}

async function getVaultDetails(options = {}) {
  const vaultAddress = toText(options.vaultAddress);
  if (!vaultAddress) {
    throw new Error('Hyperliquid vaultDetails request requires vaultAddress.');
  }
  const asOf = new Date().toISOString();
  const client = await createInfoClient(options);
  const params = {
    vaultAddress,
    ...(toText(options.user) ? { user: toText(options.user) } : {}),
  };
  const payload = options.vaultDetails
    || (client && typeof client.vaultDetails === 'function'
      ? await executeSharedRateLimitedRequest(
        `info:vaultDetails:${vaultAddress.toLowerCase()}`,
        () => client.vaultDetails(params),
        options
      ).catch(() => null)
      : null)
    || await postInfoRequest({ type: 'vaultDetails', ...params }, options);
  return normalizeVaultDetailsPayload(vaultAddress, payload, asOf);
}

async function getUserVaultEquities(options = {}) {
  const user = toText(options.user, toText(options.walletAddress, resolveWalletAddress(options.env || process.env)));
  if (!user) {
    throw new Error('Hyperliquid userVaultEquities request requires user or walletAddress.');
  }
  const asOf = new Date().toISOString();
  const client = await createInfoClient(options);
  const params = { user };
  const payload = options.userVaultEquities
    || (client && typeof client.userVaultEquities === 'function'
      ? await executeSharedRateLimitedRequest(
        `info:userVaultEquities:${user.toLowerCase()}`,
        () => client.userVaultEquities(params),
        options
      ).catch(() => null)
      : null)
    || await postInfoRequest({ type: 'userVaultEquities', ...params }, options);
  return normalizeUserVaultEquitiesPayload(user, payload, asOf);
}

function resolveWalletAddress(env = process.env) {
  return toText(
    env.HYPERLIQUID_WALLET_ADDRESS
    || env.HYPERLIQUID_ADDRESS
    || env.POLYMARKET_FUNDER_ADDRESS
  );
}

async function getClearinghouseState(options = {}) {
  if (options.clearinghouseState) {
    return options.clearinghouseState;
  }
  const walletAddress = toText(options.walletAddress, resolveWalletAddress(options.env || process.env));
  if (!walletAddress) {
    throw new Error('Hyperliquid wallet address is missing. Set POLYMARKET_FUNDER_ADDRESS or HYPERLIQUID_WALLET_ADDRESS.');
  }
  const client = await createInfoClient(options);
  const dex = normalizeDexName(options.dex, '');
  return getPooledRequest(
    `info:clearinghouseState:${walletAddress.toLowerCase()}:${dex || 'main'}`,
    () => executeSharedRateLimitedRequest(
      `info:clearinghouseState:${walletAddress.toLowerCase()}:${dex || 'main'}`,
      () => client.clearinghouseState({
        user: walletAddress,
        ...(dex ? { dex } : {}),
      }),
      options
    ),
    options
  );
}

async function getOpenOrders(options = {}) {
  if (options.openOrders) {
    return Array.isArray(options.openOrders) ? options.openOrders : [];
  }
  const walletAddress = toText(options.walletAddress, resolveWalletAddress(options.env || process.env));
  if (!walletAddress) {
    throw new Error('Hyperliquid wallet address is missing. Set POLYMARKET_FUNDER_ADDRESS or HYPERLIQUID_WALLET_ADDRESS.');
  }
  const client = await createInfoClient(options);
  const dex = normalizeDexName(options.dex, '');
  return getPooledRequest(
    `info:openOrders:${walletAddress.toLowerCase()}:${dex || 'main'}`,
    () => executeSharedRateLimitedRequest(
      `info:openOrders:${walletAddress.toLowerCase()}:${dex || 'main'}`,
      () => client.openOrders({
        user: walletAddress,
        ...(dex ? { dex } : {}),
      }),
      options
    ),
    options
  );
}

async function getAllClearinghouseStates(options = {}) {
  const walletAddress = toText(options.walletAddress, resolveWalletAddress(options.env || process.env));
  if (!walletAddress) {
    throw new Error('Hyperliquid wallet address is missing. Set POLYMARKET_FUNDER_ADDRESS or HYPERLIQUID_WALLET_ADDRESS.');
  }
  const perpDexs = options.includePerpDexs === false && !options.dex && !Array.isArray(options.dexNames)
    ? []
    : await getPerpDexs(options).catch(() => []);
  const dexNames = resolveTrackedPerpDexNames(perpDexs, options);
  const states = await Promise.all([
    getClearinghouseState({ ...options, walletAddress, dex: null }),
    ...dexNames.map((dex) => getClearinghouseState({ ...options, walletAddress, dex })),
  ]);
  return [
    {
      dex: null,
      label: 'main',
      walletAddress: walletAddress.toLowerCase(),
      state: states[0] || null,
    },
    ...dexNames.map((dex, index) => ({
      dex,
      label: dex,
      walletAddress: walletAddress.toLowerCase(),
      state: states[index + 1] || null,
    })),
  ];
}

function normalizePosition(position = {}, metadata = {}) {
  const size = toNumber(position?.szi, 0);
  const coin = toText(position?.coin);
  const coinKey = normalizeCoinKey(coin);
  const dex = normalizeDexName(metadata?.dex, null);
  return {
    ticker: coin ? `${coin}/USD` : '',
    coin,
    coinKey,
    dex,
    venue: dex ? `hyperliquid:${dex}` : 'hyperliquid',
    broker: 'hyperliquid',
    assetClass: 'crypto',
    exchange: dex ? `HYPERLIQUID:${dex.toUpperCase()}` : 'HYPERLIQUID',
    shares: Math.abs(size),
    size,
    avgPrice: toNumber(position?.entryPx, 0),
    marketValue: 0,
    unrealizedPnl: toNumber(position?.unrealizedPnl, 0),
    side: size < 0 ? 'short' : 'long',
    raw: position,
  };
}

async function getAccountSnapshot(options = {}) {
  const states = await getAllClearinghouseStates(options);
  const accountValue = states.reduce((sum, entry) => sum + toNumber(entry?.state?.marginSummary?.accountValue, 0), 0);
  const withdrawable = states.reduce((sum, entry) => sum + toNumber(entry?.state?.withdrawable, 0), 0);
  const totalMarginUsed = states.reduce((sum, entry) => sum + toNumber(entry?.state?.marginSummary?.totalMarginUsed, 0), 0);
  return {
    id: 'hyperliquid',
    status: 'active',
    equity: accountValue,
    cash: withdrawable,
    buyingPower: withdrawable,
    daytradeCount: 0,
    patternDayTrader: false,
    raw: {
      marginSummary: {
        accountValue,
        totalMarginUsed,
      },
      withdrawable,
      dexAccounts: states.map((entry) => ({
        dex: entry.dex,
        label: entry.label,
        accountValue: toNumber(entry?.state?.marginSummary?.accountValue, 0),
        totalMarginUsed: toNumber(entry?.state?.marginSummary?.totalMarginUsed, 0),
        withdrawable: toNumber(entry?.state?.withdrawable, 0),
        positions: Array.isArray(entry?.state?.assetPositions) ? entry.state.assetPositions.length : 0,
      })),
      mainState: states[0]?.state || null,
      states,
    },
  };
}

async function getOpenPositions(options = {}) {
  const states = await getAllClearinghouseStates(options);
  return states
    .flatMap((entry) => {
      const positions = Array.isArray(entry?.state?.assetPositions) ? entry.state.assetPositions : [];
      return positions.map((positionEntry) => normalizePosition(positionEntry?.position || {}, { dex: entry.dex }));
    })
    .filter((position) => position.ticker && Math.abs(toNumber(position.size, 0)) > 0);
}

function resetRequestPoolState() {
  REQUEST_POOL_STATE.memory.clear();
  REQUEST_POOL_STATE.inflight.clear();
  RATE_LIMIT_STATE.memory = null;
  HYPERLIQUID_SDK_PROMISE = null;
  resetRateLimitBucket();
  for (const filePath of [DEFAULT_RATE_LIMIT_STATE_PATH, DEFAULT_REQUEST_POOL_PATH, DEFAULT_REQUEST_POOL_LOCK_PATH]) {
    try {
      if (filePath && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {}
  }
}

module.exports = {
  __resetRequestPoolState: resetRequestPoolState,
  __resetRateLimitBucket: resetRateLimitBucket,
  __readSharedRateLimitState: readSharedRateLimitState,
  __writeSharedRateLimitState: writeSharedRateLimitState,
  acquireRateLimitToken,
  createInfoClient,
  getAllMids,
  getMetaAndAssetCtxs,
  getUserFees,
  getPredictedFundings,
  getL2Book,
  getOpenOrders,
  getVaultDetails,
  getUserVaultEquities,
  getPerpDexs,
  getClearinghouseState,
  getAllClearinghouseStates,
  getUniverseMarketData,
  getSnapshots,
  getHistoricalBars,
  getLatestBars,
  getAccountSnapshot,
  getOpenPositions,
  isAllMidsPayloadHealthy,
  isMetaAndAssetCtxsPayloadHealthy,
  normalizePredictedFundingPayload,
  normalizeL2BookPayload,
  normalizeVaultDetailsPayload,
  normalizeUserVaultEquitiesPayload,
  normalizeCoinKey,
  normalizeCoinSymbol,
  isRateLimitError,
  postInfoRequest,
  resolveCanonicalCoinSymbol,
  resolveWalletAddress,
};
