'use strict';

const path = require('path');
const { createDrainCoordinator } = require('../modules/main/telegram-ingress-drain');
const { LEGACY_SETTLEMENT } = require('../modules/main/telegram-activation-mode');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function record(updateId, overrides = {}) {
  return {
    updateId,
    text: `message-${updateId}`,
    from: 'James',
    chatId: `chat-${updateId}`,
    targetSession: `source-session-${updateId}`,
    media: null,
    rawMetadata: { updateId, marker: `raw-${updateId}` },
    receivedAtMs: 1_000 + updateId,
    ...overrides,
  };
}

function makeHarness(options = {}) {
  let pending = (options.records || []).slice();
  const log = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  const queue = {
    readPending: jest.fn(() => pending.slice()),
    ack: jest.fn((dir, updateIds) => {
      if (options.ack) {
        const overridden = options.ack({ dir, updateIds: updateIds.slice(), pending: pending.slice() });
        if (overridden !== undefined) {
          if (overridden && overridden.ok === true && overridden.acked === 1) {
            pending = pending.filter((item) => Number(item.updateId) !== Number(updateIds[0]));
          }
          return overridden;
        }
      }
      pending = pending.filter((item) => Number(item.updateId) !== Number(updateIds[0]));
      return { ok: true, acked: 1 };
    }),
  };
  const resolveRoute = jest.fn(options.resolveRoute || ((chatId) => ({
    ok: true,
    profile: 'main',
    windowKey: 'main',
    chatId,
  })));
  const lookupTransportClaim = jest.fn(options.lookupTransportClaim || (async () => null));
  const deliver = jest.fn(options.deliver || (async () => ({ ok: true, status: 'accepted' })));
  const coordinator = createDrainCoordinator({
    queue,
    log,
    resolveRoute,
    lookupTransportClaim,
    deliver,
    currentSessionFor: options.currentSessionFor || (() => 'current-session'),
    activationMode: options.activationMode || (() => LEGACY_SETTLEMENT),
    now: options.now || (() => 10_000),
  });

  return {
    coordinator,
    queue,
    log,
    resolveRoute,
    lookupTransportClaim,
    deliver,
    pending: () => pending.slice(),
  };
}

describe('Telegram ingress drain: the current no-hold contract', () => {
  test('offers unsorted records in updateId order and preserves the stored payload', async () => {
    const media = { kind: 'photo', fileId: 'photo-1' };
    const h = makeHarness({
      records: [record(3), record(1, { media }), record(2)],
    });

    const result = await h.coordinator.schedule('spool-main', 'main');

    expect(h.deliver.mock.calls.map(([job]) => job.updateId)).toEqual([1, 2, 3]);
    expect(h.deliver.mock.calls[0][0]).toEqual(expect.objectContaining({
      messageId: 'telegram-in-1',
      text: 'message-1',
      from: 'James',
      chatId: 'chat-1',
      routeKey: 'main',
      windowKey: 'main',
      profile: 'main',
      sessionScopeId: 'current-session',
      originalSessionScopeId: 'source-session-1',
      media,
      metadata: { updateId: 1, marker: 'raw-1' },
    }));
    expect(h.queue.ack.mock.calls.map(([, ids]) => ids[0])).toEqual([1, 2, 3]);
    expect(h.pending()).toEqual([]);
    expect(result).toEqual(expect.objectContaining({ delivered: 3, pending: 3, stoppedAt: null }));
  });

  test('a claim lookup that throws logs the accepted duplicate risk and still delivers N and N+1', async () => {
    const h = makeHarness({
      records: [record(1), record(2)],
      lookupTransportClaim: async ({ updateId }) => {
        if (updateId === 1) throw new Error('claim db offline');
        return null;
      },
    });

    await h.coordinator.schedule('spool-main', 'main');

    expect(h.deliver.mock.calls.map(([job]) => job.updateId)).toEqual([1, 2]);
    expect(h.log.warn).toHaveBeenCalledWith(
      'Telegram',
      expect.stringMatching(/Claim lookup failed for update 1.*delivering anyway/s)
    );
    expect(h.pending()).toEqual([]);
  });

  test('an existing updateId claim suppresses only that re-injection and releases the next record', async () => {
    const h = makeHarness({
      records: [record(1), record(2)],
      lookupTransportClaim: async ({ updateId }) => (
        updateId === 1 ? { claim: { id: 'already-claimed' } } : null
      ),
    });

    await h.coordinator.schedule('spool-main', 'main');

    expect(h.deliver).toHaveBeenCalledTimes(1);
    expect(h.deliver.mock.calls[0][0].updateId).toBe(2);
    expect(h.queue.ack.mock.calls.map(([, ids]) => ids[0])).toEqual([1, 2]);
    expect(h.log.info).toHaveBeenCalledWith(
      'Telegram',
      expect.stringContaining('Update 1 was already claimed')
    );
  });

  test('an ok:false receipt is an error report, not a gate on N+1', async () => {
    const h = makeHarness({
      records: [record(1), record(2)],
      deliver: async ({ updateId }) => (
        updateId === 1 ? { ok: false, status: 'pane_missing' } : { ok: true }
      ),
    });

    await h.coordinator.schedule('spool-main', 'main');

    expect(h.deliver.mock.calls.map(([job]) => job.updateId)).toEqual([1, 2]);
    expect(h.log.error).toHaveBeenCalledWith(
      'Telegram',
      expect.stringMatching(/Update 1 was NOT confirmed delivered.*queue continues/s)
    );
    expect(h.pending()).toEqual([]);
  });

  test('a thrown delivery is logged and retired without withholding N+1', async () => {
    const h = makeHarness({
      records: [record(1), record(2)],
      deliver: async ({ updateId }) => {
        if (updateId === 1) throw new Error('pane write exploded');
        return { ok: true };
      },
    });

    await h.coordinator.schedule('spool-main', 'main');

    expect(h.deliver.mock.calls.map(([job]) => job.updateId)).toEqual([1, 2]);
    expect(h.log.error).toHaveBeenCalledWith(
      'Telegram',
      expect.stringMatching(/Delivery threw for update 1.*next message still goes/s)
    );
    expect(h.pending()).toEqual([]);
  });

  test('an unresolved route is dropped loudly and does not block the next resolvable record', async () => {
    const h = makeHarness({
      records: [record(1, { chatId: 'missing' }), record(2)],
      resolveRoute: (chatId) => (
        chatId === 'missing'
          ? { ok: false, reason: 'route_not_found' }
          : { ok: true, profile: 'main', windowKey: 'main' }
      ),
    });

    await h.coordinator.schedule('spool-main', 'main');

    expect(h.deliver).toHaveBeenCalledTimes(1);
    expect(h.deliver.mock.calls[0][0].updateId).toBe(2);
    expect(h.log.error).toHaveBeenCalledWith(
      'Telegram',
      expect.stringMatching(/Dropping update 1.*route_not_found/s)
    );
    expect(h.pending()).toEqual([]);
  });

  test('an ack failure leaves only N pending and still processes N+1', async () => {
    const h = makeHarness({
      records: [record(1), record(2)],
      ack: ({ updateIds }) => (
        updateIds[0] === 1 ? { ok: false, acked: 0, reason: 'disk_busy' } : undefined
      ),
    });

    const result = await h.coordinator.schedule('spool-main', 'main');

    expect(h.deliver.mock.calls.map(([job]) => job.updateId)).toEqual([1, 2]);
    expect(h.queue.ack.mock.calls.map(([, ids]) => ids[0])).toEqual([1, 2]);
    expect(h.pending().map((item) => item.updateId)).toEqual([1]);
    expect(result.backlog.pendingCount).toBe(1);
    expect(result.backlog.oldestPendingUpdateId).toBe(1);
    expect(h.log.error).toHaveBeenCalledWith(
      'Telegram',
      expect.stringMatching(/could not retire update 1.*next message still goes/s)
    );
  });

  test('a missing activation mode remains visible in health but cannot gate delivery', async () => {
    const h = makeHarness({ records: [record(1)], activationMode: () => null });

    const result = await h.coordinator.schedule('spool-main', 'main');

    expect(h.deliver).toHaveBeenCalledTimes(1);
    expect(result.backlog).toEqual(expect.objectContaining({
      pendingCount: 0,
      activationModeHealthy: false,
      activationModeReason: 'activation_mode_missing',
    }));
  });
});

