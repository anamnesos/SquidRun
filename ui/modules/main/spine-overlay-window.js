'use strict';

const path = require('path');

const DEFAULT_HTML_PATH = path.join(__dirname, '..', '..', 'spine-overlay.html');
const DEFAULT_PRELOAD_PATH = path.join(__dirname, '..', '..', 'preload.js');

const DEFAULT_WINDOW_OPTIONS = Object.freeze({
  width: 1220,
  height: 760,
  minWidth: 860,
  minHeight: 560,
  title: 'SquidRun Spine Overlay',
  backgroundColor: '#00000000',
  show: true,
  frame: false,
  transparent: true,
  hasShadow: false,
  alwaysOnTop: true,
  autoHideMenuBar: true,
});

const FORCED_WEB_PREFERENCES = Object.freeze({
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: false,
});

function resolveHtmlPath(value) {
  return path.resolve(value || DEFAULT_HTML_PATH);
}

function resolvePreloadPath(value) {
  return path.resolve(value || DEFAULT_PRELOAD_PATH);
}

function createSpineOverlayWindow(deps = {}) {
  const BrowserWindow = deps.BrowserWindow;
  if (!BrowserWindow || typeof BrowserWindow !== 'function') {
    throw new Error('createSpineOverlayWindow requires deps.BrowserWindow constructor');
  }

  const htmlPath = resolveHtmlPath(deps.htmlPath);
  const preloadPath = resolvePreloadPath(deps.preloadPath);
  const overrides = deps.windowOptions && typeof deps.windowOptions === 'object'
    ? deps.windowOptions
    : {};
  const options = {
    ...DEFAULT_WINDOW_OPTIONS,
    ...overrides,
    webPreferences: {
      ...(overrides.webPreferences || {}),
      ...FORCED_WEB_PREFERENCES,
      preload: preloadPath,
    },
  };

  const win = new BrowserWindow(options);
  if (typeof win.setAlwaysOnTop === 'function') {
    win.setAlwaysOnTop(true, 'screen-saver');
  }
  if (typeof win.loadFile === 'function') {
    win.loadFile(htmlPath);
  } else if (typeof win.loadURL === 'function') {
    win.loadURL(`file://${htmlPath}`);
  }

  return {
    window: win,
    htmlPath,
    preloadPath,
    options,
  };
}

module.exports = {
  DEFAULT_HTML_PATH,
  DEFAULT_PRELOAD_PATH,
  DEFAULT_WINDOW_OPTIONS,
  FORCED_WEB_PREFERENCES,
  createSpineOverlayWindow,
};
