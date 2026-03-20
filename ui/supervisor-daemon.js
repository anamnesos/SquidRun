const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const chokidar = require('chokidar');
const { spawn } = require('child_process');
const { execFileSync } = require('child_process');
const { getDatabaseSync } = require('./modules/sqlite-compat');
const DatabaseSync = getDatabaseSync();

const { resolveCoordPath, getProjectRoot } = require('./config');
const { SupervisorStore } = require('./modules/supervisor');
const { CognitiveMemoryStore } = require('./modules/cognitive-memory-store');
const { MemorySearchIndex, resolveWorkspacePaths } = require('./modules/memory-search');
const { runMemoryConsistencyCheck } = require('./modules/memory-consistency-check');
const {
  SleepConsolidator,
  DEFAULT_IDLE_THRESHOLD_MS,
  DEFAULT_MIN_INTERVAL_MS,
  resolveSessionStatePath,
} = require('./modules/cognitive-memory-sleep');
const { stageImmediateTaskExtraction } = require('./modules/cognitive-memory-immunity');
const {
  readSystemCapabilitiesSnapshot,
  resolveSleepExtractionCommandFromSnapshot,
} = require('./modules/local-model-capabilities');
const tradingOrchestrator = require('./modules/trading/orchestrator');
const tradingScheduler = require('./modules/trading/scheduler');
const tradingWatchlist = require('./modules/trading/watchlist');
const tradingRiskEngine = require('./modules/trading/risk-engine');
const { SmartMoneyScanner, createEtherscanProvider } = require('./modules/trading/smart-money-scanner');
const macroRiskGate = require('./modules/trading/macro-risk-gate');
const { CircuitBreaker } = require('./modules/trading/circuit-breaker');
const polymarketClient = require('./modules/trading/polymarket-client');
const polymarketScanner = require('./modules/trading/polymarket-scanner');
const polymarketSignals = require('./modules/trading/polymarket-signals');
const polymarketSizer = require('./modules/trading/polymarket-sizer');
const launchRadar = require('./modules/trading/launch-radar');
const yieldRouterModule = require('./modules/trading/yield-router');

const DEFAULT_POLL_MS = Math.max(1000, Number.parseInt(process.env.SQUIDRUN_SUPERVISOR_POLL_MS || '4000', 10) || 4000);
const DEFAULT_HEARTBEAT_MS = Math.max(1000, Number.parseInt(process.env.SQUIDRUN_SUPERVISOR_HEARTBEAT_MS || '15000', 10) || 15000);
const DEFAULT_LEASE_MS = Math.max(DEFAULT_HEARTBEAT_MS + 1000, Number.parseInt(process.env.SQUIDRUN_SUPERVISOR_LEASE_MS || '60000', 10) || 60000);
const DEFAULT_MAX_WORKERS = Math.max(1, Number.parseInt(process.env.SQUIDRUN_SUPERVISOR_MAX_WORKERS || '2', 10) || 2);
const DEFAULT_PENDING_TASK_TTL_MS = parseOptionalDurationMs(
  process.env.SQUIDRUN_SUPERVISOR_PENDING_TTL_MS,
  24 * 60 * 60 * 1000
);
const DEFAULT_STDIO_TAIL_BYTES = Math.max(2048, Number.parseInt(process.env.SQUIDRUN_SUPERVISOR_STDIO_TAIL_BYTES || '16384', 10) || 16384);
const DEFAULT_MEMORY_INDEX_DEBOUNCE_MS = Math.max(500, Number.parseInt(process.env.SQUIDRUN_MEMORY_INDEX_DEBOUNCE_MS || '2000', 10) || 2000);
const DEFAULT_MEMORY_CONSISTENCY_POLL_MS = Math.max(60_000, Number.parseInt(process.env.SQUIDRUN_MEMORY_CONSISTENCY_POLL_MS || '300000', 10) || 300000);
const DEFAULT_MAX_IDLE_BACKOFF_MS = Math.max(
  DEFAULT_POLL_MS,
  Number.parseInt(process.env.SQUIDRUN_SUPERVISOR_MAX_IDLE_BACKOFF_MS || String(DEFAULT_POLL_MS * 8), 10)
  || (DEFAULT_POLL_MS * 8)
);
const DEFAULT_SLEEP_IDLE_MS = DEFAULT_IDLE_THRESHOLD_MS;
const DEFAULT_SLEEP_MIN_INTERVAL_MS = DEFAULT_MIN_INTERVAL_MS;

function resolveRuntimePath(relPath) {
  return resolveCoordPath(path.join('runtime', relPath), { forWrite: true });
}

const DEFAULT_PID_PATH = resolveRuntimePath('supervisor.pid');
const DEFAULT_STATUS_PATH = resolveRuntimePath('supervisor-status.json');
const DEFAULT_LOG_PATH = resolveRuntimePath('supervisor.log');
const DEFAULT_TASK_LOG_DIR = resolveRuntimePath(path.join('supervisor-tasks'));
const DEFAULT_WAKE_SIGNAL_PATH = resolveRuntimePath('supervisor-wake.signal');
const DEFAULT_TRADING_STATE_PATH = resolveRuntimePath('trading-supervisor-state.json');
const DEFAULT_CRYPTO_TRADING_STATE_PATH = resolveRuntimePath('crypto-trading-supervisor-state.json');
const DEFAULT_POLYMARKET_TRADING_STATE_PATH = resolveRuntimePath('polymarket-trading-state.json');
const DEFAULT_LAUNCH_RADAR_STATE_PATH = resolveRuntimePath('launch-radar-supervisor-state.json');
const DEFAULT_YIELD_ROUTER_STATE_PATH = resolveRuntimePath('yield-router-supervisor-state.json');
const HM_SEND_SCRIPT_PATH = path.join(__dirname, 'scripts', 'hm-send.js');
const TRADING_AGENT_TARGETS = Object.freeze(['architect', 'builder', 'oracle']);
const TRADING_PHASES = Object.freeze([
  { key: 'premarket_wake', label: 'Pre-market wake', offsetMinutes: -60 },
  { key: 'pre_open_consensus', label: 'Consensus round', offsetMinutes: -5 },
  { key: 'market_open_execute', label: 'Market open execute', offsetMinutes: 0 },
  { key: 'close_wake', label: 'Close wake', anchor: 'close', offsetMinutes: -30 },
  { key: 'market_close_review', label: 'Market close review', anchor: 'close', offsetMinutes: 0 },
  { key: 'end_of_day', label: 'End of day', anchor: 'close', offsetMinutes: 30 },
]);
const POLYMARKET_PHASES = Object.freeze([
  { key: 'polymarket_scan', label: 'Polymarket market scan', offsetMinutes: 0 },
  { key: 'polymarket_consensus', label: 'Polymarket consensus round', offsetMinutes: 5, internalOnly: true },
  { key: 'polymarket_execute', label: 'Polymarket order execution', offsetMinutes: 10, internalOnly: true },
  { key: 'polymarket_monitor', label: 'Polymarket position monitor', kind: 'monitor' },
]);
const POLYMARKET_SCHEDULE_PHASES = Object.freeze(
  POLYMARKET_PHASES.filter((phase) => phase.key === 'polymarket_scan' || phase.key === 'polymarket_monitor')
);
const LAUNCH_RADAR_PHASES = Object.freeze([
  { key: 'launch_radar_scan', label: 'Launch radar scan' },
]);
const DEFAULT_LAUNCH_RADAR_INTERVAL_MINUTES = 15;
const YIELD_ROUTER_PHASES = Object.freeze([
  { key: 'yield_rebalance', label: 'Yield router rebalance' },
]);
const DEFAULT_YIELD_ROUTER_INTERVAL_MINUTES = 6 * 60;

function ensureDir(targetPath) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
}

function ensureDirectory(targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
}

function readJsonFile(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, payload) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
}

function trimTail(value, maxBytes = DEFAULT_STDIO_TAIL_BYTES) {
  const text = typeof value === 'string' ? value : String(value || '');
  if (!text) return '';
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return text;
  return buffer.slice(buffer.length - maxBytes).toString('utf8');
}

function appendFileSafe(filePath, chunk) {
  try {
    fs.appendFileSync(filePath, chunk);
  } catch {}
}

function createLogger(logPath) {
  ensureDir(logPath);
  return {
    info(message) {
      const line = `[${new Date().toISOString()}] [INFO] ${message}\n`;
      process.stdout.write(line);
      appendFileSafe(logPath, line);
    },
    warn(message) {
      const line = `[${new Date().toISOString()}] [WARN] ${message}\n`;
      process.stderr.write(line);
      appendFileSafe(logPath, line);
    },
    error(message) {
      const line = `[${new Date().toISOString()}] [ERROR] ${message}\n`;
      process.stderr.write(line);
      appendFileSafe(logPath, line);
    },
  };
}

function processExists(pid) {
  const numeric = Number(pid);
  if (!Number.isFinite(numeric) || numeric <= 0) return false;
  try {
    process.kill(numeric, 0);
    return true;
  } catch {
    return false;
  }
}

function parseOptionalDurationMs(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const numeric = Number.parseInt(String(value), 10);
  if (!Number.isFinite(numeric)) return fallback;
  if (numeric <= 0) return 0;
  return Math.max(1000, numeric);
}

function defaultTradingState() {
  return {
    marketDate: null,
    sleeping: true,
    phases: {},
    nextEvent: null,
    updatedAt: null,
  };
}

function defaultCryptoTradingState() {
  return {
    lastProcessedAt: null,
    lastResult: null,
    nextEvent: null,
    updatedAt: null,
  };
}

function defaultPolymarketTradingState() {
  return {
    lastProcessedAt: null,
    lastResult: null,
    nextEvent: null,
    dayStartDate: null,
    dayStartBankroll: null,
    lastScan: null,
    lastConsensus: null,
    lastExecution: null,
    lastMonitor: null,
    updatedAt: null,
  };
}

function defaultLaunchRadarState() {
  return {
    lastProcessedAt: null,
    lastResult: null,
    nextEvent: null,
    lastScan: null,
    updatedAt: null,
  };
}

function defaultYieldRouterState() {
  return {
    lastProcessedAt: null,
    lastResult: null,
    nextEvent: null,
    lastRebalance: null,
    updatedAt: null,
  };
}

function getDateKeyInTimeZone(value = new Date(), timeZone = tradingScheduler.MARKET_TIME_ZONE) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(value instanceof Date ? value : new Date(value));
}

function startOfUtcDay(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0));
}

function buildLaunchRadarDailySchedule(referenceDate = new Date(), options = {}) {
  const intervalMinutes = Math.max(1, Math.floor(Number(options.intervalMinutes) || DEFAULT_LAUNCH_RADAR_INTERVAL_MINUTES));
  const start = startOfUtcDay(referenceDate);
  const marketDate = start.toISOString().slice(0, 10);
  const schedule = [];

  for (let minuteOfDay = 0; minuteOfDay < (24 * 60); minuteOfDay += intervalMinutes) {
    const scheduledAt = new Date(start.getTime() + (minuteOfDay * 60 * 1000));
    for (const phase of LAUNCH_RADAR_PHASES) {
      schedule.push({
        key: phase.key,
        label: phase.label,
        marketDate,
        scheduledAt: scheduledAt.toISOString(),
        scheduledTimeLocal: scheduledAt.toISOString(),
        displayTimeZone: 'UTC',
        windowKey: scheduledAt.toISOString(),
      });
    }
  }

  return {
    marketDate,
    intervalMinutes,
    displayTimeZone: 'UTC',
    schedule,
  };
}

function getNextLaunchRadarEvent(referenceDate = new Date(), options = {}) {
  const now = referenceDate instanceof Date ? referenceDate : new Date(referenceDate);
  for (let offset = 0; offset < 3; offset += 1) {
    const candidateDate = new Date(now.getTime() + (offset * 24 * 60 * 60 * 1000));
    const day = buildLaunchRadarDailySchedule(candidateDate, options);
    const nextEvent = day.schedule.find((event) => new Date(event.scheduledAt).getTime() > now.getTime());
    if (nextEvent) {
      return {
        ...nextEvent,
        day,
      };
    }
  }
  return null;
}

function buildYieldRouterDailySchedule(referenceDate = new Date(), options = {}) {
  const intervalMinutes = Math.max(1, Math.floor(Number(options.intervalMinutes) || DEFAULT_YIELD_ROUTER_INTERVAL_MINUTES));
  const start = startOfUtcDay(referenceDate);
  const marketDate = start.toISOString().slice(0, 10);
  const schedule = [];

  for (let minuteOfDay = 0; minuteOfDay < (24 * 60); minuteOfDay += intervalMinutes) {
    const scheduledAt = new Date(start.getTime() + (minuteOfDay * 60 * 1000));
    for (const phase of YIELD_ROUTER_PHASES) {
      schedule.push({
        key: phase.key,
        label: phase.label,
        marketDate,
        scheduledAt: scheduledAt.toISOString(),
        scheduledTimeLocal: scheduledAt.toISOString(),
        displayTimeZone: 'UTC',
        windowKey: scheduledAt.toISOString(),
      });
    }
  }

  return {
    marketDate,
    intervalMinutes,
    displayTimeZone: 'UTC',
    schedule,
  };
}

function getNextYieldRouterEvent(referenceDate = new Date(), options = {}) {
  const now = referenceDate instanceof Date ? referenceDate : new Date(referenceDate);
  for (let offset = 0; offset < 3; offset += 1) {
    const candidateDate = new Date(now.getTime() + (offset * 24 * 60 * 60 * 1000));
    const day = buildYieldRouterDailySchedule(candidateDate, options);
    const nextEvent = day.schedule.find((event) => new Date(event.scheduledAt).getTime() > now.getTime());
    if (nextEvent) {
      return {
        ...nextEvent,
        day,
      };
    }
  }
  return null;
}

function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const options = {
    once: false,
    dbPath: null,
    logPath: null,
    statusPath: null,
    pidPath: null,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i] || '');
    if (arg === '--once' || arg === '--daemon') {
      options.once = arg === '--once';
    } else if (arg === '--db-path') {
      options.dbPath = args[i + 1] || null;
      i += 1;
    } else if (arg === '--log-path') {
      options.logPath = args[i + 1] || null;
      i += 1;
    } else if (arg === '--status-path') {
      options.statusPath = args[i + 1] || null;
      i += 1;
    } else if (arg === '--pid-path') {
      options.pidPath = args[i + 1] || null;
      i += 1;
    }
  }

  return options;
}

function acquirePidFile(pidPath) {
  ensureDir(pidPath);
  const existing = readJsonFile(pidPath, null);
  if (existing && existing.pid && processExists(existing.pid) && Number(existing.pid) !== process.pid) {
    return { ok: false, reason: 'already_running', pid: Number(existing.pid) };
  }

  const payload = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(pidPath, JSON.stringify(payload, null, 2));
  return { ok: true };
}

class MemoryLeaseJanitor {
  constructor(options = {}) {
    this.cognitiveStore = options.cognitiveStore || new CognitiveMemoryStore(options.cognitiveStoreOptions || {});
    this.ownsCognitiveStore = !options.cognitiveStore;
    this.db = null;
  }

  init() {
    if (this.db) return this.db;
    this.cognitiveStore.init();
    this.db = new DatabaseSync(this.cognitiveStore.dbPath);
    this.db.exec('PRAGMA journal_mode=WAL;');
    this.db.exec('PRAGMA synchronous=NORMAL;');
    this.db.exec('PRAGMA foreign_keys=ON;');
    this.db.exec('PRAGMA busy_timeout=5000;');
    return this.db;
  }

