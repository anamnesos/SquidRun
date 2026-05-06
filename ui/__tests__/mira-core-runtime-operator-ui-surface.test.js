const runtimeOperatorUiSurfaceContract = require('./fixtures/mira-core-runtime-operator-ui-surface-contract.json');
const {
  BASELINE_COMMIT,
  REQUIRED_MANIFEST_FIELDS,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_SIDE_EFFECT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  RUNTIME_OPERATOR_UI_SURFACE_MANIFEST_SCHEMA_VERSION,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreRuntimeOperatorUiSurface,
  runtimeOperatorUiSurfaceIdempotencyKey,
  validateMiraCoreRuntimeOperatorUiSurfaceOutput,
} = require('../modules/mira-core/runtime-operator-ui-surface');
const {
  main,
  parseArgs,
} = require('../scripts/hm-mira-core-runtime-operator-ui-surface');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function build(inputSignals = {}) {
  return buildMiraCoreRuntimeOperatorUiSurface({
    contract: runtimeOperatorUiSurfaceContract,
    inputSignals,
    nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
  });
}

function manifest(output) {
  return output.runtime_operator_ui_surface_manifest;
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
  expect(() => assertNoForbiddenOutput(output, runtimeOperatorUiSurfaceContract.forbiddenOutputSubstrings)).not.toThrow();
}

function expectValidatorFails(output, checkId) {
  const validation = validateMiraCoreRuntimeOperatorUiSurfaceOutput(output, runtimeOperatorUiSurfaceContract);
  expect(validation.ok).toBe(false);
  expect(validation.checks.find((entry) => entry.id === checkId)).toEqual(expect.objectContaining({ ok: false }));
}

function recomputeManifestKey(output) {
  manifest(output).idempotency_key = runtimeOperatorUiSurfaceIdempotencyKey(manifest(output));
}

