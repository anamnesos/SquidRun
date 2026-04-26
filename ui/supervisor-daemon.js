const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const chokidar = require('chokidar');
const { spawn } = require('child_process');
const { execFileSync } = require('child_process');
const { getDatabaseSync } = require('./modules/sqlite-compat');
const DatabaseSync = getDatabaseSync();

const { resolveCoordPath, getProjectRoot, ROLE_ID_MAP } = require('./config');
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
const dynamicWatchlist = require('./modules/trading/dynamic-watchlist');
const oracleWatchRegime = require('./modules/trading/oracle-watch-regime');
const tradingRiskEngine = require('./modules/trading/risk-engine');
const consensusSizer = require('./modules/trading/consensus-sizer');
const convictionEngine = require('./modules/trading/conviction-engine');
const rangeStructure = require('./modules/trading/range-structure');
const [private-live-ops]Client = require('./modules/trading/[private-live-ops]-client');
const [private-live-ops]NativeLayer = require('./modules/trading/[private-live-ops]-native-layer');
const agentPositionAttribution = require('./modules/trading/agent-position-attribution');
const {
  DEFAULT_LIVE_OPS_MANUAL_ACTIVITY_PATH,
  readManual[private-live-ops]Activity,
  isManual[private-live-ops]ActivityActive,
} = require('./modules/trading/[private-live-ops]-manual-activity');
const { SmartMoneyScanner, createEtherscanProvider } = require('./modules/trading/smart-money-scanner');
const macroRiskGate = require('./modules/trading/macro-risk-gate');
const { CircuitBreaker } = require('./modules/trading/circuit-breaker');
const yieldRouterModule = require('./modules/trading/yield-router');
const marketScannerModule = require('./modules/trading/market-scanner');
const sparkCapture = require('./modules/trading/spark-capture');
const predictionTrackerModule = require('./modules/trading/prediction-tracker');
const eventVeto = require('./modules/trading/event-veto');
const tradeJournal = require('./modules/trading/journal');
const { queryCommsJournalEntries } = require('./modules/main/comms-journal');
const RUNNING_SUPERVISOR_MAIN = require.main === module;

const CONSULTATION_FUNDING_DIVERGENCE_STRONG_BPS = 50;
const CONSULTATION_FUNDING_DIVERGENCE_MILD_BPS = 25;
const CONSULTATION_FUNDING_DIVERGENCE_STRONG_BOOST = 1.0;
const CONSULTATION_FUNDING_DIVERGENCE_MILD_BOOST = 0.35;
const CONSULTATION_NATIVE_FUNDING_MAX_AGE_MS = 15 * 60 * 1000;

try {
  require('dotenv').config({ path: path.join(getProjectRoot(), '.env'), quiet: true, override: true });
} catch {}

// [private-profile] profile MUST NOT spawn wallet-touching trading lanes. The dotenv.config
// call above uses override:true and would clobber any pre-set process.env values
// that ui/profile.js applyProfileEnv tried to inject. So we re-apply the private-profile
// disable AFTER the .env load. Belt + suspenders: kill all SQUIDRUN_* trading flags
// AND blank the HL credentials so even if a lane slipped through, has[private-live-ops]Credentials returns false.
if (String(process.env.SQUIDRUN_PROFILE || '').toLowerCase() === 'private-profile') {
  process.env.SQUIDRUN_LIVE_OPS_AUTOMATION = '0';
  process.env.SQUIDRUN_ORACLE_WATCH = '0';
  process.env.SQUIDRUN_CRYPTO_TRADING_AUTOMATION = '0';
  process.env.SQUIDRUN_MARKET_SCANNER_AUTOMATION = '0';
  process.env.SQUIDRUN_LIVE_OPS_SQUEEZE_DETECTOR = '0';
  process.env.SQUIDRUN_LIVE_OPS_MONITOR = '0';
  process.env.SQUIDRUN_SPARK_MONITOR_AUTOMATION = '0';
  process.env.SQUIDRUN_LIVE_OPS_AUTOMATION = '0';
  process.env.SQUIDRUN_SAYLOR_WATCHER = '0';
  process.env.SQUIDRUN_NEWS_SCAN_AUTOMATION = '0';
  process.env.SQUIDRUN_TRADING_AUTOMATION = '0';
  process.env.SQUIDRUN_YIELD_ROUTER_AUTOMATION = '0';
  process.env.SQUIDRUN_MARKET_RESEARCH_AUTOMATION = '0';
  process.env.LIVE_OPS_WALLET_ADDRESS = '';
  process.env.LIVE_OPS_ADDRESS = '';
  process.env.LIVE_OPS_PRIVATE_KEY = '';
}

function hardenStandardStream(stream, { silence = false } = {}) {
  if (!stream || typeof stream.write !== 'function') {
    return;
  }
  let disabled = false;
  const markBroken = () => {
    disabled = true;
  };
  try {
    stream.on('error', markBroken);
  } catch {
    disabled = true;
  }
  const originalWrite = stream.write.bind(stream);
  stream.write = (chunk, encoding, callback) => {
    const resolvedEncoding = typeof encoding === 'function' ? undefined : encoding;
    const resolvedCallback = typeof encoding === 'function'
      ? encoding
      : (typeof callback === 'function' ? callback : null);
    if (silence || disabled || stream.destroyed || stream.writable === false) {
      if (resolvedCallback) resolvedCallback();
      return true;
    }
    try {
      return originalWrite(chunk, resolvedEncoding, (error) => {
        if (error) markBroken();
        if (resolvedCallback) resolvedCallback(error);
      });
    } catch (error) {
      markBroken();
      if (resolvedCallback) resolvedCallback(error);
      return false;
    }
  };
}

hardenStandardStream(process.stdout, { silence: RUNNING_SUPERVISOR_MAIN });
hardenStandardStream(process.stderr, { silence: RUNNING_SUPERVISOR_MAIN });

if (RUNNING_SUPERVISOR_MAIN) {
  process.on('uncaughtException', (error) => {
    if (error?.code === 'EOF' && error?.syscall === 'write') {
      try {
        const fallbackLogPath = path.join(getProjectRoot(), '.squidrun', 'runtime', 'supervisor.log');
        ensureDir(fallbackLogPath);
        fs.appendFileSync(
          fallbackLogPath,
          `[${new Date().toISOString()}] [WARN] Suppressed detached stdio EOF (${error.message})\n`
        );
      } catch {}
      return;
    }
    throw error;
  });
}

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
const DEFAULT_SUPERVISOR_REPEAT_LOG_MS = Math.max(60_000, Number.parseInt(process.env.SQUIDRUN_SUPERVISOR_REPEAT_LOG_MS || '900000', 10) || 900000);
const DEFAULT_MEMORY_INDEX_REPEAT_LOG_MS = Math.max(60_000, Number.parseInt(process.env.SQUIDRUN_MEMORY_INDEX_REPEAT_LOG_MS || '900000', 10) || 900000);
const DEFAULT_MEMORY_CONSISTENCY_REPEAT_LOG_MS = Math.max(60_000, Number.parseInt(process.env.SQUIDRUN_MEMORY_CONSISTENCY_REPEAT_LOG_MS || '1800000', 10) || 1800000);
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

function resolveProjectUiScriptPath(scriptName, projectRoot = getProjectRoot()) {
  const root = path.resolve(String(projectRoot || getProjectRoot() || process.cwd()));
  const candidates = [
    path.join(root, 'ui', 'scripts', scriptName),
    path.join(root, 'scripts', scriptName),
    path.join(root, '.squidrun', 'bin', 'runtime', 'ui', 'scripts', scriptName),
    path.join(__dirname, 'scripts', scriptName),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  const packagedCandidate = candidates.find((candidate) => {
    const normalized = String(candidate || '').replace(/\\/g, '/').toLowerCase();
    return normalized.includes('/app.asar/') || normalized.includes('/app.asar.unpacked/');
  });
  return packagedCandidate || candidates[0];
}

function resolveProjectUiSettingsPath(projectRoot = getProjectRoot()) {
  const root = path.resolve(String(projectRoot || getProjectRoot() || process.cwd()));
  return path.join(root, 'ui', 'settings.json');
}

const DEFAULT_PID_PATH = resolveRuntimePath('supervisor.pid');
const DEFAULT_STATUS_PATH = resolveRuntimePath('supervisor-status.json');
const DEFAULT_LOG_PATH = resolveRuntimePath('supervisor.log');
const DEFAULT_TASK_LOG_DIR = resolveRuntimePath(path.join('supervisor-tasks'));
const DEFAULT_WAKE_SIGNAL_PATH = resolveRuntimePath('supervisor-wake.signal');
const DEFAULT_AGENT_TASK_QUEUE_PATH = resolveRuntimePath('agent-task-queue.json');
const DEFAULT_TRADING_STATE_PATH = resolveRuntimePath('trading-supervisor-state.json');
const DEFAULT_CRYPTO_TRADING_STATE_PATH = resolveRuntimePath('crypto-trading-supervisor-state.json');
const DEFAULT_DEFI_PEAK_PNL_PATH = resolveRuntimePath('defi-peak-pnl.json');
const DEFAULT_NEWS_SCAN_STATE_PATH = resolveRuntimePath('news-scan-supervisor-state.json');
const DEFAULT_MARKET_RESEARCH_STATE_PATH = resolveRuntimePath('market-research-supervisor-state.json');
const DEFAULT_LIVE_OPS_STATE_PATH = resolveRuntimePath('[private-live-ops]-supervisor-state.json');
const DEFAULT_SPARK_MONITOR_STATE_PATH = resolveRuntimePath('spark-monitor-supervisor-state.json');
const DEFAULT_MARKET_SCANNER_STATE_PATH = resolveRuntimePath('market-scanner-state.json');
const DEFAULT_ORACLE_WATCH_RULES_PATH = resolveRuntimePath('oracle-watch-rules.json');
const DEFAULT_ORACLE_WATCH_STATE_PATH = resolveRuntimePath('oracle-watch-state.json');
const DEFAULT_EUNBYEOL_CHECKIN_STATE_PATH = resolveRuntimePath('private-profile-checkin-supervisor-state.json');
const DEFAULT_YIELD_ROUTER_STATE_PATH = resolveRuntimePath('yield-router-supervisor-state.json');
const DEFAULT_TELEGRAM_CHAT_ID = '5613428850';
const DEFAULT_SAYLOR_WATCHER_INTERVAL_MS = Math.max(
  60_000,
  Number.parseInt(process.env.SQUIDRUN_SAYLOR_WATCHER_INTERVAL_MS || '300000', 10) || 300_000
);
const DEFAULT_LIVE_OPS_SQUEEZE_DETECTOR_INTERVAL_MS = Math.max(
  30_000,
  Number.parseInt(process.env.SQUIDRUN_LIVE_OPS_SQUEEZE_DETECTOR_INTERVAL_MS || '60000', 10) || 60_000
);
const DEFAULT_ORACLE_WATCH_INTERVAL_MS = Math.max(
  5_000,
  Number.parseInt(process.env.SQUIDRUN_ORACLE_WATCH_INTERVAL_MS || '10000', 10) || 10_000
);
const DEFAULT_ORACLE_WATCH_MACRO_INTERVAL_MS = Math.max(
  5_000,
  Number.parseInt(process.env.SQUIDRUN_ORACLE_WATCH_MACRO_INTERVAL_MS || '5000', 10) || 5_000
);
const DEFAULT_ORACLE_WATCH_RELAUNCH_COOLDOWN_MS = 5 * 60 * 1000;
const ORACLE_WATCH_STALE_ALERT_THRESHOLD_MS = 60_000;
const DEFAULT_LIVE_OPS_MONITOR_POLL_MS = Math.max(
  60_000,
  Number.parseInt(process.env.SQUIDRUN_LIVE_OPS_MONITOR_POLL_MS || '300000', 10) || 300_000
);
const DEFAULT_RANGE_CONVICTION_INTERVAL_MS = Math.max(
  60_000,
  Number.parseInt(process.env.SQUIDRUN_RANGE_CONVICTION_INTERVAL_MS || '180000', 10) || 180_000
);
const DEFAULT_CRYPTO_TRADING_STRATEGY_MODE = 'momentum';
const DEFAULT_AGENT_TASK_IDLE_COMPLETION_MS = Math.max(
  10_000,
  Number.parseInt(process.env.SQUIDRUN_AGENT_TASK_IDLE_COMPLETION_MS || '30000', 10) || 30_000
);
const DEFAULT_AGENT_TASK_READY_GRACE_MS = Math.max(
  10_000,
  Number.parseInt(process.env.SQUIDRUN_AGENT_TASK_READY_GRACE_MS || '60000', 10) || 60_000
);
const DEFAULT_AGENT_TASK_HISTORY_LIMIT = Math.max(
  10,
  Number.parseInt(process.env.SQUIDRUN_AGENT_TASK_HISTORY_LIMIT || '50', 10) || 50
);
const DEFAULT_AGENT_TASK_REENGAGE_IDLE_MS = Math.max(
  60_000,
  Number.parseInt(process.env.SQUIDRUN_AGENT_TASK_REENGAGE_IDLE_MS || '300000', 10) || 300_000
);
const AGENT_TASK_QUEUE_ROLES = Object.freeze(['architect', 'builder', 'oracle']);
const TRADING_AGENT_TARGETS = Object.freeze(['architect', 'builder', 'oracle']);
const TRADING_PHASES = Object.freeze([
  { key: 'premarket_wake', label: 'Pre-market wake', offsetMinutes: -60 },
  { key: 'pre_open_consensus', label: 'Consensus round', offsetMinutes: -5 },
  { key: 'market_open_execute', label: 'Market open execute', offsetMinutes: 0 },
  { key: 'close_wake', label: 'Close wake', anchor: 'close', offsetMinutes: -30 },
  { key: 'market_close_review', label: 'Market close review', anchor: 'close', offsetMinutes: 0 },
  { key: 'end_of_day', label: 'End of day', anchor: 'close', offsetMinutes: 30 },
]);
const NEWS_SCAN_PHASES = Object.freeze([
  { key: 'news_scan', label: 'News and market scan' },
]);
const DEFAULT_NEWS_SCAN_INTERVAL_MINUTES = 2 * 60;
const MARKET_RESEARCH_PHASES = Object.freeze([
  { key: 'market_research', label: 'Market research scan' },
]);
const MARKET_SCANNER_PHASES = Object.freeze([
  { key: 'market_scanner', label: '[private-live-ops] market scanner' },
]);
const EUNBYEOL_CHECKIN_PHASES = Object.freeze([
  { key: 'private-profile_checkin', label: '[private-profile] check-in review' },
]);
const DEFAULT_MARKET_RESEARCH_INTERVAL_MINUTES = 4 * 60;
const DEFAULT_LIVE_OPS_INTERVAL_MINUTES = 6 * 60;
const DEFAULT_SPARK_MONITOR_INTERVAL_MINUTES = 1;
const DEFAULT_MARKET_SCANNER_INTERVAL_MINUTES = 30;
const MARKET_SCANNER_ALERT_MIN_VOLUME_USD_24H = 1_000_000;
const DEFAULT_EUNBYEOL_CHECKIN_INTERVAL_MINUTES = 4 * 60;
const DEFAULT_EUNBYEOL_CHECKIN_SILENCE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MARKET_SCANNER_CONSULTATION_SYMBOL_LIMIT = Math.max(
  1,
  Number.parseInt(process.env.SQUIDRUN_MARKET_SCANNER_CONSULTATION_SYMBOL_LIMIT || '2', 10) || 2
);
const DEFAULT_CRYPTO_CONSULTATION_SYMBOL_MAX = Math.max(
  5,
  Number.parseInt(process.env.SQUIDRUN_CRYPTO_CONSULTATION_SYMBOL_MAX || '5', 10) || 5
);
const CORE_CRYPTO_CONSULTATION_SYMBOLS = Object.freeze(['BTC/USD', 'ETH/USD', 'SOL/USD']);
const YIELD_ROUTER_PHASES = Object.freeze([
  { key: 'yield_rebalance', label: 'Yield router rebalance' },
]);
const DEFAULT_YIELD_ROUTER_INTERVAL_MINUTES = 6 * 60;
const DEFAULT_TRADE_RECONCILIATION_POLL_MS = Math.max(
  60_000,
  Number.parseInt(process.env.SQUIDRUN_TRADE_RECONCILIATION_POLL_MS || '300000', 10) || 300_000
);
const DEFAULT_LIVE_MIN_AGREE_CONFIDENCE = 0.6;
const DEFAULT_AUTO_EXECUTE_MIN_CONFIDENCE = 0.6;

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

function readProjectWatcherEnabled(projectRoot = getProjectRoot(), fallback = true) {
  const settingsPath = resolveProjectUiSettingsPath(projectRoot);
  const settings = readJsonFile(settingsPath, null);
  if (settings && Object.prototype.hasOwnProperty.call(settings, 'watcherEnabled')) {
    return settings.watcherEnabled !== false;
  }
  return fallback;
}

function resolveOracleWatchIntervalMs(rulesPath, fallback = DEFAULT_ORACLE_WATCH_INTERVAL_MS) {
  const config = readJsonFile(rulesPath, null);
  const mode = String(config?.mode || 'normal').trim().toLowerCase();
  const isMacroMode = mode === 'macro_release' || mode === 'macro-release';
  const raw = isMacroMode ? config?.macroPollIntervalMs : config?.pollIntervalMs;
  const defaultMs = isMacroMode ? DEFAULT_ORACLE_WATCH_MACRO_INTERVAL_MS : fallback;
  return Math.max(5_000, Number.parseInt(raw, 10) || defaultMs);
}

function toLocalDateKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function buildOracleWatchHeartbeat(summary = {}, state = {}) {
  const heartbeat = state?.heartbeat || {};
  const lastTickAt = String(
    heartbeat.lastTickAt
    || summary?.lastRunAt
    || state?.updatedAt
    || ''
  ).trim() || null;
  const intervalMs = Math.max(
    5_000,
    Number(heartbeat.intervalMs || summary?.intervalMs || DEFAULT_ORACLE_WATCH_INTERVAL_MS) || DEFAULT_ORACLE_WATCH_INTERVAL_MS
  );
  const ageMs = lastTickAt ? Math.max(0, Date.now() - new Date(lastTickAt).getTime()) : null;
  const stale = !lastTickAt || !Number.isFinite(ageMs) || ageMs > Math.max(intervalMs * 2, 15_000);
  return {
    lastTickAt,
    intervalMs,
    ageMs: Number.isFinite(ageMs) ? ageMs : null,
    stale,
    state: stale ? 'red' : 'green',
  };
}

function resolveOracleWatchBackoffUntilMs(state = {}, nowMs = Date.now()) {
  const heartbeatBackoffMs = new Date(state?.heartbeat?.backoffUntil || '').getTime();
  const rateLimitBackoffMs = new Date(state?.rateLimit?.backoffUntil || '').getTime();
  const backoffUntilMs = Math.max(
    Number.isFinite(heartbeatBackoffMs) ? heartbeatBackoffMs : 0,
    Number.isFinite(rateLimitBackoffMs) ? rateLimitBackoffMs : 0
  );
  if (!Number.isFinite(backoffUntilMs) || backoffUntilMs <= nowMs) return null;
  return backoffUntilMs;
}

function getTodayRealizedTargetProgress(journalPath, now = new Date()) {
  const targetUsd = 200;
  const perHourTargetUsd = targetUsd / 24;
  const localDate = toLocalDateKey(now);
  try {
    const db = tradeJournal.getDb(journalPath);
    const dailySummary = db.prepare(`
      SELECT *
      FROM daily_summary
      WHERE date = ?
      LIMIT 1
    `).get(localDate) || null;
    const fallback = db.prepare(`
      SELECT
        COALESCE(SUM(realized_pnl), 0) AS realized_pnl,
        COUNT(*) AS closed_trades
      FROM trades
      WHERE realized_pnl IS NOT NULL
        AND COALESCE(
          substr(outcome_recorded_at, 1, 10),
          substr(reconciled_at, 1, 10),
          substr(filled_at, 1, 10),
          substr(timestamp, 1, 10)
        ) = ?
    `).get(localDate) || {};
    const realizedPnl = Number(
      dailySummary?.pnl
      ?? fallback?.realized_pnl
      ?? 0
    ) || 0;
    return {
      date: localDate,
      realizedPnl,
      targetUsd,
      vsTargetUsd: Number((realizedPnl - targetUsd).toFixed(2)),
      cushionHoursBanked: Number((realizedPnl / perHourTargetUsd).toFixed(2)),
      targetHit: realizedPnl >= targetUsd,
      closedTrades: Number(dailySummary?.trades_count ?? fallback?.closed_trades ?? 0) || 0,
      source: dailySummary ? 'daily_summary' : 'trade_rollup',
      error: null,
    };
  } catch (error) {
    return {
      date: localDate,
      realizedPnl: 0,
      targetUsd,
      vsTargetUsd: Number((0 - targetUsd).toFixed(2)),
      cushionHoursBanked: 0,
      targetHit: false,
      closedTrades: 0,
      source: 'unavailable',
      error: error?.message || String(error),
    };
  }
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function trimTail(value, maxBytes = DEFAULT_STDIO_TAIL_BYTES) {
  const text = typeof value === 'string' ? value : String(value || '');
  if (!text) return '';
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return text;
  return buffer.slice(buffer.length - maxBytes).toString('utf8');
}

function toPositiveMs(value, fallback = 0) {
  const numeric = Number.parseInt(value, 10);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallback;
  }
  return numeric;
}

function trimOptionalText(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function tailText(value, maxChars = 4000) {
  const text = typeof value === 'string' ? value : String(value || '');
  if (!text) return '';
  return text.length <= maxChars ? text : text.slice(-maxChars);
}

function hasReadyPrompt(scrollback = '') {
  const tail = tailText(scrollback, 4000);
  if (!tail) return false;
  return [
    /type your message or @path\/to\/file/i,
    /\?\s+for shortcuts/i,
    /press up to edit queued messages/i,
    /\bready \(/i,
    /\n>\s*$/m,
  ].some((pattern) => pattern.test(tail));
}

function createAgentTaskId(role = 'agent') {
  const suffix = Math.random().toString(36).slice(2, 10);
  return `${String(role || 'agent')}-${Date.now()}-${suffix}`;
}

function createEmptyAgentQueueBucket() {
  return {
    pending: [],
    active: null,
    history: [],
  };
}

function normalizeAgentQueueTask(task, role, nowMs = Date.now()) {
  if (!task || typeof task !== 'object') return null;
  const message = trimOptionalText(task.message);
  if (!message) return null;
  return {
    taskId: trimOptionalText(task.taskId) || trimOptionalText(task.id) || createAgentTaskId(role),
    title: trimOptionalText(task.title),
    role,
    message,
    source: trimOptionalText(task.source),
    priority: trimOptionalText(task.priority) || 'normal',
    metadata: task.metadata && typeof task.metadata === 'object' ? { ...task.metadata } : {},
    completionSentinel: trimOptionalText(task.completionSentinel),
    idleCompletionMs: toPositiveMs(task.idleCompletionMs, 0),
    responseTimeoutMs: toPositiveMs(task.responseTimeoutMs, 0),
    enqueuedAtMs: toNumber(task.enqueuedAtMs || task.createdAtMs, nowMs),
    dispatchCount: Math.max(0, Number.parseInt(task.dispatchCount || '0', 10) || 0),
    lastDispatchAtMs: toPositiveMs(task.lastDispatchAtMs, 0),
    firstActivityAtMs: toPositiveMs(task.firstActivityAtMs, 0),
    lastObservedActivityAtMs: toPositiveMs(task.lastObservedActivityAtMs, 0),
    completedAtMs: toPositiveMs(task.completedAtMs, 0),
    status: trimOptionalText(task.status) || 'pending',
    completionReason: trimOptionalText(task.completionReason),
    lastResult: task.lastResult && typeof task.lastResult === 'object' ? { ...task.lastResult } : null,
    lastError: trimOptionalText(task.lastError),
  };
}

function normalizeAgentQueueBucket(entry, role, nowMs = Date.now(), historyLimit = DEFAULT_AGENT_TASK_HISTORY_LIMIT) {
  const bucket = Array.isArray(entry)
    ? { pending: entry, active: null, history: [] }
    : (entry && typeof entry === 'object' ? entry : {});
  const pending = Array.isArray(bucket.pending)
    ? bucket.pending
        .map((task) => normalizeAgentQueueTask(task, role, nowMs))
        .filter(Boolean)
    : [];
  const active = normalizeAgentQueueTask(bucket.active, role, nowMs);
  const history = Array.isArray(bucket.history)
    ? bucket.history
        .map((task) => normalizeAgentQueueTask(task, role, nowMs))
        .filter(Boolean)
        .slice(-historyLimit)
    : [];
  return { pending, active, history };
}

function normalizeAgentTaskQueueState(raw, options = {}) {
  const nowMs = toNumber(options.nowMs, Date.now());
  const historyLimit = Math.max(1, Number.parseInt(options.historyLimit || DEFAULT_AGENT_TASK_HISTORY_LIMIT, 10) || DEFAULT_AGENT_TASK_HISTORY_LIMIT);
  const source = raw && typeof raw === 'object' ? raw : {};
  const agentsSource = source.agents && typeof source.agents === 'object' ? source.agents : source;
  const agents = {};
  for (const role of AGENT_TASK_QUEUE_ROLES) {
    agents[role] = normalizeAgentQueueBucket(agentsSource[role], role, nowMs, historyLimit);
  }
  return {
    version: 1,
    updatedAt: trimOptionalText(source.updatedAt),
    agents,
  };
}

function summarizeAgentTaskQueueState(state) {
  const summary = {
    pending: {},
    active: {},
    history: {},
    totalPending: 0,
    totalActive: 0,
  };
  const agents = state?.agents && typeof state.agents === 'object' ? state.agents : {};
  for (const role of AGENT_TASK_QUEUE_ROLES) {
    const bucket = agents[role] || createEmptyAgentQueueBucket();
    const pendingCount = Array.isArray(bucket.pending) ? bucket.pending.length : 0;
    summary.pending[role] = pendingCount;
    summary.active[role] = bucket.active ? {
      taskId: bucket.active.taskId,
      title: bucket.active.title || null,
      lastDispatchAtMs: bucket.active.lastDispatchAtMs || 0,
      firstActivityAtMs: bucket.active.firstActivityAtMs || 0,
      completionSentinel: bucket.active.completionSentinel || null,
    } : null;
    summary.history[role] = Array.isArray(bucket.history) ? bucket.history.length : 0;
    summary.totalPending += pendingCount;
    if (bucket.active) summary.totalActive += 1;
  }
  return summary;
}

function appendFileSafe(filePath, chunk) {
  try {
    fs.appendFileSync(filePath, chunk);
  } catch {}
}

function resolve[private-live-ops]WalletAddress(env = process.env) {
  return String(
    env?.LIVE_OPS_WALLET_ADDRESS
    || env?.LIVE_OPS_ADDRESS
    || ''
  ).trim();
}

function normalize[private-live-ops]KillSwitchAction(value, fallback = 'block_new_entries') {
  const normalized = String(value || fallback).trim().toLowerCase();
  return normalized === 'flatten_positions' ? 'flatten_positions' : 'block_new_entries';
}

function applyMacroRiskSizeCapToApprovedTrades(approvedTrades = [], macroRisk = null) {
  const macroMultiplier = Number(macroRisk?.constraints?.positionSizeMultiplier);
  if (!Number.isFinite(macroMultiplier) || !(macroMultiplier > 0) || macroMultiplier >= 1) {
    return approvedTrades;
  }
  for (const trade of Array.isArray(approvedTrades) ? approvedTrades : []) {
    const assetClass = String(trade?.assetClass || 'crypto').trim().toLowerCase() || 'crypto';
    const currentMultiplier = consensusSizer.resolveAppliedSizeMultiplier(
      trade?.sizeGuide?.bucket || 'normal',
      assetClass,
      trade?.sizeGuide?.sizeMultiplier ?? null
    );
    if (!Number.isFinite(currentMultiplier) || currentMultiplier <= 0) {
      continue;
    }
    const effectiveMultiplier = Math.min(currentMultiplier, macroMultiplier);
    const ratio = effectiveMultiplier / currentMultiplier;
    trade.sizeGuide = {
      ...(trade.sizeGuide || {}),
      macroSizeMultiplier: macroMultiplier,
      effectiveSizeMultiplier: effectiveMultiplier,
    };
    if (!(ratio < 0.999999)) {
      continue;
    }
    if (Number.isFinite(Number(trade?.riskCheck?.maxShares))) {
      trade.riskCheck.maxShares = Math.floor(Number(trade.riskCheck.maxShares) * ratio * 1e6) / 1e6;
    }
    if (Number.isFinite(Number(trade?.riskCheck?.positionNotional))) {
      trade.riskCheck.positionNotional = Number((Number(trade.riskCheck.positionNotional) * ratio).toFixed(2));
    }
    if (Number.isFinite(Number(trade?.riskCheck?.margin))) {
      trade.riskCheck.margin = Number((Number(trade.riskCheck.margin) * ratio).toFixed(2));
    }
  }
  return approvedTrades;
}

function has[private-live-ops]Credentials(env = process.env) {
  return Boolean(
    String(env?.LIVE_OPS_PRIVATE_KEY || '').trim()
    && resolve[private-live-ops]WalletAddress(env)
  );
}

function normalize[private-live-ops]Position(position = {}) {
  const size = toNumber(position?.szi ?? position?.size, 0);
  return {
    coin: String(position?.coin || position?.asset || '').trim().toUpperCase(),
    dex: String(position?.dex || '').trim() || null,
    size,
    side: size < 0 ? 'short' : (size > 0 ? 'long' : 'flat'),
    entryPx: toNumber(position?.entryPx, 0),
    unrealizedPnl: toNumber(position?.unrealizedPnl, 0),
    liquidationPx: toNumber(position?.liquidationPx, 0),
  };
}

function format[private-live-ops]RetainedRatio(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 'n/a';
  return `${(numeric * 100).toFixed(0)}%`;
}

function build[private-live-ops]PaneAlert(position = {}, level = 'warning') {
  const label = String(level || 'warning').trim().toUpperCase();
  const side = String(position?.side || '').trim().toUpperCase() || 'POSITION';
  return `[${label}] [private-live-ops] ${position.coin} ${side} unrealized P&L is now $${toNumber(position?.unrealizedPnl, 0).toFixed(2)} vs peak $${toNumber(position?.peakUnrealizedPnl, 0).toFixed(2)} (${format[private-live-ops]RetainedRatio(position?.retainedPeakRatio)} retained). Review the live position now.`;
}

async function executeNodeScript(scriptPath, args = [], options = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child = null;
    let timedOut = false;
    const timeoutMs = Math.max(1_000, Number.parseInt(options.timeoutMs || '120000', 10) || 120_000);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child?.kill();
      } catch {}
    }, timeoutMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }

    try {
      child = spawn(process.execPath, [scriptPath, ...args], {
        cwd: options.cwd || getProjectRoot(),
        env: options.env || process.env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      clearTimeout(timer);
      resolve({
        ok: false,
        exitCode: null,
        error: err.message,
        stdout,
        stderr,
      });
      return;
    }

    child.stdout.on('data', (chunk) => {
      stdout = trimTail(stdout + String(chunk || ''), 64 * 1024);
    });
    child.stderr.on('data', (chunk) => {
      stderr = trimTail(stderr + String(chunk || ''), 64 * 1024);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        exitCode: null,
        error: err.message,
        stdout,
        stderr,
      });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        ok: !timedOut && Number(code) === 0,
        exitCode: Number.isFinite(Number(code)) ? Number(code) : null,
        signal: signal || null,
        timedOut,
        stdout,
        stderr,
      });
    });
  });
}

