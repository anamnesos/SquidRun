'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const mockJournalDb = { mocked: true };
let mockTrades = [];
let mockRecordedDailySummaries = [];
const mockExecFile = jest.fn();

jest.mock('child_process', () => ({
  execFile: (...args) => mockExecFile(...args),
}));

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
  normalizeOrder: jest.fn((order = {}) => ({
    id: order.id || null,
    clientOrderId: order.client_order_id || null,
    status: order.status || null,
    symbol: order.symbol || '',
    side: order.side || null,
    qty: Number(order.qty || 0) || 0,
    filledQty: Number(order.filled_qty || 0) || 0,
    filledAvgPrice: Number(order.filled_avg_price || 0) || null,
    type: order.type || null,
    raw: order,
  })),
}));

jest.mock('../journal', () => ({
  getDb: jest.fn(() => mockJournalDb),
  getRecentTrades: jest.fn((db, limit = 10) => mockTrades.slice().sort((left, right) => String(right.timestamp).localeCompare(String(left.timestamp))).slice(0, limit)),
  getAllTrades: jest.fn(() => mockTrades.slice().sort((left, right) => {
    const timeCompare = String(left.timestamp).localeCompare(String(right.timestamp));
    if (timeCompare !== 0) return timeCompare;
    return Number(left.id || 0) - Number(right.id || 0);
  })),
  getPendingTrades: jest.fn(() => mockTrades.filter((trade) => ['PENDING_NEW', 'PENDING', 'ACCEPTED', 'NEW', 'PARTIALLY_FILLED'].includes(String(trade.status || '').toUpperCase()))),
  updateTrade: jest.fn((db, tradeId, patch = {}) => {
    const index = mockTrades.findIndex((trade) => Number(trade.id) === Number(tradeId));
    if (index === -1) return null;
    const current = mockTrades[index];
    const next = {
      ...current,
      ...(patch.shares !== undefined ? { shares: patch.shares } : {}),
      ...(patch.price !== undefined ? { price: patch.price } : {}),
      ...(patch.status !== undefined ? { status: String(patch.status).toUpperCase() } : {}),
      ...(patch.brokerOrderId !== undefined ? { alpaca_order_id: patch.brokerOrderId } : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
      ...(patch.filledAt !== undefined ? { filled_at: patch.filledAt } : {}),
      ...(patch.reconciledAt !== undefined ? { reconciled_at: patch.reconciledAt } : {}),
      ...(patch.realizedPnl !== undefined ? { realized_pnl: patch.realizedPnl } : {}),
      ...(patch.outcomeRecordedAt !== undefined ? { outcome_recorded_at: patch.outcomeRecordedAt } : {}),
    };
    if (patch.shares !== undefined || patch.price !== undefined) {
      next.total_value = Number((Number(next.shares || 0) * Number(next.price || 0)).toFixed(6));
    }
    mockTrades[index] = next;
    return { ...next };
  }),
  recordConsensus: jest.fn(),
  recordDailySummary: jest.fn((db, summary) => {
    mockRecordedDailySummaries.push(summary);
    return { changes: 1 };
  }),
  recordExecutionReport: jest.fn(() => ({ lastInsertRowid: 1 })),
}));

jest.mock('../agent-attribution', () => ({
  recordPrediction: jest.fn(),
  recordOutcome: jest.fn(() => ({
    settled: [
      { agentId: 'architect' },
      { agentId: 'builder' },
      { agentId: 'oracle' },
    ],
  })),
}));

jest.mock('../signal-validation-recorder', () => ({
  appendValidationRecords: jest.fn((records = [], options = {}) => {
    const mockFs = require('fs');
    const mockPath = require('path');
    const targetPath = options.candidateLogPath || '/tmp/trading-candidate-events.jsonl';
    mockFs.mkdirSync(mockPath.dirname(targetPath), { recursive: true });
    if (Array.isArray(records) && records.length > 0) {
      mockFs.writeFileSync(targetPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
    }
    return {
      ok: true,
      count: Array.isArray(records) ? records.length : 0,
      path: targetPath,
    };
  }),
  settleValidationRecords: jest.fn(async (options = {}) => ({
    ok: true,
    candidateCount: 0,
    settledCount: 0,
    pendingCount: 0,
    path: options.settlementLogPath || '/tmp/trading-candidate-settlements.jsonl',
  })),
}));

jest.mock('../hyperliquid-native-layer', () => ({
  buildNativeFeatureBundle: jest.fn().mockResolvedValue({
    ok: true,
    asOf: '2026-03-29T03:59:00.000Z',
    symbols: {
      'BTC/USD': {
        predictedFunding: {
          venue: 'HlPerp',
          fundingRate: -0.00012,
        },
        l2Book: {
          nearTouchSkew: 'ask_heavy',
          depthImbalanceTop5: -0.22,
        },
        multiTimeframe: {
          status: null,
          sizeMultiplier: null,
          tapeStatus: 'confirm',
          statusBasis: 'tape_state',
          decisionState: null,
          regime: 'full_bear_alignment',
          directionalStates: {
            BUY: {
              status: 'block',
              sizeMultiplier: 0,
              reasons: ['BUY blocked because 4h and/or daily trends are leaning the other way.'],
            },
            SELL: {
              status: 'confirm',
              sizeMultiplier: 1,
              reasons: ['SELL confirmed by aligned 4h and daily trend.'],
            },
          },
        },
        vaultOverlay: {
          informational: false,
        },
      },
    },
    degradedSources: [],
  }),
  recordNativeFeatureSnapshot: jest.fn(() => ({
    ok: true,
    path: '/tmp/hyperliquid-native-state.json',
    symbolCount: 1,
  })),
}));

jest.mock('../risk-engine', () => ({
  DEFAULT_LIMITS: { maxDrawdownPct: 0.2, maxDailyLossPct: 0.1, maxTradesPerDay: 3, maxOpenPositions: 3, maxPositionPct: 0.05, stopLossPct: 0.03 },
  checkKillSwitch: jest.fn(() => ({ triggered: false, drawdownPct: 0 })),
  checkDailyPause: jest.fn(() => ({ paused: false, dayLossPct: 0 })),
  checkTrade: jest.fn(() => ({ approved: true, violations: [], maxShares: 2, stopLossPrice: 194 })),
}));

jest.mock('../macro-risk-gate', () => ({
  assessMacroRisk: jest.fn().mockResolvedValue({
    regime: 'green',
    score: 22,
    reason: 'All clear',
    constraints: {
      allowLongs: true,
      blockNewPositions: false,
      positionSizeMultiplier: 1,
      buyConfidenceMultiplier: 1,
      sellConfidenceMultiplier: 1,
    },
  }),
  applyMacroRiskToSignal: jest.fn((signal, macroRisk) => {
    if (String(signal?.direction || '').toUpperCase() === 'BUY' && macroRisk?.constraints?.allowLongs === false) {
      return {
        ...signal,
        direction: 'HOLD',
        confidence: 0.72,
        reasoning: `${signal.reasoning} macro blocked`,
      };
    }
    return { ...signal };
  }),
}));

jest.mock('../signal-producer', () => ({
  produceSignals: jest.fn(async (agentId, options = {}) => {
    const ticker = (options.symbols || [])[0] || 'AAPL';
    const macroBlocked = options?.macroRisk?.constraints?.allowLongs === false;
    const baseDirection = agentId === 'builder' ? 'BUY' : 'HOLD';
    return [{
      ticker,
      direction: macroBlocked && baseDirection === 'BUY' ? 'HOLD' : baseDirection,
      confidence: agentId === 'builder' ? 0.64 : 0.55,
      reasoning: macroBlocked && baseDirection === 'BUY' ? `${agentId} fallback macro blocked` : `${agentId} fallback`,
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

jest.mock('../crypto-mech-board', () => ({
  buildCryptoMechBoard: jest.fn().mockResolvedValue({
    venue: 'hyperliquid',
    asOf: '2026-03-29T03:59:00.000Z',
    symbols: {
      'BTC/USD': {
        mechanicalDirectionBias: 'neutral',
        tradeFlag: 'watch',
      },
    },
  }),
}));

jest.mock('../event-veto', () => ({
  buildEventVeto: jest.fn().mockResolvedValue({
    decision: 'CLEAR',
    eventSummary: 'No active tier-1 event veto trigger detected.',
    sourceTier: 'tier1_checked',
    stale: false,
    affectedAssets: [],
    matchedEvents: [],
  }),
}));

jest.mock('../consensus-sizer', () => ({
  sizeConsensusTrade: jest.fn(() => ({
    bucket: 'normal',
    disagreementScore: 0.2,
    mechanicalAlignment: 0.8,
    reasons: [],
  })),
  applySizeBucketToRiskCheck: jest.fn((riskCheck) => riskCheck),
}));

jest.mock('../telegram-summary', () => ({
  sendTelegram: jest.fn(),
  sendDailySummary: jest.fn(),
  sendKillSwitchAlert: jest.fn(),
  sendTradeNotification: jest.fn(),
}));

jest.mock('../portfolio-tracker', () => ({
  getPortfolioSnapshot: jest.fn().mockResolvedValue({
    totalEquity: 12000,
    positions: [],
    markets: {},
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
    { ticker: 'AAPL', broker: 'ibkr', assetClass: 'us_equity', exchange: 'SMART' },
  ]),
  getEntry: jest.fn(() => null),
  addTicker: jest.fn(() => true),
  isWatched: jest.fn(() => true),
  normalizeBroker: jest.fn((value, fallback = 'ibkr') => value || fallback),
  normalizeExchange: jest.fn((value, fallback = 'SMART') => value || fallback),
  normalizeAssetClass: jest.fn((value, fallback = 'us_equity') => value || fallback),
  DEFAULT_WATCHLIST: [],
  DEFAULT_CRYPTO_WATCHLIST: [],
}));

const executor = require('../executor');
const journal = require('../journal');
const signalProducer = require('../signal-producer');
const consultationStore = require('../consultation-store');
const cryptoMechBoard = require('../crypto-mech-board');
const eventVeto = require('../event-veto');
const consensusSizer = require('../consensus-sizer');
const portfolioTracker = require('../portfolio-tracker');
const riskEngine = require('../risk-engine');
const dynamicWatchlist = require('../dynamic-watchlist');
const telegramSummary = require('../telegram-summary');
const agentAttribution = require('../agent-attribution');
const macroRiskGate = require('../macro-risk-gate');
const signalValidationRecorder = require('../signal-validation-recorder');
const hyperliquidNativeLayer = require('../hyperliquid-native-layer');
const { createOrchestrator } = require('../orchestrator');

describe('orchestrator real consultation flow', () => {
  let tempDir;

  beforeEach(() => {
    jest.clearAllMocks();
    mockTrades = [];
    mockRecordedDailySummaries = [];
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-defi-monitor-'));
    portfolioTracker.getPortfolioSnapshot.mockResolvedValue({
      totalEquity: 12000,
      positions: [],
      markets: {},
      risk: {
        peakEquity: 12000,
        dayStartEquity: 12000,
        dailyLossPct: 0,
        totalDrawdownPct: 0,
      },
    });
    executor.getAccountSnapshot.mockResolvedValue({ equity: 10000 });
    executor.getOpenPositions.mockResolvedValue([]);
    executor.syncJournalPositions.mockResolvedValue([]);
    macroRiskGate.assessMacroRisk.mockResolvedValue({
      regime: 'green',
      score: 22,
      reason: 'All clear',
      constraints: {
        allowLongs: true,
        blockNewPositions: false,
        positionSizeMultiplier: 1,
        buyConfidenceMultiplier: 1,
        sellConfidenceMultiplier: 1,
      },
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
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
    expect(consultationStore.writeConsultationRequest).toHaveBeenCalledWith(expect.objectContaining({
      macroRisk: expect.objectContaining({
        regime: 'green',
      }),
      cryptoMechBoard: null,
      eventVeto: expect.objectContaining({
        decision: 'CLEAR',
      }),
    }), expect.anything());
    expect(cryptoMechBoard.buildCryptoMechBoard).not.toHaveBeenCalled();
    expect(eventVeto.buildEventVeto).toHaveBeenCalled();
    expect(consultationStore.dispatchConsultationRequests).toHaveBeenCalled();
    expect(consultationStore.collectConsultationResponses).toHaveBeenCalledWith(
      expect.anything(),
      ['architect', 'builder', 'oracle'],
      expect.objectContaining({
        minResponses: 2,
      })
    );
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
    expect(consensusSizer.sizeConsensusTrade).toHaveBeenCalled();
    expect(consensusSizer.applySizeBucketToRiskCheck).toHaveBeenCalled();
  });

  test('uses real-agent quorum without synthetic fallback when two live consultation responses agree', async () => {
    consultationStore.collectConsultationResponses.mockResolvedValueOnce({
      requestId: 'consult-live-2',
      responses: [
        {
          requestId: 'consult-live-2',
          agentId: 'architect',
          signals: [
            { ticker: 'AAPL', direction: 'BUY', confidence: 0.81, reasoning: 'architect real buy' },
          ],
        },
        {
          requestId: 'consult-live-2',
          agentId: 'oracle',
          signals: [
            { ticker: 'AAPL', direction: 'BUY', confidence: 0.79, reasoning: 'oracle real buy' },
          ],
        },
      ],
      missingAgents: ['builder'],
    });

    const orchestrator = createOrchestrator({
      consultationSender: jest.fn(),
      consultationQuery: jest.fn(),
    });

    const result = await orchestrator.runConsensusRound({
      symbols: ['AAPL'],
      consultationTimeoutMs: 50,
    });

    expect(signalProducer.produceSignals).not.toHaveBeenCalled();
    expect(result.consultation).toEqual(expect.objectContaining({
      requestId: 'consult-live-1',
      requestedAgents: ['architect', 'builder', 'oracle'],
      responseCount: 2,
      minResponses: 2,
      quorumSatisfied: true,
      missingAgents: ['builder'],
    }));
    expect(result.autoGeneratedSignals).toEqual([]);
    expect(result.approvedTrades).toHaveLength(1);
    expect(result.incompleteSignals).toEqual([]);
    expect(journal.recordConsensus).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      ticker: 'AAPL',
      architectSignal: expect.objectContaining({ reasoning: 'architect real buy' }),
      builderSignal: null,
      oracleSignal: expect.objectContaining({ reasoning: 'oracle real buy' }),
    }));
  });

  test('clears stale same-ticker signals before a fresh consultation so quorum confidence only reflects current respondents', async () => {
    consultationStore.collectConsultationResponses.mockResolvedValueOnce({
      requestId: 'consult-live-3',
      responses: [
        {
          requestId: 'consult-live-3',
          agentId: 'architect',
          signals: [
            { ticker: 'AAPL', direction: 'BUY', confidence: 0.6, reasoning: 'architect current buy' },
          ],
        },
        {
          requestId: 'consult-live-3',
          agentId: 'oracle',
          signals: [
            { ticker: 'AAPL', direction: 'BUY', confidence: 0.62, reasoning: 'oracle current buy' },
          ],
        },
      ],
      missingAgents: ['builder'],
    });

    const orchestrator = createOrchestrator({
      consultationSender: jest.fn(),
      consultationQuery: jest.fn(),
    });

    orchestrator.registerSignal('builder', 'AAPL', {
      ticker: 'AAPL',
      direction: 'BUY',
      confidence: 0.43,
      reasoning: 'stale builder buy from prior round',
      model: 'gpt',
      timestamp: Date.now() - 60_000,
    });

    const result = await orchestrator.runConsensusRound({
      symbols: ['AAPL'],
      consultationTimeoutMs: 50,
    });

    expect(signalProducer.produceSignals).not.toHaveBeenCalled();
    expect(result.consultation).toEqual(expect.objectContaining({
      requestId: 'consult-live-1',
      requestedAgents: ['architect', 'builder', 'oracle'],
      responseCount: 2,
      minResponses: 2,
      quorumSatisfied: true,
      missingAgents: ['builder'],
    }));
    expect(result.approvedTrades).toHaveLength(1);
    expect(result.approvedTrades[0].consensus).toEqual(expect.objectContaining({
      decision: 'BUY',
      agreementCount: 2,
      confidence: 0.61,
      averageAgreeConfidence: 0.61,
    }));
    expect(journal.recordConsensus).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      ticker: 'AAPL',
      architectSignal: expect.objectContaining({ reasoning: 'architect current buy' }),
      builderSignal: null,
      oracleSignal: expect.objectContaining({ reasoning: 'oracle current buy' }),
    }));
  });

  test('persists candidate feature snapshots for each consensus result', async () => {
    const candidateEventLogPath = path.join(tempDir, 'trading-candidate-events.jsonl');
    const validationSettlementLogPath = path.join(tempDir, 'trading-candidate-settlements.jsonl');
    const orchestrator = createOrchestrator({
      consultationSender: jest.fn(),
      consultationQuery: jest.fn(),
      candidateEventLogPath,
    });

    const result = await orchestrator.runConsensusRound({
      symbols: ['AAPL'],
      consultationTimeoutMs: 50,
      validationSettlementLogPath,
    });

    expect(result.candidateFeatureLog).toEqual({
      ok: true,
      count: 1,
      path: candidateEventLogPath,
    });
    expect(signalValidationRecorder.settleValidationRecords).toHaveBeenCalledWith(expect.objectContaining({
      candidateLogPath: candidateEventLogPath,
      settlementLogPath: validationSettlementLogPath,
    }));
    expect(result.validationSettlement).toEqual(expect.objectContaining({
      ok: true,
      path: validationSettlementLogPath,
    }));
    expect(fs.existsSync(candidateEventLogPath)).toBe(true);

    const persistedLines = fs.readFileSync(candidateEventLogPath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean);
    expect(persistedLines).toHaveLength(1);

    const persistedRecord = JSON.parse(persistedLines[0]);
    expect(persistedRecord).toEqual(expect.objectContaining({
      ticker: 'AAPL',
      consensus: true,
      status: 'approved',
      ignored: false,
      autoExecutionEnabled: false,
      macroRisk: expect.objectContaining({
        regime: 'green',
      }),
      eventVeto: expect.objectContaining({
        decision: 'CLEAR',
      }),
      signalsByAgent: expect.objectContaining({
        architect: expect.objectContaining({
          reasoning: 'real architect analysis',
        }),
        builder: expect.objectContaining({
          reasoning: 'builder fallback',
        }),
        oracle: expect.objectContaining({
          reasoning: 'oracle fallback',
        }),
      }),
      riskCheck: expect.objectContaining({
        approved: true,
      }),
    }));
  });

  test('uses the live Hyperliquid venue account for crypto kill-switch checks instead of stale global portfolio peaks', async () => {
    const orchestrator = createOrchestrator({
      consultationSender: jest.fn(),
      consultationQuery: jest.fn(),
    });
    consultationStore.collectConsultationResponses.mockResolvedValueOnce({
      requestId: 'consult-live-crypto-1',
      responses: [
        {
          requestId: 'consult-live-crypto-1',
          agentId: 'architect',
          signals: [
            { ticker: 'WLD/USD', direction: 'SELL', confidence: 0.69, reasoning: 'architect bearish' },
          ],
        },
        {
          requestId: 'consult-live-crypto-1',
          agentId: 'builder',
          signals: [
            { ticker: 'WLD/USD', direction: 'SELL', confidence: 0.69, reasoning: 'builder bearish' },
          ],
        },
        {
          requestId: 'consult-live-crypto-1',
          agentId: 'oracle',
          signals: [
            { ticker: 'WLD/USD', direction: 'SELL', confidence: 0.75, reasoning: 'oracle bearish' },
          ],
        },
      ],
      missingAgents: [],
    });
    const portfolioSnapshot = {
      totalEquity: 615.49,
      positions: [],
      risk: {
        peakEquity: 99391.8,
        dayStartEquity: 0,
        dailyLossPct: 0,
        totalDrawdownPct: 0.9938,
      },
    };
    const liveDefiStatus = {
      ok: true,
      checkedAt: '2026-04-06T01:07:50.972Z',
      accountValue: 615.49,
      withdrawable: 615.49,
      positions: [],
    };
    const result = await orchestrator.runConsensusRound({
      symbols: ['WLD/USD'],
      assetClass: 'crypto',
      consultationTimeoutMs: 50,
      portfolioSnapshot,
      defiStatusProvider: jest.fn().mockResolvedValue(liveDefiStatus),
      snapshots: new Map([
        ['WLD/USD', {
          symbol: 'WLD/USD',
          tradePrice: 0.2489,
          dailyVolume: 1000000,
          dailyClose: 0.2489,
          previousClose: 0.2579,
          tradeTimestamp: '2026-04-06T01:07:50.377Z',
        }],
      ]),
      bars: new Map([
        ['WLD/USD', [
          { symbol: 'WLD/USD', close: 0.274, high: 0.276, low: 0.27, volume: 1000000 },
          { symbol: 'WLD/USD', close: 0.263, high: 0.266, low: 0.261, volume: 1200000 },
          { symbol: 'WLD/USD', close: 0.249, high: 0.252, low: 0.247, volume: 1500000 },
        ]],
      ]),
      news: [],
    });

    expect(riskEngine.checkKillSwitch).toHaveBeenCalledWith(expect.objectContaining({
      equity: 615.49,
      peakEquity: 615.49,
      dayStartEquity: 615.49,
    }), expect.anything());
    expect(riskEngine.checkDailyPause).toHaveBeenCalledWith(expect.objectContaining({
      equity: 615.49,
      peakEquity: 615.49,
      dayStartEquity: 615.49,
    }), expect.anything());
    expect(result.approvedTrades).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ticker: 'WLD/USD',
      }),
    ]));
  });

  test('persists decision-coupled native multi-timeframe state in candidate records', async () => {
    const candidateEventLogPath = path.join(tempDir, 'trading-candidate-events-native.jsonl');
    consultationStore.collectConsultationResponses.mockResolvedValueOnce({
      requestId: 'consult-live-1',
      responses: [
        {
          requestId: 'consult-live-1',
          agentId: 'architect',
          signals: [
            { ticker: 'BTC/USD', direction: 'BUY', confidence: 0.91, reasoning: 'real architect analysis' },
          ],
        },
      ],
      missingAgents: ['builder', 'oracle'],
    });
    const orchestrator = createOrchestrator({
      consultationSender: jest.fn(),
      consultationQuery: jest.fn(),
      candidateEventLogPath,
    });

    await orchestrator.runConsensusRound({
      symbols: ['BTC/USD'],
      consultationTimeoutMs: 50,
      snapshots: new Map([
        ['BTC/USD', { symbol: 'BTC/USD', tradePrice: 66200 }],
      ]),
      bars: new Map([
        ['BTC/USD', [{ close: 66000 }]],
      ]),
      news: [],
    });

    const persistedLines = fs.readFileSync(candidateEventLogPath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean);
    const persistedRecord = JSON.parse(persistedLines[0]);
    expect(persistedRecord.nativeSignals).toEqual(expect.objectContaining({
      multiTimeframe: expect.objectContaining({
        statusBasis: 'decision',
        decisionState: expect.objectContaining({
          decision: 'BUY',
          status: 'block',
        }),
        directionalStates: expect.objectContaining({
          BUY: expect.objectContaining({
            status: 'block',
          }),
        }),
      }),
    }));
  });

  test('attaches the crypto mechanical board to Hyperliquid consultations', async () => {
    const orchestrator = createOrchestrator({
      consultationSender: jest.fn(),
      consultationQuery: jest.fn(),
      defiStatusProvider: jest.fn().mockResolvedValue({
        ok: true,
        checkedAt: '2026-03-29T03:59:00.000Z',
        positions: [],
      }),
    });

    await orchestrator.runConsensusRound({
      symbols: ['BTC/USD'],
      consultationTimeoutMs: 50,
      snapshots: new Map([
        ['BTC/USD', { symbol: 'BTC/USD', tradePrice: 66200 }],
      ]),
      bars: new Map([
        ['BTC/USD', [{ close: 66000 }]],
      ]),
      news: [],
    });

    expect(cryptoMechBoard.buildCryptoMechBoard).toHaveBeenCalledWith(expect.objectContaining({
      symbols: ['BTC/USD'],
      whaleTransfers: null,
    }));
    expect(hyperliquidNativeLayer.buildNativeFeatureBundle).toHaveBeenCalledWith(expect.objectContaining({
      symbols: ['BTC/USD'],
      detailSymbols: ['BTC/USD'],
    }));
    expect(eventVeto.buildEventVeto).toHaveBeenCalledWith(expect.objectContaining({
      symbols: ['BTC/USD'],
    }));
    expect(consultationStore.writeConsultationRequest).toHaveBeenCalledWith(expect.objectContaining({
      cryptoMechBoard: expect.objectContaining({
        symbols: expect.objectContaining({
          'BTC/USD': expect.objectContaining({
            tradeFlag: 'watch',
          }),
        }),
      }),
      nativeSignals: expect.objectContaining({
        symbols: expect.objectContaining({
          'BTC/USD': expect.objectContaining({
            multiTimeframe: expect.objectContaining({
              regime: 'full_bear_alignment',
              status: null,
              tapeStatus: 'confirm',
            }),
          }),
        }),
      }),
      eventVeto: expect.objectContaining({
        decision: 'CLEAR',
      }),
    }), expect.anything());
  });

  test('carries event-veto news blindness into consultation warnings', async () => {
    eventVeto.buildEventVeto.mockResolvedValueOnce({
      decision: 'DEGRADED',
      eventSummary: 'Live tier-1 event scan unavailable; treat news context as degraded.',
      sourceTier: 'none',
      stale: true,
      sizeMultiplier: 0.5,
      affectedAssets: ['BTC/USD'],
      matchedEvents: [],
    });

    const orchestrator = createOrchestrator({
      consultationSender: jest.fn(),
      consultationQuery: jest.fn(),
      defiStatusProvider: jest.fn().mockResolvedValue({
        ok: true,
        checkedAt: '2026-03-29T03:59:00.000Z',
        positions: [],
      }),
    });

    await orchestrator.runConsensusRound({
      symbols: ['BTC/USD'],
      consultationTimeoutMs: 50,
      snapshots: new Map([
        ['BTC/USD', { symbol: 'BTC/USD', tradePrice: 66200 }],
      ]),
      bars: new Map([
        ['BTC/USD', [{ close: 66000 }]],
      ]),
      news: [],
    });

    expect(consultationStore.writeConsultationRequest).toHaveBeenCalledWith(expect.objectContaining({
      eventVeto: expect.objectContaining({
        decision: 'DEGRADED',
        sourceTier: 'none',
        sizeMultiplier: 0.5,
      }),
      consultationWarnings: expect.arrayContaining([
        expect.objectContaining({
          code: 'event_veto_news_blind',
          message: expect.stringContaining('degraded'),
        }),
      ]),
    }), expect.anything());
  });

  test('injects Hyperliquid position warnings into consultation requests', async () => {
    const peakPath = path.join(tempDir, 'defi-peak-pnl.json');
    fs.writeFileSync(peakPath, JSON.stringify({
      updatedAt: '2026-03-28T19:55:00.000Z',
      positions: {
        'ETH:short': {
          coin: 'ETH',
          side: 'short',
          peakUnrealizedPnl: 150,
          lastAlertLevel: null,
        },
      },
    }, null, 2));

    const orchestrator = createOrchestrator({
      consultationSender: jest.fn(),
      consultationQuery: jest.fn(),
      defiPeakPnlPath: peakPath,
      defiStatusProvider: jest.fn().mockResolvedValue({
        ok: true,
        checkedAt: '2026-03-28T20:00:00.000Z',
        positions: [
          { coin: 'ETH', size: -0.12, side: 'short', entryPx: 2100, unrealizedPnl: 57, liquidationPx: 2400 },
        ],
      }),
    });

    await orchestrator.runConsensusRound({
      symbols: ['AAPL'],
      consultationTimeoutMs: 50,
    });

    expect(consultationStore.writeConsultationRequest).toHaveBeenCalledWith(expect.objectContaining({
      primaryDataSource: 'hyperliquid',
      taskType: 'position_management',
      defiStatus: expect.objectContaining({
        positions: [
          expect.objectContaining({
            coin: 'ETH',
            warningLevel: 'urgent',
            peakUnrealizedPnl: 150,
            timeOpenMs: expect.any(Number),
          }),
        ],
      }),
      consultationWarnings: [
        expect.objectContaining({
          level: 'urgent',
          ticker: 'ETH/USD',
        }),
      ],
    }), expect.anything());
  });

  test('sends a warning Telegram alert when profit retention drops below 70% of peak', async () => {
    const peakPath = path.join(tempDir, 'defi-peak-pnl.json');
    const defiStatusProvider = jest.fn().mockResolvedValue({
      ok: true,
      checkedAt: '2026-03-28T20:00:00.000Z',
      positions: [
        { coin: 'ETH', size: -1, side: 'short', entryPx: 2100, unrealizedPnl: 100, liquidationPx: 2600 },
      ],
    });
    fs.writeFileSync(peakPath, JSON.stringify({
      updatedAt: '2026-03-28T19:55:00.000Z',
      positions: {
        'ETH:short': {
          coin: 'ETH',
          side: 'short',
          peakUnrealizedPnl: 150,
          lastAlertLevel: null,
        },
      },
    }, null, 2));
    const orchestrator = createOrchestrator({
      defiPeakPnlPath: peakPath,
      defiStatusProvider,
    });

    const result = await orchestrator.runDefiMonitorCycle({ trigger: 'interval' });

    expect(result.positions[0]).toEqual(expect.objectContaining({
      warningLevel: 'warning',
      retainedPeakRatio: 0.6667,
    }));
    expect(telegramSummary.sendTelegram).toHaveBeenCalledWith(expect.stringContaining('WARNING Hyperliquid position alert'));
  });

  test('tracks peak Hyperliquid P&L and sends one urgent Telegram alert on a 50% giveback', async () => {
    const peakPath = path.join(tempDir, 'defi-peak-pnl.json');
    const defiStatusProvider = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        checkedAt: '2026-03-28T19:55:00.000Z',
        positions: [
          { coin: 'ETH', size: -0.12, side: 'short', entryPx: 2100, unrealizedPnl: 150, liquidationPx: 2400 },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        checkedAt: '2026-03-28T20:00:00.000Z',
        positions: [
          { coin: 'ETH', size: -0.12, side: 'short', entryPx: 2100, unrealizedPnl: 57, liquidationPx: 2400 },
        ],
      });
    const orchestrator = createOrchestrator({
      defiPeakPnlPath: peakPath,
      defiStatusProvider,
    });

    const first = await orchestrator.runDefiMonitorCycle({ trigger: 'interval' });
    const second = await orchestrator.runDefiMonitorCycle({ trigger: 'interval' });

    expect(first.positions[0]).toEqual(expect.objectContaining({
      coin: 'ETH',
      peakUnrealizedPnl: 150,
      warningLevel: null,
    }));
    expect(second.positions[0]).toEqual(expect.objectContaining({
      coin: 'ETH',
      peakUnrealizedPnl: 150,
      warningLevel: 'urgent',
      retainedPeakRatio: 0.38,
    }));
    expect(telegramSummary.sendTelegram).toHaveBeenCalledTimes(1);
    expect(telegramSummary.sendTelegram).toHaveBeenCalledWith(expect.stringContaining('ETH SHORT unrealized P&L is now $57.00 vs peak $150.00'));
    expect(JSON.parse(fs.readFileSync(peakPath, 'utf8'))).toEqual(expect.objectContaining({
      positions: expect.objectContaining({
        'ETH:short': expect.objectContaining({
          peakUnrealizedPnl: 150,
          unrealizedPnl: 57,
          lastAlertLevel: 'urgent',
        }),
      }),
    }));
  });

  test('fetchDefiStatus tolerates dotenv banner noise before JSON output', async () => {
    mockExecFile.mockImplementationOnce((_command, _args, _options, callback) => {
      callback(null, {
        stdout: '[dotenv@17.2.3] injecting env (0) from .env\n{\"ok\":true,\"checkedAt\":\"2026-03-29T10:55:00.000Z\",\"positions\":[{\"coin\":\"ETH\",\"size\":-1.7113,\"side\":\"short\",\"entryPx\":2008.1,\"unrealizedPnl\":17.46,\"liquidationPx\":2361.69}]}',
        stderr: '',
      });
    });

    const orchestrator = createOrchestrator({
      defiStatusScriptPath: path.join(tempDir, 'hm-defi-status.js'),
    });

    const result = await orchestrator.fetchDefiStatus({
      allowExecDefiStatusScript: true,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      checkedAt: '2026-03-29T10:55:00.000Z',
      positions: [
        expect.objectContaining({
          coin: 'ETH',
          size: -1.7113,
          side: 'short',
        }),
      ],
    }));
    expect(mockExecFile).toHaveBeenCalledWith(
      process.execPath,
      [path.join(tempDir, 'hm-defi-status.js'), '--json'],
      expect.objectContaining({
        cwd: expect.any(String),
        windowsHide: true,
        timeout: expect.any(Number),
      }),
      expect.any(Function)
    );
  });

  test('fetchDefiStatus skips dotenv tips containing braces before JSON output', async () => {
    mockExecFile.mockImplementationOnce((_command, _args, _options, callback) => {
      callback(null, {
        stdout: '[dotenv@17.2.3] injecting env (0) from .env -- tip: ⚙️ suppress all logs with { quiet: true }\n{\"ok\":true,\"checkedAt\":\"2026-03-29T11:05:00.000Z\",\"positions\":[{\"coin\":\"ETH\",\"size\":-1.7113,\"side\":\"short\",\"entryPx\":2008.1,\"unrealizedPnl\":-48.12,\"liquidationPx\":2361.69}]}',
        stderr: '',
      });
    });

    const orchestrator = createOrchestrator({
      defiStatusScriptPath: path.join(tempDir, 'hm-defi-status.js'),
    });

    const result = await orchestrator.fetchDefiStatus({
      allowExecDefiStatusScript: true,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      checkedAt: '2026-03-29T11:05:00.000Z',
      positions: [
        expect.objectContaining({
          coin: 'ETH',
          size: -1.7113,
          unrealizedPnl: -48.12,
        }),
      ],
    }));
  });

  test('sends a critical Telegram alert when a position is within 15% of liquidation', async () => {
    const peakPath = path.join(tempDir, 'defi-peak-pnl.json');
    const orchestrator = createOrchestrator({
      defiPeakPnlPath: peakPath,
      defiStatusProvider: jest.fn().mockResolvedValue({
        ok: true,
        checkedAt: '2026-03-28T20:00:00.000Z',
        positions: [
          { coin: 'ETH', size: -1, side: 'short', entryPx: 2000, unrealizedPnl: -170, liquidationPx: 2200 },
        ],
      }),
    });

    const result = await orchestrator.runDefiMonitorCycle({ trigger: 'interval' });

    expect(result.positions[0]).toEqual(expect.objectContaining({
      warningLevel: 'critical',
      liquidationDistancePct: 0.15,
    }));
    expect(telegramSummary.sendTelegram).toHaveBeenCalledWith(expect.stringContaining('CRITICAL Hyperliquid position alert'));
  });

  test('does not flag a newly opened short as liquidation-critical when mark is still at entry', async () => {
    const peakPath = path.join(tempDir, 'defi-peak-pnl.json');
    const orchestrator = createOrchestrator({
      defiPeakPnlPath: peakPath,
      defiStatusProvider: jest.fn().mockResolvedValue({
        ok: true,
        checkedAt: '2026-04-04T18:53:18.231Z',
        positions: [
          { coin: 'AVAX', size: -22.16, side: 'short', entryPx: 9.0246, unrealizedPnl: 0, liquidationPx: 10.3101156094 },
        ],
      }),
    });

    const result = await orchestrator.runDefiMonitorCycle({ trigger: 'interval' });

    expect(result.positions[0]).toEqual(expect.objectContaining({
      coin: 'AVAX',
      warningLevel: null,
      liquidationDistancePct: 1,
      markPrice: 9.0246,
    }));
    expect(result.warnings).toEqual([]);
    expect(telegramSummary.sendTelegram).not.toHaveBeenCalled();
  });

  test('syncs Hyperliquid peak state directly from a live account snapshot', async () => {
    const peakPath = path.join(tempDir, 'defi-peak-pnl.json');
    const orchestrator = createOrchestrator({
      defiPeakPnlPath: peakPath,
    });

    const result = await orchestrator.syncDefiPeakStateFromStatus({
      ok: true,
      checkedAt: '2026-03-28T20:10:00.000Z',
      accountValue: 708.4,
      positions: [
        { coin: 'ETH', size: -1.7113, side: 'short', entryPx: 2008.1, unrealizedPnl: 17.46, liquidationPx: 2361.69 },
      ],
    }, {
      trigger: 'execution_snapshot',
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      trigger: 'execution_snapshot',
      positions: [
        expect.objectContaining({
          coin: 'ETH',
          side: 'short',
          peakUnrealizedPnl: 17.46,
        }),
      ],
    }));
    expect(JSON.parse(fs.readFileSync(peakPath, 'utf8'))).toEqual(expect.objectContaining({
      positions: expect.objectContaining({
        'ETH:short': expect.objectContaining({
          peakUnrealizedPnl: 17.46,
          unrealizedPnl: 17.46,
        }),
      }),
    }));
    expect(telegramSummary.sendTelegram).not.toHaveBeenCalled();
  });

  test('auto-executes post-consensus Hyperliquid close/open actions and persists stop state when auto-open is explicitly enabled', async () => {
    const peakPath = path.join(tempDir, 'defi-peak-pnl.json');
    fs.writeFileSync(peakPath, JSON.stringify({
      updatedAt: '2026-03-28T20:00:00.000Z',
      positions: {
        'LINK:short': {
          coin: 'LINK',
          side: 'short',
          peakUnrealizedPnl: 16.93,
          stopLossPrice: 8.91,
        },
      },
    }, null, 2));
    mockExecFile.mockImplementation((_command, _args, _options, callback) => {
      callback(null, {
        stdout: '[defi] Stop loss: $2140.5\n[defi] TP2: $1840.0\n',
        stderr: '',
      });
    });
    const orchestrator = createOrchestrator({
      defiPeakPnlPath: peakPath,
    });

    const autoExecution = await orchestrator.maybeAutoExecuteLiveConsensus([
      {
        ticker: 'LINK/USD',
        consensus: true,
        decision: 'SELL',
        confidence: 0.81,
      },
      {
        ticker: 'ETH/USD',
        consensus: true,
        decision: 'SHORT',
        confidence: 0.84,
      },
    ], [
      {
        ticker: 'ETH/USD',
        consensus: { decision: 'SHORT' },
        referencePrice: 2100,
        riskCheck: { maxShares: 0.25, margin: 105, stopLossPrice: 2140.5, leverage: 5 },
      },
    ], {
      positions: [
        { coin: 'LINK', side: 'short', size: -10 },
      ],
    }, {
      autoExecuteLiveConsensus: true,
      allowHyperliquidAutoOpen: true,
      consultationRequestId: 'consult-live-eth-short-1',
      hyperliquidExecutionDryRun: true,
      hyperliquidExecuteScriptPath: path.join(tempDir, 'hm-defi-execute.js'),
      hyperliquidCloseScriptPath: path.join(tempDir, 'hm-defi-close.js'),
      positionManagementPlan: {
        managedTickers: ['LINK/USD'],
        directives: [
          { ticker: 'LINK/USD', asset: 'LINK', action: 'close', executable: true, consensusConfidence: 0.81, rationale: 'invalidate thesis' },
        ],
        executableDirectives: [
          { ticker: 'LINK/USD', asset: 'LINK', action: 'close', executable: true, consensusConfidence: 0.81, rationale: 'invalidate thesis' },
        ],
      },
    });

    expect(autoExecution).toEqual(expect.objectContaining({
      enabled: true,
      attempted: 2,
      succeeded: 2,
      executions: [
        expect.objectContaining({
          ticker: 'LINK/USD',
          action: 'close',
          ok: true,
        }),
        expect.objectContaining({
          ticker: 'ETH/USD',
          action: 'open',
          ok: true,
        }),
      ],
    }));
    expect(mockExecFile).toHaveBeenNthCalledWith(
      1,
      process.execPath,
      [path.join(tempDir, 'hm-defi-close.js'), '--dry-run', '--asset', 'LINK'],
      expect.objectContaining({ cwd: expect.any(String), windowsHide: true }),
      expect.any(Function)
    );
    const secondExecCall = mockExecFile.mock.calls[1];
    expect(secondExecCall[0]).toBe(process.execPath);
    expect(secondExecCall[1]).toEqual(expect.arrayContaining([
      path.join(tempDir, 'hm-defi-execute.js'),
      '--dry-run',
      'trade',
      '--asset',
      'ETH',
      '--direction',
      'SHORT',
      '--leverage',
      '5',
      '--margin',
      '105',
      '--confidence',
      '0.84',
      '--no-stop',
      '--client-order-id',
    ]));
    expect(secondExecCall[1]).not.toContain('--stop-loss');
    expect(secondExecCall[2]).toEqual(expect.objectContaining({ cwd: expect.any(String), windowsHide: true }));
    expect(typeof secondExecCall[3]).toBe('function');
    expect(JSON.parse(fs.readFileSync(peakPath, 'utf8'))).toEqual(expect.objectContaining({
      positions: expect.objectContaining({
        'ETH:short': expect.objectContaining({
          coin: 'ETH',
          side: 'short',
          stopLossPrice: 2140.5,
        }),
      }),
    }));
    expect(JSON.parse(fs.readFileSync(peakPath, 'utf8')).positions['LINK:short']).toBeUndefined();
  });

  test('uses averageAgreeConfidence when post-consensus execution results omit confidence', async () => {
    mockExecFile.mockImplementation((_command, _args, _options, callback) => {
      callback(null, { stdout: 'ok', stderr: '' });
    });
    const orchestrator = createOrchestrator();

    const autoExecution = await orchestrator.maybeAutoExecuteLiveConsensus([
      {
        ticker: 'ETH/USD',
        consensus: true,
        decision: 'SHORT',
        averageAgreeConfidence: 0.84,
      },
    ], [
      {
        ticker: 'ETH/USD',
        consensus: { decision: 'SHORT' },
        referencePrice: 2100,
        riskCheck: { maxShares: 0.25, margin: 105, stopLossPrice: 2140.5, leverage: 5 },
      },
    ], {
      positions: [],
    }, {
      autoExecuteLiveConsensus: true,
      allowHyperliquidAutoOpen: true,
      hyperliquidExecutionDryRun: true,
      hyperliquidExecuteScriptPath: path.join(tempDir, 'hm-defi-execute.js'),
      hyperliquidCloseScriptPath: path.join(tempDir, 'hm-defi-close.js'),
    });

    expect(autoExecution.executions).toEqual([
      expect.objectContaining({
        ticker: 'ETH/USD',
        action: 'open',
        ok: true,
      }),
    ]);
    expect(autoExecution.skipped).toEqual([]);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  test('auto-executes a near-threshold live consensus once the floor is lowered to 0.60', async () => {
    mockExecFile.mockImplementation((_command, _args, _options, callback) => {
      callback(null, { stdout: 'ok', stderr: '' });
    });
    const orchestrator = createOrchestrator();

    const autoExecution = await orchestrator.maybeAutoExecuteLiveConsensus([
      {
        ticker: 'ORDI/USD',
        consensus: true,
        decision: 'SELL',
        confidence: 0.695,
      },
    ], [
      {
        ticker: 'ORDI/USD',
        consensus: { decision: 'SELL' },
        referencePrice: 42.5,
        riskCheck: { maxShares: 0.75, margin: 95, stopLossPrice: 44.1, leverage: 5 },
      },
    ], {
      positions: [],
    }, {
      autoExecuteLiveConsensus: true,
      allowHyperliquidAutoOpen: true,
      hyperliquidExecutionDryRun: true,
      hyperliquidExecuteScriptPath: path.join(tempDir, 'hm-defi-execute.js'),
      hyperliquidCloseScriptPath: path.join(tempDir, 'hm-defi-close.js'),
    });

    expect(autoExecution.executions).toEqual([
      expect.objectContaining({
        ticker: 'ORDI/USD',
        action: 'open',
        ok: true,
      }),
    ]);
    expect(autoExecution.skipped).toEqual([]);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(mockExecFile.mock.calls[0][1]).toEqual(expect.arrayContaining([
      path.join(tempDir, 'hm-defi-execute.js'),
      '--dry-run',
      'trade',
      '--asset',
      'ORDI',
      '--direction',
      'SELL',
      '--no-stop',
    ]));
  });

  test('auto-opened BUY entries use monitor-owned protection instead of exchange-owned stops', async () => {
    mockExecFile.mockImplementation((_command, _args, _options, callback) => {
      callback(null, { stdout: 'ok', stderr: '' });
    });
    const orchestrator = createOrchestrator();

    const autoExecution = await orchestrator.maybeAutoExecuteLiveConsensus([
      {
        ticker: 'ETH/USD',
        consensus: true,
        decision: 'BUY',
        confidence: 0.81,
      },
    ], [
      {
        ticker: 'ETH/USD',
        consensus: { decision: 'BUY' },
        referencePrice: 2100,
        riskCheck: { maxShares: 0.25, margin: 105, stopLossPrice: 2058.5, leverage: 5 },
      },
    ], {
      positions: [],
    }, {
      autoExecuteLiveConsensus: true,
      allowHyperliquidAutoOpen: true,
      hyperliquidExecutionDryRun: true,
      hyperliquidExecuteScriptPath: path.join(tempDir, 'hm-defi-execute.js'),
      hyperliquidCloseScriptPath: path.join(tempDir, 'hm-defi-close.js'),
    });

    expect(autoExecution.executions).toEqual([
      expect.objectContaining({
        ticker: 'ETH/USD',
        action: 'open',
        decision: 'BUY',
        ok: true,
      }),
    ]);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(mockExecFile.mock.calls[0][1]).toEqual(expect.arrayContaining([
      path.join(tempDir, 'hm-defi-execute.js'),
      '--dry-run',
      'trade',
      '--asset',
      'ETH',
      '--direction',
      'BUY',
      '--no-stop',
    ]));
  });

  test('caps flat sub-1k Hyperliquid auto-execution to the single best oracle-backed name', async () => {
    mockExecFile.mockImplementation((_command, _args, _options, callback) => {
      callback(null, { stdout: 'ok', stderr: '' });
    });
    const orchestrator = createOrchestrator();

    const autoExecution = await orchestrator.maybeAutoExecuteLiveConsensus([
      {
        ticker: 'ETH/USD',
        consensus: true,
        decision: 'SHORT',
        confidence: 0.81,
      },
      {
        ticker: 'BTC/USD',
        consensus: true,
        decision: 'BUY',
        confidence: 0.87,
      },
    ], [
      {
        ticker: 'ETH/USD',
        consensus: { ticker: 'ETH/USD', decision: 'SHORT', agreeing: [{ confidence: 0.81 }, { confidence: 0.78 }] },
        referencePrice: 2100,
        riskCheck: { maxShares: 0.25, margin: 105, stopLossPrice: 2140.5, leverage: 5 },
        signalLookup: {
          oracle: { ticker: 'ETH/USD', direction: 'SHORT', confidence: 0.81 },
        },
      },
      {
        ticker: 'BTC/USD',
        consensus: { ticker: 'BTC/USD', decision: 'BUY', agreeing: [{ confidence: 0.87 }, { confidence: 0.82 }] },
        referencePrice: 76000,
        riskCheck: { maxShares: 0.003, margin: 95, stopLossPrice: 74800, leverage: 5 },
        signalLookup: {
          oracle: { ticker: 'BTC/USD', direction: 'BUY', confidence: 0.87 },
        },
      },
    ], {
      accountValue: 689,
      withdrawable: 689,
      positions: [],
    }, {
      autoExecuteLiveConsensus: true,
      allowHyperliquidAutoOpen: true,
      hyperliquidExecutionDryRun: true,
      eventVeto: { decision: 'CLEAR', affectedAssets: [] },
      macroRisk: { regime: 'yellow' },
      hyperliquidExecuteScriptPath: path.join(tempDir, 'hm-defi-execute.js'),
      hyperliquidCloseScriptPath: path.join(tempDir, 'hm-defi-close.js'),
    });

    expect(autoExecution.executions).toEqual([
      expect.objectContaining({
        ticker: 'BTC/USD',
        action: 'open',
        ok: true,
      }),
    ]);
    expect(autoExecution.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ticker: 'ETH/USD',
        reason: 'single_best_name_cap',
      }),
    ]));
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(mockExecFile.mock.calls[0][1]).toEqual(expect.arrayContaining([
      path.join(tempDir, 'hm-defi-execute.js'),
      '--dry-run',
      'trade',
      '--asset',
      'BTC',
      '--direction',
      'BUY',
    ]));
  });

  test('rejects an exact-threshold 0.60 average confidence instead of passing a blind spot downstream', async () => {
    const orchestrator = createOrchestrator({
      consultationEnabled: false,
      minAgreeConfidence: 0.6,
    });

    orchestrator.registerSignal('architect', 'AAPL', {
      direction: 'BUY',
      confidence: 0.6,
      reasoning: 'architect exact-threshold buy',
    });
    orchestrator.registerSignal('builder', 'AAPL', {
      direction: 'BUY',
      confidence: 0.6,
      reasoning: 'builder exact-threshold buy',
    });
    orchestrator.registerSignal('oracle', 'AAPL', {
      direction: 'HOLD',
      confidence: 0.8,
      reasoning: 'oracle unconvinced',
    });

    const result = await orchestrator.runConsensusRound({
      symbols: ['AAPL'],
    });
    expect(result.approvedTrades).toEqual([]);
    expect(result.rejectedTrades).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ticker: 'AAPL',
        riskCheck: expect.objectContaining({
          violations: expect.arrayContaining([
            expect.stringContaining('average confidence > 0.60'),
          ]),
        }),
      }),
    ]));
  });

  test('stop-ship disables Hyperliquid auto-open by default while preserving safe auto-close', async () => {
    mockExecFile.mockImplementation((_command, _args, _options, callback) => {
      callback(null, { stdout: 'ok', stderr: '' });
    });
    const orchestrator = createOrchestrator();

    const autoExecution = await orchestrator.maybeAutoExecuteLiveConsensus([
      {
        ticker: 'LINK/USD',
        consensus: true,
        decision: 'SELL',
        confidence: 0.81,
      },
      {
        ticker: 'ETH/USD',
        consensus: true,
        decision: 'SHORT',
        confidence: 0.84,
      },
    ], [
      {
        ticker: 'ETH/USD',
        consensus: { decision: 'SHORT' },
        referencePrice: 2100,
        riskCheck: { maxShares: 0.25, margin: 105, stopLossPrice: 2140.5, leverage: 5 },
      },
    ], {
      positions: [
        { coin: 'LINK', side: 'long', size: 10 },
      ],
    }, {
      autoExecuteLiveConsensus: true,
      hyperliquidExecutionDryRun: true,
      hyperliquidExecuteScriptPath: path.join(tempDir, 'hm-defi-execute.js'),
      hyperliquidCloseScriptPath: path.join(tempDir, 'hm-defi-close.js'),
    });
    expect(autoExecution.executions).toEqual([]);
    expect(autoExecution.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ticker: 'LINK/USD',
        asset: 'LINK',
        reason: 'auto_close_disabled_agent_managed',
      }),
    ]));
    expect(autoExecution.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ticker: 'ETH/USD',
        asset: 'ETH',
        reason: 'auto_open_disabled_stop_ship',
      }),
    ]));
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  test('flattens live Hyperliquid positions when kill switch action is flatten_positions', async () => {
    const peakPath = path.join(tempDir, 'kill-switch-peak.json');
    fs.writeFileSync(peakPath, JSON.stringify({
      updatedAt: '2026-04-05T23:00:00.000Z',
      positions: {
        'ETH:short': { coin: 'ETH', side: 'short', stopLossPrice: 2140.5 },
        'WLD:short': { coin: 'WLD', side: 'short', stopLossPrice: 0.256984 },
      },
    }, null, 2));
    mockExecFile.mockImplementation((_command, _args, _options, callback) => {
      callback(null, { stdout: 'closed', stderr: '' });
    });
    const orchestrator = createOrchestrator({
      defiPeakPnlPath: peakPath,
    });

    const autoExecution = await orchestrator.maybeAutoExecuteLiveConsensus([], [], {
      positions: [
        { coin: 'ETH', side: 'short', size: -0.25 },
        { coin: 'WLD', side: 'short', size: -53 },
      ],
    }, {
      autoExecuteLiveConsensus: true,
      killSwitchTriggered: true,
      hyperliquidKillSwitchAction: 'flatten_positions',
      hyperliquidExecutionDryRun: true,
      hyperliquidExecuteScriptPath: path.join(tempDir, 'hm-defi-execute.js'),
      hyperliquidCloseScriptPath: path.join(tempDir, 'hm-defi-close.js'),
    });

    expect(autoExecution).toEqual(expect.objectContaining({
      enabled: true,
      attempted: 2,
      succeeded: 2,
      killSwitchTriggered: true,
      killSwitchAction: 'flatten_positions',
      executions: [
        expect.objectContaining({ ticker: 'ETH/USD', action: 'close', source: 'kill_switch_flatten', ok: true }),
        expect.objectContaining({ ticker: 'WLD/USD', action: 'close', source: 'kill_switch_flatten', ok: true }),
      ],
    }));
    expect(JSON.parse(fs.readFileSync(peakPath, 'utf8')).positions).toEqual({});
  });

  test('runHyperliquidScript retries a transient timeout and recovers on the next attempt', async () => {
    const timeoutError = new Error('hm-defi-execute timed out after 120000ms');
    timeoutError.killed = true;
    timeoutError.signal = 'SIGTERM';
    mockExecFile
      .mockImplementationOnce((_command, _args, _options, callback) => {
        callback(timeoutError);
      })
      .mockImplementationOnce((_command, _args, _options, callback) => {
        callback(null, { stdout: 'ok', stderr: '' });
      });
    const orchestrator = createOrchestrator();

    const result = await orchestrator.runHyperliquidScript(
      path.join(tempDir, 'hm-defi-execute.js'),
      ['--dry-run', 'trade', '--asset', 'ETH', '--direction', 'SHORT'],
      {
        hyperliquidExecutionRetryMs: 1,
        hyperliquidExecutionRetries: 1,
      }
    );

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      attemptCount: 2,
      recoveredAfterRetry: true,
    }));
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });

  test('sends a funds-check Telegram alert when Hyperliquid auto-open fails for insufficient balance', async () => {
    const insufficientFundsError = new Error('hm-defi-execute failed');
    insufficientFundsError.stderr = '[defi][ERROR] Only $8.00 on Hyperliquid - need at least $10. Deposit may still be arriving.';
    mockExecFile.mockImplementation((_command, _args, _options, callback) => {
      callback(insufficientFundsError);
    });
    const orchestrator = createOrchestrator();

    const autoExecution = await orchestrator.maybeAutoExecuteLiveConsensus([
      {
        ticker: 'ETH/USD',
        consensus: true,
        decision: 'SHORT',
        confidence: 0.84,
      },
    ], [
      {
        ticker: 'ETH/USD',
        consensus: { decision: 'SHORT' },
        referencePrice: 2100,
        riskCheck: { maxShares: 0.25, margin: 105, stopLossPrice: 2140.5, leverage: 5 },
      },
    ], {
      positions: [],
    }, {
      autoExecuteLiveConsensus: true,
      allowHyperliquidAutoOpen: true,
      hyperliquidExecutionDryRun: true,
      hyperliquidExecuteScriptPath: path.join(tempDir, 'hm-defi-execute.js'),
      hyperliquidCloseScriptPath: path.join(tempDir, 'hm-defi-close.js'),
      hyperliquidExecutionRetries: 0,
    });

    expect(autoExecution.executions).toEqual([
      expect.objectContaining({
        ticker: 'ETH/USD',
        action: 'open',
        ok: false,
        issue: expect.objectContaining({
          insufficientFunds: true,
        }),
        fundsNotificationSent: true,
      }),
    ]);
    expect(telegramSummary.sendTelegram).toHaveBeenCalledWith(expect.stringContaining('insufficient funds'));
  });

  test('treats live-position assets as owned by position-management even when the directive is advisory', async () => {
    const orchestrator = createOrchestrator({
      autoExecuteLiveConsensus: true,
      hyperliquidExecutionDryRun: true,
      hyperliquidExecuteScriptPath: path.join(tempDir, 'hm-defi-execute.js'),
      hyperliquidCloseScriptPath: path.join(tempDir, 'hm-defi-close.js'),
    });

    const autoExecution = await orchestrator.maybeAutoExecuteLiveConsensus([
      { ticker: 'LINK/USD', decision: 'SELL', confidence: 0.88, consensus: true },
    ], [], {
      positions: [
        { coin: 'LINK', side: 'short', size: -1 },
      ],
    }, {
      positionManagementPlan: {
        managedTickers: ['LINK/USD'],
        directives: [
          { ticker: 'LINK/USD', asset: 'LINK', action: 'hold', executable: false },
        ],
        executableDirectives: [],
      },
    });

    expect(autoExecution.executions).toEqual([]);
    expect(autoExecution.skipped).toEqual([
      expect.objectContaining({
        ticker: 'LINK/USD',
        asset: 'LINK',
        reason: 'managed_by_position_management',
      }),
    ]);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  test('runs the Hyperliquid monitor on its own interval', async () => {
    jest.useFakeTimers();
    try {
      const setIntervalSpy = jest.spyOn(global, 'setInterval');
      const orchestrator = createOrchestrator({
        defiMonitorIntervalMs: 50,
        defiPeakPnlPath: path.join(tempDir, 'defi-peak-pnl.json'),
      });

      orchestrator.startDefiMonitor();
      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 1000);
      orchestrator.stopDefiMonitor();
    } finally {
      jest.useRealTimers();
    }
  });

  test('defaults the live equity premarket universe to the ETF strategy profile', async () => {
    const orchestrator = createOrchestrator();

    const result = await orchestrator.runPreMarket({
      date: '2026-03-20',
    });

    expect(result.symbols).toEqual(['SPY', 'QQQ', 'GLD', 'TLT', 'XLE']);
  });

  test('admits 2-of-3 equity buys when the live unanimous_or_high floor is above 0.60, not at it', async () => {
    const orchestrator = createOrchestrator({
      consultationEnabled: false,
    });

    orchestrator.registerSignal('architect', 'AAPL', {
      direction: 'BUY',
      confidence: 0.69,
      reasoning: 'architect low conviction buy',
    });
    orchestrator.registerSignal('builder', 'AAPL', {
      direction: 'BUY',
      confidence: 0.70,
      reasoning: 'builder low conviction buy',
    });
    orchestrator.registerSignal('oracle', 'AAPL', {
      direction: 'HOLD',
      confidence: 0.80,
      reasoning: 'oracle not convinced',
    });

    const result = await orchestrator.runConsensusRound({
      symbols: ['AAPL'],
    });
    expect(result.approvedTrades).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ticker: 'AAPL',
      }),
    ]));
    expect(result.rejectedTrades).toEqual([]);
    expect(journal.recordConsensus).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      ticker: 'AAPL',
      actedOn: true,
    }));
  });

  test('macro red normalizes consultation and fallback BUY signals into HOLD before consensus', async () => {
    macroRiskGate.assessMacroRisk.mockResolvedValue({
      regime: 'red',
      score: 66,
      reason: 'Macro RED',
      constraints: {
        allowLongs: false,
        blockNewPositions: true,
        positionSizeMultiplier: 0.35,
        buyConfidenceMultiplier: 0.6,
        sellConfidenceMultiplier: 1.1,
      },
    });
    consultationStore.collectConsultationResponses.mockResolvedValueOnce({
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
    });

    const orchestrator = createOrchestrator({
      consultationSender: jest.fn(),
      consultationQuery: jest.fn(),
    });

    const result = await orchestrator.runConsensusRound({
      symbols: ['AAPL'],
      consultationTimeoutMs: 50,
    });

    expect(signalProducer.produceSignals).toHaveBeenCalledWith('builder', expect.objectContaining({
      macroRisk: expect.objectContaining({ regime: 'red' }),
    }));
    expect(journal.recordConsensus).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      ticker: 'AAPL',
      architectSignal: expect.objectContaining({ direction: 'HOLD', reasoning: expect.stringContaining('macro blocked') }),
      builderSignal: expect.objectContaining({ direction: 'HOLD' }),
      oracleSignal: expect.objectContaining({ direction: 'HOLD' }),
    }));
    expect(result.approvedTrades).toEqual([]);
  });

  test('records closed-position outcomes and builds daily trade stats', async () => {
    mockTrades = [
      {
        id: 1,
        timestamp: '2026-03-19T14:30:00.000Z',
        ticker: 'AAPL',
        direction: 'BUY',
        shares: 2,
        price: 100,
        total_value: 200,
        status: 'FILLED',
      },
      {
        id: 2,
        timestamp: '2026-03-19T19:30:00.000Z',
        ticker: 'AAPL',
        direction: 'SELL',
        shares: 2,
        price: 110,
        total_value: 220,
        status: 'FILLED',
      },
    ];

    const orchestrator = createOrchestrator();
    const result = await orchestrator.runReconciliation({
      date: '2026-03-19',
      agentAttributionStatePath: '/tmp/agent-attribution.json',
    });

    expect(agentAttribution.recordOutcome).toHaveBeenCalledWith(
      'AAPL',
      'BUY',
      expect.closeTo(20 / 200, 6),
      '2026-03-19T19:30:00.000Z',
      expect.objectContaining({
        assetClass: 'us_equity',
        marketType: 'stocks',
        source: 'trade_reconciliation',
      })
    );
    expect(journal.recordExecutionReport).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      phase: 'reconciliation',
      reportType: 'trade_outcome',
      tradeId: 2,
      ticker: 'AAPL',
      realizedPnl: 20,
    }));
    expect(result).toEqual(expect.objectContaining({
      phase: 'reconciliation',
      marketDate: '2026-03-19',
      orderUpdates: [],
      recordedOutcomes: [
        expect.objectContaining({
          tradeId: 2,
          ticker: 'AAPL',
          realizedPnl: 20,
        }),
      ],
      dailySummary: expect.objectContaining({
        totalTrades: 2,
        wins: 1,
        losses: 0,
        netPnl: 20,
        bestTrade: expect.objectContaining({ ticker: 'AAPL', pnl: 20 }),
        worstTrade: expect.objectContaining({ ticker: 'AAPL', pnl: 20 }),
      }),
    }));
  });

  test('writes end-of-day summary rows with realized win/loss and best/worst trade data', async () => {
    mockTrades = [
      {
        id: 10,
        timestamp: '2026-03-19T14:30:00.000Z',
        ticker: 'AAPL',
        direction: 'BUY',
        shares: 1,
        price: 100,
        total_value: 100,
        status: 'FILLED',
      },
      {
        id: 11,
        timestamp: '2026-03-19T19:30:00.000Z',
        ticker: 'AAPL',
        direction: 'SELL',
        shares: 1,
        price: 112,
        total_value: 112,
        status: 'FILLED',
        realized_pnl: 12,
        outcome_recorded_at: '2026-03-19T19:31:00.000Z',
      },
      {
        id: 12,
        timestamp: '2026-03-19T15:00:00.000Z',
        ticker: 'MSFT',
        direction: 'BUY',
        shares: 1,
        price: 200,
        total_value: 200,
        status: 'FILLED',
      },
      {
        id: 13,
        timestamp: '2026-03-19T20:00:00.000Z',
        ticker: 'MSFT',
        direction: 'SELL',
        shares: 1,
        price: 190,
        total_value: 190,
        status: 'FILLED',
        realized_pnl: -10,
        outcome_recorded_at: '2026-03-19T20:01:00.000Z',
      },
    ];
    executor.getAccountSnapshot.mockResolvedValue({ equity: 10150 });
    const orchestrator = createOrchestrator();
    orchestrator.state.meta.marketDate = '2026-03-19';
    orchestrator.state.meta.dayStartEquity = 10000;
    orchestrator.state.meta.peakEquity = 10180;
    orchestrator.state.phases.reconciliation = {
      phase: 'reconciliation',
      marketDate: '2026-03-19',
      syncedPositions: [],
      dailySummary: {
        totalTrades: 4,
        wins: 1,
        losses: 1,
        netPnl: 2,
        bestTrade: { ticker: 'AAPL', pnl: 12 },
        worstTrade: { ticker: 'MSFT', pnl: -10 },
      },
    };

    const result = await orchestrator.runEndOfDay({
      date: '2026-03-19',
      sendTelegram: false,
    });

    expect(journal.recordDailySummary).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      date: '2026-03-19',
      tradesCount: 4,
      wins: 1,
      losses: 1,
      bestTradeTicker: 'AAPL',
      bestTradePnl: 12,
      worstTradeTicker: 'MSFT',
      worstTradePnl: -10,
    }));
    expect(mockRecordedDailySummaries).toEqual([
      expect.objectContaining({
        bestTradeTicker: 'AAPL',
        worstTradeTicker: 'MSFT',
      }),
    ]);
    expect(result).toEqual(expect.objectContaining({
      realizedSummary: expect.objectContaining({
        netPnl: 2,
      }),
      summary: expect.objectContaining({
        bestTradeTicker: 'AAPL',
        worstTradeTicker: 'MSFT',
      }),
    }));
  });

  test('enriches positions with stop/TP from Hyperliquid reduce-only open orders', async () => {
    const peakPath = path.join(tempDir, 'defi-peak-stop-enrich.json');
    const defiStatusProvider = jest.fn().mockResolvedValue({
      ok: true,
      checkedAt: '2026-04-14T10:00:00.000Z',
      positions: [
        { coin: 'ETH', size: 0.0996, side: 'long', entryPx: 2387.8, unrealizedPnl: -0.21, liquidationPx: 2192.79 },
      ],
    });
    const orchestrator = createOrchestrator({
      defiPeakPnlPath: peakPath,
      defiStatusProvider,
    });
    // Mock fetchHyperliquidOpenOrders to return reduce-only orders (stop + TP)
    orchestrator.fetchHyperliquidOpenOrders = jest.fn().mockResolvedValue([
      { coin: 'ETH', side: 'A', limitPx: '2458.0', sz: '0.0996', reduceOnly: true, triggerPx: undefined },
      { coin: 'ETH', side: 'A', limitPx: '2340.0', sz: '0.0996', reduceOnly: true, triggerPx: '2352.0' },
    ]);

    const result = await orchestrator.runDefiMonitorCycle({ trigger: 'interval' });
    expect(result.positions[0]).toEqual(expect.objectContaining({
      coin: 'ETH',
      stopLossPrice: 2352,
    }));
    expect(orchestrator.fetchHyperliquidOpenOrders).toHaveBeenCalled();
  });

  test('uses triggerPx over limitPx for stop-market orders', async () => {
    const peakPath = path.join(tempDir, 'defi-peak-trigger.json');
    const defiStatusProvider = jest.fn().mockResolvedValue({
      ok: true,
      checkedAt: '2026-04-14T10:00:00.000Z',
      positions: [
        { coin: 'SOL', size: -5, side: 'short', entryPx: 86.5, unrealizedPnl: 2.5, liquidationPx: 95.0 },
      ],
    });
    const orchestrator = createOrchestrator({
      defiPeakPnlPath: peakPath,
      defiStatusProvider,
    });
    orchestrator.fetchHyperliquidOpenOrders = jest.fn().mockResolvedValue([
      // Stop-market buy above entry for short = stop loss. triggerPx is the real trigger.
      { coin: 'SOL', side: 'B', limitPx: '89.0', sz: '5', reduceOnly: true, triggerPx: '88.0' },
      // TP buy below entry for short
      { coin: 'SOL', side: 'B', limitPx: '82.0', sz: '5', reduceOnly: true },
    ]);

    const result = await orchestrator.runDefiMonitorCycle({ trigger: 'interval' });
    // triggerPx (88.0) should be used, not limitPx (89.0)
    expect(result.positions[0]).toEqual(expect.objectContaining({
      coin: 'SOL',
      stopLossPrice: 88,
    }));
  });
});
