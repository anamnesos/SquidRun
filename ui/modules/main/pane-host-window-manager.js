const { BrowserWindow } = require('electron');
const path = require('path');
const log = require('../logger');
const IS_DARWIN = process.platform === 'darwin';
const HIDDEN_PANE_HOST_WIDTH = IS_DARWIN ? 1400 : 1200;
const HIDDEN_PANE_HOST_HEIGHT = IS_DARWIN ? 600 : 500;

function createPaneHostWindowManager(options = {}) {
  const {
    getCurrentSettings = () => ({}),
  } = options;

  const paneWindows = new Map();

  function getPaneHostHtmlPath() {
    return path.join(__dirname, '..', '..', 'pane-host.html');
  }

  function getPreloadPath() {
    return path.join(__dirname, '..', '..', 'preload.js');
  }

  function getPaneWindow(paneId) {
    const id = String(paneId);
    const win = paneWindows.get(id);
    if (!win || win.isDestroyed()) {
      paneWindows.delete(id);
      return null;
    }
    return win;
  }

  async function createPaneWindow(paneId) {
    const id = String(paneId);
    const existing = getPaneWindow(id);
    if (existing) return existing;

    const win = new BrowserWindow({
      width: HIDDEN_PANE_HOST_WIDTH,
      height: HIDDEN_PANE_HOST_HEIGHT,
      show: false,
      backgroundColor: '#0a0a0f',
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        backgroundThrottling: false,
        preload: getPreloadPath(),
      },
      title: `Hivemind Pane Host ${id}`,
    });

    paneWindows.set(id, win);
    win.on('closed', () => {
      paneWindows.delete(id);
    });

    await win.loadFile(getPaneHostHtmlPath(), {
      query: { paneId: id },
    });

    const settings = getCurrentSettings() || {};
    if (settings.devTools && process.env.HIVEMIND_PANE_HOST_DEVTOOLS === '1') {
      win.webContents.openDevTools({ mode: 'detach' });
    }

    return win;
  }

  async function ensurePaneWindows(paneIds = []) {
    const ids = Array.from(new Set((paneIds || []).map((paneId) => String(paneId))));
    for (const paneId of ids) {
      await createPaneWindow(paneId);
    }
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
    for (const win of paneWindows.values()) {
      try {
        win.close();
      } catch (err) {
        log.warn('PaneHost', `Failed to close pane host window: ${err.message}`);
      }
    }
    paneWindows.clear();
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
