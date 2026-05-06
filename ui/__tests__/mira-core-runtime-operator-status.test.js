const runtimeOperatorStatusContract = require('./fixtures/mira-core-runtime-operator-status-contract.json');
const {
  BASELINE_COMMIT,
  PHASE31_COMMIT,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_REPORT_FIELDS,
  REQUIRED_SIDE_EFFECT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  RUNTIME_OPERATOR_STATUS_REPORT_SCHEMA_VERSION,
  STATUS_SURFACE_ID,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreRuntimeOperatorStatus,
  runtimeOperatorStatusIdempotencyKey,
  validateMiraCoreRuntimeOperatorStatusOutput,
} = require('../modules/mira-core/runtime-operator-status');
const {
  main,
  parseArgs,
} = require('../scripts/hm-mira-core-runtime-operator-status');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function build(inputSignals = {}) {
  return buildMiraCoreRuntimeOperatorStatus({
    contract: runtimeOperatorStatusContract,
    inputSignals,
    nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
  });
}

function statusReport(output) {
  return output.runtime_operator_status_report;
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
  expect(() => assertNoForbiddenOutput(output, runtimeOperatorStatusContract.forbiddenOutputSubstrings)).not.toThrow();
}

function expectValidatorFails(output, checkId) {
  const validation = validateMiraCoreRuntimeOperatorStatusOutput(output, runtimeOperatorStatusContract);
  expect(validation.ok).toBe(false);
  expect(validation.checks.find((entry) => entry.id === checkId)).toEqual(expect.objectContaining({ ok: false }));
}

function recomputeStatusKey(output) {
  output.runtime_operator_status_report.idempotency_key =
    runtimeOperatorStatusIdempotencyKey(output.runtime_operator_status_report);
}

