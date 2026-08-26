/**
 * Worker<->parent durable-ingress ACK.
 *
 * The whole point of this seam: the poller AWAITS the worker callback, and
 * since 345c4311 a rejection holds the Telegram cursor. So a resolved ack is a
 * claim that the message survives without Telegram. Every test below exists to
 * prove that claim is only made after `queue.append` actually succeeded — and
 * that every other outcome leaves the worker rejected so the cursor holds.
 *
 * Duplicates are acceptable in this intermediate slice (append-then-ack-loss
 * replays the same updateId and dedupes). Loss is not.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const spool = require('../modules/main/telegram-ingress-spool');
const queue = require('../modules/telegram-inbound-durable-queue');
const { InboundPollerService } = require('../modules/main/inbound-poller-service');

const tempRoots = [];
function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-ingress-'));
  tempRoots.push(root);
  return root;
}

const silentLog = { info() {}, warn() {}, error() {} };

/** Minimal stand-in for a forked worker: records what the parent sends back. */
function fakeWorker() {
  return { sent: [], killed: false, send(msg) { this.sent.push(msg); } };
}

function serviceWith(onMessage, worker) {
  const svc = new InboundPollerService({ log: silentLog, useTelegramWorker: true });
  svc.telegramOnMessage = onMessage;
  svc.telegramWorker = worker;
  return svc;
}

/**
 * v7 §1: the spool fails closed without a producer identity, so every append in
 * this file has to say who wrote the record. Spread explicitly at each call site
 * rather than injected by a wrapper - a shim that silently stamped everything
 * would also hide the one test that proves the refusal.
 */
const PRODUCER = Object.freeze({
  producerAppGeneration: 'app-session-test',
  producerSessionId: 'sess-test',
});

const META = {
  updateId: 900,
  chatId: 123456,
  messageId: 77,
  updateKind: 'text',
  timestampMs: 1700000000000,
  media: { kind: 'photo', localPath: 'D:/x.png' },
};

afterEach(() => {
  while (tempRoots.length) fs.rmSync(tempRoots.pop(), { recursive: true, force: true });
});

// ---------------------------------------------------------------- spool base

test('SPOOL BASE: main and scoped routes never share a journal under one canonical base', () => {
  const base = tempRoot();
  const a = spool.resolveSpoolDir(base, 'main');
  const b = spool.resolveSpoolDir(base, 'client');
  expect(a.ok && b.ok).toBe(true);
  expect(a.dir).not.toBe(b.dir);
  expect(queue.journalPath(a.dir)).not.toBe(queue.journalPath(b.dir));
  // Both under the ONE owner base, in structurally separate dirs.
  expect(a.dir.startsWith(path.resolve(base))).toBe(true);
  expect(b.dir.startsWith(path.resolve(base))).toBe(true);
});

test('MISSING BASE OR UNSAFE ROUTE: writes nowhere and reports a reason', () => {
  expect(spool.resolveSpoolDir('', 'main')).toEqual({ ok: false, reason: 'missing_ingress_base' });
  expect(spool.resolveSpoolDir(null, 'main').ok).toBe(false);
  for (const bad of ['../escape', 'a/b', 'a\\b', '..', '', 'C:', 'x'.repeat(65)]) {
    expect(spool.resolveSpoolDir('D:/base', bad)).toEqual({ ok: false, reason: 'unsafe_route_key' });
  }

  // And acceptInbound must not create anything when the base is missing.
  const base = tempRoot();
  const before = fs.readdirSync(base).length;
  const res = spool.acceptInbound({ dataRoot: '', routeKey: 'main', text: 'hi', metadata: META });
  expect(res.ok).toBe(false);
  expect(fs.readdirSync(base).length).toBe(before);
});

