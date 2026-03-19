'use strict';

const dataIngestion = require('./data-ingestion');
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
	const barsMap = await dataIngestion.getHistoricalBars({
		...options,
		symbols: normalizedSymbols,
		limit: 5,
		timeframe: '1Day',
	});

	const result = new Map();
	for (const ticker of normalizedSymbols) {
		const bars = barsMap instanceof Map ? (barsMap.get(ticker) || []) : (barsMap?.[ticker] || []);
		result.set(ticker, Array.isArray(bars) ? bars : []);
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
			result.set(ticker, bars);
		}
	}

	return result;
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

function getCryptoTrendDiagnostics(currentPrice, snapshot = {}, bars = [], assetConfig = ASSET_SIGNAL_CONFIG.crypto) {
	const closes = bars.map((bar) => toNumber(bar?.close, 0)).filter((value) => value > 0);
	const recentCloses = closes.slice(-3);
	const shortAvgClose = mean(recentCloses);
	const shortMomentumPct = shortAvgClose > 0 ? (currentPrice - shortAvgClose) / shortAvgClose : 0;
	const recentTrendPct = recentCloses.length >= 2 && recentCloses[0] > 0
		? (recentCloses[recentCloses.length - 1] - recentCloses[0]) / recentCloses[0]
		: 0;
	const intradayReference = toNumber(snapshot?.previousClose, 0) || toNumber(snapshot?.dailyClose, 0);
	const intradayPct = intradayReference > 0 ? (currentPrice - intradayReference) / intradayReference : 0;
	const directionalBiases = [
		getDirectionalBias(shortMomentumPct),
		getDirectionalBias(recentTrendPct),
		getDirectionalBias(intradayPct),
	].filter((value) => value !== 0);
	const positiveVotes = directionalBiases.filter((value) => value > 0).length;
	const negativeVotes = directionalBiases.filter((value) => value < 0).length;
	let dominantBias = 0;
	if (positiveVotes >= 2) dominantBias = 1;
	if (negativeVotes >= 2) dominantBias = -1;

	const alignmentStrength = dominantBias === 0
		? 0
		: clamp(
			(
				(Math.abs(shortMomentumPct) / Math.max(assetConfig.momentumDivisor, 0.0001))
				+ (Math.abs(recentTrendPct) / Math.max(assetConfig.momentumDivisor, 0.0001))
				+ (Math.abs(intradayPct) / Math.max(assetConfig.intradayMomentumDivisor, 0.0001))
			) / 3,
			0,
			1
		);
	const mixedSignals = positiveVotes > 0 && negativeVotes > 0;
	const chopPenalty = mixedSignals
		? clamp(
			(
				(Math.abs(shortMomentumPct) / Math.max(assetConfig.momentumDivisor, 0.0001))
				+ (Math.abs(recentTrendPct) / Math.max(assetConfig.momentumDivisor, 0.0001))
				+ (Math.abs(intradayPct) / Math.max(assetConfig.intradayMomentumDivisor, 0.0001))
			) / 4,
			0,
			1
		)
		: 0;
	const exhaustionPenalty = dominantBias !== 0 && getDirectionalBias(intradayPct) !== dominantBias
		? clamp(Math.abs(shortMomentumPct) / Math.max(assetConfig.momentumDivisor, 0.0001), 0, 1)
		: 0;

	return {
		shortMomentumPct,
		recentTrendPct,
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
		? getCryptoTrendDiagnostics(currentPrice, snapshot, bars, assetConfig)
		: {
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
				? `trend aligned higher across 3d/intraday (${(cryptoTrend.shortMomentumPct * 100).toFixed(1)}% / ${(cryptoTrend.intradayPct * 100).toFixed(1)}%)`
				: cryptoTrend.dominantBias < 0
					? `trend aligned lower across 3d/intraday (${(cryptoTrend.shortMomentumPct * 100).toFixed(1)}% / ${(cryptoTrend.intradayPct * 100).toFixed(1)}%)`
					: `mixed short-term crypto tape (${(cryptoTrend.shortMomentumPct * 100).toFixed(1)}% / ${(cryptoTrend.intradayPct * 100).toFixed(1)}%)`
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
	const symbols = dataIngestion.normalizeSymbols(
		Array.isArray(clientOptions.symbols) && clientOptions.symbols.length > 0
			? clientOptions.symbols
			: watchlist.getTickers({ assetClass: clientOptions.assetClass || clientOptions.asset_class })
	);
	const emptyPortfolio = Boolean(clientOptions.emptyPortfolio);

	const [snapshots, historicalBars, newsItems] = await Promise.all([
		dataIngestion.getWatchlistSnapshots({ ...clientOptions, symbols }),
		getHistoricalBarsWithFallback(clientOptions, symbols),
		getNormalizedNews({ ...clientOptions, symbols }),
	]);

	const newsByTicker = groupNewsByTicker(newsItems);

	return symbols.map((ticker) => {
		const snapshot = snapshots instanceof Map ? snapshots.get(ticker) : snapshots?.[ticker];
		const bars = historicalBars instanceof Map ? (historicalBars.get(ticker) || []) : (historicalBars?.[ticker] || []);
		const relatedNews = newsByTicker.get(ticker) || [];
		const signal = analyzeTicker(ticker, snapshot, bars, relatedNews, profile, {
			assetClass: resolveAssetClass(ticker),
			emptyPortfolio,
		});
		return {
			ticker: signal.ticker,
			direction: signal.direction,
			confidence: signal.confidence,
			reasoning: signal.reasoning,
		};
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
	scoreNewsForAsset,
	produceSignals,
	registerAllSignals,
};
