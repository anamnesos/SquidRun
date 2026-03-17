const { BrowserWindow } = require('electron');
const path = require('path');
const log = require('../logger');
const {
  DEFAULT_INJECT_IPC_CHUNK_THRESHOLD_BYTES,
  DEFAULT_INJECT_IPC_CHUNK_SIZE_BYTES,
} = require('../inject-message-ipc');
const IS_DARWIN = process.platform === 'darwin';
// Windows PowerShell/PSReadLine can drop characters when hm-send pastes
// a few hundred bytes as one instant PTY write, so chunk earlier there.
const DEFAULT_HM_SEND_CHUNK_THRESHOLD_BYTES = IS_DARWIN ? 1024 : 256;
const HIDDEN_PANE_HOST_WIDTH = IS_DARWIN ? 1400 : 1200;
const HIDDEN_PANE_HOST_HEIGHT = IS_DARWIN ? 600 : 500;
const PANE_HOST_QUERY_ENV_MAP = Object.freeze({
  verifyTimeoutMs: 'SQUIDRUN_PANE_HOST_VERIFY_TIMEOUT_MS',
  activeOutputWindowMs: 'SQUIDRUN_PANE_HOST_ACTIVE_OUTPUT_WINDOW_MS',
  submitDeferMaxWaitMs: 'SQUIDRUN_PANE_HOST_SUBMIT_DEFER_MAX_WAIT_MS',
  submitDeferMaxWaitLongMs: 'SQUIDRUN_PANE_HOST_SUBMIT_DEFER_MAX_WAIT_LONG_MS',
  submitDeferPollMs: 'SQUIDRUN_PANE_HOST_SUBMIT_DEFER_POLL_MS',
  longPayloadBytes: 'SQUIDRUN_PANE_HOST_LONG_PAYLOAD_BYTES',
  hmSendVerifyTimeoutMs: 'SQUIDRUN_PANE_HOST_HM_SEND_VERIFY_TIMEOUT_MS',
  minEnterDelayMs: 'SQUIDRUN_PANE_HOST_MIN_ENTER_DELAY_MS',
  chunkThresholdBytes: 'SQUIDRUN_PANE_HOST_CHUNK_THRESHOLD_BYTES',
  chunkSizeBytes: 'SQUIDRUN_PANE_HOST_CHUNK_SIZE_BYTES',
  hmSendChunkThresholdBytes: 'SQUIDRUN_PANE_HOST_HM_SEND_CHUNK_THRESHOLD_BYTES',
  writeTimeoutMs: 'SQUIDRUN_PANE_HOST_WRITE_TIMEOUT_MS',
  enterTimeoutMs: 'SQUIDRUN_PANE_HOST_ENTER_TIMEOUT_MS',
});

function toNonEmptyString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function buildPaneHostQueryFromEnv(paneId) {
  const query = {};
  if (Array.isArray(paneId)) {
    query.paneIds = paneId.map((value) => String(value)).join(',');
  } else {
    query.paneId = String(paneId);
    query.paneIds = String(paneId);
  }
  for (const [queryKey, envKey] of Object.entries(PANE_HOST_QUERY_ENV_MAP)) {
    const value = toNonEmptyString(process.env[envKey]);
    if (value) {
      query[queryKey] = value;
    }
  }
  if (!query.chunkThresholdBytes) {
    query.chunkThresholdBytes = String(DEFAULT_INJECT_IPC_CHUNK_THRESHOLD_BYTES);
  }
  if (!query.chunkSizeBytes) {
    query.chunkSizeBytes = String(DEFAULT_INJECT_IPC_CHUNK_SIZE_BYTES);
  }
  if (!query.hmSendChunkThresholdBytes) {
    query.hmSendChunkThresholdBytes = String(DEFAULT_HM_SEND_CHUNK_THRESHOLD_BYTES);
  }
  return query;
}

