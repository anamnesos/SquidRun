'use strict';

const {
  createPaneRestartArbiter,
} = require('../modules/main/pane-restart-arbiter');

function createWebContents(id) {
  return {
    id,
    isDestroyed: jest.fn(() => false),
    once: jest.fn(),
  };
}

describe('pane restart arbiter', () => {
  test('coalesces active and cooldown restarts per pane', () => {
    let now = 1000;
    const webContents = createWebContents(1);
    const arbiter = createPaneRestartArbiter({
      cooldownMs: 500,
      now: () => now,
      resolveOwner: () => ({
        ownerWindowKey: 'main',
        webContents,
        requiresWebContents: true,
      }),
    });

    const first = arbiter.begin({ paneId: '1', source: 'test', webContents });
    const activeDuplicate = arbiter.begin({ paneId: '1', source: 'duplicate', webContents });

    expect(first).toEqual(expect.objectContaining({ ok: true, granted: true, coalesced: false }));
    expect(activeDuplicate).toEqual(expect.objectContaining({
      ok: true,
      granted: false,
      coalesced: true,
      reason: 'restart_in_progress',
      activeClaimId: first.claim.claimId,
    }));

    expect(arbiter.complete({ paneId: '1', claimId: first.claim.claimId, webContents }))
      .toEqual(expect.objectContaining({ ok: true, completed: true, cooldownUntil: 1500 }));
    expect(arbiter.begin({ paneId: '1', source: 'cooldown', webContents }))
      .toEqual(expect.objectContaining({
        ok: true,
        granted: false,
        coalesced: true,
        reason: 'restart_cooldown_active',
      }));

    now = 1501;
    expect(arbiter.begin({ paneId: '1', source: 'after-cooldown', webContents }))
      .toEqual(expect.objectContaining({ ok: true, granted: true, coalesced: false }));
  });

  test('authorizes kill create spawn once and in order for a single claim', () => {
    const webContents = createWebContents(7);
    const arbiter = createPaneRestartArbiter({
      cooldownMs: 0,
      resolveOwner: () => ({
        ownerWindowKey: 'main',
        webContents,
        requiresWebContents: true,
      }),
    });
    const begin = arbiter.begin({ paneId: '2', source: 'manual', webContents });
    const claimId = begin.claim.claimId;

    expect(arbiter.authorizeOperation({
      paneId: '2',
      claimId,
      operation: 'spawn-claude',
      webContents,
    })).toEqual(expect.objectContaining({
      ok: false,
      reason: 'restart_operation_out_of_order',
      expectedOperation: 'pty-kill',
    }));

    expect(arbiter.authorizeOperation({ paneId: '2', claimId, operation: 'pty-kill', webContents }))
      .toEqual(expect.objectContaining({ ok: true, operation: 'pty-kill' }));
    expect(arbiter.authorizeOperation({ paneId: '2', claimId, operation: 'pty-kill', webContents }))
      .toEqual(expect.objectContaining({
        ok: false,
        reason: 'restart_operation_already_consumed',
        expectedOperation: 'pty-create',
      }));
    expect(arbiter.authorizeOperation({ paneId: '2', claimId, operation: 'pty-create', webContents }))
      .toEqual(expect.objectContaining({ ok: true, operation: 'pty-create' }));
    expect(arbiter.authorizeOperation({ paneId: '2', claimId, operation: 'spawn-claude', webContents }))
      .toEqual(expect.objectContaining({ ok: true, operation: 'spawn-claude' }));
    expect(arbiter.authorizeOperation({ paneId: '2', claimId, operation: 'spawn-claude', webContents }))
      .toEqual(expect.objectContaining({
        ok: false,
        reason: 'restart_operation_already_consumed',
      }));
  });

  test('rejects validation and completion from the wrong owner window', () => {
    const owner = createWebContents('owner');
    const other = createWebContents('other');
    const arbiter = createPaneRestartArbiter({
      cooldownMs: 0,
      resolveOwner: () => ({
        ownerWindowKey: 'main',
        webContents: owner,
        requiresWebContents: true,
      }),
    });
    const begin = arbiter.begin({ paneId: '3', source: 'manual', webContents: owner });
    const claimId = begin.claim.claimId;

    expect(arbiter.validate({ paneId: '3', claimId, webContents: other }))
      .toEqual(expect.objectContaining({
        ok: false,
        reason: 'restart_claim_sender_mismatch',
      }));
    expect(arbiter.complete({ paneId: '3', claimId, webContents: other }))
      .toEqual(expect.objectContaining({
        ok: false,
        completed: false,
        reason: 'restart_claim_sender_mismatch',
      }));
    expect(arbiter.complete({ paneId: '3', claimId, webContents: owner }))
      .toEqual(expect.objectContaining({ ok: true, completed: true }));
  });

  test('getActiveClaim reports the lease only while it is open', () => {
    const webContents = createWebContents('owner');
    const arbiter = createPaneRestartArbiter({
      cooldownMs: 0,
      resolveOwner: () => ({
        ownerWindowKey: 'main',
        webContents,
        requiresWebContents: true,
      }),
    });

    expect(arbiter.getActiveClaim('4')).toBeNull();
    expect(arbiter.getActiveClaim('')).toBeNull();

    const begin = arbiter.begin({ paneId: '4', source: 'manual', webContents });
    const claimId = begin.claim.claimId;

    expect(arbiter.getActiveClaim('4')).toEqual(expect.objectContaining({
      claimId,
      paneId: '4',
    }));
    expect(arbiter.getActiveClaim('5')).toBeNull();

    arbiter.complete({ paneId: '4', claimId, webContents });
    expect(arbiter.getActiveClaim('4')).toBeNull();
  });
});
