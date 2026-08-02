/**
 * BEHAVIOURAL cover for the fail-closed pre-send record.
 *
 * Oracle #72 was right that the source-shape tests could not catch the wiring
 * bug: hm-telegram.js read correctly on its own while `requireDurableJournal`
 * was being silently dropped two layers up, so the strict branch was
 * unreachable from the only path that needs it. A test that reads source text
 * can only ever prove the code says what I meant; it cannot prove the flag
 * arrives.
 *
 * These drive sendTelegram itself with a failing journal and assert on whether
 * an HTTP send happened.
 */
const https = require('https');

jest.mock('https');
jest.mock('../modules/main/comms-journal', () => ({
  appendCommsJournalEntry: jest.fn(() => ({ ok: true, status: 'recorded' })),
  queryCommsJournalEntries: jest.fn(() => []),
  closeCommsJournalStores: jest.fn(),
}));

describe('hm-telegram fail-closed pre-send record (behavioural)', () => {
  let sendTelegram;
  let journal;
  let fetchCalls;

  beforeEach(() => {
    jest.resetModules();
    fetchCalls = [];
    // Re-require AFTER resetModules: configuring the stale module instance left
    // hm-telegram holding a different, unconfigured mock.
    // eslint-disable-next-line global-require
    const freshHttps = require('https');
    // hm-telegram sends over the https module, not fetch. Mocking the wrong
    // transport made the strict test pass for the wrong reason: nothing sent
    // because nothing COULD send.
    freshHttps.request.mockImplementation((options, callback) => {
      fetchCalls.push(options);
      const res = {
        statusCode: 200,
        setEncoding() {},
        on(event, handler) {
          if (event === 'data') handler('{"ok":true,"result":{"message_id":1}}');
          if (event === 'end') handler();
          return this;
        },
      };
      if (typeof callback === 'function') callback(res);
      return { on() { return this; }, write() {}, end() {}, destroy() {}, setTimeout() { return this; } };
    });
    journal = require('../modules/main/comms-journal');
    journal.appendCommsJournalEntry.mockReturnValue({ ok: true, status: 'recorded' });
    ({ sendTelegram } = require('../scripts/hm-telegram'));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  const env = {
    TELEGRAM_BOT_TOKEN: '123456789:fake_token_do_not_use',
    TELEGRAM_CHAT_ID: '123456',
  };

  test('STRICT: a failed durable record means NO HTTP send at all', async () => {
    journal.appendCommsJournalEntry.mockReturnValue({ ok: false, reason: 'db_locked' });

    const result = await sendTelegram('mira reply', env, {
      messageId: 'telegram-in-1-mira-reply',
      requireDurableJournal: true,
      metadata: { inboundMessageId: 'telegram-in-1' },
    });

    // The whole point: nothing may go out, because a crash mid-send would then
    // be indistinguishable from never having sent, and replay would re-send.
    expect(fetchCalls).toEqual([]);
    expect(result).toMatchObject({ ok: false, error: 'durable_journal_unavailable' });
  });

  test('STRICT: a successful record allows the send', async () => {
    const result = await sendTelegram('mira reply', env, {
      messageId: 'telegram-in-2-mira-reply',
      requireDurableJournal: true,
      metadata: { inboundMessageId: 'telegram-in-2' },
    });

    expect(fetchCalls.length).toBeGreaterThan(0);
    expect(result.ok).not.toBe(false);
  });

  test('NON-STRICT is unchanged: a failed record still warns and proceeds', async () => {
    // Unrelated senders must not silently acquire fail-closed behaviour.
    journal.appendCommsJournalEntry.mockReturnValue({ ok: false, reason: 'db_locked' });

    await sendTelegram('ordinary message', env, { messageId: 'tg-ordinary' });

    expect(fetchCalls.length).toBeGreaterThan(0);
  });
});
