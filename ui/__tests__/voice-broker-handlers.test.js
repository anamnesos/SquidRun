describe('voice-broker IPC handlers', () => {
  let handlers;

  beforeEach(() => {
    jest.resetModules();
    handlers = require('../modules/ipc/voice-broker-handlers');
  });

  test('reports not-ready status when OPENAI_API_KEY is missing', () => {
    const status = handlers.buildVoiceBrokerStatus({
      env: {},
      lane: {
        status: () => ({ ok: true, running: false, pid: null }),
      },
    });

    expect(status).toEqual(expect.objectContaining({
      ok: true,
      state: 'not_ready',
      ready: false,
      running: false,
      notReadyReasons: ['openai_api_key_missing'],
    }));
    expect(status.config).toEqual(expect.objectContaining({
      openaiApiKeyPresent: false,
      endpointShape: expect.objectContaining({
        clientSecret: expect.objectContaining({
          path: '/v1/voice/realtime/client-secret',
        }),
      }),
    }));
    expect(status.config).not.toHaveProperty('openaiApiKey');
  });

  test('reports running when broker lane is alive and key is configured', () => {
    const status = handlers.buildVoiceBrokerStatus({
      env: { OPENAI_API_KEY: 'sk-test' },
      lane: {
        status: () => ({
          ok: true,
          running: true,
          pid: 1234,
          broker: {
            address: { address: '127.0.0.1', port: 43123 },
          },
        }),
      },
    });

    expect(status).toEqual(expect.objectContaining({
      state: 'running',
      ready: true,
      running: true,
      notReadyReasons: [],
    }));
  });

  test('control fails closed for start/restart when broker is not ready', async () => {
    const lane = {
      status: jest.fn(() => ({ ok: true, running: false })),
      start: jest.fn(),
    };

    const result = await handlers.executeVoiceBrokerControl('start', {
      env: {},
      lane,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      reason: 'voice_broker_not_ready',
      action: 'start',
      notReadyReasons: ['openai_api_key_missing'],
    }));
    expect(lane.start).not.toHaveBeenCalled();
  });

  test('control delegates to restart without app reload when ready', async () => {
    let running = false;
    const lane = {
      status: jest.fn(() => ({ ok: true, running, pid: running ? 1234 : null })),
      restart: jest.fn(async () => {
        running = true;
        return { ok: true, action: 'restart-voice-broker' };
      }),
    };

    const result = await handlers.executeVoiceBrokerControl('restart', {
      env: { OPENAI_API_KEY: 'sk-test' },
      lane,
    });

    expect(lane.restart).toHaveBeenCalledTimes(1);
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      action: 'restart',
      result: expect.objectContaining({
        action: 'restart-voice-broker',
      }),
      status: expect.objectContaining({
        state: 'running',
      }),
    }));
  });

  test('registers status and control IPC handlers', async () => {
    const registered = new Map();
    const ipcMain = {
      handle: jest.fn((channel, handler) => registered.set(channel, handler)),
      removeHandler: jest.fn((channel) => registered.delete(channel)),
    };
    const lane = {
      status: jest.fn(() => ({ ok: true, running: false })),
      stop: jest.fn(() => ({ ok: true, stopped: false, reason: 'not_running' })),
    };

    handlers.registerVoiceBrokerHandlers({ ipcMain }, {
      env: { OPENAI_API_KEY: 'sk-test' },
      lane,
    });

    expect(ipcMain.handle).toHaveBeenCalledWith('voice-broker:status', expect.any(Function));
    expect(ipcMain.handle).toHaveBeenCalledWith('voice-broker:control', expect.any(Function));
    expect(await registered.get('voice-broker:status')({})).toEqual(expect.objectContaining({
      ready: true,
    }));
    expect(await registered.get('voice-broker:control')({}, { action: 'stop' })).toEqual(expect.objectContaining({
      ok: true,
      action: 'stop',
    }));

    handlers.unregisterVoiceBrokerHandlers({ ipcMain });
    expect(ipcMain.removeHandler).toHaveBeenCalledWith('voice-broker:status');
    expect(ipcMain.removeHandler).toHaveBeenCalledWith('voice-broker:control');
  });

  test('exposes voice-broker IPC through registry, policy, and preload API', async () => {
    const { registerVoiceBrokerHandlers } = require('../modules/ipc/voice-broker-handlers');
    const { DEFAULT_HANDLERS } = require('../modules/ipc/handler-registry');
    const { isAllowedInvokeChannel } = require('../modules/bridge/channel-policy');
    const { createPreloadApi } = require('../modules/bridge/preload-api');
    const ipcRenderer = {
      invoke: jest.fn(async () => ({ ok: true })),
      send: jest.fn(),
      on: jest.fn(),
      removeListener: jest.fn(),
    };

    expect(DEFAULT_HANDLERS).toContain(registerVoiceBrokerHandlers);
    expect(isAllowedInvokeChannel('voice-broker:status')).toBe(true);
    expect(isAllowedInvokeChannel('voice-broker:control')).toBe(true);

    const api = createPreloadApi(ipcRenderer);
    await api.voice.brokerStatus();
    await api.voice.brokerControl('restart');

    expect(ipcRenderer.invoke).toHaveBeenCalledWith('voice-broker:status');
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('voice-broker:control', { action: 'restart' });
  });
});
