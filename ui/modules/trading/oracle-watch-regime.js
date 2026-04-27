'use strict';

const fs = require('fs');
const path = require('path');

const { resolveCoordPath } = require('../../config');
const hyperliquidClient = require('./hyperliquid-client');
const marketScannerModule = require('./market-scanner');
const { MIN_EXECUTABLE_MARGIN_USD } = require('./oracle-watch-execution-gate');

const DEFAULT_SHARED_SHORT_REGIME_STATE_PATH = resolveCoordPath(path.join('runtime', 'oracle-short-regime-state.json'), { forWrite: true });
const DEFAULT_MARKET_SCANNER_STATE_PATH = resolveCoordPath(path.join('runtime', 'market-scanner-state.json'), { forWrite: true });
const DEFAULT_SPARK_FIREPLANS_PATH = resolveCoordPath(path.join('runtime', 'spark-fireplans.json'), { forWrite: true });
const DEFAULT_ORACLE_WATCH_RULES_PATH = resolveCoordPath(path.join('runtime', 'oracle-watch-rules.json'), { forWrite: true });
const DEFAULT_ORACLE_WATCH_STATE_PATH = resolveCoordPath(path.join('runtime', 'oracle-watch-state.json'), { forWrite: true });
const DEFAULT_ORACLE_WATCH_PRIORITY_OVERRIDES_PATH = resolveCoordPath(path.join('runtime', 'oracle-watch-priority-overrides.json'), { forWrite: true });
const DEFAULT_ORACLE_WATCH_PROMOTION_DECISIONS_PATH = resolveCoordPath(path.join('runtime', 'oracle-watch-promotion-decisions.jsonl'), { forWrite: true });
const DEFAULT_PROTECTED_TICKERS = ['BTC/USD', 'ETH/USD', 'SOL/USD'];
const AUTO_RULE_SOURCE = 'shared_regime_auto';
const PROMOTED_AUTO_RULE_SOURCE = 'promoted_mover_auto';
const DEFAULT_MIN_SHARED_SHORT_CANDIDATES = 4;
const DEFAULT_MAX_PROMOTED_SHORTS = 6;
const DEFAULT_MIN_VOLUME_USD_24H = 100000;
const DEFAULT_RULE_TTL_MS = 2 * 60 * 60 * 1000;
const DEFAULT_SHARED_SHORT_MISSION_FLOOR_MARGIN_USD = MIN_EXECUTABLE_MARGIN_USD;
const DEFAULT_PROMOTION_MIN_VOLUME_USD_24H = 250000;
const DEFAULT_PROMOTION_MAX_SPREAD_BPS = 40;
const DEFAULT_SCANNER_PROMOTION_TTL_MS = 4 * 60 * 60 * 1000;
const DEFAULT_SPARK_PROMOTION_POST_EVENT_TTL_MS = 2 * 60 * 60 * 1000;
const DEFAULT_PROMOTION_COOLDOWN_MS = 10 * 60 * 1000;
const ORDI_PATTERN_MIN_24H_PUMP_PCT = 0.15;
const ORDI_PATTERN_MIN_LOOKBACK_PUMP_PCT = 0.25;
const ORDI_PATTERN_MIN_DUMP_WICK_PCT = 0.08;
const ORDI_PATTERN_MIN_DUMP_BODY_PCT = 0.045;

const MANUAL_OVERRIDE_PRIORITY = 1;
const SPARK_FIREPLAN_PRIORITY = 2;
const MARKET_SCANNER_PRIORITY = 3;
const SHARED_SHORT_PRIORITY = 4;

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
}

function readJsonFile(filePath, fallback = null) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, payload) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
}

function appendJsonLine(filePath, payload) {
  ensureDir(filePath);
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
}

function toText(value, fallback = '') {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function toNumber(value, fallback = NaN) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeTicker(value) {
  const raw = toText(value).toUpperCase().replace('-', '/');
  if (!raw) return '';
  return raw.endsWith('/USD') ? raw : `${raw}/USD`;
}

function toIsoTimestamp(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return date.toISOString();
}

function normalizeMover(entry = {}) {
  if (marketScannerModule && typeof marketScannerModule.normalizeMarketScannerState === 'function') {
    const normalized = marketScannerModule.normalizeMarketScannerState({
      flaggedMovers: [entry],
    });
    return Array.isArray(normalized.flaggedMovers) && normalized.flaggedMovers[0]
      ? normalized.flaggedMovers[0]
      : entry;
  }
  return entry;
}

function round(value, digits = 4) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Number(numeric.toFixed(digits));
}

function countDecimals(value) {
  const text = String(value ?? '');
  if (!text.includes('.')) return 0;
  return text.split('.')[1].replace(/0+$/, '').length;
}

function roundToPrecision(value, digits = 4) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Number(numeric.toFixed(Math.max(0, digits)));
}

function normalizeBars(bars = []) {
  return (Array.isArray(bars) ? bars : [])
    .map((bar = {}) => ({
      open: toNumber(bar.open, NaN),
      high: toNumber(bar.high, NaN),
      low: toNumber(bar.low, NaN),
      close: toNumber(bar.close, NaN),
    }))
    .filter((bar) => (
      Number.isFinite(bar.open)
      && Number.isFinite(bar.high)
      && Number.isFinite(bar.low)
      && Number.isFinite(bar.close)
      && bar.high > 0
      && bar.low > 0
      && bar.close > 0
    ));
}

