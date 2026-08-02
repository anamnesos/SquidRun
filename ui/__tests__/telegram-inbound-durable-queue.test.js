/**
 * App-down inbound durability: two updates in ONE poll must both survive.
 *
 * ORACLE #7's DEFECT, verified in source before writing a line of fix:
 * hm-telegram-poller-lane.js forwards each inbound message with
 * `fs.writeFileSync(triggerPath, message)` — WRITE, not append — to a FIXED
 * path (`.squidrun/triggers-<windowKey>/architect.txt`), and the poller calls
 * that callback ONCE PER UPDATE inside `for (const update of sortedUpdates)`.
 * So a single getUpdates batch carrying two messages writes the first, then
 * OVERWRITES it with the second, while the cursor advances past BOTH as
 * delivered. Silent loss: the cursor says delivered, the file disagrees, and
 * nothing errors.
 *
 * That is exactly the incident shape — updates 808499314 and 808499315 arrived
 * and drained together. Building app-down continuity on that path unchanged
 * would have turned a DELAY bug into a LOSS bug, which is strictly worse
 * because it looks like success.
 *
 * The first describe REPRODUCES the loss against the real overwrite semantics,
 * so the fix is measured against a demonstrated failure rather than a
 * hypothesis. The second proves the durable queue keyed by updateId.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const queue = require('../modules/telegram-inbound-durable-queue');

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-inbound-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the defect being fixed (reproduced, not assumed)', () => {
  test('fixed-path writeFileSync LOSES the first of two messages in one poll', () => {
    const trigger = path.join(dir, 'architect.txt');
    // Exactly what forwardToProfileTrigger does, once per update.
    fs.writeFileSync(trigger, 'first message', 'utf8');
    fs.writeFileSync(trigger, 'second message', 'utf8');
    const survived = fs.readFileSync(trigger, 'utf8');
    expect(survived).toBe('second message');
    // The first message is unrecoverable — this is the loss.
    expect(survived).not.toContain('first');
  });
});

describe('durable append queue keyed by updateId', () => {
  test('BOTH messages survive one poll batch, in updateId order', () => {
    queue.append(dir, { updateId: 808499314, text: 'first message', chatId: REDACTED });
    queue.append(dir, { updateId: 808499315, text: 'second message', chatId: REDACTED });
    const pending = queue.readPending(dir);
    expect(pending.map((e) => e.updateId)).toEqual([808499314, 808499315]);
    expect(pending.map((e) => e.text)).toEqual(['first message', 'second message']);
  });

  test('order is by updateId even when appended out of order', () => {
    queue.append(dir, { updateId: 2, text: 'b' });
    queue.append(dir, { updateId: 1, text: 'a' });
    expect(queue.readPending(dir).map((e) => e.updateId)).toEqual([1, 2]);
  });

  test('IDEMPOTENT: the same updateId never duplicates', () => {
    queue.append(dir, { updateId: 42, text: 'once' });
    queue.append(dir, { updateId: 42, text: 'once' });
    queue.append(dir, { updateId: 42, text: 'different body, same id' });
    const pending = queue.readPending(dir);
    expect(pending).toHaveLength(1);
    expect(pending[0].updateId).toBe(42);
  });

  test('ACK removes only what was acked — unacked entries remain', () => {
    queue.append(dir, { updateId: 1, text: 'a' });
    queue.append(dir, { updateId: 2, text: 'b' });
    queue.ack(dir, [1]);
    expect(queue.readPending(dir).map((e) => e.updateId)).toEqual([2]);
  });

  test('CRASH BEFORE ACK REPLAYS, NEVER DROPS', () => {
    queue.append(dir, { updateId: 7, text: 'survive me' });
    // Consumer read it, then died before acking.
    expect(queue.readPending(dir)).toHaveLength(1);
    // A fresh consumer must still see it.
    expect(queue.readPending(dir).map((e) => e.text)).toEqual(['survive me']);
    queue.ack(dir, [7]);
    expect(queue.readPending(dir)).toHaveLength(0);
  });

  test('acking an unknown id must NOT tombstone that id when it later arrives', () => {
    // My original test only checked that an unrelated entry survived, so it
    // passed while the real defect stood: the ack log is consulted at READ
    // time, so a pre-emptive ack for an id that had not arrived yet silently
    // deleted that message when it did arrive.
    queue.ack(dir, [999]);
    queue.append(dir, { updateId: 999, text: 'future message' });
    const pending = queue.readPending(dir);
    expect(pending.map((e) => e.updateId)).toEqual([999]);
    expect(pending[0].text).toBe('future message');
  });

  test('an unknown ack is reported as ignored, not silently swallowed', () => {
    const res = queue.ack(dir, [4242]);
    expect(res.acked).toBe(0);
    expect(res.ignored).toBe(1);
  });

  test('a truncated/corrupt trailing line does not destroy earlier entries', () => {
    queue.append(dir, { updateId: 1, text: 'a' });
    queue.append(dir, { updateId: 2, text: 'b' });
    fs.appendFileSync(queue.journalPath(dir), '{"updateId":3,"text":"trunc', 'utf8');
    expect(queue.readPending(dir).map((e) => e.updateId)).toEqual([1, 2]);
  });

  test('THE TORN-TAIL TRAP: appending AFTER a torn line must not lose the new message', () => {
    // The dangerous case my first test missed. A crash leaves a fragment with
    // no trailing newline; the next append concatenates onto it, the combined
    // line will not parse, and the NEW message vanishes — while append()
    // returns ok and the caller advances the Telegram cursor. Silent loss of a
    // message that was never itself damaged.
    queue.append(dir, { updateId: 1, text: 'a' });
    fs.appendFileSync(queue.journalPath(dir), '{"updateId":3,"text":"trunc', 'utf8');
    queue.append(dir, { updateId: 4, text: 'IMPORTANT' });
    const pending = queue.readPending(dir);
    expect(pending.map((e) => e.updateId)).toEqual([1, 4]);
    expect(pending.find((e) => e.updateId === 4).text).toBe('IMPORTANT');
  });

  test('a re-appended id survives after a torn tail (recovery, not just tolerance)', () => {
    fs.appendFileSync(queue.journalPath(dir), '{"updateId":9,"text":"half', 'utf8');
    queue.append(dir, { updateId: 9, text: 'complete retry' });
    const pending = queue.readPending(dir);
    expect(pending.map((e) => e.updateId)).toEqual([9]);
    expect(pending[0].text).toBe('complete retry');
  });

  test('CHAT ISOLATION: entries carry their chatId and can be filtered', () => {
    queue.append(dir, { updateId: 1, text: 'main', chatId: REDACTED });
    queue.append(dir, { updateId: 2, text: 'other', chatId: REDACTED-CHAT-ID });
    const mainOnly = queue.readPending(dir, { chatId: REDACTED });
    expect(mainOnly.map((e) => e.updateId)).toEqual([1]);
  });

  test('queue is per-directory, so profiles cannot bleed into each other', () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-inbound-other-'));
    try {
      queue.append(dir, { updateId: 1, text: 'main profile' });
      expect(queue.readPending(other)).toHaveLength(0);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  test('reading an absent journal yields empty, not a throw', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-inbound-empty-'));
    try {
      expect(queue.readPending(empty)).toEqual([]);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});
