'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const attribution = require('../agent-attribution');

describe('agent-attribution', () => {
  let tempDir;
  let statePath;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-agent-attribution-'));
    statePath = path.join(tempDir, 'agent-attribution-state.json');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('records predictions, settles outcomes, and keeps stats asset-class specific', () => {
    attribution.recordPrediction('architect', 'BTC/USD', 'BUY', 0.8, '2026-03-18T18:00:00.000Z', {
      statePath,
      assetClass: 'crypto',
      marketType: 'crypto',
    });
    attribution.recordPrediction('builder', 'BTC/USD', 'SELL', 0.7, '2026-03-18T18:00:00.000Z', {
      statePath,
      assetClass: 'crypto',
      marketType: 'crypto',
    });
    attribution.recordPrediction('builder', 'AAPL', 'BUY', 0.9, '2026-03-18T18:05:00.000Z', {
      statePath,
      assetClass: 'us_equity',
      marketType: 'stocks',
    });

    const cryptoOutcome = attribution.recordOutcome('BTC/USD', 'BUY', 0.12, '2026-03-18T20:00:00.000Z', {
      statePath,
      assetClass: 'crypto',
      marketType: 'crypto',
    });
    const equityOutcome = attribution.recordOutcome('AAPL', 'BUY', 0.05, '2026-03-18T20:30:00.000Z', {
      statePath,
      assetClass: 'us_equity',
      marketType: 'stocks',
    });

    expect(cryptoOutcome.settled).toHaveLength(2);
    expect(equityOutcome.settled).toHaveLength(1);
    expect(attribution.getPendingPredictions({ statePath })).toHaveLength(0);

    expect(attribution.getAgentStats('builder', {
      statePath,
      assetClass: 'crypto',
    })).toMatchObject({
      agentId: 'builder',
      totalPredictions: 1,
      calledCorrectly: 0,
      winRate: 0,
    });
    expect(attribution.getAgentStats('builder', {
      statePath,
      assetClass: 'us_equity',
    })).toMatchObject({
      agentId: 'builder',
      totalPredictions: 1,
      calledCorrectly: 1,
      winRate: 1,
    });
  });

  test('upserts the latest pending prediction for the same agent, ticker, and market bucket', () => {
    attribution.recordPrediction('oracle', 'SOL/USD', 'BUY', 0.4, '2026-03-18T18:00:00.000Z', {
      statePath,
      assetClass: 'crypto',
    });
    attribution.recordPrediction('oracle', 'SOL/USD', 'SELL', 0.9, '2026-03-18T18:30:00.000Z', {
      statePath,
      assetClass: 'crypto',
    });

    expect(attribution.getPendingPredictions({ statePath })).toEqual([
      expect.objectContaining({
        agentId: 'oracle',
        ticker: 'SOL/USD',
        direction: 'SELL',
        confidence: 0.9,
      }),
    ]);
  });

  test('builds a leaderboard ranked by weighted score within a market bucket', () => {
    attribution.recordPrediction('architect', 'ETH/USD', 'BUY', 0.9, '2026-03-18T18:00:00.000Z', {
      statePath,
      assetClass: 'crypto',
    });
    attribution.recordPrediction('builder', 'ETH/USD', 'BUY', 0.5, '2026-03-18T18:00:00.000Z', {
      statePath,
      assetClass: 'crypto',
    });
    attribution.recordPrediction('oracle', 'ETH/USD', 'SELL', 0.8, '2026-03-18T18:00:00.000Z', {
      statePath,
      assetClass: 'crypto',
    });

    attribution.recordOutcome('ETH/USD', 'BUY', 0.1, '2026-03-18T20:00:00.000Z', {
      statePath,
      assetClass: 'crypto',
    });

    const leaderboard = attribution.getLeaderboard({
      statePath,
      assetClass: 'crypto',
    });

    expect(leaderboard.map((entry) => entry.agentId)).toEqual(['architect', 'builder', 'oracle']);
    expect(leaderboard[0]).toMatchObject({
      agentId: 'architect',
      calledCorrectly: 1,
      totalPredictions: 1,
    });
    expect(leaderboard[2]).toMatchObject({
      agentId: 'oracle',
      calledCorrectly: 0,
      totalPredictions: 1,
    });
  });
});
