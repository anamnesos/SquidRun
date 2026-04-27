'use strict';

jest.mock('../broker-adapter', () => ({
  createBroker: jest.fn(),
}));

const { createBroker } = require('../broker-adapter');
const dataIngestion = require('../data-ingestion');
const watchlist = require('../watchlist');

describe('data-ingestion broker routing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    watchlist.resetWatchlist();
  });

  test('routes ad-hoc Hyperliquid crypto tickers through the hyperliquid broker', async () => {
    createBroker.mockImplementation((type) => ({
      type,
      getHistoricalBars: jest.fn().mockResolvedValue(new Map([
        ['APT/USD', [{ symbol: 'APT/USD', close: 0.9284 }]],
      ])),
    }));

    const bars = await dataIngestion.getHistoricalBars({
      symbols: ['APT/USD'],
    });

    expect(createBroker).toHaveBeenCalledWith('hyperliquid');
    expect(bars.get('APT/USD')).toEqual([
      expect.objectContaining({
        symbol: 'APT/USD',
        close: 0.9284,
      }),
    ]);
  });
});
