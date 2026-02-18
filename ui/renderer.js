/**
 * Hivemind Renderer - Main entry point
 * Orchestrates terminal, tabs, settings, and daemon handler modules
 */

const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');
const log = require('./modules/logger');

// Import modules
const terminal = require('./modules/terminal');
const tabs = require('./modules/tabs');
const settings = require('./modules/settings');
const daemonHandlers = require('./modules/daemon-handlers');
const { showStatusNotice } = require('./modules/notifications');
const { debounceButton, applyShortcutTooltips } = require('./modules/utils');
const { initCommandPalette } = require('./modules/command-palette');
const { initStatusStrip } = require('./modules/status-strip');
const { initModelSelectors, setupModelSelectorListeners, setupModelChangeListener, setPaneCliAttribute } = require('./modules/model-selector');
const bus = require('./modules/event-bus');
const { clearScopedIpcListeners, registerScopedIpcListener } = require('./modules/renderer-ipc-registry');

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
  'codex-activity',
  'agent-stuck-detected',
  'pane-cli-identity',
  'daemon-connected',
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
const APP_STATUS_FALLBACK_PATHS = Object.freeze([
  (() => {
    const os = require('os');
    const root = os.platform() === 'win32'
      ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'hivemind')
      : path.join(os.homedir(), '.config', 'hivemind');
    return path.join(root, 'app-status.json');
  })(),
  path.resolve(__dirname, '..', '.hivemind', 'app-status.json'),
  path.resolve(__dirname, '..', 'workspace', 'app-status.json'),
]);
let mainPaneId = '1';
const RESIZE_DEBOUNCE_MS = 175;
let resizeDebounceTimer = null;

