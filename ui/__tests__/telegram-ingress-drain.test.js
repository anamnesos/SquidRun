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
  looksAccepted,
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
    queue: { ...queue, readPending: queue.readPending, ack: () => ({ ok: false, reason: 'eio' }) },
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

test('BACKOFF applies to DEFINITE failures: blocked before expiry, retried after', async () => {
  const base = tempRoot();
  const dir = seed(base, 'main', [150]);
  const seen = [];
  let clock = 1_000_000;
  const drain = coordinator({
    now: () => clock,
    backoffMs: 5000,
    // A RETURNED hard rejection: the pane says it never took the message, so
    // the attempt resolves as "did not happen" and re-delivery is safe. A THROW
    // is different — it is ambiguous, and ambiguity holds.
    deliver: async (job) => {
      seen.push(job.messageId);
      return { ok: false, accepted: false, status: 'daemon_not_connected' };
    },
  });

  await drain.schedule(dir, 'main');
  expect(seen).toEqual(['telegram-in-150']);

  clock = 1_003_000;
  const blocked = await drain.schedule(dir, 'main');
  expect(blocked.blocked).toBe(true);
  expect(seen).toEqual(['telegram-in-150']);

  clock = 1_007_000;
  await drain.schedule(dir, 'main');
  expect(seen).toEqual(['telegram-in-150', 'telegram-in-150']);
});

test('ACCEPTED-BUT-UNPROVED IS NEVER RE-INJECTED, no matter how long we wait', async () => {
  // Architect #63: the submit verifier legitimately waits ~484s because a busy
  // pane can be slow to report prompt_submit. A timer that re-delivers after
  // 30s would put the same message in front of James twice. Once accepted, the
  // only exit is correlated proof.
  const base = tempRoot();
  const dir = seed(base, 'main', [151, 152]);
  const seen = [];
  let clock = 1_000_000;
  const drain = coordinator({
    now: () => clock,
    backoffMs: 5000,
    deliver: async (job) => { seen.push(job.messageId); return UNPROVEN; },
  });

  await drain.schedule(dir, 'main');
  expect(seen).toEqual(['telegram-in-151']);

  // Far beyond any backoff, and repeatedly scheduled.
  for (const t of [1_010_000, 1_100_000, 2_000_000]) {
    clock = t;
    const res = await drain.schedule(dir, 'main');
    expect(res.stoppedAt).toMatchObject({ updateId: 151, failureClass: 'awaiting_proof' });
  }

  // Delivered exactly once, and N+1 never jumped the queue.
  expect(seen).toEqual(['telegram-in-151']);
  expect(queue.readPending(dir).map((r) => r.updateId)).toEqual([151, 152]);
});

test('A LONE AWAITING-PROOF MESSAGE RETIRES ON PROOF ALONE, without N+1 arriving', async () => {
  const base = tempRoot();
  const dir = seed(base, 'main', [153]);
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
  expect(queue.readPending(dir)).toHaveLength(1);

  receipt = {
    messageId: 'telegram-in-153', routeKey: 'main', windowKey: 'main', profile: 'main',
    status: 'delivered.verified', verified: true,
  };
  clock = 1_002_000;
  await drain.schedule(dir, 'main');

  expect(seen).toEqual(['telegram-in-153']);
  expect(queue.readPending(dir)).toHaveLength(0);
});

