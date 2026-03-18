'use strict';

const { createOrchestrator } = require('../orchestrator');

const SIGNAL_SETS = {
	oracle: {
		AAPL: { direction: 'SELL', confidence: 0.8, reasoning: 'Relative weakness into a cautious macro tape.' },
		MSFT: { direction: 'HOLD', confidence: 0.7, reasoning: 'Strength is intact, but setup is not compelling enough to add here.' },
		NVDA: { direction: 'BUY', confidence: 0.9, reasoning: 'AI demand remains the strongest growth driver on the list.' },
		TSLA: { direction: 'BUY', confidence: 0.6, reasoning: 'Event-driven upside is possible despite volatility.' },
		AMZN: { direction: 'HOLD', confidence: 0.7, reasoning: 'Mixed retail and cloud signals support patience.' },
		META: { direction: 'BUY', confidence: 0.8, reasoning: 'Ad strength and margin discipline remain supportive.' },
		GOOGL: { direction: 'BUY', confidence: 0.7, reasoning: 'Cash-flow durability looks attractive in a range-bound market.' },
		AMD: { direction: 'BUY', confidence: 0.8, reasoning: 'AI product cycle remains a constructive catalyst.' },
		AVGO: { direction: 'BUY', confidence: 0.9, reasoning: 'Networking and AI infrastructure demand remain robust.' },
		JPM: { direction: 'HOLD', confidence: 0.8, reasoning: 'Rates help, but macro softness argues against pressing longs.' },
	},
	architect: {
		AAPL: { direction: 'SELL', confidence: 0.7, reasoning: 'Defensive mega-cap, but near-term upside still looks capped.' },
		MSFT: { direction: 'HOLD', confidence: 0.6, reasoning: 'Best-in-class quality, yet not enough tactical edge for a fresh entry.' },
		NVDA: { direction: 'BUY', confidence: 0.8, reasoning: 'Leadership persists as AI capex continues to flow through the stack.' },
		TSLA: { direction: 'HOLD', confidence: 0.5, reasoning: 'Too much cross-current risk for conviction either way.' },
		AMZN: { direction: 'HOLD', confidence: 0.7, reasoning: 'Good business, unclear short-term setup.' },
		META: { direction: 'BUY', confidence: 0.7, reasoning: 'Execution quality keeps it attractive versus peers.' },
		GOOGL: { direction: 'BUY', confidence: 0.6, reasoning: 'Valuation and cash generation still look favorable.' },
		AMD: { direction: 'BUY', confidence: 0.7, reasoning: 'Positive AI exposure with room for follow-through.' },
		AVGO: { direction: 'BUY', confidence: 0.85, reasoning: 'Strong profitability and secular demand make it one of the cleaner longs.' },
		JPM: { direction: 'HOLD', confidence: 0.7, reasoning: 'Macro uncertainty offsets the rates tailwind.' },
	},
	builder: {
		AAPL: { direction: 'HOLD', confidence: 0.62, reasoning: 'Quality name, but the tape still looks range-bound.' },
		MSFT: { direction: 'BUY', confidence: 0.74, reasoning: 'Best overall quality and AI leverage in this macro backdrop.' },
		NVDA: { direction: 'HOLD', confidence: 0.66, reasoning: 'Still strong, but too crowded to chase aggressively.' },
		TSLA: { direction: 'SELL', confidence: 0.78, reasoning: 'High-beta growth remains vulnerable in a hawkish slowdown backdrop.' },
		AMZN: { direction: 'HOLD', confidence: 0.6, reasoning: 'AWS helps, but retail and margin sensitivity keep it mixed.' },
		META: { direction: 'BUY', confidence: 0.69, reasoning: 'Cash flow and cost discipline make it a relative winner.' },
		GOOGL: { direction: 'BUY', confidence: 0.65, reasoning: 'Cheaper than peers with durable cash flow support.' },
		AMD: { direction: 'HOLD', confidence: 0.61, reasoning: 'Good AI tailwind, but still more cyclical than the top-quality names.' },
		AVGO: { direction: 'BUY', confidence: 0.72, reasoning: 'AI-networking demand and profitability fit this tape well.' },
		JPM: { direction: 'HOLD', confidence: 0.64, reasoning: 'Rates help, but macro slowdown risk limits the setup.' },
	},
};

function registerSignals(orchestrator) {
	for (const [agentId, signals] of Object.entries(SIGNAL_SETS)) {
		for (const [ticker, signal] of Object.entries(signals)) {
			orchestrator.registerSignal(agentId, ticker, signal);
		}
	}
}

function formatActionable(result, approvedTrades) {
	const approved = approvedTrades.find((trade) => trade.ticker === result.ticker);
	if (approved) {
		return {
			ticker: result.ticker,
			decision: result.decision,
			consensus: result.summary,
			status: 'APPROVED',
			maxShares: approved.riskCheck?.maxShares ?? null,
			stopLossPrice: approved.riskCheck?.stopLossPrice ?? null,
			referencePrice: approved.referencePrice ?? null,
		};
	}

	return {
		ticker: result.ticker,
		decision: result.decision,
		consensus: result.summary,
		status: 'REJECTED',
	};
}

async function main() {
	const orchestrator = createOrchestrator();
	registerSignals(orchestrator);

	const consensusPhase = await orchestrator.runConsensusRound();
	const actionable = consensusPhase.results
		.filter((result) => result.consensus && result.decision !== 'HOLD')
		.map((result) => formatActionable(result, consensusPhase.approvedTrades));

	const approved = actionable.filter((entry) => entry.status === 'APPROVED');
	const rejected = actionable
		.filter((entry) => entry.status === 'REJECTED')
		.map((entry) => {
			const rejectedTrade = consensusPhase.rejectedTrades.find((trade) => trade.ticker === entry.ticker);
			return {
				...entry,
				riskViolations: rejectedTrade?.riskCheck?.violations || [],
				referencePrice: rejectedTrade?.referencePrice ?? null,
			};
		});

	process.stdout.write(`${JSON.stringify({
		ok: true,
		marketDate: consensusPhase.marketDate,
		accountState: consensusPhase.accountState,
		simulatedAccountState: consensusPhase.simulatedAccountState,
		consensusStats: {
			totalTickers: consensusPhase.results.length,
			approvedTrades: approved.length,
			actionableConsensus: actionable.length,
			incompleteSignals: consensusPhase.incompleteSignals.length,
		},
		approved,
		rejected,
	}, null, 2)}\n`);
}

main().catch((error) => {
	process.stderr.write(`${error.stack || error.message}\n`);
	process.exit(1);
});
