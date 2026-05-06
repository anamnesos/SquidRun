const runtimePreflightContract = require('./fixtures/mira-core-runtime-preflight-contract.json');
const {
  BASELINE_COMMIT,
  CANDIDATE_SLICE_ID,
  DEFAULT_BLOCKED_SIDE_EFFECT_IDS,
  DEFAULT_NEXT_SAFE_ACTION_IDS,
  DEFAULT_READINESS_DECISIONS,
  DEFAULT_TAMPER_CASE_IDS,
  DEFAULT_UNSATISFIED_GATE_IDS,
  PHASE25_COMMIT,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_REPORT_FIELDS,
  REQUIRED_SIDE_EFFECT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  RUNTIME_PREFLIGHT_REPORT_SCHEMA_VERSION,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreRuntimePreflight,
  runtimePreflightIdempotencyKey,
  validateMiraCoreRuntimePreflightOutput,
} = require('../modules/mira-core/runtime-preflight');
const {
  main,
  parseArgs,
} = require('../scripts/hm-mira-core-runtime-preflight');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function build(inputSignals = {}) {
  return buildMiraCoreRuntimePreflight({
    contract: runtimePreflightContract,
    inputSignals,
    nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
  });
}

function preflightReport(output) {
  return output.runtime_preflight_report;
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
  expect(() => assertNoForbiddenOutput(output, runtimePreflightContract.forbiddenOutputSubstrings)).not.toThrow();
}

function expectValidatorFails(output, checkId) {
  const validation = validateMiraCoreRuntimePreflightOutput(output, runtimePreflightContract);
  expect(validation.ok).toBe(false);
  expect(validation.checks.find((entry) => entry.id === checkId)).toEqual(expect.objectContaining({ ok: false }));
}

function recomputePreflightKey(output) {
  output.runtime_preflight_report.idempotency_key = runtimePreflightIdempotencyKey(output.runtime_preflight_report);
}