test('A THROWING RECEIPT LOOKUP HOLDS AT N rather than risking a second copy', async () => {
  const base = tempRoot();
  const dir = seed(base, 'main', [154, 155]);
  const seen = [];
  const drain = coordinator({
    deliver: async (job) => { seen.push(job.messageId); return provenFor(job); },
    findExistingReceipt: async () => { throw new Error('ledger unavailable'); },
  });

  const res = await drain.schedule(dir, 'main');

  expect(seen).toEqual([]);
  expect(res.stoppedAt).toMatchObject({ updateId: 154, reason: 'receipt_lookup_failed' });
  expect(queue.readPending(dir)).toHaveLength(2);
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
      ...queue,
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

// ------------------------------------------- Architect #64 state-machine holes

test('HARD REJECTION is retryable, not latched into a permanent proof wait', async () => {
  // A disconnected daemon delivered nothing. Latching it as awaiting-proof
  // would strand the message forever, waiting for proof of something that
  // never happened.
  const base = tempRoot();
  const dir = seed(base, 'main', [200]);
  const seen = [];
  let clock = 1_000_000;
  const drain = coordinator({
    now: () => clock,
    backoffMs: 5000,
    deliver: async (job) => {
      seen.push(job.messageId);
      return { ok: false, accepted: false, queued: false, status: 'daemon_not_connected' };
    },
  });

  const first = await drain.schedule(dir, 'main');
  expect(first.stoppedAt).toMatchObject({ updateId: 200, failureClass: 'definite' });

  // After the backoff it must try again — this one is safe to retry.
  clock = 1_007_000;
  await drain.schedule(dir, 'main');
  expect(seen).toEqual(['telegram-in-200', 'telegram-in-200']);
});

test('ACK LOSS AFTER A VISIBLE DELIVERY does not re-deliver on the next schedule', async () => {
  // The delivery landed and was proven, but the ack failed and the persistent
  // receipt lookup is momentarily empty. Re-delivering here is exactly how
  // James sees the same message twice.
  const base = tempRoot();
  const dir = seed(base, 'main', [210, 211]);
  const seen = [];
  const drain = coordinator({
    queue: { ...queue, readPending: queue.readPending, ack: () => ({ ok: false, reason: 'eio' }) },
    deliver: async (job) => { seen.push(job.messageId); return provenFor(job); },
    findExistingReceipt: async () => null,
  });

  await drain.schedule(dir, 'main');
  const second = await drain.schedule(dir, 'main');

  expect(seen).toEqual(['telegram-in-210']);
  expect(second.stoppedAt).toMatchObject({ updateId: 210, failureClass: 'awaiting_proof' });
  expect(queue.readPending(dir).map((r) => r.updateId)).toEqual([210, 211]);
});

test.each([
  ['accepted', { accepted: true }],
  ['queued', { queued: true }],
  ['receiptPending', { receiptPending: true }],
  ['accepted.* status', { status: 'accepted.daemon_pty_unverified' }],
])('LOOKS-ACCEPTED enters proof-only hold: %s', (_l, receipt) => {
  expect(looksAccepted(receipt)).toBe(true);
});

test.each([
  ['ok:false with no acceptance signal', { ok: false }],
  ['daemon not connected', { status: 'daemon_not_connected' }],
  ['pane missing', { status: 'pane_missing' }],
  ['rejected', { status: 'rejected' }],
  ['nothing at all', {}],
  ['null', null],
])('HARD FAILURE stays retryable: %s', (_l, receipt) => {
  expect(looksAccepted(receipt)).toBe(false);
});

// -------------------------------------------- Architect #65 conservative edges

test('ACCEPTED WITH ok:false enters proof-only hold: the bytes are already on screen', () => {
  // daemon_enter_failed / daemon_paste_end_failed report ok:false AFTER writing
  // the text. Retrying duplicates or concatenates what James can already see.
  expect(looksAccepted({ ok: false, accepted: true, status: 'daemon_enter_failed' })).toBe(true);
  expect(looksAccepted({ ok: false, accepted: true, status: 'daemon_paste_end_failed' })).toBe(true);
  expect(looksAccepted({ ok: false, pendingQueued: true })).toBe(true);
});

test('PARTIAL-WRITE FAILURE IS NOT RETRIED', async () => {
  const base = tempRoot();
  const dir = seed(base, 'main', [220]);
  const seen = [];
  let clock = 1_000_000;
  const drain = coordinator({
    now: () => clock,
    backoffMs: 5000,
    deliver: async (job) => {
      seen.push(job.messageId);
      return { ok: false, accepted: true, status: 'daemon_enter_failed' };
    },
  });

  const first = await drain.schedule(dir, 'main');
  expect(first.stoppedAt).toMatchObject({ updateId: 220, failureClass: 'awaiting_proof' });

  clock = 2_000_000;
  await drain.schedule(dir, 'main');
  expect(seen).toEqual(['telegram-in-220']);
});

test('FRESH PROCESS: proof found, ack fails, lookup goes empty => zero visible deliveries', async () => {
  const base = tempRoot();
  const dir = seed(base, 'main', [230, 231]);
  const seen = [];
  let receipt = {
    messageId: 'telegram-in-230', routeKey: 'main', windowKey: 'main', profile: 'main',
    status: 'delivered.verified', verified: true,
  };
  const drain = coordinator({
    queue: { ...queue, readPending: queue.readPending, ack: () => ({ ok: false, reason: 'eio' }) },
    deliver: async (job) => { seen.push(job.messageId); return provenFor(job); },
    findExistingReceipt: async () => receipt,
  });

  await drain.schedule(dir, 'main');
  // The ledger blinks out between passes.
  receipt = null;
  const second = await drain.schedule(dir, 'main');

  expect(seen).toEqual([]);
  expect(second.stoppedAt).toMatchObject({ updateId: 230, failureClass: 'awaiting_proof' });
  expect(queue.readPending(dir).map((r) => r.updateId)).toEqual([230, 231]);
});

test('THE PROOF CALLBACK RECEIVES THE STORED chatId', async () => {
  // Threading this was silently a no-op once: a plain string replace ran against
  // the wrong module, matched nothing, and reported success. Without chatId the
  // replay lookup correlates against nothing and re-delivers.
  const base = tempRoot();
  const dir = seed(base, 'main', [240]);
  const seen = [];
  const drain = coordinator({
    findExistingReceipt: async (identity) => { seen.push(identity); return null; },
  });

  await drain.schedule(dir, 'main');

  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({
    messageId: 'telegram-in-240', routeKey: 'main', windowKey: 'main', chatId: CHAT,
  });
});

// -------------------------------------- Architect #80/#82: durable + self-driven

test('CRASH AFTER ACCEPT, BEFORE RECEIPT: a fresh coordinator does NOT re-inject', async () => {
  // The in-memory latch dies with the process. Exact sequence: accepted but
  // unproved -> app dies before the receipt persists -> restart -> empty Map.
  // Without a durable marker N goes out a second time.
  const base = tempRoot();
  const dir = seed(base, 'main', [300]);
  const first = [];
  const before = coordinator({ deliver: async (job) => { first.push(job.messageId); return UNPROVEN; } });
  await before.schedule(dir, 'main');
  expect(first).toEqual(['telegram-in-300']);

  // "Restart": a brand new coordinator with no memory of anything.
  const after = [];
  const restarted = coordinator({ deliver: async (job) => { after.push(job.messageId); return provenFor(job); } });
  const res = await restarted.schedule(dir, 'main');

  expect(after).toEqual([]);
  expect(res.stoppedAt).toMatchObject({ updateId: 300, reason: 'unresolved_delivery_attempt' });
  expect(queue.readPending(dir)).toHaveLength(1);
});

test('S491 HEAD-OF-LINE: past the grace, an unprovable N stops muting N+1', async () => {
  // THE LIVE INCIDENT. Production pane delivery only ever returns
  // accepted.daemon_pty_unverified, which is correctly not proof, so N latched
  // "attempted" forever and the ordered drain stopped the whole route. Six of
  // James's messages sat undelivered for hours while poller health read green.
  const base = tempRoot();
  const dir = seed(base, 'main', [400, 401, 402]);

  // Wedge 400 exactly the way the incident did: attempted, never proven.
  const first = [];
  const before = coordinator({ deliver: async (job) => { first.push(job.messageId); return UNPROVEN; } });
  await before.schedule(dir, 'main');
  expect(first).toEqual(['telegram-in-400']);

  // Restart with the grace already elapsed (graceMs 0) — the injectable seam.
  const after = [];
  const restarted = coordinator({
    headOfLineGraceMs: 0,
    deliver: async (job) => { after.push(job.messageId); return provenFor(job); },
  });
  const res = await restarted.schedule(dir, 'main');

  // The messages BEHIND the wedge finally move...
  expect(after).toEqual(['telegram-in-401', 'telegram-in-402']);
  // ...the ambiguous record is NEVER re-injected (Oracle #5: 316 was already
  // consumed and answered; re-delivering would duplicate visible work)...
  expect(after).not.toContain('telegram-in-400');
  // ...it is reported, never silent...
  expect(res.bypassed).toEqual([
    expect.objectContaining({ updateId: 400, reason: 'unresolved_delivery_attempt' }),
  ]);
  // ...and it stays durably queued for proper reconciliation, not lost.
  expect(queue.readPending(dir).map((r) => r.updateId)).toEqual([400]);
});

test('INSIDE the grace, the wedge still holds the line', async () => {
  const base = tempRoot();
  const dir = seed(base, 'main', [410, 411]);
  const before = coordinator({ deliver: async () => UNPROVEN });
  await before.schedule(dir, 'main');

  const after = [];
  const restarted = coordinator({
    headOfLineGraceMs: 10 * 60 * 1000,
    deliver: async (job) => { after.push(job.messageId); return provenFor(job); },
  });
  const res = await restarted.schedule(dir, 'main');

  expect(after).toEqual([]);
  expect(res.stoppedAt).toMatchObject({ updateId: 410, reason: 'unresolved_delivery_attempt' });
  expect(res.bypassed).toEqual([]);
});

test('AFTER RESTART, exact proof retires the ambiguous attempt without re-injection', async () => {
  const base = tempRoot();
  const dir = seed(base, 'main', [310]);
  await coordinator({ deliver: async () => UNPROVEN }).schedule(dir, 'main');

  const after = [];
  const restarted = coordinator({
    deliver: async (job) => { after.push(job.messageId); return provenFor(job); },
    findExistingReceipt: async (identity) => ({
      ...identity, status: 'delivered.verified', verified: true,
    }),
  });
  await restarted.schedule(dir, 'main');

  expect(after).toEqual([]);
  expect(queue.readPending(dir)).toHaveLength(0);
});

test('A FAILED ATTEMPT MARKER MEANS NO DELIVERY AT ALL', async () => {
  const base = tempRoot();
  const dir = seed(base, 'main', [320]);
  const seen = [];
  const drain = coordinator({ deliver: async (job) => { seen.push(job.messageId); return provenFor(job); } });

  const realAppend = fs.appendFileSync;
  fs.appendFileSync = (file, ...rest) => {
    if (String(file).includes('delivery-attempts')) throw new Error('EIO');
    return realAppend(file, ...rest);
  };
  let res;
  try {
    res = await drain.schedule(dir, 'main');
  } finally {
    fs.appendFileSync = realAppend;
  }

  expect(seen).toEqual([]);
  expect(res.stoppedAt.reason).toContain('attempt_marker_failed');
});

test('A CORRUPT ATTEMPT JOURNAL FAILS CLOSED', async () => {
  const base = tempRoot();
  const dir = seed(base, 'main', [330]);
  // The QUEUE owns the sidecar; addressing it through the drain would keep
  // treating the drain as its owner.
  fs.writeFileSync(queue.attemptsPath(dir), 'not json at all\n{"updateId":330}\n', 'utf8');

  const seen = [];
  const drain = coordinator({ deliver: async (job) => { seen.push(job.messageId); return provenFor(job); } });
  const res = await drain.schedule(dir, 'main');

  expect(seen).toEqual([]);
  expect(res.stoppedAt).toBeTruthy();
});

test('SWEEP ARMS ITSELF on the first hold and retires with NO external call', async () => {
  // Two versions of this test were wrong before. The first called schedule() by
  // hand after installing proof; the second called startProofSweep() by hand.
  // Both were external pokes that production does not perform. The coordinator
  // has to arm the sweep itself the moment it first holds.
  jest.useFakeTimers();
  try {
    const base = tempRoot();
    const dir = seed(base, 'main', [340]);
    let receipt = null;
    const seen = [];
    const drain = coordinator({
      sweepIntervalMs: 1000,
      deliver: async (job) => { seen.push(job.messageId); return UNPROVEN; },
      findExistingReceipt: async (identity) => receipt && { ...identity, ...receipt },
    });

    await drain.schedule(dir, 'main');
    expect(queue.readPending(dir)).toHaveLength(1);

    // Proof lands out of band. Nothing calls schedule or startProofSweep.
    receipt = { status: 'delivered.verified', verified: true };
    jest.advanceTimersByTime(1000);
    jest.useRealTimers();
    for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r));

    expect(seen).toEqual(['telegram-in-340']);
    expect(queue.readPending(dir)).toHaveLength(0);
    await drain.dispose();
  } finally {
    jest.useRealTimers();
  }
});

