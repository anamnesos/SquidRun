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

// FX4-v2: Cross-pane Enter debounce tracking
// Prevents ghost text submission when Enter hits multiple panes within 100ms
const lastEnterTime = {};

// FX4-v3: Track actual user typing per pane
// Only allow Enter if user typed something in last 2 seconds
const lastTypedTime = {};

// V16.2: Idle detection to prevent stuck animation
// Track last output time per pane - updated on every pty.onData
const lastOutputTime = {};

// V16.2: Message queue for when pane is busy
// Format: { paneId: [{ message, timestamp }, ...] }
const messageQueue = {};

// V16.2: Idle detection constants
// V16.4: Bumped from 500ms to 2000ms - Claude may need more time after output stops
const IDLE_THRESHOLD_MS = 2000;  // No output for 2s = idle
const MAX_QUEUE_TIME_MS = 10000; // Force inject after 10 seconds
const QUEUE_RETRY_MS = 200;      // Check queue every 200ms
const BROADCAST_STAGGER_MS = 100; // Delay between panes in broadcast

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

// V16.2: Check if a pane is idle (no output for IDLE_THRESHOLD_MS)
function isIdle(paneId) {
  const lastOutput = lastOutputTime[paneId] || 0;
  return (Date.now() - lastOutput) >= IDLE_THRESHOLD_MS;
}

