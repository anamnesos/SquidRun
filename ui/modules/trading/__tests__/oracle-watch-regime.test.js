'use strict';

jest.mock('../hyperliquid-client', () => ({
  getHistoricalBars: jest.fn(),
}));

const fs = require('fs');
const os = require('os');
const path = require('path');

const hyperliquidClient = require('../hyperliquid-client');
const regimeModule = require('../oracle-watch-regime');

function buildOrdiPatternBars(price = 0.15) {
  const bars1h = [
    { open: 0.08, high: 0.082, low: 0.079, close: 0.081 },
    { open: 0.081, high: 0.096, low: 0.08, close: 0.095 },
    { open: 0.095, high: 0.122, low: 0.093, close: 0.12 },
    { open: 0.12, high: 0.168, low: 0.118, close: 0.162 },
    { open: 0.162, high: 0.18, low: 0.138, close: 0.143 },
    { open: 0.143, high: 0.158, low: 0.141, close: price },
  ];
  const bars5m = [
    { high: price * 1.16, low: price * 1.08, close: price * 1.12, open: price * 1.15 },
    { high: price * 1.12, low: price * 1.04, close: price * 1.06, open: price * 1.1 },
    { high: price * 1.08, low: price * 1.01, close: price * 1.03, open: price * 1.05 },
    { high: price * 1.06, low: price * 0.99, close: price * 1.04, open: price * 1.03 },
    { high: price * 1.04, low: price * 0.985, close: price * 1.02, open: price * 1.04 },
    { high: price * 1.01, low: price * 0.98, close: price, open: price * 1.02 },
  ];
  const bars15m = [
    { high: price * 1.18, low: price * 1.07, close: price * 1.11, open: price * 1.16 },
    { high: price * 1.12, low: price * 1.02, close: price * 1.05, open: price * 1.1 },
    { high: price * 1.08, low: price * 0.99, close: price * 1.04, open: price * 1.05 },
    { high: price * 1.025, low: price * 0.98, close: price, open: price * 1.04 },
  ];
  return { bars1h, bars5m, bars15m };
}

function mockHistoricalBarsByTimeframe(entries) {
  hyperliquidClient.getHistoricalBars.mockImplementation(async ({ timeframe }) => {
    const map = new Map();
    for (const [ticker, bars] of Object.entries(entries)) {
      if (timeframe === '5m') map.set(ticker, bars.bars5m || []);
      else if (timeframe === '15m') map.set(ticker, bars.bars15m || []);
      else map.set(ticker, bars.bars1h || []);
    }
    return map;
  });
}

function buildSharedOrdiMovers() {
  return [
    { ticker: 'ORDI/USD', direction: 'DOWN', change4hPct: -0.04, change24hPct: 0.32, fundingRate: 0.0000125, volumeUsd24h: 5000000, score: 0.32, price: 4.16 },
    { ticker: 'SCR/USD', direction: 'DOWN', change4hPct: -0.03, change24hPct: 0.24, fundingRate: 0.0000125, volumeUsd24h: 150000, score: 0.24, price: 0.0408 },
    { ticker: 'SAGA/USD', direction: 'DOWN', change4hPct: -0.025, change24hPct: 0.2, fundingRate: -0.0001, volumeUsd24h: 300000, score: 0.2, price: 0.0191 },
    { ticker: 'LIT/USD', direction: 'DOWN', change4hPct: -0.028, change24hPct: 0.18, fundingRate: 0.0000125, volumeUsd24h: 800000, score: 0.18, price: 0.8937 },
  ];
}

function mockSharedOrdiBars() {
  mockHistoricalBarsByTimeframe({
    'ORDI/USD': buildOrdiPatternBars(4.16),
    'SCR/USD': buildOrdiPatternBars(0.0408),
    'SAGA/USD': buildOrdiPatternBars(0.0191),
    'LIT/USD': buildOrdiPatternBars(0.8937),
  });
}

