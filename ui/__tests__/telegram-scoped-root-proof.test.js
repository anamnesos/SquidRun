/**
 * Scoped-root fail-closed proof (Architect #73/#79/#138).
 *
 * Every leak this closes has the same shape: a scoped message whose profile
 * root could not be resolved silently fell back to MAIN's tree — the trigger
 * path, the WebSocket envelope, and the replay receipt lookup all did it. A
 * fallback that changes WHOSE tree is addressed is not a fallback, it is a
 * cross-profile leak that looks like successful delivery.
 *
 * Absence and unreadability are also not the same thing. A receipt store that
 * cannot be READ used to answer "no receipt", which reads as "never delivered"
 * and sends the message again.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const receipts = require('../modules/model-prompt-receipt');

const roots = [];
function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scoped-proof-'));
  roots.push(root);
  return root;
}
function writeState(dir, contents) {
  const file = path.join(dir, 'receipts-state.json');
  fs.writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents), 'utf8');
  return file;
}
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

const RECEIPT = {
  receiptsByDeliveryId: {
    'telegram-in-1': { messageId: 'telegram-in-1', semanticEvent: 'prompt_submit', status: 'prompt_submitted.in_band' },
  },
  deliveryIdByMessageId: { 'telegram-in-1': 'telegram-in-1' },
};

// ------------------------------------------------------------- exact path only

test('A SCOPED receipt is found only under the target root', () => {
  const scoped = tempRoot();
  const statePath = writeState(scoped, RECEIPT);

  const found = receipts.getModelPromptReceipt('telegram-in-1', { statePath, strict: true });
  expect(found).toMatchObject({ messageId: 'telegram-in-1' });
});

test('THE SAME id living only under MAIN is NOT found for a scoped path', () => {
  // The leak in miniature: main has the receipt, the scoped profile does not.
  // Answering from main would retire a message that never reached her window.
  const main = tempRoot();
  writeState(main, RECEIPT);
  const scoped = tempRoot();

  const found = receipts.getModelPromptReceipt('telegram-in-1', {
    statePath: path.join(scoped, 'receipts-state.json'),
    strict: true,
  });
  expect(found).toBeNull();
});

test('STRICT mode refuses to guess a path', () => {
  expect(() => receipts.getModelPromptReceipt('telegram-in-1', { strict: true }))
    .toThrow(/explicit statePath/);
});

// --------------------------------------------------- absence vs unreadability

test('ENOENT is genuine ABSENCE and returns null', () => {
  const dir = tempRoot();
  const found = receipts.getModelPromptReceipt('telegram-in-1', {
    statePath: path.join(dir, 'receipts-state.json'),
    strict: true,
  });
  expect(found).toBeNull();
});

test('AN UNREADABLE store THROWS rather than reading as absence', () => {
  // A directory where the file belongs: EISDIR, not ENOENT. Under the old
  // permissive reader this collapsed to DEFAULT_STATE and meant "never
  // delivered", which is how a duplicate gets sent.
  const dir = tempRoot();
  fs.mkdirSync(path.join(dir, 'receipts-state.json'), { recursive: true });
  expect(() => receipts.getModelPromptReceipt('telegram-in-1', {
    statePath: path.join(dir, 'receipts-state.json'),
    strict: true,
  })).toThrow(/unreadable/);
});

test.each([
  ['corrupt JSON', 'not json at all'],
  ['a non-object root', '[]'],
  ['an invalid receiptsByDeliveryId', '{"receiptsByDeliveryId":[],"deliveryIdByMessageId":{}}'],
  ['an invalid deliveryIdByMessageId', '{"receiptsByDeliveryId":{},"deliveryIdByMessageId":7}'],
])('A STORE with %s THROWS', (_l, contents) => {
  const dir = tempRoot();
  const statePath = writeState(dir, contents);
  expect(() => receipts.getModelPromptReceipt('telegram-in-1', { statePath, strict: true })).toThrow();
});

test('AN INDEX POINTING AT A MISSING RECEIPT throws: the file disagrees with itself', () => {
  const dir = tempRoot();
  const statePath = writeState(dir, {
    receiptsByDeliveryId: {},
    deliveryIdByMessageId: { 'telegram-in-1': 'delivery-that-is-not-there' },
  });
  expect(() => receipts.getModelPromptReceipt('telegram-in-1', { statePath, strict: true }))
    .toThrow(/missing receipt/);
});

test('A RECEIPT THAT NAMES A DIFFERENT MESSAGE throws', () => {
  const dir = tempRoot();
  const statePath = writeState(dir, {
    receiptsByDeliveryId: { d1: { messageId: 'telegram-in-999', status: 'prompt_submitted.in_band' } },
    deliveryIdByMessageId: { 'telegram-in-1': 'd1' },
  });
  expect(() => receipts.getModelPromptReceipt('telegram-in-1', { statePath, strict: true }))
    .toThrow(/does not identify/);
});

// ------------------------------------------------------- legacy callers intact

test('NON-STRICT reads keep their permissive behaviour', () => {
  // Only the replay-proof path opted into strictness. This must target the
  // TEMP path — calling the bare getter would read the default store and prove
  // nothing about the file we just corrupted.
  const dir = tempRoot();
  const statePath = writeState(dir, 'not json at all');
  expect(() => receipts.readState(statePath)).not.toThrow();
  expect(receipts.readState(statePath)).toMatchObject({ receiptsByDeliveryId: {} });
});

test('A STRICT RECEIPT THAT NAMES NO MESSAGE throws', () => {
  const dir = tempRoot();
  const statePath = writeState(dir, {
    receiptsByDeliveryId: { 'telegram-in-1': { status: 'prompt_submitted.in_band' } },
    deliveryIdByMessageId: {},
  });
  expect(() => receipts.getModelPromptReceipt('telegram-in-1', { statePath, strict: true }))
    .toThrow(/does not identify any message/);
});

test.each([
  ['EACCES', 'EACCES'],
  ['EIO', 'EIO'],
])('AN INJECTED %s read error THROWS rather than reading as absence', (_l, code) => {
  // EISDIR alone was not the named distinction: a permission or I/O failure is
  // the realistic case, and under the old permissive reader every one of them
  // became DEFAULT_STATE, i.e. "never delivered".
  const dir = tempRoot();
  const statePath = writeState(dir, RECEIPT);
  const realRead = fs.readFileSync;
  fs.readFileSync = (file, ...rest) => {
    if (String(file) === statePath) throw Object.assign(new Error(code), { code });
    return realRead(file, ...rest);
  };
  try {
    expect(() => receipts.getModelPromptReceipt('telegram-in-1', { statePath, strict: true }))
      .toThrow(/unreadable/);
  } finally {
    fs.readFileSync = realRead;
  }
});

test('A DIRECT-KEY HIT whose receipt names another message THROWS', () => {
  // The id is a direct key in receiptsByDeliveryId, so deliveryId === the id we
  // asked for. The old condition short-circuited on that and accepted a receipt
  // whose messageId names a DIFFERENT message as proof for this one.
  const dir = tempRoot();
  const statePath = writeState(dir, {
    receiptsByDeliveryId: {
      'telegram-in-1': { messageId: 'telegram-in-999', status: 'prompt_submitted.in_band' },
    },
    deliveryIdByMessageId: {},
  });
  expect(() => receipts.getModelPromptReceipt('telegram-in-1', { statePath, strict: true }))
    .toThrow(/does not identify/);
});

describe('strict comms-journal query', () => {
  const journal = require('../modules/main/comms-journal');

  test('AN UNAVAILABLE STORE throws in strict mode instead of answering []', () => {
    // [] means "no rows", which a proof lookup reads as "never delivered" and
    // resends. A store that could not be opened has told us nothing.
    expect(() => journal.queryCommsJournalEntries(
      { messageId: 'telegram-in-1' },
      // A DIRECTORY where the database belongs: opening fails. A merely
      // missing path is not unavailable — SQLite would create it.
      { dbPath: tempRoot(), strict: true }
    )).toThrow();
  });

  test('NON-STRICT callers still receive [] and are unaffected', () => {
    const rows = journal.queryCommsJournalEntries(
      { messageId: 'telegram-in-1' },
      { dbPath: tempRoot() }
    );
    expect(Array.isArray(rows)).toBe(true);
  });
});
