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
const settings = require('./settings');
const { createInjectionController } = require('./terminal/injection');
const { createRecoveryController } = require('./terminal/recovery');
const {
  TYPING_GUARD_MS,
  INJECTION_IDLE_THRESHOLD_MS,
  MAX_QUEUE_TIME_MS,
  FORCE_INJECT_IDLE_MS,
  EXTREME_WAIT_MS,
  ABSOLUTE_MAX_WAIT_MS,
  QUEUE_RETRY_MS,
  BROADCAST_STAGGER_MS,
  INJECTION_LOCK_TIMEOUT_MS,
  ENTER_DELAY_IDLE_MS,
  ENTER_DELAY_ACTIVE_MS,
  ENTER_DELAY_BUSY_MS,
  PANE_ACTIVE_THRESHOLD_MS,
  PANE_BUSY_THRESHOLD_MS,
  FOCUS_RETRY_DELAY_MS,
  ENTER_VERIFY_DELAY_MS,
  ENTER_RETRY_INTERVAL_MS,
  PROMPT_READY_TIMEOUT_MS,
  STARTUP_READY_TIMEOUT_MS,
  STARTUP_IDENTITY_DELAY_MS,
  STARTUP_CONTEXT_DELAY_ARCHITECT_MS,
  STARTUP_CONTEXT_DELAY_MS,
  STARTUP_IDENTITY_DELAY_CODEX_MS,
  STARTUP_CONTEXT_DELAY_CODEX_MS,
  STARTUP_READY_BUFFER_MAX,
} = require('./constants');

// Pane configuration
const PANE_IDS = ['1', '2', '3', '4', '5', '6'];

// CLI identity tracking (dynamic)
// Updated by renderer's pane-cli-identity handler (calls register/unregister)
const paneCliIdentity = new Map();

