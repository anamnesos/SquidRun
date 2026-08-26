'use strict';

const mockRuntime = {
  issueElectronCredential: jest.fn(),
  refreshCliBindings: jest.fn(),
  start: jest.fn(),
  stop: jest.fn(),
};
const mockCreateTeamRoomWindow = jest.fn();
const mockRemoteAccess = {
  getStatus: jest.fn(),
  reconcile: jest.fn(),
  setEnabled: jest.fn(),
  status: { available: false, enabled: false, origin: null, reason: 'tailscale_status_not_checked' },
};
let mockNetworkOptions;

jest.mock('../modules/logger', () => ({ info: jest.fn(), warn: jest.fn() }));
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
  resolveTeamRoomNetworkOptions: () => mockNetworkOptions,
}));
jest.mock('../modules/main/team-room-window', () => ({ createTeamRoomWindow: mockCreateTeamRoomWindow }));
jest.mock('../modules/main/team-room-tailscale-access', () => ({
  TeamRoomTailscaleAccess: jest.fn(() => mockRemoteAccess),
}));

const { createTeamRoomAppController } = require('../modules/main/team-room-app-controller');
const log = require('../modules/logger');

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
  mockNetworkOptions = {
    ok: true,
    host: '127.0.0.1',
    port: 0,
    lanEnabled: false,
    allowedOrigins: [],
  };
  mockRuntime.start.mockResolvedValue({ ok: true, origin: 'http://127.0.0.1:45123' });
  mockRuntime.stop.mockResolvedValue({ ok: true });
  mockRuntime.issueElectronCredential.mockReturnValue({ ok: true, token: 'electron-secret' });
  mockRuntime.refreshCliBindings.mockReturnValue({ ok: true, changedRoles: [] });
  mockRemoteAccess.reconcile.mockResolvedValue({ ok: false, reason: 'tailscale_executable_not_found' });
  mockRemoteAccess.getStatus.mockResolvedValue({ ok: true, enabled: false, reason: 'tailscale_serve_disabled' });
  mockRemoteAccess.setEnabled.mockResolvedValue({ ok: true, enabled: false });
  mockCreateTeamRoomWindow.mockResolvedValue({ window: { id: 'team-room-window' } });
});

describe('team-room app controller', () => {
  test('surfaces a stale configured LAN host before attempting to open the room', async () => {
    mockNetworkOptions = {
      ok: false,
      reason: 'room_lan_bind_host_not_local',
      host: '192.168.0.200',
      localAddresses: ['127.0.0.1', '192.168.1.200'],
    };
    const { controller, options } = createHarness();

    await expect(controller.openWindow()).resolves.toEqual({
      ok: false,
      windowKey: 'team-room',
      reason: 'room_lan_bind_host_not_local',
      configuredHost: '192.168.0.200',
      localAddresses: ['127.0.0.1', '192.168.1.200'],
    });
    expect(mockRuntime.start).not.toHaveBeenCalled();
    expect(mockCreateTeamRoomWindow).not.toHaveBeenCalled();
    expect(options.registerAppWindow).not.toHaveBeenCalled();
  });

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
    expect(mockRuntime.refreshCliBindings).toHaveBeenCalledTimes(1);
    expect(mockRuntime.start).not.toHaveBeenCalled();
    expect(mockRuntime.issueElectronCredential).not.toHaveBeenCalled();
  });

  test('refuses to reuse a visible Room window when its current pane binding cannot refresh', async () => {
    const existing = { id: 'existing-room' };
    mockRuntime.refreshCliBindings.mockReturnValue({
      ok: false,
      reason: 'team_room_cli_current_launch_unavailable',
    });
    const { controller, options } = createHarness({
      canSendToWindow: jest.fn(() => true),
      getAppWindow: jest.fn(() => existing),
    });

    await expect(controller.openWindow()).resolves.toEqual({
      ok: false,
      windowKey: 'team-room',
      reason: 'team_room_cli_current_launch_unavailable',
    });
    expect(options.focusAppWindow).not.toHaveBeenCalled();
    expect(mockRuntime.issueElectronCredential).not.toHaveBeenCalled();
  });

  test('retries the transient boot-time CLI binding gap until pane launches exist', async () => {
    let runRetry;
    const retryTimer = { unref: jest.fn() };
    const setTimeoutFn = jest.fn((callback) => {
      runRetry = callback;
      return retryTimer;
    });
    mockRuntime.start
      .mockResolvedValueOnce({ ok: false, reason: 'team_room_cli_launch_binding_unavailable' })
      .mockResolvedValueOnce({ ok: true, origin: 'http://127.0.0.1:45123' });
    const { controller } = createHarness({ setTimeoutFn });

    await expect(controller.start()).resolves.toEqual({
      ok: false,
      reason: 'team_room_cli_launch_binding_unavailable',
      retryScheduled: true,
      retryDelayMs: 500,
    });
    expect(setTimeoutFn).toHaveBeenCalledWith(expect.any(Function), 500);
    expect(retryTimer.unref).toHaveBeenCalledTimes(1);

    await runRetry();

    expect(mockRuntime.start).toHaveBeenCalledTimes(2);
    expect(log.info).toHaveBeenCalledWith(
      'TeamRoom',
      'Runtime recovered after CLI launch bindings became available (attempt 1)'
    );
  });

  test('does not retry a non-transient Team Room startup failure', async () => {
    const setTimeoutFn = jest.fn();
    mockRuntime.start.mockResolvedValueOnce({ ok: false, reason: 'room_lan_bind_host_not_local' });
    const { controller } = createHarness({ setTimeoutFn });

    await expect(controller.start()).resolves.toEqual({
      ok: false,
      reason: 'room_lan_bind_host_not_local',
    });
    expect(setTimeoutFn).not.toHaveBeenCalled();
  });

  test('does not make primary Team Room readiness wait for Tailscale reconciliation', async () => {
    mockRemoteAccess.reconcile.mockReturnValue(new Promise(() => {}));
    const { controller } = createHarness();

    await expect(controller.start()).resolves.toEqual({ ok: true, origin: 'http://127.0.0.1:45123' });
    expect(mockRemoteAccess.reconcile).toHaveBeenCalledTimes(1);
    expect(mockRuntime.stop).not.toHaveBeenCalled();
  });

  test('cancels a pending CLI binding retry when runtime services stop', async () => {
    const retryTimer = { unref: jest.fn() };
    const setTimeoutFn = jest.fn(() => retryTimer);
    const clearTimeoutFn = jest.fn();
    mockRuntime.start.mockResolvedValueOnce({
      ok: false,
      reason: 'team_room_cli_launch_binding_unavailable',
    });
    const { controller } = createHarness({ setTimeoutFn, clearTimeoutFn });

    await controller.start();
    await controller.stop();

    expect(clearTimeoutFn).toHaveBeenCalledWith(retryTimer);
    expect(mockRuntime.stop).toHaveBeenCalledTimes(1);
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
