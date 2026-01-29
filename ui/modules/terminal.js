/**
 * Terminal management module
 * Handles xterm instances, PTY connections, and terminal operations
 */

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

// FX4-v2: Cross-pane Enter debounce tracking
// Prevents ghost text submission when Enter hits multiple panes within 100ms
const lastEnterTime = {};

// FX4-v3: Track actual user typing per pane
// Only allow Enter if user typed something in last 2 seconds
const lastTypedTime = {};

// Idle detection to prevent stuck animation
// Track last output time per pane - updated on every pty.onData
const lastOutputTime = {};

// Codex exec mode: track identity injection per pane
const codexIdentityInjected = new Set();

// Message queue for when pane is busy
// Format: { paneId: [{ message, timestamp }, ...] }
const messageQueue = {};
// Prevent overlapping PTY injections across panes (global focus/Enter mutex)
let injectionInFlight = false;

// Global UI focus tracker - survives staggered multi-pane sends.
// Updated by focusin listener on UI inputs; doSendToPane restores to this.
let lastUserUIFocus = null;

// Focus-steal fix: Track when user last typed in a UI input (not xterm).
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

// Adaptive Enter delay constants (fixes race condition where Enter fires before text appears)
const ENTER_DELAY_IDLE_MS = 50;       // Pane idle (no output > 500ms): fast Enter
const ENTER_DELAY_ACTIVE_MS = 150;    // Pane active (output in last 500ms): medium delay
const ENTER_DELAY_BUSY_MS = 300;      // Pane busy (output in last 100ms): longer delay
const PANE_ACTIVE_THRESHOLD_MS = 500; // Recent output threshold for "active"
const PANE_BUSY_THRESHOLD_MS = 100;   // Very recent output threshold for "busy"
const FOCUS_RETRY_DELAY_MS = 20;      // Delay between focus retry attempts
const MAX_FOCUS_RETRIES = 3;          // Max focus retry attempts before giving up
const ENTER_VERIFY_DELAY_MS = 100;    // Delay before checking if Enter succeeded
const MAX_ENTER_RETRIES = 5;          // Max Enter retry attempts if text remains
const ENTER_RETRY_INTERVAL_MS = 200;  // Interval between checking if pane is idle for retry

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
 * Verify Enter succeeded by checking for output activity after submission
 *
 * NOTE: We inject text via PTY write, which bypasses textarea.value entirely.
 * Therefore, checking textarea.value would always show empty (false positive).
 * Instead, we verify by checking if output activity occurs after Enter,
 * which indicates Claude processed the input.
 *
 * The PRIMARY defense is the stricter idle check in processQueue() which
 * prevents injecting during active output. This verification is secondary.
 *
 * @param {string} paneId - The pane ID
 * @param {HTMLElement} textarea - The textarea element (for focus operations)
 * @param {number} retriesLeft - Remaining retry attempts
 * @returns {Promise<boolean>} - Whether submit appears to have succeeded
 */
