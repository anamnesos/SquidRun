'use strict';

jest.mock('../polymarket-scanner', () => ({
  getMarketContext: jest.fn((market) => ({
    conditionId: market.conditionId,
    question: market.question,
    category: market.category,
    currentPrices: market.currentPrices,
    volume24h: market.volume24h,
    liquidity: market.liquidity,
    resolutionDate: market.resolutionDate,
    daysToResolution: market.daysToResolution,
    spread: market.spread?.max ?? market.spread,
  })),
}));

const {
  assessMarket,
  produceSignals,
  buildConsensus,
} = require('../polymarket-signals');

describe('polymarket-signals', () => {
  const market = {
    conditionId: 'market-1',
    question: 'Will BTC close above $120k by June 30?',
    category: 'crypto',
    currentPrices: { yes: 0.61, no: 0.39 },
    volume24h: 54000,
    liquidity: 125000,
    resolutionDate: '2026-04-15T00:00:00.000Z',
    daysToResolution: 28,
    spread: { max: 0.02 },
  };

  test('assessMarket returns a bounded probability estimate with reasoning', () => {
    const signal = assessMarket('builder', {
      conditionId: market.conditionId,
      question: market.question,
      category: market.category,
      currentPrices: market.currentPrices,
      liquidity: market.liquidity,
      resolutionDate: market.resolutionDate,
      daysToResolution: market.daysToResolution,
      spread: 0.02,
    });

    expect(signal).toMatchObject({
      conditionId: 'market-1',
      agent: 'builder',
      marketPrice: 0.61,
    });
    expect(signal.probability).toBeGreaterThan(0);
    expect(signal.probability).toBeLessThan(1);
    expect(signal.confidence).toBeGreaterThanOrEqual(0.4);
    expect(signal.reasoning).toContain('Will BTC close above $120k by June 30?');
  });

  test('produceSignals can batch assessments for all three agents', () => {
    const signalsByAgent = produceSignals([market], {
      agentIds: ['architect', 'builder', 'oracle'],
    });

    expect(Array.from(signalsByAgent.keys())).toEqual(['architect', 'builder', 'oracle']);
    expect(signalsByAgent.get('architect')).toHaveLength(1);
    expect(signalsByAgent.get('builder')[0].conditionId).toBe('market-1');
    expect(signalsByAgent.get('oracle')[0].agent).toBe('oracle');
  });

  test('buildConsensus returns BUY_YES when two of three signals clear the edge threshold', () => {
    const result = buildConsensus([
      { conditionId: 'market-1', probability: 0.75, confidence: 0.87, marketPrice: 0.61, agent: 'architect' },
      { conditionId: 'market-1', probability: 0.78, confidence: 0.85, marketPrice: 0.61, agent: 'builder' },
      { conditionId: 'market-1', probability: 0.58, confidence: 0.72, marketPrice: 0.61, agent: 'oracle' },
    ]);

    expect(result).toMatchObject({
      conditionId: 'market-1',
      decision: 'BUY_YES',
      consensus: true,
      agreementCount: 2,
    });
    expect(result.summary).toContain('BUY YES');
  });

  test('buildConsensus keeps borderline edges on HOLD when confidence is too low', () => {
    const result = buildConsensus([
      { conditionId: 'market-1', probability: 0.69, confidence: 0.51, marketPrice: 0.61, agent: 'architect' },
      { conditionId: 'market-1', probability: 0.7, confidence: 0.5, marketPrice: 0.61, agent: 'builder' },
      { conditionId: 'market-1', probability: 0.68, confidence: 0.49, marketPrice: 0.61, agent: 'oracle' },
    ]);

    expect(result.decision).toBe('HOLD');
    expect(result.consensus).toBe(false);
    expect(result.threshold).toBeGreaterThan(0.08);
  });
});
