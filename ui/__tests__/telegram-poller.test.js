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

function emitJsonResponse(response, payload, decoder = null) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  if (decoder) {
    response.emit('data', decoder.write(body));
    const remainder = decoder.end();
    if (remainder) response.emit('data', remainder);
  } else {
    response.emit('data', body);
  }
  response.emit('end');
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

  test('worker keepAlive keeps poll timer referenced', () => {
    const originalSetInterval = global.setInterval;
    const timer = { unref: jest.fn() };
    jest.spyOn(global, 'setInterval').mockImplementation(() => timer);

    const started = telegramPoller.start({
      env: {
        TELEGRAM_BOT_TOKEN: '123456789:fake_telegram_bot_token_do_not_use',
        TELEGRAM_CHAT_ID: '123456',
      },
      pollIntervalMs: 2000,
      keepAlive: true,
      onMessage: jest.fn(),
    });

    expect(started).toBe(true);
    expect(timer.unref).not.toHaveBeenCalled();

    telegramPoller.stop();
    global.setInterval.mockRestore();
    global.setInterval = originalSetInterval;
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

  test('restart loads durable cursor so old media updates are ignored and newer updates are accepted', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-poller-cursor-'));
    const statePath = path.join(tempDir, 'telegram-poller-state.json');
    const env = {
      TELEGRAM_BOT_TOKEN: '123456789:fake_telegram_bot_token_do_not_use',
      TELEGRAM_CHAT_ID: '123456',
    };
    const firstOnMessage = jest.fn();

    try {
      telegramPoller.start({
        env,
        onMessage: firstOnMessage,
        statePath,
      });

      mockTelegramUpdates([
        {
          update_id: 50,
          message: {
            message_id: 5,
            chat: { id: 123456 },
            from: { username: 'james' },
            text: 'first run',
          },
        },
      ]);

      await telegramPoller._internals.pollNow();
      expect(firstOnMessage).toHaveBeenCalledTimes(1);

      let persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      expect(Object.values(persisted.cursors)[0]).toEqual(expect.objectContaining({
        nextOffset: 51,
        lastUpdateId: 50,
        lastAction: 'delivered',
      }));

      telegramPoller.stop();
      const secondOnMessage = jest.fn();
      telegramPoller.start({
        env,
        onMessage: secondOnMessage,
        statePath,
      });

      mockTelegramRequestSequence({
        '/bot123456789:fake_telegram_bot_token_do_not_use/getUpdates?offset=51&timeout=0': {
          body: JSON.stringify({
            ok: true,
            result: [
              {
                update_id: 50,
                message: {
                  message_id: 5,
                  chat: { id: 123456 },
                  from: { username: 'james' },
                  photo: [{ file_id: 'old-photo' }],
                },
              },
              {
                update_id: 52,
                message: {
                  message_id: 7,
                  chat: { id: 123456 },
                  from: { username: 'james' },
                  text: 'fresh after restart',
                },
              },
            ],
          }),
        },
      });

      await telegramPoller._internals.pollNow();

      expect(secondOnMessage).toHaveBeenCalledTimes(1);
      expect(secondOnMessage).toHaveBeenCalledWith(
        'fresh after restart',
        '@james',
        expect.objectContaining({
          updateId: 52,
          messageId: 7,
        })
      );
      persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      expect(Object.values(persisted.cursors)[0]).toEqual(expect.objectContaining({
        nextOffset: 53,
        lastUpdateId: 52,
        lastAction: 'delivered',
      }));
    } finally {
      telegramPoller.stop();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('pollNow persists a heartbeat even when Telegram returns no updates', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-poller-heartbeat-'));
    const statePath = path.join(tempDir, 'telegram-poller-state.json');

    try {
      telegramPoller.start({
        env: {
          TELEGRAM_BOT_TOKEN: '123456789:fake_telegram_bot_token_do_not_use',
          TELEGRAM_CHAT_ID: '123456',
        },
        onMessage: jest.fn(),
        statePath,
      });

      mockTelegramUpdates([]);

      await telegramPoller._internals.pollNow();

      const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      expect(persisted.updatedAt).toEqual(expect.any(String));
      expect(Date.parse(persisted.updatedAt)).not.toBeNaN();
      expect(persisted.poller).toEqual(expect.objectContaining({
        cursorKey: expect.stringContaining('telegram:'),
        lastPollStatus: 'ok_empty',
        nextOffset: 0,
        pid: process.pid,
        profile: 'main',
      }));
      expect(Date.parse(persisted.poller.lastPollAt)).not.toBeNaN();
    } finally {
      telegramPoller.stop();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('pollNow times out a hung getUpdates request and clears in-flight for the next poll', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-poller-timeout-'));
    const statePath = path.join(tempDir, 'telegram-poller-state.json');
    const onMessage = jest.fn();
    let callIndex = 0;
    const requests = [];

    try {
      telegramPoller.start({
        env: {
          TELEGRAM_BOT_TOKEN: '123456789:fake_telegram_bot_token_do_not_use',
          TELEGRAM_CHAT_ID: '123456',
        },
        onMessage,
        requestTimeoutMs: 25,
        statePath,
      });

      https.request.mockImplementation((options, onResponse) => {
        callIndex += 1;
        const index = callIndex;
        const response = new EventEmitter();
        response.statusCode = 200;
        let decoder = null;
        response.setEncoding = jest.fn((encoding) => {
          decoder = new StringDecoder(encoding);
        });

        const request = new EventEmitter();
        request.setTimeout = jest.fn((ms, cb) => {
          request.timeoutMs = ms;
          request.timeoutCb = cb;
          return request;
        });
        request.destroy = jest.fn((err) => {
          request.emit('error', err);
        });
        request.end = jest.fn(() => {
          if (index !== 2) return;
          onResponse(response);
          emitJsonResponse(response, {
            ok: true,
            result: [{
              update_id: 77,
              message: {
                message_id: 9,
                chat: { id: 123456 },
                from: { username: 'james' },
                text: 'after timeout',
              },
            }],
          }, decoder);
        });
        requests.push({ options, request });
        return request;
      });

      const firstPoll = telegramPoller._internals.pollNow();
      expect(requests).toHaveLength(1);
      expect(requests[0].request.timeoutMs).toBe(25);
      requests[0].request.timeoutCb();
      await firstPoll;

      const persistedAfterTimeout = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      expect(persistedAfterTimeout.poller.lastPollStatus).toBe('request_timeout');
      expect(persistedAfterTimeout.poller.lastError).toContain('telegram_request_timeout');

      await telegramPoller._internals.pollNow();

      expect(requests).toHaveLength(2);
      expect(onMessage).toHaveBeenCalledWith(
        'after timeout',
        '@james',
        expect.objectContaining({
          updateId: 77,
          messageId: 9,
        })
      );
    } finally {
      telegramPoller.stop();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('startup drain marks delayed Telegram backlog while accepting fresh updates', async () => {
    const onMessage = jest.fn();
    const startedAtMs = Date.parse('2026-05-08T04:00:00.000Z');
    jest.spyOn(Date, 'now').mockReturnValue(startedAtMs);

    telegramPoller.start({
      env: {
        TELEGRAM_BOT_TOKEN: '123456789:fake_telegram_bot_token_do_not_use',
        TELEGRAM_CHAT_ID: '123456',
      },
      onMessage,
      downloadMedia: false,
      startedAtMs,
      startupGraceMs: 60 * 1000,
    });

    mockTelegramUpdates([
      {
        update_id: 60,
        message: {
          message_id: 8,
          date: Math.floor(Date.parse('2026-05-08T03:00:00.000Z') / 1000),
          chat: { id: 123456 },
          from: { username: 'james' },
          photo: [{ file_id: 'stale-photo' }],
        },
      },
      {
        update_id: 61,
        message: {
          message_id: 9,
          date: Math.floor(Date.parse('2026-05-08T04:00:05.000Z') / 1000),
          chat: { id: 123456 },
          from: { username: 'james' },
          text: 'fresh after startup',
        },
      },
    ]);

    await telegramPoller._internals.pollNow();

    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(onMessage).toHaveBeenNthCalledWith(
      1,
      '[delayed: 60m old] [Photo received]',
      '@james',
      expect.objectContaining({
        updateId: 60,
        messageId: 8,
      })
    );
    expect(onMessage).toHaveBeenNthCalledWith(
      2,
      'fresh after startup',
      '@james',
      expect.objectContaining({
        updateId: 61,
        messageId: 9,
      })
    );
    expect(log.warn).not.toHaveBeenCalledWith(
      'Telegram',
      expect.stringContaining('Dropped stale inbound Telegram update')
    );
  });

  test('backstop drops very old Telegram backlog loudly', async () => {
    const onMessage = jest.fn();
    const nowMs = Date.parse('2026-05-08T04:00:00.000Z');
    jest.spyOn(Date, 'now').mockReturnValue(nowMs);

    telegramPoller.start({
      env: {
        TELEGRAM_BOT_TOKEN: '123456789:fake_telegram_bot_token_do_not_use',
        TELEGRAM_CHAT_ID: '123456',
      },
      onMessage,
      downloadMedia: false,
      startupGraceMs: 60 * 1000,
      backlogBackstopDropMs: 60 * 60 * 1000,
    });

    mockTelegramUpdates([
      {
        update_id: 70,
        message: {
          message_id: 18,
          date: Math.floor(Date.parse('2026-05-08T02:00:00.000Z') / 1000),
          chat: { id: 123456 },
          from: { username: 'james' },
          text: 'old enough for backstop',
        },
      },
    ]);

    await telegramPoller._internals.pollNow();

    expect(onMessage).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      'Telegram',
      expect.stringContaining('DROPPED backlog update 70')
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
      TELEGRAM_CHAT_ALLOWLIST: '2222222222',
    })).toEqual(expect.objectContaining({
      chatId: 5613428850,
      authorizedChatIds: [2222222222],
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
                from: { username: 'scoped-contact' },
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
        '@scoped-contact',
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
        TELEGRAM_CHAT_ALLOWLIST: '2222222222',
      },
      onMessage,
      downloadMedia: false,
    });

    mockTelegramUpdates([
      {
        update_id: 31,
        edited_message: {
          message_id: 77,
          chat: { id: 2222222222 },
          from: { username: 'scoped-contact' },
          photo: [
            { file_id: 'photo-1' },
          ],
        },
      },
    ]);

    await telegramPoller._internals.pollNow();

    expect(onMessage).toHaveBeenCalledWith(
      '[Photo received]',
      '@scoped-contact',
      expect.objectContaining({
        updateId: 31,
        updateKind: 'edited_message',
        messageId: 77,
      })
    );
  });

  test('pollNow downloads inbound Telegram videos with safe video metadata', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-poller-video-'));
    const mediaDir = path.join(tempDir, 'telegram-inbound');
    const latestPath = path.join(tempDir, 'latest.png');
    const onMessage = jest.fn();
    const videoBytes = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);

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
              update_id: 41,
              message: {
                message_id: 101,
                chat: { id: 123456 },
                from: { username: 'iphone-user' },
                caption: 'toilet movement',
                video: {
                  file_id: 'video-file',
                  file_unique_id: 'video-unique',
                  mime_type: 'video/mp4',
                  duration: 7,
                  width: 1920,
                  height: 1080,
                },
              },
            },
          ],
        }),
      },
      '/bot123456789:fake_telegram_bot_token_do_not_use/getFile?file_id=video-file': {
        body: JSON.stringify({
          ok: true,
          result: {
            file_path: 'videos/file_456.mp4',
          },
        }),
      },
      '/file/bot123456789:fake_telegram_bot_token_do_not_use/videos/file_456.mp4': {
        body: videoBytes,
      },
    });

    try {
      await telegramPoller._internals.pollNow();

      expect(onMessage).toHaveBeenCalledTimes(1);
      expect(onMessage).toHaveBeenCalledWith(
        '[Video] toilet movement',
        '@iphone-user',
        expect.objectContaining({
          updateId: 41,
          updateKind: 'message',
          messageId: 101,
          video: expect.objectContaining({ file_id: 'video-file' }),
          media: expect.objectContaining({
            kind: 'video',
            telegramKind: 'video',
            fileId: 'video-file',
            telegramFilePath: 'videos/file_456.mp4',
            mimeType: 'video/mp4',
            duration: 7,
            width: 1920,
            height: 1080,
            latestScreenshotPath: null,
          }),
        })
      );

      const metadata = onMessage.mock.calls[0][2];
      expect(path.extname(metadata.media.localPath)).toBe('.mp4');
      expect(fs.existsSync(metadata.media.localPath)).toBe(true);
      expect(fs.readFileSync(metadata.media.localPath)).toEqual(videoBytes);
      expect(fs.existsSync(latestPath)).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('buildInboundDisplayText falls back to photo text for captionless media', () => {
    expect(telegramPoller._internals.buildInboundDisplayText({
      photo: [{ file_id: 'photo-1' }],
    })).toBe('[Photo received]');
  });

  test('buildInboundDisplayText falls back to video text for captionless media', () => {
    expect(telegramPoller._internals.buildInboundDisplayText({
      video: { file_id: 'video-1', mime_type: 'video/mp4' },
    })).toBe('[Video received]');
  });

  test('selectInboundMedia treats video documents as video attachments', () => {
    expect(telegramPoller._internals.selectInboundMedia({
      document: {
        file_id: 'doc-video',
        file_unique_id: 'doc-video-unique',
        file_name: 'clip.mov',
        mime_type: 'video/quicktime',
      },
    })).toEqual(expect.objectContaining({
      kind: 'video',
      telegramKind: 'document',
      fileId: 'doc-video',
      fileName: 'clip.mov',
      mimeType: 'video/quicktime',
    }));
  });

  test('default media download root is a neutral SquidRun runtime path', () => {
    const root = telegramPoller._internals.resolveDefaultMediaDownloadRoot({});
    const normalized = root.replace(/\\/g, '/');

    expect(normalized).toContain('/.squidrun/runtime/telegram-inbound-media');
    expect(normalized).not.toContain('Example Case');
  });

  test('explicit Telegram inbound media directory override still wins', () => {
    const root = telegramPoller._internals.resolveDefaultMediaDownloadRoot({
      TELEGRAM_INBOUND_MEDIA_DIR: 'D:\\custom-profile-media',
    });

    expect(root).toBe(path.resolve('D:\\custom-profile-media'));
  });

  describe('profile-scoped chat routing', () => {
    const JAMES_CHAT_ID = 111111111;
    const SCOPED_PROFILE_CHAT_ID = 2222222222;
    const STRAY_CHAT_ID = 222222222;

    function buildConfig(envOverrides) {
      return telegramPoller._internals.getTelegramConfig({
        TELEGRAM_BOT_TOKEN: 'test-token',
        TELEGRAM_CHAT_ID: String(JAMES_CHAT_ID),
        TELEGRAM_AUTHORIZED_CHAT_IDS: `${JAMES_CHAT_ID},${SCOPED_PROFILE_CHAT_ID}`,
        TELEGRAM_SCOPED_CHAT_IDS: String(SCOPED_PROFILE_CHAT_ID),
        ...envOverrides,
      });
    }

    function msg(chatId) {
      return { chat: { id: chatId } };
    }

    test('main profile rejects Scoped chat so case messages do not leak', () => {
      const config = buildConfig({ SQUIDRUN_PROFILE: '' });
      expect(telegramPoller._internals.isAuthorizedChat(msg(SCOPED_PROFILE_CHAT_ID), config)).toBe(false);
    });

    test('central main-profile owner accepts scoped chat ids for window routing', () => {
      const config = buildConfig({
        SQUIDRUN_PROFILE: '',
        SQUIDRUN_TELEGRAM_ACCEPT_SCOPED_CHATS: '1',
      });
      expect(telegramPoller._internals.isAuthorizedChat(msg(SCOPED_PROFILE_CHAT_ID), config)).toBe(true);
    });

    test('main profile accepts owner chat', () => {
      const config = buildConfig({ SQUIDRUN_PROFILE: '' });
      expect(telegramPoller._internals.isAuthorizedChat(msg(JAMES_CHAT_ID), config)).toBe(true);
    });

    test('scoped profile accepts Scoped chat', () => {
      const config = buildConfig({ SQUIDRUN_PROFILE: 'scoped' });
      expect(telegramPoller._internals.isAuthorizedChat(msg(SCOPED_PROFILE_CHAT_ID), config)).toBe(true);
    });

    test('scoped profile rejects owner chat so main-lane talk does not leak in', () => {
      const config = buildConfig({ SQUIDRUN_PROFILE: 'scoped' });
      expect(telegramPoller._internals.isAuthorizedChat(msg(JAMES_CHAT_ID), config)).toBe(false);
    });

    test('scoped profile rejects any chat not in the scoped allowlist', () => {
      const config = buildConfig({ SQUIDRUN_PROFILE: 'scoped' });
      expect(telegramPoller._internals.isAuthorizedChat(msg(STRAY_CHAT_ID), config)).toBe(false);
    });

    test('named side profile accepts only scoped chat ids', () => {
      const config = buildConfig({ SQUIDRUN_PROFILE: 'eunbyeol' });
      expect(telegramPoller._internals.isAuthorizedChat(msg(SCOPED_PROFILE_CHAT_ID), config)).toBe(true);
      expect(telegramPoller._internals.isAuthorizedChat(msg(JAMES_CHAT_ID), config)).toBe(false);
      expect(telegramPoller._internals.isAuthorizedChat(msg(STRAY_CHAT_ID), config)).toBe(false);
    });

    test('fail-safe: empty TELEGRAM_SCOPED_CHAT_IDS preserves legacy main-profile behavior', () => {
      const config = telegramPoller._internals.getTelegramConfig({
        TELEGRAM_BOT_TOKEN: 'test-token',
        TELEGRAM_CHAT_ID: String(JAMES_CHAT_ID),
        TELEGRAM_AUTHORIZED_CHAT_IDS: `${JAMES_CHAT_ID},${SCOPED_PROFILE_CHAT_ID}`,
        // No TELEGRAM_SCOPED_CHAT_IDS set
        SQUIDRUN_PROFILE: '',
      });
      // Both IDs should be accepted when no scoped scope is declared — matches pre-patch behavior.
      expect(telegramPoller._internals.isAuthorizedChat(msg(JAMES_CHAT_ID), config)).toBe(true);
      expect(telegramPoller._internals.isAuthorizedChat(msg(SCOPED_PROFILE_CHAT_ID), config)).toBe(true);
    });
  });
});
