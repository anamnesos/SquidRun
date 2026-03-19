'use strict';

jest.mock('../data-ingestion', () => ({
  normalizeSymbols: jest.fn((symbols = []) => Array.from(new Set((Array.isArray(symbols) ? symbols : [symbols]).map((symbol) => String(symbol).trim().toUpperCase()).filter(Boolean)))),
  buildWatchlistContext: jest.fn().mockResolvedValue({
    symbols: ['AAPL'],
    snapshots: new Map([
      ['AAPL', { symbol: 'AAPL', tradePrice: 200, dailyVolume: 1000, dailyClose: 198, previousClose: 198 }],
    ]),
    news: [],
  }),
  getWatchlistSnapshots: jest.fn().mockResolvedValue(new Map([
    ['AAPL', { symbol: 'AAPL', tradePrice: 200, dailyVolume: 1000, dailyClose: 198, previousClose: 198 }],
  ])),
  getHistoricalBars: jest.fn().mockResolvedValue(new Map([
    ['AAPL', [
      { symbol: 'AAPL', close: 195, high: 196, low: 194, volume: 1000 },
      { symbol: 'AAPL', close: 198, high: 199, low: 197, volume: 1200 },
      { symbol: 'AAPL', close: 200, high: 201, low: 199, volume: 1400 },
    ]],
  ])),
  getNews: jest.fn().mockResolvedValue([]),
}));

jest.mock('../executor', () => ({
  getAccountSnapshot: jest.fn().mockResolvedValue({ equity: 10000 }),
  getOpenPositions: jest.fn().mockResolvedValue([]),
  executeConsensusTrade: jest.fn().mockResolvedValue({ ok: true, status: 'dry_run', order: { id: 'poly-1' } }),
  syncJournalPositions: jest.fn().mockResolvedValue([]),
}));

jest.mock('../journal', () => ({
  getDb: jest.fn(() => ({ mocked: true })),
  getRecentTrades: jest.fn(() => []),
  recordConsensus: jest.fn(),
}));

jest.mock('../risk-engine', () => ({
  DEFAULT_LIMITS: { maxDrawdownPct: 0.2, maxDailyLossPct: 0.1, maxTradesPerDay: 3, maxOpenPositions: 3, maxPositionPct: 0.05, stopLossPct: 0.03 },
  checkKillSwitch: jest.fn(() => ({ triggered: false, drawdownPct: 0 })),
  checkDailyPause: jest.fn(() => ({ paused: false, dayLossPct: 0 })),
  checkTrade: jest.fn(() => ({ approved: true, violations: [], maxShares: 2, stopLossPrice: 194 })),
}));

jest.mock('../signal-producer', () => ({
  produceSignals: jest.fn(async (agentId, options = {}) => {
    const ticker = (options.symbols || [])[0] || 'AAPL';
    return [{
      ticker,
      direction: agentId === 'builder' ? 'BUY' : 'HOLD',
      confidence: agentId === 'builder' ? 0.64 : 0.55,
      reasoning: `${agentId} fallback`,
      model: `${agentId}-heuristic`,
      timestamp: Date.now(),
    }];
  }),
  registerAllSignals: jest.fn((orchestrator, agentId, signals = []) => {
    return signals.map((signal) => orchestrator.registerSignal(agentId, signal.ticker, signal));
  }),
}));

jest.mock('../consultation-store', () => ({
  DEFAULT_CONSULTATION_TIMEOUT_MS: 60000,
  writeConsultationRequest: jest.fn(() => ({
    requestId: 'consult-live-1',
    path: '/tmp/consult-live-1.json',
    deadline: '2099-03-19T04:00:00.000Z',
    createdAt: '2026-03-19T03:59:00.000Z',
    symbols: ['AAPL'],
  })),
  dispatchConsultationRequests: jest.fn().mockResolvedValue([
    { agentId: 'architect', ok: true },
    { agentId: 'builder', ok: true },
    { agentId: 'oracle', ok: true },
  ]),
  collectConsultationResponses: jest.fn().mockResolvedValue({
    requestId: 'consult-live-1',
    responses: [
      {
        requestId: 'consult-live-1',
        agentId: 'architect',
        signals: [
          { ticker: 'AAPL', direction: 'BUY', confidence: 0.91, reasoning: 'real architect analysis' },
        ],
      },
    ],
    missingAgents: ['builder', 'oracle'],
  }),
}));

jest.mock('../portfolio-tracker', () => ({
  getPortfolioSnapshot: jest.fn().mockResolvedValue({
    totalEquity: 12000,
    positions: [],
    markets: {
      polymarket: {
        equity: 162,
        cash: 162,
        marketValue: 0,
        positions: [],
      },
    },
    risk: {
      peakEquity: 12000,
      dayStartEquity: 12000,
      dailyLossPct: 0,
      totalDrawdownPct: 0,
    },
  }),
}));

