/**
 * The delivery-attempt sidecar, tested as a queue primitive (Architect #85).
 *
 * It lives in the queue module but deliberately does NOT share the inbound
 * journal's parser. `readJsonl` there is permissive — it skips malformed lines
 * so one bad record cannot strand a whole queue, which is right for pending
 * messages. It is wrong here: this sidecar is the ambiguity latch deciding
 * whether something may be put in front of the user again, so every read fails
 * closed rather than quietly returning less than the truth.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const queue = require('../modules/telegram-inbound-durable-queue');

const roots = [];
function tempDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attempt-sidecar-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

// --------------------------------------------------------------------- reads

test('A MISSING sidecar reads as empty, not as an error', () => {
  // Nothing has been attempted yet. That is a normal first-boot state.
  expect(queue.readAttemptState(tempDir()).size).toBe(0);
});

test('A WELL-FORMED sidecar reads back the latest state per updateId', () => {
  const dir = tempDir();
  queue.appendAttempt(dir, 10, 'attempted');
  queue.appendAttempt(dir, 11, 'attempted');
  queue.appendAttempt(dir, 10, 'retryable');

  const state = queue.readAttemptState(dir);
  expect(state.get(10)).toBe('retryable');
  expect(state.get(11)).toBe('attempted');
});

test.each([
  ['a corrupt complete line', 'garbage-but-newline-terminated\n'],
  ['a torn tail', '{"updateId":1,"state":"attempted"}\n{"updat'],
  ['an unknown state', '{"updateId":1,"state":"probably-fine"}\n'],
  ['a missing state', '{"updateId":1}\n'],
  ['a zero updateId', '{"updateId":0,"state":"attempted"}\n'],
  ['a fractional updateId', '{"updateId":1.5,"state":"attempted"}\n'],
  ['a string updateId', '{"updateId":"one","state":"attempted"}\n'],
  ['a NUMERIC STRING updateId', '{"updateId":"1","state":"attempted"}\n'],
  ['a boolean updateId', '{"updateId":true,"state":"attempted"}\n'],
  ['an unsafe integer updateId', '{"updateId":9007199254740993,"state":"attempted"}\n'],
])('READS FAIL CLOSED on %s', (_l, contents) => {
  const dir = tempDir();
  fs.writeFileSync(queue.attemptsPath(dir), contents, 'utf8');
  expect(() => queue.readAttemptState(dir)).toThrow();
});

test('READS FAIL CLOSED when the file cannot be read at all', () => {
  const dir = tempDir();
  // A directory where the file should be: readFileSync fails with EISDIR, which
  // is not ENOENT and must not be mistaken for "nothing attempted yet".
  fs.mkdirSync(queue.attemptsPath(dir), { recursive: true });
  expect(() => queue.readAttemptState(dir)).toThrow(/unreadable/);
});

// -------------------------------------------------------------------- writes

test.each([
  ['a zero updateId', 0, 'attempted'],
  ['a negative updateId', -1, 'attempted'],
  ['a fractional updateId', 2.5, 'attempted'],
  ['a non-numeric updateId', 'two', 'attempted'],
  ['a NUMERIC STRING updateId', '1', 'attempted'],
  ['a boolean updateId', true, 'attempted'],
  ['an unsafe integer updateId', Number.MAX_SAFE_INTEGER + 2, 'attempted'],
  ['an unknown state', 1, 'probably-fine'],
  ['a missing state', 1, undefined],
])('APPEND REJECTS %s BEFORE touching disk', (_l, updateId, state) => {
  const dir = tempDir();
  expect(() => queue.appendAttempt(dir, updateId, state)).toThrow();
  // A rejected write must leave no trace at all — not an empty file, not a
  // partial line. Otherwise the next read fails closed on our own garbage.
  expect(fs.existsSync(queue.attemptsPath(dir))).toBe(false);
});

test('APPEND REFUSES a torn tail rather than repairing it', () => {
  // Architect #129: appendAttempt writes JSON + newline as ONE record, so a
  // nonempty file not ending in a newline means a previous append died
  // mid-write. Sealing it and appending behind would bless whatever that
  // half-written record was about, and hide that it happened at all.
  const dir = tempDir();
  const torn = '{"updateId":1,"state":"attempted"}\n{"updat';
  fs.writeFileSync(queue.attemptsPath(dir), torn, 'utf8');

  expect(() => queue.appendAttempt(dir, 2, 'attempted')).toThrow(/torn/);
  // And it must not have modified the file on the way out.
  expect(fs.readFileSync(queue.attemptsPath(dir), 'utf8')).toBe(torn);
});

test('A COMPLETE-BUT-UNTERMINATED tail is still torn', () => {
  // The JSON parses. It is still a torn write, because the newline is part of
  // the record and it is missing.
  const dir = tempDir();
  fs.writeFileSync(queue.attemptsPath(dir), '{"updateId":1,"state":"attempted"}', 'utf8');
  expect(() => queue.readAttemptState(dir)).toThrow(/torn/);
  expect(() => queue.appendAttempt(dir, 2, 'attempted')).toThrow(/torn/);
});

test('APPEND newline-terminates so the next write is never concatenated', () => {
  const dir = tempDir();
  queue.appendAttempt(dir, 3, 'attempted');
  expect(fs.readFileSync(queue.attemptsPath(dir), 'utf8').endsWith('\n')).toBe(true);
});

test('APPEND PROPAGATES a storage failure rather than reporting success', () => {
  const dir = tempDir();
  const realAppend = fs.appendFileSync;
  fs.appendFileSync = () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); };
  try {
    expect(() => queue.appendAttempt(dir, 4, 'attempted')).toThrow();
  } finally {
    fs.appendFileSync = realAppend;
  }
});

// -------------------------------------------------------- separation of concerns

test('THE INBOUND JOURNAL STAYS PERMISSIVE while the sidecar does not', () => {
  // These two must not converge. A malformed inbound record should not strand
  // the queue; a malformed ATTEMPT record must stop everything.
  const dir = tempDir();
  queue.append(dir, { updateId: 1, text: 'fine' });
  fs.appendFileSync(queue.journalPath(dir), 'not json at all\n', 'utf8');
  queue.append(dir, { updateId: 2, text: 'also fine' });

  expect(queue.readPending(dir).map((r) => r.updateId)).toEqual([1, 2]);

  fs.writeFileSync(queue.attemptsPath(dir), 'not json at all\n', 'utf8');
  expect(() => queue.readAttemptState(dir)).toThrow();
});

// ------------------------------------------------- S491: attempt provenance

test('PROVENANCE ROUND-TRIPS: atMs and generation survive a write and read', () => {
  const dir = tempDir();
  queue.appendAttempt(dir, 42, 'attempted', { atMs: 1_785_780_000_000, generation: 'gen-a' });

  expect(queue.readAttemptRecords(dir).get(42)).toEqual({
    state: 'attempted',
    atMs: 1_785_780_000_000,
    generation: 'gen-a',
  });
});

test('A v0 ENTRY still reads, with provenance reported as UNKNOWN rather than guessed', () => {
  // The live latch on disk predates these fields and must stay readable.
  const dir = tempDir();
  fs.writeFileSync(
    queue.attemptsPath(dir),
    `${JSON.stringify({ updateId: 808499316, state: 'attempted' })}\n`,
    'utf8'
  );

  expect(queue.readAttemptRecords(dir).get(808499316)).toEqual({
    state: 'attempted',
    atMs: null,
    generation: null,
  });
});

test('PROVENANCE KEYS ARE OMITTED when unknown, so a v0 reader keeps working', () => {
  const dir = tempDir();
  queue.appendAttempt(dir, 7, 'attempted');

  const line = fs.readFileSync(queue.attemptsPath(dir), 'utf8').trim();
  expect(JSON.parse(line)).toEqual({ updateId: 7, state: 'attempted' });
});

test.each([
  ['a string', 'yesterday'],
  ['a boolean', true],
  ['an object', {}],
  ['zero', 0],
  ['negative', -1],
  ['fractional', 1.5],
])('A MALFORMED atMs (%s) THROWS — it is never downgraded to "absent"', (_label, value) => {
  // Downgrading corruption to absence would make a corrupt entry look exactly
  // like a legitimate v0 one, and the recovery tool treats v0 as the shape a
  // human may retire by hand. Corruption must be loud, not quietly plausible.
  const dir = tempDir();
  fs.writeFileSync(
    queue.attemptsPath(dir),
    `${JSON.stringify({ updateId: 9, state: 'attempted', atMs: value })}\n`,
    'utf8'
  );

  expect(() => queue.readAttemptRecords(dir)).toThrow(/atMs/);
  expect(() => queue.readAttemptState(dir)).toThrow(/atMs/);
});

test.each([
  ['an empty string', ''],
  ['whitespace', '   '],
  ['a number', 5],
])('A MALFORMED generation (%s) THROWS rather than reading as absent', (_label, value) => {
  const dir = tempDir();
  fs.writeFileSync(
    queue.attemptsPath(dir),
    `${JSON.stringify({ updateId: 9, state: 'attempted', generation: value })}\n`,
    'utf8'
  );

  expect(() => queue.readAttemptRecords(dir)).toThrow(/generation/);
});

test('A REJECTED PROVENANCE WRITE LEAVES NO TRACE', () => {
  const dir = tempDir();
  expect(() => queue.appendAttempt(dir, 11, 'attempted', { atMs: 'nope' })).toThrow(/atMs/);
  expect(fs.existsSync(queue.attemptsPath(dir))).toBe(false);
});
