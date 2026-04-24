'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('@nktkas/hyperliquid', () => ({
  HttpTransport: jest.fn(),
  InfoClient: jest.fn(),
}));

const hyperliquidClient = require('../hyperliquid-client');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

  test('honors file-backed pending claims across fresh process state resets', async () => {
    const payload = [
      { universe: [{ name: 'BTC' }] },
      [{ markPx: '67511', midPx: '67512', dayNtlVlm: '1200000', openInterest: '25000', prevDayPx: '67000' }],
    ];
    let resolveFirstRequest = null;
    const infoClient = {
      metaAndAssetCtxs: jest.fn().mockImplementation(() => new Promise((resolve) => {
        resolveFirstRequest = () => resolve(payload);
      })),
    };

    const poolOptions = {
      infoClient,
      requestPoolPath,
      requestPoolTtlMs: 10_000,
      requestPoolPendingTtlMs: 5_000,
      requestPoolWaitPollMs: 25,
    };

    const firstPromise = hyperliquidClient.getMetaAndAssetCtxs(poolOptions);

    let pendingClaimSeen = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (fs.existsSync(requestPoolPath)) {
        const poolState = JSON.parse(fs.readFileSync(requestPoolPath, 'utf8'));
        if (poolState?.['info:metaAndAssetCtxs']?.pendingUntilMs) {
          pendingClaimSeen = true;
          break;
        }
      }
      await sleep(25);
    }
    expect(pendingClaimSeen).toBe(true);

    hyperliquidClient.__resetRequestPoolState();

    const secondPromise = hyperliquidClient.getMetaAndAssetCtxs(poolOptions);
    resolveFirstRequest();

    await expect(firstPromise).resolves.toEqual(payload);
    await expect(secondPromise).resolves.toEqual(payload);
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

  test('getUniverseMarketData exposes meta.universe position as assetIndex, independent of szDecimals', async () => {
    const infoClient = {
      allMids: jest.fn().mockResolvedValue({ BTC: '60000', ATOM: '5', SOL: '80' }),
      metaAndAssetCtxs: jest.fn().mockResolvedValue([
        {
          universe: [
            { name: 'BTC', szDecimals: 5 },
            { name: 'ETH', szDecimals: 4 },
            { name: 'ATOM', szDecimals: 2 },
            { name: 'MATIC', szDecimals: 1 },
            { name: 'AVAX', szDecimals: 2 },
            { name: 'SOL', szDecimals: 2 },
          ],
        },
        [
          { markPx: '60000', midPx: '60000', funding: '0' },
          { markPx: '3000', midPx: '3000', funding: '0' },
          { markPx: '5', midPx: '5', funding: '0' },
          { markPx: '0.6', midPx: '0.6', funding: '0' },
          { markPx: '25', midPx: '25', funding: '0' },
          { markPx: '80', midPx: '80', funding: '0' },
        ],
      ]),
    };

    const data = await hyperliquidClient.getUniverseMarketData({ infoClient });
    const btc = data.find((row) => row.coin === 'BTC');
    const atom = data.find((row) => row.coin === 'ATOM');
    const sol = data.find((row) => row.coin === 'SOL');

    expect(btc.assetIndex).toBe(0);
    expect(atom.assetIndex).toBe(2);
    expect(sol.assetIndex).toBe(5);
    expect(sol.assetIndex).not.toBe(sol.sizeDecimals);
    expect(sol.sizeDecimals).toBe(2);
  });

  test('rate-limit token bucket serializes a burst of concurrent callers', async () => {
    const originalCapacity = process.env.SQUIDRUN_HYPERLIQUID_RATE_LIMIT_BUCKET_CAPACITY;
    const originalRefill = process.env.SQUIDRUN_HYPERLIQUID_RATE_LIMIT_BUCKET_REFILL_PER_SEC;
    // Tight bucket so the test observes queueing in a handful of ms rather than real seconds.
    process.env.SQUIDRUN_HYPERLIQUID_RATE_LIMIT_BUCKET_CAPACITY = '3';
    process.env.SQUIDRUN_HYPERLIQUID_RATE_LIMIT_BUCKET_REFILL_PER_SEC = '100';
    jest.resetModules();
    const client = require('../hyperliquid-client');
    client.__resetRateLimitBucket();
    try {
      const burst = 10;
      const acquired = [];
      const results = await Promise.all(
        Array.from({ length: burst }, (_, idx) =>
          client
            .acquireRateLimitToken({ rateLimitQueueTimeoutMs: 2000 })
            .then(() => {
              acquired.push(idx);
              return idx;
            })
        )
      );
      expect(results).toHaveLength(burst);
      expect(acquired).toHaveLength(burst);
    } finally {
      if (originalCapacity === undefined) delete process.env.SQUIDRUN_HYPERLIQUID_RATE_LIMIT_BUCKET_CAPACITY;
      else process.env.SQUIDRUN_HYPERLIQUID_RATE_LIMIT_BUCKET_CAPACITY = originalCapacity;
      if (originalRefill === undefined) delete process.env.SQUIDRUN_HYPERLIQUID_RATE_LIMIT_BUCKET_REFILL_PER_SEC;
      else process.env.SQUIDRUN_HYPERLIQUID_RATE_LIMIT_BUCKET_REFILL_PER_SEC = originalRefill;
      jest.resetModules();
    }
  });

  test('rate-limit token bucket rejects on queue timeout', async () => {
    const originalCapacity = process.env.SQUIDRUN_HYPERLIQUID_RATE_LIMIT_BUCKET_CAPACITY;
    const originalRefill = process.env.SQUIDRUN_HYPERLIQUID_RATE_LIMIT_BUCKET_REFILL_PER_SEC;
    // Capacity 1, refill 1/sec — second acquire waits ~1s, so a 50ms timeout trips.
    process.env.SQUIDRUN_HYPERLIQUID_RATE_LIMIT_BUCKET_CAPACITY = '1';
    process.env.SQUIDRUN_HYPERLIQUID_RATE_LIMIT_BUCKET_REFILL_PER_SEC = '1';
    jest.resetModules();
    const client = require('../hyperliquid-client');
    client.__resetRateLimitBucket();
    try {
      await client.acquireRateLimitToken();
      await expect(
        client.acquireRateLimitToken({ rateLimitQueueTimeoutMs: 50 })
      ).rejects.toMatchObject({ code: 'rate_limit_queue_timeout' });
    } finally {
      if (originalCapacity === undefined) delete process.env.SQUIDRUN_HYPERLIQUID_RATE_LIMIT_BUCKET_CAPACITY;
      else process.env.SQUIDRUN_HYPERLIQUID_RATE_LIMIT_BUCKET_CAPACITY = originalCapacity;
      if (originalRefill === undefined) delete process.env.SQUIDRUN_HYPERLIQUID_RATE_LIMIT_BUCKET_REFILL_PER_SEC;
      else process.env.SQUIDRUN_HYPERLIQUID_RATE_LIMIT_BUCKET_REFILL_PER_SEC = originalRefill;
      jest.resetModules();
    }
  });

  test('rate-limit token bucket respects bypassRateLimitBucket option', async () => {
    const client = require('../hyperliquid-client');
    client.__resetRateLimitBucket();
    // Even if we drained all tokens, bypass still resolves immediately.
    for (let i = 0; i < 200; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await client.acquireRateLimitToken({ bypassRateLimitBucket: true });
    }
  });
});
