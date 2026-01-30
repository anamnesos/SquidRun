/**
 * Terminal management module
 * Handles xterm instances, PTY connections, and terminal operations
 */

const { ipcRenderer } = require('electron');
const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const { WebLinksAddon } = require('@xterm/addon-web-links');
const log = require('./logger');

// Pane configuration
const PANE_IDS = ['1', '2', '3', '4', '5', '6'];

// CLI identity tracking (dynamic)
// Updated by renderer's pane-cli-identity handler (calls register/unregister)
const paneCliIdentity = new Map();

// ID-1: Pane roles for identity injection (makes /resume sessions identifiable)
const PANE_ROLES = {
  '1': 'Architect',
  '2': 'Orchestrator',
  '3': 'Implementer A',
  '4': 'Implementer B',
  '5': 'Investigator',
  '6': 'Reviewer',
};

// Track if we reconnected to existing terminals
let reconnectedToExisting = false;

// SDK Mode flag - when true, PTY spawn operations are blocked
let sdkModeActive = false;

// Terminal instances
const terminals = new Map();
const fitAddons = new Map();
let focusedPane = '1';

// Cross-pane Enter debounce tracking
// Prevents ghost text submission when Enter hits multiple panes within 100ms
const lastEnterTime = {};

// Track actual user typing per pane
// Only allow Enter if user typed something in last 2 seconds
const lastTypedTime = {};

// Idle detection to prevent stuck animation
// Track last output time per pane - updated on every pty.onData
const lastOutputTime = {};

// Unstick escalation tracking (nudge -> interrupt -> restart)
const UNSTICK_RESET_MS = 30000;
const unstickState = new Map();

// Codex exec mode: track identity injection per pane
const codexIdentityInjected = new Set();

// Stuck message sweeper - safety net for failed Enter submissions
// Tracks panes where verifyAndRetryEnter exhausted retries but message may still be stuck
const potentiallyStuckPanes = new Map(); // paneId -> { timestamp, retryCount }
const SWEEPER_INTERVAL_MS = 30000;       // Check every 30 seconds
const SWEEPER_MAX_AGE_MS = 300000;       // Give up after 5 minutes
const SWEEPER_IDLE_THRESHOLD_MS = 10000; // Pane must be idle for 10 seconds before retry
let sweeperIntervalId = null;

// Per-pane input lock - panes locked by default (view-only), toggle to unlock for direct typing
// Prevents accidental typing in agent panes while allowing programmatic sends (sendToPane/triggers)
const inputLocked = {};
PANE_IDS.forEach(id => { inputLocked[id] = true; }); // Default: all panes locked

// Message queue for when pane is busy
// Format: { paneId: [{ message, timestamp }, ...] }
const messageQueue = {};
// Prevent overlapping PTY injections across panes (global focus/Enter mutex)
let injectionInFlight = false;

// Global UI focus tracker - survives staggered multi-pane sends.
// Updated by focusin listener on UI inputs; doSendToPane restores to this.
let lastUserUIFocus = null;

// Track when user last typed in a UI input (not xterm).
// doSendToPane defers injection while user is actively typing.
let lastUserUIKeypressTime = 0;
const TYPING_GUARD_MS = 300; // Defer injection if user typed within this window

// Idle detection constants
// 2000ms threshold - Claude may need more time after output stops
const IDLE_THRESHOLD_MS = 2000;  // No output for 2s = idle
const MAX_QUEUE_TIME_MS = 10000; // Consider force inject after 10 seconds
const FORCE_INJECT_IDLE_MS = 500; // For force-inject, require 500ms of silence (not full 2s)
const EXTREME_WAIT_MS = 30000;   // Log warning if message queued this long
const ABSOLUTE_MAX_WAIT_MS = 60000; // Emergency fallback: force inject after 60s regardless
const QUEUE_RETRY_MS = 200;      // Check queue every 200ms
const BROADCAST_STAGGER_MS = 100; // Delay between panes in broadcast
const INJECTION_LOCK_TIMEOUT_MS = 1000; // Safety release if callbacks missed

// Adaptive Enter delay constants (reduce Enter-before-text race)
const ENTER_DELAY_IDLE_MS = 50;       // Pane idle (no output > 500ms): fast Enter
const ENTER_DELAY_ACTIVE_MS = 150;    // Pane active (output in last 500ms): medium delay
const ENTER_DELAY_BUSY_MS = 300;      // Pane busy (output in last 100ms): longer delay
const PANE_ACTIVE_THRESHOLD_MS = 500; // Recent output threshold for "active"
const PANE_BUSY_THRESHOLD_MS = 100;   // Very recent output threshold for "busy"
const FOCUS_RETRY_DELAY_MS = 20;      // Delay between focus retry attempts
const MAX_FOCUS_RETRIES = 3;          // Max focus retry attempts before giving up
const ENTER_VERIFY_DELAY_MS = 200;    // Delay before checking if Enter succeeded (increased to reduce double-submit risk)
const MAX_ENTER_RETRIES = 5;          // Max Enter retry attempts if text remains
const ENTER_RETRY_INTERVAL_MS = 200;  // Interval between checking if pane is idle for retry
const PROMPT_READY_TIMEOUT_MS = 3000; // Max time to wait for prompt-ready detection

// Terminal theme configuration
const TERMINAL_THEME = {
  background: '#1a1a2e',
  foreground: '#eee',
  cursor: '#e94560',
  cursorAccent: '#1a1a2e',
  selection: 'rgba(233, 69, 96, 0.3)',
  black: '#1a1a2e',
  red: '#e94560',
  green: '#4ecca3',
  yellow: '#ffc857',
  blue: '#0f3460',
  magenta: '#9b59b6',
  cyan: '#00d9ff',
  white: '#eee',
};

// Terminal options
const TERMINAL_OPTIONS = {
  theme: TERMINAL_THEME,
  fontFamily: "'Consolas', 'Monaco', 'Courier New', monospace",
  fontSize: 13,
  cursorBlink: true,
  cursorStyle: 'block',
  scrollback: 5000,
  rightClickSelectsWord: true,
  allowProposedApi: true,
};

// Track when user focuses any UI input (not xterm textareas).
// Call once from renderer.js after DOMContentLoaded.
function initUIFocusTracker() {
  document.addEventListener('focusin', (e) => {
    const el = e.target;
    const tag = el?.tagName?.toUpperCase();
    const isUI = (tag === 'INPUT' || tag === 'TEXTAREA') &&
      !el.classList.contains('xterm-helper-textarea');
    if (isUI) {
      lastUserUIFocus = el;
    }
  });

  // Track user keystrokes in UI inputs for typing guard
  document.addEventListener('keydown', (e) => {
    const el = e.target;
    const tag = el?.tagName?.toUpperCase();
    const isUI = (tag === 'INPUT' || tag === 'TEXTAREA') &&
      !el.classList.contains('xterm-helper-textarea');
    if (isUI) {
      lastUserUIKeypressTime = Date.now();
    }
  });
}

// Returns true if user is actively typing in a UI input
function userIsTyping() {
  if (!lastUserUIFocus) return false;
  const el = document.activeElement;
  const tag = el?.tagName?.toUpperCase();
  const isUI = (tag === 'INPUT' || tag === 'TEXTAREA') &&
    !el.classList.contains('xterm-helper-textarea');
  if (!isUI) return false;
  return (Date.now() - lastUserUIKeypressTime) < TYPING_GUARD_MS;
}

// Status update callbacks
let onStatusUpdate = null;
let onConnectionStatusUpdate = null;

