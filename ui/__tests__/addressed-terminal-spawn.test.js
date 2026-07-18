'use strict';

const { AddressedTerminalSpawnCoordinator } = require('../modules/addressed-terminal-spawn');
const { TerminalAddressLeaseRegistry } = require('../modules/terminal-address-leases');

function spawnRequest(overrides = {}) {
  return {
    durableAddress: 'arm://qa/portal',
    paneId: 'qa-portal',
    cwd: 'D:\\qa\\portal',
    owner: 'terminal-daemon',
    recoveryEvent: 'lease_check_on_spawn',
    sourceMessageId: 'ping-1',
    expectedResponseClass: 'arm.liveness.pong',
    options: { paneCommand: 'codex', spawnCommandOnCreate: true },
    ...overrides,
  };
}

function harness() {
  let leaseNumber = 0;
  let pidNumber = 4100;
  let nowMs = 50_000;
  const terminals = new Map();
  const lifecycle = [];
  const killTerminal = jest.fn((paneId) => terminals.delete(paneId));
  const spawnTerminal = jest.fn((paneId, cwd, dryRun, options) => {
    const terminal = {
      paneId,
      pid: ++pidNumber,
      alive: true,
      cwd,
      dryRun,
      durableAddress: options.durableAddress,
      spawnLeaseId: options.spawnLeaseId,
      owner: options.leaseOwner,
      recoveryEvent: options.recoveryEvent,
      sourceMessageId: options.sourceMessageId,
      expectedResponseClass: options.expectedResponseClass,
    };
    terminals.set(paneId, terminal);
    return terminal;
  });
  const coordinator = new AddressedTerminalSpawnCoordinator({
    leases: new TerminalAddressLeaseRegistry({
      createLeaseId: () => `lease-${++leaseNumber}`,
      now: () => nowMs,
    }),
    getTerminal: (paneId) => terminals.get(paneId) || null,
    spawnTerminal,
    killTerminal,
    emitLifecycle: (eventClass, receipt) => lifecycle.push({ eventClass, receipt }),
    now: () => nowMs,
  });
  return {
    coordinator,
    lifecycle,
    killTerminal,
    spawnTerminal,
    terminals,
    advance(ms = 1) { nowMs += ms; },
  };
}

