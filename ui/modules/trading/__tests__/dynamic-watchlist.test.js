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
      expiry: '2026-03-20T00:00:00.000Z',
      now: '2026-03-18T00:00:00.000Z',
    });

    expect(dynamicWatchlist.getActiveTickers({ statePath, assetClass: 'crypto' })).toEqual(expect.arrayContaining([
      'BTC/USD',
      'ETH/USD',
      'SOL/USD',
      'AVAX/USD',
      'LINK/USD',
      'DOGE/USD',
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

  test('watchlist compatibility layer keeps the default equity view', () => {
    expect(watchlist.getTickers()).toEqual(dynamicWatchlist.DEFAULT_WATCHLIST.map((entry) => entry.ticker));
    expect(watchlist.getTickers({ assetClass: 'crypto' })).toEqual(
      dynamicWatchlist.DEFAULT_CRYPTO_WATCHLIST.map((entry) => entry.ticker)
    );
    expect(watchlist.getAssetClassForTicker('BTC/USD')).toBe('crypto');
    expect(watchlist.getAssetClassForTicker('AAPL')).toBe('us_equity');
  });
});