function setStatusCallbacks(statusCb, connectionCb) {
  onStatusUpdate = statusCb;
  onConnectionStatusUpdate = connectionCb;
}

function updatePaneStatus(paneId, status) {
  if (onStatusUpdate) {
    onStatusUpdate(paneId, status);
  }
}

function updateConnectionStatus(status) {
  if (onConnectionStatusUpdate) {
    onConnectionStatusUpdate(status);
  }
}

function normalizeCliKey(identity) {
  if (!identity) return '';
  const parts = [];
  if (identity.provider) parts.push(String(identity.provider));
  if (identity.label) parts.push(String(identity.label));
  return parts.join(' ').toLowerCase();
}

function registerPaneCliIdentity(paneId, identity) {
  if (!paneId) return;
  const id = String(paneId);
  const key = normalizeCliKey(identity);
  paneCliIdentity.set(id, {
    provider: identity?.provider,
    label: identity?.label,
    version: identity?.version,
    key,
  });
}

function isCodexFromSettings(paneId) {
  try {
    const settings = window?.hivemind?.settings?.get?.();
    const paneCommands = settings?.paneCommands || {};
    const cmd = paneCommands[String(paneId)] || '';
    return typeof cmd === 'string' && cmd.toLowerCase().includes('codex');
  } catch {
    return false;
  }
}

function isCodexPane(paneId) {
  const entry = paneCliIdentity.get(String(paneId));
  if (entry?.key) {
    return entry.key.includes('codex');
  }
  return isCodexFromSettings(paneId);
}

// Renderer calls these based on pane-cli-identity IPC
function registerCodexPane(paneId) {
  registerPaneCliIdentity(paneId, { provider: 'codex', label: 'Codex' });
}

function unregisterCodexPane(paneId) {
  registerPaneCliIdentity(paneId, { provider: 'unknown', label: 'Unknown' });
}

function buildCodexExecPrompt(paneId, text) {
  const safeText = typeof text === 'string' ? text : '';
  if (codexIdentityInjected.has(paneId)) {
    return safeText;
  }

  const role = PANE_ROLES[paneId] || `Pane ${paneId}`;
  const timestamp = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const identity = `# HIVEMIND SESSION: ${role} - Started ${timestamp}\n`;
  codexIdentityInjected.add(paneId);
  return identity + safeText;
}

// Check if a pane is idle (no output for IDLE_THRESHOLD_MS)
function isIdle(paneId) {
  const lastOutput = lastOutputTime[paneId] || 0;
  return (Date.now() - lastOutput) >= IDLE_THRESHOLD_MS;
}

// Shorter idle check for force-inject scenario
// Requires 500ms of silence - long enough for Enter to not be ignored,
// but shorter than full 2s idle so messages don't queue forever
function isIdleForForceInject(paneId) {
  const lastOutput = lastOutputTime[paneId] || 0;
  return (Date.now() - lastOutput) >= FORCE_INJECT_IDLE_MS;
}

/**
 * Check if a pane's input is locked (view-only mode)
 * Locked panes block keyboard input but allow programmatic sends
 */
function isInputLocked(paneId) {
  return inputLocked[paneId] === true;
}

/**
 * Toggle input lock state for a pane
 * Returns the new lock state (true = locked, false = unlocked)
 */
function toggleInputLock(paneId) {
  inputLocked[paneId] = !inputLocked[paneId];
  const lockIcon = document.getElementById(`lock-icon-${paneId}`);
  if (lockIcon) {
    lockIcon.textContent = inputLocked[paneId] ? '🔒' : '🔓';
    lockIcon.title = inputLocked[paneId] ? 'Input locked (click to unlock)' : 'Input unlocked (click to lock)';
    lockIcon.classList.toggle('unlocked', !inputLocked[paneId]);
  }
  log.info(`Terminal ${paneId}`, `Input ${inputLocked[paneId] ? 'locked' : 'unlocked'}`);
  return inputLocked[paneId];
}

/**
 * Set input lock state for a pane (without toggle)
 */
function setInputLocked(paneId, locked) {
  inputLocked[paneId] = locked;
  const lockIcon = document.getElementById(`lock-icon-${paneId}`);
  if (lockIcon) {
    lockIcon.textContent = locked ? '🔒' : '🔓';
    lockIcon.title = locked ? 'Input locked (click to unlock)' : 'Input unlocked (click to lock)';
    lockIcon.classList.toggle('unlocked', !locked);
  }
  log.info(`Terminal ${paneId}`, `Input ${locked ? 'locked' : 'unlocked'}`);
}

/**
 * Mark a pane as potentially stuck (Enter verification failed)
 * Sweeper will periodically retry Enter on these panes
 */
