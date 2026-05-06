const runtimeDryRunnerContract = require('./fixtures/mira-core-runtime-dry-runner-contract.json');
const {
  BASELINE_COMMIT,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_REPORT_FIELDS,
  REQUIRED_SIDE_EFFECT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  RUNTIME_DRY_RUNNER_REPORT_SCHEMA_VERSION,
  RUNNER_ID,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreRuntimeDryRunner,
  runtimeDryRunnerIdempotencyKey,
  validateMiraCoreRuntimeDryRunnerOutput,
} = require('../modules/mira-core/runtime-dry-runner');
const {
  main,
  parseArgs,
} = require('../scripts/hm-mira-core-runtime-dry-runner');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function build(inputSignals = {}) {
  return buildMiraCoreRuntimeDryRunner({
    contract: runtimeDryRunnerContract,
    inputSignals,
    nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
  });
}

function dryRunnerReport(output) {
  return output.runtime_dry_runner_contract_report;
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
  expect(() => assertNoForbiddenOutput(output, runtimeDryRunnerContract.forbiddenOutputSubstrings)).not.toThrow();
}

function expectValidatorFails(output, checkId) {
  const validation = validateMiraCoreRuntimeDryRunnerOutput(output, runtimeDryRunnerContract);
  expect(validation.ok).toBe(false);
  expect(validation.checks.find((entry) => entry.id === checkId)).toEqual(expect.objectContaining({ ok: false }));
}

function recomputeDryRunnerKey(output) {
  output.runtime_dry_runner_contract_report.idempotency_key =
    runtimeDryRunnerIdempotencyKey(output.runtime_dry_runner_contract_report);
}

