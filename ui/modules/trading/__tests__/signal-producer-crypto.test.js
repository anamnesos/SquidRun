'use strict';

const dataIngestion = require('../data-ingestion');
const {
	analyzeTicker,
	analyzeRangeConvictionTicker,
	applyBarsSourceContext,
	getHistoricalBarsWithFallback,
	scoreNewsForAsset,
} = require('../signal-producer');

afterEach(() => {
	jest.restoreAllMocks();
});

describe('signal-producer crypto heuristics', () => {
	test('crypto breakout with aligned multi-horizon trend resolves to BUY', () => {
		const signal = analyzeTicker(
			'BTC/USD',
			{
				tradePrice: 106000,
				dailyClose: 105500,
				previousClose: 101000,
				dailyVolume: 190,
			},
			[
				{ close: 96000, high: 97500, low: 94500, volume: 90 },
				{ close: 98500, high: 100500, low: 97200, volume: 105 },
				{ close: 100500, high: 102000, low: 99300, volume: 120 },
				{ close: 103000, high: 104500, low: 101800, volume: 140 },
				{ close: 105000, high: 106200, low: 103900, volume: 165 },
			],
			[
				{
					headline: 'Spot BTC ETF inflows accelerate as exchange listing momentum builds',
					summary: 'Analysts cite strong adoption and fresh institutional demand.',
				},
			],
			{
				momentumWeight: 0.45,
				newsWeight: 0.2,
				volumeWeight: 0.25,
				riskWeight: 0.1,
				buyThreshold: 0.10,
				sellThreshold: -0.18,
				convictionBias: 0.04,
			},
			{
				assetClass: 'crypto',
			}
		);

		expect(signal.direction).toBe('BUY');
		expect(signal.confidence).toBeGreaterThanOrEqual(0.7);
		expect(signal.metrics.trendAlignment).toBeGreaterThan(0.5);
		expect(signal.reasoning).toContain('trend aligned higher');
	});

	test('crypto chop with conflicting short-term structure stays HOLD', () => {
		const signal = analyzeTicker(
			'SOL/USD',
			{
				tradePrice: 150,
				dailyClose: 149,
				previousClose: 154,
				dailyVolume: 82,
			},
			[
				{ close: 130, high: 148, low: 121, volume: 60 },
				{ close: 158, high: 166, low: 141, volume: 74 },
				{ close: 136, high: 151, low: 129, volume: 71 },
				{ close: 162, high: 168, low: 145, volume: 78 },
				{ close: 148, high: 161, low: 138, volume: 80 },
			],
			[
				{
					headline: 'SOL sees mixed flows after liquidation spike',
					summary: 'Traders digest volatile positioning and uneven demand.',
				},
			],
			{
				momentumWeight: 0.45,
				newsWeight: 0.2,
				volumeWeight: 0.25,
				riskWeight: 0.1,
				buyThreshold: 0.10,
				sellThreshold: -0.18,
				convictionBias: 0.04,
			},
			{
				assetClass: 'crypto',
			}
		);

		expect(signal.direction).toBe('HOLD');
		expect(signal.metrics.chopPenalty).toBeGreaterThan(0.25);
		expect(signal.reasoning).toContain('conflicting crypto trend structure keeps it HOLD');
	});

	test('crypto news scoring recognizes market-specific catalysts and risks', () => {
		const positive = scoreNewsForAsset([
			{
				headline: 'ETH mainnet upgrade approved as ETF inflows continue',
				summary: 'Adoption and listing tailwinds remain constructive.',
			},
		], 'crypto');
		const negative = scoreNewsForAsset([
			{
				headline: 'Exchange hack triggers liquidation wave and heavy outflows',
				summary: 'Security concerns weigh on sentiment.',
			},
		], 'crypto');

		expect(positive.score).toBeGreaterThan(0);
		expect(positive.terms).toEqual(expect.arrayContaining(['upgrade', 'approved', 'inflow']));
		expect(negative.score).toBeLessThan(0);
		expect(negative.terms).toEqual(expect.arrayContaining(['hack', 'liquidation', 'outflow']));
	});

	test('range conviction only allows short setups at the ceiling context', () => {
		const signal = analyzeRangeConvictionTicker(
			'AVAX/USD',
			{
				tradePrice: 9.54,
			},
			{
				momentumWeight: 0.45,
				newsWeight: 0.2,
				volumeWeight: 0.25,
				riskWeight: 0.1,
				buyThreshold: 0.10,
				sellThreshold: -0.18,
				convictionBias: 0.04,
			},
			{
				ok: true,
				regime: 'range',
				floor: 9.12,
				ceiling: 9.55,
				mid: 9.335,
				tolerancePct: 0.003,
				distanceToFloorPct: 0.046,
				distanceToCeilingPct: 0.001,
				setups: {
					long: {
						direction: 'BUY',
						confidence: 0.9,
						invalidationPrice: 9.06,
						targetPrice: 9.55,
						rationale: 'floor',
					},
					short: {
						direction: 'SELL',
						confidence: 0.76,
						invalidationPrice: 9.6,
						targetPrice: 9.14,
						rationale: 'ceiling',
					},
				},
			}
		);

		expect(signal.direction).toBe('SELL');
		expect(signal.reasoning).toContain('Context at_ceiling');
	});

	test('range conviction blocks long selection in breakout-up context even if long confidence is higher', () => {
		const signal = analyzeRangeConvictionTicker(
			'AVAX/USD',
			{
				tradePrice: 9.62,
			},
			{
				momentumWeight: 0.45,
				newsWeight: 0.2,
				volumeWeight: 0.25,
				riskWeight: 0.1,
				buyThreshold: 0.10,
				sellThreshold: -0.18,
				convictionBias: 0.04,
			},
			{
				ok: true,
				regime: 'breakout_up',
				floor: 9.12,
				ceiling: 9.55,
				mid: 9.335,
				tolerancePct: 0.003,
				distanceToFloorPct: 0.055,
				distanceToCeilingPct: 0.0005,
				setups: {
					long: {
						direction: 'BUY',
						confidence: 0.9,
						invalidationPrice: 9.42,
						targetPrice: 9.9,
						rationale: 'breakout continuation',
					},
					short: {
						direction: 'SELL',
						confidence: 0.82,
						invalidationPrice: 9.67,
						targetPrice: 9.3,
						rationale: 'ceiling rejection',
					},
				},
			}
		);

		expect(signal.direction).toBe('HOLD');
		expect(signal.reasoning).toContain('breakout_up');
	});

	test('surfaces Yahoo fallback bar quality with a confidence haircut and reasoning note', async () => {
		jest.spyOn(dataIngestion, 'getHistoricalBars').mockResolvedValue(new Map([
			['BTC/USD', [
				{ timestamp: '2026-04-12T00:00:00.000Z', close: 100, high: 102, low: 98, volume: 10 },
			]],
		]));
		jest.spyOn(dataIngestion, 'getYahooHistoricalBars').mockResolvedValue([
			{ timestamp: '2026-04-10T00:00:00.000Z', close: 96, high: 97, low: 95, volume: 10 },
			{ timestamp: '2026-04-11T00:00:00.000Z', close: 97, high: 98, low: 96, volume: 11 },
			{ timestamp: '2026-04-12T00:00:00.000Z', close: 98, high: 99, low: 97, volume: 12 },
			{ timestamp: '2026-04-13T00:00:00.000Z', close: 99, high: 100, low: 98, volume: 13 },
			{ timestamp: '2026-04-14T00:00:00.000Z', close: 100, high: 101, low: 99, volume: 14 },
		]);

		const barsMap = await getHistoricalBarsWithFallback({ now: '2026-04-14T18:00:00.000Z' }, ['BTC/USD']);
		const bars = barsMap.get('BTC/USD');
		expect(bars.sourceMeta).toMatchObject({
			source: 'yahoo_finance_fallback',
			primarySource: 'broker',
			fallbackUsed: true,
			primaryBarCount: 1,
			stale: false,
		});

		const adjusted = applyBarsSourceContext({
			ticker: 'BTC/USD',
			direction: 'BUY',
			confidence: 0.8,
			reasoning: 'Base setup.',
		}, bars);

		expect(adjusted.confidence).toBe(0.74);
		expect(adjusted.reasoning).toContain('backfilled from Yahoo');
		expect(adjusted.dataFreshness?.bars?.source).toBe('yahoo_finance_fallback');
	});
});
