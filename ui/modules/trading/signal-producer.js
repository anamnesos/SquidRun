'use strict';

const dataIngestion = require('./data-ingestion');
const macroRiskGate = require('./macro-risk-gate');
const rangeStructure = require('./range-structure');
const watchlist = require('./watchlist');

const AGENT_PROFILES = Object.freeze({
	oracle: Object.freeze({
		momentumWeight: 0.25,
		newsWeight: 0.5,
		volumeWeight: 0.15,
		riskWeight: 0.1,
		buyThreshold: 0.12,
		sellThreshold: -0.2,
		convictionBias: 0.05,
	}),
	architect: Object.freeze({
		momentumWeight: 0.25,
		newsWeight: 0.2,
		volumeWeight: 0.1,
		riskWeight: 0.45,
		buyThreshold: 0.15,
		sellThreshold: -0.28,
		convictionBias: -0.03,
	}),
	builder: Object.freeze({
		momentumWeight: 0.45,
		newsWeight: 0.2,
		volumeWeight: 0.25,
		riskWeight: 0.1,
		buyThreshold: 0.10,
		sellThreshold: -0.18,
		convictionBias: 0.04,
	}),
});

const EMPTY_PORTFOLIO_BUY_BIAS = 0.08;
const DEFAULT_ASSET_CLASS = 'us_equity';
const ASSET_SIGNAL_CONFIG = Object.freeze({
	us_equity: Object.freeze({
		momentumDivisor: 0.03,
		volumeActivationRatio: 1.10,
		volumeScale: 1.5,
		riskMomentumDivisor: 0.08,
		riskRangeDivisor: 0.05,
		thresholdOffset: 0,
		trendWeight: 0,
		chopWeight: 0,
		exhaustionWeight: 0,
		intradayMomentumDivisor: 0.02,
	}),
	crypto: Object.freeze({
		momentumDivisor: 0.06,
		volumeActivationRatio: 1.03,
		volumeScale: 2.0,
		riskMomentumDivisor: 0.18,
		riskRangeDivisor: 0.12,
		thresholdOffset: 0.04,
		trendWeight: 0.22,
		chopWeight: 0.18,
		exhaustionWeight: 0.10,
		intradayMomentumDivisor: 0.045,
	}),
});

const POSITIVE_NEWS_TERMS = Object.freeze([
	'upgrade',
	'beat',
	'beats',
	'raise',
	'raised',
	'raises',
]);

const NEGATIVE_NEWS_TERMS = Object.freeze([
	'downgrade',
	'miss',
	'misses',
	'cut',
	'cuts',
	'lower',
	'lowered',
]);

const CRYPTO_POSITIVE_NEWS_TERMS = Object.freeze([
	'etf',
	'approval',
	'approved',
	'inflow',
	'inflows',
	'listing',
	'launch',
	'mainnet',
	'partnership',
	'adoption',
	'upgrade',
]);

const CRYPTO_NEGATIVE_NEWS_TERMS = Object.freeze([
	'hack',
	'exploit',
	'outflow',
	'outflows',
	'liquidation',
	'liquidations',
	'ban',
	'banned',
	'delay',
	'delayed',
	'reject',
	'rejected',
]);

function toAgentId(value) {
	const normalized = String(value || '').trim().toLowerCase();
	if (!AGENT_PROFILES[normalized]) {
		throw new Error(`Unsupported agentId: ${value}`);
	}
	return normalized;
}

function toTicker(value) {
	return String(value || '').trim().toUpperCase();
}

function toNumber(value, fallback = 0) {
	const numeric = Number(value);
	return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp(value, min, max) {
	return Math.max(min, Math.min(max, value));
}

function resolveAssetClass(ticker) {
	return watchlist.getAssetClassForTicker(ticker, DEFAULT_ASSET_CLASS);
}

function getAssetSignalConfig(assetClass) {
	return ASSET_SIGNAL_CONFIG[assetClass] || ASSET_SIGNAL_CONFIG.us_equity;
}

function mean(values = []) {
	const numeric = values
		.map((value) => Number(value))
		.filter((value) => Number.isFinite(value));
	if (numeric.length === 0) return 0;
	return numeric.reduce((sum, value) => sum + value, 0) / numeric.length;
}

function pickReferencePrice(snapshot = {}) {
	return [
		snapshot.tradePrice,
		snapshot.askPrice,
		snapshot.bidPrice,
		snapshot.minuteClose,
		snapshot.dailyClose,
		snapshot.previousClose,
	].map((value) => Number(value)).find((value) => Number.isFinite(value) && value > 0) || 0;
}

function groupNewsByTicker(newsItems = []) {
	const grouped = new Map();
	for (const item of newsItems) {
		const symbols = Array.isArray(item?.symbols) ? item.symbols : [];
		for (const symbol of symbols) {
			const ticker = toTicker(symbol);
			if (!ticker) continue;
			if (!grouped.has(ticker)) grouped.set(ticker, []);
			grouped.get(ticker).push(item);
		}
	}
	return grouped;
}

function groupDefiPositionsByTicker(defiStatus = {}) {
	const grouped = new Map();
	const positions = Array.isArray(defiStatus?.positions) ? defiStatus.positions : [];
	for (const position of positions) {
		const coin = String(position?.coin || '').trim().toUpperCase();
		if (!coin) continue;
		grouped.set(coin, position);
		grouped.set(`${coin}/USD`, position);
	}
	return grouped;
}

function appendReasoning(baseReasoning, suffix) {
	if (!suffix) return baseReasoning;
	const normalized = String(baseReasoning || '').trim();
	if (!normalized) return suffix;
	return `${normalized} ${suffix}`;
}

function toIsoTimestamp(value, fallback = null) {
	if (value == null || value === '') return fallback;
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) return fallback;
	return date.toISOString();
}

