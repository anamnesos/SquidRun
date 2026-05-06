const runtimeModeKillSwitchImplementationRiskContract = require('./fixtures/mira-core-runtime-mode-kill-switch-implementation-risk-contract.json');
const {
  BASELINE_COMMIT,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_RISK_FIELDS,
  REQUIRED_SIDE_EFFECT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  RUNTIME_MODE_KILL_SWITCH_IMPLEMENTATION_RISK_SCHEMA_VERSION,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreRuntimeModeKillSwitchImplementationRisk,
  runtimeModeKillSwitchImplementationRiskIdempotencyKey,
  validateMiraCoreRuntimeModeKillSwitchImplementationRiskOutput,
} = require('../modules/mira-core/runtime-mode-kill-switch-implementation-risk');
const {
  main,
  parseArgs,
} = require('../scripts/hm-mira-core-runtime-mode-kill-switch-implementation-risk');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function build(inputSignals = {}) {
  return buildMiraCoreRuntimeModeKillSwitchImplementationRisk({
    contract: runtimeModeKillSwitchImplementationRiskContract,
    inputSignals,
    nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
  });
}

function risk(output) {
  return output.runtime_mode_kill_switch_implementation_risk;
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
  expect(() => assertNoForbiddenOutput(
    output,
    runtimeModeKillSwitchImplementationRiskContract.forbiddenOutputSubstrings,
  )).not.toThrow();
}

function expectValidatorFails(output, checkId) {
  const validation = validateMiraCoreRuntimeModeKillSwitchImplementationRiskOutput(
    output,
    runtimeModeKillSwitchImplementationRiskContract,
  );
  expect(validation.ok).toBe(false);
  expect(validation.checks.some((entry) => entry.id === checkId && entry.ok === false)).toBe(true);
}

function recomputeRiskKey(output) {
  risk(output).idempotency_key =
    runtimeModeKillSwitchImplementationRiskIdempotencyKey(risk(output));
}

