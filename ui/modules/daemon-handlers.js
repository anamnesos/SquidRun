/**
 * Daemon handlers module
 * Handles IPC events from daemon and state changes
 *
 * MESSAGE QUEUE SYSTEM (Two-Queue Architecture):
 * 1. THROTTLE QUEUE (this file): Rate-limits messages (150ms between sends per pane)
 *    - Entry: enqueueForThrottle() called by IPC inject-message handler
 *    - Exit: processThrottleQueue() calls terminal.sendToPane()
 *    - Handles: PTY routing, special commands (UNSTICK, AGGRESSIVE_NUDGE)
 *
 * 2. IDLE QUEUE (injection.js): Waits for pane to be idle before injection
 *    - Entry: terminal.sendToPane() calls injection.processIdleQueue()
 *    - Exit: doSendToPane() performs actual PTY write + keyboard Enter
 *    - Handles: Focus management, idle detection, Enter verification
 */

const { invokeBridge, sendBridge, onBridge } = require('./renderer-bridge');
const { PANE_IDS, resolvePaneCwd } = require('../config');
const log = require('./logger');
const bus = require('./event-bus');
const diagnosticLog = require('./diagnostic-log');
const { showToast } = require('./notifications');
const uiView = require('./ui-view');

// Terminal module for health handlers (lazy loaded)
let terminal = null;
function getTerminal() {
  if (!terminal) {
    try {
      terminal = require('./terminal');
    } catch (_e) {
      // Terminal not available yet
    }
  }
  return terminal;
}

// THROTTLE QUEUE: Rate-limits message injection to prevent UI glitches
const throttleQueues = new Map(); // paneId -> array of messages
const throttlingPanes = new Set(); // panes currently being processed
const MESSAGE_DELAY = 100; // ms between messages per pane (reduced from 150ms — 3 panes = less contention)
const DEFAULT_THROTTLE_QUEUE_MAX_ITEMS = 200;
const DEFAULT_THROTTLE_QUEUE_MAX_BYTES = 512 * 1024;
let throttleQueueMaxItems = DEFAULT_THROTTLE_QUEUE_MAX_ITEMS;
let throttleQueueMaxBytes = DEFAULT_THROTTLE_QUEUE_MAX_BYTES;
let daemonRuntimeConfigPromise = null;
let daemonRuntimeConfigLoaded = false;

function toNonEmptyString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeTraceContext(traceContext = null, fallback = {}) {
  const ctx = (traceContext && typeof traceContext === 'object') ? traceContext : {};
  const traceId = toNonEmptyString(ctx.traceId)
    || toNonEmptyString(ctx.correlationId)
    || toNonEmptyString(fallback.traceId)
    || toNonEmptyString(fallback.correlationId)
    || null;
  const parentEventId = toNonEmptyString(ctx.parentEventId)
    || toNonEmptyString(ctx.causationId)
    || toNonEmptyString(fallback.parentEventId)
    || toNonEmptyString(fallback.causationId)
    || null;
  const eventId = toNonEmptyString(ctx.eventId)
    || toNonEmptyString(fallback.eventId)
    || null;

  if (!traceId && !parentEventId && !eventId) {
    return null;
  }

  return {
    ...ctx,
    traceId,
    parentEventId,
    eventId,
    correlationId: traceId,
    causationId: parentEventId,
  };
}

function isHmSendTraceContext(traceContext = null) {
  const ctx = (traceContext && typeof traceContext === 'object') ? traceContext : {};
  const messageId = toNonEmptyString(ctx.messageId);
  const traceId = toNonEmptyString(ctx.traceId) || toNonEmptyString(ctx.correlationId);
  return Boolean(
    (messageId && messageId.startsWith('hm-'))
    || (traceId && traceId.startsWith('hm-'))
  );
}

function toPositiveInt(value, fallback) {
  const numeric = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return numeric;
}

function applyDaemonRuntimeConfig(config = {}) {
  throttleQueueMaxItems = toPositiveInt(
    config?.throttleQueueMaxItems,
    DEFAULT_THROTTLE_QUEUE_MAX_ITEMS
  );
  throttleQueueMaxBytes = toPositiveInt(
    config?.throttleQueueMaxBytes,
    DEFAULT_THROTTLE_QUEUE_MAX_BYTES
  );
}