function attachBarsSourceMeta(bars = [], meta = {}) {
	const next = Array.isArray(bars) ? bars.slice() : [];
	next.sourceMeta = {
		source: String(meta.source || 'unknown'),
		primarySource: meta.primarySource ? String(meta.primarySource) : null,
		fallbackUsed: meta.fallbackUsed === true,
		primaryBarCount: Number.isFinite(Number(meta.primaryBarCount)) ? Number(meta.primaryBarCount) : null,
		barCount: next.length,
		observedAt: toIsoTimestamp(meta.observedAt, null),
		fetchedAt: toIsoTimestamp(meta.fetchedAt, new Date().toISOString()),
		stale: meta.stale === true,
		staleReason: meta.staleReason || null,
	};
	return next;
}

function applyBarsSourceContext(signal = {}, bars = []) {
	const sourceMeta = Array.isArray(bars) ? bars.sourceMeta : null;
	if (!sourceMeta) return signal;

	let nextConfidence = toNumber(signal.confidence, 0);
	const notes = [];

	if (sourceMeta.fallbackUsed === true) {
		nextConfidence = clamp(nextConfidence - 0.06, 0.4, 0.92);
		notes.push(`Daily bars were backfilled from Yahoo because primary broker history was thin (${toNumber(sourceMeta.primaryBarCount, 0)} primary bars).`);
	} else if (sourceMeta.stale === true) {
		nextConfidence = clamp(nextConfidence - 0.03, 0.4, 0.92);
		notes.push(`Primary daily bar history is degraded: ${String(sourceMeta.staleReason || 'unknown data quality issue').replace(/_/g, ' ')}.`);
	}

	if (notes.length === 0) return signal;
	return {
		...signal,
		confidence: Number(nextConfidence.toFixed(2)),
		reasoning: appendReasoning(signal.reasoning, notes.join(' ')),
		dataFreshness: {
			...(signal.dataFreshness || {}),
			bars: sourceMeta,
		},
	};
}

function applyDefiPositionContext(signal = {}, ticker, positionLookup = new Map()) {
	const matchedPosition = positionLookup.get(toTicker(ticker));
	if (!matchedPosition) {
		return signal;
	}

	const side = String(matchedPosition?.side || '').trim().toLowerCase();
	const warningLevel = String(matchedPosition?.warningLevel || '').trim().toLowerCase();
	const unrealizedPnl = toNumber(matchedPosition?.unrealizedPnl, 0);
	const peakUnrealizedPnl = toNumber(matchedPosition?.peakUnrealizedPnl, 0);
	const retainedPeakRatio = toNumber(matchedPosition?.retainedPeakRatio, 0);
	const positionNote = `Live Hyperliquid ${side || 'open'} ${matchedPosition.coin} position is at $${unrealizedPnl.toFixed(2)} unrealized P&L versus $${peakUnrealizedPnl.toFixed(2)} peak (${(retainedPeakRatio * 100).toFixed(0)}% retained).`;

	if ((warningLevel === 'warning' || warningLevel === 'urgent') && String(signal.direction || '').toUpperCase() === 'HOLD') {
		const suggestedDirection = side === 'short' ? 'SELL' : (side === 'long' ? 'BUY' : signal.direction);
		return {
			...signal,
			direction: suggestedDirection,
			confidence: Number(Math.max(toNumber(signal.confidence, 0), warningLevel === 'urgent' ? 0.79 : 0.69).toFixed(2)),
			reasoning: appendReasoning(signal.reasoning, `${positionNote} Profit giveback warning keeps the bias defensive.`),
		};
	}

	return {
		...signal,
		reasoning: appendReasoning(signal.reasoning, positionNote),
	};
}

async function getNormalizedNews(options = {}) {
	const symbols = dataIngestion.normalizeSymbols(
		Array.isArray(options.symbols) && options.symbols.length > 0
			? options.symbols
			: watchlist.getTickers({ assetClass: options.assetClass || options.asset_class })
	);
	const items = await dataIngestion.getNews({
		...options,
		symbols,
		limit: Math.max(20, symbols.length * 3),
	});
	return Array.isArray(items) ? items.map((item) => dataIngestion.normalizeNewsItem(item)) : [];
}

