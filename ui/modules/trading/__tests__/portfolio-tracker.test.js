'use strict';

jest.mock('../ibkr-client', () => ({
  getAccount: jest.fn(),
  getPositions: jest.fn(),
}));

const ibkrClient = require('../ibkr-client');
const portfolioTracker = require('../portfolio-tracker');

describe('portfolio-tracker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('builds a unified portfolio snapshot across IBKR and Solana tokens', async () => {
    ibkrClient.getAccount.mockResolvedValue({
      equity: 10000,
      cash: 6000,
      buyingPower: 12000,
    });
    ibkrClient.getPositions.mockResolvedValue([
      {
        ticker: 'AAPL',
        shares: 10,
        avgPrice: 230,
        marketValue: 2500,
        assetClass: 'us_equity',
        broker: 'ibkr',
        raw: { unrealized_pl: 200 },
      },
      {
        ticker: 'BTC/USD',
        shares: 0.02,
        avgPrice: 70000,
        marketValue: 1500,
        assetClass: 'crypto',
        broker: 'ibkr',
        raw: { unrealized_pl: -100 },
      },
    ]);
    const snapshot = await portfolioTracker.getPortfolioSnapshot({
      persist: false,
      includeIbkr: true,
      state: {
        peakEquity: null,
        dayStartEquity: null,
        dayStartDate: null,
      },
      solanaPositions: [
        { ticker: 'BONK', marketValue: 25, unrealizedPnl: 5 },
      ],
      now: '2026-03-18T20:00:00.000Z',
    });

    expect(snapshot.totalEquity).toBe(10025);
    expect(snapshot.totalCash).toBe(6000);
    expect(snapshot.liquidCapital).toBe(10025);
    expect(snapshot.lockedCapital).toBe(0);
    expect(snapshot.markets.ibkr_global).toMatchObject({
      equity: 4000,
      liquidCapital: 4000,
      pnl: 100,
      buyingPower: 12000,
    });
    expect(snapshot.markets.solana_tokens).toMatchObject({
      equity: 25,
      liquidCapital: 25,
      pnl: 5,
    });
    expect(snapshot.risk).toMatchObject({
      totalDrawdownPct: 0,
      dailyLossPct: 0,
      killSwitchTriggered: false,
      liquidCapital: 10025,
      lockedCapital: 0,
      peakEquity: 10025,
      dayStartEquity: 10025,
    });
  });

  test('includes IBKR when explicitly requested and computes drawdown from prior state', async () => {
    ibkrClient.getAccount.mockResolvedValue({
      equity: 200,
      cash: 100,
      buyingPower: 500,
    });
    ibkrClient.getPositions.mockResolvedValue([
      {
        ticker: '5801',
        shares: 100,
        avgPrice: 14,
        marketValue: 100,
        broker: 'ibkr',
      },
    ]);

    const snapshot = await portfolioTracker.getPortfolioSnapshot({
      persist: false,
      includeIbkr: true,
      state: {
        peakEquity: 220,
        dayStartEquity: 200,
        dayStartDate: '2026-03-18',
      },
      now: '2026-03-18T20:00:00.000Z',
    });

    expect(snapshot.totalEquity).toBe(200);
    expect(snapshot.markets.ibkr_global.equity).toBe(100);
    expect(snapshot.markets.cash_reserve.equity).toBe(100);
    expect(snapshot.risk.killSwitchTriggered).toBe(false);
    expect(snapshot.risk.totalDrawdownPct).toBeCloseTo(20 / 220, 6);
    expect(snapshot.risk.dailyLossPct).toBeCloseTo(0, 6);
  });

  test('returns source errors without failing the whole snapshot', async () => {
    ibkrClient.getAccount.mockRejectedValue(new Error('ibkr unavailable'));
    ibkrClient.getPositions.mockResolvedValue([]);

    const snapshot = await portfolioTracker.getPortfolioSnapshot({
      persist: false,
      includeIbkr: true,
    });

    expect(snapshot.totalEquity).toBe(0);
    expect(snapshot.sourceErrors).toEqual(expect.arrayContaining([
      'ibkr: ibkr unavailable',
    ]));
  });

  test('keeps broker markets opt-in so crypto consultations do not inherit stock cash', async () => {
    const snapshot = await portfolioTracker.getPortfolioSnapshot({
      persist: false,
    });

    expect(ibkrClient.getAccount).not.toHaveBeenCalled();
    expect(ibkrClient.getPositions).not.toHaveBeenCalled();
    expect(snapshot.markets.ibkr_global.equity).toBe(0);
    expect(snapshot.markets.cash_reserve.equity).toBe(0);
    expect(snapshot.totalEquity).toBe(0);
  });
});