function ensureDaemonRuntimeConfigLoaded() {
  if (daemonRuntimeConfigLoaded) return daemonRuntimeConfigPromise || Promise.resolve();
  if (!daemonRuntimeConfigPromise) {
    daemonRuntimeConfigPromise = invokeBridge('get-daemon-runtime-config')
      .then((config) => {
        applyDaemonRuntimeConfig(config);
      })
      .catch((err) => {
        log.warn('Daemon', `Failed to load runtime config, using defaults: ${err.message}`);
      })
      .finally(() => {
        daemonRuntimeConfigLoaded = true;
      });
  }
  return daemonRuntimeConfigPromise;
}

function getThrottleQueueMaxItems() {
  return toPositiveInt(throttleQueueMaxItems, DEFAULT_THROTTLE_QUEUE_MAX_ITEMS);
}

function getThrottleQueueMaxBytes() {
  return toPositiveInt(throttleQueueMaxBytes, DEFAULT_THROTTLE_QUEUE_MAX_BYTES);
}

function getQueueItemBytes(item) {
  const msg = (item && typeof item === 'object') ? item.message : item;
  if (typeof msg !== 'string') return 0;
  return new TextEncoder().encode(msg).length;
}

function getThrottleQueueBytes(queue = []) {
  return queue.reduce((total, item) => total + getQueueItemBytes(item), 0);
}

// Sync indicator state
const syncState = new Map();
let syncIndicatorSetup = false;
const ipcListenerRegistry = new Map();

// Session timers
const sessionStartTimes = new Map();
let timerInterval = null;

// Callbacks
let onConnectionStatusUpdate = null;

function setStatusCallbacks(connectionCb) {
  onConnectionStatusUpdate = connectionCb;
}

function removeIpcListener(entry) {
  if (!entry || typeof entry.dispose !== 'function') return;
  entry.dispose();
}

function registerScopedIpcListener(scope, channel, handler) {
  const key = `${scope}:${channel}`;
  const existing = ipcListenerRegistry.get(key);
  if (existing) {
    removeIpcListener(existing);
  }
  const dispose = onBridge(channel, handler);
  ipcListenerRegistry.set(key, { channel, handler, dispose });
}

function clearScopedIpcListeners(scope = null) {
  for (const [key, entry] of ipcListenerRegistry.entries()) {
    if (scope && !key.startsWith(`${scope}:`)) continue;
    removeIpcListener(entry);
    ipcListenerRegistry.delete(key);
  }
}

function updateConnectionStatus(status) {
  if (onConnectionStatusUpdate) {
    onConnectionStatusUpdate(status);
  }
}

function normalizePath(value) {
  if (!value) return '';
  return String(value)
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .toLowerCase();
}

function basenameFromPath(value) {
  const normalized = String(value || '').trim().replace(/\\/g, '/');
  if (!normalized) return '';
  const parts = normalized.split('/');
  return parts[parts.length - 1] || '';
}

async function isProcessRunning(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return false;
  try {
    const result = await invokeBridge('daemon-is-process-running', numericPid);
    if (result && typeof result === 'object') {
      return result.running === true;
    }
    return result === true;
  } catch (err) {
    log.debug('Daemon', `Process liveness probe failed for pid ${numericPid}: ${err.message}`);
    return false;
  }
}

const CLI_TAIL_CHARS = 2000;
const CLI_RECENT_ACTIVITY_MS = 60000;
const CLI_PROMPT_REGEXES = [
  /(^|\n)>\s/m, // Claude/Gemini prompt at line start
  /(^|\n)codex>\s/m,
  /(^|\n)gemini>\s/m,
  /gemini cli/i,
];
const SHELL_PROMPT_REGEXES = [
  /(^|\n)PS [^\n>]*>\s/m,     // PowerShell prompt
  /(^|\n)[A-Z]:\\[^\n>]*>\s/m, // cmd.exe prompt
  /(^|\n)[^\n]*[$%#]\s*$/m,   // Unix shell prompt (bash/zsh)
];

function stripAnsi(value) {
  return String(value || '')
    .replace(/\x1B\][^\x07]*(\x07|\x1B\\)/g, '')
    .replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function stripInternalRoutingWrappers(value) {
  if (typeof value !== 'string') return value;
  let clean = value;
  clean = clean.replace(/^\s*\[AGENT MSG - reply via hm-send\.js\]\s*/i, '');
  for (let i = 0; i < 3; i += 1) {
    const next = clean.replace(/^\s*\[MSG from [^\]]+\]:\s*/i, '');
    if (next === clean) break;
    clean = next;
  }
  return clean;
}

function tailMatches(regexes, text) {
  return regexes.some((regex) => regex.test(text));
}

