const serverHandlerContract = require('./fixtures/mira-core-server-handler-contract.json');
const {
  ALLOWED_DECISIONS,
  BASELINE_COMMIT,
  DEPENDENCIES,
  REQUIRED_ASSESSMENT_FIELDS,
  REQUIRED_BLOCKER_IDS,
  REQUIRED_ENDPOINT_IDS,
  REQUIRED_GATE_IDS,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  SERVER_HANDLER_ASSESSMENT_SCHEMA_VERSION,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreServerHandler,
  validateMiraCoreServerHandlerOutput,
} = require('../modules/mira-core/server-handler');
const {
  main,
  parseArgs,
} = require('../scripts/hm-mira-core-server-handler');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function build(inputSignals = {}) {
  return buildMiraCoreServerHandler({
    contract: serverHandlerContract,
    inputSignals,
    nowMs: Date.parse('2026-05-06T00:00:00.000Z'),
  });
}

function assessment(output) {
  return output.server_handler_assessment;
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
  expect(() => assertNoForbiddenOutput(output, serverHandlerContract.forbiddenOutputSubstrings)).not.toThrow();
}

function expectValidatorFails(output, checkId) {
  const validation = validateMiraCoreServerHandlerOutput(output, serverHandlerContract);
  expect(validation.ok).toBe(false);
  expect(validation.checks.find((entry) => entry.id === checkId)).toEqual(expect.objectContaining({ ok: false }));
}

