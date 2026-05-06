const killSwitchWiringSafetyContract = require('./fixtures/mira-core-kill-switch-wiring-safety-contract.json');
const {
  BASELINE_COMMIT,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_SAFETY_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  KILL_SWITCH_WIRING_SAFETY_SCHEMA_VERSION,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreKillSwitchWiringSafety,
  killSwitchWiringSafetyIdempotencyKey,
  validateMiraCoreKillSwitchWiringSafetyOutput,
} = require('../modules/mira-core/kill-switch-wiring-safety');
const {
  main,
  parseArgs,
} = require('../scripts/hm-mira-core-kill-switch-wiring-safety');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function build(inputSignals = {}) {
  return buildMiraCoreKillSwitchWiringSafety({
    contract: killSwitchWiringSafetyContract,
    inputSignals,
    nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
  });
}

function safety(output) {
  return output.kill_switch_wiring_safety;
}

function report(output) {
  return output.validation_report;
}

function expectRequiredFields(value, fields) {
  for (const field of fields) expect(value).toHaveProperty(field);
}

function recomputeSafetyKey(output) {
  safety(output).idempotency_key = killSwitchWiringSafetyIdempotencyKey(safety(output));
}

function expectValidatorFails(output, checkId) {
  const validation = validateMiraCoreKillSwitchWiringSafetyOutput(output, killSwitchWiringSafetyContract);
  expect(validation.ok).toBe(false);
  expect(validation.checks.some((entry) => entry.id === checkId && entry.ok === false)).toBe(true);
}