async function hasCliContent(scrollback = '', meta = {}) {
  const alive = Boolean(meta?.alive);
  const mode = String(meta?.mode || '').toLowerCase();

  // Primary signal: if an alive PTY process still exists, treat as an active
  // session regardless of prompt/content heuristics.
  if (alive && mode === 'pty') {
    return isProcessRunning(meta?.pid);
  }

  // Dry-run mode has no real PTY process and is tracked by alive status only.
  if (alive && mode === 'dry-run') {
    return true;
  }

  const text = String(scrollback || '');
  if (!text) return false;

      const tail = stripAnsi(text.slice(-CLI_TAIL_CHARS));
      if (tailMatches(CLI_PROMPT_REGEXES, tail)) return true;
      if (tailMatches(SHELL_PROMPT_REGEXES, tail)) {
        log.info('Daemon Handlers', 'Detected shell prompt in tail, treating as empty CLI');    
        return false;
      }
  const lastActivity = Number(meta?.lastActivity || 0);
  if (lastActivity > 0 && (Date.now() - lastActivity) <= CLI_RECENT_ACTIVITY_MS) {
    return true;
  }

  return false;
}

// ============================================================
// SYNC STATE MANAGEMENT
// ============================================================

function setSyncState(file, nextState) {
  const current = syncState.get(file) || {};
  const merged = { ...current, ...nextState };
  syncState.set(file, merged);
  uiView.updateSyncChip(file, merged);
}

function handleSyncFileChanged(payload = {}) {
  const file = payload.file;
  if (!uiView.SYNC_FILES[file]) return;
  setSyncState(file, {
    status: 'dirty',
    changedAt: payload.changedAt || Date.now(),
    source: 'watcher'
  });
}

function handleSyncTriggered(payload = {}) {
  const file = payload.file;
  if (!uiView.SYNC_FILES[file]) return;
  const notified = Array.isArray(payload.notified) ? payload.notified : [];
  setSyncState(file, {
    status: notified.length > 0 ? 'synced' : 'skipped',
    syncedAt: Date.now(),
    notified,
    mode: payload.mode || 'pty',
    source: 'auto-sync'
  });
}

function _reg(evt, cb) { registerScopedIpcListener('sync', evt, cb); }

function setupSyncIndicator() {
  if (syncIndicatorSetup) return;
  syncIndicatorSetup = true;

  uiView.init();

  _reg('sync-file-changed', (event, payload) => {
    handleSyncFileChanged(payload);
  });

  _reg('sync-triggered', (event, payload) => {
    handleSyncTriggered(payload);
  });
}

// ============================================================
// DAEMON LISTENERS
// ============================================================

