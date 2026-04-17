'use strict';

const consensusSizer = require('../consensus-sizer');

function buildConsensus(overrides = {}) {
  return {
    ticker: 'BTC/USD',
    decision: 'BUY',
    consensus: true,
    agreeing: [
      { agent: 'architect', confidence: 0.86 },
      { agent: 'builder', confidence: 0.82 },
    ],
    dissenting: [
      { agent: 'oracle', confidence: 0.41 },
    ],
    ...overrides,
  };
}

describe('consensus-sizer', () => {
  test('shrinks position size when event veto is active for the asset', () => {
    const result = consensusSizer.sizeConsensusTrade({
      consensus: buildConsensus(),
      mechanical: { mechanicalDirectionBias: 'bullish', tradeFlag: 'trade' },
      eventVeto: { decision: 'VETO', affectedAssets: ['BTC/USD'], eventSummary: 'major event' },
    });

    expect(result.bucket).toBe('tiny');
    expect(result.sizeMultiplier).toBe(0.25);
    expect(result.reasons).toEqual(expect.arrayContaining([expect.stringContaining('event_veto:'), 'event_veto']));
  });

  test('returns tiny when event caution or mechanical watch is active', () => {
    const result = consensusSizer.sizeConsensusTrade({
      consensus: buildConsensus(),
      mechanical: { mechanicalDirectionBias: 'bullish', tradeFlag: 'watch' },
      eventVeto: { decision: 'CAUTION', affectedAssets: ['BTC/USD'] },
    });

    expect(result.bucket).toBe('tiny');
    expect(result.reasons).toEqual(expect.arrayContaining(['event_caution', 'mechanical_watch']));
  });

  test('uses degraded event veto sizing when live news is blind', () => {
    const result = consensusSizer.sizeConsensusTrade({
      consensus: buildConsensus(),
      mechanical: { mechanicalDirectionBias: 'bullish', tradeFlag: 'trade' },
      eventVeto: { decision: 'DEGRADED', affectedAssets: ['BTC/USD'], sizeMultiplier: 0.5 },
    });

    expect(result.bucket).toBe('tiny');
    expect(result.sizeMultiplier).toBe(0.5);
    expect(result.reasons).toEqual(expect.arrayContaining(['event_degraded']));
  });

  test('returns normal for aligned consensus with no brake', () => {
    const result = consensusSizer.sizeConsensusTrade({
      consensus: buildConsensus({
        agreeing: [
          { agent: 'architect', confidence: 0.92 },
          { agent: 'builder', confidence: 0.91 },
          { agent: 'oracle', confidence: 0.89 },
        ],
        dissenting: [],
        agreementCount: 3,
      }),
      mechanical: { mechanicalDirectionBias: 'bullish', tradeFlag: 'trade' },
      eventVeto: { decision: 'CLEAR', affectedAssets: [] },
    });

    expect(result.bucket).toBe('normal');
  });

  test('applies tiny bucket by reducing approved size', () => {
    const resized = consensusSizer.applySizeBucketToRiskCheck({
      approved: true,
      violations: [],
      maxShares: 3,
      positionNotional: 300,
      margin: 60,
      stopLossPrice: 90,
    }, 'tiny', 'crypto');

    expect(resized.approved).toBe(true);
    expect(resized.maxShares).toBeCloseTo(0.99, 6);
    expect(resized.positionNotional).toBeCloseTo(99, 6);
    expect(resized.margin).toBeCloseTo(19.8, 6);
  });

  test('applies explicit degraded event multiplier when present', () => {
    const resized = consensusSizer.applySizeBucketToRiskCheck({
      approved: true,
      violations: [],
      maxShares: 2,
      stopLossPrice: 90,
    }, 'tiny', 'crypto', 0.5);

    expect(resized.approved).toBe(true);
    expect(resized.maxShares).toBeCloseTo(1, 6);
  });

  test('blocks no-consensus trades immediately', () => {
    const result = consensusSizer.sizeConsensusTrade({
      consensus: buildConsensus({
        decision: 'HOLD',
        consensus: false,
      }),
      eventVeto: { decision: 'CLEAR' },
    });

    expect(result.bucket).toBe('block');
  });

  test('blocks a consensus-approved trade when multi-timeframe decision state blocks it', () => {
    const result = consensusSizer.sizeConsensusTrade({
      consensus: buildConsensus({
        decision: 'BUY',
      }),
      mechanical: { mechanicalDirectionBias: 'bullish', tradeFlag: 'trade' },
      eventVeto: { decision: 'CLEAR' },
      nativeSignals: {
        multiTimeframe: {
          decisionState: {
            decision: 'BUY',
            status: 'block',
            sizeMultiplier: 0,
            reasons: ['BUY blocked because 4h and/or daily trends are leaning the other way.'],
          },
        },
      },
    });

    expect(result.bucket).toBe('block');
    expect(result.reasons).toEqual(expect.arrayContaining(['mtf_block']));
  });

  test('scales size down when multi-timeframe decision state downgrades the trade', () => {
    const result = consensusSizer.sizeConsensusTrade({
      consensus: buildConsensus({
        decision: 'SELL',
      }),
      mechanical: { mechanicalDirectionBias: 'bearish', tradeFlag: 'trade' },
      eventVeto: { decision: 'CLEAR' },
      nativeSignals: {
        multiTimeframe: {
          decisionState: {
            decision: 'SELL',
            status: 'downgrade',
            sizeMultiplier: 0.6,
            reasons: ['SELL has higher-timeframe backing, but 1h is fighting the move.'],
          },
        },
      },
    });

    expect(result.bucket).toBe('tiny');
    expect(result.sizeMultiplier).toBe(0.6);
    expect(result.reasons).toEqual(expect.arrayContaining(['mtf_downgrade']));
  });

  test('uses the tighter of the event-veto and multi-timeframe size multipliers', () => {
    const result = consensusSizer.sizeConsensusTrade({
      consensus: buildConsensus({
        decision: 'SELL',
      }),
      mechanical: { mechanicalDirectionBias: 'bearish', tradeFlag: 'trade' },
      eventVeto: { decision: 'VETO', affectedAssets: ['BTC/USD'], sizeMultiplier: 0.25 },
      nativeSignals: {
        multiTimeframe: {
          decisionState: {
            decision: 'SELL',
            status: 'downgrade',
            sizeMultiplier: 0.6,
            reasons: ['SELL has higher-timeframe backing, but 1h is fighting the move.'],
          },
        },
      },
    });

    expect(result.bucket).toBe('tiny');
    expect(result.sizeMultiplier).toBe(0.25);
    expect(result.reasons).toEqual(expect.arrayContaining(['event_veto', 'mtf_downgrade']));
  });

  test('exposes the applied size multiplier for downstream macro capping', () => {
    expect(consensusSizer.resolveAppliedSizeMultiplier('normal', 'crypto', null)).toBe(1);
    expect(consensusSizer.resolveAppliedSizeMultiplier('tiny', 'crypto', null)).toBeCloseTo(0.33, 6);
    expect(consensusSizer.resolveAppliedSizeMultiplier('tiny', 'crypto', 0.25)).toBe(0.25);
  });
});
