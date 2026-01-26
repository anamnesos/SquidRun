/**
 * Hivemind Renderer - Main entry point
 * Orchestrates terminal, tabs, settings, and daemon handler modules
 */

const { ipcRenderer } = require('electron');

// Import modules
const terminal = require('./modules/terminal');
const tabs = require('./modules/tabs');
const settings = require('./modules/settings');
const daemonHandlers = require('./modules/daemon-handlers');
const sdkRenderer = require('./modules/sdk-renderer');

// SDK mode flag - when true, use SDK renderer instead of xterm terminals
let sdkMode = false;

// Initialization state tracking - fixes race condition in auto-spawn
let initState = {
  settingsLoaded: false,
  terminalsReady: false,
  autoSpawnChecked: false
};

function checkInitComplete() {
  if (initState.settingsLoaded && initState.terminalsReady && !initState.autoSpawnChecked) {
    initState.autoSpawnChecked = true;
    console.log('[Init] Both settings and terminals ready, checking auto-spawn...');
    settings.checkAutoSpawn(
      terminal.spawnAllClaude,
      terminal.getReconnectedToExisting()
    );
  }
}

function markSettingsLoaded() {
  initState.settingsLoaded = true;
  console.log('[Init] Settings loaded');

  // SDK Mode: Set SDK mode flags in all relevant modules
  const currentSettings = settings.getSettings();
  if (currentSettings.sdkMode) {
    console.log('[Init] SDK mode enabled in settings - notifying modules');
    daemonHandlers.setSDKMode(true);
    terminal.setSDKMode(true);  // Block PTY spawn operations
  }

  checkInitComplete();
}

function markTerminalsReady(isSDKMode = false) {
  initState.terminalsReady = true;
  console.log('[Init] Terminals ready, SDK mode:', isSDKMode);

  // SDK Mode: Initialize SDK panes and start sessions
  if (isSDKMode) {
    console.log('[Init] Initializing SDK mode...');
    sdkMode = true;
    sdkRenderer.initAllSDKPanes();

    // Auto-start SDK sessions (get workspace path via IPC)
    console.log('[Init] Auto-starting SDK sessions...');
    ipcRenderer.invoke('get-project')
      .then(projectPath => {
        return ipcRenderer.invoke('sdk-start-sessions', { workspace: projectPath || undefined });
      })
      .then(() => {
        console.log('[Init] SDK sessions started');
        updateConnectionStatus('SDK Mode - agents starting...');
      })
      .catch(err => {
        console.error('[Init] Failed to start SDK sessions:', err);
        updateConnectionStatus('SDK Mode - start failed');
      });
  }

  checkInitComplete();
}

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
  // SDK mode API (Task #2)
  sdk: {
    start: (prompt) => ipcRenderer.invoke('sdk-start', prompt),
    stop: () => ipcRenderer.invoke('sdk-stop'),
    isActive: () => sdkMode,
    enableMode: () => {
      // Idempotent - don't reinitialize if already enabled
      if (sdkMode) {
        console.log('[SDK] Mode already enabled, skipping reinit');
        return;
      }
      sdkMode = true;
      sdkRenderer.initAllSDKPanes();
      console.log('[SDK] Mode enabled');
    },
    disableMode: () => {
      sdkMode = false;
      console.log('[SDK] Mode disabled');
    },
    // SDK status functions (exposed for external use)
    updateStatus: (paneId, state) => updateSDKStatus(paneId, state),
    showDelivered: (paneId) => showSDKMessageDelivered(paneId),
    setSessionId: (paneId, sessionId, show) => setSDKSessionId(paneId, sessionId, show),
  },
  // Settings API - expose settings module for debugMode check etc.
  settings: {
    get: () => settings.getSettings(),
    isDebugMode: () => settings.getSettings()?.debugMode || false,
  },
};

// Status update functions (shared across modules)
function updatePaneStatus(paneId, status) {
  const statusEl = document.getElementById(`status-${paneId}`);
  if (statusEl) {
    statusEl.textContent = status;
  }
}

function updateConnectionStatus(status) {
  const statusEl = document.getElementById('connectionStatus');
  if (statusEl) {
    statusEl.textContent = status;
  }
}