test('FULL PAYLOAD ROUND-TRIP: everything a later drain needs survives the journal', () => {
  const base = tempRoot();
  const res = spool.acceptInbound({
    ...PRODUCER,
    dataRoot: base,
    routeKey: 'main',
    text: 'hello there',
    from: 'operator',
    metadata: META,
    targetProfile: 'main',
    targetWindow: 'main',
    targetSession: 'sess-1',
  });
  expect(res).toMatchObject({ ok: true, durable: true, updateId: 900, deduped: false });

  const [rec] = queue.readPending(res.dir);
  expect(rec).toMatchObject({
    updateId: 900,
    text: 'hello there',
    from: 'operator',
    chatId: 123456,
    messageId: 77,
    updateKind: 'text',
    timestampMs: 1700000000000,
    routeKey: 'main',
    targetProfile: 'main',
    targetWindow: 'main',
    targetSession: 'sess-1',
  });
  expect(rec.media).toEqual(META.media);
  // Pre-existing fields must still be present for older readers.
  expect(rec.profile).toBe('main');
  expect(Number.isFinite(rec.receivedAtMs)).toBe(true);
});

test('APPEND FAILURE IS NOT ACCEPTANCE: reported by return value, not a throw', () => {
  const base = tempRoot();
  const res = spool.acceptInbound(
    { dataRoot: base, routeKey: 'main', text: 'x', metadata: META, ...PRODUCER },
    { append: () => ({ ok: false, reason: 'disk_full' }) }
  );
  expect(res).toEqual({ ok: false, reason: 'disk_full' });

  const thrown = spool.acceptInbound(
    { dataRoot: base, routeKey: 'main', text: 'x', metadata: META, ...PRODUCER },
    { append: () => { throw new Error('EIO'); } }
  );
  expect(thrown.ok).toBe(false);
  expect(thrown.reason).toContain('append_threw');
});

test('ACK-LOSS REPLAY: the same updateId dedupes instead of double-spooling', () => {
  const base = tempRoot();
  const first = spool.acceptInbound({ dataRoot: base, routeKey: 'main', text: 'once', metadata: META, ...PRODUCER });
  // Parent appended, then the ack never arrived; Telegram replays the update.
  const replay = spool.acceptInbound({ dataRoot: base, routeKey: 'main', text: 'once', metadata: META, ...PRODUCER });
  expect(first).toMatchObject({ ok: true, durable: true, deduped: false });
  expect(replay).toMatchObject({ ok: true, durable: true, deduped: true });
  expect(queue.readPending(first.dir)).toHaveLength(1);
});

// --------------------------------------------------------------- parent side

test('PARENT ACKS ONLY ON EXPLICIT DURABLE ACCEPTANCE', async () => {
  const worker = fakeWorker();
  const svc = serviceWith(async () => ({ ok: true, durable: true, updateId: 900 }), worker);
  await svc.deliverTelegramInbound(worker, 'telegram-in-900', { text: 'hi', metadata: META });
  expect(worker.sent).toEqual([{ type: 'message-ack', ackKey: 'telegram-in-900', ok: true, durable: true }]);
});

test.each([
  ['callback throws', async () => { throw new Error('boom'); }],
  ['returns undefined', async () => undefined],
  ['returns false', async () => false],
  ['malformed result', async () => ({ ok: true })],
  ['ok but not durable', async () => ({ ok: true, durable: false })],
  ['no consumer', null],
])('PARENT NEVER POSITIVE-ACKS: %s', async (_label, cb) => {
  const worker = fakeWorker();
  const svc = serviceWith(cb, worker);
  await svc.deliverTelegramInbound(worker, 'telegram-in-900', { text: 'hi', metadata: META });
  const positives = worker.sent.filter((m) => m.ok === true);
  expect(positives).toEqual([]);
  // Exactly one negative ack: settle-once applies to the parent side too, or
  // the worker's correlation map has to reason about repeats it should never see.
  expect(worker.sent).toHaveLength(1);
});

