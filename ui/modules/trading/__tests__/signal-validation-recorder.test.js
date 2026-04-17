'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

let mockCandleSnapshot = jest.fn();

jest.mock('../hyperliquid-client', () => ({
  createInfoClient: jest.fn(() => ({
    candleSnapshot: (...args) => mockCandleSnapshot(...args),
  })),
  normalizeCoinSymbol: jest.fn((ticker) => String(ticker || '').replace('/USD', '')),
}));

const recorder = require('../signal-validation-recorder');

describe('signal validation recorder', () => {
  let tempDir;
  let candidateLogPath;
  let settlementLogPath;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-signal-validation-'));
    candidateLogPath = path.join(tempDir, 'trading-candidate-events.jsonl');
    settlementLogPath = path.join(tempDir, 'trading-candidate-settlements.jsonl');
    mockCandleSnapshot = jest.fn().mockResolvedValue([
      {
        t: Date.parse('2026-04-01T01:00:00.000Z'),
        c: '1990',
      },
      {
        t: Date.parse('2026-04-01T04:00:00.000Z'),
        c: '1950',
      },
      {
        t: Date.parse('2026-04-02T00:00:00.000Z'),
        c: '1880',
      },
    ]);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('settles due crypto candidate records into settlement log', async () => {
    recorder.appendValidationRecords([
      {
        validationId: 'val-1',
        ticker: 'ETH/USD',
        assetClass: 'crypto',
        observedAt: '2026-04-01T00:00:00.000Z',
        recordedAt: '2026-04-01T00:00:05.000Z',
        referencePrice: 2000,
        decision: 'SELL',
        status: 'approved',
        signalsByAgent: {
          architect: { direction: 'SELL', confidence: 0.8 },
        },
      },
    ], {
      candidateLogPath,
    });

    const result = await recorder.settleValidationRecords({
      candidateLogPath,
      settlementLogPath,
      now: '2026-04-02T12:00:00.000Z',
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      settledCount: 2,
      path: settlementLogPath,
    }));
    const settlements = recorder.readSettlementRecords({ settlementLogPath });
    expect(settlements).toHaveLength(2);
    expect(settlements).toEqual(expect.arrayContaining([
      expect.objectContaining({
        validationId: 'val-1',
        horizonHours: 4,
        ticker: 'ETH/USD',
        signedReturnPct: 0.025,
        actualDirection: 'SELL',
      }),
      expect.objectContaining({
        validationId: 'val-1',
        horizonHours: 24,
        ticker: 'ETH/USD',
        signedReturnPct: 0.06,
        actualDirection: 'SELL',
      }),
    ]));
  });
});