  pruneExpiredLeases(nowMs = Date.now()) {
    const db = this.init();
    const leaseTable = db.prepare(`
      SELECT 1 AS present
      FROM sqlite_master
      WHERE type = 'table' AND name = 'memory_leases'
      LIMIT 1
    `).get();
    if (Number(leaseTable?.present || 0) !== 1) {
      return { ok: true, pruned: 0, skipped: true, reason: 'missing_table' };
    }
    const result = db.prepare('DELETE FROM memory_leases WHERE expires_at_ms <= ?').run(nowMs);
    return {
      ok: true,
      pruned: Number(result?.changes || 0),
    };
  }

  close() {
    if (this.db) {
      try { this.db.close(); } catch {}
      this.db = null;
    }
    if (this.ownsCognitiveStore) {
      try { this.cognitiveStore.close(); } catch {}
    }
  }
}

class SupervisorDaemon {
  constructor(options = {}) {
    this.projectRoot = path.resolve(String(options.projectRoot || getProjectRoot() || process.cwd()));
    this.store = options.store || new SupervisorStore({ dbPath: options.dbPath });
    this.pollMs = Math.max(1000, Number.parseInt(options.pollMs || DEFAULT_POLL_MS, 10) || DEFAULT_POLL_MS);
    this.heartbeatMs = Math.max(1000, Number.parseInt(options.heartbeatMs || DEFAULT_HEARTBEAT_MS, 10) || DEFAULT_HEARTBEAT_MS);
    this.leaseMs = Math.max(this.heartbeatMs + 1000, Number.parseInt(options.leaseMs || DEFAULT_LEASE_MS, 10) || DEFAULT_LEASE_MS);
    this.maxWorkers = Math.max(1, Number.parseInt(options.maxWorkers || DEFAULT_MAX_WORKERS, 10) || DEFAULT_MAX_WORKERS);
    this.pendingTaskTtlMs = parseOptionalDurationMs(options.pendingTaskTtlMs, DEFAULT_PENDING_TASK_TTL_MS);
    this.pidPath = options.pidPath || DEFAULT_PID_PATH;
    this.statusPath = options.statusPath || DEFAULT_STATUS_PATH;
    this.logPath = options.logPath || DEFAULT_LOG_PATH;
    this.taskLogDir = options.taskLogDir || DEFAULT_TASK_LOG_DIR;
    this.workerLeaseOwnerPrefix = String(options.workerLeaseOwnerPrefix || 'supervisor');
    this.logger = options.logger || createLogger(this.logPath);
    this.activeWorkers = new Map();
    this.loopEvents = new EventEmitter();
    this.tickTimer = null;
    this.tickInFlight = null;
    this.nextTickAtMs = 0;
    this.pendingWakeReason = null;
    this.currentBackoffMs = this.pollMs;
    this.maxIdleBackoffMs = Math.max(
      this.pollMs,
      Number.parseInt(options.maxIdleBackoffMs || DEFAULT_MAX_IDLE_BACKOFF_MS, 10) || DEFAULT_MAX_IDLE_BACKOFF_MS
    );
    this.statusTimer = null;
    this.stopping = false;
    this.startedAtMs = Date.now();
    this.memoryIndexWatcher = null;
    this.wakeSignalWatcher = null;
    this.memoryIndexDebounceTimer = null;
    this.memoryIndexRefreshPromise = null;
    this.pendingMemoryIndexReason = null;
    this.memoryIndexDebounceMs = Math.max(
      500,
      Number.parseInt(options.memoryIndexDebounceMs || DEFAULT_MEMORY_INDEX_DEBOUNCE_MS, 10)
      || DEFAULT_MEMORY_INDEX_DEBOUNCE_MS
    );
    this.memoryConsistencyEnabled = options.memoryConsistencyEnabled !== false;
    this.memoryConsistencyPollMs = Math.max(
      60_000,
      Number.parseInt(options.memoryConsistencyPollMs || DEFAULT_MEMORY_CONSISTENCY_POLL_MS, 10)
      || DEFAULT_MEMORY_CONSISTENCY_POLL_MS
    );
    this.lastMemoryConsistencySummary = null;
    this.lastMemoryConsistencyCheckAtMs = 0;
    this.memoryIndexEnabled = options.memoryIndexEnabled !== false
      && process.env.SQUIDRUN_MEMORY_INDEX_WATCHER !== '0';
    this.memorySearchIndex = this.memoryIndexEnabled
      ? (options.memorySearchIndex || new MemorySearchIndex())
      : null;
    this.leaseJanitor = options.leaseJanitor || new MemoryLeaseJanitor({
      cognitiveStoreOptions: options.cognitiveStoreOptions,
    });
    this.sleepEnabled = options.sleepEnabled !== false
      && process.env.SQUIDRUN_SLEEP_CYCLE !== '0';
    this.sleepIdleMs = Math.max(
      60_000,
      Number.parseInt(options.sleepIdleMs || DEFAULT_SLEEP_IDLE_MS, 10)
      || DEFAULT_SLEEP_IDLE_MS
    );
    this.sleepMinIntervalMs = Math.max(
      30_000,
      Number.parseInt(options.sleepMinIntervalMs || DEFAULT_SLEEP_MIN_INTERVAL_MS, 10)
      || DEFAULT_SLEEP_MIN_INTERVAL_MS
    );
    this.sessionStatePath = options.sessionStatePath || resolveSessionStatePath();
    this.sleepCyclePromise = null;
    this.lastSleepCycleSummary = null;
    this.wakeSignalPath = options.wakeSignalPath || DEFAULT_WAKE_SIGNAL_PATH;
    this.tradingEnabled = options.tradingEnabled !== false
      && process.env.SQUIDRUN_TRADING_AUTOMATION !== '0';
    this.tradingStatePath = options.tradingStatePath || DEFAULT_TRADING_STATE_PATH;
    this.tradingState = {
      ...defaultTradingState(),
      ...(readJsonFile(this.tradingStatePath, defaultTradingState()) || {}),
    };
    this.tradingPhasePromise = null;
    this.lastTradingSummary = this.tradingEnabled
      ? {
        enabled: true,
        status: 'idle',
        marketDate: this.tradingState.marketDate || null,
        sleeping: this.tradingState.sleeping !== false,
        nextEvent: this.tradingState.nextEvent || null,
      }
      : {
        enabled: false,
        status: 'disabled',
        marketDate: null,
        sleeping: true,
        nextEvent: null,
      };
    this.tradingOrchestrator = this.tradingEnabled
      ? (options.tradingOrchestrator || tradingOrchestrator.createOrchestrator({
        journalPath: resolveRuntimePath('trade-journal.db'),
      }))
      : null;
    this.cryptoTradingEnabled = options.cryptoTradingEnabled !== false
      && process.env.SQUIDRUN_CRYPTO_TRADING_AUTOMATION !== '0';
    this.cryptoTradingStatePath = options.cryptoTradingStatePath || DEFAULT_CRYPTO_TRADING_STATE_PATH;
    this.cryptoTradingState = {
      ...defaultCryptoTradingState(),
      ...(readJsonFile(this.cryptoTradingStatePath, defaultCryptoTradingState()) || {}),
    };
    this.cryptoTradingPhasePromise = null;
    this.lastCryptoTradingSummary = this.cryptoTradingEnabled
      ? {
        enabled: true,
        status: 'idle',
        lastProcessedAt: this.cryptoTradingState.lastProcessedAt || null,
        nextEvent: this.cryptoTradingState.nextEvent || null,
      }
      : {
        enabled: false,
        status: 'disabled',
        lastProcessedAt: null,
        nextEvent: null,
      };
    this.cryptoTradingOrchestrator = this.cryptoTradingEnabled
      ? (options.cryptoTradingOrchestrator || tradingOrchestrator.createOrchestrator({
        journalPath: resolveRuntimePath('trade-journal.db'),
      }))
      : null;

    // Smart money scanner — watches for whale convergence and triggers immediate consensus rounds
    this.smartMoneyScanner = this.cryptoTradingEnabled && options.smartMoneyScanner !== null
      ? (options.smartMoneyScanner || new SmartMoneyScanner({
        provider: createEtherscanProvider({ minUsdValue: 50_000 }),
        pollMs: 60_000,
        minUsdValue: 50_000,
        minWalletCount: 2,
        convergenceWindowMs: 15 * 60_000,
        triggerCooldownMs: 30 * 60_000,
        statePath: resolveRuntimePath('smart-money-scanner-state.json'),
        onTrigger: async (trigger) => {
          this.logger.info(`Smart money convergence detected: ${trigger.ticker} on ${trigger.chain} — triggering immediate consensus`);
          this.smartMoneyScannerLastTrigger = {
            ticker: trigger.ticker,
            chain: trigger.chain,
            reason: trigger.reason,
            at: new Date().toISOString(),
          };
          // Trigger an immediate crypto consensus round for the detected ticker
          if (this.cryptoTradingOrchestrator && !this.cryptoTradingPhasePromise) {
            const event = {
              key: 'smart_money_trigger',
              label: `Smart money convergence: ${trigger.ticker}`,
              marketDate: new Date().toISOString().slice(0, 10),
              scheduledAt: new Date().toISOString(),
            };
            this.cryptoTradingPhasePromise = this.runCryptoConsensusPhase(event)
              .then((result) => {
                this.lastCryptoTradingSummary = {
                  enabled: true,
                  status: 'completed',
                  trigger: 'smart_money',
                  ...result,
                };
                this.writeStatus();
                return result;
              })
              .catch((err) => {
                this.logger.error(`Smart money triggered consensus failed: ${err.message}`);
                return { ok: false, error: err.message };
              })
              .finally(() => {
                this.cryptoTradingPhasePromise = null;
              });
          }
        },
      }))
      : null;
    this.smartMoneyScannerLastTrigger = null;

    // Circuit breaker — continuous position monitor with stop-loss execution
    const executor = require('./modules/trading/executor');
    const dataIngestion = require('./modules/trading/data-ingestion');
    this.circuitBreaker = this.cryptoTradingEnabled && options.circuitBreaker !== null
      ? (options.circuitBreaker || new CircuitBreaker({
        pollMs: 30_000,
        hardStopPct: 0.04,   // 4% loss from entry
        trailingStopPct: 0.03, // 3% drop from high-water mark
        flashCrashPct: 0.05,  // 5% portfolio drop → sell all
        minPositionValueUsd: 10,
        cooldownMs: 5 * 60_000,
        statePath: resolveRuntimePath('circuit-breaker-state.json'),
        logger: this.logger,
        getPositions: async () => executor.getOpenPositions(),
        getSnapshots: async (symbols) => dataIngestion.getWatchlistSnapshots({ symbols }),
        executeSell: async (ticker, shares, reason) => {
          this.logger.warn(`[circuit-breaker] Executing emergency SELL: ${ticker} x${shares} — ${reason}`);
          try {
            const result = await executor.submitOrder({
              ticker,
              direction: 'SELL',
              shares,
              assetClass: 'crypto',
              type: 'market',
              timeInForce: 'gtc',
            });
            this.logger.info(`[circuit-breaker] SELL ${ticker} submitted: ${result?.orderId || 'ok'}`);
            return { ok: true, orderId: result?.orderId };
          } catch (err) {
            this.logger.error(`[circuit-breaker] SELL ${ticker} failed: ${err.message}`);
            return { ok: false, error: err.message };
          }
        },
        getAccountEquity: async () => {
          const account = await executor.getAccountSnapshot();
          return Number(account?.equity) || 0;
        },
      }))
      : null;

    const polymarketConfigured = (() => {
      try {
        return Boolean(polymarketClient.resolvePolymarketConfig(process.env)?.configured);
      } catch {
        return false;
      }
    })();
    const polymarketAutomationRequested = options.polymarketTradingEnabled === true
      || process.env.SQUIDRUN_POLYMARKET_AUTOMATION === '1';
    this.polymarketTradingEnabled = Boolean(polymarketAutomationRequested && polymarketConfigured);
    this.polymarketTradingStatePath = options.polymarketTradingStatePath || DEFAULT_POLYMARKET_TRADING_STATE_PATH;
    this.polymarketTradingState = {
      ...defaultPolymarketTradingState(),
      ...(readJsonFile(this.polymarketTradingStatePath, defaultPolymarketTradingState()) || {}),
    };
    this.polymarketTradingPhasePromise = null;
    this.lastPolymarketTradingSummary = this.polymarketTradingEnabled
      ? {
        enabled: true,
        status: 'idle',
        lastProcessedAt: this.polymarketTradingState.lastProcessedAt || null,
        nextEvent: this.polymarketTradingState.nextEvent || null,
      }
      : {
        enabled: false,
        status: 'disabled',
        reason: polymarketConfigured ? 'manual_opt_in_required' : 'credentials_unavailable',
        lastProcessedAt: null,
        nextEvent: null,
      };
    this.polymarketClient = options.polymarketClient || polymarketClient;
    this.polymarketScanner = options.polymarketScanner || polymarketScanner;
    this.polymarketSignals = options.polymarketSignals || polymarketSignals;
    this.polymarketSizer = options.polymarketSizer || polymarketSizer;
    this.polymarketTradingOrchestrator = this.polymarketTradingEnabled
      ? (options.polymarketTradingOrchestrator || tradingOrchestrator.createOrchestrator({
        journalPath: resolveRuntimePath('trade-journal.db'),
        smartMoneyScanner: this.smartMoneyScanner,
      }))
      : null;
    const launchRadarAutomationRequested = options.launchRadarEnabled === true
      || process.env.SQUIDRUN_LAUNCH_RADAR_AUTOMATION === '1';
    this.launchRadarEnabled = Boolean(launchRadarAutomationRequested);
    this.launchRadarDryRun = options.launchRadarDryRun === true
      || process.env.SQUIDRUN_LAUNCH_RADAR_DRY_RUN === '1';
    this.launchRadarStatePath = options.launchRadarStatePath || DEFAULT_LAUNCH_RADAR_STATE_PATH;
    this.launchRadarState = {
      ...defaultLaunchRadarState(),
      ...(readJsonFile(this.launchRadarStatePath, defaultLaunchRadarState()) || {}),
    };
    this.launchRadarPhasePromise = null;
    this.lastLaunchRadarSummary = this.launchRadarEnabled
      ? {
        enabled: true,
        status: 'idle',
        dryRun: this.launchRadarDryRun,
        lastProcessedAt: this.launchRadarState.lastProcessedAt || null,
        nextEvent: this.launchRadarState.nextEvent || null,
      }
      : {
        enabled: false,
        status: 'disabled',
        dryRun: this.launchRadarDryRun,
        lastProcessedAt: null,
        nextEvent: null,
      };
    this.launchRadar = this.launchRadarEnabled && options.launchRadar !== null
      ? (options.launchRadar || launchRadar.createLaunchRadar({
        statePath: resolveRuntimePath('launch-radar-state.json'),
        fetch: options.fetch || global.fetch,
        env: options.env || process.env,
      }))
      : null;
    this.launchRadarOrchestrator = this.launchRadarEnabled
      ? (options.launchRadarOrchestrator || tradingOrchestrator.createOrchestrator({
        journalPath: resolveRuntimePath('trade-journal.db'),
        dynamicWatchlistStatePath: resolveRuntimePath('dynamic-watchlist-state.json'),
        launchRadar: this.launchRadar,
      }))
      : null;
    const yieldRouterAutomationRequested = options.yieldRouterEnabled === true
      || process.env.SQUIDRUN_YIELD_ROUTER_AUTOMATION === '1';
    this.yieldRouterEnabled = Boolean(yieldRouterAutomationRequested);
    this.yieldRouterDryRun = options.yieldRouterDryRun === true
      || process.env.SQUIDRUN_YIELD_ROUTER_DRY_RUN === '1';
    this.yieldRouterStatePath = options.yieldRouterStatePath || DEFAULT_YIELD_ROUTER_STATE_PATH;
    this.yieldRouterState = {
      ...defaultYieldRouterState(),
      ...(readJsonFile(this.yieldRouterStatePath, defaultYieldRouterState()) || {}),
    };
    this.yieldRouterPhasePromise = null;
    this.lastYieldRouterSummary = this.yieldRouterEnabled
      ? {
        enabled: true,
        status: 'idle',
        dryRun: this.yieldRouterDryRun,
        lastProcessedAt: this.yieldRouterState.lastProcessedAt || null,
        nextEvent: this.yieldRouterState.nextEvent || null,
      }
      : {
        enabled: false,
        status: 'disabled',
        dryRun: this.yieldRouterDryRun,
        lastProcessedAt: null,
        nextEvent: null,
      };
    this.yieldRouter = this.yieldRouterEnabled && options.yieldRouter !== null
      ? (options.yieldRouter || yieldRouterModule.createYieldRouter({
        statePath: resolveRuntimePath('yield-router-state.json'),
        fetch: options.fetch || global.fetch,
        env: options.env || process.env,
      }))
      : null;
    this.yieldRouterOrchestrator = this.yieldRouterEnabled
      ? (options.yieldRouterOrchestrator || tradingOrchestrator.createOrchestrator({
        journalPath: resolveRuntimePath('trade-journal.db'),
        yieldRouter: this.yieldRouter,
      }))
      : null;
    if (this.yieldRouter) {
      if (this.tradingOrchestrator?.options) {
        this.tradingOrchestrator.options.yieldRouter = this.yieldRouter;
      }
      if (this.cryptoTradingOrchestrator?.options) {
        this.cryptoTradingOrchestrator.options.yieldRouter = this.yieldRouter;
      }
      if (this.polymarketTradingOrchestrator?.options) {
        this.polymarketTradingOrchestrator.options.yieldRouter = this.yieldRouter;
      }
      if (this.launchRadarOrchestrator?.options) {
        this.launchRadarOrchestrator.options.yieldRouter = this.yieldRouter;
      }
      if (this.yieldRouterOrchestrator?.options) {
        this.yieldRouterOrchestrator.options.yieldRouter = this.yieldRouter;
      }
    }
    this.sleepConsolidator = this.sleepEnabled
      ? (options.sleepConsolidator || new SleepConsolidator({
        logger: this.logger,
        cognitiveStoreOptions: options.cognitiveStoreOptions,
        memorySearchIndex: this.memorySearchIndex || options.memorySearchIndex || undefined,
        sessionStatePath: this.sessionStatePath,
        idleThresholdMs: this.sleepIdleMs,
        minIntervalMs: this.sleepMinIntervalMs,
      }))
      : null;
    this.lastSystemCapabilities = null;
    this.lastSleepExtractionCommand = null;

    this.loopEvents.on('wake', (reason) => {
      this.handleWake(reason);
    });
  }