async function getHistoricalBarsWithFallback(options = {}, symbols = []) {
	const normalizedSymbols = symbols.map(toTicker).filter(Boolean);
	const fetchedAt = toIsoTimestamp(options.now, new Date().toISOString());
	const barsMap = await dataIngestion.getHistoricalBars({
		...options,
		symbols: normalizedSymbols,
		limit: 5,
		timeframe: '1Day',
	});

	const result = new Map();
	for (const ticker of normalizedSymbols) {
		const bars = barsMap instanceof Map ? (barsMap.get(ticker) || []) : (barsMap?.[ticker] || []);
		const normalizedBars = Array.isArray(bars) ? bars : [];
		result.set(ticker, attachBarsSourceMeta(normalizedBars, {
			source: 'primary_broker',
			primarySource: 'broker',
			fallbackUsed: false,
			primaryBarCount: normalizedBars.length,
			observedAt: normalizedBars[normalizedBars.length - 1]?.timestamp || null,
			fetchedAt,
			stale: normalizedBars.length < 3,
			staleReason: normalizedBars.length < 3 ? 'insufficient_primary_bars' : null,
		}));
	}

	const missing = normalizedSymbols.filter((ticker) => {
		return (result.get(ticker) || []).length < 3;
	});
	if (missing.length === 0) {
		return result;
	}

	const fallbackBars = await Promise.all(missing.map(async (ticker) => {
		try {
			const yahooTicker = ticker.includes('/') ? ticker.replace('/', '-') : ticker;
			const bars = await dataIngestion.getYahooHistoricalBars({
				ticker: yahooTicker,
				range: '5d',
				interval: '1d',
			});
			return [ticker, Array.isArray(bars) ? bars : []];
		} catch {
			return [ticker, result.get(ticker) || []];
		}
	}));

	for (const [ticker, bars] of fallbackBars) {
		if (Array.isArray(bars) && bars.length > 0) {
			const primaryBars = result.get(ticker) || [];
			result.set(ticker, attachBarsSourceMeta(bars, {
				source: 'yahoo_finance_fallback',
				primarySource: 'broker',
				fallbackUsed: true,
				primaryBarCount: Array.isArray(primaryBars) ? primaryBars.length : 0,
				observedAt: bars[bars.length - 1]?.timestamp || null,
				fetchedAt,
				stale: false,
				staleReason: 'primary_bars_incomplete_used_yahoo_fallback',
			}));
		}
	}

	return result;
}

async function getBarsForTimeframe(options = {}, symbols = [], timeframe = '1Day', limit = 30) {
	const normalizedSymbols = symbols.map(toTicker).filter(Boolean);
	if (normalizedSymbols.length === 0) {
		return new Map();
	}
	const barsMap = await dataIngestion.getHistoricalBars({
		...options,
		symbols: normalizedSymbols,
		limit,
		timeframe,
	}).catch(() => new Map());
	return dataIngestion.normalizeBarsMap(barsMap, normalizedSymbols);
}

function normalizeMultiTimeframeBars(rawBars = null, symbols = []) {
	const normalizedSymbols = symbols.map(toTicker).filter(Boolean);
	const result = new Map();
	for (const ticker of normalizedSymbols) {
		const entry = rawBars instanceof Map ? rawBars.get(ticker) : rawBars?.[ticker];
		result.set(ticker, {
			hourly: dataIngestion.normalizeBarsMap({ [ticker]: entry?.hourly || entry?.['1Hour'] || [] }, [ticker]).get(ticker) || [],
			fourHour: dataIngestion.normalizeBarsMap({ [ticker]: entry?.fourHour || entry?.['4Hour'] || [] }, [ticker]).get(ticker) || [],
			daily: dataIngestion.normalizeBarsMap({ [ticker]: entry?.daily || entry?.['1Day'] || [] }, [ticker]).get(ticker) || [],
		});
	}
	return result;
}

async function getCryptoMultiTimeframeBars(options = {}, symbols = []) {
	const normalizedSymbols = symbols.map(toTicker).filter(Boolean);
	if (normalizedSymbols.length === 0) {
		return new Map();
	}
	const [hourly, fourHour, daily] = await Promise.all([
		getBarsForTimeframe(options, normalizedSymbols, '1Hour', 48),
		getBarsForTimeframe(options, normalizedSymbols, '4Hour', 42),
		getBarsForTimeframe(options, normalizedSymbols, '1Day', 30),
	]);
	const result = new Map();
	for (const ticker of normalizedSymbols) {
		result.set(ticker, {
			hourly: hourly.get(ticker) || [],
			fourHour: fourHour.get(ticker) || [],
			daily: daily.get(ticker) || [],
		});
	}
	return result;
}

async function getRangeConvictionStructures(options = {}, symbols = []) {
	const normalizedSymbols = symbols.map(toTicker).filter(Boolean);
	if (normalizedSymbols.length === 0) {
		return new Map();
	}
	const [bars5m, bars15m, bars1h] = await Promise.all([
		getBarsForTimeframe(options, normalizedSymbols, '5Min', 72),
		getBarsForTimeframe(options, normalizedSymbols, '15Min', 48),
		getBarsForTimeframe(options, normalizedSymbols, '1Hour', 24),
	]);
	const result = new Map();
	for (const ticker of normalizedSymbols) {
		result.set(ticker, rangeStructure.analyzeRangeStructure({
			bars5m: bars5m.get(ticker) || [],
			bars15m: bars15m.get(ticker) || [],
			bars1h: bars1h.get(ticker) || [],
		}));
	}
	return result;
}

