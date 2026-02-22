const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

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

async function flushMicrotasks(iterations = 8) {
  for (let i = 0; i < iterations; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
}

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
    hmTelegram.resetRateLimiterStateForTests();
    jest.useRealTimers();
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
      TELEGRAM_BOT_TOKEN: '123456789:fake_telegram_bot_token_do_not_use',
      TELEGRAM_CHAT_ID: '123456',
    });

    expect(result.ok).toBe(true);
    expect(result.messageId).toBe(123);
    expect(https.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        path: '/bot123456789:fake_telegram_bot_token_do_not_use/sendMessage',
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
      TELEGRAM_BOT_TOKEN: '123456789:fake_telegram_bot_token_do_not_use',
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
      TELEGRAM_BOT_TOKEN: '123456789:fake_telegram_bot_token_do_not_use',
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

  test('sendTelegram truncates outbound message to 4000 chars with suffix', async () => {
    mockTelegramResponse(200, {
      ok: true,
      result: {
        message_id: 999,
        chat: { id: 123456 },
      },
    });

    const longMessage = `${'A'.repeat(4105)} tail`;
    const result = await hmTelegram.sendTelegram(longMessage, {
      TELEGRAM_BOT_TOKEN: '123456789:fake_telegram_bot_token_do_not_use',
      TELEGRAM_CHAT_ID: '123456',
    });

    expect(result.ok).toBe(true);
    const firstRequest = https.request.mock.results[0].value;
    const postedBody = JSON.parse(firstRequest.write.mock.calls[0][0]);
    expect(postedBody.text.length).toBe(4000);
    expect(postedBody.text.endsWith('[message truncated]')).toBe(true);
  });

  test('sendTelegram rejects chat ids not in TELEGRAM_CHAT_ALLOWLIST', async () => {
    mockTelegramResponse(200, {
      ok: true,
      result: {
        message_id: 321,
        chat: { id: 333333 },
      },
    });

    const result = await hmTelegram.sendTelegram('blocked target', {
      TELEGRAM_BOT_TOKEN: '123456789:fake_telegram_bot_token_do_not_use',
      TELEGRAM_CHAT_ID: '333333',
      TELEGRAM_CHAT_ALLOWLIST: '111111,222222',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('not allowlisted');
    expect(https.request).not.toHaveBeenCalled();
  });

  test('sendTelegram queues and paces messages beyond 10 per minute', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-02-22T00:00:00.000Z'));

    mockTelegramResponse(200, {
      ok: true,
      result: {
        message_id: 111,
        chat: { id: 123456 },
      },
    });

    const env = {
      TELEGRAM_BOT_TOKEN: '123456789:fake_telegram_bot_token_do_not_use',
      TELEGRAM_CHAT_ID: '123456',
    };
    const sends = Array.from(
      { length: 11 },
      (_, index) => hmTelegram.sendTelegram(`msg ${index + 1}`, env)
    );

    let eleventhResolved = false;
    sends[10].then(() => {
      eleventhResolved = true;
    });

    await flushMicrotasks();

    expect(https.request.mock.calls.length).toBeLessThan(11);
    expect(eleventhResolved).toBe(false);

    let advancedMs = 0;
    while (https.request.mock.calls.length < 11 && advancedMs <= 70_000) {
      jest.advanceTimersByTime(1_000);
      advancedMs += 1_000;
      // eslint-disable-next-line no-await-in-loop
      await flushMicrotasks(6);
    }

    await Promise.all(sends);

    expect(https.request).toHaveBeenCalledTimes(11);
    expect(eleventhResolved).toBe(true);
    expect(advancedMs).toBeGreaterThanOrEqual(60_000);
  });

  test('sendTelegramPhoto truncates long captions to 1000 chars with suffix', async () => {
    mockTelegramResponse(200, {
      ok: true,
      result: {
        message_id: 777,
        chat: { id: 123456 },
      },
    });

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-telegram-photo-'));
    const photoPath = path.join(tempDir, 'photo.png');
    fs.writeFileSync(photoPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    try {
      const longCaption = `${'C'.repeat(1100)} tail`;
      const result = await hmTelegram.sendTelegramPhoto(photoPath, longCaption, {
        TELEGRAM_BOT_TOKEN: '123456789:fake_telegram_bot_token_do_not_use',
        TELEGRAM_CHAT_ID: '123456',
      });

      expect(result.ok).toBe(true);
      const firstRequest = https.request.mock.results[0].value;
      const multipartHead = Buffer.from(firstRequest.write.mock.calls[0][0]).toString('utf8');
      const captionMatch = multipartHead.match(/name=\"caption\"\r\n\r\n([\s\S]*?)\r\n--/);

      expect(captionMatch).toBeTruthy();
      const submittedCaption = captionMatch[1];
      expect(submittedCaption.length).toBe(1000);
      expect(submittedCaption.endsWith('[message truncated]')).toBe(true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
