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
      accountSnapshot: {
        equity: 10000,
        markets: {
          hyperliquid: { equity: 692, cash: 410, marketValue: 282 },
          ibkr_global: { equity: 10000, cash: 10000, marketValue: 0 },
        },
      },
      macroRisk: { regime: 'red', score: 66, constraints: { allowLongs: false } },
      brokerCapabilities: { supportedUniverse: ['SQQQ'] },
      whaleData: [{ symbol: 'ETH', side: 'buy', usdValue: 150000 }],
      cryptoMechBoard: {
        venue: 'hyperliquid',
        asOf: '2026-03-29T02:00:00.000Z',
        symbols: {
          'BTC/USD': {
            fundingRateBps: 0.0639,
            openInterestToVolumeRatio: 0.82,
            mechanicalDirectionBias: 'bearish',
            tradeFlag: 'watch',
          },
        },
      },
      microData: {
        asOf: '2026-03-29T02:00:10.000Z',
        symbols: {
          'BTC/USD': {
            extensionRead: { extended: true, score: 0.82 },
            bookSnapshot: { spreadBps: 5.1 },
          },
        },
      },
      defiStatus: {
        positions: [
          { coin: 'ETH', side: 'short', unrealizedPnl: 57, peakUnrealizedPnl: 150, warningLevel: 'urgent', timeOpenMs: 300000 },
        ],
      },
      consultationWarnings: [
        { level: 'urgent', message: 'ETH SHORT unrealized P&L is now $57.00 vs peak $150.00 (38% retained).' },
      ],
    }, {
      requestsDir,
    });

    expect(request.path).toBe(path.join(requestsDir, 'consult-1.json'));
    expect(JSON.parse(fs.readFileSync(request.path, 'utf8'))).toEqual(expect.objectContaining({
      requestId: 'consult-1',
      symbols: ['BTC/USD'],
      primaryDataSource: 'hyperliquid',
      executionVenue: 'hyperliquid',
      liveTradingContext: {
        venue: 'hyperliquid',
        isPrimary: true,
        checkedAt: null,
        positions: [
          { coin: 'ETH', side: 'short', unrealizedPnl: 57, peakUnrealizedPnl: 150, warningLevel: 'urgent', timeOpenMs: 300000 },
        ],
        warnings: [
          { level: 'urgent', message: 'ETH SHORT unrealized P&L is now $57.00 vs peak $150.00 (38% retained).' },
        ],
        account: { equity: 692, cash: 410, marketValue: 282 },
      },
      snapshots: {
        'BTC/USD': { tradePrice: 64000 },
      },
      bars: {
        'BTC/USD': [{ close: 64000 }],
      },
      accountSnapshot: {
        equity: 10000,
        markets: {
          hyperliquid: { equity: 692, cash: 410, marketValue: 282 },
          ibkr_global: { equity: 10000, cash: 10000, marketValue: 0 },
        },
      },
      macroRisk: {
        regime: 'red',
        score: 66,
        constraints: { allowLongs: false },
      },
      brokerCapabilities: {
        supportedUniverse: ['SQQQ'],
      },
      whaleData: [
        { symbol: 'ETH', side: 'buy', usdValue: 150000 },
      ],
      cryptoMechBoard: {
        venue: 'hyperliquid',
        asOf: '2026-03-29T02:00:00.000Z',
        symbols: {
          'BTC/USD': {
            fundingRateBps: 0.0639,
            openInterestToVolumeRatio: 0.82,
            mechanicalDirectionBias: 'bearish',
            tradeFlag: 'watch',
          },
        },
      },
      microData: {
        asOf: '2026-03-29T02:00:10.000Z',
        symbols: {
          'BTC/USD': {
            extensionRead: { extended: true, score: 0.82 },
            bookSnapshot: { spreadBps: 5.1 },
          },
        },
      },
      defiStatus: {
        positions: [
          { coin: 'ETH', side: 'short', unrealizedPnl: 57, peakUnrealizedPnl: 150, warningLevel: 'urgent', timeOpenMs: 300000 },
        ],
      },
      consultationWarnings: [
        { level: 'urgent', message: 'ETH SHORT unrealized P&L is now $57.00 vs peak $150.00 (38% retained).' },
      ],
      taskType: 'position_management',
    }));
  });

  test('builds prompts that surface Hyperliquid position warnings', () => {
    const prompt = consultationStore.buildConsultationPrompt('builder', {
      requestId: 'consult-defi-1',
      deadline: '2099-03-19T03:01:00.000Z',
      symbols: ['ETH/USD'],
      defiStatus: {
        positions: [
          { coin: 'ETH', side: 'short', unrealizedPnl: 57, peakUnrealizedPnl: 150, warningLevel: 'urgent' },
        ],
      },
      consultationWarnings: [
        { level: 'urgent', message: 'ETH SHORT unrealized P&L is now $57.00 vs peak $150.00 (38% retained).' },
      ],
      cryptoMechBoard: {
        symbols: {
          'ETH/USD': {
            mechanicalDirectionBias: 'bearish',
            tradeFlag: 'watch',
          },
        },
      },
      microData: {
        symbols: {
          'ETH/USD': {
            extensionRead: { extended: true, score: 0.91 },
            bookSnapshot: { spreadBps: 4.2 },
          },
        },
      },
      eventVeto: {
        decision: 'CAUTION',
        eventSummary: 'options_or_expiry_event: BTC options expiry approaches',
        sourceTier: 'tier1',
        stale: false,
        affectedAssets: ['ETH/USD'],
      },
    }, {
      requestsDir,
    });

    expect(prompt).toContain('Primary live-trading venue is Hyperliquid.');
    expect(prompt).toContain('Live Hyperliquid positions are included');
    expect(prompt).toContain('cryptoMechBoard');
    expect(prompt).toContain('Live micro data');
    expect(prompt).toContain('microData');
    expect(prompt).toContain('eventVeto');
    expect(prompt).toContain('WARNING: ETH SHORT unrealized P&L is now $57.00 vs peak $150.00');
  });

  test('derives live Hyperliquid account context from defi status when no portfolio market is present', () => {
    const request = consultationStore.writeConsultationRequest({
      requestId: 'consult-2a',
      symbols: ['ETH/USD'],
      accountSnapshot: {
        totalEquity: 0,
        markets: {},
      },
      defiStatus: {
        checkedAt: '2026-03-29T02:00:00.000Z',
        walletAddress: '0xwallet',
        accountValue: 698.18,
        totalMarginUsed: 693.16,
        withdrawable: 5.02,
        positions: [{ coin: 'ETH', side: 'short' }],
      },
    }, {
      requestsDir,
    });

    expect(request.liveTradingContext.account).toEqual({
      equity: 698.18,
      cash: 5.02,
      liquidCapital: 5.02,
      marketValue: 693.16,
      walletAddress: '0xwallet',
    });
  });

  test('builds macro-aware prompts that suppress BUYs when longs are blocked', () => {
    const prompt = consultationStore.buildConsultationPrompt('builder', {
      requestId: 'consult-3',
      deadline: '2099-03-19T03:01:00.000Z',
      symbols: ['BTC/USD'],
      macroRisk: {
        regime: 'red',
        score: 66,
        reason: 'Fear and conflict spike',
        constraints: { allowLongs: false },
      },
    }, {
      requestsDir,
    });

    expect(prompt).toContain('Live macro regime: RED');
    expect(prompt).toContain('Do not emit BUY signals');
    expect(prompt).toContain('"direction":"HOLD"');
  });

  test('builds crisis consultation prompts with crisis universe and broker capabilities', () => {
    const prompt = consultationStore.buildConsultationPrompt('builder', {
      requestId: 'consult-crisis-1',
      deadline: '2099-03-19T03:01:00.000Z',
      symbols: ['SQQQ', 'BITI'],
      strategyMode: 'crisis',
      macroRisk: {
        regime: 'stay_cash',
        strategyMode: 'crisis',
        score: 95,
        reason: 'Hormuz conflict escalation',
        constraints: {
          crisisUniverse: ['SQQQ', 'BITI', 'PSQ'],
        },
      },
      brokerCapabilities: {
        supportedUniverse: ['SQQQ', 'BITI'],
      },
    }, {
      requestsDir,
    });

    expect(prompt).toContain('Crisis consultation');
    expect(prompt).toContain('what should we short or hedge');
    expect(prompt).toContain('SQQQ, BITI, PSQ');
    expect(prompt).toContain('Phase 1 executable path is BUY-side only');
    expect(prompt).toContain('"direction":"BUY"');
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

  test('ignores prompt sample JSON and only stores real consultation replies', async () => {
    const request = consultationStore.writeConsultationRequest({
      requestId: 'consult-3',
      createdAt: '2026-03-19T03:00:00.000Z',
      deadline: '2099-03-19T03:01:00.000Z',
      symbols: ['BTC/USD'],
    }, {
      requestsDir,
    });
    const queryEntries = jest.fn(() => ([
      {
        rawBody: 'Analyze ALL 1 symbols in consultation request consult-3: BTC/USD. Reply via hm-send architect with JSON containing a signal for EVERY symbol: {"requestId":"consult-3","agentId":"builder","signals":[{"ticker":"BTC/USD","direction":"HOLD","confidence":0.83,"reasoning":"..."}]} Deadline: 2099-03-19T03:01:00.000Z.',
      },
      {
        rawBody: '[AGENT MSG - reply via hm-send.js] (BUILDER #100): {"requestId":"consult-3","agentId":"builder","signals":[{"ticker":"BTC/USD","direction":"SELL","confidence":0.68,"reasoning":"Real bearish thesis."}]}',
      },
    ]));

    const result = await consultationStore.collectConsultationResponses(request, ['builder'], {
      responsesDir,
      pollMs: 5,
      queryEntries,
    });

    expect(queryEntries).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'ws',
      direction: 'outbound',
      senderRole: 'builder',
      targetRole: 'architect',
    }), expect.any(Object));
    expect(result.responses).toEqual([
      expect.objectContaining({
        requestId: 'consult-3',
        agentId: 'builder',
        signals: [
          expect.objectContaining({
            ticker: 'BTC/USD',
            direction: 'SELL',
            confidence: 0.68,
            reasoning: 'Real bearish thesis.',
          }),
        ],
      }),
    ]);
  });

  test('returns early once the configured consultation quorum is reached', async () => {
    const request = consultationStore.writeConsultationRequest({
      requestId: 'consult-quorum',
      createdAt: '2026-03-19T03:00:00.000Z',
      deadline: new Date(Date.now() + 5_000).toISOString(),
      symbols: ['BTC/USD'],
    }, {
      requestsDir,
    });
    const startedAt = Date.now();

    const result = await consultationStore.collectConsultationResponses(request, ['architect', 'builder', 'oracle'], {
      responsesDir,
      pollMs: 5,
      minResponses: 2,
      queryEntries: ({ senderRole }) => {
        if (senderRole === 'architect') {
          return [{
            rawBody: '[AGENT MSG - reply via hm-send.js] (ARCHITECT #1): {"requestId":"consult-quorum","agentId":"architect","signals":[{"ticker":"BTC/USD","direction":"BUY","confidence":0.71,"reasoning":"Architect bullish."}]}',
          }];
        }
        if (senderRole === 'oracle') {
          return [{
            rawBody: '[AGENT MSG - reply via hm-send.js] (ORACLE #1): {"requestId":"consult-quorum","agentId":"oracle","signals":[{"ticker":"BTC/USD","direction":"BUY","confidence":0.74,"reasoning":"Oracle bullish."}]}',
          }];
        }
        return [];
      },
    });

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(result.responses).toHaveLength(2);
    expect(result.missingAgents).toEqual(['builder']);
  });
});
