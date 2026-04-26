'use strict';

jest.mock('../executor', () => ({
  getAlpacaAccountSnapshot: jest.fn(),
  getAlpacaOpenPositions: jest.fn(),
}));

jest.mock('../ibkr-client', () => ({
  getAccount: jest.fn(),
  getPositions: jest.fn(),
}));

jest.mock('../polymarket-client', () => ({
  getBalance: jest.fn(),
  getPositions: jest.fn(),
  resolvePolymarketConfig: jest.fn(() => ({ configured: false })),
}));

jest.mock('../yield-router', () => ({
  createYieldRouter: jest.fn(() => ({
    getDeposits: jest.fn(() => []),
  })),
}));

const executor = require('../executor');
const ibkrClient = require('../ibkr-client');
const polymarketClient = require('../polymarket-client');
const yieldRouter = require('../yield-router');
const portfolioTracker = require('../portfolio-tracker');

describe('portfolio-tracker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    yieldRouter.createYieldRouter.mockReturnValue({
      getDeposits: jest.fn(() => []),
    });
  });

  test('builds a unified portfolio snapshot across Alpaca, Polymarket, DeFi, and Solana tokens', async () => {
    executor.getAlpacaAccountSnapshot.mockResolvedValue({
      equity: 10000,
      cash: 6000,
      buyingPower: 12000,
    });
    executor.getAlpacaOpenPositions.mockResolvedValue([
      {
        ticker: 'AAPL',
        shares: 10,
        avgPrice: 230,
        marketValue: 2500,
        assetClass: 'us_equity',
        raw: { unrealized_pl: 200 },
      },
      {
        ticker: 'BTC/USD',
        shares: 0.02,
        avgPrice: 70000,
        marketValue: 1500,
        assetClass: 'crypto',
        raw: { unrealized_pl: -100 },
      },
    ]);
    polymarketClient.resolvePolymarketConfig.mockReturnValue({ configured: true });
    polymarketClient.getBalance.mockResolvedValue({ available: 162, balance: 162 });
    polymarketClient.getPositions.mockResolvedValue([]);

    const snapshot = await portfolioTracker.getPortfolioSnapshot({
      persist: false,
      includeAlpaca: true,
      state: {
        peakEquity: null,
        dayStartEquity: null,
        dayStartDate: null,
      },
      defiDeposits: [
        { venue: 'Morpho', amount: 50, currentValue: 52, apy: 0.08, locked: true },
      ],
      solanaPositions: [
        { ticker: 'BONK', marketValue: 25, unrealizedPnl: 5 },
      ],
      now: '2026-03-18T20:00:00.000Z',
    });

    expect(snapshot.totalEquity).toBe(10239);
    expect(snapshot.totalCash).toBe(6162);
    expect(snapshot.liquidCapital).toBe(10187);
    expect(snapshot.lockedCapital).toBe(52);
    expect(snapshot.markets.alpaca_stocks).toMatchObject({
      equity: 2500,
      liquidCapital: 2500,
      pnl: 200,
    });
    expect(snapshot.markets.alpaca_crypto).toMatchObject({
      equity: 1500,
      liquidCapital: 1500,
      pnl: -100,
    });
    expect(snapshot.markets.polymarket).toMatchObject({
      equity: 162,
      cash: 162,
      liquidCapital: 162,
    });
    expect(snapshot.markets.defi_yield).toMatchObject({
      equity: 52,
      lockedCapital: 52,
      pnl: 2,
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
      liquidCapital: 10187,
      lockedCapital: 52,
      peakEquity: 10239,
      dayStartEquity: 10239,
    });
  });

  test('includes IBKR when explicitly requested and computes drawdown from prior state', async () => {
    executor.getAlpacaAccountSnapshot.mockResolvedValue({
      equity: 800,
      cash: 800,
      buyingPower: 1600,
    });
    executor.getAlpacaOpenPositions.mockResolvedValue([]);
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
      includeAlpaca: true,
      includeIbkr: true,
      includePolymarket: false,
      state: {
        peakEquity: 1200,
        dayStartEquity: 1100,
        dayStartDate: '2026-03-18',
      },
      now: '2026-03-18T20:00:00.000Z',
    });

    expect(snapshot.totalEquity).toBe(1000);
    expect(snapshot.markets.ibkr_global.equity).toBe(100);
    expect(snapshot.markets.cash_reserve.equity).toBe(900);
    expect(snapshot.risk.killSwitchTriggered).toBe(false);
    expect(snapshot.risk.totalDrawdownPct).toBeCloseTo(1 / 6, 6);
    expect(snapshot.risk.dailyLossPct).toBeCloseTo(100 / 1100, 6);
  });

  test('returns source errors without failing the whole snapshot', async () => {
    executor.getAlpacaAccountSnapshot.mockRejectedValue(new Error('alpaca unavailable'));
    executor.getAlpacaOpenPositions.mockResolvedValue([]);
    polymarketClient.resolvePolymarketConfig.mockReturnValue({ configured: true });
    polymarketClient.getBalance.mockRejectedValue(new Error('polymarket auth failed'));

    const snapshot = await portfolioTracker.getPortfolioSnapshot({
      persist: false,
      includeAlpaca: true,
      includePolymarket: true,
    });

    expect(snapshot.totalEquity).toBe(0);
    expect(snapshot.sourceErrors).toEqual(expect.arrayContaining([
      'alpaca: alpaca unavailable',
      'polymarket: polymarket auth failed',
    ]));
    expect(snapshot.markets.polymarket.sourceErrors).toEqual(['polymarket auth failed']);
  });

  test('loads yield deposits from the yield router into the unified portfolio view', async () => {
    executor.getAlpacaAccountSnapshot.mockResolvedValue({
      equity: 1000,
      cash: 700,
      buyingPower: 1400,
    });
    executor.getAlpacaOpenPositions.mockResolvedValue([
      {
        ticker: 'SPY',
        shares: 1,
        avgPrice: 300,
        marketValue: 300,
        assetClass: 'us_equity',
        raw: { unrealized_pl: 0 },
      },
    ]);
    yieldRouter.createYieldRouter.mockReturnValue({
      getDeposits: jest.fn(() => [
        {
          protocol: 'Morpho',
          amount: 75,
          currentValue: 78,
          apy: 0.09,
          locked: false,
          depositedAt: '2026-03-18T20:00:00.000Z',
        },
      ]),
    });

    const snapshot = await portfolioTracker.getPortfolioSnapshot({
      persist: false,
      includeAlpaca: true,
      includePolymarket: false,
    });

    expect(yieldRouter.createYieldRouter).toHaveBeenCalled();
    expect(snapshot.markets.defi_yield).toMatchObject({
      equity: 78,
      liquidCapital: 78,
      lockedCapital: 0,
      pnl: 3,
      deposits: [
        expect.objectContaining({
          venue: 'Morpho',
          currentValue: 78,
        }),
      ],
    });
    expect(snapshot.totalEquity).toBe(1078);
  });

  test('keeps Alpaca markets zeroed by default so crypto consultations do not inherit stock cash', async () => {
    const snapshot = await portfolioTracker.getPortfolioSnapshot({
      persist: false,
      includePolymarket: false,
    });

    expect(executor.getAlpacaAccountSnapshot).not.toHaveBeenCalled();
    expect(executor.getAlpacaOpenPositions).not.toHaveBeenCalled();
    expect(snapshot.markets.alpaca_stocks.equity).toBe(0);
    expect(snapshot.markets.alpaca_crypto.equity).toBe(0);
    expect(snapshot.markets.cash_reserve.equity).toBe(0);
    expect(snapshot.totalEquity).toBe(0);
  });
});
