'use strict';

const fs = require('fs');
const hmDefiExecute = require('../../../scripts/hm-defi-execute');

describe('hm-defi-execute', () => {
  test('resolveWalletAddress prefers Hyperliquid env vars over the Polymarket funder address', () => {
    expect(hmDefiExecute.resolveWalletAddress({
      POLYMARKET_FUNDER_ADDRESS: '0xpoly',
      HYPERLIQUID_WALLET_ADDRESS: '0xhyper',
      HYPERLIQUID_ADDRESS: '0xlegacy',
    })).toBe('0xhyper');

    expect(hmDefiExecute.resolveWalletAddress({
      POLYMARKET_FUNDER_ADDRESS: '0xpoly',
      HYPERLIQUID_ADDRESS: '0xlegacy',
    })).toBe('0xlegacy');
  });

  test('parseTradeOptions reads an explicit stop-loss price', () => {
    const argv = hmDefiExecute.parseCliArgs([
      'trade',
      '--asset', 'ETH',
      '--direction', 'SHORT',
      '--leverage', '5',
      '--margin', '125',
      '--confidence', '0.82',
      '--stop-loss', '2168.8',
      '--take-profit', '1840',
      '--client-order-id', 'consultation-1:eth-short',
    ]);

    expect(hmDefiExecute.parseTradeOptions(argv)).toEqual(expect.objectContaining({
      asset: 'ETH',
      direction: 'SHORT',
      leverage: 5,
      margin: 125,
      signalConfidence: 0.82,
      stopLossPrice: 2168.8,
      takeProfitPrice: 1840,
      clientOrderId: expect.stringMatching(/^0x[a-f0-9]{32}$/),
    }));
  });

  test('parseTradeOptions reads exact notional override and retry delay', () => {
    const argv = hmDefiExecute.parseCliArgs([
      'trade',
      '--asset', 'AVAX',
      '--direction', 'SELL',
      '--notional', '300',
      '--retry-delay', '900',
    ]);

    expect(hmDefiExecute.parseTradeOptions(argv)).toEqual(expect.objectContaining({
      asset: 'AVAX',
      direction: 'SELL',
      notional: 300,
      retryDelayMs: 900,
    }));
  });

  test('normalizeDirection preserves SELL so close intent is not silently remapped', () => {
    expect(hmDefiExecute.normalizeDirection('SELL')).toBe('SELL');
    expect(hmDefiExecute.normalizeDirection('BUY')).toBe('LONG');
  });

  test('formatPrice follows Hyperliquid perp price rules from szDecimals rather than the old heuristic ladder', () => {
    expect(hmDefiExecute.resolvePerpPriceDecimals(68543.12, 5)).toBe(0);
    expect(hmDefiExecute.formatPrice(68543.12, 68543.12, 5)).toBe('68543');

    expect(hmDefiExecute.resolvePerpPriceDecimals(2168.8, 4)).toBe(2);
    expect(hmDefiExecute.formatPrice(2168.84, 2168.84, 4)).toBe('2168.8');

    expect(hmDefiExecute.resolvePerpPriceDecimals(0.126936, 0)).toBe(5);
    expect(hmDefiExecute.formatPrice(0.126936, 0.126936, 0)).toBe('0.12694');
  });

  test('constrainStopPriceWithinLiquidationBuffer clamps requested stops on the liquidation side', () => {
    const shortStop = hmDefiExecute.constrainStopPriceWithinLiquidationBuffer({
      stopPrice: 102,
      entryPrice: 90,
      liquidationPx: 100,
      isLong: false,
      referencePrice: 90,
    });
    expect(shortStop).toBeGreaterThan(90);
    expect(shortStop).toBeLessThan(100);

    const longStop = hmDefiExecute.constrainStopPriceWithinLiquidationBuffer({
      stopPrice: 78,
      entryPrice: 90,
      liquidationPx: 80,
      isLong: true,
      referencePrice: 90,
    });
    expect(longStop).toBeGreaterThan(80);
    expect(longStop).toBeLessThan(90);
  });

  test('constrainStopPriceWithinLiquidationBuffer rejects unsafe stops when no clamp is possible', () => {
    expect(() => hmDefiExecute.constrainStopPriceWithinLiquidationBuffer({
      stopPrice: 102,
      entryPrice: undefined,
      liquidationPx: 100,
      isLong: false,
      referencePrice: 90,
    })).toThrow(/short stop loss 102 is at or above liquidation 100/);

    expect(() => hmDefiExecute.constrainStopPriceWithinLiquidationBuffer({
      stopPrice: 78,
      entryPrice: undefined,
      liquidationPx: 80,
      isLong: true,
      referencePrice: 90,
    })).toThrow(/long stop loss 78 is at or below liquidation 80/);
  });

  test('resolveAssetMaxLeverage reads the venue cap from Hyperliquid meta', () => {
    expect(hmDefiExecute.resolveAssetMaxLeverage({
      asset: { name: 'RESOLV', maxLeverage: 3 },
      assetIndex: 12,
    }, 5)).toBe(3);

    expect(hmDefiExecute.resolveAssetMaxLeverage({
      maxLeverage: 20,
    }, 5)).toBe(20);

    expect(hmDefiExecute.resolveAssetMaxLeverage(null, 5)).toBe(5);
  });

  test('resolveAssetSzDecimals preserves integer-only assets instead of falling back to 4 decimals', () => {
    expect(hmDefiExecute.resolveAssetSzDecimals({
      asset: { name: 'ALGO', szDecimals: 0 },
      assetIndex: 5,
    }, 4)).toBe(0);

    expect(hmDefiExecute.resolveAssetSzDecimals({
      szDecimals: 3,
    }, 4)).toBe(3);

    expect(hmDefiExecute.resolveAssetSzDecimals(null, 4)).toBe(4);
  });

  test('normalizeClientOrderId hashes arbitrary ids into Hyperliquid cloid format', () => {
    expect(hmDefiExecute.normalizeClientOrderId('consultation-1:eth-short')).toMatch(/^0x[a-f0-9]{32}$/);
    expect(hmDefiExecute.normalizeClientOrderId('0x1234567890abcdef1234567890abcdef')).toBe('0x1234567890abcdef1234567890abcdef');
  });

  test('buildTradePlan honors an explicit stop-loss override', () => {
    const plan = hmDefiExecute.buildTradePlan({
      asset: 'ETH',
      direction: 'SHORT',
      leverage: 5,
      margin: 125,
      reserveUsdc: 5,
      availableBalance: 500,
      midPrice: 2008.1,
      szDecimals: 4,
      stopLossPrice: 2168.8,
      signalConfidence: 0.81,
      stopLossPct: 0.08,
      takeProfitPct1: 0.07,
      takeProfitPct2: 0.12,
    });

    expect(plan).toEqual(expect.objectContaining({
      asset: 'ETH',
      direction: 'SHORT',
      collateral: 125,
      stopPrice: 2168.8,
      entryPrice: 2008.1,
      signalConfidence: 0.81,
      sizingMode: 'exact_margin',
      sizingModel: 'operator_override',
    }));
  });

  test('buildTradePlan sizes by account risk and confidence when no explicit collateral override is provided', () => {
    const plan = hmDefiExecute.buildTradePlan({
      asset: 'ETH',
      direction: 'SHORT',
      leverage: 5,
      maxNotional: 200,
      reserveUsdc: 5,
      availableBalance: 500,
      midPrice: 2008.1,
      szDecimals: 4,
      signalConfidence: 0.7,
      stopLossPct: 0.08,
      takeProfitPct1: 0.07,
      takeProfitPct2: 0.12,
    });

    expect(plan).toEqual(expect.objectContaining({
      maxNotional: 200,
      maxNotionalApplied: false,
      sizingMode: 'risk_model',
      sizingModel: 'confidence_weighted_fractional_kelly',
    }));
    expect(plan.requestedNotional).toBeCloseTo(plan.riskTargetNotional, 2);
    expect(plan.notional).toBeLessThan(200);
    expect(plan.riskBudget).toBeGreaterThan(0);
    expect(plan.signalConfidence).toBe(0.7);
  });

  test('buildTradePlan still honors an explicit hard max notional when risk sizing would exceed it', () => {
    const plan = hmDefiExecute.buildTradePlan({
      asset: 'ETH',
      direction: 'SHORT',
      leverage: 5,
      reserveUsdc: 5,
      availableBalance: 1000,
      midPrice: 2000,
      szDecimals: 4,
      signalConfidence: 0.95,
      stopLossPrice: 2020,
      maxNotional: 200,
      stopLossPct: 0.08,
      takeProfitPct1: 0.07,
      takeProfitPct2: 0.12,
    });

    expect(plan).toEqual(expect.objectContaining({
      maxNotional: 200,
      maxNotionalApplied: true,
      notional: 200,
      collateral: 40,
    }));
  });

  test('buildTradePlan honors an explicit exact-notional override over the risk budget path', () => {
    const plan = hmDefiExecute.buildTradePlan({
      asset: 'AVAX',
      direction: 'SHORT',
      leverage: 5,
      notional: 300,
      reserveUsdc: 5,
      availableBalance: 1000,
      midPrice: 10,
      szDecimals: 2,
      signalConfidence: 0.62,
      stopLossPct: 0.08,
      takeProfitPct1: 0.07,
      takeProfitPct2: 0.12,
    });

    expect(plan).toEqual(expect.objectContaining({
      notionalOverride: 300,
      notionalOverrideApplied: true,
      requestedNotional: 300,
      notional: 300,
      collateral: 60,
      size: 30,
      sizingMode: 'exact_notional',
      sizingModel: 'operator_override',
    }));
  });

  test('buildTradePlan treats --margin as exact collateral instead of a risk-model ceiling', () => {
    const plan = hmDefiExecute.buildTradePlan({
      asset: 'ETH',
      direction: 'SHORT',
      leverage: 5,
      margin: 125,
      reserveUsdc: 5,
      availableBalance: 500,
      midPrice: 2008.1,
      szDecimals: 4,
      signalConfidence: 0.7,
      stopLossPct: 0.08,
      takeProfitPct1: 0.07,
      takeProfitPct2: 0.12,
    });

    expect(plan).toEqual(expect.objectContaining({
      collateral: 125,
      requestedNotional: 625,
      notional: 625,
      sizingMode: 'exact_margin',
      sizingModel: 'operator_override',
    }));
  });

  test('buildTradePlan still clamps explicit margin by maxNotional when a hard ceiling is present', () => {
    const plan = hmDefiExecute.buildTradePlan({
      asset: 'ETH',
      direction: 'SHORT',
      leverage: 5,
      margin: 125,
      maxNotional: 200,
      reserveUsdc: 5,
      availableBalance: 500,
      midPrice: 2000,
      szDecimals: 4,
      signalConfidence: 0.7,
      stopLossPct: 0.08,
      takeProfitPct1: 0.07,
      takeProfitPct2: 0.12,
    });

    expect(plan).toEqual(expect.objectContaining({
      collateral: 40,
      requestedNotional: 625,
      maxNotional: 200,
      maxNotionalApplied: true,
      notional: 200,
      sizingMode: 'exact_margin',
      sizingModel: 'operator_override',
    }));
  });

  test('executeHyperliquidOrder retries once after a 429-style rate-limit error', async () => {
    jest.useFakeTimers();
    try {
      const exchange = {
        order: jest.fn()
          .mockRejectedValueOnce(new Error('429 Too many connections'))
          .mockResolvedValueOnce({ status: 'ok' }),
      };

      const promise = hmDefiExecute.executeHyperliquidOrder(
        exchange,
        { orders: [], grouping: 'na' },
        { retryDelayMs: 50, maxRetries: 1, state: {} }
      );

      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(50);

      await expect(promise).resolves.toEqual({ status: 'ok' });
      expect(exchange.order).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  test('executeHyperliquidInfoCall retries once after a 429-style rate-limit error', async () => {
    jest.useFakeTimers();
    try {
      const factory = jest.fn()
        .mockRejectedValueOnce(new Error('429 Too many requests'))
        .mockResolvedValueOnce({ ok: true });

      const promise = hmDefiExecute.executeHyperliquidInfoCall(factory, {
        retryDelayMs: 50,
        jitterMs: 0,
        maxRetries: 1,
      });

      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(50);

      await expect(promise).resolves.toEqual({ ok: true });
      expect(factory).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  test('executeHyperliquidOrder writes attempt and result audit entries', async () => {
    const appendSpy = jest.spyOn(fs, 'appendFileSync').mockImplementation(() => {});
    const mkdirSpy = jest.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
    try {
      const exchange = {
        order: jest.fn().mockResolvedValue({ status: 'ok' }),
      };

      await expect(hmDefiExecute.executeHyperliquidOrder(
        exchange,
        { orders: [{ a: 1, b: true, p: '88.3', s: '1', r: true }], grouping: 'na' },
        { label: 'audit-order-test', maxRetries: 0, state: {} }
      )).resolves.toEqual({ status: 'ok' });

      const auditLines = appendSpy.mock.calls.map(([, content]) => String(content));
      expect(auditLines.some((line) => line.includes('"type":"hyperliquid_order_attempt"'))).toBe(true);
      expect(auditLines.some((line) => line.includes('"type":"hyperliquid_order_result"'))).toBe(true);
      expect(auditLines.some((line) => line.includes('"label":"audit-order-test"'))).toBe(true);
    } finally {
      appendSpy.mockRestore();
      mkdirSpy.mockRestore();
    }
  });

  test('executeHyperliquidCancel writes attempt and result audit entries', async () => {
    const appendSpy = jest.spyOn(fs, 'appendFileSync').mockImplementation(() => {});
    const mkdirSpy = jest.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
    try {
      const exchange = {
        cancel: jest.fn().mockResolvedValue({ status: 'ok' }),
      };

      await expect(hmDefiExecute.executeHyperliquidCancel(
        exchange,
        { cancels: [{ a: 7, o: 12345 }] },
        { label: 'audit-cancel-test' }
      )).resolves.toEqual({ status: 'ok' });

      const auditLines = appendSpy.mock.calls.map(([, content]) => String(content));
      expect(auditLines.some((line) => line.includes('"type":"hyperliquid_cancel_attempt"'))).toBe(true);
      expect(auditLines.some((line) => line.includes('"type":"hyperliquid_cancel_result"'))).toBe(true);
      expect(auditLines.some((line) => line.includes('"label":"audit-cancel-test"'))).toBe(true);
    } finally {
      appendSpy.mockRestore();
      mkdirSpy.mockRestore();
    }
  });

  test('buildHyperliquidTriggerOrder creates a reduce-only stop-market payload', () => {
    expect(hmDefiExecute.buildHyperliquidTriggerOrder({
      assetIndex: 4,
      isBuy: true,
      size: 1.7113,
      triggerPrice: 2168.8,
      referencePrice: 2168.8,
      szDecimals: 4,
      tpsl: 'sl',
    })).toEqual({
      a: 4,
      b: true,
      p: '2168.8',
      s: '1.7113',
      r: true,
      t: { trigger: { triggerPx: '2168.8', isMarket: true, tpsl: 'sl' } },
    });
  });

  test('buildVolatilitySnapshot derives wider ATR-based protection when recent ranges are elevated', () => {
    const snapshot = hmDefiExecute.buildVolatilitySnapshot({
      historicalBars: [
        { open: 100, high: 103, low: 99, close: 102 },
        { open: 102, high: 106, low: 101, close: 105 },
        { open: 105, high: 108, low: 103, close: 104 },
        { open: 104, high: 109, low: 102, close: 108 },
      ],
      midPrice: 108,
      stopLossPct: 0.08,
      takeProfitPct2: 0.12,
    });

    expect(snapshot).toEqual(expect.objectContaining({
      source: 'recent_hyperliquid_bars',
      barCount: 4,
    }));
    expect(snapshot.atr).toBeGreaterThan(0);
    expect(snapshot.stopDistancePct).toBeGreaterThan(0.03);
    expect(snapshot.takeProfitDistancePct).toBeGreaterThan(snapshot.stopDistancePct);
  });

  test('extractOpenHyperliquidPosition returns the live filled side and absolute size', () => {
    expect(hmDefiExecute.extractOpenHyperliquidPosition({
      assetPositions: [
        { position: { coin: 'ETH', szi: '-0.61', entryPx: '2105.2' } },
      ],
    }, 'ETH')).toEqual(expect.objectContaining({
      coin: 'ETH',
      side: 'SHORT',
      signedSize: -0.61,
      absSize: 0.61,
      entryPx: 2105.2,
    }));
  });

  test('extractHyperliquidOrderId finds trigger order ids from Hyperliquid status payloads', () => {
    expect(hmDefiExecute.extractHyperliquidOrderId({
      response: {
        data: {
          statuses: [
            { resting: { oid: 998877 } },
          ],
        },
      },
    })).toBe(998877);
  });

  test('findLatestActiveHyperliquidTriggerOrderFromAudit returns the latest non-canceled stop oid', () => {
    expect(hmDefiExecute.findLatestActiveHyperliquidTriggerOrderFromAudit({
      entries: [
        {
          type: 'hyperliquid_order_result',
          label: 'placeStopLoss',
          payload: {
            orders: [{ a: 76, t: { trigger: { tpsl: 'sl' } } }],
          },
          result: {
            status: 'ok',
            response: {
              data: {
                statuses: [{ resting: { oid: 393943072354 } }],
              },
            },
          },
        },
        {
          type: 'hyperliquid_cancel_result',
          payload: {
            cancels: [{ a: 76, o: 393943072354 }],
          },
          result: {
            status: 'ok',
            response: { type: 'cancel', data: { statuses: ['success'] } },
          },
        },
        {
          type: 'hyperliquid_order_result',
          label: 'arch-ordi-widen-place',
          payload: {
            orders: [{ a: 76, t: { trigger: { tpsl: 'sl' } } }],
          },
          result: {
            status: 'ok',
            response: {
              data: {
                statuses: [{ resting: { oid: 393948579664 } }],
              },
            },
          },
        },
      ],
      assetIndex: 76,
      tpsl: 'sl',
    })).toEqual(expect.objectContaining({
      oid: 393948579664,
      label: 'arch-ordi-widen-place',
    }));
  });

  test('openHyperliquidPosition verifies filled size before placing stop/TP and returns warnings on partial protection failure', async () => {
    const info = {
      clearinghouseState: jest.fn()
        .mockResolvedValueOnce({
          marginSummary: { accountValue: '500' },
          assetPositions: [],
        })
        .mockResolvedValueOnce({
          marginSummary: { accountValue: '500' },
          assetPositions: [
            { position: { coin: 'ETH', szi: '-0.21', entryPx: '2105.2' } },
          ],
        }),
      meta: jest.fn().mockResolvedValue({
        universe: [{ name: 'ETH', szDecimals: 3 }],
      }),
      allMids: jest.fn().mockResolvedValue({ ETH: '2100' }),
    };
    const exchange = {
      updateLeverage: jest.fn().mockResolvedValue({ ok: true }),
      order: jest.fn()
        .mockResolvedValueOnce({ status: 'entry-accepted' })
        .mockRejectedValueOnce(new Error('stop rejected'))
        .mockResolvedValueOnce({
          status: 'tp-accepted',
          response: {
            data: {
              statuses: [
                { resting: { oid: 445566 } },
              ],
            },
          },
        }),
    };

    const result = await hmDefiExecute.openHyperliquidPosition({
      asset: 'ETH',
      direction: 'SELL',
      leverage: 5,
      margin: 125,
      stopLossPrice: 2168.8,
      dryRun: false,
      credentials: {
        privateKey: '0xabc',
        walletAddress: '0xwallet',
      },
      clientOrderId: 'consultation-eth-short',
      hyperliquidRuntime: {
        walletAddress: '0xwallet',
        info,
        exchange,
      },
    });

    expect(exchange.updateLeverage).toHaveBeenCalledWith(expect.objectContaining({
      leverage: 5,
      isCross: false,
    }));
    expect(exchange.order).toHaveBeenCalledTimes(3);
    expect(exchange.order).toHaveBeenNthCalledWith(1, expect.objectContaining({
      orders: [
        expect.objectContaining({
          c: expect.stringMatching(/^0x[a-f0-9]{32}$/),
        }),
      ],
    }));
    expect(exchange.order).toHaveBeenNthCalledWith(3, expect.objectContaining({
      orders: [expect.objectContaining({
        s: '0.105',
        r: true,
        t: { trigger: expect.objectContaining({ tpsl: 'tp' }) },
      })],
    }));
    expect(result).toEqual(expect.objectContaining({
      asset: 'ETH',
      direction: 'SHORT',
      size: 0.21,
      price: 2105.2,
      partialFill: true,
      stopLossConfigured: false,
      takeProfitConfigured: true,
      stopPrice: 2168.8,
      riskBudget: expect.any(Number),
      riskPct: expect.any(Number),
      signalConfidence: 0.7,
      firstTakeProfitPrice: expect.any(Number),
      runnerTakeProfitPrice: expect.any(Number),
      bracketPlan: expect.objectContaining({
        firstTakeProfitSize: 0.105,
        firstTakeProfitOrderId: 445566,
        runnerSize: 0.105,
      }),
      clientOrderId: expect.stringMatching(/^0x[a-f0-9]{32}$/),
      warnings: ['stop_loss_failed:stop rejected'],
    }));
  });

  test('openHyperliquidPosition treats BUY against a live short as a reduce-only close instead of opening a reverse long', async () => {
    const info = {
      clearinghouseState: jest.fn()
        .mockResolvedValueOnce({
          marginSummary: { accountValue: '500' },
          assetPositions: [
            { position: { coin: 'BTC', szi: '-0.15188', entryPx: '74200' } },
          ],
        })
        .mockResolvedValueOnce({
          marginSummary: { accountValue: '500' },
          assetPositions: [],
        }),
      meta: jest.fn().mockResolvedValue({
        universe: [{ name: 'BTC', szDecimals: 5 }],
      }),
      allMids: jest.fn().mockResolvedValue({ BTC: '74420' }),
      openOrders: jest.fn().mockResolvedValue([
        { coin: 'BTC', oid: 1234 },
        { coin: 'ETH', oid: 9999 },
      ]),
    };
    const exchange = {
      updateLeverage: jest.fn(),
      cancel: jest.fn().mockResolvedValue({ ok: true }),
      order: jest.fn().mockResolvedValue({ status: 'close-accepted' }),
    };

    const result = await hmDefiExecute.openHyperliquidPosition({
      asset: 'BTC',
      direction: 'BUY',
      leverage: 20,
      margin: 12,
      dryRun: false,
      credentials: {
        privateKey: '0xabc',
        walletAddress: '0xwallet',
      },
      hyperliquidRuntime: {
        walletAddress: '0xwallet',
        info,
        exchange,
      },
    });

    expect(exchange.updateLeverage).not.toHaveBeenCalled();
    expect(exchange.cancel).toHaveBeenCalledWith({
      cancels: [{ a: 0, o: 1234 }],
    });
    expect(exchange.cancel).toHaveBeenCalledTimes(1);
    expect(exchange.order).toHaveBeenCalledTimes(1);
    expect(exchange.order).toHaveBeenCalledWith(expect.objectContaining({
      orders: [expect.objectContaining({
        b: true,
        r: true,
        s: '0.15188',
        t: { limit: { tif: 'Ioc' } },
      })],
    }));
    expect(result).toEqual(expect.objectContaining({
      asset: 'BTC',
      direction: 'SHORT',
      requestedDirection: 'BUY',
      closeOnly: true,
      size: 0.15188,
      closedSize: 0.15188,
      remainingSize: 0,
      closedCompletely: true,
      warnings: [],
    }));
  });

  test('openHyperliquidPosition derives ATR-style stop and TP from recent bars when explicit levels are omitted', async () => {
    const info = {
      clearinghouseState: jest.fn()
        .mockResolvedValueOnce({
          marginSummary: { accountValue: '615.68' },
          assetPositions: [],
        })
        .mockResolvedValueOnce({
          marginSummary: { accountValue: '615.68' },
          assetPositions: [
            { position: { coin: 'AVAX', szi: '-4.2', entryPx: '9.0246' } },
          ],
        }),
      meta: jest.fn().mockResolvedValue({
        universe: [{ name: 'AVAX', szDecimals: 2 }],
      }),
      allMids: jest.fn().mockResolvedValue({ AVAX: '9.0246' }),
    };
    const exchange = {
      updateLeverage: jest.fn().mockResolvedValue({ ok: true }),
      order: jest.fn()
        .mockResolvedValueOnce({ status: 'entry-accepted' })
        .mockResolvedValueOnce({ status: 'sl-accepted' })
        .mockResolvedValueOnce({ status: 'tp-accepted' }),
    };

    const result = await hmDefiExecute.openHyperliquidPosition({
      asset: 'AVAX',
      direction: 'SELL',
      leverage: 5,
      signalConfidence: 0.83,
      dryRun: false,
      historicalBars: [
        { open: 9.4, high: 9.55, low: 9.18, close: 9.28 },
        { open: 9.28, high: 9.31, low: 9.02, close: 9.06 },
        { open: 9.06, high: 9.12, low: 8.84, close: 8.92 },
        { open: 8.92, high: 9.08, low: 8.8, close: 8.98 },
      ],
      credentials: {
        privateKey: '0xabc',
        walletAddress: '0xwallet',
      },
      hyperliquidRuntime: {
        walletAddress: '0xwallet',
        info,
        exchange,
      },
    });

    expect(exchange.order).toHaveBeenCalledTimes(3);
    expect(exchange.order).toHaveBeenNthCalledWith(2, expect.objectContaining({
      orders: [expect.objectContaining({
        r: true,
        t: { trigger: expect.objectContaining({ isMarket: true, tpsl: 'sl' }) },
      })],
    }));
    expect(exchange.order).toHaveBeenNthCalledWith(3, expect.objectContaining({
      orders: [expect.objectContaining({
        s: '2.1',
        r: true,
        t: { trigger: expect.objectContaining({ isMarket: true, tpsl: 'tp' }) },
      })],
    }));
    expect(result.stopPrice).toBeGreaterThan(result.price);
    expect(result.takeProfitPrice).toBeLessThan(result.price);
    expect(result.signalConfidence).toBe(0.83);
  });

  test('openHyperliquidPosition clamps requested leverage to the asset max leverage from Hyperliquid meta', async () => {
    const info = {
      clearinghouseState: jest.fn()
        .mockResolvedValueOnce({
          marginSummary: { accountValue: '615.68' },
          assetPositions: [],
        })
        .mockResolvedValueOnce({
          marginSummary: { accountValue: '615.68' },
          assetPositions: [
            { position: { coin: 'RESOLV', szi: '-500', entryPx: '0.0371' } },
          ],
        }),
      meta: jest.fn().mockResolvedValue({
        universe: [{ name: 'RESOLV', szDecimals: 0, maxLeverage: 3 }],
      }),
      allMids: jest.fn().mockResolvedValue({ RESOLV: '0.037164' }),
    };
    const exchange = {
      updateLeverage: jest.fn().mockResolvedValue({ ok: true }),
      order: jest.fn()
        .mockResolvedValueOnce({ status: 'entry-accepted' })
        .mockResolvedValueOnce({ status: 'sl-accepted' })
        .mockResolvedValueOnce({ status: 'tp-accepted' }),
    };

    const result = await hmDefiExecute.openHyperliquidPosition({
      asset: 'RESOLV',
      direction: 'SELL',
      leverage: 5,
      margin: 9.760493,
      signalConfidence: 0.705,
      dryRun: false,
      credentials: {
        privateKey: '0xabc',
        walletAddress: '0xwallet',
      },
      hyperliquidRuntime: {
        walletAddress: '0xwallet',
        info,
        exchange,
      },
    });

    expect(exchange.updateLeverage).toHaveBeenCalledWith(expect.objectContaining({
      leverage: 3,
      isCross: false,
    }));
    expect(exchange.order).toHaveBeenNthCalledWith(1, expect.objectContaining({
      orders: [expect.objectContaining({
        p: '0.036792',
        s: '787',
      })],
    }));
    expect(result).toEqual(expect.objectContaining({
      asset: 'RESOLV',
      direction: 'SHORT',
      stopLossConfigured: true,
      takeProfitConfigured: true,
      signalConfidence: 0.705,
    }));
  });

  test('openHyperliquidPosition respects szDecimals=0 and sends integer size for integer-only assets', async () => {
    const info = {
      clearinghouseState: jest.fn()
        .mockResolvedValueOnce({
          marginSummary: { accountValue: '615.44' },
          assetPositions: [],
        })
        .mockResolvedValueOnce({
          marginSummary: { accountValue: '615.44' },
          assetPositions: [
            { position: { coin: 'ALGO', szi: '290', entryPx: '0.1269' } },
          ],
        }),
      meta: jest.fn().mockResolvedValue({
        universe: [{ name: 'ALGO', szDecimals: 0, maxLeverage: 5 }],
      }),
      allMids: jest.fn().mockResolvedValue({ ALGO: '0.12566' }),
    };
    const exchange = {
      updateLeverage: jest.fn().mockResolvedValue({ ok: true }),
      order: jest.fn()
        .mockResolvedValueOnce({ status: 'entry-accepted' })
        .mockResolvedValueOnce({ status: 'sl-accepted' })
        .mockResolvedValueOnce({ status: 'tp-accepted' }),
    };

    const result = await hmDefiExecute.openHyperliquidPosition({
      asset: 'ALGO',
      direction: 'BUY',
      leverage: 5,
      margin: 7.308349,
      signalConfidence: 0.62,
      dryRun: false,
      credentials: {
        privateKey: '0xabc',
        walletAddress: '0xwallet',
      },
      hyperliquidRuntime: {
        walletAddress: '0xwallet',
        info,
        exchange,
      },
    });

    expect(exchange.order).toHaveBeenNthCalledWith(1, expect.objectContaining({
      orders: [expect.objectContaining({
        p: '0.12692',
        s: '290',
      })],
    }));
    expect(result).toEqual(expect.objectContaining({
      asset: 'ALGO',
      direction: 'LONG',
      size: 290,
      stopLossConfigured: true,
      takeProfitConfigured: true,
      signalConfidence: 0.62,
    }));
  });

  test('openHyperliquidPosition returns null when the IOC entry does not produce a live position', async () => {
    const info = {
      clearinghouseState: jest.fn()
        .mockResolvedValueOnce({
          marginSummary: { accountValue: '500' },
          assetPositions: [],
        })
        .mockResolvedValueOnce({
          marginSummary: { accountValue: '500' },
          assetPositions: [],
        }),
      meta: jest.fn().mockResolvedValue({
        universe: [{ name: 'ETH', szDecimals: 3 }],
      }),
      allMids: jest.fn().mockResolvedValue({ ETH: '2100' }),
    };
    const exchange = {
      updateLeverage: jest.fn().mockResolvedValue({ ok: true }),
      order: jest.fn().mockResolvedValue({ status: 'entry-accepted' }),
    };

    const result = await hmDefiExecute.openHyperliquidPosition({
      asset: 'ETH',
      direction: 'SELL',
      leverage: 5,
      margin: 125,
      stopLossPrice: 2168.8,
      dryRun: false,
      credentials: {
        privateKey: '0xabc',
        walletAddress: '0xwallet',
      },
      hyperliquidRuntime: {
        walletAddress: '0xwallet',
        info,
        exchange,
      },
    });

    expect(exchange.order).toHaveBeenCalledTimes(1);
    expect(result).toBeNull();
  });

  test('openHyperliquidPosition auto-closes undersized dust fills instead of keeping them as live positions', async () => {
    const info = {
      clearinghouseState: jest.fn()
        .mockResolvedValueOnce({
          marginSummary: { accountValue: '500' },
          assetPositions: [],
        })
        .mockResolvedValueOnce({
          marginSummary: { accountValue: '500' },
          assetPositions: [],
        }),
      meta: jest.fn().mockResolvedValue({
        universe: [{ name: 'CHIP', szDecimals: 0, maxLeverage: 3 }],
      }),
      allMids: jest.fn().mockResolvedValue({ CHIP: '0.091832' }),
    };
    const exchange = {
      updateLeverage: jest.fn().mockResolvedValue({ ok: true }),
      order: jest.fn()
        .mockResolvedValueOnce({
          status: 'ok',
          response: {
            type: 'order',
            data: {
              statuses: [{ filled: { totalSz: '1.0', avgPx: '0.091704', oid: 123 } }],
            },
          },
        })
        .mockResolvedValueOnce({
          status: 'ok',
          response: {
            type: 'order',
            data: {
              statuses: [{ filled: { totalSz: '1.0', avgPx: '0.091900', oid: 124 } }],
            },
          },
        }),
    };

    const result = await hmDefiExecute.openHyperliquidPosition({
      asset: 'CHIP',
      direction: 'SELL',
      leverage: 3,
      margin: 100,
      stopLossPrice: 0.094092,
      signalConfidence: 0.62,
      dryRun: false,
      credentials: {
        privateKey: '0xabc',
        walletAddress: '0xwallet',
      },
      hyperliquidRuntime: {
        walletAddress: '0xwallet',
        info,
        exchange,
      },
    });

    expect(result).toBeNull();
    expect(exchange.order).toHaveBeenCalledTimes(2);
    expect(exchange.order).toHaveBeenNthCalledWith(2, expect.objectContaining({
      orders: [expect.objectContaining({
        b: true,
        r: true,
        s: '1',
      })],
    }));
  });

  test('openHyperliquidPosition blocks duplicate broadcasts when the same cloid already exists on Hyperliquid', async () => {
    const info = {
      clearinghouseState: jest.fn()
        .mockResolvedValueOnce({
          marginSummary: { accountValue: '500' },
          assetPositions: [],
        })
        .mockResolvedValueOnce({
          marginSummary: { accountValue: '500' },
          assetPositions: [
            { position: { coin: 'ETH', szi: '-0.18', entryPx: '2104.5' } },
          ],
        }),
      meta: jest.fn().mockResolvedValue({
        universe: [{ name: 'ETH', szDecimals: 3 }],
      }),
      allMids: jest.fn().mockResolvedValue({ ETH: '2100' }),
      orderStatus: jest.fn().mockResolvedValue({
        status: 'order',
        order: {
          order: {
            coin: 'ETH',
            cloid: '0x1234567890abcdef1234567890abcdef',
          },
          status: 'filled',
          statusTimestamp: Date.now(),
        },
      }),
    };
    const exchange = {
      updateLeverage: jest.fn(),
      order: jest.fn(),
    };

    const result = await hmDefiExecute.openHyperliquidPosition({
      asset: 'ETH',
      direction: 'SELL',
      leverage: 5,
      margin: 125,
      stopLossPrice: 2168.8,
      clientOrderId: '0x1234567890abcdef1234567890abcdef',
      dryRun: false,
      credentials: {
        privateKey: '0xabc',
        walletAddress: '0xwallet',
      },
      hyperliquidRuntime: {
        walletAddress: '0xwallet',
        info,
        exchange,
      },
    });

    expect(info.orderStatus).toHaveBeenCalledWith({
      user: '0xwallet',
      oid: '0x1234567890abcdef1234567890abcdef',
    });
    expect(exchange.updateLeverage).not.toHaveBeenCalled();
    expect(exchange.order).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({
      duplicatePrevented: true,
      existingOrderStatus: 'filled',
      clientOrderId: '0x1234567890abcdef1234567890abcdef',
      direction: 'SHORT',
      size: 0.18,
      warnings: ['duplicate_entry_blocked:filled'],
    }));
  });

  test('openHyperliquidPosition recovers from a hanging Hyperliquid call by timing out cleanly', async () => {
    const info = {
      clearinghouseState: jest.fn().mockResolvedValue({
        marginSummary: { accountValue: '500' },
        assetPositions: [],
      }),
      meta: jest.fn().mockResolvedValue({
        universe: [{ name: 'ETH', szDecimals: 3 }],
      }),
      allMids: jest.fn().mockResolvedValue({ ETH: '2100' }),
    };
    const exchange = {
      updateLeverage: jest.fn(() => new Promise(() => {})),
      order: jest.fn(),
    };

    const result = await hmDefiExecute.openHyperliquidPosition({
      asset: 'ETH',
      direction: 'SELL',
      leverage: 5,
      margin: 125,
      stopLossPrice: 2168.8,
      hyperliquidCallTimeoutMs: 25,
      dryRun: false,
      credentials: {
        privateKey: '0xabc',
        walletAddress: '0xwallet',
      },
      hyperliquidRuntime: {
        walletAddress: '0xwallet',
        info,
        exchange,
      },
    });

    expect(exchange.updateLeverage).toHaveBeenCalled();
    expect(exchange.order).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  test('openHyperliquidPosition reuses market snapshot data but refetches untimestamped clearinghouse state', async () => {
    const info = {
      clearinghouseState: jest.fn().mockResolvedValue({
        marginSummary: { accountValue: '500' },
        assetPositions: [],
      }),
      meta: jest.fn(),
      allMids: jest.fn(),
      orderStatus: jest.fn(),
    };
    const exchange = {
      updateLeverage: jest.fn().mockResolvedValue({ ok: true }),
      order: jest.fn()
        .mockResolvedValueOnce({
          status: 'ok',
          response: {
            data: {
              statuses: [
                {
                  filled: {
                    totalSz: '0.21',
                    avgPx: '2105.2',
                    oid: 123456,
                  },
                },
              ],
            },
          },
        })
        .mockResolvedValueOnce({
          status: 'ok',
          response: { data: { statuses: [{ resting: { oid: 222 } }] } },
        })
        .mockResolvedValueOnce({
          status: 'ok',
          response: { data: { statuses: [{ resting: { oid: 333 } }] } },
        }),
    };

    const result = await hmDefiExecute.openHyperliquidPosition({
      asset: 'ETH',
      direction: 'SELL',
      leverage: 5,
      margin: 125,
      stopLossPrice: 2168.8,
      dryRun: false,
      clientOrderId: 'snapshot-path-eth-short',
      credentials: {
        privateKey: '0xabc',
        walletAddress: '0xwallet',
      },
      hyperliquidRuntime: {
        walletAddress: '0xwallet',
        info,
        exchange,
      },
      executionSnapshot: {
        clearinghouseState: {
          marginSummary: { accountValue: '500' },
          assetPositions: [],
        },
        meta: {
          universe: [{ name: 'ETH', szDecimals: 3, maxLeverage: 10 }],
        },
        allMids: { ETH: '2100' },
        resolvedAsset: {
          asset: { name: 'ETH', szDecimals: 3, maxLeverage: 10 },
          assetIndex: 0,
        },
      },
      historicalBars: [
        { open: 2090, high: 2105, low: 2088, close: 2100 },
        { open: 2100, high: 2110, low: 2098, close: 2104 },
      ],
      skipDuplicateCheck: true,
    });

    expect(info.clearinghouseState).toHaveBeenCalledTimes(1);
    expect(info.meta).not.toHaveBeenCalled();
    expect(info.allMids).not.toHaveBeenCalled();
    expect(info.orderStatus).not.toHaveBeenCalled();
    expect(exchange.updateLeverage).toHaveBeenCalledTimes(1);
    expect(exchange.order).toHaveBeenCalledTimes(3);
    expect(result).toEqual(expect.objectContaining({
      asset: 'ETH',
      direction: 'SELL',
      size: 0.21,
      price: 2105.2,
      stopLossConfigured: true,
      takeProfitConfigured: true,
    }));
  });

  test('openHyperliquidPosition rejects stale execution snapshot clearinghouse state before sizing', async () => {
    const info = {
      clearinghouseState: jest.fn().mockResolvedValue({
        marginSummary: { accountValue: '500' },
        assetPositions: [],
      }),
      meta: jest.fn(),
      allMids: jest.fn(),
    };

    const result = await hmDefiExecute.openHyperliquidPosition({
      asset: 'ETH',
      direction: 'SELL',
      leverage: 5,
      margin: 125,
      stopLossPrice: 2168.8,
      dryRun: true,
      nowMs: Date.parse('2026-04-25T10:00:20.000Z'),
      freshClearinghouseMaxAgeMs: 10 * 1000,
      credentials: {
        privateKey: '0xabc',
        walletAddress: '0xwallet',
      },
      hyperliquidRuntime: {
        walletAddress: '0xwallet',
        info,
        exchange: {},
      },
      executionSnapshot: {
        cachedAt: '2026-04-25T10:00:00.000Z',
        clearinghouseState: {
          marginSummary: { accountValue: '500' },
          assetPositions: [
            { position: { coin: 'ETH', szi: '0.21', entryPx: '2105.2' } },
          ],
        },
        meta: {
          universe: [{ name: 'ETH', szDecimals: 3, maxLeverage: 10 }],
        },
        allMids: { ETH: '2100' },
        resolvedAsset: {
          asset: { name: 'ETH', szDecimals: 3, maxLeverage: 10 },
          assetIndex: 0,
        },
      },
      historicalBars: [
        { open: 2090, high: 2105, low: 2088, close: 2100 },
        { open: 2100, high: 2110, low: 2098, close: 2104 },
      ],
    });

    expect(info.clearinghouseState).toHaveBeenCalledTimes(1);
    expect(result).toEqual(expect.objectContaining({
      asset: 'ETH',
      direction: 'SELL',
      collateral: 125,
    }));
  });

  test('openHyperliquidPosition fetches fresh clearinghouse state when execution snapshot is missing', async () => {
    const info = {
      clearinghouseState: jest.fn().mockResolvedValue({
        marginSummary: { accountValue: '500' },
        assetPositions: [],
      }),
      meta: jest.fn(),
      allMids: jest.fn(),
    };

    const result = await hmDefiExecute.openHyperliquidPosition({
      asset: 'ETH',
      direction: 'SELL',
      leverage: 5,
      margin: 125,
      stopLossPrice: 2168.8,
      dryRun: true,
      credentials: {
        privateKey: '0xabc',
        walletAddress: '0xwallet',
      },
      hyperliquidRuntime: {
        walletAddress: '0xwallet',
        info,
        exchange: {},
      },
      executionSnapshot: {
        meta: {
          universe: [{ name: 'ETH', szDecimals: 3, maxLeverage: 10 }],
        },
        allMids: { ETH: '2100' },
        resolvedAsset: {
          asset: { name: 'ETH', szDecimals: 3, maxLeverage: 10 },
          assetIndex: 0,
        },
      },
      historicalBars: [
        { open: 2090, high: 2105, low: 2088, close: 2100 },
        { open: 2100, high: 2110, low: 2098, close: 2104 },
      ],
    });

    expect(info.clearinghouseState).toHaveBeenCalledTimes(1);
    expect(result).toEqual(expect.objectContaining({
      asset: 'ETH',
      direction: 'SELL',
      collateral: 125,
    }));
  });

  test('openHyperliquidPosition aborts instead of using stale clearinghouse state when fresh fetch fails', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const info = {
        clearinghouseState: jest.fn().mockRejectedValue(new Error('network down')),
        meta: jest.fn(),
        allMids: jest.fn(),
      };
      const exchange = {
        updateLeverage: jest.fn(),
        order: jest.fn(),
      };

      const result = await hmDefiExecute.openHyperliquidPosition({
        asset: 'ETH',
        direction: 'SELL',
        leverage: 5,
        margin: 125,
        stopLossPrice: 2168.8,
        dryRun: false,
        nowMs: Date.parse('2026-04-25T10:00:20.000Z'),
        credentials: {
          privateKey: '0xabc',
          walletAddress: '0xwallet',
        },
        hyperliquidRuntime: {
          walletAddress: '0xwallet',
          info,
          exchange,
        },
        executionSnapshot: {
          cachedAt: '2026-04-25T10:00:00.000Z',
          clearinghouseState: {
            marginSummary: { accountValue: '500' },
            assetPositions: [],
          },
          meta: {
            universe: [{ name: 'ETH', szDecimals: 3, maxLeverage: 10 }],
          },
          allMids: { ETH: '2100' },
        },
      });

      expect(result).toBeNull();
      expect(info.clearinghouseState).toHaveBeenCalledTimes(1);
      expect(exchange.updateLeverage).not.toHaveBeenCalled();
      expect(exchange.order).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Fresh clearinghouseState required before Hyperliquid order placement: network down'));
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('openHyperliquidPosition retries a preflight info 429 before giving up on the trade', async () => {
    jest.useFakeTimers();
    try {
      const info = {
        clearinghouseState: jest.fn()
          .mockRejectedValueOnce(new Error('429 Too many connections'))
          .mockResolvedValueOnce({
            marginSummary: { accountValue: '500' },
            assetPositions: [],
          }),
        meta: jest.fn().mockResolvedValue({
          universe: [{ name: 'ETH', szDecimals: 3 }],
        }),
        allMids: jest.fn().mockResolvedValue({ ETH: '2100' }),
      };

      const promise = hmDefiExecute.openHyperliquidPosition({
        asset: 'ETH',
        direction: 'SELL',
        leverage: 5,
        margin: 125,
        stopLossPrice: 2168.8,
        historicalBars: [],
        infoRetryDelayMs: 50,
        infoJitterMs: 0,
        infoMaxRetries: 1,
        dryRun: true,
        credentials: {
          privateKey: '0xabc',
          walletAddress: '0xwallet',
        },
        hyperliquidRuntime: {
          walletAddress: '0xwallet',
          info,
          exchange: {},
        },
      });

      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(50);

      await expect(promise).resolves.toEqual(expect.objectContaining({
        asset: 'ETH',
        direction: 'SELL',
        collateral: 125,
      }));
      expect(info.clearinghouseState).toHaveBeenCalledTimes(2);
      expect(info.meta).toHaveBeenCalledTimes(1);
      expect(info.allMids).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
});
