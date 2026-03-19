'use strict';

const path = require('path');

const { getProjectRoot } = require('../../config');
const dataIngestion = require('./data-ingestion');
const watchlist = require('./watchlist');
const consensus = require('./consensus');
const agentAttribution = require('./agent-attribution');
const consultationStore = require('./consultation-store');
const riskEngine = require('./risk-engine');
const executor = require('./executor');
const journal = require('./journal');
const tradingScheduler = require('./scheduler');
const signalProducer = require('./signal-producer');
const telegramSummary = require('./telegram-summary');

const REQUIRED_AGENTS = Object.freeze(['architect', 'builder', 'oracle']);
const DEFAULT_MODELS = Object.freeze({
	architect: 'claude',
	builder: 'gpt',
	oracle: 'gemini',
});
const DEFAULT_PROFIT_TARGET_PCT = 0.05;
const DEFAULT_RECENT_TRADE_SCAN = 250;

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
	if (watchlist.normalizeAssetClass(assetClass) === 'crypto') {
		return Number(numeric.toFixed(6));
	}
	return toPositiveInteger(numeric);
}

function resolveAssetClassForTicker(ticker, fallback = 'us_equity') {
	return watchlist.getAssetClassForTicker(ticker, fallback);
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
		const dayStartEquity = toNumber(
			options.dayStartEquity
			?? this.state.meta.dayStartEquity
			?? accountSnapshot?.equity,
			0
		);
		const peakEquity = Math.max(
			toNumber(options.peakEquity ?? this.state.meta.peakEquity ?? accountSnapshot?.equity, 0),
			toNumber(accountSnapshot?.equity, 0)
		);

		this.state.meta.marketDate = marketDate;
		if (this.state.meta.dayStartEquity == null) this.state.meta.dayStartEquity = dayStartEquity;
		this.state.meta.peakEquity = peakEquity;

		return {
			equity: toNumber(accountSnapshot?.equity, 0),
			peakEquity,
			dayStartEquity,
			tradesToday: this.countTradesToday(db, marketDate, options),
			openPositions: Array.isArray(openPositions) ? openPositions : [],
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

	async runPreMarket(options = {}) {
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
		const db = this.getJournalDb(options);
		const symbols = normalizeSymbols(options.symbols, options);
		const premarketContext = this.state.phases.premarket?.marketContext || {};
		const snapshots = options.snapshots
			|| premarketContext.snapshots
			|| await dataIngestion.getWatchlistSnapshots({ ...options, symbols });
		const [bars, news, accountSnapshot, openPositions] = await Promise.all([
			options.bars
				|| dataIngestion.getHistoricalBars({
					...options,
					symbols,
					limit: 5,
					timeframe: '1Day',
				}).catch(() => new Map()),
			options.news
				|| premarketContext.news
				|| dataIngestion.getNews({ ...options, symbols, limit: Math.max(20, symbols.length * 3) }).catch(() => []),
			executor.getAccountSnapshot(options),
			executor.getOpenPositions(options),
		]);
		const consultation = await this.consultMissingSignals(symbols, {
			snapshots,
			bars,
			news,
			accountSnapshot,
		}, options);
		const autoGeneratedSignals = await this.backfillMissingSignals(symbols, options);
		const { completeSignals, incomplete } = this.buildSignalMap(symbols);
		const accountState = this.buildAccountState(accountSnapshot, openPositions, db, options);
		const limits = options.limits || this.options.limits || riskEngine.DEFAULT_LIMITS;
		const killSwitch = riskEngine.checkKillSwitch(accountState, limits);
		const dailyPause = riskEngine.checkDailyPause(accountState, limits);
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
			consultation,
			autoGeneratedSignals,
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
		const db = this.getJournalDb(options);
		const consensusPhase = options.consensusPhase || this.state.phases.consensus || await this.runConsensusRound(options);
		const approvedTrades = Array.isArray(options.approvedTrades) ? options.approvedTrades : consensusPhase.approvedTrades;
		const executions = [];
		let simulatedAccountState = cloneAccountState(consensusPhase.simulatedAccountState || consensusPhase.accountState || {});

		for (const trade of approvedTrades) {
			const execution = await executor.executeConsensusTrade({
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
		const [accountSnapshot, openPositions] = await Promise.all([
			executor.getAccountSnapshot(options),
			executor.getOpenPositions(options),
		]);
		const accountState = this.buildAccountState(accountSnapshot, openPositions, db, options);
		const limits = options.limits || this.options.limits || riskEngine.DEFAULT_LIMITS;
		const killSwitch = riskEngine.checkKillSwitch(accountState, limits);
		const dailyPause = riskEngine.checkDailyPause(accountState, limits);
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

		const syncedPositions = await executor.syncJournalPositions({
			...options,
			journalDb: db,
			journalPath: this.resolveJournalPath(options),
		});
		const phaseResult = {
			phase: 'market_close',
			marketDate: this.state.meta.marketDate || toDateKey(options.date || new Date()),
			accountState,
			openPositions,
			killSwitch,
			dailyPause,
			liquidation,
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
		const [accountSnapshot, syncedPositions] = await Promise.all([
			executor.getAccountSnapshot(options),
			executor.syncJournalPositions({
				...options,
				journalDb: db,
				journalPath: this.resolveJournalPath(options),
			}),
		]);
		const accountState = this.buildAccountState(accountSnapshot, syncedPositions, db, { ...options, date: marketDate });
		const recentTrades = journal.getRecentTrades(db, toPositiveInteger(options.recentTradeLimit) || DEFAULT_RECENT_TRADE_SCAN);
		const todaysTrades = recentTrades.filter((trade) => String(trade.timestamp || '').startsWith(marketDate));
		const startEquity = accountState.dayStartEquity;
		const endEquity = accountState.equity;
		const pnl = endEquity - startEquity;
		const pnlPct = startEquity > 0 ? pnl / startEquity : 0;
		const drawdown = riskEngine.checkKillSwitch(accountState, options.limits || this.options.limits || riskEngine.DEFAULT_LIMITS);
		const consensusStats = this.summarizeConsensus(this.state.phases.consensus?.results || []);
		const summaryRecord = {
			date: marketDate,
			startEquity,
			endEquity,
			pnl,
			pnlPct,
			tradesCount: todaysTrades.length,
			wins: toPositiveInteger(options.wins),
			losses: toPositiveInteger(options.losses),
			peakEquity: accountState.peakEquity,
			drawdownPct: drawdown.drawdownPct,
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
	runPreMarket: defaultOrchestrator.runPreMarket.bind(defaultOrchestrator),
	runConsensusRound: defaultOrchestrator.runConsensusRound.bind(defaultOrchestrator),
	runMarketOpen: defaultOrchestrator.runMarketOpen.bind(defaultOrchestrator),
	runMidDayCheck: defaultOrchestrator.runMidDayCheck.bind(defaultOrchestrator),
	runMarketClose: defaultOrchestrator.runMarketClose.bind(defaultOrchestrator),
	runEndOfDay: defaultOrchestrator.runEndOfDay.bind(defaultOrchestrator),
	runFullDay: defaultOrchestrator.runFullDay.bind(defaultOrchestrator),
};