// SDK Status update functions
const SDK_STATUS_LABELS = {
  disconnected: '—',
  connected: '●',
  idle: '○',
  thinking: '◐',  // Will be animated
  responding: '◑',
  error: '✕'
};

// Braille spinner frames (same as Claude Code CLI)
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_INTERVAL = 80; // ms

// Header spinner animation intervals per pane
const headerSpinnerIntervals = new Map();
const headerSpinnerFrameIndex = new Map();

// Idle state tracking per pane
const paneIdleState = new Map();
const IDLE_THRESHOLD_MS = 30000; // 30 seconds before showing idle state

/**
 * Track pane activity and manage idle state
 * @param {string} paneId - Pane ID
 * @param {boolean} isActive - Whether pane just became active
 */
function trackPaneActivity(paneId, isActive) {
  const pane = document.querySelector(`.pane[data-pane-id="${paneId}"]`);
  if (!pane) return;

  if (isActive) {
    // Activity detected - clear idle state
    pane.classList.remove('idle');
    const existingIdleIndicator = pane.querySelector('.sdk-idle-indicator');
    if (existingIdleIndicator) existingIdleIndicator.remove();

    // Reset idle timer
    const existing = paneIdleState.get(paneId);
    if (existing?.timerId) clearTimeout(existing.timerId);

    paneIdleState.set(paneId, {
      lastActive: Date.now(),
      timerId: setTimeout(() => enterIdleState(paneId), IDLE_THRESHOLD_MS)
    });
  }
}

/**
 * Enter idle state for a pane (called after IDLE_THRESHOLD_MS of inactivity)
 * @param {string} paneId - Pane ID
 */
function enterIdleState(paneId) {
  const pane = document.querySelector(`.pane[data-pane-id="${paneId}"]`);
  if (!pane) return;

  // Add idle class for breathing animation
  pane.classList.add('idle');

  // Add idle indicator with timestamp
  const sdkPane = pane.querySelector('.sdk-pane');
  if (sdkPane && !pane.querySelector('.sdk-idle-indicator')) {
    const indicator = document.createElement('div');
    indicator.className = 'sdk-idle-indicator';
    const idleState = paneIdleState.get(paneId);
    const idleSecs = idleState ? Math.round((Date.now() - idleState.lastActive) / 1000) : 30;
    const idleText = idleSecs >= 60 ? `${Math.floor(idleSecs / 60)}m` : `${idleSecs}s`;

    indicator.innerHTML = `
      <span class="sdk-idle-dot"></span>
      <span class="sdk-idle-text">Idle ${idleText}</span>
    `;
    sdkPane.insertBefore(indicator, sdkPane.firstChild);

    // Update idle time every 10 seconds
    const updateInterval = setInterval(() => {
      const state = paneIdleState.get(paneId);
      if (!state || !pane.classList.contains('idle')) {
        clearInterval(updateInterval);
        return;
      }
      const secs = Math.round((Date.now() - state.lastActive) / 1000);
      const text = secs >= 60 ? `${Math.floor(secs / 60)}m` : `${secs}s`;
      const textEl = indicator.querySelector('.sdk-idle-text');
      if (textEl) textEl.textContent = `Idle ${text}`;
    }, 10000);
  }
}

function updateSDKStatus(paneId, state) {
  const statusEl = document.getElementById(`sdk-status-${paneId}`);
  if (!statusEl) return;

  // Track activity - anything but 'idle' is activity
  if (state !== 'idle' && state !== 'disconnected') {
    trackPaneActivity(paneId, true);
  }

  // Stop any existing spinner animation
  const existingInterval = headerSpinnerIntervals.get(paneId);
  if (existingInterval) {
    clearInterval(existingInterval);
    headerSpinnerIntervals.delete(paneId);
    headerSpinnerFrameIndex.delete(paneId);
  }

  // Remove all state classes
  statusEl.classList.remove('disconnected', 'connected', 'idle', 'thinking', 'responding', 'error', 'delivered');

  // Add new state class
  statusEl.classList.add(state);
  statusEl.title = `SDK: ${state}`;

  // Start spinner animation for thinking/responding states
  if (state === 'thinking' || state === 'responding') {
    headerSpinnerFrameIndex.set(paneId, 0);
    statusEl.textContent = SPINNER_FRAMES[0];

    const interval = setInterval(() => {
      let frameIdx = (headerSpinnerFrameIndex.get(paneId) + 1) % SPINNER_FRAMES.length;
      headerSpinnerFrameIndex.set(paneId, frameIdx);
      statusEl.textContent = SPINNER_FRAMES[frameIdx];
    }, SPINNER_INTERVAL);

    headerSpinnerIntervals.set(paneId, interval);
  } else {
    statusEl.textContent = SDK_STATUS_LABELS[state] || state;
  }

  console.log(`[SDK] Pane ${paneId} status: ${state}`);
}

