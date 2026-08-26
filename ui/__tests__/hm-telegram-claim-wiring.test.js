/**
 * Strict hm-telegram wiring: claim outcome -> HTTP call count (Architect #121).
 *
 * The atomic claim existed for several commits while NOTHING consulted it —
 * hm-telegram still called a best-effort record helper, so none of the
 * duplicate protection had any production effect. These tests assert the thing
 * that actually matters at this seam: for each claim outcome, did an HTTP
 * request happen or not.
 *
 * Counting requests is deliberate. A test that only inspects the returned
 * object cannot tell "we refused to send" from "we sent and then described it
 * badly", and those differ by one duplicate message in Operator's chat.
 */
const https = require('https');

jest.mock('https');
jest.mock('../modules/main/comms-journal', () => ({
  appendCommsJournalEntry: jest.fn(() => ({ ok: true, status: 'recorded' })),
  queryCommsJournalEntries: jest.fn(() => []),
  claimCommsSend: jest.fn(() => ({ ok: true, acquired: true, sendAllowed: true, outcome: 'claimed_new' })),
  closeCommsJournalStores: jest.fn(),
}));

const ENV = {
  TELEGRAM_BOT_TOKEN: '123456789:fake_token_do_not_use',
  TELEGRAM_CHAT_ID: '123456',
};

const STRICT = {
  messageId: 'telegram-in-1-mira-reply',
  requireDurableJournal: true,
  metadata: { inboundMessageId: 'telegram-in-1' },
};

