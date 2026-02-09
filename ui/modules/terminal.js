/**
 * Terminal management module
 * Handles xterm instances, PTY connections, and terminal operations
 */

const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const { WebLinksAddon } = require('@xterm/addon-web-links');
const { WebglAddon } = require('@xterm/addon-webgl');
const { SearchAddon } = require('@xterm/addon-search');
const fs = require('fs');
const path = require('path');
const log = require('./logger');
const settings = require('./settings');
const { createInjectionController } = require('./terminal/injection');
const { createRecoveryController } = require('./terminal/recovery');
const { attachAgentColors } = require('./terminal/agent-colors');
const { PANE_IDS, PANE_ROLES, WORKSPACE_PATH } = require('../config');
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
  STARTUP_IDENTITY_DELAY_CODEX_MS,
  STARTUP_READY_BUFFER_MAX,
  GEMINI_ENTER_DELAY_MS,
} = require('./constants');

// CLI identity tracking (dynamic)
// Updated by renderer's pane-cli-identity handler (calls register/unregister)
const paneCliIdentity = new Map();

// Note: PANE_IDS and PANE_ROLES imported from config.js (canonical source)

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
const codexIdentityTimeouts = new Map();

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
const terminalWatermarks = new Map(); // paneId -> number (bytes in flight)
const terminalPaused = new Map(); // paneId -> boolean (is PTY paused)

const HIGH_WATERMARK = 500000; // 500KB - pause producer
const LOW_WATERMARK = 50000;   // 50KB - resume producer

/**
 * Reset terminal write queue state for a pane.
 * Must be called when terminal is killed/restarted to prevent frozen state.
 * @param {string} paneId - The pane ID
 */
