/**
 * Terminal injection helpers
 * Extracted from terminal.js to isolate fragile send/verify logic.
 */

const log = require('../logger');
const { BYPASS_CLEAR_DELAY_MS: DEFAULT_BYPASS_CLEAR_DELAY_MS } = require('../constants');

function createInjectionController(options = {}) {
  const {
    terminals,
    lastOutputTime,
    lastTypedTime,
    messageQueue,
    isCodexPane,
    isGeminiPane,  // Session 67: Re-enabled - Gemini CLI accepts PTY \r unlike Claude's ink TUI
    buildCodexExecPrompt,
    isIdle,
    isIdleForForceInject,
    userIsTyping,
    updatePaneStatus,
    markPotentiallyStuck,
    getInjectionInFlight,
    setInjectionInFlight,
    constants = {},
  } = options;

  const {
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
    BYPASS_CLEAR_DELAY_MS = DEFAULT_BYPASS_CLEAR_DELAY_MS,
  } = constants;

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
    }
    // No recent output - pane is idle, fast Enter is safe
    return ENTER_DELAY_IDLE_MS;
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
        }, BYPASS_CLEAR_DELAY_MS);
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

  // IDLE QUEUE: Process queued messages for a pane when it becomes idle
  // This is the SECOND queue in the two-queue system. Messages arrive here from
  // the throttle queue (daemon-handlers.js processThrottleQueue → terminal.sendToPane).
  // This queue waits for the pane to be idle (2s silence) before actual injection.
  function processIdleQueue(paneId) {
    const id = String(paneId);
    const isCodex = isCodexPane(id);

    // Global lock applies to Claude panes only (need focus for sendTrustedEnter)
    // Codex bypasses - uses codex-exec API, no PTY/focus needed
    // Session 67: Gemini also bypasses - uses PTY \r directly, no focus needed
    const isGemini = isGeminiPane(id);
    const bypassesLock = isCodex || isGemini;
    if (!bypassesLock && getInjectionInFlight()) {
      log.debug(`processQueue ${id}`, 'Claude pane deferred - injection in flight');
      setTimeout(() => processIdleQueue(paneId), QUEUE_RETRY_MS);
      return;
    }
    if (bypassesLock && getInjectionInFlight()) {
      log.debug(`processQueue ${id}`, `${isCodex ? 'Codex' : 'Gemini'} pane bypassing global lock`);
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

    // Codex/Gemini panes bypass idle checks entirely - they use PTY writes
    // that don't require the careful timing Claude's ink TUI needs
    // Session 67: Gemini CLI sends frequent cursor/status updates (~12ms) that
    // prevent idle detection from passing, causing 60s delays without this bypass
    const canSendBypass = bypassesLock && !userIsTyping();

    // Normal case: pane is fully idle (2s of silence) - Claude panes only
    const canSendNormal = !bypassesLock && isIdle(paneId) && !userIsTyping();

    // Force-inject case: waited 10s+ AND pane has at least 500ms of silence
    // This prevents injecting during active output which causes Enter to be ignored
    const canForceInject = !bypassesLock && waitedTooLong && isIdleForForceInject(paneId) && !userIsTyping();

    // Emergency fallback: 60s absolute max regardless of idle state
    // This prevents messages from being stuck forever if pane never becomes idle
    const mustForceInject = !bypassesLock && hitAbsoluteMax && !userIsTyping();

    // Log warning at 30s mark (only once per message via flag check) - Claude panes only
    if (!bypassesLock && waitedExtremelyLong && !item._warnedExtreme) {
      item._warnedExtreme = true;
      const timeSinceOutput = Date.now() - (lastOutputTime[paneId] || 0);
      log.warn(`Terminal ${paneId}`, `Message queued 30s+, pane last output ${timeSinceOutput}ms ago, still waiting for idle`);
    }

    if (canSendBypass || canSendNormal || canForceInject || mustForceInject) {
      // Remove from queue and send
      queue.shift();
      if (canSendBypass) {
        log.debug(`Terminal ${paneId}`, `${isCodex ? 'Codex' : 'Gemini'} pane: bypassing idle check`);
      } else if (mustForceInject && !canForceInject && !canSendNormal) {
        log.warn(`Terminal ${paneId}`, `EMERGENCY: Force-injecting after ${waitTime}ms (60s max reached, pane may still be active)`);
      } else if (canForceInject && !canSendNormal) {
        log.info(`Terminal ${paneId}`, `Force-injecting after ${waitTime}ms wait (pane now idle for 500ms)`);
      }
      // Only set global lock for Claude panes (Codex/Gemini use focus-free paths)
      if (!bypassesLock) {
        setInjectionInFlight(true);
      }
      doSendToPane(paneId, queuedMessage, (result) => {
        if (!bypassesLock) {
          setInjectionInFlight(false);
        }
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
      });
    } else {
      // Still busy, retry later
      setTimeout(() => processIdleQueue(paneId), QUEUE_RETRY_MS);
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
      lastTypedTime[id] = Date.now();
      lastOutputTime[id] = Date.now();
      finishWithClear({ success: true });
      return;
    }

    // GEMINI PATH: PTY with delayed Enter (Session 68 - attempt 5)
    // Root cause found: Gemini's bufferFastReturn() converts Enter to newline
    // if it arrives within 30ms of previous keystroke. We must delay the Enter.
    const isGemini = isGeminiPane(id);
    if (isGemini) {
      log.info(`doSendToPane ${id}`, 'Gemini pane: using PTY with delayed Enter (>30ms)');

      // Clear any stuck input first (Ctrl+U)
      try {
        await window.hivemind.pty.write(id, '\x15');
        log.debug(`doSendToPane ${id}`, 'Gemini pane: cleared input line (Ctrl+U)');
      } catch (err) {
        log.warn(`doSendToPane ${id}`, 'PTY clear-line failed:', err);
      }

      // Write text to PTY (without Enter)
      try {
        await window.hivemind.pty.write(id, text);
        log.info(`doSendToPane ${id}`, `Gemini pane: PTY text write complete (${text.length} chars)`);
      } catch (err) {
        log.error(`doSendToPane ${id}`, 'Gemini PTY write failed:', err);
        finishWithClear({ success: false, reason: 'pty_write_failed' });
        return;
      }

      // Send Enter with delay to bypass Gemini's fast-return buffer (FAST_RETURN_TIMEOUT = 30ms)
      // Session 69: Increased from 150ms to 500ms - OS buffering can batch writes under load
      // Even with renderer delay, text+Enter can arrive in same stdin data event
      if (hasTrailingEnter) {
        await new Promise(resolve => setTimeout(resolve, 500)); // Wait 500ms - large buffer for OS/event-loop lag
        try {
          await window.hivemind.pty.write(id, '\r');
          log.info(`doSendToPane ${id}`, 'Gemini pane: PTY Enter sent after 500ms delay');
        } catch (err) {
          log.error(`doSendToPane ${id}`, 'Gemini PTY Enter failed:', err);
          finishWithClear({ success: false, reason: 'enter_failed' });
          return;
        }
      }

      updatePaneStatus(id, 'Working');
      lastTypedTime[id] = Date.now();
      finishWithClear({ success: true });
      return;
    }

    // CLAUDE PATH: Hybrid approach (PTY write for text + DOM keyboard for Enter)
    // PTY \r does NOT auto-submit in Claude Code's ink TUI (PTY newline ignored)
    // sendTrustedEnter() sends native keyboard events via Electron which WORKS
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

        // CRITICAL: Check if focus was maintained during sendTrustedEnter IPC round-trip
        // sendInputEvent sends to whatever is focused, so if focus changed, Enter went elsewhere
        const focusStillCorrect = document.activeElement === textarea;
        if (!focusStillCorrect) {
          log.warn(`doSendToPane ${id}`, 'Claude pane: focus changed during sendTrustedEnter IPC - Enter may have gone to wrong element');
        }

        // IMMEDIATELY restore focus after Enter sent - don't block user input during verification
        // (Restore focus to avoid blocking command bar during trigger injections)
        scheduleFocusRestore();

        if (!enterResult.success) {
          log.error(`doSendToPane ${id}`, 'Enter send failed');
          markPotentiallyStuck(id);
          finishWithClear({ success: false, reason: 'enter_failed' });
          return;
        }
        log.info(`doSendToPane ${id}`, `Claude pane: Enter sent via ${enterResult.method}${focusStillCorrect ? '' : ' (focus may have changed)'}`);

        // Verify Enter succeeded (textarea empty) - if not, wait for idle and retry
        // This handles force-inject during active output where Enter is ignored
        // Note: verification runs with focus already restored to user
        const submitOk = await verifyAndRetryEnter(id, textarea);
        if (!submitOk) {
          log.warn(`doSendToPane ${id}`, 'Claude pane: Enter verification failed after retries');
          markPotentiallyStuck(id); // Register for sweeper retry
        }

        lastTypedTime[id] = Date.now();
        const resultPayload = submitOk
          ? { success: true }
          // Enter was sent, but verification failed (no output/prompt yet) - treat as unverified success
          : { success: true, verified: false, reason: 'verification_failed' };
        finishWithClear(resultPayload);
      }, enterDelay);
    } else {
      // No Enter needed, just restore focus
      restoreSavedFocus();
      lastTypedTime[id] = Date.now();
      finishWithClear({ success: true });
    }
  }

  // Send message to a specific pane (queues if pane is busy)
  // options.priority = true puts message at FRONT of queue (for user messages)
  function sendToPane(paneId, message, options = {}) {
    const id = String(paneId);

    if (!messageQueue[id]) {
      messageQueue[id] = [];
    }

    const queueItem = {
      message: message,
      timestamp: Date.now(),
      onComplete: options.onComplete,
      priority: options.priority || false,
    };

    // User messages (priority) go to front of queue, agent messages go to back
    if (options.priority) {
      messageQueue[id].unshift(queueItem);
      log.info(`Terminal ${id}`, 'USER message queued with PRIORITY (front of queue)');
    } else {
      messageQueue[id].push(queueItem);
    }

    const reason = userIsTyping()
      ? 'user typing'
      : (getInjectionInFlight() ? 'injection in flight' : (!isIdle(id) ? 'pane busy' : 'idle'));
    log.info(`Terminal ${id}`, `${reason}, queueing message`);

    // Start processing idle queue
    processIdleQueue(id);
  }

  return {
    getAdaptiveEnterDelay,
    focusWithRetry,
    sendEnterToPane,
    isPromptReady,
    verifyAndRetryEnter,
    processIdleQueue,
    doSendToPane,
    sendToPane,
  };
}

module.exports = { createInjectionController };
