/**
 * Terminal recovery helpers (unstick, restart, sweeper)
 * Extracted from terminal.js to isolate recovery logic.
 */

const { ipcRenderer } = require('electron');
const log = require('../logger');

function createRecoveryController(options = {}) {
  const {
    PANE_IDS = [],
    terminals,
    lastOutputTime,
    lastTypedTime,
    isCodexPane,
    updatePaneStatus,
    updateConnectionStatus,
    getSdkModeActive,
    getInjectionInFlight,
    userIsTyping,
    getInjectionHelpers,
    spawnClaude,
    resetCodexIdentity,
  } = options;

  // Unstick escalation tracking (nudge -> interrupt -> restart)
  const UNSTICK_RESET_MS = 30000;
  const unstickState = new Map();

  // Stuck message sweeper - safety net for failed Enter submissions
  // Tracks panes where verifyAndRetryEnter exhausted retries but message may still be stuck
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
    if (typeof isCodexPane === 'function' && isCodexPane(paneId)) return; // Only Claude panes can get stuck this way

    const existing = potentiallyStuckPanes.get(paneId);
    if (existing) {
      existing.retryCount++;
      log.info(`StuckSweeper ${paneId}`, `Re-marked as stuck (retry #${existing.retryCount})`);
    } else {
      potentiallyStuckPanes.set(paneId, { timestamp: Date.now(), retryCount: 0 });
      log.info(`StuckSweeper ${paneId}`, 'Marked as potentially stuck');
    }
  }

  /**
   * Clear stuck status for a pane (it's working again)
   */
  function clearStuckStatus(paneId) {
    if (potentiallyStuckPanes.has(paneId)) {
      potentiallyStuckPanes.delete(paneId);
      log.info(`StuckSweeper ${paneId}`, 'Cleared stuck status (pane active)');
    }
  }

  /**
   * Stuck message sweeper - periodic safety net for Claude panes
   * Checks panes marked as potentially stuck and retries Enter if idle
   */
  async function sweepStuckMessages() {
    if (typeof getInjectionInFlight === 'function' && getInjectionInFlight()) return;
    if (typeof userIsTyping === 'function' && userIsTyping()) return;

    const helpers = typeof getInjectionHelpers === 'function' ? getInjectionHelpers() : null;
    const focusWithRetry = helpers?.focusWithRetry;
    const sendEnterToPane = helpers?.sendEnterToPane;
    if (typeof focusWithRetry !== 'function' || typeof sendEnterToPane !== 'function') {
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

      if (textarea) {
        const focusOk = await focusWithRetry(textarea);
        if (focusOk) {
          // Use sendEnterToPane helper (handles bypass flag + Terminal.input fallback)
          const enterResult = await sendEnterToPane(paneId);
          if (enterResult.success) {
            log.info(`StuckSweeper ${paneId}`, `Recovery Enter sent via ${enterResult.method}`);
            // Don't remove from stuck list yet - wait for output to confirm success
          } else {
            log.error(`StuckSweeper ${paneId}`, 'Recovery Enter failed');
          }
        } else {
          log.warn(`StuckSweeper ${paneId}`, 'Focus failed for recovery');
        }
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
    if (typeof getSdkModeActive === 'function' && getSdkModeActive()) {
      try {
        await ipcRenderer.invoke('sdk-interrupt', id);
        log.info('Terminal', `SDK interrupt sent to pane ${id}`);
        return true;
      } catch (err) {
        log.error('Terminal', `SDK interrupt failed for pane ${id}:`, err);
        return false;
      }
    }

    try {
      if (ipcRenderer?.invoke) {
        await ipcRenderer.invoke('interrupt-pane', id);
      } else {
        await window.hivemind.pty.write(id, '\x03');
      }
      log.info('Terminal', `Interrupt sent to pane ${id}`);
      return true;
    } catch (err) {
      log.error('Terminal', `Interrupt failed for pane ${id}:`, err);
      return false;
    }
  }

  async function restartPane(paneId) {
    const id = String(paneId);
    if (typeof getSdkModeActive === 'function' && getSdkModeActive()) {
      log.info('Terminal', `Restart blocked for pane ${id} (SDK mode)`);
      setPaneStatus(id, 'Restart blocked (SDK)');
      setTimeout(() => setPaneStatus(id, 'Running'), 1500);
      return false;
    }

    setPaneStatus(id, 'Restarting...');
    try {
      await window.hivemind.pty.kill(id);
    } catch (err) {
      log.error('Terminal', `Failed to kill pane ${id} for restart:`, err);
    }

    await new Promise(resolve => setTimeout(resolve, 250));

    // Reset identity tracking so new session gets fresh identity header
    if (typeof resetCodexIdentity === 'function') {
      resetCodexIdentity(id);
    }

    // Codex exec panes need PTY recreated before spawnClaude
    // spawnClaude() for Codex panes only sends identity message - doesn't create PTY
    if (typeof isCodexPane === 'function' && isCodexPane(id)) {
      try {
        await window.hivemind.pty.create(id);
        log.info('Terminal', `Recreated PTY for Codex pane ${id}`);
      } catch (err) {
        log.error('Terminal', `Failed to recreate PTY for Codex pane ${id}:`, err);
        setPaneStatus(id, 'Restart failed');
        return false;
      }
    }

    if (typeof spawnClaude === 'function') {
      await spawnClaude(id);
    }
    return true;
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

  // Nudge a stuck pane - sends Enter to unstick Claude Code
  // Uses Enter only (ESC sequences were interrupting active agents)
  function nudgePane(paneId) {
    // Mark as typed so our own Enter isn't blocked
    lastTypedTime[paneId] = Date.now();
    // Send Enter to prompt for new input
    window.hivemind.pty.write(String(paneId), '\r').catch(err => {
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
      escEvent._hivemindBypass = true;
      textarea.dispatchEvent(escEvent);

      // Also keyup for completeness
      const escUpEvent = new KeyboardEvent('keyup', {
        key: 'Escape',
        code: 'Escape',
        keyCode: 27,
        which: 27,
        bubbles: true,
      });
      escUpEvent._hivemindBypass = true;
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
        textarea.focus();
        window.hivemind.pty.write(id, '\r').catch(err => {
          log.error(`aggressiveNudge ${id}`, 'PTY write failed:', err);
        });

        if (typeof isCodexPane === 'function' && isCodexPane(id)) {
          // Codex: PTY newline to submit (clipboard paste broken - Codex treats as image paste)
          window.hivemind.pty.write(id, '\r').catch(err => {
            log.error(`aggressiveNudge ${id}`, 'Codex PTY write failed:', err);
          });
          log.info(`Terminal ${id}`, 'Aggressive nudge: PTY carriage return (Codex)');
        } else {
          // Claude: use sendTrustedEnter with bypass flag
          const terminal = terminals.get(id);
          if (terminal) {
            terminal._hivemindBypass = true;
          }
          window.hivemind.pty.sendTrustedEnter().then(() => {
            log.info(`Terminal ${id}`, 'Aggressive nudge: trusted Enter dispatched (Claude)');
          }).catch(err => {
            log.error(`aggressiveNudge ${id}`, 'sendTrustedEnter failed:', err);
          }).finally(() => {
            if (terminal) {
              setTimeout(() => { terminal._hivemindBypass = false; }, 0);
            }
          });
        }
      } else {
        // Fallback if textarea truly missing
        log.warn(`Terminal ${id}`, 'Aggressive nudge: no textarea, PTY fallback');
        window.hivemind.pty.write(id, '\r').catch(err => {
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
