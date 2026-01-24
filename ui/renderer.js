// Hivemind Renderer - Terminal management and UI logic
const { Terminal } = require('xterm');
const { FitAddon } = require('xterm-addon-fit');
const { WebLinksAddon } = require('xterm-addon-web-links');
const { ipcRenderer } = require('electron');

// Create hivemind API (replaces preload bridge)
window.hivemind = {
  pty: {
    create: (paneId, workingDir) => ipcRenderer.invoke('pty-create', paneId, workingDir),
    write: (paneId, data) => ipcRenderer.invoke('pty-write', paneId, data),
    resize: (paneId, cols, rows) => ipcRenderer.invoke('pty-resize', paneId, cols, rows),
    kill: (paneId) => ipcRenderer.invoke('pty-kill', paneId),
    onData: (paneId, callback) => {
      ipcRenderer.on(`pty-data-${paneId}`, (event, data) => callback(data));
    },
    onExit: (paneId, callback) => {
      ipcRenderer.on(`pty-exit-${paneId}`, (event, code) => callback(code));
    },
  },
  claude: {
    spawn: (paneId, workingDir) => ipcRenderer.invoke('spawn-claude', paneId, workingDir),
  },
  context: {
    read: () => ipcRenderer.invoke('read-shared-context'),
    write: (content) => ipcRenderer.invoke('write-shared-context', content),
    getPath: () => ipcRenderer.invoke('get-shared-context-path'),
  },
  project: {
    select: () => ipcRenderer.invoke('select-project'),
    get: () => ipcRenderer.invoke('get-project'),
  },
  friction: {
    list: () => ipcRenderer.invoke('list-friction'),
    read: (filename) => ipcRenderer.invoke('read-friction', filename),
    delete: (filename) => ipcRenderer.invoke('delete-friction', filename),
    clear: () => ipcRenderer.invoke('clear-friction'),
  },
  screenshot: {
    save: (base64Data, originalName) => ipcRenderer.invoke('save-screenshot', base64Data, originalName),
    list: () => ipcRenderer.invoke('list-screenshots'),
    delete: (filename) => ipcRenderer.invoke('delete-screenshot', filename),
    getPath: (filename) => ipcRenderer.invoke('get-screenshot-path', filename),
  },
  process: {
    spawn: (command, args, cwd) => ipcRenderer.invoke('spawn-process', command, args, cwd),
    list: () => ipcRenderer.invoke('list-processes'),
    kill: (processId) => ipcRenderer.invoke('kill-process', processId),
    getOutput: (processId) => ipcRenderer.invoke('get-process-output', processId),
  },
};

// Pane configuration
const PANE_IDS = ['1', '2', '3', '4'];

// Track if we reconnected to existing terminals (skip auto-spawn in that case)
let reconnectedToExisting = false;
const PANE_ROLES = {
  '1': 'Lead',
  '2': 'Worker A',
  '3': 'Worker B',
  '4': 'Reviewer'
};

// State display helpers
const STATE_DISPLAY_NAMES = {
  'idle': 'IDLE',
  'project_selected': 'PROJECT SELECTED',
  'planning': 'PLANNING',
  'plan_review': 'PLAN REVIEW',
  'plan_revision': 'PLAN REVISION',
  'executing': 'EXECUTING',
  'checkpoint': 'CHECKPOINT',
  'checkpoint_review': 'CHECKPOINT REVIEW',
  'checkpoint_fix': 'CHECKPOINT FIX',
  'friction_logged': 'FRICTION LOGGED',
  'friction_sync': 'FRICTION SYNC',
  'friction_resolution': 'FRICTION RESOLUTION',
  'complete': 'COMPLETE',
  'error': 'ERROR',
  'paused': 'PAUSED',
};

// Terminal instances
const terminals = new Map();
const fitAddons = new Map();
let focusedPane = '1';

// Initialize all terminals
async function initTerminals() {
  for (const paneId of PANE_IDS) {
    await initTerminal(paneId);
  }
  updateConnectionStatus('All terminals ready');
  focusPane('1');
}

// Initialize a single terminal
async function initTerminal(paneId) {
  const container = document.getElementById(`terminal-${paneId}`);
  if (!container) return;

  // Create terminal with styling
  const terminal = new Terminal({
    theme: {
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
    },
    fontFamily: "'Consolas', 'Monaco', 'Courier New', monospace",
    fontSize: 13,
    cursorBlink: true,
    cursorStyle: 'block',
    scrollback: 5000,
    rightClickSelectsWord: true,
    allowProposedApi: true,
  });

  // Add addons
  const fitAddon = new FitAddon();
  const webLinksAddon = new WebLinksAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(webLinksAddon);

  // Open terminal in container
  terminal.open(container);
  fitAddon.fit();

  // Track selection for copy/paste
  let lastSelection = '';
  terminal.onSelectionChange(() => {
    const sel = terminal.getSelection();
    if (sel) lastSelection = sel;
  });

  // Right-click: copy if had selection, paste if not
  container.addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    e.stopPropagation();

    if (lastSelection) {
      // Copy the last selection
      await navigator.clipboard.writeText(lastSelection);
      updatePaneStatus(paneId, 'Copied!');
      setTimeout(() => updatePaneStatus(paneId, 'Connected'), 1000);
      lastSelection = ''; // Clear after copy
    } else {
      // Paste from clipboard
      try {
        const text = await navigator.clipboard.readText();
        if (text) {
          window.hivemind.pty.write(paneId, text);
          updatePaneStatus(paneId, 'Pasted!');
          setTimeout(() => updatePaneStatus(paneId, 'Connected'), 1000);
        }
      } catch (err) {
        console.error('Paste failed:', err);
      }
    }
  });

  // Ctrl+V paste support
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

  // Store references
  terminals.set(paneId, terminal);
  fitAddons.set(paneId, fitAddon);

  // Create PTY process
  try {
    await window.hivemind.pty.create(paneId, process.cwd());
    updatePaneStatus(paneId, 'Connected');

    // Connect terminal to PTY
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

  // Focus handling - use container click instead of terminal.onFocus
  container.addEventListener('click', () => {
    focusPane(paneId);
  });
}

