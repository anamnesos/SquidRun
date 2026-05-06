const serverApiContract = require('./fixtures/mira-core-server-api-contract.json');
const {
  ALLOWED_STATUSES,
  BASELINE_COMMIT,
  DEPENDENCIES,
  REQUIRED_ASSESSMENT_FIELDS,
  REQUIRED_BLOCKER_IDS,
  REQUIRED_ENDPOINT_IDS,
  REQUIRED_GATE_IDS,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  SERVER_API_ASSESSMENT_SCHEMA_VERSION,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreServerApi,
  validateMiraCoreServerApiOutput,
} = require('../modules/mira-core/server-api');
const {
  main,
  parseArgs,
} = require('../scripts/hm-mira-core-server-api');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function build(inputSignals = {}) {
  return buildMiraCoreServerApi({
    contract: serverApiContract,
    inputSignals,
    nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
  });
}

function assessment(output) {
  return output.server_api_assessment;
}

function report(output) {
  return output.validation_report;
}

function expectRequiredFields(value, fields) {
  for (const field of fields) {
    expect(value).toHaveProperty(field);
  }
}

function expectNoForbiddenOutput(output) {
  expect(() => assertNoForbiddenOutput(output, serverApiContract.forbiddenOutputSubstrings)).not.toThrow();
}

function expectValidatorFails(output, checkId) {
  const validation = validateMiraCoreServerApiOutput(output, serverApiContract);
  expect(validation.ok).toBe(false);
  expect(validation.checks.find((entry) => entry.id === checkId)).toEqual(expect.objectContaining({ ok: false }));
}

