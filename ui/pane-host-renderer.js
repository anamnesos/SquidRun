const { ipcRenderer } = require('electron');
const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');

function readPaneIdFromQuery() {
  try {
    const params = new URLSearchParams(window.location.search || '');
    const paneId = params.get('paneId');
    return paneId ? String(paneId) : '1';
  } catch {
    return '1';
  }
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

const paneId = readPaneIdFromQuery();
const IS_DARWIN = process.platform === 'darwin';
const DEFAULT_POST_ENTER_VERIFY_TIMEOUT_MS = IS_DARWIN ? 3000 : 4000;
const DEFAULT_SUBMIT_DEFER_ACTIVE_OUTPUT_WINDOW_MS = IS_DARWIN ? 250 : 350;
const DEFAULT_SUBMIT_DEFER_MAX_WAIT_MS = IS_DARWIN ? 1200 : 2000;
const DEFAULT_SUBMIT_DEFER_MAX_WAIT_LONG_MS = IS_DARWIN ? 3000 : 5000;
const DEFAULT_SUBMIT_DEFER_POLL_MS = IS_DARWIN ? 50 : 100;
const DEFAULT_LONG_PAYLOAD_BYTES = IS_DARWIN ? 2048 : 1024;
const DEFAULT_HM_SEND_POST_ENTER_VERIFY_TIMEOUT_MS = IS_DARWIN ? 700 : 800;
const DEFAULT_MIN_ENTER_DELAY_MS = IS_DARWIN ? 150 : 500;
const DEFAULT_CHUNK_THRESHOLD_BYTES = IS_DARWIN ? 4096 : 2048;
const DEFAULT_CHUNK_SIZE_BYTES = IS_DARWIN ? 4096 : 2048;
const TERMINAL_FONT_FAMILY = IS_DARWIN
  ? "'SF Mono', 'Menlo', 'Monaco', 'Courier New', monospace"
  : "'Consolas', 'Monaco', 'Courier New', monospace";
let injectedScrollback = false;
let injectChain = Promise.resolve();
let ptyOutputTick = 0;
let lastPtyOutputAtMs = 0;
const pendingOutputWaiters = new Set();
const POST_ENTER_VERIFY_TIMEOUT_MS = Number.parseInt(
  process.env.HIVEMIND_PANE_HOST_VERIFY_TIMEOUT_MS || String(DEFAULT_POST_ENTER_VERIFY_TIMEOUT_MS),
  10
);
const SUBMIT_DEFER_ACTIVE_OUTPUT_WINDOW_MS = Number.parseInt(
  process.env.HIVEMIND_PANE_HOST_ACTIVE_OUTPUT_WINDOW_MS || String(DEFAULT_SUBMIT_DEFER_ACTIVE_OUTPUT_WINDOW_MS),
  10
);
const SUBMIT_DEFER_MAX_WAIT_MS = Number.parseInt(
  process.env.HIVEMIND_PANE_HOST_SUBMIT_DEFER_MAX_WAIT_MS || String(DEFAULT_SUBMIT_DEFER_MAX_WAIT_MS),
  10
);
const SUBMIT_DEFER_MAX_WAIT_LONG_MS = Number.parseInt(
  process.env.HIVEMIND_PANE_HOST_SUBMIT_DEFER_MAX_WAIT_LONG_MS || String(DEFAULT_SUBMIT_DEFER_MAX_WAIT_LONG_MS),
  10
);
const SUBMIT_DEFER_POLL_MS = Number.parseInt(
  process.env.HIVEMIND_PANE_HOST_SUBMIT_DEFER_POLL_MS || String(DEFAULT_SUBMIT_DEFER_POLL_MS),
  10
);
const LONG_PAYLOAD_BYTES = Number.parseInt(
  process.env.HIVEMIND_PANE_HOST_LONG_PAYLOAD_BYTES || String(DEFAULT_LONG_PAYLOAD_BYTES),
  10
);
const HM_SEND_POST_ENTER_VERIFY_TIMEOUT_MS = Number.parseInt(
  process.env.HIVEMIND_PANE_HOST_HM_SEND_VERIFY_TIMEOUT_MS
    || String(DEFAULT_HM_SEND_POST_ENTER_VERIFY_TIMEOUT_MS),
  10
);
const MIN_ENTER_DELAY_MS = Number.parseInt(
  process.env.HIVEMIND_PANE_HOST_MIN_ENTER_DELAY_MS || String(DEFAULT_MIN_ENTER_DELAY_MS),
  10
);
const CHUNK_THRESHOLD_BYTES = Number.parseInt(
  process.env.HIVEMIND_PANE_HOST_CHUNK_THRESHOLD_BYTES || String(DEFAULT_CHUNK_THRESHOLD_BYTES),
  10
);
const CHUNK_SIZE_BYTES = Number.parseInt(
  process.env.HIVEMIND_PANE_HOST_CHUNK_SIZE_BYTES || String(DEFAULT_CHUNK_SIZE_BYTES),
  10
);
const WRITE_TIMEOUT_MS = Number.parseInt(
  process.env.HIVEMIND_PANE_HOST_WRITE_TIMEOUT_MS || '8000',
  10
);
const ENTER_TIMEOUT_MS = Number.parseInt(
  process.env.HIVEMIND_PANE_HOST_ENTER_TIMEOUT_MS || '5000',
  10
);

const terminal = new Terminal({
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

const fitAddon = new FitAddon();
terminal.loadAddon(fitAddon);
terminal.open(document.getElementById('paneHostTerminal'));
fitAddon.fit();
terminal.focus();

window.addEventListener('resize', () => {
  try {
    fitAddon.fit();
  } catch {
    // Best-effort only.
  }
});

// Hidden host must NOT echo xterm responses back to PTY.
// Both visible + hidden xterms receive the same escape sequences (e.g. DSR \e[6n).
// If both respond, the PTY gets doubled responses → malformed/doubled output.
// Injection uses pty.write() and dispatch-enter directly — onData is not needed here.

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

async function injectMessage(payload = {}) {
  const text = stripInternalRoutingWrappers(String(payload.message || ''));
  const deliveryId = payload.deliveryId || null;
  const traceContext = payload.traceContext || null;
  const hmSendTrace = isHmSendTraceContext(traceContext);

  try {
    // Use chunked write for large payloads to prevent PTY pipe truncation.
    const chunkThreshold = Number.isFinite(CHUNK_THRESHOLD_BYTES) && CHUNK_THRESHOLD_BYTES > 0
      ? CHUNK_THRESHOLD_BYTES
      : DEFAULT_CHUNK_THRESHOLD_BYTES;
    const chunkSize = Number.isFinite(CHUNK_SIZE_BYTES) && CHUNK_SIZE_BYTES > 0
      ? CHUNK_SIZE_BYTES
      : DEFAULT_CHUNK_SIZE_BYTES;
    if (text.length > chunkThreshold && window.squidrun.pty.writeChunked) {
      const chunkedResult = await withTimeout(
        window.squidrun.pty.writeChunked(paneId, text, { chunkSize }, traceContext || null),
        WRITE_TIMEOUT_MS,
        'pane-host writeChunked'
      );
      if (chunkedResult && chunkedResult.success === false) {
        throw new Error(chunkedResult.error || 'writeChunked returned failure');
      }
    } else {
      await withTimeout(
        window.squidrun.pty.write(paneId, text, traceContext || null),
        WRITE_TIMEOUT_MS,
        'pane-host write'
      );
    }
    // Minimum wait for the PTY to process pasted text before sending Enter.
    // Without this, Enter fires before text reaches the CLI (ConPTY round-trip latency).
    const minDelay = Math.max(
      100,
      Number.isFinite(MIN_ENTER_DELAY_MS) ? MIN_ENTER_DELAY_MS : DEFAULT_MIN_ENTER_DELAY_MS
    );
    await sleep(minDelay);
    // Then wait for output activity to settle.
    const payloadBytes = typeof Buffer !== 'undefined'
      ? Buffer.byteLength(text, 'utf8')
      : text.length;
    const isLongPayload = payloadBytes >= Math.max(
      1,
      Number.isFinite(LONG_PAYLOAD_BYTES) ? LONG_PAYLOAD_BYTES : DEFAULT_LONG_PAYLOAD_BYTES
    );
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
    // Submit via dedicated main-process Enter dispatch — bypasses pty-write IPC
    // to use the same direct daemonClient.write('\r') path as the working Enter button.
    const outputBaseline = ptyOutputTick;
    const enterResult = await withTimeout(
      ipcRenderer.invoke('pane-host-dispatch-enter', paneId),
      ENTER_TIMEOUT_MS,
      'pane-host dispatch-enter'
    );
    if (!enterResult || !enterResult.success) {
      console.error(
        `[PaneHost] pane-host-dispatch-enter FAILED for pane ${paneId}:`,
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
        ipcRenderer.send('trigger-delivery-ack', { deliveryId, paneId });
      } else {
        ipcRenderer.send('trigger-delivery-outcome', {
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
      ipcRenderer.send('trigger-delivery-outcome', {
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

ipcRenderer.on('pane-host:pty-data', (_event, payload = {}) => {
  if (String(payload.paneId || '') !== paneId) return;
  ptyOutputTick += 1;
  lastPtyOutputAtMs = Date.now();
  resolveOutputWaiters();
  terminal.write(String(payload.data || ''));
});

ipcRenderer.on('pane-host:pty-exit', (_event, payload = {}) => {
  if (String(payload.paneId || '') !== paneId) return;
  const code = payload.code ?? '?';
  terminal.write(`\r\n[Process exited with code ${code}]\r\n`);
});

ipcRenderer.on('pane-host:prime-scrollback', (_event, payload = {}) => {
  if (String(payload.paneId || '') !== paneId) return;
  if (injectedScrollback) return;
  const scrollback = String(payload.scrollback || '');
  if (!scrollback) return;
  injectedScrollback = true;
  terminal.write(scrollback);
});

ipcRenderer.on('pane-host:inject-message', (_event, payload = {}) => {
  if (String(payload.paneId || '') !== paneId) return;
  injectChain = injectChain
    .then(() => injectMessage(payload))
    .catch((err) => {
      console.error(`[PaneHost] Inject chain error for pane ${paneId}:`, err?.message || err);
    });
});

// Notify main process that the host is ready to receive payloads.
ipcRenderer.send('pane-host-ready', { paneId });
