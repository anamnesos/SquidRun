/**
 * Atomic send-claim (Architect #93/#113).
 *
 * WHY THIS EXISTS AS ITS OWN PRIMITIVE: upsertCommsJournal returns ok:true for
 * an EXISTING row (status "updated"). A caller inferring "I may send" from that
 * ok would put a second copy of an already-recorded — or already-delivered —
 * message in front of the user. It also refuses to demote a `failed` row back
 * to `recorded`, so a legitimate retry sends while the durable state still
 * reads failed, and a crash there is then misread as a definite no-send and
 * sent a third time.
 *
 * Every test uses TWO independent store handles on the same database file,
 * because a claim that only works within one process object proves nothing
 * about the race it exists to prevent.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { EvidenceLedgerStore } = require('../modules/main/evidence-ledger-store');

const roots = [];
function tempDbPath() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-cas-'));
  roots.push(root);
  return path.join(root, 'evidence-ledger.db');
}

const handles = [];
function openStore(dbPath) {
  const store = new EvidenceLedgerStore({ dbPath });
  // The constructor does not open the database; init() does. Without this the
  // claim returns 'unavailable' and every assertion would be about a store
  // that was never connected.
  // Assert the open SUCCEEDED. Without this, a store that never connected
  // returns 'unavailable' for every claim and the suite would be asserting
  // against SQLite it never touched.
  const opened = store.init();
  expect(opened?.ok).toBe(true);
  handles.push(store);
  return store;
}

afterEach(() => {
  while (handles.length) {
    const store = handles.pop();
    try { if (typeof store.close === 'function') store.close(); } catch { /* already closed */ }
  }
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

// A claim must NAME the message completely. Every field here is required.
const ENTRY = {
  messageId: 'telegram-in-1-mira-reply',
  channel: 'telegram',
  direction: 'outbound',
  senderRole: 'mira',
  targetRole: 'james',
  rawBody: 'the reply body',
  inboundMessageId: 'telegram-in-1',
  chatId: 1111111111,
  windowKey: 'main',
  profile: 'main',
  routeKey: 'main',
};

test('EXACTLY ONE of two handles acquires the claim', () => {
  const dbPath = tempDbPath();
  const a = openStore(dbPath);
  const b = openStore(dbPath);

  const first = a.claimCommsSend(ENTRY);
  const second = b.claimCommsSend(ENTRY);

  expect(first).toMatchObject({ acquired: true, sendAllowed: true, outcome: 'claimed_new' });
  // The loser must not send. This is the whole point.
  expect(second).toMatchObject({ acquired: false, sendAllowed: false, outcome: 'already_claimed' });
});

test('CRASH REPLAY on a recorded row suppresses the send', () => {
  const dbPath = tempDbPath();
  openStore(dbPath).claimCommsSend(ENTRY);

  // "Restart": a brand new handle with no memory.
  const replay = openStore(dbPath).claimCommsSend(ENTRY);

  expect(replay).toMatchObject({ acquired: false, sendAllowed: false, outcome: 'already_claimed' });
});

test('A DELIVERED row suppresses the send as delivered, not as in-flight', () => {
  const dbPath = tempDbPath();
  const store = openStore(dbPath);
  store.claimCommsSend(ENTRY);
  store.upsertCommsJournal({
    ...ENTRY, status: 'acked', ackStatus: 'telegram_delivered',
  });

  const replay = openStore(dbPath).claimCommsSend(ENTRY);
  expect(replay).toMatchObject({ acquired: false, sendAllowed: false, outcome: 'already_delivered' });
});

