const killSwitchWiringNoopBoundaryRefreshContract = require('./fixtures/mira-core-kill-switch-wiring-noop-boundary-refresh-contract.json');
const {
  BASELINE_COMMIT,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_DRY_CHECK_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  KILL_SWITCH_WIRING_NOOP_BOUNDARY_REFRESH_SCHEMA_VERSION,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreKillSwitchWiringNoopBoundaryRefresh,
  killSwitchWiringNoopBoundaryRefreshIdempotencyKey,
  validateMiraCoreKillSwitchWiringNoopBoundaryRefreshOutput,
} = require('../modules/mira-core/kill-switch-wiring-noop-boundary-refresh');
const {
  main,
  parseArgs,
} = require('../scripts/hm-mira-core-kill-switch-wiring-noop-boundary-refresh');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function build(inputSignals = {}) {
  return buildMiraCoreKillSwitchWiringNoopBoundaryRefresh({
    contract: killSwitchWiringNoopBoundaryRefreshContract,
    inputSignals,
    nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
  });
}

function dryCheck(output) {
  return output.kill_switch_wiring_noop_boundary_refresh;
}

function report(output) {
  return output.validation_report;
}

function expectRequiredFields(value, fields) {
  for (const field of fields) expect(value).toHaveProperty(field);
}

function recomputeDryCheckKey(output) {
  dryCheck(output).idempotency_key =
    killSwitchWiringNoopBoundaryRefreshIdempotencyKey(dryCheck(output));
}

function expectValidatorFails(output, checkId) {
  const validation = validateMiraCoreKillSwitchWiringNoopBoundaryRefreshOutput(
    output,
    killSwitchWiringNoopBoundaryRefreshContract,
  );
  expect(validation.ok).toBe(false);
  expect(validation.checks.some((entry) => entry.id === checkId && entry.ok === false)).toBe(true);
}

