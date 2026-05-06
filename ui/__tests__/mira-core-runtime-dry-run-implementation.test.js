const runtimeDryRunImplementationContract = require('./fixtures/mira-core-runtime-dry-run-implementation-contract.json');
const {
  BASELINE_COMMIT,
  DEFAULT_BLOCKED_SIDE_EFFECT_IDS,
  DEFAULT_DECISIONS,
  DEFAULT_NEXT_SAFE_ACTION_IDS,
  DEFAULT_PHASE28_PREREQUISITE_IDS,
  DEFAULT_TAMPER_CASE_IDS,
  PHASE28_COMMIT,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_REPORT_FIELDS,
  REQUIRED_SIDE_EFFECT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  RUNTIME_DRY_RUN_IMPLEMENTATION_REPORT_SCHEMA_VERSION,
  SLICE_ID,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreRuntimeDryRunImplementation,
  runtimeDryRunImplementationIdempotencyKey,
  validateMiraCoreRuntimeDryRunImplementationOutput,
} = require('../modules/mira-core/runtime-dry-run-implementation');
const {
  main,
  parseArgs,
} = require('../scripts/hm-mira-core-runtime-dry-run-implementation');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function build(inputSignals = {}) {
  return buildMiraCoreRuntimeDryRunImplementation({
    contract: runtimeDryRunImplementationContract,
    inputSignals,
    nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
  });
}

function implementationReport(output) {
  return output.runtime_dry_run_implementation_report;
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
  expect(() => assertNoForbiddenOutput(output, runtimeDryRunImplementationContract.forbiddenOutputSubstrings)).not.toThrow();
}

function expectValidatorFails(output, checkId) {
  const validation = validateMiraCoreRuntimeDryRunImplementationOutput(output, runtimeDryRunImplementationContract);
  expect(validation.ok).toBe(false);
  expect(validation.checks.find((entry) => entry.id === checkId)).toEqual(expect.objectContaining({ ok: false }));
}

function recomputeImplementationKey(output) {
  output.runtime_dry_run_implementation_report.idempotency_key = runtimeDryRunImplementationIdempotencyKey(output.runtime_dry_run_implementation_report);
}

