const runtimeSliceContract = require('./fixtures/mira-core-runtime-slice-contract.json');
const {
  BASELINE_COMMIT,
  CANDIDATE_SLICE_ID,
  DEFAULT_BLOCKED_NOW_IDS,
  DEFAULT_FUTURE_ELIGIBILITY_IDS,
  DEFAULT_MISSING_GATE_IDS,
  DEFAULT_OUT_OF_SCOPE_IDS,
  DEFAULT_SAFE_FIRST_SLICE_CONSTRAINT_IDS,
  DEFAULT_TAMPER_CASE_IDS,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_REPORT_FIELDS,
  REQUIRED_SIDE_EFFECT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  RUNTIME_SLICE_CANDIDATE_REPORT_SCHEMA_VERSION,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreRuntimeSlice,
  runtimeSliceIdempotencyKey,
  validateMiraCoreRuntimeSliceOutput,
} = require('../modules/mira-core/runtime-slice');
const {
  main,
  parseArgs,
} = require('../scripts/hm-mira-core-runtime-slice');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function build(inputSignals = {}) {
  return buildMiraCoreRuntimeSlice({
    contract: runtimeSliceContract,
    inputSignals,
    nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
  });
}

function candidateReport(output) {
  return output.runtime_slice_candidate_report;
}

function validationReport(output) {
  return output.validation_report;
}

function expectRequiredFields(value, fields) {
  for (const field of fields) {
    expect(value).toHaveProperty(field);
  }
}

function expectNoForbiddenOutput(output) {
  expect(() => assertNoForbiddenOutput(output, runtimeSliceContract.forbiddenOutputSubstrings)).not.toThrow();
}

function expectValidatorFails(output, checkId) {
  const validation = validateMiraCoreRuntimeSliceOutput(output, runtimeSliceContract);
  expect(validation.ok).toBe(false);
  expect(validation.checks.find((entry) => entry.id === checkId)).toEqual(expect.objectContaining({ ok: false }));
}

function recomputeCandidateKey(output) {
  output.runtime_slice_candidate_report.idempotency_key = runtimeSliceIdempotencyKey(output.runtime_slice_candidate_report);
}

