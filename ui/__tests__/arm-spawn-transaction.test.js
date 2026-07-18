'use strict';

const {
  ARM_SPAWN_TRANSACTION_SCHEMA,
  buildArmDurableAddress,
  spawnArmWithAtomicSession,
} = require('../modules/main/arm-spawn-transaction');

function baseInput(overrides = {}) {
  return {
    workspacePath: 'D:\\qa\\trustquote-test-copy',
    profileName: 'build-1a-qa',
    appRoomId: 'trustquote-qa',
    armKey: 'dev-qa',
    paneId: 'trustquote-dev-qa',
    role: 'trustquote-dev-qa',
    owner: 'terminal-daemon',
    recoveryEvent: 'lease_check_on_spawn',
    sourceMessageId: 'qa-liveness-ping-1',
    expectedResponseClass: 'arm.liveness.pong',
    mainSessionId: 'app-session-qa-1',
    dryRun: true,
    ...overrides,
  };
}

function successFor(request, overrides = {}) {
  const spawnLeaseId = overrides.spawnLeaseId || 'lease-qa-1';
  const pid = overrides.pid || 4321;
  return {
    ok: true,
    status: 'spawned',
    durableAddress: request.durableAddress,
    spawnLeaseId,
    terminal: {
      paneId: request.paneId,
      pid,
      alive: true,
      dryRun: true,
      durableAddress: request.durableAddress,
      spawnLeaseId,
      ...overrides.terminal,
    },
    receipt: {
      schema: 'squidrun.arm_spawn_receipt.v0',
      eventClass: 'arm.spawn.started',
      status: 'spawned',
      reason: null,
      sourceMessageId: request.sourceMessageId,
      expectedResponseClass: request.expectedResponseClass,
      durableAddress: request.durableAddress,
      spawnLeaseId,
      previousSpawnLeaseId: null,
      paneId: request.paneId,
      pid,
      owner: request.owner,
      recoveryEvent: request.recoveryEvent,
      atMs: 1_000,
      ...overrides.receipt,
    },
  };
}

