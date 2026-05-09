'use strict';

const fs = require('fs');
const path = require('path');

const {
  attemptAcquireLease,
  releaseLease,
  selectEgressForActiveLease,
  filterServedEgressRows,
  markServedDeliveryAcked,
  expireServedDeliveries,
  validateSpokenAck,
  recoverLeaseFromPersistence,
  registerConsumer,
  requireValidRegistration,
  expireRegistrations,
  isMultiOutputEnforced,
  REGISTRATION_TOKEN_TTL_MS,
  LEASE_DURATION_MS,
  GRACE_MS,
} = require('./voice-broker-lease-contract');

class VoiceLeaseStore {
  constructor(options = {}) {
    this.persistencePath = options.persistencePath || null;
    this.env = options.env || process.env;
    this.now = options.nowFn || (() => Date.now());
    this.fsImpl = options.fsImpl || fs;
    this.leaseState = null;
    this.registry = {};
    this.registrations = {};
    this.acquireSeq = 0;
    this.spokenAcks = [];
    this.deliveredRows = {};
    this.recovered = false;
    this.recoveredFromPersistence = false;
  }

  ensureRecovered() {
    if (this.recovered) return;
    this.recovered = true;
    if (!this.persistencePath) return;
    let raw = null;
    try {
      raw = this.fsImpl.readFileSync(this.persistencePath, 'utf8');
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        this.lastRecoveryError = err.message;
      }
      return;
    }
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.lastRecoveryError = `parse_error:${err.message}`;
      return;
    }
    const recovered = recoverLeaseFromPersistence(parsed, this.now());
    if (recovered.leaseState) {
      this.leaseState = recovered.leaseState;
      this.recoveredFromPersistence = true;
      this.acquireSeq = Number(recovered.leaseState.acquireSeq || 0);
    }
  }

  persist() {
    if (!this.persistencePath) return;
    try {
      const dir = path.dirname(this.persistencePath);
      this.fsImpl.mkdirSync(dir, { recursive: true });
      const tmp = `${this.persistencePath}.${Date.now()}.tmp`;
      this.fsImpl.writeFileSync(tmp, JSON.stringify(this.leaseState || null), 'utf8');
      try {
        this.fsImpl.renameSync(tmp, this.persistencePath);
      } catch (err) {
        if (err && err.code === 'EEXIST') {
          this.fsImpl.unlinkSync(this.persistencePath);
          this.fsImpl.renameSync(tmp, this.persistencePath);
        } else {
          throw err;
        }
      }
    } catch (err) {
      this.lastPersistError = err.message;
    }
  }

  cleanupExpiredRegistrations() {
    const now = this.now();
    this.registrations = expireRegistrations({ registrations: this.registrations, nowMs: now });
  }

  register({ consumerId, consumerKind }) {
    this.ensureRecovered();
    this.cleanupExpiredRegistrations();
    const result = registerConsumer({
      registrations: this.registrations,
      consumerId,
      consumerKind,
      nowMs: this.now(),
      ttlMs: REGISTRATION_TOKEN_TTL_MS,
    });
    if (result.ok) {
      this.registrations = result.registrations;
    }
    return result;
  }

  authorize({ consumerId, registrationToken }) {
    this.ensureRecovered();
    this.cleanupExpiredRegistrations();
    return requireValidRegistration({
      registrations: this.registrations,
      consumerId,
      registrationToken,
      nowMs: this.now(),
    });
  }

  acquire({ consumerId, consumerKind, lastUserActivityAtMs }) {
    this.ensureRecovered();
    const result = attemptAcquireLease({
      leaseState: this.leaseState,
      registry: this.registry,
      requestingConsumerId: consumerId,
      requestingConsumerKind: consumerKind,
      lastUserActivityAtMs,
      nowMs: this.now(),
      acquireSeq: this.acquireSeq,
    });
    if (result.ok) {
      this.leaseState = result.leaseState;
      this.registry = result.registry;
      this.acquireSeq = result.acquireSeq;
      this.persist();
      return result;
    }
    this.registry = result.registry || this.registry;
    return result;
  }

  release({ consumerId, leaseId }) {
    this.ensureRecovered();
    const result = releaseLease({
      leaseState: this.leaseState,
      requestingConsumerId: consumerId,
      requestingLeaseId: leaseId,
    });
    if (result.ok) {
      this.leaseState = null;
      this.persist();
    }
    return result;
  }

  filterEgress({ rows, consumerId }) {
    this.ensureRecovered();
    const multi = isMultiOutputEnforced(this.env);
    const leasePermitted = selectEgressForActiveLease({
      rows,
      leaseState: this.leaseState,
      requestingConsumerId: consumerId,
      multiOutputEnforced: multi,
      nowMs: this.now(),
    });
    this.deliveredRows = expireServedDeliveries({ deliveredRows: this.deliveredRows, nowMs: this.now() });
    const served = filterServedEgressRows({
      rows: leasePermitted,
      deliveredRows: this.deliveredRows,
      consumerId,
      leaseId: this.leaseState?.leaseId || null,
      multiOutputEnforced: multi,
      nowMs: this.now(),
    });
    if (!multi) {
      this.deliveredRows = served.deliveredRows;
    }
    return served.delivered;
  }

  recordSpoken({ consumerId, leaseId, messageId }) {
    this.ensureRecovered();
    const result = validateSpokenAck({
      leaseState: this.leaseState,
      ack: { consumerId, leaseId, messageId },
      nowMs: this.now(),
    });
    if (result.ok) {
      this.spokenAcks.push({ consumerId, leaseId, messageId, recordedAtMs: this.now() });
      if (this.spokenAcks.length > 200) {
        this.spokenAcks.splice(0, this.spokenAcks.length - 200);
      }
      const ackResult = markServedDeliveryAcked({
        deliveredRows: this.deliveredRows,
        messageId,
        consumerId,
        leaseId,
        nowMs: this.now(),
      });
      if (ackResult.ok) {
        this.deliveredRows = ackResult.deliveredRows;
      }
    }
    return result;
  }

  getMeta() {
    this.ensureRecovered();
    return {
      lease_holder: this.leaseState ? this.leaseState.consumerId : null,
      lease_kind: this.leaseState ? this.leaseState.consumerKind : null,
      lease_expires_at_ms: this.leaseState ? this.leaseState.expiresAtMs : null,
      multi_output_enforced: isMultiOutputEnforced(this.env),
      acquire_seq: this.acquireSeq,
      recovered_from_persistence: this.recoveredFromPersistence,
    };
  }
}

module.exports = {
  VoiceLeaseStore,
  LEASE_DURATION_MS,
  GRACE_MS,
};