function markPotentiallyStuck(paneId) {
  if (isCodexPane(paneId)) return; // Only Claude panes can get stuck this way

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
  if (injectionInFlight) return; // Don't interfere with active injection
  if (userIsTyping()) return; // Don't interfere with user

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
    log.info(`StuckSweeper ${paneId}`, `Attempting recovery Enter (idle ${Math.round(idleTime / 1000)}s, stuck for ${Math.round(age / 1000)}s)`);

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

/**
 * Calculate adaptive Enter delay based on pane activity level
 * Under load, the terminal needs more time for text to appear before Enter
 * @param {string} paneId - The pane ID
 * @returns {number} - Delay in milliseconds before sending Enter
 */
function getAdaptiveEnterDelay(paneId) {
  const lastOutput = lastOutputTime[paneId] || 0;
  const timeSinceOutput = Date.now() - lastOutput;

  if (timeSinceOutput < PANE_BUSY_THRESHOLD_MS) {
    // Very recent output (< 100ms) - pane is busy, use longer delay
    return ENTER_DELAY_BUSY_MS;
  } else if (timeSinceOutput < PANE_ACTIVE_THRESHOLD_MS) {
    // Recent output (< 500ms) - pane is active, use medium delay
    return ENTER_DELAY_ACTIVE_MS;
  } else {
    // No recent output - pane is idle, fast Enter is safe
    return ENTER_DELAY_IDLE_MS;
  }
}

/**
 * Attempt to focus textarea with retries
 * Returns true if focus succeeded, false if failed after retries
 * @param {HTMLElement} textarea - The textarea element to focus
 * @param {number} retries - Number of retry attempts remaining
 * @returns {Promise<boolean>} - Whether focus succeeded
 */
async function focusWithRetry(textarea, retries = MAX_FOCUS_RETRIES) {
  if (!textarea) return false;

  textarea.focus();

  // Check if focus succeeded
  if (document.activeElement === textarea) {
    return true;
  }

  // Retry if attempts remaining
  if (retries > 0) {
    await new Promise(resolve => setTimeout(resolve, FOCUS_RETRY_DELAY_MS));
    return focusWithRetry(textarea, retries - 1);
  }

  return false;
}

/**
 * Send Enter to terminal via sendTrustedEnter (native Electron keyboard events).
 * Terminal.input() is DISABLED for Claude panes - it doesn't work with ink TUI.
 * @param {string} paneId - The pane ID
 * @returns {Promise<{success: boolean, method: string}>}
 */
async function sendEnterToPane(paneId) {
  const terminal = terminals.get(paneId);

  // NOTE: Terminal.input('\r') does NOT work for Claude's ink TUI
  // It routes through onData → pty.write, same as direct PTY '\r' (no-op for ink TUI)
  // Terminal.input succeeds but Claude ignores it - messages sit until nudged
  // MUST use sendTrustedEnter which sends native Electron keyboard events
  //
  // Terminal.input is disabled for Claude panes until a working focus-free path is found
  // (Codex panes use codex-exec path, not this function)

  // Always use sendTrustedEnter for Claude panes (requires focus)
  // sendInputEvent can produce isTrusted=false, which the key handler blocks unless bypassed
  // Set bypass flag so attachCustomKeyEventHandler allows the Enter through
  if (terminal) {
    terminal._hivemindBypass = true;
    log.debug(`sendEnterToPane ${paneId}`, 'Set _hivemindBypass=true for sendTrustedEnter');
  }

  try {
    await window.hivemind.pty.sendTrustedEnter();
    log.info(`sendEnterToPane ${paneId}`, 'Enter sent via sendTrustedEnter (focus-based, bypass enabled)');
    return { success: true, method: 'sendTrustedEnter' };
  } catch (err) {
    log.error(`sendEnterToPane ${paneId}`, 'sendTrustedEnter failed:', err);
    return { success: false, method: 'sendTrustedEnter' };
  } finally {
    // Clear bypass flag after Enter is processed (next tick to ensure event handled)
    if (terminal) {
      setTimeout(() => {
        terminal._hivemindBypass = false;
        log.debug(`sendEnterToPane ${paneId}`, 'Cleared _hivemindBypass');
      }, 0);
    }
  }
}

/**
 * Check if terminal shows a prompt (ready for input).
 * Looks for common prompt patterns at end of current line.
 * @param {string} paneId - The pane ID
 * @returns {boolean}
 */
function isPromptReady(paneId) {
  const terminal = terminals.get(paneId);
  if (!terminal || !terminal.buffer || !terminal.buffer.active) return false;

  try {
    const buffer = terminal.buffer.active;
    const cursorY = buffer.cursorY;
    const line = buffer.getLine(cursorY + buffer.viewportY);
    if (!line) return false;

    const lineText = line.translateToString(true).trimEnd();
    // Common prompt patterns: ends with >, $, #, :, or ? (for prompts like "Continue?")
    // Note: May false-positive on questions in output - runtime testing needed
    const promptPatterns = [/>\s*$/, /\$\s*$/, /#\s*$/, /:\s*$/, /\?\s*$/];
    const hasPrompt = promptPatterns.some(p => p.test(lineText));

    if (hasPrompt) {
      log.debug(`isPromptReady ${paneId}`, `Prompt detected: "${lineText.slice(-20)}"`);
    }
    return hasPrompt;
  } catch (err) {
    log.warn(`isPromptReady ${paneId}`, 'Buffer read failed:', err.message);
    return false;
  }
}

/**
 * Verify Enter succeeded using stricter criteria:
 * 1. Output activity started (Claude began processing)
 * 2. AND prompt returned (Claude finished and is ready for input)
 *
 * This prevents false positives from continuation output.
 * Retries Enter only if focus can be established.
 *
 * @param {string} paneId - The pane ID
 * @param {HTMLElement} textarea - The textarea element (for focus operations)
 * @param {number} retriesLeft - Remaining retry attempts
 * @returns {Promise<boolean>} - Whether submit appears to have succeeded
 */
async function verifyAndRetryEnter(paneId, textarea, retriesLeft = MAX_ENTER_RETRIES) {
  const outputTimeBefore = lastOutputTime[paneId] || 0;

  // Wait for Enter to be processed
  await new Promise(resolve => setTimeout(resolve, ENTER_VERIFY_DELAY_MS));

  // Check for output activity (indicates Claude started processing)
  const outputTimeAfter = lastOutputTime[paneId] || 0;
  const hadOutputActivity = outputTimeAfter > outputTimeBefore;

  if (hadOutputActivity) {
    // Output started - now wait for prompt-ready (stricter success criteria)
    log.info(`verifyAndRetryEnter ${paneId}`, 'Output activity detected, waiting for prompt-ready');

    const promptWaitStart = Date.now();
    while ((Date.now() - promptWaitStart) < PROMPT_READY_TIMEOUT_MS) {
      // Check if prompt appeared (terminal ready for input)
      if (isPromptReady(paneId) && isIdle(paneId)) {
        log.info(`verifyAndRetryEnter ${paneId}`, 'Enter succeeded (prompt-ready + idle)');
        return true;
      }
      await new Promise(resolve => setTimeout(resolve, ENTER_RETRY_INTERVAL_MS));
    }

    // Timeout waiting for prompt, but output DID start - consider partial success
    // This handles cases where Claude is still outputting (long response)
    if (!isIdle(paneId)) {
      log.info(`verifyAndRetryEnter ${paneId}`, 'Enter succeeded (output ongoing, not idle)');
      return true;
    }

    // Pane is idle but no prompt detected - DON'T assume success
    // This is likely a false positive: Claude was already outputting, our Enter was ignored
    if (retriesLeft > 0) {
      log.info(`verifyAndRetryEnter ${paneId}`, 'No prompt detected after output, retrying Enter');
      // Re-query textarea and retry
      const currentPane = document.querySelector(`.pane[data-pane-id="${paneId}"]`);
      const currentTextarea = currentPane ? currentPane.querySelector('.xterm-helper-textarea') : null;
      if (currentTextarea) {
        const focusOk = await focusWithRetry(currentTextarea);
        if (focusOk) {
          await sendEnterToPane(paneId);
          return verifyAndRetryEnter(paneId, currentTextarea, retriesLeft - 1);
        }
      }
      log.warn(`verifyAndRetryEnter ${paneId}`, 'Could not retry Enter (focus/textarea issue)');
    }
    log.warn(`verifyAndRetryEnter ${paneId}`, 'Enter unverified (no prompt detected after output)');
    markPotentiallyStuck(paneId);
    return false;
  }

  // No output activity - Enter may have been ignored
  if (retriesLeft <= 0) {
    log.warn(`verifyAndRetryEnter ${paneId}`, 'Max retries reached, no output activity detected');
    return false;
  }

  log.info(`verifyAndRetryEnter ${paneId}`, `No output activity, will retry Enter (${retriesLeft} left)`);

  // Wait for pane to be idle before retrying
  const maxWaitTime = MAX_QUEUE_TIME_MS;
  const startWait = Date.now();

  while (!isIdle(paneId) && (Date.now() - startWait) < maxWaitTime) {
    await new Promise(resolve => setTimeout(resolve, ENTER_RETRY_INTERVAL_MS));
    // Check if output started during wait
    if ((lastOutputTime[paneId] || 0) > outputTimeBefore) {
      log.info(`verifyAndRetryEnter ${paneId}`, 'Output started during wait');
      // Recurse to apply prompt-ready check
      return verifyAndRetryEnter(paneId, textarea, retriesLeft);
    }
  }

  // Re-query textarea
  const currentPane = document.querySelector(`.pane[data-pane-id="${paneId}"]`);
  const currentTextarea = currentPane ? currentPane.querySelector('.xterm-helper-textarea') : null;

  if (!currentTextarea) {
    log.warn(`verifyAndRetryEnter ${paneId}`, 'textarea disappeared during wait');
    return false;
  }

  // STRICT: Only retry Enter if focus succeeds (no "sending anyway")
  const focusOk = await focusWithRetry(currentTextarea);
  if (!focusOk) {
    log.warn(`verifyAndRetryEnter ${paneId}`, 'Focus failed on retry - aborting (would send to wrong element)');
    return false;
  }

  // Retry Enter using helper (prefers Terminal.input if available)
  log.info(`verifyAndRetryEnter ${paneId}`, 'Retrying Enter');
  const enterResult = await sendEnterToPane(paneId);
  if (!enterResult.success) {
    log.warn(`verifyAndRetryEnter ${paneId}`, 'Enter retry failed');
    return false;
  }

  // Recurse with decremented retry count
  return verifyAndRetryEnter(paneId, currentTextarea, retriesLeft - 1);
}

// Process queued messages for a pane
function processQueue(paneId) {
  if (injectionInFlight) {
    setTimeout(() => processQueue(paneId), QUEUE_RETRY_MS);
    return;
  }
  const queue = messageQueue[paneId];
  if (!queue || queue.length === 0) return;

  const now = Date.now();
  const item = queue[0];
  const queuedMessage = typeof item === 'string' ? item : item.message;
  const onComplete = item && typeof item === 'object' ? item.onComplete : null;

  // Check timing conditions
  const waitTime = now - (item.timestamp || now);
  const waitedTooLong = waitTime >= MAX_QUEUE_TIME_MS;
  const waitedExtremelyLong = waitTime >= EXTREME_WAIT_MS;
  const hitAbsoluteMax = waitTime >= ABSOLUTE_MAX_WAIT_MS;

  // Normal case: pane is fully idle (2s of silence)
  const canSendNormal = isIdle(paneId) && !userIsTyping();

  // Force-inject case: waited 10s+ AND pane has at least 500ms of silence
  // This prevents injecting during active output which causes Enter to be ignored
  const canForceInject = waitedTooLong && isIdleForForceInject(paneId) && !userIsTyping();

  // Emergency fallback: 60s absolute max regardless of idle state
  // This prevents messages from being stuck forever if pane never becomes idle
  const mustForceInject = hitAbsoluteMax && !userIsTyping();

  // Log warning at 30s mark (only once per message via flag check)
  if (waitedExtremelyLong && !item._warnedExtreme) {
    item._warnedExtreme = true;
    const timeSinceOutput = Date.now() - (lastOutputTime[paneId] || 0);
    log.warn(`Terminal ${paneId}`, `Message queued 30s+, pane last output ${timeSinceOutput}ms ago, still waiting for idle`);
  }

  if (canSendNormal || canForceInject || mustForceInject) {
    // Remove from queue and send
    queue.shift();
    if (mustForceInject && !canForceInject && !canSendNormal) {
      log.warn(`Terminal ${paneId}`, `EMERGENCY: Force-injecting after ${waitTime}ms (60s max reached, pane may still be active)`);
    } else if (canForceInject && !canSendNormal) {
      log.info(`Terminal ${paneId}`, `Force-injecting after ${waitTime}ms wait (pane now idle for 500ms)`);
    }
    injectionInFlight = true;
    doSendToPane(paneId, queuedMessage, (result) => {
      injectionInFlight = false;
      if (typeof onComplete === 'function') {
        try {
          onComplete(result);
        } catch (err) {
          log.error('Terminal', 'queue onComplete failed', err);
        }
      }
      if (queue.length > 0) {
        setTimeout(() => processQueue(paneId), QUEUE_RETRY_MS);
      }
    });
  } else {
    // Still busy, retry later
    setTimeout(() => processQueue(paneId), QUEUE_RETRY_MS);
  }
}

// Initialize all terminals
async function initTerminals() {
  // SDK Mode Guard: Don't initialize PTY terminals in SDK mode
  if (sdkModeActive) {
    log.info('initTerminals', 'SDK mode active - skipping PTY terminal initialization');
    return;
  }

  for (const paneId of PANE_IDS) {
    await initTerminal(paneId);
  }
  updateConnectionStatus('All terminals ready');
  focusPane('1');

  // Start stuck message sweeper for Claude panes
  startStuckMessageSweeper();
}

// Setup copy/paste handlers
function setupCopyPaste(container, terminal, paneId, statusMsg) {
  let lastSelection = '';
  terminal.onSelectionChange(() => {
    const sel = terminal.getSelection();
    if (sel) lastSelection = sel;
  });

  container.addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    e.stopPropagation();

    if (lastSelection) {
      try {
        await navigator.clipboard.writeText(lastSelection);
        updatePaneStatus(paneId, 'Copied!');
        setTimeout(() => updatePaneStatus(paneId, statusMsg), 1000);
      } catch (err) {
        log.error('Clipboard', 'Copy failed (permission denied?):', err);
        updatePaneStatus(paneId, 'Copy failed');
        setTimeout(() => updatePaneStatus(paneId, statusMsg), 1000);
      }
      lastSelection = '';
    } else {
      // Block paste when input is locked
      if (inputLocked[paneId]) {
        updatePaneStatus(paneId, 'Input locked');
        setTimeout(() => updatePaneStatus(paneId, statusMsg), 1000);
        return;
      }
      try {
        const text = await navigator.clipboard.readText();
        if (text) {
          await window.hivemind.pty.write(paneId, text);
          updatePaneStatus(paneId, 'Pasted!');
          setTimeout(() => updatePaneStatus(paneId, statusMsg), 1000);
        }
      } catch (err) {
        log.error('Paste', 'Paste failed', err);
      }
    }
  });

  container.addEventListener('keydown', async (e) => {
    if (e.ctrlKey && e.key === 'v') {
      e.preventDefault();
      // Block Ctrl+V paste when input is locked
      if (inputLocked[paneId]) {
        updatePaneStatus(paneId, 'Input locked');
        setTimeout(() => updatePaneStatus(paneId, statusMsg), 1000);
        return;
      }
      try {
        const text = await navigator.clipboard.readText();
        if (text) {
          await window.hivemind.pty.write(paneId, text);
        }
      } catch (err) {
        log.error('Paste', 'Paste failed', err);
      }
    }
  });
}

