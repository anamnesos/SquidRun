'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../hyperliquid-client', () => ({
  getUniverseMarketData: jest.fn(),
  getHistoricalBars: jest.fn(),
}));

jest.mock('../../../scripts/hm-tokenomist-unlocks', () => ({
  runScan: jest.fn(),
}));

const hyperliquidClient = require('../hyperliquid-client');
const { runScan: scanTokenUnlocks } = require('../../../scripts/hm-tokenomist-unlocks');
const sparkCapture = require('../spark-capture');

describe('spark-capture', () => {
  let tempRoot;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'spark-capture-'));
    hyperliquidClient.getUniverseMarketData.mockReset();
    hyperliquidClient.getHistoricalBars.mockReset();
    scanTokenUnlocks.mockReset();

    hyperliquidClient.getUniverseMarketData.mockResolvedValue([
      {
        coin: 'CHIP',
        ticker: 'CHIP/USD',
        price: 0.106,
        raw: {
          asset: {
            isDelisted: false,
            maxLeverage: 3,
          },
        },
      },
      {
        coin: 'OP',
        ticker: 'OP/USD',
        price: 0.118,
        raw: {
          asset: {
            isDelisted: false,
            maxLeverage: 5,
          },
        },
      },
    ]);
    hyperliquidClient.getHistoricalBars.mockResolvedValue(new Map());
    scanTokenUnlocks.mockResolvedValue({
      ok: true,
      unlocks: [
        {
          token: 'OP',
          ticker: 'OP/USD',
          unlockAt: '2026-04-23T13:30:00.000Z',
          countdownText: '0 D 04 H 00 M 00 S',
          unlockSizeUsd: 513560,
          unlockSizeText: '$513.56K',
          unlockPctSupply: 0.22,
          unlockPctSupplyText: '0.22%',
          recipientType: 'unknown',
          hyperliquidVolumeUsd24h: 753000,
          hyperliquidVolumeUsd24hText: '$753.00K',
        },
      ],
    });
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  test('detectNewUpbitEvents only alerts recent notices on an empty baseline', () => {
    const notices = [
      {
        id: 6158,
        publishedAt: '2026-04-23T09:00:00.000Z',
      },
      {
        id: 6154,
        publishedAt: '2026-04-20T09:00:00.000Z',
      },
    ];

    const result = sparkCapture.detectNewUpbitEvents(notices, sparkCapture.defaultSparkState(), {
      now: '2026-04-23T09:30:00.000Z',
      initialAlertLookbackMinutes: 90,
    });

    expect(result).toEqual([
      expect.objectContaining({ id: 6158 }),
    ]);
  });

  test('detectHyperliquidListingEvents seeds baseline and only alerts on newly added coins after that', () => {
    const initial = sparkCapture.detectHyperliquidListingEvents([
      { coin: 'BTC', raw: { asset: { isDelisted: false } } },
      { coin: 'ETH', raw: { asset: { isDelisted: false } } },
    ], sparkCapture.defaultSparkState(), { now: '2026-04-23T09:00:00.000Z' });

    expect(initial.events).toEqual([]);

    const later = sparkCapture.detectHyperliquidListingEvents([
      { coin: 'BTC', raw: { asset: { isDelisted: false } } },
      { coin: 'ETH', raw: { asset: { isDelisted: false } } },
      { coin: 'CHIP', raw: { asset: { isDelisted: false } } },
    ], {
      ...sparkCapture.defaultSparkState(),
      hyperliquid: {
        knownUniverseCoins: ['BTC', 'ETH'],
      },
    }, { now: '2026-04-23T09:05:00.000Z' });

    expect(later.events).toEqual([
      expect.objectContaining({
        eventKey: 'hyperliquid:CHIP',
        tickers: ['CHIP/USD'],
      }),
    ]);
  });

  test('buildFirePlan falls back to percentage-based levels when bar history is unavailable', () => {
    const plan = sparkCapture.buildFirePlan({
      source: 'upbit',
      catalystType: 'upbit_listing',
      title: 'CHIP listing',
      tickers: ['CHIP/USD'],
      detectedAt: '2026-04-23T09:00:00.000Z',
      publishedAt: '2026-04-23T09:00:00.000Z',
    }, {
      universeByTicker: new Map([
        ['CHIP/USD', {
          price: 0.106,
          raw: {
            asset: {
              isDelisted: false,
              maxLeverage: 3,
            },
          },
        }],
      ]),
      bars5m: new Map(),
      bars1h: new Map(),
    });

    expect(plan.ready).toBe(true);
    expect(plan.entryZone.lower).toBeGreaterThan(0);
    expect(plan.stopPrice).toBeGreaterThan(0);
    expect(plan.stopPrice).toBeLessThan(plan.entryZone.lower);
    expect(plan.takeProfit1).toBeGreaterThan(plan.entryZone.upper);
  });

  test('runSparkScan seeds baseline state and suppresses repeated token unlock alerts with drifting timestamps', async () => {
    const statePath = path.join(tempRoot, 'spark-state.json');
    const eventsPath = path.join(tempRoot, 'spark-events.jsonl');
    const firePlansPath = path.join(tempRoot, 'spark-fireplans.json');
    const watchlistPath = path.join(tempRoot, 'spark-watchlist.json');
    const tokenomistSourcePath = path.join(tempRoot, 'tokenomist-current.yml');
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          notices: [
            {
              id: 6162,
              title: '스파크(SPK) KRW 마켓 디지털 자산 추가',
              category: '거래',
              listed_at: '2026-04-23T09:00:00.000Z',
            },
            {
              id: 6158,
              title: '유에스디에이아이(CHIP) 신규 거래지원 안내 (KRW, BTC, USDT 마켓)',
              category: '거래',
              listed_at: '2026-04-21T09:00:00.000Z',
            },
          ],
        },
      }),
    });
    fs.writeFileSync(tokenomistSourcePath, 'fresh tokenomist payload\n', 'utf8');

    const first = await sparkCapture.runSparkScan({
      now: '2026-04-23T09:30:00.000Z',
      statePath,
      eventsPath,
      firePlansPath,
      watchlistPath,
      tokenomistSourcePath,
      fetch: fetchMock,
    });

    scanTokenUnlocks.mockResolvedValueOnce({
      ok: true,
      unlocks: [
        {
          token: 'OP',
          ticker: 'OP/USD',
          unlockAt: '2026-04-23T13:47:00.000Z',
          countdownText: '0 D 04 H 00 M 00 S',
          unlockSizeUsd: 513560,
          unlockSizeText: '$513.56K',
          unlockPctSupply: 0.22,
          unlockPctSupplyText: '0.22%',
          recipientType: 'unknown',
          hyperliquidVolumeUsd24h: 753000,
          hyperliquidVolumeUsd24hText: '$753.00K',
        },
      ],
    });

    const second = await sparkCapture.runSparkScan({
      now: '2026-04-23T09:31:00.000Z',
      statePath,
      eventsPath,
      firePlansPath,
      watchlistPath,
      tokenomistSourcePath,
      fetch: fetchMock,
    });

    const persisted = sparkCapture.readSparkState(statePath);

    expect(first.newAlertEvents).toEqual([
      expect.objectContaining({ eventKey: 'upbit:6162' }),
    ]);
    expect(second.newAlertEvents).toEqual([]);
    expect(persisted.upbit.seenNoticeIds).toEqual(expect.arrayContaining([6162, 6158]));
    expect(persisted.tokenomist.seenUnlockKeys).toEqual(expect.arrayContaining(['tokenomist:OP:2026-04-23T13']));
  });

  test('runSparkScan suppresses token unlock catalysts and fire plans when tokenomist source is stale', async () => {
    const statePath = path.join(tempRoot, 'spark-state.json');
    const eventsPath = path.join(tempRoot, 'spark-events.jsonl');
    const firePlansPath = path.join(tempRoot, 'spark-fireplans.json');
    const watchlistPath = path.join(tempRoot, 'spark-watchlist.json');
    const tokenomistSourcePath = path.join(tempRoot, 'tokenomist-current.yml');

    fs.writeFileSync(tokenomistSourcePath, 'stale tokenomist payload\n', 'utf8');
    const staleAt = new Date('2026-04-20T09:00:00.000Z');
    fs.utimesSync(tokenomistSourcePath, staleAt, staleAt);

    const result = await sparkCapture.runSparkScan({
      now: '2026-04-23T09:30:00.000Z',
      statePath,
      eventsPath,
      firePlansPath,
      watchlistPath,
      tokenomistSourcePath,
      fetch: jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: {
            notices: [],
          },
        }),
      }),
    });

    expect(scanTokenUnlocks).not.toHaveBeenCalled();
    expect(result.tokenUnlockCount).toBe(0);
    expect(result.newAlertEvents).toEqual([]);
    expect(result.firePlans.filter((plan) => plan.catalystType === 'token_unlock')).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toEqual(expect.objectContaining({
      kind: 'stale_tokenomist_source',
      path: tokenomistSourcePath,
    }));
    expect(result.warnings[0].ageHours).toBeGreaterThanOrEqual(48);
    expect(result.warningMessage).toContain('Tokenomist unlock catalysts suppressed');
    expect(result.warningMessage).toContain('stale');
    expect(result.tokenomist).toEqual(expect.objectContaining({
      ok: false,
      suppressed: true,
      suppressionReason: 'stale_tokenomist_source',
      unlockCount: 0,
    }));
  });

  test('runSparkScan fails loudly when Hyperliquid universe fetch rejects (e.g. 429) and preserves state', async () => {
    const statePath = path.join(tempRoot, 'spark-state.json');
    const eventsPath = path.join(tempRoot, 'spark-events.jsonl');
    const firePlansPath = path.join(tempRoot, 'spark-fireplans.json');
    const watchlistPath = path.join(tempRoot, 'spark-watchlist.json');
    const tokenomistSourcePath = path.join(tempRoot, 'tokenomist-current.yml');
    fs.writeFileSync(tokenomistSourcePath, 'fresh tokenomist payload\n', 'utf8');

    // Seed prior state so we can verify it is not wiped on degraded scans.
    const priorState = {
      ...sparkCapture.defaultSparkState(),
      lastRunAt: '2026-04-23T09:00:00.000Z',
      hyperliquid: { knownUniverseCoins: ['BTC', 'ETH', 'CHIP'] },
      upbit: { seenNoticeIds: [6100] },
    };
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(priorState, null, 2));

    hyperliquidClient.getUniverseMarketData.mockRejectedValueOnce(new Error('http_429'));

    const result = await sparkCapture.runSparkScan({
      now: '2026-04-23T09:30:00.000Z',
      statePath,
      eventsPath,
      firePlansPath,
      watchlistPath,
      tokenomistSourcePath,
      fetch: jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: { notices: [] } }),
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.degraded).toBe(true);
    expect(result.reason).toBe('universe_fetch_failed');
    expect(result.error).toBe('http_429');
    expect(result.firePlans).toEqual([]);
    expect(result.newAlertEvents).toEqual([]);
    expect(result.warnings[0]).toEqual(expect.objectContaining({
      kind: 'hyperliquid_universe_unavailable',
      reason: 'universe_fetch_failed',
    }));

    // State must be preserved — not wiped to empty knownUniverseCoins.
    const persisted = sparkCapture.readSparkState(statePath);
    expect(persisted.hyperliquid.knownUniverseCoins).toEqual(['BTC', 'ETH', 'CHIP']);
    expect(persisted.upbit.seenNoticeIds).toEqual([6100]);
    expect(persisted.lastRunAt).toBe('2026-04-23T09:00:00.000Z');
  });
});
