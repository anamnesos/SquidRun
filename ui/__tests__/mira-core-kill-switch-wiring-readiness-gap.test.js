const killSwitchWiringReadinessGapContract = require('./fixtures/mira-core-kill-switch-wiring-readiness-gap-contract.json');
const {
  BASELINE_COMMIT,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_GAP_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  KILL_SWITCH_WIRING_READINESS_GAP_SCHEMA_VERSION,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreKillSwitchWiringReadinessGap,
  killSwitchWiringReadinessGapIdempotencyKey,
  validateMiraCoreKillSwitchWiringReadinessGapOutput,
} = require('../modules/mira-core/kill-switch-wiring-readiness-gap');
const {
  main,
  parseArgs,
} = require('../scripts/hm-mira-core-kill-switch-wiring-readiness-gap');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function build(inputSignals = {}) {
  return buildMiraCoreKillSwitchWiringReadinessGap({
    contract: killSwitchWiringReadinessGapContract,
    inputSignals,
    nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
  });
}

function gap(output) {
  return output.kill_switch_wiring_readiness_gap;
}

function report(output) {
  return output.validation_report;
}

function expectRequiredFields(value, fields) {
  for (const field of fields) expect(value).toHaveProperty(field);
}

function recomputeGapKey(output) {
  gap(output).idempotency_key = killSwitchWiringReadinessGapIdempotencyKey(gap(output));
}

function expectValidatorFails(output, checkId) {
  const validation = validateMiraCoreKillSwitchWiringReadinessGapOutput(
    output,
    killSwitchWiringReadinessGapContract,
  );
  expect(validation.ok).toBe(false);
  expect(validation.checks.some((entry) => entry.id === checkId && entry.ok === false)).toBe(true);
}

