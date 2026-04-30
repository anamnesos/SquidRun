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
      },
      onMessage,
      pollIntervalMs: 5000,
      downloadMedia: false,
    });

    expect(started).toBe(true);
    expect(forkProcess).toHaveBeenCalledWith(
      'telegram-worker.js',
      [],
      expect.objectContaining({
        env: expect.objectContaining({
          SQUIDRUN_TELEGRAM_POLLER_WORKER: '1',
        }),
      })
    );
    expect(telegramPoller.start).not.toHaveBeenCalled();
    expect(telegramPoller.stop).toHaveBeenCalledTimes(1);
    expect(worker.send).toHaveBeenCalledWith({
      type: 'start',
      options: expect.objectContaining({
        pollIntervalMs: 5000,
        downloadMedia: false,
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
});
