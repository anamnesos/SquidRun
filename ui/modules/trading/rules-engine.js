'use strict';

const DEFAULT_MIN_RULE_SCORE = 0.65;
const DEFAULT_MIN_MARGIN_USD = 200;
const DEFAULT_MAX_MARGIN_USED_RATIO = 0.8;
const DEFAULT_RECENT_SYMBOL_ACTIVITY_MS = 30 * 60 * 1000;
const DEFAULT_MAX_IMPACT_BPS = 50;

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

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, toNumber(value, min)));
}

function normalizeTicker(symbol) {
  const normalized = toText(symbol).toUpperCase();
  if (!normalized) return '';
  return normalized.endsWith('/USD') ? normalized : `${normalized}/USD`;
}

function normalizeCoin(symbol) {
  const ticker = normalizeTicker(symbol);
  return ticker.endsWith('/USD') ? ticker.slice(0, -4) : ticker;
}

function getCandles(microdata = {}) {
  return (microdata.candles4h?.candles || microdata.candles || [])
    .map((candle) => ({
      ...candle,
      timestamp: toText(candle.timestamp || candle.time || candle.t, null),
      open: toNumber(candle.open ?? candle.o, NaN),
      high: toNumber(candle.high ?? candle.h, NaN),
      low: toNumber(candle.low ?? candle.l, NaN),
      close: toNumber(candle.close ?? candle.c, NaN),
    }))
    .filter((candle) => Number.isFinite(candle.open)
      && Number.isFinite(candle.high)
      && Number.isFinite(candle.low)
      && Number.isFinite(candle.close))
    .sort((left, right) => Date.parse(left.timestamp || 0) - Date.parse(right.timestamp || 0));
}

function latestCandle(candles = []) {
  return candles[candles.length - 1] || null;
}

function getCurrentPrice(microdata = {}, candles = getCandles(microdata)) {
  return toNumber(
    microdata.bookSnapshot?.mid
    ?? microdata.extensionRead?.currentPrice
    ?? latestCandle(candles)?.close,
    NaN
  );
}

function getLookbackCandles(candles = [], hours = 24) {
  const latest = latestCandle(candles);
  if (!latest?.timestamp) return candles.slice(-Math.max(1, Math.ceil(hours / 4)));
  const latestMs = Date.parse(latest.timestamp);
  if (!Number.isFinite(latestMs)) return candles.slice(-Math.max(1, Math.ceil(hours / 4)));
  const cutoff = latestMs - (hours * 60 * 60 * 1000);
  return candles.filter((candle) => {
    const timestampMs = Date.parse(candle.timestamp || '');
    return Number.isFinite(timestampMs) && timestampMs >= cutoff;
  });
}

function pctChange(current, baseline) {
  const currentNumber = toNumber(current, NaN);
  const baselineNumber = toNumber(baseline, NaN);
  if (!Number.isFinite(currentNumber) || !Number.isFinite(baselineNumber) || baselineNumber <= 0) return null;
  return (currentNumber - baselineNumber) / baselineNumber;
}

function getTwentyFourHourExtension(microdata = {}, candles = getCandles(microdata)) {
  const latest = latestCandle(candles);
  const lookback = getLookbackCandles(candles, 24);
  const first = lookback[0] || candles[Math.max(0, candles.length - 7)] || null;
  const candleExtension = pctChange(latest?.close, first?.close);
  const extensionRead = toNumber(
    microdata.extensionRead?.pctAboveMa20
    ?? microdata.extensionRead?.pctAboveMean,
    NaN
  );
  return Math.max(
    Number.isFinite(candleExtension) ? candleExtension : -Infinity,
    Number.isFinite(extensionRead) ? extensionRead : -Infinity
  );
}

function getFundingBps(microdata = {}) {
  return toNumber(
    microdata.fundingHistory?.latest?.fundingRateBps
    ?? microdata.fundingHistory?.fundingRateBps
    ?? (microdata.fundingHistory?.latest?.fundingRate != null
      ? Number(microdata.fundingHistory.latest.fundingRate) * 10_000
      : NaN),
    NaN
  );
}

