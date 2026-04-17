const hmDefiClose = require('../scripts/hm-defi-close');

describe('hm-defi-close helpers', () => {
  test('parseCloseOptions reads asset filter', () => {
    const parsed = hmDefiClose.parseCloseOptions(
      hmDefiClose.parseCliArgs(['--asset', 'WTI'])
    );

    expect(parsed.asset).toBe('WTI');
    expect(parsed.dryRun).toBe(false);
    expect(parsed.help).toBe(false);
    expect(parsed.size).toBeNull();
  });

  test('buildCloseOrderPlan closes shorts with buy-to-cover and longs with sell', () => {
    const shortPlan = hmDefiClose.buildCloseOrderPlan({ size: -2.5, midPrice: 99.64 });
    expect(shortPlan.isBuy).toBe(true);
    expect(shortPlan.absSize).toBe(2.5);
    expect(typeof shortPlan.limitPrice).toBe('string');
    expect(Number(shortPlan.limitPrice)).toBeGreaterThan(99.64);

    const longPlan = hmDefiClose.buildCloseOrderPlan({ size: 1.75, midPrice: 3500 });
    expect(longPlan.isBuy).toBe(false);
    expect(longPlan.absSize).toBe(1.75);
    expect(typeof longPlan.limitPrice).toBe('string');
    expect(Number(longPlan.limitPrice)).toBeLessThan(3500);
  });

  test('normalizeAssetName uppercases asset filters', () => {
    expect(hmDefiClose.normalizeAssetName('gold')).toBe('GOLD');
    expect(hmDefiClose.normalizeAssetName('')).toBeNull();
  });

  test('main prints help and does not execute close logic', async () => {
    const closeSpy = jest.spyOn(hmDefiClose, 'closeHyperliquidPositions').mockResolvedValue({ ok: true });
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const result = await hmDefiClose.main(
      hmDefiClose.parseCliArgs(['--help'])
    );

    expect(closeSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
    expect(result).toEqual({ ok: true, help: true });

    closeSpy.mockRestore();
    logSpy.mockRestore();
  });

  test('parseCliArgs normalizes -h and --usage to help', () => {
    expect(hmDefiClose.parseCloseOptions(
      hmDefiClose.parseCliArgs(['-h'])
    ).help).toBe(true);

    expect(hmDefiClose.parseCloseOptions(
      hmDefiClose.parseCliArgs(['--usage'])
    ).help).toBe(true);
  });
});
