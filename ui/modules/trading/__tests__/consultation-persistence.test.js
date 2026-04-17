'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../hyperliquid-client', () => ({
  createInfoClient: jest.fn(() => ({
    metaAndAssetCtxs: jest.fn().mockResolvedValue([null, []]),
    predictedFundings: jest.fn().mockResolvedValue([]),
    fundingHistory: jest.fn().mockResolvedValue([]),
  })),
  getAccountSnapshot: jest.fn().mockResolvedValue(null),
  getOpenPositions: jest.fn().mockResolvedValue([]),
  getSnapshots: jest.fn().mockResolvedValue(new Map()),
  getLatestBars: jest.fn().mockResolvedValue(new Map()),
  getHistoricalBars: jest.fn().mockResolvedValue(new Map()),
  normalizeCoinSymbol: jest.fn((ticker) => {
    const normalized = String(ticker || '').trim().toUpperCase();
    return normalized.endsWith('/USD') ? normalized.slice(0, -4) : normalized;
  }),
}));

const { createOrchestrator } = require('../orchestrator');

describe('consultation request persistence', () => {
  let tempDir;
  let requestsDir;
  let responsesDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-consultation-persistence-'));
    requestsDir = path.join(tempDir, 'requests');
    responsesDir = path.join(tempDir, 'responses');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('consultMissingSignals persists cryptoMechBoard and eventVeto into the request JSON on disk', async () => {
    const orchestrator = createOrchestrator({
      consultationSender: async () => ({ ok: true }),
      consultationQuery: () => [],
      consultationRequestsDir: requestsDir,
      consultationResponsesDir: responsesDir,
      consultationPollMs: 50,
    });

    const result = await orchestrator.consultMissingSignals(['BTC/USD'], {
      snapshots: { 'BTC/USD': { tradePrice: 65000 } },
      bars: { 'BTC/USD': [{ close: 65000 }] },
      news: [],
      cryptoMechBoard: {
        venue: 'hyperliquid',
        symbols: {
          'BTC/USD': {
            tradeFlag: 'watch',
            mechanicalDirectionBias: 'bearish',
          },
        },
      },
      eventVeto: {
        decision: 'CAUTION',
        eventSummary: 'test event',
        sourceTier: 'tier1',
        stale: false,
        affectedAssets: ['BTC/USD'],
      },
      defiStatus: {
        positions: [],
      },
    }, {
      consultationTimeoutMs: 1000,
      consultationPollMs: 50,
    });

    const request = JSON.parse(fs.readFileSync(result.requestPath, 'utf8'));

    expect(request).toEqual(expect.objectContaining({
      cryptoMechBoard: expect.objectContaining({
        symbols: expect.objectContaining({
          'BTC/USD': expect.objectContaining({
            tradeFlag: 'watch',
          }),
        }),
      }),
      eventVeto: expect.objectContaining({
        decision: 'CAUTION',
        eventSummary: 'test event',
        affectedAssets: ['BTC/USD'],
      }),
    }));
  });
});