// Initialize a single terminal
async function initTerminal(paneId) {
  const container = document.getElementById(`terminal-${paneId}`);
  if (!container) return;

  const terminal = new Terminal(TERMINAL_OPTIONS);
  const fitAddon = new FitAddon();
  const webLinksAddon = new WebLinksAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(webLinksAddon);

  terminal.open(container);
  fitAddon.fit();

  // Critical: block keyboard input when user is typing in a UI input/textarea
  // BUT allow xterm's own internal textarea (xterm-helper-textarea) to work normally
  terminal.attachCustomKeyEventHandler((event) => {
    // Track actual user typing (single chars, no modifiers)
    if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
      lastTypedTime[paneId] = Date.now();
    }

    // Check if this is an Enter key (browsers use 'Enter', some use 'Return', keyCode 13)
    const isEnterKey = event.key === 'Enter' || event.key === 'Return' || event.keyCode === 13;

    // CRITICAL: Hivemind bypass check MUST come FIRST, before lock check
    // This allows programmatic Enter from sendTrustedEnter to bypass input lock
    // Note: sendInputEvent may produce isTrusted=true OR isTrusted=false depending on Electron version
    if (isEnterKey && (event._hivemindBypass || terminal._hivemindBypass)) {
      log.info(`Terminal ${paneId}`, `Allowing programmatic Enter (hivemind bypass, key=${event.key}, isTrusted=${event.isTrusted})`);
      return true;
    }

    // Block non-trusted synthetic Enter that doesn't have bypass flag
    if (isEnterKey && !event.isTrusted) {
      log.info(`Terminal ${paneId}`, `Blocked synthetic Enter (isTrusted=false, no bypass, key=${event.key})`);
      return false;
    }

    // Per-pane input lock: ESC always bypasses (for unstick), all else blocked when locked
    if (inputLocked[paneId]) {
      if (event.key === 'Escape') {
        return true; // ESC bypasses lock for unstick scenarios
      }
      // Allow Ctrl+L to toggle lock even when locked
      if (event.ctrlKey && event.key.toLowerCase() === 'l') {
        toggleInputLock(paneId);
        return false; // Handled, don't pass to terminal
      }
      return false; // Block all other input when locked
    }

    // Ctrl+L toggles lock when unlocked too
    if (event.ctrlKey && event.key.toLowerCase() === 'l') {
      toggleInputLock(paneId);
      return false;
    }

    const activeEl = document.activeElement;
    const tagName = activeEl?.tagName?.toUpperCase();
    const isXtermTextarea = activeEl?.classList?.contains('xterm-helper-textarea');
    // If focus is on a UI input/textarea (not xterm's own), block the key
    if ((tagName === 'INPUT' || tagName === 'TEXTAREA') && !isXtermTextarea) {
      return false; // Prevent xterm from handling this key
    }
    return true; // Allow xterm to handle normally
  });

  setupCopyPaste(container, terminal, paneId, 'Connected');

  terminals.set(paneId, terminal);
  fitAddons.set(paneId, fitAddon);

  try {
    await window.hivemind.pty.create(paneId, process.cwd());
    updatePaneStatus(paneId, 'Connected');

    if (!isCodexPane(paneId)) {
      terminal.onData((data) => {
        window.hivemind.pty.write(paneId, data).catch(err => {
          log.error(`Terminal ${paneId}`, 'PTY write failed:', err);
        });
      });
    }

    window.hivemind.pty.onData(paneId, (data) => {
      terminal.write(data);
      // Track output time for idle detection
      lastOutputTime[paneId] = Date.now();
      // Clear stuck status - output means pane is working
      clearStuckStatus(paneId);
      if (isCodexPane(paneId)) {
        if (data.includes('[Working...]')) {
          updatePaneStatus(paneId, 'Working');
        }
        if (data.includes('[Task complete]') || data.includes('[Codex exec exited')) {
          updatePaneStatus(paneId, 'Codex exec ready');
        }
      }
    });

    window.hivemind.pty.onExit(paneId, (code) => {
      updatePaneStatus(paneId, `Exited (${code})`);
      terminal.write(`\r\n[Process exited with code ${code}]\r\n`);
    });

  } catch (err) {
    log.error(`Terminal ${paneId}`, 'Failed to create PTY', err);
    updatePaneStatus(paneId, 'Error');
    terminal.write(`\r\n[Error: ${err.message}]\r\n`);
  }

  container.addEventListener('click', () => {
    focusPane(paneId);
  });
}

