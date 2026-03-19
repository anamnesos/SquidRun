'use strict';

const { DEFAULT_LIMITS, checkTrade, checkKillSwitch, checkDailyPause } = require('../modules/trading/risk-engine');

function makeAccount(overrides = {}) {
  return {
    equity: 500,
    peakEquity: 500,
    dayStartEquity: 500,
    tradesToday: 0,
    openPositions: [],
    ...overrides,
  };
}

describe('Risk Engine', () => {
  describe('checkTrade', () => {
    test('approves valid BUY within limits', () => {
      const result = checkTrade(
        { ticker: 'AAPL', direction: 'BUY', price: 10, marketCap: 3_000_000_000_000 },
        makeAccount(),
      );
      expect(result.approved).toBe(true);
      expect(result.violations).toHaveLength(0);
      expect(result.maxShares).toBe(2); // 5% of $500 = $25, floor(25/10) = 2
      expect(result.stopLossPrice).toBeCloseTo(9.7); // 10 * 0.97
    });

    test('rejects penny stocks', () => {
      const result = checkTrade(
        { ticker: 'JUNK', direction: 'BUY', price: 2 },
        makeAccount(),
      );
      expect(result.approved).toBe(false);
      expect(result.violations[0]).toContain('PENNY_STOCK');
    });

    test('rejects small cap stocks', () => {
      const result = checkTrade(
        { ticker: 'SMOL', direction: 'BUY', price: 10, marketCap: 500_000_000 },
        makeAccount(),
      );
      expect(result.approved).toBe(false);
      expect(result.violations[0]).toContain('SMALL_CAP');
    });

    test('rejects shorting (selling stock we do not own)', () => {
      const result = checkTrade(
        { ticker: 'AAPL', direction: 'SELL', price: 200 },
        makeAccount(),
      );
      expect(result.approved).toBe(false);
      expect(result.violations[0]).toContain('SHORT_PROHIBITED');
    });

    test('allows selling stock we own', () => {
      const result = checkTrade(
        { ticker: 'AAPL', direction: 'SELL', price: 200 },
        makeAccount({ openPositions: [{ ticker: 'AAPL', shares: 1 }] }),
      );
      expect(result.approved).toBe(true);
    });

    test('rejects when max trades per day reached', () => {
      const result = checkTrade(
        { ticker: 'AAPL', direction: 'BUY', price: 10 },
        makeAccount({ tradesToday: 3 }),
      );
      expect(result.approved).toBe(false);
      expect(result.violations[0]).toContain('MAX_TRADES');
    });

    test('rejects when max open positions reached', () => {
      const result = checkTrade(
        { ticker: 'NVDA', direction: 'BUY', price: 10 },
        makeAccount({
          openPositions: [
            { ticker: 'AAPL' },
            { ticker: 'MSFT' },
            { ticker: 'GOOGL' },
          ],
        }),
      );
      expect(result.approved).toBe(false);
      expect(result.violations[0]).toContain('MAX_POSITIONS');
    });

    test('rejects when position too small to buy 1 share', () => {
      const result = checkTrade(
        { ticker: 'BRK.A', direction: 'BUY', price: 700_000 },
        makeAccount(),
      );
      expect(result.approved).toBe(false);
      expect(result.violations[0]).toContain('POSITION_TOO_SMALL');
    });
  });

  describe('checkKillSwitch', () => {
    test('does not trigger within limits', () => {
      const result = checkKillSwitch(makeAccount({ equity: 450, peakEquity: 500 }));
      expect(result.triggered).toBe(false);
      expect(result.drawdownPct).toBeCloseTo(0.10);
    });

    test('triggers at 20% drawdown', () => {
      const result = checkKillSwitch(makeAccount({ equity: 400, peakEquity: 500 }));
      expect(result.triggered).toBe(true);
      expect(result.drawdownPct).toBeCloseTo(0.20);
      expect(result.message).toContain('KILL SWITCH');
    });

    test('triggers beyond 20% drawdown', () => {
      const result = checkKillSwitch(makeAccount({ equity: 350, peakEquity: 500 }));
      expect(result.triggered).toBe(true);
    });

    test('accepts a unified portfolio snapshot shape', () => {
      const result = checkKillSwitch({
        totalEquity: 900,
        positions: [{ ticker: 'AAPL', shares: 2 }],
        risk: {
          peakEquity: 1200,
          dayStartEquity: 1100,
        },
      });
      expect(result.triggered).toBe(true);
      expect(result.drawdownPct).toBeCloseTo(0.25);
    });
  });

  describe('checkDailyPause', () => {
    test('does not pause within limits', () => {
      const result = checkDailyPause(makeAccount({ equity: 460, dayStartEquity: 500 }));
      expect(result.paused).toBe(false);
    });

    test('pauses at 10% daily loss', () => {
      const result = checkDailyPause(makeAccount({ equity: 450, dayStartEquity: 500 }));
      expect(result.paused).toBe(true);
      expect(result.message).toContain('DAILY PAUSE');
    });

    test('reads daily loss from a portfolio snapshot risk block', () => {
      const result = checkDailyPause({
        totalEquity: 960,
        positions: [{ ticker: 'BTC/USD', shares: 0.05 }],
        risk: {
          peakEquity: 1000,
          dayStartEquity: 1000,
        },
      });
      expect(result.paused).toBe(false);
      expect(result.dayLossPct).toBeCloseTo(0.04);
    });
  });
});
