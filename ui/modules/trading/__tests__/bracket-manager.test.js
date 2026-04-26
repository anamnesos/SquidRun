'use strict';

const bracketManager = require('../bracket-manager');

describe('Hyperliquid bracket manager', () => {
  test('builds a split bracket plan with TP1 and runner sizes', () => {
    const plan = bracketManager.buildBracketPlan({
      asset: 'ETH',
      direction: 'LONG',
      entryPrice: 2352.48,
      stopPrice: 2341.3,
      takeProfitPrice1: 2381,
      takeProfitPrice2: 2410,
      size: 2.1169,
      szDecimals: 4,
    });

    expect(plan).toEqual(expect.objectContaining({
      asset: 'ETH',
      direction: 'LONG',
      initialSize: 2.1169,
      firstTakeProfitSize: 1.0584,
      runnerSize: 1.0585,
      firstTakeProfitPrice: 2381,
      runnerTakeProfitPrice: 2410,
      breakEvenStopPrice: 2352.5,
    }));
  });

  test('detects TP1 fill and requests a stop move to breakeven', () => {
    const state = bracketManager.deriveBracketState({
      asset: 'ETH',
      direction: 'LONG',
      entryPrice: 2352.48,
      stopPrice: 2341.3,
      takeProfitPrice1: 2381,
      takeProfitPrice2: 2410,
      firstTakeProfitOrderId: 102,
      size: 2.1169,
      szDecimals: 4,
      position: {
        coin: 'ETH',
        size: 1.0585,
        side: 'long',
        entryPx: 2352.48,
      },
      openOrders: [
        { oid: 101, coin: 'ETH', reduceOnly: true, triggerPx: '2341.3', sz: '2.1169' },
      ],
    });

    expect(state).toEqual(expect.objectContaining({
      state: 'tp1_filled_pending_stop_move',
      tp1OrderId: 102,
      tp1OrderStillOpen: false,
      firstTakeProfitFilled: true,
      needsBreakEvenStopMove: true,
      replacementStopPrice: 2352.5,
      cancelOrderIds: [101],
    }));
  });

  test('does not misclassify manual reductions as TP1 fills without the TP1 order id disappearing', () => {
    const state = bracketManager.deriveBracketState({
      asset: 'ETH',
      direction: 'LONG',
      entryPrice: 2352.48,
      stopPrice: 2341.3,
      takeProfitPrice1: 2381,
      takeProfitPrice2: 2410,
      size: 2.1169,
      szDecimals: 4,
      position: {
        coin: 'ETH',
        size: 1.0585,
        side: 'long',
        entryPx: 2352.48,
      },
      openOrders: [
        { oid: 301, coin: 'ETH', reduceOnly: true, triggerPx: '2341.3', sz: '2.1169' },
      ],
    });

    expect(state).toEqual(expect.objectContaining({
      state: 'entry_protected',
      tp1OrderId: null,
      runnerSizeReached: true,
      firstTakeProfitFilled: false,
      needsBreakEvenStopMove: false,
    }));
  });

  test('recognizes protected runner after stop moves to breakeven', () => {
    const state = bracketManager.deriveBracketState({
      asset: 'ETH',
      direction: 'LONG',
      entryPrice: 2352.48,
      stopPrice: 2341.3,
      takeProfitPrice1: 2381,
      takeProfitPrice2: 2410,
      firstTakeProfitOrderId: 202,
      size: 2.1169,
      szDecimals: 4,
      position: {
        coin: 'ETH',
        size: 1.0585,
        side: 'long',
        entryPx: 2352.48,
      },
      openOrders: [
        { oid: 201, coin: 'ETH', reduceOnly: true, triggerPx: '2352.5', sz: '1.0585' },
      ],
    });

    expect(state).toEqual(expect.objectContaining({
      state: 'runner_protected',
      firstTakeProfitFilled: true,
      needsBreakEvenStopMove: false,
      stopAtBreakEven: true,
    }));
  });

  test('handles snap-back final exit as closed state', () => {
    const state = bracketManager.deriveBracketState({
      asset: 'ETH',
      direction: 'LONG',
      entryPrice: 2352.48,
      stopPrice: 2341.3,
      takeProfitPrice1: 2381,
      takeProfitPrice2: 2410,
      size: 2.1169,
      szDecimals: 4,
      position: {
        coin: 'ETH',
        size: 0,
        side: 'long',
        entryPx: 2352.48,
      },
      openOrders: [],
    });

    expect(state).toEqual(expect.objectContaining({
      state: 'closed',
      flat: true,
      needsBreakEvenStopMove: false,
    }));
  });

  test('derives active exchange-native stop and take-profit for a short from reduce-only orders', () => {
    const protection = bracketManager.deriveExchangeProtection({
      coin: 'APT',
      size: -2695.25,
      side: 'short',
      entryPx: 0.9273,
    }, [
      { oid: 1, coin: 'APT', reduceOnly: true, triggerPx: '0.9661', sz: '2695.25' },
      { oid: 2, coin: 'APT', reduceOnly: true, triggerPx: '0.9376', sz: '2695.25' },
      { oid: 3, coin: 'APT', reduceOnly: true, triggerPx: '0.8784', sz: '1347.62' },
    ]);

    expect(protection).toEqual(expect.objectContaining({
      verified: true,
      activeStopPrice: 0.9376,
      activeTakeProfitPrice: 0.8784,
      activeStopOrder: expect.objectContaining({ oid: 2 }),
      activeTakeProfitOrder: expect.objectContaining({ oid: 3 }),
    }));
  });
});
