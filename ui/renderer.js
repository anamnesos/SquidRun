/**
 * Hivemind Renderer - Main entry point
 * Orchestrates terminal, tabs, settings, and daemon handler modules
 */

const { ipcRenderer } = require('electron');
const log = require('./modules/logger');

// Import modules
const terminal = require('./modules/terminal');
const tabs = require('./modules/tabs');
const settings = require('./modules/settings');
const daemonHandlers = require('./modules/daemon-handlers');
const sdkRenderer = require('./modules/sdk-renderer');
const { showStatusNotice } = require('./modules/notifications');
const { formatTimeSince } = require('./modules/formatters');
const {
  BUTTON_DEBOUNCE_MS,
  SPINNER_INTERVAL_MS,
  UI_IDLE_THRESHOLD_MS,
  UI_STUCK_THRESHOLD_MS,
  UI_IDLE_CLAIM_THRESHOLD_MS,
} = require('./modules/constants');

// Button debounce utility - prevents rapid double-clicks
const buttonDebounceState = {};

function debounceButton(buttonId, handler) {
  return function(...args) {
    const now = Date.now();
    const lastClick = buttonDebounceState[buttonId] || 0;
    if (now - lastClick < BUTTON_DEBOUNCE_MS) {
      log.info('UI', `Debounced rapid click on ${buttonId}`);
      return;
    }
    buttonDebounceState[buttonId] = now;
    return handler.apply(this, args);
  };
}

// SDK mode flag - when true, use SDK renderer instead of xterm terminals
let sdkMode = false;

// Centralized SDK mode setter - ensures renderer-process flags stay in sync
// Renderer flags: renderer.sdkMode, daemonHandlers.sdkModeEnabled, terminal.sdkModeActive, settings.sdkMode
// Note: triggers.js runs in main process and is synced via IPC in main.js when settings change
function setSDKMode(enabled, options = {}) {
  const { persist = true, source = 'renderer' } = options;
  const nextValue = !!enabled;

  sdkMode = nextValue;
  daemonHandlers.setSDKMode(nextValue);
  terminal.setSDKMode(nextValue);

  const currentSettings = typeof settings.getSettings === 'function' ? settings.getSettings() : null;
  const hasSettings = currentSettings && typeof currentSettings === 'object';
  const settingsValue = hasSettings ? !!currentSettings.sdkMode : undefined;
  const needsSettingsUpdate = settingsValue !== nextValue;

  if (hasSettings && needsSettingsUpdate) {
    currentSettings.sdkMode = nextValue;
    if (typeof settings.applySettingsToUI === 'function') {
      settings.applySettingsToUI();
    }
  }

  if (persist && (!hasSettings || needsSettingsUpdate)) {
    ipcRenderer.invoke('set-setting', 'sdkMode', nextValue)
      .then((updated) => {
        if (hasSettings && updated && typeof updated === 'object' && updated !== currentSettings) {
          Object.assign(currentSettings, updated);
        }
        if (typeof settings.applySettingsToUI === 'function') {
          settings.applySettingsToUI();
        }
        log.info('SDK', `SDK mode persisted to ${nextValue} (${source})`);
      })
      .catch((err) => {
        log.error('SDK', `Failed to persist SDK mode (${source})`, err);
      });
  } else {
    log.info('SDK', `SDK mode set to ${nextValue} (${source})`);
  }
}

const SDK_PANE_LABELS = {
  '1': { name: 'Architect', avatar: '[A]' },
  '2': { name: 'Infra', avatar: '[I]' },
  '3': { name: 'Frontend', avatar: '[F]' },
  '4': { name: 'Backend', avatar: '[B]' },
  '5': { name: 'Analyst', avatar: '[?]' },
  '6': { name: 'Reviewer', avatar: '[R]' }
};

const MAIN_PANE_CONTAINER_SELECTOR = '.main-pane-container';
const SIDE_PANES_CONTAINER_SELECTOR = '.side-panes-container';
let mainPaneId = '1';

function getPaneElement(paneId) {
  return document.querySelector(`.pane[data-pane-id="${paneId}"]`);
}

function updateMainPaneState(paneId) {
  mainPaneId = String(paneId);
  if (document.body) {
    document.body.dataset.mainPaneId = mainPaneId;
  }
  document.querySelectorAll('.pane').forEach((pane) => {
    pane.dataset.main = pane.dataset.paneId === mainPaneId ? 'true' : 'false';
  });
}

function getMainPaneId() {
  return mainPaneId;
}

function swapToMainPane(targetPaneId) {
  const targetId = String(targetPaneId);
  if (!targetId || targetId === mainPaneId) {
    terminal.focusPane(targetId || mainPaneId);
    return;
  }

  const mainContainer = document.querySelector(MAIN_PANE_CONTAINER_SELECTOR);
  const sideContainer = document.querySelector(SIDE_PANES_CONTAINER_SELECTOR);
  const targetPane = getPaneElement(targetId);
  const currentMainPane = getPaneElement(mainPaneId);

  if (!mainContainer || !sideContainer || !targetPane || !currentMainPane) {
    log.warn('PaneSwap', 'Swap aborted - missing pane containers or elements');
    return;
  }

  if (targetPane.parentElement !== sideContainer) {
    terminal.focusPane(targetId);
    return;
  }

  const targetNextSibling = targetPane.nextSibling;

  mainContainer.appendChild(targetPane);
  if (targetNextSibling) {
    sideContainer.insertBefore(currentMainPane, targetNextSibling);
  } else {
    sideContainer.appendChild(currentMainPane);
  }

  updateMainPaneState(targetId);
  terminal.focusPane(targetId);

  requestAnimationFrame(() => {
    terminal.handleResize();
    setTimeout(() => terminal.handleResize(), 50);
  });
}

function initMainPaneState() {
  const mainContainer = document.querySelector(MAIN_PANE_CONTAINER_SELECTOR);
  const mainPane = mainContainer ? mainContainer.querySelector('.pane') : null;
  const paneId = mainPane?.dataset?.paneId || '1';
  updateMainPaneState(paneId);
}

// Initialization state tracking - fixes race condition in auto-spawn
let initState = {
  settingsLoaded: false,
  terminalsReady: false,
  autoSpawnChecked: false
};

function checkInitComplete() {
  if (initState.settingsLoaded && initState.terminalsReady && !initState.autoSpawnChecked) {
    initState.autoSpawnChecked = true;
    log.info('Init', 'Both settings and terminals ready, checking auto-spawn...');
    settings.checkAutoSpawn(
      terminal.spawnAllClaude,
      terminal.getReconnectedToExisting()
    );
  }
}

function markSettingsLoaded() {
  initState.settingsLoaded = true;
  log.info('Init', 'Settings loaded');

  // SDK Mode: Set SDK mode flags in all relevant modules (centralized)
  const currentSettings = settings.getSettings();
  const sdkEnabled = !!currentSettings?.sdkMode;
  log.info('Init', `SDK mode in settings: ${sdkEnabled}`);
  setSDKMode(sdkEnabled, { persist: false, source: 'settings-loaded' });

  checkInitComplete();
}