  refreshSleepExtractionCommand() {
    const snapshot = readSystemCapabilitiesSnapshot(this.projectRoot);
    this.lastSystemCapabilities = snapshot;
    const command = resolveSleepExtractionCommandFromSnapshot(snapshot);
    if (this.sleepConsolidator) {
      this.sleepConsolidator.extractionCommand = command;
    }
    if (command) {
      process.env.SQUIDRUN_SLEEP_EXTRACTION_COMMAND = command;
    } else {
      delete process.env.SQUIDRUN_SLEEP_EXTRACTION_COMMAND;
    }
    if (command !== this.lastSleepExtractionCommand) {
      this.lastSleepExtractionCommand = command;
      const mode = command
        ? `local (${snapshot?.localModels?.sleepExtraction?.model || 'unknown-model'})`
        : 'fallback';
      this.logger.info(`Sleep extraction path configured: ${mode}`);
    }
    return {
      command,
      snapshot,
    };
  }

  init() {
    const pidResult = acquirePidFile(this.pidPath);
    if (!pidResult.ok) {
      return pidResult;
    }

    ensureDirectory(this.taskLogDir);
    const initResult = this.store.init();
    if (!initResult.ok) {
      return initResult;
    }
    this.refreshSleepExtractionCommand();
    if (this.sleepConsolidator && typeof this.sleepConsolidator.init === 'function') {
      try {
        this.sleepConsolidator.init();
      } catch (err) {
        return {
          ok: false,
          reason: 'sleep_init_failed',
          error: err.message,
        };
      }
    }
    const leaseHousekeeping = this.runMemoryLeaseHousekeeping(Date.now(), 'startup');
    const housekeeping = this.runQueueHousekeeping(Date.now(), 'startup');
    const memoryConsistency = this.runMemoryConsistencyAudit('startup', Date.now());
    this.writeStatus();
    return { ok: true, store: this.store.getStatus(), leaseHousekeeping, memoryConsistency, ...housekeeping };
  }

  start() {
    const initResult = this.init();
    if (!initResult.ok) {
      return initResult;
    }

    this.logger.info(`Supervisor daemon started (pid=${process.pid}, db=${this.store.dbPath})`);
    this.startMemoryIndexWatcher();
    this.startWakeSignalWatcher();
    if (this.smartMoneyScanner) {
      this.smartMoneyScanner.start();
      this.logger.info('Smart money scanner started');
    }
    if (this.circuitBreaker) {
      this.circuitBreaker.start();
      this.logger.info('Circuit breaker started (30s poll, 4% hard stop, 3% trailing stop, 5% flash crash)');
    }
    this.requestTick('startup');
    this.statusTimer = setInterval(() => {
      this.writeStatus();
    }, Math.max(5000, this.heartbeatMs));
    if (typeof this.statusTimer.unref === 'function') {
      this.statusTimer.unref();
    }
    return { ok: true };
  }

  async stop(reason = 'shutdown') {
    if (this.stopping) return;
    this.stopping = true;

    if (this.tickTimer) clearTimeout(this.tickTimer);
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.tickTimer = null;
    this.statusTimer = null;

    await this.stopMemoryIndexWatcher();
    await this.stopWakeSignalWatcher();

    if (this.smartMoneyScanner) {
      this.smartMoneyScanner.stop();
      this.logger.info('Smart money scanner stopped');
    }
    if (this.circuitBreaker) {
      this.circuitBreaker.stop();
      this.logger.info('Circuit breaker stopped');
    }
    if (this.launchRadar && typeof this.launchRadar.stop === 'function') {
      this.launchRadar.stop();
      this.logger.info('Launch radar stopped');
    }
    if (this.yieldRouter && typeof this.yieldRouter.stop === 'function') {
      this.yieldRouter.stop();
      this.logger.info('Yield router stopped');
    }

    if (this.sleepConsolidator) {
      try { this.sleepConsolidator.close(); } catch {}
    }
    if (this.leaseJanitor) {
      try { this.leaseJanitor.close(); } catch {}
    }

    const workerStops = [];
    for (const [taskId, worker] of this.activeWorkers.entries()) {
      workerStops.push(this.stopWorker(taskId, worker, reason));
    }
    await Promise.allSettled(workerStops);
    this.writeStatus({ state: 'stopped', reason });
    this.store.close();

    try {
      fs.unlinkSync(this.pidPath);
    } catch {}
  }

  async tick() {
    if (this.stopping) return;
    const nowMs = Date.now();
    const queueHousekeeping = this.runQueueHousekeeping(nowMs, 'tick');
    const leaseHousekeeping = this.runMemoryLeaseHousekeeping(nowMs, 'tick');
    const memoryConsistency = this.maybeRunMemoryConsistencyAudit(nowMs, 'tick');
    let claimedCount = 0;

    while (!this.stopping && this.activeWorkers.size < this.maxWorkers) {
      const leaseOwner = `${this.workerLeaseOwnerPrefix}-${process.pid}`;
      const claim = this.store.claimNextTask({
        leaseOwner,
        leaseMs: this.leaseMs,
        nowMs: Date.now(),
      });
      if (!claim.ok) {
        this.logger.warn(`Task claim failed: ${claim.error || claim.reason || 'unknown'}`);
        break;
      }
      if (!claim.task) break;
      claimedCount += 1;
      await this.launchTask(claim.task, { leaseOwner });
    }

    const tradingResult = await this.maybeRunTradingAutomation(nowMs);
    const cryptoTradingResult = await this.maybeRunCryptoTradingAutomation(nowMs);
    const polymarketTradingResult = await this.maybeRunPolymarketTradingAutomation(nowMs);
    const launchRadarResult = await this.maybeRunLaunchRadarAutomation(nowMs);
    const yieldRouterResult = await this.maybeRunYieldRouterAutomation(nowMs);
    const sleepResult = await this.maybeRunSleepCycle();
    this.writeStatus();
    return {
      ok: true,
      claimedCount,
      activeWorkerCount: this.activeWorkers.size,
      queueHousekeeping,
      leaseHousekeeping,
      memoryConsistency,
      tradingResult,
      cryptoTradingResult,
      polymarketTradingResult,
      launchRadarResult,
      yieldRouterResult,
      sleepResult,
    };
  }

  requestTick(reason = 'manual') {
    this.loopEvents.emit('wake', String(reason || 'manual'));
  }

  handleWake(reason = 'manual') {
    if (this.stopping) return;
    const nextReason = String(reason || 'manual');
    if (this.tickInFlight) {
      this.pendingWakeReason = nextReason;
      return;
    }
    this.currentBackoffMs = this.pollMs;
    this.scheduleTick(0, nextReason);
  }