test('ONE sweep per dir, however many holds occur', async () => {
  jest.useFakeTimers();
  try {
    const base = tempRoot();
    const dir = seed(base, 'main', [341]);
    const drain = coordinator({
      sweepIntervalMs: 1000,
      deliver: async () => UNPROVEN,
    });
    await drain.schedule(dir, 'main');
    const first = drain._internals.state.get(dir).sweepTimer;
    await drain.schedule(dir, 'main');
    expect(drain._internals.state.get(dir).sweepTimer).toBe(first);
    await drain.dispose();
  } finally {
    jest.useRealTimers();
  }
});

test('DISPOSE awaits an in-flight drain and refuses everything after', async () => {
  const base = tempRoot();
  const dir = seed(base, 'main', [342]);
  const seen = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const drain = coordinator({
    deliver: async (job) => { seen.push(job.messageId); await gate; return provenFor(job); },
  });

  const order = [];
  const running = drain.schedule(dir, 'main').then(() => order.push('drain-settled'));
  const disposing = drain.dispose().then(() => order.push('dispose-returned'));
  release();
  await Promise.all([running, disposing]);

  // dispose() must not return until the in-flight delivery has settled — the
  // app tears down journals and the poller right after it resolves.
  expect(order).toEqual(['drain-settled', 'dispose-returned']);
  expect(seen).toEqual(['telegram-in-342']);
  expect(drain.isDisposed()).toBe(true);

  // And nothing may start afterwards.
  const after = await drain.schedule(dir, 'main');
  expect(after).toMatchObject({ ok: false, reason: 'coordinator_disposed' });
  expect(drain.armProofSweep(dir, 'main')).toBeNull();
  expect(seen).toEqual(['telegram-in-342']);
});