describe('mira core runtime dry-run implementation assessment v0', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('satisfies Oracle output, implementation report, and validation report shapes', () => {
    const output = build();
    const report = implementationReport(output);
    const validation = validationReport(output);

    expectRequiredFields(output, runtimeDryRunImplementationContract.expectedOutputShape.requiredTopLevelFields);
    expect(runtimeDryRunImplementationContract.expectedOutputShape.requiredTopLevelFields).toEqual(REQUIRED_OUTPUT_FIELDS);
    expect(report.schema).toBe(RUNTIME_DRY_RUN_IMPLEMENTATION_REPORT_SCHEMA_VERSION);
    expect(validation.schema).toBe(VALIDATION_REPORT_SCHEMA_VERSION);
    expectRequiredFields(report, runtimeDryRunImplementationContract.expectedRuntimeDryRunImplementationReportShape.requiredFields);
    expect(runtimeDryRunImplementationContract.expectedRuntimeDryRunImplementationReportShape.requiredFields).toEqual(REQUIRED_REPORT_FIELDS);
    expectRequiredFields(validation, runtimeDryRunImplementationContract.expectedValidationReportShape.requiredFields);
    expect(runtimeDryRunImplementationContract.expectedValidationReportShape.requiredFields).toEqual(REQUIRED_VALIDATION_REPORT_FIELDS);
    expect(validateMiraCoreRuntimeDryRunImplementationOutput(output, runtimeDryRunImplementationContract)).toEqual(expect.objectContaining({ ok: true }));
    expect(validation.decision).toBe('accepted');
    expectNoForbiddenOutput(output);
  });

  test('pins baseline, Phase 28 dependency, slice identity, and default contract-only decision', () => {
    const report = implementationReport(build());
    const dependency = report.phase_28_dependency;
    const expected = runtimeDryRunImplementationContract.expectedRuntimeDryRunImplementationReportShape;

    expect(report.baseline_commit).toBe(BASELINE_COMMIT);
    expect(BASELINE_COMMIT).toBe(runtimeDryRunImplementationContract.baseline.commit);
    expectRequiredFields(dependency, expected.phase28DependencyRequiredFields);
    expect(dependency).toEqual(expect.objectContaining(expected.phase28DependencyRequiredValues));
    expect(dependency.commit).toBe(PHASE28_COMMIT);
    expect(report.slice_id).toBe(SLICE_ID);
    expect(report.slice_status).toBe('contract_ready_validation_only');
    expect(report.implementation_decision).toBe('remain_disabled_dry_run_contract_only');
    expect(report.implementation_decision_allowed_values).toEqual(DEFAULT_DECISIONS);
    expect(report.eligible_is_authorization).toBe(false);
    expect(report.eligible_is_runtime_proof).toBe(false);
    expect(report.runtime_available_now).toBe(false);
    expect(report.runtime_started).toBe(false);
  });

  test('eligible future validation state stays non-authorizing and not proof', () => {
    const report = implementationReport(build({ implementationDecision: 'eligible_for_future_disabled_local_dry_run_validation_slice' }));

    expect(report.implementation_decision).toBe('eligible_for_future_disabled_local_dry_run_validation_slice');
    expect(report.eligible_is_authorization).toBe(false);
    expect(report.eligible_is_runtime_proof).toBe(false);
    expect(report.runtime_available_now).toBe(false);
    expect(report.runtime_started).toBe(false);
    expect(validateMiraCoreRuntimeDryRunImplementationOutput({ runtime_dry_run_implementation_report: report, validation_report: validationReport(build()) }, runtimeDryRunImplementationContract).ok).toBe(false);
  });

  test('runtime flag, kill switch, dry-run path, and local binding match disabled contract', () => {
    const report = implementationReport(build());
    const expected = runtimeDryRunImplementationContract.expectedRuntimeDryRunImplementationReportShape;

    expectRequiredFields(report.runtime_mode_flag, expected.runtimeModeFlagRequiredFields);
    expect(report.runtime_mode_flag.flag_id).toBe('MIRA_CORE_RUNTIME_DRY_RUN_MODE');
    expect(report.runtime_mode_flag.default_state).toBe('disabled');
    expect(report.runtime_mode_flag.default_enabled).toBe(false);
    expect(report.runtime_mode_flag.dev_only).toBe(true);
    expect(report.runtime_mode_flag.local_only).toBe(true);
    expect(report.runtime_mode_flag.operator_visible).toBe(true);
    expect(report.runtime_mode_flag.non_authorizing).toBe(true);
    expect(report.runtime_mode_flag.invalid_value_behavior).toBe('fail_closed_to_status_preview');
    expect(report.runtime_mode_flag.runtime_started_when_present).toBe(false);
    expectRequiredFields(report.kill_switch, expected.killSwitchRequiredFields);
    expect(report.kill_switch.default_state).toBe('engaged');
    expect(report.kill_switch.fail_closed).toBe(true);
    expect(report.kill_switch.ignored_allowed).toBe(false);
    expect(report.kill_switch.side_effect_on_toggle).toBe(false);
    expectRequiredFields(report.dry_run_path, expected.dryRunPathRequiredFields);
    expect(report.dry_run_path.path_type).toBe('in_process_status_preview_only');
    expect(report.dry_run_path.preview_only).toBe(true);
    expect(report.dry_run_path.executes_local_work).toBe(false);
    expect(report.dry_run_path.creates_queue_or_lease).toBe(false);
    expect(report.dry_run_path.writes_store_or_file).toBe(false);
    expectRequiredFields(report.local_binding, expected.localBindingRequiredFields);
    expect(report.local_binding.allowed_hosts).toEqual(['127.0.0.1', '::1', 'localhost']);
    expect(report.local_binding.loopback_only).toBe(true);
    expect(report.local_binding.listener_opened_now).toBe(false);
    expect(report.local_binding.network_performed_now).toBe(false);
  });

  test('telemetry, operator status, rollback, and reference-only dependencies remain safe', () => {
    const report = implementationReport(build());
    const expected = runtimeDryRunImplementationContract.expectedRuntimeDryRunImplementationReportShape;

    expectRequiredFields(report.telemetry_audit_preview, expected.telemetryAuditPreviewRequiredFields);
    expect(report.telemetry_audit_preview.redacted_preview_only).toBe(true);
    expect(report.telemetry_audit_preview.raw_payload_allowed).toBe(false);
    expect(report.telemetry_audit_preview.sink_reference_only).toBe(true);
    expect(report.telemetry_audit_preview.store_write_now).toBe(false);
    expect(report.telemetry_audit_preview.file_write_now).toBe(false);
    expect(report.telemetry_audit_preview.db_write_now).toBe(false);
    expectRequiredFields(report.operator_status, expected.operatorStatusRequiredFields);
    expect(report.operator_status.visible).toBe(true);
    expect(report.operator_status.status_only).toBe(true);
    expect(report.operator_status.authorizes_runtime).toBe(false);
    expect(report.operator_status.fields).toEqual(expect.arrayContaining(['mode', 'kill_switch', 'boundary']));
    expectRequiredFields(report.rollback_disable_plan, expected.rollbackDisablePlanRequiredFields);
    expect(report.rollback_disable_plan.disable_idempotent).toBe(true);
    expect(report.rollback_disable_plan.deletes_data).toBe(false);
    expect(report.rollback_disable_plan.resurrects_blocked_state).toBe(false);
    expectRequiredFields(report.reference_only_dependencies, expected.referenceOnlyDependencyRequiredFields);
    expect(report.reference_only_dependencies.config_ref.reference_only).toBe(true);
    expect(report.reference_only_dependencies.auth_ref.reference_only).toBe(true);
    expect(report.reference_only_dependencies.key_ref.reference_only).toBe(true);
    expect(report.reference_only_dependencies.storage_ref.reference_only).toBe(true);
    expect(report.reference_only_dependencies.raw_path_allowed).toBe(false);
    expect(report.reference_only_dependencies.raw_secret_allowed).toBe(false);
    expect(report.reference_only_dependencies.env_secret_read).toBe(false);
  });

  test('Phase 28 prerequisites, proof, targets, blocked effects, tamper coverage, and next actions match fixture', () => {
    const output = build();
    const report = implementationReport(output);
    const expected = runtimeDryRunImplementationContract.expectedRuntimeDryRunImplementationReportShape;

    expect(report.phase28_prerequisite_status.map((entry) => entry.prerequisite_id)).toEqual(DEFAULT_PHASE28_PREREQUISITE_IDS);
    expect(DEFAULT_PHASE28_PREREQUISITE_IDS).toEqual(expected.phase28PrerequisiteRequiredIds);
    expect(report.phase28_prerequisite_status).toHaveLength(9);
    expect(report.phase28_prerequisite_status.every((entry) => entry.status === 'defined_for_future_validation'
      && entry.satisfies_phase28_now === false
      && entry.authorizes_runtime === false
      && entry.requires_builder_implementation_test === true)).toBe(true);
    expect(report.proof_boundaries.runtime_mode_flag_is_runtime_proof).toBe(false);
    expect(report.proof_boundaries.kill_switch_wired_is_runtime_proof).toBe(false);
    expect(report.proof_boundaries.dry_run_response_is_live_execution_proof).toBe(false);
    expect(report.proof_boundaries.socket_is_bridge_green_proof).toBe(false);
    expect(report.proof_boundaries.delivery_acceptance_is_model_processing_proof).toBe(false);
    expect(report.proof_boundaries.serverCanExecuteLocal).toBe(false);
    expect(report.target_boundaries.allowed_server_originated_target).toBe('architect');
    expect(report.target_boundaries.builder_direct_server_target_allowed).toBe(false);
    expect(report.target_boundaries.oracle_direct_server_target_allowed).toBe(false);
    expect(report.target_boundaries.local_architect_acceptance_required).toBe(true);
    expect(report.blocked_side_effects.map((entry) => entry.effect_id)).toEqual(DEFAULT_BLOCKED_SIDE_EFFECT_IDS);
    expect(DEFAULT_BLOCKED_SIDE_EFFECT_IDS).toEqual(expected.blockedSideEffectRequiredIds);
    expect(report.tamper_case_coverage.map((entry) => entry.tamper_case_id)).toEqual(DEFAULT_TAMPER_CASE_IDS);
    expect(DEFAULT_TAMPER_CASE_IDS).toEqual(runtimeDryRunImplementationContract.tamperCases.map((entry) => entry.id));
    expect(report.next_safe_actions.map((entry) => entry.action_id)).toEqual(DEFAULT_NEXT_SAFE_ACTION_IDS);
    const checkIds = validateMiraCoreRuntimeDryRunImplementationOutput(output, runtimeDryRunImplementationContract).checks.map((entry) => entry.id);
    for (const rule of runtimeDryRunImplementationContract.staticValidationRules) {
      expect(checkIds).toContain(rule.id);
    }
    expect(validationReport(output).acceptance_checks.map((entry) => entry.id)).toEqual(runtimeDryRunImplementationContract.acceptanceChecks.map((entry) => entry.id));
  });

  test('side-effect truth stays explicit and all counters remain zero', () => {
    const output = build();
    const report = implementationReport(output);
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

  test('idempotency is stable for equivalent inputs and sensitive to implementation inputs', () => {
    const first = implementationReport(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'VIGIL' }));
    const second = implementationReport(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'VIGIL' }));
    const changedDevice = implementationReport(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'ALT' }));

    expect(first.idempotency_key).toBe(second.idempotency_key);
    expect(first.implementation_report_id).toBe(second.implementation_report_id);
    expect(first.idempotency_key).not.toBe(changedDevice.idempotency_key);

    const changed = clone(build());
    const originalKey = changed.runtime_dry_run_implementation_report.idempotency_key;
    changed.runtime_dry_run_implementation_report.kill_switch.fail_closed = false;
    recomputeImplementationKey(changed);
    expect(changed.runtime_dry_run_implementation_report.idempotency_key).not.toBe(originalKey);
    expectValidatorFails(changed, 'kill-switch-visible-fail-closed-testable');
  });

  test('validator rejects stale baseline and stale Phase 28 dependency', () => {
    const staleBaseline = clone(build());
    staleBaseline.runtime_dry_run_implementation_report.baseline_commit = 'e7a8dbc';
    recomputeImplementationKey(staleBaseline);
    expectValidatorFails(staleBaseline, 'baseline-d4aa1a5-current');
    expectValidatorFails(staleBaseline, 'stale-baseline-rejected');

    const staleDependency = clone(build());
    staleDependency.runtime_dry_run_implementation_report.phase_28_dependency.commit = 'e7a8dbc';
    staleDependency.runtime_dry_run_implementation_report.phase_28_dependency.status = 'stale';
    recomputeImplementationKey(staleDependency);
    expectValidatorFails(staleDependency, 'phase28-dependency-current');
    expectValidatorFails(staleDependency, 'stale-phase28-dependency-rejected');
  });

  test('validator rejects eligible-as-authorization and default-on runtime flag', () => {
    const eligible = clone(build({ implementationDecision: 'eligible_for_future_disabled_local_dry_run_validation_slice' }));
    eligible.runtime_dry_run_implementation_report.eligible_is_authorization = true;
    eligible.runtime_dry_run_implementation_report.eligible_is_runtime_proof = true;
    eligible.runtime_dry_run_implementation_report.runtime_available_now = true;
    recomputeImplementationKey(eligible);
    expectValidatorFails(eligible, 'eligible-future-validation-non-authorizing');
    expectValidatorFails(eligible, 'eligible-as-authorization-rejected');

    const flag = clone(build());
    flag.runtime_dry_run_implementation_report.runtime_mode_flag.default_enabled = true;
    flag.runtime_dry_run_implementation_report.runtime_mode_flag.runtime_started_when_present = true;
    flag.runtime_dry_run_implementation_report.runtime_started = true;
    recomputeImplementationKey(flag);
    expectValidatorFails(flag, 'runtime-mode-flag-disabled-local-dev-visible');
    expectValidatorFails(flag, 'default-on-runtime-flag-rejected');
  });

  test('validator rejects missing kill switch and dry-run execution overclaims', () => {
    const missing = clone(build());
    delete missing.runtime_dry_run_implementation_report.kill_switch;
    recomputeImplementationKey(missing);
    expectValidatorFails(missing, 'kill-switch-visible-fail-closed-testable');
    expectValidatorFails(missing, 'missing-kill-switch-rejected');

    const dryRun = clone(build());
    dryRun.runtime_dry_run_implementation_report.dry_run_path.executes_local_work = true;
    dryRun.runtime_dry_run_implementation_report.dry_run_path.creates_queue_or_lease = true;
    dryRun.runtime_dry_run_implementation_report.dry_run_path.writes_store_or_file = true;
    recomputeImplementationKey(dryRun);
    expectValidatorFails(dryRun, 'dry-run-path-preview-only');
    expectValidatorFails(dryRun, 'dry-run-execution-overclaim-rejected');
  });

  test('validator rejects non-loopback binding, telemetry writes, and raw reference leaks', () => {
    const binding = clone(build());
    binding.runtime_dry_run_implementation_report.local_binding.allowed_hosts = ['0.0.0.0'];
    binding.runtime_dry_run_implementation_report.local_binding.public_interface_allowed = true;
    binding.runtime_dry_run_implementation_report.local_binding.listener_opened_now = true;
    binding.runtime_dry_run_implementation_report.local_binding.network_performed_now = true;
    recomputeImplementationKey(binding);
    expectValidatorFails(binding, 'local-binding-in-process-or-loopback-only');
    expectValidatorFails(binding, 'non-loopback-binding-rejected');

    const telemetry = clone(build());
    telemetry.runtime_dry_run_implementation_report.telemetry_audit_preview.store_write_now = true;
    telemetry.runtime_dry_run_implementation_report.telemetry_audit_preview.raw_payload_allowed = true;
    recomputeImplementationKey(telemetry);
    expectValidatorFails(telemetry, 'telemetry-audit-redacted-preview-only');
    expectValidatorFails(telemetry, 'telemetry-write-or-raw-payload-rejected');

    const refs = clone(build());
    refs.runtime_dry_run_implementation_report.reference_only_dependencies.raw_path_allowed = true;
    refs.runtime_dry_run_implementation_report.reference_only_dependencies.raw_secret_allowed = true;
    refs.runtime_dry_run_implementation_report.reference_only_dependencies.env_secret_read = true;
    recomputeImplementationKey(refs);
    expectValidatorFails(refs, 'reference-only-dependencies-safe');
    expectValidatorFails(refs, 'raw-secret-path-leak-rejected');
  });

  test('validator rejects fake proof, direct Builder/Oracle targets, missing gates, and satisfied prerequisites', () => {
    const proof = clone(build());
    proof.runtime_dry_run_implementation_report.proof_boundaries.runtime_mode_flag_is_runtime_proof = true;
    proof.runtime_dry_run_implementation_report.proof_boundaries.dry_run_response_is_live_execution_proof = true;
    proof.runtime_dry_run_implementation_report.proof_boundaries.socket_is_bridge_green_proof = true;
    proof.runtime_dry_run_implementation_report.proof_boundaries.serverCanExecuteLocal = true;
    recomputeImplementationKey(proof);
    expectValidatorFails(proof, 'proof-boundaries-preserved');
    expectValidatorFails(proof, 'fake-proof-rejected');

    const target = clone(build());
    target.runtime_dry_run_implementation_report.target_boundaries.builder_direct_server_target_allowed = true;
    target.runtime_dry_run_implementation_report.target_boundaries.oracle_direct_server_target_allowed = true;
    target.runtime_dry_run_implementation_report.target_boundaries.local_architect_acceptance_required = false;
    recomputeImplementationKey(target);
    expectValidatorFails(target, 'direct-builder-oracle-targets-blocked');

    const missing = clone(build());
    missing.runtime_dry_run_implementation_report.phase28_prerequisite_status = missing.runtime_dry_run_implementation_report.phase28_prerequisite_status.slice(1);
    recomputeImplementationKey(missing);
    expectValidatorFails(missing, 'phase28-prerequisite-gates-complete');
    expectValidatorFails(missing, 'missing-phase28-prerequisite-gate-rejected');

    const satisfied = clone(build());
    satisfied.runtime_dry_run_implementation_report.phase28_prerequisite_status[0].satisfies_phase28_now = true;
    satisfied.runtime_dry_run_implementation_report.phase28_prerequisite_status[0].authorizes_runtime = true;
    recomputeImplementationKey(satisfied);
    expectValidatorFails(satisfied, 'phase28-prerequisites-not-satisfied-now');
    expectValidatorFails(satisfied, 'phase28-prerequisite-satisfied-now-rejected');
  });

  test('validator rejects unsafe action drift and side-effect lies', () => {
    for (const phrase of [
      'send email to customer',
      'message the client',
      'approve deploy',
      'move money',
      'external send',
      'capture screen',
      'memory commit',
      'execute shell',
      'tier3 trade',
    ]) {
      const tampered = clone(build());
      tampered.runtime_dry_run_implementation_report.next_safe_actions[0].title = phrase;
      tampered.runtime_dry_run_implementation_report.next_safe_actions[0].why_safe = `safe to ${phrase}`;
      recomputeImplementationKey(tampered);
      expectValidatorFails(tampered, 'unsafe-action-drift-rejected');
    }

    const sideEffect = clone(build());
    sideEffect.runtime_dry_run_implementation_report.side_effect_result.no_output_file_written = false;
    sideEffect.runtime_dry_run_implementation_report.side_effect_result.outputFilesWritten = 1;
    recomputeImplementationKey(sideEffect);
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
      tampered.runtime_dry_run_implementation_report.next_safe_actions[0].why_safe = forbidden;
      recomputeImplementationKey(tampered);
      expectValidatorFails(tampered, 'forbidden-output-strings-absent');
    }
  });

  test('CLI is stdout-only, consumes the Oracle fixture, and ignores output-file flags', () => {
    const parsed = parseArgs(['--pretty', '--out', 'ignored.json']);
    expect(parsed.pretty).toBe(true);
    expect(parsed.fixturePath).toContain('mira-core-runtime-dry-run-implementation-contract.json');

    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const output = main(['--out=ignored.json'], JSON.stringify({
      profile: { name: 'main' },
      sessionId: 'session-cli',
      deviceId: 'VIGIL',
    }));

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(implementationReport(output).schema).toBe(RUNTIME_DRY_RUN_IMPLEMENTATION_REPORT_SCHEMA_VERSION);
    expect(implementationReport(output).sessionId).toBe('session-cli');
    expect(implementationReport(output).baseline_commit).toBe(BASELINE_COMMIT);
    expect(implementationReport(output).phase_28_dependency.commit).toBe(PHASE28_COMMIT);
    expect(implementationReport(output).slice_id).toBe(SLICE_ID);
    expect(implementationReport(output).implementation_decision).toBe('remain_disabled_dry_run_contract_only');
    expect(implementationReport(output).runtime_available_now).toBe(false);
    expect(implementationReport(output).runtime_started).toBe(false);
    expect(implementationReport(output).proof_boundaries.serverCanExecuteLocal).toBe(false);
    expect(implementationReport(output).target_boundaries.builder_direct_server_target_allowed).toBe(false);
    expect(implementationReport(output).target_boundaries.oracle_direct_server_target_allowed).toBe(false);
    expect(implementationReport(output).side_effect_result.no_runtime_performed).toBe(true);
    expect(implementationReport(output).side_effect_result.no_output_file_written).toBe(true);
    expect(implementationReport(output).side_effect_result.outputFileWritten).toBe(false);
    expect(validationReport(output).decision).toBe('accepted');
    expect(validateMiraCoreRuntimeDryRunImplementationOutput(output, runtimeDryRunImplementationContract)).toEqual(expect.objectContaining({ ok: true }));
  });
});