// Reattach to existing terminal (daemon reconnection)
// U1: scrollback parameter contains buffered output to restore
async function reattachTerminal(paneId, scrollback) {
  const container = document.getElementById(`terminal-${paneId}`);
  if (!container) return;

  if (terminals.has(paneId)) {
    log.info(`Terminal ${paneId}`, 'Already attached, skipping');
    return;
  }

  const terminal = new Terminal(TERMINAL_OPTIONS);
  const fitAddon = new FitAddon();
  const webLinksAddon = new WebLinksAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(webLinksAddon);

  terminal.open(container);
  fitAddon.fit();

  // Critical: block keyboard input when user is typing in a UI input/textarea
  // BUT allow xterm's own internal textarea (xterm-helper-textarea) to work normally
  terminal.attachCustomKeyEventHandler((event) => {
    // Track actual user typing (single chars, no modifiers)
    if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
      lastTypedTime[paneId] = Date.now();
    }

    // Check if this is an Enter key (browsers use 'Enter', some use 'Return', keyCode 13)
    const isEnterKey = event.key === 'Enter' || event.key === 'Return' || event.keyCode === 13;

    // CRITICAL: Hivemind bypass check MUST come FIRST, before lock check
    // This allows programmatic Enter from sendTrustedEnter to bypass input lock
    // Note: sendInputEvent may produce isTrusted=true OR isTrusted=false depending on Electron version
    if (isEnterKey && (event._hivemindBypass || terminal._hivemindBypass)) {
      log.info(`Terminal ${paneId}`, `Allowing programmatic Enter (hivemind bypass, key=${event.key}, isTrusted=${event.isTrusted})`);
      return true;
    }

    // Block non-trusted synthetic Enter that doesn't have bypass flag
    if (isEnterKey && !event.isTrusted) {
      log.info(`Terminal ${paneId}`, `Blocked synthetic Enter (isTrusted=false, no bypass, key=${event.key})`);
      return false;
    }

    // Per-pane input lock: ESC always bypasses (for unstick), all else blocked when locked
    if (inputLocked[paneId]) {
      if (event.key === 'Escape') {
        return true; // ESC bypasses lock for unstick scenarios
      }
      // Allow Ctrl+L to toggle lock even when locked
      if (event.ctrlKey && event.key.toLowerCase() === 'l') {
        toggleInputLock(paneId);
        return false;
      }
      return false; // Block all other input when locked
    }

    // Ctrl+L toggles lock when unlocked too
    if (event.ctrlKey && event.key.toLowerCase() === 'l') {
      toggleInputLock(paneId);
      return false;
    }

    const activeEl = document.activeElement;
    const tagName = activeEl?.tagName?.toUpperCase();
    const isXtermTextarea = activeEl?.classList?.contains('xterm-helper-textarea');
    if ((tagName === 'INPUT' || tagName === 'TEXTAREA') && !isXtermTextarea) {
      return false;
    }
    return true;
  });

  setupCopyPaste(container, terminal, paneId, 'Reconnected');

  terminals.set(paneId, terminal);
  fitAddons.set(paneId, fitAddon);

  // U1: Restore scrollback buffer if available
  if (scrollback && scrollback.length > 0) {
    terminal.write(scrollback);
  }

  if (!isCodexPane(paneId)) {
    terminal.onData((data) => {
      window.hivemind.pty.write(paneId, data).catch(err => {
        log.error(`Terminal ${paneId}`, 'PTY write failed:', err);
      });
    });
  }

  window.hivemind.pty.onData(paneId, (data) => {
    terminal.write(data);
    // Track output time for idle detection
    lastOutputTime[paneId] = Date.now();
    // Clear stuck status - output means pane is working
    clearStuckStatus(paneId);
    if (isCodexPane(paneId)) {
      if (data.includes('[Working...]')) {
        updatePaneStatus(paneId, 'Working');
      }
      if (data.includes('[Task complete]') || data.includes('[Codex exec exited')) {
        updatePaneStatus(paneId, 'Codex exec ready');
      }
    }
  });

  window.hivemind.pty.onExit(paneId, (code) => {
    updatePaneStatus(paneId, `Exited (${code})`);
    terminal.write(`\r\n[Process exited with code ${code}]\r\n`);
  });

  updatePaneStatus(paneId, 'Reconnected');

  container.addEventListener('click', () => {
    focusPane(paneId);
  });
}

// Focus a specific pane
function focusPane(paneId) {
  document.querySelectorAll('.pane').forEach(pane => {
    pane.classList.remove('focused');
  });

  const pane = document.querySelector(`.pane[data-pane-id="${paneId}"]`);
  if (pane) {
    pane.classList.add('focused');
  }

  const terminal = terminals.get(paneId);
  if (terminal) {
    terminal.focus();
  }

  focusedPane = paneId;
}

// Blur all terminals - used when input fields get focus
function blurAllTerminals() {
  for (const terminal of terminals.values()) {
    if (terminal && terminal.blur) {
      terminal.blur();
    }
  }
}