describe('mira core server handler/dispatcher assessment v0', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('satisfies Oracle output, assessment, and validation report shapes', () => {
    const output = build();
    const currentAssessment = assessment(output);
    const validation = report(output);

    expectRequiredFields(output, serverHandlerContract.expectedOutputShape.requiredTopLevelFields);
    expect(serverHandlerContract.expectedOutputShape.requiredTopLevelFields).toEqual(REQUIRED_OUTPUT_FIELDS);
    expect(currentAssessment.schema).toBe(SERVER_HANDLER_ASSESSMENT_SCHEMA_VERSION);
    expect(validation.schema).toBe(VALIDATION_REPORT_SCHEMA_VERSION);
    expectRequiredFields(currentAssessment, serverHandlerContract.expectedServerHandlerAssessmentShape.requiredFields);
    expect(serverHandlerContract.expectedServerHandlerAssessmentShape.requiredFields).toEqual(REQUIRED_ASSESSMENT_FIELDS);
    expectRequiredFields(validation, serverHandlerContract.expectedValidationReportShape.requiredFields);
    expect(serverHandlerContract.expectedValidationReportShape.requiredFields).toEqual(REQUIRED_VALIDATION_REPORT_FIELDS);
    expect(validateMiraCoreServerHandlerOutput(output, serverHandlerContract)).toEqual(expect.objectContaining({ ok: true }));
    expect(validation.decision).toBe('accepted');
    expectNoForbiddenOutput(output);
  });

  test('pins the Phase 20 baseline and maps Phases 14-20 as validation-only dependencies', () => {
    const currentAssessment = assessment(build());
    const dependencyMap = currentAssessment.dependency_map;
    const expected = serverHandlerContract.expectedServerHandlerAssessmentShape;

    expect(currentAssessment.baseline_commit).toBe(BASELINE_COMMIT);
    expect(BASELINE_COMMIT).toBe(serverHandlerContract.baseline.commit);
    expectRequiredFields(dependencyMap, expected.dependencyMapRequiredFields);
    expect(dependencyMap).toEqual(expect.objectContaining(expected.dependencyMapRequiredValues));
    expect(dependencyMap.baseline_ref).toBe(`commit:${BASELINE_COMMIT}`);
    expect(dependencyMap.dependency_paths).toHaveLength(DEPENDENCIES.length);
    expect(dependencyMap.dependency_paths.map((entry) => entry.phase)).toEqual(DEPENDENCIES.map((entry) => entry.phase));
    for (const entry of dependencyMap.dependency_paths) {
      expectRequiredFields(entry, expected.dependencyPhaseEntriesRequired);
      expect(entry.status).toBe('green_validation_only');
      expect(entry.boundary_mode).toBe('validation_only_no_runtime');
    }
    expect(dependencyMap.real_server_dependency_exists).toBe(false);
    expect(dependencyMap.real_handler_runtime_exists).toBe(false);
  });

  test('handler registry contains the required pure handlers and no live route table', () => {
    const registry = assessment(build()).handler_registry;
    const expected = serverHandlerContract.expectedServerHandlerAssessmentShape;

    expectRequiredFields(registry, expected.handlerRegistryRequiredFields);
    expect(registry).toEqual(expect.objectContaining(expected.handlerRegistryRequiredValues));
    expect(registry.handler_count).toBe(REQUIRED_ENDPOINT_IDS.length);
    expect(registry.allowed_endpoint_ids).toEqual(REQUIRED_ENDPOINT_IDS);
    expect(registry.allowed_endpoint_ids).toEqual(expected.requiredEndpointIds);
    expect(registry.handlers.map((handler) => handler.endpoint_id)).toEqual(REQUIRED_ENDPOINT_IDS);
    for (const handler of registry.handlers) {
      expectRequiredFields(handler, expected.handlerEntryRequiredFields);
      expect(handler.pure_function).toBe(true);
      expect(handler.side_effect_free).toBe(true);
      expect(handler.raw_payload_allowed).toBe(false);
      expect(handler.requires_scope).toBe(true);
      expect(handler.requires_binding_refs).toBe(true);
      expect(handler.allowed_decisions).toEqual(ALLOWED_DECISIONS);
      expect(handler.blocked_actions.length).toBeGreaterThan(0);
    }
  });

  test('request envelope requires endpoint, scope, refs, replay keys, watermark, expiry, and no raw payload', () => {
    const request = assessment(build()).request_envelope;
    const expected = serverHandlerContract.expectedServerHandlerAssessmentShape;

    expectRequiredFields(request, expected.requestEnvelopeRequiredFields);
    expect(request).toEqual(expect.objectContaining(expected.requestEnvelopeRequiredValues));
    expect(request.schema).toBe('squidrun.mira_core.server_handler_request_envelope.v0');
    expect(request.endpoint_id).toBe('status-readiness');
    expect(request.idempotency_key).toMatch(/^server-handler-idem:/);
    expect(request.replay_key).toMatch(/^server-handler-replay:/);
    expect(request.tenant_id).toBe('tenant:james-main-validation');
    expect(request.profile).toBe('main');
    expect(request.device_id).toBe('VIGIL');
    expect(request.session_id).toBe('app-session-326');
    expect(request.auth_binding_ref).toContain('auth-binding-validation');
    expect(request.signature_ref).toContain('identity-signing-validation');
    expect(request.key_reference_ref).toContain('encryption-key-validation');
    expect(request.source_watermark).toBeTruthy();
    expect(request.payload_summary_only).toBe(true);
    expect(request.no_raw_payload).toBe(true);
    expect(request.raw_payload_allowed).toBe(false);
  });

  test('response envelope is status-only with no store, execution, network, or output file', () => {
    const currentAssessment = assessment(build());
    const response = currentAssessment.response_envelope;
    const expected = serverHandlerContract.expectedServerHandlerAssessmentShape;

    expectRequiredFields(response, expected.responseEnvelopeRequiredFields);
    expect(response).toEqual(expect.objectContaining(expected.responseEnvelopeRequiredValues));
    expect(response.schema).toBe('squidrun.mira_core.server_handler_response_envelope.v0');
    expect(response.request_id).toBe(currentAssessment.request_envelope.request_id);
    expect(response.endpoint_id).toBe(currentAssessment.request_envelope.endpoint_id);
    expect(response.handler_id).toBe(`handler:${currentAssessment.request_envelope.endpoint_id}`);
    expect(response.decision).toBe('accepted_for_validation_only');
    expect(response.no_raw_payload).toBe(true);
    expect(response.no_store_performed).toBe(true);
    expect(response.no_execution_performed).toBe(true);
    expect(response.no_network_performed).toBe(true);
    expect(response.no_output_file_written).toBe(true);
  });

  test('dispatch table is pure and does not register routes or perform network work', () => {
    const dispatch = assessment(build()).endpoint_dispatch_table;
    const expected = serverHandlerContract.expectedServerHandlerAssessmentShape;

    expectRequiredFields(dispatch, expected.dispatchTableRequiredFields);
    expect(dispatch).toEqual(expect.objectContaining(expected.dispatchTableRequiredValues));
    expect(dispatch.dispatch_is_pure).toBe(true);
    expect(dispatch.route_registration_performed).toBe(false);
    expect(dispatch.network_performed).toBe(false);
    expect(dispatch.default_unknown_endpoint_decision).toBe('rejected');
    for (const endpointId of REQUIRED_ENDPOINT_IDS) {
      expect(dispatch.endpoint_to_handler[endpointId]).toBe(`handler:${endpointId}`);
    }
  });

  test('idempotency, replay, watermark, tombstone, and expiry rules are explicit', () => {
    const rules = assessment(build()).idempotency_replay_watermark_tombstone;
    const expected = serverHandlerContract.expectedServerHandlerAssessmentShape;

    expectRequiredFields(rules, expected.idempotencyReplayWatermarkTombstoneRequiredFields);
    expect(rules).toEqual(expect.objectContaining(expected.idempotencyReplayWatermarkTombstoneRequiredValues));
    expect(rules.same_request_same_response).toBe(true);
    expect(rules.payload_or_scope_change_changes_idempotency).toBe(true);
    expect(rules.replay_rejected_required).toBe(true);
    expect(rules.watermark_regression_rejected).toBe(true);
    expect(rules.stale_snapshot_warned_or_rejected).toBe(true);
    expect(rules.tombstone_wins_required).toBe(true);
    expect(rules.expired_request_blocked).toBe(true);
  });

  test('binding requirements fail closed on auth, signature, key, role, target, profile, device, and session refs', () => {
    const binding = assessment(build()).binding_requirements;
    const expected = serverHandlerContract.expectedServerHandlerAssessmentShape;

    expectRequiredFields(binding, expected.bindingRequirementsRequiredFields);
    expect(binding).toEqual(expect.objectContaining(expected.bindingRequirementsRequiredValues));
    expect(binding.auth_binding_ref_required).toBe(true);
    expect(binding.signature_ref_required).toBe(true);
    expect(binding.key_reference_ref_required).toBe(true);
    expect(binding.role_proof_ref_required).toBe(true);
    expect(binding.target_proof_ref_required).toBe(true);
    expect(binding.profile_mismatch_fails_closed).toBe(true);
    expect(binding.device_mismatch_fails_closed).toBe(true);
    expect(binding.session_mismatch_fails_closed).toBe(true);
    expect(binding.reference_only_no_auth_mutation).toBe(true);
  });

  test('storage, deletion, export, and retention remain status-only', () => {
    const currentAssessment = assessment(build());
    const storage = currentAssessment.storage_status_policy;
    const controls = currentAssessment.deletion_export_retention_status;
    const expected = serverHandlerContract.expectedServerHandlerAssessmentShape;

    expectRequiredFields(storage, expected.storageStatusPolicyRequiredFields);
    expect(storage).toEqual(expect.objectContaining(expected.storageStatusPolicyRequiredValues));
    expect(storage.status_only).toBe(true);
    expect(storage.storage_write_allowed_now).toBe(false);
    expect(storage.raw_storage_allowed).toBe(false);
    expect(storage.eligible_syncEligibility).toEqual(['core_sync_safe', 'core_sync_redacted']);
    expectRequiredFields(controls, expected.deletionExportRetentionStatusRequiredFields);
    expect(controls).toEqual(expect.objectContaining(expected.deletionExportRetentionStatusRequiredValues));
    expect(controls.delete_performed_now).toBe(false);
    expect(controls.export_file_written_now).toBe(false);
    expect(controls.retention_mutated_now).toBe(false);
    expect(controls.redacted_manifest_only).toBe(true);
  });

  test('local arms, bridge, and model-processing proof boundaries stay honest', () => {
    const status = assessment(build()).local_arms_status;
    const expected = serverHandlerContract.expectedServerHandlerAssessmentShape;

    expectRequiredFields(status, expected.localArmsStatusRequiredFields);
    expect(status).toEqual(expect.objectContaining(expected.localArmsStatusRequiredValues));
    expect(status.serverCanExecuteLocal).toBe(false);
    expect(status.serverCanOperatePTY).toBe(false);
    expect(status.serverCanRunShell).toBe(false);
    expect(status.serverCanAccessBrowserOrWindow).toBe(false);
    expect(status.serverCanProveModelProcessing).toBe(false);
    expect(status.socket_is_not_bridge_green).toBe(true);
    expect(status.delivery_acceptance_is_not_model_processing).toBe(true);
    expect(status.recipient_quote_back_required_for_processing_proof).toBe(true);
  });

  test('target and risk policy allows Architect only and blocks Tier 3/Tier 4', () => {
    const policy = assessment(build()).target_and_risk_policy;
    const expected = serverHandlerContract.expectedServerHandlerAssessmentShape;

    expectRequiredFields(policy, expected.targetAndRiskPolicyRequiredFields);
    expect(policy).toEqual(expect.objectContaining(expected.targetAndRiskPolicyRequiredValues));
    expect(policy.allowed_target_role).toBe('architect');
    expect(policy.allowed_target_roles).toEqual(['architect']);
    expect(policy.blocked_direct_targets).toEqual(['builder', 'oracle']);
    expect(policy.builder_direct_target_authorized).toBe(false);
    expect(policy.oracle_direct_target_authorized).toBe(false);
    expect(policy.tier3_authorized).toBe(false);
    expect(policy.tier4_authorized).toBe(false);
    expect(policy.local_acceptance_required).toBe(true);
  });

  test('privacy/security boundary blocks raw/private/secret/key/ciphertext/decrypted content', () => {
    const boundary = assessment(build()).privacy_security_boundary;
    const expected = serverHandlerContract.expectedServerHandlerAssessmentShape;

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
    expect(boundary.redaction_summary_required).toBe(true);
  });

  test('real handler runtime stays gated behind future migration gates', () => {
    const gates = assessment(build()).runtime_migration_gates;
    const expected = serverHandlerContract.expectedServerHandlerAssessmentShape;

    expectRequiredFields(gates, expected.runtimeMigrationGatesRequiredFields);
    expect(gates).toEqual(expect.objectContaining(expected.runtimeMigrationGatesRequiredValues));
    expect(gates.baseline_commit).toBe(BASELINE_COMMIT);
    expect(gates.real_handler_runtime_allowed_now).toBe(false);
    expect(gates.future_real_handler_allowed_after_gates).toBe(true);
    expect(gates.requires_transport_tls_gate).toBe(true);
    expect(gates.requires_auth_middleware_gate).toBe(true);
    expect(gates.requires_replay_store_gate).toBe(true);
    expect(gates.requires_audit_logging_gate).toBe(true);
    expect(gates.requires_red_team_leakage_tests_gate).toBe(true);
    expect(gates.requires_route_handler_integration_tests_gate).toBe(true);
    expect(gates.feature_flag_default).toBe('off');
  });

  test('required gates and blockers are complete, unique, and evidence-backed', () => {
    const currentAssessment = assessment(build());
    const expected = serverHandlerContract.expectedServerHandlerAssessmentShape;

    expect(currentAssessment.acceptance_gate_summary.map((gate) => gate.gate_id)).toEqual(REQUIRED_GATE_IDS);
    expect(currentAssessment.acceptance_gate_summary.map((gate) => gate.gate_id)).toEqual(expected.requiredAcceptanceGateIds);
    for (const gate of currentAssessment.acceptance_gate_summary) {
      expectRequiredFields(gate, expected.acceptanceGateSummaryRequiredFields);
      expect(gate.required_before_real_handler).toBe(true);
      expect(gate.required_before_real_server).toBe(true);
      expect(gate.evidenceRefs.length).toBeGreaterThan(0);
    }

    expect(currentAssessment.blocker_summary.map((blocker) => blocker.blocker_id)).toEqual(REQUIRED_BLOCKER_IDS);
    expect(currentAssessment.blocker_summary.map((blocker) => blocker.blocker_id)).toEqual(expected.requiredBlockerIds);
    for (const blocker of currentAssessment.blocker_summary) {
      expectRequiredFields(blocker, expected.blockerSummaryRequiredFields);
      expect(blocker.evidenceRefs.length).toBeGreaterThan(0);
    }
  });

  test('side-effect truth is explicit in assessment and validation report', () => {
    const output = build();
    const expectedAssessment = serverHandlerContract.expectedServerHandlerAssessmentShape.sideEffectRequiredValues;
    const expectedReport = serverHandlerContract.expectedValidationReportShape.sideEffectRequiredValues;

    expect(assessment(output).side_effect_result).toEqual(expect.objectContaining(expectedAssessment));
    expect(report(output).side_effect_result).toEqual(expect.objectContaining(expectedReport));
    expect(assessment(output).side_effect_result.serverProcessesStarted).toBe(0);
    expect(assessment(output).side_effect_result.listenersStarted).toBe(0);
    expect(assessment(output).side_effect_result.routesRegistered).toBe(0);
    expect(assessment(output).side_effect_result.httpOrNetworkCallsAttempted).toBe(0);
    expect(assessment(output).side_effect_result.databaseOrStoreWritesAttempted).toBe(0);
    expect(assessment(output).side_effect_result.queuesCreated).toBe(0);
    expect(assessment(output).side_effect_result.outputFileWritten).toBe(false);
  });

  test('static validation rules and acceptance checks are represented', () => {
    const output = build();
    const validation = validateMiraCoreServerHandlerOutput(output, serverHandlerContract);
    const validatorCheckIds = validation.checks.map((entry) => entry.id);
    const reportCheckIds = report(output).acceptance_check_results.map((entry) => entry.id);

    expect(validation.ok).toBe(true);
    for (const rule of serverHandlerContract.staticValidationRules) {
      expect(validatorCheckIds).toContain(rule.id);
    }
    expect(reportCheckIds).toEqual(serverHandlerContract.acceptanceChecks.map((check) => check.id));
    expect(report(output).summary_criteria_results).toHaveLength(serverHandlerContract.summaryAcceptanceCriteria.length);
    expectNoForbiddenOutput(output);
  });

  test('validator rejects baseline drift, dependency gaps, and real handler dependency overclaims', () => {
    const valid = build();

    const baselineDrift = clone(valid);
    baselineDrift.server_handler_assessment.baseline_commit = 'badc0de';
    expectValidatorFails(baselineDrift, 'baseline-ce9e55d-pinned');

    const missingDependency = clone(valid);
    delete missingDependency.server_handler_assessment.dependency_map.phase_20_server_api_ref;
    expectValidatorFails(missingDependency, 'phase-14-through-20-dependency-map-required');

    const realRuntimeDependency = clone(valid);
    realRuntimeDependency.server_handler_assessment.dependency_map.real_handler_runtime_exists = true;
    expectValidatorFails(realRuntimeDependency, 'phase-14-through-20-dependency-map-required');

    const missingPhaseEntry = clone(valid);
    missingPhaseEntry.server_handler_assessment.dependency_map.dependency_paths.pop();
    expectValidatorFails(missingPhaseEntry, 'phase-14-through-20-dependency-map-required');
  });

  test('validator rejects live listener, route, network, registry, and dispatch overclaims', () => {
    const valid = build();

    const registryLiveRoute = clone(valid);
    registryLiveRoute.server_handler_assessment.handler_registry.real_route_table_created = true;
    expectValidatorFails(registryLiveRoute, 'handler-registry-pure-functions-only');

    const registryListener = clone(valid);
    registryListener.server_handler_assessment.handler_registry.listener_required_now = true;
    expectValidatorFails(registryListener, 'handler-registry-pure-functions-only');

    const handlerSideEffect = clone(valid);
    handlerSideEffect.server_handler_assessment.handler_registry.handlers[0].side_effect_free = false;
    expectValidatorFails(handlerSideEffect, 'handler-registry-pure-functions-only');

    const handlerRawPayload = clone(valid);
    handlerRawPayload.server_handler_assessment.handler_registry.handlers[0].raw_payload_allowed = true;
    expectValidatorFails(handlerRawPayload, 'handler-registry-pure-functions-only');

    const routeRegistered = clone(valid);
    routeRegistered.server_handler_assessment.endpoint_dispatch_table.route_registration_performed = true;
    expectValidatorFails(routeRegistered, 'dispatch-table-pure-no-routes');

    const networkPerformed = clone(valid);
    networkPerformed.server_handler_assessment.endpoint_dispatch_table.network_performed = true;
    expectValidatorFails(networkPerformed, 'dispatch-table-pure-no-routes');
  });

  test('validator rejects missing request refs, raw payload, scope mismatch, replay, watermark, tombstone, and expiry gaps', () => {
    const valid = build();

    const missingAuth = clone(valid);
    missingAuth.server_handler_assessment.request_envelope.auth_binding_ref = '';
    expectValidatorFails(missingAuth, 'request-envelope-complete-no-raw-payload');

    const missingSignature = clone(valid);
    missingSignature.server_handler_assessment.request_envelope.signature_ref = '';
    expectValidatorFails(missingSignature, 'request-envelope-complete-no-raw-payload');

    const missingKey = clone(valid);
    missingKey.server_handler_assessment.request_envelope.key_reference_ref = '';
    expectValidatorFails(missingKey, 'request-envelope-complete-no-raw-payload');

    const missingReplay = clone(valid);
    missingReplay.server_handler_assessment.request_envelope.replay_key = '';
    expectValidatorFails(missingReplay, 'request-envelope-complete-no-raw-payload');

    const rawPayloadAllowed = clone(valid);
    rawPayloadAllowed.server_handler_assessment.request_envelope.raw_payload_allowed = true;
    expectValidatorFails(rawPayloadAllowed, 'request-envelope-complete-no-raw-payload');

    const scopeMismatch = clone(valid);
    scopeMismatch.server_handler_assessment.request_envelope.profile = 'side';
    expectValidatorFails(scopeMismatch, 'request-envelope-complete-no-raw-payload');

    const missingExpiry = clone(valid);
    missingExpiry.server_handler_assessment.request_envelope.expires_at = '';
    expectValidatorFails(missingExpiry, 'request-envelope-complete-no-raw-payload');

    for (const field of [
      'replay_rejected_required',
      'watermark_regression_rejected',
      'tombstone_wins_required',
      'expired_request_blocked',
    ]) {
      const tampered = clone(valid);
      tampered.server_handler_assessment.idempotency_replay_watermark_tombstone[field] = false;
      expectValidatorFails(tampered, 'idempotency-replay-watermark-tombstone-rules');
    }
  });

  test('validator rejects response, storage, deletion, export, retention, and side-effect overclaims', () => {
    const valid = build();

    const responseStores = clone(valid);
    responseStores.server_handler_assessment.response_envelope.no_store_performed = false;
    expectValidatorFails(responseStores, 'response-envelope-status-only');

    const responseExecutes = clone(valid);
    responseExecutes.server_handler_assessment.response_envelope.no_execution_performed = false;
    expectValidatorFails(responseExecutes, 'response-envelope-status-only');

    const storageWrite = clone(valid);
    storageWrite.server_handler_assessment.storage_status_policy.storage_write_allowed_now = true;
    expectValidatorFails(storageWrite, 'storage-delete-export-status-only');

    const rawStorage = clone(valid);
    rawStorage.server_handler_assessment.storage_status_policy.raw_storage_allowed = true;
    expectValidatorFails(rawStorage, 'storage-delete-export-status-only');

    const deletePerformed = clone(valid);
    deletePerformed.server_handler_assessment.deletion_export_retention_status.delete_performed_now = true;
    expectValidatorFails(deletePerformed, 'storage-delete-export-status-only');

    const exportFile = clone(valid);
    exportFile.server_handler_assessment.deletion_export_retention_status.export_file_written_now = true;
    expectValidatorFails(exportFile, 'storage-delete-export-status-only');

    const sideEffectLie = clone(valid);
    sideEffectLie.server_handler_assessment.side_effect_result.no_server_process_started = false;
    sideEffectLie.server_handler_assessment.side_effect_result.serverProcessesStarted = 1;
    expectValidatorFails(sideEffectLie, 'phase-21-validation-only-no-runtime');
  });

  test('validator rejects local execution, proof, bridge, Builder/Oracle target, and Tier 3/Tier 4 overclaims', () => {
    const valid = build();

    for (const field of [
      'serverCanExecuteLocal',
      'serverCanOperatePTY',
      'serverCanRunShell',
      'serverCanAccessBrowserOrWindow',
      'serverCanProveModelProcessing',
    ]) {
      const tampered = clone(valid);
      tampered.server_handler_assessment.local_arms_status[field] = true;
      expectValidatorFails(tampered, 'local-arms-offline-truth-preserved');
    }

    const socketGreen = clone(valid);
    socketGreen.server_handler_assessment.local_arms_status.socket_is_not_bridge_green = false;
    expectValidatorFails(socketGreen, 'local-arms-offline-truth-preserved');
    expectValidatorFails(socketGreen, 'proof-bridge-overclaim-blocked');

    const deliveryProof = clone(valid);
    deliveryProof.server_handler_assessment.local_arms_status.delivery_acceptance_is_not_model_processing = false;
    expectValidatorFails(deliveryProof, 'local-arms-offline-truth-preserved');
    expectValidatorFails(deliveryProof, 'proof-bridge-overclaim-blocked');

    const builderTarget = clone(valid);
    builderTarget.server_handler_assessment.target_and_risk_policy.allowed_target_role = 'builder';
    builderTarget.server_handler_assessment.target_and_risk_policy.allowed_target_roles = ['builder'];
    expectValidatorFails(builderTarget, 'architect-only-target-and-risk-gates');

    const oracleTarget = clone(valid);
    oracleTarget.server_handler_assessment.target_and_risk_policy.oracle_direct_target_authorized = true;
    expectValidatorFails(oracleTarget, 'architect-only-target-and-risk-gates');

    const tier3 = clone(valid);
    tier3.server_handler_assessment.target_and_risk_policy.tier3_authorized = true;
    expectValidatorFails(tier3, 'architect-only-target-and-risk-gates');

    const tier4 = clone(valid);
    tier4.server_handler_assessment.target_and_risk_policy.tier4_authorized = true;
    expectValidatorFails(tier4, 'architect-only-target-and-risk-gates');
  });

  test('validator rejects privacy/security boundary gaps and real runtime gate drift', () => {
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
      tampered.server_handler_assessment.privacy_security_boundary[field] = false;
      expectValidatorFails(tampered, 'privacy-security-no-raw-or-secrets');
    }

    const realRuntimeAllowed = clone(build());
    realRuntimeAllowed.server_handler_assessment.runtime_migration_gates.real_handler_runtime_allowed_now = true;
    expectValidatorFails(realRuntimeAllowed, 'real-handler-runtime-migration-gated');

    const featureOn = clone(build());
    featureOn.server_handler_assessment.runtime_migration_gates.feature_flag_default = 'on';
    expectValidatorFails(featureOn, 'real-handler-runtime-migration-gated');
  });

  test('validator rejects missing gates/blockers, output shape gaps, and validation-report side-effect lies', () => {
    const valid = build();

    const missingGate = clone(valid);
    missingGate.server_handler_assessment.acceptance_gate_summary.pop();
    expectValidatorFails(missingGate, 'required-gates-and-blockers-present');

    const missingBlocker = clone(valid);
    missingBlocker.server_handler_assessment.blocker_summary.pop();
    expectValidatorFails(missingBlocker, 'required-gates-and-blockers-present');

    const outputMissing = clone(valid);
    delete outputMissing.validation_report;
    expectValidatorFails(outputMissing, 'output-shape-complete');

    const reportSideEffectLie = clone(valid);
    reportSideEffectLie.validation_report.side_effect_result.no_routes_registered = false;
    reportSideEffectLie.validation_report.side_effect_result.routesRegistered = 1;
    expectValidatorFails(reportSideEffectLie, 'validation-side-effect-truth');
  });

  test('validator rejects forbidden raw/secret/server/proof/target/risk substrings in values', () => {
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
      'handler route registered',
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
      'handler authorizes local execution',
      'handler proves model processing',
      'socket alone proves bridge green',
      'builder direct target authorized',
      'oracle direct target authorized',
      'tier3 authorized by handler',
      'tier4 authorized by handler',
      'memory commit authorized by handler',
    ];

    for (const forbidden of forbiddenValues) {
      const tampered = clone(build());
      tampered.server_handler_assessment.blocker_summary[0].safe_next_action = forbidden;
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
    expect(first.handler_contract_id).toBe(second.handler_contract_id);
    expect(first.idempotency_key).not.toBe(changedDevice.idempotency_key);
    expect(first.idempotency_key).not.toBe(changedProfile.idempotency_key);
    expect(first.idempotency_key).not.toBe(changedTenant.idempotency_key);

    const tampered = clone(build());
    tampered.server_handler_assessment.handler_registry.pure_functions_only = false;
    expectValidatorFails(tampered, 'idempotency-stable');
  });

  test('CLI is stdout-only, consumes the Oracle fixture, and ignores output-file flags', () => {
    const parsed = parseArgs(['--pretty', '--out', 'ignored.json']);
    expect(parsed.pretty).toBe(true);
    expect(parsed.fixturePath).toContain('mira-core-server-handler-contract.json');

    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const output = main(['--out=ignored.json'], JSON.stringify({
      profile: { name: 'main' },
      sessionId: 'session-cli',
      deviceId: 'VIGIL',
      tenantId: 'tenant:james-main-validation',
    }));

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(assessment(output).schema).toBe(SERVER_HANDLER_ASSESSMENT_SCHEMA_VERSION);
    expect(assessment(output).sessionId).toBe('session-cli');
    expect(assessment(output).handler_registry.handler_count).toBe(REQUIRED_ENDPOINT_IDS.length);
    expect(assessment(output).endpoint_dispatch_table.dispatch_is_pure).toBe(true);
    expect(assessment(output).endpoint_dispatch_table.route_registration_performed).toBe(false);
    expect(assessment(output).side_effect_result.no_server_process_started).toBe(true);
    expect(assessment(output).side_effect_result.no_listener_started).toBe(true);
    expect(assessment(output).side_effect_result.no_routes_registered).toBe(true);
    expect(assessment(output).side_effect_result.no_http_or_network_performed).toBe(true);
    expect(assessment(output).side_effect_result.no_output_file_written).toBe(true);
    expect(assessment(output).side_effect_result.outputFileWritten).toBe(false);
    expect(report(output).decision).toBe('accepted');
    expect(validateMiraCoreServerHandlerOutput(output, serverHandlerContract)).toEqual(expect.objectContaining({ ok: true }));
  });
});
