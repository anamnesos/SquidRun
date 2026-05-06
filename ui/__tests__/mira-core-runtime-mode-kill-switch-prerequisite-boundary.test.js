const runtimeModeKillSwitchPrerequisiteBoundaryContract = require('./fixtures/mira-core-runtime-mode-kill-switch-prerequisite-boundary-contract.json');
const {
  BASELINE_COMMIT,
  REQUIRED_BOUNDARY_FIELDS,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_SIDE_EFFECT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  RUNTIME_MODE_KILL_SWITCH_PREREQUISITE_BOUNDARY_SCHEMA_VERSION,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreRuntimeModeKillSwitchPrerequisiteBoundary,
  runtimeModeKillSwitchPrerequisiteBoundaryIdempotencyKey,
  validateMiraCoreRuntimeModeKillSwitchPrerequisiteBoundaryOutput,
} = require('../modules/mira-core/runtime-mode-kill-switch-prerequisite-boundary');
const {
  main,
  parseArgs,
} = require('../scripts/hm-mira-core-runtime-mode-kill-switch-prerequisite-boundary');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function build(inputSignals = {}) {
  return buildMiraCoreRuntimeModeKillSwitchPrerequisiteBoundary({
    contract: runtimeModeKillSwitchPrerequisiteBoundaryContract,
    inputSignals,
    nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
  });
}

function boundary(output) {
  return output.runtime_mode_kill_switch_prerequisite_boundary;
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
    runtimeModeKillSwitchPrerequisiteBoundaryContract.forbiddenOutputSubstrings,
  )).not.toThrow();
}

function expectValidatorFails(output, checkId) {
  const validation = validateMiraCoreRuntimeModeKillSwitchPrerequisiteBoundaryOutput(
    output,
    runtimeModeKillSwitchPrerequisiteBoundaryContract,
  );
  expect(validation.ok).toBe(false);
  expect(validation.checks.some((entry) => entry.id === checkId && entry.ok === false)).toBe(true);
}

function recomputeBoundaryKey(output) {
  boundary(output).idempotency_key =
    runtimeModeKillSwitchPrerequisiteBoundaryIdempotencyKey(boundary(output));
}

