const { EventEmitter } = require('events');

jest.mock('https', () => ({
  request: jest.fn(),
}));

const https = require('https');
const hmTelegram = require('../scripts/hm-telegram');

function mockTelegramResponse(statusCode, payload) {
  https.request.mockImplementation((options, onResponse) => {
    const response = new EventEmitter();
    response.statusCode = statusCode;

    const request = new EventEmitter();
    request.write = jest.fn();
    request.end = jest.fn(() => {
      onResponse(response);
      if (payload !== undefined) {
        response.emit('data', typeof payload === 'string' ? payload : JSON.stringify(payload));
      }
      response.emit('end');
    });
    return request;
  });
}

describe('hm-telegram', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('parseMessage joins argument tokens', () => {
    expect(hmTelegram.parseMessage(['Hey,', 'build', 'passed!'])).toBe('Hey, build passed!');
  });

  test('getMissingConfigKeys reports required env vars', () => {
    const config = hmTelegram.getTelegramConfig({});
    expect(hmTelegram.getMissingConfigKeys(config)).toEqual([
      'TELEGRAM_BOT_TOKEN',
      'TELEGRAM_CHAT_ID',
    ]);
  });

  test('sendTelegram returns success on Telegram 2xx', async () => {
    mockTelegramResponse(200, {
      ok: true,
      result: {
        message_id: 123,
        chat: { id: 123456 },
      },
    });

    const result = await hmTelegram.sendTelegram('test message', {
      TELEGRAM_BOT_TOKEN: 'bot-token',
      TELEGRAM_CHAT_ID: '123456',
    });

    expect(result.ok).toBe(true);
    expect(result.messageId).toBe(123);
    expect(https.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        path: '/botbot-token/sendMessage',
      }),
      expect.any(Function)
    );
  });

  test('sendTelegram returns Telegram error message on non-2xx', async () => {
    mockTelegramResponse(400, {
      ok: false,
      description: 'Bad Request: chat not found',
    });

    const result = await hmTelegram.sendTelegram('test message', {
      TELEGRAM_BOT_TOKEN: 'bot-token',
      TELEGRAM_CHAT_ID: '123456',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('chat not found');
  });
});
