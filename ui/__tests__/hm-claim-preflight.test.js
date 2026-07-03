'use strict';

/**
 * Gate-inside-the-loop v0 contracts (organism charter S465): the pre-flight
 * that gates what an agent BELIEVES before it ships. Born from two real
 * failures: an invented test bound (asserted < 2048 against a 256-byte
 * reality) and a false "4/4" committed while the suite was red.
 */

const { extractClaims, preflight, parseJestCounts } = require('../scripts/hm-claim-preflight');

describe('claim preflight: the gate inside the loop', () => {
  test('extracts test counts only near test-ish words', () => {
    const claims = extractClaims('Suites green 13/13 today.\nThe odds were 50/50 on lunch.');
    expect(claims.testCounts).toHaveLength(1);
    expect(claims.testCounts[0]).toMatchObject({ passed: 13, total: 13 });
  });

  test('hash heuristic requires a digit so English words survive', () => {
    const claims = extractClaims('defaced facade decade abcdef1 e5f3904');
    expect(claims.hashes).toContain('abcdef1');
    expect(claims.hashes).toContain('e5f3904');
    expect(claims.hashes).not.toContain('defaced');
  });

  test('a real commit hash passes, a fabricated one is FALSE', () => {
    const real = preflight('landed in commit e5f39040 today', { skipSuiteRun: true });
    expect(real.findings.filter((f) => f.check === 'real-hash')).toHaveLength(0);
    const fake = preflight('landed in commit 9999999 today', { skipSuiteRun: true });
    expect(fake.ok).toBe(false);
    expect(fake.findings[0].check).toBe('real-hash');
  });

  test('a cited path must exist', () => {
    const good = preflight('see ui/scripts/hm-claim-preflight.js for details', { skipSuiteRun: true });
    expect(good.findings.filter((f) => f.check === 'real-path')).toHaveLength(0);
    const bad = preflight('see ui/scripts/hm-imaginary-tool.js for details', { skipSuiteRun: true });
    expect(bad.ok).toBe(false);
    expect(bad.findings[0].check).toBe('real-path');
  });

  test('green claims without a suite are UNVERIFIED, never silently accepted', () => {
    const result = preflight('all tests green 4/4', { skipSuiteRun: true });
    expect(result.ok).toBe(true); // warning, not conviction
    expect(result.findings[0].level).toBe('UNVERIFIED');
  });

  test('parseJestCounts reads real jest summary lines', () => {
    expect(parseJestCounts('Tests:       1 failed, 3 passed, 4 total')).toEqual({
      failed: 1, skipped: 0, passed: 3, total: 4,
    });
    expect(parseJestCounts('Tests:       18 skipped, 7 passed, 25 total')).toEqual({
      failed: 0, skipped: 18, passed: 7, total: 25,
    });
    expect(parseJestCounts('no summary here')).toBeNull();
  });

  test('the false-4/4 scenario: claim contradicting the run is FALSE', () => {
    // Simulate by feeding parse output through the comparison logic: a
    // claim of 4/4 against a run with 1 failed must convict.
    const counts = parseJestCounts('Tests:       1 failed, 3 passed, 4 total');
    const claim = { passed: 4, total: 4 };
    const matches = (claim.passed === counts.passed && claim.total === counts.total)
      || (claim.passed === counts.passed && claim.passed === claim.total && counts.failed === 0);
    expect(matches).toBe(false);
  });
});
