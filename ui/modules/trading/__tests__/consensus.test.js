'use strict';

const consensus = require('../consensus');

describe('consensus', () => {
  test('summarizes two-signal consultation quorum without overstating request cardinality', () => {
    const result = consensus.evaluateConsensus([
      {
        ticker: 'WLD/USD',
        direction: 'SELL',
        confidence: 0.68,
        reasoning: 'architect bearish',
        agent: 'architect',
        model: 'claude',
        timestamp: 1,
      },
      {
        ticker: 'WLD/USD',
        direction: 'SELL',
        confidence: 0.74,
        reasoning: 'oracle bearish',
        agent: 'oracle',
        model: 'gemini',
        timestamp: 2,
      },
    ]);

    expect(result.consensus).toBe(true);
    expect(result.agreementCount).toBe(2);
    expect(result.summary).toBe('WLD/USD: SELL — 2-signal real-agent quorum agrees');
  });
});