test('DISPOSE cancels the sweep so no timer outlives the app', async () => {
  jest.useFakeTimers();
  try {
    const base = tempRoot();
    const dir = seed(base, 'main', [350]);
    const seen = [];
    const drain = coordinator({ deliver: async (job) => { seen.push(job.messageId); return UNPROVEN; } });

    drain.startProofSweep(dir, 'main', 1000);
    drain.dispose();
    jest.advanceTimersByTime(10000);
    await Promise.resolve();

    expect(seen).toEqual([]);
  } finally {
    jest.useRealTimers();
  }
});

test('NEWLINE-TERMINATED CORRUPTION IS NOT A TORN TAIL: it fails closed', async () => {
  // A file ending in \n has no partial append. Every line is a complete record,
  // so a corrupt one means the journal is untrustworthy — skipping it would
  // authorize a delivery we may already have made.
  const base = tempRoot();
  const dir = seed(base, 'main', [360]);
  // The QUEUE owns the sidecar; addressing it through the drain would keep
  // treating the drain as its owner.
  fs.writeFileSync(queue.attemptsPath(dir), 'garbage-but-complete\n', 'utf8');

  const seen = [];
  const drain = coordinator({ deliver: async (job) => { seen.push(job.messageId); return provenFor(job); } });
  const res = await drain.schedule(dir, 'main');

  expect(seen).toEqual([]);
  expect(res.stoppedAt.reason).toContain('attempt_journal_unreadable');
});

