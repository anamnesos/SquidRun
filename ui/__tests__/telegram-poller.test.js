const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StringDecoder } = require('string_decoder');

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
const log = require('../modules/logger');
const telegramPoller = require('../modules/telegram-poller');

function mockTelegramUpdates(updates, statusCode = 200) {
  https.request.mockImplementation((options, onResponse) => {
    const response = new EventEmitter();
    response.statusCode = statusCode;
    let decoder = null;
    response.setEncoding = jest.fn((encoding) => {
      decoder = new StringDecoder(encoding);
    });

    const request = new EventEmitter();
    request.end = jest.fn(() => {
      onResponse(response);
      const payload = Buffer.from(JSON.stringify({ ok: true, result: updates }), 'utf8');
      if (decoder) {
        response.emit('data', decoder.write(payload));
        const remainder = decoder.end();
        if (remainder) response.emit('data', remainder);
      } else {
        response.emit('data', payload);
      }
      response.emit('end');
    });
    return request;
  });
}

function mockTelegramRequestSequence(handlers = {}) {
  https.request.mockImplementation((options, onResponse) => {
    const requestPath = options?.path || '';
    const handler = handlers[requestPath];
    if (!handler) {
      throw new Error(`Unexpected Telegram request path: ${requestPath}`);
    }

    const response = new EventEmitter();
    response.statusCode = handler.statusCode ?? 200;
    let decoder = null;
    response.setEncoding = jest.fn((encoding) => {
      decoder = new StringDecoder(encoding);
    });

    const request = new EventEmitter();
    request.end = jest.fn(() => {
      onResponse(response);
      const chunks = Array.isArray(handler.bodyChunks)
        ? handler.bodyChunks
        : (handler.body !== undefined ? [handler.body] : []);
      for (const chunk of chunks) {
        if (decoder && Buffer.isBuffer(chunk)) {
          const decoded = decoder.write(chunk);
          if (decoded) response.emit('data', decoded);
        } else {
          response.emit('data', chunk);
        }
      }
      if (decoder) {
        const remainder = decoder.end();
        if (remainder) {
          response.emit('data', remainder);
        }
      }
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

  test('requestTelegram preserves UTF-8 characters split across response chunks', async () => {
    const smile = '🙂';
    const bodyText = JSON.stringify({
      ok: true,
      result: [
        {
          update_id: 10,
          message: {
            chat: { id: 123456 },
            text: `split ${smile} utf8`,
          },
        },
      ],
    });
    const bodyBuffer = Buffer.from(bodyText, 'utf8');
    const smileBuffer = Buffer.from(smile, 'utf8');
    const smileIndex = bodyBuffer.indexOf(smileBuffer);

    expect(smileIndex).toBeGreaterThan(0);

    mockTelegramRequestSequence({
      '/bot123456789:fake_telegram_bot_token_do_not_use/getUpdates?offset=0&timeout=0': {
        bodyChunks: [
          bodyBuffer.subarray(0, smileIndex + 2),
          bodyBuffer.subarray(smileIndex + 2),
        ],
      },
    });

    const result = await telegramPoller._internals.requestTelegram(
      'GET',
      '/bot123456789:fake_telegram_bot_token_do_not_use/getUpdates?offset=0&timeout=0'
    );

    expect(result.statusCode).toBe(200);
    expect(result.body).toContain(`split ${smile} utf8`);
    expect(() => JSON.parse(result.body)).not.toThrow();
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

  test('getTelegramConfig accepts TELEGRAM_CHAT_ALLOWLIST as an authorization alias', () => {
    expect(telegramPoller._internals.getTelegramConfig({
      TELEGRAM_BOT_TOKEN: '123456789:fake_telegram_bot_token_do_not_use',
      TELEGRAM_CHAT_ID: '5613428850',
      TELEGRAM_CHAT_ALLOWLIST: '8754356993',
    })).toEqual(expect.objectContaining({
      chatId: 5613428850,
      authorizedChatIds: [8754356993],
    }));
  });

  test('pollNow downloads inbound Telegram photos and updates latest screenshot path', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-poller-photo-'));
    const mediaDir = path.join(tempDir, 'telegram-inbound');
    const latestPath = path.join(tempDir, 'latest.png');
    const onMessage = jest.fn();
    const photoBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]);

    telegramPoller.start({
      env: {
        TELEGRAM_BOT_TOKEN: '123456789:fake_telegram_bot_token_do_not_use',
        TELEGRAM_CHAT_ID: '123456',
      },
      onMessage,
      mediaDownloadRoot: mediaDir,
      latestScreenshotPath: latestPath,
    });

    mockTelegramRequestSequence({
      '/bot123456789:fake_telegram_bot_token_do_not_use/getUpdates?offset=0&timeout=0': {
        body: JSON.stringify({
          ok: true,
          result: [
            {
              update_id: 21,
              message: {
                message_id: 99,
                chat: { id: 123456 },
                from: { username: 'rachelchoi' },
                caption: 'receipt',
                photo: [
                  { file_id: 'small-photo', file_unique_id: 'small-unique' },
                  { file_id: 'large-photo', file_unique_id: 'large-unique' },
                ],
              },
            },
          ],
        }),
      },
      '/bot123456789:fake_telegram_bot_token_do_not_use/getFile?file_id=large-photo': {
        body: JSON.stringify({
          ok: true,
          result: {
            file_path: 'photos/file_123.png',
          },
        }),
      },
      '/file/bot123456789:fake_telegram_bot_token_do_not_use/photos/file_123.png': {
        body: photoBytes,
      },
    });

    try {
      await telegramPoller._internals.pollNow();

      expect(onMessage).toHaveBeenCalledTimes(1);
      expect(onMessage).toHaveBeenCalledWith(
        '[Photo] receipt',
        '@rachelchoi',
        expect.objectContaining({
          updateId: 21,
          updateKind: 'message',
          messageId: 99,
          media: expect.objectContaining({
            kind: 'photo',
            fileId: 'large-photo',
            telegramFilePath: 'photos/file_123.png',
            latestScreenshotPath: latestPath,
          }),
        })
      );

      const metadata = onMessage.mock.calls[0][2];
      expect(fs.existsSync(metadata.media.localPath)).toBe(true);
      expect(fs.readFileSync(metadata.media.localPath)).toEqual(photoBytes);
      expect(fs.existsSync(latestPath)).toBe(true);
      expect(fs.readFileSync(latestPath)).toEqual(photoBytes);
      expect(log.info).toHaveBeenCalledWith(
        'Telegram',
        expect.stringContaining('Inbound Telegram photo detected')
      );
      expect(log.info).toHaveBeenCalledWith(
        'Telegram',
        expect.stringContaining('Dispatching inbound Telegram update 21 to callback')
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('pollNow accepts photo updates delivered through edited_message payloads', async () => {
    const onMessage = jest.fn();

    telegramPoller.start({
      env: {
        TELEGRAM_BOT_TOKEN: '123456789:fake_telegram_bot_token_do_not_use',
        TELEGRAM_CHAT_ID: '5613428850',
        TELEGRAM_CHAT_ALLOWLIST: '8754356993',
      },
      onMessage,
      downloadMedia: false,
    });

    mockTelegramUpdates([
      {
        update_id: 31,
        edited_message: {
          message_id: 77,
          chat: { id: 8754356993 },
          from: { username: 'rachelchoi' },
          photo: [
            { file_id: 'photo-1' },
          ],
        },
      },
    ]);

    await telegramPoller._internals.pollNow();

    expect(onMessage).toHaveBeenCalledWith(
      '[Photo received]',
      '@rachelchoi',
      expect.objectContaining({
        updateId: 31,
        updateKind: 'edited_message',
        messageId: 77,
      })
    );
  });

  test('buildInboundDisplayText falls back to photo text for captionless media', () => {
    expect(telegramPoller._internals.buildInboundDisplayText({
      photo: [{ file_id: 'photo-1' }],
    })).toBe('[Photo received]');
  });

  describe('profile-scoped chat routing', () => {
    const JAMES_CHAT_ID = 111111111;
    const EUNBYEOL_CHAT_ID = 8754356993;
    const STRAY_CHAT_ID = 222222222;

    function buildConfig(envOverrides) {
      return telegramPoller._internals.getTelegramConfig({
        TELEGRAM_BOT_TOKEN: 'test-token',
        TELEGRAM_CHAT_ID: String(JAMES_CHAT_ID),
        TELEGRAM_AUTHORIZED_CHAT_IDS: `${JAMES_CHAT_ID},${EUNBYEOL_CHAT_ID}`,
        TELEGRAM_EUNBYEOL_CHAT_IDS: String(EUNBYEOL_CHAT_ID),
        ...envOverrides,
      });
    }

    function msg(chatId) {
      return { chat: { id: chatId } };
    }

    test('main profile rejects [private-profile] chat so case messages do not leak', () => {
      const config = buildConfig({ SQUIDRUN_PROFILE: '' });
      expect(telegramPoller._internals.isAuthorizedChat(msg(EUNBYEOL_CHAT_ID), config)).toBe(false);
    });

    test('main profile accepts the user chat', () => {
      const config = buildConfig({ SQUIDRUN_PROFILE: '' });
      expect(telegramPoller._internals.isAuthorizedChat(msg(JAMES_CHAT_ID), config)).toBe(true);
    });

    test('private-profile profile accepts [private-profile] chat', () => {
      const config = buildConfig({ SQUIDRUN_PROFILE: 'private-profile' });
      expect(telegramPoller._internals.isAuthorizedChat(msg(EUNBYEOL_CHAT_ID), config)).toBe(true);
    });

    test('private-profile profile rejects the user chat so trading talk does not leak in', () => {
      const config = buildConfig({ SQUIDRUN_PROFILE: 'private-profile' });
      expect(telegramPoller._internals.isAuthorizedChat(msg(JAMES_CHAT_ID), config)).toBe(false);
    });

    test('private-profile profile rejects any chat not in the private-profile allowlist', () => {
      const config = buildConfig({ SQUIDRUN_PROFILE: 'private-profile' });
      expect(telegramPoller._internals.isAuthorizedChat(msg(STRAY_CHAT_ID), config)).toBe(false);
    });

    test('fail-safe: empty TELEGRAM_EUNBYEOL_CHAT_IDS preserves legacy main-profile behavior', () => {
      const config = telegramPoller._internals.getTelegramConfig({
        TELEGRAM_BOT_TOKEN: 'test-token',
        TELEGRAM_CHAT_ID: String(JAMES_CHAT_ID),
        TELEGRAM_AUTHORIZED_CHAT_IDS: `${JAMES_CHAT_ID},${EUNBYEOL_CHAT_ID}`,
        // No TELEGRAM_EUNBYEOL_CHAT_IDS set
        SQUIDRUN_PROFILE: '',
      });
      // Both IDs should be accepted when no private-profile scope is declared — matches pre-patch behavior.
      expect(telegramPoller._internals.isAuthorizedChat(msg(JAMES_CHAT_ID), config)).toBe(true);
      expect(telegramPoller._internals.isAuthorizedChat(msg(EUNBYEOL_CHAT_ID), config)).toBe(true);
    });
  });
});
