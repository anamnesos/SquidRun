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
jest.mock('../modules/main/telegram-reply-obligations', () => ({
  reconcileTelegramReplyObligationFromJournal: jest.fn(() => ({
    ok: true,
    status: 'satisfied',
  })),
}));

const https = require('https');
const { appendCommsJournalEntry } = require('../modules/main/comms-journal');
const {
  reconcileTelegramReplyObligationFromJournal,
} = require('../modules/main/telegram-reply-obligations');
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

  test('parseCliArgs extracts --chat-id and photo mode arguments', () => {
    expect(hmTelegram.parseCliArgs(['--chat-id', '2222222222', 'reply now'])).toEqual({
      ok: true,
      photoPath: null,
      chatId: '2222222222',
      messageFile: null,
      readStdin: false,
      explicitMessage: false,
      message: 'reply now',
    });

    expect(hmTelegram.parseCliArgs(['--photo', 'captcha.png', '--chat-id', '2222222222', 'caption text'])).toEqual({
      ok: true,
      photoPath: 'captcha.png',
      chatId: '2222222222',
      messageFile: null,
      readStdin: false,
      explicitMessage: false,
      message: 'caption text',
    });
  });

  test('parseCliArgs rejects bare reserved command tokens but allows explicit message text', () => {
    expect(hmTelegram.parseCliArgs(['status'])).toEqual(expect.objectContaining({
      ok: false,
      error: expect.stringContaining('reserved command-like token "status"'),
    }));
    expect(hmTelegram.parseCliArgs(['--message', 'status'])).toEqual(expect.objectContaining({
      ok: true,
      explicitMessage: true,
      message: 'status',
    }));
  });

  test('main rejects bare status without sending Telegram request', async () => {
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit:${code}`);
    });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(hmTelegram.main(['status'], {
        TELEGRAM_BOT_TOKEN: '123456789:fake_telegram_bot_token_do_not_use',
        TELEGRAM_CHAT_ID: '123456',
      })).rejects.toThrow('process.exit:1');
      expect(https.request).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('reserved command-like token "status"'));
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  test('main still sends a normal message', async () => {
    mockTelegramResponse(200, {
      ok: true,
      result: {
        message_id: 321,
        chat: { id: 123456 },
      },
    });
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit:${code}`);
    });
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(hmTelegram.main(['normal', 'status', 'update'], {
        TELEGRAM_BOT_TOKEN: '123456789:fake_telegram_bot_token_do_not_use',
        TELEGRAM_CHAT_ID: '123456',
      })).rejects.toThrow('process.exit:0');
      expect(https.request).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      exitSpy.mockRestore();
      logSpy.mockRestore();
    }
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

  test('sendTelegram preserves caller message id and metadata in journal entries', async () => {
    mockTelegramResponse(200, {
      ok: true,
      result: {
        message_id: 654,
        chat: { id: 7654321 },
      },
    });

    const result = await hmTelegram.sendTelegram('correlate me', {
      TELEGRAM_BOT_TOKEN: '123456789:fake_telegram_bot_token_do_not_use',
      TELEGRAM_CHAT_ID: '7654321',
    }, {
      messageId: 'telegram-correlation-1',
      metadata: {
        routeKind: 'telegram',
        targetRaw: 'user',
      },
    });

    expect(result.ok).toBe(true);
    expect(appendCommsJournalEntry.mock.calls[0][0]).toEqual(expect.objectContaining({
      messageId: 'telegram-correlation-1',
      metadata: expect.objectContaining({
        routeKind: 'telegram',
        targetRaw: 'user',
        source: 'hm-telegram',
      }),
    }));
    expect(appendCommsJournalEntry.mock.calls[1][0]).toEqual(expect.objectContaining({
      messageId: 'telegram-correlation-1',
      metadata: expect.objectContaining({
        routeKind: 'telegram',
        targetRaw: 'user',
        telegramMessageId: 654,
      }),
    }));
  });

  test('sendTelegram annotates matching reply-context egress with inbound ids', async () => {
    mockTelegramResponse(200, {
      ok: true,
      result: {
        message_id: 20581,
        chat: { id: 5613428850 },
      },
    });

    const result = await hmTelegram.sendTelegram('same-channel answer', {
      TELEGRAM_BOT_TOKEN: '123456789:fake_telegram_bot_token_do_not_use',
      TELEGRAM_CHAT_ID: '5613428850',
    }, {
      messageId: 'hm-telegram-reply-context-1',
      sessionId: 'app-session-399',
      replyContext: {
        chatId: '5613428850',
        inboundMessageId: 'telegram-in-808498637',
        updateId: 808498637,
        telegramMessageId: 20580,
        sender: 'james',
        sessionScopeId: 'app-session-399',
        windowKey: 'main',
        profile: 'main',
        lastInboundAtMs: 1780422913000,
      },
    });

    expect(result.ok).toBe(true);
    expect(result).toEqual(expect.objectContaining({
      journalMessageId: 'hm-telegram-reply-context-1',
      durableSatisfaction: expect.objectContaining({
        ok: true,
        status: 'satisfied',
      }),
    }));
    expect(appendCommsJournalEntry.mock.calls[0][0]).toEqual(expect.objectContaining({
      messageId: 'hm-telegram-reply-context-1',
      metadata: expect.objectContaining({
        replyContext: 'telegram',
        replyToMessageId: 'telegram-in-808498637',
        inboundMessageId: 'telegram-in-808498637',
        telegramUpdateId: 808498637,
        inboundTelegramMessageId: 20580,
        replyContextSessionScopeId: 'app-session-399',
      }),
    }));
    expect(appendCommsJournalEntry.mock.calls[1][0]).toEqual(expect.objectContaining({
      messageId: 'hm-telegram-reply-context-1',
      status: 'acked',
      ackStatus: 'telegram_delivered',
      metadata: expect.objectContaining({
        replyToMessageId: 'telegram-in-808498637',
        inboundMessageId: 'telegram-in-808498637',
        telegramMessageId: 20581,
        chatId: 5613428850,
      }),
    }));
    expect(reconcileTelegramReplyObligationFromJournal).toHaveBeenCalledWith({
      inboundMessageId: 'telegram-in-808498637',
    }, {
      dbPath: null,
    });
  });

  test('sendTelegram skips durable reply reconciliation when no inbound reply context exists', async () => {
    mockTelegramResponse(200, {
      ok: true,
      result: {
        message_id: 314,
        chat: { id: 123456 },
      },
    });

    const result = await hmTelegram.sendTelegram('ordinary broadcast', {
      TELEGRAM_BOT_TOKEN: '123456789:fake_telegram_bot_token_do_not_use',
      TELEGRAM_CHAT_ID: '123456',
    }, {
      messageId: 'hm-telegram-no-reply-context-1',
    });

    expect(result.ok).toBe(true);
    expect(result.durableSatisfaction).toBeNull();
    expect(reconcileTelegramReplyObligationFromJournal).not.toHaveBeenCalled();
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

  test('sendTelegram removes internal pane wrappers and project markers from user-facing text', async () => {
    mockTelegramResponse(200, {
      ok: true,
      result: {
        message_id: 1001,
        chat: { id: 123456 },
      },
    });

    const result = await hmTelegram.sendTelegram(
      '[AGENT MSG - reply via hm-send.js] (ARCH #36): Mira: I am here now.\n[CURRENT PROJECT] name=squidrun | path=D:\\projects\\squidrun',
      {
        TELEGRAM_BOT_TOKEN: '123456789:fake_telegram_bot_token_do_not_use',
        TELEGRAM_CHAT_ID: '123456',
      }
    );

    expect(result.ok).toBe(true);
    const firstRequest = https.request.mock.results[0].value;
    const postedBody = JSON.parse(firstRequest.write.mock.calls[0][0]);
    expect(postedBody.text).toBe('I am here now.');
    expect(postedBody.text).not.toMatch(/ARCH|AGENT MSG|CURRENT PROJECT|hm-send/i);
  });

  test('sendTelegram fails closed when diagnostic fallback text is fully sanitized', async () => {
    const result = await hmTelegram.sendTelegram(
      'Mira held that reply. Open Mira Lab for diagnostics.',
      {
        TELEGRAM_BOT_TOKEN: '123456789:fake_telegram_bot_token_do_not_use',
        TELEGRAM_CHAT_ID: '123456',
      }
    );

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      code: 'telegram_empty_after_sanitization',
    }));
    expect(https.request).not.toHaveBeenCalled();
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

  test('resolveOutboundChatId only uses reply context when explicitly enabled', () => {
    const config = hmTelegram.getTelegramConfig({
      TELEGRAM_BOT_TOKEN: '123456789:fake_telegram_bot_token_do_not_use',
      TELEGRAM_CHAT_ID: '111111',
    });

    expect(hmTelegram.resolveOutboundChatId(config, {
      replyContext: {
        chatId: '2222222222',
      },
    })).toBe('111111');

    expect(hmTelegram.resolveOutboundChatId(config, {
      useReplyContext: true,
      replyContext: {
        chatId: '2222222222',
      },
    })).toBe('2222222222');

    expect(hmTelegram.resolveOutboundChatId(config, {
      useReplyContext: true,
      replyContext: {
        chatId: '111111',
      },
    })).toBe('111111');
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

describe('hm-telegram strict allowlist (fail-closed installs)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    appendCommsJournalEntry.mockReturnValue({ ok: true });
    hmTelegram.resetRateLimiterStateForTests();
    jest.useRealTimers();
  });

  test('isChatAllowed keeps the fail-open default but fails closed under strict', () => {
    expect(hmTelegram.isChatAllowed('123456', [])).toBe(true);
    expect(hmTelegram.isChatAllowed('123456', [], { strict: false })).toBe(true);
    expect(hmTelegram.isChatAllowed('123456', [], { strict: true })).toBe(false);
    expect(hmTelegram.isChatAllowed('123456', ['123456'], { strict: true })).toBe(true);
    expect(hmTelegram.isChatAllowed('999999', ['123456'], { strict: true })).toBe(false);
  });

  test('getTelegramConfig parses TELEGRAM_CHAT_ALLOWLIST_STRICT flag forms', () => {
    const base = {
      TELEGRAM_BOT_TOKEN: '123456789:fake_telegram_bot_token_do_not_use',
      TELEGRAM_CHAT_ID: '123456',
    };

    expect(hmTelegram.getTelegramConfig({ ...base }).chatAllowlistStrict).toBe(false);
    for (const value of ['1', 'true', 'TRUE', 'yes', 'on']) {
      expect(hmTelegram.getTelegramConfig({
        ...base,
        TELEGRAM_CHAT_ALLOWLIST_STRICT: value,
      }).chatAllowlistStrict).toBe(true);
    }
    for (const value of ['0', 'false', 'off', '', '   ']) {
      expect(hmTelegram.getTelegramConfig({
        ...base,
        TELEGRAM_CHAT_ALLOWLIST_STRICT: value,
      }).chatAllowlistStrict).toBe(false);
    }
  });

  test('sendTelegram under strict with a lost allowlist blocks every chat', async () => {
    const result = await hmTelegram.sendTelegram('blocked outbound', {
      TELEGRAM_BOT_TOKEN: '123456789:fake_telegram_bot_token_do_not_use',
      TELEGRAM_CHAT_ID: '8754356993',
      TELEGRAM_CHAT_ALLOWLIST_STRICT: '1',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('not allowlisted');
    expect(https.request).not.toHaveBeenCalled();
  });

  test('sendTelegram under strict still sends to an allowlisted chat', async () => {
    mockTelegramResponse(200, {
      ok: true,
      result: {
        message_id: 555,
        chat: { id: 8754356993 },
      },
    });

    const result = await hmTelegram.sendTelegram('allowed outbound', {
      TELEGRAM_BOT_TOKEN: '123456789:fake_telegram_bot_token_do_not_use',
      TELEGRAM_CHAT_ID: '8754356993',
      TELEGRAM_CHAT_ALLOWLIST: '8754356993',
      TELEGRAM_CHAT_ALLOWLIST_STRICT: '1',
    });

    expect(result.ok).toBe(true);
    expect(https.request).toHaveBeenCalledTimes(1);
  });

  test('sendTelegramPhoto under strict with a lost allowlist is blocked before file access', async () => {
    const result = await hmTelegram.sendTelegramPhoto('does-not-exist.png', 'caption', {
      TELEGRAM_BOT_TOKEN: '123456789:fake_telegram_bot_token_do_not_use',
      TELEGRAM_CHAT_ID: '8754356993',
      TELEGRAM_CHAT_ALLOWLIST_STRICT: '1',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('not allowlisted');
    expect(https.request).not.toHaveBeenCalled();
  });
});
