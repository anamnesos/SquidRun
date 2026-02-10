/**
 * Terminal injection helpers
 * Extracted from terminal.js to isolate fragile send/verify logic.
 */

const log = require('../logger');
const bus = require('../event-bus');
const { BYPASS_CLEAR_DELAY_MS: DEFAULT_BYPASS_CLEAR_DELAY_MS } = require('../constants');

const EVENT_SOURCE = 'injection.js';

function createInjectionController(options = {}) {
  const {
    terminals,
    lastOutputTime,
    lastTypedTime,
    messageQueue,
    isCodexPane,
    isGeminiPane,  // Session 67: Re-enabled - Gemini CLI accepts PTY \r unlike Claude's ink TUI
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
    INJECTION_LOCK_TIMEOUT_MS,
    BYPASS_CLEAR_DELAY_MS = DEFAULT_BYPASS_CLEAR_DELAY_MS,
    TYPING_GUARD_MS = 300,
    GEMINI_ENTER_DELAY_MS = 75,
    MAX_COMPACTION_DEFER_MS = 30000,
  } = constants;

  // Track when compaction deferral started per pane (false positive safety valve)
  const compactionDeferStart = new Map();

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
    // It routes through onData -> pty.write, same as direct PTY '\r' (no-op for ink TUI)
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

    const tryDomFallback = () => {
      if (typeof document === 'undefined') return false;
      const paneEl = document.querySelector(`.pane[data-pane-id="${paneId}"]`);
      const textarea = paneEl ? paneEl.querySelector('.xterm-helper-textarea') : null;
      if (!textarea) return false;

      try {
        textarea.focus();
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
        log.info(`sendEnterToPane ${paneId}`, 'Enter sent via DOM fallback dispatch');
        return true;
      } catch (err) {
        log.warn(`sendEnterToPane ${paneId}`, 'DOM fallback failed:', err);
        return false;
      }
    };

    try {
      const result = await window.hivemind.pty.sendTrustedEnter();
      if (result && result.success === false) {
        throw new Error(result.error || 'sendTrustedEnter failed');
      }
      log.info(`sendEnterToPane ${paneId}`, 'Enter sent via sendTrustedEnter (focus-based, bypass enabled)');
      return { success: true, method: 'sendTrustedEnter' };
    } catch (err) {
      log.error(`sendEnterToPane ${paneId}`, 'sendTrustedEnter failed:', err);
      const fallbackOk = tryDomFallback();
      if (fallbackOk) {
        return { success: true, method: 'domFallback' };
      }
      return { success: false, method: 'sendTrustedEnter' };
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

  // IDLE QUEUE: Process queued messages for a pane.
  // Messages arrive here from the throttle queue (daemon-handlers.js
  // processThrottleQueue → terminal.sendToPane). For Claude panes, the only
  // gates are injectionInFlight (focus mutex) and userInputFocused (composing
  // guard). No idle/busy timing — messages send immediately like user input.
  function processIdleQueue(paneId) {
    const id = String(paneId);
    const isCodex = isCodexPane(id);
    const isGemini = isGeminiPane(id);
    const bypassesLock = isCodex || isGemini;

    const queue = messageQueue[paneId];
    if (!queue || queue.length === 0) return;

    // Compaction gate: never inject while compaction is confirmed on this pane.
    // Only applies to Claude panes — Codex/Gemini don't do Claude-style compaction.
    // This closes the Item 20 failure mode where queued messages were submitted
    // into compaction output and appeared delivered despite being swallowed.
    // Safety valve: if gate has been stuck for > MAX_COMPACTION_DEFER_MS, force-clear
    // as a false positive (real compaction lasts 5-15s, never 30s+).
    const paneState = (typeof bus.getState === 'function') ? bus.getState(id) : null;
    if (!bypassesLock && paneState?.gates?.compacting === 'confirmed') {
      if (!compactionDeferStart.has(id)) {
        compactionDeferStart.set(id, Date.now());
      }
      const deferDuration = Date.now() - compactionDeferStart.get(id);
      if (deferDuration < MAX_COMPACTION_DEFER_MS) {
        log.info(`processQueue ${id}`, 'Pane deferred - compaction gate active (confirmed)');
        setTimeout(() => processIdleQueue(paneId), QUEUE_RETRY_MS);
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
      log.info(`processQueue ${id}`, 'Claude pane deferred - injection in flight');
      setTimeout(() => processIdleQueue(paneId), 50);
      return;
    }
    if (bypassesLock && getInjectionInFlight()) {
      log.debug(`processQueue ${id}`, `${isCodex ? 'Codex' : 'Gemini'} pane bypassing global lock`);
    }

    // Gate 2: userInputFocused — defer while user is composing in broadcastInput.
    // Codex/Gemini bypass (PTY writes, no focus steal).
    if (!bypassesLock && typeof userInputFocused === 'function' && userInputFocused()) {
      log.info(`processQueue ${id}`, 'Claude pane deferred - user input focused (composing)');
      setTimeout(() => processIdleQueue(paneId), QUEUE_RETRY_MS);
      return;
    }

    // For Codex/Gemini: still respect per-pane typing guard
    if (bypassesLock) {
      const paneLastTypedAt = (lastTypedTime && lastTypedTime[id]) || 0;
      const paneRecentlyTyped = paneLastTypedAt && (Date.now() - paneLastTypedAt) < TYPING_GUARD_MS;
      if (userIsTyping() || paneRecentlyTyped) {
        setTimeout(() => processIdleQueue(paneId), QUEUE_RETRY_MS);
        return;
      }
    }

    // Dequeue and send immediately
    const item = queue.shift();
    const queuedMessage = typeof item === 'string' ? item : item.message;
    const onComplete = item && typeof item === 'object' ? item.onComplete : null;
    const itemCorrId = (item && typeof item === 'object' && item.correlationId) || bus.getCurrentCorrelation();

    const mode = isCodex ? 'codex-exec' : (isGemini ? 'gemini-pty' : 'claude-pty');
    bus.emit('inject.mode.selected', {
      paneId: id,
      payload: { mode },
      correlationId: itemCorrId,
      source: EVENT_SOURCE,
    });

    bus.emit('queue.depth.changed', {
      paneId: id,
      payload: { depth: queue.length },
      correlationId: itemCorrId,
      source: EVENT_SOURCE,
    });

    bus.updateState(id, { activity: 'injecting' });

    if (bypassesLock) {
      log.debug(`Terminal ${paneId}`, `${isCodex ? 'Codex' : 'Gemini'} pane: immediate send`);
    } else {
      log.info(`Terminal ${id}`, 'Claude pane: immediate send');
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
    }, itemCorrId);
  }

  // Actually send message to pane (internal - use sendToPane for idle detection)
  // Triggers actual DOM keyboard events on xterm textarea with bypass marker
  // Includes diagnostic logging and focus steal prevention (save/restore user focus)
  async function doSendToPane(paneId, message, onComplete, correlationId = null) {
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
      finish({ success: true, verified: false, reason: 'timeout' });
    }, INJECTION_LOCK_TIMEOUT_MS);
    const finishWithClear = (result) => {
      clearTimeout(safetyTimerId);
      finish(result || { success: true });
    };

    const text = message.replace(/\r$/, '');
    const id = String(paneId);
    const isCodex = isCodexPane(id);
    const createKernelMeta = () => ({
      eventId: `${id}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      correlationId: correlationId || bus.getCurrentCorrelation() || undefined,
      source: EVENT_SOURCE,
    });

    // Codex exec mode: bypass PTY/textarea injection
    if (isCodex) {
      const corrId = bus.getCurrentCorrelation();
      bus.emit('inject.transform.applied', {
        paneId: id,
        payload: { transform: 'codex-exec-prompt' },
        correlationId: corrId,
        source: EVENT_SOURCE,
      });
      const prompt = buildCodexExecPrompt(id, text);
      // Echo user input to xterm so it's visible
      const terminal = terminals.get(id);
      if (terminal) {
        terminal.write(`\r\n\x1b[36m> ${text}\x1b[0m\r\n`);
      }
      bus.emit('inject.applied', {
        paneId: id,
        payload: { method: 'codex-exec', textLen: text.length },
        correlationId: corrId,
        source: EVENT_SOURCE,
      });
      bus.emit('inject.submit.sent', {
        paneId: id,
        payload: { method: 'codex-exec' },
        correlationId: corrId,
        source: EVENT_SOURCE,
      });
      window.hivemind.pty.codexExec(id, prompt).catch(err => {
        log.error(`doSendToPane ${id}`, 'Codex exec failed:', err);
        bus.emit('inject.failed', {
          paneId: id,
          payload: { reason: 'codex_exec_error', error: String(err) },
          correlationId: corrId,
          source: EVENT_SOURCE,
        });
      });
      updatePaneStatus(id, 'Working');
      lastTypedTime[id] = Date.now();
      lastOutputTime[id] = Date.now();
      finishWithClear({ success: true });
      return;
    }

    // GEMINI PATH: PTY write sanitized text + always send Enter via PTY \r
    // Gemini CLI uses readline which accepts PTY \r as submit. The body is
    // sanitized first: embedded \r/\n replaced with spaces to prevent readline
    // from treating them as partial submit signals. A single \r is then sent
    // unconditionally to submit the text — same as the Claude path.
    // Payloads may or may not include trailing \r — Enter is sent unconditionally
    // regardless, so injection.js owns the submit decision for all pane types.
    const isGemini = isGeminiPane(id);
    if (isGemini) {
      const corrId = bus.getCurrentCorrelation();
      log.info(`doSendToPane ${id}`, 'Gemini pane: PTY text + Enter');

      // Clear any stuck input first (Ctrl+U)
      try {
        await window.hivemind.pty.write(id, '\x15', createKernelMeta());
        log.debug(`doSendToPane ${id}`, 'Gemini pane: cleared input line (Ctrl+U)');
      } catch (err) {
        log.warn(`doSendToPane ${id}`, 'PTY clear-line failed:', err);
      }

      // Replace embedded \r/\n with spaces to prevent readline partial execution,
      // then strip trailing whitespace.
      const sanitizedText = text.replace(/[\r\n]/g, ' ').trimEnd();
      if (sanitizedText !== text.trimEnd()) {
        bus.emit('inject.transform.applied', {
          paneId: id,
          payload: { transform: 'gemini-sanitize', originalLen: text.length, sanitizedLen: sanitizedText.length },
          correlationId: corrId,
          source: EVENT_SOURCE,
        });
      }

      // Write sanitized text to PTY
      try {
        await window.hivemind.pty.write(id, sanitizedText, createKernelMeta());
        log.info(`doSendToPane ${id}`, `Gemini pane: PTY text write complete (${sanitizedText.length} chars)`);
        bus.emit('inject.applied', {
          paneId: id,
          payload: { method: 'gemini-pty', textLen: sanitizedText.length },
          correlationId: corrId,
          source: EVENT_SOURCE,
        });
      } catch (err) {
        log.error(`doSendToPane ${id}`, 'Gemini PTY write failed:', err);
        bus.emit('inject.failed', {
          paneId: id,
          payload: { reason: 'pty_write_failed', error: String(err) },
          correlationId: corrId,
          source: EVENT_SOURCE,
        });
        finishWithClear({ success: false, reason: 'pty_write_failed' });
        return;
      }

      // Delay before Enter so Gemini readline can process the text
      await new Promise(resolve => setTimeout(resolve, GEMINI_ENTER_DELAY_MS));

      // Always send Enter via PTY \r — Gemini readline needs it to submit
      bus.emit('inject.submit.requested', {
        paneId: id,
        payload: { method: 'gemini-pty-enter' },
        correlationId: corrId,
        source: EVENT_SOURCE,
      });
      try {
        await window.hivemind.pty.write(id, '\r', createKernelMeta());
        log.info(`doSendToPane ${id}`, 'Gemini pane: PTY Enter sent');
        bus.emit('inject.submit.sent', {
          paneId: id,
          payload: { method: 'gemini-pty-enter' },
          correlationId: corrId,
          source: EVENT_SOURCE,
        });
      } catch (err) {
        log.error(`doSendToPane ${id}`, 'Gemini PTY Enter failed:', err);
        bus.emit('inject.failed', {
          paneId: id,
          payload: { reason: 'pty_enter_failed', error: String(err) },
          correlationId: corrId,
          source: EVENT_SOURCE,
        });
        finishWithClear({ success: false, reason: 'pty_enter_failed' });
        return;
      }

      updatePaneStatus(id, 'Working');
      lastTypedTime[id] = Date.now();
      finishWithClear({ success: true });
      return;
    }

    // CLAUDE PATH: PTY write for text + sendTrustedEnter for Enter
    // PTY \r does NOT auto-submit in Claude Code's ink TUI — must use native
    // Electron keyboard events via sendTrustedEnter. Enter is always sent.
    const corrId = bus.getCurrentCorrelation();
    const paneEl = document.querySelector(`.pane[data-pane-id="${id}"]`);
    let textarea = paneEl ? paneEl.querySelector('.xterm-helper-textarea') : null;

    // Guard: Skip if textarea not found (prevents Enter going to wrong element)
    if (!textarea) {
      log.warn(`doSendToPane ${id}`, 'Claude pane: textarea not found, skipping injection');
      bus.emit('inject.failed', {
        paneId: id,
        payload: { reason: 'missing_textarea' },
        correlationId: corrId,
        source: EVENT_SOURCE,
      });
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
        } catch {
          // Element may not be focusable
        }
      }
    };
    const scheduleFocusRestore = () => {
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => restoreSavedFocus());
      } else {
        setTimeout(() => restoreSavedFocus(), 0);
      }
    };

    // Step 1: Focus terminal for sendTrustedEnter (required for Enter to target correct pane)
    textarea.focus();

    // Step 2: Clear any stuck input BEFORE writing new text
    // Ctrl+U (0x15) clears the current input line - prevents accumulation if previous Enter failed
    // This is harmless if line is already empty
    try {
      await window.hivemind.pty.write(id, '\x15', createKernelMeta());
      log.info(`doSendToPane ${id}`, 'Claude pane: cleared input line (Ctrl+U)');
    } catch (err) {
      log.warn(`doSendToPane ${id}`, 'PTY clear-line failed:', err);
      // Continue anyway - text write may still work
    }

    // Step 3: Write text to PTY (without \r)
    try {
      await window.hivemind.pty.write(id, text, createKernelMeta());
      log.info(`doSendToPane ${id}`, 'Claude pane: PTY write text complete');
      bus.emit('inject.applied', {
        paneId: id,
        payload: { method: 'claude-pty', textLen: text.length },
        correlationId: corrId,
        source: EVENT_SOURCE,
      });
    } catch (err) {
      log.error(`doSendToPane ${id}`, 'PTY write failed:', err);
      bus.emit('inject.failed', {
        paneId: id,
        payload: { reason: 'pty_write_failed', error: String(err) },
        correlationId: corrId,
        source: EVENT_SOURCE,
      });
      finishWithClear({ success: false, reason: 'pty_write_failed' });
      return;
    }

    // Step 4: Send Enter via sendTrustedEnter after short fixed delay
    // Claude panes always need Enter because ink TUI only responds to native
    // keyboard events, not PTY \r. Use a short fixed delay (50ms) to let the
    // PTY text write settle before sending Enter.
    const CLAUDE_ENTER_DELAY_MS = 50;

    setTimeout(async () => {
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

      // Focus isolation: if user focused an input during the Enter delay,
      // wait for them to blur before stealing focus for sendTrustedEnter.
      // Poll every 100ms, give up after 5s to prevent message starvation.
      // Extend the safety timer to 6s so it outlasts the 5s poll + overhead,
      // preventing premature lock release that could allow a second message
      // to write PTY text while this message's Enter hasn't fired yet.
      if (typeof userInputFocused === 'function' && userInputFocused()) {
        clearTimeout(safetyTimerId);
        safetyTimerId = setTimeout(() => {
          finish({ success: true, verified: false, reason: 'timeout' });
        }, 6000);
        log.info(`doSendToPane ${id}`, 'User input focused before Enter — waiting for blur');
        const focusWaitStart = Date.now();
        while (userInputFocused() && (Date.now() - focusWaitStart) < 5000) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (userInputFocused()) {
          log.warn(`doSendToPane ${id}`, 'User input still focused after 5s — proceeding with Enter');
        }
      }

      // Ensure focus for sendTrustedEnter
      const focusOk = await focusWithRetry(textarea);
      if (!focusOk) {
        log.warn(`doSendToPane ${id}`, 'Claude pane: focus failed, proceeding with Enter anyway');
      }

      // Send Enter
      bus.emit('inject.submit.requested', {
        paneId: id,
        payload: { method: 'sendTrustedEnter' },
        correlationId: corrId,
        source: EVENT_SOURCE,
      });
      const enterResult = await sendEnterToPane(id);

      // Restore focus immediately after Enter (no verification loop)
      scheduleFocusRestore();

      if (!enterResult.success) {
        log.error(`doSendToPane ${id}`, 'Enter send failed');
        bus.emit('inject.failed', {
          paneId: id,
          payload: { reason: 'enter_failed', method: enterResult.method },
          correlationId: corrId,
          source: EVENT_SOURCE,
        });
        markPotentiallyStuck(id);
        finishWithClear({ success: false, reason: 'enter_failed' });
        return;
      }

      bus.emit('inject.submit.sent', {
        paneId: id,
        payload: { method: enterResult.method },
        correlationId: corrId,
        source: EVENT_SOURCE,
      });
      log.info(`doSendToPane ${id}`, `Claude pane: Enter sent via ${enterResult.method}`);
      lastTypedTime[id] = Date.now();
      finishWithClear({ success: true });
    }, CLAUDE_ENTER_DELAY_MS);
  }

  // Send message to a specific pane (queues if pane is busy)
  // options.priority = true puts message at FRONT of queue (for user messages)
  function sendToPane(paneId, message, options = {}) {
    const id = String(paneId);
    const corrId = bus.startCorrelation();

    bus.emit('inject.requested', {
      paneId: id,
      payload: { priority: options.priority || false, messageLen: message.length },
      correlationId: corrId,
      source: EVENT_SOURCE,
    });

    if (!messageQueue[id]) {
      messageQueue[id] = [];
    }

    const queueItem = {
      message: message,
      timestamp: Date.now(),
      onComplete: options.onComplete,
      priority: options.priority || false,
      immediate: options.immediate || false,
      correlationId: corrId,
    };

    // User messages (priority) go to front of queue, agent messages go to back
    if (options.priority) {
      messageQueue[id].unshift(queueItem);
      log.info(`Terminal ${id}`, 'USER message queued with PRIORITY (front of queue)');
    } else {
      messageQueue[id].push(queueItem);
    }

    bus.emit('inject.queued', {
      paneId: id,
      payload: { depth: messageQueue[id].length, priority: queueItem.priority },
      correlationId: corrId,
      source: EVENT_SOURCE,
    });
    bus.emit('queue.depth.changed', {
      paneId: id,
      payload: { depth: messageQueue[id].length },
      correlationId: corrId,
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
  };
}

module.exports = { createInjectionController };
