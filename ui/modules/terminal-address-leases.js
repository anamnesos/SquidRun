'use strict';

const crypto = require('crypto');

const ADDRESS_PATTERN = /^[a-z0-9][a-z0-9._:/-]{2,255}$/i;

function toText(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function normalizeDurableAddress(value) {
  const address = toText(value);
  if (!address || !ADDRESS_PATTERN.test(address)) return null;
  return address.toLowerCase();
}

function defaultLeaseIdFactory() {
  try {
    return crypto.randomUUID();
  } catch {
    return `lease-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

class TerminalAddressLeaseRegistry {
  constructor(options = {}) {
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.createLeaseId = typeof options.createLeaseId === 'function'
      ? options.createLeaseId
      : defaultLeaseIdFactory;
    this.leases = new Map();
  }

  get(address) {
    const normalized = normalizeDurableAddress(address);
    return normalized ? (this.leases.get(normalized) || null) : null;
  }

  list() {
    return Array.from(this.leases.values()).map((lease) => ({ ...lease }));
  }

  claim(input = {}, options = {}) {
    const durableAddress = normalizeDurableAddress(input.durableAddress || input.address);
    const paneId = toText(input.paneId);
    const owner = toText(input.owner);
    const recoveryEvent = toText(input.recoveryEvent);
    const sourceMessageId = toText(input.sourceMessageId);
    const expectedResponseClass = toText(input.expectedResponseClass);

    if (!durableAddress) return { ok: false, status: 'invalid', reason: 'durable_address_required' };
    if (!paneId) return { ok: false, status: 'invalid', reason: 'pane_id_required', durableAddress };
    if (!owner) return { ok: false, status: 'invalid', reason: 'owner_required', durableAddress };
    if (!recoveryEvent) return { ok: false, status: 'invalid', reason: 'recovery_event_required', durableAddress };
    if (!sourceMessageId) return { ok: false, status: 'invalid', reason: 'source_message_id_required', durableAddress };
    if (!expectedResponseClass) {
      return { ok: false, status: 'invalid', reason: 'expected_response_class_required', durableAddress };
    }

    const existing = this.leases.get(durableAddress) || null;
    const isLeaseAlive = typeof options.isLeaseAlive === 'function'
      ? options.isLeaseAlive
      : (lease) => lease.status === 'active' || lease.status === 'claimed';
    if (existing && isLeaseAlive(existing) === true) {
      return {
        ok: false,
        status: 'refused',
        reason: 'address_lease_held',
        durableAddress,
        spawnLeaseId: existing.spawnLeaseId,
        lease: { ...existing },
      };
    }

    const claimedAtMs = Number(this.now());
    const reclaimedLease = existing
      ? {
        ...existing,
        status: 'released',
        releaseReason: 'stale_lease_reclaimed',
        recoveryEvent: 'lease_check_on_spawn',
        releasedAtMs: claimedAtMs,
      }
      : null;
    const lease = {
      durableAddress,
      spawnLeaseId: String(this.createLeaseId()),
      paneId,
      owner,
      recoveryEvent,
      sourceMessageId,
      expectedResponseClass,
      status: 'claimed',
      pid: null,
      claimedAtMs,
      activatedAtMs: null,
      releasedAtMs: null,
      releaseReason: null,
    };
    this.leases.set(durableAddress, lease);
    return {
      ok: true,
      status: reclaimedLease ? 'reclaimed_and_claimed' : 'claimed',
      durableAddress,
      spawnLeaseId: lease.spawnLeaseId,
      lease: { ...lease },
      reclaimedLease,
    };
  }

  activate(address, spawnLeaseId, details = {}) {
    const durableAddress = normalizeDurableAddress(address);
    const lease = durableAddress ? this.leases.get(durableAddress) : null;
    if (!lease) return { ok: false, status: 'not_found', durableAddress };
    if (lease.spawnLeaseId !== toText(spawnLeaseId)) {
      return {
        ok: false,
        status: 'stale_generation',
        durableAddress,
        spawnLeaseId: toText(spawnLeaseId),
        activeSpawnLeaseId: lease.spawnLeaseId,
      };
    }
    const pid = details.pid === null || details.pid === undefined
      ? null
      : Number(details.pid);
    if (!Number.isInteger(pid) || pid <= 0) {
      return {
        ok: false,
        status: 'invalid',
        reason: 'pid_required',
        durableAddress,
        spawnLeaseId: lease.spawnLeaseId,
      };
    }
    const activatedAtMs = Number(this.now());
    lease.status = 'active';
    lease.pid = pid;
    lease.activatedAtMs = activatedAtMs;
    return { ok: true, status: 'active', lease: { ...lease } };
  }

  release(address, spawnLeaseId, details = {}) {
    const durableAddress = normalizeDurableAddress(address);
    const lease = durableAddress ? this.leases.get(durableAddress) : null;
    if (!lease) return { ok: false, status: 'not_found', durableAddress };
    if (lease.spawnLeaseId !== toText(spawnLeaseId)) {
      return {
        ok: false,
        status: 'stale_generation',
        durableAddress,
        spawnLeaseId: toText(spawnLeaseId),
        activeSpawnLeaseId: lease.spawnLeaseId,
      };
    }
    this.leases.delete(durableAddress);
    const released = {
      ...lease,
      status: 'released',
      releaseReason: toText(details.reason) || 'released',
      recoveryEvent: toText(details.recoveryEvent) || lease.recoveryEvent,
      releasedAtMs: Number(this.now()),
    };
    return { ok: true, status: 'released', lease: released };
  }
}

module.exports = {
  TerminalAddressLeaseRegistry,
  normalizeDurableAddress,
};
