'use strict';

const hmTrailingStop = require('../../../scripts/hm-trailing-stop');

describe('hm-trailing-stop', () => {
  test('parseTrailingStopOptions treats 0.5 as 0.5 percent', () => {
    const argv = {
      options: new Map([
        ['asset', 'SUI'],
        ['trail-pct', '0.5'],
        ['dry-run', true],
      ]),
    };

    expect(hmTrailingStop.parseTrailingStopOptions(argv)).toEqual({
      asset: 'SUI',
      trailPct: 0.5,
      trailFraction: 0.005,
      dryRun: true,
      help: false,
    });
  });

  test('normalizeTrailingStopParams rebuilds trailFraction for programmatic calls', () => {
    expect(hmTrailingStop.normalizeTrailingStopParams({
      asset: 'XAI',
      trailPct: 0.6,
      dryRun: false,
    })).toEqual({
      asset: 'XAI',
      trailPct: 0.6,
      trailFraction: 0.006,
      dryRun: false,
      help: false,
    });
  });

  test('computeTrailingStopPrice tightens shorts above the live mark', () => {
    const price = hmTrailingStop.computeTrailingStopPrice({
      isLong: false,
      livePrice: 0.95463,
      trailFraction: 0.005,
      szDecimals: 0,
    });

    expect(price).toBeCloseTo(0.9594, 4);
  });

  test('computeTrailingStopPrice tightens longs below the live mark', () => {
    const price = hmTrailingStop.computeTrailingStopPrice({
      isLong: true,
      livePrice: 2347.25,
      trailFraction: 0.008,
      szDecimals: 2,
    });

    expect(price).toBeCloseTo(2328.5, 1);
  });

  test('evaluateTrailingStopMove approves a tighter short stop only when it locks in more', () => {
    expect(hmTrailingStop.evaluateTrailingStopMove({
      isLong: false,
      livePrice: 0.95463,
      currentStop: 0.9688,
      candidateStop: 0.9594,
    })).toEqual({
      shouldMove: true,
      reason: 'trailing_stop_tightened',
    });

    expect(hmTrailingStop.evaluateTrailingStopMove({
      isLong: false,
      livePrice: 0.95463,
      currentStop: 0.9594,
      candidateStop: 0.9688,
    })).toEqual({
      shouldMove: false,
      reason: 'candidate_stop_not_tighter',
    });
  });

  test('findActiveStopOrder picks the closest protective stop for shorts', () => {
    const { activeStopOrder, stopOrders } = hmTrailingStop.findActiveStopOrder({
      coin: 'SUI',
      signedSize: -3113.3,
      isLong: false,
      entryPx: 0.96361,
    }, [
      { coin: 'SUI', reduceOnly: true, oid: 1, triggerPx: '0.9720', sz: '3113.3' },
      { coin: 'SUI', reduceOnly: true, oid: 2, triggerPx: '0.9688', sz: '3113.3' },
      { coin: 'SUI', reduceOnly: true, oid: 3, triggerPx: '0.9524', sz: '1556.6' },
    ]);

    expect(stopOrders).toHaveLength(2);
    expect(activeStopOrder).toEqual(expect.objectContaining({
      oid: 2,
      price: 0.9688,
    }));
  });

  test('evaluateTrailingStopMove still treats breakeven-or-better short stops as tighter when price has moved enough', () => {
    expect(hmTrailingStop.evaluateTrailingStopMove({
      isLong: false,
      livePrice: 4.2,
      currentStop: 4.35,
      candidateStop: 4.3084,
    })).toEqual({
      shouldMove: true,
      reason: 'trailing_stop_tightened',
    });
  });
});
