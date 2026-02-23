/**
 * SquidRun Renderer - Main entry point
 * Orchestrates terminal, tabs, settings, and daemon handler modules
 */

function resolveBridgeApi() {
  if (typeof window === 'undefined' || !window || typeof window !== 'object') {
    return null;
  }

  const candidates = [
    window.squidrunAPI,
    window.squidrun,
  ];

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;

    if (
      typeof candidate.invoke === 'function'
      && typeof candidate.send === 'function'
      && typeof candidate.on === 'function'
    ) {
      return candidate;
    }

    const nested = candidate.ipc;
    if (
      nested
      && typeof nested === 'object'
      && typeof nested.invoke === 'function'
      && typeof nested.send === 'function'
      && typeof nested.on === 'function'
    ) {
      return {
        ...candidate,
        invoke: nested.invoke.bind(nested),
        send: nested.send.bind(nested),
        on: nested.on.bind(nested),
        removeListener: typeof nested.removeListener === 'function'
          ? nested.removeListener.bind(nested)
          : null,
        once: typeof nested.once === 'function' ? nested.once.bind(nested) : null,
      };
    }
  }

  return null;
}

function makeMissingBridgeError(method) {
  return new Error(`[renderer bridge] Missing preload bridge for ${method}()`);
}

const bridgeApi = resolveBridgeApi();
if (!bridgeApi) {
  throw makeMissingBridgeError('bootstrap');
}

const rendererModules = bridgeApi.rendererModules;
if (!rendererModules || typeof rendererModules !== 'object') {
  throw new Error('[renderer bridge] Missing rendererModules preload export');
}

function invokeBridge(channel, ...args) {
  if (typeof bridgeApi.invoke !== 'function') {
    return Promise.reject(makeMissingBridgeError('invoke'));
  }
  return bridgeApi.invoke(channel, ...args);
}

function onBridge(channel, listener) {
  if (typeof listener !== 'function') return () => {};
  if (typeof bridgeApi.on !== 'function') return () => {};

  const wrapped = (...payloadArgs) => listener(undefined, ...payloadArgs);
  const disposer = bridgeApi.on(channel, wrapped);

  if (typeof disposer === 'function') {
    return disposer;
  }

  const removeListener = (typeof bridgeApi.removeListener === 'function')
    ? bridgeApi.removeListener.bind(bridgeApi)
    : null;
  if (!removeListener) return () => {};
  return () => removeListener(channel, wrapped);
}

function onceBridge(channel, listener) {
  if (typeof listener !== 'function') return () => {};
  if (typeof bridgeApi.once === 'function') {
    const wrapped = (...payloadArgs) => listener(undefined, ...payloadArgs);
    const disposer = bridgeApi.once(channel, wrapped);
    if (typeof disposer === 'function') return disposer;
    const removeListener = (typeof bridgeApi.removeListener === 'function')
      ? bridgeApi.removeListener.bind(bridgeApi)
      : null;
    if (!removeListener) return () => {};
    return () => removeListener(channel, wrapped);
  }

  let disposed = false;
  let off = () => {};
  off = onBridge(channel, (...args) => {
    if (disposed) return;
    disposed = true;
    off();
    listener(...args);
  });
  return () => {
    if (disposed) return;
    disposed = true;
    off();
  };
}

const log = rendererModules.log;
const terminal = rendererModules.terminal;
const tabs = rendererModules.tabs;
const settings = rendererModules.settings;
const daemonHandlers = rendererModules.daemonHandlers;
const { showStatusNotice } = rendererModules.notifications;
const { debounceButton, applyShortcutTooltips } = rendererModules.utils;
const { initCommandPalette } = rendererModules.commandPalette;
const { initStatusStrip } = rendererModules.statusStrip;
const { initModelSelectors, setupModelSelectorListeners, setupModelChangeListener, setPaneCliAttribute } = rendererModules.modelSelector;
const { PANE_ROLES, PANE_ROLE_BUNDLES } = rendererModules.config;
const bus = rendererModules.bus;
const { clearScopedIpcListeners, registerScopedIpcListener } = rendererModules.ipcRegistry;

const ipcListenerRegistry = new Map();

function trackIpcListener(channel, listener, dispose) {
  const key = String(channel || '');
  if (!key || typeof listener !== 'function' || typeof dispose !== 'function') return;
  let entries = ipcListenerRegistry.get(key);
  if (!entries) {
    entries = new Set();
    ipcListenerRegistry.set(key, entries);
  }
  entries.add({ listener, dispose });
}

function untrackIpcListener(channel, listener) {
  const key = String(channel || '');
  const entries = ipcListenerRegistry.get(key);
  if (!entries || entries.size === 0) return;
  for (const entry of Array.from(entries)) {
    if (entry.listener !== listener) continue;
    try {
      entry.dispose();
    } catch (_) {}
    entries.delete(entry);
    break;
  }
  if (entries.size === 0) {
    ipcListenerRegistry.delete(key);
  }
}

const ipcRenderer = {
  invoke: (channel, ...args) => invokeBridge(channel, ...args),
  on: (channel, listener) => {
    const dispose = onBridge(channel, listener);
    trackIpcListener(channel, listener, dispose);
    return dispose;
  },
  once: (channel, listener) => {
    const dispose = onceBridge(channel, listener);
    trackIpcListener(channel, listener, dispose);
    return dispose;
  },
  off: (channel, listener) => {
    untrackIpcListener(channel, listener);
  },
  removeListener: (channel, listener) => {
    untrackIpcListener(channel, listener);
  },
  removeAllListeners: (channel) => {
    if (typeof channel !== 'string' || !channel) {
      for (const [trackedChannel, entries] of ipcListenerRegistry.entries()) {
        for (const entry of Array.from(entries)) {
          try {
            entry.dispose();
          } catch (_) {}
        }
        ipcListenerRegistry.delete(trackedChannel);
      }
      return;
    }
    const entries = ipcListenerRegistry.get(channel);
    if (!entries || entries.size === 0) return;
    for (const entry of Array.from(entries)) {
      try {
        entry.dispose();
      } catch (_) {}
    }
    ipcListenerRegistry.delete(channel);
  },
  listenerCount: (channel) => {
    const entries = ipcListenerRegistry.get(String(channel || ''));
    return entries ? entries.size : 0;
  },
  eventNames: () => Array.from(ipcListenerRegistry.keys()),
};

const dynamicPtyIpcChannels = new Set();
const RENDERER_IPC_CHANNELS = Object.freeze([
  // 'feature-capabilities-updated' — scoped listeners only (renderer + oracle.js), cleaned by clearScopedIpcListeners
  // 'task-list-updated' — scoped listener in status-strip.js (SSOT), cleaned by clearScopedIpcListeners
  'global-escape-pressed',
  'watchdog-alert',
  'heartbeat-state-changed',
  'nudge-pane',
  'pane-enter',
  'unstick-pane',
  'restart-pane',
  'restart-all-panes',
  'agent-stuck-detected',
  'pane-cli-identity',
  'daemon-connected',
  'daemon-timeout',
  // Channels registered in submodules — must be cleaned up here too
  'activity-logged',         // tabs/activity.js
  'oracle:image-generated',  // tabs/oracle.js
  'pane-model-changed',      // model-selector.js
]);

function trackDynamicPtyIpcChannel(channel) {
  if (typeof channel !== 'string') return;
  if (channel.startsWith('pty-data-') || channel.startsWith('pty-exit-')) {
    dynamicPtyIpcChannels.add(channel);
  }
}

function untrackDynamicPtyIpcChannel(channel) {
  if (!dynamicPtyIpcChannels.has(channel)) return;
  if (typeof ipcRenderer.listenerCount === 'function' && ipcRenderer.listenerCount(channel) === 0) {
    dynamicPtyIpcChannels.delete(channel);
  }
}

function collectDynamicPtyIpcChannels() {
  const channels = new Set(dynamicPtyIpcChannels);
  if (typeof ipcRenderer.eventNames === 'function') {
    for (const channel of ipcRenderer.eventNames()) {
      if (typeof channel !== 'string') continue;
      if (channel.startsWith('pty-data-') || channel.startsWith('pty-exit-')) {
        channels.add(channel);
      }
    }
  }
  return channels;
}

function clearRendererIpcListeners() {
  if (typeof ipcRenderer.removeAllListeners !== 'function') return;
  for (const channel of RENDERER_IPC_CHANNELS) {
    ipcRenderer.removeAllListeners(channel);
  }
  for (const channel of collectDynamicPtyIpcChannels()) {
    ipcRenderer.removeAllListeners(channel);
  }
  dynamicPtyIpcChannels.clear();
  clearScopedIpcListeners();
}