describe('mira core kill-switch wiring no-op boundary refresh v0', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('satisfies Oracle output, manifest, and validation report shapes', () => {
    const output = build();

    expectRequiredFields(output, killSwitchWiringNoopBoundaryRefreshContract.expectedOutputShape.requiredTopLevelFields);
    expect(killSwitchWiringNoopBoundaryRefreshContract.expectedOutputShape.requiredTopLevelFields)
      .toEqual(REQUIRED_OUTPUT_FIELDS);
    expect(dryCheck(output).schema).toBe(KILL_SWITCH_WIRING_NOOP_BOUNDARY_REFRESH_SCHEMA_VERSION);
    expect(dryCheck(output).version).toBe(0);
    expect(report(output).schema).toBe(VALIDATION_REPORT_SCHEMA_VERSION);
    expectRequiredFields(dryCheck(output), killSwitchWiringNoopBoundaryRefreshContract.expectedManifestShape.requiredFields);
    expect(killSwitchWiringNoopBoundaryRefreshContract.expectedManifestShape.requiredFields)
      .toEqual(REQUIRED_DRY_CHECK_FIELDS);
    expectRequiredFields(report(output), killSwitchWiringNoopBoundaryRefreshContract.expectedValidationReportShape.requiredFields);
    expect(killSwitchWiringNoopBoundaryRefreshContract.expectedValidationReportShape.requiredFields)
      .toEqual(REQUIRED_VALIDATION_REPORT_FIELDS);
    expect(report(output)).toEqual(expect.objectContaining({
      decision: 'accepted_validation_only',
      status: 'fixture_contract_only',
      caveats: [],
    }));
    expect(validateMiraCoreKillSwitchWiringNoopBoundaryRefreshOutput(output, killSwitchWiringNoopBoundaryRefreshContract))
      .toEqual(expect.objectContaining({ ok: true }));
    expect(() => assertNoForbiddenOutput(output, killSwitchWiringNoopBoundaryRefreshContract.forbiddenOutputSubstrings))
      .not.toThrow();
  });

  test('pins baseline d57e546, registries through Phase 48, and exact commit chain', () => {
    const current = dryCheck(build());
    const expected = killSwitchWiringNoopBoundaryRefreshContract.phaseRegistryExpected;

    expect(BASELINE_COMMIT).toBe(killSwitchWiringNoopBoundaryRefreshContract.baseline.commit);
    expect(current.baseline_commit).toBe(BASELINE_COMMIT);
    expect(current.phase_registry).toEqual(expect.objectContaining({
      expected_phases: expected.expected_phases,
      current_through_phase: 48,
      phase_inventory_count: 48,
      phase35_current: true,
      phase48_current: true,
      phase48_commit: BASELINE_COMMIT,
    }));
    expect(current.phase_registry.phase48_delta).toEqual(expect.objectContaining(expected.phase48_delta));
    expect(current.schema_registry.count).toBe(48);
    expect(current.cli_registry.count).toBe(48);
    expect(current.schema_registry.entries).toHaveLength(48);
    expect(current.cli_registry.entries).toHaveLength(48);
    expect(current.commit_chain).toEqual(killSwitchWiringNoopBoundaryRefreshContract.commitChainExpected);
    expect(current.commit_chain).toHaveLength(36);
    expect(current.commit_chain[current.commit_chain.length - 1]).toBe(BASELINE_COMMIT);
  });

  test('preserves source recommendation, satisfied Phase48 work, stale truth, closures, and source refs', () => {
    const current = dryCheck(build());

    expect(current.source_recommendation).toEqual(expect.objectContaining(
      killSwitchWiringNoopBoundaryRefreshContract.sourceRecommendation,
    ));
    expect(current.satisfied_prior_recommendations).toEqual(
      killSwitchWiringNoopBoundaryRefreshContract.satisfiedPriorRecommendations,
    );
    expect(current.current_truth).toEqual(expect.objectContaining({
      phase35_current: true,
      phase48_current: true,
      kill_switch_wiring_noop_boundary_refresh_remains_non_authorizing: true,
      noop_dry_check_remains_contract_only: true,
      no_env_config_flag_read_now: true,
      kill_switch_remains_unwired: true,
    }));
    expect(current.stale_readiness).toEqual(expect.objectContaining({
      phase13_stale: true,
      phase23_stale: true,
      phase31_stale: true,
    }));
    expect(current.phase34_prior_recommendations.satisfied_and_not_reopened).toBe(true);
    expect(current.closure_summary.closed_review_refs).toContain('ORACLE #190');
    expect(current.source_refs).toEqual(killSwitchWiringNoopBoundaryRefreshContract.sourceRefsExpected);
    expect(current.source_refs).toHaveLength(18);
    expect(current.source_refs.some((ref) => ref.artifact_id === 'phase48-kill-switch-wiring-noop-dry-check'))
      .toBe(true);
  });

  test('defines no-op boundary refresh status plus request/result contracts without reads, wiring, live checks, or output files', () => {
    const current = dryCheck(build());

    expect(current.noop_boundary_refresh_summary).toEqual(expect.objectContaining(
      killSwitchWiringNoopBoundaryRefreshContract.noopBoundaryRefreshSummaryExpected,
    ));
    expect(current.noop_boundary_status).toEqual(expect.objectContaining(
      killSwitchWiringNoopBoundaryRefreshContract.noopBoundaryStatusExpected,
    ));
    expect(current.noop_dry_check_request_contract).toEqual(expect.objectContaining(
      killSwitchWiringNoopBoundaryRefreshContract.noopDryCheckRequestContractExpected,
    ));
    expect(current.noop_dry_check_result_contract).toEqual(expect.objectContaining(
      killSwitchWiringNoopBoundaryRefreshContract.noopDryCheckResultContractExpected,
    ));
    expect(current.noop_boundary_refresh_summary).toEqual(expect.objectContaining({
      decision: 'remain_noop_boundary_refresh_contract_only',
      boundary_refresh_item_count: 8,
      ready_for_runtime_now: false,
      ready_for_dry_run_now: false,
      ready_for_kill_switch_wiring_now: false,
      noop_would_read_flag: false,
      noop_would_execute: false,
      noop_would_wire_kill_switch: false,
      noop_would_perform_live_check: false,
      noop_would_emit_output_file: false,
    }));
    expect(current.noop_boundary_status).toEqual(expect.objectContaining({
      contract_only: true,
      reference_only: true,
      request_reads_allowed: false,
      noop_execution_allowed: false,
      live_check_allowed: false,
      output_file_allowed: false,
      authorizes_runtime: false,
      authorizes_kill_switch_wiring: false,
    }));
    expect(current.noop_dry_check_request_contract).toEqual(expect.objectContaining({
      no_env_config_flag_read: true,
      no_live_kill_switch_check: true,
      no_control_or_reporting_sink: true,
      no_output_file: true,
      authorizes_runtime: false,
      authorizes_kill_switch_wiring: false,
    }));
    expect(current.noop_dry_check_result_contract).toEqual(expect.objectContaining({
      no_runtime_started: true,
      no_flag_read: true,
      no_kill_switch_wired: true,
      no_live_check_performed: true,
      no_output_file_written: true,
      authorizes_runtime: false,
      authorizes_kill_switch_wiring: false,
    }));
  });

  test('preserves disabled runtime, flag-reader, env/config, kill-switch, and wiring boundaries', () => {
    const current = dryCheck(build());

    for (const [field, shape] of [
      ['runtime_mode_boundary', killSwitchWiringNoopBoundaryRefreshContract.runtimeModeBoundaryShapeExpected],
      ['flag_reader_boundary', killSwitchWiringNoopBoundaryRefreshContract.flagReaderBoundaryShapeExpected],
      ['env_config_read_boundary', killSwitchWiringNoopBoundaryRefreshContract.envConfigReadBoundaryShapeExpected],
      ['kill_switch_boundary', killSwitchWiringNoopBoundaryRefreshContract.killSwitchBoundaryShapeExpected],
      ['kill_switch_wiring_boundary', killSwitchWiringNoopBoundaryRefreshContract.killSwitchWiringBoundaryShapeExpected],
    ]) {
      expect(current[field]).toEqual(expect.objectContaining(shape.requiredValues));
    }
    expect(current.flag_reader_boundary).toEqual(expect.objectContaining({
      flagReader: false,
      flagReadNow: false,
      envReadNow: false,
      configReadNow: false,
      secretReadNow: false,
      rawConfigExportNow: false,
    }));
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
      killSwitchWiringAvailable: false,
      wiringImplemented: false,
      wiringAuthorized: false,
    }));
  });

  test('keeps prerequisite, readiness, preimplementation, no-op item, and blocked-slice matrices fixture-owned', () => {
    const current = dryCheck(build());

    expect(current.prerequisite_gap_matrix).toEqual(expect.arrayContaining(
      killSwitchWiringNoopBoundaryRefreshContract.prerequisiteGapMatrixExpected
        .map((item) => expect.objectContaining(item)),
    ));
    expect(current.prerequisite_gap_matrix).toHaveLength(2);
    expect(current.readiness_gap_matrix).toEqual(expect.arrayContaining(
      killSwitchWiringNoopBoundaryRefreshContract.readinessGapMatrixExpected
        .map((item) => expect.objectContaining(item)),
    ));
    expect(current.readiness_gap_matrix).toHaveLength(6);
    expect(current.preimplementation_checklist_gaps).toEqual(expect.arrayContaining(
      killSwitchWiringNoopBoundaryRefreshContract.preimplementationChecklistGapsExpected
        .map((item) => expect.objectContaining(item)),
    ));
    expect(current.preimplementation_checklist_gaps).toHaveLength(8);
    expect(current.noop_dry_check_items).toEqual(expect.arrayContaining(
      killSwitchWiringNoopBoundaryRefreshContract.noopDryCheckItemsExpected
        .map((item) => expect.objectContaining(item)),
    ));
    expect(current.noop_dry_check_items).toHaveLength(7);
    expect(current.noop_dry_check_items.every((item) => (
      item.status === 'required_contract_only_non_authorizing'
      && item.satisfied_now === false
      && item.authorizes_runtime === false
      && item.authorizes_kill_switch_wiring === false
    ))).toBe(true);
    expect(current.blocked_future_slices).toEqual(expect.arrayContaining(
      killSwitchWiringNoopBoundaryRefreshContract.blockedFutureSlicesExpected
        .map((slice) => expect.objectContaining(slice)),
    ));
    expect(current.blocked_future_slices).toHaveLength(5);
  });

  test('preserves capability, proof, boundary, redaction, and no-side-effect truth', () => {
    const output = build();
    const current = dryCheck(output);

    expect(current.capability_matrix).toEqual(expect.objectContaining(
      killSwitchWiringNoopBoundaryRefreshContract.capabilityMatrixExpected,
    ));
    expect(current.proof_boundaries).toEqual(expect.objectContaining(
      killSwitchWiringNoopBoundaryRefreshContract.proofBoundaryExpected,
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
    for (const field of Object.keys(killSwitchWiringNoopBoundaryRefreshContract.sideEffectTruthExpected)) {
      expect(current.side_effect_result[field]).toBe(true);
      expect(report(output).side_effect_truth[field]).toBe(true);
    }
    expect(current.side_effect_result.outputFileWritten).toBe(false);
    expect(current.side_effect_result.killSwitchLiveCheckPerformed).toBe(false);
    expect(current.side_effect_result.reportingSinkWritten).toBe(false);
  });

  test('next recommendations are fixture-owned Tier0/Tier1 and non-authorizing', () => {
    const current = dryCheck(build());

    expect(current.next_phase_recommendations).toEqual(expect.arrayContaining(
      killSwitchWiringNoopBoundaryRefreshContract.nextRecommendationExpectedCandidates
        .map((candidate) => expect.objectContaining(candidate)),
    ));
    expect(current.next_phase_recommendations).toHaveLength(
      killSwitchWiringNoopBoundaryRefreshContract.nextRecommendationExpectedCandidates.length,
    );
    expect(current.next_phase_recommendations.map((item) => item.recommendation_id))
      .not.toContain(current.satisfied_prior_recommendations[0].recommendation_id);
    for (const recommendation of current.next_phase_recommendations) {
      expect(['tier0', 'tier1']).toContain(recommendation.tier);
      expect(recommendation.does_not_authorize_runtime).toBe(true);
      expect(recommendation.does_not_authorize_execution).toBe(true);
      expect(recommendation.does_not_authorize_kill_switch_wiring).toBe(true);
      expect(recommendation.does_not_authorize_live_check).toBe(true);
      expect(recommendation.does_not_authorize_output_files).toBe(true);
    }
  });

  test('validation report binds static rules, acceptance checks, tamper cases, literals, and paths', () => {
    const output = build();
    const validation = validateMiraCoreKillSwitchWiringNoopBoundaryRefreshOutput(
      output,
      killSwitchWiringNoopBoundaryRefreshContract,
    );

    expect(validation.ok).toBe(true);
    expect(report(output).static_rule_results.map((entry) => entry.id))
      .toEqual(killSwitchWiringNoopBoundaryRefreshContract.staticValidationRules.map((entry) => entry.id));
    expect(report(output).acceptance_check_results.map((entry) => entry.id))
      .toEqual(killSwitchWiringNoopBoundaryRefreshContract.acceptanceChecks.map((entry) => entry.id));
    expect(report(output).tamper_case_results).toHaveLength(killSwitchWiringNoopBoundaryRefreshContract.tamperCases.length);
    expect(report(output).tamper_case_results.length).toBeGreaterThanOrEqual(
      killSwitchWiringNoopBoundaryRefreshContract.expectedCounts.tamper_case_min_count,
    );
    expect(report(output).required_literal_results.length).toBeGreaterThanOrEqual(
      killSwitchWiringNoopBoundaryRefreshContract.expectedCounts.required_literal_min_count,
    );
    expect(report(output).required_literal_results.every((entry) => entry.ok)).toBe(true);
    expect(report(output).referenced_path_results.every((entry) => entry.ok)).toBe(true);
    expect(report(output).referenced_path_results).toHaveLength(63);
    expect(report(output).forbidden_output_scan.ok).toBe(true);
    expect(report(output).unsafe_action_scan.ok).toBe(true);
  });

  test('idempotency is stable for equivalent input and sensitive to scope and refresh facts', () => {
    const first = dryCheck(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'VIGIL' }));
    const second = dryCheck(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'VIGIL' }));
    const changedDevice = dryCheck(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'ALT' }));
    const changedProfile = dryCheck(build({ profile: { name: 'side' }, sessionId: 'session-a', deviceId: 'VIGIL' }));

    expect(first.idempotency_key).toBe(second.idempotency_key);
    expect(first.refresh_id).toBe(second.refresh_id);
    expect(first.idempotency_key).not.toBe(changedDevice.idempotency_key);
    expect(first.idempotency_key).not.toBe(changedProfile.idempotency_key);

    const tampered = clone(build());
    const originalKey = dryCheck(tampered).idempotency_key;
    dryCheck(tampered).noop_dry_check_items[0].satisfied_now = true;
    recomputeDryCheckKey(tampered);
    expect(dryCheck(tampered).idempotency_key).not.toBe(originalKey);
    expectValidatorFails(tampered, 'accept-noop-items-non-authorizing');
  });

  test('validator rejects baseline, registry, source, stale, closure, and path drift', () => {
    const cases = [
      ['accept-schema-baseline-d57e546', (output) => { dryCheck(output).baseline_commit = '2bff807'; }],
      ['accept-registries-48-48-48', (output) => { dryCheck(output).phase_registry.phase_inventory_count = 47; }],
      ['accept-registries-48-48-48', (output) => { dryCheck(output).schema_registry.count = 47; }],
      ['accept-registries-48-48-48', (output) => { dryCheck(output).cli_registry.count = 47; }],
      ['accept-commit-chain-36-ending-d57e546', (output) => { dryCheck(output).commit_chain.pop(); }],
      ['accept-phase48-validator-satisfied', (output) => { dryCheck(output).satisfied_prior_recommendations[0].status = 'open'; }],
      ['accept-phase49-noop-boundary-refresh-selected', (output) => { dryCheck(output).source_recommendation.recommendation_id = 'wrong'; }],
      ['accept-phase35-through-48-current', (output) => { dryCheck(output).current_truth.phase48_current = false; }],
      ['accept-stale-phase13-23-31', (output) => { dryCheck(output).stale_readiness.phase31_stale = false; }],
      ['accept-oracle-closure-through-190', (output) => { dryCheck(output).closure_summary.oracle_190_phase48_review_closure_carried = false; }],
    ];

    for (const [checkId, mutate] of cases) {
      const output = clone(build());
      mutate(output);
      recomputeDryCheckKey(output);
      expectValidatorFails(output, checkId);
    }

    const pathLie = clone(build());
    report(pathLie).referenced_path_results[0].exists = false;
    report(pathLie).referenced_path_results[0].ok = false;
    expectValidatorFails(pathLie, 'referenced-path-results-complete');
  });

  test('validator rejects no-op boundary refresh, request, and result contract drift', () => {
    const cases = [
      ['accept-noop-refresh-contract-only', (output) => { dryCheck(output).noop_boundary_refresh_summary.ready_for_kill_switch_wiring_now = true; }],
      ['accept-noop-refresh-contract-only', (output) => { dryCheck(output).noop_boundary_refresh_summary.noop_would_read_flag = true; }],
      ['accept-noop-boundary-status-blocked', (output) => { dryCheck(output).noop_boundary_status.noop_execution_allowed = true; }],
      ['accept-noop-boundary-status-blocked', (output) => { dryCheck(output).noop_boundary_status.live_check_allowed = true; }],
      ['accept-noop-request-no-read', (output) => { dryCheck(output).noop_dry_check_request_contract.no_env_config_flag_read = false; }],
      ['accept-noop-request-no-read', (output) => { dryCheck(output).noop_dry_check_request_contract.no_live_kill_switch_check = false; }],
      ['accept-noop-result-no-proof', (output) => { dryCheck(output).noop_dry_check_result_contract.no_flag_read = false; }],
      ['accept-noop-result-no-proof', (output) => { dryCheck(output).noop_dry_check_result_contract.no_live_check_performed = false; }],
      ['accept-noop-result-no-proof', (output) => { dryCheck(output).noop_dry_check_result_contract.authorizes_kill_switch_wiring = true; }],
    ];

    for (const [checkId, mutate] of cases) {
      const output = clone(build());
      mutate(output);
      recomputeDryCheckKey(output);
      expectValidatorFails(output, checkId);
    }
  });

  test('validator rejects runtime, flag-reader, env/config, kill-switch, and wiring boundary drift', () => {
    const cases = [
      ['accept-runtime-mode-default-off', (output) => { dryCheck(output).runtime_mode_boundary.disabled = false; }],
      ['accept-runtime-mode-unimplemented', (output) => { dryCheck(output).runtime_mode_boundary.implemented = true; }],
      ['accept-runtime-mode-non-authorizing', (output) => { dryCheck(output).runtime_mode_boundary.authorizes_runtime = true; }],
      ['accept-flag-reader-false', (output) => { dryCheck(output).flag_reader_boundary.flagReader = true; }],
      ['accept-flag-reader-false', (output) => { dryCheck(output).flag_reader_boundary.flagReadNow = true; }],
      ['accept-no-env-read', (output) => { dryCheck(output).flag_reader_boundary.envReadNow = true; }],
      ['accept-no-config-read', (output) => { dryCheck(output).flag_reader_boundary.configReadNow = true; }],
      ['accept-no-secret-read', (output) => { dryCheck(output).flag_reader_boundary.secretReadNow = true; }],
      ['accept-no-raw-config-export', (output) => { dryCheck(output).flag_reader_boundary.rawConfigExportNow = true; }],
      ['accept-kill-switch-visible-fail-closed', (output) => { dryCheck(output).kill_switch_boundary.fail_closed = false; }],
      ['accept-kill-wired-false', (output) => { dryCheck(output).kill_switch_boundary.killWired = true; }],
      ['accept-live-check-false', (output) => { dryCheck(output).kill_switch_boundary.liveCheck = true; }],
      ['accept-bypass-false', (output) => { dryCheck(output).kill_switch_boundary.bypass = true; }],
      ['accept-allow-open-false', (output) => { dryCheck(output).kill_switch_boundary.allow_open = true; }],
      ['accept-wiring-available-false', (output) => { dryCheck(output).kill_switch_wiring_boundary.killSwitchWiringAvailable = true; }],
      ['accept-wiring-implemented-false', (output) => { dryCheck(output).kill_switch_wiring_boundary.wiringImplemented = true; }],
      ['accept-wiring-authorized-false', (output) => { dryCheck(output).kill_switch_wiring_boundary.wiringAuthorized = true; }],
    ];

    for (const [checkId, mutate] of cases) {
      const output = clone(build());
      mutate(output);
      recomputeDryCheckKey(output);
      expectValidatorFails(output, checkId);
    }
  });

  test('validator rejects prerequisite/readiness/preimplementation/no-op item and blocked-slice drift', () => {
    const cases = [
      ['accept-prerequisite-gaps-two', (output) => { dryCheck(output).prerequisite_gap_matrix.pop(); }],
      ['accept-prerequisite-gaps-unsatisfied', (output) => { dryCheck(output).prerequisite_gap_matrix[0].satisfied_now = true; }],
      ['accept-readiness-gaps-six', (output) => { dryCheck(output).readiness_gap_matrix.pop(); }],
      ['accept-readiness-gaps-unsatisfied', (output) => { dryCheck(output).readiness_gap_matrix[0].satisfied_now = true; }],
      ['accept-preimplementation-gaps-eight', (output) => { dryCheck(output).preimplementation_checklist_gaps.pop(); }],
      ['accept-preimplementation-gaps-unsatisfied', (output) => { dryCheck(output).preimplementation_checklist_gaps[0].satisfied_now = true; }],
      ['accept-noop-items-seven', (output) => { dryCheck(output).noop_dry_check_items.pop(); }],
      ['accept-noop-items-non-authorizing', (output) => { dryCheck(output).noop_dry_check_items[0].satisfied_now = true; }],
      ['accept-noop-items-non-authorizing', (output) => { dryCheck(output).noop_dry_check_items[0].authorizes_kill_switch_wiring = true; }],
      ['accept-blocked-future-slices-five', (output) => { dryCheck(output).blocked_future_slices.pop(); }],
      ['accept-blocked-future-slices-five', (output) => { dryCheck(output).blocked_future_slices[0].implementation_allowed_now = true; }],
    ];

    for (const [checkId, mutate] of cases) {
      const output = clone(build());
      mutate(output);
      recomputeDryCheckKey(output);
      expectValidatorFails(output, checkId);
    }
  });

  test('validator rejects capability, proof, side-effect, and redaction overclaims', () => {
    const cases = [
      ['accept-capability-false', (output) => { dryCheck(output).capability_matrix.runtimeStarted = true; }],
      ['accept-capability-false', (output) => { dryCheck(output).capability_matrix.serverCanExecuteLocal = true; }],
      ['accept-capability-false', (output) => { dryCheck(output).capability_matrix.noopDryCheckAvailable = true; }],
      ['accept-capability-false', (output) => { dryCheck(output).capability_matrix.noopBoundaryRefreshAvailable = true; }],
      ['accept-direct-targets-blocked', (output) => {
        dryCheck(output).capability_matrix.directBuilderOracleServerTargetsBlocked = false;
        dryCheck(output).proof_boundaries.builder_oracle_direct_server_target_allowed = true;
      }],
      ['accept-proof-boundaries-false', (output) => { dryCheck(output).proof_boundaries.socket_is_bridge_green = true; }],
      ['accept-proof-boundaries-false', (output) => {
        dryCheck(output).proof_boundaries.noop_boundary_refresh_contract_is_live_check_proof = true;
      }],
      ['accept-side-effect-truth', (output) => {
        dryCheck(output).side_effect_result.no_output_file_written = false;
        dryCheck(output).side_effect_result.outputFileWritten = true;
      }],
      ['accept-side-effect-truth', (output) => {
        dryCheck(output).side_effect_result.no_kill_switch_live_check_performed = false;
        dryCheck(output).side_effect_result.killSwitchLiveCheckPerformed = true;
      }],
      ['accept-forbidden-substrings', (output) => { dryCheck(output).redaction_summary.note = 'runtime started'; }],
    ];

    for (const [checkId, mutate] of cases) {
      const output = clone(build());
      mutate(output);
      recomputeDryCheckKey(output);
      expectValidatorFails(output, checkId);
    }
  });

  test('validator rejects unsafe next-action drift and Tier2+ recommendations after idempotency recompute', () => {
    for (const phrase of killSwitchWiringNoopBoundaryRefreshContract.unsafeActionPhrases) {
      const output = clone(build());
      dryCheck(output).next_phase_recommendations[0].safe_next_action = `safe to ${phrase}`;
      recomputeDryCheckKey(output);
      expectValidatorFails(output, 'accept-unsafe-action-phrases');
    }

    const tier2 = clone(build());
    dryCheck(tier2).next_phase_recommendations[0].tier = 'tier2';
    recomputeDryCheckKey(tier2);
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
    dryCheck(literalLie).baseline_commit = 'bbf6e9f';
    recomputeDryCheckKey(literalLie);
    const literal = report(literalLie).required_literal_results.find((entry) => entry.path === 'baseline_commit');
    literal.actual = BASELINE_COMMIT;
    literal.ok = true;
    expectValidatorFails(literalLie, 'required-literal-checks-bound');
    expectValidatorFails(literalLie, 'validation-report-matches-contract');
  });

  test('CLI is stdout-only, consumes the Oracle fixture, and ignores output-file flags', () => {
    const parsed = parseArgs(['--pretty', '--out', 'ignored.json']);
    expect(parsed.pretty).toBe(true);
    expect(parsed.fixturePath).toContain('mira-core-kill-switch-wiring-noop-boundary-refresh-contract.json');

    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const output = main(['--out=ignored.json'], JSON.stringify({
      profile: { name: 'main' },
      sessionId: 'session-cli',
      deviceId: 'VIGIL',
    }));

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(dryCheck(output).schema).toBe(KILL_SWITCH_WIRING_NOOP_BOUNDARY_REFRESH_SCHEMA_VERSION);
    expect(dryCheck(output).sessionId).toBe('session-cli');
    expect(dryCheck(output).baseline_commit).toBe(BASELINE_COMMIT);
    expect(dryCheck(output).phase_registry.current_through_phase).toBe(48);
    expect(dryCheck(output).schema_registry.count).toBe(48);
    expect(dryCheck(output).cli_registry.count).toBe(48);
    expect(dryCheck(output).commit_chain).toHaveLength(36);
    expect(dryCheck(output).source_refs).toHaveLength(18);
    expect(dryCheck(output).prerequisite_gap_matrix).toHaveLength(2);
    expect(dryCheck(output).readiness_gap_matrix).toHaveLength(6);
    expect(dryCheck(output).preimplementation_checklist_gaps).toHaveLength(8);
    expect(dryCheck(output).noop_dry_check_items).toHaveLength(7);
    expect(dryCheck(output).blocked_future_slices).toHaveLength(5);
    expect(dryCheck(output).noop_boundary_refresh_summary.ready_for_kill_switch_wiring_now).toBe(false);
    expect(dryCheck(output).noop_boundary_status.noop_execution_allowed).toBe(false);
    expect(dryCheck(output).noop_dry_check_request_contract.no_env_config_flag_read).toBe(true);
    expect(dryCheck(output).noop_dry_check_result_contract.no_live_check_performed).toBe(true);
    expect(dryCheck(output).kill_switch_boundary.killWired).toBe(false);
    expect(dryCheck(output).kill_switch_wiring_boundary.killSwitchWiringAvailable).toBe(false);
    expect(dryCheck(output).capability_matrix.serverCanExecuteLocal).toBe(false);
    expect(dryCheck(output).capability_matrix.noopBoundaryRefreshAvailable).toBe(false);
    expect(dryCheck(output).side_effect_result.no_output_file_written).toBe(true);
    expect(dryCheck(output).side_effect_result.no_noop_execution_performed).toBe(true);
    expect(report(output).decision).toBe('accepted_validation_only');
    expect(validateMiraCoreKillSwitchWiringNoopBoundaryRefreshOutput(
      output,
      killSwitchWiringNoopBoundaryRefreshContract,
    )).toEqual(expect.objectContaining({ ok: true }));
  });
});