function resetTerminalWriteQueue(paneId) {
  const id = String(paneId);
  terminalWriteQueues.delete(id);
  terminalWriting.delete(id);
  terminalWatermarks.set(id, 0);
  terminalPaused.set(id, false);
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
  // Initialize state for this pane if needed
  if (!terminalWriteQueues.has(paneId)) {
    terminalWriteQueues.set(paneId, []);
    terminalWriting.set(paneId, false);
    terminalWatermarks.set(paneId, 0);
    terminalPaused.set(paneId, false);
  }

  // Update watermark (bytes in flight to xterm)
  const currentWatermark = (terminalWatermarks.get(paneId) || 0) + data.length;
  terminalWatermarks.set(paneId, currentWatermark);

  // If watermark exceeds high threshold, pause the PTY producer
  if (currentWatermark > HIGH_WATERMARK && !terminalPaused.get(paneId)) {
    if (window.hivemind?.pty?.pause) {
      window.hivemind.pty.pause(paneId);
      terminalPaused.set(paneId, true);
      log.info(`Terminal ${paneId}`, `High watermark reached (${currentWatermark} bytes) - PTY paused`);
    }
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

    // Update watermark
    const oldWatermark = terminalWatermarks.get(paneId) || 0;
    const newWatermark = Math.max(0, oldWatermark - data.length);
    terminalWatermarks.set(paneId, newWatermark);

    // If watermark drops below low threshold, resume the PTY producer
    if (newWatermark < LOW_WATERMARK && terminalPaused.get(paneId)) {
      if (window.hivemind?.pty?.resume) {
        window.hivemind.pty.resume(paneId);
        terminalPaused.set(paneId, false);
        log.info(`Terminal ${paneId}`, `Low watermark reached (${newWatermark} bytes) - PTY resumed`);
      }
    }

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

const SPINNER_CHARS = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const ACTIVITY_OSC_REGEX = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;
const ACTIVITY_CSI_REGEX = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * Strip ANSI escape codes from string (OSC + CSI + charset sequences)
 */
function stripAnsi(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(ACTIVITY_OSC_REGEX, '')
    .replace(ACTIVITY_CSI_REGEX, '')
    .replace(/\u001b[\(\)][A-Za-z0-9]/g, '');
}

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

// Non-timing constants that stay here
const MAX_FOCUS_RETRIES = 3;          // Max focus retry attempts before giving up
const MAX_ENTER_RETRIES = 5;          // Max Enter retry attempts if text remains
const STARTUP_OSC_REGEX = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;
const STARTUP_CSI_REGEX = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const STARTUP_READY_PATTERNS = [
  /(^|\n)>\s*(\n|$)/m,
  /how can i help/i,
];

// Terminal theme configuration — Cyberpunk
const TERMINAL_THEME = {
  background: '#0a0a0f',
  foreground: '#e8eaf0',
  cursor: '#00f0ff',
  cursorAccent: '#0a0a0f',
  selection: 'rgba(0, 240, 255, 0.25)',
  black: '#0a0a0f',
  red: '#ff2040',
  green: '#00e676',
  yellow: '#f0a000',
  blue: '#3a7bff',
  magenta: '#bb86fc',
  cyan: '#00f0ff',
  white: '#e8eaf0',
};

// Terminal options
const TERMINAL_OPTIONS = {
  theme: TERMINAL_THEME,
  fontFamily: "'Consolas', 'Monaco', 'Courier New', monospace",
  fontSize: 13,
  cursorBlink: true,
  cursorStyle: 'block',
  scrollback: 2000,
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
  const id = String(paneId);
  codexIdentityInjected.delete(id);
  const timeoutId = codexIdentityTimeouts.get(id);
  if (timeoutId) {
    clearTimeout(timeoutId);
    codexIdentityTimeouts.delete(id);
  }
  log.info('Terminal', `Reset codex identity tracking for pane ${paneId}`);
}

// Check if a pane is idle (no output for INJECTION_IDLE_THRESHOLD_MS)
function isIdle(paneId) {
  const lastOutput = lastOutputTime[paneId] || 0;
  return (Date.now() - lastOutput) >= INJECTION_IDLE_THRESHOLD_MS;
}

// Shorter idle check for force-inject scenario
// Requires 500ms of silence - long enough for Enter to not be ignored,
// but shorter than full 1s idle threshold so messages don't queue forever
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

  // Session 69 fix: Gemini needs longer delay - CLI takes longer to initialize input handling
  const identityDelayMs = state.isGemini ? 1000 : STARTUP_IDENTITY_DELAY_MS;

  setTimeout(async () => {
    // Session 69: Gemini identity - match doSendToPane pattern exactly
    // Previous attempt failed because it was missing Ctrl+U clear
    if (state.isGemini) {
      try {
        // Step 1: Clear any garbage in input line (matches doSendToPane Gemini path)
        await window.hivemind.pty.write(String(paneId), '\x15');
        log.info('spawnAgent', `Gemini identity: cleared input line for ${role} (pane ${paneId})`);

        // Step 2: Write the identity text
        await window.hivemind.pty.write(String(paneId), identityMsg);
        log.info('spawnAgent', `Gemini identity text written for ${role} (pane ${paneId})`);

        // Step 3: Wait 200ms then send Enter (Gemini's bufferFastReturn threshold = 30ms, 200ms = ~7x margin)
        await new Promise(resolve => setTimeout(resolve, 200));
        await window.hivemind.pty.write(String(paneId), '\r');
        log.info('spawnAgent', `Gemini identity Enter sent for ${role} (pane ${paneId}) [ready:${reason}]`);
      } catch (err) {
        log.error('spawnAgent', `Gemini identity injection failed for pane ${paneId}:`, err);
      }
    } else {
      sendToPane(paneId, identityMsg + '\r');
      log.info('spawnAgent', `Identity injected for ${role} (pane ${paneId}) [ready:${reason}]`);
    }
  }, identityDelayMs);

  // Startup context injection disabled: CLI tools load context natively.
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

  // Gemini CLI takes 8-12s to start (github.com/google-gemini/gemini-cli/issues/4544)
  // Use 15s timeout for Gemini so CLI is fully ready before injection
  const timeoutMs = state.isGemini ? 15000 : STARTUP_READY_TIMEOUT_MS;

  state.timeoutId = setTimeout(() => {
    const current = startupInjectionState.get(id);
    if (!current || current.completed) return;
    log.warn('spawnAgent', `Startup ready pattern not detected for pane ${id} after ${timeoutMs}ms, injecting anyway`);
    triggerStartupInjection(id, current, 'timeout');
  }, timeoutMs);

  startupInjectionState.set(id, state);
  log.info('spawnAgent', `Startup injection armed for pane ${id} (model=${state.modelType})`);
}

function handleStartupOutput(paneId, data) {
  const state = startupInjectionState.get(String(paneId));
  if (!state || state.completed) return;

  const cleaned = stripAnsiForStartup(data);
  if (cleaned) {
    state.buffer = (state.buffer + cleaned).slice(-STARTUP_READY_BUFFER_MAX);
  }

  // Gemini CLI takes 8-12s to start and its prompt is easily confused with shell prompt.
  // We ONLY trust patternReady (e.g. "how can i help" or a clean "> ") or timeout for Gemini.
  const promptReady = state.isGemini ? false : isPromptReady(paneId);
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

const INTENT_DIR = path.join(WORKSPACE_PATH, 'intent');
const SESSION_HANDOFF_PATH = path.join(WORKSPACE_PATH, 'session-handoff.json');

function getSessionNumber() {
  try {
    const data = JSON.parse(fs.readFileSync(SESSION_HANDOFF_PATH, 'utf8'));
    return data?.session ?? null;
  } catch {
    return null;
  }
}

function updateIntentFile(paneId, intent) {
  const id = String(paneId);
  const filePath = path.join(INTENT_DIR, `${id}.json`);
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {}
  const session = data.session ?? getSessionNumber();
  const role = data.role || PANE_ROLES[id] || `Pane ${id}`;
  const next = {
    ...data,
    pane: id,
    role,
    session,
    intent,
    last_update: new Date().toISOString(),
  };
  try {
    fs.mkdirSync(INTENT_DIR, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(next, null, 2), 'utf8');
  } catch (err) {
    log.warn('Intent', `Failed to update intent file for pane ${id}`, err);
  }
}

function toggleInputLock(paneId) {
  inputLocked[paneId] = !inputLocked[paneId];
  const lockIcon = document.getElementById(`lock-icon-${paneId}`);
  if (lockIcon) {
    lockIcon.innerHTML = inputLocked[paneId] ? LOCK_ICON_SVG : UNLOCK_ICON_SVG;
    lockIcon.dataset.tooltip = inputLocked[paneId] ? 'Locked (click to toggle)' : 'Unlocked (click to toggle)';
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
    lockIcon.dataset.tooltip = locked ? 'Locked (click to toggle)' : 'Unlocked (click to toggle)';
    lockIcon.classList.toggle('unlocked', !locked);
  }
  log.info(`Terminal ${paneId}`, `Input ${locked ? 'locked' : 'unlocked'}`);
}

let injectionController = null;
const ignoreExitUntil = new Map();

function markIgnoreNextExit(paneId, timeoutMs = 15000) {
  const id = String(paneId);
  ignoreExitUntil.set(id, Date.now() + timeoutMs);
  log.info('Terminal', `Exit ignore window armed for pane ${id} (${timeoutMs}ms)`);
}

function shouldIgnoreExit(paneId) {
  const id = String(paneId);
  const until = ignoreExitUntil.get(id);
  if (!until) return false;
  if (Date.now() > until) {
    ignoreExitUntil.delete(id);
    return false;
  }
  return true;
}

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
  spawnAgent,
  resetCodexIdentity,
  resetTerminalWriteQueue,
  markIgnoreNextExit,
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
    TYPING_GUARD_MS,
    GEMINI_ENTER_DELAY_MS,
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
      if (terminals.has(paneId)) continue;
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
    if (terminals.has(paneId)) return;
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
  attachAgentColors(paneId, terminal);

  // Sync PTY size to fitted terminal dimensions (PTY spawns at 80x24 by default)
  try {
    window.hivemind.pty.resize(paneId, terminal.cols, terminal.rows);
  } catch (err) {
    log.warn(`Terminal ${paneId}`, 'Initial PTY resize failed (PTY may not exist yet):', err);
  }

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

    // Now that PTY exists, sync size again (initial resize may have fired before PTY was created)
    try {
      fitAddon.fit();
      window.hivemind.pty.resize(paneId, terminal.cols, terminal.rows);
      log.info(`Terminal ${paneId}`, `PTY size synced: ${terminal.cols}x${terminal.rows}`);
    } catch (resizeErr) {
      log.warn(`Terminal ${paneId}`, 'Post-create PTY resize failed:', resizeErr);
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
      // Track output time for idle detection - only for meaningful activity
      // This ensures spinners/ANSI don't block programmatic injections
      if (isMeaningfulActivity(data)) {
        lastOutputTime[paneId] = Date.now();
      }
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
      if (shouldIgnoreExit(paneId)) {
        log.info('Terminal', `Ignoring exit for pane ${paneId} (restart in progress)`);
        return;
      }
      updatePaneStatus(paneId, `Exited (${code})`);
      queueTerminalWrite(paneId, terminal, `\r\n[Process exited with code ${code}]\r\n`);
      clearStartupInjection(paneId);
      updateIntentFile(paneId, 'Offline');
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
  attachAgentColors(paneId, terminal);

  // Sync PTY size to fitted terminal dimensions (PTY already exists during reattach)
  try {
    window.hivemind.pty.resize(paneId, terminal.cols, terminal.rows);
    log.info(`Terminal ${paneId}`, `Reattach PTY size synced: ${terminal.cols}x${terminal.rows}`);
  } catch (err) {
    log.warn(`Terminal ${paneId}`, 'Reattach PTY resize failed:', err);
  }

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
    // Track output time for idle detection - only for meaningful activity
    // This ensures spinners/ANSI don't block programmatic injections
    if (isMeaningfulActivity(data)) {
      lastOutputTime[paneId] = Date.now();
    }
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
      if (shouldIgnoreExit(paneId)) {
        log.info('Terminal', `Ignoring exit for pane ${paneId} (restart in progress)`);
        return;
      }
      updatePaneStatus(paneId, `Exited (${code})`);
      queueTerminalWrite(paneId, terminal, `\r\n[Process exited with code ${code}]\r\n`);
      clearStartupInjection(paneId);
      updateIntentFile(paneId, 'Offline');
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
// User messages get PRIORITY - they jump to front of queue ahead of agent messages
function broadcast(message) {
  // Send directly to Architect (pane 1), no broadcast prefix needed
  // priority: true ensures user message bypasses queued agent messages
  sendToPane('1', message, { priority: true });
  updateConnectionStatus('Message sent to Architect');
}

// Set SDK mode - blocks PTY spawn operations when enabled
function setSDKMode(enabled) {
  sdkModeActive = enabled;
  log.info('Terminal', `SDK mode ${enabled ? 'enabled' : 'disabled'} - PTY spawn operations ${enabled ? 'blocked' : 'allowed'}`);
}

// Spawn agent CLI in a pane
// model param: optional override for model type (used by model switch to bypass stale cache)
async function spawnAgent(paneId, model = null) {
  // Defense in depth: Early exit if no terminal exists for this pane
  // This catches race conditions where SDK mode blocks terminal creation but
  // user somehow triggers spawn before UI fully updates
  if (!terminals.has(paneId)) {
    log.info('spawnAgent', `No terminal for pane ${paneId}, skipping`);
    return;
  }

  // SDK Mode Guard: Don't spawn CLI Claude when SDK mode is active
  if (sdkModeActive) {
    log.info('spawnAgent', `SDK mode active - blocking CLI spawn for pane ${paneId}`);
    return;
  }

  updateIntentFile(paneId, 'Initializing session...');

  // Clear cached CLI identity when model is explicitly specified (model switch)
  // This ensures we don't use stale identity data
  if (model) {
    unregisterCodexPane(paneId);
    log.info('spawnAgent', `Cleared CLI identity cache for pane ${paneId} (model switch to ${model})`);
  }

  // Determine if this is a Codex pane
  // If model is explicitly passed (from model switch), use it directly
  // Otherwise fall back to checking settings/identity cache
  const isCodex = model ? model === 'codex' : isCodexPane(String(paneId));

  // Codex exec mode: non-interactive request/response
  if (isCodex) {
    updatePaneStatus(paneId, 'Starting Codex...');
    // We don't write the 'codex' command to the terminal because the daemon 
    // uses a virtual terminal (no PTY) for codex-exec mode.
    // Identity injection will happen via codex-exec IPC in the timeout below.
    log.info('spawnAgent', `Codex pane ${paneId} ready (codex-exec mode)`);

    // Send identity message after Codex starts (delayed to ensure Architect goes first)
    resetCodexIdentity(paneId);
    const timeoutId = setTimeout(() => {
      const role = PANE_ROLES[paneId] || `Pane ${paneId}`;
      const timestamp = new Date().toISOString().split('T')[0];
      const identityMsg = `# HIVEMIND SESSION: ${role} - Started ${timestamp}`;
      sendToPane(paneId, identityMsg + '\r');
      log.info('spawnAgent', `Codex exec identity sent for ${role} (pane ${paneId})`);
      codexIdentityTimeouts.delete(String(paneId));
    }, STARTUP_IDENTITY_DELAY_CODEX_MS);
    codexIdentityTimeouts.set(String(paneId), timeoutId);

    // Startup context injection disabled: Codex loads context natively.

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
      log.error(`spawnAgent ${paneId}`, 'Spawn failed:', err);
      updatePaneStatus(paneId, 'Spawn failed');
      return;
    }
    if (result.success && result.command) {
      // Use pty.write directly instead of terminal.paste for reliability
      // terminal.paste() can fail if terminal isn't fully ready
      try {
        await window.hivemind.pty.write(String(paneId), result.command);
      } catch (err) {
        log.error(`spawnAgent ${paneId}`, 'PTY write command failed:', err);
      }
      // Mark as typed so Enter isn't blocked
      lastTypedTime[paneId] = Date.now();
      // Small delay before sending Enter
      await new Promise(resolve => setTimeout(resolve, 100));
      try {
        await window.hivemind.pty.write(String(paneId), '\r');
      } catch (err) {
        log.error(`spawnAgent ${paneId}`, 'PTY write Enter failed:', err);
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
            log.error(`spawnAgent ${paneId}`, 'Codex startup Enter failed:', err);
          });
          log.info('spawnAgent', `Codex pane ${paneId}: PTY \\r to dismiss any startup prompt`);
        }, 3000);
      }

      // ID-1 + Finding #14: Wait for CLI ready prompt before identity/context injection
      // This avoids injecting while subscription prompts are blocking input.
      const isGemini = model ? model === 'gemini' : isGeminiPane(paneId);
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

// Spawn agents in all panes
async function spawnAllAgents() {
  updateConnectionStatus('Starting agents in all panes...');
  for (const paneId of PANE_IDS) {
    await spawnAgent(paneId);
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
    await spawnAgent(paneId);
  }

  updateConnectionStatus('Fresh start complete - new sessions started');
}

// Handle window resize — prioritize focused pane, defer background panes
let deferredResizeTimer = null;

function handleResize() {
  const focused = focusedPane;
  const hasFocusedTerminal = focused && fitAddons.has(focused);

  // If no focused pane (or focused pane has no terminal), resize all synchronously
  if (!hasFocusedTerminal) {
    for (const [paneId] of fitAddons) {
      resizeSinglePane(paneId);
    }
    return;
  }

  // Resize focused pane immediately for responsiveness
  resizeSinglePane(focused);

  // Defer background panes to avoid 3x synchronous fit+IPC
  if (deferredResizeTimer) {
    clearTimeout(deferredResizeTimer);
  }
  deferredResizeTimer = setTimeout(() => {
    deferredResizeTimer = null;
    for (const [paneId] of fitAddons) {
      if (paneId !== focused) {
        resizeSinglePane(paneId);
      }
    }
  }, 200);
}

function resizeSinglePane(paneId) {
  const fitAddon = fitAddons.get(paneId);
  if (!fitAddon) return;
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
  spawnAgent,
  spawnAllAgents,
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