describe('mira core runtime mode kill-switch implementation-risk v0', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('satisfies Oracle top-level, manifest, and validation report shapes', () => {
    const output = build();
    const current = risk(output);
    const report = validationReport(output);

    expectRequiredFields(output, runtimeModeKillSwitchImplementationRiskContract.expectedOutputShape.requiredTopLevelFields);
    expect(runtimeModeKillSwitchImplementationRiskContract.expectedOutputShape.requiredTopLevelFields)
      .toEqual(REQUIRED_OUTPUT_FIELDS);
    expect(current.schema).toBe(RUNTIME_MODE_KILL_SWITCH_IMPLEMENTATION_RISK_SCHEMA_VERSION);
    expect(report.schema).toBe(VALIDATION_REPORT_SCHEMA_VERSION);
    expectRequiredFields(current, runtimeModeKillSwitchImplementationRiskContract.expectedManifestShape.requiredFields);
    expect(runtimeModeKillSwitchImplementationRiskContract.expectedManifestShape.requiredFields)
      .toEqual(REQUIRED_RISK_FIELDS);
    expectRequiredFields(report, runtimeModeKillSwitchImplementationRiskContract.expectedValidationReportShape.requiredFields);
    expect(runtimeModeKillSwitchImplementationRiskContract.expectedValidationReportShape.requiredFields)
      .toEqual(REQUIRED_VALIDATION_REPORT_FIELDS);
    expect(report.accepted).toBe(true);
    expect(report.blocked).toBe(false);
    expect(report.decision).toBe('accepted_validation_only');
    expect(validateMiraCoreRuntimeModeKillSwitchImplementationRiskOutput(
      output,
      runtimeModeKillSwitchImplementationRiskContract,
    )).toEqual(expect.objectContaining({ ok: true }));
    expectNoForbiddenOutput(output);
  });

  test('pins baseline 5b3de99 and registries through Phase 42', () => {
    const current = risk(build());
    const expected = runtimeModeKillSwitchImplementationRiskContract.phaseRegistryExpected;

    expect(BASELINE_COMMIT).toBe(runtimeModeKillSwitchImplementationRiskContract.baseline.commit);
    expect(current.baseline_commit).toBe(BASELINE_COMMIT);
    expect(current.phase_registry).toEqual(expect.objectContaining({
      source_ref: expected.source_ref,
      current_through_phase: 42,
      expected_phases: '1-42',
      phase_inventory_count: 42,
      schema_registry_count: 42,
      cli_registry_count: 42,
      phase35_runtime_next_action_current: true,
      phase36_operator_ui_surface_current: true,
      phase37_control_reporting_reconciliation_current: true,
      phase38_runtime_readiness_refresh_current: true,
      phase39_dry_run_readiness_gap_current: true,
      phase40_runtime_mode_kill_switch_current: true,
      phase41_status_gap_refresh_current: true,
      phase42_prerequisite_boundary_current: true,
      phase42_commit: BASELINE_COMMIT,
    }));
    expect(current.phase_registry.phase42_delta).toEqual(expect.objectContaining(expected.phase42_delta));
    expect(current.schema_registry).toHaveLength(42);
    expect(current.cli_registry).toHaveLength(42);
    expect(current.phase_registry.recent_phase_paths).toEqual(expected.required_recent_phase_paths);
  });

  test('preserves commit chain, selected source recommendation, satisfied Phase42 work, and current truth', () => {
    const current = risk(build());

    expect(current.commit_chain).toEqual(runtimeModeKillSwitchImplementationRiskContract.commitChainExpected);
    expect(current.commit_chain).toHaveLength(
      runtimeModeKillSwitchImplementationRiskContract.expectedManifestShape.expectedCounts.commit_chain,
    );
    expect(current.commit_chain[current.commit_chain.length - 1]).toBe(BASELINE_COMMIT);
    expect(current.source_recommendation).toEqual(expect.objectContaining({
      recommendation_id: runtimeModeKillSwitchImplementationRiskContract.sourceRecommendation.recommendation_id,
      tier: 'tier1',
      status: 'selected_for_phase43_fixture_only_contract',
      contract_only_now: true,
      implemented_now: false,
      does_not_authorize_ui: true,
      does_not_authorize_runtime: true,
      does_not_authorize_execution: true,
    }));
    expect(current.satisfied_prior_recommendations[0]).toEqual(expect.objectContaining({
      recommendation_id: runtimeModeKillSwitchImplementationRiskContract.satisfiedPriorRecommendations[0].recommendation_id,
      status: 'satisfied_by_5b3de99_do_not_repeat_as_open_work',
      satisfied_by_commit: BASELINE_COMMIT,
      must_not_reopen: true,
    }));
    expect(current.next_phase_recommendations.map((item) => item.recommendation_id))
      .not.toContain(current.satisfied_prior_recommendations[0].recommendation_id);
    expect(current.current_truth).toEqual(expect.objectContaining(
      runtimeModeKillSwitchImplementationRiskContract.currentTruthExpected,
    ));
    expect(current.current_truth.implementation_risk_remains_non_authorizing).toBe(true);
  });

  test('keeps stale readiness, Phase34 prior recommendations, Oracle closures, source refs, and paths complete', () => {
    const output = build();
    const current = risk(output);

    expect(current.stale_readiness).toEqual(expect.objectContaining(
      runtimeModeKillSwitchImplementationRiskContract.staleReadinessExpected,
    ));
    expect(current.phase34_prior_recommendations.phase35_runtime_status_milestone_refresh_validator.status)
      .toBe('satisfied_by_c04155d_do_not_repeat_as_open_work');
    expect(current.phase34_prior_recommendations.phase35_stdout_only_cli_smoke.status)
      .toBe('satisfied_by_c04155d_do_not_repeat_as_open_work');
    expect(current.closure_summary).toEqual(expect.objectContaining(
      runtimeModeKillSwitchImplementationRiskContract.closureSummaryExpected,
    ));
    expect(current.closure_summary.closed_review_refs)
      .toEqual(runtimeModeKillSwitchImplementationRiskContract.closureSummaryExpected.closed_review_refs);
    expect(current.source_refs).toEqual(runtimeModeKillSwitchImplementationRiskContract.sourceRefsExpected);
    expect(current.source_refs).toHaveLength(
      runtimeModeKillSwitchImplementationRiskContract.expectedManifestShape.expectedCounts.source_refs,
    );
    expect(validationReport(output).referenced_path_results.length).toBeGreaterThan(0);
    expect(validationReport(output).referenced_path_results.every((entry) => entry.ok)).toBe(true);
  });

  test('defines contract-only prerequisite, disabled runtime mode, and fail-closed unwired kill-switch boundaries', () => {
    const current = risk(build());

    expectRequiredFields(
      current.prerequisite_boundary,
      runtimeModeKillSwitchImplementationRiskContract.prerequisiteBoundaryShapeExpected.requiredFields,
    );
    expect(current.prerequisite_boundary).toEqual(expect.objectContaining(
      runtimeModeKillSwitchImplementationRiskContract.prerequisiteBoundaryShapeExpected.requiredValues,
    ));
    expectRequiredFields(
      current.runtime_mode_boundary,
      runtimeModeKillSwitchImplementationRiskContract.runtimeModeBoundaryShapeExpected.requiredFields,
    );
    expect(current.runtime_mode_boundary).toEqual(expect.objectContaining(
      runtimeModeKillSwitchImplementationRiskContract.runtimeModeBoundaryShapeExpected.requiredValues,
    ));
    expect(current.runtime_mode_boundary.source_ref).toBe('phase42-runtime-mode-kill-switch-prerequisite-boundary');
    expectRequiredFields(
      current.kill_switch_boundary,
      runtimeModeKillSwitchImplementationRiskContract.killSwitchBoundaryShapeExpected.requiredFields,
    );
    expect(current.kill_switch_boundary).toEqual(expect.objectContaining(
      runtimeModeKillSwitchImplementationRiskContract.killSwitchBoundaryShapeExpected.requiredValues,
    ));
    expect(current.kill_switch_boundary.source_ref).toBe('phase42-runtime-mode-kill-switch-prerequisite-boundary');
    expect(current.kill_switch_boundary.killWired).toBe(false);
    expect(current.kill_switch_boundary.liveCheck).toBe(false);
  });

  test('keeps prerequisite gaps, implementation risk boundary, risk register, and future slices blocked', () => {
    const current = risk(build());

    expect(current.prerequisite_gap_matrix.map((entry) => entry.gap_id))
      .toEqual(runtimeModeKillSwitchImplementationRiskContract.prerequisiteGapMatrixExpected.map((entry) => entry.gap_id));
    expect(current.prerequisite_gap_matrix).toHaveLength(2);
    for (const gap of current.prerequisite_gap_matrix) {
      expect(gap).toEqual(expect.objectContaining({
        status: 'unsatisfied_blocking_reference_only',
        reference_contract_only: true,
        satisfied_now: false,
        blocks_runtime_now: true,
        blocks_dry_run_now: true,
        authorizes_runtime: false,
        authorizes_dry_run: false,
        authorizes_execution: false,
      }));
    }
    expectRequiredFields(
      current.implementation_risk_boundary,
      runtimeModeKillSwitchImplementationRiskContract.implementationRiskBoundaryShapeExpected.requiredFields,
    );
    expect(current.implementation_risk_boundary).toEqual(expect.objectContaining(
      runtimeModeKillSwitchImplementationRiskContract.implementationRiskBoundaryShapeExpected.requiredValues,
    ));
    expect(current.risk_register.map((entry) => entry.risk_id))
      .toEqual(runtimeModeKillSwitchImplementationRiskContract.riskRegisterExpected.map((entry) => entry.risk_id));
    expect(current.risk_register).toHaveLength(8);
    expect(current.risk_register.every((entry) => (
      entry.status === 'blocking_non_authorizing'
      && entry.satisfied_now === false
      && entry.blocks_runtime_now === true
      && entry.authorizes_runtime === false
    ))).toBe(true);
    expect(current.blocked_future_slices.map((entry) => entry.slice_id))
      .toEqual(runtimeModeKillSwitchImplementationRiskContract.blockedFutureSlicesExpected.map((entry) => entry.slice_id));
    expect(current.blocked_future_slices).toHaveLength(4);
    expect(current.blocked_future_slices.every((entry) => entry.blocked_now === true && entry.authorizes_runtime === false))
      .toBe(true);
  });

  test('preserves capability, proof, redaction, and no-side-effect boundaries', () => {
    const output = build();
    const current = risk(output);

    expect(current.capability_matrix).toEqual(expect.objectContaining(
      runtimeModeKillSwitchImplementationRiskContract.capabilityMatrixExpected,
    ));
    expect(current.boundary_truth).toEqual(expect.objectContaining(
      runtimeModeKillSwitchImplementationRiskContract.proofBoundaryExpected,
    ));
    expect(current.redaction_summary).toEqual(expect.objectContaining({
      raw_private_content_included: false,
      raw_terminal_included: false,
      raw_screenshot_ocr_browser_included: false,
      secret_material_included: false,
      customer_private_content_included: false,
    }));
    for (const field of REQUIRED_SIDE_EFFECT_FIELDS) {
      expect(current.side_effect_result[field]).toBe(true);
      expect(validationReport(output).side_effect_truth[field]).toBe(true);
    }
    expect(current.side_effect_result.outputFileWritten).toBe(false);
    expect(current.side_effect_result.runtimeModeFlagRead).toBe(false);
    expect(current.side_effect_result.killSwitchWired).toBe(false);
    expect(current.side_effect_result.controlExecutionPerformed).toBe(false);
    expect(current.side_effect_result.reportingSinkWritten).toBe(false);
  });

  test('next recommendations are Tier0/Tier1, non-authorizing, and match fixture candidates', () => {
    const current = risk(build());

    expect(current.next_phase_recommendations).toHaveLength(
      runtimeModeKillSwitchImplementationRiskContract.nextRecommendationExpectedCandidates.length,
    );
    expect(current.next_phase_recommendations).toEqual(expect.arrayContaining(
      runtimeModeKillSwitchImplementationRiskContract.nextRecommendationExpectedCandidates
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
    const validation = validateMiraCoreRuntimeModeKillSwitchImplementationRiskOutput(
      output,
      runtimeModeKillSwitchImplementationRiskContract,
    );
    const checkIds = validation.checks.map((entry) => entry.id);
    const staticIds = validationReport(output).static_rule_results.map((entry) => entry.id);
    const acceptanceIds = validationReport(output).acceptance_check_results.map((entry) => entry.id);

    expect(validation.ok).toBe(true);
    for (const rule of runtimeModeKillSwitchImplementationRiskContract.staticValidationRules) {
      expect(checkIds).toContain(rule.id);
      expect(staticIds).toContain(rule.id);
    }
    for (const check of runtimeModeKillSwitchImplementationRiskContract.acceptanceChecks) {
      expect(checkIds).toContain(check.id);
      expect(acceptanceIds).toContain(check.id);
    }
    expect(validationReport(output).tamper_case_results).toHaveLength(
      runtimeModeKillSwitchImplementationRiskContract.tamperCases.length,
    );
    expect(validationReport(output).tamper_case_results.length)
      .toBeGreaterThanOrEqual(
        runtimeModeKillSwitchImplementationRiskContract.expectedManifestShape.expectedCounts.tamper_case_results_min,
      );
    expect(validationReport(output).required_literal_results.length)
      .toBeGreaterThanOrEqual(
        runtimeModeKillSwitchImplementationRiskContract.expectedManifestShape.expectedCounts.required_literal_results_min,
      );
    expect(validationReport(output).required_literal_results.every((entry) => entry.ok)).toBe(true);
    expect(validationReport(output).referenced_path_results.every((entry) => entry.ok)).toBe(true);
  });

  test('idempotency is stable for equivalent inputs and sensitive to implementation-risk changes', () => {
    const first = risk(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'VIGIL' }));
    const second = risk(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'VIGIL' }));
    const changedDevice = risk(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'ALT' }));
    const changedProfile = risk(build({ profile: { name: 'side' }, sessionId: 'session-a', deviceId: 'VIGIL' }));

    expect(first.idempotency_key).toBe(second.idempotency_key);
    expect(first.risk_id).toBe(second.risk_id);
    expect(first.idempotency_key).not.toBe(changedDevice.idempotency_key);
    expect(first.idempotency_key).not.toBe(changedProfile.idempotency_key);

    const changed = clone(build());
    const originalKey = risk(changed).idempotency_key;
    risk(changed).implementation_risk_boundary.implementation_authorized_now = true;
    recomputeRiskKey(changed);
    expect(risk(changed).idempotency_key).not.toBe(originalKey);
    expectValidatorFails(changed, 'implementation-risk-boundary-non-authorizing');
  });

  test('validator rejects baseline, registry, source, stale, closure, source-ref, and path drift', () => {
    const baseline = clone(build());
    risk(baseline).baseline_commit = '833f9c1';
    recomputeRiskKey(baseline);
    expectValidatorFails(baseline, 'baseline-pinned-5b3de99');

    const phase42 = clone(build());
    risk(phase42).phase_registry.phase42_prerequisite_boundary_current = false;
    recomputeRiskKey(phase42);
    expectValidatorFails(phase42, 'phase42-current');

    const count = clone(build());
    risk(count).phase_registry.phase_inventory_count = 41;
    recomputeRiskKey(count);
    expectValidatorFails(count, 'phase-inventory-count-42');

    const chain = clone(build());
    risk(chain).commit_chain = risk(chain).commit_chain.filter((commit) => commit !== BASELINE_COMMIT);
    recomputeRiskKey(chain);
    expectValidatorFails(chain, 'commit-chain-exact-30');

    const source = clone(build());
    risk(source).source_recommendation.recommendation_id = 'phase43-runtime-mode-kill-switch-prerequisite-boundary-validator';
    recomputeRiskKey(source);
    expectValidatorFails(source, 'source-recommendation-tier1-selected');

    const satisfied = clone(build());
    risk(satisfied).satisfied_prior_recommendations[0].status = 'open';
    recomputeRiskKey(satisfied);
    expectValidatorFails(satisfied, 'phase42-tier0-satisfied-not-open');

    const stale13 = clone(build());
    risk(stale13).stale_readiness.phase13_readiness_current = true;
    recomputeRiskKey(stale13);
    expectValidatorFails(stale13, 'phase13-stale-preserved');

    const missingClosure = clone(build());
    risk(missingClosure).closure_summary.phase42_oracle_168_read_only_review_green = false;
    recomputeRiskKey(missingClosure);
    expectValidatorFails(missingClosure, 'closures-carried-oracle-115-123-127-131-134-137-141-148-149-156-161-165-168');

    const missingRef = clone(build());
    risk(missingRef).source_refs = risk(missingRef).source_refs
      .filter((ref) => ref.artifact_id !== 'phase42-runtime-mode-kill-switch-prerequisite-boundary');
    recomputeRiskKey(missingRef);
    expectValidatorFails(missingRef, 'source-refs-phase26-27-29-30-32-33-37-38-39-40-41-42');

    const missingPath = clone(build());
    risk(missingPath).phase_registry.recent_phase_paths = risk(missingPath).phase_registry.recent_phase_paths
      .filter((entry) => entry.phase !== 42);
    recomputeRiskKey(missingPath);
    expectValidatorFails(missingPath, 'recent-phase-paths-present');
  });

  test('validator rejects prerequisite, runtime-mode, kill-switch, and gap drift', () => {
    const preRuntime = clone(build());
    risk(preRuntime).prerequisite_boundary.runtime_authorized_now = true;
    recomputeRiskKey(preRuntime);
    expectValidatorFails(preRuntime, 'prerequisite-boundary-preserved');

    const modeEnabled = clone(build());
    risk(modeEnabled).runtime_mode_boundary.effective_state = 'dry_run_preview_only';
    recomputeRiskKey(modeEnabled);
    expectValidatorFails(modeEnabled, 'runtime-mode-boundary-disabled-reference-only');

    const flagReader = clone(build());
    risk(flagReader).runtime_mode_boundary.flag_reader_implemented = true;
    recomputeRiskKey(flagReader);
    expectValidatorFails(flagReader, 'runtime-mode-boundary-disabled-reference-only');

    const flagReadNow = clone(build());
    risk(flagReadNow).runtime_mode_boundary.flag_read_now = true;
    recomputeRiskKey(flagReadNow);
    expectValidatorFails(flagReadNow, 'runtime-mode-boundary-disabled-reference-only');

    const killWired = clone(build());
    risk(killWired).kill_switch_boundary.killWired = true;
    recomputeRiskKey(killWired);
    expectValidatorFails(killWired, 'kill-switch-boundary-fail-closed-reference-only');

    const killLive = clone(build());
    risk(killLive).kill_switch_boundary.liveCheck = true;
    recomputeRiskKey(killLive);
    expectValidatorFails(killLive, 'kill-switch-boundary-fail-closed-reference-only');

    const gapSatisfied = clone(build());
    risk(gapSatisfied).prerequisite_gap_matrix[0].satisfied_now = true;
    recomputeRiskKey(gapSatisfied);
    expectValidatorFails(gapSatisfied, 'prerequisite-gap-matrix-two-unsatisfied-gaps');
    expectValidatorFails(gapSatisfied, 'implementation-risk-does-not-satisfy-prerequisite-gaps');
  });

  test('validator rejects implementation-risk, risk-register, and blocked-future-slice drift', () => {
    const implementationAllowed = clone(build());
    risk(implementationAllowed).implementation_risk_boundary.implementation_authorized_now = true;
    recomputeRiskKey(implementationAllowed);
    expectValidatorFails(implementationAllowed, 'implementation-risk-boundary-non-authorizing');
    expectValidatorFails(implementationAllowed, 'implementation-risk-does-not-satisfy-prerequisite-gaps');

    const flagAllowed = clone(build());
    risk(flagAllowed).implementation_risk_boundary.runtime_mode_flag_reader_allowed_now = true;
    recomputeRiskKey(flagAllowed);
    expectValidatorFails(flagAllowed, 'implementation-risk-boundary-non-authorizing');

    const killAllowed = clone(build());
    risk(killAllowed).implementation_risk_boundary.kill_switch_wiring_allowed_now = true;
    recomputeRiskKey(killAllowed);
    expectValidatorFails(killAllowed, 'implementation-risk-boundary-non-authorizing');

    const controlAllowed = clone(build());
    risk(controlAllowed).implementation_risk_boundary.control_execution_allowed_now = true;
    recomputeRiskKey(controlAllowed);
    expectValidatorFails(controlAllowed, 'implementation-risk-boundary-non-authorizing');

    const missingRisk = clone(build());
    risk(missingRisk).risk_register = risk(missingRisk).risk_register
      .filter((entry) => entry.risk_id !== 'runtime-mode-default-on-risk');
    recomputeRiskKey(missingRisk);
    expectValidatorFails(missingRisk, 'risk-register-eight-blocking-risks');

    const riskSatisfied = clone(build());
    risk(riskSatisfied).risk_register[0].satisfied_now = true;
    recomputeRiskKey(riskSatisfied);
    expectValidatorFails(riskSatisfied, 'risk-register-eight-blocking-risks');

    const sliceUnblocked = clone(build());
    risk(sliceUnblocked).blocked_future_slices[0].blocked_now = false;
    recomputeRiskKey(sliceUnblocked);
    expectValidatorFails(sliceUnblocked, 'blocked-future-slices-four');
  });

  test('validator rejects capability, proof, side-effect, scope, and redaction overclaims', () => {
    const runtime = clone(build());
    risk(runtime).capability_matrix.runtimeStarted = true;
    risk(runtime).boundary_truth.runtimeStarted = true;
    risk(runtime).side_effect_result.runtimeStarted = true;
    recomputeRiskKey(runtime);
    expectValidatorFails(runtime, 'capability-truth-false');
    expectValidatorFails(runtime, 'runtime-started-false');

    const proof = clone(build());
    risk(proof).boundary_truth.implementationRiskIsRuntimeAuthorization = true;
    recomputeRiskKey(proof);
    expectValidatorFails(proof, 'proof-boundaries-false');

    const directTarget = clone(build());
    risk(directTarget).capability_matrix.directBuilderOracleServerTargetsAllowed = true;
    risk(directTarget).boundary_truth.builderOracleDirectServerTargetsAllowed = true;
    recomputeRiskKey(directTarget);
    expectValidatorFails(directTarget, 'builder-oracle-direct-targets-blocked');

    const outputFile = clone(build());
    risk(outputFile).side_effect_result.no_output_file_written = false;
    risk(outputFile).side_effect_result.outputFilesWritten = 1;
    recomputeRiskKey(outputFile);
    expectValidatorFails(outputFile, 'side-effect-truth-all-blocked');

    const flagRead = clone(build());
    risk(flagRead).side_effect_result.no_runtime_mode_flag_read = false;
    risk(flagRead).side_effect_result.runtimeModeFlagRead = true;
    recomputeRiskKey(flagRead);
    expectValidatorFails(flagRead, 'side-effect-truth-all-blocked');

    const moduleImplemented = clone(build());
    risk(moduleImplemented).side_effect_result.no_module_or_cli_implemented = false;
    risk(moduleImplemented).side_effect_result.moduleOrCliImplemented = true;
    recomputeRiskKey(moduleImplemented);
    expectValidatorFails(moduleImplemented, 'no-module-cli-test-runtime-work');

    const rawSecret = clone(build());
    risk(rawSecret).redaction_summary.note = 'raw bearer token';
    recomputeRiskKey(rawSecret);
    expectValidatorFails(rawSecret, 'redaction-summary-safe');
    expectValidatorFails(rawSecret, 'forbidden-output-strings-absent');
  });

  test('validator rejects unsafe next-action drift and Tier2+ recommendations after idempotency recompute', () => {
    const liveRuntime = clone(build());
    risk(liveRuntime).next_phase_recommendations[0].action = 'start live runtime';
    recomputeRiskKey(liveRuntime);
    expectValidatorFails(liveRuntime, 'unsafe-action-drift-blocked');

    const wireKill = clone(build());
    risk(wireKill).next_phase_recommendations[0].action = 'wire kill switch now';
    recomputeRiskKey(wireKill);
    expectValidatorFails(wireKill, 'unsafe-action-drift-blocked');

    const readFlag = clone(build());
    risk(readFlag).next_phase_recommendations[0].why_safe = 'read runtime mode flag from env';
    recomputeRiskKey(readFlag);
    expectValidatorFails(readFlag, 'unsafe-action-drift-blocked');

    const tier2 = clone(build());
    risk(tier2).next_phase_recommendations[0].tier = 'tier2';
    recomputeRiskKey(tier2);
    expectValidatorFails(tier2, 'next-recommendations-tier0-tier1-only');

    const customerSend = clone(build());
    risk(customerSend).next_phase_recommendations[0].why_safe = 'safe to send customer message';
    recomputeRiskKey(customerSend);
    expectValidatorFails(customerSend, 'unsafe-action-drift-blocked');
    expectValidatorFails(customerSend, 'unsafe-action-drift-rejected');
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
    expectValidatorFails(missingTamper, 'validation-report-coverage-bound');
    expectValidatorFails(missingTamper, 'validation-report-matches-contract');

    const literalLie = clone(build());
    risk(literalLie).baseline_commit = '833f9c1';
    recomputeRiskKey(literalLie);
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
    expect(parsed.fixturePath).toContain('mira-core-runtime-mode-kill-switch-implementation-risk-contract.json');

    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const output = main(['--out=ignored.json'], JSON.stringify({
      profile: { name: 'main' },
      sessionId: 'session-cli',
      deviceId: 'VIGIL',
    }));

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(risk(output).schema).toBe(RUNTIME_MODE_KILL_SWITCH_IMPLEMENTATION_RISK_SCHEMA_VERSION);
    expect(risk(output).sessionId).toBe('session-cli');
    expect(risk(output).baseline_commit).toBe(BASELINE_COMMIT);
    expect(risk(output).phase_registry.current_through_phase).toBe(42);
    expect(risk(output).phase_registry.phase_inventory_count).toBe(42);
    expect(risk(output).phase_registry.schema_registry_count).toBe(42);
    expect(risk(output).phase_registry.cli_registry_count).toBe(42);
    expect(risk(output).schema_registry).toHaveLength(42);
    expect(risk(output).cli_registry).toHaveLength(42);
    expect(risk(output).commit_chain).toHaveLength(30);
    expect(risk(output).source_refs).toHaveLength(12);
    expect(risk(output).prerequisite_gap_matrix).toHaveLength(2);
    expect(risk(output).risk_register).toHaveLength(8);
    expect(risk(output).blocked_future_slices).toHaveLength(4);
    expect(risk(output).implementation_risk_boundary.implementation_authorized_now).toBe(false);
    expect(risk(output).runtime_mode_boundary.flag_reader_implemented).toBe(false);
    expect(risk(output).runtime_mode_boundary.flag_read_now).toBe(false);
    expect(risk(output).kill_switch_boundary.wired).toBe(false);
    expect(risk(output).kill_switch_boundary.liveCheck).toBe(false);
    expect(risk(output).capability_matrix.runtimeStarted).toBe(false);
    expect(risk(output).capability_matrix.runnerExecuted).toBe(false);
    expect(risk(output).capability_matrix.serverCanExecuteLocal).toBe(false);
    expect(risk(output).side_effect_result.no_output_file_written).toBe(true);
    expect(risk(output).side_effect_result.no_runtime_mode_flag_read).toBe(true);
    expect(risk(output).side_effect_result.no_kill_switch_wired).toBe(true);
    expect(validationReport(output).decision).toBe('accepted_validation_only');
    expect(validateMiraCoreRuntimeModeKillSwitchImplementationRiskOutput(
      output,
      runtimeModeKillSwitchImplementationRiskContract,
    )).toEqual(expect.objectContaining({ ok: true }));
  });
});