function analyzeRangeConvictionTicker(ticker, snapshot, profile, structure, options = {}) {
	const currentPrice = pickReferencePrice(snapshot) || toNumber(structure?.currentPrice, 0);
	const profileFloor = profile === AGENT_PROFILES.builder
		? 0.62
		: profile === AGENT_PROFILES.oracle
			? 0.68
			: 0.7;
	const biasBoost = profile === AGENT_PROFILES.builder ? 0.03 : 0;
	const longSetup = structure?.setups?.long
		? {
			...structure.setups.long,
			confidence: clamp(toNumber(structure.setups.long.confidence, 0) + biasBoost, 0, 1),
		}
		: null;
	const shortSetup = structure?.setups?.short
		? {
			...structure.setups.short,
			confidence: clamp(toNumber(structure.setups.short.confidence, 0) + biasBoost, 0, 1),
		}
		: null;
	const regime = String(structure?.regime || 'unknown').trim().toLowerCase();
	const mid = toNumber(structure?.mid, currentPrice);
	const ceilingDistancePct = toNumber(structure?.distanceToCeilingPct, 1);
	const floorDistancePct = toNumber(structure?.distanceToFloorPct, 1);
	const edgeThresholdPct = Math.max(toNumber(structure?.tolerancePct, 0) * 1.6, 0.006);
	const nearCeiling = ceilingDistancePct <= edgeThresholdPct;
	const nearFloor = floorDistancePct <= edgeThresholdPct;
	const longRegimeAllowed = !['breakout_down', 'trend_down'].includes(regime);
	const shortRegimeAllowed = !['breakout_up', 'trend_up'].includes(regime);
	const longContextAllowed = longRegimeAllowed && (
		nearFloor
		|| (!nearCeiling && currentPrice <= mid)
	);
	const shortContextAllowed = shortRegimeAllowed && (
		nearCeiling
		|| (!nearFloor && currentPrice >= mid)
	);
	const eligibleLongSetup = longContextAllowed ? longSetup : null;
	const eligibleShortSetup = shortContextAllowed ? shortSetup : null;
	let selectedSetup = null;
	if (eligibleLongSetup && eligibleShortSetup) {
		if (nearCeiling && !nearFloor) {
			selectedSetup = eligibleShortSetup;
		} else if (nearFloor && !nearCeiling) {
			selectedSetup = eligibleLongSetup;
		} else {
			selectedSetup = currentPrice >= mid ? eligibleShortSetup : eligibleLongSetup;
		}
	} else {
		selectedSetup = eligibleLongSetup || eligibleShortSetup || null;
	}

	let direction = 'HOLD';
	let confidence = 0.52;
	let reasoning = `Range conviction inactive: structure is ${structure?.regime || 'unknown'} around floor ${toNumber(structure?.floor, 0).toFixed(4)} and ceiling ${toNumber(structure?.ceiling, 0).toFixed(4)}.`;
	let invalidationPrice = null;
	let takeProfitPrice = null;
	let leverage = null;

	if (selectedSetup && toNumber(selectedSetup.confidence, 0) >= profileFloor) {
		direction = selectedSetup.direction;
		confidence = clamp(selectedSetup.confidence, 0.45, 0.93);
		invalidationPrice = toNumber(selectedSetup.invalidationPrice, 0) || null;
		takeProfitPrice = toNumber(selectedSetup.targetPrice, 0) || null;
		const distancePct = currentPrice > 0 && invalidationPrice > 0
			? Math.abs(currentPrice - invalidationPrice) / currentPrice
			: 0;
		leverage = clamp(
			Math.floor(1 / Math.max(distancePct * 2.2, 0.08)),
			2,
			10
		);
		reasoning = `Range conviction ${direction}: price ${currentPrice.toFixed(4)} is inside ${toNumber(structure?.floor, 0).toFixed(4)}-${toNumber(structure?.ceiling, 0).toFixed(4)}, ${selectedSetup.rationale} Context ${nearCeiling ? 'at_ceiling' : nearFloor ? 'at_floor' : regime}. Invalidation ${toNumber(invalidationPrice, 0).toFixed(4)}, target ${toNumber(takeProfitPrice, 0).toFixed(4)}.`;
	}

	return {
		ticker,
		direction,
		confidence: Number(confidence.toFixed(2)),
		reasoning,
		invalidationPrice,
		takeProfitPrice,
		leverage: leverage ? Math.floor(leverage) : null,
		strategyMode: 'range_conviction',
		rangeStructure: structure || null,
		metrics: {
			currentPrice: Number(currentPrice.toFixed(4)),
			assetClass: 'crypto',
			rangeFloor: Number(toNumber(structure?.floor, 0).toFixed(4)),
			rangeCeiling: Number(toNumber(structure?.ceiling, 0).toFixed(4)),
			rangeMid: Number(toNumber(structure?.mid, 0).toFixed(4)),
			rangeWidthPct: Number(toNumber(structure?.widthPct, 0).toFixed(6)),
			ceilingRejections: toNumber(structure?.ceilingRejections, 0),
			floorRejections: toNumber(structure?.floorRejections, 0),
			regime: structure?.regime || 'unknown',
		},
	};
}

function scoreNews(newsItems = []) {
	return scoreNewsForAsset(newsItems, DEFAULT_ASSET_CLASS);
}

