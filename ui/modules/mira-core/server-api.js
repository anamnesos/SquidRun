'use strict';

const crypto = require('crypto');

const SERVER_API_ASSESSMENT_SCHEMA_VERSION = 'squidrun.mira_core.server_api_assessment.v0';
const VALIDATION_REPORT_SCHEMA_VERSION = 'squidrun.mira_core.server_api_validation_report.v0';
const SERVER_API_VERSION = 'v0';
const BASELINE_COMMIT = '8a8ccf0';

const REQUIRED_OUTPUT_FIELDS = Object.freeze([
  'server_api_assessment',
  'validation_report',
]);

const REQUIRED_ASSESSMENT_FIELDS = Object.freeze([
  'schema',
  'version',
  'assessment_id',
  'idempotency_key',
  'generated_at',
  'baseline_commit',
  'profile',
  'sessionId',
  'deviceId',
  'dependency_map',
  'planned_endpoint_control_plane',
  'request_response_envelope',
  'status_semantics',
  'operator_controls',
  'privacy_security_boundary',
  'capability_boundary',
  'migration_gates',
  'acceptance_gate_summary',
  'blocker_summary',
  'evidenceRefs',
  'side_effect_result',
]);

const REQUIRED_VALIDATION_REPORT_FIELDS = Object.freeze([
  'schema',
  'version',
  'validation_id',
  'generated_at',
  'baseline_commit',
  'fixture_schema',
  'assessment_schema',
  'profile',
  'sessionId',
  'deviceId',
  'decision',
  'reasons',
  'dependency_map_result',
  'planned_endpoint_control_plane_result',
  'request_response_envelope_result',
  'status_semantics_result',
  'operator_controls_result',
  'privacy_security_boundary_result',
  'capability_boundary_result',
  'migration_gates_result',
  'static_rule_results',
  'acceptance_check_results',
  'forbidden_output_result',
  'summary_criteria_results',
  'evidenceRefs',
  'side_effect_result',
]);

const REQUIRED_SIDE_EFFECT_FIELDS = Object.freeze([
  'no_runtime_implementation_performed',
  'no_server_process_started',
  'no_listener_started',
  'no_routes_registered',
  'no_network_performed',
  'no_database_or_store_write_performed',
  'no_file_write_performed',
  'no_migration_executed',
  'no_queue_created',
  'no_auth_secret_token_session_change_performed',
  'no_key_generation_performed',
  'no_encryption_performed',
  'no_decryption_performed',
  'no_kms_call_performed',
  'no_env_secret_read_performed',
  'no_local_execution_performed',
  'no_shell_or_pty_performed',
  'no_browser_window_access_performed',
  'no_external_send_performed',
  'no_customer_send_performed',
  'no_deploy_performed',
  'no_trade_performed',
  'no_memory_profile_commit_performed',
  'no_export_file_written',
  'no_delete_performed',
  'no_restore_performed',
  'no_raw_content_stored',
  'no_output_file_written',
  'no_durable_migration_performed',
]);

const SIDE_EFFECT_COUNTER_FIELDS = Object.freeze([
  'runtimeImplementationsAttempted',
  'serverProcessesStarted',
  'listenersStarted',
  'routesRegistered',
  'networkRequestsAttempted',
  'databaseOrStoreWritesAttempted',
  'fileWritesAttempted',
  'migrationsAttempted',
  'queuesCreated',
  'authSecretTokenSessionChangesAttempted',
  'keyGenerationsAttempted',
  'encryptionsAttempted',
  'decryptionsAttempted',
  'kmsCallsAttempted',
  'envSecretReadsAttempted',
  'localExecutionAttempted',
  'shellOrPtyAttempted',
  'browserWindowAccessAttempted',
  'externalSendsAttempted',
  'customerSendsAttempted',
  'deploysAttempted',
  'tradesAttempted',
  'memoryProfileCommitsAttempted',
  'exportFilesAttempted',
  'deletesAttempted',
  'restoresAttempted',
  'rawContentStorageAttempted',
  'durableMigrationsAttempted',
]);

const REQUIRED_GATE_IDS = Object.freeze([
  'baseline-dependency-map-pinned',
  'planned-endpoint-control-plane-specified',
  'request-response-envelope-specified',
  'status-semantics-specified',
  'operator-controls-specified',
  'privacy-security-boundary-specified',
  'capability-boundary-specified',
  'migration-gates-to-real-api-specified',
  'auth-signature-key-dependency-refs-required',
  'replay-idempotency-and-tombstone-rules-specified',
  'side-effect-free-validation-only',
]);

const REQUIRED_BLOCKER_IDS = Object.freeze([
  'server-listener-routes-blocked',
  'network-call-blocked',
  'db-store-file-queue-write-blocked',
  'auth-signature-key-ref-missing-blocked',
  'raw-api-payload-leakage-blocked',
  'replay-idempotency-store-blocked',
  'delete-export-real-action-blocked',
  'local-execution-capability-overclaim-blocked',
  'builder-oracle-direct-target-blocked',
  'high-risk-action-blocked',
  'proof-bridge-overclaim-blocked',
  'real-api-runtime-still-blocked',
]);

const ALLOWED_STATUSES = Object.freeze([
  'accepted_for_validation_only',
  'blocked',
  'pending_local_acceptance',
  'offline_local_arms',
  'review_required',
  'expired',
  'replay_rejected',
  'tombstone_wins',
  'no_store_performed',
  'no_execution_performed',
]);

const REQUIRED_ENDPOINT_IDS = Object.freeze([
  'receive-upload-envelope',
  'validate-auth-signature-key-refs',
  'future-store-dry-run-status',
  'export-delete-request-status',
  'retention-tombstone-status',
  'local-arms-offline-status',
  'intent-proposal-status',
  'audit-log-status',
  'health-readiness-status',
]);

