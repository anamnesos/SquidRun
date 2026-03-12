const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const { spawn } = require('child_process');

const { resolveCoordPath } = require('./config');
const { SupervisorStore } = require('./modules/supervisor');
const { MemorySearchIndex, resolveWorkspacePaths } = require('./modules/memory-search');
const {
  SleepConsolidator,
  DEFAULT_IDLE_THRESHOLD_MS,
  DEFAULT_MIN_INTERVAL_MS,
  resolveSessionStatePath,
} = require('./modules/cognitive-memory-sleep');

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
const DEFAULT_SLEEP_IDLE_MS = DEFAULT_IDLE_THRESHOLD_MS;
const DEFAULT_SLEEP_MIN_INTERVAL_MS = DEFAULT_MIN_INTERVAL_MS;

function resolveRuntimePath(relPath) {
  return resolveCoordPath(path.join('runtime', relPath), { forWrite: true });
}

const DEFAULT_PID_PATH = resolveRuntimePath('supervisor.pid');
const DEFAULT_STATUS_PATH = resolveRuntimePath('supervisor-status.json');
const DEFAULT_LOG_PATH = resolveRuntimePath('supervisor.log');
const DEFAULT_TASK_LOG_DIR = resolveRuntimePath(path.join('supervisor-tasks'));

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

class SupervisorDaemon {
  constructor(options = {}) {
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
    this.pollTimer = null;
    this.statusTimer = null;
    this.stopping = false;
    this.startedAtMs = Date.now();
    this.memoryIndexWatcher = null;
    this.memoryIndexDebounceTimer = null;
    this.memoryIndexRefreshPromise = null;
    this.pendingMemoryIndexReason = null;
    this.memoryIndexDebounceMs = Math.max(
      500,
      Number.parseInt(options.memoryIndexDebounceMs || DEFAULT_MEMORY_INDEX_DEBOUNCE_MS, 10)
      || DEFAULT_MEMORY_INDEX_DEBOUNCE_MS
    );
    this.memoryIndexEnabled = options.memoryIndexEnabled !== false
      && process.env.SQUIDRUN_MEMORY_INDEX_WATCHER !== '0';
    this.memorySearchIndex = this.memoryIndexEnabled
      ? (options.memorySearchIndex || new MemorySearchIndex())
      : null;
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
    const housekeeping = this.runQueueHousekeeping(Date.now(), 'startup');
    this.writeStatus();
    return { ok: true, store: this.store.getStatus(), ...housekeeping };
  }

  start() {
    const initResult = this.init();
    if (!initResult.ok) {
      return initResult;
    }

    this.logger.info(`Supervisor daemon started (pid=${process.pid}, db=${this.store.dbPath})`);
    this.startMemoryIndexWatcher();
    this.pollTimer = setInterval(() => {
      this.tick().catch((err) => {
        this.logger.error(`Supervisor tick failed: ${err.message}`);
      });
    }, this.pollMs);
    this.statusTimer = setInterval(() => {
      this.writeStatus();
    }, Math.max(1000, this.pollMs));
    return { ok: true };
  }

  async stop(reason = 'shutdown') {
    if (this.stopping) return;
    this.stopping = true;

    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.pollTimer = null;
    this.statusTimer = null;

    await this.stopMemoryIndexWatcher();

    if (this.sleepConsolidator) {
      try { this.sleepConsolidator.close(); } catch {}
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
    this.runQueueHousekeeping(Date.now(), 'tick');

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
      await this.launchTask(claim.task, { leaseOwner });
    }

    await this.maybeRunSleepCycle();
    this.writeStatus();
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

    this.writeStatus();
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

