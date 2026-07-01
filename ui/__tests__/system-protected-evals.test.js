'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  CASE_ID_ACCEPTED_UNVERIFIED_VISIBLE_DELIVERY,
  SYSTEM_PROTECTED_EVAL_SCHEMA_VERSION,
  buildSystemProtectedEvalRunPlan,
  runSystemProtectedEvals,
} = require('../modules/main/system-protected-evals');

const repoRoot = path.resolve(__dirname, '../..');

function readRel(relPath) {
  return fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
}

function defaultOverrides(overrides = {}) {
  return {
    'ui/scripts/hm-send.js': overrides.hmSend || readRel('ui/scripts/hm-send.js'),
    'ui/__tests__/hm-send.test.js': overrides.hmSendTest || readRel('ui/__tests__/hm-send.test.js'),
  };
}

function checkIds(report) {
  return report.cases.flatMap((evalCase) => evalCase.checks.map((check) => check.id));
}

function failedCheckIds(report) {
  return report.failures.map((failure) => failure.checkId);
}

describe('system protected evals', () => {
  test('registers Phase 4A accepted.unverified as a protected zero-fail eval with no side effects', () => {
    const report = runSystemProtectedEvals({
      caseIds: [CASE_ID_ACCEPTED_UNVERIFIED_VISIBLE_DELIVERY],
      generatedAt: '2026-06-30T00:00:00.000Z',
    });

    expect(report.ok).toBe(true);
    expect(report.schema).toBe(SYSTEM_PROTECTED_EVAL_SCHEMA_VERSION);
    expect(report.runner).toBe('squidrun_system_protected_eval_static_runner_v0');
    expect(report.mode).toBe('static_source_and_test_refs_only');
    expect(report.sideEffects).toEqual({
      runtime: false,
      network: false,
      writes: false,
      externalSends: false,
      restart: false,
    });
    expect(report.summary).toEqual(expect.objectContaining({
      caseCount: 1,
      protectedZeroFailCount: 1,
      passed: 1,
      failed: 0,
    }));
    expect(report.focusedCommands).toEqual(expect.arrayContaining([
      expect.stringContaining('hm-system-protected-evals.js --case phase4a.accepted_unverified_never_visible_delivery'),
      expect.stringContaining('hm-send.test.js'),
    ]));
    expect(checkIds(report)).toEqual(expect.arrayContaining([
      'accepted_unverified_visible_guard_before_flags',
      'accepted_unverified_status_requires_ledger_proof',
      'accepted_unverified_misleading_visible_flags_fixture',
      'test_ref_misleading_visible_flags_fail_closed',
    ]));
  });

  test('exposes source and focused hm-send test refs needed for future gates', () => {
    const plan = buildSystemProtectedEvalRunPlan({
      caseIds: [CASE_ID_ACCEPTED_UNVERIFIED_VISIBLE_DELIVERY],
    });
    const [evalCase] = plan.cases;

    expect(evalCase.id).toBe(CASE_ID_ACCEPTED_UNVERIFIED_VISIBLE_DELIVERY);
    expect(evalCase.sourceRefs.map((ref) => ref.id)).toEqual([
      'hm_send_visible_delivery_guard',
      'hm_send_unverified_requires_ledger_proof',
      'hm_send_websocket_requires_ledger_proof',
    ]);
    expect(evalCase.testRefs.map((ref) => ref.testName)).toEqual(expect.arrayContaining([
      'does not report accepted.unverified ack as visible delivery even with misleading visible flags',
      'accepts accepted-but-unverified ack only after ledger route proof confirms routed row',
      'fails closed without fallback when accepted-but-unverified delivery has no routed ledger row',
      'fails closed when ledger route proof is for the wrong session',
    ]));
    expect(evalCase.expectedRegressionFailures.map((failure) => failure.id)).toEqual([
      'accepted_unverified_visible_guard_removed',
      'unverified_status_no_longer_requires_ledger_proof',
      'misleading_visible_flags_test_removed',
    ]);
  });

  test('fails if accepted.unverified can reach visible-delivery flags before ledger proof', () => {
    const hmSend = readRel('ui/scripts/hm-send.js').replace(
      '  if (ackStatusRequiresLedgerRouteProof(status)) return false;\n',
      ''
    );
    const report = runSystemProtectedEvals({
      caseIds: [CASE_ID_ACCEPTED_UNVERIFIED_VISIBLE_DELIVERY],
      fileTextOverrides: defaultOverrides({ hmSend }),
    });

    expect(report.ok).toBe(false);
    expect(failedCheckIds(report)).toContain('accepted_unverified_visible_guard_before_flags');
    expect(failedCheckIds(report)).toContain('source_ref_hm_send_visible_delivery_guard');
  });

  test('fails if unverified ACK statuses no longer require ledger route proof', () => {
    const hmSend = readRel('ui/scripts/hm-send.js').replace(
      "    status.includes('unverified')\n",
      "    false\n"
    );
    const report = runSystemProtectedEvals({
      caseIds: [CASE_ID_ACCEPTED_UNVERIFIED_VISIBLE_DELIVERY],
      fileTextOverrides: defaultOverrides({ hmSend }),
    });

    expect(report.ok).toBe(false);
    expect(failedCheckIds(report)).toContain('accepted_unverified_status_requires_ledger_proof');
    expect(failedCheckIds(report)).toContain('source_ref_hm_send_unverified_requires_ledger_proof');
  });

  test('fails if the misleading accepted.unverified fixture is removed or renamed', () => {
    const hmSendTest = readRel('ui/__tests__/hm-send.test.js').replace(
      "does not report accepted.unverified ack as visible delivery even with misleading visible flags",
      'renamed accepted unverified fixture'
    );
    const report = runSystemProtectedEvals({
      caseIds: [CASE_ID_ACCEPTED_UNVERIFIED_VISIBLE_DELIVERY],
      fileTextOverrides: defaultOverrides({ hmSendTest }),
    });

    expect(report.ok).toBe(false);
    expect(failedCheckIds(report)).toContain('test_ref_misleading_visible_flags_fail_closed');
    expect(failedCheckIds(report)).toContain('accepted_unverified_misleading_visible_flags_fixture');
  });

  test('CLI prints reusable JSON and exits nonzero for missing cases', () => {
    const ok = spawnSync(
      process.execPath,
      ['ui/scripts/hm-system-protected-evals.js', '--case', CASE_ID_ACCEPTED_UNVERIFIED_VISIBLE_DELIVERY],
      { cwd: repoRoot, encoding: 'utf8' }
    );
    expect(ok.status).toBe(0);
    const payload = JSON.parse(ok.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.cases[0].id).toBe(CASE_ID_ACCEPTED_UNVERIFIED_VISIBLE_DELIVERY);
    expect(payload.sideEffects.externalSends).toBe(false);

    const missing = spawnSync(
      process.execPath,
      ['ui/scripts/hm-system-protected-evals.js', '--case', 'phase4a.missing_case'],
      { cwd: repoRoot, encoding: 'utf8' }
    );
    expect(missing.status).toBe(1);
    const missingPayload = JSON.parse(missing.stdout);
    expect(missingPayload.ok).toBe(false);
    expect(failedCheckIds(missingPayload)).toContain('missing_case_id');
  });
});
