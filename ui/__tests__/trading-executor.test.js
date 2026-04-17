const executor = require('../modules/trading/executor');

describe('executor Hyperliquid crypto behavior', () => {
  test('dry-run SELL consensus on Hyperliquid becomes an executable short payload', async () => {
    const result = await executor.executeConsensusTrade({
      ticker: 'ETH/USD',
      assetClass: 'crypto',
      price: 2000,
      account: {
        equity: 1000,
        peakEquity: 1000,
        dayStartEquity: 1000,
        tradesToday: 0,
        openPositions: [],
      },
      consensus: {
        ticker: 'ETH/USD',
        decision: 'SELL',
        consensus: true,
      },
    }, {
      broker: 'hyperliquid',
      dryRun: true,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      status: 'dry_run',
      payload: expect.objectContaining({
        symbol: 'ETH/USD',
        side: 'sell',
        broker: 'hyperliquid',
        direction: 'SHORT',
        position_effect: 'open_short',
        reduce_only: false,
      }),
    }));
    expect(result.payload.qty).toBeGreaterThan(0);
  });
});
