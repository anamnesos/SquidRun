'use strict';

const contract = require('../modules/voice-broker-lease-contract');

const {
  LEASE_DURATION_MS,
  GRACE_MS,
  ACTIVITY_RECENCY_WINDOW_MS,
  attemptAcquireLease,
  releaseLease,
  selectEgressForActiveLease,
  validateSpokenAck,
  recoverLeaseFromPersistence,
  registerConsumer,
  requireValidRegistration,
  expireRegistrations,
  assertConsumerIdShape,
  isMultiOutputEnforced,
} = contract;

function fixedLeaseIds() {
  let n = 0;
  return () => `lease-fixed-${++n}`;
}

function fixedTokens() {
  let n = 0;
  return () => `reg-fixed-${++n}`;
}

describe('voice-broker-lease-contract / consumerId shape', () => {
  test('rejects null, undefined, empty, whitespace, and overlong consumerId', () => {
    expect(assertConsumerIdShape(null).reason).toBe('consumer_id_required');
    expect(assertConsumerIdShape(undefined).reason).toBe('consumer_id_required');
    expect(assertConsumerIdShape('').reason).toBe('consumer_id_required');
    expect(assertConsumerIdShape('   ').reason).toBe('consumer_id_required');
    expect(assertConsumerIdShape('a'.repeat(129)).reason).toBe('consumer_id_too_long');
    expect(assertConsumerIdShape('bad space').reason).toBe('consumer_id_invalid_chars');
    expect(assertConsumerIdShape('valid-id-1').ok).toBe(true);
    expect(assertConsumerIdShape('  trims-ok  ').consumerId).toBe('trims-ok');
  });
});

