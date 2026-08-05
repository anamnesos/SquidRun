/**
 * The false-green tests. Each one describes a state the old health surface
 * scored 100/100 while James was hearing nothing.
 */
const {
  DEGRADED_HEAD_AGE_MS,
  CRITICAL_HEAD_AGE_MS,
  scoreBacklogHealth,
  scoreTelegramChannel,
} = require('../modules/main/telegram-backlog-health');

function snapshot(overrides = {}) {
  return {
    pendingCount: 0,
    oldestPendingUpdateId: null,
    oldestPendingAgeMs: null,
    oldestPendingAgeUnknown: false,
    blockedUpdateId: null,
    blockedReason: null,
    blockedFailureClass: null,
    proofUnattainable: false,
    attemptedCount: 0,
    lastRetirementAtMs: null,
    // v7 §3 Phase L. The default fixture is a channel in a state it can
    // operate in, so the existing scoring tests keep testing what they were
    // written to test; the mode's own cases set these explicitly below.
    activationMode: 'legacy_settlement',
    activationModeHealthy: true,
    activationModeReason: null,
    ...overrides,
  };
}

describe('backlog scoring', () => {
  test('AN EMPTY QUEUE is ok', () => {
    expect(scoreBacklogHealth(snapshot())).toMatchObject({ severity: 'ok', ok: true });
  });

  test('A YOUNG BACKLOG is ok — a busy pane is not an outage', () => {
    const result = scoreBacklogHealth(snapshot({
      pendingCount: 3,
      oldestPendingUpdateId: 808499317,
      oldestPendingAgeMs: 60_000,
    }));
    expect(result.severity).toBe('ok');
  });

  test('AN AGED HEAD degrades', () => {
    const result = scoreBacklogHealth(snapshot({
      pendingCount: 3,
      oldestPendingUpdateId: 808499317,
      oldestPendingAgeMs: DEGRADED_HEAD_AGE_MS,
    }));
    expect(result.severity).toBe('degraded');
    expect(result.reasons.join()).toContain('head_of_line_aged:808499317');
  });

  test('A LONG-AGED HEAD is critical', () => {
    const result = scoreBacklogHealth(snapshot({
      pendingCount: 6,
      oldestPendingUpdateId: 808499316,
      oldestPendingAgeMs: CRITICAL_HEAD_AGE_MS,
    }));
    expect(result.severity).toBe('critical');
    expect(result.ok).toBe(false);
  });

  test('THE ACTUAL S491 STATE scores critical, not 100/100', () => {
    // Six pending, head 8.6 hours old, blocked on proof that cannot arrive.
    const result = scoreBacklogHealth(snapshot({
      pendingCount: 6,
      oldestPendingUpdateId: 808499316,
      oldestPendingAgeMs: 8.6 * 60 * 60 * 1000,
      blockedUpdateId: 808499316,
      blockedReason: 'unprovable_pane:runtime_never_produced_proof',
      proofUnattainable: true,
    }));
    expect(result.severity).toBe('critical');
    expect(result.ok).toBe(false);
  });

  test('UNATTAINABLE PROOF is critical even when the head is BRAND NEW', () => {
    // Waiting cannot fix a pane runtime that has never written a receipt, so
    // the usual youth grace must not apply.
    const result = scoreBacklogHealth(snapshot({
      pendingCount: 1,
      oldestPendingUpdateId: 808499317,
      oldestPendingAgeMs: 1000,
      blockedReason: 'unprovable_pane:runtime_never_produced_proof',
      proofUnattainable: true,
    }));
    expect(result.severity).toBe('critical');
  });

  test('A BLOCKED BUT PROVABLE QUEUE degrades rather than screaming', () => {
    const result = scoreBacklogHealth(snapshot({
      pendingCount: 2,
      oldestPendingUpdateId: 808499317,
      oldestPendingAgeMs: 1000,
      blockedUpdateId: 808499317,
      blockedReason: 'unresolved_delivery_attempt:proof_time_unknown',
    }));
    expect(result.severity).toBe('degraded');
  });

  test('AN UNKNOWN HEAD AGE cannot score ok', () => {
    const result = scoreBacklogHealth(snapshot({
      pendingCount: 1,
      oldestPendingUpdateId: 808499317,
      oldestPendingAgeMs: null,
      oldestPendingAgeUnknown: true,
    }));
    expect(result.ok).toBe(false);
  });

  test('NO SNAPSHOT AT ALL is critical — silence is not health', () => {
    expect(scoreBacklogHealth(null).severity).toBe('critical');
    expect(scoreBacklogHealth(undefined).reasons).toContain('no_backlog_snapshot');
  });

  test('THRESHOLDS ARE INJECTABLE so the gate can be tightened without a rewrite', () => {
    const result = scoreBacklogHealth(
      snapshot({ pendingCount: 1, oldestPendingUpdateId: 1, oldestPendingAgeMs: 5000 }),
      { degradedAfterMs: 1000, criticalAfterMs: 4000 }
    );
    expect(result.severity).toBe('critical');
  });
});

