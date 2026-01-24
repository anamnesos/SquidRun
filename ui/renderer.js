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

// Wire up module callbacks
terminal.setStatusCallbacks(updatePaneStatus, updateConnectionStatus);
tabs.setConnectionStatusCallback(updateConnectionStatus);
settings.setConnectionStatusCallback(updateConnectionStatus);
daemonHandlers.setStatusCallbacks(updateConnectionStatus, updatePaneStatus);

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

  // Broadcast input - only send on explicit user Enter with non-empty content
  const broadcastInput = document.getElementById('broadcastInput');
  let lastBroadcastTime = 0;
  let lastInputChangeTime = 0;
  let lastInputValue = '';
  const AUTOCOMPLETE_GUARD_MS = 150; // Block submit if value changed within this window

  if (broadcastInput) {
    // Track when input value changes (catches autocomplete fills)
    broadcastInput.addEventListener('input', (e) => {
      if (broadcastInput.value !== lastInputValue) {
        lastInputChangeTime = Date.now();
        lastInputValue = broadcastInput.value;
      }
    });

    broadcastInput.addEventListener('keydown', (e) => {
      // DEFENSIVE: Only process real user Enter key presses
      if (e.key === 'Enter' && e.isTrusted && !e.isComposing) {
        e.preventDefault();
        e.stopPropagation();

        const now = Date.now();

        // Rate limit - too fast
        if (now - lastBroadcastTime < 500) {
          console.log('[Broadcast] Rate limited - too fast');
          return;
        }

        // AUTOCOMPLETE GUARD: If value just changed, likely autocomplete fill
        // User pressed Enter to select autocomplete, not to submit
        if (now - lastInputChangeTime < AUTOCOMPLETE_GUARD_MS) {
          console.log('[Broadcast] Blocked - possible autocomplete selection');
          return;
        }

        const value = broadcastInput.value.trim();
        // Don't send empty or whitespace-only messages
        if (value.length > 0) {
          lastBroadcastTime = now;
          terminal.broadcast(value + '\r');
          broadcastInput.value = '';
          lastInputValue = '';
        }
      }
    });
    // Block ALL other submission methods
    broadcastInput.addEventListener('change', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    broadcastInput.addEventListener('submit', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
  }

  // Broadcast button
  const broadcastBtn = document.getElementById('broadcastBtn');
  if (broadcastBtn) {
    broadcastBtn.addEventListener('click', () => {
      const input = document.getElementById('broadcastInput');
      if (input && input.value) {
        terminal.broadcast(input.value + '\r');
        input.value = '';
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

  // Nudge all button - unstick churning agents
  const nudgeAllBtn = document.getElementById('nudgeAllBtn');
  if (nudgeAllBtn) {
    nudgeAllBtn.addEventListener('click', terminal.nudgeAllPanes);
  }

  // Fresh start button - kill all and start new sessions
  const freshStartBtn = document.getElementById('freshStartBtn');
  if (freshStartBtn) {
    freshStartBtn.addEventListener('click', terminal.freshStartAll);
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
  ipcRenderer.on('watchdog-alert', (event, data) => {
    console.log('[Watchdog] Alert received:', data);

    // Show desktop notification
    if (Notification.permission === 'granted') {
      new Notification('Hivemind Alert', {
        body: 'All agents are stuck! Intervention needed.',
        icon: 'assets/icon.png',
        requireInteraction: true
      });
    } else if (Notification.permission !== 'denied') {
      Notification.requestPermission().then(perm => {
        if (perm === 'granted') {
          new Notification('Hivemind Alert', {
            body: 'All agents are stuck! Intervention needed.',
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

    // Show visual alert in status bar
    const statusBar = document.querySelector('.status-bar');
    if (statusBar) {
      const alert = document.createElement('span');
      alert.className = 'watchdog-alert';
      alert.textContent = ' ⚠️ ALL AGENTS STUCK - Click to nudge all';
      alert.style.cssText = 'color: #ff5722; font-weight: bold; cursor: pointer; animation: pulse 1s infinite;';
      alert.onclick = () => {
        terminal.nudgeAllPanes();
        alert.remove();
      };
      statusBar.appendChild(alert);
    }
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
  daemonHandlers.setupDaemonListeners(
    terminal.initTerminals,
    terminal.reattachTerminal,
    terminal.setReconnectedToExisting
  );

  // Load initial project path
  await daemonHandlers.loadInitialProject();

  // CB1: Load initial agent tasks on startup
  await daemonHandlers.loadInitialAgentTasks();

  // MP2: Setup per-pane project indicators
  daemonHandlers.setupPaneProjectClicks();
  await daemonHandlers.loadPaneProjects();

  // Check auto-spawn after terminals are ready
  setTimeout(() => {
    settings.checkAutoSpawn(
      terminal.spawnAllClaude,
      terminal.getReconnectedToExisting()
    );
  }, 1000);
});
