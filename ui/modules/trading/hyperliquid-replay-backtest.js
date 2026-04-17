'use strict';

const fs = require('fs');
const path = require('path');

const { getProjectRoot } = require('../../config');
const consensus = require('./consensus');
const hyperliquidClient = require('./hyperliquid-client');
const rangeStructure = require('./range-structure');
const signalProducer = require('./signal-producer');

const DEFAULT_SYMBOLS = Object.freeze(['BTC/USD', 'ETH/USD']);
const DEFAULT_LOOKBACK_DAYS = 183;
const DEFAULT_STEP_HOURS = 4;
const DEFAULT_RANGE_CONVICTION_STEP_MINUTES = 15;
const DEFAULT_FORWARD_HOURS = Object.freeze([4, 24]);
const DEFAULT_DAILY_BAR_LOOKBACK = 5;
const DEFAULT_ENTRY_MODE = 'unanimous_or_high';
const DEFAULT_MIN_AGREE_CONFIDENCE = 0.72;
const DEFAULT_RUNTIME_DIR = path.join(getProjectRoot(), '.squidrun', 'runtime', 'backtests');
const DEFAULT_SIMULATION_LANE = 'candle_sim_plus_funding';
const DEFAULT_REPLAY_STRATEGY_MODE = 'consensus';
const DEFAULT_FALLBACK_TAKER_FEE_RATE = 0.00045;
const DEFAULT_FALLBACK_MAKER_FEE_RATE = 0.00015;
const DEFAULT_COST_SCENARIOS = Object.freeze({
  base: { entrySlippageRate: 0.0002, exitSlippageRate: 0.0002 },
  conservative: { entrySlippageRate: 0.0005, exitSlippageRate: 0.0005 },
  harsh: { entrySlippageRate: 0.001, exitSlippageRate: 0.001 },
});

function toText(value, fallback = '') {
  const normalized = String(value ?? '').trim();
  return normalized || fallback;
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function round(value, digits = 6) {
  const numeric = toNumber(value, NaN);
  if (!Number.isFinite(numeric)) return null;
  return Number(numeric.toFixed(digits));
}

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, toNumber(value, min)));
}