function create[private-live-ops]Executor(options = {}) {
  const env = options.env || process.env;
  const cwd = options.cwd || getProjectRoot();
  const dryRun = options.dryRun === true;
  const defiExecuteScriptPath = options.defiExecuteScriptPath || resolveProjectUiScriptPath('hm-defi-execute.js', cwd);
  const defiCloseScriptPath = options.defiCloseScriptPath || resolveProjectUiScriptPath('hm-defi-close.js', cwd);
  const supervisorEnv = {
    ...env,
    SQUIDRUN_LIVE_OPS_CALLER: 'supervisor',
  };

  function normalizeAsset(asset = 'ETH') {
    return String(asset || 'ETH').trim().toUpperCase();
  }

  return {
    async getAccountState() {
      const walletAddress = resolve[private-live-ops]WalletAddress(env);
      if (!walletAddress) {
        throw new Error('[private-live-ops] wallet address is missing. Set LIVE_OPS_WALLET_ADDRESS.');
      }
      const [account, positions] = await Promise.all([
        [private-live-ops]Client.getAccountSnapshot({ walletAddress }),
        [private-live-ops]Client.getOpenPositions({ walletAddress }),
      ]);
      return {
        accountValue: toNumber(account?.equity, 0),
        withdrawable: toNumber(account?.cash, 0),
        positions: (Array.isArray(positions) ? positions : [])
          .map((position) => normalize[private-live-ops]Position({
            ...(position?.raw || {}),
            dex: position?.dex || null,
          }))
          .filter((position) => position.coin && position.side !== 'flat'),
      };
    },

    async openPosition({ asset = 'ETH', direction = 'SHORT', stopLossPrice = null } = {}) {
      const args = dryRun
        ? ['--dry-run', 'trade', '--asset', normalizeAsset(asset), '--direction', String(direction || 'SHORT').trim().toUpperCase()]
        : ['trade', '--asset', normalizeAsset(asset), '--direction', String(direction || 'SHORT').trim().toUpperCase()];
      if (Number.isFinite(Number(stopLossPrice)) && Number(stopLossPrice) > 0) {
        args.push('--stop-loss', String(Number(stopLossPrice)));
      }
      return executeNodeScript(defiExecuteScriptPath, args, {
        cwd,
        env: supervisorEnv,
      });
    },

    async closePosition({ asset = 'ETH' } = {}) {
      const args = dryRun
        ? ['--dry-run', '--asset', normalizeAsset(asset)]
        : ['--asset', normalizeAsset(asset)];
      return executeNodeScript(defiCloseScriptPath, args, {
        cwd,
        env: supervisorEnv,
      });
    },

    async openEthShort(options = {}) {
      return this.openPosition({ asset: 'ETH', direction: 'SHORT', ...options });
    },

    async closeEthPosition(options = {}) {
      return this.closePosition({ asset: 'ETH', ...options });
    },
  };
}

function createLogger(logPath) {
  ensureDir(logPath);
  const createMirrorWriter = (stream) => {
    if (!stream || typeof stream.write !== 'function') {
      return () => {};
    }
    let disabled = false;
    const markBroken = () => {
      disabled = true;
      try { stream.removeListener('error', markBroken); } catch {}
    };
    try {
      stream.on('error', markBroken);
    } catch {
      disabled = true;
    }
    return (line) => {
      if (disabled || !line || stream.destroyed || stream.writable === false) return;
      try {
        stream.write(line, (error) => {
          if (error) markBroken();
        });
      } catch {
        markBroken();
      }
    };
  };
  const writeStdout = createMirrorWriter(process.stdout);
  const writeStderr = createMirrorWriter(process.stderr);
  return {
    info(message) {
      const line = `[${new Date().toISOString()}] [INFO] ${message}\n`;
      writeStdout(line);
      appendFileSafe(logPath, line);
    },
    warn(message) {
      const line = `[${new Date().toISOString()}] [WARN] ${message}\n`;
      writeStderr(line);
      appendFileSafe(logPath, line);
    },
    error(message) {
      const line = `[${new Date().toISOString()}] [ERROR] ${message}\n`;
      writeStderr(line);
      appendFileSafe(logPath, line);
    },
  };
}

