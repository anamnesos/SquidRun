/**
 * pollNow fail-closed cursor commit — the guards the existing suite is blind to.
 *
 * WHY THIS FILE EXISTS. After implementing deliver -> checked-persist -> advance,
 * the existing telegram-poller suite passed 36/36 — and it ALSO passed 36/36
 * with BOTH safety guards disabled. Green there proves the change breaks
 * nothing; it proves nothing about the change working. These tests are written
 * to FAIL when either guard is removed, and that mutation result is recorded in
 * the lane artifact.
 *
 * THE CONTRACT UNDER TEST:
 *   deliver the update, THEN durably record it, THEN advance the local cursor.
 *   If delivery throws, or the durable write returns false, hold the cursor
 *   where it is and stop the batch — N+1 must never leapfrog an unrecorded N.
 *   Replaying a message is visible and recoverable; losing one is neither.
 *
 * Every test uses an EXPLICIT temp statePath: under NODE_ENV=test
 * resolveDefaultStatePath returns null, so persistNextOffset would return false
 * by its own argument guard and the gate would correctly refuse to advance.
 * The fix for that is a real store in the test, never a weakened production
 * gate (Oracle #44).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('https');

jest.mock('https');

const telegramPoller = require('../modules/telegram-poller');

const ENV = {
  TELEGRAM_BOT_TOKEN: '123456789:fake_telegram_bot_token_do_not_use',
  TELEGRAM_CHAT_ID: '123456',
};

function tempStatePath() {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cursor-hold-')),
    'telegram-poller-state.json'
  );
}

/** Mirrors the existing suite's https mock shape. */
function mockUpdates(updates) {
  https.request.mockImplementation((_options, callback) => {
    const res = {
      statusCode: 200,
      setEncoding() {},
      on(event, handler) {
        if (event === 'data') handler(JSON.stringify({ ok: true, result: updates }));
        if (event === 'end') handler();
        return this;
      },
    };
    callback(res);
    return { on() { return this; }, setTimeout() { return this; }, end() {}, destroy() {} };
  });
}

function msg(updateId, text) {
  return {
    update_id: updateId,
    message: { chat: { id: 123456 }, from: { username: 'james' }, text },
  };
}

function durableOffset(statePath) {
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const cursors = state.cursors || {};
    const key = Object.keys(cursors)[0];
    return key ? cursors[key].nextOffset : null;
  } catch {
    return null;
  }
}

afterEach(() => {
  telegramPoller.stop();
  jest.clearAllMocks();
});

test('CALLBACK REJECT AT N: cursor holds at N, N+1 never delivered, then N replays before N+1', async () => {
  const statePath = tempStatePath();
  const seen = [];
  const onMessage = jest.fn(async (text) => {
    seen.push(text);
    if (text === 'first') throw new Error('consumer refused N');
  });

  telegramPoller.start({ statePath, env: ENV, onMessage });
  mockUpdates([msg(10, 'first'), msg(11, 'second')]);
  await telegramPoller._internals.pollNow();

  // N failed, so N+1 must not have been attempted at all.
  expect(seen).toEqual(['first']);
  expect(onMessage).toHaveBeenCalledTimes(1);
  // Durable cursor must not have moved past the update that was not accepted.
  expect(durableOffset(statePath)).not.toBe(12);

  // Consumer recovers; the next poll must replay N BEFORE N+1.
  seen.length = 0;
  onMessage.mockImplementation(async (text) => { seen.push(text); });
  await telegramPoller._internals.pollNow();
  expect(seen).toEqual(['first', 'second']);
});

test('DURABLE WRITE FALSE AFTER ACCEPTANCE: cursor holds, no leapfrog, replays after recovery', async () => {
  const statePath = tempStatePath();
  const seen = [];
  const onMessage = jest.fn(async (text) => { seen.push(text); });

  telegramPoller.start({ statePath, env: ENV, onMessage });
  mockUpdates([msg(20, 'alpha'), msg(21, 'beta')]);

  // The message IS accepted; the durable record fails. writePollerState catches
  // its own errors and returns false, so this failure is a return value nobody
  // used to read — exactly the shape that hid the original loss.
  // Fail ONLY the cursor write that follows acceptance. A blanket throw on the
  // state path also killed the dispatch lease, which aborted the poll before
  // any delivery — that tested the wrong thing entirely.
  const realWrite = fs.writeFileSync;
  fs.writeFileSync = (file, ...rest) => {
    if (seen.length > 0 && String(file).includes('telegram-poller-state')) {
      throw Object.assign(new Error('EIO: simulated'), { code: 'EIO' });
    }
    return realWrite(file, ...rest);
  };
  try {
    await telegramPoller._internals.pollNow();
  } finally {
    fs.writeFileSync = realWrite;
  }

  // Delivered, but unrecorded -> must not have stepped on to beta.
  expect(seen).toEqual(['alpha']);

  // Storage recovers: alpha replays (a visible duplicate) rather than being
  // silently skipped, and beta follows in order.
  seen.length = 0;
  await telegramPoller._internals.pollNow();
  expect(seen).toEqual(['alpha', 'beta']);
});

test('SUCCESS PATH: N then N+1 delivered in order and the cursor advances past both', async () => {
  const statePath = tempStatePath();
  const seen = [];
  const onMessage = jest.fn(async (text) => { seen.push(text); });

  telegramPoller.start({ statePath, env: ENV, onMessage });
  mockUpdates([msg(30, 'one'), msg(31, 'two')]);
  await telegramPoller._internals.pollNow();

  expect(seen).toEqual(['one', 'two']);
  expect(durableOffset(statePath)).toBe(32);

  // And a second poll of the same batch delivers nothing new.
  await telegramPoller._internals.pollNow();
  expect(onMessage).toHaveBeenCalledTimes(2);
});