function showSDKMessageDelivered(paneId) {
  const statusEl = document.getElementById(`sdk-status-${paneId}`);
  if (!statusEl) return;

  // Trigger delivered animation
  statusEl.classList.add('delivered');
  setTimeout(() => {
    statusEl.classList.remove('delivered');
  }, 600);

  console.log(`[SDK] Pane ${paneId} message delivered`);
}

function setSDKSessionId(paneId, sessionId, showInUI = false) {
  const sessionEl = document.getElementById(`sdk-session-${paneId}`);
  if (!sessionEl) return;

  sessionEl.textContent = sessionId ? sessionId.substring(0, 8) + '...' : '';
  sessionEl.title = sessionId || 'No session';
  sessionEl.classList.toggle('visible', showInUI && sessionId);
}

// Wire up module callbacks
terminal.setStatusCallbacks(updatePaneStatus, updateConnectionStatus);
tabs.setConnectionStatusCallback(updateConnectionStatus);
settings.setConnectionStatusCallback(updateConnectionStatus);
settings.setSettingsLoadedCallback(markSettingsLoaded);
daemonHandlers.setStatusCallbacks(updateConnectionStatus, updatePaneStatus);

// Toggle worker pane expanded state
function toggleExpandPane(paneId) {
  const pane = document.querySelector(`.pane[data-pane-id="${paneId}"]`);
  if (!pane || !pane.classList.contains('worker-pane')) return;

  const isExpanded = pane.classList.toggle('expanded');
  const expandBtn = pane.querySelector('.expand-btn');

  // Update button icon
  if (expandBtn) {
    expandBtn.textContent = isExpanded ? '⤡' : '⤢';
    expandBtn.title = isExpanded ? 'Collapse pane' : 'Expand pane';
  }

  // Hide/show other worker panes
  document.querySelectorAll('.worker-pane').forEach(wp => {
    if (wp.dataset.paneId !== paneId) {
      wp.classList.toggle('collapsed', isExpanded);
    }
  });

  // Refit terminals after layout change
  setTimeout(() => {
    terminal.handleResize();
  }, 50);
}

