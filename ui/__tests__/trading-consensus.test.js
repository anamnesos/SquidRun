'use strict';

const { evaluateConsensus, evaluateAll, actionableOnly } = require('../modules/trading/consensus');

function makeSignal(agent, direction, confidence = 0.7, ticker = 'AAPL') {
  return {
    ticker,
    direction,
    confidence,
    timeframe: '1-5 days',
    reasoning: `${agent} analysis`,
    agent,
    model: `model-${agent}`,
    timestamp: Date.now(),
  };
}

describe('Consensus Engine', () => {
  test('2-of-3 BUY consensus', () => {
    const signals = [
      makeSignal('architect', 'BUY'),
      makeSignal('builder', 'BUY'),
      makeSignal('oracle', 'HOLD'),
    ];
    const result = evaluateConsensus(signals);
    expect(result.decision).toBe('BUY');
    expect(result.consensus).toBe(true);
    expect(result.agreementCount).toBe(2);
    expect(result.agreeing).toHaveLength(2);
    expect(result.dissenting).toHaveLength(1);
    expect(result.dissenting[0].agent).toBe('oracle');
  });

  test('unanimous BUY (3-of-3)', () => {
    const signals = [
      makeSignal('architect', 'BUY'),
      makeSignal('builder', 'BUY'),
      makeSignal('oracle', 'BUY'),
    ];
    const result = evaluateConsensus(signals);
    expect(result.decision).toBe('BUY');
    expect(result.consensus).toBe(true);
    expect(result.agreementCount).toBe(3);
    expect(result.summary).toContain('UNANIMOUS');
  });

  test('2-of-3 SELL consensus', () => {
    const signals = [
      makeSignal('architect', 'SELL'),
      makeSignal('builder', 'BUY'),
      makeSignal('oracle', 'SELL'),
    ];
    const result = evaluateConsensus(signals);
    expect(result.decision).toBe('SELL');
    expect(result.consensus).toBe(true);
    expect(result.dissenting[0].agent).toBe('builder');
  });

  test('no consensus (3-way split) → HOLD', () => {
    const signals = [
      makeSignal('architect', 'BUY'),
      makeSignal('builder', 'SELL'),
      makeSignal('oracle', 'HOLD'),
    ];
    const result = evaluateConsensus(signals);
    expect(result.decision).toBe('HOLD');
    expect(result.consensus).toBe(false);
    expect(result.agreementCount).toBe(0);
  });

  test('2-of-3 HOLD consensus', () => {
    const signals = [
      makeSignal('architect', 'HOLD'),
      makeSignal('builder', 'HOLD'),
      makeSignal('oracle', 'BUY'),
    ];
    const result = evaluateConsensus(signals);
    expect(result.decision).toBe('HOLD');
    expect(result.consensus).toBe(true);
  });

  test('rejects wrong number of signals', () => {
    expect(() => evaluateConsensus([makeSignal('a', 'BUY')])).toThrow('exactly 3');
    expect(() => evaluateConsensus([])).toThrow('exactly 3');
  });

  test('rejects mismatched tickers', () => {
    const signals = [
      makeSignal('architect', 'BUY', 0.7, 'AAPL'),
      makeSignal('builder', 'BUY', 0.7, 'MSFT'),
      makeSignal('oracle', 'BUY', 0.7, 'AAPL'),
    ];
    expect(() => evaluateConsensus(signals)).toThrow('same ticker');
  });

  test('evaluateAll processes multiple tickers', () => {
    const map = new Map();
    map.set('AAPL', [
      makeSignal('architect', 'BUY', 0.7, 'AAPL'),
      makeSignal('builder', 'BUY', 0.7, 'AAPL'),
      makeSignal('oracle', 'HOLD', 0.7, 'AAPL'),
    ]);
    map.set('MSFT', [
      makeSignal('architect', 'HOLD', 0.7, 'MSFT'),
      makeSignal('builder', 'HOLD', 0.7, 'MSFT'),
      makeSignal('oracle', 'HOLD', 0.7, 'MSFT'),
    ]);
    const results = evaluateAll(map);
    expect(results).toHaveLength(2);
    expect(results[0].ticker).toBe('AAPL');
    expect(results[1].ticker).toBe('MSFT');
  });

  test('actionableOnly filters to BUY/SELL with consensus', () => {
    const results = [
      { ticker: 'AAPL', decision: 'BUY', consensus: true },
      { ticker: 'MSFT', decision: 'HOLD', consensus: true },
      { ticker: 'GOOGL', decision: 'SELL', consensus: true },
      { ticker: 'TSLA', decision: 'BUY', consensus: false },
    ];
    const actionable = actionableOnly(results);
    expect(actionable).toHaveLength(2);
    expect(actionable[0].ticker).toBe('AAPL');
    expect(actionable[1].ticker).toBe('GOOGL');
  });
});