describe('strict claim wiring', () => {
  let sendTelegram;
  let journal;
  let requests;

  function mockResponse(payload, statusCode = 200) {
    // eslint-disable-next-line global-require
    const freshHttps = require('https');
    freshHttps.request.mockImplementation((options, callback) => {
      requests.push(options);
      const res = {
        statusCode,
        setEncoding() {},
        on(event, handler) {
          if (event === 'data') handler(JSON.stringify(payload));
          if (event === 'end') handler();
          return this;
        },
      };
      if (typeof callback === 'function') callback(res);
      return { on() { return this; }, write() {}, end() {}, destroy() {}, setTimeout() { return this; } };
    });
  }

  beforeEach(() => {
    jest.resetModules();
    requests = [];
    journal = require('../modules/main/comms-journal');
    journal.appendCommsJournalEntry.mockReturnValue({ ok: true, status: 'recorded' });
    journal.claimCommsSend.mockReturnValue({
      ok: true, acquired: true, sendAllowed: true, outcome: 'claimed_new',
    });
    mockResponse({ ok: true, result: { message_id: 55, chat: { id: 123456 } } });
    ({ sendTelegram } = require('../scripts/hm-telegram'));
  });

  afterEach(() => jest.clearAllMocks());

  test.each([
    ['claimed_new', { outcome: 'claimed_new' }],
    ['reclaimed_after_failure', { outcome: 'reclaimed_after_failure', attempt: 2 }],
  ])('%s sends exactly ONE request', async (_l, claim) => {
    journal.claimCommsSend.mockReturnValue({ ok: true, acquired: true, sendAllowed: true, ...claim });
    const result = await sendTelegram('reply', ENV, STRICT);
    expect(requests).toHaveLength(1);
    expect(result.ok).toBe(true);
  });

  test('already_delivered sends ZERO requests and reports ok suppression', async () => {
    // Must be ok, not a failure: a multipart send has to continue past a part
    // that is already in the chat.
    journal.claimCommsSend.mockReturnValue({
      ok: true, acquired: false, sendAllowed: false, outcome: 'already_delivered',
    });
    const result = await sendTelegram('reply', ENV, STRICT);
    expect(requests).toEqual([]);
    expect(result).toMatchObject({ ok: true, suppressed: true, alreadyDelivered: true });
  });

  test('already_claimed sends ZERO requests and HOLDS as ambiguous', async () => {
    journal.claimCommsSend.mockReturnValue({
      ok: true, acquired: false, sendAllowed: false, outcome: 'already_claimed',
    });
    const result = await sendTelegram('reply', ENV, STRICT);
    expect(requests).toEqual([]);
    expect(result).toMatchObject({ ok: false, accepted: true, ambiguous: true });
    expect(result.definiteNoSend).toBeFalsy();
  });

  test.each([
    ['identity_mismatch'],
    ['identity_incomplete'],
    ['identity_invalid'],
  ])('%s sends ZERO requests and HOLDS on integrity', async (outcome) => {
    journal.claimCommsSend.mockReturnValue({
      ok: false, acquired: false, sendAllowed: false, outcome, field: 'routeKey',
    });
    const result = await sendTelegram('reply', ENV, STRICT);
    expect(requests).toEqual([]);
    expect(result).toMatchObject({ ok: false, accepted: true, ambiguous: true, claimOutcome: outcome });
  });

  test.each([
    ['unavailable'],
    ['claim_failed'],
  ])('%s sends ZERO requests and is a DEFINITE pre-send failure', async (outcome) => {
    // The network was never touched, so a caller may safely fall back.
    journal.claimCommsSend.mockReturnValue({
      ok: false, acquired: false, sendAllowed: false, outcome,
    });
    const result = await sendTelegram('reply', ENV, STRICT);
    expect(requests).toEqual([]);
    expect(result).toMatchObject({ ok: false, definiteNoSend: true });
  });

  // ------------------------------------------- post-claim terminal classification

  test('An EXPLICIT Bot API rejection is DEFINITE and persists failed', async () => {
    // payload.ok === false is Telegram telling us it did not accept the
    // message. That is proven, not ambiguous, and a caller may fall back.
    mockResponse({ ok: false, description: 'chat not found' });
    const result = await sendTelegram('reply', ENV, STRICT);

    expect(requests).toHaveLength(1);
    expect(result.ok).toBe(false);
    const statuses = journal.appendCommsJournalEntry.mock.calls.map((c) => c[0].status);
    expect(statuses).toContain('failed');
  });

  test.each([
    ['no message_id', { ok: true, result: { chat: { id: 123456 } } }],
    ['chat id does not match', { ok: true, result: { message_id: 55, chat: { id: 999 } } }],
    ['no result at all', { ok: true }],
  ])('A 2xx with unusable evidence (%s) is AMBIGUOUS, never acked', async (_l, payload) => {
    mockResponse(payload);
    const result = await sendTelegram('reply', ENV, STRICT);

    expect(requests).toHaveLength(1);
    expect(result).toMatchObject({ ok: false, accepted: true, ambiguous: true });
    const statuses = journal.appendCommsJournalEntry.mock.calls.map((c) => c[0].status);
    expect(statuses).not.toContain('acked');
    expect(statuses).not.toContain('failed');
  });

  test('A real success that cannot be durably marked delivered HOLDS', async () => {
    // Reporting verified success here would let a later replay find no
    // delivery evidence and send the message a second time.
    journal.appendCommsJournalEntry.mockImplementation((entry) => (
      entry.status === 'acked' ? { ok: false, reason: 'db_locked' } : { ok: true }
    ));
    const result = await sendTelegram('reply', ENV, STRICT);
    expect(result).toMatchObject({ ok: false, accepted: true, ambiguous: true, status: 'telegram_ack_not_durable' });
  });

  test('A THROWN claim wrapper is a zero-HTTP DEFINITE pre-send failure', async () => {
    journal.claimCommsSend.mockImplementation(() => { throw new Error('store exploded'); });
    const result = await sendTelegram('reply', ENV, STRICT);
    expect(requests).toEqual([]);
    expect(result).toMatchObject({ ok: false, definiteNoSend: true, status: 'telegram_claim_threw' });
  });

  test.each([
    ['zero', 0],
    ['negative', -5],
    ['fractional', 1.5],
    ['empty string', ''],
    ['a numeric string', '55'],
    ['a boolean', true],
    ['beyond safe integer range', Number.MAX_SAFE_INTEGER + 2],
  ])('A message_id that is %s is NOT valid success evidence', async (_l, id) => {
    // Number.isFinite accepted all of these, so a malformed success was acked
    // as delivered and the message could never be replayed if it had not been.
    mockResponse({ ok: true, result: { message_id: id, chat: { id: 123456 } } });
    const result = await sendTelegram('reply', ENV, STRICT);
    expect(result).toMatchObject({ ok: false, ambiguous: true });
  });

  test('AN EXPLICIT REJECTION IS DEFINITE so a caller may fall back', async () => {
    mockResponse({ ok: false, description: 'chat not found' });
    const result = await sendTelegram('reply', ENV, STRICT);
    expect(result).toMatchObject({ ok: false, definiteNoSend: true });
    expect(result.ambiguous).toBeFalsy();
  });

  test('A PREFLIGHT REFUSAL after an acquired claim is DEFINITE, not ambiguous', async () => {
    // Nothing left the process. Reporting ambiguous would hold a message that
    // can never become deliverable.
    const result = await sendTelegram('   ', ENV, STRICT);
    expect(requests).toEqual([]);
    expect(result).toMatchObject({ ok: false, definiteNoSend: true });
  });

  test('A REQUEST THROW after an acquired claim is AMBIGUOUS and writes no failed row', async () => {
    // The request may already have reached Telegram. A `failed` row here would
    // later read as proof of no-send and the message would go out twice.
    // eslint-disable-next-line global-require
    const freshHttps = require('https');
    freshHttps.request.mockImplementation(() => ({
      on(event, handler) {
        if (event === 'error') setImmediate(() => handler(new Error('read ECONNRESET')));
        return this;
      },
      write() {}, end() {}, destroy() {}, setTimeout() { return this; },
    }));

    const result = await sendTelegram('reply', ENV, STRICT);

    expect(result).toMatchObject({ ok: false, accepted: true, ambiguous: true });
    expect(result.definiteNoSend).toBe(false);
    const statuses = journal.appendCommsJournalEntry.mock.calls.map((c) => c[0].status);
    expect(statuses).not.toContain('failed');
  });

  test('NON-STRICT callers never consult the claim', async () => {
    await sendTelegram('ordinary message', ENV, { messageId: 'tg-ordinary' });
    expect(journal.claimCommsSend).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
  });
});
