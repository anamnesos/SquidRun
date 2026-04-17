'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../hyperliquid-client', () => ({
  normalizeCoinSymbol: (ticker) => String(ticker || '').replace('/USD', ''),
  createInfoClient: jest.fn(),
  getUserFees: jest.fn(),
  resolveWalletAddress: jest.fn(() => '0xfeed'),
}));

jest.mock('../signal-producer', () => ({
  produceSignals: jest.fn(),
}));

const replay = require('../hyperliquid-replay-backtest');
const hyperliquidClient = require('../hyperliquid-client');
const signalProducer = require('../signal-producer');

function buildCandles(startMs, count, intervalMs, basePrice = 100, drift = 0.2) {
  return Array.from({ length: count }, (_, index) => {
    const close = basePrice + (index * drift);
    return {
      t: startMs + (index * intervalMs),
      o: close - 0.4,
      h: close + 0.8,
      l: close - 0.8,
      c: close,
      v: 1_000 + index,
      n: 10 + index,
    };
  });
}

describe('hyperliquid historical replay backtest', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    hyperliquidClient.resolveWalletAddress.mockReturnValue('0xfeed');
  });

  test('paginates funding history beyond the 500-row API cap', async () => {
    const firstPage = Array.from({ length: 500 }, (_, index) => ({
      coin: 'BTC',
      fundingRate: '0.00001',
      premium: '0',
      time: 1_000 + index,
    }));
    const secondPage = [
      {
        coin: 'BTC',
        fundingRate: '-0.00002',
        premium: '0',
        time: 1_500,
      },
      {
        coin: 'BTC',
        fundingRate: '-0.00001',
        premium: '0',
        time: 1_501,
      },
    ];
    const client = {
      fundingHistory: jest
        .fn()
        .mockResolvedValueOnce(firstPage)
        .mockResolvedValueOnce(secondPage),
    };

    const funding = await replay.fetchFundingHistoryPaged(client, 'BTC/USD', 1_000, 2_000);

    expect(client.fundingHistory).toHaveBeenNthCalledWith(1, {
      coin: 'BTC',
      startTime: 1_000,
      endTime: 2_000,
    });
    expect(client.fundingHistory).toHaveBeenNthCalledWith(2, {
      coin: 'BTC',
      startTime: 1_500,
      endTime: 2_000,
    });
    expect(funding).toHaveLength(502);
    expect(funding[0].time).toBe(1_000);
    expect(funding[501].time).toBe(1_501);
  });

  test('summarizes actionable decision accuracy and expectancy by symbol', () => {
    const decisions = [
      {
        ticker: 'BTC/USD',
        consensus: {
          actionable: true,
          decision: 'BUY',
        },
        forward: {
          '4h': { correct: true, signedReturnPct: 0.02 },
          '24h': { correct: true, signedReturnPct: 0.05 },
        },
      },
      {
        ticker: 'BTC/USD',
        consensus: {
          actionable: true,
          decision: 'SELL',
        },
        forward: {
          '4h': { correct: false, signedReturnPct: -0.01 },
          '24h': { correct: true, signedReturnPct: 0.03 },
        },
      },
      {
        ticker: 'ETH/USD',
        consensus: {
          actionable: false,
          decision: 'HOLD',
        },
        forward: {
          '4h': { correct: null, signedReturnPct: null },
          '24h': { correct: null, signedReturnPct: null },
        },
      },
    ];

    const summary = replay.summarizeDecisions(decisions, {
      forwardHours: [4, 24],
    });

    expect(summary.overall.totalEvaluations).toBe(3);
    expect(summary.overall.actionableTrades).toBe(2);
    expect(summary.overall.accuracy['4h']).toBe(0.5);
    expect(summary.overall.accuracy['24h']).toBe(1);
    expect(summary.overall.expectancy['4h']).toBe(0.005);
    expect(summary.overall.expectancy['24h']).toBe(0.04);
    expect(summary.bySymbol).toEqual(expect.arrayContaining([
      expect.objectContaining({
        symbol: 'BTC/USD',
        actionableTrades: 2,
        accuracy: expect.objectContaining({
          '4h': 0.5,
          '24h': 1,
        }),
        grossExpectancy: expect.objectContaining({
          '4h': 0.005,
          '24h': 0.04,
        }),
      }),
      expect.objectContaining({
        symbol: 'ETH/USD',
        actionableTrades: 0,
      }),
    ]));
  });

  test('prefers net returns in headline expectancy while keeping gross expectancy visible', () => {
    const decisions = [
      {
        ticker: 'BTC/USD',
        consensus: {
          actionable: true,
          decision: 'BUY',
        },
        forward: {
          '4h': {
            correct: true,
            signedReturnPct: 0.02,
            netSignedReturnPct: 0.015,
            netSignedReturnPctByScenario: {
              base: 0.015,
              conservative: 0.012,
              harsh: 0.009,
            },
            fundingSamplesMissing: false,
          },
          '24h': {
            correct: true,
            signedReturnPct: 0.05,
            netSignedReturnPct: 0.041,
            netSignedReturnPctByScenario: {
              base: 0.041,
              conservative: 0.036,
              harsh: 0.028,
            },
            fundingSamplesMissing: false,
          },
        },
      },
    ];

    const summary = replay.summarizeDecisions(decisions, {
      forwardHours: [4, 24],
    });

    expect(summary.overall.grossExpectancy['4h']).toBe(0.02);
    expect(summary.overall.expectancy['4h']).toBe(0.015);
    expect(summary.overall.grossExpectancy['24h']).toBe(0.05);
    expect(summary.overall.expectancy['24h']).toBe(0.041);
    expect(summary.overall.sensitivity.base['24h']).toBe(0.041);
    expect(summary.overall.sensitivity.conservative['24h']).toBe(0.036);
    expect(summary.overall.sensitivity.harsh['24h']).toBe(0.028);
    expect(summary.overall.missingFundingWindows['24h']).toBe(0);
  });

  test('uses live userFees when available and records fallback reason when unavailable', async () => {
    hyperliquidClient.getUserFees
      .mockResolvedValueOnce({
        userCrossRate: '0.00033',
        userAddRate: '0.00010',
      })
      .mockRejectedValueOnce(new Error('429 Too Many Requests'));

    const live = await replay.resolveReplayCostModel({});
    const fallback = await replay.resolveReplayCostModel({});

    expect(live).toEqual(expect.objectContaining({
      takerFeeRate: 0.00033,
      makerFeeRate: 0.0001,
      assumptionSource: 'live_userFees',
      feeLookupError: null,
    }));
    expect(fallback).toEqual(expect.objectContaining({
      takerFeeRate: 0.00045,
      assumptionSource: 'fallback_default',
      feeLookupError: '429 Too Many Requests',
    }));
  });

  test('keeps the markdown verdict scoped to the replayed symbols rather than broader system proof', () => {
    const markdown = replay.buildReportMarkdown({
      runId: 'hyperliquid-replay-test',
      window: {
        start: '2026-03-01T00:00:00.000Z',
        end: '2026-04-01T00:00:00.000Z',
      },
      symbols: ['BTC/USD', 'ETH/USD'],
      config: {
        stepHours: 4,
      },
      simulationLane: 'candle_sim_plus_funding',
      costModel: {
        takerFeeRate: 0.00033,
        assumptionSource: 'live_userFees',
        feeLookupError: null,
      },
      summary: {
        overall: {
          actionableTrades: 12,
          accuracy: { '4h': 0.58, '24h': 0.61 },
          grossExpectancy: { '4h': 0.004, '24h': 0.011 },
          expectancy: { '4h': 0.002, '24h': 0.008 },
          sensitivity: {
            base: { '4h': 0.002, '24h': 0.008 },
            conservative: { '4h': 0.001, '24h': 0.005 },
            harsh: { '4h': -0.001, '24h': 0.002 },
          },
          missingFundingWindows: { '4h': 0, '24h': 0 },
        },
        bySymbol: [],
      },
    });

    expect(markdown).toContain('Tentative positive directional/cost evidence on the replayed symbols in this candle/funding lane, not broader system proof.');
    expect(markdown).toContain('Scope is only the explicitly replayed symbols shown above; default runs are majors-first sanity checks, not proof for the wider Hyperliquid basket.');
  });

  test('buildSignalInputs derives replay-time range structures from 5m/15m/1h history', () => {
    const timestamp = '2026-04-08T12:00:00.000Z';
    const timestampMs = Date.parse(timestamp);
    const dataset = new Map([
      ['AVAX/USD', {
        bars5m: Array.from({ length: 72 }, (_, index) => {
          const time = timestampMs - ((71 - index) * 5 * 60 * 1000);
          const close = index < 36 ? 20.05 : 20.95;
          return {
            timestamp: new Date(time).toISOString(),
            open: close,
            high: index < 36 ? 20.2 : 21.05,
            low: index < 36 ? 19.8 : 20.8,
            close,
            volume: 1_000 + index,
          };
        }),
        bars15m: Array.from({ length: 48 }, (_, index) => {
          const time = timestampMs - ((47 - index) * 15 * 60 * 1000);
          const touchingFloor = index % 4 === 0;
          const close = touchingFloor ? 20.12 : 20.4;
          return {
            timestamp: new Date(time).toISOString(),
            open: close,
            high: touchingFloor ? 20.35 : 20.7,
            low: touchingFloor ? 19.92 : 20.18,
            close: touchingFloor ? 20.28 : close,
            volume: 2_000 + index,
          };
        }),
        hourlyBars: Array.from({ length: 24 }, (_, index) => {
          const time = timestampMs - ((23 - index) * 60 * 60 * 1000);
          const close = 20.2 + (index * 0.01);
          return {
            timestamp: new Date(time).toISOString(),
            open: close - 0.1,
            high: 21.0,
            low: 20.0,
            close,
            volume: 5_000 + index,
          };
        }),
        dailyBars: Array.from({ length: 7 }, (_, index) => ({
          timestamp: new Date(timestampMs - ((6 - index) * 24 * 60 * 60 * 1000)).toISOString(),
          open: 19 + index * 0.1,
          high: 21 + index * 0.1,
          low: 18.8 + index * 0.1,
          close: 20 + index * 0.1,
          volume: 50_000 + index,
        })),
        fundingHistory: [],
      }],
    ]);

    const inputs = replay.buildSignalInputs(dataset, timestamp, {
      strategyMode: 'range_conviction',
      forwardHours: [4, 24],
    });

    const structure = inputs.rangeStructures.get('AVAX/USD');
    expect(structure).toEqual(expect.objectContaining({
      ok: true,
    }));
    expect(structure.floor).toBeGreaterThan(0);
    expect(structure.ceiling).toBeGreaterThan(structure.floor);
  });

  test('buildDecisionTimeline supports 15-minute cadence for range conviction replay', () => {
    const dataset = new Map([
      ['AVAX/USD', {
        bars15m: buildCandles(Date.parse('2026-04-01T00:15:00.000Z'), 80, 15 * 60 * 1000, 20, 0.01).map((bar) => ({
          timestamp: new Date(bar.t).toISOString(),
          open: bar.o,
          high: bar.h,
          low: bar.l,
          close: bar.c,
          volume: bar.v,
        })),
        hourlyBars: buildCandles(Date.parse('2026-04-01T00:00:00.000Z'), 48, 60 * 60 * 1000, 20, 0.02).map((bar) => ({
          timestamp: new Date(bar.t).toISOString(),
          open: bar.o,
          high: bar.h,
          low: bar.l,
          close: bar.c,
          volume: bar.v,
        })),
        dailyBars: buildCandles(Date.parse('2026-03-24T00:00:00.000Z'), 10, 24 * 60 * 60 * 1000, 18, 0.2).map((bar) => ({
          timestamp: new Date(bar.t).toISOString(),
          open: bar.o,
          high: bar.h,
          low: bar.l,
          close: bar.c,
          volume: bar.v,
        })),
      }],
    ]);

    const timeline = replay.buildDecisionTimeline(dataset, {
      strategyMode: 'range_conviction',
      stepMinutes: 15,
      forwardHours: [4],
    });

    expect(timeline.length).toBeGreaterThan(0);
    expect(timeline.some((timestamp) => /T\d{2}:(15|30|45):00.000Z$/.test(timestamp))).toBe(true);
  });

  test('runs replay in single-thesis range conviction mode with builder-only signals', async () => {
    const startMs = Date.parse('2026-04-01T00:00:00.000Z');
    const client = {
      candleSnapshot: jest.fn(async ({ interval }) => {
        if (interval === '5m') return buildCandles(startMs, 96, 5 * 60 * 1000, 19.9, 0.01);
        if (interval === '15m') return buildCandles(startMs + (15 * 60 * 1000), 72, 15 * 60 * 1000, 20.0, 0.015);
        if (interval === '1h') return buildCandles(startMs, 64, 60 * 60 * 1000, 20.1, 0.02);
        if (interval === '1d') return buildCandles(startMs - (7 * 24 * 60 * 60 * 1000), 12, 24 * 60 * 60 * 1000, 18.5, 0.25);
        return [];
      }),
      fundingHistory: jest.fn().mockResolvedValue([]),
    };
    hyperliquidClient.createInfoClient.mockReturnValue(client);
    signalProducer.produceSignals.mockImplementation(async (agentId, options = {}) => {
      if (agentId !== 'builder') {
        throw new Error(`unexpected agent ${agentId}`);
      }
      return (options.symbols || []).map((ticker) => ({
        ticker,
        direction: 'BUY',
        confidence: 0.83,
        reasoning: 'Range floor rejection replay test.',
        invalidationPrice: 19.5,
        takeProfitPrice: 21.8,
        leverage: 5,
        strategyMode: 'range_conviction',
        rangeStructure: options.rangeStructures?.get(ticker) || null,
      }));
    });

    const run = await replay.runHyperliquidHistoricalReplay({
      symbols: ['AVAX/USD'],
      start: '2026-04-01T00:00:00.000Z',
      end: '2026-04-03T16:00:00.000Z',
      stepMinutes: 15,
      strategyMode: 'range_conviction',
      runtimeDir: fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-replay-rc-')),
    });

    expect(run.config.strategyMode).toBe('range_conviction');
    expect(signalProducer.produceSignals).toHaveBeenCalled();
    expect(signalProducer.produceSignals.mock.calls.every(([agentId]) => agentId === 'builder')).toBe(true);
    expect(run.decisions.length).toBeGreaterThan(0);
    expect(run.decisions[0].consensus).toEqual(expect.objectContaining({
      decision: 'BUY',
      agreementCount: 1,
      actionable: true,
      actionabilityReason: 'single_thesis',
    }));
    expect(run.decisions[0].signals.builder).toEqual(expect.objectContaining({
      direction: 'BUY',
      strategyMode: 'range_conviction',
    }));
    expect(run.decisions[0].signals.architect).toBeUndefined();
    expect(run.decisions[0].signals.oracle).toBeUndefined();
    expect(run.artifacts.reportPath).toBeTruthy();
    const markdown = fs.readFileSync(run.artifacts.reportPath, 'utf8');
    expect(markdown).toContain('Strategy mode: range_conviction');
    expect(markdown).toContain('Single-thesis replay path using the builder-owned `range_conviction` lane');
    expect(markdown).toContain('Cadence: every 15m');
  });
});
