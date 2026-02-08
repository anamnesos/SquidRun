/**
 * Self-Healing Recovery Manager
 * Detects stuck/failed agents, restarts with backoff, and enforces circuit breakers.
 */

const log = require('./logger');

const DEFAULT_CONFIG = {
  stuckThresholdMs: 120000,
  stuckConfirmCount: 2,
  restartConfirmMs: 20000,
  backoffBaseMs: 5000,
  backoffMaxMs: 120000,
  taskRetryBaseMs: 2000,
  taskRetryMaxMs: 60000,
  taskRetryMaxAttempts: 5,
  circuitMaxFailures: 3,
  circuitWindowMs: 5 * 60 * 1000,
  circuitCooldownMs: 5 * 60 * 1000,
  expectedExitTtlMs: 15000,
  resyncDelayMs: 15000,
  ptyStuckThresholdMs: 15000,
  ptyStuckCooldownMs: 30000,
};

const MAX_TASK_CHARS = 4000;
const TOKEN_REGEX = /(\d+(?:\.\d+)?)\s*([kKmM]?)\s*tokens\b/g;
const TIMER_REGEX = /(\d{1,4})s\b/g;
const OSC_REGEX = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;
const CSI_REGEX = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

function stripAnsi(input) {
  return String(input || '')
    .replace(OSC_REGEX, '')
    .replace(CSI_REGEX, '')
    .replace(/\u001b[\(\)][A-Za-z0-9]/g, '')
    .replace(/\r/g, '\n');
}

function parseTokenCount(text) {
  if (!text) return null;
  TOKEN_REGEX.lastIndex = 0;
  const matches = [...text.matchAll(TOKEN_REGEX)];
  if (!matches.length) return null;
  const match = matches[matches.length - 1];
  let value = Number.parseFloat(match[1]);
  if (Number.isNaN(value)) return null;
  const suffix = (match[2] || '').toLowerCase();
  if (suffix === 'k') value *= 1000;
  if (suffix === 'm') value *= 1000000;
  return Math.round(value);
}

function parseTimerSeconds(text) {
  if (!text) return null;
  TIMER_REGEX.lastIndex = 0;
  const matches = [...text.matchAll(TIMER_REGEX)];
  if (!matches.length) return null;
  const match = matches[matches.length - 1];
  const value = Number.parseInt(match[1], 10);
  return Number.isNaN(value) ? null : value;
}

const PLAYBOOKS = {
  stuck: {
    title: 'Stuck Agent Recovery',
    steps: [
      'Detect idle/stuck agent beyond threshold',
      'Send interrupt/nudge',
      'If still stuck, restart terminal with backoff',
      'Re-sync shared context after restart',
      'Resend last task context',
    ],
  },
  crash: {
    title: 'Unexpected Exit Recovery',
    steps: [
      'Detect non-zero exit or unexpected termination',
      'Restart terminal with exponential backoff',
      'Resend last task context',
      'Trip circuit breaker after repeated failures',
      'Notify user for manual intervention if circuit open',
    ],
  },
  circuit: {
    title: 'Circuit Breaker Open',
    steps: [
      'Pause automatic restarts',
      'Wait for cooldown window',
      'Require manual restart or reset circuit',
    ],
  },
};

