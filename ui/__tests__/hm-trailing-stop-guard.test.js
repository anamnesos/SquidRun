'use strict';

jest.mock('../modules/trading/hyperliquid-client', () => ({
  getMetaAndAssetCtxs: jest.fn(),
  getOpenOrders: jest.fn(),
}));

jest.mock('../modules/trading/manual-stop-overrides', () => ({
  maybeBlockTrailingStopTighten: jest.fn(),
}));

jest.mock('../scripts/hm-defi-execute', () => ({
  parseCliArgs: jest.fn(() => ({ options: new Map() })),
  normalizeAssetName: jest.fn((value) => String(value || '').trim().toUpperCase()),
  resolveHyperliquidRuntime: jest.fn(),
  toNonNegativeInteger: jest.fn((value, fallback = 0) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : fallback;
  }),
  withTimeout: jest.fn((promise) => promise),
  findAssetMeta: jest.fn(),
  extractOpenHyperliquidPosition: jest.fn(),
  resolveAssetSzDecimals: jest.fn(() => 4),
  roundPrice: jest.fn((value) => Number(Number(value).toFixed(4))),
  placeHyperliquidStopLoss: jest.fn(),
  extractHyperliquidOrderId: jest.fn(() => null),
}));

jest.mock('../scripts/hm-hyperliquid-bracket-manager', () => ({
  cancelHyperliquidOrders: jest.fn(),
}));

const hyperliquidClient = require('../modules/trading/hyperliquid-client');
const manualStopOverrides = require('../modules/trading/manual-stop-overrides');
const hmDefiExecute = require('../scripts/hm-defi-execute');
const hyperliquidBracketManager = require('../scripts/hm-hyperliquid-bracket-manager');
const hmTrailingStop = require('../scripts/hm-trailing-stop');

describe('hm-trailing-stop manual override guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('holds instead of replacing a manual widened stop while the guard is active', async () => {
    hmDefiExecute.resolveHyperliquidRuntime.mockResolvedValue({
      walletAddress: '0xwallet',
      info: {
        clearinghouseState: jest.fn().mockResolvedValue({}),
      },
      exchange: {},
    });
    hyperliquidClient.getMetaAndAssetCtxs.mockResolvedValue([
      { universe: [{ name: 'ORDI', szDecimals: 0 }] },
      [{ markPx: '4.309' }],
    ]);
    hmDefiExecute.findAssetMeta.mockReturnValue({
      assetIndex: 76,
      asset: { name: 'ORDI', szDecimals: 0 },
    });
    hmDefiExecute.extractOpenHyperliquidPosition.mockReturnValue({
      coin: 'ORDI',
      signedSize: -86.99,
      absSize: 86.99,
      isLong: false,
      side: 'SHORT',
      entryPx: 4.3084,
      positionValue: 374.78,
    });
    hyperliquidClient.getOpenOrders.mockResolvedValue([
      { coin: 'ORDI', oid: 393948579664, reduceOnly: true, triggerPx: '4.35', sz: '86.99' },
    ]);
    manualStopOverrides.maybeBlockTrailingStopTighten.mockReturnValue({
      blocked: true,
      reason: 'manual_stop_override_guard_active',
      override: {
        ticker: 'ORDI/USD',
        mode: 'wick_clearance',
        stopOrderId: '393948579664',
      },
    });

    const result = await hmTrailingStop.manageTrailingStop({
      asset: 'ORDI',
      trailPct: 0.6,
      dryRun: false,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      action: 'none',
      reason: 'manual_stop_override_guard_active',
      manualStopOverride: expect.objectContaining({
        ticker: 'ORDI/USD',
      }),
    }));
    expect(hyperliquidBracketManager.cancelHyperliquidOrders).not.toHaveBeenCalled();
    expect(hmDefiExecute.placeHyperliquidStopLoss).not.toHaveBeenCalled();
  });
});
