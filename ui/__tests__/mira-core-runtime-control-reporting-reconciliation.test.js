const runtimeControlReportingContract = require('./fixtures/mira-core-runtime-control-reporting-reconciliation-contract.json');
const {
  BASELINE_COMMIT,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_RECONCILIATION_FIELDS,
  REQUIRED_SIDE_EFFECT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  RUNTIME_CONTROL_REPORTING_RECONCILIATION_SCHEMA_VERSION,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreRuntimeControlReportingReconciliation,
  runtimeControlReportingReconciliationIdempotencyKey,
  validateMiraCoreRuntimeControlReportingReconciliationOutput,
} = require('../modules/mira-core/runtime-control-reporting-reconciliation');
const {
  main,
  parseArgs,
} = require('../scripts/hm-mira-core-runtime-control-reporting-reconciliation');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function build(inputSignals = {}) {
  return buildMiraCoreRuntimeControlReportingReconciliation({
    contract: runtimeControlReportingContract,
    inputSignals,
    nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
  });
}

function reconciliation(output) {
  return output.runtime_control_reporting_reconciliation;
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
  expect(() => assertNoForbiddenOutput(output, runtimeControlReportingContract.forbiddenOutputSubstrings)).not.toThrow();
}

function expectValidatorFails(output, checkId) {
  const validation = validateMiraCoreRuntimeControlReportingReconciliationOutput(output, runtimeControlReportingContract);
  expect(validation.ok).toBe(false);
  expect(validation.checks.find((entry) => entry.id === checkId)).toEqual(expect.objectContaining({ ok: false }));
}

function recomputeReconciliationKey(output) {
  reconciliation(output).idempotency_key =
    runtimeControlReportingReconciliationIdempotencyKey(reconciliation(output));
}

