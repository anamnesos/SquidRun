'use strict';

const mtf = require('../multi-timeframe-confirmation');

function makeBars(closes = []) {
  return closes.map((close) => ({
    close,
  }));
}

describe('multi-timeframe-confirmation', () => {
  test('confirms aligned bearish structure for SELL decisions', () => {
    const result = mtf.buildMultiTimeframeConfirmation({
      ticker: 'ETH/USD',
      decision: 'SELL',
      snapshot: {
        tradePrice: 90,
        previousClose: 96,
      },
      timeframeBars: {
        hourly: makeBars([100, 98, 96, 94, 92, 90]),
        fourHour: makeBars([110, 105, 100, 96, 93, 90]),
        daily: makeBars([140, 130, 120, 110, 100, 90]),
      },
      asOf: '2026-04-05T21:00:00.000Z',
    });

    expect(result).toEqual(expect.objectContaining({
      ticker: 'ETH/USD',
      regime: 'full_bear_alignment',
      status: 'confirm',
      sizeMultiplier: 1,
      bias1h: -1,
      bias4h: -1,
      bias1d: -1,
    }));
    expect(result.directionalStates.SELL).toEqual(expect.objectContaining({
      status: 'confirm',
    }));
  });

  test('blocks BUY when 4h and daily oppose the trade', () => {
    const result = mtf.buildMultiTimeframeConfirmation({
      ticker: 'BTC/USD',
      decision: 'BUY',
      snapshot: {
        tradePrice: 90,
        previousClose: 91,
      },
      timeframeBars: {
        hourly: makeBars([95, 94, 93, 92, 91, 90]),
        fourHour: makeBars([120, 115, 110, 105, 100, 95]),
        daily: makeBars([160, 150, 140, 130, 120, 110]),
      },
    });

    expect(result.status).toBe('block');
    expect(result.sizeMultiplier).toBe(0);
    expect(result.directionalStates.BUY).toEqual(expect.objectContaining({
      status: 'block',
    }));
  });

  test('keeps top-level status non-actionable when no decision is supplied', () => {
    const result = mtf.buildMultiTimeframeConfirmation({
      ticker: 'ETH/USD',
      snapshot: {
        tradePrice: 90,
        previousClose: 96,
      },
      timeframeBars: {
        hourly: makeBars([100, 98, 96, 94, 92, 90]),
        fourHour: makeBars([110, 105, 100, 96, 93, 90]),
        daily: makeBars([140, 130, 120, 110, 100, 90]),
      },
    });

    expect(result.status).toBeNull();
    expect(result.sizeMultiplier).toBeNull();
    expect(result.statusBasis).toBe('tape_state');
    expect(result.tapeStatus).toBe('confirm');
    expect(result.directionalStates.SELL).toEqual(expect.objectContaining({
      status: 'confirm',
    }));
  });
});
