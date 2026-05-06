const runtimeControlPathContract = require('./fixtures/mira-core-runtime-control-path-contract.json');
const {
  BASELINE_COMMIT,
  DEFAULT_BLOCKED_SIDE_EFFECT_IDS,
  DEFAULT_DECISIONS,
  DEFAULT_NEXT_SAFE_ACTION_IDS,
  DEFAULT_PHASE29_PREREQUISITE_GATE_IDS,
  DEFAULT_TAMPER_CASE_IDS,
  GATE_ID,
  PHASE29_COMMIT,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_REPORT_FIELDS,
  REQUIRED_SIDE_EFFECT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  RUNTIME_CONTROL_PATH_REPORT_SCHEMA_VERSION,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreRuntimeControlPath,
  runtimeControlPathIdempotencyKey,
  validateMiraCoreRuntimeControlPathOutput,
} = require('../modules/mira-core/runtime-control-path');
const {
  main,
  parseArgs,
} = require('../scripts/hm-mira-core-runtime-control-path');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function build(inputSignals = {}) {
  return buildMiraCoreRuntimeControlPath({
    contract: runtimeControlPathContract,
    inputSignals,
    nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
  });
}

function controlPathReport(output) {
  return output.runtime_control_path_report;
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
  expect(() => assertNoForbiddenOutput(output, runtimeControlPathContract.forbiddenOutputSubstrings)).not.toThrow();
}

function expectValidatorFails(output, checkId) {
  const validation = validateMiraCoreRuntimeControlPathOutput(output, runtimeControlPathContract);
  expect(validation.ok).toBe(false);
  expect(validation.checks.find((entry) => entry.id === checkId)).toEqual(expect.objectContaining({ ok: false }));
}

function recomputeControlPathKey(output) {
  output.runtime_control_path_report.idempotency_key = runtimeControlPathIdempotencyKey(output.runtime_control_path_report);
}

