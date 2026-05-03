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
  let activeMockConfig;
  let tempRoot;

  beforeEach(() => {
    jest.resetModules();
    activeMockConfig = require('./helpers/mock-config').mockDefaultConfig;
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-telegram-routing-'));
    activeMockConfig.WORKSPACE_PATH = tempRoot;
    fs.mkdirSync(path.join(tempRoot, 'runtime'), { recursive: true });
  });

  afterEach(() => {
    if (activeMockConfig) {
      activeMockConfig.WORKSPACE_PATH = originalWorkspacePath;
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('falls back to default routes when no routing file exists', () => {
    const routing = require('../scripts/hm-telegram-routing');

    const scopedRoute = routing.resolveTelegramRoute({ chatId: '2222222222' });
    const defaultRoute = routing.resolveTelegramRoute({ chatId: '1111111111' });

    expect(scopedRoute.route).toEqual(expect.objectContaining({
      method: 'send-long-telegram',
      language: 'ko',
    }));
    expect(defaultRoute.route).toEqual(expect.objectContaining({
      method: 'hm-send-telegram',
      language: 'en',
    }));
  });

  it('defaults no-chat Scoped profile sends to the Scoped route', () => {
    const routing = require('../scripts/hm-telegram-routing');

    const defaultRoute = routing.resolveTelegramRoute({
      env: {
        SQUIDRUN_PROFILE: 'scoped',
      },
    });

    expect(defaultRoute.route).toEqual(expect.objectContaining({
      method: 'send-long-telegram',
      language: 'ko',
    }));
  });

  it('chunks long routed messages for Scoped', async () => {
    const { sendTelegram } = require('../scripts/hm-telegram');
    const routing = require('../scripts/hm-telegram-routing');
    const longMessage = `${'A'.repeat(3200)}\n\n${'B'.repeat(3200)}`;

    const result = await routing.sendRoutedTelegramMessage(longMessage, process.env, {
      chatId: '2222222222',
      messageId: 'route-long',
      senderRole: 'builder',
    });

    expect(sendTelegram).toHaveBeenCalledTimes(2);
    expect(sendTelegram.mock.calls[0][2]).toEqual(expect.objectContaining({
      chatId: '2222222222',
      messageId: 'route-long-part1',
      metadata: expect.objectContaining({
        routeMethod: 'send-long-telegram',
        chunkIndex: 1,
        chunkCount: 2,
      }),
    }));
    expect(sendTelegram.mock.calls[1][2]).toEqual(expect.objectContaining({
      chatId: '2222222222',
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

  it('resolves explicit non-owner inbound chats to their configured window/profile', () => {
    fs.writeFileSync(
      path.join(tempRoot, 'runtime', 'telegram-routing.json'),
      JSON.stringify({
        '3333333333': {
          method: 'send-long-telegram',
          name: 'Client Profile',
          language: 'en',
          profile: 'client-profile',
          windowKey: 'client-profile',
        },
        default: {
          method: 'hm-send-telegram',
          name: 'Owner',
          language: 'en',
        },
      }),
      'utf8'
    );
    const routing = require('../scripts/hm-telegram-routing');

    expect(routing.resolveTelegramInboundRoute({
      chatId: '3333333333',
      env: { TELEGRAM_CHAT_ID: '1111111111' },
    })).toEqual(expect.objectContaining({
      ok: true,
      chatId: '3333333333',
      windowKey: 'client-profile',
      profile: 'client-profile',
      reason: 'explicit_non_owner_route',
    }));
  });

  it('keeps the owner chat on main inbound routing', () => {
    const routing = require('../scripts/hm-telegram-routing');

    expect(routing.resolveTelegramInboundRoute({
      chatId: '1111111111',
      env: { TELEGRAM_CHAT_ID: '1111111111' },
    })).toEqual(expect.objectContaining({
      ok: true,
      chatId: '1111111111',
      windowKey: 'main',
      profile: 'main',
      reason: 'owner_chat',
    }));
  });

  it('fails closed for non-owner inbound chats without explicit window/profile routing', () => {
    fs.writeFileSync(
      path.join(tempRoot, 'runtime', 'telegram-routing.json'),
      JSON.stringify({
        '3333333333': {
          method: 'send-long-telegram',
          name: 'Client Profile',
          language: 'en',
        },
        default: {
          method: 'hm-send-telegram',
          name: 'Owner',
          language: 'en',
        },
      }),
      'utf8'
    );
    const routing = require('../scripts/hm-telegram-routing');

    expect(routing.resolveTelegramInboundRoute({
      chatId: '3333333333',
      env: { TELEGRAM_CHAT_ID: '1111111111' },
    })).toEqual(expect.objectContaining({
      ok: false,
      blocked: true,
      chatId: '3333333333',
      reason: 'missing_inbound_window_route',
    }));
  });
});
