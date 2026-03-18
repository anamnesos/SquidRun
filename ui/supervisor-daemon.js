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
    const sleepRan = summary?.sleepResult && summary.sleepResult.skipped !== true;
    const memoryChecked = summary?.memoryConsistency && summary.memoryConsistency.skipped !== true;
    const performedWork = claimedCount > 0
      || queueRequeued > 0
      || pendingPruned > 0
      || leasePruned > 0
      || tradingRan
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

  describeTradingEvent(event) {
    if (!event) return null;
    return {
      key: String(event.key || ''),
      label: String(event.label || ''),
      marketDate: String(event.marketDate || ''),
      scheduledAt: String(event.scheduledAt || ''),
      scheduledTimeLocal: String(event.scheduledTimeLocal || ''),
      displayTimeZone: String(event.displayTimeZone || ''),
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