function average(values = []) {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return NaN;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function resolveDigitsFromPrice(price = NaN) {
  const numeric = Number(price);
  if (!Number.isFinite(numeric) || numeric <= 0) return 4;
  if (numeric < 0.01) return 6;
  if (numeric < 0.1) return 5;
  if (numeric < 10) return 4;
  if (numeric < 1000) return 2;
  return 1;
}

function isSharedRegimeAutoRule(rule = {}) {
  return toText(rule?.sourceTag || rule?.source, '') === AUTO_RULE_SOURCE
    || /^shared-regime-auto-short-/i.test(toText(rule?.id, ''));
}

function isPromotionAutoRule(rule = {}) {
  return toText(rule?.sourceTag || rule?.source, '') === PROMOTED_AUTO_RULE_SOURCE
    || /^promoted-watch-(short|long)-/i.test(toText(rule?.id, ''));
}

function isAutoRule(rule = {}) {
  return isSharedRegimeAutoRule(rule) || isPromotionAutoRule(rule);
}

function extractAutoTicker(rule = {}) {
  return normalizeTicker(rule?.ticker);
}

function scoreShortMover(entry = {}) {
  const change4hPct = Math.abs(toNumber(entry.change4hPct, 0));
  const change24hPct = Math.abs(toNumber(entry.change24hPct, 0));
  const volumeUsd24h = Math.max(1, toNumber(entry.volumeUsd24h, 1));
  const openInterestChange24hPct = toNumber(entry.openInterestChange24hPct, 0);
  const fundingRate = toNumber(entry.fundingRate, 0);
  const liquidityScore = Math.log10(volumeUsd24h) / 10;
  const magnitudeScore = (change4hPct * 8) + (change24hPct * 3);
  const oiScore = openInterestChange24hPct >= -0.15 ? 0.2 : 0;
  const fundingScore = fundingRate >= -0.00005 ? 0.15 : 0;
  return round(magnitudeScore + liquidityScore + oiScore + fundingScore, 4) || 0;
}

function isQualifiedSharedShortMover(entry = {}, options = {}) {
  const direction = toText(entry.direction).toUpperCase();
  const change4hPct = toNumber(entry.change4hPct, 0);
  const change24hPct = toNumber(entry.change24hPct, 0);
  const score = toNumber(entry.score, 0);
  const fundingRate = toNumber(entry.fundingRate, 0);
  const volumeUsd24h = toNumber(entry.volumeUsd24h, 0);
  const minVolumeUsd24h = Math.max(0, toNumber(options.minVolumeUsd24h, DEFAULT_MIN_VOLUME_USD_24H));

  return direction === 'DOWN'
    && volumeUsd24h >= minVolumeUsd24h
    && change4hPct <= -0.015
    && (change24hPct <= -0.06 || score >= 0.08)
    && fundingRate >= -0.00025;
}

function detectSharedShortRegime(input = {}, options = {}) {
  const movers = (Array.isArray(input?.movers) ? input.movers : [])
    .map((entry) => normalizeMover(entry))
    .filter((entry) => normalizeTicker(entry?.ticker));
  const protectedTickers = new Set(
    (Array.isArray(options.protectedTickers) ? options.protectedTickers : DEFAULT_PROTECTED_TICKERS)
      .map((ticker) => normalizeTicker(ticker))
      .filter(Boolean)
  );

  const qualified = movers
    .filter((entry) => isQualifiedSharedShortMover(entry, options))
    .map((entry) => ({
      ...entry,
      ticker: normalizeTicker(entry.ticker),
      regimeScore: scoreShortMover(entry),
      protected: protectedTickers.has(normalizeTicker(entry.ticker)),
    }))
    .sort((left, right) => Number(right.regimeScore || 0) - Number(left.regimeScore || 0));

  const minCandidates = Math.max(2, Math.floor(toNumber(options.minCandidates, DEFAULT_MIN_SHARED_SHORT_CANDIDATES)));
  const promotedCandidates = qualified.filter((entry) => !entry.protected);
  const active = qualified.length >= minCandidates && promotedCandidates.length > 0;

  return {
    active,
    qualifiedCount: qualified.length,
    promotedEligibleCount: promotedCandidates.length,
    detectedAt: new Date(options.now || Date.now()).toISOString(),
    candidates: qualified,
    promotedCandidates,
    reason: active
      ? `shared_short_regime_${qualified.length}_qualified`
      : `shared_short_regime_insufficient_${qualified.length}`,
  };
}

function shouldRetireAutoRuleState(ruleState = {}, nowMs = Date.now()) {
  if (!ruleState || typeof ruleState !== 'object') return false;
  if (ruleState?.conflictResolution?.status === 'superseded') return true;
  if (ruleState?.stale?.active === true) return true;
  if (ruleState?.lastEventType === 'invalidated') return true;
  const expiresAtMs = Date.parse(toText(ruleState?.expiresAt, ''));
  return Number.isFinite(expiresAtMs) && expiresAtMs <= nowMs;
}

function resolveSharedShortSizing(entry = {}) {
  const volumeUsd24h = toNumber(entry?.volumeUsd24h, 0);
  if (volumeUsd24h >= 5_000_000) {
    return {
      suggestedMarginUsd: 250,
      suggestedLeverage: 10,
    };
  }
  if (volumeUsd24h >= 1_000_000) {
    return {
      suggestedMarginUsd: MIN_EXECUTABLE_MARGIN_USD,
      suggestedLeverage: 8,
    };
  }
  return {
    suggestedMarginUsd: DEFAULT_SHARED_SHORT_MISSION_FLOOR_MARGIN_USD,
    suggestedLeverage: 7,
  };
}

function buildSharedShortRule(entry = {}, bars = [], nowMs = Date.now(), ttlMs = DEFAULT_RULE_TTL_MS) {
  const ticker = normalizeTicker(entry?.ticker);
  const price = toNumber(entry?.price, NaN);
  const normalizedBars = Array.isArray(bars) ? bars.filter(Boolean) : [];
  const latestBar = normalizedBars.length > 0 ? normalizedBars[normalizedBars.length - 1] : null;
  const latestClose = toNumber(latestBar?.close, price);
  const digits = Math.max(
    resolveDigitsFromPrice(latestClose),
    countDecimals(entry?.price),
  );
  const recentWindow = normalizedBars.slice(-8);
  const recentHigh = recentWindow.reduce((max, bar) => Math.max(max, toNumber(bar?.high, NaN)), Number.NEGATIVE_INFINITY);
  const structureHigh = Number.isFinite(recentHigh) ? recentHigh : latestClose * 1.01;
  const headroom = Math.max(
    structureHigh - latestClose,
    latestClose * 0.004
  );
  const retestMin = roundToPrecision(latestClose + (headroom * 0.35), digits);
  const retestMax = roundToPrecision(
    Math.max(retestMin + (latestClose * 0.0025), Math.min(structureHigh, latestClose + (headroom * 0.7))),
    digits
  );
  const loseLevel = retestMin;
  const coin = ticker.replace('/USD', '');
  const generatedAtIso = new Date(nowMs).toISOString();
  const expiresAtIso = new Date(nowMs + ttlMs).toISOString();
  const { suggestedMarginUsd, suggestedLeverage } = resolveSharedShortSizing(entry);
  return {
    id: `shared-regime-auto-short-${coin.toLowerCase()}`,
    name: `${coin} shared short regime — lose ${loseLevel} then fail retest ${retestMin}-${retestMax}`,
    enabled: true,
    ticker,
    trigger: 'lose_fail_retest',
    loseLevel,
    retestMin,
    retestMax,
    timeframe: '5m',
    cooldownMs: 10 * 60 * 1000,
    suggestedMarginUsd,
    suggestedLeverage,
    sourceTag: AUTO_RULE_SOURCE,
    generatedAt: generatedAtIso,
    expiresAt: expiresAtIso,
    metadata: {
      regime: 'shared_short_continuation',
      generatedFromPrice: latestClose,
      generatedStructureHigh: roundToPrecision(structureHigh, digits),
      change4hPct: entry?.change4hPct ?? null,
      change24hPct: entry?.change24hPct ?? null,
      regimeScore: entry?.regimeScore ?? null,
      volumeUsd24h: entry?.volumeUsd24h ?? null,
    },
  };
}

function normalizePriorityOverride(entry = {}) {
  const ticker = normalizeTicker(entry?.ticker);
  const preferredDirection = toText(entry?.preferredDirection).toUpperCase();
  if (!ticker || !['BUY', 'SELL'].includes(preferredDirection)) {
    return null;
  }
  return {
    ticker,
    preferredDirection,
    reason: toText(entry?.reason),
    expiresAt: toIsoTimestamp(entry?.expiresAt, null),
  };
}

function readPriorityOverrides(filePath = DEFAULT_ORACLE_WATCH_PRIORITY_OVERRIDES_PATH) {
  const payload = readJsonFile(filePath, { entries: [] }) || { entries: [] };
  return {
    path: filePath,
    entries: (Array.isArray(payload?.entries) ? payload.entries : [])
      .map((entry) => normalizePriorityOverride(entry))
      .filter(Boolean),
  };
}

function buildMarketScannerUrgentMap(marketScannerState = {}) {
  const lastResult = marketScannerState?.lastResult && typeof marketScannerState.lastResult === 'object'
    ? marketScannerState.lastResult
    : marketScannerState;
  const flaggedMovers = Array.isArray(lastResult?.flaggedMovers) && lastResult.flaggedMovers.length > 0
    ? lastResult.flaggedMovers
    : (Array.isArray(marketScannerState?.flaggedMovers) ? marketScannerState.flaggedMovers : []);
  const urgentMovers = Array.isArray(lastResult?.urgentMovers) ? lastResult.urgentMovers : [];
  const urgentPromotedSymbols = Array.isArray(lastResult?.urgentPromotedSymbols) ? lastResult.urgentPromotedSymbols : [];
  const moversByTicker = new Map();
  for (const entry of [...flaggedMovers, ...urgentMovers]) {
    const normalized = normalizeMover(entry);
    const ticker = normalizeTicker(normalized?.ticker);
    if (!ticker) continue;
    moversByTicker.set(ticker, normalized);
  }
  const scannedAt = toIsoTimestamp(lastResult?.scannedAt || marketScannerState?.updatedAt || marketScannerState?.lastScanAt, null);
  const urgentMap = new Map();
  for (const tickerValue of urgentPromotedSymbols) {
    const ticker = normalizeTicker(tickerValue);
    if (!ticker) continue;
    const mover = moversByTicker.get(ticker);
    if (mover) {
      urgentMap.set(ticker, mover);
    }
  }
  return {
    urgentMap,
    scannedAt,
  };
}

function buildSparkFirePlanMap(payload = {}) {
  const firePlans = Array.isArray(payload?.firePlans)
    ? payload.firePlans
    : (Array.isArray(payload) ? payload : []);
  const generatedAt = toIsoTimestamp(payload?.generatedAt, null);
  const map = new Map();
  for (const entry of firePlans) {
    const ticker = normalizeTicker(entry?.ticker);
    if (!ticker) continue;
    if (entry?.ready !== true) continue;
    if (entry?.tradeableOnHyperliquid !== true) continue;
    map.set(ticker, {
      ...entry,
      ticker,
      generatedAt,
      direction: toText(entry?.direction).toUpperCase(),
    });
  }
  return {
    firePlans: map,
    generatedAt,
  };
}

function determinePromotionExpiry(source = {}, nowMs = Date.now()) {
  if (source?.type === 'manual_override') {
    return toIsoTimestamp(source?.override?.expiresAt, null);
  }
  if (source?.type === 'spark_fireplan') {
    const anchorMs = Date.parse(
      toText(
        source?.plan?.publishedAt,
        toText(source?.plan?.detectedAt, toText(source?.generatedAt, ''))
      )
    );
    const baseMs = Number.isFinite(anchorMs) ? anchorMs : nowMs;
    return new Date(baseMs + DEFAULT_SPARK_PROMOTION_POST_EVENT_TTL_MS).toISOString();
  }
  if (source?.type === 'market_scanner_urgent') {
    const anchorMs = Date.parse(toText(source?.scannedAt, ''));
    const baseMs = Number.isFinite(anchorMs) ? anchorMs : nowMs;
    return new Date(baseMs + DEFAULT_SCANNER_PROMOTION_TTL_MS).toISOString();
  }
  return null;
}

function resolvePromotionPrice(candidate = {}, bars5m = [], bars1h = []) {
  const sparkPrice = toNumber(candidate?.sparkPlan?.currentPrice, NaN);
  if (Number.isFinite(sparkPrice) && sparkPrice > 0) return sparkPrice;
  const scannerPrice = toNumber(candidate?.scannerMover?.price, NaN);
  if (Number.isFinite(scannerPrice) && scannerPrice > 0) return scannerPrice;
  const latest5m = Array.isArray(bars5m) && bars5m.length > 0 ? toNumber(bars5m[bars5m.length - 1]?.close, NaN) : NaN;
  if (Number.isFinite(latest5m) && latest5m > 0) return latest5m;
  const latest1h = Array.isArray(bars1h) && bars1h.length > 0 ? toNumber(bars1h[bars1h.length - 1]?.close, NaN) : NaN;
  return Number.isFinite(latest1h) && latest1h > 0 ? latest1h : NaN;
}

function resolvePromotionVolumeUsd(candidate = {}) {
  const scannerVolume = toNumber(candidate?.scannerMover?.volumeUsd24h, NaN);
  if (Number.isFinite(scannerVolume) && scannerVolume > 0) return scannerVolume;
  return NaN;
}

function resolvePromotionSpreadBps(candidate = {}) {
  const explicit = toNumber(candidate?.sparkPlan?.spreadBps, NaN);
  if (Number.isFinite(explicit)) return explicit;
  return toNumber(candidate?.scannerMover?.impactSpreadBps, NaN);
}

function hasObviousUrgentShortContext(scannerMover = {}) {
  const direction = toText(scannerMover?.direction).toUpperCase();
  const change4hPct = toNumber(scannerMover?.change4hPct, 0);
  const change24hPct = toNumber(scannerMover?.change24hPct, 0);
  const volumeUsd24h = toNumber(scannerMover?.volumeUsd24h, 0);
  const openInterestChange24hPct = toNumber(scannerMover?.openInterestChange24hPct, NaN);
  return direction === 'DOWN'
    && (change4hPct <= -0.08 || change24hPct <= -0.12)
    && volumeUsd24h >= DEFAULT_PROMOTION_MIN_VOLUME_USD_24H
    && (!Number.isFinite(openInterestChange24hPct) || openInterestChange24hPct >= -0.05);
}

function evaluateHistoricalDumpHistory(bars1h = []) {
  const bars = normalizeBars(bars1h);
  if (bars.length < 6) {
    return {
      ok: false,
      reason: 'dump_history_insufficient_bars',
    };
  }
  let strongest = null;
  for (const bar of bars) {
    const wickDropPct = bar.high > 0 ? (bar.high - bar.low) / bar.high : 0;
    const bodyDropPct = bar.open > 0 ? (bar.open - bar.close) / bar.open : 0;
    const qualifies = wickDropPct >= ORDI_PATTERN_MIN_DUMP_WICK_PCT || bodyDropPct >= ORDI_PATTERN_MIN_DUMP_BODY_PCT;
    if (!strongest || wickDropPct > strongest.wickDropPct || bodyDropPct > strongest.bodyDropPct) {
      strongest = {
        wickDropPct,
        bodyDropPct,
      };
    }
    if (qualifies) {
      return {
        ok: true,
        reason: 'dump_history_confirmed',
        wickDropPct: round(wickDropPct, 4),
        bodyDropPct: round(bodyDropPct, 4),
      };
    }
  }
  return {
    ok: false,
    reason: 'dump_history_missing',
    wickDropPct: round(strongest?.wickDropPct, 4),
    bodyDropPct: round(strongest?.bodyDropPct, 4),
  };
}

function evaluateMultiDayPump(candidate = {}, bars1h = [], currentPrice = NaN) {
  const bars = normalizeBars(bars1h);
  const change24hPct = toNumber(candidate?.scannerMover?.change24hPct, NaN);
  if (change24hPct >= ORDI_PATTERN_MIN_24H_PUMP_PCT) {
    return {
      ok: true,
      reason: 'scanner_24h_pump_confirmed',
      change24hPct: round(change24hPct, 4),
    };
  }
  if (bars.length < 24) {
    return {
      ok: false,
      reason: 'multi_day_pump_insufficient_bars',
      change24hPct: Number.isFinite(change24hPct) ? round(change24hPct, 4) : null,
    };
  }
  const firstClose = bars[0].close;
  const lookbackHigh = Math.max(...bars.map((bar) => bar.high));
  const latestClose = Number.isFinite(currentPrice) ? currentPrice : bars[bars.length - 1].close;
  const lookbackPumpPct = firstClose > 0 ? (lookbackHigh - firstClose) / firstClose : 0;
  const retainedPumpPct = firstClose > 0 ? (latestClose - firstClose) / firstClose : 0;
  const ok = lookbackPumpPct >= ORDI_PATTERN_MIN_LOOKBACK_PUMP_PCT || retainedPumpPct >= ORDI_PATTERN_MIN_24H_PUMP_PCT;
  return {
    ok,
    reason: ok ? 'multi_day_pump_confirmed' : 'multi_day_pump_missing',
    change24hPct: Number.isFinite(change24hPct) ? round(change24hPct, 4) : null,
    lookbackPumpPct: round(lookbackPumpPct, 4),
    retainedPumpPct: round(retainedPumpPct, 4),
  };
}

function evaluateShortStructureAgreement(bars = [], currentPrice = NaN, label = 'structure') {
  const normalized = normalizeBars(bars);
  if (normalized.length < 3) {
    return {
      ok: false,
      reason: `${label}_insufficient_bars`,
    };
  }
  const closes = normalized.map((bar) => bar.close);
  const latestClose = Number.isFinite(currentPrice) ? currentPrice : closes[closes.length - 1];
  const previousClose = closes[closes.length - 2];
  const sma = average(closes.slice(-Math.min(6, closes.length)));
  const recentHigh = Math.max(...normalized.slice(-Math.min(8, normalized.length)).map((bar) => bar.high));
  const losingMomentum = latestClose <= previousClose * 1.002;
  const belowMean = Number.isFinite(sma) && latestClose <= sma;
  const belowRecentHigh = recentHigh > 0 && latestClose <= recentHigh * 0.985;
  const ok = losingMomentum && belowMean && belowRecentHigh;
  return {
    ok,
    reason: ok ? `${label}_agrees_short` : `${label}_does_not_agree`,
    latestClose: round(latestClose, 8),
    previousClose: round(previousClose, 8),
    sma: round(sma, 8),
    recentHigh: round(recentHigh, 8),
  };
}

function evaluateOrdiPatternPromotionGate(candidate = {}, bars5m = [], bars15m = [], bars1h = [], currentPrice = NaN) {
  const desiredDirection = toText(candidate?.desiredDirection).toUpperCase();
  if (desiredDirection !== 'SELL') {
    return {
      ok: false,
      reason: 'ordi_pattern_short_only',
    };
  }

  const pump = evaluateMultiDayPump(candidate, bars1h, currentPrice);
  if (!pump.ok) {
    return {
      ok: false,
      reason: pump.reason,
      pump,
    };
  }

  const dumpHistory = evaluateHistoricalDumpHistory(bars1h);
  if (!dumpHistory.ok) {
    return {
      ok: false,
      reason: dumpHistory.reason,
      pump,
      dumpHistory,
    };
  }

  const structure5m = evaluateShortStructureAgreement(bars5m, currentPrice, 'structure_5m');
  if (!structure5m.ok) {
    return {
      ok: false,
      reason: structure5m.reason,
      pump,
      dumpHistory,
      structure5m,
    };
  }

  const structure15m = evaluateShortStructureAgreement(bars15m, currentPrice, 'structure_15m');
  if (!structure15m.ok) {
    return {
      ok: false,
      reason: structure15m.reason,
      pump,
      dumpHistory,
      structure5m,
      structure15m,
    };
  }

  return {
    ok: true,
    reason: 'ordi_pattern_gate_passed',
    pump,
    dumpHistory,
    structure5m,
    structure15m,
  };
}

function evaluateLongStructure(candidate = {}, bars5m = [], currentPrice = NaN) {
  if (hasObviousUrgentShortContext(candidate?.scannerMover)) {
    return {
      ok: false,
      reason: 'waterfall_dump_state',
    };
  }
  const closes = (Array.isArray(bars5m) ? bars5m : [])
    .map((bar) => toNumber(bar?.close, NaN))
    .filter((value) => Number.isFinite(value));
  if (closes.length === 0) {
    return {
      ok: false,
      reason: 'insufficient_structure',
    };
  }
  const highs = (Array.isArray(bars5m) ? bars5m : [])
    .map((bar) => toNumber(bar?.high, NaN))
    .filter((value) => Number.isFinite(value));
  const lows = (Array.isArray(bars5m) ? bars5m : [])
    .map((bar) => toNumber(bar?.low, NaN))
    .filter((value) => Number.isFinite(value));
  const latestClose = Number.isFinite(currentPrice) ? currentPrice : closes[closes.length - 1];
  const priorClose = closes.length >= 2 ? closes[closes.length - 2] : latestClose;
  const recentHigh = highs.length > 0 ? Math.max(...highs) : latestClose;
  const recentLow = lows.length > 0 ? Math.min(...lows) : latestClose;
  const midpoint = recentLow + ((recentHigh - recentLow) * 0.55);
  if (latestClose < (priorClose * 0.995)) {
    return {
      ok: false,
      reason: 'structure_not_constructive',
    };
  }
  if (latestClose < midpoint) {
    return {
      ok: false,
      reason: 'structure_not_constructive',
    };
  }
  return {
    ok: true,
    recentHigh,
    recentLow,
  };
}

function resolvePromotionSizing(candidate = {}, fallback = {}) {
  const planMarginUsd = toNumber(candidate?.sparkPlan?.maxMarginUsd, NaN);
  const planLeverage = Math.floor(toNumber(candidate?.sparkPlan?.maxLeverage, NaN));
  if (Number.isFinite(planMarginUsd) && planMarginUsd > 0) {
    return {
      suggestedMarginUsd: round(planMarginUsd, 2),
      suggestedLeverage: Math.max(1, Number.isFinite(planLeverage) && planLeverage > 0 ? planLeverage : toNumber(fallback?.suggestedLeverage, 5)),
    };
  }
  const volumeUsd24h = resolvePromotionVolumeUsd(candidate);
  if (Number.isFinite(volumeUsd24h) && volumeUsd24h > 0) {
    return resolveSharedShortSizing({ volumeUsd24h });
  }
  return {
    suggestedMarginUsd: round(toNumber(fallback?.suggestedMarginUsd, DEFAULT_SHARED_SHORT_MISSION_FLOOR_MARGIN_USD), 2),
    suggestedLeverage: Math.max(1, Math.floor(toNumber(fallback?.suggestedLeverage, 5))),
  };
}

function buildPromotedShortRule(candidate = {}, bars5m = [], nowMs = Date.now(), expiresAtIso = null) {
  const ticker = normalizeTicker(candidate?.ticker);
  const price = resolvePromotionPrice(candidate, bars5m, []);
  const volumeUsd24h = resolvePromotionVolumeUsd(candidate);
  const baseRule = buildSharedShortRule({
    ticker,
    price,
    volumeUsd24h,
    change4hPct: candidate?.scannerMover?.change4hPct ?? null,
    change24hPct: candidate?.scannerMover?.change24hPct ?? null,
    score: candidate?.scannerMover?.score ?? null,
  }, bars5m, nowMs, DEFAULT_RULE_TTL_MS);
  const sizing = resolvePromotionSizing(candidate, baseRule);
  const coin = ticker.replace('/USD', '');
  const expiresAt = toIsoTimestamp(expiresAtIso, baseRule.expiresAt);
  return {
    ...baseRule,
    id: `promoted-watch-short-${coin.toLowerCase()}`,
    name: `${coin} promoted short — lose ${baseRule.loseLevel} then fail retest ${baseRule.retestMin}-${baseRule.retestMax}`,
    currentPrice: round(price, 8),
    suggestedMarginUsd: sizing.suggestedMarginUsd,
    suggestedLeverage: sizing.suggestedLeverage,
    sourceTag: PROMOTED_AUTO_RULE_SOURCE,
    generatedAt: new Date(nowMs).toISOString(),
    expiresAt,
    metadata: {
      ...(baseRule.metadata || {}),
      promotionSource: toText(candidate?.selectedSource, null),
      sourcePriority: Number(candidate?.selectedPriority || MARKET_SCANNER_PRIORITY),
      scannerDirection: toText(candidate?.scannerMover?.direction, null),
      change4hPct: candidate?.scannerMover?.change4hPct ?? null,
      change24hPct: candidate?.scannerMover?.change24hPct ?? null,
      openInterestChange24hPct: candidate?.scannerMover?.openInterestChange24hPct ?? null,
      fundingRate: candidate?.scannerMover?.fundingRate ?? candidate?.sparkPlan?.fundingRate ?? null,
      overrideDirection: toText(candidate?.manualOverride?.preferredDirection, null),
      overrideReason: toText(candidate?.manualOverride?.reason, null),
      sparkDirection: toText(candidate?.sparkPlan?.direction, null),
      catalystType: toText(candidate?.sparkPlan?.catalystType, null),
    },
  };
}

function buildPromotedLongRule(candidate = {}, bars5m = [], nowMs = Date.now(), expiresAtIso = null) {
  const ticker = normalizeTicker(candidate?.ticker);
  const price = resolvePromotionPrice(candidate, bars5m, []);
  const coin = ticker.replace('/USD', '');
  const digits = Math.max(
    resolveDigitsFromPrice(price),
    countDecimals(candidate?.sparkPlan?.entryZone?.upper),
    countDecimals(candidate?.sparkPlan?.entryZone?.lower)
  );
  const recentHigh = (Array.isArray(bars5m) ? bars5m : [])
    .map((bar) => toNumber(bar?.high, NaN))
    .filter((value) => Number.isFinite(value))
    .reduce((max, value) => Math.max(max, value), Number.NEGATIVE_INFINITY);
  const sparkUpper = toNumber(candidate?.sparkPlan?.entryZone?.upper, NaN);
  const reclaimLevel = roundToPrecision(
    Math.max(
      Number.isFinite(sparkUpper) ? sparkUpper : Number.NEGATIVE_INFINITY,
      Number.isFinite(recentHigh) ? recentHigh * 0.998 : Number.NEGATIVE_INFINITY,
      Number.isFinite(price) ? price : Number.NEGATIVE_INFINITY
    ),
    digits
  );
  const sizing = resolvePromotionSizing(candidate, {
    suggestedMarginUsd: DEFAULT_SHARED_SHORT_MISSION_FLOOR_MARGIN_USD,
    suggestedLeverage: 5,
  });
  return {
    id: `promoted-watch-long-${coin.toLowerCase()}`,
    name: `${coin} promoted long — reclaim ${reclaimLevel} hold 2x 5m`,
    enabled: true,
    ticker,
    currentPrice: round(price, 8),
    trigger: 'reclaim_hold',
    level: reclaimLevel,
    confirmCloses: 2,
    timeframe: '5m',
    cooldownMs: DEFAULT_PROMOTION_COOLDOWN_MS,
    suggestedMarginUsd: sizing.suggestedMarginUsd,
    suggestedLeverage: sizing.suggestedLeverage,
    sourceTag: PROMOTED_AUTO_RULE_SOURCE,
    generatedAt: new Date(nowMs).toISOString(),
    expiresAt: toIsoTimestamp(expiresAtIso, new Date(nowMs + DEFAULT_RULE_TTL_MS).toISOString()),
    metadata: {
      promotionSource: toText(candidate?.selectedSource, null),
      sourcePriority: Number(candidate?.selectedPriority || SPARK_FIREPLAN_PRIORITY),
      scannerDirection: toText(candidate?.scannerMover?.direction, null),
      change4hPct: candidate?.scannerMover?.change4hPct ?? null,
      change24hPct: candidate?.scannerMover?.change24hPct ?? null,
      openInterestChange24hPct: candidate?.scannerMover?.openInterestChange24hPct ?? null,
      fundingRate: candidate?.scannerMover?.fundingRate ?? candidate?.sparkPlan?.fundingRate ?? null,
      overrideDirection: toText(candidate?.manualOverride?.preferredDirection, null),
      overrideReason: toText(candidate?.manualOverride?.reason, null),
      sparkDirection: toText(candidate?.sparkPlan?.direction, null),
      catalystType: toText(candidate?.sparkPlan?.catalystType, null),
    },
  };
}

function evaluatePromotionCandidate(candidate = {}, bars5m = [], bars15m = [], bars1h = [], nowMs = Date.now()) {
  const desiredDirection = toText(candidate?.desiredDirection).toUpperCase();
  const expiresAt = determinePromotionExpiry(candidate?.source, nowMs);
  const expiresAtMs = Date.parse(toText(expiresAt, ''));
  if (Number.isFinite(expiresAtMs) && expiresAtMs <= nowMs) {
    return {
      accepted: false,
      reason: 'source_expired',
      expiresAt,
    };
  }
  if (candidate?.source?.type === 'spark_fireplan' && candidate?.sparkPlan?.tradeableOnHyperliquid !== true) {
    return {
      accepted: false,
      reason: 'non_tradeable_on_hyperliquid',
      expiresAt,
    };
  }
  const price = resolvePromotionPrice(candidate, bars5m, bars1h);
  if (!(Number.isFinite(price) && price > 0)) {
    return {
      accepted: false,
      reason: 'price_unavailable',
      expiresAt,
    };
  }
  const setupGate = evaluateOrdiPatternPromotionGate(candidate, bars5m, bars15m, bars1h, price);
  if (!setupGate.ok) {
    return {
      accepted: false,
      reason: setupGate.reason,
      setupGate,
      expiresAt,
    };
  }
  const spreadBps = resolvePromotionSpreadBps(candidate);
  if (Number.isFinite(spreadBps) && spreadBps > DEFAULT_PROMOTION_MAX_SPREAD_BPS) {
    return {
      accepted: false,
      reason: 'spread_too_wide_for_rule',
      expiresAt,
    };
  }
  const volumeUsd24h = resolvePromotionVolumeUsd(candidate);
  if (
    desiredDirection === 'SELL'
    && Number.isFinite(volumeUsd24h)
    && volumeUsd24h > 0
    && volumeUsd24h < DEFAULT_PROMOTION_MIN_VOLUME_USD_24H
    && candidate?.source?.type === 'market_scanner_urgent'
  ) {
    return {
      accepted: false,
      reason: 'insufficient_liquidity',
      expiresAt,
    };
  }
  if (desiredDirection === 'BUY') {
    const longStructure = evaluateLongStructure(candidate, bars5m, price);
    if (!longStructure.ok) {
      return {
        accepted: false,
        reason: longStructure.reason,
        expiresAt,
      };
    }
    return {
      accepted: true,
      rule: buildPromotedLongRule(candidate, bars5m, nowMs, expiresAt),
      expiresAt,
    };
  }
  if (desiredDirection === 'SELL') {
    return {
      accepted: true,
      rule: buildPromotedShortRule(candidate, bars5m, nowMs, expiresAt),
      expiresAt,
    };
  }
  return {
    accepted: false,
    reason: 'unsupported_direction',
    expiresAt,
  };
}

async function buildPromotedWatchOutcome(options = {}) {
  const nowMs = Number(new Date(options.now || Date.now()).getTime()) || Date.now();
  const marketScannerState = options.marketScannerState || readJsonFile(options.marketScannerStatePath || DEFAULT_MARKET_SCANNER_STATE_PATH, {}) || {};
  const sparkFireplansPayload = options.sparkFireplans
    || readJsonFile(options.sparkFirePlansPath || DEFAULT_SPARK_FIREPLANS_PATH, { firePlans: [] })
    || { firePlans: [] };
  const priorityOverrides = options.priorityOverrides
    || readPriorityOverrides(options.priorityOverridesPath || DEFAULT_ORACLE_WATCH_PRIORITY_OVERRIDES_PATH);
  const { urgentMap, scannedAt } = buildMarketScannerUrgentMap(marketScannerState);
  const { firePlans, generatedAt } = buildSparkFirePlanMap(sparkFireplansPayload);
  const candidatesByTicker = new Map();
  const decisions = [];

  function ensureCandidateRecord(ticker) {
    const normalizedTicker = normalizeTicker(ticker);
    if (!normalizedTicker) return null;
    const existing = candidatesByTicker.get(normalizedTicker) || {
      ticker: normalizedTicker,
      sources: [],
      scannerMover: urgentMap.get(normalizedTicker) || null,
      sparkPlan: firePlans.get(normalizedTicker) || null,
      manualOverride: null,
    };
    candidatesByTicker.set(normalizedTicker, existing);
    return existing;
  }

  for (const [ticker, mover] of urgentMap.entries()) {
    const record = ensureCandidateRecord(ticker);
    if (!record) continue;
    record.scannerMover = mover;
    const scannerDirection = toText(mover?.direction).toUpperCase();
    const fadingPumpShort = toNumber(mover?.change4hPct, 0) < 0
      && toNumber(mover?.change24hPct, 0) >= ORDI_PATTERN_MIN_24H_PUMP_PCT;
    record.sources.push({
      type: 'market_scanner_urgent',
      priority: MARKET_SCANNER_PRIORITY,
      scannedAt,
      direction: scannerDirection === 'DOWN' || fadingPumpShort ? 'SELL' : 'BUY',
    });
  }

  for (const [ticker, plan] of firePlans.entries()) {
    const record = ensureCandidateRecord(ticker);
    if (!record) continue;
    record.sparkPlan = plan;
    record.sources.push({
      type: 'spark_fireplan',
      priority: SPARK_FIREPLAN_PRIORITY,
      generatedAt,
      direction: toText(plan?.direction).toUpperCase(),
      plan,
    });
  }

  for (const entry of priorityOverrides.entries) {
    const record = ensureCandidateRecord(entry.ticker);
    if (!record) continue;
    record.manualOverride = entry;
    record.sources.push({
      type: 'manual_override',
      priority: MANUAL_OVERRIDE_PRIORITY,
      direction: entry.preferredDirection,
      override: entry,
    });
  }

  const candidateTickers = Array.from(candidatesByTicker.keys());
  const [bars5m, bars15m, bars1h] = await Promise.all([
    candidateTickers.length > 0
      ? hyperliquidClient.getHistoricalBars({
        symbols: candidateTickers,
        timeframe: '5m',
        limit: 24,
      }).catch(() => new Map())
      : Promise.resolve(new Map()),
    candidateTickers.length > 0
      ? hyperliquidClient.getHistoricalBars({
        symbols: candidateTickers,
        timeframe: '15m',
        limit: 24,
      }).catch(() => new Map())
      : Promise.resolve(new Map()),
    candidateTickers.length > 0
      ? hyperliquidClient.getHistoricalBars({
        symbols: candidateTickers,
        timeframe: '1Hour',
        limit: 96,
      }).catch(() => new Map())
      : Promise.resolve(new Map()),
  ]);

  const promotedRules = [];
  const promotedTickers = [];
  const rejectedTickers = [];
  for (const ticker of candidateTickers) {
    const record = candidatesByTicker.get(ticker);
    if (!record) continue;
    const sortedSources = record.sources.slice().sort((left, right) => Number(left.priority || 0) - Number(right.priority || 0));
    let selected = null;
    for (const source of sortedSources) {
      const candidate = {
        ticker,
        source,
        selectedSource: source.type,
        selectedPriority: source.priority,
        desiredDirection: source.direction,
        scannerMover: record.scannerMover,
        sparkPlan: record.sparkPlan,
        manualOverride: record.manualOverride,
      };
      const evaluation = evaluatePromotionCandidate(
        candidate,
        bars5m instanceof Map ? (bars5m.get(ticker) || []) : [],
        bars15m instanceof Map ? (bars15m.get(ticker) || []) : [],
        bars1h instanceof Map ? (bars1h.get(ticker) || []) : [],
        nowMs
      );
      decisions.push({
        recordedAt: new Date(nowMs).toISOString(),
        ticker,
        promotionSource: source.type,
        desiredDirection: source.direction,
        accepted: evaluation.accepted === true,
        reason: evaluation.accepted ? 'accepted' : evaluation.reason,
        priority: source.priority,
      });
      if (evaluation.accepted) {
        selected = evaluation.rule;
        break;
      }
    }
    if (selected) {
      promotedRules.push(selected);
      promotedTickers.push(ticker);
    } else {
      rejectedTickers.push(ticker);
    }
  }

  return {
    promotedRules,
    promotedTickers,
    rejectedTickers,
    decisions,
  };
}

function seedRuleState(rule = {}, previousState = {}, marketPrice = NaN, nowMs = Date.now()) {
  const seeded = {
    ...(previousState || {}),
    expiresAt: rule?.expiresAt || null,
  };
  const price = toNumber(marketPrice, NaN);
  const loseLevel = toNumber(rule?.loseLevel, NaN);
  const reclaimLevel = toNumber(rule?.level, NaN);
  if (Number.isFinite(price) && Number.isFinite(loseLevel) && price < loseLevel) {
    if (seeded.status !== 'armed' && seeded.status !== 'fired') {
      seeded.status = 'armed';
      seeded.armedAt = nowMs;
      seeded.lastEventType = 'armed_seeded';
      seeded.lastEventAt = new Date(nowMs).toISOString();
      seeded.eventCounts = {
        ...(seeded.eventCounts || {}),
        armed: Number(seeded?.eventCounts?.armed || 0) + 1,
      };
    }
  }
  if (Number.isFinite(price) && Number.isFinite(reclaimLevel) && price >= reclaimLevel) {
    if (seeded.status !== 'armed' && seeded.status !== 'fired') {
      seeded.status = 'armed';
      seeded.armedAt = nowMs;
      seeded.lastEventType = 'armed_seeded';
      seeded.lastEventAt = new Date(nowMs).toISOString();
      seeded.eventCounts = {
        ...(seeded.eventCounts || {}),
        armed: Number(seeded?.eventCounts?.armed || 0) + 1,
      };
    }
  }
  return seeded;
}

function clearExecutionAttemptState(ruleState = {}) {
  if (!ruleState || typeof ruleState !== 'object') return {};
  const nextState = { ...ruleState };
  delete nextState.execution;
  delete nextState.actedOnAt;
  delete nextState.actedOnCount;
  delete nextState.actedOnNote;
  return nextState;
}

function shouldClearExecutionForRule(rule = {}, ruleState = {}) {
  const currentExecution = ruleState?.execution;
  if (!currentExecution || typeof currentExecution !== 'object') return false;
  const targetMarginUsd = toNumber(rule?.suggestedMarginUsd, NaN);
  if (!Number.isFinite(targetMarginUsd) || targetMarginUsd <= 0) return false;
  const previousRequestedMarginUsd = toNumber(currentExecution?.requestedMarginUsd, NaN);
  const previousMarginUsd = toNumber(currentExecution?.marginUsd, NaN);
  return (
    (Number.isFinite(previousRequestedMarginUsd) && previousRequestedMarginUsd !== targetMarginUsd)
    || (Number.isFinite(previousMarginUsd) && previousMarginUsd < targetMarginUsd)
  );
}

async function applySharedShortRegime(options = {}) {
  const nowMs = Number(new Date(options.now || Date.now()).getTime()) || Date.now();
  const statePath = options.statePath || DEFAULT_SHARED_SHORT_REGIME_STATE_PATH;
  const rulesPath = options.rulesPath || DEFAULT_ORACLE_WATCH_RULES_PATH;
  const watchStatePath = options.watchStatePath || DEFAULT_ORACLE_WATCH_STATE_PATH;
  const marketScannerStatePath = options.marketScannerStatePath || DEFAULT_MARKET_SCANNER_STATE_PATH;
  const sparkFirePlansPath = options.sparkFirePlansPath || DEFAULT_SPARK_FIREPLANS_PATH;
  const priorityOverridesPath = options.priorityOverridesPath || DEFAULT_ORACLE_WATCH_PRIORITY_OVERRIDES_PATH;
  const promotionDecisionsPath = options.promotionDecisionsPath || DEFAULT_ORACLE_WATCH_PROMOTION_DECISIONS_PATH;
  const marketScannerState = options.marketScannerState
    || readJsonFile(marketScannerStatePath, {})
    || {};
  const moversSource = Array.isArray(options.movers) && options.movers.length > 0
    ? options.movers
    : (Array.isArray(marketScannerState.flaggedMovers) && marketScannerState.flaggedMovers.length > 0
      ? marketScannerState.flaggedMovers
      : (Array.isArray(marketScannerState.topMovers) ? marketScannerState.topMovers : []));
  const regime = detectSharedShortRegime({ movers: moversSource }, {
    now: nowMs,
    protectedTickers: options.protectedTickers,
    minCandidates: options.minCandidates,
    minVolumeUsd24h: options.minVolumeUsd24h,
  });

  const config = readJsonFile(rulesPath, { rules: [], symbols: [], hotSymbols: [] }) || { rules: [], symbols: [], hotSymbols: [] };
  const watchState = readJsonFile(watchStatePath, { rules: {} }) || { rules: {} };
  const existingRules = Array.isArray(config.rules) ? config.rules : [];
  const manualRules = existingRules.filter((rule) => !isAutoRule(rule));
  const existingSharedRules = existingRules.filter((rule) => isSharedRegimeAutoRule(rule));
  const existingPromotionRules = existingRules.filter((rule) => isPromotionAutoRule(rule));
  const existingSharedRuleByTicker = new Map(existingSharedRules.map((rule) => [extractAutoTicker(rule), rule]));

  const promotionOutcome = await buildPromotedWatchOutcome({
    now: nowMs,
    marketScannerState,
    marketScannerStatePath,
    sparkFirePlansPath,
    sparkFireplans: options.sparkFireplans,
    priorityOverridesPath,
    priorityOverrides: options.priorityOverrides,
  });

  const promotionRules = [];
  const promotionRuleIds = [];
  const promotionRetainedRuleIds = [];
  const nextPromotionRuleStates = {};

  for (const rule of promotionOutcome.promotedRules) {
    const existingRule = existingPromotionRules.find((entry) => entry.id === rule.id);
    const existingState = existingRule ? (watchState.rules?.[existingRule.id] || {}) : (watchState.rules?.[rule.id] || {});
    promotionRules.push(rule);
    promotionRuleIds.push(rule.id);
    if (existingRule && !shouldRetireAutoRuleState(existingState, nowMs)) {
      promotionRetainedRuleIds.push(rule.id);
    }
    const nextBaseState = shouldRetireAutoRuleState(existingState, nowMs)
      ? {}
      : (shouldClearExecutionForRule(rule, existingState) ? clearExecutionAttemptState(existingState) : existingState);
    nextPromotionRuleStates[rule.id] = seedRuleState(rule, nextBaseState, toNumber(rule?.currentPrice, NaN), nowMs);
  }

  const sharedRules = [];
  const promotedRuleIds = [];
  const retainedRuleIds = [];
  const nextSharedRuleStates = {};
  const candidateEntries = [];
  const sharedRuleTickers = [];
  const rejectedSharedTickers = [];

  if (regime.active) {
    const maxPromoted = Math.max(1, Math.floor(toNumber(options.maxPromoted, DEFAULT_MAX_PROMOTED_SHORTS)));
    for (const entry of regime.promotedCandidates) {
      candidateEntries.push(entry);
      if (candidateEntries.length >= maxPromoted) break;
    }
    if (candidateEntries.length === 0) {
      candidateEntries.push(...regime.promotedCandidates.slice(0, maxPromoted));
    }

    const candidateTickers = candidateEntries.map((entry) => entry.ticker);
    const [bars5mByTicker, bars15mByTicker, bars1hByTicker] = await Promise.all([
      hyperliquidClient.getHistoricalBars({
        symbols: candidateTickers,
        timeframe: '5m',
        limit: 12,
      }).catch(() => new Map()),
      hyperliquidClient.getHistoricalBars({
        symbols: candidateTickers,
        timeframe: '15m',
        limit: 24,
      }).catch(() => new Map()),
      hyperliquidClient.getHistoricalBars({
        symbols: candidateTickers,
        timeframe: '1Hour',
        limit: 96,
      }).catch(() => new Map()),
    ]);

    for (const entry of candidateEntries.slice(0, maxPromoted)) {
      const ticker = normalizeTicker(entry.ticker);
      const bars5m = bars5mByTicker instanceof Map ? (bars5mByTicker.get(ticker) || []) : [];
      const setupGate = evaluateOrdiPatternPromotionGate(
        {
          ticker,
          desiredDirection: 'SELL',
          currentPrice: entry.price,
          scannerMover: entry,
        },
        bars5m,
        bars15mByTicker instanceof Map ? (bars15mByTicker.get(ticker) || []) : [],
        bars1hByTicker instanceof Map ? (bars1hByTicker.get(ticker) || []) : [],
        toNumber(entry.price, NaN)
      );
      if (!setupGate.ok) {
        rejectedSharedTickers.push(ticker);
        appendJsonLine(promotionDecisionsPath, {
          recordedAt: new Date(nowMs).toISOString(),
          ticker,
          promotionSource: 'shared_short_regime',
          desiredDirection: 'SELL',
          accepted: false,
          reason: setupGate.reason,
          priority: SHARED_SHORT_PRIORITY,
          setupGate,
        });
        continue;
      }
      const existingRule = existingSharedRuleByTicker.get(ticker);
      const existingState = existingRule ? (watchState.rules?.[existingRule.id] || {}) : {};
      const refreshedRule = buildSharedShortRule(
        entry,
        bars5m,
        nowMs,
        toNumber(options.ruleTtlMs, DEFAULT_RULE_TTL_MS)
      );
      const shouldKeepExisting = existingRule
        && !shouldRetireAutoRuleState(existingState, nowMs)
        && Number.isFinite(Number(existingRule?.suggestedMarginUsd))
        && Number.isFinite(Number(existingRule?.suggestedLeverage))
        && Number(existingRule.suggestedMarginUsd) === Number(refreshedRule.suggestedMarginUsd)
        && Number(existingRule.suggestedLeverage) === Number(refreshedRule.suggestedLeverage)
        && Number(existingRule?.metadata?.generatedStructureHigh) === Number(refreshedRule?.metadata?.generatedStructureHigh)
        && toText(existingRule?.expiresAt, '') !== ''
        && Date.parse(existingRule.expiresAt) > nowMs;
      const rule = shouldKeepExisting
        ? existingRule
        : refreshedRule;
      sharedRules.push(rule);
      promotedRuleIds.push(rule.id);
      sharedRuleTickers.push(ticker);
      if (shouldKeepExisting) {
        retainedRuleIds.push(rule.id);
      }
      const nextBaseState = shouldKeepExisting
        ? (shouldClearExecutionForRule(rule, existingState) ? clearExecutionAttemptState(existingState) : existingState)
        : clearExecutionAttemptState(existingState);
      nextSharedRuleStates[rule.id] = seedRuleState(rule, nextBaseState, entry.price, nowMs);
    }
  }

  const retiredSharedRuleIds = existingSharedRules
    .map((rule) => rule.id)
    .filter((ruleId) => !promotedRuleIds.includes(ruleId));
  const retiredPromotionRuleIds = existingPromotionRules
    .map((rule) => rule.id)
    .filter((ruleId) => !promotionRuleIds.includes(ruleId));
  const retiredRuleIds = [...retiredSharedRuleIds, ...retiredPromotionRuleIds];

  for (const ruleId of retiredPromotionRuleIds) {
    const retiredRule = existingPromotionRules.find((rule) => rule.id === ruleId);
    appendJsonLine(promotionDecisionsPath, {
      recordedAt: new Date(nowMs).toISOString(),
      ticker: normalizeTicker(retiredRule?.ticker),
      promotionSource: 'retired_auto_rule',
      desiredDirection: retiredRule?.trigger === 'lose_fail_retest' ? 'SELL' : 'BUY',
      accepted: false,
      reason: 'source_disappeared',
      priority: SHARED_SHORT_PRIORITY,
    });
  }
  for (const decision of promotionOutcome.decisions) {
    appendJsonLine(promotionDecisionsPath, decision);
  }

  const finalRules = [...manualRules, ...promotionRules, ...sharedRules];
  const finalRuleIds = new Set(finalRules.map((rule) => rule.id));
  const preservedRuleStates = Object.fromEntries(
    Object.entries(watchState.rules || {}).filter(([ruleId]) => !retiredRuleIds.includes(ruleId) && !finalRuleIds.has(ruleId))
  );
  const nextWatchState = {
    ...watchState,
    rules: {
      ...preservedRuleStates,
      ...nextPromotionRuleStates,
      ...nextSharedRuleStates,
    },
    updatedAt: new Date(nowMs).toISOString(),
  };

  const nextConfig = {
    ...config,
    symbols: Array.from(new Set([
      ...(Array.isArray(config.symbols) ? config.symbols : []),
      ...promotionOutcome.promotedTickers,
      ...sharedRuleTickers,
    ])),
    hotSymbols: Array.from(new Set([
      ...promotionOutcome.promotedTickers,
      ...sharedRuleTickers,
    ])).slice(0, 2),
    rules: finalRules,
  };

  writeJsonFile(rulesPath, nextConfig);
  writeJsonFile(watchStatePath, nextWatchState);

  const nextRegimeState = {
    updatedAt: new Date(nowMs).toISOString(),
    active: regime.active,
    reason: regime.reason,
    qualifiedCount: regime.qualifiedCount,
    promotedRuleIds,
    retainedRuleIds,
    retiredRuleIds: retiredSharedRuleIds,
    candidates: regime.candidates.slice(0, 10),
    promotedTickers: sharedRuleTickers,
    rejectedTickers: rejectedSharedTickers,
    protectedTickers: Array.from(new Set((options.protectedTickers || DEFAULT_PROTECTED_TICKERS).map((ticker) => normalizeTicker(ticker)).filter(Boolean))),
    promotionBridge: {
      promotedRuleIds: promotionRuleIds,
      promotedTickers: promotionOutcome.promotedTickers,
      retainedRuleIds: promotionRetainedRuleIds,
      retiredRuleIds: retiredPromotionRuleIds,
      rejectedTickers: promotionOutcome.rejectedTickers,
      decisionsPath: promotionDecisionsPath,
    },
  };
  writeJsonFile(statePath, nextRegimeState);

  return {
    ok: true,
    active: regime.active,
    statePath,
    rulesPath,
    watchStatePath,
    candidateCount: regime.qualifiedCount,
    promotedRuleIds,
    retainedRuleIds,
    retiredRuleIds,
    promotedTickers: nextRegimeState.promotedTickers,
    promotionPromotedRuleIds: promotionRuleIds,
    promotionPromotedTickers: promotionOutcome.promotedTickers,
    promotionRejectedTickers: promotionOutcome.rejectedTickers,
    promotionRetiredRuleIds: retiredPromotionRuleIds,
  };
}

module.exports = {
  AUTO_RULE_SOURCE,
  DEFAULT_MARKET_SCANNER_STATE_PATH,
  DEFAULT_ORACLE_WATCH_PRIORITY_OVERRIDES_PATH,
  DEFAULT_ORACLE_WATCH_PROMOTION_DECISIONS_PATH,
  DEFAULT_ORACLE_WATCH_RULES_PATH,
  DEFAULT_ORACLE_WATCH_STATE_PATH,
  DEFAULT_PROTECTED_TICKERS,
  DEFAULT_SPARK_FIREPLANS_PATH,
  DEFAULT_SHARED_SHORT_REGIME_STATE_PATH,
  PROMOTED_AUTO_RULE_SOURCE,
  applySharedShortRegime,
  buildSharedShortRule,
  detectSharedShortRegime,
  evaluateOrdiPatternPromotionGate,
  isAutoRule,
  scoreShortMover,
  seedRuleState,
  shouldRetireAutoRuleState,
};
