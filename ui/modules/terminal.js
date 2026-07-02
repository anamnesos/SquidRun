/**
 * Terminal management module
 * Handles xterm instances, PTY connections, and terminal operations
 */

const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const fs = require('fs');
const path = require('path');
const log = require('./logger');
const bus = require('./event-bus');
const { stripAnsi: stripAnsiCodes } = require('./ansi');
const settings = require('./settings');
const compactionDetector = require('./compaction-detector');
const contracts = require('./contracts');
const contractPromotion = require('./contract-promotion');
const transitionLedger = require('./transition-ledger');
const { invokeBridge } = require('./renderer-bridge');
const { createInjectionController } = require('./terminal/injection');
const { createRecoveryController } = require('./terminal/recovery');
const { getRuntimeInjectionCapabilityDefault } = require('./terminal/injection-capabilities');
const { readStartupBriefingForInjection } = require('./startup-ai-briefing');
const { isTrustQuotePaneId } = require('./work-room-terminal-visibility');
const {
  extractClaudeSessionIdFromCommand,
  isClaudeSessionInUseError,
} = require('./cli-resume-invocation');

const TERMINAL_EVENT_SOURCE = 'terminal.js';
const SQUID_ROOM_WINDOW_KEY = 'squid-room';
const SQUID_ROOM_MIRRORED_TEAM_PANE_IDS = new Set(['2', '3']);
const SQUID_ROOM_STARTUP_SHARED_PANE_IDS = new Set(['1', '2', '3']);
const STARTUP_INJECTION_CLAIM_CHANNEL = 'startup-injection-claim';
const STARTUP_INJECTION_RELEASE_CHANNEL = 'startup-injection-release';
const { attachAgentColors } = require('./terminal/agent-colors');
const {
  PANE_IDS,
  PANE_ROLES,
  WORKSPACE_PATH,
  resolveCoordPath,
  getPaneDisplayName,
} = require('../config');
const {
  TYPING_GUARD_MS,
  QUEUE_RETRY_MS,
  INJECTION_LOCK_TIMEOUT_MS,
  FOCUS_RETRY_DELAY_MS,
  STARTUP_READY_TIMEOUT_MS,
  STARTUP_IDENTITY_DELAY_MS,
  STARTUP_IDENTITY_VERIFY_DELAY_MS,
  STARTUP_IDENTITY_RETRY_DELAY_MS,
  STARTUP_IDENTITY_MAX_ATTEMPTS,
  CODEX_ENTER_DELAY_MS,
  STARTUP_READY_BUFFER_MAX,
  GEMINI_ENTER_DELAY_MS,
  SUBMIT_ACCEPT_MAX_ATTEMPTS,
} = require('./constants');

// CLI identity tracking (dynamic)
// Updated by renderer's pane-cli-identity handler (calls register/unregister)
const paneCliIdentity = new Map();

// Note: PANE_IDS and PANE_ROLES imported from config.js (canonical source)

// Track if we reconnected to existing terminals
let reconnectedToExisting = false;

// Terminal instances
const terminals = new Map();
const fitAddons = new Map();
const searchAddons = new Map();
const webglAddons = new Map();
const agentColorDisposers = new Map();
const ptyDataListenerDisposers = new Map();
const ptyExitListenerDisposers = new Map();
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
const terminalInputBridgeDisposables = new Map();
const pendingClaudeSessionCollisionRecovery = new Map();
const paneRuntimeOverrides = new Map();

// Per-pane input lock - panes locked by default (view-only), toggle to unlock for direct typing
// Prevents accidental typing in agent panes while allowing programmatic sends (sendToPane/triggers)
const inputLocked = {};
PANE_IDS.forEach(id => { inputLocked[id] = true; }); // Default: all panes locked
let activePaneIds = [...PANE_IDS];
const FRESH_SPAWN_INIT_TIMEOUT_MS = 10000;
const IS_DARWIN = process.platform === 'darwin';
const FRESH_STARTUP_INJECTION_WINDOW_MS = 60000;
const HIDDEN_PANE_HOSTS_ENV_FLAG = (
  typeof process !== 'undefined'
  && process
  && process.env
  && process.env.SQUIDRUN_HIDDEN_PANE_HOSTS === '1'
);

// Per-pane typing idle timers for event bus typing.idle emission
const typingIdleTimers = {};

// Message queue for when pane is busy
// Format: { paneId: [{ message, timestamp }, ...] }
const messageQueue = {};
// Prevent overlapping PTY injections across panes (global focus/Enter mutex)
let injectionInFlight = false;
const getInjectionInFlight = () => injectionInFlight;
const setInjectionInFlight = (value) => { injectionInFlight = value; };

// Startup injection readiness tracking (per pane)
const startupInjectionState = new Map();
const intentStateByPane = new Map();
let startupWindowContext = {
  loaded: false,
  windowKey: 'main',
  windowTeam: 'main',
  profileName: 'main',
  profileLabel: 'Main',
  sessionScopeId: '',
  startupBundlePath: '',
  startupBundleReady: false,
};

// Terminal write flow control - prevents xterm buffer overflow
// When PTY sends data faster than xterm can render, writes get discarded
// This queue ensures writes complete before sending more data
const terminalWriteQueues = new Map(); // paneId -> [data chunks]
const terminalWriting = new Map(); // paneId -> boolean (write in progress)
const terminalWatermarks = new Map(); // paneId -> number (bytes in flight)
const terminalPaused = new Map(); // paneId -> boolean (is PTY paused)
const terminalWriteFlushTimers = new Map(); // paneId -> timer ID
const terminalWriteFrameBudgets = new Map(); // paneId -> { startedAt, bytes, chunks }
const terminalPaintRefreshTimers = new Map(); // `${paneId}:${delayMs}` -> timer ID
const terminalStreamingFitTimers = new Map(); // paneId -> timer ID
const terminalStreamingLastFitAt = new Map(); // paneId -> timestamp
const terminalSettleRedrawTimers = new Map(); // paneId -> timer ID (post-burst settle redraw)
const terminalSettleRedrawFirstReqAt = new Map(); // paneId -> timestamp of first settle request in burst
const terminalSettleRedrawLastAt = new Map(); // paneId -> timestamp of last applied settle redraw
const terminalLastWriteAt = new Map(); // paneId -> timestamp of last PTY chunk that mutated the frame

const HIGH_WATERMARK = 500000; // 500KB - pause producer
const LOW_WATERMARK = 50000;   // 50KB - resume producer
const TERMINAL_QUEUE_MAX_BYTES = 2 * 1024 * 1024; // 2MB absolute per-pane queue cap
const TERMINAL_WRITE_FRAME_BYTE_BUDGET = 64 * 1024;
const TERMINAL_WRITE_FRAME_CHUNK_BUDGET = 8;
const TERMINAL_WRITE_FRAME_TIME_BUDGET_MS = 8;
const TERMINAL_WRITE_FRAME_YIELD_MS = 16;
const TERMINAL_STREAMING_FIT_MIN_INTERVAL_MS = 350;
const TERMINAL_STREAMING_FIT_SETTLE_MS = 160;
// Bug A: post-burst settle redraw. Fires once after streaming output goes quiet
// (DEBOUNCE), or at least once per MAX_DEFER during sustained streaming, but never
// more often than MIN_INTERVAL — keeping forced PTY re-pokes at <=~0.9/sec so the
// steady_state_event_rates proof (RESIZE_STEADY_STATE_LIMIT_PER_SEC=1) stays green.
const TERMINAL_SETTLE_REDRAW_DEBOUNCE_MS = 200;
const TERMINAL_SETTLE_REDRAW_MAX_DEFER_MS = 1200;
const TERMINAL_SETTLE_REDRAW_MIN_INTERVAL_MS = 1100;
// Delay between the forced re-poke and the paint-outcome sample. Gives the PTY/agent
// time to emit its redraw so the frame-signature delta reflects an actual repaint.
const TERMINAL_SETTLE_REDRAW_PAINT_SAMPLE_MS = 140;
// Auto-follow is position-based: a viewport within this many rows of the bottom
// counts as "at bottom" and resumes auto-scroll; scrolled further up preserves
// the user's position. Tolerance (not strict equality) absorbs the 1-frame lag
// where a just-written line bumps baseY before the viewport auto-follows.
const TERMINAL_AT_BOTTOM_EPSILON_ROWS = 2;
const TERMINAL_SCROLL_FALLBACK_DELAY_MS = 24;
const TERMINAL_WHEEL_PIXEL_LINE = 40;
const TERMINAL_SCROLL_PROBE_TARGET_PROPERTY = '__squidrunTerminalScrollProbeTarget';
const PROMOTION_CHECK_INTERVAL_MS = 30 * 60 * 1000;

// WebGL rendering: disabled by default to reduce memory usage.
// 3 terminals with WebGL contexts + texture atlases can consume 500MB+ with heavy output.
// Enable via settings.json: { "terminalWebGL": true }
// Lazy-evaluated at first terminal creation (settings may not be loaded at module init)
let _webglEnabled = null;
let _webLinksAddonCtor = null;
let _webglAddonCtor = null;
let _searchAddonCtor = null;
function isWebGLEnabled() {
  if (_webglEnabled === null) {
    try {
      const s = settings.getSettings();
      _webglEnabled = s && s.terminalWebGL === true;
    } catch {
      _webglEnabled = false;
    }
  }
  return _webglEnabled;
}

function getWebLinksAddonCtor() {
  if (!_webLinksAddonCtor) {
    ({ WebLinksAddon: _webLinksAddonCtor } = require('@xterm/addon-web-links'));
  }
  return _webLinksAddonCtor;
}

function getWebglAddonCtor() {
  if (!_webglAddonCtor) {
    ({ WebglAddon: _webglAddonCtor } = require('@xterm/addon-webgl'));
  }
  return _webglAddonCtor;
}

function getSearchAddonCtor() {
  if (!_searchAddonCtor) {
    ({ SearchAddon: _searchAddonCtor } = require('@xterm/addon-search'));
  }
  return _searchAddonCtor;
}
let promotionCheckTimer = null;

// AbortControllers for DOM listener cleanup (memory leak prevention)
// Module-level controller for document listeners in initUIFocusTracker
let uiFocusTrackerAbortController = null;
// Per-pane controllers for container listeners (setupCopyPaste + click)
const paneListenerAbortControllers = new Map();

function isHiddenPaneHostModeEnabled() {
  if (HIDDEN_PANE_HOSTS_ENV_FLAG) return true;
  try {
    return settings.getSettings()?.hiddenPaneHostsEnabled === true;
  } catch {
    return false;
  }
}

function isHiddenPaneHostPane(paneId) {
  const id = String(paneId || '');
  if (!id) return false;
  return isHiddenPaneHostModeEnabled() && PANE_IDS.includes(id);
}

function getActivePaneIds() {
  return activePaneIds.slice();
}

function setActivePaneIds(paneIds = null) {
  const nextIds = Array.isArray(paneIds)
    ? paneIds.map((paneId) => String(paneId || '').trim()).filter(Boolean)
    : [];
  activePaneIds = nextIds.length > 0 ? Array.from(new Set(nextIds)) : [...PANE_IDS];
  for (const paneId of activePaneIds) {
    if (!Object.prototype.hasOwnProperty.call(inputLocked, paneId)) {
      inputLocked[paneId] = true;
    }
  }
  return getActivePaneIds();
}

function getPaneRuntimeOverride(paneId) {
  const id = String(paneId || '').trim();
  if (!id) return {};
  const override = paneRuntimeOverrides.get(id);
  return override ? { ...override } : {};
}

function setPaneRuntimeOverride(paneId, override = {}) {
  const id = String(paneId || '').trim();
  if (!id || !override || typeof override !== 'object') return getPaneRuntimeOverride(id);
  const next = {
    ...getPaneRuntimeOverride(id),
    ...override,
  };
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined || value === null || value === '') {
      delete next[key];
    }
  }
  paneRuntimeOverrides.set(id, next);
  if (!Object.prototype.hasOwnProperty.call(inputLocked, id)) {
    inputLocked[id] = true;
  }
  if (next.provider || next.label) {
    registerPaneCliIdentity(id, {
      provider: next.provider,
      label: next.label || next.provider,
    });
  }
  return getPaneRuntimeOverride(id);
}

function clearPaneRuntimeOverride(paneId) {
  const id = String(paneId || '').trim();
  if (!id) return false;
  return paneRuntimeOverrides.delete(id);
}

function isPaneReadOnlyMirrorMode(paneId) {
  const id = String(paneId || '');
  if (!id) return false;
  return isHiddenPaneHostPane(id) && inputLocked[id] === true;
}

function maybeResumePtyProducer(paneId, watermark) {
  if (!rendererOwnsPtyGeometry(paneId)) {
    if (terminalPaused.get(paneId)) {
      terminalPaused.set(paneId, false);
    }
    return;
  }
  if (watermark < LOW_WATERMARK && terminalPaused.get(paneId)) {
    if (window.squidrun?.pty?.resume) {
      window.squidrun.pty.resume(paneId);
      terminalPaused.set(paneId, false);
      log.info(`Terminal ${paneId}`, `Low watermark reached (${watermark} bytes) - PTY resumed`);
    }
  }
}

function getTerminalWriteNow() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function clearTerminalWriteFlushTimer(paneId) {
  const id = String(paneId);
  const timer = terminalWriteFlushTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    terminalWriteFlushTimers.delete(id);
  }
}

function scheduleTerminalQueueFlush(paneId, terminal, delayMs = 0) {
  const id = String(paneId);
  if (terminalWriteFlushTimers.has(id)) return;
  const timer = setTimeout(() => {
    terminalWriteFlushTimers.delete(id);
    flushTerminalQueue(id, terminal);
  }, Math.max(0, Number(delayMs) || 0));
  terminalWriteFlushTimers.set(id, timer);
}

function recordTerminalWriteFrame(paneId, byteLen) {
  const id = String(paneId);
  const now = getTerminalWriteNow();
  let frame = terminalWriteFrameBudgets.get(id);
  if (!frame || (now - frame.startedAt) > TERMINAL_WRITE_FRAME_YIELD_MS) {
    frame = { startedAt: now, bytes: 0, chunks: 0 };
    terminalWriteFrameBudgets.set(id, frame);
  }

  frame.bytes += Math.max(0, Number(byteLen) || 0);
  frame.chunks += 1;

  const shouldYield = frame.bytes >= TERMINAL_WRITE_FRAME_BYTE_BUDGET
    || frame.chunks >= TERMINAL_WRITE_FRAME_CHUNK_BUDGET
    || (now - frame.startedAt) >= TERMINAL_WRITE_FRAME_TIME_BUDGET_MS;
  if (shouldYield) {
    terminalWriteFrameBudgets.delete(id);
    return TERMINAL_WRITE_FRAME_YIELD_MS;
  }
  return 0;
}

/**
 * Reset terminal write queue state for a pane.
 * Must be called when terminal is killed/restarted to prevent frozen state.
 * @param {string} paneId - The pane ID
 */
function resetTerminalWriteQueue(paneId) {
  const id = String(paneId);
  clearTerminalWriteFlushTimer(id);
  clearTerminalStreamingFit(id);
  clearTerminalSettleRedraw(id);
  terminalWriteQueues.delete(id);
  terminalWriting.delete(id);
  terminalWatermarks.set(id, 0);
  terminalPaused.set(id, false);
  terminalWriteFrameBudgets.delete(id);
}

function clearTerminalPaintRefresh(paneId) {
  const id = String(paneId);
  for (const [key, timer] of terminalPaintRefreshTimers.entries()) {
    if (key === id || key.startsWith(`${id}:`)) {
      clearTimeout(timer);
      terminalPaintRefreshTimers.delete(key);
    }
  }
}

function clearTerminalStreamingFit(paneId) {
  const id = String(paneId);
  const timer = terminalStreamingFitTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    terminalStreamingFitTimers.delete(id);
  }
}

function getTerminalScrollbackInfo(terminal) {
  const activeBuffer = terminal?.buffer?.active || {};
  const baseY = Math.max(0, Number(activeBuffer.baseY) || 0);
  const viewportY = Math.max(0, Number(activeBuffer.viewportY) || 0);
  const cursorY = Math.max(0, Number(activeBuffer.cursorY) || 0);
  const rows = Math.max(0, Number(terminal?.rows) || 0);
  const length = Math.max(0, Number(activeBuffer.length) || 0);
  const populatedRows = length || (baseY + cursorY + 1);
  return {
    baseY,
    viewportY,
    cursorY,
    rows,
    length,
    scrollbackRows: Math.max(0, populatedRows - rows),
  };
}

function terminalHasScrollableScrollback(terminal) {
  const info = getTerminalScrollbackInfo(terminal);
  return info.scrollbackRows > 0 || info.baseY > 0;
}

function getTerminalViewportY(terminal) {
  return getTerminalScrollbackInfo(terminal).viewportY;
}

// Guards that a wheel/keyboard event is a real scroll on scrollable content.
// Its return value drives focus + wheel-fallback scheduling; it no longer marks
// any time window — auto-follow authority is purely viewport position now.
function markTerminalUserScroll(paneId, terminal, event = {}) {
  if (!terminalHasScrollableScrollback(terminal)) return false;
  const deltaY = Number(event.deltaY);
  if (Number.isFinite(deltaY) && deltaY === 0) return false;
  return true;
}

function normalizeTerminalWheelScrollLines(event = {}, terminal = {}) {
  const deltaY = Number(event.deltaY);
  if (!Number.isFinite(deltaY) || deltaY === 0) return 0;

  const rows = Math.max(1, Number(terminal?.rows) || 1);
  const deltaMode = Number(event.deltaMode) || 0;
  let rawLines;
  if (deltaMode === 1) {
    rawLines = deltaY;
  } else if (deltaMode === 2) {
    rawLines = deltaY * rows;
  } else {
    rawLines = deltaY / TERMINAL_WHEEL_PIXEL_LINE;
  }

  const direction = rawLines < 0 ? -1 : 1;
  const lineCount = Math.max(1, Math.ceil(Math.abs(rawLines)));
  return direction * Math.min(rows, lineCount);
}

function applyTerminalScrollLines(paneId, terminal, lines) {
  const id = String(paneId);
  const amount = Number(lines);
  if (!terminalHasScrollableScrollback(terminal) || !Number.isFinite(amount) || amount === 0) {
    return false;
  }
  if (typeof terminal?.scrollLines !== 'function') {
    return false;
  }
  terminal.scrollLines(amount);
  markTerminalUserScroll(id, terminal, { deltaY: amount });
  return true;
}

function scheduleTerminalScrollFallback(paneId, terminal, beforeViewportY, lines, delayMs = TERMINAL_SCROLL_FALLBACK_DELAY_MS) {
  const id = String(paneId);
  const amount = Number(lines);
  if (!id || !terminal || !Number.isFinite(amount) || amount === 0) return false;
  if (typeof terminal.scrollLines !== 'function') return false;

  setTimeout(() => {
    if (terminals.get(id) !== terminal) return;
    if (getTerminalViewportY(terminal) !== beforeViewportY) return;
    applyTerminalScrollLines(id, terminal, amount);
  }, Math.max(0, Number(delayMs) || 0));
  return true;
}

function handleTerminalWheelScrollIntent(paneId, terminal, event = {}) {
  if (!markTerminalUserScroll(paneId, terminal, event)) return false;

  if (typeof terminal?.focus === 'function') {
    try {
      terminal.focus();
    } catch (_) {}
  }

  const lines = normalizeTerminalWheelScrollLines(event, terminal);
  if (lines === 0) return false;
  return scheduleTerminalScrollFallback(paneId, terminal, getTerminalViewportY(terminal), lines);
}

function getTerminalKeyboardScrollLines(event = {}, terminal = {}) {
  if (event?.ctrlKey || event?.metaKey || event?.altKey) return 0;
  const key = String(event?.key || '');
  const rows = Math.max(1, Number(terminal?.rows) || 1);
  if (key === 'PageUp') return -rows;
  if (key === 'PageDown') return rows;
  return 0;
}

function handleTerminalKeyboardScroll(paneId, terminal, event = {}) {
  const lines = getTerminalKeyboardScrollLines(event, terminal);
  if (lines === 0) return false;
  if (!applyTerminalScrollLines(paneId, terminal, lines)) return false;
  if (typeof event.preventDefault === 'function') event.preventDefault();
  if (typeof event.stopPropagation === 'function') event.stopPropagation();
  return true;
}