describe('mira core runtime mode kill-switch prerequisite boundary v0', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('satisfies Oracle top-level, manifest, and validation report shapes', () => {
    const output = build();
    const current = boundary(output);
    const report = validationReport(output);

    expectRequiredFields(output, runtimeModeKillSwitchPrerequisiteBoundaryContract.expectedOutputShape.requiredTopLevelFields);
    expect(runtimeModeKillSwitchPrerequisiteBoundaryContract.expectedOutputShape.requiredTopLevelFields)
      .toEqual(REQUIRED_OUTPUT_FIELDS);
    expect(current.schema).toBe(RUNTIME_MODE_KILL_SWITCH_PREREQUISITE_BOUNDARY_SCHEMA_VERSION);
    expect(report.schema).toBe(VALIDATION_REPORT_SCHEMA_VERSION);
    expectRequiredFields(current, runtimeModeKillSwitchPrerequisiteBoundaryContract.expectedManifestShape.requiredFields);
    expect(runtimeModeKillSwitchPrerequisiteBoundaryContract.expectedManifestShape.requiredFields)
      .toEqual(REQUIRED_BOUNDARY_FIELDS);
    expectRequiredFields(report, runtimeModeKillSwitchPrerequisiteBoundaryContract.expectedValidationReportShape.requiredFields);
    expect(runtimeModeKillSwitchPrerequisiteBoundaryContract.expectedValidationReportShape.requiredFields)
      .toEqual(REQUIRED_VALIDATION_REPORT_FIELDS);
    expect(report.accepted).toBe(true);
    expect(report.blocked).toBe(false);
    expect(report.decision).toBe('accepted_validation_only');
    expect(validateMiraCoreRuntimeModeKillSwitchPrerequisiteBoundaryOutput(
      output,
      runtimeModeKillSwitchPrerequisiteBoundaryContract,
    )).toEqual(expect.objectContaining({ ok: true }));
    expectNoForbiddenOutput(output);
  });

  test('pins baseline 833f9c1 and registries through Phase 41', () => {
    const current = boundary(build());
    const expected = runtimeModeKillSwitchPrerequisiteBoundaryContract.phaseRegistryExpected;

    expect(BASELINE_COMMIT).toBe(runtimeModeKillSwitchPrerequisiteBoundaryContract.baseline.commit);
    expect(current.baseline_commit).toBe(BASELINE_COMMIT);
    expect(current.phase_registry).toEqual(expect.objectContaining({
      source_ref: expected.source_ref,
      current_through_phase: 41,
      expected_phases: '1-41',
      phase_inventory_count: 41,
      schema_registry_count: 41,
      cli_registry_count: 41,
      phase35_runtime_next_action_current: true,
      phase36_operator_ui_surface_current: true,
      phase37_control_reporting_reconciliation_current: true,
      phase38_runtime_readiness_refresh_current: true,
      phase39_dry_run_readiness_gap_current: true,
      phase40_runtime_mode_kill_switch_current: true,
      phase41_status_gap_refresh_current: true,
      phase41_commit: BASELINE_COMMIT,
    }));
    expect(current.phase_registry.phase41_delta).toEqual(expect.objectContaining(expected.phase41_delta));
    expect(current.schema_registry).toHaveLength(41);
    expect(current.cli_registry).toHaveLength(41);
    expect(current.phase_registry.recent_phase_paths).toEqual(expected.required_recent_phase_paths);
  });

  test('preserves commit chain, selected source recommendation, satisfied Phase41 work, and current truth', () => {
    const current = boundary(build());

    expect(current.commit_chain).toEqual(runtimeModeKillSwitchPrerequisiteBoundaryContract.commitChainExpected);
    expect(current.commit_chain).toHaveLength(
      runtimeModeKillSwitchPrerequisiteBoundaryContract.expectedManifestShape.expectedCounts.commit_chain,
    );
    expect(current.commit_chain[current.commit_chain.length - 1]).toBe(BASELINE_COMMIT);
    expect(current.source_recommendation).toEqual(expect.objectContaining({
      recommendation_id: runtimeModeKillSwitchPrerequisiteBoundaryContract.sourceRecommendation.recommendation_id,
      tier: 'tier1',
      status: 'selected_for_phase42_fixture_only_contract',
      contract_only_now: true,
      implemented_now: false,
      does_not_authorize_ui: true,
      does_not_authorize_runtime: true,
      does_not_authorize_execution: true,
    }));
    expect(current.satisfied_prior_recommendations[0]).toEqual(expect.objectContaining({
      recommendation_id: runtimeModeKillSwitchPrerequisiteBoundaryContract.satisfiedPriorRecommendations[0].recommendation_id,
      status: 'satisfied_by_833f9c1_do_not_repeat_as_open_work',
      satisfied_by_commit: BASELINE_COMMIT,
      must_not_reopen: true,
    }));
    expect(current.next_phase_recommendations.map((item) => item.recommendation_id))
      .not.toContain(current.satisfied_prior_recommendations[0].recommendation_id);
    expect(current.current_truth).toEqual(expect.objectContaining(
      runtimeModeKillSwitchPrerequisiteBoundaryContract.currentTruthExpected,
    ));
    expect(current.current_truth.runtime_mode_and_kill_switch_remain_non_authorizing).toBe(true);
  });

  test('keeps stale readiness, Phase34 prior recommendations, Oracle closures, source refs, and paths complete', () => {
    const output = build();
    const current = boundary(output);

    expect(current.stale_readiness).toEqual(expect.objectContaining(
      runtimeModeKillSwitchPrerequisiteBoundaryContract.staleReadinessExpected,
    ));
    expect(current.phase34_prior_recommendations.phase35_runtime_status_milestone_refresh_validator.status)
      .toBe('satisfied_by_c04155d_do_not_repeat_as_open_work');
    expect(current.phase34_prior_recommendations.phase35_stdout_only_cli_smoke.status)
      .toBe('satisfied_by_c04155d_do_not_repeat_as_open_work');
    expect(current.closure_summary).toEqual(expect.objectContaining(
      runtimeModeKillSwitchPrerequisiteBoundaryContract.closureSummaryExpected,
    ));
    expect(current.closure_summary.closed_review_refs)
      .toEqual(runtimeModeKillSwitchPrerequisiteBoundaryContract.closureSummaryExpected.closed_review_refs);
    expect(current.source_refs).toEqual(runtimeModeKillSwitchPrerequisiteBoundaryContract.sourceRefsExpected);
    expect(current.source_refs).toHaveLength(
      runtimeModeKillSwitchPrerequisiteBoundaryContract.expectedManifestShape.expectedCounts.source_refs,
    );
    expect(validationReport(output).referenced_path_results.length).toBeGreaterThan(0);
    expect(validationReport(output).referenced_path_results.every((entry) => entry.ok)).toBe(true);
  });

  test('defines contract-only prerequisite, disabled runtime mode, and fail-closed unwired kill-switch boundaries', () => {
    const current = boundary(build());

    expectRequiredFields(
      current.prerequisite_boundary,
      runtimeModeKillSwitchPrerequisiteBoundaryContract.prerequisiteBoundaryShapeExpected.requiredFields,
    );
    expect(current.prerequisite_boundary).toEqual(expect.objectContaining(
      runtimeModeKillSwitchPrerequisiteBoundaryContract.prerequisiteBoundaryShapeExpected.requiredValues,
    ));
    expect(current.prerequisite_boundary.future_implementation_requires.length).toBeGreaterThan(0);
    expectRequiredFields(
      current.runtime_mode_boundary,
      runtimeModeKillSwitchPrerequisiteBoundaryContract.runtimeModeBoundaryShapeExpected.requiredFields,
    );
    expect(current.runtime_mode_boundary).toEqual(expect.objectContaining(
      runtimeModeKillSwitchPrerequisiteBoundaryContract.runtimeModeBoundaryShapeExpected.requiredValues,
    ));
    expect(current.runtime_mode_boundary.source_ref).toBe('phase41-runtime-mode-kill-switch-status-gap-refresh');
    expectRequiredFields(
      current.kill_switch_boundary,
      runtimeModeKillSwitchPrerequisiteBoundaryContract.killSwitchBoundaryShapeExpected.requiredFields,
    );
    expect(current.kill_switch_boundary).toEqual(expect.objectContaining(
      runtimeModeKillSwitchPrerequisiteBoundaryContract.killSwitchBoundaryShapeExpected.requiredValues,
    ));
    expect(current.kill_switch_boundary.source_ref).toBe('phase41-runtime-mode-kill-switch-status-gap-refresh');
    expect(current.kill_switch_boundary.killWired).toBe(false);
    expect(current.kill_switch_boundary.liveCheck).toBe(false);
  });

  test('keeps exactly two prerequisite gaps unsatisfied, blocking, reference-only, and non-authorizing', () => {
    const current = boundary(build());
    const expected = runtimeModeKillSwitchPrerequisiteBoundaryContract.prerequisiteGapMatrixExpected;

    expect(current.prerequisite_gap_matrix.map((entry) => entry.gap_id))
      .toEqual(expected.map((entry) => entry.gap_id));
    expect(current.prerequisite_gap_matrix).toHaveLength(
      runtimeModeKillSwitchPrerequisiteBoundaryContract.expectedManifestShape.expectedCounts.prerequisite_gap_matrix,
    );
    for (const gap of current.prerequisite_gap_matrix) {
      const expectedGap = expected.find((item) => item.gap_id === gap.gap_id);
      expect(gap).toEqual(expect.objectContaining({
        maps_from_phase41_gap: expectedGap.maps_from_phase41_gap,
        status: 'unsatisfied_blocking_reference_only',
        reference_contract_only: true,
        satisfied_now: false,
        blocks_runtime_now: true,
        blocks_dry_run_now: true,
        authorizes_runtime: false,
        authorizes_dry_run: false,
        authorizes_execution: false,
      }));
      expect(gap.future_green_requires).toEqual(expectedGap.future_green_requires);
    }
  });

  test('preserves capability, proof, redaction, and no-side-effect boundaries', () => {
    const output = build();
    const current = boundary(output);

    expect(current.capability_matrix).toEqual(expect.objectContaining(
      runtimeModeKillSwitchPrerequisiteBoundaryContract.capabilityMatrixExpected,
    ));
    expect(current.boundary_truth).toEqual(expect.objectContaining(
      runtimeModeKillSwitchPrerequisiteBoundaryContract.proofBoundaryExpected,
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
    expect(current.side_effect_result.reportingSinkWritten).toBe(false);
  });

  test('next recommendations are Tier0/Tier1, non-authorizing, and match fixture candidates', () => {
    const current = boundary(build());

    expect(current.next_phase_recommendations).toHaveLength(
      runtimeModeKillSwitchPrerequisiteBoundaryContract.nextRecommendationExpectedCandidates.length,
    );
    expect(current.next_phase_recommendations).toEqual(expect.arrayContaining(
      runtimeModeKillSwitchPrerequisiteBoundaryContract.nextRecommendationExpectedCandidates
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
    const validation = validateMiraCoreRuntimeModeKillSwitchPrerequisiteBoundaryOutput(
      output,
      runtimeModeKillSwitchPrerequisiteBoundaryContract,
    );
    const checkIds = validation.checks.map((entry) => entry.id);
    const staticIds = validationReport(output).static_rule_results.map((entry) => entry.id);
    const acceptanceIds = validationReport(output).acceptance_check_results.map((entry) => entry.id);

    expect(validation.ok).toBe(true);
    for (const rule of runtimeModeKillSwitchPrerequisiteBoundaryContract.staticValidationRules) {
      expect(checkIds).toContain(rule.id);
      expect(staticIds).toContain(rule.id);
    }
    for (const check of runtimeModeKillSwitchPrerequisiteBoundaryContract.acceptanceChecks) {
      expect(checkIds).toContain(check.id);
      expect(acceptanceIds).toContain(check.id);
    }
    expect(validationReport(output).tamper_case_results).toHaveLength(
      runtimeModeKillSwitchPrerequisiteBoundaryContract.tamperCases.length,
    );
    expect(validationReport(output).tamper_case_results.length)
      .toBeGreaterThanOrEqual(
        runtimeModeKillSwitchPrerequisiteBoundaryContract.expectedManifestShape.expectedCounts.tamper_case_results_min,
      );
    expect(validationReport(output).required_literal_results.length)
      .toBeGreaterThanOrEqual(
        runtimeModeKillSwitchPrerequisiteBoundaryContract.expectedManifestShape.expectedCounts.required_literal_results_min,
      );
    expect(validationReport(output).required_literal_results.every((entry) => entry.ok)).toBe(true);
    expect(validationReport(output).referenced_path_results.every((entry) => entry.ok)).toBe(true);
  });

  test('idempotency is stable for equivalent inputs and sensitive to prerequisite boundary changes', () => {
    const first = boundary(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'VIGIL' }));
    const second = boundary(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'VIGIL' }));
    const changedDevice = boundary(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'ALT' }));
    const changedProfile = boundary(build({ profile: { name: 'side' }, sessionId: 'session-a', deviceId: 'VIGIL' }));

    expect(first.idempotency_key).toBe(second.idempotency_key);
    expect(first.boundary_id).toBe(second.boundary_id);
    expect(first.idempotency_key).not.toBe(changedDevice.idempotency_key);
    expect(first.idempotency_key).not.toBe(changedProfile.idempotency_key);

    const changed = clone(build());
    const originalKey = boundary(changed).idempotency_key;
    boundary(changed).prerequisite_boundary.flag_reader_allowed_now = true;
    recomputeBoundaryKey(changed);
    expect(boundary(changed).idempotency_key).not.toBe(originalKey);
    expectValidatorFails(changed, 'prerequisite-boundary-contract-only');
  });

  test('validator rejects baseline, registry, source, stale, closure, source-ref, and path drift', () => {
    const baseline = clone(build());
    boundary(baseline).baseline_commit = 'def3f3b';
    recomputeBoundaryKey(baseline);
    expectValidatorFails(baseline, 'baseline-pinned-833f9c1');

    const phase41 = clone(build());
    boundary(phase41).phase_registry.phase41_status_gap_refresh_current = false;
    recomputeBoundaryKey(phase41);
    expectValidatorFails(phase41, 'phase41-current');

    const count = clone(build());
    boundary(count).phase_registry.phase_inventory_count = 40;
    recomputeBoundaryKey(count);
    expectValidatorFails(count, 'phase-inventory-count-41');

    const chain = clone(build());
    boundary(chain).commit_chain = boundary(chain).commit_chain.filter((commit) => commit !== BASELINE_COMMIT);
    recomputeBoundaryKey(chain);
    expectValidatorFails(chain, 'commit-chain-exact-29');

    const source = clone(build());
    boundary(source).source_recommendation.recommendation_id = 'phase42-runtime-mode-kill-switch-status-gap-refresh-validator';
    recomputeBoundaryKey(source);
    expectValidatorFails(source, 'source-recommendation-tier1-selected');

    const satisfied = clone(build());
    boundary(satisfied).satisfied_prior_recommendations[0].status = 'open';
    recomputeBoundaryKey(satisfied);
    expectValidatorFails(satisfied, 'phase41-tier0-satisfied-not-open');

    const stale13 = clone(build());
    boundary(stale13).stale_readiness.phase13_readiness_current = true;
    recomputeBoundaryKey(stale13);
    expectValidatorFails(stale13, 'phase13-stale-preserved');

    const missingClosure = clone(build());
    boundary(missingClosure).closure_summary.phase41_oracle_165_read_only_review_green = false;
    recomputeBoundaryKey(missingClosure);
    expectValidatorFails(missingClosure, 'closures-carried-oracle-115-123-127-131-134-137-141-148-149-156-161-165');

    const missingRef = clone(build());
    boundary(missingRef).source_refs = boundary(missingRef).source_refs
      .filter((ref) => ref.artifact_id !== 'phase41-runtime-mode-kill-switch-status-gap-refresh');
    recomputeBoundaryKey(missingRef);
    expectValidatorFails(missingRef, 'source-refs-phase26-27-29-30-32-33-37-38-39-40-41');

    const missingPath = clone(build());
    boundary(missingPath).phase_registry.recent_phase_paths = boundary(missingPath).phase_registry.recent_phase_paths
      .filter((entry) => entry.phase !== 41);
    recomputeBoundaryKey(missingPath);
    expectValidatorFails(missingPath, 'recent-phase-paths-present');
  });

  test('validator rejects prerequisite, runtime-mode, kill-switch, and gap drift', () => {
    const preRuntime = clone(build());
    boundary(preRuntime).prerequisite_boundary.runtime_authorized_now = true;
    recomputeBoundaryKey(preRuntime);
    expectValidatorFails(preRuntime, 'prerequisite-boundary-contract-only');

    const preFlag = clone(build());
    boundary(preFlag).prerequisite_boundary.flag_reader_allowed_now = true;
    recomputeBoundaryKey(preFlag);
    expectValidatorFails(preFlag, 'prerequisite-boundary-contract-only');

    const modeEnabled = clone(build());
    boundary(modeEnabled).runtime_mode_boundary.effective_state = 'dry_run_preview_only';
    recomputeBoundaryKey(modeEnabled);
    expectValidatorFails(modeEnabled, 'runtime-mode-boundary-disabled-reference-only');

    const flagReader = clone(build());
    boundary(flagReader).runtime_mode_boundary.flag_reader_implemented = true;
    recomputeBoundaryKey(flagReader);
    expectValidatorFails(flagReader, 'runtime-mode-boundary-disabled-reference-only');

    const flagReadNow = clone(build());
    boundary(flagReadNow).runtime_mode_boundary.flag_read_now = true;
    recomputeBoundaryKey(flagReadNow);
    expectValidatorFails(flagReadNow, 'runtime-mode-boundary-disabled-reference-only');

    const killWired = clone(build());
    boundary(killWired).kill_switch_boundary.killWired = true;
    recomputeBoundaryKey(killWired);
    expectValidatorFails(killWired, 'kill-switch-boundary-fail-closed-reference-only');

    const killLive = clone(build());
    boundary(killLive).kill_switch_boundary.liveCheck = true;
    recomputeBoundaryKey(killLive);
    expectValidatorFails(killLive, 'kill-switch-boundary-fail-closed-reference-only');

    const gapSatisfied = clone(build());
    boundary(gapSatisfied).prerequisite_gap_matrix[0].satisfied_now = true;
    recomputeBoundaryKey(gapSatisfied);
    expectValidatorFails(gapSatisfied, 'prerequisite-gap-matrix-two-unsatisfied-gaps');
    expectValidatorFails(gapSatisfied, 'prerequisite-boundary-does-not-satisfy-gaps');
  });

  test('validator rejects capability, proof, side-effect, scope, and redaction overclaims', () => {
    const runtime = clone(build());
    boundary(runtime).capability_matrix.runtimeStarted = true;
    boundary(runtime).boundary_truth.runtimeStarted = true;
    boundary(runtime).side_effect_result.runtimeStarted = true;
    recomputeBoundaryKey(runtime);
    expectValidatorFails(runtime, 'capability-truth-false');
    expectValidatorFails(runtime, 'runtime-started-false');

    const proof = clone(build());
    boundary(proof).boundary_truth.prerequisiteBoundaryIsRuntimeAuthorization = true;
    recomputeBoundaryKey(proof);
    expectValidatorFails(proof, 'proof-boundaries-false');

    const directTarget = clone(build());
    boundary(directTarget).capability_matrix.directBuilderOracleServerTargetsAllowed = true;
    boundary(directTarget).boundary_truth.builderOracleDirectServerTargetsAllowed = true;
    recomputeBoundaryKey(directTarget);
    expectValidatorFails(directTarget, 'builder-oracle-direct-targets-blocked');

    const outputFile = clone(build());
    boundary(outputFile).side_effect_result.no_output_file_written = false;
    boundary(outputFile).side_effect_result.outputFilesWritten = 1;
    recomputeBoundaryKey(outputFile);
    expectValidatorFails(outputFile, 'side-effect-truth-all-blocked');

    const flagRead = clone(build());
    boundary(flagRead).side_effect_result.no_runtime_mode_flag_read = false;
    boundary(flagRead).side_effect_result.runtimeModeFlagRead = true;
    recomputeBoundaryKey(flagRead);
    expectValidatorFails(flagRead, 'side-effect-truth-all-blocked');

    const moduleImplemented = clone(build());
    boundary(moduleImplemented).side_effect_result.no_module_or_cli_implemented = false;
    boundary(moduleImplemented).side_effect_result.moduleOrCliImplemented = true;
    recomputeBoundaryKey(moduleImplemented);
    expectValidatorFails(moduleImplemented, 'no-module-cli-test-runtime-work');

    const rawSecret = clone(build());
    boundary(rawSecret).redaction_summary.note = 'raw bearer token';
    recomputeBoundaryKey(rawSecret);
    expectValidatorFails(rawSecret, 'redaction-summary-safe');
    expectValidatorFails(rawSecret, 'forbidden-output-strings-absent');
  });

  test('validator rejects unsafe next-action drift and Tier2+ recommendations after idempotency recompute', () => {
    const liveRuntime = clone(build());
    boundary(liveRuntime).next_phase_recommendations[0].action = 'start live runtime';
    recomputeBoundaryKey(liveRuntime);
    expectValidatorFails(liveRuntime, 'unsafe-action-drift-blocked');

    const wireKill = clone(build());
    boundary(wireKill).next_phase_recommendations[0].action = 'wire kill switch now';
    recomputeBoundaryKey(wireKill);
    expectValidatorFails(wireKill, 'unsafe-action-drift-blocked');

    const readFlag = clone(build());
    boundary(readFlag).next_phase_recommendations[0].why_safe = 'read runtime mode flag from env';
    recomputeBoundaryKey(readFlag);
    expectValidatorFails(readFlag, 'unsafe-action-drift-blocked');

    const tier2 = clone(build());
    boundary(tier2).next_phase_recommendations[0].tier = 'tier2';
    recomputeBoundaryKey(tier2);
    expectValidatorFails(tier2, 'next-recommendations-tier0-tier1-only');

    const customerSend = clone(build());
    boundary(customerSend).next_phase_recommendations[0].why_safe = 'safe to send customer message';
    recomputeBoundaryKey(customerSend);
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
    boundary(literalLie).baseline_commit = 'def3f3b';
    recomputeBoundaryKey(literalLie);
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
    expect(parsed.fixturePath).toContain('mira-core-runtime-mode-kill-switch-prerequisite-boundary-contract.json');

    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const output = main(['--out=ignored.json'], JSON.stringify({
      profile: { name: 'main' },
      sessionId: 'session-cli',
      deviceId: 'VIGIL',
    }));

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(boundary(output).schema).toBe(RUNTIME_MODE_KILL_SWITCH_PREREQUISITE_BOUNDARY_SCHEMA_VERSION);
    expect(boundary(output).sessionId).toBe('session-cli');
    expect(boundary(output).baseline_commit).toBe(BASELINE_COMMIT);
    expect(boundary(output).phase_registry.current_through_phase).toBe(41);
    expect(boundary(output).phase_registry.phase_inventory_count).toBe(41);
    expect(boundary(output).phase_registry.schema_registry_count).toBe(41);
    expect(boundary(output).phase_registry.cli_registry_count).toBe(41);
    expect(boundary(output).schema_registry).toHaveLength(41);
    expect(boundary(output).cli_registry).toHaveLength(41);
    expect(boundary(output).commit_chain).toHaveLength(29);
    expect(boundary(output).source_refs).toHaveLength(11);
    expect(boundary(output).prerequisite_gap_matrix).toHaveLength(2);
    expect(boundary(output).prerequisite_boundary.runtime_authorized_now).toBe(false);
    expect(boundary(output).runtime_mode_boundary.flag_reader_implemented).toBe(false);
    expect(boundary(output).runtime_mode_boundary.flag_read_now).toBe(false);
    expect(boundary(output).kill_switch_boundary.wired).toBe(false);
    expect(boundary(output).kill_switch_boundary.liveCheck).toBe(false);
    expect(boundary(output).capability_matrix.runtimeStarted).toBe(false);
    expect(boundary(output).capability_matrix.runnerExecuted).toBe(false);
    expect(boundary(output).capability_matrix.serverCanExecuteLocal).toBe(false);
    expect(boundary(output).side_effect_result.no_output_file_written).toBe(true);
    expect(boundary(output).side_effect_result.no_runtime_mode_flag_read).toBe(true);
    expect(boundary(output).side_effect_result.no_kill_switch_wired).toBe(true);
    expect(validationReport(output).decision).toBe('accepted_validation_only');
    expect(validateMiraCoreRuntimeModeKillSwitchPrerequisiteBoundaryOutput(
      output,
      runtimeModeKillSwitchPrerequisiteBoundaryContract,
    )).toEqual(expect.objectContaining({ ok: true }));
  });
});
