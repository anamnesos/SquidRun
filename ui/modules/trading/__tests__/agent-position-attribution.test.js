'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const attribution = require('../agent-position-attribution');

describe('agent-position-attribution', () => {
  let tempDir;
  let statePath;
  let predictionStatePath;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-agent-position-attribution-'));
    statePath = path.join(tempDir, 'agent-position-attribution.json');
    predictionStatePath = path.join(tempDir, 'agent-attribution-state.json');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('resolveAgentPositionOwnership falls back to recent architect predictions for live crypto positions', () => {
    fs.writeFileSync(predictionStatePath, JSON.stringify({
      pendingPredictions: [
        {
          agentId: 'builder',
          ticker: 'APT/USD',
          assetClass: 'crypto',
          timestamp: '2026-04-19T09:02:28.177Z',
        },
        {
          agentId: 'architect',
          ticker: 'APT/USD',
          assetClass: 'crypto',
          timestamp: '2026-04-19T09:02:27.737Z',
        },
      ],
    }, null, 2));

    const result = attribution.resolveAgentPositionOwnership([
      { ticker: 'APT/USD', coin: 'APT' },
    ], {
      statePath,
      attributionStatePath: predictionStatePath,
      nowMs: new Date('2026-04-19T09:15:00.000Z').getTime(),
      lookbackMs: 2 * 60 * 60 * 1000,
    });

    expect(result.tickers).toEqual(['APT/USD']);
    expect(result.ownersByTicker['APT/USD']).toBe('architect');
  });

  test('upsertOpenPosition and recordClosedPosition persist durable ownership state', () => {
    attribution.upsertOpenPosition({
      ticker: 'AAVE/USD',
      agentId: 'architect',
      direction: 'LONG',
      entryPrice: 102.31,
      currentSize: 9.75,
      initialSize: 9.75,
      marginUsd: 100,
      leverage: 10,
    }, { statePath });

    let state = attribution.loadPositionAttributionState({ statePath });
    expect(state.positions['AAVE/USD']).toEqual(expect.objectContaining({
      ticker: 'AAVE/USD',
      agentId: 'architect',
      currentSize: 9.75,
    }));

    attribution.recordClosedPosition({
      ticker: 'AAVE/USD',
      agentId: 'architect',
      exitPrice: 105.16,
      closedSize: 9.75,
    }, { statePath });

    state = attribution.loadPositionAttributionState({ statePath });
    expect(state.positions['AAVE/USD']).toBeUndefined();
    expect(state.closedPositions).toEqual([
      expect.objectContaining({
        ticker: 'AAVE/USD',
        agentId: 'architect',
        closedSize: 9.75,
        exitPrice: 105.16,
      }),
    ]);
  });

  test('resolveTrackedAgentAssets returns persisted live agent tickers', () => {
    attribution.upsertOpenPosition({
      ticker: 'APT/USD',
      agentId: 'architect',
      currentSize: 121,
    }, { statePath });

    expect(attribution.resolveTrackedAgentAssets({ statePath })).toEqual(['APT/USD']);
  });

  test('reconcilePositionAttributionWithLivePositions quarantines stale entries and creates manual live records', () => {
    fs.writeFileSync(statePath, JSON.stringify({
      version: 2,
      positions: {
        'AVAX/USD': {
          ticker: 'AVAX/USD',
          agentId: 'architect',
          direction: 'SHORT',
          entryPrice: 9.2,
          currentSize: 12,
        },
        'ETH/USD': {
          ticker: 'ETH/USD',
          agentId: 'oracle',
          direction: 'SHORT',
          entryPrice: 2340,
          currentSize: 0.3,
          strategyLane: 'range_conviction',
        },
      },
      closedPositions: [],
      quarantinedPositions: [],
    }, null, 2));

    const summary = attribution.reconcilePositionAttributionWithLivePositions([
      {
        coin: 'ETH',
        size: -0.4,
        entryPx: 2331,
        liquidationPx: 2500,
        markPrice: 2328,
      },
      {
        coin: 'AXS',
        size: -25,
        entryPx: 2.7,
        liquidationPx: 3.1,
        markPrice: 2.74,
      },
    ], {
      statePath,
      walletAddress: '0xabc',
      nowIso: '2026-04-25T23:55:00.000Z',
    });

    expect(summary).toEqual(expect.objectContaining({
      liveCount: 2,
      updatedCount: 1,
      createdCount: 1,
      quarantinedCount: 1,
      updated: ['ETH/USD'],
      created: ['AXS/USD'],
      quarantined: ['AVAX/USD'],
    }));

    const state = attribution.loadPositionAttributionState({ statePath });
    expect(state.positions['AVAX/USD']).toBeUndefined();
    expect(state.quarantinedPositions).toEqual([
      expect.objectContaining({
        ticker: 'AVAX/USD',
        quarantineReason: 'not_in_live_hyperliquid_snapshot',
      }),
    ]);
    expect(state.positions['ETH/USD']).toEqual(expect.objectContaining({
      agentId: 'oracle',
      strategyLane: 'range_conviction',
      currentSize: 0.4,
      liquidationPx: 2500,
      lastLiveSeenAt: '2026-04-25T23:55:00.000Z',
    }));
    expect(state.positions['AXS/USD']).toEqual(expect.objectContaining({
      agentId: '',
      source: 'live_snapshot_reconciliation',
      strategyLane: 'manual_unattributed',
      direction: 'SHORT',
      currentSize: 25,
      liquidationPx: 3.1,
      walletAddress: '0xabc',
    }));
  });

  test('reconcilePositionAttributionWithLivePositions treats empty live snapshots over existing attributions as stale', () => {
    fs.writeFileSync(statePath, JSON.stringify({
      version: 2,
      positions: {
        'HYPER/USD': {
          ticker: 'HYPER/USD',
          agentId: 'architect',
          direction: 'SHORT',
          entryPrice: 0.15374,
          currentSize: 11903,
        },
      },
      closedPositions: [],
      quarantinedPositions: [],
    }, null, 2));

    const summary = attribution.reconcilePositionAttributionWithLivePositions([], {
      statePath,
      walletAddress: '0xabc',
      nowIso: '2026-04-26T00:12:00.000Z',
    });

    expect(summary).toEqual(expect.objectContaining({
      ok: false,
      skipped: true,
      reason: 'empty_live_snapshot_with_existing_attributions',
      liveCount: 0,
      previousOpenCount: 1,
      previousOpenTickers: ['HYPER/USD'],
      quarantinedCount: 0,
    }));

    const state = attribution.loadPositionAttributionState({ statePath });
    expect(state.positions['HYPER/USD']).toEqual(expect.objectContaining({
      direction: 'SHORT',
      currentSize: 11903,
    }));
    expect(state.quarantinedPositions).toEqual([]);
  });
});
