/**
 * Ordered drain — the tests that decide whether a message can be lost.
 *
 * Every "stop" case here is a case where the easy implementation retires the
 * record and moves on. The point of the suite is that stopping is the correct,
 * boring outcome: a stuck queue is visible; a retired-but-undelivered message is
 * gone with no trace that it ever existed.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const queue = require('../modules/telegram-inbound-durable-queue');
const spool = require('../modules/main/telegram-ingress-spool');
const { createDrainCoordinator, isProvenOwnership } = require('../modules/main/telegram-ingress-drain');

const tempRoots = [];
function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-drain-'));
  tempRoots.push(root);
  return root;
}
afterEach(() => {
  while (tempRoots.length) fs.rmSync(tempRoots.pop(), { recursive: true, force: true });
});

const silentLog = { info() {}, warn() {} };
const CHAT = 4242;

function seed(base, routeKey, updateIds, extra = {}) {
  let dir = null;
  for (const updateId of updateIds) {
    const res = spool.acceptInbound({
      dataRoot: base,
      routeKey,
      text: `body ${updateId}`,
      from: 'james',
      metadata: { updateId, chatId: CHAT, messageId: updateId * 10, media: { kind: 'photo' }, extra: 'kept' },
      targetProfile: routeKey,
      targetWindow: routeKey === 'main' ? 'main' : routeKey,
      targetSession: 'session-at-append',
      ...extra,
    });
    expect(res.ok).toBe(true);
    dir = res.dir;
  }
  return dir;
}

function routerFor(routeKey, windowKey = routeKey) {
  return () => ({ ok: true, profile: routeKey, windowKey });
}

const PROVEN = { status: 'delivered.verified', verified: true };
const UNPROVEN = { status: 'accepted.daemon_pty_unverified', accepted: true };

function coordinator(overrides = {}) {
  return createDrainCoordinator({
    queue,
    log: silentLog,
    resolveRoute: routerFor('main', 'main'),
    deliver: async () => PROVEN,
    currentSessionFor: () => 'session-now',
    ...overrides,
  });
}

// ------------------------------------------------------------------ ordering

test('STARTUP DRAIN of an app-down backlog delivers N then N+1 and retires both', async () => {
  const base = tempRoot();
  const dir = seed(base, 'main', [10, 11]);
  const seen = [];
  const drain = coordinator({ deliver: async (job) => { seen.push(job.messageId); return PROVEN; } });

  const res = await drain.schedule(dir, 'main');

  expect(seen).toEqual(['telegram-in-10', 'telegram-in-11']);
  expect(res.delivered).toBe(2);
  expect(queue.readPending(dir)).toHaveLength(0);
});

test('DELIVERY FAILURE AT N blocks N+1 and leaves both pending', async () => {
  const base = tempRoot();
  const dir = seed(base, 'main', [20, 21]);
  const seen = [];
  const drain = coordinator({
    deliver: async (job) => {
      seen.push(job.messageId);
      if (job.updateId === 20) throw new Error('pane down');
      return PROVEN;
    },
  });

  const res = await drain.schedule(dir, 'main');

  expect(seen).toEqual(['telegram-in-20']);
  expect(res.stoppedAt).toMatchObject({ updateId: 20 });
  expect(queue.readPending(dir).map((r) => r.updateId)).toEqual([20, 21]);
});

test('ACK FAILURE AT N blocks N+1 even though N was delivered', async () => {
  const base = tempRoot();
  const dir = seed(base, 'main', [30, 31]);
  const seen = [];
  const drain = coordinator({
    queue: { readPending: queue.readPending, ack: () => ({ ok: false, reason: 'eio' }) },
    deliver: async (job) => { seen.push(job.messageId); return PROVEN; },
  });

  const res = await drain.schedule(dir, 'main');

  expect(seen).toEqual(['telegram-in-30']);
  expect(res.stoppedAt).toMatchObject({ updateId: 30, reason: 'ack_failed' });
});

test('CONCURRENT SCHEDULES single-flight: one drain, no double delivery', async () => {
  const base = tempRoot();
  const dir = seed(base, 'main', [40, 41]);
  const seen = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const drain = coordinator({
    deliver: async (job) => { seen.push(job.messageId); await gate; return PROVEN; },
  });

  const a = drain.schedule(dir, 'main');
  const b = drain.schedule(dir, 'main');
  const c = drain.schedule(dir, 'main');
  release();
  const [, rb, rc] = await Promise.all([a, b, c]);

  expect(rb.coalesced).toBe(true);
  expect(rc.coalesced).toBe(true);
  expect(seen).toEqual(['telegram-in-40', 'telegram-in-41']);
});

// -------------------------------------------------------------- acceptance

test('ACCEPTED-BUT-UNVERIFIED IS NOT PROOF: record stays pending and blocks the queue', async () => {
  const base = tempRoot();
  const dir = seed(base, 'main', [50, 51]);
  const drain = coordinator({ deliver: async () => UNPROVEN });

  const res = await drain.schedule(dir, 'main');

  expect(res.stoppedAt).toMatchObject({ updateId: 50 });
  expect(res.stoppedAt.reason).toContain('unproven_acceptance');
  expect(queue.readPending(dir).map((r) => r.updateId)).toEqual([50, 51]);
});

test('A LATER CORRELATED RECEIPT retires the record with no second injection', async () => {
  const base = tempRoot();
  const dir = seed(base, 'main', [60]);
  let receiptExists = false;
  const seen = [];
  const drain = coordinator({
    deliver: async (job) => { seen.push(job.messageId); return UNPROVEN; },
    hasExistingReceipt: async () => receiptExists,
  });

  await drain.schedule(dir, 'main');
  expect(queue.readPending(dir)).toHaveLength(1);

  // The receipt lands out of band; the next pass must retire WITHOUT delivering.
  receiptExists = true;
  await drain.schedule(dir, 'main');

  expect(seen).toEqual(['telegram-in-60']);
  expect(queue.readPending(dir)).toHaveLength(0);
});

test.each([
  ['verified', { verified: true }],
  ['userVisible', { userVisible: true }],
  ['durable handoff', { durableHandoff: true }],
  ['persisted receipt row', { persistedReceiptId: 'ledger-1' }],
])('PROOF SHAPES accepted: %s', (_l, receipt) => {
  expect(isProvenOwnership(receipt)).toBe(true);
});

test.each([
  ['transport only', { status: 'accepted.unverified', accepted: true }],
  ['daemon pty unverified', { status: 'accepted.daemon_pty_unverified' }],
  ['queued', { queued: true }],
  ['empty', {}],
  ['null', null],
  ['blank receipt id', { persistedReceiptId: '   ' }],
])('PROOF SHAPES rejected: %s', (_l, receipt) => {
  expect(isProvenOwnership(receipt)).toBe(false);
});

// ------------------------------------------------------------------- routing

test('ROUTE CHANGE holds the record and delivers nowhere', async () => {
  const base = tempRoot();
  const dir = seed(base, 'main', [70]);
  const seen = [];
  const drain = coordinator({
    // The chat now points at a different profile than when it was appended.
    resolveRoute: () => ({ ok: true, profile: 'sideprofile', windowKey: 'sideprofile' }),
    deliver: async (job) => { seen.push(job.messageId); return PROVEN; },
  });

  const res = await drain.schedule(dir, 'main');

  expect(seen).toEqual([]);
  expect(res.stoppedAt).toMatchObject({ updateId: 70, reason: 'route_changed' });
  expect(queue.readPending(dir)).toHaveLength(1);
});

test('UNRESOLVABLE ROUTE holds rather than guessing a destination', async () => {
  const base = tempRoot();
  const dir = seed(base, 'main', [80]);
  const drain = coordinator({ resolveRoute: () => ({ ok: false, reason: 'unknown_chat' }) });
  const res = await drain.schedule(dir, 'main');
  expect(res.stoppedAt.reason).toContain('route_unresolved');
  expect(queue.readPending(dir)).toHaveLength(1);
});

test('ROUTE ISOLATION: main and scoped journals drain independently', async () => {
  const base = tempRoot();
  const mainDir = seed(base, 'main', [90]);
  const scopedDir = seed(base, 'sideprofile', [91]);
  expect(mainDir).not.toBe(scopedDir);

  const seen = [];
  const mainDrain = coordinator({
    resolveRoute: routerFor('main', 'main'),
    deliver: async (job) => { seen.push(`main:${job.updateId}`); return PROVEN; },
  });
  const scopedDrain = coordinator({
    resolveRoute: routerFor('sideprofile', 'sideprofile'),
    deliver: async (job) => { seen.push(`scoped:${job.updateId}`); return PROVEN; },
  });

  await mainDrain.schedule(mainDir, 'main');
  await scopedDrain.schedule(scopedDir, 'sideprofile');

  expect(seen).toEqual(['main:90', 'scoped:91']);
  expect(queue.readPending(mainDir)).toHaveLength(0);
  expect(queue.readPending(scopedDir)).toHaveLength(0);
});

test('DISCOVERY only returns safe route dirs below the canonical spool root', () => {
  const base = tempRoot();
  seed(base, 'main', [100]);
  seed(base, 'sideprofile', [101]);
  const drain = coordinator();
  const found = drain.discoverRouteDirs(base, (root) => fs.readdirSync(root).concat(['..', 'bad/name']));
  expect(found.ok).toBe(true);
  expect(found.routes.map((r) => r.routeKey).sort()).toEqual(['sideprofile', 'main']);
});

// ------------------------------------------------------------------ terminal

test('TERMINAL TOMBSTONE retires after route validation without any pane delivery', async () => {
  const base = tempRoot();
  const dir = seed(base, 'main', [110], { terminalDisposition: 'empty_body' });
  const seen = [];
  const drain = coordinator({ deliver: async (job) => { seen.push(job.messageId); return PROVEN; } });

  const res = await drain.schedule(dir, 'main');

  expect(seen).toEqual([]);
  expect(res.delivered).toBe(1);
  expect(queue.readPending(dir)).toHaveLength(0);
});

test('TERMINAL TOMBSTONE still holds when the route cannot be validated', async () => {
  const base = tempRoot();
  const dir = seed(base, 'main', [111], { terminalDisposition: 'empty_body' });
  const drain = coordinator({ resolveRoute: () => ({ ok: false, reason: 'unknown_chat' }) });
  const res = await drain.schedule(dir, 'main');
  expect(res.stoppedAt).toBeTruthy();
  expect(queue.readPending(dir)).toHaveLength(1);
});

// ------------------------------------------------------------------- payload

test('FULL ROUND-TRIP: media and rawMetadata reach the delivery job intact', async () => {
  const base = tempRoot();
  const dir = seed(base, 'main', [120]);
  let job = null;
  const drain = coordinator({ deliver: async (j) => { job = j; return PROVEN; } });

  await drain.schedule(dir, 'main');

  expect(job.messageId).toBe('telegram-in-120');
  expect(job.media).toEqual({ kind: 'photo' });
  expect(job.metadata).toMatchObject({ updateId: 120, chatId: CHAT, extra: 'kept' });
  // Current session for delivery, original session retained for context.
  expect(job.sessionScopeId).toBe('session-now');
  expect(job.originalSessionScopeId).toBe('session-at-append');
});
