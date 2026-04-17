'use strict';

const fs = require('fs');
const path = require('path');

const { resolveCoordPath } = require('../../config');
const hyperliquidClient = require('./hyperliquid-client');

const DEFAULT_CANDIDATE_LOG_PATH = resolveCoordPath(path.join('runtime', 'trading-candidate-events.jsonl'), { forWrite: true });
const DEFAULT_SETTLEMENT_LOG_PATH = resolveCoordPath(path.join('runtime', 'trading-candidate-settlements.jsonl'), { forWrite: true });
const DEFAULT_FORWARD_HOURS = Object.freeze([4, 24]);

function toText(value, fallback = '') {
  const normalized = String(value ?? '').trim();
  return normalized || fallback;
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function round(value, digits = 6) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Number(numeric.toFixed(digits));
}

function toIsoTimestamp(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return date.toISOString();
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  return filePath;
}

function readJsonLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return String(fs.readFileSync(filePath, 'utf8') || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function appendJsonLines(filePath, records = []) {
  if (!Array.isArray(records) || records.length === 0) {
    return { ok: true, count: 0, path: filePath };
  }
  ensureDir(filePath);
  fs.appendFileSync(filePath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
  return { ok: true, count: records.length, path: filePath };
}

function resolveCandidateLogPath(options = {}) {
  return options.candidateEventLogPath
    || options.candidateLogPath
    || DEFAULT_CANDIDATE_LOG_PATH;
}

function resolveSettlementLogPath(options = {}) {
  return options.validationSettlementLogPath
    || options.settlementLogPath
    || DEFAULT_SETTLEMENT_LOG_PATH;
}

function appendValidationRecords(records = [], options = {}) {
  return appendJsonLines(resolveCandidateLogPath(options), records);
}

function normalizeCandidateRecord(record = {}) {
  const observedAt = toIsoTimestamp(record.observedAt, toIsoTimestamp(record.recordedAt, null));
  const ticker = toText(record.ticker).toUpperCase();
  const validationId = toText(
    record.validationId,
    [ticker, observedAt || 'unknown', toText(record.decision, 'UNKNOWN'), toText(record.recordedAt, 'unknown')].join('::')
  );
  return {
    ...record,
    validationId,
    ticker,
    observedAt,
    recordedAt: toIsoTimestamp(record.recordedAt, new Date().toISOString()),
    assetClass: toText(record.assetClass, ticker.endsWith('/USD') ? 'crypto' : 'unknown').toLowerCase(),
  };
}

function readCandidateRecords(options = {}) {
  return readJsonLines(resolveCandidateLogPath(options)).map((record) => normalizeCandidateRecord(record));
}

function readSettlementRecords(options = {}) {
  return readJsonLines(resolveSettlementLogPath(options));
}

function buildSettlementKey(validationId, horizonHours) {
  return `${toText(validationId)}::${Number(horizonHours) || 0}`;
}

async function withRateLimitRetry(task, options = {}) {
  const maxAttempts = Math.max(1, Math.floor(toNumber(options.maxAttempts, 6)));
  let attempt = 0;
  let delayMs = Math.max(500, Math.floor(toNumber(options.initialDelayMs, 1000)));
  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      return await task();
    } catch (error) {
      const message = String(error?.message || '');
      const isRateLimit = message.includes('429') || message.toLowerCase().includes('rate limit');
      if (!isRateLimit || attempt >= maxAttempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(delayMs * 2, 15_000);
    }
  }
  throw new Error('Signal validation retry state exhausted unexpectedly.');
}

function normalizeBar(ticker, candle = {}) {
  return {
    ticker,
    timestamp: toIsoTimestamp(Number(candle.t), null),
    close: toNumber(candle.c, NaN),
  };
}

async function fetchHourlyBarsForTicker(ticker, startTime, endTime, options = {}) {
  const coin = hyperliquidClient.normalizeCoinSymbol(ticker);
  if (!coin) return [];
  const client = await hyperliquidClient.createInfoClient(options);
  const candles = await withRateLimitRetry(() => client.candleSnapshot({
    coin,
    interval: '1h',
    startTime,
    endTime,
  }), options);
  return (Array.isArray(candles) ? candles : [])
    .map((candle) => normalizeBar(ticker, candle))
    .filter((bar) => bar.timestamp && Number.isFinite(bar.close) && bar.close > 0)
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
}

function findExitBar(bars = [], dueAtMs) {
  let best = null;
  for (const bar of bars) {
    const barMs = Date.parse(bar.timestamp);
    if (!Number.isFinite(barMs) || barMs < dueAtMs) continue;
    if (!best || barMs < Date.parse(best.timestamp)) {
      best = bar;
    }
  }
  if (best) return best;
  for (let index = bars.length - 1; index >= 0; index -= 1) {
    const bar = bars[index];
    const barMs = Date.parse(bar.timestamp);
    if (Number.isFinite(barMs) && barMs <= dueAtMs) {
      return bar;
    }
  }
  return null;
}

function computeForwardSettlement(record = {}, horizonHours, exitBar) {
  const observedAt = toIsoTimestamp(record.observedAt, null);
  const dueAt = observedAt ? new Date(Date.parse(observedAt) + (Number(horizonHours) * 60 * 60 * 1000)).toISOString() : null;
  const entryPrice = toNumber(record.referencePrice, NaN);
  const exitPrice = toNumber(exitBar?.close, NaN);
  const rawReturnPct = Number.isFinite(entryPrice) && entryPrice > 0 && Number.isFinite(exitPrice)
    ? (exitPrice - entryPrice) / entryPrice
    : null;
  const direction = toText(record.decision, 'HOLD').toUpperCase();
  const signedReturnPct = rawReturnPct == null
    ? null
    : direction === 'SELL' || direction === 'SHORT'
      ? -rawReturnPct
      : direction === 'BUY'
        ? rawReturnPct
        : null;
  const actualDirection = rawReturnPct == null
    ? null
    : rawReturnPct > 0
      ? 'BUY'
      : rawReturnPct < 0
        ? 'SELL'
        : 'HOLD';
  return {
    validationId: record.validationId,
    ticker: record.ticker,
    assetClass: record.assetClass,
    observedAt,
    dueAt,
    horizonHours,
    settledAt: new Date().toISOString(),
    status: record.status || null,
    skipReason: record.skipReason || null,
    decision: direction,
    entryPrice: Number.isFinite(entryPrice) ? round(entryPrice, 6) : null,
    exitPrice: Number.isFinite(exitPrice) ? round(exitPrice, 6) : null,
    exitTimestamp: exitBar?.timestamp || null,
    rawReturnPct: rawReturnPct == null ? null : round(rawReturnPct, 6),
    signedReturnPct: signedReturnPct == null ? null : round(signedReturnPct, 6),
    actualDirection,
    consensus: Boolean(record.consensus),
    confidence: Number.isFinite(Number(record.confidence)) ? round(record.confidence, 4) : null,
    averageAgreeConfidence: Number.isFinite(Number(record.averageAgreeConfidence)) ? round(record.averageAgreeConfidence, 4) : null,
    signalsByAgent: record.signalsByAgent || null,
    macroRisk: record.macroRisk || null,
    eventVeto: record.eventVeto || null,
    mechanical: record.mechanical || null,
    execution: record.execution || null,
  };
}

async function settleValidationRecords(options = {}) {
  const nowMs = options.now ? Date.parse(options.now) : Date.now();
  const candidateRecords = readCandidateRecords(options);
  const settledKeys = new Set(
    readSettlementRecords(options).map((record) => buildSettlementKey(record.validationId, record.horizonHours))
  );
  const horizons = Array.isArray(options.forwardHours) && options.forwardHours.length > 0
    ? options.forwardHours.map((value) => Math.max(1, Math.floor(toNumber(value, 0)))).filter(Boolean)
    : DEFAULT_FORWARD_HOURS;
  const dueByTicker = new Map();

  for (const record of candidateRecords) {
    if (record.assetClass !== 'crypto' || !record.ticker.endsWith('/USD')) continue;
    const observedAtMs = Date.parse(record.observedAt || '');
    if (!Number.isFinite(observedAtMs) || !Number.isFinite(toNumber(record.referencePrice, NaN))) continue;
    for (const horizonHours of horizons) {
      const key = buildSettlementKey(record.validationId, horizonHours);
      if (settledKeys.has(key)) continue;
      const dueAtMs = observedAtMs + (horizonHours * 60 * 60 * 1000);
      if (dueAtMs > nowMs) continue;
      const bucket = dueByTicker.get(record.ticker) || [];
      bucket.push({ record, horizonHours, dueAtMs });
      dueByTicker.set(record.ticker, bucket);
    }
  }

  if (dueByTicker.size === 0) {
    return {
      ok: true,
      candidateCount: candidateRecords.length,
      settledCount: 0,
      path: resolveSettlementLogPath(options),
      pendingCount: 0,
    };
  }

  const settlements = [];
  for (const [ticker, pending] of dueByTicker.entries()) {
    const minObservedAtMs = Math.min(...pending.map((entry) => Date.parse(entry.record.observedAt || '')));
    const bars = await fetchHourlyBarsForTicker(
      ticker,
      Math.max(0, minObservedAtMs - (60 * 60 * 1000)),
      nowMs + (60 * 60 * 1000),
      options
    ).catch(() => []);
    for (const entry of pending) {
      const exitBar = findExitBar(bars, entry.dueAtMs);
      if (!exitBar) continue;
      settlements.push(computeForwardSettlement(entry.record, entry.horizonHours, exitBar));
    }
  }

  const appendResult = appendJsonLines(resolveSettlementLogPath(options), settlements);
  return {
    ok: true,
    candidateCount: candidateRecords.length,
    settledCount: settlements.length,
    path: appendResult.path,
    pendingCount: Array.from(dueByTicker.values()).reduce((sum, records) => sum + records.length, 0) - settlements.length,
  };
}

module.exports = {
  DEFAULT_CANDIDATE_LOG_PATH,
  DEFAULT_FORWARD_HOURS,
  DEFAULT_SETTLEMENT_LOG_PATH,
  appendJsonLines,
  appendValidationRecords,
  buildSettlementKey,
  computeForwardSettlement,
  normalizeCandidateRecord,
  readCandidateRecords,
  readJsonLines,
  readSettlementRecords,
  resolveCandidateLogPath,
  resolveSettlementLogPath,
  settleValidationRecords,
};