// ID-1: Pane roles for identity injection (makes /resume sessions identifiable)
const PANE_ROLES = {
  '1': 'Architect',
  '2': 'Infra',
  '3': 'Frontend',
  '4': 'Backend',
  '5': 'Analyst',
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

// Startup injection readiness tracking (per pane)
const startupInjectionState = new Map();

// Terminal write flow control - prevents xterm buffer overflow
// When PTY sends data faster than xterm can render, writes get discarded
// This queue ensures writes complete before sending more data
const terminalWriteQueues = new Map(); // paneId -> [data chunks]
const terminalWriting = new Map(); // paneId -> boolean (write in progress)

/**
 * Reset terminal write queue state for a pane.
 * Must be called when terminal is killed/restarted to prevent frozen state.
 * @param {string} paneId - The pane ID
 */
function resetTerminalWriteQueue(paneId) {
  const id = String(paneId);
  terminalWriteQueues.delete(id);
  terminalWriting.delete(id);
}

/**
 * Write data to terminal with flow control.
 * Queues writes and processes them one at a time, waiting for xterm's
 * callback before sending more data. Prevents "write data discarded" errors.
 * @param {string} paneId - The pane ID
 * @param {Terminal} terminal - The xterm Terminal instance
 * @param {string} data - Data to write
 */
function queueTerminalWrite(paneId, terminal, data) {
  // Initialize queue for this pane if needed
  if (!terminalWriteQueues.has(paneId)) {
    terminalWriteQueues.set(paneId, []);
    terminalWriting.set(paneId, false);
  }

  // Add data to queue
  terminalWriteQueues.get(paneId).push(data);

  // Start processing if not already writing
  flushTerminalQueue(paneId, terminal);
}

/**
 * Process terminal write queue with flow control.
 * Writes one chunk at a time, waiting for xterm callback before next write.
 * @param {string} paneId - The pane ID
 * @param {Terminal} terminal - The xterm Terminal instance
 */
function flushTerminalQueue(paneId, terminal) {
  // Don't start if already writing
  if (terminalWriting.get(paneId)) {
    return;
  }

  const queue = terminalWriteQueues.get(paneId);
  if (!queue || queue.length === 0) {
    return;
  }

  // Mark as writing
  terminalWriting.set(paneId, true);

  // Get next chunk
  const data = queue.shift();

  // Write with callback - xterm calls this when write is processed
  terminal.write(data, () => {
    // Write complete, allow next write
    terminalWriting.set(paneId, false);

    // Process next chunk if any
    if (queue.length > 0) {
      flushTerminalQueue(paneId, terminal);
    }
  });
}

// Global UI focus tracker - survives staggered multi-pane sends.
// Updated by focusin listener on UI inputs; doSendToPane restores to this.
let lastUserUIFocus = null;

// Track when user last typed in a UI input (not xterm).
// doSendToPane defers injection while user is actively typing.
let lastUserUIKeypressTime = 0;
// Timing constants imported from constants.js

// Non-timing constants that stay here
const MAX_FOCUS_RETRIES = 3;          // Max focus retry attempts before giving up
const MAX_ENTER_RETRIES = 5;          // Max Enter retry attempts if text remains
const STARTUP_OSC_REGEX = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;
const STARTUP_CSI_REGEX = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const STARTUP_READY_PATTERNS = [
  /(^|\n)>\s*(\n|$)/m,
  /how can i help/i,
];

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
    const settingsObj = settings.getSettings();
    const paneCommands = settingsObj?.paneCommands || {};
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

// Reset codex identity injection tracking for a pane (used on restart)
// This ensures the identity header is re-injected when the pane restarts
function resetCodexIdentity(paneId) {
  codexIdentityInjected.delete(String(paneId));
  log.info('Terminal', `Reset codex identity tracking for pane ${paneId}`);
}

// Check if a pane is idle (no output for INJECTION_IDLE_THRESHOLD_MS)
function isIdle(paneId) {
  const lastOutput = lastOutputTime[paneId] || 0;
  return (Date.now() - lastOutput) >= INJECTION_IDLE_THRESHOLD_MS;
}

// Shorter idle check for force-inject scenario
// Requires 500ms of silence - long enough for Enter to not be ignored,
// but shorter than full 2s idle so messages don't queue forever
function isIdleForForceInject(paneId) {
  const lastOutput = lastOutputTime[paneId] || 0;
  return (Date.now() - lastOutput) >= FORCE_INJECT_IDLE_MS;
}

function stripAnsiForStartup(input) {
  return String(input || '')
    .replace(STARTUP_OSC_REGEX, '')
    .replace(STARTUP_CSI_REGEX, '')
    .replace(/\u001b[\(\)][A-Za-z0-9]/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/\r/g, '\n');
}

function clearStartupInjection(paneId) {
  const state = startupInjectionState.get(String(paneId));
  if (!state) return;
  if (state.timeoutId) {
    clearTimeout(state.timeoutId);
  }
  startupInjectionState.delete(String(paneId));
}

function triggerStartupInjection(paneId, state, reason) {
  if (!state || state.completed) return;
  state.completed = true;
  if (state.timeoutId) {
    clearTimeout(state.timeoutId);
  }
  startupInjectionState.delete(String(paneId));

  const role = PANE_ROLES[paneId] || `Pane ${paneId}`;
  const timestamp = new Date().toISOString().split('T')[0];
  const identityMsg = `# HIVEMIND SESSION: ${role} - Started ${timestamp}`;

  setTimeout(() => {
    sendToPane(paneId, identityMsg + '\r');
    log.info('spawnClaude', `Identity injected for ${role} (pane ${paneId}) [ready:${reason}]`);
  }, STARTUP_IDENTITY_DELAY_MS);

  if (!state.isGemini && window.hivemind?.claude?.injectContext) {
    const contextDelayMs = String(paneId) === '1' ? STARTUP_CONTEXT_DELAY_ARCHITECT_MS : STARTUP_CONTEXT_DELAY_MS;
    window.hivemind.claude.injectContext(paneId, state.modelType, contextDelayMs);
    log.info('spawnClaude', `Context injection scheduled for ${state.modelType} pane ${paneId} in ${contextDelayMs}ms [ready:${reason}]`);
  }
}

function armStartupInjection(paneId, options = {}) {
  const id = String(paneId);
  clearStartupInjection(id);
  const state = {
    buffer: '',
    completed: false,
    modelType: options.modelType || 'claude',
    isGemini: Boolean(options.isGemini),
    timeoutId: null,
  };

  state.timeoutId = setTimeout(() => {
    const current = startupInjectionState.get(id);
    if (!current || current.completed) return;
    log.warn('spawnClaude', `Startup ready pattern not detected for pane ${id} after ${STARTUP_READY_TIMEOUT_MS}ms, injecting anyway`);
    triggerStartupInjection(id, current, 'timeout');
  }, STARTUP_READY_TIMEOUT_MS);

  startupInjectionState.set(id, state);
  log.info('spawnClaude', `Startup injection armed for pane ${id} (model=${state.modelType})`);
}

function handleStartupOutput(paneId, data) {
  const state = startupInjectionState.get(String(paneId));
  if (!state || state.completed) return;

  const cleaned = stripAnsiForStartup(data);
  if (cleaned) {
    state.buffer = (state.buffer + cleaned).slice(-STARTUP_READY_BUFFER_MAX);
  }

  const promptReady = isPromptReady(paneId);
  const patternReady = STARTUP_READY_PATTERNS.some((pattern) => pattern.test(state.buffer));
  if (promptReady || patternReady) {
    triggerStartupInjection(paneId, state, promptReady ? 'prompt' : 'pattern');
  }
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
// SVG icons for lock states (Feather/Lucide style)
const LOCK_ICON_SVG = '<svg class="pane-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
const UNLOCK_ICON_SVG = '<svg class="pane-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>';

function toggleInputLock(paneId) {
  inputLocked[paneId] = !inputLocked[paneId];
  const lockIcon = document.getElementById(`lock-icon-${paneId}`);
  if (lockIcon) {
    lockIcon.innerHTML = inputLocked[paneId] ? LOCK_ICON_SVG : UNLOCK_ICON_SVG;
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
    lockIcon.innerHTML = locked ? LOCK_ICON_SVG : UNLOCK_ICON_SVG;
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
  resetCodexIdentity,
  resetTerminalWriteQueue,
});

injectionController = createInjectionController({
  terminals,
  lastOutputTime,
  lastTypedTime,
  messageQueue,
  isCodexPane,
  isGeminiPane,
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

function processIdleQueue(...args) {
  return injectionController.processIdleQueue(...args);
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
  // Track selection - clear when empty to fix stale selection bug
  let lastSelection = '';
  terminal.onSelectionChange(() => {
    // FIX: Always update, including clearing when selection is empty
    lastSelection = terminal.getSelection() || '';
  });

  container.addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    e.stopPropagation();

    // FIX: Check hasSelection() at click time, not stale lastSelection variable
    // This ensures we detect current selection state, not old cached value
    const currentSelection = terminal.hasSelection() ? terminal.getSelection() : '';

    if (currentSelection) {
      // COPY: There's an active selection
      try {
        await navigator.clipboard.writeText(currentSelection);
        updatePaneStatus(paneId, 'Copied!');
        log.info('Clipboard', `Copied ${currentSelection.length} chars from pane ${paneId}`);
        setTimeout(() => updatePaneStatus(paneId, statusMsg), 1000);
      } catch (err) {
        log.error('Clipboard', 'Copy failed (permission denied?):', err);
        updatePaneStatus(paneId, 'Copy failed');
        setTimeout(() => updatePaneStatus(paneId, statusMsg), 1000);
      }
      // Clear selection after copy
      terminal.clearSelection();
      lastSelection = '';
    } else {
      // PASTE: No selection, so paste from clipboard
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
          log.info('Clipboard', `Pasted ${text.length} chars to pane ${paneId}`);
          setTimeout(() => updatePaneStatus(paneId, statusMsg), 1000);
        } else {
          updatePaneStatus(paneId, 'Clipboard empty');
          setTimeout(() => updatePaneStatus(paneId, statusMsg), 1000);
        }
      } catch (err) {
        log.error('Paste', 'Paste failed:', err);
        updatePaneStatus(paneId, 'Paste failed');
        setTimeout(() => updatePaneStatus(paneId, statusMsg), 1000);
      }
    }
  });

  // Ctrl+C: Copy selection (if any)
  container.addEventListener('keydown', async (e) => {
    if (e.ctrlKey && e.key === 'c' && terminal.hasSelection()) {
      // Don't prevent default - let xterm handle Ctrl+C for interrupt when no selection
      const selection = terminal.getSelection();
      if (selection) {
        try {
          await navigator.clipboard.writeText(selection);
          updatePaneStatus(paneId, 'Copied!');
          setTimeout(() => updatePaneStatus(paneId, statusMsg), 1000);
        } catch (err) {
          log.error('Clipboard', 'Ctrl+C copy failed:', err);
        }
      }
    }

    // Ctrl+V: Paste
    if (e.ctrlKey && e.key === 'v') {
      e.preventDefault();
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
        log.error('Paste', 'Ctrl+V paste failed:', err);
        updatePaneStatus(paneId, 'Paste failed');
        setTimeout(() => updatePaneStatus(paneId, statusMsg), 1000);
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
      // Use flow control to prevent xterm buffer overflow
      queueTerminalWrite(paneId, terminal, data);
      // Track output time for idle detection
      lastOutputTime[paneId] = Date.now();
      // Clear stuck status - output means pane is working
      clearStuckStatus(paneId);
      handleStartupOutput(paneId, data);
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
      queueTerminalWrite(paneId, terminal, `\r\n[Process exited with code ${code}]\r\n`);
      clearStartupInjection(paneId);
    });

  } catch (err) {
    log.error(`Terminal ${paneId}`, 'Failed to create PTY', err);
    updatePaneStatus(paneId, 'Error');
    queueTerminalWrite(paneId, terminal, `\r\n[Error: ${err.message}]\r\n`);
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
    queueTerminalWrite(paneId, terminal, scrollback);
  }

  if (!isCodexPane(paneId)) {
    terminal.onData((data) => {
      window.hivemind.pty.write(paneId, data).catch(err => {
        log.error(`Terminal ${paneId}`, 'PTY write failed:', err);
      });
    });
  }

  window.hivemind.pty.onData(paneId, (data) => {
    // Use flow control to prevent xterm buffer overflow
    queueTerminalWrite(paneId, terminal, data);
    // Track output time for idle detection
    lastOutputTime[paneId] = Date.now();
    // Clear stuck status - output means pane is working
    clearStuckStatus(paneId);
    handleStartupOutput(paneId, data);
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
    queueTerminalWrite(paneId, terminal, `\r\n[Process exited with code ${code}]\r\n`);
    clearStartupInjection(paneId);
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
// model param: optional override for model type (used by model switch to bypass stale cache)
async function spawnClaude(paneId, model = null) {
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

  // Clear cached CLI identity when model is explicitly specified (model switch)
  // This ensures we don't use stale identity data
  if (model) {
    unregisterCodexPane(paneId);
    log.info('spawnClaude', `Cleared CLI identity cache for pane ${paneId} (model switch to ${model})`);
  }

  // Determine if this is a Codex pane
  // If model is explicitly passed (from model switch), use it directly
  // Otherwise fall back to checking settings/identity cache
  const isCodex = model ? model === 'codex' : isCodexPane(String(paneId));

  // Codex exec mode: spawn codex command then send identity prompt
  if (isCodex) {
    updatePaneStatus(paneId, 'Starting Codex...');
    // Spawn codex command (needed after model switch when terminal is at shell prompt)
    try {
      const result = await window.hivemind.claude.spawn(paneId);
      if (result.success && result.command) {
        await window.hivemind.pty.write(String(paneId), result.command);
        lastTypedTime[paneId] = Date.now();
        await new Promise(resolve => setTimeout(resolve, 100));
        await window.hivemind.pty.write(String(paneId), '\r');
        log.info('spawnClaude', `Codex command written for pane ${paneId}`);
      }
    } catch (err) {
      log.error(`spawnClaude ${paneId}`, 'Codex spawn failed:', err);
      updatePaneStatus(paneId, 'Spawn failed');
      return;
    }
    // Send identity message after Codex starts (delayed to ensure Architect goes first)
    setTimeout(() => {
      const role = PANE_ROLES[paneId] || `Pane ${paneId}`;
      const timestamp = new Date().toISOString().split('T')[0];
      const identityMsg = `# HIVEMIND SESSION: ${role} - Started ${timestamp}`;
      sendToPane(paneId, identityMsg + '\r');
      log.info('spawnClaude', `Codex exec identity sent for ${role} (pane ${paneId})`);
    }, STARTUP_IDENTITY_DELAY_CODEX_MS);

    // Finding #14: Inject context files (AGENTS.md for Codex) after startup
    if (window.hivemind?.claude?.injectContext) {
      window.hivemind.claude.injectContext(paneId, 'codex', STARTUP_CONTEXT_DELAY_CODEX_MS);
      log.info('spawnClaude', `Context injection scheduled for Codex pane ${paneId}`);
    }

    updatePaneStatus(paneId, 'Codex exec ready');
    return;
  }

  const terminal = terminals.get(paneId);
  if (terminal) {
    updatePaneStatus(paneId, 'Starting...');
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
      const isCodexCommand = result.command.startsWith('codex');
      if (isCodexCommand) {
        setTimeout(() => {
          window.hivemind.pty.write(String(paneId), '\r').catch(err => {
            log.error(`spawnClaude ${paneId}`, 'Codex startup Enter failed:', err);
          });
          log.info('spawnClaude', `Codex pane ${paneId}: PTY \\r to dismiss any startup prompt`);
        }, 3000);
      }

      // ID-1 + Finding #14: Wait for CLI ready prompt before identity/context injection
      // This avoids injecting while subscription prompts are blocking input.
      const isGemini = isGeminiPane(paneId);
      const modelType = isGemini ? 'gemini' : 'claude';
      armStartupInjection(paneId, { modelType, isGemini });

    }
    updatePaneStatus(paneId, 'Working');
  }
}

// Helper to check if a pane is Gemini
function isGeminiPane(paneId) {
  try {
    const settingsObj = settings.getSettings();
    const paneCommands = settingsObj?.paneCommands || {};
    const cmd = paneCommands[String(paneId)] || '';
    return typeof cmd === 'string' && cmd.toLowerCase().includes('gemini');
  } catch {
    return false;
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
      // Reset write queue state to prevent frozen pane on next spawn
      resetTerminalWriteQueue(paneId);
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
    '� Kill all 6 terminals\n' +
    '� Start new agent sessions with NO previous context\n\n' +
    'All current conversations will be lost.\n\n' +
    'Continue?'
  );

  if (!confirmed) {
    updateConnectionStatus('Fresh start cancelled');
    return;
  }

  updateConnectionStatus('Fresh start: killing all terminals...');

  // Kill all terminals and reset identity tracking
  for (const paneId of PANE_IDS) {
    try {
      await window.hivemind.pty.kill(paneId);
      // Reset codex identity tracking so new session gets identity header
      resetCodexIdentity(paneId);
      // Reset write queue state to prevent frozen pane on next spawn
      resetTerminalWriteQueue(paneId);
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
      <button id="terminal-search-prev" title="Previous (Shift+Enter)">?</button>
      <button id="terminal-search-next" title="Next (Enter)">?</button>
      <button id="terminal-search-close" title="Close (Esc)">?</button>
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
  resetTerminalWriteQueue, // Reset write queue on pane restart/kill
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




