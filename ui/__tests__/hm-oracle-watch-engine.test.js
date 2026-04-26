jest.mock('../scripts/hm-agent-alert', () => ({
  sendAgentAlert: jest.fn(() => ({ ok: true, targets: ['oracle'], results: [{ target: 'oracle', ok: true }] })),
}));

jest.mock('../scripts/hm-defi-execute', () => ({
  openHyperliquidPosition: jest.fn(),
}));

jest.mock('../scripts/hm-defi-close', () => ({
  resolveWalletAddress: jest.fn(() => '0xwallet'),
  closeHyperliquidPositions: jest.fn(),
}));

jest.mock('../scripts/hm-trailing-stop', () => ({
  manageTrailingStop: jest.fn(),
}));

jest.mock('child_process', () => ({
  execFileSync: jest.fn(() => 'Delivered to telegram: ok (ack: telegram_delivered, attempt 1)'),
}));

jest.mock('../modules/trading/hyperliquid-client', () => ({
  getUniverseMarketData: jest.fn(),
  getHistoricalBars: jest.fn(),
  getPredictedFundings: jest.fn(),
  getOpenPositions: jest.fn(),
  getOpenOrders: jest.fn(),
  getClearinghouseState: jest.fn(),
  getMetaAndAssetCtxs: jest.fn(),
  getL2Book: jest.fn(),
}));

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { sendAgentAlert } = require('../scripts/hm-agent-alert');
const hmDefiExecute = require('../scripts/hm-defi-execute');
const hmDefiClose = require('../scripts/hm-defi-close');
const hmTrailingStop = require('../scripts/hm-trailing-stop');
const hyperliquidClient = require('../modules/trading/hyperliquid-client');
const {
  evaluateReclaimHold,
  evaluateRelativeStrength,
  evaluateRuleStaleness,
  loadRulesConfig,
  buildSuggestedCommand,
  resolveWatchExecutionStopLoss,
  resolveWatchedTickers,
  decideOraclePositionManagementAction,
  runWatchCycle,
  formatOracleAlert,
  formatTelegramTradeAlert,
  collectStaleRules,
} = require('../scripts/hm-oracle-watch-engine');
const { main: watchRulesCli } = require('../scripts/hm-oracle-watch-rules');

