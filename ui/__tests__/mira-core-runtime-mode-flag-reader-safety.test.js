const runtimeModeFlagReaderSafetyContract = require('./fixtures/mira-core-runtime-mode-flag-reader-safety-contract.json');
const {
  BASELINE_COMMIT,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_SAFETY_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  RUNTIME_MODE_FLAG_READER_SAFETY_SCHEMA_VERSION,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreRuntimeModeFlagReaderSafety,
  runtimeModeFlagReaderSafetyIdempotencyKey,
  validateMiraCoreRuntimeModeFlagReaderSafetyOutput,
} = require('../modules/mira-core/runtime-mode-flag-reader-safety');
const {
  main,
  parseArgs,
} = require('../scripts/hm-mira-core-runtime-mode-flag-reader-safety');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function build(inputSignals = {}) {
  return buildMiraCoreRuntimeModeFlagReaderSafety({
    contract: runtimeModeFlagReaderSafetyContract,
    inputSignals,
    nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
  });
}

function safety(output) {
  return output.runtime_mode_flag_reader_safety;
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
    runtimeModeFlagReaderSafetyContract.forbiddenOutputSubstrings,
  )).not.toThrow();
}

function expectValidatorFails(output, checkId) {
  const validation = validateMiraCoreRuntimeModeFlagReaderSafetyOutput(
    output,
    runtimeModeFlagReaderSafetyContract,
  );
  expect(validation.ok).toBe(false);
  expect(validation.checks.some((entry) => entry.id === checkId && entry.ok === false)).toBe(true);
}

function recomputeSafetyKey(output) {
  safety(output).idempotency_key = runtimeModeFlagReaderSafetyIdempotencyKey(safety(output));
}