describe('mira core runtime operator status contract v0', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('satisfies Oracle output, report, and validation report shapes', () => {
    const output = build();
    const report = statusReport(output);
    const validation = validationReport(output);

    expectRequiredFields(output, runtimeOperatorStatusContract.expectedTopLevelFields);
    expect(runtimeOperatorStatusContract.expectedTopLevelFields).toEqual(REQUIRED_OUTPUT_FIELDS);
    expect(report.schema).toBe(RUNTIME_OPERATOR_STATUS_REPORT_SCHEMA_VERSION);
    expect(validation.schema).toBe(VALIDATION_REPORT_SCHEMA_VERSION);
    expectRequiredFields(report, runtimeOperatorStatusContract.expectedRuntimeOperatorStatusReportShape.requiredFields);
    expect(runtimeOperatorStatusContract.expectedRuntimeOperatorStatusReportShape.requiredFields).toEqual(REQUIRED_REPORT_FIELDS);
    expectRequiredFields(validation, runtimeOperatorStatusContract.expectedValidationReportShape.requiredFields);
    expect(runtimeOperatorStatusContract.expectedValidationReportShape.requiredFields).toEqual(REQUIRED_VALIDATION_REPORT_FIELDS);
    expect(validateMiraCoreRuntimeOperatorStatusOutput(output, runtimeOperatorStatusContract)).toEqual(expect.objectContaining({ ok: true }));
    expect(validation.accepted).toBe(true);
    expect(validation.blocked).toBe(false);
    expect(validation.decision).toBe('accepted_validation_only');
    expectNoForbiddenOutput(output);
  });

  test('pins baseline and Phase 31/32 dependencies with registry and expiry-closure truth', () => {
    const report = statusReport(build());
    const expected = runtimeOperatorStatusContract.expectedRuntimeOperatorStatusReportShape;

    expect(report.baseline_commit).toBe(BASELINE_COMMIT);
    expect(BASELINE_COMMIT).toBe(runtimeOperatorStatusContract.baseline.commit);
    expect(report.phase_31_dependency).toEqual(expect.objectContaining({
      commit: PHASE31_COMMIT,
      phase_registry_count: 30,
      schema_registry_count: 30,
      cli_registry_count: 30,
      commit_chain_count: 19,
      phase_23_stale_superseded: true,
      phase_30_oracle_115_closure: true,
      runtime_started: false,
      runtime_available_now: false,
      serverCanExecuteLocal: false,
    }));
    expect(report.phase_32_dependency).toEqual(expect.objectContaining({
      commit: BASELINE_COMMIT,
      decision: 'remain_disabled_dry_runner_contract_only',
      runner_executed: false,
      runtime_started: false,
      runner_available_now: false,
      result_enum_count: 12,
      oracle_123_expiry_closure: true,
    }));
    for (const [field, value] of Object.entries(expected.requiredLiteralValues)) {
      expect(field.includes('.') ? field.split('.').reduce((acc, key) => acc && acc[key], report) : report[field]).toEqual(value);
    }
  });

  test('status surface remains contract-only, read-only, non-authorizing, and not runtime proof', () => {
    const report = statusReport(build());

    expect(report.status_surface_id).toBe(STATUS_SURFACE_ID);
    expect(report.status_surface_status).toBe('contract_only_read_only_operator_summary');
    expect(report.status_surface_decision).toBe('remain_operator_status_contract_only');
    expect(report.eligible_is_authorization).toBe(false);
    expect(report.eligible_is_runtime_proof).toBe(false);
    expect(report.runtime_started).toBe(false);
    expect(report.runtime_available_now).toBe(false);
    expect(report.runner_available_now).toBe(false);
    expect(report.runner_executed).toBe(false);
    expect(report.proof_boundaries.socket_is_bridge_green).toBe(false);
    expect(report.proof_boundaries.delivery_acceptance_is_model_processing_proof).toBe(false);
    expect(report.proof_boundaries.config_present_is_runtime_proof).toBe(false);
    expect(report.proof_boundaries.runner_contract_is_runner_execution_proof).toBe(false);
    expect(report.proof_boundaries.serverCanExecuteLocal).toBe(false);
  });

  test('operator status cards, warning states, schema refs, and CLI refs match fixture', () => {
    const report = statusReport(build());
    const expected = runtimeOperatorStatusContract.expectedRuntimeOperatorStatusReportShape;

    expect(report.status_cards).toHaveLength(10);
    expect(report.status_cards).toEqual(expect.arrayContaining(expected.statusCardsExpected.map((card) => expect.objectContaining(card))));
    for (const card of report.status_cards) {
      expectRequiredFields(card, expected.statusCardRequiredFields);
      expect(card.visible).toBe(true);
      expect(card.read_only).toBe(true);
      expect(card.side_effect_result.no_ui_implemented).toBe(true);
      expect(card.side_effect_result.no_output_file_written).toBe(true);
    }
    expect(report.stale_replay_warning_states).toHaveLength(5);
    expect(report.stale_replay_warning_states).toEqual(expect.arrayContaining(expected.warningStatesExpected.map((warning) => expect.objectContaining(warning))));
    expect(report.schema_registry_refs).toEqual(expected.schemaRegistryRefsExpected);
    expect(report.cli_registry_refs).toEqual(expected.cliRegistryRefsExpected);
  });

  test('flag, dry-runner, kill switch, fallback, local, execution, telemetry, and targets preserve boundaries', () => {
    const report = statusReport(build());

    expect(report.runtime_flag_status).toEqual(expect.objectContaining({
      value: 'disabled_off',
      default_disabled: true,
      dev_only: true,
      local_only: true,
      authorizes_runtime: false,
    }));
    expect(report.dry_runner_status).toEqual(expect.objectContaining({
      runner_decision: 'remain_disabled_dry_runner_contract_only',
      runner_executed: false,
      runner_available_now: false,
      result_enum_count: 12,
      oracle_123_expiry_closure: true,
    }));
    expect(report.kill_switch_status.fail_closed).toBe(true);
    expect(report.kill_switch_status.authorizes_runtime).toBe(false);
    expect(report.dry_run_fallback_status.preview_only).toBe(true);
    expect(report.dry_run_fallback_status.executes_requests).toBe(false);
    expect(report.dry_run_fallback_status.creates_queue_or_lease).toBe(false);
    expect(report.local_boundary_status.loopback_only).toBe(true);
    expect(report.local_boundary_status.listener_bound).toBe(false);
    expect(report.local_boundary_status.network_performed).toBe(false);
    expect(report.execution_boundary_status.runner_execution_performed).toBe(false);
    expect(report.execution_boundary_status.runtime_start_performed).toBe(false);
    expect(report.execution_boundary_status.queue_created).toBe(false);
    expect(report.execution_boundary_status.lease_created).toBe(false);
    expect(report.execution_boundary_status.local_execution_performed).toBe(false);
    expect(report.telemetry_audit_status.redacted_preview_only).toBe(true);
    expect(report.telemetry_audit_status.write_performed).toBe(false);
    expect(report.target_boundaries.architect_only_future_server_target).toBe(true);
    expect(report.target_boundaries.builder_direct_server_target_allowed).toBe(false);
    expect(report.target_boundaries.oracle_direct_server_target_allowed).toBe(false);
  });

  test('unsafe policy, next recommendations, side-effect truth, static rules, and acceptance checks are explicit', () => {
    const output = build();
    const report = statusReport(output);
    const validation = validateMiraCoreRuntimeOperatorStatusOutput(output, runtimeOperatorStatusContract);

    expect(report.unsafe_action_policy.customer_send_allowed).toBe(false);
    expect(report.unsafe_action_policy.external_send_allowed).toBe(false);
    expect(report.unsafe_action_policy.deploy_allowed).toBe(false);
    expect(report.unsafe_action_policy.trade_allowed).toBe(false);
    expect(report.next_phase_recommendations).toEqual(expect.arrayContaining(
      runtimeOperatorStatusContract.expectedRuntimeOperatorStatusReportShape.nextRecommendationExpectedCandidates.map((candidate) => expect.objectContaining(candidate)),
    ));
    for (const recommendation of report.next_phase_recommendations) {
      expect(['tier0', 'tier1']).toContain(recommendation.tier);
      expect(recommendation.does_not_authorize_runtime).toBe(true);
    }
    for (const field of REQUIRED_SIDE_EFFECT_FIELDS) {
      expect(report.side_effect_result[field]).toBe(true);
      expect(validationReport(output).side_effect_truth[field]).toBe(true);
    }
    const checkIds = validation.checks.map((entry) => entry.id);
    const staticIds = validationReport(output).static_rule_results.map((entry) => entry.id);
    const acceptanceIds = validationReport(output).acceptance_check_results.map((entry) => entry.id);
    for (const rule of runtimeOperatorStatusContract.staticValidationRules) {
      expect(checkIds).toContain(rule.id);
      expect(staticIds).toContain(rule.id);
    }
    for (const check of runtimeOperatorStatusContract.acceptanceChecks) {
      expect(checkIds).toContain(check.id);
      expect(acceptanceIds).toContain(check.id);
    }
    expect(validationReport(output).tamper_case_results).toHaveLength(runtimeOperatorStatusContract.tamperCases.length);
  });

  test('idempotency is stable for equivalent inputs and sensitive to status facts', () => {
    const first = statusReport(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'VIGIL' }));
    const second = statusReport(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'VIGIL' }));
    const changedDevice = statusReport(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'ALT' }));
    const changedProfile = statusReport(build({ profile: { name: 'side' }, sessionId: 'session-a', deviceId: 'VIGIL' }));

    expect(first.idempotency_key).toBe(second.idempotency_key);
    expect(first.status_report_id).toBe(second.status_report_id);
    expect(first.idempotency_key).not.toBe(changedDevice.idempotency_key);
    expect(first.idempotency_key).not.toBe(changedProfile.idempotency_key);

    const changed = clone(build());
    const originalKey = changed.runtime_operator_status_report.idempotency_key;
    changed.runtime_operator_status_report.phase_32_dependency.oracle_123_expiry_closure = false;
    recomputeStatusKey(changed);
    expect(changed.runtime_operator_status_report.idempotency_key).not.toBe(originalKey);
    expectValidatorFails(changed, 'phase32-dependency-current');
  });

  test('validator rejects stale baseline, stale dependencies, UI overclaim, runtime flag, and dry-runner live decision', () => {
    const staleBaseline = clone(build());
    staleBaseline.runtime_operator_status_report.baseline_commit = '83963ab';
    recomputeStatusKey(staleBaseline);
    expectValidatorFails(staleBaseline, 'baseline-pinned');

    const stalePhase32 = clone(build());
    stalePhase32.runtime_operator_status_report.phase_32_dependency.commit = '83963ab';
    recomputeStatusKey(stalePhase32);
    expectValidatorFails(stalePhase32, 'phase32-dependency-current');

    const ui = clone(build());
    ui.runtime_operator_status_report.status_surface_status = 'ui_implemented';
    recomputeStatusKey(ui);
    expectValidatorFails(ui, 'operator-status-contract-only');

    const flag = clone(build());
    flag.runtime_operator_status_report.runtime_flag_status.value = 'enabled_on';
    flag.runtime_operator_status_report.runtime_flag_status.default_disabled = false;
    recomputeStatusKey(flag);
    expectValidatorFails(flag, 'runtime-flag-disabled');

    const runner = clone(build());
    runner.runtime_operator_status_report.dry_runner_status.runner_decision = 'runner_available';
    recomputeStatusKey(runner);
    expectValidatorFails(runner, 'dry-runner-decision-contract-only');
  });

  test('validator rejects kill switch, fallback, local boundary, execution, telemetry, warning, proof, and target tampering', () => {
    const kill = clone(build());
    kill.runtime_operator_status_report.kill_switch_status.fail_closed = false;
    recomputeStatusKey(kill);
    expectValidatorFails(kill, 'kill-switch-fail-closed');

    const fallback = clone(build());
    fallback.runtime_operator_status_report.dry_run_fallback_status.executes_requests = true;
    recomputeStatusKey(fallback);
    expectValidatorFails(fallback, 'dry-run-fallback-preview-only');

    const listener = clone(build());
    listener.runtime_operator_status_report.local_boundary_status.listener_bound = true;
    listener.runtime_operator_status_report.local_boundary_status.network_performed = true;
    recomputeStatusKey(listener);
    expectValidatorFails(listener, 'local-loopback-no-listener-network');

    const executed = clone(build());
    executed.runtime_operator_status_report.runner_executed = true;
    executed.runtime_operator_status_report.execution_boundary_status.queue_created = true;
    recomputeStatusKey(executed);
    expectValidatorFails(executed, 'no-runner-runtime-queue-lease-execution');

    const telemetry = clone(build());
    telemetry.runtime_operator_status_report.telemetry_audit_status.write_performed = true;
    recomputeStatusKey(telemetry);
    expectValidatorFails(telemetry, 'telemetry-audit-preview-only');

    const warning = clone(build());
    warning.runtime_operator_status_report.stale_replay_warning_states =
      warning.runtime_operator_status_report.stale_replay_warning_states.filter((entry) => entry.warning_id !== 'replay_rejected_warning');
    recomputeStatusKey(warning);
    expectValidatorFails(warning, 'warning-states-visible');

    const proof = clone(build());
    proof.runtime_operator_status_report.proof_boundaries.delivery_acceptance_is_model_processing_proof = true;
    proof.runtime_operator_status_report.proof_boundaries.serverCanExecuteLocal = true;
    recomputeStatusKey(proof);
    expectValidatorFails(proof, 'proof-boundaries-false');

    const target = clone(build());
    target.runtime_operator_status_report.target_boundaries.builder_direct_server_target_allowed = true;
    target.runtime_operator_status_report.target_boundaries.oracle_direct_server_target_allowed = true;
    recomputeStatusKey(target);
    expectValidatorFails(target, 'direct-builder-oracle-targets-blocked');
  });

  test('validator rejects unsafe action drift, Tier3 recommendations, side-effect lies, and forbidden content', () => {
    for (const phrase of runtimeOperatorStatusContract.unsafeActionPhrases) {
      const unsafe = clone(build());
      unsafe.runtime_operator_status_report.next_phase_recommendations[0].action = phrase;
      recomputeStatusKey(unsafe);
      expectValidatorFails(unsafe, 'unsafe-action-drift-blocked');
    }

    const cardDrift = clone(build());
    cardDrift.runtime_operator_status_report.status_cards[0].title = 'send email to customer';
    recomputeStatusKey(cardDrift);
    expectValidatorFails(cardDrift, 'unsafe-action-drift-blocked');

    const tier = clone(build());
    tier.runtime_operator_status_report.next_phase_recommendations[0].tier = 'tier3';
    recomputeStatusKey(tier);
    expectValidatorFails(tier, 'next-recommendations-tier0-tier1-only');

    const sideEffect = clone(build());
    sideEffect.runtime_operator_status_report.side_effect_result.no_output_file_written = false;
    recomputeStatusKey(sideEffect);
    expectValidatorFails(sideEffect, 'side-effect-truth-all-blocked');

    const forbidden = clone(build());
    forbidden.runtime_operator_status_report.status_cards[0].title = 'raw bearer token';
    recomputeStatusKey(forbidden);
    expectValidatorFails(forbidden, 'no-raw-private-secret-output');
    expectValidatorFails(forbidden, 'forbidden-output-strings-absent');
  });

  test('validator rejects validation-report ok lies and missing tamper coverage', () => {
    const staticLie = clone(build());
    staticLie.validation_report.static_rule_results[0].ok = false;
    expectValidatorFails(staticLie, 'validation-report-matches-contract');

    const acceptanceLie = clone(build());
    acceptanceLie.validation_report.acceptance_check_results[0].ok = false;
    expectValidatorFails(acceptanceLie, 'validation-report-matches-contract');

    const missingTamper = clone(build());
    missingTamper.validation_report.tamper_case_results = [];
    expectValidatorFails(missingTamper, 'validation-report-matches-contract');

    const wrongTamper = clone(build());
    wrongTamper.validation_report.tamper_case_results[0].covered = false;
    expectValidatorFails(wrongTamper, 'validation-report-matches-contract');
  });

  test('CLI is stdout-only, consumes the Oracle fixture, and ignores output-file flags', () => {
    const parsed = parseArgs(['--pretty', '--out', 'ignored.json']);
    expect(parsed.pretty).toBe(true);
    expect(parsed.fixturePath).toContain('mira-core-runtime-operator-status-contract.json');

    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const output = main(['--out=ignored.json'], JSON.stringify({
      profile: { name: 'main' },
      sessionId: 'session-cli',
      deviceId: 'VIGIL',
    }));

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(statusReport(output).schema).toBe(RUNTIME_OPERATOR_STATUS_REPORT_SCHEMA_VERSION);
    expect(statusReport(output).sessionId).toBe('session-cli');
    expect(statusReport(output).baseline_commit).toBe(BASELINE_COMMIT);
    expect(statusReport(output).phase_31_dependency.commit).toBe(PHASE31_COMMIT);
    expect(statusReport(output).phase_32_dependency.commit).toBe(BASELINE_COMMIT);
    expect(statusReport(output).status_surface_decision).toBe('remain_operator_status_contract_only');
    expect(statusReport(output).runtime_started).toBe(false);
    expect(statusReport(output).runner_executed).toBe(false);
    expect(statusReport(output).proof_boundaries.serverCanExecuteLocal).toBe(false);
    expect(statusReport(output).status_cards).toHaveLength(10);
    expect(statusReport(output).stale_replay_warning_states).toHaveLength(5);
    expect(statusReport(output).side_effect_result.no_output_file_written).toBe(true);
    expect(validationReport(output).decision).toBe('accepted_validation_only');
    expect(validateMiraCoreRuntimeOperatorStatusOutput(output, runtimeOperatorStatusContract)).toEqual(expect.objectContaining({ ok: true }));
  });
});