describe('channel scoring — freshness may never buy a passing grade', () => {
  test('THE EXACT S491 FALSE GREEN: fresh poller + aged head is NOT ok', () => {
    const result = scoreTelegramChannel({
      pollerFresh: true,
      backlog: snapshot({
        pendingCount: 6,
        oldestPendingUpdateId: 808499316,
        oldestPendingAgeMs: 8.6 * 60 * 60 * 1000,
        blockedReason: 'unprovable_pane:runtime_never_produced_proof',
        proofUnattainable: true,
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.severity).toBe('critical');
    expect(result.pollerFresh).toBe(true);
  });

  test('A FRESH POLLER CANNOT LIFT a degraded backlog', () => {
    const degraded = snapshot({
      pendingCount: 2,
      oldestPendingUpdateId: 808499317,
      oldestPendingAgeMs: DEGRADED_HEAD_AGE_MS,
    });
    expect(scoreTelegramChannel({ pollerFresh: true, backlog: degraded }).severity).toBe('degraded');
    expect(scoreTelegramChannel({ pollerFresh: false, backlog: degraded }).severity).toBe('degraded');
  });

  test('A STALE POLLER still degrades a clean queue', () => {
    const result = scoreTelegramChannel({ pollerFresh: false, backlog: snapshot() });
    expect(result.severity).toBe('degraded');
    expect(result.reasons).toContain('poller_stale');
  });

  test('FRESH POLLER AND EMPTY QUEUE is the only way to score ok', () => {
    const result = scoreTelegramChannel({ pollerFresh: true, backlog: snapshot() });
    expect(result.ok).toBe(true);
    expect(result.severity).toBe('ok');
  });

  test('A MISSING BACKLOG cannot be rescued by a fresh poller', () => {
    const result = scoreTelegramChannel({ pollerFresh: true, backlog: null });
    expect(result.ok).toBe(false);
  });
});

describe('no default may resolve toward "fine" (Architect #60)', () => {
  test.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'seven'],
    ['NaN', NaN],
    ['negative', -1],
    ['an object', {}],
  ])('A MALFORMED pendingCount (%s) is CRITICAL, never coerced to a healthy zero', (_label, value) => {
    // `Number(x) || 0` turned every one of these into an early return with
    // severity ok - corrupt data producing a clean bill of health, inside the
    // module written to end exactly that.
    const result = scoreBacklogHealth(snapshot({ pendingCount: value }));
    expect(result.severity).toBe('critical');
    expect(result.ok).toBe(false);
  });

  test('A GENUINE ZERO is still ok — the fix must not break the healthy case', () => {
    expect(scoreBacklogHealth(snapshot({ pendingCount: 0 })).ok).toBe(true);
  });

  test.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'yes'],
    ['1', 1],
  ])('MISSING OR NON-BOOLEAN pollerFresh (%s) is UNKNOWN, never true', (_label, value) => {
    const result = scoreTelegramChannel({ pollerFresh: value, backlog: snapshot() });
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('poller_freshness_unknown');
    expect(result.pollerFresh).toBeNull();
  });

  test('AN EXPLICIT TRUE still passes a clean queue', () => {
    const result = scoreTelegramChannel({ pollerFresh: true, backlog: snapshot() });
    expect(result.ok).toBe(true);
    expect(result.pollerFresh).toBe(true);
  });
});

describe('bar 3 — pendingCount must be a non-negative SAFE INTEGER', () => {
  test.each([
    ['fractional 1.5', 1.5],
    ['fractional 0.5', 0.5],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['beyond safe integer range', Number.MAX_SAFE_INTEGER + 2],
  ])('%s is CRITICAL — a fractional queue depth is a broken producer, not a rounding error', (_label, value) => {
    const result = scoreBacklogHealth(snapshot({ pendingCount: value }));
    expect(result.severity).toBe('critical');
    expect(result.ok).toBe(false);
  });

  test('LEGITIMATE INTEGER COUNTS still score normally', () => {
    expect(scoreBacklogHealth(snapshot({ pendingCount: 0 })).ok).toBe(true);
    expect(scoreBacklogHealth(snapshot({
      pendingCount: 6, oldestPendingUpdateId: 1, oldestPendingAgeMs: 1000,
    })).severity).toBe('ok');
  });
});