test('A TORN TAIL IS NOT TOLERATED EITHER: the sidecar biases HOLD', async () => {
  // The sidecar is the ambiguity latch, so a tail it cannot fully trust stops
  // everything. Since #129 appendAttempt does NOT seal-and-append behind a torn
  // fragment either: repairing it would bless whatever that half-written record
  // was about. Read and append both refuse without modifying the file.
  const base = tempRoot();
  const dir = seed(base, 'main', [370]);
  // The QUEUE owns the sidecar; addressing it through the drain would keep
  // treating the drain as its owner.
  fs.writeFileSync(queue.attemptsPath(dir), '{"updateId":1,"state":"retryable"}\n{"updat', 'utf8');

  const seen = [];
  const drain = coordinator({ deliver: async (job) => { seen.push(job.messageId); return provenFor(job); } });
  const res = await drain.schedule(dir, 'main');

  expect(seen).toEqual([]);
  expect(res.stoppedAt.reason).toContain('attempt_journal_unreadable');
});

test.each([
  ['no state field', '{"updateId":5}'],
  ['unknown state', '{"updateId":5,"state":"probably-fine"}'],
  ['zero updateId', '{"updateId":0,"state":"attempted"}'],
  ['non-integer updateId', '{"updateId":"five","state":"attempted"}'],
])('PARSEABLE BUT INVALID entry fails closed: %s', async (_l, line) => {
  // A record missing its state used to read as "not attempted" and authorize
  // delivery — parseable is not the same as valid.
  const base = tempRoot();
  const dir = seed(base, 'main', [375]);
  // The QUEUE owns the sidecar; addressing it through the drain would keep
  // treating the drain as its owner.
  fs.writeFileSync(queue.attemptsPath(dir), `${line}\n`, 'utf8');

  const seen = [];
  const drain = coordinator({ deliver: async (job) => { seen.push(job.messageId); return provenFor(job); } });
  const res = await drain.schedule(dir, 'main');

  expect(seen).toEqual([]);
  expect(res.stoppedAt.reason).toContain('attempt_journal_unreadable');
});