function scoreNewsForAsset(newsItems = [], assetClass = DEFAULT_ASSET_CLASS) {
	let positiveHits = 0;
	let negativeHits = 0;
	const matchedTerms = [];
	const positiveTerms = assetClass === 'crypto'
		? [...POSITIVE_NEWS_TERMS, ...CRYPTO_POSITIVE_NEWS_TERMS]
		: POSITIVE_NEWS_TERMS;
	const negativeTerms = assetClass === 'crypto'
		? [...NEGATIVE_NEWS_TERMS, ...CRYPTO_NEGATIVE_NEWS_TERMS]
		: NEGATIVE_NEWS_TERMS;

	for (const item of newsItems) {
		const haystack = `${item?.headline || ''} ${item?.summary || ''}`.toLowerCase();
		for (const term of positiveTerms) {
			if (haystack.includes(term)) {
				positiveHits += 1;
				matchedTerms.push(term);
			}
		}
		for (const term of negativeTerms) {
			if (haystack.includes(term)) {
				negativeHits += 1;
				matchedTerms.push(term);
			}
		}
	}

	const denominator = Math.max(1, positiveHits + negativeHits);
	return {
		score: clamp((positiveHits - negativeHits) / denominator, -1, 1),
		positiveHits,
		negativeHits,
		terms: Array.from(new Set(matchedTerms)).slice(0, 4),
	};
}

function getDirectionalBias(value) {
	if (value > 0.0025) return 1;
	if (value < -0.0025) return -1;
	return 0;
}

function computeWindowMomentumPct(bars = [], currentPrice = 0, lookback = 6) {
	const closes = (Array.isArray(bars) ? bars : [])
		.map((bar) => toNumber(bar?.close, 0))
		.filter((value) => value > 0);
	const window = closes.slice(-lookback);
	const baseline = mean(window);
	return baseline > 0 && currentPrice > 0 ? (currentPrice - baseline) / baseline : 0;
}

function computeSeriesTrendPct(bars = [], lookback = 6) {
	const closes = (Array.isArray(bars) ? bars : [])
		.map((bar) => toNumber(bar?.close, 0))
		.filter((value) => value > 0)
		.slice(-lookback);
	return closes.length >= 2 && closes[0] > 0
		? (closes[closes.length - 1] - closes[0]) / closes[0]
		: 0;
}

function getCryptoTrendDiagnostics(
	currentPrice,
	snapshot = {},
	bars = [],
	assetConfig = ASSET_SIGNAL_CONFIG.crypto,
	timeframeBars = null
) {
	const hourlyBars = Array.isArray(timeframeBars?.hourly) && timeframeBars.hourly.length > 0
		? timeframeBars.hourly
		: bars;
	const fourHourBars = Array.isArray(timeframeBars?.fourHour) && timeframeBars.fourHour.length > 0
		? timeframeBars.fourHour
		: bars;
	const dailyBars = Array.isArray(timeframeBars?.daily) && timeframeBars.daily.length > 0
		? timeframeBars.daily
		: bars;
	const hourlyMomentumPct = computeWindowMomentumPct(hourlyBars, currentPrice, 6);
	const fourHourTrendPct = computeSeriesTrendPct(fourHourBars, 6);
	const dailyTrendPct = computeSeriesTrendPct(dailyBars, 5);
	const intradayReference = toNumber(snapshot?.previousClose, 0) || toNumber(snapshot?.dailyClose, 0);
	const intradayPct = intradayReference > 0 ? (currentPrice - intradayReference) / intradayReference : 0;
	const directionalBiases = [
		getDirectionalBias(hourlyMomentumPct),
		getDirectionalBias(fourHourTrendPct),
		getDirectionalBias(dailyTrendPct),
		getDirectionalBias(intradayPct),
	].filter((value) => value !== 0);
	const positiveVotes = directionalBiases.filter((value) => value > 0).length;
	const negativeVotes = directionalBiases.filter((value) => value < 0).length;
	let dominantBias = 0;
	if (positiveVotes >= 3 || (positiveVotes >= 2 && positiveVotes > negativeVotes)) dominantBias = 1;
	if (negativeVotes >= 3 || (negativeVotes >= 2 && negativeVotes > positiveVotes)) dominantBias = -1;

	const alignmentStrength = dominantBias === 0
		? 0
		: clamp(
			(
				(Math.abs(hourlyMomentumPct) / Math.max(assetConfig.intradayMomentumDivisor, 0.0001))
				+ (Math.abs(fourHourTrendPct) / Math.max(assetConfig.momentumDivisor, 0.0001))
				+ (Math.abs(dailyTrendPct) / Math.max(assetConfig.momentumDivisor, 0.0001))
				+ (Math.abs(intradayPct) / Math.max(assetConfig.intradayMomentumDivisor, 0.0001))
			) / 4,
			0,
			1
		);
	const mixedSignals = positiveVotes > 0 && negativeVotes > 0;
	const chopPenalty = mixedSignals
		? clamp(
			(
				(Math.abs(hourlyMomentumPct) / Math.max(assetConfig.intradayMomentumDivisor, 0.0001))
				+ (Math.abs(fourHourTrendPct) / Math.max(assetConfig.momentumDivisor, 0.0001))
				+ (Math.abs(dailyTrendPct) / Math.max(assetConfig.momentumDivisor, 0.0001))
				+ (Math.abs(intradayPct) / Math.max(assetConfig.intradayMomentumDivisor, 0.0001))
			) / 5,
			0,
			1
		)
		: 0;
	const exhaustionPenalty = dominantBias !== 0
		&& getDirectionalBias(hourlyMomentumPct) !== dominantBias
		&& getDirectionalBias(intradayPct) !== dominantBias
		? clamp(Math.abs(hourlyMomentumPct) / Math.max(assetConfig.intradayMomentumDivisor, 0.0001), 0, 1)
		: 0;

	return {
		hourlyMomentumPct,
		fourHourTrendPct,
		dailyTrendPct,
		shortMomentumPct: hourlyMomentumPct,
		recentTrendPct: fourHourTrendPct,
		intradayPct,
		dominantBias,
		alignmentStrength,
		chopPenalty,
		exhaustionPenalty,
	};
}

