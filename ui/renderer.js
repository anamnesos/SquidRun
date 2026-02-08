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
const { createOrganicUI } = require('./sdk-ui/organic-ui');
const { showStatusNotice, showToast } = require('./modules/notifications');
const { formatTimeSince } = require('./modules/formatters');
const {
  UI_IDLE_THRESHOLD_MS,
  UI_STUCK_THRESHOLD_MS,
  UI_IDLE_CLAIM_THRESHOLD_MS,
} = require('./modules/constants');
const { debounceButton, applyShortcutTooltips } = require('./modules/utils');
const { initCommandPalette } = require('./modules/command-palette');
const { initCustomTargetDropdown } = require('./modules/target-dropdown');
const { initStatusStrip } = require('./modules/status-strip');
const { initModelSelectors, setupModelSelectorListeners, setupModelChangeListener } = require('./modules/model-selector');

// SDK mode flag - when true, use SDK renderer instead of xterm terminals
let sdkMode = false;

// Organic UI instance for SDK mode
let organicUIInstance = null;

// Pending messages for War Room (queued before organicUIInstance is ready)
let pendingWarRoomMessages = [];

// Reference to sendBroadcast (set after DOMContentLoaded)
let sendBroadcastFn = null;

/**
 * Wire up organic UI input to send messages
 * Called after organic UI is mounted and sendBroadcast is available
 */
function wireOrganicInput() {
  log.info('SDK', `wireOrganicInput called: instance=${!!organicUIInstance}, input=${!!organicUIInstance?.input}, sendFn=${!!sendBroadcastFn}`);
  if (!organicUIInstance || !organicUIInstance.input || !sendBroadcastFn) {
    log.info('SDK', 'wireOrganicInput: missing dependency, skipping');
    return;
  }
  // Prevent double-wiring
  if (organicUIInstance._inputWired) {
    log.info('SDK', 'wireOrganicInput: already wired, skipping');
    return;
  }
  organicUIInstance._inputWired = true;

  const handleSubmit = () => {
    const value = organicUIInstance.input.value?.trim();
    if (value) {
      if (sendBroadcastFn(value)) {
        organicUIInstance.input.value = '';
        // No need to append manually - sendBroadcastFn triggers triggers.broadcastToAllAgents
        // which emits 'war-room-message' IPC, handled below by the standard stream handler.
      }
    }
  };

  organicUIInstance.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && e.isTrusted) {
      e.preventDefault();
      handleSubmit();
    }
  });

  organicUIInstance.sendBtn.addEventListener('click', (e) => {
    if (e.isTrusted) {
      handleSubmit();
    }
  });

  log.info('SDK', 'Organic UI input wired');
}

/**
 * Update agent state in organic UI
 * @param {string} paneId - Pane ID or agent ID
 * @param {string} activityState - Activity state (ready, thinking, tool, etc.)
 */
