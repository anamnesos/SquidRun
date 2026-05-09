'use strict';

const crypto = require('crypto');

const LEASE_DURATION_MS = 15000;
const HEARTBEAT_MS = 5000;
const GRACE_MS = 2000;
const REGISTRATION_TOKEN_TTL_MS = 6 * 60 * 60 * 1000;
const UNACK_GRACE_MS = 10000;
const SERVED_ROW_RETENTION_MS = 60000;
const MAX_REGISTERED_CONSUMERS = 16;
const MAX_CONSUMER_ID_LENGTH = 128;
const ACTIVITY_RECENCY_WINDOW_MS = 30000;
const ACTIVITY_TIE_TOLERANCE_MS = 1000;
const ACTIVITY_FUTURE_CLOCK_SKEW_TOLERANCE_MS = 100;
const CONSUMER_ID_PATTERN = /^[\x21-\x7e]{1,128}$/;
const VALID_CONSUMER_KINDS = Object.freeze(['desktop-tab', 'phone-client', 'arbitrary']);
const KIND_PRECEDENCE = Object.freeze({
  'desktop-tab': 3,
  'phone-client': 2,
  'arbitrary': 1,
});

function assertConsumerIdShape(consumerId) {
  if (consumerId === null || consumerId === undefined) {
    return { ok: false, reason: 'consumer_id_required' };
  }
  if (typeof consumerId !== 'string') {
    return { ok: false, reason: 'consumer_id_required' };
  }
  const trimmed = consumerId.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: 'consumer_id_required' };
  }
  if (trimmed.length > MAX_CONSUMER_ID_LENGTH) {
    return { ok: false, reason: 'consumer_id_too_long' };
  }
  if (!CONSUMER_ID_PATTERN.test(trimmed)) {
    return { ok: false, reason: 'consumer_id_invalid_chars' };
  }
  return { ok: true, consumerId: trimmed };
}

function normalizeConsumerKind(consumerKind) {
  if (typeof consumerKind !== 'string') return 'arbitrary';
  const trimmed = consumerKind.trim();
  return VALID_CONSUMER_KINDS.includes(trimmed) ? trimmed : 'arbitrary';
}