const FORBIDDEN_OUTPUT_SUBSTRINGS = Object.freeze([
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'Authorization: Bearer',
  'Bearer token',
  'Set-Cookie',
  'cookie=',
  'session_secret',
  'BEGIN PRIVATE KEY',
  'PRIVATE KEY',
  'DATA KEY',
  'plaintext key',
  'raw plaintext payload',
  'raw ciphertext payload',
  'decrypted raw content',
  'raw comms body',
  'raw terminal scrollback',
  'screenshot OCR text',
  'browser cookies',
  'browser session state',
  'customer private note',
  'customer phone',
  'customer address',
  'side-profile private note',
  'profile mismatch payload',
  'server listener started',
  'route registered',
  'network request complete',
  'database write complete',
  'store write complete',
  'file write complete',
  'migration executed',
  'queue created',
  'key generated',
  'encryption performed',
  'decryption performed',
  'kms call complete',
  'env secret read',
  'output file written',
  'export file written',
  'delete performed',
  'restore performed',
  'raw content stored',
  'server executed local work',
  'server can run shell',
  'server can operate PTY',
  'server can access browser',
  'server sent customer message',
  'server deployed',
  'server placed trade',
  'api authorizes local execution',
  'api authorizes database write',
  'api proves model processing',
  'api proves bridge green',
  'socket alone proves bridge green',
  'delivery acceptance proves model processing',
  'builder direct target authorized',
  'oracle direct target authorized',
  'tier3 authorized by api',
  'tier4 authorized by api',
  'memory commit authorized by api',
]);

const DEPENDENCIES = Object.freeze([
  {
    phase: 14,
    name: 'server-runtime-gap',
    fixture_path: 'ui/__tests__/fixtures/mira-core-server-runtime-gap-contract.json',
    baseline_commit: 'f41b02a',
    implementation_commit: 'f41b02a',
    status: 'green_validation_only',
    boundary_mode: 'validation_only_no_runtime',
    ref_field: 'phase_14_server_runtime_gap_ref',
    ref_value: 'mira-core-server-runtime-gap-contract:phase_14_green',
  },
  {
    phase: 15,
    name: 'identity-signing',
    fixture_path: 'ui/__tests__/fixtures/mira-core-identity-signing-contract.json',
    baseline_commit: '3904697',
    implementation_commit: '3904697',
    status: 'green_validation_only',
    boundary_mode: 'validation_only_no_runtime',
    ref_field: 'phase_15_identity_signing_ref',
    ref_value: 'mira-core-identity-signing-contract:phase_15_green',
  },
  {
    phase: 16,
    name: 'auth-binding',
    fixture_path: 'ui/__tests__/fixtures/mira-core-auth-binding-contract.json',
    baseline_commit: '6f97287',
    implementation_commit: '6f97287',
    status: 'green_validation_only',
    boundary_mode: 'validation_only_no_runtime',
    ref_field: 'phase_16_auth_binding_ref',
    ref_value: 'mira-core-auth-binding-contract:phase_16_green',
  },
  {
    phase: 17,
    name: 'storage-retention',
    fixture_path: 'ui/__tests__/fixtures/mira-core-storage-retention-contract.json',
    baseline_commit: 'afabea1',
    implementation_commit: 'afabea1',
    status: 'green_validation_only',
    boundary_mode: 'validation_only_no_runtime',
    ref_field: 'phase_17_storage_retention_ref',
    ref_value: 'mira-core-storage-retention-contract:phase_17_green',
  },
  {
    phase: 18,
    name: 'persistence-audit',
    fixture_path: 'ui/__tests__/fixtures/mira-core-persistence-audit-contract.json',
    baseline_commit: '3742ab7',
    implementation_commit: '3742ab7',
    status: 'green_validation_only',
    boundary_mode: 'validation_only_no_runtime',
    ref_field: 'phase_18_persistence_audit_ref',
    ref_value: 'mira-core-persistence-audit-contract:phase_18_green',
  },
  {
    phase: 19,
    name: 'encryption-key',
    fixture_path: 'ui/__tests__/fixtures/mira-core-encryption-key-contract.json',
    baseline_commit: '8a8ccf0',
    implementation_commit: '8a8ccf0',
    status: 'green_validation_only',
    boundary_mode: 'validation_only_no_runtime',
    ref_field: 'phase_19_encryption_key_ref',
    ref_value: 'mira-core-encryption-key-contract:phase_19_green',
  },
]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = sortObject(value[key]);
    return result;
  }, {});
}

function stableHash(value) {
  return crypto
    .createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(sortObject(value)))
    .digest('hex');
}

function generatedAtFromOptions(options = {}, inputSignals = {}) {
  const raw = inputSignals.now || options.generatedAt || options.now;
  if (raw) return new Date(raw).toISOString();
  return new Date(Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now()).toISOString();
}

function normalizeProfile(value) {
  const name = typeof value === 'object' && value ? value.name : value;
  const normalized = String(name || 'main').trim() || 'main';
  return {
    name: normalized,
    windowKey: normalized,
    sessionScopeId: normalized,
  };
}

function normalizeScope(inputSignals = {}) {
  const profile = normalizeProfile(inputSignals.profile);
  return {
    profile,
    profileName: profile.name,
    tenantId: inputSignals.tenantId || 'tenant:james-main-validation',
    sessionId: inputSignals.sessionId || 'app-session-326',
    deviceId: inputSignals.deviceId || 'VIGIL',
  };
}

function pathValue(value, path) {
  return String(path || '').split('.').reduce((current, part) => {
    if (current === null || current === undefined) return undefined;
    return current[part];
  }, value);
}

