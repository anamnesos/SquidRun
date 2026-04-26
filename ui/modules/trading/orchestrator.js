'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');

const { getProjectRoot, resolveCoordPath } = require('../../config');
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
const macroRiskGate = require('./macro-risk-gate');
const tradingScheduler = require('./scheduler');
const signalProducer = require('./signal-producer');
const telegramSummary = require('./telegram-summary');
const yieldRouterModule = require('./yield-router');
const cryptoMechBoard = require('./crypto-mech-board');
const eventVeto = require('./event-veto');
const consensusSizer = require('./consensus-sizer');
const positionManagement = require('./position-management');
const bracketManager = require('./bracket-manager');
const signalValidationRecorder = require('./signal-validation-recorder');
const hyperliquidClient = require('./hyperliquid-client');
const hyperliquidNativeLayer = require('./hyperliquid-native-layer');
const multiTimeframeConfirmation = require('./multi-timeframe-confirmation');
const {
	STRATEGY_MODES,
	buildBrokerCapabilityPayload,
	deriveCrisisRiskLimits,
	estimateCrisisBookExposure,
	getCrisisUniverse,
	normalizeSignalDirection,
	validateCrisisSignalCapability,
} = require('./crisis-mode');

const REQUIRED_AGENTS = Object.freeze(['architect', 'builder', 'oracle']);
const DEFAULT_MODELS = Object.freeze({
	architect: 'claude',
	builder: 'gpt',
	oracle: 'gemini',
});
const LIVE_ETF_STRATEGY_SYMBOLS = Object.freeze(['SPY', 'QQQ', 'GLD', 'TLT', 'XLE']);
const DEFAULT_CRYPTO_MONITOR_SYMBOLS = Object.freeze(['BTC/USD', 'ETH/USD', 'SOL/USD']);
const DEFAULT_LIVE_ENTRY_MODE = 'unanimous_or_high';
const DEFAULT_LIVE_MIN_AGREE_CONFIDENCE = 0.6;
const DEFAULT_LIVE_MAX_IDEAS_PER_ROUND = 2;
const DEFAULT_PROFIT_TARGET_PCT = 0.08;
const DEFAULT_TRAILING_STOP_PCT = 0.04;
const DEFAULT_LIVE_MAX_POSITION_PCT = 0.025;
const DEFAULT_LIVE_EQUITY_LIMITS = Object.freeze({
	...riskEngine.DEFAULT_LIMITS,
	maxPositionPct: DEFAULT_LIVE_MAX_POSITION_PCT,
});
const DEFAULT_RECENT_TRADE_SCAN = 250;
const DEFAULT_ACTIVE_TRADING_RATIO = 0.4;
const DEFAULT_YIELD_ROUTER_RATIO = yieldRouterModule.DEFAULT_YIELD_TARGET_RATIO || 0.35;
const DEFAULT_RESERVE_RATIO = yieldRouterModule.DEFAULT_RESERVE_RATIO || 0.2;
const DEFAULT_DEFI_MONITOR_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_DEFI_MONITOR_TIMEOUT_MS = 30_000;
const DEFAULT_AUTO_EXECUTE_MIN_CONFIDENCE = 0.6;
const DEFAULT_HYPERLIQUID_AUTO_LEVERAGE = 5;
const DEFAULT_HYPERLIQUID_SCALP_LEVERAGE = 20;
const DEFAULT_HYPERLIQUID_AUTO_OPEN_ENABLED = false;
const DEFAULT_SMALL_WALLET_SINGLE_NAME_MAX_EQUITY = 1000;
const AUTONOMOUS_MAJOR_CRYPTO_TICKERS = Object.freeze(['BTC/USD', 'ETH/USD', 'SOL/USD']);
const DEFAULT_HYPERLIQUID_EXECUTION_RETRIES = Math.max(
	0,
	Number.parseInt(process.env.SQUIDRUN_HYPERLIQUID_EXECUTION_RETRIES || '2', 10) || 2
);
const DEFAULT_HYPERLIQUID_EXECUTION_RETRY_MS = Math.max(
	250,
	Number.parseInt(process.env.SQUIDRUN_HYPERLIQUID_EXECUTION_RETRY_MS || '2000', 10) || 2000
);
const DEFI_WARNING_RETAINED_PNL_RATIO = 0.7;
const DEFI_URGENT_RETAINED_PNL_RATIO = 0.5;
const DEFI_CRITICAL_LIQUIDATION_BUFFER_PCT = 0.15;

const execFileAsync = promisify(execFile);

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
	const normalized = normalizeSignalDirection(value, { strict: true });
	if (!['BUY', 'SELL', 'HOLD', 'SHORT', 'COVER', 'BUY_PUT'].includes(normalized)) {
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

function toIsoTimestamp(value, fallback = null) {
	if (value == null || value === '') return fallback;
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) return fallback;
	return date.toISOString();
}

function toNumber(value, fallback = 0) {
	const numeric = Number(value);
	return Number.isFinite(numeric) ? numeric : fallback;
}