// Viewport position is the SINGLE authority for auto-follow (no time window):
// preserve the user's scroll whenever the viewport sits more than a small bottom
// tolerance above baseY. At/near the bottom, auto-follow resumes.
//
// The tolerance is load-bearing, not cosmetic: when the user is following at the
// bottom and an agent line lands, baseY increments the instant the line is
// written but the viewport hasn't auto-followed yet, so for that frame
// viewportY < baseY. A strict `viewportY < baseY` predicate would read that as
// "scrolled up" and suppress the follow, sticking one line short mid-stream (the
// opposite-but-equal bug). The tolerance absorbs that transient lag; a genuine
// user scroll-up is always many rows (a wheel notch is ~3 lines, PageUp a full
// page), so real scroll-backs are well outside it.
function shouldPreserveTerminalUserScroll(paneId, terminal = null) {
  if (!terminal || !terminalHasScrollableScrollback(terminal)) return false;
  const { baseY, viewportY } = getTerminalScrollbackInfo(terminal);
  return (baseY - viewportY) > TERMINAL_AT_BOTTOM_EPSILON_ROWS;
}

function refreshTerminalViewport(paneId, terminal, fitAddon = null, options = {}) {
  const id = String(paneId);
  if (!terminal) return;
  const operation = options.operation || 'paint_refresh';

  if (!rendererOwnsPtyGeometry(id)) {
    emitPtyGeometrySkipped(id, 'secondary_squid_room_mirror_geometry_blocked', {
      operation,
    });
  } else {
    try {
      if (fitAddon && typeof fitAddon.fit === 'function') {
        if (options.forceFit === true || terminalContainerChangedSinceLastApply(id)) {
          fitTerminalForPane(id, fitAddon, operation);
        } else {
          emitTerminalResizeSkipped(id, 'paint_refresh_container_unchanged', {
            operation,
          });
        }
      }
    } catch (err) {
      log.warn(`Terminal ${id}`, `Paint refresh fit failed: ${err?.message || err}`);
    }

    try {
      applyTerminalPtyResize(id, terminal, { operation, forceApply: options.forceApply === true });
    } catch (err) {
      log.warn(`Terminal ${id}`, `Paint refresh resize failed: ${err?.message || err}`);
    }
  }

  try {
    if (typeof terminal.refresh === 'function') {
      const lastRow = Math.max(0, (Number(terminal.rows) || 1) - 1);
      terminal.refresh(0, lastRow);
    }
  } catch (err) {
    log.warn(`Terminal ${id}`, `Paint refresh failed: ${err?.message || err}`);
  }

  try {
    if (
      options.scrollToBottom !== false
      && !shouldPreserveTerminalUserScroll(id, terminal)
      && typeof terminal.scrollToBottom === 'function'
    ) {
      terminal.scrollToBottom();
    }
  } catch (err) {
    log.warn(`Terminal ${id}`, `Paint refresh scroll failed: ${err?.message || err}`);
  }
}

function scheduleTerminalPaintRefresh(paneId, terminal, fitAddon = null, delayMs = 0, options = {}) {
  const id = String(paneId);
  if (!id || !terminal) return;
  const delay = Math.max(0, Number(delayMs) || 0);
  const key = `${id}:${delay}:${options.operation || 'paint_refresh'}:${options.forceFit === true ? 'force' : 'normal'}`;
  const existingTimer = terminalPaintRefreshTimers.get(key);
  if (existingTimer) clearTimeout(existingTimer);

  const timer = setTimeout(() => {
    terminalPaintRefreshTimers.delete(key);
    if (terminals.get(id) !== terminal) return;
    refreshTerminalViewport(id, terminal, fitAddon || fitAddons.get(id), options);
  }, delay);
  terminalPaintRefreshTimers.set(key, timer);
}

function scheduleStreamingViewportFit(paneId, terminal, fitAddon = null) {
  const id = String(paneId);
  if (!id || !terminal || !rendererOwnsPtyGeometry(id)) return;
  clearTerminalStreamingFit(id);
  const now = Date.now();
  const lastFitAt = Number(terminalStreamingLastFitAt.get(id)) || 0;
  const elapsed = Math.max(0, now - lastFitAt);
  const delay = elapsed >= TERMINAL_STREAMING_FIT_MIN_INTERVAL_MS
    ? 0
    : Math.min(TERMINAL_STREAMING_FIT_SETTLE_MS, TERMINAL_STREAMING_FIT_MIN_INTERVAL_MS - elapsed);

  const timer = setTimeout(() => {
    terminalStreamingFitTimers.delete(id);
    if (terminals.get(id) !== terminal) return;
    terminalStreamingLastFitAt.set(id, Date.now());
    refreshTerminalViewport(id, terminal, fitAddon || fitAddons.get(id), {
      operation: 'streaming_viewport_sync',
      forceFit: true,
    });
  }, delay);
  terminalStreamingFitTimers.set(id, timer);
}

function clearTerminalSettleRedraw(paneId) {
  const id = String(paneId);
  const timer = terminalSettleRedrawTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    terminalSettleRedrawTimers.delete(id);
  }
  terminalSettleRedrawFirstReqAt.delete(id);
}

// Cheap FNV-1a hash of the visible viewport rows. Used as a paint-outcome signature:
// if the signature changes across the forced re-poke, the agent TUI actually redrew.
function captureTerminalFrameSignature(terminal) {
  const active = terminal?.buffer?.active;
  if (!active || typeof active.getLine !== 'function') return null;
  const rows = Math.max(0, Number(terminal?.rows) || 0);
  const baseY = Math.max(0, Number(active.baseY) || 0);
  let hash = 0x811c9dc5;
  let chars = 0;
  for (let i = 0; i < rows; i += 1) {
    const line = active.getLine(baseY + i);
    const text = line && typeof line.translateToString === 'function'
      ? line.translateToString(true)
      : '';
    for (let j = 0; j < text.length; j += 1) {
      hash ^= text.charCodeAt(j);
      hash = Math.imul(hash, 0x01000193);
    }
    hash ^= 0x0a; // row separator so row boundaries affect the signature
    hash = Math.imul(hash, 0x01000193);
    chars += text.length;
  }
  return `${(hash >>> 0).toString(16)}:${rows}:${chars}`;
}

function captureTerminalFitCoherence(paneId, terminal, fitAddon) {
  const id = String(paneId);
  const xtermCols = Math.trunc(Number(terminal?.cols)) || null;
  const xtermRows = Math.trunc(Number(terminal?.rows)) || null;
  let proposedCols = null;
  let proposedRows = null;
  try {
    if (fitAddon && typeof fitAddon.proposeDimensions === 'function') {
      const proposed = fitAddon.proposeDimensions();
      if (proposed) {
        proposedCols = Math.trunc(Number(proposed.cols)) || null;
        proposedRows = Math.trunc(Number(proposed.rows)) || null;
      }
    }
  } catch {
    // proposeDimensions can throw if the container is detached; leave as null.
  }
  const applied = terminalAppliedPtyGeometries.get(id) || null;
  const appliedCols = applied ? Math.trunc(Number(applied.cols)) || null : null;
  const appliedRows = applied ? Math.trunc(Number(applied.rows)) || null : null;
  const proposedCoherent = proposedCols == null || proposedRows == null
    ? true
    : (proposedCols === xtermCols && proposedRows === xtermRows);
  const appliedCoherent = appliedCols == null || appliedRows == null
    ? true
    : (appliedCols === xtermCols && appliedRows === xtermRows);
  return {
    xtermCols,
    xtermRows,
    proposedCols,
    proposedRows,
    appliedCols,
    appliedRows,
    coherent: Boolean(xtermCols && xtermRows && proposedCoherent && appliedCoherent),
  };
}

function emitTerminalFitTelemetry(payload) {
  try {
    const record = window?.squidrun?.pty?.recordFitTelemetry;
    if (typeof record === 'function') {
      const result = record(payload);
      // The main-process handler only exists after a full restart; on a renderer-only
      // reload it is absent and ipc.invoke rejects. Swallow it — telemetry is best-effort.
      if (result && typeof result.then === 'function') {
        result.catch(() => {});
      }
    }
  } catch (err) {
    log.warn(`Terminal ${payload?.paneId}`, `Fit telemetry emit failed: ${err?.message || err}`);
  }
}

// Bug A corrective: after a streaming burst, force ONE real re-poke (forceFit +
// forceApply) so applyTerminalPtyResize calls pty.resize even when geometry is
// unchanged — mirroring what a manual window resize does (PTY resize -> TUI redraw),
// which is the only thing that clears the persisted deformation. Captures a paint-
// outcome signature before/after so the proof can tell whether ConPTY actually
// repainted (X) vs needing an xterm-side recompute (Y).
function performSettleRedraw(paneId, terminal, fitAddon) {
  const id = String(paneId);
  if (terminals.get(id) !== terminal || !rendererOwnsPtyGeometry(id)) return;
  const resolvedFit = fitAddon || fitAddons.get(id);
  const rePokeTs = Date.now();
  // painted is only attributable to the re-poke when the streaming burst had already
  // gone quiet BEFORE the re-poke. On the MAX_DEFER path the settle fires mid-stream,
  // so concurrent writes would flip painted=true regardless of the re-poke (false-X).
  // We gate on PRE-re-poke quiescence rather than "no write in the after-window",
  // because a genuine redraw IS delivered as a write in that after-window — excluding
  // it would make painted=true impossible and the proof unable to ever confirm X.
  const lastWriteAt = Number(terminalLastWriteAt.get(id)) || 0;
  const quietSettle = (rePokeTs - lastWriteAt) >= TERMINAL_SETTLE_REDRAW_DEBOUNCE_MS;
  const beforeSignature = captureTerminalFrameSignature(terminal);

  refreshTerminalViewport(id, terminal, resolvedFit, {
    operation: 'settle_redraw',
    forceFit: true,
    forceApply: true,
  });

  const coherence = captureTerminalFitCoherence(id, terminal, resolvedFit);
  terminalSettleRedrawLastAt.set(id, rePokeTs);

  setTimeout(() => {
    if (terminals.get(id) !== terminal) return;
    const afterSignature = captureTerminalFrameSignature(terminal);
    emitTerminalFitTelemetry({
      paneId: id,
      operation: 'settle_redraw',
      ts: Date.now(),
      ...coherence,
      quietSettle,
      beforeSignature,
      afterSignature,
      painted: Boolean(beforeSignature && afterSignature && beforeSignature !== afterSignature),
    });
  }, TERMINAL_SETTLE_REDRAW_PAINT_SAMPLE_MS);
}

function scheduleSettleRedraw(paneId, terminal, fitAddon = null) {
  const id = String(paneId);
  if (!id || !terminal || !rendererOwnsPtyGeometry(id)) return;
  // The settle redraw exists to capture a paint-outcome signature; skip terminals
  // with no renderable buffer (nothing to repaint or measure).
  if (!terminal.buffer || !terminal.buffer.active) return;
  const now = Date.now();
  const firstReqAt = terminalSettleRedrawFirstReqAt.get(id) || now;
  terminalSettleRedrawFirstReqAt.set(id, firstReqAt);

  const existing = terminalSettleRedrawTimers.get(id);
  if (existing) clearTimeout(existing);

  // Debounce on quiet, but never defer past MAX_DEFER during sustained streaming.
  const burstElapsed = Math.max(0, now - firstReqAt);
  const delay = burstElapsed >= TERMINAL_SETTLE_REDRAW_MAX_DEFER_MS
    ? 0
    : Math.min(TERMINAL_SETTLE_REDRAW_DEBOUNCE_MS, TERMINAL_SETTLE_REDRAW_MAX_DEFER_MS - burstElapsed);

  const timer = setTimeout(() => {
    terminalSettleRedrawTimers.delete(id);
    if (terminals.get(id) !== terminal) return;
    // Rate-limit the forced re-poke to protect steady_state_event_rates (<=1/sec).
    const sinceLast = Date.now() - (Number(terminalSettleRedrawLastAt.get(id)) || 0);
    if (sinceLast < TERMINAL_SETTLE_REDRAW_MIN_INTERVAL_MS) {
      // Too soon — re-arm for the remaining cooldown without resetting the burst clock.
      const wait = TERMINAL_SETTLE_REDRAW_MIN_INTERVAL_MS - sinceLast;
      const retry = setTimeout(() => {
        terminalSettleRedrawTimers.delete(id);
        if (terminals.get(id) !== terminal) return;
        terminalSettleRedrawFirstReqAt.delete(id);
        performSettleRedraw(id, terminal, fitAddon);
      }, wait);
      terminalSettleRedrawTimers.set(id, retry);
      return;
    }
    terminalSettleRedrawFirstReqAt.delete(id);
    performSettleRedraw(id, terminal, fitAddon);
  }, delay);
  terminalSettleRedrawTimers.set(id, timer);
}

