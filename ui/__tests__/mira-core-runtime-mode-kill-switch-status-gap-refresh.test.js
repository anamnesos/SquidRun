const runtimeModeKillSwitchStatusGapRefreshContract = require('./fixtures/mira-core-runtime-mode-kill-switch-status-gap-refresh-contract.json');
const {
  BASELINE_COMMIT,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_REFRESH_FIELDS,
  REQUIRED_SIDE_EFFECT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  RUNTIME_MODE_KILL_SWITCH_STATUS_GAP_REFRESH_SCHEMA_VERSION,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreRuntimeModeKillSwitchStatusGapRefresh,
  runtimeModeKillSwitchStatusGapRefreshIdempotencyKey,
  validateMiraCoreRuntimeModeKillSwitchStatusGapRefreshOutput,
} = require('../modules/mira-core/runtime-mode-kill-switch-status-gap-refresh');
const {
  main,
  parseArgs,
} = require('../scripts/hm-mira-core-runtime-mode-kill-switch-status-gap-refresh');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function build(inputSignals = {}) {
  return buildMiraCoreRuntimeModeKillSwitchStatusGapRefresh({
    contract: runtimeModeKillSwitchStatusGapRefreshContract,
    inputSignals,
    nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
  });
}

function refresh(output) {
  return output.runtime_mode_kill_switch_status_gap_refresh;
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
    runtimeModeKillSwitchStatusGapRefreshContract.forbiddenOutputSubstrings,
  )).not.toThrow();
}

function expectValidatorFails(output, checkId) {
  const validation = validateMiraCoreRuntimeModeKillSwitchStatusGapRefreshOutput(
    output,
    runtimeModeKillSwitchStatusGapRefreshContract,
  );
  expect(validation.ok).toBe(false);
  expect(validation.checks.some((entry) => entry.id === checkId && entry.ok === false)).toBe(true);
}

function recomputeRefreshKey(output) {
  refresh(output).idempotency_key =
    runtimeModeKillSwitchStatusGapRefreshIdempotencyKey(refresh(output));
}

