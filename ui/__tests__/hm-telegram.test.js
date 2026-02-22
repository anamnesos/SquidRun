const { EventEmitter } = require('events');

jest.mock('https', () => ({
  request: jest.fn(),
}));
jest.mock('../modules/main/comms-journal', () => ({
  appendCommsJournalEntry: jest.fn(() => ({ ok: true })),
  closeCommsJournalStores: jest.fn(),
}));

const https = require('https');
const { appendCommsJournalEntry } = require('../modules/main/comms-journal');
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
    appendCommsJournalEntry.mockReturnValue({ ok: true });
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

  test('sendTelegram journals architect -> user with session id', async () => {
    mockTelegramResponse(200, {
      ok: true,
      result: {
        message_id: 456,
        chat: { id: 654321 },
      },
    });

    const result = await hmTelegram.sendTelegram('journal me', {
      TELEGRAM_BOT_TOKEN: 'bot-token',
      TELEGRAM_CHAT_ID: '654321',
    }, {
      sessionId: 'app-session-2',
    });

    expect(result.ok).toBe(true);
    expect(appendCommsJournalEntry).toHaveBeenCalled();
    expect(appendCommsJournalEntry.mock.calls[0][0]).toEqual(expect.objectContaining({
      channel: 'telegram',
      direction: 'outbound',
      senderRole: 'architect',
      targetRole: 'user',
      sessionId: 'app-session-2',
      status: 'recorded',
    }));
  });
});
