'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('@nktkas/hyperliquid', () => ({
  HttpTransport: jest.fn(),
  InfoClient: jest.fn(),
}));

const hyperliquidClient = require('../hyperliquid-client');

describe('hyperliquid-client native wrappers', () => {
  let requestPoolPath;

  beforeEach(() => {
    jest.clearAllMocks();
    hyperliquidClient.__resetRequestPoolState();
    requestPoolPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hl-pool-')), 'request-pool.json');
  });

  test('prefers Hyperliquid wallet env vars over Polymarket funder address', () => {
    expect(hyperliquidClient.resolveWalletAddress({
      POLYMARKET_FUNDER_ADDRESS: '0xpoly',
      HYPERLIQUID_WALLET_ADDRESS: '0xhyper',
      HYPERLIQUID_ADDRESS: '0xlegacy',
    })).toBe('0xhyper');

    expect(hyperliquidClient.resolveWalletAddress({
      POLYMARKET_FUNDER_ADDRESS: '0xpoly',
      HYPERLIQUID_ADDRESS: '0xlegacy',
    })).toBe('0xlegacy');
  });

  test('normalizes predicted funding payloads by coin and venue', () => {
    const result = hyperliquidClient.normalizePredictedFundingPayload([
      ['BTC', [
        ['HlPerp', { fundingRate: '-0.00012', nextFundingTime: 1_775_422_800_000, fundingIntervalHours: 1 }],
        ['BinPerp', { fundingRate: '-0.0002', nextFundingTime: 1_775_433_600_000, fundingIntervalHours: 4 }],
      ]],
    ], '2026-04-05T21:00:00.000Z');

    expect(result).toEqual(expect.objectContaining({
      asOf: '2026-04-05T21:00:00.000Z',
      byCoin: expect.objectContaining({
        BTC: expect.objectContaining({
          venue: 'HlPerp',
          fundingRate: -0.00012,
          fundingIntervalHours: 1,
          venues: expect.objectContaining({
            HlPerp: expect.objectContaining({
              fundingRate: -0.00012,
            }),
          }),
        }),
      }),
    }));
  });

  test('normalizes l2 book depth into spread and imbalance metrics', () => {
    const result = hyperliquidClient.normalizeL2BookPayload('BTC', {
      time: 1_775_425_829_984,
      levels: [
        [
          { px: '67511', sz: '13', n: 43 },
          { px: '67510', sz: '2', n: 4 },
        ],
        [
          { px: '67512', sz: '1', n: 3 },
          { px: '67513', sz: '1.5', n: 3 },
        ],
      ],
    }, '2026-04-05T21:10:00.000Z');

    expect(result).toEqual(expect.objectContaining({
      coin: 'BTC',
      bestBid: 67511,
      bestAsk: 67512,
      spread: 1,
      nearTouchSkew: 'bid_heavy',
      depthImbalanceTop5: expect.any(Number),
      bids: expect.arrayContaining([
        expect.objectContaining({
          px: 67511,
          sz: 13,
          usd: 877643,
        }),
      ]),
    }));
  });

  test('preserves canonical Hyperliquid coin casing for historical bars', async () => {
    const infoClient = {
      candleSnapshot: jest.fn().mockResolvedValue([
        { t: 1_775_425_829_984, o: '0.0035', h: '0.0037', l: '0.0034', c: '0.0036', v: '12345', n: 42 },
      ]),
      metaAndAssetCtxs: jest.fn().mockResolvedValue([
        { universe: [{ name: 'kPEPE' }] },
        [{ markPx: '0.0036', midPx: '0.0036', dayNtlVlm: '120000', openInterest: '90000', prevDayPx: '0.0034' }],
      ]),
    };

    const barsBySymbol = await hyperliquidClient.getHistoricalBars({
      infoClient,
      requestPoolPath,
      requestPoolTtlMs: 10_000,
      symbols: ['KPEPE/USD'],
      timeframe: '4Hour',
      limit: 1,
    });

    expect(infoClient.candleSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      coin: 'kPEPE',
      interval: '1d',
    }));
    expect(barsBySymbol.get('KPEPE/USD')).toEqual([
      expect.objectContaining({
        symbol: 'KPEPE/USD',
        close: 0.0036,
      }),
    ]);
  });

  test('reuses pooled metaAndAssetCtxs responses within the same cycle', async () => {
    const payload = [
      { universe: [{ name: 'BTC' }] },
      [{ markPx: '67511' }],
    ];
    const infoClient = {
      metaAndAssetCtxs: jest.fn().mockResolvedValue(payload),
    };

    const first = await hyperliquidClient.getMetaAndAssetCtxs({
      infoClient,
      requestPoolPath,
      requestPoolTtlMs: 10_000,
    });
    const second = await hyperliquidClient.getMetaAndAssetCtxs({
      infoClient,
      requestPoolPath,
      requestPoolTtlMs: 10_000,
    });

    expect(first).toEqual(payload);
    expect(second).toEqual(payload);
    expect(infoClient.metaAndAssetCtxs).toHaveBeenCalledTimes(1);
  });

  test('falls back to the last good pooled metaAndAssetCtxs payload when a fresh response is zeroed', async () => {
    const healthyPayload = [
      { universe: [{ name: 'BTC' }, { name: 'ETH' }] },
      [
        { markPx: '67511', midPx: '67512', dayNtlVlm: '1200000', openInterest: '25000', prevDayPx: '67000' },
        { markPx: '3200', midPx: '3201', dayNtlVlm: '900000', openInterest: '180000', prevDayPx: '3150' },
      ],
    ];
    fs.writeFileSync(requestPoolPath, JSON.stringify({
      'info:metaAndAssetCtxs': {
        cachedAt: Date.now() - 60_000,
        value: healthyPayload,
      },
    }, null, 2));

    const infoClient = {
      metaAndAssetCtxs: jest.fn().mockResolvedValue([
        { universe: [{ name: 'BTC' }, { name: 'ETH' }] },
        [
          { markPx: '0', midPx: '0', dayNtlVlm: '0', openInterest: '0', prevDayPx: '0' },
          { markPx: '0', midPx: '0', dayNtlVlm: '0', openInterest: '0', prevDayPx: '0' },
        ],
      ]),
    };

    const result = await hyperliquidClient.getMetaAndAssetCtxs({
      infoClient,
      requestPoolPath,
      requestPoolTtlMs: 1,
    });

    expect(result).toEqual(healthyPayload);
    expect(infoClient.metaAndAssetCtxs).toHaveBeenCalledTimes(1);
  });

  test('merges builder-dex positions into the open position list', async () => {
    const infoClient = {
      perpDexs: jest.fn().mockResolvedValue([
        { name: 'xyz' },
        { name: 'flx' },
      ]),
      clearinghouseState: jest.fn().mockImplementation(({ dex } = {}) => {
        if (dex === 'xyz') {
          return Promise.resolve({
            marginSummary: {
              accountValue: '47.5',
              totalMarginUsed: '22.1',
            },
            withdrawable: '25.4',
            assetPositions: [
              {
                position: {
                  coin: 'xyz:CL',
                  szi: '-2.5',
                  entryPx: '87.614',
                  unrealizedPnl: '12.34',
                  liquidationPx: '95.1',
                },
              },
            ],
          });
        }
        if (dex === 'flx') {
          return Promise.resolve({
            marginSummary: {
              accountValue: '0',
              totalMarginUsed: '0',
            },
            withdrawable: '0',
            assetPositions: [],
          });
        }
        return Promise.resolve({
          marginSummary: {
            accountValue: '410.2',
            totalMarginUsed: '30.3',
          },
          withdrawable: '379.9',
          assetPositions: [
            {
              position: {
                coin: 'ETH',
                szi: '1.2',
                entryPx: '2400',
                unrealizedPnl: '5.6',
                liquidationPx: '2000',
              },
            },
          ],
        });
      }),
    };

    const positions = await hyperliquidClient.getOpenPositions({
      walletAddress: '0xabc',
      infoClient,
      requestPoolPath,
      requestPoolTtlMs: 10_000,
    });

    expect(positions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        coin: 'ETH',
        dex: null,
        side: 'long',
      }),
      expect.objectContaining({
        coin: 'xyz:CL',
        dex: 'xyz',
        side: 'short',
        unrealizedPnl: 12.34,
      }),
    ]));
    expect(infoClient.perpDexs).toHaveBeenCalledTimes(1);
    expect(infoClient.clearinghouseState).toHaveBeenCalledWith(expect.objectContaining({ user: '0xabc' }));
    expect(infoClient.clearinghouseState).toHaveBeenCalledWith(expect.objectContaining({ user: '0xabc', dex: 'xyz' }));
  });

  test('aggregates account totals across main and builder dexs', async () => {
    const infoClient = {
      perpDexs: jest.fn().mockResolvedValue([
        { name: 'xyz' },
      ]),
      clearinghouseState: jest.fn().mockImplementation(({ dex } = {}) => {
        if (dex === 'xyz') {
          return Promise.resolve({
            marginSummary: {
              accountValue: '47.5',
              totalMarginUsed: '22.1',
            },
            withdrawable: '25.4',
            assetPositions: [
              { position: { coin: 'xyz:CL', szi: '-2.5' } },
            ],
          });
        }
        return Promise.resolve({
          marginSummary: {
            accountValue: '410.2',
            totalMarginUsed: '30.3',
          },
          withdrawable: '379.9',
          assetPositions: [],
        });
      }),
    };

    const account = await hyperliquidClient.getAccountSnapshot({
      walletAddress: '0xabc',
      infoClient,
      requestPoolPath,
      requestPoolTtlMs: 10_000,
    });

    expect(account.equity).toBeCloseTo(457.7, 8);
    expect(account.cash).toBeCloseTo(405.3, 8);
    expect(account.buyingPower).toBeCloseTo(405.3, 8);
    expect(account.raw.dexAccounts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        dex: null,
        label: 'main',
        accountValue: 410.2,
      }),
      expect.objectContaining({
        dex: 'xyz',
        label: 'xyz',
        accountValue: 47.5,
        positions: 1,
      }),
    ]));
  });
});