// V16.2: Process queued messages for a pane
function processQueue(paneId) {
  const queue = messageQueue[paneId];
  if (!queue || queue.length === 0) return;

  const now = Date.now();
  const item = queue[0];

  // Check if we should send (idle OR timeout exceeded)
  const waitedTooLong = (now - item.timestamp) >= MAX_QUEUE_TIME_MS;

  if (isIdle(paneId) || waitedTooLong) {
    // Remove from queue and send
    queue.shift();
    if (waitedTooLong) {
      console.log(`[Terminal ${paneId}] Force-injecting after ${MAX_QUEUE_TIME_MS}ms wait`);
    }
    doSendToPane(paneId, item.message);

    // Process next item if any
    if (queue.length > 0) {
      setTimeout(() => processQueue(paneId), QUEUE_RETRY_MS);
    }
  } else {
    // Still busy, retry later
    setTimeout(() => processQueue(paneId), QUEUE_RETRY_MS);
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

  // CRITICAL FIX: Block keyboard input when user is typing in a UI input/textarea
  // BUT allow xterm's own internal textarea (xterm-helper-textarea) to work normally
  terminal.attachCustomKeyEventHandler((event) => {
    // FX4-v3: Track actual user typing (single chars, no modifiers)
    if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
      lastTypedTime[paneId] = Date.now();
    }

    // V16.10: Allow synthetic Enter if it's from our programmatic send
    // Check for our marker on the event
    if (event.key === 'Enter' && !event.isTrusted) {
      if (event._hivemindBypass) {
        // Our programmatic send, allow it
        console.log(`[Terminal ${paneId}] Allowing programmatic Enter (hivemind bypass)`);
        return true;
      }
      console.log(`[Terminal ${paneId}] Blocked synthetic Enter (isTrusted=false)`);
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

    terminal.onData((data) => {
      window.hivemind.pty.write(paneId, data);
    });

    window.hivemind.pty.onData(paneId, (data) => {
      terminal.write(data);
      // V16.2: Track output time for idle detection
      lastOutputTime[paneId] = Date.now();
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

  // CRITICAL FIX: Block keyboard input when user is typing in a UI input/textarea
  // BUT allow xterm's own internal textarea (xterm-helper-textarea) to work normally
  terminal.attachCustomKeyEventHandler((event) => {
    // FX4-v3: Track actual user typing (single chars, no modifiers)
    if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
      lastTypedTime[paneId] = Date.now();
    }

    // V16.10: Allow synthetic Enter if it's from our programmatic send
    if (event.key === 'Enter' && !event.isTrusted) {
      if (event._hivemindBypass) {
        console.log(`[Terminal ${paneId}] Allowing programmatic Enter (hivemind bypass)`);
        return true;
      }
      console.log(`[Terminal ${paneId}] Blocked synthetic Enter (isTrusted=false)`);
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

  // U1: Restore scrollback buffer if available
  if (scrollback && scrollback.length > 0) {
    terminal.write(scrollback);
  }

  terminal.onData((data) => {
    window.hivemind.pty.write(paneId, data);
  });

  window.hivemind.pty.onData(paneId, (data) => {
    terminal.write(data);
    // V16.2: Track output time for idle detection
    lastOutputTime[paneId] = Date.now();
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

// V16.2: Actually send message to pane (internal - use sendToPane for idle detection)
// V16.10: Trigger actual DOM keyboard events on xterm textarea with bypass marker
// V16.11: Added diagnostic logging for pane 1 & 4 focus issues
function doSendToPane(paneId, message) {
  const hasTrailingEnter = message.endsWith('\r');
  const text = message.replace(/\r$/, '');
  const id = String(paneId);

  // Find xterm's hidden textarea for this pane
  const paneEl = document.querySelector(`.pane[data-pane-id="${id}"]`);
  const textarea = paneEl?.querySelector('.xterm-helper-textarea');

  // V16.11: Diagnostic logging
  console.log(`[doSendToPane ${id}] paneEl found:`, !!paneEl);
  console.log(`[doSendToPane ${id}] textarea found:`, !!textarea);

  if (textarea) {
    // Focus the textarea
    textarea.focus();

    // V16.11: Check focus state
    const activeAfterFocus = document.activeElement;
    const focusSucceeded = activeAfterFocus === textarea;
    console.log(`[doSendToPane ${id}] focus succeeded:`, focusSucceeded);
    if (!focusSucceeded) {
      console.warn(`[doSendToPane ${id}] Focus went to:`, activeAfterFocus?.className || activeAfterFocus?.tagName);
    }

    // Send text via PTY (this part works)
    window.hivemind.pty.write(id, text);

    if (hasTrailingEnter) {
      // Trigger actual keyboard Enter event after small delay
      setTimeout(() => {
        // V16.11: Re-check focus before dispatching
        const stillFocused = document.activeElement === textarea;
        console.log(`[doSendToPane ${id}] still focused before Enter:`, stillFocused);

        if (!stillFocused) {
          // Try to re-focus
          textarea.focus();
          console.log(`[doSendToPane ${id}] re-focused, now:`, document.activeElement === textarea);
        }

        const enterEvent = new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true
        });
        // Add our bypass marker so the key handler allows it
        enterEvent._hivemindBypass = true;
        textarea.dispatchEvent(enterEvent);
        console.log(`[doSendToPane ${id}] Enter keydown dispatched`);

        // Also keypress with bypass
        const keypressEvent = new KeyboardEvent('keypress', {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true
        });
        keypressEvent._hivemindBypass = true;
        textarea.dispatchEvent(keypressEvent);

        // And keyup
        const keyupEvent = new KeyboardEvent('keyup', {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true
        });
        keyupEvent._hivemindBypass = true;
        textarea.dispatchEvent(keyupEvent);
      }, 50);
    }
  } else {
    // Fallback to direct PTY write
    console.warn(`[doSendToPane ${id}] No textarea found, using PTY fallback`);
    window.hivemind.pty.write(id, hasTrailingEnter ? text + '\r' : text);
  }

  lastTypedTime[paneId] = Date.now();
}

// Send message to a specific pane
// V16.2: Idle detection - queue message if pane is busy (Claude thinking)
function sendToPane(paneId, message) {
  const id = String(paneId);

  // If pane is idle, send immediately
  if (isIdle(id)) {
    doSendToPane(id, message);
    return;
  }

  // Pane is busy - queue the message
  console.log(`[Terminal ${id}] Pane busy, queueing message`);

  if (!messageQueue[id]) {
    messageQueue[id] = [];
  }

  messageQueue[id].push({
    message: message,
    timestamp: Date.now()
  });

  // Start processing queue if this is the first item
  if (messageQueue[id].length === 1) {
    setTimeout(() => processQueue(id), QUEUE_RETRY_MS);
  }
}

// Broadcast message to all panes
// V16.4: Added stagger delay between panes to avoid overwhelming all at once
function broadcast(message) {
  const broadcastMessage = `[BROADCAST TO ALL AGENTS] ${message}`;
  PANE_IDS.forEach((paneId, index) => {
    setTimeout(() => {
      sendToPane(paneId, broadcastMessage);
    }, index * BROADCAST_STAGGER_MS);
  });
  updateConnectionStatus('Broadcast sent to all panes');
}

// Spawn claude in a pane
async function spawnClaude(paneId) {
  const terminal = terminals.get(paneId);
  if (terminal) {
    updatePaneStatus(paneId, 'Starting Claude...');
    const result = await window.hivemind.claude.spawn(paneId);
    if (result.success && result.command) {
      // Use pty.write directly instead of terminal.paste for reliability
      // terminal.paste() can fail if terminal isn't fully ready
      window.hivemind.pty.write(String(paneId), result.command);
      // FX4-v5: Mark as typed so Enter isn't blocked
      lastTypedTime[paneId] = Date.now();
      // Small delay before sending Enter
      await new Promise(resolve => setTimeout(resolve, 100));
      window.hivemind.pty.write(String(paneId), '\r');
    }
    updatePaneStatus(paneId, 'Claude running');
  }
}

// Spawn claude in all panes
async function spawnAllClaude() {
  updateConnectionStatus('Starting Claude in all panes...');
  for (const paneId of PANE_IDS) {
    await spawnClaude(paneId);
    // Small delay between panes to prevent race conditions
    await new Promise(resolve => setTimeout(resolve, 200));
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

// Nudge a stuck pane - sends Enter to unstick Claude Code
// V16 FIX: Removed ESC sequences - they were interrupting active agents!
function nudgePane(paneId) {
  // FX4-v5: Mark as typed so our own Enter isn't blocked
  lastTypedTime[paneId] = Date.now();
  // Send Enter to prompt for new input
  window.hivemind.pty.write(String(paneId), '\r');
  updatePaneStatus(paneId, 'Nudged');
  setTimeout(() => updatePaneStatus(paneId, 'Running'), 1000);
}

// V16.10: Send ESC keyboard event to unstick a stuck agent
// This is triggered by writing "(UNSTICK)" to an agent's trigger file
// Unlike PTY ESC (\x1b), keyboard ESC safely interrupts thinking animation
function sendUnstick(paneId) {
  const id = String(paneId);
  const paneEl = document.querySelector(`.pane[data-pane-id="${id}"]`);
  const textarea = paneEl?.querySelector('.xterm-helper-textarea');

  if (textarea) {
    textarea.focus();

    // Dispatch ESC keydown event with bypass marker
    const escEvent = new KeyboardEvent('keydown', {
      key: 'Escape',
      code: 'Escape',
      keyCode: 27,
      which: 27,
      bubbles: true,
      cancelable: true
    });
    escEvent._hivemindBypass = true;
    textarea.dispatchEvent(escEvent);

    // Also keyup for completeness
    const escUpEvent = new KeyboardEvent('keyup', {
      key: 'Escape',
      code: 'Escape',
      keyCode: 27,
      which: 27,
      bubbles: true
    });
    escUpEvent._hivemindBypass = true;
    textarea.dispatchEvent(escUpEvent);

    console.log(`[Terminal ${id}] Sent ESC keyboard event to unstick agent`);
    updatePaneStatus(id, 'Unstick sent');
    setTimeout(() => updatePaneStatus(id, 'Running'), 1000);
  } else {
    console.warn(`[Terminal ${id}] Could not find xterm textarea for unstick`);
  }
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
  sendUnstick,    // V16.10: ESC keyboard event to unstick agents
  freshStartAll,
  syncSharedContext,
  handleResize,
  getTerminal,
  getFocusedPane,
  setReconnectedToExisting,
  getReconnectedToExisting,
  updatePaneStatus,
  updateConnectionStatus,
  lastEnterTime,  // FX4-v2: Exported for daemon coordination
  lastTypedTime,  // FX4-v3: Track typing for Enter blocking
  lastOutputTime, // V16.2: Track output for idle detection
  isIdle,         // V16.2: Check if pane is idle
  messageQueue,   // V16.2: Message queue for busy panes
};
