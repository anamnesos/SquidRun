'use strict';

const convictionEngine = require('../conviction-engine');

describe('conviction-engine', () => {
  test('chooses one dominant setup instead of fanning back into many names', () => {
    const selection = convictionEngine.chooseDominantSetup([
      {
        ticker: 'BTC/USD',
        change4hPct: 0.01,
        structure: {
          ok: true,
          ceilingRejections: 2,
          floorRejections: 2,
          widthPct: 0.018,
          setups: {
            long: {
              direction: 'BUY',
              confidence: 0.68,
              edgeDistancePct: 0.009,
            },
          },
        },
      },
      {
        ticker: 'AVAX/USD',
        change4hPct: 0.045,
        structure: {
          ok: true,
          ceilingRejections: 3,
          floorRejections: 3,
          widthPct: 0.03,
          setups: {
            short: {
              direction: 'SELL',
              confidence: 0.81,
              edgeDistancePct: 0.004,
            },
          },
        },
      },
    ]);

    expect(selection.selectedTicker).toBe('AVAX/USD');
    expect(selection.selectedDirection).toBe('SELL');
    expect(selection.ranked).toHaveLength(2);
  });

  test('takes profit when an open long reaches the planned range target', () => {
    const action = convictionEngine.resolvePositionAction({
      dominant: {
        ticker: 'AVAX/USD',
        setup: {
          direction: 'BUY',
          confidence: 0.81,
          targetPrice: 22,
          invalidationPrice: 18.6,
          rationale: 'Floor rejection is intact.',
        },
        structure: {
          ok: true,
          currentPrice: 21.95,
          targets: { long: 22, short: 18 },
          invalidation: { long: 18.6, short: 22.4 },
          ceiling: 22,
          floor: 18.9,
        },
      },
    }, {
      side: 'long',
    }, {
      ticker: 'AVAX/USD',
      structure: {
        ok: true,
        currentPrice: 21.95,
        targets: { long: 22, short: 18 },
        invalidation: { long: 18.6, short: 22.4 },
        ceiling: 22,
        floor: 18.9,
      },
    });

    expect(action.action).toBe('take_profit');
    expect(action.targetPrice).toBe(22);
  });

  test('aborts a live thesis when the range breaks against the open position', () => {
    const action = convictionEngine.resolvePositionAction({
      dominant: null,
    }, {
      side: 'long',
    }, {
      ticker: 'BTC/USD',
      structure: {
        ok: true,
        currentPrice: 59800,
        invalidation: { long: 60200, short: 64800 },
        targets: { long: 64800, short: 60400 },
        breakoutDown: true,
        mid: 62400,
        hourlySlopePct: -0.03,
      },
    });

    expect(action.action).toBe('abort_thesis');
    expect(action.invalidationPrice).toBe(60200);
  });
});