test('PARENT IGNORES A STALE WORKER: no ack is sent to a replaced worker', async () => {
  const current = fakeWorker();
  const stale = fakeWorker();
  const svc = serviceWith(async () => ({ ok: true, durable: true, updateId: 900 }), current);
  await svc.deliverTelegramInbound(stale, 'telegram-in-900', { text: 'hi', metadata: META });
  expect(stale.sent).toEqual([]);
});

test('ACK SEND FAILURE IS NOT DELIVERY: reported false so the worker times out', async () => {
  const worker = fakeWorker();
  worker.send = () => { throw new Error('channel closed'); };
  const svc = serviceWith(async () => ({ ok: true, durable: true, updateId: 900 }), worker);
  await expect(
    svc.deliverTelegramInbound(worker, 'telegram-in-900', { text: 'hi', metadata: META })
  ).resolves.toBeUndefined();
  expect(svc.sendTelegramAck(worker, { ackKey: 'telegram-in-900', ok: true, durable: true })).toBe(false);
});

// --------------------------------------------------------------- worker side

describe('worker ack promise', () => {
  const { _ackInternals: ack } = require('../modules/main/telegram-poller-worker');

  afterEach(() => ack.pendingAcks.clear());

  test('POSITIVE ACK RESOLVES; NEGATIVE AND MALFORMED REJECT', async () => {
    const ok = ack.awaitParentAck(1, 5000);
    ack.handleParentAck({ ackKey: 'telegram-in-1', ok: true, durable: true });
    await expect(ok).resolves.toBeUndefined();

    const nacked = ack.awaitParentAck(2, 5000);
    ack.handleParentAck({ ackKey: 'telegram-in-2', ok: false, reason: 'disk_full' });
    await expect(nacked).rejects.toThrow(/disk_full/);

    // ok without durable is NOT acceptance.
    const malformed = ack.awaitParentAck(3, 5000);
    ack.handleParentAck({ ackKey: 'telegram-in-3', ok: true });
    await expect(malformed).rejects.toThrow(/nacked/);
  });

  test('TIMEOUT REJECTS so the cursor holds when the parent never answers', async () => {
    await expect(ack.awaitParentAck(4, 1)).rejects.toThrow(/ack timeout/);
  });

  test('DISCONNECT REJECTS EVERY PENDING ACK before exit, and settles once', async () => {
    const a = ack.awaitParentAck(5, 60000);
    const b = ack.awaitParentAck(6, 60000);
    ack.rejectAllPendingAcks('parent disconnected');

    await expect(a).rejects.toThrow(/parent disconnected/);
    await expect(b).rejects.toThrow(/parent disconnected/);
    expect(ack.pendingAcks.size).toBe(0);

    // A late positive ack for an already-rejected key must not resurrect it.
    expect(() => ack.handleParentAck({ ackKey: 'telegram-in-5', ok: true, durable: true })).not.toThrow();
  });

  test('DETERMINISTIC KEY: identity is telegram-in-<updateId>', () => {
    expect(ack.ackKeyFor(900)).toBe('telegram-in-900');
  });
});

test('TWO UPDATES SERIALIZE: N is spooled and acked before N+1', async () => {
  const base = tempRoot();
  const worker = fakeWorker();
  const order = [];
  const svc = serviceWith(async (text, from, meta) => {
    order.push(`append:${meta.updateId}`);
    const r = spool.acceptInbound({ dataRoot: base, routeKey: 'main', text, from, metadata: meta, ...PRODUCER });
    return r.ok ? { ok: true, durable: true, updateId: r.updateId } : { ok: false, reason: r.reason };
  }, worker);

  // The poller awaits each callback, so the parent sees them one at a time.
  await svc.deliverTelegramInbound(worker, 'telegram-in-901', { text: 'n', metadata: { ...META, updateId: 901 } });
  await svc.deliverTelegramInbound(worker, 'telegram-in-902', { text: 'n+1', metadata: { ...META, updateId: 902 } });

  expect(order).toEqual(['append:901', 'append:902']);
  expect(worker.sent.map((m) => m.ackKey)).toEqual(['telegram-in-901', 'telegram-in-902']);
  expect(worker.sent.every((m) => m.ok === true)).toBe(true);

  const dir = spool.resolveSpoolDir(base, 'main').dir;
  expect(queue.readPending(dir).map((r) => r.updateId)).toEqual([901, 902]);
});