describe('mira core runtime preflight readiness assessment v0', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('satisfies Oracle output, preflight report, and validation report shapes', () => {
    const output = build();
    const report = preflightReport(output);
    const validation = validationReport(output);

    expectRequiredFields(output, runtimePreflightContract.expectedOutputShape.requiredTopLevelFields);
    expect(runtimePreflightContract.expectedOutputShape.requiredTopLevelFields).toEqual(REQUIRED_OUTPUT_FIELDS);
    expect(report.schema).toBe(RUNTIME_PREFLIGHT_REPORT_SCHEMA_VERSION);
    expect(validation.schema).toBe(VALIDATION_REPORT_SCHEMA_VERSION);
    expectRequiredFields(report, runtimePreflightContract.expectedRuntimePreflightReportShape.requiredFields);
    expect(runtimePreflightContract.expectedRuntimePreflightReportShape.requiredFields).toEqual(REQUIRED_REPORT_FIELDS);
    expectRequiredFields(validation, runtimePreflightContract.expectedValidationReportShape.requiredFields);
    expect(runtimePreflightContract.expectedValidationReportShape.requiredFields).toEqual(REQUIRED_VALIDATION_REPORT_FIELDS);
    expect(validateMiraCoreRuntimePreflightOutput(output, runtimePreflightContract)).toEqual(expect.objectContaining({ ok: true }));
    expect(validation.decision).toBe('accepted');
    expectNoForbiddenOutput(output);
  });

  test('pins Phase 25 and Phase 26 dependencies to accepted commits', () => {
    const report = preflightReport(build());
    const expected = runtimePreflightContract.expectedRuntimePreflightReportShape;

    expect(report.baseline_commit).toBe(BASELINE_COMMIT);
    expect(BASELINE_COMMIT).toBe(runtimePreflightContract.baseline.commit);
    expectRequiredFields(report.phase_25_dependency, expected.phase25DependencyRequiredFields);
    expect(report.phase_25_dependency).toEqual(expect.objectContaining(expected.phase25DependencyRequiredValues));
    expect(report.phase_25_dependency.commit).toBe(PHASE25_COMMIT);
    expect(report.phase_25_dependency.status).toBe('committed_validation_only');
    expect(report.phase_25_dependency.candidate_slice_id).toBe(CANDIDATE_SLICE_ID);
    expectRequiredFields(report.phase_26_dependency, expected.phase26DependencyRequiredFields);
    expect(report.phase_26_dependency).toEqual(expect.objectContaining(expected.phase26DependencyRequiredValues));
    expect(report.phase_26_dependency.commit).toBe(BASELINE_COMMIT);
    expect(report.phase_26_dependency.controls_current).toBe(true);
  });

  test('keeps runtime-slice-0 unavailable, read-only, and non-authorizing', () => {
    const report = preflightReport(build());
    const candidate = report.candidate_runtime_slice;
    const expected = runtimePreflightContract.expectedRuntimePreflightReportShape;

    expectRequiredFields(candidate, expected.candidateRuntimeSliceRequiredFields);
    expect(candidate.slice_id).toBe(CANDIDATE_SLICE_ID);
    expect(candidate.local_only).toBe(true);
    expect(candidate.dev_only).toBe(true);
    expect(candidate.disabled_by_default).toBe(true);
    expect(candidate.operator_visible).toBe(true);
    expect(candidate.read_only_status_control_plane_only).toBe(true);
    expect(candidate.runtime_available_now).toBe(false);
    expect(candidate.non_authorizing).toBe(true);
    expect(candidate.does_not_satisfy_phase_24_prerequisites).toBe(true);
  });

  test('represents current Phase 26 controls without runtime or network behavior', () => {
    const controls = preflightReport(build()).controls_current;
    const expected = runtimePreflightContract.expectedRuntimePreflightReportShape;

    expectRequiredFields(controls, expected.controlsCurrentRequiredFields);
    expectRequiredFields(controls.runtime_mode_flag, expected.runtimeModeFlagRequiredFields);
    expect(controls.runtime_mode_flag.default_state).toBe('disabled');
    expect(controls.runtime_mode_flag.default_enabled).toBe(false);
    expect(controls.runtime_mode_flag.dev_only).toBe(true);
    expect(controls.runtime_mode_flag.local_only).toBe(true);
    expect(controls.runtime_mode_flag.operator_visible).toBe(true);
    expect(controls.runtime_mode_flag.non_authorizing).toBe(true);
    expect(controls.runtime_mode_flag.runtime_started).toBe(false);
    expectRequiredFields(controls.local_binding_plan, expected.localBindingPlanRequiredFields);
    expect(controls.local_binding_plan.allowed_hosts).toEqual(['127.0.0.1', '::1', 'localhost']);
    expect(controls.local_binding_plan.public_interface_allowed).toBe(false);
    expect(controls.local_binding_plan.remote_interface_allowed).toBe(false);
    expect(controls.local_binding_plan.listener_opened).toBe(false);
    expect(controls.local_binding_plan.network_performed).toBe(false);
    expectRequiredFields(controls.port_config_refs, expected.portConfigRefsRequiredFields);
    expect(controls.port_config_refs.reference_only).toBe(true);
    expect(controls.port_config_refs.port_opened).toBe(false);
    expect(controls.port_config_refs.env_secret_read).toBe(false);
    expect(controls.port_config_refs.raw_secret_allowed).toBe(false);
    expect(controls.port_config_refs.raw_path_allowed).toBe(false);
    expect(controls.phase15_to_24_refs_reference_only).toBe(true);
  });

  test('keeps kill switch, dry-run fallback, rollback, and telemetry controls bounded', () => {
    const controls = preflightReport(build()).controls_current;
    const expected = runtimePreflightContract.expectedRuntimePreflightReportShape;

    expectRequiredFields(controls.operator_kill_switch, expected.operatorKillSwitchRequiredFields);
    expect(controls.operator_kill_switch.visible).toBe(true);
    expect(controls.operator_kill_switch.fail_closed).toBe(true);
    expect(controls.operator_kill_switch.testable).toBe(true);
    expect(controls.operator_kill_switch.wired_to_runtime_now).toBe(false);
    expect(controls.operator_kill_switch.ignored_allowed).toBe(false);
    expectRequiredFields(controls.dry_run_fallback, expected.dryRunFallbackRequiredFields);
    expect(controls.dry_run_fallback.preview_only).toBe(true);
    expect(controls.dry_run_fallback.applies_when_flag_missing_false_invalid).toBe(true);
    expect(controls.dry_run_fallback.bypass_allowed).toBe(false);
    expect(controls.dry_run_fallback.tested_runtime_path_now).toBe(false);
    expectRequiredFields(controls.rollback_disable_plan, expected.rollbackDisableRequiredFields);
    expect(controls.rollback_disable_plan.disable_idempotent).toBe(true);
    expect(controls.rollback_disable_plan.deletes_data).toBe(false);
    expect(controls.rollback_disable_plan.resurrects_blocked_state).toBe(false);
    expectRequiredFields(controls.telemetry_audit_plan, expected.telemetryAuditRequiredFields);
    expect(controls.telemetry_audit_plan.redacted_preview_only).toBe(true);
    expect(controls.telemetry_audit_plan.store_write_now).toBe(false);
    expect(controls.telemetry_audit_plan.file_write_now).toBe(false);
    expect(controls.telemetry_audit_plan.db_write_now).toBe(false);
    expect(controls.telemetry_audit_plan.real_sink_wired_now).toBe(false);
    expect(controls.telemetry_audit_plan.raw_payload_allowed).toBe(false);
  });

  test('readiness decision defaults to validation-only and eligible remains non-authorizing', () => {
    const defaultReport = preflightReport(build());
    const eligibleReport = preflightReport(build({ readinessDecision: 'eligible_for_future_local_dry_run_preflight' }));

    expect(defaultReport.readiness_decision).toBe('remain_validation_only');
    expect(defaultReport.readiness_decision_allowed_values).toEqual(DEFAULT_READINESS_DECISIONS);
    expect(defaultReport.readiness_decision_allowed_values).toEqual(runtimePreflightContract.expectedRuntimePreflightReportShape.readinessDecisionAllowedValues);
    expect(defaultReport.eligible_is_authorization).toBe(false);
    expect(eligibleReport.readiness_decision).toBe('eligible_for_future_local_dry_run_preflight');
    expect(eligibleReport.eligible_is_authorization).toBe(false);
    expect(eligibleReport.candidate_runtime_slice.runtime_available_now).toBe(false);
    expect(eligibleReport.controls_current.runtime_mode_flag.runtime_started).toBe(false);
  });

  test('unsatisfied gates, proof boundaries, blocked effects, tamper coverage, and next actions match fixture', () => {
    const output = build();
    const report = preflightReport(output);
    const validation = validateMiraCoreRuntimePreflightOutput(output, runtimePreflightContract);

    expect(report.unsatisfied_gates.map((entry) => entry.gate_id)).toEqual(DEFAULT_UNSATISFIED_GATE_IDS);
    expect(DEFAULT_UNSATISFIED_GATE_IDS).toEqual(runtimePreflightContract.expectedRuntimePreflightReportShape.unsatisfiedGateRequiredIds);
    expect(report.unsatisfied_gates.every((entry) => entry.status === 'unsatisfied' && entry.carried_forward && entry.blocks_runtime_now)).toBe(true);
    expect(report.proof_boundaries.preflight_ready_is_runtime_proof).toBe(false);
    expect(report.proof_boundaries.config_present_is_runtime_proof).toBe(false);
    expect(report.proof_boundaries.socket_is_bridge_green_proof).toBe(false);
    expect(report.proof_boundaries.delivery_acceptance_is_model_processing_proof).toBe(false);
    expect(report.proof_boundaries.server_can_execute_local_arms).toBe(false);
    expect(report.proof_boundaries.builder_direct_server_target_allowed).toBe(false);
    expect(report.proof_boundaries.oracle_direct_server_target_allowed).toBe(false);
    expect(report.blocked_side_effects.map((entry) => entry.effect_id)).toEqual(DEFAULT_BLOCKED_SIDE_EFFECT_IDS);
    expect(DEFAULT_BLOCKED_SIDE_EFFECT_IDS).toEqual(runtimePreflightContract.expectedRuntimePreflightReportShape.blockedSideEffectRequiredIds);
    expect(report.blocked_side_effects.every((entry) => entry.blocked_now && entry.attempts === 0)).toBe(true);
    expect(report.tamper_case_coverage.map((entry) => entry.tamper_case_id)).toEqual(DEFAULT_TAMPER_CASE_IDS);
    expect(DEFAULT_TAMPER_CASE_IDS).toEqual(runtimePreflightContract.tamperCases.map((entry) => entry.id));
    expect(report.next_safe_actions.map((entry) => entry.action_id)).toEqual(DEFAULT_NEXT_SAFE_ACTION_IDS);
    expect(DEFAULT_NEXT_SAFE_ACTION_IDS).toEqual(runtimePreflightContract.expectedRuntimePreflightReportShape.nextSafeActionRequiredIds);
    const checkIds = validation.checks.map((entry) => entry.id);
    for (const rule of runtimePreflightContract.staticValidationRules) {
      expect(checkIds).toContain(rule.id);
    }
    expect(validationReport(output).acceptance_checks.map((entry) => entry.id)).toEqual(runtimePreflightContract.acceptanceChecks.map((entry) => entry.id));
  });

  test('side-effect truth stays explicit and all counters remain zero', () => {
    const output = build();
    const report = preflightReport(output);
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

  test('idempotency is stable for equivalent inputs and sensitive to baselines, controls, and gates', () => {
    const first = preflightReport(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'VIGIL' }));
    const second = preflightReport(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'VIGIL' }));
    const changedDevice = preflightReport(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'ALT' }));

    expect(first.idempotency_key).toBe(second.idempotency_key);
    expect(first.preflight_report_id).toBe(second.preflight_report_id);
    expect(first.idempotency_key).not.toBe(changedDevice.idempotency_key);

    const controlChange = clone(build());
    const originalKey = controlChange.runtime_preflight_report.idempotency_key;
    controlChange.runtime_preflight_report.controls_current.operator_kill_switch.fail_closed = false;
    recomputePreflightKey(controlChange);
    expect(controlChange.runtime_preflight_report.idempotency_key).not.toBe(originalKey);
    expectValidatorFails(controlChange, 'kill-switch-visible-fail-closed');
  });

  test('validator rejects stale Phase 25 and Phase 26 dependencies', () => {
    const stale25 = clone(build());
    stale25.runtime_preflight_report.phase_25_dependency.commit = 'e062d16';
    stale25.runtime_preflight_report.phase_25_dependency.candidate_slice_id = 'different-candidate';
    recomputePreflightKey(stale25);
    expectValidatorFails(stale25, 'phase25-baseline-current');
    expectValidatorFails(stale25, 'stale-phase25-baseline-rejected');

    const stale26 = clone(build());
    stale26.runtime_preflight_report.phase_26_dependency.commit = '3efa9c5';
    stale26.runtime_preflight_report.phase_26_dependency.controls_current = false;
    recomputePreflightKey(stale26);
    expectValidatorFails(stale26, 'phase26-baseline-current');
    expectValidatorFails(stale26, 'stale-phase26-baseline-rejected');
  });

  test('validator rejects candidate/runtime flag overclaims and eligible-as-authorization', () => {
    const candidate = clone(build());
    candidate.runtime_preflight_report.candidate_runtime_slice.runtime_available_now = true;
    candidate.runtime_preflight_report.candidate_runtime_slice.non_authorizing = false;
    recomputePreflightKey(candidate);
    expectValidatorFails(candidate, 'candidate-remains-non-authorizing-unavailable');

    const flag = clone(build());
    flag.runtime_preflight_report.controls_current.runtime_mode_flag.default_enabled = true;
    flag.runtime_preflight_report.controls_current.runtime_mode_flag.runtime_started = true;
    recomputePreflightKey(flag);
    expectValidatorFails(flag, 'runtime-flag-default-disabled');
    expectValidatorFails(flag, 'default-on-runtime-rejected');

    const eligible = clone(build({ readinessDecision: 'eligible_for_future_local_dry_run_preflight' }));
    eligible.runtime_preflight_report.eligible_is_authorization = true;
    recomputePreflightKey(eligible);
    expectValidatorFails(eligible, 'eligible-decision-non-authorizing');
  });

  test('validator rejects missing controls, non-loopback binding, and hidden listener/network', () => {
    const missing = clone(build());
    delete missing.runtime_preflight_report.controls_current.operator_kill_switch;
    recomputePreflightKey(missing);
    expectValidatorFails(missing, 'controls-current-complete');
    expectValidatorFails(missing, 'missing-controls-rejected');

    const nonLoopback = clone(build());
    nonLoopback.runtime_preflight_report.controls_current.local_binding_plan.allowed_hosts = ['0.0.0.0'];
    nonLoopback.runtime_preflight_report.controls_current.local_binding_plan.public_interface_allowed = true;
    nonLoopback.runtime_preflight_report.controls_current.local_binding_plan.listener_opened = true;
    recomputePreflightKey(nonLoopback);
    expectValidatorFails(nonLoopback, 'local-binding-loopback-only');
    expectValidatorFails(nonLoopback, 'non-loopback-binding-rejected');
    expectValidatorFails(nonLoopback, 'raw-secret-path-leak-rejected');

    const hidden = clone(build());
    hidden.runtime_preflight_report.controls_current.local_binding_plan.network_performed = true;
    hidden.runtime_preflight_report.controls_current.port_config_refs.port_opened = true;
    hidden.runtime_preflight_report.side_effect_result.no_network_performed = false;
    hidden.runtime_preflight_report.side_effect_result.networkRequestsAttempted = 1;
    recomputePreflightKey(hidden);
    expectValidatorFails(hidden, 'non-loopback-binding-rejected');
    expectValidatorFails(hidden, 'side-effect-truth-all-blocked');
  });

  test('validator rejects kill-switch, dry-run, rollback, telemetry, and port/config drift', () => {
    const killSwitch = clone(build());
    killSwitch.runtime_preflight_report.controls_current.operator_kill_switch.fail_closed = false;
    killSwitch.runtime_preflight_report.controls_current.operator_kill_switch.ignored_allowed = true;
    recomputePreflightKey(killSwitch);
    expectValidatorFails(killSwitch, 'kill-switch-visible-fail-closed');

    const dryRun = clone(build());
    dryRun.runtime_preflight_report.controls_current.dry_run_fallback.preview_only = false;
    dryRun.runtime_preflight_report.controls_current.dry_run_fallback.bypass_allowed = true;
    recomputePreflightKey(dryRun);
    expectValidatorFails(dryRun, 'dry-run-preview-only');

    const rollback = clone(build());
    rollback.runtime_preflight_report.controls_current.rollback_disable_plan.disable_idempotent = false;
    rollback.runtime_preflight_report.controls_current.rollback_disable_plan.deletes_data = true;
    rollback.runtime_preflight_report.controls_current.rollback_disable_plan.resurrects_blocked_state = true;
    recomputePreflightKey(rollback);
    expectValidatorFails(rollback, 'rollback-disable-idempotent');

    const telemetry = clone(build());
    telemetry.runtime_preflight_report.controls_current.telemetry_audit_plan.store_write_now = true;
    telemetry.runtime_preflight_report.controls_current.telemetry_audit_plan.raw_payload_allowed = true;
    recomputePreflightKey(telemetry);
    expectValidatorFails(telemetry, 'telemetry-audit-preview-only');

    const refs = clone(build());
    refs.runtime_preflight_report.controls_current.port_config_refs.reference_only = false;
    refs.runtime_preflight_report.controls_current.port_config_refs.env_secret_read = true;
    refs.runtime_preflight_report.controls_current.port_config_refs.raw_secret_allowed = true;
    refs.runtime_preflight_report.controls_current.port_config_refs.raw_path_allowed = true;
    recomputePreflightKey(refs);
    expectValidatorFails(refs, 'port-config-reference-only');
  });

  test('validator rejects proof overclaims, direct Builder/Oracle targets, and missing gates', () => {
    const proof = clone(build());
    proof.runtime_preflight_report.proof_boundaries.preflight_ready_is_runtime_proof = true;
    proof.runtime_preflight_report.proof_boundaries.socket_is_bridge_green_proof = true;
    proof.runtime_preflight_report.proof_boundaries.delivery_acceptance_is_model_processing_proof = true;
    proof.runtime_preflight_report.proof_boundaries.server_can_execute_local_arms = true;
    proof.runtime_preflight_report.proof_boundaries.builder_direct_server_target_allowed = true;
    proof.runtime_preflight_report.proof_boundaries.oracle_direct_server_target_allowed = true;
    recomputePreflightKey(proof);
    expectValidatorFails(proof, 'proof-boundaries-preserved');
    expectValidatorFails(proof, 'fake-proof-rejected');
    expectValidatorFails(proof, 'direct-builder-oracle-targets-blocked');

    const gates = clone(build());
    gates.runtime_preflight_report.unsatisfied_gates = gates.runtime_preflight_report.unsatisfied_gates.slice(0, -1);
    recomputePreflightKey(gates);
    expectValidatorFails(gates, 'unsatisfied-gates-present');
    expectValidatorFails(gates, 'missing-unsatisfied-gates-rejected');
  });

  test('validator rejects forbidden raw/private/runtime/proof strings in values', () => {
    for (const forbidden of [
      'runtime authorized',
      'runtime available now',
      'runtime started',
      'preflight proves runtime',
      'config proves runtime',
      'eligible authorizes runtime',
      'server started',
      'listener bound',
      'route registered',
      'http server listening',
      'websocket listening',
      'network request performed',
      'public interface allowed',
      '0.0.0.0',
      'port opened',
      'secret read',
      'env secret read',
      'raw path',
      'local execution performed',
      'customer send performed',
      'deploy performed',
      'trade performed',
      'output file written',
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
      tampered.runtime_preflight_report.next_safe_actions[0].why_safe = forbidden;
      recomputePreflightKey(tampered);
      expectValidatorFails(tampered, 'forbidden-output-strings-absent');
      expectValidatorFails(tampered, 'raw-secret-path-leak-rejected');
    }
  });

  test('validator rejects unsafe action drift and validation report side-effect lies', () => {
    const unsafe = clone(build());
    unsafe.runtime_preflight_report.next_safe_actions[0].risk_tier = 'tier3_deploy';
    unsafe.runtime_preflight_report.next_safe_actions[0].why_safe = 'approve deploy';
    recomputePreflightKey(unsafe);
    expectValidatorFails(unsafe, 'unsafe-action-drift-rejected');

    const customerMessage = clone(build());
    customerMessage.runtime_preflight_report.next_safe_actions[0].title = 'send a customer message';
    customerMessage.runtime_preflight_report.next_safe_actions[0].why_safe = 'safe to send customer message';
    recomputePreflightKey(customerMessage);
    expectValidatorFails(customerMessage, 'unsafe-action-drift-rejected');

    for (const phrase of [
      'send email to customer',
      'email a client',
      'message the client',
      'send message to client',
      'customer email',
      'client email',
    ]) {
      const variant = clone(build());
      variant.runtime_preflight_report.next_safe_actions[0].title = phrase;
      variant.runtime_preflight_report.next_safe_actions[0].why_safe = `safe to ${phrase}`;
      recomputePreflightKey(variant);
      expectValidatorFails(variant, 'unsafe-action-drift-rejected');
    }

    const validationLie = clone(build());
    validationLie.validation_report.side_effect_result.no_output_file_written = false;
    validationLie.validation_report.side_effect_result.outputFilesWritten = 1;
    expectValidatorFails(validationLie, 'validation-report-side-effect-truth');
  });

  test('CLI is stdout-only, consumes the Oracle fixture, and ignores output-file flags', () => {
    const parsed = parseArgs(['--pretty', '--out', 'ignored.json']);
    expect(parsed.pretty).toBe(true);
    expect(parsed.fixturePath).toContain('mira-core-runtime-preflight-contract.json');

    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const output = main(['--out=ignored.json'], JSON.stringify({
      profile: { name: 'main' },
      sessionId: 'session-cli',
      deviceId: 'VIGIL',
    }));

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(preflightReport(output).schema).toBe(RUNTIME_PREFLIGHT_REPORT_SCHEMA_VERSION);
    expect(preflightReport(output).sessionId).toBe('session-cli');
    expect(preflightReport(output).baseline_commit).toBe(BASELINE_COMMIT);
    expect(preflightReport(output).phase_25_dependency.commit).toBe(PHASE25_COMMIT);
    expect(preflightReport(output).phase_26_dependency.commit).toBe(BASELINE_COMMIT);
    expect(preflightReport(output).candidate_runtime_slice.slice_id).toBe(CANDIDATE_SLICE_ID);
    expect(preflightReport(output).readiness_decision).toBe('remain_validation_only');
    expect(preflightReport(output).eligible_is_authorization).toBe(false);
    expect(preflightReport(output).unsatisfied_gates).toHaveLength(9);
    expect(preflightReport(output).proof_boundaries.server_can_execute_local_arms).toBe(false);
    expect(preflightReport(output).side_effect_result.no_runtime_performed).toBe(true);
    expect(preflightReport(output).side_effect_result.no_output_file_written).toBe(true);
    expect(preflightReport(output).side_effect_result.outputFileWritten).toBe(false);
    expect(validationReport(output).decision).toBe('accepted');
    expect(validateMiraCoreRuntimePreflightOutput(output, runtimePreflightContract)).toEqual(expect.objectContaining({ ok: true }));
  });
});
