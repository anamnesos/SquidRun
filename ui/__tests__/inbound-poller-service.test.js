const { createInboundPollerService } = require('../modules/main/inbound-poller-service');
const { EventEmitter } = require('events');

describe('InboundPollerService', () => {
  test('starts and stops inbound channel pollers through injected dependencies', () => {
    const smsPoller = {
      start: jest.fn(() => true),
      stop: jest.fn(),
    };
    const telegramPoller = {
      start: jest.fn(() => true),
      stop: jest.fn(),
    };
    const service = createInboundPollerService({
      smsPoller,
      telegramPoller,
      useTelegramWorker: false,
    });
    const smsOptions = { onMessage: jest.fn() };
    const telegramOptions = { env: { TELEGRAM_CHAT_ID: '123' }, onMessage: jest.fn() };

    expect(service.startSms(smsOptions)).toBe(true);
    expect(service.startTelegram(telegramOptions)).toBe(true);
    service.stopAll();

    expect(smsPoller.start).toHaveBeenCalledWith(smsOptions);
    expect(telegramPoller.start).toHaveBeenCalledWith(telegramOptions);
    expect(smsPoller.stop).toHaveBeenCalledTimes(1);
    expect(telegramPoller.stop).toHaveBeenCalledTimes(1);
  });

  test('starts Telegram through a forked single-owner worker and relays messages to the app callback', () => {
    const worker = new EventEmitter();
    worker.connected = true;
    worker.send = jest.fn();
    worker.kill = jest.fn();
    const forkProcess = jest.fn(() => worker);
    const onMessage = jest.fn();
    const smsPoller = {
      start: jest.fn(() => true),
      stop: jest.fn(),
    };
    const telegramPoller = {
      start: jest.fn(() => {
        throw new Error('parent must not own getUpdates');
      }),
      stop: jest.fn(),
      _internals: {
        getTelegramConfig: jest.fn(() => ({ botToken: 'token', chatId: 123 })),
      },
    };
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    const service = createInboundPollerService({
      smsPoller,
      telegramPoller,
      forkProcess,
      log: logger,
      telegramWorkerPath: 'telegram-worker.js',
      useTelegramWorker: true,
    });

    const started = service.startTelegram({
      env: {
        TELEGRAM_BOT_TOKEN: 'token',
        TELEGRAM_CHAT_ID: '123',
        SQUIDRUN_DATA_ROOT: 'D:\\SquidRun\\Eunbyeol',
        SQUIDRUN_PROJECT_ROOT: 'D:\\SquidRun\\Eunbyeol',
        TELEGRAM_POLLER_STATE_PATH: 'D:\\SquidRun\\Eunbyeol\\.squidrun\\runtime\\telegram-poller-state.json',
      },
      onMessage,
      pollIntervalMs: 5000,
      requestTimeoutMs: 25000,
      downloadMedia: false,
    });

    expect(started).toBe(true);
    expect(forkProcess).toHaveBeenCalledWith(
      'telegram-worker.js',
      [],
      expect.objectContaining({
        env: expect.objectContaining({
          SQUIDRUN_TELEGRAM_POLLER_WORKER: '1',
          SQUIDRUN_DATA_ROOT: 'D:\\SquidRun\\Eunbyeol',
          SQUIDRUN_PROJECT_ROOT: 'D:\\SquidRun\\Eunbyeol',
          TELEGRAM_POLLER_STATE_PATH: 'D:\\SquidRun\\Eunbyeol\\.squidrun\\runtime\\telegram-poller-state.json',
        }),
      })
    );
    expect(telegramPoller.start).not.toHaveBeenCalled();
    expect(telegramPoller.stop).toHaveBeenCalledTimes(1);
    expect(worker.send).toHaveBeenCalledWith({
      type: 'start',
      options: expect.objectContaining({
        env: expect.objectContaining({
          SQUIDRUN_DATA_ROOT: 'D:\\SquidRun\\Eunbyeol',
          SQUIDRUN_PROJECT_ROOT: 'D:\\SquidRun\\Eunbyeol',
          TELEGRAM_POLLER_STATE_PATH: 'D:\\SquidRun\\Eunbyeol\\.squidrun\\runtime\\telegram-poller-state.json',
        }),
        pollIntervalMs: 5000,
        requestTimeoutMs: 25000,
        downloadMedia: false,
        keepAlive: true,
      }),
    });

    worker.emit('message', {
      type: 'message',
      payload: {
        text: 'hello',
        from: '@james',
        metadata: { updateId: 7 },
      },
    });

    expect(onMessage).toHaveBeenCalledWith('hello', '@james', { updateId: 7 });

    service.stopTelegram();
    expect(worker.send).toHaveBeenCalledWith({ type: 'shutdown' });
  });

  test('uses electron-as-node fork options for packaged Telegram worker', () => {
    const worker = new EventEmitter();
    worker.connected = true;
    worker.send = jest.fn();
    worker.kill = jest.fn();
    const forkProcess = jest.fn(() => worker);
    const originalExecPath = process.execPath;
    const originalVersions = process.versions;
    Object.defineProperty(process, 'execPath', {
      configurable: true,
      writable: true,
      value: 'D:\\SquidRun\\Eunbyeol\\versions\\0.1.34-test\\sr-electron.exe',
    });
    Object.defineProperty(process, 'versions', {
      configurable: true,
      value: {
        ...originalVersions,
        electron: '28.3.3',
      },
    });

    try {
      const service = createInboundPollerService({
        smsPoller: { start: jest.fn(), stop: jest.fn() },
        telegramPoller: {
          stop: jest.fn(),
          _internals: {
            getTelegramConfig: jest.fn(() => ({ botToken: 'token', chatId: 8754356993 })),
          },
        },
        forkProcess,
        telegramWorkerPath: 'telegram-worker.js',
        useTelegramWorker: true,
      });

      expect(service.startTelegram({
        env: {
          TELEGRAM_BOT_TOKEN: 'token',
          TELEGRAM_CHAT_ID: '8754356993',
          SQUIDRUN_DATA_ROOT: 'D:\\SquidRun\\Eunbyeol',
          SQUIDRUN_PROJECT_ROOT: 'D:\\SquidRun\\Eunbyeol',
        },
      })).toBe(true);

      expect(forkProcess).toHaveBeenCalledWith(
        'telegram-worker.js',
        [],
        expect.objectContaining({
          execPath: 'D:\\SquidRun\\Eunbyeol\\versions\\0.1.34-test\\sr-electron.exe',
          env: expect.objectContaining({
            SQUIDRUN_TELEGRAM_POLLER_WORKER: '1',
            SQUIDRUN_DATA_ROOT: 'D:\\SquidRun\\Eunbyeol',
            SQUIDRUN_PROJECT_ROOT: 'D:\\SquidRun\\Eunbyeol',
            ELECTRON_RUN_AS_NODE: '1',
          }),
        })
      );
    } finally {
      Object.defineProperty(process, 'execPath', {
        configurable: true,
        writable: true,
        value: originalExecPath,
      });
      Object.defineProperty(process, 'versions', {
        configurable: true,
        value: originalVersions,
      });
    }
  });
});
