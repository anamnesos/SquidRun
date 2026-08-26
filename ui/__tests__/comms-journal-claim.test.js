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
  targetRole: 'operator',
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
  ['different window', { windowKey: 'client' }],
  ['different profile', { profile: 'client' }],
  ['different route', { routeKey: 'client' }],
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

test.each([
  ['zero index', { chunkIndex: 0, chunkCount: 3 }],
  ['fractional index', { chunkIndex: 1.5, chunkCount: 3 }],
  ['negative index', { chunkIndex: -1, chunkCount: 3 }],
  ['garbage string', { chunkIndex: 'first', chunkCount: 3 }],
  ['NaN count', { chunkIndex: 1, chunkCount: Number.NaN }],
  ['index beyond count', { chunkIndex: 4, chunkCount: 3 }],
])('AN INCOHERENT CHUNK POSITION claims nothing: %s', (_l, chunk) => {
  const dbPath = tempDbPath();
  const result = openStore(dbPath).claimCommsSend({ ...ENTRY, ...chunk });
  expect(result).toMatchObject({ acquired: false, sendAllowed: false, outcome: 'identity_invalid' });
});

test('REAL PRODUCER SHAPE: identity nested under metadata only still claims and replays', () => {
  // hm-telegram's recordEntry does NOT put these top-level; it nests them in
  // metadata. A claim that only understood friendly top-level aliases would
  // have failed closed on every real send.
  const dbPath = tempDbPath();
  const producerShape = {
    messageId: 'telegram-in-7-mira-reply',
    channel: 'telegram',
    direction: 'outbound',
    senderRole: 'mira',
    targetRole: 'operator',
    rawBody: 'chunked reply part 1',
    metadata: {
      inboundMessageId: 'telegram-in-7',
      chatId: 1111111111,
      windowKey: 'main',
      profile: 'main',
      routeKey: 'main',
      chunkIndex: 1,
      chunkCount: 3,
    },
  };

  const first = openStore(dbPath).claimCommsSend(producerShape);
  expect(first).toMatchObject({ acquired: true, sendAllowed: true, outcome: 'claimed_new' });

  // Replay through a second handle must recognise its OWN claim.
  const replay = openStore(dbPath).claimCommsSend(producerShape);
  expect(replay).toMatchObject({ acquired: false, sendAllowed: false, outcome: 'already_claimed' });

  // A different chunk of the same reply is a DIFFERENT message.
  const otherChunk = openStore(dbPath).claimCommsSend({
    ...producerShape,
    messageId: 'telegram-in-7-mira-reply-part2',
    metadata: { ...producerShape.metadata, chunkIndex: 2 },
  });
  expect(otherChunk).toMatchObject({ acquired: true, sendAllowed: true });
});

test('A CLAIM RECOGNISES ITS OWN REPLAY despite whitespace and case', () => {
  // Canonicalisation must match what the ledger persists, or a claim mismatches
  // itself and a legitimate retry is blocked forever.
  const dbPath = tempDbPath();
  openStore(dbPath).claimCommsSend(ENTRY);
  const replay = openStore(dbPath).claimCommsSend({
    ...ENTRY,
    channel: ' Telegram ',
    direction: ' Outbound ',
    windowKey: ' main ',
  });
  expect(replay).toMatchObject({ acquired: false, sendAllowed: false, outcome: 'already_claimed' });
});

const CHUNKED = {
  ...ENTRY,
  messageId: 'telegram-in-8-mira-reply-part1',
  rawBody: 'part one of three',
  metadata: {
    inboundMessageId: 'telegram-in-8',
    chatId: 1111111111,
    windowKey: 'main',
    profile: 'main',
    routeKey: 'main',
    chunkIndex: 1,
    chunkCount: 3,
  },
};

test.each([
  ['chunkIndex', { chunkIndex: 2 }, 'chunkIndex'],
  ['chunkCount', { chunkCount: 4 }, 'chunkCount'],
])('SAME MESSAGE, DIFFERENT %s replays as a mismatch, not a claim', (_l, override, field) => {
  // A row claimed as part 1 of 3 does not authorize sending part 2, nor part 1
  // of a differently-sized reply. Same id, different position, different
  // message.
  const dbPath = tempDbPath();
  openStore(dbPath).claimCommsSend(CHUNKED);

  const replay = openStore(dbPath).claimCommsSend({
    ...CHUNKED,
    metadata: { ...CHUNKED.metadata, ...override },
  });

  expect(replay).toMatchObject({
    acquired: false, sendAllowed: false, outcome: 'identity_mismatch', field,
  });
});

test('CANONICAL STORAGE: numeric and string chunk values are the SAME identity', () => {
  // Proves the stored form is canonical rather than whatever type the caller
  // happened to pass. If it were not, a producer sending '1' after a restart
  // that previously sent 1 would be told it is a different message and would
  // send a duplicate.
  const dbPath = tempDbPath();
  const first = openStore(dbPath).claimCommsSend(CHUNKED);
  expect(first).toMatchObject({ acquired: true, sendAllowed: true });

  const replayAsStrings = openStore(dbPath).claimCommsSend({
    ...CHUNKED,
    metadata: { ...CHUNKED.metadata, chunkIndex: '1', chunkCount: '3' },
  });
  expect(replayAsStrings).toMatchObject({ acquired: false, outcome: 'already_claimed' });
});

test.each([
  ['routeKey', 'routeKey'],
  ['chatId', 'chatId'],
  ['windowKey', 'windowKey'],
])('A LEGACY ROW MISSING %s fails closed, not matches', (_l, field) => {
  // THE UPGRADE PATH. Rows written before strict identity landed carry
  // metadata without these fields. I previously dismissed this as equivalent
  // noise; it is not — it is exactly the state every existing install will be
  // in on first boot after this change. Treating the absent field as a
  // wildcard would let an old row authorize a send it never described.
  const dbPath = tempDbPath();
  const legacyMetadata = {
    inboundMessageId: 'telegram-in-1',
    chatId: 1111111111,
    windowKey: 'main',
    profile: 'main',
    routeKey: 'main',
  };
  delete legacyMetadata[field];

  const seeder = openStore(dbPath);
  seeder.upsertCommsJournal({
    messageId: ENTRY.messageId,
    channel: 'telegram',
    direction: 'outbound',
    senderRole: 'mira',
    targetRole: 'operator',
    rawBody: ENTRY.rawBody,
    status: 'recorded',
    metadata: legacyMetadata,
  });

  const claim = openStore(dbPath).claimCommsSend(ENTRY);

  expect(claim).toMatchObject({
    acquired: false, sendAllowed: false, outcome: 'identity_mismatch', field,
  });
});