const MAIN_PANE_CONTAINER_SELECTOR = '.main-pane-container';
const SIDE_PANES_CONTAINER_SELECTOR = '.side-panes-container';
let mainPaneId = '1';
const RESIZE_DEBOUNCE_MS = 175;
let resizeDebounceTimer = null;
let setupEventListenersBound = false;
let autonomyOnboardingHandlersBound = false;
let lifecycleUnloadHookBound = false;
let rendererLifecycleCleanupFns = [];

function registerRendererLifecycleCleanup(fn) {
  if (typeof fn === 'function') {
    rendererLifecycleCleanupFns.push(fn);
  }
}

function clearRendererLifecycleBindings() {
  if (resizeDebounceTimer) {
    clearTimeout(resizeDebounceTimer);
    resizeDebounceTimer = null;
  }

  const cleanupFns = rendererLifecycleCleanupFns;
  rendererLifecycleCleanupFns = [];
  for (const cleanup of cleanupFns) {
    try {
      cleanup();
    } catch (_) {}
  }
}

function ensureLifecycleUnloadHook() {
  if (lifecycleUnloadHookBound || typeof window?.addEventListener !== 'function') return;
  const unloadHandler = () => {
    clearRendererIpcListeners();
    clearRendererLifecycleBindings();
  };
  window.addEventListener('beforeunload', unloadHandler);
  lifecycleUnloadHookBound = true;
}