function getImpactBps(microdata = {}) {
  const book = microdata.bookSnapshot || {};
  if (book.buyImpact?.fillable === false || book.sellImpact?.fillable === false) {
    return Infinity;
  }
  return Math.max(
    0,
    toNumber(book.spreadBps, 0),
    toNumber(book.buyImpact?.impactBps, 0),
    toNumber(book.sellImpact?.impactBps, 0)
  );
}

function getAccountContext(microdata = {}) {
  const account = microdata.account || microdata.context?.account || {};
  const accountValue = toNumber(account.accountValue ?? account.equity ?? account.value, NaN);
  const totalMarginUsed = toNumber(account.totalMarginUsed ?? account.marginUsed ?? account.marketValue, 0);
  const withdrawable = toNumber(account.withdrawable ?? account.cash ?? account.liquidCapital, NaN);
  const marginUsedRatio = Number.isFinite(accountValue) && accountValue > 0
    ? totalMarginUsed / accountValue
    : toNumber(account.marginUsedRatio, 0);
  return {
    accountValue,
    totalMarginUsed,
    withdrawable,
    marginUsedRatio,
  };
}

function getPositions(microdata = {}) {
  return Array.isArray(microdata.positions)
    ? microdata.positions
    : Array.isArray(microdata.context?.positions)
      ? microdata.context.positions
      : [];
}

function hasActivePosition(symbol, microdata = {}) {
  const ticker = normalizeTicker(symbol);
  const coin = normalizeCoin(symbol);
  return getPositions(microdata).some((position) => {
    const positionTicker = normalizeTicker(position.ticker || position.symbol || position.coin);
    const positionCoin = normalizeCoin(position.coin || positionTicker);
    return (positionTicker === ticker || positionCoin === coin) && Math.abs(toNumber(position.size ?? position.szi ?? position.shares, 0)) > 0;
  });
}

function hasActiveEventVeto(symbol, microdata = {}) {
  const veto = microdata.eventVeto || microdata.context?.eventVeto || null;
  if (!veto) return false;
  const decision = toText(veto.decision).toUpperCase();
  if (!decision || decision === 'CLEAR' || decision === 'NONE') return false;
  const affected = Array.isArray(veto.affectedAssets) ? veto.affectedAssets.map(normalizeTicker) : [];
  return affected.length === 0 || affected.includes(normalizeTicker(symbol));
}

function hasRecentSymbolActivity(symbol, microdata = {}, options = {}) {
  const nowMs = toNumber(options.nowMs ?? microdata.nowMs, Date.now());
  const windowMs = Math.max(1, toNumber(options.recentSymbolActivityMs, DEFAULT_RECENT_SYMBOL_ACTIVITY_MS));
  const ticker = normalizeTicker(symbol);
  const coin = normalizeCoin(symbol);
  const entries = Array.isArray(microdata.recentSymbolActivity)
    ? microdata.recentSymbolActivity
    : Array.isArray(microdata.context?.recentSymbolActivity)
      ? microdata.context.recentSymbolActivity
      : [];
  return entries.some((entry) => {
    const entryTicker = normalizeTicker(entry.ticker || entry.symbol || entry.coin);
    const entryCoin = normalizeCoin(entry.coin || entryTicker);
    const timestampMs = Date.parse(entry.ts || entry.timestamp || entry.createdAt || entry.detectedAt || '');
    return (entryTicker === ticker || entryCoin === coin)
      && Number.isFinite(timestampMs)
      && nowMs - timestampMs <= windowMs;
  });
}

function getHardDisqualifier(symbol, microdata = {}, options = {}) {
  const account = getAccountContext(microdata);
  if (account.marginUsedRatio > toNumber(options.maxMarginUsedRatio, DEFAULT_MAX_MARGIN_USED_RATIO)) {
    return `account margin already used ${round(account.marginUsedRatio * 100, 2)}% > 80%`;
  }
  const rateLimit = microdata.rateLimit || microdata.context?.rateLimit || {};
  const backoffUntilMs = Date.parse(rateLimit.backoffUntil || '');
  if (rateLimit.active === true || (Number.isFinite(backoffUntilMs) && backoffUntilMs > toNumber(options.nowMs, Date.now()))) {
    return 'Hyperliquid rate-limit backoff active';
  }
  const supervisor = microdata.supervisor || microdata.context?.supervisor || {};
  if (supervisor.running === false || supervisor.ok === false) {
    return 'supervisor-daemon not running';
  }
  if (hasRecentSymbolActivity(symbol, microdata, options)) {
    return `${normalizeTicker(symbol)} had manual/open-close activity inside hands-off window`;
  }
  return null;
}

