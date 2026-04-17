'use strict';

const {
  CRISIS_UNIVERSE,
  CRISIS_TYPES,
  buildBrokerCapabilityPayload,
  deriveCrisisRiskLimits,
  estimateCrisisBookExposure,
  getCrisisUniverse,
  resolveCrisisUniverse,
  validateCrisisSignalCapability,
} = require('../crisis-mode');

describe('crisis-mode helpers', () => {
  test('derives phase 1 crisis limits from baseline limits', () => {
    const limits = deriveCrisisRiskLimits({
      maxPositionPct: 0.05,
      maxOpenPositions: 5,
    });

    expect(limits.maxPositionPct).toBe(0.025);
    expect(limits.maxOpenPositions).toBe(3);
    expect(limits.crisisBookPct).toBe(0.08);
  });

  test('builds broker capability payload and marks tradable phase 1 instruments', () => {
    const payload = buildBrokerCapabilityPayload({
      account: {
        shorting_enabled: true,
        options_trading_level: 3,
      },
      assets: new Map([
        ['SQQQ', { tradable: true, shortable: true, easy_to_borrow: true }],
        ['BITI', { tradable: true, shortable: false, easy_to_borrow: false }],
      ]),
    });

    expect(payload.account.shortingEnabled).toBe(true);
    expect(payload.instruments.SQQQ.phase1Executable).toBe(true);
    expect(payload.supportedUniverse).toEqual(expect.arrayContaining(['SQQQ', 'BITI']));
  });

  test('validates crisis BUY signals against broker capabilities', () => {
    const brokerCapabilities = buildBrokerCapabilityPayload({
      assets: new Map(CRISIS_UNIVERSE.map((ticker) => [ticker, { tradable: ticker !== 'UVXY' }])),
    });

    expect(validateCrisisSignalCapability({
      ticker: 'SQQQ',
      direction: 'BUY',
    }, brokerCapabilities, {
      regime: 'stay_cash',
      strategyMode: 'crisis',
      constraints: { crisisUniverse: getCrisisUniverse() },
    })).toEqual(expect.objectContaining({ ok: true }));

    expect(validateCrisisSignalCapability({
      ticker: 'UVXY',
      direction: 'BUY',
    }, brokerCapabilities, {
      regime: 'stay_cash',
      strategyMode: 'crisis',
      constraints: { crisisUniverse: getCrisisUniverse() },
    })).toEqual(expect.objectContaining({ ok: false }));
  });

  test('allows Hyperliquid crypto SELL signals during crisis mode', () => {
    expect(validateCrisisSignalCapability({
      ticker: 'ETH/USD',
      direction: 'SELL',
      assetClass: 'crypto',
      broker: 'hyperliquid',
    }, null, {
      regime: 'stay_cash',
      strategyMode: 'crisis',
    })).toEqual(expect.objectContaining({
      ok: true,
      reason: 'hyperliquid_crypto_short_allowed',
    }));
  });

  test('estimates current crisis book exposure from open positions', () => {
    const exposure = estimateCrisisBookExposure({
      openPositions: [
        { ticker: 'SQQQ', marketValue: 1200 },
        { ticker: 'XLE', shares: 10, avgPrice: 90 },
        { ticker: 'AAPL', marketValue: 5000 },
      ],
    });

    expect(exposure).toBe(2100);
  });

  test('resolves deflationary crisis universe with TLT and without XLE', () => {
    const universe = resolveCrisisUniverse(CRISIS_TYPES.DEFLATIONARY);

    expect(universe).toContain('TLT');
    expect(universe).not.toContain('XLE');
    expect(getCrisisUniverse({ crisisType: CRISIS_TYPES.DEFLATIONARY })).toEqual(expect.arrayContaining(['TLT', 'SQQQ']));
  });
});
