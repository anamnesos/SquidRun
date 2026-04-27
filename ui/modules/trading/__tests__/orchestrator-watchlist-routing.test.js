'use strict';

const watchlist = require('../watchlist');
const { createOrchestrator } = require('../orchestrator');

describe('orchestrator watchlist routing', () => {
  beforeEach(() => {
    watchlist.resetWatchlist();
  });

  test('auto-adds ad-hoc Hyperliquid crypto tickers when registering signals', () => {
    const orchestrator = createOrchestrator({
      consultationSender: jest.fn(),
      consultationQuery: jest.fn(),
    });

    expect(watchlist.isWatched('APT/USD')).toBe(false);

    const registration = orchestrator.registerSignal('builder', 'APT/USD', {
      direction: 'SELL',
      confidence: 0.67,
      reasoning: 'fresh scanner short candidate',
    });

    expect(registration).toEqual(expect.objectContaining({
      ticker: 'APT/USD',
      agent: 'builder',
      receivedCount: 1,
    }));
    expect(watchlist.isWatched('APT/USD')).toBe(true);
    expect(watchlist.getBrokerForTicker('APT/USD')).toBe('hyperliquid');
    expect(watchlist.getAssetClassForTicker('APT/USD')).toBe('crypto');
  });
});
