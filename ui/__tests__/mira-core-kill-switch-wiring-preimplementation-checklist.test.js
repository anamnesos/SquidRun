const killSwitchWiringPreimplementationChecklistContract = require('./fixtures/mira-core-kill-switch-wiring-preimplementation-checklist-contract.json');
const {
  BASELINE_COMMIT,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_CHECKLIST_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  KILL_SWITCH_WIRING_PREIMPLEMENTATION_CHECKLIST_SCHEMA_VERSION,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreKillSwitchWiringPreimplementationChecklist,
  killSwitchWiringPreimplementationChecklistIdempotencyKey,
  validateMiraCoreKillSwitchWiringPreimplementationChecklistOutput,
} = require('../modules/mira-core/kill-switch-wiring-preimplementation-checklist');
const {
  main,
  parseArgs,
} = require('../scripts/hm-mira-core-kill-switch-wiring-preimplementation-checklist');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function build(inputSignals = {}) {
  return buildMiraCoreKillSwitchWiringPreimplementationChecklist({
    contract: killSwitchWiringPreimplementationChecklistContract,
    inputSignals,
    nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
  });
}

function checklist(output) {
  return output.kill_switch_wiring_preimplementation_checklist;
}

function report(output) {
  return output.validation_report;
}

function expectRequiredFields(value, fields) {
  for (const field of fields) expect(value).toHaveProperty(field);
}

function recomputeChecklistKey(output) {
  checklist(output).idempotency_key =
    killSwitchWiringPreimplementationChecklistIdempotencyKey(checklist(output));
}

function expectValidatorFails(output, checkId) {
  const validation = validateMiraCoreKillSwitchWiringPreimplementationChecklistOutput(
    output,
    killSwitchWiringPreimplementationChecklistContract,
  );
  expect(validation.ok).toBe(false);
  expect(validation.checks.some((entry) => entry.id === checkId && entry.ok === false)).toBe(true);
}

