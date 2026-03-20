'use strict';

const path = require('path');

const { getProjectRoot } = require('../../config');
const dataIngestion = require('./data-ingestion');
const watchlist = require('./watchlist');
const dynamicWatchlist = require('./dynamic-watchlist');
const consensus = require('./consensus');
const agentAttribution = require('./agent-attribution');
const consultationStore = require('./consultation-store');
const riskEngine = require('./risk-engine');
const executor = require('./executor');
const journal = require('./journal');
const polymarketScanner = require('./polymarket-scanner');
const polymarketSignals = require('./polymarket-signals');
const polymarketSizer = require('./polymarket-sizer');
const portfolioTracker = require('./portfolio-tracker');
const tradingScheduler = require('./scheduler');
const signalProducer = require('./signal-producer');
const telegramSummary = require('./telegram-summary');
const yieldRouterModule = require('./yield-router');

const REQUIRED_AGENTS = Object.freeze(['architect', 'builder', 'oracle']);
const DEFAULT_MODELS = Object.freeze({
	architect: 'claude',
	builder: 'gpt',
	oracle: 'gemini',
});
const DEFAULT_PROFIT_TARGET_PCT = 0.05;
const DEFAULT_RECENT_TRADE_SCAN = 250;
const DEFAULT_ACTIVE_TRADING_RATIO = 0.4;
const DEFAULT_YIELD_ROUTER_RATIO = yieldRouterModule.DEFAULT_YIELD_TARGET_RATIO || 0.35;
const DEFAULT_RESERVE_RATIO = yieldRouterModule.DEFAULT_RESERVE_RATIO || 0.2;
const DEFAULT_LAUNCH_RADAR_RATIO = yieldRouterModule.DEFAULT_LAUNCH_RADAR_ALLOCATION_RATIO || 0.05;

function toTicker(value) {
	return String(value || '').trim().toUpperCase();
}

function toAgentId(value) {
	const normalized = String(value || '').trim().toLowerCase();
	if (!REQUIRED_AGENTS.includes(normalized)) {
		throw new Error(`Unsupported agentId: ${value}`);
	}
	return normalized;
}

function toDirection(value) {
	const normalized = String(value || '').trim().toUpperCase();
	if (!['BUY', 'SELL', 'HOLD'].includes(normalized)) {
		throw new Error(`Unsupported signal direction: ${value}`);
	}
	return normalized;
}

function toConfidence(value) {
	const numeric = Number(value);
	if (!Number.isFinite(numeric)) return 0;
	return Math.max(0, Math.min(1, numeric));
}

function toDateKey(value = new Date()) {
	const date = value instanceof Date ? value : new Date(value);
	return date.toISOString().slice(0, 10);
}

function toNumber(value, fallback = 0) {
	const numeric = Number(value);
	return Number.isFinite(numeric) ? numeric : fallback;
}