function appendSuppressedRepeatCount(message, suppressedCount = 0) {
  const count = Number(suppressedCount || 0);
  if (!Number.isFinite(count) || count <= 0) return String(message || '');
  return `${message} (suppressed ${count} repeat${count === 1 ? '' : 's'})`;
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

function normalizeNewsTicker(value = '') {
  const raw = String(value || '').trim().toUpperCase();
  if (!raw) return '';
  return raw.includes('/') ? raw : `${raw}/USD`;
}

function buildNewsFingerprint(payload = {}) {
  const headlines = Array.isArray(payload.headlines) ? payload.headlines : [];
  const reason = String(payload.reason || '').trim();
  return JSON.stringify({
    level: String(payload.level || '').trim(),
    reason,
    headlines: headlines.slice(0, 5).map((headline) => String(headline || '').trim().toLowerCase()),
  });
}

function tokenizeCaseKeywords(text = '') {
  return Array.from(new Set(
    String(text || '')
      .split(/[(),/|·:\-\u2014]+/)
      .map((entry) => String(entry || '').trim())
      .filter((entry) => entry.length >= 2)
  ));
}

function extractActiveCaseSignals(markdown = '') {
  const source = String(markdown || '');
  if (!source.trim()) return [];
  const headings = Array.from(source.matchAll(/^###\s+Case\s+\d+:\s+(.+)$/gm)).map((match) => String(match[1] || '').trim());
  const signals = headings.map((heading) => {
    const label = heading.replace(/\s+[-—].*$/, '').trim();
    return {
      label,
      keywords: Array.from(new Set([
        ...tokenizeCaseKeywords(label),
        '은별',
        '[private-profile]',
      ])),
    };
  }).filter((entry) => entry.keywords.length > 0);
  return signals;
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
    activeConvictionThesis: null,
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

function defaultNewsScanState() {
  return {
    lastProcessedAt: null,
    lastResult: null,
    nextEvent: null,
    lastScan: null,
    lastAlertFingerprint: null,
    updatedAt: null,
  };
}

function defaultMarketResearchState() {
  return {
    lastProcessedAt: null,
    lastResult: null,
    nextEvent: null,
    lastScan: null,
    lastAlertFingerprint: null,
    updatedAt: null,
  };
}

function default[private-live-ops]State() {
  return {
    lastProcessedAt: null,
    lastResult: null,
    nextEvent: null,
    lastScan: null,
    updatedAt: null,
  };
}

function defaultSparkMonitorState() {
  return {
    lastProcessedAt: null,
    lastResult: null,
    nextEvent: null,
    lastScan: null,
    updatedAt: null,
  };
}

function defaultMarketScannerState() {
  return marketScannerModule.defaultMarketScannerState();
}

function default[private-profile]CheckInState() {
  return {
    lastProcessedAt: null,
    lastResult: null,
    nextEvent: null,
    lastDraft: null,
    lastDraftFingerprint: null,
    updatedAt: null,
  };
}

function defaultTradeReconciliationState() {
  return {
    lastProcessedAt: null,
    lastPendingCount: 0,
    lastResult: null,
    lastError: null,
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

function buildNewsScanDailySchedule(referenceDate = new Date(), options = {}) {
  const intervalMinutes = Math.max(1, Math.floor(Number(options.intervalMinutes) || DEFAULT_NEWS_SCAN_INTERVAL_MINUTES));
  const start = startOfUtcDay(referenceDate);
  const marketDate = start.toISOString().slice(0, 10);
  const schedule = [];

  for (let minuteOfDay = 0; minuteOfDay < (24 * 60); minuteOfDay += intervalMinutes) {
    const scheduledAt = new Date(start.getTime() + (minuteOfDay * 60 * 1000));
    for (const phase of NEWS_SCAN_PHASES) {
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

function getNextNewsScanEvent(referenceDate = new Date(), options = {}) {
  const now = referenceDate instanceof Date ? referenceDate : new Date(referenceDate);
  for (let offset = 0; offset < 3; offset += 1) {
    const candidateDate = new Date(now.getTime() + (offset * 24 * 60 * 60 * 1000));
    const day = buildNewsScanDailySchedule(candidateDate, options);
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

function build[private-live-ops]DailySchedule(referenceDate = new Date(), options = {}) {
  return buildUtcIntervalSchedule(referenceDate, [{ key: '[private-live-ops]_scan', label: 'Token unlock scan' }], options.intervalMinutes || DEFAULT_LIVE_OPS_INTERVAL_MINUTES);
}

function getNext[private-live-ops]Event(referenceDate = new Date(), options = {}) {
  const now = referenceDate instanceof Date ? referenceDate : new Date(referenceDate);
  for (let offset = 0; offset < 3; offset += 1) {
    const candidateDate = new Date(now.getTime() + (offset * 24 * 60 * 60 * 1000));
    const day = build[private-live-ops]DailySchedule(candidateDate, options);
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

function buildSparkMonitorDailySchedule(referenceDate = new Date(), options = {}) {
  return buildUtcIntervalSchedule(referenceDate, [{ key: 'spark_monitor', label: 'Spark monitor scan' }], options.intervalMinutes || DEFAULT_SPARK_MONITOR_INTERVAL_MINUTES);
}

function getNextSparkMonitorEvent(referenceDate = new Date(), options = {}) {
  const now = referenceDate instanceof Date ? referenceDate : new Date(referenceDate);
  for (let offset = 0; offset < 3; offset += 1) {
    const candidateDate = new Date(now.getTime() + (offset * 24 * 60 * 60 * 1000));
    const day = buildSparkMonitorDailySchedule(candidateDate, options);
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

function buildUtcIntervalSchedule(referenceDate = new Date(), phases = [], intervalMinutes = 60) {
  const safeIntervalMinutes = Math.max(1, Math.floor(Number(intervalMinutes) || 60));
  const start = startOfUtcDay(referenceDate);
  const marketDate = start.toISOString().slice(0, 10);
  const schedule = [];

  for (let minuteOfDay = 0; minuteOfDay < (24 * 60); minuteOfDay += safeIntervalMinutes) {
    const scheduledAt = new Date(start.getTime() + (minuteOfDay * 60 * 1000));
    for (const phase of phases) {
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
    intervalMinutes: safeIntervalMinutes,
    displayTimeZone: 'UTC',
    schedule,
  };
}

function getNextUtcIntervalEvent(referenceDate = new Date(), phases = [], intervalMinutes = 60) {
  const now = referenceDate instanceof Date ? referenceDate : new Date(referenceDate);
  for (let offset = 0; offset < 3; offset += 1) {
    const candidateDate = new Date(now.getTime() + (offset * 24 * 60 * 60 * 1000));
    const day = buildUtcIntervalSchedule(candidateDate, phases, intervalMinutes);
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

function parseCaseOperationsDashboard(markdown = '') {
  const lines = String(markdown || '').split(/\r?\n/);
  const pendingItems = [];
  let currentCaseLabel = null;
  let currentSection = null;
  let scheduleDate = null;
  const scheduleItems = [];

  for (const rawLine of lines) {
    const line = String(rawLine || '').trim();
    if (!line) continue;
    const caseMatch = line.match(/^###\s+Case\s+\d+:\s+(.+)$/i);
    if (caseMatch) {
      currentCaseLabel = String(caseMatch[1] || '').trim();
      currentSection = 'case';
      continue;
    }
    const scheduleMatch = line.match(/^##\s+은별\s+내일\s+일정\s+\((\d{4}-\d{2}-\d{2})\)/);
    if (scheduleMatch) {
      scheduleDate = scheduleMatch[1];
      currentSection = 'schedule';
      continue;
    }
    if (/^##\s+/.test(line)) {
      currentSection = null;
      continue;
    }
    if (currentSection === 'schedule' && /^\d+\.\s+/.test(line)) {
      scheduleItems.push(line.replace(/^\d+\.\s+/, '').trim());
      continue;
    }
    if (!line.startsWith('|') || /^\|\s*-+/.test(line) || /^\|\s*#\s*\|/.test(line)) {
      continue;
    }
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 4 || !/^\d+$/.test(cells[0])) continue;
    pendingItems.push({
      id: cells[0],
      item: cells[1],
      blockedOn: cells[2],
      status: cells[3],
      caseLabel: currentCaseLabel,
    });
  }

  return {
    pendingItems,
    scheduleDate,
    scheduleItems,
  };
}

function getLatest[private-profile]MessageTimestamp(rows = []) {
  for (const row of Array.isArray(rows) ? rows : []) {
    const metadata = row && typeof row.metadata === 'object' ? row.metadata : {};
    const rawBody = String(row?.rawBody || row?.body || '');
    const sender = String(metadata.from || row?.sender || '');
    const chatId = String(metadata.chatId || metadata.telegramChatId || row?.chatId || '');
    if (
      chatId === '8754356993'
      || /은별|private-profile/i.test(sender)
      || /은별|private-profile|8754356993/i.test(rawBody)
    ) {
      return Number(row?.sentAtMs || row?.brokeredAtMs || row?.createdAtMs || 0) || 0;
    }
  }
  return 0;
}

function buildMarketResearchDailySchedule(referenceDate = new Date(), options = {}) {
  return buildUtcIntervalSchedule(referenceDate, MARKET_RESEARCH_PHASES, options.intervalMinutes || DEFAULT_MARKET_RESEARCH_INTERVAL_MINUTES);
}

function getNextMarketResearchEvent(referenceDate = new Date(), options = {}) {
  return getNextUtcIntervalEvent(referenceDate, MARKET_RESEARCH_PHASES, options.intervalMinutes || DEFAULT_MARKET_RESEARCH_INTERVAL_MINUTES);
}

function buildMarketScannerDailySchedule(referenceDate = new Date(), options = {}) {
  return buildUtcIntervalSchedule(referenceDate, MARKET_SCANNER_PHASES, options.intervalMinutes || DEFAULT_MARKET_SCANNER_INTERVAL_MINUTES);
}

function getNextMarketScannerEvent(referenceDate = new Date(), options = {}) {
  return getNextUtcIntervalEvent(referenceDate, MARKET_SCANNER_PHASES, options.intervalMinutes || DEFAULT_MARKET_SCANNER_INTERVAL_MINUTES);
}

function build[private-profile]CheckInDailySchedule(referenceDate = new Date(), options = {}) {
  return buildUtcIntervalSchedule(referenceDate, EUNBYEOL_CHECKIN_PHASES, options.intervalMinutes || DEFAULT_EUNBYEOL_CHECKIN_INTERVAL_MINUTES);
}

function getNext[private-profile]CheckInEvent(referenceDate = new Date(), options = {}) {
  return getNextUtcIntervalEvent(referenceDate, EUNBYEOL_CHECKIN_PHASES, options.intervalMinutes || DEFAULT_EUNBYEOL_CHECKIN_INTERVAL_MINUTES);
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
    this.[private-live-ops]ManualActivityPath = options.[private-live-ops]ManualActivityPath || DEFAULT_LIVE_OPS_MANUAL_ACTIVITY_PATH;
    this.hmSendScriptPath = path.resolve(String(options.hmSendScriptPath || resolveProjectUiScriptPath('hm-send.js', this.projectRoot)));
    this.hmSendExternalDisabled = options.hmSendExternalDisabled === true
      || (Boolean(process.env.JEST_WORKER_ID) && !options.hmSendScriptPath);
    this.hmDefiStatusScriptPath = path.resolve(String(options.defiStatusScriptPath || resolveProjectUiScriptPath('hm-defi-status.js', this.projectRoot)));
    this.hmDefiExecuteScriptPath = path.resolve(String(options.defiExecuteScriptPath || resolveProjectUiScriptPath('hm-defi-execute.js', this.projectRoot)));
    this.hmDefiCloseScriptPath = path.resolve(String(options.defiCloseScriptPath || resolveProjectUiScriptPath('hm-defi-close.js', this.projectRoot)));
    this.hmSaylorWatcherScriptPath = path.resolve(String(options.saylorWatcherScriptPath || resolveProjectUiScriptPath('hm-x-watchlist.js', this.projectRoot)));
    this.hm[private-live-ops]SqueezeDetectorScriptPath = path.resolve(String(options.[private-live-ops]SqueezeDetectorScriptPath || resolveProjectUiScriptPath('hm-[private-live-ops]-squeeze-detector.js', this.projectRoot)));
    this.hmOracleWatchEngineScriptPath = path.resolve(String(options.oracleWatchEngineScriptPath || resolveProjectUiScriptPath('hm-oracle-watch-engine.js', this.projectRoot)));
    this.hm[private-live-ops]UnlocksScriptPath = path.resolve(String(options.[private-live-ops]UnlocksScriptPath || resolveProjectUiScriptPath('hm-[private-live-ops]-unlocks.js', this.projectRoot)));
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
    this.dynamicWatchlistStatePath = options.dynamicWatchlistStatePath || resolveRuntimePath('dynamic-watchlist-state.json');
    this.agentTaskQueueEnabled = options.agentTaskQueueEnabled !== false;
    this.agentTaskQueuePath = options.agentTaskQueuePath || DEFAULT_AGENT_TASK_QUEUE_PATH;
    this.agentTaskIdleCompletionMs = Math.max(
      10_000,
      Number.parseInt(options.agentTaskIdleCompletionMs || DEFAULT_AGENT_TASK_IDLE_COMPLETION_MS, 10)
      || DEFAULT_AGENT_TASK_IDLE_COMPLETION_MS
    );
    this.agentTaskReadyGraceMs = Math.max(
      this.agentTaskIdleCompletionMs,
      Number.parseInt(options.agentTaskReadyGraceMs || DEFAULT_AGENT_TASK_READY_GRACE_MS, 10)
      || DEFAULT_AGENT_TASK_READY_GRACE_MS
    );
    this.agentTaskHistoryLimit = Math.max(
      10,
      Number.parseInt(options.agentTaskHistoryLimit || DEFAULT_AGENT_TASK_HISTORY_LIMIT, 10)
      || DEFAULT_AGENT_TASK_HISTORY_LIMIT
    );
    this.agentTaskReengageIdleMs = Math.max(
      60_000,
      Number.parseInt(options.agentTaskReengageIdleMs || DEFAULT_AGENT_TASK_REENGAGE_IDLE_MS, 10)
      || DEFAULT_AGENT_TASK_REENGAGE_IDLE_MS
    );
    this.lastAgentTaskQueueSummary = this.agentTaskQueueEnabled
      ? {
        enabled: true,
        path: this.agentTaskQueuePath,
        dispatched: 0,
        completed: 0,
        pending: {
          architect: 0,
          builder: 0,
          oracle: 0,
        },
        active: {
          architect: null,
          builder: null,
          oracle: null,
        },
      }
      : {
        enabled: false,
        path: this.agentTaskQueuePath,
        status: 'disabled',
      };
    this.workerLeaseOwnerPrefix = String(options.workerLeaseOwnerPrefix || 'supervisor');
    this.logger = options.logger || createLogger(this.logPath);
    this.rateLimitedLogState = new Map();
    this.supervisorRepeatLogMs = Math.max(
      60_000,
      Number.parseInt(options.supervisorRepeatLogMs || DEFAULT_SUPERVISOR_REPEAT_LOG_MS, 10)
      || DEFAULT_SUPERVISOR_REPEAT_LOG_MS
    );
    this.memoryIndexRepeatLogMs = Math.max(
      60_000,
      Number.parseInt(options.memoryIndexRepeatLogMs || DEFAULT_MEMORY_INDEX_REPEAT_LOG_MS, 10)
      || DEFAULT_MEMORY_INDEX_REPEAT_LOG_MS
    );
    this.memoryConsistencyRepeatLogMs = Math.max(
      60_000,
      Number.parseInt(options.memoryConsistencyRepeatLogMs || DEFAULT_MEMORY_CONSISTENCY_REPEAT_LOG_MS, 10)
      || DEFAULT_MEMORY_CONSISTENCY_REPEAT_LOG_MS
    );
    this.activeWorkers = new Map();
    this.runtimeEnv = options.env || process.env;
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
    // Previously hardcoded to true → produced manualOnly=true, [private-live-ops]Execution.enabled=false,
    // approvedTrades=0, convictionSelection=null cascade because consensus + execution phases
    // all gate on !manualTradingOnly. Now env-gated: set SQUIDRUN_MANUAL_TRADING=0 to allow
    // the automation phases to run. Default stays true for safety.
    this.manualTradingOnly = options.manualTradingOnly === false
      || String(this.runtimeEnv.SQUIDRUN_MANUAL_TRADING || '').trim() === '0'
      ? false
      : true;
    this.[private-live-ops]ScalpModeArmed = options.[private-live-ops]ScalpModeArmed === true
      || this.runtimeEnv.SQUIDRUN_LIVE_OPS_SCALP_MODE === '1';
    const stockTradingAutomationRequested = options.tradingEnabled === true
      || this.runtimeEnv.SQUIDRUN_ENABLE_STOCK_TRADING_AUTOMATION === '1';
    this.tradingEnabled = Boolean(
      stockTradingAutomationRequested
      && this.runtimeEnv.SQUIDRUN_TRADING_AUTOMATION !== '0'
    );
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
        reason: stockTradingAutomationRequested ? 'manual_opt_out' : 'manual_opt_in_required',
        marketDate: null,
        sleeping: true,
        nextEvent: null,
      };
    this.tradingOrchestrator = this.tradingEnabled
      ? (options.tradingOrchestrator || tradingOrchestrator.createOrchestrator({
        journalPath: resolveRuntimePath('trade-journal.db'),
      }))
      : null;
    this.tradeReconciliationPollMs = Math.max(
      60_000,
      Number.parseInt(
        options.tradeReconciliationPollMs || DEFAULT_TRADE_RECONCILIATION_POLL_MS,
        10
      ) || DEFAULT_TRADE_RECONCILIATION_POLL_MS
    );
    this.tradeReconciliationPromise = null;
    this.tradeReconciliationState = defaultTradeReconciliationState();
    this.lastTradeReconciliationSummary = {
      enabled: Boolean(this.tradingOrchestrator),
      status: this.tradingOrchestrator ? 'idle' : 'disabled',
      marketDate: this.tradingState.marketDate || null,
      pendingCount: 0,
      lastProcessedAt: null,
      lastResult: null,
      lastError: null,
    };
    this.saylorWatcherEnabled = options.saylorWatcherEnabled !== false
      && this.runtimeEnv.SQUIDRUN_SAYLOR_WATCHER !== '0';
    this.saylorWatcherIntervalMs = Math.max(
      60_000,
      Number.parseInt(options.saylorWatcherIntervalMs || DEFAULT_SAYLOR_WATCHER_INTERVAL_MS, 10)
      || DEFAULT_SAYLOR_WATCHER_INTERVAL_MS
    );
    this.lastSaylorWatcherRunAtMs = 0;
    this.saylorWatcherPromise = null;
    this.lastSaylorWatcherSummary = this.saylorWatcherEnabled
      ? {
        enabled: true,
        status: 'idle',
        intervalMs: this.saylorWatcherIntervalMs,
        lastRunAt: null,
        lastSummary: null,
      }
      : {
        enabled: false,
        status: 'disabled',
        intervalMs: this.saylorWatcherIntervalMs,
        lastRunAt: null,
        lastSummary: null,
      };
    this.[private-live-ops]SqueezeDetectorEnabled = options.[private-live-ops]SqueezeDetectorEnabled !== false
      && this.runtimeEnv.SQUIDRUN_LIVE_OPS_SQUEEZE_DETECTOR !== '0';
    this.[private-live-ops]SqueezeDetectorIntervalMs = Math.max(
      30_000,
      Number.parseInt(
        options.[private-live-ops]SqueezeDetectorIntervalMs || DEFAULT_LIVE_OPS_SQUEEZE_DETECTOR_INTERVAL_MS,
        10
      ) || DEFAULT_LIVE_OPS_SQUEEZE_DETECTOR_INTERVAL_MS
    );
    this.last[private-live-ops]SqueezeDetectorRunAtMs = 0;
    this.[private-live-ops]SqueezeDetectorPromise = null;
    this.last[private-live-ops]SqueezeDetectorSummary = this.[private-live-ops]SqueezeDetectorEnabled
      ? {
        enabled: true,
        status: 'idle',
        intervalMs: this.[private-live-ops]SqueezeDetectorIntervalMs,
        lastRunAt: null,
        lastSummary: null,
      }
      : {
        enabled: false,
        status: 'disabled',
        intervalMs: this.[private-live-ops]SqueezeDetectorIntervalMs,
        lastRunAt: null,
        lastSummary: null,
      };
    this.oracleWatchRulesPath = path.resolve(String(options.oracleWatchRulesPath || DEFAULT_ORACLE_WATCH_RULES_PATH));
    this.oracleWatchStatePath = path.resolve(String(options.oracleWatchStatePath || DEFAULT_ORACLE_WATCH_STATE_PATH));
    this.oracleShortRegimeStatePath = path.resolve(String(
      options.oracleShortRegimeStatePath || oracleWatchRegime.DEFAULT_SHARED_SHORT_REGIME_STATE_PATH
    ));
    this.oracleWatchEnabled = options.oracleWatchEnabled !== false
      && readProjectWatcherEnabled(this.projectRoot, true)
      && this.runtimeEnv.SQUIDRUN_ORACLE_WATCH !== '0';
    this.oracleWatchIntervalMs = resolveOracleWatchIntervalMs(this.oracleWatchRulesPath);
    this.lastOracleWatchRunAtMs = 0;
    this.lastOracleWatchRelaunchAtMs = 0;
    this.oracleWatchRelaunchCooldownMs = Math.max(
      DEFAULT_ORACLE_WATCH_RELAUNCH_COOLDOWN_MS,
      Number.parseInt(options.oracleWatchRelaunchCooldownMs || DEFAULT_ORACLE_WATCH_RELAUNCH_COOLDOWN_MS, 10)
      || DEFAULT_ORACLE_WATCH_RELAUNCH_COOLDOWN_MS
    );
    this.oracleWatchPromise = null;
    this.oracleWatchStaleAlertActive = false;
    this.lastOracleWatchSummary = this.oracleWatchEnabled
      ? {
        enabled: true,
        status: 'idle',
        intervalMs: this.oracleWatchIntervalMs,
        rulesPath: this.oracleWatchRulesPath,
        statePath: this.oracleWatchStatePath,
        lastRunAt: null,
        lastSummary: null,
      }
      : {
        enabled: false,
        status: 'disabled',
        intervalMs: this.oracleWatchIntervalMs,
        rulesPath: this.oracleWatchRulesPath,
        statePath: this.oracleWatchStatePath,
        lastRunAt: null,
        lastSummary: null,
      };
    this.cryptoTradingEnabled = options.cryptoTradingEnabled !== false
      && process.env.SQUIDRUN_CRYPTO_TRADING_AUTOMATION !== '0';
    this.cryptoMonitorOnly = options.cryptoMonitorOnly === true
      || this.runtimeEnv.SQUIDRUN_CRYPTO_MONITOR_ONLY === '1';
    this.cryptoTradingStatePath = options.cryptoTradingStatePath || DEFAULT_CRYPTO_TRADING_STATE_PATH;
    this.cryptoTradingState = {
      ...defaultCryptoTradingState(),
      ...(readJsonFile(this.cryptoTradingStatePath, defaultCryptoTradingState()) || {}),
    };
    this.cryptoTradingStrategyMode = String(
      options.cryptoTradingStrategyMode
      || this.runtimeEnv.SQUIDRUN_CRYPTO_TRADING_STRATEGY_MODE
      || DEFAULT_CRYPTO_TRADING_STRATEGY_MODE
    ).trim().toLowerCase() || DEFAULT_CRYPTO_TRADING_STRATEGY_MODE;
    this.rangeConvictionIntervalMs = Math.max(
      60_000,
      Number.parseInt(options.rangeConvictionIntervalMs || DEFAULT_RANGE_CONVICTION_INTERVAL_MS, 10) || DEFAULT_RANGE_CONVICTION_INTERVAL_MS
    );
    this.lastRangeConvictionRunAt = 0;
    this.lastRangeConvictionSelection = null;
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
        strategyMode: this.cryptoTradingStrategyMode,
      }))
      : null;
    const [private-live-ops]Configured = Boolean(options.[private-live-ops]Executor) || has[private-live-ops]Credentials(this.runtimeEnv);
    this.[private-live-ops]MonitorPollMs = Math.max(
      60_000,
      Number.parseInt(options.[private-live-ops]MonitorPollMs || DEFAULT_LIVE_OPS_MONITOR_POLL_MS, 10) || DEFAULT_LIVE_OPS_MONITOR_POLL_MS
    );
    this.[private-live-ops]MonitorEnabled = options.[private-live-ops]MonitorEnabled !== false && [private-live-ops]Configured;
    this.[private-live-ops]MonitorTimer = null;
    this.[private-live-ops]MonitorPromise = null;
    this.defiPeakPnlPath = options.defiPeakPnlPath || DEFAULT_DEFI_PEAK_PNL_PATH;
    this.[private-live-ops]MonitorOrchestrator = this.[private-live-ops]MonitorEnabled
      ? (options.[private-live-ops]MonitorOrchestrator || tradingOrchestrator.createOrchestrator({
        defiMonitorAutoStart: false,
        defiPeakPnlPath: this.defiPeakPnlPath,
        defiStatusScriptPath: this.hmDefiStatusScriptPath,
      }))
      : null;
    this.last[private-live-ops]MonitorSummary = this.[private-live-ops]MonitorEnabled
      ? {
        enabled: true,
        status: 'idle',
        pollMs: this.[private-live-ops]MonitorPollMs,
        checkedAt: null,
        warnings: [],
        telegramAlerts: [],
      }
      : {
        enabled: false,
        status: [private-live-ops]Configured ? 'manual_opt_out' : 'credentials_unavailable',
        pollMs: this.[private-live-ops]MonitorPollMs,
        checkedAt: null,
        warnings: [],
        telegramAlerts: [],
      };
    this.positionAttributionStatePath = options.positionAttributionStatePath
      || agentPositionAttribution.DEFAULT_POSITION_ATTRIBUTION_STATE_PATH;
    this.positionAttributionSnapshotProvider = typeof options.positionAttributionSnapshotProvider === 'function'
      ? options.positionAttributionSnapshotProvider
      : null;
    const positionAttributionReconciliationRequested = options.positionAttributionReconciliationEnabled === true
      || (options.positionAttributionReconciliationEnabled !== false && !process.env.JEST_WORKER_ID);
    this.positionAttributionReconciliationEnabled = positionAttributionReconciliationRequested
      && (Boolean(resolve[private-live-ops]WalletAddress(this.runtimeEnv)) || Boolean(this.positionAttributionSnapshotProvider));
    this.lastPositionAttributionReconciliationSummary = this.positionAttributionReconciliationEnabled
      ? {
        enabled: true,
        status: 'idle',
        statePath: this.positionAttributionStatePath,
        checkedAt: null,
        liveCount: 0,
        updatedCount: 0,
        createdCount: 0,
        quarantinedCount: 0,
      }
      : {
        enabled: false,
        status: resolve[private-live-ops]WalletAddress(this.runtimeEnv) ? 'manual_opt_out' : 'wallet_unavailable',
        statePath: this.positionAttributionStatePath,
        checkedAt: null,
        liveCount: 0,
        updatedCount: 0,
        createdCount: 0,
        quarantinedCount: 0,
      };
    const [private-live-ops]AutomationRequested = options.[private-live-ops]ExecutionEnabled !== false
      && this.runtimeEnv.SQUIDRUN_LIVE_OPS_AUTOMATION !== '0';
    this.[private-live-ops]ExecutionEnabled = Boolean(this.cryptoTradingEnabled && [private-live-ops]AutomationRequested && [private-live-ops]Configured);
    this.[private-live-ops]ExecutionDryRun = options.[private-live-ops]ExecutionDryRun === true
      || this.runtimeEnv.SQUIDRUN_LIVE_OPS_DRY_RUN === '1';
    this.[private-live-ops]ExecutionLeverage = Math.max(
      1,
      Number.parseInt(
        options.[private-live-ops]ExecutionLeverage
        || this.runtimeEnv.SQUIDRUN_LIVE_OPS_DEFAULT_LEVERAGE
        || (this.[private-live-ops]ScalpModeArmed ? '20' : '5'),
        10
      ) || (this.[private-live-ops]ScalpModeArmed ? 20 : 5)
    );
    this.[private-live-ops]KillSwitchAction = normalize[private-live-ops]KillSwitchAction(
      options.[private-live-ops]KillSwitchAction || this.runtimeEnv.SQUIDRUN_LIVE_OPS_KILL_SWITCH_ACTION,
      'block_new_entries'
    );
    this.[private-live-ops]Executor = this.[private-live-ops]ExecutionEnabled
      ? (options.[private-live-ops]Executor || create[private-live-ops]Executor({
        env: this.runtimeEnv,
        cwd: this.projectRoot,
        dryRun: this.[private-live-ops]ExecutionDryRun,
        defiExecuteScriptPath: this.hmDefiExecuteScriptPath,
        defiCloseScriptPath: this.hmDefiCloseScriptPath,
      }))
      : null;
    this.last[private-live-ops]ExecutionSummary = (this.manualTradingOnly && !this.[private-live-ops]ScalpModeArmed)
      ? {
        enabled: false,
        status: 'manual_only',
        dryRun: this.[private-live-ops]ExecutionDryRun,
        reason: 'manual_only_reset',
        accountValue: null,
        position: null,
        action: null,
        executedAt: null,
      }
      : this.[private-live-ops]ExecutionEnabled
        ? {
          enabled: true,
          status: 'idle',
          armed: this.[private-live-ops]ScalpModeArmed,
          dryRun: this.[private-live-ops]ExecutionDryRun,
          accountValue: null,
          position: null,
          action: null,
          reason: null,
          executedAt: null,
        }
        : {
          enabled: false,
          status: 'disabled',
          dryRun: this.[private-live-ops]ExecutionDryRun,
          reason: [private-live-ops]Configured ? 'manual_opt_out' : 'credentials_unavailable',
          accountValue: null,
          position: null,
          action: null,
          executedAt: null,
        };
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
    // Circuit breaker DISABLED — was monitoring stale PaperBroker positions and spamming
    // the user's Telegram with ghost ETH SHORT alerts for 3+ days. [private-live-ops] has its own
    // position monitor. — Session 268
    this.circuitBreaker = false && this.tradingEnabled && options.circuitBreaker !== null
      ? (options.circuitBreaker || new CircuitBreaker({
        pollMs: 30_000,
        hardStopPct: 0.04,   // 4% loss from entry
        trailingStopPct: 0.04, // 4% drop from high-water mark
        flashCrashPct: 0.05,  // 5% portfolio drop → sell all
        minPositionValueUsd: 10,
        cooldownMs: 5 * 60_000,
        statePath: resolveRuntimePath('circuit-breaker-state.json'),
        logger: this.logger,
        getPositions: async () => executor.getOpenPositions(),
        getSnapshots: async (symbols) => dataIngestion.getWatchlistSnapshots({ symbols }),
        executeSell: async (ticker, shares, reason) => {
          const assetClass = tradingWatchlist.getAssetClassForTicker(ticker, 'us_equity');
          this.logger.warn(`[circuit-breaker] Executing emergency SELL: ${ticker} x${shares} — ${reason}`);
          try {
            const result = await executor.submitOrder({
              ticker,
              direction: 'SELL',
              shares,
              assetClass,
              orderType: 'market',
              ...(assetClass === 'crypto' ? { timeInForce: 'gtc' } : {}),
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

    this.newsScanEnabled = options.newsScanEnabled !== false
      && process.env.SQUIDRUN_NEWS_SCAN_AUTOMATION !== '0';
    this.newsScanIntervalMinutes = Math.max(
      15,
      Math.floor(Number(options.newsScanIntervalMinutes) || DEFAULT_NEWS_SCAN_INTERVAL_MINUTES)
    );
    this.caseOperationsPath = options.caseOperationsPath || path.join(this.projectRoot, 'workspace', 'knowledge', 'case-operations.md');
    this.newsScanStatePath = options.newsScanStatePath || DEFAULT_NEWS_SCAN_STATE_PATH;
    this.newsScanState = {
      ...defaultNewsScanState(),
      ...(readJsonFile(this.newsScanStatePath, defaultNewsScanState()) || {}),
    };
    this.newsScanPhasePromise = null;
    this.lastNewsScanSummary = this.newsScanEnabled
      ? {
        enabled: true,
        status: 'idle',
        intervalMinutes: this.newsScanIntervalMinutes,
        lastProcessedAt: this.newsScanState.lastProcessedAt || null,
        nextEvent: this.newsScanState.nextEvent || null,
      }
      : {
        enabled: false,
        status: 'disabled',
        intervalMinutes: this.newsScanIntervalMinutes,
        lastProcessedAt: null,
        nextEvent: null,
      };
    this.newsVetoModule = options.newsVetoModule || eventVeto;
    this.newsScanOpenPositionProvider = options.newsScanOpenPositionProvider || (async () => {
      const state = await this.[private-live-ops]Executor?.getAccountState?.().catch(() => null);
      return Array.isArray(state?.positions) ? state.positions : [];
    });
    this.marketResearchEnabled = options.marketResearchEnabled !== false
      && process.env.SQUIDRUN_MARKET_RESEARCH_AUTOMATION !== '0';
    this.marketResearchIntervalMinutes = Math.max(
      30,
      Math.floor(Number(options.marketResearchIntervalMinutes) || DEFAULT_MARKET_RESEARCH_INTERVAL_MINUTES)
    );
    this.marketResearchStatePath = options.marketResearchStatePath || DEFAULT_MARKET_RESEARCH_STATE_PATH;
    this.marketResearchState = {
      ...defaultMarketResearchState(),
      ...(readJsonFile(this.marketResearchStatePath, defaultMarketResearchState()) || {}),
    };
    this.marketResearchPhasePromise = null;
    this.lastMarketResearchSummary = this.marketResearchEnabled
      ? {
        enabled: true,
        status: 'idle',
        intervalMinutes: this.marketResearchIntervalMinutes,
        lastProcessedAt: this.marketResearchState.lastProcessedAt || null,
        nextEvent: this.marketResearchState.nextEvent || null,
      }
      : {
        enabled: false,
        status: 'disabled',
        intervalMinutes: this.marketResearchIntervalMinutes,
        lastProcessedAt: null,
        nextEvent: null,
      };
    this.[private-live-ops]Enabled = options.[private-live-ops]Enabled === true
      || (
        options.[private-live-ops]Enabled !== false
        && RUNNING_SUPERVISOR_MAIN
        && process.env.SQUIDRUN_LIVE_OPS_AUTOMATION !== '0'
      );
    this.[private-live-ops]IntervalMinutes = Math.max(
      60,
      Math.floor(Number(options.[private-live-ops]IntervalMinutes) || DEFAULT_LIVE_OPS_INTERVAL_MINUTES)
    );
    this.[private-live-ops]StatePath = options.[private-live-ops]StatePath || DEFAULT_LIVE_OPS_STATE_PATH;
    this.[private-live-ops]State = {
      ...default[private-live-ops]State(),
      ...(readJsonFile(this.[private-live-ops]StatePath, default[private-live-ops]State()) || {}),
    };
    this.[private-live-ops]PhasePromise = null;
    this.last[private-live-ops]Summary = this.[private-live-ops]Enabled
      ? {
        enabled: true,
        status: 'idle',
        intervalMinutes: this.[private-live-ops]IntervalMinutes,
        lastProcessedAt: this.[private-live-ops]State.lastProcessedAt || null,
        nextEvent: this.[private-live-ops]State.nextEvent || null,
      }
      : {
        enabled: false,
        status: 'disabled',
        intervalMinutes: this.[private-live-ops]IntervalMinutes,
        lastProcessedAt: null,
        nextEvent: null,
      };
    this.sparkMonitorEnabled = options.sparkMonitorEnabled === true
      || (
        options.sparkMonitorEnabled !== false
        && RUNNING_SUPERVISOR_MAIN
        && process.env.SQUIDRUN_SPARK_MONITOR_AUTOMATION !== '0'
      );
    this.sparkMonitorIntervalMinutes = Math.max(
      1,
      Math.floor(Number(options.sparkMonitorIntervalMinutes) || DEFAULT_SPARK_MONITOR_INTERVAL_MINUTES)
    );
    this.sparkMonitorStatePath = options.sparkMonitorStatePath || DEFAULT_SPARK_MONITOR_STATE_PATH;
    this.sparkMonitorState = {
      ...defaultSparkMonitorState(),
      ...(readJsonFile(this.sparkMonitorStatePath, defaultSparkMonitorState()) || {}),
    };
    this.sparkMonitorDataStatePath = options.sparkMonitorDataStatePath || sparkCapture.DEFAULT_SPARK_STATE_PATH;
    this.sparkMonitorEventsPath = options.sparkMonitorEventsPath || sparkCapture.DEFAULT_SPARK_EVENTS_PATH;
    this.sparkMonitorFirePlansPath = options.sparkMonitorFirePlansPath || sparkCapture.DEFAULT_SPARK_FIREPLANS_PATH;
    this.sparkMonitorWatchlistPath = options.sparkMonitorWatchlistPath || sparkCapture.DEFAULT_SPARK_WATCHLIST_PATH;
    this.sparkMonitorPhasePromise = null;
    this.lastSparkMonitorSummary = this.sparkMonitorEnabled
      ? {
        enabled: true,
        status: 'idle',
        intervalMinutes: this.sparkMonitorIntervalMinutes,
        lastProcessedAt: this.sparkMonitorState.lastProcessedAt || null,
        nextEvent: this.sparkMonitorState.nextEvent || null,
      }
      : {
        enabled: false,
        status: 'disabled',
        intervalMinutes: this.sparkMonitorIntervalMinutes,
        lastProcessedAt: null,
        nextEvent: null,
      };
    this.marketScannerEnabled = options.marketScannerEnabled !== false
      && process.env.SQUIDRUN_MARKET_SCANNER_AUTOMATION !== '0';
    this.marketScannerImmediateConsultationEnabled = options.marketScannerImmediateConsultationEnabled === true
      || process.env.SQUIDRUN_MARKET_SCANNER_IMMEDIATE_CONSULTATION === '1';
    this.marketScannerIntervalMinutes = Math.max(
      30,
      Math.floor(Number(options.marketScannerIntervalMinutes) || DEFAULT_MARKET_SCANNER_INTERVAL_MINUTES)
    );
    this.marketScannerConsultationSymbolLimit = Math.max(
      1,
      Math.floor(Number(options.marketScannerConsultationSymbolLimit) || DEFAULT_MARKET_SCANNER_CONSULTATION_SYMBOL_LIMIT)
    );
    this.cryptoConsultationSymbolMax = Math.max(
      this.marketScannerConsultationSymbolLimit,
      Math.floor(Number(options.cryptoConsultationSymbolMax) || DEFAULT_CRYPTO_CONSULTATION_SYMBOL_MAX)
    );
    this.marketScannerStatePath = options.marketScannerStatePath || DEFAULT_MARKET_SCANNER_STATE_PATH;
    this.marketScannerState = marketScannerModule.normalizeMarketScannerState({
      ...defaultMarketScannerState(),
      ...(readJsonFile(this.marketScannerStatePath, defaultMarketScannerState()) || {}),
    });
    this.marketScanner = options.marketScanner || marketScannerModule;
    this.marketScannerAlertGate = typeof options.marketScannerAlertGate === 'function'
      ? options.marketScannerAlertGate
      : null;
    this.marketScannerPhasePromise = null;
    this.marketScannerLastTrigger = null;
    this.lastMarketScannerSummary = this.marketScannerEnabled
      ? {
        enabled: true,
        status: 'idle',
        intervalMinutes: this.marketScannerIntervalMinutes,
        lastProcessedAt: this.marketScannerState.lastProcessedAt || null,
        nextEvent: this.marketScannerState.nextEvent || null,
      }
      : {
        enabled: false,
        status: 'disabled',
        intervalMinutes: this.marketScannerIntervalMinutes,
        lastProcessedAt: null,
        nextEvent: null,
      };
    this.lastCryptoCoverage = {
      basketBuiltAt: null,
      openPositionSymbols: [],
      coreSymbols: [],
      moverSymbols: [],
      promotedSymbols: [],
      symbolsConsulted: [],
      symbolsExecutable: [],
    };
    this.private-profileCheckInEnabled = options.private-profileCheckInEnabled !== false
      && process.env.SQUIDRUN_EUNBYEOL_CHECKIN_AUTOMATION !== '0';
    this.private-profileCheckInIntervalMinutes = Math.max(
      30,
      Math.floor(Number(options.private-profileCheckInIntervalMinutes) || DEFAULT_EUNBYEOL_CHECKIN_INTERVAL_MINUTES)
    );
    this.private-profileCheckInSilenceMs = Math.max(
      60_000,
      Number.parseInt(options.private-profileCheckInSilenceMs || `${DEFAULT_EUNBYEOL_CHECKIN_SILENCE_MS}`, 10) || DEFAULT_EUNBYEOL_CHECKIN_SILENCE_MS
    );
    this.private-profileCheckInStatePath = options.private-profileCheckInStatePath || DEFAULT_EUNBYEOL_CHECKIN_STATE_PATH;
    this.private-profileCheckInState = {
      ...default[private-profile]CheckInState(),
      ...(readJsonFile(this.private-profileCheckInStatePath, default[private-profile]CheckInState()) || {}),
    };
    this.private-profileCheckInPhasePromise = null;
    this.last[private-profile]CheckInSummary = this.private-profileCheckInEnabled
      ? {
        enabled: true,
        status: 'idle',
        intervalMinutes: this.private-profileCheckInIntervalMinutes,
        lastProcessedAt: this.private-profileCheckInState.lastProcessedAt || null,
        nextEvent: this.private-profileCheckInState.nextEvent || null,
      }
      : {
        enabled: false,
        status: 'disabled',
        intervalMinutes: this.private-profileCheckInIntervalMinutes,
        lastProcessedAt: null,
        nextEvent: null,
      };
    this.proactiveCommsProvider = options.proactiveCommsProvider || (() => queryCommsJournalEntries({
      order: 'desc',
      limit: 200,
    }));
    this.marketResearchOpenPositionProvider = options.marketResearchOpenPositionProvider || this.newsScanOpenPositionProvider;
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

  emitRateLimitedLog({
    key,
    level = 'warn',
    message,
    state = '',
    intervalMs = this.supervisorRepeatLogMs,
    nowMs = Date.now(),
  } = {}) {
    const resolvedKey = String(key || message || '').trim();
    const resolvedMessage = String(message || '').trim();
    if (!resolvedKey || !resolvedMessage) return false;
    const resolvedLevel = ['info', 'warn', 'error'].includes(level) ? level : 'warn';
    const resolvedState = String(state || resolvedMessage);
    const resolvedIntervalMs = Math.max(60_000, Number(intervalMs || this.supervisorRepeatLogMs) || this.supervisorRepeatLogMs);
    const previous = this.rateLimitedLogState.get(resolvedKey);
    const stateChanged = !previous || previous.state !== resolvedState;
    const intervalElapsed = previous && (Number(nowMs || Date.now()) - Number(previous.lastEmittedAtMs || 0)) >= resolvedIntervalMs;
    if (stateChanged || intervalElapsed) {
      const suppressedCount = previous && !stateChanged ? Number(previous.suppressed || 0) : 0;
      this.logger[resolvedLevel](appendSuppressedRepeatCount(resolvedMessage, suppressedCount));
      this.rateLimitedLogState.set(resolvedKey, {
        state: resolvedState,
        lastEmittedAtMs: Number(nowMs || Date.now()),
        suppressed: 0,
      });
      return true;
    }
    previous.suppressed = Number(previous.suppressed || 0) + 1;
    this.rateLimitedLogState.set(resolvedKey, previous);
    return false;
  }

  emitMemoryConsistencyLog(reason, message, synced, nowMs = Date.now()) {
    const normalizedReason = String(reason || '').trim().toLowerCase();
    const level = synced ? 'info' : 'warn';
    if (normalizedReason === 'startup') {
      this.logger[level](message);
      return true;
    }
    const summary = this.lastMemoryConsistencySummary || {};
    const counts = summary.summary || {};
    const state = [
      summary.status || 'unknown',
      counts.knowledgeEntryCount || 0,
      counts.knowledgeNodeCount || 0,
      counts.missingInCognitiveCount || 0,
      counts.orphanedNodeCount || 0,
      counts.duplicateKnowledgeHashCount || 0,
    ].join(':');
    return this.emitRateLimitedLog({
      key: 'memory-consistency',
      level,
      message,
      state,
      intervalMs: this.memoryConsistencyRepeatLogMs,
      nowMs,
    });
  }

  emitMemoryIndexRefreshLog(reason, result, nowMs = Date.now()) {
    const indexedGroups = Number(result?.indexedGroups || 0);
    const skippedGroups = Number(result?.skippedGroups || 0);
    const documentCount = Number(result?.status?.document_count || 0);
    const message = `Memory index refresh (${reason}) complete: `
      + `groups=${indexedGroups} skipped=${skippedGroups} docs=${documentCount}`;
    const state = `${indexedGroups}:${skippedGroups}:${documentCount}`;
    return this.emitRateLimitedLog({
      key: 'memory-index-refresh',
      level: 'info',
      message,
      state,
      intervalMs: this.memoryIndexRepeatLogMs,
      nowMs,
    });
  }

  executeHmSendSync(args = [], reason = 'hm_send', options = {}) {
    if (this.hmSendExternalDisabled) {
      this.emitRateLimitedLog({
        key: 'hm-send-external-disabled',
        level: 'info',
        message: `hm-send suppressed during ${reason}: ${Array.isArray(args) ? args[0] || 'unknown' : 'unknown'}`,
        state: String(reason || 'hm_send'),
      });
      return { ok: false, skipped: true, reason: 'hm_send_external_disabled' };
    }
    execFileSync(process.execPath, [this.hmSendScriptPath, ...args], {
      cwd: options.cwd || this.projectRoot,
      env: options.env || this.runtimeEnv,
      timeout: options.timeout || 15000,
      stdio: options.stdio || 'ignore',
      windowsHide: true,
    });
    return { ok: true };
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
        ? `${snapshot?.localModels?.sleepExtraction?.path || 'external'} (${snapshot?.localModels?.sleepExtraction?.model || 'unknown-model'})`
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
    if (this.agentTaskQueueEnabled) {
      this.saveAgentTaskQueueState(this.loadAgentTaskQueueState(Date.now()));
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

    const bootedProfile = String(process.env.SQUIDRUN_PROFILE || 'unset').toLowerCase() || 'unset';
    this.logger.info(`Supervisor daemon started (pid=${process.pid}, profile=${bootedProfile}, db=${this.store.dbPath})`);
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
    this.start[private-live-ops]PositionMonitor();
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
    await this.stop[private-live-ops]PositionMonitor();
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

  loadAgentTaskQueueState(nowMs = Date.now()) {
    const fallback = normalizeAgentTaskQueueState(null, {
      nowMs,
      historyLimit: this.agentTaskHistoryLimit,
    });
    if (!this.agentTaskQueueEnabled) {
      return fallback;
    }
    return normalizeAgentTaskQueueState(readJsonFile(this.agentTaskQueuePath, fallback), {
      nowMs,
      historyLimit: this.agentTaskHistoryLimit,
    });
  }

  saveAgentTaskQueueState(state) {
    if (!this.agentTaskQueueEnabled) return;
    const normalized = normalizeAgentTaskQueueState(state, {
      nowMs: Date.now(),
      historyLimit: this.agentTaskHistoryLimit,
    });
    normalized.updatedAt = new Date().toISOString();
    writeJsonFile(this.agentTaskQueuePath, normalized);
  }

  readAgentSessionState() {
    const snapshot = readJsonFile(this.sessionStatePath, {});
    return snapshot && typeof snapshot === 'object' ? snapshot : {};
  }

  getAgentTerminalSnapshot(role, sessionState = null) {
    const paneId = ROLE_ID_MAP[String(role || '').trim().toLowerCase()] || null;
    if (!paneId) return null;
    const state = sessionState && typeof sessionState === 'object' ? sessionState : this.readAgentSessionState();
    const terminals = Array.isArray(state.terminals) ? state.terminals : [];
    const terminal = terminals.find((entry) => String(entry?.paneId || '') === String(paneId));
    return terminal && typeof terminal === 'object' ? terminal : null;
  }

  completeAgentTask(bucket, task, completionReason, terminal, nowMs) {
    if (!bucket || !task) return null;
    const completedTask = {
      ...task,
      status: completionReason === 'timeout' ? 'timeout' : 'completed',
      completionReason,
      completedAtMs: nowMs,
      lastObservedActivityAtMs: toPositiveMs(terminal?.lastActivity, task.lastObservedActivityAtMs || 0),
      lastResult: {
        reason: completionReason,
        paneId: terminal?.paneId || null,
        lastActivity: toPositiveMs(terminal?.lastActivity, 0),
      },
    };
    bucket.active = null;
    bucket.history.push(completedTask);
    if (bucket.history.length > this.agentTaskHistoryLimit) {
      bucket.history = bucket.history.slice(-this.agentTaskHistoryLimit);
    }
    return completedTask;
  }

  evaluateActiveAgentTask(task, terminal, nowMs, pendingCount = 0) {
    if (!task) {
      return { changed: false, completed: false, task: null };
    }

    const nextTask = { ...task };
    const lastDispatchAtMs = toPositiveMs(nextTask.lastDispatchAtMs, 0);
    const terminalLastActivity = toPositiveMs(terminal?.lastActivity, 0);
    const hasPostDispatchActivity = terminalLastActivity > lastDispatchAtMs;
    let changed = false;

    if (hasPostDispatchActivity) {
      if (!nextTask.firstActivityAtMs || terminalLastActivity < nextTask.firstActivityAtMs) {
        nextTask.firstActivityAtMs = terminalLastActivity;
        changed = true;
      }
      if (terminalLastActivity !== toPositiveMs(nextTask.lastObservedActivityAtMs, 0)) {
        nextTask.lastObservedActivityAtMs = terminalLastActivity;
        changed = true;
      }
      if (nextTask.status !== 'running') {
        nextTask.status = 'running';
        changed = true;
      }
    }

    const completionSentinel = nextTask.completionSentinel || null;
    if (completionSentinel && String(terminal?.scrollback || '').includes(completionSentinel)) {
      return {
        changed: true,
        completed: true,
        completionReason: 'sentinel',
        task: nextTask,
      };
    }

    const responseTimeoutMs = toPositiveMs(nextTask.responseTimeoutMs, 0);
    if (!nextTask.firstActivityAtMs && responseTimeoutMs > 0 && lastDispatchAtMs > 0 && (nowMs - lastDispatchAtMs) >= responseTimeoutMs) {
      return {
        changed: true,
        completed: true,
        completionReason: 'timeout',
        task: nextTask,
      };
    }

    const reengageReferenceMs = Math.max(
      toPositiveMs(nextTask.lastObservedActivityAtMs, 0),
      toPositiveMs(nextTask.firstActivityAtMs, 0),
      lastDispatchAtMs
    );
    if (pendingCount > 0 && reengageReferenceMs > 0 && (nowMs - reengageReferenceMs) >= this.agentTaskReengageIdleMs) {
      return {
        changed: true,
        completed: true,
        completionReason: 'reengage_next_task',
        task: nextTask,
      };
    }

    if (nextTask.firstActivityAtMs > 0 && terminalLastActivity > 0) {
      const idleCompletionMs = toPositiveMs(nextTask.idleCompletionMs, this.agentTaskIdleCompletionMs) || this.agentTaskIdleCompletionMs;
      const idleMs = Math.max(0, nowMs - terminalLastActivity);
      const ready = hasReadyPrompt(terminal?.scrollback || '');
      if ((idleMs >= idleCompletionMs && ready) || idleMs >= Math.max(this.agentTaskReadyGraceMs, idleCompletionMs * 2)) {
        return {
          changed: true,
          completed: true,
          completionReason: ready ? 'idle_ready' : 'idle_timeout',
          task: nextTask,
        };
      }
    }

    return {
      changed,
      completed: false,
      task: nextTask,
    };
  }

  async dispatchAgentQueuedTask(role, task) {
    const target = String(role || '').trim().toLowerCase();
    if (!target || !ROLE_ID_MAP[target]) {
      return { ok: false, reason: 'invalid_role' };
    }
    const message = trimOptionalText(task?.message);
    if (!message) {
      return { ok: false, reason: 'invalid_message' };
    }
    ensureDirectory(this.taskLogDir);
    const messagePath = path.join(this.taskLogDir, `hm-msg-${target}-${task.taskId || createAgentTaskId(target)}.txt`);
    fs.writeFileSync(messagePath, `${message}\n`, 'utf8');
    if (this.hmSendExternalDisabled) {
      return { ok: false, skipped: true, reason: 'hm_send_external_disabled', messagePath };
    }
    return executeNodeScript(this.hmSendScriptPath, [target, '--file', messagePath], {
      cwd: this.projectRoot,
      timeoutMs: 20_000,
      env: this.runtimeEnv,
    });
  }

  async maybeRunAgentTaskQueue(nowMs = Date.now()) {
    if (!this.agentTaskQueueEnabled) {
      const disabled = {
        enabled: false,
        path: this.agentTaskQueuePath,
        status: 'disabled',
      };
      this.lastAgentTaskQueueSummary = disabled;
      return disabled;
    }

    const state = this.loadAgentTaskQueueState(nowMs);
    const sessionState = this.readAgentSessionState();
    let changed = false;
    const summary = {
      enabled: true,
      path: this.agentTaskQueuePath,
      status: 'idle',
      dispatched: 0,
      completed: 0,
      reengaged: 0,
      pending: {},
      active: {},
      blocked: [],
      notes: [],
    };

    for (const role of AGENT_TASK_QUEUE_ROLES) {
      const bucket = state.agents[role] || createEmptyAgentQueueBucket();
      const terminal = this.getAgentTerminalSnapshot(role, sessionState);

      if (bucket.active) {
        const evaluation = this.evaluateActiveAgentTask(bucket.active, terminal, nowMs, bucket.pending.length);
        if (evaluation.changed) {
          changed = true;
        }
        if (evaluation.completed) {
          this.completeAgentTask(bucket, evaluation.task, evaluation.completionReason, terminal, nowMs);
          summary.completed += 1;
          if (evaluation.completionReason === 'reengage_next_task') {
            summary.reengaged += 1;
          }
        } else if (evaluation.task) {
          bucket.active = evaluation.task;
        }
      }

      if (!bucket.active && bucket.pending.length > 0) {
        if (!terminal?.alive) {
          summary.blocked.push(role);
        } else {
          const nextTask = bucket.pending.shift();
          const dispatchResult = await this.dispatchAgentQueuedTask(role, nextTask);
          if (dispatchResult?.ok) {
            bucket.active = {
              ...nextTask,
              status: 'dispatched',
              dispatchCount: Math.max(0, Number(nextTask.dispatchCount || 0)) + 1,
              lastDispatchAtMs: nowMs,
              lastError: null,
              lastResult: {
                exitCode: dispatchResult.exitCode,
                status: dispatchResult.status || 'accepted',
              },
            };
            changed = true;
            summary.dispatched += 1;
          } else {
            bucket.pending.unshift({
              ...nextTask,
              lastError: dispatchResult?.error || dispatchResult?.reason || 'dispatch_failed',
            });
            summary.notes.push(`${role}:dispatch_failed`);
          }
        }
      }

      summary.pending[role] = bucket.pending.length;
      summary.active[role] = bucket.active
        ? {
          taskId: bucket.active.taskId,
          title: bucket.active.title || null,
          status: bucket.active.status || 'active',
          lastDispatchAtMs: bucket.active.lastDispatchAtMs || 0,
          firstActivityAtMs: bucket.active.firstActivityAtMs || 0,
        }
        : null;
      state.agents[role] = bucket;
    }

    if (summary.dispatched > 0 || summary.completed > 0) {
      summary.status = 'active';
    } else if (summary.blocked.length > 0) {
      summary.status = 'blocked';
    }

    if (changed) {
      this.saveAgentTaskQueueState(state);
    }

    this.lastAgentTaskQueueSummary = {
      ...summary,
      queue: summarizeAgentTaskQueueState(state),
    };
    return this.lastAgentTaskQueueSummary;
  }

  async tick() {
    if (this.stopping) return;
    const nowMs = Date.now();
    const agentTaskQueue = await this.maybeRunAgentTaskQueue(nowMs);
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
    const positionAttributionReconciliationResult = await this.maybeRunPositionAttributionReconciliation(nowMs);
    const cryptoTradingResult = await this.maybeRunCryptoTradingAutomation(nowMs);
    const tradeReconciliationResult = await this.maybeRunTradeReconciliation(nowMs);
    const newsScanResult = await this.maybeRunNewsScanAutomation(nowMs);
    const marketResearchResult = await this.maybeRunMarketResearchAutomation(nowMs);
    const [private-live-ops]Result = await this.maybeRun[private-live-ops]Automation(nowMs);
    const sparkMonitorResult = await this.maybeRunSparkAutomation(nowMs);
    const marketScannerResult = await this.maybeRunMarketScannerAutomation(nowMs);
    const saylorWatcherResult = await this.maybeRunSaylorWatcher(nowMs);
    const oracleWatchResult = await this.maybeRunOracleWatchEngine(nowMs);
    const [private-live-ops]SqueezeDetectorResult = await this.maybeRun[private-live-ops]SqueezeDetector(nowMs);
    const private-profileCheckInResult = await this.maybeRun[private-profile]CheckInAutomation(nowMs);
    const yieldRouterResult = await this.maybeRunYieldRouterAutomation(nowMs);
    const sleepResult = await this.maybeRunSleepCycle();
    this.writeStatus();
    return {
      ok: true,
      claimedCount,
      activeWorkerCount: this.activeWorkers.size,
      agentTaskQueue,
      queueHousekeeping,
      leaseHousekeeping,
      memoryConsistency,
      tradingResult,
      positionAttributionReconciliationResult,
      tradeReconciliationResult,
      cryptoTradingResult,
      newsScanResult,
      marketResearchResult,
      [private-live-ops]Result,
      sparkMonitorResult,
      marketScannerResult,
      saylorWatcherResult,
      oracleWatchResult,
      [private-live-ops]SqueezeDetectorResult,
      private-profileCheckInResult,
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
        this.emitRateLimitedLog({
          key: 'supervisor-tick-failed',
          level: 'error',
          message: `Supervisor tick failed: ${err.message}`,
          state: err.message,
        });
      });
    }, safeDelayMs);
    if (typeof this.tickTimer.unref === 'function') {
      this.tickTimer.unref();
    }
  }

  computeNextTickDelay(summary = null) {
    const claimedCount = Number(summary?.claimedCount || 0);
    const activeWorkerCount = Number(summary?.activeWorkerCount || 0);
    const agentQueueDispatched = Number(summary?.agentTaskQueue?.dispatched || 0);
    const agentQueueCompleted = Number(summary?.agentTaskQueue?.completed || 0);
    const queueRequeued = Number(summary?.queueHousekeeping?.requeueResult?.requeued || 0);
    const pendingPruned = Number(summary?.queueHousekeeping?.pruneResult?.pruned || 0);
    const leasePruned = Number(summary?.leaseHousekeeping?.pruned || 0);
    const tradingRan = summary?.tradingResult && summary.tradingResult.skipped !== true;
    const positionAttributionReconciliationRan = summary?.positionAttributionReconciliationResult
      && summary.positionAttributionReconciliationResult.skipped !== true;
    const tradeReconciliationRan = summary?.tradeReconciliationResult && summary.tradeReconciliationResult.skipped !== true;
    const cryptoTradingRan = summary?.cryptoTradingResult && summary.cryptoTradingResult.skipped !== true;
    const newsScanRan = summary?.newsScanResult && summary.newsScanResult.skipped !== true;
    const marketResearchRan = summary?.marketResearchResult && summary.marketResearchResult.skipped !== true;
    const saylorWatcherRan = summary?.saylorWatcherResult && summary.saylorWatcherResult.skipped !== true;
    const oracleWatchRan = summary?.oracleWatchResult && summary.oracleWatchResult.skipped !== true;
    const [private-live-ops]SqueezeDetectorRan = summary?.[private-live-ops]SqueezeDetectorResult && summary.[private-live-ops]SqueezeDetectorResult.skipped !== true;
    const private-profileCheckInRan = summary?.private-profileCheckInResult && summary.private-profileCheckInResult.skipped !== true;
    const sleepRan = summary?.sleepResult && summary.sleepResult.skipped !== true;
    const memoryChecked = summary?.memoryConsistency && summary.memoryConsistency.skipped !== true;
    const performedWork = claimedCount > 0
      || agentQueueDispatched > 0
      || agentQueueCompleted > 0
      || queueRequeued > 0
      || pendingPruned > 0
      || leasePruned > 0
      || tradingRan
      || positionAttributionReconciliationRan
      || tradeReconciliationRan
      || cryptoTradingRan
      || newsScanRan
      || marketResearchRan
      || saylorWatcherRan
      || oracleWatchRan
      || [private-live-ops]SqueezeDetectorRan
      || private-profileCheckInRan
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

    let nextDelayMs = this.currentBackoffMs;
    if (this.oracleWatchEnabled) {
      const oracleWatchState = readJsonFile(this.oracleWatchStatePath, {}) || {};
      const heartbeat = buildOracleWatchHeartbeat(this.lastOracleWatchSummary, oracleWatchState);
      if (!this.oracleWatchPromise && heartbeat?.stale === true) {
        this.currentBackoffMs = this.pollMs;
        return this.pollMs;
      }
      if (!this.oracleWatchPromise) {
        const nextOracleWatchDueMs = Math.max(
          0,
          (Number(this.lastOracleWatchRunAtMs || 0) + Number(this.oracleWatchIntervalMs || DEFAULT_ORACLE_WATCH_INTERVAL_MS))
          - Date.now()
        );
        nextDelayMs = Math.min(nextDelayMs, nextOracleWatchDueMs);
      }
    }

    return nextDelayMs;
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

  persistYieldRouterState() {
    this.yieldRouterState.updatedAt = new Date().toISOString();
    writeJsonFile(this.yieldRouterStatePath, this.yieldRouterState);
  }

  persistNewsScanState() {
    this.newsScanState.updatedAt = new Date().toISOString();
    writeJsonFile(this.newsScanStatePath, this.newsScanState);
  }

  persistMarketResearchState() {
    this.marketResearchState.updatedAt = new Date().toISOString();
    writeJsonFile(this.marketResearchStatePath, this.marketResearchState);
  }

  persist[private-live-ops]State() {
    this.[private-live-ops]State.updatedAt = new Date().toISOString();
    writeJsonFile(this.[private-live-ops]StatePath, this.[private-live-ops]State);
  }

  persistSparkMonitorState() {
    this.sparkMonitorState.updatedAt = new Date().toISOString();
    writeJsonFile(this.sparkMonitorStatePath, this.sparkMonitorState);
  }

  persistMarketScannerState() {
    this.marketScannerState = marketScannerModule.normalizeMarketScannerState({
      ...this.marketScannerState,
      updatedAt: new Date().toISOString(),
    });
    writeJsonFile(this.marketScannerStatePath, this.marketScannerState);
  }

  persist[private-profile]CheckInState() {
    this.private-profileCheckInState.updatedAt = new Date().toISOString();
    writeJsonFile(this.private-profileCheckInStatePath, this.private-profileCheckInState);
  }

  readCaseOperationsDashboard() {
    try {
      const markdown = fs.existsSync(this.caseOperationsPath)
        ? fs.readFileSync(this.caseOperationsPath, 'utf8')
        : '';
      return parseCaseOperationsDashboard(markdown);
    } catch {
      return {
        pendingItems: [],
        scheduleDate: null,
        scheduleItems: [],
      };
    }
  }

  readActiveCaseSignals() {
    try {
      const markdown = fs.existsSync(this.caseOperationsPath)
        ? fs.readFileSync(this.caseOperationsPath, 'utf8')
        : '';
      return extractActiveCaseSignals(markdown);
    } catch {
      return [];
    }
  }

  build[private-profile]CheckInDraft(summary = {}) {
    const topItems = Array.isArray(summary.topItems) ? summary.topItems.slice(0, 3) : [];
    const bullets = topItems.map((item) => `- ${item}`).join('\n');
    return [
      '은별님, 진행 중인 항목들 확인차 체크인드립니다.',
      '',
      topItems.length > 0 ? '현재 계속 열려 있는 항목:' : null,
      topItems.length > 0 ? bullets : null,
      '',
      '오늘/내일 진행 상황이나 필요한 자료 있으면 보내주세요. 제가 이어서 바로 정리해둘게요.',
    ].filter((line) => line !== null).join('\n');
  }

  buildNewsScanTelegramAlert(summary = {}) {
    const findings = Array.isArray(summary.findings) ? summary.findings : [];
    const top = findings[0] || {};
    const headline = String(top.headline || top.summary || summary.reason || 'significant news detected').trim();
    const subjects = Array.isArray(summary.livePositionSymbols) && summary.livePositionSymbols.length > 0
      ? `live positions ${summary.livePositionSymbols.join(', ')}`
      : (summary.caseMatches?.map((entry) => entry.label).join(', ') || 'active cases');
    return [
      '[PROACTIVE] News scan found a significant headline.',
      `Level: ${summary.alertLevel || 'level_0'}`,
      `Scope: ${subjects}`,
      `Reason: ${summary.reason || 'headline matched active scope'}`,
      `Headline: ${headline}`,
    ].join('\n');
  }

  buildNewsScanArchitectAlert(summary = {}) {
    const findings = Array.isArray(summary.findings) ? summary.findings : [];
    const top = findings[0] || {};
    const headline = String(top.headline || top.summary || summary.reason || 'no significant headline').trim();
    const scope = Array.isArray(summary.livePositionSymbols) && summary.livePositionSymbols.length > 0
      ? `live positions ${summary.livePositionSymbols.join(', ')}`
      : (Array.isArray(summary.scanSymbols) ? summary.scanSymbols.join(', ') : 'watchlist');
    return [
      '[PROACTIVE][NEWS] News scan complete.',
      `Level: ${summary.alertLevel || 'level_0'}`,
      `Decision: ${summary.decision || 'DEGRADED'} (${summary.sourceTier || 'none'})`,
      `Scope: ${scope}`,
      `Reason: ${summary.reason || 'stored_for_review'}`,
      `Headline: ${headline}`,
    ].join('\n');
  }

  buildMarketResearchArchitectAlert(summary = {}) {
    const findings = Array.isArray(summary.findings) ? summary.findings : [];
    const top = findings[0] || {};
    const headline = String(top.headline || top.summary || 'none').trim();
    return [
      '[PROACTIVE][RESEARCH] Market research scan complete.',
      `Level: ${summary.alertLevel || 'level_0'}`,
      `Macro: ${summary.macroRisk?.regime || 'unknown'} (${summary.macroRisk?.score ?? 'n/a'})`,
      `Event decision: ${summary.eventDecision || 'DEGRADED'} (${summary.sourceTier || 'none'})`,
      `Headline count: ${Number(summary.headlineCount || 0)}`,
      headline ? `Top headline: ${headline}` : null,
    ].filter(Boolean).join('\n');
  }

  buildMarketScannerArchitectAlert(summary = {}) {
    const movers = Array.isArray(summary.alerts) && summary.alerts.length > 0
      ? summary.alerts
      : (Array.isArray(summary.flaggedMovers) ? summary.flaggedMovers.slice(0, 5) : []);
    const lines = movers.slice(0, 5).map((mover) => {
      const price = Number.isFinite(Number(mover?.price)) ? Number(mover.price).toFixed(4) : 'n/a';
      const change4h = Number.isFinite(Number(mover?.change4hPct))
        ? `${(Number(mover.change4hPct) * 100).toFixed(2)}%`
        : 'n/a';
      const change24h = Number.isFinite(Number(mover?.change24hPct))
        ? `${(Number(mover.change24hPct) * 100).toFixed(2)}%`
        : 'n/a';
      const volume = Number.isFinite(Number(mover?.volumeUsd24h))
        ? `$${Math.round(Number(mover.volumeUsd24h)).toLocaleString('en-US')}`
        : 'n/a';
      const fundingBps = Number.isFinite(Number(mover?.fundingRate))
        ? `${(Number(mover.fundingRate) * 10_000).toFixed(3)} bps`
        : 'n/a';
      return `${mover?.coin || mover?.ticker}: ${mover?.direction || 'FLAT'} @ ${price} | 4h ${change4h} | 24h ${change24h} | vol ${volume} | funding ${fundingBps}`;
    });
    return [
      '[PROACTIVE][MARKET] [private-live-ops] full-universe scan found movers.',
      `Tracked pairs: ${Number(summary.assetCount || 0)}`,
      `Flagged movers: ${Number(summary.flaggedCount || 0)}`,
      ...lines,
    ].filter(Boolean).join('\n');
  }

  logTradingEventHeader(phaseKey = 'unknown') {
    try {
      const header = predictionTrackerModule.eventHeader();
      if (header) {
        this.logger.info(`[EVENT WATCH][${phaseKey}]\n${header}`);
      }
    } catch (error) {
      this.logger.warn(`Event watch header failed (${phaseKey}): ${error?.message || String(error)}`);
    }
  }

  runOilMonitorCheck(phaseKey = 'unknown', oilIndicator = null) {
    const indicator = oilIndicator && typeof oilIndicator === 'object'
      ? oilIndicator
      : { value: oilIndicator };
    const numericOilPrice = Number(indicator?.value);
    if (!Number.isFinite(numericOilPrice) || numericOilPrice <= 0) {
      return null;
    }
    try {
      const oilStatus = predictionTrackerModule.checkOilPrice(numericOilPrice, {
        source: indicator?.source || null,
        observedAt: indicator?.observedAt || null,
        fetchedAt: indicator?.fetchedAt || null,
        stale: indicator?.stale === true,
        staleReason: indicator?.staleReason || null,
      });
      const delta = Number(oilStatus?.delta || 0);
      this.logger.info(
        `[OIL MONITOR][${phaseKey}] WTI $${numericOilPrice.toFixed(2)} (${delta >= 0 ? '+' : ''}${delta.toFixed(2)} vs last check, source=${String(indicator?.source || 'unknown')}${indicator?.stale === true ? ', stale=true' : ''})`
      );
      if (oilStatus?.suppressed) {
        this.logger.warn(
          `[OIL MONITOR][${phaseKey}] Alert suppressed (${oilStatus.suppressReason || 'unknown'}) for WTI $${numericOilPrice.toFixed(2)}.`
        );
      } else if (oilStatus?.alert) {
        const message = `[PROACTIVE][MACRO] Oil moved ${delta >= 0 ? '+' : ''}$${delta.toFixed(2)} to $${numericOilPrice.toFixed(2)} since the last supervisor cycle.`;
        this.logger.warn(message);
        this.notifyArchitectInternal(message, 'oil_monitor');
      }
      return oilStatus;
    } catch (error) {
      this.logger.warn(`Oil monitor failed (${phaseKey}): ${error?.message || String(error)}`);
      return null;
    }
  }

  parseWatcherScriptSummary(result = {}, label = 'watcher') {
    const stdout = String(result?.stdout || '').trim();
    if (!result?.ok) {
      return {
        ok: false,
        status: 'failed',
        error: result?.error || result?.stderr || `script_failed:${label}`,
        exitCode: result?.exitCode ?? null,
      };
    }
    if (!stdout) {
      return {
        ok: false,
        status: 'failed',
        error: `empty_stdout:${label}`,
        exitCode: result?.exitCode ?? null,
      };
    }
    try {
      return JSON.parse(stdout);
    } catch (error) {
      return {
        ok: false,
        status: 'failed',
        error: `invalid_json:${label}:${error?.message || String(error)}`,
        stdout,
        exitCode: result?.exitCode ?? null,
      };
    }
  }

  async maybeRunSaylorWatcher(nowMs = Date.now()) {
    if (!this.saylorWatcherEnabled || this.stopping) {
      return { ok: false, skipped: true, reason: 'x_watchlist_disabled' };
    }
    if (this.saylorWatcherPromise) {
      return this.saylorWatcherPromise;
    }
    if ((nowMs - this.lastSaylorWatcherRunAtMs) < this.saylorWatcherIntervalMs) {
      return {
        ok: false,
        skipped: true,
        reason: 'x_watchlist_cooldown',
        nextEligibleAtMs: this.lastSaylorWatcherRunAtMs + this.saylorWatcherIntervalMs,
      };
    }

    this.saylorWatcherPromise = executeNodeScript(
      this.hmSaylorWatcherScriptPath,
      ['--json'],
      {
        cwd: this.projectRoot,
        env: this.runtimeEnv,
        timeoutMs: 45_000,
      }
    ).then((result) => {
      const summary = this.parseWatcherScriptSummary(result, 'saylor_watcher');
      this.lastSaylorWatcherRunAtMs = Date.now();
      this.lastSaylorWatcherSummary = {
        enabled: true,
        status: summary?.ok ? (summary?.alerted ? 'alert_sent' : 'ok') : 'failed',
        intervalMs: this.saylorWatcherIntervalMs,
        lastRunAt: new Date(this.lastSaylorWatcherRunAtMs).toISOString(),
        lastSummary: summary,
      };
      if (summary?.ok !== true) {
        this.logger.warn(`X watchlist failed: ${summary?.error || 'unknown'}`);
      } else if (Number(summary?.alertCount || 0) > 0) {
        this.logger.warn(`X watchlist detected ${summary.alertCount} new item(s).`);
      }
      return summary;
    }).finally(() => {
      this.saylorWatcherPromise = null;
    });

    return this.saylorWatcherPromise;
  }

  async maybeRun[private-live-ops]SqueezeDetector(nowMs = Date.now()) {
    if (!this.[private-live-ops]SqueezeDetectorEnabled || this.stopping) {
      return { ok: false, skipped: true, reason: '[private-live-ops]_squeeze_detector_disabled' };
    }
    const manualActivity = this.getActive[private-live-ops]ManualActivity(nowMs);
    if (manualActivity) {
      this.last[private-live-ops]SqueezeDetectorSummary = {
        enabled: true,
        status: 'paused_for_manual_activity',
        intervalMs: this.[private-live-ops]SqueezeDetectorIntervalMs,
        lastRunAt: this.last[private-live-ops]SqueezeDetectorSummary?.lastRunAt || null,
        manualActivity,
      };
      return {
        ok: true,
        skipped: true,
        reason: 'manual_[private-live-ops]_activity',
        manualActivity,
      };
    }
    if (this.[private-live-ops]SqueezeDetectorPromise) {
      return this.[private-live-ops]SqueezeDetectorPromise;
    }
    if ((nowMs - this.last[private-live-ops]SqueezeDetectorRunAtMs) < this.[private-live-ops]SqueezeDetectorIntervalMs) {
      return {
        ok: false,
        skipped: true,
        reason: '[private-live-ops]_squeeze_detector_cooldown',
        nextEligibleAtMs: this.last[private-live-ops]SqueezeDetectorRunAtMs + this.[private-live-ops]SqueezeDetectorIntervalMs,
      };
    }

    this.[private-live-ops]SqueezeDetectorPromise = executeNodeScript(
      this.hm[private-live-ops]SqueezeDetectorScriptPath,
      ['--json'],
      {
        cwd: this.projectRoot,
        env: this.runtimeEnv,
        timeoutMs: 30_000,
      }
    ).then((result) => {
      const summary = this.parseWatcherScriptSummary(result, '[private-live-ops]_squeeze_detector');
      this.last[private-live-ops]SqueezeDetectorRunAtMs = Date.now();
      this.last[private-live-ops]SqueezeDetectorSummary = {
        enabled: true,
        status: summary?.ok ? (summary?.alerted ? 'alert_sent' : 'ok') : 'failed',
        intervalMs: this.[private-live-ops]SqueezeDetectorIntervalMs,
        lastRunAt: new Date(this.last[private-live-ops]SqueezeDetectorRunAtMs).toISOString(),
        lastSummary: summary,
      };
      if (summary?.ok !== true) {
        this.logger.warn(`[private-live-ops] squeeze detector failed: ${summary?.error || 'unknown'}`);
      } else if (Number(summary?.detectionCount || 0) > 0) {
        this.logger.warn(`[private-live-ops] squeeze detector flagged ${summary.detectionCount} setup(s).`);
      }
      return summary;
    }).finally(() => {
      this.[private-live-ops]SqueezeDetectorPromise = null;
    });

    return this.[private-live-ops]SqueezeDetectorPromise;
  }

  async maybeRunOracleWatchEngine(nowMs = Date.now()) {
    if (!this.oracleWatchEnabled || this.stopping) {
      return { ok: false, skipped: true, reason: 'oracle_watch_disabled' };
    }
    const manualActivity = this.getActive[private-live-ops]ManualActivity(nowMs);
    if (manualActivity) {
      return {
        ok: true,
        skipped: true,
        reason: 'manual_[private-live-ops]_activity',
        manualActivity,
      };
    }
    if (this.oracleWatchPromise) {
      return this.oracleWatchPromise;
    }
    this.oracleWatchIntervalMs = resolveOracleWatchIntervalMs(this.oracleWatchRulesPath, this.oracleWatchIntervalMs);
    const oracleWatchState = readJsonFile(this.oracleWatchStatePath, {}) || {};
    this.lastOracleShortRegimeSummary = readJsonFile(this.oracleShortRegimeStatePath, null) || null;
    const heartbeat = buildOracleWatchHeartbeat(this.lastOracleWatchSummary, oracleWatchState);
    const backoffUntilMs = resolveOracleWatchBackoffUntilMs(oracleWatchState, nowMs);
    const forceRelaunch = Boolean(
      heartbeat?.stale === true
      && Number.isFinite(Number(heartbeat?.ageMs))
      && Number(heartbeat.ageMs) >= this.oracleWatchIntervalMs
    );
    if (forceRelaunch && Number.isFinite(backoffUntilMs)) {
      return {
        ok: false,
        skipped: true,
        reason: 'oracle_watch_backoff_active',
        backoffUntil: Number.isFinite(backoffUntilMs) ? new Date(backoffUntilMs).toISOString() : null,
        nextEligibleAtMs: Number.isFinite(backoffUntilMs)
          ? backoffUntilMs
          : (Number(this.lastOracleWatchRunAtMs || 0) + Number(this.oracleWatchIntervalMs || DEFAULT_ORACLE_WATCH_INTERVAL_MS)),
      };
    }
    const relaunchCooldownMs = Math.max(
      Number(this.oracleWatchRelaunchCooldownMs || DEFAULT_ORACLE_WATCH_RELAUNCH_COOLDOWN_MS) || DEFAULT_ORACLE_WATCH_RELAUNCH_COOLDOWN_MS,
      Number(this.oracleWatchIntervalMs || DEFAULT_ORACLE_WATCH_INTERVAL_MS) || DEFAULT_ORACLE_WATCH_INTERVAL_MS
    );
    if (forceRelaunch && (nowMs - this.lastOracleWatchRelaunchAtMs) < relaunchCooldownMs) {
      return {
        ok: false,
        skipped: true,
        reason: 'oracle_watch_relaunch_cooldown',
        nextEligibleAtMs: this.lastOracleWatchRelaunchAtMs + relaunchCooldownMs,
      };
    }
    if (!forceRelaunch && (nowMs - this.lastOracleWatchRunAtMs) < this.oracleWatchIntervalMs) {
      return {
        ok: false,
        skipped: true,
        reason: 'oracle_watch_cooldown',
        nextEligibleAtMs: this.lastOracleWatchRunAtMs + this.oracleWatchIntervalMs,
      };
    }
    if (forceRelaunch) {
      this.lastOracleWatchRelaunchAtMs = nowMs;
      const lastTickAt = heartbeat?.lastTickAt || 'unknown';
      this.emitRateLimitedLog({
        key: 'oracle-watch-inproc-relaunch',
        level: 'warn',
        message: `[ORACLE WATCH][INPROC_RELAUNCH] Oracle watch heartbeat is stale with no running lane; forcing relaunch `
          + `(lastTickAt=${lastTickAt}, ageMs=${Number(heartbeat?.ageMs || 0) || 0}).`,
        state: lastTickAt,
        intervalMs: this.supervisorRepeatLogMs,
        nowMs,
      });
    }

    this.oracleWatchPromise = executeNodeScript(
      this.hmOracleWatchEngineScriptPath,
      ['run', '--once', '--rules', this.oracleWatchRulesPath, '--state', this.oracleWatchStatePath],
      {
        cwd: this.projectRoot,
        env: this.runtimeEnv,
        timeoutMs: Math.max(this.oracleWatchIntervalMs, 30_000),
      }
    ).then((result) => {
      const summary = this.parseWatcherScriptSummary(result, 'oracle_watch');
      this.lastOracleWatchRunAtMs = Date.now();
      this.oracleWatchIntervalMs = resolveOracleWatchIntervalMs(this.oracleWatchRulesPath, this.oracleWatchIntervalMs);
      this.lastOracleWatchSummary = {
        enabled: true,
        status: summary?.ok ? (summary?.alertCount > 0 ? 'alert_sent' : 'ok') : 'failed',
        intervalMs: this.oracleWatchIntervalMs,
        rulesPath: this.oracleWatchRulesPath,
        statePath: this.oracleWatchStatePath,
        lastRunAt: new Date(this.lastOracleWatchRunAtMs).toISOString(),
        lastSummary: summary,
      };
      if (summary?.ok !== true) {
        const errorMessage = summary?.error || 'unknown';
        this.emitRateLimitedLog({
          key: 'oracle-watch-engine-failed',
          level: 'warn',
          message: `Oracle watch engine failed: ${errorMessage}`,
          state: errorMessage,
        });
      } else if (Number(summary?.alertCount || 0) > 0) {
        this.emitRateLimitedLog({
          key: 'oracle-watch-engine-alerts',
          level: 'warn',
          message: `Oracle watch engine sent ${summary.alertCount} alert(s).`,
          state: `${summary.alertCount}:${Array.isArray(summary.tickers) ? summary.tickers.join(',') : ''}`,
          intervalMs: this.supervisorRepeatLogMs,
        });
      }
      return summary;
    }).finally(() => {
      this.oracleWatchPromise = null;
    });

    return this.oracleWatchPromise;
  }

  buildPredictionPriceMap(entries = []) {
    const prices = {};
    for (const entry of Array.isArray(entries) ? entries : []) {
      const ticker = String(entry?.ticker || '').trim().toUpperCase();
      const coin = String(entry?.coin || (ticker.endsWith('/USD') ? ticker.slice(0, -4) : ticker)).trim().toUpperCase();
      const price = Number(entry?.price);
      if (!Number.isFinite(price) || price <= 0) continue;
      if (coin) prices[coin] = price;
      if (ticker) prices[ticker] = price;
    }
    return prices;
  }

  normalizePredictionDirection(decision = '') {
    const normalized = String(decision || '').trim().toUpperCase();
    if (['BUY', 'LONG', 'COVER'].includes(normalized)) return 'LONG';
    if (['SELL', 'SHORT'].includes(normalized)) return 'SHORT';
    return 'HOLD';
  }

  buildPredictionReasoning(result = {}) {
    const explicit = String(result?.reasoning || '').trim();
    if (explicit) return explicit;
    const agreeingReasoning = (Array.isArray(result?.agreeing) ? result.agreeing : [])
      .map((signal) => String(signal?.reasoning || '').trim())
      .filter(Boolean)
      .slice(0, 3);
    if (agreeingReasoning.length > 0) {
      return agreeingReasoning.join(' | ');
    }
    return `Consensus ${String(result?.decision || 'HOLD').toUpperCase()} on ${String(result?.ticker || '').trim() || 'unknown ticker'}`;
  }

  logConsensusPredictions(consensusPhase = {}) {
    const results = Array.isArray(consensusPhase?.results) ? consensusPhase.results : [];
    if (results.length === 0) return 0;
    const prices = this.buildPredictionPriceMap(this.marketScannerState?.assets);
    for (const trade of Array.isArray(consensusPhase?.approvedTrades) ? consensusPhase.approvedTrades : []) {
      const ticker = String(trade?.ticker || '').trim().toUpperCase();
      const coin = ticker.endsWith('/USD') ? ticker.slice(0, -4) : ticker;
      const price = Number(trade?.referencePrice);
      if (!Number.isFinite(price) || price <= 0) continue;
      if (coin) prices[coin] = price;
      if (ticker) prices[ticker] = price;
    }
    for (const trade of Array.isArray(consensusPhase?.rejectedTrades) ? consensusPhase.rejectedTrades : []) {
      const ticker = String(trade?.ticker || '').trim().toUpperCase();
      const coin = ticker.endsWith('/USD') ? ticker.slice(0, -4) : ticker;
      const price = Number(trade?.referencePrice);
      if (!Number.isFinite(price) || price <= 0) continue;
      if (coin) prices[coin] = price;
      if (ticker) prices[ticker] = price;
    }

    let logged = 0;
    for (const result of results) {
      const ticker = String(result?.ticker || '').trim().toUpperCase();
      if (!ticker) continue;
      const coin = ticker.endsWith('/USD') ? ticker.slice(0, -4) : ticker;
      const entryPrice = Number(prices[coin] ?? prices[ticker]);
      if (!Number.isFinite(entryPrice) || entryPrice <= 0) continue;
      predictionTrackerModule.logPrediction({
        coin,
        direction: this.normalizePredictionDirection(result?.decision),
        entryPrice,
        confidence: toNumber(result?.averageAgreeConfidence ?? result?.confidence, 0),
        reasoning: this.buildPredictionReasoning(result),
        source: 'supervisor',
        setupType: String(consensusPhase?.strategyMode || 'consensus').trim() || 'consensus',
        macroState: String(consensusPhase?.macroRisk?.regime || 'unknown').trim() || 'unknown',
      });
      logged += 1;
    }
    return logged;
  }

  sanitizeMarketScannerMovers(entries = []) {
    const canonicalMovers = marketScannerModule.buildMoverMap([
      ...(Array.isArray(this.marketScannerState?.assets) ? this.marketScannerState.assets : []),
      ...(Array.isArray(this.marketScannerState?.topMovers) ? this.marketScannerState.topMovers : []),
      ...(Array.isArray(this.marketScannerState?.flaggedMovers) ? this.marketScannerState.flaggedMovers : []),
    ]);
    const sanitized = [];
    const isMissing = (value) => value == null || value === '' || (typeof value === 'number' && Number.isNaN(value));
    for (const entry of Array.isArray(entries) ? entries : []) {
      const normalized = marketScannerModule.normalizeMover(entry);
      if (!normalized.coin) continue;
      const canonical = canonicalMovers.get(normalized.coin);
      if (!canonical) {
        sanitized.push(normalized);
        continue;
      }
      const merged = { ...canonical, ...normalized };
      for (const key of [
        'price',
        'change4hPct',
        'change24hPct',
        'volumeUsd24h',
        'fundingRate',
        'openInterest',
        'openInterestChange24hPct',
        'score',
      ]) {
        if (isMissing(normalized[key]) && !isMissing(canonical[key])) {
          merged[key] = canonical[key];
        }
      }
      if ((normalized.direction === 'FLAT' || !normalized.direction) && canonical.direction && canonical.direction !== 'FLAT') {
        merged.direction = canonical.direction;
      }
      if (!normalized.triggerWindow && canonical.triggerWindow) {
        merged.triggerWindow = canonical.triggerWindow;
      }
      merged.flagged = normalized.flagged === true || canonical.flagged === true;
      sanitized.push(merged);
    }
    return sanitized;
  }

  async filterExecutableMarketScannerMovers(entries = []) {
    const candidates = this.sanitizeMarketScannerMovers(entries);
    if (candidates.length === 0) return [];
    const supported = [];
    for (const mover of candidates) {
      const ticker = String(mover?.ticker || '').trim().toUpperCase();
      if (!ticker) continue;
      try {
        const barsBySymbol = await [private-live-ops]Client.getHistoricalBars({
          symbols: [ticker],
          timeframe: '1Hour',
          limit: 2,
          end: new Date().toISOString(),
        });
        const bars = barsBySymbol instanceof Map ? barsBySymbol.get(ticker) : barsBySymbol?.[ticker];
        if (Array.isArray(bars) && bars.length > 0) {
          supported.push(mover);
        } else {
          this.emitRateLimitedLog({
            key: `market-scanner-missing-history:${ticker}`,
            level: 'warn',
            message: `Skipping market-scanner mover without executable historical support: ${ticker}`,
            state: ticker,
          });
        }
      } catch (error) {
        const errorMessage = error?.message || String(error);
        this.emitRateLimitedLog({
          key: `market-scanner-history-error:${ticker}`,
          level: 'warn',
          message: `Skipping market-scanner mover ${ticker}: ${errorMessage}`,
          state: errorMessage,
        });
      }
    }
    return supported;
  }

  getBarsForTicker(barsBySymbol, ticker) {
    if (!ticker) return [];
    if (barsBySymbol instanceof Map) {
      return barsBySymbol.get(ticker) || [];
    }
    if (barsBySymbol && typeof barsBySymbol === 'object') {
      return barsBySymbol[ticker] || [];
    }
    return [];
  }

  async filterOrdiQualifiedMarketScannerMovers(entries = [], options = {}) {
    const candidatesByTicker = new Map();
    for (const mover of this.sanitizeMarketScannerMovers(entries)) {
      const ticker = String(mover?.ticker || '').trim().toUpperCase();
      if (!ticker || candidatesByTicker.has(ticker)) continue;
      candidatesByTicker.set(ticker, mover);
    }

    const suppressed = [];
    const decisions = [];
    const rolloverCandidates = [];
    for (const mover of candidatesByTicker.values()) {
      const ticker = String(mover?.ticker || '').trim().toUpperCase();
      const volumeUsd24h = toNumber(mover?.volumeUsd24h, 0);
      const change4hPct = toNumber(mover?.change4hPct, 0);
      const direction = String(mover?.direction || '').trim().toUpperCase();
      if (volumeUsd24h < MARKET_SCANNER_ALERT_MIN_VOLUME_USD_24H) {
        suppressed.push({ ticker, reason: 'insufficient_alert_liquidity', volumeUsd24h });
        decisions.push({ ticker, accepted: false, reason: 'insufficient_alert_liquidity' });
        continue;
      }
      if (direction !== 'DOWN' && !(change4hPct < 0)) {
        suppressed.push({ ticker, reason: 'rollover_missing', direction, change4hPct });
        decisions.push({ ticker, accepted: false, reason: 'rollover_missing' });
        continue;
      }
      rolloverCandidates.push(mover);
    }

    if (this.marketScannerAlertGate) {
      const customResult = await this.marketScannerAlertGate({
        candidates: rolloverCandidates,
        suppressed,
        decisions,
        scannedAt: options.scannedAt,
        now: options.now,
      });
      return {
        qualifiedMovers: Array.isArray(customResult?.qualifiedMovers) ? customResult.qualifiedMovers : [],
        suppressedMovers: Array.isArray(customResult?.suppressedMovers) ? customResult.suppressedMovers : suppressed,
        decisions: Array.isArray(customResult?.decisions) ? customResult.decisions : decisions,
      };
    }

    if (rolloverCandidates.length === 0) {
      return {
        qualifiedMovers: [],
        suppressedMovers: suppressed,
        decisions,
      };
    }

    const tickers = rolloverCandidates.map((mover) => mover.ticker);
    const end = options.scannedAt || options.now || new Date().toISOString();
    const [bars5m, bars15m, bars1h] = await Promise.all([
      [private-live-ops]Client.getHistoricalBars({
        symbols: tickers,
        timeframe: '5m',
        limit: 24,
        end,
      }).catch(() => new Map()),
      [private-live-ops]Client.getHistoricalBars({
        symbols: tickers,
        timeframe: '15m',
        limit: 24,
        end,
      }).catch(() => new Map()),
      [private-live-ops]Client.getHistoricalBars({
        symbols: tickers,
        timeframe: '1Hour',
        limit: 96,
        end,
      }).catch(() => new Map()),
    ]);

    const qualifiedMovers = [];
    for (const mover of rolloverCandidates) {
      const ticker = String(mover?.ticker || '').trim().toUpperCase();
      const recent5m = this.getBarsForTicker(bars5m, ticker);
      const recent15m = this.getBarsForTicker(bars15m, ticker);
      const recent1h = this.getBarsForTicker(bars1h, ticker);
      const latest5m = Array.isArray(recent5m) && recent5m.length > 0
        ? toNumber(recent5m[recent5m.length - 1]?.close, NaN)
        : NaN;
      const currentPrice = toNumber(mover?.price, latest5m);
      const gate = oracleWatchRegime.evaluateOrdiPatternPromotionGate({
        ticker,
        desiredDirection: 'SELL',
        scannerMover: mover,
        source: { type: 'market_scanner_alert' },
      }, recent5m, recent15m, recent1h, currentPrice);
      decisions.push({
        ticker,
        accepted: gate?.ok === true,
        reason: gate?.reason || 'ordi_pattern_gate_failed',
      });
      if (gate?.ok === true) {
        qualifiedMovers.push(mover);
      } else {
        suppressed.push({
          ticker,
          reason: gate?.reason || 'ordi_pattern_gate_failed',
        });
      }
    }

    return {
      qualifiedMovers,
      suppressedMovers: suppressed,
      decisions,
    };
  }

  promoteMarketScannerMovers(movers = [], now = new Date()) {
    return dynamicWatchlist.promoteMarketScannerMovers(movers, {
      statePath: this.dynamicWatchlistStatePath,
      now,
      ttlHours: 4,
    });
  }

  build[private-profile]CheckInArchitectAlert(summary = {}) {
    return [
      '[PROACTIVE][EUNBYEOL] Check-in review complete.',
      `Pending [private-profile] items: ${Number(summary.pendingCount || 0)}`,
      `Last message at: ${summary.lastMessageAt || 'never'}`,
      `Silence hours: ${summary.silenceHours ?? 'n/a'}`,
      `Drafted: ${summary.drafted ? 'yes' : 'no'}`,
      summary.topItems?.length ? `Top items: ${summary.topItems.join(' | ')}` : null,
      summary.draft ? `Draft:\n${summary.draft}` : null,
    ].filter(Boolean).join('\n');
  }

  async runNewsScanPhase(event) {
    const scannedAt = new Date().toISOString();
    const watchlistSymbols = await this.getCryptoSymbols();
    const openPositions = await Promise.resolve(this.newsScanOpenPositionProvider()).catch(() => []);
    const livePositionSymbols = Array.from(new Set(
      (Array.isArray(openPositions) ? openPositions : [])
        .map((position) => normalizeNewsTicker(position?.coin || position?.asset || position?.ticker || ''))
        .filter(Boolean)
    ));
    const scanSymbols = Array.from(new Set([...livePositionSymbols, ...watchlistSymbols]));
    const caseSignals = this.readActiveCaseSignals();
    const newsItems = await this.newsVetoModule.fetchTier1News({
      symbols: scanSymbols,
      timeoutMs: 8_000,
      limit: 25,
    }).catch(() => []);
    const veto = await this.newsVetoModule.buildEventVeto({
      symbols: scanSymbols,
      now: scannedAt,
      newsItems,
    }).catch(() => ({
      decision: 'DEGRADED',
      matchedEvents: [],
      eventSummary: 'news_scan_failed',
      sourceTier: 'none',
    }));

    const lowerCaseSignals = caseSignals.map((entry) => ({
      label: entry.label,
      keywords: entry.keywords.map((keyword) => String(keyword || '').toLowerCase()),
    }));
    const caseMatches = (Array.isArray(newsItems) ? newsItems : []).flatMap((item) => {
      const haystack = `${item?.headline || ''} ${item?.summary || ''}`.toLowerCase();
      return lowerCaseSignals
        .filter((signal) => signal.keywords.some((keyword) => keyword && haystack.includes(keyword)))
        .map((signal) => ({
          label: signal.label,
          headline: String(item?.headline || '').trim(),
          source: String(item?.source || '').trim(),
          url: String(item?.url || '').trim(),
        }));
    });

    let alertLevel = 'level_0';
    let reason = 'stored_for_review';
    if (livePositionSymbols.length > 0 && ['CAUTION', 'VETO'].includes(String(veto?.decision || '').toUpperCase())) {
      alertLevel = 'level_2';
      reason = 'live_position_event_risk';
    } else if (caseMatches.length > 0) {
      alertLevel = 'level_2';
      reason = 'active_case_headline_match';
    }

    const findings = Array.isArray(veto?.matchedEvents) && veto.matchedEvents.length > 0
      ? veto.matchedEvents
      : (Array.isArray(newsItems) ? newsItems.slice(0, 5) : []);
    const alertFingerprint = buildNewsFingerprint({
      level: alertLevel,
      reason,
      headlines: findings.map((item) => item?.headline || item?.summary || ''),
    });
    const shouldNotifyArchitect = Boolean(alertFingerprint)
      && alertFingerprint !== this.newsScanState.lastAlertFingerprint;
    const summary = {
      ok: true,
      key: event?.key || 'news_scan',
      scannedAt,
      scanSymbols,
      livePositionSymbols,
      watchlistSize: watchlistSymbols.length,
      headlineCount: Array.isArray(newsItems) ? newsItems.length : 0,
      decision: veto?.decision || 'DEGRADED',
      sourceTier: veto?.sourceTier || 'none',
      alertLevel,
      reason,
      caseMatches: caseMatches.slice(0, 5),
      findings: findings.slice(0, 5),
      notified: shouldNotifyArchitect,
    };

    if (shouldNotifyArchitect) {
      this.notifyArchitectInternal(this.buildNewsScanArchitectAlert(summary), 'news_scan');
      this.newsScanState.lastAlertFingerprint = alertFingerprint;
    }
    return summary;
  }

  async maybeRunNewsScanAutomation(nowMs = Date.now()) {
    if (!this.newsScanEnabled || this.stopping || !this.newsVetoModule) {
      return { ok: false, skipped: true, reason: 'news_scan_disabled' };
    }
    if (this.newsScanPhasePromise) {
      return this.newsScanPhasePromise;
    }

    const now = nowMs instanceof Date ? nowMs : new Date(nowMs);
    const nextEvent = getNextNewsScanEvent(now, {
      intervalMinutes: this.newsScanIntervalMinutes,
    });
    const newsScanDay = buildNewsScanDailySchedule(now, {
      intervalMinutes: this.newsScanIntervalMinutes,
    });
    const lastProcessedAtMs = this.newsScanState.lastProcessedAt
      ? new Date(this.newsScanState.lastProcessedAt).getTime()
      : 0;
    const dueEvents = newsScanDay.schedule.filter((event) => {
      const scheduledAtMs = new Date(event.scheduledAt).getTime();
      return scheduledAtMs <= now.getTime() && scheduledAtMs > lastProcessedAtMs;
    });

    this.newsScanState.nextEvent = this.describeTradingEvent(nextEvent);
    this.persistNewsScanState();

    if (dueEvents.length === 0) {
      this.lastNewsScanSummary = {
        enabled: true,
        status: 'scheduled',
        intervalMinutes: this.newsScanIntervalMinutes,
        lastProcessedAt: this.newsScanState.lastProcessedAt || null,
        nextEvent: this.newsScanState.nextEvent,
      };
      return {
        ok: false,
        skipped: true,
        reason: 'no_due_news_scan',
        nextEvent: this.newsScanState.nextEvent,
      };
    }

    this.newsScanPhasePromise = (async () => {
      const executed = [];
      for (const event of dueEvents) {
        const phaseResult = await this.runNewsScanPhase(event);
        executed.push(phaseResult);
        this.newsScanState.lastProcessedAt = event.scheduledAt;
        this.newsScanState.lastResult = phaseResult;
        this.newsScanState.lastScan = phaseResult;
        this.persistNewsScanState();
      }

      const upcomingEvent = getNextNewsScanEvent(new Date(), {
        intervalMinutes: this.newsScanIntervalMinutes,
      });
      this.newsScanState.nextEvent = this.describeTradingEvent(upcomingEvent);
      this.persistNewsScanState();
      this.lastNewsScanSummary = {
        enabled: true,
        status: executed.some((entry) => entry.notified) ? 'alert_sent' : 'scan_complete',
        intervalMinutes: this.newsScanIntervalMinutes,
        lastProcessedAt: this.newsScanState.lastProcessedAt || null,
        nextEvent: this.newsScanState.nextEvent,
        lastResult: executed[executed.length - 1] || null,
      };

      return {
        ok: true,
        skipped: false,
        executed,
        nextEvent: this.newsScanState.nextEvent,
      };
    })().finally(() => {
      this.newsScanPhasePromise = null;
    });

    return this.newsScanPhasePromise;
  }

  async runMarketResearchPhase(event) {
    const scannedAt = new Date().toISOString();
    const watchlistSymbols = await this.getCryptoSymbols();
    const openPositions = await Promise.resolve(this.marketResearchOpenPositionProvider()).catch(() => []);
    const livePositionSymbols = Array.from(new Set(
      (Array.isArray(openPositions) ? openPositions : [])
        .map((position) => normalizeNewsTicker(position?.coin || position?.asset || position?.ticker || ''))
        .filter(Boolean)
    ));
    const scanSymbols = Array.from(new Set([...livePositionSymbols, ...watchlistSymbols]));
    const [macroRisk, newsItems, veto] = await Promise.all([
      macroRiskGate.assessMacroRisk().catch(() => null),
      this.newsVetoModule.fetchTier1News({
        symbols: scanSymbols,
        timeoutMs: 8_000,
        limit: 12,
      }).catch(() => []),
      this.newsVetoModule.buildEventVeto({
        symbols: scanSymbols,
        now: scannedAt,
      }).catch(() => ({
        decision: 'DEGRADED',
        matchedEvents: [],
        sourceTier: 'none',
      })),
    ]);
    const summary = {
      ok: true,
      key: event?.key || 'market_research',
      scannedAt,
      scanSymbols,
      livePositionSymbols,
      macroRisk: macroRisk ? {
        regime: macroRisk.regime,
        score: macroRisk.score,
        reason: macroRisk.reason,
      } : null,
      eventDecision: veto?.decision || 'DEGRADED',
      sourceTier: veto?.sourceTier || 'none',
      headlineCount: Array.isArray(newsItems) ? newsItems.length : 0,
      findings: Array.isArray(veto?.matchedEvents) && veto.matchedEvents.length > 0
        ? veto.matchedEvents.slice(0, 5)
        : (Array.isArray(newsItems) ? newsItems.slice(0, 5) : []),
      alertLevel: 'level_0',
      notified: false,
    };
    const fingerprint = buildNewsFingerprint({
      level: summary.alertLevel,
      reason: `${summary.macroRisk?.regime || 'unknown'}:${summary.eventDecision || 'DEGRADED'}`,
      headlines: summary.findings.map((item) => item?.headline || item?.summary || ''),
    });
    const shouldNotifyArchitect = Boolean(fingerprint)
      && fingerprint !== this.marketResearchState.lastAlertFingerprint;
    if (shouldNotifyArchitect) {
      this.notifyArchitectInternal(this.buildMarketResearchArchitectAlert(summary), 'market_research');
      this.marketResearchState.lastAlertFingerprint = fingerprint;
      summary.notified = true;
    }
    return summary;
  }

  async maybeRunMarketResearchAutomation(nowMs = Date.now()) {
    if (!this.marketResearchEnabled || this.stopping || !this.newsVetoModule) {
      return { ok: false, skipped: true, reason: 'market_research_disabled' };
    }
    if (this.marketResearchPhasePromise) {
      return this.marketResearchPhasePromise;
    }

    const now = nowMs instanceof Date ? nowMs : new Date(nowMs);
    const nextEvent = getNextMarketResearchEvent(now, {
      intervalMinutes: this.marketResearchIntervalMinutes,
    });
    const day = buildMarketResearchDailySchedule(now, {
      intervalMinutes: this.marketResearchIntervalMinutes,
    });
    const lastProcessedAtMs = this.marketResearchState.lastProcessedAt
      ? new Date(this.marketResearchState.lastProcessedAt).getTime()
      : 0;
    const dueEvents = day.schedule.filter((event) => {
      const scheduledAtMs = new Date(event.scheduledAt).getTime();
      return scheduledAtMs <= now.getTime() && scheduledAtMs > lastProcessedAtMs;
    });

    this.marketResearchState.nextEvent = this.describeTradingEvent(nextEvent);
    this.persistMarketResearchState();

    if (dueEvents.length === 0) {
      this.lastMarketResearchSummary = {
        enabled: true,
        status: 'scheduled',
        intervalMinutes: this.marketResearchIntervalMinutes,
        lastProcessedAt: this.marketResearchState.lastProcessedAt || null,
        nextEvent: this.marketResearchState.nextEvent,
      };
      return { ok: false, skipped: true, reason: 'no_due_market_research', nextEvent: this.marketResearchState.nextEvent };
    }

    this.marketResearchPhasePromise = (async () => {
      const executed = [];
      for (const dueEvent of dueEvents) {
        const phaseResult = await this.runMarketResearchPhase(dueEvent);
        executed.push(phaseResult);
        this.marketResearchState.lastProcessedAt = dueEvent.scheduledAt;
        this.marketResearchState.lastResult = phaseResult;
        this.marketResearchState.lastScan = phaseResult;
        this.persistMarketResearchState();
      }

      const upcomingEvent = getNextMarketResearchEvent(new Date(), {
        intervalMinutes: this.marketResearchIntervalMinutes,
      });
      this.marketResearchState.nextEvent = this.describeTradingEvent(upcomingEvent);
      this.persistMarketResearchState();
      this.lastMarketResearchSummary = {
        enabled: true,
        status: 'scan_complete',
        intervalMinutes: this.marketResearchIntervalMinutes,
        lastProcessedAt: this.marketResearchState.lastProcessedAt || null,
        nextEvent: this.marketResearchState.nextEvent,
        lastResult: executed[executed.length - 1] || null,
      };

      return { ok: true, skipped: false, executed, nextEvent: this.marketResearchState.nextEvent };
    })().finally(() => {
      this.marketResearchPhasePromise = null;
    });

    return this.marketResearchPhasePromise;
  }

  async run[private-live-ops]Phase(event) {
    const executedAt = new Date().toISOString();
    const result = await executeNodeScript(this.hm[private-live-ops]UnlocksScriptPath, ['--json', '--hours', '48'], {
      cwd: this.projectRoot,
      timeoutMs: 30_000,
      env: this.runtimeEnv,
    });
    if (!result?.ok) {
      return {
        ok: false,
        key: event?.key || '[private-live-ops]_scan',
        executedAt,
        error: result?.error || result?.stderr || '[private-live-ops]_scan_failed',
        stdout: result?.stdout || '',
        stderr: result?.stderr || '',
      };
    }
    let payload = null;
    try {
      payload = JSON.parse(String(result.stdout || '{}'));
    } catch (error) {
      return {
        ok: false,
        key: event?.key || '[private-live-ops]_scan',
        executedAt,
        error: `[private-live-ops]_json_parse_failed:${error.message}`,
        stdout: result.stdout || '',
      };
    }
    return {
      ok: true,
      key: event?.key || '[private-live-ops]_scan',
      executedAt,
      unlockCount: Number(payload?.unlockCount || 0),
      unlocks: Array.isArray(payload?.unlocks) ? payload.unlocks.slice(0, 10) : [],
      sourcePath: payload?.sourcePath || null,
      maxHours: payload?.maxHours || 48,
    };
  }

  async maybeRun[private-live-ops]Automation(nowMs = Date.now()) {
    if (!this.[private-live-ops]Enabled || this.stopping) {
      return { ok: false, skipped: true, reason: '[private-live-ops]_disabled' };
    }
    if (this.[private-live-ops]PhasePromise) {
      return this.[private-live-ops]PhasePromise;
    }

    const now = nowMs instanceof Date ? nowMs : new Date(nowMs);
    const nextEvent = getNext[private-live-ops]Event(now, {
      intervalMinutes: this.[private-live-ops]IntervalMinutes,
    });
    const day = build[private-live-ops]DailySchedule(now, {
      intervalMinutes: this.[private-live-ops]IntervalMinutes,
    });
    const lastProcessedAtMs = this.[private-live-ops]State.lastProcessedAt
      ? new Date(this.[private-live-ops]State.lastProcessedAt).getTime()
      : 0;
    const dueEvents = day.schedule.filter((event) => {
      const scheduledAtMs = new Date(event.scheduledAt).getTime();
      return scheduledAtMs <= now.getTime() && scheduledAtMs > lastProcessedAtMs;
    });

    this.[private-live-ops]State.nextEvent = this.describeTradingEvent(nextEvent);
    this.persist[private-live-ops]State();

    if (dueEvents.length === 0) {
      this.last[private-live-ops]Summary = {
        enabled: true,
        status: 'scheduled',
        intervalMinutes: this.[private-live-ops]IntervalMinutes,
        lastProcessedAt: this.[private-live-ops]State.lastProcessedAt || null,
        nextEvent: this.[private-live-ops]State.nextEvent,
      };
      return { ok: false, skipped: true, reason: 'no_due_[private-live-ops]_phase', nextEvent: this.[private-live-ops]State.nextEvent };
    }

    this.[private-live-ops]PhasePromise = (async () => {
      const executed = [];
      for (const dueEvent of dueEvents) {
        const phaseResult = await this.run[private-live-ops]Phase(dueEvent);
        executed.push(phaseResult);
        this.[private-live-ops]State.lastProcessedAt = dueEvent.scheduledAt;
        this.[private-live-ops]State.lastResult = phaseResult;
        this.[private-live-ops]State.lastScan = phaseResult;
        this.persist[private-live-ops]State();
      }

      const upcomingEvent = getNext[private-live-ops]Event(new Date(), {
        intervalMinutes: this.[private-live-ops]IntervalMinutes,
      });
      this.[private-live-ops]State.nextEvent = this.describeTradingEvent(upcomingEvent);
      this.persist[private-live-ops]State();
      this.last[private-live-ops]Summary = {
        enabled: true,
        status: executed.every((entry) => entry.ok) ? 'scan_complete' : 'scan_failed',
        intervalMinutes: this.[private-live-ops]IntervalMinutes,
        lastProcessedAt: this.[private-live-ops]State.lastProcessedAt || null,
        nextEvent: this.[private-live-ops]State.nextEvent,
        lastResult: executed[executed.length - 1] || null,
      };

      return { ok: executed.every((entry) => entry.ok), skipped: false, executed, nextEvent: this.[private-live-ops]State.nextEvent };
    })().finally(() => {
      this.[private-live-ops]PhasePromise = null;
    });

    return this.[private-live-ops]PhasePromise;
  }

  async maybeRunSparkAutomation(nowMs = Date.now()) {
    if (!this.sparkMonitorEnabled || this.stopping) {
      return { ok: false, skipped: true, reason: 'spark_monitor_disabled' };
    }
    if (this.sparkMonitorPhasePromise) {
      return this.sparkMonitorPhasePromise;
    }

    const now = nowMs instanceof Date ? nowMs : new Date(nowMs);
    const nextEvent = getNextSparkMonitorEvent(now, {
      intervalMinutes: this.sparkMonitorIntervalMinutes,
    });
    const day = buildSparkMonitorDailySchedule(now, {
      intervalMinutes: this.sparkMonitorIntervalMinutes,
    });
    const lastProcessedAtMs = this.sparkMonitorState.lastProcessedAt
      ? new Date(this.sparkMonitorState.lastProcessedAt).getTime()
      : 0;
    const dueEvents = day.schedule.filter((event) => {
      const scheduledAtMs = new Date(event.scheduledAt).getTime();
      return scheduledAtMs <= now.getTime() && scheduledAtMs > lastProcessedAtMs;
    });

    this.sparkMonitorState.nextEvent = this.describeTradingEvent(nextEvent);
    this.persistSparkMonitorState();

    if (dueEvents.length === 0) {
      this.lastSparkMonitorSummary = {
        enabled: true,
        status: 'scheduled',
        intervalMinutes: this.sparkMonitorIntervalMinutes,
        lastProcessedAt: this.sparkMonitorState.lastProcessedAt || null,
        nextEvent: this.sparkMonitorState.nextEvent,
      };
      return { ok: false, skipped: true, reason: 'no_due_spark_phase', nextEvent: this.sparkMonitorState.nextEvent };
    }

    this.sparkMonitorPhasePromise = (async () => {
      const dueEvent = dueEvents[dueEvents.length - 1];
      const phaseResult = await sparkCapture.runSparkScan({
        now: dueEvent.scheduledAt,
        statePath: this.sparkMonitorDataStatePath,
        eventsPath: this.sparkMonitorEventsPath,
        firePlansPath: this.sparkMonitorFirePlansPath,
        watchlistPath: this.sparkMonitorWatchlistPath,
        fetch: this.fetch || global.fetch,
      });

      this.sparkMonitorState.lastProcessedAt = dueEvent.scheduledAt;
      this.sparkMonitorState.lastResult = phaseResult;
      this.sparkMonitorState.lastScan = phaseResult;

      const upcomingEvent = getNextSparkMonitorEvent(new Date(), {
        intervalMinutes: this.sparkMonitorIntervalMinutes,
      });
      this.sparkMonitorState.nextEvent = this.describeTradingEvent(upcomingEvent);
      this.persistSparkMonitorState();

      const alertCount = Array.isArray(phaseResult?.newAlertEvents) ? phaseResult.newAlertEvents.length : 0;
      const summary = {
        enabled: true,
        status: phaseResult?.ok === true ? 'scan_complete' : 'scan_failed',
        intervalMinutes: this.sparkMonitorIntervalMinutes,
        lastProcessedAt: this.sparkMonitorState.lastProcessedAt || null,
        nextEvent: this.sparkMonitorState.nextEvent,
        alertCount,
        upbitListingCount: Number(phaseResult?.upbitListingCount || 0),
        [private-live-ops]ListingCount: Number(phaseResult?.[private-live-ops]ListingCount || 0),
        tokenUnlockCount: Number(phaseResult?.tokenUnlockCount || 0),
        lastResult: phaseResult || null,
      };
      this.lastSparkMonitorSummary = summary;

      if (alertCount > 0 && phaseResult?.alertMessage) {
        const notification = phaseResult.alertMessage;
        this.notifyArchitectInternal(notification, 'spark_monitor');
        this.notifyTelegramTrading(notification);
      }

      return {
        ok: phaseResult?.ok !== false,
        skipped: false,
        nextEvent: this.sparkMonitorState.nextEvent,
        result: phaseResult,
      };
    })().finally(() => {
      this.sparkMonitorPhasePromise = null;
    });

    return this.sparkMonitorPhasePromise;
  }

  async runMarketScannerPhase(event) {
    const phaseKey = event?.key || 'market_scanner';
    this.logTradingEventHeader(phaseKey);
    try {
      const macroRisk = await macroRiskGate.assessMacroRisk();
      this.runOilMonitorCheck(phaseKey, macroRisk?.indicators?.oilPrice);
    } catch (error) {
      this.logger.warn(`Market scanner macro prelude failed: ${error?.message || String(error)}`);
    }
    const phaseResult = await this.marketScanner.runMarketScan({
      statePath: this.marketScannerStatePath,
      now: Date.now(),
      fetch: this.fetch || global.fetch,
    });
    if (phaseResult?.ok === false) {
      return {
        ok: false,
        degraded: phaseResult?.degraded === true,
        key: phaseKey,
        scannedAt: phaseResult?.scannedAt || new Date().toISOString(),
        assetCount: Number(phaseResult?.assetCount || this.marketScannerState?.assetCount || 0),
        flaggedCount: Array.isArray(phaseResult?.flaggedMovers) ? phaseResult.flaggedMovers.length : 0,
        flaggedMovers: Array.isArray(phaseResult?.flaggedMovers) ? phaseResult.flaggedMovers.slice(0, 10) : [],
        topMovers: Array.isArray(phaseResult?.topMovers) ? phaseResult.topMovers.slice(0, 10) : [],
        alerts: [],
        notified: false,
        error: phaseResult?.reason || 'market_scan_failed',
        validation: phaseResult?.validation || null,
      };
    }
    this.marketScannerState = marketScannerModule.normalizeMarketScannerState(phaseResult.state);
    const canonicalFlaggedMovers = Array.isArray(this.marketScannerState.flaggedMovers)
      ? this.marketScannerState.flaggedMovers.slice(0, 10)
      : [];
    const canonicalTopMovers = Array.isArray(this.marketScannerState.topMovers)
      ? this.marketScannerState.topMovers.slice(0, 10)
      : [];
    const canonicalAlerts = this.sanitizeMarketScannerMovers(
      Array.isArray(phaseResult.alerts) ? phaseResult.alerts : canonicalFlaggedMovers
    ).slice(0, 10);
    const rawUrgentSourceMovers = this.getUrgentMarketScannerMovers(
      Array.isArray(this.marketScannerState.flaggedMovers) && this.marketScannerState.flaggedMovers.length > 0
        ? this.marketScannerState.flaggedMovers
        : canonicalFlaggedMovers
    ).slice(0, 6);
    const alertGateResult = await this.filterOrdiQualifiedMarketScannerMovers([
      ...canonicalAlerts,
      ...rawUrgentSourceMovers,
    ], {
      scannedAt: phaseResult.scannedAt,
    });
    const qualifiedByTicker = new Map(
      (Array.isArray(alertGateResult.qualifiedMovers) ? alertGateResult.qualifiedMovers : [])
        .map((mover) => [String(mover?.ticker || '').trim().toUpperCase(), mover])
        .filter(([ticker]) => Boolean(ticker))
    );
    const gatedAlerts = canonicalAlerts.filter((mover) => qualifiedByTicker.has(String(mover?.ticker || '').trim().toUpperCase()));
    const gatedUrgentSourceMovers = rawUrgentSourceMovers
      .map((mover) => qualifiedByTicker.get(String(mover?.ticker || '').trim().toUpperCase()))
      .filter(Boolean)
      .slice(0, 6);
    const urgentPromotedSymbols = gatedUrgentSourceMovers
      .map((entry) => String(entry?.ticker || '').trim().toUpperCase())
      .filter(Boolean);
    const summary = {
      ok: true,
      key: phaseKey,
      scannedAt: phaseResult.scannedAt,
      assetCount: Number(this.marketScannerState.assetCount || phaseResult.assetCount || 0),
      flaggedCount: Array.isArray(this.marketScannerState.flaggedMovers) ? this.marketScannerState.flaggedMovers.length : 0,
      flaggedMovers: canonicalFlaggedMovers,
      topMovers: canonicalTopMovers,
      alerts: gatedAlerts,
      alertGate: {
        policy: 'ordi_pattern_source_gate',
        rawAlertCount: canonicalAlerts.length,
        rawUrgentCount: rawUrgentSourceMovers.length,
        qualifiedCount: qualifiedByTicker.size,
        suppressedCount: Array.isArray(alertGateResult.suppressedMovers) ? alertGateResult.suppressedMovers.length : 0,
        decisions: Array.isArray(alertGateResult.decisions) ? alertGateResult.decisions.slice(0, 10) : [],
      },
      urgentPromotedSymbols,
      notified: false,
    };
    this.marketScannerState = marketScannerModule.normalizeMarketScannerState({
      ...this.marketScannerState,
      lastResult: {
        scannedAt: summary.scannedAt,
        assetCount: summary.assetCount,
        flaggedCount: summary.flaggedCount,
        flaggedMovers: summary.flaggedMovers,
        topMovers: summary.topMovers,
        alerts: summary.alerts,
        urgentMovers: gatedUrgentSourceMovers,
        urgentPromotedSymbols,
        alertGate: summary.alertGate,
      },
    });
    try {
      summary.predictionsScored = predictionTrackerModule.scorePredictions(
        this.buildPredictionPriceMap(this.marketScannerState.assets)
      );
      if (summary.predictionsScored > 0) {
        this.logger.info(`[PREDICTION TRACKER] Scored ${summary.predictionsScored} matured prediction checks during ${phaseKey}.`);
      }
    } catch (error) {
      this.logger.warn(`Prediction scoring failed during ${phaseKey}: ${error?.message || String(error)}`);
      summary.predictionsScored = 0;
    }
    const promotionResult = this.promoteMarketScannerMovers(summary.topMovers, phaseResult.scannedAt);
    summary.promotedSymbols = Array.isArray(promotionResult?.promotedTickers) ? promotionResult.promotedTickers : [];
    summary.refreshedSymbols = Array.isArray(promotionResult?.refreshedTickers) ? promotionResult.refreshedTickers : [];
    try {
      const regimeResult = await oracleWatchRegime.applySharedShortRegime({
        marketScannerState: this.marketScannerState,
        movers: canonicalFlaggedMovers.length > 0 ? canonicalFlaggedMovers : canonicalTopMovers,
        rulesPath: this.oracleWatchRulesPath,
        watchStatePath: this.oracleWatchStatePath,
        statePath: this.oracleShortRegimeStatePath,
      });
      this.lastOracleShortRegimeSummary = regimeResult;
      summary.sharedShortRegime = {
        active: regimeResult?.active === true,
        candidateCount: Number(regimeResult?.candidateCount || 0),
        promotedTickers: Array.isArray(regimeResult?.promotedTickers) ? regimeResult.promotedTickers : [],
        promotedRuleIds: Array.isArray(regimeResult?.promotedRuleIds) ? regimeResult.promotedRuleIds : [],
        retiredRuleIds: Array.isArray(regimeResult?.retiredRuleIds) ? regimeResult.retiredRuleIds : [],
        statePath: this.oracleShortRegimeStatePath,
      };
    } catch (error) {
      summary.sharedShortRegime = {
        active: false,
        error: error?.message || String(error),
        statePath: this.oracleShortRegimeStatePath,
      };
      this.logger.warn(`Oracle shared short regime update failed: ${error?.message || String(error)}`);
    }
    if (summary.alerts.length > 0) {
      this.notifyArchitectInternal(this.buildMarketScannerArchitectAlert(summary), 'market_scanner');
      summary.notified = true;
    }
    const urgentMovers = (await this.filterExecutableMarketScannerMovers(gatedUrgentSourceMovers)).slice(0, 6);
    summary.urgentMovers = urgentMovers;
    if (urgentMovers.length > 0) {
      const urgentPromotionResult = this.promoteMarketScannerMovers(urgentMovers, phaseResult.scannedAt);
      const promotedUrgentTickers = Array.isArray(urgentPromotionResult?.promotedTickers)
        ? urgentPromotionResult.promotedTickers
        : [];
      const refreshedUrgentTickers = Array.isArray(urgentPromotionResult?.refreshedTickers)
        ? urgentPromotionResult.refreshedTickers
        : [];
      summary.urgentPromotedSymbols = Array.from(new Set([
        ...urgentPromotedSymbols,
        ...promotedUrgentTickers,
        ...refreshedUrgentTickers,
      ]));
      summary.urgentRefreshedSymbols = refreshedUrgentTickers;
      const triggerDecision = this.shouldTriggerImmediateMarketScannerConsultation(urgentMovers, phaseResult.scannedAt);
      summary.immediateConsultationEligibility = triggerDecision.reason;
      if (triggerDecision.shouldTrigger && !this.marketScannerImmediateConsultationEnabled) {
        summary.immediateConsultation = {
          ok: false,
          skipped: true,
          reason: 'market_scanner_immediate_consultation_disabled',
        };
      } else if (triggerDecision.shouldTrigger) {
        const nowIso = new Date().toISOString();
        const urgentSymbols = urgentMovers.map((entry) => entry.ticker).filter(Boolean);
        this.marketScannerLastTrigger = {
          at: nowIso,
          trigger: 'market_scanner',
          symbols: urgentSymbols,
          fingerprint: triggerDecision.fingerprint,
        };
        summary.immediateConsultation = await this.triggerImmediateCryptoConsensus({
          key: 'market_scanner_trigger',
          label: `Market scanner movers: ${urgentMovers.map((entry) => entry.coin).join(', ')}`,
          marketDate: nowIso.slice(0, 10),
          scheduledAt: nowIso,
          symbols: urgentSymbols,
          symbolLimit: this.cryptoConsultationSymbolMax,
          trigger: 'market_scanner',
        }, {
          trigger: 'market_scanner',
        });
      } else {
        summary.immediateConsultation = {
          ok: false,
          skipped: true,
          reason: triggerDecision.reason,
        };
      }
    }
    return summary;
  }

  async maybeRunMarketScannerAutomation(nowMs = Date.now()) {
    if (!this.marketScannerEnabled || this.stopping || !this.marketScanner || typeof this.marketScanner.runMarketScan !== 'function') {
      return { ok: false, skipped: true, reason: 'market_scanner_disabled' };
    }
    const manualActivity = this.getActive[private-live-ops]ManualActivity(nowMs);
    if (manualActivity) {
      this.lastMarketScannerSummary = {
        enabled: true,
        status: 'paused_for_manual_activity',
        intervalMinutes: this.marketScannerIntervalMinutes,
        lastProcessedAt: this.marketScannerState.lastProcessedAt || null,
        nextEvent: this.marketScannerState.nextEvent || null,
        manualActivity,
      };
      return {
        ok: true,
        skipped: true,
        reason: 'manual_[private-live-ops]_activity',
        manualActivity,
      };
    }
    if (this.marketScannerPhasePromise) {
      this.lastMarketScannerSummary = {
        enabled: true,
        status: 'running',
        intervalMinutes: this.marketScannerIntervalMinutes,
        lastProcessedAt: this.marketScannerState.lastProcessedAt || null,
        nextEvent: this.marketScannerState.nextEvent || null,
      };
      return {
        ok: false,
        skipped: true,
        reason: 'market_scanner_running',
        nextEvent: this.marketScannerState.nextEvent || null,
      };
    }

    const now = nowMs instanceof Date ? nowMs : new Date(nowMs);
    const nextEvent = getNextMarketScannerEvent(now, {
      intervalMinutes: this.marketScannerIntervalMinutes,
    });
    const day = buildMarketScannerDailySchedule(now, {
      intervalMinutes: this.marketScannerIntervalMinutes,
    });
    const lastProcessedAtMs = this.marketScannerState.lastProcessedAt
      ? new Date(this.marketScannerState.lastProcessedAt).getTime()
      : 0;
    const dueEvents = day.schedule.filter((entry) => {
      const scheduledAtMs = new Date(entry.scheduledAt).getTime();
      return scheduledAtMs <= now.getTime() && scheduledAtMs > lastProcessedAtMs;
    });
    const latestDueEvent = dueEvents.length > 0 ? dueEvents[dueEvents.length - 1] : null;

    this.marketScannerState.nextEvent = this.describeTradingEvent(nextEvent);
    this.persistMarketScannerState();

    if (!latestDueEvent) {
      this.lastMarketScannerSummary = {
        enabled: true,
        status: 'scheduled',
        intervalMinutes: this.marketScannerIntervalMinutes,
        lastProcessedAt: this.marketScannerState.lastProcessedAt || null,
        nextEvent: this.marketScannerState.nextEvent,
      };
      return { ok: false, skipped: true, reason: 'no_due_market_scan', nextEvent: this.marketScannerState.nextEvent };
    }

    this.lastMarketScannerSummary = {
      enabled: true,
      status: 'running',
      intervalMinutes: this.marketScannerIntervalMinutes,
      lastProcessedAt: this.marketScannerState.lastProcessedAt || null,
      nextEvent: this.marketScannerState.nextEvent,
    };

    this.marketScannerPhasePromise = (async () => {
      const phaseResult = await this.runMarketScannerPhase(latestDueEvent);
      this.marketScannerState.lastProcessedAt = latestDueEvent.scheduledAt;
      this.marketScannerState.lastResult = phaseResult;
      this.marketScannerState.lastScan = phaseResult;
      this.persistMarketScannerState();

      const upcomingEvent = getNextMarketScannerEvent(new Date(), {
        intervalMinutes: this.marketScannerIntervalMinutes,
      });
      this.marketScannerState.nextEvent = this.describeTradingEvent(upcomingEvent);
      this.persistMarketScannerState();
      this.lastMarketScannerSummary = {
        enabled: true,
        status: phaseResult.degraded ? 'scan_degraded' : (phaseResult.notified ? 'alert_sent' : 'scan_complete'),
        intervalMinutes: this.marketScannerIntervalMinutes,
        lastProcessedAt: this.marketScannerState.lastProcessedAt || null,
        nextEvent: this.marketScannerState.nextEvent,
        lastResult: phaseResult,
      };

      return { ok: true, skipped: false, executed: [phaseResult], nextEvent: this.marketScannerState.nextEvent };
    })().catch((err) => {
      this.lastMarketScannerSummary = {
        enabled: true,
        status: 'failed',
        intervalMinutes: this.marketScannerIntervalMinutes,
        lastProcessedAt: this.marketScannerState.lastProcessedAt || null,
        nextEvent: this.marketScannerState.nextEvent || null,
        lastError: err.message,
      };
      this.logger.warn(`Market scanner automation phase failed: ${err.message}`);
      return {
        ok: false,
        skipped: false,
        error: err.message,
        nextEvent: this.marketScannerState.nextEvent || null,
      };
    }).finally(() => {
      this.marketScannerPhasePromise = null;
    });

    return {
      ok: true,
      skipped: false,
      started: true,
      reason: 'market_scanner_started',
      nextEvent: this.marketScannerState.nextEvent,
    };
  }

  async run[private-profile]CheckInPhase(event) {
    const scannedAt = new Date().toISOString();
    const dashboard = this.readCaseOperationsDashboard();
    const pendingItems = Array.isArray(dashboard.pendingItems) ? dashboard.pendingItems : [];
    const private-profileItems = pendingItems.filter((item) => /은별 input|은별 action|은별/i.test(String(item.blockedOn || '')));
    const commsRows = await Promise.resolve(this.proactiveCommsProvider()).catch(() => []);
    const lastMessageAtMs = getLatest[private-profile]MessageTimestamp(commsRows);
    const silenceMs = lastMessageAtMs > 0 ? Math.max(0, Date.parse(scannedAt) - lastMessageAtMs) : Number.POSITIVE_INFINITY;
    const shouldDraft = private-profileItems.length > 0 && silenceMs >= this.private-profileCheckInSilenceMs;
    const topItems = private-profileItems.slice(0, 4).map((item) => item.item);
    const draft = shouldDraft
      ? this.build[private-profile]CheckInDraft({ topItems })
      : null;
    const fingerprint = draft ? JSON.stringify({ topItems, lastMessageAtMs }) : null;
    const summary = {
      ok: true,
      key: event?.key || 'private-profile_checkin',
      scannedAt,
      pendingCount: private-profileItems.length,
      lastMessageAt: lastMessageAtMs > 0 ? new Date(lastMessageAtMs).toISOString() : null,
      silenceHours: Number.isFinite(silenceMs) ? Number((silenceMs / (60 * 60 * 1000)).toFixed(2)) : null,
      drafted: Boolean(draft),
      topItems,
      draft,
      alertLevel: 'level_0',
      notified: false,
    };
    if (fingerprint) {
      this.private-profileCheckInState.lastDraftFingerprint = fingerprint;
      this.private-profileCheckInState.lastDraft = {
        createdAt: scannedAt,
        message: draft,
        topItems,
      };
      this.notifyArchitectInternal(this.build[private-profile]CheckInArchitectAlert(summary), 'private-profile_checkin');
      summary.notified = true;
    }
    return summary;
  }

  async maybeRun[private-profile]CheckInAutomation(nowMs = Date.now()) {
    if (!this.private-profileCheckInEnabled || this.stopping) {
      return { ok: false, skipped: true, reason: 'private-profile_checkin_disabled' };
    }
    if (this.private-profileCheckInPhasePromise) {
      return this.private-profileCheckInPhasePromise;
    }

    const now = nowMs instanceof Date ? nowMs : new Date(nowMs);
    const nextEvent = getNext[private-profile]CheckInEvent(now, {
      intervalMinutes: this.private-profileCheckInIntervalMinutes,
    });
    const day = build[private-profile]CheckInDailySchedule(now, {
      intervalMinutes: this.private-profileCheckInIntervalMinutes,
    });
    const lastProcessedAtMs = this.private-profileCheckInState.lastProcessedAt
      ? new Date(this.private-profileCheckInState.lastProcessedAt).getTime()
      : 0;
    const dueEvents = day.schedule.filter((event) => {
      const scheduledAtMs = new Date(event.scheduledAt).getTime();
      return scheduledAtMs <= now.getTime() && scheduledAtMs > lastProcessedAtMs;
    });

    this.private-profileCheckInState.nextEvent = this.describeTradingEvent(nextEvent);
    this.persist[private-profile]CheckInState();

    if (dueEvents.length === 0) {
      this.last[private-profile]CheckInSummary = {
        enabled: true,
        status: 'scheduled',
        intervalMinutes: this.private-profileCheckInIntervalMinutes,
        lastProcessedAt: this.private-profileCheckInState.lastProcessedAt || null,
        nextEvent: this.private-profileCheckInState.nextEvent,
      };
      return { ok: false, skipped: true, reason: 'no_due_private-profile_checkin', nextEvent: this.private-profileCheckInState.nextEvent };
    }

    this.private-profileCheckInPhasePromise = (async () => {
      const executed = [];
      for (const dueEvent of dueEvents) {
        const phaseResult = await this.run[private-profile]CheckInPhase(dueEvent);
        executed.push(phaseResult);
        this.private-profileCheckInState.lastProcessedAt = dueEvent.scheduledAt;
        this.private-profileCheckInState.lastResult = phaseResult;
        this.persist[private-profile]CheckInState();
      }

      const upcomingEvent = getNext[private-profile]CheckInEvent(new Date(), {
        intervalMinutes: this.private-profileCheckInIntervalMinutes,
      });
      this.private-profileCheckInState.nextEvent = this.describeTradingEvent(upcomingEvent);
      this.persist[private-profile]CheckInState();
      this.last[private-profile]CheckInSummary = {
        enabled: true,
        status: executed.some((entry) => entry.drafted) ? 'draft_ready' : 'scan_complete',
        intervalMinutes: this.private-profileCheckInIntervalMinutes,
        lastProcessedAt: this.private-profileCheckInState.lastProcessedAt || null,
        nextEvent: this.private-profileCheckInState.nextEvent,
        lastResult: executed[executed.length - 1] || null,
      };

      return { ok: true, skipped: false, executed, nextEvent: this.private-profileCheckInState.nextEvent };
    })().finally(() => {
      this.private-profileCheckInPhasePromise = null;
    });

    return this.private-profileCheckInPhasePromise;
  }

  getTradeReconciliationOrchestrator() {
    return this.tradingOrchestrator || null;
  }

  hasActiveTradingPhase() {
    return Boolean(this.tradingPhasePromise || this.cryptoTradingPhasePromise);
  }

  getTradeReconciliationMarketDate(referenceDate = new Date()) {
    if (this.tradingState.marketDate) {
      return this.tradingState.marketDate;
    }
    return getDateKeyInTimeZone(referenceDate, tradingScheduler.MARKET_TIME_ZONE);
  }

  async maybeRunTradeReconciliation(nowMs = Date.now()) {
    if (this.stopping) {
      return { ok: false, skipped: true, reason: 'stopping' };
    }
    if (this.tradeReconciliationPromise) {
      return this.tradeReconciliationPromise;
    }

    const orchestrator = this.getTradeReconciliationOrchestrator();
    if (!orchestrator || typeof orchestrator.runReconciliation !== 'function') {
      this.lastTradeReconciliationSummary = {
        enabled: false,
        status: 'disabled',
        marketDate: this.tradingState.marketDate || null,
        pendingCount: 0,
        lastProcessedAt: this.tradeReconciliationState.lastProcessedAt || null,
        lastResult: this.tradeReconciliationState.lastResult || null,
        lastError: this.tradeReconciliationState.lastError || null,
      };
      return { ok: false, skipped: true, reason: 'reconciliation_disabled' };
    }
    if (typeof orchestrator.getPendingReconciliationTrades !== 'function') {
      return { ok: false, skipped: true, reason: 'pending_trade_lookup_unavailable' };
    }
    if (this.hasActiveTradingPhase()) {
      return { ok: false, skipped: true, reason: 'trading_phase_busy' };
    }

    const now = nowMs instanceof Date ? nowMs : new Date(nowMs);
    const marketDate = this.getTradeReconciliationMarketDate(now);
    const processedAt = now.toISOString();
    const pendingTrades = orchestrator.getPendingReconciliationTrades({ date: marketDate });
    const pendingCount = Array.isArray(pendingTrades) ? pendingTrades.length : 0;

    if (pendingCount === 0) {
      this.tradeReconciliationState.lastPendingCount = 0;
      this.lastTradeReconciliationSummary = {
        enabled: true,
        status: 'idle',
        marketDate,
        pendingCount: 0,
        lastProcessedAt: this.tradeReconciliationState.lastProcessedAt || null,
        lastResult: this.tradeReconciliationState.lastResult || null,
        lastError: this.tradeReconciliationState.lastError || null,
      };
      return { ok: false, skipped: true, reason: 'no_pending_trades', marketDate, pendingTrades: false, pendingCount: 0 };
    }

    const lastProcessedAtMs = this.tradeReconciliationState.lastProcessedAt
      ? new Date(this.tradeReconciliationState.lastProcessedAt).getTime()
      : 0;
    const elapsedMs = lastProcessedAtMs > 0 ? (now.getTime() - lastProcessedAtMs) : Number.POSITIVE_INFINITY;
    if (elapsedMs < this.tradeReconciliationPollMs) {
      const nextDueInMs = Math.max(0, this.tradeReconciliationPollMs - elapsedMs);
      this.tradeReconciliationState.lastPendingCount = pendingCount;
      this.lastTradeReconciliationSummary = {
        enabled: true,
        status: 'waiting',
        marketDate,
        pendingCount,
        lastProcessedAt: this.tradeReconciliationState.lastProcessedAt || null,
        nextDueAt: new Date(now.getTime() + nextDueInMs).toISOString(),
        lastResult: this.tradeReconciliationState.lastResult || null,
        lastError: this.tradeReconciliationState.lastError || null,
      };
      return {
        ok: false,
        skipped: true,
        reason: 'interval_guard',
        marketDate,
        pendingTrades: true,
        pendingCount,
        nextDueInMs,
      };
    }

    this.tradeReconciliationPromise = Promise.resolve(orchestrator.runReconciliation({ date: marketDate }))
      .then((result) => {
        const remainingTrades = orchestrator.getPendingReconciliationTrades({ date: marketDate });
        const remainingPendingCount = Array.isArray(remainingTrades) ? remainingTrades.length : 0;
        this.tradeReconciliationState = {
          lastProcessedAt: processedAt,
          lastPendingCount: remainingPendingCount,
          lastResult: {
            marketDate: result?.marketDate || marketDate,
            orderUpdates: Array.isArray(result?.orderUpdates) ? result.orderUpdates.length : 0,
            recordedOutcomes: Array.isArray(result?.recordedOutcomes) ? result.recordedOutcomes.length : 0,
            asOf: result?.asOf || new Date().toISOString(),
          },
          lastError: null,
        };
        this.lastTradeReconciliationSummary = {
          enabled: true,
          status: 'completed',
          marketDate: result?.marketDate || marketDate,
          pendingCount: remainingPendingCount,
          lastProcessedAt: this.tradeReconciliationState.lastProcessedAt,
          lastResult: this.tradeReconciliationState.lastResult,
          lastError: null,
        };
        this.logger.info(
          `Trade reconciliation completed for ${marketDate}: `
            + `pending=${pendingCount} updates=${this.tradeReconciliationState.lastResult.orderUpdates} `
            + `outcomes=${this.tradeReconciliationState.lastResult.recordedOutcomes} `
            + `remaining=${remainingPendingCount}`
        );
        return {
          ok: true,
          skipped: false,
          marketDate,
          pendingTrades: remainingPendingCount > 0,
          pendingCount,
          remainingPendingCount,
          result,
        };
      })
      .catch((err) => {
        this.tradeReconciliationState.lastError = err.message;
        this.tradeReconciliationState.lastPendingCount = pendingCount;
        this.lastTradeReconciliationSummary = {
          enabled: true,
          status: 'failed',
          marketDate,
          pendingCount,
          lastProcessedAt: this.tradeReconciliationState.lastProcessedAt || null,
          lastResult: this.tradeReconciliationState.lastResult || null,
          lastError: err.message,
        };
        this.logger.warn(`Trade reconciliation failed for ${marketDate}: ${err.message}`);
        return {
          ok: false,
          skipped: false,
          marketDate,
          pendingTrades: true,
          pendingCount,
          error: err.message,
        };
      })
      .finally(() => {
        this.tradeReconciliationPromise = null;
      });

    return this.tradeReconciliationPromise;
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
        this.executeHmSendSync([target, message], phaseKey);
      } catch (err) {
        this.logger.warn(`Trading notify failed for ${target} during ${phaseKey}: ${err.message}`);
      }
    }
  }

  notifyAllTradingAgents(message, reason = 'monitor') {
    const text = String(message || '').trim();
    if (!text) return;
    for (const target of TRADING_AGENT_TARGETS) {
      try {
        this.executeHmSendSync([target, text], reason);
      } catch (err) {
        this.logger.warn(`Trading notify failed for ${target} during ${reason}: ${err.message}`);
      }
    }
  }

  notifyArchitectInternal(message, reason = 'proactive') {
    const text = String(message || '').trim();
    if (!text) return;
    try {
      this.executeHmSendSync(['architect', text], reason);
    } catch (err) {
      this.logger.warn(`Architect internal notify failed during ${reason}: ${err.message}`);
    }
  }

  notifyOracleWatchLane(message, reason = 'oracle_watch') {
    const text = String(message || '').trim();
    if (!text) return;
    for (const target of ['architect', 'oracle']) {
      try {
        this.executeHmSendSync([target, text], reason);
      } catch (err) {
        this.logger.warn(`Oracle watch notify failed for ${target} during ${reason}: ${err.message}`);
      }
    }
  }

  maybeAlertOracleWatchHeartbeat(heartbeat = null) {
    const ageMs = Number(heartbeat?.ageMs);
    const intervalMs = Math.max(
      5_000,
      Number(heartbeat?.intervalMs || this.oracleWatchIntervalMs || DEFAULT_ORACLE_WATCH_INTERVAL_MS) || DEFAULT_ORACLE_WATCH_INTERVAL_MS
    );
    const staleThresholdMs = Math.max(ORACLE_WATCH_STALE_ALERT_THRESHOLD_MS, intervalMs * 2);
    const isStale = Boolean(
      this.oracleWatchEnabled
      && heartbeat?.stale === true
      && Number.isFinite(ageMs)
      && ageMs >= staleThresholdMs
    );

    if (isStale && !this.oracleWatchStaleAlertActive) {
      const seconds = Math.round(ageMs / 1000);
      const lastTickAt = String(heartbeat?.lastTickAt || 'unknown');
      this.notifyOracleWatchLane(
        `(SUPERVISOR): Oracle watch heartbeat stale for ${seconds}s. lastTickAt=${lastTickAt}. Expected roughly every ${Math.round(intervalMs / 1000)}s. Oracle trigger lane is blind until this recovers.`,
        'stale'
      );
      this.oracleWatchStaleAlertActive = true;
      return;
    }

    if (!isStale && this.oracleWatchStaleAlertActive) {
      const lastTickAt = String(heartbeat?.lastTickAt || new Date().toISOString());
      this.notifyOracleWatchLane(
        `(SUPERVISOR): Oracle watch heartbeat recovered. lastTickAt=${lastTickAt}. Oracle trigger lane is live again.`,
        'recovered'
      );
      this.oracleWatchStaleAlertActive = false;
    }
  }

  notifyTelegramTrading(message) {
    // Suppress old trading alerts while manual trading mode is active
    // TODO: Re-enable when conviction engine is live-ready
    if (process.env.SQUIDRUN_SUPPRESS_TRADING_ALERTS === '1') {
      this.logger.info(`Trading alert suppressed (manual mode): ${message.slice(0, 80)}...`);
      return;
    }
    const chatId = String(this.runtimeEnv?.TELEGRAM_CHAT_ID || '').trim();
    if (!chatId) {
      this.logger.warn('Trading Telegram notify suppressed: TELEGRAM_CHAT_ID is not configured.');
      return;
    }
    try {
      this.executeHmSendSync(['telegram', message, '--chat-id', chatId], 'telegram_trading');
    } catch (err) {
      this.logger.warn(`Trading Telegram notify failed: ${err.message}`);
    }
  }

  async run[private-live-ops]PositionMonitorCycle(trigger = 'manual') {
    if (!this.[private-live-ops]MonitorEnabled || !this.[private-live-ops]MonitorOrchestrator) {
      return {
        enabled: false,
        status: 'disabled',
        trigger,
        checkedAt: null,
        warnings: [],
        telegramAlerts: [],
      };
    }
    const checkedAt = new Date().toISOString();
    const manualActivity = this.getActive[private-live-ops]ManualActivity();
    if (manualActivity) {
      const pausedResult = {
        ok: true,
        skipped: true,
        reason: 'manual_[private-live-ops]_activity',
        trigger,
        checkedAt,
        positions: [],
        warnings: [],
        telegramAlerts: [],
        manualActivity,
      };
      this.last[private-live-ops]MonitorSummary = {
        enabled: true,
        status: 'paused_for_manual_activity',
        trigger,
        pollMs: this.[private-live-ops]MonitorPollMs,
        checkedAt,
        warnings: [],
        telegramAlerts: [],
        positions: [],
        peakStatePath: this.defiPeakPnlPath,
        riskExit: { attempted: false, reason: 'manual_activity_pause', executions: [] },
        manualActivity,
        error: null,
      };
      this.writeStatus();
      return pausedResult;
    }

    const result = await this.[private-live-ops]MonitorOrchestrator.runDefiMonitorCycle({
      trigger,
      sendTelegram: false,
    });
    const riskExit = trigger === 'startup'
      ? { attempted: false, reason: 'startup_grace', executions: [] }
      : await this.maybeExecute[private-live-ops]RiskExit(result, {
        trigger,
        checkedAt: result?.checkedAt || new Date().toISOString(),
      });
    this.last[private-live-ops]MonitorSummary = {
      enabled: true,
      status: result?.ok === false ? 'error' : 'ok',
      trigger,
      pollMs: this.[private-live-ops]MonitorPollMs,
      checkedAt: result?.checkedAt || null,
      warnings: Array.isArray(result?.warnings) ? result.warnings : [],
      telegramAlerts: Array.isArray(result?.telegramAlerts) ? result.telegramAlerts : [],
      positions: Array.isArray(result?.positions) ? result.positions : [],
      peakStatePath: result?.peakStatePath || this.defiPeakPnlPath,
      riskExit,
      error: result?.error || null,
    };

    if (result?.ok === false && result?.error) {
      this.logger.warn(`[private-live-ops] monitor failed (${trigger}): ${result.error}`);
    }
    if (this.cryptoTradingStrategyMode === 'range_conviction') {
      await this.maybeRunRangeConvictionCycle({
        trigger: `monitor_${trigger}`,
      }).catch(() => null);
    }

    this.writeStatus();
    return result;
  }

  getActive[private-live-ops]ManualActivity(nowMs = Date.now()) {
    const activity = readManual[private-live-ops]Activity(this.[private-live-ops]ManualActivityPath);
    if (!isManual[private-live-ops]ActivityActive(activity, { nowMs })) {
      return null;
    }
    return {
      command: String(activity.command || '[private-live-ops]_manual'),
      caller: String(activity.caller || 'manual'),
      pid: Number(activity.pid) || null,
      startedAt: activity.startedAt || null,
      lastHeartbeatAt: activity.lastHeartbeatAt || null,
      expiresAt: activity.expiresAt || null,
      metadata: activity.metadata && typeof activity.metadata === 'object' ? activity.metadata : {},
    };
  }

  async sync[private-live-ops]PeakStateFromAccountState(accountState = {}, options = {}) {
    if (!this.[private-live-ops]MonitorOrchestrator || typeof this.[private-live-ops]MonitorOrchestrator.syncDefiPeakStateFromStatus !== 'function') {
      return null;
    }
    try {
      return await this.[private-live-ops]MonitorOrchestrator.syncDefiPeakStateFromStatus({
        ok: true,
        checkedAt: options.checkedAt || new Date().toISOString(),
        accountValue: toNumber(accountState?.accountValue, 0),
        positions: Array.isArray(accountState?.positions) ? accountState.positions : [],
      }, {
        trigger: options.trigger || 'execution_snapshot',
        sendTelegram: options.sendTelegram === true,
      });
    } catch (error) {
      this.logger.warn(`[private-live-ops] peak-state sync failed (${options.trigger || 'execution_snapshot'}): ${error?.message || String(error)}`);
      return null;
    }
  }

  async maybeExecute[private-live-ops]RiskExit(monitorResult = {}, options = {}) {
    const positions = Array.isArray(monitorResult?.positions) ? monitorResult.positions : [];
    const executions = [];

    for (const position of positions) {
      const drawdown = Number(position?.drawdownFromPeakPct || 0);
      const previousAlertThreshold = Number(position?.previousGivebackAlertThreshold || 0);
      if (drawdown >= 0.3 && previousAlertThreshold < 0.3) {
        this.notifyTelegramTrading(this.build[private-live-ops]GivebackAlert(position));
      }

      const reasons = [];
      if (this.shouldTrigger[private-live-ops]Stop(position)) {
        reasons.push('stop_loss_crossed');
      }
      const peakPnl = toNumber(position?.peakUnrealizedPnl, 0);
      const timeOpenMs = toNumber(position?.timeOpenMs, 0);
      // giveback_75 DISABLED — killed the user's profitable BLUR trade on a normal pullback. Session 268.
      // if (drawdown >= 0.75 && peakPnl >= 5 && timeOpenMs >= 1200000) {
      //   reasons.push('giveback_75');
      // }
      const warningLevel = String(position?.warningLevel || '').trim().toLowerCase();
      if (warningLevel === 'critical') {
        reasons.push('liquidation_risk');
      }
      if (reasons.length === 0) {
        continue;
      }

      const summary = {
        asset: position.coin,
        ok: true,
        reasons,
        position: this.summarize[private-live-ops]Position(position),
        execution: null,
      };
      executions.push(summary);
      this.logger.warn(`[TradeLog] [private-live-ops] risk exit requires manual action for ${position.coin} ${position.side} | reasons: ${reasons.join('+')} | pnl: $${toNumber(position?.unrealizedPnl, 0).toFixed(2)} | entry: ${position.entryPx} | mark: ${position.markPrice}`);
      this.notifyTelegramTrading(this.build[private-live-ops]ManualActionAlert(position, reasons));
    }

    if (!executions.length) {
      return { attempted: false, reason: 'no_risk_exit_signal', executions: [] };
    }

    return {
      attempted: false,
      ok: true,
      reason: 'manual_only_alerted',
      executions,
    };
  }

  start[private-live-ops]PositionMonitor() {
    if (!this.[private-live-ops]MonitorEnabled || this.[private-live-ops]MonitorTimer) {
      return;
    }
    this.[private-live-ops]MonitorPromise = this.run[private-live-ops]PositionMonitorCycle('startup')
      .catch((error) => {
        this.logger.warn(`[private-live-ops] startup monitor failed: ${error.message}`);
        return { ok: false, error: error.message };
      })
      .finally(() => {
        this.[private-live-ops]MonitorPromise = null;
      });
    this.[private-live-ops]MonitorTimer = setInterval(() => {
      if (this.[private-live-ops]MonitorPromise) {
        return;
      }
      this.[private-live-ops]MonitorPromise = this.run[private-live-ops]PositionMonitorCycle('interval')
        .catch((error) => {
          this.logger.warn(`[private-live-ops] interval monitor failed: ${error.message}`);
          return { ok: false, error: error.message };
        })
        .finally(() => {
          this.[private-live-ops]MonitorPromise = null;
        });
    }, this.[private-live-ops]MonitorPollMs);
    if (typeof this.[private-live-ops]MonitorTimer.unref === 'function') {
      this.[private-live-ops]MonitorTimer.unref();
    }
  }

  async stop[private-live-ops]PositionMonitor() {
    if (this.[private-live-ops]MonitorTimer) {
      clearInterval(this.[private-live-ops]MonitorTimer);
      this.[private-live-ops]MonitorTimer = null;
    }
    if (this.[private-live-ops]MonitorPromise) {
      await Promise.resolve(this.[private-live-ops]MonitorPromise).catch(() => {});
      this.[private-live-ops]MonitorPromise = null;
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

  async getCurrent[private-live-ops]PositionSymbols() {
    const sources = [];
    const liveAccountState = await Promise.resolve(
      this.[private-live-ops]Executor?.getAccountState?.()
    ).catch(() => null);
    if (Array.isArray(liveAccountState?.positions) && liveAccountState.positions.length > 0) {
      sources.push(...liveAccountState.positions);
    } else {
      const fallbackPositions = await [private-live-ops]Client.getOpenPositions({
        env: this.runtimeEnv,
      }).catch(() => []);
      if (Array.isArray(fallbackPositions) && fallbackPositions.length > 0) {
        sources.push(...fallbackPositions);
      }
    }
    return Array.from(new Set(
      sources
        .map((position) => normalizeNewsTicker(position?.ticker || position?.coin || ''))
        .filter((ticker) => /\/USD$/i.test(ticker))
    ));
  }

  async maybeRunPositionAttributionReconciliation(nowMs = Date.now()) {
    const checkedAt = new Date(nowMs).toISOString();
    if (!this.positionAttributionReconciliationEnabled) {
      return {
        ok: false,
        skipped: true,
        enabled: false,
        reason: this.lastPositionAttributionReconciliationSummary?.status || 'position_attribution_reconciliation_disabled',
        checkedAt,
        statePath: this.positionAttributionStatePath,
      };
    }

    const walletAddress = resolve[private-live-ops]WalletAddress(this.runtimeEnv);
    try {
      const livePositions = this.positionAttributionSnapshotProvider
        ? await Promise.resolve(this.positionAttributionSnapshotProvider({ walletAddress, env: this.runtimeEnv, nowMs }))
        : await [private-live-ops]Client.getOpenPositions({ walletAddress, env: this.runtimeEnv });
      const reconcileSummary = agentPositionAttribution.reconcilePositionAttributionWithLivePositions(
        Array.isArray(livePositions) ? livePositions : [],
        {
          statePath: this.positionAttributionStatePath,
          walletAddress,
          nowIso: checkedAt,
        }
      );
      const summary = {
        enabled: true,
        status: 'ok',
        ...reconcileSummary,
        checkedAt,
        statePath: reconcileSummary.path || this.positionAttributionStatePath,
      };
      this.lastPositionAttributionReconciliationSummary = summary;
      if (summary.createdCount > 0 || summary.quarantinedCount > 0) {
        this.logger.info(
          `Position attribution reconciled: live=${summary.liveCount}, created=${summary.createdCount}, quarantined=${summary.quarantinedCount}`
        );
      }
      return summary;
    } catch (error) {
      const message = error?.message || String(error);
      const summary = {
        ok: false,
        enabled: true,
        status: 'error',
        checkedAt,
        statePath: this.positionAttributionStatePath,
        error: message,
      };
      this.lastPositionAttributionReconciliationSummary = summary;
      this.emitRateLimitedLog({
        key: 'position-attribution-reconciliation-failed',
        level: 'warn',
        message: `Position attribution reconciliation failed: ${message}`,
        state: message,
      });
      return summary;
    }
  }

  async getCryptoSymbolCandidates(options = {}) {
    const openPositionSymbols = await this.getCurrent[private-live-ops]PositionSymbols();
    const prioritySymbols = (Array.isArray(options.prioritySymbols) ? options.prioritySymbols : [])
      .map((ticker) => String(ticker || '').trim().toUpperCase())
      .filter((ticker) => /\/USD$/i.test(ticker));
    const rankedMovers = await this.rankConsultationMovers(
      (Array.isArray(this.marketScannerState?.topMovers) ? this.marketScannerState.topMovers : [])
        .filter((entry) => entry?.flagged === true)
    );
    const baseSymbols = Array.from(new Set([
      ...openPositionSymbols,
      ...CORE_CRYPTO_CONSULTATION_SYMBOLS,
      ...prioritySymbols,
    ]));
    const requestedLimit = Math.max(
      baseSymbols.length,
      Math.floor(Number(options.limit) || this.cryptoConsultationSymbolMax)
    );
    const baseSymbolSet = new Set(baseSymbols);
    const moverSymbols = rankedMovers
      .map((entry) => String(entry?.ticker || '').trim().toUpperCase())
      .filter((ticker) => /\/USD$/i.test(ticker) && !baseSymbolSet.has(ticker))
      .slice(0, Math.min(this.marketScannerConsultationSymbolLimit, Math.max(0, requestedLimit - baseSymbols.length)));
    const promotedSymbols = dynamicWatchlist.getActiveEntries({
      statePath: this.dynamicWatchlistStatePath,
      assetClass: 'crypto',
      source: 'market_scanner',
    })
      .map((entry) => String(entry?.ticker || '').trim().toUpperCase())
      .filter((ticker) => /\/USD$/i.test(ticker) && !baseSymbolSet.has(ticker) && !moverSymbols.includes(ticker))
      .slice(0, Math.max(0, requestedLimit - baseSymbols.length - moverSymbols.length));
    const orderedSymbols = [...baseSymbols, ...moverSymbols, ...promotedSymbols];
    const symbolsExecutable = orderedSymbols.filter((ticker) => this.is[private-live-ops]ConsensusTicker(ticker));
    this.lastCryptoCoverage = {
      basketBuiltAt: new Date().toISOString(),
      openPositionSymbols,
      coreSymbols: [...CORE_CRYPTO_CONSULTATION_SYMBOLS],
      prioritySymbols,
      moverSymbols,
      rankedMovers: rankedMovers.slice(0, this.marketScannerConsultationSymbolLimit).map((entry) => ({
        ticker: entry?.ticker || null,
        score: entry?.score ?? null,
        consultationRankScore: entry?.consultationRankScore ?? null,
        consultationBoost: entry?.consultationBoost ?? 0,
        fundingBoostEligible: entry?.fundingBoostEligible === true,
        fundingDivergenceBps: entry?.fundingDivergenceBps ?? null,
        fundingBoostTier: entry?.fundingBoostTier || 'none',
      })),
      promotedSymbols,
      symbolsConsulted: orderedSymbols,
      symbolsExecutable,
    };
    return orderedSymbols;
  }

  async buildRangeConvictionSelection(symbols = [], options = {}) {
    const candidates = (Array.isArray(symbols) ? symbols : [])
      .map((ticker) => String(ticker || '').trim().toUpperCase())
      .filter((ticker) => /\/USD$/i.test(ticker));
    if (candidates.length === 0) {
      return {
        selectedTicker: null,
        rangeStructures: new Map(),
        ranked: [],
      };
    }

    const [bars5m, bars15m, bars1h, accountState] = await Promise.all([
      [private-live-ops]Client.getHistoricalBars({
        symbols: candidates,
        timeframe: '5Min',
        limit: 72,
      }).catch(() => new Map()),
      [private-live-ops]Client.getHistoricalBars({
        symbols: candidates,
        timeframe: '15Min',
        limit: 48,
      }).catch(() => new Map()),
      [private-live-ops]Client.getHistoricalBars({
        symbols: candidates,
        timeframe: '1Hour',
        limit: 24,
      }).catch(() => new Map()),
      this.[private-live-ops]Executor?.getAccountState?.().catch(() => null),
    ]);

    const positionsByCoin = new Map(
      (Array.isArray(accountState?.positions) ? accountState.positions : [])
        .filter((position) => position?.coin)
        .map((position) => [String(position.coin || '').trim().toUpperCase(), position])
    );
    const rankedMovers = Array.isArray(this.lastCryptoCoverage?.rankedMovers) ? this.lastCryptoCoverage.rankedMovers : [];
    const moverByTicker = new Map(
      rankedMovers
        .map((entry) => [String(entry?.ticker || '').trim().toUpperCase(), entry])
        .filter(([ticker]) => ticker)
    );
    const rangeStructures = new Map();
    const evaluationRows = [];

    for (const ticker of candidates) {
      const structure = rangeStructure.analyzeRangeStructure({
        bars5m: bars5m instanceof Map ? (bars5m.get(ticker) || []) : [],
        bars15m: bars15m instanceof Map ? (bars15m.get(ticker) || []) : [],
        bars1h: bars1h instanceof Map ? (bars1h.get(ticker) || []) : [],
      });
      rangeStructures.set(ticker, structure);
      const position = positionsByCoin.get(String(ticker).replace('/USD', '')) || null;
      evaluationRows.push({
        ticker,
        structure,
        change4hPct: moverByTicker.get(ticker)?.change4hPct ?? null,
        hasOpenPosition: Boolean(position),
        openPosition: position,
      });
    }

    const selection = convictionEngine.chooseDominantSetup(evaluationRows);
    const activeRow = evaluationRows.find((entry) => entry?.hasOpenPosition && entry?.ticker === selection.selectedTicker)
      || evaluationRows.find((entry) => entry?.hasOpenPosition)
      || null;
    const positionAction = convictionEngine.resolvePositionAction(
      selection,
      activeRow?.openPosition || null,
      {
        ticker: activeRow?.ticker || selection.selectedTicker || null,
        structure: activeRow?.structure
          || (selection.selectedTicker ? rangeStructures.get(selection.selectedTicker) : null)
          || selection?.dominant?.structure
          || null,
      }
    );
    const selectedTicker = activeRow?.ticker || selection.selectedTicker || null;
    this.lastRangeConvictionSelection = {
      selectedTicker,
      selectedDirection: activeRow?.openPosition
        ? (String(activeRow.openPosition.side || '').trim().toLowerCase() === 'short' ? 'SELL' : 'BUY')
        : selection.selectedDirection,
      confidence: selection.confidence,
      action: positionAction?.action || null,
      rationale: positionAction?.rationale || null,
      invalidationPrice: Number(positionAction?.invalidationPrice || 0) || null,
      targetPrice: Number(positionAction?.targetPrice || 0) || null,
      activePosition: activeRow ? this.summarize[private-live-ops]Position(activeRow.openPosition) : null,
      ranked: (selection.ranked || []).slice(0, 5).map((entry) => ({
        ticker: entry.ticker,
        direction: entry.setup?.direction || null,
        score: entry.score,
        confidence: entry.setup?.confidence ?? null,
      })),
      computedAt: new Date().toISOString(),
    };

    return {
      ...selection,
      selectedTicker,
      rangeStructures,
      activePosition: activeRow?.openPosition || null,
      positionAction,
    };
  }

  async getCryptoSymbols(options = {}) {
    const prioritySymbols = (Array.isArray(options.prioritySymbols) ? options.prioritySymbols : [])
      .map((ticker) => String(ticker || '').trim().toUpperCase())
      .filter((ticker) => /\/USD$/i.test(ticker));
    if (options.forceSelection === true && prioritySymbols.length > 0) {
      return prioritySymbols.slice(0, 1);
    }

    const candidates = await this.getCryptoSymbolCandidates(options);
    if (this.cryptoTradingStrategyMode !== 'range_conviction') {
      return candidates;
    }

    const selection = await this.buildRangeConvictionSelection(candidates, options);
    if (selection.selectedTicker) {
      this.lastCryptoCoverage = {
        ...(this.lastCryptoCoverage || {}),
        strategyMode: 'range_conviction',
        convictionSelection: this.lastRangeConvictionSelection,
      };
      return [selection.selectedTicker];
    }

    return candidates.slice(0, 1);
  }

  async rankConsultationMovers(entries = []) {
    const normalized = (Array.isArray(entries) ? entries : [])
      .map((entry) => marketScannerModule.normalizeMover(entry))
      .filter((entry) => entry?.flagged === true && /\/USD$/i.test(String(entry?.ticker || '').trim()));
    if (normalized.length === 0) return [];

    let nativeBundle = null;
    try {
      nativeBundle = await [private-live-ops]NativeLayer.buildNativeFeatureBundle({
        symbols: normalized.map((entry) => entry.ticker),
      });
    } catch (error) {
      const errorMessage = error?.message || String(error);
      this.emitRateLimitedLog({
        key: 'market-scanner-native-funding-unavailable',
        level: 'warn',
        message: `[market-scanner-rank] native funding boost unavailable: ${errorMessage}`,
        state: errorMessage,
      });
    }

    const nativeAsOfMs = Date.parse(nativeBundle?.asOf || '');
    const nowMs = Date.now();
    const nativeFundingFresh = Number.isFinite(nativeAsOfMs)
      && Math.max(0, nowMs - nativeAsOfMs) <= CONSULTATION_NATIVE_FUNDING_MAX_AGE_MS;
    const nativeFundingDegraded = Array.isArray(nativeBundle?.degradedSources)
      && nativeBundle.degradedSources.some((source) => String(source || '').startsWith('predictedFundings:'));
    const allowFundingBoost = nativeFundingFresh && !nativeFundingDegraded;

    return normalized
      .map((entry, index) => {
        const nativeEntry = nativeBundle?.symbols?.[entry.ticker] || null;
        const fundingDivergenceBps = Number(
          nativeEntry?.crossVenueFunding?.strongestVsHl?.absoluteSpreadBps
          ?? nativeEntry?.crossVenueFunding?.basisSpreadBps
        );
        let consultationBoost = 0;
        let fundingBoostTier = 'none';
        if (allowFundingBoost && Number.isFinite(fundingDivergenceBps) && fundingDivergenceBps >= CONSULTATION_FUNDING_DIVERGENCE_STRONG_BPS) {
          consultationBoost = CONSULTATION_FUNDING_DIVERGENCE_STRONG_BOOST;
          fundingBoostTier = 'strong';
        } else if (allowFundingBoost && Number.isFinite(fundingDivergenceBps) && fundingDivergenceBps >= CONSULTATION_FUNDING_DIVERGENCE_MILD_BPS) {
          consultationBoost = CONSULTATION_FUNDING_DIVERGENCE_MILD_BOOST;
          fundingBoostTier = 'mild';
        }
        return {
          ...entry,
          consultationOriginalIndex: index,
          fundingBoostEligible: allowFundingBoost,
          fundingDivergenceBps: Number.isFinite(fundingDivergenceBps) ? Number(fundingDivergenceBps.toFixed(4)) : null,
          fundingBoostTier,
          consultationBoost,
          consultationRankScore: Number((Number(entry?.score || 0) + consultationBoost).toFixed(4)),
        };
      })
      .sort((left, right) => {
        const rankDelta = Number(right?.consultationRankScore || 0) - Number(left?.consultationRankScore || 0);
        if (Math.abs(rankDelta) > 0.0000001) return rankDelta;
        const magnitudeDelta = Math.abs(Number(right?.change4hPct || 0)) - Math.abs(Number(left?.change4hPct || 0));
        if (Math.abs(magnitudeDelta) > 0.0000001) return magnitudeDelta;
        return Number(left?.consultationOriginalIndex || 0) - Number(right?.consultationOriginalIndex || 0);
      });
  }

  extractConsensusResultForTicker(consensusPhase, ticker) {
    const normalizedTicker = String(ticker || '').trim().toUpperCase();
    const results = Array.isArray(consensusPhase?.results) ? consensusPhase.results : [];
    return results.find((result) => String(result?.ticker || '').trim().toUpperCase() === normalizedTicker) || null;
  }

  summarize[private-live-ops]Position(position) {
    if (!position || !position.coin) return null;
    return {
      coin: position.coin,
      side: position.side,
      size: position.size,
      entryPx: position.entryPx,
      unrealizedPnl: position.unrealizedPnl,
      liquidationPx: position.liquidationPx,
    };
  }

  is[private-live-ops]ConsensusTicker(ticker) {
    return /\/USD$/i.test(String(ticker || '').trim());
  }

  getUrgentMarketScannerMovers(entries = []) {
    return (Array.isArray(entries) ? entries : [])
      .filter((entry) => {
        const change4hPct = Number(entry?.change4hPct);
        return entry?.flagged === true
          && Number.isFinite(change4hPct)
          && Math.abs(change4hPct) >= 0.015;
      })
      .slice()
      .sort((left, right) => Math.abs(Number(right?.change4hPct || 0)) - Math.abs(Number(left?.change4hPct || 0)));
  }

  buildMarketScannerTriggerFingerprint(entries = []) {
    return (Array.isArray(entries) ? entries : [])
      .map((entry) => String(entry?.ticker || '').trim().toUpperCase())
      .filter(Boolean)
      .sort()
      .join('|');
  }

  shouldTriggerImmediateMarketScannerConsultation(entries = [], scannedAt = null) {
    const fingerprint = this.buildMarketScannerTriggerFingerprint(entries);
    if (!fingerprint) {
      return {
        shouldTrigger: false,
        reason: 'no_urgent_market_scanner_movers',
        fingerprint: null,
      };
    }
    if (this.marketScannerLastTrigger?.fingerprint !== fingerprint) {
      return {
        shouldTrigger: true,
        reason: 'urgent_set_changed',
        fingerprint,
      };
    }
    const lastTriggeredAtMs = Date.parse(this.marketScannerLastTrigger?.at || '');
    const scannedAtMs = Date.parse(scannedAt || '');
    if (!Number.isFinite(lastTriggeredAtMs) || !Number.isFinite(scannedAtMs) || scannedAtMs > lastTriggeredAtMs) {
      return {
        shouldTrigger: false,
        reason: 'urgent_set_already_triggered',
        fingerprint,
      };
    }
    return {
      shouldTrigger: false,
      reason: 'urgent_set_duplicate_scan',
      fingerprint,
    };
  }

  async triggerImmediateCryptoConsensus(event, summary = {}) {
    if (!this.cryptoTradingOrchestrator) {
      return { ok: false, skipped: true, reason: 'crypto_trading_unavailable' };
    }
    if (this.cryptoTradingPhasePromise) {
      return { ok: false, skipped: true, reason: 'crypto_phase_busy' };
    }

    const trigger = String(summary.trigger || event?.key || 'manual').trim() || 'manual';
    const startedAt = new Date().toISOString();
    this.cryptoTradingPhasePromise = this.runCryptoConsensusPhase(event)
      .then((result) => {
        this.cryptoTradingState.lastProcessedAt = event?.scheduledAt || startedAt;
        this.cryptoTradingState.lastResult = result;
        this.persistCryptoTradingState();
        this.cryptoTradingState.nextEvent = this.cryptoTradingState.nextEvent || null;
        this.lastCryptoTradingSummary = {
          enabled: true,
          status: result?.ok ? 'completed' : 'failed',
          trigger,
          startedAt,
          lastProcessedAt: this.cryptoTradingState.lastProcessedAt || null,
          ...result,
        };
        this.writeStatus();
        return result;
      })
      .catch((err) => {
        this.logger.error(`Immediate crypto consensus (${trigger}) failed: ${err.message}`);
        return { ok: false, error: err.message, trigger };
      })
      .finally(() => {
        this.cryptoTradingPhasePromise = null;
      });
    return this.cryptoTradingPhasePromise;
  }

  syncRangeConvictionState(selection = null) {
    const thesis = selection
      ? {
        ticker: selection?.selectedTicker || null,
        action: selection?.positionAction?.action || null,
        rationale: selection?.positionAction?.rationale || null,
        confidence: Number(selection?.confidence || 0) || null,
        invalidationPrice: Number(selection?.positionAction?.invalidationPrice || 0) || null,
        targetPrice: Number(selection?.positionAction?.targetPrice || 0) || null,
        activePosition: selection?.activePosition ? this.summarize[private-live-ops]Position(selection.activePosition) : null,
        updatedAt: new Date().toISOString(),
      }
      : null;
    this.cryptoTradingState.activeConvictionThesis = thesis;
    this.persistCryptoTradingState();
    return thesis;
  }

  async executeRangeConvictionManagement(selection = {}, options = {}) {
    const positionAction = selection?.positionAction || null;
    const activePosition = selection?.activePosition || null;
    const action = String(positionAction?.action || '').trim().toLowerCase();
    if (!['abort_thesis', 'take_profit'].includes(action) || !activePosition) {
      return { ok: false, skipped: true, reason: 'range_conviction_no_management_action' };
    }
    const asset = String(activePosition.coin || selection?.selectedTicker || '').replace('/USD', '').trim().toUpperCase();
    if (!asset) {
      return { ok: false, skipped: true, reason: 'range_conviction_missing_asset' };
    }
    this.logger.warn(`[TradeLog] Range conviction ${action} flagged manual exit for ${asset} ${activePosition.side} | pnl: $${toNumber(activePosition?.unrealizedPnl, 0).toFixed(2)} | entry: ${activePosition.entryPx}`);
    this.notifyTelegramTrading(`[ACTION REQUIRED] Range conviction wants to ${action.replace('_', ' ')} ${asset} ${String(activePosition.side || '').toUpperCase()}. ${positionAction?.rationale || 'Thesis exit fired.'} PnL: $${toNumber(activePosition?.unrealizedPnl, 0).toFixed(2)}. Entry: $${activePosition.entryPx}. Manual-only reset is active, so the supervisor did not close it.`);
    return {
      attempted: false,
      ok: true,
      skipped: true,
      reason: 'manual_only_reset',
      action,
      rationale: positionAction?.rationale || null,
      asset,
      ticker: selection?.selectedTicker || `${asset}/USD`,
      position: this.summarize[private-live-ops]Position(activePosition),
      execution: null,
    };
  }

  async maybeRunRangeConvictionCycle(options = {}) {
    if (!this.cryptoTradingEnabled || this.stopping || !this.cryptoTradingOrchestrator) {
      return { ok: false, skipped: true, reason: 'crypto_trading_disabled' };
    }
    if (this.cryptoTradingStrategyMode !== 'range_conviction') {
      return { ok: false, skipped: true, reason: 'strategy_mode_not_range_conviction' };
    }
    if (this.cryptoTradingPhasePromise) {
      return { ok: false, skipped: true, reason: 'crypto_phase_busy' };
    }

    const nowMs = Date.now();
    if (options.force !== true && (nowMs - this.lastRangeConvictionRunAt) < this.rangeConvictionIntervalMs) {
      return {
        ok: false,
        skipped: true,
        reason: 'range_conviction_interval_guard',
      };
    }

    const candidates = await this.getCryptoSymbolCandidates({
      prioritySymbols: Array.isArray(options.prioritySymbols) ? options.prioritySymbols : [],
      limit: Math.max(CORE_CRYPTO_CONSULTATION_SYMBOLS.length, this.cryptoConsultationSymbolMax),
    });
    const selection = await this.buildRangeConvictionSelection(candidates, options);
    this.syncRangeConvictionState(selection);
    const positionAction = selection?.positionAction || null;
    if (selection?.activePosition) {
      this.lastRangeConvictionRunAt = nowMs;
      if (['abort_thesis', 'take_profit'].includes(String(positionAction?.action || '').trim().toLowerCase())) {
        const managed = await this.executeRangeConvictionManagement(selection, {
          trigger: String(options.trigger || 'range_conviction').trim() || 'range_conviction',
          checkedAt: new Date().toISOString(),
        });
        if (managed?.ok && options.reentryAfterManagement !== false) {
          const reentry = await this.maybeRunRangeConvictionCycle({
            ...options,
            trigger: `post_${positionAction.action}`,
            force: true,
            reentryAfterManagement: false,
          }).catch(() => null);
          return {
            ...managed,
            reentry,
          };
        }
        return managed;
      }
      return {
        ok: true,
        skipped: true,
        reason: positionAction?.action || 'range_conviction_position_managed',
        selection: this.lastRangeConvictionSelection,
      };
    }
    if (!selection.selectedTicker) {
      this.lastRangeConvictionRunAt = nowMs;
      return { ok: false, skipped: true, reason: 'no_range_conviction_setup' };
    }

    this.lastRangeConvictionRunAt = nowMs;
    const nowIso = new Date().toISOString();
    return this.triggerImmediateCryptoConsensus({
      key: 'range_conviction',
      label: `Range conviction: ${selection.selectedTicker}`,
      marketDate: nowIso.slice(0, 10),
      scheduledAt: nowIso,
      symbols: [selection.selectedTicker],
      symbolLimit: 1,
      strategyMode: 'range_conviction',
      forceSelection: true,
      trigger: String(options.trigger || 'range_conviction').trim() || 'range_conviction',
      rangeStructures: selection.rangeStructures,
      convictionSelection: this.lastRangeConvictionSelection,
    }, {
      trigger: options.trigger || 'range_conviction',
    });
  }

  build[private-live-ops]AutoExecutionSummary(autoExecution = {}, scheduledAt = null) {
    const executions = Array.isArray(autoExecution?.executions) ? autoExecution.executions : [];
    const firstAction = executions[0]?.action || null;
    return {
      enabled: Boolean(autoExecution?.enabled),
      status: executions.length === 0
        ? 'idle'
        : (executions.every((entry) => entry.ok !== false) ? 'completed' : 'failed'),
      dryRun: this.[private-live-ops]ExecutionDryRun,
      action: firstAction,
      reason: executions.length === 0
        ? 'no_consensus_execution'
        : executions.filter((entry) => entry.ok === false).map((entry) => entry.error || entry.stderr || 'execution_failed').filter(Boolean).join(' | ') || 'executed',
      executedAt: scheduledAt || new Date().toISOString(),
      executions,
    };
  }

  build[private-live-ops]GivebackAlert(position) {
    const drawdownPct = Number(position?.drawdownFromPeakPct || 0);
    const stopLossText = position?.stopLossVerifiedAt
      && Number.isFinite(Number(position?.stopLossPrice)) && Number(position.stopLossPrice) > 0
      ? ` stop=$${Number(position.stopLossPrice).toFixed(4)}`
      : '';
    return `[TRADING] [private-live-ops] ${position.coin} ${String(position.side || '').toUpperCase()} has given back ${(drawdownPct * 100).toFixed(0)}% of peak PnL. Current=$${toNumber(position?.unrealizedPnl, 0).toFixed(2)} peak=$${toNumber(position?.peakUnrealizedPnl, 0).toFixed(2)} mark=$${toNumber(position?.markPrice, 0).toFixed(4)}.${stopLossText}`;
  }

  build[private-live-ops]ManualActionAlert(position = {}, reasons = []) {
    const reasonText = Array.isArray(reasons) && reasons.length > 0 ? reasons.join('+') : 'risk_exit_signal';
    const stopLossText = position?.stopLossVerifiedAt
      && Number.isFinite(Number(position?.stopLossPrice)) && Number(position.stopLossPrice) > 0
      ? ` stop=$${Number(position.stopLossPrice).toFixed(4)}`
      : '';
    return `[ACTION REQUIRED] [private-live-ops] ${position.coin} ${String(position.side || '').toUpperCase()} hit ${reasonText}. Current=$${toNumber(position?.unrealizedPnl, 0).toFixed(2)} entry=$${toNumber(position?.entryPx, 0).toFixed(4)} mark=$${toNumber(position?.markPrice, 0).toFixed(4)}.${stopLossText} Manual-only reset is active, so the supervisor did not close it.`;
  }

  shouldTrigger[private-live-ops]Stop(position = {}) {
    const stopLossPrice = Number(position?.stopLossPrice);
    const markPrice = Number(position?.markPrice);
    const side = String(position?.side || '').trim().toLowerCase();
    if (!position?.stopLossVerifiedAt || !Number.isFinite(stopLossPrice) || stopLossPrice <= 0 || !Number.isFinite(markPrice) || markPrice <= 0) {
      return false;
    }
    if (side === 'short') {
      return markPrice >= stopLossPrice;
    }
    if (side === 'long') {
      return markPrice <= stopLossPrice;
    }
    return false;
  }

  resolve[private-live-ops]EthDirective(consensusPhase, approvedTrades = []) {
    const ethConsensus = this.extractConsensusResultForTicker(consensusPhase, 'ETH/USD');
    const approvedEthTrade = (Array.isArray(approvedTrades) ? approvedTrades : []).find((trade) => {
      return String(trade?.ticker || '').trim().toUpperCase() === 'ETH/USD';
    }) || null;
    const decision = String(ethConsensus?.decision || '').trim().toUpperCase();

    if (!ethConsensus || ethConsensus.consensus !== true || !decision) {
      return {
        action: 'none',
        reason: 'no_eth_consensus',
        consensus: ethConsensus,
        approvedTrade: approvedEthTrade,
      };
    }

    if (decision === 'BUY' || decision === 'COVER') {
      return {
        action: 'close_position',
        reason: 'eth_bullish_consensus',
        consensus: ethConsensus,
        approvedTrade: approvedEthTrade,
      };
    }

    if ((decision === 'SELL' || decision === 'SHORT') && approvedEthTrade) {
      return {
        action: 'open_short',
        reason: 'eth_bearish_consensus_approved',
        consensus: ethConsensus,
        approvedTrade: approvedEthTrade,
      };
    }

    if (decision === 'SELL' || decision === 'SHORT') {
      return {
        action: 'none',
        reason: 'eth_sell_not_approved',
        consensus: ethConsensus,
        approvedTrade: approvedEthTrade,
      };
    }

    return {
      action: 'none',
      reason: 'eth_non_actionable_consensus',
      consensus: ethConsensus,
      approvedTrade: approvedEthTrade,
    };
  }

  async run[private-live-ops]ExecutionPhase({ scheduledAt, marketDate, consensusPhase, approvedTrades = [] } = {}) {
    const phase = '[private-live-ops]_execution';
    if (this.manualTradingOnly && !this.[private-live-ops]ScalpModeArmed) {
      const accountState = typeof this.[private-live-ops]Executor?.getAccountState === 'function'
        ? await Promise.resolve(this.[private-live-ops]Executor.getAccountState()).catch(() => null)
        : null;
      const ethPosition = Array.isArray(accountState?.positions)
        ? accountState.positions.find((position) => position.coin === 'ETH' && position.side !== 'flat')
        : null;
      await this.sync[private-live-ops]PeakStateFromAccountState(accountState || {}, {
        trigger: '[private-live-ops]_execution_none',
        checkedAt: scheduledAt || new Date().toISOString(),
        sendTelegram: false,
      });
      const result = {
        ok: true,
        skipped: true,
        phase,
        scheduledAt,
        marketDate,
        action: 'none',
        reason: 'manual_only_reset',
        signal: null,
        approvedTrade: null,
        accountValue: toNumber(accountState?.accountValue, 0),
        position: this.summarize[private-live-ops]Position(ethPosition),
        execution: null,
      };
      this.last[private-live-ops]ExecutionSummary = {
        enabled: false,
        status: 'manual_only',
        dryRun: this.[private-live-ops]ExecutionDryRun,
        accountValue: result.accountValue,
        position: result.position,
        action: result.action,
        reason: result.reason,
        executedAt: scheduledAt || new Date().toISOString(),
        signal: result.signal,
      };
      return result;
    }
    if (!this.[private-live-ops]ExecutionEnabled || !this.[private-live-ops]Executor) {
      return {
        ok: false,
        skipped: true,
        phase,
        reason: '[private-live-ops]_disabled',
      };
    }

    const directive = this.resolve[private-live-ops]EthDirective(consensusPhase, approvedTrades);
    let accountState = await this.[private-live-ops]Executor.getAccountState();
    let ethPosition = Array.isArray(accountState?.positions)
      ? accountState.positions.find((position) => position.coin === 'ETH' && position.side !== 'flat')
      : null;
    const positionSummary = this.summarize[private-live-ops]Position(ethPosition);
    let result = {
      ok: true,
      skipped: true,
      phase,
      scheduledAt,
      marketDate,
      action: 'none',
      reason: directive.reason,
      signal: directive.consensus
        ? {
          ticker: directive.consensus.ticker,
          decision: directive.consensus.decision,
          confidence: directive.consensus.confidence,
          agreementCount: directive.consensus.agreementCount,
        }
        : null,
      approvedTrade: directive.approvedTrade
        ? {
          ticker: directive.approvedTrade.ticker,
          decision: directive.approvedTrade.consensus?.decision || null,
          maxShares: directive.approvedTrade.riskCheck?.maxShares ?? null,
        }
        : null,
      accountValue: toNumber(accountState?.accountValue, 0),
      position: positionSummary,
      execution: null,
    };

    if (directive.action === 'open_short') {
      if (ethPosition?.side === 'short') {
        result.reason = 'eth_short_already_open';
      } else if (ethPosition?.side === 'long') {
        result.reason = 'eth_long_position_present';
      } else {
        const execution = await this.[private-live-ops]Executor.openEthShort({
          scheduledAt,
          marketDate,
          consensus: directive.consensus,
        });
        result = {
          ...result,
          ok: execution?.ok !== false,
          skipped: false,
          action: 'open_short',
          reason: execution?.ok !== false ? directive.reason : (execution?.error || execution?.stderr || 'open_short_failed'),
          execution,
        };
        if (execution?.ok !== false) {
          accountState = await this.[private-live-ops]Executor.getAccountState();
          ethPosition = Array.isArray(accountState?.positions)
            ? accountState.positions.find((position) => position.coin === 'ETH' && position.side !== 'flat')
            : null;
          result.accountValue = toNumber(accountState?.accountValue, 0);
          result.position = this.summarize[private-live-ops]Position(ethPosition);
        }
      }
    } else if (directive.action === 'close_position') {
      // AUTO-CLOSE DISABLED: agents manage exits manually
      this.logger.info('[[private-live-ops]Execution] close_position directive BLOCKED — agents manage exits manually');
      result.reason = 'auto_close_disabled_agent_managed';
      result.skipped = true;
      if (false) { // dead code — original close logic disabled
        const execution = await this.[private-live-ops]Executor.closeEthPosition({
          scheduledAt,
          marketDate,
          consensus: directive.consensus,
        });
        result = {
          ...result,
          ok: execution?.ok !== false,
          skipped: false,
          action: 'close_position',
          reason: execution?.ok !== false ? directive.reason : (execution?.error || execution?.stderr || 'close_position_failed'),
          execution,
        };
        if (execution?.ok !== false) {
          accountState = await this.[private-live-ops]Executor.getAccountState();
          ethPosition = Array.isArray(accountState?.positions)
            ? accountState.positions.find((position) => position.coin === 'ETH' && position.side !== 'flat')
            : null;
          result.accountValue = toNumber(accountState?.accountValue, 0);
          result.position = this.summarize[private-live-ops]Position(ethPosition);
        }
      }
    }

    await this.sync[private-live-ops]PeakStateFromAccountState(accountState, {
      trigger: `[private-live-ops]_execution_${result.action || 'none'}`,
      checkedAt: scheduledAt || new Date().toISOString(),
      sendTelegram: false,
    });

    this.last[private-live-ops]ExecutionSummary = {
      enabled: true,
      status: result.ok ? (result.skipped ? 'idle' : 'completed') : 'failed',
      dryRun: this.[private-live-ops]ExecutionDryRun,
      accountValue: result.accountValue,
      position: result.position,
      action: result.action,
      reason: result.reason,
      executedAt: scheduledAt || new Date().toISOString(),
      signal: result.signal,
    };
    return result;
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
    const strategyMode = String(event?.strategyMode || this.cryptoTradingStrategyMode || 'momentum').trim().toLowerCase() || 'momentum';
    if (!phaseKey || !scheduledAt || !this.cryptoTradingOrchestrator) {
      return { ok: false, phase: phaseKey || 'unknown', error: 'crypto_phase_unavailable' };
    }
    this.logTradingEventHeader(phaseKey);
    const cryptoSymbols = await this.getCryptoSymbols({
      prioritySymbols: Array.isArray(event?.symbols) ? event.symbols : [],
      limit: event?.symbolLimit,
      forceSelection: event?.forceSelection === true,
    });
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
        macroRisk = {
          regime: 'red',
          score: 100,
          constraints: {
            allowLongs: false,
            blockNewPositions: true,
            positionSizeMultiplier: 0.25,
            buyConfidenceMultiplier: 0.75,
            sellConfidenceMultiplier: 1.0,
          },
          reason: 'macro gate error defensive fallback',
        };
      }
      this.runOilMonitorCheck(phaseKey, macroRisk?.indicators?.oilPrice);

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
        strategyMode,
        rangeStructures: event?.rangeStructures || null,
        convictionSelection: event?.convictionSelection || this.lastRangeConvictionSelection || null,
        limits: tradingRiskEngine.DEFAULT_CRYPTO_LIMITS,
        whaleTransfers: whaleTransfers.length > 0 ? whaleTransfers : undefined,
        macroRisk,
        autoExecuteLiveConsensus: false,
        [private-live-ops]ExecutionDryRun: this.[private-live-ops]ExecutionDryRun,
        [private-live-ops]ExecutionEnv: this.runtimeEnv,
        [private-live-ops]ExecuteScriptPath: this.hmDefiExecuteScriptPath,
        [private-live-ops]CloseScriptPath: this.hmDefiCloseScriptPath,
        [private-live-ops]ExecutionLeverage: this.[private-live-ops]ExecutionLeverage,
      });

      let approved = Array.isArray(consensusPhase?.approvedTrades) ? consensusPhase.approvedTrades : [];
      // Macro risk should cap size, not double-compress an already vetoed/MTF-scaled trade.
      approved = applyMacroRiskSizeCapToApprovedTrades(approved, macroRisk);

      const [private-live-ops]ScalpExecutionEnabled = this.[private-live-ops]ExecutionEnabled
        && this.[private-live-ops]ScalpModeArmed
        && !this.cryptoMonitorOnly;

      if (this.cryptoMonitorOnly) {
        if (approved.length > 0) {
          this.logger.info(`Crypto automation is monitor-only: skipping execution for ${approved.length} approved trade(s)`);
        }
        approved = [];
      } else if (this.manualTradingOnly && ![private-live-ops]ScalpExecutionEnabled && approved.length > 0) {
        this.logger.info(`Crypto automation is manual-only: supervisor will not execute ${approved.length} approved trade(s)`);
      }
      consensusPhase.approvedTrades = approved;
      try {
        const predictionsLogged = this.logConsensusPredictions(consensusPhase);
        this.logger.info(`[PREDICTION TRACKER] Logged ${predictionsLogged} consultation predictions for ${phaseKey}.`);
      } catch (error) {
        this.logger.warn(`Prediction logging failed during ${phaseKey}: ${error?.message || String(error)}`);
      }
      const actionableCount = approved.length;
      const approvedForMarketOpen = (this.manualTradingOnly && ![private-live-ops]ScalpExecutionEnabled)
        ? []
        : approved;

      const [private-live-ops]Execution = typeof this.cryptoTradingOrchestrator.maybeAutoExecuteLiveConsensus === 'function'
        ? await this.cryptoTradingOrchestrator.maybeAutoExecuteLiveConsensus(
          [private-live-ops]ScalpExecutionEnabled ? [] : consensusPhase?.results,
          [private-live-ops]ScalpExecutionEnabled ? [] : approved,
          consensusPhase?.defiStatus || {},
          {
            autoExecuteLiveConsensus: this.[private-live-ops]ExecutionEnabled && !this.cryptoMonitorOnly && (!this.manualTradingOnly || this.[private-live-ops]ScalpModeArmed),
            [private-live-ops]ExecutionDryRun: this.[private-live-ops]ExecutionDryRun,
            [private-live-ops]ExecutionEnv: this.runtimeEnv,
            [private-live-ops]ExecuteScriptPath: this.hmDefiExecuteScriptPath,
            [private-live-ops]CloseScriptPath: this.hmDefiCloseScriptPath,
            [private-live-ops]ExecutionLeverage: this.[private-live-ops]ExecutionLeverage,
            [private-live-ops]ScalpModeArmed: this.[private-live-ops]ScalpModeArmed,
            [private-live-ops]KillSwitchAction: this.[private-live-ops]KillSwitchAction,
            killSwitchTriggered: consensusPhase?.killSwitch?.triggered === true,
            defiPeakPnlPath: this.defiPeakPnlPath,
          }
        )
        : {
          enabled: false,
          attempted: 0,
          succeeded: 0,
          executions: [],
          skipped: [],
        };

      // Execute non-[private-live-ops] approved trades immediately after [private-live-ops] sizing/execution is settled.
      let executionResult = null;
      if (approvedForMarketOpen.length > 0) {
        this.logger.info(`Crypto consensus approved ${approvedForMarketOpen.length} executable trades — executing immediately`);
        executionResult = await this.cryptoTradingOrchestrator.runMarketOpen({
          date: scheduledAt,
          assetClass: 'crypto',
          consensusPhase,
          approvedTrades: approvedForMarketOpen,
          allow[private-live-ops]LiveExecution: [private-live-ops]ScalpExecutionEnabled,
          [private-live-ops]ScalpModeArmed: this.[private-live-ops]ScalpModeArmed,
          [private-live-ops]ExecutionDryRun: this.[private-live-ops]ExecutionDryRun,
          [private-live-ops]ExecutionEnv: this.runtimeEnv,
          [private-live-ops]ExecuteScriptPath: this.hmDefiExecuteScriptPath,
          [private-live-ops]CloseScriptPath: this.hmDefiCloseScriptPath,
          [private-live-ops]ExecutionLeverage: this.[private-live-ops]ExecutionLeverage,
        });
        const execCount = Array.isArray(executionResult?.executions) ? executionResult.executions.length : 0;
        const fills = (executionResult?.executions || []).filter((e) => e.execution?.ok);
        this.logger.info(`Crypto execution: ${fills.length}/${execCount} orders filled`);
      }

      if ([private-live-ops]Execution?.attempted > 0 && typeof this.[private-live-ops]Executor?.getAccountState === 'function') {
        const accountState = await Promise.resolve(this.[private-live-ops]Executor.getAccountState()).catch(() => null);
        if (accountState) {
          await this.sync[private-live-ops]PeakStateFromAccountState(accountState, {
            trigger: 'consensus_auto_execution',
            checkedAt: scheduledAt,
            sendTelegram: false,
          });
        }
        this.last[private-live-ops]ExecutionSummary = this.build[private-live-ops]AutoExecutionSummary([private-live-ops]Execution, scheduledAt);
        this.logger.info(
          `[private-live-ops] auto-execution ${[private-live-ops]Execution.succeeded}/${[private-live-ops]Execution.attempted} completed`
        );
      } else {
        this.last[private-live-ops]ExecutionSummary = this.build[private-live-ops]AutoExecutionSummary([private-live-ops]Execution, scheduledAt);
      }

      return {
        ok: true,
        phase: phaseKey,
        marketDate: event.marketDate || '',
        scheduledAt,
        preMarket,
        macroRisk: { regime: macroRisk.regime, score: macroRisk.score, reason: macroRisk.reason },
        execution: executionResult,
        [private-live-ops]Execution,
        summary: {
          strategyMode,
          symbols: cryptoSymbols.length,
          symbolsConsulted: this.lastCryptoCoverage.symbolsConsulted,
          symbolsExecutable: this.lastCryptoCoverage.symbolsExecutable,
          convictionSelection: event?.convictionSelection || this.lastRangeConvictionSelection || null,
          trigger: String(event?.trigger || phaseKey || 'scheduled'),
          approvedTrades: actionableCount,
          rejectedTrades: Array.isArray(consensusPhase?.rejectedTrades) ? consensusPhase.rejectedTrades.length : 0,
          incompleteSignals: Array.isArray(consensusPhase?.incompleteSignals) ? consensusPhase.incompleteSignals.length : 0,
          executedTrades: executionResult ? (executionResult.executions || []).filter((e) => e.execution?.ok).length : 0,
          [private-live-ops]Action: [private-live-ops]Execution?.executions?.[0]?.action || 'none',
          [private-live-ops]Executed: Number([private-live-ops]Execution?.succeeded || 0) > 0,
          monitorOnly: this.cryptoMonitorOnly,
          manualOnly: this.manualTradingOnly,
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
    if (this.manualTradingOnly) {
      this.lastTradingSummary = {
        enabled: false,
        status: 'manual_only',
        reason: 'manual_only_reset',
        marketDate: null,
        sleeping: true,
        nextEvent: null,
      };
      return { ok: false, skipped: true, reason: 'manual_only_reset' };
    }
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
    if (this.cryptoTradingStrategyMode === 'range_conviction') {
      return this.maybeRunRangeConvictionCycle({
        trigger: 'range_conviction_loop',
      });
    }
    if (this.cryptoTradingPhasePromise) {
      this.lastCryptoTradingSummary = {
        enabled: true,
        status: 'running',
        symbolsConsulted: this.lastCryptoCoverage.symbolsConsulted,
        symbolsExecutable: this.lastCryptoCoverage.symbolsExecutable,
        lastProcessedAt: this.cryptoTradingState.lastProcessedAt || null,
        nextEvent: this.cryptoTradingState.nextEvent || null,
      };
      return {
        ok: false,
        skipped: true,
        reason: 'crypto_phase_running',
        nextEvent: this.cryptoTradingState.nextEvent || null,
      };
    }

    const cryptoSymbols = await this.getCryptoSymbols();
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
        symbolsConsulted: this.lastCryptoCoverage.symbolsConsulted,
        symbolsExecutable: this.lastCryptoCoverage.symbolsExecutable,
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
        symbolsConsulted: this.lastCryptoCoverage.symbolsConsulted,
        symbolsExecutable: this.lastCryptoCoverage.symbolsExecutable,
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

    this.lastCryptoTradingSummary = {
      enabled: true,
      status: 'running',
      symbolsConsulted: this.lastCryptoCoverage.symbolsConsulted,
      symbolsExecutable: this.lastCryptoCoverage.symbolsExecutable,
      lastProcessedAt: this.cryptoTradingState.lastProcessedAt || null,
      nextEvent: this.cryptoTradingState.nextEvent,
    };

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
        symbolsConsulted: this.lastCryptoCoverage.symbolsConsulted,
        symbolsExecutable: this.lastCryptoCoverage.symbolsExecutable,
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
    })().catch((err) => {
      this.lastCryptoTradingSummary = {
        enabled: true,
        status: 'phase_failed',
        symbolsConsulted: this.lastCryptoCoverage.symbolsConsulted,
        symbolsExecutable: this.lastCryptoCoverage.symbolsExecutable,
        lastProcessedAt: this.cryptoTradingState.lastProcessedAt || null,
        nextEvent: this.cryptoTradingState.nextEvent || null,
        error: err.message,
      };
      this.logger.warn(`Crypto trading automation phase failed: ${err.message}`);
      return {
        ok: false,
        skipped: false,
        error: err.message,
        nextEvent: this.cryptoTradingState.nextEvent || null,
      };
    }).finally(() => {
      this.cryptoTradingPhasePromise = null;
    });

    return {
      ok: true,
      skipped: false,
      started: true,
      reason: 'crypto_phase_started',
      nextEvent: this.cryptoTradingState.nextEvent,
    };
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
      this.emitMemoryConsistencyLog(
        reason,
        message,
        this.lastMemoryConsistencySummary.synced,
        nowMs
      );
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
      this.emitRateLimitedLog({
        key: 'memory-consistency-failed',
        level: 'warn',
        message: `Memory consistency (${reason}) failed: ${err.message}`,
        state: err.message,
        intervalMs: this.memoryConsistencyRepeatLogMs,
        nowMs,
      });
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
    if (Array.isArray(paths.caseEvidenceDirs)) {
      for (const evidenceDir of paths.caseEvidenceDirs) {
        if (fs.existsSync(evidenceDir)) {
          targets.push(path.join(evidenceDir, '**', '*'));
        }
      }
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
        this.emitRateLimitedLog({
          key: 'memory-index-refresh-failed',
          level: 'warn',
          message: `Memory index refresh failed: ${err.message}`,
          state: err.message,
          intervalMs: this.memoryIndexRepeatLogMs,
        });
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
        this.emitMemoryIndexRefreshLog(reason, result);
        return result;
      })
      .catch((err) => {
        this.emitRateLimitedLog({
          key: 'memory-index-refresh-failed',
          level: 'warn',
          message: `Memory index refresh (${reason}) failed: ${err.message}`,
          state: err.message,
          intervalMs: this.memoryIndexRepeatLogMs,
        });
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
      // Per-file event logs were noisy in the pane when a burst of memory
      // files saved. The aggregate "Memory index refresh complete: ..." line
      // still fires once per debounced batch and is the useful signal.
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
    const oracleWatchState = readJsonFile(this.oracleWatchStatePath, {}) || {};
    const oracleWatchHeartbeat = buildOracleWatchHeartbeat(this.lastOracleWatchSummary, oracleWatchState);
    this.maybeAlertOracleWatchHeartbeat(oracleWatchHeartbeat);
    const dailyTargetProgress = getTodayRealizedTargetProgress(resolveRuntimePath('trade-journal.db'));
    const pairsScanned = Number(
      this.marketScannerState?.assetCount
      || this.lastMarketScannerSummary?.lastResult?.assetCount
      || 0
    );
    const symbolsConsulted = Array.isArray(this.lastCryptoCoverage?.symbolsConsulted)
      ? this.lastCryptoCoverage.symbolsConsulted
      : [];
    const symbolsExecutable = Array.isArray(this.lastCryptoCoverage?.symbolsExecutable)
      ? this.lastCryptoCoverage.symbolsExecutable
      : [];
    const macroRiskPolicy = {
      green: macroRiskGate._internals?.regimeConstraints?.('green') || null,
      yellow: macroRiskGate._internals?.regimeConstraints?.('yellow') || null,
      red: macroRiskGate._internals?.regimeConstraints?.('red') || null,
      stay_cash: macroRiskGate._internals?.regimeConstraints?.('stay_cash') || null,
    };
    const cryptoHardCapFloorPct = 0.35;
    const configuredCryptoMaxPositionPct = Number(
      this.cryptoTradingOrchestrator?.options?.limits?.maxPositionPct
      ?? tradingRiskEngine.DEFAULT_CRYPTO_LIMITS.maxPositionPct
    );
    const configuredCryptoStopLossPct = Number(
      this.cryptoTradingOrchestrator?.options?.limits?.stopLossPct
      ?? tradingRiskEngine.DEFAULT_CRYPTO_LIMITS.stopLossPct
    );
    const cryptoConsultationPolicy = {
      coreSymbols: [...CORE_CRYPTO_CONSULTATION_SYMBOLS],
      consultationSymbolMax: this.cryptoConsultationSymbolMax,
      marketScannerSymbolLimit: this.marketScannerConsultationSymbolLimit,
      minAgreeConfidence: Number(
        this.cryptoTradingOrchestrator?.options?.minAgreeConfidence
        ?? this.cryptoTradingOrchestrator?.options?.minConfidence
        ?? DEFAULT_LIVE_MIN_AGREE_CONFIDENCE
      ),
        autoExecuteMinConfidence: Number(
          this.cryptoTradingOrchestrator?.options?.autoExecuteMinConfidence
          ?? DEFAULT_AUTO_EXECUTE_MIN_CONFIDENCE
        ),
      };
    const cryptoRiskPolicy = {
      configuredMaxPositionPct: configuredCryptoMaxPositionPct,
      hardCapFloorPct: cryptoHardCapFloorPct,
      effectiveHardCapPct: Math.max(
        Number.isFinite(configuredCryptoMaxPositionPct) ? configuredCryptoMaxPositionPct : 0,
        cryptoHardCapFloorPct
      ),
      configuredStopLossPct: configuredCryptoStopLossPct,
      confidenceRiskFloorPct: 0.005,
      confidenceRiskCeilingPct: 0.02,
    };
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
      pairsScanned,
      symbolsConsulted,
      symbolsExecutable,
      macroRiskPolicy,
      cryptoConsultationPolicy,
      cryptoRiskPolicy,
      dailyTargetProgress,
      agentTaskQueue: {
        enabled: this.agentTaskQueueEnabled,
        path: this.agentTaskQueuePath,
        idleCompletionMs: this.agentTaskIdleCompletionMs,
        readyGraceMs: this.agentTaskReadyGraceMs,
        historyLimit: this.agentTaskHistoryLimit,
        reengageIdleMs: this.agentTaskReengageIdleMs,
        lastSummary: this.lastAgentTaskQueueSummary || null,
      },
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
        manualOnly: this.manualTradingOnly,
        running: Boolean(this.tradingPhasePromise),
        statePath: this.tradingStatePath,
        marketDate: this.tradingState.marketDate || null,
        sleeping: this.tradingState.sleeping !== false,
        phases: this.tradingState.phases || {},
        nextEvent: this.tradingState.nextEvent || null,
        lastSummary: this.lastTradingSummary || null,
      },
      tradeReconciliationAutomation: {
        enabled: Boolean(this.getTradeReconciliationOrchestrator()),
        running: Boolean(this.tradeReconciliationPromise),
        pollMs: this.tradeReconciliationPollMs,
        state: this.tradeReconciliationState || defaultTradeReconciliationState(),
        lastSummary: this.lastTradeReconciliationSummary || null,
      },
      positionAttributionReconciliation: {
        enabled: this.positionAttributionReconciliationEnabled,
        statePath: this.positionAttributionStatePath,
        lastSummary: this.lastPositionAttributionReconciliationSummary || null,
      },
      cryptoTradingAutomation: {
        enabled: this.cryptoTradingEnabled,
        running: Boolean(this.cryptoTradingPhasePromise),
        statePath: this.cryptoTradingStatePath,
        symbolsConsulted,
        symbolsExecutable,
        lastProcessedAt: this.cryptoTradingState.lastProcessedAt || null,
        nextEvent: this.cryptoTradingState.nextEvent || null,
        lastSummary: this.lastCryptoTradingSummary || null,
      },
      [private-live-ops]Execution: {
        enabled: this.[private-live-ops]ExecutionEnabled && (!this.manualTradingOnly || this.[private-live-ops]ScalpModeArmed),
        manualOnly: this.manualTradingOnly,
        scalpModeArmed: this.[private-live-ops]ScalpModeArmed,
        dryRun: this.[private-live-ops]ExecutionDryRun,
        autoOpenEnabled: this.[private-live-ops]ScalpModeArmed || String(this.runtimeEnv.SQUIDRUN_ALLOW_LIVE_OPS_AUTO_OPEN || '').trim() === '1',
        killSwitchAction: this.[private-live-ops]KillSwitchAction,
        symbolsExecutable,
        lastSummary: this.last[private-live-ops]ExecutionSummary || null,
      },
      [private-live-ops]PositionMonitor: {
        enabled: this.[private-live-ops]MonitorEnabled,
        running: Boolean(this.[private-live-ops]MonitorTimer || this.[private-live-ops]MonitorPromise),
        pollMs: this.[private-live-ops]MonitorPollMs,
        peakStatePath: this.defiPeakPnlPath,
        lastSummary: this.last[private-live-ops]MonitorSummary || null,
      },
      smartMoneyScanner: {
        enabled: Boolean(this.smartMoneyScanner),
        status: this.smartMoneyScanner?.state?.health || (this.smartMoneyScanner ? 'idle' : 'disabled'),
        running: Boolean(this.smartMoneyScanner?.running),
        pollMs: this.smartMoneyScanner?.pollMs || null,
        lastTrigger: this.smartMoneyScannerLastTrigger || null,
        lastError: this.smartMoneyScanner?.state?.lastError || null,
        lastResult: this.smartMoneyScanner?.state?.lastResult || null,
        state: this.smartMoneyScanner ? {
          recentTransfers: this.smartMoneyScanner.state?.recentTransfers?.length || 0,
          convergenceSignals: this.smartMoneyScanner.state?.convergenceSignals?.length || 0,
        } : null,
      },
      circuitBreaker: {
        enabled: Boolean(this.circuitBreaker),
        manualOnly: true,
        running: Boolean(this.circuitBreaker?.running),
        pollMs: this.circuitBreaker?.pollMs || null,
        passCount: this.circuitBreaker?.passCount || 0,
        highWaterMarks: this.circuitBreaker ? Object.keys(this.circuitBreaker.highWaterMarks).length : 0,
        recentExits: this.circuitBreaker?.exits?.slice(-5) || [],
      },
      newsScanAutomation: {
        enabled: this.newsScanEnabled,
        running: Boolean(this.newsScanPhasePromise),
        intervalMinutes: this.newsScanIntervalMinutes,
        statePath: this.newsScanStatePath,
        lastProcessedAt: this.newsScanState.lastProcessedAt || null,
        nextEvent: this.newsScanState.nextEvent || null,
        lastSummary: this.lastNewsScanSummary || null,
      },
      marketResearchAutomation: {
        enabled: this.marketResearchEnabled,
        running: Boolean(this.marketResearchPhasePromise),
        intervalMinutes: this.marketResearchIntervalMinutes,
        statePath: this.marketResearchStatePath,
        lastProcessedAt: this.marketResearchState.lastProcessedAt || null,
        nextEvent: this.marketResearchState.nextEvent || null,
        lastSummary: this.lastMarketResearchSummary || null,
      },
      [private-live-ops]Automation: {
        enabled: this.[private-live-ops]Enabled,
        running: Boolean(this.[private-live-ops]PhasePromise),
        intervalMinutes: this.[private-live-ops]IntervalMinutes,
        statePath: this.[private-live-ops]StatePath,
        lastProcessedAt: this.[private-live-ops]State.lastProcessedAt || null,
        nextEvent: this.[private-live-ops]State.nextEvent || null,
        lastSummary: this.last[private-live-ops]Summary || null,
      },
      sparkMonitorAutomation: {
        enabled: this.sparkMonitorEnabled,
        running: Boolean(this.sparkMonitorPhasePromise),
        intervalMinutes: this.sparkMonitorIntervalMinutes,
        statePath: this.sparkMonitorStatePath,
        dataStatePath: this.sparkMonitorDataStatePath,
        eventsPath: this.sparkMonitorEventsPath,
        firePlansPath: this.sparkMonitorFirePlansPath,
        watchlistPath: this.sparkMonitorWatchlistPath,
        lastProcessedAt: this.sparkMonitorState.lastProcessedAt || null,
        nextEvent: this.sparkMonitorState.nextEvent || null,
        lastSummary: this.lastSparkMonitorSummary || null,
      },
      marketScannerAutomation: {
        enabled: this.marketScannerEnabled,
        running: Boolean(this.marketScannerPhasePromise),
        intervalMinutes: this.marketScannerIntervalMinutes,
        consultationSymbolLimit: this.marketScannerConsultationSymbolLimit,
        pairsScanned,
        statePath: this.marketScannerStatePath,
        lastProcessedAt: this.marketScannerState.lastProcessedAt || null,
        nextEvent: this.marketScannerState.nextEvent || null,
        lastSummary: this.lastMarketScannerSummary || null,
      },
      saylorWatcher: {
        enabled: this.saylorWatcherEnabled,
        running: Boolean(this.saylorWatcherPromise),
        intervalMs: this.saylorWatcherIntervalMs,
        scriptPath: this.hmSaylorWatcherScriptPath,
        lastRunAt: this.lastSaylorWatcherSummary?.lastRunAt || null,
        lastSummary: this.lastSaylorWatcherSummary || null,
      },
      oracleWatch: {
        enabled: this.oracleWatchEnabled,
        running: Boolean(this.oracleWatchPromise),
        intervalMs: this.oracleWatchIntervalMs,
        scriptPath: this.hmOracleWatchEngineScriptPath,
        rulesPath: this.oracleWatchRulesPath,
        statePath: this.oracleWatchStatePath,
        sharedShortRegimeStatePath: this.oracleShortRegimeStatePath,
        heartbeat: oracleWatchHeartbeat,
        counters: oracleWatchState?.counters || null,
        lastRunAt: this.lastOracleWatchSummary?.lastRunAt || null,
        lastSummary: this.lastOracleWatchSummary || null,
      },
      oracleShortRegime: readJsonFile(this.oracleShortRegimeStatePath, null) || this.lastOracleShortRegimeSummary || null,
      [private-live-ops]SqueezeDetector: {
        enabled: this.[private-live-ops]SqueezeDetectorEnabled,
        running: Boolean(this.[private-live-ops]SqueezeDetectorPromise),
        intervalMs: this.[private-live-ops]SqueezeDetectorIntervalMs,
        scriptPath: this.hm[private-live-ops]SqueezeDetectorScriptPath,
        lastRunAt: this.last[private-live-ops]SqueezeDetectorSummary?.lastRunAt || null,
        lastSummary: this.last[private-live-ops]SqueezeDetectorSummary || null,
      },
      private-profileCheckInAutomation: {
        enabled: this.private-profileCheckInEnabled,
        running: Boolean(this.private-profileCheckInPhasePromise),
        intervalMinutes: this.private-profileCheckInIntervalMinutes,
        silenceMs: this.private-profileCheckInSilenceMs,
        statePath: this.private-profileCheckInStatePath,
        lastProcessedAt: this.private-profileCheckInState.lastProcessedAt || null,
        nextEvent: this.private-profileCheckInState.nextEvent || null,
        lastSummary: this.last[private-profile]CheckInSummary || null,
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
  resolveProjectUiScriptPath,
};
