'use strict';

jest.mock('../modules/trading/journal', () => ({
  getDb: jest.fn(() => ({})),
  recordExecutionReport: jest.fn(() => ({ lastInsertRowid: 1 })),
}));

jest.mock('../scripts/hm-defi-execute', () => ({
  resolveHyperliquidRuntime: jest.fn(),
  findAssetMeta: jest.fn(),
  extractOpenHyperliquidPosition: jest.fn(),
  extractHyperliquidOrderId: jest.fn((result) => result?.statuses?.[0]?.resting?.oid ?? null),
  resolveAssetSzDecimals: jest.fn(() => 4),
  placeHyperliquidStopLoss: jest.fn(),
}));

const journal = require('../modules/trading/journal');
const hmDefiExecute = require('../scripts/hm-defi-execute');
const manager = require('../scripts/hm-hyperliquid-bracket-manager');

describe('hm-hyperliquid-bracket-manager', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('moves stop to breakeven after TP1 fill', async () => {
    const info = {
      meta: jest.fn().mockResolvedValue({ universe: [{ name: 'ETH', szDecimals: 4 }] }),
      clearinghouseState: jest.fn().mockResolvedValue({}),
      openOrders: jest.fn().mockResolvedValue([
        { oid: 11, coin: 'ETH', reduceOnly: true, triggerPx: '2341.3', sz: '2.1169' },
      ]),
    };
    const exchange = {
      cancel: jest.fn().mockResolvedValue({ status: 'ok' }),
    };

    hmDefiExecute.resolveHyperliquidRuntime.mockResolvedValue({
      walletAddress: '0xwallet',
      info,
      exchange,
    });
    hmDefiExecute.findAssetMeta.mockReturnValue({ assetIndex: 2, asset: { name: 'ETH', szDecimals: 4 } });
    hmDefiExecute.extractOpenHyperliquidPosition.mockReturnValue({
      coin: 'ETH',
      signedSize: 1.0585,
      absSize: 1.0585,
      isLong: true,
      side: 'LONG',
      entryPx: 2352.48,
    });
    hmDefiExecute.placeHyperliquidStopLoss.mockResolvedValue({
      statuses: [{ resting: { oid: 77 } }],
    });

    const result = await manager.manageHyperliquidBracket({
      asset: 'ETH',
      direction: 'LONG',
      entryPrice: 2352.48,
      stopPrice: 2341.3,
      takeProfitPrice1: 2381,
      takeProfitPrice2: 2410,
      firstTakeProfitOrderId: 12,
      size: 2.1169,
      dryRun: false,
    });

    expect(exchange.cancel).toHaveBeenCalledWith({
      cancels: [{ a: 2, o: 11 }],
    });
    expect(hmDefiExecute.placeHyperliquidStopLoss).toHaveBeenCalledWith(expect.objectContaining({
      assetIndex: 2,
      isLong: true,
      size: 1.0585,
      stopPrice: 2352.5,
    }));
    expect(journal.recordExecutionReport).toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      action: 'move_stop_to_breakeven',
      replacementStopPrice: 2352.5,
      replacementStopOrderId: 77,
      canceledStopOrderIds: [11],
    }));
  });

  test('re-places the original stop if breakeven stop placement fails', async () => {
    const info = {
      meta: jest.fn().mockResolvedValue({ universe: [{ name: 'ETH', szDecimals: 4 }] }),
      clearinghouseState: jest.fn().mockResolvedValue({}),
      openOrders: jest.fn().mockResolvedValue([
        { oid: 31, coin: 'ETH', reduceOnly: true, triggerPx: '2341.3', sz: '2.1169' },
      ]),
    };
    const exchange = {
      cancel: jest.fn().mockResolvedValue({ status: 'ok' }),
    };

    hmDefiExecute.resolveHyperliquidRuntime.mockResolvedValue({
      walletAddress: '0xwallet',
      info,
      exchange,
    });
    hmDefiExecute.findAssetMeta.mockReturnValue({ assetIndex: 2, asset: { name: 'ETH', szDecimals: 4 } });
    hmDefiExecute.extractOpenHyperliquidPosition.mockReturnValue({
      coin: 'ETH',
      signedSize: 1.0585,
      absSize: 1.0585,
      isLong: true,
      side: 'LONG',
      entryPx: 2352.48,
    });
    hmDefiExecute.placeHyperliquidStopLoss
      .mockRejectedValueOnce(new Error('replacement stop rejected'))
      .mockResolvedValueOnce({ status: 'restored' });

    const result = await manager.manageHyperliquidBracket({
      asset: 'ETH',
      direction: 'LONG',
      entryPrice: 2352.48,
      stopPrice: 2341.3,
      takeProfitPrice1: 2381,
      takeProfitPrice2: 2410,
      firstTakeProfitOrderId: 32,
      size: 2.1169,
      dryRun: false,
    });

    expect(exchange.cancel).toHaveBeenCalledWith({
      cancels: [{ a: 2, o: 31 }],
    });
    expect(hmDefiExecute.placeHyperliquidStopLoss).toHaveBeenNthCalledWith(1, expect.objectContaining({
      assetIndex: 2,
      stopPrice: 2352.5,
    }));
    expect(hmDefiExecute.placeHyperliquidStopLoss).toHaveBeenNthCalledWith(2, expect.objectContaining({
      assetIndex: 2,
      stopPrice: 2341.3,
    }));
    expect(journal.recordExecutionReport).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: 'restored_original_stop',
      restoredOriginalStop: true,
      restoredStopPrice: 2341.3,
      error: 'replacement stop rejected',
    }));
  });

  test('returns dry-run action without changing orders', async () => {
    const info = {
      meta: jest.fn().mockResolvedValue({ universe: [{ name: 'ETH', szDecimals: 4 }] }),
      clearinghouseState: jest.fn().mockResolvedValue({}),
      openOrders: jest.fn().mockResolvedValue([
        { oid: 21, coin: 'ETH', reduceOnly: true, triggerPx: '2341.3', sz: '2.1169' },
      ]),
    };

    hmDefiExecute.resolveHyperliquidRuntime.mockResolvedValue({
      walletAddress: '0xwallet',
      info,
      exchange: { cancel: jest.fn() },
    });
    hmDefiExecute.findAssetMeta.mockReturnValue({ assetIndex: 2, asset: { name: 'ETH', szDecimals: 4 } });
    hmDefiExecute.extractOpenHyperliquidPosition.mockReturnValue({
      coin: 'ETH',
      signedSize: 1.0585,
      absSize: 1.0585,
      isLong: true,
      side: 'LONG',
      entryPx: 2352.48,
    });

    const result = await manager.manageHyperliquidBracket({
      asset: 'ETH',
      direction: 'LONG',
      entryPrice: 2352.48,
      stopPrice: 2341.3,
      takeProfitPrice1: 2381,
      takeProfitPrice2: 2410,
      firstTakeProfitOrderId: 22,
      size: 2.1169,
      dryRun: true,
    });

    expect(hmDefiExecute.placeHyperliquidStopLoss).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      status: 'dry_run',
      action: 'move_stop_to_breakeven',
      replacementStopPrice: 2352.5,
    }));
  });

  test('records the final runner exit after a snap-back stop fill', async () => {
    const stopMoveRow = {
      id: 9,
      timestamp: '2026-04-16T19:00:00.000Z',
      report_type: 'hyperliquid_bracket_stop_move',
      report_json: JSON.stringify({
        timestamp: '2026-04-16T19:00:00.000Z',
        ticker: 'ETH/USD',
        entryPrice: 2352.48,
        replacementStopOrderId: 555,
        replacementStopPrice: 2352.5,
        execution: {
          entryPrice: 2352.48,
          replacementStopOrderId: 555,
          replacementStopPrice: 2352.5,
          bracketPlan: {
            entryPrice: 2352.48,
          },
        },
      }),
    };
    const fakeDb = {
      prepare: jest.fn().mockReturnValue({
        all: jest.fn().mockReturnValue([stopMoveRow]),
      }),
    };
    const info = {
      meta: jest.fn().mockResolvedValue({ universe: [{ name: 'ETH', szDecimals: 4 }] }),
      clearinghouseState: jest.fn().mockResolvedValue({}),
      openOrders: jest.fn().mockResolvedValue([]),
      userFillsByTime: jest.fn().mockResolvedValue([
        {
          coin: 'ETH',
          oid: 555,
          px: '2352.5',
          sz: '1.0585',
          closedPnl: '0.02',
          time: 1776366600000,
        },
      ]),
    };

    hmDefiExecute.resolveHyperliquidRuntime.mockResolvedValue({
      walletAddress: '0xwallet',
      info,
      exchange: { cancel: jest.fn() },
    });
    hmDefiExecute.findAssetMeta.mockReturnValue({ assetIndex: 2, asset: { name: 'ETH', szDecimals: 4 } });
    hmDefiExecute.extractOpenHyperliquidPosition.mockReturnValue(null);

    const result = await manager.manageHyperliquidBracket({
      asset: 'ETH',
      direction: 'LONG',
      entryPrice: 2352.48,
      stopPrice: 2341.3,
      takeProfitPrice1: 2381,
      takeProfitPrice2: 2410,
      firstTakeProfitOrderId: 12,
      size: 2.1169,
      dryRun: false,
    }, {
      journalDb: fakeDb,
    });

    expect(info.userFillsByTime).toHaveBeenCalledWith(expect.objectContaining({
      user: '0xwallet',
      startTime: expect.any(Number),
      aggregateByTime: false,
      reversed: true,
    }));
    expect(journal.recordExecutionReport).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({
        reportType: 'hyperliquid_bracket_final_exit',
        ticker: 'ETH/USD',
        direction: 'SELL',
        status: 'filled',
        exitPrice: 2352.5,
        realizedPnl: 0.02,
        execution: expect.objectContaining({
          exitOrderId: '555',
          closedSize: 1.0585,
        }),
      })
    );
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      action: 'record_final_exit',
      state: 'closed',
      finalExit: expect.objectContaining({
        reportType: 'hyperliquid_bracket_final_exit',
        exitOrderId: '555',
        exitPrice: 2352.5,
        realizedPnl: 0.02,
        closedSize: 1.0585,
      }),
    }));
  });

  test('aggregates multiple partial fills for the same runner stop order id', async () => {
    const stopMoveRow = {
      id: 10,
      timestamp: '2026-04-16T19:05:00.000Z',
      report_type: 'hyperliquid_bracket_stop_move',
      report_json: JSON.stringify({
        timestamp: '2026-04-16T19:05:00.000Z',
        ticker: 'ETH/USD',
        entryPrice: 2352.48,
        replacementStopOrderId: 777,
        replacementStopPrice: 2352.5,
      }),
    };
    const fakeDb = {
      prepare: jest.fn().mockReturnValue({
        all: jest.fn().mockReturnValue([stopMoveRow]),
      }),
    };
    const info = {
      meta: jest.fn().mockResolvedValue({ universe: [{ name: 'ETH', szDecimals: 4 }] }),
      clearinghouseState: jest.fn().mockResolvedValue({}),
      openOrders: jest.fn().mockResolvedValue([]),
      userFillsByTime: jest.fn().mockResolvedValue([
        {
          coin: 'ETH',
          oid: 777,
          px: '2352.4',
          sz: '0.5000',
          closedPnl: '0.03',
          time: 1776366900000,
        },
        {
          coin: 'ETH',
          oid: 777,
          px: '2352.6',
          sz: '0.5585',
          closedPnl: '0.05',
          time: 1776366901000,
        },
      ]),
    };

    hmDefiExecute.resolveHyperliquidRuntime.mockResolvedValue({
      walletAddress: '0xwallet',
      info,
      exchange: { cancel: jest.fn() },
    });
    hmDefiExecute.findAssetMeta.mockReturnValue({ assetIndex: 2, asset: { name: 'ETH', szDecimals: 4 } });
    hmDefiExecute.extractOpenHyperliquidPosition.mockReturnValue(null);

    const result = await manager.manageHyperliquidBracket({
      asset: 'ETH',
      direction: 'LONG',
      entryPrice: 2352.48,
      stopPrice: 2341.3,
      takeProfitPrice1: 2381,
      takeProfitPrice2: 2410,
      firstTakeProfitOrderId: 12,
      size: 2.1169,
      dryRun: false,
    }, {
      journalDb: fakeDb,
    });

    expect(journal.recordExecutionReport).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({
        reportType: 'hyperliquid_bracket_final_exit',
        exitPrice: expect.closeTo((0.5 * 2352.4 + 0.5585 * 2352.6) / 1.0585, 10),
        realizedPnl: 0.08,
        execution: expect.objectContaining({
          closedSize: 1.0585,
          fills: expect.arrayContaining([
            expect.objectContaining({ oid: 777, sz: '0.5000' }),
            expect.objectContaining({ oid: 777, sz: '0.5585' }),
          ]),
        }),
      })
    );
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      action: 'record_final_exit',
      finalExit: expect.objectContaining({
        exitOrderId: '777',
        realizedPnl: 0.08,
        closedSize: 1.0585,
        fillTimestamp: 1776366901000,
      }),
    }));
  });
});