function toPositiveInteger(value) {
	const numeric = Math.floor(Number(value));
	return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

function toPositiveQuantity(value, assetClass = 'us_equity') {
	const numeric = Number(value);
	if (!Number.isFinite(numeric) || numeric <= 0) return 0;
	const normalizedAssetClass = watchlist.normalizeAssetClass(assetClass);
	if (normalizedAssetClass === 'crypto') {
		return Number(numeric.toFixed(6));
	}
	if (normalizedAssetClass === 'prediction_market') {
		return Number(numeric.toFixed(4));
	}
	return toPositiveInteger(numeric);
}

function resolveAssetClassForTicker(ticker, fallback = 'us_equity') {
	return watchlist.getAssetClassForTicker(ticker, fallback);
}

function isPolymarketMode(options = {}) {
	const explicit = String(options.broker || options.marketType || options.market_type || '').trim().toLowerCase();
	if (explicit === 'polymarket') return true;
	return String(options.assetClass || options.asset_class || '').trim().toLowerCase() === 'prediction_market';
}

function toJournalDecision(value) {
	const normalized = String(value || '').trim().toUpperCase();
	if (normalized === 'BUY_YES') return 'BUY';
	if (normalized === 'BUY_NO') return 'SELL';
	return toDirection(normalized);
}

function resolveSmartMoneyAssetClass(signal = {}) {
	return String(signal.chain || '').trim().toLowerCase() === 'solana' ? 'solana_token' : 'crypto';
}

function resolveSmartMoneyExchange(signal = {}) {
	return String(signal.chain || '').trim().toLowerCase() === 'solana' ? 'SOLANA' : 'CRYPTO';
}

function buildSmartMoneyReason(signal = {}) {
	const wallets = toPositiveInteger(signal.walletCount || signal.wallets?.length || 0);
	const totalUsdValue = Math.round(toNumber(signal.totalUsdValue, 0));
	const chain = String(signal.chain || 'unknown').trim().toUpperCase();
	return `Wallet convergence: ${wallets} wallets on ${chain}, ~$${totalUsdValue.toLocaleString('en-US')} total flow`;
}

function resolveLaunchRadarExchange(token = {}) {
	const chain = String(token.chain || 'solana').trim().toLowerCase();
	return chain === 'base' ? 'BASE' : 'SOLANA';
}

function buildLaunchRadarReason(token = {}) {
	const chain = String(token.chain || 'unknown').trim().toUpperCase();
	const liquidityUsd = Math.round(toNumber(token.liquidityUsd, 0));
	const holders = toPositiveInteger(token.holders || token.holderCount || 0);
	const recommendation = String(token.audit?.recommendation || 'proceed').trim().toLowerCase();
	return `Launch radar: ${chain} token with ~$${liquidityUsd.toLocaleString('en-US')} liquidity, ${holders} holders, audit=${recommendation}`;
}

function resolveLaunchRadarExpiryDays(value) {
	const numeric = toPositiveInteger(value);
	return numeric > 0 ? numeric : 7;
}

function roundCurrency(value) {
	return Number(toNumber(value, 0).toFixed(2));
}

function sumSnapshotEquity(snapshot, marketKeys = []) {
	return roundCurrency(marketKeys.reduce((sum, key) => {
		return sum + toNumber(snapshot?.markets?.[key]?.equity, 0);
	}, 0));
}

function buildCapitalRatios(options = {}) {
	const activeTrading = Math.max(0, toConfidence(options.activeTradingRatio ?? options.activeRatio ?? DEFAULT_ACTIVE_TRADING_RATIO));
	const yieldCapital = Math.max(0, toConfidence(options.yieldRatio ?? options.yieldRouterRatio ?? DEFAULT_YIELD_ROUTER_RATIO));
	const reserve = Math.max(0, toConfidence(options.reserveRatio ?? DEFAULT_RESERVE_RATIO));
	const launchRadar = Math.max(0, toConfidence(options.launchRadarRatio ?? DEFAULT_LAUNCH_RADAR_RATIO));
	return {
		activeTrading,
		yield: yieldCapital,
		reserve,
		launchRadar,
		total: Number((activeTrading + yieldCapital + reserve + launchRadar).toFixed(6)),
	};
}

function estimateTradeCapitalRequirement(trades = []) {
	return roundCurrency(trades.reduce((sum, trade) => {
		if (String(trade?.consensus?.decision || '').trim().toUpperCase() !== 'BUY') {
			return sum;
		}
		const shares = toNumber(trade?.riskCheck?.maxShares, 0);
		const price = toNumber(trade?.referencePrice, 0);
		if (shares <= 0 || price <= 0) return sum;
		return sum + (shares * price);
	}, 0));
}

function normalizeBrokerOrderStatus(value) {
	const normalized = String(value || '').trim().toLowerCase();
	if (!normalized) return 'PENDING_NEW';
	if (['accepted', 'pending_new', 'pending', 'new', 'accepted_for_bidding', 'held', 'calculated'].includes(normalized)) {
		return 'PENDING_NEW';
	}
	if (normalized === 'partially_filled') {
		return 'PARTIALLY_FILLED';
	}
	if (normalized === 'filled') {
		return 'FILLED';
	}
	if (['canceled', 'cancelled', 'done_for_day', 'expired', 'stopped', 'suspended'].includes(normalized)) {
		return 'CANCELLED';
	}
	if (['replaced', 'rejected'].includes(normalized)) {
		return 'REJECTED';
	}
	return String(value || '').trim().toUpperCase();
}

function resolveTradeAssetClass(trade = {}) {
	return resolveAssetClassForTicker(trade.ticker, 'us_equity');
}

function resolveTradeMarketType(assetClass = 'us_equity') {
	if (assetClass === 'prediction_market') return 'polymarket';
	if (assetClass === 'crypto') return 'crypto';
	if (assetClass === 'solana_token') return 'solana';
	if (assetClass === 'defi_yield') return 'defi';
	return 'stocks';
}

function getOrderFilledQuantity(order = {}) {
	return toNumber(
		order.filledQty
		?? order.filled_qty
		?? order.qty
		?? order.raw?.filled_qty,
		0
	);
}

function getOrderFilledPrice(order = {}) {
	return toNumber(
		order.filledAvgPrice
		?? order.filled_avg_price
		?? order.raw?.filled_avg_price
		?? order.raw?.average_fill_price,
		0
	);
}

function getOrderFilledTimestamp(order = {}, fallback = new Date().toISOString()) {
	const filledAt = order.raw?.filled_at
		|| order.raw?.updated_at
		|| order.raw?.timestamp
		|| order.updated_at
		|| order.timestamp
		|| fallback;
	const normalized = new Date(filledAt);
	return Number.isNaN(normalized.getTime()) ? fallback : normalized.toISOString();
}

function buildOpenPositionTickerSet(positions = []) {
	return new Set(
		(Array.isArray(positions) ? positions : [])
			.map((position) => toTicker(position?.ticker))
			.filter(Boolean)
	);
}

function buildTradeOutcomeCandidates(trades = [], openPositionTickers = new Set()) {
	const lotsByTicker = new Map();
	const outcomes = [];

	for (const trade of Array.isArray(trades) ? trades : []) {
		if (String(trade?.status || '').trim().toUpperCase() !== 'FILLED') continue;
		const ticker = toTicker(trade.ticker);
		if (!ticker) continue;
		const direction = String(trade.direction || '').trim().toUpperCase();
		const shares = toNumber(trade.shares, 0);
		const price = toNumber(trade.price, 0);
		if (shares <= 0 || price <= 0) continue;

		const lots = lotsByTicker.get(ticker) || [];
		if (direction === 'BUY') {
			lots.push({
				shares,
				price,
				tradeId: trade.id,
				timestamp: trade.timestamp,
			});
			lotsByTicker.set(ticker, lots);
			continue;
		}

		if (direction !== 'SELL') {
			continue;
		}

		let remaining = shares;
		let matchedShares = 0;
		let costBasis = 0;
		while (remaining > 0.000001 && lots.length > 0) {
			const lot = lots[0];
			const matched = Math.min(remaining, lot.shares);
			costBasis += matched * lot.price;
			matchedShares += matched;
			lot.shares -= matched;
			remaining -= matched;
			if (lot.shares <= 0.000001) {
				lots.shift();
			}
		}

		lotsByTicker.set(ticker, lots);
		if (matchedShares <= 0 || costBasis <= 0) continue;

		const proceeds = matchedShares * price;
		const realizedPnl = roundCurrency(proceeds - costBasis);
		const realizedReturn = costBasis > 0 ? Number((realizedPnl / costBasis).toFixed(6)) : 0;
		const remainingShares = lots.reduce((sum, lot) => sum + toNumber(lot.shares, 0), 0);
		const isClosed = remainingShares <= 0.000001 && !openPositionTickers.has(ticker);
		outcomes.push({
			trade,
			ticker,
			matchedShares,
			costBasis: roundCurrency(costBasis),
			proceeds: roundCurrency(proceeds),
			realizedPnl,
			realizedReturn,
			isClosed,
		});
	}

	return outcomes;
}

function summarizeDailyTradeOutcomes(trades = [], marketDate = '') {
	const tradeRows = Array.isArray(trades) ? trades : [];
	const filledTrades = tradeRows.filter((trade) => {
		return String(trade.timestamp || '').startsWith(marketDate)
			&& String(trade.status || '').trim().toUpperCase() === 'FILLED';
	});
	const closedOutcomes = tradeRows.filter((trade) => {
		return String(trade.timestamp || '').startsWith(marketDate)
			&& String(trade.direction || '').trim().toUpperCase() === 'SELL'
			&& trade.outcome_recorded_at
			&& Number.isFinite(Number(trade.realized_pnl));
	});
	const sortedByPnl = closedOutcomes.slice().sort((left, right) => toNumber(right.realized_pnl, 0) - toNumber(left.realized_pnl, 0));
	const bestTrade = sortedByPnl[0] || null;
	const worstTrade = sortedByPnl[sortedByPnl.length - 1] || null;
	return {
		totalTrades: filledTrades.length,
		wins: closedOutcomes.filter((trade) => toNumber(trade.realized_pnl, 0) > 0).length,
		losses: closedOutcomes.filter((trade) => toNumber(trade.realized_pnl, 0) < 0).length,
		netPnl: roundCurrency(closedOutcomes.reduce((sum, trade) => sum + toNumber(trade.realized_pnl, 0), 0)),
		bestTrade: bestTrade ? {
			ticker: bestTrade.ticker,
			pnl: roundCurrency(bestTrade.realized_pnl),
			tradeId: bestTrade.id,
		} : null,
		worstTrade: worstTrade ? {
			ticker: worstTrade.ticker,
			pnl: roundCurrency(worstTrade.realized_pnl),
			tradeId: worstTrade.id,
		} : null,
	};
}

function pickReferencePrice(snapshot) {
	if (!snapshot) return null;
	return [
		snapshot.tradePrice,
		snapshot.askPrice,
		snapshot.bidPrice,
		snapshot.minuteClose,
		snapshot.dailyClose,
		snapshot.previousClose,
	].map((value) => Number(value)).find((value) => Number.isFinite(value) && value > 0) || null;
}

function getReconcilablePendingTrades(db) {
	return journal.getPendingTrades(db).filter((trade) => {
		return watchlist.getBrokerForTicker(trade.ticker, 'alpaca') === 'alpaca'
			&& String(trade.alpaca_order_id || '').trim().length > 0;
	});
}

function normalizeSymbols(symbols, options = {}) {
	return dataIngestion.normalizeSymbols(
		Array.isArray(symbols)
			? symbols
			: (symbols
				? [symbols]
				: watchlist.getTickers({ assetClass: options.assetClass || options.asset_class }))
	);
}

function normalizeSignal(agentId, ticker, signal = {}) {
	const normalizedAgent = toAgentId(agentId);
	const normalizedTicker = toTicker(ticker || signal.ticker);
	if (!normalizedTicker) {
		throw new Error('ticker is required');
	}

	return {
		ticker: normalizedTicker,
		direction: toDirection(signal.direction),
		confidence: toConfidence(signal.confidence),
		timeframe: String(signal.timeframe || '1-5 days').trim(),
		reasoning: String(signal.reasoning || '').trim(),
		agent: normalizedAgent,
		model: String(signal.model || DEFAULT_MODELS[normalizedAgent] || 'unknown').trim(),
		timestamp: Number(signal.timestamp) || Date.now(),
	};
}

function cloneAccountState(accountState = {}) {
	return {
		...accountState,
		openPositions: Array.isArray(accountState.openPositions)
			? accountState.openPositions.map((position) => ({ ...position }))
			: [],
	};
}

function applyTradeToAccountState(accountState, trade = {}, riskCheck = {}) {
	const next = cloneAccountState(accountState);
	const ticker = toTicker(trade.ticker);
	const direction = toDirection(trade.direction);

	next.tradesToday = toPositiveInteger(next.tradesToday) + 1;

	if (direction === 'BUY') {
		const assetClass = trade.assetClass || resolveAssetClassForTicker(ticker);
		const shares = toPositiveQuantity(riskCheck.maxShares, assetClass);
		const existing = next.openPositions.find((position) => toTicker(position.ticker) === ticker);
		if (existing) {
			existing.shares = toPositiveQuantity(existing.shares, assetClass) + shares;
			existing.avgPrice = toNumber(trade.price, existing.avgPrice || 0);
			existing.stopLossPrice = riskCheck.stopLossPrice || existing.stopLossPrice || null;
			existing.assetClass = assetClass;
		} else {
			next.openPositions.push({
				ticker,
				shares,
				avgPrice: toNumber(trade.price, 0),
				stopLossPrice: riskCheck.stopLossPrice || null,
				assetClass,
			});
		}
	} else if (direction === 'SELL') {
		next.openPositions = next.openPositions.filter((position) => toTicker(position.ticker) !== ticker);
	}

	return next;
}

function defaultState() {
	return {
		signals: new Map(),
		phases: {},
		meta: {
			dayStartEquity: null,
			peakEquity: null,
			marketDate: null,
		},
	};
}

class TradingOrchestrator {
	constructor(options = {}) {
		this.options = { ...options };
		this.state = defaultState();
	}

	resolveJournalPath(options = {}) {
		return options.journalPath || this.options.journalPath || path.join(getProjectRoot(), '.squidrun', 'runtime', 'trade-journal.db');
	}

	getJournalDb(options = {}) {
		return options.journalDb || journal.getDb(this.resolveJournalPath(options));
	}

	getRegisteredSignals(ticker) {
		if (ticker) {
			const bucket = this.state.signals.get(toTicker(ticker));
			return bucket ? Array.from(bucket.values()).map((signal) => ({ ...signal })) : [];
		}

		const result = {};
		for (const [symbol, bucket] of this.state.signals.entries()) {
			result[symbol] = Array.from(bucket.values()).map((signal) => ({ ...signal }));
		}
		return result;
	}

	clearSignals(ticker) {
		if (ticker) {
			this.state.signals.delete(toTicker(ticker));
		} else {
			this.state.signals.clear();
		}
		return this.getRegisteredSignals();
	}

	resetForMarketDate(marketDate) {
		const normalizedDate = toDateKey(marketDate || new Date());
		if (this.state.meta.marketDate && this.state.meta.marketDate !== normalizedDate) {
			this.clearSignals();
			this.state.phases = {};
			this.state.meta.dayStartEquity = null;
			this.state.meta.peakEquity = null;
		}
		this.state.meta.marketDate = normalizedDate;
		return normalizedDate;
	}

	registerSignal(agentId, ticker, signal = {}) {
		const normalized = normalizeSignal(agentId, ticker, signal);
		if (!watchlist.isWatched(normalized.ticker)) {
			throw new Error(`Ticker ${normalized.ticker} is not on the watchlist`);
		}

		if (!this.state.signals.has(normalized.ticker)) {
			this.state.signals.set(normalized.ticker, new Map());
		}
		const bucket = this.state.signals.get(normalized.ticker);
		bucket.set(normalized.agent, normalized);

		return {
			ticker: normalized.ticker,
			agent: normalized.agent,
			receivedCount: bucket.size,
			complete: REQUIRED_AGENTS.every((requiredAgent) => bucket.has(requiredAgent)),
			signal: { ...normalized },
		};
	}

	countTradesToday(db, marketDate, options = {}) {
		const limit = toPositiveInteger(options.recentTradeLimit || this.options.recentTradeLimit || DEFAULT_RECENT_TRADE_SCAN) || DEFAULT_RECENT_TRADE_SCAN;
		return journal.getRecentTrades(db, limit).filter((trade) => String(trade.timestamp || '').startsWith(marketDate)).length;
	}

	buildAccountState(accountSnapshot, openPositions, db, options = {}) {
		const marketDate = toDateKey(options.date || this.state.meta.marketDate || new Date());
		const portfolioSnapshot = accountSnapshot && typeof accountSnapshot.totalEquity === 'number'
			? accountSnapshot
			: null;
		const liveEquity = toNumber(portfolioSnapshot?.totalEquity ?? accountSnapshot?.equity, 0);
		const resolvedOpenPositions = Array.isArray(portfolioSnapshot?.positions)
			? portfolioSnapshot.positions
			: (Array.isArray(openPositions) ? openPositions : []);
		const dayStartEquity = toNumber(
			options.dayStartEquity
			?? portfolioSnapshot?.risk?.dayStartEquity
			?? this.state.meta.dayStartEquity
			?? liveEquity,
			0
		);
		const peakEquity = Math.max(
			toNumber(options.peakEquity ?? portfolioSnapshot?.risk?.peakEquity ?? this.state.meta.peakEquity ?? liveEquity, 0),
			liveEquity
		);

		this.state.meta.marketDate = marketDate;
		if (this.state.meta.dayStartEquity == null) this.state.meta.dayStartEquity = dayStartEquity;
		this.state.meta.peakEquity = peakEquity;

		return {
			equity: liveEquity,
			peakEquity,
			dayStartEquity,
			tradesToday: this.countTradesToday(db, marketDate, options),
			openPositions: resolvedOpenPositions,
			portfolioSnapshot,
		};
	}

	buildSignalMap(symbols) {
		const completeSignals = new Map();
		const incomplete = [];

		for (const symbol of symbols) {
			const bucket = this.state.signals.get(symbol);
			const signals = bucket ? REQUIRED_AGENTS.map((agentId) => bucket.get(agentId)).filter(Boolean) : [];
			if (signals.length === REQUIRED_AGENTS.length) {
				completeSignals.set(symbol, signals);
				continue;
			}

			incomplete.push({
				ticker: symbol,
				receivedAgents: signals.map((signal) => signal.agent),
				missingAgents: REQUIRED_AGENTS.filter((agentId) => !signals.some((signal) => signal.agent === agentId)),
			});
		}

		return { completeSignals, incomplete };
	}

	buildMissingSignalMap(symbols) {
		const missingByAgent = new Map(REQUIRED_AGENTS.map((agentId) => [agentId, []]));

		for (const symbol of symbols) {
			const bucket = this.state.signals.get(symbol);
			for (const agentId of REQUIRED_AGENTS) {
				if (!bucket?.has(agentId)) {
					missingByAgent.get(agentId).push(symbol);
				}
			}
		}

		return Array.from(missingByAgent.entries()).filter(([, tickers]) => tickers.length > 0);
	}

	getPendingReconciliationTrades(options = {}) {
		const db = this.getJournalDb(options);
		return getReconcilablePendingTrades(db).map((trade) => ({ ...trade }));
	}

	isRealConsultationEnabled(options = {}) {
		if (options.realAgentConsultationEnabled === false || options.consultationEnabled === false) {
			return false;
		}
		if (this.options.realAgentConsultationEnabled === false || this.options.consultationEnabled === false) {
			return false;
		}
		if (process.env.SQUIDRUN_REAL_AGENT_CONSULTATION === '0') {
			return false;
		}
		return true;
	}

	async consultMissingSignals(symbols, context = {}, options = {}) {
		const missingByAgent = this.buildMissingSignalMap(symbols);
		if (missingByAgent.length === 0 || !this.isRealConsultationEnabled(options)) {
			return {
				requestId: null,
				requestPath: null,
				requestedAgents: [],
				deliveries: [],
				responses: [],
				missingAgents: [],
			};
		}

		const requestedAgents = missingByAgent.map(([agentId]) => agentId);
		const timeoutMs = Math.max(
			1_000,
			toPositiveInteger(
				options.consultationTimeoutMs
				|| this.options.consultationTimeoutMs
				|| consultationStore.DEFAULT_CONSULTATION_TIMEOUT_MS
			)
		) || consultationStore.DEFAULT_CONSULTATION_TIMEOUT_MS;
		const request = consultationStore.writeConsultationRequest({
			requestId: options.consultationRequestId || null,
			timeoutMs,
			symbols,
			snapshots: context.snapshots || {},
			bars: context.bars || {},
			news: context.news || [],
			accountSnapshot: context.accountSnapshot || null,
		}, {
			requestsDir: options.consultationRequestsDir || this.options.consultationRequestsDir,
		});
		const consultationOptions = {
			requestsDir: options.consultationRequestsDir || this.options.consultationRequestsDir,
			responsesDir: options.consultationResponsesDir || this.options.consultationResponsesDir,
			sender: options.consultationSender || this.options.consultationSender,
			queryEntries: options.consultationQuery || this.options.consultationQuery,
			hmSendPath: options.hmSendPath || this.options.hmSendPath,
			dbPath: options.consultationDbPath || this.options.consultationDbPath || null,
			pollMs: options.consultationPollMs || this.options.consultationPollMs,
		};
		const deliveries = await consultationStore.dispatchConsultationRequests(request, requestedAgents, consultationOptions);
		const responseResult = await consultationStore.collectConsultationResponses(request, requestedAgents, consultationOptions);

		for (const response of responseResult.responses) {
			signalProducer.registerAllSignals(this, response.agentId, response.signals);
		}

		return {
			requestId: request.requestId,
			requestPath: request.path,
			requestedAgents,
			deliveries,
			responses: responseResult.responses.map((response) => ({
				agentId: response.agentId,
				count: Array.isArray(response.signals) ? response.signals.length : 0,
			})),
			missingAgents: responseResult.missingAgents,
		};
	}

	async backfillMissingSignals(symbols, options = {}) {
		const missingByAgent = this.buildMissingSignalMap(symbols);
		if (missingByAgent.length === 0) {
			return [];
		}

		const alpacaClient = options.alpacaClient
			|| options.client
			|| this.options.alpacaClient
			|| this.options.client
			|| null;
		const generated = [];

		for (const [agentId, missingTickers] of missingByAgent) {
			const signalOptions = alpacaClient
				? { client: alpacaClient, emptyPortfolio: Boolean(options.emptyPortfolio), symbols: missingTickers }
				: { emptyPortfolio: Boolean(options.emptyPortfolio), symbols: missingTickers };
			const producedSignals = await signalProducer.produceSignals(agentId, signalOptions);
			const missingSet = new Set(missingTickers.map(toTicker));
			const selectedSignals = producedSignals.filter((signal) => missingSet.has(toTicker(signal.ticker)));
			signalProducer.registerAllSignals(this, agentId, selectedSignals);
			generated.push({
				agentId,
				tickers: selectedSignals.map((signal) => signal.ticker),
				count: selectedSignals.length,
			});
		}

		return generated;
	}

	lookupSignalsByAgent(signals = []) {
		return Object.fromEntries(signals.map((signal) => [signal.agent, signal]));
	}

	summarizeConsensus(results = []) {
		return results.reduce((stats, result) => {
			if (!result.consensus) {
				stats.noConsensus += 1;
				return stats;
			}

			if (result.agreementCount === 3) {
				stats.unanimous += 1;
			} else {
				stats.majority += 1;
			}
			return stats;
		}, { unanimous: 0, majority: 0, noConsensus: 0 });
	}

	async getUnifiedPortfolioSnapshot(options = {}) {
		return portfolioTracker.getPortfolioSnapshot({
			...this.options.portfolioOptions,
			yieldRouter: options.yieldRouter ?? this.options.yieldRouter ?? this.options.portfolioOptions?.yieldRouter,
			...options,
		});
	}

	getCapitalAllocation(portfolioSnapshot = {}, options = {}) {
		const ratios = buildCapitalRatios({
			activeTradingRatio: options.activeTradingRatio ?? this.options.activeTradingRatio,
			yieldRouterRatio: options.yieldRouterRatio ?? this.options.yieldRouterRatio,
			reserveRatio: options.reserveRatio ?? this.options.reserveRatio,
			launchRadarRatio: options.launchRadarRatio ?? this.options.launchRadarRatio,
		});
		const totalEquity = roundCurrency(portfolioSnapshot?.totalEquity);
		const targets = {
			activeTrading: roundCurrency(totalEquity * ratios.activeTrading),
			yield: roundCurrency(totalEquity * ratios.yield),
			reserve: roundCurrency(totalEquity * ratios.reserve),
			launchRadar: roundCurrency(totalEquity * ratios.launchRadar),
		};
		const activeTradingCapital = sumSnapshotEquity(portfolioSnapshot, [
			'alpaca_stocks',
			'alpaca_crypto',
			'ibkr_global',
			'polymarket',
		]);
		const yieldCapital = roundCurrency(portfolioSnapshot?.markets?.defi_yield?.equity);
		const reserveCapital = roundCurrency(
			options.reserveCapital
			?? portfolioSnapshot?.markets?.cash_reserve?.cash
			?? portfolioSnapshot?.markets?.cash_reserve?.equity
		);
		const launchRadarCapital = roundCurrency(
			options.launchRadarCapital
			?? portfolioSnapshot?.markets?.solana_tokens?.equity
		);
		const launchRadarGap = roundCurrency(Math.max(0, targets.launchRadar - launchRadarCapital));
		const deployableTradingCapital = roundCurrency(Math.max(0, reserveCapital - targets.reserve - launchRadarGap));
		const effectiveActiveCapital = roundCurrency(activeTradingCapital + deployableTradingCapital);
		const gaps = {
			activeTrading: roundCurrency(Math.max(0, targets.activeTrading - effectiveActiveCapital)),
			yield: roundCurrency(Math.max(0, targets.yield - yieldCapital)),
			reserve: roundCurrency(Math.max(0, targets.reserve - reserveCapital)),
			launchRadar: launchRadarGap,
		};
		const excess = {
			reserveCash: roundCurrency(Math.max(0, reserveCapital - targets.reserve)),
			idleCapital: roundCurrency(Math.max(0, deployableTradingCapital - gaps.activeTrading)),
			yield: roundCurrency(Math.max(0, yieldCapital - targets.yield)),
		};

		return {
			totalEquity,
			ratios,
			targets,
			actual: {
				activeTrading: activeTradingCapital,
				yield: yieldCapital,
				reserve: reserveCapital,
				launchRadar: launchRadarCapital,
			},
			effective: {
				activeTrading: effectiveActiveCapital,
			},
			deployable: {
				activeTradingCash: deployableTradingCapital,
			},
			gaps,
			excess,
			asOf: portfolioSnapshot?.asOf || new Date().toISOString(),
		};
	}

	async returnIdleCapital(options = {}) {
		const router = options.yieldRouter ?? this.options.yieldRouter ?? null;
		if (!router || typeof router.returnCapital !== 'function' || typeof router.requestCapital !== 'function') {
			return { ok: false, skipped: true, reason: 'yield_router_unavailable' };
		}

		const portfolioSnapshot = options.portfolioSnapshot || await this.getUnifiedPortfolioSnapshot(options);
		const allocation = this.getCapitalAllocation(portfolioSnapshot, options);
		const killSwitchTriggered = options.killSwitchTriggered === true
			|| portfolioSnapshot?.risk?.killSwitchTriggered === true;
		if (options.dryRun === true) {
			return {
				ok: true,
				skipped: true,
				simulated: true,
				action: killSwitchTriggered ? 'withdraw_all' : 'return_idle',
				allocation,
				amount: killSwitchTriggered
					? allocation.actual.yield
					: roundCurrency(Math.min(allocation.excess.idleCapital, allocation.gaps.yield)),
			};
		}

		if (killSwitchTriggered) {
			const withdrawal = await router.requestCapital(0, {
				...options,
				portfolioSnapshot,
				killSwitchTriggered: true,
			});
			return {
				ok: withdrawal.ok,
				action: 'withdraw_all',
				allocation,
				withdrawal,
			};
		}

		const amount = roundCurrency(Math.min(
			toNumber(options.amount, allocation.excess.idleCapital),
			allocation.excess.idleCapital,
			allocation.gaps.yield
		));
		if (amount < yieldRouterModule.DEFAULT_MIN_DEPOSIT_USD) {
			return {
				ok: false,
				skipped: true,
				reason: 'no_idle_capital_to_return',
				allocation,
				amount,
			};
		}

		const deposit = await router.returnCapital(amount, {
			...options,
			portfolioSnapshot,
			totalCapital: allocation.totalEquity,
			activeTradeCapital: allocation.actual.activeTrading,
		});
		return {
			ok: deposit.ok,
			action: 'return_idle',
			amount,
			allocation,
			deposit,
		};
	}

	async requestTradingCapital(amount, options = {}) {
		const router = options.yieldRouter ?? this.options.yieldRouter ?? null;
		if (!router || typeof router.requestCapital !== 'function') {
			return { ok: false, skipped: true, reason: 'yield_router_unavailable', requested: roundCurrency(amount) };
		}

		const portfolioSnapshot = options.portfolioSnapshot || await this.getUnifiedPortfolioSnapshot(options);
		const allocation = this.getCapitalAllocation(portfolioSnapshot, options);
		const killSwitchTriggered = options.killSwitchTriggered === true
			|| portfolioSnapshot?.risk?.killSwitchTriggered === true;
		const requested = roundCurrency(amount);
		if (requested <= 0) {
			return { ok: false, skipped: true, reason: 'no_capital_requested', requested, allocation };
		}
		if (killSwitchTriggered) {
			return { ok: false, skipped: true, reason: 'kill_switch_triggered', requested, allocation };
		}

		const shortfall = roundCurrency(Math.max(0, requested - allocation.deployable.activeTradingCash));
		const requestAmount = roundCurrency(Math.min(shortfall, allocation.gaps.activeTrading));
		if (requestAmount <= 0) {
			return {
				ok: true,
				skipped: true,
				reason: 'active_allocation_sufficient',
				requested,
				shortfall,
				allocation,
			};
		}
		if (options.dryRun === true) {
			return {
				ok: true,
				skipped: true,
				simulated: true,
				reason: 'dry_run',
				requested,
				shortfall,
				requestAmount,
				allocation,
			};
		}

		const withdrawal = await router.requestCapital(requestAmount, {
			...options,
			portfolioSnapshot,
			totalCapital: allocation.totalEquity,
		});
		return {
			ok: withdrawal.ok,
			requested,
			shortfall,
			requestAmount,
			allocation,
			withdrawal,
		};
	}

	async runReconciliation(options = {}) {
		const db = this.getJournalDb(options);
		const marketDate = this.state.meta.marketDate || toDateKey(options.date || new Date());
		const pendingTrades = this.getPendingReconciliationTrades({ ...options, journalDb: db });
		const alpacaClient = pendingTrades.length > 0
			? (options.alpacaClient || this.options.alpacaClient || this.options.client || dataIngestion.createAlpacaClient(options))
			: null;
		const orderUpdates = [];

		for (const trade of pendingTrades) {
			try {
				let rawOrder = null;
				if (typeof alpacaClient?.getOrder === 'function') {
					rawOrder = await alpacaClient.getOrder(String(trade.alpaca_order_id));
				} else if (typeof alpacaClient?.getOrderByClientOrderId === 'function') {
					rawOrder = await alpacaClient.getOrderByClientOrderId(String(trade.alpaca_order_id));
				} else {
					throw new Error('alpaca_get_order_unavailable');
				}
				const order = executor.normalizeOrder(rawOrder || {});
				const status = normalizeBrokerOrderStatus(order.status);
				const filledQty = getOrderFilledQuantity(order);
				const filledPrice = getOrderFilledPrice(order);
				const update = journal.updateTrade(db, trade.id, {
					status,
					shares: filledQty > 0 ? filledQty : undefined,
					price: filledPrice > 0 ? filledPrice : undefined,
					filledAt: status === 'FILLED' ? getOrderFilledTimestamp(order) : undefined,
					reconciledAt: new Date().toISOString(),
				});
				orderUpdates.push({
					tradeId: trade.id,
					ticker: trade.ticker,
					orderId: trade.alpaca_order_id,
					status,
					filledQty,
					filledPrice,
					trade: update,
				});
			} catch (err) {
				orderUpdates.push({
					tradeId: trade.id,
					ticker: trade.ticker,
					orderId: trade.alpaca_order_id,
					ok: false,
					error: err.message,
				});
			}
		}

		const syncedPositions = await executor.syncJournalPositions({
			...options,
			journalDb: db,
			journalPath: this.resolveJournalPath(options),
		});
		const openPositionTickers = buildOpenPositionTickerSet(syncedPositions);
		const allTrades = journal.getAllTrades(db);
		const tradeOutcomes = buildTradeOutcomeCandidates(allTrades, openPositionTickers);
		const recordedOutcomes = [];

		for (const outcome of tradeOutcomes) {
			const tradeId = outcome.trade.id;
			journal.updateTrade(db, tradeId, {
				realizedPnl: outcome.realizedPnl,
			});
			if (!outcome.isClosed || outcome.trade.outcome_recorded_at) {
				continue;
			}

			const assetClass = resolveTradeAssetClass(outcome.trade);
			const actualDirection = outcome.realizedReturn > 0 ? 'BUY' : (outcome.realizedReturn < 0 ? 'SELL' : 'HOLD');
			const attributionResult = agentAttribution.recordOutcome(
				outcome.ticker,
				actualDirection,
				outcome.realizedReturn,
				outcome.trade.timestamp || new Date().toISOString(),
				{
					assetClass,
					marketType: resolveTradeMarketType(assetClass),
					statePath: options.agentAttributionStatePath || this.options.agentAttributionStatePath,
					source: 'trade_reconciliation',
				}
			);
			const outcomeRecordedAt = new Date().toISOString();
			const updatedTrade = journal.updateTrade(db, tradeId, {
				outcomeRecordedAt,
				realizedPnl: outcome.realizedPnl,
			});
			recordedOutcomes.push({
				tradeId,
				ticker: outcome.ticker,
				realizedPnl: outcome.realizedPnl,
				realizedReturn: outcome.realizedReturn,
				costBasis: outcome.costBasis,
				proceeds: outcome.proceeds,
				settledPredictions: attributionResult.settled.length,
				trade: updatedTrade,
			});
		}

		const reconciledTrades = journal.getAllTrades(db);
		const dailySummary = summarizeDailyTradeOutcomes(reconciledTrades, marketDate);
		const phaseResult = {
			phase: 'reconciliation',
			marketDate,
			pendingTrades: pendingTrades.map((trade) => ({ ...trade })),
			orderUpdates,
			syncedPositions,
			recordedOutcomes,
			dailySummary,
			asOf: new Date().toISOString(),
		};

		this.state.phases.reconciliation = phaseResult;
		return phaseResult;
	}

	async syncSmartMoneyWatchlist(options = {}) {
		const scanner = options.smartMoneyScanner || this.options.smartMoneyScanner || null;
		let pollResult = null;
		let signals = Array.isArray(options.smartMoneySignals) ? options.smartMoneySignals : [];
		if (signals.length === 0 && scanner && typeof scanner.pollNow === 'function') {
			pollResult = await scanner.pollNow({ reason: options.reason || 'orchestrator' });
			if (pollResult?.ok) {
				if (Array.isArray(pollResult.freshSignals) && pollResult.freshSignals.length > 0) {
					signals = pollResult.freshSignals;
				} else if (Array.isArray(pollResult.signals)) {
					signals = pollResult.signals;
				}
			}
		}

		const statePath = options.dynamicWatchlistStatePath || this.options.dynamicWatchlistStatePath;
		const added = [];
		const refreshed = [];
		for (const signal of signals) {
			const ticker = toTicker(signal.symbol || signal.ticker || signal.tokenAddress);
			if (!ticker) continue;
			const existed = dynamicWatchlist.getEntry(ticker, { statePath });
			dynamicWatchlist.addTicker(ticker, {
				statePath,
				persist: options.persistDynamicWatchlist,
				name: ticker,
				sector: 'Smart Money',
				source: 'smart_money',
				reason: buildSmartMoneyReason(signal),
				exchange: resolveSmartMoneyExchange(signal),
				broker: 'alpaca',
				assetClass: resolveSmartMoneyAssetClass(signal),
				expiry: options.smartMoneyExpiry || null,
			});
			(existed ? refreshed : added).push(ticker);
		}

		return {
			ok: pollResult?.ok !== false,
			signals,
			added,
			refreshed,
			pollResult,
		};
	}

	async syncLaunchRadarWatchlist(options = {}) {
		const radar = options.launchRadar || this.options.launchRadar || null;
		let pollResult = null;
		let qualifiedTokens = Array.isArray(options.launchRadarQualifiedTokens) ? options.launchRadarQualifiedTokens : [];
		if (qualifiedTokens.length === 0 && radar && typeof radar.pollNow === 'function') {
			pollResult = await radar.pollNow({ reason: options.reason || 'orchestrator' });
			if (pollResult?.ok && Array.isArray(pollResult.qualified)) {
				qualifiedTokens = pollResult.qualified;
			}
		}

		const statePath = options.dynamicWatchlistStatePath || this.options.dynamicWatchlistStatePath;
		const expiryDays = resolveLaunchRadarExpiryDays(options.launchRadarExpiryDays || this.options.launchRadarExpiryDays);
		const now = options.now instanceof Date ? options.now : (options.now ? new Date(options.now) : new Date());
		const expiry = new Date(now.getTime() + (expiryDays * 24 * 60 * 60 * 1000)).toISOString();
		const added = [];
		const refreshed = [];
		for (const token of qualifiedTokens) {
			const ticker = toTicker(token.symbol || token.ticker || token.address);
			if (!ticker) continue;
			const existed = dynamicWatchlist.getEntry(ticker, { statePath });
			dynamicWatchlist.addTicker(ticker, {
				statePath,
				persist: options.persistDynamicWatchlist,
				name: token.name || ticker,
				sector: 'Launch Radar',
				source: 'launch_radar',
				reason: buildLaunchRadarReason(token),
				exchange: resolveLaunchRadarExchange(token),
				broker: 'alpaca',
				assetClass: 'solana_token',
				expiry,
			});
			(existed ? refreshed : added).push(ticker);
		}

		return {
			ok: pollResult?.ok !== false,
			qualifiedTokens,
			added,
			refreshed,
			pollResult,
		};
	}

	async runPolymarketConsensusRound(options = {}) {
		const db = this.getJournalDb(options);
		const [smartMoneyWatchlist, portfolioSnapshot, markets] = await Promise.all([
			this.syncSmartMoneyWatchlist({ ...options, reason: 'polymarket_consensus' }),
			this.getUnifiedPortfolioSnapshot({ ...options, includePolymarket: true }),
			Array.isArray(options.polymarketMarkets) && options.polymarketMarkets.length > 0
				? Promise.resolve(options.polymarketMarkets)
				: polymarketScanner.scanMarkets(options),
		]);
		const accountState = this.buildAccountState(portfolioSnapshot, portfolioSnapshot?.positions || [], db, options);
		const limits = options.limits || this.options.limits || riskEngine.DEFAULT_LIMITS;
		const killSwitch = riskEngine.checkKillSwitch(portfolioSnapshot, limits);
		const dailyPause = riskEngine.checkDailyPause(portfolioSnapshot, limits);
		const polymarketMarket = portfolioSnapshot?.markets?.polymarket || {};
		const bankroll = toNumber(polymarketMarket.equity ?? polymarketMarket.liquidCapital ?? portfolioSnapshot?.totalEquity, 0);
		let currentExposure = toNumber(polymarketMarket.marketValue, 0);
		const openPositions = Array.isArray(polymarketMarket.positions)
			? polymarketMarket.positions.map((position) => ({ ...position }))
			: [];
		const signalsByAgent = polymarketSignals.produceSignals(markets, {
			...options,
			agentIds: REQUIRED_AGENTS,
		});
		const results = [];
		const approvedTrades = [];
		const rejectedTrades = [];

		for (const market of markets) {
			const marketSignals = REQUIRED_AGENTS.map((agentId) => {
				return (signalsByAgent.get(agentId) || []).find((signal) => signal.conditionId === market.conditionId);
			}).filter(Boolean);
			if (marketSignals.length !== REQUIRED_AGENTS.length) continue;

			const result = {
				...polymarketSignals.buildConsensus(marketSignals, options),
				ticker: market.conditionId,
				market,
			};
			results.push(result);
			const signalLookup = this.lookupSignalsByAgent(marketSignals);
			let actedOn = false;
			let sizing = null;
			let rejectionReason = null;

			for (const signal of marketSignals) {
				try {
					agentAttribution.recordPrediction(
						signal.agent,
						market.conditionId,
						signal.direction,
						signal.confidence,
						Date.now(),
						{
							assetClass: 'prediction_market',
							marketType: 'polymarket',
							reasoning: signal.reasoning,
							source: 'polymarket_consensus',
							statePath: options.agentAttributionStatePath,
						}
					);
				} catch (_) {
					// Attribution should never block consensus evaluation.
				}
			}

			if (result.consensus && result.decision !== 'HOLD' && !killSwitch.triggered && !dailyPause.paused) {
				const buyYes = result.decision === 'BUY_YES';
				const tokenId = buyYes ? market.tokens?.yes : market.tokens?.no;
				const referencePrice = buyYes
					? toNumber(market.currentPrices?.yes, 0)
					: toNumber(market.currentPrices?.no, 0);
				const probability = buyYes
					? toNumber(result.probability, 0)
					: Number((1 - toNumber(result.probability, 0)).toFixed(4));
				const alreadyOpen = openPositions.some((position) => {
					return String(position.market || '').trim() === String(market.conditionId || '').trim()
						|| String(position.tokenId || '').trim() === String(tokenId || '').trim();
				});
				if (alreadyOpen) {
					rejectionReason = 'market_already_open';
				} else if (!tokenId || referencePrice <= 0) {
					rejectionReason = 'missing_polymarket_execution_context';
				} else {
					sizing = polymarketSizer.positionSize(bankroll, probability, referencePrice, {
						...options,
						openPositions,
						currentExposure,
						dailyLossPct: dailyPause.dayLossPct,
					});
					actedOn = Boolean(sizing.executable);
					if (sizing.executable) {
						approvedTrades.push({
							ticker: market.conditionId,
							consensus: result,
							market,
							tokenId,
							referencePrice,
							probability,
							sizing,
							limits,
						});
						currentExposure = Number((currentExposure + sizing.stake).toFixed(2));
						openPositions.push({
							market: market.conditionId,
							tokenId,
							marketValue: sizing.stake,
							costBasis: sizing.stake,
						});
					} else {
						rejectionReason = sizing.reasons.join('; ') || 'not_executable';
					}
				}
			}

			if (!actedOn && result.consensus && result.decision !== 'HOLD') {
				rejectedTrades.push({
					ticker: market.conditionId,
					consensus: result,
					market,
					sizing,
					reason: rejectionReason,
				});
			}

			journal.recordConsensus(db, {
				ticker: market.conditionId,
				decision: toJournalDecision(result.decision),
				consensusReached: result.consensus,
				agreementCount: result.agreementCount,
				architectSignal: signalLookup.architect || null,
				builderSignal: signalLookup.builder || null,
				oracleSignal: signalLookup.oracle || null,
				dissentReasoning: result.summary || rejectionReason || null,
				actedOn,
			});
		}

		const phaseResult = {
			phase: 'polymarket_consensus',
			marketDate: this.state.meta.marketDate || toDateKey(options.date || new Date()),
			smartMoneyWatchlist,
			portfolioSnapshot,
			accountState,
			killSwitch,
			dailyPause,
			markets,
			agentSignals: Object.fromEntries(Array.from(signalsByAgent.entries())),
			results,
			approvedTrades,
			rejectedTrades,
			asOf: new Date().toISOString(),
		};

		this.state.phases.polymarketConsensus = phaseResult;
		this.state.phases.consensus = phaseResult;
		return phaseResult;
	}

	async runPolymarketMarketOpen(options = {}) {
		const db = this.getJournalDb(options);
		const consensusPhase = options.consensusPhase
			|| this.state.phases.polymarketConsensus
			|| this.state.phases.consensus
			|| await this.runPolymarketConsensusRound(options);
		const approvedTrades = Array.isArray(options.approvedTrades) ? options.approvedTrades : consensusPhase.approvedTrades;
		const portfolioSnapshot = await this.getUnifiedPortfolioSnapshot({ ...options, includePolymarket: true });
		const executions = [];

		for (const trade of approvedTrades) {
			let execution;
			try {
				execution = await executor.executeConsensusTrade({
					consensus: trade.consensus,
					ticker: trade.ticker,
					conditionId: trade.market?.conditionId || trade.ticker,
					tokenId: trade.tokenId,
					yesTokenId: trade.market?.tokens?.yes,
					noTokenId: trade.market?.tokens?.no,
					currentPrices: trade.market?.currentPrices,
					price: trade.referencePrice,
					referencePrice: trade.referencePrice,
					broker: 'polymarket',
					assetClass: 'prediction_market',
					account: portfolioSnapshot,
					limits: trade.limits,
					requestedShares: trade.sizing?.shares,
					notes: `polymarket-open:${trade.ticker}`,
				}, {
					...options,
					broker: 'polymarket',
					journalDb: db,
					journalPath: this.resolveJournalPath(options),
				});
			} catch (execErr) {
				execution = { ok: false, status: 'error', error: execErr.message };
			}

			executions.push({
				ticker: trade.ticker,
				consensus: trade.consensus,
				referencePrice: trade.referencePrice,
				sizing: trade.sizing,
				execution,
			});
		}

		const syncedPositions = await executor.getOpenPositions({ ...options, broker: 'polymarket' }).catch(() => []);
		const phaseResult = {
			phase: 'polymarket_execute',
			marketDate: this.state.meta.marketDate || toDateKey(options.date || new Date()),
			executions,
			syncedPositions,
			asOf: new Date().toISOString(),
		};

		this.state.phases.polymarketExecute = phaseResult;
		this.state.phases.marketOpen = phaseResult;
		return phaseResult;
	}

	async runPreMarket(options = {}) {
		const [smartMoneyWatchlist, launchRadarWatchlist] = await Promise.all([
			this.syncSmartMoneyWatchlist({ ...options, reason: 'premarket' }),
			this.syncLaunchRadarWatchlist({ ...options, reason: 'premarket' }),
		]);
		const symbols = normalizeSymbols(options.symbols, options);
		const marketDate = this.resetForMarketDate(options.date || new Date());
		const isCrypto = watchlist.normalizeAssetClass(options.assetClass || options.asset_class, 'us_equity') === 'crypto';
		const calendarDay = isCrypto
			? null
			: await tradingScheduler.getCalendarDay(options.date || new Date(), options).catch(() => null);
		const schedule = calendarDay ? tradingScheduler.buildTradingDaySchedule(calendarDay, options) : null;
		const [marketContext, accountSnapshot, openPositions] = await Promise.all([
			dataIngestion.buildWatchlistContext({ ...options, symbols }),
			executor.getAccountSnapshot(options).catch(() => null),
			executor.getOpenPositions(options).catch(() => []),
		]);
		const emptyPortfolio = !Array.isArray(openPositions) || openPositions.length === 0;
		const autoGeneratedSignals = options.backfillDuringPreMarket === true
			? await this.backfillMissingSignals(symbols, { ...options, emptyPortfolio })
			: [];

		const result = {
			phase: 'premarket',
			marketDate: schedule?.marketDate || marketDate,
			smartMoneyWatchlist,
			launchRadarWatchlist,
			watchlist: watchlist.getWatchlist({ assetClass: options.assetClass || options.asset_class }),
			symbols,
			schedule,
			marketContext,
			accountSnapshot,
			autoGeneratedSignals,
			registeredSignals: this.getRegisteredSignals(),
			asOf: new Date().toISOString(),
		};

		this.state.meta.marketDate = result.marketDate;
		if (accountSnapshot?.equity && this.state.meta.dayStartEquity == null) {
			this.state.meta.dayStartEquity = accountSnapshot.equity;
		}
		if (accountSnapshot?.equity) {
			this.state.meta.peakEquity = Math.max(toNumber(this.state.meta.peakEquity, 0), toNumber(accountSnapshot.equity, 0));
		}
		this.state.phases.premarket = result;
		return result;
	}

	async runConsensusRound(options = {}) {
		if (isPolymarketMode(options)) {
			return this.runPolymarketConsensusRound(options);
		}

		const db = this.getJournalDb(options);
		const [smartMoneyWatchlist, launchRadarWatchlist] = await Promise.all([
			this.syncSmartMoneyWatchlist({ ...options, reason: 'consensus_round' }),
			this.syncLaunchRadarWatchlist({ ...options, reason: 'consensus_round' }),
		]);
		const symbols = normalizeSymbols(options.symbols, options);
		const premarketContext = this.state.phases.premarket?.marketContext || {};
		// Always fetch fresh data — cached Maps lose their entries after JSON serialization
		const cachedSnapshots = options.snapshots || premarketContext.snapshots;
		const hasCachedSnapshots = cachedSnapshots instanceof Map ? cachedSnapshots.size > 0
			: (cachedSnapshots && typeof cachedSnapshots === 'object' && Object.keys(cachedSnapshots).length > 0);
		const [freshSnapshots, bars, news, portfolioSnapshot] = await Promise.all([
			hasCachedSnapshots
				? Promise.resolve(cachedSnapshots)
				: dataIngestion.getWatchlistSnapshots({ ...options, symbols }),
			options.bars
				|| dataIngestion.getHistoricalBars({
					...options,
					symbols,
					limit: 5,
					timeframe: '1Day',
				}).catch(() => new Map()),
			options.news
				|| (Array.isArray(premarketContext.news) && premarketContext.news.length > 0 ? premarketContext.news : null)
				|| dataIngestion.getNews({ ...options, symbols, limit: Math.max(20, symbols.length * 3) }).catch(() => []),
			this.getUnifiedPortfolioSnapshot(options),
		]);
		const snapshots = freshSnapshots;
		const whaleData = options.whaleTransfers || null;
		const consultation = await this.consultMissingSignals(symbols, {
			snapshots,
			bars,
			news,
			accountSnapshot: portfolioSnapshot,
			whaleData,
		}, options);
		const autoGeneratedSignals = await this.backfillMissingSignals(symbols, options);
		const { completeSignals, incomplete } = this.buildSignalMap(symbols);
		const accountState = this.buildAccountState(portfolioSnapshot, portfolioSnapshot?.positions || [], db, options);
		const limits = options.limits || this.options.limits || riskEngine.DEFAULT_LIMITS;
		const killSwitch = riskEngine.checkKillSwitch(portfolioSnapshot, limits);
		const dailyPause = riskEngine.checkDailyPause(portfolioSnapshot, limits);
		const results = completeSignals.size > 0 ? consensus.evaluateAll(completeSignals) : [];
		const approvedTrades = [];
		const rejectedTrades = [];
		let simulatedAccountState = cloneAccountState(accountState);

		for (const result of results) {
			const signals = completeSignals.get(result.ticker) || [];
			const signalLookup = this.lookupSignalsByAgent(signals);
			const snapshot = snapshots instanceof Map ? snapshots.get(result.ticker) : snapshots?.[result.ticker];
			const referencePrice = pickReferencePrice(snapshot);
			const assetClass = resolveAssetClassForTicker(result.ticker);
			let riskCheck = null;
			let actedOn = false;

			for (const signal of signals) {
				try {
					agentAttribution.recordPrediction(
						signal.agent,
						signal.ticker,
						signal.direction,
						signal.confidence,
						signal.timestamp,
						{
							assetClass,
							marketType: options.marketType || options.market_type,
							reasoning: signal.reasoning,
							source: 'consensus_round',
							statePath: options.agentAttributionStatePath,
						}
					);
				} catch (_) {
					// Attribution should never block consensus evaluation.
				}
			}

			if (result.consensus && result.decision !== 'HOLD' && !killSwitch.triggered && !dailyPause.paused) {
				riskCheck = riskEngine.checkTrade({
					ticker: result.ticker,
					direction: result.decision,
					price: referencePrice || 0,
					marketCap: options.marketCaps?.[result.ticker] ?? null,
					assetClass,
				}, simulatedAccountState, limits);
				actedOn = Boolean(riskCheck.approved);
				if (riskCheck.approved) {
					approvedTrades.push({
						ticker: result.ticker,
						consensus: result,
						referencePrice,
						riskCheck,
						marketCap: options.marketCaps?.[result.ticker] ?? null,
						limits,
					});
					simulatedAccountState = applyTradeToAccountState(simulatedAccountState, {
						ticker: result.ticker,
						direction: result.decision,
						price: referencePrice,
						assetClass,
					}, riskCheck);
				} else {
					rejectedTrades.push({
						ticker: result.ticker,
						consensus: result,
						referencePrice,
						riskCheck,
					});
				}
			}

			journal.recordConsensus(db, {
				ticker: result.ticker,
				decision: result.decision,
				consensusReached: result.consensus,
				agreementCount: result.agreementCount,
				architectSignal: signalLookup.architect || null,
				builderSignal: signalLookup.builder || null,
				oracleSignal: signalLookup.oracle || null,
				dissentReasoning: result.dissenting.map((signal) => `${signal.agent}: ${signal.reasoning}`).join(' | ') || null,
				actedOn,
			});
		}

		const phaseResult = {
			phase: 'consensus',
			marketDate: this.state.meta.marketDate || toDateKey(options.date || new Date()),
			smartMoneyWatchlist,
			launchRadarWatchlist,
			consultation,
			autoGeneratedSignals,
			portfolioSnapshot,
			accountState,
			simulatedAccountState,
			killSwitch,
			dailyPause,
			incompleteSignals: incomplete,
			results,
			approvedTrades,
			rejectedTrades,
			asOf: new Date().toISOString(),
		};

		this.state.phases.consensus = phaseResult;
		return phaseResult;
	}

	async runMarketOpen(options = {}) {
		if (isPolymarketMode(options)) {
			return this.runPolymarketMarketOpen(options);
		}

		const db = this.getJournalDb(options);
		const consensusPhase = options.consensusPhase || this.state.phases.consensus || await this.runConsensusRound(options);
		const approvedTrades = Array.isArray(options.approvedTrades) ? options.approvedTrades : consensusPhase.approvedTrades;
		const executions = [];
		const requiredTradingCapital = estimateTradeCapitalRequirement(approvedTrades);
		// Use pre-trade accountState (not simulatedAccountState which already incremented tradesToday
		// for the same trades we're about to execute, causing double-counting)
		let simulatedAccountState = cloneAccountState(consensusPhase.accountState || consensusPhase.simulatedAccountState || {});
		let capitalRequest = {
			ok: false,
			skipped: true,
			reason: 'no_capital_request_needed',
			requested: 0,
		};

		// If account state is empty (e.g. lost during serialization), fetch fresh from broker
		if (!simulatedAccountState.equity || simulatedAccountState.equity <= 0) {
			const portfolioSnapshot = await this.getUnifiedPortfolioSnapshot(options);
			if (portfolioSnapshot?.totalEquity > 0) {
				simulatedAccountState = this.buildAccountState(portfolioSnapshot, portfolioSnapshot.positions || [], db, options);
			}
		}

		if (requiredTradingCapital > 0) {
			capitalRequest = await this.requestTradingCapital(requiredTradingCapital, {
				...options,
				portfolioSnapshot: consensusPhase.portfolioSnapshot,
			});
		}

		for (const trade of approvedTrades) {
			let execution;
			try {
				execution = await executor.executeConsensusTrade({
					consensus: trade.consensus,
					price: trade.referencePrice,
					marketCap: trade.marketCap,
					assetClass: resolveAssetClassForTicker(trade.ticker),
					account: simulatedAccountState,
					limits: trade.limits,
					requestedShares: trade.riskCheck?.maxShares,
					notes: `market-open:${trade.ticker}`,
				}, {
					...options,
					journalDb: db,
					journalPath: this.resolveJournalPath(options),
				});
			} catch (execErr) {
				execution = { ok: false, status: 'error', error: execErr.message };
			}

			executions.push({
				ticker: trade.ticker,
				consensus: trade.consensus,
				riskCheck: trade.riskCheck,
				referencePrice: trade.referencePrice,
				accountState: simulatedAccountState,
				execution,
			});

			if (execution?.ok) {
				simulatedAccountState = applyTradeToAccountState(simulatedAccountState, {
					ticker: trade.ticker,
					direction: trade.consensus?.decision,
					price: trade.referencePrice,
					assetClass: resolveAssetClassForTicker(trade.ticker),
				}, trade.riskCheck || {});
			}
		}

		const syncedPositions = await executor.syncJournalPositions({
			...options,
			journalDb: db,
			journalPath: this.resolveJournalPath(options),
		});
		const phaseResult = {
			phase: 'market_open',
			marketDate: this.state.meta.marketDate || toDateKey(options.date || new Date()),
			requiredTradingCapital,
			capitalRequest,
			executions,
			syncedPositions,
			asOf: new Date().toISOString(),
		};

		this.state.phases.marketOpen = phaseResult;
		return phaseResult;
	}

	async runMidDayCheck(options = {}) {
		const db = this.getJournalDb(options);
		const positions = await executor.getOpenPositions(options);
		const symbols = positions.map((position) => position.ticker).filter(Boolean);
		const snapshots = symbols.length > 0
			? await dataIngestion.getWatchlistSnapshots({ ...options, symbols })
			: new Map();
		const profitTargetPct = Number.isFinite(Number(options.profitTargetPct))
			? Number(options.profitTargetPct)
			: DEFAULT_PROFIT_TARGET_PCT;
		const reviews = positions.map((position) => {
			const snapshot = snapshots instanceof Map ? snapshots.get(position.ticker) : snapshots?.[position.ticker];
			const currentPrice = pickReferencePrice(snapshot);
			const pnlPct = position.avgPrice > 0 && currentPrice
				? (currentPrice - position.avgPrice) / position.avgPrice
				: null;
			return {
				...position,
				currentPrice,
				pnlPct,
				targetHit: pnlPct != null && pnlPct >= profitTargetPct,
			};
		});
		const exits = [];

		if (options.reviewOnly !== true) {
			for (const review of reviews.filter((position) => position.targetHit)) {
				const execution = await executor.submitOrder({
					ticker: review.ticker,
					direction: 'SELL',
					shares: review.shares,
					assetClass: review.assetClass,
					referencePrice: review.currentPrice,
					notes: `midday-profit-target:${(profitTargetPct * 100).toFixed(1)}%`,
				}, {
					...options,
					journalDb: db,
					journalPath: this.resolveJournalPath(options),
				});
				exits.push({
					ticker: review.ticker,
					currentPrice: review.currentPrice,
					pnlPct: review.pnlPct,
					execution,
				});
			}
		}

		const syncedPositions = await executor.syncJournalPositions({
			...options,
			journalDb: db,
			journalPath: this.resolveJournalPath(options),
		});
		const phaseResult = {
			phase: 'midday',
			marketDate: this.state.meta.marketDate || toDateKey(options.date || new Date()),
			profitTargetPct,
			reviews,
			exits,
			syncedPositions,
			asOf: new Date().toISOString(),
		};

		this.state.phases.midDay = phaseResult;
		return phaseResult;
	}

	async runMarketClose(options = {}) {
		const db = this.getJournalDb(options);
		const marketDate = this.state.meta.marketDate || toDateKey(options.date || new Date());
		const [portfolioSnapshot, openPositions] = await Promise.all([
			this.getUnifiedPortfolioSnapshot(options),
			executor.getOpenPositions(options),
		]);
		const accountState = this.buildAccountState(portfolioSnapshot, portfolioSnapshot?.positions || openPositions, db, options);
		const limits = options.limits || this.options.limits || riskEngine.DEFAULT_LIMITS;
		const killSwitch = riskEngine.checkKillSwitch(portfolioSnapshot, limits);
		const dailyPause = riskEngine.checkDailyPause(portfolioSnapshot, limits);
		let liquidation = null;

		if (killSwitch.triggered && options.autoLiquidate !== false) {
			liquidation = await executor.liquidateAllPositions({
				...options,
				journalDb: db,
				journalPath: this.resolveJournalPath(options),
			});
			if (options.sendKillSwitchAlert !== false) {
				telegramSummary.sendKillSwitchAlert({
					equity: accountState.equity,
					peakEquity: accountState.peakEquity,
					drawdownPct: killSwitch.drawdownPct,
				});
			}
		}

		const reconciliation = await this.runReconciliation({
			...options,
			date: marketDate,
			journalDb: db,
			journalPath: this.resolveJournalPath(options),
		});
		const syncedPositions = reconciliation.syncedPositions;
		const phaseResult = {
			phase: 'market_close',
			marketDate,
			accountState,
			openPositions,
			killSwitch,
			dailyPause,
			liquidation,
			reconciliation,
			syncedPositions,
			asOf: new Date().toISOString(),
		};

		this.state.phases.marketClose = phaseResult;
		return phaseResult;
	}

	applyWatchlistUpdates(options = {}) {
		const additions = Array.isArray(options.addToWatchlist) ? options.addToWatchlist : [];
		const removals = Array.isArray(options.removeFromWatchlist) ? options.removeFromWatchlist : [];

		for (const entry of additions) {
			if (!entry?.ticker) continue;
			watchlist.addToWatchlist(
				entry.ticker,
				entry.name || entry.ticker,
				entry.sector || 'Unspecified',
				entry.exchange,
				entry.broker,
				entry.assetClass || entry.asset_class
			);
		}

		for (const ticker of removals) {
			if (!ticker) continue;
			watchlist.removeFromWatchlist(ticker);
		}

		return watchlist.getWatchlist({ assetClass: options.assetClass || options.asset_class, includeAll: options.includeAll === true });
	}

	async runEndOfDay(options = {}) {
		const db = this.getJournalDb(options);
		const marketDate = this.state.meta.marketDate || toDateKey(options.date || new Date());
		const reconciliation = options.reconciliation
			|| (this.state.phases.reconciliation?.marketDate === marketDate ? this.state.phases.reconciliation : null)
			|| await this.runReconciliation({
				...options,
				date: marketDate,
				journalDb: db,
				journalPath: this.resolveJournalPath(options),
			});
		const [accountSnapshot] = await Promise.all([
			executor.getAccountSnapshot(options),
		]);
		const syncedPositions = Array.isArray(reconciliation?.syncedPositions)
			? reconciliation.syncedPositions
			: await executor.syncJournalPositions({
				...options,
				journalDb: db,
				journalPath: this.resolveJournalPath(options),
			});
		const accountState = this.buildAccountState(accountSnapshot, syncedPositions, db, { ...options, date: marketDate });
		const allTrades = journal.getAllTrades(db);
		const todaysTrades = allTrades.filter((trade) => {
			return String(trade.timestamp || '').startsWith(marketDate)
				&& String(trade.status || '').trim().toUpperCase() === 'FILLED';
		});
		const startEquity = accountState.dayStartEquity;
		const endEquity = accountState.equity;
		const pnl = endEquity - startEquity;
		const pnlPct = startEquity > 0 ? pnl / startEquity : 0;
		const drawdown = riskEngine.checkKillSwitch(accountState, options.limits || this.options.limits || riskEngine.DEFAULT_LIMITS);
		const consensusStats = this.summarizeConsensus(this.state.phases.consensus?.results || []);
		const realizedSummary = reconciliation?.dailySummary || summarizeDailyTradeOutcomes(allTrades, marketDate);
		const summaryRecord = {
			date: marketDate,
			startEquity,
			endEquity,
			pnl,
			pnlPct,
			tradesCount: realizedSummary.totalTrades,
			wins: realizedSummary.wins,
			losses: realizedSummary.losses,
			peakEquity: accountState.peakEquity,
			drawdownPct: drawdown.drawdownPct,
			bestTradeTicker: realizedSummary.bestTrade?.ticker || null,
			bestTradePnl: realizedSummary.bestTrade?.pnl ?? null,
			worstTradeTicker: realizedSummary.worstTrade?.ticker || null,
			worstTradePnl: realizedSummary.worstTrade?.pnl ?? null,
			notes: options.notes || null,
		};

		journal.recordDailySummary(db, summaryRecord);

		const updatedWatchlist = typeof options.updateWatchlist === 'function'
			? await options.updateWatchlist({
				watchlist: watchlist.getWatchlist({ assetClass: options.assetClass || options.asset_class }),
				trades: todaysTrades,
				accountState,
			})
			: this.applyWatchlistUpdates(options);

		if (options.sendTelegram !== false) {
			telegramSummary.sendDailySummary({
				date: marketDate,
				equity: endEquity,
				pnl,
				pnlPct,
				trades: todaysTrades.map((trade) => ({
					ticker: trade.ticker,
					direction: trade.direction,
					shares: trade.shares,
					price: Number(trade.price) || 0,
				})),
				openPositions: syncedPositions,
				peakEquity: accountState.peakEquity,
				weekPnlPct: Number(options.weekPnlPct) || 0,
				consensusStats,
			});
		}

		const phaseResult = {
			phase: 'end_of_day',
			marketDate,
			summary: summaryRecord,
			reconciliation,
			realizedSummary,
			trades: todaysTrades,
			openPositions: syncedPositions,
			consensusStats,
			watchlist: updatedWatchlist,
			asOf: new Date().toISOString(),
		};

		this.state.phases.endOfDay = phaseResult;
		return phaseResult;
	}

	async runFullDay(options = {}) {
		if (isPolymarketMode(options)) {
			const consensusPhase = await this.runPolymarketConsensusRound(options);
			const marketOpen = await this.runPolymarketMarketOpen({ ...options, consensusPhase });
			return {
				preMarket: null,
				consensus: consensusPhase,
				marketOpen,
				midDayCheck: null,
				marketClose: null,
				endOfDay: null,
			};
		}

		const preMarket = await this.runPreMarket(options);
		const consensusPhase = await this.runConsensusRound({ ...options, symbols: preMarket.symbols });
		const marketOpen = await this.runMarketOpen({ ...options, consensusPhase });
		const midDayCheck = await this.runMidDayCheck(options);
		const marketClose = await this.runMarketClose(options);
		const endOfDay = await this.runEndOfDay(options);

		return {
			preMarket,
			consensus: consensusPhase,
			marketOpen,
			midDayCheck,
			marketClose,
			endOfDay,
		};
	}
}

const defaultOrchestrator = new TradingOrchestrator();

module.exports = {
	TradingOrchestrator,
	createOrchestrator: (options = {}) => new TradingOrchestrator(options),
	registerSignal: defaultOrchestrator.registerSignal.bind(defaultOrchestrator),
	getRegisteredSignals: defaultOrchestrator.getRegisteredSignals.bind(defaultOrchestrator),
	clearSignals: defaultOrchestrator.clearSignals.bind(defaultOrchestrator),
	getCapitalAllocation: defaultOrchestrator.getCapitalAllocation.bind(defaultOrchestrator),
	returnIdleCapital: defaultOrchestrator.returnIdleCapital.bind(defaultOrchestrator),
	requestTradingCapital: defaultOrchestrator.requestTradingCapital.bind(defaultOrchestrator),
	runReconciliation: defaultOrchestrator.runReconciliation.bind(defaultOrchestrator),
	runPreMarket: defaultOrchestrator.runPreMarket.bind(defaultOrchestrator),
	runConsensusRound: defaultOrchestrator.runConsensusRound.bind(defaultOrchestrator),
	runMarketOpen: defaultOrchestrator.runMarketOpen.bind(defaultOrchestrator),
	runMidDayCheck: defaultOrchestrator.runMidDayCheck.bind(defaultOrchestrator),
	runMarketClose: defaultOrchestrator.runMarketClose.bind(defaultOrchestrator),
	runEndOfDay: defaultOrchestrator.runEndOfDay.bind(defaultOrchestrator),
	runFullDay: defaultOrchestrator.runFullDay.bind(defaultOrchestrator),
};
