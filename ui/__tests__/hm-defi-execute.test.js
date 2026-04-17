const hmDefiExecute = require('../scripts/hm-defi-execute');

describe('hm-defi-execute helpers', () => {
  test('buildTradePlan supports long assets with explicit margin', () => {
    const plan = hmDefiExecute.buildTradePlan({
      asset: 'WTI',
      direction: 'LONG',
      leverage: 10,
      margin: 150,
      reserveUsdc: 5,
      availableBalance: 692,
      midPrice: 99.64,
      szDecimals: 2,
      stopLossPct: 0.08,
      takeProfitPct1: 0.07,
      takeProfitPct2: 0.12,
    });

    expect(plan.asset).toBe('WTI');
    expect(plan.direction).toBe('LONG');
    expect(plan.leverage).toBe(10);
    expect(plan.collateral).toBeGreaterThan(0);
    expect(plan.collateral).toBeLessThanOrEqual(150);
    expect(plan.isLong).toBe(true);
    expect(plan.limitPrice).toBeGreaterThan(plan.entryPrice);
    expect(plan.stopPrice).toBeLessThan(plan.entryPrice);
    expect(plan.takeProfitPrice2).toBeGreaterThan(plan.entryPrice);
    expect(plan.size).toBeGreaterThan(0);
  });

  test('buildTradePlan supports short assets with default collateral', () => {
    const plan = hmDefiExecute.buildTradePlan({
      asset: 'ETH',
      direction: 'SHORT',
      leverage: 5,
      margin: null,
      reserveUsdc: 5,
      availableBalance: 250,
      midPrice: 3500,
      szDecimals: 3,
      stopLossPct: 0.08,
      takeProfitPct1: 0.07,
      takeProfitPct2: 0.12,
    });

    expect(plan.asset).toBe('ETH');
    expect(plan.direction).toBe('SHORT');
    expect(plan.leverage).toBe(5);
    expect(plan.collateral).toBeGreaterThan(0);
    expect(plan.collateral).toBeLessThanOrEqual(245);
    expect(plan.isLong).toBe(false);
    expect(plan.limitPrice).toBeLessThan(plan.entryPrice);
    expect(plan.stopPrice).toBeGreaterThan(plan.entryPrice);
    expect(plan.takeProfitPrice2).toBeLessThan(plan.entryPrice);
    expect(plan.size).toBeGreaterThan(0);
  });

  test('buildTradePlan caps short stop distance inside the leverage liquidation buffer', () => {
    const plan = hmDefiExecute.buildTradePlan({
      asset: 'NEAR',
      direction: 'SHORT',
      leverage: 10,
      margin: 100,
      reserveUsdc: 5,
      availableBalance: 500,
      midPrice: 1.33947,
      szDecimals: 1,
      stopLossPct: 0.15,
      takeProfitPct1: 0.07,
      takeProfitPct2: 0.12,
    });

    expect(plan.stopPrice).toBeGreaterThan(plan.entryPrice);
    expect(plan.stopDistancePct).toBeLessThanOrEqual(0.06);
  });

  test('constrainStopPriceWithinLiquidationBuffer keeps short stops below liquidation', () => {
    const constrained = hmDefiExecute.constrainStopPriceWithinLiquidationBuffer({
      stopPrice: 1.45,
      entryPrice: 1.33947,
      liquidationPx: 1.4027,
      isLong: false,
      referencePrice: 1.33947,
      szDecimals: 4,
    });

    expect(constrained).toBeGreaterThan(1.33947);
    expect(constrained).toBeLessThan(1.4027);
  });

  test('findAssetMeta resolves arbitrary assets from Hyperliquid metadata', () => {
    const meta = {
      universe: [
        { name: 'BTC', szDecimals: 3 },
        { name: 'WTI', szDecimals: 1 },
        { name: 'GOLD', szDecimals: 2 },
      ],
    };

    const resolved = hmDefiExecute.findAssetMeta(meta, 'wti');
    expect(resolved.asset.name).toBe('WTI');
    expect(resolved.assetIndex).toBe(1);
  });

  test('main prints help and exits before any live execution path', async () => {
    const statusSpy = jest.spyOn(hmDefiExecute, 'checkStatus').mockResolvedValue({ ok: true });
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const result = await hmDefiExecute.main(
      hmDefiExecute.parseCliArgs(['--help'])
    );

    expect(statusSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
    expect(result).toEqual({ ok: true, help: true });

    statusSpy.mockRestore();
    logSpy.mockRestore();
  });

  test('parseCliArgs normalizes -h and --usage to help', () => {
    expect(hmDefiExecute.parseCliArgs(['-h']).options.get('help')).toBe(true);
    expect(hmDefiExecute.parseCliArgs(['--usage']).options.get('help')).toBe(true);
  });
});
