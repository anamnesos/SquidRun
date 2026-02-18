/**
 * Terminal injection helpers
 * Extracted from terminal.js to isolate fragile send/verify logic.
 */

const log = require('../logger');
const bus = require('../event-bus');
const { BYPASS_CLEAR_DELAY_MS: DEFAULT_BYPASS_CLEAR_DELAY_MS } = require('../constants');

const EVENT_SOURCE = 'injection.js';
const IS_DARWIN = process.platform === 'darwin';

function createInjectionController(options = {}) {
  const {
    terminals,
    lastOutputTime,
    lastTypedTime,
    messageQueue,
    getPaneCapabilities,
    isCodexPane,
    isGeminiPane,
    buildCodexExecPrompt,
    userIsTyping,
    userInputFocused,
    updatePaneStatus,
    markPotentiallyStuck,
    getInjectionInFlight,
    setInjectionInFlight,
    constants = {},
  } = options;

  const {
    FOCUS_RETRY_DELAY_MS,
    MAX_FOCUS_RETRIES,
    QUEUE_RETRY_MS,
    QUEUE_DEFER_BACKOFF_START_MS = 100,
    QUEUE_DEFER_BACKOFF_MAX_MS = 2000,
    QUEUE_DEFER_BACKOFF_MULTIPLIER = 2,
    INJECTION_LOCK_TIMEOUT_MS,
    BYPASS_CLEAR_DELAY_MS = DEFAULT_BYPASS_CLEAR_DELAY_MS,
    TYPING_GUARD_MS = 300,
    CODEX_ENTER_DELAY_MS = 200,
    GEMINI_ENTER_DELAY_MS = 75,
    MAX_COMPACTION_DEFER_MS = 8000,
    CLAUDE_CHUNK_SIZE = 2048,
    CLAUDE_CHUNK_MIN_SIZE = 1024,
    CLAUDE_CHUNK_MAX_SIZE = 8192,
    CLAUDE_CHUNK_THRESHOLD_BYTES = 8 * 1024,
    CLAUDE_CHUNK_YIELD_MS = 0,
    CLAUDE_ENTER_DELAY_MS = 50,
    CLAUDE_LONG_MESSAGE_BYTES = 1024,
    CLAUDE_LONG_MESSAGE_BASE_ENTER_DELAY_MS = 200,
    CLAUDE_ENTER_DELAY_SCALE_START_BYTES = 256,
    CLAUDE_ENTER_DELAY_BYTES_PER_MS = 64,
    CLAUDE_ENTER_DELAY_MAX_EXTRA_MS = 250,
    SUBMIT_ACCEPT_VERIFY_WINDOW_MS = 1200,
    SUBMIT_ACCEPT_POLL_MS = 50,
    SUBMIT_ACCEPT_RETRY_BACKOFF_MS = 250,
    SUBMIT_ACCEPT_MAX_ATTEMPTS = 2,
    SUBMIT_DEFER_ACTIVE_OUTPUT_WINDOW_MS = 350,
    SUBMIT_DEFER_MAX_WAIT_MS = 2000,
    SUBMIT_DEFER_MAX_WAIT_LONG_MS = 5000,
    SUBMIT_DEFER_POLL_MS = 100,
    CLAUDE_SUBMIT_SAFETY_TIMEOUT_MS = 9000,
    SAFE_DEFAULT_ENTER_DELAY_MS = 50,
    INJECTION_QUEUE_MAX_ITEMS = 200,
    INJECTION_QUEUE_MAX_BYTES = 512 * 1024,
  } = constants;

  // Track when compaction deferral started per pane (false positive safety valve)
  const compactionDeferStart = new Map();
  // Track per-pane queue defer retry backoff and deferred-log suppression state.
  const queueDeferBackoffMs = new Map();
  const queueDeferLogState = new Map();

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
   * Send Enter to terminal via direct DOM keyboard dispatch on xterm textarea.
   * @param {string} paneId - The pane ID
   * @returns {Promise<{success: boolean, method: string}>}
   */
  async function sendEnterToPane(paneId) {
    const terminal = terminals.get(paneId);
    // sendInputEvent can produce isTrusted=false, which the key handler blocks
    // unless bypassed. Set bypass flag so attachCustomKeyEventHandler allows Enter.
    if (terminal) {
      terminal._hivemindBypass = true;
      log.debug(`sendEnterToPane ${paneId}`, 'Set _hivemindBypass=true for DOM dispatch');
    }

    const tryDomFallback = () => {
      if (typeof document === 'undefined') return false;
      let textarea = document.querySelector(`.pane[data-pane-id="${paneId}"] .xterm-helper-textarea`);
      if (!textarea || typeof textarea.dispatchEvent !== 'function') {
        const paneEl = document.querySelector(`.pane[data-pane-id="${paneId}"]`);
        textarea = paneEl ? paneEl.querySelector('.xterm-helper-textarea') : null;
      }
      if (!textarea) return false;

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
          evt._hivemindBypass = true;
          return evt;
        };
        textarea.dispatchEvent(makeEvent('keydown'));
        textarea.dispatchEvent(makeEvent('keypress'));
        textarea.dispatchEvent(makeEvent('keyup'));
        log.info(`sendEnterToPane ${paneId}`, 'Enter sent via DOM dispatch');
        return true;
      } catch (err) {
        log.warn(`sendEnterToPane ${paneId}`, 'DOM dispatch failed:', err);
        return false;
      }
    };

    try {
      const fallbackOk = tryDomFallback();
      if (fallbackOk) {
        return { success: true, method: 'domFallback' };
      }
      return { success: false, method: 'domFallback' };
    } finally {
      // Clear bypass flag after Enter is processed (next tick to ensure event handled)
      if (terminal) {
        setTimeout(() => {
          terminal._hivemindBypass = false;
          log.debug(`sendEnterToPane ${paneId}`, 'Cleared _hivemindBypass');
        }, BYPASS_CLEAR_DELAY_MS);
      }
    }
  }

  /**
   * Check if terminal shows a prompt (ready for input).
   * Used by terminal.js startup detection to know when a pane is ready.
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
      const promptPatterns = [
        /(?:^|[\s>])(codex|gemini|claude|cursor)>\s*$/i,
        /(?:^|[\s>])PS\s+[^>\n]*>\s*$/i,
        /(?:^|[\s>])[A-Za-z]:\\[^>\n]*>\s*$/,
        /(?:^|[\w./~:-]+)[$#]\s*$/,
      ];
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

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function getLastOutputTimestamp(paneId) {
    const ts = Number(lastOutputTime?.[paneId]);
    return Number.isFinite(ts) ? ts : 0;
  }

  function paneHasRecentOutput(paneId, windowMs = SUBMIT_DEFER_ACTIVE_OUTPUT_WINDOW_MS) {
    const ts = getLastOutputTimestamp(paneId);
    if (!ts) return false;
    return (Date.now() - ts) <= windowMs;
  }

  function canProbePromptState(paneId) {
    const terminal = terminals.get(paneId);
    const buffer = terminal?.buffer?.active;
    return !!(buffer && typeof buffer.getLine === 'function');
  }

  function computeScaledEnterDelayMs(baseDelayMs, payloadBytes, capabilities = {}) {
    const defaultBase = Math.max(0, Number(baseDelayMs) || 0);
    const byteLength = Math.max(0, Number(payloadBytes) || 0);
    const explicitScaling = capabilities.scaleEnterDelayByPayload === true;
    const displayName = String(capabilities.displayName || '').trim().toLowerCase();
    const modeLabel = String(capabilities.modeLabel || '').trim().toLowerCase();
    const isCodexCapability = displayName === 'codex' || modeLabel.includes('codex');
    const shouldScale = explicitScaling || capabilities.enterMethod === 'trusted' || isCodexCapability;
    if (!shouldScale) {
      return defaultBase;
    }

    const longMessageBytes = Math.max(1, Number(CLAUDE_LONG_MESSAGE_BYTES) || 1024);
    const longMessageBaseDelayMs = Math.max(0, Number(CLAUDE_LONG_MESSAGE_BASE_ENTER_DELAY_MS) || 200);
    const base = byteLength >= longMessageBytes
      ? Math.max(defaultBase, longMessageBaseDelayMs)
      : defaultBase;

    const scaleStartBytes = Math.max(0, Number(CLAUDE_ENTER_DELAY_SCALE_START_BYTES) || 256);
    const bytesPerMs = Math.max(1, Number(CLAUDE_ENTER_DELAY_BYTES_PER_MS) || 64);
    const maxExtraMs = Math.max(0, Number(CLAUDE_ENTER_DELAY_MAX_EXTRA_MS) || 250);
    const bytesOverThreshold = Math.max(0, byteLength - scaleStartBytes);
    const extraDelayMs = Math.ceil(bytesOverThreshold / bytesPerMs);

    return base + Math.min(maxExtraMs, extraDelayMs);
  }

  async function deferSubmitWhilePaneActive(paneId, maxWaitMs = SUBMIT_DEFER_MAX_WAIT_MS) {
    const deferMaxWaitMs = Math.max(0, Number(maxWaitMs) || 0);
    const start = Date.now();
    while (paneHasRecentOutput(paneId) && (Date.now() - start) < deferMaxWaitMs) {
      await sleep(SUBMIT_DEFER_POLL_MS);
    }

    const waitedMs = Date.now() - start;
    if (waitedMs <= 0) {
      return { waitedMs: 0, forcedExpire: false };
    }

    if (paneHasRecentOutput(paneId)) {
      log.warn(
        `doSendToPane ${paneId}`,
        `Claude pane still active after ${waitedMs}ms defer window; proceeding with submit`
      );
      return { waitedMs, forcedExpire: true };
    }

    log.info(
      `doSendToPane ${paneId}`,
      `Deferred submit ${waitedMs}ms while pane reported active output`
    );
    return { waitedMs, forcedExpire: false };
  }

  async function verifySubmitAccepted(paneId, baseline = {}, options = {}) {
    const {
      outputTsBefore = 0,
      promptProbeAvailable = false,
      promptWasReady = false,
    } = baseline;
    const allowOutputTransitionOnly = Boolean(options.allowOutputTransitionOnly);

    // Fallback when prompt probing is unavailable (mock/test edge cases).
    if (!promptProbeAvailable) {
      return {
        accepted: true,
        signal: 'prompt_probe_unavailable',
        outputTransitionObserved: false,
        promptTransitionObserved: false,
      };
    }

    const start = Date.now();
    let outputTransitionObserved = false;
    let promptTransitionObserved = false;
    while ((Date.now() - start) < SUBMIT_ACCEPT_VERIFY_WINDOW_MS) {
      const outputTsAfter = getLastOutputTimestamp(paneId);
      if (outputTsAfter > outputTsBefore) {
        outputTransitionObserved = true;
      }

      if (promptWasReady && !isPromptReady(paneId)) {
        promptTransitionObserved = true;
        return {
          accepted: true,
          signal: outputTransitionObserved ? 'prompt_and_output_transition' : 'prompt_transition',
          outputTransitionObserved,
          promptTransitionObserved,
        };
      }

      await sleep(SUBMIT_ACCEPT_POLL_MS);
    }

    // If prompt was not ready at baseline, prompt transition cannot be observed.
    // In that case, treat output transition as sufficient acceptance signal.
    if ((allowOutputTransitionOnly || !promptWasReady) && outputTransitionObserved) {
      return {
        accepted: true,
        signal: allowOutputTransitionOnly ? 'output_transition_allowed' : 'output_transition_prompt_unavailable',
        outputTransitionObserved,
        promptTransitionObserved,
      };
    }

    return {
      accepted: false,
      signal: outputTransitionObserved ? 'output_transition_only' : 'no_acceptance_signal',
      outputTransitionObserved,
      promptTransitionObserved,
    };
  }

  function getBackoffStartMs() {
    return Math.max(100, Number(QUEUE_RETRY_MS) || 0, Number(QUEUE_DEFER_BACKOFF_START_MS) || 100);
  }

  function getBackoffMaxMs() {
    return Math.max(getBackoffStartMs(), Number(QUEUE_DEFER_BACKOFF_MAX_MS) || 2000);
  }

  function getBackoffMultiplier() {
    const parsed = Number(QUEUE_DEFER_BACKOFF_MULTIPLIER);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 2;
  }

  function nextDeferredRetryDelayMs(paneId) {
    const id = String(paneId);
    const startMs = getBackoffStartMs();
    const maxMs = getBackoffMaxMs();
    const multiplier = getBackoffMultiplier();
    const delayMs = queueDeferBackoffMs.get(id) ?? startMs;
    const nextMs = Math.min(maxMs, Math.round(delayMs * multiplier));
    queueDeferBackoffMs.set(id, nextMs);
    return delayMs;
  }

  function emitDeferredSummaryIfNeeded(paneId, nextState = null) {
    const id = String(paneId);
    const state = queueDeferLogState.get(id);
    if (!state) return;

    if (state.suppressedCount > 0) {
      const elapsedMs = Math.max(0, Date.now() - state.startedAt);
      const suffix = nextState ? ` (state -> ${nextState})` : ' (state -> resumed)';
      log.info(
        `processQueue ${id}`,
        `Pane defer repeats suppressed: ${state.reason} repeated ${state.suppressedCount}x over ${elapsedMs}ms${suffix}`
      );
    }

    queueDeferLogState.delete(id);
  }

  function clearDeferredState(paneId) {
    const id = String(paneId);
    emitDeferredSummaryIfNeeded(id);
    queueDeferBackoffMs.delete(id);
  }

  function noteDeferredState(paneId, reason, delayMs) {
    const id = String(paneId);
    const state = queueDeferLogState.get(id);
    if (!state) {
      log.info(`processQueue ${id}`, `Pane deferred - ${reason}; retry in ${delayMs}ms (backoff)`);
      queueDeferLogState.set(id, { reason, suppressedCount: 0, startedAt: Date.now() });
      return;
    }

    if (state.reason === reason) {
      state.suppressedCount += 1;
      queueDeferLogState.set(id, state);
      return;
    }

    emitDeferredSummaryIfNeeded(id, reason);
    log.info(`processQueue ${id}`, `Pane deferred - ${reason}; retry in ${delayMs}ms (backoff)`);
    queueDeferLogState.set(id, { reason, suppressedCount: 0, startedAt: Date.now() });
  }

  function scheduleDeferredRetry(paneId, reason) {
    const delayMs = nextDeferredRetryDelayMs(paneId);
    noteDeferredState(paneId, reason, delayMs);
    setTimeout(() => processIdleQueue(paneId), delayMs);
  }

  function getInjectionQueueMaxItems() {
    return Number.isFinite(INJECTION_QUEUE_MAX_ITEMS) && INJECTION_QUEUE_MAX_ITEMS > 0
      ? INJECTION_QUEUE_MAX_ITEMS
      : 200;
  }

  function getInjectionQueueMaxBytes() {
    return Number.isFinite(INJECTION_QUEUE_MAX_BYTES) && INJECTION_QUEUE_MAX_BYTES > 0
      ? INJECTION_QUEUE_MAX_BYTES
      : (512 * 1024);
  }

  function getQueueItemBytes(item) {
    const msg = item && typeof item === 'object' ? item.message : item;
    if (typeof msg !== 'string') return 0;
    return Buffer.byteLength(msg, 'utf8');
  }

  function getQueueBytes(queue = []) {
    return queue.reduce((total, item) => total + getQueueItemBytes(item), 0);
  }

  function failQueueItem(item, reason = 'queue_cleared') {
    if (!item || typeof item !== 'object' || typeof item.onComplete !== 'function') return;
    try {
      item.onComplete({ success: false, verified: false, reason });
    } catch (err) {
      log.warn('Terminal', `Failed to notify dropped queue item: ${err.message}`);
    }
  }

  function clearPaneQueue(paneId, reason = 'queue_cleared') {
    const id = String(paneId);
    const queue = messageQueue[id];
    if (!Array.isArray(queue) || queue.length === 0) {
      clearDeferredState(id);
      compactionDeferStart.delete(id);
      return 0;
    }

    const droppedItems = queue.splice(0, queue.length);
    droppedItems.forEach(item => failQueueItem(item, reason));
    delete messageQueue[id];
    clearDeferredState(id);
    compactionDeferStart.delete(id);
    bus.emit('queue.depth.changed', {
      paneId: id,
      payload: { depth: 0, cleared: droppedItems.length, reason },
      source: EVENT_SOURCE,
    });
    return droppedItems.length;
  }

  function toNonEmptyString(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }

  function normalizeTraceContext(traceContext = null) {
    const ctx = (traceContext && typeof traceContext === 'object') ? traceContext : {};
    const traceId = toNonEmptyString(ctx.traceId) || toNonEmptyString(ctx.correlationId) || null;
    const parentEventId = toNonEmptyString(ctx.parentEventId) || toNonEmptyString(ctx.causationId) || null;
    const eventId = toNonEmptyString(ctx.eventId) || null;
    if (!traceId && !parentEventId && !eventId) return null;
    return {
      ...ctx,
      traceId,
      parentEventId,
      eventId,
      correlationId: traceId,
      causationId: parentEventId,
    };
  }

  function isHmSendFastTraceContext(traceContext = null) {
    const ctx = (traceContext && typeof traceContext === 'object') ? traceContext : {};
    const messageId = toNonEmptyString(ctx.messageId);
    const traceId = toNonEmptyString(ctx.traceId) || toNonEmptyString(ctx.correlationId);
    return Boolean(
      (messageId && messageId.startsWith('hm-'))
      || (traceId && traceId.startsWith('hm-'))
    );
  }

  function normalizeBoolean(value, fallback = false) {
    return typeof value === 'boolean' ? value : fallback;
  }

  function normalizeModeLabel(value, fallback = 'claude-pty') {
    const normalized = toNonEmptyString(value);
    return normalized || fallback;
  }

  function normalizeEnterMethod(value, fallback = 'trusted') {
    const normalized = toNonEmptyString(value);
    if (normalized === 'none' || normalized === 'pty' || normalized === 'trusted') {
      return normalized;
    }
    return fallback;
  }

  function resolveLegacyCapabilities(paneId) {
    const id = String(paneId);
    const isCodex = typeof isCodexPane === 'function' ? isCodexPane(id) : false;
    if (isCodex) {
      return {
        mode: 'pty',
        modeLabel: 'codex-pty',
        appliedMethod: 'codex-pty',
        submitMethod: 'codex-pty-enter',
        bypassGlobalLock: false,
        applyCompactionGate: true,
        requiresFocusForEnter: false,
        enterMethod: 'pty',
        enterDelayMs: CODEX_ENTER_DELAY_MS,
        sanitizeMultiline: true,
        clearLineBeforeWrite: true,
        useChunkedWrite: false,
        homeResetBeforeWrite: false,
        verifySubmitAccepted: true,
        deferSubmitWhilePaneActive: false,
        scaleEnterDelayByPayload: true,
        typingGuardWhenBypassing: false,
        sanitizeTransform: 'none',
        enterFailureReason: 'pty_enter_failed',
        displayName: 'Codex',
      };
    }

    const isGemini = typeof isGeminiPane === 'function' ? isGeminiPane(id) : false;
    if (isGemini) {
      return {
        mode: 'pty',
        modeLabel: 'gemini-pty',
        appliedMethod: 'gemini-pty',
        submitMethod: 'gemini-pty-enter',
        bypassGlobalLock: true,
        applyCompactionGate: false,
        requiresFocusForEnter: false,
        enterMethod: 'pty',
        enterDelayMs: GEMINI_ENTER_DELAY_MS,
        sanitizeMultiline: true,
        clearLineBeforeWrite: true,
        useChunkedWrite: false,
        homeResetBeforeWrite: false,
        verifySubmitAccepted: false,
        deferSubmitWhilePaneActive: false,
        scaleEnterDelayByPayload: false,
        typingGuardWhenBypassing: true,
        sanitizeTransform: 'gemini-sanitize',
        enterFailureReason: 'pty_enter_failed',
        displayName: 'Gemini',
      };
    }

    return {
      mode: 'pty',
      modeLabel: 'claude-pty',
      appliedMethod: 'claude-pty',
      submitMethod: 'sendTrustedEnter',
      bypassGlobalLock: false,
      applyCompactionGate: true,
      requiresFocusForEnter: !IS_DARWIN,
      enterMethod: IS_DARWIN ? 'pty' : 'trusted',
      enterDelayMs: CLAUDE_ENTER_DELAY_MS,
      sanitizeMultiline: false,
      clearLineBeforeWrite: true,
      useChunkedWrite: true,
      homeResetBeforeWrite: true,
      verifySubmitAccepted: true,
      deferSubmitWhilePaneActive: true,
      scaleEnterDelayByPayload: true,
      typingGuardWhenBypassing: false,
      sanitizeTransform: 'none',
      enterFailureReason: 'enter_failed',
      displayName: 'Claude',
    };
  }

  function normalizeCapabilities(raw, fallbackCaps, paneId) {
    const id = String(paneId);
    const source = (raw && typeof raw === 'object') ? raw : fallbackCaps;
    const mode = 'pty';
    const fallbackEnterMethod = fallbackCaps.enterMethod || 'pty';
    const enterMethod = normalizeEnterMethod(source.enterMethod, fallbackEnterMethod);
    const requiresFocusForEnter = normalizeBoolean(
      source.requiresFocusForEnter,
      enterMethod === 'trusted'
    );
    const bypassGlobalLock = normalizeBoolean(
      source.bypassGlobalLock,
      !requiresFocusForEnter
    );

    return {
      paneId: id,
      mode,
      modeLabel: normalizeModeLabel(source.modeLabel, fallbackCaps.modeLabel || 'generic-pty'),
      appliedMethod: normalizeModeLabel(source.appliedMethod, fallbackCaps.appliedMethod || 'generic-pty'),
      submitMethod: normalizeModeLabel(
        source.submitMethod,
        fallbackCaps.submitMethod || (enterMethod === 'trusted' ? 'sendTrustedEnter' : (enterMethod === 'pty' ? 'pty-enter' : 'none'))
      ),
      bypassGlobalLock,
      applyCompactionGate: normalizeBoolean(source.applyCompactionGate, !bypassGlobalLock),
      requiresFocusForEnter,
      enterMethod,
      enterDelayMs: Number.isFinite(Number(source.enterDelayMs))
        ? Math.max(0, Number(source.enterDelayMs))
        : (Number.isFinite(Number(fallbackCaps.enterDelayMs))
          ? Math.max(0, Number(fallbackCaps.enterDelayMs))
          : SAFE_DEFAULT_ENTER_DELAY_MS),
      sanitizeMultiline: normalizeBoolean(source.sanitizeMultiline, false),
      clearLineBeforeWrite: normalizeBoolean(source.clearLineBeforeWrite, true),
      useChunkedWrite: normalizeBoolean(source.useChunkedWrite, true),
      homeResetBeforeWrite: normalizeBoolean(source.homeResetBeforeWrite, true),
      verifySubmitAccepted: normalizeBoolean(source.verifySubmitAccepted, false),
      deferSubmitWhilePaneActive: normalizeBoolean(source.deferSubmitWhilePaneActive, false),
      scaleEnterDelayByPayload: normalizeBoolean(
        source.scaleEnterDelayByPayload,
        normalizeBoolean(
          fallbackCaps.scaleEnterDelayByPayload,
          enterMethod === 'trusted'
        )
      ),
      typingGuardWhenBypassing: normalizeBoolean(source.typingGuardWhenBypassing, bypassGlobalLock),
      sanitizeTransform: normalizeModeLabel(source.sanitizeTransform, fallbackCaps.sanitizeTransform || 'sanitize-multiline'),
      enterFailureReason: normalizeModeLabel(source.enterFailureReason, fallbackCaps.enterFailureReason || 'enter_failed'),
      displayName: normalizeModeLabel(source.displayName, fallbackCaps.displayName || fallbackCaps.modeLabel || 'Pane'),
    };
  }

  function getPaneInjectionCapabilities(paneId) {
    const fallbackCaps = resolveLegacyCapabilities(paneId);
    if (typeof getPaneCapabilities !== 'function') {
      return fallbackCaps;
    }

    try {
      const runtimeCaps = getPaneCapabilities(String(paneId));
      if (!runtimeCaps || typeof runtimeCaps !== 'object') {
        return fallbackCaps;
      }
      return normalizeCapabilities(runtimeCaps, fallbackCaps, paneId);
    } catch (err) {
      log.warn(`processQueue ${paneId}`, `Failed to resolve pane capabilities, using fallback: ${err.message}`);
      return fallbackCaps;
    }
  }

  // IDLE QUEUE: Process queued messages for a pane.
  // Messages arrive here from the throttle queue (daemon-handlers.js
  // processThrottleQueue → terminal.sendToPane). For Claude panes, the only
  // gates are injectionInFlight (focus mutex) and userInputFocused (composing
  // guard). No idle/busy timing — messages send immediately like user input.
  function processIdleQueue(paneId) {
    const id = String(paneId);
    const queue = messageQueue[paneId];
    if (!queue || queue.length === 0) {
      clearDeferredState(id);
      compactionDeferStart.delete(id);
      return;
    }
    const capabilities = getPaneInjectionCapabilities(id);
    const peekItem = queue[0];
    const peekTraceContext = normalizeTraceContext(peekItem && typeof peekItem === 'object' ? peekItem.traceContext : null);
    const hmSendFastEnter = Boolean(
      (peekItem && typeof peekItem === 'object' && peekItem.hmSendFastEnter === true)
      || isHmSendFastTraceContext(peekTraceContext)
    );
    const bypassesLock = capabilities.bypassGlobalLock || hmSendFastEnter;

    // Compaction gate: never inject while compaction is confirmed on this pane.
    // Only applies to Claude panes — Codex/Gemini don't do Claude-style compaction.
    // This closes the Item 20 failure mode where queued messages were submitted
    // into compaction output and appeared delivered despite being swallowed.
    // Safety valve: if gate has been stuck for > MAX_COMPACTION_DEFER_MS, force-clear
    // as a false positive (real compaction lasts 5-15s, never indefinitely).
    const paneState = (typeof bus.getState === 'function') ? bus.getState(id) : null;
    if (capabilities.applyCompactionGate && paneState?.gates?.compacting === 'confirmed') {
      if (!compactionDeferStart.has(id)) {
        compactionDeferStart.set(id, Date.now());
      }
      const deferDuration = Date.now() - compactionDeferStart.get(id);
      if (deferDuration < MAX_COMPACTION_DEFER_MS) {
        scheduleDeferredRetry(paneId, 'compaction gate active (confirmed)');
        return;
      }
      log.warn(`processQueue ${id}`, `Compaction gate stuck ${deferDuration}ms — forcing clear (false positive safety)`);
      bus.updateState(id, { gates: { compacting: 'none' } });
      compactionDeferStart.delete(id);
    } else {
      compactionDeferStart.delete(id);
    }

    // Gate 1: injectionInFlight — focus mutex for Claude panes.
    // Codex/Gemini bypass (focus-free paths).
    if (!bypassesLock && getInjectionInFlight()) {
      scheduleDeferredRetry(paneId, 'injection in flight');
      return;
    }
    if (bypassesLock && getInjectionInFlight()) {
      log.debug(`processQueue ${id}`, `${capabilities.displayName} pane bypassing global lock`);
    }

    // Gate 2: userInputFocused — defer while user is actively composing in UI input.
    // Focus alone does not block; terminal.js reports true only for recent activity.
    // Codex/Gemini bypass (PTY writes, no focus steal).
    if (!bypassesLock && typeof userInputFocused === 'function' && userInputFocused()) {
      scheduleDeferredRetry(paneId, 'user input focused (composing)');
      return;
    }

    if (bypassesLock && capabilities.typingGuardWhenBypassing) {
      const paneLastTypedAt = (lastTypedTime && lastTypedTime[id]) || 0;
      const paneRecentlyTyped = paneLastTypedAt && (Date.now() - paneLastTypedAt) < TYPING_GUARD_MS;
      if (userIsTyping() || paneRecentlyTyped) {
        scheduleDeferredRetry(paneId, 'typing guard active');
        return;
      }
    }

    clearDeferredState(id);

    // Dequeue and send immediately
    const item = queue.shift();
    const queuedMessage = typeof item === 'string' ? item : item.message;
    const onComplete = item && typeof item === 'object' ? item.onComplete : null;
    const verifySubmitAcceptedOverride = item && typeof item === 'object'
      ? item.verifySubmitAccepted
      : undefined;
    const startupInjectionOverride = item && typeof item === 'object'
      ? item.startupInjection
      : undefined;
    const acceptOutputTransitionOnlyOverride = item && typeof item === 'object'
      ? item.acceptOutputTransitionOnly
      : undefined;
    const hmSendFastEnterOverride = item && typeof item === 'object'
      ? item.hmSendFastEnter
      : undefined;
    const itemTraceContext = normalizeTraceContext(item && typeof item === 'object' ? item.traceContext : null);
    const itemCorrId = itemTraceContext?.traceId
      || itemTraceContext?.correlationId
      || (item && typeof item === 'object' && item.correlationId)
      || bus.getCurrentCorrelation();
    const itemCausationId = itemTraceContext?.parentEventId || itemTraceContext?.causationId || undefined;

    bus.emit('inject.mode.selected', {
      paneId: id,
      payload: {
        mode: capabilities.modeLabel,
        enterMethod: capabilities.enterMethod,
        verifySubmitAccepted: typeof verifySubmitAcceptedOverride === 'boolean'
          ? verifySubmitAcceptedOverride
          : capabilities.verifySubmitAccepted,
        startupInjection: Boolean(startupInjectionOverride),
        acceptOutputTransitionOnly: Boolean(acceptOutputTransitionOnlyOverride),
        hmSendFastEnter: Boolean(hmSendFastEnterOverride || isHmSendFastTraceContext(itemTraceContext)),
        useChunkedWrite: capabilities.useChunkedWrite,
      },
      correlationId: itemCorrId,
      causationId: itemCausationId,
      source: EVENT_SOURCE,
    });

    bus.emit('queue.depth.changed', {
      paneId: id,
      payload: { depth: queue.length },
      correlationId: itemCorrId,
      causationId: itemCausationId,
      source: EVENT_SOURCE,
    });

    bus.updateState(id, { activity: 'injecting' });

    if (bypassesLock) {
      log.debug(`Terminal ${paneId}`, `${capabilities.displayName} pane: immediate send`);
    } else {
      log.info(`Terminal ${id}`, `${capabilities.modeLabel} pane: immediate send`);
      setInjectionInFlight(true);
    }

    doSendToPane(paneId, queuedMessage, (result) => {
      if (!bypassesLock) {
        setInjectionInFlight(false);
      }
      bus.updateState(id, { activity: 'idle' });
      if (typeof onComplete === 'function') {
        try {
          onComplete(result);
        } catch (err) {
          log.error('Terminal', 'queue onComplete failed', err);
        }
      }
      if (queue.length > 0) {
        setTimeout(() => processIdleQueue(paneId), QUEUE_RETRY_MS);
      }
    }, itemTraceContext || {
      traceId: itemCorrId || null,
      parentEventId: itemCausationId || null,
      correlationId: itemCorrId || null,
      causationId: itemCausationId || null,
      eventId: itemTraceContext?.eventId || null,
    }, {
      verifySubmitAccepted: verifySubmitAcceptedOverride,
      startupInjection: startupInjectionOverride,
      acceptOutputTransitionOnly: acceptOutputTransitionOnlyOverride,
      hmSendFastEnter: hmSendFastEnterOverride,
    });
  }

  // Actually send message to pane (internal - use sendToPane for idle detection)
  // Triggers actual DOM keyboard events on xterm textarea with bypass marker
  // Includes diagnostic logging and focus steal prevention (save/restore user focus)
  async function doSendToPane(paneId, message, onComplete, traceContext = null, behaviorOverrides = {}) {
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
    // Safety timer releases injectionInFlight lock if callbacks are missed
    // Uses let so it can be replaced with a longer timer during Enter+verify phase
    let safetyTimerId = setTimeout(() => {
      // Timeout doesn't mean failure - message may still be delivered
      // Return success:true so delivery ack is sent, but mark as unverified
      bus.emit('inject.timeout', {
        paneId: id,
        payload: { timeoutMs: INJECTION_LOCK_TIMEOUT_MS },
        source: EVENT_SOURCE,
      });
      finish({ success: true, verified: false, status: 'submit_unverified_timeout', reason: 'timeout' });
    }, INJECTION_LOCK_TIMEOUT_MS);
    const finishWithClear = (result) => {
      clearTimeout(safetyTimerId);
      finish(result || { success: true });
    };

    const text = message.replace(/\r$/, '');
    const id = String(paneId);
    const capabilities = getPaneInjectionCapabilities(id);
    const shouldVerifySubmitAccepted = (typeof behaviorOverrides.verifySubmitAccepted === 'boolean')
      ? behaviorOverrides.verifySubmitAccepted
      : capabilities.verifySubmitAccepted;
    const isStartupInjection = Boolean(behaviorOverrides.startupInjection);
    const allowOutputTransitionOnly = Boolean(behaviorOverrides.acceptOutputTransitionOnly);
    const normalizedTraceContext = normalizeTraceContext(traceContext);
    const hmSendFastEnter = Boolean(behaviorOverrides.hmSendFastEnter)
      || isHmSendFastTraceContext(normalizedTraceContext);
    const corrId = normalizedTraceContext?.traceId
      || normalizedTraceContext?.correlationId
      || bus.getCurrentCorrelation()
      || undefined;
    let currentParentEventId = normalizedTraceContext?.parentEventId
      || normalizedTraceContext?.causationId
      || normalizedTraceContext?.eventId
      || null;
    const createKernelMeta = () => {
      const eventId = `${id}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const kernelMeta = {
        eventId,
        correlationId: corrId,
        traceId: corrId,
        parentEventId: currentParentEventId || undefined,
        causationId: currentParentEventId || undefined,
        source: EVENT_SOURCE,
      };
      currentParentEventId = eventId;
      return kernelMeta;
    };

    const paneEl = document.querySelector(`.pane[data-pane-id="${id}"]`);
    let textarea = paneEl ? paneEl.querySelector('.xterm-helper-textarea') : null;

    if (capabilities.requiresFocusForEnter && !textarea) {
      log.warn(`doSendToPane ${id}`, `${capabilities.modeLabel} pane: textarea not found, skipping injection`);
      bus.emit('inject.failed', {
        paneId: id,
        payload: { reason: 'missing_textarea' },
        correlationId: corrId,
        source: EVENT_SOURCE,
      });
      finishWithClear({ success: false, reason: 'missing_textarea' });
      return;
    }

    const savedFocus = document.activeElement;
    const restoreSavedFocus = () => {
      if (!savedFocus || !textarea || savedFocus === textarea) return;
      if (!document.body.contains(savedFocus)) return;
      try {
        savedFocus.focus();
      } catch {
        // Ignore non-focusable elements.
      }
    };
    const scheduleFocusRestore = () => {
      if (!capabilities.requiresFocusForEnter) return;
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => restoreSavedFocus());
      } else {
        setTimeout(() => restoreSavedFocus(), 0);
      }
    };

    if (capabilities.requiresFocusForEnter && textarea) {
      textarea.focus();
    }

    const normalizedText = String(text || '');
    const longMessageBytes = Math.max(1, Number(CLAUDE_LONG_MESSAGE_BYTES) || 1024);
    const rawPayloadBytes = Buffer.byteLength(normalizedText, 'utf8');
    const isLongPayload = rawPayloadBytes > longMessageBytes;
    const modeFingerprint = `${String(capabilities.displayName || '').toLowerCase()} ${String(capabilities.modeLabel || '').toLowerCase()}`.trim();
    const isCodexOrGeminiPane = modeFingerprint.includes('codex') || modeFingerprint.includes('gemini');
    const preserveMultilineForLongRuntimePayload = isLongPayload && isCodexOrGeminiPane;
    const shouldSanitizeMultiline = capabilities.sanitizeMultiline && !preserveMultilineForLongRuntimePayload;

    const payloadText = shouldSanitizeMultiline
      ? normalizedText.replace(/[\r\n]/g, ' ').trimEnd()
      : normalizedText;
    const payloadBytes = Buffer.byteLength(payloadText, 'utf8');
    const enterDelayMs = computeScaledEnterDelayMs(capabilities.enterDelayMs, payloadBytes, capabilities);
    const forceChunkedWriteForLongFastPath = hmSendFastEnter && isLongPayload;
    const preferChunkedWrite = capabilities.useChunkedWrite || forceChunkedWriteForLongFastPath;

    // Defer before writing to avoid counting our own echoed input as "active output".
    const isLongClaudeMessage = capabilities.enterMethod === 'trusted' && payloadBytes >= longMessageBytes;
    let deferResult = { waitedMs: 0, forcedExpire: false };
    if (capabilities.deferSubmitWhilePaneActive) {
      const deferMaxWaitMs = isLongClaudeMessage
        ? Math.max(SUBMIT_DEFER_MAX_WAIT_MS, Number(SUBMIT_DEFER_MAX_WAIT_LONG_MS) || 5000)
        : SUBMIT_DEFER_MAX_WAIT_MS;
      deferResult = await deferSubmitWhilePaneActive(id, deferMaxWaitMs);
    }
    const deferForcedExpire = !!deferResult?.forcedExpire;

    if (shouldSanitizeMultiline && payloadText !== normalizedText.trimEnd()) {
      bus.emit('inject.transform.applied', {
        paneId: id,
        payload: {
          transform: capabilities.sanitizeTransform || 'sanitize-multiline',
          originalLen: normalizedText.length,
          sanitizedLen: payloadText.length,
        },
        correlationId: corrId,
        source: EVENT_SOURCE,
      });
    }

    try {
      if (preferChunkedWrite) {
        const chunkThresholdBytes = Math.max(1024, Number(CLAUDE_CHUNK_THRESHOLD_BYTES) || (8 * 1024));
        const shouldChunkWrite = forceChunkedWriteForLongFastPath || payloadBytes > chunkThresholdBytes;

        if (!shouldChunkWrite) {
          await window.hivemind.pty.write(id, payloadText, createKernelMeta());
        } else {
          const first32 = payloadText.slice(0, 32).replace(/\r/g, '\\r').replace(/\n/g, '\\n');
          const last32 = payloadText.slice(-32).replace(/\r/g, '\\r').replace(/\n/g, '\\n');
          log.info(
            `doSendToPane ${id}`,
            `${capabilities.modeLabel} pane: pre-PTY fingerprint textLen=${payloadText.length} first32="${first32}" last32="${last32}"`
          );

          // Prepend Home reset to payload so it arrives in the same PTY write,
          // preventing split-chunk rendering of \x1b[H as literal "[H" text.
          const writeText = capabilities.homeResetBeforeWrite
            ? '\x1b[H' + payloadText
            : payloadText;

          if (typeof window.hivemind?.pty?.writeChunked !== 'function') {
            log.warn(`doSendToPane ${id}`, 'writeChunked API unavailable, falling back to single PTY write');
            await window.hivemind.pty.write(id, writeText, createKernelMeta());
          } else {
            const chunkMin = Math.max(1, Number(CLAUDE_CHUNK_MIN_SIZE) || 1024);
            const chunkMax = Math.max(chunkMin, Number(CLAUDE_CHUNK_MAX_SIZE) || 8192);
            const chunkSize = Math.max(chunkMin, Math.min(chunkMax, Number(CLAUDE_CHUNK_SIZE) || 2048));
            const yieldEveryChunks = (Math.max(0, Number(CLAUDE_CHUNK_YIELD_MS) || 0) > 0) ? 1 : 0;
            const chunkOptions = { chunkSize, yieldEveryChunks };
            if (forceChunkedWriteForLongFastPath) {
              chunkOptions.waitForWriteAck = true;
            }
            const chunkResult = await window.hivemind.pty.writeChunked(
              id,
              writeText,
              chunkOptions,
              createKernelMeta()
            );
            if (chunkResult && chunkResult.success === false) {
              throw new Error(chunkResult.error || 'writeChunked returned failure');
            }
          }
        }
      } else {
        await window.hivemind.pty.write(id, payloadText, createKernelMeta());
      }

      bus.emit('inject.applied', {
        paneId: id,
        payload: { method: capabilities.appliedMethod, textLen: payloadText.length },
        correlationId: corrId,
        source: EVENT_SOURCE,
      });
    } catch (err) {
      if (capabilities.displayName === 'Gemini') {
        log.error(`doSendToPane ${id}`, 'Gemini PTY write failed:', err);
      } else {
        log.error(`doSendToPane ${id}`, 'PTY write failed:', err);
      }
      bus.emit('inject.failed', {
        paneId: id,
        payload: { reason: 'pty_write_failed', error: String(err) },
        correlationId: corrId,
        source: EVENT_SOURCE,
      });
      finishWithClear({ success: false, reason: 'pty_write_failed' });
      return;
    }

    if (hmSendFastEnter) {
      // Wait for the CLI to finish processing the pasted text before sending Enter.
      // Without this delay, \r arrives while the CLI is still ingesting the paste
      // and gets swallowed or treated as a literal newline — not a submit.
      const fastPathDelayMs = Math.max(enterDelayMs, 80);
      await sleep(fastPathDelayMs);

      bus.emit('inject.submit.requested', {
        paneId: id,
        payload: { method: 'hm-send-pty-enter', attempt: 1, maxAttempts: 1, fastPath: true, delayMs: fastPathDelayMs },
        correlationId: corrId,
        source: EVENT_SOURCE,
      });
      try {
        await window.hivemind.pty.write(id, '\r');
      } catch (err) {
        log.error(`doSendToPane ${id}`, 'hm-send PTY Enter failed:', err);
        bus.emit('inject.failed', {
          paneId: id,
          payload: { reason: 'enter_failed', method: 'hm-send-pty-enter' },
          correlationId: corrId,
          source: EVENT_SOURCE,
        });
        markPotentiallyStuck(id);
        finishWithClear({ success: false, reason: 'enter_failed' });
        return;
      }

      bus.emit('inject.submit.sent', {
        paneId: id,
        payload: { method: 'hm-send-pty-enter', attempt: 1, maxAttempts: 1, fastPath: true },
        correlationId: corrId,
        source: EVENT_SOURCE,
      });
      updatePaneStatus(id, 'Working');
      lastTypedTime[id] = Date.now();
      lastOutputTime[id] = Date.now();
      finishWithClear({
        success: true,
        verified: true,
        signal: 'hm_send_fast_path',
      });
      return;
    }

    const submitEnter = async () => {
      if (capabilities.enterMethod === 'trusted') {
        return sendEnterToPane(id);
      }
      if (capabilities.enterMethod === 'pty') {
        try {
          await window.hivemind.pty.write(id, '\r', createKernelMeta());
          return { success: true, method: capabilities.submitMethod };
        } catch (err) {
          log.error(`doSendToPane ${id}`, 'PTY Enter failed:', err);
          return {
            success: false,
            method: capabilities.submitMethod,
            reason: capabilities.enterFailureReason || 'enter_failed',
          };
        }
      }
      return { success: true, method: 'none' };
    };

    setTimeout(async () => {
      if (capabilities.requiresFocusForEnter) {
        const currentPane = document.querySelector(`.pane[data-pane-id="${id}"]`);
        textarea = currentPane ? currentPane.querySelector('.xterm-helper-textarea') : null;
        if (!textarea) {
          log.warn(`doSendToPane ${id}`, `${capabilities.modeLabel} pane: textarea disappeared before Enter, aborting`);
          restoreSavedFocus();
          finishWithClear({ success: false, reason: 'textarea_disappeared' });
          return;
        }
      }

      clearTimeout(safetyTimerId);
      safetyTimerId = setTimeout(() => {
        finish({ success: true, verified: false, status: 'submit_unverified_timeout', reason: 'timeout' });
      }, CLAUDE_SUBMIT_SAFETY_TIMEOUT_MS);

      if (capabilities.requiresFocusForEnter && typeof userInputFocused === 'function' && userInputFocused()) {
        log.info(`doSendToPane ${id}`, 'User actively composing before Enter - waiting for idle');
        const focusWaitStart = Date.now();
        while (userInputFocused() && (Date.now() - focusWaitStart) < 5000) {
          await sleep(100);
        }
        if (userInputFocused()) {
          log.warn(`doSendToPane ${id}`, 'User composition still active after 5s - proceeding with Enter');
        }
      }

      let submitAccepted = null;
      const maxSubmitAttempts = shouldVerifySubmitAccepted
        ? Math.max(
          isStartupInjection ? 2 : 1,
          Number(SUBMIT_ACCEPT_MAX_ATTEMPTS) || 1,
          deferForcedExpire ? 2 : 1
        )
        : 1;

      for (let attempt = 1; attempt <= maxSubmitAttempts; attempt += 1) {
        const promptProbeAvailable = canProbePromptState(id);
        const attemptBaseline = {
          outputTsBefore: getLastOutputTimestamp(id),
          promptProbeAvailable,
          promptWasReady: promptProbeAvailable ? isPromptReady(id) : false,
        };

        if (capabilities.requiresFocusForEnter && textarea) {
          const focusOk = await focusWithRetry(textarea);
          if (!focusOk) {
            log.warn(`doSendToPane ${id}`, `${capabilities.modeLabel} pane: focus failed, proceeding with Enter anyway`);
          } else if (deferForcedExpire && attempt > 1) {
            log.info(`doSendToPane ${id}`, 'Force-expired defer: refocus succeeded before retry Enter');
          }
        }

        bus.emit('inject.submit.requested', {
          paneId: id,
          payload: { method: capabilities.submitMethod, attempt, maxAttempts: maxSubmitAttempts },
          correlationId: corrId,
          source: EVENT_SOURCE,
        });

        const enterResult = await submitEnter();
        scheduleFocusRestore();

        if (!enterResult.success) {
          bus.emit('inject.failed', {
            paneId: id,
            payload: { reason: enterResult.reason || 'enter_failed', method: enterResult.method },
            correlationId: corrId,
            source: EVENT_SOURCE,
          });
          markPotentiallyStuck(id);
          finishWithClear({ success: false, reason: 'enter_failed' });
          return;
        }

        bus.emit('inject.submit.sent', {
          paneId: id,
          payload: { method: enterResult.method, attempt, maxAttempts: maxSubmitAttempts },
          correlationId: corrId,
          source: EVENT_SOURCE,
        });

        if (!shouldVerifySubmitAccepted) {
          submitAccepted = { accepted: true, signal: 'verification_disabled' };
          break;
        }

        const verifyResult = await verifySubmitAccepted(id, attemptBaseline, { allowOutputTransitionOnly });
        if (verifyResult.accepted) {
          log.info(
            `doSendToPane ${id}`,
            `Submit acceptance verified via ${verifyResult.signal} (attempt ${attempt}/${maxSubmitAttempts})`
          );
          submitAccepted = verifyResult;
          break;
        }

        const signalDetails = `signal=${verifyResult.signal} outputTransition=${verifyResult.outputTransitionObserved ? 'yes' : 'no'} promptTransition=${verifyResult.promptTransitionObserved ? 'yes' : 'no'}`;
        log.warn(
          `doSendToPane ${id}`,
          `Submit acceptance check failed on attempt ${attempt}/${maxSubmitAttempts}; ${signalDetails}`
        );

        if (attempt < maxSubmitAttempts) {
          if (deferForcedExpire && attempt === 1) {
            log.warn(
              `doSendToPane ${id}`,
              'Force-expired defer path active - auto-retrying Enter with refocus'
            );
          }
          log.warn(
            `doSendToPane ${id}`,
            `Submit acceptance not observed after attempt ${attempt}; retrying in ${SUBMIT_ACCEPT_RETRY_BACKOFF_MS}ms`
          );
          await sleep(SUBMIT_ACCEPT_RETRY_BACKOFF_MS);
        }
      }

      let submitVerified = true;
      if (!submitAccepted) {
        // Enter succeeded; treat submit verification as advisory so delivery is not downgraded.
        submitVerified = false;
        submitAccepted = { accepted: true, signal: 'accepted_unverified' };
        log.warn(
          `doSendToPane ${id}`,
          `Submit acceptance not observed after ${maxSubmitAttempts} attempt(s); treating as accepted.unverified`
        );
      }

      updatePaneStatus(id, 'Working');
      lastTypedTime[id] = Date.now();
      lastOutputTime[id] = Date.now();
      const successResult = shouldVerifySubmitAccepted
        ? (
          submitVerified
            ? { success: true, verified: true, signal: submitAccepted.signal }
            : { success: true, verified: false, signal: submitAccepted.signal, status: 'accepted.unverified', reason: 'submit_not_accepted' }
        )
        : { success: true };
      finishWithClear({
        ...successResult,
      });
    }, enterDelayMs);
  }
  // Send message to a specific pane (queues if pane is busy)
  // options.priority = true puts message at FRONT of queue (for user messages)
  function sendToPane(paneId, message, options = {}) {
    const id = String(paneId);
    const capabilities = getPaneInjectionCapabilities(id);
    const isCodexRuntime = String(capabilities?.displayName || '').toLowerCase() === 'codex'
      || String(capabilities?.modeLabel || '').toLowerCase().includes('codex');
    const shouldApplyCodexExecPrompt = isCodexRuntime
      && typeof buildCodexExecPrompt === 'function'
      && options.startupInjection !== true;
    let payloadMessage = message;
    if (shouldApplyCodexExecPrompt) {
      try {
        payloadMessage = buildCodexExecPrompt(id, payloadMessage);
      } catch (err) {
        log.warn(`Terminal ${id}`, `Codex exec prompt build failed, using raw payload: ${err.message}`);
      }
    }

    const incomingTraceContext = normalizeTraceContext(options.traceContext);
    const corrId = incomingTraceContext?.traceId
      || incomingTraceContext?.correlationId
      || bus.startCorrelation();
    const causationId = incomingTraceContext?.parentEventId
      || incomingTraceContext?.causationId
      || undefined;

    const requestedEvent = bus.emit('inject.requested', {
      paneId: id,
      payload: { priority: options.priority || false, messageLen: payloadMessage.length },
      correlationId: corrId,
      causationId,
      source: EVENT_SOURCE,
    });
    const requestedEventId = requestedEvent?.eventId || incomingTraceContext?.eventId || null;

    if (!messageQueue[id]) {
      messageQueue[id] = [];
    }
    const queue = messageQueue[id];

    const queueTraceContext = {
      traceId: corrId,
      correlationId: corrId,
      parentEventId: requestedEventId || causationId || null,
      causationId: requestedEventId || causationId || null,
      eventId: requestedEventId,
    };

    const queueItem = {
      message: payloadMessage,
      timestamp: Date.now(),
      onComplete: options.onComplete,
      priority: options.priority || false,
      immediate: options.immediate || false,
      hmSendFastEnter: options.hmSendFastEnter === true,
      correlationId: corrId,
      traceContext: queueTraceContext,
      verifySubmitAccepted: typeof options.verifySubmitAccepted === 'boolean'
        ? options.verifySubmitAccepted
        : undefined,
      startupInjection: typeof options.startupInjection === 'boolean'
        ? options.startupInjection
        : undefined,
      acceptOutputTransitionOnly: typeof options.acceptOutputTransitionOnly === 'boolean'
        ? options.acceptOutputTransitionOnly
        : undefined,
    };

    const maxItems = getInjectionQueueMaxItems();
    const maxBytes = getInjectionQueueMaxBytes();
    const incomingBytes = getQueueItemBytes(queueItem);
    if (incomingBytes > maxBytes) {
      log.warn(`Terminal ${id}`, `Dropping oversize queued message (${incomingBytes} bytes > ${maxBytes} byte cap)`);
      failQueueItem(queueItem, 'queue_oversize');
      return;
    }

    let queueBytes = getQueueBytes(queue);
    let droppedCount = 0;
    while (
      queue.length >= maxItems
      || ((queueBytes + incomingBytes) > maxBytes && queue.length > 0)
    ) {
      const dropped = queue.shift();
      queueBytes -= getQueueItemBytes(dropped);
      droppedCount += 1;
      failQueueItem(dropped, 'queue_overflow');
    }
    if (droppedCount > 0) {
      log.warn(
        `Terminal ${id}`,
        `Injection queue cap reached; dropped ${droppedCount} stale message(s) `
        + `(maxItems=${maxItems}, maxBytes=${maxBytes})`
      );
    }

    // Priority lane: keep priority items ahead of normal items, while preserving
    // FIFO order among priority messages to avoid rapid-send reordering.
    if (options.priority) {
      let insertIndex = 0;
      while (insertIndex < queue.length && queue[insertIndex]?.priority === true) {
        insertIndex += 1;
      }
      queue.splice(insertIndex, 0, queueItem);
      log.info(`Terminal ${id}`, `USER message queued with PRIORITY (lane index ${insertIndex})`);
    } else {
      queue.push(queueItem);
    }

    bus.emit('inject.queued', {
      paneId: id,
      payload: { depth: queue.length, priority: queueItem.priority },
      correlationId: corrId,
      causationId: queueTraceContext.parentEventId || undefined,
      source: EVENT_SOURCE,
    });
    bus.emit('queue.depth.changed', {
      paneId: id,
      payload: { depth: queue.length },
      correlationId: corrId,
      causationId: queueTraceContext.parentEventId || undefined,
      source: EVENT_SOURCE,
    });

    const reason = userIsTyping()
      ? 'user typing'
      : (getInjectionInFlight() ? 'injection in flight' : 'ready');
    log.info(`Terminal ${id}`, `${reason}, queueing message`);

    // Start processing idle queue
    processIdleQueue(id);
  }

  return {
    focusWithRetry,
    sendEnterToPane,
    isPromptReady,
    processIdleQueue,
    doSendToPane,
    sendToPane,
    clearPaneQueue,
  };
}

module.exports = { createInjectionController };
