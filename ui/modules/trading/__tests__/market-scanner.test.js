'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../hyperliquid-client', () => ({
  getUniverseMarketData: jest.fn(),
  getHistoricalBars: jest.fn(),
}));

const hyperliquidClient = require('../hyperliquid-client');
const marketScanner = require('../market-scanner');

describe('market-scanner', () => {
  let tempDir;
  let statePath;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-market-scanner-'));
    statePath = path.join(tempDir, 'market-scanner-state.json');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  test('flags full-universe movers and persists ranked results', async () => {
    hyperliquidClient.getUniverseMarketData.mockResolvedValue([
      {
        coin: 'AVAX',
        ticker: 'AVAX/USD',
        price: 9,
        prevDayPx: 10,
        fundingRate: 0.00012,
        openInterest: 1000,
        volumeUsd24h: 125000000,
      },
      {
        coin: 'BTC',
        ticker: 'BTC/USD',
        price: 65000,
        prevDayPx: 64800,
        fundingRate: 0.00001,
        openInterest: 25000,
        volumeUsd24h: 950000000,
      },
    ]);
    hyperliquidClient.getHistoricalBars.mockResolvedValue(new Map([
      ['AVAX/USD', [
        { open: 10, close: 9.8 },
        { open: 9.8, close: 9.5 },
        { open: 9.5, close: 9.3 },
        { open: 9.3, close: 9.1 },
        { open: 9.1, close: 9.0 },
      ]],
      ['BTC/USD', [
        { open: 64850, close: 64900 },
        { open: 64900, close: 65000 },
      ]],
    ]));

    const result = await marketScanner.runMarketScan({
      statePath,
      now: '2026-04-05T01:00:00.000Z',
    });

    expect(result.flaggedMovers[0]).toEqual(expect.objectContaining({
      coin: 'AVAX',
      direction: 'DOWN',
      triggerWindow: '4h_and_24h',
    }));
    expect(result.flaggedMovers[0].change4hPct).toBeCloseTo(-0.1, 4);
    expect(result.flaggedMovers[0].change24hPct).toBeCloseTo(-0.1, 4);

    const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    expect(saved.assetCount).toBe(2);
    expect(saved.topMovers[0]).toEqual(expect.objectContaining({
      coin: 'AVAX',
      flagged: true,
    }));
  });

  test('uses persisted history for 24h open-interest change and suppresses duplicate alerts', async () => {
    hyperliquidClient.getUniverseMarketData
      .mockResolvedValueOnce([
        {
          coin: 'AVAX',
          ticker: 'AVAX/USD',
          price: 10,
          prevDayPx: 10,
          fundingRate: 0.00002,
          openInterest: 1000,
          volumeUsd24h: 100000000,
        },
      ])
      .mockResolvedValueOnce([
        {
          coin: 'AVAX',
          ticker: 'AVAX/USD',
          price: 9,
          prevDayPx: 10,
          fundingRate: 0.00002,
          openInterest: 1200,
          volumeUsd24h: 140000000,
        },
      ])
      .mockResolvedValueOnce([
        {
          coin: 'AVAX',
          ticker: 'AVAX/USD',
          price: 9,
          prevDayPx: 10,
          fundingRate: 0.00002,
          openInterest: 1200,
          volumeUsd24h: 140000000,
        },
      ]);
    hyperliquidClient.getHistoricalBars
      .mockResolvedValueOnce(new Map([
        ['AVAX/USD', [
          { open: 10, close: 10 },
          { open: 10, close: 10 },
          { open: 10, close: 10 },
          { open: 10, close: 10 },
          { open: 10, close: 10 },
        ]],
      ]))
      .mockResolvedValue(new Map([
        ['AVAX/USD', [
          { open: 10, close: 9.8 },
          { open: 9.8, close: 9.5 },
          { open: 9.5, close: 9.3 },
          { open: 9.3, close: 9.1 },
          { open: 9.1, close: 9.0 },
        ]],
      ]));

    await marketScanner.runMarketScan({
      statePath,
      now: '2026-04-04T01:00:00.000Z',
    });
    const second = await marketScanner.runMarketScan({
      statePath,
      now: '2026-04-05T01:00:00.000Z',
    });
    const third = await marketScanner.runMarketScan({
      statePath,
      now: '2026-04-05T01:30:00.000Z',
    });

    expect(second.flaggedMovers[0].openInterestChange24hPct).toBeCloseTo(0.2, 4);
    expect(second.alerts).toHaveLength(1);
    expect(third.alerts).toHaveLength(0);
  });

  test('keeps the last good state when a partial universe suddenly drops far below the prior scan', async () => {
    const fullUniverse = Array.from({ length: 229 }, (_, index) => ({
      coin: `C${index + 1}`,
      ticker: `C${index + 1}/USD`,
      price: 1 + (index * 0.01),
      prevDayPx: 1 + (index * 0.01),
      fundingRate: 0.00001,
      openInterest: 1000 + index,
      volumeUsd24h: 100000 + index,
    }));
    const partialUniverse = Array.from({ length: 132 }, (_, index) => ({
      coin: `C${index + 1}`,
      ticker: `C${index + 1}/USD`,
      price: 1 + (index * 0.01),
      prevDayPx: 1 + (index * 0.01),
      fundingRate: 0.00001,
      openInterest: 1000 + index,
      volumeUsd24h: 100000 + index,
    }));

    hyperliquidClient.getUniverseMarketData
      .mockResolvedValueOnce(fullUniverse)
      .mockResolvedValueOnce(partialUniverse);
    hyperliquidClient.getHistoricalBars.mockResolvedValue(new Map());

    const first = await marketScanner.runMarketScan({
      statePath,
      now: '2026-04-05T01:00:00.000Z',
    });
    const second = await marketScanner.runMarketScan({
      statePath,
      now: '2026-04-05T01:30:00.000Z',
    });

    expect(first.ok).toBe(true);
    expect(first.assetCount).toBe(229);
    expect(second).toEqual(expect.objectContaining({
      ok: false,
      degraded: true,
      reason: 'universe_regressed',
      assetCount: 229,
    }));

    const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    expect(saved.assetCount).toBe(229);
  });
});
