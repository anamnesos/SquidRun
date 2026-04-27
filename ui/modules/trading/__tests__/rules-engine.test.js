'use strict';

const { evaluateLongShortSetup } = require('../rules-engine');

const NOW = Date.parse('2026-04-27T18:00:00.000Z');

function candle(index, overrides = {}) {
  const close = overrides.close ?? 100 + index;
  return {
    timestamp: new Date(NOW - ((17 - index) * 4 * 60 * 60 * 1000)).toISOString(),
    open: overrides.open ?? close - 1,
    high: overrides.high ?? close + 2,
    low: overrides.low ?? close - 2,
    close,
    volume: 1000,
  };
}

function baseMicrodata(overrides = {}) {
  const candles = Array.from({ length: 18 }, (_, index) => candle(index, { close: 100 + index }));
  return {
    candles4h: { ok: true, candles },
    fundingHistory: { ok: true, latest: { fundingRateBps: 0 } },
    bookSnapshot: {
      ok: true,
      mid: candles[candles.length - 1].close,
      spreadBps: 8,
      buyImpact: { fillable: true, impactBps: 12 },
      sellImpact: { fillable: true, impactBps: 12 },
    },
    extensionRead: { ok: true, pctAboveMa20: 0.02, currentPrice: candles[candles.length - 1].close },
    account: { accountValue: 1000, totalMarginUsed: 0, withdrawable: 700 },
    supervisor: { running: true },
    rateLimit: { active: false },
    positions: [],
    eventVeto: { decision: 'CLEAR', affectedAssets: [] },
    recentSymbolActivity: [],
    catalysts: [],
    nowMs: NOW,
    ...overrides,
  };
}

describe('rules-engine', () => {
  test('fires the ORDI-shaped short setup on extension, positive funding, clean book, and no position', () => {
    const candles = Array.from({ length: 18 }, (_, index) => candle(index, { close: 100 + (index * 2) }));
    candles[candles.length - 1].close = 125;
    candles[candles.length - 1].high = 128;
    const signal = evaluateLongShortSetup('ORDI/USD', baseMicrodata({
      candles4h: { ok: true, candles },
      fundingHistory: { ok: true, latest: { fundingRateBps: 1.4 } },
      extensionRead: { ok: true, pctAboveMa20: 0.11, currentPrice: 125 },
    }), { nowMs: NOW });

    expect(signal).toEqual(expect.objectContaining({
      fire: true,
      side: 'short',
      sizeUsd: 245,
    }));
    expect(signal.stopPx).toBeGreaterThan(128);
    expect(signal.tp2Px).toBeLessThan(signal.tpPx);
    expect(signal.reason).toContain('SHORT ORDI-pattern');
  });

  test('does not fire the short setup without extension', () => {
    const signal = evaluateLongShortSetup('ORDI/USD', baseMicrodata({
      fundingHistory: { ok: true, latest: { fundingRateBps: 1.6 } },
      extensionRead: { ok: true, pctAboveMa20: 0.03, currentPrice: 117 },
    }), { nowMs: NOW });

    expect(signal).toEqual(expect.objectContaining({
      fire: false,
      side: null,
    }));
    expect(signal.reason).toContain('no setup');
  });

  test('fires the lower-priority long setup on post-dip recovery, negative funding, and fresh catalyst', () => {
    const closes = [100, 98, 96, 94, 93, 99, 106];
    const candles = closes.map((close, index) => candle(index + 11, {
      open: close - 2,
      high: close + 1,
      low: index === 4 ? 90 : close - 3,
      close,
    }));
    candles[6].high = 107;
    const signal = evaluateLongShortSetup('PRL/USD', baseMicrodata({
      candles4h: { ok: true, candles },
      fundingHistory: { ok: true, latest: { fundingRateBps: -2.5 } },
      extensionRead: { ok: true, pctAboveMa20: 0.01, currentPrice: 106 },
      catalysts: [{ assets: ['PRL/USD'], ts: new Date(NOW - (2 * 60 * 60 * 1000)).toISOString() }],
    }), { nowMs: NOW });

    expect(signal).toEqual(expect.objectContaining({
      fire: true,
      side: 'long',
      sizeUsd: 245,
    }));
    expect(signal.stopPx).toBeLessThan(90);
    expect(signal.tpPx).toBeGreaterThan(signal.entryPx);
  });

  test('blocks every setup when account margin used is above eighty percent', () => {
    const signal = evaluateLongShortSetup('ORDI/USD', baseMicrodata({
      account: { accountValue: 1000, totalMarginUsed: 850, withdrawable: 150 },
      fundingHistory: { ok: true, latest: { fundingRateBps: 1.4 } },
      extensionRead: { ok: true, pctAboveMa20: 0.12, currentPrice: 125 },
    }), { nowMs: NOW });

    expect(signal).toEqual(expect.objectContaining({
      fire: false,
      side: null,
    }));
    expect(signal.reason).toContain('account margin already used');
  });
});