test('A DELIVER THROW IS AMBIGUOUS, not a definite failure', async () => {
  const base = tempRoot();
  const dir = seed(base, 'main', [380]);
  const seen = [];
  let clock = 1_000_000;
  const drain = coordinator({
    now: () => clock,
    backoffMs: 5000,
    deliver: async (job) => { seen.push(job.messageId); throw new Error('exploded mid-send'); },
  });

  const res = await drain.schedule(dir, 'main');
  expect(res.stoppedAt).toMatchObject({ updateId: 380, failureClass: 'awaiting_proof' });

  // Even long after any backoff, it must not be re-injected.
  clock = 9_000_000;
  await drain.schedule(dir, 'main');
  expect(seen).toEqual(['telegram-in-380']);
});

test('DIRECT drainOnce respects dispose too', async () => {
  // Guarding only schedule() left the startup path wide open during teardown.
  const base = tempRoot();
  const dir = seed(base, 'main', [400]);
  const seen = [];
  const drain = coordinator({ deliver: async (job) => { seen.push(job.messageId); return provenFor(job); } });

  await drain.dispose();
  const res = await drain.drainOnce(dir, 'main');

  expect(seen).toEqual([]);
  expect(res).toMatchObject({ ok: false, reason: 'coordinator_disposed' });
});

test('DISPOSE MID-BATCH: dispose waits for N, and N+1 is never delivered', async () => {
  const base = tempRoot();
  const dir = seed(base, 'main', [410, 411]);
  const seen = [];
  const settled = [];
  let disposing = null;
  let release;
  const gate = new Promise((r) => { release = r; });

  let drain;
  drain = coordinator({
    deliver: async (job) => {
      seen.push(job.messageId);
      if (job.updateId === 410) {
        // Teardown begins WHILE N is still in flight. Retain the promise —
        // voiding it made "dispose finished" unobservable, so the old test
        // could not tell waiting from not waiting.
        disposing = drain.dispose().then(() => settled.push('dispose'));
        await gate;
      }
      return provenFor(job);
    },
  });

  const running = drain.schedule(dir, 'main').then(() => settled.push('schedule'));

  // Let the deliver callback start and register the dispose.
  await new Promise((r) => setImmediate(r));
  expect(disposing).not.toBeNull();
  expect(settled).toEqual([]); // dispose is still unresolved: N is in flight

  release();
  await Promise.all([running, disposing]);

  expect(settled).toEqual(['schedule', 'dispose']);
  expect(seen).toEqual(['telegram-in-410']);
});

test('COALESCED RERUN AFTER DISPOSE: no follow-up pass, no N+1', async () => {
  // st.rerun was set by a second schedule while the first was in flight. If
  // dispose does not stop the loop, that pending rerun delivers N+1 into a
  // half-dismantled app.
  const base = tempRoot();
  const dir = seed(base, 'main', [420]);
  const seen = [];
  let release;
  const gate = new Promise((r) => { release = r; });

  const drain = coordinator({
    deliver: async (job) => { seen.push(job.messageId); await gate; return provenFor(job); },
  });

  const first = drain.schedule(dir, 'main');
  await new Promise((r) => setImmediate(r));

  // New work arrives, and a second schedule marks the rerun.
  seed(base, 'main', [421]);
  const coalesced = await drain.schedule(dir, 'main');
  expect(coalesced.coalesced).toBe(true);

  const disposing = drain.dispose();
  release();
  await Promise.all([first, disposing]);

  // The first pass settled, dispose settled, and the coalesced rerun never ran.
  expect(seen).toEqual(['telegram-in-420']);
  expect(queue.readPending(dir).map((r) => r.updateId)).toEqual([421]);
});