function buildSizeUsd(score, microdata = {}, options = {}) {
  if (score < toNumber(options.minRuleScore, DEFAULT_MIN_RULE_SCORE)) return 0;
  const account = getAccountContext(microdata);
  const minMargin = toNumber(options.minMarginUsd, DEFAULT_MIN_MARGIN_USD);
  if (Number.isFinite(account.withdrawable) && account.withdrawable > 0) {
    return round(Math.min(Math.max(minMargin, account.withdrawable * 0.35), account.withdrawable), 2);
  }
  return minMargin;
}

function computeStopCushion(candles = [], side = 'short') {
  const recent = getLookbackCandles(candles, 24);
  const price = latestCandle(candles)?.close || 0;
  const ranges = recent
    .map((candle) => Math.max(0, candle.high - candle.low))
    .filter((value) => Number.isFinite(value) && value > 0);
  const averageRange = ranges.length ? ranges.reduce((sum, value) => sum + value, 0) / ranges.length : 0;
  const wickDepth = Math.max(averageRange * 0.25, price * 0.006);
  return side === 'short' ? wickDepth : wickDepth;
}

function detectPostDipRecovery(candles = []) {
  if (candles.length < 7) return false;
  const recent = candles.slice(-7);
  const firstHalf = recent.slice(0, 4);
  const secondHalf = recent.slice(3);
  const priorLow = Math.min(...firstHalf.map((candle) => candle.low));
  const laterLow = Math.min(...secondHalf.map((candle) => candle.low));
  const priorHigh = Math.max(...firstHalf.map((candle) => candle.high));
  const latest = latestCandle(recent);
  const previous = recent[recent.length - 2];
  return laterLow < priorLow
    && latest.close > priorHigh
    && latest.close > latest.open
    && previous
    && latest.close > previous.high;
}

function hasFreshCatalyst(symbol, microdata = {}, options = {}) {
  const nowMs = toNumber(options.nowMs ?? microdata.nowMs, Date.now());
  const windowMs = Math.max(1, toNumber(options.catalystMaxAgeMs, 24 * 60 * 60 * 1000));
  const ticker = normalizeTicker(symbol);
  const coin = normalizeCoin(symbol);
  const catalysts = Array.isArray(microdata.catalysts)
    ? microdata.catalysts
    : Array.isArray(microdata.context?.catalysts)
      ? microdata.context.catalysts
      : [];
  return catalysts.some((event) => {
    const assets = Array.isArray(event.assets) ? event.assets.map(normalizeTicker) : [normalizeTicker(event.ticker || event.symbol || event.coin)];
    const coins = assets.map(normalizeCoin);
    const timestampMs = Date.parse(event.ts || event.timestamp || event.createdAt || event.detectedAt || '');
    return (assets.includes(ticker) || coins.includes(coin))
      && Number.isFinite(timestampMs)
      && nowMs - timestampMs <= windowMs;
  });
}

function buildNoFire(reason) {
  return {
    fire: false,
    side: null,
    reason,
    sizeUsd: 0,
    stopPx: null,
    tpPx: null,
  };
}

