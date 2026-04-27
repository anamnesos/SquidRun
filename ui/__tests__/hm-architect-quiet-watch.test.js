'use strict';

const quietWatch = require('../scripts/hm-architect-quiet-watch');

describe('hm-architect-quiet-watch capture layer', () => {
  test('buildPositionAlert includes fast reduce and fast close commands', () => {
    const message = quietWatch.buildPositionAlert(
      {
        ticker: 'ETH/USD',
        side: 'short',
        stopPrice: 2372,
        takeProfit1Price: 2333.7,
        takeProfit2Price: 2320,
      },
      {
        coin: 'ETH',
        ticker: 'ETH/USD',
        side: 'short',
      },
      {
        triggers: [
          {
            label: 'peak_giveback',
            detail: 'peak $60 to $34 = 43% giveback',
            action: 'winner giving back, scale or close instead of hold-and-hope',
          },
        ],
        metrics: {
          currentPrice: 2350.4,
          currentPnlUsd: 34,
          peakUnrealizedPnlUsd: 60,
          gainMarginPct: 0.34,
        },
      }
    );

    expect(message).toContain('fast_reduce=node ui/scripts/hm-defi-close.js --asset ETH --close-pct 50');
    expect(message).toContain('fast_close=node ui/scripts/hm-defi-close.js --asset ETH --close-pct 100');
  });

  test('resolvePositionCadenceMs tightens to 60s when a watched position is open', () => {
    expect(quietWatch.resolvePositionCadenceMs({
      cadences: { positionCheckMs: 300000 },
    }, {
      positions: {
        'ETH/USD': { wasOpen: true },
      },
    })).toBe(60000);

    expect(quietWatch.resolvePositionCadenceMs({
      cadences: { positionCheckMs: 300000 },
    }, {
      positions: {
        'ETH/USD': { wasOpen: false },
      },
    })).toBe(300000);
  });
});