function setupDaemonListeners(initTerminalsFn, reattachTerminalFn, setReconnectedFn, onTerminalsReadyFn) {       
  clearScopedIpcListeners('daemon-core');
  ensureDaemonRuntimeConfigLoaded();

  registerScopedIpcListener('daemon-core', 'kernel:bridge-event', (event, envelope) => {
    if (!envelope || typeof envelope !== 'object' || !envelope.event) return;
    bus.ingest(envelope.event);
  });

  registerScopedIpcListener('daemon-core', 'kernel:bridge-stats', (event, stats) => {
    if (!stats || typeof stats !== 'object') return;
    log.debug('KernelBridge', `Stats update: forwarded=${stats.forwardedCount || 0} dropped=${stats.droppedCount || 0}`);
  });

  // Handle initial daemon connection with existing terminals
  registerScopedIpcListener('daemon-core', 'daemon-connected', async (event, data) => {
    const { terminals: existingTerminals } = data || {};
    const terminalList = Array.isArray(existingTerminals) ? existingTerminals : [];
    const aliveCount = terminalList.filter((term) => term?.alive).length;
    const paneSummary = terminalList
      .map((term) => `${String(term?.paneId ?? '?')}:${term?.alive ? 'up' : 'down'}`)
      .join(', ');
    log.info(
      'Daemon',
      `Connected: terminals=${terminalList.length}, alive=${aliveCount}, panes=[${paneSummary || 'none'}]`
    );

    if (existingTerminals && existingTerminals.length > 0) {
      updateConnectionStatus('Reconnecting to existing sessions...');
      const panesWithCli = new Set();
      const panesNeedingSpawn = new Set();

      for (const term of existingTerminals) {
        if (!term || !term.alive) continue;
        const paneId = String(term.paneId);
        if (await hasCliContent(term.scrollback, term)) {
          panesWithCli.add(paneId);
        } else {
          panesNeedingSpawn.add(paneId);
        }
      }

      setReconnectedFn(true);
      if (panesNeedingSpawn.size > 0) {
        log.info('Daemon', `Detected empty CLI shells, will spawn for panes: ${[...panesNeedingSpawn].join(', ')}`);
      } else {
        log.info('Daemon', 'All alive terminals have CLI content, skipping auto-spawn');
      }

      const existingPaneIds = new Set();
      for (const term of existingTerminals) {
        if (term.alive) {
          const paneId = String(term.paneId);
          const expectedDir = resolvePaneCwd(paneId);
          const cwd = term.cwd;
          const hasMismatch = expectedDir && cwd &&
            normalizePath(expectedDir) !== normalizePath(cwd);

          if (hasMismatch) {
            log.warn('Reattach', `Pane ${paneId} cwd mismatch (expected: ${expectedDir}, got: ${cwd}) - updating session state to correct cwd`);
            term.cwd = expectedDir;
          }

          existingPaneIds.add(paneId);
          await reattachTerminalFn(paneId, term.scrollback, { createdAt: term.createdAt || null });
        }
      }

      const missingPanes = PANE_IDS.filter(id => !existingPaneIds.has(id));
      if (missingPanes.length > 0) {
        log.info('Daemon', 'Creating missing terminals for panes:', missingPanes);
        for (const paneId of missingPanes) {
          const terminal = require('./terminal');
          await terminal.initTerminal(paneId);
        }
      }

      if (missingPanes.length > 0) {
        for (const paneId of missingPanes) {
          panesNeedingSpawn.add(String(paneId));
        }
      }

      if (panesNeedingSpawn.size > 0) {
        let autoSpawnEnabled = true;
        try {
          const settings = await invokeBridge('get-settings');
          if (settings && settings.autoSpawn === false) {
            autoSpawnEnabled = false;
          }
          if (settings && settings.autonomyConsentGiven !== true) {
            autoSpawnEnabled = false;
            log.info('Daemon', 'Auto-spawn blocked pending autonomy consent');
          }
        } catch (err) {
          log.warn('Daemon', `Failed to read settings for auto-spawn: ${err.message}`);
        }

        if (autoSpawnEnabled) {
          updateConnectionStatus(`Spawning agents in panes: ${[...panesNeedingSpawn].join(', ')}`);
          const terminal = require('./terminal');
          for (const paneId of panesNeedingSpawn) {
            try {
              await terminal.spawnAgent(paneId);
            } catch (err) {
              log.error('Daemon', `Failed to spawn CLI for pane ${paneId}`, err);
            }
          }
        } else {
          log.info('Daemon', `Auto-spawn disabled; leaving panes empty: ${[...panesNeedingSpawn].join(', ')}`);
        }
      }

      updateConnectionStatus(`Restored ${existingTerminals.length} terminal(s)${missingPanes.length > 0 ? `, created ${missingPanes.length} new` : ''}`);
    } else {
      log.info('Daemon', 'No existing terminals, creating new ones...');
      updateConnectionStatus('Creating terminals...');
      await initTerminalsFn();
      updateConnectionStatus('Ready');
    }

    if (onTerminalsReadyFn) {
      onTerminalsReadyFn(false);
    }
  });

  registerScopedIpcListener('daemon-core', 'daemon-reconnected', (_event) => {
    log.info('Daemon', 'Reconnected after disconnect');
    updateConnectionStatus('Daemon reconnected');
  });

  registerScopedIpcListener('daemon-core', 'daemon-disconnected', (_event) => {
    log.info('Daemon', 'Disconnected');
    updateConnectionStatus('Daemon disconnected - terminals may be stale');
  });

  registerScopedIpcListener('daemon-core', 'inject-message', (event, data) => {
    const { panes, message, deliveryId, traceContext, traceCtx } = data || {};
    const normalizedTraceContext = normalizeTraceContext(traceContext || traceCtx, {
      traceId: deliveryId || null,
    });
    for (const paneId of panes || []) {
      log.info('Inject', `Received inject-message for pane ${paneId}`);
      diagnosticLog.write('Inject', `Received inject-message for pane ${paneId}`);
      const corrId = normalizedTraceContext?.traceId || normalizedTraceContext?.correlationId || undefined;
      const causationId = normalizedTraceContext?.parentEventId || normalizedTraceContext?.causationId || undefined;
      bus.emit('inject.route.received', {
        paneId: String(paneId),
        payload: { deliveryId: deliveryId || null },
        correlationId: corrId,
        causationId,
        source: 'daemon-handlers.js',
      });
      enqueueForThrottle(String(paneId), message, deliveryId, normalizedTraceContext);
    }
  });

  registerScopedIpcListener('daemon-core', 'nudge-pane', (event, data) => {
    const { paneId } = data || {};
    const term = getTerminal();
    if (paneId && typeof term?.nudgePane === 'function') {
      log.info('Health', `Nudging pane ${paneId}`);
      term.nudgePane(String(paneId));
    }
  });

  registerScopedIpcListener('daemon-core', 'restart-pane', (event, data) => {
    const { paneId } = data || {};
    const term = getTerminal();
    if (paneId && typeof term?.restartPane === 'function') {
      log.info('Health', `Restarting pane ${paneId}`);
      term.restartPane(String(paneId));
    }
  });

  registerScopedIpcListener('daemon-core', 'restart-all-panes', () => {
    log.info('Health', 'Restarting all panes');
    const term = getTerminal();
    if (typeof term?.freshStartAll === 'function') {
      term.freshStartAll();
    }
  });
}