describe('voice-broker-lease-contract / attemptAcquireLease', () => {
  test('fresh acquire from null lease grants a new lease', () => {
    const result = attemptAcquireLease({
      leaseState: null,
      registry: {},
      requestingConsumerId: 'desktop-A',
      requestingConsumerKind: 'desktop-tab',
      lastUserActivityAtMs: 1000,
      nowMs: 2000,
      leaseIdFactory: fixedLeaseIds(),
    });
    expect(result.ok).toBe(true);
    expect(result.decision).toBe('fresh_acquire');
    expect(result.leaseState.consumerId).toBe('desktop-A');
    expect(result.leaseState.consumerKind).toBe('desktop-tab');
    expect(result.leaseState.leaseId).toBe('lease-fixed-1');
    expect(result.leaseState.acquireSeq).toBe(1);
    expect(result.leaseState.expiresAtMs).toBe(2000 + LEASE_DURATION_MS + GRACE_MS);
    expect(result.registry['desktop-A'].firstSeenAtMs).toBe(2000);
  });

  test('holder repeating acquire renews and extends expiresAtMs', () => {
    const factory = fixedLeaseIds();
    const first = attemptAcquireLease({
      leaseState: null,
      registry: {},
      requestingConsumerId: 'desktop-A',
      requestingConsumerKind: 'desktop-tab',
      nowMs: 0,
      leaseIdFactory: factory,
      acquireSeq: 0,
    });
    const renew = attemptAcquireLease({
      leaseState: first.leaseState,
      registry: first.registry,
      requestingConsumerId: 'desktop-A',
      requestingConsumerKind: 'desktop-tab',
      nowMs: 4000,
      leaseIdFactory: factory,
      acquireSeq: first.acquireSeq,
    });
    expect(renew.ok).toBe(true);
    expect(renew.decision).toBe('renew');
    expect(renew.leaseState.leaseId).toBe(first.leaseState.leaseId);
    expect(renew.leaseState.expiresAtMs).toBe(4000 + LEASE_DURATION_MS + GRACE_MS);
    expect(renew.leaseState.acquireSeq).toBe(2);
  });

  test('expired lease can be replaced by any valid acquirer', () => {
    const factory = fixedLeaseIds();
    const first = attemptAcquireLease({
      leaseState: null,
      registry: {},
      requestingConsumerId: 'desktop-A',
      requestingConsumerKind: 'desktop-tab',
      nowMs: 0,
      leaseIdFactory: factory,
    });
    const second = attemptAcquireLease({
      leaseState: first.leaseState,
      registry: first.registry,
      requestingConsumerId: 'phone-A',
      requestingConsumerKind: 'phone-client',
      nowMs: first.leaseState.expiresAtMs + 1,
      leaseIdFactory: factory,
      acquireSeq: first.acquireSeq,
    });
    expect(second.ok).toBe(true);
    expect(second.decision).toBe('replace_expired');
    expect(second.leaseState.consumerId).toBe('phone-A');
    expect(second.leaseState.leaseId).not.toBe(first.leaseState.leaseId);
  });

  test('fresh phone activity beats idle desktop holder (activity outranks kind)', () => {
    const factory = fixedLeaseIds();
    const desktop = attemptAcquireLease({
      leaseState: null,
      registry: {},
      requestingConsumerId: 'desktop-A',
      requestingConsumerKind: 'desktop-tab',
      lastUserActivityAtMs: 0,
      nowMs: 0,
      leaseIdFactory: factory,
    });
    const phone = attemptAcquireLease({
      leaseState: desktop.leaseState,
      registry: desktop.registry,
      requestingConsumerId: 'phone-A',
      requestingConsumerKind: 'phone-client',
      lastUserActivityAtMs: 5000,
      nowMs: 5000,
      leaseIdFactory: factory,
      acquireSeq: desktop.acquireSeq,
    });
    expect(phone.ok).toBe(true);
    expect(phone.decision).toBe('preempt_by_priority');
    expect(phone.tieReason).toBe('activity_recency_only_challenger');
    expect(phone.leaseState.consumerId).toBe('phone-A');
  });

  test('desktop wins on kind when activity is tied (both idle)', () => {
    const factory = fixedLeaseIds();
    const phone = attemptAcquireLease({
      leaseState: null,
      registry: {},
      requestingConsumerId: 'phone-A',
      requestingConsumerKind: 'phone-client',
      lastUserActivityAtMs: 0,
      nowMs: ACTIVITY_RECENCY_WINDOW_MS + 10,
      leaseIdFactory: factory,
    });
    const desktop = attemptAcquireLease({
      leaseState: phone.leaseState,
      registry: phone.registry,
      requestingConsumerId: 'desktop-A',
      requestingConsumerKind: 'desktop-tab',
      lastUserActivityAtMs: 0,
      nowMs: ACTIVITY_RECENCY_WINDOW_MS + 11,
      leaseIdFactory: factory,
      acquireSeq: phone.acquireSeq,
    });
    expect(desktop.ok).toBe(true);
    expect(desktop.decision).toBe('preempt_by_priority');
    expect(desktop.tieReason).toBe('kind_precedence');
    expect(desktop.leaseState.consumerId).toBe('desktop-A');
  });

  test('lower kind is rejected against an idle higher-kind holder (no tie reject)', () => {
    const factory = fixedLeaseIds();
    const desktop = attemptAcquireLease({
      leaseState: null,
      registry: {},
      requestingConsumerId: 'desktop-A',
      requestingConsumerKind: 'desktop-tab',
      lastUserActivityAtMs: 0,
      nowMs: ACTIVITY_RECENCY_WINDOW_MS + 10,
      leaseIdFactory: factory,
    });
    const phone = attemptAcquireLease({
      leaseState: desktop.leaseState,
      registry: desktop.registry,
      requestingConsumerId: 'phone-A',
      requestingConsumerKind: 'phone-client',
      lastUserActivityAtMs: 0,
      nowMs: ACTIVITY_RECENCY_WINDOW_MS + 11,
      leaseIdFactory: factory,
      acquireSeq: desktop.acquireSeq,
    });
    expect(phone.ok).toBe(false);
    expect(phone.reason).toBe('lease_held_by_priority_other');
    expect(phone.tieReason).toBe('kind_precedence');
    expect(phone.currentHolder).toBe('desktop-A');
  });

  test('holder retains lease when activity AND kind both tie (deterministic holder-default)', () => {
    const factory = fixedLeaseIds();
    const a = attemptAcquireLease({
      leaseState: null,
      registry: {},
      requestingConsumerId: 'desktop-A',
      requestingConsumerKind: 'desktop-tab',
      lastUserActivityAtMs: 1500,
      nowMs: 2000,
      leaseIdFactory: factory,
    });
    const b = attemptAcquireLease({
      leaseState: a.leaseState,
      registry: a.registry,
      requestingConsumerId: 'desktop-B',
      requestingConsumerKind: 'desktop-tab',
      lastUserActivityAtMs: 1700,
      nowMs: 2000,
      leaseIdFactory: factory,
      acquireSeq: a.acquireSeq,
    });
    expect(b.ok).toBe(false);
    expect(b.reason).toBe('lease_held_by_priority_other');
    expect(b.tieReason).toBe('holder_default_fallback');
    expect(b.currentHolder).toBe('desktop-A');
  });

  test('lease renewal alone does not refresh user activity (heartbeat is not real activity)', () => {
    const factory = fixedLeaseIds();
    let registry = {};
    let acquireSeq = 0;
    const holder = attemptAcquireLease({
      leaseState: null,
      registry,
      requestingConsumerId: 'desktop-A',
      requestingConsumerKind: 'desktop-tab',
      lastUserActivityAtMs: 0,
      nowMs: 0,
      leaseIdFactory: factory,
      acquireSeq,
    });
    registry = holder.registry;
    acquireSeq = holder.acquireSeq;
    let lease = holder.leaseState;
    for (const t of [10000, 20000, 30000]) {
      const renew = attemptAcquireLease({
        leaseState: lease,
        registry,
        requestingConsumerId: 'desktop-A',
        requestingConsumerKind: 'desktop-tab',
        lastUserActivityAtMs: 0,
        nowMs: t,
        leaseIdFactory: factory,
        acquireSeq,
      });
      expect(renew.decision).toBe('renew');
      lease = renew.leaseState;
      registry = renew.registry;
      acquireSeq = renew.acquireSeq;
    }
    expect(Number(registry['desktop-A'].lastUserActivityAtMs)).toBe(0);
    const challenger = attemptAcquireLease({
      leaseState: lease,
      registry,
      requestingConsumerId: 'desktop-B',
      requestingConsumerKind: 'desktop-tab',
      lastUserActivityAtMs: 35000,
      nowMs: 35000,
      leaseIdFactory: factory,
      acquireSeq,
    });
    expect(challenger.ok).toBe(true);
    expect(challenger.decision).toBe('preempt_by_priority');
    expect(challenger.tieReason).toBe('activity_recency_only_challenger');
    expect(challenger.leaseState.consumerId).toBe('desktop-B');
  });

  test('real user activity events refresh holder and defeat challenger', () => {
    const factory = fixedLeaseIds();
    let registry = {};
    let acquireSeq = 0;
    const holder = attemptAcquireLease({
      leaseState: null,
      registry,
      requestingConsumerId: 'desktop-A',
      requestingConsumerKind: 'desktop-tab',
      lastUserActivityAtMs: 0,
      nowMs: 0,
      leaseIdFactory: factory,
      acquireSeq,
    });
    registry = holder.registry;
    acquireSeq = holder.acquireSeq;
    let lease = holder.leaseState;
    for (const t of [10000, 20000, 30000, 34000]) {
      const realActivity = t - 100;
      const renew = attemptAcquireLease({
        leaseState: lease,
        registry,
        requestingConsumerId: 'desktop-A',
        requestingConsumerKind: 'desktop-tab',
        lastUserActivityAtMs: realActivity,
        nowMs: t,
        leaseIdFactory: factory,
        acquireSeq,
      });
      expect(renew.decision).toBe('renew');
      lease = renew.leaseState;
      registry = renew.registry;
      acquireSeq = renew.acquireSeq;
    }
    expect(Number(registry['desktop-A'].lastUserActivityAtMs)).toBe(33900);
    const challenger = attemptAcquireLease({
      leaseState: lease,
      registry,
      requestingConsumerId: 'desktop-B',
      requestingConsumerKind: 'desktop-tab',
      lastUserActivityAtMs: 0,
      nowMs: 35000,
      leaseIdFactory: factory,
      acquireSeq,
    });
    expect(challenger.ok).toBe(false);
    expect(challenger.reason).toBe('lease_held_by_priority_other');
    expect(challenger.tieReason).toBe('activity_recency_only_holder');
    expect(challenger.currentHolder).toBe('desktop-A');
  });

  test('far-future activity is treated as idle and cannot win', () => {
    const factory = fixedLeaseIds();
    const holder = attemptAcquireLease({
      leaseState: null,
      registry: {},
      requestingConsumerId: 'desktop-A',
      requestingConsumerKind: 'desktop-tab',
      lastUserActivityAtMs: 5000,
      nowMs: 5000,
      leaseIdFactory: factory,
    });
    const challenger = attemptAcquireLease({
      leaseState: holder.leaseState,
      registry: holder.registry,
      requestingConsumerId: 'desktop-B',
      requestingConsumerKind: 'desktop-tab',
      lastUserActivityAtMs: 999999999,
      nowMs: 5000,
      leaseIdFactory: factory,
      acquireSeq: holder.acquireSeq,
    });
    expect(challenger.ok).toBe(false);
    expect(challenger.reason).toBe('lease_held_by_priority_other');
    expect(challenger.tieReason).toBe('activity_recency_only_holder');
    expect(challenger.registry['desktop-B'].lastUserActivityAtMs).toBe(0);
    expect(challenger.currentHolder).toBe('desktop-A');
  });

  test('small clock-skew future activity (within tolerance) is clamped to nowMs and counts as recent', () => {
    const factory = fixedLeaseIds();
    const holder = attemptAcquireLease({
      leaseState: null,
      registry: {},
      requestingConsumerId: 'desktop-A',
      requestingConsumerKind: 'desktop-tab',
      lastUserActivityAtMs: 0,
      nowMs: 5000,
      leaseIdFactory: factory,
    });
    const challenger = attemptAcquireLease({
      leaseState: holder.leaseState,
      registry: holder.registry,
      requestingConsumerId: 'desktop-B',
      requestingConsumerKind: 'desktop-tab',
      lastUserActivityAtMs: 5050,
      nowMs: 5000,
      leaseIdFactory: factory,
      acquireSeq: holder.acquireSeq,
    });
    expect(challenger.ok).toBe(true);
    expect(challenger.decision).toBe('preempt_by_priority');
    expect(challenger.tieReason).toBe('activity_recency_only_challenger');
    expect(challenger.registry['desktop-B'].lastUserActivityAtMs).toBe(5000);
  });

  test('negative or non-finite activity is treated as 0 (idle)', () => {
    const factory = fixedLeaseIds();
    const negative = attemptAcquireLease({
      leaseState: null,
      registry: {},
      requestingConsumerId: 'desktop-A',
      requestingConsumerKind: 'desktop-tab',
      lastUserActivityAtMs: -5000,
      nowMs: 1000,
      leaseIdFactory: factory,
    });
    expect(negative.ok).toBe(true);
    expect(negative.registry['desktop-A'].lastUserActivityAtMs).toBe(0);

    const nan = attemptAcquireLease({
      leaseState: null,
      registry: {},
      requestingConsumerId: 'desktop-B',
      requestingConsumerKind: 'desktop-tab',
      lastUserActivityAtMs: Number.NaN,
      nowMs: 1000,
      leaseIdFactory: factory,
    });
    expect(nan.ok).toBe(true);
    expect(nan.registry['desktop-B'].lastUserActivityAtMs).toBe(0);

    const string = attemptAcquireLease({
      leaseState: null,
      registry: {},
      requestingConsumerId: 'desktop-C',
      requestingConsumerKind: 'desktop-tab',
      lastUserActivityAtMs: 'not-a-number',
      nowMs: 1000,
      leaseIdFactory: factory,
    });
    expect(string.ok).toBe(true);
    expect(string.registry['desktop-C'].lastUserActivityAtMs).toBe(0);
  });

  test('no acquisition path returns priority_tie_unbreakable_retry_after', () => {
    const factory = fixedLeaseIds();
    const scenarios = [
      { aActivity: 1500, bActivity: 1700, nowMs: 2000 },
      { aActivity: 0, bActivity: 0, nowMs: ACTIVITY_RECENCY_WINDOW_MS + 1 },
      { aActivity: 5000, bActivity: 0, nowMs: 5000 },
      { aActivity: 0, bActivity: 5000, nowMs: 5000 },
    ];
    for (const s of scenarios) {
      const a = attemptAcquireLease({
        leaseState: null,
        registry: {},
        requestingConsumerId: 'desktop-A',
        requestingConsumerKind: 'desktop-tab',
        lastUserActivityAtMs: s.aActivity,
        nowMs: s.nowMs,
        leaseIdFactory: factory,
      });
      const b = attemptAcquireLease({
        leaseState: a.leaseState,
        registry: a.registry,
        requestingConsumerId: 'desktop-B',
        requestingConsumerKind: 'desktop-tab',
        lastUserActivityAtMs: s.bActivity,
        nowMs: s.nowMs,
        leaseIdFactory: factory,
        acquireSeq: a.acquireSeq,
      });
      expect(b.reason).not.toBe('priority_tie_unbreakable_retry_after');
    }
  });

  test('registry caps at maxRegisteredConsumers', () => {
    let registry = {};
    let acquireSeq = 0;
    const factory = fixedLeaseIds();
    const max = 3;
    let last = null;
    for (let i = 0; i < max; i++) {
      last = attemptAcquireLease({
        leaseState: null,
        registry,
        requestingConsumerId: `c-${i}`,
        requestingConsumerKind: 'arbitrary',
        nowMs: i,
        leaseIdFactory: factory,
        acquireSeq,
        maxRegisteredConsumers: max,
      });
      registry = last.registry;
      acquireSeq = last.acquireSeq;
    }
    const overflow = attemptAcquireLease({
      leaseState: null,
      registry,
      requestingConsumerId: 'c-overflow',
      requestingConsumerKind: 'arbitrary',
      nowMs: max + 1,
      leaseIdFactory: factory,
      acquireSeq,
      maxRegisteredConsumers: max,
    });
    expect(overflow.ok).toBe(false);
    expect(overflow.reason).toBe('consumer_registry_full');
  });

  test('rejects when consumerId is missing or empty', () => {
    const empty = attemptAcquireLease({
      leaseState: null,
      registry: {},
      requestingConsumerId: '',
      requestingConsumerKind: 'desktop-tab',
      nowMs: 0,
    });
    expect(empty.ok).toBe(false);
    expect(empty.reason).toBe('consumer_id_required');
  });
});

