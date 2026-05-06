const runtimeDryRunReadinessGapContract = require('./fixtures/mira-core-runtime-dry-run-readiness-gap-contract.json');
const {
  BASELINE_COMMIT,
  REQUIRED_GAP_REPORT_FIELDS,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_SIDE_EFFECT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  RUNTIME_DRY_RUN_READINESS_GAP_SCHEMA_VERSION,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreRuntimeDryRunReadinessGap,
  runtimeDryRunReadinessGapIdempotencyKey,
  validateMiraCoreRuntimeDryRunReadinessGapOutput,
} = require('../modules/mira-core/runtime-dry-run-readiness-gap');
const {
  main,
  parseArgs,
} = require('../scripts/hm-mira-core-runtime-dry-run-readiness-gap');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function build(inputSignals = {}) {
  return buildMiraCoreRuntimeDryRunReadinessGap({
    contract: runtimeDryRunReadinessGapContract,
    inputSignals,
    nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
  });
}

function gapReport(output) {
  return output.runtime_dry_run_readiness_gap;
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
    runtimeDryRunReadinessGapContract.forbiddenOutputSubstrings,
  )).not.toThrow();
}

function expectValidatorFails(output, checkId) {
  const validation = validateMiraCoreRuntimeDryRunReadinessGapOutput(
    output,
    runtimeDryRunReadinessGapContract,
  );
  expect(validation.ok).toBe(false);
  expect(validation.checks.some((entry) => entry.id === checkId && entry.ok === false)).toBe(true);
}

function recomputeGapKey(output) {
  gapReport(output).idempotency_key = runtimeDryRunReadinessGapIdempotencyKey(gapReport(output));
}