function createPaneHostWindowManager(options = {}) {
  const {
    getCurrentSettings = () => ({}),
  } = options;

  let hostWindow = null;
  const hostedPaneIds = new Set();

  function getPaneHostHtmlPath() {
    return path.join(__dirname, '..', '..', 'pane-host.html');
  }

  function getPreloadPath() {
    return path.join(__dirname, '..', '..', 'preload.js');
  }

  function getAppIconPath() {
    return path.join(
      __dirname,
      '..',
      '..',
      'assets',
      process.platform === 'win32' ? 'squidrun-favicon.ico' : 'squidrun-favicon-256.png'
    );
  }

  function buildPaneHostQuery(paneId) {
    return buildPaneHostQueryFromEnv(paneId);
  }

  function getPaneWindow(paneId) {
    const id = String(paneId);
    if (!hostedPaneIds.has(id)) return null;
    if (!hostWindow || hostWindow.isDestroyed()) {
      hostWindow = null;
      hostedPaneIds.clear();
      return null;
    }
    return hostWindow;
  }

  async function createPaneWindow(paneId, allPaneIds = null) {
    const id = String(paneId);
    hostedPaneIds.add(id);
    const existing = getPaneWindow(id);
    if (existing) return existing;

    const paneIds = Array.isArray(allPaneIds) && allPaneIds.length > 0
      ? Array.from(new Set(allPaneIds.map((value) => String(value))))
      : Array.from(hostedPaneIds);

    const win = new BrowserWindow({
      width: HIDDEN_PANE_HOST_WIDTH,
      height: HIDDEN_PANE_HOST_HEIGHT,
      show: false,
      skipTaskbar: true,
      icon: getAppIconPath(),
      backgroundColor: '#0a0a0f',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false,
        backgroundThrottling: false,
        preload: getPreloadPath(),
      },
      title: `SquidRun Pane Host (${paneIds.join(', ')})`,
    });

    hostWindow = win;
    win.on('closed', () => {
      hostWindow = null;
      hostedPaneIds.clear();
    });

    await win.loadFile(getPaneHostHtmlPath(), { query: buildPaneHostQuery(paneIds) });

    const settings = getCurrentSettings() || {};
    if (settings.devTools && process.env.SQUIDRUN_PANE_HOST_DEVTOOLS === '1') {
      win.webContents.openDevTools({ mode: 'detach' });
    }

    return win;
  }

  async function ensurePaneWindows(paneIds = []) {
    const ids = Array.from(new Set((paneIds || []).map((paneId) => String(paneId))));
    for (const paneId of ids) {
      hostedPaneIds.add(paneId);
    }
    if (ids.length === 0) return;
    await createPaneWindow(ids[0], ids);
  }

  function sendToPaneWindow(paneId, channel, payload) {
    const id = String(paneId);
    const win = getPaneWindow(id);
    if (!win || !win.webContents) return false;
    try {
      if (typeof win.webContents.isLoadingMainFrame === 'function' && win.webContents.isLoadingMainFrame()) {
        win.webContents.once('did-finish-load', () => {
          try {
            win.webContents.send(channel, payload);
          } catch (err) {
            log.warn('PaneHost', `Deferred send failed for pane ${id}: ${err.message}`);
          }
        });
        return true;
      }
      win.webContents.send(channel, payload);
      return true;
    } catch (err) {
      log.warn('PaneHost', `Failed sending ${channel} to pane ${id}: ${err.message}`);
      return false;
    }
  }

  function closeAllPaneWindows() {
    if (hostWindow) {
      try {
        hostWindow.close();
      } catch (err) {
        log.warn('PaneHost', `Failed to close pane host window: ${err.message}`);
      }
    }
    hostWindow = null;
    hostedPaneIds.clear();
  }

  return {
    getPaneWindow,
    createPaneWindow,
    ensurePaneWindows,
    sendToPaneWindow,
    closeAllPaneWindows,
  };
}

module.exports = { createPaneHostWindowManager };
module.exports._internals = {
  buildPaneHostQueryFromEnv,
  DEFAULT_HM_SEND_CHUNK_THRESHOLD_BYTES,
};
