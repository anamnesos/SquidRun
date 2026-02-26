/**
 * Terminal Daemon - Manages PTY processes independently of Electron app
 *
 * This daemon runs as a separate process and owns all terminal PTYs.
 * The Electron app connects as a client via named pipe.
 * Terminals survive app restarts because the daemon keeps running.
 *
 * Protocol:
 * - Client → Daemon: { action: "spawn"|"write"|"resize"|"kill"|"list"|"attach", ... }
 * - Daemon → Client: { event: "data"|"exit"|"spawned"|"list"|"error", ... }
 */

const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// node-pty's unixTerminal.js does helperPath.replace('app.asar', 'app.asar.unpacked')
// to find its spawn-helper binary.  When the daemon already runs from app.asar.unpacked
// (which it does — electron-builder's asarUnpack extracts it there), that replace turns
// the path into app.asar.unpacked.unpacked, which doesn't exist, causing every
// pty.spawn() to fail with "posix_spawnp failed".
// Fix: intercept the module load and make the replace a no-op when already unpacked.
if (__dirname.includes('app.asar.unpacked')) {
  const _origJsHandler = require.extensions['.js'];
  require.extensions['.js'] = function (mod, filename) {
    if (filename.endsWith('node-pty/lib/unixTerminal.js') ||
        filename.endsWith('node-pty\\lib\\unixTerminal.js')) {
      let src = fs.readFileSync(filename, 'utf8');
      src = src.replace(
        "helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');",
        "helperPath = helperPath.includes('app.asar.unpacked') ? helperPath : helperPath.replace('app.asar', 'app.asar.unpacked');"
      );
      mod._compile(src, filename);
      require.extensions['.js'] = _origJsHandler; // restore after patching
      return;
    }
    _origJsHandler(mod, filename);
  };
}
const pty = require('node-pty');
const {
  PIPE_PATH,
  PANE_ROLES,
  resolvePaneCwd,
  resolveCoordPath,
} = require('./config');

// ============================================================
// D1: DAEMON LOGGING TO FILE
// ============================================================

const LOG_FILE_PATH = path.join(__dirname, 'daemon.log');
const daemonStartTime = Date.now();

// Log levels
const LOG_LEVELS = {
  INFO: 'INFO',
  WARN: 'WARN',
  ERROR: 'ERROR',
};

// Log to both console and file
function log(level, message) {
  const timestamp = new Date().toISOString();
  const entry = `[${timestamp}] [${level}] ${message}\n`;
  if (level === LOG_LEVELS.ERROR || level === LOG_LEVELS.WARN) {
    process.stderr.write(entry);
  } else {
    process.stdout.write(entry);
  }

  fs.appendFile(LOG_FILE_PATH, entry, () => {
    // If we can't write to log file, at least console still works
  });
}

// Convenience log functions
function logInfo(message) { log(LOG_LEVELS.INFO, message); }
function logWarn(message) { log(LOG_LEVELS.WARN, message); }
function logError(message) { log(LOG_LEVELS.ERROR, message); }

// Initialize log file with startup message
function initLogFile() {
  const header = `\n${'='.repeat(60)}\nDaemon started at ${new Date().toISOString()}\nPID: ${process.pid}\n${'='.repeat(60)}\n`;
  try {
    fs.appendFileSync(LOG_FILE_PATH, header);
  } catch (err) {
    process.stderr.write(`Could not initialize log file: ${err.message}\n`);
  }
}

// Format uptime as human-readable string
function formatUptime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${secs}s`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

// Store PTY processes: Map<paneId, { pty, pid, alive, cwd, scrollback, dryRun, lastActivity }>
const terminals = new Map();

// Event Kernel: daemon-side event envelope sequencing
let daemonKernelSeq = 0;

function generateKernelId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `daemon-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

function nextDaemonKernelSeq() {
  daemonKernelSeq += 1;
  return daemonKernelSeq;
}

function buildDaemonKernelEvent(type, {
  paneId = 'system',
  payload = {},
  kernelMeta = null,
  correlationId = null,
  traceId = null,
  parentEventId,
  causationId,
} = {}) {
  const meta = (kernelMeta && typeof kernelMeta === 'object') ? kernelMeta : {};
  const resolvedTraceId = traceId
    || meta.traceId
    || correlationId
    || meta.correlationId
    || generateKernelId();
  const resolvedParentEventId = parentEventId !== undefined
    ? parentEventId
    : (causationId !== undefined
      ? causationId
      : (meta.parentEventId || meta.causationId || meta.eventId || null));
  return {
    eventId: generateKernelId(),
    traceId: resolvedTraceId,
    parentEventId: resolvedParentEventId,
    correlationId: resolvedTraceId,
    causationId: resolvedParentEventId,
    type,
    source: 'daemon',
    paneId: String(paneId || 'system'),
    ts: Date.now(),
    seq: nextDaemonKernelSeq(),
    payload,
  };
}

function sendKernelEvent(client, type, details = {}) {
  const eventData = buildDaemonKernelEvent(type, details);
  sendToClient(client, { event: 'kernel-event', eventData });
  return eventData;
}

function broadcastKernelEvent(type, details = {}) {
  const eventData = buildDaemonKernelEvent(type, details);
  broadcast({ event: 'kernel-event', eventData });
  return eventData;
}

// ============================================================
// CODEX AUTO-APPROVAL FALLBACK
// ============================================================
// Best-effort suppression when Codex still shows approval prompts.
// This is a safety net; primary suppression is via CLI flags/config.
const AUTO_APPROVE_ENABLED = true;
const AUTO_APPROVE_THROTTLE_MS = 5000;
const AUTO_APPROVE_BUFFER_MAX = 1500;
const autoApproveState = new Map(); // paneId -> { buffer, lastTrigger }

const CODEX_APPROVAL_PROMPT_REGEX =
  /\b1\.\s*Yes\b[\s\S]{0,200}\b2\.\s*Yes and (?:don't|dont) ask again\b[\s\S]{0,200}\b3\.\s*No\b/i;

function stripAnsi(input) {
  if (!input) return '';
  // Strip OSC (Operating System Command) and CSI (Control Sequence Introducer)
  return input
    .replace(/\x1B\][^\x07]*(\x07|\x1B\\)/g, '')
    .replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function maybeAutoApprovePrompt(paneId, data) {
  if (!AUTO_APPROVE_ENABLED) return;
  const clean = stripAnsi(data);
  if (!clean) return;

  const state = autoApproveState.get(paneId) || { buffer: '', lastTrigger: 0 };
  state.buffer = (state.buffer + clean).slice(-AUTO_APPROVE_BUFFER_MAX);

  const now = Date.now();
  if (now - state.lastTrigger < AUTO_APPROVE_THROTTLE_MS) {
    autoApproveState.set(paneId, state);
    return;
  }

  if (CODEX_APPROVAL_PROMPT_REGEX.test(state.buffer)) {
    state.lastTrigger = now;
    state.buffer = '';
    autoApproveState.set(paneId, state);

    const terminal = terminals.get(paneId);
    if (terminal && terminal.pty && terminal.alive) {
      terminal.pty.write('2\r'); // "Yes and don't ask again"
      terminal.lastInputTime = Date.now();
      logInfo(`[AutoApprove] Detected approval prompt in pane ${paneId} - sent '2'`);
    }
    return;
  }

  autoApproveState.set(paneId, state);
}

// U1: Scrollback buffer settings - keep last 50KB of output per terminal by default.
// Background builders can override this per-terminal with a lower cap.
const SCROLLBACK_MAX_SIZE = 50000;

function normalizeScrollbackMaxSize(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return SCROLLBACK_MAX_SIZE;
  }
  return parsed;
}

function appendToScrollback(terminal, chunk) {
  if (!terminal) return;
  const text = typeof chunk === 'string' ? chunk : String(chunk ?? '');
  if (!text) return;
  terminal.scrollback += text;
  const maxSize = normalizeScrollbackMaxSize(terminal.scrollbackMaxSize);
  if (terminal.scrollback.length > maxSize) {
    terminal.scrollback = terminal.scrollback.slice(-maxSize);
  }
}

// Default stuck threshold (60 seconds)
const DEFAULT_STUCK_THRESHOLD = 60000;

// Smart Watchdog: Threshold for churning stalls (30 seconds)
const MEANINGFUL_ACTIVITY_TIMEOUT_MS = 30000;

