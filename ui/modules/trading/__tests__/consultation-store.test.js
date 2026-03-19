'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const consultationStore = require('../consultation-store');

describe('consultation-store', () => {
  let tempDir;
  let requestsDir;
  let responsesDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-consultation-store-'));
    requestsDir = path.join(tempDir, 'consultation-requests');
    responsesDir = path.join(tempDir, 'consultation-responses');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('writes consultation requests to the runtime request directory', () => {
    const request = consultationStore.writeConsultationRequest({
      requestId: 'consult-1',
      timeoutMs: 60000,
      symbols: ['BTC/USD'],
      snapshots: new Map([['BTC/USD', { tradePrice: 64000 }]]),
      bars: new Map([['BTC/USD', [{ close: 64000 }]]]),
      news: [{ headline: 'ETF inflows accelerate' }],
      accountSnapshot: { equity: 10000 },
    }, {
      requestsDir,
    });

    expect(request.path).toBe(path.join(requestsDir, 'consult-1.json'));
    expect(JSON.parse(fs.readFileSync(request.path, 'utf8'))).toEqual(expect.objectContaining({
      requestId: 'consult-1',
      symbols: ['BTC/USD'],
      snapshots: {
        'BTC/USD': { tradePrice: 64000 },
      },
      bars: {
        'BTC/USD': [{ close: 64000 }],
      },
      accountSnapshot: { equity: 10000 },
    }));
  });

  test('parses role-prefixed hm-send JSON replies and stores them by request and agent', async () => {
    const request = consultationStore.writeConsultationRequest({
      requestId: 'consult-2',
      createdAt: '2026-03-19T03:00:00.000Z',
      deadline: '2099-03-19T03:01:00.000Z',
      symbols: ['BTC/USD'],
    }, {
      requestsDir,
    });

    const result = await consultationStore.collectConsultationResponses(request, ['builder'], {
      responsesDir,
      pollMs: 5,
      queryEntries: () => ([
        {
          rawBody: '[AGENT MSG - reply via hm-send.js] (BUILDER #99): {"requestId":"consult-2","agentId":"builder","signals":[{"ticker":"BTC/USD","direction":"BUY","confidence":0.72,"reasoning":"ETF flows and trend alignment."}]}',
        },
      ]),
    });

    expect(result.responses).toEqual([
      expect.objectContaining({
        requestId: 'consult-2',
        agentId: 'builder',
        signals: [
          expect.objectContaining({
            ticker: 'BTC/USD',
            direction: 'BUY',
            confidence: 0.72,
          }),
        ],
      }),
    ]);
    const responsePath = path.join(responsesDir, 'consult-2-builder.json');
    expect(fs.existsSync(responsePath)).toBe(true);
  });
});