  scheduleTick(delayMs = this.pollMs, reason = 'scheduled') {
    if (this.stopping) return;
    const safeDelayMs = Math.max(0, Number.parseInt(delayMs, 10) || 0);
    const targetAtMs = Date.now() + safeDelayMs;
    if (this.tickTimer && this.nextTickAtMs > 0 && this.nextTickAtMs <= targetAtMs) {
      return;
    }
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
    }
    this.nextTickAtMs = targetAtMs;
    this.tickTimer = setTimeout(() => {
      this.tickTimer = null;
      this.nextTickAtMs = 0;
      this.runScheduledTick(reason).catch((err) => {
        this.logger.error(`Supervisor tick failed: ${err.message}`);
      });
    }, safeDelayMs);
    if (typeof this.tickTimer.unref === 'function') {
      this.tickTimer.unref();
    }
  }

  computeNextTickDelay(summary = null) {
    const claimedCount = Number(summary?.claimedCount || 0);
    const activeWorkerCount = Number(summary?.activeWorkerCount || 0);
    const queueRequeued = Number(summary?.queueHousekeeping?.requeueResult?.requeued || 0);
    const pendingPruned = Number(summary?.queueHousekeeping?.pruneResult?.pruned || 0);
    const leasePruned = Number(summary?.leaseHousekeeping?.pruned || 0);
    const tradingRan = summary?.tradingResult && summary.tradingResult.skipped !== true;
    const cryptoTradingRan = summary?.cryptoTradingResult && summary.cryptoTradingResult.skipped !== true;
    const polymarketTradingRan = summary?.polymarketTradingResult && summary.polymarketTradingResult.skipped !== true;
    const sleepRan = summary?.sleepResult && summary.sleepResult.skipped !== true;
    const memoryChecked = summary?.memoryConsistency && summary.memoryConsistency.skipped !== true;
    const performedWork = claimedCount > 0
      || queueRequeued > 0
      || pendingPruned > 0
      || leasePruned > 0
      || tradingRan
      || cryptoTradingRan
      || polymarketTradingRan
      || sleepRan
      || memoryChecked;

    if (performedWork || activeWorkerCount > 0) {
      this.currentBackoffMs = this.pollMs;
      return this.pollMs;
    }

    this.currentBackoffMs = Math.min(
      this.maxIdleBackoffMs,
      Math.max(this.pollMs, this.currentBackoffMs * 2)
    );
    return this.currentBackoffMs;
  }

  async runScheduledTick(reason = 'scheduled') {
    if (this.stopping) return;
    if (this.tickInFlight) {
      this.pendingWakeReason = String(reason || 'scheduled');
      return;
    }

    this.tickInFlight = this.tick();
    try {
      const summary = await this.tickInFlight;
      if (this.stopping) return;
      if (this.pendingWakeReason) {
        const followUpReason = this.pendingWakeReason;
        this.pendingWakeReason = null;
        this.scheduleTick(0, followUpReason);
        return;
      }
      this.scheduleTick(this.computeNextTickDelay(summary), reason);
    } finally {
      this.tickInFlight = null;
    }
  }

  getSleepActivitySnapshot(nowMs = Date.now()) {
    if (!this.sleepConsolidator || typeof this.sleepConsolidator.readActivitySnapshot !== 'function') {
      return null;
    }
    try {
      return this.sleepConsolidator.readActivitySnapshot(nowMs);
    } catch (err) {
      this.logger.warn('Sleep activity snapshot failed: ' + err.message);
      return null;
    }
  }

  async maybeRunSleepCycle(nowMs = Date.now()) {
    if (!this.sleepEnabled || this.stopping || !this.sleepConsolidator) {
      return { ok: false, skipped: true, reason: 'sleep_disabled' };
    }
    if (this.activeWorkers.size > 0) {
      return { ok: false, skipped: true, reason: 'workers_active' };
    }
    if (this.memoryIndexRefreshPromise) {
      return { ok: false, skipped: true, reason: 'memory_index_busy' };
    }
    if (this.sleepCyclePromise) {
      return this.sleepCyclePromise;
    }
    this.refreshSleepExtractionCommand();

    const decision = typeof this.sleepConsolidator.shouldRun === 'function'
      ? this.sleepConsolidator.shouldRun(nowMs)
      : { ok: false, activity: null, reason: 'missing_should_run' };
    if (!decision.ok) {
      this.lastSleepCycleSummary = {
        ...(this.lastSleepCycleSummary || {}),
        skipped: true,
        skipReason: decision.reason || (!decision.enoughGap ? 'interval_guard' : 'not_idle'),
        activity: decision.activity || null,
      };
      return { ok: false, skipped: true, reason: this.lastSleepCycleSummary.skipReason, activity: decision.activity || null };
    }

    this.sleepCyclePromise = Promise.resolve(this.sleepConsolidator.runOnce())
      .then((summary) => {
        this.lastSleepCycleSummary = summary;
        this.logger.info(
          'Sleep cycle complete: episodes='
          + String(summary.episodeCount || 0)
          + ' extracted=' + String(summary.extractedCount || 0)
          + ' prs=' + String(summary.generatedPrCount || 0)
        );
        return summary;
      })
      .catch((err) => {
        this.lastSleepCycleSummary = { ok: false, error: err.message, finishedAtMs: Date.now() };
        this.logger.warn('Sleep cycle failed: ' + err.message);
        throw err;
      })
      .finally(() => {
        this.sleepCyclePromise = null;
      });

    return this.sleepCyclePromise;
  }

  persistTradingState() {
    this.tradingState.updatedAt = new Date().toISOString();
    writeJsonFile(this.tradingStatePath, this.tradingState);
  }

  persistCryptoTradingState() {
    this.cryptoTradingState.updatedAt = new Date().toISOString();
    writeJsonFile(this.cryptoTradingStatePath, this.cryptoTradingState);
  }

  persistPolymarketTradingState() {
    this.polymarketTradingState.updatedAt = new Date().toISOString();
    writeJsonFile(this.polymarketTradingStatePath, this.polymarketTradingState);
  }

  persistLaunchRadarState() {
    this.launchRadarState.updatedAt = new Date().toISOString();
    writeJsonFile(this.launchRadarStatePath, this.launchRadarState);
  }

  persistYieldRouterState() {
    this.yieldRouterState.updatedAt = new Date().toISOString();
    writeJsonFile(this.yieldRouterStatePath, this.yieldRouterState);
  }

  describeTradingEvent(event) {
    if (!event) return null;
    return {
      key: String(event.key || ''),
      label: String(event.label || ''),
      marketDate: String(event.marketDate || ''),
      scheduledAt: String(event.scheduledAt || ''),
      scheduledTimeLocal: String(event.scheduledTimeLocal || ''),
      displayTimeZone: String(event.displayTimeZone || ''),
      windowKey: String(event.windowKey || ''),
    };
  }

  resetTradingStateForMarketDate(marketDate) {
    if (!marketDate || this.tradingState.marketDate === marketDate) return;
    this.tradingState = {
      ...defaultTradingState(),
      marketDate,
      sleeping: true,
    };
    this.persistTradingState();
  }

  isTradingPhaseComplete(marketDate, phaseKey) {
    if (this.tradingState.marketDate !== marketDate) return false;
    const phase = this.tradingState.phases && this.tradingState.phases[phaseKey];
    if (!phase) return false;
    return phase.status === 'completed' || phase.status === 'failed';
  }

  recordTradingPhaseState(marketDate, phaseKey, patch = {}) {
    if (!marketDate) return;
    if (this.tradingState.marketDate !== marketDate) {
      this.resetTradingStateForMarketDate(marketDate);
    }
    this.tradingState.phases = this.tradingState.phases || {};
    this.tradingState.phases[phaseKey] = {
      ...(this.tradingState.phases[phaseKey] || {}),
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.persistTradingState();
  }

  summarizeTradingPhaseResult(phaseKey, result) {
    if (!result || typeof result !== 'object') {
      return { phase: phaseKey, ok: true };
    }

    if (phaseKey === 'premarket_wake') {
      return {
        phase: phaseKey,
        marketDate: result.marketDate || null,
        symbols: Array.isArray(result.symbols) ? result.symbols.length : 0,
        watchlistSize: Array.isArray(result.watchlist) ? result.watchlist.length : 0,
      };
    }

    if (phaseKey === 'pre_open_consensus') {
      return {
        phase: phaseKey,
        marketDate: result.marketDate || null,
        approvedTrades: Array.isArray(result.approvedTrades) ? result.approvedTrades.length : 0,
        rejectedTrades: Array.isArray(result.rejectedTrades) ? result.rejectedTrades.length : 0,
        incompleteSignals: Array.isArray(result.incompleteSignals) ? result.incompleteSignals.length : 0,
      };
    }

    if (phaseKey === 'market_open_execute') {
      return {
        phase: phaseKey,
        marketDate: result.marketDate || null,
        executions: Array.isArray(result.executions) ? result.executions.length : 0,
      };
    }

    if (phaseKey === 'close_wake') {
      return {
        phase: phaseKey,
        marketDate: result.marketDate || null,
        reviews: Array.isArray(result.reviews) ? result.reviews.length : 0,
        exits: Array.isArray(result.exits) ? result.exits.length : 0,
      };
    }

    if (phaseKey === 'market_close_review') {
      return {
        phase: phaseKey,
        marketDate: result.marketDate || null,
        openPositions: Array.isArray(result.openPositions) ? result.openPositions.length : 0,
        liquidation: Boolean(result.liquidation),
        reconciledTrades: Array.isArray(result.reconciliation?.orderUpdates) ? result.reconciliation.orderUpdates.length : 0,
        outcomesRecorded: Array.isArray(result.reconciliation?.recordedOutcomes) ? result.reconciliation.recordedOutcomes.length : 0,
      };
    }

    if (phaseKey === 'end_of_day') {
      return {
        phase: phaseKey,
        marketDate: result.marketDate || null,
        pnl: Number(result.summary?.pnl || 0),
        pnlPct: Number(result.summary?.pnlPct || 0),
        trades: Array.isArray(result.trades) ? result.trades.length : 0,
      };
    }

    return {
      phase: phaseKey,
      marketDate: result.marketDate || null,
    };
  }

  buildTradingAgentMessage(phaseKey, tradingDay) {
    const marketDate = tradingDay?.marketDate || 'unknown-date';
    if (phaseKey === 'premarket_wake') {
      return {
        architect: `[TRADING] Pre-market wake for ${marketDate}. Coordinate watchlist review and collect signals before 6:25 AM PT consensus.`,
        builder: `[TRADING] Pre-market wake for ${marketDate}. Review the watchlist and register Builder signals before 6:25 AM PT.`,
        oracle: `[TRADING] Pre-market wake for ${marketDate}. Scan news and register Oracle signals before 6:25 AM PT.`,
      };
    }

    if (phaseKey === 'close_wake') {
      return {
        architect: `[TRADING] Close wake for ${marketDate}. Review positions and coordinate any profit-taking decisions before 1:00 PM PT.`,
        builder: `[TRADING] Close wake for ${marketDate}. Review open positions and prepare any exits before the close.`,
        oracle: `[TRADING] Close wake for ${marketDate}. Review late-day news or catalysts that could affect open positions.`,
      };
    }

    if (phaseKey === 'end_of_day') {
      return {
        architect: `[TRADING] End of day complete for ${marketDate}. Stand down until the next market wake.`,
        builder: `[TRADING] End of day complete for ${marketDate}. Stand down until the next market wake.`,
        oracle: `[TRADING] End of day complete for ${marketDate}. Stand down until the next market wake.`,
      };
    }

    return null;
  }

  notifyTradingAgents(phaseKey, tradingDay) {
    const messages = this.buildTradingAgentMessage(phaseKey, tradingDay);
    if (!messages) return;

    for (const target of TRADING_AGENT_TARGETS) {
      const message = messages[target];
      if (!message) continue;
      try {
        execFileSync(process.execPath, [HM_SEND_SCRIPT_PATH, target, message], {
          cwd: this.projectRoot,
          timeout: 15000,
          stdio: 'ignore',
        });
      } catch (err) {
        this.logger.warn(`Trading notify failed for ${target} during ${phaseKey}: ${err.message}`);
      }
    }
  }

  notifyTelegramTrading(message) {
    try {
      execFileSync(process.execPath, [HM_SEND_SCRIPT_PATH, 'telegram', message], {
        cwd: this.projectRoot,
        timeout: 15000,
        stdio: 'ignore',
      });
    } catch (err) {
      this.logger.warn(`Trading Telegram notify failed: ${err.message}`);
    }
  }

  async getTradingDaySchedule(date) {
    const calendarDay = await tradingScheduler.getCalendarDay(date, { projectRoot: this.projectRoot });
    if (!calendarDay) return null;
    return tradingScheduler.buildTradingDaySchedule(calendarDay, {
      phases: TRADING_PHASES,
    });
  }

  async getNextTradingEvent(referenceDate = new Date()) {
    const now = referenceDate instanceof Date ? referenceDate : new Date(referenceDate);
    for (let offset = 0; offset < 10; offset += 1) {
      const candidateDate = new Date(now.getTime() + (offset * 24 * 60 * 60 * 1000));
      const tradingDay = await this.getTradingDaySchedule(candidateDate);
      if (!tradingDay) continue;

      const nextEvent = tradingDay.schedule.find((event) => new Date(event.scheduledAt).getTime() > now.getTime());
      if (nextEvent) {
        return {
          ...nextEvent,
          tradingDay,
        };
      }
    }

    return null;
  }

  getCryptoSymbols() {
    return tradingWatchlist.getTickers({ assetClass: 'crypto' });
  }

  async getPolymarketBankrollSnapshot(now = new Date()) {
    const [balance, positions] = await Promise.all([
      this.polymarketClient.getBalance(),
      this.polymarketClient.getPositions(),
    ]);
    const normalizedPositions = Array.isArray(positions) ? positions : [];
    const marketValue = normalizedPositions.reduce((sum, position) => {
      return sum + Math.max(0, Number(position?.marketValue || 0));
    }, 0);
    const available = Number(balance?.available ?? balance?.balance ?? 0) || 0;
    const bankroll = Number((available + marketValue).toFixed(2));
    const dayKey = getDateKeyInTimeZone(now);
    if (this.polymarketTradingState.dayStartDate !== dayKey || !Number.isFinite(Number(this.polymarketTradingState.dayStartBankroll))) {
      this.polymarketTradingState.dayStartDate = dayKey;
      this.polymarketTradingState.dayStartBankroll = bankroll;
    }
    const dayStartBankroll = Number(this.polymarketTradingState.dayStartBankroll || bankroll) || bankroll;
    const dailyLossPct = dayStartBankroll > 0 ? Math.max(0, (dayStartBankroll - bankroll) / dayStartBankroll) : 0;

    return {
      balance,
      positions: normalizedPositions,
      bankroll,
      currentExposure: Number(marketValue.toFixed(2)),
      dayStartBankroll,
      dailyLossPct: Number(dailyLossPct.toFixed(6)),
    };
  }

  async getPolymarketCandidateMarkets(event, options = {}) {
    const cached = this.polymarketTradingState.lastScan;
    if (!options.forceRefresh && cached && cached.windowKey === event.windowKey && Array.isArray(cached.markets) && cached.markets.length > 0) {
      return cached.markets;
    }

    const markets = await this.polymarketScanner.scanMarkets({
      limit: options.limit || 12,
    });
    this.polymarketTradingState.lastScan = {
      windowKey: event.windowKey || event.scheduledAt,
      marketDate: event.marketDate || '',
      scheduledAt: event.scheduledAt || '',
      markets,
    };
    this.persistPolymarketTradingState();
    return markets;
  }

  async buildPolymarketConsensus(event, options = {}) {
    const cached = this.polymarketTradingState.lastConsensus;
    if (!options.forceRefresh && cached && cached.windowKey === event.windowKey && Array.isArray(cached.results)) {
      return cached;
    }

    const markets = await this.getPolymarketCandidateMarkets(event, options);
    const signalsByAgent = this.polymarketSignals.produceSignals(markets, {
      agentIds: TRADING_AGENT_TARGETS,
    });
    const results = markets.map((market) => {
      const marketSignals = TRADING_AGENT_TARGETS.map((agentId) => {
        return (signalsByAgent.get(agentId) || []).find((signal) => signal.conditionId === market.conditionId);
      }).filter(Boolean);
      if (marketSignals.length !== 3) return null;
      return {
        ...this.polymarketSignals.buildConsensus(marketSignals),
        market,
      };
    }).filter(Boolean);

    const payload = {
      windowKey: event.windowKey || event.scheduledAt,
      marketDate: event.marketDate || '',
      scheduledAt: event.scheduledAt || '',
      results,
      actionable: results.filter((result) => result.consensus && result.decision !== 'HOLD'),
      agentSignals: Object.fromEntries(Array.from(signalsByAgent.entries())),
    };
    this.polymarketTradingState.lastConsensus = payload;
    this.persistPolymarketTradingState();
    return payload;
  }

  async runPolymarketPhase(event) {
    const phaseKey = String(event?.key || '').trim();
    const scheduledAt = String(event?.scheduledAt || '').trim();
    const marketDate = String(event?.marketDate || getDateKeyInTimeZone(scheduledAt || new Date())).trim();
    if (!phaseKey || !scheduledAt || !this.polymarketTradingEnabled || !this.polymarketTradingOrchestrator) {
      return { ok: false, phase: phaseKey || 'unknown', error: 'polymarket_phase_unavailable' };
    }

    try {
      const phaseOptions = {
        date: marketDate || scheduledAt,
        broker: 'polymarket',
        assetClass: 'prediction_market',
        includePolymarket: true,
      };

      if (phaseKey === 'polymarket_scan' || phaseKey === 'polymarket_consensus') {
        const consensusPhase = await this.polymarketTradingOrchestrator.runPolymarketConsensusRound(phaseOptions);
        this.polymarketTradingState.lastScan = {
          windowKey: event.windowKey || event.scheduledAt,
          marketDate,
          scheduledAt,
          markets: Array.isArray(consensusPhase?.markets) ? consensusPhase.markets : [],
        };
        this.polymarketTradingState.lastConsensus = consensusPhase;
        let executionPhase = null;
        if (phaseKey === 'polymarket_scan') {
          executionPhase = await this.polymarketTradingOrchestrator.runPolymarketMarketOpen({
            ...phaseOptions,
            consensusPhase,
          });
          this.polymarketTradingState.lastExecution = executionPhase;
        }
        const result = {
          ok: true,
          phase: phaseKey,
          marketDate,
          scheduledAt,
          summary: {
            markets: Array.isArray(consensusPhase?.markets) ? consensusPhase.markets.length : 0,
            actionable: Array.isArray(consensusPhase?.approvedTrades) ? consensusPhase.approvedTrades.length : 0,
            executions: Array.isArray(executionPhase?.executions)
              ? executionPhase.executions.filter((entry) => entry.execution?.ok !== false).length
              : 0,
          },
        };
        this.polymarketTradingState.lastResult = result;
        this.persistPolymarketTradingState();
        return result;
      }

      if (phaseKey === 'polymarket_execute') {
        const consensusPhase = await this.polymarketTradingOrchestrator.runPolymarketConsensusRound(phaseOptions);
        const executionPhase = await this.polymarketTradingOrchestrator.runPolymarketMarketOpen({
          ...phaseOptions,
          consensusPhase,
        });
        const result = {
          ok: true,
          phase: phaseKey,
          marketDate,
          scheduledAt,
          summary: {
            executions: Array.isArray(executionPhase?.executions) ? executionPhase.executions.length : 0,
            filled: Array.isArray(executionPhase?.executions)
              ? executionPhase.executions.filter((entry) => entry.execution?.ok !== false).length
              : 0,
          },
        };
        this.polymarketTradingState.lastConsensus = consensusPhase;
        this.polymarketTradingState.lastExecution = executionPhase;
        this.polymarketTradingState.lastResult = result;
        this.persistPolymarketTradingState();
        return result;
      }

      if (phaseKey === 'polymarket_monitor') {
        const portfolioSnapshot = await this.polymarketTradingOrchestrator.getUnifiedPortfolioSnapshot({
          ...phaseOptions,
          includePolymarket: true,
        });
        const limits = tradingRiskEngine.DEFAULT_LIMITS;
        const killSwitch = tradingRiskEngine.checkKillSwitch(portfolioSnapshot, limits);
        const dailyPause = tradingRiskEngine.checkDailyPause(portfolioSnapshot, limits);
        const positions = await this.polymarketClient.getPositions();
        const exits = [];
        const executor = require('./modules/trading/executor');

        for (const position of Array.isArray(positions) ? positions : []) {
          const exitCheck = this.polymarketSizer.shouldExit(position, position.currentPrice, {
            now: scheduledAt,
          });
          if (!exitCheck.exit) continue;
          const order = await executor.submitOrder({
            ticker: position.market || position.tokenId,
            conditionId: position.market || position.tokenId,
            broker: 'polymarket',
            assetClass: 'prediction_market',
            direction: 'SELL',
            shares: position.size,
            tokenId: position.tokenId,
            price: position.currentPrice,
            referencePrice: position.currentPrice,
            notes: `polymarket-stop:${position.market || position.tokenId}`,
          }, {
            broker: 'polymarket',
          });
          exits.push({
            tokenId: position.tokenId,
            market: position.market,
            exitCheck,
            order,
          });
        }

        const result = {
          ok: true,
          phase: phaseKey,
          marketDate,
          scheduledAt,
          summary: {
            positions: Array.isArray(positions) ? positions.length : 0,
            exits: exits.length,
            killSwitch: Boolean(killSwitch?.triggered),
            dailyPause: Boolean(dailyPause?.paused),
          },
        };
        if (this.yieldRouterEnabled && this.yieldRouterOrchestrator && !this.yieldRouterPhasePromise) {
          result.yieldRebalance = await this.runYieldRebalancePhase({
            key: 'yield_rebalance',
            marketDate,
            scheduledAt: new Date().toISOString(),
            windowKey: event.windowKey || event.scheduledAt,
            triggerSource: phaseKey,
          });
        }
        this.polymarketTradingState.lastMonitor = {
          windowKey: event.windowKey || event.scheduledAt,
          marketDate,
          scheduledAt,
          exits,
          killSwitch,
          dailyPause,
          yieldRebalance: result.yieldRebalance || null,
        };
        this.polymarketTradingState.lastResult = result;
        this.persistPolymarketTradingState();
        return result;
      }

      return {
        ok: true,
        phase: phaseKey,
        marketDate,
        scheduledAt,
        summary: {},
      };
    } catch (err) {
      this.logger.warn(`Polymarket trading phase ${phaseKey} failed at ${scheduledAt}: ${err.message}`);
      const result = {
        ok: false,
        phase: phaseKey,
        marketDate,
        scheduledAt,
        error: err.message,
      };
      this.polymarketTradingState.lastResult = result;
      this.persistPolymarketTradingState();
      return result;
    }
  }

  async runLaunchRadarPhase(event) {
    const phaseKey = String(event?.key || '').trim();
    const scheduledAt = String(event?.scheduledAt || '').trim();
    const marketDate = String(event?.marketDate || new Date(scheduledAt || Date.now()).toISOString().slice(0, 10)).trim();
    if (!phaseKey || !scheduledAt || !this.launchRadarEnabled || !this.launchRadar || !this.launchRadarOrchestrator) {
      return { ok: false, phase: phaseKey || 'unknown', error: 'launch_radar_phase_unavailable' };
    }

    try {
      if (phaseKey !== 'launch_radar_scan') {
        return {
          ok: true,
          phase: phaseKey,
          marketDate,
          scheduledAt,
          summary: {},
        };
      }

      const portfolioSnapshot = await this.launchRadarOrchestrator.getUnifiedPortfolioSnapshot({
        date: marketDate || scheduledAt,
        includePolymarket: true,
      }).catch(() => null);
      const killSwitch = tradingRiskEngine.checkKillSwitch(portfolioSnapshot || {}, tradingRiskEngine.DEFAULT_LIMITS);
      const pollResult = await this.launchRadar.pollNow({ reason: phaseKey });
      const qualified = Array.isArray(pollResult?.qualified) ? pollResult.qualified : [];
      const rejected = Array.isArray(pollResult?.rejected) ? pollResult.rejected : [];
      const syncResult = killSwitch.triggered
        ? {
          ok: false,
          skipped: true,
          reason: 'kill_switch_triggered',
          qualifiedTokens: qualified,
          added: [],
          refreshed: [],
        }
        : await this.launchRadarOrchestrator.syncLaunchRadarWatchlist({
          reason: 'launch_radar_scan',
          date: marketDate || scheduledAt,
          launchRadar: this.launchRadar,
          launchRadarQualifiedTokens: qualified,
          launchRadarExpiryDays: 7,
          persistDynamicWatchlist: this.launchRadarDryRun ? false : undefined,
        });

      const result = {
        ok: pollResult?.ok !== false,
        phase: phaseKey,
        marketDate,
        scheduledAt,
        summary: {
          launches: Array.isArray(pollResult?.launches) ? pollResult.launches.length : 0,
          qualified: qualified.length,
          rejected: rejected.length,
          added: Array.isArray(syncResult?.added) ? syncResult.added.length : 0,
          refreshed: Array.isArray(syncResult?.refreshed) ? syncResult.refreshed.length : 0,
          killSwitch: Boolean(killSwitch.triggered),
          dryRun: this.launchRadarDryRun,
        },
      };
      this.launchRadarState.lastScan = {
        windowKey: event.windowKey || event.scheduledAt,
        marketDate,
        scheduledAt,
        dryRun: this.launchRadarDryRun,
        killSwitch,
        pollResult,
        syncResult,
      };
      this.launchRadarState.lastResult = result;
      this.persistLaunchRadarState();
      return result;
    } catch (err) {
      this.logger.warn(`Launch radar phase ${phaseKey} failed at ${scheduledAt}: ${err.message}`);
      const result = {
        ok: false,
        phase: phaseKey,
        marketDate,
        scheduledAt,
        error: err.message,
      };
      this.launchRadarState.lastResult = result;
      this.persistLaunchRadarState();
      return result;
    }
  }

  async runYieldRebalancePhase(event) {
    const phaseKey = String(event?.key || '').trim();
    const scheduledAt = String(event?.scheduledAt || '').trim();
    const marketDate = String(event?.marketDate || new Date(scheduledAt || Date.now()).toISOString().slice(0, 10)).trim();
    if (!phaseKey || !scheduledAt || !this.yieldRouterEnabled || !this.yieldRouter || !this.yieldRouterOrchestrator) {
      return { ok: false, phase: phaseKey || 'unknown', error: 'yield_router_phase_unavailable' };
    }

    try {
      if (phaseKey !== 'yield_rebalance') {
        return {
          ok: true,
          phase: phaseKey,
          marketDate,
          scheduledAt,
          summary: {},
        };
      }

      const portfolioSnapshot = await this.yieldRouterOrchestrator.getUnifiedPortfolioSnapshot({
        date: marketDate || scheduledAt,
        includePolymarket: true,
        yieldRouter: this.yieldRouter,
      });
      const allocation = this.yieldRouterOrchestrator.getCapitalAllocation(portfolioSnapshot, event.allocationOptions || {});
      const rebalanceResult = await this.yieldRouterOrchestrator.returnIdleCapital({
        date: marketDate || scheduledAt,
        portfolioSnapshot,
        yieldRouter: this.yieldRouter,
        dryRun: this.yieldRouterDryRun,
        killSwitchTriggered: portfolioSnapshot?.risk?.killSwitchTriggered === true,
        ...event.rebalanceOptions,
      });
      const result = {
        ok: rebalanceResult.ok !== false || rebalanceResult.skipped === true,
        phase: phaseKey,
        marketDate,
        scheduledAt,
        summary: {
          action: rebalanceResult.action || 'none',
          deposited: Number(rebalanceResult.deposit?.deposited || 0),
          withdrawn: Number(rebalanceResult.withdrawal?.withdrawn || 0),
          idleCapital: Number(allocation?.excess?.idleCapital || 0),
          yieldGap: Number(allocation?.gaps?.yield || 0),
          activeGap: Number(allocation?.gaps?.activeTrading || 0),
          killSwitch: Boolean(portfolioSnapshot?.risk?.killSwitchTriggered),
          dryRun: this.yieldRouterDryRun,
          triggerSource: event.triggerSource || null,
        },
      };
      this.yieldRouterState.lastProcessedAt = scheduledAt;
      this.yieldRouterState.lastRebalance = {
        windowKey: event.windowKey || event.scheduledAt,
        marketDate,
        scheduledAt,
        triggerSource: event.triggerSource || null,
        dryRun: this.yieldRouterDryRun,
        portfolioSnapshot,
        allocation,
        rebalanceResult,
      };
      this.yieldRouterState.lastResult = result;
      this.persistYieldRouterState();
      return result;
    } catch (err) {
      this.logger.warn(`Yield router phase ${phaseKey} failed at ${scheduledAt}: ${err.message}`);
      const result = {
        ok: false,
        phase: phaseKey,
        marketDate,
        scheduledAt,
        error: err.message,
      };
      this.yieldRouterState.lastProcessedAt = scheduledAt;
      this.yieldRouterState.lastResult = result;
      this.persistYieldRouterState();
      return result;
    }
  }

  async runCryptoConsensusPhase(event) {
    const phaseKey = String(event?.key || '').trim();
    const scheduledAt = String(event?.scheduledAt || '').trim();
    const cryptoSymbols = this.getCryptoSymbols();
    if (!phaseKey || !scheduledAt || !this.cryptoTradingOrchestrator) {
      return { ok: false, phase: phaseKey || 'unknown', error: 'crypto_phase_unavailable' };
    }
    if (cryptoSymbols.length === 0) {
      return { ok: false, skipped: true, reason: 'no_crypto_symbols', phase: phaseKey };
    }

    try {
      // Assess macro risk before any trading decisions
      let macroRisk;
      try {
        macroRisk = await macroRiskGate.assessMacroRisk();
        this.logger.info(`Macro risk: ${macroRisk.regime.toUpperCase()} (score: ${macroRisk.score}) — ${macroRisk.reason}`);
      } catch (macroErr) {
        this.logger.warn(`Macro risk gate failed: ${macroErr.message} — proceeding with defaults`);
        macroRisk = { regime: 'yellow', score: 50, constraints: { allowLongs: true, positionSizeMultiplier: 0.6, buyConfidenceMultiplier: 0.8, sellConfidenceMultiplier: 1.0 }, reason: 'macro gate error fallback' };
      }

      for (const ticker of cryptoSymbols) {
        this.cryptoTradingOrchestrator.clearSignals(ticker);
      }

      const preMarket = await this.cryptoTradingOrchestrator.runPreMarket({
        date: scheduledAt,
        symbols: cryptoSymbols,
        assetClass: 'crypto',
      });
      // Pass whale transfer data from scanner into consensus context
      const whaleTransfers = this.smartMoneyScanner?.state?.recentTransfers || [];
      const consensusPhase = await this.cryptoTradingOrchestrator.runConsensusRound({
        date: scheduledAt,
        symbols: cryptoSymbols,
        assetClass: 'crypto',
        limits: tradingRiskEngine.DEFAULT_CRYPTO_LIMITS,
        whaleTransfers: whaleTransfers.length > 0 ? whaleTransfers : undefined,
        macroRisk,
      });

      // Apply macro risk gate to approved trades
      let approved = Array.isArray(consensusPhase?.approvedTrades) ? consensusPhase.approvedTrades : [];
      if (macroRisk.regime === 'red') {
        const blocked = approved.filter((t) => t.consensus?.decision === 'BUY');
        if (blocked.length > 0) {
          this.logger.info(`Macro RED regime: blocking ${blocked.length} BUY trades (${blocked.map(t => t.ticker).join(', ')})`);
        }
        approved = approved.filter((t) => t.consensus?.decision !== 'BUY');
      }

      // Apply position size multiplier from macro gate
      if (macroRisk.constraints?.positionSizeMultiplier < 1) {
        for (const trade of approved) {
          if (trade.riskCheck?.maxShares) {
            trade.riskCheck.maxShares = Math.floor(trade.riskCheck.maxShares * macroRisk.constraints.positionSizeMultiplier * 1e6) / 1e6;
          }
        }
      }

      // Execute approved trades immediately — crypto markets are always open
      let executionResult = null;
      if (approved.length > 0) {
        this.logger.info(`Crypto consensus approved ${approved.length} trades — executing immediately`);
        executionResult = await this.cryptoTradingOrchestrator.runMarketOpen({
          date: scheduledAt,
          assetClass: 'crypto',
          consensusPhase,
          approvedTrades: approved,
        });
        const execCount = Array.isArray(executionResult?.executions) ? executionResult.executions.length : 0;
        const fills = (executionResult?.executions || []).filter((e) => e.execution?.ok);
        this.logger.info(`Crypto execution: ${fills.length}/${execCount} orders filled`);
      }

      return {
        ok: true,
        phase: phaseKey,
        marketDate: event.marketDate || '',
        scheduledAt,
        preMarket,
        macroRisk: { regime: macroRisk.regime, score: macroRisk.score, reason: macroRisk.reason },
        execution: executionResult,
        summary: {
          symbols: cryptoSymbols.length,
          approvedTrades: approved.length,
          rejectedTrades: Array.isArray(consensusPhase?.rejectedTrades) ? consensusPhase.rejectedTrades.length : 0,
          incompleteSignals: Array.isArray(consensusPhase?.incompleteSignals) ? consensusPhase.incompleteSignals.length : 0,
          executedTrades: executionResult ? (executionResult.executions || []).filter((e) => e.execution?.ok).length : 0,
        },
      };
    } catch (err) {
      this.logger.warn(`Crypto trading phase ${phaseKey} failed at ${scheduledAt}: ${err.message}`);
      return {
        ok: false,
        phase: phaseKey,
        marketDate: event.marketDate || '',
        scheduledAt,
        error: err.message,
      };
    }
  }

  async runTradingPhase(event, tradingDay) {
    const phaseKey = String(event?.key || '').trim();
    const marketDate = tradingDay?.marketDate || null;
    if (!phaseKey || !marketDate || !this.tradingOrchestrator) {
      return { ok: false, phase: phaseKey || 'unknown', error: 'trading_phase_unavailable' };
    }

    const startedAt = new Date().toISOString();
    this.recordTradingPhaseState(marketDate, phaseKey, {
      status: 'running',
      startedAt,
      scheduledAt: event.scheduledAt,
    });

    try {
      let result = null;
      if (phaseKey === 'premarket_wake') {
        this.tradingState.sleeping = false;
        this.notifyTradingAgents(phaseKey, tradingDay);
        result = await this.tradingOrchestrator.runPreMarket({ date: marketDate });
        this.notifyTelegramTrading(`[TRADING] Pre-market wake for ${marketDate}. Watching ${Array.isArray(result?.symbols) ? result.symbols.length : '?'} stocks. Consensus at 6:25 AM PT, market open at 6:30 AM PT.`);
      } else if (phaseKey === 'pre_open_consensus') {
        result = await this.tradingOrchestrator.runConsensusRound({ date: marketDate });
        const approved = Array.isArray(result?.approvedTrades) ? result.approvedTrades.length : 0;
        const rejected = Array.isArray(result?.rejectedTrades) ? result.rejectedTrades.length : 0;
        const tradeList = approved > 0
          ? result.approvedTrades.map((t) => `${t.consensus?.decision} ${t.ticker}`).join(', ')
          : 'none';
        this.notifyTelegramTrading(`[TRADING] Consensus for ${marketDate}: ${approved} approved, ${rejected} rejected. Trades: ${tradeList}.`);
      } else if (phaseKey === 'market_open_execute') {
        result = await this.tradingOrchestrator.runMarketOpen({ date: marketDate });
        const execCount = Array.isArray(result?.executions) ? result.executions.length : 0;
        if (execCount > 0) {
          const execList = result.executions.map((e) => `${e.consensus?.decision} ${e.ticker}`).join(', ');
          this.notifyTelegramTrading(`[TRADING] Market open: ${execCount} orders executed — ${execList}.`);
        }
      } else if (phaseKey === 'close_wake') {
        this.tradingState.sleeping = false;
        this.notifyTradingAgents(phaseKey, tradingDay);
        result = await this.tradingOrchestrator.runMidDayCheck({ date: marketDate });
      } else if (phaseKey === 'market_close_review') {
        result = await this.tradingOrchestrator.runMarketClose({ date: marketDate });
        if (this.yieldRouterEnabled && this.yieldRouterOrchestrator && !this.yieldRouterPhasePromise) {
          result.yieldRebalance = await this.runYieldRebalancePhase({
            key: 'yield_rebalance',
            marketDate,
            scheduledAt: new Date().toISOString(),
            windowKey: event.windowKey || event.scheduledAt,
            triggerSource: phaseKey,
          });
        }
      } else if (phaseKey === 'end_of_day') {
        result = await this.tradingOrchestrator.runEndOfDay({ date: marketDate });
        this.tradingState.sleeping = true;
        this.notifyTradingAgents(phaseKey, tradingDay);
      } else {
        result = { phase: phaseKey, marketDate };
      }

      const summary = this.summarizeTradingPhaseResult(phaseKey, result);
      this.recordTradingPhaseState(marketDate, phaseKey, {
        status: 'completed',
        finishedAt: new Date().toISOString(),
        scheduledAt: event.scheduledAt,
        summary,
      });
      this.logger.info(`Trading phase ${phaseKey} completed for ${marketDate}`);
      return {
        ok: true,
        phase: phaseKey,
        marketDate,
        summary,
      };
    } catch (err) {
      this.recordTradingPhaseState(marketDate, phaseKey, {
        status: 'failed',
        finishedAt: new Date().toISOString(),
        scheduledAt: event.scheduledAt,
        error: err.message,
      });
      this.logger.warn(`Trading phase ${phaseKey} failed for ${marketDate}: ${err.message}`);
      return {
        ok: false,
        phase: phaseKey,
        marketDate,
        error: err.message,
      };
    }
  }

  async maybeRunTradingAutomation(nowMs = Date.now()) {
    if (!this.tradingEnabled || this.stopping || !this.tradingOrchestrator) {
      return { ok: false, skipped: true, reason: 'trading_disabled' };
    }
    if (this.tradingPhasePromise) {
      return this.tradingPhasePromise;
    }

    const now = nowMs instanceof Date ? nowMs : new Date(nowMs);
    const tradingDay = await this.getTradingDaySchedule(now).catch((err) => {
      this.logger.warn(`Trading schedule lookup failed: ${err.message}`);
      return null;
    });
    const nextEvent = await this.getNextTradingEvent(now).catch((err) => {
      this.logger.warn(`Next trading event lookup failed: ${err.message}`);
      return null;
    });

    if (!tradingDay) {
      this.tradingState.nextEvent = this.describeTradingEvent(nextEvent);
      this.tradingState.sleeping = true;
      this.persistTradingState();
      this.lastTradingSummary = {
        enabled: true,
        status: 'idle',
        reason: 'not_trading_day',
        marketDate: null,
        sleeping: true,
        nextEvent: this.describeTradingEvent(nextEvent),
      };
      return { ok: false, skipped: true, reason: 'not_trading_day', nextEvent: this.describeTradingEvent(nextEvent) };
    }

    this.resetTradingStateForMarketDate(tradingDay.marketDate);
    const dueEvents = tradingDay.schedule.filter((event) => {
      return new Date(event.scheduledAt).getTime() <= now.getTime()
        && !this.isTradingPhaseComplete(tradingDay.marketDate, event.key);
    });

    this.tradingState.nextEvent = this.describeTradingEvent(
      tradingDay.schedule.find((event) => new Date(event.scheduledAt).getTime() > now.getTime())
      || nextEvent
    );
    this.persistTradingState();

    if (dueEvents.length === 0) {
      this.lastTradingSummary = {
        enabled: true,
        status: 'scheduled',
        marketDate: tradingDay.marketDate,
        sleeping: this.tradingState.sleeping !== false,
        nextEvent: this.tradingState.nextEvent,
      };
      return {
        ok: false,
        skipped: true,
        reason: 'no_due_trading_phase',
        marketDate: tradingDay.marketDate,
        nextEvent: this.tradingState.nextEvent,
      };
    }

    this.tradingPhasePromise = (async () => {
      const executed = [];
      for (const event of dueEvents) {
        const phaseResult = await this.runTradingPhase(event, tradingDay);
        executed.push(phaseResult);
        if (!phaseResult.ok) break;
      }

      const upcomingEvent = tradingDay.schedule.find((event) => {
        return new Date(event.scheduledAt).getTime() > Date.now()
          && !this.isTradingPhaseComplete(tradingDay.marketDate, event.key);
      }) || nextEvent;
      this.tradingState.nextEvent = this.describeTradingEvent(upcomingEvent);
      this.persistTradingState();
      this.lastTradingSummary = {
        enabled: true,
        status: executed.every((entry) => entry.ok) ? 'phase_completed' : 'phase_failed',
        marketDate: tradingDay.marketDate,
        executedPhases: executed.map((entry) => entry.phase),
        sleeping: this.tradingState.sleeping !== false,
        nextEvent: this.tradingState.nextEvent,
        lastResult: executed[executed.length - 1] || null,
      };

      return {
        ok: executed.every((entry) => entry.ok),
        skipped: false,
        marketDate: tradingDay.marketDate,
        executed,
        nextEvent: this.tradingState.nextEvent,
      };
    })().finally(() => {
      this.tradingPhasePromise = null;
    });

    return this.tradingPhasePromise;
  }

  async maybeRunCryptoTradingAutomation(nowMs = Date.now()) {
    if (!this.cryptoTradingEnabled || this.stopping || !this.cryptoTradingOrchestrator) {
      return { ok: false, skipped: true, reason: 'crypto_trading_disabled' };
    }
    if (this.cryptoTradingPhasePromise) {
      return this.cryptoTradingPhasePromise;
    }

    const cryptoSymbols = this.getCryptoSymbols();
    const now = nowMs instanceof Date ? nowMs : new Date(nowMs);
    const nextEvent = await tradingScheduler.getNextCryptoWakeEvent(now, {
      projectRoot: this.projectRoot,
    }).catch((err) => {
      this.logger.warn(`Next crypto event lookup failed: ${err.message}`);
      return null;
    });

    if (cryptoSymbols.length === 0) {
      this.cryptoTradingState.nextEvent = this.describeTradingEvent(nextEvent);
      this.persistCryptoTradingState();
      this.lastCryptoTradingSummary = {
        enabled: true,
        status: 'idle',
        reason: 'no_crypto_symbols',
        lastProcessedAt: this.cryptoTradingState.lastProcessedAt || null,
        nextEvent: this.cryptoTradingState.nextEvent,
      };
      return { ok: false, skipped: true, reason: 'no_crypto_symbols', nextEvent: this.cryptoTradingState.nextEvent };
    }

    const cryptoDay = tradingScheduler.buildCryptoDailySchedule(now, {
      projectRoot: this.projectRoot,
    });
    const lastProcessedAtMs = this.cryptoTradingState.lastProcessedAt
      ? new Date(this.cryptoTradingState.lastProcessedAt).getTime()
      : 0;
    const dueEvents = cryptoDay.schedule.filter((event) => {
      const scheduledAtMs = new Date(event.scheduledAt).getTime();
      return scheduledAtMs <= now.getTime() && scheduledAtMs > lastProcessedAtMs;
    });

    this.cryptoTradingState.nextEvent = this.describeTradingEvent(nextEvent);
    this.persistCryptoTradingState();

    if (dueEvents.length === 0) {
      this.lastCryptoTradingSummary = {
        enabled: true,
        status: 'scheduled',
        lastProcessedAt: this.cryptoTradingState.lastProcessedAt || null,
        nextEvent: this.cryptoTradingState.nextEvent,
      };
      return {
        ok: false,
        skipped: true,
        reason: 'no_due_crypto_phase',
        nextEvent: this.cryptoTradingState.nextEvent,
      };
    }

    this.cryptoTradingPhasePromise = (async () => {
      const executed = [];
      for (const event of dueEvents) {
        const phaseResult = await this.runCryptoConsensusPhase(event);
        executed.push(phaseResult);
        this.cryptoTradingState.lastProcessedAt = event.scheduledAt;
        this.cryptoTradingState.lastResult = phaseResult;
        this.persistCryptoTradingState();
        if (!phaseResult.ok) break;
      }

      const upcomingEvent = await tradingScheduler.getNextCryptoWakeEvent(new Date(), {
        projectRoot: this.projectRoot,
      }).catch(() => null);
      this.cryptoTradingState.nextEvent = this.describeTradingEvent(upcomingEvent);
      this.persistCryptoTradingState();
      this.lastCryptoTradingSummary = {
        enabled: true,
        status: executed.every((entry) => entry.ok) ? 'phase_completed' : 'phase_failed',
        lastProcessedAt: this.cryptoTradingState.lastProcessedAt || null,
        nextEvent: this.cryptoTradingState.nextEvent,
        lastResult: executed[executed.length - 1] || null,
      };

      return {
        ok: executed.every((entry) => entry.ok),
        skipped: false,
        executed,
        nextEvent: this.cryptoTradingState.nextEvent,
      };
    })().finally(() => {
      this.cryptoTradingPhasePromise = null;
    });

    return this.cryptoTradingPhasePromise;
  }

  async maybeRunPolymarketTradingAutomation(nowMs = Date.now()) {
    if (!this.polymarketTradingEnabled || this.stopping) {
      return { ok: false, skipped: true, reason: 'polymarket_trading_disabled' };
    }
    if (this.polymarketTradingPhasePromise) {
      return this.polymarketTradingPhasePromise;
    }

    const now = nowMs instanceof Date ? nowMs : new Date(nowMs);
    const nextEvent = await tradingScheduler.getNextPolymarketWakeEvent(now, {
      projectRoot: this.projectRoot,
      phases: POLYMARKET_SCHEDULE_PHASES,
    }).catch((err) => {
      this.logger.warn(`Next Polymarket event lookup failed: ${err.message}`);
      return null;
    });

    const polymarketDay = tradingScheduler.buildPolymarketDailySchedule(now, {
      projectRoot: this.projectRoot,
      phases: POLYMARKET_SCHEDULE_PHASES,
    });
    const lastProcessedAtMs = this.polymarketTradingState.lastProcessedAt
      ? new Date(this.polymarketTradingState.lastProcessedAt).getTime()
      : 0;
    const dueEvents = polymarketDay.schedule.filter((event) => {
      const scheduledAtMs = new Date(event.scheduledAt).getTime();
      return scheduledAtMs <= now.getTime() && scheduledAtMs > lastProcessedAtMs;
    });

    this.polymarketTradingState.nextEvent = this.describeTradingEvent(nextEvent);
    this.persistPolymarketTradingState();

    if (dueEvents.length === 0) {
      this.lastPolymarketTradingSummary = {
        enabled: true,
        status: 'scheduled',
        lastProcessedAt: this.polymarketTradingState.lastProcessedAt || null,
        nextEvent: this.polymarketTradingState.nextEvent,
      };
      return {
        ok: false,
        skipped: true,
        reason: 'no_due_polymarket_phase',
        nextEvent: this.polymarketTradingState.nextEvent,
      };
    }

    this.polymarketTradingPhasePromise = (async () => {
      const executed = [];
      for (const event of dueEvents) {
        const phaseResult = await this.runPolymarketPhase(event);
        executed.push(phaseResult);
        this.polymarketTradingState.lastProcessedAt = event.scheduledAt;
        this.polymarketTradingState.lastResult = phaseResult;
        this.persistPolymarketTradingState();
        if (!phaseResult.ok) break;
      }

      const upcomingEvent = await tradingScheduler.getNextPolymarketWakeEvent(new Date(), {
        projectRoot: this.projectRoot,
      }).catch(() => null);
      this.polymarketTradingState.nextEvent = this.describeTradingEvent(upcomingEvent);
      this.persistPolymarketTradingState();
      this.lastPolymarketTradingSummary = {
        enabled: true,
        status: executed.every((entry) => entry.ok) ? 'phase_completed' : 'phase_failed',
        lastProcessedAt: this.polymarketTradingState.lastProcessedAt || null,
        nextEvent: this.polymarketTradingState.nextEvent,
        lastResult: executed[executed.length - 1] || null,
      };

      return {
        ok: executed.every((entry) => entry.ok),
        skipped: false,
        executed,
        nextEvent: this.polymarketTradingState.nextEvent,
      };
    })().finally(() => {
      this.polymarketTradingPhasePromise = null;
    });

    return this.polymarketTradingPhasePromise;
  }

  async maybeRunLaunchRadarAutomation(nowMs = Date.now()) {
    if (!this.launchRadarEnabled || this.stopping || !this.launchRadar || !this.launchRadarOrchestrator) {
      return { ok: false, skipped: true, reason: 'launch_radar_disabled' };
    }
    if (this.launchRadarPhasePromise) {
      return this.launchRadarPhasePromise;
    }

    const now = nowMs instanceof Date ? nowMs : new Date(nowMs);
    const nextEvent = getNextLaunchRadarEvent(now, {
      intervalMinutes: DEFAULT_LAUNCH_RADAR_INTERVAL_MINUTES,
    });
    const launchRadarDay = buildLaunchRadarDailySchedule(now, {
      intervalMinutes: DEFAULT_LAUNCH_RADAR_INTERVAL_MINUTES,
    });
    const lastProcessedAtMs = this.launchRadarState.lastProcessedAt
      ? new Date(this.launchRadarState.lastProcessedAt).getTime()
      : 0;
    const dueEvents = launchRadarDay.schedule.filter((event) => {
      const scheduledAtMs = new Date(event.scheduledAt).getTime();
      return scheduledAtMs <= now.getTime() && scheduledAtMs > lastProcessedAtMs;
    });

    this.launchRadarState.nextEvent = this.describeTradingEvent(nextEvent);
    this.persistLaunchRadarState();

    if (dueEvents.length === 0) {
      this.lastLaunchRadarSummary = {
        enabled: true,
        status: 'scheduled',
        dryRun: this.launchRadarDryRun,
        lastProcessedAt: this.launchRadarState.lastProcessedAt || null,
        nextEvent: this.launchRadarState.nextEvent,
      };
      return {
        ok: false,
        skipped: true,
        reason: 'no_due_launch_radar_phase',
        nextEvent: this.launchRadarState.nextEvent,
      };
    }

    this.launchRadarPhasePromise = (async () => {
      const executed = [];
      for (const event of dueEvents) {
        const phaseResult = await this.runLaunchRadarPhase(event);
        executed.push(phaseResult);
        this.launchRadarState.lastProcessedAt = event.scheduledAt;
        this.launchRadarState.lastResult = phaseResult;
        this.persistLaunchRadarState();
        if (!phaseResult.ok) break;
      }

      const upcomingEvent = getNextLaunchRadarEvent(new Date(), {
        intervalMinutes: DEFAULT_LAUNCH_RADAR_INTERVAL_MINUTES,
      });
      this.launchRadarState.nextEvent = this.describeTradingEvent(upcomingEvent);
      this.persistLaunchRadarState();
      this.lastLaunchRadarSummary = {
        enabled: true,
        status: executed.every((entry) => entry.ok) ? 'phase_completed' : 'phase_failed',
        dryRun: this.launchRadarDryRun,
        lastProcessedAt: this.launchRadarState.lastProcessedAt || null,
        nextEvent: this.launchRadarState.nextEvent,
        lastResult: executed[executed.length - 1] || null,
      };

      return {
        ok: executed.every((entry) => entry.ok),
        skipped: false,
        executed,
        nextEvent: this.launchRadarState.nextEvent,
      };
    })().finally(() => {
      this.launchRadarPhasePromise = null;
    });

    return this.launchRadarPhasePromise;
  }

  async maybeRunYieldRouterAutomation(nowMs = Date.now()) {
    if (!this.yieldRouterEnabled || this.stopping || !this.yieldRouter || !this.yieldRouterOrchestrator) {
      return { ok: false, skipped: true, reason: 'yield_router_disabled' };
    }
    if (this.yieldRouterPhasePromise) {
      return this.yieldRouterPhasePromise;
    }

    const now = nowMs instanceof Date ? nowMs : new Date(nowMs);
    const nextEvent = getNextYieldRouterEvent(now, {
      intervalMinutes: DEFAULT_YIELD_ROUTER_INTERVAL_MINUTES,
    });
    const yieldRouterDay = buildYieldRouterDailySchedule(now, {
      intervalMinutes: DEFAULT_YIELD_ROUTER_INTERVAL_MINUTES,
    });
    const lastProcessedAtMs = this.yieldRouterState.lastProcessedAt
      ? new Date(this.yieldRouterState.lastProcessedAt).getTime()
      : 0;
    const dueEvents = yieldRouterDay.schedule.filter((event) => {
      const scheduledAtMs = new Date(event.scheduledAt).getTime();
      return scheduledAtMs <= now.getTime() && scheduledAtMs > lastProcessedAtMs;
    });

    this.yieldRouterState.nextEvent = this.describeTradingEvent(nextEvent);
    this.persistYieldRouterState();

    if (dueEvents.length === 0) {
      this.lastYieldRouterSummary = {
        enabled: true,
        status: 'scheduled',
        dryRun: this.yieldRouterDryRun,
        lastProcessedAt: this.yieldRouterState.lastProcessedAt || null,
        nextEvent: this.yieldRouterState.nextEvent,
      };
      return {
        ok: false,
        skipped: true,
        reason: 'no_due_yield_router_phase',
        nextEvent: this.yieldRouterState.nextEvent,
      };
    }

    this.yieldRouterPhasePromise = (async () => {
      const executed = [];
      for (const event of dueEvents) {
        const phaseResult = await this.runYieldRebalancePhase(event);
        executed.push(phaseResult);
        this.yieldRouterState.lastResult = phaseResult;
        this.persistYieldRouterState();
        if (!phaseResult.ok) break;
      }

      const upcomingEvent = getNextYieldRouterEvent(new Date(), {
        intervalMinutes: DEFAULT_YIELD_ROUTER_INTERVAL_MINUTES,
      });
      this.yieldRouterState.nextEvent = this.describeTradingEvent(upcomingEvent);
      this.persistYieldRouterState();
      this.lastYieldRouterSummary = {
        enabled: true,
        status: executed.every((entry) => entry.ok) ? 'phase_completed' : 'phase_failed',
        dryRun: this.yieldRouterDryRun,
        lastProcessedAt: this.yieldRouterState.lastProcessedAt || null,
        nextEvent: this.yieldRouterState.nextEvent,
        lastResult: executed[executed.length - 1] || null,
      };

      return {
        ok: executed.every((entry) => entry.ok),
        skipped: false,
        executed,
        nextEvent: this.yieldRouterState.nextEvent,
      };
    })().finally(() => {
      this.yieldRouterPhasePromise = null;
    });

    return this.yieldRouterPhasePromise;
  }

  runMemoryLeaseHousekeeping(nowMs = Date.now(), phase = 'tick') {
    if (!this.leaseJanitor || typeof this.leaseJanitor.pruneExpiredLeases !== 'function') {
      return { ok: false, skipped: true, reason: 'lease_janitor_unavailable' };
    }
    try {
      const pruneResult = this.leaseJanitor.pruneExpiredLeases(nowMs);
      if (Number(pruneResult?.pruned || 0) > 0) {
        this.logger.warn(`Pruned ${pruneResult.pruned} expired memory lease(s) during ${phase}`);
      }
      return pruneResult;
    } catch (err) {
      this.logger.warn(`Memory lease janitor failed during ${phase}: ${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  buildMemoryConsistencySummary(result = null) {
    const source = result && typeof result === 'object' && !Array.isArray(result)
      ? result
      : {};
    const summary = source.summary && typeof source.summary === 'object' && !Array.isArray(source.summary)
      ? source.summary
      : {};
    return {
      enabled: this.memoryConsistencyEnabled,
      checkedAt: typeof source.checkedAt === 'string' ? source.checkedAt : null,
      status: typeof source.status === 'string' && source.status.trim() ? source.status.trim() : 'unknown',
      synced: source.synced === true,
      error: typeof source.error === 'string' && source.error.trim() ? source.error.trim() : null,
      summary: {
        knowledgeEntryCount: Number(summary.knowledgeEntryCount || 0),
        knowledgeNodeCount: Number(summary.knowledgeNodeCount || 0),
        missingInCognitiveCount: Number(summary.missingInCognitiveCount || 0),
        orphanedNodeCount: Number(summary.orphanedNodeCount || 0),
        duplicateKnowledgeHashCount: Number(summary.duplicateKnowledgeHashCount || 0),
        issueCount: Number(summary.issueCount || 0),
      },
    };
  }

  runMemoryConsistencyAudit(reason = 'periodic', nowMs = Date.now()) {
    if (!this.memoryConsistencyEnabled) {
      return { ok: false, skipped: true, reason: 'memory_consistency_disabled' };
    }

    try {
      const result = runMemoryConsistencyCheck({
        projectRoot: this.projectRoot,
        sampleLimit: 5,
      });
      this.lastMemoryConsistencySummary = this.buildMemoryConsistencySummary(result);
      this.lastMemoryConsistencyCheckAtMs = nowMs;
      const counts = this.lastMemoryConsistencySummary.summary;
      const message = `Memory consistency (${reason}): status=${this.lastMemoryConsistencySummary.status}`
        + ` entries=${counts.knowledgeEntryCount}`
        + ` nodes=${counts.knowledgeNodeCount}`
        + ` missing=${counts.missingInCognitiveCount}`
        + ` orphans=${counts.orphanedNodeCount}`
        + ` duplicates=${counts.duplicateKnowledgeHashCount}`;
      if (this.lastMemoryConsistencySummary.synced) {
        this.logger.info(message);
      } else {
        this.logger.warn(message);
      }
      return this.lastMemoryConsistencySummary;
    } catch (err) {
      this.lastMemoryConsistencySummary = this.buildMemoryConsistencySummary({
        checkedAt: new Date(nowMs).toISOString(),
        status: 'check_failed',
        synced: false,
        error: err.message,
        summary: {},
      });
      this.lastMemoryConsistencyCheckAtMs = nowMs;
      this.logger.warn(`Memory consistency (${reason}) failed: ${err.message}`);
      return this.lastMemoryConsistencySummary;
    }
  }

  maybeRunMemoryConsistencyAudit(nowMs = Date.now(), reason = 'periodic') {
    if (!this.memoryConsistencyEnabled) {
      return { ok: false, skipped: true, reason: 'memory_consistency_disabled' };
    }
    if (this.lastMemoryConsistencyCheckAtMs > 0 && (nowMs - this.lastMemoryConsistencyCheckAtMs) < this.memoryConsistencyPollMs) {
      return {
        ok: false,
        skipped: true,
        reason: 'memory_consistency_poll_interval',
        checkedAt: this.lastMemoryConsistencySummary?.checkedAt || null,
      };
    }
    return this.runMemoryConsistencyAudit(reason, nowMs);
  }

  async launchTask(task, options = {}) {
    const leaseOwner = String(options.leaseOwner || `${this.workerLeaseOwnerPrefix}-${process.pid}`);
    const execution = this.buildExecutionSpec(task);
    if (!execution.ok) {
      this.store.failTask(task.taskId, {
        leaseOwner,
        errorPayload: {
          message: execution.reason,
          taskId: task.taskId,
        },
      });
      this.logger.warn(`Task ${task.taskId} failed validation: ${execution.reason}`);
      return;
    }

    const taskLogPath = path.join(this.taskLogDir, `${task.taskId}.log`);
    ensureDir(taskLogPath);
    appendFileSafe(taskLogPath, `\n[${new Date().toISOString()}] starting task ${task.taskId}: ${task.objective}\n`);

    let child;
    try {
      child = spawn(execution.command, execution.args, {
        cwd: execution.cwd,
        env: execution.env,
        shell: execution.shell,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      this.store.failTask(task.taskId, {
        leaseOwner,
        errorPayload: {
          message: err.message,
          stage: 'spawn',
        },
      });
      this.logger.error(`Task ${task.taskId} failed to spawn: ${err.message}`);
      return;
    }

    const worker = {
      taskId: task.taskId,
      task,
      leaseOwner,
      child,
      taskLogPath,
      startedAtMs: Date.now(),
      timeoutMs: execution.timeoutMs,
      stdoutTail: '',
      stderrTail: '',
      timeoutHandle: null,
      heartbeatHandle: null,
      settled: false,
    };
    this.activeWorkers.set(task.taskId, worker);
    this.store.attachWorkerPid(task.taskId, child.pid, { leaseOwner, nowMs: Date.now() });
    this.logger.info(`Task ${task.taskId} claimed and started as pid ${child.pid}`);
    this.requestTick(`worker-start:${task.taskId}`);

    worker.heartbeatHandle = setInterval(() => {
      const heartbeat = this.store.heartbeatTask(task.taskId, {
        leaseOwner,
        leaseMs: this.leaseMs,
        nowMs: Date.now(),
      });
      if (!heartbeat.ok) {
        this.logger.warn(`Heartbeat failed for ${task.taskId}: ${heartbeat.reason || heartbeat.error || 'unknown'}`);
      }
    }, this.heartbeatMs);
    if (typeof worker.heartbeatHandle.unref === 'function') {
      worker.heartbeatHandle.unref();
    }

    if (Number.isFinite(worker.timeoutMs) && worker.timeoutMs > 0) {
      worker.timeoutHandle = setTimeout(() => {
        if (worker.settled) return;
        appendFileSafe(taskLogPath, `[${new Date().toISOString()}] timeout after ${worker.timeoutMs}ms\n`);
        try { child.kill(); } catch {}
      }, worker.timeoutMs);
      if (typeof worker.timeoutHandle.unref === 'function') {
        worker.timeoutHandle.unref();
      }
    }

    child.stdout.on('data', (chunk) => {
      const text = String(chunk || '');
      worker.stdoutTail = trimTail(worker.stdoutTail + text);
      appendFileSafe(taskLogPath, text);
    });

    child.stderr.on('data', (chunk) => {
      const text = String(chunk || '');
      worker.stderrTail = trimTail(worker.stderrTail + text);
      appendFileSafe(taskLogPath, text);
    });

    child.on('error', (err) => {
      this.settleWorker(worker, {
        ok: false,
        errorPayload: {
          message: err.message,
          stage: 'runtime',
          stdoutTail: worker.stdoutTail,
          stderrTail: worker.stderrTail,
        },
      }).catch((settleErr) => {
        this.logger.error(`Failed to settle errored task ${task.taskId}: ${settleErr.message}`);
      });
    });

    child.on('exit', (code, signal) => {
      const elapsedMs = Date.now() - worker.startedAtMs;
      const payload = {
        pid: child.pid,
        exitCode: code,
        signal: signal || null,
        elapsedMs,
        stdoutTail: worker.stdoutTail,
        stderrTail: worker.stderrTail,
        logPath: taskLogPath,
      };
      const success = code === 0 && !signal;
      this.settleWorker(worker, success
        ? { ok: true, resultPayload: payload }
        : { ok: false, errorPayload: payload }
      ).catch((settleErr) => {
        this.logger.error(`Failed to settle exited task ${task.taskId}: ${settleErr.message}`);
      });
    });
  }

  buildExecutionSpec(task) {
    const snapshot = task && task.contextSnapshot && typeof task.contextSnapshot === 'object'
      ? task.contextSnapshot
      : {};

    const kind = String(snapshot.kind || 'shell').trim().toLowerCase();
    const cwd = snapshot.cwd ? path.resolve(String(snapshot.cwd)) : process.cwd();
    const timeoutMs = Number.parseInt(snapshot.timeoutMs || snapshot.timeout_ms || '0', 10) || 0;
    const env = {
      ...process.env,
      SQUIDRUN_SUPERVISOR_TASK_ID: task.taskId,
    };

    if (snapshot.env && typeof snapshot.env === 'object') {
      for (const [key, value] of Object.entries(snapshot.env)) {
        if (value === undefined || value === null) continue;
        env[String(key)] = String(value);
      }
    }

    if (kind === 'shell') {
      if (typeof snapshot.command === 'string' && snapshot.command.trim()) {
        return {
          ok: true,
          command: snapshot.command.trim(),
          args: Array.isArray(snapshot.args) ? snapshot.args.map((value) => String(value)) : [],
          cwd,
          env,
          shell: Boolean(snapshot.shell),
          timeoutMs,
        };
      }

      if (typeof snapshot.shellCommand === 'string' && snapshot.shellCommand.trim()) {
        return {
          ok: true,
          command: snapshot.shellCommand.trim(),
          args: [],
          cwd,
          env,
          shell: true,
          timeoutMs,
        };
      }
    }

    return {
      ok: false,
      reason: `unsupported_task_context:${kind}`,
    };
  }

  getMemoryIndexWatchTargets() {
    const paths = resolveWorkspacePaths();
    const targets = [];

    if (fs.existsSync(paths.knowledgeDir)) {
      targets.push(path.join(paths.knowledgeDir, '**', '*.md'));
    }
    if (fs.existsSync(path.dirname(paths.handoffPath))) {
      targets.push(paths.handoffPath);
    }

    return Array.from(new Set(targets));
  }

  scheduleMemoryIndexRefresh(reason = 'manual') {
    if (!this.memoryIndexEnabled || this.stopping) return;
    this.pendingMemoryIndexReason = String(reason || 'manual');
    if (this.memoryIndexDebounceTimer) clearTimeout(this.memoryIndexDebounceTimer);
    this.memoryIndexDebounceTimer = setTimeout(() => {
      const nextReason = this.pendingMemoryIndexReason || 'manual';
      this.pendingMemoryIndexReason = null;
      this.runMemoryIndexRefresh(nextReason).catch((err) => {
        this.logger.warn(`Memory index refresh failed: ${err.message}`);
      });
    }, this.memoryIndexDebounceMs);
    this.requestTick(`memory-index:${this.pendingMemoryIndexReason}`);
    if (typeof this.memoryIndexDebounceTimer.unref === 'function') {
      this.memoryIndexDebounceTimer.unref();
    }
  }

  async runMemoryIndexRefresh(reason = 'manual') {
    if (!this.memoryIndexEnabled || this.stopping || !this.memorySearchIndex) {
      return { ok: false, skipped: true, reason: 'memory_index_disabled' };
    }
    if (this.memoryIndexRefreshPromise) {
      this.pendingMemoryIndexReason = String(reason || 'manual');
      return this.memoryIndexRefreshPromise;
    }

    this.memoryIndexRefreshPromise = this.memorySearchIndex.indexAll()
      .then((result) => {
        this.logger.info(
          `Memory index refresh (${reason}) complete: `
          + `groups=${result.indexedGroups} skipped=${result.skippedGroups} `
          + `docs=${result.status.document_count}`
        );
        return result;
      })
      .catch((err) => {
        this.logger.warn(`Memory index refresh (${reason}) failed: ${err.message}`);
        throw err;
      })
      .finally(() => {
        this.memoryIndexRefreshPromise = null;
        if (!this.stopping && this.pendingMemoryIndexReason) {
          const followUpReason = this.pendingMemoryIndexReason;
          this.pendingMemoryIndexReason = null;
          this.scheduleMemoryIndexRefresh(followUpReason);
        }
      });

    return this.memoryIndexRefreshPromise;
  }

  startMemoryIndexWatcher() {
    if (!this.memoryIndexEnabled || this.memoryIndexWatcher) return;
    const targets = this.getMemoryIndexWatchTargets();
    if (targets.length === 0) {
      this.logger.info('Memory index watcher skipped: no targets found');
      return;
    }

    this.memoryIndexWatcher = chokidar.watch(targets, {
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 500,
        pollInterval: 100,
      },
    });

    this.memoryIndexWatcher.on('all', (eventName, changedPath) => {
      const relPath = String(changedPath || '');
      this.logger.info(`Memory index watcher event ${eventName}: ${relPath}`);
      this.scheduleMemoryIndexRefresh(`${eventName}:${path.basename(relPath)}`);
    });

    this.scheduleMemoryIndexRefresh('startup');
  }

  startWakeSignalWatcher() {
    if (this.wakeSignalWatcher) return;
    ensureDir(this.wakeSignalPath);
    this.wakeSignalWatcher = chokidar.watch(this.wakeSignalPath, {
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 50,
      },
    });

    this.wakeSignalWatcher.on('all', (eventName) => {
      this.requestTick(`wake-signal:${eventName}`);
    });
  }

  async stopMemoryIndexWatcher() {
    if (this.memoryIndexDebounceTimer) clearTimeout(this.memoryIndexDebounceTimer);
    this.memoryIndexDebounceTimer = null;

    if (this.memoryIndexWatcher) {
      try {
        await this.memoryIndexWatcher.close();
      } catch {}
      this.memoryIndexWatcher = null;
    }

    if (this.memorySearchIndex) {
      try {
        this.memorySearchIndex.close();
      } catch {}
    }
  }

  async stopWakeSignalWatcher() {
    if (this.wakeSignalWatcher) {
      try {
        await this.wakeSignalWatcher.close();
      } catch {}
      this.wakeSignalWatcher = null;
    }
  }

  runQueueHousekeeping(nowMs = Date.now(), phase = 'tick') {
    const requeueResult = this.store.requeueExpiredTasks({ nowMs });
    if (!requeueResult.ok) {
      this.logger.warn(`Expired-task requeue failed during ${phase}: ${requeueResult.error || requeueResult.reason || 'unknown'}`);
    } else {
      this.cleanupRequeuedWorkers(requeueResult, 'lease_expired_requeue');
    }

    let pruneResult = { ok: true, pruned: 0, taskIds: [], tasks: [], skipped: true, reason: 'ttl_disabled' };
    if (this.pendingTaskTtlMs > 0 && typeof this.store.pruneExpiredPendingTasks === 'function') {
      pruneResult = this.store.pruneExpiredPendingTasks({
        nowMs,
        maxAgeMs: this.pendingTaskTtlMs,
      });
      if (!pruneResult.ok) {
        this.logger.warn(`Pending-task TTL prune failed during ${phase}: ${pruneResult.error || pruneResult.reason || 'unknown'}`);
      } else if (Number(pruneResult.pruned || 0) > 0) {
        this.logger.warn(`Pruned ${pruneResult.pruned} stale pending supervisor task(s) during ${phase}`);
      }
    }

    return { requeueResult, pruneResult };
  }

  cleanupRequeuedWorkers(requeueResult, reason = 'lease_expired_requeue') {
    const tasks = Array.isArray(requeueResult?.tasks) ? requeueResult.tasks : [];
    for (const task of tasks) {
      const taskId = String(task?.taskId || '').trim();
      const workerPid = Number(task?.workerPid);
      if (!taskId || !Number.isFinite(workerPid) || workerPid <= 0) {
        continue;
      }

      const activeWorker = this.activeWorkers.get(taskId);
      if (activeWorker) {
        this.logger.warn(`Lease expired for active worker ${taskId}; stopping pid ${workerPid} before requeue replacement`);
        void this.stopWorker(taskId, activeWorker, reason);
        continue;
      }

      if (!processExists(workerPid)) {
        continue;
      }

      try {
        process.kill(workerPid);
        this.logger.warn(`Killed stale worker pid ${workerPid} for requeued task ${taskId}`);
      } catch (err) {
        this.logger.warn(`Failed to kill stale worker pid ${workerPid} for ${taskId}: ${err.message}`);
      }
    }
  }

  async settleWorker(worker, result) {
    if (!worker || worker.settled) return;
    worker.settled = true;
    if (worker.timeoutHandle) clearTimeout(worker.timeoutHandle);
    if (worker.heartbeatHandle) clearInterval(worker.heartbeatHandle);
    this.activeWorkers.delete(worker.taskId);

    if (result.ok) {
      const completion = this.store.completeTask(worker.taskId, {
        leaseOwner: worker.leaseOwner,
        resultPayload: result.resultPayload,
        nowMs: Date.now(),
      });
      if (!completion.ok) {
        this.logger.warn(`Completion update failed for ${worker.taskId}: ${completion.reason || completion.error || 'unknown'}`);
      } else {
        this.logger.info(`Task ${worker.taskId} completed successfully`);
      }
    } else {
      const failure = this.store.failTask(worker.taskId, {
        leaseOwner: worker.leaseOwner,
        errorPayload: result.errorPayload,
        nowMs: Date.now(),
      });
      if (!failure.ok) {
        this.logger.warn(`Failure update failed for ${worker.taskId}: ${failure.reason || failure.error || 'unknown'}`);
      } else {
        this.logger.warn(`Task ${worker.taskId} failed`);
      }
    }

    Promise.resolve()
      .then(() => stageImmediateTaskExtraction({
        task: worker.task,
        taskId: worker.taskId,
        status: result.ok ? 'completed' : 'failed',
        metadata: result.ok
          ? {
            resultSummary: result?.resultPayload?.resultSummary || result?.resultPayload?.stdoutTail || '',
            files: worker?.task?.contextSnapshot?.files || [],
            scopes: worker?.task?.contextSnapshot?.scopes || [],
            session: worker?.task?.contextSnapshot?.session || null,
          }
          : {
            error: { message: result?.errorPayload?.message || result?.errorPayload?.stderrTail || 'Task failed' },
            files: worker?.task?.contextSnapshot?.files || [],
            scopes: worker?.task?.contextSnapshot?.scopes || [],
            session: worker?.task?.contextSnapshot?.session || null,
          },
        contextSnapshot: worker?.task?.contextSnapshot || {},
        session: worker?.task?.contextSnapshot?.session || null,
      }, {
        store: this.sleepConsolidator?.cognitiveStore || undefined,
      }))
      .catch((err) => {
        this.logger.warn(`Behavioral extraction failed for supervisor task ${worker.taskId}: ${err.message}`);
      });

    this.writeStatus();
    this.requestTick(`worker-settled:${worker.taskId}`);
  }

  async stopWorker(taskId, worker, reason) {
    if (!worker) return;
    worker.settled = true;
    this.activeWorkers.delete(taskId);
    if (worker.timeoutHandle) clearTimeout(worker.timeoutHandle);
    if (worker.heartbeatHandle) clearInterval(worker.heartbeatHandle);
    appendFileSafe(worker.taskLogPath, `[${new Date().toISOString()}] stopping task ${taskId}: ${reason}\n`);
    try { worker.child.kill(); } catch {}
  }

  async waitForActiveWorkers(timeoutMs = 60000) {
    const deadline = Date.now() + Math.max(1000, timeoutMs);
    while (this.activeWorkers.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return {
      ok: this.activeWorkers.size === 0,
      remaining: this.activeWorkers.size,
    };
  }

  writeStatus(extra = {}) {
    const counts = this.store.isAvailable() ? this.store.getTaskCounts() : null;
    const payload = {
      pid: process.pid,
      startedAtMs: this.startedAtMs,
      heartbeatAtMs: Date.now(),
      pollMs: this.pollMs,
      currentBackoffMs: this.currentBackoffMs,
      maxIdleBackoffMs: this.maxIdleBackoffMs,
      heartbeatMs: this.heartbeatMs,
      leaseMs: this.leaseMs,
      pendingTaskTtlMs: this.pendingTaskTtlMs,
      maxWorkers: this.maxWorkers,
      activeWorkers: Array.from(this.activeWorkers.values()).map((worker) => ({
        taskId: worker.taskId,
        pid: worker.child?.pid || null,
        leaseOwner: worker.leaseOwner,
        startedAtMs: worker.startedAtMs,
      })),
      counts,
      dbPath: this.store.dbPath,
      sleepCycle: {
        enabled: this.sleepEnabled,
        idleThresholdMs: this.sleepIdleMs,
        minIntervalMs: this.sleepMinIntervalMs,
        running: Boolean(this.sleepCyclePromise),
        sessionStatePath: this.sessionStatePath,
        activity: this.getSleepActivitySnapshot(),
        lastSummary: this.lastSleepCycleSummary,
      },
      localModels: this.lastSystemCapabilities?.localModels || {
        enabled: false,
        provider: 'ollama',
        sleepExtraction: {
          enabled: false,
          available: false,
          model: null,
          path: 'fallback',
          reason: 'not_detected',
        },
      },
      memoryConsistency: this.lastMemoryConsistencySummary || {
        enabled: this.memoryConsistencyEnabled,
        checkedAt: null,
        status: 'not_checked',
        synced: false,
        error: null,
        summary: {
          knowledgeEntryCount: 0,
          knowledgeNodeCount: 0,
          missingInCognitiveCount: 0,
          orphanedNodeCount: 0,
          duplicateKnowledgeHashCount: 0,
          issueCount: 0,
        },
      },
      tradingAutomation: {
        enabled: this.tradingEnabled,
        running: Boolean(this.tradingPhasePromise),
        statePath: this.tradingStatePath,
        marketDate: this.tradingState.marketDate || null,
        sleeping: this.tradingState.sleeping !== false,
        phases: this.tradingState.phases || {},
        nextEvent: this.tradingState.nextEvent || null,
        lastSummary: this.lastTradingSummary || null,
      },
      cryptoTradingAutomation: {
        enabled: this.cryptoTradingEnabled,
        running: Boolean(this.cryptoTradingPhasePromise),
        statePath: this.cryptoTradingStatePath,
        lastProcessedAt: this.cryptoTradingState.lastProcessedAt || null,
        nextEvent: this.cryptoTradingState.nextEvent || null,
        lastSummary: this.lastCryptoTradingSummary || null,
      },
      smartMoneyScanner: {
        enabled: Boolean(this.smartMoneyScanner),
        running: Boolean(this.smartMoneyScanner?.running),
        pollMs: this.smartMoneyScanner?.pollMs || null,
        lastTrigger: this.smartMoneyScannerLastTrigger || null,
        state: this.smartMoneyScanner ? {
          recentTransfers: this.smartMoneyScanner.state?.recentTransfers?.length || 0,
          convergenceSignals: this.smartMoneyScanner.state?.convergenceSignals?.length || 0,
        } : null,
      },
      circuitBreaker: {
        enabled: Boolean(this.circuitBreaker),
        running: Boolean(this.circuitBreaker?.running),
        pollMs: this.circuitBreaker?.pollMs || null,
        passCount: this.circuitBreaker?.passCount || 0,
        highWaterMarks: this.circuitBreaker ? Object.keys(this.circuitBreaker.highWaterMarks).length : 0,
        recentExits: this.circuitBreaker?.exits?.slice(-5) || [],
      },
      polymarketTradingAutomation: {
        enabled: this.polymarketTradingEnabled,
        running: Boolean(this.polymarketTradingPhasePromise),
        statePath: this.polymarketTradingStatePath,
        lastProcessedAt: this.polymarketTradingState.lastProcessedAt || null,
        nextEvent: this.polymarketTradingState.nextEvent || null,
        lastSummary: this.lastPolymarketTradingSummary || null,
      },
      launchRadarAutomation: {
        enabled: this.launchRadarEnabled,
        running: Boolean(this.launchRadarPhasePromise),
        dryRun: this.launchRadarDryRun,
        statePath: this.launchRadarStatePath,
        lastProcessedAt: this.launchRadarState.lastProcessedAt || null,
        nextEvent: this.launchRadarState.nextEvent || null,
        lastSummary: this.lastLaunchRadarSummary || null,
      },
      yieldRouterAutomation: {
        enabled: this.yieldRouterEnabled,
        running: Boolean(this.yieldRouterPhasePromise),
        dryRun: this.yieldRouterDryRun,
        statePath: this.yieldRouterStatePath,
        lastProcessedAt: this.yieldRouterState.lastProcessedAt || null,
        nextEvent: this.yieldRouterState.nextEvent || null,
        lastSummary: this.lastYieldRouterSummary || null,
      },
      ...extra,
    };
    ensureDir(this.statusPath);
    fs.writeFileSync(this.statusPath, JSON.stringify(payload, null, 2));
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const daemon = new SupervisorDaemon({
    dbPath: args.dbPath || undefined,
    logPath: args.logPath || undefined,
    statusPath: args.statusPath || undefined,
    pidPath: args.pidPath || undefined,
  });

  const shutdown = async (signal) => {
    daemon.logger.info(`Received ${signal}; shutting down supervisor daemon`);
    await daemon.stop(signal);
    process.exit(0);
  };

  process.on('SIGINT', () => {
    shutdown('SIGINT').catch((err) => {
      daemon.logger.error(`SIGINT shutdown failed: ${err.message}`);
      process.exit(1);
    });
  });
  process.on('SIGTERM', () => {
    shutdown('SIGTERM').catch((err) => {
      daemon.logger.error(`SIGTERM shutdown failed: ${err.message}`);
      process.exit(1);
    });
  });

  if (args.once) {
    const initResult = daemon.init();
    if (!initResult.ok) {
      daemon.logger.error(`Supervisor init failed: ${initResult.error || initResult.reason || 'unknown'}`);
      process.exit(1);
    }
    await daemon.tick();
    const settled = await daemon.waitForActiveWorkers(Math.max(daemon.leaseMs, 30000));
    if (!settled.ok) {
      daemon.logger.warn(`Supervisor once mode timed out with ${settled.remaining} active worker(s)`);
    }
    await daemon.stop('once_complete');
    return;
  }

  const startResult = daemon.start();
  if (!startResult.ok) {
    daemon.logger.error(`Supervisor start failed: ${startResult.error || startResult.reason || 'unknown'}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`${err.stack || err.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  SupervisorDaemon,
  parseArgs,
  DEFAULT_POLL_MS,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_LEASE_MS,
  DEFAULT_MAX_WORKERS,
  DEFAULT_SLEEP_IDLE_MS,
  DEFAULT_SLEEP_MIN_INTERVAL_MS,
};
