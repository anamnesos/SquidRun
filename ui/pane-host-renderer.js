function readPaneIdsFromQuery(params) {
  try {
    const raw = String(params.get('paneIds') || params.get('paneId') || '1');
    const values = raw
      .split(',')
      .map((value) => String(value || '').trim())
      .filter(Boolean);
    return values.length > 0 ? Array.from(new Set(values)) : ['1'];
  } catch {
    return ['1'];
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

function readNonNegativeIntFromQuery(params, key, fallback) {
  try {
    const raw = params.get(key);
    const numeric = Number.parseInt(String(raw || ''), 10);
    return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
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

function getPromptKindFromLine(lineText) {
  const line = String(lineText || '').trimEnd();
  if (!line) return 'unknown';
  if (/^>\s*$/.test(line) || /(?:^|[\s>])(?:codex|claude|gemini|cursor)>\s*$/i.test(line)) {
    return 'cli';
  }
  if (/(?:^|[\s>])PS\s+[^>\n]*>\s*$/i.test(line)) {
    return 'powershell';
  }
  if (/(?:^|[\s>])[A-Za-z]:\\[^>\n]*>\s*$/.test(line)) {
    return 'cmd';
  }
  if (/(?:^|[\w./~:-]+)[$#]\s*$/.test(line)) {
    return 'unix';
  }
  return 'unknown';
}

function formatHmSendForPrompt(text, promptKind) {
  if (!text || promptKind === 'cli') return text;
  const prefix = promptKind === 'cmd' ? 'REM ' : (promptKind === 'powershell' || promptKind === 'unix' ? '# ' : '');
  if (!prefix) return text;
  return String(text)
    .split('\n')
    .map((line) => (line ? `${prefix}${line}` : prefix.trimEnd()))
    .join('\n');
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

function resolvePostEnterDeliveryResult({ outputObserved = false, enterSucceeded = false } = {}) {
  if (outputObserved) {
    return { ack: true };
  }

  if (!enterSucceeded) {
    return {
      ack: false,
      outcome: {
        accepted: false,
        verified: false,
        status: 'delivery_failed',
        reason: 'enter_dispatch_failed',
      },
    };
  }

  return {
    ack: false,
    outcome: {
      accepted: true,
      verified: false,
      status: 'accepted.unverified',
      reason: 'post_enter_output_timeout',
    },
  };
}

function buildPtyWriteDispatchPlan({
  text = '',
  payloadBytes = null,
  hmSendTrace = false,
  ipcReassembled = false,
  hasChunkedWriter = false,
  homeResetBeforeWrite = false,
  chunkThresholdBytes = 1024,
  chunkSizeBytes = 4096,
  hmSendChunkThresholdBytes = 256,
  hmSendChunkYieldEveryChunks = 0,
} = {}) {
  const normalizedText = typeof text === 'string' ? text : String(text || '');
  const normalizedPayloadBytes = Number.isFinite(payloadBytes)
    ? payloadBytes
    : getUtf8ByteLength(normalizedText);
  const normalizedChunkThresholdBytes = Number.isFinite(chunkThresholdBytes) && chunkThresholdBytes > 0
    ? chunkThresholdBytes
    : 1024;
  const normalizedChunkSizeBytes = Number.isFinite(chunkSizeBytes) && chunkSizeBytes > 0
    ? chunkSizeBytes
    : 4096;
  const normalizedHmSendChunkThresholdBytes = Number.isFinite(hmSendChunkThresholdBytes) && hmSendChunkThresholdBytes > 0
    ? hmSendChunkThresholdBytes
    : 256;
  const normalizedHmSendChunkYieldEveryChunks = Number.isFinite(hmSendChunkYieldEveryChunks)
    && hmSendChunkYieldEveryChunks >= 0
    ? hmSendChunkYieldEveryChunks
    : 0;

  const forceChunkedWrite = Boolean(hmSendTrace || ipcReassembled);
  const forceChunkForHmSend = Boolean(hmSendTrace && normalizedPayloadBytes >= normalizedHmSendChunkThresholdBytes);
  const shouldChunkWrite = Boolean(
    hasChunkedWriter
    && (
      forceChunkedWrite
      || normalizedPayloadBytes >= normalizedChunkThresholdBytes
      || forceChunkForHmSend
    )
  );

  if (!shouldChunkWrite) {
    return {
      method: 'direct',
      forceChunkedWrite,
      forceChunkForHmSend,
      writeText: normalizedText,
      payloadBytes: normalizedPayloadBytes,
      chunkOptions: null,
    };
  }

  const writeText = homeResetBeforeWrite
    ? '\x1b[H' + normalizedText
    : normalizedText;
  const chunkOptions = {
    chunkSize: normalizedChunkSizeBytes,
  };
  if (forceChunkedWrite || forceChunkForHmSend) {
    chunkOptions.yieldEveryChunks = normalizedHmSendChunkYieldEveryChunks;
  }

  return {
    method: 'chunked',
    forceChunkedWrite,
    forceChunkForHmSend,
    writeText,
    payloadBytes: normalizedPayloadBytes,
    chunkOptions,
  };
}

function createPaneRuntime(paneId, terminal, fitAddon) {
  return {
    paneId,
    terminal,
    fitAddon,
    injectedScrollback: false,
    injectChain: Promise.resolve(),
    ptyOutputTick: 0,
    lastPtyOutputAtMs: 0,
    pendingOutputWaiters: new Set(),
    ipcChunkAssemblies: new Map(),
    disposeDataListener: null,
    disposeExitListener: null,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    _internals: {
      buildPtyWriteDispatchPlan,
      formatHmSendForPrompt,
      getPromptKindFromLine,
      resolvePostEnterDeliveryResult,
      stripInternalRoutingWrappers,
    },
  };
}

if (typeof window !== 'undefined') {
  (function bootPaneHost() {
  const params = new URLSearchParams(window.location.search || '');
  const paneIds = readPaneIdsFromQuery(params);
  const isDarwin = detectDarwin();
  const api = window.squidrun;
  const TerminalCtor = window.Terminal;
  const FitAddonCtor = window.FitAddon && window.FitAddon.FitAddon;

  if (!api?.pty || !api?.paneHost?.inject) {
    console.error('[PaneHost] Missing preload bridge');
    return;
  }
  if (!TerminalCtor || !FitAddonCtor) {
    console.error('[PaneHost] Missing xterm globals');
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
  const DEFAULT_CHUNK_THRESHOLD_BYTES = 1024;
  const DEFAULT_CHUNK_SIZE_BYTES = 4096;
  const DEFAULT_HM_SEND_CHUNK_THRESHOLD_BYTES = isDarwin ? 1024 : 256;
  const DEFAULT_HM_SEND_CHUNK_YIELD_EVERY_CHUNKS = 0;

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
  const HM_SEND_CHUNK_YIELD_EVERY_CHUNKS = readNonNegativeIntFromQuery(
    params,
    'hmSendChunkYieldEveryChunks',
    DEFAULT_HM_SEND_CHUNK_YIELD_EVERY_CHUNKS
  );
  const WRITE_TIMEOUT_MS = readPositiveIntFromQuery(params, 'writeTimeoutMs', 8000);
  const ENTER_TIMEOUT_MS = readPositiveIntFromQuery(params, 'enterTimeoutMs', 5000);

  const TERMINAL_FONT_FAMILY = isDarwin
    ? "'SF Mono', 'Menlo', 'Monaco', 'Courier New', monospace"
    : "'Consolas', 'Monaco', 'Courier New', monospace";

  const terminalRoot = document.getElementById('paneHostRoot');
  if (!terminalRoot) {
    console.error('[PaneHost] Missing terminal root');
    return;
  }

  /** @type {Map<string, ReturnType<typeof createPaneRuntime>>} */
  const paneRuntimeById = new Map();

  function sendPaneHostAction(action, paneId, payload = {}) {
    return api.paneHost.inject(paneId, {
      action,
      ...payload,
    });
  }

  function reportDeliveryAck(paneId, deliveryId) {
    if (!deliveryId) return;
    sendPaneHostAction('delivery-ack', paneId, { deliveryId }).catch((err) => {
      console.error(`[PaneHost] Failed to report delivery ack for pane ${paneId}:`, err?.message || err);
    });
  }

  function reportDeliveryOutcome(paneId, payload = {}) {
    sendPaneHostAction('delivery-outcome', paneId, payload).catch((err) => {
      console.error(`[PaneHost] Failed to report delivery outcome for pane ${paneId}:`, err?.message || err);
    });
  }

  function getCurrentPromptKind(terminal) {
    try {
      const buffer = terminal?.buffer?.active;
      if (!buffer || typeof buffer.getLine !== 'function') return 'unknown';
      const line = buffer.getLine(buffer.cursorY + buffer.viewportY);
      if (!line || typeof line.translateToString !== 'function') return 'unknown';
      return getPromptKindFromLine(line.translateToString(true));
    } catch {
      return 'unknown';
    }
  }

  function waitForPtyOutputAfter(runtime, baselineTick, timeoutMs = POST_ENTER_VERIFY_TIMEOUT_MS) {
    if (runtime.ptyOutputTick > baselineTick) return Promise.resolve(true);
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
        runtime.pendingOutputWaiters.delete(waiter);
        resolve(false);
      }, maxWaitMs);
      runtime.pendingOutputWaiters.add(waiter);
    });
  }

  function resolveOutputWaiters(runtime) {
    if (runtime.pendingOutputWaiters.size === 0) return;
    for (const waiter of Array.from(runtime.pendingOutputWaiters)) {
      if (runtime.ptyOutputTick <= waiter.baselineTick) continue;
      runtime.pendingOutputWaiters.delete(waiter);
      clearTimeout(waiter.timeoutId);
      waiter.resolve(true);
    }
  }

  function paneHasRecentOutput(runtime, windowMs = SUBMIT_DEFER_ACTIVE_OUTPUT_WINDOW_MS) {
    const activeWindowMs = Number.isFinite(windowMs) && windowMs > 0
      ? windowMs
      : DEFAULT_SUBMIT_DEFER_ACTIVE_OUTPUT_WINDOW_MS;
    if (!runtime.lastPtyOutputAtMs) return false;
    return (Date.now() - runtime.lastPtyOutputAtMs) <= activeWindowMs;
  }

  async function deferSubmitWhilePaneActive(runtime, maxWaitMs = SUBMIT_DEFER_MAX_WAIT_MS) {
    const deferMaxWaitMs = Number.isFinite(maxWaitMs) && maxWaitMs > 0
      ? maxWaitMs
      : DEFAULT_SUBMIT_DEFER_MAX_WAIT_MS;
    const pollMs = Math.max(
      25,
      Number.isFinite(SUBMIT_DEFER_POLL_MS) ? SUBMIT_DEFER_POLL_MS : DEFAULT_SUBMIT_DEFER_POLL_MS
    );
    const start = Date.now();

    while (paneHasRecentOutput(runtime) && (Date.now() - start) < deferMaxWaitMs) {
      await sleep(pollMs);
    }

    const waitedMs = Math.max(0, Date.now() - start);
    return {
      waitedMs,
      forcedExpire: paneHasRecentOutput(runtime),
    };
  }

  function pruneIpcChunkAssemblies(runtime, now = Date.now()) {
    for (const [key, entry] of runtime.ipcChunkAssemblies.entries()) {
      const updatedAt = Number(entry?.updatedAtMs || 0);
      if (!Number.isFinite(updatedAt) || (updatedAt + 60000) <= now) {
        runtime.ipcChunkAssemblies.delete(key);
      }
    }
  }

  function prepareInjectedPayload(runtime, rawPayload = {}) {
    const payload = (rawPayload && typeof rawPayload === 'object') ? rawPayload : {};
    const chunkMeta = payload.ipcChunk && typeof payload.ipcChunk === 'object' ? payload.ipcChunk : null;
    const message = String(payload.message || '');
    const actualBytes = getUtf8ByteLength(message);
    const expectedBytes = Number.isFinite(Number(payload.messageBytes)) ? Number(payload.messageBytes) : null;

    if (expectedBytes !== null && expectedBytes !== actualBytes) {
      console.warn(`[PaneHost] IPC byte mismatch for pane ${runtime.paneId}: expected ${expectedBytes}, received ${actualBytes}`);
    }

    if (!chunkMeta) {
      console.info(`[PaneHost] inject-message receive pane=${runtime.paneId} bytes=${actualBytes}/${expectedBytes ?? actualBytes}`);
      return { ready: true, payload: { ...payload, message, messageBytes: actualBytes, ipcChunk: null } };
    }

    pruneIpcChunkAssemblies(runtime);
    const groupId = toNonEmptyString(chunkMeta.groupId);
    const chunkIndex = Number.parseInt(String(chunkMeta.index ?? ''), 10);
    const chunkCount = Number.parseInt(String(chunkMeta.count ?? ''), 10);
    const totalBytes = Number.isFinite(Number(chunkMeta.totalBytes)) ? Number(chunkMeta.totalBytes) : null;
    if (!groupId || !Number.isFinite(chunkIndex) || !Number.isFinite(chunkCount) || chunkIndex < 0 || chunkCount <= 0) {
      console.warn(`[PaneHost] Invalid IPC chunk metadata for pane ${runtime.paneId}; delivering chunk directly`);
      return { ready: true, payload: { ...payload, message, messageBytes: actualBytes, ipcChunk: null } };
    }

    const key = `${runtime.paneId}:${groupId}`;
    const entry = runtime.ipcChunkAssemblies.get(key) || {
      count: chunkCount,
      totalBytes,
      parts: new Array(chunkCount),
      received: 0,
      updatedAtMs: Date.now(),
      payload,
    };

    if (!entry.parts[chunkIndex]) {
      entry.parts[chunkIndex] = message;
      entry.received += 1;
    }
    entry.updatedAtMs = Date.now();
    entry.payload = payload;
    runtime.ipcChunkAssemblies.set(key, entry);

    console.info(`[PaneHost] inject-message chunk pane=${runtime.paneId} group=${groupId} part=${chunkIndex + 1}/${chunkCount} bytes=${actualBytes}/${expectedBytes ?? actualBytes}`);

    if (entry.received < chunkCount) {
      return { ready: false, waitingFor: chunkCount - entry.received };
    }

    runtime.ipcChunkAssemblies.delete(key);
    const fullMessage = entry.parts.join('');
    const reassembledBytes = getUtf8ByteLength(fullMessage);
    if (entry.totalBytes !== null && entry.totalBytes !== reassembledBytes) {
      console.warn(`[PaneHost] IPC reassembly byte mismatch for pane ${runtime.paneId}: expected ${entry.totalBytes}, reassembled ${reassembledBytes}`);
    }
    console.info(`[PaneHost] inject-message reassembled pane=${runtime.paneId} group=${groupId} totalBytes=${reassembledBytes}`);

    return {
      ready: true,
      payload: {
        ...entry.payload,
        message: fullMessage,
        messageBytes: reassembledBytes,
        ipcChunk: null,
        meta: {
          ...(entry.payload.meta && typeof entry.payload.meta === 'object' ? entry.payload.meta : {}),
          ipcReassembled: true,
          ipcChunkCount: chunkCount,
        },
      },
    };
  }

  async function injectMessage(runtime, payload = {}) {
    const baseText = stripInternalRoutingWrappers(String(payload.message || ''));
    const deliveryId = payload.deliveryId || null;
    const traceContext = payload.traceContext || null;
    const hmSendTrace = isHmSendTraceContext(traceContext);
    const promptKind = hmSendTrace ? getCurrentPromptKind(runtime.terminal) : 'unknown';
    const text = hmSendTrace ? formatHmSendForPrompt(baseText, promptKind) : baseText;
    const payloadBytes = getUtf8ByteLength(text);
    const isLongPayload = payloadBytes >= Math.max(
      1,
      Number.isFinite(LONG_PAYLOAD_BYTES) ? LONG_PAYLOAD_BYTES : DEFAULT_LONG_PAYLOAD_BYTES
    );
    const deferMaxWaitMs = isLongPayload
      ? Math.max(SUBMIT_DEFER_MAX_WAIT_MS, SUBMIT_DEFER_MAX_WAIT_LONG_MS)
      : SUBMIT_DEFER_MAX_WAIT_MS;

    try {
      // Match the visible renderer path: wait for active pane output to settle
      // before the PTY write so the front of the injected message is not
      // interleaved with streaming CLI output.
      const preWriteDeferResult = await deferSubmitWhilePaneActive(runtime, deferMaxWaitMs);
      if (preWriteDeferResult.forcedExpire) {
        console.warn(
          `[PaneHost] Pre-write defer window expired for pane ${runtime.paneId} after ${preWriteDeferResult.waitedMs}ms; `
          + 'writing while output is still active'
        );
      }

      const chunkThreshold = Number.isFinite(CHUNK_THRESHOLD_BYTES) && CHUNK_THRESHOLD_BYTES > 0
        ? CHUNK_THRESHOLD_BYTES
        : DEFAULT_CHUNK_THRESHOLD_BYTES;
      const chunkSize = Number.isFinite(CHUNK_SIZE_BYTES) && CHUNK_SIZE_BYTES > 0
        ? CHUNK_SIZE_BYTES
        : DEFAULT_CHUNK_SIZE_BYTES;
      const hmSendChunkThreshold = Number.isFinite(HM_SEND_CHUNK_THRESHOLD_BYTES) && HM_SEND_CHUNK_THRESHOLD_BYTES > 0
        ? HM_SEND_CHUNK_THRESHOLD_BYTES
        : DEFAULT_HM_SEND_CHUNK_THRESHOLD_BYTES;
      const chunkYieldEveryChunks = Math.max(
        1,
        Number.isFinite(HM_SEND_CHUNK_YIELD_EVERY_CHUNKS)
          ? HM_SEND_CHUNK_YIELD_EVERY_CHUNKS
          : DEFAULT_HM_SEND_CHUNK_YIELD_EVERY_CHUNKS
      );
      const writePlan = buildPtyWriteDispatchPlan({
        text,
        payloadBytes,
        hmSendTrace,
        ipcReassembled: payload?.meta?.ipcReassembled === true,
        hasChunkedWriter: Boolean(api.pty.writeChunked),
        // Hidden pane-host deliveries should not prepend Home for hm-send traffic.
        // In production this can overwrite the visible screen buffer and make long
        // routed messages appear to lose their head even though the broker payload
        // is intact. Keep Home only for IPC-reassembled payload recovery.
        homeResetBeforeWrite: payload?.meta?.ipcReassembled === true,
        chunkThresholdBytes: chunkThreshold,
        chunkSizeBytes: chunkSize,
        hmSendChunkThresholdBytes: hmSendChunkThreshold,
        hmSendChunkYieldEveryChunks: chunkYieldEveryChunks,
      });
      if (writePlan.method === 'chunked') {
        const chunkedResult = await withTimeout(
          api.pty.writeChunked(runtime.paneId, writePlan.writeText, writePlan.chunkOptions, traceContext || null),
          WRITE_TIMEOUT_MS,
          'pane-host writeChunked'
        );
        if (chunkedResult && chunkedResult.success === false) {
          throw new Error(chunkedResult.error || 'writeChunked returned failure');
        }
      } else {
        await withTimeout(
          api.pty.write(runtime.paneId, writePlan.writeText, traceContext || null),
          WRITE_TIMEOUT_MS,
          'pane-host write'
        );
      }

      const baseMinDelay = Math.max(
        100,
        Number.isFinite(MIN_ENTER_DELAY_MS) ? MIN_ENTER_DELAY_MS : DEFAULT_MIN_ENTER_DELAY_MS
      );
      const hmSendExtraDelayMs = hmSendTrace && isLongPayload
        ? Math.min(600, Math.ceil(Math.max(0, payloadBytes - LONG_PAYLOAD_BYTES) / 64))
        : 0;
      const minDelay = baseMinDelay + hmSendExtraDelayMs;
      await sleep(minDelay);

      const outputBaseline = runtime.ptyOutputTick;
      const enterResult = await withTimeout(
        sendPaneHostAction('dispatch-enter', runtime.paneId),
        ENTER_TIMEOUT_MS,
        'pane-host dispatch-enter'
      );
      if (!enterResult || !enterResult.success) {
        console.error(
          `[PaneHost] pane-host dispatch-enter FAILED for pane ${runtime.paneId}:`,
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
      const outputObserved = await waitForPtyOutputAfter(runtime, outputBaseline, postEnterVerifyTimeoutMs);
      const deliveryResult = resolvePostEnterDeliveryResult({
        outputObserved,
        enterSucceeded: Boolean(enterResult?.success),
      });

      if (deliveryId) {
        if (deliveryResult.ack) {
          reportDeliveryAck(runtime.paneId, deliveryId);
        } else {
          reportDeliveryOutcome(runtime.paneId, {
            deliveryId,
            paneId: runtime.paneId,
            ...deliveryResult.outcome,
          });
        }
      }

      if (!outputObserved && hmSendTrace && enterResult?.success) {
        console.warn(
          `[PaneHost] hm-send trace remained unverified for pane ${runtime.paneId} without immediate PTY output `
          + `(${postEnterVerifyTimeoutMs}ms window)`
        );
      } else if (!outputObserved && !enterResult?.success) {
        console.warn(
          `[PaneHost] Delivery failed for pane ${runtime.paneId} because dispatch-enter was not accepted`
        );
      } else if (!outputObserved) {
        console.warn(
          `[PaneHost] Delivery remained unverified for pane ${runtime.paneId} after Enter `
          + `(${postEnterVerifyTimeoutMs}ms without PTY output)`
        );
      }
    } catch (err) {
      console.error(`[PaneHost] injectMessage FAILED for pane ${runtime.paneId}:`, err.message);
      if (deliveryId) {
        reportDeliveryOutcome(runtime.paneId, {
          deliveryId,
          paneId: runtime.paneId,
          accepted: false,
          verified: false,
          status: 'delivery_failed',
          reason: err.message,
        });
      }
    }
  }

  function createPaneTerminal(paneId) {
    const section = document.createElement('div');
    section.className = 'paneHostTerminal';
    section.dataset.paneId = paneId;
    terminalRoot.appendChild(section);

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

    const fitAddon = new FitAddonCtor();
    terminal.loadAddon(fitAddon);
    terminal.open(section);
    fitAddon.fit();

    return createPaneRuntime(paneId, terminal, fitAddon);
  }

  function handlePaneHostEvent(payload = {}) {
    const source = String(payload?.source || '').trim().toLowerCase();
    if (source !== 'pane-host') return;
    const paneId = String(payload?.paneId || '').trim();
    if (!paneId) return;
    const runtime = paneRuntimeById.get(paneId);
    if (!runtime) return;
    const type = String(payload?.type || '').trim().toLowerCase();

    if (type === 'prime-scrollback') {
      if (runtime.injectedScrollback) return;
      const scrollback = String(payload?.scrollback || '');
      if (!scrollback) return;
      runtime.injectedScrollback = true;
      runtime.terminal.write(scrollback);
      return;
    }

    if (type === 'inject-message') {
      const prepared = prepareInjectedPayload(runtime, payload);
      if (!prepared.ready) return;
      runtime.injectChain = runtime.injectChain
        .then(() => injectMessage(runtime, prepared.payload))
        .catch((err) => {
          console.error(`[PaneHost] Inject chain error for pane ${runtime.paneId}:`, err?.message || err);
        });
    }
  }

  for (const paneId of paneIds) {
    const runtime = createPaneTerminal(paneId);
    paneRuntimeById.set(paneId, runtime);

    runtime.disposeDataListener = api.pty.onData(paneId, (data) => {
      runtime.ptyOutputTick += 1;
      runtime.lastPtyOutputAtMs = Date.now();
      resolveOutputWaiters(runtime);
      runtime.terminal.write(String(data || ''));
    });

    runtime.disposeExitListener = api.pty.onExit(paneId, (code) => {
      const exitCode = code ?? '?';
      runtime.terminal.write(`\r\n[Process exited with code ${exitCode}]\r\n`);
    });
  }

  window.addEventListener('resize', () => {
    for (const runtime of paneRuntimeById.values()) {
      try {
        runtime.fitAddon.fit();
      } catch {
        // Best-effort only.
      }
    }
  });

  api.pty.onKernelBridgeEvent((payload = {}) => {
    handlePaneHostEvent(payload);
  });

  window.addEventListener('beforeunload', () => {
    for (const runtime of paneRuntimeById.values()) {
      if (typeof runtime.disposeDataListener === 'function') runtime.disposeDataListener();
      if (typeof runtime.disposeExitListener === 'function') runtime.disposeExitListener();
    }
  });

  for (const paneId of paneIds) {
    try {
      api.paneHost.ready({ paneId });
    } catch (err) {
      console.error(`[PaneHost] Failed to send ready for pane ${paneId}:`, err?.message || err);
    }
  }
  })();
}
