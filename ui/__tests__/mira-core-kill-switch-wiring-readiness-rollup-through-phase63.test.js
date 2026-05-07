const killSwitchWiringReadinessRollupThroughPhase64Contract = require('./fixtures/mira-core-kill-switch-wiring-readiness-rollup-through-phase63-contract.json');
const {
  BASELINE_COMMIT,
  CURRENT_SCOPED_STATUS_KEY,
  STALE_SCOPED_STATUS_KEYS,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_DRY_CHECK_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  KILL_SWITCH_WIRING_READINESS_ROLLUP_THROUGH_PHASE64_SCHEMA_VERSION,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreKillSwitchWiringReadinessRollupThroughPhase64,
  killSwitchWiringReadinessRollupThroughPhase64IdempotencyKey,
  validateMiraCoreKillSwitchWiringReadinessRollupThroughPhase64Output,
} = require('../modules/mira-core/kill-switch-wiring-readiness-rollup-through-phase63');
const {
  main,
  parseArgs,
} = require('../scripts/hm-mira-core-kill-switch-wiring-readiness-rollup-through-phase63');

const OUTPUT_FIELD = 'kill_switch_wiring_readiness_rollup_through_phase63';
const PHASE63_HYBRID_FIELD = ['phase63', 'boundary_refresh_summary'].join('_');
const PHASE63_HYBRID_CAMEL = ['phase63', 'Boundary', 'Refresh', 'Summary'].join('');
const PHASE63_HYBRID_SLUG = ['phase63', 'boundary', 'refresh'].join('-');
const INHERITED_PHASE62_CURRENT_ACCEPT_ID =
  ['accept', 'phase62', 'current', 'scoped', 'status', 'key', 'required'].join('-');
const INHERITED_PHASE62_CURRENT_TAMPER_ID =
  ['tamper', 'phase62', 'current', 'scoped', 'key', 'missing'].join('-');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function build(inputSignals = {}) {
  return buildMiraCoreKillSwitchWiringReadinessRollupThroughPhase64({
    contract: killSwitchWiringReadinessRollupThroughPhase64Contract,
    inputSignals,
    nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
  });
}

function rollup(output) {
  return output[OUTPUT_FIELD];
}

function report(output) {
  return output.validation_report;
}

function expectRequiredFields(value, fields) {
  for (const field of fields) expect(value).toHaveProperty(field);
}

function recomputeRollupKey(output) {
  rollup(output).idempotency_key =
    killSwitchWiringReadinessRollupThroughPhase64IdempotencyKey(rollup(output));
}

function expectValidatorFails(output, checkId) {
  const validation = validateMiraCoreKillSwitchWiringReadinessRollupThroughPhase64Output(
    output,
    killSwitchWiringReadinessRollupThroughPhase64Contract,
  );
  expect(validation.ok).toBe(false);
  expect(validation.checks.some((entry) => entry.id === checkId && entry.ok === false)).toBe(true);
}