describe('mira core runtime dry-run readiness gap v0', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('satisfies Oracle top-level, gap report, and validation report shapes', () => {
    const output = build();
    const current = gapReport(output);
    const report = validationReport(output);

    expectRequiredFields(output, runtimeDryRunReadinessGapContract.expectedOutputShape.requiredTopLevelFields);
    expect(runtimeDryRunReadinessGapContract.expectedOutputShape.requiredTopLevelFields)
      .toEqual(REQUIRED_OUTPUT_FIELDS);
    expect(current.schema).toBe(RUNTIME_DRY_RUN_READINESS_GAP_SCHEMA_VERSION);
    expect(report.schema).toBe(VALIDATION_REPORT_SCHEMA_VERSION);
    expectRequiredFields(current, runtimeDryRunReadinessGapContract.expectedManifestShape.requiredFields);
    expect(runtimeDryRunReadinessGapContract.expectedManifestShape.requiredFields)
      .toEqual(REQUIRED_GAP_REPORT_FIELDS);
    expectRequiredFields(report, runtimeDryRunReadinessGapContract.expectedValidationReportShape.requiredFields);
    expect(runtimeDryRunReadinessGapContract.expectedValidationReportShape.requiredFields)
      .toEqual(REQUIRED_VALIDATION_REPORT_FIELDS);
    expect(report.accepted).toBe(true);
    expect(report.blocked).toBe(false);
    expect(report.decision).toBe('accepted_validation_only');
    expect(validateMiraCoreRuntimeDryRunReadinessGapOutput(output, runtimeDryRunReadinessGapContract))
      .toEqual(expect.objectContaining({ ok: true }));
    expectNoForbiddenOutput(output);
  });

  test('pins baseline 85c78ab and registries through Phase 38', () => {
    const current = gapReport(build());
    const expected = runtimeDryRunReadinessGapContract.phaseRegistryExpected;

    expect(BASELINE_COMMIT).toBe(runtimeDryRunReadinessGapContract.baseline.commit);
    expect(current.baseline_commit).toBe(BASELINE_COMMIT);
    expect(current.phase_registry).toEqual(expect.objectContaining({
      source_ref: expected.source_ref,
      current_through_phase: 38,
      expected_phases: '1-38',
      phase_inventory_count: 38,
      schema_registry_count: 38,
      cli_registry_count: 38,
      phase35_runtime_next_action_current: true,
      phase36_operator_ui_surface_current: true,
      phase37_control_reporting_reconciliation_current: true,
      phase38_runtime_readiness_refresh_current: true,
      phase38_commit: BASELINE_COMMIT,
    }));
    expect(current.phase_registry.phase38_delta).toEqual(expect.objectContaining(expected.phase38_delta));
    expect(current.phase_registry.phase38_delta.capability_truth).toEqual(expect.objectContaining({
      runtimeStarted: false,
      runnerExecuted: false,
      runtimeAvailable: false,
      serverCanExecuteLocal: false,
      serverCanProveModelProcessing: false,
      directBuilderOracleServerTargetsAllowed: false,
    }));
    expect(current.schema_registry).toHaveLength(38);
    expect(current.cli_registry).toHaveLength(38);
    expect(current.phase_registry.recent_phase_paths).toEqual(expected.required_recent_phase_paths);
  });

  test('preserves commit chain, source recommendation, satisfied Phase38 work, and current/stale truth', () => {
    const current = gapReport(build());

    expect(current.commit_chain).toEqual(runtimeDryRunReadinessGapContract.commitChainExpected);
    expect(current.commit_chain).toHaveLength(
      runtimeDryRunReadinessGapContract.expectedManifestShape.expectedCounts.commit_chain,
    );
    expect(current.commit_chain[current.commit_chain.length - 1]).toBe(BASELINE_COMMIT);
    expect(current.source_recommendation).toEqual(expect.objectContaining({
      recommendation_id: runtimeDryRunReadinessGapContract.sourceRecommendation.recommendation_id,
      tier: 'tier1',
      status: 'selected_for_phase39_fixture_only_contract',
      contract_only_now: true,
      implemented_now: false,
      does_not_authorize_ui: true,
      does_not_authorize_runtime: true,
      does_not_authorize_execution: true,
    }));
    expect(current.satisfied_prior_recommendations).toHaveLength(1);
    expect(current.satisfied_prior_recommendations[0]).toEqual(expect.objectContaining({
      recommendation_id: runtimeDryRunReadinessGapContract.satisfiedPriorRecommendations[0].recommendation_id,
      status: 'satisfied_by_85c78ab_do_not_repeat_as_open_work',
      satisfied_by_commit: BASELINE_COMMIT,
      must_not_reopen: true,
    }));
    expect(current.next_phase_recommendations.map((item) => item.recommendation_id))
      .not.toContain(current.satisfied_prior_recommendations[0].recommendation_id);
    expect(current.current_truth).toEqual(expect.objectContaining({
      phase35_current: true,
      phase36_current: true,
      phase37_current: true,
      phase38_current: true,
    }));
    expect(current.stale_readiness).toEqual(expect.objectContaining(
      runtimeDryRunReadinessGapContract.staleReadinessExpected,
    ));
  });

  test('keeps Phase34 prior recommendations, Oracle closures, source refs, and recent paths complete', () => {
    const output = build();
    const current = gapReport(output);

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
      phase38_oracle_148_read_only_review_green: true,
      phase38_oracle_149_delivery_resend_accepted: true,
    }));
    expect(current.closure_summary.closed_review_refs)
      .toEqual(runtimeDryRunReadinessGapContract.closureSummaryExpected.closed_review_refs);
    expect(current.source_refs).toEqual(runtimeDryRunReadinessGapContract.sourceRefsExpected);
    expect(current.source_refs).toHaveLength(
      runtimeDryRunReadinessGapContract.expectedManifestShape.expectedCounts.source_refs,
    );
    expect(validationReport(output).referenced_path_results.length).toBeGreaterThan(0);
    expect(validationReport(output).referenced_path_results.every((entry) => entry.ok)).toBe(true);
  });

  test('models exactly nine unsatisfied blocking non-authorizing dry-run readiness gaps', () => {
    const current = gapReport(build());
    const expectedShape = runtimeDryRunReadinessGapContract.readinessGapShapeExpected;

    expect(current.gap_summary).toEqual(expect.objectContaining({
      decision: 'remain_gap_contract_only',
      gap_count: 9,
      all_gaps_block_runtime_now: true,
      all_gaps_block_dry_run_now: true,
      all_gaps_non_authorizing: true,
      runtime_authorized_now: false,
      dry_run_authorized_now: false,
    }));
    expect(current.readiness_gap_matrix.map((gap) => gap.gap_id)).toEqual(expectedShape.requiredGapIds);
    expect(current.readiness_gap_matrix).toHaveLength(9);
    for (const gap of current.readiness_gap_matrix) {
      expectRequiredFields(gap, expectedShape.gapRequiredFields);
      expect(gap.current_status).toBe(expectedShape.requiredGapValues.current_status);
      expect(gap.required_before_dry_run).toBe(true);
      expect(gap.blocks_runtime_now).toBe(true);
      expect(gap.blocks_dry_run_now).toBe(true);
      expect(gap.satisfied_now).toBe(false);
      expect(gap.authorizes_runtime).toBe(false);
      expect(gap.authorizes_dry_run).toBe(false);
      expect(gap.authorizes_execution).toBe(false);
      expect(gap.non_authorizing).toBe(true);
      const expected = expectedShape.gapMapExpected.find((item) => item.gap_id === gap.gap_id);
      expect(gap.maps_from_prior_prerequisite).toBe(expected.maps_from_prior_prerequisite);
      expect(gap.evidence_required).toBe(expected.evidence_required);
    }
    expect(current.dry_run_boundary).toEqual(expect.objectContaining({
      disabled_local_dry_run_available_now: false,
      disabled_by_default: true,
      local_only: true,
      dev_only: true,
      in_process_or_loopback_only: true,
      runtime_mode_flag_implemented: false,
      kill_switch_wired: false,
      tested_dry_run_runtime_path: false,
      queue_or_lease_created: false,
      store_or_output_written: false,
      reporting_sink_written: false,
      authorizes_runtime: false,
      authorizes_dry_run: false,
      authorizes_execution: false,
    }));
  });

  test('preserves capability, proof, redaction, and no-side-effect boundaries', () => {
    const output = build();
    const current = gapReport(output);

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
      phase38CommitIsRuntimeProof: false,
      readinessGapIsRuntimeAuthorization: false,
      readinessGapIsDryRunAuthorization: false,
      controlReportIsExecutionAuthorization: false,
      operatorSurfaceIsUiProof: false,
    }));
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
    expect(current.side_effect_result.moduleOrCliImplemented).toBe(false);
    expect(current.side_effect_result.testsImplemented).toBe(false);
    expect(current.side_effect_result.reportingSinkWritten).toBe(false);
  });

  test('next recommendations are Tier0/Tier1, non-authorizing, and match fixture candidates', () => {
    const current = gapReport(build());

    expect(current.next_phase_recommendations).toHaveLength(
      runtimeDryRunReadinessGapContract.nextRecommendationExpectedCandidates.length,
    );
    expect(current.next_phase_recommendations).toEqual(expect.arrayContaining(
      runtimeDryRunReadinessGapContract.nextRecommendationExpectedCandidates
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
    const validation = validateMiraCoreRuntimeDryRunReadinessGapOutput(
      output,
      runtimeDryRunReadinessGapContract,
    );
    const checkIds = validation.checks.map((entry) => entry.id);
    const staticIds = validationReport(output).static_rule_results.map((entry) => entry.id);
    const acceptanceIds = validationReport(output).acceptance_check_results.map((entry) => entry.id);

    expect(validation.ok).toBe(true);
    for (const rule of runtimeDryRunReadinessGapContract.staticValidationRules) {
      expect(checkIds).toContain(rule.id);
      expect(staticIds).toContain(rule.id);
    }
    for (const check of runtimeDryRunReadinessGapContract.acceptanceChecks) {
      expect(checkIds).toContain(check.id);
      expect(acceptanceIds).toContain(check.id);
    }
    expect(validationReport(output).tamper_case_results).toHaveLength(
      runtimeDryRunReadinessGapContract.tamperCases.length,
    );
    expect(validationReport(output).tamper_case_results.length)
      .toBeGreaterThanOrEqual(
        runtimeDryRunReadinessGapContract.expectedManifestShape.expectedCounts.tamper_case_results_min,
      );
    expect(validationReport(output).tamper_case_results.every((entry) => entry.covered && entry.expectedFailure))
      .toBe(true);
    expect(validationReport(output).required_literal_results.length)
      .toBeGreaterThanOrEqual(
        runtimeDryRunReadinessGapContract.expectedManifestShape.expectedCounts.required_literal_results_min,
      );
    expect(validationReport(output).required_literal_results.every((entry) => entry.ok)).toBe(true);
    expect(validationReport(output).referenced_path_results.every((entry) => entry.ok)).toBe(true);
  });

  test('idempotency is stable for equivalent inputs and sensitive to meaningful gap report changes', () => {
    const first = gapReport(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'VIGIL' }));
    const second = gapReport(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'VIGIL' }));
    const changedDevice = gapReport(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'ALT' }));
    const changedProfile = gapReport(build({ profile: { name: 'side' }, sessionId: 'session-a', deviceId: 'VIGIL' }));

    expect(first.idempotency_key).toBe(second.idempotency_key);
    expect(first.gap_report_id).toBe(second.gap_report_id);
    expect(first.idempotency_key).not.toBe(changedDevice.idempotency_key);
    expect(first.idempotency_key).not.toBe(changedProfile.idempotency_key);

    const changed = clone(build());
    const originalKey = gapReport(changed).idempotency_key;
    gapReport(changed).closure_summary.phase38_oracle_148_read_only_review_green = false;
    recomputeGapKey(changed);
    expect(gapReport(changed).idempotency_key).not.toBe(originalKey);
    expectValidatorFails(changed, 'closures-carried-oracle-115-123-127-131-134-137-141-148-149');
  });

  test('validator rejects baseline, registry, commit-chain, source, prior, stale, source-ref, and path drift', () => {
    const baseline = clone(build());
    gapReport(baseline).baseline_commit = 'c8b55be';
    recomputeGapKey(baseline);
    expectValidatorFails(baseline, 'baseline-pinned-85c78ab');

    const phase38 = clone(build());
    gapReport(phase38).phase_registry.phase38_runtime_readiness_refresh_current = false;
    recomputeGapKey(phase38);
    expectValidatorFails(phase38, 'phase38-current');

    const phase35 = clone(build());
    gapReport(phase35).current_truth.phase35_current = false;
    recomputeGapKey(phase35);
    expectValidatorFails(phase35, 'phase35-current-preserved');

    const phase36 = clone(build());
    gapReport(phase36).current_truth.phase36_current = false;
    recomputeGapKey(phase36);
    expectValidatorFails(phase36, 'phase36-current-preserved');

    const phase37 = clone(build());
    gapReport(phase37).current_truth.phase37_current = false;
    recomputeGapKey(phase37);
    expectValidatorFails(phase37, 'phase37-current-preserved');

    const count = clone(build());
    gapReport(count).phase_registry.phase_inventory_count = 37;
    recomputeGapKey(count);
    expectValidatorFails(count, 'phase-inventory-count-38');

    const chain = clone(build());
    gapReport(chain).commit_chain = gapReport(chain).commit_chain.filter((commit) => commit !== BASELINE_COMMIT);
    recomputeGapKey(chain);
    expectValidatorFails(chain, 'commit-chain-exact-26');

    const source = clone(build());
    gapReport(source).source_recommendation.recommendation_id = 'phase39-runtime-readiness-refresh-through-phase37-validator';
    recomputeGapKey(source);
    expectValidatorFails(source, 'source-recommendation-tier1-selected');

    const satisfied = clone(build());
    gapReport(satisfied).satisfied_prior_recommendations[0].status = 'open';
    recomputeGapKey(satisfied);
    expectValidatorFails(satisfied, 'phase38-tier0-satisfied-not-open');

    const stale13 = clone(build());
    gapReport(stale13).stale_readiness.phase13_readiness_current = true;
    recomputeGapKey(stale13);
    expectValidatorFails(stale13, 'phase13-stale-preserved');

    const stale23 = clone(build());
    gapReport(stale23).stale_readiness.phase23_milestone_readiness_current = true;
    recomputeGapKey(stale23);
    expectValidatorFails(stale23, 'phase23-stale-preserved');

    const stale31 = clone(build());
    gapReport(stale31).stale_readiness.phase31_runtime_milestone_refresh_current = true;
    recomputeGapKey(stale31);
    expectValidatorFails(stale31, 'phase31-stale-preserved');

    const missingRef = clone(build());
    gapReport(missingRef).source_refs = gapReport(missingRef).source_refs
      .filter((ref) => ref.artifact_id !== 'phase38-runtime-readiness-refresh-through-phase37');
    recomputeGapKey(missingRef);
    expectValidatorFails(missingRef, 'source-refs-phase29-30-32-33-34-35-36-37-38');

    const missingPath = clone(build());
    gapReport(missingPath).phase_registry.recent_phase_paths = gapReport(missingPath).phase_registry.recent_phase_paths
      .filter((entry) => entry.phase !== 38);
    recomputeGapKey(missingPath);
    expectValidatorFails(missingPath, 'recent-phase-paths-present');
  });

  test('validator rejects dry-run readiness gap and dry-run boundary drift after idempotency recompute', () => {
    const gapCount = clone(build());
    gapReport(gapCount).readiness_gap_matrix = gapReport(gapCount).readiness_gap_matrix
      .filter((gap) => gap.gap_id !== 'end-to-end-runtime-proof');
    gapReport(gapCount).gap_summary.gap_count = 8;
    gapReport(gapCount).gap_summary.blocking_gap_ids = gapReport(gapCount).readiness_gap_matrix.map((gap) => gap.gap_id);
    recomputeGapKey(gapCount);
    expectValidatorFails(gapCount, 'readiness-gap-count-exact-9');

    const satisfied = clone(build());
    gapReport(satisfied).readiness_gap_matrix[0].satisfied_now = true;
    recomputeGapKey(satisfied);
    expectValidatorFails(satisfied, 'readiness-gaps-unsatisfied-and-blocking');
    expectValidatorFails(satisfied, 'readiness-gaps-unsatisfied');

    const authorizesRuntime = clone(build());
    gapReport(authorizesRuntime).readiness_gap_matrix[0].authorizes_runtime = true;
    recomputeGapKey(authorizesRuntime);
    expectValidatorFails(authorizesRuntime, 'dry-run-gaps-do-not-authorize-runtime');

    const noDryRunBlock = clone(build());
    gapReport(noDryRunBlock).readiness_gap_matrix[0].blocks_dry_run_now = false;
    recomputeGapKey(noDryRunBlock);
    expectValidatorFails(noDryRunBlock, 'readiness-gaps-unsatisfied-and-blocking');
    expectValidatorFails(noDryRunBlock, 'readiness-gaps-block-dry-run-now');

    const dryRunAvailable = clone(build());
    gapReport(dryRunAvailable).dry_run_boundary.disabled_local_dry_run_available_now = true;
    recomputeGapKey(dryRunAvailable);
    expectValidatorFails(dryRunAvailable, 'dry-run-boundary-disabled-local-only');

    const killSwitch = clone(build());
    gapReport(killSwitch).dry_run_boundary.kill_switch_wired = true;
    recomputeGapKey(killSwitch);
    expectValidatorFails(killSwitch, 'dry-run-boundary-disabled-local-only');
  });

  test('validator rejects capability, proof, scope, side-effect, and redaction overclaims', () => {
    const runtime = clone(build());
    gapReport(runtime).capability_matrix.runtimeStarted = true;
    gapReport(runtime).boundary_truth.runtimeStarted = true;
    gapReport(runtime).side_effect_result.runtimeStarted = true;
    recomputeGapKey(runtime);
    expectValidatorFails(runtime, 'capability-truth-false');
    expectValidatorFails(runtime, 'runtime-started-false');

    const runner = clone(build());
    gapReport(runner).capability_matrix.runnerExecuted = true;
    recomputeGapKey(runner);
    expectValidatorFails(runner, 'capability-truth-false');
    expectValidatorFails(runner, 'runner-executed-false');

    const modelProof = clone(build());
    gapReport(modelProof).capability_matrix.serverCanProveModelProcessing = true;
    recomputeGapKey(modelProof);
    expectValidatorFails(modelProof, 'capability-truth-false');

    const directTarget = clone(build());
    gapReport(directTarget).capability_matrix.directBuilderOracleServerTargetsAllowed = true;
    gapReport(directTarget).boundary_truth.builderOracleDirectServerTargetsAllowed = true;
    recomputeGapKey(directTarget);
    expectValidatorFails(directTarget, 'builder-oracle-direct-targets-blocked');

    const deliveryProof = clone(build());
    gapReport(deliveryProof).boundary_truth.deliveryAcceptanceIsModelProcessingProof = true;
    recomputeGapKey(deliveryProof);
    expectValidatorFails(deliveryProof, 'proof-boundaries-false');

    const phase38Proof = clone(build());
    gapReport(phase38Proof).boundary_truth.phase38CommitIsRuntimeProof = true;
    recomputeGapKey(phase38Proof);
    expectValidatorFails(phase38Proof, 'proof-boundaries-false');

    const dryRunProof = clone(build());
    gapReport(dryRunProof).boundary_truth.readinessGapIsDryRunAuthorization = true;
    recomputeGapKey(dryRunProof);
    expectValidatorFails(dryRunProof, 'proof-boundaries-false');

    const outputFile = clone(build());
    gapReport(outputFile).side_effect_result.no_output_file_written = false;
    gapReport(outputFile).side_effect_result.outputFilesWritten = 1;
    recomputeGapKey(outputFile);
    expectValidatorFails(outputFile, 'side-effect-truth-all-blocked');

    const reportSink = clone(build());
    gapReport(reportSink).side_effect_result.no_reporting_sink_written = false;
    gapReport(reportSink).side_effect_result.reportingSinkWritesAttempted = 1;
    recomputeGapKey(reportSink);
    expectValidatorFails(reportSink, 'side-effect-truth-all-blocked');

    const moduleImplemented = clone(build());
    gapReport(moduleImplemented).side_effect_result.no_module_or_cli_implemented = false;
    gapReport(moduleImplemented).side_effect_result.moduleOrCliImplemented = true;
    recomputeGapKey(moduleImplemented);
    expectValidatorFails(moduleImplemented, 'no-module-cli-test-runtime-work');

    const testsImplemented = clone(build());
    gapReport(testsImplemented).side_effect_result.no_tests_implemented = false;
    gapReport(testsImplemented).side_effect_result.testsImplemented = true;
    recomputeGapKey(testsImplemented);
    expectValidatorFails(testsImplemented, 'no-module-cli-test-runtime-work');

    const rawSecret = clone(build());
    gapReport(rawSecret).redaction_summary.note = 'raw bearer token';
    recomputeGapKey(rawSecret);
    expectValidatorFails(rawSecret, 'redaction-summary-safe');
    expectValidatorFails(rawSecret, 'forbidden-output-strings-absent');
  });

  test('validator rejects unsafe next-action drift and Tier2+ recommendations after idempotency recompute', () => {
    const liveRuntime = clone(build());
    gapReport(liveRuntime).next_phase_recommendations[0].action = 'start live runtime';
    recomputeGapKey(liveRuntime);
    expectValidatorFails(liveRuntime, 'unsafe-action-drift-blocked');

    const liveUi = clone(build());
    gapReport(liveUi).next_phase_recommendations[0].action = 'build live UI';
    recomputeGapKey(liveUi);
    expectValidatorFails(liveUi, 'unsafe-action-drift-blocked');

    const tier2 = clone(build());
    gapReport(tier2).next_phase_recommendations[0].tier = 'tier2';
    recomputeGapKey(tier2);
    expectValidatorFails(tier2, 'next-recommendations-tier0-tier1-only');

    const customerSend = clone(build());
    gapReport(customerSend).next_phase_recommendations[0].why_safe = 'safe to send customer message';
    recomputeGapKey(customerSend);
    expectValidatorFails(customerSend, 'unsafe-action-drift-blocked');
    expectValidatorFails(customerSend, 'unsafe-action-drift-rejected');

    const controlExecution = clone(build());
    gapReport(controlExecution).next_phase_recommendations[0].why_safe = 'execute control and write report';
    recomputeGapKey(controlExecution);
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
    expectValidatorFails(missingTamper, 'validation-report-coverage-bound');
    expectValidatorFails(missingTamper, 'validation-report-matches-contract');

    const literalLie = clone(build());
    gapReport(literalLie).baseline_commit = 'c8b55be';
    recomputeGapKey(literalLie);
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
    expect(parsed.fixturePath).toContain('mira-core-runtime-dry-run-readiness-gap-contract.json');

    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const output = main(['--out=ignored.json'], JSON.stringify({
      profile: { name: 'main' },
      sessionId: 'session-cli',
      deviceId: 'VIGIL',
    }));

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(gapReport(output).schema).toBe(RUNTIME_DRY_RUN_READINESS_GAP_SCHEMA_VERSION);
    expect(gapReport(output).sessionId).toBe('session-cli');
    expect(gapReport(output).baseline_commit).toBe(BASELINE_COMMIT);
    expect(gapReport(output).phase_registry.current_through_phase).toBe(38);
    expect(gapReport(output).phase_registry.phase_inventory_count).toBe(38);
    expect(gapReport(output).phase_registry.schema_registry_count).toBe(38);
    expect(gapReport(output).phase_registry.cli_registry_count).toBe(38);
    expect(gapReport(output).schema_registry).toHaveLength(38);
    expect(gapReport(output).cli_registry).toHaveLength(38);
    expect(gapReport(output).commit_chain).toHaveLength(26);
    expect(gapReport(output).source_refs).toHaveLength(9);
    expect(gapReport(output).readiness_gap_matrix).toHaveLength(9);
    expect(gapReport(output).capability_matrix.runtimeStarted).toBe(false);
    expect(gapReport(output).capability_matrix.runnerExecuted).toBe(false);
    expect(gapReport(output).capability_matrix.serverCanExecuteLocal).toBe(false);
    expect(gapReport(output).side_effect_result.no_output_file_written).toBe(true);
    expect(gapReport(output).side_effect_result.no_module_or_cli_implemented).toBe(true);
    expect(gapReport(output).side_effect_result.no_tests_implemented).toBe(true);
    expect(validationReport(output).decision).toBe('accepted_validation_only');
    expect(validateMiraCoreRuntimeDryRunReadinessGapOutput(output, runtimeDryRunReadinessGapContract))
      .toEqual(expect.objectContaining({ ok: true }));
  });
});
