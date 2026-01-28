/**
 * Terminal management module
 * Handles xterm instances, PTY connections, and terminal operations
 */

const { Terminal } = require('xterm');
const { FitAddon } = require('xterm-addon-fit');
const { WebLinksAddon } = require('xterm-addon-web-links');

// Pane configuration
const PANE_IDS = ['1', '2', '3', '4', '5', '6'];

// CLI identity tracking (dynamic)
// Updated by renderer's pane-cli-identity handler (calls register/unregister)
const paneCliIdentity = new Map();

// ID-1: Pane roles for identity injection (makes /resume sessions identifiable)
const PANE_ROLES = {
  '1': 'Architect',
  '2': 'Orchestrator',
  '3': 'Implementer A',
  '4': 'Implementer B',
  '5': 'Investigator',
  '6': 'Reviewer',
};

// Track if we reconnected to existing terminals
let reconnectedToExisting = false;

// SDK Mode flag - when true, PTY spawn operations are blocked
let sdkModeActive = false;

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

// Codex exec mode: track identity injection per pane
const codexIdentityInjected = new Set();

// V16.2: Message queue for when pane is busy
// Format: { paneId: [{ message, timestamp }, ...] }
const messageQueue = {};

// BUG-4: Global UI focus tracker - survives staggered multi-pane sends.
// Updated by focusin listener on UI inputs; doSendToPane restores to this.
let lastUserUIFocus = null;

// Focus-steal fix: Track when user last typed in a UI input (not xterm).
// doSendToPane defers injection while user is actively typing.
let lastUserUIKeypressTime = 0;
const TYPING_GUARD_MS = 300; // Defer injection if user typed within this window

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

// BUG-4: Track when user focuses any UI input (not xterm textareas).
// Call once from renderer.js after DOMContentLoaded.
function initUIFocusTracker() {
  document.addEventListener('focusin', (e) => {
    const el = e.target;
    const tag = el?.tagName?.toUpperCase();
    const isUI = (tag === 'INPUT' || tag === 'TEXTAREA') &&
      !el.classList.contains('xterm-helper-textarea');
    if (isUI) {
      lastUserUIFocus = el;
    }
  });

  // Track user keystrokes in UI inputs for typing guard
  document.addEventListener('keydown', (e) => {
    const el = e.target;
    const tag = el?.tagName?.toUpperCase();
    const isUI = (tag === 'INPUT' || tag === 'TEXTAREA') &&
      !el.classList.contains('xterm-helper-textarea');
    if (isUI) {
      lastUserUIKeypressTime = Date.now();
    }
  });
}

