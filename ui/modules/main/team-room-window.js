'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parsePrivateNetworkOrigin } = require('./team-room-auth');
const { DEFAULT_COOKIE_NAME, writeJsonAtomic } = require('./team-room-runtime');

const DEFAULT_WINDOW_OPTIONS = Object.freeze({
  width: 980,
  height: 820,
  minWidth: 520,
  minHeight: 620,
  title: 'SquidRun Team Room',
  backgroundColor: '#0c1014',
  show: false,
  autoHideMenuBar: true,
  ...((process.platform === 'win32' || process.platform === 'linux') ? {
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0c1014',
      symbolColor: '#8fa1b3',
      height: 32,
    },
  } : {}),
});

const FORCED_WEB_PREFERENCES = Object.freeze({
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: true,
  partition: 'persist:squidrun-team-room',
  spellcheck: true,
});

function readRememberedBounds(statePath) {
  try {
    const value = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const width = Number(value.width);
    const height = Number(value.height);
    const x = Number(value.x);
    const y = Number(value.y);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 520 || height < 620) return null;
    return {
      width: Math.min(2400, Math.round(width)),
      height: Math.min(1800, Math.round(height)),
      ...(Number.isFinite(x) ? { x: Math.round(x) } : {}),
      ...(Number.isFinite(y) ? { y: Math.round(y) } : {}),
    };
  } catch {
    return null;
  }
}

function rememberBounds(windowRef, statePath) {
  if (!windowRef || windowRef.isDestroyed?.() || typeof windowRef.getBounds !== 'function') return;
  const bounds = windowRef.getBounds();
  if (!bounds || Number(bounds.width) < 520 || Number(bounds.height) < 620) return;
  writeJsonAtomic(statePath, {
    schema: 'squidrun.team_room_window.v1',
    x: Math.round(Number(bounds.x) || 0),
    y: Math.round(Number(bounds.y) || 0),
    width: Math.round(Number(bounds.width)),
    height: Math.round(Number(bounds.height)),
    updatedAtMs: Date.now(),
  });
}

async function createTeamRoomWindow(options = {}) {
  const BrowserWindow = options.BrowserWindow;
  if (!BrowserWindow || typeof BrowserWindow !== 'function') {
    throw new Error('createTeamRoomWindow requires options.BrowserWindow constructor');
  }
  const origin = String(options.origin || '').trim();
  const credentialToken = String(options.credentialToken || '').trim();
  const statePath = path.resolve(String(options.statePath || ''));
  const parsedOrigin = parsePrivateNetworkOrigin(origin);
  if (!parsedOrigin.ok || parsedOrigin.protocol !== 'http:') {
    throw new Error('team_room_window_private_origin_required');
  }
  if (!/^[A-Za-z0-9_-]{40,256}$/u.test(credentialToken)) {
    throw new Error('team_room_window_credential_required');
  }
  if (!statePath || statePath === path.parse(statePath).root) throw new Error('team_room_window_state_path_required');

  const remembered = readRememberedBounds(statePath);
  const overrides = options.windowOptions && typeof options.windowOptions === 'object' ? options.windowOptions : {};
  const windowOptions = {
    ...DEFAULT_WINDOW_OPTIONS,
    ...remembered,
    ...overrides,
    webPreferences: {
      ...(overrides.webPreferences || {}),
      ...FORCED_WEB_PREFERENCES,
    },
  };
  const windowRef = new BrowserWindow(windowOptions);
  const roomOrigin = parsedOrigin.origin;
  const cookieName = String(options.cookieName || DEFAULT_COOKIE_NAME);
  await windowRef.webContents.session.cookies.set({
    url: `${roomOrigin}/`,
    name: cookieName,
    value: credentialToken,
    httpOnly: true,
    sameSite: 'strict',
    secure: false,
    path: '/',
    expirationDate: Math.floor(Date.now() / 1000) + (12 * 60 * 60),
  });
  windowRef.webContents.setWindowOpenHandler?.(() => ({ action: 'deny' }));
  windowRef.webContents.on?.('will-navigate', (event, targetUrl) => {
    try {
      if (new URL(targetUrl).origin !== roomOrigin) event.preventDefault();
    } catch {
      event.preventDefault();
    }
  });
  let saveTimer = null;
  const queueSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      rememberBounds(windowRef, statePath);
    }, 180);
  };
  windowRef.on?.('resize', queueSave);
  windowRef.on?.('move', queueSave);
  windowRef.on?.('close', () => {
    if (saveTimer) clearTimeout(saveTimer);
    rememberBounds(windowRef, statePath);
  });
  if (options.showOnReady !== false) {
    windowRef.once?.('ready-to-show', () => windowRef.show?.());
  }
  await windowRef.loadURL(`${roomOrigin}/`);
  return { window: windowRef, origin: roomOrigin, statePath, options: windowOptions };
}

module.exports = {
  DEFAULT_WINDOW_OPTIONS,
  FORCED_WEB_PREFERENCES,
  createTeamRoomWindow,
  readRememberedBounds,
  rememberBounds,
};
