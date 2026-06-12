/**
 * Terminal recovery helpers (unstick, restart, sweeper)
 * Extracted from terminal.js to isolate recovery logic.
 */

const { invokeBridge } = require('../renderer-bridge');
const log = require('../logger');
const { BYPASS_CLEAR_DELAY_MS } = require('../constants');

function createRecoveryController(options = {}) {
  const {
    PANE_IDS = [],
    terminals,
    lastOutputTime,
    lastTypedTime,
    isCodexPane,
    isGeminiPane,
    updatePaneStatus,
    updateConnectionStatus,
    getInjectionInFlight,
    userIsTyping,
    getInjectionHelpers,
    spawnAgent,
    resetCodexIdentity,
    resetTerminalWriteQueue,
    syncTerminalInputBridge,
    markIgnoreNextExit,
    getPaneRuntimeOverride,
    buildPtyCreateOptionsForRuntimeOverride,
  } = options;

  // Unstick escalation tracking (nudge -> interrupt -> restart)
  const UNSTICK_RESET_MS = 30000;
  const unstickState = new Map();

  // Stuck message sweeper - safety net for failed Enter submissions
  // Tracks panes where Enter send failed or timed out but message may still be stuck
  const potentiallyStuckPanes = new Map(); // paneId -> { timestamp, retryCount }
  const SWEEPER_INTERVAL_MS = 30000;       // Check every 30 seconds
  const SWEEPER_MAX_AGE_MS = 300000;       // Give up after 5 minutes
  const SWEEPER_IDLE_THRESHOLD_MS = 10000; // Pane must be idle for 10 seconds before retry
  let sweeperIntervalId = null;

  const setPaneStatus = (paneId, status) => {
    if (typeof updatePaneStatus === 'function') {
      updatePaneStatus(paneId, status);
    }
  };

  const setConnectionStatus = (status) => {
    if (typeof updateConnectionStatus === 'function') {
      updateConnectionStatus(status);
    }
  };

  /**
   * Mark a pane as potentially stuck (Enter verification failed)
   * Sweeper will periodically retry Enter on these panes
   */
  function markPotentiallyStuck(paneId) {
    const id = String(paneId);
    if (typeof isGeminiPane === 'function' && isGeminiPane(id)) return; // Gemini PTY submit is reliable enough to skip stuck sweeper

    const existing = potentiallyStuckPanes.get(id);
    if (existing) {
      existing.retryCount++;
      log.info(`StuckSweeper ${id}`, `Re-marked as stuck (retry #${existing.retryCount})`);
    } else {
      potentiallyStuckPanes.set(id, { timestamp: Date.now(), retryCount: 0 });
      log.info(`StuckSweeper ${id}`, 'Marked as potentially stuck');
    }
  }

  /**
   * Clear stuck status for a pane (it's working again)
   */
  function clearStuckStatus(paneId) {
    const id = String(paneId);
    if (potentiallyStuckPanes.has(id)) {
      potentiallyStuckPanes.delete(id);
      log.info(`StuckSweeper ${id}`, 'Cleared stuck status (pane active)');
    }
  }

  /**
   * Stuck message sweeper - periodic safety net for non-Gemini panes
   * Checks panes marked as potentially stuck and retries Enter if idle
   */
  async function sweepStuckMessages() {
    if (typeof getInjectionInFlight === 'function' && getInjectionInFlight()) return;
    if (typeof userIsTyping === 'function' && userIsTyping()) return;

    const helpers = typeof getInjectionHelpers === 'function' ? getInjectionHelpers() : null;
    const focusWithRetry = helpers?.focusWithRetry;
    if (typeof focusWithRetry !== 'function') {
      return;
    }

    const now = Date.now();
    const toRemove = [];

    for (const [paneId, info] of potentiallyStuckPanes) {
      const age = now - info.timestamp;

      // Give up after 5 minutes
      if (age > SWEEPER_MAX_AGE_MS) {
        log.warn(`StuckSweeper ${paneId}`, `Giving up after ${Math.round(age / 1000)}s (max age reached)`);
        toRemove.push(paneId);
        continue;
      }

      // Only retry if pane is idle for at least 10 seconds
      const lastOutput = lastOutputTime[paneId] || 0;
      const idleTime = now - lastOutput;
      if (idleTime < SWEEPER_IDLE_THRESHOLD_MS) {
        continue; // Pane is active, wait
      }

      // Pane is idle and marked as stuck - try Enter
      log.info(
        `StuckSweeper ${paneId}`,
        `Attempting recovery Enter (idle ${Math.round(idleTime / 1000)}s, stuck for ${Math.round(age / 1000)}s)`
      );

      const paneEl = document.querySelector(`.pane[data-pane-id="${paneId}"]`);
      const textarea = paneEl ? paneEl.querySelector('.xterm-helper-textarea') : null;

      if (!textarea) {
        log.warn(`StuckSweeper ${paneId}`, 'No textarea available for recovery');
        continue;
      }

      const focusOk = await focusWithRetry(textarea);
      if (focusOk) {
        // Use nudge path (PTY Enter) for all runtimes.
        nudgePane(paneId);
        log.info(`StuckSweeper ${paneId}`, 'Recovery Enter sent via nudgePane');
      } else {
        log.warn(`StuckSweeper ${paneId}`, 'Focus failed for recovery');
      }
    }

    // Clean up expired entries
    for (const paneId of toRemove) {
      potentiallyStuckPanes.delete(paneId);
    }
  }

  /**
   * Start the stuck message sweeper interval
   */
  function startStuckMessageSweeper() {
    if (sweeperIntervalId) return; // Already running
    sweeperIntervalId = setInterval(sweepStuckMessages, SWEEPER_INTERVAL_MS);
    log.info('Terminal', `Stuck message sweeper started (interval: ${SWEEPER_INTERVAL_MS / 1000}s)`);
  }

  /**
   * Stop the stuck message sweeper
   */
  function stopStuckMessageSweeper() {
    if (sweeperIntervalId) {
      clearInterval(sweeperIntervalId);
      sweeperIntervalId = null;
      log.info('Terminal', 'Stuck message sweeper stopped');
    }
  }

  function getUnstickState(paneId) {
    const id = String(paneId);
    const now = Date.now();
    const current = unstickState.get(id) || { step: 0, lastAt: 0 };
    if (now - current.lastAt > UNSTICK_RESET_MS) {
      current.step = 0;
    }
    current.lastAt = now;
    unstickState.set(id, current);
    return current;
  }

  function resetUnstickState(paneId) {
    unstickState.set(String(paneId), { step: 0, lastAt: 0 });
  }

  async function interruptPane(paneId) {
    const id = String(paneId);
    try {
      await invokeBridge('interrupt-pane', id);
      log.info('Terminal', `Interrupt sent to pane ${id}`);
      return true;
    } catch (err) {
      try {
        if (window?.squidrun?.pty?.write) {
          await window.squidrun.pty.write(id, '\x03');
          log.info('Terminal', `Interrupt fallback (PTY write) sent to pane ${id}`);
          return true;
        }
      } catch (_) {}
      log.error('Terminal', `Interrupt failed for pane ${id}:`, err);
      return false;
    }
  }

  async function acquireRestartClaim(paneId, options = {}) {
    const id = String(paneId);
    const providedClaim = options?.restartClaim && typeof options.restartClaim === 'object'
      ? options.restartClaim
      : null;
    const providedClaimId = providedClaim?.claimId || options?.restartClaimId || null;
    if (providedClaimId) {
      return {
        ok: true,
        granted: true,
        claim: {
          ...(providedClaim || {}),
          claimId: String(providedClaimId),
          paneId: id,
        },
        source: options.source || 'pregranted',
      };
    }
    const begin = window?.squidrun?.pty?.beginPaneRestart;
    if (typeof begin !== 'function') {
      return { ok: false, granted: false, reason: 'pane_restart_begin_unavailable' };
    }
    return begin({
      paneId: id,
      source: options.source || 'renderer-restart',
      requestId: options.requestId || null,
    });
  }

  function buildRestartLifecycleOptions(restartLease, extra = {}) {
    const claimId = restartLease?.claim?.claimId || null;
    return {
      ...extra,
      requireRestartClaim: true,
      restartClaimId: claimId,
      restartClaim: restartLease?.claim || null,
      expectedExitReason: 'restart',
    };
  }

  function buildFreshSessionOptions(options = {}) {
    return options?.freshSession === true
      ? { remintClaudeSessionId: true }
      : {};
  }

  function buildRestartPtyCreateArgs(paneId, restartLease) {
    const id = String(paneId);
    const runtimeOverride = typeof getPaneRuntimeOverride === 'function'
      ? (getPaneRuntimeOverride(id) || {})
      : {};
    const workingDir = String(runtimeOverride.workingDir || runtimeOverride.cwd || '').trim();
    const runtimeCreateOptions = typeof buildPtyCreateOptionsForRuntimeOverride === 'function'
      ? (buildPtyCreateOptionsForRuntimeOverride(id, runtimeOverride, workingDir) || {})
      : {};
    return {
      workingDir: workingDir || undefined,
      options: {
        ...runtimeCreateOptions,
        ...buildRestartLifecycleOptions(restartLease),
        ...buildFreshSessionOptions(restartLease?.options || {}),
      },
    };
  }

  async function completeRestartClaim(paneId, restartLease, payload = {}) {
    const complete = window?.squidrun?.pty?.completePaneRestart;
    const claimId = restartLease?.claim?.claimId || null;
    if (typeof complete !== 'function' || !claimId) return;
    try {
      await complete({
        paneId: String(paneId),
        claimId,
        status: payload.status || 'completed',
        reason: payload.reason || null,
        error: payload.error || null,
      });
    } catch (err) {
      log.warn('Terminal', `Failed to complete restart claim for pane ${paneId}: ${err?.message || err}`);
    }
  }

  function isLifecycleFailureResult(result) {
    if (!result || typeof result !== 'object') return false;
    if (result.success === false || result.ok === false) return true;
    if (Object.prototype.hasOwnProperty.call(result, 'error') && result.error) return true;
    return false;
  }

  function assertLifecycleResult(stage, result) {
    if (!isLifecycleFailureResult(result)) return result;
    const reason = result.reason || result.error || 'unknown';
    const err = new Error(`${stage} failed: ${reason}`);
    err.result = result;
    throw err;
  }

  function isRestartClaimDenialError(err) {
    const result = err?.result;
    if (!result || typeof result !== 'object') return false;
    const error = String(result.error || '').trim();
    const reason = String(result.reason || '').trim();
    return error === 'restart_claim_denied'
      || reason === 'missing_restart_claim'
      || reason === 'pane_restart_arbiter_unavailable'
      || reason.startsWith('restart_claim_')
      || reason.startsWith('restart_operation_');
  }

  async function restartPane(paneId, model = null, options = {}) {
    const id = String(paneId);
    const restartLease = await acquireRestartClaim(id, options);
    if (!restartLease?.granted) {
      const reason = restartLease?.reason || 'restart_claim_not_granted';
      log.info('Terminal', `Restart for pane ${id} coalesced/denied: ${reason}`);
      setPaneStatus(id, reason === 'restart_in_progress' || reason === 'restart_cooldown_active'
        ? 'Restart queued'
        : 'Restart blocked');
      return restartLease?.ok !== false;
    }
    restartLease.options = options && typeof options === 'object' ? { ...options } : {};

    let completion = { status: 'failed', reason: 'unknown' };
    let shouldCompleteRestartClaim = true;
    setPaneStatus(id, 'Restarting...');
    if (typeof markIgnoreNextExit === 'function') {
      markIgnoreNextExit(id);
    }
    try {
      try {
        const killResult = await window.squidrun.pty.kill(id, buildRestartLifecycleOptions(restartLease));
        assertLifecycleResult('pty-kill', killResult);
      } catch (err) {
        log.error('Terminal', `Failed to kill pane ${id} for restart:`, err);
        setPaneStatus(id, 'Restart failed');
        completion = { status: 'failed', reason: 'pty_kill_failed', error: err?.message || String(err) };
        if (isRestartClaimDenialError(err)) {
          shouldCompleteRestartClaim = false;
        }
        return false;
      }

      await new Promise(resolve => setTimeout(resolve, 250));

      // Reset identity tracking so new session gets fresh identity header
      if (typeof resetCodexIdentity === 'function') {
        resetCodexIdentity(id);
      }
      // Reset write queue state to prevent frozen pane
      if (typeof resetTerminalWriteQueue === 'function') {
        resetTerminalWriteQueue(id);
      }

      // Clear terminal display so we don't detect stale prompts from the previous session
      const terminal = terminals.get(id);
      if (terminal) {
        terminal.clear();
        log.info('Terminal', `Cleared xterm for pane ${id} during restart`);
      }

      // All panes need PTY recreated after kill - the kill destroys the PTY entirely
      // This applies to Claude, Codex, AND Gemini panes
      try {
        const ptyCreateArgs = buildRestartPtyCreateArgs(id, restartLease);
        const createResult = await window.squidrun.pty.create(id, ptyCreateArgs.workingDir, ptyCreateArgs.options);
        assertLifecycleResult('pty-create', createResult);
        log.info('Terminal', `Recreated PTY for pane ${id}`);
      } catch (err) {
        log.error('Terminal', `Failed to recreate PTY for pane ${id}:`, err);
        setPaneStatus(id, 'Restart failed');
        completion = { status: 'failed', reason: 'pty_create_failed', error: err?.message || String(err) };
        if (isRestartClaimDenialError(err)) {
          shouldCompleteRestartClaim = false;
        }
        return false;
      }

      if (typeof spawnAgent === 'function') {
        try {
          const spawnResult = await spawnAgent(id, model, {
            ...buildRestartLifecycleOptions(restartLease),
            ...buildFreshSessionOptions(options),
          });
          assertLifecycleResult('spawn-claude', spawnResult);
          if (typeof syncTerminalInputBridge === 'function') {
            syncTerminalInputBridge(id, { modelHint: model });
          }
        } catch (err) {
          log.error('Terminal', `Failed to spawn Claude for pane ${id}:`, err);
          setPaneStatus(id, 'Spawn failed');
          completion = { status: 'failed', reason: 'spawn_failed', error: err?.message || String(err) };
          if (isRestartClaimDenialError(err)) {
            shouldCompleteRestartClaim = false;
          }
          return false;
        }
      }
      completion = { status: 'completed', reason: 'restart_completed' };
      return true;
    } finally {
      if (shouldCompleteRestartClaim) {
        await completeRestartClaim(id, restartLease, completion);
      }
    }
  }

  async function unstickEscalation(paneId) {
    const id = String(paneId);
    const state = getUnstickState(id);

    if (state.step === 0) {
      log.info('Unstick', `Pane ${id}: nudge`);
      aggressiveNudge(id);
      setPaneStatus(id, 'Nudged');
      setTimeout(() => setPaneStatus(id, 'Running'), 1500);
      state.step = 1;
      return;
    }

    if (state.step === 1) {
      log.info('Unstick', `Pane ${id}: interrupt`);
      const ok = await interruptPane(id);
      setPaneStatus(id, ok ? 'Interrupted' : 'Interrupt failed');
      setTimeout(() => setPaneStatus(id, 'Running'), 1500);
      state.step = 2;
      return;
    }

    log.info('Unstick', `Pane ${id}: restart`);
    await restartPane(id);
    resetUnstickState(id);
  }

  // Nudge a stuck pane - sends PTY Enter to unstick all runtimes.
  // Uses Enter only (ESC sequences were interrupting active agents)
  function nudgePane(paneId) {
    // Mark as typed so our own Enter isn't blocked
    lastTypedTime[paneId] = Date.now();
    // Send Enter to prompt for new input
    window.squidrun.pty.write(String(paneId), '\r').catch(err => {
      log.error(`nudgePane ${paneId}`, 'PTY write failed:', err);
    });
    setPaneStatus(paneId, 'Nudged');
    setTimeout(() => setPaneStatus(paneId, 'Running'), 1000);
  }

  // Send ESC keyboard event to unstick a stuck agent
  // Triggered by writing "(UNSTICK)" to an agent's trigger file
  // Keyboard ESC safely interrupts thinking animation (unlike PTY ESC)
  function sendUnstick(paneId) {
    const id = String(paneId);
    const paneEl = document.querySelector(`.pane[data-pane-id="${id}"]`);
    const textarea = paneEl?.querySelector('.xterm-helper-textarea');

    if (textarea) {
      textarea.focus();

      // Dispatch ESC keydown event with bypass marker
      const escEvent = new KeyboardEvent('keydown', {
        key: 'Escape',
        code: 'Escape',
        keyCode: 27,
        which: 27,
        bubbles: true,
        cancelable: true,
      });
      escEvent._squidrunBypass = true;
      textarea.dispatchEvent(escEvent);

      // Also keyup for completeness
      const escUpEvent = new KeyboardEvent('keyup', {
        key: 'Escape',
        code: 'Escape',
        keyCode: 27,
        which: 27,
        bubbles: true,
      });
      escUpEvent._squidrunBypass = true;
      textarea.dispatchEvent(escUpEvent);

      log.info(`Terminal ${id}`, 'Sent ESC keyboard event to unstick agent');
      setPaneStatus(id, 'Unstick sent');
      setTimeout(() => setPaneStatus(id, 'Running'), 1000);
    } else {
      log.warn(`Terminal ${id}`, 'Could not find xterm textarea for unstick');
    }
  }

  // Aggressive nudge - ESC followed by Enter
  // More forceful than simple Enter nudge, interrupts thinking then prompts input
  function aggressiveNudge(paneId) {
    const id = String(paneId);
    log.info(`Terminal ${id}`, 'Aggressive nudge: ESC + Enter');

    // First send ESC to interrupt any stuck state
    sendUnstick(id);

    // Use keyboard Enter dispatch (PTY carriage return unreliable in Codex CLI)
    setTimeout(() => {
      lastTypedTime[id] = Date.now();

      const paneEl = document.querySelector(`.pane[data-pane-id="${id}"]`);
      const textarea = paneEl?.querySelector('.xterm-helper-textarea');

      if (textarea) {
        if ((typeof isCodexPane === 'function' && isCodexPane(id)) || (typeof isGeminiPane === 'function' && isGeminiPane(id))) {
          // Codex/Gemini: PTY newline to submit (reads stdin directly)
          window.squidrun.pty.write(id, '\r').catch(err => {
            log.error(`aggressiveNudge ${id}`, 'PTY write failed:', err);
          });
          log.info(`Terminal ${id}`, 'Aggressive nudge: PTY carriage return');
        } else {
          // Claude: direct Enter keyboard dispatch with bypass flag
          const terminal = terminals.get(id);
          if (terminal) {
            terminal._squidrunBypass = true;
          }
          try {
            const makeEvent = (type) => {
              const evt = new KeyboardEvent(type, {
                key: 'Enter',
                code: 'Enter',
                keyCode: 13,
                which: 13,
                bubbles: true,
                cancelable: true,
              });
              evt._squidrunBypass = true;
              return evt;
            };

            textarea.dispatchEvent(makeEvent('keydown'));
            textarea.dispatchEvent(makeEvent('keypress'));
            textarea.dispatchEvent(makeEvent('keyup'));
            log.info(`Terminal ${id}`, 'Aggressive nudge: DOM Enter dispatched');
          } catch (err) {
            log.error(`aggressiveNudge ${id}`, 'DOM Enter dispatch failed:', err);
          } finally {
            if (terminal) {
              setTimeout(() => { terminal._squidrunBypass = false; }, BYPASS_CLEAR_DELAY_MS);
            }
          }
        }
      } else {
        // Fallback if textarea truly missing
        log.warn(`Terminal ${id}`, 'Aggressive nudge: no textarea, PTY fallback');
        window.squidrun.pty.write(id, '\r').catch(err => {
          log.error(`aggressiveNudge ${id}`, 'PTY fallback write failed:', err);
        });
      }

      setPaneStatus(id, 'Nudged (aggressive)');
      setTimeout(() => setPaneStatus(id, 'Running'), 1000);
    }, 150); // 150ms delay between ESC and Enter
  }

  // Aggressive nudge all panes (staggered to avoid thundering herd)
  function aggressiveNudgeAll() {
    log.info('Terminal', 'Aggressive nudge all panes');
    for (const paneId of PANE_IDS) {
      // Stagger to avoid thundering herd
      setTimeout(() => {
        aggressiveNudge(paneId);
      }, paneId * 200);
    }
  }

  // Nudge all panes to unstick any churning agents
  function nudgeAllPanes() {
    setConnectionStatus('Nudging all agents...');
    for (const paneId of PANE_IDS) {
      nudgePane(paneId);
    }
    setTimeout(() => {
      setConnectionStatus('All agents nudged');
    }, 200);
  }

  return {
    potentiallyStuckPanes,
    markPotentiallyStuck,
    clearStuckStatus,
    sweepStuckMessages,
    startStuckMessageSweeper,
    stopStuckMessageSweeper,
    interruptPane,
    restartPane,
    unstickEscalation,
    nudgePane,
    nudgeAllPanes,
    sendUnstick,
    aggressiveNudge,
    aggressiveNudgeAll,
  };
}

module.exports = { createRecoveryController };