function analyzeTicker(ticker, snapshot, bars = [], newsItems = [], profile, options = {}) {
	const assetClass = options.assetClass || resolveAssetClass(ticker);
	const assetConfig = getAssetSignalConfig(assetClass);
	let currentPrice = pickReferencePrice(snapshot);
	const closes = bars.map((bar) => toNumber(bar?.close, 0)).filter((value) => value > 0);
	if (!(currentPrice > 0) && closes.length > 0) {
		currentPrice = closes[closes.length - 1];
	}
	const volumes = bars.map((bar) => toNumber(bar?.volume, 0)).filter((value) => value > 0);
	const avgClose = mean(closes);
	const avgVolume = mean(volumes);
	const momentumPct = avgClose > 0 ? (currentPrice - avgClose) / avgClose : 0;
	const momentumScore = clamp(momentumPct / assetConfig.momentumDivisor, -1, 1);
	const volumeRatio = avgVolume > 0 ? toNumber(snapshot?.dailyVolume, avgVolume) / avgVolume : 1;
	const volumeScore = momentumScore === 0 || volumeRatio < assetConfig.volumeActivationRatio
		? 0
		: clamp((volumeRatio - 1) / assetConfig.volumeScale, 0, 1) * Math.sign(momentumScore);
	const avgRangePct = mean(
		bars.map((bar) => {
			const high = toNumber(bar?.high, 0);
			const low = toNumber(bar?.low, 0);
			const close = toNumber(bar?.close, 0);
			return close > 0 && high >= low ? (high - low) / close : 0;
		})
	);
	const riskPenalty = clamp(
		((Math.abs(momentumPct) / assetConfig.riskMomentumDivisor) * 0.45)
		+ ((avgRangePct / assetConfig.riskRangeDivisor) * 0.55),
		0,
		1
	);
	const newsScore = scoreNewsForAsset(newsItems, assetClass);
	const cryptoTrend = assetClass === 'crypto'
		? getCryptoTrendDiagnostics(currentPrice, snapshot, bars, assetConfig, options.timeframeBars)
		: {
			hourlyMomentumPct: 0,
			fourHourTrendPct: 0,
			dailyTrendPct: 0,
			shortMomentumPct: 0,
			recentTrendPct: 0,
			intradayPct: 0,
			dominantBias: 0,
			alignmentStrength: 0,
			chopPenalty: 0,
			exhaustionPenalty: 0,
		};

	let compositeScore = (
		(momentumScore * profile.momentumWeight)
		+ (newsScore.score * profile.newsWeight)
		+ (volumeScore * profile.volumeWeight)
		- (riskPenalty * profile.riskWeight)
	);
	if (assetClass === 'crypto') {
		compositeScore += (cryptoTrend.dominantBias * cryptoTrend.alignmentStrength * assetConfig.trendWeight);
		compositeScore -= (cryptoTrend.chopPenalty * assetConfig.chopWeight);
		compositeScore -= (cryptoTrend.exhaustionPenalty * assetConfig.exhaustionWeight);
	}
	compositeScore += profile.convictionBias * (
		profile === AGENT_PROFILES.oracle
			? newsScore.score
			: profile === AGENT_PROFILES.builder
				? momentumScore
				: -riskPenalty
	);

	if (options.emptyPortfolio) {
		compositeScore += EMPTY_PORTFOLIO_BUY_BIAS;
	}

	compositeScore = clamp(compositeScore, -1, 1);

	let direction = 'HOLD';
	const buyThreshold = profile.buyThreshold + assetConfig.thresholdOffset;
	const sellThreshold = profile.sellThreshold - assetConfig.thresholdOffset;
	if (compositeScore >= buyThreshold) {
		direction = 'BUY';
	} else if (compositeScore <= sellThreshold) {
		direction = 'SELL';
	}

	const confidence = clamp(
		0.48
		+ (Math.abs(compositeScore) * 0.3)
		+ (Math.min(Math.abs(newsScore.score), 1) * 0.08)
		+ (Math.min(Math.abs(volumeScore), 1) * 0.06),
		0.4,
		0.92
	);
	const adjustedConfidence = assetClass === 'crypto'
		? clamp(
			confidence
			+ (cryptoTrend.alignmentStrength * 0.06)
			- (cryptoTrend.chopPenalty * 0.07)
			- (cryptoTrend.exhaustionPenalty * 0.04),
			0.4,
			0.92
		)
		: confidence;

	const momentumText = avgClose > 0
		? `${momentumPct >= 0 ? 'above' : 'below'} 5d avg by ${(Math.abs(momentumPct) * 100).toFixed(1)}%`
		: '5d average unavailable';
	const volumeText = avgVolume > 0
		? `${volumeRatio.toFixed(2)}x normal volume`
		: 'normal volume';
	let newsText = 'neutral news flow';
	if (newsScore.positiveHits > newsScore.negativeHits) {
		newsText = `positive news (${newsScore.terms.join('/') || (assetClass === 'crypto' ? 'etf/inflow/listing' : 'upgrade/beat/raise')})`;
	} else if (newsScore.negativeHits > newsScore.positiveHits) {
		newsText = `negative news (${newsScore.terms.join('/') || (assetClass === 'crypto' ? 'hack/outflow/liquidation' : 'downgrade/miss/cut')})`;
	}
	const cryptoTrendText = assetClass === 'crypto'
		? (
			cryptoTrend.dominantBias > 0
				? `trend aligned higher across 1h/4h/daily (${(cryptoTrend.hourlyMomentumPct * 100).toFixed(1)}% / ${(cryptoTrend.fourHourTrendPct * 100).toFixed(1)}% / ${(cryptoTrend.dailyTrendPct * 100).toFixed(1)}%)`
				: cryptoTrend.dominantBias < 0
					? `trend aligned lower across 1h/4h/daily (${(cryptoTrend.hourlyMomentumPct * 100).toFixed(1)}% / ${(cryptoTrend.fourHourTrendPct * 100).toFixed(1)}% / ${(cryptoTrend.dailyTrendPct * 100).toFixed(1)}%)`
					: `mixed 1h/4h/daily crypto tape (${(cryptoTrend.hourlyMomentumPct * 100).toFixed(1)}% / ${(cryptoTrend.fourHourTrendPct * 100).toFixed(1)}% / ${(cryptoTrend.dailyTrendPct * 100).toFixed(1)}%)`
		)
		: '';

	let reasoning = `${momentumText}, ${volumeText}, ${newsText}.`;
	if (direction === 'BUY') {
		reasoning = assetClass === 'crypto'
			? `${momentumText}, ${cryptoTrendText}, ${volumeText}, ${newsText}; bias resolves to BUY.`
			: `${momentumText}, ${volumeText}, ${newsText}; bias resolves to BUY.`;
	} else if (direction === 'SELL') {
		reasoning = assetClass === 'crypto'
			? `${momentumText}, ${cryptoTrendText}, ${volumeText}, ${newsText}; bias resolves to SELL.`
			: `${momentumText}, ${volumeText}, ${newsText}; bias resolves to SELL.`;
	} else if (assetClass === 'crypto' && (cryptoTrend.chopPenalty > 0.25 || cryptoTrend.exhaustionPenalty > 0.25)) {
		reasoning = `${momentumText}, ${cryptoTrendText}, ${volumeText}, ${newsText}, but conflicting crypto trend structure keeps it HOLD.`;
	} else if (riskPenalty > 0.55) {
		reasoning = `${momentumText}, ${volumeText}, ${newsText}, but elevated short-term risk keeps it HOLD.`;
	}

	return {
		ticker,
		direction,
		confidence: Number(adjustedConfidence.toFixed(2)),
		reasoning,
		metrics: {
			currentPrice: Number(currentPrice.toFixed(2)),
			avgClose: Number(avgClose.toFixed(2)),
			momentumPct: Number(momentumPct.toFixed(4)),
			volumeRatio: Number(volumeRatio.toFixed(2)),
			riskPenalty: Number(riskPenalty.toFixed(2)),
			newsScore: Number(newsScore.score.toFixed(2)),
			assetClass,
			hourlyMomentumPct: Number(cryptoTrend.hourlyMomentumPct.toFixed(4)),
			fourHourTrendPct: Number(cryptoTrend.fourHourTrendPct.toFixed(4)),
			dailyTrendPct: Number(cryptoTrend.dailyTrendPct.toFixed(4)),
			shortMomentumPct: Number(cryptoTrend.shortMomentumPct.toFixed(4)),
			recentTrendPct: Number(cryptoTrend.recentTrendPct.toFixed(4)),
			intradayPct: Number(cryptoTrend.intradayPct.toFixed(4)),
			trendAlignment: Number(cryptoTrend.alignmentStrength.toFixed(2)),
			chopPenalty: Number(cryptoTrend.chopPenalty.toFixed(2)),
			exhaustionPenalty: Number(cryptoTrend.exhaustionPenalty.toFixed(2)),
		},
	};
}