function setupTerminalWheelScrollGuard(paneId, container, terminal, options = {}) {
  if (!container || typeof container.addEventListener !== 'function' || !terminal) return false;
  container.addEventListener('wheel', (event) => {
    handleTerminalWheelScrollIntent(paneId, terminal, event);
  }, {
    passive: true,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return true;
}

function attachTerminalScrollProbeTarget(paneId, container, terminal) {
  if (!container || !terminal) return false;
  try {
    Object.defineProperty(container, TERMINAL_SCROLL_PROBE_TARGET_PROPERTY, {
      value: {
        paneId: String(paneId),
        terminal,
      },
      configurable: true,
      enumerable: false,
      writable: true,
    });
    return true;
  } catch (err) {
    log.warn(`Terminal ${paneId}`, `Scroll probe target attach failed: ${err?.message || err}`);
    return false;
  }
}

function detachTerminalScrollProbeTarget(paneId) {
  if (typeof document === 'undefined') return;
  const container = document.getElementById(`terminal-${String(paneId)}`);
  if (!container) return;
  try {
    delete container[TERMINAL_SCROLL_PROBE_TARGET_PROPERTY];
  } catch (_) {}
}

function snapshotTerminalScrollState(terminal) {
  const buffer = terminal && terminal.buffer && terminal.buffer.active ? terminal.buffer.active : {};
  const baseY = Math.max(0, Number(buffer.baseY) || 0);
  const viewportY = Math.max(0, Number(buffer.viewportY) || 0);
  const cursorY = Math.max(0, Number(buffer.cursorY) || 0);
  const rows = Math.max(0, Number(terminal && terminal.rows) || 0);
  const length = Math.max(0, Number(buffer.length) || 0);
  const populatedRows = length || (baseY + cursorY + 1);
  return {
    baseY,
    viewportY,
    cursorY,
    rows,
    length,
    scrollbackRows: Math.max(0, populatedRows - rows),
  };
}

// Runs the terminal scroll-probe in the renderer ISOLATED world, where the
// xterm Terminal instance, its DOM listeners, and the scroll-probe expando
// actually live. The probe used to be injected as a string into the main world
// via webContents.executeJavaScript, but the expando set here via
// Object.defineProperty is bound to this world's DOM wrapper and is invisible
// to the main world — so every probe returned terminal_probe_target_unavailable
// (the Bug B proof-seam failure). The main-world injection now delegates here
// through the contextBridge so the read context matches where the target lives.
const UI_PROBE_HOVER_CLASS = 'squidrun-ui-probe-hover';
const UI_PROBE_HOVER_STYLE_ID = 'squidrun-ui-probe-hover-style';

// Selector-based UI interaction ops (S426 UX audit tooling). Click fires
// synthetic listeners faithfully; hover CANNOT trigger CSS :hover from
// synthetic events, so forceHover ALSO injects a style rule that renders the
// data-tooltip layer exactly as :hover would - the clipping geometry under
// audit is identical, and that is the honest limit of the tool.
function runUiInteractionProbe(probe = {}) {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
  const element = document.querySelector(probe.selector);
  if (!element) {
    return { success: false, reason: 'selector_not_found', selector: probe.selector, op: probe.op };
  }
  const rect = element.getBoundingClientRect?.() || {};
  const base = {
    success: true,
    op: probe.op,
    selector: probe.selector,
    windowKey: String(document.body?.dataset?.windowKey || ''),
    tagName: element.tagName || null,
    elementId: element.id || null,
    rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
    disabled: element.disabled === true,
    valueBefore: 'value' in element ? element.value : null,
  };
  if (probe.op === 'dispatchClick') {
    const opts = { bubbles: true, cancelable: true, view: window };
    element.dispatchEvent(new MouseEvent('pointerdown', opts));
    element.dispatchEvent(new MouseEvent('mousedown', opts));
    element.dispatchEvent(new MouseEvent('pointerup', opts));
    element.dispatchEvent(new MouseEvent('mouseup', opts));
    const accepted = element.dispatchEvent(new MouseEvent('click', opts));
    return wait(probe.waitMs).then(() => ({
      ...base,
      dispatchAccepted: accepted,
      activeElementId: document.activeElement?.id || null,
    }));
  }
  if (probe.op === 'dispatchHover') {
    const opts = { bubbles: true, cancelable: true, view: window };
    element.dispatchEvent(new MouseEvent('pointerover', opts));
    element.dispatchEvent(new MouseEvent('mouseover', opts));
    element.dispatchEvent(new MouseEvent('mouseenter', { ...opts, bubbles: false }));
    if (!document.getElementById(UI_PROBE_HOVER_STYLE_ID)) {
      const style = document.createElement('style');
      style.id = UI_PROBE_HOVER_STYLE_ID;
      style.textContent = [
        `.${UI_PROBE_HOVER_CLASS}[data-tooltip]::after,`,
        `.${UI_PROBE_HOVER_CLASS}[data-tooltip]::before {`,
        '  opacity: 1 !important;',
        '}',
      ].join('\n');
      document.head.appendChild(style);
    }
    document.querySelectorAll(`.${UI_PROBE_HOVER_CLASS}`).forEach((other) => {
      if (other !== element) other.classList.remove(UI_PROBE_HOVER_CLASS);
    });
    element.classList.add(UI_PROBE_HOVER_CLASS);
    return wait(probe.waitMs).then(() => ({
      ...base,
      hoverForced: true,
      hasDataTooltip: Boolean(element.dataset?.tooltip),
      title: element.getAttribute?.('title') || null,
    }));
  }
  if (probe.op === 'dispatchSelect') {
    if (element.tagName !== 'SELECT') {
      return { ...base, success: false, reason: 'selector_not_select' };
    }
    if (element.disabled === true) {
      return { ...base, success: false, reason: 'select_disabled' };
    }
    const nextValue = String(probe.value || '');
    const optionExists = Array.from(element.options || []).some((option) => option.value === nextValue);
    if (!optionExists) {
      return { ...base, success: false, reason: 'select_option_not_found', requestedValue: nextValue };
    }
    element.focus?.();
    element.value = nextValue;
    const inputAccepted = element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    const changeAccepted = element.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    return wait(probe.waitMs).then(() => ({
      ...base,
      requestedValue: nextValue,
      valueAfter: element.value,
      disabledAfter: element.disabled === true,
      inputAccepted,
      changeAccepted,
      activeElementId: document.activeElement?.id || null,
    }));
  }
  if (probe.op === 'clearHover') {
    document.querySelectorAll(`.${UI_PROBE_HOVER_CLASS}`).forEach((other) => {
      other.classList.remove(UI_PROBE_HOVER_CLASS);
    });
    document.getElementById(UI_PROBE_HOVER_STYLE_ID)?.remove();
    return { ...base, hoverCleared: true };
  }
  return { ...base, success: false, reason: 'op_unsupported' };
}

function runTerminalScrollProbe(probe = {}) {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
  if (typeof document === 'undefined') {
    return { success: false, reason: 'terminal_probe_no_document', ...probe };
  }
  if (probe.op === 'dispatchClick' || probe.op === 'dispatchHover' || probe.op === 'dispatchSelect' || probe.op === 'clearHover') {
    if (!probe.selector || typeof probe.selector !== 'string') {
      return { success: false, reason: 'selector_required', op: probe.op };
    }
    return runUiInteractionProbe(probe);
  }
  const container = document.getElementById(probe.containerId);
  if (!container) {
    return { success: false, reason: 'container_not_found', ...probe };
  }
  const target = container[TERMINAL_SCROLL_PROBE_TARGET_PROPERTY];
  const terminal = target && target.terminal;
  if (!terminal) {
    return { success: false, reason: 'terminal_probe_target_unavailable', ...probe };
  }
  const before = snapshotTerminalScrollState(terminal);
  const result = {
    success: true,
    windowKey: String(document.body && document.body.dataset ? document.body.dataset.windowKey || '' : ''),
    requestedWindowKey: probe.windowKey,
    containerId: probe.containerId,
    paneId: target.paneId || null,
    op: probe.op,
    before,
    after: null,
    moved: false,
    dispatchAccepted: null,
    dispatchTarget: null,
  };
  if (probe.op === 'scrollLines') {
    if (typeof terminal.scrollLines !== 'function') {
      return { ...result, success: false, reason: 'scrollLines_unavailable' };
    }
    terminal.scrollLines(Number(probe.lines));
    result.lines = Number(probe.lines);
    result.after = snapshotTerminalScrollState(terminal);
    result.moved = result.after.viewportY !== before.viewportY;
    return result;
  }
  if (probe.op === 'dispatchWheel') {
    const event = new WheelEvent('wheel', {
      deltaY: Number(probe.deltaY),
      deltaMode: 0,
      bubbles: true,
      cancelable: true,
    });
    result.deltaY = Number(probe.deltaY);
    // Dispatch at the DEEP xterm element, like a real cursor wheel: a real
    // wheel targets the element under the pointer and bubbles UP through
    // xterm's viewport listener. Dispatching on the container started the
    // event ABOVE those listeners (bubbling never descends), so the old probe
    // could never move xterm regardless of live wheel health (S426 audit).
    const deepTarget = container.querySelector('.xterm-screen')
      || container.querySelector('.xterm-viewport')
      || container.querySelector('.xterm')
      || container;
    result.dispatchTarget = deepTarget === container
      ? 'container'
      : (deepTarget.className?.baseVal || deepTarget.className || 'xterm-child');
    result.dispatchAccepted = deepTarget.dispatchEvent(event);
    return wait(probe.waitMs).then(() => {
      result.after = snapshotTerminalScrollState(terminal);
      result.moved = result.after.viewportY !== before.viewportY;
      return result;
    });
  }
  if (probe.op === 'dispatchKey') {
    const helper = container.querySelector('textarea.xterm-helper-textarea, .xterm-helper-textarea');
    if (!helper) {
      return { ...result, success: false, reason: 'xterm_helper_textarea_not_found' };
    }
    const key = String(probe.key || '');
    const keyCode = key === 'PageUp' ? 33 : 34;
    // Remote-driven probe: never leave focus on the probed pane (S463
    // focus-steal guarantee). Restore the user's focus after dispatch.
    const probeSavedFocus = document.activeElement;
    if (typeof helper.focus === 'function') {
      try {
        helper.focus({ preventScroll: true });
      } catch (_) {
        helper.focus();
      }
    }
    const restoreProbeFocus = () => {
      if (document.activeElement !== helper) return;
      if (probeSavedFocus && probeSavedFocus !== helper && document.body?.contains?.(probeSavedFocus)) {
        try {
          probeSavedFocus.focus?.();
          return;
        } catch (_) { /* fall through */ }
      }
      try { helper.blur?.(); } catch (_) { /* ignore */ }
    };
    const event = new KeyboardEvent('keydown', {
      key,
      code: key,
      keyCode,
      which: keyCode,
      bubbles: true,
      cancelable: true,
    });
    result.key = key;
    result.dispatchTarget = 'xterm-helper-textarea';
    result.helperFocused = document.activeElement === helper;
    result.dispatchAccepted = helper.dispatchEvent(event);
    return wait(probe.waitMs).then(() => {
      result.after = snapshotTerminalScrollState(terminal);
      result.moved = result.after.viewportY !== before.viewportY;
      result.defaultPrevented = event.defaultPrevented === true;
      restoreProbeFocus();
      return result;
    });
  }
  return { ...result, success: false, reason: 'op_unsupported' };
}

function scheduleTerminalAttachPaintRefresh(paneId, terminal, fitAddon = null) {
  scheduleTerminalPaintRefresh(paneId, terminal, fitAddon, 0);
  scheduleTerminalPaintRefresh(paneId, terminal, fitAddon, 80);
  scheduleTerminalPaintRefresh(paneId, terminal, fitAddon, 250);
  scheduleTerminalPaintRefresh(paneId, terminal, fitAddon, 650);
  scheduleTerminalPaintRefresh(paneId, terminal, fitAddon, 1200);
  scheduleTerminalPaintRefresh(paneId, terminal, fitAddon, 2400);
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
  const id = String(paneId);
  // Suspended hidden mirror: DROP the write entirely - the daemon owns the
  // history and resume repaints it (S463 drawer-mirror suspension).
  if (suspendedRenderPanes.has(id)) return;
  const payload = typeof data === 'string' ? data : String(data ?? '');
  const byteLen = Buffer.byteLength(payload, 'utf8');

  // Initialize state for this pane if needed
  if (!terminalWriteQueues.has(id)) {
    terminalWriteQueues.set(id, []);
    terminalWriting.set(id, false);
    terminalWatermarks.set(id, 0);
    terminalPaused.set(id, false);
  }

  const queue = terminalWriteQueues.get(id);
  let currentWatermark = terminalWatermarks.get(id) || 0;
  let droppedBytes = 0;
  let droppedEntries = 0;

  // Drop oldest queued chunks when hitting absolute queue cap.
  // This prevents unbounded per-pane memory growth when renderer is backpressured.
  while ((currentWatermark + byteLen) > TERMINAL_QUEUE_MAX_BYTES && queue.length > 0) {
    const dropped = queue.shift();
    const droppedByteLen = typeof dropped === 'string'
      ? Buffer.byteLength(dropped, 'utf8')
      : Number(dropped?.byteLen) || Buffer.byteLength(String(dropped?.data ?? ''), 'utf8');
    currentWatermark = Math.max(0, currentWatermark - droppedByteLen);
    droppedBytes += droppedByteLen;
    droppedEntries += 1;
  }

  // If a single incoming chunk cannot fit (in-flight bytes already exceed cap),
  // drop the new chunk instead of allowing unbounded growth.
  if ((currentWatermark + byteLen) > TERMINAL_QUEUE_MAX_BYTES) {
    terminalWatermarks.set(id, currentWatermark);
    maybeResumePtyProducer(id, currentWatermark);
    if (droppedEntries > 0) {
      log.warn(`Terminal ${id}`, `Dropped ${droppedEntries} queued chunk(s), ${droppedBytes} bytes to enforce queue cap`);
    }
    log.warn(`Terminal ${id}`, `Dropped incoming terminal chunk (${byteLen} bytes) - queue cap ${TERMINAL_QUEUE_MAX_BYTES} reached`);
    return;
  }

  if (droppedEntries > 0) {
    log.warn(`Terminal ${id}`, `Dropped ${droppedEntries} queued chunk(s), ${droppedBytes} bytes to enforce queue cap`);
  }

  // Update watermark (bytes in flight + queued to xterm)
  currentWatermark += byteLen;
  terminalWatermarks.set(id, currentWatermark);

  // If watermark exceeds high threshold, pause the PTY producer
  if (
    rendererOwnsPtyGeometry(id)
    && currentWatermark > HIGH_WATERMARK
    && !terminalPaused.get(id)
  ) {
    if (window.squidrun?.pty?.pause) {
      window.squidrun.pty.pause(id);
      terminalPaused.set(id, true);
      log.info(`Terminal ${id}`, `High watermark reached (${currentWatermark} bytes) - PTY paused`);
    }
  }

  // Add data to queue
  queue.push({ data: payload, byteLen });
  terminalLastWriteAt.set(id, Date.now()); // for the settle quiescence gate (Bug A painted validity)
  scheduleStreamingViewportFit(id, terminal, fitAddons.get(id));
  scheduleSettleRedraw(id, terminal, fitAddons.get(id));

  // Start processing if not already writing
  if (!terminalWriteFlushTimers.has(id)) {
    flushTerminalQueue(id, terminal);
  }
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
    const paneFitAddon = fitAddons.get(String(paneId));
    if (paneFitAddon) {
      scheduleTerminalPaintRefresh(paneId, terminal, paneFitAddon, 0, {
        operation: 'write_queue_drain',
        forceFit: true,
      });
      scheduleTerminalPaintRefresh(paneId, terminal, paneFitAddon, 120, {
        operation: 'write_queue_settle',
        forceFit: true,
      });
    }
    return;
  }

  // Mark as writing
  terminalWriting.set(paneId, true);

  // Get next chunk
  const entry = queue.shift();
  if (!entry) {
    terminalWriting.set(paneId, false);
    return;
  }
  const data = typeof entry === 'string' ? entry : String(entry.data ?? '');
  const byteLen = typeof entry === 'string'
    ? Buffer.byteLength(entry, 'utf8')
    : (Number(entry.byteLen) || Buffer.byteLength(data, 'utf8'));

  // Write with callback - xterm calls this when write is processed
  terminal.write(data, () => {
    // Write complete, allow next write
    terminalWriting.set(paneId, false);

    // Update watermark
    const oldWatermark = terminalWatermarks.get(paneId) || 0;
    const newWatermark = Math.max(0, oldWatermark - byteLen);
    terminalWatermarks.set(paneId, newWatermark);

    // If watermark drops below low threshold, resume the PTY producer
    maybeResumePtyProducer(paneId, newWatermark);

    const paneFitAddon = fitAddons.get(String(paneId));
    if (paneFitAddon) {
      scheduleTerminalPaintRefresh(paneId, terminal, paneFitAddon, 16, {
        operation: 'write_chunk_paint',
      });
    }

    const nextDelayMs = recordTerminalWriteFrame(paneId, byteLen);
    scheduleTerminalQueueFlush(paneId, terminal, nextDelayMs);
  });
}

// Global UI focus tracker - survives staggered multi-pane sends.
// Updated by focusin listener on UI inputs; doSendToPane restores to this.
let lastUserUIFocus = null;

// Track when user last typed in a UI input (not xterm).
// doSendToPane defers injection while user is actively typing.
let lastUserUIKeypressTime = 0;
// Timing constants imported from constants.js
const UI_FOCUS_TYPING_WINDOW_MS = 2000;

const SPINNER_CHARS = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * Strip ANSI escape codes from string (OSC + CSI + charset sequences)
 */
function stripAnsi(text) {
  if (typeof text !== 'string') return text;
  return stripAnsiCodes(text)
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
const STARTUP_READY_PATTERNS = [
  { pattern: /(^|\n)(?:codex|claude|gemini|cursor)>\s*(\n|$)/im, models: null },        // All CLIs
  { pattern: /(^|\n)PS\s+[^\n>]*>\s*(\n|$)/m, models: ['codex'] },                      // PS prompt — Codex only (fires before Claude Code starts)
  { pattern: /how can i help/i, models: ['gemini'] },                                     // Gemini greeting
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
  rightClickSelectsWord: false,
  allowProposedApi: true,
};

const XTERM_SCROLLBACK_LINES = TERMINAL_OPTIONS.scrollback;

function createTerminalInstance() {
  const terminal = new Terminal(TERMINAL_OPTIONS);
  // Defensive re-enforcement to avoid downstream option mutation.
  if (terminal?.options && terminal.options.scrollback !== XTERM_SCROLLBACK_LINES) {
    terminal.options.scrollback = XTERM_SCROLLBACK_LINES;
  }
  return terminal;
}

function trimScrollbackToMaxLines(scrollback, maxLines = XTERM_SCROLLBACK_LINES) {
  if (!scrollback || maxLines <= 0) {
    return '';
  }

  const text = typeof scrollback === 'string' ? scrollback : String(scrollback);
  let newlineCount = 0;

  for (let i = text.length - 1; i >= 0; i -= 1) {
    if (text[i] === '\n') {
      newlineCount += 1;
      if (newlineCount >= maxLines) {
        return text.slice(i + 1);
      }
    }
  }

  return text;
}

async function readDaemonScrollbackForPane(paneId, options = {}) {
  const terminalEntry = await readDaemonTerminalForPane(paneId, options);
  return typeof terminalEntry?.scrollback === 'string' ? terminalEntry.scrollback : '';
}

function shouldRestoreDaemonScrollbackOnCreate(paneId, options = {}) {
  if (options.restoreDaemonScrollback === true) return true;
  if (options.restoreDaemonScrollback === false) return false;
  return !PANE_IDS.includes(String(paneId || ''));
}

// DRAWER-MIRROR SUSPENSION (S463 renderer-death case): rendering xterm
// mirrors inside a CLOSED drawer is pure waste and the prime suspect for the
// RSS explosions (onsets correlated to the second with big message bursts
// into the mirrored panes). While suspended, incoming writes are DROPPED -
// the daemon owns the truth - and resume repaints the full history from the
// daemon's scrollback.
const suspendedRenderPanes = new Set();

function setPaneRenderSuspended(paneId, suspended) {
  const id = String(paneId || '').trim();
  if (!id) return false;
  if (suspended) {
    if (suspendedRenderPanes.has(id)) return true;
    suspendedRenderPanes.add(id);
    resetTerminalWriteQueue(id);
    log.info(`Terminal ${id}`, 'Render suspended (hidden mirror) - writes dropped, daemon keeps history');
    return true;
  }
  if (!suspendedRenderPanes.delete(id)) return false;
  log.info(`Terminal ${id}`, 'Render resumed - repainting full history from daemon scrollback');
  void repaintTerminalFromDaemonScrollback(id, {});
  return true;
}

function isPaneRenderSuspended(paneId) {
  return suspendedRenderPanes.has(String(paneId || '').trim());
}

async function repaintTerminalFromDaemonScrollback(paneId, options = {}) {
  const id = String(paneId || '').trim();
  if (!id) return { ok: false, reason: 'missing_pane' };
  const terminal = terminals.get(id);
  if (!terminal) return { ok: false, reason: 'terminal_not_attached' };
  const scrollback = await readDaemonScrollbackForPane(id, { timeoutMs: options.timeoutMs });
  if (!scrollback) return { ok: false, reason: 'empty_scrollback' };

  if (options.clear !== false && typeof terminal.clear === 'function') {
    try {
      terminal.clear();
    } catch (err) {
      log.warn(`Terminal ${id}`, `Daemon scrollback repaint clear failed: ${err?.message || err}`);
    }
  }

  resetTerminalWriteQueue(id);
  queueTerminalWrite(id, terminal, trimScrollbackToMaxLines(scrollback));
  scheduleTerminalAttachPaintRefresh(id, terminal, fitAddons.get(id));
  return { ok: true };
}

function scheduleDaemonScrollbackRepaint(paneId, options = {}) {
  const id = String(paneId || '').trim();
  if (!id) return;
  const delays = Array.isArray(options.delays)
    ? options.delays
    : [1200, 3200, 6500];
  for (const delayMs of delays) {
    const delay = Math.max(0, Number(delayMs) || 0);
    setTimeout(() => {
      void repaintTerminalFromDaemonScrollback(id, {
        timeoutMs: options.timeoutMs,
        clear: options.clear,
      }).catch((err) => {
        log.warn(`Terminal ${id}`, `Daemon scrollback repaint failed: ${err?.message || err}`);
      });
    }, delay);
  }
}

async function readDaemonTerminalForPane(paneId, options = {}) {
  const id = String(paneId || '').trim();
  if (!id) return null;
  const snapshotFn = window?.squidrun?.daemon?.terminalSnapshot
    || window?.squidrunAPI?.daemon?.terminalSnapshot;
  if (typeof snapshotFn !== 'function') return null;

  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(250, Number(options.timeoutMs))
    : 1500;
  try {
    const snapshot = await snapshotFn({ timeoutMs });
    return Array.isArray(snapshot?.terminals)
      ? snapshot.terminals.find((entry) => String(entry?.paneId || '') === id)
      : null;
  } catch (err) {
    log.warn(`Terminal ${id}`, `Daemon terminal snapshot failed: ${err?.message || err}`);
    return null;
  }
}

function normalizeWorkingDirForCompare(value) {
  return String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+$/g, '')
    .toLowerCase();
}

function getDaemonTerminalWorkingDir(entry = {}) {
  return entry?.cwd || entry?.workingDir || entry?.currentWorkingDirectory || '';
}

function isDaemonTerminalWorkingDirMismatch(entry = {}, expectedWorkingDir = '') {
  if (!entry || entry.alive !== true) return false;
  const actual = normalizeWorkingDirForCompare(getDaemonTerminalWorkingDir(entry));
  const expected = normalizeWorkingDirForCompare(expectedWorkingDir);
  return Boolean(actual && expected && actual !== expected);
}

async function recreatePaneOnWorkingDirMismatch(paneId, workingDir, runtimeOverride = {}, options = {}) {
  if (runtimeOverride.recreateOnWorkingDirMismatch !== true) {
    return { recreated: false, skipped: true, reason: 'not_enabled' };
  }
  const id = String(paneId || '').trim();
  const expectedWorkingDir = String(workingDir || '').trim();
  if (!id || !expectedWorkingDir) {
    return { recreated: false, skipped: true, reason: 'missing_pane_or_working_dir' };
  }

  const existing = options.daemonTerminal && typeof options.daemonTerminal === 'object'
    ? options.daemonTerminal
    : await readDaemonTerminalForPane(id, { timeoutMs: options.snapshotTimeoutMs });
  if (!isDaemonTerminalWorkingDirMismatch(existing, expectedWorkingDir)) {
    return { recreated: false, skipped: true, reason: 'working_dir_ok' };
  }

  if (!window?.squidrun?.pty?.kill) {
    log.warn(`Terminal ${id}`, 'Working directory mismatch detected but PTY kill is unavailable');
    return { recreated: false, skipped: true, reason: 'pty_kill_unavailable' };
  }

  const actualWorkingDir = getDaemonTerminalWorkingDir(existing);
  log.warn(
    `Terminal ${id}`,
    `Recreating PTY for working directory mismatch: ${actualWorkingDir || 'unknown cwd'} -> ${expectedWorkingDir}`
  );
  try {
    await window.squidrun.pty.kill(id);
  } catch (err) {
    log.warn(`Terminal ${id}`, `Failed to kill mismatched PTY before recreate: ${err?.message || err}`);
  }
  resetTerminalWriteQueue(id);
  const recreateDelayMs = Number.isFinite(Number(options.recreateDelayMs))
    ? Math.max(0, Number(options.recreateDelayMs))
    : 250;
  if (recreateDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, recreateDelayMs));
  }
  return { recreated: true, actualWorkingDir, expectedWorkingDir };
}

// Track when user focuses any UI input (not xterm textareas).
// Call once from renderer.js after DOMContentLoaded.
function isNonTerminalUiInput(el) {
  const tag = el?.tagName?.toUpperCase();
  return (tag === 'INPUT' || tag === 'TEXTAREA') &&
    !el?.classList?.contains?.('xterm-helper-textarea');
}

function markUserUiActivity(el) {
  if (isNonTerminalUiInput(el)) {
    lastUserUIKeypressTime = Date.now();
  }
}

function initUIFocusTracker() {
  // Abort previous controller if re-initialized (destroy-before-setup)
  if (uiFocusTrackerAbortController) {
    uiFocusTrackerAbortController.abort();
  }
  uiFocusTrackerAbortController = new AbortController();
  const { signal } = uiFocusTrackerAbortController;

  document.addEventListener('focusin', (e) => {
    const el = e.target;
    if (isNonTerminalUiInput(el)) {
      lastUserUIFocus = el;
    }
  }, { signal });

  // Track user activity in UI inputs for typing guard.
  // keydown captures direct typing; input captures IME/paste/programmatic edits.
  document.addEventListener('keydown', (e) => {
    markUserUiActivity(e.target);
  }, { signal });
  document.addEventListener('input', (e) => {
    markUserUiActivity(e.target);
  }, { signal });
}

// Returns true if user is actively typing in a UI input
function userIsTyping() {
  if (!lastUserUIFocus) return false;
  const el = document.activeElement;
  if (!isNonTerminalUiInput(el)) return false;
  return (Date.now() - lastUserUIKeypressTime) < TYPING_GUARD_MS;
}

