'use strict';

/**
 * VERDICT LEDGER v0 contracts (Charter organ #2). The laws, pinned:
 * unsourced rejected · resolution immutable · corrections supersede ·
 * small-n applies to us · evidence expires visibly.
 */

const {
  createVerdict, credibility, resolveVerdict, supersedeVerdict, sweepExpired,
} = require('../modules/verdict-ledger');

const T0 = '2026-07-02T18:00:00.000Z';
const T1 = '2026-07-03T06:00:00.000Z';

function mk(over = {}) {
  return createVerdict({
    issuer: 'oracle', kind: 'gate', subject: 'wedge-phase2',
    statement: 'PASS WITH 4 CHANGES', evidence: '.squidrun/coord/oracle-gate-wedge-phase2.md',
    issuedAt: T0, ...over,
  });
}

describe('verdict ledger — the auditor audited', () => {
  test('unsourced verdicts are rejected: evidence is not optional', () => {
    expect(() => mk({ evidence: '' })).toThrow(/unsourced/);
    expect(() => mk({ evidence: '   ' })).toThrow(/unsourced/);
  });

  test('resolution is immutable: a second resolve throws, corrections supersede', () => {
    const v = mk();
    resolveVerdict(v, { status: 'held', resolver: 'architect', note: 'survived contact', resolvedAt: T1 });
    expect(v.outcome.status).toBe('held');
    expect(() => resolveVerdict(v, { status: 'failed', resolver: 'oracle', note: 'x', resolvedAt: T1 }))
      .toThrow(/immutable/);
    const correction = mk({ statement: 'corrected verdict', issuedAt: T1 });
    supersedeVerdict(v, correction);
    expect(v.outcome.status).toBe('superseded');
    expect(v.outcome.supersededBy).toBe(correction.id);
  });

  test('outcomes carry provenance too: resolver and note are required', () => {
    expect(() => resolveVerdict(mk(), { status: 'held', resolver: '', note: 'x', resolvedAt: T1 }))
      .toThrow(/resolver and note/);
    expect(() => resolveVerdict(mk(), { status: 'held', resolver: 'a', note: '', resolvedAt: T1 }))
      .toThrow(/resolver and note/);
  });

  test('pends is a first-class waiting state (wedge PASS pends on Charles)', () => {
    const v = mk({ pendsOn: 'charles-next-real-bid' });
    expect(v.outcome.status).toBe('pends');
    resolveVerdict(v, { status: 'held', resolver: 'oracle', note: 'bid landed inside band', resolvedAt: T1 });
    expect(v.outcome.status).toBe('held');
  });

  test('small-n applies to US: below 5 resolutions credibility is INSUFFICIENT, never a number', () => {
    const records = [mk(), mk({ statement: 's2' }), mk({ statement: 's3' })];
    records.forEach((r, i) => resolveVerdict(r, {
      status: 'held', resolver: 'architect', note: `r${i}`, resolvedAt: T1,
    }));
    const c = credibility(records, 'oracle');
    expect(c.status).toBe('insufficient');
    expect(c.accuracy).toBeNull();
    expect(c.resolved).toBe(3);
  });

  test('accuracy counts only resolved: held=1, mixed=0.5, open/pends/expired excluded', () => {
    const records = [];
    for (let i = 0; i < 4; i += 1) {
      const v = mk({ statement: `held-${i}` });
      resolveVerdict(v, { status: 'held', resolver: 'a', note: 'ok', resolvedAt: T1 });
      records.push(v);
    }
    const f = mk({ statement: 'failed-1' });
    resolveVerdict(f, { status: 'failed', resolver: 'a', note: 'regressed', resolvedAt: T1 });
    records.push(f);
    const m = mk({ statement: 'mixed-1' });
    resolveVerdict(m, { status: 'mixed', resolver: 'a', note: 'partial', resolvedAt: T1 });
    records.push(m);
    records.push(mk({ statement: 'still-open' })); // must not count
    const c = credibility(records, 'oracle');
    expect(c.status).toBe('scored');
    expect(c.resolved).toBe(6);
    expect(c.open).toBe(1);
    expect(c.accuracy).toBeCloseTo((4 + 0.5) / 6, 10);
  });

  test('evidence expires VISIBLY: unresolved past expiresAt sweeps to expired, excluded from accuracy', () => {
    const v = mk({ statement: 'will-expire', expiresAt: '2026-07-03T00:00:00.000Z' });
    const kept = mk({ statement: 'no-expiry' });
    const swept = sweepExpired([v, kept], T1);
    expect(swept).toBe(1);
    expect(v.outcome.status).toBe('expired');
    expect(kept.outcome.status).toBe('open');
    const c = credibility([v, kept], 'oracle');
    expect(c.expired).toBe(1);
  });
});
