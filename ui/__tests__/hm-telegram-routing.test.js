const fs = require('fs');
const os = require('os');
const path = require('path');
const { mockDefaultConfig } = require('./helpers/mock-config');

jest.mock('../config', () => require('./helpers/mock-config').mockDefaultConfig);

jest.mock('../scripts/hm-telegram', () => ({
  sendTelegram: jest.fn(async (_message, _env, options = {}) => ({
    ok: true,
    chatId: options.chatId ? Number(options.chatId) : 123456789,
    messageId: options.messageId || 'tg-msg-1',
  })),
  normalizeChatId: jest.fn((value) => {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    return /^-?\d+$/.test(text) ? text : null;
  }),
}));

describe('hm-telegram-routing', () => {
  const originalWorkspacePath = mockDefaultConfig.WORKSPACE_PATH;
  let tempRoot;

  beforeEach(() => {
    jest.resetModules();
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-telegram-routing-'));
    mockDefaultConfig.WORKSPACE_PATH = tempRoot;
    fs.mkdirSync(path.join(tempRoot, 'runtime'), { recursive: true });
  });

  afterEach(() => {
    mockDefaultConfig.WORKSPACE_PATH = originalWorkspacePath;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('falls back to default routes when no routing file exists', () => {
    const routing = require('../scripts/hm-telegram-routing');

    const eunbyeolRoute = routing.resolveTelegramRoute({ chatId: '8754356993' });
    const defaultRoute = routing.resolveTelegramRoute({ chatId: '1111111111' });

    expect(eunbyeolRoute.route).toEqual(expect.objectContaining({
      method: 'send-long-telegram',
      language: 'ko',
    }));
    expect(defaultRoute.route).toEqual(expect.objectContaining({
      method: 'hm-send-telegram',
      language: 'en',
    }));
  });

  it('chunks long routed messages for Eunbyeol', async () => {
    const { sendTelegram } = require('../scripts/hm-telegram');
    const routing = require('../scripts/hm-telegram-routing');
    const longMessage = `${'A'.repeat(3200)}\n\n${'B'.repeat(3200)}`;

    const result = await routing.sendRoutedTelegramMessage(longMessage, process.env, {
      chatId: '8754356993',
      messageId: 'route-long',
      senderRole: 'builder',
    });

    expect(sendTelegram).toHaveBeenCalledTimes(2);
    expect(sendTelegram.mock.calls[0][2]).toEqual(expect.objectContaining({
      chatId: '8754356993',
      messageId: 'route-long-part1',
      metadata: expect.objectContaining({
        routeMethod: 'send-long-telegram',
        chunkIndex: 1,
        chunkCount: 2,
      }),
    }));
    expect(sendTelegram.mock.calls[1][2]).toEqual(expect.objectContaining({
      chatId: '8754356993',
      messageId: 'route-long-part2',
      metadata: expect.objectContaining({
        routeMethod: 'send-long-telegram',
        chunkIndex: 2,
        chunkCount: 2,
      }),
    }));
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      method: 'send-long-telegram',
      chunkCount: 2,
    }));
  });

  it('uses the standard sender for non-special chats', async () => {
    const { sendTelegram } = require('../scripts/hm-telegram');
    const routing = require('../scripts/hm-telegram-routing');

    const result = await routing.sendRoutedTelegramMessage('hello', process.env, {
      chatId: '123456789',
      messageId: 'route-default',
      senderRole: 'builder',
    });

    expect(sendTelegram).toHaveBeenCalledTimes(1);
    expect(sendTelegram).toHaveBeenCalledWith(
      'hello',
      process.env,
      expect.objectContaining({
        chatId: '123456789',
        messageId: 'route-default',
        metadata: expect.objectContaining({
          routeMethod: 'hm-send-telegram',
        }),
      })
    );
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      method: 'hm-send-telegram',
    }));
  });
});
