'use strict';

const fs = require('fs');
const path = require('path');

const { getProjectRoot } = require('../../config');
const { createOrchestrator } = require('./orchestrator');
const macroRiskGate = require('./macro-risk-gate');
const watchlist = require('./watchlist');

const DEFAULT_BACKTEST_SYMBOLS = Object.freeze([
  'BTC/USD',
  'ETH/USD',
  'SOL/USD',
  'AVAX/USD',
  'LINK/USD',
  'DOGE/USD',
  'SPY',
  'QQQ',
  'XLE',
  'GLD',
  'TLT',
]);

const BOOK_SYMBOLS = Object.freeze({
  all: DEFAULT_BACKTEST_SYMBOLS,
  etf: Object.freeze(['SPY', 'QQQ', 'GLD', 'TLT', 'XLE']),
  crypto: Object.freeze(['BTC/USD', 'ETH/USD', 'SOL/USD', 'AVAX/USD', 'LINK/USD', 'DOGE/USD']),
  crisis: Object.freeze(['SQQQ', 'BITI', 'XLE', 'TLT']),
});

const DEFAULT_MACRO_PROXY_SYMBOLS = Object.freeze(['^VIX', 'CL=F']);
const DEFAULT_ENTRY_MODE = 'majority';
const DEFAULT_MIN_AGREE_CONFIDENCE = 0.72;
const DEFAULT_EXIT_MODE = 'baseline';
const DEFAULT_PROFIT_TAKE_PCT = 0.08;
const DEFAULT_TRAILING_STOP_PCT = 0.04;

const DEFAULT_DATA_DIR = path.join(getProjectRoot(), 'workspace', 'data', 'backtest');
const DEFAULT_RUNTIME_DIR = path.join(getProjectRoot(), '.squidrun', 'runtime', 'backtests');
const DEFAULT_LOOKBACK_BARS = 30;
const DEFAULT_STEP_BARS = 24;
const DEFAULT_INITIAL_EQUITY = 100_000;

function toText(value, fallback = '') {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function toTicker(value) {
  return toText(value).toUpperCase();
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function roundCurrency(value) {
  return Number(toNumber(value, 0).toFixed(2));
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function toIsoTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid timestamp: ${value}`);
  }
  return date.toISOString();
}

function normalizeTimestampBucket(value, options = {}) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid timestamp: ${value}`);
  }
  if (options.bucket === 'raw') {
    return date.toISOString();
  }
  date.setUTCMinutes(0, 0, 0);
  return date.toISOString();
}

function sourceTickerForSymbol(symbol) {
  const ticker = toTicker(symbol);
  if (ticker.includes('/')) {
    return ticker.replace('/', '-');
  }
  return ticker;
}

function fileStemForSourceTicker(sourceTicker = '') {
  return String(sourceTicker || '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function resolveBacktestCsvPath(symbol, options = {}) {
  const dataDir = options.dataDir || DEFAULT_DATA_DIR;
  const sourceTicker = sourceTickerForSymbol(symbol);
  const interval = toText(options.interval, '1h');
  const period = toText(options.period, '6mo');
  const preferred = path.join(dataDir, `${fileStemForSourceTicker(sourceTicker)}_${interval}_${period}.csv`);
  if (fs.existsSync(preferred)) return preferred;
  const legacy = path.join(dataDir, `${String(sourceTicker).replace(/-/g, '_')}_${interval}_${period}.csv`);
  if (fs.existsSync(legacy)) return legacy;
  return preferred;
}

function resolveBookSymbols(book = 'all', symbols = null) {
  if (Array.isArray(symbols) && symbols.length > 0) {
    return symbols.map(toTicker);
  }
  const normalizedBook = toText(book, 'all').toLowerCase();
  return (BOOK_SYMBOLS[normalizedBook] || DEFAULT_BACKTEST_SYMBOLS).map(toTicker);
}

function parseCsvLine(line = '') {
  return String(line || '').split(',').map((part) => part.trim());
}

function loadBarsFromCsv(filePath, symbol) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/).filter(Boolean);
  if (lines.length <= 1) return [];
  const [headerLine, ...rows] = lines;
  const headers = parseCsvLine(headerLine).map((value) => value.toLowerCase());
  const indexByName = Object.fromEntries(headers.map((value, index) => [value, index]));

  return rows.map((line) => {
    const parts = parseCsvLine(line);
    return {
      symbol: toTicker(symbol),
      timestamp: normalizeTimestampBucket(parts[indexByName.timestamp]),
      open: toNumber(parts[indexByName.open], null),
      high: toNumber(parts[indexByName.high], null),
      low: toNumber(parts[indexByName.low], null),
      close: toNumber(parts[indexByName.close], null),
      volume: toNumber(parts[indexByName.volume], 0),
    };
  }).filter((bar) => bar.timestamp && bar.close != null).sort((left, right) => {
    return Date.parse(left.timestamp) - Date.parse(right.timestamp);
  });
}