jest.mock('../dynamic-watchlist', () => ({
  cloneEntry: jest.fn((entry) => ({ ...entry })),
  getActiveEntries: jest.fn(() => [
    { ticker: 'AAPL', broker: 'alpaca', assetClass: 'us_equity', exchange: 'SMART' },
  ]),
  getEntry: jest.fn(() => null),
  addTicker: jest.fn(() => true),
  isWatched: jest.fn(() => true),
  normalizeBroker: jest.fn((value, fallback = 'alpaca') => value || fallback),
  normalizeExchange: jest.fn((value, fallback = 'SMART') => value || fallback),
  normalizeAssetClass: jest.fn((value, fallback = 'us_equity') => value || fallback),
  DEFAULT_WATCHLIST: [],
  DEFAULT_CRYPTO_WATCHLIST: [],
}));

jest.mock('../polymarket-scanner', () => ({
  scanMarkets: jest.fn().mockResolvedValue([
    {
      conditionId: 'market-1',
      question: 'Will BTC close above $120k by June 30?',
      tokens: { yes: 'yes-token', no: 'no-token' },
      currentPrices: { yes: 0.61, no: 0.39 },
    },
  ]),
}));

jest.mock('../polymarket-signals', () => ({
  produceSignals: jest.fn(() => new Map([
    ['architect', [{ agent: 'architect', conditionId: 'market-1', probability: 0.74, confidence: 0.84, direction: 'BUY_YES', reasoning: 'architect poly' }]],
    ['builder', [{ agent: 'builder', conditionId: 'market-1', probability: 0.76, confidence: 0.86, direction: 'BUY_YES', reasoning: 'builder poly' }]],
    ['oracle', [{ agent: 'oracle', conditionId: 'market-1', probability: 0.58, confidence: 0.70, direction: 'BUY_NO', reasoning: 'oracle poly' }]],
  ])),
  buildConsensus: jest.fn(() => ({
    conditionId: 'market-1',
    decision: 'BUY_YES',
    consensus: true,
    agreementCount: 2,
    probability: 0.72,
    edge: 0.11,
    summary: 'BUY YES edge',
  })),
}));

jest.mock('../polymarket-sizer', () => ({
  positionSize: jest.fn(() => ({
    executable: true,
    stake: 24.3,
    shares: 39.836,
    reasons: [],
  })),
}));

const executor = require('../executor');
const journal = require('../journal');
const signalProducer = require('../signal-producer');
const consultationStore = require('../consultation-store');
const portfolioTracker = require('../portfolio-tracker');
const dynamicWatchlist = require('../dynamic-watchlist');
const polymarketScanner = require('../polymarket-scanner');
const polymarketSignals = require('../polymarket-signals');
const polymarketSizer = require('../polymarket-sizer');
const { createOrchestrator } = require('../orchestrator');

