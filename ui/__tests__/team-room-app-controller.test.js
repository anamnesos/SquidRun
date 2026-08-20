'use strict';

const mockRuntime = {
  issueElectronCredential: jest.fn(),
  start: jest.fn(),
  stop: jest.fn(),
};
const mockCreateTeamRoomWindow = jest.fn();

jest.mock('../modules/logger', () => ({ warn: jest.fn() }));
jest.mock('../config', () => ({
  getProjectRoot: () => 'D:/projects/squidrun',
  resolveCoordPath: (relativePath) => `D:/projects/squidrun/.squidrun/${relativePath}`,
}));
jest.mock('../modules/main/team-room-pane-delivery', () => ({
  createTeamRoomPaneDelivery: () => jest.fn(),
  createTeamRoomRouteScopeResolver: () => jest.fn(),
}));
jest.mock('../modules/main/team-room-runtime', () => ({
  TeamRoomRuntime: jest.fn(() => mockRuntime),
  resolveTeamRoomNetworkOptions: () => ({
    ok: true,
    host: '127.0.0.1',
    port: 0,
    lanEnabled: false,
    allowedOrigins: [],
  }),
}));
jest.mock('../modules/main/team-room-window', () => ({ createTeamRoomWindow: mockCreateTeamRoomWindow }));

const { createTeamRoomAppController } = require('../modules/main/team-room-app-controller');

function createHarness(overrides = {}) {
  const windowRef = { id: 'team-room-window' };
  const options = {
    BrowserWindow: jest.fn(),
    canSendToWindow: jest.fn(() => false),
    focusAppWindow: jest.fn(),
    getAppWindow: jest.fn(() => null),
    getSessionScopeId: jest.fn(() => 'session-512:main:team-room'),
    getWindowScope: jest.fn(() => ({ profileName: 'main' })),
    registerAppWindow: jest.fn(),
    sendDirectMessage: jest.fn(),
    setupWindowListeners: jest.fn(),
    suppressMenu: jest.fn(),
    ...overrides,
  };
  return { controller: createTeamRoomAppController(options), options, windowRef };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRuntime.start.mockResolvedValue({ ok: true, origin: 'http://127.0.0.1:45123' });
  mockRuntime.stop.mockResolvedValue({ ok: true });
  mockRuntime.issueElectronCredential.mockReturnValue({ ok: true, token: 'electron-secret' });
  mockCreateTeamRoomWindow.mockResolvedValue({ window: { id: 'team-room-window' } });
});

describe('team-room app controller', () => {
  test('binds the SquidRun app host without losing method context', async () => {
    const appHost = {
      canSendToWindow: jest.fn(() => false),
      focusAppWindow: jest.fn(),
      getAppWindow: jest.fn(() => null),
      getWindowSessionScopeId: jest.fn(() => 'session-512:main:team-room'),
      getAppWindowInstanceScope: jest.fn(() => ({
        windowKey: 'main',
        profileName: 'main',
        sessionScopeId: 'session-512:main',
      })),
      registerAppWindow: jest.fn(),
      setupWindowListeners: jest.fn(),
      enforceMenuSuppression: jest.fn(),
    };
    const controller = createTeamRoomAppController({
      appHost,
      BrowserWindow: jest.fn(),
      sendDirectMessage: jest.fn(),
    });

    await expect(controller.openWindow()).resolves.toMatchObject({ ok: true, windowKey: 'team-room' });
    expect(appHost.registerAppWindow).toHaveBeenCalledWith(
      'team-room',
      { id: 'team-room-window' },
      expect.objectContaining({ sessionScopeId: 'session-512:main:team-room' })
    );
  });

  test('reuses the existing isolated room window without minting another credential', async () => {
    const existing = { id: 'existing-room' };
    const { controller, options } = createHarness({
      canSendToWindow: jest.fn(() => true),
      getAppWindow: jest.fn(() => existing),
    });

    await expect(controller.openWindow()).resolves.toMatchObject({
      ok: true,
      status: 'reused_existing',
      windowKey: 'team-room',
    });
    expect(options.focusAppWindow).toHaveBeenCalledWith('team-room');
    expect(mockRuntime.start).not.toHaveBeenCalled();
    expect(mockRuntime.issueElectronCredential).not.toHaveBeenCalled();
  });

  test('registers a new Team Room with explicit main-profile session scope', async () => {
    const { controller, options } = createHarness();

    await expect(controller.openWindow()).resolves.toEqual({
      ok: true,
      windowKey: 'team-room',
      title: 'SquidRun Team Room',
      origin: 'http://127.0.0.1:45123',
    });
    expect(mockCreateTeamRoomWindow).toHaveBeenCalledWith(expect.objectContaining({
      origin: 'http://127.0.0.1:45123',
      credentialToken: 'electron-secret',
    }));
    expect(options.registerAppWindow).toHaveBeenCalledWith(
      'team-room',
      { id: 'team-room-window' },
      {
        lifecycleRoot: false,
        profileName: 'main',
        sessionScopeId: 'session-512:main:team-room',
      }
    );
    expect(options.suppressMenu).toHaveBeenCalledWith({ id: 'team-room-window' });
    expect(options.setupWindowListeners).toHaveBeenCalledWith(
      { id: 'team-room-window' },
      { windowKey: 'team-room', lifecycleRoot: false }
    );
  });

  test('fails closed when trusted Electron credential issuance fails', async () => {
    mockRuntime.issueElectronCredential.mockReturnValue({ ok: false, reason: 'credential_refused' });
    const { controller, options } = createHarness();

    await expect(controller.openWindow()).resolves.toEqual({
      ok: false,
      windowKey: 'team-room',
      reason: 'credential_refused',
    });
    expect(mockCreateTeamRoomWindow).not.toHaveBeenCalled();
    expect(options.registerAppWindow).not.toHaveBeenCalled();
  });
});