test('A FULLY DRAINED ROUTE stops its sweep instead of ticking forever', async () => {
  const base = tempRoot();
  const dir = seed(base, 'main', [420]);
  let proof = null;
  const drain = coordinator({
    sweepIntervalMs: 1000,
    deliver: async () => UNPROVEN,
    findExistingReceipt: async (identity) => proof && { ...identity, ...proof },
  });

  await drain.schedule(dir, 'main');
  expect(drain._internals.state.get(dir).sweepTimer).toBeTruthy();

  // Once accepted-but-unproved, only PROOF can retire it — a retry cannot, and
  // must not. Proof arrives and the queue empties.
  proof = { status: 'delivered.verified', verified: true };
  await drain.schedule(dir, 'main');

  expect(queue.readPending(dir)).toHaveLength(0);
  expect(drain._internals.state.get(dir).sweepTimer).toBeFalsy();
  await drain.dispose();
});

test('DISPOSE waits for an in-flight DIRECT drain, not just a scheduled one', async () => {
  // An untracked drainOnce awaiting deliver() when dispose starts would let
  // dispose resolve immediately, and shutdown would close journals out from
  // under a live delivery.
  const base = tempRoot();
  const dir = seed(base, 'main', [430]);
  const order = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const drain = coordinator({
    deliver: async (job) => { await gate; order.push('delivered'); return provenFor(job); },
  });

  const direct = drain.drainOnce(dir, 'main').then(() => order.push('pass-settled'));
  const disposing = drain.dispose().then(() => order.push('dispose-returned'));
  release();
  await Promise.all([direct, disposing]);

  expect(order).toEqual(['delivered', 'pass-settled', 'dispose-returned']);
});

test('A DIRECT pass and a SCHEDULED pass cannot double-deliver', async () => {
  const base = tempRoot();
  const dir = seed(base, 'main', [440]);
  const seen = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const drain = coordinator({
    deliver: async (job) => { seen.push(job.messageId); await gate; return provenFor(job); },
  });

  const a = drain.drainOnce(dir, 'main');
  const b = drain.schedule(dir, 'main');
  release();
  await Promise.all([a, b]);

  expect(seen).toEqual(['telegram-in-440']);
});

test('A DIRECT pass arriving mid-drain sets rerun, so newly queued work is not dropped', async () => {
  // The two-way coalescing loss: a separate direct wrapper returned "coalesced"
  // WITHOUT setting rerun, so anything appended during the in-flight pass was
  // silently stranded until some unrelated event scheduled another drain.
  const base = tempRoot();
  const dir = seed(base, 'main', [500]);
  const seen = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const drain = coordinator({
    deliver: async (job) => {
      seen.push(job.messageId);
      if (job.updateId === 500) await gate;
      return provenFor(job);
    },
  });

  const running = drain.schedule(dir, 'main');
  // New inbound lands while the first pass is still delivering.
  seed(base, 'main', [501]);
  const direct = drain.drainOnce(dir, 'main');
  release();
  await Promise.all([running, direct]);

  expect(seen).toEqual(['telegram-in-500', 'telegram-in-501']);
  expect(queue.readPending(dir)).toHaveLength(0);
});

test('THE INJECTED QUEUE OWNS ATTEMPT STORAGE, not the default module', () => {
  // Rejecting a queue that LACKS the attempt methods proves only that the
  // check exists. It does not prove the coordinator actually calls the injected
  // ones — rebinding to defaultQueue while the injected methods merely exist
  // would leave every other drain test green. These spies do not touch disk, so
  // if the default module were used instead, its sidecar file would appear.
  return (async () => {
    const base = tempRoot();
    const dir = seed(base, 'main', [600]);
    const reads = [];
    const appends = [];

    const drain = coordinator({
      queue: {
        ...queue,
        readAttemptState: (d) => { reads.push(d); return new Map(); },
        appendAttempt: (d, updateId, state) => { appends.push({ d, updateId, state }); return { ok: true }; },
      },
      deliver: async (job) => provenFor(job),
    });

    await drain.schedule(dir, 'main');

    // The injected implementations were the ones consulted...
    expect(reads).toEqual([dir]);
    expect(appends).toEqual([{ d: dir, updateId: 600, state: 'attempted' }]);
    // ...and nothing wrote through the default module's path.
    expect(fs.existsSync(queue.attemptsPath(dir))).toBe(false);
  })();
});