describe('voice-broker-lease-contract / releaseLease', () => {
  test('holder releases successfully', () => {
    const lease = { consumerId: 'A', leaseId: 'L1', expiresAtMs: 9999 };
    const r = releaseLease({ leaseState: lease, requestingConsumerId: 'A', requestingLeaseId: 'L1' });
    expect(r.ok).toBe(true);
    expect(r.leaseState).toBe(null);
  });

  test('non-holder release is rejected', () => {
    const lease = { consumerId: 'A', leaseId: 'L1', expiresAtMs: 9999 };
    const r = releaseLease({ leaseState: lease, requestingConsumerId: 'B', requestingLeaseId: 'L1' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('not_lease_holder');
  });

  test('stale leaseId is rejected', () => {
    const lease = { consumerId: 'A', leaseId: 'L1', expiresAtMs: 9999 };
    const r = releaseLease({ leaseState: lease, requestingConsumerId: 'A', requestingLeaseId: 'L-OLD' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('stale_lease_id');
  });
});

describe('voice-broker-lease-contract / selectEgressForActiveLease', () => {
  const rows = [{ messageId: 'm1' }, { messageId: 'm2' }];

  test('empty lease returns no rows', () => {
    expect(selectEgressForActiveLease({ rows, leaseState: null, requestingConsumerId: 'A', nowMs: 0 })).toEqual([]);
  });

  test('holder polling within window returns rows', () => {
    const lease = { consumerId: 'A', expiresAtMs: 100 };
    expect(selectEgressForActiveLease({ rows, leaseState: lease, requestingConsumerId: 'A', nowMs: 50 })).toEqual(rows);
  });

  test('non-holder polling returns no rows', () => {
    const lease = { consumerId: 'A', expiresAtMs: 100 };
    expect(selectEgressForActiveLease({ rows, leaseState: lease, requestingConsumerId: 'B', nowMs: 50 })).toEqual([]);
  });

  test('expired lease returns no rows even for holder', () => {
    const lease = { consumerId: 'A', expiresAtMs: 100 };
    expect(selectEgressForActiveLease({ rows, leaseState: lease, requestingConsumerId: 'A', nowMs: 200 })).toEqual([]);
  });

  test('multiOutputEnforced=true returns rows for any consumer regardless of lease', () => {
    expect(selectEgressForActiveLease({ rows, leaseState: null, requestingConsumerId: 'B', multiOutputEnforced: true, nowMs: 0 })).toEqual(rows);
  });
});

describe('voice-broker-lease-contract / filterServedEgressRows + markServedDeliveryAcked', () => {
  const { filterServedEgressRows, markServedDeliveryAcked, expireServedDeliveries, UNACK_GRACE_MS } = contract;
  const sampleRow = { messageId: 'm1', text: 'hello' };

  test('first delivery to consumer A passes through and records served entry', () => {
    const result = filterServedEgressRows({
      rows: [sampleRow],
      deliveredRows: {},
      consumerId: 'A',
      leaseId: 'L1',
      nowMs: 1000,
    });
    expect(result.delivered).toEqual([sampleRow]);
    expect(result.deliveredRows.m1).toEqual(expect.objectContaining({
      consumerId: 'A',
      leaseId: 'L1',
      deliveredAtMs: 1000,
      acked: false,
    }));
  });

  test('row already served to A is suppressed for B within unack grace window', () => {
    const deliveredRows = { m1: { consumerId: 'A', leaseId: 'L1', deliveredAtMs: 1000, acked: false } };
    const result = filterServedEgressRows({
      rows: [sampleRow],
      deliveredRows,
      consumerId: 'B',
      leaseId: 'L2',
      nowMs: 1000 + UNACK_GRACE_MS - 1,
    });
    expect(result.delivered).toEqual([]);
  });

  test('row served to A becomes available to B after unack grace expires', () => {
    const deliveredRows = { m1: { consumerId: 'A', leaseId: 'L1', deliveredAtMs: 1000, acked: false } };
    const result = filterServedEgressRows({
      rows: [sampleRow],
      deliveredRows,
      consumerId: 'B',
      leaseId: 'L2',
      nowMs: 1000 + UNACK_GRACE_MS + 1,
    });
    expect(result.delivered).toEqual([sampleRow]);
    expect(result.deliveredRows.m1.consumerId).toBe('B');
  });

  test('same consumer re-polling within grace gets the row again (idempotent for owner before ack)', () => {
    const deliveredRows = { m1: { consumerId: 'A', leaseId: 'L1', deliveredAtMs: 1000, acked: false } };
    const result = filterServedEgressRows({
      rows: [sampleRow],
      deliveredRows,
      consumerId: 'A',
      leaseId: 'L1',
      nowMs: 1500,
    });
    expect(result.delivered).toEqual([sampleRow]);
  });

  test('same consumer re-polling AFTER ack does NOT get the row again (already spoken)', () => {
    const deliveredRows = { m1: { consumerId: 'A', leaseId: 'L1', deliveredAtMs: 1000, acked: true, ackedAtMs: 1500 } };
    const result = filterServedEgressRows({
      rows: [sampleRow],
      deliveredRows,
      consumerId: 'A',
      leaseId: 'L1',
      nowMs: 2000,
    });
    expect(result.delivered).toEqual([]);
  });

  test('multiOutputEnforced bypasses suppression entirely', () => {
    const deliveredRows = { m1: { consumerId: 'A', leaseId: 'L1', deliveredAtMs: 1000, acked: false } };
    const result = filterServedEgressRows({
      rows: [sampleRow],
      deliveredRows,
      consumerId: 'B',
      leaseId: 'L2',
      multiOutputEnforced: true,
      nowMs: 1000 + 1,
    });
    expect(result.delivered).toEqual([sampleRow]);
  });

  test('acked delivery suppresses a different consumer for the entire retention window (already spoken)', () => {
    const deliveredRows = { m1: { consumerId: 'A', leaseId: 'L1', deliveredAtMs: 1000, acked: true, ackedAtMs: 1500 } };
    const inGrace = filterServedEgressRows({
      rows: [sampleRow],
      deliveredRows,
      consumerId: 'B',
      leaseId: 'L2',
      nowMs: 2000,
    });
    expect(inGrace.delivered).toEqual([]);
    const pastGrace = filterServedEgressRows({
      rows: [sampleRow],
      deliveredRows,
      consumerId: 'B',
      leaseId: 'L2',
      nowMs: 1000 + UNACK_GRACE_MS + 5000,
    });
    expect(pastGrace.delivered).toEqual([]);
  });

  test('only unacked + grace-expired prior delivery recovers to a different consumer', () => {
    const deliveredRows = { m1: { consumerId: 'A', leaseId: 'L1', deliveredAtMs: 1000, acked: false } };
    const recovered = filterServedEgressRows({
      rows: [sampleRow],
      deliveredRows,
      consumerId: 'B',
      leaseId: 'L2',
      nowMs: 1000 + UNACK_GRACE_MS + 1,
    });
    expect(recovered.delivered).toEqual([sampleRow]);
    expect(recovered.deliveredRows.m1.consumerId).toBe('B');
  });

  test('markServedDeliveryAcked records ack only when consumer + leaseId match', () => {
    const deliveredRows = { m1: { consumerId: 'A', leaseId: 'L1', deliveredAtMs: 1000, acked: false } };
    const okResult = markServedDeliveryAcked({ deliveredRows, messageId: 'm1', consumerId: 'A', leaseId: 'L1', nowMs: 1500 });
    expect(okResult.ok).toBe(true);
    expect(okResult.deliveredRows.m1.acked).toBe(true);

    const wrongConsumer = markServedDeliveryAcked({ deliveredRows, messageId: 'm1', consumerId: 'B', leaseId: 'L1', nowMs: 1500 });
    expect(wrongConsumer.ok).toBe(false);
    expect(wrongConsumer.reason).toBe('served_consumer_mismatch');

    const wrongLease = markServedDeliveryAcked({ deliveredRows, messageId: 'm1', consumerId: 'A', leaseId: 'L-OLD', nowMs: 1500 });
    expect(wrongLease.ok).toBe(false);
    expect(wrongLease.reason).toBe('served_lease_mismatch');

    const noEntry = markServedDeliveryAcked({ deliveredRows: {}, messageId: 'm1', consumerId: 'A', leaseId: 'L1', nowMs: 1500 });
    expect(noEntry.ok).toBe(false);
    expect(noEntry.reason).toBe('no_served_record');
  });

  test('expireServedDeliveries strips rows older than retention window', () => {
    const deliveredRows = {
      old: { consumerId: 'A', deliveredAtMs: 1000 },
      fresh: { consumerId: 'A', deliveredAtMs: 50000 },
    };
    const next = expireServedDeliveries({ deliveredRows, nowMs: 65000, retentionMs: 30000 });
    expect(next.fresh).toBeDefined();
    expect(next.old).toBeUndefined();
  });
});

describe('voice-broker-lease-contract / validateSpokenAck', () => {
  const lease = { consumerId: 'A', leaseId: 'L1', expiresAtMs: 100 };

  test('accepts matching consumer + leaseId + non-empty messageId', () => {
    expect(validateSpokenAck({
      leaseState: lease,
      ack: { consumerId: 'A', leaseId: 'L1', messageId: 'm1' },
      nowMs: 50,
    }).ok).toBe(true);
  });

  test('rejects when not lease holder', () => {
    expect(validateSpokenAck({ leaseState: lease, ack: { consumerId: 'B', leaseId: 'L1', messageId: 'm1' }, nowMs: 50 }).reason).toBe('not_lease_holder');
  });

  test('rejects stale leaseId', () => {
    expect(validateSpokenAck({ leaseState: lease, ack: { consumerId: 'A', leaseId: 'OLD', messageId: 'm1' }, nowMs: 50 }).reason).toBe('stale_lease_id');
  });

  test('rejects when lease expired', () => {
    expect(validateSpokenAck({ leaseState: lease, ack: { consumerId: 'A', leaseId: 'L1', messageId: 'm1' }, nowMs: 200 }).reason).toBe('lease_expired');
  });

  test('rejects empty messageId', () => {
    expect(validateSpokenAck({ leaseState: lease, ack: { consumerId: 'A', leaseId: 'L1', messageId: '' }, nowMs: 50 }).reason).toBe('message_id_required');
  });

  test('rejects when no active lease', () => {
    expect(validateSpokenAck({ leaseState: null, ack: { consumerId: 'A', leaseId: 'L1', messageId: 'm1' }, nowMs: 50 }).reason).toBe('no_active_lease');
  });
});

describe('voice-broker-lease-contract / recoverLeaseFromPersistence', () => {
  const persisted = {
    consumerId: 'desktop-A',
    consumerKind: 'desktop-tab',
    leaseId: 'lease-old',
    acquiredAtMs: 1000,
    lastRenewedAtMs: 1000,
    expiresAtMs: 5000,
    acquireSeq: 3,
  };

  test('recovers a still-valid persisted lease', () => {
    const r = recoverLeaseFromPersistence(persisted, 4000);
    expect(r.recoveredFromPersistence).toBe(true);
    expect(r.leaseState.consumerId).toBe('desktop-A');
    expect(r.leaseState.expiresAtMs).toBe(5000);
  });

  test('discards a persisted lease that has already expired', () => {
    const r = recoverLeaseFromPersistence(persisted, 6000);
    expect(r.leaseState).toBe(null);
    expect(r.reason).toBe('persisted_lease_expired');
  });

  test('discards malformed persisted state', () => {
    const r = recoverLeaseFromPersistence({ consumerId: 'A' }, 1000);
    expect(r.leaseState).toBe(null);
    expect(r.reason).toBe('persisted_lease_malformed');
  });

  test('discards non-object persisted state', () => {
    expect(recoverLeaseFromPersistence(null, 1).reason).toBe('no_persisted_state');
    expect(recoverLeaseFromPersistence(undefined, 1).reason).toBe('no_persisted_state');
    expect(recoverLeaseFromPersistence('not-json', 1).reason).toBe('no_persisted_state');
  });
});

describe('voice-broker-lease-contract / registerConsumer + requireValidRegistration', () => {
  test('register issues a token; requireValid passes for that token within TTL', () => {
    const reg = registerConsumer({
      registrations: {},
      consumerId: 'desktop-A',
      consumerKind: 'desktop-tab',
      nowMs: 0,
      ttlMs: 1000,
      tokenFactory: fixedTokens(),
    });
    expect(reg.ok).toBe(true);
    expect(reg.registrationToken).toBe('reg-fixed-1');
    expect(reg.expiresAtMs).toBe(1000);
    const valid = requireValidRegistration({
      registrations: reg.registrations,
      consumerId: 'desktop-A',
      registrationToken: reg.registrationToken,
      nowMs: 500,
    });
    expect(valid.ok).toBe(true);
  });

  test('requireValid rejects missing consumerId or token', () => {
    expect(requireValidRegistration({ registrations: {}, consumerId: '', registrationToken: 't', nowMs: 0 }).reason).toBe('consumer_id_required');
    expect(requireValidRegistration({ registrations: {}, consumerId: 'A', registrationToken: '', nowMs: 0 }).reason).toBe('registration_required');
  });

  test('requireValid rejects unknown consumer or wrong token', () => {
    const reg = registerConsumer({
      registrations: {},
      consumerId: 'A',
      consumerKind: 'arbitrary',
      nowMs: 0,
      tokenFactory: fixedTokens(),
    });
    expect(requireValidRegistration({ registrations: reg.registrations, consumerId: 'B', registrationToken: reg.registrationToken, nowMs: 0 }).reason).toBe('registration_required');
    expect(requireValidRegistration({ registrations: reg.registrations, consumerId: 'A', registrationToken: 'wrong', nowMs: 0 }).reason).toBe('registration_token_invalid');
  });

  test('requireValid rejects an expired registration', () => {
    const reg = registerConsumer({
      registrations: {},
      consumerId: 'A',
      consumerKind: 'arbitrary',
      nowMs: 0,
      ttlMs: 100,
      tokenFactory: fixedTokens(),
    });
    expect(requireValidRegistration({ registrations: reg.registrations, consumerId: 'A', registrationToken: reg.registrationToken, nowMs: 200 }).reason).toBe('registration_expired');
  });

  test('expireRegistrations strips expired entries', () => {
    const reg = registerConsumer({
      registrations: {},
      consumerId: 'A',
      consumerKind: 'arbitrary',
      nowMs: 0,
      ttlMs: 100,
      tokenFactory: fixedTokens(),
    });
    const after = expireRegistrations({ registrations: reg.registrations, nowMs: 500 });
    expect(after).toEqual({});
  });

  test('register rejects when registry is full', () => {
    let registrations = {};
    const factory = fixedTokens();
    for (let i = 0; i < 3; i++) {
      const r = registerConsumer({
        registrations,
        consumerId: `c-${i}`,
        consumerKind: 'arbitrary',
        nowMs: 0,
        ttlMs: 1000,
        tokenFactory: factory,
        maxRegisteredConsumers: 3,
      });
      registrations = r.registrations;
    }
    const overflow = registerConsumer({
      registrations,
      consumerId: 'c-overflow',
      consumerKind: 'arbitrary',
      nowMs: 0,
      ttlMs: 1000,
      tokenFactory: factory,
      maxRegisteredConsumers: 3,
    });
    expect(overflow.ok).toBe(false);
    expect(overflow.reason).toBe('consumer_registry_full');
  });
});

describe('voice-broker-lease-contract / isMultiOutputEnforced', () => {
  test('returns true only when env var equals "1"', () => {
    expect(isMultiOutputEnforced({ SQUIDRUN_VOICE_MULTI_OUTPUT_ENABLED: '1' })).toBe(true);
    expect(isMultiOutputEnforced({ SQUIDRUN_VOICE_MULTI_OUTPUT_ENABLED: '0' })).toBe(false);
    expect(isMultiOutputEnforced({ SQUIDRUN_VOICE_MULTI_OUTPUT_ENABLED: 'true' })).toBe(false);
    expect(isMultiOutputEnforced({})).toBe(false);
    expect(isMultiOutputEnforced()).toBe(false);
  });
});