function markTerminalsReady(isSDKMode = false) {
  initState.terminalsReady = true;
  log.info('Init', `Terminals ready, SDK mode: ${isSDKMode}`);

  // SDK Mode: Initialize SDK panes and start sessions
  if (isSDKMode) {
    log.info('Init', 'Initializing SDK mode...');
    setSDKMode(true, { persist: false, source: 'daemon-ready' });  // Centralized - sets all 4 SDK mode flags
    sdkRenderer.setSDKPaneConfig();
    applySDKPaneLayout();
    sdkRenderer.initAllSDKPanes();

    // Auto-start SDK sessions (get workspace path via IPC)
    log.info('Init', 'Auto-starting SDK sessions...');
    ipcRenderer.invoke('get-project')
      .then(projectPath => {
        return ipcRenderer.invoke('sdk-start-sessions', { workspace: projectPath || undefined });
      })
      .then(() => {
        log.info('Init', 'SDK sessions started');
        updateConnectionStatus('SDK Mode - agents starting...');
      })
      .catch(err => {
        log.error('Init', 'Failed to start SDK sessions:', err);
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
    codexExec: (paneId, prompt) => ipcRenderer.invoke('codex-exec', paneId, prompt),
    sendTrustedEnter: () => ipcRenderer.invoke('send-trusted-enter'),
    clipboardPasteText: (text) => ipcRenderer.invoke('clipboard-paste-text', text),
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
        log.info('SDK', 'Mode already enabled, skipping reinit');
        return;
      }
      setSDKMode(true, { source: 'sdk-enable' });  // Centralized - sets all 4 SDK mode flags
      sdkRenderer.setSDKPaneConfig();
      applySDKPaneLayout();
      sdkRenderer.initAllSDKPanes();
      log.info('SDK', 'Mode enabled');
    },
    disableMode: () => {
      setSDKMode(false, { source: 'sdk-disable' });  // Centralized - clears all 4 SDK mode flags
      log.info('SDK', 'Mode disabled');
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
    // Update text (preserve spinner if working)
    const spinnerEl = statusEl.querySelector('.pane-spinner');
    if (spinnerEl) {
      statusEl.innerHTML = '';
      statusEl.appendChild(spinnerEl);
      statusEl.appendChild(document.createTextNode(status));
    } else {
      statusEl.textContent = status;
    }

    // Toggle CSS classes based on status
    statusEl.classList.remove('idle', 'starting', 'running', 'working');
    const statusLower = status.toLowerCase();
    if (statusLower === 'ready' || statusLower === 'idle' || statusLower === 'stopped') {
      statusEl.classList.add('idle');
    } else if (statusLower === 'starting' || statusLower === 'spawning') {
      statusEl.classList.add('starting');
    } else if (statusLower === 'working' || statusLower === 'processing') {
      statusEl.classList.add('working');
    } else if (statusLower === 'running' || statusLower.includes('running')) {
      statusEl.classList.add('running');
    }
  }
}

function updateConnectionStatus(status) {
  const statusEl = document.getElementById('connectionStatus');
  if (statusEl) {
    statusEl.textContent = status;
  }
}

// Agent Health Dashboard (#1) - update health indicators per pane
// Constants imported from modules/constants.js: UI_UI_STUCK_THRESHOLD_MS, UI_UI_IDLE_CLAIM_THRESHOLD_MS

// Smart Parallelism Phase 3 - Domain ownership mapping
const PANE_DOMAIN_MAP = {
  '1': 'architecture',  // Architect
  '2': 'infra',         // Infra
  '3': 'frontend',      // Frontend
  '4': 'backend',       // Backend
  '5': 'analysis',      // Analyst
  '6': null             // Reviewer - no self-claim domain
};

// Track available claimable tasks per domain (updated via IPC)
let claimableTasksCache = {
  tasks: [],
  lastUpdated: 0
};

// Check if there are claimable tasks for a given pane's domain
function hasClaimableTasks(paneId) {
  const domain = PANE_DOMAIN_MAP[paneId];
  if (!domain) return false; // Reviewer can't self-claim

  return claimableTasksCache.tasks.some(task =>
    task.status === 'open' &&
    !task.owner &&
    task.metadata?.domain === domain &&
    (!task.blockedBy || task.blockedBy.length === 0)
  );
}

// Get claimable tasks for a pane's domain
function getClaimableTasksForPane(paneId) {
  const domain = PANE_DOMAIN_MAP[paneId];
  if (!domain) return [];

  return claimableTasksCache.tasks.filter(task =>
    task.status === 'open' &&
    !task.owner &&
    task.metadata?.domain === domain &&
    (!task.blockedBy || task.blockedBy.length === 0)
  );
}

// formatTimeSince now imported from ./modules/formatters

function updateHealthIndicators() {
  const lastOutputTime = terminal.lastOutputTime || {};
  const paneIds = ['1', '2', '3', '4', '5', '6'];

  paneIds.forEach(paneId => {
    const healthEl = document.getElementById(`health-${paneId}`);
    const stuckEl = document.getElementById(`stuck-${paneId}`);
    const idleEl = document.getElementById(`idle-${paneId}`);
    const claimBtn = document.querySelector(`.claim-btn[data-pane-id="${paneId}"]`);
    const lastOutput = lastOutputTime[paneId];

    if (healthEl) {
      const timeStr = formatTimeSince(lastOutput);
      healthEl.textContent = timeStr;

      // Color coding based on recency
      healthEl.classList.remove('recent', 'active', 'stale');
      if (!lastOutput) {
        healthEl.classList.add('active');
      } else {
        const age = Date.now() - lastOutput;
        if (age < 5000) {
          healthEl.classList.add('recent'); // Green - very recent
        } else if (age < 30000) {
          healthEl.classList.add('active'); // Gray - recent
        } else {
          healthEl.classList.add('stale'); // Yellow - getting stale
        }
      }
    }

    if (stuckEl) {
      const isStuck = lastOutput && (Date.now() - lastOutput) > UI_STUCK_THRESHOLD_MS;
      stuckEl.classList.toggle('visible', isStuck);
    }

    // Smart Parallelism - Idle detection with claimable tasks
    const isIdle = lastOutput && (Date.now() - lastOutput) > UI_IDLE_CLAIM_THRESHOLD_MS;
    const hasTasksToClaim = hasClaimableTasks(paneId);
    const showIdleIndicator = isIdle && hasTasksToClaim;

    if (idleEl) {
      idleEl.classList.toggle('visible', showIdleIndicator);
      if (showIdleIndicator) {
        const tasks = getClaimableTasksForPane(paneId);
        idleEl.title = `${tasks.length} task${tasks.length !== 1 ? 's' : ''} available to claim`;
      }
    }

    if (claimBtn) {
      claimBtn.classList.toggle('visible', showIdleIndicator);
    }
  });
}

// ============================================================
// STATUS STRIP - Task status overview
// ============================================================

// Session start time for duration tracking
let sessionStartTime = Date.now();

// Cached task pool data
let cachedTaskPool = { tasks: [] };

// Update session timer display
function updateSessionTimer() {
  const timerEl = document.getElementById('sessionTimer');
  if (!timerEl) return;

  const elapsed = Date.now() - sessionStartTime;
  const hours = Math.floor(elapsed / 3600000);
  const minutes = Math.floor((elapsed % 3600000) / 60000);

  if (hours > 0) {
    timerEl.textContent = `Session: ${hours}h ${minutes}m`;
  } else {
    timerEl.textContent = `Session: ${minutes}m`;
  }
}

// Fetch task pool via IPC (uses existing get-task-list handler)
async function fetchTaskPool() {
  try {
    const tasks = await ipcRenderer.invoke('get-task-list');
    if (Array.isArray(tasks)) {
      cachedTaskPool = { tasks };
    }
  } catch (err) {
    log.error('StatusStrip', 'Failed to fetch task pool:', err);
  }
  return cachedTaskPool;
}

// Count tasks by status
function countTasksByStatus(tasks) {
  const counts = {
    completed: 0,
    in_progress: 0,
    waiting: 0,
    failed: 0
  };

  tasks.forEach(task => {
    const status = task.status || 'open';

    if (status === 'completed') {
      counts.completed++;
    } else if (status === 'in_progress') {
      counts.in_progress++;
    } else if (status === 'failed') {
      counts.failed++;
    } else if (status === 'needs_input') {
      counts.waiting++;
    } else if (task.blockedBy && task.blockedBy.length > 0) {
      // Check if blockers are still open
      const hasUnresolvedBlocker = task.blockedBy.some(blockerId => {
        const blocker = tasks.find(t => t.id === blockerId);
        return blocker && blocker.status !== 'completed';
      });
      if (hasUnresolvedBlocker) {
        counts.waiting++;
      }
    }
  });

  return counts;
}

// Get tasks filtered by status for dropdown display
function getTasksByStatus(tasks, statusFilter) {
  return tasks.filter(task => {
    const status = task.status || 'open';

    if (statusFilter === 'completed') {
      return status === 'completed';
    } else if (statusFilter === 'in_progress') {
      return status === 'in_progress';
    } else if (statusFilter === 'failed') {
      return status === 'failed';
    } else if (statusFilter === 'waiting') {
      if (status === 'needs_input') return true;
      if (task.blockedBy && task.blockedBy.length > 0) {
        const hasUnresolvedBlocker = task.blockedBy.some(blockerId => {
          const blocker = tasks.find(t => t.id === blockerId);
          return blocker && blocker.status !== 'completed';
        });
        return hasUnresolvedBlocker;
      }
      return false;
    }
    return false;
  });
}

// Render dropdown list for a status segment
function renderDropdownList(listEl, tasks, statusType) {
  if (!listEl) return;

  if (tasks.length === 0) {
    listEl.innerHTML = '<div class="status-dropdown-empty">None</div>';
    return;
  }

  listEl.innerHTML = tasks.map(task => {
    let meta = '';
    if (statusType === 'waiting' && task.status === 'needs_input') {
      meta = 'Needs human input';
    } else if (statusType === 'waiting' && task.blockedBy) {
      meta = `Blocked by: ${task.blockedBy.join(', ')}`;
    } else if (statusType === 'failed' && task.metadata?.error) {
      meta = task.metadata.error.message || 'Error';
    } else if (task.owner) {
      meta = `Owner: ${task.owner}`;
    }

    return `
      <div class="status-dropdown-item">
        <div class="status-dropdown-item-title">${task.subject || task.id}</div>
        ${meta ? `<div class="status-dropdown-item-meta">${meta}</div>` : ''}
      </div>
    `;
  }).join('');
}

// Update status strip UI with current task counts
function updateStatusStrip() {
  const tasks = cachedTaskPool.tasks || [];
  const counts = countTasksByStatus(tasks);

  // Update counts
  const updateSegment = (id, count, statusType) => {
    const countEl = document.getElementById(`count${id}`);
    const segmentEl = document.getElementById(`status${id}`);
    const listEl = document.getElementById(`list${id}`);

    if (countEl) countEl.textContent = count;
    if (segmentEl) {
      segmentEl.classList.toggle('zero', count === 0);
    }

    // Update dropdown list
    const filteredTasks = getTasksByStatus(tasks, statusType);
    renderDropdownList(listEl, filteredTasks, statusType);
  };

  updateSegment('Done', counts.completed, 'completed');
  updateSegment('Running', counts.in_progress, 'in_progress');
  updateSegment('Waiting', counts.waiting, 'waiting');
  updateSegment('Failed', counts.failed, 'failed');
}

// Initialize status strip event handlers
function initStatusStrip() {
  const segments = document.querySelectorAll('.status-segment');

  segments.forEach(segment => {
    // Toggle dropdown on click
    segment.addEventListener('click', (e) => {
      // Close other dropdowns
      segments.forEach(s => {
        if (s !== segment) s.classList.remove('open');
      });

      // Toggle this dropdown
      segment.classList.toggle('open');
      e.stopPropagation();
    });
  });

  // Close dropdowns when clicking outside
  document.addEventListener('click', () => {
    segments.forEach(s => s.classList.remove('open'));
  });

  // Initial fetch and update
  fetchTaskPool().then(() => updateStatusStrip());

  // Poll every 5 seconds as backup
  setInterval(async () => {
    await fetchTaskPool();
    updateStatusStrip();
  }, 5000);

  // Listen for immediate task updates from main process
  ipcRenderer.on('task-list-updated', (event, data) => {
    if (data && Array.isArray(data.tasks)) {
      cachedTaskPool = { tasks: data.tasks };
      updateStatusStrip();
    }
  });

  // Update session timer every minute
  updateSessionTimer();
  setInterval(updateSessionTimer, 60000);

  log.info('StatusStrip', 'Initialized');
}

function applySDKPaneLayout() {
  const sdkPaneIds = Object.keys(SDK_PANE_LABELS);

  sdkPaneIds.forEach((paneId) => {
    const pane = document.querySelector(`.pane[data-pane-id="${paneId}"]`);
    if (!pane) return;
    pane.style.display = '';

    const titleEl = pane.querySelector('.pane-title');
    if (!titleEl) return;

    const avatarEl = titleEl.querySelector('.agent-avatar');
    if (avatarEl) {
      avatarEl.textContent = SDK_PANE_LABELS[paneId].avatar;
    }

    let roleTextNode = null;
    for (const node of titleEl.childNodes) {
      if (node.nodeType === Node.TEXT_NODE && node.textContent.trim().length > 0) {
        roleTextNode = node;
        break;
      }
    }

    if (!roleTextNode) {
      const projectEl = titleEl.querySelector('.pane-project');
      const nameNode = document.createTextNode(SDK_PANE_LABELS[paneId].name);
      if (projectEl) {
        titleEl.insertBefore(nameNode, projectEl);
      } else {
        titleEl.appendChild(nameNode);
      }
    } else {
      roleTextNode.textContent = SDK_PANE_LABELS[paneId].name;
    }
  });

  // Placeholder is now set dynamically by updateCommandPlaceholder() based on target selector
  // Initial call happens in DOMContentLoaded event handler
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
// SPINNER_INTERVAL_MS imported from modules/constants.js

// Header spinner animation intervals per pane
const headerSpinnerIntervals = new Map();
const headerSpinnerFrameIndex = new Map();

// Idle state tracking per pane
const paneIdleState = new Map();
// UI_UI_IDLE_THRESHOLD_MS imported from modules/constants.js

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
      timerId: setTimeout(() => enterIdleState(paneId), UI_IDLE_THRESHOLD_MS)
    });
  }
}

