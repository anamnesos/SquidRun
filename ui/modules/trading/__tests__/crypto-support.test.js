'use strict';

const riskEngine = require('../risk-engine');
const scheduler = require('../scheduler');
const watchlist = require('../watchlist');

describe('crypto trading support', () => {
  beforeEach(() => {
    watchlist.resetWatchlist();
  });

  test('watchlist exposes crypto entries without changing the default equity watchlist', () => {
    expect(watchlist.getTickers()).toEqual(watchlist.DEFAULT_WATCHLIST.map((entry) => entry.ticker));
    expect(watchlist.getTickers({ assetClass: 'crypto' })).toEqual(
      watchlist.DEFAULT_CRYPTO_WATCHLIST.map((entry) => entry.ticker)
    );
    expect(watchlist.getAssetClassForTicker('BTC/USD')).toBe('crypto');
    expect(watchlist.getAssetClassForTicker('AVAX/USD')).toBe('crypto');
    expect(watchlist.getBrokerForTicker('BTC/USD')).toBe('hyperliquid');
    expect(watchlist.getAssetClassForTicker('AAPL')).toBe('us_equity');
    expect(watchlist.getBrokerForTicker('AAPL')).toBe('ibkr');
  });

  test('risk engine applies crypto-specific position sizing with fractional quantities', () => {
    const result = riskEngine.checkTrade({
      ticker: 'BTC/USD',
      direction: 'BUY',
      price: 100000,
      assetClass: 'crypto',
      confidence: 0.65,
    }, {
      equity: 10000,
      peakEquity: 10000,
      dayStartEquity: 10000,
      tradesToday: 0,
      openPositions: [],
    });

    expect(result.approved).toBe(true);
    expect(result.maxShares).toBeCloseTo(0.026562, 6);
    expect(result.positionNotional).toBeCloseTo(2656.25, 2);
    expect(result.stopLossPrice).toBeCloseTo(96000, 6);
  });

  test('scheduler builds a recurring 24-7 crypto schedule', async () => {
    const cryptoDay = scheduler.buildCryptoDailySchedule(new Date('2026-03-18T15:00:00.000Z'));
    const nextEvent = await scheduler.getNextCryptoWakeEvent(new Date('2026-03-18T15:00:00.000Z'));

    expect(cryptoDay.intervalHours).toBe(4);
    expect(cryptoDay.schedule).toHaveLength(6);
    expect(new Set(cryptoDay.schedule.map((event) => event.key))).toEqual(new Set(['crypto_consensus']));
    expect(nextEvent).toMatchObject({
      key: 'crypto_consensus',
      marketDate: cryptoDay.marketDate,
    });
  });
});