describe('mira core runtime slice candidate assessment v0', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('satisfies Oracle output, candidate report, and validation report shapes', () => {
    const output = build();
    const report = candidateReport(output);
    const validation = validationReport(output);

    expectRequiredFields(output, runtimeSliceContract.expectedOutputShape.requiredTopLevelFields);
    expect(runtimeSliceContract.expectedOutputShape.requiredTopLevelFields).toEqual(REQUIRED_OUTPUT_FIELDS);
    expect(report.schema).toBe(RUNTIME_SLICE_CANDIDATE_REPORT_SCHEMA_VERSION);
    expect(validation.schema).toBe(VALIDATION_REPORT_SCHEMA_VERSION);
    expectRequiredFields(report, runtimeSliceContract.expectedRuntimeSliceCandidateReportShape.requiredFields);
    expect(runtimeSliceContract.expectedRuntimeSliceCandidateReportShape.requiredFields).toEqual(REQUIRED_REPORT_FIELDS);
    expectRequiredFields(validation, runtimeSliceContract.expectedValidationReportShape.requiredFields);
    expect(runtimeSliceContract.expectedValidationReportShape.requiredFields).toEqual(REQUIRED_VALIDATION_REPORT_FIELDS);
    expect(validateMiraCoreRuntimeSliceOutput(output, runtimeSliceContract)).toEqual(expect.objectContaining({ ok: true }));
    expect(validation.decision).toBe('accepted');
    expectNoForbiddenOutput(output);
  });

  test('pins baseline and Phase 24 dependency to remain validation-only', () => {
    const report = candidateReport(build());
    const dependency = report.phase_24_dependency;
    const expected = runtimeSliceContract.expectedRuntimeSliceCandidateReportShape;

    expect(report.baseline_commit).toBe(BASELINE_COMMIT);
    expect(BASELINE_COMMIT).toBe(runtimeSliceContract.baseline.commit);
    expectRequiredFields(dependency, expected.phase24DependencyRequiredFields);
    expect(dependency).toEqual(expect.objectContaining(expected.phase24DependencyRequiredValues));
    expect(dependency.current_decision).toBe('remain_validation_only');
    expect(dependency.eligible_is_authorization).toBe(false);
    expect(dependency.runtime_started).toBe(false);
    expect(dependency.no_runtime_performed).toBe(true);
    expect(dependency.phase23_dependency_current_through_phase).toBe(22);
  });

  test('candidate identity is the safe local in-process status-only slice', () => {
    const identity = candidateReport(build()).candidate_slice_identity;
    const expected = runtimeSliceContract.expectedRuntimeSliceCandidateReportShape;

    expectRequiredFields(identity, expected.candidateSliceIdentityRequiredFields);
    expect(identity.slice_id).toBe(CANDIDATE_SLICE_ID);
    expect(identity.slice_id).toBe('runtime_slice_0_local_in_process_status_only');
    expect(identity.local_only).toBe(true);
    expect(identity.dev_only).toBe(true);
    expect(identity.disabled_by_default).toBe(true);
    expect(identity.operator_visible).toBe(true);
    expect(identity.read_only_status_control_plane_validation_only).toBe(true);
    expect(identity.runtime_available_now).toBe(false);
    expect(identity.allowed_future_request_count).toBe(1);
  });

  test('Phase 25 is explicitly non-authorizing and carries missing gates forward', () => {
    const report = candidateReport(build());
    const nonAuth = report.phase25_non_authorization;
    const expected = runtimeSliceContract.expectedRuntimeSliceCandidateReportShape;

    expectRequiredFields(nonAuth, expected.phase25NonAuthorizationRequiredFields);
    expect(nonAuth.does_not_satisfy_phase24_prerequisites).toBe(true);
    expect(nonAuth.does_not_authorize_runtime).toBe(true);
    expect(nonAuth.does_not_enable_runtime).toBe(true);
    expect(nonAuth.eligibility_is_future_review_only).toBe(true);
    expect(nonAuth.missing_gate_count).toBe(expected.requiredMissingGateIds.length);
    expect(report.missing_gates_carried_forward.map((gate) => gate.gate_id)).toEqual(DEFAULT_MISSING_GATE_IDS);
    expect(DEFAULT_MISSING_GATE_IDS).toEqual(expected.requiredMissingGateIds);
    expect(report.missing_gates_carried_forward).toHaveLength(20);
    for (const gate of report.missing_gates_carried_forward) {
      expectRequiredFields(gate, expected.missingGateRequiredFields);
      expect(gate.required_before_future_eligibility).toBe(true);
      expect(gate.blocks_runtime_now).toBe(true);
      expect(gate.reference_only).toBe(true);
    }
  });

  test('future eligibility, blocked-now, and out-of-scope checklists match the fixture', () => {
    const report = candidateReport(build());
    const expected = runtimeSliceContract.expectedRuntimeSliceCandidateReportShape;

    expect(report.future_eligibility_checklist.map((entry) => entry.check_id)).toEqual(DEFAULT_FUTURE_ELIGIBILITY_IDS);
    expect(DEFAULT_FUTURE_ELIGIBILITY_IDS).toEqual(expected.futureEligibilityChecklistRequiredIds);
    expect(report.future_eligibility_checklist).toHaveLength(12);
    expect(report.future_eligibility_checklist.every((entry) => entry.future_only && entry.non_authorizing && !entry.satisfied_now)).toBe(true);
    expect(report.blocked_now_checklist.map((entry) => entry.block_id)).toEqual(DEFAULT_BLOCKED_NOW_IDS);
    expect(DEFAULT_BLOCKED_NOW_IDS).toEqual(expected.blockedNowChecklistRequiredIds);
    expect(report.blocked_now_checklist).toHaveLength(8);
    expect(report.blocked_now_checklist.every((entry) => entry.blocked_now)).toBe(true);
    expect(report.out_of_scope_now.map((entry) => entry.scope_id)).toEqual(DEFAULT_OUT_OF_SCOPE_IDS);
    expect(DEFAULT_OUT_OF_SCOPE_IDS).toEqual(expected.outOfScopeNowRequiredIds);
    expect(report.out_of_scope_now).toHaveLength(9);
    expect(report.out_of_scope_now.every((entry) => entry.out_of_scope_now && !entry.allowed_in_phase25)).toBe(true);
  });

  test('proof boundaries, safe first-slice constraints, tamper coverage, and next actions are present', () => {
    const output = build();
    const report = candidateReport(output);
    const expected = runtimeSliceContract.expectedRuntimeSliceCandidateReportShape;
    const validation = validateMiraCoreRuntimeSliceOutput(output, runtimeSliceContract);

    expectRequiredFields(report.proof_boundaries, expected.proofBoundaryRequiredFields);
    expect(report.proof_boundaries.socket_is_bridge_green_proof).toBe(false);
    expect(report.proof_boundaries.delivery_acceptance_is_model_processing_proof).toBe(false);
    expect(report.proof_boundaries.runtime_candidate_is_runtime_proof).toBe(false);
    expect(report.proof_boundaries.server_can_execute_local_arms).toBe(false);
    expect(report.proof_boundaries.builder_direct_server_target_allowed).toBe(false);
    expect(report.proof_boundaries.oracle_direct_server_target_allowed).toBe(false);
    expect(report.safe_first_slice_constraints.map((entry) => entry.constraint_id)).toEqual(DEFAULT_SAFE_FIRST_SLICE_CONSTRAINT_IDS);
    expect(DEFAULT_SAFE_FIRST_SLICE_CONSTRAINT_IDS).toEqual(expected.safeFirstSliceConstraintRequiredIds);
    expect(report.tamper_case_coverage.map((entry) => entry.tamper_case_id)).toEqual(DEFAULT_TAMPER_CASE_IDS);
    expect(DEFAULT_TAMPER_CASE_IDS).toEqual(runtimeSliceContract.tamperCases.map((entry) => entry.id));
    expect(report.next_safe_actions.map((entry) => entry.action_id)).toEqual(expected.nextSafeActionRequiredIds);
    const checkIds = validation.checks.map((entry) => entry.id);
    for (const rule of runtimeSliceContract.staticValidationRules) {
      expect(checkIds).toContain(rule.id);
    }
    expect(validationReport(output).acceptance_checks.map((entry) => entry.id)).toEqual(runtimeSliceContract.acceptanceChecks.map((entry) => entry.id));
  });

  test('side-effect truth stays explicit and all counters remain zero', () => {
    const output = build();
    const report = candidateReport(output);
    const validation = validationReport(output);

    for (const field of REQUIRED_SIDE_EFFECT_FIELDS) {
      expect(report.side_effect_result[field]).toBe(true);
      expect(validation.side_effect_result[field]).toBe(true);
    }
    for (const field of [
      'runtimeAttempts',
      'serverAttempts',
      'listenerRouteAttempts',
      'networkRequestsAttempted',
      'databaseWritesAttempted',
      'storeWritesAttempted',
      'fileWritesAttempted',
      'migrationsAttempted',
      'queuesCreated',
      'leasesCreated',
      'authChangesAttempted',
      'keySecretOperationsAttempted',
      'localExecutionAttempted',
      'sendsAttempted',
      'deploysAttempted',
      'tradesAttempted',
      'outputFilesWritten',
    ]) {
      expect(report.side_effect_result[field]).toBe(0);
    }
    expect(report.side_effect_result.outputFileWritten).toBe(false);
    expect(validation.side_effect_result.outputFileWritten).toBe(false);
  });

  test('idempotency is stable for equivalent inputs and sensitive to candidate changes', () => {
    const first = candidateReport(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'VIGIL' }));
    const second = candidateReport(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'VIGIL' }));
    const changedDevice = candidateReport(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'ALT' }));

    expect(first.idempotency_key).toBe(second.idempotency_key);
    expect(first.candidate_report_id).toBe(second.candidate_report_id);
    expect(first.idempotency_key).not.toBe(changedDevice.idempotency_key);

    const tampered = clone(build());
    tampered.runtime_slice_candidate_report.candidate_slice_identity.disabled_by_default = false;
    recomputeCandidateKey(tampered);
    expect(validateMiraCoreRuntimeSliceOutput(tampered, runtimeSliceContract).checks.find((entry) => entry.id === 'idempotency-sensitive-to-candidate-gates')).toEqual(expect.objectContaining({ ok: true }));
    expectValidatorFails(tampered, 'candidate-identity-status-only');
  });

  test('validator rejects runtime availability and eligibility-as-authorization overclaims', () => {
    const availableNow = clone(build());
    availableNow.runtime_slice_candidate_report.candidate_slice_identity.runtime_available_now = true;
    recomputeCandidateKey(availableNow);
    expectValidatorFails(availableNow, 'candidate-identity-status-only');
    expectValidatorFails(availableNow, 'overclaiming-runtime-availability-rejected');

    const enabled = clone(build());
    enabled.runtime_slice_candidate_report.phase25_non_authorization.does_not_authorize_runtime = false;
    enabled.runtime_slice_candidate_report.phase25_non_authorization.eligibility_is_future_review_only = false;
    recomputeCandidateKey(enabled);
    expectValidatorFails(enabled, 'phase25-non-authorization-explicit');
    expectValidatorFails(enabled, 'eligibility-as-authorization-rejected');
  });

  test('validator rejects hidden listener/network/store/queue side-effect lies', () => {
    const sideEffect = clone(build());
    sideEffect.runtime_slice_candidate_report.side_effect_result.no_network_performed = false;
    sideEffect.runtime_slice_candidate_report.side_effect_result.networkRequestsAttempted = 1;
    recomputeCandidateKey(sideEffect);
    expectValidatorFails(sideEffect, 'out-of-scope-side-effects-blocked');
    expectValidatorFails(sideEffect, 'side-effects-blocked-now');

    const validationLie = clone(build());
    validationLie.validation_report.side_effect_result.no_output_file_written = false;
    validationLie.validation_report.side_effect_result.outputFilesWritten = 1;
    expectValidatorFails(validationLie, 'validation-report-side-effect-truth');
  });

  test('validator rejects unsafe tier/action drift and fake proof after idempotency recompute', () => {
    const unsafeTier = clone(build());
    unsafeTier.runtime_slice_candidate_report.candidate_slice_identity.risk_tier = 'tier3_external_side_effect';
    recomputeCandidateKey(unsafeTier);
    expectValidatorFails(unsafeTier, 'unsafe-tier-action-drift-rejected');

    const unsafeAction = clone(build());
    unsafeAction.runtime_slice_candidate_report.candidate_slice_identity.requested_action_classes = ['deploy'];
    recomputeCandidateKey(unsafeAction);
    expectValidatorFails(unsafeAction, 'unsafe-tier-action-drift-rejected');

    const fakeProof = clone(build());
    fakeProof.runtime_slice_candidate_report.proof_boundaries.socket_is_bridge_green_proof = true;
    fakeProof.runtime_slice_candidate_report.proof_boundaries.runtime_candidate_is_runtime_proof = true;
    recomputeCandidateKey(fakeProof);
    expectValidatorFails(fakeProof, 'proof-boundaries-preserved');
    expectValidatorFails(fakeProof, 'fake-proof-rejected');
  });

  test('validator rejects missing kill switch, rollback, audit, and stale Phase 24 baseline', () => {
    const missingKillSwitch = clone(build());
    missingKillSwitch.runtime_slice_candidate_report.missing_gates_carried_forward =
      missingKillSwitch.runtime_slice_candidate_report.missing_gates_carried_forward.filter((gate) => gate.gate_id !== 'operator-kill-switch');
    missingKillSwitch.runtime_slice_candidate_report.phase25_non_authorization.missing_gate_count -= 1;
    recomputeCandidateKey(missingKillSwitch);
    expectValidatorFails(missingKillSwitch, 'missing-gates-carried-forward-complete');
    expectValidatorFails(missingKillSwitch, 'kill-switch-rollback-audit-required');

    const stalePhase24 = clone(build());
    stalePhase24.runtime_slice_candidate_report.phase_24_dependency.baseline_commit = '3ce041c';
    stalePhase24.runtime_slice_candidate_report.phase_24_dependency.current_decision = 'eligible_for_future_runtime_slice';
    recomputeCandidateKey(stalePhase24);
    expectValidatorFails(stalePhase24, 'phase24-remain-validation-only-required');
    expectValidatorFails(stalePhase24, 'stale-phase24-baseline-rejected');
  });

  test('validator rejects forbidden raw/private/runtime/proof strings in values', () => {
    for (const forbidden of [
      'runtime available now',
      'runtime authorized',
      'runtime enabled',
      'phase 25 satisfies phase 24',
      'candidate proves runtime',
      'runtime started',
      'server started',
      'listener bound',
      'network request performed',
      'database write performed',
      'queue created',
      'lease created',
      'auth changed',
      'key generated',
      'secret read',
      'local execution performed',
      'deploy performed',
      'trade performed',
      'output file written',
      'socket proves bridge green',
      'delivery acceptance proves model processing',
      'server can execute local arms',
      'direct builder target allowed',
      'eligible authorizes runtime',
      'tier3 promoted',
      'raw terminal scrollback',
      'raw browser state',
      'raw screenshot',
      'raw customer private',
      'source-store payload',
      'bearer token',
      'session secret',
      'private key',
      'plaintext payload',
      'decrypted payload',
    ]) {
      const tampered = clone(build());
      tampered.runtime_slice_candidate_report.next_safe_actions[0].why_safe = forbidden;
      recomputeCandidateKey(tampered);
      expectValidatorFails(tampered, 'forbidden-output-strings-absent');
      expectValidatorFails(tampered, 'raw-private-secret-leakage-rejected');
    }
  });

  test('validator rejects missing future eligibility, blocked-now, out-of-scope, and safe constraints', () => {
    const missingFuture = clone(build());
    missingFuture.runtime_slice_candidate_report.future_eligibility_checklist =
      missingFuture.runtime_slice_candidate_report.future_eligibility_checklist.filter((entry) => entry.check_id !== 'operator-kill-switch-tested');
    recomputeCandidateKey(missingFuture);
    expectValidatorFails(missingFuture, 'future-eligibility-checklist-complete');

    const missingBlocked = clone(build());
    missingBlocked.runtime_slice_candidate_report.blocked_now_checklist =
      missingBlocked.runtime_slice_candidate_report.blocked_now_checklist.filter((entry) => entry.block_id !== 'output-file-blocked-now');
    recomputeCandidateKey(missingBlocked);
    expectValidatorFails(missingBlocked, 'blocked-now-checklist-complete');

    const missingScope = clone(build());
    missingScope.runtime_slice_candidate_report.out_of_scope_now =
      missingScope.runtime_slice_candidate_report.out_of_scope_now.filter((entry) => entry.scope_id !== 'network');
    recomputeCandidateKey(missingScope);
    expectValidatorFails(missingScope, 'out-of-scope-side-effects-blocked');

    const missingConstraint = clone(build());
    missingConstraint.runtime_slice_candidate_report.safe_first_slice_constraints =
      missingConstraint.runtime_slice_candidate_report.safe_first_slice_constraints.filter((entry) => entry.constraint_id !== 'audit-preview-only');
    recomputeCandidateKey(missingConstraint);
    expectValidatorFails(missingConstraint, 'safe-first-slice-constraints-complete');
  });

  test('CLI is stdout-only, consumes the Oracle fixture, and ignores output-file flags', () => {
    const parsed = parseArgs(['--pretty', '--out', 'ignored.json']);
    expect(parsed.pretty).toBe(true);
    expect(parsed.fixturePath).toContain('mira-core-runtime-slice-contract.json');

    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const output = main(['--out=ignored.json'], JSON.stringify({
      profile: { name: 'main' },
      sessionId: 'session-cli',
      deviceId: 'VIGIL',
    }));

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(candidateReport(output).schema).toBe(RUNTIME_SLICE_CANDIDATE_REPORT_SCHEMA_VERSION);
    expect(candidateReport(output).sessionId).toBe('session-cli');
    expect(candidateReport(output).baseline_commit).toBe('e062d16');
    expect(candidateReport(output).phase_24_dependency.current_decision).toBe('remain_validation_only');
    expect(candidateReport(output).phase_24_dependency.eligible_is_authorization).toBe(false);
    expect(candidateReport(output).candidate_slice_identity.slice_id).toBe(CANDIDATE_SLICE_ID);
    expect(candidateReport(output).candidate_slice_identity.runtime_available_now).toBe(false);
    expect(candidateReport(output).phase25_non_authorization.does_not_authorize_runtime).toBe(true);
    expect(candidateReport(output).proof_boundaries.runtime_candidate_is_runtime_proof).toBe(false);
    expect(candidateReport(output).side_effect_result.no_runtime_performed).toBe(true);
    expect(candidateReport(output).side_effect_result.no_output_file_written).toBe(true);
    expect(candidateReport(output).side_effect_result.outputFileWritten).toBe(false);
    expect(validationReport(output).decision).toBe('accepted');
    expect(validateMiraCoreRuntimeSliceOutput(output, runtimeSliceContract)).toEqual(expect.objectContaining({ ok: true }));
  });
});
