/**
 * Terminal management module
 * Handles xterm instances, PTY connections, and terminal operations
 */

const { Terminal } = require('xterm');
const { FitAddon } = require('xterm-addon-fit');
const { WebLinksAddon } = require('xterm-addon-web-links');

// Pane configuration
const PANE_IDS = ['1', '2', '3', '4'];

// Track if we reconnected to existing terminals
let reconnectedToExisting = false;

// Terminal instances
const terminals = new Map();
const fitAddons = new Map();
let focusedPane = '1';

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

// Initialize all terminals
async function initTerminals() {
  for (const paneId of PANE_IDS) {
    await initTerminal(paneId);
  }
  updateConnectionStatus('All terminals ready');
  focusPane('1');
}

// Setup copy/paste handlers
function setupCopyPaste(container, terminal, paneId, statusMsg) {
  let lastSelection = '';
  terminal.onSelectionChange(() => {
    const sel = terminal.getSelection();
    if (sel) lastSelection = sel;
  });

  container.addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    e.stopPropagation();

    if (lastSelection) {
      await navigator.clipboard.writeText(lastSelection);
      updatePaneStatus(paneId, 'Copied!');
      setTimeout(() => updatePaneStatus(paneId, statusMsg), 1000);
      lastSelection = '';
    } else {
      try {
        const text = await navigator.clipboard.readText();
        if (text) {
          window.hivemind.pty.write(paneId, text);
          updatePaneStatus(paneId, 'Pasted!');
          setTimeout(() => updatePaneStatus(paneId, statusMsg), 1000);
        }
      } catch (err) {
        console.error('Paste failed:', err);
      }
    }
  });

  container.addEventListener('keydown', async (e) => {
    if (e.ctrlKey && e.key === 'v') {
      e.preventDefault();
      try {
        const text = await navigator.clipboard.readText();
        if (text) {
          window.hivemind.pty.write(paneId, text);
        }
      } catch (err) {
        console.error('Paste failed:', err);
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
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(webLinksAddon);

  terminal.open(container);
  fitAddon.fit();

  setupCopyPaste(container, terminal, paneId, 'Connected');

  terminals.set(paneId, terminal);
  fitAddons.set(paneId, fitAddon);

  try {
    await window.hivemind.pty.create(paneId, process.cwd());
    updatePaneStatus(paneId, 'Connected');

    terminal.onData((data) => {
      window.hivemind.pty.write(paneId, data);
    });

    window.hivemind.pty.onData(paneId, (data) => {
      terminal.write(data);
    });

    window.hivemind.pty.onExit(paneId, (code) => {
      updatePaneStatus(paneId, `Exited (${code})`);
      terminal.write(`\r\n[Process exited with code ${code}]\r\n`);
    });

  } catch (err) {
    console.error(`Failed to create PTY for pane ${paneId}:`, err);
    updatePaneStatus(paneId, 'Error');
    terminal.write(`\r\n[Error: ${err.message}]\r\n`);
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
    console.log(`[Terminal ${paneId}] Already attached, skipping`);
    return;
  }

  const terminal = new Terminal(TERMINAL_OPTIONS);
  const fitAddon = new FitAddon();
  const webLinksAddon = new WebLinksAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(webLinksAddon);

  terminal.open(container);
  fitAddon.fit();

  setupCopyPaste(container, terminal, paneId, 'Reconnected');

  terminals.set(paneId, terminal);
  fitAddons.set(paneId, fitAddon);

  // U1: Restore scrollback buffer if available
  if (scrollback && scrollback.length > 0) {
    terminal.write(scrollback);
  }

  terminal.onData((data) => {
    window.hivemind.pty.write(paneId, data);
  });

  window.hivemind.pty.onData(paneId, (data) => {
    terminal.write(data);
  });

  window.hivemind.pty.onExit(paneId, (code) => {
    updatePaneStatus(paneId, `Exited (${code})`);
    terminal.write(`\r\n[Process exited with code ${code}]\r\n`);
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

// Send message to a specific pane
function sendToPane(paneId, message) {
  const text = message.replace(/\r$/, '');
  window.hivemind.pty.write(String(paneId), text);
  setTimeout(() => {
    window.hivemind.pty.write(String(paneId), '\r');
  }, 50);
}

// Broadcast message to all panes
function broadcast(message) {
  const broadcastMessage = `[BROADCAST TO ALL AGENTS] ${message}`;
  for (const paneId of PANE_IDS) {
    sendToPane(paneId, broadcastMessage);
  }
  updateConnectionStatus('Broadcast sent to all panes');
}

// Spawn claude in a pane
async function spawnClaude(paneId) {
  const terminal = terminals.get(paneId);
  if (terminal) {
    updatePaneStatus(paneId, 'Starting Claude...');
    const result = await window.hivemind.claude.spawn(paneId);
    if (result.success && result.command) {
      terminal.paste(result.command + '\r');
    }
    updatePaneStatus(paneId, 'Claude running');
  }
}

// Spawn claude in all panes
async function spawnAllClaude() {
  updateConnectionStatus('Starting Claude in all panes...');
  for (const paneId of PANE_IDS) {
    await spawnClaude(paneId);
  }
  updateConnectionStatus('All Claude instances running');
}

// Kill all terminals
async function killAllTerminals() {
  updateConnectionStatus('Killing all terminals...');
  for (const paneId of PANE_IDS) {
    try {
      await window.hivemind.pty.kill(paneId);
      updatePaneStatus(paneId, 'Killed');
    } catch (err) {
      console.error(`Failed to kill pane ${paneId}:`, err);
    }
  }
  updateConnectionStatus('All terminals killed');
}

// Nudge a stuck pane - sends Escape then Enter to unstick Claude Code
function nudgePane(paneId) {
  // Send Escape (0x1B) to cancel any pending state
  window.hivemind.pty.write(String(paneId), '\x1b');
  // Brief delay then send Enter to prompt for new input
  setTimeout(() => {
    window.hivemind.pty.write(String(paneId), '\r');
  }, 100);
  updatePaneStatus(paneId, 'Nudged');
  setTimeout(() => updatePaneStatus(paneId, 'Running'), 1000);
}

// Nudge all panes to unstick any churning agents
function nudgeAllPanes() {
  updateConnectionStatus('Nudging all agents...');
  for (const paneId of PANE_IDS) {
    nudgePane(paneId);
  }
  setTimeout(() => {
    updateConnectionStatus('All agents nudged');
  }, 200);
}

// Fresh start - kill all and spawn new sessions without context
async function freshStartAll() {
  const confirmed = confirm(
    'Fresh Start will:\n\n' +
    '• Kill all 4 terminals\n' +
    '• Start new Claude sessions with NO previous context\n\n' +
    'All current conversations will be lost.\n\n' +
    'Continue?'
  );

  if (!confirmed) {
    updateConnectionStatus('Fresh start cancelled');
    return;
  }

  updateConnectionStatus('Fresh start: killing all terminals...');

  // Kill all terminals
  for (const paneId of PANE_IDS) {
    try {
      await window.hivemind.pty.kill(paneId);
    } catch (err) {
      console.error(`Failed to kill pane ${paneId}:`, err);
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
      console.error(`Failed to create terminal ${paneId}:`, err);
    }
  }

  // Wait for terminals to be ready
  await new Promise(resolve => setTimeout(resolve, 300));

  // Spawn Claude with fresh session flag
  for (const paneId of PANE_IDS) {
    const terminal = terminals.get(paneId);
    if (terminal) {
      // Start Claude with explicit instruction to not resume
      sendToPane(paneId, 'claude --dangerously-skip-permissions');
    }
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
      return;
    }

    const syncMessage = `[HIVEMIND SYNC] Please read and acknowledge the following shared context:

---
${result.content}
---

Acknowledge receipt and summarize the key points.\r`;

    broadcast(syncMessage);
    updateConnectionStatus('Shared context synced to all panes');

  } catch (err) {
    updateConnectionStatus(`Sync error: ${err.message}`);
  }
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
      console.error(`Error resizing pane ${paneId}:`, err);
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

module.exports = {
  PANE_IDS,
  terminals,
  fitAddons,
  setStatusCallbacks,
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
  freshStartAll,
  syncSharedContext,
  handleResize,
  getTerminal,
  getFocusedPane,
  setReconnectedToExisting,
  getReconnectedToExisting,
  updatePaneStatus,
  updateConnectionStatus,
};