/**
 * Enter idle state for a pane (called after UI_IDLE_THRESHOLD_MS of inactivity)
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
    }, SPINNER_INTERVAL_MS);

    headerSpinnerIntervals.set(paneId, interval);
  } else {
    statusEl.textContent = SDK_STATUS_LABELS[state] || state;
  }

  log.info('SDK', `Pane ${paneId} status: ${state}`);
}

function showSDKMessageDelivered(paneId) {
  const statusEl = document.getElementById(`sdk-status-${paneId}`);
  if (!statusEl) return;

  // Trigger delivered animation
  statusEl.classList.add('delivered');
  setTimeout(() => {
    statusEl.classList.remove('delivered');
  }, 600);

  // Also show delivery indicator in pane header (using daemon-handlers version)
  daemonHandlers.showDeliveryIndicator(paneId, 'delivered');

  log.info('SDK', `Pane ${paneId} message delivered`);
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
    // Ctrl+1-6 to focus panes
    if (e.ctrlKey && e.key >= '1' && e.key <= '6') {
      e.preventDefault();
      terminal.focusPane(e.key);
    }
  });

  // Command bar input - Enter re-enabled (ghost text fix is in xterm, not here)
  const broadcastInput = document.getElementById('broadcastInput');
  const commandTarget = document.getElementById('commandTarget');
  const commandDeliveryStatus = document.getElementById('commandDeliveryStatus');
  const voiceInputBtn = document.getElementById('voiceInputBtn');
  const voiceStatus = document.getElementById('voiceStatus');
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null;
  let voiceEnabled = false;
  let voiceAutoSend = false;
  let voiceLanguage = 'en-US';
  let voiceListening = false;
  let voiceBase = '';
  let voiceSentFinal = false;
  let lastBroadcastTime = 0;

  // Update placeholder based on selected target
  function updateCommandPlaceholder() {
    if (!broadcastInput || !commandTarget) return;
    const target = commandTarget.value;
    const targetName = commandTarget.options[commandTarget.selectedIndex]?.text || 'Architect';
    if (target === 'auto') {
      broadcastInput.placeholder = 'Describe a task to auto-route (Enter to send)';
      broadcastInput.title = 'Auto-route a task based on description';
    } else if (target === 'all') {
      broadcastInput.placeholder = 'Type here to message all agents (Enter to send)';
      broadcastInput.title = 'Send message to all agents';
    } else {
      broadcastInput.placeholder = `Type here to message ${targetName} (Enter to send)`;
      broadcastInput.title = `Send message to ${targetName}`;
    }
  }

  // showStatusNotice now imported from ./modules/notifications

  function updateVoiceUI(statusText) {
    if (voiceInputBtn) {
      voiceInputBtn.disabled = !voiceEnabled || !SpeechRecognition;
      voiceInputBtn.classList.toggle('is-listening', voiceListening);
      voiceInputBtn.setAttribute('aria-pressed', voiceListening ? 'true' : 'false');
    }
    if (broadcastInput) {
      broadcastInput.classList.toggle('voice-listening', voiceListening);
    }
    if (voiceStatus) {
      voiceStatus.textContent = statusText;
      voiceStatus.classList.toggle('is-listening', voiceListening);
    }
  }

  function stopVoiceRecognition() {
    if (recognition && voiceListening) {
      recognition.stop();
    }
  }

  function ensureRecognition() {
    if (!SpeechRecognition || recognition) return;
    recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      voiceListening = true;
      voiceBase = (broadcastInput?.value || '').trim();
      if (voiceBase) {
        voiceBase += ' ';
      }
      voiceSentFinal = false;
      updateVoiceUI(voiceAutoSend ? 'Listening (auto-send)' : 'Listening');
    };

    recognition.onresult = (event) => {
      let interimTranscript = '';
      let finalTranscript = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (result.isFinal) {
          finalTranscript += result[0].transcript;
        } else {
          interimTranscript += result[0].transcript;
        }
      }

      const combined = `${voiceBase}${finalTranscript}${interimTranscript}`.trim();
      if (broadcastInput) {
        broadcastInput.value = combined;
      }

      if (finalTranscript && voiceAutoSend && combined) {
        if (sendBroadcast(combined)) {
          voiceSentFinal = true;
          if (broadcastInput) {
            broadcastInput.value = '';
          }
        }
      }
    };

    recognition.onerror = (event) => {
      const errorType = event?.error || 'unknown';
      log.error('Voice', 'Speech recognition error', errorType);
      voiceListening = false;

      if (errorType === 'network') {
        // Electron/Chromium limitation - Google Speech API not available
        updateVoiceUI('Unavailable in Electron');
        showStatusNotice('Voice input requires Chrome browser or local speech support (coming soon)', 10000);
      } else if (errorType === 'not-allowed') {
        updateVoiceUI('Mic blocked');
        showStatusNotice('Microphone access denied. Check browser permissions.', 8000);
      } else if (errorType === 'no-speech') {
        updateVoiceUI('No speech detected');
      } else {
        updateVoiceUI('Voice error');
      }
    };

    recognition.onend = () => {
      voiceListening = false;
      if (!voiceEnabled) {
        updateVoiceUI('Voice off');
      } else if (voiceSentFinal && voiceAutoSend) {
        updateVoiceUI('Voice ready');
      } else {
        updateVoiceUI('Voice ready');
      }
    };
  }

  function startVoiceRecognition() {
    if (!SpeechRecognition) {
      updateVoiceUI('Voice unsupported');
      return;
    }
    if (!voiceEnabled) {
      updateVoiceUI('Voice off');
      return;
    }
    ensureRecognition();
    if (!recognition) return;
    recognition.lang = voiceLanguage || 'en-US';
    try {
      recognition.start();
    } catch (err) {
      log.error('Voice', 'Failed to start recognition', err);
      updateVoiceUI('Voice error');
    }
  }

  function refreshVoiceSettings(nextSettings) {
    const source = nextSettings || settings.getSettings() || {};
    voiceEnabled = !!source.voiceInputEnabled;
    voiceAutoSend = !!source.voiceAutoSend;
    voiceLanguage = source.voiceLanguage || 'en-US';
    if (!SpeechRecognition) {
      updateVoiceUI('Voice unsupported');
      if (voiceInputBtn) {
        voiceInputBtn.disabled = true;
      }
      return;
    }
    if (!voiceEnabled) {
      stopVoiceRecognition();
      updateVoiceUI('Voice off');
      return;
    }
    updateVoiceUI('Voice ready');
  }

  async function routeNaturalTask(message) {
    try {
      const result = await ipcRenderer.invoke('route-task-input', message);
      if (result?.success) {
        const routedCount = result.routed?.length || 0;
        showStatusNotice(`Auto-routed ${routedCount} task${routedCount === 1 ? '' : 's'}`);
        showDeliveryStatus('delivered');
        return true;
      }
      if (result?.ambiguity?.isAmbiguous) {
        showDeliveryStatus('failed');
        const questions = result.ambiguity.questions?.join(' ') || 'Clarification needed.';
        showStatusNotice(`Clarify: ${questions}`, 9000);
        return false;
      }
      showDeliveryStatus('failed');
      showStatusNotice('Auto-route failed. Check task description.', 7000);
      return false;
    } catch (err) {
      log.error('AutoRoute', 'Failed to route task:', err);
      showDeliveryStatus('failed');
      showStatusNotice('Auto-route error. See logs.', 7000);
      return false;
    }
  }

  // Show delivery status indicator
  function showDeliveryStatus(status) {
    if (!commandDeliveryStatus) return;
    commandDeliveryStatus.className = 'command-delivery-status visible ' + status;
    if (status === 'sending') {
      commandDeliveryStatus.textContent = '⏳';
    } else if (status === 'delivered') {
      commandDeliveryStatus.textContent = '✓';
      setTimeout(() => {
        commandDeliveryStatus.classList.remove('visible');
      }, 2000);
    } else if (status === 'failed') {
      commandDeliveryStatus.textContent = '✕';
      setTimeout(() => {
        commandDeliveryStatus.classList.remove('visible');
      }, 3000);
    }
  }

  // Target selector change event
  if (commandTarget) {
    commandTarget.addEventListener('change', updateCommandPlaceholder);
    updateCommandPlaceholder(); // Set initial placeholder
  }

  // Helper function to send broadcast - routes through SDK or PTY based on mode
  // Supports pane targeting via dropdown or /1-6 prefix
  function sendBroadcast(message) {
    const now = Date.now();
    if (now - lastBroadcastTime < 500) {
      log.info('Broadcast', 'Rate limited');
      return false;
    }
    lastBroadcastTime = now;

    // Show sending status
    showDeliveryStatus('sending');

    const trimmed = message.trim();
    if (trimmed.toLowerCase().startsWith('/task ')) {
      return routeNaturalTask(trimmed.slice(6));
    }

    if (commandTarget && commandTarget.value === 'auto') {
      return routeNaturalTask(trimmed);
    }

    // Check SDK mode from settings
    const currentSettings = settings.getSettings();
    if (currentSettings.sdkMode || sdkMode) {
      // Check for pane targeting prefix: /1-6 or /architect, /orchestrator, etc.
      // /all broadcasts to all agents
      const paneMatch = message.match(/^\/([1-6]|all|lead|architect|orchestrator|worker-?a|worker-?b|implementer-?a|implementer-?b|investigator|reviewer)\s+/i);

      // Determine target: explicit prefix > dropdown selector > default (1)
      let targetPaneId = '1';
      let actualMessage = message;

      if (paneMatch) {
        // Explicit prefix takes precedence
        const target = paneMatch[1].toLowerCase();
        actualMessage = message.slice(paneMatch[0].length);
        if (target === 'all') {
          targetPaneId = 'all';
        } else {
          const paneMap = {
            '1': '1', '2': '2', '3': '3', '4': '4', '5': '5', '6': '6',
            'lead': '1', 'architect': '1', 'orchestrator': '2',
            'worker-a': '3', 'workera': '3', 'implementer-a': '3', 'implementera': '3',
            'worker-b': '4', 'workerb': '4', 'implementer-b': '4', 'implementerb': '4',
            'investigator': '5', 'reviewer': '6'
          };
          targetPaneId = paneMap[target] || '1';
        }
      } else if (commandTarget) {
        // Use dropdown selector value
        targetPaneId = commandTarget.value;
      }

      // Send to target(s)
      if (targetPaneId === 'all') {
        log.info('SDK', 'Broadcast to ALL agents');
        ['1', '2', '3', '4', '5', '6'].forEach(paneId => {
          sdkRenderer.appendMessage(paneId, { type: 'user', content: actualMessage });
        });
        ipcRenderer.invoke('sdk-broadcast', actualMessage)
          .then(() => showDeliveryStatus('delivered'))
          .catch(err => {
            log.error('SDK', 'Broadcast failed:', err);
            showDeliveryStatus('failed');
          });
      } else {
        log.info('SDK', `Targeted send to pane ${targetPaneId}: ${actualMessage.substring(0, 30)}...`);
        sdkRenderer.appendMessage(targetPaneId, { type: 'user', content: actualMessage });
        ipcRenderer.invoke('sdk-send-message', targetPaneId, actualMessage)
          .then(() => showDeliveryStatus('delivered'))
          .catch(err => {
            log.error('SDK', `Send to pane ${targetPaneId} failed:`, err);
            showDeliveryStatus('failed');
          });
      }
    } else {
      // PTY mode - use terminal broadcast with target from dropdown
      const targetPaneId = commandTarget ? commandTarget.value : 'all';
      log.info('Broadcast', `Using PTY mode, target: ${targetPaneId}`);
      if (targetPaneId === 'all') {
        terminal.broadcast(message + '\r');
      } else {
        // Send to specific pane in PTY mode
        terminal.sendToPane(targetPaneId, message + '\r');
      }
      showDeliveryStatus('delivered');
    }
    return true;
  }

  if (broadcastInput) {
    broadcastInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        // Only allow trusted (real user) Enter presses
        if (!e.isTrusted) {
          e.preventDefault();
          log.info('Broadcast', 'Blocked untrusted Enter');
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
        log.info('Broadcast', 'Blocked untrusted click');
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

  if (voiceInputBtn) {
    voiceInputBtn.addEventListener('click', (e) => {
      if (!e.isTrusted) {
        log.info('Voice', 'Blocked untrusted click');
        return;
      }
      if (!voiceEnabled) {
        updateVoiceUI('Enable in settings');
        return;
      }
      if (voiceListening) {
        stopVoiceRecognition();
      } else {
        startVoiceRecognition();
      }
    });
  }

  window.addEventListener('hivemind-settings-updated', (event) => {
    refreshVoiceSettings(event.detail);
  });
  refreshVoiceSettings(settings.getSettings());

  // Spawn all button (debounced)
  const spawnAllBtn = document.getElementById('spawnAllBtn');
  if (spawnAllBtn) {
    spawnAllBtn.addEventListener('click', debounceButton('spawnAll', terminal.spawnAllClaude));
  }

  // Kill all button (debounced)
  const killAllBtn = document.getElementById('killAllBtn');
  if (killAllBtn) {
    killAllBtn.addEventListener('click', debounceButton('killAll', terminal.killAllTerminals));
  }

  // Nudge all button - unstick churning agents (uses aggressive ESC+Enter) (debounced)
  const nudgeAllBtn = document.getElementById('nudgeAllBtn');
  if (nudgeAllBtn) {
    nudgeAllBtn.addEventListener('click', debounceButton('nudgeAll', terminal.aggressiveNudgeAll));
  }

  // Agent Health Dashboard (#1) - interrupt and unstick buttons per pane
  document.querySelectorAll('.interrupt-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const paneId = btn.dataset.paneId;
      if (paneId) {
        log.info('Health', `Sending Ctrl+C to pane ${paneId}`);
        const ok = await terminal.interruptPane(paneId);
        terminal.updatePaneStatus(paneId, ok ? 'Interrupted' : 'Interrupt failed');
        setTimeout(() => terminal.updatePaneStatus(paneId, 'Running'), 1500);
      }
    });
  });

  document.querySelectorAll('.unstick-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const paneId = btn.dataset.paneId;
      if (paneId) {
        log.info('Health', `Unstick escalation for pane ${paneId}`);
        terminal.unstickEscalation(paneId);
      }
    });
  });

  // Per-pane Respawn+Kickoff button - kill and restart agent with startup prompt
  document.querySelectorAll('.kickoff-btn').forEach(btn => {
    btn.addEventListener('click', debounceButton(`kickoff-${btn.dataset.paneId}`, async () => {
      const paneId = btn.dataset.paneId;
      if (!paneId) return;

      log.info('Kickoff', `Respawn+Kickoff for pane ${paneId}`);
      // restartPane handles: kill → wait → reset identity → spawn (with identity injection)
      const success = await terminal.restartPane(paneId);
      if (!success) {
        log.warn('Kickoff', `Restart returned false for pane ${paneId}`);
      }
    }));
  });

  // Smart Parallelism - Claim task button click handlers
  document.querySelectorAll('.claim-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const paneId = btn.dataset.paneId;
      if (!paneId) return;

      const tasks = getClaimableTasksForPane(paneId);
      if (tasks.length === 0) {
        log.info('Claim', `No claimable tasks for pane ${paneId}`);
        return;
      }

      // Claim first available task
      const task = tasks[0];
      log.info('Claim', `Pane ${paneId} claiming task: ${task.subject}`);

      // Visual feedback
      btn.classList.add('claiming');
      setTimeout(() => btn.classList.remove('claiming'), 500);

      try {
        // Claim via IPC - main process handles the actual claim
        const result = await ipcRenderer.invoke('claim-task', {
          paneId,
          taskId: task.id,
          domain: PANE_DOMAIN_MAP[paneId]
        });

        if (result.success) {
          log.info('Claim', `Task ${task.id} claimed successfully`);
          // Notify agent via terminal injection
          const claimMessage = `[TASK CLAIMED] Task #${task.id}: ${task.subject}`;
          terminal.sendToPane(paneId, claimMessage + '\r');
        } else {
          log.warn('Claim', `Failed to claim task: ${result.error}`);
        }
      } catch (err) {
        log.error('Claim', 'Claim failed:', err);
      }
    });
  });

  // Fresh start button - kill all and start new sessions (debounced)
  const freshStartBtn = document.getElementById('freshStartBtn');
  if (freshStartBtn) {
    freshStartBtn.addEventListener('click', debounceButton('freshStart', terminal.freshStartAll));
  }

  // Full restart button - kill daemon and reload app with fresh code
  const fullRestartBtn = document.getElementById('fullRestartBtn');
  if (fullRestartBtn) {
    fullRestartBtn.addEventListener('click', async () => {
      if (confirm('This will kill the daemon and restart the app.\n\nAll agent conversations will be lost, but code changes will be loaded.\n\nContinue?')) {
        updateConnectionStatus('Restarting...');
        try {
          await ipcRenderer.invoke('full-restart');
        } catch (err) {
          log.error('Restart', 'Full restart failed:', err);
          updateConnectionStatus('Restart failed - try manually');
        }
      }
    });
  }

  // Sync button
  const syncBtn = document.getElementById('syncBtn');
  if (syncBtn) {
    syncBtn.addEventListener('click', async () => {
      try {
        const synced = await terminal.syncSharedContext();
        if (synced) {
          daemonHandlers.markManualSync('shared_context.md');
        }
      } catch (err) {
        log.error('Sync', 'Sync failed:', err);
        updateConnectionStatus('Sync failed');
      }
    });
  }

  // Select Project button
  const selectProjectBtn = document.getElementById('selectProjectBtn');
  if (selectProjectBtn) {
    selectProjectBtn.addEventListener('click', daemonHandlers.selectProject);
  }

  // Actions dropdown toggle
  const actionsBtn = document.getElementById('actionsBtn');
  const actionsMenu = document.getElementById('actionsMenu');
  if (actionsBtn && actionsMenu) {
    actionsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      actionsMenu.classList.toggle('show');
    });
    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#actionsDropdown')) {
        actionsMenu.classList.remove('show');
      }
    });
    // Close dropdown when clicking a menu item
    actionsMenu.querySelectorAll('.dropdown-item').forEach(item => {
      item.addEventListener('click', () => {
        actionsMenu.classList.remove('show');
      });
    });
  }

  // Pane click: swap side pane into main, or focus if already main
  document.querySelectorAll('.pane').forEach(pane => {
    pane.addEventListener('click', (event) => {
      if (event.target && event.target.closest('button')) {
        return;
      }
      const paneId = pane.dataset.paneId;
      const mainContainer = document.querySelector(MAIN_PANE_CONTAINER_SELECTOR);
      if (!paneId) return;

      if (pane.parentElement === mainContainer || paneId === getMainPaneId()) {
        terminal.focusPane(paneId);
        return;
      }

      swapToMainPane(paneId);
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

  // Lock icon click handler - toggle input lock for pane
  document.querySelectorAll('.lock-icon').forEach(icon => {
    icon.addEventListener('click', (e) => {
      e.stopPropagation(); // Don't trigger pane click/focus
      const paneId = icon.dataset.paneId;
      if (paneId) {
        terminal.toggleInputLock(paneId);
      }
    });
  });

  // Custom target dropdown with pane preview on hover
  initCustomTargetDropdown();

  // Command palette (Ctrl+K)
  initCommandPalette();

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

// Custom target dropdown with pane preview on hover
// Replaces native select with interactive dropdown that highlights target pane
function initCustomTargetDropdown() {
  const nativeSelect = document.getElementById('commandTarget');
  if (!nativeSelect) return;

  // Hide native select
  nativeSelect.style.display = 'none';

  // Create custom dropdown
  const dropdown = document.createElement('div');
  dropdown.className = 'custom-target-dropdown';
  dropdown.innerHTML = `
    <button type="button" class="custom-target-button" id="customTargetBtn">
      <span class="selected-text">Architect</span>
      <span class="arrow">▼</span>
    </button>
    <div class="custom-target-list" id="customTargetList"></div>
  `;

  // Insert after native select
  nativeSelect.parentNode.insertBefore(dropdown, nativeSelect.nextSibling);

  const button = dropdown.querySelector('.custom-target-button');
  const list = dropdown.querySelector('.custom-target-list');
  const selectedText = dropdown.querySelector('.selected-text');

  // Build options from native select
  const options = [
    { value: '1', label: 'Architect', pane: '1' },
    { value: 'all', label: 'All Agents', pane: 'all' },
    { value: '2', label: 'Infra', pane: '2' },
    { value: '3', label: 'Frontend', pane: '3' },
    { value: '4', label: 'Backend', pane: '4' },
    { value: '5', label: 'Analyst', pane: '5' },
    { value: '6', label: 'Reviewer', pane: '6' },
  ];

  options.forEach(opt => {
    const option = document.createElement('div');
    option.className = 'custom-target-option' + (opt.value === nativeSelect.value ? ' selected' : '');
    option.dataset.value = opt.value;
    option.dataset.pane = opt.pane;
    option.innerHTML = `
      <span class="pane-number">${opt.pane === 'all' ? '★' : opt.pane}</span>
      <span class="option-label">${opt.label}</span>
    `;
    list.appendChild(option);

    // Hover: highlight target pane(s)
    option.addEventListener('mouseenter', () => {
      clearPaneHighlights();
      if (opt.pane === 'all') {
        // Highlight all panes
        document.querySelectorAll('.pane').forEach(pane => {
          pane.classList.add('preview-highlight');
        });
      } else {
        // Highlight single pane
        const pane = document.querySelector(`.pane[data-pane-id="${opt.pane}"]`);
        if (pane) pane.classList.add('preview-highlight');
      }
    });

    option.addEventListener('mouseleave', () => {
      // Don't clear immediately - let the list mouseleave handle it
    });

    // Click: select option
    option.addEventListener('click', () => {
      // Update native select
      nativeSelect.value = opt.value;
      nativeSelect.dispatchEvent(new Event('change'));

      // Update visual state
      list.querySelectorAll('.custom-target-option').forEach(o => o.classList.remove('selected'));
      option.classList.add('selected');
      selectedText.textContent = opt.label;

      // Close dropdown
      dropdown.classList.remove('open');
      clearPaneHighlights();
    });
  });

  // Toggle dropdown
  button.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropdown.classList.toggle('open');
  });

  // Close on outside click
  document.addEventListener('click', (e) => {
    if (!dropdown.contains(e.target)) {
      dropdown.classList.remove('open');
      clearPaneHighlights();
    }
  });

  // Clear highlights when mouse leaves dropdown list
  list.addEventListener('mouseleave', () => {
    clearPaneHighlights();
  });

  // Keyboard navigation
  button.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      dropdown.classList.toggle('open');
    } else if (e.key === 'Escape') {
      dropdown.classList.remove('open');
      clearPaneHighlights();
    }
  });

  function clearPaneHighlights() {
    document.querySelectorAll('.pane.preview-highlight').forEach(pane => {
      pane.classList.remove('preview-highlight');
    });
  }

  log.info('UI', 'Custom target dropdown initialized with pane preview');
}

// Command Palette (Ctrl+K) - Quick access to all actions
function initCommandPalette() {
  const overlay = document.getElementById('commandPaletteOverlay');
  const palette = document.getElementById('commandPalette');
  const input = document.getElementById('commandPaletteInput');
  const list = document.getElementById('commandPaletteList');

  if (!overlay || !palette || !input || !list) return;

  let selectedIndex = 0;
  let filteredCommands = [];

  // Define all available commands
  const commands = [
    // Agent Control
    { id: 'spawn-all', label: 'Spawn All Agents', icon: '🚀', category: 'Agents', action: () => document.getElementById('spawnAllBtn')?.click() },
    { id: 'kill-all', label: 'Kill All Agents', icon: '💀', category: 'Agents', action: () => document.getElementById('killAllBtn')?.click() },
    { id: 'nudge-all', label: 'Nudge All (ESC+Enter)', icon: '👋', category: 'Agents', action: () => document.getElementById('nudgeAllBtn')?.click() },
    { id: 'fresh-start', label: 'Fresh Start', icon: '🔄', category: 'Agents', action: () => document.getElementById('freshStartBtn')?.click() },
    { id: 'sync-context', label: 'Sync Context', icon: '📡', category: 'Agents', action: () => document.getElementById('syncBtn')?.click() },

    // Navigation
    { id: 'focus-1', label: 'Focus Architect (Pane 1)', icon: '1️⃣', category: 'Navigate', shortcut: 'Alt+1', action: () => terminal.focusPane('1') },
    { id: 'focus-2', label: 'Focus Infra (Pane 2)', icon: '2️⃣', category: 'Navigate', shortcut: 'Alt+2', action: () => terminal.focusPane('2') },
    { id: 'focus-3', label: 'Focus Frontend (Pane 3)', icon: '3️⃣', category: 'Navigate', shortcut: 'Alt+3', action: () => terminal.focusPane('3') },
    { id: 'focus-4', label: 'Focus Backend (Pane 4)', icon: '4️⃣', category: 'Navigate', shortcut: 'Alt+4', action: () => terminal.focusPane('4') },
    { id: 'focus-5', label: 'Focus Analyst (Pane 5)', icon: '5️⃣', category: 'Navigate', shortcut: 'Alt+5', action: () => terminal.focusPane('5') },
    { id: 'focus-6', label: 'Focus Reviewer (Pane 6)', icon: '6️⃣', category: 'Navigate', shortcut: 'Alt+6', action: () => terminal.focusPane('6') },

    // Panels
    { id: 'toggle-settings', label: 'Toggle Settings Panel', icon: '⚙️', category: 'Panels', action: () => document.getElementById('settingsBtn')?.click() },
    { id: 'toggle-panel', label: 'Toggle Right Panel', icon: '📊', category: 'Panels', action: () => document.getElementById('panelBtn')?.click() },
    { id: 'toggle-friction', label: 'View Friction Logs', icon: '🔧', category: 'Panels', action: () => {
      // Open right panel and switch to friction tab
      const rightPanel = document.getElementById('rightPanel');
      if (rightPanel && !rightPanel.classList.contains('visible')) {
        document.getElementById('panelBtn')?.click();
      }
      document.querySelector('.panel-tab[data-tab="friction"]')?.click();
    }},

    // Project
    { id: 'select-project', label: 'Select Project Folder', icon: '📁', category: 'Project', action: () => document.getElementById('selectProjectBtn')?.click() },

    // System
    { id: 'shutdown', label: 'Shutdown Hivemind', icon: '🔌', category: 'System', action: () => document.getElementById('fullRestartBtn')?.click() },
  ];

  function openPalette() {
    overlay.classList.add('open');
    input.value = '';
    selectedIndex = 0;
    renderCommands('');
    input.focus();
  }

  function closePalette() {
    overlay.classList.remove('open');
    input.value = '';
  }

  function renderCommands(filter) {
    const filterLower = filter.toLowerCase();
    filteredCommands = commands.filter(cmd =>
      cmd.label.toLowerCase().includes(filterLower) ||
      cmd.category.toLowerCase().includes(filterLower) ||
      cmd.id.includes(filterLower)
    );

    if (filteredCommands.length === 0) {
      list.innerHTML = '<div class="command-palette-empty">No matching commands</div>';
      return;
    }

    // Clamp selected index
    if (selectedIndex >= filteredCommands.length) {
      selectedIndex = filteredCommands.length - 1;
    }

    list.innerHTML = filteredCommands.map((cmd, i) => `
      <div class="command-palette-item ${i === selectedIndex ? 'selected' : ''}" data-index="${i}">
        <span class="icon">${cmd.icon}</span>
        <span class="label">${cmd.label}</span>
        <span class="category">${cmd.category}</span>
        ${cmd.shortcut ? `<span class="shortcut-hint">${cmd.shortcut}</span>` : ''}
      </div>
    `).join('');

    // Add click handlers
    list.querySelectorAll('.command-palette-item').forEach(item => {
      item.addEventListener('click', () => {
        const idx = parseInt(item.dataset.index);
        executeCommand(filteredCommands[idx]);
      });
      item.addEventListener('mouseenter', () => {
        selectedIndex = parseInt(item.dataset.index);
        updateSelection();
      });
    });
  }

  function updateSelection() {
    list.querySelectorAll('.command-palette-item').forEach((item, i) => {
      item.classList.toggle('selected', i === selectedIndex);
    });
    // Scroll selected into view
    const selected = list.querySelector('.command-palette-item.selected');
    if (selected) {
      selected.scrollIntoView({ block: 'nearest' });
    }
  }

  function executeCommand(cmd) {
    closePalette();
    if (cmd && cmd.action) {
      log.info('CommandPalette', `Executing: ${cmd.label}`);
      cmd.action();
    }
  }

  // Input filtering
  input.addEventListener('input', () => {
    selectedIndex = 0;
    renderCommands(input.value);
  });

  // Keyboard navigation
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (selectedIndex < filteredCommands.length - 1) {
        selectedIndex++;
        updateSelection();
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (selectedIndex > 0) {
        selectedIndex--;
        updateSelection();
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filteredCommands[selectedIndex]) {
        executeCommand(filteredCommands[selectedIndex]);
      }
    } else if (e.key === 'Escape') {
      closePalette();
    }
  });

  // Close on overlay click
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      closePalette();
    }
  });

  // Global Ctrl+K handler
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (overlay.classList.contains('open')) {
        closePalette();
      } else {
        openPalette();
      }
    }
  });

  log.info('UI', 'Command palette initialized (Ctrl+K)');
}

function applyShortcutTooltips() {
  const shortcutRegex = /(Ctrl\+[A-Za-z0-9]+|Alt\+[A-Za-z0-9]+|Shift\+[A-Za-z0-9]+|Cmd\+[A-Za-z0-9]+|⌘[A-Za-z0-9]+|Esc|Escape|Enter|Tab|↑|↓)/gi;
  document.querySelectorAll('[title]').forEach((el) => {
    const title = el.getAttribute('title');
    if (!title) return;
    const matches = title.match(shortcutRegex);
    if (!matches) return;
    const shortcut = matches.join(' / ').replace(/Escape/gi, 'Esc');
    const cleaned = title
      .replace(shortcutRegex, '')
      .replace(/[()]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    el.dataset.tooltip = cleaned || title;
    el.dataset.shortcut = shortcut;
    el.classList.add('shortcut-tooltip');
    el.removeAttribute('title');
  });
}

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', async () => {
  // Setup all event handlers
  setupEventListeners();
  initMainPaneState();

  // Enhance shortcut tooltips for controls with keyboard hints
  applyShortcutTooltips();

  // Initialize global UI focus tracker for multi-pane focus restore
  terminal.initUIFocusTracker();

  // Agent Health Dashboard (#1) - start health monitor interval
  setInterval(updateHealthIndicators, 1000);
  updateHealthIndicators(); // Initial update

  // Status Strip - task counts at a glance
  initStatusStrip();

  // Global ESC key handler - interrupt agent AND release keyboard
  ipcRenderer.on('global-escape-pressed', () => {
    // Send Ctrl+C (0x03) to focused pane to interrupt Claude
    const focusedPane = terminal.getFocusedPane();
    if (focusedPane) {
      window.hivemind.pty.write(focusedPane, '\x03').catch(err => {
        log.error('ESC', 'Failed to send Ctrl+C:', err);
      });
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

  // Watchdog alert - all agents stuck, notify user
  // Auto-triggers aggressive nudge and uses it for click handler
  ipcRenderer.on('watchdog-alert', (event, data) => {
    log.info('Watchdog', 'Alert received:', data);

    // Auto-trigger aggressive nudge when watchdog fires
    log.info('Watchdog', 'Auto-triggering aggressive nudge on all panes');
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
      audio.play().catch(() => log.info('Watchdog', 'Could not play alert sound'));
    } catch (e) {
      log.info('Watchdog', 'Audio not available');
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

  // Heartbeat state indicator
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

      log.info('Heartbeat', `State changed: ${state}, interval: ${displayInterval}`);
    }
  });

  // Self-healing recovery actions
  ipcRenderer.on('nudge-pane', (event, data) => {
    const paneId = data?.paneId;
    if (paneId) {
      terminal.nudgePane(String(paneId));
    }
  });

  ipcRenderer.on('unstick-pane', (event, data) => {
    const paneId = data?.paneId;
    if (paneId) {
      terminal.sendUnstick(String(paneId));
    }
  });

  ipcRenderer.on('restart-pane', (event, data) => {
    const paneId = data?.paneId;
    if (paneId) {
      terminal.restartPane(String(paneId));
    }
  });

  ipcRenderer.on('restart-all-panes', () => {
    const panes = terminal.PANE_IDS || ['1', '2', '3', '4', '5', '6'];
    panes.forEach((paneId, index) => {
      setTimeout(() => terminal.restartPane(String(paneId)), index * 200);
    });
  });

  // Smart Parallelism - Task list updates for claim button visibility
  ipcRenderer.on('task-list-updated', (event, data) => {
    if (data && Array.isArray(data.tasks)) {
      claimableTasksCache.tasks = data.tasks;
      claimableTasksCache.lastUpdated = Date.now();
      log.info('Tasks', `Task list updated: ${data.tasks.length} tasks`);
      // Immediately update indicators with new task data
      updateHealthIndicators();
    }
  });

  // Request initial task list on startup
  ipcRenderer.invoke('get-task-list').then(tasks => {
    if (Array.isArray(tasks)) {
      claimableTasksCache.tasks = tasks;
      claimableTasksCache.lastUpdated = Date.now();
      log.info('Tasks', `Initial task list: ${tasks.length} tasks`);
    }
  }).catch(err => {
    log.warn('Tasks', 'Failed to get initial task list:', err);
  });

  // Codex activity indicator - update pane status based on Codex exec activity
  // State labels for UI display
  const CODEX_ACTIVITY_LABELS = {
    thinking: 'Thinking',
    tool: 'Tool',
    command: 'Command',
    file: 'File',
    streaming: 'Streaming',
    done: 'Done',
    ready: 'Ready',
  };

  // Glyph spinner sequence (Claude TUI style)
  const SPINNER_GLYPHS = ['◐', '◓', '◑', '◒'];
  const spinnerTimers = new Map(); // paneId -> intervalId

  // Start glyph cycling for a pane
  function startSpinnerCycle(paneId, spinnerEl) {
    // Clear existing timer if any
    if (spinnerTimers.has(paneId)) {
      clearInterval(spinnerTimers.get(paneId));
    }
    // Check reduced motion preference
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reducedMotion) {
      spinnerEl.textContent = '●';
      return;
    }
    // Cycle through glyphs
    let index = 0;
    spinnerEl.textContent = SPINNER_GLYPHS[0];
    const timerId = setInterval(() => {
      index = (index + 1) % SPINNER_GLYPHS.length;
      spinnerEl.textContent = SPINNER_GLYPHS[index];
    }, 150);
    spinnerTimers.set(paneId, timerId);
  }

  // Stop glyph cycling for a pane
  function stopSpinnerCycle(paneId) {
    if (spinnerTimers.has(paneId)) {
      clearInterval(spinnerTimers.get(paneId));
      spinnerTimers.delete(paneId);
    }
  }

  ipcRenderer.on('codex-activity', (event, data) => {
    const { paneId, state, detail } = data;
    const statusEl = document.getElementById(`status-${paneId}`);
    if (!statusEl) return;

    // Get or create spinner element
    let spinnerEl = statusEl.querySelector('.pane-spinner');
    if (!spinnerEl) {
      spinnerEl = document.createElement('span');
      spinnerEl.className = 'pane-spinner';
      statusEl.insertBefore(spinnerEl, statusEl.firstChild);
    }

    // Update status text with optional detail truncated
    const label = CODEX_ACTIVITY_LABELS[state] || state;
    const displayDetail = detail && detail.length > 30 ? detail.slice(0, 27) + '...' : detail;
    const statusText = displayDetail ? `${label}: ${displayDetail}` : label;

    // Set tooltip for full detail
    statusEl.title = detail || '';

    // Update text content (preserve spinner)
    statusEl.innerHTML = '';
    statusEl.appendChild(spinnerEl);
    statusEl.appendChild(document.createTextNode(statusText));

    // Update CSS classes for activity state
    statusEl.classList.remove('idle', 'starting', 'running', 'working', 'activity-thinking', 'activity-tool', 'activity-command', 'activity-file', 'activity-streaming', 'activity-done');

    if (state === 'ready') {
      statusEl.classList.add('idle');
      stopSpinnerCycle(paneId);
    } else if (state === 'done') {
      statusEl.classList.add('activity-done');
      stopSpinnerCycle(paneId);
    } else {
      statusEl.classList.add('working', `activity-${state}`);
      startSpinnerCycle(paneId, spinnerEl);
    }
  });

  // Single agent stuck detection - notify user (we can't auto-ESC via PTY)
  // Track shown alerts to avoid spamming
  const stuckAlertShown = new Set();
  ipcRenderer.on('agent-stuck-detected', (event, data) => {
    const { paneId, idleTime, message } = data;

    // Only show once per stuck detection (reset after 60 seconds)
    if (stuckAlertShown.has(paneId)) return;
    stuckAlertShown.add(paneId);
    setTimeout(() => stuckAlertShown.delete(paneId), 60000);

    log.info('StuckDetection', `Pane ${paneId} stuck for ${Math.round(idleTime / 1000)}s`);

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

  // SDK Message Handler
  // Receives messages from Python SDK via IPC and routes to correct pane
  // sdk-bridge sends single object { paneId, message }, not separate args
  // Includes null check for malformed data and contextual thinking state for tool_use
  ipcRenderer.on('sdk-message', (event, data) => {
    if (!data || !data.message) {
      log.warn('SDK', 'Received malformed sdk-message:', data);
      return;
    }
    const { paneId, message } = data;
    log.info('SDK', `Message for pane ${paneId}: ${message?.type || 'unknown'}`);

    // Update contextual thinking indicator for tool_use
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
  // sdk-bridge sends { paneId, active } as single object
  ipcRenderer.on('sdk-streaming', (event, data) => {
    if (!data) return;
    const { paneId, active } = data;
    sdkRenderer.streamingIndicator(paneId, active);
    // Update SDK status based on streaming state
    updateSDKStatus(paneId, active ? 'thinking' : 'idle');

    if (active) {
      // Clear old streaming state when new turn starts
      sdkRenderer.clearStreamingState(paneId);
    } else {
      // Finalize streaming message when streaming stops
      sdkRenderer.finalizeStreamingMessage(paneId);
    }
  });

  // SDK text delta - real-time typewriter streaming from Python
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
    log.info('SDK', 'Session starting - enabling SDK mode');
    window.hivemind.sdk.enableMode();
    // Update all panes to connected status
    for (let i = 1; i <= 4; i++) {
      updateSDKStatus(i, 'connected');
    }
  });

  // SDK session ended
  ipcRenderer.on('sdk-session-end', (event, data) => {
    log.info('SDK', 'Session ended');
    // Update all panes to disconnected status
    for (let i = 1; i <= 4; i++) {
      updateSDKStatus(i, 'disconnected');
    }
  });

  // SDK error handler
  // sdk-bridge sends { paneId, error } as single object
  ipcRenderer.on('sdk-error', (event, data) => {
    if (!data) return;
    const { paneId, error } = data;
    log.error('SDK', `Error in pane ${paneId}:`, error);
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

  // CLI Identity Badge listener
  ipcRenderer.on('pane-cli-identity', (event, data) => {
    if (!data) return;
    const { paneId, label, provider } = data;
    const el = document.getElementById(`cli-badge-${paneId}`);
    if (!el) return;
    const pane = document.querySelector(`.pane[data-pane-id="${paneId}"]`);
    const key = (label || provider || '').toLowerCase();
    el.textContent = label || provider || '';
    el.className = 'cli-badge visible';
    if (pane) {
      pane.classList.remove('cli-claude', 'cli-codex', 'cli-gemini');
    }
    if (key.includes('claude')) {
      el.classList.add('claude');
      if (pane) pane.classList.add('cli-claude');
      terminal.unregisterCodexPane(paneId);
    } else if (key.includes('codex')) {
      el.classList.add('codex');
      if (pane) pane.classList.add('cli-codex');
      terminal.registerCodexPane(paneId);
    } else if (key.includes('gemini')) {
      el.classList.add('gemini');
      if (pane) pane.classList.add('cli-gemini');
      terminal.unregisterCodexPane(paneId);
    }
  });

  // Setup daemon handlers
  daemonHandlers.setupStateListener();
  daemonHandlers.setupClaudeStateListener(daemonHandlers.handleSessionTimerState);
  daemonHandlers.setupCostAlertListener();
  daemonHandlers.setupRefreshButtons(terminal.sendToPane);
  daemonHandlers.setupSyncIndicator();
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
  tabs.setupQueueTab();         // Task #3: Task queue dashboard
  tabs.setupScheduleTab();      // Task #28: Scheduler
  tabs.setupTestsTab();         // TR1: Test results panel
  tabs.setupInspectorTab();     // P2-5: Message inspector
  tabs.setupCIStatusIndicator(); // CI2: CI status indicator
  tabs.setupMCPStatusIndicator(); // MC7: MCP status indicator
  tabs.setupGitTab();           // Task #6: Git integration
  tabs.setupMemoryTab();        // Task #8: Conversation history viewer
  tabs.setupHealthTab();        // Task #29: Self-healing error recovery UI
  tabs.setupGraphTab();         // Task #36: Knowledge graph visualization
  tabs.setupWorkflowTab();      // Task #19: Workflow builder
  tabs.setupDebugTab();         // Task #21: Agent debugging/replay
  tabs.setupReviewTab();        // Task #18: AI-powered code review
  tabs.setupDocsTab();          // Task #23: Automated documentation generation
  tabs.setupOracleTab();        // Oracle Visual QA tab
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