// Returns true if a non-terminal UI input currently has focus.
// Defer window is activity-based: focus alone does NOT block injection.
// This prevents stale focus from deadlocking injections while still
// protecting active composition in broadcastInput and similar fields.
function userInputFocused() {
  const el = document.activeElement;
  if (!isNonTerminalUiInput(el)) return false;
  return (Date.now() - lastUserUIKeypressTime) <= UI_FOCUS_TYPING_WINDOW_MS;
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

function getSettingsSafe() {
  try {
    return settings.getSettings() || {};
  } catch {
    return {};
  }
}

function getPaneCommandFromSettings(paneId) {
  const settingsObj = getSettingsSafe();
  const paneCommands = settingsObj?.paneCommands || {};
  const id = String(paneId);
  const runtimeOverride = getPaneRuntimeOverride(id);
  if (typeof runtimeOverride.command === 'string' && runtimeOverride.command.trim()) {
    return runtimeOverride.command.trim();
  }
  const sourcePaneId = runtimeOverride.commandSourcePaneId || null;
  const cmd = paneCommands[id] || (sourcePaneId ? paneCommands[sourcePaneId] : '') || '';
  return typeof cmd === 'string' ? cmd : '';
}

function buildPtyCreateOptionsForRuntimeOverride(paneId, runtimeOverride = {}, workingDir = '') {
  const command = typeof runtimeOverride.command === 'string'
    ? runtimeOverride.command.trim()
    : '';
  const hasRuntimeOverride = Boolean(
    command
    || runtimeOverride.spawnCommandOnCreate === true
    || runtimeOverride.roleId
    || runtimeOverride.routeTarget
    || runtimeOverride.role
    || runtimeOverride.roleLabel
    || runtimeOverride.label
    || runtimeOverride.workingDir
    || runtimeOverride.cwd
  );
  if (!hasRuntimeOverride) return {};
  const spawnCommandOnCreate = runtimeOverride.spawnCommandOnCreate === true && Boolean(command);
  const context = normalizeStartupWindowContext(startupWindowContext);
  const role = String(
    runtimeOverride.roleId
    || runtimeOverride.routeTarget
    || runtimeOverride.role
    || runtimeOverride.roleLabel
    || runtimeOverride.label
    || paneId
  ).trim();
  const env = {
    ...(role ? { SQUIDRUN_ROLE: role } : {}),
    ...(context.sessionScopeId ? { SQUIDRUN_SESSION_SCOPE_ID: context.sessionScopeId } : {}),
    ...(context.profileName ? { SQUIDRUN_PROFILE: context.profileName } : {}),
    ...(context.windowKey ? { SQUIDRUN_WINDOW_KEY: context.windowKey } : {}),
    ...(workingDir ? { SQUIDRUN_WORKING_DIR: workingDir } : {}),
  };
  return {
    ...(command ? { paneCommand: command } : {}),
    ...(spawnCommandOnCreate ? { spawnCommandOnCreate: true, preferWorkingDir: true } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
}

function applyFreshCreateSpawnCommandOptions(paneId, ptyCreateOptions = {}, options = {}) {
  const id = String(paneId || '');
  if (options.spawnCommandOnCreate !== true) return ptyCreateOptions;
  if (!PANE_IDS.includes(id)) return ptyCreateOptions;
  if (ptyCreateOptions.spawnCommandOnCreate === true) return ptyCreateOptions;

  const paneCommand = getPaneCommandFromSettings(id);
  if (!paneCommand) return ptyCreateOptions;

  return {
    ...ptyCreateOptions,
    paneCommand,
    spawnCommandOnCreate: true,
    ...(options.remintClaudeSessionId === true ? { remintClaudeSessionId: true } : {}),
  };
}

function classifyRuntimeFromIdentity(paneId) {
  const id = String(paneId);
  const entry = paneCliIdentity.get(id);
  const command = getPaneCommandFromSettings(id);
  const parts = [
    entry?.provider,
    entry?.label,
    entry?.key,
    command,
  ].filter(Boolean).map((value) => String(value).toLowerCase());
  const runtimeHint = parts.join(' ');

  if (runtimeHint.includes('codex')) return 'codex';
  if (runtimeHint.includes('gemini')) return 'gemini';
  if (runtimeHint.includes('claude')) return 'claude';
  if (!String(command || '').trim()) {
    // Preserve legacy behavior when runtime is unspecified.
    return 'claude';
  }
  return 'unknown';
}

function getInjectionCapabilityOverrides(paneId, runtimeKey) {
  const settingsObj = getSettingsSafe();
  const overridesRoot = settingsObj?.injectionCapabilities;
  if (!overridesRoot || typeof overridesRoot !== 'object') {
    return {};
  }

  const id = String(paneId);
  const paneOverrides = (overridesRoot.panes && typeof overridesRoot.panes === 'object')
    ? (overridesRoot.panes[id] || {})
    : (overridesRoot[id] || {});
  const runtimeOverrides = (overridesRoot.runtimes && typeof overridesRoot.runtimes === 'object')
    ? (overridesRoot.runtimes[runtimeKey] || {})
    : (overridesRoot[runtimeKey] || {});

  const merged = {};
  if (paneOverrides && typeof paneOverrides === 'object') {
    Object.assign(merged, paneOverrides);
  }
  if (runtimeOverrides && typeof runtimeOverrides === 'object') {
    Object.assign(merged, runtimeOverrides);
  }
  return merged;
}

function getPaneInjectionCapabilities(paneId) {
  const runtimeKey = classifyRuntimeFromIdentity(paneId);
  const base = getRuntimeInjectionCapabilityDefault(runtimeKey, {
    isDarwin: IS_DARWIN,
    codexEnterDelayMs: CODEX_ENTER_DELAY_MS,
    codexVerifySubmitAccepted: true,
    geminiEnterDelayMs: GEMINI_ENTER_DELAY_MS,
    claudeEnterDelayMs: 50,
  });
  const overrides = getInjectionCapabilityOverrides(paneId, runtimeKey);
  if (overrides && typeof overrides === 'object') {
    Object.assign(base, overrides);
  }

  // In hidden pane host mode, trusted-enter runtimes (Claude) must submit
  // through raw PTY Enter to avoid browser key-event delivery issues.
  if (isHiddenPaneHostPane(paneId) && base.enterMethod === 'trusted') {
    const hiddenHostNeedsSubmitProof = String(base.displayName || '').toLowerCase() === 'codex'
      || String(base.modeLabel || '').toLowerCase().includes('codex');
    Object.assign(base, {
      submitMethod: 'hidden-pane-host-pty-enter',
      bypassGlobalLock: true,
      applyCompactionGate: false,
      requiresFocusForEnter: false,
      enterMethod: 'pty',
      verifySubmitAccepted: hiddenHostNeedsSubmitProof,
      deferSubmitWhilePaneActive: false,
      typingGuardWhenBypassing: true,
      enterFailureReason: 'pty_enter_failed',
    });
  }

  if (isTrustQuotePaneId(paneId)) {
    Object.assign(base, {
      submitMethod: 'trustquote-pty-enter',
      requiresFocusForEnter: false,
      enterMethod: 'pty',
      enterFailureReason: 'pty_enter_failed',
    });
  }

  return base;
}

function isCodexFromSettings(paneId) {
  return getPaneCommandFromSettings(paneId).toLowerCase().includes('codex');
}

function isCodexPane(paneId) {
  const entry = paneCliIdentity.get(String(paneId));
  if (entry?.key) {
    return entry.key.includes('codex');
  }
  return isCodexFromSettings(paneId);
}

function getPaneIdentityLabel(paneId) {
  const runtimeOverride = getPaneRuntimeOverride(paneId);
  if (runtimeOverride.roleLabel || runtimeOverride.label) {
    return runtimeOverride.roleLabel || runtimeOverride.label;
  }
  if (typeof getPaneDisplayName === 'function') {
    return getPaneDisplayName(paneId, { includeRole: true });
  }
  return PANE_ROLES[String(paneId)] || `Pane ${paneId}`;
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

  const role = getPaneIdentityLabel(paneId);
  const d = new Date();
  const timestamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const identity = `# SQUIDRUN SESSION: ${role} - Started ${timestamp}\n`;
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

function detachTerminalInputBridge(paneId) {
  const id = String(paneId);
  const disposable = terminalInputBridgeDisposables.get(id);
  if (disposable && typeof disposable.dispose === 'function') {
    disposable.dispose();
  }
  terminalInputBridgeDisposables.delete(id);
}

function attachTerminalInputBridge(paneId) {
  const id = String(paneId);
  if (isPaneReadOnlyMirrorMode(id)) {
    detachTerminalInputBridge(id);
    return false;
  }
  if (terminalInputBridgeDisposables.has(id)) {
    return true;
  }

  const terminal = terminals.get(id);
  if (!terminal || typeof terminal.onData !== 'function') {
    return false;
  }

  const disposable = terminal.onData((data) => {
    window.squidrun.pty.write(id, data).catch(err => {
      log.error(`Terminal ${id}`, 'PTY write failed:', err);
    });
  });
  terminalInputBridgeDisposables.set(id, disposable);
  return true;
}

function syncTerminalInputBridge(paneId, options = {}) {
  const id = String(paneId);
  if (isPaneReadOnlyMirrorMode(id)) {
    detachTerminalInputBridge(id);
    return false;
  }
  const modelHint = typeof options?.modelHint === 'string' ? options.modelHint.toLowerCase() : '';

  let shouldAttach;
  // All PTY-based panes (claude, codex, gemini) need the input bridge attached
  if (modelHint) {
    shouldAttach = true;
  } else {
    shouldAttach = true;
  }

  if (!shouldAttach) {
    detachTerminalInputBridge(id);
    return false;
  }

  return attachTerminalInputBridge(id);
}

function refreshMirrorModeBindings() {
  for (const paneId of getActivePaneIds()) {
    const id = String(paneId);
    if (isPaneReadOnlyMirrorMode(id)) {
      detachTerminalInputBridge(id);
      setInputLocked(id, true);
    } else {
      syncTerminalInputBridge(id);
    }
  }
}

function detachPtyDataListener(paneId) {
  const id = String(paneId);
  const dispose = ptyDataListenerDisposers.get(id);
  if (typeof dispose === 'function') {
    try {
      dispose();
    } catch (err) {
      log.warn('Terminal', `Failed to dispose pty.onData listener for pane ${id}: ${err.message}`);
    }
  }
  ptyDataListenerDisposers.delete(id);
  // Nuclear cleanup: remove ALL listeners on this channel to prevent stacking.
  // If dispose() silently failed (reference mismatch, preload/renderer swap),
  // stale listeners would cause every byte of PTY data to render twice.
  if (typeof window.squidrun?.pty?.removeAllDataListeners === 'function') {
    window.squidrun.pty.removeAllDataListeners(id);
  }
}

function detachPtyExitListener(paneId) {
  const id = String(paneId);
  const dispose = ptyExitListenerDisposers.get(id);
  if (typeof dispose === 'function') {
    try {
      dispose();
    } catch (err) {
      log.warn('Terminal', `Failed to dispose pty.onExit listener for pane ${id}: ${err.message}`);
    }
  }
  ptyExitListenerDisposers.delete(id);
  // Nuclear cleanup: same pattern as detachPtyDataListener
  if (typeof window.squidrun?.pty?.removeAllExitListeners === 'function') {
    window.squidrun.pty.removeAllExitListeners(id);
  }
}

function detachPtyListeners(paneId) {
  detachPtyDataListener(paneId);
  detachPtyExitListener(paneId);
}

function disposeAddon(addon, paneId, name) {
  if (!addon || typeof addon.dispose !== 'function') return;
  try {
    addon.dispose();
  } catch (err) {
    log.warn('Terminal', `Failed to dispose ${name} addon for pane ${paneId}: ${err.message}`);
  }
}

function teardownTerminalPane(paneId) {
  const id = String(paneId);

  if (injectionController && typeof injectionController.clearPaneQueue === 'function') {
    injectionController.clearPaneQueue(id, 'pane_teardown');
  } else if (messageQueue[id]) {
    delete messageQueue[id];
  }

  // Abort all DOM listeners for this pane (contextmenu, keydown, click)
  const paneAbort = paneListenerAbortControllers.get(id);
  if (paneAbort) {
    paneAbort.abort();
    paneListenerAbortControllers.delete(id);
  }

  cleanupResizeObserver(id);
  clearTerminalPaintRefresh(id);
  detachTerminalScrollProbeTarget(id);
  terminalAppliedPtyGeometries.delete(id);
  terminalOwnFitSuppressUntil.delete(id);
  terminalOwnFitContainerSizes.delete(id);
  terminalStreamingLastFitAt.delete(id);
  clearTerminalSettleRedraw(id);
  terminalSettleRedrawLastAt.delete(id);
  terminalLastWriteAt.delete(id);
  clearStartupInjection(id);
  detachTerminalInputBridge(id);
  detachPtyListeners(id);
  resetTerminalWriteQueue(id);
  // Dispose agent color decorations listener
  const agentColorDispose = agentColorDisposers.get(id);
  if (agentColorDispose && typeof agentColorDispose.dispose === 'function') {
    agentColorDispose.dispose();
  }
  agentColorDisposers.delete(id);
  ignoreExitUntil.delete(id);

  // Clean up codex identity tracking for this pane (prevents Set from growing forever)
  codexIdentityInjected.delete(id);
  const codeIdTimeout = codexIdentityTimeouts.get(id);
  if (codeIdTimeout) {
    clearTimeout(codeIdTimeout);
    codexIdentityTimeouts.delete(id);
  }

  if (typingIdleTimers[id]) {
    clearTimeout(typingIdleTimers[id]);
    typingIdleTimers[id] = null;
  }

  if (activeSearchPane === id) {
    closeTerminalSearch();
  }

  disposeAddon(webglAddons.get(id), id, 'webgl');
  webglAddons.delete(id);

  disposeAddon(searchAddons.get(id), id, 'search');
  searchAddons.delete(id);

  disposeAddon(fitAddons.get(id), id, 'fit');
  fitAddons.delete(id);

  const terminal = terminals.get(id);
  if (terminal && typeof terminal.dispose === 'function') {
    try {
      terminal.dispose();
    } catch (err) {
      log.warn('Terminal', `Failed to dispose terminal for pane ${id}: ${err.message}`);
    }
  }
  terminals.delete(id);
}


function stripAnsiForStartup(input) {
  return stripAnsiCodes(input)
    .replace(/\u001b[\(\)][A-Za-z0-9]/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/\r/g, '\n');
}

function hasStartupSessionHeader(scrollback, paneId) {
  const id = String(paneId || '');
  const role = paneId ? (PANE_ROLES[id] || '') : '';
  const identityLabel = paneId ? getPaneIdentityLabel(id) : '';
  const candidates = [role, identityLabel].filter(Boolean);
  if (candidates.length > 0) {
    return candidates.some((label) => (
      new RegExp(`#\\s*SQUIDRUN SESSION:\\s*${escapeRegExp(label)}(?:\\s|-|$)`, 'i')
        .test(String(scrollback || ''))
    ));
  }
  return /#\s*SQUIDRUN SESSION:/i.test(String(scrollback || ''));
}

function clearStartupInjection(paneId) {
  const state = startupInjectionState.get(String(paneId));
  if (!state) return;
  if (state.timeoutId) {
    clearTimeout(state.timeoutId);
    state.timeoutId = null;
  }
  if (state.sendTimeoutId) {
    clearTimeout(state.sendTimeoutId);
    state.sendTimeoutId = null;
  }
  state.cancelled = true;
  startupInjectionState.delete(String(paneId));
}

function hasPendingStartupInjection(paneId) {
  const state = startupInjectionState.get(String(paneId));
  return Boolean(state && !state.completed && !state.cancelled);
}

function scheduleStartupIdentityAttempt(paneId, state, reason, delayMs) {
  if (state.sendTimeoutId) {
    clearTimeout(state.sendTimeoutId);
    state.sendTimeoutId = null;
  }

  const safeDelayMs = Math.max(0, Number(delayMs) || 0);
  state.sendTimeoutId = setTimeout(() => {
    runStartupIdentityAttempt(paneId, state, reason).catch((err) => {
      log.error('spawnAgent', `Startup identity attempt crashed for pane ${paneId}: ${formatSerializedError(err)}`);
      startupInjectionState.delete(String(paneId));
    });
  }, safeDelayMs);
}

function serializeErrorForLog(err) {
  if (!err || typeof err !== 'object') {
    return { message: String(err || 'unknown_error') };
  }
  return {
    name: err.name || 'Error',
    message: err.message || String(err),
    stack: err.stack || null,
    code: err.code || null,
    reason: err.reason || null,
    status: err.status || null,
    applied: err.applied === true,
  };
}

function formatSerializedError(err) {
  try {
    return JSON.stringify(serializeErrorForLog(err));
  } catch (_) {
    return String(err?.message || err || 'unknown_error');
  }
}

function buildStartupIdentitySendError(sendResult = {}) {
  const error = new Error(sendResult?.reason || 'startup_identity_send_failed');
  error.reason = sendResult?.reason || null;
  error.status = sendResult?.status || null;
  error.signal = sendResult?.signal || null;
  error.applied = sendResult?.applied === true;
  error.pendingInputObserved = sendResult?.pendingInputObserved === true;
  return error;
}

function reportStartupIdentityTerminalFailure(paneId, err, reason = 'terminal_failure') {
  const id = String(paneId);
  const terminal = terminals.get(id);
  const detail = err?.reason || err?.message || reason;
  if (terminal && typeof terminal.write === 'function') {
    queueTerminalWrite(
      id,
      terminal,
      `\r\n[Startup identity injection failed: ${detail}. Restart pane to retry.]\r\n`
    );
  }
  updatePaneStatus(id, 'Startup identity failed');
}

async function sendStartupIdentityViaInjection(paneId, identityMsg) {
  const id = String(paneId);
  return new Promise((resolve, reject) => {
    if (typeof sendToPane !== 'function') {
      reject(new Error('sendToPane unavailable'));
      return;
    }

    let settled = false;
    const timeoutMs = Math.max(
      2000,
      Number(STARTUP_IDENTITY_VERIFY_DELAY_MS) || 1200
    );
    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ success: false, reason: 'startup_send_timeout' });
    }, timeoutMs);

    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      resolve(result || { success: true });
    };

    try {
      sendToPane(id, identityMsg, {
        priority: true,
        immediate: true,
        startupInjection: true,
        verifySubmitAccepted: true,
        onComplete: settle,
      });
    } catch (err) {
      clearTimeout(timeoutId);
      reject(err);
    }
  });
}

function shouldLoadWebLinksAddon(container) {
  if (!container || typeof container.getClientRects !== 'function') return false;
  return container.getClientRects().length > 0;
}

function setupTerminalAddons(paneId, terminal, container) {
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);

  if (shouldLoadWebLinksAddon(container)) {
    try {
      const WebLinksAddon = getWebLinksAddonCtor();
      terminal.loadAddon(new WebLinksAddon());
    } catch (err) {
      log.warn(`Terminal ${paneId}`, `WebLinks addon unavailable: ${err.message}`);
    }
  }

  if (isWebGLEnabled()) {
    try {
      const WebglAddon = getWebglAddonCtor();
      const webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => {
        log.warn(`Terminal ${paneId}`, 'WebGL context lost, falling back to canvas');
        webglAddon.dispose();
        if (webglAddons.get(paneId) === webglAddon) {
          webglAddons.delete(paneId);
        }
      });
      terminal.loadAddon(webglAddon);
      webglAddons.set(paneId, webglAddon);
      log.info(`Terminal ${paneId}`, 'WebGL renderer enabled');
    } catch (e) {
      log.warn(`Terminal ${paneId}`, `WebGL not available: ${e.message}`);
    }
  }

  return { fitAddon };
}

function ensureSearchAddon(paneId) {
  const id = String(paneId || '');
  if (!id) return null;
  const existing = searchAddons.get(id);
  if (existing) return existing;
  const terminal = terminals.get(id);
  if (!terminal) return null;

  try {
    const SearchAddon = getSearchAddonCtor();
    const searchAddon = new SearchAddon();
    terminal.loadAddon(searchAddon);
    searchAddons.set(id, searchAddon);
    return searchAddon;
  } catch (err) {
    log.warn(`Terminal ${id}`, `Search addon unavailable: ${err.message}`);
    return null;
  }
}