// Reattach to an existing terminal (for daemon reconnection)
// Same as initTerminal but skips pty.create() since PTY already exists
async function reattachTerminal(paneId) {
  const container = document.getElementById(`terminal-${paneId}`);
  if (!container) return;

  // Check if terminal already exists
  if (terminals.has(paneId)) {
    console.log(`[Terminal ${paneId}] Already attached, skipping`);
    return;
  }

  // Create terminal with same styling as initTerminal
  const terminal = new Terminal({
    theme: {
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
    },
    fontFamily: "'Consolas', 'Monaco', 'Courier New', monospace",
    fontSize: 13,
    cursorBlink: true,
    cursorStyle: 'block',
    scrollback: 5000,
    rightClickSelectsWord: true,
    allowProposedApi: true,
  });

  // Add addons
  const fitAddon = new FitAddon();
  const webLinksAddon = new WebLinksAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(webLinksAddon);

  // Open terminal in container
  terminal.open(container);
  fitAddon.fit();

  // Track selection for copy/paste
  let lastSelection = '';
  terminal.onSelectionChange(() => {
    const sel = terminal.getSelection();
    if (sel) lastSelection = sel;
  });

  // Right-click: copy if had selection, paste if not
  container.addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    e.stopPropagation();

    if (lastSelection) {
      await navigator.clipboard.writeText(lastSelection);
      updatePaneStatus(paneId, 'Copied!');
      setTimeout(() => updatePaneStatus(paneId, 'Reconnected'), 1000);
      lastSelection = '';
    } else {
      try {
        const text = await navigator.clipboard.readText();
        if (text) {
          window.hivemind.pty.write(paneId, text);
          updatePaneStatus(paneId, 'Pasted!');
          setTimeout(() => updatePaneStatus(paneId, 'Reconnected'), 1000);
        }
      } catch (err) {
        console.error('Paste failed:', err);
      }
    }
  });

  // Ctrl+V paste support
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

  // Store references
  terminals.set(paneId, terminal);
  fitAddons.set(paneId, fitAddon);

  // Connect terminal to existing PTY (no create call!)
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
  terminal.write('\r\n[Session restored from daemon]\r\n');

  // Focus handling
  container.addEventListener('click', () => {
    focusPane(paneId);
  });
}

// Setup daemon connection listeners
function setupDaemonListeners() {
  // Handle initial daemon connection with existing terminals
  ipcRenderer.on('daemon-connected', async (event, data) => {
    const { terminals: existingTerminals } = data;
    console.log('[Daemon] Connected, existing terminals:', existingTerminals);

    if (existingTerminals && existingTerminals.length > 0) {
      updateConnectionStatus('Reconnecting to existing sessions...');
      reconnectedToExisting = true; // Skip auto-spawn for reconnected terminals

      // Reattach to each existing terminal
      for (const term of existingTerminals) {
        if (term.alive) {
          await reattachTerminal(String(term.paneId));
        }
      }

      updateConnectionStatus(`Restored ${existingTerminals.length} terminal(s)`);
    } else {
      // No existing terminals - create fresh ones
      console.log('[Daemon] No existing terminals, creating new ones...');
      updateConnectionStatus('Creating terminals...');
      await initTerminals();
      updateConnectionStatus('Ready');
    }
  });

  // Handle daemon reconnection after disconnect
  ipcRenderer.on('daemon-reconnected', (event) => {
    console.log('[Daemon] Reconnected after disconnect');
    updateConnectionStatus('Daemon reconnected');
  });

  // Handle daemon disconnect
  ipcRenderer.on('daemon-disconnected', (event) => {
    console.log('[Daemon] Disconnected');
    updateConnectionStatus('Daemon disconnected - terminals may be stale');
  });

  // Handle message injection from main process (auto-sync, broadcasts)
  // Write directly to PTY for proper execution
  ipcRenderer.on('inject-message', (event, data) => {
    const { panes, message } = data;
    for (const paneId of panes) {
      // Split: send text first, then Enter separately (like typing)
      const text = message.replace(/\r$/, '');
      window.hivemind.pty.write(String(paneId), text);
      // Small delay then send Enter
      setTimeout(() => {
        window.hivemind.pty.write(String(paneId), '\r');
      }, 50);
    }
  });
}

// Focus a specific pane
function focusPane(paneId) {
  // Remove focus from all panes
  document.querySelectorAll('.pane').forEach(pane => {
    pane.classList.remove('focused');
  });

  // Add focus to target pane
  const pane = document.querySelector(`.pane[data-pane-id="${paneId}"]`);
  if (pane) {
    pane.classList.add('focused');
  }

  // Focus the terminal
  const terminal = terminals.get(paneId);
  if (terminal) {
    terminal.focus();
  }

  focusedPane = paneId;
}