describe('mira core runtime operator UI surface v0', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('satisfies Oracle top-level, manifest, and validation report shapes', () => {
    const output = build();
    const current = manifest(output);
    const report = validationReport(output);

    expectRequiredFields(output, runtimeOperatorUiSurfaceContract.expectedOutputShape.requiredTopLevelFields);
    expect(runtimeOperatorUiSurfaceContract.expectedOutputShape.requiredTopLevelFields).toEqual(REQUIRED_OUTPUT_FIELDS);
    expect(current.schema).toBe(RUNTIME_OPERATOR_UI_SURFACE_MANIFEST_SCHEMA_VERSION);
    expect(report.schema).toBe(VALIDATION_REPORT_SCHEMA_VERSION);
    expectRequiredFields(current, runtimeOperatorUiSurfaceContract.expectedManifestShape.requiredFields);
    expect(runtimeOperatorUiSurfaceContract.expectedManifestShape.requiredFields).toEqual(REQUIRED_MANIFEST_FIELDS);
    expectRequiredFields(report, runtimeOperatorUiSurfaceContract.expectedValidationReportShape.requiredFields);
    expect(runtimeOperatorUiSurfaceContract.expectedValidationReportShape.requiredFields).toEqual(REQUIRED_VALIDATION_REPORT_FIELDS);
    expect(report.accepted).toBe(true);
    expect(report.blocked).toBe(false);
    expect(report.decision).toBe('accepted_validation_only');
    expect(validateMiraCoreRuntimeOperatorUiSurfaceOutput(output, runtimeOperatorUiSurfaceContract)).toEqual(expect.objectContaining({ ok: true }));
    expectNoForbiddenOutput(output);
  });

  test('pins baseline 801a92a and phase registry through Phase 35', () => {
    const current = manifest(build());
    const expected = runtimeOperatorUiSurfaceContract.phaseRegistryExpected;

    expect(current.baseline_commit).toBe(BASELINE_COMMIT);
    expect(BASELINE_COMMIT).toBe(runtimeOperatorUiSurfaceContract.baseline.commit);
    expect(current.phase_registry).toEqual(expect.objectContaining({
      source_ref: expected.source_ref,
      current_through_phase: 35,
      expected_phases: '1-35',
      phase_inventory_count: 35,
      schema_registry_count: 35,
      cli_registry_count: 35,
      phase35_current: true,
      phase35_commit: BASELINE_COMMIT,
    }));
    expect(current.phase_registry.phase35_delta).toEqual(expect.objectContaining(expected.phase35_delta));
    expect(current.phase_registry.phase35_delta.capability_truth).toEqual(expect.objectContaining({
      runtimeStarted: false,
      runnerExecuted: false,
      runtimeAvailable: false,
      serverCanExecuteLocal: false,
      serverCanProveModelProcessing: false,
      directBuilderOracleServerTargetsAllowed: false,
    }));
  });

  test('preserves commit chain, source recommendation, carried-forward work, and stale readiness truth', () => {
    const current = manifest(build());

    expect(current.commit_chain).toEqual(runtimeOperatorUiSurfaceContract.commitChainExpected);
    expect(current.commit_chain).toHaveLength(runtimeOperatorUiSurfaceContract.expectedManifestShape.expectedCounts.commit_chain);
    expect(current.commit_chain[current.commit_chain.length - 1]).toBe(BASELINE_COMMIT);
    expect(current.source_recommendation).toEqual(expect.objectContaining({
      recommendation_id: runtimeOperatorUiSurfaceContract.sourceRecommendation.recommendation_id,
      tier: 'tier0',
      status: 'selected_for_phase36_fixture_only_contract',
      contract_only_now: true,
      implemented_now: false,
      does_not_authorize_ui: true,
      does_not_authorize_runtime: true,
    }));
    expect(current.carried_forward_recommendations).toHaveLength(1);
    expect(current.carried_forward_recommendations[0]).toEqual(expect.objectContaining({
      recommendation_id: runtimeOperatorUiSurfaceContract.carriedForwardRecommendations[0].recommendation_id,
      status: 'carried_forward_not_implemented_in_phase36',
      does_not_authorize_ui: true,
      does_not_authorize_runtime: true,
    }));
    expect(current.stale_readiness).toEqual(expect.objectContaining(runtimeOperatorUiSurfaceContract.staleReadinessExpected));
    expect(current.stale_readiness.phase13_readiness_current).toBe(false);
    expect(current.stale_readiness.phase23_milestone_readiness_current).toBe(false);
    expect(current.stale_readiness.phase31_runtime_milestone_refresh_current).toBe(false);
    expect(current.stale_readiness.phase35_runtime_next_action_current).toBe(true);
  });

  test('keeps Phase34 prior recommendations satisfied and carries Oracle closures/source refs', () => {
    const current = manifest(build());

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
    }));
    expect(current.closure_summary.closed_review_refs)
      .toEqual(['ORACLE #115', 'ORACLE #123', 'ORACLE #127', 'ORACLE #131', 'ORACLE #134']);
    expect(current.source_artifact_refs).toEqual(runtimeOperatorUiSurfaceContract.sourceArtifactRefsExpected);
  });

  test('defines display-only sections, cards, warnings, and disabled non-authorizing actions', () => {
    const current = manifest(build());
    const shape = runtimeOperatorUiSurfaceContract.surfaceShapeExpected;

    expect(current.sections).toHaveLength(shape.requiredSections.length);
    expect(current.cards).toHaveLength(shape.requiredCards.length);
    expect(current.warnings).toHaveLength(shape.requiredWarnings.length);
    expect(current.actions).toHaveLength(shape.requiredActions.length);
    expect(current.sections.map((item) => item.section_id)).toEqual(expect.arrayContaining(shape.requiredSections));
    expect(current.cards.map((item) => item.card_id)).toEqual(expect.arrayContaining(shape.requiredCards));
    expect(current.warnings.map((item) => item.warning_id)).toEqual(expect.arrayContaining(shape.requiredWarnings));
    expect(current.actions.map((item) => item.action_id)).toEqual(expect.arrayContaining(shape.requiredActions));
    for (const section of current.sections) {
      expectRequiredFields(section, shape.sectionRequiredFields);
      expect(section.display_only).toBe(true);
      expect(section.operator_visible).toBe(true);
      expect(section.redaction_status).toBe('redacted_metadata_only');
    }
    for (const card of current.cards) {
      expectRequiredFields(card, shape.cardRequiredFields);
      expect(card.display_only).toBe(true);
      expect(card.disabled_by_default).toBe(true);
      expect(card.non_authorizing).toBe(true);
      expect(card.proof_boundary).toEqual(expect.objectContaining({
        statusCardIsUiProof: false,
        operatorSurfaceIsRuntimeProof: false,
        operatorSurfaceIsModelProcessingProof: false,
      }));
    }
    for (const warning of current.warnings) {
      expectRequiredFields(warning, shape.warningRequiredFields);
      expect(warning.does_not_prove.length).toBeGreaterThan(0);
      expect(warning.blocked_actions.length).toBeGreaterThan(0);
    }
    for (const action of current.actions) {
      expectRequiredFields(action, shape.actionRequiredFields);
      expect(action.enabled).toBe(false);
      expect(action.non_authorizing).toBe(true);
      expect(action.does_not_authorize_ui).toBe(true);
      expect(action.does_not_authorize_runtime).toBe(true);
      expect(action.does_not_authorize_execution).toBe(true);
    }
  });

  test('preserves surface, capability, proof, redaction, and side-effect boundaries', () => {
    const output = build();
    const current = manifest(output);

    expect(current.surface_contract).toEqual(expect.objectContaining({
      display_only: true,
      operator_visible: true,
      disabled_by_default: true,
      non_authorizing: true,
      ui_rendering_authorized: false,
      browser_window_capture_authorized: false,
      runtime_start_authorized: false,
      runner_execution_authorized: false,
      output_file_authorized: false,
      store_write_authorized: false,
      queue_lease_authorized: false,
      local_execution_authorized: false,
      send_deploy_trade_authorized: false,
    }));
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
      statusCardIsUiProof: false,
      operatorSurfaceIsRuntimeProof: false,
      operatorSurfaceIsRuntimeAuthorization: false,
      operatorSurfaceIsModelProcessingProof: false,
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
  });

  test('next recommendations are new Tier0/Tier1, non-authorizing, and match fixture candidates', () => {
    const current = manifest(build());

    expect(current.next_phase_recommendations).toHaveLength(
      runtimeOperatorUiSurfaceContract.nextRecommendationExpectedCandidates.length,
    );
    expect(current.next_phase_recommendations).toEqual(expect.arrayContaining(
      runtimeOperatorUiSurfaceContract.nextRecommendationExpectedCandidates.map((candidate) => expect.objectContaining(candidate)),
    ));
    for (const recommendation of current.next_phase_recommendations) {
      expect(['tier0', 'tier1']).toContain(recommendation.tier);
      expect(recommendation.does_not_authorize_ui).toBe(true);
      expect(recommendation.does_not_authorize_runtime).toBe(true);
      expect(recommendation.blocked_side_effects.length).toBeGreaterThan(0);
    }
  });

  test('static rules, acceptance checks, tamper cases, and required literal results are represented', () => {
    const output = build();
    const validation = validateMiraCoreRuntimeOperatorUiSurfaceOutput(output, runtimeOperatorUiSurfaceContract);
    const checkIds = validation.checks.map((entry) => entry.id);
    const staticIds = validationReport(output).static_rule_results.map((entry) => entry.id);
    const acceptanceIds = validationReport(output).acceptance_check_results.map((entry) => entry.id);

    expect(validation.ok).toBe(true);
    for (const rule of runtimeOperatorUiSurfaceContract.staticValidationRules) {
      expect(checkIds).toContain(rule.id);
      expect(staticIds).toContain(rule.id);
    }
    for (const check of runtimeOperatorUiSurfaceContract.acceptanceChecks) {
      expect(checkIds).toContain(check.id);
      expect(acceptanceIds).toContain(check.id);
    }
    expect(validationReport(output).tamper_case_results).toHaveLength(runtimeOperatorUiSurfaceContract.tamperCases.length);
    expect(validationReport(output).tamper_case_results.length)
      .toBeGreaterThanOrEqual(runtimeOperatorUiSurfaceContract.expectedManifestShape.expectedCounts.tamper_case_results_min);
    expect(validationReport(output).tamper_case_results.every((entry) => entry.covered && entry.expectedFailure)).toBe(true);
    expect(validationReport(output).required_literal_results).toHaveLength(
      Object.keys(runtimeOperatorUiSurfaceContract.expectedManifestShape.requiredLiteralValues).length,
    );
    expect(validationReport(output).required_literal_results.every((entry) => entry.ok)).toBe(true);
  });

  test('idempotency is stable for equivalent inputs and sensitive to meaningful manifest changes', () => {
    const first = manifest(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'VIGIL' }));
    const second = manifest(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'VIGIL' }));
    const changedDevice = manifest(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'ALT' }));
    const changedProfile = manifest(build({ profile: { name: 'side' }, sessionId: 'session-a', deviceId: 'VIGIL' }));

    expect(first.idempotency_key).toBe(second.idempotency_key);
    expect(first.surface_id).toBe(second.surface_id);
    expect(first.idempotency_key).not.toBe(changedDevice.idempotency_key);
    expect(first.idempotency_key).not.toBe(changedProfile.idempotency_key);

    const changed = clone(build());
    const originalKey = manifest(changed).idempotency_key;
    manifest(changed).closure_summary.phase35_oracle_134_read_only_review_green = false;
    recomputeManifestKey(changed);
    expect(manifest(changed).idempotency_key).not.toBe(originalKey);
    expectValidatorFails(changed, 'closures-carried-oracle-115-123-127-131-134');
  });

  test('validator rejects registry, source, carried-forward, stale readiness, and closure drift', () => {
    const phaseCount = clone(build());
    manifest(phaseCount).phase_registry.phase_inventory_count = 34;
    recomputeManifestKey(phaseCount);
    expectValidatorFails(phaseCount, 'phase-registry-count-35');

    const source = clone(build());
    manifest(source).source_recommendation.recommendation_id = 'phase36-wrong-work';
    recomputeManifestKey(source);
    expectValidatorFails(source, 'source-recommendation-tier0-selected');

    const carried = clone(build());
    manifest(carried).carried_forward_recommendations[0].status = 'implemented_now';
    recomputeManifestKey(carried);
    expectValidatorFails(carried, 'tier1-recommendation-carried-forward');

    const prior = clone(build());
    manifest(prior).phase34_prior_recommendations.phase35_runtime_status_milestone_refresh_validator.status = 'open';
    recomputeManifestKey(prior);
    expectValidatorFails(prior, 'phase34-prior-recommendations-satisfied');

    const stale31 = clone(build());
    manifest(stale31).stale_readiness.phase31_runtime_milestone_refresh_current = true;
    recomputeManifestKey(stale31);
    expectValidatorFails(stale31, 'phase31-stale-preserved');

    const closure = clone(build());
    manifest(closure).closure_summary.phase35_oracle_134_read_only_review_green = false;
    recomputeManifestKey(closure);
    expectValidatorFails(closure, 'closures-carried-oracle-115-123-127-131-134');
  });

  test('validator rejects surface/card/action overclaims and missing UI surface elements', () => {
    const ui = clone(build());
    manifest(ui).surface_contract.ui_rendering_authorized = true;
    recomputeManifestKey(ui);
    expectValidatorFails(ui, 'surface-shape-data-only');

    const capture = clone(build());
    manifest(capture).surface_contract.browser_window_capture_authorized = true;
    recomputeManifestKey(capture);
    expectValidatorFails(capture, 'surface-contract-display-only');

    const runtime = clone(build());
    manifest(runtime).surface_contract.runtime_start_authorized = true;
    recomputeManifestKey(runtime);
    expectValidatorFails(runtime, 'surface-contract-display-only');

    const missingSection = clone(build());
    manifest(missingSection).sections = manifest(missingSection).sections.filter((section) => section.section_id !== 'warnings');
    recomputeManifestKey(missingSection);
    expectValidatorFails(missingSection, 'sections-complete');

    const missingCard = clone(build());
    manifest(missingCard).cards = manifest(missingCard).cards.filter((card) => card.card_id !== 'proof-boundary-card');
    recomputeManifestKey(missingCard);
    expectValidatorFails(missingCard, 'cards-complete');

    const actionEnabled = clone(build());
    manifest(actionEnabled).actions[0].enabled = true;
    recomputeManifestKey(actionEnabled);
    expectValidatorFails(actionEnabled, 'actions-disabled-non-authorizing');

    const actionAuthorizes = clone(build());
    manifest(actionAuthorizes).actions[0].does_not_authorize_runtime = false;
    recomputeManifestKey(actionAuthorizes);
    expectValidatorFails(actionAuthorizes, 'actions-disabled-and-non-authorizing');
  });

  test('validator rejects capability/proof overclaims, redaction leaks, and side-effect lies', () => {
    const runtime = clone(build());
    manifest(runtime).capability_matrix.runtimeStarted = true;
    manifest(runtime).boundary_truth.runtimeStarted = true;
    recomputeManifestKey(runtime);
    expectValidatorFails(runtime, 'capability-truth-false');
    expectValidatorFails(runtime, 'runtime-started-false');

    const modelProof = clone(build());
    manifest(modelProof).capability_matrix.serverCanProveModelProcessing = true;
    recomputeManifestKey(modelProof);
    expectValidatorFails(modelProof, 'capability-truth-false');

    const directTarget = clone(build());
    manifest(directTarget).capability_matrix.directBuilderOracleServerTargetsAllowed = true;
    manifest(directTarget).boundary_truth.builderOracleDirectServerTargetsAllowed = true;
    recomputeManifestKey(directTarget);
    expectValidatorFails(directTarget, 'builder-oracle-direct-targets-blocked');

    const statusProof = clone(build());
    manifest(statusProof).boundary_truth.statusCardIsUiProof = true;
    manifest(statusProof).cards[0].proof_boundary.statusCardIsUiProof = true;
    recomputeManifestKey(statusProof);
    expectValidatorFails(statusProof, 'proof-boundaries-false');

    const redaction = clone(build());
    manifest(redaction).redaction_summary.secret_material_included = true;
    recomputeManifestKey(redaction);
    expectValidatorFails(redaction, 'redaction-summary-safe');

    const sideEffect = clone(build());
    manifest(sideEffect).side_effect_result.no_output_file_written = false;
    manifest(sideEffect).side_effect_result.outputFilesWritten = 1;
    manifest(sideEffect).side_effect_result.outputFileWritten = true;
    recomputeManifestKey(sideEffect);
    expectValidatorFails(sideEffect, 'side-effect-truth-all-blocked');
  });

  test('validator rejects unsafe action drift, Tier2+ recommendations, and forbidden output strings', () => {
    const liveUi = clone(build());
    manifest(liveUi).next_phase_recommendations[0].action = 'render UI dashboard';
    recomputeManifestKey(liveUi);
    expectValidatorFails(liveUi, 'unsafe-action-drift-blocked');
    expectValidatorFails(liveUi, 'unsafe-action-drift-rejected');

    const browserWindow = clone(build());
    manifest(browserWindow).warnings[0].message = 'browser window capture is safe';
    recomputeManifestKey(browserWindow);
    expectValidatorFails(browserWindow, 'unsafe-action-drift-blocked');

    const customerSend = clone(build());
    manifest(customerSend).next_phase_recommendations[0].why_safe = 'safe to send customer message';
    recomputeManifestKey(customerSend);
    expectValidatorFails(customerSend, 'unsafe-action-drift-rejected');

    const tier = clone(build());
    manifest(tier).next_phase_recommendations[0].tier = 'tier2';
    recomputeManifestKey(tier);
    expectValidatorFails(tier, 'next-recommendations-tier0-tier1-only');

    const forbidden = clone(build());
    manifest(forbidden).cards[0].summary = 'bearer token leaked';
    recomputeManifestKey(forbidden);
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
    manifest(literalLie).baseline_commit = 'c04155d';
    recomputeManifestKey(literalLie);
    const literal = validationReport(literalLie).required_literal_results.find((entry) => entry.path === 'baseline_commit');
    literal.actual = '801a92a';
    literal.ok = true;
    expectValidatorFails(literalLie, 'required-literal-checks-bound');
    expectValidatorFails(literalLie, 'validation-report-matches-contract');
  });

  test('CLI is stdout-only, consumes the Oracle fixture, and ignores output-file flags', () => {
    const parsed = parseArgs(['--pretty', '--out', 'ignored.json']);
    expect(parsed.pretty).toBe(true);
    expect(parsed.fixturePath).toContain('mira-core-runtime-operator-ui-surface-contract.json');

    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const output = main(['--out=ignored.json'], JSON.stringify({
      profile: { name: 'main' },
      sessionId: 'session-cli',
      deviceId: 'VIGIL',
    }));

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(manifest(output).schema).toBe(RUNTIME_OPERATOR_UI_SURFACE_MANIFEST_SCHEMA_VERSION);
    expect(manifest(output).sessionId).toBe('session-cli');
    expect(manifest(output).baseline_commit).toBe(BASELINE_COMMIT);
    expect(manifest(output).phase_registry.current_through_phase).toBe(35);
    expect(manifest(output).phase_registry.phase_inventory_count).toBe(35);
    expect(manifest(output).phase_registry.schema_registry_count).toBe(35);
    expect(manifest(output).phase_registry.cli_registry_count).toBe(35);
    expect(manifest(output).commit_chain).toHaveLength(23);
    expect(manifest(output).surface_contract.display_only).toBe(true);
    expect(manifest(output).capability_matrix.runtimeStarted).toBe(false);
    expect(manifest(output).capability_matrix.runnerExecuted).toBe(false);
    expect(manifest(output).capability_matrix.serverCanExecuteLocal).toBe(false);
    expect(manifest(output).boundary_truth.statusCardIsUiProof).toBe(false);
    expect(manifest(output).side_effect_result.no_output_file_written).toBe(true);
    expect(validationReport(output).decision).toBe('accepted_validation_only');
    expect(validateMiraCoreRuntimeOperatorUiSurfaceOutput(output, runtimeOperatorUiSurfaceContract))
      .toEqual(expect.objectContaining({ ok: true }));
  });
});