describe('Telegram ingress drain: concurrency and lifecycle', () => {
  test('concurrent schedules coalesce and never deliver the same pending record twice', async () => {
    const entered = deferred();
    const release = deferred();
    const h = makeHarness({
      records: [record(1)],
      deliver: async () => {
        entered.resolve();
        await release.promise;
        return { ok: true };
      },
    });

    const first = h.coordinator.schedule('spool-main', 'main');
    await entered.promise;
    const second = await h.coordinator.schedule('spool-main', 'main');
    expect(second).toEqual({ ok: true, coalesced: true });
    release.resolve();
    await first;

    expect(h.deliver).toHaveBeenCalledTimes(1);
    expect(h.queue.readPending).toHaveBeenCalledTimes(2);
    expect(h.pending()).toEqual([]);
  });

  test('dispose waits for N already in flight and prevents N+1 from starting', async () => {
    const entered = deferred();
    const release = deferred();
    const h = makeHarness({
      records: [record(1), record(2)],
      deliver: async ({ updateId }) => {
        if (updateId === 1) {
          entered.resolve();
          await release.promise;
        }
        return { ok: true };
      },
    });

    const draining = h.coordinator.schedule('spool-main', 'main');
    await entered.promise;
    const disposing = h.coordinator.dispose();
    release.resolve();
    await Promise.all([draining, disposing]);

    expect(h.deliver.mock.calls.map(([job]) => job.updateId)).toEqual([1]);
    expect(h.pending().map((item) => item.updateId)).toEqual([2]);
    await expect(h.coordinator.schedule('spool-main', 'main'))
      .resolves.toEqual({ ok: false, reason: 'coordinator_disposed' });
  });

  test('route discovery returns only safe direct children of the canonical spool root', () => {
    const h = makeHarness();
    const dataRoot = path.resolve('C:\\squidrun-test-data');

    const found = h.coordinator.discoverRouteDirs(
      dataRoot,
      () => ['main', 'scoped_1', '..', 'nested/child', 'bad space']
    );

    expect(found).toEqual({
      ok: true,
      routes: [
        { routeKey: 'main', dir: path.join(dataRoot, '.squidrun', 'runtime', 'telegram-inbound', 'main') },
        { routeKey: 'scoped_1', dir: path.join(dataRoot, '.squidrun', 'runtime', 'telegram-inbound', 'scoped_1') },
      ],
    });
  });
});
