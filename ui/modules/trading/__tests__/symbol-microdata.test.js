'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

let mockInfoClient;

jest.mock('../hyperliquid-client', () => ({
  createInfoClient: jest.fn(async () => mockInfoClient),
  getL2Book: jest.fn(),
  getMetaAndAssetCtxs: jest.fn(),
  postInfoRequest: jest.fn(),
  resolveCanonicalCoinSymbol: jest.fn(async (symbol) => String(symbol || '').replace(/\/USD$/i, '').toUpperCase()),
}));

const hyperliquidClient = require('../hyperliquid-client');
const cryptoMechBoard = require('../crypto-mech-board');
const symbolMicrodata = require('../symbol-microdata');

function makeCandles(count = 44, startMs = Date.parse('2026-04-20T00:00:00.000Z')) {
  return Array.from({ length: count }, (_, index) => {
    const open = 100 + index;
    const close = index === count - 1 ? 180 : open + 1;
    return {
      t: startMs + (index * 4 * 60 * 60 * 1000),
      T: startMs + ((index + 1) * 4 * 60 * 60 * 1000),
      o: String(open),
      h: String(close + 2),
      l: String(open - 1),
      c: String(close),
      v: String(1000 + index),
      n: index + 1,
    };
  });
}

describe('symbol-microdata', () => {
  let tempDir;
  let statePath;
  const nowMs = Date.parse('2026-04-27T00:00:00.000Z');

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-symbol-microdata-'));
    statePath = path.join(tempDir, 'crypto-mech-board-state.json');
    symbolMicrodata.clearMicrodataCache();
    mockInfoClient = {
      candleSnapshot: jest.fn(async () => makeCandles()),
      fundingHistory: jest.fn(async () => ([
        { time: nowMs - (16 * 60 * 60 * 1000), fundingRate: '0.0001', premium: '0.0002' },
        { time: nowMs - (8 * 60 * 60 * 1000), fundingRate: '0.00016', premium: '0.0003' },
        { time: nowMs, fundingRate: '0.00012', premium: '0.00025' },
      ])),
    };
    hyperliquidClient.getMetaAndAssetCtxs.mockResolvedValue([
      { universe: [{ name: 'BTC' }] },
      [{ markPx: '180', midPx: '180', openInterest: '1200', funding: '0.00012' }],
    ]);
    hyperliquidClient.getL2Book.mockResolvedValue({
      coin: 'BTC',
      asOf: new Date(nowMs).toISOString(),
      bestBid: 179.9,
      bestAsk: 180.1,
      mid: 180,
      spread: 0.2,
      spreadPct: 0.001111,
      bids: [
        { px: 179.9, sz: 10, usd: 1799 },
        { px: 179.8, sz: 10, usd: 1798 },
      ],
      asks: [
        { px: 180.1, sz: 8, usd: 1440.8 },
        { px: 180.2, sz: 10, usd: 1802 },
      ],
    });
    cryptoMechBoard.writeBoardState(statePath, {
      updatedAt: new Date(nowMs).toISOString(),
      history: {
        BTC: [
          {
            recordedAt: new Date(nowMs - (48 * 60 * 60 * 1000)).toISOString(),
            fundingRate: 0.00008,
            markPx: 150,
            openInterest: 900,
          },
          {
            recordedAt: new Date(nowMs - (24 * 60 * 60 * 1000)).toISOString(),
            fundingRate: 0.0001,
            markPx: 160,
            openInterest: 1000,
          },
        ],
      },
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  test('returns normalized 4h candles with a 60s cache', async () => {
    const first = await symbolMicrodata.get4hCandles('BTC/USD', 72, { nowMs });
    const second = await symbolMicrodata.get4hCandles('BTC/USD', 72, { nowMs });

    expect(first).toEqual(expect.objectContaining({
      ok: true,
      source: 'hyperliquid_info.candleSnapshot',
      ticker: 'BTC/USD',
      coin: 'BTC',
      interval: '4h',
      candleCount: expect.any(Number),
    }));
    expect(first.candles[0]).toEqual(expect.objectContaining({
      symbol: 'BTC/USD',
      open: expect.any(Number),
      close: expect.any(Number),
      changePct: expect.any(Number),
    }));
    expect(second.candles).toEqual(first.candles);
    expect(mockInfoClient.candleSnapshot).toHaveBeenCalledTimes(1);
  });

  test('returns open interest history from retained board state plus current Hyperliquid context', async () => {
    const result = await symbolMicrodata.getOpenInterestHistory('BTC/USD', 72, {
      cryptoMechBoardStatePath: statePath,
      nowMs,
      endTimeMs: nowMs,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      source: 'crypto_mech_board_local_history_plus_hyperliquid_current',
      ticker: 'BTC/USD',
      sampleCount: 3,
    }));
    expect(result.latest).toEqual(expect.objectContaining({
      openInterest: 1200,
      markPx: 180,
      openInterestUsd: 216000,
      changePctFromFirst: expect.any(Number),
    }));
  });

  test('returns funding history with deltas', async () => {
    const result = await symbolMicrodata.getFundingHistory('BTC/USD', 24, { nowMs, endTimeMs: nowMs });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      source: 'hyperliquid_info.fundingHistory',
      ticker: 'BTC/USD',
      sampleCount: 3,
      averageFundingRate: expect.any(Number),
    }));
    expect(result.latest).toEqual(expect.objectContaining({
      fundingRate: 0.00012,
      fundingRateBps: 1.2,
      deltaFromFirst: 0.00002,
      deltaFromPrevious: -0.00004,
    }));
  });

  test('returns book depth and 1000 dollar impact spread', async () => {
    const result = await symbolMicrodata.getBookSnapshot('BTC/USD', { nowMs });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      source: 'hyperliquid_info.l2Book',
      ticker: 'BTC/USD',
      notionalUsd: 1000,
      spreadBps: expect.any(Number),
      buyImpact: expect.objectContaining({ fillable: true, impactBps: expect.any(Number) }),
      sellImpact: expect.objectContaining({ fillable: true, impactBps: expect.any(Number) }),
    }));
  });

  test('returns extension read and bundled per-symbol micro data', async () => {
    const extension = await symbolMicrodata.getExtensionRead('BTC/USD', { nowMs });
    const bundled = await symbolMicrodata.getMicroDataForSymbols(['BTC/USD'], {
      cryptoMechBoardStatePath: statePath,
      nowMs,
      endTimeMs: nowMs,
    });

    expect(extension).toEqual(expect.objectContaining({
      ok: true,
      source: 'hyperliquid_info.candleSnapshot.extension',
      ticker: 'BTC/USD',
      extended: true,
      score: expect.any(Number),
      zScore: expect.any(Number),
    }));
    expect(bundled.symbols['BTC/USD']).toEqual(expect.objectContaining({
      ok: true,
      candles4h: expect.objectContaining({ ok: true }),
      openInterestHistory: expect.objectContaining({ ok: true }),
      fundingHistory: expect.objectContaining({ ok: true }),
      bookSnapshot: expect.objectContaining({ ok: true }),
      extensionRead: expect.objectContaining({ ok: true }),
    }));
  });
});
