/**
 * Terminal management module
 * Handles xterm instances, PTY connections, and terminal operations
 */

const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const { WebLinksAddon } = require('@xterm/addon-web-links');
const { WebglAddon } = require('@xterm/addon-webgl');
const { SearchAddon } = require('@xterm/addon-search');
const log = require('./logger');
const { createInjectionController } = require('./terminal/injection');
const { createRecoveryController } = require('./terminal/recovery');

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
const searchAddons = new Map();
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

// Codex exec mode: track identity injection per pane
const codexIdentityInjected = new Set();

// Per-pane input lock - panes locked by default (view-only), toggle to unlock for direct typing
// Prevents accidental typing in agent panes while allowing programmatic sends (sendToPane/triggers)
const inputLocked = {};
PANE_IDS.forEach(id => { inputLocked[id] = true; }); // Default: all panes locked

// Message queue for when pane is busy
// Format: { paneId: [{ message, timestamp }, ...] }
const messageQueue = {};
// Prevent overlapping PTY injections across panes (global focus/Enter mutex)
let injectionInFlight = false;
const getInjectionInFlight = () => injectionInFlight;
const setInjectionInFlight = (value) => { injectionInFlight = value; };

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

let injectionController = null;
const recoveryController = createRecoveryController({
  PANE_IDS,
  terminals,
  lastOutputTime,
  lastTypedTime,
  isCodexPane,
  updatePaneStatus,
  updateConnectionStatus,
  getSdkModeActive: () => sdkModeActive,
  getInjectionInFlight,
  userIsTyping,
  getInjectionHelpers: () => injectionController,
  spawnClaude,
});

injectionController = createInjectionController({
  terminals,
  lastOutputTime,
  lastTypedTime,
  messageQueue,
  isCodexPane,
  buildCodexExecPrompt,
  isIdle,
  isIdleForForceInject,
  userIsTyping,
  updatePaneStatus,
  markPotentiallyStuck: recoveryController.markPotentiallyStuck,
  getInjectionInFlight,
  setInjectionInFlight,
  constants: {
    ENTER_DELAY_IDLE_MS,
    ENTER_DELAY_ACTIVE_MS,
    ENTER_DELAY_BUSY_MS,
    PANE_ACTIVE_THRESHOLD_MS,
    PANE_BUSY_THRESHOLD_MS,
    FOCUS_RETRY_DELAY_MS,
    MAX_FOCUS_RETRIES,
    ENTER_VERIFY_DELAY_MS,
    MAX_ENTER_RETRIES,
    ENTER_RETRY_INTERVAL_MS,
    PROMPT_READY_TIMEOUT_MS,
    MAX_QUEUE_TIME_MS,
    EXTREME_WAIT_MS,
    ABSOLUTE_MAX_WAIT_MS,
    QUEUE_RETRY_MS,
    INJECTION_LOCK_TIMEOUT_MS,
  },
});

const {
  potentiallyStuckPanes,
  clearStuckStatus,
  startStuckMessageSweeper,
  stopStuckMessageSweeper,
  sweepStuckMessages,
  interruptPane,
  restartPane,
  unstickEscalation,
  nudgePane,
  nudgeAllPanes,
  sendUnstick,
  aggressiveNudge,
  aggressiveNudgeAll,
} = recoveryController;

function focusWithRetry(...args) {
  return injectionController.focusWithRetry(...args);
}

function sendEnterToPane(...args) {
  return injectionController.sendEnterToPane(...args);
}

function isPromptReady(...args) {
  return injectionController.isPromptReady(...args);
}

function verifyAndRetryEnter(...args) {
  return injectionController.verifyAndRetryEnter(...args);
}

function processQueue(...args) {
  return injectionController.processQueue(...args);
}

function doSendToPane(...args) {
  return injectionController.doSendToPane(...args);
}

