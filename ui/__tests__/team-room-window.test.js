'use strict';

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  FORCED_WEB_PREFERENCES,
  createTeamRoomWindow,
  readRememberedBounds,
} = require('../modules/main/team-room-window');

class FakeWebContents extends EventEmitter {
  constructor() {
    super();
    this.cookie = null;
    this.windowHandler = null;
    this.session = { cookies: { set: jest.fn(async (cookie) => { this.cookie = cookie; }) } };
  }

  setWindowOpenHandler(handler) { this.windowHandler = handler; }
}

class FakeWindow extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.webContents = new FakeWebContents();
    this.loadedUrl = null;
    this.shown = false;
    this.bounds = { x: 40, y: 50, width: options.width, height: options.height };
  }

  async loadURL(url) { this.loadedUrl = url; }
  show() { this.shown = true; }
  isDestroyed() { return false; }
  getBounds() { return this.bounds; }
}

describe('Team Room window', () => {
  let tempRoot;
  beforeEach(() => { tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-team-room-window-')); });
  afterEach(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  test('sets an HttpOnly cookie, enforces isolated web preferences, and remembers bounds without secrets', async () => {
    const statePath = path.join(tempRoot, 'window.json');
    const created = await createTeamRoomWindow({
      BrowserWindow: FakeWindow,
      origin: 'http://127.0.0.1:41234',
      credentialToken: 'a'.repeat(43),
      statePath,
    });
    expect(created.options.webPreferences).toEqual(expect.objectContaining(FORCED_WEB_PREFERENCES));
    expect(created.window.webContents.session.cookies.set).toHaveBeenCalledWith(expect.objectContaining({
      url: 'http://127.0.0.1:41234/',
      name: 'squidrun_team_room',
      value: 'a'.repeat(43),
      httpOnly: true,
      sameSite: 'strict',
    }));
    expect(created.window.loadedUrl).toBe('http://127.0.0.1:41234/');
    created.window.emit('ready-to-show');
    expect(created.window.shown).toBe(true);
    created.window.emit('close');
    const saved = fs.readFileSync(statePath, 'utf8');
    expect(saved).not.toContain('a'.repeat(43));
    expect(readRememberedBounds(statePath)).toEqual({ x: 40, y: 50, width: 980, height: 820 });
  });

  test('blocks navigation outside the exact room origin', async () => {
    const created = await createTeamRoomWindow({
      BrowserWindow: FakeWindow,
      origin: 'http://127.0.0.1:41234',
      credentialToken: 'b'.repeat(43),
      statePath: path.join(tempRoot, 'window.json'),
    });
    const external = { preventDefault: jest.fn() };
    created.window.webContents.emit('will-navigate', external, 'https://example.com/');
    expect(external.preventDefault).toHaveBeenCalledTimes(1);
    const internal = { preventDefault: jest.fn() };
    created.window.webContents.emit('will-navigate', internal, 'http://127.0.0.1:41234/');
    expect(internal.preventDefault).not.toHaveBeenCalled();
    expect(created.window.webContents.windowHandler()).toEqual({ action: 'deny' });
  });

  test('supports a hidden real-window smoke without changing the production default', async () => {
    const created = await createTeamRoomWindow({
      BrowserWindow: FakeWindow,
      origin: 'http://127.0.0.1:41234',
      credentialToken: 'c'.repeat(43),
      statePath: path.join(tempRoot, 'window.json'),
      showOnReady: false,
    });
    created.window.emit('ready-to-show');
    expect(created.window.shown).toBe(false);
  });

  test.each(['http://10.attacker.example:41234', 'http://192.168.attacker.example:41234'])(
    'rejects DNS names that only begin like a private IP: %s',
    async (origin) => {
      await expect(createTeamRoomWindow({
        BrowserWindow: FakeWindow,
        origin,
        credentialToken: 'd'.repeat(43),
        statePath: path.join(tempRoot, 'window.json'),
      })).rejects.toThrow('team_room_window_private_origin_required');
    }
  );
});
