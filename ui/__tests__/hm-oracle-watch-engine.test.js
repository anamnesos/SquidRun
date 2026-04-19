jest.mock('../scripts/hm-agent-alert', () => ({
  sendAgentAlert: jest.fn(() => ({ ok: true, targets: ['oracle'], results: [{ target: 'oracle', ok: true }] })),
}));

jest.mock('child_process', () => ({
  execFileSync: jest.fn(() => 'Delivered to telegram: ok (ack: telegram_delivered, attempt 1)'),
}));

jest.mock('../modules/trading/hyperliquid-client', () => ({
  getUniverseMarketData: jest.fn(),
  getHistoricalBars: jest.fn(),
  getPredictedFundings: jest.fn(),
  getOpenPositions: jest.fn(),
  getL2Book: jest.fn(),
}));

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { sendAgentAlert } = require('../scripts/hm-agent-alert');
const hyperliquidClient = require('../modules/trading/hyperliquid-client');
const {
  evaluateReclaimHold,
  evaluateRelativeStrength,
  evaluateRuleStaleness,
  resolveWatchedTickers,
  runWatchCycle,
  formatOracleAlert,
  formatTelegramTradeAlert,
  collectStaleRules,
} = require('../scripts/hm-oracle-watch-engine');
const { main: watchRulesCli } = require('../scripts/hm-oracle-watch-rules');

describe('hm-oracle-watch-engine', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('resolveWatchedTickers keeps majors plus only two hot symbols', () => {
    expect(resolveWatchedTickers({
      symbols: ['BTC/USD', 'ETH/USD', 'SOL/USD'],
      hotSymbols: ['BIO/USD', 'TURBO/USD', 'PNUT/USD'],
    })).toEqual(['BTC/USD', 'ETH/USD', 'SOL/USD', 'BIO/USD', 'TURBO/USD']);
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
      status: 'failed',
      statePath,
    }));
    expect(persistedState.updatedAt).not.toBe(frozenAt);
    expect(persistedState.heartbeat).toEqual(expect.objectContaining({
      lastTickAt: frozenAt,
      stale: true,
      state: 'red',
      lastErrorAt: expect.any(String),
    }));
    expect(persistedState.lastError).toContain('429');
    expect(sendAgentAlert).not.toHaveBeenCalled();
    expect(execFileSync).not.toHaveBeenCalled();
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