function evaluateLongShortSetup(symbol, microdata = {}, options = {}) {
  const ticker = normalizeTicker(symbol);
  if (!ticker) return null;
  const minRuleScore = toNumber(options.minRuleScore, DEFAULT_MIN_RULE_SCORE);
  const hardDisqualifier = getHardDisqualifier(ticker, microdata, options);
  if (hardDisqualifier) return buildNoFire(hardDisqualifier);

  const candles = getCandles(microdata);
  const currentPrice = getCurrentPrice(microdata, candles);
  const recent24h = getLookbackCandles(candles, 24);
  const recentHigh = Math.max(...recent24h.map((candle) => candle.high).filter(Number.isFinite));
  const recentLow = Math.min(...recent24h.map((candle) => candle.low).filter(Number.isFinite));
  if (!Number.isFinite(currentPrice) || !Number.isFinite(recentHigh) || !Number.isFinite(recentLow)) {
    return buildNoFire('insufficient candle/book price data');
  }

  const extension24h = getTwentyFourHourExtension(microdata, candles);
  const fundingBps = getFundingBps(microdata);
  const impactBps = getImpactBps(microdata);
  const bookOk = impactBps < toNumber(options.maxImpactBps, DEFAULT_MAX_IMPACT_BPS);
  const activePosition = hasActivePosition(ticker, microdata);
  const eventVeto = hasActiveEventVeto(ticker, microdata);

  const shortScore = clamp(
    0.35
    + Math.max(0, extension24h - 0.08) * 2.5
    + Math.max(0, fundingBps - 0.5) / 10
    + (bookOk ? 0.18 : -0.25)
    + (!activePosition ? 0.08 : -0.5)
    + (!eventVeto ? 0.04 : -0.5)
  );
  if (extension24h > 0.08 && fundingBps > 0.5 && bookOk && !activePosition && !eventVeto && shortScore >= minRuleScore) {
    const cushion = computeStopCushion(candles, 'short');
    const stopPx = round(recentHigh + cushion, 8);
    const tp1 = round(recentLow, 8);
    const tp2 = round(recentLow * 0.95, 8);
    return {
      fire: true,
      side: 'short',
      reason: `SHORT ORDI-pattern: 24h extension ${round(extension24h * 100, 2)}%, funding ${round(fundingBps, 3)}bps, impact ${round(impactBps, 2)}bps`,
      score: round(shortScore, 4),
      sizeUsd: buildSizeUsd(shortScore, microdata, options),
      stopPx,
      tpPx: tp1,
      tp2Px: tp2,
      entryPx: round(currentPrice, 8),
    };
  }

  const recovery = detectPostDipRecovery(candles);
  const catalyst = hasFreshCatalyst(ticker, microdata, options);
  const longScore = clamp(
    0.32
    + (recovery ? 0.23 : -0.2)
    + (fundingBps < 0 ? Math.min(0.22, Math.abs(fundingBps) / 8) : -0.15)
    + (bookOk ? 0.14 : -0.2)
    + (catalyst ? 0.16 : -0.2)
    + (!activePosition ? 0.08 : -0.5)
    + (!eventVeto ? 0.04 : -0.5)
  );
  if (recovery && fundingBps < 0 && bookOk && catalyst && !activePosition && !eventVeto && longScore >= minRuleScore) {
    const cushion = computeStopCushion(candles, 'long');
    const stopPx = round(recentLow - cushion, 8);
    const tpPx = round(currentPrice + ((currentPrice - stopPx) * 1.8), 8);
    return {
      fire: true,
      side: 'long',
      reason: `LONG post-dip recovery: 4h break higher, funding ${round(fundingBps, 3)}bps, fresh catalyst, impact ${round(impactBps, 2)}bps`,
      score: round(longScore, 4),
      sizeUsd: buildSizeUsd(longScore, microdata, options),
      stopPx,
      tpPx,
      tp2Px: round(currentPrice + ((currentPrice - stopPx) * 2.8), 8),
      entryPx: round(currentPrice, 8),
    };
  }

  return buildNoFire(`no setup: extension=${round(extension24h * 100, 2)}%, funding=${round(fundingBps, 3)}bps, impact=${round(impactBps, 2)}bps`);
}

module.exports = {
  DEFAULT_MAX_IMPACT_BPS,
  DEFAULT_MAX_MARGIN_USED_RATIO,
  DEFAULT_MIN_MARGIN_USD,
  DEFAULT_MIN_RULE_SCORE,
  DEFAULT_RECENT_SYMBOL_ACTIVITY_MS,
  detectPostDipRecovery,
  evaluateLongShortSetup,
  getHardDisqualifier,
};
