const {
  createWebSocketStartupLifecycle,
} = require('../modules/main/websocket-startup-lifecycle');

function createHarness(overrides = {}) {
  const scheduled = [];
  const server = {
    DEFAULT_PORT: 9900,
    start: jest.fn().mockResolvedValue(),
    getClients: jest.fn(() => []),
    isRunning: jest.fn(() => false),
    getPort: jest.fn(() => null),
  };
  const settings = { writeAppStatus: jest.fn() };
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  const setTimeoutFn = jest.fn((callback, delayMs) => {
    const handle = { callback, delayMs };
    scheduled.push(handle);
    return handle;
  });
  const clearTimeoutFn = jest.fn();
  const lifecycle = createWebSocketStartupLifecycle({
    websocketServer: server,
    log: logger,
    resolvePortInfo: () => ({ port: 9901, source: 'settings:test' }),
    getSettings: () => settings,
    refreshStartupHealth: jest.fn().mockResolvedValue(),
    getCurrentSessionNumber: () => 519,
    isShuttingDown: () => false,
    setTimeoutFn,
    clearTimeoutFn,
    retryBaseMs: 500,
    retryMaxMs: 10000,
    ...overrides,
  });
  return {
    lifecycle,
    server,
    settings,
    logger,
    scheduled,
    setTimeoutFn,
    clearTimeoutFn,
  };
}

describe('WebSocketStartupLifecycle', () => {
  test('builds runtime status from the bound server and configured desired port', () => {
    const { lifecycle, server } = createHarness();
    server.getClients.mockReturnValue([{ id: 1 }, { id: 2 }]);
    server.isRunning.mockReturnValue(true);
    server.getPort.mockReturnValue(9911);

    const status = lifecycle.buildStatusPatch();

    expect(status).toEqual(expect.objectContaining({
      running: true,
      port: 9911,
      desiredPort: 9901,
      source: 'settings:test',
      clientCount: 2,
      status: 'running',
    }));
    expect(Number.isNaN(Date.parse(status.lastUpdatedAt))).toBe(false);
  });

  test('records failure details and writes the existing app-status shape', () => {
    const { lifecycle, settings } = createHarness();
    const error = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE', port: 9901 });

    lifecycle.recordStartFailure(error);

    expect(settings.writeAppStatus).toHaveBeenCalledWith({
      statusPatch: {
        websocket: expect.objectContaining({
          running: false,
          status: 'bind_failed',
          port: 9901,
          desiredPort: 9901,
          warning: 'websocket_bind_failed',
          error: 'listen EADDRINUSE',
          code: 'EADDRINUSE',
        }),
      },
    });
  });

  test('preserves retry classification and capped exponential delays', () => {
    const { lifecycle } = createHarness();

    expect(lifecycle.isRetryableStartError(new Error('listen EADDRINUSE'))).toBe(true);
    expect(lifecycle.isRetryableStartError(new Error('comms worker timeout'))).toBe(true);
    expect(lifecycle.isRetryableStartError(new Error('bad message payload'))).toBe(false);
    expect(lifecycle.getStartRetryDelayMs(1)).toBe(500);
    expect(lifecycle.getStartRetryDelayMs(2)).toBe(1000);
    expect(lifecycle.getStartRetryDelayMs(8)).toBe(10000);
  });

  test('retries at the exact prior schedule, then clears state and records success', async () => {
    const { lifecycle, server, scheduled, logger, clearTimeoutFn } = createHarness();
    const startOptions = { port: 9901, portSource: 'settings:test', onMessage: jest.fn() };

    lifecycle.scheduleStartRetry(startOptions, new Error('listen EADDRINUSE'));

    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].delayMs).toBe(500);
    expect(logger.warn).toHaveBeenCalledWith('WebSocket', 'Retrying server start in 500ms (attempt 2)');

    await scheduled[0].callback();

    expect(server.start).toHaveBeenCalledWith(startOptions);
    expect(lifecycle.getState()).toEqual({
      startRetryTimer: null,
      startRetryAttempt: 0,
      startupStatus: expect.objectContaining({
        ok: true,
        port: 9901,
        source: 'settings:test',
      }),
    });
    expect(clearTimeoutFn).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('WebSocket', 'Server start recovery succeeded');
  });

  test('failed retries reschedule at the next exact delay and duplicate schedules stay fenced', async () => {
    const { lifecycle, server, scheduled, setTimeoutFn } = createHarness();
    const startOptions = { port: 9901, portSource: 'settings:test' };
    server.start.mockRejectedValueOnce(new Error('comms worker exited'));

    lifecycle.scheduleStartRetry(startOptions, new Error('listen EADDRINUSE'));
    lifecycle.scheduleStartRetry(startOptions, new Error('listen EADDRINUSE'));
    expect(setTimeoutFn).toHaveBeenCalledTimes(1);

    await scheduled[0].callback();

    expect(scheduled).toHaveLength(2);
    expect(scheduled[1].delayMs).toBe(1000);
    expect(lifecycle.getState().startRetryAttempt).toBe(2);
  });

  test('does not schedule during shutdown or for non-retryable failures', () => {
    const shuttingDown = createHarness({ isShuttingDown: () => true });
    shuttingDown.lifecycle.scheduleStartRetry({ port: 9901 }, new Error('listen EADDRINUSE'));
    expect(shuttingDown.setTimeoutFn).not.toHaveBeenCalled();

    const nonRetryable = createHarness();
    nonRetryable.lifecycle.scheduleStartRetry({ port: 9901 }, new Error('bad payload'));
    expect(nonRetryable.setTimeoutFn).not.toHaveBeenCalled();
  });
});