function normalizeRate(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeTicker(value) {
  const normalized = toText(value).toUpperCase();
  if (!normalized) return '';
  return normalized.endsWith('/USD') ? normalized : `${normalized}/USD`;
}

function resolveSymbols(symbols = DEFAULT_SYMBOLS) {
  const input = Array.isArray(symbols) ? symbols : [symbols];
  return Array.from(new Set(input.map(normalizeTicker).filter(Boolean)));
}

function resolveReplayStrategyMode(options = {}) {
  const normalized = toText(options.strategyMode, DEFAULT_REPLAY_STRATEGY_MODE).toLowerCase();
  return normalized || DEFAULT_REPLAY_STRATEGY_MODE;
}

function resolveReplayWindow(options = {}) {
  const explicitEnd = options.end ? new Date(options.end) : new Date();
  const end = Number.isNaN(explicitEnd.getTime()) ? new Date() : explicitEnd;
  const explicitStart = options.start ? new Date(options.start) : null;
  if (explicitStart && !Number.isNaN(explicitStart.getTime())) {
    return {
      start: explicitStart,
      end,
    };
  }
  const lookbackDays = Math.max(30, Math.round(toNumber(options.lookbackDays, DEFAULT_LOOKBACK_DAYS)));
  return {
    start: new Date(end.getTime() - (lookbackDays * 24 * 60 * 60 * 1000)),
    end,
  };
}

function normalizeRawCandle(ticker, candle = {}) {
  return {
    symbol: ticker,
    timestamp: new Date(Number(candle.t)).toISOString(),
    open: toNumber(candle.o, 0),
    high: toNumber(candle.h, 0),
    low: toNumber(candle.l, 0),
    close: toNumber(candle.c, 0),
    volume: toNumber(candle.v, 0),
    tradeCount: toNumber(candle.n, 0),
  };
}

function normalizeFundingPoint(point = {}) {
  return {
    coin: toText(point.coin).toUpperCase(),
    fundingRate: toNumber(point.fundingRate, 0),
    premium: toNumber(point.premium, 0),
    time: toNumber(point.time, 0),
    timestamp: new Date(toNumber(point.time, 0)).toISOString(),
  };
}

async function fetchHistoricalCandles(client, ticker, interval, startMs, endMs) {
  const coin = hyperliquidClient.normalizeCoinSymbol(ticker);
  const candles = await withRateLimitRetry(() => client.candleSnapshot({
    coin,
    interval,
    startTime: startMs,
    endTime: endMs,
  }));
  return (Array.isArray(candles) ? candles : [])
    .map((candle) => normalizeRawCandle(ticker, candle))
    .filter((bar) => Number.isFinite(Date.parse(bar.timestamp)) && bar.close > 0)
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
}

async function fetchFundingHistoryPaged(client, ticker, startMs, endMs, options = {}) {
  const coin = hyperliquidClient.normalizeCoinSymbol(ticker);
  const pageSize = Math.max(100, Math.round(toNumber(options.pageSize, 500)));
  const pages = [];
  const seen = new Set();
  let cursorStart = startMs;
  let guard = 0;

  while (cursorStart < endMs && guard < 64) {
    guard += 1;
    const page = await withRateLimitRetry(() => client.fundingHistory({
      coin,
      startTime: cursorStart,
      endTime: endMs,
    })).catch(() => []);
    const normalized = (Array.isArray(page) ? page : [])
      .map(normalizeFundingPoint)
      .filter((point) => point.time >= cursorStart && point.time <= endMs && point.time > 0)
      .sort((left, right) => left.time - right.time);

    if (normalized.length === 0) {
      break;
    }

    let pageAdvanced = false;
    for (const point of normalized) {
      const key = `${point.coin}:${point.time}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pages.push(point);
      pageAdvanced = true;
    }

    const lastTime = normalized[normalized.length - 1].time;
    if (!pageAdvanced || !Number.isFinite(lastTime) || lastTime <= cursorStart) {
      break;
    }
    cursorStart = lastTime + 1;
    if (normalized.length < pageSize) {
      break;
    }
  }

  return pages.sort((left, right) => left.time - right.time);
}

async function withRateLimitRetry(task, options = {}) {
  const maxAttempts = Math.max(1, Math.round(toNumber(options.maxAttempts, 8)));
  let attempt = 0;
  let delayMs = Math.max(500, Math.round(toNumber(options.initialDelayMs, 1_000)));
  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      return await task();
    } catch (error) {
      const message = String(error?.message || '');
      const isRateLimit = message.includes('429') || message.toLowerCase().includes('rate limit');
      if (!isRateLimit || attempt >= maxAttempts) {
        throw error;
      }
      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, 10_000);
    }
  }
  throw new Error('Unreachable retry state');
}

function resolveCostScenarioConfig(name, overrides = {}) {
  const defaults = DEFAULT_COST_SCENARIOS[name] || DEFAULT_COST_SCENARIOS.base;
  return {
    entrySlippageRate: normalizeRate(overrides.entrySlippageRate, defaults.entrySlippageRate),
    exitSlippageRate: normalizeRate(overrides.exitSlippageRate, defaults.exitSlippageRate),
  };
}

async function resolveReplayCostModel(options = {}) {
  const walletAddress = toText(options.walletAddress, hyperliquidClient.resolveWalletAddress?.(options.env || process.env) || '');
  let takerFeeRate = normalizeRate(options.takerFeeRate, null);
  let assumptionSource = Number.isFinite(takerFeeRate) ? 'explicit_option' : 'fallback_default';
  let feePayload = null;
  let feeLookupError = null;

  if (!Number.isFinite(takerFeeRate) && walletAddress) {
    try {
      feePayload = await hyperliquidClient.getUserFees({
        ...options,
        walletAddress,
      });
      takerFeeRate = normalizeRate(feePayload?.userCrossRate, null);
      if (Number.isFinite(takerFeeRate)) {
        assumptionSource = 'live_userFees';
      }
    } catch (error) {
      feeLookupError = String(error?.message || error);
    }
  }

  if (!Number.isFinite(takerFeeRate)) {
    takerFeeRate = DEFAULT_FALLBACK_TAKER_FEE_RATE;
  }

  const scenarioOverrides = options.costScenarios && typeof options.costScenarios === 'object'
    ? options.costScenarios
    : {};
  const scenarios = Object.fromEntries(Object.keys(DEFAULT_COST_SCENARIOS).map((name) => ([
    name,
    resolveCostScenarioConfig(name, scenarioOverrides[name] || {}),
  ])));

  return {
    walletAddress: walletAddress || null,
    takerFeeRate: round(takerFeeRate, 8),
    makerFeeRate: normalizeRate(feePayload?.userAddRate, null) == null ? null : round(normalizeRate(feePayload?.userAddRate, null), 8),
    assumptionSource,
    feeLookupError,
    feePayload: feePayload
      ? {
          userCrossRate: round(normalizeRate(feePayload.userCrossRate, null), 8),
          userAddRate: round(normalizeRate(feePayload.userAddRate, null), 8),
        }
      : null,
    scenarios,
  };
}

async function fetchReplayDataset(options = {}) {
  const { start, end } = resolveReplayWindow(options);
  const startMs = start.getTime();
  const endMs = end.getTime();
  const symbols = resolveSymbols(options.symbols);
  const client = hyperliquidClient.createInfoClient(options);
  const strategyMode = resolveReplayStrategyMode(options);
  const datasets = [];
  for (const ticker of symbols) {
    const fetchRangeIntraday = strategyMode === 'range_conviction';
    const bars5m = fetchRangeIntraday ? await fetchHistoricalCandles(client, ticker, '5m', startMs, endMs) : [];
    if (fetchRangeIntraday) await sleep(750);
    const bars15m = fetchRangeIntraday ? await fetchHistoricalCandles(client, ticker, '15m', startMs, endMs) : [];
    if (fetchRangeIntraday) await sleep(750);
    const hourlyBars = await fetchHistoricalCandles(client, ticker, '1h', startMs, endMs);
    await sleep(750);
    const dailyBars = await fetchHistoricalCandles(client, ticker, '1d', startMs - (7 * 24 * 60 * 60 * 1000), endMs);
    await sleep(750);
    const fundingHistory = await fetchFundingHistoryPaged(client, ticker, startMs - (24 * 60 * 60 * 1000), endMs);
    datasets.push([
      ticker,
      {
        ticker,
        bars5m,
        bars15m,
        hourlyBars,
        dailyBars,
        fundingHistory,
      },
    ]);
    await sleep(200);
  }

  return {
    symbols,
    start: start.toISOString(),
    end: end.toISOString(),
    bySymbol: new Map(datasets),
  };
}

function findLatestIndexAtOrBefore(series = [], targetMs, selector = (item) => Date.parse(item?.timestamp || 0)) {
  let low = 0;
  let high = series.length - 1;
  let found = -1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const value = selector(series[mid]);
    if (!Number.isFinite(value)) {
      high = mid - 1;
      continue;
    }
    if (value <= targetMs) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

function buildDecisionTimeline(dataset = new Map(), options = {}) {
  const strategyMode = resolveReplayStrategyMode(options);
  const stepHours = Math.max(1, Math.round(toNumber(options.stepHours, DEFAULT_STEP_HOURS)));
  const stepMinutes = Math.max(
    5,
    Math.round(toNumber(options.stepMinutes, strategyMode === 'range_conviction' ? DEFAULT_RANGE_CONVICTION_STEP_MINUTES : 60))
  );
  const stepMs = strategyMode === 'range_conviction'
    ? stepMinutes * 60 * 1000
    : stepHours * 60 * 60 * 1000;
  const forwardHours = Array.isArray(options.forwardHours)
    ? options.forwardHours.map((value) => Math.max(1, Math.round(toNumber(value, 0)))).filter(Boolean)
    : DEFAULT_FORWARD_HOURS;
  const maxForwardHours = forwardHours.length > 0 ? Math.max(...forwardHours) : 0;
  const maxForwardMs = maxForwardHours * 60 * 60 * 1000;
  const timelines = Array.from(dataset.values()).map((entry) => {
    const sourceSeries = strategyMode === 'range_conviction' && Array.isArray(entry?.bars15m) && entry.bars15m.length > 0
      ? entry.bars15m
      : (entry?.hourlyBars || []);
    return new Set(sourceSeries.map((bar) => bar.timestamp));
  });
  if (timelines.length === 0) return [];
  const [first, ...rest] = timelines;
  const shared = Array.from(first)
    .filter((timestamp) => rest.every((set) => set.has(timestamp)))
    .sort((left, right) => Date.parse(left) - Date.parse(right));

  const selected = [];
  let lastSelectedMs = null;
  for (const timestamp of shared) {
    const timestampMs = Date.parse(timestamp);
    if (!Number.isFinite(timestampMs)) continue;
    if (lastSelectedMs != null && (timestampMs - lastSelectedMs) < stepMs) continue;
    const hasWarmup = Array.from(dataset.values()).every((entry) => {
      const dailyIndex = findLatestIndexAtOrBefore(entry.dailyBars, timestampMs);
      const hourlyIndex = findLatestIndexAtOrBefore(entry.hourlyBars, timestampMs);
      const intradayIndex = strategyMode === 'range_conviction'
        ? findLatestIndexAtOrBefore(entry.bars15m || [], timestampMs)
        : hourlyIndex;
      const latestBarMs = Date.parse(entry.hourlyBars[entry.hourlyBars.length - 1]?.timestamp || 0);
      return dailyIndex >= (DEFAULT_DAILY_BAR_LOOKBACK - 1)
        && hourlyIndex >= 0
        && intradayIndex >= 0
        && Number.isFinite(latestBarMs)
        && latestBarMs >= (timestampMs + maxForwardMs);
    });
    if (!hasWarmup) continue;
    selected.push(timestamp);
    lastSelectedMs = timestampMs;
  }
  return selected;
}

function sumVolume(series = []) {
  return round(series.reduce((sum, item) => sum + toNumber(item?.volume, 0), 0), 6) || 0;
}

function getWindow(series = [], endIndex = -1, size = DEFAULT_DAILY_BAR_LOOKBACK) {
  if (endIndex < 0) return [];
  return series.slice(Math.max(0, endIndex - size + 1), endIndex + 1);
}

function pctChange(current, baseline) {
  const currentNumber = toNumber(current, NaN);
  const baselineNumber = toNumber(baseline, NaN);
  if (!Number.isFinite(currentNumber) || !Number.isFinite(baselineNumber) || baselineNumber === 0) {
    return null;
  }
  return (currentNumber - baselineNumber) / baselineNumber;
}

function scorePercent(value) {
  return Math.round(clamp(value, 0, 1) * 100);
}

function buildHistoricalMechBoard(symbol, currentHourBar, dailyBarsWindow = [], fundingWindow = []) {
  const previousDailyBar = dailyBarsWindow.length >= 2 ? dailyBarsWindow[dailyBarsWindow.length - 2] : null;
  const currentPrice = toNumber(currentHourBar?.close, 0);
  const prevDayPx = toNumber(previousDailyBar?.close, 0);
  const priceChange24hPct = pctChange(currentPrice, prevDayPx);
  const currentFunding = fundingWindow.length > 0 ? fundingWindow[fundingWindow.length - 1] : null;
  const currentFundingRate = toNumber(currentFunding?.fundingRate, 0);
  const fundingRate24hAvg = fundingWindow.length > 0
    ? fundingWindow.reduce((sum, point) => sum + toNumber(point.fundingRate, 0), 0) / fundingWindow.length
    : null;
  const fundingRateChange24h = fundingWindow.length > 0
    ? currentFundingRate - toNumber(fundingWindow[0]?.fundingRate, currentFundingRate)
    : null;

  const fundingCrowdingFactor = clamp(Math.abs(currentFundingRate) / 0.00003, 0, 1);
  const priceMoveFactor = Number.isFinite(priceChange24hPct) ? clamp(Math.abs(priceChange24hPct) / 0.06, 0, 1) : 0;
  const biasScore = clamp(
    (Number.isFinite(priceChange24hPct) ? clamp(priceChange24hPct / 0.05, -1, 1) * 0.6 : 0)
    + (clamp(-currentFundingRate / 0.00003, -1, 1) * 0.4),
    -1,
    1
  );

  const mechanicalDirectionBias = biasScore >= 0.2
    ? 'bullish'
    : biasScore <= -0.2
      ? 'bearish'
      : 'neutral';

  const squeezeRiskScore = scorePercent((fundingCrowdingFactor * 0.65) + (priceMoveFactor * 0.35));
  const overcrowdingScore = scorePercent((fundingCrowdingFactor * 0.8) + (priceMoveFactor * 0.2));
  const tradeFlag = Math.abs(biasScore) >= 0.55 || squeezeRiskScore >= 60
    ? 'trade'
    : Math.abs(biasScore) >= 0.25 || squeezeRiskScore >= 40
      ? 'watch'
      : 'no-trade';

  return {
    ticker: symbol,
    markPx: round(currentPrice, 6),
    prevDayPx: round(prevDayPx, 6),
    priceChange24hPct: priceChange24hPct == null ? null : round(priceChange24hPct, 6),
    fundingRate: round(currentFundingRate, 8),
    fundingRateBps: round(currentFundingRate * 10_000, 4),
    fundingRate24hAvg: fundingRate24hAvg == null ? null : round(fundingRate24hAvg, 8),
    fundingRateChange24h: fundingRateChange24h == null ? null : round(fundingRateChange24h, 8),
    fundingRateChange24hBps: fundingRateChange24h == null ? null : round(fundingRateChange24h * 10_000, 4),
    openInterest: null,
    openInterestChange24hPct: null,
    priceOiDivergence: {
      label: 'historical_oi_unavailable',
      bias: 'neutral',
    },
    squeezeRiskScore,
    overcrowdingScore,
    cascadeRiskScore: null,
    mechanicalDirectionBias,
    mechanicalBiasScore: round(biasScore, 4),
    tradeFlag,
    dataCompleteness: round(fundingWindow.length > 0 && previousDailyBar ? 0.5 : 0.25, 2),
    rationale: [
      Number.isFinite(priceChange24hPct)
        ? `24h price change ${round(priceChange24hPct * 100, 2)}%`
        : '24h price context unavailable',
      fundingWindow.length > 0
        ? `funding ${round(currentFundingRate * 10_000, 3)} bps with ${fundingWindow.length} hourly samples`
        : 'funding history unavailable',
      'historical open interest unavailable from public Hyperliquid API',
    ],
    sourceNotes: {
      funding: 'hyperliquid fundingHistory',
      price: 'hyperliquid candleSnapshot',
      openInterest: 'unavailable_from_public_hyperliquid_history',
    },
  };
}

function buildSignalInputs(dataset = new Map(), timestamp, options = {}) {
  const timestampMs = Date.parse(timestamp);
  const strategyMode = resolveReplayStrategyMode(options);
  const snapshots = new Map();
  const bars = new Map();
  const rangeStructures = new Map();
  const mechBoardSymbols = {};
  const forwardPriceLookup = {};
  const forwardFundingLookup = {};

  for (const [symbol, entry] of dataset.entries()) {
    const hourlyIndex = findLatestIndexAtOrBefore(entry.hourlyBars, timestampMs);
    const dailyIndex = findLatestIndexAtOrBefore(entry.dailyBars, timestampMs);
    const bars5mIndex = findLatestIndexAtOrBefore(entry.bars5m || [], timestampMs);
    const bars15mIndex = findLatestIndexAtOrBefore(entry.bars15m || [], timestampMs);
    const currentHourBar = hourlyIndex >= 0 ? entry.hourlyBars[hourlyIndex] : null;
    const currentIntradayBar = strategyMode === 'range_conviction'
      ? (bars15mIndex >= 0
        ? entry.bars15m[bars15mIndex]
        : (bars5mIndex >= 0 ? entry.bars5m[bars5mIndex] : currentHourBar))
      : currentHourBar;
    const dailyBarsWindow = getWindow(entry.dailyBars, dailyIndex, DEFAULT_DAILY_BAR_LOOKBACK);
    const rollingHourlyVolume = hourlyIndex >= 0
      ? sumVolume(entry.hourlyBars.slice(Math.max(0, hourlyIndex - 23), hourlyIndex + 1))
      : 0;
    const previousDailyBar = dailyBarsWindow.length >= 2 ? dailyBarsWindow[dailyBarsWindow.length - 2] : null;
    const currentDailyBar = dailyBarsWindow.length > 0 ? dailyBarsWindow[dailyBarsWindow.length - 1] : null;

    snapshots.set(symbol, {
      symbol,
      tradePrice: toNumber(currentIntradayBar?.close, 0),
      bidPrice: toNumber(currentIntradayBar?.close, 0),
      askPrice: toNumber(currentIntradayBar?.close, 0),
      minuteClose: toNumber(currentIntradayBar?.close, 0),
      dailyClose: toNumber(currentIntradayBar?.close, 0),
      previousClose: toNumber(previousDailyBar?.close, toNumber(currentIntradayBar?.open, 0)),
      dailyVolume: toNumber(currentDailyBar?.volume, rollingHourlyVolume),
      tradeTimestamp: currentIntradayBar?.timestamp || timestamp,
      quoteTimestamp: currentIntradayBar?.timestamp || timestamp,
      raw: currentIntradayBar,
    });
    bars.set(symbol, dailyBarsWindow);
    if (strategyMode === 'range_conviction') {
      const hourlyStructureWindow = getWindow(entry.hourlyBars || [], hourlyIndex, 24);
      const bars5mWindow = getWindow(entry.bars5m || [], bars5mIndex, 72);
      const bars15mWindow = getWindow(entry.bars15m || [], bars15mIndex, 48);
      rangeStructures.set(symbol, rangeStructure.analyzeRangeStructure({
        bars5m: bars5mWindow,
        bars15m: bars15mWindow,
        bars1h: hourlyStructureWindow,
        currentPrice: toNumber(currentIntradayBar?.close, 0),
      }));
    }

    const fundingWindow = entry.fundingHistory.filter((point) => {
      return point.time <= timestampMs && point.time >= (timestampMs - (24 * 60 * 60 * 1000));
    });
    mechBoardSymbols[symbol] = buildHistoricalMechBoard(symbol, currentHourBar, dailyBarsWindow, fundingWindow);

    const horizons = Array.isArray(options.forwardHours) && options.forwardHours.length > 0
      ? options.forwardHours
      : DEFAULT_FORWARD_HOURS;
    for (const horizon of horizons) {
      const targetMs = timestampMs + (horizon * 60 * 60 * 1000);
      const targetIndex = findLatestIndexAtOrBefore(entry.hourlyBars, targetMs);
      if (!forwardPriceLookup[symbol]) forwardPriceLookup[symbol] = {};
      forwardPriceLookup[symbol][horizon] = targetIndex >= 0 ? toNumber(entry.hourlyBars[targetIndex]?.close, 0) : null;
      const fundingWindowForHorizon = entry.fundingHistory.filter((point) => point.time > timestampMs && point.time <= targetMs);
      if (!forwardFundingLookup[symbol]) forwardFundingLookup[symbol] = {};
      forwardFundingLookup[symbol][horizon] = {
        sampleCount: fundingWindowForHorizon.length,
        totalRate: fundingWindowForHorizon.length > 0
          ? round(fundingWindowForHorizon.reduce((sum, point) => sum + toNumber(point.fundingRate, 0), 0), 8)
          : null,
        points: fundingWindowForHorizon.map((point) => ({
          time: point.time,
          timestamp: point.timestamp,
          fundingRate: round(toNumber(point.fundingRate, 0), 8),
        })),
      };
    }
  }

  return {
    snapshots,
    bars,
    rangeStructures,
    cryptoMechBoard: {
      venue: 'hyperliquid_historical_replay',
      asOf: timestamp,
      symbols: mechBoardSymbols,
      sourceNotes: {
        price: 'hyperliquid candleSnapshot',
        funding: 'hyperliquid fundingHistory',
        openInterest: 'unavailable_from_public_hyperliquid_history',
        news: 'not_replayed',
      },
    },
    forwardPriceLookup,
    forwardFundingLookup,
  };
}

function evaluateTradeEligibility(result = {}, options = {}) {
  const strategyMode = resolveReplayStrategyMode(options);
  const entryMode = toText(options.entryMode, DEFAULT_ENTRY_MODE).toLowerCase();
  const minAgreeConfidence = toNumber(options.minAgreeConfidence, DEFAULT_MIN_AGREE_CONFIDENCE);
  const agreementCount = toNumber(result.agreementCount, 0);
  const averageAgreeConfidence = toNumber(result.averageAgreeConfidence, result.confidence);

  if (!result.consensus || result.decision === 'HOLD') {
    return {
      actionable: false,
      reason: result.decision === 'HOLD' && result.consensus ? 'hold_consensus' : 'no_consensus',
    };
  }
  if (strategyMode === 'range_conviction') {
    return {
      actionable: true,
      reason: 'single_thesis',
    };
  }
  if (entryMode === 'unanimous') {
    return {
      actionable: agreementCount === 3,
      reason: agreementCount === 3 ? 'unanimous' : 'requires_unanimous',
    };
  }
  if (entryMode === 'high_confidence') {
    return {
      actionable: agreementCount >= 2 && averageAgreeConfidence >= minAgreeConfidence,
      reason: agreementCount >= 2 && averageAgreeConfidence >= minAgreeConfidence
        ? 'high_confidence'
        : 'below_confidence_threshold',
    };
  }
  if (entryMode === 'unanimous_or_high') {
    return {
      actionable: agreementCount === 3 || (agreementCount >= 2 && averageAgreeConfidence >= minAgreeConfidence),
      reason: agreementCount === 3 || (agreementCount >= 2 && averageAgreeConfidence >= minAgreeConfidence)
        ? 'unanimous_or_high'
        : 'below_confidence_threshold',
    };
  }
  return {
    actionable: agreementCount >= 2,
    reason: agreementCount >= 2 ? 'majority' : 'requires_majority',
  };
}

function buildSingleThesisReplayResult(signal = {}) {
  const decision = toText(signal?.direction, 'HOLD').toUpperCase();
  const confidence = round(toNumber(signal?.confidence, 0), 4) || 0;
  const actionable = decision !== 'HOLD';
  return {
    ticker: normalizeTicker(signal?.ticker),
    decision,
    consensus: actionable,
    agreementCount: actionable ? 1 : 0,
    confidence,
    averageAgreeConfidence: confidence,
    averageSignalConfidence: confidence,
    agreeing: actionable ? [signal] : [],
    dissenting: actionable ? [] : [signal],
    summary: actionable
      ? `${normalizeTicker(signal?.ticker)}: ${decision} — range_conviction replay single-thesis`
      : `${normalizeTicker(signal?.ticker)}: HOLD — range_conviction replay thesis inactive`,
  };
}

function classifyDirectionalOutcome(direction, forwardReturn) {
  if (!Number.isFinite(forwardReturn)) return null;
  if (direction === 'BUY') return forwardReturn > 0;
  if (direction === 'SELL') return forwardReturn < 0;
  return null;
}

function buildForwardCostBreakdown(direction, fundingCarryLookup = {}, costModel = null) {
  const normalizedDirection = toText(direction).toUpperCase();
  const fundingTotalRate = normalizeRate(fundingCarryLookup?.totalRate, null);
  const fundingCarryPct = Number.isFinite(fundingTotalRate)
    ? round(
        normalizedDirection === 'SELL'
          ? fundingTotalRate
          : normalizedDirection === 'BUY'
            ? -fundingTotalRate
            : 0,
        8
      )
    : null;
  const scenarios = {};
  for (const [name, config] of Object.entries(costModel?.scenarios || {})) {
    const roundTripFeePct = round(2 * toNumber(costModel?.takerFeeRate, 0), 8);
    const roundTripSlippagePct = round(
      toNumber(config?.entrySlippageRate, 0) + toNumber(config?.exitSlippageRate, 0),
      8
    );
    scenarios[name] = {
      roundTripFeePct,
      roundTripSlippagePct,
      totalCostPct: round(roundTripFeePct + roundTripSlippagePct, 8),
    };
  }
  return {
    fundingCarryPct,
    fundingSampleCount: toNumber(fundingCarryLookup?.sampleCount, 0),
    fundingSamplesMissing: toNumber(fundingCarryLookup?.sampleCount, 0) === 0,
    scenarios,
  };
}

function buildDecisionRecord(timestamp, ticker, result, signals, mechSnapshot, entryPrice, forwardPrices = {}, fundingLookup = {}, options = {}) {
  const eligibility = evaluateTradeEligibility(result, options);
  const horizons = Array.isArray(options.forwardHours) && options.forwardHours.length > 0
    ? options.forwardHours
    : DEFAULT_FORWARD_HOURS;
  const forward = {};
  for (const horizon of horizons) {
    const exitPrice = toNumber(forwardPrices[horizon], NaN);
    const rawReturn = Number.isFinite(exitPrice) && entryPrice > 0 ? ((exitPrice - entryPrice) / entryPrice) : null;
    const signedReturn = rawReturn == null
      ? null
      : result.decision === 'SELL'
        ? -rawReturn
        : result.decision === 'BUY'
          ? rawReturn
          : null;
    const costBreakdown = buildForwardCostBreakdown(
      result.decision,
      fundingLookup[horizon] || {},
      options.costModel || null
    );
    const netReturnsByScenario = Object.fromEntries(Object.entries(costBreakdown.scenarios).map(([name, scenario]) => ([
      name,
      signedReturn == null
        ? null
        : round(
            signedReturn
              + toNumber(costBreakdown.fundingCarryPct, 0)
              - toNumber(scenario.totalCostPct, 0),
            6
          ),
    ])));
    forward[`${horizon}h`] = {
      exitPrice: Number.isFinite(exitPrice) ? round(exitPrice, 6) : null,
      rawReturnPct: rawReturn == null ? null : round(rawReturn, 6),
      signedReturnPct: signedReturn == null ? null : round(signedReturn, 6),
      fundingCarryPct: costBreakdown.fundingCarryPct,
      fundingSampleCount: costBreakdown.fundingSampleCount,
      fundingSamplesMissing: costBreakdown.fundingSamplesMissing,
      roundTripCosts: costBreakdown.scenarios,
      netSignedReturnPct: netReturnsByScenario.base ?? null,
      netSignedReturnPctByScenario: netReturnsByScenario,
      correct: eligibility.actionable ? classifyDirectionalOutcome(result.decision, rawReturn) : null,
    };
  }

  return {
    timestamp,
    ticker,
    simulationLane: toText(options.simulationLane, DEFAULT_SIMULATION_LANE),
    entryPrice: round(entryPrice, 6),
    consensus: {
      decision: result.decision,
      consensus: Boolean(result.consensus),
      agreementCount: toNumber(result.agreementCount, 0),
      confidence: round(toNumber(result.confidence, 0), 4),
      averageAgreeConfidence: round(toNumber(result.averageAgreeConfidence, 0), 4),
      averageSignalConfidence: round(toNumber(result.averageSignalConfidence, 0), 4),
      summary: result.summary,
      actionable: eligibility.actionable,
      actionabilityReason: eligibility.reason,
    },
    signals: Object.fromEntries(signals.map((signal) => [signal.agent, signal])),
    mechBoard: mechSnapshot,
    forward,
  };
}

function summarizeDecisions(decisions = [], options = {}) {
  const horizons = Array.isArray(options.forwardHours) && options.forwardHours.length > 0
    ? options.forwardHours
    : DEFAULT_FORWARD_HOURS;
  const bySymbol = {};

  for (const decision of decisions) {
    const bucket = bySymbol[decision.ticker] || {
      symbol: decision.ticker,
      totalEvaluations: 0,
      actionableTrades: 0,
      buySignals: 0,
      sellSignals: 0,
      holdSignals: 0,
      accuracy: {},
      grossExpectancy: {},
      expectancy: {},
      sensitivity: {},
      missingFundingWindows: {},
    };
    bucket.totalEvaluations += 1;
    if (decision.consensus.decision === 'BUY') bucket.buySignals += 1;
    if (decision.consensus.decision === 'SELL') bucket.sellSignals += 1;
    if (decision.consensus.decision === 'HOLD') bucket.holdSignals += 1;

    if (decision.consensus.actionable) {
      bucket.actionableTrades += 1;
      for (const horizon of horizons) {
        const key = `${horizon}h`;
        const result = decision.forward[key];
        if (!bucket.accuracy[key]) bucket.accuracy[key] = [];
        if (!bucket.grossExpectancy[key]) bucket.grossExpectancy[key] = [];
        if (!bucket.expectancy[key]) bucket.expectancy[key] = [];
        if (!bucket.missingFundingWindows[key]) bucket.missingFundingWindows[key] = [];
        if (typeof result?.correct === 'boolean') {
          bucket.accuracy[key].push(result.correct ? 1 : 0);
        }
        if (Number.isFinite(result?.signedReturnPct)) {
          bucket.grossExpectancy[key].push(result.signedReturnPct);
        }
        if (Number.isFinite(result?.netSignedReturnPct)) {
          bucket.expectancy[key].push(result.netSignedReturnPct);
        } else if (Number.isFinite(result?.signedReturnPct)) {
          bucket.expectancy[key].push(result.signedReturnPct);
        }
        bucket.missingFundingWindows[key].push(result?.fundingSamplesMissing === true ? 1 : 0);
        for (const [scenario, scenarioValue] of Object.entries(result?.netSignedReturnPctByScenario || {})) {
          if (!bucket.sensitivity[scenario]) bucket.sensitivity[scenario] = {};
          if (!bucket.sensitivity[scenario][key]) bucket.sensitivity[scenario][key] = [];
          if (Number.isFinite(scenarioValue)) {
            bucket.sensitivity[scenario][key].push(scenarioValue);
          }
        }
      }
    }

    bySymbol[decision.ticker] = bucket;
  }

  const normalizedSymbols = Object.values(bySymbol).map((entry) => ({
    symbol: entry.symbol,
    totalEvaluations: entry.totalEvaluations,
    actionableTrades: entry.actionableTrades,
    buySignals: entry.buySignals,
    sellSignals: entry.sellSignals,
    holdSignals: entry.holdSignals,
    accuracy: Object.fromEntries(Object.entries(entry.accuracy).map(([key, values]) => ([
      key,
      values.length > 0 ? round(values.reduce((sum, value) => sum + value, 0) / values.length, 4) : null,
    ]))),
    grossExpectancy: Object.fromEntries(Object.entries(entry.grossExpectancy).map(([key, values]) => ([
      key,
      values.length > 0 ? round(values.reduce((sum, value) => sum + value, 0) / values.length, 6) : null,
    ]))),
    expectancy: Object.fromEntries(Object.entries(entry.expectancy).map(([key, values]) => ([
      key,
      values.length > 0 ? round(values.reduce((sum, value) => sum + value, 0) / values.length, 6) : null,
    ]))),
    missingFundingWindows: Object.fromEntries(Object.entries(entry.missingFundingWindows).map(([key, values]) => ([
      key,
      values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : 0,
    ]))),
    sensitivity: Object.fromEntries(Object.entries(entry.sensitivity).map(([scenario, horizonValues]) => ([
      scenario,
      Object.fromEntries(Object.entries(horizonValues).map(([key, values]) => ([
        key,
        values.length > 0 ? round(values.reduce((sum, value) => sum + value, 0) / values.length, 6) : null,
      ]))),
    ]))),
  }));

  const actionable = decisions.filter((decision) => decision.consensus.actionable);
  const overall = {
    totalEvaluations: decisions.length,
    actionableTrades: actionable.length,
    accuracy: {},
    grossExpectancy: {},
    expectancy: {},
    sensitivity: {},
    missingFundingWindows: {},
  };
  for (const horizon of horizons) {
    const key = `${horizon}h`;
    const correctness = actionable
      .map((decision) => decision.forward[key]?.correct)
      .filter((value) => typeof value === 'boolean')
      .map((value) => value ? 1 : 0);
    const grossExpectancy = actionable
      .map((decision) => decision.forward[key]?.signedReturnPct)
      .filter((value) => Number.isFinite(value));
    const expectancy = actionable
      .map((decision) => decision.forward[key]?.netSignedReturnPct)
      .filter((value) => Number.isFinite(value));
    overall.accuracy[key] = correctness.length > 0
      ? round(correctness.reduce((sum, value) => sum + value, 0) / correctness.length, 4)
      : null;
    overall.grossExpectancy[key] = grossExpectancy.length > 0
      ? round(grossExpectancy.reduce((sum, value) => sum + value, 0) / grossExpectancy.length, 6)
      : null;
    overall.expectancy[key] = expectancy.length > 0
      ? round(expectancy.reduce((sum, value) => sum + value, 0) / expectancy.length, 6)
      : overall.grossExpectancy[key];
    overall.missingFundingWindows[key] = actionable
      .map((decision) => decision.forward[key]?.fundingSamplesMissing === true ? 1 : 0)
      .reduce((sum, value) => sum + value, 0);
    for (const scenario of Object.keys(DEFAULT_COST_SCENARIOS)) {
      const scenarioValues = actionable
        .map((decision) => decision.forward[key]?.netSignedReturnPctByScenario?.[scenario])
        .filter((value) => Number.isFinite(value));
      if (!overall.sensitivity[scenario]) overall.sensitivity[scenario] = {};
      overall.sensitivity[scenario][key] = scenarioValues.length > 0
        ? round(scenarioValues.reduce((sum, value) => sum + value, 0) / scenarioValues.length, 6)
        : null;
    }
  }

  return {
    overall,
    bySymbol: normalizedSymbols,
  };
}

function buildRunId() {
  return `hyperliquid-replay-${Date.now()}`;
}

function buildReportMarkdown(run = {}) {
  const symbolLines = (run.summary?.bySymbol || []).map((entry) => {
    return `| ${entry.symbol} | ${entry.totalEvaluations} | ${entry.actionableTrades} | ${entry.accuracy['4h'] ?? 'n/a'} | ${entry.accuracy['24h'] ?? 'n/a'} | ${entry.grossExpectancy['4h'] ?? 'n/a'} | ${entry.expectancy['4h'] ?? 'n/a'} | ${entry.grossExpectancy['24h'] ?? 'n/a'} | ${entry.expectancy['24h'] ?? 'n/a'} |`;
  }).join('\n');
  const overall24hExpectancy = run.summary?.overall?.expectancy?.['24h'];
  const overall24hAccuracy = run.summary?.overall?.accuracy?.['24h'];
  const verdict = Number.isFinite(overall24hExpectancy) && Number.isFinite(overall24hAccuracy)
    ? (overall24hExpectancy > 0 && overall24hAccuracy >= 0.5
      ? 'Tentative positive directional/cost evidence on the replayed symbols in this candle/funding lane, not broader system proof.'
      : 'No clear positive edge demonstrated on the replayed symbols in this candle/funding lane.')
    : 'Insufficient actionable signals for a firm verdict on the replayed symbol set.';

  return [
    '# Hyperliquid Historical Replay',
    '',
    `Run ID: \`${run.runId}\``,
    `Window: ${run.window?.start} to ${run.window?.end}`,
    `Symbols: ${(run.symbols || []).join(', ')}`,
    `Cadence: ${(run.config?.strategyMode || DEFAULT_REPLAY_STRATEGY_MODE) === 'range_conviction'
      ? `every ${run.config?.stepMinutes || DEFAULT_RANGE_CONVICTION_STEP_MINUTES}m`
      : `every ${run.config?.stepHours || DEFAULT_STEP_HOURS}h`}`,
    `Strategy mode: ${run.config?.strategyMode || DEFAULT_REPLAY_STRATEGY_MODE}`,
    `Simulation lane: ${run.simulationLane || DEFAULT_SIMULATION_LANE}`,
    '',
    '## What This Replayed',
    '',
    '- Hyperliquid 1h candles for execution/forward returns.',
    '- Hyperliquid 1d candles for the same daily-bar trend input our local crypto signal producer uses.',
    '- Hyperliquid hourly funding history, paged to avoid the 500-row API cap.',
    (run.config?.strategyMode || DEFAULT_REPLAY_STRATEGY_MODE) === 'range_conviction'
      ? '- Single-thesis replay path using the builder-owned `range_conviction` lane with replay-time 5m/15m/1h range structure.'
      : '- Three local agent signals (`architect`, `builder`, `oracle`) via the existing `signal-producer` and consensus engine.',
    `- Cost model: taker fee ${(toNumber(run.costModel?.takerFeeRate, 0) * 10_000).toFixed(3)} bps (${run.costModel?.assumptionSource || 'unknown'}), plus explicit slippage scenarios and realized funding carry from replayed funding samples.`,
    '- This is a candle/funding simulation lane, not a venue-complete execution replay.',
    '- Scope is only the explicitly replayed symbols shown above; default runs are majors-first sanity checks, not proof for the wider Hyperliquid basket.',
    '',
    '## Gaps / Honest Limits',
    '',
    '- Historical open interest is not available from the public Hyperliquid history surface used here, so OI-based mech-board fields are marked unavailable instead of being fabricated.',
    '- Historical news was not replayed because this repo has no matching archived news feed for the same window.',
    `- Fee lookup source: ${run.costModel?.assumptionSource || 'unknown'}${run.costModel?.feeLookupError ? ` (fallback reason: ${run.costModel.feeLookupError})` : ''}.`,
    '- Slippage is still modeled as explicit scenario assumptions, not order-book replay.',
    '- This report measures forward movement after the signal; it does not simulate live stop-loss / take-profit execution.',
    '',
    '## Summary',
    '',
    '| Symbol | Evaluations | Actionable Trades | 4h Accuracy | 24h Accuracy | 4h Gross | 4h Net | 24h Gross | 24h Net |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    symbolLines || '| n/a | 0 | 0 | n/a | n/a | n/a | n/a | n/a | n/a |',
    '',
    `Overall actionable trades: ${run.summary?.overall?.actionableTrades ?? 0}`,
    `Overall 4h accuracy: ${run.summary?.overall?.accuracy?.['4h'] ?? 'n/a'}`,
    `Overall 24h accuracy: ${run.summary?.overall?.accuracy?.['24h'] ?? 'n/a'}`,
    `Overall 4h gross expectancy: ${run.summary?.overall?.grossExpectancy?.['4h'] ?? 'n/a'}`,
    `Overall 4h net expectancy: ${run.summary?.overall?.expectancy?.['4h'] ?? 'n/a'}`,
    `Overall 24h gross expectancy: ${run.summary?.overall?.grossExpectancy?.['24h'] ?? 'n/a'}`,
    `Overall 24h net expectancy: ${run.summary?.overall?.expectancy?.['24h'] ?? 'n/a'}`,
    '',
    '## Sensitivity',
    '',
    `Base net expectancy (4h / 24h): ${run.summary?.overall?.sensitivity?.base?.['4h'] ?? 'n/a'} / ${run.summary?.overall?.sensitivity?.base?.['24h'] ?? 'n/a'}`,
    `Conservative net expectancy (4h / 24h): ${run.summary?.overall?.sensitivity?.conservative?.['4h'] ?? 'n/a'} / ${run.summary?.overall?.sensitivity?.conservative?.['24h'] ?? 'n/a'}`,
    `Harsh net expectancy (4h / 24h): ${run.summary?.overall?.sensitivity?.harsh?.['4h'] ?? 'n/a'} / ${run.summary?.overall?.sensitivity?.harsh?.['24h'] ?? 'n/a'}`,
    `Funding windows missing samples (4h / 24h): ${run.summary?.overall?.missingFundingWindows?.['4h'] ?? 0} / ${run.summary?.overall?.missingFundingWindows?.['24h'] ?? 0}`,
    '',
    `Verdict: ${verdict}`,
    '',
    '## Output Files',
    '',
    '- `summary.json`: top-level run metadata and aggregated metrics.',
    '- `decisions.json`: every replay decision with signals, mech-board snapshot, and forward returns.',
    '- `report.md`: this human-readable summary.',
  ].join('\n');
}

function writeReplayArtifacts(run = {}, runtimeDir = DEFAULT_RUNTIME_DIR) {
  const runDir = ensureDir(path.join(runtimeDir, run.runId));
  const summaryPath = path.join(runDir, 'summary.json');
  const decisionsPath = path.join(runDir, 'decisions.json');
  const reportPath = path.join(runDir, 'report.md');

  fs.writeFileSync(summaryPath, JSON.stringify({
    runId: run.runId,
    window: run.window,
    symbols: run.symbols,
    config: run.config,
    costModel: run.costModel,
    coverage: run.coverage,
    summary: run.summary,
    limitations: run.limitations,
  }, null, 2));
  fs.writeFileSync(decisionsPath, JSON.stringify(run.decisions, null, 2));
  fs.writeFileSync(reportPath, buildReportMarkdown(run));

  return {
    runDir,
    summaryPath,
    decisionsPath,
    reportPath,
  };
}

async function runHyperliquidHistoricalReplay(options = {}) {
  const runtimeDir = options.runtimeDir || DEFAULT_RUNTIME_DIR;
  ensureDir(runtimeDir);
  const symbols = resolveSymbols(options.symbols);
  const strategyMode = resolveReplayStrategyMode(options);
  const entryMode = toText(options.entryMode, DEFAULT_ENTRY_MODE);
  const minAgreeConfidence = toNumber(options.minAgreeConfidence, DEFAULT_MIN_AGREE_CONFIDENCE);
  const forwardHours = Array.isArray(options.forwardHours)
    ? options.forwardHours.map((value) => Math.max(1, Math.round(toNumber(value, 0)))).filter(Boolean)
    : DEFAULT_FORWARD_HOURS;
  const datasetInfo = await fetchReplayDataset({ ...options, symbols });
  const replayCostModel = await resolveReplayCostModel(options);
  const timeline = buildDecisionTimeline(datasetInfo.bySymbol, {
    strategyMode,
    stepHours: options.stepHours,
    stepMinutes: options.stepMinutes,
    forwardHours,
  });
  const decisions = [];

  for (const timestamp of timeline) {
    const inputs = buildSignalInputs(datasetInfo.bySymbol, timestamp, { forwardHours, strategyMode });
    const byTicker = new Map();
    let results = [];
    if (strategyMode === 'range_conviction') {
      const builderSignals = await signalProducer.produceSignals('builder', {
        symbols,
        assetClass: 'crypto',
        snapshots: inputs.snapshots,
        bars: inputs.bars,
        news: [],
        strategyMode,
        rangeStructures: inputs.rangeStructures,
      });
      const taggedBuilderSignals = builderSignals.map((signal) => ({ ...signal, agent: 'builder' }));
      for (const signal of taggedBuilderSignals) {
        const ticker = normalizeTicker(signal.ticker);
        if (!byTicker.has(ticker)) byTicker.set(ticker, []);
        byTicker.get(ticker).push(signal);
      }
      results = taggedBuilderSignals.map((signal) => buildSingleThesisReplayResult(signal));
    } else {
      const [architectSignals, builderSignals, oracleSignals] = await Promise.all([
        signalProducer.produceSignals('architect', {
          symbols,
          assetClass: 'crypto',
          snapshots: inputs.snapshots,
          bars: inputs.bars,
          news: [],
        }),
        signalProducer.produceSignals('builder', {
          symbols,
          assetClass: 'crypto',
          snapshots: inputs.snapshots,
          bars: inputs.bars,
          news: [],
        }),
        signalProducer.produceSignals('oracle', {
          symbols,
          assetClass: 'crypto',
          snapshots: inputs.snapshots,
          bars: inputs.bars,
          news: [],
        }),
      ]);
      const taggedArchitectSignals = architectSignals.map((signal) => ({ ...signal, agent: 'architect' }));
      const taggedBuilderSignals = builderSignals.map((signal) => ({ ...signal, agent: 'builder' }));
      const taggedOracleSignals = oracleSignals.map((signal) => ({ ...signal, agent: 'oracle' }));

      for (const signal of [...taggedArchitectSignals, ...taggedBuilderSignals, ...taggedOracleSignals]) {
        const ticker = normalizeTicker(signal.ticker);
        if (!byTicker.has(ticker)) byTicker.set(ticker, []);
        byTicker.get(ticker).push(signal);
      }

      results = consensus.evaluateAll(byTicker);
    }
    for (const result of results) {
      const ticker = normalizeTicker(result.ticker);
      const signals = byTicker.get(ticker) || [];
      const entryPrice = toNumber(inputs.snapshots.get(ticker)?.tradePrice, NaN);
      decisions.push(buildDecisionRecord(
        timestamp,
        ticker,
        result,
        signals,
        inputs.cryptoMechBoard.symbols[ticker] || null,
        entryPrice,
        inputs.forwardPriceLookup[ticker] || {},
        inputs.forwardFundingLookup[ticker] || {},
        {
          strategyMode,
          entryMode,
          minAgreeConfidence,
          forwardHours,
          simulationLane: DEFAULT_SIMULATION_LANE,
          costModel: replayCostModel,
        }
      ));
    }
  }

  const run = {
    runId: buildRunId(),
    simulationLane: DEFAULT_SIMULATION_LANE,
    window: {
      start: datasetInfo.start,
      end: datasetInfo.end,
    },
    symbols,
    config: {
      stepHours: Math.max(1, Math.round(toNumber(options.stepHours, DEFAULT_STEP_HOURS))),
      stepMinutes: strategyMode === 'range_conviction'
        ? Math.max(5, Math.round(toNumber(options.stepMinutes, DEFAULT_RANGE_CONVICTION_STEP_MINUTES)))
        : null,
      strategyMode,
      entryMode,
      minAgreeConfidence,
      forwardHours,
    },
    costModel: replayCostModel,
    coverage: Object.fromEntries(Array.from(datasetInfo.bySymbol.entries()).map(([ticker, entry]) => ([
      ticker,
      {
        hourlyBars: entry.hourlyBars.length,
        dailyBars: entry.dailyBars.length,
        fundingSamples: entry.fundingHistory.length,
      },
    ]))),
    limitations: {
      simulationLane: DEFAULT_SIMULATION_LANE,
      historicalOpenInterest: 'unavailable_from_public_hyperliquid_history',
      historicalNews: 'not_replayed',
      fees: {
        takerFeeRate: replayCostModel.takerFeeRate,
        makerFeeRate: replayCostModel.makerFeeRate,
        assumptionSource: replayCostModel.assumptionSource,
        feeLookupError: replayCostModel.feeLookupError,
      },
      slippage: replayCostModel.scenarios,
      fundingCarry: 'modeled_from_replayed_funding_history_when_samples_exist',
    },
    decisions,
    summary: summarizeDecisions(decisions, { forwardHours }),
  };

  const artifacts = writeReplayArtifacts(run, runtimeDir);
  return {
    ...run,
    artifacts,
  };
}

module.exports = {
  DEFAULT_DAILY_BAR_LOOKBACK,
  DEFAULT_ENTRY_MODE,
  DEFAULT_FORWARD_HOURS,
  DEFAULT_LOOKBACK_DAYS,
  DEFAULT_MIN_AGREE_CONFIDENCE,
  DEFAULT_RUNTIME_DIR,
  DEFAULT_STEP_HOURS,
  DEFAULT_SYMBOLS,
  buildDecisionTimeline,
  buildHistoricalMechBoard,
  buildReportMarkdown,
  buildSignalInputs,
  evaluateTradeEligibility,
  fetchFundingHistoryPaged,
  resolveReplayWindow,
  resolveReplayCostModel,
  runHyperliquidHistoricalReplay,
  summarizeDecisions,
  writeReplayArtifacts,
};