describe('mira core runtime control/reporting reconciliation v0', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('satisfies Oracle top-level, reconciliation, and validation report shapes', () => {
    const output = build();
    const current = reconciliation(output);
    const report = validationReport(output);

    expectRequiredFields(output, runtimeControlReportingContract.expectedOutputShape.requiredTopLevelFields);
    expect(runtimeControlReportingContract.expectedOutputShape.requiredTopLevelFields).toEqual(REQUIRED_OUTPUT_FIELDS);
    expect(current.schema).toBe(RUNTIME_CONTROL_REPORTING_RECONCILIATION_SCHEMA_VERSION);
    expect(report.schema).toBe(VALIDATION_REPORT_SCHEMA_VERSION);
    expectRequiredFields(current, runtimeControlReportingContract.expectedManifestShape.requiredFields);
    expect(runtimeControlReportingContract.expectedManifestShape.requiredFields).toEqual(REQUIRED_RECONCILIATION_FIELDS);
    expectRequiredFields(report, runtimeControlReportingContract.expectedValidationReportShape.requiredFields);
    expect(runtimeControlReportingContract.expectedValidationReportShape.requiredFields).toEqual(REQUIRED_VALIDATION_REPORT_FIELDS);
    expect(report.accepted).toBe(true);
    expect(report.blocked).toBe(false);
    expect(report.decision).toBe('accepted_validation_only');
    expect(validateMiraCoreRuntimeControlReportingReconciliationOutput(output, runtimeControlReportingContract))
      .toEqual(expect.objectContaining({ ok: true }));
    expectNoForbiddenOutput(output);
  });

  test('pins baseline 6f08b05 and phase/schema/CLI registries through Phase 36', () => {
    const current = reconciliation(build());
    const expected = runtimeControlReportingContract.phaseRegistryExpected;

    expect(current.baseline_commit).toBe(BASELINE_COMMIT);
    expect(BASELINE_COMMIT).toBe(runtimeControlReportingContract.baseline.commit);
    expect(current.phase_registry).toEqual(expect.objectContaining({
      source_ref: expected.source_ref,
      current_through_phase: 36,
      expected_phases: '1-36',
      phase_inventory_count: 36,
      schema_registry_count: 36,
      cli_registry_count: 36,
      phase35_current: true,
      phase36_operator_ui_surface_current: true,
      phase36_commit: BASELINE_COMMIT,
    }));
    expect(current.phase_registry.phase36_delta).toEqual(expect.objectContaining(expected.phase36_delta));
    expect(current.phase_registry.phase36_delta.capability_truth).toEqual(expect.objectContaining({
      runtimeStarted: false,
      runnerExecuted: false,
      runtimeAvailable: false,
      serverCanExecuteLocal: false,
      serverCanProveModelProcessing: false,
      directBuilderOracleServerTargetsAllowed: false,
    }));
  });

  test('preserves commit chain, source recommendation, satisfied prior work, and stale readiness truth', () => {
    const current = reconciliation(build());

    expect(current.commit_chain).toEqual(runtimeControlReportingContract.commitChainExpected);
    expect(current.commit_chain).toHaveLength(runtimeControlReportingContract.expectedManifestShape.expectedCounts.commit_chain);
    expect(current.commit_chain[current.commit_chain.length - 1]).toBe(BASELINE_COMMIT);
    expect(current.source_recommendation).toEqual(expect.objectContaining({
      recommendation_id: runtimeControlReportingContract.sourceRecommendation.recommendation_id,
      tier: 'tier1',
      status: 'selected_for_phase37_fixture_only_contract',
      contract_only_now: true,
      implemented_now: false,
      does_not_authorize_ui: true,
      does_not_authorize_runtime: true,
      does_not_authorize_execution: true,
    }));
    expect(current.satisfied_prior_recommendations).toHaveLength(1);
    expect(current.satisfied_prior_recommendations[0]).toEqual(expect.objectContaining({
      recommendation_id: runtimeControlReportingContract.satisfiedPriorRecommendations[0].recommendation_id,
      status: 'satisfied_by_6f08b05_do_not_repeat_as_open_work',
      satisfied_by_commit: BASELINE_COMMIT,
      must_not_reopen: true,
    }));
    expect(current.stale_readiness).toEqual(expect.objectContaining(runtimeControlReportingContract.staleReadinessExpected));
    expect(current.stale_readiness.phase13_readiness_current).toBe(false);
    expect(current.stale_readiness.phase23_milestone_readiness_current).toBe(false);
    expect(current.stale_readiness.phase31_runtime_milestone_refresh_current).toBe(false);
    expect(current.stale_readiness.phase35_runtime_next_action_current).toBe(true);
    expect(current.stale_readiness.phase36_runtime_operator_ui_surface_current).toBe(true);
  });

  test('keeps Phase34 recommendations satisfied and carries Oracle closures plus Phase29/30/32/33/34/35/36 refs', () => {
    const current = reconciliation(build());

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
    }));
    expect(current.closure_summary.closed_review_refs)
      .toEqual(['ORACLE #115', 'ORACLE #123', 'ORACLE #127', 'ORACLE #131', 'ORACLE #134', 'ORACLE #137']);
    expect(current.source_refs).toEqual(runtimeControlReportingContract.sourceRefsExpected);
    expect(current.source_refs).toHaveLength(runtimeControlReportingContract.expectedManifestShape.expectedCounts.source_refs);
  });

  test('defines disabled control state, contract-only dry-run status, and reference-only gates', () => {
    const current = reconciliation(build());
    const shape = runtimeControlReportingContract.controlStateShapeExpected;

    expectRequiredFields(current.control_state, shape.requiredFields);
    expect(current.control_state).toEqual(expect.objectContaining({
      disabled_by_default: true,
      operator_visible: true,
      control_execution_authorized: false,
      kill_switch_wired: false,
      rollback_wired: false,
      reporting_sink_wired: false,
    }));
    expectRequiredFields(current.control_state.runtime_mode_flag, shape.runtimeModeFlag.requiredFields);
    expect(current.control_state.runtime_mode_flag).toEqual(expect.objectContaining(shape.runtimeModeFlag.requiredValues));
    expectRequiredFields(current.dry_run_status, shape.dryRunStatusRequiredFields);
    expect(current.dry_run_status).toEqual(expect.objectContaining({
      contract_only: true,
      runner_executed: false,
      runtime_started: false,
      runtime_available: false,
      queue_created: false,
      lease_created: false,
      store_written: false,
      output_file_written: false,
      execution_performed: false,
      side_effects_performed: false,
    }));
    expect(Object.values(current.gates)).toHaveLength(shape.requiredGates.length);
    expect(Object.values(current.gates).map((gate) => gate.gate_id)).toEqual(expect.arrayContaining(shape.requiredGates));
    for (const gate of Object.values(current.gates)) {
      expectRequiredFields(gate, shape.gateRequiredFields);
      expect(gate.reference_only).toBe(true);
      expect(gate.implemented).toBe(false);
      expect(gate.wired).toBe(false);
      expect(gate.does_not_authorize_runtime).toBe(true);
      expect(gate.does_not_authorize_execution).toBe(true);
    }
  });

  test('defines display-only operator reporting summary with report cards and status lines', () => {
    const current = reconciliation(build());
    const shape = runtimeControlReportingContract.controlStateShapeExpected;

    expectRequiredFields(current.operator_reporting_summary, shape.reportingSummaryRequiredFields);
    expect(current.operator_reporting_summary).toEqual(expect.objectContaining({
      operator_visible: true,
      display_only: true,
      non_authorizing: true,
      ui_rendering_authorized: false,
      browser_window_capture_authorized: false,
      output_file_authorized: false,
      redaction_status: 'redacted_metadata_only',
    }));
    expect(current.operator_reporting_summary.report_cards).toHaveLength(shape.requiredReportCards.length);
    expect(current.operator_reporting_summary.report_cards.map((card) => card.card_id))
      .toEqual(expect.arrayContaining(shape.requiredReportCards));
    expect(current.operator_reporting_summary.status_lines).toEqual(expect.arrayContaining(shape.requiredStatusLines));
    expect(current.reporting_shape).toEqual(expect.objectContaining({
      gate_count: 4,
      reference_only: true,
      implemented: false,
      display_only: true,
      output_file_authorized: false,
    }));
  });

  test('preserves capability, proof, redaction, queue/lease/store/output, and side-effect boundaries', () => {
    const output = build();
    const current = reconciliation(output);

    expect(current.capability_matrix).toEqual(expect.objectContaining({
      runtimeStarted: false,
      runnerExecuted: false,
      runtimeAvailable: false,
      realRuntimeAvailable: false,
      serverCanExecuteLocal: false,
      serverCanProveModelProcessing: false,
      directBuilderOracleServerTargetsAllowed: false,
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
      controlReportIsRuntimeProof: false,
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
    expect(current.dry_run_status.queue_created).toBe(false);
    expect(current.dry_run_status.lease_created).toBe(false);
    expect(current.dry_run_status.store_written).toBe(false);
    expect(current.dry_run_status.output_file_written).toBe(false);
    expect(current.dry_run_status.execution_performed).toBe(false);
    for (const field of REQUIRED_SIDE_EFFECT_FIELDS) {
      expect(current.side_effect_result[field]).toBe(true);
      expect(validationReport(output).side_effect_truth[field]).toBe(true);
    }
  });

  test('next recommendations are Tier0/Tier1, non-authorizing, and match fixture candidates', () => {
    const current = reconciliation(build());

    expect(current.next_phase_recommendations).toHaveLength(
      runtimeControlReportingContract.nextRecommendationExpectedCandidates.length,
    );
    expect(current.next_phase_recommendations).toEqual(expect.arrayContaining(
      runtimeControlReportingContract.nextRecommendationExpectedCandidates.map((candidate) => expect.objectContaining(candidate)),
    ));
    for (const recommendation of current.next_phase_recommendations) {
      expect(['tier0', 'tier1']).toContain(recommendation.tier);
      expect(recommendation.does_not_authorize_ui).toBe(true);
      expect(recommendation.does_not_authorize_runtime).toBe(true);
      expect(recommendation.does_not_authorize_execution).toBe(true);
      expect(recommendation.blocked_side_effects.length).toBeGreaterThan(0);
    }
  });

  test('static rules, acceptance checks, tamper cases, and required literal results are represented', () => {
    const output = build();
    const validation = validateMiraCoreRuntimeControlReportingReconciliationOutput(output, runtimeControlReportingContract);
    const checkIds = validation.checks.map((entry) => entry.id);
    const staticIds = validationReport(output).static_rule_results.map((entry) => entry.id);
    const acceptanceIds = validationReport(output).acceptance_check_results.map((entry) => entry.id);

    expect(validation.ok).toBe(true);
    for (const rule of runtimeControlReportingContract.staticValidationRules) {
      expect(checkIds).toContain(rule.id);
      expect(staticIds).toContain(rule.id);
    }
    for (const check of runtimeControlReportingContract.acceptanceChecks) {
      expect(checkIds).toContain(check.id);
      expect(acceptanceIds).toContain(check.id);
    }
    expect(validationReport(output).tamper_case_results).toHaveLength(runtimeControlReportingContract.tamperCases.length);
    expect(validationReport(output).tamper_case_results.length)
      .toBeGreaterThanOrEqual(runtimeControlReportingContract.expectedManifestShape.expectedCounts.tamper_case_results_min);
    expect(validationReport(output).tamper_case_results.every((entry) => entry.covered && entry.expectedFailure)).toBe(true);
    expect(validationReport(output).required_literal_results).toHaveLength(
      Object.keys(runtimeControlReportingContract.expectedManifestShape.requiredLiteralValues).length,
    );
    expect(validationReport(output).required_literal_results.every((entry) => entry.ok)).toBe(true);
  });

  test('idempotency is stable for equivalent inputs and sensitive to meaningful reconciliation changes', () => {
    const first = reconciliation(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'VIGIL' }));
    const second = reconciliation(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'VIGIL' }));
    const changedDevice = reconciliation(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'ALT' }));
    const changedProfile = reconciliation(build({ profile: { name: 'side' }, sessionId: 'session-a', deviceId: 'VIGIL' }));

    expect(first.idempotency_key).toBe(second.idempotency_key);
    expect(first.reconciliation_id).toBe(second.reconciliation_id);
    expect(first.idempotency_key).not.toBe(changedDevice.idempotency_key);
    expect(first.idempotency_key).not.toBe(changedProfile.idempotency_key);

    const changed = clone(build());
    const originalKey = reconciliation(changed).idempotency_key;
    reconciliation(changed).closure_summary.phase36_oracle_137_read_only_review_green = false;
    recomputeReconciliationKey(changed);
    expect(reconciliation(changed).idempotency_key).not.toBe(originalKey);
    expectValidatorFails(changed, 'closures-carried-oracle-115-123-127-131-134-137');
  });

  test('validator rejects registry, source, prior, stale readiness, source-ref, and closure drift', () => {
    const phaseCount = clone(build());
    reconciliation(phaseCount).phase_registry.phase_inventory_count = 35;
    recomputeReconciliationKey(phaseCount);
    expectValidatorFails(phaseCount, 'phase-registry-count-36');

    const source = clone(build());
    reconciliation(source).source_recommendation.recommendation_id = 'phase37-runtime-operator-ui-surface-validator';
    recomputeReconciliationKey(source);
    expectValidatorFails(source, 'source-recommendation-tier1-selected');

    const satisfied = clone(build());
    reconciliation(satisfied).satisfied_prior_recommendations[0].status = 'open';
    recomputeReconciliationKey(satisfied);
    expectValidatorFails(satisfied, 'phase36-tier0-satisfied-not-open');

    const prior = clone(build());
    reconciliation(prior).phase34_prior_recommendations.phase35_runtime_status_milestone_refresh_validator.status = 'open';
    recomputeReconciliationKey(prior);
    expectValidatorFails(prior, 'phase34-prior-recommendations-satisfied');

    const stale35 = clone(build());
    reconciliation(stale35).stale_readiness.phase35_runtime_next_action_current = false;
    recomputeReconciliationKey(stale35);
    expectValidatorFails(stale35, 'phase35-current-preserved');

    const missingRef = clone(build());
    reconciliation(missingRef).source_refs = reconciliation(missingRef).source_refs
      .filter((ref) => ref.artifact_id !== 'phase29-runtime-dry-run-implementation');
    recomputeReconciliationKey(missingRef);
    expectValidatorFails(missingRef, 'source-refs-phase29-30-32-33-34-35-36');

    const closure = clone(build());
    reconciliation(closure).closure_summary.phase36_oracle_137_read_only_review_green = false;
    recomputeReconciliationKey(closure);
    expectValidatorFails(closure, 'closures-carried-oracle-115-123-127-131-134-137');
  });

  test('validator rejects enabled controls, implemented gates, runner/runtime execution, and queue/lease/store/output claims', () => {
    const enabled = clone(build());
    reconciliation(enabled).control_state.disabled_by_default = false;
    recomputeReconciliationKey(enabled);
    expectValidatorFails(enabled, 'control-state-disabled-reference-only');

    const authorized = clone(build());
    reconciliation(authorized).control_state.control_execution_authorized = true;
    recomputeReconciliationKey(authorized);
    expectValidatorFails(authorized, 'control-state-disabled-and-non-authorizing');

    const killSwitch = clone(build());
    reconciliation(killSwitch).gates.kill_switch.implemented = true;
    recomputeReconciliationKey(killSwitch);
    expectValidatorFails(killSwitch, 'gates-reference-only-not-implemented');
    expectValidatorFails(killSwitch, 'kill-switch-reference-only');

    const reporting = clone(build());
    reconciliation(reporting).gates.reporting.implemented = true;
    recomputeReconciliationKey(reporting);
    expectValidatorFails(reporting, 'reporting-reference-only');

    const runner = clone(build());
    reconciliation(runner).dry_run_status.runner_executed = true;
    recomputeReconciliationKey(runner);
    expectValidatorFails(runner, 'dry-run-status-contract-only');
    expectValidatorFails(runner, 'runner-executed-false');

    const runtime = clone(build());
    reconciliation(runtime).dry_run_status.runtime_started = true;
    reconciliation(runtime).capability_matrix.runtimeStarted = true;
    reconciliation(runtime).boundary_truth.runtimeStarted = true;
    recomputeReconciliationKey(runtime);
    expectValidatorFails(runtime, 'capability-truth-false');
    expectValidatorFails(runtime, 'runtime-started-false');

    const outputFile = clone(build());
    reconciliation(outputFile).dry_run_status.output_file_written = true;
    reconciliation(outputFile).side_effect_result.no_output_file_written = false;
    reconciliation(outputFile).side_effect_result.outputFilesWritten = 1;
    recomputeReconciliationKey(outputFile);
    expectValidatorFails(outputFile, 'side-effect-truth-all-blocked');
    expectValidatorFails(outputFile, 'no-queue-lease-store-output-execution');
  });

  test('validator rejects reporting/proof/capability/redaction overclaims', () => {
    const reportingUi = clone(build());
    reconciliation(reportingUi).operator_reporting_summary.ui_rendering_authorized = true;
    recomputeReconciliationKey(reportingUi);
    expectValidatorFails(reportingUi, 'operator-reporting-summary-display-only');

    const proof = clone(build());
    reconciliation(proof).boundary_truth.controlReportIsRuntimeProof = true;
    recomputeReconciliationKey(proof);
    expectValidatorFails(proof, 'proof-boundaries-false');

    const modelProof = clone(build());
    reconciliation(modelProof).capability_matrix.serverCanProveModelProcessing = true;
    recomputeReconciliationKey(modelProof);
    expectValidatorFails(modelProof, 'capability-truth-false');

    const directTarget = clone(build());
    reconciliation(directTarget).capability_matrix.directBuilderOracleServerTargetsAllowed = true;
    reconciliation(directTarget).boundary_truth.builderOracleDirectServerTargetsAllowed = true;
    recomputeReconciliationKey(directTarget);
    expectValidatorFails(directTarget, 'builder-oracle-direct-targets-blocked');

    const redaction = clone(build());
    reconciliation(redaction).redaction_summary.secret_material_included = true;
    recomputeReconciliationKey(redaction);
    expectValidatorFails(redaction, 'redaction-summary-safe');
  });

  test('validator rejects unsafe action drift, Tier2+ recommendations, and forbidden output strings', () => {
    const liveRuntime = clone(build());
    reconciliation(liveRuntime).next_phase_recommendations[0].action = 'start live runtime';
    recomputeReconciliationKey(liveRuntime);
    expectValidatorFails(liveRuntime, 'unsafe-action-drift-blocked');
    expectValidatorFails(liveRuntime, 'unsafe-action-drift-rejected');

    const browserCapture = clone(build());
    reconciliation(browserCapture).next_phase_recommendations[0].why_safe = 'open browser window and capture screen';
    recomputeReconciliationKey(browserCapture);
    expectValidatorFails(browserCapture, 'unsafe-action-drift-rejected');

    const customerSend = clone(build());
    reconciliation(customerSend).operator_reporting_summary.status_lines[0] = 'send email to customer';
    recomputeReconciliationKey(customerSend);
    expectValidatorFails(customerSend, 'unsafe-action-drift-blocked');

    const tier = clone(build());
    reconciliation(tier).next_phase_recommendations[0].tier = 'tier2';
    recomputeReconciliationKey(tier);
    expectValidatorFails(tier, 'next-recommendations-tier0-tier1-only');

    const forbidden = clone(build());
    reconciliation(forbidden).operator_reporting_summary.status_lines[0] = 'bearer token leaked';
    recomputeReconciliationKey(forbidden);
    expectValidatorFails(forbidden, 'redaction-summary-safe');
    expectValidatorFails(forbidden, 'forbidden-output-strings-absent');
  });

  test('validator rejects validation report ok lies, missing tamper coverage, and required literal result lies', () => {
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
    reconciliation(literalLie).baseline_commit = '801a92a';
    recomputeReconciliationKey(literalLie);
    const literal = validationReport(literalLie).required_literal_results.find((entry) => entry.path === 'baseline_commit');
    literal.actual = '6f08b05';
    literal.ok = true;
    expectValidatorFails(literalLie, 'required-literal-checks-bound');
    expectValidatorFails(literalLie, 'validation-report-matches-contract');
  });

  test('CLI is stdout-only, consumes the Oracle fixture, and ignores output-file flags', () => {
    const parsed = parseArgs(['--pretty', '--out', 'ignored.json']);
    expect(parsed.pretty).toBe(true);
    expect(parsed.fixturePath).toContain('mira-core-runtime-control-reporting-reconciliation-contract.json');

    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const output = main(['--out=ignored.json'], JSON.stringify({
      profile: { name: 'main' },
      sessionId: 'session-cli',
      deviceId: 'VIGIL',
    }));

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(reconciliation(output).schema).toBe(RUNTIME_CONTROL_REPORTING_RECONCILIATION_SCHEMA_VERSION);
    expect(reconciliation(output).sessionId).toBe('session-cli');
    expect(reconciliation(output).baseline_commit).toBe(BASELINE_COMMIT);
    expect(reconciliation(output).phase_registry.current_through_phase).toBe(36);
    expect(reconciliation(output).phase_registry.phase_inventory_count).toBe(36);
    expect(reconciliation(output).phase_registry.schema_registry_count).toBe(36);
    expect(reconciliation(output).phase_registry.cli_registry_count).toBe(36);
    expect(reconciliation(output).commit_chain).toHaveLength(24);
    expect(reconciliation(output).source_refs).toHaveLength(7);
    expect(Object.values(reconciliation(output).gates)).toHaveLength(4);
    expect(reconciliation(output).operator_reporting_summary.report_cards).toHaveLength(6);
    expect(reconciliation(output).operator_reporting_summary.status_lines).toHaveLength(6);
    expect(reconciliation(output).capability_matrix.runtimeStarted).toBe(false);
    expect(reconciliation(output).capability_matrix.runnerExecuted).toBe(false);
    expect(reconciliation(output).capability_matrix.serverCanExecuteLocal).toBe(false);
    expect(reconciliation(output).dry_run_status.queue_created).toBe(false);
    expect(reconciliation(output).side_effect_result.no_output_file_written).toBe(true);
    expect(validationReport(output).decision).toBe('accepted_validation_only');
    expect(validateMiraCoreRuntimeControlReportingReconciliationOutput(output, runtimeControlReportingContract))
      .toEqual(expect.objectContaining({ ok: true }));
  });
});