async function produceSignals(agentId, alpacaClientOrOptions) {
	const normalizedAgent = toAgentId(agentId);
	const profile = AGENT_PROFILES[normalizedAgent];
	const isOptions = alpacaClientOrOptions && typeof alpacaClientOrOptions === 'object' && !alpacaClientOrOptions.getAccount;
	const clientOptions = isOptions ? alpacaClientOrOptions : (alpacaClientOrOptions ? { client: alpacaClientOrOptions } : {});
	const macroRisk = clientOptions.macroRisk || null;
	const providedSnapshots = clientOptions.snapshots || clientOptions.paperTradingContext?.snapshots || null;
	const providedBars = clientOptions.bars || clientOptions.paperTradingContext?.bars || null;
	const providedMultiTimeframeBars = clientOptions.multiTimeframeBars || clientOptions.paperTradingContext?.multiTimeframeBars || null;
	const providedRangeStructures = clientOptions.rangeStructures || clientOptions.paperTradingContext?.rangeStructures || null;
	const providedNews = clientOptions.news || clientOptions.paperTradingContext?.news || null;
	const providedDefiStatus = clientOptions.defiStatus || clientOptions.liveTradingContext || null;
	const strategyMode = String(clientOptions.strategyMode || '').trim().toLowerCase();
	const symbols = dataIngestion.normalizeSymbols(
		Array.isArray(clientOptions.symbols) && clientOptions.symbols.length > 0
			? clientOptions.symbols
			: watchlist.getTickers({ assetClass: clientOptions.assetClass || clientOptions.asset_class })
	);
	const emptyPortfolio = Boolean(clientOptions.emptyPortfolio);
	const hasProvidedSnapshots = providedSnapshots instanceof Map
		? providedSnapshots.size > 0
		: Boolean(providedSnapshots && typeof providedSnapshots === 'object' && Object.keys(providedSnapshots).length > 0);
	const hasProvidedBars = providedBars instanceof Map
		? providedBars.size > 0
		: Boolean(providedBars && typeof providedBars === 'object' && Object.keys(providedBars).length > 0);
	const hasProvidedMultiTimeframeBars = providedMultiTimeframeBars instanceof Map
		? providedMultiTimeframeBars.size > 0
		: Boolean(providedMultiTimeframeBars && typeof providedMultiTimeframeBars === 'object' && Object.keys(providedMultiTimeframeBars).length > 0);
	const hasProvidedRangeStructures = providedRangeStructures instanceof Map
		? providedRangeStructures.size > 0
		: Boolean(providedRangeStructures && typeof providedRangeStructures === 'object' && Object.keys(providedRangeStructures).length > 0);
	const hasProvidedNews = Array.isArray(providedNews);
	const cryptoSymbols = symbols.filter((ticker) => resolveAssetClass(ticker) === 'crypto');

	const [snapshots, historicalBars, newsItems, multiTimeframeBars, rangeStructures] = await Promise.all([
		hasProvidedSnapshots
			? Promise.resolve(dataIngestion.normalizeSnapshotCollection(providedSnapshots, symbols))
			: dataIngestion.getWatchlistSnapshots({ ...clientOptions, symbols }),
		hasProvidedBars
			? Promise.resolve(dataIngestion.normalizeBarsMap(providedBars, symbols))
			: getHistoricalBarsWithFallback(clientOptions, symbols),
		hasProvidedNews
			? Promise.resolve((providedNews || []).map((item) => dataIngestion.normalizeNewsItem(item)))
			: getNormalizedNews({ ...clientOptions, symbols }),
		cryptoSymbols.length === 0
			? Promise.resolve(new Map())
			: (hasProvidedMultiTimeframeBars
				? Promise.resolve(normalizeMultiTimeframeBars(providedMultiTimeframeBars, cryptoSymbols))
				: getCryptoMultiTimeframeBars(clientOptions, cryptoSymbols)),
		(strategyMode !== 'range_conviction' || cryptoSymbols.length === 0)
			? Promise.resolve(new Map())
			: (hasProvidedRangeStructures
				? Promise.resolve(providedRangeStructures)
				: getRangeConvictionStructures(clientOptions, cryptoSymbols)),
	]);

	const newsByTicker = groupNewsByTicker(newsItems);
	const defiPositionLookup = groupDefiPositionsByTicker(providedDefiStatus);

	return symbols.map((ticker) => {
		const snapshot = snapshots instanceof Map ? snapshots.get(ticker) : snapshots?.[ticker];
		const bars = historicalBars instanceof Map ? (historicalBars.get(ticker) || []) : (historicalBars?.[ticker] || []);
		const timeframeBars = multiTimeframeBars instanceof Map ? (multiTimeframeBars.get(ticker) || null) : null;
		const relatedNews = newsByTicker.get(ticker) || [];
		const assetClass = resolveAssetClass(ticker);
		const convictionStructure = rangeStructures instanceof Map ? (rangeStructures.get(ticker) || null) : null;
		const signal = strategyMode === 'range_conviction' && assetClass === 'crypto'
			? analyzeRangeConvictionTicker(ticker, snapshot, profile, convictionStructure, {
				emptyPortfolio,
			})
			: analyzeTicker(ticker, snapshot, bars, relatedNews, profile, {
				assetClass,
				emptyPortfolio,
				timeframeBars,
			});
		const enrichedSignal = applyDefiPositionContext(signal, ticker, defiPositionLookup);
		const dataAwareSignal = applyBarsSourceContext(enrichedSignal, bars);
		return macroRiskGate.applyMacroRiskToSignal({
			ticker: dataAwareSignal.ticker,
			direction: dataAwareSignal.direction,
			confidence: dataAwareSignal.confidence,
			reasoning: dataAwareSignal.reasoning,
			invalidationPrice: dataAwareSignal.invalidationPrice,
			takeProfitPrice: dataAwareSignal.takeProfitPrice,
			leverage: dataAwareSignal.leverage,
			strategyMode: dataAwareSignal.strategyMode,
			rangeStructure: dataAwareSignal.rangeStructure,
			dataFreshness: dataAwareSignal.dataFreshness,
		}, macroRisk);
	});
}

function registerAllSignals(orchestrator, agentId, signals = []) {
	if (!orchestrator || typeof orchestrator.registerSignal !== 'function') {
		throw new Error('orchestrator.registerSignal is required');
	}

	const normalizedAgent = toAgentId(agentId);
	if (!Array.isArray(signals)) {
		throw new Error('signals must be an array');
	}

	return signals.map((signal) => {
		return orchestrator.registerSignal(normalizedAgent, signal.ticker, signal);
	});
}

module.exports = {
	analyzeTicker,
	analyzeRangeConvictionTicker,
	applyBarsSourceContext,
	getHistoricalBarsWithFallback,
	scoreNewsForAsset,
	produceSignals,
	registerAllSignals,
};