function asPositiveInt(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function extractSessionNumberFromStatus(status) {
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

function readSessionFromAppStatusFallback() {
  for (const statusPath of APP_STATUS_FALLBACK_PATHS) {
    try {
      if (!fs.existsSync(statusPath)) continue;
      const raw = fs.readFileSync(statusPath, 'utf8');
      const parsed = JSON.parse(raw);
      const session = extractSessionNumberFromStatus(parsed);
      if (session) return session;
    } catch (err) {
      log.debug('HeaderSession', `Failed to read session from ${statusPath}: ${err.message}`);
    }
  }
  return null;
}

function resolveCurrentSessionNumber() {
  return readSessionFromAppStatusFallback();
}

function refreshHeaderSessionBadge() {
  const sessionNumber = resolveCurrentSessionNumber();
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

// Create hivemind API (merges with preload bridge to preserve workflow/graph/memory APIs)
window.hivemind = window.hivemind || {};
Object.assign(window.hivemind, {
  pty: {
    create: (paneId, workingDir) => ipcRenderer.invoke('pty-create', paneId, workingDir),
    write: (paneId, data, kernelMeta = null) => ipcRenderer.invoke('pty-write', paneId, data, kernelMeta),
    writeChunked: (paneId, fullText, options = {}, kernelMeta = null) =>
      ipcRenderer.invoke('pty-write-chunked', paneId, fullText, options, kernelMeta),
    sendTrustedEnter: () => ipcRenderer.invoke('send-trusted-enter'),
    clipboardPasteText: (text) => ipcRenderer.invoke('clipboard-paste-text', text),
    resize: (paneId, cols, rows, kernelMeta = null) => ipcRenderer.invoke('pty-resize', paneId, cols, rows, kernelMeta),
    kill: (paneId) => ipcRenderer.invoke('pty-kill', paneId),
    pause: (paneId) => ipcRenderer.invoke('pty-pause', paneId),
    resume: (paneId) => ipcRenderer.invoke('pty-resume', paneId),
    onData: (paneId, callback) => {
      const channel = `pty-data-${paneId}`;
      const listener = (event, data) => callback(data);
      trackDynamicPtyIpcChannel(channel);
      ipcRenderer.on(channel, listener);
      return () => {
        if (typeof ipcRenderer.off === 'function') {
          ipcRenderer.off(channel, listener);
        } else if (typeof ipcRenderer.removeListener === 'function') {
          ipcRenderer.removeListener(channel, listener);
        }
        untrackDynamicPtyIpcChannel(channel);
      };
    },
    onExit: (paneId, callback) => {
      const channel = `pty-exit-${paneId}`;
      const listener = (event, code) => callback(code);
      trackDynamicPtyIpcChannel(channel);
      ipcRenderer.on(channel, listener);
      return () => {
        if (typeof ipcRenderer.off === 'function') {
          ipcRenderer.off(channel, listener);
        } else if (typeof ipcRenderer.removeListener === 'function') {
          ipcRenderer.removeListener(channel, listener);
        }
        untrackDynamicPtyIpcChannel(channel);
      };
    },
    onKernelBridgeEvent: (callback) => {
      const channel = 'kernel:bridge-event';
      const listener = (event, data) => callback(data);
      ipcRenderer.on(channel, listener);
      return () => {
        if (typeof ipcRenderer.off === 'function') {
          ipcRenderer.off(channel, listener);
        } else if (typeof ipcRenderer.removeListener === 'function') {
          ipcRenderer.removeListener(channel, listener);
        }
      };
    },
    onKernelBridgeStats: (callback) => {
      const channel = 'kernel:bridge-stats';
      const listener = (event, data) => callback(data);
      ipcRenderer.on(channel, listener);
      return () => {
        if (typeof ipcRenderer.off === 'function') {
          ipcRenderer.off(channel, listener);
        } else if (typeof ipcRenderer.removeListener === 'function') {
          ipcRenderer.removeListener(channel, listener);
        }
      };
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
  // Settings API - expose settings module for debugMode check etc.
  settings: {
    get: () => settings.getSettings(),
    isDebugMode: () => settings.getSettings()?.debugMode || false,
  },
});

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
  // ResizeObserver in terminal.js handles resize automatically when element dimensions change
}

// Status Strip - imported from modules/status-strip.js

// Wire up module callbacks
terminal.setStatusCallbacks(updatePaneStatus, updateConnectionStatus);
tabs.setConnectionStatusCallback(updateConnectionStatus);
settings.setConnectionStatusCallback(updateConnectionStatus);
settings.setSettingsLoadedCallback(markSettingsLoaded);
daemonHandlers.setStatusCallbacks(updateConnectionStatus, updatePaneStatus);


// Setup event listeners
function setupEventListeners() {
  // Window resize handled by ResizeObserver in terminal.js (observes .pane-terminal containers)

  // Keyboard shortcuts (consolidated — Ctrl+N focus + ESC collapse)
  document.addEventListener('keydown', (e) => {
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
  const MIN_REC[private-live-ops]NG_MS = 500;
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

        // Gate: discard recordings shorter than MIN_REC[private-live-ops]NG_MS
        if (elapsed < MIN_REC[private-live-ops]NG_MS) {
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
          const result = await window.hivemind.voice.transcribe(Buffer.from(arrayBuf));
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

  window.addEventListener('hivemind-settings-updated', (event) => {
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

  // Pane action buttons: Interrupt (ESC), Enter, Restart
  document.querySelectorAll('.interrupt-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const paneId = btn.dataset.paneId;
      if (paneId) {
        log.info('Health', `Sending ESC to pane ${paneId}`);
        terminal.sendUnstick(paneId);
      }
    });
  });

  document.querySelectorAll('.unstick-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
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
  clearRendererIpcListeners();
  if (typeof daemonHandlers.teardownDaemonListeners === 'function') {
    daemonHandlers.teardownDaemonListeners();
  }
  ipcRenderer.once('daemon-connected', () => {
    dismissStartupLoadingOverlay();
  });

  // Setup all event handlers
  setupEventListeners();
  initMainPaneState();

  // Enhance shortcut tooltips for controls with keyboard hints
  applyShortcutTooltips();

  // Initialize global UI focus tracker for multi-pane focus restore
  terminal.initUIFocusTracker();

  // Status Strip - task counts at a glance
  initStatusStrip();
  refreshHeaderSessionBadge();

  // Model Selector - per-pane model switching
  setupModelSelectorListeners();
  setupModelChangeListener();
  initModelSelectors();

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

  ipcRenderer.on('pane-enter', async (event, data) => {
    const paneId = String(data?.paneId || '');
    if (!paneId) return;
    const hiddenPaneHostMode = process.env.HIVEMIND_HIDDEN_PANE_HOSTS === '1'
      || settings.getSettings()?.hiddenPaneHostsEnabled === true;
    if (hiddenPaneHostMode && window.hivemind?.paneHost?.inject) {
      try {
        await window.hivemind.paneHost.inject(paneId, { message: '' });
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
        await window.hivemind.pty.write(paneId, '\r');
        return;
      }

      terminal.focusPane(paneId);
      if (typeof terminal.sendEnterToPane === 'function') {
        await terminal.sendEnterToPane(paneId);
      } else {
        await window.hivemind.pty.sendTrustedEnter();
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
    }, 500);
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

  // Aggregate overlay state: open if ANY overlay is open
  function updateOverlayState() {
    const settingsOpen = settingsPanel && settingsPanel.classList.contains('open');
    const paletteOpen = cmdPaletteOverlay && cmdPaletteOverlay.classList.contains('open');
    bus.updateState('system', { overlay: { open: !!(settingsOpen || paletteOpen) } });
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
  }

  // 2. resize.requested — window resize events
  window.addEventListener('resize', () => {
    bus.emit('resize.requested', {
      paneId: 'system',
      payload: { trigger: 'window_resize' },
      source: 'renderer.js',
    });
  });

  // 3. resize.requested — panel toggle (right panel)
  const panelBtn = document.getElementById('panelBtn');
  if (panelBtn) {
    panelBtn.addEventListener('click', () => {
      bus.emit('resize.requested', {
        paneId: 'system',
        payload: { trigger: 'panel_toggle' },
        source: 'renderer.js',
      });
    });
  }

  // 4. pane.visibility.changed — pane expand/collapse
  document.querySelectorAll('.expand-btn').forEach(btn => {
    btn.addEventListener('click', () => {
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
    });
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
    } catch (e) {
      // PerformanceObserver for longtask not supported — skip gracefully
    }
  }

});
