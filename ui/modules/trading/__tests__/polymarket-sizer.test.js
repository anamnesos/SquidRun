'use strict';

const {
  kellyFraction,
  positionSize,
  shouldExit,
} = require('../polymarket-sizer');

describe('polymarket-sizer', () => {
  test('kellyFraction returns a positive edge when probability exceeds market price', () => {
    expect(kellyFraction(0.65, 0.5)).toBeCloseTo(0.3, 6);
    expect(kellyFraction(0.45, 0.5)).toBeCloseTo(-0.1, 6);
  });

  test('positionSize applies half-Kelly and max-position caps', () => {
    const size = positionSize(162, 0.8, 0.6, {
      currentExposure: 30,
    });

    expect(size.executable).toBe(true);
    expect(size.rawKellyFraction).toBeCloseTo(0.5, 6);
    expect(size.halfKellyFraction).toBeCloseTo(0.25, 6);
    expect(size.targetFraction).toBeCloseTo(0.15, 6);
    expect(size.stake).toBeCloseTo(24.3, 6);
    expect(size.shares).toBeCloseTo(40.5, 4);
  });

  test('positionSize blocks new trades when position or loss limits are reached', () => {
    const size = positionSize(162, 0.78, 0.62, {
      openPositions: new Array(5).fill({ costBasis: 10 }),
      dailyLossPct: 0.26,
    });

    expect(size.executable).toBe(false);
    expect(size.reasons).toContain('Concurrent position cap reached (5)');
    expect(size.reasons).toContain('Daily loss pause active at 26.0%');
  });

  test('shouldExit triggers on a 20 percent adverse move', () => {
    const result = shouldExit({
      avgEntryPrice: 0.6,
      resolutionDate: '2026-04-15T00:00:00.000Z',
    }, 0.47, {
      now: '2026-03-18T00:00:00.000Z',
    });

    expect(result.exit).toBe(true);
    expect(result.stopPrice).toBeCloseTo(0.48, 4);
    expect(result.reason).toContain('Stop loss triggered');
  });
});