function createRecoveryManager(options = {}) {
  const {
    getSettings,
    getLastActivity,
    getAllActivity,
    getDaemonTerminals,
    isPaneRunning,
    isCodexPane,  // NEW: Check if pane runs Codex CLI
    requestRestart,
    requestUnstick,
    beforeRestart,
    afterRestart,
    resendTask,
    notifyEvent,
  } = options;

  const paneState = new Map();
  const expectedExit = new Map();

  function getConfig() {
    const settings = typeof getSettings === 'function' ? getSettings() : {};
    return {
      ...DEFAULT_CONFIG,
      stuckThresholdMs: settings?.stuckThreshold || DEFAULT_CONFIG.stuckThresholdMs,
      ptyStuckThresholdMs: settings?.ptyStuckThreshold || DEFAULT_CONFIG.ptyStuckThresholdMs,
    };
  }

  function getPaneState(paneId) {
    const id = String(paneId);
    if (!paneState.has(id)) {
      paneState.set(id, {
        paneId: id,
        status: 'healthy',
        stuckCount: 0,
        recoveryStep: 'none',
        restartAttempts: 0,
        lastRestartAt: 0,
        lastActivityAt: 0,
        lastFailureAt: 0,
        lastFailureReason: null,
        lastTask: null,
        lastTaskAt: 0,
        lastTaskMeta: null,
        pendingResend: false,
        taskRetryAttempts: 0,
        taskRetryTimer: null,
        failureTimestamps: [],
        circuitOpenUntil: 0,
        nextRestartAt: 0,
        pendingRestart: false,
        restartTimer: null,
        confirmTimer: null,
        ptyTokenCount: null,
        ptyZeroSince: 0,
        ptyZeroTimerSeconds: null,
        ptyLastTimerSeconds: null,
        ptyLastTimerAt: 0,
        ptyLastEscAt: 0,
        ptyStuckActive: false,
      });
    }
    return paneState.get(id);
  }

  function emitEvent(payload) {
    if (typeof notifyEvent === 'function') {
      notifyEvent(payload);
    }
  }

  function recordTask(paneId, message, meta = {}) {
    const state = getPaneState(paneId);
    const safeMessage = String(message || '').slice(0, MAX_TASK_CHARS);
    state.lastTask = safeMessage;
    state.lastTaskAt = Date.now();
    state.lastTaskMeta = meta;
    state.pendingResend = false;
    state.taskRetryAttempts = 0;
    if (state.taskRetryTimer) {
      clearTimeout(state.taskRetryTimer);
      state.taskRetryTimer = null;
    }
  }

  async function attemptResend(paneId, reason = 'recovery') {
    const state = getPaneState(paneId);
    if (!state.lastTask || typeof resendTask !== 'function') return false;

    let ok = false;
    try {
      ok = await Promise.resolve(resendTask(paneId, state.lastTask, {
        reason,
        meta: state.lastTaskMeta,
      }));
    } catch (err) {
      log.warn('Recovery', `Resend task failed for pane ${paneId}: ${err.message}`);
    }

    if (ok) {
      state.pendingResend = false;
      state.taskRetryAttempts = 0;
      emitEvent({
        type: 'resend',
        paneId: String(paneId),
        status: 'success',
        message: 'Resent last task context',
        timestamp: new Date().toISOString(),
      });
      return true;
    }

    emitEvent({
      type: 'resend',
      paneId: String(paneId),
      status: 'failed',
      message: 'Failed to resend last task context',
      timestamp: new Date().toISOString(),
    });
    return false;
  }

  function scheduleTaskRetry(paneId, reason = 'recovery') {
    const state = getPaneState(paneId);
    const config = getConfig();
    if (!state.lastTask || typeof resendTask !== 'function') return false;

    if (state.taskRetryAttempts >= config.taskRetryMaxAttempts) {
      openCircuit(state, 'task retry limit');
      return false;
    }

    if (state.taskRetryTimer) return true;

    state.taskRetryAttempts += 1;
    const delay = Math.min(
      config.taskRetryBaseMs * Math.pow(2, Math.max(0, state.taskRetryAttempts - 1)),
      config.taskRetryMaxMs
    );

    state.taskRetryTimer = setTimeout(async () => {
      state.taskRetryTimer = null;
      const ok = await attemptResend(paneId, reason);
      if (!ok) {
        scheduleTaskRetry(paneId, reason);
      }
    }, delay);

    emitEvent({
      type: 'resend',
      paneId: String(paneId),
      status: 'scheduled',
      message: `Retrying task resend in ${(delay / 1000).toFixed(1)}s`,
      timestamp: new Date().toISOString(),
    });

    return true;
  }

  function markExpectedExit(paneId, reason = 'manual') {
    const config = getConfig();
    expectedExit.set(String(paneId), {
      reason,
      expiresAt: Date.now() + config.expectedExitTtlMs,
    });
  }

  function consumeExpectedExit(paneId) {
    const entry = expectedExit.get(String(paneId));
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      expectedExit.delete(String(paneId));
      return null;
    }
    expectedExit.delete(String(paneId));
    return entry;
  }

  function recordActivity(paneId, timestamp = Date.now()) {
    const state = getPaneState(paneId);
    state.lastActivityAt = timestamp;

    if (state.status !== 'healthy') {
      state.status = 'healthy';
      state.stuckCount = 0;
      state.recoveryStep = 'none';
      state.pendingRestart = false;
      state.nextRestartAt = 0;
      if (state.confirmTimer) {
        clearTimeout(state.confirmTimer);
        state.confirmTimer = null;
      }
      emitEvent({
        type: 'recovery',
        paneId: String(paneId),
        status: 'healthy',
        message: 'Agent activity restored',
        timestamp: new Date().toISOString(),
      });
    }

    if (state.pendingResend && state.lastTask && typeof resendTask === 'function') {
      const delay = getConfig().resyncDelayMs;
      state.pendingResend = false;
      setTimeout(async () => {
        const ok = await attemptResend(paneId, 'post-restart');
        if (!ok) {
          scheduleTaskRetry(paneId, 'post-restart');
        }
      }, delay);
    }
  }

  function resetPtyZero(state) {
    state.ptyZeroSince = 0;
    state.ptyZeroTimerSeconds = null;
    state.ptyStuckActive = false;
  }

  function recordPtyOutput(paneId, data) {
    if (!data) return;
    const settings = typeof getSettings === 'function' ? getSettings() : {};
    if (settings?.sdkMode) return;
    if (settings?.ptyStuckDetection === false) return;
    if (typeof isCodexPane === 'function' && isCodexPane(paneId)) return;

    const text = stripAnsi(data);
    if (!text) return;

    const state = getPaneState(paneId);
    const tokenCount = parseTokenCount(text);
    const timerSeconds = parseTimerSeconds(text);
    if (tokenCount === null && timerSeconds === null) return;

    const now = Date.now();
    if (tokenCount !== null) {
      state.ptyTokenCount = tokenCount;
    }

    const effectiveTokens = tokenCount !== null ? tokenCount : state.ptyTokenCount;
    if (effectiveTokens === null) return;

    if (effectiveTokens > 0) {
      resetPtyZero(state);
      return;
    }

    if (!state.ptyZeroSince) {
      state.ptyZeroSince = now;
    }

    if (timerSeconds === null) return;

    const prevTimerSeconds = state.ptyLastTimerSeconds;
    const timerAdvanced = prevTimerSeconds === null || timerSeconds > prevTimerSeconds;
    const timerReset = prevTimerSeconds !== null && timerSeconds < prevTimerSeconds;

    state.ptyLastTimerSeconds = timerSeconds;

    if (timerAdvanced || timerReset) {
      state.ptyLastTimerAt = now;
      resetPtyZero(state);
      return;
    }

    if (!state.ptyZeroSince) {
      state.ptyZeroSince = now;
    }

    const config = getConfig();
    const lastTimerAt = state.ptyLastTimerAt || now;
    const elapsedMs = now - lastTimerAt;

    if (elapsedMs < config.ptyStuckThresholdMs) return;

    if (now - state.ptyLastEscAt < config.ptyStuckCooldownMs) return;

    state.ptyLastEscAt = now;
    state.ptyStuckActive = true;

    const stalledSeconds = Math.floor(elapsedMs / 1000);

    log.warn(
      'Recovery',
      `PTY stuck detected for pane ${paneId}: 0 tokens, timer stalled at ${timerSeconds}s for ${stalledSeconds}s`
    );

    emitEvent({
      type: 'pty-stuck',
      paneId: String(paneId),
      status: 'detected',
      message: `PTY stuck detected (0 tokens, timer stalled for ${stalledSeconds}s)`,
      tokens: effectiveTokens,
      timerSeconds,
      timestamp: new Date().toISOString(),
    });

    if (typeof requestUnstick === 'function') {
      requestUnstick(paneId, {
        reason: 'pty-stuck',
        tokens: effectiveTokens,
        timerSeconds,
      });
    }
  }

  function updateFailureWindow(state, timestamp) {
    const config = getConfig();
    state.failureTimestamps = state.failureTimestamps.filter(t => timestamp - t <= config.circuitWindowMs);
    state.failureTimestamps.push(timestamp);
  }

  function openCircuit(state, reason) {
    const config = getConfig();
    state.circuitOpenUntil = Date.now() + config.circuitCooldownMs;
    state.status = 'circuit_open';
    state.recoveryStep = 'none';
    state.pendingRestart = false;
    state.nextRestartAt = 0;
    if (state.restartTimer) {
      clearTimeout(state.restartTimer);
      state.restartTimer = null;
    }
    emitEvent({
      type: 'circuit',
      paneId: state.paneId,
      status: 'open',
      message: `Circuit opened: ${reason}`,
      timestamp: new Date().toISOString(),
    });
  }

  function canRestart(state) {
    if (state.circuitOpenUntil && Date.now() < state.circuitOpenUntil) {
      return false;
    }
    return true;
  }

  function computeBackoff(state) {
    const config = getConfig();
    const attempt = Math.max(0, state.restartAttempts);
    const backoff = Math.min(config.backoffBaseMs * Math.pow(2, attempt), config.backoffMaxMs);
    return backoff;
  }

  async function performRestart(paneId, reason) {
    const state = getPaneState(paneId);
    if (!canRestart(state)) return false;

    state.status = 'restarting';
    state.recoveryStep = 'restart';
    state.restartAttempts += 1;
    state.lastRestartAt = Date.now();
    state.lastFailureReason = reason;
    state.pendingRestart = false;
    state.nextRestartAt = 0;
    if (state.lastTask && typeof resendTask === 'function') {
      state.pendingResend = true;
    }

    markExpectedExit(paneId, 'auto-restart');

    if (typeof beforeRestart === 'function') {
      try {
        await beforeRestart(paneId, reason);
      } catch (err) {
        log.error('Recovery', `beforeRestart failed for pane ${paneId}: ${err.message}`);
      }
    }

    emitEvent({
      type: 'restart',
      paneId: String(paneId),
      status: 'started',
      message: `Auto-restart initiated (${reason})`,
      timestamp: new Date().toISOString(),
      attempt: state.restartAttempts,
    });

    if (typeof requestRestart === 'function') {
      requestRestart(paneId, { reason, attempt: state.restartAttempts });
    }

    if (state.confirmTimer) {
      clearTimeout(state.confirmTimer);
    }

    const config = getConfig();
    state.confirmTimer = setTimeout(() => {
      if (state.status === 'restarting') {
        state.lastFailureAt = Date.now();
        updateFailureWindow(state, state.lastFailureAt);
        emitEvent({
          type: 'restart',
          paneId: String(paneId),
          status: 'timeout',
          message: `Restart confirmation timed out`,
          timestamp: new Date().toISOString(),
        });

        if (state.failureTimestamps.length >= config.circuitMaxFailures) {
          openCircuit(state, 'restart timeout');
        } else {
          scheduleRestart(paneId, 'restart-timeout');
        }
      }
    }, config.restartConfirmMs);

    if (typeof afterRestart === 'function') {
      try {
        await afterRestart(paneId, reason);
      } catch (err) {
        log.error('Recovery', `afterRestart failed for pane ${paneId}: ${err.message}`);
      }
    }

    return true;
  }

  function scheduleRestart(paneId, reason) {
    const state = getPaneState(paneId);
    if (!canRestart(state)) return false;

    const backoff = computeBackoff(state);
    const now = Date.now();
    const delay = Math.max(0, backoff - (now - state.lastRestartAt));

    if (state.pendingRestart && state.restartTimer) {
      return true;
    }

    state.pendingRestart = true;
    state.recoveryStep = 'restart';
    state.nextRestartAt = now + delay;

    state.restartTimer = setTimeout(() => {
      state.restartTimer = null;
      performRestart(paneId, reason);
    }, delay);

    emitEvent({
      type: 'restart',
      paneId: String(paneId),
      status: 'scheduled',
      message: `Restart scheduled in ${(delay / 1000).toFixed(1)}s`,
      timestamp: new Date().toISOString(),
    });

    return true;
  }

  function handleExit(paneId, exitCode) {
    const state = getPaneState(paneId);
    const expected = consumeExpectedExit(paneId);
    const isCodex = typeof isCodexPane === 'function' && isCodexPane(paneId);

    // Expected exit (manual restart, auto-restart confirmation, etc)
    if (expected) {
      state.status = 'recovering';
      emitEvent({
        type: 'exit',
        paneId: String(paneId),
        status: 'expected',
        message: `Expected exit (${expected.reason})`,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Codex graceful completion (exit code 0) - NOT a failure
    // Codex CLI exits normally after completing tasks, needs auto-restart
    if (isCodex && exitCode === 0) {
      log.info('Recovery', `Codex pane ${paneId} completed (exit 0), auto-restarting`);
      emitEvent({
        type: 'exit',
        paneId: String(paneId),
        status: 'codex_completed',
        message: 'Codex task completed, auto-restarting',
        timestamp: new Date().toISOString(),
      });
      // Reset backoff state - graceful completion is not a failure
      state.restartAttempts = 0;
      state.failureTimestamps = [];
      // Immediate restart - no backoff, no failure counting
      // Mark as expected so the restart itself doesn't trigger another handleExit
      markExpectedExit(paneId, 'codex-auto-restart');
      performRestart(paneId, 'codex-completion');
      return;
    }

    // Unexpected exit - treat as failure
    state.lastFailureAt = Date.now();
    state.lastFailureReason = `exit-${exitCode}`;
    updateFailureWindow(state, state.lastFailureAt);

    emitEvent({
      type: 'exit',
      paneId: String(paneId),
      status: 'unexpected',
      message: `Unexpected exit code ${exitCode}`,
      timestamp: new Date().toISOString(),
    });

    const config = getConfig();
    if (state.failureTimestamps.length >= config.circuitMaxFailures) {
      openCircuit(state, 'repeated exits');
      return;
    }

    scheduleRestart(paneId, `exit-${exitCode}`);
  }

  function handleStuck(paneId, idleMs, source = 'idle') {
    const state = getPaneState(paneId);
    const config = getConfig();
    state.stuckCount += 1;
    state.status = 'stuck';
    state.recoveryStep = 'interrupt';

    emitEvent({
      type: 'stuck',
      paneId: String(paneId),
      status: 'detected',
      message: `Stuck detected (${Math.round(idleMs / 1000)}s idle via ${source})`,
      timestamp: new Date().toISOString(),
    });

    if (state.stuckCount >= config.stuckConfirmCount) {
      scheduleRestart(paneId, 'stuck');
    }
  }

  function resetCircuit(paneId) {
    const state = getPaneState(paneId);
    state.circuitOpenUntil = 0;
    state.failureTimestamps = [];
    state.status = 'healthy';
    state.recoveryStep = 'none';
    emitEvent({
      type: 'circuit',
      paneId: String(paneId),
      status: 'reset',
      message: 'Circuit reset',
      timestamp: new Date().toISOString(),
    });
  }

  function stop() {
    for (const state of paneState.values()) {
      if (state.taskRetryTimer) {
        clearTimeout(state.taskRetryTimer);
        state.taskRetryTimer = null;
      }
      if (state.restartTimer) {
        clearTimeout(state.restartTimer);
        state.restartTimer = null;
      }
      if (state.confirmTimer) {
        clearTimeout(state.confirmTimer);
        state.confirmTimer = null;
      }
    }
    log.info('Recovery', 'Manager stopped (timers cleared)');
  }

  function getStatus() {
    const status = {};
    const activity = getAllActivity ? getAllActivity() : {};
    const paneIds = new Set([...Object.keys(activity), ...paneState.keys()]);
    for (const paneId of paneIds) {
      status[paneId] = { ...getPaneState(paneId) };
    }
    return status;
  }

  function getHealthSnapshot() {
    const terminals = typeof getDaemonTerminals === 'function' ? getDaemonTerminals() : [];
    const activity = typeof getAllActivity === 'function' ? getAllActivity() : {};

    const panes = {};
    const paneIds = new Set([...Object.keys(activity), ...paneState.keys()]);
    for (const paneId of paneIds) {
      const state = getPaneState(paneId);
      panes[paneId] = {
        paneId,
        lastActivity: activity[paneId],
        running: typeof isPaneRunning === 'function' ? isPaneRunning(paneId) : null,
        recovery: { ...state },
      };
    }

    return {
      timestamp: new Date().toISOString(),
      terminals,
      panes,
      playbooks: PLAYBOOKS,
    };
  }

  return {
    recordActivity,
    recordPtyOutput,
    recordTask,
    handleExit,
    handleStuck,
    markExpectedExit,
    resetCircuit,
    getStatus,
    getHealthSnapshot,
    getPlaybooks: () => PLAYBOOKS,
    scheduleRestart,
    scheduleTaskRetry,
    stop,
  };
}

module.exports = { createRecoveryManager };
