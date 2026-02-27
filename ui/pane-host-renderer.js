function readPaneIdFromQuery(params) {
  try {
    const paneId = params.get('paneId');
    return paneId ? String(paneId) : '1';
  } catch {
    return '1';
  }
}

function readPositiveIntFromQuery(params, key, fallback) {
  try {
    const raw = params.get(key);
    const numeric = Number.parseInt(String(raw || ''), 10);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
  } catch {
    return fallback;
  }
}

function detectDarwin() {
  const platform = String(
    navigator.userAgentData?.platform
      || navigator.platform
      || navigator.userAgent
      || ''
  ).toLowerCase();
  return platform.includes('mac');
}

function toNonEmptyString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function isHmSendTraceContext(traceContext = null) {
  const ctx = (traceContext && typeof traceContext === 'object') ? traceContext : {};
  const messageId = toNonEmptyString(ctx.messageId);
  const traceId = toNonEmptyString(ctx.traceId) || toNonEmptyString(ctx.correlationId);
  return Boolean(
    (messageId && messageId.startsWith('hm-'))
    || (traceId && traceId.startsWith('hm-'))
  );
}

function stripInternalRoutingWrappers(value) {
  if (typeof value !== 'string') return '';
  let clean = value;
  clean = clean.replace(/^\s*\[AGENT MSG - reply via hm-send\.js\]\s*/i, '');
  for (let i = 0; i < 3; i += 1) {
    const next = clean.replace(/^\s*\[MSG from [^\]]+\]:\s*/i, '');
    if (next === clean) break;
    clean = next;
  }
  return clean;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, timeoutMs, label) {
  const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5000;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    Promise.resolve(promise)
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

function getUtf8ByteLength(value) {
  const text = typeof value === 'string' ? value : String(value || '');
  if (typeof TextEncoder === 'function') {
    return new TextEncoder().encode(text).length;
  }
  return text.length;
}

(function bootPaneHost() {
  const params = new URLSearchParams(window.location.search || '');
  const paneId = readPaneIdFromQuery(params);
  const isDarwin = detectDarwin();
  const api = window.squidrun;
  const TerminalCtor = window.Terminal;
  const FitAddonCtor = window.FitAddon && window.FitAddon.FitAddon;

  if (!api?.pty || !api?.paneHost?.inject) {
    console.error(`[PaneHost] Missing preload bridge for pane ${paneId}`);
    return;
  }
  if (!TerminalCtor || !FitAddonCtor) {
    console.error(`[PaneHost] Missing xterm globals for pane ${paneId}`);
    return;
  }

  const DEFAULT_POST_ENTER_VERIFY_TIMEOUT_MS = isDarwin ? 3000 : 4000;
  const DEFAULT_SUBMIT_DEFER_ACTIVE_OUTPUT_WINDOW_MS = isDarwin ? 250 : 350;
  const DEFAULT_SUBMIT_DEFER_MAX_WAIT_MS = isDarwin ? 1200 : 2000;
  const DEFAULT_SUBMIT_DEFER_MAX_WAIT_LONG_MS = isDarwin ? 3000 : 5000;
  const DEFAULT_SUBMIT_DEFER_POLL_MS = isDarwin ? 50 : 100;
  const DEFAULT_LONG_PAYLOAD_BYTES = isDarwin ? 2048 : 1024;
  const DEFAULT_HM_SEND_POST_ENTER_VERIFY_TIMEOUT_MS = isDarwin ? 700 : 800;
  const DEFAULT_MIN_ENTER_DELAY_MS = isDarwin ? 150 : 500;
  const DEFAULT_CHUNK_THRESHOLD_BYTES = isDarwin ? 4096 : 2048;
  const DEFAULT_CHUNK_SIZE_BYTES = isDarwin ? 4096 : 2048;
  const DEFAULT_HM_SEND_CHUNK_THRESHOLD_BYTES = isDarwin ? 2048 : 1024;
  const DEFAULT_HM_SEND_CHUNK_YIELD_EVERY_CHUNKS = 1;

  const POST_ENTER_VERIFY_TIMEOUT_MS = readPositiveIntFromQuery(
    params,
    'verifyTimeoutMs',
    DEFAULT_POST_ENTER_VERIFY_TIMEOUT_MS
  );
  const SUBMIT_DEFER_ACTIVE_OUTPUT_WINDOW_MS = readPositiveIntFromQuery(
    params,
    'activeOutputWindowMs',
    DEFAULT_SUBMIT_DEFER_ACTIVE_OUTPUT_WINDOW_MS
  );
  const SUBMIT_DEFER_MAX_WAIT_MS = readPositiveIntFromQuery(
    params,
    'submitDeferMaxWaitMs',
    DEFAULT_SUBMIT_DEFER_MAX_WAIT_MS
  );
  const SUBMIT_DEFER_MAX_WAIT_LONG_MS = readPositiveIntFromQuery(
    params,
    'submitDeferMaxWaitLongMs',
    DEFAULT_SUBMIT_DEFER_MAX_WAIT_LONG_MS
  );
  const SUBMIT_DEFER_POLL_MS = readPositiveIntFromQuery(
    params,
    'submitDeferPollMs',
    DEFAULT_SUBMIT_DEFER_POLL_MS
  );
  const LONG_PAYLOAD_BYTES = readPositiveIntFromQuery(
    params,
    'longPayloadBytes',
    DEFAULT_LONG_PAYLOAD_BYTES
  );
  const HM_SEND_POST_ENTER_VERIFY_TIMEOUT_MS = readPositiveIntFromQuery(
    params,
    'hmSendVerifyTimeoutMs',
    DEFAULT_HM_SEND_POST_ENTER_VERIFY_TIMEOUT_MS
  );
  const MIN_ENTER_DELAY_MS = readPositiveIntFromQuery(
    params,
    'minEnterDelayMs',
    DEFAULT_MIN_ENTER_DELAY_MS
  );
  const CHUNK_THRESHOLD_BYTES = readPositiveIntFromQuery(
    params,
    'chunkThresholdBytes',
    DEFAULT_CHUNK_THRESHOLD_BYTES
  );
  const CHUNK_SIZE_BYTES = readPositiveIntFromQuery(
    params,
    'chunkSizeBytes',
    DEFAULT_CHUNK_SIZE_BYTES
  );
  const HM_SEND_CHUNK_THRESHOLD_BYTES = readPositiveIntFromQuery(
    params,
    'hmSendChunkThresholdBytes',
    DEFAULT_HM_SEND_CHUNK_THRESHOLD_BYTES
  );
  const HM_SEND_CHUNK_YIELD_EVERY_CHUNKS = readPositiveIntFromQuery(
    params,
    'hmSendChunkYieldEveryChunks',
    DEFAULT_HM_SEND_CHUNK_YIELD_EVERY_CHUNKS
  );
  const WRITE_TIMEOUT_MS = readPositiveIntFromQuery(params, 'writeTimeoutMs', 8000);
  const ENTER_TIMEOUT_MS = readPositiveIntFromQuery(params, 'enterTimeoutMs', 5000);

  const TERMINAL_FONT_FAMILY = isDarwin
    ? "'SF Mono', 'Menlo', 'Monaco', 'Courier New', monospace"
    : "'Consolas', 'Monaco', 'Courier New', monospace";

  let injectedScrollback = false;
  let injectChain = Promise.resolve();
  let ptyOutputTick = 0;
  let lastPtyOutputAtMs = 0;
  const pendingOutputWaiters = new Set();

  const terminal = new TerminalCtor({
    theme: {
      background: '#0a0a0f',
      foreground: '#e8eaf0',
      cursor: '#00f0ff',
      cursorAccent: '#0a0a0f',
      selection: 'rgba(0, 240, 255, 0.25)',
    },
    fontFamily: TERMINAL_FONT_FAMILY,
    fontSize: 13,
    cursorBlink: true,
    cursorStyle: 'block',
    scrollback: 3000,
    rightClickSelectsWord: true,
    allowProposedApi: true,
  });

  const terminalRoot = document.getElementById('paneHostTerminal');
  if (!terminalRoot) {
    console.error(`[PaneHost] Missing terminal root for pane ${paneId}`);
    return;
  }

  const fitAddon = new FitAddonCtor();
  terminal.loadAddon(fitAddon);
  terminal.open(terminalRoot);
  fitAddon.fit();
  terminal.focus();

  window.addEventListener('resize', () => {
    try {
      fitAddon.fit();
    } catch {
      // Best-effort only.
    }
  });

  function waitForPtyOutputAfter(baselineTick, timeoutMs = POST_ENTER_VERIFY_TIMEOUT_MS) {
    if (ptyOutputTick > baselineTick) return Promise.resolve(true);
    const maxWaitMs = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : DEFAULT_POST_ENTER_VERIFY_TIMEOUT_MS;

    return new Promise((resolve) => {
      const waiter = {
        baselineTick,
        resolve,
        timeoutId: null,
      };
      waiter.timeoutId = setTimeout(() => {
        pendingOutputWaiters.delete(waiter);
        resolve(false);
      }, maxWaitMs);
      pendingOutputWaiters.add(waiter);
    });
  }

  function resolveOutputWaiters() {
    if (pendingOutputWaiters.size === 0) return;
    for (const waiter of Array.from(pendingOutputWaiters)) {
      if (ptyOutputTick <= waiter.baselineTick) continue;
      pendingOutputWaiters.delete(waiter);
      clearTimeout(waiter.timeoutId);
      waiter.resolve(true);
    }
  }

  function paneHasRecentOutput(windowMs = SUBMIT_DEFER_ACTIVE_OUTPUT_WINDOW_MS) {
    const activeWindowMs = Number.isFinite(windowMs) && windowMs > 0
      ? windowMs
      : DEFAULT_SUBMIT_DEFER_ACTIVE_OUTPUT_WINDOW_MS;
    if (!lastPtyOutputAtMs) return false;
    return (Date.now() - lastPtyOutputAtMs) <= activeWindowMs;
  }

  async function deferSubmitWhilePaneActive(maxWaitMs = SUBMIT_DEFER_MAX_WAIT_MS) {
    const deferMaxWaitMs = Number.isFinite(maxWaitMs) && maxWaitMs > 0
      ? maxWaitMs
      : DEFAULT_SUBMIT_DEFER_MAX_WAIT_MS;
    const pollMs = Math.max(
      25,
      Number.isFinite(SUBMIT_DEFER_POLL_MS) ? SUBMIT_DEFER_POLL_MS : DEFAULT_SUBMIT_DEFER_POLL_MS
    );
    const start = Date.now();

    while (paneHasRecentOutput() && (Date.now() - start) < deferMaxWaitMs) {
      await sleep(pollMs);
    }

    const waitedMs = Math.max(0, Date.now() - start);
    return {
      waitedMs,
      forcedExpire: paneHasRecentOutput(),
    };
  }

  function sendPaneHostAction(action, payload = {}) {
    return api.paneHost.inject(paneId, {
      action,
      ...payload,
    });
  }

  function reportDeliveryAck(deliveryId) {
    if (!deliveryId) return;
    sendPaneHostAction('delivery-ack', { deliveryId }).catch((err) => {
      console.error(`[PaneHost] Failed to report delivery ack for pane ${paneId}:`, err?.message || err);
    });
  }

  function reportDeliveryOutcome(payload = {}) {
    sendPaneHostAction('delivery-outcome', payload).catch((err) => {
      console.error(`[PaneHost] Failed to report delivery outcome for pane ${paneId}:`, err?.message || err);
    });
  }

  async function injectMessage(payload = {}) {
    const text = stripInternalRoutingWrappers(String(payload.message || ''));
    const deliveryId = payload.deliveryId || null;
    const traceContext = payload.traceContext || null;
    const hmSendTrace = isHmSendTraceContext(traceContext);
    const payloadBytes = getUtf8ByteLength(text);
    const isLongPayload = payloadBytes >= Math.max(
      1,
      Number.isFinite(LONG_PAYLOAD_BYTES) ? LONG_PAYLOAD_BYTES : DEFAULT_LONG_PAYLOAD_BYTES
    );

    try {
      // Use chunked write for large payloads to prevent PTY pipe truncation.
      const chunkThreshold = Number.isFinite(CHUNK_THRESHOLD_BYTES) && CHUNK_THRESHOLD_BYTES > 0
        ? CHUNK_THRESHOLD_BYTES
        : DEFAULT_CHUNK_THRESHOLD_BYTES;
      const chunkSize = Number.isFinite(CHUNK_SIZE_BYTES) && CHUNK_SIZE_BYTES > 0
        ? CHUNK_SIZE_BYTES
        : DEFAULT_CHUNK_SIZE_BYTES;
      const hmSendChunkThreshold = Number.isFinite(HM_SEND_CHUNK_THRESHOLD_BYTES) && HM_SEND_CHUNK_THRESHOLD_BYTES > 0
        ? HM_SEND_CHUNK_THRESHOLD_BYTES
        : DEFAULT_HM_SEND_CHUNK_THRESHOLD_BYTES;
      const forceChunkForHmSend = hmSendTrace && payloadBytes >= hmSendChunkThreshold;
      const shouldChunkWrite = Boolean(api.pty.writeChunked)
        && (payloadBytes > chunkThreshold || forceChunkForHmSend);
      if (shouldChunkWrite) {
        const chunkOptions = { chunkSize };
        if (forceChunkForHmSend) {
          chunkOptions.yieldEveryChunks = Math.max(
            1,
            Number.isFinite(HM_SEND_CHUNK_YIELD_EVERY_CHUNKS)
              ? HM_SEND_CHUNK_YIELD_EVERY_CHUNKS
              : DEFAULT_HM_SEND_CHUNK_YIELD_EVERY_CHUNKS
          );
        }
        const chunkedResult = await withTimeout(
          api.pty.writeChunked(paneId, text, chunkOptions, traceContext || null),
          WRITE_TIMEOUT_MS,
          'pane-host writeChunked'
        );
        if (chunkedResult && chunkedResult.success === false) {
          throw new Error(chunkedResult.error || 'writeChunked returned failure');
        }
      } else {
        await withTimeout(
          api.pty.write(paneId, text, traceContext || null),
          WRITE_TIMEOUT_MS,
          'pane-host write'
        );
      }

      // Minimum wait for the PTY to process pasted text before sending Enter.
      const baseMinDelay = Math.max(
        100,
        Number.isFinite(MIN_ENTER_DELAY_MS) ? MIN_ENTER_DELAY_MS : DEFAULT_MIN_ENTER_DELAY_MS
      );
      const hmSendExtraDelayMs = hmSendTrace && isLongPayload
        ? Math.min(600, Math.ceil(Math.max(0, payloadBytes - LONG_PAYLOAD_BYTES) / 64))
        : 0;
      const minDelay = baseMinDelay + hmSendExtraDelayMs;
      await sleep(minDelay);

      // Then wait for output activity to settle.
      const deferMaxWaitMs = isLongPayload
        ? Math.max(SUBMIT_DEFER_MAX_WAIT_MS, SUBMIT_DEFER_MAX_WAIT_LONG_MS)
        : SUBMIT_DEFER_MAX_WAIT_MS;
      const deferResult = await deferSubmitWhilePaneActive(deferMaxWaitMs);
      if (deferResult.forcedExpire) {
        console.warn(
          `[PaneHost] Submit defer window expired for pane ${paneId} after ${deferResult.waitedMs}ms; `
          + 'sending Enter while output is still active'
        );
      }

      const outputBaseline = ptyOutputTick;
      const enterResult = await withTimeout(
        sendPaneHostAction('dispatch-enter'),
        ENTER_TIMEOUT_MS,
        'pane-host dispatch-enter'
      );
      if (!enterResult || !enterResult.success) {
        console.error(
          `[PaneHost] pane-host dispatch-enter FAILED for pane ${paneId}:`,
          enterResult?.reason || 'unknown'
        );
      }

      const postEnterVerifyTimeoutMs = hmSendTrace
        ? Math.max(
          200,
          Number.isFinite(HM_SEND_POST_ENTER_VERIFY_TIMEOUT_MS)
            ? HM_SEND_POST_ENTER_VERIFY_TIMEOUT_MS
            : DEFAULT_HM_SEND_POST_ENTER_VERIFY_TIMEOUT_MS
        )
        : POST_ENTER_VERIFY_TIMEOUT_MS;
      const outputObserved = await waitForPtyOutputAfter(outputBaseline, postEnterVerifyTimeoutMs);
      const treatAsDelivered = Boolean(outputObserved || (hmSendTrace && enterResult?.success));

      if (deliveryId) {
        if (treatAsDelivered) {
          reportDeliveryAck(deliveryId);
        } else {
          reportDeliveryOutcome({
            deliveryId,
            paneId,
            accepted: true,
            verified: false,
            status: 'accepted.unverified',
            reason: 'post_enter_output_timeout',
          });
        }
      }

      if (!outputObserved && hmSendTrace && enterResult?.success) {
        console.warn(
          `[PaneHost] hm-send trace accepted for pane ${paneId} without immediate PTY output `
          + `(${postEnterVerifyTimeoutMs}ms window)`
        );
      } else if (!outputObserved) {
        console.warn(
          `[PaneHost] Delivery remained unverified for pane ${paneId} after Enter `
          + `(${postEnterVerifyTimeoutMs}ms without PTY output)`
        );
      }
    } catch (err) {
      console.error(`[PaneHost] injectMessage FAILED for pane ${paneId}:`, err.message);
      if (deliveryId) {
        reportDeliveryOutcome({
          deliveryId,
          paneId,
          accepted: false,
          verified: false,
          status: 'delivery_failed',
          reason: err.message,
        });
      }
    }
  }

  function handlePaneHostEvent(payload = {}) {
    const source = String(payload?.source || '').trim().toLowerCase();
    if (source !== 'pane-host') return;
    if (String(payload?.paneId || '') !== paneId) return;
    const type = String(payload?.type || '').trim().toLowerCase();

    if (type === 'prime-scrollback') {
      if (injectedScrollback) return;
      const scrollback = String(payload?.scrollback || '');
      if (!scrollback) return;
      injectedScrollback = true;
      terminal.write(scrollback);
      return;
    }

    if (type === 'inject-message') {
      injectChain = injectChain
        .then(() => injectMessage(payload))
        .catch((err) => {
          console.error(`[PaneHost] Inject chain error for pane ${paneId}:`, err?.message || err);
        });
    }
  }

  const disposeDataListener = api.pty.onData(paneId, (data) => {
    ptyOutputTick += 1;
    lastPtyOutputAtMs = Date.now();
    resolveOutputWaiters();
    terminal.write(String(data || ''));
  });

  const disposeExitListener = api.pty.onExit(paneId, (code) => {
    const exitCode = code ?? '?';
    terminal.write(`\r\n[Process exited with code ${exitCode}]\r\n`);
  });

  api.pty.onKernelBridgeEvent((payload = {}) => {
    handlePaneHostEvent(payload);
  });

  window.addEventListener('beforeunload', () => {
    if (typeof disposeDataListener === 'function') disposeDataListener();
    if (typeof disposeExitListener === 'function') disposeExitListener();
  });

  sendPaneHostAction('ready').catch((err) => {
    console.error(`[PaneHost] Failed to send ready for pane ${paneId}:`, err?.message || err);
  });
})();
