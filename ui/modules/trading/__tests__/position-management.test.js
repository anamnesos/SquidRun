'use strict';

const {
  buildPositionManagementContext,
  positionManagement,
} = require('../position-management');

describe('position-management contract', () => {
  test('builds a v2 management context for live positions', () => {
    const context = buildPositionManagementContext({
      checkedAt: '2026-04-03T20:00:00.000Z',
      positions: [
        { coin: 'ETH', size: -1, side: 'short', entryPx: 2100, markPrice: 2000 },
      ],
    }, {}, {});

    expect(context).toEqual(expect.objectContaining({
      contractVersion: 2,
      ownerModel: {
        strategicOwner: 'position_management',
        emergencyOwner: 'supervisor_risk',
      },
      portfolio_state: expect.objectContaining({
        managedTickers: ['ETH/USD'],
      }),
    }));
  });

  test('closes a position when consensus strongly invalidates the thesis', () => {
    const plan = positionManagement({
      positions: [
        { coin: 'ETH', size: -1, side: 'short', entryPx: 2100, markPrice: 2000, unrealizedPnl: 100 },
      ],
    }, {
      results: [
        { ticker: 'ETH/USD', decision: 'BUY', confidence: 0.82 },
      ],
    }, {});

    expect(plan.directives).toEqual([
      expect.objectContaining({
        ticker: 'ETH/USD',
        action: 'close',
        executable: true,
        managementIntent: 'invalidate_thesis',
        owner: 'position_management',
        thesisState: 'invalidated',
      }),
    ]);
    expect(plan.summary.byIntent.invalidate_thesis).toBe(1);
  });

  test('hands critical risk states back to the supervisor loop', () => {
    const plan = positionManagement({
      positions: [
        { coin: 'BTC', size: 0.1, side: 'long', entryPx: 85000, markPrice: 83000, drawdownFromPeakPct: 0.55, warningLevel: 'critical' },
      ],
    }, {
      results: [
        { ticker: 'BTC/USD', decision: 'BUY', confidence: 0.77 },
      ],
    }, {});

    expect(plan.directives).toEqual([
      expect.objectContaining({
        ticker: 'BTC/USD',
        action: 'risk_loop_owner',
        executable: false,
        owner: 'supervisor_risk',
        managementIntent: 'handoff_risk_loop',
      }),
    ]);
  });

  test('tightens stops when profit giveback risk is rising and a better stop exists', () => {
    const plan = positionManagement({
      positions: [
        { coin: 'ETH', size: 1, side: 'long', entryPx: 2000, markPrice: 2200, unrealizedPnl: 200, peakUnrealizedPnl: 240, warningLevel: 'urgent' },
      ],
    }, {
      results: [
        { ticker: 'ETH/USD', decision: 'BUY', confidence: 0.71 },
      ],
    }, {});

    expect(plan.directives).toEqual([
      expect.objectContaining({
        ticker: 'ETH/USD',
        action: 'tighten_stop',
        executable: true,
        managementIntent: 'protect_gain',
        proposedStopLossPrice: expect.any(Number),
      }),
    ]);
  });

  test('de-risks profitable positions under event veto pressure instead of adding', () => {
    const plan = positionManagement({
      positions: [
        { coin: 'LINK', size: 10, side: 'long', entryPx: 12, markPrice: 14, unrealizedPnl: 20, peakUnrealizedPnl: 24 },
      ],
    }, {
      eventVeto: { decision: 'VETO' },
      results: [
        { ticker: 'LINK/USD', decision: 'BUY', confidence: 0.74 },
      ],
    }, {
      approvedTrades: [
        { ticker: 'LINK/USD', riskCheck: { approved: true, maxShares: 5 } },
      ],
    });

    expect(plan.directives).toEqual([
      expect.objectContaining({
        ticker: 'LINK/USD',
        action: 'reduce',
        executable: false,
        managementIntent: 'de_risk',
        marketPressure: expect.objectContaining({
          eventDecision: 'VETO',
          additiveBrake: true,
        }),
      }),
    ]);
  });

  test('keeps additive decisions advisory when the thesis stays aligned and no brake is active', () => {
    const plan = positionManagement({
      positions: [
        { coin: 'SOL', size: -2, side: 'short', entryPx: 140, markPrice: 132, unrealizedPnl: 16 },
      ],
    }, {
      results: [
        { ticker: 'SOL/USD', decision: 'SELL', confidence: 0.79 },
      ],
      eventVeto: { decision: 'CLEAR' },
      macroRisk: { regime: 'red', constraints: { allowLongs: false } },
    }, {
      approvedTrades: [
        { ticker: 'SOL/USD', riskCheck: { approved: true, maxShares: 1 } },
      ],
    });

    expect(plan.directives).toEqual([
      expect.objectContaining({
        ticker: 'SOL/USD',
        action: 'add',
        executable: false,
        managementIntent: 'scale_winner',
      }),
    ]);
    expect(plan.managedTickers).toEqual(['SOL/USD']);
  });
});