describe('hm-oracle-watch-engine', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    hmDefiExecute.openHyperliquidPosition.mockResolvedValue({
      asset: 'BTC',
      direction: 'LONG',
      size: 0.1,
      price: 74045,
      stopLossConfigured: true,
      takeProfitConfigured: true,
    });
    hyperliquidClient.getClearinghouseState.mockResolvedValue({
      marginSummary: { accountValue: '500' },
      assetPositions: [],
    });
    hmDefiClose.closeHyperliquidPositions.mockResolvedValue({
      ok: true,
      closeAttempted: 1,
      closedCount: 1,
    });
    hmTrailingStop.manageTrailingStop.mockResolvedValue({
      ok: true,
      action: 'replace_stop',
      reason: 'trailing_stop_tightened',
      newStop: 41.01,
    });
    hyperliquidClient.getMetaAndAssetCtxs.mockResolvedValue([
      {
        universe: [
          { name: 'BTC', szDecimals: 5, maxLeverage: 25 },
          { name: 'ORDI', szDecimals: 2, maxLeverage: 10 },
          { name: 'SAGA', szDecimals: 0, maxLeverage: 7 },
          { name: 'HYPE', szDecimals: 2, maxLeverage: 10 },
        ],
      },
      [],
    ]);
    hyperliquidClient.getOpenOrders.mockResolvedValue([]);
  });

  test('resolveWatchedTickers keeps majors plus only two hot symbols', () => {
    expect(resolveWatchedTickers({
      symbols: ['BTC/USD', 'ETH/USD', 'SOL/USD'],
      hotSymbols: ['BIO/USD', 'TURBO/USD', 'PNUT/USD'],
      rules: [
        { ticker: 'ZEC/USD' },
        { ticker: 'APT/USD', anchorTicker: 'BTC/USD' },
      ],
    })).toEqual(['BTC/USD', 'ETH/USD', 'SOL/USD', 'BIO/USD', 'TURBO/USD', 'ZEC/USD', 'APT/USD']);
  });

  test('shared continuation shorts buffer the live stop above the fragile retest cap', () => {
    const stopLoss = resolveWatchExecutionStopLoss({
      ticker: 'HYPE/USD',
      trigger: 'lose_fail_retest',
      sourceTag: 'shared_regime_auto',
      loseLevel: 40.98,
      retestMin: 40.98,
      retestMax: 41.12,
      metadata: {
        regime: 'shared_short_continuation',
        generatedFromPrice: 40.975,
        generatedStructureHigh: 41.17,
      },
    }, {
      livePrice: 40.975,
    });

    expect(stopLoss).toBe(41.31);
  });

  test('suggested command uses the buffered continuation stop for shared regime shorts', () => {
    const command = buildSuggestedCommand({
      ticker: 'HYPE/USD',
      trigger: 'lose_fail_retest',
      sourceTag: 'shared_regime_auto',
      suggestedMarginUsd: 200,
      suggestedLeverage: 10,
      loseLevel: 40.98,
      retestMin: 40.98,
      retestMax: 41.12,
      metadata: {
        regime: 'shared_short_continuation',
        generatedFromPrice: 40.975,
        generatedStructureHigh: 41.17,
      },
    }, {
      ticker: 'HYPE/USD',
      livePrice: 40.975,
    }, 'fired');

    expect(command).toContain('--stop-loss 41.31');
    expect(command).toContain('--margin 200');
  });

  test('loadRulesConfig restores the broad oracle board from runtime operating rules', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-watch-board-'));
    const rulesPath = path.join(tempDir, 'oracle-watch-rules.json');
    const operatingRulesPath = path.join(tempDir, 'agent-operating-rules.json');

    fs.writeFileSync(rulesPath, JSON.stringify({
      version: 1,
      symbols: ['BTC/USD', 'ETH/USD', 'SOL/USD'],
      rules: [],
    }, null, 2));
    fs.writeFileSync(operatingRulesPath, JSON.stringify({
      roles: {
        oracle: {
          rules: [
            'Primary live scope is the 20-name board used today: ZEREBRO, BIO, MEGA, PNUT, PENDLE, ORDI, ARB, ENA, BTC, ETH, SOL, WLD, XPL, LIT, ZEC, SUI, MON, FARTCOIN, PUMP, kPEPE.',
          ],
        },
      },
    }, null, 2));

    const config = loadRulesConfig(rulesPath, { operatingRulesPath });
    expect(config.symbols).toEqual(expect.arrayContaining([
      'BTC/USD',
      'ETH/USD',
      'SOL/USD',
      'ZEREBRO/USD',
      'PNUT/USD',
      'XPL/USD',
      'KPEPE/USD',
    ]));

    const persisted = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
    expect(persisted.symbols).toEqual(expect.arrayContaining([
      'WLD/USD',
      'ZEC/USD',
      'SUI/USD',
      'FARTCOIN/USD',
      'PUMP/USD',
    ]));
  });

  test('loadRulesConfig canonicalizes drifted manual rule ids and names and migrates watch-state keys', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-watch-rule-identity-'));
    const rulesPath = path.join(tempDir, 'oracle-watch-rules.json');
    const statePath = path.join(tempDir, 'oracle-watch-state.json');

    fs.writeFileSync(rulesPath, JSON.stringify({
      version: 1,
      symbols: ['BTC/USD', 'ETH/USD', 'SOL/USD'],
      rules: [
        {
          id: 'btc-short-lose-75300-fail-retest',
          name: 'BTC short — lose 75300 (5m) then fail retest 75300-75380',
          ticker: 'BTC/USD',
          trigger: 'lose_fail_retest',
          loseLevel: 73697,
          retestMin: 73697,
          retestMax: 73808,
          timeframe: '5m',
        },
      ],
    }, null, 2));
    fs.writeFileSync(statePath, JSON.stringify({
      version: 2,
      rules: {
        'btc-short-lose-75300-fail-retest': {
          status: 'idle',
        },
      },
      staleRules: [
        { ruleId: 'btc-short-lose-75300-fail-retest' },
      ],
    }, null, 2));

    const config = loadRulesConfig(rulesPath, { statePath });
    const persistedRules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
    const persistedState = JSON.parse(fs.readFileSync(statePath, 'utf8'));

    expect(config.rules[0]).toEqual(expect.objectContaining({
      id: 'btc-short-lose-73697-fail-retest',
      name: 'BTC short — lose 73697 (5m) then fail retest 73697-73808',
    }));
    expect(persistedRules.rules[0]).toEqual(expect.objectContaining({
      id: 'btc-short-lose-73697-fail-retest',
      name: 'BTC short — lose 73697 (5m) then fail retest 73697-73808',
    }));
    expect(persistedState.rules['btc-short-lose-73697-fail-retest']).toEqual(expect.objectContaining({
      status: 'idle',
    }));
    expect(persistedState.rules['btc-short-lose-75300-fail-retest']).toBeUndefined();
    expect(persistedState.staleRules[0].ruleId).toBe('btc-short-lose-73697-fail-retest');
  });

  test('evaluateReclaimHold arms and then fires after two closes above the reclaim line', () => {
    const rule = {
      id: 'btc-reclaim',
      ticker: 'BTC/USD',
      trigger: 'reclaim_hold',
      level: 74020,
      confirmCloses: 2,
      enabled: true,
    };

    const armed = evaluateReclaimHold(rule, {
      bars1m: [
        { close: 73980 },
        { close: 74025 },
      ],
    }, {}, Date.now());
    expect(armed.events).toEqual(['armed']);

    const fired = evaluateReclaimHold(rule, {
      bars1m: [
        { close: 73980 },
        { close: 74025 },
        { close: 74040 },
      ],
    }, { status: 'armed' }, Date.now());
    expect(fired.events).toEqual(['fired']);
  });

  test('evaluateRelativeStrength fires when alt stays green while BTC is red on the same 5m bar', () => {
    const result = evaluateRelativeStrength({
      id: 'sol-vs-btc',
      ticker: 'SOL/USD',
      trigger: 'relative_strength',
      anchorTicker: 'BTC/USD',
      altMinChangePct: 0.002,
      anchorMaxChangePct: -0.001,
    }, {
      bar5m: { open: 100, close: 100.5 },
    }, {
      bar5m: { open: 100, close: 99.7 },
    }, {}, Date.now());

    expect(result.events).toEqual(['fired']);
  });

  test('decideOraclePositionManagementAction closes when exchange protection is not verified', () => {
    const decision = decideOraclePositionManagementAction({
      ticker: 'HYPE/USD',
      side: 'short',
      size: -15.76,
      avgPrice: 40.975,
      unrealizedPnl: 3.2,
    }, {
      market: { price: 40.81 },
      bars1m: [
        { close: 40.82 },
        { close: 40.81 },
      ],
    }, {
      verified: false,
      activeStopPrice: null,
      activeTakeProfitPrice: null,
    });

    expect(decision).toEqual(expect.objectContaining({
      action: 'close',
      reason: 'protection_fault',
      closePct: 100,
    }));
  });

  test('decideOraclePositionManagementAction tightens profitable shorts when 1m structure starts bouncing against them', () => {
    const decision = decideOraclePositionManagementAction({
      ticker: 'HYPE/USD',
      side: 'short',
      size: -15.76,
      avgPrice: 40.975,
      unrealizedPnl: 4.8,
    }, {
      market: { price: 40.86 },
      bars1m: [
        { close: 40.82 },
        { close: 40.86 },
      ],
    }, {
      verified: true,
      activeStopPrice: 41.31,
      activeTakeProfitPrice: 40.4,
    });

    expect(decision).toEqual(expect.objectContaining({
      action: 'tighten',
      reason: 'profitable_reversal_against_position',
      trailPct: 0.6,
    }));
  });

  test('relative-strength alerts stay watch-only outside the valid SOL chart-location zones', () => {
    const message = formatOracleAlert('armed', {
      id: 'sol-relative-strength-vs-btc',
      ticker: 'SOL/USD',
      trigger: 'relative_strength',
      chartLocation: {
        bias: 'long_only',
        dayRange: { min: 89.0, max: 90.0 },
        validLongZones: [
          { label: 'support_reclaim', min: 89.0, max: 89.1 },
          { label: 'breakout_reclaim', min: 89.7, max: 89.8 },
        ],
        invalidLabel: 'midrange_watch_only',
        invalidNote: 'SOL relative strength is watch-only here.',
      },
    }, {
      ticker: 'SOL/USD',
      trigger: 'SOL green while BTC red over same 5m window',
      livePrice: 89.48,
    }, 'normal');

    expect(message).toContain('"executionReady":false');
    expect(message).toContain('"label":"midrange_watch_only"');
    expect(message).toContain('"command":null');
  });

  test('runWatchCycle sends a direct oracle alert with compact payload when a reclaim rule fires', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-watch-engine-'));
    const rulesPath = path.join(tempDir, 'oracle-watch-rules.json');
    const statePath = path.join(tempDir, 'oracle-watch-state.json');

    fs.writeFileSync(rulesPath, JSON.stringify({
      version: 1,
      mode: 'normal',
      targets: ['oracle'],
      symbols: ['BTC/USD', 'ETH/USD', 'SOL/USD'],
      hotSymbols: [],
      rules: [
        {
          id: 'btc-reclaim-74020',
          name: 'BTC reclaim above 74020 and hold 2x 1m closes',
          enabled: true,
          ticker: 'BTC/USD',
          trigger: 'reclaim_hold',
          level: 74020,
          confirmCloses: 2,
          suggestedMarginUsd: 200,
          cooldownMs: 600000,
        },
      ],
    }, null, 2));

    hyperliquidClient.getUniverseMarketData.mockResolvedValue([
      {
        coin: 'BTC',
        ticker: 'BTC/USD',
        price: 74045,
        fundingRate: -0.00003,
        openInterest: 1250000,
      },
      {
        coin: 'ETH',
        ticker: 'ETH/USD',
        price: 2325,
        fundingRate: -0.00001,
        openInterest: 500000,
      },
      {
        coin: 'SOL',
        ticker: 'SOL/USD',
        price: 86.5,
        fundingRate: -0.00001,
        openInterest: 300000,
      },
    ]);
    hyperliquidClient.getHistoricalBars
      .mockResolvedValueOnce(new Map([
        ['BTC/USD', [
          { close: 73980, high: 74000, low: 73950, open: 73970 },
          { close: 74030, high: 74035, low: 74005, open: 73990 },
          { close: 74045, high: 74050, low: 74020, open: 74020 },
        ]],
        ['ETH/USD', []],
        ['SOL/USD', []],
      ]))
      .mockResolvedValueOnce(new Map([
        ['BTC/USD', [
          { open: 73990, high: 74050, low: 73980, close: 74045 },
        ]],
        ['ETH/USD', []],
        ['SOL/USD', []],
      ]));
    hyperliquidClient.getPredictedFundings.mockResolvedValue({
      byCoin: {
        BTC: { fundingRate: -0.00003 },
      },
    });
    hyperliquidClient.getOpenPositions.mockResolvedValue([]);
    hyperliquidClient.getL2Book.mockResolvedValue({
      nearTouchSkew: 'bid_heavy',
      depthImbalanceTop5: 0.22,
      bestBid: 74044,
      bestAsk: 74046,
    });

    const result = await runWatchCycle({
      rulesPath,
      statePath,
    });
    const persistedState = JSON.parse(fs.readFileSync(statePath, 'utf8'));

    expect(result.alertCount).toBe(1);
    expect(persistedState.heartbeat).toEqual(expect.objectContaining({
      lastTickAt: expect.any(String),
      stale: false,
      state: 'green',
    }));
    expect(persistedState.counters).toEqual(expect.objectContaining({
      triggersSeen: 1,
      triggersFired: 1,
      alertsSent: 1,
    }));
    expect(sendAgentAlert).toHaveBeenCalledWith(
      expect.stringContaining('"ticker":"BTC/USD"'),
      expect.objectContaining({
        role: 'oracle-watch',
        targets: ['oracle'],
      })
    );
    expect(sendAgentAlert).toHaveBeenCalledWith(
      expect.stringContaining('(ORACLE WATCH):'),
      expect.any(Object)
    );
    expect(sendAgentAlert).toHaveBeenCalledWith(
      expect.stringContaining('hm-defi-execute.js trade --asset BTC --direction LONG'),
      expect.any(Object)
    );
    expect(execFileSync).not.toHaveBeenCalled();

    await watchRulesCli(['mark-acted', 'btc-reclaim-74020', '--state', statePath, '--note', 'Oracle called it']);
    const actedState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    expect(actedState.counters.triggersActedOn).toBe(1);
    expect(actedState.rules['btc-reclaim-74020']).toEqual(expect.objectContaining({
      actedOnCount: 1,
      actedOnNote: 'Oracle called it',
    }));
  });

  test('runWatchCycle auto-attempts a fired rule through hm-defi-execute when live auto-execution is enabled', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-watch-engine-autoexec-'));
    const rulesPath = path.join(tempDir, 'oracle-watch-rules.json');
    const statePath = path.join(tempDir, 'oracle-watch-state.json');
    const hardRiskStatePath = path.join(tempDir, 'hard-risk-state.json');

    fs.writeFileSync(rulesPath, JSON.stringify({
      version: 1,
      mode: 'normal',
      targets: ['oracle'],
      symbols: ['ORDI/USD'],
      hotSymbols: [],
      rules: [
        {
          id: 'shared-regime-auto-short-ordi',
          name: 'ORDI shared short regime — lose 4.1772 then fail retest 4.1772-4.1917',
          enabled: true,
          ticker: 'ORDI/USD',
          trigger: 'lose_fail_retest',
          loseLevel: 4.1772,
          retestMin: 4.1772,
          retestMax: 4.1917,
          suggestedMarginUsd: 200,
          suggestedLeverage: 10,
          cooldownMs: 600000,
          sourceTag: 'shared_regime_auto',
        },
      ],
    }, null, 2));
    fs.writeFileSync(statePath, JSON.stringify({
      version: 2,
      updatedAt: null,
      mode: 'normal',
      heartbeat: {
        lastTickAt: null,
        intervalMs: 120000,
        stale: false,
        state: 'green',
      },
      counters: {},
      marketByTicker: {},
      rules: {
        'shared-regime-auto-short-ordi': {
          status: 'armed',
          armedAt: Date.now() - 30_000,
        },
      },
    }, null, 2));
    fs.writeFileSync(hardRiskStatePath, JSON.stringify({
      mode: 'normal',
      updatedAt: new Date().toISOString(),
      remainingLossBudgetUsd: 100,
      remainingPerTradeMarginCapUsd: 250,
    }, null, 2));

    hyperliquidClient.getUniverseMarketData.mockResolvedValue([
      {
        coin: 'ORDI',
        ticker: 'ORDI/USD',
        price: 4.1837,
        fundingRate: 0.0000125,
        openInterest: 639811.78,
      },
    ]);
    hyperliquidClient.getHistoricalBars
      .mockResolvedValueOnce(new Map([
        ['ORDI/USD', [
          { open: 4.186, high: 4.1925, low: 4.1762, close: 4.1765 },
          { open: 4.1765, high: 4.1919, low: 4.1759, close: 4.1761 },
        ]],
      ]))
      .mockResolvedValueOnce(new Map([
        ['ORDI/USD', [
          { open: 4.1765, high: 4.1925, low: 4.1759, close: 4.1837 },
        ]],
      ]));
    hyperliquidClient.getPredictedFundings.mockResolvedValue({
      byCoin: {
        ORDI: { fundingRate: 0.0000125 },
      },
    });
    hyperliquidClient.getOpenPositions.mockResolvedValue([]);
    hyperliquidClient.getL2Book.mockResolvedValue({
      nearTouchSkew: 'balanced',
      depthImbalanceTop5: 0.01,
      bestBid: 4.1835,
      bestAsk: 4.1837,
    });

    const result = await runWatchCycle({
      rulesPath,
      statePath,
      hardRiskStatePath,
      autoExecuteFiredSignals: true,
      sendAlerts: false,
    });
    const persistedState = JSON.parse(fs.readFileSync(statePath, 'utf8'));

    expect(result.alertCount).toBe(1);
    expect(result.executionResult).toEqual(expect.objectContaining({
      attempted: 1,
      executions: [
        expect.objectContaining({
          ruleId: 'shared-regime-auto-short-ordi',
          ticker: 'ORDI/USD',
          status: 'filled_protected',
          marginUsd: 200,
          leverage: 10,
          minMarginUsd: 200,
          requestedMarginUsd: 200,
          stopLossPrice: 4.2063,
        }),
      ],
    }));
    expect(hmDefiExecute.openHyperliquidPosition).toHaveBeenCalledWith(expect.objectContaining({
      asset: 'ORDI',
      requestedDirection: 'SHORT',
      directionInput: 'SHORT',
      margin: 200,
      leverage: 10,
      stopLossPrice: 4.2063,
      strategyLane: 'oracle_watch',
      originatingAgentId: 'oracle',
      attributionSource: 'oracle_watch_auto',
    }));
    expect(persistedState.counters).toEqual(expect.objectContaining({
      triggersActedOn: 1,
      lastCycleActedOn: 1,
    }));
    expect(persistedState.rules['shared-regime-auto-short-ordi']).toEqual(expect.objectContaining({
      actedOnCount: 1,
      actedOnNote: 'filled_protected',
      execution: expect.objectContaining({
        status: 'filled_protected',
        marginUsd: 200,
      }),
    }));
  });

  test('runWatchCycle clears carried-forward shared-regime fires instead of leaving queue-head hang state', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-watch-engine-carry-clear-'));
    const rulesPath = path.join(tempDir, 'oracle-watch-rules.json');
    const statePath = path.join(tempDir, 'oracle-watch-state.json');
    const hardRiskStatePath = path.join(tempDir, 'hard-risk-state.json');

    fs.writeFileSync(rulesPath, JSON.stringify({
      version: 1,
      mode: 'normal',
      targets: ['oracle'],
      symbols: ['ORDI/USD'],
      hotSymbols: [],
      rules: [
        {
          id: 'shared-regime-auto-short-ordi',
          name: 'ORDI shared short regime',
          enabled: true,
          ticker: 'ORDI/USD',
          trigger: 'lose_fail_retest',
          loseLevel: 4.1772,
          retestMin: 4.1772,
          retestMax: 4.1917,
          suggestedMarginUsd: 200,
          suggestedLeverage: 10,
          cooldownMs: 600000,
          sourceTag: 'shared_regime_auto',
        },
      ],
    }, null, 2));
    fs.writeFileSync(statePath, JSON.stringify({
      version: 2,
      updatedAt: null,
      mode: 'normal',
      heartbeat: {
        lastTickAt: null,
        intervalMs: 120000,
        stale: false,
        state: 'green',
      },
      counters: {},
      marketByTicker: {
        'ORDI/USD': {
          price: 4.0757,
          openInterest: 800122.99,
          fundingRate: -0.0000023,
          checkedAt: new Date().toISOString(),
        },
      },
      rules: {
        'shared-regime-auto-short-ordi': {
          status: 'fired',
          firedAt: Date.now() - 30_000,
          lastEventAt: new Date(Date.now() - 30_000).toISOString(),
          actedOnCount: 0,
        },
      },
    }, null, 2));
    fs.writeFileSync(hardRiskStatePath, JSON.stringify({
      mode: 'normal',
      updatedAt: new Date().toISOString(),
      remainingLossBudgetUsd: 100,
      remainingPerTradeMarginCapUsd: 154.99,
    }, null, 2));

    hyperliquidClient.getUniverseMarketData.mockResolvedValue([
      {
        coin: 'ORDI',
        ticker: 'ORDI/USD',
        price: 4.0757,
        fundingRate: -0.0000023,
        openInterest: 800122.99,
      },
    ]);
    hyperliquidClient.getHistoricalBars.mockResolvedValueOnce(new Map([
      ['ORDI/USD', []],
    ])).mockResolvedValueOnce(new Map([
      ['ORDI/USD', []],
    ]));
    hyperliquidClient.getPredictedFundings.mockResolvedValue({
      byCoin: {
        ORDI: { fundingRate: -0.0000023 },
      },
    });
    hyperliquidClient.getOpenPositions.mockResolvedValue([]);
    hyperliquidClient.getL2Book.mockResolvedValue(null);

    const result = await runWatchCycle({
      rulesPath,
      statePath,
      hardRiskStatePath,
      autoExecuteFiredSignals: true,
      sendAlerts: false,
    });
    const persistedState = JSON.parse(fs.readFileSync(statePath, 'utf8'));

    expect(result.executionResult).toEqual(expect.objectContaining({
      attempted: 0,
      executions: [
        expect.objectContaining({
          ruleId: 'shared-regime-auto-short-ordi',
          status: 'invalidated_missed_same_cycle',
          carriedForward: true,
        }),
      ],
    }));
    expect(hmDefiExecute.openHyperliquidPosition).not.toHaveBeenCalled();
    expect(persistedState.rules['shared-regime-auto-short-ordi']).toEqual(expect.objectContaining({
      status: 'idle',
      actedOnCount: 0,
      actedOnNote: 'invalidated_missed_same_cycle',
      execution: expect.objectContaining({
        status: 'invalidated_missed_same_cycle',
        carriedForward: true,
      }),
    }));
  });

  test('runWatchCycle preserves fired truth but defers toy-size auto execution below the mission floor', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-watch-engine-floor-'));
    const rulesPath = path.join(tempDir, 'oracle-watch-rules.json');
    const statePath = path.join(tempDir, 'oracle-watch-state.json');
    const hardRiskStatePath = path.join(tempDir, 'hard-risk-state.json');

    fs.writeFileSync(rulesPath, JSON.stringify({
      version: 1,
      mode: 'normal',
      targets: ['oracle'],
      symbols: ['SAGA/USD'],
      hotSymbols: [],
      rules: [
        {
          id: 'shared-regime-auto-short-saga',
          name: 'SAGA shared short regime — lose 0.0191 then fail retest 0.0191-0.01917',
          enabled: true,
          ticker: 'SAGA/USD',
          trigger: 'lose_fail_retest',
          loseLevel: 0.0191,
          retestMin: 0.0191,
          retestMax: 0.01917,
          suggestedMarginUsd: 35,
          suggestedLeverage: 7,
          cooldownMs: 600000,
          sourceTag: 'shared_regime_auto',
        },
      ],
    }, null, 2));
    fs.writeFileSync(statePath, JSON.stringify({
      version: 2,
      updatedAt: null,
      mode: 'normal',
      heartbeat: {
        lastTickAt: null,
        intervalMs: 120000,
        stale: false,
        state: 'green',
      },
      counters: {},
      marketByTicker: {},
      rules: {
        'shared-regime-auto-short-saga': {
          status: 'armed',
          armedAt: Date.now() - 30000,
        },
      },
    }, null, 2));
    fs.writeFileSync(hardRiskStatePath, JSON.stringify({
      mode: 'normal',
      updatedAt: new Date().toISOString(),
      remainingLossBudgetUsd: 100,
      remainingPerTradeMarginCapUsd: 64.58,
    }, null, 2));

    hyperliquidClient.getUniverseMarketData.mockResolvedValue([
      {
        coin: 'SAGA',
        ticker: 'SAGA/USD',
        price: 0.01902,
        fundingRate: -0.000019,
        openInterest: 99904761.4,
      },
    ]);
    hyperliquidClient.getHistoricalBars
      .mockResolvedValueOnce(new Map([
        ['SAGA/USD', [
          { open: 0.0192, high: 0.01921, low: 0.01901, close: 0.01903 },
          { open: 0.01903, high: 0.01917, low: 0.01898, close: 0.01902 },
        ]],
      ]))
      .mockResolvedValueOnce(new Map([
        ['SAGA/USD', [
          { open: 0.01903, high: 0.01917, low: 0.01898, close: 0.01902 },
        ]],
      ]));
    hyperliquidClient.getPredictedFundings.mockResolvedValue({
      byCoin: {
        SAGA: { fundingRate: -0.000019 },
      },
    });
    hyperliquidClient.getOpenPositions.mockResolvedValue([]);
    hyperliquidClient.getL2Book.mockResolvedValue({
      nearTouchSkew: 'balanced',
      depthImbalanceTop5: 0.01,
      bestBid: 0.01901,
      bestAsk: 0.01902,
    });

    const result = await runWatchCycle({
      rulesPath,
      statePath,
      hardRiskStatePath,
      autoExecuteFiredSignals: true,
      sendAlerts: false,
    });
    const persistedState = JSON.parse(fs.readFileSync(statePath, 'utf8'));

    expect(result.alertCount).toBe(1);
    expect(result.executionResult).toEqual(expect.objectContaining({
      attempted: 0,
      executions: [
        expect.objectContaining({
          ruleId: 'shared-regime-auto-short-saga',
          status: 'deferred_below_mission_floor',
          requestedMarginUsd: 35,
          minMarginUsd: 200,
          marginUsd: null,
        }),
      ],
    }));
    expect(hmDefiExecute.openHyperliquidPosition).not.toHaveBeenCalled();
    expect(persistedState.rules['shared-regime-auto-short-saga']).toEqual(expect.objectContaining({
      status: 'idle',
      actedOnCount: 0,
      actedOnNote: 'deferred_below_mission_floor',
      execution: expect.objectContaining({
        status: 'deferred_below_mission_floor',
        requestedMarginUsd: 35,
        minMarginUsd: 200,
        marginUsd: null,
      }),
    }));
  });

  test('runWatchCycle blocks sub-floor auto execution even when a stale rule is marked manual override', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-watch-engine-manual-override-'));
    const rulesPath = path.join(tempDir, 'oracle-watch-rules.json');
    const statePath = path.join(tempDir, 'oracle-watch-state.json');
    const hardRiskStatePath = path.join(tempDir, 'hard-risk-state.json');

    fs.writeFileSync(rulesPath, JSON.stringify({
      version: 1,
      mode: 'normal',
      targets: ['oracle'],
      symbols: ['HYPE/USD'],
      hotSymbols: [],
      rules: [
        {
          id: 'shared-regime-auto-short-hype',
          name: 'HYPE shared short regime — lose 41.018 then fail retest 41.018-41.12',
          enabled: true,
          ticker: 'HYPE/USD',
          trigger: 'lose_fail_retest',
          loseLevel: 41.018,
          retestMin: 41.018,
          retestMax: 41.12,
          suggestedMarginUsd: 90,
          suggestedLeverage: 10,
          cooldownMs: 600000,
          sourceTag: 'shared_regime_auto',
          manualOverride: true,
        },
      ],
    }, null, 2));
    fs.writeFileSync(statePath, JSON.stringify({
      version: 2,
      updatedAt: null,
      mode: 'normal',
      heartbeat: {
        lastTickAt: null,
        intervalMs: 120000,
        stale: false,
        state: 'green',
      },
      counters: {},
      marketByTicker: {},
      rules: {
        'shared-regime-auto-short-hype': {
          status: 'armed',
          armedAt: Date.now() - 30000,
        },
      },
    }, null, 2));
    fs.writeFileSync(hardRiskStatePath, JSON.stringify({
      mode: 'normal',
      updatedAt: new Date().toISOString(),
      remainingLossBudgetUsd: 100,
      remainingPerTradeMarginCapUsd: 125,
    }, null, 2));

    hyperliquidClient.getUniverseMarketData.mockResolvedValue([
      {
        coin: 'HYPE',
        ticker: 'HYPE/USD',
        price: 40.9645,
        fundingRate: 0.0000125,
        openInterest: 19292688.3,
      },
    ]);
    hyperliquidClient.getHistoricalBars
      .mockResolvedValueOnce(new Map([
        ['HYPE/USD', [
          { open: 40.996, high: 41.12, low: 40.961, close: 40.961 },
          { open: 40.961, high: 41.02, low: 40.96, close: 40.9645 },
        ]],
      ]))
      .mockResolvedValueOnce(new Map([
        ['HYPE/USD', [
          { open: 40.962, high: 40.962, low: 40.96, close: 40.961 },
        ]],
      ]));
    hyperliquidClient.getPredictedFundings.mockResolvedValue({
      byCoin: {
        HYPE: { fundingRate: 0.0000125 },
      },
    });
    hyperliquidClient.getOpenPositions.mockResolvedValue([]);
    hyperliquidClient.getL2Book.mockResolvedValue({
      nearTouchSkew: 'ask_heavy',
      depthImbalanceTop5: -0.78,
      bestBid: 40.963,
      bestAsk: 40.966,
    });

    const result = await runWatchCycle({
      rulesPath,
      statePath,
      hardRiskStatePath,
      autoExecuteFiredSignals: true,
      sendAlerts: false,
    });
    expect(result.executionResult).toEqual(expect.objectContaining({
      attempted: 0,
      executions: [
        expect.objectContaining({
          ruleId: 'shared-regime-auto-short-hype',
          status: 'deferred_below_mission_floor',
          requestedMarginUsd: 90,
          minMarginUsd: 200,
          marginUsd: null,
        }),
      ],
    }));
    expect(hmDefiExecute.openHyperliquidPosition).not.toHaveBeenCalled();
  });

  test('runWatchCycle reviews oracle-owned live positions and actuates a tighten decision through hm-trailing-stop', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-watch-engine-position-mgmt-'));
    const rulesPath = path.join(tempDir, 'oracle-watch-rules.json');
    const statePath = path.join(tempDir, 'oracle-watch-state.json');

    fs.writeFileSync(rulesPath, JSON.stringify({
      version: 1,
      mode: 'normal',
      targets: ['oracle'],
      symbols: ['HYPE/USD'],
      hotSymbols: [],
      rules: [],
    }, null, 2));

    hyperliquidClient.getUniverseMarketData.mockResolvedValue([
      {
        coin: 'HYPE',
        ticker: 'HYPE/USD',
        price: 40.86,
        fundingRate: 0.0000125,
        openInterest: 19292688.3,
      },
    ]);
    hyperliquidClient.getHistoricalBars
      .mockResolvedValueOnce(new Map([
        ['HYPE/USD', [
          { open: 40.84, high: 40.845, low: 40.81, close: 40.82 },
          { open: 40.82, high: 40.87, low: 40.81, close: 40.86 },
        ]],
      ]))
      .mockResolvedValueOnce(new Map([
        ['HYPE/USD', [
          { open: 40.9, high: 40.95, low: 40.8, close: 40.86 },
        ]],
      ]));
    hyperliquidClient.getPredictedFundings.mockResolvedValue({
      byCoin: {
        HYPE: { fundingRate: 0.0000125 },
      },
    });
    hyperliquidClient.getOpenPositions.mockResolvedValue([
      {
        ticker: 'HYPE/USD',
        coin: 'HYPE',
        size: -15.76,
        avgPrice: 40.975,
        unrealizedPnl: 4.8,
        side: 'short',
        agentId: 'oracle',
      },
    ]);
    hyperliquidClient.getOpenOrders.mockResolvedValue([
      {
        coin: 'HYPE',
        triggerPx: 41.31,
        limitPx: 41.35,
        sz: 15.76,
        reduceOnly: true,
        oid: 'stop-1',
      },
      {
        coin: 'HYPE',
        triggerPx: 40.4,
        limitPx: 40.39,
        sz: 7.88,
        reduceOnly: true,
        oid: 'tp-1',
      },
    ]);

    const result = await runWatchCycle({
      rulesPath,
      statePath,
      autoExecuteFiredSignals: false,
      manageOracleOwnedPositions: true,
      sendAlerts: false,
    });
    const persistedState = JSON.parse(fs.readFileSync(statePath, 'utf8'));

    expect(hmTrailingStop.manageTrailingStop).toHaveBeenCalledWith(expect.objectContaining({
      asset: 'HYPE',
      trailPct: 0.6,
      dryRun: false,
    }));
    expect(result.positionManagement).toEqual(expect.objectContaining({
      reviewed: 1,
      acted: 1,
      actions: [
        expect.objectContaining({
          ticker: 'HYPE/USD',
          action: 'tighten',
          status: 'tightened',
          protectionVerified: true,
          activeStopPrice: 41.31,
          activeTakeProfitPrice: 40.4,
        }),
      ],
    }));
    expect(persistedState.positionManagement).toEqual(expect.objectContaining({
      reviewed: 1,
      acted: 1,
      actions: [
        expect.objectContaining({
          ticker: 'HYPE/USD',
          action: 'tighten',
          status: 'tightened',
        }),
      ],
    }));
  });

  test('runWatchCycle persists a red degraded state when market fetch fails instead of freezing the last good tick', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-watch-engine-fail-'));
    const rulesPath = path.join(tempDir, 'oracle-watch-rules.json');
    const statePath = path.join(tempDir, 'oracle-watch-state.json');
    const frozenAt = '2026-04-16T21:29:34.168Z';

    fs.writeFileSync(rulesPath, JSON.stringify({
      version: 1,
      mode: 'normal',
      pollIntervalMs: 10000,
      targets: ['oracle'],
      symbols: ['BTC/USD', 'ETH/USD', 'SOL/USD'],
      hotSymbols: [],
      rules: [],
    }, null, 2));
    fs.writeFileSync(statePath, JSON.stringify({
      version: 2,
      updatedAt: frozenAt,
      mode: 'normal',
      heartbeat: {
        lastTickAt: frozenAt,
        intervalMs: 10000,
        stale: false,
        state: 'green',
      },
      counters: {},
      marketByTicker: {},
      rules: {},
    }, null, 2));

    hyperliquidClient.getUniverseMarketData.mockRejectedValue(new Error('HttpRequestError: 429 Too Many Requests'));

    const result = await runWatchCycle({
      rulesPath,
      statePath,
    });
    const persistedState = JSON.parse(fs.readFileSync(statePath, 'utf8'));

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: 'backoff',
      statePath,
      nextPollMs: expect.any(Number),
    }));
    expect(persistedState.updatedAt).not.toBe(frozenAt);
    expect(persistedState.heartbeat).toEqual(expect.objectContaining({
      lastTickAt: expect.any(String),
      stale: false,
      state: 'backoff',
      lastErrorAt: expect.any(String),
      backoffUntil: expect.any(String),
    }));
    expect(persistedState.heartbeat.lastTickAt).not.toBe(frozenAt);
    expect(persistedState.rateLimit).toEqual(expect.objectContaining({
      consecutive429s: 1,
      backoffUntil: expect.any(String),
    }));
    expect(persistedState.lastError).toContain('429');
    expect(sendAgentAlert).not.toHaveBeenCalled();
    expect(execFileSync).not.toHaveBeenCalled();
  });

  test('runWatchCycle skips repeat venue calls while 429 backoff is active', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-watch-engine-backoff-'));
    const rulesPath = path.join(tempDir, 'oracle-watch-rules.json');
    const statePath = path.join(tempDir, 'oracle-watch-state.json');

    fs.writeFileSync(rulesPath, JSON.stringify({
      version: 1,
      mode: 'normal',
      pollIntervalMs: 30000,
      targets: ['oracle'],
      symbols: ['BTC/USD'],
      hotSymbols: [],
      rules: [],
    }, null, 2));
    fs.writeFileSync(statePath, JSON.stringify({
      version: 3,
      updatedAt: null,
      mode: 'normal',
      heartbeat: {
        lastTickAt: null,
        intervalMs: 30000,
        stale: false,
        state: 'idle',
      },
      counters: {},
      rateLimit: {
        consecutive429s: 1,
        backoffUntil: new Date(Date.now() + 120000).toISOString(),
        last429At: new Date().toISOString(),
        lastBackoffMs: 120000,
        lastError: '429',
      },
      marketByTicker: {},
      rules: {},
      staleRules: [],
    }, null, 2));

    const result = await runWatchCycle({
      rulesPath,
      statePath,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      status: 'backoff',
      nextPollMs: expect.any(Number),
    }));
    expect(hyperliquidClient.getUniverseMarketData).not.toHaveBeenCalled();
    expect(hyperliquidClient.getHistoricalBars).not.toHaveBeenCalled();
  });

  test('runWatchCycle degrades with cached context while 429 backoff is active', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-watch-engine-degraded-active-'));
    const rulesPath = path.join(tempDir, 'oracle-watch-rules.json');
    const statePath = path.join(tempDir, 'oracle-watch-state.json');
    const snapshotAt = new Date(Date.now() - 45_000).toISOString();

    fs.writeFileSync(rulesPath, JSON.stringify({
      version: 1,
      mode: 'normal',
      pollIntervalMs: 30000,
      targets: ['oracle'],
      symbols: ['BTC/USD'],
      hotSymbols: [],
      rules: [],
    }, null, 2));
    fs.writeFileSync(statePath, JSON.stringify({
      version: 3,
      updatedAt: null,
      mode: 'normal',
      heartbeat: {
        lastTickAt: snapshotAt,
        intervalMs: 30000,
        stale: false,
        state: 'green',
      },
      counters: {},
      rateLimit: {
        consecutive429s: 1,
        backoffUntil: new Date(Date.now() + 120000).toISOString(),
        last429At: new Date().toISOString(),
        lastBackoffMs: 120000,
        lastError: '429',
      },
      marketByTicker: {},
      watchContextSnapshot: {
        capturedAt: snapshotAt,
        tickers: ['BTC/USD'],
        marketByTicker: {
          'BTC/USD': {
            price: 74200,
            openInterest: 1200000,
            fundingRate: -0.00002,
            checkedAt: snapshotAt,
          },
        },
        byTicker: {
          'BTC/USD': {
            ticker: 'BTC/USD',
            coin: 'BTC',
            market: { ticker: 'BTC/USD', price: 74200 },
            predictedFunding: null,
            hasLivePosition: false,
            latest1mClose: 74210,
            latest5mClose: 74205,
            latest5mBarAt: snapshotAt,
          },
        },
        openPositions: [],
      },
      rules: {},
      staleRules: [],
    }, null, 2));

    const result = await runWatchCycle({
      rulesPath,
      statePath,
    });
    const persistedState = JSON.parse(fs.readFileSync(statePath, 'utf8'));

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      status: 'degraded',
      cachedContextAgeMs: expect.any(Number),
      nextPollMs: expect.any(Number),
      tickers: ['BTC/USD'],
    }));
    expect(persistedState.heartbeat).toEqual(expect.objectContaining({
      lastTickAt: expect.any(String),
      state: 'degraded_backoff',
      degradedFromSnapshotAt: snapshotAt,
      degradedSnapshotAgeMs: expect.any(Number),
    }));
    expect(persistedState.heartbeat.lastTickAt).not.toBe(snapshotAt);
    expect(persistedState.marketByTicker).toEqual(expect.objectContaining({
      'BTC/USD': expect.objectContaining({
        price: 74200,
      }),
    }));
    expect(hyperliquidClient.getUniverseMarketData).not.toHaveBeenCalled();
    expect(hyperliquidClient.getHistoricalBars).not.toHaveBeenCalled();
  });

  test('runWatchCycle degrades after a fresh 429 when cached context exists', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-watch-engine-degraded-fresh-'));
    const rulesPath = path.join(tempDir, 'oracle-watch-rules.json');
    const statePath = path.join(tempDir, 'oracle-watch-state.json');
    const snapshotAt = new Date(Date.now() - 30_000).toISOString();

    fs.writeFileSync(rulesPath, JSON.stringify({
      version: 1,
      mode: 'normal',
      pollIntervalMs: 10000,
      targets: ['oracle'],
      symbols: ['BTC/USD'],
      hotSymbols: [],
      rules: [],
    }, null, 2));
    fs.writeFileSync(statePath, JSON.stringify({
      version: 3,
      updatedAt: null,
      mode: 'normal',
      heartbeat: {
        lastTickAt: snapshotAt,
        intervalMs: 10000,
        stale: false,
        state: 'green',
      },
      counters: {},
      rateLimit: {
        consecutive429s: 0,
        backoffUntil: null,
        last429At: null,
        lastBackoffMs: 0,
        lastError: null,
      },
      marketByTicker: {},
      watchContextSnapshot: {
        capturedAt: snapshotAt,
        tickers: ['BTC/USD'],
        marketByTicker: {
          'BTC/USD': {
            price: 74150,
            openInterest: 1199000,
            fundingRate: -0.00001,
            checkedAt: snapshotAt,
          },
        },
        byTicker: {},
        openPositions: [],
      },
      rules: {},
      staleRules: [],
    }, null, 2));

    hyperliquidClient.getUniverseMarketData.mockImplementation(() => {
      throw new Error('HttpRequestError: 429 Too Many Requests');
    });

    const result = await runWatchCycle({
      rulesPath,
      statePath,
    });
    const persistedState = JSON.parse(fs.readFileSync(statePath, 'utf8'));

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      status: 'degraded',
      cachedContextAgeMs: expect.any(Number),
      nextPollMs: expect.any(Number),
    }));
    expect(persistedState.heartbeat).toEqual(expect.objectContaining({
      lastTickAt: expect.any(String),
      state: 'degraded_backoff',
      degradedFromSnapshotAt: snapshotAt,
    }));
    expect(persistedState.heartbeat.lastTickAt).not.toBe(snapshotAt);
    expect(persistedState.rateLimit).toEqual(expect.objectContaining({
      consecutive429s: 1,
      backoffUntil: expect.any(String),
    }));
    expect(persistedState.marketByTicker).toEqual(expect.objectContaining({
      'BTC/USD': expect.objectContaining({
        price: 74150,
      }),
    }));
  });

  test('runWatchCycle does not fetch L2 books when no rules fire', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-watch-engine-no-l2-'));
    const rulesPath = path.join(tempDir, 'oracle-watch-rules.json');
    const statePath = path.join(tempDir, 'oracle-watch-state.json');

    fs.writeFileSync(rulesPath, JSON.stringify({
      version: 1,
      mode: 'normal',
      targets: ['oracle'],
      symbols: ['BTC/USD'],
      hotSymbols: [],
      rules: [
        {
          id: 'btc-reclaim-74020',
          name: 'BTC reclaim above 74020 and hold 2x 1m closes',
          enabled: true,
          ticker: 'BTC/USD',
          trigger: 'reclaim_hold',
          level: 74020,
          confirmCloses: 2,
          suggestedMarginUsd: 200,
          cooldownMs: 600000,
        },
      ],
    }, null, 2));

    hyperliquidClient.getUniverseMarketData.mockResolvedValue([
      {
        coin: 'BTC',
        ticker: 'BTC/USD',
        price: 73980,
        fundingRate: -0.00003,
        openInterest: 1250000,
      },
    ]);
    hyperliquidClient.getHistoricalBars
      .mockResolvedValueOnce(new Map([
        ['BTC/USD', [
          { close: 73970, high: 73990, low: 73950, open: 73980 },
          { close: 73980, high: 73990, low: 73960, open: 73970 },
        ]],
      ]))
      .mockResolvedValueOnce(new Map([
        ['BTC/USD', [
          { open: 73980, high: 73990, low: 73950, close: 73980 },
        ]],
      ]));
    hyperliquidClient.getPredictedFundings.mockResolvedValue({
      byCoin: {
        BTC: { fundingRate: -0.00003 },
      },
    });
    hyperliquidClient.getOpenPositions.mockResolvedValue([]);

    const result = await runWatchCycle({
      rulesPath,
      statePath,
    });

    expect(result.alertCount).toBe(0);
    expect(hyperliquidClient.getL2Book).not.toHaveBeenCalled();
  });

  test('runWatchCycle invalidates older opposite-direction state on the same ticker', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-watch-engine-conflict-'));
    const rulesPath = path.join(tempDir, 'oracle-watch-rules.json');
    const statePath = path.join(tempDir, 'oracle-watch-state.json');

    fs.writeFileSync(rulesPath, JSON.stringify({
      version: 1,
      mode: 'normal',
      targets: ['oracle'],
      symbols: ['ETH/USD'],
      hotSymbols: [],
      rules: [
        {
          id: 'eth-short-lose-2264-fail-retest',
          name: 'ETH short lose 2264 then fail retest 2264-2279',
          enabled: true,
          ticker: 'ETH/USD',
          trigger: 'lose_fail_retest',
          loseLevel: 2264,
          retestMin: 2264,
          retestMax: 2279,
          cooldownMs: 600000,
        },
        {
          id: 'eth-long-reclaim-2268',
          name: 'ETH long reclaim 2268',
          enabled: true,
          ticker: 'ETH/USD',
          trigger: 'reclaim_hold',
          level: 2268,
          confirmCloses: 2,
          cooldownMs: 600000,
        },
      ],
    }, null, 2));

    fs.writeFileSync(statePath, JSON.stringify({
      version: 2,
      updatedAt: null,
      mode: 'normal',
      heartbeat: {
        lastTickAt: null,
        intervalMs: 120000,
        stale: false,
        state: 'green',
      },
      counters: {},
      marketByTicker: {},
      rules: {
        'eth-short-lose-2264-fail-retest': {
          status: 'fired',
          lastEventType: 'fired',
          lastEventAt: '2026-04-19T22:14:01.023Z',
          firedAt: 1776608041023,
          eventCounts: {
            fired: 1,
          },
        },
        'eth-long-reclaim-2268': {
          status: 'fired',
          lastEventType: 'fired',
          lastEventAt: '2026-04-19T22:39:17.207Z',
          firedAt: 1776609557207,
          eventCounts: {
            fired: 1,
          },
        },
      },
    }, null, 2));

    hyperliquidClient.getUniverseMarketData.mockResolvedValue([
      {
        coin: 'ETH',
        ticker: 'ETH/USD',
        price: 2270.15,
        fundingRate: -0.000015708,
        openInterest: 447284.1666,
      },
    ]);
    hyperliquidClient.getHistoricalBars
      .mockResolvedValueOnce(new Map([
        ['ETH/USD', [
          { open: 2266, high: 2271, low: 2265, close: 2269.4 },
          { open: 2269.4, high: 2271.2, low: 2268.5, close: 2270.15 },
        ]],
      ]))
      .mockResolvedValueOnce(new Map([
        ['ETH/USD', [
          { open: 2262, high: 2271.2, low: 2260, close: 2270.15 },
        ]],
      ]));
    hyperliquidClient.getPredictedFundings.mockResolvedValue({
      byCoin: {
        ETH: { fundingRate: -0.000015708 },
      },
    });
    hyperliquidClient.getOpenPositions.mockResolvedValue([]);

    const result = await runWatchCycle({
      rulesPath,
      statePath,
      sendAlerts: false,
    });
    const persistedState = JSON.parse(fs.readFileSync(statePath, 'utf8'));

    expect(result.ok).toBe(true);
    expect(persistedState.rules['eth-long-reclaim-2268']).toEqual(expect.objectContaining({
      status: 'fired',
      lastEventType: 'fired',
    }));
    expect(persistedState.rules['eth-short-lose-2264-fail-retest']).toEqual(expect.objectContaining({
      status: 'idle',
      lastEventType: 'invalidated',
      conflictResolution: expect.objectContaining({
        status: 'superseded',
        supersededByRuleId: 'eth-long-reclaim-2268',
        supersededByDirection: 'LONG',
      }),
    }));
    expect(persistedState.counters.triggersInvalidated).toBe(1);
  });

  test('runWatchCycle mirrors SUI fired trade alerts to Telegram with a one-line entry summary', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-watch-engine-sui-fire-'));
    const rulesPath = path.join(tempDir, 'oracle-watch-rules.json');
    const statePath = path.join(tempDir, 'oracle-watch-state.json');

    fs.writeFileSync(rulesPath, JSON.stringify({
      version: 1,
      mode: 'normal',
      targets: ['oracle'],
      symbols: ['SUI/USD'],
      hotSymbols: [],
      rules: [
        {
          id: 'sui-short-lose-9633-fail-retest',
          name: 'SUI short — lose 0.9633 then fail retest',
          enabled: true,
          ticker: 'SUI/USD',
          trigger: 'lose_fail_retest',
          loseLevel: 0.9633,
          retestMin: 0.9633,
          retestMax: 0.9650,
          cooldownMs: 600000,
        },
      ],
    }, null, 2));

    fs.writeFileSync(statePath, JSON.stringify({
      version: 2,
      updatedAt: null,
      mode: 'normal',
      heartbeat: {
        lastTickAt: null,
        intervalMs: 10000,
        stale: false,
        state: 'idle',
      },
      counters: {},
      marketByTicker: {},
      rules: {
        'sui-short-lose-9633-fail-retest': {
          status: 'armed',
          armedAt: Date.now() - 30_000,
        },
      },
    }, null, 2));

    hyperliquidClient.getUniverseMarketData.mockResolvedValue([
      {
        coin: 'SUI',
        ticker: 'SUI/USD',
        price: 0.9628,
        fundingRate: -0.0000098,
        openInterest: 18844100.8,
      },
    ]);
    hyperliquidClient.getHistoricalBars
      .mockResolvedValueOnce(new Map([
        ['SUI/USD', [
          { open: 0.9642, high: 0.9649, low: 0.9629, close: 0.9631 },
          { open: 0.9631, high: 0.9647, low: 0.9627, close: 0.9628 },
        ]],
      ]))
      .mockResolvedValueOnce(new Map([
        ['SUI/USD', [
          { open: 0.9644, high: 0.9649, low: 0.9627, close: 0.9628 },
        ]],
      ]));
    hyperliquidClient.getPredictedFundings.mockResolvedValue({ byCoin: { SUI: { fundingRate: -0.0000098 } } });
    hyperliquidClient.getOpenPositions.mockResolvedValue([]);
    hyperliquidClient.getL2Book.mockResolvedValue({
      nearTouchSkew: 'ask_heavy',
      depthImbalanceTop5: -0.18,
      bestBid: 0.9627,
      bestAsk: 0.9628,
    });

    const result = await runWatchCycle({
      rulesPath,
      statePath,
    });

    expect(result.alertCount).toBe(1);
    expect(execFileSync).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining([
        expect.stringContaining('hm-send.js'),
        'telegram',
        expect.stringContaining('TRADE ALERT: SUI SHORT entry confirmed'),
        '--role',
        'oracle-watch',
      ]),
      expect.objectContaining({
        cwd: expect.any(String),
        encoding: 'utf8',
      })
    );
    expect(result.telegramAlertResult).toEqual(expect.objectContaining({
      ok: true,
      sent: 1,
    }));
  });

  test('telegram invalidation alerts escalate to exit-now wording when the live position is on', async () => {
    const message = formatTelegramTradeAlert({
      eventType: 'invalidated',
      ticker: 'SUI/USD',
      rule: {
        trigger: 'lose_fail_retest',
      },
      payload: {
        ticker: 'SUI/USD',
        livePrice: 0.9692,
        hasLivePosition: true,
      },
    });

    expect(message).toContain('TRADE ALERT: SUI SHORT invalidated / hard-stop touch');
    expect(message).toContain('Exit now.');
  });

  test('evaluateRuleStaleness proposes refreshed levels after a rule drifts too far from live price', () => {
    const result = evaluateRuleStaleness({
      id: 'btc-short-lose-75300-fail-retest',
      ticker: 'BTC/USD',
      trigger: 'lose_fail_retest',
      enabled: true,
      loseLevel: 75300,
      retestMin: 75300,
      retestMax: 75380,
    }, {
      market: {
        price: 76500,
      },
      hasLivePosition: false,
    }, {}, {
      enabled: true,
      distancePct: 0.015,
      persistAfterMs: 0,
      loseOffsetPct: 0.006,
      minRetestBandPct: 0.0015,
    }, Date.now());

    expect(result.event).toBe('stale');
    expect(result.summary).toEqual(expect.objectContaining({
      ticker: 'BTC/USD',
      trigger: 'lose_fail_retest',
      proposal: expect.objectContaining({
        mode: 'manual_validation',
        proposedFields: expect.objectContaining({
          loseLevel: expect.any(Number),
          retestMin: expect.any(Number),
          retestMax: expect.any(Number),
        }),
      }),
    }));
    expect(result.summary.distancePct).toBeGreaterThan(0.015);
  });

  test('runWatchCycle persists stale rules and alerts oracle when enabled rules are materially offside', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-watch-engine-stale-'));
    const rulesPath = path.join(tempDir, 'oracle-watch-rules.json');
    const statePath = path.join(tempDir, 'oracle-watch-state.json');

    fs.writeFileSync(rulesPath, JSON.stringify({
      version: 1,
      mode: 'normal',
      staleRulePolicy: {
        enabled: true,
        distancePct: 0.015,
        persistAfterMs: 0,
        loseOffsetPct: 0.006,
        minRetestBandPct: 0.0015,
      },
      targets: ['oracle'],
      symbols: ['BTC/USD'],
      hotSymbols: [],
      rules: [
        {
          id: 'btc-short-lose-75300-fail-retest',
          name: 'BTC short — lose 75300 then fail retest',
          enabled: true,
          ticker: 'BTC/USD',
          trigger: 'lose_fail_retest',
          loseLevel: 75300,
          retestMin: 75300,
          retestMax: 75380,
          cooldownMs: 600000,
        },
      ],
    }, null, 2));

    hyperliquidClient.getUniverseMarketData.mockResolvedValue([
      {
        coin: 'BTC',
        ticker: 'BTC/USD',
        price: 76500,
        fundingRate: -0.00003,
        openInterest: 1250000,
      },
    ]);
    hyperliquidClient.getHistoricalBars
      .mockResolvedValueOnce(new Map([
        ['BTC/USD', [
          { close: 76490, high: 76510, low: 76420, open: 76440 },
          { close: 76500, high: 76530, low: 76470, open: 76490 },
        ]],
      ]))
      .mockResolvedValueOnce(new Map([
        ['BTC/USD', [
          { open: 76440, high: 76530, low: 76420, close: 76500 },
        ]],
      ]));
    hyperliquidClient.getPredictedFundings.mockResolvedValue({
      byCoin: {
        BTC: { fundingRate: -0.00003 },
      },
    });
    hyperliquidClient.getOpenPositions.mockResolvedValue([]);
    hyperliquidClient.getL2Book.mockResolvedValue({
      nearTouchSkew: 'bid_heavy',
      depthImbalanceTop5: 0.12,
      bestBid: 76499,
      bestAsk: 76501,
    });

    const result = await runWatchCycle({
      rulesPath,
      statePath,
    });
    const persistedState = JSON.parse(fs.readFileSync(statePath, 'utf8'));

    expect(result.alertCount).toBe(1);
    expect(persistedState.staleRules).toHaveLength(1);
    expect(persistedState.staleRules[0]).toEqual(expect.objectContaining({
      ticker: 'BTC/USD',
      trigger: 'lose_fail_retest',
      distancePct: expect.any(Number),
    }));
    expect(persistedState.counters).toEqual(expect.objectContaining({
      staleRulesDetected: 1,
      lastCycleStaleCount: 1,
    }));
    expect(sendAgentAlert).toHaveBeenCalledWith(
      expect.stringContaining('"state":"stale"'),
      expect.objectContaining({
        role: 'oracle-watch',
        targets: ['oracle'],
      })
    );

    const currentStaleRules = collectStaleRules(
      JSON.parse(fs.readFileSync(rulesPath, 'utf8')),
      persistedState,
      { persistAfterMs: 0, distancePct: 0.015, nowMs: Date.now() }
    );
    expect(currentStaleRules).toHaveLength(1);
  });
});