describe('oracle-watch-regime', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('detects a shared short regime from clustered downside movers', () => {
    const regime = regimeModule.detectSharedShortRegime({
      movers: [
        { ticker: 'ORDI/USD', direction: 'DOWN', change4hPct: -0.04, change24hPct: -0.18, fundingRate: 0.0000125, volumeUsd24h: 5000000, score: 0.18 },
        { ticker: 'SCR/USD', direction: 'DOWN', change4hPct: -0.03, change24hPct: -0.13, fundingRate: 0.0000125, volumeUsd24h: 150000, score: 0.13 },
        { ticker: 'SAGA/USD', direction: 'DOWN', change4hPct: -0.025, change24hPct: -0.16, fundingRate: -0.0001, volumeUsd24h: 300000, score: 0.16 },
        { ticker: 'LIT/USD', direction: 'DOWN', change4hPct: -0.028, change24hPct: -0.11, fundingRate: 0.0000125, volumeUsd24h: 800000, score: 0.11 },
        { ticker: 'ETH/USD', direction: 'DOWN', change4hPct: -0.01, change24hPct: -0.05, fundingRate: -0.00001, volumeUsd24h: 20000000, score: 0.05 },
      ],
    });

    expect(regime.active).toBe(true);
    expect(regime.qualifiedCount).toBeGreaterThanOrEqual(4);
    expect(regime.promotedCandidates.map((entry) => entry.ticker)).toEqual(expect.arrayContaining([
      'ORDI/USD',
      'SCR/USD',
      'SAGA/USD',
      'LIT/USD',
    ]));
    expect(regime.promotedCandidates.map((entry) => entry.ticker)).not.toContain('ETH/USD');
  });

  test('applies promoted short rules, seeds armed state, and rotates superseded auto rules out', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-watch-regime-'));
    const rulesPath = path.join(tempDir, 'oracle-watch-rules.json');
    const watchStatePath = path.join(tempDir, 'oracle-watch-state.json');
    const regimeStatePath = path.join(tempDir, 'oracle-short-regime-state.json');
    const marketStatePath = path.join(tempDir, 'market-scanner-state.json');

    fs.writeFileSync(rulesPath, JSON.stringify({
      version: 1,
      symbols: ['BTC/USD', 'ETH/USD', 'SOL/USD'],
      hotSymbols: [],
      rules: [
        {
          id: 'eth-short-lose-2320-fail-retest',
          ticker: 'ETH/USD',
          enabled: true,
          trigger: 'lose_fail_retest',
          loseLevel: 2264,
          retestMin: 2264,
          retestMax: 2279,
        },
        {
          id: 'shared-regime-auto-short-old',
          ticker: 'OLD/USD',
          enabled: true,
          trigger: 'lose_fail_retest',
          loseLevel: 1.2,
          retestMin: 1.2,
          retestMax: 1.25,
          sourceTag: regimeModule.AUTO_RULE_SOURCE,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      ],
    }, null, 2));
    fs.writeFileSync(watchStatePath, JSON.stringify({
      version: 2,
      rules: {
        'shared-regime-auto-short-old': {
          status: 'idle',
          lastEventType: 'invalidated',
          conflictResolution: {
            status: 'superseded',
          },
        },
      },
    }, null, 2));
    fs.writeFileSync(marketStatePath, JSON.stringify({
      flaggedMovers: buildSharedOrdiMovers(),
    }, null, 2));

    mockSharedOrdiBars();

    const result = await regimeModule.applySharedShortRegime({
      statePath: regimeStatePath,
      rulesPath,
      watchStatePath,
      marketScannerStatePath: marketStatePath,
    });

    const savedRules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
    const savedWatchState = JSON.parse(fs.readFileSync(watchStatePath, 'utf8'));
    const savedRegimeState = JSON.parse(fs.readFileSync(regimeStatePath, 'utf8'));

    expect(result.ok).toBe(true);
    expect(result.active).toBe(true);
    expect(result.promotedTickers).toEqual(expect.arrayContaining(['ORDI/USD', 'SCR/USD', 'SAGA/USD', 'LIT/USD']));
    expect(savedRules.rules.some((rule) => rule.id === 'shared-regime-auto-short-old')).toBe(false);
    expect(savedRules.rules.filter((rule) => rule.sourceTag === regimeModule.AUTO_RULE_SOURCE).length).toBeGreaterThanOrEqual(4);
    expect(savedRules.rules.find((rule) => rule.id === 'shared-regime-auto-short-ordi')).toEqual(expect.objectContaining({
      suggestedMarginUsd: 250,
      suggestedLeverage: 10,
    }));
    expect(savedRules.rules.find((rule) => rule.id === 'shared-regime-auto-short-saga')).toEqual(expect.objectContaining({
      suggestedMarginUsd: 200,
      suggestedLeverage: 7,
    }));
    expect(savedWatchState.rules['shared-regime-auto-short-ordi']).toEqual(expect.objectContaining({
      status: 'armed',
      lastEventType: 'armed_seeded',
    }));
    expect(savedRegimeState.promotedTickers).toEqual(expect.arrayContaining(['ORDI/USD', 'SCR/USD']));
    expect(savedRegimeState.retiredRuleIds).toContain('shared-regime-auto-short-old');
  });

  test('blocks generic shared short clusters that lack the ORDI-pattern setup', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-watch-regime-generic-block-'));
    const rulesPath = path.join(tempDir, 'oracle-watch-rules.json');
    const watchStatePath = path.join(tempDir, 'oracle-watch-state.json');
    const regimeStatePath = path.join(tempDir, 'oracle-short-regime-state.json');
    const marketStatePath = path.join(tempDir, 'market-scanner-state.json');
    const promotionDecisionsPath = path.join(tempDir, 'oracle-watch-promotion-decisions.jsonl');

    fs.writeFileSync(rulesPath, JSON.stringify({ version: 1, symbols: [], hotSymbols: [], rules: [] }, null, 2));
    fs.writeFileSync(watchStatePath, JSON.stringify({ version: 2, rules: {} }, null, 2));
    fs.writeFileSync(marketStatePath, JSON.stringify({
      flaggedMovers: [
        { ticker: 'ORDI/USD', direction: 'DOWN', change4hPct: -0.04, change24hPct: -0.18, fundingRate: 0.0000125, volumeUsd24h: 5000000, score: 0.18, price: 4.16 },
        { ticker: 'SCR/USD', direction: 'DOWN', change4hPct: -0.03, change24hPct: -0.13, fundingRate: 0.0000125, volumeUsd24h: 150000, score: 0.13, price: 0.0408 },
        { ticker: 'SAGA/USD', direction: 'DOWN', change4hPct: -0.025, change24hPct: -0.16, fundingRate: -0.0001, volumeUsd24h: 300000, score: 0.16, price: 0.0191 },
        { ticker: 'LIT/USD', direction: 'DOWN', change4hPct: -0.028, change24hPct: -0.11, fundingRate: 0.0000125, volumeUsd24h: 800000, score: 0.11, price: 0.8937 },
      ],
    }, null, 2));

    mockSharedOrdiBars();

    const result = await regimeModule.applySharedShortRegime({
      statePath: regimeStatePath,
      rulesPath,
      watchStatePath,
      marketScannerStatePath: marketStatePath,
      promotionDecisionsPath,
    });

    const savedRules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
    const decisionLog = fs.readFileSync(promotionDecisionsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(result.active).toBe(true);
    expect(result.promotedTickers).toEqual([]);
    expect(savedRules.rules.filter((rule) => rule.sourceTag === regimeModule.AUTO_RULE_SOURCE)).toEqual([]);
    expect(decisionLog).toEqual(expect.arrayContaining([
      expect.objectContaining({ ticker: 'ORDI/USD', promotionSource: 'shared_short_regime', accepted: false, reason: 'multi_day_pump_insufficient_bars' }),
    ]));
  });

  test('refreshes retained auto rules when the mission sizing bucket changes', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-watch-regime-refresh-'));
    const rulesPath = path.join(tempDir, 'oracle-watch-rules.json');
    const watchStatePath = path.join(tempDir, 'oracle-watch-state.json');
    const regimeStatePath = path.join(tempDir, 'oracle-short-regime-state.json');
    const marketStatePath = path.join(tempDir, 'market-scanner-state.json');
    const futureIso = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    fs.writeFileSync(rulesPath, JSON.stringify({
      version: 1,
      symbols: ['BTC/USD', 'ETH/USD', 'SOL/USD'],
      hotSymbols: [],
      rules: [
        {
          id: 'shared-regime-auto-short-saga',
          ticker: 'SAGA/USD',
          enabled: true,
          trigger: 'lose_fail_retest',
          loseLevel: 0.0191,
          retestMin: 0.0191,
          retestMax: 0.01917,
          sourceTag: regimeModule.AUTO_RULE_SOURCE,
          suggestedMarginUsd: 35,
          suggestedLeverage: 7,
          expiresAt: futureIso,
        },
      ],
    }, null, 2));
    fs.writeFileSync(watchStatePath, JSON.stringify({
      version: 2,
      rules: {
        'shared-regime-auto-short-saga': {
          status: 'armed',
          armedAt: Date.now() - 10000,
        },
      },
    }, null, 2));
    fs.writeFileSync(marketStatePath, JSON.stringify({
      flaggedMovers: buildSharedOrdiMovers(),
    }, null, 2));

    mockSharedOrdiBars();

    await regimeModule.applySharedShortRegime({
      statePath: regimeStatePath,
      rulesPath,
      watchStatePath,
      marketScannerStatePath: marketStatePath,
    });

    const savedRules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
    const savedWatchState = JSON.parse(fs.readFileSync(watchStatePath, 'utf8'));
    expect(savedRules.rules.find((rule) => rule.id === 'shared-regime-auto-short-saga')).toEqual(expect.objectContaining({
      suggestedMarginUsd: 200,
      suggestedLeverage: 7,
    }));
    expect(savedWatchState.rules['shared-regime-auto-short-saga']).toEqual(expect.not.objectContaining({
      execution: expect.anything(),
      actedOnAt: expect.anything(),
      actedOnCount: expect.anything(),
      actedOnNote: expect.anything(),
    }));
  });

  test('clears stale execution metadata when a retained auto rule keeps the symbol but now targets larger mission size', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-watch-regime-clear-execution-'));
    const rulesPath = path.join(tempDir, 'oracle-watch-rules.json');
    const watchStatePath = path.join(tempDir, 'oracle-watch-state.json');
    const regimeStatePath = path.join(tempDir, 'oracle-short-regime-state.json');
    const marketStatePath = path.join(tempDir, 'market-scanner-state.json');
    const futureIso = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    fs.writeFileSync(rulesPath, JSON.stringify({
      version: 1,
      symbols: ['BTC/USD', 'ETH/USD', 'SOL/USD'],
      hotSymbols: [],
      rules: [
        {
          id: 'shared-regime-auto-short-ordi',
          ticker: 'ORDI/USD',
          enabled: true,
          trigger: 'lose_fail_retest',
          loseLevel: 4.2251,
          retestMin: 4.2251,
          retestMax: 4.2445,
          sourceTag: regimeModule.AUTO_RULE_SOURCE,
          suggestedMarginUsd: 250,
          suggestedLeverage: 10,
          expiresAt: futureIso,
          metadata: {
            generatedStructureHigh: 4.2612,
          },
        },
      ],
    }, null, 2));
    fs.writeFileSync(watchStatePath, JSON.stringify({
      version: 2,
      rules: {
        'shared-regime-auto-short-ordi': {
          status: 'fired',
          lastEventType: 'fired',
          lastEventAt: '2026-04-19T23:45:13.158Z',
          execution: {
            requestedMarginUsd: 90,
            marginUsd: 60,
          },
          actedOnAt: '2026-04-19T23:45:16.019Z',
          actedOnCount: 1,
          actedOnNote: 'attempted',
        },
      },
    }, null, 2));
    fs.writeFileSync(marketStatePath, JSON.stringify({
      flaggedMovers: buildSharedOrdiMovers(),
    }, null, 2));

    mockSharedOrdiBars();

    await regimeModule.applySharedShortRegime({
      statePath: regimeStatePath,
      rulesPath,
      watchStatePath,
      marketScannerStatePath: marketStatePath,
    });

    const savedWatchState = JSON.parse(fs.readFileSync(watchStatePath, 'utf8'));
    expect(savedWatchState.rules['shared-regime-auto-short-ordi']).toEqual(expect.not.objectContaining({
      execution: expect.anything(),
      actedOnAt: expect.anything(),
      actedOnCount: expect.anything(),
      actedOnNote: expect.anything(),
    }));
    expect(savedWatchState.rules['shared-regime-auto-short-ordi']).toEqual(expect.objectContaining({
      status: 'fired',
      lastEventType: 'fired',
    }));
  });

  test('bridges urgent promoted scanner shorts into oracle watch rules even when shared short regime is inactive', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-watch-promotions-scanner-'));
    const rulesPath = path.join(tempDir, 'oracle-watch-rules.json');
    const watchStatePath = path.join(tempDir, 'oracle-watch-state.json');
    const regimeStatePath = path.join(tempDir, 'oracle-short-regime-state.json');
    const marketStatePath = path.join(tempDir, 'market-scanner-state.json');
    const sparkFirePlansPath = path.join(tempDir, 'spark-fireplans.json');
    const priorityOverridesPath = path.join(tempDir, 'oracle-watch-priority-overrides.json');
    const promotionDecisionsPath = path.join(tempDir, 'oracle-watch-promotion-decisions.jsonl');

    fs.writeFileSync(rulesPath, JSON.stringify({
      version: 1,
      symbols: ['BTC/USD', 'ETH/USD', 'SOL/USD'],
      hotSymbols: [],
      rules: [],
    }, null, 2));
    fs.writeFileSync(watchStatePath, JSON.stringify({ version: 2, rules: {} }, null, 2));
    fs.writeFileSync(marketStatePath, JSON.stringify({
      lastResult: {
        scannedAt: '2026-04-23T17:00:13.110Z',
        urgentPromotedSymbols: ['HYPER/USD'],
        flaggedMovers: [
          { ticker: 'HYPER/USD', direction: 'UP', change4hPct: -0.033, change24hPct: 0.5967, fundingRate: -0.00228789, volumeUsd24h: 3956295.61, openInterestChange24hPct: 1.6361, score: 0.5967, price: 0.156405 },
        ],
      },
    }, null, 2));
    fs.writeFileSync(sparkFirePlansPath, JSON.stringify({ generatedAt: '2026-04-23T17:26:00.000Z', firePlans: [] }, null, 2));
    fs.writeFileSync(priorityOverridesPath, JSON.stringify({ version: 1, entries: [] }, null, 2));

    mockHistoricalBarsByTimeframe({
      'HYPER/USD': buildOrdiPatternBars(0.156405),
    });

    const result = await regimeModule.applySharedShortRegime({
      now: '2026-04-23T17:30:00.000Z',
      statePath: regimeStatePath,
      rulesPath,
      watchStatePath,
      marketScannerStatePath: marketStatePath,
      sparkFirePlansPath,
      priorityOverridesPath,
      promotionDecisionsPath,
    });

    const savedRules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
    const savedWatchState = JSON.parse(fs.readFileSync(watchStatePath, 'utf8'));
    const decisionLog = fs.readFileSync(promotionDecisionsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));

    expect(result.active).toBe(false);
    expect(result.promotionPromotedTickers).toEqual(expect.arrayContaining(['HYPER/USD']));
    expect(savedRules.rules.find((rule) => rule.id === 'promoted-watch-short-hyper')).toEqual(expect.objectContaining({
      sourceTag: regimeModule.PROMOTED_AUTO_RULE_SOURCE,
      trigger: 'lose_fail_retest',
      suggestedMarginUsd: 200,
    }));
    expect(savedWatchState.rules['promoted-watch-short-hyper']).toEqual(expect.objectContaining({
      status: 'armed',
      lastEventType: 'armed_seeded',
    }));
    expect(decisionLog).toEqual(expect.arrayContaining([
      expect.objectContaining({ ticker: 'HYPER/USD', promotionSource: 'market_scanner_urgent', desiredDirection: 'SELL', accepted: true }),
    ]));
  });

  test('rejects catalyst-only spark longs instead of converting them into executable watch rules', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-watch-promotions-spark-'));
    const rulesPath = path.join(tempDir, 'oracle-watch-rules.json');
    const watchStatePath = path.join(tempDir, 'oracle-watch-state.json');
    const regimeStatePath = path.join(tempDir, 'oracle-short-regime-state.json');
    const marketStatePath = path.join(tempDir, 'market-scanner-state.json');
    const sparkFirePlansPath = path.join(tempDir, 'spark-fireplans.json');
    const promotionDecisionsPath = path.join(tempDir, 'oracle-watch-promotion-decisions.jsonl');

    fs.writeFileSync(rulesPath, JSON.stringify({ version: 1, symbols: [], hotSymbols: [], rules: [] }, null, 2));
    fs.writeFileSync(watchStatePath, JSON.stringify({ version: 2, rules: {} }, null, 2));
    fs.writeFileSync(marketStatePath, JSON.stringify({ lastResult: { flaggedMovers: [], urgentPromotedSymbols: [] } }, null, 2));
    fs.writeFileSync(sparkFirePlansPath, JSON.stringify({
      generatedAt: '2026-04-23T17:26:00.000Z',
      firePlans: [
        {
          ticker: 'AERO/USD',
          source: 'upbit',
          catalystType: 'upbit_listing',
          direction: 'BUY',
          ready: true,
          tradeableOnHyperliquid: true,
          currentPrice: 0.44724,
          entryZone: { lower: 0.4441, upper: 0.44611 },
          maxMarginUsd: 250,
          maxLeverage: 5,
          publishedAt: '2026-04-23T17:10:00.000Z',
        },
      ],
    }, null, 2));

    mockHistoricalBarsByTimeframe({
      'AERO/USD': buildOrdiPatternBars(0.44724),
    });

    const result = await regimeModule.applySharedShortRegime({
      now: '2026-04-23T17:30:00.000Z',
      statePath: regimeStatePath,
      rulesPath,
      watchStatePath,
      marketScannerStatePath: marketStatePath,
      sparkFirePlansPath,
      promotionDecisionsPath,
    });

    const savedRules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
    const decisionLog = fs.readFileSync(promotionDecisionsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(result.promotionPromotedTickers).toEqual([]);
    expect(savedRules.rules.find((rule) => rule.id === 'promoted-watch-long-aero')).toBeUndefined();
    expect(decisionLog).toEqual(expect.arrayContaining([
      expect.objectContaining({ ticker: 'AERO/USD', promotionSource: 'spark_fireplan', accepted: false, reason: 'ordi_pattern_short_only' }),
    ]));
  });

  test('manual priority override wins over bullish inputs and keeps direction bearish', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-watch-promotions-manual-'));
    const rulesPath = path.join(tempDir, 'oracle-watch-rules.json');
    const watchStatePath = path.join(tempDir, 'oracle-watch-state.json');
    const regimeStatePath = path.join(tempDir, 'oracle-short-regime-state.json');
    const marketStatePath = path.join(tempDir, 'market-scanner-state.json');
    const sparkFirePlansPath = path.join(tempDir, 'spark-fireplans.json');
    const priorityOverridesPath = path.join(tempDir, 'oracle-watch-priority-overrides.json');

    fs.writeFileSync(rulesPath, JSON.stringify({ version: 1, symbols: [], hotSymbols: [], rules: [] }, null, 2));
    fs.writeFileSync(watchStatePath, JSON.stringify({ version: 2, rules: {} }, null, 2));
    fs.writeFileSync(marketStatePath, JSON.stringify({
      lastResult: {
        scannedAt: '2026-04-23T17:00:13.110Z',
        urgentPromotedSymbols: ['CHIP/USD'],
        flaggedMovers: [
          { ticker: 'CHIP/USD', direction: 'UP', change4hPct: -0.041, change24hPct: 0.32, fundingRate: -0.0002, volumeUsd24h: 1500000, openInterestChange24hPct: 0.14, score: 0.32, price: 0.091985 },
        ],
      },
    }, null, 2));
    fs.writeFileSync(sparkFirePlansPath, JSON.stringify({
      generatedAt: '2026-04-23T17:26:00.000Z',
      firePlans: [
        {
          ticker: 'CHIP/USD',
          source: 'upbit',
          catalystType: 'upbit_listing',
          direction: 'BUY',
          ready: true,
          tradeableOnHyperliquid: true,
          currentPrice: 0.091985,
          entryZone: { lower: 0.0913, upper: 0.0922 },
          maxMarginUsd: 250,
          maxLeverage: 3,
          publishedAt: '2026-04-23T17:10:00.000Z',
        },
      ],
    }, null, 2));
    fs.writeFileSync(priorityOverridesPath, JSON.stringify({
      version: 1,
      updatedAt: '2026-04-23T17:00:00.000Z',
      entries: [
        {
          ticker: 'CHIP/USD',
          preferredDirection: 'SELL',
          reason: 'James flagged as excellent short',
          expiresAt: '2026-04-24T00:00:00.000Z',
        },
      ],
    }, null, 2));

    mockHistoricalBarsByTimeframe({
      'CHIP/USD': buildOrdiPatternBars(0.091985),
    });

    await regimeModule.applySharedShortRegime({
      now: '2026-04-23T17:30:00.000Z',
      statePath: regimeStatePath,
      rulesPath,
      watchStatePath,
      marketScannerStatePath: marketStatePath,
      sparkFirePlansPath,
      priorityOverridesPath,
    });

    const savedRules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
    expect(savedRules.rules.find((rule) => rule.id === 'promoted-watch-short-chip')).toEqual(expect.objectContaining({
      sourceTag: regimeModule.PROMOTED_AUTO_RULE_SOURCE,
      metadata: expect.objectContaining({
        overrideDirection: 'SELL',
        overrideReason: 'James flagged as excellent short',
      }),
    }));
    expect(savedRules.rules.find((rule) => rule.id === 'promoted-watch-long-chip')).toBeUndefined();
  });

  test('rejected spark long does not suppress a valid urgent bearish scanner rule on the same ticker', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-watch-promotions-priority-'));
    const rulesPath = path.join(tempDir, 'oracle-watch-rules.json');
    const watchStatePath = path.join(tempDir, 'oracle-watch-state.json');
    const regimeStatePath = path.join(tempDir, 'oracle-short-regime-state.json');
    const marketStatePath = path.join(tempDir, 'market-scanner-state.json');
    const sparkFirePlansPath = path.join(tempDir, 'spark-fireplans.json');
    const promotionDecisionsPath = path.join(tempDir, 'oracle-watch-promotion-decisions.jsonl');

    fs.writeFileSync(rulesPath, JSON.stringify({ version: 1, symbols: [], hotSymbols: [], rules: [] }, null, 2));
    fs.writeFileSync(watchStatePath, JSON.stringify({ version: 2, rules: {} }, null, 2));
    fs.writeFileSync(marketStatePath, JSON.stringify({
      lastResult: {
        scannedAt: '2026-04-23T17:00:13.110Z',
        urgentPromotedSymbols: ['CHIP/USD'],
        flaggedMovers: [
          { ticker: 'CHIP/USD', direction: 'UP', change4hPct: -0.041, change24hPct: 0.32, fundingRate: -0.00005446, volumeUsd24h: 150558673.02, openInterestChange24hPct: 0.2505, score: 0.32, price: 0.091985 },
        ],
      },
    }, null, 2));
    fs.writeFileSync(sparkFirePlansPath, JSON.stringify({
      generatedAt: '2026-04-23T17:26:00.000Z',
      firePlans: [
        {
          ticker: 'CHIP/USD',
          source: 'upbit',
          catalystType: 'upbit_listing',
          direction: 'BUY',
          ready: true,
          tradeableOnHyperliquid: true,
          currentPrice: 0.091985,
          entryZone: { lower: 0.0913, upper: 0.0922 },
          maxMarginUsd: 250,
          maxLeverage: 3,
          publishedAt: '2026-04-23T17:10:00.000Z',
        },
      ],
    }, null, 2));

    mockHistoricalBarsByTimeframe({
      'CHIP/USD': buildOrdiPatternBars(0.091985),
    });

    await regimeModule.applySharedShortRegime({
      now: '2026-04-23T17:30:00.000Z',
      statePath: regimeStatePath,
      rulesPath,
      watchStatePath,
      marketScannerStatePath: marketStatePath,
      sparkFirePlansPath,
      promotionDecisionsPath,
    });

    const savedRules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
    const decisionLog = fs.readFileSync(promotionDecisionsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));

    expect(savedRules.rules.find((rule) => rule.id === 'promoted-watch-short-chip')).toBeDefined();
    expect(savedRules.rules.find((rule) => rule.id === 'promoted-watch-long-chip')).toBeUndefined();
    expect(decisionLog).toEqual(expect.arrayContaining([
      expect.objectContaining({ ticker: 'CHIP/USD', promotionSource: 'spark_fireplan', accepted: false, reason: 'ordi_pattern_short_only' }),
      expect.objectContaining({ ticker: 'CHIP/USD', promotionSource: 'market_scanner_urgent', desiredDirection: 'SELL', accepted: true }),
    ]));
  });

  test('retires stale promoted auto rules when no active source remains', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-watch-promotions-retire-'));
    const rulesPath = path.join(tempDir, 'oracle-watch-rules.json');
    const watchStatePath = path.join(tempDir, 'oracle-watch-state.json');
    const regimeStatePath = path.join(tempDir, 'oracle-short-regime-state.json');
    const marketStatePath = path.join(tempDir, 'market-scanner-state.json');
    const sparkFirePlansPath = path.join(tempDir, 'spark-fireplans.json');
    const priorityOverridesPath = path.join(tempDir, 'oracle-watch-priority-overrides.json');
    const promotionDecisionsPath = path.join(tempDir, 'oracle-watch-promotion-decisions.jsonl');

    fs.writeFileSync(rulesPath, JSON.stringify({
      version: 1,
      symbols: ['CHIP/USD'],
      hotSymbols: ['CHIP/USD'],
      rules: [
        {
          id: 'promoted-watch-short-chip',
          ticker: 'CHIP/USD',
          enabled: true,
          trigger: 'lose_fail_retest',
          loseLevel: 0.0931,
          retestMin: 0.0931,
          retestMax: 0.0936,
          sourceTag: regimeModule.PROMOTED_AUTO_RULE_SOURCE,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        },
      ],
    }, null, 2));
    fs.writeFileSync(watchStatePath, JSON.stringify({
      version: 2,
      rules: {
        'promoted-watch-short-chip': {
          status: 'armed',
          lastEventType: 'armed_seeded',
        },
      },
    }, null, 2));
    fs.writeFileSync(marketStatePath, JSON.stringify({ lastResult: { flaggedMovers: [], urgentPromotedSymbols: [] } }, null, 2));
    fs.writeFileSync(sparkFirePlansPath, JSON.stringify({ generatedAt: '2026-04-23T17:26:00.000Z', firePlans: [] }, null, 2));
    fs.writeFileSync(priorityOverridesPath, JSON.stringify({ version: 1, entries: [] }, null, 2));

    await regimeModule.applySharedShortRegime({
      statePath: regimeStatePath,
      rulesPath,
      watchStatePath,
      marketScannerStatePath: marketStatePath,
      sparkFirePlansPath,
      priorityOverridesPath,
      promotionDecisionsPath,
    });

    const savedRules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
    const savedWatchState = JSON.parse(fs.readFileSync(watchStatePath, 'utf8'));
    const decisionLog = fs.readFileSync(promotionDecisionsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));

    expect(savedRules.rules.find((rule) => rule.id === 'promoted-watch-short-chip')).toBeUndefined();
    expect(savedWatchState.rules['promoted-watch-short-chip']).toBeUndefined();
    expect(decisionLog).toEqual(expect.arrayContaining([
      expect.objectContaining({ ticker: 'CHIP/USD', promotionSource: 'retired_auto_rule', accepted: false, reason: 'source_disappeared' }),
    ]));
  });
});