describe('arm spawn transaction', () => {
  test('derives an app-restart-stable address without session identity', () => {
    const first = buildArmDurableAddress(baseInput({ mainSessionId: 'app-session-qa-1' }));
    const restarted = buildArmDurableAddress(baseInput({ mainSessionId: 'app-session-qa-2' }));
    const otherWorkspace = buildArmDurableAddress(baseInput({
      workspacePath: 'D:\\qa\\another-copy',
      mainSessionId: 'app-session-qa-2',
    }));

    expect(first).toMatch(/^arm:\/\/build-1a-qa\/[a-f0-9]{16}\/trustquote-qa\/dev-qa$/);
    expect(restarted).toBe(first);
    expect(otherWorkspace).not.toBe(first);
  });

  test('does not create a session when addressed daemon spawn is refused', async () => {
    const recordSession = jest.fn();
    const daemonClient = {
      spawnAddressed: jest.fn().mockResolvedValue({
        ok: false,
        status: 'refused',
        reason: 'address_lease_held',
      }),
      killAddressed: jest.fn(),
    };

    const result = await spawnArmWithAtomicSession(baseInput(), { daemonClient, recordSession });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: 'refused',
      reason: 'address_lease_held',
    }));
    expect(recordSession).not.toHaveBeenCalled();
    expect(daemonClient.killAddressed).not.toHaveBeenCalled();
  });

  test('persists only after a generation-correlated live spawn acknowledgment', async () => {
    const ordering = [];
    const daemonClient = {
      spawnAddressed: jest.fn().mockImplementation(async (request) => {
        ordering.push('spawned');
        return successFor(request);
      }),
      killAddressed: jest.fn(),
    };
    const recordSession = jest.fn().mockImplementation((entry) => {
      ordering.push('persisted');
      return {
        ok: true,
        status: 'inserted',
        session: {
          spawnSessionId: 'arm-spawn-session-1',
          durableAddress: entry.durableAddress,
          spawnLeaseId: entry.spawnLeaseId,
          status: 'active',
        },
      };
    });

    const result = await spawnArmWithAtomicSession(baseInput({
      env: {
        SQUIDRUN_ROLE: 'wrong-role',
        SQUIDRUN_PANE_ID: 'wrong-pane',
      },
    }), { daemonClient, recordSession });

    expect(ordering).toEqual(['spawned', 'persisted']);
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      status: 'spawned_and_registered',
      schema: ARM_SPAWN_TRANSACTION_SCHEMA,
      spawnLeaseId: 'lease-qa-1',
      session: expect.objectContaining({ status: 'active' }),
    }));
    expect(daemonClient.spawnAddressed).toHaveBeenCalledWith(expect.objectContaining({
      env: expect.objectContaining({
        SQUIDRUN_ROLE: 'trustquote-dev-qa',
        SQUIDRUN_PANE_ID: 'trustquote-dev-qa',
      }),
    }), {});
    expect(recordSession).toHaveBeenCalledWith(expect.objectContaining({
      schema: ARM_SPAWN_TRANSACTION_SCHEMA,
      owner: 'terminal-daemon',
      recoveryEvent: 'lease_check_on_spawn',
      sourceMessageId: 'qa-liveness-ping-1',
      expectedResponseClass: 'arm.liveness.pong',
      terminal: expect.objectContaining({ alive: true, pid: 4321 }),
    }), expect.any(Object));
    expect(daemonClient.killAddressed).not.toHaveBeenCalled();
  });

  test('kills the exact generation when session persistence fails', async () => {
    const daemonClient = {
      spawnAddressed: jest.fn().mockImplementation(async (request) => successFor(request)),
      killAddressed: jest.fn().mockResolvedValue({ ok: true, status: 'killed' }),
    };
    const recordSession = jest.fn().mockReturnValue({
      ok: false,
      status: 'db_error',
      reason: 'disk full',
    });

    const result = await spawnArmWithAtomicSession(baseInput(), { daemonClient, recordSession });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: 'registry_write_rolled_back',
      reason: 'disk full',
      spawnLeaseId: 'lease-qa-1',
      rollback: expect.objectContaining({ ok: true, status: 'killed' }),
    }));
    expect(daemonClient.killAddressed).toHaveBeenCalledWith(expect.objectContaining({
      durableAddress: result.durableAddress,
      spawnLeaseId: 'lease-qa-1',
      paneId: 'trustquote-dev-qa',
      reason: 'spawn_session_persist_failure',
    }));
  });

  test('rejects and tears down a live process whose receipt cannot be correlated', async () => {
    const daemonClient = {
      spawnAddressed: jest.fn().mockImplementation(async (request) => successFor(request, {
        receipt: { sourceMessageId: 'wrong-ping' },
      })),
      killAddressed: jest.fn().mockResolvedValue({ ok: true, status: 'killed' }),
    };
    const recordSession = jest.fn();

    const result = await spawnArmWithAtomicSession(baseInput(), { daemonClient, recordSession });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: 'invalid_spawn_ack',
      reason: 'receipt_source_message_mismatch',
      rollback: expect.objectContaining({ ok: true }),
    }));
    expect(recordSession).not.toHaveBeenCalled();
    expect(daemonClient.killAddressed).toHaveBeenCalledWith(expect.objectContaining({
      spawnLeaseId: 'lease-qa-1',
      reason: 'invalid_spawn_ack',
    }));
  });

  test('makes blame fields structurally invalid in the receipt contract', async () => {
    const daemonClient = {
      spawnAddressed: jest.fn().mockImplementation(async (request) => successFor(request, {
        receipt: { whoFailed: 'builder' },
      })),
      killAddressed: jest.fn().mockResolvedValue({ ok: true, status: 'killed' }),
    };

    const result = await spawnArmWithAtomicSession(baseInput(), {
      daemonClient,
      recordSession: jest.fn(),
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: 'invalid_spawn_ack',
      reason: 'blame_field_forbidden',
    }));
  });
});
