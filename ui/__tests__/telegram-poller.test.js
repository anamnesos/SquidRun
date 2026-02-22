const { EventEmitter } = require('events');

jest.mock('https', () => ({
  request: jest.fn(),
}));

jest.mock('../modules/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const https = require('https');
const telegramPoller = require('../modules/telegram-poller');

function mockTelegramUpdates(updates, statusCode = 200) {
  https.request.mockImplementation((options, onResponse) => {
    const response = new EventEmitter();
    response.statusCode = statusCode;

    const request = new EventEmitter();
    request.end = jest.fn(() => {
      onResponse(response);
      response.emit('data', JSON.stringify({ ok: true, result: updates }));
      response.emit('end');
    });
    return request;
  });
}

describe('telegram-poller', () => {
  afterEach(() => {
    telegramPoller.stop();
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  test('start is a no-op when Telegram credentials are missing', () => {
    const started = telegramPoller.start({
      env: {},
      onMessage: jest.fn(),
    });

    expect(started).toBe(false);
    expect(telegramPoller.isRunning()).toBe(false);
  });

  test('start and stop manage running state', () => {
    const started = telegramPoller.start({
      env: {
        TELEGRAM_BOT_TOKEN: '123456789:fake_telegram_bot_token_do_not_use',
        TELEGRAM_CHAT_ID: '123456',
      },
      pollIntervalMs: 2000,
      onMessage: jest.fn(),
    });

    expect(started).toBe(true);
    expect(telegramPoller.isRunning()).toBe(true);

    telegramPoller.stop();
    expect(telegramPoller.isRunning()).toBe(false);
  });

  test('pollNow emits inbound messages once and deduplicates by update_id offset', async () => {
    const onMessage = jest.fn();

    telegramPoller.start({
      env: {
        TELEGRAM_BOT_TOKEN: '123456789:fake_telegram_bot_token_do_not_use',
        TELEGRAM_CHAT_ID: '123456',
      },
      onMessage,
    });

    mockTelegramUpdates([
      {
        update_id: 10,
        message: {
          chat: { id: 123456 },
          from: { username: 'james' },
          text: 'hello from telegram',
        },
      },
    ]);

    await telegramPoller._internals.pollNow();
    await telegramPoller._internals.pollNow();

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(
      'hello from telegram',
      '@james',
      expect.objectContaining({
        updateId: 10,
        messageId: null,
      })
    );
  });

  test('pollNow rejects unauthorized chat ids', async () => {
    const onMessage = jest.fn();

    telegramPoller.start({
      env: {
        TELEGRAM_BOT_TOKEN: '123456789:fake_telegram_bot_token_do_not_use',
        TELEGRAM_CHAT_ID: '123456',
      },
      onMessage,
    });

    mockTelegramUpdates([
      {
        update_id: 11,
        message: {
          chat: { id: 999999 },
          from: { username: 'attacker' },
          text: 'unauthorized',
        },
      },
    ]);

    await telegramPoller._internals.pollNow();
    expect(onMessage).not.toHaveBeenCalled();
  });
});
