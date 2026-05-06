const runtimeNextActionContract = require('./fixtures/mira-core-runtime-next-action-contract.json');
const {
  BASELINE_COMMIT,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_RECONCILIATION_FIELDS,
  REQUIRED_SIDE_EFFECT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  RUNTIME_NEXT_ACTION_RECONCILIATION_SCHEMA_VERSION,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreRuntimeNextAction,
  runtimeNextActionIdempotencyKey,
  validateMiraCoreRuntimeNextActionOutput,
} = require('../modules/mira-core/runtime-next-action');
const {
  main,
  parseArgs,
} = require('../scripts/hm-mira-core-runtime-next-action');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function build(inputSignals = {}) {
  return buildMiraCoreRuntimeNextAction({
    contract: runtimeNextActionContract,
    inputSignals,
    nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
  });
}

function reconciliation(output) {
  return output.runtime_next_action_reconciliation;
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
  expect(() => assertNoForbiddenOutput(output, runtimeNextActionContract.forbiddenOutputSubstrings)).not.toThrow();
}

function expectValidatorFails(output, checkId) {
  const validation = validateMiraCoreRuntimeNextActionOutput(output, runtimeNextActionContract);
  expect(validation.ok).toBe(false);
  expect(validation.checks.find((entry) => entry.id === checkId)).toEqual(expect.objectContaining({ ok: false }));
}

function recomputeReconciliationKey(output) {
  output.runtime_next_action_reconciliation.idempotency_key =
    runtimeNextActionIdempotencyKey(output.runtime_next_action_reconciliation);
}

