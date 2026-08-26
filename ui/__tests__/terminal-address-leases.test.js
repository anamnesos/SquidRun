'use strict';

const {
  TerminalAddressLeaseRegistry,
  normalizeDurableAddress,
} = require('../modules/terminal-address-leases');

function request(overrides = {}) {
  return {
    durableAddress: 'arm://qa/portal',
    paneId: 'qa-portal',
    owner: 'terminal-daemon',
    recoveryEvent: 'lease_check_on_spawn',
    sourceMessageId: 'qa-source-1',
    expectedResponseClass: 'arm.liveness.pong',
    ...overrides,
  };
}

describe('TerminalAddressLeaseRegistry', () => {
  test('normalizes durable addresses without accepting malformed values', () => {
    expect(normalizeDurableAddress(' ARM://QA/Portal ')).toBe('arm://qa/portal');
    expect(normalizeDurableAddress('x')).toBeNull();
    expect(normalizeDurableAddress('arm address with spaces')).toBeNull();
  });

  test('refuses a second live claim without replacing the original lease', () => {
    let leaseNumber = 0;
    const registry = new TerminalAddressLeaseRegistry({
      createLeaseId: () => `lease-${++leaseNumber}`,
      now: () => 10_000,
    });

    const first = registry.claim(request());
    expect(registry.activate(first.durableAddress, first.spawnLeaseId, { pid: 1234 }).ok).toBe(true);
    const second = registry.claim(request({ sourceMessageId: 'qa-source-2' }), {
      isLeaseAlive: () => true,
    });

    expect(first).toEqual(expect.objectContaining({ ok: true, spawnLeaseId: 'lease-1' }));
    expect(second).toEqual(expect.objectContaining({
      ok: false,
      status: 'refused',
      reason: 'address_lease_held',
      spawnLeaseId: 'lease-1',
    }));
    expect(registry.get('arm://qa/portal')).toEqual(expect.objectContaining({
      spawnLeaseId: 'lease-1',
      pid: 1234,
      status: 'active',
    }));
  });

  test('a real same-turn race has exactly one winner', async () => {
    let leaseNumber = 0;
    const registry = new TerminalAddressLeaseRegistry({
      createLeaseId: () => `lease-${++leaseNumber}`,
      now: () => 20_000,
    });

    const attempts = await Promise.all([
      Promise.resolve().then(() => registry.claim(request({ sourceMessageId: 'race-a' }))),
      Promise.resolve().then(() => registry.claim(request({ sourceMessageId: 'race-b' }))),
    ]);

    expect(attempts.filter((entry) => entry.ok)).toHaveLength(1);
    expect(attempts.filter((entry) => !entry.ok)).toEqual([
      expect.objectContaining({ reason: 'address_lease_held' }),
    ]);
    expect(registry.list()).toHaveLength(1);
  });

  test('external death releases the generation and a later claim gets a new lease', () => {
    let nowMs = 30_000;
    let leaseNumber = 0;
    const registry = new TerminalAddressLeaseRegistry({
      createLeaseId: () => `lease-${++leaseNumber}`,
      now: () => nowMs,
    });
    const first = registry.claim(request());
    registry.activate(first.durableAddress, first.spawnLeaseId, { pid: 2233 });

    nowMs += 100;
    const released = registry.release(first.durableAddress, first.spawnLeaseId, {
      reason: 'process_exit',
      recoveryEvent: 'pty_exit',
    });
    const next = registry.claim(request({ sourceMessageId: 'qa-source-2' }));

    expect(released).toEqual(expect.objectContaining({
      ok: true,
      lease: expect.objectContaining({
        spawnLeaseId: 'lease-1',
        releaseReason: 'process_exit',
        recoveryEvent: 'pty_exit',
      }),
    }));
    expect(next).toEqual(expect.objectContaining({ ok: true, spawnLeaseId: 'lease-2' }));
  });

  test('lease-check-on-spawn reclaims an unobservable stale holder without timers', () => {
    let leaseNumber = 0;
    const registry = new TerminalAddressLeaseRegistry({
      createLeaseId: () => `lease-${++leaseNumber}`,
      now: () => 40_000,
    });
    const first = registry.claim(request());
    registry.activate(first.durableAddress, first.spawnLeaseId, { pid: 3344 });

    const reclaimed = registry.claim(request({ sourceMessageId: 'qa-source-2' }), {
      isLeaseAlive: () => false,
    });

    expect(reclaimed).toEqual(expect.objectContaining({
      ok: true,
      status: 'reclaimed_and_claimed',
      spawnLeaseId: 'lease-2',
      reclaimedLease: expect.objectContaining({
        spawnLeaseId: 'lease-1',
        releaseReason: 'stale_lease_reclaimed',
        recoveryEvent: 'lease_check_on_spawn',
      }),
    }));
  });

  test('a stale release cannot clear a newer generation', () => {
    let leaseNumber = 0;
    const registry = new TerminalAddressLeaseRegistry({
      createLeaseId: () => `lease-${++leaseNumber}`,
    });
    const first = registry.claim(request());
    registry.release(first.durableAddress, first.spawnLeaseId, { reason: 'process_exit' });
    const second = registry.claim(request({ sourceMessageId: 'qa-source-2' }));

    expect(registry.release(second.durableAddress, first.spawnLeaseId)).toEqual(expect.objectContaining({
      ok: false,
      status: 'stale_generation',
      activeSpawnLeaseId: second.spawnLeaseId,
    }));
    expect(registry.get(second.durableAddress).spawnLeaseId).toBe(second.spawnLeaseId);
  });

  test('cannot activate a lease without a real process id', () => {
    const registry = new TerminalAddressLeaseRegistry({
      createLeaseId: () => 'lease-1',
    });
    const claimed = registry.claim(request());

    expect(registry.activate(claimed.durableAddress, claimed.spawnLeaseId, { pid: null })).toEqual(
      expect.objectContaining({
        ok: false,
        status: 'invalid',
        reason: 'pid_required',
      })
    );
    expect(registry.get(claimed.durableAddress)).toEqual(expect.objectContaining({
      status: 'claimed',
      pid: null,
    }));
  });
});