function loadDataset(symbols = DEFAULT_BACKTEST_SYMBOLS, options = {}) {
  const dataset = new Map();
  for (const symbol of symbols.map(toTicker)) {
    const filePath = resolveBacktestCsvPath(symbol, options);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Missing backtest CSV for ${symbol}: ${filePath}`);
    }
    dataset.set(symbol, loadBarsFromCsv(filePath, symbol));
  }
  return dataset;
}

function loadOptionalDataset(symbols = [], options = {}) {
  const dataset = new Map();
  for (const symbol of symbols.map(toText).filter(Boolean)) {
    const filePath = resolveBacktestCsvPath(symbol, options);
    if (!fs.existsSync(filePath)) continue;
    dataset.set(symbol, loadBarsFromCsv(filePath, symbol));
  }
  return dataset;
}

function buildIntersectionTimeline(dataset = new Map()) {
  const timestampSets = Array.from(dataset.values()).map((bars) => {
    return new Set((Array.isArray(bars) ? bars : []).map((bar) => bar.timestamp));
  });
  if (timestampSets.length === 0) return [];
  const [first, ...rest] = timestampSets;
  const timeline = Array.from(first).filter((timestamp) => {
    return rest.every((set) => set.has(timestamp));
  });
  return timeline.sort((left, right) => Date.parse(left) - Date.parse(right));
}

function buildTimelineIndex(dataset = new Map(), timeline = []) {
  const index = new Map();
  for (const [ticker, bars] of dataset.entries()) {
    const byTimestamp = new Map((Array.isArray(bars) ? bars : []).map((bar) => [bar.timestamp, bar]));
    index.set(ticker, timeline.map((timestamp) => byTimestamp.get(timestamp)).filter(Boolean));
  }
  return index;
}

function findLatestBarAtOrBefore(series = [], timestamp) {
  const target = Date.parse(timestamp);
  if (!Number.isFinite(target)) return { current: null, previous: null };
  let previous = null;
  let current = null;
  for (const bar of Array.isArray(series) ? series : []) {
    const barTime = Date.parse(bar?.timestamp);
    if (!Number.isFinite(barTime) || barTime > target) break;
    previous = current;
    current = bar;
  }
  return { current, previous };
}

function buildSnapshotFromBars(ticker, currentBar, previousBar) {
  const close = toNumber(currentBar?.close, null);
  return {
    symbol: ticker,
    tradePrice: close,
    bidPrice: close,
    askPrice: close,
    minuteClose: close,
    dailyClose: close,
    previousClose: toNumber(previousBar?.close, close),
    dailyVolume: toNumber(currentBar?.volume, 0),
    tradeTimestamp: currentBar?.timestamp || null,
    quoteTimestamp: currentBar?.timestamp || null,
    raw: currentBar || null,
  };
}

function clonePositions(positions = []) {
  return (Array.isArray(positions) ? positions : []).map((position) => ({ ...position }));
}

function markToMarketEquity(state = {}, snapshots = new Map()) {
  const cash = roundCurrency(state.cash);
  const positionValue = clonePositions(state.positions).reduce((sum, position) => {
    const snapshot = snapshots instanceof Map ? snapshots.get(position.ticker) : snapshots?.[position.ticker];
    const mark = toNumber(snapshot?.tradePrice ?? snapshot?.dailyClose ?? position.avgPrice, 0);
    return sum + (toNumber(position.shares, 0) * mark);
  }, 0);
  return roundCurrency(cash + positionValue);
}

function buildPortfolioSnapshot(state = {}, snapshots = new Map(), timestamp = null) {
  const totalEquity = markToMarketEquity(state, snapshots);
  const positions = clonePositions(state.positions).map((position) => {
    const snapshot = snapshots instanceof Map ? snapshots.get(position.ticker) : snapshots?.[position.ticker];
    const mark = toNumber(snapshot?.tradePrice ?? snapshot?.dailyClose ?? position.avgPrice, 0);
    return {
      ...position,
      marketValue: roundCurrency(mark * toNumber(position.shares, 0)),
      currentPrice: mark,
    };
  });

  return {
    asOf: timestamp,
    totalEquity,
    positions,
    risk: {
      peakEquity: roundCurrency(state.peakEquity),
      dayStartEquity: roundCurrency(state.dayStartEquity),
    },
  };
}

function staticMacroRisk(regime = 'green') {
  const normalizedRegime = toText(regime, 'green').toLowerCase();
  const constraints = macroRiskGate._internals.regimeConstraints(normalizedRegime, { crisisType: 'none' });
  return {
    regime: normalizedRegime,
    strategyMode: constraints.strategyMode,
    crisisType: constraints.crisisType || 'none',
    score: normalizedRegime === 'green' ? 18 : 50,
    constraints,
    reason: `Backtest static macro override: ${normalizedRegime.toUpperCase()}`,
  };
}

function buildDynamicMacroRisk(timestamp, macroDataset = new Map(), options = {}) {
  const { current: vixBar, previous: prevVixBar } = findLatestBarAtOrBefore(macroDataset.get('^VIX') || [], timestamp);
  const { current: oilBar, previous: prevOilBar } = findLatestBarAtOrBefore(macroDataset.get('CL=F') || [], timestamp);
  const vix = toNumber(vixBar?.close, macroRiskGate._internals.FALLBACK_VALUES.vix);
  const oilPrice = toNumber(oilBar?.close, macroRiskGate._internals.FALLBACK_VALUES.oilPrice);
  const vixPrev = toNumber(prevVixBar?.close, vix);
  const oilPrev = toNumber(prevOilBar?.close, oilPrice);
  const market = {
    vixDeltaPct: vixPrev > 0 ? (vix - vixPrev) / vixPrev : 0,
    oilDeltaPct: oilPrev > 0 ? (oilPrice - oilPrev) / oilPrev : 0,
  };
  const fed = macroRiskGate._internals.getFedEventState(new Date(timestamp));
  const crisisType = macroRiskGate._internals.classifyCrisisType(vix, oilPrice, market);
  const geopolitics = {
    ...macroRiskGate._internals.FALLBACK_VALUES.geopolitics,
    source: 'historical_proxy',
    riskScore: crisisType === 'none' ? 20 : (crisisType === 'inflationary' ? 72 : 68),
    sentiment: crisisType === 'none' ? 0 : (crisisType === 'inflationary' ? -0.45 : -0.35),
    stayCashTrigger: false,
    activeKineticConflict: false,
    avgTone: crisisType === 'none' ? 0 : -1.8,
    minTone: crisisType === 'none' ? 0 : -2.6,
    note: 'Historical macro proxy replay based on VIX and oil direction.',
  };
  const classified = macroRiskGate._internals.classifyRegime(vix, 50, oilPrice, { geopolitics, fed, market }, new Date(timestamp));
  let regime = classified.regime;

  if (options.crisisActivation === true && crisisType !== 'none' && ['red', 'stay_cash'].includes(regime)) {
    regime = 'stay_cash';
  }

  const score = macroRiskGate._internals.computeRiskScore(vix, 50, oilPrice, { geopolitics, fed, market });
  const constraints = macroRiskGate._internals.regimeConstraints(regime, { crisisType });

  return {
    regime,
    strategyMode: constraints.strategyMode,
    crisisType,
    score,
    constraints,
    crisisUniverse: constraints.crisisUniverse,
    indicators: {
      vix: { value: vix, previousValue: vixPrev, source: vixBar ? 'historical_proxy' : 'fallback' },
      fearGreed: { value: 50, source: 'static_proxy' },
      oilPrice: { value: oilPrice, previousValue: oilPrev, source: oilBar ? 'historical_proxy' : 'fallback' },
    },
    intelligence: {
      geopolitics,
      fed,
      market,
    },
    reason: `${classified.reason.join('; ')} Historical proxy crisisType=${crisisType}.`,
    fetchedAt: timestamp,
  };
}

function intervalAnnualization(interval = '1h') {
  const normalized = toText(interval, '1h').toLowerCase();
  if (normalized.includes('1d') || normalized === '1day') {
    return 252;
  }
  if (normalized.includes('1h') || normalized === '60m') {
    return 252 * 6.5;
  }
  return 252;
}

function computeSharpeRatio(equityCurve = [], interval = '1h') {
  if (!Array.isArray(equityCurve) || equityCurve.length < 3) return 0;
  const returns = [];
  for (let index = 1; index < equityCurve.length; index += 1) {
    const previous = toNumber(equityCurve[index - 1]?.equity, 0);
    const current = toNumber(equityCurve[index]?.equity, 0);
    if (previous > 0 && current > 0) {
      returns.push((current - previous) / previous);
    }
  }
  if (returns.length < 2) return 0;
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (returns.length - 1);
  const stdDev = Math.sqrt(Math.max(variance, 0));
  if (stdDev === 0) return 0;
  return Number(((mean / stdDev) * Math.sqrt(intervalAnnualization(interval))).toFixed(2));
}

function computeMaxDrawdown(equityCurve = []) {
  let peak = 0;
  let maxDrawdown = 0;
  for (const point of equityCurve) {
    const equity = toNumber(point?.equity, 0);
    peak = Math.max(peak, equity);
    if (peak > 0) {
      maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
    }
  }
  return Number(maxDrawdown.toFixed(4));
}

function upsertPosition(state, trade, fillPrice) {
  const ticker = toTicker(trade.ticker);
  const shares = toNumber(trade.shares, 0);
  if (!(shares > 0) || !(fillPrice > 0)) return false;
  const existing = state.positions.find((position) => position.ticker === ticker);
  if (existing) {
    const totalShares = toNumber(existing.shares, 0) + shares;
    const blendedCost = totalShares > 0
      ? ((toNumber(existing.shares, 0) * toNumber(existing.avgPrice, 0)) + (shares * fillPrice)) / totalShares
      : fillPrice;
    existing.shares = totalShares;
    existing.avgPrice = Number(blendedCost.toFixed(6));
    existing.stopLossPrice = trade.stopLossPrice || existing.stopLossPrice || null;
    existing.highestPrice = Math.max(toNumber(existing.highestPrice, fillPrice), fillPrice);
    existing.profitTargetPrice = trade.profitTargetPrice || existing.profitTargetPrice || null;
    existing.trailingStopPct = trade.trailingStopPct || existing.trailingStopPct || null;
    return true;
  }
  state.positions.push({
    ticker,
    shares,
    avgPrice: fillPrice,
    stopLossPrice: trade.stopLossPrice || null,
    highestPrice: fillPrice,
    profitTargetPrice: trade.profitTargetPrice || null,
    trailingStopPct: trade.trailingStopPct || null,
    assetClass: trade.assetClass || watchlist.getAssetClassForTicker(ticker, 'us_equity'),
    openedAt: trade.timestamp,
  });
  return true;
}

function closePosition(state, ticker, fillPrice, timestamp, closedTrades, reason = 'signal_exit') {
  const normalizedTicker = toTicker(ticker);
  const index = state.positions.findIndex((position) => position.ticker === normalizedTicker);
  if (index < 0 || !(fillPrice > 0)) return false;
  const position = state.positions[index];
  const proceeds = toNumber(position.shares, 0) * fillPrice;
  const pnl = proceeds - (toNumber(position.shares, 0) * toNumber(position.avgPrice, 0));
  state.cash = roundCurrency(state.cash + proceeds);
  state.positions.splice(index, 1);
  closedTrades.push({
    ticker: normalizedTicker,
    entryPrice: roundCurrency(position.avgPrice),
    exitPrice: roundCurrency(fillPrice),
    shares: toNumber(position.shares, 0),
    pnl: roundCurrency(pnl),
    pnlPct: toNumber(position.avgPrice, 0) > 0
      ? Number((pnl / (toNumber(position.shares, 0) * toNumber(position.avgPrice, 0))).toFixed(4))
      : 0,
    openedAt: position.openedAt || null,
    closedAt: timestamp,
    reason,
  });
  return true;
}

function shouldTakeTrade(trade = {}, options = {}) {
  const entryMode = toText(options.entryMode, DEFAULT_ENTRY_MODE).toLowerCase();
  const agreeing = Array.isArray(trade?.consensus?.agreeing) ? trade.consensus.agreeing : [];
  const agreementCount = toNumber(trade?.consensus?.agreementCount, agreeing.length);
  const averageConfidence = agreeing.length > 0
    ? agreeing.reduce((sum, signal) => sum + toNumber(signal?.confidence, 0), 0) / agreeing.length
    : 0;
  const minAgreeConfidence = toNumber(options.minAgreeConfidence, DEFAULT_MIN_AGREE_CONFIDENCE);

  if (entryMode === 'unanimous') {
    return agreementCount === 3;
  }
  if (entryMode === 'high_confidence') {
    return agreementCount >= 2 && averageConfidence >= minAgreeConfidence;
  }
  if (entryMode === 'unanimous_or_high') {
    return agreementCount === 3 || (agreementCount >= 2 && averageConfidence >= minAgreeConfidence);
  }
  return agreementCount >= 2;
}

function filterApprovedTrades(approvedTrades = [], macroRisk = null, options = {}) {
  const filtered = approvedTrades.filter((trade) => shouldTakeTrade(trade, options));
  const capped = toNumber(options.maxIdeasPerStep, 0);
  const sorted = filtered.sort((left, right) => {
    const leftConfidence = Array.isArray(left?.consensus?.agreeing)
      ? left.consensus.agreeing.reduce((sum, signal) => sum + toNumber(signal?.confidence, 0), 0) / Math.max(1, left.consensus.agreeing.length)
      : 0;
    const rightConfidence = Array.isArray(right?.consensus?.agreeing)
      ? right.consensus.agreeing.reduce((sum, signal) => sum + toNumber(signal?.confidence, 0), 0) / Math.max(1, right.consensus.agreeing.length)
      : 0;
    return rightConfidence - leftConfidence;
  });

  if (String(options.book || '').toLowerCase() === 'crisis' && !['red', 'stay_cash'].includes(String(macroRisk?.regime || '').toLowerCase())) {
    return [];
  }

  return capped > 0 ? sorted.slice(0, capped) : sorted;
}

function maybeTriggerStops(state, snapshots, barsByTicker, timestamp, closedTrades, options = {}) {
  const exitMode = toText(options.exitMode, DEFAULT_EXIT_MODE).toLowerCase();
  const trailingStopPct = toNumber(options.trailingStopPct, DEFAULT_TRAILING_STOP_PCT);
  const profitTakePct = toNumber(options.profitTakePct, DEFAULT_PROFIT_TAKE_PCT);

  for (const position of [...state.positions]) {
    const currentBar = barsByTicker instanceof Map ? barsByTicker.get(position.ticker) : barsByTicker?.[position.ticker];
    if (!currentBar) continue;

    position.highestPrice = Math.max(toNumber(position.highestPrice, position.avgPrice), toNumber(currentBar.high, position.avgPrice));
    const fixedStop = toNumber(position.stopLossPrice, 0);
    const trailingStop = (exitMode === 'trailing' || exitMode === 'combined')
      ? position.highestPrice * (1 - Math.max(0.005, trailingStopPct))
      : 0;
    const activeStop = Math.max(fixedStop, trailingStop);
    if (activeStop > 0 && toNumber(currentBar.low, Infinity) <= activeStop) {
      const stopReason = trailingStop > fixedStop ? 'trailing_stop' : 'stop_loss';
      closePosition(state, position.ticker, activeStop, timestamp, closedTrades, stopReason);
      continue;
    }

    const profitTargetPrice = position.profitTargetPrice
      || ((exitMode === 'profit_target' || exitMode === 'combined')
        ? toNumber(position.avgPrice, 0) * (1 + Math.max(0.01, profitTakePct))
        : 0);
    if (profitTargetPrice > 0 && (exitMode === 'profit_target' || exitMode === 'combined') && toNumber(currentBar.high, 0) >= profitTargetPrice) {
      closePosition(state, position.ticker, profitTargetPrice, timestamp, closedTrades, 'profit_take');
    }
  }
  return buildPortfolioSnapshot(state, snapshots, timestamp);
}

function buildStepContext(datasetIndex = new Map(), symbols = [], stepIndex = 0, lookbackBars = DEFAULT_LOOKBACK_BARS) {
  const snapshots = new Map();
  const bars = new Map();
  const currentBars = new Map();

  for (const symbol of symbols.map(toTicker)) {
    const series = datasetIndex.get(symbol) || [];
    const currentBar = series[stepIndex];
    const previousBar = series[stepIndex - 1] || null;
    if (!currentBar) {
      throw new Error(`Missing current bar for ${symbol} at step ${stepIndex}`);
    }
    snapshots.set(symbol, buildSnapshotFromBars(symbol, currentBar, previousBar));
    bars.set(symbol, series.slice(Math.max(0, stepIndex - lookbackBars + 1), stepIndex + 1));
    currentBars.set(symbol, currentBar);
  }

  return { snapshots, bars, currentBars };
}

async function runBacktest(options = {}) {
  const book = toText(options.book, 'all').toLowerCase();
  const symbols = resolveBookSymbols(book, options.symbols);
  const interval = toText(options.interval, '1h');
  const period = toText(options.period, '6mo');
  const lookbackBars = Math.max(5, Math.floor(toNumber(options.lookbackBars, DEFAULT_LOOKBACK_BARS)));
  const stepBars = Math.max(1, Math.floor(toNumber(options.stepBars, DEFAULT_STEP_BARS)));
  const initialEquity = roundCurrency(toNumber(options.initialEquity, DEFAULT_INITIAL_EQUITY));
  const dataset = options.dataset instanceof Map ? options.dataset : loadDataset(symbols, options);
  const macroDataset = options.dynamicMacro === true
    ? (options.macroDataset instanceof Map
      ? options.macroDataset
      : loadOptionalDataset(options.macroProxySymbols || DEFAULT_MACRO_PROXY_SYMBOLS, options))
    : new Map();
  const timeline = Array.isArray(options.timeline) ? options.timeline : buildIntersectionTimeline(dataset);

  if (timeline.length <= lookbackBars + 1) {
    throw new Error(`Not enough aligned bars for backtest. Need > ${lookbackBars + 1}, got ${timeline.length}.`);
  }

  const datasetIndex = buildTimelineIndex(dataset, timeline);
  const runId = `backtest-${Date.now()}`;
  const runDir = ensureDir(path.join(options.runtimeDir || DEFAULT_RUNTIME_DIR, runId));
  const journalPath = path.join(runDir, 'backtest-journal.db');
  const agentAttributionStatePath = path.join(runDir, 'agent-attribution.json');
  const staticMacro = options.macroRisk || staticMacroRisk(options.macroRegime || 'green');

  const state = {
    cash: initialEquity,
    positions: [],
    peakEquity: initialEquity,
    dayStartEquity: initialEquity,
    tradesToday: 0,
    currentDay: null,
  };
  const equityCurve = [];
  const closedTrades = [];
  const decisionLog = [];

  for (let stepIndex = lookbackBars - 1; stepIndex < timeline.length - 1; stepIndex += stepBars) {
    const timestamp = timeline[stepIndex];
    const currentDay = timestamp.slice(0, 10);
    if (state.currentDay !== currentDay) {
      state.currentDay = currentDay;
      state.tradesToday = 0;
      const markedSnapshots = buildStepContext(datasetIndex, symbols, stepIndex, lookbackBars).snapshots;
      state.dayStartEquity = markToMarketEquity(state, markedSnapshots);
    }

    const { snapshots, bars, currentBars } = buildStepContext(datasetIndex, symbols, stepIndex, lookbackBars);
    maybeTriggerStops(state, snapshots, currentBars, timestamp, closedTrades, options);
    const markedEquity = markToMarketEquity(state, snapshots);
    state.peakEquity = Math.max(state.peakEquity, markedEquity);
    const portfolioSnapshot = buildPortfolioSnapshot(state, snapshots, timestamp);
    const macroRisk = options.dynamicMacro === true
      ? buildDynamicMacroRisk(timestamp, macroDataset, {
        crisisActivation: book === 'crisis' || options.crisisActivation === true,
      })
      : staticMacro;

    const orchestrator = createOrchestrator({
      consultationEnabled: false,
      realAgentConsultationEnabled: false,
      journalPath,
    });
    orchestrator.clearSignals();

    const consensusPhase = await orchestrator.runConsensusRound({
      date: timestamp,
      symbols,
      snapshots,
      bars,
      news: [],
      macroRisk,
      portfolioSnapshot,
      consultationEnabled: false,
      realAgentConsultationEnabled: false,
      journalPath,
      agentAttributionStatePath,
      tradesToday: state.tradesToday,
      dayStartEquity: state.dayStartEquity,
      peakEquity: state.peakEquity,
    });

    const filteredApprovedTrades = filterApprovedTrades(consensusPhase.approvedTrades, macroRisk, {
      ...options,
      book,
    });

    decisionLog.push({
      timestamp,
      macroRisk: {
        regime: macroRisk.regime,
        strategyMode: macroRisk.strategyMode,
        crisisType: macroRisk.crisisType || 'none',
      },
      approvedTrades: filteredApprovedTrades.map((trade) => ({
        ticker: trade.ticker,
        decision: trade.consensus?.decision,
        shares: trade.riskCheck?.maxShares || 0,
        referencePrice: trade.referencePrice,
      })),
      rejectedCount: consensusPhase.rejectedTrades.length + Math.max(0, consensusPhase.approvedTrades.length - filteredApprovedTrades.length),
    });

    equityCurve.push({
      timestamp,
      equity: markedEquity,
      cash: roundCurrency(state.cash),
      openPositions: clonePositions(state.positions),
    });

    const nextIndex = stepIndex + 1;
    for (const trade of filteredApprovedTrades) {
      const nextBarSeries = datasetIndex.get(trade.ticker) || [];
      const nextBar = nextBarSeries[nextIndex];
      const fillPrice = toNumber(nextBar?.open, toNumber(nextBar?.close, 0));
      if (!(fillPrice > 0)) continue;

      if (String(trade.consensus?.decision || '').toUpperCase() === 'BUY') {
        const requestedShares = toNumber(trade.riskCheck?.maxShares, 0);
        const affordableShares = watchlist.getAssetClassForTicker(trade.ticker, 'us_equity') === 'crypto'
          ? Number((state.cash / fillPrice).toFixed(6))
          : Math.floor(state.cash / fillPrice);
        const shares = Math.min(requestedShares, affordableShares);
        if (!(shares > 0)) continue;
        const cost = shares * fillPrice;
        state.cash = roundCurrency(state.cash - cost);
        if (upsertPosition(state, {
          ticker: trade.ticker,
          shares,
          stopLossPrice: trade.riskCheck?.stopLossPrice || null,
          profitTargetPrice: (toText(options.exitMode, DEFAULT_EXIT_MODE).toLowerCase() === 'profit_target'
            || toText(options.exitMode, DEFAULT_EXIT_MODE).toLowerCase() === 'combined')
            ? fillPrice * (1 + Math.max(0.01, toNumber(options.profitTakePct, DEFAULT_PROFIT_TAKE_PCT)))
            : null,
          trailingStopPct: (toText(options.exitMode, DEFAULT_EXIT_MODE).toLowerCase() === 'trailing'
            || toText(options.exitMode, DEFAULT_EXIT_MODE).toLowerCase() === 'combined')
            ? Math.max(0.005, toNumber(options.trailingStopPct, DEFAULT_TRAILING_STOP_PCT))
            : null,
          assetClass: watchlist.getAssetClassForTicker(trade.ticker, 'us_equity'),
          timestamp: nextBar.timestamp,
        }, fillPrice)) {
          state.tradesToday += 1;
        }
      } else if (String(trade.consensus?.decision || '').toUpperCase() === 'SELL') {
        if (closePosition(state, trade.ticker, fillPrice, nextBar.timestamp, closedTrades, 'signal_exit')) {
          state.tradesToday += 1;
        }
      }
    }
  }

  const finalTimestamp = timeline[timeline.length - 1];
  const { snapshots: finalSnapshots } = buildStepContext(datasetIndex, symbols, timeline.length - 1, lookbackBars);
  const finalEquityBeforeLiquidation = markToMarketEquity(state, finalSnapshots);
  for (const position of [...state.positions]) {
    const finalSnapshot = finalSnapshots.get(position.ticker);
    const finalPrice = toNumber(finalSnapshot?.tradePrice ?? finalSnapshot?.dailyClose, 0);
    if (finalPrice > 0) {
      closePosition(state, position.ticker, finalPrice, finalTimestamp, closedTrades, 'final_mark');
    }
  }
  const finalEquity = roundCurrency(state.cash);
  const totalReturnPct = initialEquity > 0 ? Number(((finalEquity - initialEquity) / initialEquity).toFixed(4)) : 0;
  const wins = closedTrades.filter((trade) => trade.pnl > 0).length;
  const losses = closedTrades.filter((trade) => trade.pnl < 0).length;
  const winRate = closedTrades.length > 0 ? Number((wins / closedTrades.length).toFixed(4)) : 0;
  const sharpeRatio = computeSharpeRatio(equityCurve, interval);
  const maxDrawdownPct = computeMaxDrawdown(equityCurve);
  const bestTrade = closedTrades.reduce((best, trade) => (!best || trade.pnl > best.pnl ? trade : best), null);
  const worstTrade = closedTrades.reduce((worst, trade) => (!worst || trade.pnl < worst.pnl ? trade : worst), null);

  const summary = {
    runId,
    book,
    interval,
    period,
    symbols,
    lookbackBars,
    stepBars,
    initialEquity,
    finalEquity,
    finalEquityBeforeLiquidation,
    totalPnl: roundCurrency(finalEquity - initialEquity),
    totalReturnPct,
    closedTrades: closedTrades.length,
    wins,
    losses,
    winRate,
    maxDrawdownPct,
    sharpeRatio,
    bestTrade,
    worstTrade,
    macroRisk: {
      regime: options.dynamicMacro === true ? 'dynamic' : staticMacro.regime,
      strategyMode: options.dynamicMacro === true ? 'dynamic' : staticMacro.strategyMode,
      crisisType: options.dynamicMacro === true ? 'dynamic' : (staticMacro.crisisType || 'none'),
    },
    entryMode: toText(options.entryMode, DEFAULT_ENTRY_MODE).toLowerCase(),
    minAgreeConfidence: toNumber(options.minAgreeConfidence, DEFAULT_MIN_AGREE_CONFIDENCE),
    exitMode: toText(options.exitMode, DEFAULT_EXIT_MODE).toLowerCase(),
    profitTakePct: toNumber(options.profitTakePct, DEFAULT_PROFIT_TAKE_PCT),
    trailingStopPct: toNumber(options.trailingStopPct, DEFAULT_TRAILING_STOP_PCT),
    barsEvaluated: equityCurve.length,
    startedAt: timeline[lookbackBars - 1],
    endedAt: finalTimestamp,
    reportPath: path.join(runDir, 'report.json'),
  };

  const report = {
    summary,
    equityCurve,
    closedTrades,
    decisionLog,
  };
  fs.writeFileSync(summary.reportPath, JSON.stringify(report, null, 2));
  return report;
}

async function runWalkForwardBacktest(options = {}) {
  const book = toText(options.book, 'all').toLowerCase();
  const symbols = resolveBookSymbols(book, options.symbols);
  const dataset = options.dataset instanceof Map ? options.dataset : loadDataset(symbols, options);
  const timeline = Array.isArray(options.timeline) ? options.timeline : buildIntersectionTimeline(dataset);
  const lookbackBars = Math.max(5, Math.floor(toNumber(options.lookbackBars, DEFAULT_LOOKBACK_BARS)));
  const splitRatio = Math.min(0.95, Math.max(0.5, toNumber(options.splitRatio, 0.7)));
  const splitIndex = Math.max(lookbackBars + 1, Math.floor(timeline.length * splitRatio));

  if (timeline.length <= lookbackBars + 2 || splitIndex >= timeline.length - 1) {
    throw new Error(`Not enough timeline for walk-forward split. timeline=${timeline.length}, splitIndex=${splitIndex}`);
  }

  const trainTimeline = timeline.slice(0, splitIndex);
  const testTimeline = timeline.slice(Math.max(0, splitIndex - lookbackBars));
  const macroDataset = options.dynamicMacro === true
    ? (options.macroDataset instanceof Map
      ? options.macroDataset
      : loadOptionalDataset(options.macroProxySymbols || DEFAULT_MACRO_PROXY_SYMBOLS, options))
    : new Map();

  const train = await runBacktest({
    ...options,
    dataset,
    macroDataset,
    timeline: trainTimeline,
    walkForwardSegment: 'train',
  });
  const test = await runBacktest({
    ...options,
    dataset,
    macroDataset,
    timeline: testTimeline,
    walkForwardSegment: 'test',
  });

  return {
    splitRatio,
    splitIndex,
    splitTimestamp: timeline[splitIndex],
    lookbackBars,
    train: train.summary,
    test: test.summary,
  };
}

module.exports = {
  BOOK_SYMBOLS,
  DEFAULT_BACKTEST_SYMBOLS,
  DEFAULT_DATA_DIR,
  DEFAULT_INITIAL_EQUITY,
  DEFAULT_LOOKBACK_BARS,
  DEFAULT_MACRO_PROXY_SYMBOLS,
  DEFAULT_RUNTIME_DIR,
  DEFAULT_STEP_BARS,
  buildDynamicMacroRisk,
  buildIntersectionTimeline,
  buildPortfolioSnapshot,
  loadBarsFromCsv,
  loadDataset,
  loadOptionalDataset,
  resolveBacktestCsvPath,
  runBacktest,
  runWalkForwardBacktest,
  sourceTickerForSymbol,
  staticMacroRisk,
};
