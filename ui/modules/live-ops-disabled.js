'use strict';

const DISABLED_REASON = 'live_ops_removed_from_public_core';

function disabledResult(extra = {}) {
  return {
    ok: false,
    skipped: true,
    reason: DISABLED_REASON,
    ...extra,
  };
}

function noOp() {
  return disabledResult();
}

async function noOpAsync() {
  return disabledResult();
}

function disabledModule(extra = {}) {
  return new Proxy(extra, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return noOp;
    },
  });
}

function createDisabledOrchestrator() {
  return {
    options: { limits: {} },
    clearSignals() {},
    runPreMarket: noOpAsync,
    runConsensusRound: async () => ({ ok: true, results: [], approvedTrades: [] }),
    maybeAutoExecuteLiveConsensus: async () => ({ ok: true, attempted: 0, succeeded: 0, executions: [] }),
    runMarketOpen: noOpAsync,
  };
}

class DisabledSmartMoneyScanner {
  constructor() {
    this.running = false;
    this.pollMs = null;
    this.state = {
      health: 'disabled',
      recentTransfers: [],
      convergenceSignals: [],
      lastError: null,
      lastResult: null,
    };
  }

  start() {
    this.running = false;
    return disabledResult();
  }

  stop() {
    this.running = false;
    return disabledResult();
  }
}

function disabledDb() {
  const statement = {
    get: () => ({}),
    all: () => [],
    run: () => ({ changes: 0 }),
  };
  return {
    prepare: () => statement,
    close() {},
  };
}

const tradingOrchestrator = disabledModule({
  createOrchestrator: createDisabledOrchestrator,
});

const tradingScheduler = disabledModule({
  MARKET_TIME_ZONE: 'America/New_York',
  buildCryptoDailySchedule: () => ({ schedule: [] }),
  getNextCryptoWakeEvent: async () => null,
});

const dynamicWatchlist = disabledModule({
  getActiveEntries: () => [],
  promoteMarketScannerMovers: () => ({ ok: true, promoted: [] }),
});

const oracleWatchRegime = disabledModule({
  DEFAULT_SHARED_SHORT_REGIME_STATE_PATH: null,
  evaluateOrdiPatternPromotionGate: () => ({ ok: false, allowed: false, reason: DISABLED_REASON }),
  applySharedShortRegime: async () => disabledResult(),
});

const tradingRiskEngine = disabledModule({
  DEFAULT_CRYPTO_LIMITS: {
    maxPositionPct: 0,
    stopLossPct: 0,
  },
});

const consensusSizer = disabledModule({
  resolveAppliedSizeMultiplier: () => 1,
});

const convictionEngine = disabledModule({
  chooseDominantSetup: () => null,
  resolvePositionAction: () => ({ action: 'none', reason: DISABLED_REASON }),
});

const rangeStructure = disabledModule({
  analyzeRangeStructure: () => ({ ok: false, reason: DISABLED_REASON }),
});

const [private-live-ops]Client = disabledModule({
  has[private-live-ops]Credentials: () => false,
  getAccountSnapshot: async () => ({}),
  getOpenPositions: async () => [],
  getHistoricalBars: async () => [],
});

const [private-live-ops]NativeLayer = disabledModule({
  buildNativeFeatureBundle: async () => ({ ok: false, reason: DISABLED_REASON }),
});

const agentPositionAttribution = disabledModule({
  DEFAULT_POSITION_ATTRIBUTION_STATE_PATH: null,
  reconcilePositionAttributionWithLivePositions: () => disabledResult(),
});

const manualActivity = {
  DEFAULT_LIVE_OPS_MANUAL_ACTIVITY_PATH: null,
  readManual[private-live-ops]Activity: () => null,
  isManual[private-live-ops]ActivityActive: () => false,
};

const marketScannerModule = disabledModule({
  defaultMarketScannerState: () => ({ enabled: false, status: 'disabled', movers: [] }),
  normalizeMarketScannerState: (value = {}) => ({ enabled: false, status: 'disabled', movers: [], ...value }),
  buildMoverMap: () => new Map(),
  normalizeMover: (entry = {}) => entry,
});

const sparkCapture = disabledModule({
  DEFAULT_SPARK_STATE_PATH: null,
  DEFAULT_SPARK_EVENTS_PATH: null,
  DEFAULT_SPARK_FIREPLANS_PATH: null,
  DEFAULT_SPARK_WATCHLIST_PATH: null,
  runSparkScan: async () => ({ ok: true, state: marketScannerModule.defaultMarketScannerState(), events: [], firePlans: [] }),
});

const predictionTrackerModule = disabledModule({
  eventHeader: () => null,
  checkOilPrice: () => disabledResult(),
  logPrediction: () => disabledResult(),
  scorePredictions: () => [],
});

const tradeJournal = disabledModule({
  getDb: disabledDb,
});

module.exports = {
  DISABLED_REASON,
  tradingOrchestrator,
  tradingScheduler,
  tradingWatchlist: disabledModule(),
  dynamicWatchlist,
  oracleWatchRegime,
  tradingRiskEngine,
  consensusSizer,
  convictionEngine,
  rangeStructure,
  [private-live-ops]Client,
  [private-live-ops]NativeLayer,
  agentPositionAttribution,
  manualActivity,
  SmartMoneyScanner: DisabledSmartMoneyScanner,
  createEtherscanProvider: () => null,
  macroRiskGate: disabledModule(),
  marketScannerModule,
  sparkCapture,
  predictionTrackerModule,
  eventVeto: disabledModule(),
  tradeJournal,
};