function setupRollbackListener() {
  registerScopedIpcListener('rollback', 'rollback-available', (_event, data) => {
    uiView.showRollbackUI(data, async (checkpointId, _files) => {
      try {
        const result = await invokeBridge('apply-rollback', checkpointId);
        if (result && result.success) {
          showToast(`Rolled back ${result.filesRestored} file(s)`, 'info');
          uiView.hideRollbackUI();
        } else {
          showToast(`Rollback failed: ${result?.error || 'Unknown error'}`, 'warning');
        }
      } catch (err) {
        showToast(`Rollback error: ${err.message}`, 'warning');
      }
    });
  });

  registerScopedIpcListener('rollback', 'rollback-cleared', () => {
    uiView.hideRollbackUI();
  });
}

function setupHandoffListener() {
  registerScopedIpcListener('handoff', 'task-handoff', (event, data) => {
    uiView.showHandoffNotification(data);
  });

  registerScopedIpcListener('handoff', 'auto-handoff', (event, data) => {
    uiView.showHandoffNotification({ ...data, reason: data.reason || 'Auto-handoff triggered' });
  });
}

function setupConflictResolutionListener() {
  registerScopedIpcListener('conflict', 'file-conflict', (event, data) => {
    const conflicts = Array.isArray(data) ? data : [data];
    for (const conflict of conflicts) {
      if (!conflict || typeof conflict !== 'object') continue;
      const agents = Array.isArray(conflict.agents)
        ? conflict.agents
        : (Array.isArray(conflict.workers) ? conflict.workers : []);
      uiView.showConflictNotification({ ...conflict, agents });
    }
  });

  registerScopedIpcListener('conflict', 'conflict-resolved', (event, data) => {
    uiView.showConflictNotification({ ...data, status: 'resolved' });
  });
}

function setupAutoTriggerListener() {
  registerScopedIpcListener('auto-trigger', 'auto-trigger', (event, data) => {
    uiView.showAutoTriggerFeedback(data);
  });

  registerScopedIpcListener('auto-trigger', 'completion-detected', async (event, data) => {
    const { paneId, pattern } = data;
    log.info('Completion', `Pane ${paneId} completed: ${pattern}`);
    showToast(`${uiView.PANE_ROLES[paneId] || `Pane ${paneId}`} completed task`, 'info');

    try {
      const claims = await invokeBridge('get-claims');
      const claimEntry = (claims && typeof claims === 'object') ? claims[String(paneId)] : null;
      const taskId = typeof claimEntry === 'string' ? claimEntry : claimEntry?.taskId;
      if (!taskId) return;

      await invokeBridge('update-task-status', {
        taskId,
        status: 'completed',
        metadata: {
          paneId: String(paneId),
          source: 'completion-detected',
          pattern: pattern || null,
        },
      });
      await invokeBridge('release-agent', String(paneId));
    } catch (err) {
      log.warn('Completion', `Failed to resolve task lifecycle for pane ${paneId}: ${err.message}`);
    }
  });
}

function setupProjectListener() {
  registerScopedIpcListener('project', 'project-changed', (event, projectPath) => {
    log.info('Project', 'Changed to:', projectPath);
    uiView.updateProjectDisplay(projectPath);
    const projectName = projectPath ? basenameFromPath(projectPath) : 'Developer Mode';
    showToast(`Project changed to ${projectName || 'Developer Mode'} — restart agents to apply`, 'warning');
  });
  registerScopedIpcListener('project', 'project-warning', (event, message) => {
    log.warn('Project', message);
    showToast(message, 'warning');
  });
}

