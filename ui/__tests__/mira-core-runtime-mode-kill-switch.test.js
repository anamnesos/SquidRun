const runtimeModeKillSwitchContract = require('./fixtures/mira-core-runtime-mode-kill-switch-contract.json');
const {
  BASELINE_COMMIT,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_REFERENCE_FIELDS,
  REQUIRED_SIDE_EFFECT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  RUNTIME_MODE_KILL_SWITCH_REFERENCE_SCHEMA_VERSION,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreRuntimeModeKillSwitch,
  runtimeModeKillSwitchIdempotencyKey,
  validateMiraCoreRuntimeModeKillSwitchOutput,
} = require('../modules/mira-core/runtime-mode-kill-switch');
const {
  main,
  parseArgs,
} = require('../scripts/hm-mira-core-runtime-mode-kill-switch');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function build(inputSignals = {}) {
  return buildMiraCoreRuntimeModeKillSwitch({
    contract: runtimeModeKillSwitchContract,
    inputSignals,
    nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
  });
}

function reference(output) {
  return output.runtime_mode_kill_switch_reference;
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
    runtimeModeKillSwitchContract.forbiddenOutputSubstrings,
  )).not.toThrow();
}

function expectValidatorFails(output, checkId) {
  const validation = validateMiraCoreRuntimeModeKillSwitchOutput(
    output,
    runtimeModeKillSwitchContract,
  );
  expect(validation.ok).toBe(false);
  expect(validation.checks.some((entry) => entry.id === checkId && entry.ok === false)).toBe(true);
}

function recomputeReferenceKey(output) {
  reference(output).idempotency_key = runtimeModeKillSwitchIdempotencyKey(reference(output));
}