describe('mira core runtime next action reconciliation v0', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('satisfies Oracle top-level, reconciliation, and validation report shapes', () => {
    const output = build();
    const current = reconciliation(output);
    const report = validationReport(output);

    expectRequiredFields(output, runtimeNextActionContract.expectedOutputShape.requiredTopLevelFields);
    expect(runtimeNextActionContract.expectedOutputShape.requiredTopLevelFields).toEqual(REQUIRED_OUTPUT_FIELDS);
    expect(current.schema).toBe(RUNTIME_NEXT_ACTION_RECONCILIATION_SCHEMA_VERSION);
    expect(report.schema).toBe(VALIDATION_REPORT_SCHEMA_VERSION);
    expectRequiredFields(current, runtimeNextActionContract.expectedManifestShape.requiredFields);
    expect(runtimeNextActionContract.expectedManifestShape.requiredFields).toEqual(REQUIRED_RECONCILIATION_FIELDS);
    expectRequiredFields(report, runtimeNextActionContract.expectedValidationReportShape.requiredFields);
    expect(runtimeNextActionContract.expectedValidationReportShape.requiredFields).toEqual(REQUIRED_VALIDATION_REPORT_FIELDS);
    expect(report.accepted).toBe(true);
    expect(report.blocked).toBe(false);
    expect(report.decision).toBe('accepted_validation_only');
    expect(validateMiraCoreRuntimeNextActionOutput(output, runtimeNextActionContract)).toEqual(expect.objectContaining({ ok: true }));
    expectNoForbiddenOutput(output);
  });

  test('pins baseline c04155d and phase registry through Phase 34', () => {
    const current = reconciliation(build());
    const expected = runtimeNextActionContract.phaseRegistryExpected;

    expect(current.baseline_commit).toBe(BASELINE_COMMIT);
    expect(BASELINE_COMMIT).toBe(runtimeNextActionContract.baseline.commit);
    expect(current.phase_registry).toEqual(expect.objectContaining({
      source_ref: expected.source_ref,
      current_through_phase: 34,
      expected_phases: '1-34',
      phase_inventory_count: 34,
      schema_registry_count: 34,
      cli_registry_count: 34,
      phase34_current: true,
      phase34_commit: BASELINE_COMMIT,
    }));
    expect(current.phase_registry.phase34_delta).toEqual(expect.objectContaining(expected.phase34_delta));
    expect(current.phase_registry.phase34_delta.capability_truth).toEqual(expect.objectContaining({
      runtimeStarted: false,
      runnerExecuted: false,
      runtimeAvailable: false,
      serverCanExecuteLocal: false,
      serverCanProveModelProcessing: false,
      directBuilderOracleServerTargetsAllowed: false,
    }));
  });

  test('commit chain and stale readiness preserve Phase 13/23/31 truth while Phase 34 is current', () => {
    const current = reconciliation(build());

    expect(current.commit_chain).toEqual(runtimeNextActionContract.commitChainExpected);
    expect(current.commit_chain).toHaveLength(runtimeNextActionContract.expectedManifestShape.expectedCounts.commit_chain);
    expect(current.commit_chain[current.commit_chain.length - 1]).toBe(BASELINE_COMMIT);
    expect(current.stale_readiness).toEqual(expect.objectContaining(runtimeNextActionContract.staleReadinessExpected));
    expect(current.stale_readiness.phase13_readiness_current).toBe(false);
    expect(current.stale_readiness.phase23_milestone_readiness_current).toBe(false);
    expect(current.stale_readiness.phase31_runtime_milestone_refresh_current).toBe(false);
    expect(current.stale_readiness.phase34_runtime_status_milestone_refresh_current).toBe(true);
  });

  test('marks Phase 34 prior Phase35 recommendations satisfied and not repeated as open work', () => {
    const current = reconciliation(build());
    const satisfied = current.satisfied_prior_recommendations;
    const priorIds = runtimeNextActionContract.satisfiedPriorRecommendationsExpected.map((item) => item.recommendation_id);

    expect(Object.keys(satisfied)).toHaveLength(2);
    for (const expected of runtimeNextActionContract.satisfiedPriorRecommendationsExpected) {
      const item = Object.values(satisfied).find((entry) => entry.recommendation_id === expected.recommendation_id);
      expect(item).toEqual(expect.objectContaining(expected));
      expect(item.status).toBe('satisfied_by_c04155d_do_not_repeat_as_open_work');
    }
    expect(current.next_phase_recommendations.map((item) => item.recommendation_id)).not.toEqual(expect.arrayContaining(priorIds));

    const reopened = clone(build());
    reconciliation(reopened).satisfied_prior_recommendations
      .phase34_phase35_runtime_status_milestone_refresh_validator.status = 'open';
    recomputeReconciliationKey(reopened);
    expectValidatorFails(reopened, 'phase34-prior-recommendations-satisfied');

    const repeated = clone(build());
    reconciliation(repeated).next_phase_recommendations[0].recommendation_id = priorIds[0];
    recomputeReconciliationKey(repeated);
    expectValidatorFails(repeated, 'phase34-prior-recommendations-not-open');
  });

  test('carries Oracle closures and preserves capability, proof, and side-effect boundaries', () => {
    const output = build();
    const current = reconciliation(output);

    expect(current.closure_summary).toEqual(expect.objectContaining({
      phase30_oracle_115_prerequisite_mapping_closure: true,
      phase32_oracle_123_expires_at_closure: true,
      phase33_oracle_127_validation_report_tamper_coverage_closure: true,
      phase34_oracle_131_read_only_review_green: true,
    }));
    expect(current.closure_summary.closed_review_refs).toEqual(['ORACLE #115', 'ORACLE #123', 'ORACLE #127', 'ORACLE #131']);
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
      phase34CommitIsRuntimeProof: false,
      reconciliationIsUiProof: false,
      reconciliationIsRuntimeAuthorization: false,
    }));
    for (const field of REQUIRED_SIDE_EFFECT_FIELDS) {
      expect(current.side_effect_result[field]).toBe(true);
      expect(validationReport(output).side_effect_truth[field]).toBe(true);
    }
    expect(current.side_effect_result.outputFileWritten).toBe(false);
  });

  test('next recommendations are new, Tier0/Tier1, non-authorizing, and match fixture candidates', () => {
    const current = reconciliation(build());

    expect(current.next_phase_recommendations).toHaveLength(runtimeNextActionContract.nextRecommendationExpectedCandidates.length);
    expect(current.next_phase_recommendations).toEqual(expect.arrayContaining(
      runtimeNextActionContract.nextRecommendationExpectedCandidates.map((candidate) => expect.objectContaining(candidate)),
    ));
    for (const recommendation of current.next_phase_recommendations) {
      expect(['tier0', 'tier1']).toContain(recommendation.tier);
      expect(recommendation.does_not_authorize_ui).toBe(true);
      expect(recommendation.does_not_authorize_runtime).toBe(true);
      expect(recommendation.blocked_side_effects.length).toBeGreaterThan(0);
    }
  });

  test('static rules, acceptance checks, tamper coverage, and required literal results are represented', () => {
    const output = build();
    const validation = validateMiraCoreRuntimeNextActionOutput(output, runtimeNextActionContract);
    const checkIds = validation.checks.map((entry) => entry.id);
    const staticIds = validationReport(output).static_rule_results.map((entry) => entry.id);
    const acceptanceIds = validationReport(output).acceptance_check_results.map((entry) => entry.id);

    expect(validation.ok).toBe(true);
    for (const rule of runtimeNextActionContract.staticValidationRules) {
      expect(checkIds).toContain(rule.id);
      expect(staticIds).toContain(rule.id);
    }
    for (const check of runtimeNextActionContract.acceptanceChecks) {
      expect(checkIds).toContain(check.id);
      expect(acceptanceIds).toContain(check.id);
    }
    expect(validationReport(output).tamper_case_results).toHaveLength(runtimeNextActionContract.tamperCases.length);
    expect(validationReport(output).tamper_case_results.length)
      .toBeGreaterThanOrEqual(runtimeNextActionContract.expectedManifestShape.expectedCounts.tamper_case_results_min);
    expect(validationReport(output).required_literal_results).toHaveLength(
      Object.keys(runtimeNextActionContract.expectedManifestShape.requiredLiteralValues).length,
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
    reconciliation(changed).closure_summary.phase34_oracle_131_read_only_review_green = false;
    recomputeReconciliationKey(changed);
    expect(reconciliation(changed).idempotency_key).not.toBe(originalKey);
    expectValidatorFails(changed, 'phase34-oracle131-closure-carried');
  });

  test('validator rejects registry, commit, stale readiness, and closure drift', () => {
    const phaseCount = clone(build());
    reconciliation(phaseCount).phase_registry.phase_inventory_count = 33;
    recomputeReconciliationKey(phaseCount);
    expectValidatorFails(phaseCount, 'phase-inventory-count-34');

    const schemaCount = clone(build());
    reconciliation(schemaCount).phase_registry.schema_registry_count = 33;
    recomputeReconciliationKey(schemaCount);
    expectValidatorFails(schemaCount, 'schema-registry-count-34');

    const cliCount = clone(build());
    reconciliation(cliCount).phase_registry.cli_registry_count = 33;
    recomputeReconciliationKey(cliCount);
    expectValidatorFails(cliCount, 'cli-registry-count-34');

    const missingCommit = clone(build());
    reconciliation(missingCommit).commit_chain.pop();
    recomputeReconciliationKey(missingCommit);
    expectValidatorFails(missingCommit, 'commit-chain-exact-22');

    const stale31 = clone(build());
    reconciliation(stale31).stale_readiness.phase31_runtime_milestone_refresh_current = true;
    recomputeReconciliationKey(stale31);
    expectValidatorFails(stale31, 'phase31-stale-preserved');

    const closure = clone(build());
    reconciliation(closure).closure_summary.phase32_oracle_123_expires_at_closure = false;
    recomputeReconciliationKey(closure);
    expectValidatorFails(closure, 'phase32-oracle123-closure-carried');
  });

  test('validator rejects capability/proof overclaims and side-effect lies', () => {
    const runtime = clone(build());
    reconciliation(runtime).capability_matrix.runtimeStarted = true;
    reconciliation(runtime).boundary_truth.runtimeStarted = true;
    recomputeReconciliationKey(runtime);
    expectValidatorFails(runtime, 'capability-truth-false');
    expectValidatorFails(runtime, 'runtime-started-false');

    const modelProof = clone(build());
    reconciliation(modelProof).capability_matrix.serverCanProveModelProcessing = true;
    recomputeReconciliationKey(modelProof);
    expectValidatorFails(modelProof, 'capability-truth-false');

    const proof = clone(build());
    reconciliation(proof).boundary_truth.phase34CommitIsRuntimeProof = true;
    recomputeReconciliationKey(proof);
    expectValidatorFails(proof, 'proof-boundaries-false');

    const sideEffect = clone(build());
    reconciliation(sideEffect).side_effect_result.no_output_file_written = false;
    reconciliation(sideEffect).side_effect_result.outputFilesWritten = 1;
    reconciliation(sideEffect).side_effect_result.outputFileWritten = true;
    recomputeReconciliationKey(sideEffect);
    expectValidatorFails(sideEffect, 'side-effect-truth-all-blocked');
  });

  test('validator rejects live runtime/UI recommendations, Tier2+, customer-send drift, and forbidden content', () => {
    const liveRuntime = clone(build());
    reconciliation(liveRuntime).next_phase_recommendations[0].action = 'implement live runtime';
    recomputeReconciliationKey(liveRuntime);
    expectValidatorFails(liveRuntime, 'next-recommendations-no-live-runtime-or-ui');
    expectValidatorFails(liveRuntime, 'unsafe-action-drift-blocked');

    const liveUi = clone(build());
    reconciliation(liveUi).next_phase_recommendations[0].action = 'build live UI dashboard';
    recomputeReconciliationKey(liveUi);
    expectValidatorFails(liveUi, 'next-recommendations-no-live-runtime-or-ui');

    const tier = clone(build());
    reconciliation(tier).next_phase_recommendations[0].tier = 'tier2';
    recomputeReconciliationKey(tier);
    expectValidatorFails(tier, 'next-recommendations-new-tier0-tier1-only');

    const customerSend = clone(build());
    reconciliation(customerSend).next_phase_recommendations[0].why_safe = 'safe to send customer message';
    recomputeReconciliationKey(customerSend);
    expectValidatorFails(customerSend, 'unsafe-action-drift-blocked');

    const forbidden = clone(build());
    reconciliation(forbidden).verification_summary.note = 'raw bearer token';
    recomputeReconciliationKey(forbidden);
    expectValidatorFails(forbidden, 'no-raw-private-secret-output');
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
    reconciliation(literalLie).baseline_commit = '0e82768';
    recomputeReconciliationKey(literalLie);
    validationReport(literalLie).required_literal_results.find((entry) => entry.path === 'baseline_commit').actual = 'c04155d';
    validationReport(literalLie).required_literal_results.find((entry) => entry.path === 'baseline_commit').ok = true;
    expectValidatorFails(literalLie, 'required-literal-checks-bound');
    expectValidatorFails(literalLie, 'validation-report-matches-contract');
  });

  test('CLI is stdout-only, consumes the Oracle fixture, and ignores output-file flags', () => {
    const parsed = parseArgs(['--pretty', '--out', 'ignored.json']);
    expect(parsed.pretty).toBe(true);
    expect(parsed.fixturePath).toContain('mira-core-runtime-next-action-contract.json');

    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const output = main(['--out=ignored.json'], JSON.stringify({
      profile: { name: 'main' },
      sessionId: 'session-cli',
      deviceId: 'VIGIL',
    }));

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(reconciliation(output).schema).toBe(RUNTIME_NEXT_ACTION_RECONCILIATION_SCHEMA_VERSION);
    expect(reconciliation(output).sessionId).toBe('session-cli');
    expect(reconciliation(output).baseline_commit).toBe(BASELINE_COMMIT);
    expect(reconciliation(output).phase_registry.current_through_phase).toBe(34);
    expect(reconciliation(output).phase_registry.phase_inventory_count).toBe(34);
    expect(reconciliation(output).phase_registry.schema_registry_count).toBe(34);
    expect(reconciliation(output).phase_registry.cli_registry_count).toBe(34);
    expect(reconciliation(output).commit_chain).toHaveLength(22);
    expect(reconciliation(output).satisfied_prior_recommendations.phase34_phase35_runtime_status_milestone_refresh_validator.status)
      .toBe('satisfied_by_c04155d_do_not_repeat_as_open_work');
    expect(reconciliation(output).capability_matrix.runtimeStarted).toBe(false);
    expect(reconciliation(output).capability_matrix.runnerExecuted).toBe(false);
    expect(reconciliation(output).capability_matrix.serverCanExecuteLocal).toBe(false);
    expect(reconciliation(output).side_effect_result.no_output_file_written).toBe(true);
    expect(validationReport(output).decision).toBe('accepted_validation_only');
    expect(validateMiraCoreRuntimeNextActionOutput(output, runtimeNextActionContract)).toEqual(expect.objectContaining({ ok: true }));
  });
});