test('NO IPC CHANNEL: an ack that cannot be sent is never counted as delivery', async () => {
  const worker = fakeWorker();
  delete worker.send;
  const svc = serviceWith(async () => ({ ok: true, durable: true }), worker);
  await svc.deliverTelegramInbound(worker, 'telegram-in-900', { text: 'hi', metadata: META });
  expect(svc.sendTelegramAck(worker, { ackKey: 'telegram-in-900', ok: true, durable: true })).toBe(false);
});

// ---------------------------------------------- Architect #51 bounded blockers

test('RELATIVE BASE WRITES NOWHERE: cwd must never stand in for the owner root', () => {
  expect(spool.resolveSpoolDir('relative/base', 'main'))
    .toEqual({ ok: false, reason: 'relative_ingress_base' });
  expect(spool.resolveSpoolDir('./x', 'main').ok).toBe(false);

  const res = spool.acceptInbound(
    { dataRoot: 'relative/base', routeKey: 'main', text: 'x', metadata: META },
    { append: () => { throw new Error('append must never be reached'); } }
  );
  expect(res).toEqual({ ok: false, reason: 'relative_ingress_base' });
});

test('RAW METADATA ROUND-TRIP: the complete object is persisted, not just picked fields', () => {
  const base = tempRoot();
  const meta = { ...META, someFutureField: { nested: true } };
  const res = spool.acceptInbound({ dataRoot: base, routeKey: 'main', text: 'x', from: 'j', metadata: meta, ...PRODUCER });
  const [rec] = queue.readPending(res.dir);
  expect(rec.rawMetadata).toEqual(meta);
  expect(rec.rawMetadata.someFutureField).toEqual({ nested: true });
});

test('TERMINAL DISPOSITION persists so a drain can tell a poison update from a pending one', () => {
  const base = tempRoot();
  const res = spool.acceptInbound({
    dataRoot: base, routeKey: 'main', text: '', from: 'j', metadata: META, ...PRODUCER,
    terminalDisposition: 'empty_body',
  });
  expect(res.ok).toBe(true);
  expect(queue.readPending(res.dir)[0].terminalDisposition).toBe('empty_body');
});

test.each([
  ['result id does not match payload id', { ok: true, durable: true, updateId: 901 }, 'telegram-in-900'],
  ['ackKey does not match result id', { ok: true, durable: true, updateId: 900 }, 'telegram-in-999'],
  ['result carries no updateId', { ok: true, durable: true }, 'telegram-in-900'],
])('ACK CORRELATION MISMATCH holds the cursor: %s', async (_label, result, ackKey) => {
  const worker = fakeWorker();
  const svc = serviceWith(async () => result, worker);
  await svc.deliverTelegramInbound(worker, ackKey, { text: 'hi', metadata: META });
  expect(worker.sent.filter((m) => m.ok === true)).toEqual([]);
  expect(worker.sent).toHaveLength(1);
  expect(worker.sent[0].reason).toBe('ack_correlation_mismatch');
});

test('MATCHING CORRELATION still acks exactly once', async () => {
  const worker = fakeWorker();
  const svc = serviceWith(async () => ({ ok: true, durable: true, updateId: 900 }), worker);
  await svc.deliverTelegramInbound(worker, 'telegram-in-900', { text: 'hi', metadata: META });
  expect(worker.sent).toEqual([{ type: 'message-ack', ackKey: 'telegram-in-900', ok: true, durable: true }]);
});