// Update pane status
function updatePaneStatus(paneId, status) {
  const statusEl = document.getElementById(`status-${paneId}`);
  if (statusEl) {
    statusEl.textContent = status;
  }
}

// Update connection status
function updateConnectionStatus(status) {
  const statusEl = document.getElementById('connectionStatus');
  if (statusEl) {
    statusEl.textContent = status;
  }
}

// Send message to a specific pane (with proper Enter handling)
function sendToPane(paneId, message) {
  // Split: send text first, then Enter separately (like typing)
  const text = message.replace(/\r$/, '');
  window.hivemind.pty.write(String(paneId), text);
  // Small delay then send Enter
  setTimeout(() => {
    window.hivemind.pty.write(String(paneId), '\r');
  }, 50);
}

// Broadcast message to all panes
function broadcast(message) {
  // Prefix with indicator so agents know it's a broadcast
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
      // Send command via terminal.paste() which properly triggers input
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

// Sync shared context to all panes
async function syncSharedContext() {
  updateConnectionStatus('Syncing shared context...');

  try {
    const result = await window.hivemind.context.read();

    if (!result.success) {
      updateConnectionStatus(`Sync failed: ${result.error}`);
      return;
    }

    // Format the context message for Claude
    const syncMessage = `[HIVEMIND SYNC] Please read and acknowledge the following shared context:

---
${result.content}
---

Acknowledge receipt and summarize the key points.\r`;

    // Send to all panes
    broadcast(syncMessage);
    updateConnectionStatus('Shared context synced to all panes');

  } catch (err) {
    updateConnectionStatus(`Sync error: ${err.message}`);
  }
}

// ============================================================
// STATE DISPLAY
// ============================================================

// Update state display in UI
function updateStateDisplay(state) {
  // Update state indicator
  const stateDisplay = document.getElementById('stateDisplay');
  if (stateDisplay) {
    const stateName = state.state || 'idle';
    stateDisplay.textContent = STATE_DISPLAY_NAMES[stateName] || stateName.toUpperCase();
    // Remove all state classes and add current one
    stateDisplay.className = 'state-value ' + stateName.replace(/_/g, '_');
  }

  // Update progress bar
  const progressFill = document.getElementById('progressFill');
  const progressText = document.getElementById('progressText');
  if (progressFill && progressText) {
    const current = state.current_checkpoint || 0;
    const total = state.total_checkpoints || 0;
    const percent = total > 0 ? (current / total) * 100 : 0;
    progressFill.style.width = `${percent}%`;
    progressText.textContent = `${current} / ${total}`;
  }

  // Update agent badges
  const activeAgents = state.active_agents || [];
  for (const paneId of PANE_IDS) {
    const badge = document.getElementById(`badge-${paneId}`);
    if (badge) {
      const isActive = activeAgents.includes(paneId);
      badge.classList.toggle('active', isActive);
      badge.classList.toggle('idle', !isActive);
    }
  }

  // Update connection status with state info
  updateConnectionStatus(`State: ${STATE_DISPLAY_NAMES[state.state] || state.state}`);
}

// Setup state change listener
function setupStateListener() {
  ipcRenderer.on('state-changed', (event, state) => {
    console.log('[State] Received state change:', state);
    updateStateDisplay(state);
  });
}

// ============================================================
// CLAUDE STATE TRACKING (QW-4)
// ============================================================

// Update agent status badge based on Claude state
function updateAgentStatus(paneId, state) {
  const statusEl = document.getElementById(`status-${paneId}`);
  if (statusEl) {
    const labels = {
      'idle': 'Idle',
      'starting': 'Starting Claude...',
      'running': 'Claude running',
    };
    statusEl.textContent = labels[state] || state;
    // Update CSS class for coloring
    statusEl.classList.remove('idle', 'starting', 'running');
    statusEl.classList.add(state || 'idle');
  }
}

// Listen for claude state changes from main process
function setupClaudeStateListener() {
  ipcRenderer.on('claude-state-changed', (event, states) => {
    console.log('[Claude State] Received:', states);
    for (const [paneId, state] of Object.entries(states)) {
      updateAgentStatus(paneId, state);
      // Update session timer based on state
      handleSessionTimerState(paneId, state);
    }
  });
}

// ============================================================
// COST ALERTS
// ============================================================

// Show cost alert notification
function showCostAlert(data) {
  console.log('[Cost Alert]', data.message);

  // Update cost display with warning style and pulsing animation
  const costEl = document.getElementById('usageEstCost');
  if (costEl) {
    costEl.style.color = '#e94560'; // Red warning color
    costEl.textContent = `$${data.cost}`;
    // Add alert class to parent for pulsing effect
    const parent = costEl.closest('.usage-stat.cost-estimate');
    if (parent) {
      parent.classList.add('alert');
    }
  }

  // Show toast notification
  showToast(data.message, 'warning');

  // Update alert badge if it exists
  const alertBadge = document.getElementById('costAlertBadge');
  if (alertBadge) {
    alertBadge.style.display = 'inline-block';
  }
}

// Simple toast notification
function showToast(message, type = 'info') {
  // Remove existing toast if any
  const existing = document.querySelector('.toast-notification');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = `toast-notification toast-${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  // Auto-dismiss after 5 seconds
  setTimeout(() => {
    toast.classList.add('toast-fade');
    setTimeout(() => toast.remove(), 500);
  }, 5000);
}

// Listen for cost alerts from main process
function setupCostAlertListener() {
  ipcRenderer.on('cost-alert', (event, data) => {
    showCostAlert(data);
  });
}

// ============================================================
// SESSION TIMERS (Cost Tracking)
// ============================================================

// Track session start times per pane
const sessionStartTimes = new Map();
let timerInterval = null;

// Format seconds as M:SS
function formatTimer(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Handle session timer state changes
function handleSessionTimerState(paneId, state) {
  if (state === 'running' && !sessionStartTimes.has(paneId)) {
    // Claude just started - begin tracking
    sessionStartTimes.set(paneId, Date.now());
    startTimerInterval();
  } else if (state === 'idle' && sessionStartTimes.has(paneId)) {
    // Claude stopped - stop tracking this pane
    sessionStartTimes.delete(paneId);
  }
  updateTimerDisplay(paneId);
}

// Update timer display for a pane
function updateTimerDisplay(paneId) {
  const timerEl = document.getElementById(`timer-${paneId}`);
  if (!timerEl) return;

  const startTime = sessionStartTimes.get(paneId);
  if (startTime) {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    timerEl.textContent = formatTimer(elapsed);
    timerEl.classList.add('active');
  } else {
    timerEl.textContent = '0:00';
    timerEl.classList.remove('active');
  }
}

// Update all timers
function updateAllTimers() {
  for (const paneId of PANE_IDS) {
    updateTimerDisplay(paneId);
  }

  // Stop interval if no active sessions
  if (sessionStartTimes.size === 0 && timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

// Start the timer update interval
function startTimerInterval() {
  if (!timerInterval) {
    timerInterval = setInterval(updateAllTimers, 1000);
  }
}

// Get total session time across all panes (in seconds)
function getTotalSessionTime() {
  let total = 0;
  const now = Date.now();
  for (const startTime of sessionStartTimes.values()) {
    total += Math.floor((now - startTime) / 1000);
  }
  return total;
}

// ============================================================
// REFRESH BUTTONS (QW-5)
// ============================================================

// Setup refresh buttons for each pane
function setupRefreshButtons() {
  document.querySelectorAll('.pane-refresh-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const paneId = btn.dataset.paneId;
      // Send command to read shared context
      sendToPane(paneId, '/read workspace/shared_context.md\n');
      updatePaneStatus(paneId, 'Refreshed');
      // Reset status after 2 seconds
      setTimeout(() => {
        const statusEl = document.getElementById(`status-${paneId}`);
        if (statusEl && statusEl.textContent === 'Refreshed') {
          statusEl.textContent = 'Ready';
        }
      }, 2000);
    });
  });
}

// ============================================================
// PROCESSES TAB
// ============================================================

let processList = [];

// Render process list
function renderProcessList() {
  const listEl = document.getElementById('processList');
  if (!listEl) return;

  if (processList.length === 0) {
    listEl.innerHTML = '<div class="process-empty">No processes running</div>';
    return;
  }

  listEl.innerHTML = processList.map(proc => `
    <div class="process-item" data-process-id="${proc.id}">
      <div class="process-status-dot ${proc.status}"></div>
      <div class="process-info">
        <div class="process-command">${proc.command} ${(proc.args || []).join(' ')}</div>
        <div class="process-details">PID: ${proc.pid || 'N/A'} | Status: ${proc.status}</div>
      </div>
      <button class="process-kill-btn" data-process-id="${proc.id}" ${proc.status !== 'running' ? 'disabled' : ''}>
        Kill
      </button>
    </div>
  `).join('');

  // Add click handlers for kill buttons
  listEl.querySelectorAll('.process-kill-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const processId = btn.dataset.processId;
      btn.disabled = true;
      btn.textContent = 'Killing...';
      const result = await window.hivemind.process.kill(processId);
      if (!result.success) {
        updateConnectionStatus(`Failed to kill process: ${result.error}`);
        btn.disabled = false;
        btn.textContent = 'Kill';
      }
    });
  });
}

// Load processes from backend
async function loadProcesses() {
  try {
    const result = await window.hivemind.process.list();
    if (result.success) {
      processList = result.processes;
      renderProcessList();
    }
  } catch (err) {
    console.error('Error loading processes:', err);
  }
}

// Spawn a new process
async function spawnProcess(commandStr) {
  if (!commandStr.trim()) return;

  // Parse command string into command and args
  const parts = commandStr.trim().split(/\s+/);
  const command = parts[0];
  const args = parts.slice(1);

  updateConnectionStatus(`Starting: ${commandStr}...`);

  try {
    const result = await window.hivemind.process.spawn(command, args);
    if (result.success) {
      updateConnectionStatus(`Started: ${commandStr} (PID: ${result.pid})`);
    } else {
      updateConnectionStatus(`Failed to start: ${result.error}`);
    }
  } catch (err) {
    updateConnectionStatus(`Error: ${err.message}`);
  }
}

// ============================================================
// BUILD PROGRESS TAB
// ============================================================

const AGENT_NAMES = {
  '1': 'Lead',
  '2': 'Worker A',
  '3': 'Worker B',
  '4': 'Reviewer',
};

// Update build progress tab with state data
function updateBuildProgress(state) {
  // State badge
  const stateEl = document.getElementById('progressState');
  if (stateEl) {
    const stateName = state.state || 'idle';
    stateEl.textContent = stateName.toUpperCase().replace(/_/g, ' ');
    stateEl.className = 'progress-state-badge ' + stateName.replace(/_/g, '_');
  }

  // Checkpoints
  const checkpointFill = document.getElementById('checkpointFill');
  const checkpointText = document.getElementById('checkpointText');
  if (checkpointFill && checkpointText) {
    const current = state.current_checkpoint || 0;
    const total = state.total_checkpoints || 0;
    const percent = total > 0 ? (current / total) * 100 : 0;
    checkpointFill.style.width = `${percent}%`;
    checkpointText.textContent = `${current} / ${total}`;
  }

  // Active agents
  const agentsEl = document.getElementById('activeAgentsList');
  if (agentsEl) {
    const agents = state.active_agents || [];
    if (agents.length === 0) {
      agentsEl.innerHTML = '<span class="no-agents">No agents active</span>';
    } else {
      agentsEl.innerHTML = agents.map(id =>
        `<span class="active-agent-badge">${AGENT_NAMES[id] || `Agent ${id}`}</span>`
      ).join('');
    }
  }

  // Friction count
  const frictionEl = document.getElementById('frictionCountDisplay');
  if (frictionEl) {
    frictionEl.textContent = state.friction_count || 0;
  }

  // Error display
  const errorSection = document.getElementById('errorSection');
  const errorDisplay = document.getElementById('errorDisplay');
  if (errorSection && errorDisplay) {
    if (state.error) {
      errorSection.style.display = 'block';
      errorDisplay.textContent = state.error;
    } else if (state.errors && state.errors.length > 0) {
      const lastError = state.errors[state.errors.length - 1];
      errorSection.style.display = 'block';
      errorDisplay.textContent = `${lastError.agent}: ${lastError.message}`;
    } else {
      errorSection.style.display = 'none';
    }
  }
}

// Update usage stats display
async function updateUsageStats() {
  try {
    const stats = await ipcRenderer.invoke('get-usage-stats');
    if (stats) {
      const totalSpawnsEl = document.getElementById('usageTotalSpawns');
      const sessionsTodayEl = document.getElementById('usageSessionsToday');
      const totalTimeEl = document.getElementById('usageTotalTime');
      const estCostEl = document.getElementById('usageEstCost');

      if (totalSpawnsEl) totalSpawnsEl.textContent = stats.totalSpawns || 0;
      if (sessionsTodayEl) sessionsTodayEl.textContent = stats.sessionsToday || 0;
      if (totalTimeEl) totalTimeEl.textContent = stats.totalSessionTime || '0s';
      if (estCostEl) estCostEl.textContent = `$${stats.estimatedCost || '0.00'}`;
    }
  } catch (err) {
    console.error('Error loading usage stats:', err);
  }
}

// Load and display current state
async function refreshBuildProgress() {
  try {
    const state = await ipcRenderer.invoke('get-state');
    if (state) {
      updateBuildProgress(state);
    }
    // Also refresh usage stats
    await updateUsageStats();
  } catch (err) {
    console.error('Error loading state:', err);
  }
}

// ============================================================
// CONFLICT DETECTION UI
// ============================================================

let currentConflicts = [];

function displayConflicts(conflicts) {
  currentConflicts = conflicts;
  const errorSection = document.getElementById('errorSection');
  const errorDisplay = document.getElementById('errorDisplay');
  if (conflicts.length > 0 && errorSection && errorDisplay) {
    errorSection.style.display = 'block';
    errorDisplay.textContent = `⚠️ File Conflict: ${conflicts.map(c => c.file).join(', ')}`;
    errorDisplay.style.color = '#ffc857';
  }
}

function setupConflictListener() {
  ipcRenderer.on('file-conflicts-detected', (event, conflicts) => {
    console.log('[Conflict]', conflicts);
    displayConflicts(conflicts);
  });
}

// Setup build progress tab
function setupBuildProgressTab() {
  const refreshBtn = document.getElementById('refreshProgressBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', refreshBuildProgress);
  setupConflictListener();
  refreshBuildProgress();
}

// Setup processes tab
function setupProcessesTab() {
  // Spawn form
  const commandInput = document.getElementById('processCommandInput');
  const spawnBtn = document.getElementById('processSpawnBtn');

  if (commandInput && spawnBtn) {
    spawnBtn.addEventListener('click', () => {
      spawnProcess(commandInput.value);
      commandInput.value = '';
    });

    commandInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        spawnProcess(commandInput.value);
        commandInput.value = '';
      }
    });
  }

  // Listen for process list updates
  ipcRenderer.on('processes-changed', (event, processes) => {
    console.log('[Processes] Updated:', processes);
    processList = processes;
    renderProcessList();
  });

  // Initial load
  loadProcesses();
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

// Setup event listeners
function setupEventListeners() {
  // Window resize
  window.addEventListener('resize', handleResize);

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    // Ctrl+1-4 to focus panes
    if (e.ctrlKey && e.key >= '1' && e.key <= '4') {
      e.preventDefault();
      focusPane(e.key);
    }
  });

  // Broadcast input
  const broadcastInput = document.getElementById('broadcastInput');
  if (broadcastInput) {
    broadcastInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const message = broadcastInput.value + '\r';
        broadcast(message);
        broadcastInput.value = '';
      }
    });
  }

  // Broadcast button
  const broadcastBtn = document.getElementById('broadcastBtn');
  if (broadcastBtn) {
    broadcastBtn.addEventListener('click', () => {
      const input = document.getElementById('broadcastInput');
      if (input && input.value) {
        broadcast(input.value + '\r');
        input.value = '';
      }
    });
  }

  // Spawn all button
  const spawnAllBtn = document.getElementById('spawnAllBtn');
  if (spawnAllBtn) {
    spawnAllBtn.addEventListener('click', spawnAllClaude);
  }

  // Sync button - sends shared_context.md to all panes
  const syncBtn = document.getElementById('syncBtn');
  if (syncBtn) {
    syncBtn.addEventListener('click', async () => {
      await syncSharedContext();
    });
  }

  // Select Project button
  const selectProjectBtn = document.getElementById('selectProjectBtn');
  if (selectProjectBtn) {
    selectProjectBtn.addEventListener('click', selectProject);
  }

  // Pane click to focus
  document.querySelectorAll('.pane').forEach(pane => {
    pane.addEventListener('click', () => {
      const paneId = pane.dataset.paneId;
      focusPane(paneId);
    });
  });

}

// ============================================================
// PROJECT PICKER
// ============================================================

// Update project path display
function updateProjectDisplay(projectPath) {
  const projectPathEl = document.getElementById('projectPath');
  if (projectPathEl) {
    if (projectPath) {
      projectPathEl.textContent = projectPath;
      projectPathEl.classList.remove('no-project');
    } else {
      projectPathEl.textContent = 'No project selected';
      projectPathEl.classList.add('no-project');
    }
  }
}

// Select project folder
async function selectProject() {
  updateConnectionStatus('Selecting project...');
  try {
    const result = await window.hivemind.project.select();
    if (result.success) {
      updateProjectDisplay(result.path);
      updateConnectionStatus(`Project: ${result.path}`);
    } else if (result.canceled) {
      updateConnectionStatus('Project selection canceled');
    } else {
      updateConnectionStatus('Failed to select project');
    }
  } catch (err) {
    updateConnectionStatus(`Error: ${err.message}`);
  }
}

// Load initial project on startup
async function loadInitialProject() {
  try {
    const projectPath = await window.hivemind.project.get();
    if (projectPath) {
      updateProjectDisplay(projectPath);
    }
  } catch (err) {
    console.error('Error loading initial project:', err);
  }
}

// Setup project picker listener
function setupProjectListener() {
  // Listen for project changes from main process
  ipcRenderer.on('project-changed', (event, projectPath) => {
    console.log('[Project] Changed to:', projectPath);
    updateProjectDisplay(projectPath);
  });
}

// ============================================================
// FRICTION PANEL
// ============================================================

let frictionFiles = [];

// Update friction badge count
function updateFrictionBadge(count) {
  const badge = document.getElementById('frictionBadge');
  if (badge) {
    badge.textContent = count;
  }
}

// Format date for display
function formatFrictionTime(isoString) {
  const date = new Date(isoString);
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// Render friction list
function renderFrictionList() {
  const listEl = document.getElementById('frictionList');
  if (!listEl) return;

  if (frictionFiles.length === 0) {
    listEl.innerHTML = '<div class="friction-empty">No friction logs found</div>';
    updateFrictionBadge(0);
    return;
  }

  updateFrictionBadge(frictionFiles.length);

  listEl.innerHTML = frictionFiles.map(f => `
    <div class="friction-item" data-filename="${f.name}">
      <span class="friction-item-name">${f.name}</span>
      <span class="friction-item-time">${formatFrictionTime(f.modified)}</span>
    </div>
  `).join('');

  // Add click handlers
  listEl.querySelectorAll('.friction-item').forEach(item => {
    item.addEventListener('click', () => viewFrictionFile(item.dataset.filename));
  });
}

// Load friction files
async function loadFrictionFiles() {
  try {
    const result = await window.hivemind.friction.list();
    if (result.success) {
      frictionFiles = result.files;
      renderFrictionList();
    }
  } catch (err) {
    console.error('Error loading friction files:', err);
  }
}

// View friction file content
async function viewFrictionFile(filename) {
  try {
    const result = await window.hivemind.friction.read(filename);
    if (result.success) {
      // Show content in an alert for now (could be improved with a modal)
      alert(`=== ${filename} ===\n\n${result.content}`);
    }
  } catch (err) {
    console.error('Error reading friction file:', err);
  }
}

// Clear all friction files
async function clearFriction() {
  if (!confirm('Clear all friction logs?')) return;

  try {
    const result = await window.hivemind.friction.clear();
    if (result.success) {
      frictionFiles = [];
      renderFrictionList();
      updateConnectionStatus('Friction logs cleared');
    }
  } catch (err) {
    console.error('Error clearing friction:', err);
  }
}

// Setup friction panel
function setupFrictionPanel() {
  // Friction button toggle
  const frictionBtn = document.getElementById('frictionBtn');
  const frictionPanel = document.getElementById('frictionPanel');

  if (frictionBtn && frictionPanel) {
    frictionBtn.addEventListener('click', () => {
      frictionPanel.classList.toggle('open');
      frictionBtn.classList.toggle('active');
      // Refresh on open
      if (frictionPanel.classList.contains('open')) {
        loadFrictionFiles();
      }
    });
  }

  // Refresh button
  const refreshBtn = document.getElementById('refreshFrictionBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', loadFrictionFiles);
  }

  // Clear button
  const clearBtn = document.getElementById('clearFrictionBtn');
  if (clearBtn) {
    clearBtn.addEventListener('click', clearFriction);
  }

  // Initial load
  loadFrictionFiles();
}

// ============================================================
// SETTINGS
// ============================================================

let currentSettings = {};

// Load and apply settings
async function loadSettings() {
  try {
    currentSettings = await ipcRenderer.invoke('get-settings');
    applySettingsToUI();
  } catch (err) {
    console.error('Error loading settings:', err);
  }
}

// Apply settings to toggle UI
function applySettingsToUI() {
  for (const [key, value] of Object.entries(currentSettings)) {
    const toggle = document.getElementById(`toggle${key.charAt(0).toUpperCase() + key.slice(1)}`);
    if (toggle) {
      toggle.classList.toggle('active', value);
    }
  }

  // Show/hide permissions warning
  const warning = document.getElementById('permissionsWarning');
  if (warning) {
    warning.style.display = currentSettings.allowAllPermissions ? 'block' : 'none';
  }

  // Populate cost alert threshold
  const thresholdInput = document.getElementById('costAlertThreshold');
  if (thresholdInput && currentSettings.costAlertThreshold !== undefined) {
    thresholdInput.value = currentSettings.costAlertThreshold.toFixed(2);
  }
}

// Handle setting toggle
async function toggleSetting(key) {
  try {
    const newValue = !currentSettings[key];
    currentSettings = await ipcRenderer.invoke('set-setting', key, newValue);
    applySettingsToUI();
    console.log(`[Settings] ${key} = ${newValue}`);
  } catch (err) {
    console.error('Error setting:', err);
  }
}

// Setup settings panel
function setupSettings() {
  // Settings button toggle
  const settingsBtn = document.getElementById('settingsBtn');
  const settingsPanel = document.getElementById('settingsPanel');

  if (settingsBtn && settingsPanel) {
    settingsBtn.addEventListener('click', () => {
      settingsPanel.classList.toggle('open');
      settingsBtn.classList.toggle('active');
    });
  }

  // Toggle switches
  document.querySelectorAll('.toggle').forEach(toggle => {
    toggle.addEventListener('click', () => {
      const setting = toggle.dataset.setting;
      if (setting) {
        toggleSetting(setting);
      }
    });
  });

  // Cost alert threshold input
  const thresholdInput = document.getElementById('costAlertThreshold');
  if (thresholdInput) {
    thresholdInput.addEventListener('change', async () => {
      const value = parseFloat(thresholdInput.value);
      if (!isNaN(value) && value > 0) {
        await ipcRenderer.invoke('set-setting', 'costAlertThreshold', value);
        console.log('[Settings] Cost alert threshold set to $' + value.toFixed(2));
      }
    });
  }

  // Load settings
  loadSettings();
}

// Check if should auto-spawn Claude
async function checkAutoSpawn() {
  // Skip auto-spawn if we reconnected to existing terminals (Claude already running)
  if (reconnectedToExisting) {
    console.log('[AutoSpawn] Skipping - reconnected to existing terminals');
    return;
  }

  if (currentSettings.autoSpawn) {
    updateConnectionStatus('Auto-spawning Claude in all panes...');
    await spawnAllClaude();
  }
}

// ============================================================
// RIGHT PANEL
// ============================================================

let panelOpen = false;

// Toggle right panel
function togglePanel() {
  const panel = document.getElementById('rightPanel');
  const terminalsSection = document.getElementById('terminalsSection');
  const panelBtn = document.getElementById('panelBtn');

  panelOpen = !panelOpen;

  if (panel) panel.classList.toggle('open', panelOpen);
  if (terminalsSection) terminalsSection.classList.toggle('panel-open', panelOpen);
  if (panelBtn) panelBtn.classList.toggle('active', panelOpen);

  // Trigger resize for terminals to fit new width
  setTimeout(handleResize, 350);
}

// Switch panel tab
function switchTab(tabId) {
  // Update tab buttons
  document.querySelectorAll('.panel-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.tab === tabId);
  });

  // Update tab content
  document.querySelectorAll('.tab-pane').forEach(pane => {
    pane.classList.toggle('active', pane.id === `tab-${tabId}`);
  });
}

// Setup right panel
function setupRightPanel() {
  // Panel toggle button
  const panelBtn = document.getElementById('panelBtn');
  if (panelBtn) {
    panelBtn.addEventListener('click', togglePanel);
  }

  // Tab switching
  document.querySelectorAll('.panel-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      switchTab(tab.dataset.tab);
    });
  });

  // Screenshot dropzone
  const dropzone = document.getElementById('screenshotDropzone');
  if (dropzone) {
    // Drag and drop
    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    });

    dropzone.addEventListener('dragleave', () => {
      dropzone.classList.remove('dragover');
    });

    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
      handleScreenshotDrop(e.dataTransfer.files);
    });

    // Click to browse
    dropzone.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.multiple = true;
      input.onchange = () => handleScreenshotDrop(input.files);
      input.click();
    });
  }

  // Clipboard paste
  document.addEventListener('paste', (e) => {
    if (panelOpen) {
      const items = e.clipboardData.items;
      const files = [];
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          files.push(item.getAsFile());
        }
      }
      if (files.length > 0) {
        handleScreenshotDrop(files);
      }
    }
  });

  // Load existing screenshots
  loadScreenshots();
}

// Handle screenshot files - saves to disk
async function handleScreenshotDrop(files) {
  const listEl = document.getElementById('screenshotList');
  if (!listEl) return;

  // Remove empty message
  const emptyMsg = listEl.querySelector('.screenshot-empty');
  if (emptyMsg) emptyMsg.remove();

  let savedCount = 0;

  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;

    const reader = new FileReader();
    reader.onload = async (e) => {
      const base64Data = e.target.result;

      // Save to disk
      const result = await window.hivemind.screenshot.save(base64Data, file.name);
      if (!result.success) {
        updateConnectionStatus(`Failed to save ${file.name}: ${result.error}`);
        return;
      }

      savedCount++;
      const savedFilename = result.filename;
      const savedPath = result.path;

      // Create UI item
      const item = document.createElement('div');
      item.className = 'screenshot-item';
      item.dataset.filename = savedFilename;
      item.innerHTML = `
        <img class="screenshot-thumb" src="${base64Data}" alt="${savedFilename}">
        <div class="screenshot-info">
          <div class="screenshot-name" title="${savedPath}">${savedFilename}</div>
          <div class="screenshot-size">${(file.size / 1024).toFixed(1)} KB</div>
        </div>
        <div class="screenshot-actions">
          <button class="screenshot-btn copy-btn" title="Copy path">📋</button>
          <button class="screenshot-btn delete-btn" title="Delete">×</button>
        </div>
      `;

      // Delete button - removes from disk
      item.querySelector('.delete-btn').addEventListener('click', async () => {
        const delResult = await window.hivemind.screenshot.delete(savedFilename);
        if (delResult.success) {
          item.remove();
          if (listEl.children.length === 0) {
            listEl.innerHTML = '<div class="screenshot-empty">No screenshots yet</div>';
          }
          updateConnectionStatus(`Deleted ${savedFilename}`);
        } else {
          updateConnectionStatus(`Failed to delete: ${delResult.error}`);
        }
      });

      // Copy path button - for agent reference
      item.querySelector('.copy-btn').addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(savedPath);
          updateConnectionStatus(`Copied path: ${savedPath}`);
        } catch (err) {
          updateConnectionStatus(`Copy failed: ${err.message}`);
        }
      });

      listEl.appendChild(item);
    };
    reader.readAsDataURL(file);
  }

  updateConnectionStatus(`Saving ${files.length} screenshot(s)...`);
}

// Load existing screenshots from disk
async function loadScreenshots() {
  const listEl = document.getElementById('screenshotList');
  if (!listEl) return;

  try {
    const result = await window.hivemind.screenshot.list();
    if (!result.success) {
      console.error('Failed to load screenshots:', result.error);
      return;
    }

    if (result.files.length === 0) {
      listEl.innerHTML = '<div class="screenshot-empty">No screenshots yet</div>';
      return;
    }

    // Clear list
    listEl.innerHTML = '';

    // Add each screenshot
    for (const file of result.files) {
      const item = document.createElement('div');
      item.className = 'screenshot-item';
      item.dataset.filename = file.name;
      item.innerHTML = `
        <img class="screenshot-thumb" src="file://${file.path.replace(/\\/g, '/')}" alt="${file.name}">
        <div class="screenshot-info">
          <div class="screenshot-name" title="${file.path}">${file.name}</div>
          <div class="screenshot-size">${(file.size / 1024).toFixed(1)} KB</div>
        </div>
        <div class="screenshot-actions">
          <button class="screenshot-btn copy-btn" title="Copy path">📋</button>
          <button class="screenshot-btn delete-btn" title="Delete">×</button>
        </div>
      `;

      // Delete button
      const savedFilename = file.name;
      const savedPath = file.path;
      item.querySelector('.delete-btn').addEventListener('click', async () => {
        const delResult = await window.hivemind.screenshot.delete(savedFilename);
        if (delResult.success) {
          item.remove();
          if (listEl.children.length === 0) {
            listEl.innerHTML = '<div class="screenshot-empty">No screenshots yet</div>';
          }
          updateConnectionStatus(`Deleted ${savedFilename}`);
        } else {
          updateConnectionStatus(`Failed to delete: ${delResult.error}`);
        }
      });

      // Copy path button
      item.querySelector('.copy-btn').addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(savedPath);
          updateConnectionStatus(`Copied path: ${savedPath}`);
        } catch (err) {
          updateConnectionStatus(`Copy failed: ${err.message}`);
        }
      });

      listEl.appendChild(item);
    }

    updateConnectionStatus(`Loaded ${result.files.length} screenshot(s)`);
  } catch (err) {
    console.error('Error loading screenshots:', err);
  }
}

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', async () => {
  setupEventListeners();
  setupStateListener();
  setupClaudeStateListener();
  setupCostAlertListener();
  setupRefreshButtons();
  setupProjectListener();
  setupFrictionPanel();
  setupSettings();
  setupRightPanel();
  setupProcessesTab();
  setupBuildProgressTab();
  setupDaemonListeners();
  // Note: initTerminals() is now called from daemon-connected handler
  // This ensures daemon is ready before creating terminals

  // Load initial project path
  await loadInitialProject();

  // Check auto-spawn after terminals are ready
  setTimeout(() => {
    checkAutoSpawn();
  }, 1000);
});