function updateOrganicState(paneId, activityState) {
  if (!organicUIInstance) return;
  // Map activity states to organic UI states
  const stateMap = {
    ready: 'idle',
    idle: 'idle',
    done: 'idle',
    thinking: 'thinking',
    responding: 'thinking',  // SDK sends 'responding' when generating output
    tool: 'thinking',
    command: 'thinking',
    file: 'thinking',
    streaming: 'thinking',
  };
  const state = stateMap[activityState] || activityState;
  organicUIInstance.updateState(paneId, state);
}

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
  '2': { name: 'DevOps', avatar: '[D]' },
  '5': { name: 'Analyst', avatar: '[?]' },
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
      terminal.spawnAllAgents,
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

  // SDK Mode: Initialize organic bubble UI and start sessions
  if (isSDKMode) {
    log.info('Init', 'Initializing SDK mode (organic UI)...');
    setSDKMode(true, { persist: false, source: 'daemon-ready' });  // Centralized - sets all 4 SDK mode flags

    // Mount organic bubble canvas
    const terminalsSection = document.getElementById('terminalsSection');
    const paneLayout = terminalsSection?.querySelector('.pane-layout');
    if (paneLayout) {
      paneLayout.style.display = 'none';
    }

    // Hide PTY command bar (organic UI has its own input)
    const commandBar = document.querySelector('.command-bar');
    if (commandBar) {
      commandBar.style.display = 'none';
    }

    if (terminalsSection && !organicUIInstance) {
      organicUIInstance = createOrganicUI({ mount: terminalsSection });
      log.info('Init', 'Organic UI mounted');
      wireOrganicInput();  // Wire up input handlers

      // Replay pending messages
      if (pendingWarRoomMessages.length > 0) {
        log.info('Init', `Replaying ${pendingWarRoomMessages.length} queued messages`);
        pendingWarRoomMessages.forEach(msg => organicUIInstance.appendWarRoomMessage(msg));
        pendingWarRoomMessages = [];
      }
    }

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
    injectContext: (paneId, model, delay) => ipcRenderer.invoke('inject-context', paneId, model, delay),
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
        restartSession: (paneId) => ipcRenderer.invoke('sdk-restart-session', paneId),
        isActive: () => sdkMode,    enableMode: () => {
      // Idempotent - don't reinitialize if already enabled
      if (sdkMode) {
        log.info('SDK', 'Mode already enabled, skipping reinit');
        return;
      }
      setSDKMode(true, { source: 'sdk-enable' });  // Centralized - sets all 4 SDK mode flags

      // Mount organic UI
      const terminalsSection = document.getElementById('terminalsSection');
      const paneLayout = terminalsSection?.querySelector('.pane-layout');
      if (paneLayout) {
        paneLayout.style.display = 'none';
      }

      // Hide PTY command bar (organic UI has its own input)
      const commandBar = document.querySelector('.command-bar');
      if (commandBar) {
        commandBar.style.display = 'none';
      }

      if (terminalsSection && !organicUIInstance) {
        organicUIInstance = createOrganicUI({ mount: terminalsSection });
        log.info('SDK', 'Organic UI mounted');
        wireOrganicInput();  // Wire up input handlers
        initModelSelectors(true);

        // Replay pending messages
        if (pendingWarRoomMessages.length > 0) {
          log.info('SDK', `Replaying ${pendingWarRoomMessages.length} queued messages`);
          pendingWarRoomMessages.forEach(msg => organicUIInstance.appendWarRoomMessage(msg));
          pendingWarRoomMessages = [];
        }
      }

      log.info('SDK', 'Mode enabled (organic UI v2)');
    },
    disableMode: () => {
      setSDKMode(false, { source: 'sdk-disable' });  // Centralized - clears all 4 SDK mode flags

      // Unmount organic UI and restore pane layout
      if (organicUIInstance) {
        organicUIInstance.destroy();
        organicUIInstance = null;
        log.info('SDK', 'Organic UI destroyed');
      }

      const terminalsSection = document.getElementById('terminalsSection');
      const paneLayout = terminalsSection?.querySelector('.pane-layout');
      if (paneLayout) {
        paneLayout.style.display = '';
      }

              // Restore PTY command bar
              const commandBar = document.querySelector('.command-bar');
              if (commandBar) {
                commandBar.style.display = '';
              }
      
              log.info('SDK', 'Mode disabled (restoring agents)...');
              initModelSelectors(false);
              // Ensure PTY terminals are initialized and agents started
              terminal.initTerminals().then(() => {
                terminal.spawnAllAgents();
              });
            },    // SDK status functions (exposed for external use)
    updateStatus: (paneId, state) => updateSDKStatus(paneId, state),
    showDelivered: (paneId) => showSDKMessageDelivered(paneId),
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
// Constants imported from modules/constants.js: UI_STUCK_THRESHOLD_MS, UI_IDLE_CLAIM_THRESHOLD_MS

// Smart Parallelism Phase 3 - Domain ownership mapping
const PANE_DOMAIN_MAP = {
  '1': 'architecture',  // Architect
  '2': 'devops',        // DevOps (Infra + Backend)
  '5': 'analysis',      // Analyst
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

// Pane expansion state
let expandedPaneId = null;

function toggleExpandPane(paneId) {
  const pane = document.querySelector(`.pane[data-pane-id="${paneId}"]`);
  const paneLayout = document.querySelector('.pane-layout');
  if (!pane || !paneLayout) return;

  if (pane.classList.contains('pane-expanded')) {
    // Collapse
    expandedPaneId = null;
    pane.classList.remove('pane-expanded');
    paneLayout.classList.remove('has-expanded-pane');
  } else {
    // Collapse any previously expanded pane
    if (expandedPaneId) {
      const prevPane = document.querySelector(`.pane[data-pane-id="${expandedPaneId}"]`);
      if (prevPane) prevPane.classList.remove('pane-expanded');
    }
    // Expand this pane
    expandedPaneId = paneId;
    pane.classList.add('pane-expanded');
    paneLayout.classList.add('has-expanded-pane');
  }
  // Trigger terminal resize
  if (terminal && terminal.handleResize) {
    setTimeout(() => terminal.handleResize(), 100);
  }
}

// Status Strip - imported from modules/status-strip.js

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

// SDK activity tracking (header indicators removed)
const paneIdleState = new Map();

// SDK status debouncing - track last status per pane to avoid flicker
const lastSDKStatus = new Map();
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
  // Debounce: skip if same status as last time (prevents flicker from rapid updates)
  if (lastSDKStatus.get(paneId) === state) {
    return;
  }
  lastSDKStatus.set(paneId, state);

  // Track activity - anything but 'idle' is activity
  if (state !== 'idle' && state !== 'disconnected') {
    trackPaneActivity(paneId, true);
  }

  // Update organic UI visual state
  updateOrganicState(paneId, state);

  log.info('SDK', `Pane ${paneId} status: ${state}`);
}

function showSDKMessageDelivered(paneId) {
  daemonHandlers.showDeliveryIndicator(paneId, 'delivered');

  log.info('SDK', `Pane ${paneId} message delivered`);
}

// Wire up module callbacks
terminal.setStatusCallbacks(updatePaneStatus, updateConnectionStatus);
tabs.setConnectionStatusCallback(updateConnectionStatus);
settings.setConnectionStatusCallback(updateConnectionStatus);
settings.setSettingsLoadedCallback(markSettingsLoaded);
daemonHandlers.setStatusCallbacks(updateConnectionStatus, updatePaneStatus);


// Setup event listeners
function setupEventListeners() {
  // Window resize
  window.addEventListener('resize', terminal.handleResize);

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    // Ctrl+number to focus panes
    if (e.ctrlKey && terminal.PANE_IDS.includes(e.key)) {
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

    const roleHints = {
      '1': 'architecture or strategy',
      '2': 'infrastructure, builds, or backend logic',
      '5': 'debugging or analysis',
    };

    const hint = roleHints[target] ? ` about ${roleHints[target]}` : '';

    if (target === 'auto') {
      broadcastInput.placeholder = 'Describe a task to auto-route (Enter to send)';
      broadcastInput.title = 'Auto-route a task based on description';
    } else if (target === 'all') {
      broadcastInput.placeholder = 'Type here to message all agents (Enter to send)';
      broadcastInput.title = 'Send message to all agents';
    } else {
      broadcastInput.placeholder = `Type a message to ${targetName}${hint} (Enter to send)`;
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
  // Supports pane targeting via dropdown or /1, /2, /5 prefix
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
      // Check for pane targeting prefix: /1, /2, /5 or /architect, /devops, etc.
      // /all broadcasts to all agents
      const paneMatch = message.match(/^\/([125]|all|lead|architect|devops|infra|orchestrator|backend|worker-?b|implementer-?b|analyst|investigator)\s+/i);

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
            '1': '1', '2': '2', '5': '5',
            'lead': '1', 'architect': '1',
            'devops': '2', 'infra': '2', 'orchestrator': '2', 'backend': '2', 'worker-b': '2', 'workerb': '2',
            'analyst': '5', 'investigator': '5'
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

        // Show user message in War Room if active
        if (organicUIInstance) {
          organicUIInstance.appendWarRoomMessage({
            ts: Math.floor(Date.now() / 1000),
            from: 'YOU',
            to: 'ALL',
            msg: actualMessage,
            type: 'broadcast'
          });
        }

        terminal.PANE_IDS.forEach(paneId => {
          // Show user message in organic UI agent panes if active
          if (organicUIInstance) {
            organicUIInstance.appendText(paneId, `> ${actualMessage}`);
          }
          sdkRenderer.appendMessage(paneId, { type: 'user', content: actualMessage });
        });
        ipcRenderer.invoke('sdk-broadcast', actualMessage)
          .then(() => showDeliveryStatus('delivered'))
          .catch(err => {
            log.error('SDK', 'Broadcast failed:', err);
            showDeliveryStatus('failed');
            showToast(`Broadcast failed: ${err.message}`, 'error');
          });
      } else {
        log.info('SDK', `Targeted send to pane ${targetPaneId}: ${actualMessage.substring(0, 30)}...`);

        // Show user message in War Room if active
        if (organicUIInstance) {
          const toLabel = SDK_PANE_LABELS[targetPaneId]?.name || `Pane ${targetPaneId}`;
          organicUIInstance.appendWarRoomMessage({
            ts: Math.floor(Date.now() / 1000),
            from: 'YOU',
            to: toLabel.toUpperCase(),
            msg: actualMessage,
            type: 'direct'
          });
        }

        // Show user message in organic UI if active
        if (organicUIInstance) {
          organicUIInstance.appendText(targetPaneId, `> ${actualMessage}`);
        }
        sdkRenderer.appendMessage(targetPaneId, { type: 'user', content: actualMessage });
        ipcRenderer.invoke('sdk-send-message', targetPaneId, actualMessage)
          .then(() => showDeliveryStatus('delivered'))
          .catch(err => {
            log.error('SDK', `Send to pane ${targetPaneId} failed:`, err);
            showDeliveryStatus('failed');
            showToast(`Send failed: ${err.message}`, 'error');
          });
      }
    } else {
      // PTY mode - use terminal broadcast with target from dropdown
      const targetPaneId = commandTarget ? commandTarget.value : 'all';
      log.info('Broadcast', `Using PTY mode, target: ${targetPaneId}`);
      if (targetPaneId === 'all') {
        terminal.broadcast(message + '\r');
      } else {
        // Send to specific pane in PTY mode - user messages get priority
        terminal.sendToPane(targetPaneId, message + '\r', { priority: true });
      }
      showDeliveryStatus('delivered');
    }
    return true;
  }

  // Store reference for organic UI input wiring
  sendBroadcastFn = sendBroadcast;
  wireOrganicInput();  // Wire up if organic UI already mounted

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

    // Handle SDK mode toggle at runtime
    const newSettings = event.detail;
    if (newSettings && typeof newSettings.sdkMode !== 'undefined') {
      const newSdkMode = !!newSettings.sdkMode;
      if (newSdkMode !== sdkMode) {
        log.info('Settings', `SDK mode changed: ${sdkMode} -> ${newSdkMode}`);
        if (newSdkMode) {
          window.hivemind.sdk.enableMode();
        } else {
          window.hivemind.sdk.disableMode();
        }
      }
    }
  });
  refreshVoiceSettings(settings.getSettings());

  // Spawn all button (debounced)
  const spawnAllBtn = document.getElementById('spawnAllBtn');
  if (spawnAllBtn) {
    spawnAllBtn.addEventListener('click', debounceButton('spawnAll', terminal.spawnAllAgents));
  }

  // Kill all button (debounced, with confirmation)
  const killAllBtn = document.getElementById('killAllBtn');
  if (killAllBtn) {
    killAllBtn.addEventListener('click', debounceButton('killAll', () => {
      if (confirm('Kill all agent sessions?\n\nThis will terminate all running agents immediately.')) {
        terminal.killAllTerminals();
      }
    }));
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


  // ESC key to collapse expanded pane
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && expandedPaneId) {
      toggleExpandPane(expandedPaneId);
    }
  });

  // Fresh start button - kill all and start new sessions (debounced)
  const freshStartBtn = document.getElementById('freshStartBtn');
  if (freshStartBtn) {
    freshStartBtn.addEventListener('click', debounceButton('freshStart', () => {
      if (confirm('Start fresh with all agents?\n\nThis will kill all sessions and restart agents without injecting previous context.')) {
        terminal.freshStartAll();
      }
    }));
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

  // Pane click: focus the pane (pane positions are fixed)
  document.querySelectorAll('.pane').forEach(pane => {
    pane.addEventListener('click', (event) => {
      // Ignore clicks on buttons and model selector dropdowns
      if (event.target && (event.target.closest('button') || event.target.closest('.model-selector'))) {
        return;
      }
      const paneId = pane.dataset.paneId;
      if (!paneId) return;
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

// Custom target dropdown - imported from modules/target-dropdown.js

// Command Palette - imported from modules/command-palette.js

// applyShortcutTooltips - imported from modules/utils.js

// Model Selector - imported from modules/model-selector.js

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', async () => {
  // Setup all event handlers
  setupEventListeners();
  initMainPaneState();

  // Enhance shortcut tooltips for controls with keyboard hints
  applyShortcutTooltips();

  // Initialize global UI focus tracker for multi-pane focus restore
  terminal.initUIFocusTracker();

  // Status Strip - task counts at a glance
  initStatusStrip();

  // Model Selector - per-pane model switching
  setupModelSelectorListeners();
  setupModelChangeListener();
  initModelSelectors(sdkMode);

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
    const panes = terminal.PANE_IDS;
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

    // Update organic UI state
    updateOrganicState(paneId, state);
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
      alert.style.cssText = 'color: #f0a000; cursor: pointer;';
      alert.onclick = () => {
        terminal.focusPane(paneId);
        alert.remove();
      };
      statusBar.appendChild(alert);
      setTimeout(() => alert.remove(), 5000);
    }
  });

  // ============================================================
  // SDK MESSAGE ORDERING - Buffer and sort by timestamp
  // ============================================================
  // Messages from Python SDK now have 'timestamp' field (ISO string).
  // Buffer briefly then process in timestamp order to prevent stale message bugs.

  const SDK_MESSAGE_BUFFER_MS = 100; // Buffer window for sorting
  const sdkMessageBuffer = new Map(); // paneId -> { messages: [], timer: null, lastTimestamp: null }

  // Initialize buffer for each pane
  terminal.PANE_IDS.forEach(paneId => {
    sdkMessageBuffer.set(paneId, { messages: [], timer: null, lastTimestamp: null });
  });

  // Process buffered messages for a pane (sorted by timestamp)
  function processSDKMessageBuffer(paneId) {
    const buffer = sdkMessageBuffer.get(paneId);
    if (!buffer || buffer.messages.length === 0) return;

    // Sort by timestamp (oldest first)
    buffer.messages.sort((a, b) => {
      const tsA = a.message?.timestamp ? new Date(a.message.timestamp).getTime() : 0;
      const tsB = b.message?.timestamp ? new Date(b.message.timestamp).getTime() : 0;
      return tsA - tsB;
    });

    // Process each message
    for (const data of buffer.messages) {
      const { message } = data;
      const msgTimestamp = message?.timestamp ? new Date(message.timestamp).getTime() : null;

      // Detect out-of-order arrival (message older than last processed)
      if (msgTimestamp && buffer.lastTimestamp && msgTimestamp < buffer.lastTimestamp) {
        log.warn('SDK', `Out-of-order message detected in pane ${paneId}: msg=${msgTimestamp}, last=${buffer.lastTimestamp}`);
      }

      // Update last timestamp
      if (msgTimestamp) {
        buffer.lastTimestamp = Math.max(buffer.lastTimestamp || 0, msgTimestamp);
      }

      // Process the message
      processSDKMessage(paneId, message);
    }

    // Clear buffer
    buffer.messages = [];
    buffer.timer = null;
  }

  // Core message processing (extracted from original handler)
  function processSDKMessage(paneId, message) {
    log.info('SDK', `Processing message for pane ${paneId}: ${message?.type || 'unknown'}`);

    // Update contextual thinking indicator for tool_use AND activity feed
    if (message.type === 'tool_use' || (message.type === 'assistant' && Array.isArray(message.content))) {
      // Check for tool_use blocks in assistant content
      const toolBlocks = Array.isArray(message.content)
        ? message.content.filter(b => b.type === 'tool_use')
        : [];

      if (message.type === 'tool_use') {
        sdkRenderer.updateToolContext(paneId, message);
        // Add to activity feed in organic UI
        if (organicUIInstance && organicUIInstance.appendActivity) {
          organicUIInstance.appendActivity(paneId, message);
        }
      } else if (toolBlocks.length > 0) {
        // Use the first tool_use block for context
        sdkRenderer.updateToolContext(paneId, toolBlocks[0]);
        // Add all tool_use blocks to activity feed
        if (organicUIInstance && organicUIInstance.appendActivity) {
          toolBlocks.forEach(block => organicUIInstance.appendActivity(paneId, block));
        }
      }
    }

    // Route to organic UI if active, otherwise to sdk-renderer
    if (organicUIInstance) {
      // Extract text content for organic UI display
      let textContent = '';
      if (message.type === 'assistant') {
        if (Array.isArray(message.content)) {
          // Extract text blocks from content array
          textContent = message.content
            .filter(b => b.type === 'text')
            .map(b => b.text || '')
            .join('\n');
        } else if (typeof message.content === 'string') {
          textContent = message.content;
        }
      } else if (message.type === 'user') {
        textContent = `> ${message.content || message.message || ''}`;
      } else if (message.type === 'tool_use') {
        textContent = `[Tool: ${message.name || 'unknown'}]`;
      } else if (message.type === 'tool_result') {
        const resultContent = typeof message.content === 'string'
          ? message.content
          : (message.content != null ? JSON.stringify(message.content) : '(empty)');
        // Truncate long results
        textContent = resultContent.length > 100
          ? `[Result: ${resultContent.substring(0, 100)}...]`
          : `[Result: ${resultContent}]`;
      } else if (message.error) {
        textContent = `[Error: ${message.error}]`;
      }

      if (textContent) {
        organicUIInstance.appendText(paneId, textContent);

        // Also route assistant responses to War Room stream
        if (message.type === 'assistant') {
          const fromLabel = SDK_PANE_LABELS[paneId]?.name || `Pane ${paneId}`;
          organicUIInstance.appendWarRoomMessage({
            ts: Math.floor(Date.now() / 1000),
            from: fromLabel.toUpperCase(),
            to: 'YOU',
            msg: textContent,
            type: 'direct'
          });
        }
      }
    }

    // Also render to sdk-renderer (for detailed view when panes are shown)
    sdkRenderer.appendMessage(paneId, message);
  }

  // SDK Message Handler - buffers messages for timestamp sorting
  // Receives messages from Python SDK via IPC and routes to correct pane
  // sdk-bridge sends single object { paneId, message }, not separate args
  ipcRenderer.on('sdk-message', (event, data) => {
    if (!data || !data.message) {
      log.warn('SDK', 'Received malformed sdk-message:', data);
      return;
    }
    const { paneId, message } = data;

    // For streaming deltas (text_delta, thinking_delta), process immediately (no buffering)
    // These need real-time display for typewriter effect
    if (message.type === 'text_delta' || message.type === 'thinking_delta') {
      processSDKMessage(paneId, message);
      return;
    }

    // Buffer the message
    const buffer = sdkMessageBuffer.get(paneId);
    if (!buffer) {
      // Fallback: process immediately if no buffer
      processSDKMessage(paneId, message);
      return;
    }

    buffer.messages.push(data);

    // Start/reset the buffer timer
    if (buffer.timer) {
      clearTimeout(buffer.timer);
    }
    buffer.timer = setTimeout(() => processSDKMessageBuffer(paneId), SDK_MESSAGE_BUFFER_MS);
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
  // FIXED: Routes to organic UI when active
  ipcRenderer.on('sdk-text-delta', (event, data) => {
    if (!data) return;
    const { paneId, text } = data;
    if (text) {
      // Route to organic UI for live streaming display
      if (organicUIInstance) {
        organicUIInstance.appendText(paneId, text);
      }
      // Also update sdk-renderer for detailed view
      sdkRenderer.appendTextDelta(paneId, text);
      // Update status to 'responding' while receiving text
      updateSDKStatus(paneId, 'responding');
    }
  });

  // SDK thinking delta - real-time thinking/reasoning indicator from Codex
  // Shows agent's thought process (reasoning, planning) before text output
  ipcRenderer.on('sdk-thinking-delta', (event, data) => {
    if (!data) return;
    const { paneId, thinking } = data;
    if (thinking) {
      // Show thinking indicator with the reasoning content
      sdkRenderer.streamingIndicator(paneId, true, thinking, 'thinking');
      // Update status to 'thinking' while reasoning
      updateSDKStatus(paneId, 'thinking');
    }
  });

  // SDK session started - initialize panes for SDK mode
  ipcRenderer.on('sdk-session-start', (event, data) => {
    log.info('SDK', 'Session starting - enabling SDK mode');
    window.hivemind.sdk.enableMode();
  });

  // SDK session ended
  ipcRenderer.on('sdk-session-end', (event, data) => {
    log.info('SDK', 'Session ended');
  });

  // SDK error handler
  // sdk-bridge sends { paneId, error } as single object
  // FIXED: Routes to organic UI when active
  ipcRenderer.on('sdk-error', (event, data) => {
    if (!data) return;
    const { paneId, error } = data;
    log.error('SDK', `Error in pane ${paneId}:`, error);
    // Route to organic UI if active
    if (organicUIInstance) {
      organicUIInstance.appendText(paneId, `[Error: ${error}]`);
    }
    sdkRenderer.addErrorMessage(paneId, error);
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

  // Organic UI: Message stream visualizations
  // Trigger visual streams when agents communicate
  ipcRenderer.on('direct-message-sent', (event, data) => {
    if (!organicUIInstance || !data) return;
    const { from, to } = data;
    // 'to' can be an array of target panes
    const targets = Array.isArray(to) ? to : [to];
    for (const targetPaneId of targets) {
      organicUIInstance.triggerMessageStream({
        fromRole: from,
        toRole: targetPaneId,
        phase: 'sending'
      });
    }
  });

  ipcRenderer.on('auto-handoff', (event, data) => {
    if (!organicUIInstance || !data) return;
    const { from, to } = data;
    organicUIInstance.triggerMessageStream({
      fromRole: from,
      toRole: to,
      phase: 'sending'
    });
  });

  // War Room message stream - receives routed messages for display
  // Data format: {ts, from, to, msg, type}
  ipcRenderer.on('war-room-message', (event, data) => {
    if (!data) return;

    if (!organicUIInstance) {
      log.info('WarRoom', 'Queueing message (UI not ready)');
      pendingWarRoomMessages.push(data);
      return;
    }

    log.info('WarRoom', `Message: (${data.from} → ${data.to}): ${(data.msg || '').substring(0, 50)}...`);
    organicUIInstance.appendWarRoomMessage(data);

    // Also trigger visual stream animation for agent-to-agent messages
    if (data.from && data.to && data.from !== 'USER' && data.to !== 'USER') {
      organicUIInstance.triggerMessageStream({
        fromRole: data.from,
        toRole: data.to,
        phase: 'sending'
      });
    }
  });

  // Organic UI: State updates
  ipcRenderer.on('agent-online', (event, data) => {
    if (!organicUIInstance) {
      log.debug('OrganicUI', 'agent-online received but UI not mounted');
      return;
    }
    if (!data) return;
    updateOrganicState(data.agentId, 'idle');
  });

  ipcRenderer.on('agent-offline', (event, data) => {
    if (!organicUIInstance) {
      log.debug('OrganicUI', 'agent-offline received but UI not mounted');
      return;
    }
    if (!data) return;
    updateOrganicState(data.agentId, 'offline');
  });

  ipcRenderer.on('agent-state-changed', (event, data) => {
    if (!organicUIInstance) {
      log.debug('OrganicUI', 'agent-state-changed received but UI not mounted');
      return;
    }
    if (!data) return;
    updateOrganicState(data.agentId, data.state);
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
  settings.setupSettings();
  tabs.setupRightPanel(terminal.handleResize);  // All tab setup now handled internally
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
