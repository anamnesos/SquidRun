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
const {
  createDrainCoordinator,
  isProvenOwnership,
  isCorrelatedProof,
} = require('../modules/main/telegram-ingress-drain');

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

// A real delivery adapter knows what it delivered, so it attaches identity.
// These helpers model that boundary; the validator never invents it.
function identityOf(job) {
  return {
    messageId: job.messageId,
    routeKey: job.routeKey,
    windowKey: job.windowKey,
    profile: job.profile,
  };
}
function provenFor(job) {
  return { ...identityOf(job), status: 'delivered.verified', verified: true };
}
const PROVEN_NO_IDENTITY = { status: 'delivered.verified', verified: true };
const IDENT = { messageId: 'telegram-in-60', routeKey: 'main', windowKey: 'main', profile: 'main' };
const UNPROVEN = { status: 'accepted.daemon_pty_unverified', accepted: true };

function coordinator(overrides = {}) {
  return createDrainCoordinator({
    queue,
    log: silentLog,
    resolveRoute: routerFor('main', 'main'),
    deliver: async (job) => provenFor(job),
    currentSessionFor: () => 'session-now',
    ...overrides,
  });
}

// ------------------------------------------------------------------ ordering

test('STARTUP DRAIN of an app-down backlog delivers N then N+1 and retires both', async () => {
  const base = tempRoot();
  const dir = seed(base, 'main', [10, 11]);
  const seen = [];
  const drain = coordinator({ deliver: async (job) => { seen.push(job.messageId); return provenFor(job); } });

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
      return provenFor(job);
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
    deliver: async (job) => { seen.push(job.messageId); return provenFor(job); },
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
    deliver: async (job) => { seen.push(job.messageId); await gate; return provenFor(job); },
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
  let receipt = null;
  let clock = 1_000_000;
  const seen = [];
  const drain = coordinator({
    now: () => clock,
    backoffMs: 5000,
    deliver: async (job) => { seen.push(job.messageId); return UNPROVEN; },
    findExistingReceipt: async () => receipt,
  });

  await drain.schedule(dir, 'main');
  expect(queue.readPending(dir)).toHaveLength(1);

  // The receipt lands out of band; after the backoff expires the next pass must
  // retire WITHOUT delivering again.
  receipt = { ...IDENT, status: 'delivered.verified', verified: true };
  clock = 1_009_000;
  await drain.schedule(dir, 'main');

  expect(seen).toEqual(['telegram-in-60']);
  expect(queue.readPending(dir)).toHaveLength(0);
});

const FULL_ID = {
  messageId: 'telegram-in-1', routeKey: 'main', windowKey: 'main', profile: 'main',
};

test.each([
  ['verified', { verified: true }],
  ['userVisible', { userVisible: true }],
  ['durable handoff', { durableHandoff: true }],
  ['allowlisted status', { status: 'durable.pending_handoff' }],
])('PROOF CLASS accepted: %s', (_l, receipt) => {
  expect(isProvenOwnership(receipt)).toBe(true);
  expect(isCorrelatedProof({ ...FULL_ID, ...receipt }, FULL_ID)).toBe(true);
});

test.each([
  ['no identity at all', {}],
  ['missing messageId', { routeKey: 'main', windowKey: 'main', profile: 'main' }],
  ['missing routeKey', { messageId: 'telegram-in-1', windowKey: 'main', profile: 'main' }],
  ['missing windowKey', { messageId: 'telegram-in-1', routeKey: 'main', profile: 'main' }],
  ['missing profile', { messageId: 'telegram-in-1', routeKey: 'main', windowKey: 'main' }],
])('IDENTITY-FREE PROOF IS FORGERY: verified:true with %s is rejected', (_l, partial) => {
  // The exact hole Architect #62 caught: the validator used to merge the
  // expected identity into the receipt and then "verify" it.
  expect(isCorrelatedProof({ ...partial, verified: true }, FULL_ID)).toBe(false);
});

test('A DELIVERY RECEIPT WITHOUT IDENTITY DOES NOT RETIRE THE RECORD', async () => {
  const base = tempRoot();
  const dir = seed(base, 'main', [190]);
  const drain = coordinator({ deliver: async () => PROVEN_NO_IDENTITY });

  const res = await drain.schedule(dir, 'main');

  expect(res.stoppedAt).toMatchObject({ updateId: 190 });
  expect(queue.readPending(dir)).toHaveLength(1);
});

test.each([
  ['transport only', { status: 'accepted.unverified', accepted: true }],
  ['daemon pty unverified', { status: 'accepted.daemon_pty_unverified' }],
  ['queued', { queued: true }],
  ['empty', {}],
  ['null', null],
  ['persisted id alone is not proof', { persistedReceiptId: 'ledger-1' }],
  ['our own inbound bookkeeping', { direction: 'inbound', verified: true }],
  ['our own brokered row', { status: 'brokered', verified: true }],
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
    deliver: async (job) => { seen.push(job.messageId); return provenFor(job); },
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
    deliver: async (job) => { seen.push(`main:${job.updateId}`); return provenFor(job); },
  });
  const scopedDrain = coordinator({
    resolveRoute: routerFor('sideprofile', 'sideprofile'),
    deliver: async (job) => { seen.push(`scoped:${job.updateId}`); return provenFor(job); },
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
  const drain = coordinator({ deliver: async (job) => { seen.push(job.messageId); return provenFor(job); } });

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
  const drain = coordinator({ deliver: async (j) => { job = j; return provenFor(job); } });

  await drain.schedule(dir, 'main');

  expect(job.messageId).toBe('telegram-in-120');
  expect(job.media).toEqual({ kind: 'photo' });
  expect(job.metadata).toMatchObject({ updateId: 120, chatId: CHAT, extra: 'kept' });
  // Current session for delivery, original session retained for context.
  expect(job.sessionScopeId).toBe('session-now');
  expect(job.originalSessionScopeId).toBe('session-at-append');
});

