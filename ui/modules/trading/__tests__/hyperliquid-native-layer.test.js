'use strict';

jest.mock('../hyperliquid-client', () => ({
  getPredictedFundings: jest.fn(),
  getHistoricalBars: jest.fn(),
  getUserVaultEquities: jest.fn(),
  getUniverseMarketData: jest.fn(),
  getL2Book: jest.fn(),
  getVaultDetails: jest.fn(),
  normalizeCoinSymbol: jest.fn((ticker) => String(ticker || '').toUpperCase().replace(/\/USD$/, '')),
  resolveWalletAddress: jest.fn(() => '0xwallet'),
}));

jest.mock('../multi-timeframe-confirmation', () => ({
  buildMultiTimeframeConfirmation: jest.fn(() => ({
    tapeStatus: 'confirm',
    status: null,
    sizeMultiplier: null,
    statusBasis: 'tape_state',
    directionalStates: {
      BUY: { status: 'confirm', sizeMultiplier: 1 },
      SELL: { status: 'block', sizeMultiplier: 0 },
    },
  })),
}));

const hyperliquidClient = require('../hyperliquid-client');
const nativeLayer = require('../hyperliquid-native-layer');

describe('hyperliquid native layer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    hyperliquidClient.getPredictedFundings.mockResolvedValue({
      asOf: '2026-04-06T02:00:00.000Z',
      byCoin: {
        ZETA: {
          fundingRate: -0.00155893,
          venues: {
            HlPerp: { fundingRate: -0.00155893 },
            Binance: { fundingRate: -0.0052 },
            Bybit: { fundingRate: -0.0089 },
          },
        },
      },
      raw: [],
    });
    hyperliquidClient.getHistoricalBars.mockResolvedValue(new Map([
      ['ZETA/USD', []],
    ]));
    hyperliquidClient.getUserVaultEquities.mockResolvedValue({
      entries: [],
    });
    hyperliquidClient.getUniverseMarketData.mockResolvedValue([
      {
        coin: 'ZETA',
        ticker: 'ZETA/USD',
        price: 0.05161,
        markPx: 0.05161,
        oraclePx: 0.05213,
        premium: -0.00824861,
        openInterest: 14793746.8,
        volumeUsd24h: 763539.1323,
      },
    ]);
    hyperliquidClient.getL2Book.mockResolvedValue({
      nearTouchSkew: 'bid_heavy',
      spreadPct: 0.0007,
      depthImbalanceTop5: 0.26,
      depthImbalanceTop10: 0.19,
    });
    hyperliquidClient.getVaultDetails.mockResolvedValue(null);
  });

  test('builds cross-venue funding divergence and crowding signals into native symbols', async () => {
    const bundle = await nativeLayer.buildNativeFeatureBundle({
      symbols: ['ZETA/USD'],
    });

    expect(bundle.ok).toBe(true);
    expect(bundle.degradedSources).toEqual([]);
    expect(bundle.symbols['ZETA/USD']).toEqual(expect.objectContaining({
      crossVenueFunding: expect.objectContaining({
        hlFundingBps: -15.5893,
        binanceFundingBps: -52,
        bybitFundingBps: -89,
        basisSpreadBps: 73.4107,
        strongestVsHl: expect.objectContaining({
          venue: 'Bybit',
          spreadBps: 73.4107,
          absoluteSpreadBps: 73.4107,
        }),
        divergenceScore: 1,
        directionalBias: 'short_crowded_on_hl',
      }),
      crowdingLiquidity: expect.objectContaining({
        openInterestToVolume: 19.3752,
        premiumBps: -82.4861,
        l2Skew: 'bid_heavy',
        score: expect.any(Number),
        components: expect.objectContaining({
          fundingDivergenceScore: 1,
        }),
        reasons: expect.arrayContaining([
          'cross_venue_funding_divergence',
          'premium_extreme',
          'l2_bid_heavy',
        ]),
      }),
      universeMarket: expect.objectContaining({
        coin: 'ZETA',
        openInterest: 14793746.8,
        volumeUsd24h: 763539.1323,
      }),
    }));
  });

  test('falls back cleanly when funding is unavailable for a symbol', async () => {
    hyperliquidClient.getPredictedFundings.mockResolvedValueOnce({
      asOf: '2026-04-06T02:00:00.000Z',
      byCoin: {},
      raw: [],
    });

    const bundle = await nativeLayer.buildNativeFeatureBundle({
      symbols: ['ZETA/USD'],
    });

    expect(bundle.symbols['ZETA/USD'].crossVenueFunding).toEqual(expect.objectContaining({
      basisSpreadBps: null,
      divergenceScore: 0,
      directionalBias: 'neutral',
    }));
    expect(bundle.symbols['ZETA/USD'].crowdingLiquidity).toEqual(expect.objectContaining({
      components: expect.objectContaining({
        fundingDivergenceScore: 0,
      }),
    }));
  });
});