describe('mira core server API/control-plane/status assessment v0', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('satisfies Oracle output, assessment, and validation report shapes', () => {
    const output = build();
    const currentAssessment = assessment(output);
    const validation = report(output);

    expectRequiredFields(output, serverApiContract.expectedOutputShape.requiredTopLevelFields);
    expect(serverApiContract.expectedOutputShape.requiredTopLevelFields).toEqual(REQUIRED_OUTPUT_FIELDS);
    expect(currentAssessment.schema).toBe(SERVER_API_ASSESSMENT_SCHEMA_VERSION);
    expect(validation.schema).toBe(VALIDATION_REPORT_SCHEMA_VERSION);
    expectRequiredFields(currentAssessment, serverApiContract.expectedServerApiAssessmentShape.requiredFields);
    expect(serverApiContract.expectedServerApiAssessmentShape.requiredFields).toEqual(REQUIRED_ASSESSMENT_FIELDS);
    expectRequiredFields(validation, serverApiContract.expectedValidationReportShape.requiredFields);
    expect(serverApiContract.expectedValidationReportShape.requiredFields).toEqual(REQUIRED_VALIDATION_REPORT_FIELDS);
    expect(validateMiraCoreServerApiOutput(output, serverApiContract)).toEqual(expect.objectContaining({ ok: true }));
    expect(validation.decision).toBe('accepted');
    expectNoForbiddenOutput(output);
  });

  test('pins the Phase 19 baseline and maps Phases 14-19 as validation-only dependencies', () => {
    const dependencyMap = assessment(build()).dependency_map;
    const expected = serverApiContract.expectedServerApiAssessmentShape;

    expect(assessment(build()).baseline_commit).toBe(BASELINE_COMMIT);
    expect(BASELINE_COMMIT).toBe(serverApiContract.baseline.commit);
    expectRequiredFields(dependencyMap, expected.dependencyMapRequiredFields);
    expect(dependencyMap).toEqual(expect.objectContaining(expected.dependencyMapRequiredValues));
    expect(dependencyMap.baseline_ref).toBe(`commit:${BASELINE_COMMIT}`);
    expect(dependencyMap.dependency_paths).toHaveLength(DEPENDENCIES.length);
    for (const entry of dependencyMap.dependency_paths) {
      expectRequiredFields(entry, expected.dependencyPhaseEntriesRequired);
      expect(entry.status).toBe('green_validation_only');
      expect(entry.boundary_mode).toBe('validation_only_no_runtime');
    }
    expect(dependencyMap.real_server_dependency_exists).toBe(false);
    expect(dependencyMap.real_api_dependency_exists).toBe(false);
  });

  test('planned endpoint catalog is complete, side-effect-free, and not registered live', () => {
    const control = assessment(build()).planned_endpoint_control_plane;
    const expected = serverApiContract.expectedServerApiAssessmentShape;

    expectRequiredFields(control, expected.plannedEndpointControlPlaneRequiredFields);
    expect(control).toEqual(expect.objectContaining(expected.plannedEndpointControlPlaneRequiredValues));
    expect(control.endpoint_count).toBe(REQUIRED_ENDPOINT_IDS.length);
    expect(control.endpoints.map((endpoint) => endpoint.endpoint_id)).toEqual(REQUIRED_ENDPOINT_IDS);
    expect(control.endpoints.map((endpoint) => endpoint.endpoint_id)).toEqual(expected.requiredEndpointIds);
    for (const endpoint of control.endpoints) {
      expectRequiredFields(endpoint, expected.endpointRequiredFields);
      expect(endpoint.boundary_mode).toBe('planned_validation_only_endpoint_shape');
      expect(endpoint.side_effect_free).toBe(true);
      expect(endpoint.raw_payload_allowed).toBe(false);
      expect(endpoint.requires_auth_binding_ref).toBe(true);
      expect(endpoint.requires_signature_ref).toBe(true);
      expect(endpoint.requires_key_reference_ref).toBe(true);
      expect(endpoint.allowed_statuses).toEqual(ALLOWED_STATUSES);
      expect(control.allowed_methods).toContain(endpoint.method);
    }
  });

  test('request/response envelope requires scope, refs, watermarks, redaction, expiry, and no raw payload', () => {
    const envelope = assessment(build()).request_response_envelope;
    const expected = serverApiContract.expectedServerApiAssessmentShape;

    expectRequiredFields(envelope, expected.requestResponseEnvelopeRequiredFields);
    expect(envelope).toEqual(expect.objectContaining(expected.requestResponseEnvelopeRequiredValues));
    expect(envelope.schema).toBe('squidrun.mira_core.server_api_envelope.v0');
    expect(envelope.method).toBe('POST');
    expect(envelope.path).toBe('/v0/mira-core/receive-upload-envelope');
    expect(envelope.idempotency_key).toMatch(/^server-api-idem:/);
    expect(envelope.replay_key).toMatch(/^server-api-replay:/);
    expect(envelope.profile).toBe('main');
    expect(envelope.device_id).toBe('VIGIL');
    expect(envelope.session_id).toBe('app-session-326');
    expect(envelope.auth_binding_ref).toContain('auth-binding-validation');
    expect(envelope.signature_ref).toContain('identity-signing-validation');
    expect(envelope.key_reference_ref).toContain('encryption-key-validation');
    expect(envelope.no_raw_payload).toBe(true);
    expect(envelope.raw_payload_allowed).toBe(false);
  });

  test('status semantics include required safe states and offline/local acceptance honesty', () => {
    const semantics = assessment(build()).status_semantics;
    const expected = serverApiContract.expectedServerApiAssessmentShape;

    expectRequiredFields(semantics, expected.statusSemanticsRequiredFields);
    expect(semantics).toEqual(expect.objectContaining(expected.statusSemanticsRequiredValues));
    expect(semantics.allowed_statuses).toEqual(ALLOWED_STATUSES);
    expect(semantics.terminal_statuses).toEqual(expect.arrayContaining([
      'blocked',
      'expired',
      'replay_rejected',
      'tombstone_wins',
      'no_store_performed',
      'no_execution_performed',
    ]));
    expect(semantics.transient_statuses).toContain('offline_local_arms');
    expect(semantics.offline_local_arms_honest).toBe(true);
    expect(semantics.pending_local_acceptance_requires_architect).toBe(true);
  });

  test('operator controls are read-only status/report records', () => {
    const controls = assessment(build()).operator_controls;
    const expected = serverApiContract.expectedServerApiAssessmentShape;

    expectRequiredFields(controls, expected.operatorControlsRequiredFields);
    expect(controls).toEqual(expect.objectContaining(expected.operatorControlsRequiredValues));
    expect(controls.status_report_controls.length).toBeGreaterThan(0);
    expect(controls.future_delete_request_shape.mode).toBe('record_only');
    expect(controls.future_export_manifest_shape.mode).toBe('redacted_manifest_only');
    expect(controls.future_retention_control_shape.mode).toBe('status_record_only');
    expect(controls.delete_export_retention_actions_performed_now).toBe(false);
    expect(controls.redacted_manifests_only).toBe(true);
  });

  test('privacy/security boundary blocks raw private, secret, side-profile, token, key, plaintext, and ciphertext content', () => {
    const boundary = assessment(build()).privacy_security_boundary;
    const expected = serverApiContract.expectedServerApiAssessmentShape;

    expectRequiredFields(boundary, expected.privacySecurityBoundaryRequiredFields);
    expect(boundary).toEqual(expect.objectContaining(expected.privacySecurityBoundaryRequiredValues));
    expect(boundary.no_raw_private_content).toBe(true);
    expect(boundary.no_secret_material).toBe(true);
    expect(boundary.no_profile_mismatch_content).toBe(true);
    expect(boundary.no_side_profile_content).toBe(true);
    expect(boundary.no_bearer_tokens).toBe(true);
    expect(boundary.no_cookies).toBe(true);
    expect(boundary.no_session_secrets).toBe(true);
    expect(boundary.no_private_keys).toBe(true);
    expect(boundary.no_data_keys).toBe(true);
    expect(boundary.no_plaintext_ciphertext_or_decrypted_content).toBe(true);
    expect(boundary.blocked_content_classes.length).toBeGreaterThan(10);
  });

  test('capability boundary prevents API overclaims', () => {
    const boundary = assessment(build()).capability_boundary;
    const expected = serverApiContract.expectedServerApiAssessmentShape;

    expectRequiredFields(boundary, expected.capabilityBoundaryRequiredFields);
    expect(boundary).toEqual(expect.objectContaining(expected.capabilityBoundaryRequiredValues));
    expect(boundary.api_validity_permits).toBe('future_server_api_control_plane_status_validation_only');
    expect(boundary.allowed_target_role).toBe('architect');
    expect(boundary.local_acceptance_required).toBe(true);
    expect(boundary.local_execution_authorized).toBe(false);
    expect(boundary.shell_or_pty_authorized).toBe(false);
    expect(boundary.db_write_authorized).toBe(false);
    expect(boundary.storage_write_authorized).toBe(false);
    expect(boundary.builder_direct_target_authorized).toBe(false);
    expect(boundary.oracle_direct_target_authorized).toBe(false);
    expect(boundary.tier2_plus_authorized).toBe(false);
    expect(boundary.model_processing_proven).toBe(false);
    expect(boundary.bridge_green_proven).toBe(false);
    expect(boundary.raw_restore_authorized).toBe(false);
  });

  test('real API migration stays gated', () => {
    const gates = assessment(build()).migration_gates;
    const expected = serverApiContract.expectedServerApiAssessmentShape;

    expectRequiredFields(gates, expected.migrationGatesRequiredFields);
    expect(gates).toEqual(expect.objectContaining(expected.migrationGatesRequiredValues));
    expect(gates.baseline_commit).toBe(BASELINE_COMMIT);
    expect(gates.phase_19_dependency_id).toBe('encryption-key-validation-green');
    expect(gates.real_api_server_allowed_now).toBe(false);
    expect(gates.future_real_api_allowed_after_gates).toBe(true);
    expect(gates.requires_transport_tls_gate).toBe(true);
    expect(gates.requires_auth_middleware_gate).toBe(true);
    expect(gates.requires_replay_store_gate).toBe(true);
    expect(gates.requires_rate_limits_gate).toBe(true);
    expect(gates.requires_encryption_kms_integration_gate).toBe(true);
    expect(gates.requires_red_team_leakage_tests_gate).toBe(true);
    expect(gates.feature_flag_default).toBe('off');
  });

  test('required gates and blockers are complete, unique, and evidence-backed', () => {
    const currentAssessment = assessment(build());

    expect(currentAssessment.acceptance_gate_summary.map((gate) => gate.gate_id)).toEqual(REQUIRED_GATE_IDS);
    expect(currentAssessment.acceptance_gate_summary.map((gate) => gate.gate_id)).toEqual(
      serverApiContract.expectedServerApiAssessmentShape.requiredAcceptanceGateIds,
    );
    for (const gate of currentAssessment.acceptance_gate_summary) {
      expectRequiredFields(gate, serverApiContract.expectedServerApiAssessmentShape.acceptanceGateSummaryRequiredFields);
      expect(gate.required_before_real_server).toBe(true);
      expect(gate.required_before_real_api).toBe(true);
      expect(gate.evidenceRefs.length).toBeGreaterThan(0);
    }

    expect(currentAssessment.blocker_summary.map((blocker) => blocker.blocker_id)).toEqual(REQUIRED_BLOCKER_IDS);
    expect(currentAssessment.blocker_summary.map((blocker) => blocker.blocker_id)).toEqual(
      serverApiContract.expectedServerApiAssessmentShape.requiredBlockerIds,
    );
    for (const blocker of currentAssessment.blocker_summary) {
      expectRequiredFields(blocker, serverApiContract.expectedServerApiAssessmentShape.blockerSummaryRequiredFields);
      expect(blocker.evidenceRefs.length).toBeGreaterThan(0);
    }
  });

  test('side-effect truth is explicit in assessment and validation report', () => {
    const output = build();
    const expectedAssessment = serverApiContract.expectedServerApiAssessmentShape.sideEffectRequiredValues;
    const expectedReport = serverApiContract.expectedValidationReportShape.sideEffectRequiredValues;

    expect(assessment(output).side_effect_result).toEqual(expect.objectContaining(expectedAssessment));
    expect(report(output).side_effect_result).toEqual(expect.objectContaining(expectedReport));
    expect(assessment(output).side_effect_result.serverProcessesStarted).toBe(0);
    expect(assessment(output).side_effect_result.listenersStarted).toBe(0);
    expect(assessment(output).side_effect_result.routesRegistered).toBe(0);
    expect(assessment(output).side_effect_result.networkRequestsAttempted).toBe(0);
    expect(assessment(output).side_effect_result.databaseOrStoreWritesAttempted).toBe(0);
    expect(assessment(output).side_effect_result.queuesCreated).toBe(0);
    expect(assessment(output).side_effect_result.outputFileWritten).toBe(false);
  });

  test('static validation rules and acceptance checks are represented', () => {
    const output = build();
    const validation = validateMiraCoreServerApiOutput(output, serverApiContract);
    const validatorCheckIds = validation.checks.map((entry) => entry.id);
    const reportCheckIds = report(output).acceptance_check_results.map((entry) => entry.id);

    expect(validation.ok).toBe(true);
    for (const rule of serverApiContract.staticValidationRules) {
      expect(validatorCheckIds).toContain(rule.id);
    }
    expect(reportCheckIds).toEqual(serverApiContract.acceptanceChecks.map((check) => check.id));
    expect(report(output).summary_criteria_results).toHaveLength(serverApiContract.summaryAcceptanceCriteria.length);
    expectNoForbiddenOutput(output);
  });

  test('validator rejects baseline drift, dependency gaps, and real dependency overclaims', () => {
    const valid = build();

    const baselineDrift = clone(valid);
    baselineDrift.server_api_assessment.baseline_commit = 'badc0de';
    expectValidatorFails(baselineDrift, 'phase-20-baseline-8a8ccf0-pinned');

    const missingDependency = clone(valid);
    delete missingDependency.server_api_assessment.dependency_map.phase_19_encryption_key_ref;
    expectValidatorFails(missingDependency, 'phase-14-through-19-dependency-map-required');

    const realServerDependency = clone(valid);
    realServerDependency.server_api_assessment.dependency_map.real_server_dependency_exists = true;
    expectValidatorFails(realServerDependency, 'phase-14-through-19-dependency-map-required');

    const missingPhaseEntry = clone(valid);
    missingPhaseEntry.server_api_assessment.dependency_map.dependency_paths.pop();
    expectValidatorFails(missingPhaseEntry, 'phase-14-through-19-dependency-map-required');
  });

  test('validator rejects live server/listener/routes/network endpoint overclaims', () => {
    const valid = build();

    const liveListener = clone(valid);
    liveListener.server_api_assessment.planned_endpoint_control_plane.real_server_listener_created = true;
    expectValidatorFails(liveListener, 'planned-endpoints-shape-only');

    const routesRegistered = clone(valid);
    routesRegistered.server_api_assessment.planned_endpoint_control_plane.routes_registered_now = true;
    expectValidatorFails(routesRegistered, 'planned-endpoints-shape-only');

    const missingEndpoint = clone(valid);
    missingEndpoint.server_api_assessment.planned_endpoint_control_plane.endpoints.pop();
    missingEndpoint.server_api_assessment.planned_endpoint_control_plane.endpoint_count -= 1;
    expectValidatorFails(missingEndpoint, 'planned-endpoints-shape-only');

    const rawEndpoint = clone(valid);
    rawEndpoint.server_api_assessment.planned_endpoint_control_plane.endpoints[0].raw_payload_allowed = true;
    expectValidatorFails(rawEndpoint, 'planned-endpoints-shape-only');

    const sideEffectingEndpoint = clone(valid);
    sideEffectingEndpoint.server_api_assessment.planned_endpoint_control_plane.endpoints[0].side_effect_free = false;
    expectValidatorFails(sideEffectingEndpoint, 'planned-endpoints-shape-only');

    const sideEffectLie = clone(valid);
    sideEffectLie.server_api_assessment.side_effect_result.no_server_process_started = false;
    sideEffectLie.server_api_assessment.side_effect_result.serverProcessesStarted = 1;
    expectValidatorFails(sideEffectLie, 'validation-only-no-real-api');
  });

  test('validator rejects missing envelope refs, replay/idempotency gaps, raw payload, expiry, and scope mismatch', () => {
    const valid = build();

    const missingAuth = clone(valid);
    missingAuth.server_api_assessment.request_response_envelope.auth_binding_ref = '';
    expectValidatorFails(missingAuth, 'request-response-envelope-scope-and-refs');

    const missingSignature = clone(valid);
    missingSignature.server_api_assessment.request_response_envelope.signature_ref = '';
    expectValidatorFails(missingSignature, 'request-response-envelope-scope-and-refs');

    const missingKey = clone(valid);
    missingKey.server_api_assessment.request_response_envelope.key_reference_ref = '';
    expectValidatorFails(missingKey, 'request-response-envelope-scope-and-refs');

    const missingReplay = clone(valid);
    missingReplay.server_api_assessment.request_response_envelope.replay_key = '';
    expectValidatorFails(missingReplay, 'request-response-envelope-scope-and-refs');

    const rawPayloadAllowed = clone(valid);
    rawPayloadAllowed.server_api_assessment.request_response_envelope.raw_payload_allowed = true;
    expectValidatorFails(rawPayloadAllowed, 'request-response-envelope-scope-and-refs');

    const missingExpiry = clone(valid);
    missingExpiry.server_api_assessment.request_response_envelope.expires_at = '';
    expectValidatorFails(missingExpiry, 'request-response-envelope-scope-and-refs');

    const scopeMismatch = clone(valid);
    scopeMismatch.server_api_assessment.request_response_envelope.profile = 'side';
    expectValidatorFails(scopeMismatch, 'request-response-envelope-scope-and-refs');

    const replayNotRejected = clone(valid);
    replayNotRejected.server_api_assessment.status_semantics.replay_rejected_required = false;
    expectValidatorFails(replayNotRejected, 'status-semantics-safe');
    expectValidatorFails(replayNotRejected, 'replay-idempotency-required');
  });

  test('validator rejects operator action overclaims and offline/proof status drift', () => {
    const valid = build();

    const operatorAction = clone(valid);
    operatorAction.server_api_assessment.operator_controls.delete_export_retention_actions_performed_now = true;
    expectValidatorFails(operatorAction, 'operator-controls-read-only-status');

    const mutableExport = clone(valid);
    mutableExport.server_api_assessment.operator_controls.future_export_manifest_shape.mode = 'raw_export';
    expectValidatorFails(mutableExport, 'operator-controls-read-only-status');

    const offlineDishonest = clone(valid);
    offlineDishonest.server_api_assessment.status_semantics.offline_local_arms_honest = false;
    expectValidatorFails(offlineDishonest, 'status-semantics-safe');
    expectValidatorFails(offlineDishonest, 'offline-local-arms-honesty');

    const modelProof = clone(valid);
    modelProof.server_api_assessment.capability_boundary.model_processing_proven = true;
    expectValidatorFails(modelProof, 'capability-boundary-validation-only');
    expectValidatorFails(modelProof, 'offline-local-arms-honesty');

    const bridgeGreen = clone(valid);
    bridgeGreen.server_api_assessment.capability_boundary.bridge_green_proven = true;
    expectValidatorFails(bridgeGreen, 'capability-boundary-validation-only');
    expectValidatorFails(bridgeGreen, 'offline-local-arms-honesty');
  });

  test('validator rejects privacy/security boundary gaps', () => {
    const privacyFields = [
      'no_raw_private_content',
      'no_secret_material',
      'no_profile_mismatch_content',
      'no_side_profile_content',
      'no_bearer_tokens',
      'no_cookies',
      'no_session_secrets',
      'no_private_keys',
      'no_data_keys',
      'no_plaintext_ciphertext_or_decrypted_content',
      'redaction_summary_required',
    ];

    for (const field of privacyFields) {
      const tampered = clone(build());
      tampered.server_api_assessment.privacy_security_boundary[field] = false;
      expectValidatorFails(tampered, 'privacy-security-no-raw-or-secrets');
    }

    const missingBlockedClasses = clone(build());
    missingBlockedClasses.server_api_assessment.privacy_security_boundary.blocked_content_classes = [];
    expectValidatorFails(missingBlockedClasses, 'privacy-security-no-raw-or-secrets');
  });

  test('validator rejects capability and high-risk action overclaims', () => {
    const overclaims = [
      ['local_execution_authorized', true],
      ['shell_or_pty_authorized', true],
      ['db_write_authorized', true],
      ['storage_write_authorized', true],
      ['builder_direct_target_authorized', true],
      ['oracle_direct_target_authorized', true],
      ['tier2_plus_authorized', true],
      ['customer_send_authorized', true],
      ['deploy_authorized', true],
      ['trade_authorized', true],
      ['memory_profile_commit_authorized', true],
      ['raw_restore_authorized', true],
      ['server_resurrection_of_deleted_state_authorized', true],
    ];

    for (const [field, value] of overclaims) {
      const tampered = clone(build());
      tampered.server_api_assessment.capability_boundary[field] = value;
      expectValidatorFails(tampered, 'capability-boundary-validation-only');
      if (['tier2_plus_authorized', 'customer_send_authorized', 'deploy_authorized', 'trade_authorized'].includes(field)) {
        expectValidatorFails(tampered, 'high-risk-actions-blocked');
      }
    }

    const wrongTarget = clone(build());
    wrongTarget.server_api_assessment.capability_boundary.allowed_target_role = 'builder';
    expectValidatorFails(wrongTarget, 'capability-boundary-validation-only');
  });

  test('validator rejects real API gate drift, missing gates/blockers, output shape gaps, and validation side-effect lies', () => {
    const valid = build();

    const realApiAllowed = clone(valid);
    realApiAllowed.server_api_assessment.migration_gates.real_api_server_allowed_now = true;
    expectValidatorFails(realApiAllowed, 'migration-real-api-gated');

    const featureOn = clone(valid);
    featureOn.server_api_assessment.migration_gates.feature_flag_default = 'on';
    expectValidatorFails(featureOn, 'migration-real-api-gated');

    const missingGate = clone(valid);
    missingGate.server_api_assessment.acceptance_gate_summary.pop();
    expectValidatorFails(missingGate, 'required-gates-and-blockers-present');

    const missingBlocker = clone(valid);
    missingBlocker.server_api_assessment.blocker_summary.pop();
    expectValidatorFails(missingBlocker, 'required-gates-and-blockers-present');

    const outputMissing = clone(valid);
    delete outputMissing.validation_report;
    expectValidatorFails(outputMissing, 'output-shape-complete');

    const reportSideEffectLie = clone(valid);
    reportSideEffectLie.validation_report.side_effect_result.no_routes_registered = false;
    reportSideEffectLie.validation_report.side_effect_result.routesRegistered = 1;
    expectValidatorFails(reportSideEffectLie, 'validation-side-effect-truth');
  });

  test('validator rejects forbidden raw/secret/server/proof/high-risk substrings in values', () => {
    const forbiddenValues = [
      'Authorization: Bearer',
      'Bearer token',
      'Set-Cookie',
      'session_secret',
      'BEGIN PRIVATE KEY',
      'DATA KEY',
      'raw plaintext payload',
      'raw ciphertext payload',
      'decrypted raw content',
      'raw comms body',
      'browser session state',
      'customer private note',
      'profile mismatch payload',
      'server listener started',
      'route registered',
      'network request complete',
      'database write complete',
      'queue created',
      'key generated',
      'encryption performed',
      'decryption performed',
      'kms call complete',
      'env secret read',
      'output file written',
      'server executed local work',
      'api authorizes local execution',
      'api proves model processing',
      'socket alone proves bridge green',
      'builder direct target authorized',
      'oracle direct target authorized',
      'tier3 authorized by api',
      'tier4 authorized by api',
      'memory commit authorized by api',
    ];

    for (const forbidden of forbiddenValues) {
      const tampered = clone(build());
      tampered.server_api_assessment.blocker_summary[0].safe_next_action = forbidden;
      expectValidatorFails(tampered, 'forbidden-output-strings-absent');
      expectValidatorFails(tampered, 'forbidden-substrings-absent');
    }
  });

  test('idempotency is stable for equivalent inputs and sensitive to scope changes', () => {
    const first = assessment(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'VIGIL' }));
    const second = assessment(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'VIGIL' }));
    const changedDevice = assessment(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'ALT' }));
    const changedProfile = assessment(build({ profile: { name: 'side' }, sessionId: 'session-a', deviceId: 'VIGIL' }));
    const changedTenant = assessment(build({ profile: { name: 'main' }, sessionId: 'session-a', deviceId: 'VIGIL', tenantId: 'tenant:other' }));

    expect(first.idempotency_key).toBe(second.idempotency_key);
    expect(first.assessment_id).toBe(second.assessment_id);
    expect(first.idempotency_key).not.toBe(changedDevice.idempotency_key);
    expect(first.idempotency_key).not.toBe(changedProfile.idempotency_key);
    expect(first.idempotency_key).not.toBe(changedTenant.idempotency_key);

    const tampered = clone(build());
    tampered.server_api_assessment.planned_endpoint_control_plane.planned_only = false;
    expectValidatorFails(tampered, 'idempotency-stable');
  });

  test('CLI is stdout-only, consumes the Oracle fixture, and ignores output-file flags', () => {
    const parsed = parseArgs(['--pretty', '--out', 'ignored.json']);
    expect(parsed.pretty).toBe(true);
    expect(parsed.fixturePath).toContain('mira-core-server-api-contract.json');

    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const output = main(['--out=ignored.json'], JSON.stringify({
      profile: { name: 'main' },
      sessionId: 'session-cli',
      deviceId: 'VIGIL',
      tenantId: 'tenant:james-main-validation',
    }));

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(assessment(output).schema).toBe(SERVER_API_ASSESSMENT_SCHEMA_VERSION);
    expect(assessment(output).sessionId).toBe('session-cli');
    expect(assessment(output).side_effect_result.no_server_process_started).toBe(true);
    expect(assessment(output).side_effect_result.no_listener_started).toBe(true);
    expect(assessment(output).side_effect_result.no_routes_registered).toBe(true);
    expect(assessment(output).side_effect_result.no_network_performed).toBe(true);
    expect(assessment(output).side_effect_result.no_output_file_written).toBe(true);
    expect(assessment(output).side_effect_result.outputFileWritten).toBe(false);
    expect(report(output).decision).toBe('accepted');
    expect(validateMiraCoreServerApiOutput(output, serverApiContract)).toEqual(expect.objectContaining({ ok: true }));
  });
});
