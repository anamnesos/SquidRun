'use strict';

const mockExecFile = jest.fn();

jest.mock('child_process', () => ({
  execFile: (...args) => mockExecFile(...args),
}));

jest.mock('../modules/trading/dynamic-watchlist', () => ({
  DEFAULT_CRYPTO_WATCHLIST: [{ ticker: 'BTC/USD' }],
  getActiveEntries: jest.fn(() => [{ ticker: 'BTC/USD', assetClass: 'crypto' }]),
}));

jest.mock('../modules/trading/hyperliquid-client', () => ({
  __readSharedRateLimitState: jest.fn(() => ({ backoffUntil: null })),
  getAccountSnapshot: jest.fn(async () => ({
    equity: 1000,
    cash: 700,
    raw: { marginSummary: { totalMarginUsed: 0 } },
  })),
  getOpenPositions: jest.fn(async () => []),
}));

jest.mock('../modules/trading/hyperliquid-manual-activity', () => ({
  readManualHyperliquidActivity: jest.fn(() => null),
  isManualHyperliquidActivityActive: jest.fn(() => false),
}));

jest.mock('../modules/trading/symbol-microdata', () => ({
  getMicroDataForSymbol: jest.fn(async (symbol) => ({ ticker: symbol, ok: true })),
}));

jest.mock('../modules/trading/rules-engine', () => ({
  evaluateLongShortSetup: jest.fn(() => ({
    fire: true,
    side: 'short',
    reason: 'SHORT ORDI-pattern: test',
    score: 0.72,
    sizeUsd: 200,
    stopPx: 105,
    tpPx: 90,
    tp2Px: 85.5,
    entryPx: 100,
  })),
}));

const hyperliquidClient = require('../modules/trading/hyperliquid-client');
const rulesEngine = require('../modules/trading/rules-engine');
const symbolMicrodata = require('../modules/trading/symbol-microdata');
const tradingTick = require('../scripts/hm-trading-tick');

describe('hm-trading-tick', () => {
  let stdoutSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  test('dry-run smoke checks live-shaped Hyperliquid context and prints what would fire without executing', async () => {
    const result = await tradingTick.runTradingTick({
      dryRun: true,
      json: true,
      symbols: ['BTC/USD'],
      nowMs: Date.parse('2026-04-27T18:00:00.000Z'),
      supervisorStatusPath: 'missing-supervisor-status.json',
      anomalyPath: 'missing-anomalies.jsonl',
      sparkEventsPath: 'missing-spark-events.jsonl',
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      dryRun: true,
      checked: 1,
      fired: 1,
    }));
    expect(hyperliquidClient.getAccountSnapshot).toHaveBeenCalled();
    expect(hyperliquidClient.getOpenPositions).toHaveBeenCalled();
    expect(symbolMicrodata.getMicroDataForSymbol).toHaveBeenCalledWith('BTC/USD', expect.any(Object));
    expect(rulesEngine.evaluateLongShortSetup).toHaveBeenCalledWith(
      'BTC/USD',
      expect.objectContaining({
        account: expect.objectContaining({ accountValue: 1000 }),
        positions: [],
        eventVeto: expect.objectContaining({ decision: 'CLEAR' }),
      }),
      expect.objectContaining({ nowMs: Date.parse('2026-04-27T18:00:00.000Z') })
    );
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('"dryRun": true'));
  });

  test('live fire invokes hm-defi-execute and logs a rules_engine_fired anomaly', async () => {
    mockExecFile.mockImplementation((file, args, options, callback) => {
      callback(null, '{"ok":true}', '');
    });

    const result = await tradingTick.runTradingTick({
      dryRun: false,
      json: true,
      symbols: ['BTC/USD'],
      nowMs: Date.parse('2026-04-27T18:00:00.000Z'),
      executeScriptPath: 'hm-defi-execute.js',
      anomalyScriptPath: 'hm-anomaly.js',
      supervisorStatusPath: 'missing-supervisor-status.json',
      anomalyPath: 'missing-anomalies.jsonl',
      sparkEventsPath: 'missing-spark-events.jsonl',
    });

    expect(result.fired).toBe(1);
    expect(mockExecFile).toHaveBeenCalledTimes(2);
    expect(mockExecFile.mock.calls[0][1]).toEqual(expect.arrayContaining([
      'hm-defi-execute.js',
      'trade',
      '--asset',
      'BTC',
      '--direction',
      'SHORT',
      '--margin',
      '200',
    ]));
    expect(mockExecFile.mock.calls[1][1]).toEqual(expect.arrayContaining([
      'hm-anomaly.js',
      'type=rules_engine_fired',
      'src=rules-engine',
      'sev=medium',
      '--json',
    ]));
  });
});
