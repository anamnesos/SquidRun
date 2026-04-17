'use strict';

const riskEngine = require('../risk-engine');

describe('risk-engine conviction sizing', () => {
  test('sizes from invalidation distance and returns conviction leverage metadata', () => {
    const result = riskEngine.checkTrade({
      ticker: 'AVAX/USD',
      direction: 'SELL',
      price: 20,
      assetClass: 'crypto',
      confidence: 0.84,
      strategyMode: 'range_conviction',
      invalidationPrice: 20.6,
      takeProfitPrice: 18.5,
      leverage: 10,
    }, {
      equity: 1000,
      peakEquity: 1000,
      dayStartEquity: 1000,
      tradesToday: 0,
      openPositions: [],
    }, riskEngine.DEFAULT_CRYPTO_LIMITS);

    expect(result.approved).toBe(true);
    expect(result.stopLossPrice).toBeCloseTo(20.6, 4);
    expect(result.takeProfitPrice).toBeCloseTo(18.5, 4);
    expect(result.margin).toBeGreaterThan(0);
    expect(result.leverage).toBeGreaterThanOrEqual(2);
    expect(result.leverage).toBeLessThanOrEqual(10);
  });
});
