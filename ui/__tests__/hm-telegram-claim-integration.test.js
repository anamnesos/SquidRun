/**
 * REAL store integration for the strict send path (Architect #124).
 *
 * The claim-wiring suite mocks comms-journal entirely. That proves the branch
 * logic and the HTTP call counts, but it cannot prove a single byte reaches a
 * database — and I reported "second-handle proof observes the same store" on
 * the strength of it, which was false. Every strict journal write also needed
 * `{dbPath}` threaded to it; the helper accepted the option and no call site
 * passed it, so the threading was decorative.
 *
 * This suite uses a REAL temp database and reads the resulting row back through
 * an INDEPENDENT store handle, because a write only one handle can see is not a
 * durable record of anything.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('https');

jest.mock('https');

const { EvidenceLedgerStore } = require('../modules/main/evidence-ledger-store');
const { closeCommsJournalStores } = require('../modules/main/comms-journal');
const { sendTelegram } = require('../scripts/hm-telegram');

const roots = [];
const handles = [];

function tempDbPath() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-claim-int-'));
  roots.push(root);
  return path.join(root, 'evidence-ledger.db');
}

/** An INDEPENDENT handle: the point is to read what another writer persisted. */
function observer(dbPath) {
  const store = new EvidenceLedgerStore({ dbPath });
  const opened = store.init();
  expect(opened?.ok).toBe(true);
  handles.push(store);
  return store;
}

function rowFor(dbPath, messageId) {
  const [row] = observer(dbPath).queryCommsJournal({ messageId, limit: 1 }) || [];
  return row || null;
}