// Actually send message to pane (internal - use sendToPane for idle detection)
// Triggers actual DOM keyboard events on xterm textarea with bypass marker
// Includes diagnostic logging and focus steal prevention (save/restore user focus)
async function doSendToPane(paneId, message, onComplete) {
  let completed = false;
  const finish = (result) => {
    if (completed) return;
    completed = true;
    if (onComplete) {
      try {
        onComplete(result);
      } catch (err) {
        log.error('Terminal', 'onComplete failed', err);
      }
    }
  };
  const safetyTimer = setTimeout(() => {
    // Timeout doesn't mean failure - message may still be delivered
    // Return success:true so delivery ack is sent, but mark as unverified
    finish({ success: true, verified: false, reason: 'timeout' });
  }, INJECTION_LOCK_TIMEOUT_MS);
  const finishWithClear = (result) => {
    clearTimeout(safetyTimer);
    finish(result || { success: true });
  };

  const hasTrailingEnter = message.endsWith('\r');
  const text = message.replace(/\r$/, '');
  const id = String(paneId);
  const isCodex = isCodexPane(id);

  // Codex exec mode: bypass PTY/textarea injection
  if (isCodex) {
    const prompt = buildCodexExecPrompt(id, text);
    // Echo user input to xterm so it's visible
    const terminal = terminals.get(id);
    if (terminal) {
      terminal.write(`\r\n\x1b[36m> ${text}\x1b[0m\r\n`);
    }
    window.hivemind.pty.codexExec(id, prompt).catch(err => {
      log.error(`doSendToPane ${id}`, 'Codex exec failed:', err);
    });
    updatePaneStatus(id, 'Working');
    lastTypedTime[paneId] = Date.now();
    lastOutputTime[paneId] = Date.now();
    finishWithClear({ success: true });
    return;
  }

  // CLAUDE PATH: Hybrid approach (PTY write for text + DOM keyboard for Enter)
  // PTY \r does NOT auto-submit in Claude Code's ink TUI (PTY newline ignored)
  // sendTrustedEnter() sends native keyboard events via Electron which WORKS
  const terminal = terminals.get(id);
  const paneEl = document.querySelector(`.pane[data-pane-id="${id}"]`);
  let textarea = paneEl ? paneEl.querySelector('.xterm-helper-textarea') : null;

  // Guard: Skip if textarea not found (prevents Enter going to wrong element)
  if (!textarea) {
    log.warn(`doSendToPane ${id}`, 'Claude pane: textarea not found, skipping injection');
    finishWithClear({ success: false, reason: 'missing_textarea' });
    return;
  }

  // Save current focus to restore after injection
  const savedFocus = document.activeElement;

  // Helper to restore focus (called immediately after Enter, not after verification)
  const restoreSavedFocus = () => {
    if (savedFocus && savedFocus !== textarea && document.body.contains(savedFocus)) {
      try {
        savedFocus.focus();
      } catch (e) {
        // Element may not be focusable
      }
    }
  };

  // Step 1: Focus terminal for sendTrustedEnter (required for Enter to target correct pane)
  // Note: Terminal.input() was disabled for Claude panes - it doesn't work with ink TUI
  if (hasTrailingEnter) {
    textarea.focus();
  }

  // Step 2: Clear any stuck input BEFORE writing new text
  // Ctrl+U (0x15) clears the current input line - prevents accumulation if previous Enter failed
  // This is harmless if line is already empty
  try {
    await window.hivemind.pty.write(id, '\x15');
    log.info(`doSendToPane ${id}`, 'Claude pane: cleared input line (Ctrl+U)');
  } catch (err) {
    log.warn(`doSendToPane ${id}`, 'PTY clear-line failed:', err);
    // Continue anyway - text write may still work
  }

  // Step 3: Write text to PTY (without \r)
  try {
    await window.hivemind.pty.write(id, text);
    log.info(`doSendToPane ${id}`, 'Claude pane: PTY write text complete');
  } catch (err) {
    log.error(`doSendToPane ${id}`, 'PTY write failed:', err);
    finishWithClear({ success: false, reason: 'pty_write_failed' });
    return;
  }

  // Step 4: If message needs Enter, use sendTrustedEnter after adaptive delay
  if (hasTrailingEnter) {
    // Calculate delay based on pane activity (busy panes need more time)
    const enterDelay = getAdaptiveEnterDelay(id);
    log.info(`doSendToPane ${id}`, `Using adaptive Enter delay: ${enterDelay}ms`);

    setTimeout(async () => {
      // Clear safety timer immediately - we've reached the callback, injection is proceeding
      // (safetyTimer at 1000ms can fire during enterDelay wait, causing false abort)
      clearTimeout(safetyTimer);

      // Re-query textarea in case DOM changed during delay
      const currentPane = document.querySelector(`.pane[data-pane-id="${id}"]`);
      textarea = currentPane ? currentPane.querySelector('.xterm-helper-textarea') : null;

      // Guard: Abort if textarea disappeared
      if (!textarea) {
        log.warn(`doSendToPane ${id}`, 'Claude pane: textarea disappeared before Enter, aborting');
        restoreSavedFocus();
        finishWithClear({ success: false, reason: 'textarea_disappeared' });
        return;
      }

      // PRE-FLIGHT IDLE CHECK: Don't send Enter while Claude is outputting
      // If we send Enter mid-output, it gets ignored and verification sees false positive
      // (lastOutputTime comparison doesn't work if Claude was already outputting)
      if (!isIdle(id)) {
        log.info(`doSendToPane ${id}`, 'Claude pane: waiting for idle before Enter');
        const idleWaitStart = Date.now();
        const maxIdleWait = 5000; // 5s max wait for idle
        while (!isIdle(id) && (Date.now() - idleWaitStart) < maxIdleWait) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (!isIdle(id)) {
          log.warn(`doSendToPane ${id}`, 'Claude pane: still not idle after 5s, proceeding anyway');
        } else {
          log.info(`doSendToPane ${id}`, `Claude pane: now idle after ${Date.now() - idleWaitStart}ms`);
        }
      }

      // Ensure focus for sendTrustedEnter (Terminal.input disabled for Claude panes)
      const focusOk = await focusWithRetry(textarea);

      // STRICT: If focus failed, abort BEFORE sending Enter (would go to wrong element)
      if (!focusOk) {
        log.warn(`doSendToPane ${id}`, 'Claude pane: focus failed - aborting Enter');
        restoreSavedFocus();
        markPotentiallyStuck(id);
        finishWithClear({ success: false, reason: 'focus_failed' });
        return;
      }

      // Send Enter via sendTrustedEnter (Terminal.input disabled for Claude panes)
      const enterResult = await sendEnterToPane(id);

      // IMMEDIATELY restore focus after Enter sent - don't block user input during verification
      // (Restore focus to avoid blocking command bar during trigger injections)
      restoreSavedFocus();

      if (!enterResult.success) {
        log.error(`doSendToPane ${id}`, 'Enter send failed');
        markPotentiallyStuck(id);
        finishWithClear({ success: false, reason: 'enter_failed' });
        return;
      }
      log.info(`doSendToPane ${id}`, `Claude pane: Enter sent via ${enterResult.method}`);

      // Verify Enter succeeded (textarea empty) - if not, wait for idle and retry
      // This handles force-inject during active output where Enter is ignored
      // Note: verification runs with focus already restored to user
      const submitOk = await verifyAndRetryEnter(id, textarea);
      if (!submitOk) {
        log.warn(`doSendToPane ${id}`, 'Claude pane: Enter verification failed after retries');
        markPotentiallyStuck(id); // Register for sweeper retry
      }

      lastTypedTime[paneId] = Date.now();
      const resultPayload = submitOk
        ? { success: true }
        // Enter was sent, but verification failed (no output/prompt yet) - treat as unverified success
        : { success: true, verified: false, reason: 'verification_failed' };
      finishWithClear(resultPayload);
    }, enterDelay);
  } else {
    // No Enter needed, just restore focus
    restoreSavedFocus();
    lastTypedTime[paneId] = Date.now();
    finishWithClear({ success: true });
  }
}