describe('mira core runtime mode kill-switch reference v0', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('satisfies Oracle top-level, manifest, and validation report shapes', () => {
    const output = build();
    const current = reference(output);
    const report = validationReport(output);

    expectRequiredFields(output, runtimeModeKillSwitchContract.expectedOutputShape.requiredTopLevelFields);
    expect(runtimeModeKillSwitchContract.expectedOutputShape.requiredTopLevelFields)
      .toEqual(REQUIRED_OUTPUT_FIELDS);
    expect(current.schema).toBe(RUNTIME_MODE_KILL_SWITCH_REFERENCE_SCHEMA_VERSION);
    expect(report.schema).toBe(VALIDATION_REPORT_SCHEMA_VERSION);
    expectRequiredFields(current, runtimeModeKillSwitchContract.expectedManifestShape.requiredFields);
    expect(runtimeModeKillSwitchContract.expectedManifestShape.requiredFields)
      .toEqual(REQUIRED_REFERENCE_FIELDS);
    expectRequiredFields(report, runtimeModeKillSwitchContract.expectedValidationReportShape.requiredFields);
    expect(runtimeModeKillSwitchContract.expectedValidationReportShape.requiredFields)
      .toEqual(REQUIRED_VALIDATION_REPORT_FIELDS);
    expect(report.accepted).toBe(true);
    expect(report.blocked).toBe(false);
    expect(report.decision).toBe('accepted_validation_only');
    expect(validateMiraCoreRuntimeModeKillSwitchOutput(output, runtimeModeKillSwitchContract))
      .toEqual(expect.objectContaining({ ok: true }));
    expectNoForbiddenOutput(output);
  });

  test('pins baseline a62fe16 and registries through Phase 39', () => {
    const current = reference(build());
    const expected = runtimeModeKillSwitchContract.phaseRegistryExpected;

    expect(BASELINE_COMMIT).toBe(runtimeModeKillSwitchContract.baseline.commit);
    expect(current.baseline_commit).toBe(BASELINE_COMMIT);
    expect(current.phase_registry).toEqual(expect.objectContaining({
      source_ref: expected.source_ref,
      current_through_phase: 39,
      expected_phases: '1-39',
      phase_inventory_count: 39,
      schema_registry_count: 39,
      cli_registry_count: 39,
      phase35_runtime_next_action_current: true,
      phase36_operator_ui_surface_current: true,
      phase37_control_reporting_reconciliation_current: true,
      phase38_runtime_readiness_refresh_current: true,
      phase39_dry_run_readiness_gap_current: true,
      phase39_commit: BASELINE_COMMIT,
    }));
    expect(current.phase_registry.phase39_delta).toEqual(expect.objectContaining(expected.phase39_delta));
    expect(current.schema_registry).toHaveLength(39);
    expect(current.cli_registry).toHaveLength(39);
    expect(current.phase_registry.recent_phase_paths).toEqual(expected.required_recent_phase_paths);
  });

  test('preserves commit chain, source recommendation, satisfied Phase39 work, and current/stale truth', () => {
    const current = reference(build());

    expect(current.commit_chain).toEqual(runtimeModeKillSwitchContract.commitChainExpected);
    expect(current.commit_chain).toHaveLength(
      runtimeModeKillSwitchContract.expectedManifestShape.expectedCounts.commit_chain,
    );
    expect(current.commit_chain[current.commit_chain.length - 1]).toBe(BASELINE_COMMIT);
    expect(current.source_recommendation).toEqual(expect.objectContaining({
      recommendation_id: runtimeModeKillSwitchContract.sourceRecommendation.recommendation_id,
      tier: 'tier1',
      status: 'selected_for_phase40_fixture_only_contract',
      contract_only_now: true,
      implemented_now: false,
      does_not_authorize_ui: true,
      does_not_authorize_runtime: true,
      does_not_authorize_execution: true,
    }));
    expect(current.satisfied_prior_recommendations).toHaveLength(1);
    expect(current.satisfied_prior_recommendations[0]).toEqual(expect.objectContaining({
      recommendation_id: runtimeModeKillSwitchContract.satisfiedPriorRecommendations[0].recommendation_id,
      status: 'satisfied_by_a62fe16_do_not_repeat_as_open_work',
      satisfied_by_commit: BASELINE_COMMIT,
      must_not_reopen: true,
    }));
    expect(current.next_phase_recommendations.map((item) => item.recommendation_id))
      .not.toContain(current.satisfied_prior_recommendations[0].recommendation_id);
    expect(current.current_truth).toEqual(expect.objectContaining(
      runtimeModeKillSwitchContract.currentTruthExpected,
    ));
    expect(current.stale_readiness).toEqual(expect.objectContaining(
      runtimeModeKillSwitchContract.staleReadinessExpected,
    ));
  });

  test('keeps Phase34 prior recommendations, Oracle closures, source refs, and recent paths complete', () => {
    const output = build();
    const current = reference(output);

    expect(current.phase34_prior_recommendations.phase35_runtime_status_milestone_refresh_validator.status)
      .toBe('satisfied_by_c04155d_do_not_repeat_as_open_work');
    expect(current.phase34_prior_recommendations.phase35_stdout_only_cli_smoke.status)
      .toBe('satisfied_by_c04155d_do_not_repeat_as_open_work');
    expect(current.closure_summary).toEqual(expect.objectContaining(
      runtimeModeKillSwitchContract.closureSummaryExpected,
    ));
    expect(current.closure_summary.closed_review_refs)
      .toEqual(runtimeModeKillSwitchContract.closureSummaryExpected.closed_review_refs);
    expect(current.source_refs).toEqual(runtimeModeKillSwitchContract.sourceRefsExpected);
    expect(current.source_refs).toHaveLength(
      runtimeModeKillSwitchContract.expectedManifestShape.expectedCounts.source_refs,
    );
    expect(validationReport(output).referenced_path_results.length).toBeGreaterThan(0);
    expect(validationReport(output).referenced_path_results.every((entry) => entry.ok)).toBe(true);
  });

  test('defines disabled reference-only runtime mode and fail-closed unwired kill-switch records', () => {
    const current = reference(build());
    const modeShape = runtimeModeKillSwitchContract.runtimeModeReferenceShapeExpected;
    const killShape = runtimeModeKillSwitchContract.killSwitchReferenceShapeExpected;

    expectRequiredFields(current.runtime_mode_reference, modeShape.requiredFields);
    expect(current.runtime_mode_reference).toEqual(expect.objectContaining(modeShape.requiredValues));
    expect(Date.parse(current.runtime_mode_reference.expires_at))
      .toBeGreaterThan(Date.parse(current.generated_at));
    expectRequiredFields(current.kill_switch_reference, killShape.requiredFields);
    expect(current.kill_switch_reference).toEqual(expect.objectContaining(killShape.requiredValues));
    expect(current.control_reference).toEqual(expect.objectContaining({
      reference_only: true,
      disabled_by_default: true,
      control_execution_authorized: false,
      reporting_sink_wired: false,
      queue_created: false,
      lease_created: false,
      store_written: false,
      output_file_written: false,
      runtime_mode_flag_read: false,
      kill_switch_wired: false,
      runtime_started: false,
      runner_executed: false,
    }));
  });

  test('maps exactly two Phase39 gaps as unsatisfied, blocking, reference-only, and non-authorizing', () => {
    const current = reference(build());
    const expected = runtimeModeKillSwitchContract.gapMappingExpected;
    const entries = [current.gap_mapping.runtime_mode_flag_gap, current.gap_mapping.kill_switch_gap];

    expect(entries.map((entry) => entry.gap_id)).toEqual(expected.map((entry) => entry.gap_id));
    expect(entries).toHaveLength(runtimeModeKillSwitchContract.expectedManifestShape.expectedCounts.gap_mapping);
    for (const gap of entries) {
      const expectedGap = expected.find((item) => item.gap_id === gap.gap_id);
      expect(gap).toEqual(expect.objectContaining({
        maps_from_phase39_gap: expectedGap.maps_from_phase39_gap,
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
    const current = reference(output);

    expect(current.capability_matrix).toEqual(expect.objectContaining(
      runtimeModeKillSwitchContract.capabilityMatrixExpected,
    ));
    expect(current.boundary_truth).toEqual(expect.objectContaining(
      runtimeModeKillSwitchContract.proofBoundaryExpected,
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
    const current = reference(build());

    expect(current.next_phase_recommendations).toHaveLength(
      runtimeModeKillSwitchContract.nextRecommendationExpectedCandidates.length,
    );
    expect(current.next_phase_recommendations).toEqual(expect.arrayContaining(
      runtimeModeKillSwitchContract.nextRecommendationExpectedCandidates
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
    const validation = validateMiraCoreRuntimeModeKillSwitchOutput(
      output,
      runtimeModeKillSwitchContract,
    );
    const checkIds = validation.checks.map((entry) => entry.id);
    const staticIds = validationReport(output).static_rule_results.map((entry) => entry.id);
    const acceptanceIds = validationReport(output).acceptance_check_results.map((entry) => entry.id);

    expect(validation.ok).toBe(true);
    for (const rule of runtimeModeKillSwitchContract.staticValidationRules) {
      expect(checkIds).toContain(rule.id);
      expect(staticIds).toContain(rule.id);
    }
    for (const check of runtimeModeKillSwitchContract.acceptanceChecks) {
      expect(checkIds).toContain(check.id);
      expect(acceptanceIds).toContain(check.id);
    }
    expect(validationReport(output).tamper_case_results).toHaveLength(
      runtimeModeKillSwitchContract.tamperCases.length,
    );
    expect(validationReport(output).tamper_case_results.length)
      .toBeGreaterThanOrEqual(
        runtimeModeKillSwitchContract.expectedManifestShape.expectedCounts.tamper_case_results_min,
      );
    expect(validationReport(output).required_literal_results.length)
      .toBeGreaterThanOrEqual(
        runtimeModeKillSwitchContract.expectedManifestShape.expectedCounts.required_literal_results_min,
      );
    expect(validationReport(output).required_literal_results.every((entry) => entry.ok)).toBe(true);
    expect(validationReport(output).referenced_path_results.every((entry) => entry.ok)).toBe(true);
  });

  test('idempotency is stable for equivalent inputs and sensitive to reference changes', () => {
    const first = reference(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'VIGIL' }));
    const second = reference(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'VIGIL' }));
    const changedDevice = reference(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'ALT' }));
    const changedProfile = reference(build({ profile: { name: 'side' }, sessionId: 'session-a', deviceId: 'VIGIL' }));

    expect(first.idempotency_key).toBe(second.idempotency_key);
    expect(first.reference_id).toBe(second.reference_id);
    expect(first.idempotency_key).not.toBe(changedDevice.idempotency_key);
    expect(first.idempotency_key).not.toBe(changedProfile.idempotency_key);

    const changed = clone(build());
    const originalKey = reference(changed).idempotency_key;
    reference(changed).runtime_mode_reference.effective_state = 'dry_run_preview_only';
    recomputeReferenceKey(changed);
    expect(reference(changed).idempotency_key).not.toBe(originalKey);
    expectValidatorFails(changed, 'runtime-mode-reference-disabled-reference-only');
  });

  test('validator rejects baseline, registry, commit-chain, source, prior, stale, source-ref, and path drift', () => {
    const baseline = clone(build());
    reference(baseline).baseline_commit = '85c78ab';
    recomputeReferenceKey(baseline);
    expectValidatorFails(baseline, 'baseline-pinned-a62fe16');

    const phase39 = clone(build());
    reference(phase39).phase_registry.phase39_dry_run_readiness_gap_current = false;
    recomputeReferenceKey(phase39);
    expectValidatorFails(phase39, 'phase39-current');

    const phase35 = clone(build());
    reference(phase35).current_truth.phase35_current = false;
    recomputeReferenceKey(phase35);
    expectValidatorFails(phase35, 'phase35-current-preserved');

    const phase36 = clone(build());
    reference(phase36).current_truth.phase36_current = false;
    recomputeReferenceKey(phase36);
    expectValidatorFails(phase36, 'phase36-current-preserved');

    const phase37 = clone(build());
    reference(phase37).current_truth.phase37_current = false;
    recomputeReferenceKey(phase37);
    expectValidatorFails(phase37, 'phase37-current-preserved');

    const phase38 = clone(build());
    reference(phase38).current_truth.phase38_current = false;
    recomputeReferenceKey(phase38);
    expectValidatorFails(phase38, 'phase38-current-preserved');

    const count = clone(build());
    reference(count).phase_registry.phase_inventory_count = 38;
    recomputeReferenceKey(count);
    expectValidatorFails(count, 'phase-inventory-count-39');

    const chain = clone(build());
    reference(chain).commit_chain = reference(chain).commit_chain.filter((commit) => commit !== BASELINE_COMMIT);
    recomputeReferenceKey(chain);
    expectValidatorFails(chain, 'commit-chain-exact-27');

    const source = clone(build());
    reference(source).source_recommendation.recommendation_id = 'phase40-runtime-dry-run-readiness-gap-validator';
    recomputeReferenceKey(source);
    expectValidatorFails(source, 'source-recommendation-tier1-selected');

    const satisfied = clone(build());
    reference(satisfied).satisfied_prior_recommendations[0].status = 'open';
    recomputeReferenceKey(satisfied);
    expectValidatorFails(satisfied, 'phase39-tier0-satisfied-not-open');

    const stale13 = clone(build());
    reference(stale13).stale_readiness.phase13_readiness_current = true;
    recomputeReferenceKey(stale13);
    expectValidatorFails(stale13, 'phase13-stale-preserved');

    const stale23 = clone(build());
    reference(stale23).stale_readiness.phase23_milestone_readiness_current = true;
    recomputeReferenceKey(stale23);
    expectValidatorFails(stale23, 'phase23-stale-preserved');

    const stale31 = clone(build());
    reference(stale31).stale_readiness.phase31_runtime_milestone_refresh_current = true;
    recomputeReferenceKey(stale31);
    expectValidatorFails(stale31, 'phase31-stale-preserved');

    const missingClosure = clone(build());
    reference(missingClosure).closure_summary.phase39_oracle_156_read_only_review_green = false;
    recomputeReferenceKey(missingClosure);
    expectValidatorFails(missingClosure, 'closures-carried-oracle-115-123-127-131-134-137-141-148-149-156');

    const missingRef = clone(build());
    reference(missingRef).source_refs = reference(missingRef).source_refs
      .filter((ref) => ref.artifact_id !== 'phase39-runtime-dry-run-readiness-gap');
    recomputeReferenceKey(missingRef);
    expectValidatorFails(missingRef, 'source-refs-phase26-27-29-30-32-33-37-38-39');

    const missingPath = clone(build());
    reference(missingPath).phase_registry.recent_phase_paths = reference(missingPath).phase_registry.recent_phase_paths
      .filter((entry) => entry.phase !== 39);
    recomputeReferenceKey(missingPath);
    expectValidatorFails(missingPath, 'recent-phase-paths-present');
  });

  test('validator rejects runtime mode, kill-switch, control, and gap mapping drift', () => {
    const modeEnabled = clone(build());
    reference(modeEnabled).runtime_mode_reference.effective_state = 'dry_run_preview_only';
    recomputeReferenceKey(modeEnabled);
    expectValidatorFails(modeEnabled, 'runtime-mode-reference-disabled-reference-only');

    const modeImplemented = clone(build());
    reference(modeImplemented).runtime_mode_reference.implemented_now = true;
    recomputeReferenceKey(modeImplemented);
    expectValidatorFails(modeImplemented, 'runtime-mode-reference-disabled-reference-only');

    const flagReader = clone(build());
    reference(flagReader).runtime_mode_reference.flag_reader_implemented = true;
    recomputeReferenceKey(flagReader);
    expectValidatorFails(flagReader, 'runtime-mode-reference-disabled-reference-only');

    const modeAuthorizes = clone(build());
    reference(modeAuthorizes).runtime_mode_reference.authorizes_runtime = true;
    recomputeReferenceKey(modeAuthorizes);
    expectValidatorFails(modeAuthorizes, 'runtime-mode-reference-disabled-reference-only');
    expectValidatorFails(modeAuthorizes, 'mode-kill-switch-references-do-not-satisfy-gaps');

    const killWired = clone(build());
    reference(killWired).kill_switch_reference.wired = true;
    recomputeReferenceKey(killWired);
    expectValidatorFails(killWired, 'kill-switch-reference-fail-closed-reference-only');

    const killAllow = clone(build());
    reference(killAllow).kill_switch_reference.default_behavior = 'allow';
    recomputeReferenceKey(killAllow);
    expectValidatorFails(killAllow, 'kill-switch-reference-fail-closed-reference-only');

    const killAuthorizes = clone(build());
    reference(killAuthorizes).kill_switch_reference.authorizes_execution = true;
    recomputeReferenceKey(killAuthorizes);
    expectValidatorFails(killAuthorizes, 'kill-switch-reference-fail-closed-reference-only');

    const gapSatisfied = clone(build());
    reference(gapSatisfied).gap_mapping.runtime_mode_flag_gap.satisfied_now = true;
    recomputeReferenceKey(gapSatisfied);
    expectValidatorFails(gapSatisfied, 'gap-mapping-two-unsatisfied-gaps');
    expectValidatorFails(gapSatisfied, 'mode-kill-switch-references-do-not-satisfy-gaps');

    const gapNoBlock = clone(build());
    reference(gapNoBlock).gap_mapping.runtime_mode_flag_gap.blocks_runtime_now = false;
    recomputeReferenceKey(gapNoBlock);
    expectValidatorFails(gapNoBlock, 'gap-mapping-two-unsatisfied-gaps');

    const queue = clone(build());
    reference(queue).control_reference.queue_created = true;
    recomputeReferenceKey(queue);
    expectValidatorFails(queue, 'control-reference-no-side-effects');

    const sink = clone(build());
    reference(sink).control_reference.reporting_sink_wired = true;
    recomputeReferenceKey(sink);
    expectValidatorFails(sink, 'control-reference-no-side-effects');
  });

  test('validator rejects capability, proof, side-effect, scope, and redaction overclaims', () => {
    const runtime = clone(build());
    reference(runtime).capability_matrix.runtimeStarted = true;
    reference(runtime).boundary_truth.runtimeStarted = true;
    reference(runtime).side_effect_result.runtimeStarted = true;
    recomputeReferenceKey(runtime);
    expectValidatorFails(runtime, 'capability-truth-false');
    expectValidatorFails(runtime, 'runtime-started-false');

    const runner = clone(build());
    reference(runner).capability_matrix.runnerExecuted = true;
    recomputeReferenceKey(runner);
    expectValidatorFails(runner, 'capability-truth-false');
    expectValidatorFails(runner, 'runner-executed-false');

    const modelProof = clone(build());
    reference(modelProof).capability_matrix.serverCanProveModelProcessing = true;
    recomputeReferenceKey(modelProof);
    expectValidatorFails(modelProof, 'capability-truth-false');

    const directTarget = clone(build());
    reference(directTarget).capability_matrix.directBuilderOracleServerTargetsAllowed = true;
    reference(directTarget).boundary_truth.builderOracleDirectServerTargetsAllowed = true;
    recomputeReferenceKey(directTarget);
    expectValidatorFails(directTarget, 'builder-oracle-direct-targets-blocked');

    const deliveryProof = clone(build());
    reference(deliveryProof).boundary_truth.deliveryAcceptanceIsModelProcessingProof = true;
    recomputeReferenceKey(deliveryProof);
    expectValidatorFails(deliveryProof, 'proof-boundaries-false');

    const phase39Proof = clone(build());
    reference(phase39Proof).boundary_truth.phase39CommitIsRuntimeProof = true;
    recomputeReferenceKey(phase39Proof);
    expectValidatorFails(phase39Proof, 'proof-boundaries-false');

    const outputFile = clone(build());
    reference(outputFile).side_effect_result.no_output_file_written = false;
    reference(outputFile).side_effect_result.outputFilesWritten = 1;
    recomputeReferenceKey(outputFile);
    expectValidatorFails(outputFile, 'side-effect-truth-all-blocked');

    const flagRead = clone(build());
    reference(flagRead).side_effect_result.no_runtime_mode_flag_read = false;
    reference(flagRead).side_effect_result.runtimeModeFlagRead = true;
    recomputeReferenceKey(flagRead);
    expectValidatorFails(flagRead, 'side-effect-truth-all-blocked');

    const killWire = clone(build());
    reference(killWire).side_effect_result.no_kill_switch_wired = false;
    reference(killWire).side_effect_result.killSwitchWired = true;
    recomputeReferenceKey(killWire);
    expectValidatorFails(killWire, 'side-effect-truth-all-blocked');

    const moduleImplemented = clone(build());
    reference(moduleImplemented).side_effect_result.no_module_or_cli_implemented = false;
    reference(moduleImplemented).side_effect_result.moduleOrCliImplemented = true;
    recomputeReferenceKey(moduleImplemented);
    expectValidatorFails(moduleImplemented, 'no-module-cli-test-runtime-work');

    const rawSecret = clone(build());
    reference(rawSecret).redaction_summary.note = 'raw bearer token';
    recomputeReferenceKey(rawSecret);
    expectValidatorFails(rawSecret, 'redaction-summary-safe');
    expectValidatorFails(rawSecret, 'forbidden-output-strings-absent');
  });

  test('validator rejects unsafe next-action drift and Tier2+ recommendations after idempotency recompute', () => {
    const liveRuntime = clone(build());
    reference(liveRuntime).next_phase_recommendations[0].action = 'start live runtime';
    recomputeReferenceKey(liveRuntime);
    expectValidatorFails(liveRuntime, 'unsafe-action-drift-blocked');

    const wireKill = clone(build());
    reference(wireKill).next_phase_recommendations[0].action = 'wire kill switch now';
    recomputeReferenceKey(wireKill);
    expectValidatorFails(wireKill, 'unsafe-action-drift-blocked');

    const readFlag = clone(build());
    reference(readFlag).next_phase_recommendations[0].why_safe = 'read runtime mode flag from env';
    recomputeReferenceKey(readFlag);
    expectValidatorFails(readFlag, 'unsafe-action-drift-blocked');

    const tier2 = clone(build());
    reference(tier2).next_phase_recommendations[0].tier = 'tier2';
    recomputeReferenceKey(tier2);
    expectValidatorFails(tier2, 'next-recommendations-tier0-tier1-only');

    const customerSend = clone(build());
    reference(customerSend).next_phase_recommendations[0].why_safe = 'safe to send customer message';
    recomputeReferenceKey(customerSend);
    expectValidatorFails(customerSend, 'unsafe-action-drift-blocked');
    expectValidatorFails(customerSend, 'unsafe-action-drift-rejected');

    const controlExecution = clone(build());
    reference(controlExecution).next_phase_recommendations[0].why_safe = 'execute control and write report';
    recomputeReferenceKey(controlExecution);
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
    reference(literalLie).baseline_commit = '85c78ab';
    recomputeReferenceKey(literalLie);
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
    expect(parsed.fixturePath).toContain('mira-core-runtime-mode-kill-switch-contract.json');

    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const output = main(['--out=ignored.json'], JSON.stringify({
      profile: { name: 'main' },
      sessionId: 'session-cli',
      deviceId: 'VIGIL',
    }));

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(reference(output).schema).toBe(RUNTIME_MODE_KILL_SWITCH_REFERENCE_SCHEMA_VERSION);
    expect(reference(output).sessionId).toBe('session-cli');
    expect(reference(output).baseline_commit).toBe(BASELINE_COMMIT);
    expect(reference(output).phase_registry.current_through_phase).toBe(39);
    expect(reference(output).phase_registry.phase_inventory_count).toBe(39);
    expect(reference(output).phase_registry.schema_registry_count).toBe(39);
    expect(reference(output).phase_registry.cli_registry_count).toBe(39);
    expect(reference(output).schema_registry).toHaveLength(39);
    expect(reference(output).cli_registry).toHaveLength(39);
    expect(reference(output).commit_chain).toHaveLength(27);
    expect(reference(output).source_refs).toHaveLength(9);
    expect(Object.keys(reference(output).gap_mapping)).toHaveLength(2);
    expect(reference(output).runtime_mode_reference.effective_state).toBe('disabled');
    expect(reference(output).kill_switch_reference.wired).toBe(false);
    expect(reference(output).capability_matrix.runtimeStarted).toBe(false);
    expect(reference(output).capability_matrix.runnerExecuted).toBe(false);
    expect(reference(output).capability_matrix.serverCanExecuteLocal).toBe(false);
    expect(reference(output).side_effect_result.no_output_file_written).toBe(true);
    expect(reference(output).side_effect_result.no_runtime_mode_flag_read).toBe(true);
    expect(reference(output).side_effect_result.no_kill_switch_wired).toBe(true);
    expect(validationReport(output).decision).toBe('accepted_validation_only');
    expect(validateMiraCoreRuntimeModeKillSwitchOutput(output, runtimeModeKillSwitchContract))
      .toEqual(expect.objectContaining({ ok: true }));
  });
});