describe('mira core kill-switch wiring safety v0', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('satisfies Oracle output, manifest, and validation report shapes', () => {
    const output = build();

    expectRequiredFields(output, killSwitchWiringSafetyContract.expectedOutputShape.requiredTopLevelFields);
    expect(killSwitchWiringSafetyContract.expectedOutputShape.requiredTopLevelFields)
      .toEqual(REQUIRED_OUTPUT_FIELDS);
    expect(safety(output).schema).toBe(KILL_SWITCH_WIRING_SAFETY_SCHEMA_VERSION);
    expect(report(output).schema).toBe(VALIDATION_REPORT_SCHEMA_VERSION);
    expectRequiredFields(safety(output), killSwitchWiringSafetyContract.expectedManifestShape.requiredFields);
    expect(killSwitchWiringSafetyContract.expectedManifestShape.requiredFields)
      .toEqual(REQUIRED_SAFETY_FIELDS);
    expectRequiredFields(report(output), killSwitchWiringSafetyContract.expectedValidationReportShape.requiredFields);
    expect(killSwitchWiringSafetyContract.expectedValidationReportShape.requiredFields)
      .toEqual(REQUIRED_VALIDATION_REPORT_FIELDS);
    expect(report(output)).toEqual(expect.objectContaining({
      decision: 'accepted_validation_only',
      accepted: true,
      blocked: false,
      reasons: [],
    }));
    expect(validateMiraCoreKillSwitchWiringSafetyOutput(output, killSwitchWiringSafetyContract))
      .toEqual(expect.objectContaining({ ok: true }));
    expect(() => assertNoForbiddenOutput(output, killSwitchWiringSafetyContract.forbiddenOutputSubstrings))
      .not.toThrow();
  });

  test('pins baseline b6fd5b8, registries through Phase 44, and exact commit chain', () => {
    const current = safety(build());
    const expected = killSwitchWiringSafetyContract.phaseRegistryExpected;

    expect(BASELINE_COMMIT).toBe(killSwitchWiringSafetyContract.baseline.commit);
    expect(current.baseline_commit).toBe(BASELINE_COMMIT);
    expect(current.phase_registry).toEqual(expect.objectContaining({
      source_ref: expected.source_ref,
      current_through_phase: 44,
      expected_phases: '1-44',
      phase_inventory_count: 44,
      schema_registry_count: 44,
      cli_registry_count: 44,
      phase43_implementation_risk_current: true,
      phase44_flag_reader_safety_current: true,
      phase44_commit: BASELINE_COMMIT,
    }));
    expect(current.phase_registry.phase44_delta).toEqual(expect.objectContaining(expected.phase44_delta));
    expect(current.schema_registry).toHaveLength(44);
    expect(current.cli_registry).toHaveLength(44);
    expect(current.commit_chain).toEqual(killSwitchWiringSafetyContract.commitChainExpected);
    expect(current.commit_chain).toHaveLength(
      killSwitchWiringSafetyContract.expectedManifestShape.expectedCounts.commit_chain_count,
    );
    expect(current.commit_chain[current.commit_chain.length - 1]).toBe(BASELINE_COMMIT);
  });

  test('preserves source recommendation, satisfied Phase44 work, stale truth, closures, and source refs', () => {
    const current = safety(build());

    expect(current.source_recommendation).toEqual(expect.objectContaining(
      killSwitchWiringSafetyContract.sourceRecommendation,
    ));
    expect(current.source_recommendation).toEqual(expect.objectContaining({
      tier: 'tier1',
      contract_only_now: true,
      implemented_now: false,
      does_not_authorize_kill_switch_wiring: true,
    }));
    expect(current.satisfied_prior_recommendations).toEqual(
      killSwitchWiringSafetyContract.satisfiedPriorRecommendations,
    );
    expect(current.current_truth).toEqual(expect.objectContaining(
      killSwitchWiringSafetyContract.currentTruthExpected,
    ));
    expect(current.stale_readiness).toEqual(expect.objectContaining(
      killSwitchWiringSafetyContract.staleReadinessExpected,
    ));
    expect(current.phase34_prior_recommendations.phase35_runtime_status_milestone_refresh_validator.status)
      .toBe('satisfied_by_c04155d_do_not_repeat_as_open_work');
    expect(current.closure_summary).toEqual(expect.objectContaining(
      killSwitchWiringSafetyContract.closureSummaryExpected,
    ));
    expect(current.closure_summary.closed_review_refs)
      .toEqual(killSwitchWiringSafetyContract.closureSummaryExpected.closed_review_refs);
    expect(current.source_refs).toEqual(killSwitchWiringSafetyContract.sourceRefsExpected);
    expect(current.source_refs).toHaveLength(14);
    expect(current.source_refs.some((ref) => ref.artifact_id === 'phase44-runtime-mode-flag-reader-safety'))
      .toBe(true);
  });

  test('defines disabled runtime, flag-reader, env/config, kill-switch, and wiring boundaries', () => {
    const current = safety(build());

    for (const [field, shape] of [
      ['prerequisite_boundary', killSwitchWiringSafetyContract.prerequisiteBoundaryShapeExpected],
      ['runtime_mode_boundary', killSwitchWiringSafetyContract.runtimeModeBoundaryShapeExpected],
      ['flag_reader_boundary', killSwitchWiringSafetyContract.flagReaderBoundaryShapeExpected],
      ['env_config_read_boundary', killSwitchWiringSafetyContract.envConfigReadBoundaryShapeExpected],
      ['kill_switch_boundary', killSwitchWiringSafetyContract.killSwitchBoundaryShapeExpected],
      ['kill_switch_wiring_boundary', killSwitchWiringSafetyContract.killSwitchWiringBoundaryShapeExpected],
      ['implementation_risk_boundary', killSwitchWiringSafetyContract.implementationRiskBoundaryShapeExpected],
    ]) {
      expectRequiredFields(current[field], shape.requiredFields);
      expect(current[field]).toEqual(expect.objectContaining(shape.requiredValues));
    }

    expect(current.kill_switch_boundary).toEqual(expect.objectContaining({
      visible_to_operator: true,
      default_behavior: 'fail_closed',
      wired: false,
      killWired: false,
      liveCheck: false,
    }));
    expect(current.kill_switch_wiring_boundary).toEqual(expect.objectContaining({
      contract_only_now: true,
      reference_only: true,
      fail_closed_required: true,
      wiring_implemented_now: false,
      killWired: false,
      liveCheck: false,
      bypass_allowed: false,
      allow_open_allowed: false,
      control_execution_allowed: false,
      reporting_sink_allowed: false,
      authorizes_runtime: false,
      authorizes_execution: false,
    }));
  });

  test('keeps gaps, risks, and future slices blocked and non-authorizing', () => {
    const current = safety(build());

    expect(current.prerequisite_gap_matrix.map((entry) => entry.gap_id))
      .toEqual(killSwitchWiringSafetyContract.prerequisiteGapMatrixExpected.map((entry) => entry.gap_id));
    expect(current.prerequisite_gap_matrix).toHaveLength(2);
    for (const gap of current.prerequisite_gap_matrix) {
      expect(gap).toEqual(expect.objectContaining({
        status: 'unsatisfied_blocking_non_authorizing',
        satisfied_now: false,
        blocks_runtime_now: true,
        blocks_dry_run_now: true,
        reference_contract_only: true,
        authorizes_runtime: false,
      }));
    }
    expect(current.risk_register.map((entry) => entry.risk_id))
      .toEqual(killSwitchWiringSafetyContract.riskRegisterExpected.map((entry) => entry.risk_id));
    expect(current.risk_register).toHaveLength(8);
    expect(current.risk_register.every((entry) => (
      entry.status === 'blocking_non_authorizing'
      && entry.satisfied_now === false
      && entry.blocks_runtime_now === true
      && entry.authorizes_runtime === false
    ))).toBe(true);
    expect(current.blocked_future_slices).toEqual(expect.arrayContaining(
      killSwitchWiringSafetyContract.blockedFutureSlicesExpected.map((slice) => expect.objectContaining(slice)),
    ));
    expect(current.blocked_future_slices).toHaveLength(4);
  });

  test('preserves capability, proof, redaction, and no-side-effect truth', () => {
    const output = build();
    const current = safety(output);

    expect(current.capability_matrix).toEqual(expect.objectContaining(
      killSwitchWiringSafetyContract.capabilityMatrixExpected,
    ));
    expect(current.boundary_truth).toEqual(expect.objectContaining(
      killSwitchWiringSafetyContract.proofBoundaryExpected,
    ));
    expect(current.redaction_summary).toEqual(expect.objectContaining({
      raw_private_content_included: false,
      raw_terminal_included: false,
      raw_screenshot_ocr_browser_included: false,
      secret_material_included: false,
      customer_private_content_included: false,
      raw_config_included: false,
    }));
    for (const field of Object.keys(killSwitchWiringSafetyContract.sideEffectTruthExpected)) {
      expect(current.side_effect_result[field]).toBe(true);
      expect(report(output).side_effect_truth[field]).toBe(true);
    }
    expect(current.side_effect_result.killSwitchWired).toBe(false);
    expect(current.side_effect_result.killSwitchLiveCheckPerformed).toBe(false);
    expect(current.side_effect_result.controlExecutionPerformed).toBe(false);
    expect(current.side_effect_result.reportingSinkWritten).toBe(false);
    expect(current.side_effect_result.outputFileWritten).toBe(false);
  });

  test('next recommendations are fixture-owned Tier0/Tier1 and non-authorizing', () => {
    const current = safety(build());

    expect(current.next_phase_recommendations).toHaveLength(
      killSwitchWiringSafetyContract.nextRecommendationExpectedCandidates.length,
    );
    expect(current.next_phase_recommendations).toEqual(expect.arrayContaining(
      killSwitchWiringSafetyContract.nextRecommendationExpectedCandidates
        .map((candidate) => expect.objectContaining(candidate)),
    ));
    expect(current.next_phase_recommendations.map((item) => item.recommendation_id))
      .not.toContain(current.satisfied_prior_recommendations[0].recommendation_id);
    for (const recommendation of current.next_phase_recommendations) {
      expect(['tier0', 'tier1']).toContain(recommendation.tier);
      expect(recommendation.does_not_authorize_ui).toBe(true);
      expect(recommendation.does_not_authorize_runtime).toBe(true);
      expect(recommendation.does_not_authorize_execution).toBe(true);
      expect(recommendation.does_not_authorize_flag_read).toBe(true);
      expect(recommendation.does_not_authorize_kill_switch_wiring).toBe(true);
    }
  });

  test('validation report binds static rules, acceptance checks, tamper cases, literals, and paths', () => {
    const output = build();
    const validation = validateMiraCoreKillSwitchWiringSafetyOutput(output, killSwitchWiringSafetyContract);

    expect(validation.ok).toBe(true);
    expect(report(output).static_rule_results.map((entry) => entry.id))
      .toEqual(killSwitchWiringSafetyContract.staticValidationRules.map((entry) => entry.id));
    expect(report(output).acceptance_check_results.map((entry) => entry.id))
      .toEqual(killSwitchWiringSafetyContract.acceptanceChecks.map((entry) => entry.id));
    expect(report(output).tamper_case_results).toHaveLength(killSwitchWiringSafetyContract.tamperCases.length);
    expect(report(output).tamper_case_results.length).toBeGreaterThanOrEqual(
      killSwitchWiringSafetyContract.expectedManifestShape.expectedCounts.tamper_case_results_min,
    );
    expect(report(output).required_literal_results.length).toBeGreaterThanOrEqual(
      killSwitchWiringSafetyContract.expectedManifestShape.expectedCounts.required_literal_results_min,
    );
    expect(report(output).required_literal_results.every((entry) => entry.ok)).toBe(true);
    expect(report(output).referenced_path_results.length).toBeGreaterThan(0);
    expect(report(output).referenced_path_results.every((entry) => entry.ok)).toBe(true);
  });

  test('idempotency is stable for equivalent input and sensitive to scope and wiring facts', () => {
    const first = safety(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'VIGIL' }));
    const second = safety(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'VIGIL' }));
    const changedDevice = safety(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'ALT' }));
    const changedProfile = safety(build({ profile: { name: 'side' }, sessionId: 'session-a', deviceId: 'VIGIL' }));

    expect(first.idempotency_key).toBe(second.idempotency_key);
    expect(first.safety_id).toBe(second.safety_id);
    expect(first.idempotency_key).not.toBe(changedDevice.idempotency_key);
    expect(first.idempotency_key).not.toBe(changedProfile.idempotency_key);

    const tampered = clone(build());
    const originalKey = safety(tampered).idempotency_key;
    safety(tampered).kill_switch_wiring_boundary.killWired = true;
    recomputeSafetyKey(tampered);
    expect(safety(tampered).idempotency_key).not.toBe(originalKey);
    expectValidatorFails(tampered, 'kill-switch-wiring-boundary-unwired');
  });

  test('validator rejects baseline, registry, source, stale, closure, source-ref, and path drift', () => {
    const cases = [
      ['baseline-pinned-b6fd5b8', (output) => { safety(output).baseline_commit = '78f5164'; }],
      ['phase44-current-preserved', (output) => { safety(output).phase_registry.phase44_flag_reader_safety_current = false; }],
      ['phase43-current-preserved', (output) => { safety(output).phase_registry.phase43_implementation_risk_current = false; }],
      ['phase-inventory-count-44', (output) => { safety(output).phase_registry.phase_inventory_count = 43; }],
      ['commit-chain-exact-32', (output) => { safety(output).commit_chain.pop(); }],
      ['source-tier1-kill-switch-wiring-selected', (output) => { safety(output).source_recommendation.recommendation_id = 'wrong'; }],
      ['phase44-tier0-satisfied-not-open', (output) => { safety(output).satisfied_prior_recommendations[0].status = 'open'; }],
      ['stale-phase13-preserved', (output) => { safety(output).stale_readiness.phase13_readiness_current = true; }],
      ['stale-phase23-preserved', (output) => { safety(output).stale_readiness.phase23_milestone_readiness_current = true; }],
      ['stale-phase31-preserved', (output) => { safety(output).stale_readiness.phase31_runtime_milestone_refresh_current = true; }],
      ['closure-chain-through-oracle174', (output) => { safety(output).closure_summary.phase44_oracle_174_read_only_review_green = false; }],
      ['source-refs-include-phase44', (output) => {
        safety(output).source_refs = safety(output).source_refs
          .filter((ref) => ref.artifact_id !== 'phase44-runtime-mode-flag-reader-safety');
      }],
    ];

    for (const [checkId, mutate] of cases) {
      const output = clone(build());
      mutate(output);
      recomputeSafetyKey(output);
      expectValidatorFails(output, checkId);
    }

    const pathLie = clone(build());
    report(pathLie).referenced_path_results[0].exists = false;
    report(pathLie).referenced_path_results[0].ok = false;
    expectValidatorFails(pathLie, 'referenced-path-results-complete');
  });

  test('validator rejects runtime mode, flag-reader, env/config, kill-switch, and wiring boundary drift', () => {
    const cases = [
      ['runtime-mode-boundary-disabled-reference-only', (output) => { safety(output).runtime_mode_boundary.effective_state = 'enabled'; }],
      ['runtime-mode-no-flag-read', (output) => { safety(output).runtime_mode_boundary.flag_read_now = true; }],
      ['flag-reader-boundary-contract-only', (output) => { safety(output).flag_reader_boundary.reader_implemented_now = true; }],
      ['flag-reader-no-env-config-flag-secret-read', (output) => { safety(output).flag_reader_boundary.envReadNow = true; }],
      ['env-config-read-boundary-none', (output) => { safety(output).env_config_read_boundary.config_read_performed = true; }],
      ['env-config-read-boundary-none', (output) => { safety(output).env_config_read_boundary.process_env_accessed = true; }],
      ['kill-switch-boundary-fail-closed-reference-only', (output) => { safety(output).kill_switch_boundary.killWired = true; }],
      ['kill-switch-no-live-check', (output) => { safety(output).kill_switch_boundary.liveCheck = true; }],
      ['kill-switch-wiring-boundary-contract-only', (output) => { safety(output).kill_switch_wiring_boundary.wiring_implemented_now = true; }],
      ['kill-switch-wiring-no-live-check', (output) => { safety(output).kill_switch_wiring_boundary.liveCheck = true; }],
      ['kill-switch-wiring-no-bypass', (output) => { safety(output).kill_switch_wiring_boundary.bypass_allowed = true; }],
      ['kill-switch-wiring-no-allow-open', (output) => { safety(output).kill_switch_wiring_boundary.allow_open_allowed = true; }],
      ['kill-switch-wiring-no-control-execution', (output) => { safety(output).kill_switch_wiring_boundary.control_execution_allowed = true; }],
      ['kill-switch-wiring-no-reporting-sink', (output) => { safety(output).kill_switch_wiring_boundary.reporting_sink_allowed = true; }],
      ['kill-switch-wiring-non-authorizing', (output) => { safety(output).kill_switch_wiring_boundary.authorizes_runtime = true; }],
    ];

    for (const [checkId, mutate] of cases) {
      const output = clone(build());
      mutate(output);
      recomputeSafetyKey(output);
      expectValidatorFails(output, checkId);
    }
  });

  test('validator rejects gap, implementation risk, risk register, and blocked-slice drift', () => {
    const cases = [
      ['gap-matrix-runtime-mode-unsatisfied', (output) => { safety(output).prerequisite_gap_matrix[0].satisfied_now = true; }],
      ['gap-matrix-live-kill-switch-unsatisfied', (output) => { safety(output).prerequisite_gap_matrix[1].satisfied_now = true; }],
      ['implementation-risk-boundary-non-authorizing', (output) => { safety(output).implementation_risk_boundary.kill_switch_wiring_allowed_now = true; }],
      ['implementation-risk-boundary-non-authorizing', (output) => { safety(output).implementation_risk_boundary.control_execution_allowed_now = true; }],
      ['risk-register-eight-blocking-risks', (output) => { safety(output).risk_register[0].satisfied_now = true; }],
      ['risk-register-all-non-authorizing', (output) => { safety(output).risk_register[0].authorizes_runtime = true; }],
      ['live-kill-switch-wiring-slice-blocked', (output) => { safety(output).blocked_future_slices[0].blocked_now = false; }],
      ['live-kill-switch-wiring-slice-blocked', (output) => { safety(output).blocked_future_slices[0].authorizes_kill_switch_wiring = true; }],
      ['runtime-mode-flag-reader-slice-blocked', (output) => { safety(output).blocked_future_slices[1].authorizes_flag_read = true; }],
      ['control-path-execution-slice-blocked', (output) => { safety(output).blocked_future_slices[2].authorizes_execution = true; }],
      ['reporting-sink-write-slice-blocked', (output) => { safety(output).blocked_future_slices[3].authorizes_reporting_sink = true; }],
    ];

    for (const [checkId, mutate] of cases) {
      const output = clone(build());
      mutate(output);
      recomputeSafetyKey(output);
      expectValidatorFails(output, checkId);
    }
  });

  test('validator rejects capability, proof, side-effect, and redaction overclaims', () => {
    const cases = [
      ['runtime-started-false', (output) => {
        safety(output).capability_matrix.runtimeStarted = true;
        safety(output).boundary_truth.runtimeStarted = true;
      }],
      ['kill-switch-wiring-available-false', (output) => { safety(output).capability_matrix.killSwitchWiringAvailable = true; }],
      ['kill-switch-live-check-available-false', (output) => { safety(output).capability_matrix.killSwitchLiveCheckAvailable = true; }],
      ['control-execution-available-false', (output) => { safety(output).capability_matrix.controlExecutionAvailable = true; }],
      ['server-can-prove-model-processing-false', (output) => { safety(output).capability_matrix.serverCanProveModelProcessing = true; }],
      ['proof-boundaries-false', (output) => { safety(output).boundary_truth.killSwitchWiringSafetyIsRuntimeAuthorization = true; }],
      ['builder-oracle-direct-targets-blocked', (output) => {
        safety(output).capability_matrix.directBuilderOracleServerTargetsAllowed = true;
        safety(output).boundary_truth.builderOracleDirectServerTargetsAllowed = true;
      }],
      ['no-kill-switch-wiring-side-effect', (output) => {
        safety(output).side_effect_result.no_kill_switch_wired = false;
        safety(output).side_effect_result.killSwitchWired = true;
      }],
      ['no-kill-switch-wiring-side-effect', (output) => {
        safety(output).side_effect_result.no_kill_switch_live_check = false;
        safety(output).side_effect_result.killSwitchLiveCheckPerformed = true;
      }],
      ['no-control-or-reporting-side-effect', (output) => {
        safety(output).side_effect_result.no_control_execution_performed = false;
        safety(output).side_effect_result.controlExecutionPerformed = true;
      }],
      ['side-effect-truth-all-blocked', (output) => {
        safety(output).side_effect_result.no_output_file_written = false;
        safety(output).side_effect_result.outputFilesWritten = 1;
      }],
      ['redaction-summary-safe', (output) => { safety(output).redaction_summary.note = 'bearer token'; }],
    ];

    for (const [checkId, mutate] of cases) {
      const output = clone(build());
      mutate(output);
      recomputeSafetyKey(output);
      expectValidatorFails(output, checkId);
    }
  });

  test('validator rejects unsafe next-action drift and Tier2+ recommendations after idempotency recompute', () => {
    const unsafePhrases = [
      'wire kill switch',
      'kill switch live check',
      'bypass kill switch',
      'allow open',
      'execute control',
      'write report',
      'send email to customer',
      'email a client',
      'message the client',
      'runtime start',
      'read env flag',
      'read config',
    ];

    for (const phrase of unsafePhrases) {
      const output = clone(build());
      safety(output).next_phase_recommendations[0].why_safe = `safe to ${phrase}`;
      recomputeSafetyKey(output);
      expectValidatorFails(output, 'unsafe-action-drift-rejected');
    }

    const tier2 = clone(build());
    safety(tier2).next_phase_recommendations[0].tier = 'tier2';
    recomputeSafetyKey(tier2);
    expectValidatorFails(tier2, 'next-recommendations-tier0-tier1-only');
  });

  test('validator rejects validation-report lies, missing tamper coverage, and literal/path result lies', () => {
    const staticLie = clone(build());
    report(staticLie).static_rule_results[0].ok = false;
    expectValidatorFails(staticLie, 'validation-report-matches-contract');

    const acceptanceLie = clone(build());
    report(acceptanceLie).acceptance_check_results[0].ok = false;
    expectValidatorFails(acceptanceLie, 'validation-report-matches-contract');

    const missingTamper = clone(build());
    report(missingTamper).tamper_case_results = [];
    expectValidatorFails(missingTamper, 'validation-report-coverage-bound');
    expectValidatorFails(missingTamper, 'validation-report-matches-contract');

    const literalLie = clone(build());
    safety(literalLie).baseline_commit = '78f5164';
    recomputeSafetyKey(literalLie);
    const literal = report(literalLie).required_literal_results.find((entry) => entry.path === 'baseline_commit');
    literal.actual = BASELINE_COMMIT;
    literal.ok = true;
    expectValidatorFails(literalLie, 'required-literal-checks-bound');
    expectValidatorFails(literalLie, 'validation-report-matches-contract');
  });

  test('CLI is stdout-only, consumes the Oracle fixture, and ignores output-file flags', () => {
    const parsed = parseArgs(['--pretty', '--out', 'ignored.json']);
    expect(parsed.pretty).toBe(true);
    expect(parsed.fixturePath).toContain('mira-core-kill-switch-wiring-safety-contract.json');

    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const output = main(['--out=ignored.json'], JSON.stringify({
      profile: { name: 'main' },
      sessionId: 'session-cli',
      deviceId: 'VIGIL',
    }));

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(safety(output).schema).toBe(KILL_SWITCH_WIRING_SAFETY_SCHEMA_VERSION);
    expect(safety(output).sessionId).toBe('session-cli');
    expect(safety(output).baseline_commit).toBe(BASELINE_COMMIT);
    expect(safety(output).phase_registry.current_through_phase).toBe(44);
    expect(safety(output).schema_registry).toHaveLength(44);
    expect(safety(output).cli_registry).toHaveLength(44);
    expect(safety(output).commit_chain).toHaveLength(32);
    expect(safety(output).source_refs).toHaveLength(14);
    expect(safety(output).prerequisite_gap_matrix).toHaveLength(2);
    expect(safety(output).risk_register).toHaveLength(8);
    expect(safety(output).blocked_future_slices).toHaveLength(4);
    expect(safety(output).kill_switch_boundary.killWired).toBe(false);
    expect(safety(output).kill_switch_wiring_boundary.killWired).toBe(false);
    expect(safety(output).kill_switch_wiring_boundary.liveCheck).toBe(false);
    expect(safety(output).capability_matrix.killSwitchWiringAvailable).toBe(false);
    expect(safety(output).capability_matrix.serverCanExecuteLocal).toBe(false);
    expect(safety(output).side_effect_result.no_output_file_written).toBe(true);
    expect(safety(output).side_effect_result.no_kill_switch_wired).toBe(true);
    expect(safety(output).side_effect_result.no_kill_switch_live_check).toBe(true);
    expect(report(output).decision).toBe('accepted_validation_only');
    expect(validateMiraCoreKillSwitchWiringSafetyOutput(output, killSwitchWiringSafetyContract))
      .toEqual(expect.objectContaining({ ok: true }));
  });
});
