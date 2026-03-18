'use strict';

const { analyzeTicker, scoreNewsForAsset } = require('../signal-producer');

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
});