// Setup event listeners
function setupEventListeners() {
  // Window resize
  window.addEventListener('resize', terminal.handleResize);

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    // Ctrl+1-4 to focus panes
    if (e.ctrlKey && e.key >= '1' && e.key <= '4') {
      e.preventDefault();
      terminal.focusPane(e.key);
    }
  });

  // Broadcast input - Enter re-enabled (ghost text fix is in xterm, not here)
  const broadcastInput = document.getElementById('broadcastInput');
  let lastBroadcastTime = 0;

  // Helper function to send broadcast - routes through SDK or PTY based on mode
  // V2 FIX: Support pane targeting with /1, /2, /3, /4 prefix
  function sendBroadcast(message) {
    const now = Date.now();
    if (now - lastBroadcastTime < 500) {
      console.log('[Broadcast] Rate limited');
      return false;
    }
    lastBroadcastTime = now;

    // Check SDK mode from settings
    const currentSettings = settings.getSettings();
    if (currentSettings.sdkMode || sdkMode) {
      // V2 FIX: Check for pane targeting prefix: /1, /2, /3, /4 or /lead, /worker-a, etc.
      // /all broadcasts to all agents
      const paneMatch = message.match(/^\/([1-4]|all|lead|worker-?a|worker-?b|reviewer)\s+/i);
      if (paneMatch) {
        const target = paneMatch[1].toLowerCase();
        const actualMessage = message.slice(paneMatch[0].length);
        if (target === 'all') {
          console.log('[SDK] Broadcast to ALL agents');
          // Show user message in ALL panes immediately
          ['1', '2', '3', '4'].forEach(paneId => {
            sdkRenderer.appendMessage(paneId, { type: 'user', content: actualMessage });
          });
          ipcRenderer.invoke('sdk-broadcast', actualMessage);
        } else {
          const paneMap = { '1': '1', '2': '2', '3': '3', '4': '4', 'lead': '1', 'worker-a': '2', 'workera': '2', 'worker-b': '3', 'workerb': '3', 'reviewer': '4' };
          const paneId = paneMap[target] || '1';
          console.log(`[SDK] Targeted send to pane ${paneId}: ${actualMessage.substring(0, 30)}...`);
          // Show user message in target pane immediately
          sdkRenderer.appendMessage(paneId, { type: 'user', content: actualMessage });
          ipcRenderer.invoke('sdk-send-message', paneId, actualMessage);
        }
      } else {
        // V2 FIX: Default to Lead only (pane 1), not broadcast to all
        // Use /all prefix to explicitly broadcast to all agents
        console.log('[SDK] Default send to Lead (pane 1)');
        // Show user message in Lead pane immediately
        sdkRenderer.appendMessage('1', { type: 'user', content: message });
        ipcRenderer.invoke('sdk-send-message', '1', message);
      }
    } else {
      console.log('[Broadcast] Using PTY mode');
      terminal.broadcast(message + '\r');
    }
    return true;
  }

  if (broadcastInput) {
    broadcastInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        // Only allow trusted (real user) Enter presses
        if (!e.isTrusted) {
          e.preventDefault();
          console.log('[Broadcast] Blocked untrusted Enter');
          return;
        }
        e.preventDefault();
        const input = broadcastInput;
        if (input.value && input.value.trim()) {
          if (sendBroadcast(input.value.trim())) {
            input.value = '';
          }
        }
      }
    });
  }

  // Broadcast button - also works (for accessibility)
  const broadcastBtn = document.getElementById('broadcastBtn');
  if (broadcastBtn) {
    broadcastBtn.addEventListener('click', (e) => {
      // Must be trusted click event
      if (!e.isTrusted) {
        console.log('[Broadcast] Blocked untrusted click');
        return;
      }
      const input = document.getElementById('broadcastInput');
      if (input && input.value && input.value.trim()) {
        if (sendBroadcast(input.value.trim())) {
          input.value = '';
        }
      }
    });
  }

  // Spawn all button
  const spawnAllBtn = document.getElementById('spawnAllBtn');
  if (spawnAllBtn) {
    spawnAllBtn.addEventListener('click', terminal.spawnAllClaude);
  }

  // Kill all button
  const killAllBtn = document.getElementById('killAllBtn');
  if (killAllBtn) {
    killAllBtn.addEventListener('click', terminal.killAllTerminals);
  }

  // Nudge all button - unstick churning agents (FIX3: now uses aggressive ESC+Enter)
  const nudgeAllBtn = document.getElementById('nudgeAllBtn');
  if (nudgeAllBtn) {
    nudgeAllBtn.addEventListener('click', terminal.aggressiveNudgeAll);
  }

  // Fresh start button - kill all and start new sessions
  const freshStartBtn = document.getElementById('freshStartBtn');
  if (freshStartBtn) {
    freshStartBtn.addEventListener('click', terminal.freshStartAll);
  }

  // Full restart button - kill daemon and reload app with fresh code
  const fullRestartBtn = document.getElementById('fullRestartBtn');
  if (fullRestartBtn) {
    fullRestartBtn.addEventListener('click', async () => {
      if (confirm('This will kill the daemon and restart the app.\n\nAll agent conversations will be lost, but code changes will be loaded.\n\nContinue?')) {
        updateConnectionStatus('Restarting...');
        await ipcRenderer.invoke('full-restart');
      }
    });
  }

  // Sync button
  const syncBtn = document.getElementById('syncBtn');
  if (syncBtn) {
    syncBtn.addEventListener('click', async () => {
      await terminal.syncSharedContext();
    });
  }

  // Select Project button
  const selectProjectBtn = document.getElementById('selectProjectBtn');
  if (selectProjectBtn) {
    selectProjectBtn.addEventListener('click', daemonHandlers.selectProject);
  }

  // Pane click to focus
  document.querySelectorAll('.pane').forEach(pane => {
    pane.addEventListener('click', () => {
      const paneId = pane.dataset.paneId;
      terminal.focusPane(paneId);
    });
  });

  // Expand button for worker panes - toggles expanded view
  document.querySelectorAll('.expand-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation(); // Don't trigger pane focus
      const paneId = btn.dataset.paneId;
      toggleExpandPane(paneId);
    });
  });

  // Fix: Blur terminals when UI input/textarea gets focus (NOT xterm's internal textarea)
  // This prevents xterm from capturing keyboard input meant for form fields
  document.addEventListener('focusin', (e) => {
    // xterm uses a hidden textarea with class 'xterm-helper-textarea' for keyboard input
    // We must NOT blur terminals when that textarea gets focus, or typing won't work
    const isXtermTextarea = e.target.classList && e.target.classList.contains('xterm-helper-textarea');
    if ((e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') && !isXtermTextarea) {
      // Blur all terminals so they don't capture keyboard input
      terminal.blurAllTerminals();
    }
  });
}

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', async () => {
  // Setup all event handlers
  setupEventListeners();

  // Global ESC key handler - interrupt agent AND release keyboard
  ipcRenderer.on('global-escape-pressed', () => {
    // Send Ctrl+C (0x03) to focused pane to interrupt Claude
    const focusedPane = terminal.getFocusedPane();
    if (focusedPane) {
      window.hivemind.pty.write(focusedPane, '\x03');
    }

    // Also blur terminals to release keyboard capture
    terminal.blurAllTerminals();
    if (document.activeElement) {
      document.activeElement.blur();
    }

    // Show visual feedback
    const statusBar = document.querySelector('.status-bar');
    if (statusBar) {
      const msg = document.createElement('span');
      msg.textContent = ` | Ctrl+C sent to pane ${focusedPane} - agent interrupted`;
      msg.style.color = '#4fc3f7';
      statusBar.appendChild(msg);
      setTimeout(() => msg.remove(), 2000);
    }
  });

  // HB4: Watchdog alert - all agents stuck, notify user
  // FIX3: Now auto-triggers aggressive nudge and uses it for click handler
  ipcRenderer.on('watchdog-alert', (event, data) => {
    console.log('[Watchdog] Alert received:', data);

    // FIX3: Auto-trigger aggressive nudge when watchdog fires
    console.log('[Watchdog] Auto-triggering aggressive nudge on all panes');
    terminal.aggressiveNudgeAll();

    // Show desktop notification
    if (Notification.permission === 'granted') {
      new Notification('Hivemind Alert', {
        body: 'Agents stuck - auto-nudged with ESC+Enter',
        icon: 'assets/icon.png',
        requireInteraction: true
      });
    } else if (Notification.permission !== 'denied') {
      Notification.requestPermission().then(perm => {
        if (perm === 'granted') {
          new Notification('Hivemind Alert', {
            body: 'Agents stuck - auto-nudged with ESC+Enter',
            requireInteraction: true
          });
        }
      });
    }

    // Play alert sound
    try {
      const audio = new Audio('assets/alert.mp3');
      audio.play().catch(() => console.log('[Watchdog] Could not play alert sound'));
    } catch (e) {
      console.log('[Watchdog] Audio not available');
    }

    // Show visual alert in status bar (click for additional nudge if needed)
    const statusBar = document.querySelector('.status-bar');
    if (statusBar) {
      const alert = document.createElement('span');
      alert.className = 'watchdog-alert';
      alert.textContent = ' ⚠️ Auto-nudged - Click for another nudge';
      alert.style.cssText = 'color: #ff5722; font-weight: bold; cursor: pointer; animation: pulse 1s infinite;';
      alert.onclick = () => {
        terminal.aggressiveNudgeAll();
        alert.remove();
      };
      statusBar.appendChild(alert);
    }
  });

  // V17: Heartbeat state indicator
  ipcRenderer.on('heartbeat-state-changed', (event, data) => {
    const { state, interval } = data;
    const indicator = document.getElementById('heartbeatIndicator');
    if (indicator) {
      // Format interval for display
      const minutes = Math.round(interval / 60000);
      const seconds = Math.round(interval / 1000);
      const displayInterval = minutes >= 1 ? `${minutes}m` : `${seconds}s`;

      // Update text and class
      indicator.textContent = `HB: ${state.toUpperCase()} (${displayInterval})`;
      indicator.className = `heartbeat-indicator ${state}`;
      indicator.style.display = 'inline-flex';

      console.log(`[Heartbeat] State changed: ${state}, interval: ${displayInterval}`);
    }
  });

  // V16 FIX: Single agent stuck detection - notify user (we can't auto-ESC via PTY)
  // Track shown alerts to avoid spamming
  const stuckAlertShown = new Set();
  ipcRenderer.on('agent-stuck-detected', (event, data) => {
    const { paneId, idleTime, message } = data;

    // Only show once per stuck detection (reset after 60 seconds)
    if (stuckAlertShown.has(paneId)) return;
    stuckAlertShown.add(paneId);
    setTimeout(() => stuckAlertShown.delete(paneId), 60000);

    console.log(`[Stuck Detection] Pane ${paneId} stuck for ${Math.round(idleTime / 1000)}s`);

    // Flash the stuck pane header
    const pane = document.querySelector(`.pane[data-pane-id="${paneId}"]`);
    if (pane) {
      const header = pane.querySelector('.pane-header');
      if (header) {
        header.style.boxShadow = '0 0 10px #ff5722';
        setTimeout(() => header.style.boxShadow = '', 3000);
      }
    }

    // Show brief status bar notification
    const statusBar = document.querySelector('.status-bar');
    if (statusBar) {
      const alert = document.createElement('span');
      alert.textContent = ` | Pane ${paneId} may be stuck - click pane and press ESC`;
      alert.style.cssText = 'color: #ffc857; cursor: pointer;';
      alert.onclick = () => {
        terminal.focusPane(paneId);
        alert.remove();
      };
      statusBar.appendChild(alert);
      setTimeout(() => alert.remove(), 5000);
    }
  });

  // SDK Message Handler (Task #2)
  // Receives messages from Python SDK via IPC and routes to correct pane
  // BUG FIX: sdk-bridge sends single object { paneId, message }, not separate args
  // SDK-2 FIX: Add null check for malformed data
  // UX-8: Update contextual thinking state for tool_use messages
  ipcRenderer.on('sdk-message', (event, data) => {
    if (!data || !data.message) {
      console.warn('[SDK] Received malformed sdk-message:', data);
      return;
    }
    const { paneId, message } = data;
    console.log(`[SDK] Message for pane ${paneId}:`, message?.type || 'unknown');

    // UX-8: Update contextual thinking indicator for tool_use
    if (message.type === 'tool_use' || (message.type === 'assistant' && Array.isArray(message.content))) {
      // Check for tool_use blocks in assistant content
      const toolBlocks = Array.isArray(message.content)
        ? message.content.filter(b => b.type === 'tool_use')
        : [];

      if (message.type === 'tool_use') {
        sdkRenderer.updateToolContext(paneId, message);
      } else if (toolBlocks.length > 0) {
        // Use the first tool_use block for context
        sdkRenderer.updateToolContext(paneId, toolBlocks[0]);
      }
    }

    sdkRenderer.appendMessage(paneId, message);
  });

  // SDK streaming indicator - show when agent is thinking
  // FIX: sdk-bridge sends { paneId, active } as single object
  ipcRenderer.on('sdk-streaming', (event, data) => {
    if (!data) return;
    const { paneId, active } = data;
    sdkRenderer.streamingIndicator(paneId, active);
    // Update SDK status based on streaming state
    updateSDKStatus(paneId, active ? 'thinking' : 'idle');
    // STR-4: Finalize streaming message when streaming stops
    if (!active) {
      sdkRenderer.finalizeStreamingMessage(paneId);
    }
  });

  // STR-4: SDK text delta - real-time typewriter streaming from Python
  // Receives partial text chunks for character-by-character display
  ipcRenderer.on('sdk-text-delta', (event, data) => {
    if (!data) return;
    const { paneId, text } = data;
    if (text) {
      sdkRenderer.appendTextDelta(paneId, text);
      // Update status to 'responding' while receiving text
      updateSDKStatus(paneId, 'responding');
    }
  });

  // SDK session started - initialize panes for SDK mode
  ipcRenderer.on('sdk-session-start', (event, data) => {
    console.log('[SDK] Session starting - enabling SDK mode');
    window.hivemind.sdk.enableMode();
    // Update all panes to connected status
    for (let i = 1; i <= 4; i++) {
      updateSDKStatus(i, 'connected');
    }
  });

  // SDK session ended
  ipcRenderer.on('sdk-session-end', (event, data) => {
    console.log('[SDK] Session ended');
    // Update all panes to disconnected status
    for (let i = 1; i <= 4; i++) {
      updateSDKStatus(i, 'disconnected');
    }
  });

  // SDK error handler
  // FIX: sdk-bridge sends { paneId, error } as single object
  ipcRenderer.on('sdk-error', (event, data) => {
    if (!data) return;
    const { paneId, error } = data;
    console.error(`[SDK] Error in pane ${paneId}:`, error);
    sdkRenderer.addErrorMessage(paneId, error);
    updateSDKStatus(paneId, 'error');
  });

  // SDK status change - update UI indicators
  ipcRenderer.on('sdk-status-changed', (event, data) => {
    if (!data) return;
    const { paneId, status, sessionId } = data;
    updateSDKStatus(paneId, status);
    if (sessionId) {
      setSDKSessionId(paneId, sessionId, window.hivemind.settings.isDebugMode());
    }
  });

  // SDK message delivered confirmation
  ipcRenderer.on('sdk-message-delivered', (event, data) => {
    if (!data) return;
    const { paneId } = data;
    showSDKMessageDelivered(paneId);
  });

  // Setup daemon handlers
  daemonHandlers.setupStateListener();
  daemonHandlers.setupClaudeStateListener(daemonHandlers.handleSessionTimerState);
  daemonHandlers.setupCostAlertListener();
  daemonHandlers.setupRefreshButtons(terminal.sendToPane);
  daemonHandlers.setupProjectListener();
  daemonHandlers.setupAutoTriggerListener();  // AT2: Auto-trigger feedback
  daemonHandlers.setupHandoffListener();      // AH2: Handoff notification
  daemonHandlers.setupConflictResolutionListener(); // CR2: Conflict resolution
  daemonHandlers.setupRollbackListener();     // RB2: Rollback UI

  // Setup UI panels
  tabs.setupFrictionPanel();
  settings.setupSettings();
  tabs.setupRightPanel(terminal.handleResize);
  tabs.setupProcessesTab();
  tabs.setupBuildProgressTab();
  tabs.setupHistoryTab();
  tabs.setupProjectsTab();
  tabs.setupPerformanceTab();   // PT2: Performance dashboard
  tabs.setupTemplatesTab();     // TM2: Template management
  tabs.setupActivityTab();      // OB2: Activity log
  tabs.setupTestsTab();         // TR1: Test results panel
  tabs.setupMessagesTab();      // MQ3+MQ6: Messages tab
  tabs.setupCIStatusIndicator(); // CI2: CI status indicator
  tabs.setupMCPStatusIndicator(); // MC7: MCP status indicator

  // Setup daemon listeners (for terminal reconnection)
  // Pass markTerminalsReady callback to fix auto-spawn race condition
  daemonHandlers.setupDaemonListeners(
    terminal.initTerminals,
    terminal.reattachTerminal,
    terminal.setReconnectedToExisting,
    markTerminalsReady
  );

  // Load initial project path
  await daemonHandlers.loadInitialProject();

  // CB1: Load initial agent tasks on startup
  await daemonHandlers.loadInitialAgentTasks();

  // MP2: Setup per-pane project indicators
  daemonHandlers.setupPaneProjectClicks();
  await daemonHandlers.loadPaneProjects();

  // Auto-spawn now handled by checkInitComplete() when both
  // settings are loaded AND terminals are ready (no more race condition)
});