function makeLeaseId() {
  return `lease-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
}

function makeRegistrationToken() {
  return `reg-${Date.now()}-${crypto.randomBytes(12).toString('hex')}`;
}

function kindPrecedence(consumerKind) {
  const normalized = normalizeConsumerKind(consumerKind);
  return KIND_PRECEDENCE[normalized] || 0;
}

function compareTieBreak({
  challengerKind,
  holderKind,
  challengerActivityMs,
  holderActivityMs,
  nowMs,
}) {
  const cActivity = Number(challengerActivityMs || 0);
  const hActivity = Number(holderActivityMs || 0);
  const cRecent = cActivity > 0 && nowMs - cActivity <= ACTIVITY_RECENCY_WINDOW_MS;
  const hRecent = hActivity > 0 && nowMs - hActivity <= ACTIVITY_RECENCY_WINDOW_MS;
  if (cRecent && !hRecent) return { winner: 'challenger', reason: 'activity_recency_only_challenger' };
  if (hRecent && !cRecent) return { winner: 'holder', reason: 'activity_recency_only_holder' };
  if (cRecent && hRecent) {
    const delta = cActivity - hActivity;
    if (delta > ACTIVITY_TIE_TOLERANCE_MS) return { winner: 'challenger', reason: 'activity_recency_newer' };
    if (delta < -ACTIVITY_TIE_TOLERANCE_MS) return { winner: 'holder', reason: 'activity_recency_newer' };
  }
  const challengerScore = kindPrecedence(challengerKind);
  const holderScore = kindPrecedence(holderKind);
  if (challengerScore > holderScore) return { winner: 'challenger', reason: 'kind_precedence' };
  if (challengerScore < holderScore) return { winner: 'holder', reason: 'kind_precedence' };
  return { winner: 'holder', reason: 'holder_default_fallback' };
}

function attemptAcquireLease({
  leaseState,
  registry = {},
  requestingConsumerId,
  requestingConsumerKind,
  lastUserActivityAtMs = 0,
  nowMs,
  leaseDurationMs = LEASE_DURATION_MS,
  graceMs = GRACE_MS,
  maxRegisteredConsumers = MAX_REGISTERED_CONSUMERS,
  acquireSeq = 0,
  leaseIdFactory = makeLeaseId,
} = {}) {
  const consumerCheck = assertConsumerIdShape(requestingConsumerId);
  if (!consumerCheck.ok) {
    return { ok: false, reason: consumerCheck.reason, leaseState, registry, acquireSeq };
  }
  const consumerId = consumerCheck.consumerId;
  const consumerKind = normalizeConsumerKind(requestingConsumerKind);
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const rawActivity = Number(lastUserActivityAtMs);
  let challengerActivityMs = 0;
  if (Number.isFinite(rawActivity) && rawActivity > 0) {
    if (rawActivity <= now + ACTIVITY_FUTURE_CLOCK_SKEW_TOLERANCE_MS) {
      challengerActivityMs = Math.min(rawActivity, now);
    }
  }

  let nextRegistry = { ...registry };
  if (!nextRegistry[consumerId]) {
    if (Object.keys(nextRegistry).length >= maxRegisteredConsumers) {
      return { ok: false, reason: 'consumer_registry_full', leaseState, registry, acquireSeq };
    }
    nextRegistry[consumerId] = {
      consumerKind,
      firstSeenAtMs: now,
      lastSeenAtMs: now,
      lastUserActivityAtMs: challengerActivityMs,
    };
  } else {
    nextRegistry[consumerId] = {
      ...nextRegistry[consumerId],
      consumerKind,
      lastSeenAtMs: now,
      lastUserActivityAtMs: Math.max(
        Number(nextRegistry[consumerId].lastUserActivityAtMs || 0),
        challengerActivityMs
      ),
    };
  }

  const effectiveExpiresAtMs = leaseState ? Number(leaseState.expiresAtMs || 0) : 0;
  const leaseExpired = !leaseState || now >= effectiveExpiresAtMs;
  const isHolder = Boolean(leaseState) && leaseState.consumerId === consumerId;

  if (!leaseExpired && !isHolder) {
    const holderRegistry = nextRegistry[leaseState.consumerId] || {};
    const tie = compareTieBreak({
      challengerKind: consumerKind,
      holderKind: leaseState.consumerKind,
      challengerActivityMs,
      holderActivityMs: Number(holderRegistry.lastUserActivityAtMs || 0),
      nowMs: now,
    });
    if (tie.winner === 'challenger') {
      const newSeq = acquireSeq + 1;
      const fresh = {
        consumerId,
        consumerKind,
        leaseId: leaseIdFactory(),
        acquiredAtMs: now,
        lastRenewedAtMs: now,
        expiresAtMs: now + leaseDurationMs + graceMs,
        acquireSeq: newSeq,
      };
      return {
        ok: true,
        leaseState: fresh,
        registry: nextRegistry,
        acquireSeq: newSeq,
        decision: 'preempt_by_priority',
        tieReason: tie.reason,
      };
    }
    return {
      ok: false,
      reason: 'lease_held_by_priority_other',
      currentHolder: leaseState.consumerId,
      expiresAtMs: effectiveExpiresAtMs,
      leaseState,
      registry: nextRegistry,
      acquireSeq,
      tieReason: tie.reason,
    };
  }

  const newSeq = acquireSeq + 1;
  if (isHolder && !leaseExpired) {
    const renewed = {
      ...leaseState,
      consumerKind,
      lastRenewedAtMs: now,
      expiresAtMs: now + leaseDurationMs + graceMs,
      acquireSeq: newSeq,
    };
    return {
      ok: true,
      leaseState: renewed,
      registry: nextRegistry,
      acquireSeq: newSeq,
      decision: 'renew',
    };
  }
  const fresh = {
    consumerId,
    consumerKind,
    leaseId: leaseIdFactory(),
    acquiredAtMs: now,
    lastRenewedAtMs: now,
    expiresAtMs: now + leaseDurationMs + graceMs,
    acquireSeq: newSeq,
  };
  return {
    ok: true,
    leaseState: fresh,
    registry: nextRegistry,
    acquireSeq: newSeq,
    decision: leaseState ? 'replace_expired' : 'fresh_acquire',
  };
}

function releaseLease({ leaseState, requestingConsumerId, requestingLeaseId }) {
  if (!leaseState) return { ok: true, leaseState: null, decision: 'no_lease' };
  if (leaseState.consumerId !== requestingConsumerId) {
    return { ok: false, reason: 'not_lease_holder', leaseState };
  }
  if (requestingLeaseId && leaseState.leaseId !== requestingLeaseId) {
    return { ok: false, reason: 'stale_lease_id', leaseState };
  }
  return { ok: true, leaseState: null, decision: 'released' };
}

function selectEgressForActiveLease({
  rows,
  leaseState,
  requestingConsumerId,
  multiOutputEnforced = false,
  nowMs,
} = {}) {
  if (!Array.isArray(rows)) return [];
  if (multiOutputEnforced === true) return rows.slice();
  if (!leaseState) return [];
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  if (now >= Number(leaseState.expiresAtMs || 0)) return [];
  if (leaseState.consumerId !== requestingConsumerId) return [];
  return rows.slice();
}

function filterServedEgressRows({
  rows,
  deliveredRows = {},
  consumerId,
  leaseId = null,
  multiOutputEnforced = false,
  unackGraceMs = UNACK_GRACE_MS,
  nowMs,
} = {}) {
  if (!Array.isArray(rows)) return { delivered: [], deliveredRows: { ...(deliveredRows || {}) } };
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const map = deliveredRows && typeof deliveredRows === 'object' ? { ...deliveredRows } : {};
  const out = [];
  for (const row of rows) {
    const messageId = row && (row.messageId || row.message_id) ? String(row.messageId || row.message_id) : null;
    if (!messageId) continue;
    if (multiOutputEnforced === true) {
      out.push(row);
      continue;
    }
    const prior = map[messageId];
    const deliveredAtMs = prior ? Number(prior.deliveredAtMs || 0) : 0;
    const inGrace = prior && now - deliveredAtMs < unackGraceMs;
    if (prior) {
      if (prior.acked) {
        continue;
      }
      if (prior.consumerId !== consumerId && inGrace) {
        continue;
      }
    }
    out.push(row);
    map[messageId] = {
      consumerId,
      leaseId,
      deliveredAtMs: now,
      acked: false,
    };
  }
  return { delivered: out, deliveredRows: map };
}

function markServedDeliveryAcked({ deliveredRows = {}, messageId, consumerId, leaseId, nowMs }) {
  const map = deliveredRows && typeof deliveredRows === 'object' ? { ...deliveredRows } : {};
  if (!messageId) return { deliveredRows: map, ok: false, reason: 'message_id_required' };
  const entry = map[messageId];
  if (!entry) {
    return { deliveredRows: map, ok: false, reason: 'no_served_record' };
  }
  if (entry.consumerId !== consumerId) {
    return { deliveredRows: map, ok: false, reason: 'served_consumer_mismatch' };
  }
  if (leaseId && entry.leaseId && entry.leaseId !== leaseId) {
    return { deliveredRows: map, ok: false, reason: 'served_lease_mismatch' };
  }
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  map[messageId] = { ...entry, acked: true, ackedAtMs: now };
  return { deliveredRows: map, ok: true };
}

function expireServedDeliveries({ deliveredRows = {}, nowMs, retentionMs = SERVED_ROW_RETENTION_MS }) {
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const next = {};
  for (const [messageId, entry] of Object.entries(deliveredRows || {})) {
    if (now - Number(entry.deliveredAtMs || 0) < retentionMs) {
      next[messageId] = entry;
    }
  }
  return next;
}

function validateSpokenAck({ leaseState, ack, nowMs }) {
  if (!ack || typeof ack !== 'object') {
    return { ok: false, reason: 'spoken_ack_required' };
  }
  const { consumerId, leaseId, messageId } = ack;
  if (!leaseState) return { ok: false, reason: 'no_active_lease' };
  if (leaseState.consumerId !== consumerId) {
    return { ok: false, reason: 'not_lease_holder' };
  }
  if (leaseState.leaseId !== leaseId) {
    return { ok: false, reason: 'stale_lease_id' };
  }
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  if (now >= Number(leaseState.expiresAtMs || 0)) {
    return { ok: false, reason: 'lease_expired' };
  }
  if (typeof messageId !== 'string' || messageId.trim().length === 0) {
    return { ok: false, reason: 'message_id_required' };
  }
  return { ok: true, messageId: messageId.trim() };
}

function recoverLeaseFromPersistence(persisted, nowMs) {
  if (!persisted || typeof persisted !== 'object') {
    return { leaseState: null, recoveredFromPersistence: false, reason: 'no_persisted_state' };
  }
  const requiredFields = ['consumerId', 'leaseId', 'acquiredAtMs', 'expiresAtMs'];
  for (const field of requiredFields) {
    if (persisted[field] === undefined || persisted[field] === null) {
      return { leaseState: null, recoveredFromPersistence: false, reason: 'persisted_lease_malformed' };
    }
  }
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const expiresAtMs = Number(persisted.expiresAtMs);
  if (!Number.isFinite(expiresAtMs) || now >= expiresAtMs) {
    return { leaseState: null, recoveredFromPersistence: false, reason: 'persisted_lease_expired' };
  }
  const consumerCheck = assertConsumerIdShape(persisted.consumerId);
  if (!consumerCheck.ok) {
    return { leaseState: null, recoveredFromPersistence: false, reason: 'persisted_consumer_id_invalid' };
  }
  return {
    leaseState: {
      consumerId: consumerCheck.consumerId,
      consumerKind: normalizeConsumerKind(persisted.consumerKind),
      leaseId: String(persisted.leaseId),
      acquiredAtMs: Number(persisted.acquiredAtMs),
      lastRenewedAtMs: Number(persisted.lastRenewedAtMs || persisted.acquiredAtMs),
      expiresAtMs,
      acquireSeq: Number(persisted.acquireSeq || 0),
    },
    recoveredFromPersistence: true,
    reason: null,
  };
}

function registerConsumer({
  registrations = {},
  consumerId,
  consumerKind,
  nowMs,
  ttlMs = REGISTRATION_TOKEN_TTL_MS,
  tokenFactory = makeRegistrationToken,
  maxRegisteredConsumers = MAX_REGISTERED_CONSUMERS,
} = {}) {
  const consumerCheck = assertConsumerIdShape(consumerId);
  if (!consumerCheck.ok) {
    return { ok: false, reason: consumerCheck.reason, registrations };
  }
  const normalizedId = consumerCheck.consumerId;
  const normalizedKind = normalizeConsumerKind(consumerKind);
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const next = { ...registrations };
  const existing = next[normalizedId];
  if (!existing && Object.keys(next).length >= maxRegisteredConsumers) {
    return { ok: false, reason: 'consumer_registry_full', registrations };
  }
  const registrationToken = tokenFactory();
  const expiresAtMs = now + ttlMs;
  next[normalizedId] = {
    consumerId: normalizedId,
    consumerKind: normalizedKind,
    registrationToken,
    registeredAtMs: now,
    expiresAtMs,
  };
  return {
    ok: true,
    registrations: next,
    registrationToken,
    registeredAtMs: now,
    expiresAtMs,
    consumerId: normalizedId,
    consumerKind: normalizedKind,
  };
}

function requireValidRegistration({ registrations = {}, consumerId, registrationToken, nowMs }) {
  if (!consumerId || typeof consumerId !== 'string') {
    return { ok: false, reason: 'consumer_id_required' };
  }
  if (!registrationToken || typeof registrationToken !== 'string') {
    return { ok: false, reason: 'registration_required' };
  }
  const entry = registrations[consumerId];
  if (!entry) return { ok: false, reason: 'registration_required' };
  if (entry.registrationToken !== registrationToken) {
    return { ok: false, reason: 'registration_token_invalid' };
  }
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  if (now >= Number(entry.expiresAtMs || 0)) {
    return { ok: false, reason: 'registration_expired' };
  }
  return { ok: true, registration: entry };
}

function expireRegistrations({ registrations = {}, nowMs }) {
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const next = {};
  for (const [id, entry] of Object.entries(registrations)) {
    if (Number(entry.expiresAtMs || 0) > now) next[id] = entry;
  }
  return next;
}

function isMultiOutputEnforced(env = process.env) {
  return env && env.SQUIDRUN_VOICE_MULTI_OUTPUT_ENABLED === '1';
}

module.exports = {
  LEASE_DURATION_MS,
  HEARTBEAT_MS,
  GRACE_MS,
  REGISTRATION_TOKEN_TTL_MS,
  MAX_REGISTERED_CONSUMERS,
  MAX_CONSUMER_ID_LENGTH,
  ACTIVITY_RECENCY_WINDOW_MS,
  ACTIVITY_TIE_TOLERANCE_MS,
  UNACK_GRACE_MS,
  SERVED_ROW_RETENTION_MS,
  VALID_CONSUMER_KINDS,
  KIND_PRECEDENCE,
  assertConsumerIdShape,
  normalizeConsumerKind,
  makeLeaseId,
  makeRegistrationToken,
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
};
