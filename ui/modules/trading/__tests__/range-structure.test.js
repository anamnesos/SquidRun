'use strict';

const rangeStructure = require('../range-structure');

function buildBars(prices = []) {
  return prices.map((price, index) => ({
    open: price - 0.03,
    high: price + 0.06,
    low: price - 0.06,
    close: price,
    timestamp: new Date(Date.UTC(2026, 3, 8, 0, index, 0)).toISOString(),
  }));
}

describe('range-structure', () => {
  test('names floor, ceiling, invalidation, and active setup from recent bars', () => {
    const result = rangeStructure.analyzeRangeStructure({
      bars5m: buildBars([
        10.8, 10.55, 10.32, 10.18, 10.14, 10.12, 10.18, 10.3, 10.55, 10.78, 10.84, 10.8,
      ]),
      bars15m: buildBars([
        10.82, 10.18, 10.78, 10.14, 10.8, 10.12, 10.76, 10.16, 10.79, 10.13,
      ]),
      bars1h: buildBars([
        10.75, 10.2, 10.78, 10.18, 10.8, 10.15, 10.77, 10.17,
      ]),
      currentPrice: 10.14,
    });

    expect(result.ok).toBe(true);
    expect(result.regime).toBe('range');
    expect(result.floor).toBeLessThan(result.ceiling);
    expect(result.setups.long).toEqual(expect.objectContaining({
      direction: 'BUY',
    }));
    expect(result.setups.long.invalidationPrice).toBeLessThan(result.floor);
    expect(result.setups.long.targetPrice).toBeGreaterThan(result.currentPrice);
  });

  test('does not emit a short setup once price is in breakout_up above the ceiling', () => {
    const result = rangeStructure.analyzeRangeStructure({
      bars5m: buildBars([
        9.08, 9.12, 9.18, 9.24, 9.3, 9.36, 9.42, 9.48, 9.54, 9.62, 9.71, 9.82,
      ]),
      bars15m: buildBars([
        9.08, 9.14, 9.2, 9.28, 9.34, 9.4, 9.46, 9.58, 9.72, 9.84,
      ]),
      bars1h: buildBars([
        9.02, 9.1, 9.18, 9.28, 9.38, 9.48, 9.62, 9.8,
      ]),
      currentPrice: 9.82,
    });

    expect(result.currentPrice).toBeGreaterThanOrEqual(result.ceiling);
    expect(result.setups.short).toBeNull();
  });

  test('keeps a ceiling short available when the market is still inside a validated range', () => {
    const result = rangeStructure.analyzeRangeStructure({
      bars5m: buildBars([
        9.18, 9.26, 9.34, 9.42, 9.5, 9.54, 9.5, 9.46, 9.4, 9.34, 9.28, 9.24,
      ]),
      bars15m: buildBars([
        9.22, 9.5, 9.24, 9.48, 9.26, 9.49, 9.25, 9.47, 9.24, 9.46,
      ]),
      bars1h: buildBars([
        9.24, 9.46, 9.22, 9.48, 9.24, 9.47, 9.23, 9.45,
      ]),
      currentPrice: 9.49,
    });

    expect(result.regime).toBe('range');
    expect(result.setups.short).toEqual(expect.objectContaining({
      direction: 'SELL',
    }));
    expect(result.setups.short.invalidationPrice).toBeGreaterThan(result.ceiling);
  });
});