function setupCostAlertListener() {
  registerScopedIpcListener('cost-alert', 'cost-alert', (event, data) => {
    uiView.showCostAlert(data);
    showToast(data.message, 'warning');
  });
}

function setupClaudeStateListener(handleTimerStateFn) {
  registerScopedIpcListener('claude-state', 'claude-state-changed', (event, states) => {
    log.info('Agent State', 'Received:', states);
    for (const [paneId, state] of Object.entries(states)) {
      uiView.updateAgentStatus(paneId, state);
      if (handleTimerStateFn) {
        handleTimerStateFn(paneId, state);
      } else {
        handleSessionTimerState(paneId, state);
      }
    }
  });
}

function teardownDaemonListeners() {
  clearScopedIpcListeners();
  syncIndicatorSetup = false;
  throttleQueues.clear();
  throttlingPanes.clear();
}

function setupRefreshButtons(sendToPaneFn) {
  // This still needs direct DOM access as it sets up event listeners on specific buttons
  document.querySelectorAll('.pane-refresh-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const paneId = btn.dataset.paneId;
      const refreshPrompt =
        `Refresh startup context: read ROLES.md, runtime memory snapshot (Evidence Ledger + Team Memory), .squidrun/build/blockers.md, ` +
        `.squidrun/build/errors.md, .squidrun/handoffs/session.md, and .squidrun/context-snapshots/${paneId}.md. Then report status.`;
      sendToPaneFn(paneId, `${refreshPrompt}\r`);
    });
  });
}

function setupPaneProjectClicks() {
  for (const paneId of PANE_IDS) {
    const el = document.getElementById(`project-${paneId}`);
    if (el) {
      el.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          const result = await invokeBridge('select-pane-project', paneId);
          if (result && result.success) {
            uiView.updatePaneProject(paneId, result.path);
          }
        } catch (err) {
          log.error('MP2', `Error selecting project for pane ${paneId}:`, err);
        }
      });
    }
  }
}

async function loadInitialAgentTasks() {
  try {
    const state = await invokeBridge('get-state');
    if (state) {
      uiView.updateAgentTasks(state.agent_claims || {});
    }
  } catch (err) {
    log.error('CB1', 'Error loading initial agent tasks:', err);
  }
}

async function loadPaneProjects() {
  try {
    const result = await invokeBridge('get-all-pane-projects');
    if (result && result.success) {
      for (const [paneId, projectPath] of Object.entries(result.paneProjects || {})) {
        uiView.updatePaneProject(paneId, projectPath);
      }
    }
  } catch (err) {
    log.error('MP2', 'Error loading pane projects:', err);
  }
}

// ============================================================
// THROTTLE QUEUE
// ============================================================

function enqueueForThrottle(paneId, message, deliveryId, traceContext = null) {
  if (!throttleQueues.has(paneId)) {
    throttleQueues.set(paneId, []);
  }
  const queue = throttleQueues.get(paneId);
  const incomingItem = {
    message,
    deliveryId: deliveryId || null,
    traceContext: traceContext || null,
  };
  const maxItems = getThrottleQueueMaxItems();
  const maxBytes = getThrottleQueueMaxBytes();
  const incomingBytes = getQueueItemBytes(incomingItem);

  if (incomingBytes > maxBytes) {
    log.warn(
      'ThrottleQueue',
      `Dropping oversize message for pane ${paneId} (${incomingBytes} bytes > ${maxBytes} byte cap)`
    );
    diagnosticLog.write(
      'ThrottleQueue',
      `Dropped oversize message for pane ${paneId} (${incomingBytes} bytes > ${maxBytes} cap)`
    );
    return;
  }

  let queueBytes = getThrottleQueueBytes(queue);
  let droppedCount = 0;
  while (
    queue.length >= maxItems
    || ((queueBytes + incomingBytes) > maxBytes && queue.length > 0)
  ) {
    const dropped = queue.shift();
    queueBytes -= getQueueItemBytes(dropped);
    droppedCount += 1;
  }

  if (droppedCount > 0) {
    log.warn(
      'ThrottleQueue',
      `Queue cap reached for pane ${paneId}; dropped ${droppedCount} stale message(s) `
      + `(maxItems=${maxItems}, maxBytes=${maxBytes})`
    );
  }

  queue.push(incomingItem);
  log.info('ThrottleQueue', `Queued for pane ${paneId}, queue length: ${queue.length}`);
  diagnosticLog.write('ThrottleQueue', `Queued for pane ${paneId}, queue length: ${queue.length}`);
  processThrottleQueue(paneId);
}