describe('orchestrator real consultation flow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    portfolioTracker.getPortfolioSnapshot.mockResolvedValue({
      totalEquity: 12000,
      positions: [],
      markets: {
        polymarket: {
          equity: 162,
          cash: 162,
          marketValue: 0,
          positions: [],
        },
      },
      risk: {
        peakEquity: 12000,
        dayStartEquity: 12000,
        dailyLossPct: 0,
        totalDrawdownPct: 0,
      },
    });
  });

  test('collects real consultation responses first and only falls back for missing agents', async () => {
    const orchestrator = createOrchestrator({
      consultationSender: jest.fn(),
      consultationQuery: jest.fn(),
    });

    const result = await orchestrator.runConsensusRound({
      symbols: ['AAPL'],
      consultationTimeoutMs: 50,
    });

    expect(consultationStore.writeConsultationRequest).toHaveBeenCalled();
    expect(consultationStore.dispatchConsultationRequests).toHaveBeenCalled();
    expect(consultationStore.collectConsultationResponses).toHaveBeenCalled();
    expect(signalProducer.produceSignals).toHaveBeenCalledTimes(2);
    expect(signalProducer.produceSignals).toHaveBeenCalledWith('builder', expect.objectContaining({
      symbols: ['AAPL'],
    }));
    expect(signalProducer.produceSignals).toHaveBeenCalledWith('oracle', expect.objectContaining({
      symbols: ['AAPL'],
    }));
    expect(signalProducer.produceSignals).not.toHaveBeenCalledWith('architect', expect.anything());
    expect(result.consultation).toEqual(expect.objectContaining({
      requestId: 'consult-live-1',
      requestedAgents: ['architect', 'builder', 'oracle'],
      missingAgents: ['builder', 'oracle'],
    }));
    expect(result.autoGeneratedSignals).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId: 'builder', count: 1 }),
      expect.objectContaining({ agentId: 'oracle', count: 1 }),
    ]));
    expect(journal.recordConsensus).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      ticker: 'AAPL',
      architectSignal: expect.objectContaining({ reasoning: 'real architect analysis' }),
      builderSignal: expect.objectContaining({ reasoning: 'builder fallback' }),
      oracleSignal: expect.objectContaining({ reasoning: 'oracle fallback' }),
    }));
  });

  test('runs the polymarket branch end-to-end and auto-adds smart money convergence tickers', async () => {
    const orchestrator = createOrchestrator();

    const consensusPhase = await orchestrator.runConsensusRound({
      broker: 'polymarket',
      assetClass: 'prediction_market',
      smartMoneySignals: [
        {
          symbol: 'UNI',
          chain: 'ethereum',
          walletCount: 2,
          totalUsdValue: 165000,
        },
      ],
    });

    expect(dynamicWatchlist.addTicker).toHaveBeenCalledWith('UNI', expect.objectContaining({
      source: 'smart_money',
      assetClass: 'crypto',
    }));
    expect(polymarketScanner.scanMarkets).toHaveBeenCalled();
    expect(polymarketSignals.produceSignals).toHaveBeenCalled();
    expect(polymarketSizer.positionSize).toHaveBeenCalledWith(
      162,
      0.72,
      0.61,
      expect.objectContaining({
        dailyLossPct: 0,
      })
    );
    expect(consensusPhase.approvedTrades).toEqual([
      expect.objectContaining({
        ticker: 'market-1',
        tokenId: 'yes-token',
        referencePrice: 0.61,
      }),
    ]);

    const executionPhase = await orchestrator.runMarketOpen({
      broker: 'polymarket',
      assetClass: 'prediction_market',
      consensusPhase,
    });

    expect(executor.executeConsensusTrade).toHaveBeenCalledWith(expect.objectContaining({
      broker: 'polymarket',
      assetClass: 'prediction_market',
      tokenId: 'yes-token',
      requestedShares: 39.836,
      account: expect.objectContaining({
        totalEquity: 12000,
      }),
    }), expect.objectContaining({
      broker: 'polymarket',
    }));
    expect(executionPhase.executions).toEqual([
      expect.objectContaining({
        ticker: 'market-1',
        execution: expect.objectContaining({ ok: true, status: 'dry_run' }),
      }),
    ]);
  });

  test('syncs qualified launch radar tokens into the dynamic watchlist', async () => {
    const launchRadarMock = {
      pollNow: jest.fn().mockResolvedValue({
        ok: true,
        qualified: [
          {
            chain: 'solana',
            symbol: 'SQD',
            name: 'Squid Launch',
            address: 'SoLaunch11111111111111111111111111111111111',
            liquidityUsd: 12500,
            holders: 44,
            audit: { recommendation: 'proceed' },
          },
        ],
      }),
    };
    const orchestrator = createOrchestrator({
      launchRadar: launchRadarMock,
      dynamicWatchlistStatePath: '/tmp/dynamic-watchlist.json',
    });

    const result = await orchestrator.syncLaunchRadarWatchlist({
      reason: 'test_launch_radar',
      now: '2026-03-19T21:00:00.000Z',
    });

    expect(launchRadarMock.pollNow).toHaveBeenCalledWith({ reason: 'test_launch_radar' });
    expect(dynamicWatchlist.addTicker).toHaveBeenCalledWith('SQD', expect.objectContaining({
      statePath: '/tmp/dynamic-watchlist.json',
      source: 'launch_radar',
      assetClass: 'solana_token',
      exchange: 'SOLANA',
      expiry: '2026-03-26T21:00:00.000Z',
    }));
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      qualifiedTokens: [
        expect.objectContaining({
          symbol: 'SQD',
        }),
      ],
      added: ['SQD'],
    }));
  });

  test('runs launch radar sync during both premarket and consensus rounds', async () => {
    const orchestrator = createOrchestrator();
    const syncLaunchRadarSpy = jest.spyOn(orchestrator, 'syncLaunchRadarWatchlist').mockResolvedValue({
      ok: true,
      qualifiedTokens: [],
      added: [],
      refreshed: [],
      pollResult: null,
    });

    await orchestrator.runPreMarket({
      symbols: ['AAPL'],
      date: '2026-03-19',
    });
    await orchestrator.runConsensusRound({
      symbols: ['AAPL'],
      date: '2026-03-19',
      consultationTimeoutMs: 50,
    });

    expect(syncLaunchRadarSpy).toHaveBeenNthCalledWith(1, expect.objectContaining({
      reason: 'premarket',
    }));
    expect(syncLaunchRadarSpy).toHaveBeenNthCalledWith(2, expect.objectContaining({
      reason: 'consensus_round',
    }));
  });

  test('computes capital allocation and parks excess idle cash in yield', async () => {
    const yieldRouter = {
      returnCapital: jest.fn().mockResolvedValue({
        ok: true,
        deposited: 250,
        venue: 'Morpho',
      }),
      requestCapital: jest.fn(),
    };
    const orchestrator = createOrchestrator({ yieldRouter });
    const portfolioSnapshot = {
      totalEquity: 1000,
      markets: {
        alpaca_stocks: { equity: 250 },
        alpaca_crypto: { equity: 150 },
        ibkr_global: { equity: 0 },
        polymarket: { equity: 0 },
        defi_yield: { equity: 100 },
        solana_tokens: { equity: 0 },
        cash_reserve: { cash: 500, equity: 500 },
      },
    };

    const allocation = orchestrator.getCapitalAllocation(portfolioSnapshot);
    const result = await orchestrator.returnIdleCapital({
      portfolioSnapshot,
    });

    expect(allocation).toEqual(expect.objectContaining({
      targets: expect.objectContaining({
        activeTrading: 400,
        yield: 350,
        reserve: 200,
        launchRadar: 50,
      }),
      excess: expect.objectContaining({
        idleCapital: 250,
      }),
      gaps: expect.objectContaining({
        yield: 250,
      }),
    }));
    expect(yieldRouter.returnCapital).toHaveBeenCalledWith(250, expect.objectContaining({
      portfolioSnapshot,
      totalCapital: 1000,
      activeTradeCapital: 400,
    }));
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      action: 'return_idle',
      amount: 250,
      deposit: expect.objectContaining({
        deposited: 250,
      }),
    }));
  });

  test('requests trading capital from yield when active allocation is short', async () => {
    const yieldRouter = {
      returnCapital: jest.fn(),
      requestCapital: jest.fn().mockResolvedValue({
        ok: true,
        withdrawn: 50,
        sources: [
          { venue: { protocol: 'Aave' }, amount: 50 },
        ],
      }),
    };
    const orchestrator = createOrchestrator({ yieldRouter });
    const portfolioSnapshot = {
      totalEquity: 1000,
      markets: {
        alpaca_stocks: { equity: 100 },
        alpaca_crypto: { equity: 0 },
        ibkr_global: { equity: 0 },
        polymarket: { equity: 0 },
        defi_yield: { equity: 250 },
        solana_tokens: { equity: 0 },
        cash_reserve: { cash: 300, equity: 300 },
      },
      risk: {
        killSwitchTriggered: false,
      },
    };

    const result = await orchestrator.requestTradingCapital(100, {
      portfolioSnapshot,
    });

    expect(yieldRouter.requestCapital).toHaveBeenCalledWith(50, expect.objectContaining({
      portfolioSnapshot,
      totalCapital: 1000,
    }));
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      requested: 100,
      shortfall: 50,
      requestAmount: 50,
      withdrawal: expect.objectContaining({
        withdrawn: 50,
      }),
    }));
  });

  test('requests trading capital before executing approved BUY trades', async () => {
    const yieldRouter = {
      returnCapital: jest.fn(),
      requestCapital: jest.fn().mockResolvedValue({
        ok: true,
        withdrawn: 200,
        sources: [],
      }),
    };
    const orchestrator = createOrchestrator({ yieldRouter });
    const consensusPhase = {
      accountState: {
        equity: 1000,
        peakEquity: 1000,
        dayStartEquity: 1000,
        tradesToday: 0,
        openPositions: [],
      },
      portfolioSnapshot: {
        totalEquity: 1000,
        markets: {
          alpaca_stocks: { equity: 100 },
          alpaca_crypto: { equity: 0 },
          ibkr_global: { equity: 0 },
          polymarket: { equity: 0 },
          defi_yield: { equity: 250 },
          solana_tokens: { equity: 0 },
          cash_reserve: { cash: 400, equity: 400 },
        },
        risk: {
          killSwitchTriggered: false,
        },
      },
      approvedTrades: [
        {
          ticker: 'AAPL',
          consensus: { decision: 'BUY' },
          referencePrice: 100,
          riskCheck: { maxShares: 2 },
          limits: {},
        },
      ],
    };

    const result = await orchestrator.runMarketOpen({
      consensusPhase,
    });

    expect(yieldRouter.requestCapital).toHaveBeenCalledWith(50, expect.objectContaining({
      portfolioSnapshot: consensusPhase.portfolioSnapshot,
    }));
    expect(executor.executeConsensusTrade).toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({
      requiredTradingCapital: 200,
      capitalRequest: expect.objectContaining({
        requestAmount: 50,
      }),
    }));
  });
});