function fetchStartupHealthSummary(options = {}) {
  const context = normalizeStartupWindowContext(options.windowContext || startupWindowContext);
  const profileKey = getStartupProfileKey(context);
  const healthFileName = profileKey === 'main'
    ? 'startup-health.md'
    : `startup-health-${profileKey}.md`;
  const healthPath = resolveCoordPath(path.join('build', healthFileName));
  if (!healthPath || typeof fs.existsSync !== 'function' || !fs.existsSync(healthPath)) return '';
  try {
    if (typeof fs.readFileSync !== 'function') return '';
    return String(fs.readFileSync(healthPath, 'utf8') || '').trim();
  } catch (err) {
    log.warn('spawnAgent', `Startup health summary read failed: ${err.message}`);
    return '';
  }
}

function normalizeStartupContextValue(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function normalizeStartupScopeName(value) {
  const normalized = normalizeStartupContextValue(value, 'main').toLowerCase();
  return normalized.replace(/[^a-z0-9_-]+/g, '-') || 'main';
}

function normalizeStartupWindowContext(context = startupWindowContext) {
  const payload = context && typeof context === 'object' ? context : {};
  const windowKey = normalizeStartupScopeName(payload.windowKey || 'main');
  const profileName = normalizeStartupScopeName(payload.profileName || (windowKey !== 'main' ? windowKey : 'main'));
  return {
    loaded: payload.loaded === true,
    windowKey,
    windowTeam: normalizeStartupScopeName(payload.windowTeam || windowKey),
    profileName,
    profileLabel: normalizeStartupContextValue(payload.profileLabel, profileName === 'main' ? 'Main' : profileName),
    sessionScopeId: normalizeStartupContextValue(payload.sessionScopeId, ''),
    startupBundlePath: normalizeStartupContextValue(payload.startupBundlePath, ''),
    startupBundleReady: payload.startupBundleReady === true,
  };
}

function getStartupProfileKey(context = startupWindowContext) {
  const normalized = normalizeStartupWindowContext(context);
  if (normalized.windowKey !== 'main') return normalized.windowKey;
  return normalized.profileName || 'main';
}

function isSideStartupContext(context = startupWindowContext) {
  return getStartupProfileKey(context) !== 'main';
}

function setStartupWindowContext(context = {}) {
  startupWindowContext = normalizeStartupWindowContext(context);
  return { ...startupWindowContext };
}

function getCurrentRendererWindowKey() {
  const bodyWindowKey = typeof document !== 'undefined'
    ? String(document?.body?.dataset?.windowKey || '').trim().toLowerCase()
    : '';
  if (bodyWindowKey) return bodyWindowKey;
  return normalizeStartupWindowContext(startupWindowContext).windowKey;
}

function isSecondarySquidRoomMirrorPane(paneId) {
  const id = String(paneId || '').trim();
  if (!SQUID_ROOM_MIRRORED_TEAM_PANE_IDS.has(id)) return false;
  return getCurrentRendererWindowKey() === SQUID_ROOM_WINDOW_KEY;
}

function rendererOwnsPtyGeometry(paneId) {
  return !isSecondarySquidRoomMirrorPane(paneId);
}

function rendererOwnsStartupInjection(paneId) {
  const id = String(paneId || '').trim();
  if (!SQUID_ROOM_STARTUP_SHARED_PANE_IDS.has(id)) return true;
  const context = normalizeStartupWindowContext(startupWindowContext);
  return context.windowKey !== SQUID_ROOM_WINDOW_KEY;
}

function emitPtyGeometrySkipped(paneId, reason, payload = {}) {
  bus.emit('fit.skipped', {
    paneId,
    payload: {
      reason,
      windowKey: getCurrentRendererWindowKey(),
      ...payload,
    },
    source: TERMINAL_EVENT_SOURCE,
  });
}

function getStartupWindowContext() {
  return { ...startupWindowContext };
}

function readStartupBundleForContext(context = startupWindowContext) {
  const normalized = normalizeStartupWindowContext(context);
  if (!isSideStartupContext(normalized)) return '';
  if (!normalized.startupBundlePath || normalized.startupBundleReady !== true) {
    return [
      `SIDE-PROFILE STARTUP CONTEXT PENDING: ${normalized.profileLabel || normalized.profileName}`,
      '',
      `Profile: ${normalized.profileName}`,
      `Window: ${normalized.windowKey}`,
      normalized.sessionScopeId ? `Session Scope: ${normalized.sessionScopeId}` : '',
      'Main startup continuity intentionally omitted to prevent cross-profile lane leakage.',
    ].filter(Boolean).join('\n');
  }
  try {
    if (typeof fs.existsSync !== 'function' || !fs.existsSync(normalized.startupBundlePath)) {
      return [
        `SIDE-PROFILE STARTUP CONTEXT PENDING: ${normalized.profileLabel || normalized.profileName}`,
        '',
        `Profile: ${normalized.profileName}`,
        `Window: ${normalized.windowKey}`,
        normalized.sessionScopeId ? `Session Scope: ${normalized.sessionScopeId}` : '',
        `Bundle missing: ${normalized.startupBundlePath}`,
        'Main startup continuity intentionally omitted to prevent cross-profile lane leakage.',
      ].filter(Boolean).join('\n');
    }
    if (typeof fs.readFileSync !== 'function') return '';
    return String(fs.readFileSync(normalized.startupBundlePath, 'utf8') || '').trim();
  } catch (err) {
    log.warn('spawnAgent', `Side-profile startup bundle read failed: ${err.message}`);
    return '';
  }
}

function fetchStartupAiBriefing(options = {}) {
  const context = normalizeStartupWindowContext(options.windowContext || startupWindowContext);
  if (isSideStartupContext(context)) {
    return readStartupBundleForContext(context);
  }
  try {
    return readStartupBriefingForInjection({
      windowKey: context.windowKey,
      profileName: context.profileName,
      sessionScopeId: context.sessionScopeId,
    });
  } catch (err) {
    log.warn('spawnAgent', `Startup AI briefing read failed: ${err.message}`);
    return '';
  }
}

async function buildStartupIdentityMessage(paneId, options = {}) {
  const role = getPaneIdentityLabel(paneId);
  const d = new Date();
  const timestamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const header = `# SQUIDRUN SESSION: ${role} - Started ${timestamp}`;
  const runtimeOverride = getPaneRuntimeOverride(paneId);
  if (typeof runtimeOverride.startupMessage === 'string' && runtimeOverride.startupMessage.trim()) {
    return [header, runtimeOverride.startupMessage.trim()].join('\n');
  }
  const context = normalizeStartupWindowContext(options.windowContext || startupWindowContext);
  const [briefingSummary, healthSummary] = await Promise.all([
    Promise.resolve(fetchStartupAiBriefing({ windowContext: context })),
    Promise.resolve(fetchStartupHealthSummary({ windowContext: context })),
  ]);
  return [header, briefingSummary, healthSummary].filter(Boolean).join('\n');
}

async function runStartupIdentityAttempt(paneId, state, reason) {
  const id = String(paneId);
  const current = startupInjectionState.get(id);
  if (!current || current !== state || current.cancelled || current.completed) {
    return;
  }
  state.sendTimeoutId = null;

  if (!state.identityMsgPromise) {
    state.identityMsgPromise = buildStartupIdentityMessage(id)
      .catch((err) => {
        log.warn('spawnAgent', `Startup identity message build failed for pane ${id}: ${err.message}`);
        const role = getPaneIdentityLabel(id);
        const d = new Date();
        const timestamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        return `# SQUIDRUN SESSION: ${role} - Started ${timestamp}`;
      });
  }
  const identityMsg = await state.identityMsgPromise;
  state.identityMsg = identityMsg;
  state.attemptCount = (Number(state.attemptCount) || 0) + 1;
  const attempt = state.attemptCount;

  const maxAttempts = Math.max(1, Number(STARTUP_IDENTITY_MAX_ATTEMPTS) || 3);
  const retryDelayMs = Math.max(500, Number(STARTUP_IDENTITY_RETRY_DELAY_MS) || 2000);

  try {
    let deliveryMethod = 'send-to-pane';
    const sendResult = await sendStartupIdentityViaInjection(id, identityMsg);
    if (!sendResult?.success) {
      const sendError = buildStartupIdentitySendError(sendResult);
      if (sendResult?.applied === true) {
        state.identityPayloadApplied = true;
      }
      if (!state.isGemini || sendResult?.applied === true) {
        throw sendError;
      }
      // Gemini fallback: send direct PTY writes if injection queue rejects startup delivery.
      await window.squidrun.pty.write(id, identityMsg);
      await new Promise(resolve => setTimeout(resolve, 200));
      await window.squidrun.pty.write(id, '\r');
      deliveryMethod = 'gemini-raw-write-fallback';
    }

    // PTY write succeeded — trust the delivery. Scrollback verification is unreliable
    // (CLI consumes input before xterm buffer updates) and caused triple-delivery when
    // all retry attempts fired despite successful writes.
    state.completed = true;
    startupInjectionState.delete(id);
    log.info(
      'spawnAgent',
      `Identity injected for ${PANE_ROLES[id] || 'Pane ' + id} (pane ${id}) [ready:${reason}] [attempt:${attempt}/${maxAttempts}] [${deliveryMethod}]`
    );
  } catch (err) {
    log.error(
      'spawnAgent',
      `Identity injection failed for pane ${id} (attempt ${attempt}/${maxAttempts}): ${formatSerializedError(err)}`
    );
    const payloadAlreadyApplied = err?.applied === true || state.identityPayloadApplied === true;
    if (attempt < maxAttempts && !payloadAlreadyApplied) {
      scheduleStartupIdentityAttempt(id, state, reason, retryDelayMs);
    } else {
      state.completed = true;
      startupInjectionState.delete(id);
      const releaseReason = attempt >= maxAttempts
        ? 'exhausted_retries'
        : 'startup_identity_payload_already_applied';
      await releaseStartupInjectionArm(id, state, releaseReason);
      reportStartupIdentityTerminalFailure(id, err, releaseReason);
      if (attempt >= maxAttempts) {
        log.error('spawnAgent', `Identity injection exhausted retries for pane ${id} after ${maxAttempts} attempts`);
      } else {
        log.error('spawnAgent', `Identity injection stopped for pane ${id}: startup payload already applied`);
      }
    }
    return;
  }
}

function triggerStartupInjection(paneId, state, reason) {
  if (!state || state.completed || state.triggered) return;
  state.triggered = true;
  state.cancelled = false;
  if (state.timeoutId) {
    clearTimeout(state.timeoutId);
    state.timeoutId = null;
  }

  // Session 69 fix: Gemini needs longer delay - CLI takes longer to initialize input handling
  const identityDelayMs = state.isGemini ? 1000 : STARTUP_IDENTITY_DELAY_MS;
  const role = getPaneIdentityLabel(paneId);
  const d = new Date();
  const timestamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  state.identityMsg = `# SQUIDRUN SESSION: ${role} - Started ${timestamp}`;
  state.attemptCount = 0;

  scheduleStartupIdentityAttempt(String(paneId), state, reason, identityDelayMs);
}

async function claimStartupInjectionArm(paneId, options = {}) {
  const id = String(paneId);
  const context = normalizeStartupWindowContext(startupWindowContext);
  const payload = {
    paneId: id,
    source: options.source || 'unknown',
    modelType: options.modelType || 'claude',
    isGemini: Boolean(options.isGemini),
    windowKey: getCurrentRendererWindowKey(),
    profileName: context.profileName,
  };
  const apiClaim = window?.squidrun?.pty?.claimStartupInjection;
  if (typeof apiClaim === 'function') {
    return apiClaim(payload);
  }
  return invokeBridge(STARTUP_INJECTION_CLAIM_CHANNEL, payload);
}

async function releaseStartupInjectionArm(paneId, state, reason) {
  const id = String(paneId);
  const claimId = String(state?.startupClaimId || '').trim();
  if (!claimId) return false;
  const payload = {
    paneId: id,
    claimId,
    reason: reason || 'unspecified',
  };

  try {
    const apiRelease = window?.squidrun?.pty?.releaseStartupInjection;
    const result = typeof apiRelease === 'function'
      ? await apiRelease(payload)
      : await invokeBridge(STARTUP_INJECTION_RELEASE_CHANNEL, payload);
    if (!result?.released) {
      log.warn(
        'spawnAgent',
        `Startup injection claim release skipped for pane ${id}: ${result?.reason || 'not_released'}`
      );
    }
    return result?.released === true;
  } catch (err) {
    log.warn(
      'spawnAgent',
      `Startup injection claim release failed for pane ${id}: ${err?.message || err}`
    );
    return false;
  }
}

async function armStartupInjection(paneId, options = {}) {
  const id = String(paneId);
  let claimResult;
  try {
    claimResult = await claimStartupInjectionArm(id, options);
  } catch (err) {
    log.warn(
      'spawnAgent',
      `Startup injection claim failed for pane ${id}; refusing to arm (${err?.message || err})`
    );
    return false;
  }

  if (!claimResult || claimResult.claimed !== true) {
    log.info(
      'spawnAgent',
      `Startup injection claim denied for pane ${id}, skipping arm (${claimResult?.reason || 'claim_denied'})`
    );
    return false;
  }

  if (!options.force && hasPendingStartupInjection(id)) {
    log.info(
      'spawnAgent',
      `Startup injection already armed locally for pane ${id}, skipping duplicate arm (${options.source || 'unknown'})`
    );
    await releaseStartupInjectionArm(id, {
      startupClaimId: claimResult?.claim?.claimId,
    }, 'local_duplicate_arm');
    return false;
  }

  clearStartupInjection(id);
  const state = {
    buffer: '',
    completed: false,
    triggered: false,
    cancelled: false,
    modelType: options.modelType || 'claude',
    isGemini: Boolean(options.isGemini),
    source: options.source || 'unknown',
    attemptCount: 0,
    identityMsg: null,
    identityPayloadApplied: false,
    timeoutId: null,
    sendTimeoutId: null,
    startupClaimId: claimResult?.claim?.claimId || null,
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
  return true;
}

function handleStartupOutput(paneId, data) {
  const state = startupInjectionState.get(String(paneId));
  if (!state || state.completed || state.triggered) return;

  const cleaned = stripAnsiForStartup(data);
  if (cleaned) {
    state.buffer = (state.buffer + cleaned).slice(-STARTUP_READY_BUFFER_MAX);
  }

  // Gemini CLI takes 8-12s to start and its prompt is easily confused with shell prompt.
  // We ONLY trust patternReady (e.g. "how can i help" or a clean "> ") or timeout for Gemini.
  const promptReady = state.isGemini ? false : isPromptReady(paneId);
  // S125 fix: Filter patterns by model type. The PS prompt appears BEFORE Claude Code starts
  // (~300ms after spawn), causing identity injection to fire into the shell where `#` is a
  // comment and the message is silently ignored. Only check patterns valid for this model.
  const patternReady = STARTUP_READY_PATTERNS.some(({ pattern, models }) => {
    if (models && !models.includes(state.modelType)) return false;
    return pattern.test(state.buffer);
  });
  if (promptReady || patternReady) {
    triggerStartupInjection(paneId, state, promptReady ? 'prompt' : 'pattern');
  }
}

/**
 * Check if a pane's input is locked (view-only mode)
 * Locked panes block keyboard input but allow programmatic sends
 */
function isInputLocked(paneId) {
  if (isPaneReadOnlyMirrorMode(paneId)) return true;
  return inputLocked[paneId] === true;
}

/**
 * Toggle input lock state for a pane
 * Returns the new lock state (true = locked, false = unlocked)
 */
// SVG icons for lock states (Feather/Lucide style)
const LOCK_ICON_SVG = '<svg class="pane-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
const UNLOCK_ICON_SVG = '<svg class="pane-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>';

function resolveCoordFile(relPath, options = {}) {
  if (typeof resolveCoordPath === 'function') {
    return resolveCoordPath(relPath, options);
  }
  return path.join(WORKSPACE_PATH, relPath);
}

function getSnapshotSessionPath() {
  return resolveCoordFile(path.join('context-snapshots', '1.md'));
}

function getSessionNumberFromSnapshot() {
  try {
    const content = fs.readFileSync(getSnapshotSessionPath(), 'utf8');
    const direct = content.match(/Session:\s*(\d+)/i);
    if (direct) {
      const parsed = Number.parseInt(direct[1], 10);
      if (Number.isInteger(parsed) && parsed > 0) return parsed;
    }
    const header = content.match(/\|\s*Session\s+(\d+)\b/i);
    if (header) {
      const parsed = Number.parseInt(header[1], 10);
      if (Number.isInteger(parsed) && parsed > 0) return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function getSessionNumber() {
  return getSessionNumberFromSnapshot();
}

function updateIntentState(paneId, intent) {
  const id = String(paneId);
  const data = intentStateByPane.get(id) || {};
  const session = data.session ?? getSessionNumber();
  const role = data.role || PANE_ROLES[id] || `Pane ${id}`;
  const previousIntent = typeof data.intent === 'string' ? data.intent : '';
  const next = {
    ...data,
    pane: id,
    role,
    session,
    intent,
    last_update: new Date().toISOString(),
  };
  intentStateByPane.set(id, next);
  if (window?.squidrun?.intent?.update) {
    Promise.resolve(window.squidrun.intent.update({
      paneId: id,
      role,
      session,
      intent,
      previousIntent,
      source: 'terminal.js',
    }))
      .then((result) => {
        if (result?.ok === false) {
          log.warn('Intent', `Main-process intent update rejected for pane ${id}: ${result.reason || 'unknown'}`);
        }
      })
      .catch((err) => {
        log.warn('Intent', `Failed to update intent via main process for pane ${id}: ${err.message}`);
      });
    return;
  }
  log.warn('Intent', `Intent update IPC unavailable for pane ${id}`);
}

function toggleInputLock(paneId) {
  inputLocked[paneId] = !inputLocked[paneId];

  // Hidden pane host xterms do NOT have an onData bridge (by design —
  // see pane-host-renderer.js). Only the visible xterm's input bridge
  // calls pty.write(), so unlocking does NOT cause doubled keystrokes.
  // The user needs to unlock to interact with CLI prompts (plan mode,
  // permission dialogs, option selection).

  syncTerminalInputBridge(paneId);
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
  const nextLocked = Boolean(locked);
  inputLocked[paneId] = nextLocked;
  syncTerminalInputBridge(paneId);
  const lockIcon = document.getElementById(`lock-icon-${paneId}`);
  if (lockIcon) {
    lockIcon.innerHTML = nextLocked ? LOCK_ICON_SVG : UNLOCK_ICON_SVG;
    lockIcon.dataset.tooltip = nextLocked ? 'Locked (click to toggle)' : 'Unlocked (click to toggle)';
    lockIcon.classList.toggle('unlocked', !nextLocked);
  }
  log.info(`Terminal ${paneId}`, `Input ${nextLocked ? 'locked' : 'unlocked'}`);
}

/**
 * Track user typing for event bus emissions.
 * Emits typing.activity immediately, and typing.idle after TYPING_GUARD_MS of no typing.
 */
function trackTypingEvent(paneId) {
  bus.emit('typing.activity', {
    paneId,
    payload: {},
    source: TERMINAL_EVENT_SOURCE,
  });
  bus.updateState(paneId, { gates: { focusLocked: true } });

  if (typingIdleTimers[paneId]) {
    clearTimeout(typingIdleTimers[paneId]);
  }
  typingIdleTimers[paneId] = setTimeout(() => {
    bus.emit('typing.idle', {
      paneId,
      payload: {},
      source: TERMINAL_EVENT_SOURCE,
    });
    bus.updateState(paneId, { gates: { focusLocked: false } });
    typingIdleTimers[paneId] = null;
  }, TYPING_GUARD_MS);
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
  isGeminiPane,
  updatePaneStatus,
  updateConnectionStatus,
  getInjectionInFlight,
  userIsTyping,
  getInjectionHelpers: () => injectionController,
  spawnAgent,
  resetCodexIdentity,
  resetTerminalWriteQueue,
  syncTerminalInputBridge,
  markIgnoreNextExit,
  getPaneRuntimeOverride,
  buildPtyCreateOptionsForRuntimeOverride,
});

injectionController = createInjectionController({
  terminals,
  lastOutputTime,
  lastTypedTime,
  messageQueue,
  getPaneCapabilities: getPaneInjectionCapabilities,
  isCodexPane,
  isGeminiPane,
  buildCodexExecPrompt,
  userIsTyping,
  userInputFocused,
  updatePaneStatus,
  markPotentiallyStuck: recoveryController.markPotentiallyStuck,
  getInjectionInFlight,
  setInjectionInFlight,
  constants: {
    FOCUS_RETRY_DELAY_MS,
    MAX_FOCUS_RETRIES,
    QUEUE_RETRY_MS,
    INJECTION_LOCK_TIMEOUT_MS,
    TYPING_GUARD_MS,
    GEMINI_ENTER_DELAY_MS,
    SUBMIT_ACCEPT_MAX_ATTEMPTS,
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

// Initialize contracts (registers enforced + shadow contracts on the bus)
contracts.init(bus);

function runPromotionCheck() {
  const promoted = contractPromotion.checkPromotions();
  contractPromotion.saveStats();
  if (promoted.length > 0) {
    log.info('ContractPromotion', `Promoted ${promoted.length} contract(s): ${promoted.join(', ')}`);
  }
  return promoted;
}

function stopPromotionCheckTimer() {
  if (promotionCheckTimer) {
    clearInterval(promotionCheckTimer);
    promotionCheckTimer = null;
  }
}

function startPromotionCheckTimer() {
  stopPromotionCheckTimer();
  promotionCheckTimer = setInterval(() => {
    try {
      runPromotionCheck();
    } catch (err) {
      log.error('ContractPromotion', 'Periodic promotion check failed', err);
    }
  }, PROMOTION_CHECK_INTERVAL_MS);

  // In Node/Jest contexts, avoid keeping the process alive just for this timer.
  if (promotionCheckTimer && typeof promotionCheckTimer.unref === 'function') {
    promotionCheckTimer.unref();
  }
}

function initPromotionEngine() {
  contractPromotion.init(bus);

  for (const contract of contracts.SHADOW_CONTRACTS || []) {
    contractPromotion.incrementSession(contract.id);
  }

  runPromotionCheck();
  startPromotionCheckTimer();
}

initPromotionEngine();

// Initialize transition ledger scaffold (phase 2 transition objects)
transitionLedger.init(bus);

// Initialize compaction detector (subscribes to inject.requested events on the bus)
compactionDetector.init(bus);

function sendEnterToPane(...args) {
  return injectionController.sendEnterToPane(...args);
}

function isPromptReady(...args) {
  return injectionController.isPromptReady(...args);
}


function sendToPane(paneId, message, options = {}) {
  const id = String(paneId);
  const useHiddenPaneHostRoute = (
    isHiddenPaneHostPane(id)
    && window?.squidrun?.paneHost?.inject
    && options?.startupInjection !== true
  );
  if (useHiddenPaneHostRoute) {
    const hiddenPaneRuntimeKey = classifyRuntimeFromIdentity(id);
    const hiddenPaneCodex = hiddenPaneRuntimeKey === 'codex' || isCodexPane(id);
    Promise.resolve(window.squidrun.paneHost.inject(id, {
      message: String(message || ''),
      traceContext: options?.traceContext || null,
      deliveryId: options?.deliveryId || null,
      meta: {
        ...((options?.meta && typeof options.meta === 'object') ? options.meta : {}),
        runtimeHint: hiddenPaneRuntimeKey,
        codexPane: hiddenPaneCodex,
      },
    }))
      .then((result) => {
        if (result?.success === false) {
          return injectionController.sendToPane(id, message, options);
        }
        if (typeof options?.onComplete === 'function') {
          const verified = result?.verified === true;
          options.onComplete({
            success: true,
            verified,
            routePending: !verified,
            signal: 'pane_host_inject',
            status: verified ? (result?.status || 'delivered.verified') : 'pane_host_route_pending',
            reason: verified ? null : (result?.reason || 'hidden_pane_host_delivery_pending'),
          });
        }
      })
      .catch((err) => {
        log.warn(`Terminal ${id}`, `Pane host inject failed; falling back to renderer path: ${err.message}`);
        injectionController.sendToPane(id, message, options);
      });
    return;
  }
  return injectionController.sendToPane(id, message, options);
}

function withFreshSpawnInitTimeout(paneId, promise) {
  let timeoutId = null;
  const guarded = Promise.resolve(promise)
    .then(() => ({ paneId, ok: true }))
    .catch((err) => ({ paneId, ok: false, error: err }));
  const timeout = new Promise((resolve) => {
    timeoutId = setTimeout(() => {
      resolve({ paneId, ok: false, timedOut: true });
    }, FRESH_SPAWN_INIT_TIMEOUT_MS);
  });
  return Promise.race([guarded, timeout]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
}

// Initialize all terminals
async function initTerminals(options = {}) {
  const initOptions = options && typeof options === 'object' ? options : {};
  const missingPaneIds = getActivePaneIds().filter((paneId) => !terminals.has(paneId));
  if (initOptions.spawnCommandOnCreate === true) {
    const results = await Promise.all(missingPaneIds.map((paneId) => {
      const promise = initTerminal(paneId, { spawnCommandOnCreate: true });
      return withFreshSpawnInitTimeout(paneId, promise);
    }));
    for (const result of results) {
      if (result.timedOut) {
        log.warn('Terminal', `Fresh command-on-create init timed out for pane ${result.paneId}; continuing with other panes`);
      } else if (result.ok === false) {
        log.error(`Terminal ${result.paneId}`, 'Fresh command-on-create init failed', result.error);
      }
    }
  } else {
    for (const paneId of missingPaneIds) {
      if (terminals.has(paneId)) continue;
      await initTerminal(paneId);
    }
  }
  updateConnectionStatus('All terminals ready');
  focusPane(getActivePaneIds()[0] || '1');
  startStuckMessageSweeper();
}

let activeTerminalContextMenu = null;
let activeTerminalContextMenuCleanup = null;

function dismissTerminalContextMenu() {
  if (typeof activeTerminalContextMenuCleanup === 'function') {
    try {
      activeTerminalContextMenuCleanup();
    } catch (_) {}
  }
  activeTerminalContextMenuCleanup = null;
  if (activeTerminalContextMenu && activeTerminalContextMenu.parentNode) {
    activeTerminalContextMenu.parentNode.removeChild(activeTerminalContextMenu);
  }
  activeTerminalContextMenu = null;
}

function isCopyShortcut(event) {
  const key = String(event?.key || '').toLowerCase();
  return (event?.ctrlKey || event?.metaKey) && !event?.altKey && key === 'c';
}

function isPasteShortcut(event) {
  const key = String(event?.key || '').toLowerCase();
  return (event?.ctrlKey || event?.metaKey) && !event?.altKey && key === 'v';
}

function showTerminalStatusTemporary(paneId, statusMsg, message) {
  updatePaneStatus(paneId, message);
  setTimeout(() => updatePaneStatus(paneId, statusMsg), 1000);
}

async function copyTerminalSelection(terminal, paneId, statusMsg, selectionOverride = null) {
  const selection = typeof selectionOverride === 'string'
    ? selectionOverride
    : getTerminalSelectionSnapshot(terminal);
  if (!selection) return false;
  try {
    if (typeof window?.squidrun?.pty?.clipboardWriteText !== 'function') {
      throw new Error('IPC clipboard-write channel unavailable');
    }
    const result = await window.squidrun.pty.clipboardWriteText(selection);
    if (result && result.success === false) {
      throw new Error(result.error || 'clipboard-write failed');
    }
    showTerminalStatusTemporary(paneId, statusMsg, 'Copied!');
    log.info('Clipboard', `Copied ${selection.length} chars from pane ${paneId}`);
    return true;
  } catch (err) {
    log.error('Clipboard', `Copy failed for pane ${paneId}:`, err);
    showTerminalStatusTemporary(paneId, statusMsg, 'Copy failed');
    return false;
  }
}

function getTerminalSelectionSnapshot(terminal) {
  if (!terminal?.hasSelection?.()) return '';
  const selection = terminal.getSelection();
  return typeof selection === 'string' ? selection : String(selection ?? '');
}

async function pasteClipboardToPane(paneId, statusMsg) {
  // Keep read-only panes truly read-only for keyboard/mouse input.
  if (inputLocked[paneId]) return false;
  try {
    const text = await navigator.clipboard.readText();
    if (!text) return false;
    await window.squidrun.pty.write(paneId, text);
    showTerminalStatusTemporary(paneId, statusMsg, 'Pasted!');
    log.info('Clipboard', `Pasted ${text.length} chars to pane ${paneId}`);
    return true;
  } catch (err) {
    log.error('Paste', `Paste failed for pane ${paneId}:`, err);
    showTerminalStatusTemporary(paneId, statusMsg, 'Paste failed');
    return false;
  }
}

function createContextMenuItem(label, shortcut, disabled, onClick) {
  const item = document.createElement('div');
  item.className = `context-menu-item${disabled ? ' disabled' : ''}`;
  item.setAttribute('role', 'menuitem');
  item.setAttribute('tabindex', disabled ? '-1' : '0');

  const icon = document.createElement('span');
  icon.className = 'icon';
  icon.textContent = '';
  item.appendChild(icon);

  const text = document.createElement('span');
  text.textContent = label;
  item.appendChild(text);

  if (shortcut) {
    const badge = document.createElement('span');
    badge.className = 'shortcut';
    badge.textContent = shortcut;
    item.appendChild(badge);
  }

  if (!disabled && typeof onClick === 'function') {
    item.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick();
    });
  }

  return item;
}

function openTerminalContextMenu(event, terminal, paneId, statusMsg, signal, capturedSelection = '') {
  dismissTerminalContextMenu();

  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.setAttribute('role', 'menu');

  const selection = typeof capturedSelection === 'string'
    ? capturedSelection
    : getTerminalSelectionSnapshot(terminal);
  const hasSelection = Boolean(selection);
  const allowPaste = !inputLocked[paneId];

  menu.appendChild(createContextMenuItem('Copy', 'Ctrl+C', !hasSelection, () => {
    void copyTerminalSelection(terminal, paneId, statusMsg, selection);
    dismissTerminalContextMenu();
  }));
  menu.appendChild(createContextMenuItem('Paste', 'Ctrl+V', !allowPaste, () => {
    void pasteClipboardToPane(paneId, statusMsg);
    dismissTerminalContextMenu();
  }));
  menu.appendChild(createContextMenuItem('Select All', 'Ctrl+A', false, () => {
    if (typeof terminal?.selectAll === 'function') {
      terminal.selectAll();
    }
    dismissTerminalContextMenu();
  }));

  document.body.appendChild(menu);
  activeTerminalContextMenu = menu;

  const rect = menu.getBoundingClientRect();
  const maxLeft = Math.max(0, window.innerWidth - rect.width - 8);
  const maxTop = Math.max(0, window.innerHeight - rect.height - 8);
  const left = Math.max(8, Math.min(event.clientX, maxLeft));
  const top = Math.max(8, Math.min(event.clientY, maxTop));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  const onPointerDown = (pointerEvent) => {
    if (!menu.contains(pointerEvent.target)) {
      dismissTerminalContextMenu();
    }
  };
  const onKeyDown = (keyEvent) => {
    if (keyEvent.key === 'Escape') {
      dismissTerminalContextMenu();
    }
  };
  const onWindowBlur = () => dismissTerminalContextMenu();

  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('contextmenu', onPointerDown, true);
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('blur', onWindowBlur, true);

  activeTerminalContextMenuCleanup = () => {
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('contextmenu', onPointerDown, true);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('blur', onWindowBlur, true);
  };

  if (signal && typeof signal.addEventListener === 'function') {
    signal.addEventListener('abort', dismissTerminalContextMenu, { once: true });
  }
}

// Setup copy/paste handlers
function setupCopyPaste(container, terminal, paneId, statusMsg, { signal } = {}) {
  let contextMenuSelection = '';

  container.addEventListener('pointerdown', (event) => {
    if (event?.button !== 2) return;
    contextMenuSelection = getTerminalSelectionSnapshot(terminal);
  }, { signal, capture: true });

  container.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const capturedSelection = contextMenuSelection || getTerminalSelectionSnapshot(terminal);
    contextMenuSelection = '';
    openTerminalContextMenu(event, terminal, paneId, statusMsg, signal, capturedSelection);
  }, { signal });

  container.addEventListener('keydown', (event) => {
    if (isCopyShortcut(event)) {
      event.preventDefault();
      event.stopPropagation();
      void copyTerminalSelection(terminal, paneId, statusMsg);
      return;
    }

    if (isPasteShortcut(event)) {
      event.preventDefault();
      event.stopPropagation();
      void pasteClipboardToPane(paneId, statusMsg);
    }
  }, { signal, capture: true });
}

  // Initialize a single terminal
  async function initTerminal(paneId, options = {}) {
    if (terminals.has(paneId)) return;
    const container = document.getElementById(`terminal-${paneId}`);
    if (!container) return;
  const runtimeOverride = getPaneRuntimeOverride(paneId);
  const workingDir = String(
    options.workingDir
    || options.cwd
    || runtimeOverride.workingDir
    || runtimeOverride.cwd
    || process.cwd()
  );
  teardownTerminalPane(paneId);

  // Create AbortController for this pane's container DOM listeners (destroy-before-setup)
  const paneAbortController = new AbortController();
  paneListenerAbortControllers.set(paneId, paneAbortController);
  const { signal: paneSignal } = paneAbortController;

  const terminal = createTerminalInstance();
  const { fitAddon } = setupTerminalAddons(paneId, terminal, container);
  attachTerminalScrollProbeTarget(paneId, container, terminal);

  terminal.open(container);
  if (rendererOwnsPtyGeometry(paneId)) {
    fitTerminalForPane(paneId, fitAddon, 'initial_fit');
  } else {
    emitPtyGeometrySkipped(paneId, 'secondary_squid_room_mirror_geometry_blocked', {
      operation: 'initial_fit',
    });
  }
  const agentColorDisposable = attachAgentColors(paneId, terminal);
  if (agentColorDisposable) { agentColorDisposers.set(paneId, agentColorDisposable); }

  // Sync PTY size to fitted terminal dimensions (PTY spawns at 80x24 by default)
  if (rendererOwnsPtyGeometry(paneId)) {
    try {
      applyTerminalPtyResize(paneId, terminal, {
        operation: 'initial_resize',
        forceApply: true,
      });
    } catch (err) {
      log.warn(`Terminal ${paneId}`, 'Initial PTY resize failed (PTY may not exist yet):', err);
    }
  } else {
    emitPtyGeometrySkipped(paneId, 'secondary_squid_room_mirror_geometry_blocked', {
      operation: 'initial_resize',
    });
  }

  // Critical: block keyboard input when user is typing in a UI input/textarea
  // BUT allow xterm's own internal textarea (xterm-helper-textarea) to work normally
  terminal.attachCustomKeyEventHandler((event) => {
    // Track actual user typing (single chars, no modifiers)
    if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
      lastTypedTime[paneId] = Date.now();
      trackTypingEvent(paneId);
    }

    // Check if this is an Enter key (browsers use 'Enter', some use 'Return', keyCode 13)
    const isEnterKey = event.key === 'Enter' || event.key === 'Return' || event.keyCode === 13;
    if (isCopyShortcut(event) || isPasteShortcut(event)) {
      // Always keep Ctrl/Cmd+C and Ctrl/Cmd+V as OS copy/paste, never terminal input/SIGINT.
      return false;
    }

    if (handleTerminalKeyboardScroll(paneId, terminal, event)) {
      return false;
    }

    if (isPaneReadOnlyMirrorMode(paneId)) {
      if (event.ctrlKey && event.key.toLowerCase() === 'f') {
        openTerminalSearch(paneId);
      }
      const bypassed = isEnterKey && (event._squidrunBypass || terminal._squidrunBypass);
      return Boolean(bypassed);
    }

    // CRITICAL: SquidRun bypass check MUST come FIRST, before lock check
    // This allows programmatic Enter from sendTrustedEnter to bypass input lock
    // Note: sendInputEvent may produce isTrusted=true OR isTrusted=false depending on Electron version
    if (isEnterKey && (event._squidrunBypass || terminal._squidrunBypass)) {
      log.info(`Terminal ${paneId}`, `Allowing programmatic Enter (squidrun bypass, key=${event.key}, isTrusted=${event.isTrusted})`);
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

  setupCopyPaste(container, terminal, paneId, 'Connected', { signal: paneSignal });
  setupTerminalWheelScrollGuard(paneId, container, terminal, { signal: paneSignal });

  terminals.set(paneId, terminal);
  fitAddons.set(paneId, fitAddon);

  // Setup ResizeObserver to auto-resize terminal when container size changes
  setupResizeObserver(paneId);
  scheduleTerminalAttachPaintRefresh(paneId, terminal, fitAddon);

  try {
    const recreatedForWorkingDir = await recreatePaneOnWorkingDirMismatch(paneId, workingDir, runtimeOverride, {
      snapshotTimeoutMs: options.snapshotTimeoutMs,
      recreateDelayMs: options.recreateDelayMs,
    });
    let ptyCreateOptions = buildPtyCreateOptionsForRuntimeOverride(paneId, runtimeOverride, workingDir);
    ptyCreateOptions = applyFreshCreateSpawnCommandOptions(paneId, ptyCreateOptions, options);
    if (Object.keys(ptyCreateOptions).length > 0) {
      await window.squidrun.pty.create(paneId, workingDir, ptyCreateOptions);
    } else {
      await window.squidrun.pty.create(paneId, workingDir);
    }
    updatePaneStatus(paneId, 'Connected');
    if (runtimeOverride.spawnCommandOnCreate === true && runtimeOverride.command) {
      const commandText = String(runtimeOverride.command || '').trim().toLowerCase();
      const modelType = commandText.includes('gemini') ? 'gemini' : commandText.includes('codex') ? 'codex' : 'claude';
      await armStartupInjection(paneId, {
        modelType,
        isGemini: modelType === 'gemini',
        source: 'spawn-command-on-create',
      });
    }

    // Now that PTY exists, sync size again (initial resize may have fired before PTY was created)
    if (rendererOwnsPtyGeometry(paneId)) {
      try {
        fitTerminalForPane(paneId, fitAddon, 'post_create_sync');
        applyTerminalPtyResize(paneId, terminal, {
          operation: 'post_create_sync',
          forceApply: true,
        });
        log.info(`Terminal ${paneId}`, `PTY size synced: ${terminal.cols}x${terminal.rows}`);
      } catch (resizeErr) {
        log.warn(`Terminal ${paneId}`, 'Post-create PTY resize failed:', resizeErr);
      }
    } else {
      emitPtyGeometrySkipped(paneId, 'secondary_squid_room_mirror_geometry_blocked', {
        operation: 'post_create_sync',
      });
    }

    let restoredScrollback = '';
    if (typeof options.scrollback === 'string') {
      restoredScrollback = options.scrollback;
    } else if (
      !recreatedForWorkingDir.recreated
      && shouldRestoreDaemonScrollbackOnCreate(paneId, options)
    ) {
      restoredScrollback = await readDaemonScrollbackForPane(paneId, { timeoutMs: options.snapshotTimeoutMs });
    }
    if (restoredScrollback && restoredScrollback.length > 0) {
      queueTerminalWrite(paneId, terminal, trimScrollbackToMaxLines(restoredScrollback));
      scheduleTerminalAttachPaintRefresh(paneId, terminal, fitAddon);
    }

    syncTerminalInputBridge(paneId);

    detachPtyListeners(paneId);
    const disposeOnData = window.squidrun.pty.onData(paneId, (data) => {
      void maybeRecoverClaudeSessionCollision(paneId, data);
      // Use flow control to prevent xterm buffer overflow
      queueTerminalWrite(paneId, terminal, data);
      // Track output time for idle detection - only for meaningful activity
      // This ensures spinners/ANSI don't block programmatic injections
      if (isMeaningfulActivity(data)) {
        lastOutputTime[paneId] = Date.now();
      }
      // Feed PTY output to compaction detector for multi-signal analysis
      compactionDetector.processChunk(paneId, data);
      // Clear stuck status - output means pane is working
      clearStuckStatus(paneId);
      handleStartupOutput(paneId, data);
    });
    if (typeof disposeOnData === 'function') {
      ptyDataListenerDisposers.set(String(paneId), disposeOnData);
    }

  const disposeOnExit = window.squidrun.pty.onExit(paneId, (code) => {
    if (shouldIgnoreExit(paneId)) {
      log.info('Terminal', `Ignoring exit for pane ${paneId} (restart in progress)`);
      return;
    }
    updatePaneStatus(paneId, `Exited (${code})`);
    queueTerminalWrite(paneId, terminal, `\r\n[Process exited with code ${code}]\r\n`);
    clearStartupInjection(paneId);
    updateIntentState(paneId, 'Offline');
  });
    if (typeof disposeOnExit === 'function') {
      ptyExitListenerDisposers.set(String(paneId), disposeOnExit);
    }

    if (recreatedForWorkingDir.recreated && options.repaintAfterRecreate !== false) {
      scheduleDaemonScrollbackRepaint(paneId, { timeoutMs: options.snapshotTimeoutMs });
    }

  } catch (err) {
    log.error(`Terminal ${paneId}`, 'Failed to create PTY', err);
    updatePaneStatus(paneId, 'Error');
    queueTerminalWrite(paneId, terminal, `\r\n[Error: ${err.message}]\r\n`);
  }

  container.addEventListener('click', () => {
    focusPane(paneId);
  }, { signal: paneSignal });
}

// Reattach to existing terminal (daemon reconnection)
// U1: scrollback parameter contains buffered output to restore
async function reattachTerminal(paneId, scrollback, options = {}) {
  const container = document.getElementById(`terminal-${paneId}`);
  if (!container) return;

  if (terminals.has(paneId)) {
    log.info(`Terminal ${paneId}`, 'Already attached, skipping');
    return;
  }

  const runtimeOverride = getPaneRuntimeOverride(paneId);
  const workingDir = String(
    runtimeOverride.workingDir
    || runtimeOverride.cwd
    || ''
  );
  const daemonTerminal = options.daemonTerminal && typeof options.daemonTerminal === 'object'
    ? options.daemonTerminal
    : {
      paneId,
      alive: true,
      cwd: options.cwd || options.workingDir || null,
    };
  const recreatedForWorkingDir = await recreatePaneOnWorkingDirMismatch(paneId, workingDir, runtimeOverride, {
    snapshotTimeoutMs: options.snapshotTimeoutMs,
    recreateDelayMs: options.recreateDelayMs,
    daemonTerminal,
  });
  if (recreatedForWorkingDir.recreated) {
    await initTerminal(paneId, {
      workingDir,
      scrollback: '',
      snapshotTimeoutMs: options.snapshotTimeoutMs,
      recreateDelayMs: options.recreateDelayMs,
      repaintAfterRecreate: options.repaintAfterRecreate,
    });
    if (runtimeOverride.command && options.spawnAfterRecreate !== false) {
      await spawnAgent(paneId);
    }
    return;
  }

  teardownTerminalPane(paneId);

  // Create AbortController for this pane's container DOM listeners (destroy-before-setup)
  const paneAbortController = new AbortController();
  paneListenerAbortControllers.set(paneId, paneAbortController);
  const { signal: paneSignal } = paneAbortController;

  const terminal = createTerminalInstance();
  const { fitAddon } = setupTerminalAddons(paneId, terminal, container);
  attachTerminalScrollProbeTarget(paneId, container, terminal);

  terminal.open(container);
  if (rendererOwnsPtyGeometry(paneId)) {
    fitTerminalForPane(paneId, fitAddon, 'reattach_fit');
  } else {
    emitPtyGeometrySkipped(paneId, 'secondary_squid_room_mirror_geometry_blocked', {
      operation: 'reattach_fit',
    });
  }
  const agentColorDisposable = attachAgentColors(paneId, terminal);
  if (agentColorDisposable) { agentColorDisposers.set(paneId, agentColorDisposable); }

  // Sync PTY size to fitted terminal dimensions (PTY already exists during reattach)
  if (rendererOwnsPtyGeometry(paneId)) {
    try {
      applyTerminalPtyResize(paneId, terminal, {
        operation: 'reattach_resize',
        forceApply: true,
      });
      log.info(`Terminal ${paneId}`, `Reattach PTY size synced: ${terminal.cols}x${terminal.rows}`);
    } catch (err) {
      log.warn(`Terminal ${paneId}`, 'Reattach PTY resize failed:', err);
    }
  } else {
    emitPtyGeometrySkipped(paneId, 'secondary_squid_room_mirror_geometry_blocked', {
      operation: 'reattach_resize',
    });
  }

  // Critical: block keyboard input when user is typing in a UI input/textarea
  // BUT allow xterm's own internal textarea (xterm-helper-textarea) to work normally
  terminal.attachCustomKeyEventHandler((event) => {
    // Track actual user typing (single chars, no modifiers)
    if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
      lastTypedTime[paneId] = Date.now();
      trackTypingEvent(paneId);
    }

    // Check if this is an Enter key (browsers use 'Enter', some use 'Return', keyCode 13)
    const isEnterKey = event.key === 'Enter' || event.key === 'Return' || event.keyCode === 13;
    if (isCopyShortcut(event) || isPasteShortcut(event)) {
      // Keep Ctrl/Cmd+C and Ctrl/Cmd+V as clipboard actions, never terminal input/SIGINT.
      return false;
    }

    if (handleTerminalKeyboardScroll(paneId, terminal, event)) {
      return false;
    }

    if (isPaneReadOnlyMirrorMode(paneId)) {
      if (event.ctrlKey && event.key.toLowerCase() === 'f') {
        openTerminalSearch(paneId);
      }
      const bypassed = isEnterKey && (event._squidrunBypass || terminal._squidrunBypass);
      return Boolean(bypassed);
    }

    // CRITICAL: SquidRun bypass check MUST come FIRST, before lock check
    // This allows programmatic Enter from sendTrustedEnter to bypass input lock
    // Note: sendInputEvent may produce isTrusted=true OR isTrusted=false depending on Electron version
    if (isEnterKey && (event._squidrunBypass || terminal._squidrunBypass)) {
      log.info(`Terminal ${paneId}`, `Allowing programmatic Enter (squidrun bypass, key=${event.key}, isTrusted=${event.isTrusted})`);
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

  setupCopyPaste(container, terminal, paneId, 'Reconnected', { signal: paneSignal });
  setupTerminalWheelScrollGuard(paneId, container, terminal, { signal: paneSignal });

  terminals.set(paneId, terminal);
  fitAddons.set(paneId, fitAddon);

  // Setup ResizeObserver to auto-resize terminal when container size changes
  setupResizeObserver(paneId);
  scheduleTerminalAttachPaintRefresh(paneId, terminal, fitAddon);

  // U1: Restore scrollback buffer if available
  if (scrollback && scrollback.length > 0) {
    queueTerminalWrite(paneId, terminal, trimScrollbackToMaxLines(scrollback));
    scheduleTerminalAttachPaintRefresh(paneId, terminal, fitAddon);
  }

  syncTerminalInputBridge(paneId);

  detachPtyListeners(paneId);
  const disposeOnData = window.squidrun.pty.onData(paneId, (data) => {
    void maybeRecoverClaudeSessionCollision(paneId, data);
    // Use flow control to prevent xterm buffer overflow
    queueTerminalWrite(paneId, terminal, data);
    // Track output time for idle detection - only for meaningful activity
    // This ensures spinners/ANSI don't block programmatic injections
    if (isMeaningfulActivity(data)) {
      lastOutputTime[paneId] = Date.now();
    }
    // Feed PTY output to compaction detector for multi-signal analysis
    compactionDetector.processChunk(paneId, data);
    // Clear stuck status - output means pane is working
    clearStuckStatus(paneId);
    handleStartupOutput(paneId, data);
  });
  if (typeof disposeOnData === 'function') {
    ptyDataListenerDisposers.set(String(paneId), disposeOnData);
  }

    const disposeOnExit = window.squidrun.pty.onExit(paneId, (code) => {
      if (shouldIgnoreExit(paneId)) {
        log.info('Terminal', `Ignoring exit for pane ${paneId} (restart in progress)`);
        return;
      }
      updatePaneStatus(paneId, `Exited (${code})`);
      queueTerminalWrite(paneId, terminal, `\r\n[Process exited with code ${code}]\r\n`);
      clearStartupInjection(paneId);
      updateIntentState(paneId, 'Offline');
    });
  if (typeof disposeOnExit === 'function') {
    ptyExitListenerDisposers.set(String(paneId), disposeOnExit);
  }

  // Ensure Architect startup identity can still be injected on reattach
  // when no prior startup marker exists (e.g. reconnect edge cases).
  // Guardrails:
  // - Pane 1 only (do not re-trigger Builder/Oracle startup on light reloads)
  // - Skip if terminal has been alive for >60s (injection cycle already completed or failed)
  // - Skip if identity marker is already present in scrollback
  const terminalAge = options.createdAt ? (Date.now() - options.createdAt) : Infinity;
  const shouldArmStartupOnReattach =
    String(paneId) === '1' &&
    rendererOwnsStartupInjection(paneId) &&
    terminalAge < FRESH_STARTUP_INJECTION_WINDOW_MS &&
    !hasStartupSessionHeader(scrollback, paneId);
  if (shouldArmStartupOnReattach) {
    const { modelType, isGemini } = getStartupModelForPane(paneId);
    const armed = await armStartupInjection(paneId, { modelType, isGemini, source: 'reattach' });
    // Seed detector with restored scrollback so ready-pattern detection can fire
    // immediately instead of waiting for new daemon output.
    if (armed && scrollback && scrollback.length > 0) {
      handleStartupOutput(paneId, scrollback);
    }
    if (armed) {
      log.info('spawnAgent', `Reattach armed startup injection for pane ${paneId}`);
    }
  }

  updatePaneStatus(paneId, 'Reconnected');

  container.addEventListener('click', () => {
    focusPane(paneId);
  }, { signal: paneSignal });
}

// Focus a specific pane
function focusPane(paneId) {
  const prevPane = focusedPane;
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

  if (prevPane !== paneId) {
    bus.emit('focus.changed', {
      paneId: paneId,
      payload: { prevPane, newPane: paneId },
      source: TERMINAL_EVENT_SOURCE,
    });
  }
}

// Blur all terminals - used when input fields get focus
function blurAllTerminals() {
  for (const terminal of terminals.values()) {
    if (terminal && terminal.blur) {
      terminal.blur();
    }
  }
}


// Send user command-bar messages to the Architect pane.
// User messages get PRIORITY + IMMEDIATE - bypass queue ordering AND idle gating
const USER_BROADCAST_CLIPBOARD_PASTE_THRESHOLD_BYTES = 1024;

function broadcast(message, options = {}) {
  const messageText = typeof message === 'string' ? message.trim() : String(message ?? '').trim();
  if (messageText) {
    const userMessageId = `user-ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      Promise.resolve(invokeBridge('evidence-ledger:upsert-comms-journal', {
        messageId: userMessageId,
        sessionId: null,
        senderRole: 'user',
        targetRole: 'architect',
        channel: 'user',
        direction: 'outbound',
        sentAtMs: Date.now(),
        rawBody: messageText,
        status: 'recorded',
        attempt: 1,
        metadata: {
          source: 'ui.broadcast',
        },
      }))
        .then((journalResult) => {
          if (journalResult?.ok !== true) {
            log.warn('Terminal', `User message journal write unavailable: ${journalResult?.reason || 'unknown'}`);
          }
        })
        .catch((err) => {
          log.warn('Terminal', `User message journal write unavailable: ${err?.message || 'unknown'}`);
        });
    } catch (err) {
      log.warn('Terminal', `User message journal write unavailable: ${err?.message || 'unknown'}`);
    }
  }

  sendToPane('1', messageText || String(message ?? ''), {
    priority: true,
    immediate: true,
    preferClipboardPasteForLongMessage: true,
    clipboardPasteThresholdBytes: USER_BROADCAST_CLIPBOARD_PASTE_THRESHOLD_BYTES,
    ...options,
  });
  updateConnectionStatus('Message sent to Architect');
}

function rememberClaudeSessionCollisionRecovery(paneId, command) {
  const id = String(paneId || '');
  const commandText = String(command || '').trim();
  const sessionId = extractClaudeSessionIdFromCommand(commandText);
  if (!id || !sessionId || !/^claude(?:\s|$)/i.test(commandText)) {
    pendingClaudeSessionCollisionRecovery.delete(id);
    return;
  }
  pendingClaudeSessionCollisionRecovery.set(id, {
    command: commandText,
    sessionId,
    startedAt: Date.now(),
    attempted: false,
  });
}

async function maybeRecoverClaudeSessionCollision(paneId, data) {
  const id = String(paneId || '');
  const pending = pendingClaudeSessionCollisionRecovery.get(id);
  if (!pending || pending.attempted) return;
  if ((Date.now() - pending.startedAt) > 30000) {
    pendingClaudeSessionCollisionRecovery.delete(id);
    return;
  }
  if (!isClaudeSessionInUseError(stripAnsiCodes(String(data || '')))) return;

  pending.attempted = true;
  updatePaneStatus(id, 'Recovering session...');
  log.warn('spawnAgent', `Claude session ${pending.sessionId} already in use for pane ${id}; reminting and retrying`);

  let result;
  try {
    result = await window.squidrun.claude.spawn(id, undefined, {
      remintClaudeSessionId: true,
      collisionRecoveryForSessionId: pending.sessionId,
    });
  } catch (err) {
    log.error(`spawnAgent ${id}`, 'Claude collision recovery remint failed:', err);
    updatePaneStatus(id, 'Spawn failed');
    return;
  }

  if (!result?.success || !result.command) {
    log.error(`spawnAgent ${id}`, 'Claude collision recovery did not return a command:', result);
    updatePaneStatus(id, 'Spawn failed');
    return;
  }

  rememberClaudeSessionCollisionRecovery(id, result.command);
  const next = pendingClaudeSessionCollisionRecovery.get(id);
  if (next) next.attempted = true;

  try {
    await window.squidrun.pty.write(id, '\r');
    await new Promise(resolve => setTimeout(resolve, 150));
    await window.squidrun.pty.write(id, result.command);
    await new Promise(resolve => setTimeout(resolve, 100));
    await window.squidrun.pty.write(id, '\r');
    log.info('spawnAgent', `Claude pane ${id}: retried with reminted session after in-use collision`);
    await armStartupInjection(id, {
      modelType: 'claude',
      isGemini: false,
      source: 'spawn-claude-remint',
    });
    updatePaneStatus(id, 'Working');
  } catch (err) {
    log.error(`spawnAgent ${id}`, 'Claude collision recovery retry failed:', err);
    updatePaneStatus(id, 'Spawn failed');
  }
}

// Spawn agent CLI in a pane
// model param: optional override for model type (used by model switch to bypass stale cache)
async function spawnAgent(paneId, model = null, options = {}) {
  // Defense in depth: Early exit if no terminal exists for this pane
  // This catches race conditions where terminal creation is still in progress but
  // user somehow triggers spawn before UI fully updates
  if (!terminals.has(paneId)) {
    log.info('spawnAgent', `No terminal for pane ${paneId}, skipping`);
    return;
  }

  updateIntentState(paneId, 'Initializing session...');

  // Clear cached CLI identity when model is explicitly specified (model switch)
  // This ensures we don't use stale identity data
  if (model) {
    unregisterCodexPane(paneId);
    log.info('spawnAgent', `Cleared CLI identity cache for pane ${paneId} (model switch to ${model})`);
  }

  // Codex panes now use interactive PTY mode (same as Claude/Gemini).
  // The spawn-claude IPC handler builds the right command (codex --yolo).
  // Identity injection happens via the normal startup context path below.

  const terminal = terminals.get(paneId);
  if (terminal) {
    updatePaneStatus(paneId, 'Starting...');
    syncTerminalInputBridge(paneId, { modelHint: model });
    const runtimeOverride = getPaneRuntimeOverride(paneId);
    let result;
    if (runtimeOverride.command) {
      result = { success: true, command: runtimeOverride.command, runtimeOverride: true };
    } else {
      try {
        const hasSpawnOptions = options && typeof options === 'object' && Object.keys(options).length > 0;
        result = hasSpawnOptions
          ? await window.squidrun.claude.spawn(paneId, undefined, options)
          : await window.squidrun.claude.spawn(paneId);
      } catch (err) {
        log.error(`spawnAgent ${paneId}`, 'Spawn failed:', err);
        updatePaneStatus(paneId, 'Spawn failed');
        return;
      }
    }
    if (result.success && result.command) {
      rememberClaudeSessionCollisionRecovery(paneId, result.command);
      if (runtimeOverride.spawnCommandOnCreate === true) {
        const commandText = String(result.command || '').trim().toLowerCase();
        const modelType = commandText.includes('gemini') ? 'gemini' : commandText.includes('codex') ? 'codex' : 'claude';
        await armStartupInjection(paneId, {
          modelType,
          isGemini: modelType === 'gemini',
          source: 'spawn-command-on-create-retry',
        });
        updatePaneStatus(paneId, 'Working');
        return;
      }
      // Use pty.write directly instead of terminal.paste for reliability
      // terminal.paste() can fail if terminal isn't fully ready
      try {
        await window.squidrun.pty.write(String(paneId), result.command);
      } catch (err) {
        log.error(`spawnAgent ${paneId}`, 'PTY write command failed:', err);
      }
      // Mark as typed so Enter isn't blocked
      lastTypedTime[paneId] = Date.now();
      // Small delay before sending Enter
      await new Promise(resolve => setTimeout(resolve, 100));
      try {
        await window.squidrun.pty.write(String(paneId), '\r');
      } catch (err) {
        log.error(`spawnAgent ${paneId}`, 'PTY write Enter failed:', err);
      }

      // Codex CLI needs an extra Enter after startup to dismiss its welcome prompt
      // Claude Code CLI doesn't need this - it's ready immediately
      // NOTE: Codex sandbox_mode should be pre-configured via ~/.codex/config.toml
      // (sandbox_mode = "workspace-write") to skip the first-run sandbox prompt.
      // This PTY \r is a fallback to dismiss any residual prompt if config is missing.
      const isCodexCommand = result.command.startsWith('codex');
      const isClaudeCommand = result.command.startsWith('claude');
      if (isCodexCommand) {
        setTimeout(() => {
          window.squidrun.pty.write(String(paneId), '\r').catch(err => {
            log.error(`spawnAgent ${paneId}`, 'Codex startup Enter failed:', err);
          });
          log.info('spawnAgent', `Codex pane ${paneId}: PTY \\r to dismiss any startup prompt`);
        }, 3000);
      }
      if (isClaudeCommand) {
        setTimeout(() => {
          window.squidrun.pty.write(String(paneId), '\r').catch(err => {
            log.error(`spawnAgent ${paneId}`, 'Claude startup Enter failed:', err);
          });
          log.info('spawnAgent', `Claude pane ${paneId}: PTY \\r startup fallback`);
        }, 3000);
      }

      // ID-1 + Finding #14: Wait for CLI ready prompt before identity/context injection
      // This avoids injecting while subscription prompts are blocking input.
      const isGemini = model ? model === 'gemini' : isGeminiPane(paneId);
      const isCodexSpawn = model ? model === 'codex' : isCodexPane(String(paneId));
      const modelType = isGemini ? 'gemini' : isCodexSpawn ? 'codex' : 'claude';
      await armStartupInjection(paneId, { modelType, isGemini, source: 'spawn' });

    }
    updatePaneStatus(paneId, 'Working');
  }
}

// Helper to check if a pane is Gemini
function isGeminiPane(paneId) {
  return classifyRuntimeFromIdentity(paneId) === 'gemini';
}

function getStartupModelForPane(paneId) {
  const isGemini = isGeminiPane(paneId);
  const isCodex = isCodexPane(String(paneId));
  return {
    modelType: isGemini ? 'gemini' : isCodex ? 'codex' : 'claude',
    isGemini,
  };
}

function parseDaemonCreatedAtMs(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

async function armStartupInjectionForDaemonStartedPane(paneId, daemonTerminal = {}) {
  const id = String(paneId);
  if (!PANE_IDS.includes(id)) return false;
  if (!rendererOwnsStartupInjection(id)) return false;
  if (hasPendingStartupInjection(id)) return false;
  if (hasStartupSessionHeader(daemonTerminal?.scrollback || '', id)) return false;

  const createdAtMs = parseDaemonCreatedAtMs(daemonTerminal?.createdAt);
  if (!createdAtMs) return false;
  const terminalAge = Date.now() - createdAtMs;
  if (terminalAge < 0 || terminalAge > FRESH_STARTUP_INJECTION_WINDOW_MS) return false;

  const { modelType, isGemini } = getStartupModelForPane(id);
  const armed = await armStartupInjection(id, {
    modelType,
    isGemini,
    source: 'daemon-command-on-create',
  });
  if (armed && daemonTerminal?.scrollback) {
    handleStartupOutput(id, daemonTerminal.scrollback);
  }
  if (armed) {
    log.info('spawnAgent', `Daemon command-on-create armed startup injection for pane ${id}`);
  }
  return armed;
}

// Spawn agents in all panes
async function spawnAllAgents() {
  updateConnectionStatus('Starting agents in all panes...');
  for (const paneId of getActivePaneIds()) {
    const daemonTerminal = await readDaemonTerminalForPane(paneId, { timeoutMs: 750 });
    if (
      PANE_IDS.includes(String(paneId))
      && daemonTerminal?.alive === true
      && daemonTerminal?.mode === 'pty-command'
    ) {
      await armStartupInjectionForDaemonStartedPane(paneId, daemonTerminal);
      log.info('spawnAgent', `Pane ${paneId} already started by daemon command-on-create; skipping duplicate spawn`);
      continue;
    }
    await spawnAgent(paneId);
    // Small delay between panes to prevent race conditions
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  updateConnectionStatus('All agents running');
}

// Kill all terminals
async function killAllTerminals() {
  updateConnectionStatus('Killing all terminals...');
  for (const paneId of getActivePaneIds()) {
    try {
      await window.squidrun.pty.kill(paneId);
    } catch (err) {
      log.error(`Terminal ${paneId}`, 'Failed to kill pane', err);
    } finally {
      teardownTerminalPane(paneId);
      updatePaneStatus(paneId, 'Killed');
    }
  }
  updateConnectionStatus('All terminals killed');
}

// ResizeObserver-based resize — fires when .pane-terminal elements actually change size
// Replaces window 'resize' event + transitionend listeners with a single mechanism
const resizeObservers = new Map();    // paneId -> ResizeObserver
const resizeDebounceTimers = new Map(); // paneId -> timer ID
const deferredResizeTimers = new Map(); // paneId -> timer ID
const deferredResizeFirstRequestedAt = new Map(); // paneId -> timestamp
const terminalAppliedPtyGeometries = new Map(); // paneId -> last cols/rows actually sent to PTY
const terminalOwnFitSuppressUntil = new Map(); // paneId -> timestamp while self-fit ResizeObserver callbacks are ignored
const terminalOwnFitContainerSizes = new Map(); // paneId -> container size at self-fit time

const RESIZE_OBSERVER_DEBOUNCE_MS = 150;
const RESIZE_INPUT_DEFER_MS = 150;
const RESIZE_INPUT_MAX_DEFER_MS = 900;
const RESIZE_OWN_FIT_OBSERVER_SUPPRESS_MS = 250;
const RESIZE_CONTAINER_TOLERANCE_PX = 2;

function getTerminalGeometry(terminal) {
  const cols = Math.trunc(Number(terminal?.cols));
  const rows = Math.trunc(Number(terminal?.rows));
  if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) {
    return null;
  }
  return { cols, rows };
}

function getTerminalContainerSize(paneId) {
  const container = document.getElementById(`terminal-${paneId}`);
  if (!container) return null;
  const rect = typeof container.getBoundingClientRect === 'function'
    ? container.getBoundingClientRect()
    : null;
  const width = Number(container.clientWidth) || Number(rect?.width);
  const height = Number(container.clientHeight) || Number(rect?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return {
    width: Math.round(width),
    height: Math.round(height),
  };
}

function containerSizeApproximatelyEqual(a, b) {
  if (!a || !b) return false;
  return Math.abs(a.width - b.width) <= RESIZE_CONTAINER_TOLERANCE_PX
    && Math.abs(a.height - b.height) <= RESIZE_CONTAINER_TOLERANCE_PX;
}

function getAppliedTerminalContainerSize(previous) {
  const width = Number(previous?.containerWidth);
  const height = Number(previous?.containerHeight);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return {
    width: Math.round(width),
    height: Math.round(height),
  };
}

function terminalContainerChangedSinceLastApply(paneId) {
  const id = String(paneId);
  const previous = terminalAppliedPtyGeometries.get(id);
  if (!previous) return true;
  const containerSize = getTerminalContainerSize(id);
  const previousContainerSize = getAppliedTerminalContainerSize(previous);
  if (!containerSize || !previousContainerSize) return true;
  return !containerSizeApproximatelyEqual(containerSize, previousContainerSize);
}

function markOwnTerminalFit(paneId) {
  const id = String(paneId);
  terminalOwnFitSuppressUntil.set(id, Date.now() + RESIZE_OWN_FIT_OBSERVER_SUPPRESS_MS);
  const containerSize = getTerminalContainerSize(id);
  if (containerSize) {
    terminalOwnFitContainerSizes.set(id, containerSize);
  } else {
    terminalOwnFitContainerSizes.delete(id);
  }
}

function shouldSuppressOwnFitResizeObserver(paneId) {
  const id = String(paneId);
  const until = Number(terminalOwnFitSuppressUntil.get(id)) || 0;
  if (until <= 0) return false;
  if (Date.now() <= until) {
    const fittedContainerSize = terminalOwnFitContainerSizes.get(id);
    const currentContainerSize = getTerminalContainerSize(id);
    if (
      fittedContainerSize
      && currentContainerSize
      && !containerSizeApproximatelyEqual(fittedContainerSize, currentContainerSize)
    ) {
      terminalOwnFitSuppressUntil.delete(id);
      terminalOwnFitContainerSizes.delete(id);
      return false;
    }
    return true;
  }
  terminalOwnFitSuppressUntil.delete(id);
  terminalOwnFitContainerSizes.delete(id);
  return false;
}

function fitTerminalForPane(paneId, fitAddon, operation = 'fit') {
  if (!fitAddon || typeof fitAddon.fit !== 'function') return false;
  markOwnTerminalFit(paneId);
  fitAddon.fit();
  bus.emit('fit.completed', {
    paneId: String(paneId),
    payload: { operation },
    source: TERMINAL_EVENT_SOURCE,
  });
  return true;
}

function emitTerminalResizeSkipped(paneId, reason, payload = {}) {
  bus.emit('fit.skipped', {
    paneId: String(paneId),
    payload: {
      reason,
      ...payload,
    },
    source: TERMINAL_EVENT_SOURCE,
  });
}

function applyTerminalPtyResize(paneId, terminal, options = {}) {
  const id = String(paneId);
  const operation = options.operation || 'pty_resize';
  if (!rendererOwnsPtyGeometry(id)) {
    emitPtyGeometrySkipped(id, 'secondary_squid_room_mirror_geometry_blocked', { operation });
    return { applied: false, reason: 'secondary_squid_room_mirror_geometry_blocked' };
  }

  const geometry = getTerminalGeometry(terminal);
  if (!geometry) {
    emitTerminalResizeSkipped(id, 'invalid_terminal_geometry', { operation });
    return { applied: false, reason: 'invalid_terminal_geometry' };
  }

  if (!window.squidrun?.pty?.resize) {
    emitTerminalResizeSkipped(id, 'pty_resize_unavailable', {
      operation,
      cols: geometry.cols,
      rows: geometry.rows,
    });
    return { applied: false, reason: 'pty_resize_unavailable', ...geometry };
  }

  const previous = terminalAppliedPtyGeometries.get(id) || null;
  const containerSize = getTerminalContainerSize(id);
  const previousContainerSize = previous
    ? { width: previous.containerWidth, height: previous.containerHeight }
    : null;
  const sameAppliedGeometry = previous
    && previous.cols === geometry.cols
    && previous.rows === geometry.rows;
  if (sameAppliedGeometry && options.forceApply !== true) {
    emitTerminalResizeSkipped(id, 'applied_geometry_unchanged', {
      operation,
      cols: geometry.cols,
      rows: geometry.rows,
    });
    return { applied: false, reason: 'applied_geometry_unchanged', ...geometry };
  }

  const sameContainerSize = previous
    && containerSize
    && previousContainerSize
    && containerSizeApproximatelyEqual(containerSize, previousContainerSize);
  if (sameContainerSize && options.forceApply !== true) {
    emitTerminalResizeSkipped(id, 'container_geometry_unchanged', {
      operation,
      cols: geometry.cols,
      rows: geometry.rows,
      lastAppliedCols: previous.cols,
      lastAppliedRows: previous.rows,
      containerWidth: containerSize.width,
      containerHeight: containerSize.height,
    });
    return { applied: false, reason: 'container_geometry_unchanged', ...geometry };
  }

  bus.emit('pty.resize.requested', {
    paneId: id,
    payload: {
      operation,
      cols: geometry.cols,
      rows: geometry.rows,
      prevCols: options.prevCols,
      prevRows: options.prevRows,
      lastAppliedCols: previous?.cols,
      lastAppliedRows: previous?.rows,
      containerWidth: containerSize?.width,
      containerHeight: containerSize?.height,
    },
    source: TERMINAL_EVENT_SOURCE,
  });
  window.squidrun.pty.resize(id, geometry.cols, geometry.rows);
  terminalAppliedPtyGeometries.set(id, {
    cols: geometry.cols,
    rows: geometry.rows,
    containerWidth: containerSize?.width,
    containerHeight: containerSize?.height,
    operation,
    appliedAt: Date.now(),
  });
  return { applied: true, ...geometry };
}

function shouldDeferTerminalResizeForInput() {
  return userIsTyping() || userInputFocused();
}

function clearDeferredTerminalResize(paneId) {
  const id = String(paneId);
  const timer = deferredResizeTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    deferredResizeTimers.delete(id);
  }
  deferredResizeFirstRequestedAt.delete(id);
}

function scheduleDeferredTerminalResize(paneId) {
  const id = String(paneId);
  const now = Date.now();
  const firstRequestedAt = deferredResizeFirstRequestedAt.get(id) || now;
  deferredResizeFirstRequestedAt.set(id, firstRequestedAt);

  const existingTimer = deferredResizeTimers.get(id);
  if (existingTimer) clearTimeout(existingTimer);

  const elapsedMs = Math.max(0, now - firstRequestedAt);
  const delayMs = elapsedMs >= RESIZE_INPUT_MAX_DEFER_MS
    ? 0
    : Math.min(RESIZE_INPUT_DEFER_MS, RESIZE_INPUT_MAX_DEFER_MS - elapsedMs);

  deferredResizeTimers.set(id, setTimeout(() => {
    deferredResizeTimers.delete(id);
    const liveElapsedMs = Math.max(0, Date.now() - firstRequestedAt);
    if (shouldDeferTerminalResizeForInput() && liveElapsedMs < RESIZE_INPUT_MAX_DEFER_MS) {
      scheduleDeferredTerminalResize(id);
      return;
    }
    deferredResizeFirstRequestedAt.delete(id);
    resizeSinglePane(id, { force: true });
  }, delayMs));
}

function setupResizeObserver(paneId) {
  cleanupResizeObserver(paneId);
  const container = document.getElementById(`terminal-${paneId}`);
  if (!container) return;
  if (!rendererOwnsPtyGeometry(paneId)) {
    emitPtyGeometrySkipped(paneId, 'secondary_squid_room_mirror_geometry_blocked', {
      operation: 'resize_observer_setup',
    });
    return;
  }

  const observer = new ResizeObserver(() => {
    if (shouldSuppressOwnFitResizeObserver(paneId)) {
      emitTerminalResizeSkipped(paneId, 'own_fit_resize_observer_suppressed', {
        operation: 'resize_observer',
      });
      return;
    }

    // Skip resize while settings overlay is open — its max-height transition
    // triggers layout reflow on all terminal containers, and fitAddon.fit()
    // with the WebGL renderer stalls the main thread (Item 23).
    const settingsPanel = document.getElementById('settingsPanel');
    if (settingsPanel && settingsPanel.classList.contains('open')) {
      bus.emit('fit.skipped', {
        paneId,
        payload: { reason: 'overlay_open' },
        source: TERMINAL_EVENT_SOURCE,
      });
      return;
    }

    // Debounce: don't fire fit() on every pixel during drag resize
    const existingTimer = resizeDebounceTimers.get(paneId);
    if (existingTimer) clearTimeout(existingTimer);

    // Focused pane gets shorter debounce, background panes defer longer
    const isFocused = (paneId === focusedPane);
    const delay = isFocused ? RESIZE_OBSERVER_DEBOUNCE_MS : 300;

    resizeDebounceTimers.set(paneId, setTimeout(() => {
      resizeDebounceTimers.delete(paneId);
      if (shouldSuppressOwnFitResizeObserver(paneId)) {
        emitTerminalResizeSkipped(paneId, 'own_fit_resize_timer_suppressed', {
          operation: 'resize_observer_debounce',
        });
        return;
      }
      resizeSinglePane(paneId);
    }, delay));
  });

  observer.observe(container);
  resizeObservers.set(paneId, observer);
}

function cleanupResizeObserver(paneId) {
  const observer = resizeObservers.get(paneId);
  if (observer) {
    observer.disconnect();
    resizeObservers.delete(paneId);
  }
  const timer = resizeDebounceTimers.get(paneId);
  if (timer) {
    clearTimeout(timer);
    resizeDebounceTimers.delete(paneId);
  }
  terminalOwnFitSuppressUntil.delete(String(paneId));
  terminalOwnFitContainerSizes.delete(String(paneId));
  clearDeferredTerminalResize(paneId);
}

// Explicit resize all — kept for programmatic calls (e.g., right panel toggle)
// Staggers pane resizes by 50ms to avoid 3 simultaneous WebGL renders
function handleResize() {
  let i = 0;
  for (const [paneId] of fitAddons) {
    if (!rendererOwnsPtyGeometry(paneId)) continue;
    setTimeout(() => resizeSinglePane(paneId), i * 50);
    i++;
  }
}

function resizeSinglePane(paneId, options = {}) {
  const fitAddon = fitAddons.get(paneId);
  const terminal = terminals.get(paneId);
  if (!fitAddon || !terminal) return;
  if (!rendererOwnsPtyGeometry(paneId)) {
    clearDeferredTerminalResize(paneId);
    emitPtyGeometrySkipped(paneId, 'secondary_squid_room_mirror_geometry_blocked', {
      operation: 'resize_single_pane',
    });
    return;
  }
  if (options?.force !== true && shouldDeferTerminalResizeForInput()) {
    scheduleDeferredTerminalResize(paneId);
    return;
  }
  clearDeferredTerminalResize(paneId);
  try {
    const previousGeometry = getTerminalGeometry(terminal) || {};
    const prevCols = previousGeometry.cols;
    const prevRows = previousGeometry.rows;
    bus.emit('resize.started', {
      paneId,
      payload: { prevCols, prevRows },
      source: TERMINAL_EVENT_SOURCE,
    });
    if (!terminalContainerChangedSinceLastApply(paneId)) {
      emitTerminalResizeSkipped(paneId, 'resize_container_unchanged_before_fit', {
        operation: 'resize_single_pane',
        cols: prevCols,
        rows: prevRows,
      });
      return;
    }
    fitTerminalForPane(paneId, fitAddon, 'resize_single_pane');
    const resizeResult = applyTerminalPtyResize(paneId, terminal, {
      operation: 'resize_single_pane',
      prevCols,
      prevRows,
    });
    if (!resizeResult.applied) return;
    bus.emit('resize.completed', {
      paneId,
      payload: { cols: resizeResult.cols, rows: resizeResult.rows },
      source: TERMINAL_EVENT_SOURCE,
    });
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
  const searchAddon = ensureSearchAddon(paneId);
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
  initUIFocusTracker,   // Global UI focus tracking for multi-pane restore
  userInputFocused,     // Active UI composition guard (focus + recent typing)
  getActivePaneIds,
  setActivePaneIds,
  getPaneRuntimeOverride,
  setPaneRuntimeOverride,
  clearPaneRuntimeOverride,
  initTerminals,
  initTerminal,
  reattachTerminal,
  focusPane,
  sendEnterToPane,
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
  registerCodexPane,   // CLI Identity: mark pane as Codex
  unregisterCodexPane, // CLI Identity: unmark pane as Codex
  isCodexPane,         // CLI Identity: query Codex status
  setStartupWindowContext,
  getStartupWindowContext,
  hasPendingStartupInjection,
  getPaneInjectionCapabilities, // Runtime capability profile for injection paths
  messageQueue,   // Message queue for busy panes
  getInjectionInFlight, // Check injection lock state
  setInjectionInFlight, // Set injection lock (for testing)
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
  refreshMirrorModeBindings,
  // Terminal search (Ctrl+F)
  searchAddons,        // Search addon instances
  openTerminalSearch,  // Open search bar for pane
  closeTerminalSearch, // Close search bar
  // Contract promotion runtime wiring
  runPromotionCheck,
  stopPromotionCheckTimer,
  // Scroll-probe seam: runs in the isolated world where the terminal lives,
  // invoked from the main-world probe injection via the contextBridge.
  runTerminalScrollProbe,
  setPaneRenderSuspended,
  isPaneRenderSuspended,
  _internals: {
    get promotionCheckTimer() { return promotionCheckTimer; },
    set promotionCheckTimer(v) { promotionCheckTimer = v; },
    PROMOTION_CHECK_INTERVAL_MS,
    startPromotionCheckTimer,
    initPromotionEngine,
    buildStartupIdentityMessage,
    clearStartupInjection,
    parseDaemonCreatedAtMs,
    fetchStartupHealthSummary,
    fetchStartupAiBriefing,
    normalizeStartupWindowContext,
    readStartupBundleForContext,
    setStartupWindowContext,
    getStartupWindowContext,
    getPaneIdentityLabel,
    queueTerminalWrite,
    refreshTerminalViewport,
    resizeSinglePane,
    setupResizeObserver,
    applyTerminalPtyResize,
    fitTerminalForPane,
    shouldSuppressOwnFitResizeObserver,
    scheduleStreamingViewportFit,
    scheduleSettleRedraw,
    performSettleRedraw,
    clearTerminalSettleRedraw,
    captureTerminalFrameSignature,
    captureTerminalFitCoherence,
    scheduleDeferredTerminalResize,
    clearDeferredTerminalResize,
    scheduleTerminalPaintRefresh,
    scheduleTerminalAttachPaintRefresh,
    getTerminalScrollbackInfo,
    terminalHasScrollableScrollback,
    markTerminalUserScroll,
    normalizeTerminalWheelScrollLines,
    applyTerminalScrollLines,
    scheduleTerminalScrollFallback,
    handleTerminalWheelScrollIntent,
    getTerminalKeyboardScrollLines,
    handleTerminalKeyboardScroll,
    shouldPreserveTerminalUserScroll,
    setupTerminalWheelScrollGuard,
    rendererOwnsPtyGeometry,
    rendererOwnsStartupInjection,
    isSecondarySquidRoomMirrorPane,
    terminalWriteFlushTimers,
    terminalWriteFrameBudgets,
    terminalWatermarks,
    terminalPaused,
    terminalPaintRefreshTimers,
    terminalStreamingFitTimers,
    terminalStreamingLastFitAt,
    resizeDebounceTimers,
    terminalAppliedPtyGeometries,
    terminalOwnFitSuppressUntil,
    terminalOwnFitContainerSizes,
    deferredResizeTimers,
    deferredResizeFirstRequestedAt,
    TERMINAL_WRITE_FRAME_YIELD_MS,
    TERMINAL_WRITE_FRAME_BYTE_BUDGET,
    TERMINAL_STREAMING_FIT_MIN_INTERVAL_MS,
    TERMINAL_STREAMING_FIT_SETTLE_MS,
    TERMINAL_AT_BOTTOM_EPSILON_ROWS,
    TERMINAL_SCROLL_FALLBACK_DELAY_MS,
    RESIZE_INPUT_MAX_DEFER_MS,
    RESIZE_OWN_FIT_OBSERVER_SUPPRESS_MS,
  },
};