function toPositiveInteger(value) {
	const numeric = Math.floor(Number(value));
	return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

function extractFirstJsonObject(rawText, fallback = {}) {
	const raw = String(rawText || '');
	for (let start = 0; start < raw.length; start += 1) {
		if (raw[start] !== '{') continue;
		let depth = 0;
		let inString = false;
		let escaped = false;
		for (let index = start; index < raw.length; index += 1) {
			const char = raw[index];
			if (inString) {
				if (escaped) {
					escaped = false;
					continue;
				}
				if (char === '\\') {
					escaped = true;
					continue;
				}
				if (char === '"') {
					inString = false;
				}
				continue;
			}
			if (char === '"') {
				inString = true;
				continue;
			}
			if (char === '{') {
				depth += 1;
				continue;
			}
			if (char !== '}') continue;
			depth -= 1;
			if (depth !== 0) continue;
			const candidate = raw.slice(start, index + 1);
			try {
				return JSON.parse(candidate);
			} catch {
				break;
			}
		}
	}
	return fallback;
}

function parseStoredJsonObject(rawValue, fallback = {}) {
	if (!rawValue) {
		return fallback;
	}
	if (typeof rawValue === 'object') {
		return rawValue;
	}
	try {
		return JSON.parse(String(rawValue));
	} catch {
		return extractFirstJsonObject(rawValue, fallback);
	}
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

function ensureSignalTickerTracked(ticker) {
	const normalizedTicker = toTicker(ticker);
	if (!normalizedTicker) return false;
	if (watchlist.isWatched(normalizedTicker)) return true;
	if (!/\/USD$/i.test(normalizedTicker)) return false;
	if (resolveAssetClassForTicker(normalizedTicker, 'us_equity') !== 'crypto') return false;
	return watchlist.addToWatchlist(
		normalizedTicker,
		normalizedTicker,
		'Crypto',
		'CRYPTO',
		'hyperliquid',
		'crypto'
	);
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

function roundCurrency(value) {
	return Number(toNumber(value, 0).toFixed(2));
}

function extractHyperliquidAssetFromTicker(ticker = '') {
	const normalized = String(ticker || '').trim().toUpperCase();
	return normalized.includes('/') ? normalized.split('/')[0] : normalized;
}

function isHyperliquidCryptoTicker(ticker = '') {
	return /\/USD$/i.test(String(ticker || '').trim());
}

function roundExecutionMargin(value) {
	const numeric = toNumber(value, 0);
	if (!Number.isFinite(numeric) || numeric <= 0) return null;
	return Math.floor(numeric * 1_000_000) / 1_000_000;
}

function round(value, digits = 4) {
	const numeric = Number(value);
	if (!Number.isFinite(numeric)) return 0;
	const scale = 10 ** digits;
	return Math.round(numeric * scale) / scale;
}

function toCliNumber(value) {
	const numeric = Number(value);
	if (!Number.isFinite(numeric)) return null;
	return String(Number(numeric.toFixed(6)));
}

function buildValidationId(ticker, observedAt, decision, marketDate) {
	const normalizedDecision = String(decision || 'UNKNOWN').trim().toUpperCase() || 'UNKNOWN';
	const normalizedMarketDate = String(marketDate || 'unknown').trim() || 'unknown';
	const input = [toTicker(ticker), toIsoTimestamp(observedAt, 'unknown'), normalizedDecision, normalizedMarketDate].join('::');
	return crypto.createHash('sha1').update(input).digest('hex');
}

function toRatio(value) {
	const numeric = Number(value);
	if (!Number.isFinite(numeric)) return null;
	return Math.max(0, numeric);
}

function buildHyperliquidClientOrderId(parts = []) {
	const fingerprint = parts
		.map((part) => String(part || '').trim())
		.filter(Boolean)
		.join('|');
	if (!fingerprint) return null;
	return `0x${crypto.createHash('sha256').update(fingerprint, 'utf8').digest('hex').slice(0, 32)}`;
}

function buildDecisionCoupledNativeEntry(nativeEntry = null, decision = null) {
	if (!nativeEntry || typeof nativeEntry !== 'object') {
		return nativeEntry || null;
	}
	const multiTimeframe = nativeEntry.multiTimeframe;
	if (!multiTimeframe || typeof multiTimeframe !== 'object') {
		return { ...nativeEntry };
	}
	const decisionState = multiTimeframeConfirmation.resolveDecisionState(multiTimeframe, decision);
	return {
		...nativeEntry,
		multiTimeframe: {
			...multiTimeframe,
			decision: String(decision || multiTimeframe.decision || '').trim().toUpperCase() || null,
			decisionState,
			status: decisionState?.status || null,
			sizeMultiplier: decisionState?.sizeMultiplier ?? null,
			statusBasis: decisionState ? 'decision' : (multiTimeframe.statusBasis || 'tape_state'),
			reasons: Array.isArray(decisionState?.reasons) && decisionState.reasons.length > 0
				? decisionState.reasons
				: (Array.isArray(multiTimeframe.reasons) ? multiTimeframe.reasons : []),
		},
	};
}

function sleepMs(ms = 0) {
	return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function classifyHyperliquidScriptResult(result = {}) {
	const stdout = String(result?.stdout || '');
	const stderr = String(result?.stderr || '');
	const errorText = String(result?.error || '');
	const combined = `${stdout}\n${stderr}\n${errorText}`.toLowerCase();
	const timedOut = result?.timedOut === true
		|| /timed?\s*out|timeout/i.test(errorText)
		|| String(result?.signal || '').trim().toUpperCase() === 'SIGTERM' && /timed?\s*out|timeout/i.test(combined);
	const insufficientFunds = /only \$[\d.]+ on hyperliquid|need at least \$10|deposit may still be arriving|insufficient(?:\s+\w+)*\s+balance/i.test(combined);
	const transient = timedOut
		|| /econnreset|etimedout|socket hang up|temporarily unavailable|rate limit|429|502|503|504|network|fetch failed|connection reset/i.test(combined);
	return {
		timedOut,
		insufficientFunds,
		transient,
		shouldRetry: transient && !insufficientFunds,
	};
}

function buildHyperliquidFundsAlert(execution = {}) {
	const asset = String(execution?.asset || execution?.ticker || 'asset').trim();
	const detail = String(execution?.stderr || execution?.stdout || execution?.error || '').trim();
	return [
		'[TRADING] Hyperliquid auto-execution skipped for insufficient funds.',
		`Asset: ${asset}`,
		detail ? `Detail: ${detail}` : null,
	].filter(Boolean).join('\n');
}

function buildDefiPositionKey(position = {}) {
	const coin = String(position.coin || position.asset || '').trim().toUpperCase();
	const side = String(position.side || '').trim().toLowerCase();
	return coin && side ? `${coin}:${side}` : coin;
}

function normalizeDefiPosition(position = {}) {
	const size = toNumber(position?.size ?? position?.szi, 0);
	const side = String(position?.side || '').trim().toLowerCase()
		|| (size < 0 ? 'short' : (size > 0 ? 'long' : 'flat'));
	const result = {
		coin: String(position?.coin || position?.asset || '').trim().toUpperCase(),
		size,
		side,
		entryPx: toNumber(position?.entryPx, 0),
		unrealizedPnl: roundCurrency(position?.unrealizedPnl),
		liquidationPx: toNumber(position?.liquidationPx, 0),
	};
	if (position?.stopLossPrice != null) result.stopLossPrice = toNumber(position.stopLossPrice, 0) || null;
	if (position?.takeProfitPrice != null) result.takeProfitPrice = toNumber(position.takeProfitPrice, 0) || null;
	if (position?.stopLossVerifiedAt) result.stopLossVerifiedAt = toIsoTimestamp(position.stopLossVerifiedAt, null);
	if (position?.takeProfitVerifiedAt) result.takeProfitVerifiedAt = toIsoTimestamp(position.takeProfitVerifiedAt, null);
	return result;
}

function formatRetainedPnlRatio(value) {
	if (!Number.isFinite(value)) return 'n/a';
	return `${(value * 100).toFixed(0)}%`;
}

function calculateLiquidationBufferRemainingPct(position = {}, markPrice = 0) {
	const liquidationPx = toNumber(position.liquidationPx, 0);
	const entryPx = toNumber(position.entryPx, 0);
	const side = String(position.side || '').trim().toLowerCase();
	const mark = toNumber(markPrice, 0);
	if (liquidationPx <= 0 || entryPx <= 0 || mark <= 0) {
		return null;
	}

	let totalRiskWindow = 0;
	let remainingRiskWindow = 0;
	if (side === 'short') {
		totalRiskWindow = liquidationPx - entryPx;
		remainingRiskWindow = liquidationPx - mark;
	} else if (side === 'long') {
		totalRiskWindow = entryPx - liquidationPx;
		remainingRiskWindow = mark - liquidationPx;
	} else {
		return null;
	}

	if (totalRiskWindow <= 0) {
		return null;
	}

	return Number(Math.max(0, Math.min(1, remainingRiskWindow / totalRiskWindow)).toFixed(4));
}

function buildDefiWarningMessage(position = {}, level = 'warning') {
	const retainedRatio = toRatio(position.retainedPeakRatio);
	const peakUnrealizedPnl = roundCurrency(position.peakUnrealizedPnl);
	const currentUnrealizedPnl = roundCurrency(position.unrealizedPnl);
	const sideLabel = String(position.side || '').trim().toUpperCase() || 'POSITION';
	if (String(level || '').trim().toLowerCase() === 'critical') {
		return `${position.coin} ${sideLabel} mark is within ${(DEFI_CRITICAL_LIQUIDATION_BUFFER_PCT * 100).toFixed(0)}% of liquidation (${formatRetainedPnlRatio(toRatio(position.liquidationDistancePct))} buffer remaining).`;
	}
	return `${position.coin} ${sideLabel} unrealized P&L is now $${currentUnrealizedPnl.toFixed(2)} vs peak $${peakUnrealizedPnl.toFixed(2)} (${formatRetainedPnlRatio(retainedRatio)} retained).`;
}

function buildDefiTelegramAlertsMessage(alerts = [], checkedAt = new Date().toISOString()) {
	if (alerts.length === 0) return '';
	const highestSeverity = alerts.some((entry) => entry.level === 'critical')
		? 'CRITICAL'
		: alerts.some((entry) => entry.level === 'urgent')
			? 'URGENT'
			: 'WARNING';
	const header = `${highestSeverity} Hyperliquid position alert (${checkedAt})`;
	const lines = alerts.map((entry) => `- ${buildDefiWarningMessage(entry.position, entry.level)}`);
	return [header, '', ...lines].join('\n');
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
	return {
		activeTrading,
		yield: yieldCapital,
		reserve,
		total: Number((activeTrading + yieldCapital + reserve).toFixed(6)),
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
		const matchedLots = [];
		while (remaining > 0.000001 && lots.length > 0) {
			const lot = lots[0];
			const matched = Math.min(remaining, lot.shares);
			costBasis += matched * lot.price;
			matchedShares += matched;
			matchedLots.push({
				tradeId: lot.tradeId,
				timestamp: lot.timestamp,
				shares: matched,
				price: lot.price,
			});
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
			matchedLots,
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

function resolveStrategyMode(macroRisk = null) {
	return String(macroRisk?.strategyMode || STRATEGY_MODES.NORMAL).trim().toLowerCase() || STRATEGY_MODES.NORMAL;
}

function averageConfidence(signals = []) {
	if (!Array.isArray(signals) || signals.length === 0) return 0;
	return signals.reduce((sum, signal) => sum + toConfidence(signal?.confidence), 0) / signals.length;
}

function resolveEntryMode(options = {}, orchestratorOptions = {}) {
	return String(
		options.entryMode
		|| options.consensusEntryMode
		|| orchestratorOptions.entryMode
		|| orchestratorOptions.consensusEntryMode
		|| DEFAULT_LIVE_ENTRY_MODE
	).trim().toLowerCase();
}

function resolveMinAgreeConfidence(options = {}, orchestratorOptions = {}) {
	return toNumber(
		options.minAgreeConfidence
		?? options.minConfidence
		?? orchestratorOptions.minAgreeConfidence
		?? orchestratorOptions.minConfidence,
		DEFAULT_LIVE_MIN_AGREE_CONFIDENCE
	);
}

function resolveMaxIdeasPerRound(options = {}, orchestratorOptions = {}) {
	if (String(options.strategyMode || orchestratorOptions.strategyMode || '').trim().toLowerCase() === 'range_conviction') {
		return 1;
	}
	return toPositiveInteger(
		options.maxIdeasPerRound
		?? options.maxIdeasPerStep
		?? orchestratorOptions.maxIdeasPerRound
		?? orchestratorOptions.maxIdeasPerStep
		?? DEFAULT_LIVE_MAX_IDEAS_PER_ROUND
	);
}

function resolveTradingStrategyMode(options = {}, macroRisk = null) {
	const explicit = String(options.strategyMode || '').trim().toLowerCase();
	return explicit || resolveStrategyMode(macroRisk);
}

function shouldTakeApprovedTrade(trade = {}, options = {}, orchestratorOptions = {}) {
	const entryMode = resolveEntryMode(options, orchestratorOptions);
	const agreeing = Array.isArray(trade?.consensus?.agreeing) ? trade.consensus.agreeing : [];
	const agreementCount = toNumber(trade?.consensus?.agreementCount, agreeing.length);
	const minAgreeConfidence = resolveMinAgreeConfidence(options, orchestratorOptions);
	const averageAgreeConfidence = averageConfidence(agreeing);

	if (entryMode === 'unanimous') {
		return {
			ok: agreementCount === 3,
			reason: `ENTRY_FILTER: unanimous requires 3 agreeing signals (got ${agreementCount})`,
			averageAgreeConfidence,
		};
	}
	if (entryMode === 'high_confidence') {
		return {
			ok: agreementCount >= 2 && averageAgreeConfidence > minAgreeConfidence,
			reason: `ENTRY_FILTER: high_confidence requires 2+ agreeing signals with average confidence > ${minAgreeConfidence.toFixed(2)} (got ${agreementCount} @ ${averageAgreeConfidence.toFixed(2)})`,
			averageAgreeConfidence,
		};
	}
	if (entryMode === 'unanimous_or_high') {
		return {
			ok: agreementCount === 3 || (agreementCount >= 2 && averageAgreeConfidence > minAgreeConfidence),
			reason: `ENTRY_FILTER: unanimous_or_high requires unanimity or 2+ agreeing signals with average confidence > ${minAgreeConfidence.toFixed(2)} (got ${agreementCount} @ ${averageAgreeConfidence.toFixed(2)})`,
			averageAgreeConfidence,
		};
	}
	return {
		ok: agreementCount >= 2,
		reason: `ENTRY_FILTER: majority requires 2+ agreeing signals (got ${agreementCount})`,
		averageAgreeConfidence,
	};
}

function selectTopTradeIdeas(candidates = [], options = {}, orchestratorOptions = {}) {
	const capped = resolveMaxIdeasPerRound(options, orchestratorOptions);
	const sorted = candidates.slice().sort((left, right) => {
		const leftConfidence = toNumber(left?.averageAgreeConfidence, averageConfidence(left?.consensus?.agreeing || []));
		const rightConfidence = toNumber(right?.averageAgreeConfidence, averageConfidence(right?.consensus?.agreeing || []));
		const leftRankScore = toNumber(left?.autoExecutionRankScore, leftConfidence);
		const rightRankScore = toNumber(right?.autoExecutionRankScore, rightConfidence);
		if (rightRankScore !== leftRankScore) {
			return rightRankScore - leftRankScore;
		}
		return rightConfidence - leftConfidence;
	});
	if (capped <= 0) {
		return {
			selected: sorted,
			excluded: [],
		};
	}
	return {
		selected: sorted.slice(0, capped),
		excluded: sorted.slice(capped),
	};
}

function isAutonomousMajorCryptoTicker(ticker = '') {
	return AUTONOMOUS_MAJOR_CRYPTO_TICKERS.includes(toTicker(ticker));
}

function hasActionableOracleSignal(signalLookup = {}, ticker = '') {
	const oracleSignal = signalLookup?.oracle || null;
	if (!oracleSignal) return false;
	if (ticker && toTicker(oracleSignal.ticker || ticker) !== toTicker(ticker)) {
		return false;
	}
	const direction = String(oracleSignal.direction || '').trim().toUpperCase();
	return direction !== '' && direction !== 'HOLD';
}

function narrowEventVetoForTicker(eventVetoValue = null, ticker = '') {
	if (!eventVetoValue || typeof eventVetoValue !== 'object') {
		return null;
	}
	const normalizedTicker = toTicker(ticker);
	const affectedAssets = Array.isArray(eventVetoValue.affectedAssets)
		? eventVetoValue.affectedAssets.map(toTicker).filter(Boolean)
		: [];
	if (affectedAssets.length > 0 && normalizedTicker && !affectedAssets.includes(normalizedTicker)) {
		return {
			...eventVetoValue,
			decision: 'CLEAR',
			sizeMultiplier: 1,
			affectedAssets: [],
			narrowedForTicker: normalizedTicker,
			narrowedFromDecision: String(eventVetoValue.decision || '').trim().toUpperCase() || 'CLEAR',
		};
	}
	return eventVetoValue;
}

function resolveHyperliquidWalletEquity(defiStatus = {}) {
	return toNumber(
		defiStatus?.accountValue
		?? defiStatus?.withdrawable
		?? defiStatus?.account?.equity
		?? defiStatus?.account?.cash,
		0
	);
}

function buildCryptoAutoExecutionPolicy(defiStatus = {}, macroRisk = null, options = {}, orchestratorOptions = {}) {
	const livePositions = Array.isArray(defiStatus?.positions) ? defiStatus.positions : [];
	const walletEquity = resolveHyperliquidWalletEquity(defiStatus);
	const subSmallWalletCap = toNumber(
		options.smallWalletSingleNameMaxEquity
		?? orchestratorOptions.smallWalletSingleNameMaxEquity,
		DEFAULT_SMALL_WALLET_SINGLE_NAME_MAX_EQUITY
	);
	const subSmallWallet = walletEquity > 0 && walletEquity < subSmallWalletCap;
	const flatWallet = livePositions.length === 0;
	const regime = String(macroRisk?.regime || '').trim().toLowerCase();
	const macroEligible = regime !== 'red' && regime !== 'stay_cash';
	const singleBestNameMode = subSmallWallet && flatWallet && macroEligible;
	return {
		walletEquity,
		subSmallWallet,
		flatWallet,
		macroEligible,
		singleBestNameMode,
		maxIdeasPerRound: singleBestNameMode
			? 1
			: resolveMaxIdeasPerRound(options, orchestratorOptions),
	};
}

function scoreTradeIdeaForAutoExecution(trade = {}) {
	const confidence = toNumber(
		trade?.averageAgreeConfidence,
		averageConfidence(trade?.consensus?.agreeing || [])
	);
	let score = confidence;
	if (hasActionableOracleSignal(trade?.signalLookup || {}, trade?.ticker)) {
		score += 0.2;
	}
	if (isAutonomousMajorCryptoTicker(trade?.ticker)) {
		score += 0.05;
	}
	if (String(trade?.sizeGuide?.bucket || 'normal').trim().toLowerCase() === 'normal') {
		score += 0.03;
	}
	if (String(trade?.mechanicalEntry?.tradeFlag || '').trim().toLowerCase() === 'trade') {
		score += 0.02;
	}
	return Number(score.toFixed(4));
}

function selectConvictionSignalMetadata(consensusResult = {}) {
	const agreeing = Array.isArray(consensusResult?.agreeing) ? consensusResult.agreeing : [];
	const ranked = agreeing
		.filter((signal) => {
			return Number.isFinite(Number(signal?.invalidationPrice))
				|| Number.isFinite(Number(signal?.takeProfitPrice))
				|| Number.isFinite(Number(signal?.leverage));
		})
		.slice()
		.sort((left, right) => toNumber(right?.confidence, 0) - toNumber(left?.confidence, 0));
	const signal = ranked[0] || null;
	if (!signal) return null;
	return {
		invalidationPrice: Number.isFinite(Number(signal?.invalidationPrice)) ? Number(signal.invalidationPrice) : null,
		takeProfitPrice: Number.isFinite(Number(signal?.takeProfitPrice)) ? Number(signal.takeProfitPrice) : null,
		leverage: toPositiveInteger(signal?.leverage) || null,
		strategyMode: String(signal?.strategyMode || '').trim().toLowerCase() || null,
		rangeStructure: signal?.rangeStructure || null,
	};
}

function buildRangeConvictionSingleThesisResult(signal = {}) {
	const ticker = toTicker(signal?.ticker);
	const decision = toDirection(signal?.direction || 'HOLD');
	const confidence = toConfidence(signal?.confidence);
	const actionable = decision !== 'HOLD';
	return {
		ticker,
		decision,
		consensus: actionable,
		agreementCount: actionable ? 1 : 0,
		confidence,
		averageAgreeConfidence: confidence,
		averageSignalConfidence: confidence,
		agreeing: actionable ? [signal] : [],
		dissenting: actionable ? [] : [signal],
		summary: actionable
			? `${ticker}: ${decision} — range_conviction single-thesis owner approved entry`
			: `${ticker}: HOLD — range_conviction thesis not actionable`,
	};
}

function resolveDefaultSymbols(symbols, options = {}, macroRisk = null) {
	const explicitSymbols = Array.isArray(symbols)
		? symbols
		: (symbols ? [symbols] : []);
	if (explicitSymbols.length > 0) {
		return normalizeSymbols(explicitSymbols, options);
	}

	const assetClass = watchlist.normalizeAssetClass(options.assetClass || options.asset_class, 'us_equity');
	if (assetClass === 'crypto') {
		const watchlistSymbols = watchlist.getTickers({ assetClass: 'crypto' });
		const fallbackSymbols = watchlistSymbols.length > 0 ? watchlistSymbols : DEFAULT_CRYPTO_MONITOR_SYMBOLS;
		return normalizeSymbols(fallbackSymbols, options);
	}
	if (resolveStrategyMode(macroRisk) === STRATEGY_MODES.CRISIS) {
		return normalizeSymbols(getCrisisUniverse(macroRisk), options);
	}
	return normalizeSymbols(LIVE_ETF_STRATEGY_SYMBOLS, options);
}

function buildCapabilityGateSignal(signal = {}, brokerCapabilities = null, macroRisk = null) {
	const normalized = {
		...signal,
		ticker: toTicker(signal.ticker),
		direction: normalizeSignalDirection(signal.direction),
		confidence: toConfidence(signal.confidence),
		reasoning: String(signal.reasoning || '').trim(),
	};
	const validation = validateCrisisSignalCapability(normalized, brokerCapabilities, macroRisk);
	if (validation.ok) {
		return normalized;
	}
	return {
		...normalized,
		direction: 'HOLD',
		confidence: Math.max(normalized.confidence, 0.74),
		reasoning: `${normalized.reasoning}${normalized.reasoning ? ' ' : ''}Capability gate blocked ${normalized.ticker}: ${validation.reason}`.trim(),
	};
}

function buildEffectiveRiskLimits(baseLimits = {}, macroRisk = null) {
	if (resolveStrategyMode(macroRisk) !== STRATEGY_MODES.CRISIS) {
		return baseLimits;
	}
	return deriveCrisisRiskLimits(baseLimits);
}

function resolveHyperliquidKillSwitchAction(options = {}, orchestratorOptions = {}) {
	const raw = String(
		options.hyperliquidKillSwitchAction
		?? options.killSwitchAction
		?? orchestratorOptions.hyperliquidKillSwitchAction
		?? orchestratorOptions.killSwitchAction
		?? 'block_new_entries'
	).trim().toLowerCase();
	return raw === 'flatten_positions' ? 'flatten_positions' : 'block_new_entries';
}

function extractHyperliquidProtectionFromOutput(output = '') {
	const text = String(output || '');
	const stopLossMatch = text.match(/Stop loss:\s*\$([0-9]+(?:\.[0-9]+)?)/i);
	const takeProfitMatch = text.match(/TP2:\s*\$([0-9]+(?:\.[0-9]+)?)/i);
	const stopLossPrice = toNumber(stopLossMatch?.[1], 0) || null;
	const takeProfitPrice = toNumber(takeProfitMatch?.[1], 0) || null;
	return {
		stopLossPrice,
		takeProfitPrice,
	};
}

function resolveLiveRiskLimits(options = {}, orchestratorOptions = {}, macroRisk = null) {
	const explicitLimits = options.limits || orchestratorOptions.limits;
	if (explicitLimits) {
		return explicitLimits;
	}
	const assetClass = watchlist.normalizeAssetClass(options.assetClass || options.asset_class, 'us_equity');
	if (assetClass === 'crypto') {
		return riskEngine.DEFAULT_CRYPTO_LIMITS;
	}
	if (resolveStrategyMode(macroRisk) === STRATEGY_MODES.CRISIS) {
		return DEFAULT_LIVE_EQUITY_LIMITS;
	}
	return DEFAULT_LIVE_EQUITY_LIMITS;
}

async function fetchBrokerCapabilities(symbols = [], options = {}) {
	const uniqueSymbols = Array.from(new Set((Array.isArray(symbols) ? symbols : []).map(toTicker).filter(Boolean)));
	if (uniqueSymbols.length === 0) return null;

	try {
		const client = options.alpacaClient
			|| options.client
			|| dataIngestion.createAlpacaClient(options);
		if (!client || typeof client.getAsset !== 'function' || typeof client.getAccount !== 'function') {
			return null;
		}

		const [account, assets] = await Promise.all([
			client.getAccount(),
			Promise.all(uniqueSymbols.map(async (ticker) => {
				try {
					return [ticker, await client.getAsset(ticker)];
				} catch {
					return [ticker, null];
				}
			})),
		]);

		return buildBrokerCapabilityPayload({
			account,
			assets: new Map(assets),
			phase: 'phase1',
		});
	} catch {
		return null;
	}
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
		defiMonitor: null,
	};
}

class TradingOrchestrator {
	constructor(options = {}) {
		this.options = { ...options };
		this.state = defaultState();
		this.defiMonitorTimer = null;
		if (this.shouldAutoStartDefiMonitor()) {
			this.startDefiMonitor();
		}
	}

	shouldAutoStartDefiMonitor() {
		if (this.options.defiMonitorEnabled === false || this.options.enableDefiMonitor === false) {
			return false;
		}
		if (this.options.defiMonitorAutoStart !== true) {
			return false;
		}
		if (process.env.SQUIDRUN_DEFI_MONITOR === '0') {
			return false;
		}
		return true;
	}

	resolveDefiStatusScriptPath(options = {}) {
		return options.defiStatusScriptPath
			|| this.options.defiStatusScriptPath
			|| path.join(getProjectRoot(), 'ui', 'scripts', 'hm-defi-status.js');
	}

	resolveDefiPeakPnlPath(options = {}) {
		return options.defiPeakPnlPath
			|| this.options.defiPeakPnlPath
			|| resolveCoordPath(path.join('runtime', 'defi-peak-pnl.json'), { forWrite: true });
	}

	resolveDefiMonitorIntervalMs(options = {}) {
		return Math.max(
			1_000,
			toPositiveInteger(options.defiMonitorIntervalMs || this.options.defiMonitorIntervalMs || DEFAULT_DEFI_MONITOR_INTERVAL_MS)
		) || DEFAULT_DEFI_MONITOR_INTERVAL_MS;
	}

	resolveAutoExecutionMinConfidence(options = {}) {
		const threshold = Number(
			options.autoExecuteMinConfidence
			?? this.options.autoExecuteMinConfidence
			?? DEFAULT_AUTO_EXECUTE_MIN_CONFIDENCE
		);
		if (!Number.isFinite(threshold)) return DEFAULT_AUTO_EXECUTE_MIN_CONFIDENCE;
		return Math.max(0, Math.min(1, threshold));
	}

	resolveHyperliquidExecuteScriptPath(options = {}) {
		return options.hyperliquidExecuteScriptPath
			|| this.options.hyperliquidExecuteScriptPath
			|| path.join(getProjectRoot(), 'ui', 'scripts', 'hm-defi-execute.js');
	}

	resolveHyperliquidCloseScriptPath(options = {}) {
		return options.hyperliquidCloseScriptPath
			|| this.options.hyperliquidCloseScriptPath
			|| path.join(getProjectRoot(), 'ui', 'scripts', 'hm-defi-close.js');
	}

	async runHyperliquidScript(scriptPath, args = [], options = {}) {
		const timeout = Math.max(
			1_000,
			toPositiveInteger(options.hyperliquidExecutionTimeoutMs || this.options.hyperliquidExecutionTimeoutMs || 120_000)
		) || 120_000;
		const maxRetries = Math.max(
			0,
			toPositiveInteger(options.hyperliquidExecutionRetries ?? this.options.hyperliquidExecutionRetries ?? DEFAULT_HYPERLIQUID_EXECUTION_RETRIES)
		);
		const retryDelayMs = Math.max(
			250,
			toPositiveInteger(options.hyperliquidExecutionRetryMs ?? this.options.hyperliquidExecutionRetryMs ?? DEFAULT_HYPERLIQUID_EXECUTION_RETRY_MS)
		) || DEFAULT_HYPERLIQUID_EXECUTION_RETRY_MS;
		let attempts = 0;
		let finalResult = null;

		while (attempts <= maxRetries) {
			attempts += 1;
			try {
				const { stdout = '', stderr = '' } = await execFileAsync(process.execPath, [scriptPath, ...args], {
					cwd: getProjectRoot(),
					windowsHide: true,
					timeout,
					env: options.hyperliquidExecutionEnv || this.options.hyperliquidExecutionEnv || process.env,
				});
				finalResult = {
					ok: true,
					exitCode: 0,
					stdout,
					stderr,
					timedOut: false,
					attemptCount: attempts,
					recoveredAfterRetry: attempts > 1,
				};
				break;
			} catch (error) {
				const attemptResult = {
					ok: false,
					exitCode: Number.isFinite(Number(error?.code)) ? Number(error.code) : null,
					error: error?.message || String(error),
					stdout: error?.stdout || '',
					stderr: error?.stderr || '',
					signal: error?.signal || null,
					timedOut: Boolean(error?.killed) && String(error?.signal || '').trim().toUpperCase() === 'SIGTERM'
						? /timed?\s*out|timeout/i.test(String(error?.message || ''))
						: /timed?\s*out|timeout/i.test(String(error?.message || '')),
					attemptCount: attempts,
				};
				const classification = classifyHyperliquidScriptResult(attemptResult);
				if (classification.shouldRetry && attempts <= maxRetries) {
					await sleepMs(retryDelayMs * attempts);
					continue;
				}
				finalResult = {
					...attemptResult,
					...classification,
				};
				break;
			}
		}

		return finalResult || {
			ok: false,
			exitCode: null,
			error: 'hyperliquid_script_failed',
			stdout: '',
			stderr: '',
			timedOut: false,
			attemptCount: attempts,
		};
	}

	loadDefiPeakState(options = {}) {
		const statePath = this.resolveDefiPeakPnlPath(options);
		try {
			if (!fs.existsSync(statePath)) {
				return { path: statePath, updatedAt: null, positions: {} };
			}
			const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
			return {
				path: statePath,
				updatedAt: parsed?.updatedAt || null,
				positions: parsed && typeof parsed.positions === 'object' && !Array.isArray(parsed.positions)
					? parsed.positions
					: {},
			};
		} catch {
			return { path: statePath, updatedAt: null, positions: {} };
		}
	}

	saveDefiPeakState(state = {}, options = {}) {
		const statePath = this.resolveDefiPeakPnlPath(options);
		fs.mkdirSync(path.dirname(statePath), { recursive: true });
		fs.writeFileSync(statePath, JSON.stringify({
			updatedAt: state.updatedAt || new Date().toISOString(),
			positions: state.positions || {},
		}, null, 2));
		return statePath;
	}

	async fetchDefiStatus(options = {}) {
		const provider = options.defiStatusProvider || this.options.defiStatusProvider;
		if (typeof provider === 'function') {
			return provider({
				trigger: options.trigger || 'manual',
				orchestrator: this,
			});
		}
		if (
			process.env.NODE_ENV === 'test'
			&& options.allowExecDefiStatusScript !== true
			&& this.options.allowExecDefiStatusScript !== true
		) {
			return {
				ok: true,
				checkedAt: new Date().toISOString(),
				positions: [],
			};
		}

		const scriptPath = this.resolveDefiStatusScriptPath(options);
		const timeout = Math.max(
			1_000,
			toPositiveInteger(options.defiMonitorTimeoutMs || this.options.defiMonitorTimeoutMs || DEFAULT_DEFI_MONITOR_TIMEOUT_MS)
		) || DEFAULT_DEFI_MONITOR_TIMEOUT_MS;
		const { stdout } = await execFileAsync(process.execPath, [scriptPath, '--json'], {
			cwd: getProjectRoot(),
			env: {
				...process.env,
				SQUIDRUN_HYPERLIQUID_CALLER: 'supervisor',
			},
			windowsHide: true,
			timeout,
		});
		return extractFirstJsonObject(stdout, {});
	}

	async fetchHyperliquidOpenOrders(options = {}) {
		if (process.env.NODE_ENV === 'test' && !options.allowExecDefiStatusScript) {
			return [];
		}
		try {
			const walletAddress = String(
				process.env.HYPERLIQUID_WALLET_ADDRESS
				|| process.env.HYPERLIQUID_ADDRESS
				|| process.env.POLYMARKET_FUNDER_ADDRESS
				|| ''
			).trim();
			if (!walletAddress) return [];
			return await hyperliquidClient.getOpenOrders({
				walletAddress,
			});
		} catch (_err) {
			return [];
		}
	}

	normalizeDefiStatus(status = {}, options = {}) {
		const checkedAt = (() => {
			const value = status?.checkedAt || options.checkedAt || new Date().toISOString();
			const parsed = new Date(value);
			return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
		})();
		const positions = (Array.isArray(status?.positions) ? status.positions : [])
			.map((position) => normalizeDefiPosition(position))
			.filter((position) => position.coin && Math.abs(position.size) > 0);

		return {
			ok: status?.ok !== false,
			checkedAt,
			walletAddress: status?.walletAddress || null,
			accountValue: roundCurrency(status?.accountValue),
			totalMarginUsed: roundCurrency(status?.totalMarginUsed),
			withdrawable: roundCurrency(status?.withdrawable),
			error: status?.error ? String(status.error) : null,
			positions,
		};
	}

	buildDefiConsultationWarnings(defiStatus = {}) {
		return (Array.isArray(defiStatus.warnings) ? defiStatus.warnings : []).map((warning) => ({
			level: warning.level,
			code: warning.code,
			ticker: warning.ticker,
			coin: warning.coin,
			message: warning.message,
			positionKey: warning.positionKey,
			retainedPeakRatio: warning.retainedPeakRatio ?? null,
		}));
	}

	buildEventVetoConsultationWarnings(eventVeto = {}, symbols = []) {
		if (!eventVeto || typeof eventVeto !== 'object') return [];
		const decision = String(eventVeto.decision || '').trim().toUpperCase();
		const sourceTier = String(eventVeto.sourceTier || '').trim().toLowerCase();
		if (!['CAUTION', 'DEGRADED'].includes(decision) || sourceTier !== 'none') {
			return [];
		}
		return [{
			level: 'warning',
			code: 'event_veto_news_blind',
			ticker: symbols[0] || null,
			message: String(eventVeto.eventSummary || 'Live tier-1 event scan unavailable; treat news context as degraded.'),
		}];
	}

	buildPositionManagementContext(defiStatus = {}, marketContext = {}, riskState = {}) {
		return positionManagement.buildPositionManagementContext(defiStatus, marketContext, riskState);
	}

	evaluatePositionManagement(defiStatus = {}, marketContext = {}, riskState = {}) {
		return positionManagement.positionManagement(defiStatus, marketContext, riskState);
	}

	processDefiMonitorStatus(liveStatus = {}, options = {}) {
		const checkedAt = (() => {
			const value = options.checkedAt || liveStatus?.checkedAt || new Date().toISOString();
			const parsed = new Date(value);
			return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
		})();
		const trigger = options.trigger || 'manual';
		const sendTelegram = options.sendTelegram !== false;
		const peakState = this.loadDefiPeakState(options);
		const normalized = this.normalizeDefiStatus(liveStatus, { checkedAt });
		const nextPositions = {};
		const enrichedPositions = [];
		const warnings = [];
		const telegramAlerts = [];

		for (const position of normalized.positions) {
			const positionKey = buildDefiPositionKey(position);
			const previous = peakState.positions?.[positionKey] || {};
			const firstSeenAt = previous.firstSeenAt || checkedAt;
			const previousPeak = Math.max(toNumber(previous.peakUnrealizedPnl, 0), 0);
			const peakUnrealizedPnl = Math.max(previousPeak, toNumber(position.unrealizedPnl, 0), 0);
			const timeOpenMs = Math.max(
				0,
				(new Date(checkedAt).getTime()) - (new Date(firstSeenAt).getTime())
			);
			const markPrice = Math.abs(toNumber(position.size, 0)) > 0
				? Number((toNumber(position.entryPx, 0) + (toNumber(position.unrealizedPnl, 0) / toNumber(position.size, 0))).toFixed(4))
				: 0;
			const liquidationDistancePct = calculateLiquidationBufferRemainingPct(position, markPrice);
			const retainedPeakRatio = peakUnrealizedPnl > 0
				? Number((toNumber(position.unrealizedPnl, 0) / peakUnrealizedPnl).toFixed(4))
				: null;
			const drawdownFromPeakPct = retainedPeakRatio == null
				? 0
				: Number(Math.max(0, Math.min(1, 1 - retainedPeakRatio)).toFixed(4));
			const givebackAlertThreshold = drawdownFromPeakPct >= 0.5
				? 0.5
				: (drawdownFromPeakPct >= 0.3 ? 0.3 : 0);
			const previousGivebackAlertThreshold = toNumber(previous.givebackAlertThreshold, 0);
			const stopLossPrice = position.stopLossVerifiedAt
				? (toNumber(position.stopLossPrice, 0) || null)
				: null;
			let warningLevel = null;
			if (liquidationDistancePct != null && liquidationDistancePct <= DEFI_CRITICAL_LIQUIDATION_BUFFER_PCT) {
				warningLevel = 'critical';
			} else if (peakUnrealizedPnl > 0) {
				if (toNumber(position.unrealizedPnl, 0) <= peakUnrealizedPnl * DEFI_URGENT_RETAINED_PNL_RATIO) {
					warningLevel = 'urgent';
				} else if (toNumber(position.unrealizedPnl, 0) <= peakUnrealizedPnl * DEFI_WARNING_RETAINED_PNL_RATIO) {
					warningLevel = 'warning';
				}
			}

			const enrichedPosition = {
				...position,
				positionKey,
				peakUnrealizedPnl: roundCurrency(peakUnrealizedPnl),
				firstSeenAt,
				timeOpenMs,
				markPrice,
				liquidationDistancePct,
				retainedPeakRatio,
				drawdownFromPeakPct,
				givebackAlertThreshold,
				previousGivebackAlertThreshold,
				stopLossPrice,
				stopLossVerifiedAt: position.stopLossVerifiedAt || null,
				takeProfitPrice: position.takeProfitVerifiedAt
					? (toNumber(position.takeProfitPrice, 0) || null)
					: null,
				takeProfitVerifiedAt: position.takeProfitVerifiedAt || null,
				warningLevel,
			};
			enrichedPositions.push(enrichedPosition);

			if (warningLevel) {
				warnings.push({
					level: warningLevel,
					code: warningLevel === 'critical' ? 'defi_liquidation_risk_critical' : `defi_profit_giveback_${warningLevel}`,
					ticker: `${position.coin}/USD`,
					coin: position.coin,
					positionKey,
					retainedPeakRatio,
					liquidationDistancePct,
					message: buildDefiWarningMessage(enrichedPosition, warningLevel),
				});
			}
			if (warningLevel && previous.lastAlertLevel !== warningLevel) {
				telegramAlerts.push({
					level: warningLevel,
					position: enrichedPosition,
				});
			}

			nextPositions[positionKey] = {
				coin: position.coin,
				side: position.side,
				size: position.size,
				entryPx: position.entryPx,
				unrealizedPnl: enrichedPosition.unrealizedPnl,
				liquidationPx: position.liquidationPx,
				peakUnrealizedPnl: enrichedPosition.peakUnrealizedPnl,
				firstSeenAt,
				timeOpenMs,
				markPrice,
				liquidationDistancePct,
				retainedPeakRatio,
				drawdownFromPeakPct,
				givebackAlertThreshold,
				stopLossPrice,
				stopLossVerifiedAt: position.stopLossVerifiedAt || null,
				takeProfitPrice: position.takeProfitVerifiedAt
					? (toNumber(position.takeProfitPrice, 0) || null)
					: null,
				takeProfitVerifiedAt: position.takeProfitVerifiedAt || null,
				lastAlertLevel: warningLevel,
				lastAlertSentAt: warningLevel && previous.lastAlertLevel !== warningLevel ? checkedAt : (previous.lastAlertSentAt || null),
				updatedAt: checkedAt,
			};
		}

		peakState.updatedAt = checkedAt;
		peakState.positions = nextPositions;
		this.saveDefiPeakState(peakState, options);

		const result = {
			...normalized,
			trigger,
			positions: enrichedPositions,
			warnings,
			telegramAlerts,
			peakStatePath: peakState.path,
		};

		if (telegramAlerts.length > 0 && sendTelegram) {
			try {
				telegramSummary.sendTelegram(buildDefiTelegramAlertsMessage(telegramAlerts, checkedAt));
			} catch (error) {
				result.warnings.push({
					level: 'warning',
					code: 'defi_telegram_alert_failed',
					message: `Hyperliquid urgent alert failed: ${error?.message || String(error)}`,
				});
			}
		}

		this.state.defiMonitor = result;
		return result;
	}

	async runDefiMonitorCycle(options = {}) {
		const checkedAt = new Date().toISOString();
		const trigger = options.trigger || 'manual';
		const peakState = this.loadDefiPeakState(options);
		let liveStatus;

		try {
			liveStatus = await this.fetchDefiStatus({ ...options, trigger });
		} catch (error) {
			const failed = {
				ok: false,
				trigger,
				checkedAt,
				error: error?.message || String(error),
				positions: [],
				warnings: [{
					level: 'warning',
					code: 'defi_status_unavailable',
					message: `Hyperliquid status check failed: ${error?.message || String(error)}`,
				}],
				telegramAlerts: [],
				peakStatePath: peakState.path,
			};
			this.state.defiMonitor = failed;
			return failed;
		}

		// Enrich positions with on-exchange stop/TP from open orders
		try {
			const openOrders = await this.fetchHyperliquidOpenOrders(options);
			if (Array.isArray(openOrders) && openOrders.length > 0 && Array.isArray(liveStatus.positions)) {
				for (const position of liveStatus.positions) {
					const coin = position.coin || position.asset;
					if (!coin) continue;
					const reduceOnlyOrders = openOrders.filter(
						(o) => o.coin === coin && o.reduceOnly === true
					);
					const protection = bracketManager.deriveExchangeProtection(position, reduceOnlyOrders);
					position.stopLossPrice = protection.activeStopPrice;
					position.takeProfitPrice = protection.activeTakeProfitPrice;
					position.stopLossVerifiedAt = protection.verified ? checkedAt : null;
					position.takeProfitVerifiedAt = protection.verified ? checkedAt : null;
				}
			}
		} catch (_err) {
			// Non-fatal: proceed with positions as-is if order query fails
		}

		return this.processDefiMonitorStatus(liveStatus, {
			...options,
			checkedAt,
			trigger,
		});
	}

	async syncDefiPeakStateFromStatus(status = {}, options = {}) {
		return this.processDefiMonitorStatus(status, {
			...options,
			sendTelegram: options.sendTelegram === true,
		});
	}

	updateDefiPeakStateForExecution(entry = {}, options = {}) {
		const state = this.loadDefiPeakState(options);
		const asset = extractHyperliquidAssetFromTicker(entry.asset || entry.ticker || '');
		if (!asset) {
			return state.path;
		}
		const positions = state.positions && typeof state.positions === 'object' ? { ...state.positions } : {};
		const updatedAt = entry.executedAt || new Date().toISOString();
		if (entry.action === 'close') {
			for (const key of Object.keys(positions)) {
				if (String(key || '').toUpperCase().startsWith(`${asset}:`)) {
					delete positions[key];
				}
			}
		} else if (entry.action === 'open') {
			const side = String(entry.side || '').trim().toLowerCase() === 'short' ? 'short' : 'long';
			const key = buildDefiPositionKey({ coin: asset, side });
			const previous = positions[key] || {};
			positions[key] = {
				...previous,
				coin: asset,
				side,
				stopLossPrice: toNumber(entry.stopLossPrice, 0) || previous.stopLossPrice || null,
				peakUnrealizedPnl: Math.max(toNumber(previous.peakUnrealizedPnl, 0), 0),
				firstSeenAt: previous.firstSeenAt || updatedAt,
				updatedAt,
			};
		} else if (entry.action === 'tighten_stop') {
			for (const key of Object.keys(positions)) {
				if (!String(key || '').toUpperCase().startsWith(`${asset}:`)) {
					continue;
				}
				const previous = positions[key] || {};
				positions[key] = {
					...previous,
					stopLossPrice: toNumber(entry.stopLossPrice, 0) || previous.stopLossPrice || null,
					updatedAt,
				};
			}
		}
		state.updatedAt = updatedAt;
		state.positions = positions;
		this.saveDefiPeakState(state, options);
		return state.path;
	}

	resolveHyperliquidExecutionLeverage(approvedTrade = {}, options = {}) {
		const scalpModeArmed = options.hyperliquidScalpModeArmed === true
			|| this.options.hyperliquidScalpModeArmed === true
			|| String(process.env.SQUIDRUN_HYPERLIQUID_SCALP_MODE || '').trim() === '1';
		const candidates = [
			approvedTrade?.riskCheck?.leverage,
			approvedTrade?.consensus?.leverage,
			options.hyperliquidExecutionLeverage,
			this.options.hyperliquidExecutionLeverage,
			process.env.SQUIDRUN_HYPERLIQUID_DEFAULT_LEVERAGE,
			scalpModeArmed ? DEFAULT_HYPERLIQUID_SCALP_LEVERAGE : DEFAULT_HYPERLIQUID_AUTO_LEVERAGE,
		];
		for (const candidate of candidates) {
			const numeric = toPositiveInteger(candidate);
			if (numeric > 0) {
				return numeric;
			}
		}
		return scalpModeArmed ? DEFAULT_HYPERLIQUID_SCALP_LEVERAGE : DEFAULT_HYPERLIQUID_AUTO_LEVERAGE;
	}

	resolveHyperliquidExecutionMargin(approvedTrade = {}, leverage = DEFAULT_HYPERLIQUID_AUTO_LEVERAGE) {
		const explicitMargin = roundExecutionMargin(approvedTrade?.riskCheck?.margin);
		if (explicitMargin) {
			return explicitMargin;
		}
		const referencePrice = toNumber(approvedTrade?.referencePrice, 0);
		const requestedShares = toNumber(approvedTrade?.riskCheck?.maxShares, 0);
		const resolvedLeverage = toPositiveInteger(leverage);
		if (referencePrice <= 0 || requestedShares <= 0 || resolvedLeverage <= 0) {
			return null;
		}
		return roundExecutionMargin((referencePrice * requestedShares) / resolvedLeverage);
	}

	resolveHyperliquidAutoOpenEnabled(options = {}) {
		if (
			options.hyperliquidScalpModeArmed === true
			|| this.options.hyperliquidScalpModeArmed === true
			|| String(process.env.SQUIDRUN_HYPERLIQUID_SCALP_MODE || '').trim() === '1'
		) {
			return true;
		}
		if (options.allowHyperliquidAutoOpen === true || this.options.allowHyperliquidAutoOpen === true) {
			return true;
		}
		if (options.allowHyperliquidAutoOpen === false || this.options.allowHyperliquidAutoOpen === false) {
			return false;
		}
		if (String(process.env.SQUIDRUN_ALLOW_HYPERLIQUID_AUTO_OPEN || '').trim() === '1') {
			return true;
		}
		return DEFAULT_HYPERLIQUID_AUTO_OPEN_ENABLED;
	}

	buildHyperliquidAutoOpenClientOrderId(result = {}, approvedTrade = {}, options = {}) {
		return buildHyperliquidClientOrderId([
			options.consultationRequestId,
			options.requestId,
			approvedTrade?.consultationRequestId,
			approvedTrade?.requestId,
			result?.ticker,
			result?.decision,
			Number(result?.confidence || 0).toFixed(4),
			this.resolveHyperliquidExecutionLeverage(approvedTrade, options),
			this.resolveHyperliquidExecutionMargin(approvedTrade, this.resolveHyperliquidExecutionLeverage(approvedTrade, options)),
			toNumber(approvedTrade?.riskCheck?.stopLossPrice, 0).toFixed(6),
		]);
	}

	async maybeAutoExecuteLiveConsensus(results = [], approvedTrades = [], defiStatus = {}, options = {}) {
		if (options.autoExecuteLiveConsensus !== true && this.options.autoExecuteLiveConsensus !== true) {
			return {
				enabled: false,
				attempted: 0,
				succeeded: 0,
				executions: [],
				skipped: [],
			};
		}

		const executeScriptPath = this.resolveHyperliquidExecuteScriptPath(options);
		const closeScriptPath = this.resolveHyperliquidCloseScriptPath(options);
		const minConfidence = this.resolveAutoExecutionMinConfidence(options);
		const allowAutoOpen = this.resolveHyperliquidAutoOpenEnabled(options);
		const killSwitchTriggered = options.killSwitchTriggered === true;
		const killSwitchAction = resolveHyperliquidKillSwitchAction(options, this.options);
		const dryRun = options.hyperliquidExecutionDryRun === true || this.options.hyperliquidExecutionDryRun === true;
		const livePositions = Array.isArray(defiStatus?.positions) ? defiStatus.positions : [];
		const positionsByAsset = new Map(
			livePositions
				.filter((position) => position?.coin)
				.map((position) => [String(position.coin || '').trim().toUpperCase(), position])
		);
		const approvedByTicker = new Map(
			(Array.isArray(approvedTrades) ? approvedTrades : []).map((trade) => [toTicker(trade?.ticker), trade])
		);
		const autoExecutionPolicy = options.autoExecutionPolicy && typeof options.autoExecutionPolicy === 'object'
			? options.autoExecutionPolicy
			: buildCryptoAutoExecutionPolicy(defiStatus, options.macroRisk || null, options, this.options);
		const rankedApprovedTrades = (Array.isArray(approvedTrades) ? approvedTrades : [])
			.slice()
			.sort((left, right) => {
				const leftScore = toNumber(left?.autoExecutionRankScore, scoreTradeIdeaForAutoExecution(left));
				const rightScore = toNumber(right?.autoExecutionRankScore, scoreTradeIdeaForAutoExecution(right));
				return rightScore - leftScore;
			});
		const topSingleBestTrade = autoExecutionPolicy.singleBestNameMode
			? rankedApprovedTrades.find((trade) => hasActionableOracleSignal(trade?.signalLookup || {}, trade?.ticker))
			: null;
		const singleBestTicker = toTicker(topSingleBestTrade?.ticker);
		const executions = [];
		const skipped = [];
		const positionManagementPlan = options.positionManagementPlan && typeof options.positionManagementPlan === 'object'
			? options.positionManagementPlan
			: null;
		const positionManagedAssets = new Set(
			(Array.isArray(positionManagementPlan?.managedTickers) ? positionManagementPlan.managedTickers : [])
				.map((ticker) => extractHyperliquidAssetFromTicker(ticker))
				.filter(Boolean)
		);
		const executionManagedAssets = new Set();

		if (killSwitchTriggered) {
			if (killSwitchAction !== 'flatten_positions') {
				return {
					enabled: true,
					attempted: 0,
					succeeded: 0,
					executions: [],
					skipped: [{
						reason: 'kill_switch_block_new_entries',
						action: killSwitchAction,
						openPositions: livePositions.length,
					}],
					killSwitchTriggered: true,
					killSwitchAction,
				};
			}

			for (const position of livePositions) {
				const asset = extractHyperliquidAssetFromTicker(position?.coin || position?.asset || position?.ticker || '');
				if (!asset || executionManagedAssets.has(asset)) continue;
				const args = dryRun ? ['--dry-run', '--asset', asset] : ['--asset', asset];
				const commandResult = await this.runHyperliquidScript(closeScriptPath, args, options);
				const execution = {
					ticker: `${asset}/USD`,
					asset,
					action: 'close',
					source: 'kill_switch_flatten',
					confidence: null,
					dryRun,
					ok: commandResult.ok !== false,
					scriptPath: closeScriptPath,
					args,
					stdout: commandResult.stdout || '',
					stderr: commandResult.stderr || '',
					error: commandResult.error || null,
				};
				executions.push(execution);
				executionManagedAssets.add(asset);
				if (execution.ok) {
					this.updateDefiPeakStateForExecution({
						action: 'close',
						asset,
						executedAt: new Date().toISOString(),
					}, options);
					positionsByAsset.delete(asset);
				}
			}

			return {
				enabled: true,
				attempted: executions.length,
				succeeded: executions.filter((execution) => execution.ok).length,
				executions,
				skipped: executions.length === 0
					? [{
						reason: 'kill_switch_flatten_no_positions',
						action: killSwitchAction,
					}]
					: [],
				killSwitchTriggered: true,
				killSwitchAction,
			};
		}

		for (const directive of Array.isArray(positionManagementPlan?.executableDirectives) ? positionManagementPlan.executableDirectives : []) {
			const asset = extractHyperliquidAssetFromTicker(directive?.asset || directive?.ticker || '');
			if (!asset || executionManagedAssets.has(asset)) continue;
			const livePosition = positionsByAsset.get(asset) || null;
			if (!livePosition) continue;

			if (directive.action === 'close') {
				const args = dryRun ? ['--dry-run', '--asset', asset] : ['--asset', asset];
				const commandResult = await this.runHyperliquidScript(closeScriptPath, args, options);
				const execution = {
					ticker: `${asset}/USD`,
					asset,
					action: 'close',
					source: 'position_management',
					confidence: toConfidence(directive?.consensusConfidence),
					dryRun,
					ok: commandResult.ok !== false,
					scriptPath: closeScriptPath,
					args,
					stdout: commandResult.stdout || '',
					stderr: commandResult.stderr || '',
					error: commandResult.error || null,
					rationale: directive.rationale || null,
				};
				executions.push(execution);
				executionManagedAssets.add(asset);
				if (execution.ok) {
					this.updateDefiPeakStateForExecution({
						action: 'close',
						asset,
						executedAt: new Date().toISOString(),
					}, options);
					positionsByAsset.delete(asset);
				}
				continue;
			}

			if (directive.action === 'tighten_stop' && Number(directive?.proposedStopLossPrice) > 0) {
				const args = dryRun
					? ['--dry-run', 'stop-loss', '--asset', asset, '--stop-loss', String(Number(directive.proposedStopLossPrice))]
					: ['stop-loss', '--asset', asset, '--stop-loss', String(Number(directive.proposedStopLossPrice))];
				const commandResult = await this.runHyperliquidScript(executeScriptPath, args, options);
				const execution = {
					ticker: `${asset}/USD`,
					asset,
					action: 'tighten_stop',
					source: 'position_management',
					confidence: toConfidence(directive?.consensusConfidence),
					dryRun,
					ok: commandResult.ok !== false,
					scriptPath: executeScriptPath,
					args,
					stdout: commandResult.stdout || '',
					stderr: commandResult.stderr || '',
					error: commandResult.error || null,
					stopLossPrice: Number(directive.proposedStopLossPrice),
					rationale: directive.rationale || null,
				};
				executions.push(execution);
				executionManagedAssets.add(asset);
				if (execution.ok) {
					this.updateDefiPeakStateForExecution({
						action: 'tighten_stop',
						asset,
						stopLossPrice: Number(directive.proposedStopLossPrice),
						executedAt: new Date().toISOString(),
					}, options);
				}
			}
		}

		for (const result of Array.isArray(results) ? results : []) {
			const ticker = toTicker(result?.ticker);
			if (!ticker || !isHyperliquidCryptoTicker(ticker)) continue;
			if (result?.consensus !== true) {
				skipped.push({ ticker, reason: 'no_consensus' });
				continue;
			}

			const confidence = toConfidence(result?.confidence ?? result?.averageAgreeConfidence);
			if (confidence <= minConfidence) {
				skipped.push({ ticker, reason: 'confidence_below_threshold', confidence });
				continue;
			}

			const decision = toDirection(result?.decision || 'HOLD');
			const asset = extractHyperliquidAssetFromTicker(ticker);
			const narrowedEventVeto = narrowEventVetoForTicker(options.eventVeto || null, ticker);
			const narrowedEventDecision = String(narrowedEventVeto?.decision || 'CLEAR').trim().toUpperCase();
			if (positionManagedAssets.has(asset) || executionManagedAssets.has(asset)) {
				skipped.push({ ticker, asset, reason: 'managed_by_position_management', confidence });
				continue;
			}
			const openPosition = positionsByAsset.get(asset) || null;
			const approvedTrade = approvedByTicker.get(ticker) || null;
			if (autoExecutionPolicy.singleBestNameMode && singleBestTicker) {
				if (ticker !== singleBestTicker && !openPosition) {
					skipped.push({ ticker, asset, reason: 'single_best_name_cap', confidence });
					continue;
				}
				if (!openPosition && narrowedEventDecision !== 'CLEAR') {
					skipped.push({ ticker, asset, reason: 'event_veto_active', confidence, eventDecision: narrowedEventDecision });
					continue;
				}
			}
			let action = null;
			let args = [];
			let side = null;
			let stopLossPrice = null;

			if (decision === 'SELL') {
				if (openPosition) {
					// AUTO-CLOSE DISABLED: agents manage exits manually, not via consultation consensus
					skipped.push({ ticker, asset, reason: 'auto_close_disabled_agent_managed', confidence, decision });
					continue;
				} else if (false) { // dead code — original close logic disabled
				} else {
					if (!allowAutoOpen) {
						skipped.push({ ticker, asset, reason: 'auto_open_disabled_stop_ship', confidence });
						continue;
					}
					action = 'open';
					side = 'short';
					stopLossPrice = toNumber(approvedTrade?.riskCheck?.stopLossPrice, 0) || null;
					const takeProfitPrice = toNumber(approvedTrade?.riskCheck?.takeProfitPrice, 0) || null;
					const convictionMode = String(approvedTrade?.strategyMode || approvedTrade?.riskCheck?.strategyMode || '').trim().toLowerCase() === 'range_conviction';
					const leverage = this.resolveHyperliquidExecutionLeverage(approvedTrade, options);
					const margin = this.resolveHyperliquidExecutionMargin(approvedTrade, leverage);
					if (!approvedTrade || !margin) {
						skipped.push({ ticker, asset, reason: !approvedTrade ? 'not_approved_for_entry' : 'missing_risk_sizing', confidence, leverage });
						continue;
					}
					args = dryRun
						? ['--dry-run', 'trade', '--asset', asset, '--direction', decision]
						: ['trade', '--asset', asset, '--direction', decision];
					args.push('--leverage', String(leverage));
					args.push('--margin', toCliNumber(margin));
					args.push('--confidence', String(confidence));
					if (convictionMode) {
						if (stopLossPrice) {
							args.push('--stop-loss', toCliNumber(stopLossPrice));
						}
						if (takeProfitPrice) {
							args.push('--take-profit', toCliNumber(takeProfitPrice));
						}
					} else {
						args.push('--no-stop');
					}
					if (Number(approvedTrade?.riskCheck?.positionNotional) > 0) {
						args.push('--max-notional', toCliNumber(approvedTrade.riskCheck.positionNotional));
					}
					const clientOrderId = this.buildHyperliquidAutoOpenClientOrderId(result, approvedTrade, options);
					if (clientOrderId) {
						args.push('--client-order-id', clientOrderId);
					}
				}
			} else if (decision === 'BUY' || decision === 'SHORT' || decision === 'COVER') {
				if (decision === 'BUY' || decision === 'COVER') {
					if (openPosition) {
						// AUTO-CLOSE DISABLED: agents manage exits manually, not via consultation consensus
						skipped.push({ ticker, asset, reason: 'auto_close_disabled_agent_managed', confidence, decision });
						continue;
					} else {
						if (decision === 'COVER') {
							skipped.push({ ticker, asset, reason: 'cover_without_open_position', confidence });
							continue;
						}
					}
				}
				if (action === 'close') {
					// no-op; handled above
				} else if (decision === 'SHORT') {
					if (!allowAutoOpen) {
						skipped.push({ ticker, asset, reason: 'auto_open_disabled_stop_ship', confidence });
						continue;
					}
					if (!approvedTrade) {
						skipped.push({ ticker, asset, reason: 'not_approved_for_entry', confidence });
						continue;
					}
					if (openPosition) {
						skipped.push({ ticker, asset, reason: 'position_already_open', confidence, side: openPosition.side || null });
						continue;
					}
					action = 'open';
					side = 'short';
					stopLossPrice = toNumber(approvedTrade?.riskCheck?.stopLossPrice, 0) || null;
					const takeProfitPrice = toNumber(approvedTrade?.riskCheck?.takeProfitPrice, 0) || null;
					const convictionMode = String(approvedTrade?.strategyMode || approvedTrade?.riskCheck?.strategyMode || '').trim().toLowerCase() === 'range_conviction';
					const leverage = this.resolveHyperliquidExecutionLeverage(approvedTrade, options);
					const margin = this.resolveHyperliquidExecutionMargin(approvedTrade, leverage);
					if (!margin) {
						skipped.push({ ticker, asset, reason: 'missing_risk_sizing', confidence, leverage });
						continue;
					}
					args = dryRun
						? ['--dry-run', 'trade', '--asset', asset, '--direction', decision]
						: ['trade', '--asset', asset, '--direction', decision];
					args.push('--leverage', String(leverage));
					args.push('--margin', toCliNumber(margin));
					args.push('--confidence', String(confidence));
					if (convictionMode) {
						if (stopLossPrice) {
							args.push('--stop-loss', toCliNumber(stopLossPrice));
						}
						if (takeProfitPrice) {
							args.push('--take-profit', toCliNumber(takeProfitPrice));
						}
					} else {
						args.push('--no-stop');
					}
					if (Number(approvedTrade?.riskCheck?.positionNotional) > 0) {
						args.push('--max-notional', toCliNumber(approvedTrade.riskCheck.positionNotional));
					}
					const clientOrderId = this.buildHyperliquidAutoOpenClientOrderId(result, approvedTrade, options);
					if (clientOrderId) {
						args.push('--client-order-id', clientOrderId);
					}
				} else if (decision === 'BUY') {
					if (!allowAutoOpen) {
						skipped.push({ ticker, asset, reason: 'auto_open_disabled_stop_ship', confidence });
						continue;
					}
					if (!approvedTrade) {
						skipped.push({ ticker, asset, reason: 'not_approved_for_entry', confidence });
						continue;
					}
					if (openPosition) {
						skipped.push({ ticker, asset, reason: 'position_already_open', confidence, side: openPosition.side || null });
						continue;
					}
					action = 'open';
					side = 'long';
					stopLossPrice = toNumber(approvedTrade?.riskCheck?.stopLossPrice, 0) || null;
					const takeProfitPrice = toNumber(approvedTrade?.riskCheck?.takeProfitPrice, 0) || null;
					const convictionMode = String(approvedTrade?.strategyMode || approvedTrade?.riskCheck?.strategyMode || '').trim().toLowerCase() === 'range_conviction';
					const leverage = this.resolveHyperliquidExecutionLeverage(approvedTrade, options);
					const margin = this.resolveHyperliquidExecutionMargin(approvedTrade, leverage);
					if (!margin) {
						skipped.push({ ticker, asset, reason: 'missing_risk_sizing', confidence, leverage });
						continue;
					}
					args = dryRun
						? ['--dry-run', 'trade', '--asset', asset, '--direction', decision]
						: ['trade', '--asset', asset, '--direction', decision];
					args.push('--leverage', String(leverage));
					args.push('--margin', toCliNumber(margin));
					args.push('--confidence', String(confidence));
					if (convictionMode) {
						if (stopLossPrice) {
							args.push('--stop-loss', toCliNumber(stopLossPrice));
						}
						if (takeProfitPrice) {
							args.push('--take-profit', toCliNumber(takeProfitPrice));
						}
					} else {
						args.push('--no-stop');
					}
					if (Number(approvedTrade?.riskCheck?.positionNotional) > 0) {
						args.push('--max-notional', toCliNumber(approvedTrade.riskCheck.positionNotional));
					}
					const clientOrderId = this.buildHyperliquidAutoOpenClientOrderId(result, approvedTrade, options);
					if (clientOrderId) {
						args.push('--client-order-id', clientOrderId);
					}
				}
			} else {
				skipped.push({ ticker, asset, reason: 'non_actionable_decision', decision, confidence });
				continue;
			}

			// AUTO-CLOSE FULLY DISABLED: skip ALL close actions from orchestrator
			if (action === 'close') {
				skipped.push({ ticker, asset, reason: 'all_auto_close_disabled', confidence, decision });
				continue;
			}
			const commandResult = await this.runHyperliquidScript(
				executeScriptPath,
				args,
				options
			);
			const execution = {
				ticker,
				asset,
				action,
				decision,
				confidence,
				dryRun,
				ok: commandResult.ok !== false,
				scriptPath: action === 'close' ? closeScriptPath : executeScriptPath,
				args,
				stdout: commandResult.stdout || '',
				stderr: commandResult.stderr || '',
				error: commandResult.error || null,
				timedOut: commandResult.timedOut === true,
				attemptCount: Number(commandResult.attemptCount || 1) || 1,
				recoveredAfterRetry: commandResult.recoveredAfterRetry === true,
			};
			if (action === 'open') {
				const protection = extractHyperliquidProtectionFromOutput(commandResult.stdout);
				stopLossPrice = protection.stopLossPrice || stopLossPrice;
				execution.stopLossPrice = stopLossPrice || null;
				execution.takeProfitPrice = protection.takeProfitPrice || null;
				execution.stopSource = protection.stopLossPrice ? 'atr_owned' : 'planned_risk_check';
			}
			const executionIssue = classifyHyperliquidScriptResult(execution);
			execution.issue = executionIssue;
			if (executionIssue.insufficientFunds && action === 'open' && options.notifyHyperliquidFunds !== false) {
				try {
					telegramSummary.sendTelegram(buildHyperliquidFundsAlert(execution));
					execution.fundsNotificationSent = true;
				} catch (notifyError) {
					execution.fundsNotificationSent = false;
					execution.fundsNotificationError = notifyError?.message || String(notifyError);
				}
			}
			executions.push(execution);

			if (execution.ok) {
				this.updateDefiPeakStateForExecution({
					action,
					asset,
					side,
					stopLossPrice,
					executedAt: new Date().toISOString(),
				}, options);
				if (action === 'open') {
					positionsByAsset.set(asset, { coin: asset, side });
				} else if (action === 'close') {
					positionsByAsset.delete(asset);
				}
			}
		}

		return {
			enabled: true,
			minConfidence,
			attempted: executions.length,
			succeeded: executions.filter((entry) => entry.ok).length,
			executions,
			skipped,
		};
	}

	startDefiMonitor(options = {}) {
		if (this.defiMonitorTimer) {
			return this.defiMonitorTimer;
		}
		const intervalMs = this.resolveDefiMonitorIntervalMs(options);
		this.defiMonitorTimer = setInterval(() => {
			this.runDefiMonitorCycle({ ...options, trigger: 'interval' }).catch(() => {});
		}, intervalMs);
		if (typeof this.defiMonitorTimer.unref === 'function') {
			this.defiMonitorTimer.unref();
		}
		return this.defiMonitorTimer;
	}

	stopDefiMonitor() {
		if (this.defiMonitorTimer) {
			clearInterval(this.defiMonitorTimer);
			this.defiMonitorTimer = null;
		}
	}

	resolveJournalPath(options = {}) {
		return options.journalPath || this.options.journalPath || path.join(getProjectRoot(), '.squidrun', 'runtime', 'trade-journal.db');
	}

	resolveCandidateEventLogPath(options = {}) {
		return options.candidateEventLogPath
			|| this.options.candidateEventLogPath
			|| resolveCoordPath(path.join('runtime', 'trading-candidate-events.jsonl'), { forWrite: true });
	}

	getJournalDb(options = {}) {
		return options.journalDb || journal.getDb(this.resolveJournalPath(options));
	}

	recordCandidateFeatureSnapshots(records = [], options = {}) {
		if (!Array.isArray(records) || records.length === 0) {
			return { ok: true, count: 0, path: this.resolveCandidateEventLogPath(options) };
		}
		return signalValidationRecorder.appendValidationRecords(records, {
			candidateLogPath: this.resolveCandidateEventLogPath(options),
		});
	}

	recordExecutionReport(report = {}, options = {}) {
		try {
			const db = this.getJournalDb(options);
			return journal.recordExecutionReport(db, report);
		} catch (error) {
			return {
				ok: false,
				error: error?.message || String(error),
			};
		}
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
		if (!watchlist.isWatched(normalized.ticker) && !ensureSignalTickerTracked(normalized.ticker)) {
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
			tradesToday: toPositiveInteger(options.tradesToday ?? this.countTradesToday(db, marketDate, options)),
			openPositions: resolvedOpenPositions,
			portfolioSnapshot,
		};
	}

	buildCryptoVenueRiskAccountState(defiStatus = {}, db, options = {}) {
		const marketDate = toDateKey(options.date || this.state.meta.marketDate || new Date());
		const liveEquity = toNumber(
			options.liveEquity
			?? defiStatus?.accountValue
			?? defiStatus?.withdrawable,
			0
		);
		if (!(liveEquity > 0)) {
			return null;
		}
		const dayStartKey = 'cryptoDayStartEquity';
		const peakKey = 'cryptoPeakEquity';
		const dateKey = 'cryptoRiskMarketDate';
		if (this.state.meta[dateKey] !== marketDate || this.state.meta[dayStartKey] == null) {
			this.state.meta[dateKey] = marketDate;
			this.state.meta[dayStartKey] = liveEquity;
		}
		this.state.meta[peakKey] = Math.max(
			toNumber(this.state.meta[peakKey], liveEquity),
			liveEquity
		);
		const openPositions = (Array.isArray(defiStatus?.positions) ? defiStatus.positions : [])
			.map((position) => normalizeDefiPosition(position))
			.filter((position) => position.coin)
			.map((position) => ({
				ticker: `${position.coin}/USD`,
				assetClass: 'crypto',
				size: position.size,
				side: position.side,
			}));
		return {
			equity: liveEquity,
			peakEquity: toNumber(this.state.meta[peakKey], liveEquity),
			dayStartEquity: toNumber(this.state.meta[dayStartKey], liveEquity),
			tradesToday: toPositiveInteger(options.tradesToday ?? this.countTradesToday(db, marketDate, options)),
			openPositions,
			defiStatus,
		};
	}

	buildSignalMap(symbols, options = {}) {
		const minSignalCount = Math.max(
			1,
			Math.min(
				REQUIRED_AGENTS.length,
				toPositiveInteger(options.minSignalCount) || REQUIRED_AGENTS.length
			)
		);
		const completeSignals = new Map();
		const incomplete = [];

		for (const symbol of symbols) {
			const bucket = this.state.signals.get(symbol);
			const signals = bucket ? REQUIRED_AGENTS.map((agentId) => bucket.get(agentId)).filter(Boolean) : [];
			if (signals.length >= minSignalCount) {
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
		if (String(options.strategyMode || '').trim().toLowerCase() === 'range_conviction') {
			return {
				requestId: null,
				requestPath: null,
				requestedAgents: [],
				deliveries: [],
				responses: [],
				missingAgents: [],
				skipped: true,
				reason: 'range_conviction_local_only',
			};
		}
		if (!this.isRealConsultationEnabled(options)) {
			return {
				requestId: null,
				requestPath: null,
				requestedAgents: [],
				deliveries: [],
				responses: [],
				missingAgents: [],
			};
		}
		for (const symbol of Array.isArray(symbols) ? symbols : []) {
			this.clearSignals(symbol);
		}
		const missingByAgent = this.buildMissingSignalMap(symbols);
		if (missingByAgent.length === 0) {
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
		const defiStatus = context.defiStatus || options.defiStatus || null;
		const primaryDataSource = Array.isArray(defiStatus?.positions) && defiStatus.positions.length > 0
			? 'hyperliquid'
			: (symbols.some((ticker) => /\/USD$/i.test(String(ticker || '').trim())) ? 'hyperliquid' : 'alpaca');
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
			primaryDataSource,
			snapshots: context.snapshots || {},
			bars: context.bars || {},
			news: context.news || [],
			accountSnapshot: context.accountSnapshot || null,
			macroRisk: context.macroRisk || options.macroRisk || null,
			strategyMode: options.strategyMode || context.macroRisk?.strategyMode || options.macroRisk?.strategyMode || null,
			brokerCapabilities: context.brokerCapabilities || options.brokerCapabilities || null,
			whaleData: context.whaleData || options.whaleData || null,
			cryptoMechBoard: context.cryptoMechBoard || options.cryptoMechBoard || null,
			nativeSignals: context.nativeSignals || options.nativeSignals || null,
			eventVeto: context.eventVeto || options.eventVeto || null,
			defiStatus,
			consultationWarnings: context.consultationWarnings || options.consultationWarnings || [],
			taskType: Array.isArray(defiStatus?.positions) && defiStatus.positions.length > 0 ? 'position_management' : 'new_signal',
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
			minResponses: Math.max(
				1,
				toPositiveInteger(
					options.consultationMinResponses
					|| this.options.consultationMinResponses
					|| Math.floor(requestedAgents.length / 2) + 1
				)
			),
		};
		const deliveries = await consultationStore.dispatchConsultationRequests(request, requestedAgents, consultationOptions);
		const responseResult = await consultationStore.collectConsultationResponses(request, requestedAgents, consultationOptions);

		for (const response of responseResult.responses) {
			const normalizedSignals = (Array.isArray(response.signals) ? response.signals : []).map((signal) => {
				return buildCapabilityGateSignal(
					macroRiskGate.applyMacroRiskToSignal(signal, context.macroRisk || options.macroRisk || null),
					context.brokerCapabilities || options.brokerCapabilities || null,
					context.macroRisk || options.macroRisk || null
				);
			});
			signalProducer.registerAllSignals(this, response.agentId, normalizedSignals);
		}

		return {
			requestId: request.requestId,
			requestPath: request.path,
			requestedAgents,
			minResponses: consultationOptions.minResponses,
			responseCount: responseResult.responses.length,
			quorumSatisfied: responseResult.responses.length >= consultationOptions.minResponses,
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
				? {
					client: alpacaClient,
					emptyPortfolio: Boolean(options.emptyPortfolio),
					symbols: missingTickers,
					macroRisk: options.macroRisk || null,
					strategyMode: options.strategyMode || null,
					snapshots: options.snapshots || null,
					bars: options.bars || null,
					news: options.news || null,
					defiStatus: options.defiStatus || null,
					rangeStructures: options.rangeStructures || null,
				}
				: {
					emptyPortfolio: Boolean(options.emptyPortfolio),
					symbols: missingTickers,
					macroRisk: options.macroRisk || null,
					strategyMode: options.strategyMode || null,
					snapshots: options.snapshots || null,
					bars: options.bars || null,
					news: options.news || null,
					defiStatus: options.defiStatus || null,
					rangeStructures: options.rangeStructures || null,
				};
			const producedSignals = await signalProducer.produceSignals(agentId, signalOptions);
			const gatedSignals = producedSignals.map((signal) => buildCapabilityGateSignal(
				signal,
				options.brokerCapabilities || null,
				options.macroRisk || null
			));
			const missingSet = new Set(missingTickers.map(toTicker));
			const selectedSignals = gatedSignals.filter((signal) => missingSet.has(toTicker(signal.ticker)));
			signalProducer.registerAllSignals(this, agentId, selectedSignals);
			generated.push({
				agentId,
				tickers: selectedSignals.map((signal) => signal.ticker),
				count: selectedSignals.length,
			});
		}

		return generated;
	}

	async buildRangeConvictionThesis(symbols, options = {}) {
		const normalizedSymbols = (Array.isArray(symbols) ? symbols : [])
			.map((symbol) => toTicker(symbol))
			.filter(Boolean);
		const preferredTicker = toTicker(options?.convictionSelection?.selectedTicker || normalizedSymbols[0] || '');
		const targetSymbols = preferredTicker ? [preferredTicker] : normalizedSymbols.slice(0, 1);
		if (targetSymbols.length === 0) {
			return {
				signal: null,
				signalsByTicker: new Map(),
				generated: [],
			};
		}

		const producedSignals = await signalProducer.produceSignals('builder', {
			client: options.alpacaClient || options.client || this.options.alpacaClient || this.options.client || null,
			emptyPortfolio: Boolean(options.emptyPortfolio),
			symbols: targetSymbols,
			macroRisk: options.macroRisk || null,
			strategyMode: 'range_conviction',
			snapshots: options.snapshots || null,
			bars: options.bars || null,
			news: options.news || null,
			defiStatus: options.defiStatus || null,
			rangeStructures: options.rangeStructures || null,
		});
		const gatedSignals = producedSignals.map((signal) => buildCapabilityGateSignal(
			signal,
			options.brokerCapabilities || null,
			options.macroRisk || null
		));
		const selectedSignal = gatedSignals.find((signal) => toTicker(signal?.ticker) === preferredTicker)
			|| gatedSignals[0]
			|| null;
		if (!selectedSignal) {
			return {
				signal: null,
				signalsByTicker: new Map(),
				generated: [],
			};
		}

		const registeredSignal = this.registerSignal('builder', selectedSignal.ticker, selectedSignal)?.signal || selectedSignal;
		return {
			signal: registeredSignal,
			signalsByTicker: new Map([[toTicker(registeredSignal.ticker), [registeredSignal]]]),
			generated: [{
				agentId: 'builder',
				tickers: [registeredSignal.ticker],
				count: 1,
				mode: 'single_thesis',
			}],
		};
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
		});
		const totalEquity = roundCurrency(portfolioSnapshot?.totalEquity);
		const targets = {
			activeTrading: roundCurrency(totalEquity * ratios.activeTrading),
			yield: roundCurrency(totalEquity * ratios.yield),
			reserve: roundCurrency(totalEquity * ratios.reserve),
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
		const deployableTradingCapital = roundCurrency(Math.max(0, reserveCapital - targets.reserve));
		const effectiveActiveCapital = roundCurrency(activeTradingCapital + deployableTradingCapital);
		const gaps = {
			activeTrading: roundCurrency(Math.max(0, targets.activeTrading - effectiveActiveCapital)),
			yield: roundCurrency(Math.max(0, targets.yield - yieldCapital)),
			reserve: roundCurrency(Math.max(0, targets.reserve - reserveCapital)),
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
			const matchedLots = Array.isArray(outcome.matchedLots) ? outcome.matchedLots : [];
			const entryTimestamp = matchedLots.length > 0
				? matchedLots
					.map((lot) => lot.timestamp)
					.filter(Boolean)
					.sort()[0] || null
				: null;
			const entryPrice = outcome.matchedShares > 0
				? roundCurrency(outcome.costBasis / outcome.matchedShares)
				: null;
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
			const existingConsensusDetail = parseStoredJsonObject(outcome.trade.consensus_detail, {});
			const existingRiskCheckDetail = parseStoredJsonObject(outcome.trade.risk_check_detail, {});
			const executionContext = {
				tradeId,
				orderId: outcome.trade.alpaca_order_id || null,
				status: outcome.trade.status || null,
				filledAt: outcome.trade.filled_at || null,
				reconciledAt: outcome.trade.reconciled_at || null,
				notes: outcome.trade.notes || null,
			};
			const postTradeReport = {
				entry: {
					timestamp: entryTimestamp,
					price: entryPrice,
					shares: outcome.matchedShares,
					lots: matchedLots,
				},
				exit: {
					timestamp: outcome.trade.filled_at || outcome.trade.reconciled_at || outcome.trade.timestamp || outcomeRecordedAt,
					price: roundCurrency(outcome.trade.price),
					shares: outcome.matchedShares,
				},
				realizedPnl: outcome.realizedPnl,
				realizedReturn: outcome.realizedReturn,
				costBasis: outcome.costBasis,
				proceeds: outcome.proceeds,
				macroRisk: existingConsensusDetail?.macroRisk || null,
				eventVeto: existingConsensusDetail?.eventVeto || null,
				mechanical: existingConsensusDetail?.mechanical || null,
				nativeSignals: existingConsensusDetail?.nativeSignals || null,
				riskCheck: existingRiskCheckDetail || null,
				sizeGuide: existingConsensusDetail?.sizeGuide || null,
				signalsByAgent: existingConsensusDetail?.signalsByAgent || null,
				confidence: existingConsensusDetail?.averageAgreeConfidence
					?? existingConsensusDetail?.confidence
					?? null,
				execution: executionContext,
			};
			const updatedTrade = journal.updateTrade(db, tradeId, {
				outcomeRecordedAt,
				realizedPnl: outcome.realizedPnl,
				consensusDetail: {
					...existingConsensusDetail,
					postTradeReport,
				},
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
			this.recordExecutionReport({
				timestamp: outcomeRecordedAt,
				marketDate,
				phase: 'reconciliation',
				ticker: outcome.ticker,
				direction: updatedTrade?.direction || outcome.trade.direction || null,
				broker: assetClass === 'prediction_market'
					? 'polymarket'
					: (assetClass === 'crypto' ? 'hyperliquid' : 'alpaca'),
				assetClass,
				status: updatedTrade?.status || outcome.trade.status || null,
				ok: true,
				tradeId,
				reportType: 'trade_outcome',
				realizedPnl: outcome.realizedPnl,
				realizedReturn: outcome.realizedReturn,
				costBasis: outcome.costBasis,
				proceeds: outcome.proceeds,
				confidence: postTradeReport.confidence,
				postTradeReport,
				macroRisk: postTradeReport.macroRisk,
				eventVeto: postTradeReport.eventVeto,
				mechanical: postTradeReport.mechanical,
				nativeSignals: postTradeReport.nativeSignals,
				riskCheck: postTradeReport.riskCheck,
				sizeGuide: postTradeReport.sizeGuide,
				signalLookup: postTradeReport.signalsByAgent,
				execution: executionContext,
				settledPredictions: attributionResult.settled || [],
			}, options);
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
			this.recordExecutionReport({
				timestamp: new Date().toISOString(),
				marketDate: this.state.meta.marketDate || toDateKey(options.date || new Date()),
				phase: 'polymarket_execute',
				ticker: trade.ticker,
				direction: trade.consensus?.decision || null,
				broker: 'polymarket',
				assetClass: 'prediction_market',
				status: execution?.status || null,
				ok: execution?.ok === true,
				tradeId: execution?.tradeId ?? null,
				reportType: 'polymarket_execution',
				execution,
				consensus: trade.consensus,
				referencePrice: trade.referencePrice,
				sizing: trade.sizing || null,
				market: trade.market || null,
			}, options);
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
		const smartMoneyWatchlist = await this.syncSmartMoneyWatchlist({ ...options, reason: 'premarket' });
		const symbols = resolveDefaultSymbols(options.symbols, options);
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
			watchlist: symbols.map((ticker) => watchlist.getEntry(ticker)).filter(Boolean),
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
		const smartMoneyWatchlist = await this.syncSmartMoneyWatchlist({ ...options, reason: 'consensus_round' });
		const macroRisk = options.macroRisk || await macroRiskGate.assessMacroRisk().catch(() => null);
		const strategyMode = resolveTradingStrategyMode(options, macroRisk);
		const crisisUniverse = getCrisisUniverse(macroRisk);
		const symbols = resolveDefaultSymbols(
			(Array.isArray(options.symbols) && options.symbols.length > 0)
				? options.symbols
				: (strategyMode === STRATEGY_MODES.CRISIS ? crisisUniverse : options.symbols),
			options,
			macroRisk
		);
		const brokerCapabilities = strategyMode === STRATEGY_MODES.CRISIS
			? await fetchBrokerCapabilities(symbols, {
				alpacaClient: options.alpacaClient || this.options.alpacaClient || null,
				client: options.client || this.options.client || null,
				...options,
			})
			: null;
		const defiStatusPromise = this.runDefiMonitorCycle({
			...options,
			trigger: 'consultation',
		});
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
			options.portfolioSnapshot || this.getUnifiedPortfolioSnapshot(options),
		]);
		const snapshots = freshSnapshots;
		const defiStatus = await defiStatusPromise.catch(() => ({
			ok: false,
			checkedAt: new Date().toISOString(),
			positions: [],
			warnings: [],
			telegramAlerts: [],
		}));
		const whaleData = options.whaleTransfers || null;
		const cryptoSymbols = symbols.filter((ticker) => /\/USD$/i.test(String(ticker || '').trim()));
		const compactEventVeto = options.eventVeto || await eventVeto.buildEventVeto({
			...options,
			symbols: cryptoSymbols.length > 0 ? cryptoSymbols : symbols,
			newsItems: options.eventVetoNews || news,
			macroRisk,
		}).catch(() => ({
			decision: 'CAUTION',
			eventSummary: 'Live tier-1 event scan failed; treat news context as degraded.',
			sourceTier: 'none',
			stale: true,
			affectedAssets: cryptoSymbols.length > 0 ? cryptoSymbols : symbols,
			matchedEvents: [],
		}));
		const consultationWarnings = [
			...this.buildDefiConsultationWarnings(defiStatus),
			...this.buildEventVetoConsultationWarnings(compactEventVeto, cryptoSymbols.length > 0 ? cryptoSymbols : symbols),
		];
		const positionManagementContext = this.buildPositionManagementContext(
			defiStatus,
			{
				macroRisk,
				eventVeto: compactEventVeto,
				results: [],
			},
			{
				warnings: defiStatus?.warnings || [],
				approvedTrades: [],
				rejectedTrades: [],
			}
		);
		const mechanicalBoard = cryptoSymbols.length > 0
			? (options.cryptoMechBoard || await cryptoMechBoard.buildCryptoMechBoard({
				...options,
				symbols: cryptoSymbols,
				snapshots,
				bars,
				defiStatus,
				whaleTransfers: whaleData,
			}).catch(() => null))
			: null;
		const nativeSignals = cryptoSymbols.length > 0
			? (options.nativeSignals || await hyperliquidNativeLayer.buildNativeFeatureBundle({
				...options,
				symbols: cryptoSymbols,
				detailSymbols: cryptoSymbols,
				snapshots,
			}).catch(() => null))
			: null;
		if (nativeSignals?.ok) {
			hyperliquidNativeLayer.recordNativeFeatureSnapshot(nativeSignals, options);
		}
		let consultation = null;
		let autoGeneratedSignals = [];
		let incomplete = [];
		let signalBuckets = new Map();
		let results = [];
		if (strategyMode === 'range_conviction') {
			consultation = {
				requestId: null,
				requestPath: null,
				requestedAgents: [],
				deliveries: [],
				responses: [],
				missingAgents: [],
				skipped: true,
				reason: 'range_conviction_single_thesis',
			};
			const thesis = await this.buildRangeConvictionThesis(symbols, {
				...options,
				emptyPortfolio: !Array.isArray(portfolioSnapshot?.positions) || portfolioSnapshot.positions.length === 0,
				macroRisk,
				brokerCapabilities,
				snapshots,
				bars,
				news,
				defiStatus,
				rangeStructures: options.rangeStructures || null,
				convictionSelection: options.convictionSelection || null,
			});
			autoGeneratedSignals = thesis.generated;
			signalBuckets = thesis.signalsByTicker;
			results = thesis.signal ? [buildRangeConvictionSingleThesisResult(thesis.signal)] : [];
		} else {
			consultation = await this.consultMissingSignals(symbols, {
				snapshots,
				bars,
				news,
				accountSnapshot: portfolioSnapshot,
				whaleData,
				cryptoMechBoard: mechanicalBoard,
				nativeSignals,
				eventVeto: compactEventVeto,
				macroRisk,
				brokerCapabilities,
				defiStatus,
				consultationWarnings,
				positionManagementContext,
			}, { ...options, macroRisk });
			const consultationQuorumSatisfied = consultation?.quorumSatisfied === true;
			autoGeneratedSignals = consultationQuorumSatisfied
				? []
				: await this.backfillMissingSignals(symbols, {
					...options,
					macroRisk,
					brokerCapabilities,
					snapshots,
					bars,
					news,
					defiStatus,
				});
			const builtSignals = this.buildSignalMap(symbols, {
				minSignalCount: consultationQuorumSatisfied
					? Math.max(2, toPositiveInteger(consultation?.minResponses) || 2)
					: REQUIRED_AGENTS.length,
			});
			signalBuckets = builtSignals.completeSignals;
			incomplete = builtSignals.incomplete;
			results = signalBuckets.size > 0 ? consensus.evaluateAll(signalBuckets) : [];
		}
		const cryptoRiskAccountState = cryptoSymbols.length > 0
			? this.buildCryptoVenueRiskAccountState(defiStatus, db, options)
			: null;
		const accountState = cryptoRiskAccountState
			|| this.buildAccountState(portfolioSnapshot, portfolioSnapshot?.positions || [], db, options);
		const limits = buildEffectiveRiskLimits(resolveLiveRiskLimits(options, this.options, macroRisk), macroRisk);
		const killSwitch = riskEngine.checkKillSwitch(accountState, limits);
		const dailyPause = riskEngine.checkDailyPause(accountState, limits);
		const approvedTrades = [];
		const rejectedTrades = [];
		const candidateTrades = [];
		const consensusRecords = [];
		let simulatedAccountState = cloneAccountState(accountState);
		const autoExecutionPolicy = buildCryptoAutoExecutionPolicy(defiStatus, macroRisk, options, this.options);

		for (const result of results) {
			const signals = signalBuckets.get(result.ticker) || [];
			const signalLookup = this.lookupSignalsByAgent(signals);
			const snapshot = snapshots instanceof Map ? snapshots.get(result.ticker) : snapshots?.[result.ticker];
			const referencePrice = pickReferencePrice(snapshot);
			const assetClass = resolveAssetClassForTicker(result.ticker);
			const mechanicalEntry = mechanicalBoard?.symbols?.[result.ticker] || null;
			const nativeEntry = buildDecisionCoupledNativeEntry(
				nativeSignals?.symbols?.[result.ticker] || null,
				result.decision
			);
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
				const singleThesisMode = strategyMode === 'range_conviction';
				const entryDecision = singleThesisMode
					? {
						ok: true,
						reason: 'range_conviction_single_thesis',
						averageAgreeConfidence: toNumber(result.averageAgreeConfidence, result.confidence),
					}
					: shouldTakeApprovedTrade({
						ticker: result.ticker,
						consensus: result,
					}, options, this.options);
				if (!entryDecision.ok) {
					rejectedTrades.push({
						ticker: result.ticker,
						consensus: result,
						referencePrice,
						riskCheck: {
							approved: false,
							violations: [entryDecision.reason],
						},
					});
				} else {
					const narrowedEventVeto = narrowEventVetoForTicker(compactEventVeto, result.ticker);
					const sizeGuide = consensusSizer.sizeConsensusTrade({
						ticker: result.ticker,
						consensus: result,
						mechanicalBoard,
						nativeSignals: nativeEntry,
						eventVeto: narrowedEventVeto,
					});
					if (sizeGuide.bucket === 'block') {
						rejectedTrades.push({
							ticker: result.ticker,
							consensus: result,
							referencePrice,
							sizeGuide,
							riskCheck: {
								approved: false,
								violations: [`CONSENSUS_SIZER: ${sizeGuide.reasons.join(', ') || 'blocked'}`],
							},
						});
						continue;
					}
					candidateTrades.push({
						ticker: result.ticker,
						consensus: result,
						referencePrice,
						assetClass,
						marketCap: options.marketCaps?.[result.ticker] ?? null,
						averageAgreeConfidence: entryDecision.averageAgreeConfidence,
						signalLookup,
						strategyMode,
						convictionSignal: selectConvictionSignalMetadata(result),
						mechanicalEntry,
						nativeEntry,
						sizeGuide,
						eventVeto: narrowedEventVeto,
						oracleActionable: hasActionableOracleSignal(signalLookup, result.ticker),
						autoExecutionRankScore: scoreTradeIdeaForAutoExecution({
							ticker: result.ticker,
							averageAgreeConfidence: entryDecision.averageAgreeConfidence,
							consensus: result,
							signalLookup,
							mechanicalEntry,
							sizeGuide,
						}),
					});
				}
			}

			consensusRecords.push({
				result,
				signalLookup,
				actedOn,
			});
		}

		const singleBestEligibleTrades = autoExecutionPolicy.singleBestNameMode
			? candidateTrades.filter((trade) => {
				const vetoDecision = String(trade?.eventVeto?.decision || 'CLEAR').trim().toUpperCase();
				return trade.oracleActionable === true && vetoDecision === 'CLEAR';
			})
			: [];
		const rankedSingleBestTrades = singleBestEligibleTrades.length > 0
			? selectTopTradeIdeas(singleBestEligibleTrades, {
				...options,
				maxIdeasPerRound: 1,
			}, this.options)
			: null;
		const tradeSelection = rankedSingleBestTrades && rankedSingleBestTrades.selected.length > 0
			? {
				selected: rankedSingleBestTrades.selected,
				excluded: candidateTrades.filter((trade) => {
					return !rankedSingleBestTrades.selected.some((selectedTrade) => toTicker(selectedTrade?.ticker) === toTicker(trade?.ticker));
				}),
			}
			: selectTopTradeIdeas(candidateTrades, {
				...options,
				maxIdeasPerRound: autoExecutionPolicy.maxIdeasPerRound,
			}, this.options);
		const { selected: selectedTrades, excluded: excludedTrades } = tradeSelection;
		for (const trade of excludedTrades) {
			rejectedTrades.push({
				ticker: trade.ticker,
				consensus: trade.consensus,
				referencePrice: trade.referencePrice,
				riskCheck: {
					approved: false,
					violations: [`ENTRY_CAP: only top ${autoExecutionPolicy.maxIdeasPerRound} ideas per round are executable`],
				},
			});
		}

		for (const trade of selectedTrades) {
			let riskCheck = null;
			let actedOn = false;

			if (strategyMode === STRATEGY_MODES.CRISIS) {
				const validation = validateCrisisSignalCapability({
					ticker: trade.ticker,
					direction: trade.consensus?.decision,
				}, brokerCapabilities, macroRisk);
				if (!validation.ok) {
					rejectedTrades.push({
						ticker: trade.ticker,
						consensus: trade.consensus,
						referencePrice: trade.referencePrice,
						riskCheck: {
							approved: false,
							violations: [`CRISIS_CAPABILITY_GATE: ${validation.reason}`],
						},
					});
					continue;
				}
			}

			riskCheck = riskEngine.checkTrade({
				ticker: trade.ticker,
				direction: trade.consensus?.decision,
				price: trade.referencePrice || 0,
				marketCap: trade.marketCap,
				assetClass: trade.assetClass,
				confidence: trade.averageAgreeConfidence ?? trade.consensus?.confidence,
				strategyMode: trade.strategyMode,
				invalidationPrice: trade.convictionSignal?.invalidationPrice ?? null,
				takeProfitPrice: trade.convictionSignal?.takeProfitPrice ?? null,
				leverage: trade.convictionSignal?.leverage ?? null,
			}, simulatedAccountState, limits);
			riskCheck = consensusSizer.applySizeBucketToRiskCheck(
				riskCheck,
				trade.sizeGuide?.bucket || 'normal',
				trade.assetClass,
				trade.sizeGuide?.sizeMultiplier ?? null
			);

			if (riskCheck.approved && strategyMode === STRATEGY_MODES.CRISIS && trade.consensus?.decision === 'BUY') {
				const crisisBookExposure = estimateCrisisBookExposure(simulatedAccountState, crisisUniverse);
				const proposedExposure = toNumber(trade.referencePrice, 0) * toNumber(riskCheck.maxShares, 0);
				const maxBookPct = toNumber(limits.crisisBookPct, 0.08);
				const maxBookDollars = toNumber(simulatedAccountState.equity, 0) * maxBookPct;
				if ((crisisBookExposure + proposedExposure) > maxBookDollars) {
					riskCheck = {
						approved: false,
						violations: [
							`CRISIS_BOOK_CAP: ${(crisisBookExposure + proposedExposure).toFixed(2)} exceeds ${(maxBookDollars).toFixed(2)}`,
						],
						maxShares: null,
						stopLossPrice: riskCheck.stopLossPrice,
					};
				}
			}

			actedOn = Boolean(riskCheck.approved);
			if (riskCheck.approved) {
				approvedTrades.push({
					ticker: trade.ticker,
					consensus: trade.consensus,
					referencePrice: trade.referencePrice,
					riskCheck,
					sizeGuide: trade.sizeGuide || null,
					marketCap: trade.marketCap,
					signalLookup: trade.signalLookup || null,
					mechanicalEntry: trade.mechanicalEntry || null,
					nativeEntry: trade.nativeEntry || null,
					strategyMode: trade.strategyMode || null,
					convictionSignal: trade.convictionSignal || null,
					limits,
				});
				simulatedAccountState = applyTradeToAccountState(simulatedAccountState, {
					ticker: trade.ticker,
					direction: trade.consensus?.decision,
					price: trade.referencePrice,
					assetClass: trade.assetClass,
				}, riskCheck);
			} else {
				rejectedTrades.push({
					ticker: trade.ticker,
					consensus: trade.consensus,
					referencePrice: trade.referencePrice,
					riskCheck,
					sizeGuide: trade.sizeGuide || null,
				});
			}

			const record = consensusRecords.find((item) => item.result?.ticker === trade.ticker);
			if (record) {
				record.actedOn = actedOn;
			}
		}

		for (const record of consensusRecords) {
			const { result, signalLookup, actedOn } = record;
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

		const positionManagementPlan = this.evaluatePositionManagement(
			defiStatus,
			{
				macroRisk,
				eventVeto: compactEventVeto,
				results,
			},
			{
				warnings: defiStatus?.warnings || [],
				approvedTrades,
				rejectedTrades,
			}
		);
		const autoExecution = await this.maybeAutoExecuteLiveConsensus(results, approvedTrades, defiStatus, {
			...options,
			macroRisk,
			eventVeto: compactEventVeto,
			autoExecutionPolicy,
			positionManagementPlan,
			killSwitchTriggered: killSwitch.triggered,
			hyperliquidKillSwitchAction: resolveHyperliquidKillSwitchAction(options, this.options),
		});
		for (const execution of Array.isArray(autoExecution?.executions) ? autoExecution.executions : []) {
			const approvedTrade = approvedTrades.find((trade) => toTicker(trade?.ticker) === toTicker(execution?.ticker)) || null;
			this.recordExecutionReport({
				timestamp: new Date().toISOString(),
				marketDate: this.state.meta.marketDate || toDateKey(options.date || new Date()),
				phase: 'consensus_auto_execution',
				ticker: execution.ticker || null,
				direction: execution.decision || approvedTrade?.consensus?.decision || null,
				broker: 'hyperliquid',
				assetClass: 'crypto',
				status: execution.ok ? 'executed' : 'failed',
				ok: execution.ok !== false,
				reportType: 'auto_execution',
				execution,
				consensus: approvedTrade?.consensus || null,
				signalLookup: approvedTrade?.signalLookup || null,
				macroRisk: macroRisk
					? {
						regime: macroRisk.regime,
						score: macroRisk.score,
						reason: macroRisk.reason,
					}
					: null,
				eventVeto: compactEventVeto || null,
				mechanical: approvedTrade?.mechanicalEntry || null,
				nativeSignals: approvedTrade?.nativeEntry || null,
				riskCheck: approvedTrade?.riskCheck || null,
				sizeGuide: approvedTrade?.sizeGuide || null,
			}, options);
		}
		const approvedByTicker = new Map(approvedTrades.map((trade) => [trade.ticker, trade]));
		const rejectedByTicker = new Map(rejectedTrades.map((trade) => [trade.ticker, trade]));
		const autoExecutionByTicker = new Map(
			(Array.isArray(autoExecution?.executions) ? autoExecution.executions : [])
				.map((entry) => [toTicker(entry?.ticker), entry])
		);
		const autoExecutionSkippedByTicker = new Map(
			(Array.isArray(autoExecution?.skipped) ? autoExecution.skipped : [])
				.map((entry) => [toTicker(entry?.ticker), entry])
		);
		const candidateFeatureRecords = results.map((result) => {
			const record = consensusRecords.find((entry) => entry.result?.ticker === result.ticker) || null;
			const approvedTrade = approvedByTicker.get(result.ticker) || null;
			const rejectedTrade = rejectedByTicker.get(result.ticker) || null;
			const autoExecutionRecord = autoExecutionByTicker.get(result.ticker) || null;
			const autoExecutionSkip = autoExecutionSkippedByTicker.get(result.ticker) || null;
			const mechanicalEntry = mechanicalBoard?.symbols?.[result.ticker] || null;
			const nativeEntry = buildDecisionCoupledNativeEntry(
				nativeSignals?.symbols?.[result.ticker] || null,
				result.decision
			);
			const snapshot = snapshots instanceof Map ? snapshots.get(result.ticker) : snapshots?.[result.ticker];
			const referencePrice = approvedTrade?.referencePrice
				?? rejectedTrade?.referencePrice
				?? pickReferencePrice(snapshot);
			const observedAt = toIsoTimestamp(
				snapshot?.tradeTimestamp
				|| snapshot?.quoteTimestamp
				|| options.date
				|| new Date(),
				new Date().toISOString()
			);
			const skipReason = autoExecutionSkip?.reason
				|| rejectedTrade?.reason
				|| (Array.isArray(rejectedTrade?.riskCheck?.violations) ? rejectedTrade.riskCheck.violations.join('; ') : null)
				|| (!result.consensus ? 'no_consensus' : (!approvedTrade && !rejectedTrade ? 'ignored' : null));
			return {
				validationId: buildValidationId(
					result.ticker,
					observedAt,
					result.decision,
					this.state.meta.marketDate || toDateKey(options.date || new Date())
				),
				recordedAt: new Date().toISOString(),
				observedAt,
				marketDate: this.state.meta.marketDate || toDateKey(options.date || new Date()),
				ticker: result.ticker,
				assetClass: resolveAssetClassForTicker(result.ticker),
				decision: result.decision,
				consensus: Boolean(result.consensus),
				agreementCount: toNumber(result.agreementCount, 0),
				confidence: round(toNumber(result.confidence, 0), 4),
				averageAgreeConfidence: round(toNumber(result.averageAgreeConfidence, 0), 4),
				status: approvedTrade
					? 'approved'
					: rejectedTrade
						? 'rejected'
						: (result.consensus ? 'ignored' : 'no_consensus'),
				ignored: !approvedTrade && !rejectedTrade,
				skipReason,
				referencePrice: round(toNumber(referencePrice, 0), 6),
				signalsByAgent: record?.signalLookup || null,
				macroRisk: macroRisk
					? {
						regime: macroRisk.regime,
						score: macroRisk.score,
						reason: macroRisk.reason,
					}
					: null,
				eventVeto: compactEventVeto
					? {
						decision: compactEventVeto.decision,
						eventSummary: compactEventVeto.eventSummary,
						affectedAssets: compactEventVeto.affectedAssets,
					}
					: null,
				mechanical: mechanicalEntry ? {
					priceChange24hPct: mechanicalEntry.priceChange24hPct ?? null,
					openInterestChange24hPct: mechanicalEntry.openInterestChange24hPct ?? null,
					fundingRate: mechanicalEntry.fundingRate ?? null,
					fundingRateChange24hBps: mechanicalEntry.fundingRateChange24hBps ?? null,
					openInterestToVolumeRatio: mechanicalEntry.openInterestToVolumeRatio ?? null,
					impactSpreadPct: mechanicalEntry.impactSpreadPct ?? null,
					squeezeRiskScore: mechanicalEntry.squeezeRiskScore ?? null,
					overcrowdingScore: mechanicalEntry.overcrowdingScore ?? null,
					cascadeRiskScore: mechanicalEntry.cascadeRiskScore ?? null,
					tradeFlag: mechanicalEntry.tradeFlag ?? null,
					mechanicalDirectionBias: mechanicalEntry.mechanicalDirectionBias ?? null,
					dataCompleteness: mechanicalEntry.dataCompleteness ?? null,
				} : null,
				nativeSignals: nativeEntry || null,
				sizeGuide: approvedTrade?.sizeGuide || rejectedTrade?.sizeGuide || null,
				riskCheck: approvedTrade?.riskCheck || rejectedTrade?.riskCheck || null,
				execution: autoExecutionRecord
					? {
						attempted: true,
						ok: autoExecutionRecord.ok !== false,
						action: autoExecutionRecord.action || null,
						dryRun: autoExecutionRecord.dryRun === true,
						issue: autoExecutionRecord.issue || null,
					}
					: autoExecutionSkip
						? {
							attempted: false,
							ok: false,
							skipReason: autoExecutionSkip.reason || null,
						}
						: null,
				autoExecutionEnabled: options.autoExecuteLiveConsensus === true || this.options.autoExecuteLiveConsensus === true,
			};
		});
		const candidateFeatureLog = this.recordCandidateFeatureSnapshots(candidateFeatureRecords, options);
		const validationSettlement = await signalValidationRecorder.settleValidationRecords({
			candidateLogPath: this.resolveCandidateEventLogPath(options),
			settlementLogPath: options.validationSettlementLogPath,
		}).catch((error) => ({
			ok: false,
			error: error?.message || String(error),
			path: options.validationSettlementLogPath || null,
		}));
		const phaseResult = {
			phase: 'consensus',
			marketDate: this.state.meta.marketDate || toDateKey(options.date || new Date()),
			smartMoneyWatchlist,
			consultation,
			eventVeto: compactEventVeto,
			cryptoMechBoard: mechanicalBoard,
			macroRisk,
			brokerCapabilities,
			defiStatus,
			positionManagement: positionManagementPlan,
			autoGeneratedSignals,
			portfolioSnapshot,
			accountState,
			simulatedAccountState,
			killSwitch,
			dailyPause,
			autoExecution,
			autoExecutionPolicy,
			candidateFeatureLog,
			validationSettlement,
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
					ticker: trade.ticker,
					price: trade.referencePrice,
					marketCap: trade.marketCap,
					assetClass: resolveAssetClassForTicker(trade.ticker),
					account: simulatedAccountState,
					limits: trade.limits,
					requestedShares: trade.riskCheck?.maxShares,
					consensusDetail: {
						...trade.consensus,
						signalsByAgent: trade.signalLookup || null,
						macroRisk: consensusPhase?.macroRisk
							? {
								regime: consensusPhase.macroRisk.regime,
								score: consensusPhase.macroRisk.score,
								reason: consensusPhase.macroRisk.reason,
							}
							: null,
						eventVeto: consensusPhase?.eventVeto
							? {
								decision: consensusPhase.eventVeto.decision,
								eventSummary: consensusPhase.eventVeto.eventSummary,
								affectedAssets: consensusPhase.eventVeto.affectedAssets,
								matchedEvents: consensusPhase.eventVeto.matchedEvents,
							}
							: null,
						mechanical: trade.mechanicalEntry || null,
						nativeSignals: trade.nativeEntry || null,
						sizeGuide: trade.sizeGuide || null,
					},
					riskCheckDetail: {
						...(trade.riskCheck || {}),
						limits: trade.limits || null,
					},
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
			this.recordExecutionReport({
				timestamp: new Date().toISOString(),
				marketDate: this.state.meta.marketDate || toDateKey(options.date || new Date()),
				phase: 'market_open',
				ticker: trade.ticker,
				direction: trade.consensus?.decision || null,
				broker: watchlist.getEntry(trade.ticker)?.broker
					|| (resolveAssetClassForTicker(trade.ticker) === 'crypto' ? 'hyperliquid' : 'alpaca'),
				assetClass: resolveAssetClassForTicker(trade.ticker),
				status: execution?.status || null,
				ok: execution?.ok === true,
				tradeId: execution?.tradeId ?? null,
				reportType: 'market_open_execution',
				execution,
				consensus: trade.consensus,
				referencePrice: trade.referencePrice,
				riskCheck: trade.riskCheck || null,
				sizeGuide: trade.sizeGuide || null,
				accountState: simulatedAccountState,
				macroRisk: consensusPhase?.macroRisk || null,
				eventVeto: consensusPhase?.eventVeto || null,
				mechanical: trade.mechanicalEntry || null,
				nativeSignals: trade.nativeEntry || null,
				signalLookup: trade.signalLookup || null,
			}, options);

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