// Returns true if user is actively typing in a UI input
function userIsTyping() {
  if (!lastUserUIFocus) return false;
  const el = document.activeElement;
  const tag = el?.tagName?.toUpperCase();
  const isUI = (tag === 'INPUT' || tag === 'TEXTAREA') &&
    !el.classList.contains('xterm-helper-textarea');
  if (!isUI) return false;
  return (Date.now() - lastUserUIKeypressTime) < TYPING_GUARD_MS;
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

function isCodexFromSettings(paneId) {
  try {
    const settings = window?.hivemind?.settings?.get?.();
    const paneCommands = settings?.paneCommands || {};
    const cmd = paneCommands[String(paneId)] || '';
    return typeof cmd === 'string' && cmd.toLowerCase().includes('codex');
  } catch {
    return false;
  }
}

function isCodexPane(paneId) {
  const entry = paneCliIdentity.get(String(paneId));
  if (entry?.key) {
    return entry.key.includes('codex');
  }
  return isCodexFromSettings(paneId);
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

  const role = PANE_ROLES[paneId] || `Pane ${paneId}`;
  const timestamp = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const identity = `# HIVEMIND SESSION: ${role} - Started ${timestamp}\n`;
  codexIdentityInjected.add(paneId);
  return identity + safeText;
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

  // Check if we should send (idle + not typing, OR timeout exceeded)
  const waitedTooLong = (now - item.timestamp) >= MAX_QUEUE_TIME_MS;

  if ((isIdle(paneId) && !userIsTyping()) || waitedTooLong) {
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
  // SDK Mode Guard: Don't initialize PTY terminals in SDK mode
  if (sdkModeActive) {
    console.log('[initTerminals] SDK mode active - skipping PTY terminal initialization');
    return;
  }

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
    // Check for our marker on the event or terminal-level bypass flag
    if (event.key === 'Enter' && !event.isTrusted) {
      if (event._hivemindBypass || terminal._hivemindBypass) {
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

    if (!isCodexPane(paneId)) {
      terminal.onData((data) => {
        window.hivemind.pty.write(paneId, data);
      });
    }

    window.hivemind.pty.onData(paneId, (data) => {
      terminal.write(data);
      // V16.2: Track output time for idle detection
      lastOutputTime[paneId] = Date.now();
      if (isCodexPane(paneId)) {
        if (data.includes('[Working...]')) {
          updatePaneStatus(paneId, 'Working');
        }
        if (data.includes('[Task complete]') || data.includes('[Codex exec exited')) {
          updatePaneStatus(paneId, 'Codex exec ready');
        }
      }
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
      if (event._hivemindBypass || terminal._hivemindBypass) {
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

  if (!isCodexPane(paneId)) {
    terminal.onData((data) => {
      window.hivemind.pty.write(paneId, data);
    });
  }

  window.hivemind.pty.onData(paneId, (data) => {
    terminal.write(data);
    // V16.2: Track output time for idle detection
    lastOutputTime[paneId] = Date.now();
    if (isCodexPane(paneId)) {
      if (data.includes('[Working...]')) {
        updatePaneStatus(paneId, 'Working');
      }
      if (data.includes('[Task complete]') || data.includes('[Codex exec exited')) {
        updatePaneStatus(paneId, 'Codex exec ready');
      }
    }
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
// FIX: Focus steal prevention - save/restore user's focus during message injection
function doSendToPane(paneId, message) {
  const hasTrailingEnter = message.endsWith('\r');
  const text = message.replace(/\r$/, '');
  const id = String(paneId);
  const isCodex = isCodexPane(id);

  // Codex exec mode: bypass PTY/textarea injection
  if (isCodex) {
    const restoreTarget = lastUserUIFocus;
    const prompt = buildCodexExecPrompt(id, text);
    // Echo user input to xterm so it's visible
    const terminal = terminals.get(id);
    if (terminal) {
      terminal.write(`\r\n\x1b[36m> ${text}\x1b[0m\r\n`);
    }
    window.hivemind.pty.codexExec(id, prompt);
    updatePaneStatus(id, 'Working');
    lastTypedTime[paneId] = Date.now();
    lastOutputTime[paneId] = Date.now();
    // Restore focus to non-xterm UI element if it was stolen
    if (restoreTarget) {
      setTimeout(() => restoreTarget.focus(), 50);
    }
    return;
  }

  // BUG-4 FIX: Use global lastUserUIFocus instead of per-call snapshot.
  // Per-call previousFocus breaks under staggered multi-pane sends because
  // the second call sees the first call's xterm textarea as activeElement.
  const restoreTarget = lastUserUIFocus;

  // Find xterm's hidden textarea for this pane
  const paneEl = document.querySelector(`.pane[data-pane-id="${id}"]`);
  const textarea = paneEl?.querySelector('.xterm-helper-textarea');

  // V16.11: Diagnostic logging
  console.log(`[doSendToPane ${id}] paneEl found:`, !!paneEl);
  console.log(`[doSendToPane ${id}] textarea found:`, !!textarea);
  if (restoreTarget) {
    console.log(`[doSendToPane ${id}] Will restore focus to:`, restoreTarget.id || restoreTarget.className);
  }

  if (textarea) {
    // Focus the textarea (needed for sendTrustedEnter to target xterm)
    textarea.focus();

    const focusSucceeded = document.activeElement === textarea;
    console.log(`[doSendToPane ${id}] focus succeeded:`, focusSucceeded);

    if (isCodex && hasTrailingEnter) {
      // CODEX PATH: Single pty.write with text + newline.
      // Codex TUI ignores synthetic Enter, sendInputEvent Enter, and clipboard paste.
      window.hivemind.pty.write(id, text + '\n');
      console.log(`[doSendToPane ${id}] Codex pane: single pty.write with trailing \\n`);

      if (restoreTarget) {
        setTimeout(() => {
          restoreTarget.focus();
          console.log(`[doSendToPane ${id}] Restored focus to:`, restoreTarget.id || restoreTarget.className);
        }, 50);
      }
    } else {
      // CLAUDE PATH (or no trailing Enter): two-step write then Enter
      window.hivemind.pty.write(id, text);
    }

    if (hasTrailingEnter && !isCodex) {
      setTimeout(() => {
        const term = terminals.get(id);
        if (term) term._hivemindBypass = true;

        window.hivemind.pty.write(id, '\r');

        // CLAUDE PATH: Trusted Enter via sendInputEvent (requires DOM focus)
        if (document.activeElement !== textarea) {
          textarea.focus();
        }
        window.hivemind.pty.sendTrustedEnter();
        console.log(`[doSendToPane ${id}] Claude pane: trusted Enter dispatched`);

        if (term) term._hivemindBypass = false;

        if (restoreTarget) {
          setTimeout(() => {
            restoreTarget.focus();
            console.log(`[doSendToPane ${id}] Restored focus to:`, restoreTarget.id || restoreTarget.className);
          }, 10);
        }
      }, 50);
    } else if (!isCodex) {
      // No trailing Enter and not Codex - restore focus immediately
      if (restoreTarget) {
        setTimeout(() => restoreTarget.focus(), 10);
      }
    }
  } else {
    // BUG-1 FIX: Retry finding textarea before falling back to unreliable PTY write.
    // Codex CLI textareas may not be in DOM yet if pane is still initializing.
    console.warn(`[doSendToPane ${id}] No textarea found, retrying...`);
    let retryCount = 0;
    const maxRetries = 5;
    const retryDelayMs = 100;

    const retryFindTextarea = () => {
      retryCount++;
      const retryPaneEl = document.querySelector(`.pane[data-pane-id="${id}"]`);
      const retryTextarea = retryPaneEl?.querySelector('.xterm-helper-textarea');

      if (retryTextarea) {
        console.log(`[doSendToPane ${id}] Textarea found on retry ${retryCount}`);
        retryTextarea.focus();

        if (isCodexPane(id) && hasTrailingEnter) {
          // Codex: single pty.write with text + newline
          window.hivemind.pty.write(id, text + '\n');
          console.log(`[doSendToPane ${id}] Codex retry: single pty.write with trailing \\n`);
          if (restoreTarget) {
            setTimeout(() => restoreTarget.focus(), 50);
          }
        } else {
          window.hivemind.pty.write(id, text);
          if (hasTrailingEnter) {
            setTimeout(() => {
              window.hivemind.pty.write(id, '\r');
              retryTextarea.focus();
              window.hivemind.pty.sendTrustedEnter();
              if (restoreTarget) {
                setTimeout(() => restoreTarget.focus(), 10);
              }
            }, 50);
          } else if (restoreTarget) {
            setTimeout(() => restoreTarget.focus(), 10);
          }
        }
      } else if (retryCount < maxRetries) {
        setTimeout(retryFindTextarea, retryDelayMs);
      } else {
        // Final fallback after all retries exhausted
        console.warn(`[doSendToPane ${id}] Textarea not found after ${maxRetries} retries, using PTY fallback`);
        window.hivemind.pty.write(id, hasTrailingEnter ? text + '\r' : text);

        if (restoreTarget) {
          setTimeout(() => restoreTarget.focus(), 10);
        }
      }
    };

    setTimeout(retryFindTextarea, retryDelayMs);
  }

  lastTypedTime[paneId] = Date.now();
}

// Send message to a specific pane
// V16.2: Idle detection - queue message if pane is busy (Claude thinking)
function sendToPane(paneId, message) {
  const id = String(paneId);

  // If pane is idle and user is not typing, send immediately
  if (isIdle(id) && !userIsTyping()) {
    doSendToPane(id, message);
    return;
  }

  // Pane is busy or user is typing - queue the message
  const reason = !isIdle(id) ? 'pane busy' : 'user typing';
  console.log(`[Terminal ${id}] ${reason}, queueing message`);

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

// Send message to Architect only (user interacts with Architect, Architect coordinates execution)
function broadcast(message) {
  // Send directly to Architect (pane 1), no broadcast prefix needed
  sendToPane('1', message);
  updateConnectionStatus('Message sent to Architect');
}

// Set SDK mode - blocks PTY spawn operations when enabled
function setSDKMode(enabled) {
  sdkModeActive = enabled;
  console.log(`[Terminal] SDK mode ${enabled ? 'enabled' : 'disabled'} - PTY spawn operations ${enabled ? 'blocked' : 'allowed'}`);
}

// Spawn claude in a pane
async function spawnClaude(paneId) {
  // Defense in depth: Early exit if no terminal exists for this pane
  // This catches race conditions where SDK mode blocks terminal creation but
  // user somehow triggers spawn before UI fully updates
  if (!terminals.has(paneId)) {
    console.log(`[spawnClaude] No terminal for pane ${paneId}, skipping`);
    return;
  }

  // SDK Mode Guard: Don't spawn CLI Claude when SDK mode is active
  if (sdkModeActive) {
    console.log(`[spawnClaude] SDK mode active - blocking CLI spawn for pane ${paneId}`);
    return;
  }

  // Codex exec mode: no interactive CLI spawn — send identity prompt to kick off agent
  if (isCodexPane(String(paneId))) {
    updatePaneStatus(paneId, 'Codex exec ready');
    // Auto-send identity message to start the Codex agent (mirrors Claude identity injection at line 716)
    setTimeout(() => {
      const role = PANE_ROLES[paneId] || `Pane ${paneId}`;
      const timestamp = new Date().toISOString().split('T')[0];
      const identityMsg = `# HIVEMIND SESSION: ${role} - Started ${timestamp}`;
      sendToPane(paneId, identityMsg + '\r');
      console.log(`[spawnClaude] Codex exec identity sent for ${role} (pane ${paneId})`);
    }, 2000);
    return;
  }

  const terminal = terminals.get(paneId);
  if (terminal) {
    updatePaneStatus(paneId, 'Starting agent...');
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

      // Codex CLI needs an extra Enter after startup to dismiss its welcome prompt
      // Claude Code CLI doesn't need this - it's ready immediately
      // NOTE: Codex sandbox_mode should be pre-configured via ~/.codex/config.toml
      // (sandbox_mode = "workspace-write") to skip the first-run sandbox prompt.
      // This PTY \r is a fallback to dismiss any residual prompt if config is missing.
      const isCodex = result.command.startsWith('codex');
      if (isCodex) {
        setTimeout(() => {
          window.hivemind.pty.write(String(paneId), '\r');
          console.log(`[spawnClaude] Codex pane ${paneId}: PTY \\r to dismiss any startup prompt`);
        }, 3000);
      }

      // ID-1: Inject identity message after CLI initializes
      // Uses sendToPane() which properly submits via keyboard events
      // This makes sessions identifiable in /resume list
      setTimeout(() => {
        const role = PANE_ROLES[paneId] || `Pane ${paneId}`;
        const timestamp = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
        const identityMsg = `# HIVEMIND SESSION: ${role} - Started ${timestamp}`;
        sendToPane(paneId, identityMsg + '\r');
        console.log(`[spawnClaude] Identity injected for ${role} (pane ${paneId})`);
      }, isCodex ? 5000 : 4000);
    }
    updatePaneStatus(paneId, 'Agent running');
  }
}

// Spawn claude in all panes
async function spawnAllClaude() {
  updateConnectionStatus('Starting agents in all panes...');
  for (const paneId of PANE_IDS) {
    await spawnClaude(paneId);
    // Small delay between panes to prevent race conditions
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  updateConnectionStatus('All agents running');
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

// FIX3: Aggressive nudge - ESC followed by Enter
// More forceful than simple Enter nudge, interrupts thinking then prompts input
function aggressiveNudge(paneId) {
  const id = String(paneId);
  console.log(`[Terminal ${id}] Aggressive nudge: ESC + Enter`);

  // First send ESC to interrupt any stuck state
  sendUnstick(id);

  // BUG-2 FIX: Use keyboard Enter dispatch instead of unreliable pty.write('\r')
  // PTY carriage return doesn't reliably submit in Codex CLI textareas
  setTimeout(() => {
    lastTypedTime[id] = Date.now();

    const paneEl = document.querySelector(`.pane[data-pane-id="${id}"]`);
    const textarea = paneEl?.querySelector('.xterm-helper-textarea');

    if (textarea) {
      textarea.focus();
      window.hivemind.pty.write(id, '\r');

      if (isCodexPane(id)) {
        // Codex: PTY newline to submit (clipboard paste broken - Codex treats as image paste)
        window.hivemind.pty.write(id, '\r');
        console.log(`[Terminal ${id}] Aggressive nudge: PTY carriage return (Codex)`);
      } else {
        window.hivemind.pty.sendTrustedEnter();
        console.log(`[Terminal ${id}] Aggressive nudge: trusted Enter dispatched (Claude)`);
      }
    } else {
      // Fallback if textarea truly missing
      console.warn(`[Terminal ${id}] Aggressive nudge: no textarea, PTY fallback`);
      window.hivemind.pty.write(id, '\r');
    }

    updatePaneStatus(id, 'Nudged (aggressive)');
    setTimeout(() => updatePaneStatus(id, 'Running'), 1000);
  }, 150); // 150ms delay between ESC and Enter
}

// FIX3: Aggressive nudge all panes
function aggressiveNudgeAll() {
  console.log('[Terminal] Aggressive nudge all panes');
  for (const paneId of PANE_IDS) {
    // Stagger to avoid thundering herd
    setTimeout(() => {
      aggressiveNudge(paneId);
    }, paneId * 200);
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
  // SDK Mode Guard: Don't allow fresh start in SDK mode
  if (sdkModeActive) {
    console.log('[freshStartAll] SDK mode active - blocking PTY fresh start');
    alert('Fresh Start is not available in SDK mode.\nSDK manages agent sessions differently.');
    return;
  }

  const confirmed = confirm(
    'Fresh Start will:\n\n' +
    '• Kill all 6 terminals\n' +
    '• Start new agent sessions with NO previous context\n\n' +
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

  // Spawn agents with fresh sessions
  for (const paneId of PANE_IDS) {
    await spawnClaude(paneId);
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
  setSDKMode,           // SDK mode guard for PTY operations
  initUIFocusTracker,   // BUG-4: Global UI focus tracking for multi-pane restore
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
  sendUnstick,         // V16.10: ESC keyboard event to unstick agents
  aggressiveNudge,     // FIX3: ESC + Enter for more forceful unstick
  aggressiveNudgeAll,  // FIX3: Aggressive nudge all panes with stagger
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
  registerCodexPane,   // CLI Identity: mark pane as Codex
  unregisterCodexPane, // CLI Identity: unmark pane as Codex
  isCodexPane,         // CLI Identity: query Codex status
  messageQueue,   // V16.2: Message queue for busy panes
};
