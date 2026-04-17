jest.mock('../modules/trading/hyperliquid-client', () => ({
  getAccountSnapshot: jest.fn(),
  getOpenPositions: jest.fn(),
}));

const hmDefiStatus = require('../scripts/hm-defi-status');

describe('hm-defi-status helpers', () => {
  test('parseCliArgs normalizes -h and --usage to help', () => {
    expect(hmDefiStatus.parseCliArgs(['-h']).options.get('help')).toBe(true);
    expect(hmDefiStatus.parseCliArgs(['--usage']).options.get('help')).toBe(true);
  });

  test('main prints help and exits safely', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const result = await hmDefiStatus.main(
      hmDefiStatus.parseCliArgs(['--help'])
    );

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
    expect(result).toEqual({ ok: true, help: true });

    logSpy.mockRestore();
  });
});
