'use strict';

const {
  TerminalAddressLeaseRegistry,
  normalizeDurableAddress,
} = require('./terminal-address-leases');

const RECEIPT_SCHEMA = 'squidrun.arm_spawn_receipt.v0';

function toText(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function terminalMatchesLease(terminal, lease) {
  if (!terminal || terminal.alive !== true || !lease) return false;
  return terminal.durableAddress === lease.durableAddress
    && terminal.spawnLeaseId === lease.spawnLeaseId;
}

function buildReceipt(eventClass, input = {}) {
  const pid = input.pid === null || input.pid === undefined
    ? null
    : Number(input.pid);
  return {
    schema: RECEIPT_SCHEMA,
    eventClass,
    status: input.status || null,
    reason: input.reason || null,
    sourceMessageId: input.sourceMessageId || null,
    expectedResponseClass: input.expectedResponseClass || null,
    durableAddress: input.durableAddress || null,
    spawnLeaseId: input.spawnLeaseId || null,
    previousSpawnLeaseId: input.previousSpawnLeaseId || null,
    paneId: input.paneId || null,
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    owner: input.owner || null,
    recoveryEvent: input.recoveryEvent || null,
    atMs: Number.isFinite(Number(input.atMs)) ? Number(input.atMs) : Date.now(),
  };
}

class AddressedTerminalSpawnCoordinator {
  constructor(options = {}) {
    this.leases = options.leases || new TerminalAddressLeaseRegistry(options.leaseOptions);
    this.getTerminal = typeof options.getTerminal === 'function'
      ? options.getTerminal
      : () => null;
    this.spawnTerminal = typeof options.spawnTerminal === 'function'
      ? options.spawnTerminal
      : () => {
        throw new Error('spawn_terminal_unavailable');
      };
    this.killTerminal = typeof options.killTerminal === 'function'
      ? options.killTerminal
      : () => false;
    this.emitLifecycle = typeof options.emitLifecycle === 'function'
      ? options.emitLifecycle
      : () => {};
    this.now = typeof options.now === 'function' ? options.now : Date.now;
  }

  _emit(eventClass, receipt) {
    try {
      this.emitLifecycle(eventClass, receipt);
    } catch {
      // Lifecycle reporting must never strand or duplicate the owned process.
    }
  }

  _isLeaseAlive(lease) {
    return terminalMatchesLease(this.getTerminal(lease.paneId), lease);
  }

  _refusal(input, claim, reason, details = {}) {
    const receipt = buildReceipt('arm.spawn.refused', {
      ...input,
      ...details,
      status: 'refused',
      reason,
      spawnLeaseId: details.spawnLeaseId || claim?.spawnLeaseId || null,
      atMs: this.now(),
    });
    this._emit(receipt.eventClass, receipt);
    return {
      ok: false,
      status: 'refused',
      reason,
      durableAddress: receipt.durableAddress,
      spawnLeaseId: receipt.spawnLeaseId,
      receipt,
    };
  }

  spawn(input = {}) {
    const durableAddress = normalizeDurableAddress(input.durableAddress || input.address);
    const paneId = toText(input.paneId);
    const owner = toText(input.owner);
    const recoveryEvent = toText(input.recoveryEvent);
    const sourceMessageId = toText(input.sourceMessageId);
    const expectedResponseClass = toText(input.expectedResponseClass);
    const normalized = {
      durableAddress,
      paneId,
      owner,
      recoveryEvent,
      sourceMessageId,
      expectedResponseClass,
    };

    const claim = this.leases.claim(normalized, {
      isLeaseAlive: (lease) => this._isLeaseAlive(lease),
    });
    if (!claim.ok) {
      return this._refusal(normalized, claim, claim.reason || 'lease_claim_refused', {
        spawnLeaseId: claim.spawnLeaseId || null,
      });
    }

    const existingTerminal = this.getTerminal(paneId);
    if (existingTerminal?.alive === true) {
      this.leases.release(durableAddress, claim.spawnLeaseId, {
        reason: 'pane_terminal_held',
        recoveryEvent: 'lease_check_on_spawn',
      });
      return this._refusal(normalized, claim, 'pane_terminal_held', {
        spawnLeaseId: existingTerminal.spawnLeaseId || claim.spawnLeaseId,
        pid: existingTerminal.pid,
      });
    }

    let terminal;
    try {
      terminal = this.spawnTerminal(
        paneId,
        input.cwd,
        input.dryRun === true,
        {
          ...(input.options && typeof input.options === 'object' ? input.options : {}),
          mode: input.mode || input.options?.mode || null,
          env: input.env && typeof input.env === 'object' ? input.env : input.options?.env,
          durableAddress,
          spawnLeaseId: claim.spawnLeaseId,
          leaseOwner: owner,
          recoveryEvent,
          sourceMessageId,
          expectedResponseClass,
        }
      );
      if (!terminal || !Number.isInteger(Number(terminal.pid)) || Number(terminal.pid) <= 0) {
        throw new Error('spawn_terminal_missing_pid');
      }
    } catch (error) {
      const spawnedTerminal = terminal || this.getTerminal(paneId);
      if (spawnedTerminal) {
        try {
          this.killTerminal(paneId, {
            reason: 'spawn_failed',
            recoveryEvent: 'spawn_attempt',
          });
        } catch {
          // The lease still releases below; the daemon lifecycle event exposes leftovers.
        }
      }
      this.leases.release(durableAddress, claim.spawnLeaseId, {
        reason: 'spawn_failed',
        recoveryEvent: 'spawn_attempt',
      });
      return this._refusal(normalized, claim, 'spawn_failed', {
        spawnLeaseId: claim.spawnLeaseId,
        errorCode: toText(error?.code) || toText(error?.message),
      });
    }

    const activated = this.leases.activate(durableAddress, claim.spawnLeaseId, {
      pid: terminal.pid,
    });
    if (!activated.ok) {
      try {
        this.killTerminal(paneId, {
          reason: 'lease_activation_failed',
          recoveryEvent: 'spawn_attempt',
        });
      } catch {
        // The refusal receipt still makes activation failure visible.
      }
      this.leases.release(durableAddress, claim.spawnLeaseId, {
        reason: 'lease_activation_failed',
        recoveryEvent: 'spawn_attempt',
      });
      return this._refusal(normalized, claim, 'lease_activation_failed', {
        spawnLeaseId: claim.spawnLeaseId,
        pid: terminal.pid,
      });
    }

    const receipt = buildReceipt('arm.spawn.started', {
      ...normalized,
      status: 'spawned',
      spawnLeaseId: claim.spawnLeaseId,
      previousSpawnLeaseId: claim.reclaimedLease?.spawnLeaseId || null,
      pid: terminal.pid,
      atMs: this.now(),
    });
    this._emit(receipt.eventClass, receipt);
    return {
      ok: true,
      status: 'spawned',
      durableAddress,
      spawnLeaseId: claim.spawnLeaseId,
      terminal,
      lease: activated.lease,
      receipt,
    };
  }

  releaseTerminal(terminal = {}, details = {}) {
    const durableAddress = normalizeDurableAddress(terminal.durableAddress);
    const spawnLeaseId = toText(terminal.spawnLeaseId);
    if (!durableAddress || !spawnLeaseId) return null;

    const released = this.leases.release(durableAddress, spawnLeaseId, {
      reason: details.reason || 'process_exit',
      recoveryEvent: details.recoveryEvent || 'pty_exit',
    });
    if (!released.ok) return released;

    const receipt = buildReceipt('arm.spawn.released', {
      ...released.lease,
      status: 'released',
      reason: released.lease.releaseReason,
      pid: terminal.pid,
      atMs: this.now(),
    });
    this._emit(receipt.eventClass, receipt);
    return { ...released, receipt };
  }
}

module.exports = {
  AddressedTerminalSpawnCoordinator,
  RECEIPT_SCHEMA,
  buildReceipt,
  terminalMatchesLease,
};
