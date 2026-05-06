const runtimeControlsContract = require('./fixtures/mira-core-runtime-controls-contract.json');
const {
  BASELINE_COMMIT,
  CANDIDATE_SLICE_ID,
  DEFAULT_HARD_OUT_OF_SCOPE_IDS,
  DEFAULT_NEXT_SAFE_ACTION_IDS,
  DEFAULT_PHASE_REF_IDS,
  DEFAULT_TAMPER_CASE_IDS,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_REPORT_FIELDS,
  REQUIRED_SIDE_EFFECT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  RUNTIME_CONTROLS_REPORT_SCHEMA_VERSION,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreRuntimeControls,
  runtimeControlsIdempotencyKey,
  validateMiraCoreRuntimeControlsOutput,
} = require('../modules/mira-core/runtime-controls');
const {
  main,
  parseArgs,
} = require('../scripts/hm-mira-core-runtime-controls');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function build(inputSignals = {}) {
  return buildMiraCoreRuntimeControls({
    contract: runtimeControlsContract,
    inputSignals,
    nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
  });
}

function controlsReport(output) {
  return output.runtime_controls_report;
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
  expect(() => assertNoForbiddenOutput(output, runtimeControlsContract.forbiddenOutputSubstrings)).not.toThrow();
}

function expectValidatorFails(output, checkId) {
  const validation = validateMiraCoreRuntimeControlsOutput(output, runtimeControlsContract);
  expect(validation.ok).toBe(false);
  expect(validation.checks.find((entry) => entry.id === checkId)).toEqual(expect.objectContaining({ ok: false }));
}

function recomputeControlsKey(output) {
  output.runtime_controls_report.idempotency_key = runtimeControlsIdempotencyKey(output.runtime_controls_report);
}