// ------------------------------------------- Architect #59 release blockers

test('OUR OWN BROKERED ROW MUST NEVER RETIRE THE QUEUE', async () => {
  // squidrun-app.js:14626 upserts direction:'inbound' status:'brokered' under
  // the SAME telegram-in-<updateId> BEFORE delivery. A boolean receipt check
  // would find it on the first pass and retire the record undelivered.
  const base = tempRoot();
  const dir = seed(base, 'main', [130]);
  const seen = [];
  const drain = coordinator({
    deliver: async (job) => { seen.push(job.messageId); return provenFor(job); },
    findExistingReceipt: async () => ({
      messageId: 'telegram-in-130',
      routeKey: 'main',
      windowKey: 'main',
      profile: 'main',
      direction: 'inbound',
      status: 'brokered',
    }),
  });

  await drain.schedule(dir, 'main');

  // It must have been DELIVERED, not silently retired on our own bookkeeping.
  expect(seen).toEqual(['telegram-in-130']);
});

test.each([
  ['mismatched messageId', { messageId: 'telegram-in-999', routeKey: 'main', verified: true }],
  ['mismatched routeKey', { messageId: 'telegram-in-140', routeKey: 'sideprofile', verified: true }],
  ['mismatched window', { messageId: 'telegram-in-140', routeKey: 'main', windowKey: 'other', verified: true }],
  ['no proof class', { messageId: 'telegram-in-140', routeKey: 'main' }],
])('UNCORRELATED EVIDENCE does not retire: %s', async (_l, evidence) => {
  const base = tempRoot();
  const dir = seed(base, 'main', [140]);
  const seen = [];
  const drain = coordinator({
    deliver: async (job) => { seen.push(job.messageId); return UNPROVEN; },
    findExistingReceipt: async () => evidence,
  });

  await drain.schedule(dir, 'main');

  expect(seen).toEqual(['telegram-in-140']);
  expect(queue.readPending(dir)).toHaveLength(1);
});

test('EXACT DOWNSTREAM PROOF retires without re-injection', () => {
  const expected = { messageId: 'telegram-in-141', routeKey: 'main', windowKey: 'main', profile: 'main' };
  expect(isCorrelatedProof({ ...expected, status: 'durable.pending_handoff' }, expected)).toBe(true);
  expect(isCorrelatedProof({ ...expected, direction: 'inbound', verified: true }, expected)).toBe(false);
});

test('BACKOFF: a schedule before expiry does NOT re-deliver N', async () => {
  const base = tempRoot();
  const dir = seed(base, 'main', [150]);
  const seen = [];
  let clock = 1_000_000;
  const drain = coordinator({
    now: () => clock,
    backoffMs: 5000,
    deliver: async (job) => { seen.push(job.messageId); return UNPROVEN; },
  });

  await drain.schedule(dir, 'main');
  expect(seen).toEqual(['telegram-in-150']);

  // Still inside the backoff window.
  clock = 1_003_000;
  const blocked = await drain.schedule(dir, 'main');
  expect(blocked.blocked).toBe(true);
  expect(seen).toEqual(['telegram-in-150']);

  // After expiry it may try again.
  clock = 1_007_000;
  await drain.schedule(dir, 'main');
  expect(seen).toEqual(['telegram-in-150', 'telegram-in-150']);
});

test('BACKOFF EXPIRY re-checks proof first and retires without a second injection', async () => {
  const base = tempRoot();
  const dir = seed(base, 'main', [160]);
  const seen = [];
  let clock = 1_000_000;
  let receipt = null;
  const drain = coordinator({
    now: () => clock,
    backoffMs: 5000,
    deliver: async (job) => { seen.push(job.messageId); return UNPROVEN; },
    findExistingReceipt: async () => receipt,
  });

  await drain.schedule(dir, 'main');
  expect(seen).toEqual(['telegram-in-160']);

  // The delivery actually landed; proof arrives during the backoff.
  receipt = {
    messageId: 'telegram-in-160', routeKey: 'main', windowKey: 'main', profile: 'main',
    status: 'delivered.verified', verified: true,
  };
  clock = 1_007_000;
  await drain.schedule(dir, 'main');

  expect(seen).toEqual(['telegram-in-160']);
  expect(queue.readPending(dir)).toHaveLength(0);
});

test('ACK THROW stops at N exactly like ack false', async () => {
  const base = tempRoot();
  const dir = seed(base, 'main', [170, 171]);
  const seen = [];
  const drain = coordinator({
    queue: {
      readPending: queue.readPending,
      ack: () => { throw new Error('EIO'); },
    },
    deliver: async (job) => { seen.push(job.messageId); return provenFor(job); },
  });

  const res = await drain.schedule(dir, 'main');

  expect(seen).toEqual(['telegram-in-170']);
  expect(res.stoppedAt).toMatchObject({ updateId: 170, reason: 'ack_failed' });
});

test('UNKNOWN TERMINAL DISPOSITION holds instead of retiring undelivered', async () => {
  const base = tempRoot();
  const dir = seed(base, 'main', [180], { terminalDisposition: 'corrupted_value' });
  const seen = [];
  const drain = coordinator({ deliver: async (job) => { seen.push(job.messageId); return provenFor(job); } });

  const res = await drain.schedule(dir, 'main');

  expect(seen).toEqual([]);
  expect(res.stoppedAt).toMatchObject({ updateId: 180, reason: 'unknown_terminal_disposition' });
  expect(queue.readPending(dir)).toHaveLength(1);
});
