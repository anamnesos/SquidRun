'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const dynamicWatchlist = require('../dynamic-watchlist');
const watchlist = require('../watchlist');

describe('dynamic-watchlist', () => {
  let tempDir;
  let statePath;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-dynamic-watchlist-'));
    statePath = path.join(tempDir, 'dynamic-watchlist-state.json');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('combines static and dynamic tickers with source and asset-class filters', () => {
    dynamicWatchlist.addTicker('BONK', {
      statePath,
      source: 'launch_radar',
      assetClass: 'crypto',
      exchange: 'SOLANA',
      broker: 'alpaca',
      sector: 'Memecoin',
      reason: 'Viral velocity spike',
      expiry: '2099-12-31T00:00:00.000Z',
      now: '2026-03-18T00:00:00.000Z',
    });

    expect(dynamicWatchlist.getActiveTickers({ statePath, assetClass: 'crypto' })).toEqual(expect.arrayContaining([
      'BTC/USD',
      'ETH/USD',
      'SOL/USD',
      'BONK',
    ]));
    expect(dynamicWatchlist.getActiveEntries({ statePath, source: 'launch_radar' })).toEqual([
      expect.objectContaining({
        ticker: 'BONK',
        source: 'launch_radar',
        assetClass: 'crypto',
        reason: 'Viral velocity spike',
      }),
    ]);
  });

  test('prunes expired entries and persists static removals until reset', () => {
    dynamicWatchlist.addTicker('PUMP', {
      statePath,
      source: 'smart_money',
      assetClass: 'crypto',
      exchange: 'SOLANA',
      broker: 'alpaca',
      expiry: '2026-03-18T01:00:00.000Z',
      now: '2026-03-18T00:00:00.000Z',
    });

    expect(dynamicWatchlist.isWatched('PUMP', { statePath, now: '2026-03-18T00:30:00.000Z' })).toBe(true);
    expect(dynamicWatchlist.isWatched('PUMP', { statePath, now: '2026-03-18T02:00:00.000Z' })).toBe(false);
    expect(dynamicWatchlist.readDynamicState(statePath).dynamicEntries).toHaveLength(0);

    expect(dynamicWatchlist.removeTicker('AAPL', { statePath })).toBe(true);
    expect(dynamicWatchlist.isWatched('AAPL', { statePath })).toBe(false);

    dynamicWatchlist.resetWatchlist({ statePath });
    expect(dynamicWatchlist.isWatched('AAPL', { statePath })).toBe(true);
  });

  test('promotes market-scanner movers with crypto metadata and a 4-hour ttl', () => {
    const result = dynamicWatchlist.promoteMarketScannerMovers([
      { ticker: 'FOGO/USD', reason: '4h momentum breakout' },
      { symbol: 'HEMI', reason: 'large 24h move' },
    ], {
      statePath,
      now: '2026-04-05T00:00:00.000Z',
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      promotedTickers: ['FOGO/USD', 'HEMI/USD'],
    }));
    expect(dynamicWatchlist.getActiveTickers({
      statePath,
      source: 'market_scanner',
      assetClass: 'crypto',
      now: '2026-04-05T01:00:00.000Z',
    })).toEqual(expect.arrayContaining(['FOGO/USD', 'HEMI/USD']));
    expect(dynamicWatchlist.getActiveEntries({
      statePath,
      source: 'market_scanner',
      now: '2026-04-05T01:00:00.000Z',
    })).toEqual([
      expect.objectContaining({
        ticker: 'FOGO/USD',
        source: 'market_scanner',
        assetClass: 'crypto',
        exchange: 'CRYPTO',
        broker: 'hyperliquid',
        expiry: '2026-04-05T04:00:00.000Z',
        reason: '4h momentum breakout',
      }),
      expect.objectContaining({
        ticker: 'HEMI/USD',
        source: 'market_scanner',
        assetClass: 'crypto',
        exchange: 'CRYPTO',
        broker: 'hyperliquid',
        expiry: '2026-04-05T04:00:00.000Z',
        reason: 'large 24h move',
      }),
    ]);

    expect(dynamicWatchlist.isWatched('FOGO/USD', {
      statePath,
      now: '2026-04-05T04:01:00.000Z',
    })).toBe(false);
    expect(dynamicWatchlist.readDynamicState(statePath).dynamicEntries).toHaveLength(0);
  });

  test('refreshes an existing market-scanner promotion instead of duplicating it', () => {
    dynamicWatchlist.promoteMarketScannerMovers([{ ticker: 'AVAX/USD', reason: 'first scan' }], {
      statePath,
      now: '2026-04-05T00:00:00.000Z',
    });
    dynamicWatchlist.promoteMarketScannerMovers([{ ticker: 'AVAX/USD', reason: 'refreshed scan' }], {
      statePath,
      now: '2026-04-05T01:00:00.000Z',
    });

    const entries = dynamicWatchlist.getActiveEntries({
      statePath,
      source: 'market_scanner',
      now: '2026-04-05T01:30:00.000Z',
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(expect.objectContaining({
      ticker: 'AVAX/USD',
      source: 'market_scanner',
      reason: 'refreshed scan',
      expiry: '2026-04-05T05:00:00.000Z',
    }));
  });

  test('watchlist compatibility layer keeps the default equity view', () => {
    expect(watchlist.getTickers({ statePath })).toEqual(dynamicWatchlist.DEFAULT_WATCHLIST.map((entry) => entry.ticker));
    expect(watchlist.getTickers({ statePath, assetClass: 'crypto' })).toEqual(
      dynamicWatchlist.DEFAULT_CRYPTO_WATCHLIST.map((entry) => entry.ticker)
    );
    expect(watchlist.getAssetClassForTicker('BTC/USD', 'crypto')).toBe('crypto');
    expect(watchlist.getAssetClassForTicker('AAPL')).toBe('us_equity');
  });
});