// Send message to a specific pane (queues if pane is busy)
function sendToPane(paneId, message, options = {}) {
  const id = String(paneId);

  if (!messageQueue[id]) {
    messageQueue[id] = [];
  }

  messageQueue[id].push({
    message: message,
    timestamp: Date.now(),
    onComplete: options.onComplete,
  });

  const reason = userIsTyping()
    ? 'user typing'
    : (injectionInFlight ? 'injection in flight' : (!isIdle(id) ? 'pane busy' : 'idle'));
  log.info(`Terminal ${id}`, `${reason}, queueing message`);

  // Start processing queue
  processQueue(id);
}

// Send message to Architect only (user interacts with Architect, Architect coordinates execution)
function broadcast(message) {
  // Send directly to Architect (pane 1), no broadcast prefix needed
  sendToPane('1', message);
  updateConnectionStatus('Message sent to Architect');
}

// Set SDK mode - blocks PTY spawn operations when enabled
function setSDKMode(enabled) {
  sdkModeActive = enabled;
  log.info('Terminal', `SDK mode ${enabled ? 'enabled' : 'disabled'} - PTY spawn operations ${enabled ? 'blocked' : 'allowed'}`);
}

// Spawn claude in a pane
async function spawnClaude(paneId) {
  // Defense in depth: Early exit if no terminal exists for this pane
  // This catches race conditions where SDK mode blocks terminal creation but
  // user somehow triggers spawn before UI fully updates
  if (!terminals.has(paneId)) {
    log.info('spawnClaude', `No terminal for pane ${paneId}, skipping`);
    return;
  }

  // SDK Mode Guard: Don't spawn CLI Claude when SDK mode is active
  if (sdkModeActive) {
    log.info('spawnClaude', `SDK mode active - blocking CLI spawn for pane ${paneId}`);
    return;
  }

  // Codex exec mode: no interactive CLI spawn — send identity prompt to kick off agent
  if (isCodexPane(String(paneId))) {
    updatePaneStatus(paneId, 'Codex exec ready');
    // Auto-send identity message to start the Codex agent (mirrors Claude identity injection at line 716)
    setTimeout(() => {
      const role = PANE_ROLES[paneId] || `Pane ${paneId}`;
      const timestamp = new Date().toISOString().split('T')[0];
      const identityMsg = `# HIVEMIND SESSION: ${role} - Started ${timestamp}`;
      sendToPane(paneId, identityMsg + '\r');
      log.info('spawnClaude', `Codex exec identity sent for ${role} (pane ${paneId})`);
    }, 2000);
    return;
  }

  const terminal = terminals.get(paneId);
  if (terminal) {
    updatePaneStatus(paneId, 'Starting agent...');
    let result;
    try {
      result = await window.hivemind.claude.spawn(paneId);
    } catch (err) {
      log.error(`spawnClaude ${paneId}`, 'Spawn failed:', err);
      updatePaneStatus(paneId, 'Spawn failed');
      return;
    }
    if (result.success && result.command) {
      // Use pty.write directly instead of terminal.paste for reliability
      // terminal.paste() can fail if terminal isn't fully ready
      try {
        await window.hivemind.pty.write(String(paneId), result.command);
      } catch (err) {
        log.error(`spawnClaude ${paneId}`, 'PTY write command failed:', err);
      }
      // Mark as typed so Enter isn't blocked
      lastTypedTime[paneId] = Date.now();
      // Small delay before sending Enter
      await new Promise(resolve => setTimeout(resolve, 100));
      try {
        await window.hivemind.pty.write(String(paneId), '\r');
      } catch (err) {
        log.error(`spawnClaude ${paneId}`, 'PTY write Enter failed:', err);
      }

      // Codex CLI needs an extra Enter after startup to dismiss its welcome prompt
      // Claude Code CLI doesn't need this - it's ready immediately
      // NOTE: Codex sandbox_mode should be pre-configured via ~/.codex/config.toml
      // (sandbox_mode = "workspace-write") to skip the first-run sandbox prompt.
      // This PTY \r is a fallback to dismiss any residual prompt if config is missing.
      const isCodex = result.command.startsWith('codex');
      if (isCodex) {
        setTimeout(() => {
          window.hivemind.pty.write(String(paneId), '\r').catch(err => {
            log.error(`spawnClaude ${paneId}`, 'Codex startup Enter failed:', err);
          });
          log.info('spawnClaude', `Codex pane ${paneId}: PTY \\r to dismiss any startup prompt`);
        }, 3000);
      }

      // ID-1: Inject identity message after CLI initializes
      // Uses sendToPane() which properly submits via keyboard events
      // This makes sessions identifiable in /resume list
      setTimeout(() => {
        const role = PANE_ROLES[paneId] || `Pane ${paneId}`;
        const timestamp = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
        const identityMsg = `# HIVEMIND SESSION: ${role} - Started ${timestamp}`;
        sendToPane(paneId, identityMsg + '\r');
        log.info('spawnClaude', `Identity injected for ${role} (pane ${paneId})`);
      }, isCodex ? 5000 : 4000);
    }
    updatePaneStatus(paneId, 'Agent running');
  }
}