describe('mira core kill-switch wiring readiness gap v0', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('satisfies Oracle output, manifest, and validation report shapes', () => {
    const output = build();

    expectRequiredFields(output, killSwitchWiringReadinessGapContract.expectedOutputShape.requiredTopLevelFields);
    expect(killSwitchWiringReadinessGapContract.expectedOutputShape.requiredTopLevelFields)
      .toEqual(REQUIRED_OUTPUT_FIELDS);
    expect(gap(output).schema).toBe(KILL_SWITCH_WIRING_READINESS_GAP_SCHEMA_VERSION);
    expect(report(output).schema).toBe(VALIDATION_REPORT_SCHEMA_VERSION);
    expectRequiredFields(gap(output), killSwitchWiringReadinessGapContract.expectedManifestShape.requiredFields);
    expect(killSwitchWiringReadinessGapContract.expectedManifestShape.requiredFields)
      .toEqual(REQUIRED_GAP_FIELDS);
    expectRequiredFields(report(output), killSwitchWiringReadinessGapContract.expectedValidationReportShape.requiredFields);
    expect(killSwitchWiringReadinessGapContract.expectedValidationReportShape.requiredFields)
      .toEqual(REQUIRED_VALIDATION_REPORT_FIELDS);
    expect(report(output)).toEqual(expect.objectContaining({
      decision: 'accepted_validation_only',
      accepted: true,
      blocked: false,
      reasons: [],
    }));
    expect(validateMiraCoreKillSwitchWiringReadinessGapOutput(output, killSwitchWiringReadinessGapContract))
      .toEqual(expect.objectContaining({ ok: true }));
    expect(() => assertNoForbiddenOutput(output, killSwitchWiringReadinessGapContract.forbiddenOutputSubstrings))
      .not.toThrow();
  });

  test('pins baseline 62fa3a8, registries through Phase 45, and exact commit chain', () => {
    const current = gap(build());
    const expected = killSwitchWiringReadinessGapContract.phaseRegistryExpected;

    expect(BASELINE_COMMIT).toBe(killSwitchWiringReadinessGapContract.baseline.commit);
    expect(current.baseline_commit).toBe(BASELINE_COMMIT);
    expect(current.phase_registry).toEqual(expect.objectContaining({
      source_ref: expected.source_ref,
      current_through_phase: 45,
      expected_phases: '1-45',
      phase_inventory_count: 45,
      schema_registry_count: 45,
      cli_registry_count: 45,
      phase44_flag_reader_safety_current: true,
      phase45_kill_switch_wiring_safety_current: true,
      phase45_commit: BASELINE_COMMIT,
    }));
    expect(current.phase_registry.phase45_delta).toEqual(expect.objectContaining(expected.phase45_delta));
    expect(current.schema_registry).toHaveLength(45);
    expect(current.cli_registry).toHaveLength(45);
    expect(current.commit_chain).toEqual(killSwitchWiringReadinessGapContract.commitChainExpected);
    expect(current.commit_chain).toHaveLength(
      killSwitchWiringReadinessGapContract.expectedManifestShape.expectedCounts.commit_chain_count,
    );
    expect(current.commit_chain[current.commit_chain.length - 1]).toBe(BASELINE_COMMIT);
  });

  test('preserves source recommendation, satisfied Phase45 work, stale truth, closures, and source refs', () => {
    const current = gap(build());

    expect(current.source_recommendation).toEqual(expect.objectContaining(
      killSwitchWiringReadinessGapContract.sourceRecommendation,
    ));
    expect(current.source_recommendation).toEqual(expect.objectContaining({
      tier: 'tier1',
      contract_only_now: true,
      implemented_now: false,
      does_not_authorize_kill_switch_wiring: true,
    }));
    expect(current.satisfied_prior_recommendations).toEqual(
      killSwitchWiringReadinessGapContract.satisfiedPriorRecommendations,
    );
    expect(current.current_truth).toEqual(expect.objectContaining(
      killSwitchWiringReadinessGapContract.currentTruthExpected,
    ));
    expect(current.stale_readiness).toEqual(expect.objectContaining(
      killSwitchWiringReadinessGapContract.staleReadinessExpected,
    ));
    expect(current.phase34_prior_recommendations.phase35_runtime_status_milestone_refresh_validator.status)
      .toBe('satisfied_by_c04155d_do_not_repeat_as_open_work');
    expect(current.closure_summary).toEqual(expect.objectContaining(
      killSwitchWiringReadinessGapContract.closureSummaryExpected,
    ));
    expect(current.closure_summary.closed_review_refs)
      .toEqual(killSwitchWiringReadinessGapContract.closureSummaryExpected.closed_review_refs);
    expect(current.source_refs).toEqual(killSwitchWiringReadinessGapContract.sourceRefsExpected);
    expect(current.source_refs).toHaveLength(15);
    expect(current.source_refs.some((ref) => ref.artifact_id === 'phase45-kill-switch-wiring-safety'))
      .toBe(true);
  });

  test('defines readiness summary plus disabled runtime, flag-reader, env/config, kill-switch, and wiring boundaries', () => {
    const current = gap(build());

    expectRequiredFields(current.readiness_gap_summary, killSwitchWiringReadinessGapContract.readinessGapSummaryExpected.requiredFields);
    expect(current.readiness_gap_summary).toEqual(expect.objectContaining(
      killSwitchWiringReadinessGapContract.readinessGapSummaryExpected.requiredValues,
    ));
    expect(current.readiness_gap_summary).toEqual(expect.objectContaining({
      decision: 'remain_kill_switch_wiring_readiness_gap_contract_only',
      status: 'blocked_unimplemented_unwired_non_authorizing',
      ready_for_runtime_now: false,
      ready_for_dry_run_now: false,
      ready_for_kill_switch_wiring_now: false,
    }));

    for (const [field, shape] of [
      ['runtime_mode_boundary', killSwitchWiringReadinessGapContract.runtimeModeBoundaryShapeExpected],
      ['flag_reader_boundary', killSwitchWiringReadinessGapContract.flagReaderBoundaryShapeExpected],
      ['env_config_read_boundary', killSwitchWiringReadinessGapContract.envConfigReadBoundaryShapeExpected],
      ['kill_switch_boundary', killSwitchWiringReadinessGapContract.killSwitchBoundaryShapeExpected],
      ['kill_switch_wiring_boundary', killSwitchWiringReadinessGapContract.killSwitchWiringBoundaryShapeExpected],
    ]) {
      expect(current[field]).toEqual(expect.objectContaining(shape.requiredValues));
    }

    expect(current.kill_switch_boundary).toEqual(expect.objectContaining({
      visible_to_operator: true,
      default_behavior: 'fail_closed',
      wired: false,
      killWired: false,
      liveCheck: false,
      bypass_allowed: false,
      allow_open_allowed: false,
    }));
    expect(current.kill_switch_wiring_boundary).toEqual(expect.objectContaining({
      contract_only_now: true,
      reference_only: true,
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

  test('keeps prerequisite gaps, readiness gaps, and future slices blocked and non-authorizing', () => {
    const current = gap(build());

    expect(current.prerequisite_gap_matrix.map((entry) => entry.gap_id))
      .toEqual(killSwitchWiringReadinessGapContract.prerequisiteGapMatrixExpected.map((entry) => entry.gap_id));
    expect(current.prerequisite_gap_matrix).toHaveLength(2);
    for (const prerequisiteGap of current.prerequisite_gap_matrix) {
      expect(prerequisiteGap).toEqual(expect.objectContaining({
        status: 'unsatisfied_blocking_non_authorizing',
        satisfied_now: false,
        blocks_runtime_now: true,
        blocks_dry_run_now: true,
        reference_contract_only: true,
        authorizes_runtime: false,
      }));
    }

    expect(current.readiness_gap_matrix.map((entry) => entry.gap_id))
      .toEqual(killSwitchWiringReadinessGapContract.readinessGapMatrixExpected.map((entry) => entry.gap_id));
    expect(current.readiness_gap_matrix).toHaveLength(6);
    expect(current.readiness_gap_matrix.every((entry) => (
      entry.status === 'unsatisfied_blocking_non_authorizing'
      && entry.satisfied_now === false
      && entry.blocks_kill_switch_wiring_now === true
      && entry.authorizes_runtime === false
      && entry.authorizes_kill_switch_wiring === false
    ))).toBe(true);

    expect(current.blocked_future_slices).toEqual(expect.arrayContaining(
      killSwitchWiringReadinessGapContract.blockedFutureSlicesExpected
        .map((slice) => expect.objectContaining(slice)),
    ));
    expect(current.blocked_future_slices).toHaveLength(4);
  });

  test('preserves capability, proof, redaction, and no-side-effect truth', () => {
    const output = build();
    const current = gap(output);

    expect(current.capability_matrix).toEqual(expect.objectContaining(
      killSwitchWiringReadinessGapContract.capabilityMatrixExpected,
    ));
    expect(current.boundary_truth).toEqual(expect.objectContaining(
      killSwitchWiringReadinessGapContract.proofBoundaryExpected,
    ));
    expect(current.redaction_summary).toEqual(expect.objectContaining({
      raw_private_content_included: false,
      raw_terminal_included: false,
      raw_screenshot_ocr_browser_included: false,
      secret_material_included: false,
      customer_private_content_included: false,
      raw_config_included: false,
    }));
    for (const field of Object.keys(killSwitchWiringReadinessGapContract.sideEffectTruthExpected)) {
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
    const current = gap(build());

    expect(current.next_phase_recommendations).toHaveLength(
      killSwitchWiringReadinessGapContract.nextRecommendationExpectedCandidates.length,
    );
    expect(current.next_phase_recommendations).toEqual(expect.arrayContaining(
      killSwitchWiringReadinessGapContract.nextRecommendationExpectedCandidates
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
    const validation = validateMiraCoreKillSwitchWiringReadinessGapOutput(output, killSwitchWiringReadinessGapContract);

    expect(validation.ok).toBe(true);
    expect(report(output).static_rule_results.map((entry) => entry.id))
      .toEqual(killSwitchWiringReadinessGapContract.staticValidationRules.map((entry) => entry.id));
    expect(report(output).acceptance_check_results.map((entry) => entry.id))
      .toEqual(killSwitchWiringReadinessGapContract.acceptanceChecks.map((entry) => entry.id));
    expect(report(output).tamper_case_results).toHaveLength(killSwitchWiringReadinessGapContract.tamperCases.length);
    expect(report(output).tamper_case_results.length).toBeGreaterThanOrEqual(
      killSwitchWiringReadinessGapContract.expectedManifestShape.expectedCounts.tamper_case_results_min,
    );
    expect(report(output).required_literal_results.length).toBeGreaterThanOrEqual(
      killSwitchWiringReadinessGapContract.expectedManifestShape.expectedCounts.required_literal_results_min,
    );
    expect(report(output).required_literal_results.every((entry) => entry.ok)).toBe(true);
    expect(report(output).referenced_path_results.length).toBeGreaterThan(0);
    expect(report(output).referenced_path_results.every((entry) => entry.ok)).toBe(true);
  });

  test('idempotency is stable for equivalent input and sensitive to scope and wiring facts', () => {
    const first = gap(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'VIGIL' }));
    const second = gap(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'VIGIL' }));
    const changedDevice = gap(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'ALT' }));
    const changedProfile = gap(build({ profile: { name: 'side' }, sessionId: 'session-a', deviceId: 'VIGIL' }));

    expect(first.idempotency_key).toBe(second.idempotency_key);
    expect(first.gap_id).toBe(second.gap_id);
    expect(first.idempotency_key).not.toBe(changedDevice.idempotency_key);
    expect(first.idempotency_key).not.toBe(changedProfile.idempotency_key);

    const tampered = clone(build());
    const originalKey = gap(tampered).idempotency_key;
    gap(tampered).kill_switch_wiring_boundary.killWired = true;
    recomputeGapKey(tampered);
    expect(gap(tampered).idempotency_key).not.toBe(originalKey);
    expectValidatorFails(tampered, 'kill-switch-wiring-boundary-unwired');
  });

  test('validator rejects baseline, registry, source, stale, closure, source-ref, and path drift', () => {
    const cases = [
      ['baseline-pinned-62fa3a8', (output) => { gap(output).baseline_commit = 'b6fd5b8'; }],
      ['phase45-current-preserved', (output) => { gap(output).phase_registry.phase45_kill_switch_wiring_safety_current = false; }],
      ['phase44-current-preserved', (output) => { gap(output).current_truth.phase44_current = false; }],
      ['phase-inventory-exactly-45', (output) => { gap(output).phase_registry.phase_inventory_count = 44; }],
      ['commit-chain-exact-33', (output) => { gap(output).commit_chain.pop(); }],
      ['source-tier1-readiness-gap-selected', (output) => { gap(output).source_recommendation.recommendation_id = 'wrong'; }],
      ['phase45-tier0-satisfied-not-open', (output) => { gap(output).satisfied_prior_recommendations[0].status = 'open'; }],
      ['stale-phase13-preserved', (output) => { gap(output).stale_readiness.phase13_readiness_current = true; }],
      ['stale-phase23-preserved', (output) => { gap(output).stale_readiness.phase23_milestone_readiness_current = true; }],
      ['stale-phase31-preserved', (output) => { gap(output).stale_readiness.phase31_runtime_milestone_refresh_current = true; }],
      ['closure-chain-through-oracle178', (output) => { gap(output).closure_summary.phase45_oracle_178_read_only_review_green = false; }],
      ['source-refs-include-phase45', (output) => {
        gap(output).source_refs = gap(output).source_refs
          .filter((ref) => ref.artifact_id !== 'phase45-kill-switch-wiring-safety');
      }],
    ];

    for (const [checkId, mutate] of cases) {
      const output = clone(build());
      mutate(output);
      recomputeGapKey(output);
      expectValidatorFails(output, checkId);
    }

    const pathLie = clone(build());
    report(pathLie).referenced_path_results[0].exists = false;
    report(pathLie).referenced_path_results[0].ok = false;
    expectValidatorFails(pathLie, 'referenced-path-results-complete');
  });

  test('validator rejects readiness summary and boundary drift', () => {
    const cases = [
      ['readiness-summary-not-ready', (output) => { gap(output).readiness_gap_summary.ready_for_kill_switch_wiring_now = true; }],
      ['readiness-gap-summary-blocked', (output) => { gap(output).readiness_gap_summary.status = 'ready'; }],
      ['runtime-mode-boundary-disabled-reference-only', (output) => { gap(output).runtime_mode_boundary.effective_state = 'enabled'; }],
      ['runtime-mode-no-flag-read', (output) => { gap(output).runtime_mode_boundary.flag_read_now = true; }],
      ['flag-reader-boundary-contract-only', (output) => { gap(output).flag_reader_boundary.reader_implemented_now = true; }],
      ['flag-reader-no-env-config-flag-secret-read', (output) => { gap(output).flag_reader_boundary.envReadNow = true; }],
      ['env-config-read-boundary-none', (output) => { gap(output).env_config_read_boundary.config_read_performed = true; }],
      ['env-config-read-boundary-none', (output) => { gap(output).env_config_read_boundary.process_env_accessed = true; }],
      ['kill-switch-boundary-fail-closed-reference-only', (output) => { gap(output).kill_switch_boundary.killWired = true; }],
      ['kill-switch-no-live-check', (output) => { gap(output).kill_switch_boundary.liveCheck = true; }],
      ['kill-switch-no-bypass', (output) => { gap(output).kill_switch_boundary.bypass_allowed = true; }],
      ['kill-switch-no-allow-open', (output) => { gap(output).kill_switch_boundary.allow_open_allowed = true; }],
      ['kill-switch-wiring-boundary-unwired', (output) => { gap(output).kill_switch_wiring_boundary.wiring_implemented_now = true; }],
      ['kill-switch-wiring-no-live-check', (output) => { gap(output).kill_switch_wiring_boundary.liveCheck = true; }],
      ['kill-switch-wiring-no-bypass', (output) => { gap(output).kill_switch_wiring_boundary.bypass_allowed = true; }],
      ['kill-switch-wiring-no-allow-open', (output) => { gap(output).kill_switch_wiring_boundary.allow_open_allowed = true; }],
    ];

    for (const [checkId, mutate] of cases) {
      const output = clone(build());
      mutate(output);
      recomputeGapKey(output);
      expectValidatorFails(output, checkId);
    }
  });

  test('validator rejects prerequisite/readiness gap and blocked-slice drift', () => {
    const cases = [
      ['gap-matrix-exactly-two', (output) => { gap(output).prerequisite_gap_matrix.pop(); }],
      ['prerequisite-gap-matrix-two-unsatisfied-gaps', (output) => { gap(output).prerequisite_gap_matrix[0].satisfied_now = true; }],
      ['prerequisite-gap-matrix-two-unsatisfied-gaps', (output) => { gap(output).prerequisite_gap_matrix[1].satisfied_now = true; }],
      ['readiness-gap-matrix-exactly-six', (output) => { gap(output).readiness_gap_matrix.pop(); }],
      ['readiness-gaps-all-unsatisfied-blocking', (output) => { gap(output).readiness_gap_matrix[0].satisfied_now = true; }],
      ['readiness-gaps-all-unsatisfied-blocking', (output) => { gap(output).readiness_gap_matrix[0].authorizes_kill_switch_wiring = true; }],
      ['live-kill-switch-wiring-slice-blocked', (output) => { gap(output).blocked_future_slices[0].blocked_now = false; }],
      ['live-kill-switch-wiring-slice-blocked', (output) => { gap(output).blocked_future_slices[0].authorizes_kill_switch_wiring = true; }],
    ];

    for (const [checkId, mutate] of cases) {
      const output = clone(build());
      mutate(output);
      recomputeGapKey(output);
      expectValidatorFails(output, checkId);
    }
  });

  test('validator rejects capability, proof, side-effect, and redaction overclaims', () => {
    const cases = [
      ['runtime-started-false', (output) => {
        gap(output).capability_matrix.runtimeStarted = true;
        gap(output).boundary_truth.runtimeStarted = true;
      }],
      ['kill-switch-wiring-available-false', (output) => { gap(output).capability_matrix.killSwitchWiringAvailable = true; }],
      ['kill-switch-live-check-available-false', (output) => { gap(output).capability_matrix.killSwitchLiveCheckAvailable = true; }],
      ['server-can-prove-model-processing-false', (output) => { gap(output).capability_matrix.serverCanProveModelProcessing = true; }],
      ['proof-boundaries-false', (output) => { gap(output).boundary_truth.killSwitchWiringReadinessGapIsRuntimeAuthorization = true; }],
      ['builder-oracle-direct-targets-blocked', (output) => {
        gap(output).capability_matrix.directBuilderOracleServerTargetsAllowed = true;
        gap(output).boundary_truth.builderOracleDirectServerTargetsAllowed = true;
      }],
      ['no-kill-switch-wiring-side-effect', (output) => {
        gap(output).side_effect_result.no_kill_switch_wired = false;
        gap(output).side_effect_result.killSwitchWired = true;
      }],
      ['no-kill-switch-wiring-side-effect', (output) => {
        gap(output).side_effect_result.no_kill_switch_live_check = false;
        gap(output).side_effect_result.killSwitchLiveCheckPerformed = true;
      }],
      ['no-control-or-reporting-side-effect', (output) => {
        gap(output).side_effect_result.no_control_execution_performed = false;
        gap(output).side_effect_result.controlExecutionPerformed = true;
      }],
      ['side-effect-truth-all-blocked', (output) => {
        gap(output).side_effect_result.no_output_file_written = false;
        gap(output).side_effect_result.outputFilesWritten = 1;
      }],
      ['redaction-summary-safe', (output) => { gap(output).redaction_summary.note = 'bearer token'; }],
    ];

    for (const [checkId, mutate] of cases) {
      const output = clone(build());
      mutate(output);
      recomputeGapKey(output);
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
      'create queue',
    ];

    for (const phrase of unsafePhrases) {
      const output = clone(build());
      gap(output).next_phase_recommendations[0].why_safe = `safe to ${phrase}`;
      recomputeGapKey(output);
      expectValidatorFails(output, 'unsafe-action-drift-rejected');
    }

    const tier2 = clone(build());
    gap(tier2).next_phase_recommendations[0].tier = 'tier2';
    recomputeGapKey(tier2);
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
    gap(literalLie).baseline_commit = 'b6fd5b8';
    recomputeGapKey(literalLie);
    const literal = report(literalLie).required_literal_results.find((entry) => entry.path === 'baseline_commit');
    literal.actual = BASELINE_COMMIT;
    literal.ok = true;
    expectValidatorFails(literalLie, 'required-literal-checks-bound');
    expectValidatorFails(literalLie, 'validation-report-matches-contract');
  });

  test('CLI is stdout-only, consumes the Oracle fixture, and ignores output-file flags', () => {
    const parsed = parseArgs(['--pretty', '--out', 'ignored.json']);
    expect(parsed.pretty).toBe(true);
    expect(parsed.fixturePath).toContain('mira-core-kill-switch-wiring-readiness-gap-contract.json');

    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const output = main(['--out=ignored.json'], JSON.stringify({
      profile: { name: 'main' },
      sessionId: 'session-cli',
      deviceId: 'VIGIL',
    }));

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(gap(output).schema).toBe(KILL_SWITCH_WIRING_READINESS_GAP_SCHEMA_VERSION);
    expect(gap(output).sessionId).toBe('session-cli');
    expect(gap(output).baseline_commit).toBe(BASELINE_COMMIT);
    expect(gap(output).phase_registry.current_through_phase).toBe(45);
    expect(gap(output).schema_registry).toHaveLength(45);
    expect(gap(output).cli_registry).toHaveLength(45);
    expect(gap(output).commit_chain).toHaveLength(33);
    expect(gap(output).source_refs).toHaveLength(15);
    expect(gap(output).prerequisite_gap_matrix).toHaveLength(2);
    expect(gap(output).readiness_gap_matrix).toHaveLength(6);
    expect(gap(output).blocked_future_slices).toHaveLength(4);
    expect(gap(output).readiness_gap_summary.ready_for_kill_switch_wiring_now).toBe(false);
    expect(gap(output).kill_switch_boundary.killWired).toBe(false);
    expect(gap(output).kill_switch_wiring_boundary.killWired).toBe(false);
    expect(gap(output).kill_switch_wiring_boundary.liveCheck).toBe(false);
    expect(gap(output).capability_matrix.killSwitchWiringAvailable).toBe(false);
    expect(gap(output).capability_matrix.serverCanExecuteLocal).toBe(false);
    expect(gap(output).side_effect_result.no_output_file_written).toBe(true);
    expect(gap(output).side_effect_result.no_kill_switch_wired).toBe(true);
    expect(gap(output).side_effect_result.no_kill_switch_live_check).toBe(true);
    expect(report(output).decision).toBe('accepted_validation_only');
    expect(validateMiraCoreKillSwitchWiringReadinessGapOutput(output, killSwitchWiringReadinessGapContract))
      .toEqual(expect.objectContaining({ ok: true }));
  });
});