describe('mira core runtime controls assessment v0', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('satisfies Oracle output, controls report, and validation report shapes', () => {
    const output = build();
    const report = controlsReport(output);
    const validation = validationReport(output);

    expectRequiredFields(output, runtimeControlsContract.expectedOutputShape.requiredTopLevelFields);
    expect(runtimeControlsContract.expectedOutputShape.requiredTopLevelFields).toEqual(REQUIRED_OUTPUT_FIELDS);
    expect(report.schema).toBe(RUNTIME_CONTROLS_REPORT_SCHEMA_VERSION);
    expect(validation.schema).toBe(VALIDATION_REPORT_SCHEMA_VERSION);
    expectRequiredFields(report, runtimeControlsContract.expectedRuntimeControlsReportShape.requiredFields);
    expect(runtimeControlsContract.expectedRuntimeControlsReportShape.requiredFields).toEqual(REQUIRED_REPORT_FIELDS);
    expectRequiredFields(validation, runtimeControlsContract.expectedValidationReportShape.requiredFields);
    expect(runtimeControlsContract.expectedValidationReportShape.requiredFields).toEqual(REQUIRED_VALIDATION_REPORT_FIELDS);
    expect(validateMiraCoreRuntimeControlsOutput(output, runtimeControlsContract)).toEqual(expect.objectContaining({ ok: true }));
    expect(validation.decision).toBe('accepted');
    expectNoForbiddenOutput(output);
  });

  test('pins baseline and Phase 25 runtime slice candidate dependency', () => {
    const report = controlsReport(build());
    const dependency = report.phase_25_dependency;
    const expected = runtimeControlsContract.expectedRuntimeControlsReportShape;

    expect(report.baseline_commit).toBe(BASELINE_COMMIT);
    expect(BASELINE_COMMIT).toBe(runtimeControlsContract.baseline.commit);
    expectRequiredFields(dependency, expected.phase25DependencyRequiredFields);
    expect(dependency).toEqual(expect.objectContaining(expected.phase25DependencyRequiredValues));
    expect(dependency.candidate_slice_id).toBe(CANDIDATE_SLICE_ID);
    expect(dependency.runtime_available_now).toBe(false);
    expect(dependency.does_not_authorize_runtime).toBe(true);
    expect(dependency.missing_gate_count).toBe(20);
  });

  test('runtime mode flag defaults disabled, local-only, dev-only, visible, and non-authorizing', () => {
    const flag = controlsReport(build()).runtime_mode_flag;
    const expected = runtimeControlsContract.expectedRuntimeControlsReportShape;

    expectRequiredFields(flag, expected.runtimeModeFlagRequiredFields);
    expect(flag.default_enabled).toBe(false);
    expect(flag.default_state).toBe('disabled');
    expect(flag.allowed_values).toContain('disabled');
    expect(flag.dev_only).toBe(true);
    expect(flag.local_only).toBe(true);
    expect(flag.operator_visible).toBe(true);
    expect(flag.non_authorizing).toBe(true);
    expect(flag.runtime_started).toBe(false);
    expect(flag.invalid_value_behavior).toBe('validation_status_preview_only');
  });

  test('local binding plan is loopback-only with no listener, port, public interface, or network', () => {
    const report = controlsReport(build());
    const binding = report.local_binding_plan;
    const refs = report.port_config_refs;
    const expected = runtimeControlsContract.expectedRuntimeControlsReportShape;

    expectRequiredFields(binding, expected.localBindingPlanRequiredFields);
    expect(binding.loopback_only).toBe(true);
    expect(binding.allowed_hosts).toEqual(['127.0.0.1', '::1', 'localhost']);
    expect(binding.public_interface_allowed).toBe(false);
    expect(binding.remote_interface_allowed).toBe(false);
    expect(binding.listener_opened).toBe(false);
    expect(binding.network_performed).toBe(false);
    expectRequiredFields(refs, expected.portConfigRefsRequiredFields);
    expect(refs.reference_only).toBe(true);
    expect(refs.port_opened).toBe(false);
    expect(refs.env_secret_read).toBe(false);
    expect(refs.network_performed).toBe(false);
    expect(refs.raw_secret_allowed).toBe(false);
    expect(refs.raw_path_allowed).toBe(false);
  });

  test('kill switch, dry-run fallback, rollback, and telemetry audit plans are safe', () => {
    const report = controlsReport(build());
    const expected = runtimeControlsContract.expectedRuntimeControlsReportShape;

    expectRequiredFields(report.operator_kill_switch, expected.operatorKillSwitchRequiredFields);
    expect(report.operator_kill_switch.operator_visible).toBe(true);
    expect(report.operator_kill_switch.fail_closed).toBe(true);
    expect(report.operator_kill_switch.testable).toBe(true);
    expect(report.operator_kill_switch.ignored_allowed).toBe(false);
    expect(report.operator_kill_switch.runtime_side_effects_now).toBe(false);
    expectRequiredFields(report.dry_run_fallback, expected.dryRunFallbackRequiredFields);
    expect(report.dry_run_fallback.all_requests_preview_only_when_flag_missing_false_invalid).toBe(true);
    expect(report.dry_run_fallback.bypass_allowed).toBe(false);
    expect(report.dry_run_fallback.response_mode).toBe('validation_status_preview_only');
    expectRequiredFields(report.rollback_disable_plan, expected.rollbackDisablePlanRequiredFields);
    expect(report.rollback_disable_plan.disable_idempotent).toBe(true);
    expect(report.rollback_disable_plan.deletes_data).toBe(false);
    expect(report.rollback_disable_plan.resurrects_blocked_state).toBe(false);
    expectRequiredFields(report.telemetry_audit_plan, expected.telemetryAuditPlanRequiredFields);
    expect(report.telemetry_audit_plan.redacted_audit_preview_only).toBe(true);
    expect(report.telemetry_audit_plan.store_write_now).toBe(false);
    expect(report.telemetry_audit_plan.file_write_now).toBe(false);
    expect(report.telemetry_audit_plan.db_write_now).toBe(false);
    expect(report.telemetry_audit_plan.network_write_now).toBe(false);
    expect(report.telemetry_audit_plan.raw_payload_allowed).toBe(false);
  });

  test('Phase 15-25 refs, proof boundaries, hard scope, tamper coverage, and next actions match fixture', () => {
    const output = build();
    const report = controlsReport(output);
    const expected = runtimeControlsContract.expectedRuntimeControlsReportShape;
    const validation = validateMiraCoreRuntimeControlsOutput(output, runtimeControlsContract);

    expect(report.phase_ref_map.map((entry) => entry.ref_id)).toEqual(DEFAULT_PHASE_REF_IDS);
    expect(DEFAULT_PHASE_REF_IDS).toEqual(expected.phaseRefMapRequiredIds);
    expect(report.phase_ref_map).toHaveLength(11);
    expect(report.phase_ref_map.every((entry) => entry.reference_only && !entry.behavior_performed)).toBe(true);
    expectRequiredFields(report.proof_boundaries, expected.proofBoundaryRequiredFields);
    expect(report.proof_boundaries.config_present_is_runtime_proof).toBe(false);
    expect(report.proof_boundaries.socket_is_bridge_green_proof).toBe(false);
    expect(report.proof_boundaries.delivery_acceptance_is_model_processing_proof).toBe(false);
    expect(report.proof_boundaries.server_can_execute_local_arms).toBe(false);
    expect(report.proof_boundaries.builder_direct_server_target_allowed).toBe(false);
    expect(report.proof_boundaries.oracle_direct_server_target_allowed).toBe(false);
    expect(report.hard_out_of_scope.map((entry) => entry.scope_id)).toEqual(DEFAULT_HARD_OUT_OF_SCOPE_IDS);
    expect(DEFAULT_HARD_OUT_OF_SCOPE_IDS).toEqual(expected.hardOutOfScopeRequiredIds);
    expect(report.hard_out_of_scope).toHaveLength(9);
    expect(report.hard_out_of_scope.every((entry) => entry.out_of_scope_now && !entry.allowed_now)).toBe(true);
    expect(report.tamper_case_coverage.map((entry) => entry.tamper_case_id)).toEqual(DEFAULT_TAMPER_CASE_IDS);
    expect(DEFAULT_TAMPER_CASE_IDS).toEqual(runtimeControlsContract.tamperCases.map((entry) => entry.id));
    expect(report.next_safe_actions.map((entry) => entry.action_id)).toEqual(DEFAULT_NEXT_SAFE_ACTION_IDS);
    expect(DEFAULT_NEXT_SAFE_ACTION_IDS).toEqual(expected.nextSafeActionRequiredIds);
    const checkIds = validation.checks.map((entry) => entry.id);
    for (const rule of runtimeControlsContract.staticValidationRules) {
      expect(checkIds).toContain(rule.id);
    }
    expect(validationReport(output).acceptance_checks.map((entry) => entry.id)).toEqual(runtimeControlsContract.acceptanceChecks.map((entry) => entry.id));
  });

  test('side-effect truth stays explicit and all counters remain zero', () => {
    const output = build();
    const report = controlsReport(output);
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

  test('idempotency is stable for equivalent inputs and sensitive to control changes', () => {
    const first = controlsReport(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'VIGIL' }));
    const second = controlsReport(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'VIGIL' }));
    const changedDevice = controlsReport(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'ALT' }));

    expect(first.idempotency_key).toBe(second.idempotency_key);
    expect(first.controls_report_id).toBe(second.controls_report_id);
    expect(first.idempotency_key).not.toBe(changedDevice.idempotency_key);

    const tampered = clone(build());
    tampered.runtime_controls_report.operator_kill_switch.fail_closed = false;
    recomputeControlsKey(tampered);
    expect(validateMiraCoreRuntimeControlsOutput(tampered, runtimeControlsContract).checks.find((entry) => entry.id === 'idempotency-sensitive-to-control-gates')).toEqual(expect.objectContaining({ ok: true }));
    expectValidatorFails(tampered, 'operator-kill-switch-visible-fail-closed');
  });

  test('validator rejects runtime flag default-on and config authorization overclaims', () => {
    const defaultOn = clone(build());
    defaultOn.runtime_controls_report.runtime_mode_flag.default_enabled = true;
    defaultOn.runtime_controls_report.runtime_mode_flag.default_state = 'active';
    recomputeControlsKey(defaultOn);
    expectValidatorFails(defaultOn, 'runtime-mode-flag-disabled-local-dev-nonauthorizing');
    expectValidatorFails(defaultOn, 'default-on-overclaim-rejected');

    const authorizing = clone(build());
    authorizing.runtime_controls_report.runtime_mode_flag.non_authorizing = false;
    authorizing.runtime_controls_report.proof_boundaries.config_present_is_runtime_proof = true;
    recomputeControlsKey(authorizing);
    expectValidatorFails(authorizing, 'runtime-mode-flag-disabled-local-dev-nonauthorizing');
    expectValidatorFails(authorizing, 'proof-boundaries-preserved');
    expectValidatorFails(authorizing, 'config-eligibility-not-authorization');
  });

  test('validator rejects non-loopback binding, hidden listener/network, and side-effect lies', () => {
    const nonLoopback = clone(build());
    nonLoopback.runtime_controls_report.local_binding_plan.loopback_only = false;
    nonLoopback.runtime_controls_report.local_binding_plan.allowed_hosts = ['0.0.0.0'];
    nonLoopback.runtime_controls_report.local_binding_plan.public_interface_allowed = true;
    nonLoopback.runtime_controls_report.local_binding_plan.remote_interface_allowed = true;
    nonLoopback.runtime_controls_report.local_binding_plan.listener_opened = true;
    nonLoopback.runtime_controls_report.local_binding_plan.network_performed = true;
    nonLoopback.runtime_controls_report.port_config_refs.port_opened = true;
    recomputeControlsKey(nonLoopback);
    expectValidatorFails(nonLoopback, 'local-binding-loopback-only-no-listener');
    expectValidatorFails(nonLoopback, 'non-loopback-binding-rejected');
    expectValidatorFails(nonLoopback, 'hidden-listener-network-rejected');

    const sideEffect = clone(build());
    sideEffect.runtime_controls_report.side_effect_result.no_network_performed = false;
    sideEffect.runtime_controls_report.side_effect_result.networkRequestsAttempted = 1;
    recomputeControlsKey(sideEffect);
    expectValidatorFails(sideEffect, 'hard-out-of-scope-side-effects-blocked');
    expectValidatorFails(sideEffect, 'hidden-listener-network-rejected');

    const validationLie = clone(build());
    validationLie.validation_report.side_effect_result.no_output_file_written = false;
    validationLie.validation_report.side_effect_result.outputFilesWritten = 1;
    expectValidatorFails(validationLie, 'validation-report-side-effect-truth');
  });

  test('validator rejects missing or ignored kill switch and dry-run bypass', () => {
    const missing = clone(build());
    delete missing.runtime_controls_report.operator_kill_switch;
    recomputeControlsKey(missing);
    expectValidatorFails(missing, 'operator-kill-switch-visible-fail-closed');
    expectValidatorFails(missing, 'kill-switch-missing-or-ignored-rejected');

    const ignored = clone(build());
    ignored.runtime_controls_report.operator_kill_switch.ignored_allowed = true;
    recomputeControlsKey(ignored);
    expectValidatorFails(ignored, 'operator-kill-switch-visible-fail-closed');
    expectValidatorFails(ignored, 'kill-switch-missing-or-ignored-rejected');

    const bypass = clone(build());
    bypass.runtime_controls_report.dry_run_fallback.bypass_allowed = true;
    bypass.runtime_controls_report.dry_run_fallback.all_requests_preview_only_when_flag_missing_false_invalid = false;
    recomputeControlsKey(bypass);
    expectValidatorFails(bypass, 'dry-run-fallback-cannot-be-bypassed');
    expectValidatorFails(bypass, 'dry-run-bypass-rejected');
  });

  test('validator rejects unsafe rollback, telemetry writes, and port/config raw refs', () => {
    const rollback = clone(build());
    rollback.runtime_controls_report.rollback_disable_plan.disable_idempotent = false;
    rollback.runtime_controls_report.rollback_disable_plan.deletes_data = true;
    rollback.runtime_controls_report.rollback_disable_plan.resurrects_blocked_state = true;
    recomputeControlsKey(rollback);
    expectValidatorFails(rollback, 'rollback-disable-idempotent-no-resurrection');

    const telemetry = clone(build());
    telemetry.runtime_controls_report.telemetry_audit_plan.store_write_now = true;
    telemetry.runtime_controls_report.telemetry_audit_plan.file_write_now = true;
    telemetry.runtime_controls_report.telemetry_audit_plan.db_write_now = true;
    telemetry.runtime_controls_report.telemetry_audit_plan.network_write_now = true;
    recomputeControlsKey(telemetry);
    expectValidatorFails(telemetry, 'telemetry-audit-preview-only-no-writes');
    expectValidatorFails(telemetry, 'telemetry-write-rejected');

    const rawRefs = clone(build());
    rawRefs.runtime_controls_report.port_config_refs.raw_secret_allowed = true;
    rawRefs.runtime_controls_report.port_config_refs.raw_path_allowed = true;
    rawRefs.runtime_controls_report.port_config_refs.env_secret_read = true;
    recomputeControlsKey(rawRefs);
    expectValidatorFails(rawRefs, 'port-config-reference-only-no-secret-read');
    expectValidatorFails(rawRefs, 'raw-secret-leak-rejected');
  });

  test('validator rejects stale Phase 25 baseline, phase ref behavior, and proof overclaims', () => {
    const stale = clone(build());
    stale.runtime_controls_report.phase_25_dependency.baseline_commit = 'e062d16';
    stale.runtime_controls_report.phase_25_dependency.candidate_slice_id = 'different-candidate';
    recomputeControlsKey(stale);
    expectValidatorFails(stale, 'phase25-runtime-slice-candidate-required');
    expectValidatorFails(stale, 'stale-phase25-baseline-rejected');

    const phaseRef = clone(build());
    phaseRef.runtime_controls_report.phase_ref_map[0].behavior_performed = true;
    recomputeControlsKey(phaseRef);
    expectValidatorFails(phaseRef, 'phase15-through-25-refs-reference-only');

    const proof = clone(build());
    proof.runtime_controls_report.proof_boundaries.socket_is_bridge_green_proof = true;
    proof.runtime_controls_report.proof_boundaries.delivery_acceptance_is_model_processing_proof = true;
    proof.runtime_controls_report.proof_boundaries.server_can_execute_local_arms = true;
    proof.runtime_controls_report.proof_boundaries.builder_direct_server_target_allowed = true;
    recomputeControlsKey(proof);
    expectValidatorFails(proof, 'proof-boundaries-preserved');
  });

  test('validator rejects forbidden raw/private/runtime/proof strings in values', () => {
    for (const forbidden of [
      'runtime flag enabled',
      'runtime enabled',
      'runtime authorized',
      'runtime started',
      'config proves runtime',
      'server started',
      'listener bound',
      'network request performed',
      'port opened',
      'database write performed',
      'queue created',
      'lease created',
      'auth changed',
      'key generated',
      'secret read',
      'env secret read',
      'local execution performed',
      'deploy performed',
      'trade performed',
      'output file written',
      'socket proves bridge green',
      'delivery acceptance proves model processing',
      'server can execute local arms',
      'direct builder target allowed',
      'kill switch ignored',
      'dry run bypassed',
      'telemetry written',
      'audit written',
      'raw terminal scrollback',
      'raw browser state',
      'raw screenshot',
      'raw customer private',
      'source-store payload',
      'bearer token',
      'session secret',
      'private key',
      'plaintext payload',
      'decrypted payload',
    ]) {
      const tampered = clone(build());
      tampered.runtime_controls_report.next_safe_actions[0].why_safe = forbidden;
      recomputeControlsKey(tampered);
      expectValidatorFails(tampered, 'forbidden-output-strings-absent');
      expectValidatorFails(tampered, 'raw-private-secret-leakage-rejected');
    }
  });

  test('CLI is stdout-only, consumes the Oracle fixture, and ignores output-file flags', () => {
    const parsed = parseArgs(['--pretty', '--out', 'ignored.json']);
    expect(parsed.pretty).toBe(true);
    expect(parsed.fixturePath).toContain('mira-core-runtime-controls-contract.json');

    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const output = main(['--out=ignored.json'], JSON.stringify({
      profile: { name: 'main' },
      sessionId: 'session-cli',
      deviceId: 'VIGIL',
    }));

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(controlsReport(output).schema).toBe(RUNTIME_CONTROLS_REPORT_SCHEMA_VERSION);
    expect(controlsReport(output).sessionId).toBe('session-cli');
    expect(controlsReport(output).baseline_commit).toBe('3efa9c5');
    expect(controlsReport(output).phase_25_dependency.candidate_slice_id).toBe(CANDIDATE_SLICE_ID);
    expect(controlsReport(output).runtime_mode_flag.default_state).toBe('disabled');
    expect(controlsReport(output).runtime_mode_flag.default_enabled).toBe(false);
    expect(controlsReport(output).local_binding_plan.loopback_only).toBe(true);
    expect(controlsReport(output).local_binding_plan.listener_opened).toBe(false);
    expect(controlsReport(output).operator_kill_switch.fail_closed).toBe(true);
    expect(controlsReport(output).dry_run_fallback.bypass_allowed).toBe(false);
    expect(controlsReport(output).telemetry_audit_plan.redacted_audit_preview_only).toBe(true);
    expect(controlsReport(output).proof_boundaries.config_present_is_runtime_proof).toBe(false);
    expect(controlsReport(output).side_effect_result.no_runtime_performed).toBe(true);
    expect(controlsReport(output).side_effect_result.no_output_file_written).toBe(true);
    expect(controlsReport(output).side_effect_result.outputFileWritten).toBe(false);
    expect(validationReport(output).decision).toBe('accepted');
    expect(validateMiraCoreRuntimeControlsOutput(output, runtimeControlsContract)).toEqual(expect.objectContaining({ ok: true }));
  });
});