describe('mira core runtime mode kill-switch status gap refresh v0', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('satisfies Oracle top-level, manifest, and validation report shapes', () => {
    const output = build();
    const current = refresh(output);
    const report = validationReport(output);

    expectRequiredFields(output, runtimeModeKillSwitchStatusGapRefreshContract.expectedOutputShape.requiredTopLevelFields);
    expect(runtimeModeKillSwitchStatusGapRefreshContract.expectedOutputShape.requiredTopLevelFields)
      .toEqual(REQUIRED_OUTPUT_FIELDS);
    expect(current.schema).toBe(RUNTIME_MODE_KILL_SWITCH_STATUS_GAP_REFRESH_SCHEMA_VERSION);
    expect(report.schema).toBe(VALIDATION_REPORT_SCHEMA_VERSION);
    expectRequiredFields(current, runtimeModeKillSwitchStatusGapRefreshContract.expectedManifestShape.requiredFields);
    expect(runtimeModeKillSwitchStatusGapRefreshContract.expectedManifestShape.requiredFields)
      .toEqual(REQUIRED_REFRESH_FIELDS);
    expectRequiredFields(report, runtimeModeKillSwitchStatusGapRefreshContract.expectedValidationReportShape.requiredFields);
    expect(runtimeModeKillSwitchStatusGapRefreshContract.expectedValidationReportShape.requiredFields)
      .toEqual(REQUIRED_VALIDATION_REPORT_FIELDS);
    expect(report.accepted).toBe(true);
    expect(report.blocked).toBe(false);
    expect(report.decision).toBe('accepted_validation_only');
    expect(validateMiraCoreRuntimeModeKillSwitchStatusGapRefreshOutput(
      output,
      runtimeModeKillSwitchStatusGapRefreshContract,
    )).toEqual(expect.objectContaining({ ok: true }));
    expectNoForbiddenOutput(output);
  });

  test('pins baseline def3f3b and registries through Phase 40', () => {
    const current = refresh(build());
    const expected = runtimeModeKillSwitchStatusGapRefreshContract.phaseRegistryExpected;

    expect(BASELINE_COMMIT).toBe(runtimeModeKillSwitchStatusGapRefreshContract.baseline.commit);
    expect(current.baseline_commit).toBe(BASELINE_COMMIT);
    expect(current.phase_registry).toEqual(expect.objectContaining({
      source_ref: expected.source_ref,
      current_through_phase: 40,
      expected_phases: '1-40',
      phase_inventory_count: 40,
      schema_registry_count: 40,
      cli_registry_count: 40,
      phase35_runtime_next_action_current: true,
      phase36_operator_ui_surface_current: true,
      phase37_control_reporting_reconciliation_current: true,
      phase38_runtime_readiness_refresh_current: true,
      phase39_dry_run_readiness_gap_current: true,
      phase40_runtime_mode_kill_switch_current: true,
      phase40_commit: BASELINE_COMMIT,
    }));
    expect(current.phase_registry.phase40_delta).toEqual(expect.objectContaining(expected.phase40_delta));
    expect(current.schema_registry).toHaveLength(40);
    expect(current.cli_registry).toHaveLength(40);
    expect(current.phase_registry.recent_phase_paths).toEqual(expected.required_recent_phase_paths);
  });

  test('preserves commit chain, selected source recommendation, satisfied Phase40 work, and current truth', () => {
    const current = refresh(build());

    expect(current.commit_chain).toEqual(runtimeModeKillSwitchStatusGapRefreshContract.commitChainExpected);
    expect(current.commit_chain).toHaveLength(
      runtimeModeKillSwitchStatusGapRefreshContract.expectedManifestShape.expectedCounts.commit_chain,
    );
    expect(current.commit_chain[current.commit_chain.length - 1]).toBe(BASELINE_COMMIT);
    expect(current.source_recommendation).toEqual(expect.objectContaining({
      recommendation_id: runtimeModeKillSwitchStatusGapRefreshContract.sourceRecommendation.recommendation_id,
      tier: 'tier1',
      status: 'selected_for_phase41_fixture_only_contract',
      contract_only_now: true,
      implemented_now: false,
      does_not_authorize_ui: true,
      does_not_authorize_runtime: true,
      does_not_authorize_execution: true,
    }));
    expect(current.satisfied_prior_recommendations).toHaveLength(1);
    expect(current.satisfied_prior_recommendations[0]).toEqual(expect.objectContaining({
      recommendation_id: runtimeModeKillSwitchStatusGapRefreshContract.satisfiedPriorRecommendations[0].recommendation_id,
      status: 'satisfied_by_def3f3b_do_not_repeat_as_open_work',
      satisfied_by_commit: BASELINE_COMMIT,
      must_not_reopen: true,
    }));
    expect(current.next_phase_recommendations.map((item) => item.recommendation_id))
      .not.toContain(current.satisfied_prior_recommendations[0].recommendation_id);
    expect(current.current_truth).toEqual(expect.objectContaining(
      runtimeModeKillSwitchStatusGapRefreshContract.currentTruthExpected,
    ));
    expect(current.current_truth.runtime_mode_and_kill_switch_remain_non_authorizing).toBe(true);
  });

  test('keeps stale readiness, Phase34 prior recommendations, Oracle closures, source refs, and paths complete', () => {
    const output = build();
    const current = refresh(output);

    expect(current.stale_readiness).toEqual(expect.objectContaining(
      runtimeModeKillSwitchStatusGapRefreshContract.staleReadinessExpected,
    ));
    expect(current.phase34_prior_recommendations.phase35_runtime_status_milestone_refresh_validator.status)
      .toBe('satisfied_by_c04155d_do_not_repeat_as_open_work');
    expect(current.phase34_prior_recommendations.phase35_stdout_only_cli_smoke.status)
      .toBe('satisfied_by_c04155d_do_not_repeat_as_open_work');
    expect(current.closure_summary).toEqual(expect.objectContaining(
      runtimeModeKillSwitchStatusGapRefreshContract.closureSummaryExpected,
    ));
    expect(current.closure_summary.closed_review_refs)
      .toEqual(runtimeModeKillSwitchStatusGapRefreshContract.closureSummaryExpected.closed_review_refs);
    expect(current.source_refs).toEqual(runtimeModeKillSwitchStatusGapRefreshContract.sourceRefsExpected);
    expect(current.source_refs).toHaveLength(
      runtimeModeKillSwitchStatusGapRefreshContract.expectedManifestShape.expectedCounts.source_refs,
    );
    expect(validationReport(output).referenced_path_results.length).toBeGreaterThan(0);
    expect(validationReport(output).referenced_path_results.every((entry) => entry.ok)).toBe(true);
  });

  test('defines disabled runtime-mode status and fail-closed unwired kill-switch status', () => {
    const current = refresh(build());
    const modeShape = runtimeModeKillSwitchStatusGapRefreshContract.runtimeModeStatusShapeExpected;
    const killShape = runtimeModeKillSwitchStatusGapRefreshContract.killSwitchStatusShapeExpected;

    expectRequiredFields(current.runtime_mode_status, modeShape.requiredFields);
    expect(current.runtime_mode_status).toEqual(expect.objectContaining(modeShape.requiredValues));
    expect(current.runtime_mode_status.status_id).toBe('runtime-mode-status-v0');
    expect(current.runtime_mode_status.source_ref).toBe('phase40-runtime-mode-kill-switch');
    expect(current.runtime_mode_status.flag_reader_implemented).toBe(false);
    expect(current.runtime_mode_status.flag_read_now).toBe(false);
    expectRequiredFields(current.kill_switch_status, killShape.requiredFields);
    expect(current.kill_switch_status).toEqual(expect.objectContaining(killShape.requiredValues));
    expect(current.kill_switch_status.status_id).toBe('kill-switch-status-v0');
    expect(current.kill_switch_status.source_ref).toBe('phase40-runtime-mode-kill-switch');
    expect(current.kill_switch_status.wired).toBe(false);
    expect(current.kill_switch_status.live_check_performed).toBe(false);
  });

  test('keeps exactly two status gaps unsatisfied, blocking, reference-only, and non-authorizing', () => {
    const current = refresh(build());
    const expected = runtimeModeKillSwitchStatusGapRefreshContract.statusGapMatrixExpected;

    expect(current.status_gap_matrix.map((entry) => entry.gap_id))
      .toEqual(expected.map((entry) => entry.gap_id));
    expect(current.status_gap_matrix).toHaveLength(
      runtimeModeKillSwitchStatusGapRefreshContract.expectedManifestShape.expectedCounts.status_gap_matrix,
    );
    for (const gap of current.status_gap_matrix) {
      const expectedGap = expected.find((item) => item.gap_id === gap.gap_id);
      expect(gap).toEqual(expect.objectContaining({
        maps_from_phase40_gap: expectedGap.maps_from_phase40_gap,
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
    expect(current.refresh_summary).toEqual(expect.objectContaining({
      decision: 'remain_status_gap_refresh_contract_only',
      status_gap_count: 2,
      runtime_authorized_now: false,
      dry_run_authorized_now: false,
      flag_reader_allowed_now: false,
      kill_switch_wiring_allowed_now: false,
      all_gaps_block_runtime_now: true,
      all_gaps_non_authorizing: true,
    }));
  });

  test('preserves capability, proof, redaction, and no-side-effect boundaries', () => {
    const output = build();
    const current = refresh(output);

    expect(current.capability_matrix).toEqual(expect.objectContaining(
      runtimeModeKillSwitchStatusGapRefreshContract.capabilityMatrixExpected,
    ));
    expect(current.boundary_truth).toEqual(expect.objectContaining(
      runtimeModeKillSwitchStatusGapRefreshContract.proofBoundaryExpected,
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
    const current = refresh(build());

    expect(current.next_phase_recommendations).toHaveLength(
      runtimeModeKillSwitchStatusGapRefreshContract.nextRecommendationExpectedCandidates.length,
    );
    expect(current.next_phase_recommendations).toEqual(expect.arrayContaining(
      runtimeModeKillSwitchStatusGapRefreshContract.nextRecommendationExpectedCandidates
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
    const validation = validateMiraCoreRuntimeModeKillSwitchStatusGapRefreshOutput(
      output,
      runtimeModeKillSwitchStatusGapRefreshContract,
    );
    const checkIds = validation.checks.map((entry) => entry.id);
    const staticIds = validationReport(output).static_rule_results.map((entry) => entry.id);
    const acceptanceIds = validationReport(output).acceptance_check_results.map((entry) => entry.id);

    expect(validation.ok).toBe(true);
    for (const rule of runtimeModeKillSwitchStatusGapRefreshContract.staticValidationRules) {
      expect(checkIds).toContain(rule.id);
      expect(staticIds).toContain(rule.id);
    }
    for (const check of runtimeModeKillSwitchStatusGapRefreshContract.acceptanceChecks) {
      expect(checkIds).toContain(check.id);
      expect(acceptanceIds).toContain(check.id);
    }
    expect(validationReport(output).tamper_case_results).toHaveLength(
      runtimeModeKillSwitchStatusGapRefreshContract.tamperCases.length,
    );
    expect(validationReport(output).tamper_case_results.length)
      .toBeGreaterThanOrEqual(
        runtimeModeKillSwitchStatusGapRefreshContract.expectedManifestShape.expectedCounts.tamper_case_results_min,
      );
    expect(validationReport(output).required_literal_results.length)
      .toBeGreaterThanOrEqual(
        runtimeModeKillSwitchStatusGapRefreshContract.expectedManifestShape.expectedCounts.required_literal_results_min,
      );
    expect(validationReport(output).required_literal_results.every((entry) => entry.ok)).toBe(true);
    expect(validationReport(output).referenced_path_results.every((entry) => entry.ok)).toBe(true);
  });

  test('idempotency is stable for equivalent inputs and sensitive to status/gap changes', () => {
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
    refresh(changed).runtime_mode_status.flag_reader_implemented = true;
    recomputeRefreshKey(changed);
    expect(refresh(changed).idempotency_key).not.toBe(originalKey);
    expectValidatorFails(changed, 'runtime-mode-status-disabled-reference-only');
  });

  test('validator rejects baseline, registry, source, stale, closure, source-ref, and path drift', () => {
    const baseline = clone(build());
    refresh(baseline).baseline_commit = 'a62fe16';
    recomputeRefreshKey(baseline);
    expectValidatorFails(baseline, 'baseline-pinned-def3f3b');

    const phase40 = clone(build());
    refresh(phase40).phase_registry.phase40_runtime_mode_kill_switch_current = false;
    recomputeRefreshKey(phase40);
    expectValidatorFails(phase40, 'phase40-current');

    const phase35 = clone(build());
    refresh(phase35).current_truth.phase35_current = false;
    recomputeRefreshKey(phase35);
    expectValidatorFails(phase35, 'phase35-current-preserved');

    const phase39 = clone(build());
    refresh(phase39).current_truth.phase39_current = false;
    recomputeRefreshKey(phase39);
    expectValidatorFails(phase39, 'phase39-current-preserved');

    const count = clone(build());
    refresh(count).phase_registry.phase_inventory_count = 39;
    recomputeRefreshKey(count);
    expectValidatorFails(count, 'phase-inventory-count-40');

    const chain = clone(build());
    refresh(chain).commit_chain = refresh(chain).commit_chain.filter((commit) => commit !== BASELINE_COMMIT);
    recomputeRefreshKey(chain);
    expectValidatorFails(chain, 'commit-chain-exact-28');

    const source = clone(build());
    refresh(source).source_recommendation.recommendation_id = 'phase41-runtime-mode-kill-switch-reference-validator';
    recomputeRefreshKey(source);
    expectValidatorFails(source, 'source-recommendation-tier1-selected');

    const satisfied = clone(build());
    refresh(satisfied).satisfied_prior_recommendations[0].status = 'open';
    recomputeRefreshKey(satisfied);
    expectValidatorFails(satisfied, 'phase40-tier0-satisfied-not-open');

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

    const missingClosure = clone(build());
    refresh(missingClosure).closure_summary.phase40_oracle_161_read_only_review_green = false;
    recomputeRefreshKey(missingClosure);
    expectValidatorFails(missingClosure, 'closures-carried-oracle-115-123-127-131-134-137-141-148-149-156-161');

    const missingRef = clone(build());
    refresh(missingRef).source_refs = refresh(missingRef).source_refs
      .filter((ref) => ref.artifact_id !== 'phase40-runtime-mode-kill-switch');
    recomputeRefreshKey(missingRef);
    expectValidatorFails(missingRef, 'source-refs-phase26-27-29-30-32-33-37-38-39-40');

    const missingPath = clone(build());
    refresh(missingPath).phase_registry.recent_phase_paths = refresh(missingPath).phase_registry.recent_phase_paths
      .filter((entry) => entry.phase !== 40);
    recomputeRefreshKey(missingPath);
    expectValidatorFails(missingPath, 'recent-phase-paths-present');
  });

  test('validator rejects runtime-mode, kill-switch, gap matrix, and refresh summary drift', () => {
    const modeEnabled = clone(build());
    refresh(modeEnabled).runtime_mode_status.effective_state = 'dry_run_preview_only';
    recomputeRefreshKey(modeEnabled);
    expectValidatorFails(modeEnabled, 'runtime-mode-status-disabled-reference-only');

    const modeImplemented = clone(build());
    refresh(modeImplemented).runtime_mode_status.implemented_now = true;
    recomputeRefreshKey(modeImplemented);
    expectValidatorFails(modeImplemented, 'runtime-mode-status-disabled-reference-only');

    const flagReader = clone(build());
    refresh(flagReader).runtime_mode_status.flag_reader_implemented = true;
    recomputeRefreshKey(flagReader);
    expectValidatorFails(flagReader, 'runtime-mode-status-disabled-reference-only');

    const flagReadNow = clone(build());
    refresh(flagReadNow).runtime_mode_status.flag_read_now = true;
    recomputeRefreshKey(flagReadNow);
    expectValidatorFails(flagReadNow, 'runtime-mode-status-disabled-reference-only');

    const killWired = clone(build());
    refresh(killWired).kill_switch_status.wired = true;
    recomputeRefreshKey(killWired);
    expectValidatorFails(killWired, 'kill-switch-status-fail-closed-reference-only');

    const killLive = clone(build());
    refresh(killLive).kill_switch_status.live_check_performed = true;
    recomputeRefreshKey(killLive);
    expectValidatorFails(killLive, 'kill-switch-status-fail-closed-reference-only');

    const killAllow = clone(build());
    refresh(killAllow).kill_switch_status.default_behavior = 'allow';
    recomputeRefreshKey(killAllow);
    expectValidatorFails(killAllow, 'kill-switch-status-fail-closed-reference-only');

    const gapSatisfied = clone(build());
    refresh(gapSatisfied).status_gap_matrix[0].satisfied_now = true;
    recomputeRefreshKey(gapSatisfied);
    expectValidatorFails(gapSatisfied, 'status-gap-matrix-two-unsatisfied-gaps');
    expectValidatorFails(gapSatisfied, 'status-gap-refresh-does-not-satisfy-gaps');

    const gapNoBlock = clone(build());
    refresh(gapNoBlock).status_gap_matrix[0].blocks_runtime_now = false;
    recomputeRefreshKey(gapNoBlock);
    expectValidatorFails(gapNoBlock, 'status-gap-matrix-two-unsatisfied-gaps');

    const summaryRuntime = clone(build());
    refresh(summaryRuntime).refresh_summary.runtime_authorized_now = true;
    recomputeRefreshKey(summaryRuntime);
    expectValidatorFails(summaryRuntime, 'refresh-summary-non-authorizing');

    const summaryFlag = clone(build());
    refresh(summaryFlag).refresh_summary.flag_reader_allowed_now = true;
    recomputeRefreshKey(summaryFlag);
    expectValidatorFails(summaryFlag, 'refresh-summary-non-authorizing');
  });

  test('validator rejects capability, proof, side-effect, scope, and redaction overclaims', () => {
    const runtime = clone(build());
    refresh(runtime).capability_matrix.runtimeStarted = true;
    refresh(runtime).boundary_truth.runtimeStarted = true;
    refresh(runtime).side_effect_result.runtimeStarted = true;
    recomputeRefreshKey(runtime);
    expectValidatorFails(runtime, 'capability-truth-false');
    expectValidatorFails(runtime, 'runtime-started-false');

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

    const phase40Proof = clone(build());
    refresh(phase40Proof).boundary_truth.phase40CommitIsRuntimeProof = true;
    recomputeRefreshKey(phase40Proof);
    expectValidatorFails(phase40Proof, 'proof-boundaries-false');

    const outputFile = clone(build());
    refresh(outputFile).side_effect_result.no_output_file_written = false;
    refresh(outputFile).side_effect_result.outputFilesWritten = 1;
    recomputeRefreshKey(outputFile);
    expectValidatorFails(outputFile, 'side-effect-truth-all-blocked');

    const flagRead = clone(build());
    refresh(flagRead).side_effect_result.no_runtime_mode_flag_read = false;
    refresh(flagRead).side_effect_result.runtimeModeFlagRead = true;
    recomputeRefreshKey(flagRead);
    expectValidatorFails(flagRead, 'side-effect-truth-all-blocked');

    const killWire = clone(build());
    refresh(killWire).side_effect_result.no_kill_switch_wired = false;
    refresh(killWire).side_effect_result.killSwitchWired = true;
    recomputeRefreshKey(killWire);
    expectValidatorFails(killWire, 'side-effect-truth-all-blocked');

    const moduleImplemented = clone(build());
    refresh(moduleImplemented).side_effect_result.no_module_or_cli_implemented = false;
    refresh(moduleImplemented).side_effect_result.moduleOrCliImplemented = true;
    recomputeRefreshKey(moduleImplemented);
    expectValidatorFails(moduleImplemented, 'no-module-cli-test-runtime-work');

    const rawSecret = clone(build());
    refresh(rawSecret).redaction_summary.note = 'raw bearer token';
    recomputeRefreshKey(rawSecret);
    expectValidatorFails(rawSecret, 'redaction-summary-safe');
    expectValidatorFails(rawSecret, 'forbidden-output-strings-absent');
  });

  test('validator rejects unsafe next-action drift and Tier2+ recommendations after idempotency recompute', () => {
    const liveRuntime = clone(build());
    refresh(liveRuntime).next_phase_recommendations[0].action = 'start live runtime';
    recomputeRefreshKey(liveRuntime);
    expectValidatorFails(liveRuntime, 'unsafe-action-drift-blocked');

    const wireKill = clone(build());
    refresh(wireKill).next_phase_recommendations[0].action = 'wire kill switch now';
    recomputeRefreshKey(wireKill);
    expectValidatorFails(wireKill, 'unsafe-action-drift-blocked');

    const readFlag = clone(build());
    refresh(readFlag).next_phase_recommendations[0].why_safe = 'read runtime mode flag from env';
    recomputeRefreshKey(readFlag);
    expectValidatorFails(readFlag, 'unsafe-action-drift-blocked');

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
    expectValidatorFails(missingTamper, 'validation-report-coverage-bound');
    expectValidatorFails(missingTamper, 'validation-report-matches-contract');

    const literalLie = clone(build());
    refresh(literalLie).baseline_commit = 'a62fe16';
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
    expect(parsed.fixturePath).toContain('mira-core-runtime-mode-kill-switch-status-gap-refresh-contract.json');

    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const output = main(['--out=ignored.json'], JSON.stringify({
      profile: { name: 'main' },
      sessionId: 'session-cli',
      deviceId: 'VIGIL',
    }));

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(refresh(output).schema).toBe(RUNTIME_MODE_KILL_SWITCH_STATUS_GAP_REFRESH_SCHEMA_VERSION);
    expect(refresh(output).sessionId).toBe('session-cli');
    expect(refresh(output).baseline_commit).toBe(BASELINE_COMMIT);
    expect(refresh(output).phase_registry.current_through_phase).toBe(40);
    expect(refresh(output).phase_registry.phase_inventory_count).toBe(40);
    expect(refresh(output).phase_registry.schema_registry_count).toBe(40);
    expect(refresh(output).phase_registry.cli_registry_count).toBe(40);
    expect(refresh(output).schema_registry).toHaveLength(40);
    expect(refresh(output).cli_registry).toHaveLength(40);
    expect(refresh(output).commit_chain).toHaveLength(28);
    expect(refresh(output).source_refs).toHaveLength(10);
    expect(refresh(output).status_gap_matrix).toHaveLength(2);
    expect(refresh(output).runtime_mode_status.effective_state).toBe('disabled');
    expect(refresh(output).runtime_mode_status.flag_reader_implemented).toBe(false);
    expect(refresh(output).runtime_mode_status.flag_read_now).toBe(false);
    expect(refresh(output).kill_switch_status.wired).toBe(false);
    expect(refresh(output).kill_switch_status.live_check_performed).toBe(false);
    expect(refresh(output).capability_matrix.runtimeStarted).toBe(false);
    expect(refresh(output).capability_matrix.runnerExecuted).toBe(false);
    expect(refresh(output).capability_matrix.serverCanExecuteLocal).toBe(false);
    expect(refresh(output).side_effect_result.no_output_file_written).toBe(true);
    expect(refresh(output).side_effect_result.no_runtime_mode_flag_read).toBe(true);
    expect(refresh(output).side_effect_result.no_kill_switch_wired).toBe(true);
    expect(validationReport(output).decision).toBe('accepted_validation_only');
    expect(validateMiraCoreRuntimeModeKillSwitchStatusGapRefreshOutput(
      output,
      runtimeModeKillSwitchStatusGapRefreshContract,
    )).toEqual(expect.objectContaining({ ok: true }));
  });
});