function processThrottleQueue(paneId) {
  if (throttlingPanes.has(paneId)) return;

  const queue = throttleQueues.get(paneId);
  if (!queue || queue.length === 0) return;

  throttlingPanes.add(paneId);

  const item = queue.shift();
  const message = typeof item === 'string' ? item : item.message;
  const routedMessage = stripInternalRoutingWrappers(message);
  const deliveryId = item && typeof item === 'object' ? item.deliveryId : null;
  const traceContext = item && typeof item === 'object' ? (item.traceContext || null) : null;
  const hmSendFastEnter = isHmSendTraceContext(traceContext);
  const corrId = traceContext?.traceId || traceContext?.correlationId || undefined;
  const causationId = traceContext?.parentEventId || traceContext?.causationId || undefined;

  const terminal = require('./terminal');

  if (message.trim() === '(UNSTICK)') {
    log.info('Daemon', `Sending UNSTICK (ESC) to pane ${paneId}`);
    terminal.sendUnstick(paneId);
    uiView.flashPaneHeader(paneId);
    throttlingPanes.delete(paneId);
    if (queue.length > 0) {
      setTimeout(() => processThrottleQueue(paneId), MESSAGE_DELAY);
    } else {
      throttleQueues.delete(paneId);
    }
    return;
  }

  if (message.trim() === '(AGGRESSIVE_NUDGE)') {
    log.info('Daemon', `Sending AGGRESSIVE_NUDGE (ESC + Enter) to pane ${paneId}`);
    terminal.aggressiveNudge(paneId);
    uiView.flashPaneHeader(paneId);
    throttlingPanes.delete(paneId);
    if (queue.length > 0) {
      setTimeout(() => processThrottleQueue(paneId), MESSAGE_DELAY);
    } else {
      throttleQueues.delete(paneId);
    }
    return;
  }

  uiView.flashPaneHeader(paneId);
  bus.emit('inject.route.dispatched', {
    paneId: String(paneId),
    payload: { deliveryId: deliveryId || null, mode: 'pty' },
    correlationId: corrId,
    causationId,
    source: 'daemon-handlers.js',
  });

  let queueFinalized = false;
  const finalizeQueueProcessing = () => {
    if (queueFinalized) return;
    queueFinalized = true;

    throttlingPanes.delete(paneId);
    if (queue.length > 0) {
      setTimeout(() => processThrottleQueue(paneId), MESSAGE_DELAY);
    } else {
      throttleQueues.delete(paneId);
    }
  };

  let sendScheduled = false;
  try {
    terminal.sendToPane(paneId, routedMessage, {
      traceContext: traceContext || undefined,
      hmSendFastEnter,
      onComplete: (result) => {
      const status = typeof result?.status === 'string' ? result.status : '';
      const reason = typeof result?.reason === 'string' ? result.reason : '';
      const statusLower = status.toLowerCase();
      const reasonLower = reason.toLowerCase();
      const submitUnverified = (
        reasonLower === 'submit_not_accepted'
        || statusLower === 'submit_not_accepted'
        || statusLower.includes('unverified')
        || (result?.verified === false && result?.success !== false)
      );
      const accepted = submitUnverified || !result || result.success !== false;
      if (!accepted) {
        log.warn('Daemon', `Trigger delivery failed for pane ${paneId}: ${result.reason || 'unknown'}`);
        uiView.showDeliveryFailed(paneId, result.reason || 'Delivery failed');
        if (deliveryId) {
          sendBridge('trigger-delivery-outcome', {
            deliveryId,
            paneId,
            accepted: false,
            verified: false,
            status: result?.status || result?.reason || 'delivery_failed',
            reason: result?.reason || null,
          });
        }
      } else {
        // Message was typed + Enter pressed = delivered.
        // Verification is best-effort; unverified does NOT mean undelivered.
        const verified = submitUnverified ? false : (result?.verified !== false);
        if (!verified) {
          log.info('Daemon', `Trigger delivery sent for pane ${paneId} (verification skipped: ${result?.reason || 'agent busy'})`);
        }
        uiView.showDeliveryIndicator(paneId, 'delivered');
        if (deliveryId) {
          if (!verified) {
            sendBridge('trigger-delivery-outcome', {
              deliveryId,
              paneId,
              accepted: true,
              verified: false,
              status: 'accepted.unverified',
              reason: result?.reason || (result?.status || 'delivery_unverified'),
            });
          } else {
            sendBridge('trigger-delivery-ack', { deliveryId, paneId });
          }
        }
      }

        finalizeQueueProcessing();
      }
    });
    sendScheduled = true;
  } finally {
    if (!sendScheduled) {
      finalizeQueueProcessing();
    }
  }
}