describe('mira core kill-switch wiring preimplementation checklist v0', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('satisfies Oracle output, manifest, and validation report shapes', () => {
    const output = build();

    expectRequiredFields(output, killSwitchWiringPreimplementationChecklistContract.expectedOutputShape.requiredTopLevelFields);
    expect(killSwitchWiringPreimplementationChecklistContract.expectedOutputShape.requiredTopLevelFields)
      .toEqual(REQUIRED_OUTPUT_FIELDS);
    expect(checklist(output).schema).toBe(KILL_SWITCH_WIRING_PREIMPLEMENTATION_CHECKLIST_SCHEMA_VERSION);
    expect(checklist(output).version).toBe(0);
    expect(report(output).schema).toBe(VALIDATION_REPORT_SCHEMA_VERSION);
    expectRequiredFields(checklist(output), killSwitchWiringPreimplementationChecklistContract.expectedManifestShape.requiredFields);
    expect(killSwitchWiringPreimplementationChecklistContract.expectedManifestShape.requiredFields)
      .toEqual(REQUIRED_CHECKLIST_FIELDS);
    expectRequiredFields(report(output), killSwitchWiringPreimplementationChecklistContract.expectedValidationReportShape.requiredFields);
    expect(killSwitchWiringPreimplementationChecklistContract.expectedValidationReportShape.requiredFields)
      .toEqual(REQUIRED_VALIDATION_REPORT_FIELDS);
    expect(report(output)).toEqual(expect.objectContaining({
      decision: 'accepted_validation_only',
      status: 'fixture_contract_only',
      caveats: [],
    }));
    expect(validateMiraCoreKillSwitchWiringPreimplementationChecklistOutput(output, killSwitchWiringPreimplementationChecklistContract))
      .toEqual(expect.objectContaining({ ok: true }));
    expect(() => assertNoForbiddenOutput(output, killSwitchWiringPreimplementationChecklistContract.forbiddenOutputSubstrings))
      .not.toThrow();
  });

  test('pins baseline bbf6e9f, registries through Phase 46, and exact commit chain', () => {
    const current = checklist(build());
    const expected = killSwitchWiringPreimplementationChecklistContract.phaseRegistryExpected;

    expect(BASELINE_COMMIT).toBe(killSwitchWiringPreimplementationChecklistContract.baseline.commit);
    expect(current.baseline_commit).toBe(BASELINE_COMMIT);
    expect(current.phase_registry).toEqual(expect.objectContaining({
      current_through_phase: 46,
      expected_phases: expected.expected_phases,
      phase_inventory_count: 46,
      phase35_current: true,
      phase46_current: true,
      phase46_commit: BASELINE_COMMIT,
    }));
    expect(current.phase_registry.phase46_delta).toEqual(expect.objectContaining(expected.phase46_delta));
    expect(current.schema_registry.count).toBe(46);
    expect(current.cli_registry.count).toBe(46);
    expect(current.schema_registry.entries).toHaveLength(46);
    expect(current.cli_registry.entries).toHaveLength(46);
    expect(current.commit_chain).toEqual(killSwitchWiringPreimplementationChecklistContract.commitChainExpected);
    expect(current.commit_chain).toHaveLength(34);
    expect(current.commit_chain[current.commit_chain.length - 1]).toBe(BASELINE_COMMIT);
  });

  test('preserves source recommendation, satisfied Phase46 work, stale truth, closures, and source refs', () => {
    const current = checklist(build());

    expect(current.source_recommendation).toEqual(expect.objectContaining(
      killSwitchWiringPreimplementationChecklistContract.sourceRecommendation,
    ));
    expect(current.satisfied_prior_recommendations).toEqual(
      killSwitchWiringPreimplementationChecklistContract.satisfiedPriorRecommendations,
    );
    expect(current.current_truth).toEqual(expect.objectContaining({
      phase35_current: true,
      phase46_current: true,
      kill_switch_wiring_preimplementation_checklist_remains_non_authorizing: true,
      no_env_config_flag_read_now: true,
      kill_switch_remains_unwired: true,
    }));
    expect(current.stale_readiness).toEqual(expect.objectContaining({
      phase13_stale: true,
      phase23_stale: true,
      phase31_stale: true,
    }));
    expect(current.phase34_prior_recommendations.satisfied_and_not_reopened).toBe(true);
    expect(current.closure_summary.closed_review_refs).toContain('ORACLE #182');
    expect(current.source_refs).toEqual(killSwitchWiringPreimplementationChecklistContract.sourceRefsExpected);
    expect(current.source_refs).toHaveLength(16);
    expect(current.source_refs.some((ref) => ref.artifact_id === 'phase46-kill-switch-wiring-readiness-gap'))
      .toBe(true);
  });

  test('defines checklist summary plus disabled runtime, flag-reader, env/config, kill-switch, and wiring boundaries', () => {
    const current = checklist(build());

    expect(current.preimplementation_checklist_summary).toEqual(expect.objectContaining(
      killSwitchWiringPreimplementationChecklistContract.preimplementationChecklistSummaryExpected,
    ));
    expect(current.preimplementation_checklist_summary).toEqual(expect.objectContaining({
      decision: 'remain_preimplementation_checklist_contract_only',
      status: 'blocked_unimplemented_unwired_non_authorizing',
      checklist_count: 8,
      ready_for_runtime_now: false,
      ready_for_dry_run_now: false,
      ready_for_kill_switch_wiring_now: false,
    }));

    for (const [field, shape] of [
      ['runtime_mode_boundary', killSwitchWiringPreimplementationChecklistContract.runtimeModeBoundaryShapeExpected],
      ['flag_reader_boundary', killSwitchWiringPreimplementationChecklistContract.flagReaderBoundaryShapeExpected],
      ['env_config_read_boundary', killSwitchWiringPreimplementationChecklistContract.envConfigReadBoundaryShapeExpected],
      ['kill_switch_boundary', killSwitchWiringPreimplementationChecklistContract.killSwitchBoundaryShapeExpected],
      ['kill_switch_wiring_boundary', killSwitchWiringPreimplementationChecklistContract.killSwitchWiringBoundaryShapeExpected],
    ]) {
      expect(current[field]).toEqual(expect.objectContaining(shape.requiredValues));
    }

    expect(current.kill_switch_boundary).toEqual(expect.objectContaining({
      visible: true,
      fail_closed: true,
      unwired: true,
      unimplemented: true,
      killWired: false,
      liveCheck: false,
      bypass: false,
      allow_open: false,
    }));
    expect(current.kill_switch_wiring_boundary).toEqual(expect.objectContaining({
      future_live_kill_switch_wiring_slice_blocked_now: true,
      killSwitchWiringAvailable: false,
      wiringImplemented: false,
      wiringAuthorized: false,
      non_authorizing: true,
    }));
  });

  test('keeps prerequisite gaps, readiness gaps, checklist items, and future slices blocked', () => {
    const current = checklist(build());

    expect(current.prerequisite_gap_matrix).toEqual(expect.arrayContaining(
      killSwitchWiringPreimplementationChecklistContract.prerequisiteGapMatrixExpected
        .map((item) => expect.objectContaining(item)),
    ));
    expect(current.prerequisite_gap_matrix).toHaveLength(2);
    expect(current.readiness_gap_matrix).toEqual(expect.arrayContaining(
      killSwitchWiringPreimplementationChecklistContract.readinessGapMatrixExpected
        .map((item) => expect.objectContaining(item)),
    ));
    expect(current.readiness_gap_matrix).toHaveLength(6);
    expect(current.checklist_items).toEqual(expect.arrayContaining(
      killSwitchWiringPreimplementationChecklistContract.checklistItemsExpected
        .map((item) => expect.objectContaining(item)),
    ));
    expect(current.checklist_items).toHaveLength(8);
    expect(current.checklist_items.every((item) => (
      item.status === 'required_unsatisfied_blocking_non_authorizing'
      && item.satisfied_now === false
      && item.blocks_kill_switch_wiring_now === true
      && item.authorizes_kill_switch_wiring === false
    ))).toBe(true);
    expect(current.blocked_future_slices).toEqual(expect.arrayContaining(
      killSwitchWiringPreimplementationChecklistContract.blockedFutureSlicesExpected
        .map((slice) => expect.objectContaining(slice)),
    ));
    expect(current.blocked_future_slices).toHaveLength(4);
  });

  test('preserves capability, proof, boundary, redaction, and no-side-effect truth', () => {
    const output = build();
    const current = checklist(output);

    expect(current.capability_matrix).toEqual(expect.objectContaining(
      killSwitchWiringPreimplementationChecklistContract.capabilityMatrixExpected,
    ));
    expect(current.proof_boundaries).toEqual(expect.objectContaining(
      killSwitchWiringPreimplementationChecklistContract.proofBoundaryExpected,
    ));
    expect(current.boundary_truth).toEqual(expect.objectContaining({
      no_runtime_server_listener_routes: true,
      no_ui_browser_window_capture: true,
      no_network: true,
      no_db_store_file_migration_write: true,
      no_queue_or_lease: true,
      no_env_config_flag_read: true,
      no_auth_key_secret: true,
      no_local_execution_shell_pty: true,
      no_control_execution_or_reporting_sink: true,
      no_send_deploy_trade: true,
      no_output_file: true,
    }));
    expect(current.redaction_summary).toEqual(expect.objectContaining({
      raw_private_content_exported: false,
      secret_material_exported: false,
      raw_config_exported: false,
    }));
    for (const field of Object.keys(killSwitchWiringPreimplementationChecklistContract.sideEffectTruthExpected)) {
      expect(current.side_effect_result[field]).toBe(true);
      expect(report(output).side_effect_truth[field]).toBe(true);
    }
    expect(current.side_effect_result.outputFileWritten).toBe(false);
    expect(current.side_effect_result.controlExecutionPerformed).toBe(false);
    expect(current.side_effect_result.reportingSinkWritten).toBe(false);
  });

  test('next recommendations are fixture-owned Tier0/Tier1 and non-authorizing', () => {
    const current = checklist(build());

    expect(current.next_phase_recommendations).toHaveLength(
      killSwitchWiringPreimplementationChecklistContract.nextRecommendationExpectedCandidates.length,
    );
    expect(current.next_phase_recommendations).toEqual(expect.arrayContaining(
      killSwitchWiringPreimplementationChecklistContract.nextRecommendationExpectedCandidates
        .map((candidate) => expect.objectContaining(candidate)),
    ));
    expect(current.next_phase_recommendations.map((item) => item.recommendation_id))
      .not.toContain(current.satisfied_prior_recommendations[0].recommendation_id);
    for (const recommendation of current.next_phase_recommendations) {
      expect(['tier0', 'tier1']).toContain(recommendation.tier);
      expect(recommendation.does_not_authorize_runtime).toBe(true);
      expect(recommendation.does_not_authorize_execution).toBe(true);
      expect(recommendation.does_not_authorize_kill_switch_wiring).toBe(true);
      expect(recommendation.does_not_authorize_output_files).toBe(true);
    }
  });

  test('validation report binds static rules, acceptance checks, tamper cases, literals, and paths', () => {
    const output = build();
    const validation = validateMiraCoreKillSwitchWiringPreimplementationChecklistOutput(
      output,
      killSwitchWiringPreimplementationChecklistContract,
    );

    expect(validation.ok).toBe(true);
    expect(report(output).static_rule_results.map((entry) => entry.id))
      .toEqual(killSwitchWiringPreimplementationChecklistContract.staticValidationRules.map((entry) => entry.id));
    expect(report(output).acceptance_check_results.map((entry) => entry.id))
      .toEqual(killSwitchWiringPreimplementationChecklistContract.acceptanceChecks.map((entry) => entry.id));
    expect(report(output).tamper_case_results).toHaveLength(killSwitchWiringPreimplementationChecklistContract.tamperCases.length);
    expect(report(output).tamper_case_results.length).toBeGreaterThanOrEqual(
      killSwitchWiringPreimplementationChecklistContract.expectedCounts.tamper_case_min_count,
    );
    expect(report(output).required_literal_results.length).toBeGreaterThanOrEqual(
      killSwitchWiringPreimplementationChecklistContract.expectedCounts.required_literal_min_count,
    );
    expect(report(output).required_literal_results.every((entry) => entry.ok)).toBe(true);
    expect(report(output).referenced_path_results.every((entry) => entry.ok)).toBe(true);
    expect(report(output).forbidden_output_scan.ok).toBe(true);
    expect(report(output).unsafe_action_scan.ok).toBe(true);
  });

  test('idempotency is stable for equivalent input and sensitive to scope and checklist facts', () => {
    const first = checklist(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'VIGIL' }));
    const second = checklist(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'VIGIL' }));
    const changedDevice = checklist(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'ALT' }));
    const changedProfile = checklist(build({ profile: { name: 'side' }, sessionId: 'session-a', deviceId: 'VIGIL' }));

    expect(first.idempotency_key).toBe(second.idempotency_key);
    expect(first.checklist_id).toBe(second.checklist_id);
    expect(first.idempotency_key).not.toBe(changedDevice.idempotency_key);
    expect(first.idempotency_key).not.toBe(changedProfile.idempotency_key);

    const tampered = clone(build());
    const originalKey = checklist(tampered).idempotency_key;
    checklist(tampered).checklist_items[0].satisfied_now = true;
    recomputeChecklistKey(tampered);
    expect(checklist(tampered).idempotency_key).not.toBe(originalKey);
    expectValidatorFails(tampered, 'accept-checklist-all-unsatisfied');
  });

  test('validator rejects baseline, registry, source, stale, closure, source-ref, and path drift', () => {
    const cases = [
      ['accept-schema-baseline-bbf6e9f', (output) => { checklist(output).baseline_commit = '62fa3a8'; }],
      ['accept-registries-46-46-46', (output) => { checklist(output).phase_registry.phase_inventory_count = 45; }],
      ['accept-registries-46-46-46', (output) => { checklist(output).schema_registry.count = 45; }],
      ['accept-registries-46-46-46', (output) => { checklist(output).cli_registry.count = 45; }],
      ['accept-commit-chain-34-ending-bbf6e9f', (output) => { checklist(output).commit_chain.pop(); }],
      ['accept-phase46-validator-satisfied', (output) => { checklist(output).satisfied_prior_recommendations[0].status = 'open'; }],
      ['accept-phase47-checklist-selected', (output) => { checklist(output).source_recommendation.recommendation_id = 'wrong'; }],
      ['accept-phase35-through-46-current', (output) => { checklist(output).current_truth.phase35_current = false; }],
      ['accept-phase35-through-46-current', (output) => { checklist(output).phase_registry.phase46_current = false; }],
      ['accept-stale-phase13-23-31', (output) => { checklist(output).stale_readiness.phase23_stale = false; }],
      ['accept-oracle-closure-through-182', (output) => { checklist(output).closure_summary.oracle_182_phase46_review_closure_carried = false; }],
    ];

    for (const [checkId, mutate] of cases) {
      const output = clone(build());
      mutate(output);
      recomputeChecklistKey(output);
      expectValidatorFails(output, checkId);
    }

    const pathLie = clone(build());
    report(pathLie).referenced_path_results[0].exists = false;
    report(pathLie).referenced_path_results[0].ok = false;
    expectValidatorFails(pathLie, 'referenced-path-results-complete');
  });

  test('validator rejects runtime, flag-reader, env/config, kill-switch, and wiring boundary drift', () => {
    const cases = [
      ['accept-runtime-mode-default-off', (output) => { checklist(output).runtime_mode_boundary.disabled = false; }],
      ['accept-runtime-mode-unimplemented', (output) => { checklist(output).runtime_mode_boundary.implemented = true; }],
      ['accept-runtime-mode-non-authorizing', (output) => { checklist(output).runtime_mode_boundary.authorizes_runtime = true; }],
      ['accept-flag-reader-false', (output) => { checklist(output).flag_reader_boundary.flagReader = true; }],
      ['accept-no-env-read', (output) => { checklist(output).env_config_read_boundary.no_env_read = false; }],
      ['accept-no-config-read', (output) => { checklist(output).env_config_read_boundary.no_config_read = false; }],
      ['accept-no-flag-read', (output) => { checklist(output).env_config_read_boundary.no_flag_read = false; }],
      ['accept-no-process-env-read', (output) => { checklist(output).env_config_read_boundary.no_process_env_read = false; }],
      ['accept-no-secret-read', (output) => { checklist(output).env_config_read_boundary.no_secret_read = false; }],
      ['accept-no-raw-config-export', (output) => { checklist(output).env_config_read_boundary.no_raw_config_export = false; }],
      ['accept-kill-switch-visible-fail-closed', (output) => { checklist(output).kill_switch_boundary.fail_closed = false; }],
      ['accept-kill-wired-false', (output) => { checklist(output).kill_switch_boundary.killWired = true; }],
      ['accept-live-check-false', (output) => { checklist(output).kill_switch_boundary.liveCheck = true; }],
      ['accept-bypass-false', (output) => { checklist(output).kill_switch_boundary.bypass = true; }],
      ['accept-allow-open-false', (output) => { checklist(output).kill_switch_boundary.allow_open = true; }],
      ['accept-wiring-available-false', (output) => { checklist(output).kill_switch_wiring_boundary.killSwitchWiringAvailable = true; }],
      ['accept-wiring-implemented-false', (output) => { checklist(output).kill_switch_wiring_boundary.wiringImplemented = true; }],
      ['accept-wiring-authorized-false', (output) => { checklist(output).kill_switch_wiring_boundary.wiringAuthorized = true; }],
    ];

    for (const [checkId, mutate] of cases) {
      const output = clone(build());
      mutate(output);
      recomputeChecklistKey(output);
      expectValidatorFails(output, checkId);
    }
  });

  test('validator rejects prerequisite/readiness/checklist item and blocked-slice drift', () => {
    const cases = [
      ['accept-prerequisite-gaps-two', (output) => { checklist(output).prerequisite_gap_matrix.pop(); }],
      ['accept-prerequisite-gaps-unsatisfied', (output) => { checklist(output).prerequisite_gap_matrix[0].satisfied_now = true; }],
      ['accept-readiness-gaps-six', (output) => { checklist(output).readiness_gap_matrix.pop(); }],
      ['accept-readiness-gaps-unsatisfied', (output) => { checklist(output).readiness_gap_matrix[0].satisfied_now = true; }],
      ['accept-checklist-eight', (output) => { checklist(output).checklist_items.pop(); }],
      ['accept-checklist-all-unsatisfied', (output) => { checklist(output).checklist_items[0].satisfied_now = true; }],
      ['accept-checklist-all-unsatisfied', (output) => { checklist(output).checklist_items[0].authorizes_kill_switch_wiring = true; }],
      ['accept-blocked-future-slices-four', (output) => { checklist(output).blocked_future_slices.pop(); }],
      ['accept-blocked-future-slices-four', (output) => { checklist(output).blocked_future_slices[0].implementation_allowed_now = true; }],
    ];

    for (const [checkId, mutate] of cases) {
      const output = clone(build());
      mutate(output);
      recomputeChecklistKey(output);
      expectValidatorFails(output, checkId);
    }
  });

  test('validator rejects capability, proof, side-effect, and redaction overclaims', () => {
    const cases = [
      ['accept-capability-false', (output) => { checklist(output).capability_matrix.runtimeStarted = true; }],
      ['accept-capability-false', (output) => { checklist(output).capability_matrix.serverCanExecuteLocal = true; }],
      ['accept-capability-false', (output) => { checklist(output).capability_matrix.killSwitchWiringAvailable = true; }],
      ['accept-direct-targets-blocked', (output) => {
        checklist(output).capability_matrix.directBuilderOracleServerTargetsBlocked = false;
        checklist(output).proof_boundaries.builder_oracle_direct_server_target_allowed = true;
      }],
      ['accept-proof-boundaries-false', (output) => { checklist(output).proof_boundaries.phase46_commit_is_runtime_proof = true; }],
      ['accept-proof-boundaries-false', (output) => {
        checklist(output).proof_boundaries.kill_switch_wiring_preimplementation_checklist_is_runtime_authorization = true;
      }],
      ['accept-side-effect-truth', (output) => {
        checklist(output).side_effect_result.no_output_file_written = false;
        checklist(output).side_effect_result.outputFileWritten = true;
      }],
      ['accept-side-effect-truth', (output) => {
        checklist(output).boundary_truth.no_control_execution_or_reporting_sink = false;
        checklist(output).side_effect_result.reportingSinkWritten = true;
      }],
      ['accept-forbidden-substrings', (output) => { checklist(output).redaction_summary.note = 'runtime started'; }],
    ];

    for (const [checkId, mutate] of cases) {
      const output = clone(build());
      mutate(output);
      recomputeChecklistKey(output);
      expectValidatorFails(output, checkId);
    }
  });

  test('validator rejects unsafe next-action drift and Tier2+ recommendations after idempotency recompute', () => {
    const unsafePhrases = [
      'send email to customer',
      'email a client',
      'message the client',
      'deploy',
      'trade',
      'write output file',
      'create queue',
      'create lease',
      'local shell',
      'run pty',
    ];

    for (const phrase of unsafePhrases) {
      const output = clone(build());
      checklist(output).next_phase_recommendations[0].safe_next_action = `safe to ${phrase}`;
      recomputeChecklistKey(output);
      expectValidatorFails(output, 'accept-unsafe-action-phrases');
    }

    const tier2 = clone(build());
    checklist(tier2).next_phase_recommendations[0].tier = 'tier2';
    recomputeChecklistKey(tier2);
    expectValidatorFails(tier2, 'accept-next-recs-tier0-tier1');
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
    checklist(literalLie).baseline_commit = '62fa3a8';
    recomputeChecklistKey(literalLie);
    const literal = report(literalLie).required_literal_results.find((entry) => entry.path === 'baseline_commit');
    literal.actual = BASELINE_COMMIT;
    literal.ok = true;
    expectValidatorFails(literalLie, 'required-literal-checks-bound');
    expectValidatorFails(literalLie, 'validation-report-matches-contract');
  });

  test('CLI is stdout-only, consumes the Oracle fixture, and ignores output-file flags', () => {
    const parsed = parseArgs(['--pretty', '--out', 'ignored.json']);
    expect(parsed.pretty).toBe(true);
    expect(parsed.fixturePath).toContain('mira-core-kill-switch-wiring-preimplementation-checklist-contract.json');

    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const output = main(['--out=ignored.json'], JSON.stringify({
      profile: { name: 'main' },
      sessionId: 'session-cli',
      deviceId: 'VIGIL',
    }));

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(checklist(output).schema).toBe(KILL_SWITCH_WIRING_PREIMPLEMENTATION_CHECKLIST_SCHEMA_VERSION);
    expect(checklist(output).sessionId).toBe('session-cli');
    expect(checklist(output).baseline_commit).toBe(BASELINE_COMMIT);
    expect(checklist(output).phase_registry.current_through_phase).toBe(46);
    expect(checklist(output).schema_registry.count).toBe(46);
    expect(checklist(output).cli_registry.count).toBe(46);
    expect(checklist(output).commit_chain).toHaveLength(34);
    expect(checklist(output).source_refs).toHaveLength(16);
    expect(checklist(output).prerequisite_gap_matrix).toHaveLength(2);
    expect(checklist(output).readiness_gap_matrix).toHaveLength(6);
    expect(checklist(output).checklist_items).toHaveLength(8);
    expect(checklist(output).blocked_future_slices).toHaveLength(4);
    expect(checklist(output).preimplementation_checklist_summary.ready_for_kill_switch_wiring_now).toBe(false);
    expect(checklist(output).kill_switch_boundary.killWired).toBe(false);
    expect(checklist(output).kill_switch_wiring_boundary.killSwitchWiringAvailable).toBe(false);
    expect(checklist(output).capability_matrix.serverCanExecuteLocal).toBe(false);
    expect(checklist(output).side_effect_result.no_output_file_written).toBe(true);
    expect(report(output).decision).toBe('accepted_validation_only');
    expect(validateMiraCoreKillSwitchWiringPreimplementationChecklistOutput(
      output,
      killSwitchWiringPreimplementationChecklistContract,
    )).toEqual(expect.objectContaining({ ok: true }));
  });
});