describe('mira core runtime control-path assessment v0', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('satisfies Oracle output, control-path report, and validation report shapes', () => {
    const output = build();
    const report = controlPathReport(output);
    const validation = validationReport(output);

    expectRequiredFields(output, runtimeControlPathContract.expectedOutputShape.requiredTopLevelFields);
    expect(runtimeControlPathContract.expectedOutputShape.requiredTopLevelFields).toEqual(REQUIRED_OUTPUT_FIELDS);
    expect(report.schema).toBe(RUNTIME_CONTROL_PATH_REPORT_SCHEMA_VERSION);
    expect(validation.schema).toBe(VALIDATION_REPORT_SCHEMA_VERSION);
    expectRequiredFields(report, runtimeControlPathContract.expectedRuntimeControlPathReportShape.requiredFields);
    expect(runtimeControlPathContract.expectedRuntimeControlPathReportShape.requiredFields).toEqual(REQUIRED_REPORT_FIELDS);
    expectRequiredFields(validation, runtimeControlPathContract.expectedValidationReportShape.requiredFields);
    expect(runtimeControlPathContract.expectedValidationReportShape.requiredFields).toEqual(REQUIRED_VALIDATION_REPORT_FIELDS);
    expect(validateMiraCoreRuntimeControlPathOutput(output, runtimeControlPathContract)).toEqual(expect.objectContaining({ ok: true }));
    expect(validation.decision).toBe('accepted');
    expectNoForbiddenOutput(output);
  });

  test('pins baseline, Phase 29 dependency, gate identity, and default contract-only decision', () => {
    const report = controlPathReport(build());
    const dependency = report.phase_29_dependency;
    const expected = runtimeControlPathContract.expectedRuntimeControlPathReportShape;

    expect(report.baseline_commit).toBe(BASELINE_COMMIT);
    expect(BASELINE_COMMIT).toBe(runtimeControlPathContract.baseline.commit);
    expectRequiredFields(dependency, expected.phase29DependencyRequiredFields);
    expect(dependency).toEqual(expect.objectContaining(expected.phase29DependencyRequiredValues));
    expect(dependency.commit).toBe(PHASE29_COMMIT);
    expect(report.gate_id).toBe(GATE_ID);
    expect(report.gate_status).toBe('contract_ready_validation_only');
    expect(report.control_path_decision).toBe('remain_control_path_contract_only');
    expect(report.control_path_decision_allowed_values).toEqual(DEFAULT_DECISIONS);
    expect(report.eligible_is_authorization).toBe(false);
    expect(report.eligible_is_runtime_proof).toBe(false);
    expect(report.runtime_available_now).toBe(false);
    expect(report.runtime_started).toBe(false);
  });

  test('eligible future control-path state remains non-authorizing and not proof', () => {
    const report = controlPathReport(build({
      controlPathDecision: 'eligible_for_future_disabled_local_control_path_validation',
    }));

    expect(report.control_path_decision).toBe('eligible_for_future_disabled_local_control_path_validation');
    expect(report.eligible_is_authorization).toBe(false);
    expect(report.eligible_is_runtime_proof).toBe(false);
    expect(report.runtime_available_now).toBe(false);
    expect(report.runtime_started).toBe(false);
    expect(validateMiraCoreRuntimeControlPathOutput({
      runtime_control_path_report: report,
      validation_report: validationReport(build()),
    }, runtimeControlPathContract).ok).toBe(false);
  });

  test('runtime flag reader, kill switch, request/response shapes, and local boundary match contract', () => {
    const report = controlPathReport(build());
    const expected = runtimeControlPathContract.expectedRuntimeControlPathReportShape;

    expectRequiredFields(report.runtime_mode_flag_reader, expected.runtimeModeFlagReaderRequiredFields);
    expect(report.runtime_mode_flag_reader.flag_id).toBe('MIRA_CORE_RUNTIME_DRY_RUN_MODE');
    expect(report.runtime_mode_flag_reader.default_state).toBe('disabled');
    expect(report.runtime_mode_flag_reader.default_enabled).toBe(false);
    expect(report.runtime_mode_flag_reader.dev_only).toBe(true);
    expect(report.runtime_mode_flag_reader.local_only).toBe(true);
    expect(report.runtime_mode_flag_reader.operator_visible).toBe(true);
    expect(report.runtime_mode_flag_reader.non_authorizing).toBe(true);
    expect(report.runtime_mode_flag_reader.invalid_value_behavior).toBe('fail_closed_to_status_preview');
    expect(report.runtime_mode_flag_reader.reads_env_secret).toBe(false);
    expect(report.runtime_mode_flag_reader.starts_runtime).toBe(false);
    expectRequiredFields(report.kill_switch_check, expected.killSwitchCheckRequiredFields);
    expect(report.kill_switch_check.default_state).toBe('engaged');
    expect(report.kill_switch_check.fail_closed).toBe(true);
    expect(report.kill_switch_check.ignored_allowed).toBe(false);
    expect(report.kill_switch_check.side_effect_on_check).toBe(false);
    expect(report.kill_switch_check.authorizes_runtime).toBe(false);
    expectRequiredFields(report.dry_run_request_shape, expected.dryRunRequestShapeRequiredFields);
    expect(report.dry_run_request_shape.validation_only).toBe(true);
    expect(report.dry_run_request_shape.idempotent).toBe(true);
    expect(report.dry_run_request_shape.redacted_payload_only).toBe(true);
    expect(report.dry_run_request_shape.allows_raw_payload).toBe(false);
    expectRequiredFields(report.dry_run_response_shape, expected.dryRunResponseShapeRequiredFields);
    expect(report.dry_run_response_shape.status_preview_only).toBe(true);
    expect(report.dry_run_response_shape.executes_local_work).toBe(false);
    expect(report.dry_run_response_shape.creates_queue_or_lease).toBe(false);
    expect(report.dry_run_response_shape.writes_store_or_file).toBe(false);
    expectRequiredFields(report.local_boundary, expected.localBoundaryRequiredFields);
    expect(report.local_boundary.allowed_hosts).toEqual(['127.0.0.1', '::1', 'localhost']);
    expect(report.local_boundary.loopback_only).toBe(true);
    expect(report.local_boundary.listener_opened_now).toBe(false);
    expect(report.local_boundary.network_performed_now).toBe(false);
  });

  test('operator status, rollback, telemetry, and reference dependencies remain preview/reference-only', () => {
    const report = controlPathReport(build());
    const expected = runtimeControlPathContract.expectedRuntimeControlPathReportShape;

    expectRequiredFields(report.operator_status_summary, expected.operatorStatusSummaryRequiredFields);
    expect(report.operator_status_summary.visible).toBe(true);
    expect(report.operator_status_summary.status_only).toBe(true);
    expect(report.operator_status_summary.authorizes_runtime).toBe(false);
    expect(report.operator_status_summary.includes_mode).toBe(true);
    expect(report.operator_status_summary.includes_kill_switch).toBe(true);
    expectRequiredFields(report.rollback_disable_behavior, expected.rollbackDisableBehaviorRequiredFields);
    expect(report.rollback_disable_behavior.disable_idempotent).toBe(true);
    expect(report.rollback_disable_behavior.deletes_data).toBe(false);
    expect(report.rollback_disable_behavior.resurrects_blocked_state).toBe(false);
    expect(report.rollback_disable_behavior.disable_authorizes_runtime).toBe(false);
    expectRequiredFields(report.telemetry_audit_preview, expected.telemetryAuditPreviewRequiredFields);
    expect(report.telemetry_audit_preview.redacted_preview_only).toBe(true);
    expect(report.telemetry_audit_preview.raw_payload_allowed).toBe(false);
    expect(report.telemetry_audit_preview.sink_reference_only).toBe(true);
    expect(report.telemetry_audit_preview.store_write_now).toBe(false);
    expect(report.telemetry_audit_preview.file_write_now).toBe(false);
    expect(report.telemetry_audit_preview.db_write_now).toBe(false);
    expectRequiredFields(report.reference_only_dependencies, expected.referenceOnlyDependencyRequiredFields);
    expect(report.reference_only_dependencies.config_ref.reference_only).toBe(true);
    expect(report.reference_only_dependencies.auth_ref.reference_only).toBe(true);
    expect(report.reference_only_dependencies.key_ref.reference_only).toBe(true);
    expect(report.reference_only_dependencies.storage_ref.reference_only).toBe(true);
    expect(report.reference_only_dependencies.raw_path_allowed).toBe(false);
    expect(report.reference_only_dependencies.raw_secret_allowed).toBe(false);
    expect(report.reference_only_dependencies.env_secret_read).toBe(false);
  });

  test('Phase 29 gates, proof, targets, blocked effects, tamper coverage, and next actions match fixture', () => {
    const output = build();
    const report = controlPathReport(output);
    const expected = runtimeControlPathContract.expectedRuntimeControlPathReportShape;

    expect(report.phase29_prerequisite_gate_status.map((entry) => entry.gate_id)).toEqual(DEFAULT_PHASE29_PREREQUISITE_GATE_IDS);
    expect(DEFAULT_PHASE29_PREREQUISITE_GATE_IDS).toEqual(expected.phase29PrerequisiteGateRequiredIds);
    expect(report.phase29_prerequisite_gate_status).toHaveLength(9);
    expect(report.phase29_prerequisite_gate_status.every((entry) => entry.status === 'defined_for_future_control_path_validation'
      && entry.satisfies_phase29_now === false
      && entry.authorizes_runtime === false
      && entry.requires_builder_implementation_test === true)).toBe(true);
    expect(report.proof_boundaries.runtime_mode_flag_is_runtime_proof).toBe(false);
    expect(report.proof_boundaries.kill_switch_check_is_runtime_proof).toBe(false);
    expect(report.proof_boundaries.dry_run_response_is_live_execution_proof).toBe(false);
    expect(report.proof_boundaries.control_path_present_is_runtime_proof).toBe(false);
    expect(report.proof_boundaries.socket_is_bridge_green_proof).toBe(false);
    expect(report.proof_boundaries.delivery_acceptance_is_model_processing_proof).toBe(false);
    expect(report.proof_boundaries.serverCanExecuteLocal).toBe(false);
    expect(report.target_boundaries.allowed_server_originated_target).toBe('architect');
    expect(report.target_boundaries.builder_direct_server_target_allowed).toBe(false);
    expect(report.target_boundaries.oracle_direct_server_target_allowed).toBe(false);
    expect(report.target_boundaries.local_architect_acceptance_required).toBe(true);
    expect(report.blocked_side_effects.map((entry) => entry.effect_id)).toEqual(DEFAULT_BLOCKED_SIDE_EFFECT_IDS);
    expect(report.tamper_case_coverage.map((entry) => entry.tamper_case_id)).toEqual(DEFAULT_TAMPER_CASE_IDS);
    expect(DEFAULT_TAMPER_CASE_IDS).toEqual(runtimeControlPathContract.tamperCases.map((entry) => entry.id));
    expect(report.next_safe_actions.map((entry) => entry.action_id)).toEqual(DEFAULT_NEXT_SAFE_ACTION_IDS);
    const checkIds = validateMiraCoreRuntimeControlPathOutput(output, runtimeControlPathContract).checks.map((entry) => entry.id);
    for (const rule of runtimeControlPathContract.staticValidationRules) {
      expect(checkIds).toContain(rule.id);
    }
    expect(validationReport(output).acceptance_checks.map((entry) => entry.id)).toEqual(runtimeControlPathContract.acceptanceChecks.map((entry) => entry.id));
  });

  test('side-effect truth stays explicit and all counters remain zero', () => {
    const output = build();
    const report = controlPathReport(output);
    const validation = validationReport(output);

    for (const field of REQUIRED_SIDE_EFFECT_FIELDS) {
      expect(report.side_effect_result[field]).toBe(true);
      expect(validation.side_effect_result[field]).toBe(true);
    }
    for (const field of [
      'runtimeAttempts',
      'serverAttempts',
      'listenerRouteAttempts',
      'networkRequestsAttempted',
      'databaseWritesAttempted',
      'storeWritesAttempted',
      'fileWritesAttempted',
      'migrationsAttempted',
      'queuesCreated',
      'leasesCreated',
      'authChangesAttempted',
      'keySecretOperationsAttempted',
      'localExecutionAttempted',
      'sendsAttempted',
      'deploysAttempted',
      'tradesAttempted',
      'outputFilesWritten',
    ]) {
      expect(report.side_effect_result[field]).toBe(0);
    }
    expect(report.side_effect_result.outputFileWritten).toBe(false);
    expect(validation.side_effect_result.outputFileWritten).toBe(false);
  });

  test('idempotency is stable for equivalent inputs and sensitive to control-path inputs', () => {
    const first = controlPathReport(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'VIGIL' }));
    const second = controlPathReport(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'VIGIL' }));
    const changedDevice = controlPathReport(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'ALT' }));

    expect(first.idempotency_key).toBe(second.idempotency_key);
    expect(first.control_path_report_id).toBe(second.control_path_report_id);
    expect(first.idempotency_key).not.toBe(changedDevice.idempotency_key);

    const changed = clone(build());
    const originalKey = changed.runtime_control_path_report.idempotency_key;
    changed.runtime_control_path_report.kill_switch_check.fail_closed = false;
    recomputeControlPathKey(changed);
    expect(changed.runtime_control_path_report.idempotency_key).not.toBe(originalKey);
    expectValidatorFails(changed, 'kill-switch-check-fail-closed-testable');
  });

  test('validator rejects stale baseline and stale Phase 29 dependency', () => {
    const staleBaseline = clone(build());
    staleBaseline.runtime_control_path_report.baseline_commit = 'd4aa1a5';
    recomputeControlPathKey(staleBaseline);
    expectValidatorFails(staleBaseline, 'baseline-8084b29-current');
    expectValidatorFails(staleBaseline, 'stale-baseline-rejected');

    const staleDependency = clone(build());
    staleDependency.runtime_control_path_report.phase_29_dependency.commit = 'd4aa1a5';
    staleDependency.runtime_control_path_report.phase_29_dependency.status = 'stale';
    recomputeControlPathKey(staleDependency);
    expectValidatorFails(staleDependency, 'phase29-dependency-current');
    expectValidatorFails(staleDependency, 'stale-phase29-dependency-rejected');
  });

  test('validator rejects eligible-as-authorization and default-on runtime flag reader', () => {
    const eligible = clone(build({
      controlPathDecision: 'eligible_for_future_disabled_local_control_path_validation',
    }));
    eligible.runtime_control_path_report.eligible_is_authorization = true;
    eligible.runtime_control_path_report.eligible_is_runtime_proof = true;
    eligible.runtime_control_path_report.runtime_available_now = true;
    recomputeControlPathKey(eligible);
    expectValidatorFails(eligible, 'eligible-control-path-non-authorizing');
    expectValidatorFails(eligible, 'eligible-as-authorization-rejected');

    const flag = clone(build());
    flag.runtime_control_path_report.runtime_mode_flag_reader.default_enabled = true;
    flag.runtime_control_path_report.runtime_mode_flag_reader.starts_runtime = true;
    flag.runtime_control_path_report.runtime_started = true;
    recomputeControlPathKey(flag);
    expectValidatorFails(flag, 'runtime-mode-flag-reader-disabled-local-dev-visible');
    expectValidatorFails(flag, 'default-on-runtime-flag-rejected');
  });

  test('validator rejects missing kill switch, raw request payload, and response overclaims', () => {
    const missing = clone(build());
    delete missing.runtime_control_path_report.kill_switch_check;
    recomputeControlPathKey(missing);
    expectValidatorFails(missing, 'kill-switch-check-fail-closed-testable');
    expectValidatorFails(missing, 'missing-kill-switch-rejected');

    const request = clone(build());
    request.runtime_control_path_report.dry_run_request_shape.allows_raw_payload = true;
    request.runtime_control_path_report.dry_run_request_shape.redacted_payload_only = false;
    recomputeControlPathKey(request);
    expectValidatorFails(request, 'dry-run-request-shape-safe');
    expectValidatorFails(request, 'raw-request-payload-rejected');

    const response = clone(build());
    response.runtime_control_path_report.dry_run_response_shape.executes_local_work = true;
    response.runtime_control_path_report.dry_run_response_shape.creates_queue_or_lease = true;
    response.runtime_control_path_report.dry_run_response_shape.writes_store_or_file = true;
    recomputeControlPathKey(response);
    expectValidatorFails(response, 'dry-run-response-shape-preview-only');
    expectValidatorFails(response, 'response-execution-overclaim-rejected');
  });

  test('validator rejects non-loopback boundary, telemetry writes, and raw reference leaks', () => {
    const boundary = clone(build());
    boundary.runtime_control_path_report.local_boundary.allowed_hosts = ['0.0.0.0'];
    boundary.runtime_control_path_report.local_boundary.public_interface_allowed = true;
    boundary.runtime_control_path_report.local_boundary.listener_opened_now = true;
    boundary.runtime_control_path_report.local_boundary.network_performed_now = true;
    recomputeControlPathKey(boundary);
    expectValidatorFails(boundary, 'local-boundary-in-process-or-loopback-only');
    expectValidatorFails(boundary, 'non-loopback-boundary-rejected');

    const telemetry = clone(build());
    telemetry.runtime_control_path_report.telemetry_audit_preview.store_write_now = true;
    telemetry.runtime_control_path_report.telemetry_audit_preview.raw_payload_allowed = true;
    recomputeControlPathKey(telemetry);
    expectValidatorFails(telemetry, 'telemetry-audit-preview-only');
    expectValidatorFails(telemetry, 'telemetry-write-or-raw-payload-rejected');

    const refs = clone(build());
    refs.runtime_control_path_report.reference_only_dependencies.raw_path_allowed = true;
    refs.runtime_control_path_report.reference_only_dependencies.raw_secret_allowed = true;
    refs.runtime_control_path_report.reference_only_dependencies.env_secret_read = true;
    recomputeControlPathKey(refs);
    expectValidatorFails(refs, 'reference-only-dependencies-safe');
    expectValidatorFails(refs, 'raw-secret-path-leak-rejected');
  });

  test('validator rejects fake proof, direct Builder/Oracle targets, missing gates, and satisfied gates', () => {
    const proof = clone(build());
    proof.runtime_control_path_report.proof_boundaries.runtime_mode_flag_is_runtime_proof = true;
    proof.runtime_control_path_report.proof_boundaries.control_path_present_is_runtime_proof = true;
    proof.runtime_control_path_report.proof_boundaries.socket_is_bridge_green_proof = true;
    proof.runtime_control_path_report.proof_boundaries.delivery_acceptance_is_model_processing_proof = true;
    proof.runtime_control_path_report.proof_boundaries.serverCanExecuteLocal = true;
    recomputeControlPathKey(proof);
    expectValidatorFails(proof, 'proof-boundaries-preserved');
    expectValidatorFails(proof, 'fake-proof-rejected');

    const target = clone(build());
    target.runtime_control_path_report.target_boundaries.builder_direct_server_target_allowed = true;
    target.runtime_control_path_report.target_boundaries.oracle_direct_server_target_allowed = true;
    target.runtime_control_path_report.target_boundaries.local_architect_acceptance_required = false;
    recomputeControlPathKey(target);
    expectValidatorFails(target, 'direct-builder-oracle-targets-blocked');

    const missing = clone(build());
    missing.runtime_control_path_report.phase29_prerequisite_gate_status = missing.runtime_control_path_report.phase29_prerequisite_gate_status.slice(1);
    recomputeControlPathKey(missing);
    expectValidatorFails(missing, 'phase29-prerequisite-gates-complete');
    expectValidatorFails(missing, 'missing-phase29-prerequisite-gate-rejected');

    const mismapped = clone(build());
    mismapped.runtime_control_path_report.phase29_prerequisite_gate_status[0].maps_from_phase29_prerequisite = 'bogus';
    recomputeControlPathKey(mismapped);
    expectValidatorFails(mismapped, 'phase29-prerequisite-gates-complete');

    const satisfied = clone(build());
    satisfied.runtime_control_path_report.phase29_prerequisite_gate_status[0].satisfies_phase29_now = true;
    satisfied.runtime_control_path_report.phase29_prerequisite_gate_status[0].authorizes_runtime = true;
    recomputeControlPathKey(satisfied);
    expectValidatorFails(satisfied, 'phase29-prerequisites-not-satisfied-now');
    expectValidatorFails(satisfied, 'phase29-prerequisite-satisfied-now-rejected');
  });

  test('validator rejects unsafe action drift and side-effect lies', () => {
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
      const tampered = clone(build());
      tampered.runtime_control_path_report.next_safe_actions[0].title = phrase;
      tampered.runtime_control_path_report.next_safe_actions[0].why_safe = `safe to ${phrase}`;
      recomputeControlPathKey(tampered);
      expectValidatorFails(tampered, 'unsafe-action-drift-rejected');
    }

    const requestDrift = clone(build());
    requestDrift.runtime_control_path_report.dry_run_request_shape.required_fields.push('send customer email');
    recomputeControlPathKey(requestDrift);
    expectValidatorFails(requestDrift, 'unsafe-action-drift-rejected');

    const sideEffect = clone(build());
    sideEffect.runtime_control_path_report.side_effect_result.no_output_file_written = false;
    sideEffect.runtime_control_path_report.side_effect_result.outputFilesWritten = 1;
    recomputeControlPathKey(sideEffect);
    expectValidatorFails(sideEffect, 'side-effect-truth-all-blocked');

    const validationLie = clone(build());
    validationLie.validation_report.side_effect_result.no_output_file_written = false;
    validationLie.validation_report.side_effect_result.outputFilesWritten = 1;
    expectValidatorFails(validationLie, 'validation-report-side-effect-truth');
  });

  test('validator rejects forbidden raw/private/runtime/proof strings in values', () => {
    for (const forbidden of [
      'runtime authorized',
      'runtime available now',
      'runtime started',
      'live runtime',
      'control path authorizes runtime',
      'eligible authorizes runtime',
      'server started',
      'listener bound',
      'network request performed',
      '0.0.0.0',
      'port opened',
      'queue created',
      'lease created',
      'secret read',
      'env secret read',
      'raw path',
      'local execution performed',
      'shell executed',
      'customer send performed',
      'customer email sent',
      'client message sent',
      'external send performed',
      'deploy performed',
      'trade performed',
      'money moved',
      'output file written',
      'runtime flag proves runtime',
      'control path proves runtime',
      'socket proves bridge green',
      'delivery acceptance proves model processing',
      'server can execute local arms',
      'direct builder target allowed',
      'direct oracle target allowed',
      'raw terminal scrollback',
      'raw browser state',
      'raw screenshot',
      'raw ocr',
      'raw customer private',
      'side-profile payload',
      'source-store payload',
      'bearer token',
      'session secret',
      'private key',
      'plaintext payload',
      'ciphertext payload',
      'decrypted payload',
    ]) {
      const tampered = clone(build());
      tampered.runtime_control_path_report.next_safe_actions[0].why_safe = forbidden;
      recomputeControlPathKey(tampered);
      expectValidatorFails(tampered, 'forbidden-output-strings-absent');
    }
  });

  test('CLI is stdout-only, consumes the Oracle fixture, and ignores output-file flags', () => {
    const parsed = parseArgs(['--pretty', '--out', 'ignored.json']);
    expect(parsed.pretty).toBe(true);
    expect(parsed.fixturePath).toContain('mira-core-runtime-control-path-contract.json');

    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const output = main(['--out=ignored.json'], JSON.stringify({
      profile: { name: 'main' },
      sessionId: 'session-cli',
      deviceId: 'VIGIL',
    }));

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(controlPathReport(output).schema).toBe(RUNTIME_CONTROL_PATH_REPORT_SCHEMA_VERSION);
    expect(controlPathReport(output).sessionId).toBe('session-cli');
    expect(controlPathReport(output).baseline_commit).toBe(BASELINE_COMMIT);
    expect(controlPathReport(output).phase_29_dependency.commit).toBe(PHASE29_COMMIT);
    expect(controlPathReport(output).gate_id).toBe(GATE_ID);
    expect(controlPathReport(output).control_path_decision).toBe('remain_control_path_contract_only');
    expect(controlPathReport(output).runtime_available_now).toBe(false);
    expect(controlPathReport(output).runtime_started).toBe(false);
    expect(controlPathReport(output).proof_boundaries.serverCanExecuteLocal).toBe(false);
    expect(controlPathReport(output).target_boundaries.builder_direct_server_target_allowed).toBe(false);
    expect(controlPathReport(output).target_boundaries.oracle_direct_server_target_allowed).toBe(false);
    expect(controlPathReport(output).side_effect_result.no_runtime_performed).toBe(true);
    expect(controlPathReport(output).side_effect_result.no_output_file_written).toBe(true);
    expect(controlPathReport(output).side_effect_result.outputFileWritten).toBe(false);
    expect(validationReport(output).decision).toBe('accepted');
    expect(validateMiraCoreRuntimeControlPathOutput(output, runtimeControlPathContract)).toEqual(expect.objectContaining({ ok: true }));
  });
});