// ============================================================
// SESSION TIMERS
// ============================================================

function handleSessionTimerState(paneId, state) {
  const timerEl = document.getElementById('sessionTimer');
  if (timerEl) timerEl.classList.add('active');
  if (state === 'running' && !sessionStartTimes.has(paneId)) {
    sessionStartTimes.set(paneId, Date.now());
    startTimerInterval();
  } else if (state === 'idle' && sessionStartTimes.has(paneId)) {
    sessionStartTimes.delete(paneId);
  }
}

function startTimerInterval() {
  if (!timerInterval) {
    timerInterval = setInterval(() => {
      if (sessionStartTimes.size === 0 && timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
      }
    }, 1000);
  }
}

function getTotalSessionTime() {
  let total = 0;
  const now = Date.now();
  for (const startTime of sessionStartTimes.values()) {
    total += Math.floor((now - startTime) / 1000);
  }
  return total;
}

// ============================================================
// PROJECT PICKER
// ============================================================

async function selectProject() {
  updateConnectionStatus('Selecting project...');
  try {
    const result = await window.squidrun.project.select();
    if (result.success) {
      uiView.updateProjectDisplay(result.path);
      updateConnectionStatus(`Project: ${result.path}`);
    } else if (result.canceled) {
      updateConnectionStatus('Project selection canceled');
    } else {
      updateConnectionStatus('Failed to select project');
    }
  } catch (err) {
    updateConnectionStatus(`Error: ${err.message}`);
  }
}

async function loadInitialProject() {
  try {
    const projectPath = await window.squidrun.project.get();
    uiView.updateProjectDisplay(projectPath || null);
  } catch (err) {
    log.error('Daemon', 'Error loading initial project:', err);
  }
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  setStatusCallbacks,
  teardownDaemonListeners,
  setupDaemonListeners,
  setupSyncIndicator,
  handleSessionTimerState,
  getTotalSessionTime,
  selectProject,
  loadInitialProject,
  // Individual listeners for renderer.js
  setupRollbackListener,
  setupHandoffListener,
  setupConflictResolutionListener,
  setupAutoTriggerListener,
  setupProjectListener,
  setupCostAlertListener,
  setupClaudeStateListener,
  setupRefreshButtons,
  setupPaneProjectClicks,
  loadInitialAgentTasks,
  loadPaneProjects,
  // Re-export for backward compatibility (fixes tests)
  showConflictNotification: uiView.showConflictNotification,
  showDeliveryIndicator: uiView.showDeliveryIndicator,
  showToast,
  showDeliveryFailed: uiView.showDeliveryFailed,
  updatePaneProject: uiView.updatePaneProject,
  updateAllPaneProjects(projects) {
    if (!projects) return;
    Object.entries(projects).forEach(([id, path]) => uiView.updatePaneProject(id, path));
  },
  updateAgentTasks: uiView.updateAgentTasks,
  showHandoffNotification: uiView.showHandoffNotification,
  showAutoTriggerFeedback: uiView.showAutoTriggerFeedback,
  showRollbackUI: uiView.showRollbackUI,
  hideRollbackUI: uiView.hideRollbackUI,
  updateAgentStatus: uiView.updateAgentStatus,
  flashPaneHeader: uiView.flashPaneHeader,
  PANE_IDS,
  PANE_ROLES: uiView.PANE_ROLES,
  _resetForTesting: uiView._resetForTesting,
  _getThrottleQueueDepthForTesting(paneId) {
    const id = String(paneId || '');
    const queue = throttleQueues.get(id);
    return Array.isArray(queue) ? queue.length : 0;
  },
  _resetThrottleQueueForTesting() {
    throttleQueues.clear();
    throttlingPanes.clear();
    throttleQueueMaxItems = DEFAULT_THROTTLE_QUEUE_MAX_ITEMS;
    throttleQueueMaxBytes = DEFAULT_THROTTLE_QUEUE_MAX_BYTES;
    daemonRuntimeConfigLoaded = false;
    daemonRuntimeConfigPromise = null;
  },
};