test('A FAILED row is atomically reset to recorded BEFORE a retry may send', () => {
  const dbPath = tempDbPath();
  const store = openStore(dbPath);
  store.claimCommsSend(ENTRY);
  store.upsertCommsJournal({ ...ENTRY, status: 'failed', errorCode: 'telegram_send_failed' });

  const retry = openStore(dbPath).claimCommsSend(ENTRY);
  expect(retry).toMatchObject({ acquired: true, sendAllowed: true, outcome: 'reclaimed_after_failure' });
  expect(retry.attempt).toBe(2);

  // The reset must be PERSISTED and visible through a DIFFERENT handle before
  // any HTTP call — otherwise a crash here still reads as failed and resends.
  const observer = openStore(dbPath);
  const [row] = observer.queryCommsJournal({ messageId: ENTRY.messageId, limit: 1 }) || [];
  expect(row).toMatchObject({ status: 'recorded', attempt: 2 });
  expect(row.ackStatus ?? row.ack_status ?? null).toBeNull();
  expect(row.errorCode ?? row.error_code ?? null).toBeNull();

  // The reset must be VISIBLE to another handle before the HTTP call, so a
  // concurrent claimant cannot also send.
  const concurrent = openStore(dbPath).claimCommsSend(ENTRY);
  expect(concurrent).toMatchObject({ acquired: false, sendAllowed: false });
});

test.each([
  ['different body', { rawBody: 'a completely different reply' }],
  ['different sender', { senderRole: 'architect' }],
  ['different direction', { direction: 'inbound' }],
  ['different channel', { channel: 'ws' }],
])('IDENTITY MISMATCH fails closed: %s', (_l, override) => {
  const dbPath = tempDbPath();
  openStore(dbPath).claimCommsSend(ENTRY);

  const mismatched = openStore(dbPath).claimCommsSend({ ...ENTRY, ...override });
  expect(mismatched).toMatchObject({ acquired: false, sendAllowed: false, outcome: 'identity_mismatch' });
});

test.each([
  ['inboundMessageId', 'inboundMessageId'],
  ['chatId', 'chatId'],
  ['windowKey', 'windowKey'],
  ['profile', 'profile'],
  ['routeKey', 'routeKey'],
])('A CLAIM MISSING REQUIRED IDENTITY (%s) FAILS CLOSED', (_l, field) => {
  // Missing identity used to be a WILDCARD, so a claim could be reused by any
  // message sharing the id — the opposite of what a claim is for.
  const dbPath = tempDbPath();
  const partial = { ...ENTRY };
  delete partial[field];

  const result = openStore(dbPath).claimCommsSend(partial);
  expect(result).toMatchObject({ acquired: false, sendAllowed: false, outcome: 'identity_incomplete', field });
});

test.each([
  ['different inbound message', { inboundMessageId: 'telegram-in-999' }],
  ['different chat', { chatId: 2222222222 }],
  ['different window', { windowKey: 'sideprofile' }],
  ['different profile', { profile: 'sideprofile' }],
  ['different route', { routeKey: 'sideprofile' }],
])('ROUTE IDENTITY MISMATCH fails closed: %s', (_l, override) => {
  const dbPath = tempDbPath();
  openStore(dbPath).claimCommsSend(ENTRY);

  const mismatched = openStore(dbPath).claimCommsSend({ ...ENTRY, ...override });
  expect(mismatched).toMatchObject({ acquired: false, sendAllowed: false, outcome: 'identity_mismatch' });
});

test('CHUNK FIELDS ARE OPTIONAL ONLY TOGETHER', () => {
  const dbPath = tempDbPath();
  const store = openStore(dbPath);
  // One without the other cannot name a chunk position.
  expect(store.claimCommsSend({ ...ENTRY, chunkIndex: 1 }))
    .toMatchObject({ acquired: false, outcome: 'identity_incomplete' });
  expect(store.claimCommsSend({ ...ENTRY, chunkCount: 3 }))
    .toMatchObject({ acquired: false, outcome: 'identity_incomplete' });
  // Both present is a valid, distinct identity.
  expect(store.claimCommsSend({ ...ENTRY, chunkIndex: 1, chunkCount: 3 }))
    .toMatchObject({ acquired: true, sendAllowed: true });
});

test('AN EMPTY BODY IS STILL HASHED, so it cannot match a different message', () => {
  const dbPath = tempDbPath();
  openStore(dbPath).claimCommsSend({ ...ENTRY, rawBody: '' });
  const other = openStore(dbPath).claimCommsSend({ ...ENTRY, rawBody: 'now with content' });
  expect(other).toMatchObject({ acquired: false, outcome: 'identity_mismatch', field: 'bodyHash' });
});