describe('mira core runtime mode flag-reader safety v0', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('satisfies Oracle top-level, manifest, and validation report shapes', () => {
    const output = build();
    const current = safety(output);
    const report = validationReport(output);

    expectRequiredFields(output, runtimeModeFlagReaderSafetyContract.expectedOutputShape.requiredTopLevelFields);
    expect(runtimeModeFlagReaderSafetyContract.expectedOutputShape.requiredTopLevelFields)
      .toEqual(REQUIRED_OUTPUT_FIELDS);
    expect(current.schema).toBe(RUNTIME_MODE_FLAG_READER_SAFETY_SCHEMA_VERSION);
    expect(report.schema).toBe(VALIDATION_REPORT_SCHEMA_VERSION);
    expectRequiredFields(current, runtimeModeFlagReaderSafetyContract.expectedManifestShape.requiredFields);
    expect(runtimeModeFlagReaderSafetyContract.expectedManifestShape.requiredFields)
      .toEqual(REQUIRED_SAFETY_FIELDS);
    expectRequiredFields(report, runtimeModeFlagReaderSafetyContract.expectedValidationReportShape.requiredFields);
    expect(runtimeModeFlagReaderSafetyContract.expectedValidationReportShape.requiredFields)
      .toEqual(REQUIRED_VALIDATION_REPORT_FIELDS);
    expect(report.accepted).toBe(true);
    expect(report.blocked).toBe(false);
    expect(report.decision).toBe('accepted_validation_only');
    expect(validateMiraCoreRuntimeModeFlagReaderSafetyOutput(
      output,
      runtimeModeFlagReaderSafetyContract,
    )).toEqual(expect.objectContaining({ ok: true }));
    expectNoForbiddenOutput(output);
  });

  test('pins baseline 78f5164 and registries through Phase 43', () => {
    const current = safety(build());
    const expected = runtimeModeFlagReaderSafetyContract.phaseRegistryExpected;

    expect(BASELINE_COMMIT).toBe(runtimeModeFlagReaderSafetyContract.baseline.commit);
    expect(current.baseline_commit).toBe(BASELINE_COMMIT);
    expect(current.phase_registry).toEqual(expect.objectContaining({
      source_ref: expected.source_ref,
      current_through_phase: 43,
      expected_phases: '1-43',
      phase_inventory_count: 43,
      schema_registry_count: 43,
      cli_registry_count: 43,
      phase35_runtime_next_action_current: true,
      phase36_operator_ui_surface_current: true,
      phase37_control_reporting_reconciliation_current: true,
      phase38_runtime_readiness_refresh_current: true,
      phase39_dry_run_readiness_gap_current: true,
      phase40_runtime_mode_kill_switch_current: true,
      phase41_status_gap_refresh_current: true,
      phase42_prerequisite_boundary_current: true,
      phase43_implementation_risk_current: true,
      phase43_commit: BASELINE_COMMIT,
    }));
    expect(current.phase_registry.phase43_delta).toEqual(expect.objectContaining(expected.phase43_delta));
    expect(current.schema_registry).toHaveLength(43);
    expect(current.cli_registry).toHaveLength(43);
    expect(current.phase_registry.recent_phase_paths).toEqual(expected.required_recent_phase_paths);
  });

  test('preserves commit chain, selected source recommendation, satisfied Phase43 work, and current truth', () => {
    const current = safety(build());

    expect(current.commit_chain).toEqual(runtimeModeFlagReaderSafetyContract.commitChainExpected);
    expect(current.commit_chain).toHaveLength(
      runtimeModeFlagReaderSafetyContract.expectedManifestShape.expectedCounts.commit_chain,
    );
    expect(current.commit_chain[current.commit_chain.length - 1]).toBe(BASELINE_COMMIT);
    expect(current.source_recommendation).toEqual(expect.objectContaining({
      recommendation_id: runtimeModeFlagReaderSafetyContract.sourceRecommendation.recommendation_id,
      tier: 'tier1',
      status: 'selected_for_phase44_fixture_only_contract',
      contract_only_now: true,
      implemented_now: false,
      does_not_authorize_flag_read: true,
      does_not_authorize_ui: true,
      does_not_authorize_runtime: true,
      does_not_authorize_execution: true,
    }));
    expect(current.satisfied_prior_recommendations[0]).toEqual(expect.objectContaining({
      recommendation_id: runtimeModeFlagReaderSafetyContract.satisfiedPriorRecommendations[0].recommendation_id,
      status: 'satisfied_by_78f5164_do_not_repeat_as_open_work',
      satisfied_by_commit: BASELINE_COMMIT,
      must_not_reopen: true,
    }));
    expect(current.next_phase_recommendations.map((item) => item.recommendation_id))
      .not.toContain(current.satisfied_prior_recommendations[0].recommendation_id);
    expect(current.current_truth).toEqual(expect.objectContaining(
      runtimeModeFlagReaderSafetyContract.currentTruthExpected,
    ));
    expect(current.current_truth.flag_reader_safety_remains_non_authorizing).toBe(true);
    expect(current.current_truth.no_env_config_flag_read_now).toBe(true);
  });

  test('keeps stale readiness, Phase34 prior recommendations, closures, source refs, and paths complete', () => {
    const output = build();
    const current = safety(output);

    expect(current.stale_readiness).toEqual(expect.objectContaining(
      runtimeModeFlagReaderSafetyContract.staleReadinessExpected,
    ));
    expect(current.phase34_prior_recommendations.phase35_runtime_status_milestone_refresh_validator.status)
      .toBe('satisfied_by_c04155d_do_not_repeat_as_open_work');
    expect(current.phase34_prior_recommendations.phase35_stdout_only_cli_smoke.status)
      .toBe('satisfied_by_c04155d_do_not_repeat_as_open_work');
    expect(current.closure_summary).toEqual(expect.objectContaining(
      runtimeModeFlagReaderSafetyContract.closureSummaryExpected,
    ));
    expect(current.closure_summary.closed_review_refs)
      .toEqual(runtimeModeFlagReaderSafetyContract.closureSummaryExpected.closed_review_refs);
    expect(current.source_refs).toEqual(runtimeModeFlagReaderSafetyContract.sourceRefsExpected);
    expect(current.source_refs).toHaveLength(
      runtimeModeFlagReaderSafetyContract.expectedManifestShape.expectedCounts.source_refs,
    );
    expect(validationReport(output).referenced_path_results.length).toBeGreaterThan(0);
    expect(validationReport(output).referenced_path_results.every((entry) => entry.ok)).toBe(true);
  });

  test('defines disabled runtime mode, flag-reader, env/config-read, and kill-switch boundaries', () => {
    const current = safety(build());

    expectRequiredFields(
      current.runtime_mode_boundary,
      runtimeModeFlagReaderSafetyContract.runtimeModeBoundaryShapeExpected.requiredFields,
    );
    expect(current.runtime_mode_boundary).toEqual(expect.objectContaining(
      runtimeModeFlagReaderSafetyContract.runtimeModeBoundaryShapeExpected.requiredValues,
    ));
    expectRequiredFields(
      current.flag_reader_boundary,
      runtimeModeFlagReaderSafetyContract.flagReaderBoundaryShapeExpected.requiredFields,
    );
    expect(current.flag_reader_boundary).toEqual(expect.objectContaining(
      runtimeModeFlagReaderSafetyContract.flagReaderBoundaryShapeExpected.requiredValues,
    ));
    expect(current.flag_reader_boundary.reader_implemented_now).toBe(false);
    expect(current.flag_reader_boundary.flagReader).toBe(false);
    expect(current.flag_reader_boundary.flagReadNow).toBe(false);
    expect(current.flag_reader_boundary.envReadNow).toBe(false);
    expect(current.flag_reader_boundary.configReadNow).toBe(false);
    expect(current.flag_reader_boundary.secretReadNow).toBe(false);
    expect(current.flag_reader_boundary.rawConfigExportNow).toBe(false);
    expectRequiredFields(
      current.env_config_read_boundary,
      runtimeModeFlagReaderSafetyContract.envConfigReadBoundaryShapeExpected.requiredFields,
    );
    expect(current.env_config_read_boundary).toEqual(expect.objectContaining(
      runtimeModeFlagReaderSafetyContract.envConfigReadBoundaryShapeExpected.requiredValues,
    ));
    expectRequiredFields(
      current.kill_switch_boundary,
      runtimeModeFlagReaderSafetyContract.killSwitchBoundaryShapeExpected.requiredFields,
    );
    expect(current.kill_switch_boundary).toEqual(expect.objectContaining(
      runtimeModeFlagReaderSafetyContract.killSwitchBoundaryShapeExpected.requiredValues,
    ));
  });

  test('keeps prerequisite gaps, implementation risk, risk register, and future slices blocked', () => {
    const current = safety(build());

    expect(current.prerequisite_gap_matrix.map((entry) => entry.gap_id))
      .toEqual(runtimeModeFlagReaderSafetyContract.prerequisiteGapMatrixExpected.map((entry) => entry.gap_id));
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
    expect(current.implementation_risk_boundary).toEqual(expect.objectContaining(
      runtimeModeFlagReaderSafetyContract.implementationRiskBoundaryShapeExpected.requiredValues,
    ));
    expect(current.risk_register.map((entry) => entry.risk_id))
      .toEqual(runtimeModeFlagReaderSafetyContract.riskRegisterExpected.map((entry) => entry.risk_id));
    expect(current.risk_register).toHaveLength(8);
    expect(current.blocked_future_slices.map((entry) => entry.slice_id))
      .toEqual(runtimeModeFlagReaderSafetyContract.blockedFutureSlicesExpected.map((entry) => entry.slice_id));
    expect(current.blocked_future_slices).toHaveLength(4);
    expect(current.blocked_future_slices[0]).toEqual(expect.objectContaining({
      slice_id: 'runtime-mode-flag-reader',
      blocked_now: true,
      authorizes_runtime: false,
      authorizes_flag_read: false,
    }));
  });

  test('preserves capability, proof, redaction, and no-side-effect boundaries', () => {
    const output = build();
    const current = safety(output);

    expect(current.capability_matrix).toEqual(expect.objectContaining(
      runtimeModeFlagReaderSafetyContract.capabilityMatrixExpected,
    ));
    expect(current.boundary_truth).toEqual(expect.objectContaining(
      runtimeModeFlagReaderSafetyContract.proofBoundaryExpected,
    ));
    expect(current.redaction_summary).toEqual(expect.objectContaining({
      raw_private_content_included: false,
      raw_terminal_included: false,
      raw_screenshot_ocr_browser_included: false,
      secret_material_included: false,
      customer_private_content_included: false,
      raw_config_included: false,
    }));
    for (const field of Object.keys(runtimeModeFlagReaderSafetyContract.sideEffectTruthExpected)) {
      expect(current.side_effect_result[field]).toBe(true);
      expect(validationReport(output).side_effect_truth[field]).toBe(true);
    }
    expect(current.side_effect_result.outputFileWritten).toBe(false);
    expect(current.side_effect_result.runtimeModeFlagRead).toBe(false);
    expect(current.side_effect_result.envReadPerformed).toBe(false);
    expect(current.side_effect_result.configReadPerformed).toBe(false);
    expect(current.side_effect_result.flagReadPerformed).toBe(false);
  });

  test('next recommendations are Tier0/Tier1, non-authorizing, and match fixture candidates', () => {
    const current = safety(build());

    expect(current.next_phase_recommendations).toHaveLength(
      runtimeModeFlagReaderSafetyContract.nextRecommendationExpectedCandidates.length,
    );
    expect(current.next_phase_recommendations).toEqual(expect.arrayContaining(
      runtimeModeFlagReaderSafetyContract.nextRecommendationExpectedCandidates
        .map((candidate) => expect.objectContaining(candidate)),
    ));
    for (const recommendation of current.next_phase_recommendations) {
      expect(['tier0', 'tier1']).toContain(recommendation.tier);
      expect(recommendation.does_not_authorize_ui).toBe(true);
      expect(recommendation.does_not_authorize_runtime).toBe(true);
      expect(recommendation.does_not_authorize_execution).toBe(true);
      expect(recommendation.does_not_authorize_flag_read).toBe(true);
      expect(recommendation.blocked_side_effects.length).toBeGreaterThan(0);
    }
  });

  test('static rules, acceptance checks, tamper cases, literal checks, and referenced paths are represented', () => {
    const output = build();
    const validation = validateMiraCoreRuntimeModeFlagReaderSafetyOutput(
      output,
      runtimeModeFlagReaderSafetyContract,
    );
    const checkIds = validation.checks.map((entry) => entry.id);
    const staticIds = validationReport(output).static_rule_results.map((entry) => entry.id);
    const acceptanceIds = validationReport(output).acceptance_check_results.map((entry) => entry.id);

    expect(validation.ok).toBe(true);
    for (const rule of runtimeModeFlagReaderSafetyContract.staticValidationRules) {
      expect(checkIds).toContain(rule.id);
      expect(staticIds).toContain(rule.id);
    }
    for (const check of runtimeModeFlagReaderSafetyContract.acceptanceChecks) {
      expect(checkIds).toContain(check.id);
      expect(acceptanceIds).toContain(check.id);
    }
    expect(validationReport(output).tamper_case_results).toHaveLength(
      runtimeModeFlagReaderSafetyContract.tamperCases.length,
    );
    expect(validationReport(output).tamper_case_results.length)
      .toBeGreaterThanOrEqual(
        runtimeModeFlagReaderSafetyContract.expectedManifestShape.expectedCounts.tamper_case_results_min,
      );
    expect(validationReport(output).required_literal_results.length)
      .toBeGreaterThanOrEqual(
        runtimeModeFlagReaderSafetyContract.expectedManifestShape.expectedCounts.required_literal_results_min,
      );
    expect(validationReport(output).required_literal_results.every((entry) => entry.ok)).toBe(true);
    expect(validationReport(output).referenced_path_results.every((entry) => entry.ok)).toBe(true);
  });

  test('idempotency is stable for equivalent inputs and sensitive to flag-reader changes', () => {
    const first = safety(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'VIGIL' }));
    const second = safety(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'VIGIL' }));
    const changedDevice = safety(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'ALT' }));
    const changedProfile = safety(build({ profile: { name: 'side' }, sessionId: 'session-a', deviceId: 'VIGIL' }));

    expect(first.idempotency_key).toBe(second.idempotency_key);
    expect(first.safety_id).toBe(second.safety_id);
    expect(first.idempotency_key).not.toBe(changedDevice.idempotency_key);
    expect(first.idempotency_key).not.toBe(changedProfile.idempotency_key);

    const changed = clone(build());
    const originalKey = safety(changed).idempotency_key;
    safety(changed).flag_reader_boundary.flagReadNow = true;
    recomputeSafetyKey(changed);
    expect(safety(changed).idempotency_key).not.toBe(originalKey);
    expectValidatorFails(changed, 'flag-reader-boundary-contract-only');
  });

  test('validator rejects baseline, registry, source, stale, closure, source-ref, and path drift', () => {
    const baseline = clone(build());
    safety(baseline).baseline_commit = '5b3de99';
    recomputeSafetyKey(baseline);
    expectValidatorFails(baseline, 'baseline-pinned-78f5164');

    const phase43 = clone(build());
    safety(phase43).phase_registry.phase43_implementation_risk_current = false;
    recomputeSafetyKey(phase43);
    expectValidatorFails(phase43, 'phase43-current');

    const count = clone(build());
    safety(count).phase_registry.phase_inventory_count = 42;
    recomputeSafetyKey(count);
    expectValidatorFails(count, 'phase-inventory-count-43');

    const chain = clone(build());
    safety(chain).commit_chain = safety(chain).commit_chain.filter((commit) => commit !== BASELINE_COMMIT);
    recomputeSafetyKey(chain);
    expectValidatorFails(chain, 'commit-chain-exact-31');

    const source = clone(build());
    safety(source).source_recommendation.recommendation_id = 'phase44-runtime-mode-kill-switch-implementation-risk-validator';
    recomputeSafetyKey(source);
    expectValidatorFails(source, 'source-recommendation-tier1-selected');

    const satisfied = clone(build());
    safety(satisfied).satisfied_prior_recommendations[0].status = 'open';
    recomputeSafetyKey(satisfied);
    expectValidatorFails(satisfied, 'phase43-tier0-satisfied-not-open');

    const stale13 = clone(build());
    safety(stale13).stale_readiness.phase13_readiness_current = true;
    recomputeSafetyKey(stale13);
    expectValidatorFails(stale13, 'phase13-stale-preserved');

    const missingClosure = clone(build());
    safety(missingClosure).closure_summary.phase43_oracle_171_read_only_review_green = false;
    recomputeSafetyKey(missingClosure);
    expectValidatorFails(missingClosure, 'closures-carried-oracle-115-123-127-131-134-137-141-148-149-156-161-165-168-171');

    const missingRef = clone(build());
    safety(missingRef).source_refs = safety(missingRef).source_refs
      .filter((ref) => ref.artifact_id !== 'phase43-runtime-mode-kill-switch-implementation-risk');
    recomputeSafetyKey(missingRef);
    expectValidatorFails(missingRef, 'source-refs-phase26-27-29-30-32-33-37-38-39-40-41-42-43');
  });

  test('validator rejects runtime-mode, flag-reader, env/config-read, kill-switch, and gap drift', () => {
    const modeEnabled = clone(build());
    safety(modeEnabled).runtime_mode_boundary.effective_state = 'enabled';
    recomputeSafetyKey(modeEnabled);
    expectValidatorFails(modeEnabled, 'runtime-mode-boundary-disabled-reference-only');

    const reader = clone(build());
    safety(reader).flag_reader_boundary.reader_implemented_now = true;
    recomputeSafetyKey(reader);
    expectValidatorFails(reader, 'flag-reader-boundary-contract-only');
    expectValidatorFails(reader, 'flag-reader-boundary-no-reader');

    const flagRead = clone(build());
    safety(flagRead).flag_reader_boundary.flagReadNow = true;
    recomputeSafetyKey(flagRead);
    expectValidatorFails(flagRead, 'flag-reader-boundary-no-env-config-flag-secret-read');

    const envRead = clone(build());
    safety(envRead).flag_reader_boundary.envReadNow = true;
    recomputeSafetyKey(envRead);
    expectValidatorFails(envRead, 'flag-reader-boundary-no-env-config-flag-secret-read');

    const configRead = clone(build());
    safety(configRead).env_config_read_boundary.config_read_performed = true;
    recomputeSafetyKey(configRead);
    expectValidatorFails(configRead, 'env-config-read-boundary-none');
    expectValidatorFails(configRead, 'env-config-read-boundary-no-reads');

    const processEnv = clone(build());
    safety(processEnv).env_config_read_boundary.process_env_accessed = true;
    recomputeSafetyKey(processEnv);
    expectValidatorFails(processEnv, 'env-config-read-boundary-none');

    const killWired = clone(build());
    safety(killWired).kill_switch_boundary.killWired = true;
    recomputeSafetyKey(killWired);
    expectValidatorFails(killWired, 'kill-switch-boundary-fail-closed-reference-only');

    const gapSatisfied = clone(build());
    safety(gapSatisfied).prerequisite_gap_matrix[0].satisfied_now = true;
    recomputeSafetyKey(gapSatisfied);
    expectValidatorFails(gapSatisfied, 'prerequisite-gap-matrix-two-unsatisfied-gaps');
    expectValidatorFails(gapSatisfied, 'flag-reader-safety-does-not-satisfy-runtime-gap');
  });

  test('validator rejects implementation-risk, risk-register, and blocked-slice drift', () => {
    const implementationAllowed = clone(build());
    safety(implementationAllowed).implementation_risk_boundary.runtime_mode_flag_reader_allowed_now = true;
    recomputeSafetyKey(implementationAllowed);
    expectValidatorFails(implementationAllowed, 'implementation-risk-boundary-non-authorizing');

    const missingRisk = clone(build());
    safety(missingRisk).risk_register = safety(missingRisk).risk_register
      .filter((entry) => entry.risk_id !== 'runtime-mode-env-secret-read-risk');
    recomputeSafetyKey(missingRisk);
    expectValidatorFails(missingRisk, 'risk-register-eight-blocking-risks');

    const riskSatisfied = clone(build());
    safety(riskSatisfied).risk_register[0].satisfied_now = true;
    recomputeSafetyKey(riskSatisfied);
    expectValidatorFails(riskSatisfied, 'risk-register-eight-blocking-risks');

    const sliceUnblocked = clone(build());
    safety(sliceUnblocked).blocked_future_slices[0].blocked_now = false;
    recomputeSafetyKey(sliceUnblocked);
    expectValidatorFails(sliceUnblocked, 'future-flag-reader-slice-blocked-now');

    const sliceAuth = clone(build());
    safety(sliceAuth).blocked_future_slices[0].authorizes_flag_read = true;
    recomputeSafetyKey(sliceAuth);
    expectValidatorFails(sliceAuth, 'runtime-mode-flag-reader-slice-blocked');
  });

  test('validator rejects capability, proof, side-effect, scope, and redaction overclaims', () => {
    const runtime = clone(build());
    safety(runtime).capability_matrix.runtimeStarted = true;
    safety(runtime).boundary_truth.runtimeStarted = true;
    safety(runtime).side_effect_result.runtimeStarted = true;
    recomputeSafetyKey(runtime);
    expectValidatorFails(runtime, 'capability-truth-false');
    expectValidatorFails(runtime, 'runtime-started-false');

    const flagAvailable = clone(build());
    safety(flagAvailable).capability_matrix.runtimeModeFlagReaderAvailable = true;
    recomputeSafetyKey(flagAvailable);
    expectValidatorFails(flagAvailable, 'runtime-mode-flag-reader-available-false');

    const proof = clone(build());
    safety(proof).boundary_truth.flagReaderSafetyIsFlagReadAuthorization = true;
    recomputeSafetyKey(proof);
    expectValidatorFails(proof, 'proof-boundaries-false');

    const directTarget = clone(build());
    safety(directTarget).capability_matrix.directBuilderOracleServerTargetsAllowed = true;
    safety(directTarget).boundary_truth.builderOracleDirectServerTargetsAllowed = true;
    recomputeSafetyKey(directTarget);
    expectValidatorFails(directTarget, 'builder-oracle-direct-targets-blocked');

    const outputFile = clone(build());
    safety(outputFile).side_effect_result.no_output_file_written = false;
    safety(outputFile).side_effect_result.outputFilesWritten = 1;
    recomputeSafetyKey(outputFile);
    expectValidatorFails(outputFile, 'side-effect-truth-all-blocked');

    const envSideEffect = clone(build());
    safety(envSideEffect).side_effect_result.no_env_or_config_read = false;
    safety(envSideEffect).side_effect_result.envReadPerformed = true;
    recomputeSafetyKey(envSideEffect);
    expectValidatorFails(envSideEffect, 'side-effect-truth-all-blocked');
    expectValidatorFails(envSideEffect, 'no-env-config-flag-read-side-effect');

    const rawSecret = clone(build());
    safety(rawSecret).redaction_summary.note = 'raw bearer token';
    recomputeSafetyKey(rawSecret);
    expectValidatorFails(rawSecret, 'redaction-summary-safe');
    expectValidatorFails(rawSecret, 'forbidden-output-strings-absent');
  });

  test('validator rejects unsafe next-action drift and Tier2+ recommendations after idempotency recompute', () => {
    const readEnv = clone(build());
    safety(readEnv).next_phase_recommendations[0].action = 'read env flag';
    recomputeSafetyKey(readEnv);
    expectValidatorFails(readEnv, 'unsafe-action-drift-blocked');

    const readConfig = clone(build());
    safety(readConfig).next_phase_recommendations[0].why_safe = 'read config for runtime mode';
    recomputeSafetyKey(readConfig);
    expectValidatorFails(readConfig, 'unsafe-action-drift-blocked');

    const wireKill = clone(build());
    safety(wireKill).next_phase_recommendations[0].action = 'wire kill switch now';
    recomputeSafetyKey(wireKill);
    expectValidatorFails(wireKill, 'unsafe-action-drift-blocked');

    const tier2 = clone(build());
    safety(tier2).next_phase_recommendations[0].tier = 'tier2';
    recomputeSafetyKey(tier2);
    expectValidatorFails(tier2, 'next-recommendations-tier0-tier1-only');

    const customerSend = clone(build());
    safety(customerSend).next_phase_recommendations[0].why_safe = 'safe to send customer message';
    recomputeSafetyKey(customerSend);
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
    safety(literalLie).baseline_commit = '5b3de99';
    recomputeSafetyKey(literalLie);
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
    expect(parsed.fixturePath).toContain('mira-core-runtime-mode-flag-reader-safety-contract.json');

    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const output = main(['--out=ignored.json'], JSON.stringify({
      profile: { name: 'main' },
      sessionId: 'session-cli',
      deviceId: 'VIGIL',
    }));

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(safety(output).schema).toBe(RUNTIME_MODE_FLAG_READER_SAFETY_SCHEMA_VERSION);
    expect(safety(output).sessionId).toBe('session-cli');
    expect(safety(output).baseline_commit).toBe(BASELINE_COMMIT);
    expect(safety(output).phase_registry.current_through_phase).toBe(43);
    expect(safety(output).phase_registry.phase_inventory_count).toBe(43);
    expect(safety(output).schema_registry).toHaveLength(43);
    expect(safety(output).cli_registry).toHaveLength(43);
    expect(safety(output).commit_chain).toHaveLength(31);
    expect(safety(output).source_refs).toHaveLength(13);
    expect(safety(output).prerequisite_gap_matrix).toHaveLength(2);
    expect(safety(output).risk_register).toHaveLength(8);
    expect(safety(output).blocked_future_slices).toHaveLength(4);
    expect(safety(output).flag_reader_boundary.reader_implemented_now).toBe(false);
    expect(safety(output).flag_reader_boundary.flagReadNow).toBe(false);
    expect(safety(output).env_config_read_boundary.env_read_performed).toBe(false);
    expect(safety(output).env_config_read_boundary.config_read_performed).toBe(false);
    expect(safety(output).kill_switch_boundary.killWired).toBe(false);
    expect(safety(output).capability_matrix.runtimeStarted).toBe(false);
    expect(safety(output).capability_matrix.runtimeModeFlagReaderAvailable).toBe(false);
    expect(safety(output).capability_matrix.serverCanExecuteLocal).toBe(false);
    expect(safety(output).side_effect_result.no_output_file_written).toBe(true);
    expect(safety(output).side_effect_result.no_runtime_mode_flag_read).toBe(true);
    expect(safety(output).side_effect_result.no_env_or_config_read).toBe(true);
    expect(validationReport(output).decision).toBe('accepted_validation_only');
    expect(validateMiraCoreRuntimeModeFlagReaderSafetyOutput(
      output,
      runtimeModeFlagReaderSafetyContract,
    )).toEqual(expect.objectContaining({ ok: true }));
  });
});