// Spawn claude in all panes
async function spawnAllClaude() {
  updateConnectionStatus('Starting agents in all panes...');
  for (const paneId of PANE_IDS) {
    await spawnClaude(paneId);
    // Small delay between panes to prevent race conditions
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  updateConnectionStatus('All agents running');
}

// Kill all terminals
async function killAllTerminals() {
  updateConnectionStatus('Killing all terminals...');
  for (const paneId of PANE_IDS) {
    try {
      await window.hivemind.pty.kill(paneId);
      updatePaneStatus(paneId, 'Killed');
    } catch (err) {
      log.error(`Terminal ${paneId}`, 'Failed to kill pane', err);
    }
  }
  updateConnectionStatus('All terminals killed');
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
  if (sdkModeActive) {
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
  if (sdkModeActive) {
    log.info('Terminal', `Restart blocked for pane ${id} (SDK mode)`);
    updatePaneStatus(id, 'Restart blocked (SDK)');
    setTimeout(() => updatePaneStatus(id, 'Running'), 1500);
    return false;
  }

  updatePaneStatus(id, 'Restarting...');
  try {
    await window.hivemind.pty.kill(id);
  } catch (err) {
    log.error('Terminal', `Failed to kill pane ${id} for restart:`, err);
  }

  await new Promise(resolve => setTimeout(resolve, 250));

  // Codex exec panes need PTY recreated before spawnClaude
  // spawnClaude() for Codex panes only sends identity message - doesn't create PTY
  if (isCodexPane(id)) {
    try {
      await window.hivemind.pty.create(id);
      log.info('Terminal', `Recreated PTY for Codex pane ${id}`);
    } catch (err) {
      log.error('Terminal', `Failed to recreate PTY for Codex pane ${id}:`, err);
      updatePaneStatus(id, 'Restart failed');
      return false;
    }
  }

  await spawnClaude(id);
  return true;
}

async function unstickEscalation(paneId) {
  const id = String(paneId);
  const state = getUnstickState(id);

  if (state.step === 0) {
    log.info('Unstick', `Pane ${id}: nudge`);
    aggressiveNudge(id);
    updatePaneStatus(id, 'Nudged');
    setTimeout(() => updatePaneStatus(id, 'Running'), 1500);
    state.step = 1;
    return;
  }

  if (state.step === 1) {
    log.info('Unstick', `Pane ${id}: interrupt`);
    const ok = await interruptPane(id);
    updatePaneStatus(id, ok ? 'Interrupted' : 'Interrupt failed');
    setTimeout(() => updatePaneStatus(id, 'Running'), 1500);
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
  updatePaneStatus(paneId, 'Nudged');
  setTimeout(() => updatePaneStatus(paneId, 'Running'), 1000);
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
      cancelable: true
    });
    escEvent._hivemindBypass = true;
    textarea.dispatchEvent(escEvent);

    // Also keyup for completeness
    const escUpEvent = new KeyboardEvent('keyup', {
      key: 'Escape',
      code: 'Escape',
      keyCode: 27,
      which: 27,
      bubbles: true
    });
    escUpEvent._hivemindBypass = true;
    textarea.dispatchEvent(escUpEvent);

    log.info(`Terminal ${id}`, 'Sent ESC keyboard event to unstick agent');
    updatePaneStatus(id, 'Unstick sent');
    setTimeout(() => updatePaneStatus(id, 'Running'), 1000);
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

      if (isCodexPane(id)) {
        // Codex: PTY newline to submit (clipboard paste broken - Codex treats as image paste)
        window.hivemind.pty.write(id, '\r').catch(err => {
          log.error(`aggressiveNudge ${id}`, 'Codex PTY write failed:', err);
        });
        log.info(`Terminal ${id}`, 'Aggressive nudge: PTY carriage return (Codex)');
      } else {
        // Claude: use sendEnterToPane helper (handles bypass flag + Terminal.input fallback)
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

    updatePaneStatus(id, 'Nudged (aggressive)');
    setTimeout(() => updatePaneStatus(id, 'Running'), 1000);
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
  updateConnectionStatus('Nudging all agents...');
  for (const paneId of PANE_IDS) {
    nudgePane(paneId);
  }
  setTimeout(() => {
    updateConnectionStatus('All agents nudged');
  }, 200);
}

// Fresh start - kill all and spawn new sessions without context
async function freshStartAll() {
  // SDK Mode Guard: Don't allow fresh start in SDK mode
  if (sdkModeActive) {
    log.info('freshStartAll', 'SDK mode active - blocking PTY fresh start');
    alert('Fresh Start is not available in SDK mode.\nSDK manages agent sessions differently.');
    return;
  }

  const confirmed = confirm(
    'Fresh Start will:\n\n' +
    '• Kill all 6 terminals\n' +
    '• Start new agent sessions with NO previous context\n\n' +
    'All current conversations will be lost.\n\n' +
    'Continue?'
  );

  if (!confirmed) {
    updateConnectionStatus('Fresh start cancelled');
    return;
  }

  updateConnectionStatus('Fresh start: killing all terminals...');

  // Kill all terminals
  for (const paneId of PANE_IDS) {
    try {
      await window.hivemind.pty.kill(paneId);
    } catch (err) {
      log.error(`Terminal ${paneId}`, 'Failed to kill pane', err);
    }
  }

  // Clear terminal displays
  for (const [paneId, terminal] of terminals) {
    terminal.clear();
  }

  // Wait for terminals to close
  await new Promise(resolve => setTimeout(resolve, 500));

  updateConnectionStatus('Fresh start: spawning new sessions...');

  // Spawn fresh Claude instances
  for (const paneId of PANE_IDS) {
    try {
      await window.hivemind.pty.create(paneId, process.cwd());
      updatePaneStatus(paneId, 'Connected');
    } catch (err) {
      log.error(`Terminal ${paneId}`, 'Failed to create terminal', err);
    }
  }

  // Wait for terminals to be ready
  await new Promise(resolve => setTimeout(resolve, 300));

  // Spawn agents with fresh sessions
  for (const paneId of PANE_IDS) {
    await spawnClaude(paneId);
  }

  updateConnectionStatus('Fresh start complete - new sessions started');
}

// Sync shared context to all panes
async function syncSharedContext() {
  updateConnectionStatus('Syncing shared context...');

  try {
    const result = await window.hivemind.context.read();

    if (!result.success) {
      updateConnectionStatus(`Sync failed: ${result.error}`);
      return false;
    }

    const syncMessage = `[HIVEMIND SYNC] Please read and acknowledge the following shared context:

---
${result.content}
---

Acknowledge receipt and summarize the key points.\r`;

    broadcast(syncMessage);
    updateConnectionStatus('Shared context synced to all panes');
    return true;

  } catch (err) {
    updateConnectionStatus(`Sync error: ${err.message}`);
  }
  return false;
}

// Handle window resize
function handleResize() {
  for (const [paneId, fitAddon] of fitAddons) {
    try {
      fitAddon.fit();
      const terminal = terminals.get(paneId);
      if (terminal) {
        window.hivemind.pty.resize(paneId, terminal.cols, terminal.rows);
      }
    } catch (err) {
      log.error(`Terminal ${paneId}`, 'Error resizing pane', err);
    }
  }
}

// Getters/setters
function getTerminal(paneId) {
  return terminals.get(paneId);
}

function getFocusedPane() {
  return focusedPane;
}

function setReconnectedToExisting(value) {
  reconnectedToExisting = value;
}

function getReconnectedToExisting() {
  return reconnectedToExisting;
}

module.exports = {
  PANE_IDS,
  terminals,
  fitAddons,
  setStatusCallbacks,
  setSDKMode,           // SDK mode guard for PTY operations
  initUIFocusTracker,   // Global UI focus tracking for multi-pane restore
  initTerminals,
  initTerminal,
  reattachTerminal,
  focusPane,
  blurAllTerminals,
  sendToPane,
  broadcast,
  spawnClaude,
  spawnAllClaude,
  killAllTerminals,
  nudgePane,
  nudgeAllPanes,
  interruptPane,
  restartPane,
  unstickEscalation,
  sendUnstick,         // ESC keyboard event to unstick agents
  aggressiveNudge,     // ESC + Enter for more forceful unstick
  aggressiveNudgeAll,  // Aggressive nudge all panes with stagger
  freshStartAll,
  syncSharedContext,
  handleResize,
  getTerminal,
  getFocusedPane,
  setReconnectedToExisting,
  getReconnectedToExisting,
  updatePaneStatus,
  updateConnectionStatus,
  lastEnterTime,  // Exported for daemon coordination
  lastTypedTime,  // Track typing for Enter blocking
  lastOutputTime, // Track output for idle detection
  isIdle,         // Check if pane is idle
  registerCodexPane,   // CLI Identity: mark pane as Codex
  unregisterCodexPane, // CLI Identity: unmark pane as Codex
  isCodexPane,         // CLI Identity: query Codex status
  messageQueue,   // Message queue for busy panes
  // Stuck message sweeper
  potentiallyStuckPanes, // Tracking for sweeper
  startStuckMessageSweeper,
  stopStuckMessageSweeper,
  sweepStuckMessages,  // Manual trigger for testing
  // Per-pane input lock (view-only mode)
  inputLocked,         // Lock state map
  isInputLocked,       // Check if pane is locked
  toggleInputLock,     // Toggle lock state
  setInputLocked,      // Set lock state directly
};