describe('mira core runtime dry-runner contract v0', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('satisfies Oracle output, report, and validation report shapes', () => {
    const output = build();
    const report = dryRunnerReport(output);
    const validation = validationReport(output);

    expectRequiredFields(output, runtimeDryRunnerContract.expectedOutputShape.requiredTopLevelFields);
    expect(runtimeDryRunnerContract.expectedOutputShape.requiredTopLevelFields).toEqual(REQUIRED_OUTPUT_FIELDS);
    expect(report.schema).toBe(RUNTIME_DRY_RUNNER_REPORT_SCHEMA_VERSION);
    expect(validation.schema).toBe(VALIDATION_REPORT_SCHEMA_VERSION);
    expectRequiredFields(report, runtimeDryRunnerContract.expectedRuntimeDryRunnerContractReportShape.requiredFields);
    expect(runtimeDryRunnerContract.expectedRuntimeDryRunnerContractReportShape.requiredFields).toEqual(REQUIRED_REPORT_FIELDS);
    expectRequiredFields(validation, runtimeDryRunnerContract.expectedValidationReportShape.requiredFields);
    expect(runtimeDryRunnerContract.expectedValidationReportShape.requiredFields).toEqual(REQUIRED_VALIDATION_REPORT_FIELDS);
    expect(validateMiraCoreRuntimeDryRunnerOutput(output, runtimeDryRunnerContract)).toEqual(expect.objectContaining({ ok: true }));
    expect(validation.accepted).toBe(true);
    expect(validation.decision).toBe('accepted_validation_only');
    expectNoForbiddenOutput(output);
  });

  test('pins baseline, Phase 31 dependency, registry carry-forward, and default contract decision', () => {
    const report = dryRunnerReport(build());
    const expected = runtimeDryRunnerContract.expectedRuntimeDryRunnerContractReportShape;

    expect(report.baseline_commit).toBe(BASELINE_COMMIT);
    expect(BASELINE_COMMIT).toBe(runtimeDryRunnerContract.baseline.commit);
    expectRequiredFields(report.phase_31_dependency, expected.phase31DependencyRequiredFields);
    expect(report.phase_31_dependency).toEqual(expect.objectContaining(expected.phase31DependencyRequiredValues));
    expect(report.phase_31_dependency.commit_chain_through_phase31).toEqual(expected.phase31CommitChainExpected);
    expect(report.phase_31_dependency.commit_chain_through_phase31).toHaveLength(19);
    expect(report.phase31_registry_carry_forward).toEqual(expect.objectContaining({
      phase_inventory_count: 30,
      schema_registry_count: 30,
      cli_registry_count: 30,
      commit_chain_count: 19,
      phase23_stale_superseded: true,
      phase30_oracle_115_closure: true,
    }));
    expect(report.runner_id).toBe(RUNNER_ID);
    expect(report.runner_status).toBe('contract_ready_validation_only');
    expect(report.runner_decision).toBe(expected.requiredDefaultDecision);
    expect(report.runner_decision_allowed_values).toEqual(expected.runnerDecisionAllowedValues);
  });

  test('runtime and runner truth remains unavailable, unexecuted, non-authorizing, and not proof', () => {
    const report = dryRunnerReport(build());

    expect(report.eligible_is_authorization).toBe(false);
    expect(report.eligible_is_runtime_proof).toBe(false);
    expect(report.requires_future_review).toBe(true);
    expect(report.requires_operator_review).toBe(true);
    expect(report.runtime_available_now).toBe(false);
    expect(report.runtime_started).toBe(false);
    expect(report.runner_available_now).toBe(false);
    expect(report.runner_executed).toBe(false);
    expect(report.proof_boundaries.runtime_flag_is_runtime_proof).toBe(false);
    expect(report.proof_boundaries.kill_switch_check_is_runtime_proof).toBe(false);
    expect(report.proof_boundaries.runner_contract_is_runtime_proof).toBe(false);
    expect(report.proof_boundaries.dry_run_response_is_execution_proof).toBe(false);
    expect(report.proof_boundaries.socket_is_bridge_green_proof).toBe(false);
    expect(report.proof_boundaries.delivery_acceptance_is_model_processing_proof).toBe(false);
    expect(report.proof_boundaries.serverCanExecuteLocal).toBe(false);
    expect(report.proof_boundaries.server_can_execute_local_arms).toBe(false);
  });

  test('flag, kill switch, request, response, result enum, replay, and local boundary match fixture', () => {
    const report = dryRunnerReport(build());
    const expected = runtimeDryRunnerContract.expectedRuntimeDryRunnerContractReportShape;

    expect(report.runtime_mode_flag_dependency).toEqual(expect.objectContaining({
      flag_id: 'MIRA_CORE_RUNTIME_DRY_RUN_MODE',
      required: true,
      default_state: 'disabled',
      default_enabled: false,
      dev_only: true,
      local_only: true,
      non_authorizing: true,
      runner_starts_when_present: false,
    }));
    expect(report.kill_switch_dependency).toEqual(expect.objectContaining({
      required: true,
      default_state: 'engaged',
      fail_closed: true,
      testable: true,
      ignored_allowed: false,
      authorizes_runtime: false,
    }));
    expect(report.runner_request_contract).toEqual(expect.objectContaining({
      schema: 'squidrun.mira_core.runtime_dry_runner_request.v0',
      validation_only: true,
      local_in_process_only: true,
      requires_idempotency_key: true,
      requires_replay_key: true,
      redacted_payload_only: true,
      allows_raw_payload: false,
      allows_queue_or_lease: false,
      allows_local_execution: false,
    }));
    expectRequiredFields(report.runner_request_contract.request_example, expected.runnerRequestRequiredFields);
    expect(expected.runnerRequestAllowedRiskTiers).toContain(report.runner_request_contract.request_example.risk_tier);
    expect(report.runner_response_contract).toEqual(expect.objectContaining({
      schema: 'squidrun.mira_core.runtime_dry_runner_response.v0',
      status_preview_only: true,
      executes_request: false,
      starts_runtime: false,
      creates_queue_or_lease: false,
      writes_store_file_db_or_audit: false,
      authorizes_runtime: false,
    }));
    expectRequiredFields(report.runner_response_contract.response_example, expected.runnerResponseRequiredFields);
    expect(report.dry_run_result_enums.allowed_results).toEqual(expected.dryRunResultAllowedValues);
    expect(report.dry_run_result_enums.allowed_results).toHaveLength(12);
    expect(report.dry_run_result_enums.default_result).toBe('blocked_disabled_contract_only');
    expect(report.dry_run_result_enums.result_values_authorize_runtime).toBe(false);
    expect(report.idempotency_replay_rules.replay_executes_side_effects).toBe(false);
    expect(report.idempotency_replay_rules.stale_request_rejected).toBe(true);
    expect(report.local_in_process_boundary.listener_opened_now).toBe(false);
    expect(report.local_in_process_boundary.network_performed_now).toBe(false);
  });

  test('operator status, telemetry, rollback, target boundaries, recommendations, and side effects are safe', () => {
    const output = build();
    const report = dryRunnerReport(output);
    const expected = runtimeDryRunnerContract.expectedRuntimeDryRunnerContractReportShape;

    expect(report.operator_visible_status.visible).toBe(true);
    expect(report.operator_visible_status.status_only).toBe(true);
    expect(report.operator_visible_status.authorizes_runtime).toBe(false);
    expect(report.telemetry_audit_preview.redacted_preview_only).toBe(true);
    expect(report.telemetry_audit_preview.raw_payload_allowed).toBe(false);
    expect(report.telemetry_audit_preview.telemetry_write_now).toBe(false);
    expect(report.telemetry_audit_preview.audit_write_now).toBe(false);
    expect(report.telemetry_audit_preview.file_write_now).toBe(false);
    expect(report.telemetry_audit_preview.db_write_now).toBe(false);
    expect(report.rollback_disable_boundaries.disable_idempotent).toBe(true);
    expect(report.rollback_disable_boundaries.rollback_executed_now).toBe(false);
    expect(report.rollback_disable_boundaries.authorizes_runtime).toBe(false);
    expect(report.target_boundaries.allowed_server_originated_target).toBe('architect');
    expect(report.target_boundaries.builder_direct_server_target_allowed).toBe(false);
    expect(report.target_boundaries.oracle_direct_server_target_allowed).toBe(false);
    expect(report.unsafe_action_policy).toEqual(expect.objectContaining(expected.unsafeActionPolicyRequiredValues));
    expect(report.blocked_side_effects.map((entry) => entry.effect_id)).toEqual(expected.blockedSideEffectsExpected);
    expect(report.next_phase_recommendations).toEqual(expect.arrayContaining(expected.nextRecommendationExpectedCandidates.map((candidate) => expect.objectContaining(candidate))));
    for (const recommendation of report.next_phase_recommendations) {
      expect(expected.nextRecommendationAllowedTiers).toContain(recommendation.tier);
      expect(recommendation.does_not_authorize_runtime).toBe(true);
    }
    for (const field of REQUIRED_SIDE_EFFECT_FIELDS) {
      expect(report.side_effect_result[field]).toBe(true);
      expect(validationReport(output).side_effect_result[field]).toBe(true);
    }
    expect(report.side_effect_result.runnerExecuted).toBe(false);
    expect(report.side_effect_result.outputFilesWritten).toBe(0);
  });

  test('static rules and protected acceptance checks are represented by validation output', () => {
    const output = build();
    const validation = validateMiraCoreRuntimeDryRunnerOutput(output, runtimeDryRunnerContract);
    const checkIds = validation.checks.map((entry) => entry.id);
    const reportCheckIds = validationReport(output).checks.map((entry) => entry.id);

    expect(validation.ok).toBe(true);
    for (const rule of runtimeDryRunnerContract.staticValidationRules) {
      expect(checkIds).toContain(rule.id);
      expect(reportCheckIds).toContain(rule.id);
    }
    for (const check of runtimeDryRunnerContract.acceptanceChecks) {
      expect(checkIds).toContain(check.id);
      expect(reportCheckIds).toContain(check.id);
    }
    expect(validationReport(output).checks.every((entry) => entry.ok)).toBe(true);
  });

  test('idempotency is stable for equivalent inputs and sensitive to runner contract inputs', () => {
    const first = dryRunnerReport(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'VIGIL' }));
    const second = dryRunnerReport(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'VIGIL' }));
    const changedDevice = dryRunnerReport(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'ALT' }));
    const changedProfile = dryRunnerReport(build({ profile: { name: 'side' }, sessionId: 'session-a', deviceId: 'VIGIL' }));

    expect(first.idempotency_key).toBe(second.idempotency_key);
    expect(first.runner_contract_id).toBe(second.runner_contract_id);
    expect(first.idempotency_key).not.toBe(changedDevice.idempotency_key);
    expect(first.idempotency_key).not.toBe(changedProfile.idempotency_key);

    const changed = clone(build());
    const originalKey = changed.runtime_dry_runner_contract_report.idempotency_key;
    changed.runtime_dry_runner_contract_report.dry_run_result_enums.allowed_results.pop();
    recomputeDryRunnerKey(changed);
    expect(changed.runtime_dry_runner_contract_report.idempotency_key).not.toBe(originalKey);
    expectValidatorFails(changed, 'dry-run-result-enums-complete');
  });

  test('validator rejects stale baseline, stale Phase 31 dependency, runner overclaim, and eligibility overclaim', () => {
    const staleBaseline = clone(build());
    staleBaseline.runtime_dry_runner_contract_report.baseline_commit = '679e018';
    recomputeDryRunnerKey(staleBaseline);
    expectValidatorFails(staleBaseline, 'baseline-83963ab-pinned');

    const staleDependency = clone(build());
    staleDependency.runtime_dry_runner_contract_report.phase_31_dependency.commit = '679e018';
    recomputeDryRunnerKey(staleDependency);
    expectValidatorFails(staleDependency, 'phase31-dependency-carried-forward');

    const runner = clone(build());
    runner.runtime_dry_runner_contract_report.runner_available_now = true;
    runner.runtime_dry_runner_contract_report.runner_executed = true;
    recomputeDryRunnerKey(runner);
    expectValidatorFails(runner, 'runner-remains-contract-only');

    const eligible = clone(build());
    eligible.runtime_dry_runner_contract_report.eligible_is_authorization = true;
    eligible.runtime_dry_runner_contract_report.eligible_is_runtime_proof = true;
    recomputeDryRunnerKey(eligible);
    expectValidatorFails(eligible, 'eligibility-non-authorizing');
  });

  test('validator rejects default-enabled flag, ignored kill switch, raw payload, and response execution', () => {
    const flag = clone(build());
    flag.runtime_dry_runner_contract_report.runtime_mode_flag_dependency.default_enabled = true;
    recomputeDryRunnerKey(flag);
    expectValidatorFails(flag, 'disabled-flag-and-kill-switch-required');

    const kill = clone(build());
    kill.runtime_dry_runner_contract_report.kill_switch_dependency.ignored_allowed = true;
    recomputeDryRunnerKey(kill);
    expectValidatorFails(kill, 'disabled-flag-and-kill-switch-required');

    const request = clone(build());
    request.runtime_dry_runner_contract_report.runner_request_contract.allows_raw_payload = true;
    recomputeDryRunnerKey(request);
    expectValidatorFails(request, 'request-contract-redacted-local-only');

    const expired = clone(build());
    expired.runtime_dry_runner_contract_report.runner_request_contract.request_example.expires_at = '2000-01-01T00:00:00.000Z';
    recomputeDryRunnerKey(expired);
    expectValidatorFails(expired, 'request-contract-redacted-local-only');

    const response = clone(build());
    response.runtime_dry_runner_contract_report.runner_response_contract.executes_request = true;
    recomputeDryRunnerKey(response);
    expectValidatorFails(response, 'response-contract-status-preview-only');
  });

  test('validator rejects missing enum, replay side effects, listener/network, telemetry write, fake proof, and direct target', () => {
    const missingEnum = clone(build());
    missingEnum.runtime_dry_runner_contract_report.dry_run_result_enums.allowed_results =
      missingEnum.runtime_dry_runner_contract_report.dry_run_result_enums.allowed_results.filter((result) => result !== 'unsafe_action_rejected');
    recomputeDryRunnerKey(missingEnum);
    expectValidatorFails(missingEnum, 'dry-run-result-enums-complete');

    const replay = clone(build());
    replay.runtime_dry_runner_contract_report.idempotency_replay_rules.replay_executes_side_effects = true;
    recomputeDryRunnerKey(replay);
    expectValidatorFails(replay, 'idempotency-replay-rules-fail-closed');

    const boundary = clone(build());
    boundary.runtime_dry_runner_contract_report.local_in_process_boundary.listener_opened_now = true;
    boundary.runtime_dry_runner_contract_report.local_in_process_boundary.network_performed_now = true;
    recomputeDryRunnerKey(boundary);
    expectValidatorFails(boundary, 'local-boundary-no-listener-network');

    const telemetry = clone(build());
    telemetry.runtime_dry_runner_contract_report.telemetry_audit_preview.audit_write_now = true;
    recomputeDryRunnerKey(telemetry);
    expectValidatorFails(telemetry, 'telemetry-audit-preview-only');

    const proof = clone(build());
    proof.runtime_dry_runner_contract_report.proof_boundaries.runner_contract_is_runtime_proof = true;
    proof.runtime_dry_runner_contract_report.proof_boundaries.serverCanExecuteLocal = true;
    recomputeDryRunnerKey(proof);
    expectValidatorFails(proof, 'proof-boundaries-false');

    const target = clone(build());
    target.runtime_dry_runner_contract_report.target_boundaries.builder_direct_server_target_allowed = true;
    recomputeDryRunnerKey(target);
    expectValidatorFails(target, 'direct-builder-oracle-targets-blocked');
  });

  test('validator rejects side-effect lies, unsafe drift across scanned surfaces, Tier3 recommendations, and validation reason drift', () => {
    const sideEffect = clone(build());
    sideEffect.runtime_dry_runner_contract_report.side_effect_result.no_runner_executed = false;
    sideEffect.runtime_dry_runner_contract_report.side_effect_result.runnerExecuted = true;
    recomputeDryRunnerKey(sideEffect);
    expectValidatorFails(sideEffect, 'side-effects-blocked-now');

    for (const phrase of [
      'send email to customer',
      'email a client',
      'message the client',
      'send message to client',
      'customer email',
      'client email',
      'approve deploy',
      'move money',
      'external send',
      'capture screen',
      'memory commit',
      'execute shell',
      'tier3 trade',
    ]) {
      const unsafe = clone(build());
      unsafe.runtime_dry_runner_contract_report.runner_request_contract.payload_summary_example = phrase;
      recomputeDryRunnerKey(unsafe);
      expectValidatorFails(unsafe, 'unsafe-action-drift-blocked');
    }

    const validationReason = clone(build());
    validationReason.validation_report.reasons = ['send email to customer'];
    expectValidatorFails(validationReason, 'unsafe-action-drift-blocked');

    const tier = clone(build());
    tier.runtime_dry_runner_contract_report.next_phase_recommendations[0].tier = 'Tier3';
    recomputeDryRunnerKey(tier);
    expectValidatorFails(tier, 'next-recommendations-tier0-tier1-only');
  });

  test('validator rejects forbidden raw/private/runtime/proof strings in values', () => {
    for (const forbidden of [
      'bearer token',
      'api key',
      'private key',
      'session secret',
      'raw terminal',
      'raw screenshot',
      'browser cookie',
      'customer private',
      'decrypted payload',
      'runtime started',
      'runner executed',
      'server started',
      'listener bound',
      'network request sent',
      'database write',
      'store write',
      'file written',
      'audit write',
      'telemetry write',
      'output file written',
      'queue created',
      'lease created',
      'local execution performed',
      'shell executed',
      'PTY executed',
      'customer send performed',
      'external send performed',
      'deploy performed',
      'trade performed',
      'runtime is available',
      'runner is available',
      'socket proves bridge green',
      'delivery acceptance proves model processing',
    ]) {
      const tampered = clone(build());
      tampered.runtime_dry_runner_contract_report.next_phase_recommendations[0].why_safe = forbidden;
      recomputeDryRunnerKey(tampered);
      expectValidatorFails(tampered, 'no-raw-private-secret-output');
      expectValidatorFails(tampered, 'forbidden-output-strings-absent');
    }
  });

  test('CLI is stdout-only, consumes the Oracle fixture, and ignores output-file flags', () => {
    const parsed = parseArgs(['--pretty', '--out', 'ignored.json']);
    expect(parsed.pretty).toBe(true);
    expect(parsed.fixturePath).toContain('mira-core-runtime-dry-runner-contract.json');

    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const output = main(['--out=ignored.json'], JSON.stringify({
      profile: { name: 'main' },
      sessionId: 'session-cli',
      deviceId: 'VIGIL',
    }));

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(dryRunnerReport(output).schema).toBe(RUNTIME_DRY_RUNNER_REPORT_SCHEMA_VERSION);
    expect(dryRunnerReport(output).sessionId).toBe('session-cli');
    expect(dryRunnerReport(output).baseline_commit).toBe(BASELINE_COMMIT);
    expect(dryRunnerReport(output).phase_31_dependency.commit).toBe(BASELINE_COMMIT);
    expect(dryRunnerReport(output).runner_id).toBe(RUNNER_ID);
    expect(dryRunnerReport(output).runner_decision).toBe('remain_disabled_dry_runner_contract_only');
    expect(dryRunnerReport(output).runtime_started).toBe(false);
    expect(dryRunnerReport(output).runner_executed).toBe(false);
    expect(dryRunnerReport(output).runner_available_now).toBe(false);
    expect(dryRunnerReport(output).proof_boundaries.serverCanExecuteLocal).toBe(false);
    expect(dryRunnerReport(output).target_boundaries.builder_direct_server_target_allowed).toBe(false);
    expect(dryRunnerReport(output).target_boundaries.oracle_direct_server_target_allowed).toBe(false);
    expect(dryRunnerReport(output).dry_run_result_enums.allowed_results).toHaveLength(12);
    expect(dryRunnerReport(output).side_effect_result.no_output_file_written).toBe(true);
    expect(dryRunnerReport(output).side_effect_result.outputFilesWritten).toBe(0);
    expect(validationReport(output).decision).toBe('accepted_validation_only');
    expect(validateMiraCoreRuntimeDryRunnerOutput(output, runtimeDryRunnerContract)).toEqual(expect.objectContaining({ ok: true }));
  });
});
