const runtimeReadinessRefreshContract = require('./fixtures/mira-core-runtime-readiness-refresh-through-phase37-contract.json');
const {
  BASELINE_COMMIT,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_REFRESH_FIELDS,
  REQUIRED_SIDE_EFFECT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  RUNTIME_READINESS_REFRESH_SCHEMA_VERSION,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreRuntimeReadinessRefreshThroughPhase37,
  runtimeReadinessRefreshThroughPhase37IdempotencyKey,
  validateMiraCoreRuntimeReadinessRefreshThroughPhase37Output,
} = require('../modules/mira-core/runtime-readiness-refresh-through-phase37');
const {
  main,
  parseArgs,
} = require('../scripts/hm-mira-core-runtime-readiness-refresh-through-phase37');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function build(inputSignals = {}) {
  return buildMiraCoreRuntimeReadinessRefreshThroughPhase37({
    contract: runtimeReadinessRefreshContract,
    inputSignals,
    nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
  });
}

function refresh(output) {
  return output.runtime_readiness_refresh_through_phase37;
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
  expect(() => assertNoForbiddenOutput(output, runtimeReadinessRefreshContract.forbiddenOutputSubstrings)).not.toThrow();
}

function expectValidatorFails(output, checkId) {
  const validation = validateMiraCoreRuntimeReadinessRefreshThroughPhase37Output(
    output,
    runtimeReadinessRefreshContract,
  );
  expect(validation.ok).toBe(false);
  expect(validation.checks.some((entry) => entry.id === checkId && entry.ok === false)).toBe(true);
}

function recomputeRefreshKey(output) {
  refresh(output).idempotency_key = runtimeReadinessRefreshThroughPhase37IdempotencyKey(refresh(output));
}

