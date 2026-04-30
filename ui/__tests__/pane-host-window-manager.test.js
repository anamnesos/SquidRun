let mockLatestWindow = null;

jest.mock('electron', () => ({
  BrowserWindow: jest.fn().mockImplementation(() => {
    const windowEvents = new Map();
    const webContentsEvents = new Map();
    mockLatestWindow = {
      loadFile: jest.fn().mockResolvedValue(),
      close: jest.fn(),
      isDestroyed: jest.fn(() => false),
      on: jest.fn((event, handler) => {
        windowEvents.set(event, handler);
      }),
      emitWindowEvent: (event, ...args) => {
        const handler = windowEvents.get(event);
        if (typeof handler === 'function') handler(...args);
      },
      webContents: {
        send: jest.fn(),
        isLoadingMainFrame: jest.fn(() => false),
        once: jest.fn(),
        openDevTools: jest.fn(),
        on: jest.fn((event, handler) => {
          webContentsEvents.set(event, handler);
        }),
        emitWebContentsEvent: (event, ...args) => {
          const handler = webContentsEvents.get(event);
          if (typeof handler === 'function') handler(...args);
        },
      },
    };
    return mockLatestWindow;
  }),
}));

describe('pane-host-window-manager query defaults', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    delete process.env.SQUIDRUN_PANE_HOST_HM_SEND_CHUNK_THRESHOLD_BYTES;
    delete process.env.SQUIDRUN_PANE_HOST_CHUNK_THRESHOLD_BYTES;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('defaults hm-send chunk threshold to platform-safe value', () => {
    const { _internals } = require('../modules/main/pane-host-window-manager');
    const expectedThreshold = process.platform === 'darwin' ? '1024' : '256';

    const query = _internals.buildPaneHostQueryFromEnv('1');

    expect(query).toEqual(expect.objectContaining({
      paneId: '1',
      paneIds: '1',
      chunkThresholdBytes: '256',
      chunkSizeBytes: '256',
      hmSendChunkThresholdBytes: expectedThreshold,
    }));
  });

  test('honors explicit hm-send chunk threshold override', () => {
    process.env.SQUIDRUN_PANE_HOST_HM_SEND_CHUNK_THRESHOLD_BYTES = '1536';
    const { _internals } = require('../modules/main/pane-host-window-manager');

    const query = _internals.buildPaneHostQueryFromEnv('3');

    expect(query.hmSendChunkThresholdBytes).toBe('1536');
  });
});

describe('pane-host-window-manager multiplexing', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test('uses one hidden BrowserWindow for multiple pane hosts', async () => {
    const { BrowserWindow } = require('electron');
    const { createPaneHostWindowManager } = require('../modules/main/pane-host-window-manager');
    const manager = createPaneHostWindowManager();

    await manager.ensurePaneWindows(['1', '2', '3']);

    expect(BrowserWindow).toHaveBeenCalledTimes(1);
    expect(manager.getPaneWindow('1')).toBe(manager.getPaneWindow('2'));
    expect(manager.getPaneWindow('2')).toBe(manager.getPaneWindow('3'));
  });

  test('emits lifecycle events for hidden pane host failures', async () => {
    const { createPaneHostWindowManager } = require('../modules/main/pane-host-window-manager');
    const onLifecycleEvent = jest.fn();
    const manager = createPaneHostWindowManager({ onLifecycleEvent });

    await manager.ensurePaneWindows(['1', '2', '3']);
    mockLatestWindow.webContents.emitWebContentsEvent('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'file:///pane-host.html', true);
    mockLatestWindow.emitWindowEvent('closed');

    expect(onLifecycleEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'window-created',
      paneIds: ['1', '2', '3'],
    }));
    expect(onLifecycleEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'did-fail-load',
      paneIds: ['1', '2', '3'],
      errorCode: -6,
      errorDescription: 'ERR_FILE_NOT_FOUND',
    }));
    expect(onLifecycleEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'closed',
      paneIds: ['1', '2', '3'],
    }));
  });

  test('tracks load diagnostics for slow hidden pane hosts', async () => {
    const { createPaneHostWindowManager } = require('../modules/main/pane-host-window-manager');
    const manager = createPaneHostWindowManager();

    await manager.ensurePaneWindows(['1', '2', '3']);
    let diagnostics = manager.getWindowDiagnostics();
    expect(diagnostics).toEqual(expect.objectContaining({
      paneIds: ['1', '2', '3'],
      loading: true,
      hasWindow: true,
    }));

    mockLatestWindow.webContents.emitWebContentsEvent('did-finish-load');
    diagnostics = manager.getWindowDiagnostics();
    expect(diagnostics).toEqual(expect.objectContaining({
      paneIds: ['1', '2', '3'],
      loading: false,
      hasWindow: true,
    }));
    expect(diagnostics.lastDidFinishLoadAt).toEqual(expect.any(Number));
  });
});