async function verifyAndRetryEnter(paneId, textarea, retriesLeft = MAX_ENTER_RETRIES) {
  // Record output time before Enter
  const outputTimeBefore = lastOutputTime[paneId] || 0;

  // Wait for Enter to be processed and potential output to start
  await new Promise(resolve => setTimeout(resolve, ENTER_VERIFY_DELAY_MS));

  // Check if there was output activity after Enter (indicates Claude processed input)
  const outputTimeAfter = lastOutputTime[paneId] || 0;
  const hadOutputActivity = outputTimeAfter > outputTimeBefore;

  if (hadOutputActivity) {
    log.info(`verifyAndRetryEnter ${paneId}`, 'Enter succeeded (output activity detected)');
    return true;
  }

  // No output yet - could be normal delay or Enter was ignored
  // Wait a bit longer and check for output
  if (retriesLeft <= 0) {
    log.warn(`verifyAndRetryEnter ${paneId}`, 'Max retries reached, no output activity detected after Enter');
    return false;
  }

  log.info(`verifyAndRetryEnter ${paneId}`, `No output activity yet, waiting for idle to retry Enter (${retriesLeft} retries left)`);

  // Wait for pane to be idle (if it's outputting, Enter might still be processing)
  const maxWaitTime = MAX_QUEUE_TIME_MS;
  const startWait = Date.now();

  while (!isIdle(paneId) && (Date.now() - startWait) < maxWaitTime) {
    await new Promise(resolve => setTimeout(resolve, ENTER_RETRY_INTERVAL_MS));
    // Check if output started during our wait
    if ((lastOutputTime[paneId] || 0) > outputTimeBefore) {
      log.info(`verifyAndRetryEnter ${paneId}`, 'Output started during wait, Enter succeeded');
      return true;
    }
  }

  // Still no output - retry Enter
  const currentPane = document.querySelector(`.pane[data-pane-id="${paneId}"]`);
  const currentTextarea = currentPane ? currentPane.querySelector('.xterm-helper-textarea') : null;

  if (!currentTextarea) {
    log.warn(`verifyAndRetryEnter ${paneId}`, 'textarea disappeared during wait');
    return false;
  }

  // Focus and retry Enter
  const focusOk = await focusWithRetry(currentTextarea);
  if (!focusOk) {
    log.warn(`verifyAndRetryEnter ${paneId}`, 'Focus failed on retry');
  }

  log.info(`verifyAndRetryEnter ${paneId}`, 'Retrying sendTrustedEnter');
  window.hivemind.pty.sendTrustedEnter();

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
      await navigator.clipboard.writeText(lastSelection);
      updatePaneStatus(paneId, 'Copied!');
      setTimeout(() => updatePaneStatus(paneId, statusMsg), 1000);
      lastSelection = '';
    } else {
      try {
        const text = await navigator.clipboard.readText();
        if (text) {
          window.hivemind.pty.write(paneId, text);
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
      try {
        const text = await navigator.clipboard.readText();
        if (text) {
          window.hivemind.pty.write(paneId, text);
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
    // FX4-v3: Track actual user typing (single chars, no modifiers)
    if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
      lastTypedTime[paneId] = Date.now();
    }

    // Allow synthetic Enter if it's from our programmatic send
    // Check for our marker on the event or terminal-level bypass flag
    if (event.key === 'Enter' && !event.isTrusted) {
      if (event._hivemindBypass || terminal._hivemindBypass) {
        log.info(`Terminal ${paneId}`, 'Allowing programmatic Enter (hivemind bypass)');
        return true;
      }
      log.info(`Terminal ${paneId}`, 'Blocked synthetic Enter (isTrusted=false)');
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
        window.hivemind.pty.write(paneId, data);
      });
    }

    window.hivemind.pty.onData(paneId, (data) => {
      terminal.write(data);
      // Track output time for idle detection
      lastOutputTime[paneId] = Date.now();
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
    // FX4-v3: Track actual user typing (single chars, no modifiers)
    if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
      lastTypedTime[paneId] = Date.now();
    }

    // Allow synthetic Enter if it's from our programmatic send
    if (event.key === 'Enter' && !event.isTrusted) {
      if (event._hivemindBypass || terminal._hivemindBypass) {
        log.info(`Terminal ${paneId}`, 'Allowing programmatic Enter (hivemind bypass)');
        return true;
      }
      log.info(`Terminal ${paneId}`, 'Blocked synthetic Enter (isTrusted=false)');
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
      window.hivemind.pty.write(paneId, data);
    });
  }

  window.hivemind.pty.onData(paneId, (data) => {
    terminal.write(data);
    // Track output time for idle detection
    lastOutputTime[paneId] = Date.now();
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
function doSendToPane(paneId, message, onComplete) {
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
    finish({ success: false, reason: 'timeout' });
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
    window.hivemind.pty.codexExec(id, prompt);
    updatePaneStatus(id, 'Working');
    lastTypedTime[paneId] = Date.now();
    lastOutputTime[paneId] = Date.now();
    finishWithClear({ success: true });
    return;
  }

  // CLAUDE PATH: Hybrid approach (PTY write for text + DOM keyboard for Enter)
  // PTY \r does NOT auto-submit in Claude Code's ink TUI (proven in Fix R)
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

  // Step 1: Focus terminal so sendTrustedEnter targets correct pane
  textarea.focus();

  // Step 2: Write text to PTY (without \r)
  window.hivemind.pty.write(id, text);
  log.info(`doSendToPane ${id}`, 'Claude pane: PTY write text');

  // Step 3: If message needs Enter, use sendTrustedEnter after adaptive delay
  if (hasTrailingEnter) {
    // Calculate delay based on pane activity (busy panes need more time)
    const enterDelay = getAdaptiveEnterDelay(id);
    log.info(`doSendToPane ${id}`, `Using adaptive Enter delay: ${enterDelay}ms`);

    setTimeout(async () => {
      // Re-query textarea in case DOM changed during delay
      const currentPane = document.querySelector(`.pane[data-pane-id="${id}"]`);
      textarea = currentPane ? currentPane.querySelector('.xterm-helper-textarea') : null;

      // Guard: Abort if textarea disappeared
      if (!textarea) {
        log.warn(`doSendToPane ${id}`, 'Claude pane: textarea disappeared before Enter, aborting');
        finishWithClear({ success: false, reason: 'textarea_disappeared' });
        return;
      }

      // Ensure focus with retry (handles race conditions)
      const focusOk = await focusWithRetry(textarea);
      if (!focusOk) {
        log.warn(`doSendToPane ${id}`, 'Claude pane: focus failed after retries, sending Enter anyway');
      }

      window.hivemind.pty.sendTrustedEnter();
      log.info(`doSendToPane ${id}`, 'Claude pane: sendTrustedEnter for submit');

      // Verify Enter succeeded (textarea empty) - if not, wait for idle and retry
      // This handles force-inject during active output where Enter is ignored
      const submitOk = await verifyAndRetryEnter(id, textarea);
      if (!submitOk) {
        log.warn(`doSendToPane ${id}`, 'Claude pane: Enter verification failed after retries');
      }

      // Step 4: Restore focus after injection complete
      if (savedFocus && savedFocus !== textarea) {
        try {
          savedFocus.focus();
        } catch (e) {
          // Element may no longer be in DOM
        }
      }
      lastTypedTime[paneId] = Date.now();
      finishWithClear({ success: submitOk });
    }, enterDelay);
  } else {
    // No Enter needed, just restore focus
    if (savedFocus && savedFocus !== textarea) {
      try {
        savedFocus.focus();
      } catch (e) {
        // Element may no longer be in DOM
      }
    }
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
    const result = await window.hivemind.claude.spawn(paneId);
    if (result.success && result.command) {
      // Use pty.write directly instead of terminal.paste for reliability
      // terminal.paste() can fail if terminal isn't fully ready
      window.hivemind.pty.write(String(paneId), result.command);
      // FX4-v5: Mark as typed so Enter isn't blocked
      lastTypedTime[paneId] = Date.now();
      // Small delay before sending Enter
      await new Promise(resolve => setTimeout(resolve, 100));
      window.hivemind.pty.write(String(paneId), '\r');

      // Codex CLI needs an extra Enter after startup to dismiss its welcome prompt
      // Claude Code CLI doesn't need this - it's ready immediately
      // NOTE: Codex sandbox_mode should be pre-configured via ~/.codex/config.toml
      // (sandbox_mode = "workspace-write") to skip the first-run sandbox prompt.
      // This PTY \r is a fallback to dismiss any residual prompt if config is missing.
      const isCodex = result.command.startsWith('codex');
      if (isCodex) {
        setTimeout(() => {
          window.hivemind.pty.write(String(paneId), '\r');
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

// Nudge a stuck pane - sends Enter to unstick Claude Code
// Uses Enter only (ESC sequences were interrupting active agents)
function nudgePane(paneId) {
  // FX4-v5: Mark as typed so our own Enter isn't blocked
  lastTypedTime[paneId] = Date.now();
  // Send Enter to prompt for new input
  window.hivemind.pty.write(String(paneId), '\r');
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
      window.hivemind.pty.write(id, '\r');

      if (isCodexPane(id)) {
        // Codex: PTY newline to submit (clipboard paste broken - Codex treats as image paste)
        window.hivemind.pty.write(id, '\r');
        log.info(`Terminal ${id}`, 'Aggressive nudge: PTY carriage return (Codex)');
      } else {
        window.hivemind.pty.sendTrustedEnter();
        log.info(`Terminal ${id}`, 'Aggressive nudge: trusted Enter dispatched (Claude)');
      }
    } else {
      // Fallback if textarea truly missing
      log.warn(`Terminal ${id}`, 'Aggressive nudge: no textarea, PTY fallback');
      window.hivemind.pty.write(id, '\r');
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
      return;
    }

    const syncMessage = `[HIVEMIND SYNC] Please read and acknowledge the following shared context:

---
${result.content}
---

Acknowledge receipt and summarize the key points.\r`;

    broadcast(syncMessage);
    updateConnectionStatus('Shared context synced to all panes');

  } catch (err) {
    updateConnectionStatus(`Sync error: ${err.message}`);
  }
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
  lastEnterTime,  // FX4-v2: Exported for daemon coordination
  lastTypedTime,  // FX4-v3: Track typing for Enter blocking
  lastOutputTime, // Track output for idle detection
  isIdle,         // Check if pane is idle
  registerCodexPane,   // CLI Identity: mark pane as Codex
  unregisterCodexPane, // CLI Identity: unmark pane as Codex
  isCodexPane,         // CLI Identity: query Codex status
  messageQueue,   // Message queue for busy panes
};