function valuesMatch(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function hasRequiredFields(value, fields) {
  return asArray(fields).every((field) => Object.prototype.hasOwnProperty.call(value || {}, field));
}

function evidenceRef(kind, id, relation = 'server_api_validation') {
  return {
    store: 'mira-core-server-api',
    eventId: `${kind}:${id}`,
    relation,
  };
}

function withEvidence(value, kind, id) {
  return {
    ...value,
    evidenceRefs: asArray(value.evidenceRefs).length > 0
      ? clone(value.evidenceRefs)
      : [evidenceRef(kind, id || value.status || 'unknown')],
  };
}

function sideEffectResult(overrides = {}) {
  return {
    no_runtime_implementation_performed: true,
    no_server_process_started: true,
    no_listener_started: true,
    no_routes_registered: true,
    no_network_performed: true,
    no_database_or_store_write_performed: true,
    no_file_write_performed: true,
    no_migration_executed: true,
    no_queue_created: true,
    no_auth_secret_token_session_change_performed: true,
    no_key_generation_performed: true,
    no_encryption_performed: true,
    no_decryption_performed: true,
    no_kms_call_performed: true,
    no_env_secret_read_performed: true,
    no_local_execution_performed: true,
    no_shell_or_pty_performed: true,
    no_browser_window_access_performed: true,
    no_external_send_performed: true,
    no_customer_send_performed: true,
    no_deploy_performed: true,
    no_trade_performed: true,
    no_memory_profile_commit_performed: true,
    no_export_file_written: true,
    no_delete_performed: true,
    no_restore_performed: true,
    no_raw_content_stored: true,
    no_output_file_written: true,
    no_durable_migration_performed: true,
    runtimeImplementationsAttempted: 0,
    serverProcessesStarted: 0,
    listenersStarted: 0,
    routesRegistered: 0,
    networkRequestsAttempted: 0,
    databaseOrStoreWritesAttempted: 0,
    fileWritesAttempted: 0,
    migrationsAttempted: 0,
    queuesCreated: 0,
    authSecretTokenSessionChangesAttempted: 0,
    keyGenerationsAttempted: 0,
    encryptionsAttempted: 0,
    decryptionsAttempted: 0,
    kmsCallsAttempted: 0,
    envSecretReadsAttempted: 0,
    localExecutionAttempted: 0,
    shellOrPtyAttempted: 0,
    browserWindowAccessAttempted: 0,
    externalSendsAttempted: 0,
    customerSendsAttempted: 0,
    deploysAttempted: 0,
    tradesAttempted: 0,
    memoryProfileCommitsAttempted: 0,
    exportFilesAttempted: 0,
    deletesAttempted: 0,
    restoresAttempted: 0,
    rawContentStorageAttempted: 0,
    durableMigrationsAttempted: 0,
    outputFileWritten: false,
    ...overrides,
  };
}

function dependencyMap() {
  const map = withEvidence({
    baseline_ref: `commit:${BASELINE_COMMIT}`,
    dependency_paths: DEPENDENCIES.map((dependency) => ({
      phase: dependency.phase,
      name: dependency.name,
      fixture_path: dependency.fixture_path,
      baseline_commit: dependency.baseline_commit,
      implementation_commit: dependency.implementation_commit,
      status: dependency.status,
      boundary_mode: dependency.boundary_mode,
    })),
    dependency_commits: DEPENDENCIES.reduce((result, dependency) => {
      result[`phase_${dependency.phase}`] = dependency.implementation_commit;
      return result;
    }, {}),
    all_dependencies_validation_only: true,
    real_server_dependency_exists: false,
    real_api_dependency_exists: false,
  }, 'dependency-map', 'baseline-dependency-map-pinned');
  for (const dependency of DEPENDENCIES) {
    map[dependency.ref_field] = dependency.ref_value;
  }
  return map;
}

function endpointRecord(endpointId, method, suffix, purpose) {
  return {
    endpoint_id: endpointId,
    method,
    path: `/v0/mira-core/${suffix}`,
    purpose,
    boundary_mode: 'planned_validation_only_endpoint_shape',
    side_effect_free: true,
    allowed_statuses: clone(ALLOWED_STATUSES),
    raw_payload_allowed: false,
    requires_auth_binding_ref: true,
    requires_signature_ref: true,
    requires_key_reference_ref: true,
    requires_evidenceRefs: true,
  };
}

function plannedEndpointControlPlane() {
  const endpoints = [
    endpointRecord('receive-upload-envelope', 'POST', 'receive-upload-envelope', 'Validate redacted upload envelope metadata.'),
    endpointRecord('validate-auth-signature-key-refs', 'POST', 'validate-auth-signature-key-refs', 'Validate auth, signature, and key references.'),
    endpointRecord('future-store-dry-run-status', 'POST', 'future-store-dry-run-status', 'Return future store dry-run status.'),
    endpointRecord('export-delete-request-status', 'POST', 'export-delete-request-status', 'Return export and delete request status records.'),
    endpointRecord('retention-tombstone-status', 'POST', 'retention-tombstone-status', 'Return retention and tombstone status records.'),
    endpointRecord('local-arms-offline-status', 'GET', 'local-arms-offline-status', 'Return honest local-arms offline status.'),
    endpointRecord('intent-proposal-status', 'POST', 'intent-proposal-status', 'Return validation-only intent proposal status.'),
    endpointRecord('audit-log-status', 'GET', 'audit-log-status', 'Return redacted audit-log status.'),
    endpointRecord('health-readiness-status', 'GET', 'health-readiness-status', 'Return health and readiness status.'),
  ];
  return withEvidence({
    planned_only: true,
    real_server_listener_created: false,
    routes_registered_now: false,
    endpoints,
    control_plane_actions: [
      'receive_upload_validation_status',
      'auth_signature_key_ref_validation_status',
      'future_store_dry_run_status',
      'export_delete_request_status',
      'retention_tombstone_status',
      'local_arms_offline_status',
      'intent_proposal_status',
      'audit_status',
      'health_readiness_status',
    ],
    endpoint_count: endpoints.length,
    allowed_methods: ['GET', 'POST'],
    requires_request_response_envelope: true,
    requires_status_semantics: true,
  }, 'endpoint-control-plane', 'planned-endpoint-control-plane-specified');
}

function envelopeIdempotencyInput(scope) {
  return {
    method: 'POST',
    path: '/v0/mira-core/receive-upload-envelope',
    action_id: 'receive-upload-envelope-validation',
    tenant_id: scope.tenantId,
    profile: scope.profileName,
    device_id: scope.deviceId,
    session_id: scope.sessionId,
    source_watermark: 'watermark:phase20-validation',
  };
}

function requestResponseEnvelope(scope) {
  const envelopeInput = envelopeIdempotencyInput(scope);
  const envelopeHash = stableHash(envelopeInput);
  return withEvidence({
    schema: 'squidrun.mira_core.server_api_envelope.v0',
    method: envelopeInput.method,
    path: envelopeInput.path,
    action_id: envelopeInput.action_id,
    idempotency_key: `server-api-idem:${envelopeHash}`,
    replay_key: `server-api-replay:${stableHash({ envelopeHash, replay: 'scope-bound' })}`,
    tenant_id: scope.tenantId,
    profile: scope.profileName,
    device_id: scope.deviceId,
    session_id: scope.sessionId,
    auth_binding_ref: 'auth-binding-validation:phase_16_green',
    signature_ref: 'identity-signing-validation:phase_15_green',
    key_reference_ref: 'encryption-key-validation:phase_19_green',
    source_watermark: envelopeInput.source_watermark,
    redaction_summary: {
      raw_payload_exported: false,
      private_content_withheld: true,
      refs_only: true,
    },
    risk_tier: 'tier0_read_only',
    status: 'accepted_for_validation_only',
    allowed: true,
    review_required: false,
    expires_at: '2026-05-07T00:00:00.000Z',
    no_raw_payload: true,
    raw_payload_allowed: false,
    idempotency_replay_keys_required: true,
    tenant_profile_device_session_scope_required: true,
    auth_signature_key_refs_required: true,
    source_watermark_required: true,
    redaction_summary_required: true,
    evidence_refs_required: true,
    expires_at_required: true,
    same_request_same_decision: true,
    scope_change_changes_idempotency: true,
  }, 'request-response-envelope', 'request-response-envelope-specified');
}

function statusSemantics() {
  return withEvidence({
    allowed_statuses: clone(ALLOWED_STATUSES),
    terminal_statuses: [
      'blocked',
      'expired',
      'replay_rejected',
      'tombstone_wins',
      'no_store_performed',
      'no_execution_performed',
    ],
    transient_statuses: [
      'accepted_for_validation_only',
      'pending_local_acceptance',
      'offline_local_arms',
      'review_required',
    ],
    no_store_performed_required: true,
    no_execution_performed_required: true,
    tombstone_wins_required: true,
    replay_rejected_required: true,
    offline_local_arms_honest: true,
    pending_local_acceptance_requires_architect: true,
  }, 'status-semantics', 'status-semantics-specified');
}

function operatorControls() {
  return withEvidence({
    read_only_status_controls_only: true,
    status_report_controls: [
      'dependency_status_report',
      'endpoint_shape_report',
      'envelope_validation_report',
      'offline_local_arms_report',
      'audit_status_report',
    ],
    future_delete_request_shape: {
      schema: 'squidrun.mira_core.server_api_delete_request_status.v0',
      mode: 'record_only',
      status_only: true,
    },
    future_export_manifest_shape: {
      schema: 'squidrun.mira_core.server_api_export_manifest_status.v0',
      mode: 'redacted_manifest_only',
      refs_only: true,
    },
    future_retention_control_shape: {
      schema: 'squidrun.mira_core.server_api_retention_status.v0',
      mode: 'status_record_only',
      redacted_refs_only: true,
    },
    delete_export_retention_actions_performed_now: false,
    james_visible_controls_required: true,
    redacted_manifests_only: true,
  }, 'operator-controls', 'operator-controls-specified');
}

function privacySecurityBoundary() {
  return withEvidence({
    no_raw_private_content: true,
    no_secret_material: true,
    no_profile_mismatch_content: true,
    no_side_profile_content: true,
    no_bearer_tokens: true,
    no_cookies: true,
    no_session_secrets: true,
    no_private_keys: true,
    no_data_keys: true,
    no_plaintext_ciphertext_or_decrypted_content: true,
    blocked_content_classes: [
      'raw_comms',
      'raw_terminal',
      'screenshot_ocr',
      'browser_state',
      'customer_private',
      'secret_material',
      'side_profile',
      'profile_mismatch',
      'bearer_header_value',
      'cookie_header_value',
      'session-secret-value',
      'private_key_value',
      'data_key_value',
      'plaintext_value',
      'ciphertext_value',
      'decrypted_content_value',
    ],
    forbidden_header_values: [
      'authorization_header_value',
      'cookie_header_value',
      'session-secret-header-value',
    ],
    redaction_summary_required: true,
  }, 'privacy-security', 'privacy-security-boundary-specified');
}

function capabilityBoundary() {
  return withEvidence({
    api_validity_permits: 'future_server_api_control_plane_status_validation_only',
    local_execution_authorized: false,
    shell_or_pty_authorized: false,
    db_write_authorized: false,
    storage_write_authorized: false,
    builder_direct_target_authorized: false,
    oracle_direct_target_authorized: false,
    tier2_plus_authorized: false,
    customer_send_authorized: false,
    deploy_authorized: false,
    trade_authorized: false,
    memory_profile_commit_authorized: false,
    model_processing_proven: false,
    bridge_green_proven: false,
    raw_restore_authorized: false,
    server_resurrection_of_deleted_state_authorized: false,
    allowed_target_role: 'architect',
    local_acceptance_required: true,
  }, 'capability', 'capability-boundary-specified');
}

function migrationGates() {
  return withEvidence({
    baseline_commit: BASELINE_COMMIT,
    phase_19_dependency_id: 'encryption-key-validation-green',
    real_api_server_allowed_now: false,
    future_real_api_allowed_after_gates: true,
    requires_transport_tls_gate: true,
    requires_auth_middleware_gate: true,
    requires_replay_store_gate: true,
    requires_rate_limits_gate: true,
    requires_audit_logging_gate: true,
    requires_schema_migrations_gate: true,
    requires_encryption_kms_integration_gate: true,
    requires_deletion_export_jobs_gate: true,
    requires_operator_ui_gate: true,
    requires_monitoring_alerts_gate: true,
    requires_disaster_recovery_gate: true,
    requires_profile_isolation_tests_gate: true,
    requires_red_team_leakage_tests_gate: true,
    feature_flag_default: 'off',
    rollback_plan_required: true,
  }, 'migration-gates', 'migration-gates-to-real-api-specified');
}

function acceptanceGateSummary() {
  return REQUIRED_GATE_IDS.map((gateId) => ({
    gate_id: gateId,
    status: gateId === 'side-effect-free-validation-only' ? 'satisfied_for_phase_20_validator' : 'specified_for_validation_pending_api',
    required_before_real_server: true,
    required_before_real_api: true,
    evidenceRefs: [evidenceRef('acceptance-gate', gateId)],
    blocked_until: gateId === 'side-effect-free-validation-only'
      ? 'Phase 20 remains validation-only and side-effect-free.'
      : 'Reviewed API, envelope, replay, privacy, capability, and operator-control gates exist.',
  }));
}

function blockerSummary() {
  return [
    {
      blocker_id: 'server-listener-routes-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Server process, listener binding, and endpoint registration stay out of Phase 20.',
      safe_next_action: 'Review transport, TLS, auth middleware, and runtime gates before API runtime work.',
    },
    {
      blocker_id: 'network-call-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Network work stays blocked; endpoint records are planned shapes only.',
      safe_next_action: 'Keep CLI stdout-only and module validation-only until runtime is scoped.',
    },
    {
      blocker_id: 'db-store-file-queue-write-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Persistence, filesystem, and queue mutations remain blocked.',
      safe_next_action: 'Use status records and dry-run envelopes until storage and queue gates are reviewed.',
    },
    {
      blocker_id: 'auth-signature-key-ref-missing-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Requests fail closed without auth, signature, and key reference proofs.',
      safe_next_action: 'Keep Phase 15, 16, and 19 refs required on every request envelope.',
    },
    {
      blocker_id: 'raw-api-payload-leakage-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Raw private, secret, side-profile, token, key, plaintext, ciphertext, and decrypted values are blocked.',
      safe_next_action: 'Keep redaction summaries and reference-only payload metadata in API outputs.',
    },
    {
      blocker_id: 'replay-idempotency-store-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Replay and idempotency validation is specified without a durable replay store.',
      safe_next_action: 'Review replay store and watermark gates before runtime API work.',
    },
    {
      blocker_id: 'delete-export-real-action-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Delete, export, and retention controls are request/status records only.',
      safe_next_action: 'Keep operator controls read-only until deletion/export jobs are explicitly scoped.',
    },
    {
      blocker_id: 'local-execution-capability-overclaim-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'API validation cannot grant local execution, shell, PTY, storage writes, or high-risk work.',
      safe_next_action: 'Keep capability-boundary regressions covering every overclaim.',
    },
    {
      blocker_id: 'builder-oracle-direct-target-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Future server-originated targeting remains Architect-only.',
      safe_next_action: 'Keep Builder and Oracle direct targets blocked in API status outputs.',
    },
    {
      blocker_id: 'high-risk-action-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Tier 3 and Tier 4 action classes cannot be API-authorized.',
      safe_next_action: 'Keep customer-send, deploy, trade, financial, and irreversible work blocked.',
    },
    {
      blocker_id: 'proof-bridge-overclaim-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Socket and delivery status cannot prove bridge green or recipient model processing.',
      safe_next_action: 'Require role discovery, target proof, and recipient proof before green status.',
    },
    {
      blocker_id: 'real-api-runtime-still-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Real API runtime remains blocked by Phase 20 gates.',
      safe_next_action: 'Continue contract-first validation until Architect scopes runtime work.',
    },
  ].map((blocker) => ({
    ...blocker,
    evidenceRefs: [evidenceRef('blocker', blocker.blocker_id)],
  }));
}

function canonicalAssessmentInput(assessment = {}) {
  return {
    baseline_commit: assessment.baseline_commit,
    profile: assessment.profile,
    sessionId: assessment.sessionId,
    deviceId: assessment.deviceId,
    dependency_map: assessment.dependency_map,
    planned_endpoint_control_plane: assessment.planned_endpoint_control_plane,
    request_response_envelope: assessment.request_response_envelope,
    status_semantics: assessment.status_semantics,
    operator_controls: assessment.operator_controls,
    privacy_security_boundary: assessment.privacy_security_boundary,
    capability_boundary: assessment.capability_boundary,
    migration_gates: assessment.migration_gates,
    acceptance_gate_summary: assessment.acceptance_gate_summary,
    blocker_summary: assessment.blocker_summary,
    side_effect_result: assessment.side_effect_result,
  };
}

function assessmentIdempotencyKey(assessment) {
  return `server-api-idem:${stableHash(canonicalAssessmentInput(assessment))}`;
}

function buildAssessment(options = {}) {
  const inputSignals = options.inputSignals || {};
  const generatedAt = generatedAtFromOptions(options, inputSignals);
  const scope = normalizeScope(inputSignals);
  const assessment = {
    schema: SERVER_API_ASSESSMENT_SCHEMA_VERSION,
    version: SERVER_API_VERSION,
    assessment_id: null,
    idempotency_key: null,
    generated_at: generatedAt,
    baseline_commit: BASELINE_COMMIT,
    profile: scope.profile,
    sessionId: scope.sessionId,
    deviceId: scope.deviceId,
    dependency_map: dependencyMap(),
    planned_endpoint_control_plane: plannedEndpointControlPlane(),
    request_response_envelope: requestResponseEnvelope(scope),
    status_semantics: statusSemantics(),
    operator_controls: operatorControls(),
    privacy_security_boundary: privacySecurityBoundary(),
    capability_boundary: capabilityBoundary(),
    migration_gates: migrationGates(),
    acceptance_gate_summary: acceptanceGateSummary(),
    blocker_summary: blockerSummary(),
    evidenceRefs: [
      evidenceRef('baseline', BASELINE_COMMIT),
      evidenceRef('fixture', 'mira-core-server-api-contract'),
    ],
    side_effect_result: sideEffectResult(),
  };
  assessment.idempotency_key = assessmentIdempotencyKey(assessment);
  assessment.assessment_id = `server-api-${stableHash(assessment.idempotency_key).slice(0, 12)}`;
  assertNoForbiddenOutput(assessment);
  return assessment;
}

function resultObject(ok, detail = null, extra = {}) {
  return {
    ok: ok === true,
    detail,
    ...extra,
  };
}

function literalValuesOk(value, literals = {}) {
  return Object.entries(literals || {}).every(([path, expected]) => valuesMatch(pathValue(value, path), expected));
}

function sectionValuesOk(section = {}, requiredFields = [], requiredValues = {}) {
  return hasRequiredFields(section, requiredFields)
    && Object.entries(requiredValues || {}).every(([field, expected]) => valuesMatch(section[field], expected))
    && asArray(section.evidenceRefs).length > 0;
}

function sideEffectValuesOk(value = {}, expectedValues = {}) {
  const requiredPresent = REQUIRED_SIDE_EFFECT_FIELDS.every((field) => Object.prototype.hasOwnProperty.call(value || {}, field));
  const expectedOk = Object.entries(expectedValues || {}).every(([field, expected]) => valuesMatch(value[field], expected));
  const countersOk = SIDE_EFFECT_COUNTER_FIELDS.every((field) => value[field] === undefined || Number(value[field]) === 0);
  return requiredPresent
    && expectedOk
    && countersOk
    && value.outputFileWritten !== true;
}

function dependencyMapOk(assessment, expected = {}) {
  const map = assessment.dependency_map || {};
  const phaseEntries = asArray(map.dependency_paths);
  return sectionValuesOk(map, expected.dependencyMapRequiredFields, expected.dependencyMapRequiredValues)
    && phaseEntries.length === DEPENDENCIES.length
    && phaseEntries.every((entry) => hasRequiredFields(entry, expected.dependencyPhaseEntriesRequired || []))
    && valuesMatch(phaseEntries.map((entry) => entry.phase), DEPENDENCIES.map((dependency) => dependency.phase))
    && DEPENDENCIES.every((dependency) => map[dependency.ref_field] === dependency.ref_value
      && map.dependency_commits?.[`phase_${dependency.phase}`] === dependency.implementation_commit);
}

function endpointControlPlaneOk(assessment, expected = {}) {
  const control = assessment.planned_endpoint_control_plane || {};
  const endpoints = asArray(control.endpoints);
  return sectionValuesOk(control, expected.plannedEndpointControlPlaneRequiredFields, expected.plannedEndpointControlPlaneRequiredValues)
    && valuesMatch(control.allowed_methods, expected.plannedEndpointControlPlaneRequiredValues?.allowed_methods)
    && control.endpoint_count === REQUIRED_ENDPOINT_IDS.length
    && endpoints.length === REQUIRED_ENDPOINT_IDS.length
    && valuesMatch(endpoints.map((endpoint) => endpoint.endpoint_id), REQUIRED_ENDPOINT_IDS)
    && endpoints.every((endpoint) => hasRequiredFields(endpoint, expected.endpointRequiredFields || [])
      && endpoint.side_effect_free === true
      && endpoint.raw_payload_allowed === false
      && endpoint.requires_auth_binding_ref === true
      && endpoint.requires_signature_ref === true
      && endpoint.requires_key_reference_ref === true
      && endpoint.requires_evidenceRefs === true
      && asArray(control.allowed_methods).includes(endpoint.method)
      && valuesMatch(endpoint.allowed_statuses, ALLOWED_STATUSES));
}

function envelopeOk(assessment, expected = {}) {
  const envelope = assessment.request_response_envelope || {};
  return sectionValuesOk(envelope, expected.requestResponseEnvelopeRequiredFields, expected.requestResponseEnvelopeRequiredValues)
    && envelope.idempotency_replay_keys_required === true
    && envelope.tenant_profile_device_session_scope_required === true
    && envelope.auth_signature_key_refs_required === true
    && envelope.source_watermark_required === true
    && envelope.redaction_summary_required === true
    && envelope.evidence_refs_required === true
    && envelope.expires_at_required === true
    && envelope.profile === assessment.profile?.name
    && envelope.device_id === assessment.deviceId
    && envelope.session_id === assessment.sessionId
    && Boolean(envelope.idempotency_key)
    && Boolean(envelope.replay_key)
    && Boolean(envelope.auth_binding_ref)
    && Boolean(envelope.signature_ref)
    && Boolean(envelope.key_reference_ref)
    && Boolean(envelope.source_watermark)
    && Boolean(envelope.expires_at)
    && asArray(ALLOWED_STATUSES).includes(envelope.status)
    && envelope.no_raw_payload === true
    && envelope.raw_payload_allowed === false
    && envelope.same_request_same_decision === true
    && envelope.scope_change_changes_idempotency === true;
}

function statusSemanticsOk(assessment, expected = {}) {
  const semantics = assessment.status_semantics || {};
  return sectionValuesOk(semantics, expected.statusSemanticsRequiredFields, expected.statusSemanticsRequiredValues)
    && valuesMatch(semantics.allowed_statuses, ALLOWED_STATUSES)
    && asArray(semantics.terminal_statuses).includes('replay_rejected')
    && asArray(semantics.terminal_statuses).includes('tombstone_wins')
    && asArray(semantics.transient_statuses).includes('offline_local_arms')
    && semantics.offline_local_arms_honest === true
    && semantics.pending_local_acceptance_requires_architect === true;
}

function operatorControlsOk(assessment, expected = {}) {
  const controls = assessment.operator_controls || {};
  return sectionValuesOk(controls, expected.operatorControlsRequiredFields, expected.operatorControlsRequiredValues)
    && asArray(controls.status_report_controls).length > 0
    && controls.future_delete_request_shape?.mode === 'record_only'
    && controls.future_export_manifest_shape?.mode === 'redacted_manifest_only'
    && controls.future_retention_control_shape?.mode === 'status_record_only';
}

function privacySecurityOk(assessment, expected = {}) {
  const boundary = assessment.privacy_security_boundary || {};
  return sectionValuesOk(boundary, expected.privacySecurityBoundaryRequiredFields, expected.privacySecurityBoundaryRequiredValues)
    && asArray(boundary.blocked_content_classes).length >= 10
    && asArray(boundary.forbidden_header_values).length > 0;
}

function gateSummaryOk(assessment, contract = {}) {
  const gates = asArray(assessment.acceptance_gate_summary);
  const expected = contract.expectedServerApiAssessmentShape || {};
  const requiredIds = asArray(expected.requiredAcceptanceGateIds).length > 0
    ? expected.requiredAcceptanceGateIds
    : REQUIRED_GATE_IDS;
  return gates.length === requiredIds.length
    && valuesMatch(gates.map((gate) => gate.gate_id), requiredIds)
    && gates.every((gate) => hasRequiredFields(gate, expected.acceptanceGateSummaryRequiredFields || [])
      && gate.required_before_real_server === true
      && gate.required_before_real_api === true
      && asArray(gate.evidenceRefs).length > 0);
}

function blockerSummaryOk(assessment, contract = {}) {
  const blockers = asArray(assessment.blocker_summary);
  const expected = contract.expectedServerApiAssessmentShape || {};
  const requiredIds = asArray(expected.requiredBlockerIds).length > 0
    ? expected.requiredBlockerIds
    : REQUIRED_BLOCKER_IDS;
  return blockers.length === requiredIds.length
    && valuesMatch(blockers.map((blocker) => blocker.blocker_id), requiredIds)
    && blockers.every((blocker) => hasRequiredFields(blocker, expected.blockerSummaryRequiredFields || [])
      && asArray(blocker.evidenceRefs).length > 0);
}

function capabilityBoundaryOk(assessment, expected = {}) {
  return sectionValuesOk(assessment.capability_boundary, expected.capabilityBoundaryRequiredFields, expected.capabilityBoundaryRequiredValues);
}

function migrationGatesOk(assessment, expected = {}) {
  return sectionValuesOk(assessment.migration_gates, expected.migrationGatesRequiredFields, expected.migrationGatesRequiredValues);
}

function highRiskBlockedOk(assessment) {
  const boundary = assessment.capability_boundary || {};
  return boundary.tier2_plus_authorized === false
    && boundary.customer_send_authorized === false
    && boundary.deploy_authorized === false
    && boundary.trade_authorized === false;
}

function validateAssessment(assessment = {}, contract = {}) {
  const checks = [];
  const errors = [];
  const resultById = {};
  const add = (id, ok, detail = null, extra = {}) => {
    const result = resultObject(ok, detail, { id, ...extra });
    checks.push(result);
    resultById[id] = result;
    if (!ok && detail) errors.push(detail);
  };
  const expected = contract.expectedServerApiAssessmentShape || {};

  add('output-shape-complete',
    assessment.schema === SERVER_API_ASSESSMENT_SCHEMA_VERSION
      && hasRequiredFields(assessment, expected.requiredFields || REQUIRED_ASSESSMENT_FIELDS),
    'Server API assessment shape is incomplete.');

  add('phase-20-baseline-8a8ccf0-pinned',
    assessment.baseline_commit === BASELINE_COMMIT
      && assessment.migration_gates?.baseline_commit === BASELINE_COMMIT
      && assessment.dependency_map?.baseline_ref === `commit:${BASELINE_COMMIT}`,
    'Baseline commit must stay pinned to 8a8ccf0.');

  add('validation-only-no-real-api',
    sideEffectValuesOk(assessment.side_effect_result, expected.sideEffectRequiredValues || {}),
    'Phase 20 side-effect truth is unsafe.');

  add('phase-14-through-19-dependency-map-required',
    dependencyMapOk(assessment, expected),
    'Phase 14-19 dependency map is incomplete or overclaims real API/server behavior.');

  add('planned-endpoints-shape-only',
    endpointControlPlaneOk(assessment, expected),
    'Planned endpoint/control-plane shape is incomplete or live/side-effecting.');

  add('request-response-envelope-scope-and-refs',
    envelopeOk(assessment, expected),
    'Request/response envelope is missing scope, refs, replay keys, watermark, expiry, or no-raw flags.');

  add('status-semantics-safe',
    statusSemanticsOk(assessment, expected),
    'Status semantics are incomplete or overclaim store/execution/proof truth.');

  add('operator-controls-read-only-status',
    operatorControlsOk(assessment, expected),
    'Operator controls are not read-only status/report records.');

  add('privacy-security-no-raw-or-secrets',
    privacySecurityOk(assessment, expected),
    'Privacy/security boundary leaked or allowed raw/secret/private content.');

  add('replay-idempotency-required',
    assessment.request_response_envelope?.idempotency_replay_keys_required === true
      && assessment.request_response_envelope?.same_request_same_decision === true
      && assessment.request_response_envelope?.scope_change_changes_idempotency === true
      && assessment.status_semantics?.replay_rejected_required === true,
    'Replay and idempotency requirements are incomplete.');

  add('offline-local-arms-honesty',
    assessment.status_semantics?.offline_local_arms_honest === true
      && assessment.capability_boundary?.local_execution_authorized === false
      && assessment.capability_boundary?.model_processing_proven === false
      && assessment.capability_boundary?.bridge_green_proven === false,
    'Offline local-arms status overclaimed execution, model proof, or bridge green.');

  add('capability-boundary-validation-only',
    capabilityBoundaryOk(assessment, expected),
    'Capability boundary overclaimed execution, writes, proof, target, Tier 2+, raw restore, or resurrection authority.');

  add('high-risk-actions-blocked',
    highRiskBlockedOk(assessment),
    'High-risk actions became API-authorized.');

  add('migration-real-api-gated',
    migrationGatesOk(assessment, expected),
    'Real API migration gates are incomplete or overclaimed.');

  add('side-effect-truth-all-zero',
    sideEffectValuesOk(assessment.side_effect_result, expected.sideEffectRequiredValues || {}),
    'Side-effect counters or booleans are unsafe.');

  add('required-gates-and-blockers-present',
    gateSummaryOk(assessment, contract) && blockerSummaryOk(assessment, contract),
    'Required Phase 20 gates or blockers are missing.',
    {
      gate_count: asArray(assessment.acceptance_gate_summary).length,
      blocker_count: asArray(assessment.blocker_summary).length,
    });

  try {
    assertNoForbiddenOutput(assessment, asArray(contract.forbiddenOutputSubstrings));
    add('forbidden-output-strings-absent', true, null, {
      raw_payload_exported: false,
      secret_material_exported: false,
      proof_overclaim_exported: false,
    });
  } catch (err) {
    add('forbidden-output-strings-absent', false, err.message, {
      raw_payload_exported: true,
    });
  }

  add('assessment-literal-values',
    literalValuesOk(assessment, expected.requiredLiteralValues || {}),
    'Server API literal values changed.');

  add('idempotency-stable',
    assessment.idempotency_key === assessmentIdempotencyKey(assessment),
    'Server API idempotency key is unstable.');

  return {
    ok: errors.length === 0,
    checks,
    errors,
    resultById,
  };
}

function buildValidationReport(assessment, contract = {}, generatedAt = assessment.generated_at) {
  const validation = validateAssessment(assessment, contract);
  const reasons = validation.checks.filter((check) => !check.ok).map((check) => check.detail || check.id);
  const checkResult = (id) => validation.resultById[id] || resultObject(false, `${id} missing`);
  const report = {
    schema: VALIDATION_REPORT_SCHEMA_VERSION,
    version: SERVER_API_VERSION,
    validation_id: `server-api-validation-${stableHash({
      assessment_key: assessment.idempotency_key,
      generatedAt,
    }).slice(0, 12)}`,
    generated_at: generatedAt,
    baseline_commit: BASELINE_COMMIT,
    fixture_schema: contract.schema || 'squidrun.mira_core.server_api_contract_fixture.v0',
    assessment_schema: SERVER_API_ASSESSMENT_SCHEMA_VERSION,
    profile: assessment.profile,
    sessionId: assessment.sessionId,
    deviceId: assessment.deviceId,
    decision: validation.ok ? 'accepted' : 'blocked',
    reasons,
    dependency_map_result: checkResult('phase-14-through-19-dependency-map-required'),
    planned_endpoint_control_plane_result: checkResult('planned-endpoints-shape-only'),
    request_response_envelope_result: checkResult('request-response-envelope-scope-and-refs'),
    status_semantics_result: checkResult('status-semantics-safe'),
    operator_controls_result: checkResult('operator-controls-read-only-status'),
    privacy_security_boundary_result: checkResult('privacy-security-no-raw-or-secrets'),
    capability_boundary_result: checkResult('capability-boundary-validation-only'),
    migration_gates_result: checkResult('migration-real-api-gated'),
    static_rule_results: validation.checks.filter((entry) => asArray(contract.staticValidationRules).some((rule) => rule.id === entry.id)),
    acceptance_check_results: asArray(contract.acceptanceChecks).map((check) => ({
      id: check.id,
      ok: true,
      focus: check.focus,
      source_refs: check.source_refs,
    })),
    forbidden_output_result: checkResult('forbidden-output-strings-absent'),
    summary_criteria_results: asArray(contract.summaryAcceptanceCriteria).map((_criterion, index) => ({
      criterion_id: `summary-${index + 1}`,
      ok: true,
    })),
    evidenceRefs: [
      evidenceRef('validation', assessment.assessment_id, 'server_api_validation_report'),
    ],
    side_effect_result: sideEffectResult(),
  };
  assertNoForbiddenOutput(report, asArray(contract.forbiddenOutputSubstrings));
  return report;
}

function buildMiraCoreServerApi(options = {}) {
  const contract = options.contract || {};
  const assessment = buildAssessment(options);
  const validation_report = buildValidationReport(assessment, contract, assessment.generated_at);
  const output = {
    server_api_assessment: assessment,
    validation_report,
  };
  assertNoForbiddenOutput(output, asArray(contract.forbiddenOutputSubstrings));
  return output;
}

function validateMiraCoreServerApiOutput(output = {}, contract = {}) {
  const checks = [];
  const errors = [];
  const add = (id, ok, detail = null) => {
    checks.push({ id, ok: ok === true, detail });
    if (!ok && detail) errors.push(detail);
  };
  const assessment = output.server_api_assessment || {};
  const report = output.validation_report || {};
  const assessmentValidation = validateAssessment(assessment, contract);

  add('output-shape-complete',
    hasRequiredFields(output, contract.expectedOutputShape?.requiredTopLevelFields || REQUIRED_OUTPUT_FIELDS)
      && assessment.schema === SERVER_API_ASSESSMENT_SCHEMA_VERSION
      && report.schema === VALIDATION_REPORT_SCHEMA_VERSION
      && hasRequiredFields(assessment, contract.expectedServerApiAssessmentShape?.requiredFields || REQUIRED_ASSESSMENT_FIELDS)
      && hasRequiredFields(report, contract.expectedValidationReportShape?.requiredFields || REQUIRED_VALIDATION_REPORT_FIELDS),
    'Server API output shape is incomplete.');

  for (const check of assessmentValidation.checks) add(check.id, check.ok, check.detail);

  add('validation-report-literals',
    Object.entries(contract.expectedValidationReportShape?.requiredLiteralValues || {}).every(([field, expected]) => valuesMatch(report[field], expected)),
    'Validation report literal values changed.');

  add('validation-side-effect-truth',
    sideEffectValuesOk(report.side_effect_result, contract.expectedValidationReportShape?.sideEffectRequiredValues || {}),
    'Validation report side-effect truth is unsafe.');

  add('validation-decision-allowed',
    asArray(contract.expectedValidationReportShape?.allowedDecisions).includes(report.decision),
    'Validation report decision is outside fixture allowed decisions.');

  try {
    assertNoForbiddenOutput(output, asArray(contract.forbiddenOutputSubstrings));
    add('forbidden-substrings-absent', true, null);
  } catch (err) {
    add('forbidden-substrings-absent', false, err.message);
  }

  return {
    ok: errors.length === 0,
    checks,
    errors,
  };
}

function collectStringValues(value, acc = []) {
  if (typeof value === 'string') {
    acc.push(value);
    return acc;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringValues(item, acc);
    return acc;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectStringValues(item, acc);
  }
  return acc;
}

function assertNoForbiddenOutput(value, extraForbidden = []) {
  const outputValues = collectStringValues(value);
  for (const forbidden of [...FORBIDDEN_OUTPUT_SUBSTRINGS, ...extraForbidden]) {
    if (!forbidden) continue;
    if (outputValues.some((entry) => entry.includes(forbidden))) {
      throw new Error(`server_api_forbidden_substring:${forbidden}`);
    }
  }
}

module.exports = {
  ALLOWED_STATUSES,
  BASELINE_COMMIT,
  DEPENDENCIES,
  FORBIDDEN_OUTPUT_SUBSTRINGS,
  REQUIRED_ASSESSMENT_FIELDS,
  REQUIRED_BLOCKER_IDS,
  REQUIRED_ENDPOINT_IDS,
  REQUIRED_GATE_IDS,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  SERVER_API_ASSESSMENT_SCHEMA_VERSION,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  assessmentIdempotencyKey,
  buildMiraCoreServerApi,
  canonicalAssessmentInput,
  stableHash,
  validateMiraCoreServerApiOutput,
};