function asPositiveInt(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function _extractSessionNumberFromStatus(status) {
  if (!status || typeof status !== 'object') return null;
  return (
    asPositiveInt(status.session)
    || asPositiveInt(status.sessionNumber)
    || asPositiveInt(status.currentSession)
    || null
  );
}

function updateHeaderSessionBadge(sessionNumber) {
  const badge = document.getElementById('headerSessionBadge');
  if (!badge) return;

  if (asPositiveInt(sessionNumber)) {
    badge.textContent = `Session ${sessionNumber}`;
    badge.classList.remove('pending');
    badge.classList.add('ready');
    badge.title = `Current app session: ${sessionNumber}`;
    return;
  }

  badge.textContent = 'Session --';
  badge.classList.remove('ready');
  badge.classList.add('pending');
  badge.title = 'Current app session unavailable';
}

async function readSessionFromAppStatusFallback() {
  try {
    const status = await ipcRenderer.invoke('get-app-status');
    return _extractSessionNumberFromStatus(status);
  } catch (_) {
    return null;
  }
}

async function resolveCurrentSessionNumber() {
  return readSessionFromAppStatusFallback();
}

async function refreshHeaderSessionBadge() {
  const sessionNumber = await resolveCurrentSessionNumber();
  updateHeaderSessionBadge(sessionNumber);
}

function scheduleTerminalResize(delayMs = RESIZE_DEBOUNCE_MS) {
  if (resizeDebounceTimer) {
    clearTimeout(resizeDebounceTimer);
  }
  resizeDebounceTimer = setTimeout(() => {
    resizeDebounceTimer = null;
    terminal.handleResize();
  }, delayMs);
}

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

function _getMainPaneId() {
  return mainPaneId;
}

function _swapToMainPane(targetPaneId) {
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
    scheduleTerminalResize(0);
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
const STARTUP_OVERLAY_FADE_MS = 280;
const DAEMON_TIMEOUT_FALLBACK_MESSAGE = "SquidRun couldn't start the background daemon. Make sure Node.js 18+ is installed and try restarting the app.";
const STARTUP_LOADING_DEFAULT_MESSAGE = 'Starting SquidRun...';
const STARTUP_OVERLAY_ERROR_DISMISS_MS = 12000;
let autonomyOnboardingBusy = false;
const profileOnboardingState = {
  checkComplete: false,
  checking: false,
  required: false,
  completed: false,
};

function isAutonomyConsentRequired() {
  if (typeof settings.requiresAutonomyConsent !== 'function') return false;
  return settings.requiresAutonomyConsent();
}

function getAutonomyOnboardingElements() {
  return {
    overlay: document.getElementById('autonomyOnboardingOverlay'),
    enableButton: document.getElementById('autonomyEnableBtn'),
    declineButton: document.getElementById('autonomyDeclineBtn'),
  };
}

function showAutonomyOnboarding() {
  const { overlay } = getAutonomyOnboardingElements();
  if (!overlay) return;
  overlay.classList.add('open');
  overlay.setAttribute('aria-hidden', 'false');
}

function hideAutonomyOnboarding() {
  const { overlay } = getAutonomyOnboardingElements();
  if (!overlay) return;
  overlay.classList.remove('open');
  overlay.setAttribute('aria-hidden', 'true');
}

function setAutonomyOnboardingBusyState(isBusy) {
  const { enableButton, declineButton } = getAutonomyOnboardingElements();
  if (enableButton) enableButton.disabled = isBusy;
  if (declineButton) declineButton.disabled = isBusy;
}

async function handleAutonomyOnboardingChoice(enabled) {
  if (autonomyOnboardingBusy) return;
  autonomyOnboardingBusy = true;
  setAutonomyOnboardingBusyState(true);
  try {
    const result = await settings.setAutonomyConsentChoice(enabled);
    if (!result?.success) {
      showStatusNotice('Failed to save autonomy preference. Please try again.', 'warning', 3500);
      return;
    }

    hideAutonomyOnboarding();
    initState.autoSpawnChecked = false;
    checkInitComplete();
    showStatusNotice(
      enabled
        ? 'Autonomy enabled. Agents will skip native permission prompts.'
        : 'Autonomy disabled. Agents will use native permission prompts.',
      'info',
      3500
    );
  } catch (err) {
    log.error('Onboarding', 'Failed to save autonomy choice', err);
    showStatusNotice('Failed to save autonomy preference. Please try again.', 'warning', 3500);
  } finally {
    autonomyOnboardingBusy = false;
    setAutonomyOnboardingBusyState(false);
  }
}

function setupAutonomyOnboardingHandlers() {
  if (autonomyOnboardingHandlersBound) return;
  autonomyOnboardingHandlersBound = true;

  const { enableButton, declineButton } = getAutonomyOnboardingElements();
  if (enableButton) {
    enableButton.addEventListener('click', () => {
      handleAutonomyOnboardingChoice(true);
    });
  }
  if (declineButton) {
    declineButton.addEventListener('click', () => {
      handleAutonomyOnboardingChoice(false);
    });
  }
}

function checkInitComplete() {
  if (initState.settingsLoaded && initState.terminalsReady && !initState.autoSpawnChecked) {
    if (!profileOnboardingState.checkComplete) {
      log.info('Init', 'Waiting for profile onboarding check before auto-spawn');
      return;
    }

    if (profileOnboardingState.required && !profileOnboardingState.completed) {
      log.info('Init', 'Profile setup required before autonomy/auto-spawn');
      void openProfileModal({ enforceName: true, reload: false });
      return;
    }

    if (isAutonomyConsentRequired()) {
      log.info('Init', 'Autonomy consent required before auto-spawn');
      showAutonomyOnboarding();
      return;
    }

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
  void evaluateProfileOnboardingRequirement();
  checkInitComplete();
}

function markTerminalsReady() {
  initState.terminalsReady = true;
  log.info('Init', 'Terminals ready');

  checkInitComplete();
}

function dismissStartupLoadingOverlay() {
  const overlay = document.getElementById('startupLoadingOverlay');
  if (!overlay || overlay.dataset.dismissed === 'true') return;
  overlay.dataset.dismissed = 'true';
  overlay.classList.add('hidden');
  setTimeout(() => {
    if (overlay.parentNode) {
      overlay.parentNode.removeChild(overlay);
    }
  }, STARTUP_OVERLAY_FADE_MS + 40);
}

function setStartupLoadingOverlayState({ message = null, error = false, hideSpinner = false } = {}) {
  const overlay = document.getElementById('startupLoadingOverlay');
  if (!overlay || overlay.dataset.dismissed === 'true') return;

  const textElement = document.getElementById('startupLoadingText');
  const spinner = overlay.querySelector('.startup-loading-spinner');

  if (textElement && typeof message === 'string' && message.trim()) {
    textElement.textContent = message.trim();
  }

  overlay.classList.toggle('error', Boolean(error));

  if (spinner) {
    spinner.classList.toggle('hidden', Boolean(hideSpinner));
  }
}

function handleDaemonStartupTimeout(payload = null) {
  setStartupLoadingOverlayState({
    message: DAEMON_TIMEOUT_FALLBACK_MESSAGE,
    error: true,
    hideSpinner: true,
  });
  setTimeout(() => {
    dismissStartupLoadingOverlay();
  }, STARTUP_OVERLAY_ERROR_DISMISS_MS);
  updateConnectionStatus('Daemon unavailable. Open Settings or restart after installing Node.js 18+.');
  showStatusNotice(DAEMON_TIMEOUT_FALLBACK_MESSAGE, 12000);
  const timeoutMs = Number(payload?.timeoutMs) || 0;
  if (timeoutMs > 0) {
    log.warn('Init', `Daemon startup timeout after ${timeoutMs}ms`);
  } else {
    log.warn('Init', 'Daemon startup timeout received');
  }
}

function createFallbackRendererApi() {
  return {
    pty: {
      create: (paneId, workingDir) => ipcRenderer.invoke('pty-create', paneId, workingDir),
      write: (paneId, data, kernelMeta = null) => ipcRenderer.invoke('pty-write', paneId, data, kernelMeta),
      writeChunked: (paneId, fullText, options = {}, kernelMeta = null) =>
        ipcRenderer.invoke('pty-write-chunked', paneId, fullText, options, kernelMeta),
      sendTrustedEnter: () => ipcRenderer.invoke('send-trusted-enter'),
      clipboardWriteText: (text) => ipcRenderer.invoke('clipboard-write', text),
      clipboardPasteText: (text) => ipcRenderer.invoke('clipboard-paste-text', text),
      resize: (paneId, cols, rows, kernelMeta = null) => ipcRenderer.invoke('pty-resize', paneId, cols, rows, kernelMeta),
      kill: (paneId) => ipcRenderer.invoke('pty-kill', paneId),
      pause: (paneId) => ipcRenderer.invoke('pty-pause', paneId),
      resume: (paneId) => ipcRenderer.invoke('pty-resume', paneId),
      onData: (paneId, callback) => {
        const channel = `pty-data-${paneId}`;
        const listener = (_event, data) => callback(data);
        trackDynamicPtyIpcChannel(channel);
        const off = ipcRenderer.on(channel, listener);
        return () => {
          if (typeof off === 'function') {
            off();
          } else {
            ipcRenderer.removeListener(channel, listener);
          }
          untrackDynamicPtyIpcChannel(channel);
        };
      },
      removeAllDataListeners: (paneId) => {
        const channel = `pty-data-${paneId}`;
        ipcRenderer.removeAllListeners(channel);
        untrackDynamicPtyIpcChannel(channel);
      },
      onExit: (paneId, callback) => {
        const channel = `pty-exit-${paneId}`;
        const listener = (_event, code) => callback(code);
        trackDynamicPtyIpcChannel(channel);
        const off = ipcRenderer.on(channel, listener);
        return () => {
          if (typeof off === 'function') {
            off();
          } else {
            ipcRenderer.removeListener(channel, listener);
          }
          untrackDynamicPtyIpcChannel(channel);
        };
      },
      removeAllExitListeners: (paneId) => {
        const channel = `pty-exit-${paneId}`;
        ipcRenderer.removeAllListeners(channel);
        untrackDynamicPtyIpcChannel(channel);
      },
      onKernelBridgeEvent: (callback) => ipcRenderer.on('kernel:bridge-event', (_event, data) => callback(data)),
      onKernelBridgeStats: (callback) => ipcRenderer.on('kernel:bridge-stats', (_event, data) => callback(data)),
    },
    input: {
      editAction: (action) => ipcRenderer.invoke('input-edit-action', action),
    },
    claude: {
      spawn: (paneId, workingDir) => ipcRenderer.invoke('spawn-claude', paneId, workingDir),
    },
    paneHost: {
      inject: (paneId, payload = {}) => ipcRenderer.invoke('pane-host-inject', paneId, payload),
    },
    context: {
      read: () => ipcRenderer.invoke('read-shared-context'),
      write: (content) => ipcRenderer.invoke('write-shared-context', content),
      getPath: () => ipcRenderer.invoke('get-shared-context-path'),
    },
    project: {
      select: () => ipcRenderer.invoke('select-project'),
      get: () => ipcRenderer.invoke('get-project'),
      setContext: (payload = null) => ipcRenderer.invoke('set-project-context', payload),
      clearContext: () => ipcRenderer.invoke('clear-project-context'),
    },
    friction: {
      list: () => ipcRenderer.invoke('list-friction'),
      read: (filename) => ipcRenderer.invoke('read-friction', filename),
      delete: (filename) => ipcRenderer.invoke('delete-friction', filename),
      clear: () => ipcRenderer.invoke('clear-friction'),
    },
    screenshot: {
      save: (base64Data, originalName) => ipcRenderer.invoke('save-screenshot', base64Data, originalName),
      list: (options = null) => ipcRenderer.invoke('list-screenshots', options),
      delete: (filename) => ipcRenderer.invoke('delete-screenshot', filename),
      getPath: (filename) => ipcRenderer.invoke('get-screenshot-path', filename),
    },
    process: {
      spawn: (command, args, cwd) => ipcRenderer.invoke('spawn-process', command, args, cwd),
      list: () => ipcRenderer.invoke('list-processes'),
      kill: (processId) => ipcRenderer.invoke('kill-process', processId),
      getOutput: (processId) => ipcRenderer.invoke('get-process-output', processId),
    },
    voice: {
      transcribe: (audioBuffer) => ipcRenderer.invoke('voice:transcribe', audioBuffer),
    },
  };
}

// Merge renderer-local helpers into preload bridge API.
const fallbackApi = createFallbackRendererApi();
const squidrunApi = Object.assign({}, fallbackApi, bridgeApi, {
  settings: {
    get: () => settings.getSettings(),
    isDebugMode: () => settings.getSettings()?.debugMode || false,
  },
});
window.squidrun = squidrunApi;
window.squidrunAPI = squidrunApi;

function updateConnectionStatus(status) {
  const statusEl = document.getElementById('connectionStatus');
  if (statusEl) {
    statusEl.textContent = status;
  }
}

// Pane expansion state
let expandedPaneId = null;

function getPaneRoleBundle(paneId) {
  const id = String(paneId || '');
  const configuredBundle = PANE_ROLE_BUNDLES[id];
  const fallbackRole = PANE_ROLES[id] || `Pane ${id}`;
  const heading = configuredBundle?.heading || fallbackRole;
  const members = Array.isArray(configuredBundle?.members) && configuredBundle.members.length > 0
    ? configuredBundle.members
    : [fallbackRole];
  return { id, heading, members };
}

function closePaneRoleModal() {
  const overlay = document.getElementById('paneRoleModalOverlay');
  if (!overlay || !overlay.classList.contains('open')) return false;
  overlay.classList.remove('open');
  overlay.setAttribute('aria-hidden', 'true');
  return true;
}

function openPaneRoleModal(paneId) {
  const overlay = document.getElementById('paneRoleModalOverlay');
  const titleEl = document.getElementById('paneRoleModalTitle');
  const subtitleEl = document.getElementById('paneRoleModalSubtitle');
  const listEl = document.getElementById('paneRoleModalList');
  if (!overlay || !titleEl || !subtitleEl || !listEl) return;

  const bundle = getPaneRoleBundle(paneId);
  titleEl.textContent = `${bundle.heading} Role Bundle`;
  subtitleEl.textContent = `${bundle.heading} (Pane ${bundle.id})`;
  listEl.innerHTML = '';
  bundle.members.forEach((member) => {
    const item = document.createElement('li');
    item.textContent = member;
    listEl.appendChild(item);
  });

  overlay.classList.add('open');
  overlay.setAttribute('aria-hidden', 'false');
}

const PROFILE_EDITABLE_FIELDS = Object.freeze([
  'name',
  'experience_level',
  'communication_style',
  'domain_expertise',
  'notes',
]);

const PROFILE_EXPERIENCE_ORDER = Object.freeze(['beginner', 'tinkerer', 'developer', 'expert']);
const PROFILE_COMMUNICATION_ORDER = Object.freeze(['detailed', 'balanced', 'terse']);

const PROFILE_FALLBACK_SCHEMA = Object.freeze({
  experience_level: Object.freeze({
    beginner: 'Learning to code - explain concepts, avoid jargon, confirm before destructive actions',
    tinkerer: 'Builds real things but not formally trained - explain architecture decisions, skip basics, use plain language',
    developer: 'Junior dev, knows fundamentals - use technical terms freely, explain only non-obvious tradeoffs',
    expert: 'Pro dev - be terse, skip explanations unless asked, assume deep knowledge',
  }),
  communication_style: Object.freeze({
    detailed: 'Explain what you are doing and why',
    balanced: 'Brief context, focus on action',
    terse: 'Just do it, minimal commentary',
  }),
});

let profileModalBusy = false;
let profileModalSchema = null;
let profileOnboardingEnforced = false;

function cloneJsonValue(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_) {
    return null;
  }
}

function getProfileFallbackSchema() {
  const cloned = cloneJsonValue(PROFILE_FALLBACK_SCHEMA);
  return cloned && typeof cloned === 'object' ? cloned : {};
}

function isObjectRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getProfileModalElements() {
  return {
    overlay: document.getElementById('profileModalOverlay'),
    form: document.getElementById('profileModalForm'),
    closeBtn: document.getElementById('profileModalClose'),
    cancelBtn: document.getElementById('profileModalCancel'),
    saveBtn: document.getElementById('profileModalSave'),
    nameInput: document.getElementById('profileNameInput'),
    nameRequiredIndicator: document.getElementById('profileNameRequiredIndicator'),
    experienceSelect: document.getElementById('profileExperienceSelect'),
    communicationSelect: document.getElementById('profileCommunicationStyleSelect'),
    domainTextarea: document.getElementById('profileDomainExpertiseInput'),
    notesTextarea: document.getElementById('profileNotesInput'),
    experienceHelper: document.getElementById('profileExperienceHelper'),
    communicationHelper: document.getElementById('profileCommunicationHelper'),
  };
}

function setProfileOnboardingMode(enforced) {
  profileOnboardingEnforced = Boolean(enforced);
  const {
    overlay,
    closeBtn,
    cancelBtn,
    nameInput,
    nameRequiredIndicator,
  } = getProfileModalElements();

  if (overlay) {
    overlay.classList.toggle('profile-modal-enforced', profileOnboardingEnforced);
  }
  if (closeBtn) {
    closeBtn.style.display = profileOnboardingEnforced ? 'none' : '';
  }
  if (cancelBtn) {
    cancelBtn.style.display = profileOnboardingEnforced ? 'none' : '';
  }
  if (nameInput) {
    nameInput.required = profileOnboardingEnforced;
    nameInput.classList.toggle('profile-onboarding-required', profileOnboardingEnforced);
    nameInput.setAttribute('aria-required', profileOnboardingEnforced ? 'true' : 'false');
  }
  if (nameRequiredIndicator) {
    nameRequiredIndicator.hidden = !profileOnboardingEnforced;
  }
}

function closeProfileModal(options = {}) {
  const force = options.force === true;
  if (profileOnboardingEnforced && !force) return false;
  const { overlay } = getProfileModalElements();
  if (!overlay || !overlay.classList.contains('open')) return false;
  overlay.classList.remove('open');
  overlay.setAttribute('aria-hidden', 'true');
  setProfileOnboardingMode(false);
  return true;
}

function setProfileModalBusyState(isBusy) {
  profileModalBusy = Boolean(isBusy);
  const { saveBtn, cancelBtn, closeBtn } = getProfileModalElements();
  if (saveBtn) saveBtn.disabled = profileModalBusy;
  if (cancelBtn) cancelBtn.disabled = profileModalBusy;
  if (closeBtn) closeBtn.disabled = profileModalBusy;
}

function toDisplayLabel(value) {
  const raw = String(value || '');
  if (!raw) return '';
  return raw
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(' ');
}

function normalizeProfileSchemaSection(schema, key, fallback) {
  const candidate = isObjectRecord(schema) && isObjectRecord(schema[key]) ? schema[key] : null;
  if (candidate) return candidate;
  return fallback;
}

function buildOptionOrder(schemaSection, fallbackOrder = []) {
  const seen = new Set();
  const ordered = [];
  for (const key of fallbackOrder) {
    if (!schemaSection || !Object.prototype.hasOwnProperty.call(schemaSection, key)) continue;
    ordered.push(key);
    seen.add(key);
  }
  for (const key of Object.keys(schemaSection || {})) {
    if (seen.has(key)) continue;
    ordered.push(key);
  }
  return ordered;
}

function renderProfileHelper(container, schemaSection, optionOrder, selectedValue) {
  if (!container) return;
  container.innerHTML = '';

  const list = document.createElement('div');
  list.className = 'profile-modal-helper-list';

  optionOrder.forEach((optionKey) => {
    const item = document.createElement('div');
    item.className = 'profile-modal-helper-item';
    item.dataset.optionKey = optionKey;
    if (optionKey === selectedValue) {
      item.classList.add('selected');
    }

    const keyEl = document.createElement('span');
    keyEl.className = 'profile-modal-helper-key';
    keyEl.textContent = toDisplayLabel(optionKey);

    const textEl = document.createElement('span');
    textEl.className = 'profile-modal-helper-text';
    textEl.textContent = String(schemaSection?.[optionKey] || '');

    item.appendChild(keyEl);
    item.appendChild(textEl);
    list.appendChild(item);
  });

  container.appendChild(list);
}

function highlightProfileHelperSelection(container, selectedValue) {
  if (!container) return;
  const items = container.querySelectorAll('.profile-modal-helper-item');
  items.forEach((item) => {
    item.classList.toggle('selected', item.dataset.optionKey === String(selectedValue || ''));
  });
}

function populateProfileSelect(selectEl, schemaSection, fallbackOrder, selectedValue) {
  if (!selectEl) return '';

  const current = typeof selectedValue === 'string' ? selectedValue : '';
  const firstOption = selectEl.querySelector('option[value=""]');
  const placeholderLabel = firstOption ? firstOption.textContent : 'Select option';

  selectEl.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = placeholderLabel;
  selectEl.appendChild(placeholder);

  const optionOrder = buildOptionOrder(schemaSection, fallbackOrder);
  optionOrder.forEach((optionKey) => {
    const option = document.createElement('option');
    option.value = optionKey;
    option.textContent = toDisplayLabel(optionKey);
    selectEl.appendChild(option);
  });

  if (current && !optionOrder.includes(current)) {
    const custom = document.createElement('option');
    custom.value = current;
    custom.textContent = toDisplayLabel(current);
    selectEl.appendChild(custom);
    optionOrder.push(current);
  }

  selectEl.value = current;
  return current;
}

function normalizeProfilePayload(profile) {
  const payload = isObjectRecord(profile) ? profile : {};
  const normalized = {};
  PROFILE_EDITABLE_FIELDS.forEach((field) => {
    normalized[field] = typeof payload[field] === 'string' ? payload[field] : '';
  });
  return normalized;
}

function applyProfileToModal(profile) {
  const {
    nameInput,
    experienceSelect,
    communicationSelect,
    domainTextarea,
    notesTextarea,
    experienceHelper,
    communicationHelper,
  } = getProfileModalElements();

  const normalized = normalizeProfilePayload(profile);
  const schemaSource = isObjectRecord(profile?.schema) ? profile.schema : getProfileFallbackSchema();
  profileModalSchema = cloneJsonValue(schemaSource) || getProfileFallbackSchema();

  const experienceSchema = normalizeProfileSchemaSection(
    schemaSource,
    'experience_level',
    PROFILE_FALLBACK_SCHEMA.experience_level
  );
  const communicationSchema = normalizeProfileSchemaSection(
    schemaSource,
    'communication_style',
    PROFILE_FALLBACK_SCHEMA.communication_style
  );

  if (nameInput) nameInput.value = normalized.name;
  if (domainTextarea) domainTextarea.value = normalized.domain_expertise;
  if (notesTextarea) notesTextarea.value = normalized.notes;

  const selectedExperience = populateProfileSelect(
    experienceSelect,
    experienceSchema,
    PROFILE_EXPERIENCE_ORDER,
    normalized.experience_level
  );
  const selectedCommunication = populateProfileSelect(
    communicationSelect,
    communicationSchema,
    PROFILE_COMMUNICATION_ORDER,
    normalized.communication_style
  );

  renderProfileHelper(
    experienceHelper,
    experienceSchema,
    buildOptionOrder(experienceSchema, PROFILE_EXPERIENCE_ORDER),
    selectedExperience
  );
  renderProfileHelper(
    communicationHelper,
    communicationSchema,
    buildOptionOrder(communicationSchema, PROFILE_COMMUNICATION_ORDER),
    selectedCommunication
  );
}

async function openProfileModal(options = {}) {
  const enforceName = options.enforceName === true
    || (profileOnboardingState.required && !profileOnboardingState.completed);
  const reload = options.reload !== false;
  const { overlay, form } = getProfileModalElements();
  if (!overlay || !form) return;

  const alreadyOpen = overlay.classList.contains('open');
  setProfileOnboardingMode(enforceName);
  overlay.classList.add('open');
  overlay.setAttribute('aria-hidden', 'false');

  if (alreadyOpen && !reload) {
    return;
  }

  if (profileModalBusy) return;
  setProfileModalBusyState(true);

  try {
    const result = await ipcRenderer.invoke('get-user-profile');
    if (!result?.success) {
      applyProfileToModal({});
      showStatusNotice(result?.error || 'Failed to load user profile. You can still save a new one.', 'warning', 3200);
      return;
    }
    applyProfileToModal(result.profile || {});
  } catch (err) {
    log.error('ProfileModal', `Failed to load profile: ${err?.message || err}`);
    applyProfileToModal({});
    showStatusNotice('Failed to load user profile. You can still save a new one.', 'warning', 3200);
  } finally {
    setProfileModalBusyState(false);
  }
}

function buildProfileSavePayload() {
  const {
    nameInput,
    experienceSelect,
    communicationSelect,
    domainTextarea,
    notesTextarea,
  } = getProfileModalElements();

  return {
    name: nameInput?.value || '',
    experience_level: experienceSelect?.value || '',
    communication_style: communicationSelect?.value || '',
    domain_expertise: domainTextarea?.value || '',
    notes: notesTextarea?.value || '',
    schema: cloneJsonValue(profileModalSchema) || getProfileFallbackSchema(),
  };
}

async function saveProfileFromModal() {
  if (profileModalBusy) return;
  setProfileModalBusyState(true);

  try {
    const payload = buildProfileSavePayload();
    if (profileOnboardingEnforced && !String(payload.name || '').trim()) {
      const { nameInput } = getProfileModalElements();
      showStatusNotice('Name is required to continue setup.', 'warning', 2800);
      if (nameInput && typeof nameInput.focus === 'function') {
        nameInput.focus();
      }
      return;
    }
    const result = await ipcRenderer.invoke('save-user-profile', payload);
    if (!result?.success) {
      showStatusNotice(result?.error || 'Failed to save user profile.', 'warning', 3200);
      return;
    }

    const savedSchema = isObjectRecord(result.profile?.schema)
      ? result.profile.schema
      : payload.schema;
    profileModalSchema = cloneJsonValue(savedSchema) || getProfileFallbackSchema();
    const completedOnboarding = profileOnboardingEnforced && String(result.profile?.name || payload.name || '').trim().length > 0;
    if (completedOnboarding) {
      profileOnboardingState.required = false;
      profileOnboardingState.completed = true;
      closeProfileModal({ force: true });
      if (initState.settingsLoaded && isAutonomyConsentRequired()) {
        showAutonomyOnboarding();
      }
      checkInitComplete();
    } else {
      closeProfileModal({ force: true });
    }
    showStatusNotice('User profile saved.', 'info', 2200);
  } catch (err) {
    log.error('ProfileModal', `Failed to save profile: ${err?.message || err}`);
    showStatusNotice('Failed to save user profile.', 'warning', 3200);
  } finally {
    setProfileModalBusyState(false);
  }
}

async function evaluateProfileOnboardingRequirement() {
  if (profileOnboardingState.checkComplete || profileOnboardingState.checking) return;
  profileOnboardingState.checking = true;

  try {
    const result = await ipcRenderer.invoke('get-user-profile');
    const existingName = String(result?.profile?.name || '').trim();
    const requiresProfile = existingName.length === 0;
    profileOnboardingState.required = requiresProfile;
    profileOnboardingState.completed = !requiresProfile;

    if (requiresProfile) {
      log.info('Init', 'First-run profile setup required');
      void openProfileModal({ enforceName: true, reload: true });
    } else if (initState.settingsLoaded && isAutonomyConsentRequired()) {
      showAutonomyOnboarding();
    }
  } catch (err) {
    log.error('Init', `Failed profile onboarding check: ${err?.message || err}`);
    profileOnboardingState.required = true;
    profileOnboardingState.completed = false;
    void openProfileModal({ enforceName: true, reload: true });
  } finally {
    profileOnboardingState.checking = false;
    profileOnboardingState.checkComplete = true;
    checkInitComplete();
  }
}

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
  // ResizeObserver in terminal.js handles resize automatically when element dimensions change
}

// Status Strip - imported from modules/status-strip.js

// Wire up module callbacks
terminal.setStatusCallbacks(null, updateConnectionStatus);
tabs.setConnectionStatusCallback(updateConnectionStatus);
settings.setConnectionStatusCallback(updateConnectionStatus);
settings.setSettingsLoadedCallback(markSettingsLoaded);
daemonHandlers.setStatusCallbacks(updateConnectionStatus);


// Setup event listeners
function setupEventListeners() {
  if (setupEventListenersBound) return;
  setupEventListenersBound = true;

  // Window resize handled by ResizeObserver in terminal.js (observes .pane-terminal containers)

  // Keyboard shortcuts (consolidated — Ctrl+N focus + ESC collapse)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && closeProfileModal()) {
      e.preventDefault();
      return;
    }
    if (e.key === 'Escape' && closePaneRoleModal()) {
      e.preventDefault();
      return;
    }
    // Ctrl+number to focus panes
    if (e.ctrlKey && terminal.PANE_IDS.includes(e.key)) {
      e.preventDefault();
      terminal.focusPane(e.key);
      return;
    }
    // ESC to collapse expanded pane
    if (e.key === 'Escape' && expandedPaneId) {
      toggleExpandPane(expandedPaneId);
    }
  });

  // Command bar input - Enter re-enabled (ghost text fix is in xterm, not here)
  const broadcastInput = document.getElementById('broadcastInput');
  const commandDeliveryStatus = document.getElementById('commandDeliveryStatus');
  const voiceInputBtn = document.getElementById('voiceInputBtn');
  const voiceStatus = document.getElementById('voiceStatus');
  let voiceEnabled = false;
  let voiceAutoSend = false;
  let voiceListening = false;
  let voiceCapabilityAvailable = true; // optimistic until capabilities load
  let voiceBase = '';
  let mediaRecorder = null;
  let audioChunks = [];
  let audioStream = null;
  let recordingStartTime = 0;
  const MIN_RECORDING_MS = 500;
  const WHISPER_HALLUCINATIONS = new Set([
    'you', 'thank you', 'thanks', 'bye', 'goodbye', 'hey',
    'thanks for watching', 'thank you for watching',
    'please subscribe', 'like and subscribe',
    'the end', 'so', 'um', 'uh', 'hmm', 'ah', 'oh',
  ]);
  let lastBroadcastTime = 0;

  // Keep command bar copy explicit now that target selection UI is removed.
  function updateCommandPlaceholder() {
    if (!broadcastInput) return;
    broadcastInput.placeholder = 'Type here to message Architect (Enter to send)';
    broadcastInput.title = 'Send message to Architect';
  }

  // showStatusNotice now imported from ./modules/notifications

  function updateVoiceUI(statusText) {
    if (voiceInputBtn) {
      voiceInputBtn.disabled = !voiceEnabled || !voiceCapabilityAvailable;
      voiceInputBtn.classList.toggle('is-listening', voiceListening);
      voiceInputBtn.setAttribute('aria-pressed', voiceListening ? 'true' : 'false');
      if (!voiceCapabilityAvailable) {
        voiceInputBtn.title = 'Set OpenAI key in Keys tab for voice input';
      } else {
        voiceInputBtn.title = 'Toggle voice input';
      }
    }
    if (broadcastInput) {
      broadcastInput.classList.toggle('voice-listening', voiceListening);
    }
    if (voiceStatus) {
      voiceStatus.textContent = statusText;
      voiceStatus.classList.toggle('is-listening', voiceListening);
    }
  }

  async function stopVoiceRecording() {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') return;
    return new Promise((resolve) => {
      mediaRecorder.onstop = async () => {
        voiceListening = false;

        const elapsed = Date.now() - recordingStartTime;
        const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
        audioChunks = [];

        // Gate: discard recordings shorter than MIN_RECORDING_MS
        if (elapsed < MIN_RECORDING_MS) {
          log.info('Voice', `Recording too short (${elapsed}ms), discarding`);
          updateVoiceUI('Too short');
          if (audioStream) { audioStream.getTracks().forEach(t => t.stop()); audioStream = null; }
          mediaRecorder = null;
          resolve();
          return;
        }

        updateVoiceUI('Transcribing...');

        try {
          const arrayBuf = await audioBlob.arrayBuffer();
          const result = await window.squidrun.voice.transcribe(new Uint8Array(arrayBuf));
          if (result.success && result.text) {
            const trimmed = result.text.trim();
            // Filter known Whisper silence hallucinations
            if (WHISPER_HALLUCINATIONS.has(trimmed.toLowerCase().replace(/[.!?,]+$/g, ''))) {
              log.info('Voice', `Filtered hallucination: "${trimmed}"`);
              updateVoiceUI('No speech detected');
            } else {
              const combined = `${voiceBase}${trimmed}`.trim();
              if (broadcastInput) {
                broadcastInput.value = combined;
                broadcastInput.dispatchEvent(new Event('input'));
              }
              if (voiceAutoSend && combined) {
                if (await sendBroadcast(combined)) {
                  if (broadcastInput) {
                    broadcastInput.value = '';
                    broadcastInput.style.height = '';
                    broadcastInput.focus();
                  }
                }
              }
              updateVoiceUI('Voice ready');
            }
          } else {
            log.error('Voice', 'Whisper transcription failed:', result.error);
            updateVoiceUI(result.code === 'MISSING_OPENAI_KEY' ? 'No API key' : 'Transcription failed');
          }
        } catch (err) {
          log.error('Voice', 'Whisper IPC error:', err);
          updateVoiceUI('Voice error');
        }

        // Release mic
        if (audioStream) {
          audioStream.getTracks().forEach(t => t.stop());
          audioStream = null;
        }
        mediaRecorder = null;
        resolve();
      };
      mediaRecorder.stop();
    });
  }

  async function startVoiceRecording() {
    if (!voiceEnabled) {
      updateVoiceUI('Voice off');
      return;
    }
    try {
      audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorder = new MediaRecorder(audioStream, { mimeType: 'audio/webm' });
      audioChunks = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunks.push(e.data);
      };

      voiceBase = (broadcastInput?.value || '').trim();
      if (voiceBase) voiceBase += ' ';

      mediaRecorder.start();
      recordingStartTime = Date.now();
      voiceListening = true;
      updateVoiceUI(voiceAutoSend ? 'Recording (auto-send)' : 'Recording');
    } catch (err) {
      log.error('Voice', 'Mic access failed:', err);
      if (err.name === 'NotAllowedError') {
        updateVoiceUI('Mic blocked');
        showStatusNotice('Microphone access denied. Check system permissions.', 8000);
      } else {
        updateVoiceUI('Mic error');
      }
    }
  }

  function refreshVoiceSettings(nextSettings) {
    const source = nextSettings || settings.getSettings() || {};
    voiceEnabled = !!source.voiceInputEnabled;
    voiceAutoSend = !!source.voiceAutoSend;
    if (!voiceEnabled) {
      stopVoiceRecording();
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
        showDeliveryStatus('queued');
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
    } else if (status === 'queued' || status === 'unverified') {
      commandDeliveryStatus.textContent = '…';
      setTimeout(() => {
        commandDeliveryStatus.classList.remove('visible');
      }, 2500);
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

  let activeBroadcastContextMenu = null;
  let activeBroadcastContextMenuCleanup = null;

  function dismissBroadcastContextMenu() {
    if (typeof activeBroadcastContextMenuCleanup === 'function') {
      try {
        activeBroadcastContextMenuCleanup();
      } catch (_) {}
    }
    activeBroadcastContextMenuCleanup = null;
    if (activeBroadcastContextMenu?.parentNode) {
      activeBroadcastContextMenu.parentNode.removeChild(activeBroadcastContextMenu);
    }
    activeBroadcastContextMenu = null;
  }

  function createBroadcastContextMenuItem(label, shortcut, disabled, onClick) {
    const item = document.createElement('div');
    item.className = `context-menu-item${disabled ? ' disabled' : ''}`;
    item.setAttribute('role', 'menuitem');
    item.setAttribute('tabindex', disabled ? '-1' : '0');

    const icon = document.createElement('span');
    icon.className = 'icon';
    icon.textContent = '';
    item.appendChild(icon);

    const text = document.createElement('span');
    text.textContent = label;
    item.appendChild(text);

    if (shortcut) {
      const badge = document.createElement('span');
      badge.className = 'shortcut';
      badge.textContent = shortcut;
      item.appendChild(badge);
    }

    if (!disabled && typeof onClick === 'function') {
      item.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick();
      });
    }

    return item;
  }

  async function runBroadcastInputFallbackAction(input, action) {
    if (!input) return false;
    switch (action) {
      case 'selectAll':
        input.select();
        return true;
      case 'paste': {
        const clipboardApi = (typeof navigator !== 'undefined' && navigator && navigator.clipboard)
          ? navigator.clipboard
          : null;
        if (!clipboardApi || typeof clipboardApi.readText !== 'function') return false;
        try {
          const clipboardText = await clipboardApi.readText();
          if (typeof input.setRangeText === 'function') {
            const start = typeof input.selectionStart === 'number' ? input.selectionStart : input.value.length;
            const end = typeof input.selectionEnd === 'number' ? input.selectionEnd : input.value.length;
            input.setRangeText(clipboardText, start, end, 'end');
          } else {
            input.value += clipboardText;
          }
          input.dispatchEvent(new Event('input'));
          return true;
        } catch {
          return false;
        }
      }
      case 'undo':
      case 'cut':
      case 'copy':
        if (typeof document?.execCommand !== 'function') return false;
        return document.execCommand(action);
      default:
        return false;
    }
  }

  async function runBroadcastInputAction(input, action) {
    if (!input) return false;
    input.focus();

    const editAction = window.squidrun?.input?.editAction;
    if (typeof editAction === 'function') {
      try {
        const result = await editAction(action);
        if (result?.success === true) {
          return true;
        }
      } catch (_) {}
    }

    return runBroadcastInputFallbackAction(input, action);
  }

  function openBroadcastContextMenu(event, input) {
    if (!input) return;
    event.preventDefault();
    event.stopPropagation();
    dismissBroadcastContextMenu();
    input.focus();

    const hasSelection = typeof input.selectionStart === 'number'
      && typeof input.selectionEnd === 'number'
      && input.selectionStart !== input.selectionEnd;
    const hasText = String(input.value || '').length > 0;
    const isEditable = !(input.disabled || input.readOnly);

    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.setAttribute('role', 'menu');

    menu.appendChild(createBroadcastContextMenuItem('Copy', 'Ctrl+C', !hasSelection, () => {
      void runBroadcastInputAction(input, 'copy');
      dismissBroadcastContextMenu();
    }));
    menu.appendChild(createBroadcastContextMenuItem('Paste', 'Ctrl+V', !isEditable, () => {
      void runBroadcastInputAction(input, 'paste');
      dismissBroadcastContextMenu();
    }));
    menu.appendChild(createBroadcastContextMenuItem('Cut', 'Ctrl+X', !isEditable || !hasSelection, () => {
      void runBroadcastInputAction(input, 'cut');
      dismissBroadcastContextMenu();
    }));
    menu.appendChild(createBroadcastContextMenuItem('Select All', 'Ctrl+A', !hasText, () => {
      void runBroadcastInputAction(input, 'selectAll');
      dismissBroadcastContextMenu();
    }));
    menu.appendChild(createBroadcastContextMenuItem('Undo', 'Ctrl+Z', !isEditable, () => {
      void runBroadcastInputAction(input, 'undo');
      dismissBroadcastContextMenu();
    }));

    document.body.appendChild(menu);
    activeBroadcastContextMenu = menu;

    const rect = menu.getBoundingClientRect();
    const maxLeft = Math.max(0, window.innerWidth - rect.width - 8);
    const maxTop = Math.max(0, window.innerHeight - rect.height - 8);
    const left = Math.max(8, Math.min(event.clientX, maxLeft));
    const top = Math.max(8, Math.min(event.clientY, maxTop));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;

    const onPointerDown = (pointerEvent) => {
      if (!menu.contains(pointerEvent.target)) {
        dismissBroadcastContextMenu();
      }
    };
    const onKeyDown = (keyEvent) => {
      if (keyEvent.key === 'Escape') {
        dismissBroadcastContextMenu();
      }
    };
    const onWindowBlur = () => dismissBroadcastContextMenu();

    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('contextmenu', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('blur', onWindowBlur, true);

    activeBroadcastContextMenuCleanup = () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('contextmenu', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('blur', onWindowBlur, true);
    };
  }

  updateCommandPlaceholder();

  // Helper function to send user text through PTY delivery path.
  function resolveDeliveryState(result) {
    const accepted = !result || result.success !== false;
    if (!accepted) {
      showDeliveryStatus('failed');
      return false;
    }
    if (result?.verified === false) {
      showDeliveryStatus('queued');
      return true;
    }
    showDeliveryStatus('delivered');
    return true;
  }

  function sendArchitectMessage(content) {
    return new Promise((resolve) => {
      terminal.broadcast(content, {
        onComplete: (result) => resolve(resolveDeliveryState(result)),
      });
    });
  }

  async function sendBroadcast(message) {
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
      return await routeNaturalTask(trimmed.slice(6));
    }

    // Direct command-bar messages default to Architect.
    return await sendArchitectMessage(message + '\r');
  }

  if (broadcastInput) {
    // Auto-grow textarea as user types
    const autoGrow = () => {
      broadcastInput.style.height = 'auto';
      broadcastInput.style.height = Math.min(broadcastInput.scrollHeight, 120) + 'px';
    };
    broadcastInput.addEventListener('input', autoGrow);
    broadcastInput.addEventListener('contextmenu', (event) => {
      openBroadcastContextMenu(event, broadcastInput);
    });

    broadcastInput.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        // Only allow trusted (real user) Enter presses
        if (!e.isTrusted) {
          e.preventDefault();
          log.info('Broadcast', 'Blocked untrusted Enter');
          return;
        }
        
        const input = broadcastInput;
        const message = input.value.trim();
        
        if (message) {
          e.preventDefault();
          // FIX: Clear immediately before async call to prevent race/stuck text on Windows
          input.value = '';
          input.style.height = '';
          input.focus();
          await sendBroadcast(message);
        }
      }
    });

    // Safeguard for Windows: clear any leftover newlines on keyup after Enter
    broadcastInput.addEventListener('keyup', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        if (broadcastInput.value === '\n' || broadcastInput.value === '\r\n') {
          broadcastInput.value = '';
          broadcastInput.style.height = '';
        }
      }
    });
  }

  // Broadcast button - also works (for accessibility)
  const broadcastBtn = document.getElementById('broadcastBtn');
  if (broadcastBtn) {
    broadcastBtn.addEventListener('click', async (e) => {
      // Must be trusted click event
      if (!e.isTrusted) {
        log.info('Broadcast', 'Blocked untrusted click');
        return;
      }
      const input = document.getElementById('broadcastInput');
      if (input && input.value && input.value.trim()) {
        const message = input.value.trim();
        // FIX: Clear immediately before async call
        input.value = '';
        input.style.height = '';
        input.focus();
        await sendBroadcast(message);
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
        stopVoiceRecording();
      } else {
        startVoiceRecording();
      }
    });
  }

  window.addEventListener('squidrun-settings-updated', (event) => {
    refreshVoiceSettings(event.detail);
    if (typeof terminal.refreshMirrorModeBindings === 'function') {
      terminal.refreshMirrorModeBindings();
    }
  });
  refreshVoiceSettings(settings.getSettings());
  if (typeof terminal.refreshMirrorModeBindings === 'function') {
    terminal.refreshMirrorModeBindings();
  }

  // Fetch initial voice capability
  ipcRenderer.invoke('get-feature-capabilities').then(caps => {
    if (caps) {
      voiceCapabilityAvailable = !!caps.voiceTranscriptionAvailable;
      updateVoiceUI(voiceCapabilityAvailable ? 'Voice ready' : 'No API key');
    }
  }).catch(() => {});

  // Listen for dynamic capability updates (scoped for consistent cleanup)
  registerScopedIpcListener('renderer-voice', 'feature-capabilities-updated', (event, caps) => {
    if (caps) {
      voiceCapabilityAvailable = !!caps.voiceTranscriptionAvailable;
      updateVoiceUI(voiceCapabilityAvailable ? 'Voice ready' : 'No API key');
    }
  });

  // Spawn all button (debounced)
  const spawnAllBtn = document.getElementById('spawnAllBtn');
  if (spawnAllBtn) {
    spawnAllBtn.addEventListener('click', debounceButton('spawnAll', terminal.spawnAllAgents));
  }

  // Pane action buttons: Interrupt (ESC), Enter, Restart
  document.querySelectorAll('.interrupt-btn').forEach(btn => {
    btn.addEventListener('click', async (_e) => {
      const paneId = btn.dataset.paneId;
      if (paneId) {
        log.info('Health', `Sending interrupt (Ctrl+C) to pane ${paneId}`);
        await terminal.interruptPane(paneId);
      }
    });
  });

  document.querySelectorAll('.unstick-btn').forEach(btn => {
    btn.addEventListener('click', (_e) => {
      const paneId = btn.dataset.paneId;
      if (paneId) {
        log.info('Health', `Sending Enter to pane ${paneId}`);
        terminal.nudgePane(paneId);
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


  // ESC collapse handler consolidated into setupEventListeners keyboard shortcuts listener

  // Shutdown button - kill daemon and exit app cleanly
  const fullRestartBtn = document.getElementById('fullRestartBtn');
  if (fullRestartBtn) {
    fullRestartBtn.addEventListener('click', async () => {
      if (confirm('Shutdown SquidRun and stop the daemon?\n\nAll active agent sessions will be terminated.\n\nContinue?')) {
        updateConnectionStatus('Shutting down...');
        try {
          await ipcRenderer.invoke('full-restart');
        } catch (err) {
          log.error('Shutdown', 'Full shutdown failed:', err);
          updateConnectionStatus('Shutdown failed - try manually');
        }
      }
    });
  }

  // Select Project button
  const selectProjectBtn = document.getElementById('selectProjectBtn');
  if (selectProjectBtn) {
    selectProjectBtn.addEventListener('click', daemonHandlers.selectProject);
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

  // Role bundle info button + modal
  document.querySelectorAll('.pane-role-info-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const paneId = btn.dataset.paneId;
      if (paneId) openPaneRoleModal(paneId);
    });
  });
  const paneRoleModalOverlay = document.getElementById('paneRoleModalOverlay');
  const paneRoleModalClose = document.getElementById('paneRoleModalClose');
  if (paneRoleModalClose) {
    paneRoleModalClose.addEventListener('click', () => {
      closePaneRoleModal();
    });
  }
  if (paneRoleModalOverlay) {
    paneRoleModalOverlay.addEventListener('click', (e) => {
      if (e.target === paneRoleModalOverlay) {
        closePaneRoleModal();
      }
    });
  }

  // User profile modal controls
  const profileBtn = document.getElementById('profileBtn');
  const profileModalOverlay = document.getElementById('profileModalOverlay');
  const profileModalClose = document.getElementById('profileModalClose');
  const profileModalCancel = document.getElementById('profileModalCancel');
  const profileModalSave = document.getElementById('profileModalSave');
  const profileModalForm = document.getElementById('profileModalForm');
  const profileExperienceSelect = document.getElementById('profileExperienceSelect');
  const profileCommunicationSelect = document.getElementById('profileCommunicationStyleSelect');
  const profileExperienceHelper = document.getElementById('profileExperienceHelper');
  const profileCommunicationHelper = document.getElementById('profileCommunicationHelper');

  if (profileBtn) {
    profileBtn.addEventListener('click', () => {
      void openProfileModal();
    });
  }
  if (profileModalClose) {
    profileModalClose.addEventListener('click', () => {
      closeProfileModal();
    });
  }
  if (profileModalCancel) {
    profileModalCancel.addEventListener('click', () => {
      closeProfileModal();
    });
  }
  if (profileModalSave) {
    profileModalSave.addEventListener('click', () => {
      void saveProfileFromModal();
    });
  }
  if (profileModalForm) {
    profileModalForm.addEventListener('submit', (event) => {
      event.preventDefault();
      void saveProfileFromModal();
    });
  }
  if (profileModalOverlay) {
    profileModalOverlay.addEventListener('click', (event) => {
      if (event.target === profileModalOverlay) {
        closeProfileModal();
      }
    });
  }
  if (profileExperienceSelect) {
    profileExperienceSelect.addEventListener('change', () => {
      highlightProfileHelperSelection(profileExperienceHelper, profileExperienceSelect.value);
    });
  }
  if (profileCommunicationSelect) {
    profileCommunicationSelect.addEventListener('change', () => {
      highlightProfileHelperSelection(profileCommunicationHelper, profileCommunicationSelect.value);
    });
  }

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

// Command Palette - imported from modules/command-palette.js

// applyShortcutTooltips - imported from modules/utils.js

// Model Selector - imported from modules/model-selector.js

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', async () => {
  ensureLifecycleUnloadHook();
  clearRendererLifecycleBindings();
  clearRendererIpcListeners();
  if (typeof daemonHandlers.teardownDaemonListeners === 'function') {
    daemonHandlers.teardownDaemonListeners();
  }
  let startupOverlayResolved = false;
  setStartupLoadingOverlayState({
    message: STARTUP_LOADING_DEFAULT_MESSAGE,
    error: false,
    hideSpinner: false,
  });
  const resolveStartupOverlay = (reason, payload = null) => {
    if (startupOverlayResolved) return;
    startupOverlayResolved = true;
    if (reason === 'daemon-timeout') {
      handleDaemonStartupTimeout(payload);
    } else {
      dismissStartupLoadingOverlay();
    }
    void refreshHeaderSessionBadge();
  };

  ipcRenderer.once('daemon-connected', () => {
    resolveStartupOverlay('daemon-connected');
  });

  ipcRenderer.once('daemon-timeout', (_event, payload) => {
    resolveStartupOverlay('daemon-timeout', payload);
  });

  // Setup all event handlers
  setupEventListeners();
  setupAutonomyOnboardingHandlers();
  initMainPaneState();

  // Enhance shortcut tooltips for controls with keyboard hints
  applyShortcutTooltips();

  // Initialize global UI focus tracker for multi-pane focus restore
  terminal.initUIFocusTracker();

  // Status Strip - task counts at a glance
  initStatusStrip();
  await refreshHeaderSessionBadge();

  // Model Selector - per-pane model switching
  setupModelSelectorListeners();
  setupModelChangeListener();
  initModelSelectors();

  // Global ESC key handler - interrupt agent AND release keyboard
  ipcRenderer.on('global-escape-pressed', () => {
    // Send daemon-backed interrupt to focused pane so hidden-pane-host mode
    // still reaches the real agent process.
    const focusedPane = terminal.getFocusedPane();
    if (focusedPane) {
      terminal.interruptPane(focusedPane).catch(err => {
        log.error('ESC', 'Failed to send interrupt:', err);
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
      new Notification('SquidRun Alert', {
        body: 'Agents stuck - auto-nudged with ESC+Enter',
        icon: 'assets/squidrun-favicon-64.png',
        requireInteraction: true
      });
    } else if (Notification.permission !== 'denied') {
      Notification.requestPermission().then(perm => {
        if (perm === 'granted') {
          new Notification('SquidRun Alert', {
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
    } catch (_e) {
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

  ipcRenderer.on('pane-enter', async (event, data) => {
    const paneId = String(data?.paneId || '');
    if (!paneId) return;
    const hiddenPaneHostMode = settings.getSettings()?.hiddenPaneHostsEnabled === true;
    if (hiddenPaneHostMode && window.squidrun?.paneHost?.inject) {
      try {
        await window.squidrun.paneHost.inject(paneId, { message: '' });
        return;
      } catch (err) {
        log.warn('PaneControl', `pane-host Enter fallback for pane ${paneId}: ${err.message}`);
      }
    }

    const capabilities = typeof terminal.getPaneInjectionCapabilities === 'function'
      ? terminal.getPaneInjectionCapabilities(paneId)
      : null;

    try {
      if (capabilities?.enterMethod === 'pty') {
        terminal.lastTypedTime[paneId] = Date.now();
        await window.squidrun.pty.write(paneId, '\r');
        return;
      }

      terminal.focusPane(paneId);
      if (typeof terminal.sendEnterToPane === 'function') {
        await terminal.sendEnterToPane(paneId);
      } else {
        await window.squidrun.pty.sendTrustedEnter();
      }
    } catch (err) {
      log.error('PaneControl', `pane-enter failed for pane ${paneId}: ${err.message}`);
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

  // Task list updates handled by status-strip.js (SSOT for task-list-updated IPC)

  // Single agent stuck detection - notify user (we can't auto-ESC via PTY)
  // Track shown alerts to avoid spamming
  const stuckAlertShown = new Set();
  ipcRenderer.on('agent-stuck-detected', (event, data) => {
    const { paneId, idleTime, message: _message } = data;

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
      setPaneCliAttribute(paneId, 'claude');
      terminal.unregisterCodexPane(paneId);
    } else if (key.includes('codex')) {
      el.classList.add('codex');
      if (pane) pane.classList.add('cli-codex');
      setPaneCliAttribute(paneId, 'codex');
      terminal.registerCodexPane(paneId);
    } else if (key.includes('gemini')) {
      el.classList.add('gemini');
      if (pane) pane.classList.add('cli-gemini');
      setPaneCliAttribute(paneId, 'gemini');
      terminal.unregisterCodexPane(paneId);
    }
  });

  // Setup daemon handlers
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
  tabs.setupRightPanel(terminal.handleResize, bus);  // All tab setup now handled internally
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

  // ============================================================
  // Event Kernel Phase 4: Wire renderer events to event bus
  // ============================================================

  // 1. Overlay events — observe settings panel + command palette open/close
  const settingsPanel = document.getElementById('settingsPanel');
  const cmdPaletteOverlay = document.getElementById('commandPaletteOverlay');
  const paneRoleModalOverlay = document.getElementById('paneRoleModalOverlay');
  const profileModalOverlay = document.getElementById('profileModalOverlay');

  // Aggregate overlay state: open if ANY overlay is open
  function updateOverlayState() {
    const settingsOpen = settingsPanel && settingsPanel.classList.contains('open');
    const paletteOpen = cmdPaletteOverlay && cmdPaletteOverlay.classList.contains('open');
    const roleModalOpen = paneRoleModalOverlay && paneRoleModalOverlay.classList.contains('open');
    const profileModalOpen = profileModalOverlay && profileModalOverlay.classList.contains('open');
    bus.updateState('system', { overlay: { open: !!(settingsOpen || paletteOpen || roleModalOpen || profileModalOpen) } });
  }

  if (settingsPanel) {
    const overlayObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.attributeName === 'class') {
          const isOpen = settingsPanel.classList.contains('open');
          bus.emit(isOpen ? 'overlay.opened' : 'overlay.closed', { paneId: 'system', payload: { overlay: 'settings' }, source: 'renderer.js' });
          updateOverlayState();
        }
      }
    });
    overlayObserver.observe(settingsPanel, { attributes: true, attributeFilter: ['class'] });
    registerRendererLifecycleCleanup(() => overlayObserver.disconnect());
  }

  if (cmdPaletteOverlay) {
    const paletteObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.attributeName === 'class') {
          const isOpen = cmdPaletteOverlay.classList.contains('open');
          bus.emit(isOpen ? 'overlay.opened' : 'overlay.closed', { paneId: 'system', payload: { overlay: 'command-palette' }, source: 'renderer.js' });
          updateOverlayState();
        }
      }
    });
    paletteObserver.observe(cmdPaletteOverlay, { attributes: true, attributeFilter: ['class'] });
    registerRendererLifecycleCleanup(() => paletteObserver.disconnect());
  }
  if (paneRoleModalOverlay) {
    const roleModalObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.attributeName === 'class') {
          const isOpen = paneRoleModalOverlay.classList.contains('open');
          bus.emit(isOpen ? 'overlay.opened' : 'overlay.closed', { paneId: 'system', payload: { overlay: 'role-modal' }, source: 'renderer.js' });
          updateOverlayState();
        }
      }
    });
    roleModalObserver.observe(paneRoleModalOverlay, { attributes: true, attributeFilter: ['class'] });
    registerRendererLifecycleCleanup(() => roleModalObserver.disconnect());
  }
  if (profileModalOverlay) {
    const profileModalObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.attributeName === 'class') {
          const isOpen = profileModalOverlay.classList.contains('open');
          bus.emit(isOpen ? 'overlay.opened' : 'overlay.closed', { paneId: 'system', payload: { overlay: 'profile-modal' }, source: 'renderer.js' });
          updateOverlayState();
        }
      }
    });
    profileModalObserver.observe(profileModalOverlay, { attributes: true, attributeFilter: ['class'] });
    registerRendererLifecycleCleanup(() => profileModalObserver.disconnect());
  }

  // 2. resize.requested — window resize events
  const onWindowResizeRequested = () => {
    bus.emit('resize.requested', {
      paneId: 'system',
      payload: { trigger: 'window_resize' },
      source: 'renderer.js',
    });
  };
  window.addEventListener('resize', onWindowResizeRequested);
  registerRendererLifecycleCleanup(() => window.removeEventListener('resize', onWindowResizeRequested));

  // 3. resize.requested — panel toggle (right panel)
  const panelBtn = document.getElementById('panelBtn');
  if (panelBtn) {
    const onPanelToggleResizeRequested = () => {
      bus.emit('resize.requested', {
        paneId: 'system',
        payload: { trigger: 'panel_toggle' },
        source: 'renderer.js',
      });
    };
    panelBtn.addEventListener('click', onPanelToggleResizeRequested);
    registerRendererLifecycleCleanup(() => panelBtn.removeEventListener('click', onPanelToggleResizeRequested));
  }

  // 4. pane.visibility.changed — pane expand/collapse
  document.querySelectorAll('.expand-btn').forEach(btn => {
    const onPaneVisibilityChanged = () => {
      const paneId = btn.dataset.paneId;
      if (paneId) {
        const pane = document.querySelector(`.pane[data-pane-id="${paneId}"]`);
        const visible = pane ? pane.classList.contains('pane-expanded') : true;
        bus.emit('pane.visibility.changed', {
          paneId,
          payload: { paneId, visible },
          source: 'renderer.js',
        });
      }
    };
    btn.addEventListener('click', onPaneVisibilityChanged);
    registerRendererLifecycleCleanup(() => btn.removeEventListener('click', onPaneVisibilityChanged));
  });

  // 5. ui.longtask.detected — PerformanceObserver for long tasks
  if (typeof PerformanceObserver !== 'undefined') {
    try {
      const longTaskObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          bus.emit('ui.longtask.detected', {
            paneId: 'system',
            payload: { durationMs: entry.duration, startTime: entry.startTime },
            source: 'renderer.js',
          });
        }
      });
      longTaskObserver.observe({ entryTypes: ['longtask'] });
      registerRendererLifecycleCleanup(() => {
        if (typeof longTaskObserver.takeRecords === 'function') {
          longTaskObserver.takeRecords();
        }
        if (typeof longTaskObserver.disconnect === 'function') {
          longTaskObserver.disconnect();
        }
      });
    } catch (_e) {
      // PerformanceObserver for longtask not supported — skip gracefully
    }
  }

});