function mockResponse(payload, statusCode = 200) {
  https.request.mockImplementation((options, callback) => {
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

const ENV = {
  TELEGRAM_BOT_TOKEN: '123456789:fake_token_do_not_use',
  TELEGRAM_CHAT_ID: '123456',
};

/** Complete production-shaped identity: the claim requires all of it. */
function strictOpts(dbPath, messageId = 'telegram-in-1-mira-reply') {
  return {
    messageId,
    dbPath,
    requireDurableJournal: true,
    senderRole: 'mira',
    targetRole: 'operator',
    metadata: {
      inboundMessageId: 'telegram-in-1',
      chatId: '123456',
      windowKey: 'main',
      profile: 'main',
      routeKey: 'main',
    },
  };
}

afterEach(() => {
  // sendTelegram opens its OWN store through comms-journal; leaving that handle
  // open holds a lock on the sqlite file and the temp cleanup fails with EPERM.
  try { closeCommsJournalStores(); } catch { /* nothing open */ }
  while (handles.length) {
    const store = handles.pop();
    try { if (typeof store.close === 'function') store.close(); } catch { /* already closed */ }
  }
  while (roots.length) {
    const root = roots.pop();
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // A stubborn lock must not fail the assertions above; the dir lives in
      // the temp sandbox either way.
    }
  }
  jest.clearAllMocks();
});

test('VALID SUCCESS is persisted as acked + telegram_delivered, visible to another handle', async () => {
  const dbPath = tempDbPath();
  mockResponse({ ok: true, result: { message_id: 55, chat: { id: 123456 } } });

  const result = await sendTelegram('reply body', ENV, strictOpts(dbPath));
  expect(result.ok).toBe(true);

  const row = rowFor(dbPath, 'telegram-in-1-mira-reply');
  expect(row).toMatchObject({ status: 'acked' });
  expect(row.ackStatus ?? row.ack_status).toBe('telegram_delivered');
});

test('MALFORMED 2xx leaves the row at recorded — never acked, never failed', async () => {
  // The claim is held, so the row exists. What must NOT happen is it being
  // marked delivered on evidence we cannot read, because that retires a
  // message that may never have arrived.
  const dbPath = tempDbPath();
  mockResponse({ ok: true, result: { chat: { id: 123456 } } });

  const result = await sendTelegram('reply body', ENV, strictOpts(dbPath));
  expect(result).toMatchObject({ ok: false, ambiguous: true });

  const row = rowFor(dbPath, 'telegram-in-1-mira-reply');
  expect(row.status).toBe('recorded');
  expect(row.ackStatus ?? row.ack_status ?? null).toBeNull();
});

test('EXPLICIT REJECTION is persisted as failed and reported definite', async () => {
  const dbPath = tempDbPath();
  mockResponse({ ok: false, description: 'chat not found' });

  const result = await sendTelegram('reply body', ENV, strictOpts(dbPath));
  expect(result).toMatchObject({ ok: false, definiteNoSend: true });

  const row = rowFor(dbPath, 'telegram-in-1-mira-reply');
  expect(row.status).toBe('failed');
});

test('A TRANSPORT THROW leaves the row at recorded, NOT failed', async () => {
  // A `failed` row here would later read as proof of no-send and the message
  // would go out twice.
  const dbPath = tempDbPath();
  https.request.mockImplementation(() => ({
    on(event, handler) {
      if (event === 'error') setImmediate(() => handler(new Error('read ECONNRESET')));
      return this;
    },
    write() {}, end() {}, destroy() {}, setTimeout() { return this; },
  }));

  const result = await sendTelegram('reply body', ENV, strictOpts(dbPath));
  expect(result).toMatchObject({ ok: false, ambiguous: true });

  const row = rowFor(dbPath, 'telegram-in-1-mira-reply');
  expect(row.status).toBe('recorded');
});

test('A SECOND STRICT SEND of a delivered message performs NO request', async () => {
  const dbPath = tempDbPath();
  mockResponse({ ok: true, result: { message_id: 55, chat: { id: 123456 } } });
  await sendTelegram('reply body', ENV, strictOpts(dbPath));

  let requests = 0;
  https.request.mockImplementation((options, callback) => {
    requests += 1;
    const res = {
      statusCode: 200,
      setEncoding() {},
      on(event, handler) {
        if (event === 'data') handler(JSON.stringify({ ok: true, result: { message_id: 56, chat: { id: 123456 } } }));
        if (event === 'end') handler();
        return this;
      },
    };
    if (typeof callback === 'function') callback(res);
    return { on() { return this; }, write() {}, end() {}, destroy() {}, setTimeout() { return this; } };
  });

  const replay = await sendTelegram('reply body', ENV, strictOpts(dbPath));

  // End to end, through a real database: the duplicate never leaves.
  expect(requests).toBe(0);
  expect(replay).toMatchObject({ ok: true, suppressed: true, alreadyDelivered: true });
});

test.each([
  ['a non-allowlisted chat', { TELEGRAM_CHAT_ALLOWLIST: '999999' }, 'not allowlisted'],
  ['missing config', { TELEGRAM_BOT_TOKEN: '' }, 'Missing required env'],
])('A PREFLIGHT REFUSAL (%s) is DEFINITE and sends nothing', async (_l, envOverride, expected) => {
  // Nothing left the process, so a caller may fall back. Reporting ambiguous
  // would hold a message that can never become deliverable.
  const dbPath = tempDbPath();
  let requests = 0;
  https.request.mockImplementation(() => { requests += 1; return { on() { return this; }, write() {}, end() {}, destroy() {}, setTimeout() { return this; } }; });

  const result = await sendTelegram('reply body', { ...ENV, ...envOverride }, strictOpts(dbPath));

  expect(requests).toBe(0);
  expect(result).toMatchObject({ ok: false, definiteNoSend: true });
  expect(String(result.error)).toContain(expected);

  // The RETURN VALUE is not the contract. A caller that falls back needs the
  // refusal durably recorded, or a later replay finds no trace and re-sends.
  // Read it through the independent handle, from the same dbPath.
  const row = rowFor(dbPath, 'telegram-in-1-mira-reply');
  expect(row).not.toBeNull();
  expect(row.status).toBe('failed');
});
