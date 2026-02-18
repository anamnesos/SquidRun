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

const paneId = readPaneIdFromQuery();
let injectedScrollback = false;
let injectChain = Promise.resolve();
let paneCommand = '';
let codexIdentityInjected = false;

const terminal = new Terminal({
  theme: {
    background: '#0a0a0f',
    foreground: '#e8eaf0',
    cursor: '#00f0ff',
    cursorAccent: '#0a0a0f',
    selection: 'rgba(0, 240, 255, 0.25)',
  },
  fontFamily: "'Consolas', 'Monaco', 'Courier New', monospace",
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
    window.hivemind?.pty?.resize?.(paneId, terminal.cols, terminal.rows);
  } catch {
    // Best-effort only.
  }
});

terminal.onData((data) => {
  window.hivemind.pty.write(paneId, data).catch(() => {
    // No-op: daemon write failures are surfaced in main app logs.
  });
});

ipcRenderer.invoke('get-settings')
  .then((settings) => {
    paneCommand = String(settings?.paneCommands?.[paneId] || '').toLowerCase();
  })
  .catch(() => {});

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

async function injectMessage(payload = {}) {
  let text = stripInternalRoutingWrappers(String(payload.message || ''));
  const deliveryId = payload.deliveryId || null;
  const traceContext = payload.traceContext || null;
  if (paneCommand.includes('codex') && !codexIdentityInjected) {
    const roleMap = { '1': 'Architect', '2': 'Builder', '5': 'Oracle' };
    const role = roleMap[paneId] || `Pane ${paneId}`;
    const d = new Date();
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    text = `# HIVEMIND SESSION: ${role} - Started ${stamp}\n${text}`;
    codexIdentityInjected = true;
  }

  try {
    // Use chunked write for large payloads to prevent PTY pipe truncation.
    const CHUNK_THRESHOLD = 2048;
    if (text.length > CHUNK_THRESHOLD && window.hivemind.pty.writeChunked) {
      await window.hivemind.pty.writeChunked(paneId, text, { chunkSize: 2048 }, traceContext || null);
    } else {
      await window.hivemind.pty.write(paneId, text, traceContext || null);
    }
    // Allow CLI to consume pasted text before submitting Enter.
    // Hidden windows fix focus contention; this delay handles PTY pipe buffering.
    const enterDelayMs = Math.max(80, Math.min(300, Math.ceil(text.length / 20)));
    await new Promise(resolve => setTimeout(resolve, enterDelayMs));
    // Submit via direct PTY Enter.
    await window.hivemind.pty.write(paneId, '\r', traceContext || null);

    if (deliveryId) {
      ipcRenderer.send('trigger-delivery-ack', { deliveryId, paneId });
    }
  } catch (err) {
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
  terminal.write(String(payload.data || ''));
});

ipcRenderer.on('pane-host:pty-exit', (_event, payload = {}) => {
  if (String(payload.paneId || '') !== paneId) return;
  const code = payload.code ?? '?';
  terminal.write(`\r\n[Process exited with code ${code}]\r\n`);
  codexIdentityInjected = false;
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
    .catch(() => {});
});

// Notify main process that the host is ready to receive payloads.
ipcRenderer.send('pane-host-ready', { paneId });
