const {
  dispatchInboundTelegramMessage,
  formatInbound,
  isMainTelegramWorkerAlive,
} = require('../scripts/hm-telegram-poller-lane');

describe('hm-telegram-poller-lane', () => {
  test('formats inbound videos with saved media path for Architect', () => {
    expect(formatInbound('', '@james', {
      updateId: 10,
      media: {
        kind: 'video',
        localPath: 'D:\\projects\\squidrun\\.squidrun\\runtime\\telegram-inbound-media\\video-10.mp4',
      },
    })).toBe('[Telegram from @james]: [Video received] | saved: D:\\projects\\squidrun\\.squidrun\\runtime\\telegram-inbound-media\\video-10.mp4');
  });

  test('formats document fallback without losing filename', () => {
    expect(formatInbound('', '@james', {
      media: {
        kind: 'document',
        fileName: 'report.pdf',
      },
    })).toBe('[Telegram from @james]: [File: report.pdf]');
  });

  test('dispatches routed non-main inbound messages to profile trigger only', () => {
    const sendToArchitect = jest.fn();
    const forwardToProfileTrigger = jest.fn(() => ({ ok: true, written: ['trigger'] }));

    const result = dispatchInboundTelegramMessage(
      '[Telegram from @ClientProfile]: hello',
      { chatId: '3333333333', updateId: 1 },
      {
        env: { TELEGRAM_CHAT_ID: '1111111111' },
        sendToArchitect,
        forwardToProfileTrigger,
        writeLog: jest.fn(),
        resolveInboundRoute: () => ({
          ok: true,
          chatId: '3333333333',
          windowKey: 'client-profile',
          profile: 'client-profile',
        }),
      }
    );

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      target: 'profile-trigger',
      windowKey: 'client-profile',
    }));
    expect(forwardToProfileTrigger).toHaveBeenCalledWith(
      'client-profile',
      '[Telegram from @ClientProfile]: hello',
      { TELEGRAM_CHAT_ID: '1111111111' }
    );
    expect(sendToArchitect).not.toHaveBeenCalled();
  });

  test('fails closed when inbound route is missing for a non-owner chat', () => {
    const sendToArchitect = jest.fn();
    const forwardToProfileTrigger = jest.fn();

    const result = dispatchInboundTelegramMessage(
      '[Telegram from @ClientProfile]: hello',
      { chatId: '3333333333', updateId: 2 },
      {
        sendToArchitect,
        forwardToProfileTrigger,
        writeLog: jest.fn(),
        resolveInboundRoute: () => ({
          ok: false,
          blocked: true,
          chatId: '3333333333',
          reason: 'missing_inbound_window_route',
        }),
      }
    );

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      blocked: true,
      reason: 'missing_inbound_window_route',
    }));
    expect(sendToArchitect).not.toHaveBeenCalled();
    expect(forwardToProfileTrigger).not.toHaveBeenCalled();
  });

  test('detects a running main app Telegram worker so standalone lane does not fight getUpdates', () => {
    expect(isMainTelegramWorkerAlive({
      processListText: [
        '1234 D:\\projects\\squidrun\\ui\\node_modules\\electron\\dist\\electron.exe D:\\projects\\squidrun\\ui\\modules\\main\\telegram-poller-worker.js',
      ].join('\n'),
    })).toBe(true);
  });

  test('does not treat unrelated Telegram Desktop as the main app poller', () => {
    expect(isMainTelegramWorkerAlive({
      processListText: [
        '1234 C:\\Program Files\\Telegram Desktop\\Telegram.exe',
        '2345 node D:\\projects\\squidrun\\ui\\scripts\\hm-telegram-poller-lane.js run',
      ].join('\n'),
    })).toBe(false);
  });
});