// Allowlist of spinner characters to ignore during churning stall detection
const SPINNER_CHARS = ['|', '/', '-', '\\', '⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * Check if the PTY output contains meaningful content (not just spinners/ANSI/whitespace)
 */
function isMeaningfulActivity(data) {
  if (!data) return false;
  // Strip ANSI, control characters, and whitespace
  const clean = stripAnsi(data)
    .replace(/[\x00-\x1F\x7F]/g, '')
    .replace(/\s/g, '');
  
  if (clean.length === 0) return false;
  
  // If the remaining string contains any character NOT in our spinner allowlist, it's meaningful
  for (let i = 0; i < clean.length; i++) {
    if (!SPINNER_CHARS.includes(clean[i])) {
      return true;
    }
  }
  return false;
}

// Event Kernel: coalesced PTY metadata emissions to avoid telemetry storms
const PTY_KERNEL_COALESCE_MS = 75;
const PTY_KERNEL_META_TTL_MS = 2000;
const pendingPtyKernelData = new Map(); // paneId -> aggregate

function queuePtyDataKernelEvent(paneId, data, terminalInfo) {
  const paneKey = String(paneId);
  const now = Date.now();
  const meaningful = isMeaningfulActivity(data);
  const byteLen = Buffer.byteLength(String(data || ''), 'utf8');

  let entry = pendingPtyKernelData.get(paneKey);
  if (!entry) {
    entry = {
      byteLen: 0,
      chunkCount: 0,
      meaningfulCount: 0,
      firstTs: now,
      timer: null,
    };
  }

  entry.byteLen += byteLen;
  entry.chunkCount += 1;
  if (meaningful) {
    entry.meaningfulCount += 1;
  }

  if (!entry.timer) {
    entry.timer = setTimeout(() => {
      pendingPtyKernelData.delete(paneKey);

      const chunkType = entry.meaningfulCount === 0
        ? 'non_meaningful'
        : (entry.meaningfulCount === entry.chunkCount ? 'meaningful' : 'mixed');

      let kernelMeta = null;
      if (terminalInfo && terminalInfo.lastKernelMeta && terminalInfo.lastKernelMetaAt) {
        if ((Date.now() - terminalInfo.lastKernelMetaAt) <= PTY_KERNEL_META_TTL_MS) {
          kernelMeta = terminalInfo.lastKernelMeta;
        }
      }

      broadcastKernelEvent('pty.data.received', {
        paneId: paneKey,
        payload: {
          paneId: paneKey,
          byteLen: entry.byteLen,
          meaningful: entry.meaningfulCount > 0,
          chunkType,
          chunkCount: entry.chunkCount,
        },
        kernelMeta,
      });
    }, PTY_KERNEL_COALESCE_MS);
  }

  pendingPtyKernelData.set(paneKey, entry);
}

// ============================================================
// Ghost text deduplication
// ============================================================

// Track recent inputs for ghost text detection
// Format: [{ data, timestamp, paneId }, ...]
const recentInputs = [];
const GHOST_DEDUP_WINDOW_MS = 100; // Block duplicates within 100ms
const GHOST_MIN_INPUT_LENGTH = 5; // Only check inputs >= 5 chars (ignore single keystrokes)
let ghostBlockCount = 0; // Track total blocks for stats

/**
 * Check if this input is a ghost text duplicate
 * Returns { isGhost: boolean, blockedPanes: string[] }
 */
function checkGhostText(paneId, data) {
  const now = Date.now();

  // Clean up old entries
  while (recentInputs.length > 0 && now - recentInputs[0].timestamp > GHOST_DEDUP_WINDOW_MS) {
    recentInputs.shift();
  }

  // Single keystrokes are not ghost text - only check longer inputs
  // Ghost text typically submits entire suggestions at once
  if (data.length < GHOST_MIN_INPUT_LENGTH) {
    return { isGhost: false, blockedPanes: [] };
  }

  // Check if same input was recently sent to the SAME pane (true ghost text)
  // Ghost text = same pane gets duplicate input, NOT different panes getting same input
  // Cross-pane same-input is legitimate (e.g., broadcast messages)
  const matchingInputs = recentInputs.filter(entry =>
    entry.data === data &&
    entry.paneId === paneId &&  // Only dedup SAME pane, not cross-pane
    now - entry.timestamp < GHOST_DEDUP_WINDOW_MS
  );

  if (matchingInputs.length > 0) {
    // This is a duplicate! Block it.
    const blockedPanes = matchingInputs.map(e => e.paneId);
    blockedPanes.push(paneId);
    return { isGhost: true, blockedPanes };
  }

  // Record this input for future dedup checks
  recentInputs.push({ data, timestamp: now, paneId });

  // Keep only recent entries (prevent memory leak)
  if (recentInputs.length > 50) {
    recentInputs.shift();
  }

  return { isGhost: false, blockedPanes: [] };
}

// ============================================================
// Session persistence
// ============================================================

const SESSION_FILE_PATH = path.join(__dirname, 'session-state.json');

/**
 * Save current session state to disk
 * Called periodically and on shutdown
 */
function saveSessionState() {
  const sessionState = {
    savedAt: new Date().toISOString(),
    daemonPid: process.pid,
    terminals: [],
  };

  for (const [paneId, termInfo] of terminals) {
    sessionState.terminals.push({
      paneId,
      cwd: termInfo.cwd,
      alive: termInfo.alive,
      dryRun: termInfo.dryRun || false,
      scrollback: termInfo.scrollback || '',
      lastActivity: termInfo.lastActivity,
    });
  }

  try {
    fs.writeFileSync(SESSION_FILE_PATH, JSON.stringify(sessionState, null, 2));
    logInfo(`Session state saved: ${sessionState.terminals.length} terminals`);
  } catch (err) {
    logError(`Failed to save session state: ${err.message}`);
  }
}

/**
 * Load saved session state from disk
 * Returns null if no saved state or invalid
 */
function loadSessionState() {
  try {
    if (!fs.existsSync(SESSION_FILE_PATH)) {
      logInfo('No saved session state found');
      return null;
    }
    const data = fs.readFileSync(SESSION_FILE_PATH, 'utf-8');
    const state = JSON.parse(data);
    logInfo(`Loaded session state from ${state.savedAt}`);
    // Correct stale cwds against configured pane cwd source of truth.
    if (state.terminals) {
      for (const term of state.terminals) {
        const expectedDir = resolvePaneCwd(String(term.paneId));
        if (expectedDir && term.cwd && path.resolve(expectedDir) !== path.resolve(term.cwd)) {
          logWarn(`[Session] Correcting pane ${term.paneId} cwd: ${term.cwd} -> ${expectedDir}`);
          term.cwd = expectedDir;
        }
      }
    }
    return state;
  } catch (err) {
    logWarn(`Could not load session state: ${err.message}`);
    return null;
  }
}

/**
 * Clear saved session state
 */
function clearSessionState() {
  try {
    if (fs.existsSync(SESSION_FILE_PATH)) {
      fs.unlinkSync(SESSION_FILE_PATH);
      logInfo('Session state cleared');
    }
  } catch (err) {
    logWarn(`Could not clear session state: ${err.message}`);
  }
}

// Save session state periodically (every 30 seconds)
setInterval(() => {
  if (terminals.size > 0) {
    saveSessionState();
  }
}, 30000);

// ============================================================
// HEARTBEAT WATCHDOG (adaptive intervals)
// ============================================================

function resolveCoordFile(relPath, options = {}) {
  if (typeof resolveCoordPath === 'function') {
    return resolveCoordPath(relPath, options);
  }
  return path.join(__dirname, '..', 'workspace', relPath);
}

function getTriggerPath(filename) {
  return path.join(resolveCoordFile('triggers', { forWrite: true }), filename);
}

function readJsonIfExists(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function countActiveTaskPoolTasks() {
  const taskPoolPath = resolveCoordFile('task-pool.json');
  const taskPool = readJsonIfExists(taskPoolPath);
  if (!taskPool || !Array.isArray(taskPool.tasks)) return 0;

  const terminalStatuses = new Set([
    'completed',
    'failed',
    'cancelled',
    'canceled',
    'done',
    'resolved',
    'closed',
    'deprecated',
  ]);

  return taskPool.tasks.reduce((count, task) => {
    const status = String(task?.status || '').trim().toLowerCase();
    if (!status || terminalStatuses.has(status)) return count;
    return count + 1;
  }, 0);
}

function hasActiveMarkdownItems(relPath) {
  const filePath = resolveCoordFile(relPath);
  try {
    if (!fs.existsSync(filePath)) return false;
    const content = fs.readFileSync(filePath, 'utf-8');
    const activeMatch = content.match(/## ACTIVE[\s\S]*?(?=\n##\s|$)/i);
    if (!activeMatch) return false;

    const section = activeMatch[0];
    if (/\(No active/i.test(section)) return false;
    return /(^|\n)\s*(?:###\s+|- \*\*|- [^\n]+)/m.test(section);
  } catch {
    return false;
  }
}

function getPendingTaskSignals() {
  const taskPoolActiveCount = countActiveTaskPoolTasks();
  const hasActiveBlockers = hasActiveMarkdownItems(path.join('build', 'blockers.md'));
  const hasActiveErrors = hasActiveMarkdownItems(path.join('build', 'errors.md'));

  return {
    taskPoolActiveCount,
    hasActiveBlockers,
    hasActiveErrors,
  };
}

function summarizePendingTaskSignals(signals) {
  const parts = [];
  if (signals.taskPoolActiveCount > 0) {
    parts.push(`${signals.taskPoolActiveCount} task-pool item(s) open/in-progress`);
  }
  if (signals.hasActiveBlockers) {
    parts.push('active blockers');
  }
  if (signals.hasActiveErrors) {
    parts.push('active errors');
  }
  return parts.length > 0
    ? `${parts.join(', ')}`
    : 'No active coordination signals detected';
}

// Adaptive heartbeat intervals (ms)
const HEARTBEAT_INTERVALS = {
  idle: 600000,       // 10 minutes - no pending tasks
  active: 120000,     // 2 minutes - tasks in progress
  overdue: 60000,     // 1 minute - task stale (no status.md update in >5 min)
  recovering: 45000,  // 45 seconds - after stuck detection, before escalation
};

// Staleness threshold - task is "overdue" if no status.md update in 5 minutes
const STALENESS_THRESHOLD = 300000; // 5 minutes

const ARCHITECT_RESPONSE_TIMEOUT = 15000;  // HB2: 15 seconds
const MAX_ARCHITECT_NUDGES = 2;  // HB3: After 2 failed nudges, escalate
const ACTIVITY_THRESHOLD = 10000;  // Only nudge if no activity for 10 seconds

// Auto-aggressive-nudge settings
const AGGRESSIVE_NUDGE_WAIT = 30000;  // 30 seconds between nudge attempts
const MAX_AGGRESSIVE_NUDGES = 2;  // After 2 failed nudges, alert user
const STUCK_CHECK_THRESHOLD = 60000;  // Consider stuck after 60s of no activity

// State tracking
let heartbeatEnabled = false;  // Disabled by default - user can enable via protocol
let architectNudgeCount = 0;
let lastHeartbeatTime = 0;
let awaitingArchitectResponse = false;
let currentHeartbeatState = 'idle';  // Track current state
let heartbeatTimerId = null;  // Dynamic timer reference
let heartbeatStateCheckTimerId = null;  // Periodic state check reference
let isRecovering = false;  // Recovery state after stuck detection

// Track aggressive nudge attempts per pane
// Map<paneId, { attempts: number, lastNudgeTime: number, alerted: boolean }>
const aggressiveNudgeState = new Map();

/**
 * Check if any terminal has recent activity
 * Returns true if agents are actively working (don't need nudge)
 */
function _hasRecentActivity() {
  const now = Date.now();
  for (const [_paneId, terminal] of terminals) {
    if (terminal.alive && terminal.lastActivity) {
      const idleTime = now - terminal.lastActivity;
      if (idleTime < ACTIVITY_THRESHOLD) {
        return true; // At least one agent is active
      }
    }
  }
  return false; // All agents idle
}

/**
 * Get status.md last modified time
 * Returns null if file doesn't exist or can't be read
 */
function getStatusMdMtime() {
  const statusMdPath = resolveCoordFile(path.join('build', 'status.md'));
  try {
    if (fs.existsSync(statusMdPath)) {
      const stats = fs.statSync(statusMdPath);
      return stats.mtimeMs;
    }
  } catch (err) {
    logWarn(`[Heartbeat] Could not read status.md mtime: ${err.message}`);
  }
  return null;
}

/**
 * Check if there are pending/in-progress tasks via coordination state
 * Returns true if tasks found, false otherwise
 */
function hasPendingTasks() {
  try {
    const signals = getPendingTaskSignals();
    return signals.taskPoolActiveCount > 0
      || signals.hasActiveBlockers
      || signals.hasActiveErrors;
  } catch (err) {
    logWarn(`[Heartbeat] Could not read coordination state: ${err.message}`);
  }
  return false;
}

/**
 * Determine heartbeat state based on task activity and staleness
 * Returns: 'idle' | 'active' | 'overdue' | 'recovering'
 */
function getHeartbeatState() {
  // If in recovery mode, stay there until cleared
  if (isRecovering) {
    return 'recovering';
  }

  const now = Date.now();
  const statusMtime = getStatusMdMtime();
  const hasTasks = hasPendingTasks();

  // If no status.md, default to 'active' (safe default per Reviewer feedback)
  if (statusMtime === null) {
    logInfo('[Heartbeat] No status.md found, defaulting to ACTIVE state');
    return 'active';
  }

  const staleness = now - statusMtime;

  // Check for overdue: tasks exist but no status.md update in >5 minutes
  if (hasTasks && staleness > STALENESS_THRESHOLD) {
    logInfo(`[Heartbeat] Task stale (${Math.round(staleness/1000)}s since status.md update) - OVERDUE`);
    return 'overdue';
  }

  // Check for active: tasks exist and recently updated
  if (hasTasks) {
    return 'active';
  }

  // No tasks = idle
  return 'idle';
}

/**
 * Get heartbeat interval based on current state
 * Returns interval in milliseconds
 */
function _getHeartbeatInterval() {
  const _state = getHeartbeatState();
  return HEARTBEAT_INTERVALS[_state] || HEARTBEAT_INTERVALS.active;
}

/**
 * Broadcast heartbeat state change to all clients
 * This is picked up by main.js and forwarded to renderer
 */
function broadcastHeartbeatState(state, interval) {
  broadcast({
    event: 'heartbeat-state-changed',
    state: state,
    interval: interval,
    timestamp: new Date().toISOString(),
  });
  logInfo(`[Heartbeat] State changed: ${state} (interval: ${interval}ms)`);
}

/**
 * Enter recovery mode (45 sec interval) after stuck detection
 */
function enterRecoveryMode() {
  if (!isRecovering) {
    isRecovering = true;
    logInfo('[Heartbeat] Entering RECOVERING state');
    updateHeartbeatTimer();
  }
}

/**
 * Exit recovery mode (agent responded)
 */
function exitRecoveryMode() {
  if (isRecovering) {
    isRecovering = false;
    logInfo('[Heartbeat] Exiting RECOVERING state');
    updateHeartbeatTimer();
  }
}

// ============================================================
// AUTO-AGGRESSIVE-NUDGE
// When watchdog detects stuck agent, auto-send (AGGRESSIVE_NUDGE)
// Escalation: nudge → wait 30s → nudge again → alert user
// ============================================================

// Map paneId to trigger filename
const PANE_TRIGGER_FILES = {
  '1': 'architect.txt',
  '2': 'builder.txt',
  '3': 'oracle.txt',
};

/**
 * Send aggressive nudge to a specific agent via trigger file
 * Returns true if nudge was sent, false if failed
 */
function sendAggressiveNudge(paneId) {
  const triggerFile = PANE_TRIGGER_FILES[paneId];
  if (!triggerFile) {
    logWarn(`[AutoNudge] Unknown paneId: ${paneId}`);
    return false;
  }

  const triggerPath = getTriggerPath(triggerFile);
  const roleName = PANE_ROLES[paneId] || `Pane ${paneId}`;
  const message = `(AGGRESSIVE_NUDGE)\n`;

  try {
    fs.writeFileSync(triggerPath, message);
    logInfo(`[AutoNudge] Sent aggressive nudge to ${roleName} (pane ${paneId})`);
    return true;
  } catch (err) {
    logError(`[AutoNudge] Failed to nudge ${roleName}: ${err.message}`);
    return false;
  }
}

/**
 * Check if an agent has responded since last nudge
 * An agent has "responded" if they have recent activity
 */
// Grace period to distinguish nudge-induced writes from real agent response
// The nudge process takes ~200ms (ESC + 150ms delay + Enter), so any input within
// 500ms of the nudge is likely the nudge itself, not the agent actually responding
const NUDGE_GRACE_PERIOD_MS = 500;

function hasAgentResponded(paneId) {
  const terminal = terminals.get(paneId);
  if (!terminal || !terminal.alive) return false;

  const state = aggressiveNudgeState.get(paneId);
  if (!state) return true; // No nudge state = not being tracked = OK

  // Check if agent received INPUT after the last nudge
  // Use lastInputTime (user/trigger input) not lastActivity (PTY output)
  const lastInput = terminal.lastInputTime || terminal.lastActivity;

  // Add grace period - the nudge itself causes PTY writes (ESC + Enter)
  // which update lastInputTime. Only count as "responded" if input came AFTER
  // the grace period, meaning it's likely real agent activity, not our nudge.
  const nudgeCompleteTime = state.lastNudgeTime + NUDGE_GRACE_PERIOD_MS;
  return lastInput > nudgeCompleteTime;
}

/**
 * Alert user about a specific stuck agent
 */
function alertUserAboutAgent(paneId) {
  const roleName = PANE_ROLES[paneId] || `Pane ${paneId}`;
  logError(`[AutoNudge] ${roleName} unresponsive after ${MAX_AGGRESSIVE_NUDGES} nudges - alerting user`);

  // Broadcast alert event to connected clients (for UI notification)
  broadcast({
    event: 'agent-stuck-alert',
    paneId: paneId,
    role: roleName,
    message: `${roleName} is stuck and not responding to nudges. Manual intervention needed.`,
    timestamp: new Date().toISOString(),
  });

  // Also write to all.txt as visible notification
  const allTrigger = getTriggerPath('all.txt');
  const message = `(SYSTEM): ⚠️ ${roleName} (pane ${paneId}) is stuck. Auto-nudge failed. Please check manually.\n`;
  try {
    fs.writeFileSync(allTrigger, message);
  } catch (err) {
    logError(`[AutoNudge] Failed to write alert: ${err.message}`);
  }
}

/**
 * Broadcast per-agent stuck detection to clients
 * Used to consolidate stuck detection in the daemon
 */
function broadcastAgentStuck(stuckInfo, attempt) {
  const roleName = PANE_ROLES[stuckInfo.paneId] || `Pane ${stuckInfo.paneId}`;
  broadcast({
    event: 'agent-stuck-detected',
    paneId: stuckInfo.paneId,
    role: roleName,
    idleMs: stuckInfo.idleTimeMs,
    idleTimeFormatted: stuckInfo.idleTimeFormatted,
    attempt,
    maxAttempts: MAX_AGGRESSIVE_NUDGES,
    timestamp: new Date().toISOString(),
    message: `${roleName} idle for ${stuckInfo.idleTimeFormatted}. Auto-nudge attempt ${attempt}/${MAX_AGGRESSIVE_NUDGES}.`,
  });
}

/**
 * Main auto-aggressive-nudge logic
 * Called periodically to check for stuck agents and nudge them
 */
function checkAndNudgeStuckAgents() {
  if (!heartbeatEnabled || terminals.size === 0) {
    return;
  }

  const now = Date.now();
  const stuckTerminals = getStuckTerminals(STUCK_CHECK_THRESHOLD);

  // First: Clear nudge state for agents that have responded
  for (const [paneId, _state] of aggressiveNudgeState) {
    if (hasAgentResponded(paneId)) {
      logInfo(`[AutoNudge] Pane ${paneId} responded - clearing nudge state`);
      aggressiveNudgeState.delete(paneId);
    }
  }

  // Process each stuck terminal
  for (const stuckInfo of stuckTerminals) {
    const paneId = stuckInfo.paneId;
    let state = aggressiveNudgeState.get(paneId);

    // Initialize state if first time seeing this agent stuck
    if (!state) {
      state = { attempts: 0, lastNudgeTime: 0, alerted: false };
      aggressiveNudgeState.set(paneId, state);
    }

    // Skip if already alerted user about this agent
    if (state.alerted) {
      continue;
    }

    // Check if enough time has passed since last nudge
    const timeSinceLastNudge = now - state.lastNudgeTime;

    if (state.attempts === 0 || timeSinceLastNudge >= AGGRESSIVE_NUDGE_WAIT) {
      // Time to nudge
      state.attempts++;
      state.lastNudgeTime = now;

      if (state.attempts <= MAX_AGGRESSIVE_NUDGES) {
        // Send nudge
        const roleName = PANE_ROLES[paneId] || `Pane ${paneId}`;
        logInfo(`[AutoNudge] ${roleName} stuck for ${stuckInfo.idleTimeFormatted} - nudge attempt ${state.attempts}/${MAX_AGGRESSIVE_NUDGES}`);
        broadcastAgentStuck(stuckInfo, state.attempts);
        sendAggressiveNudge(paneId);

        // Enter recovery mode on first nudge
        if (state.attempts === 1) {
          enterRecoveryMode();
        }
      } else {
        // Max nudges reached - alert user
        state.alerted = true;
        alertUserAboutAgent(paneId);
        exitRecoveryMode();
      }
    }
  }
}

/**
 * Update heartbeat timer with new interval based on current state
 */
function updateHeartbeatTimer() {
  const newState = getHeartbeatState();
  const newInterval = HEARTBEAT_INTERVALS[newState];

  // Only update if state changed
  if (newState !== currentHeartbeatState) {
    currentHeartbeatState = newState;

    // Clear existing timer
    if (heartbeatTimerId) {
      clearInterval(heartbeatTimerId);
    }

    // Set new timer with updated interval
    heartbeatTimerId = setInterval(heartbeatTick, newInterval);

    // Broadcast state change to clients
    broadcastHeartbeatState(newState, newInterval);

    logInfo(`[Heartbeat] Timer updated: ${newState} (${newInterval}ms)`);
  }
}

/**
 * HB1: Write heartbeat message to Architect's trigger file
 * NOTE: Removed automatic ESC sending - it was interrupting active agents
 * The trigger file watcher will handle delivery; ESC is only sent if truly stuck
 */
function sendHeartbeatToArchitect() {
  const architectPaneId = '1';
  const _architectTerminal = terminals.get(architectPaneId);

  // ESC sending removed - PTY ESC breaks agents (keyboard ESC works, PTY does not)
  // Just send the trigger file message, let user manually ESC if needed.

  // Send heartbeat message via trigger file
  const triggerPath = getTriggerPath('architect.txt');
  const message = '(SYSTEM): Heartbeat - check team status and nudge any stuck workers\n';
  try {
    fs.writeFileSync(triggerPath, message);
    logInfo('[Heartbeat] Sent heartbeat to Architect');
    awaitingArchitectResponse = true;
    lastHeartbeatTime = Date.now();
  } catch (err) {
    logError(`[Heartbeat] Failed to send to Architect: ${err.message}`);
  }
}

/**
 * HB3: Directly nudge workers when Architect is unresponsive
 * NOTE: Only sends ESC to workers that are actually idle (not actively working)
 */
function directNudgeWorkers() {
  logWarn('[Heartbeat] Architect unresponsive - directly nudging workers');

  // ESC sending removed - PTY ESC breaks agents. Use trigger files instead.

  const incompleteTasksMsg = summarizePendingTaskSignals(getPendingTaskSignals());

  // Nudge workers directly via trigger file
  const workersTrigger = getTriggerPath('workers.txt');
  const message = `(SYSTEM): Watchdog alert - Architect unresponsive. ${incompleteTasksMsg}. Reply with your status.\n`;
  try {
    fs.writeFileSync(workersTrigger, message);
    logInfo('[Heartbeat] Directly nudged workers');
  } catch (err) {
    logError(`[Heartbeat] Failed to nudge workers: ${err.message}`);
  }
}

/**
 * HB4: Alert user when all agents are stuck
 */
function alertUser() {
  logError('[Heartbeat] ALL AGENTS UNRESPONSIVE - Alerting user');

  // Write to all.txt as last resort
  const allTrigger = getTriggerPath('all.txt');
  const message = '(SYSTEM): ⚠️ WATCHDOG ALERT - All agents appear stuck. User intervention needed.\n';
  try {
    fs.writeFileSync(allTrigger, message);
  } catch (err) {
    logError(`[Heartbeat] Failed to write alert: ${err.message}`);
  }

  // Broadcast alert event to connected clients (for UI notification)
  broadcast({
    event: 'watchdog-alert',
    message: 'All agents unresponsive - user intervention needed',
    timestamp: new Date().toISOString(),
  });
}

/**
 * Check if Architect ACTUALLY responded (not just trigger file cleared)
 * Real response = Architect wrote to workers.txt OR had terminal activity
 */
function checkArchitectResponse() {
  // Check 1: Did Architect write to workers.txt after heartbeat?
  const workersTrigger = getTriggerPath('workers.txt');
  try {
    if (fs.existsSync(workersTrigger)) {
      const stats = fs.statSync(workersTrigger);
      const content = fs.readFileSync(workersTrigger, 'utf-8').trim();
      // If workers.txt was modified after heartbeat and contains Architect message
      if (stats.mtimeMs > lastHeartbeatTime && /\((ARCH|ARCHITECT)\s*#/i.test(content)) {
        logInfo('[Heartbeat] Architect responded - wrote to workers.txt');
        return true;
      }
    }
  } catch (_err) {
    // Ignore
  }

  // Check 2: REMOVED - Terminal activity check was causing false positives
  // Claude Code's thinking animation counts as "activity" even when stuck
  // Only actual actions (writing to workers.txt or clearing trigger file) count

  // Check 3: Original check - trigger file cleared (fallback)
  const triggerPath = getTriggerPath('architect.txt');
  try {
    if (!fs.existsSync(triggerPath)) {
      return true; // File deleted
    }
    const content = fs.readFileSync(triggerPath, 'utf-8').trim();
    // Only count as response if file is empty (fully processed)
    if (content.length === 0) {
      return true;
    }
  } catch (_err) {
    // Ignore read errors
  }

  // No response detected
  return false;
}

/**
 * Main heartbeat tick - HB1-HB4 logic + adaptive intervals + auto-nudge
 */
function heartbeatTick() {
  if (!heartbeatEnabled || terminals.size === 0) {
    return;
  }

  // Check for stuck agents and auto-nudge them
  checkAndNudgeStuckAgents();

  // Check if state changed and update timer accordingly
  updateHeartbeatTimer();

  // NOTE: Removed "smart activity check" - it was preventing heartbeats from firing
  // because PTY output (ANSI codes, cursor updates) counts as "activity" even when
  // agents are stuck at prompts. Heartbeats are non-intrusive, so always fire them.

  logInfo(`[Heartbeat] Tick - state=${currentHeartbeatState}, awaiting=${awaitingArchitectResponse}, nudgeCount=${architectNudgeCount}`);

  // If awaiting Architect response, check if they responded
  if (awaitingArchitectResponse) {
    const elapsed = Date.now() - lastHeartbeatTime;

    if (checkArchitectResponse()) {
      // Architect responded - reset state
      logInfo('[Heartbeat] Architect responded');
      architectNudgeCount = 0;
      awaitingArchitectResponse = false;
      exitRecoveryMode();  // Exit recovery if we were in it
      return;
    }

    // HB2: Check timeout
    if (elapsed > ARCHITECT_RESPONSE_TIMEOUT) {
      architectNudgeCount++;
      logWarn(`[Heartbeat] Architect no response after ${elapsed}ms (nudge ${architectNudgeCount}/${MAX_ARCHITECT_NUDGES})`);

      // Enter recovery mode on first failed nudge
      enterRecoveryMode();

      if (architectNudgeCount >= MAX_ARCHITECT_NUDGES) {
        // HB3: Escalate to direct worker nudge
        directNudgeWorkers();
        architectNudgeCount = 0;
        awaitingArchitectResponse = false;

        // Set timer for HB4 check
        setTimeout(() => {
          // If workers also don't respond, alert user
          const workersTrigger = getTriggerPath('workers.txt');
          try {
            if (fs.existsSync(workersTrigger)) {
              const content = fs.readFileSync(workersTrigger, 'utf-8').trim();
              if (content.includes('(SYSTEM): Watchdog')) {
                alertUser();
                exitRecoveryMode();  // Exit recovery after user alert
              }
            }
          } catch (_err) {
            // Ignore
          }
        }, ARCHITECT_RESPONSE_TIMEOUT);
      } else {
        // Retry Architect nudge
        sendHeartbeatToArchitect();
      }
    }
    return;
  }

  // HB1: Send regular heartbeat
  sendHeartbeatToArchitect();
}

// Start heartbeat timer with initial adaptive interval
function initHeartbeatTimer() {
  if (!heartbeatEnabled) {
    return;
  }
  const initialState = getHeartbeatState();
  const initialInterval = HEARTBEAT_INTERVALS[initialState];
  currentHeartbeatState = initialState;

  heartbeatTimerId = setInterval(heartbeatTick, initialInterval);
  logInfo(`[Heartbeat] Watchdog started - state: ${initialState}, interval: ${initialInterval}ms`);

  // Broadcast initial state to any connected clients
  broadcastHeartbeatState(initialState, initialInterval);

  // Periodic state check (every 30 seconds) to detect state changes
  // This catches state changes between heartbeat ticks
  heartbeatStateCheckTimerId = setInterval(() => {
    if (heartbeatEnabled) {
      updateHeartbeatTimer();
    }
  }, 30000);
}

// NOTE: initHeartbeatTimer() is called later, after 'clients' Set is declared

// ============================================================
// Dry-run mode
// ============================================================

// Mock responses for dry-run mode (simulates an agent)
const _DRY_RUN_RESPONSES = [
  '[DRY-RUN] Agent simulated. Ready for input.\r\n',
  '[DRY-RUN] Processing your request...\r\n',
  '[DRY-RUN] Analyzing codebase structure...\r\n',
  '[DRY-RUN] Reading relevant files...\r\n',
  '[DRY-RUN] Task completed successfully.\r\n',
  '[DRY-RUN] Waiting for next instruction...\r\n',
];

// Simulated typing delay (ms per character)
const DRY_RUN_TYPING_DELAY = 15;

// Send mock data with simulated typing effect
function sendMockData(paneId, text, callback) {
  const terminal = terminals.get(paneId);
  if (!terminal || !terminal.alive) return;

  let index = 0;
  const sendChar = () => {
    if (index < text.length && terminal.alive) {
      const char = text[index];
      // Buffer for scrollback
      appendToScrollback(terminal, char);
      // Broadcast character
      broadcast({ event: 'data', paneId, data: char });

      // Update activity timers for Dry-run mode
      terminal.lastActivity = Date.now();
      if (isMeaningfulActivity(char)) {
        terminal.lastMeaningfulActivity = Date.now();
      }

      index++;
      setTimeout(sendChar, DRY_RUN_TYPING_DELAY);
    } else if (callback) {
      callback();
    }
  };
  sendChar();
}

// Generate mock agent response based on input
function generateMockResponse(input) {
  const trimmed = input.trim().toLowerCase();

  // Recognize common commands/patterns
  if (trimmed === '' || trimmed === '\r' || trimmed === '\n') {
    return '';
  }

  if (trimmed.includes('sync') || trimmed.includes('squidrun')) {
    return '\r\n[DRY-RUN] Sync received. Reviewing ROLES.md and coordination state...\r\n[DRY-RUN] Worker acknowledged. Standing by for tasks.\r\n\r\n> ';
  }

  if (trimmed.includes('read') || trimmed.includes('cat')) {
    return '\r\n[DRY-RUN] Reading file... (simulated)\r\n[DRY-RUN] File contents displayed.\r\n\r\n> ';
  }

  if (trimmed.includes('edit') || trimmed.includes('write') || trimmed.includes('fix')) {
    return '\r\n[DRY-RUN] Editing file... (simulated)\r\n[DRY-RUN] Changes applied successfully.\r\n\r\n> ';
  }

  if (trimmed.includes('test') || trimmed.includes('npm')) {
    return '\r\n[DRY-RUN] Running tests... (simulated)\r\n[DRY-RUN] All 86 tests passed.\r\n\r\n> ';
  }

  if (trimmed.includes('help') || trimmed === '?') {
    return '\r\n[DRY-RUN] This is dry-run mode. Commands are simulated.\r\n[DRY-RUN] Toggle off in Settings to use real agents.\r\n\r\n> ';
  }

  // Default response
  return '\r\n[DRY-RUN] Command received: "' + input.trim().substring(0, 50) + '"\r\n[DRY-RUN] Processing... Done.\r\n\r\n> ';
}

// Connected clients: Set<net.Socket>
const clients = new Set();

// Initialize heartbeat timer now that clients is declared
initHeartbeatTimer();

// Get the appropriate shell for the platform
function getShell() {
  return os.platform() === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/bash';
}

function detectCliRuntimeFromCommand(command = '') {
  const normalized = String(command || '').trim().toLowerCase();
  if (!normalized) return 'claude';
  if (normalized.startsWith('codex') || normalized.includes(' codex')) return 'codex';
  if (normalized.startsWith('gemini') || normalized.includes(' gemini')) return 'gemini';
  return 'claude';
}

function getPackagedWorkspaceFallbackDir() {
  const preferred = path.join(os.homedir(), 'SquidRun');
  try {
    fs.mkdirSync(preferred, { recursive: true });
    return preferred;
  } catch (_) {
    return os.homedir();
  }
}

// Send JSON message to a client
function sendToClient(client, message) {
  try {
    if (client && !client.destroyed) {
      client.write(JSON.stringify(message) + '\n');
    }
  } catch (err) {
    logError(`Error sending to client: ${err.message}`);
  }
}

// Broadcast message to all connected clients
function broadcast(message) {
  for (const client of clients) {
    sendToClient(client, message);
  }
}

// Spawn a new PTY for a pane (or mock terminal in dry-run mode)
function spawnTerminal(paneId, cwd, dryRun = false, options = {}) {
  // Kill existing terminal for this pane if any
  if (terminals.has(paneId)) {
    const existing = terminals.get(paneId);
    if (existing.pty && existing.alive && !existing.dryRun) {
      try {
        existing.pty.kill();
      } catch (_e) { /* ignore */ }
    }
    // Clear any dry-run timers
    if (existing.dryRunTimer) {
      clearTimeout(existing.dryRunTimer);
    }
  }

  // Use cwd from Electron (already resolved with paneProjects), else daemon fallback.
  // Avoid cwd inside the app bundle (e.g. /Applications/SquidRun.app/... or app.asar*)
  // because child process spawning from bundled runtime paths is brittle.
  let workDir = cwd || resolvePaneCwd(paneId) || process.cwd();
  const normalizedWorkDir = String(workDir || '').replace(/\\/g, '/').toLowerCase();
  if (normalizedWorkDir.includes('.app/contents/') || normalizedWorkDir.includes('app.asar')) {
    workDir = getPackagedWorkspaceFallbackDir();
  }
  const paneCommand = typeof options.paneCommand === 'string'
    ? options.paneCommand
    : '';
  const paneRuntime = detectCliRuntimeFromCommand(paneCommand);
  const packagedWorkspaceBin = path.join(os.homedir(), 'SquidRun', '.squidrun', 'bin');
  const projectWorkspaceBin = path.join(workDir, '.squidrun', 'bin');

  // macOS apps launched from Finder get a minimal PATH. Ensure common bin dirs
  // are included so shells can find CLIs like claude, codex, gemini.
  const extraPaths = process.platform === 'darwin'
    ? ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local', 'bin')]
    : [];
  const basePath = process.env.PATH || '';
  const pathEntries = [
    packagedWorkspaceBin,
    projectWorkspaceBin,
    ...extraPaths,
    basePath,
  ].filter(Boolean);
  const augmentedPath = Array.from(new Set(pathEntries)).join(path.delimiter);
  const runtimeEnv = {
    ...process.env,
    PATH: augmentedPath,
    ...(options.env && typeof options.env === 'object' ? options.env : {}),
  };
  if (paneRuntime === 'claude') {
    runtimeEnv.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION = 'false';
  }

  // DRY-RUN MODE: Create mock terminal instead of real PTY
  if (dryRun) {
    logInfo(`[DRY-RUN] Spawning MOCK terminal for pane ${paneId}`);

    const mockPid = 90000 + parseInt(paneId); // Fake PID for identification

    const terminalInfo = {
      pty: null,
      pid: mockPid,
      alive: true,
      cwd: workDir,
      scrollback: '',
      scrollbackMaxSize: normalizeScrollbackMaxSize(options?.scrollbackMaxSize),
      dryRun: true,
      mode: 'dry-run',
      inputBuffer: '', // Buffer for accumulating input
      createdAt: Date.now(), // Track terminal creation time (for reattach guard)
      lastActivity: Date.now(), // Track last activity
      lastMeaningfulActivity: Date.now(), // Smart Watchdog: last non-spinner output
      lastInputTime: Date.now(), // Track last user INPUT
    };

    terminals.set(paneId, terminalInfo);

    // Send initial mock prompt after short delay
    setTimeout(() => {
      if (terminalInfo.alive) {
        const welcomeMsg = `\r\n[DRY-RUN MODE] Mock agent for Pane ${paneId}\r\n` +
          `[DRY-RUN] Role: ${PANE_ROLES[paneId] || 'Unknown'}\r\n` +
          `[DRY-RUN] Working dir: ${workDir}\r\n` +
          `[DRY-RUN] Commands are simulated. Toggle off in Settings for real agents.\r\n\r\n> `;
        sendMockData(paneId, welcomeMsg);
      }
    }, 300);

    return { paneId, pid: mockPid, dryRun: true, mode: 'dry-run' };
  }

  // NORMAL MODE: Spawn real PTY
  const shell = getShell();
  logInfo(`Spawning terminal for pane ${paneId} in ${workDir}`);

  const ptyProcess = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: workDir,
    env: runtimeEnv,
    handleFlowControl: true,
  });

  const terminalInfo = {
    pty: ptyProcess,
    pid: ptyProcess.pid,
    alive: true,
    cwd: workDir,
    scrollback: '', // U1: Buffer for scrollback persistence
    scrollbackMaxSize: normalizeScrollbackMaxSize(options?.scrollbackMaxSize),
    dryRun: false,
    mode: 'pty',
    createdAt: Date.now(), // Track terminal creation time (for reattach guard)
    lastActivity: Date.now(), // Track last PTY output
    lastMeaningfulActivity: Date.now(), // Smart Watchdog: last non-spinner output
    lastInputTime: Date.now(), // Track last user INPUT (not output)
  };

  terminals.set(paneId, terminalInfo);

  // Identity injection is handled by renderer (terminal.js:spawnAgent) at 4s
  // using keyboard events via sendToPane(). The daemon PTY write approach caused
  // issues with Codex CLI: echo commands landed in Codex's textarea instead of
  // PowerShell when the CLI started before the 800ms delay elapsed.

  // Forward PTY output to all connected clients
  ptyProcess.onData((data) => {
    // Track last activity time
    terminalInfo.lastActivity = Date.now();

    // Smart Watchdog: Track last meaningful activity (ignore churning spinners)
    if (isMeaningfulActivity(data)) {
      terminalInfo.lastMeaningfulActivity = Date.now();
    }

    // Codex approval prompt fallback (best-effort)
    maybeAutoApprovePrompt(paneId, data);

    // U1: Buffer output for scrollback persistence
    appendToScrollback(terminalInfo, data);

    broadcast({
      event: 'data',
      paneId,
      data,
    });

    queuePtyDataKernelEvent(paneId, data, terminalInfo);
  });

  // Handle PTY exit
  ptyProcess.onExit(({ exitCode }) => {
    logInfo(`Terminal ${paneId} exited with code ${exitCode}`);
    terminalInfo.alive = false;
    broadcast({
      event: 'exit',
      paneId,
      code: exitCode,
    });

    broadcastKernelEvent('pty.down', {
      paneId,
      payload: { paneId: String(paneId), code: exitCode, reason: 'process_exit' },
      kernelMeta: terminalInfo.lastKernelMeta || null,
    });
  });

  return { paneId, pid: ptyProcess.pid, dryRun: false, mode: 'pty' };
}

// Write data to a terminal
function writeTerminal(paneId, data) {
  const terminal = terminals.get(paneId);
  if (!terminal) {
    return { ok: false, status: 'rejected_terminal_missing' };
  }
  if (!terminal.alive) {
    return { ok: false, status: 'rejected_not_alive' };
  }

  // DRY-RUN MODE: Handle input simulation
  if (terminal.dryRun) {
    // Track last INPUT time (for stuck detection)
    terminal.lastInputTime = Date.now();

    // Handle special characters BEFORE echoing
    if (data === '\r' || data === '\n') {
      // Enter: echo newline and process command
      broadcast({ event: 'data', paneId, data: '\r\n' });
      appendToScrollback(terminal, '\r\n');

      const input = terminal.inputBuffer;
      terminal.inputBuffer = '';

      // Generate and send mock response
      const response = generateMockResponse(input);
      if (response) {
        // Delay response slightly for realism
        setTimeout(() => {
          sendMockData(paneId, response);
        }, 100 + Math.random() * 200);
      }
    } else if (data === '\x7f' || data === '\b') {
      // Backspace: remove last character from buffer and screen
      if (terminal.inputBuffer.length > 0) {
        terminal.inputBuffer = terminal.inputBuffer.slice(0, -1);
        // Send escape sequence to visually delete: backspace, space, backspace
        broadcast({ event: 'data', paneId, data: '\b \b' });
        terminal.scrollback = terminal.scrollback.slice(0, -1);
      }
    } else {
      // Normal character: echo and add to buffer
      broadcast({ event: 'data', paneId, data });
      appendToScrollback(terminal, data);
      terminal.inputBuffer += data;
    }
    return { ok: true, status: 'accepted' };
  }

  // NORMAL MODE: Write to real PTY
  if (terminal.pty) {
    // Track last INPUT time (for stuck detection)
    terminal.lastInputTime = Date.now();
    terminal.pty.write(data);
    return { ok: true, status: 'accepted' };
  }
  return { ok: false, status: 'error' };
}

// Append to scrollback buffer with max size trimming

// Resize a terminal
function resizeTerminal(paneId, cols, rows) {
  const terminal = terminals.get(paneId);
  if (terminal && terminal.pty && terminal.alive) {
    terminal.pty.resize(cols, rows);
    return true;
  }
  return false;
}

// Kill a terminal
function killTerminal(paneId) {
  const terminal = terminals.get(paneId);
  if (!terminal) return false;

  // Clean up dry-run timer if exists
  if (terminal.dryRunTimer) {
    clearTimeout(terminal.dryRunTimer);
  }

  // Kill real PTY if not dry-run
  if (terminal.pty && !terminal.dryRun) {
    try {
      terminal.pty.kill();
    } catch (_e) { /* ignore */ }
  }

  terminal.alive = false;
  terminals.delete(paneId);
  logInfo(`Terminal ${paneId} killed (dryRun: ${terminal.dryRun || false})`);
  return true;
}

// List all terminals
function listTerminals() {
  const list = [];
  for (const [paneId, info] of terminals) {
      list.push({
        paneId,
        pid: info.pid,
        alive: info.alive,
        cwd: info.cwd,
        mode: info.mode || 'pty',
        // Include scrollback for session restoration
        scrollback: info.scrollback || '',
        dryRun: info.dryRun || false,
        createdAt: info.createdAt || null,
        lastActivity: info.lastActivity || null,
        lastMeaningfulActivity: info.lastMeaningfulActivity || null, // Smart Watchdog
        lastInputTime: info.lastInputTime || null,
    });
  }
  return list;
}

// Get stuck terminals (no INPUT for threshold ms AND no OUTPUT for 15s)
// Refined logic: Don't consider agent stuck if it's actively outputting data (streaming)
function getStuckTerminals(thresholdMs = DEFAULT_STUCK_THRESHOLD) {
  const now = Date.now();
  const stuck = [];
  const ACTIVITY_GRACE_PERIOD = 15000; // 15s grace for active output

  for (const [paneId, info] of terminals) {
    if (info.alive) {
      const lastInput = info.lastInputTime || 0;
      const lastActivity = info.lastActivity || 0;
      const lastMeaningful = info.lastMeaningfulActivity || lastActivity;

      const timeSinceInput = now - lastInput;
      const timeSinceActivity = now - lastActivity;
      const timeSinceMeaningful = now - lastMeaningful;

      // If agent is actively outputting data (within grace period), it's NOT stuck
      // UNLESS it's just churning (no meaningful output for a while)
      if (timeSinceActivity < ACTIVITY_GRACE_PERIOD) {
        // Only skip if it has also had meaningful activity recently
        if (timeSinceMeaningful < MEANINGFUL_ACTIVITY_TIMEOUT_MS) {
          continue;
        }
        // If we fall through, it's considered stuck (churning stall)
        logWarn(`[SmartWatchdog] Detected churning stall in pane ${paneId} (last meaningful: ${Math.round(timeSinceMeaningful/1000)}s ago)`);
      }

      // If meaningful time has passed since input AND it has stopped outputting (or is churning)
      if (lastInput > 0 && timeSinceInput > thresholdMs) {
        stuck.push({
          paneId,
          pid: info.pid,
          lastInputTime: info.lastInputTime,
          lastActivity: info.lastActivity,
          lastMeaningfulActivity: info.lastMeaningfulActivity || lastActivity,
          isChurning: timeSinceActivity < ACTIVITY_GRACE_PERIOD,
          idleTimeMs: timeSinceInput,
          idleTimeFormatted: formatUptime(Math.floor(timeSinceInput / 1000)),
        });
      }
    }
  }
  return stuck;
}

// Handle incoming client messages
function handleMessage(client, message) {
  try {
    const msg = JSON.parse(message);
    logInfo(`Received: ${msg.action} for pane ${msg.paneId || 'N/A'}`);

    switch (msg.action) {
      case 'spawn': {
        const result = spawnTerminal(msg.paneId, msg.cwd, msg.dryRun || false, {
          mode: msg.mode,
          env: msg.env,
          ...(msg.options && typeof msg.options === 'object' ? msg.options : {}),
        });
        sendToClient(client, {
          event: 'spawned',
          paneId: msg.paneId,
          pid: result.pid,
          dryRun: result.dryRun || false,
        });
        broadcastKernelEvent('pty.up', {
          paneId: msg.paneId,
          payload: {
            paneId: String(msg.paneId),
            pid: result.pid,
            mode: result.mode || 'pty',
            dryRun: result.dryRun || false,
          },
          kernelMeta: msg.kernelMeta || null,
        });
        break;
      }

      case 'write': {
        const paneId = String(msg.paneId || 'system');
        const requestedByEventId = msg?.kernelMeta?.eventId || null;
        const requestedEvent = sendKernelEvent(client, 'daemon.write.requested', {
          paneId,
          payload: {
            paneId,
            dataLen: Buffer.byteLength(String(msg.data || ''), 'utf8'),
            mode: terminals.get(paneId)?.mode || 'unknown',
            requestedBy: msg?.kernelMeta?.source || 'unknown',
            requestedByEventId,
          },
          kernelMeta: msg.kernelMeta || null,
        });

        // Ghost text deduplication - block duplicate inputs across panes
        const ghostCheck = checkGhostText(msg.paneId, msg.data);
        if (ghostCheck.isGhost) {
          ghostBlockCount++;
          const panesStr = ghostCheck.blockedPanes.join(', ');
          const truncatedInput = msg.data.length > 50 ? msg.data.substring(0, 50) + '...' : msg.data;
          logWarn(`[GHOST-BLOCK] #${ghostBlockCount} Blocked duplicate input to panes ${panesStr}: "${truncatedInput}"`);

          // Notify the requesting client
          sendToClient(client, {
            event: 'ghost-blocked',
            paneId: msg.paneId,
            blockedPanes: ghostCheck.blockedPanes,
            message: `Ghost text blocked - same input sent to ${ghostCheck.blockedPanes.length} panes within ${GHOST_DEDUP_WINDOW_MS}ms`,
            totalBlocks: ghostBlockCount,
          });

          // Also broadcast to all clients so UI can show feedback
          broadcast({
            event: 'ghost-blocked-broadcast',
            blockedPanes: ghostCheck.blockedPanes,
            inputPreview: truncatedInput,
            totalBlocks: ghostBlockCount,
            timestamp: new Date().toISOString(),
          });

          sendKernelEvent(client, 'daemon.write.ack', {
            paneId,
            payload: {
              paneId,
              status: 'blocked_ghost_dedup',
              reason: `duplicate_input_within_${GHOST_DEDUP_WINDOW_MS}ms`,
              requestedByEventId,
            },
            kernelMeta: msg.kernelMeta || null,
            correlationId: requestedEvent.correlationId,
            causationId: requestedEvent.eventId,
          });

          break; // Don't write the ghost text
        }

        const writeResult = writeTerminal(msg.paneId, msg.data);
        if (writeResult.ok) {
          const terminal = terminals.get(msg.paneId);
          if (terminal && msg.kernelMeta) {
            terminal.lastKernelMeta = { ...msg.kernelMeta };
            terminal.lastKernelMetaAt = Date.now();
          }
        }

        sendKernelEvent(client, 'daemon.write.ack', {
          paneId,
          payload: {
            paneId,
            status: writeResult.status,
            reason: writeResult.ok ? undefined : 'write_not_applied',
            bytesAccepted: writeResult.ok ? Buffer.byteLength(String(msg.data || ''), 'utf8') : 0,
            requestedByEventId,
          },
          kernelMeta: msg.kernelMeta || null,
          correlationId: requestedEvent.correlationId,
          causationId: requestedEvent.eventId,
        });

        if (!writeResult.ok && (writeResult.status === 'rejected_terminal_missing' || writeResult.status === 'rejected_not_alive')) {
          sendToClient(client, {
            event: 'error',
            paneId: msg.paneId,
            message: 'Terminal not found or not alive',
          });
        }
        break;
      }

      case 'resize': {
        const resized = resizeTerminal(msg.paneId, msg.cols, msg.rows);
        sendKernelEvent(client, 'pty.resize.ack', {
          paneId: String(msg.paneId || 'system'),
          payload: {
            paneId: String(msg.paneId || 'system'),
            cols: msg.cols,
            rows: msg.rows,
            status: resized ? 'accepted' : 'rejected_terminal_missing',
          },
          kernelMeta: msg.kernelMeta || null,
        });
        break;
      }

      case 'kill': {
        const existing = terminals.get(msg.paneId);
        killTerminal(msg.paneId);
        sendToClient(client, {
          event: 'killed',
          paneId: msg.paneId,
        });
        if (existing && existing.dryRun) {
          broadcastKernelEvent('pty.down', {
            paneId: msg.paneId,
            payload: {
              paneId: String(msg.paneId),
              reason: 'killed',
            },
            kernelMeta: existing.lastKernelMeta || null,
          });
        }
        break;
      }

      case 'list': {
        const terminalList = listTerminals();
        sendToClient(client, {
          event: 'list',
          terminals: terminalList,
        });
        break;
      }

      case 'pause': {
        const terminal = terminals.get(msg.paneId);
        if (terminal && terminal.pty) {
          // write XOFF (\x13) to pause when handleFlowControl is enabled
          terminal.pty.write('\x13');
          logInfo(`PTY paused for pane ${msg.paneId}`);
        }
        break;
      }

      case 'resume': {
        const terminal = terminals.get(msg.paneId);
        if (terminal && terminal.pty) {
          // write XON (\x11) to resume when handleFlowControl is enabled
          terminal.pty.write('\x11');
          logInfo(`PTY resumed for pane ${msg.paneId}`);
        }
        break;
      }

      case 'attach': {
        // Attach just means the client wants to receive data from this terminal
        // Since we broadcast to all clients, they're already "attached"
        const terminal = terminals.get(msg.paneId);
        if (terminal) {
          sendToClient(client, {
            event: 'attached',
            paneId: msg.paneId,
            pid: terminal.pid,
            alive: terminal.alive,
            // U1: Include scrollback buffer for session restoration
            scrollback: terminal.scrollback || '',
          });
        } else {
          sendToClient(client, {
            event: 'error',
            paneId: msg.paneId,
            message: 'Terminal not found',
          });
        }
        break;
      }

      case 'ping': {
        sendToClient(client, { event: 'pong' });
        break;
      }

      // D2: Health check endpoint
      case 'health': {
        const uptimeMs = Date.now() - daemonStartTime;
        const uptimeSecs = Math.floor(uptimeMs / 1000);
        const memUsage = process.memoryUsage();

        sendToClient(client, {
          event: 'health',
          uptime: uptimeSecs,
          uptimeFormatted: formatUptime(uptimeSecs),
          terminalCount: terminals.size,
          activeTerminals: [...terminals.values()].filter(t => t.alive).length,
          clientCount: clients.size,
          memory: {
            heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
            heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
            rss: Math.round(memUsage.rss / 1024 / 1024),
          },
          pid: process.pid,
        });
        logInfo(`Health check requested by client`);
        break;
      }

      // Heartbeat control
      case 'heartbeat-enable': {
        heartbeatEnabled = true;
        logInfo('[Heartbeat] Enabled via protocol');
        if (!heartbeatTimerId) {
          initHeartbeatTimer();
        }
        sendToClient(client, { event: 'heartbeat-status', enabled: true });
        break;
      }

      case 'heartbeat-disable': {
        heartbeatEnabled = false;
        logInfo('[Heartbeat] Disabled via protocol');
        if (heartbeatTimerId) {
          clearInterval(heartbeatTimerId);
          heartbeatTimerId = null;
        }
        if (heartbeatStateCheckTimerId) {
          clearInterval(heartbeatStateCheckTimerId);
          heartbeatStateCheckTimerId = null;
        }
        sendToClient(client, { event: 'heartbeat-status', enabled: false });
        break;
      }

      case 'heartbeat-status': {
        const currentState = getHeartbeatState();
        const currentInterval = HEARTBEAT_INTERVALS[currentState];
        sendToClient(client, {
          event: 'heartbeat-status',
          enabled: heartbeatEnabled,
          state: currentState,
          interval: currentInterval,
          isRecovering: isRecovering,
          architectNudgeCount,
          awaitingResponse: awaitingArchitectResponse,
          lastHeartbeat: lastHeartbeatTime,
        });
        // Also broadcast current state so UI updates
        broadcastHeartbeatState(currentState, currentInterval);
        break;
      }

      case 'heartbeat-trigger': {
        // Manually trigger a heartbeat
        heartbeatTick();
        sendToClient(client, { event: 'heartbeat-triggered' });
        break;
      }

      // ID-1: Session identity injection for /resume identification
      case 'inject-identity': {
        const paneId = msg.paneId;
        const terminal = terminals.get(paneId);
        if (!terminal || !terminal.alive) {
          sendToClient(client, {
            event: 'error',
            paneId: paneId,
            message: 'Terminal not found or not alive',
          });
          break;
        }

        const role = PANE_ROLES[paneId] || `Pane ${paneId}`;
        const d = new Date();
        const timestamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

        // Identity message that becomes part of Claude conversation
        // This shows in /resume session list, making it identifiable
        const identityMsg = `# SQUIDRUN SESSION: ${role} - Started ${timestamp}\n`;

        if (terminal.dryRun) {
          // Dry-run: just echo the message
          broadcast({ event: 'data', paneId, data: `\r\n${identityMsg}` });
          appendToScrollback(terminal, identityMsg);
        } else if (terminal.pty) {
          // Real PTY: write the identity message
          terminal.pty.write(identityMsg);
        }

        logInfo(`[Identity] Injected identity for ${role} (pane ${paneId})`);
        sendToClient(client, {
          event: 'identity-injected',
          paneId: paneId,
          role: role,
          message: identityMsg,
        });
        break;
      }

      // Auto-aggressive-nudge protocol actions
      case 'nudge-agent': {
        // Manually nudge a specific agent
        const success = sendAggressiveNudge(msg.paneId);
        sendToClient(client, {
          event: 'nudge-sent',
          paneId: msg.paneId,
          success: success,
        });
        break;
      }

      case 'nudge-status': {
        // Get current nudge state for all agents
        const nudgeStatus = {};
        for (const [paneId, state] of aggressiveNudgeState) {
          nudgeStatus[paneId] = {
            attempts: state.attempts,
            lastNudgeTime: state.lastNudgeTime,
            alerted: state.alerted,
            timeSinceNudge: state.lastNudgeTime ? Date.now() - state.lastNudgeTime : null,
          };
        }
        sendToClient(client, {
          event: 'nudge-status',
          agents: nudgeStatus,
          settings: {
            waitTime: AGGRESSIVE_NUDGE_WAIT,
            maxAttempts: MAX_AGGRESSIVE_NUDGES,
            stuckThreshold: STUCK_CHECK_THRESHOLD,
          },
        });
        break;
      }

      case 'nudge-reset': {
        // Reset nudge state for a specific agent or all agents
        if (msg.paneId) {
          aggressiveNudgeState.delete(msg.paneId);
          logInfo(`[AutoNudge] Reset nudge state for pane ${msg.paneId}`);
        } else {
          aggressiveNudgeState.clear();
          logInfo('[AutoNudge] Reset all nudge states');
        }
        sendToClient(client, {
          event: 'nudge-reset',
          paneId: msg.paneId || 'all',
          success: true,
        });
        break;
      }

      // Ghost text stats
      case 'ghost-stats': {
        sendToClient(client, {
          event: 'ghost-stats',
          totalBlocks: ghostBlockCount,
          dedupWindowMs: GHOST_DEDUP_WINDOW_MS,
          minInputLength: GHOST_MIN_INPUT_LENGTH,
          recentInputCount: recentInputs.length,
        });
        break;
      }

      // Get stuck terminals
      case 'stuck': {
        const threshold = msg.threshold || DEFAULT_STUCK_THRESHOLD;
        const stuckTerminals = getStuckTerminals(threshold);
        sendToClient(client, {
          event: 'stuck',
          terminals: stuckTerminals,
          threshold,
          count: stuckTerminals.length,
        });
        if (stuckTerminals.length > 0) {
          logWarn(`Stuck check: ${stuckTerminals.length} terminal(s) idle > ${threshold}ms`);
        }
        break;
      }

      // Session persistence protocol actions
      case 'get-session': {
        const state = loadSessionState();
        sendToClient(client, {
          event: 'session-state',
          state: state,
        });
        break;
      }

      case 'save-session': {
        saveSessionState();
        sendToClient(client, {
          event: 'session-saved',
          success: true,
        });
        break;
      }

      case 'clear-session': {
        clearSessionState();
        sendToClient(client, {
          event: 'session-cleared',
          success: true,
        });
        break;
      }

      case 'shutdown': {
        logInfo('Shutdown requested via protocol');
        // Save session state before shutdown
        saveSessionState();
        // Kill all terminals
        for (const [paneId] of terminals) {
          killTerminal(paneId);
        }
        // Close server
        server.close(() => {
          logInfo('[Daemon] Server closed');
          process.exit(0);
        });
        break;
      }

      default:
        sendToClient(client, {
          event: 'error',
          message: `Unknown action: ${msg.action}`,
        });
    }
  } catch (err) {
    logError(`Error handling message: ${err.message}`);
    sendToClient(client, {
      event: 'error',
      message: `Parse error: ${err.message}`,
    });
  }
}

// Create the server
const server = net.createServer((client) => {
  logInfo('Client connected');
  clients.add(client);

  // Buffer for incomplete messages (messages are newline-delimited)
  let buffer = '';

  client.on('data', (data) => {
    buffer += data.toString();

    // Process complete messages (newline-delimited)
    const lines = buffer.split('\n');
    buffer = lines.pop() || ''; // Keep incomplete line in buffer

    for (const line of lines) {
      if (line.trim()) {
        handleMessage(client, line.trim());
      }
    }
  });

  client.on('close', () => {
    logInfo('Client disconnected');
    clients.delete(client);
    // Don't kill terminals - that's the whole point!
  });

  client.on('error', (err) => {
    logError(`Client error: ${err.message}`);
    clients.delete(client);
  });

  // Send initial list of terminals to new client
  sendToClient(client, {
    event: 'connected',
    terminals: listTerminals(),
  });
});

// Clean up Unix socket file if it exists (Unix only)
function cleanupSocket() {
  if (os.platform() !== 'win32') {
    const fs = require('fs');
    try {
      if (fs.existsSync(PIPE_PATH)) {
        fs.unlinkSync(PIPE_PATH);
      }
    } catch (_e) { /* ignore */ }
  }
}

// Handle process signals
process.on('SIGINT', () => {
  logInfo('SIGINT received, shutting down...');
  // Save session state before shutdown
  saveSessionState();
  // Notify clients of shutdown
  broadcast({
    event: 'shutdown',
    message: 'Daemon is shutting down (SIGINT)',
    timestamp: new Date().toISOString(),
  });
  for (const [paneId] of terminals) {
    killTerminal(paneId);
  }
  server.close();
  cleanupSocket();
  process.exit(0);
});

// D3: Graceful shutdown with client notification
process.on('SIGTERM', () => {
  logInfo('SIGTERM received, initiating graceful shutdown...');

  // Save session state before shutdown
  saveSessionState();

  // Notify all clients before shutdown
  broadcast({
    event: 'shutdown',
    message: 'Daemon is shutting down',
    timestamp: new Date().toISOString(),
  });
  logInfo(`Notified ${clients.size} client(s) of shutdown`);

  // Give clients a moment to process the shutdown message
  setTimeout(() => {
    // Kill all terminals
    for (const [paneId] of terminals) {
      killTerminal(paneId);
    }
    logInfo('All terminals killed');

    server.close(() => {
      logInfo('Server closed, exiting');
      cleanupSocket();
      process.exit(0);
    });

    // Force exit after 2 seconds if server doesn't close cleanly
    setTimeout(() => {
      logWarn('Forced exit after timeout');
      cleanupSocket();
      process.exit(0);
    }, 2000);
  }, 100);
});

// Start the server
cleanupSocket();
initLogFile();

server.listen(PIPE_PATH, () => {
  logInfo(`Terminal daemon listening on ${PIPE_PATH}`);
  logInfo(`PID: ${process.pid}`);

  // Write PID file for easy process management
  const pidFile = path.join(__dirname, 'daemon.pid');
  try {
    fs.writeFileSync(pidFile, process.pid.toString());
    logInfo(`PID written to ${pidFile}`);
  } catch (err) {
    logError(`Failed to write PID file: ${err.message}`);
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    logError(`Another instance is already running on ${PIPE_PATH}`);
    process.exit(1);
  } else {
    logError(`Server error: ${err.message}`);
    process.exit(1);
  }
});