describe('mira core kill-switch wiring readiness rollup through Phase63 v0', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('satisfies Oracle output, manifest, and validation report shapes', () => {
    const output = build();

    expectRequiredFields(output, killSwitchWiringReadinessRollupThroughPhase64Contract.expectedOutputShape.requiredTopLevelFields);
    expect(killSwitchWiringReadinessRollupThroughPhase64Contract.expectedOutputShape.requiredTopLevelFields)
      .toEqual(REQUIRED_OUTPUT_FIELDS);
    expect(rollup(output).schema).toBe(KILL_SWITCH_WIRING_READINESS_ROLLUP_THROUGH_PHASE64_SCHEMA_VERSION);
    expect(rollup(output).version).toBe(0);
    expect(report(output).schema).toBe(VALIDATION_REPORT_SCHEMA_VERSION);
    expectRequiredFields(rollup(output), killSwitchWiringReadinessRollupThroughPhase64Contract.expectedManifestShape.requiredFields);
    expect(killSwitchWiringReadinessRollupThroughPhase64Contract.expectedManifestShape.requiredFields)
      .toEqual(REQUIRED_DRY_CHECK_FIELDS);
    expectRequiredFields(report(output), killSwitchWiringReadinessRollupThroughPhase64Contract.expectedValidationReportShape.requiredFields);
    expect(killSwitchWiringReadinessRollupThroughPhase64Contract.expectedValidationReportShape.requiredFields)
      .toEqual(REQUIRED_VALIDATION_REPORT_FIELDS);
    expect(report(output)).toEqual(expect.objectContaining({
      schema: killSwitchWiringReadinessRollupThroughPhase64Contract.expectedOutputShape.reportSchema,
      fixture_path: 'ui/__tests__/fixtures/mira-core-kill-switch-wiring-readiness-rollup-through-phase63-contract.json',
      baseline_commit: BASELINE_COMMIT,
      decision: 'accepted_validation_only',
      status: killSwitchWiringReadinessRollupThroughPhase64Contract.expectedValidationReportShape.requiredLiteralValues.status,
      caveats: [],
    }));
    expect(validateMiraCoreKillSwitchWiringReadinessRollupThroughPhase64Output(
      output,
      killSwitchWiringReadinessRollupThroughPhase64Contract,
    )).toEqual(expect.objectContaining({ ok: true }));
    expect(() => assertNoForbiddenOutput(output, killSwitchWiringReadinessRollupThroughPhase64Contract.forbiddenOutputSubstrings))
      .not.toThrow();
  });

  test('pins baseline 3e51f67, registries through Phase63, duplicate counts, and commit chain', () => {
    const current = rollup(build());
    const expected = killSwitchWiringReadinessRollupThroughPhase64Contract.phaseRegistryExpected;
    const counts = killSwitchWiringReadinessRollupThroughPhase64Contract.expectedCounts;

    expect(BASELINE_COMMIT).toBe(killSwitchWiringReadinessRollupThroughPhase64Contract.baseline.commit);
    expect(current.baseline_commit).toBe(BASELINE_COMMIT);
    expect(current.phase_registry).toEqual(expect.objectContaining({
      expected_phases: expected.expected_phases,
      current_through_phase: counts.phase_inventory_count,
      phase_inventory_count: counts.phase_inventory_count,
      schema_registry_count:
        killSwitchWiringReadinessRollupThroughPhase64Contract.expectedManifestShape
          .requiredLiteralValues['phase_registry.schema_registry_count'],
      cli_registry_count:
        killSwitchWiringReadinessRollupThroughPhase64Contract.expectedManifestShape
          .requiredLiteralValues['phase_registry.cli_registry_count'],
      phase52_current: true,
      phase52_readiness_rollup_validation_current: true,
      phase60_current: true,
      phase60_commit: expected.current_truth.phase60_commit,
      phase60_readiness_rollup_validation_current: true,
      phase61_current: true,
      phase61_commit: expected.current_truth.phase61_commit,
      phase61_readiness_rollup_validation_current: true,
      phase62_current: true,
      phase62_commit:
        killSwitchWiringReadinessRollupThroughPhase64Contract.expectedManifestShape
          .requiredLiteralValues['phase_registry.phase62_commit'],
      phase62_readiness_rollup_validation_current: true,
      phase62_duplicate_registry_count_closure_current: true,
      phase63_current: true,
      phase63_commit:
        killSwitchWiringReadinessRollupThroughPhase64Contract.expectedManifestShape
          .requiredLiteralValues['phase_registry.phase63_commit'],
      phase63_readiness_rollup_validation_current: true,
      phase63_duplicate_registry_count_closure_current: true,
    }));
    expect(current.schema_registry.count).toBe(counts.schema_registry_count);
    expect(current.cli_registry.count).toBe(counts.cli_registry_count);
    expect(current.phase_registry.schema_registry_count).toBe(63);
    expect(current.phase_registry.cli_registry_count).toBe(63);
    expect(current.schema_registry.entries).toHaveLength(counts.schema_registry_count);
    expect(current.cli_registry.entries).toHaveLength(counts.cli_registry_count);
    expect(current.commit_chain).toEqual(killSwitchWiringReadinessRollupThroughPhase64Contract.commitChainExpected);
    expect(current.commit_chain).toHaveLength(counts.commit_chain_count);
    expect(current.commit_chain[current.commit_chain.length - 1]).toBe(BASELINE_COMMIT);
  });

  test('preserves Phase63 source truth, stale truth, closure chain, and source refs', () => {
    const current = rollup(build());

    expect(current.source_recommendation).toEqual(expect.objectContaining(
      killSwitchWiringReadinessRollupThroughPhase64Contract.sourceRecommendation,
    ));
    expect(current.satisfied_prior_recommendations).toEqual(
      killSwitchWiringReadinessRollupThroughPhase64Contract.satisfiedPriorRecommendations,
    );
    expect(current.current_truth).toEqual(expect.objectContaining(
      killSwitchWiringReadinessRollupThroughPhase64Contract.currentTruthExpected,
    ));
    expect(current.current_truth).toEqual(expect.objectContaining({
      phase63_current: true,
      phase63_readiness_rollup_validation_current: true,
      kill_switch_wiring_readiness_rollup_through_phase63_remains_non_authorizing: true,
      phase63_duplicate_registry_count_closure_current: true,
    }));
    expect(current.stale_readiness).toEqual(expect.objectContaining(
      killSwitchWiringReadinessRollupThroughPhase64Contract.staleReadinessExpected,
    ));
    expect(current.phase34_prior_recommendations).toEqual(expect.objectContaining(
      killSwitchWiringReadinessRollupThroughPhase64Contract.phase34PriorRecommendationsExpected,
    ));
    expect(current.closure_summary).toEqual(expect.objectContaining(
      killSwitchWiringReadinessRollupThroughPhase64Contract.closureSummaryExpected,
    ));
    expect(current.closure_summary.phase63_scoped_status_closure_carried).toBe(true);
    expect(current.closure_summary.phase63_duplicate_registry_count_closure_carried).toBe(true);
    expect(current.source_refs).toEqual(killSwitchWiringReadinessRollupThroughPhase64Contract.sourceRefsExpected);
    expect(current.source_refs).toHaveLength(killSwitchWiringReadinessRollupThroughPhase64Contract.expectedCounts.source_ref_count);
    expect(current.source_refs.some((ref) => ref.artifact_id === 'phase63-kill-switch-wiring-readiness-rollup-through-phase62'))
      .toBe(true);
  });

  test('binds Phase49 boundary plus Phase50-63 readiness anchors without Phase63 hybrid output', () => {
    const current = rollup(build());

    expect(current.readiness_rollup_summary).toEqual(expect.objectContaining(
      killSwitchWiringReadinessRollupThroughPhase64Contract.readinessRollupSummaryExpected,
    ));
    expect(current.phase49_boundary_refresh_summary).toEqual(expect.objectContaining(
      killSwitchWiringReadinessRollupThroughPhase64Contract.phase49BoundaryRefreshSummaryExpected,
    ));
    for (const phase of [50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63]) {
      const field = `phase${phase}_readiness_rollup_summary`;
      const expectedField = `phase${phase}ReadinessRollupSummaryExpected`;
      expect(current[field]).toEqual(expect.objectContaining(
        killSwitchWiringReadinessRollupThroughPhase64Contract[expectedField],
      ));
      expect(current[field].validation_green).toBe(true);
    }
    expect(current.phase63_readiness_rollup_summary).toEqual(expect.objectContaining({
      committed_baseline: BASELINE_COMMIT,
      oracle_review_ref: 'ORACLE #288',
      scoped_status_closure:
        'scoped_phase63_through_phase62_files_only_bound_and_stale_phase56_phase58_phase59_phase60_phase61_phase62_rejected',
      duplicate_registry_count_closure:
        'phase_registry_schema_registry_count_and_cli_registry_count_bound_to_expectedCounts_63_in_phase64_with_phase63_closure_carried',
      phase22_caveat_out_of_scope_non_blocking: true,
      phase22_caveat_non_authorizing: true,
      remains_validation_only: true,
      remains_contract_only: true,
      no_output_file_written: true,
    }));
    expect(current).not.toHaveProperty(PHASE63_HYBRID_FIELD);
    expect(JSON.stringify(current)).not.toContain(PHASE63_HYBRID_CAMEL);
    expect(JSON.stringify(current)).not.toContain(PHASE63_HYBRID_SLUG);
  });

  test('preserves Phase22 caveat as non-authorizing and non-blocking only', () => {
    const current = rollup(build());

    expect(current.readiness_rollup_summary.phase22_date_sensitive_expiry_caveat)
      .toBe('non_authorizing_non_blocking_out_of_scope');
    expect(current.readiness_rollup_summary.phase22_caveat_authorizes_runtime).toBe(false);
    expect(current.readiness_rollup_summary.phase22_caveat_blocks_phase64_fixture).toBe(false);
    expect(current.phase63_readiness_rollup_summary.phase22_caveat_out_of_scope_non_blocking).toBe(true);
    expect(current.phase63_readiness_rollup_summary.phase22_caveat_non_authorizing).toBe(true);
    expect(current.readiness_rollup_summary).toEqual(expect.objectContaining({
      ready_for_runtime_now: false,
      ready_for_dry_run_now: false,
      ready_for_kill_switch_wiring_now: false,
      authorizes_runtime: false,
      authorizes_kill_switch_wiring: false,
      authorizes_output_file: false,
    }));
  });

  test('keeps runtime, flag reader, kill-switch, capability, proof, and side-effect boundaries false', () => {
    const current = rollup(build());

    expect(current.runtime_mode_boundary).toEqual(expect.objectContaining(
      killSwitchWiringReadinessRollupThroughPhase64Contract.runtimeModeBoundaryShapeExpected.requiredValues,
    ));
    expect(current.flag_reader_boundary).toEqual(expect.objectContaining(
      killSwitchWiringReadinessRollupThroughPhase64Contract.flagReaderBoundaryShapeExpected.requiredValues,
    ));
    expect(current.env_config_read_boundary).toEqual(expect.objectContaining(
      killSwitchWiringReadinessRollupThroughPhase64Contract.envConfigReadBoundaryShapeExpected.requiredValues,
    ));
    expect(current.kill_switch_boundary).toEqual(expect.objectContaining(
      killSwitchWiringReadinessRollupThroughPhase64Contract.killSwitchBoundaryShapeExpected.requiredValues,
    ));
    expect(current.kill_switch_wiring_boundary).toEqual(expect.objectContaining(
      killSwitchWiringReadinessRollupThroughPhase64Contract.killSwitchWiringBoundaryShapeExpected.requiredValues,
    ));
    expect(current.capability_matrix).toEqual(expect.objectContaining(
      killSwitchWiringReadinessRollupThroughPhase64Contract.capabilityMatrixExpected,
    ));
    expect(current.proof_boundaries).toEqual(expect.objectContaining(
      killSwitchWiringReadinessRollupThroughPhase64Contract.proofBoundaryExpected,
    ));
    expect(current.side_effect_result).toEqual(expect.objectContaining({
      no_runtime_performed: true,
      no_env_config_flag_read_performed: true,
      no_kill_switch_live_check_performed: true,
      no_noop_execution_performed: true,
      no_output_file_written: true,
      runtimeStarted: false,
      envRead: false,
      configRead: false,
      flagRead: false,
      killSwitchLiveCheckPerformed: false,
      outputFileWritten: false,
      output_file_write_attempts: 0,
    }));
  });

  test('emits validation report coverage, required literals, referenced paths, and current scoped key', () => {
    const output = build();
    const validation = validateMiraCoreKillSwitchWiringReadinessRollupThroughPhase64Output(
      output,
      killSwitchWiringReadinessRollupThroughPhase64Contract,
    );

    expect(report(output).static_rule_results)
      .toHaveLength(killSwitchWiringReadinessRollupThroughPhase64Contract.staticValidationRules.length);
    expect(report(output).acceptance_check_results)
      .toHaveLength(killSwitchWiringReadinessRollupThroughPhase64Contract.acceptanceChecks.length);
    expect(report(output).tamper_case_results)
      .toHaveLength(killSwitchWiringReadinessRollupThroughPhase64Contract.tamperCases.length);
    expect(report(output).required_literal_results.length)
      .toBeGreaterThanOrEqual(killSwitchWiringReadinessRollupThroughPhase64Contract.expectedCounts.required_literal_min_count);
    expect(report(output).referenced_path_results.every((entry) => entry.ok === true)).toBe(true);
    expect(report(output).scoped_status).toEqual(expect.objectContaining({
      only_fixture_changed_before_builder: true,
      [CURRENT_SCOPED_STATUS_KEY]: true,
      unrelated_files_untouched: true,
    }));
    expect(killSwitchWiringReadinessRollupThroughPhase64Contract.acceptanceChecks
      .some((entry) => entry.id === INHERITED_PHASE62_CURRENT_ACCEPT_ID)).toBe(false);
    expect(killSwitchWiringReadinessRollupThroughPhase64Contract.tamperCases
      .some((entry) => entry.id === INHERITED_PHASE62_CURRENT_TAMPER_ID)).toBe(false);
    for (const staleKey of STALE_SCOPED_STATUS_KEYS) {
      expect(report(output).scoped_status).not.toHaveProperty(staleKey);
    }
    expect(validation).toEqual(expect.objectContaining({ ok: true }));
  });

  test('validator rejects literal, baseline, registry count, and idempotency drift', () => {
    const cases = [
      ['required-literal-checks-bound', (output) => { rollup(output).baseline_commit = 'ef02359'; }],
      ['static-phase64-duplicate-registry-counts-bound', (output) => { rollup(output).phase_registry.schema_registry_count = 62; }],
      ['accept-phase64-duplicate-registry-count-closure-carried', (output) => { rollup(output).phase_registry.cli_registry_count = 62; }],
      ['required-literal-checks-bound', (output) => { rollup(output).phase_registry.phase63_commit = 'bogus'; }],
      ['refresh-contract-complete', (output) => { rollup(output).idempotency_key = 'stale'; }],
    ];

    for (const [checkId, mutate] of cases) {
      const output = clone(build());
      mutate(output);
      if (rollup(output).idempotency_key !== 'stale') {
        recomputeRollupKey(output);
      }
      expectValidatorFails(output, checkId);
    }
  });

  test('validator rejects Phase63 readiness, scoped closure, duplicate closure, source ref, and hybrid drift', () => {
    const cases = [
      ['accept-phase63-readiness-rollup-current', (output) => { rollup(output).phase63_readiness_rollup_summary.validation_green = false; }],
      ['accept-phase63-scoped-status-closure-carried', (output) => { rollup(output).phase63_readiness_rollup_summary.scoped_status_closure = 'missing'; }],
      ['accept-phase64-duplicate-registry-count-closure-carried', (output) => { rollup(output).phase63_readiness_rollup_summary.duplicate_registry_count_closure = 'missing'; }],
      ['refresh-contract-complete', (output) => {
        rollup(output).source_refs = rollup(output).source_refs
          .filter((ref) => ref.artifact_id !== 'phase63-kill-switch-wiring-readiness-rollup-through-phase62');
      }],
      ['refresh-contract-complete', (output) => { rollup(output)[PHASE63_HYBRID_FIELD] = { hybrid: true }; }],
    ];

    for (const [checkId, mutate] of cases) {
      const output = clone(build());
      mutate(output);
      recomputeRollupKey(output);
      expectValidatorFails(output, checkId);
    }
  });

  test('validator rejects Phase22 caveat overclaim and readiness authorization drift', () => {
    const cases = [
      ['accept-phase22-caveat-non-blocking-non-authorizing-through-phase64', (output) => {
        rollup(output).readiness_rollup_summary.phase22_caveat_blocks_phase64_fixture = true;
      }],
      ['accept-phase22-caveat-non-blocking-non-authorizing-through-phase64', (output) => {
        rollup(output).readiness_rollup_summary.phase22_caveat_authorizes_runtime = true;
      }],
      ['accept-readiness-rollup-contract-only', (output) => {
        rollup(output).readiness_rollup_summary.ready_for_kill_switch_wiring_now = true;
      }],
      ['accept-readiness-rollup-non-authorizing', (output) => {
        rollup(output).readiness_rollup_summary.authorizes_output_file = true;
      }],
    ];

    for (const [checkId, mutate] of cases) {
      const output = clone(build());
      mutate(output);
      recomputeRollupKey(output);
      expectValidatorFails(output, checkId);
    }
  });

  test('validator rejects stale scoped report keys and missing current scoped report key', () => {
    for (const staleKey of STALE_SCOPED_STATUS_KEYS) {
      const output = clone(build());
      report(output).scoped_status[staleKey] = true;
      expect(report(output).scoped_status[CURRENT_SCOPED_STATUS_KEY]).toBe(true);
      expectValidatorFails(output, 'validation-report-scoped-status-current');
      expectValidatorFails(output, 'validation-report-matches-contract');
    }

    const missingCurrent = clone(build());
    delete report(missingCurrent).scoped_status[CURRENT_SCOPED_STATUS_KEY];
    expectValidatorFails(missingCurrent, 'validation-report-scoped-status-current');
    expectValidatorFails(missingCurrent, 'validation-report-matches-contract');
  });

  test('validator rejects boundary, capability, proof, side-effect, and forbidden-output drift', () => {
    const cases = [
      ['accept-runtime-mode-default-off', (output) => { rollup(output).runtime_mode_boundary.disabled = false; }],
      ['accept-flag-reader-false', (output) => { rollup(output).flag_reader_boundary.flagReadNow = true; }],
      ['accept-no-env-read', (output) => { rollup(output).env_config_read_boundary.no_env_read = false; }],
      ['accept-kill-wired-false', (output) => { rollup(output).kill_switch_boundary.killWired = true; }],
      ['accept-wiring-available-false', (output) => { rollup(output).kill_switch_wiring_boundary.killSwitchWiringAvailable = true; }],
      ['accept-capability-false', (output) => { rollup(output).capability_matrix.serverCanExecuteLocal = true; }],
      ['accept-proof-boundaries-false', (output) => { rollup(output).proof_boundaries.socket_is_bridge_green = true; }],
      ['accept-side-effect-truth', (output) => {
        rollup(output).side_effect_result.no_output_file_written = false;
        rollup(output).side_effect_result.outputFileWritten = true;
      }],
      ['accept-forbidden-substrings', (output) => { rollup(output).redaction_summary.note = 'runtime started'; }],
    ];

    for (const [checkId, mutate] of cases) {
      const output = clone(build());
      mutate(output);
      recomputeRollupKey(output);
      expectValidatorFails(output, checkId);
    }
  });

  test('validator rejects unsafe action drift and Tier2+ recommendations after idempotency recompute', () => {
    for (const phrase of killSwitchWiringReadinessRollupThroughPhase64Contract.unsafeActionPhrases) {
      const output = clone(build());
      rollup(output).next_phase_recommendations[0].safe_next_action = `safe to ${phrase}`;
      recomputeRollupKey(output);
      expectValidatorFails(output, 'accept-unsafe-action-phrases');
    }

    const tier2 = clone(build());
    rollup(tier2).next_phase_recommendations[0].tier = 'tier2';
    recomputeRollupKey(tier2);
    expectValidatorFails(tier2, 'accept-next-recs-tier0-tier1');
  });

  test('validator rejects validation-report lies, missing tamper coverage, and literal result lies', () => {
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
    rollup(literalLie).baseline_commit = 'ef02359';
    recomputeRollupKey(literalLie);
    const literal = report(literalLie).required_literal_results.find((entry) => entry.path === 'baseline_commit');
    literal.actual = BASELINE_COMMIT;
    literal.ok = true;
    expectValidatorFails(literalLie, 'required-literal-checks-bound');
    expectValidatorFails(literalLie, 'validation-report-matches-contract');
  });

  test('CLI is stdout-only, consumes the Oracle fixture, and ignores output-file flags', () => {
    const parsed = parseArgs(['--pretty', '--out', 'ignored.json']);
    expect(parsed.pretty).toBe(true);
    expect(parsed.fixturePath).toContain('mira-core-kill-switch-wiring-readiness-rollup-through-phase63-contract.json');

    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const output = main(['--out=ignored.json'], JSON.stringify({
      profile: { name: 'main' },
      sessionId: 'session-cli',
      deviceId: 'VIGIL',
    }));

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(rollup(output).schema).toBe(KILL_SWITCH_WIRING_READINESS_ROLLUP_THROUGH_PHASE64_SCHEMA_VERSION);
    expect(rollup(output).sessionId).toBe('session-cli');
    expect(rollup(output).baseline_commit).toBe(BASELINE_COMMIT);
    expect(rollup(output).phase_registry.current_through_phase)
      .toBe(killSwitchWiringReadinessRollupThroughPhase64Contract.expectedCounts.phase_inventory_count);
    expect(rollup(output).schema_registry.count)
      .toBe(killSwitchWiringReadinessRollupThroughPhase64Contract.expectedCounts.schema_registry_count);
    expect(rollup(output).cli_registry.count)
      .toBe(killSwitchWiringReadinessRollupThroughPhase64Contract.expectedCounts.cli_registry_count);
    expect(rollup(output).phase_registry.schema_registry_count).toBe(63);
    expect(rollup(output).phase_registry.cli_registry_count).toBe(63);
    expect(rollup(output).commit_chain)
      .toHaveLength(killSwitchWiringReadinessRollupThroughPhase64Contract.expectedCounts.commit_chain_count);
    expect(rollup(output).source_refs)
      .toHaveLength(killSwitchWiringReadinessRollupThroughPhase64Contract.expectedCounts.source_ref_count);
    expect(rollup(output).phase63_readiness_rollup_summary.validation_green).toBe(true);
    expect(rollup(output).readiness_rollup_summary.phase22_caveat_blocks_phase64_fixture).toBe(false);
    expect(rollup(output)).not.toHaveProperty(PHASE63_HYBRID_FIELD);
    expect(rollup(output).noop_dry_check_items).toHaveLength(7);
    expect(rollup(output).blocked_future_slices).toHaveLength(5);
    expect(rollup(output).kill_switch_boundary.killWired).toBe(false);
    expect(rollup(output).kill_switch_wiring_boundary.killSwitchWiringAvailable).toBe(false);
    expect(rollup(output).capability_matrix.serverCanExecuteLocal).toBe(false);
    expect(rollup(output).side_effect_result.no_output_file_written).toBe(true);
    expect(report(output).scoped_status[CURRENT_SCOPED_STATUS_KEY]).toBe(true);
    expect(report(output).decision).toBe('accepted_validation_only');
    expect(validateMiraCoreKillSwitchWiringReadinessRollupThroughPhase64Output(
      output,
      killSwitchWiringReadinessRollupThroughPhase64Contract,
    )).toEqual(expect.objectContaining({ ok: true }));
  });
});