describe('mira core runtime readiness refresh through phase37 v0', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('satisfies Oracle top-level, refresh, and validation report shapes', () => {
    const output = build();
    const current = refresh(output);
    const report = validationReport(output);

    expectRequiredFields(output, runtimeReadinessRefreshContract.expectedOutputShape.requiredTopLevelFields);
    expect(runtimeReadinessRefreshContract.expectedOutputShape.requiredTopLevelFields).toEqual(REQUIRED_OUTPUT_FIELDS);
    expect(current.schema).toBe(RUNTIME_READINESS_REFRESH_SCHEMA_VERSION);
    expect(report.schema).toBe(VALIDATION_REPORT_SCHEMA_VERSION);
    expectRequiredFields(current, runtimeReadinessRefreshContract.expectedManifestShape.requiredFields);
    expect(runtimeReadinessRefreshContract.expectedManifestShape.requiredFields).toEqual(REQUIRED_REFRESH_FIELDS);
    expectRequiredFields(report, runtimeReadinessRefreshContract.expectedValidationReportShape.requiredFields);
    expect(runtimeReadinessRefreshContract.expectedValidationReportShape.requiredFields)
      .toEqual(REQUIRED_VALIDATION_REPORT_FIELDS);
    expect(report.accepted).toBe(true);
    expect(report.blocked).toBe(false);
    expect(report.decision).toBe('accepted_validation_only');
    expect(validateMiraCoreRuntimeReadinessRefreshThroughPhase37Output(output, runtimeReadinessRefreshContract))
      .toEqual(expect.objectContaining({ ok: true }));
    expectNoForbiddenOutput(output);
  });

  test('pins baseline c8b55be and registries through Phase 37', () => {
    const current = refresh(build());
    const expected = runtimeReadinessRefreshContract.phaseRegistryExpected;

    expect(BASELINE_COMMIT).toBe(runtimeReadinessRefreshContract.baseline.commit);
    expect(current.baseline_commit).toBe(BASELINE_COMMIT);
    expect(current.phase_registry).toEqual(expect.objectContaining({
      source_ref: expected.source_ref,
      current_through_phase: 37,
      expected_phases: '1-37',
      phase_inventory_count: 37,
      schema_registry_count: 37,
      cli_registry_count: 37,
      phase35_runtime_next_action_current: true,
      phase36_operator_ui_surface_current: true,
      phase37_control_reporting_reconciliation_current: true,
      phase37_commit: BASELINE_COMMIT,
    }));
    expect(current.phase_registry.phase37_delta).toEqual(expect.objectContaining(expected.phase37_delta));
    expect(current.phase_registry.phase37_delta.capability_truth).toEqual(expect.objectContaining({
      runtimeStarted: false,
      runnerExecuted: false,
      runtimeAvailable: false,
      serverCanExecuteLocal: false,
      serverCanProveModelProcessing: false,
      directBuilderOracleServerTargetsAllowed: false,
    }));
    expect(current.schema_registry).toHaveLength(37);
    expect(current.cli_registry).toHaveLength(37);
    expect(current.phase_registry.recent_phase_paths).toEqual(expected.required_recent_phase_paths);
  });

  test('preserves commit chain, source recommendation, satisfied prior work, and stale readiness truth', () => {
    const current = refresh(build());

    expect(current.commit_chain).toEqual(runtimeReadinessRefreshContract.commitChainExpected);
    expect(current.commit_chain).toHaveLength(runtimeReadinessRefreshContract.expectedManifestShape.expectedCounts.commit_chain);
    expect(current.commit_chain[current.commit_chain.length - 1]).toBe(BASELINE_COMMIT);
    expect(current.source_recommendation).toEqual(expect.objectContaining({
      recommendation_id: runtimeReadinessRefreshContract.sourceRecommendation.recommendation_id,
      tier: 'tier1',
      status: 'selected_for_phase38_fixture_only_contract',
      contract_only_now: true,
      implemented_now: false,
      does_not_authorize_ui: true,
      does_not_authorize_runtime: true,
      does_not_authorize_execution: true,
    }));
    expect(current.satisfied_prior_recommendations).toHaveLength(1);
    expect(current.satisfied_prior_recommendations[0]).toEqual(expect.objectContaining({
      recommendation_id: runtimeReadinessRefreshContract.satisfiedPriorRecommendations[0].recommendation_id,
      status: 'satisfied_by_c8b55be_do_not_repeat_as_open_work',
      satisfied_by_commit: BASELINE_COMMIT,
      must_not_reopen: true,
    }));
    expect(current.next_phase_recommendations.map((item) => item.recommendation_id))
      .not.toContain(current.satisfied_prior_recommendations[0].recommendation_id);
    expect(current.stale_readiness).toEqual(expect.objectContaining(
      runtimeReadinessRefreshContract.staleReadinessExpected,
    ));
  });

  test('keeps Phase34 prior recommendations, Oracle closures, source refs, and recent paths complete', () => {
    const output = build();
    const current = refresh(output);

    expect(current.phase34_prior_recommendations.phase35_runtime_status_milestone_refresh_validator.status)
      .toBe('satisfied_by_c04155d_do_not_repeat_as_open_work');
    expect(current.phase34_prior_recommendations.phase35_stdout_only_cli_smoke.status)
      .toBe('satisfied_by_c04155d_do_not_repeat_as_open_work');
    expect(current.closure_summary).toEqual(expect.objectContaining({
      phase30_oracle_115_prerequisite_mapping_closure: true,
      phase32_oracle_123_expires_at_closure: true,
      phase33_oracle_127_validation_report_tamper_coverage_closure: true,
      phase34_oracle_131_read_only_review_green: true,
      phase35_oracle_134_read_only_review_green: true,
      phase36_oracle_137_read_only_review_green: true,
      phase37_oracle_141_read_only_review_green: true,
    }));
    expect(current.closure_summary.closed_review_refs)
      .toEqual(['ORACLE #115', 'ORACLE #123', 'ORACLE #127', 'ORACLE #131', 'ORACLE #134', 'ORACLE #137', 'ORACLE #141']);
    expect(current.source_refs).toEqual(runtimeReadinessRefreshContract.sourceRefsExpected);
    expect(current.source_refs).toHaveLength(runtimeReadinessRefreshContract.expectedManifestShape.expectedCounts.source_refs);
    expect(validationReport(output).referenced_path_results.length).toBeGreaterThan(0);
    expect(validationReport(output).referenced_path_results.every((entry) => entry.ok)).toBe(true);
  });

  test('preserves capability, proof, verification, and no-side-effect boundaries', () => {
    const output = build();
    const current = refresh(output);

    expect(current.capability_matrix).toEqual(expect.objectContaining({
      runtimeStarted: false,
      runnerExecuted: false,
      runtimeAvailable: false,
      realRuntimeAvailable: false,
      serverCanExecuteLocal: false,
      serverCanProveModelProcessing: false,
      directBuilderOracleServerTargetsAllowed: false,
      allowed_future_server_target_role: 'architect',
    }));
    expect(current.boundary_truth).toEqual(expect.objectContaining({
      runtimeStarted: false,
      runnerExecuted: false,
      runtimeAvailable: false,
      serverCanExecuteLocal: false,
      serverCanProveModelProcessing: false,
      builderOracleDirectServerTargetsAllowed: false,
      socketIsBridgeGreenProof: false,
      deliveryAcceptanceIsModelProcessingProof: false,
      phase37CommitIsRuntimeProof: false,
      readinessRefreshIsRuntimeAuthorization: false,
      readinessRefreshIsUiProof: false,
    }));
    expect(current.verification_summary).toEqual(expect.objectContaining({
      no_fake_test_proof: true,
      phase37_commit_is_runtime_proof: false,
      readiness_refresh_is_runtime_authorization: false,
      readiness_refresh_is_ui_proof: false,
      model_processing_proof: false,
    }));
    expect(current.blocker_summary.length)
      .toBeGreaterThanOrEqual(runtimeReadinessRefreshContract.expectedManifestShape.expectedCounts.blocker_summary_min);
    for (const field of REQUIRED_SIDE_EFFECT_FIELDS) {
      expect(current.side_effect_result[field]).toBe(true);
      expect(validationReport(output).side_effect_truth[field]).toBe(true);
    }
    expect(current.side_effect_result.outputFileWritten).toBe(false);
    expect(current.side_effect_result.moduleOrCliImplemented).toBe(false);
    expect(current.side_effect_result.testsImplemented).toBe(false);
  });

  test('next recommendations are Tier0/Tier1, non-authorizing, and match fixture candidates', () => {
    const current = refresh(build());

    expect(current.next_phase_recommendations).toHaveLength(
      runtimeReadinessRefreshContract.nextRecommendationExpectedCandidates.length,
    );
    expect(current.next_phase_recommendations).toEqual(expect.arrayContaining(
      runtimeReadinessRefreshContract.nextRecommendationExpectedCandidates
        .map((candidate) => expect.objectContaining(candidate)),
    ));
    for (const recommendation of current.next_phase_recommendations) {
      expect(['tier0', 'tier1']).toContain(recommendation.tier);
      expect(recommendation.does_not_authorize_ui).toBe(true);
      expect(recommendation.does_not_authorize_runtime).toBe(true);
      expect(recommendation.does_not_authorize_execution).toBe(true);
      expect(recommendation.blocked_side_effects.length).toBeGreaterThan(0);
    }
  });

  test('static rules, acceptance checks, tamper cases, literal checks, and referenced paths are represented', () => {
    const output = build();
    const validation = validateMiraCoreRuntimeReadinessRefreshThroughPhase37Output(
      output,
      runtimeReadinessRefreshContract,
    );
    const checkIds = validation.checks.map((entry) => entry.id);
    const staticIds = validationReport(output).static_rule_results.map((entry) => entry.id);
    const acceptanceIds = validationReport(output).acceptance_check_results.map((entry) => entry.id);

    expect(validation.ok).toBe(true);
    for (const rule of runtimeReadinessRefreshContract.staticValidationRules) {
      expect(checkIds).toContain(rule.id);
      expect(staticIds).toContain(rule.id);
    }
    for (const check of runtimeReadinessRefreshContract.acceptanceChecks) {
      expect(checkIds).toContain(check.id);
      expect(acceptanceIds).toContain(check.id);
    }
    expect(validationReport(output).tamper_case_results).toHaveLength(runtimeReadinessRefreshContract.tamperCases.length);
    expect(validationReport(output).tamper_case_results.length)
      .toBeGreaterThanOrEqual(runtimeReadinessRefreshContract.expectedManifestShape.expectedCounts.tamper_case_results_min);
    expect(validationReport(output).tamper_case_results.every((entry) => entry.covered && entry.expectedFailure)).toBe(true);
    expect(validationReport(output).required_literal_results.length)
      .toBeGreaterThanOrEqual(runtimeReadinessRefreshContract.expectedManifestShape.expectedCounts.required_literal_results_min);
    expect(validationReport(output).required_literal_results.every((entry) => entry.ok)).toBe(true);
    expect(validationReport(output).referenced_path_results.every((entry) => entry.ok)).toBe(true);
  });

  test('idempotency is stable for equivalent inputs and sensitive to meaningful refresh changes', () => {
    const first = refresh(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'VIGIL' }));
    const second = refresh(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'VIGIL' }));
    const changedDevice = refresh(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'ALT' }));
    const changedProfile = refresh(build({ profile: { name: 'side' }, sessionId: 'session-a', deviceId: 'VIGIL' }));

    expect(first.idempotency_key).toBe(second.idempotency_key);
    expect(first.refresh_id).toBe(second.refresh_id);
    expect(first.idempotency_key).not.toBe(changedDevice.idempotency_key);
    expect(first.idempotency_key).not.toBe(changedProfile.idempotency_key);

    const changed = clone(build());
    const originalKey = refresh(changed).idempotency_key;
    refresh(changed).closure_summary.phase37_oracle_141_read_only_review_green = false;
    recomputeRefreshKey(changed);
    expect(refresh(changed).idempotency_key).not.toBe(originalKey);
    expectValidatorFails(changed, 'closures-carried-oracle-115-123-127-131-134-137-141');
  });

  test('validator rejects baseline, registry, commit-chain, source, prior, stale, source-ref, and path drift', () => {
    const baseline = clone(build());
    refresh(baseline).baseline_commit = '6f08b05';
    recomputeRefreshKey(baseline);
    expectValidatorFails(baseline, 'baseline-pinned-c8b55be');

    const phase37 = clone(build());
    refresh(phase37).phase_registry.phase37_control_reporting_reconciliation_current = false;
    recomputeRefreshKey(phase37);
    expectValidatorFails(phase37, 'phase37-current');

    const phase35 = clone(build());
    refresh(phase35).phase_registry.phase35_runtime_next_action_current = false;
    recomputeRefreshKey(phase35);
    expectValidatorFails(phase35, 'phase35-current-preserved');

    const phase36 = clone(build());
    refresh(phase36).phase_registry.phase36_operator_ui_surface_current = false;
    recomputeRefreshKey(phase36);
    expectValidatorFails(phase36, 'phase36-current-preserved');

    const count = clone(build());
    refresh(count).phase_registry.phase_inventory_count = 36;
    recomputeRefreshKey(count);
    expectValidatorFails(count, 'phase-inventory-count-37');

    const chain = clone(build());
    refresh(chain).commit_chain = refresh(chain).commit_chain.filter((commit) => commit !== BASELINE_COMMIT);
    recomputeRefreshKey(chain);
    expectValidatorFails(chain, 'commit-chain-exact-25');

    const source = clone(build());
    refresh(source).source_recommendation.recommendation_id = 'phase38-runtime-control-reporting-reconciliation-validator';
    recomputeRefreshKey(source);
    expectValidatorFails(source, 'source-recommendation-tier1-selected');

    const satisfied = clone(build());
    refresh(satisfied).satisfied_prior_recommendations[0].status = 'open';
    recomputeRefreshKey(satisfied);
    expectValidatorFails(satisfied, 'phase37-tier0-satisfied-not-open');

    const prior = clone(build());
    refresh(prior).phase34_prior_recommendations.phase35_runtime_status_milestone_refresh_validator.status = 'open';
    recomputeRefreshKey(prior);
    expectValidatorFails(prior, 'phase34-prior-recommendations-satisfied');

    const stale13 = clone(build());
    refresh(stale13).stale_readiness.phase13_readiness_current = true;
    recomputeRefreshKey(stale13);
    expectValidatorFails(stale13, 'phase13-stale-preserved');

    const stale23 = clone(build());
    refresh(stale23).stale_readiness.phase23_milestone_readiness_current = true;
    recomputeRefreshKey(stale23);
    expectValidatorFails(stale23, 'phase23-stale-preserved');

    const stale31 = clone(build());
    refresh(stale31).stale_readiness.phase31_runtime_milestone_refresh_current = true;
    recomputeRefreshKey(stale31);
    expectValidatorFails(stale31, 'phase31-stale-preserved');

    const missingRef = clone(build());
    refresh(missingRef).source_refs = refresh(missingRef).source_refs
      .filter((ref) => ref.artifact_id !== 'phase37-runtime-control-reporting-reconciliation');
    recomputeRefreshKey(missingRef);
    expectValidatorFails(missingRef, 'source-refs-phase29-30-32-33-34-35-36-37');

    const missingPath = clone(build());
    refresh(missingPath).phase_registry.recent_phase_paths = refresh(missingPath).phase_registry.recent_phase_paths
      .filter((entry) => entry.phase !== 37);
    recomputeRefreshKey(missingPath);
    expectValidatorFails(missingPath, 'recent-phase-paths-present');
  });

  test('validator rejects capability, proof, scope, side-effect, and redaction overclaims', () => {
    const runtime = clone(build());
    refresh(runtime).capability_matrix.runtimeStarted = true;
    refresh(runtime).boundary_truth.runtimeStarted = true;
    refresh(runtime).side_effect_result.runtimeStarted = true;
    recomputeRefreshKey(runtime);
    expectValidatorFails(runtime, 'capability-truth-false');
    expectValidatorFails(runtime, 'runtime-started-false');

    const runner = clone(build());
    refresh(runner).capability_matrix.runnerExecuted = true;
    recomputeRefreshKey(runner);
    expectValidatorFails(runner, 'capability-truth-false');
    expectValidatorFails(runner, 'runner-executed-false');

    const modelProof = clone(build());
    refresh(modelProof).capability_matrix.serverCanProveModelProcessing = true;
    recomputeRefreshKey(modelProof);
    expectValidatorFails(modelProof, 'capability-truth-false');

    const directTarget = clone(build());
    refresh(directTarget).capability_matrix.directBuilderOracleServerTargetsAllowed = true;
    refresh(directTarget).boundary_truth.builderOracleDirectServerTargetsAllowed = true;
    recomputeRefreshKey(directTarget);
    expectValidatorFails(directTarget, 'builder-oracle-direct-targets-blocked');

    const deliveryProof = clone(build());
    refresh(deliveryProof).boundary_truth.deliveryAcceptanceIsModelProcessingProof = true;
    recomputeRefreshKey(deliveryProof);
    expectValidatorFails(deliveryProof, 'proof-boundaries-false');

    const commitProof = clone(build());
    refresh(commitProof).boundary_truth.phase37CommitIsRuntimeProof = true;
    recomputeRefreshKey(commitProof);
    expectValidatorFails(commitProof, 'proof-boundaries-false');

    const outputFile = clone(build());
    refresh(outputFile).side_effect_result.no_output_file_written = false;
    refresh(outputFile).side_effect_result.outputFilesWritten = 1;
    recomputeRefreshKey(outputFile);
    expectValidatorFails(outputFile, 'side-effect-truth-all-blocked');

    const moduleImplemented = clone(build());
    refresh(moduleImplemented).side_effect_result.no_module_or_cli_implemented = false;
    refresh(moduleImplemented).side_effect_result.moduleOrCliImplemented = true;
    recomputeRefreshKey(moduleImplemented);
    expectValidatorFails(moduleImplemented, 'no-module-cli-test-runtime-work');

    const testsImplemented = clone(build());
    refresh(testsImplemented).side_effect_result.no_tests_implemented = false;
    refresh(testsImplemented).side_effect_result.testsImplemented = true;
    recomputeRefreshKey(testsImplemented);
    expectValidatorFails(testsImplemented, 'no-module-cli-test-runtime-work');

    const rawSecret = clone(build());
    refresh(rawSecret).verification_summary.note = 'raw bearer token';
    recomputeRefreshKey(rawSecret);
    expectValidatorFails(rawSecret, 'no-raw-private-secret-output');
    expectValidatorFails(rawSecret, 'forbidden-output-strings-absent');
  });

  test('validator rejects unsafe next-action drift and Tier2+ recommendations after idempotency recompute', () => {
    const liveRuntime = clone(build());
    refresh(liveRuntime).next_phase_recommendations[0].action = 'start live runtime';
    recomputeRefreshKey(liveRuntime);
    expectValidatorFails(liveRuntime, 'next-recommendations-no-live-runtime-or-ui');
    expectValidatorFails(liveRuntime, 'unsafe-action-drift-blocked');

    const liveUi = clone(build());
    refresh(liveUi).next_phase_recommendations[0].action = 'build live UI';
    recomputeRefreshKey(liveUi);
    expectValidatorFails(liveUi, 'next-recommendations-no-live-runtime-or-ui');

    const tier2 = clone(build());
    refresh(tier2).next_phase_recommendations[0].tier = 'tier2';
    recomputeRefreshKey(tier2);
    expectValidatorFails(tier2, 'next-recommendations-tier0-tier1-only');

    const customerSend = clone(build());
    refresh(customerSend).next_phase_recommendations[0].why_safe = 'safe to send customer message';
    recomputeRefreshKey(customerSend);
    expectValidatorFails(customerSend, 'unsafe-action-drift-blocked');
    expectValidatorFails(customerSend, 'unsafe-action-drift-rejected');

    const controlExecution = clone(build());
    refresh(controlExecution).next_phase_recommendations[0].why_safe = 'execute control and write report';
    recomputeRefreshKey(controlExecution);
    expectValidatorFails(controlExecution, 'unsafe-action-drift-blocked');
  });

  test('validator rejects validation report ok lies, missing tamper coverage, literal lies, and path result lies', () => {
    const staticLie = clone(build());
    validationReport(staticLie).static_rule_results[0].ok = false;
    expectValidatorFails(staticLie, 'validation-report-matches-contract');

    const acceptanceLie = clone(build());
    validationReport(acceptanceLie).acceptance_check_results[0].ok = false;
    expectValidatorFails(acceptanceLie, 'validation-report-matches-contract');

    const missingTamper = clone(build());
    validationReport(missingTamper).tamper_case_results = [];
    expectValidatorFails(missingTamper, 'validation-report-matches-contract');

    const literalLie = clone(build());
    refresh(literalLie).baseline_commit = '6f08b05';
    recomputeRefreshKey(literalLie);
    const literal = validationReport(literalLie).required_literal_results.find((entry) => entry.path === 'baseline_commit');
    literal.actual = BASELINE_COMMIT;
    literal.ok = true;
    expectValidatorFails(literalLie, 'required-literal-checks-bound');
    expectValidatorFails(literalLie, 'validation-report-matches-contract');

    const pathLie = clone(build());
    validationReport(pathLie).referenced_path_results[0].exists = false;
    validationReport(pathLie).referenced_path_results[0].ok = false;
    expectValidatorFails(pathLie, 'referenced-path-results-complete');
    expectValidatorFails(pathLie, 'validation-report-matches-contract');
  });

  test('CLI is stdout-only, consumes the Oracle fixture, and ignores output-file flags', () => {
    const parsed = parseArgs(['--pretty', '--out', 'ignored.json']);
    expect(parsed.pretty).toBe(true);
    expect(parsed.fixturePath).toContain('mira-core-runtime-readiness-refresh-through-phase37-contract.json');

    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const output = main(['--out=ignored.json'], JSON.stringify({
      profile: { name: 'main' },
      sessionId: 'session-cli',
      deviceId: 'VIGIL',
    }));

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(refresh(output).schema).toBe(RUNTIME_READINESS_REFRESH_SCHEMA_VERSION);
    expect(refresh(output).sessionId).toBe('session-cli');
    expect(refresh(output).baseline_commit).toBe(BASELINE_COMMIT);
    expect(refresh(output).phase_registry.current_through_phase).toBe(37);
    expect(refresh(output).phase_registry.phase_inventory_count).toBe(37);
    expect(refresh(output).phase_registry.schema_registry_count).toBe(37);
    expect(refresh(output).phase_registry.cli_registry_count).toBe(37);
    expect(refresh(output).schema_registry).toHaveLength(37);
    expect(refresh(output).cli_registry).toHaveLength(37);
    expect(refresh(output).commit_chain).toHaveLength(25);
    expect(refresh(output).source_refs).toHaveLength(8);
    expect(refresh(output).blocker_summary.length).toBeGreaterThanOrEqual(8);
    expect(refresh(output).capability_matrix.runtimeStarted).toBe(false);
    expect(refresh(output).capability_matrix.runnerExecuted).toBe(false);
    expect(refresh(output).capability_matrix.serverCanExecuteLocal).toBe(false);
    expect(refresh(output).side_effect_result.no_output_file_written).toBe(true);
    expect(refresh(output).side_effect_result.no_module_or_cli_implemented).toBe(true);
    expect(refresh(output).side_effect_result.no_tests_implemented).toBe(true);
    expect(validationReport(output).decision).toBe('accepted_validation_only');
    expect(validateMiraCoreRuntimeReadinessRefreshThroughPhase37Output(output, runtimeReadinessRefreshContract))
      .toEqual(expect.objectContaining({ ok: true }));
  });
});