describe('AddressedTerminalSpawnCoordinator', () => {
  test('claims then starts a daemon-owned terminal with the gate receipt fields', () => {
    const test = harness();

    const result = test.coordinator.spawn(spawnRequest());

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      status: 'spawned',
      durableAddress: 'arm://qa/portal',
      spawnLeaseId: 'lease-1',
      receipt: expect.objectContaining({
        eventClass: 'arm.spawn.started',
        sourceMessageId: 'ping-1',
        expectedResponseClass: 'arm.liveness.pong',
        durableAddress: 'arm://qa/portal',
        spawnLeaseId: 'lease-1',
        owner: 'terminal-daemon',
        recoveryEvent: 'lease_check_on_spawn',
      }),
    }));
    expect(result.receipt).not.toHaveProperty('whoFailed');
    expect(test.spawnTerminal).toHaveBeenCalledWith(
      'qa-portal',
      'D:\\qa\\portal',
      false,
      expect.objectContaining({
        durableAddress: 'arm://qa/portal',
        spawnLeaseId: 'lease-1',
        leaseOwner: 'terminal-daemon',
      })
    );
  });

  test('refuses a second spawn for the live address and leaves the original terminal alone', () => {
    const test = harness();
    const first = test.coordinator.spawn(spawnRequest());

    const second = test.coordinator.spawn(spawnRequest({ sourceMessageId: 'ping-2' }));

    expect(second).toEqual(expect.objectContaining({
      ok: false,
      status: 'refused',
      reason: 'address_lease_held',
      spawnLeaseId: first.spawnLeaseId,
    }));
    expect(test.spawnTerminal).toHaveBeenCalledTimes(1);
    expect(test.terminals.get('qa-portal').pid).toBe(first.terminal.pid);
  });

  test('same-turn contenders produce one process and one refusal receipt', async () => {
    const test = harness();

    const attempts = await Promise.all([
      Promise.resolve().then(() => test.coordinator.spawn(spawnRequest({ sourceMessageId: 'race-a' }))),
      Promise.resolve().then(() => test.coordinator.spawn(spawnRequest({ sourceMessageId: 'race-b' }))),
    ]);

    expect(attempts.filter((entry) => entry.ok)).toHaveLength(1);
    expect(attempts.filter((entry) => !entry.ok)).toEqual([
      expect.objectContaining({ reason: 'address_lease_held' }),
    ]);
    expect(test.spawnTerminal).toHaveBeenCalledTimes(1);
  });

  test('spawn failure releases the claim so the address can be retried', () => {
    const test = harness();
    test.spawnTerminal.mockImplementationOnce(() => {
      throw new Error('pty spawn failed');
    });

    const failed = test.coordinator.spawn(spawnRequest());
    const retried = test.coordinator.spawn(spawnRequest({ sourceMessageId: 'ping-2' }));

    expect(failed).toEqual(expect.objectContaining({ ok: false, reason: 'spawn_failed' }));
    expect(retried).toEqual(expect.objectContaining({ ok: true, spawnLeaseId: 'lease-2' }));
  });

  test('a partial spawn without a pid is killed before the address is retried', () => {
    const test = harness();
    test.spawnTerminal.mockImplementationOnce((paneId, cwd, dryRun, options) => {
      test.terminals.set(paneId, {
        paneId,
        pid: null,
        alive: true,
        cwd,
        dryRun,
        durableAddress: options.durableAddress,
        spawnLeaseId: options.spawnLeaseId,
      });
      return test.terminals.get(paneId);
    });

    const failed = test.coordinator.spawn(spawnRequest());
    const retried = test.coordinator.spawn(spawnRequest({ sourceMessageId: 'ping-2' }));

    expect(failed).toEqual(expect.objectContaining({ ok: false, reason: 'spawn_failed' }));
    expect(test.killTerminal).toHaveBeenCalledWith('qa-portal', expect.objectContaining({
      reason: 'spawn_failed',
    }));
    expect(retried).toEqual(expect.objectContaining({ ok: true, spawnLeaseId: 'lease-2' }));
  });

  test('external process death releases the generation and journals lifecycle', () => {
    const test = harness();
    const spawned = test.coordinator.spawn(spawnRequest());
    test.advance(100);

    const released = test.coordinator.releaseTerminal(spawned.terminal, {
      reason: 'process_exit',
      recoveryEvent: 'pty_exit',
    });
    test.terminals.delete('qa-portal');
    const replacement = test.coordinator.spawn(spawnRequest({ sourceMessageId: 'ping-2' }));

    expect(released).toEqual(expect.objectContaining({
      ok: true,
      receipt: expect.objectContaining({
        eventClass: 'arm.spawn.released',
        reason: 'process_exit',
        recoveryEvent: 'pty_exit',
        spawnLeaseId: 'lease-1',
      }),
    }));
    expect(replacement).toEqual(expect.objectContaining({ ok: true, spawnLeaseId: 'lease-2' }));
  });

  test('does not replace an unrelated live terminal that already owns the pane id', () => {
    const test = harness();
    test.terminals.set('qa-portal', {
      paneId: 'qa-portal',
      pid: 7001,
      alive: true,
      durableAddress: 'arm://qa/other',
      spawnLeaseId: 'other-lease',
    });

    const result = test.coordinator.spawn(spawnRequest());

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      reason: 'pane_terminal_held',
    }));
    expect(test.spawnTerminal).not.toHaveBeenCalled();
    expect(test.terminals.get('qa-portal').pid).toBe(7001);
  });
});