function sendToPane(...args) {
  return injectionController.sendToPane(...args);
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
  const searchAddon = new SearchAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(webLinksAddon);
  terminal.loadAddon(searchAddon);
  searchAddons.set(paneId, searchAddon);

  // Load WebGL addon for GPU-accelerated rendering (with fallback)
  try {
    const webglAddon = new WebglAddon();
    webglAddon.onContextLoss(() => {
      log.warn(`Terminal ${paneId}`, 'WebGL context lost, falling back to canvas');
      webglAddon.dispose();
    });
    terminal.loadAddon(webglAddon);
    log.info(`Terminal ${paneId}`, 'WebGL renderer enabled');
  } catch (e) {
    log.warn(`Terminal ${paneId}`, `WebGL not available: ${e.message}`);
  }

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

    // Ctrl+F opens search for this terminal
    if (event.ctrlKey && event.key.toLowerCase() === 'f') {
      openTerminalSearch(paneId);
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
  const searchAddon = new SearchAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(webLinksAddon);
  terminal.loadAddon(searchAddon);
  searchAddons.set(paneId, searchAddon);

  // Load WebGL addon for GPU-accelerated rendering (with fallback)
  try {
    const webglAddon = new WebglAddon();
    webglAddon.onContextLoss(() => {
      log.warn(`Terminal ${paneId}`, 'WebGL context lost, falling back to canvas');
      webglAddon.dispose();
    });
    terminal.loadAddon(webglAddon);
    log.info(`Terminal ${paneId}`, 'WebGL renderer enabled');
  } catch (e) {
    log.warn(`Terminal ${paneId}`, `WebGL not available: ${e.message}`);
  }

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

    // Ctrl+F opens search for this terminal
    if (event.ctrlKey && event.key.toLowerCase() === 'f') {
      openTerminalSearch(paneId);
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
  searchAddons.set(paneId, searchAddon);

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

// Terminal search UI - opens a search bar for the focused pane
let activeSearchPane = null;
let searchBar = null;

function openTerminalSearch(paneId) {
  const searchAddon = searchAddons.get(paneId);
  if (!searchAddon) {
    log.warn(`Terminal ${paneId}`, 'Search addon not available');
    return;
  }

  // Create search bar if it doesn't exist
  if (!searchBar) {
    searchBar = document.createElement('div');
    searchBar.id = 'terminal-search-bar';
    searchBar.innerHTML = `
      <input type="text" id="terminal-search-input" placeholder="Search terminal (Enter=next, Shift+Enter=prev, Esc=close)">
      <span id="terminal-search-count"></span>
      <button id="terminal-search-prev" title="Previous (Shift+Enter)">▲</button>
      <button id="terminal-search-next" title="Next (Enter)">▼</button>
      <button id="terminal-search-close" title="Close (Esc)">✕</button>
    `;
    document.body.appendChild(searchBar);

    const input = document.getElementById('terminal-search-input');
    const prevBtn = document.getElementById('terminal-search-prev');
    const nextBtn = document.getElementById('terminal-search-next');
    const closeBtn = document.getElementById('terminal-search-close');

    input.addEventListener('input', () => {
      if (activeSearchPane) {
        const addon = searchAddons.get(activeSearchPane);
        if (addon && input.value) {
          addon.findNext(input.value);
        }
      }
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (activeSearchPane) {
          const addon = searchAddons.get(activeSearchPane);
          if (addon && input.value) {
            if (e.shiftKey) {
              addon.findPrevious(input.value);
            } else {
              addon.findNext(input.value);
            }
          }
        }
      } else if (e.key === 'Escape') {
        closeTerminalSearch();
      }
    });

    prevBtn.addEventListener('click', () => {
      if (activeSearchPane) {
        const addon = searchAddons.get(activeSearchPane);
        const input = document.getElementById('terminal-search-input');
        if (addon && input.value) {
          addon.findPrevious(input.value);
        }
      }
    });

    nextBtn.addEventListener('click', () => {
      if (activeSearchPane) {
        const addon = searchAddons.get(activeSearchPane);
        const input = document.getElementById('terminal-search-input');
        if (addon && input.value) {
          addon.findNext(input.value);
        }
      }
    });

    closeBtn.addEventListener('click', closeTerminalSearch);
  }

  activeSearchPane = paneId;
  searchBar.style.display = 'flex';
  searchBar.dataset.paneId = paneId;

  const input = document.getElementById('terminal-search-input');
  input.value = '';
  input.focus();

  log.info(`Terminal ${paneId}`, 'Search opened');
}

function closeTerminalSearch() {
  if (searchBar) {
    searchBar.style.display = 'none';
  }
  if (activeSearchPane) {
    const addon = searchAddons.get(activeSearchPane);
    if (addon) {
      addon.clearDecorations();
    }
    // Return focus to terminal
    const terminal = terminals.get(activeSearchPane);
    if (terminal) {
      terminal.focus();
    }
    activeSearchPane = null;
  }
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
  // Terminal search (Ctrl+F)
  searchAddons,        // Search addon instances
  openTerminalSearch,  // Open search bar for pane
  closeTerminalSearch, // Close search bar
};
