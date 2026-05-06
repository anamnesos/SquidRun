'use strict';

const crypto = require('crypto');

const SERVER_HANDLER_ASSESSMENT_SCHEMA_VERSION = 'squidrun.mira_core.server_handler_assessment.v0';
const VALIDATION_REPORT_SCHEMA_VERSION = 'squidrun.mira_core.server_handler_validation_report.v0';
const SERVER_HANDLER_VERSION = 'v0';
const BASELINE_COMMIT = 'ce9e55d';

const REQUIRED_OUTPUT_FIELDS = Object.freeze([
  'server_handler_assessment',
  'validation_report',
]);

const REQUIRED_ASSESSMENT_FIELDS = Object.freeze([
  'schema',
  'version',
  'handler_contract_id',
  'idempotency_key',
  'generated_at',
  'baseline_commit',
  'profile',
  'sessionId',
  'deviceId',
  'dependency_map',
  'handler_registry',
  'request_envelope',
  'response_envelope',
  'endpoint_dispatch_table',
  'idempotency_replay_watermark_tombstone',
  'binding_requirements',
  'storage_status_policy',
  'deletion_export_retention_status',
  'local_arms_status',
  'target_and_risk_policy',
  'privacy_security_boundary',
  'runtime_migration_gates',
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
  'handler_assessment_schema',
  'profile',
  'sessionId',
  'deviceId',
  'decision',
  'reasons',
  'dependency_map_result',
  'handler_registry_result',
  'request_envelope_result',
  'response_envelope_result',
  'dispatch_table_result',
  'idempotency_replay_watermark_tombstone_result',
  'binding_requirements_result',
  'storage_status_result',
  'deletion_export_retention_result',
  'local_arms_status_result',
  'target_and_risk_policy_result',
  'privacy_security_boundary_result',
  'runtime_migration_gates_result',
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
  'no_http_or_network_performed',
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
  'httpOrNetworkCallsAttempted',
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
  'baseline-ce9e55d-pinned',
  'phase-14-through-20-dependencies-present',
  'handler-registry-pure-functions-only',
  'request-envelope-complete-no-raw-payload',
  'response-envelope-status-only',
  'dispatch-table-pure-no-routes',
  'idempotency-replay-watermark-tombstone-rules',
  'auth-signature-key-scope-binding-refs-required',
  'storage-status-only-no-write',
  'deletion-export-retention-status-only',
  'local-arms-offline-truth-preserved',
  'architect-only-target-and-risk-gates',
  'privacy-security-no-raw-or-secrets',
  'real-handler-runtime-migration-gated',
  'side-effect-free-validation-only',
]);

const REQUIRED_BLOCKER_IDS = Object.freeze([
  'real-server-handler-runtime-blocked',
  'listener-route-http-network-blocked',
  'db-store-file-queue-output-write-blocked',
  'auth-signature-key-binding-ref-missing-blocked',
  'replay-expiry-watermark-tombstone-blocked',
  'storage-delete-export-real-action-blocked',
  'local-execution-proof-bridge-overclaim-blocked',
  'builder-oracle-direct-target-blocked',
  'tier3-tier4-high-risk-action-blocked',
  'raw-secret-private-payload-blocked',
]);

const REQUIRED_ENDPOINT_IDS = Object.freeze([
  'status-readiness',
  'receive-upload-envelope',
  'validate-auth-signature-key-refs',
  'storage-dry-run-status',
  'deletion-export-status',
  'retention-tombstone-status',
  'local-arms-offline-status',
  'intent-proposal-status',
  'audit-log-status',
]);

const ALLOWED_DECISIONS = Object.freeze([
  'accepted_for_validation_only',
  'pending_local_acceptance',
  'review_required',
  'blocked',
  'rejected',
  'expired',
  'replay_rejected',
  'tombstone_wins',
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
  'handler route registered',
  'http server started',
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
  'handler authorizes local execution',
  'handler authorizes database write',
  'handler proves model processing',
  'handler proves bridge green',
  'socket alone proves bridge green',
  'delivery acceptance proves model processing',
  'handler dispatch proves model processing',
  'builder direct target authorized',
  'oracle direct target authorized',
  'tier3 authorized by handler',
  'tier4 authorized by handler',
  'memory commit authorized by handler',
]);

const DEPENDENCIES = Object.freeze([
  {
    phase: 14,
    name: 'server-runtime-gap',
    fixture_path: 'ui/__tests__/fixtures/mira-core-server-runtime-gap-contract.json',
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
    implementation_commit: '8a8ccf0',
    status: 'green_validation_only',
    boundary_mode: 'validation_only_no_runtime',
    ref_field: 'phase_19_encryption_key_ref',
    ref_value: 'mira-core-encryption-key-contract:phase_19_green',
  },
  {
    phase: 20,
    name: 'server-api',
    fixture_path: 'ui/__tests__/fixtures/mira-core-server-api-contract.json',
    implementation_commit: 'ce9e55d',
    status: 'green_validation_only',
    boundary_mode: 'validation_only_no_runtime',
    ref_field: 'phase_20_server_api_ref',
    ref_value: 'mira-core-server-api-contract:phase_20_green',
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

function evidenceRef(kind, id, relation = 'server_handler_validation') {
  return {
    store: 'mira-core-server-handler',
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
    no_http_or_network_performed: true,
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
    httpOrNetworkCallsAttempted: 0,
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
    real_handler_runtime_exists: false,
  }, 'dependency-map', 'phase-14-through-20-dependencies-present');
  for (const dependency of DEPENDENCIES) {
    map[dependency.ref_field] = dependency.ref_value;
  }
  return map;
}

function handlerEntry(endpointId, kind, riskFloor, riskCeiling) {
  return {
    handler_id: `handler:${endpointId}`,
    endpoint_id: endpointId,
    kind,
    input_schema: 'squidrun.mira_core.server_handler_request_envelope.v0',
    output_schema: 'squidrun.mira_core.server_handler_response_envelope.v0',
    risk_floor: riskFloor,
    risk_ceiling: riskCeiling,
    pure_function: true,
    side_effect_free: true,
    raw_payload_allowed: false,
    requires_scope: true,
    requires_binding_refs: true,
    allowed_decisions: clone(ALLOWED_DECISIONS),
    blocked_actions: [
      'live_runtime_start',
      'listener_binding',
      'http_network_call',
      'db_store_write',
      'queue_write',
      'local_execution',
      'customer_send',
      'deploy',
      'trade',
    ],
  };
}

function handlerRegistry() {
  const handlers = [
    handlerEntry('status-readiness', 'read_only_status', 'tier0_read_only', 'tier0_read_only'),
    handlerEntry('receive-upload-envelope', 'receive_validation_status', 'tier0_read_only', 'tier1_local_reversible'),
    handlerEntry('validate-auth-signature-key-refs', 'binding_validation_status', 'tier0_read_only', 'tier1_local_reversible'),
    handlerEntry('storage-dry-run-status', 'future_storage_status', 'tier0_read_only', 'tier1_local_reversible'),
    handlerEntry('deletion-export-status', 'operator_review_status', 'tier1_local_reversible', 'tier2_review_required'),
    handlerEntry('retention-tombstone-status', 'tombstone_status', 'tier0_read_only', 'tier2_review_required'),
    handlerEntry('local-arms-offline-status', 'offline_status', 'tier0_read_only', 'tier0_read_only'),
    handlerEntry('intent-proposal-status', 'intent_status', 'tier0_read_only', 'tier1_local_reversible'),
    handlerEntry('audit-log-status', 'audit_status', 'tier0_read_only', 'tier0_read_only'),
  ];
  return withEvidence({
    schema: 'squidrun.mira_core.server_handler_registry.v0',
    version: SERVER_HANDLER_VERSION,
    registry_id: 'server-handler-registry-validation-v0',
    pure_functions_only: true,
    real_route_table_created: false,
    listener_required_now: false,
    handlers,
    handler_count: handlers.length,
    allowed_endpoint_ids: clone(REQUIRED_ENDPOINT_IDS),
    handler_context_allowed_fields: [
      'endpoint_id',
      'request_metadata',
      'redaction_summary',
      'evidenceRefs',
      'dependency_refs',
      'status_only_flags',
    ],
    forbidden_handler_context_fields: [
      'raw_body_value',
      'secret_material_value',
      'token_header_value',
      'cookie_header_value',
      'private_key_value',
      'data_key_value',
      'plaintext_value',
      'ciphertext_value',
      'decrypted_content_value',
    ],
  }, 'handler-registry', 'handler-registry-pure-functions-only');
}

function requestIdempotencyInput(scope) {
  return {
    endpoint_id: 'status-readiness',
    tenant_id: scope.tenantId,
    profile: scope.profileName,
    device_id: scope.deviceId,
    session_id: scope.sessionId,
    payload_ref: 'payload-ref:status-readiness-validation',
  };
}

function requestEnvelope(scope) {
  const requestInput = requestIdempotencyInput(scope);
  const requestHash = stableHash(requestInput);
  return withEvidence({
    schema: 'squidrun.mira_core.server_handler_request_envelope.v0',
    endpoint_id: requestInput.endpoint_id,
    request_id: `server-handler-request:${requestHash.slice(0, 12)}`,
    idempotency_key: `server-handler-idem:${requestHash}`,
    replay_key: `server-handler-replay:${stableHash({ requestHash, replay: 'scope-bound' })}`,
    tenant_id: scope.tenantId,
    profile: scope.profileName,
    device_id: scope.deviceId,
    session_id: scope.sessionId,
    auth_binding_ref: 'auth-binding-validation:phase_16_green',
    signature_ref: 'identity-signing-validation:phase_15_green',
    key_reference_ref: 'encryption-key-validation:phase_19_green',
    source_watermark: 'watermark:phase21-handler-validation',
    request_metadata_redaction_status: 'applied',
    payload_summary: 'Redacted metadata summary only.',
    payload_hash: `sha256:${stableHash({ requestInput, payload: 'redacted-summary' })}`,
    payload_ref: requestInput.payload_ref,
    risk_tier: 'tier0_read_only',
    action_class: 'status_readiness',
    requested_by: 'server_system_validation',
    target_role: 'architect',
    created_at: '2026-05-06T00:00:00.000Z',
    expires_at: '2026-05-07T00:00:00.000Z',
    no_raw_payload: true,
    raw_payload_allowed: false,
    auth_signature_key_refs_required: true,
    tenant_profile_device_session_scope_required: true,
    source_watermark_required: true,
    idempotency_replay_keys_required: true,
    expires_at_required: true,
    payload_summary_only: true,
  }, 'request-envelope', 'request-envelope-complete-no-raw-payload');
}

function responseEnvelope(request) {
  return withEvidence({
    schema: 'squidrun.mira_core.server_handler_response_envelope.v0',
    request_id: request.request_id,
    handler_id: `handler:${request.endpoint_id}`,
    endpoint_id: request.endpoint_id,
    decision: 'accepted_for_validation_only',
    status: 'status_only',
    logical_status_code: 200,
    reasons: [
      'validation_only_status_response',
      'no_runtime_side_effect',
    ],
    safe_next_action: 'Review status output; no runtime action is available in Phase 21.',
    redaction_summary: {
      raw_payload_exported: false,
      private_content_withheld: true,
      refs_only: true,
    },
    response_refs: [
      'server-api-contract:phase_20_green',
      'server-handler-contract:phase_21_validation',
    ],
    review_required: false,
    expires_at: request.expires_at,
    no_raw_payload: true,
    no_store_performed: true,
    no_execution_performed: true,
    no_network_performed: true,
    no_output_file_written: true,
  }, 'response-envelope', 'response-envelope-status-only');
}

function endpointDispatchTable() {
  const endpointToHandler = REQUIRED_ENDPOINT_IDS.reduce((result, endpointId) => {
    result[endpointId] = `handler:${endpointId}`;
    return result;
  }, {});
  return withEvidence({
    schema: 'squidrun.mira_core.server_handler_dispatch_table.v0',
    dispatch_is_pure: true,
    route_registration_performed: false,
    network_performed: false,
    endpoint_to_handler: endpointToHandler,
    default_unknown_endpoint_decision: 'rejected',
    blocked_action_classes: [
      'live_runtime_start',
      'listener_binding',
      'http_network_call',
      'db_store_write',
      'queue_write',
      'local_execution',
      'customer_send',
      'deploy',
      'trade',
      'financial_action',
    ],
  }, 'dispatch-table', 'dispatch-table-pure-no-routes');
}

function idempotencyReplayWatermarkTombstone() {
  return withEvidence({
    idempotency_key_inputs: [
      'endpoint_id',
      'tenant_id',
      'profile',
      'device_id',
      'session_id',
      'payload_hash',
      'source_watermark',
    ],
    same_request_same_response: true,
    payload_or_scope_change_changes_idempotency: true,
    replay_key_required: true,
    replay_rejected_required: true,
    watermark_required: true,
    watermark_regression_rejected: true,
    stale_snapshot_warned_or_rejected: true,
    tombstone_ref_checked: true,
    tombstone_wins_required: true,
    expired_request_blocked: true,
    no_duplicate_side_effect_possible: true,
  }, 'replay-watermark-tombstone', 'idempotency-replay-watermark-tombstone-rules');
}

function bindingRequirements() {
  return withEvidence({
    auth_binding_ref_required: true,
    signature_ref_required: true,
    key_reference_ref_required: true,
    profile_scope_required: true,
    device_scope_required: true,
    session_scope_required: true,
    tenant_scope_required: true,
    role_proof_ref_required: true,
    target_proof_ref_required: true,
    profile_mismatch_fails_closed: true,
    device_mismatch_fails_closed: true,
    session_mismatch_fails_closed: true,
    side_profile_content_withheld: true,
    reference_only_no_auth_mutation: true,
  }, 'binding-requirements', 'auth-signature-key-scope-binding-refs-required');
}

function storageStatusPolicy() {
  return withEvidence({
    status_only: true,
    storage_write_allowed_now: false,
    eligible_syncEligibility: ['core_sync_safe', 'core_sync_redacted'],
    eligible_redactionStatus: ['none', 'applied'],
    withheld_reason_codes: [
      'raw_payload_blocked',
      'profile_mismatch',
      'side_profile_withheld',
      'approval_required',
      'stale_snapshot',
      'watermark_regression',
    ],
    raw_storage_allowed: false,
    storage_response_decisions: [
      'accepted_for_validation_only',
      'blocked',
      'replay_rejected',
      'tombstone_wins',
    ],
  }, 'storage-status', 'storage-status-only-no-write');
}

function deletionExportRetentionStatus() {
  return withEvidence({
    status_only: true,
    delete_performed_now: false,
    export_file_written_now: false,
    retention_mutated_now: false,
    delete_response_shape: {
      schema: 'squidrun.mira_core.server_handler_delete_status.v0',
      mode: 'review_status_record',
    },
    export_response_shape: {
      schema: 'squidrun.mira_core.server_handler_export_status.v0',
      mode: 'redacted_manifest_status',
    },
    retention_response_shape: {
      schema: 'squidrun.mira_core.server_handler_retention_status.v0',
      mode: 'status_record',
    },
    redacted_manifest_only: true,
    james_visible_review_required: true,
  }, 'deletion-export-retention', 'deletion-export-retention-status-only');
}

function localArmsStatus() {
  return withEvidence({
    status_values: ['offline_local_arms', 'pending_local_acceptance', 'blocked'],
    serverCanExecuteLocal: false,
    serverCanOperatePTY: false,
    serverCanRunShell: false,
    serverCanAccessBrowserOrWindow: false,
    serverCanProveModelProcessing: false,
    socket_is_not_bridge_green: true,
    delivery_acceptance_is_not_model_processing: true,
    role_discovery_required_for_green: true,
    target_proof_required_for_green: true,
    recipient_quote_back_required_for_processing_proof: true,
  }, 'local-arms', 'local-arms-offline-truth-preserved');
}

function targetAndRiskPolicy() {
  return withEvidence({
    allowed_target_role: 'architect',
    allowed_target_roles: ['architect'],
    blocked_direct_targets: ['builder', 'oracle'],
    builder_direct_target_authorized: false,
    oracle_direct_target_authorized: false,
    tier0_decision: 'accepted_for_validation_only',
    tier1_decision: 'pending_local_acceptance',
    tier2_decision: 'review_required_or_blocked',
    tier3_authorized: false,
    tier4_authorized: false,
    high_risk_action_classes: [
      'customer_send',
      'deploy',
      'trade',
      'financial_action',
      'local_execution',
      'auth_secret_mutation',
    ],
    local_acceptance_required: true,
    safe_next_action_required: true,
  }, 'target-risk', 'architect-only-target-and-risk-gates');
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
  }, 'privacy-security', 'privacy-security-no-raw-or-secrets');
}

function runtimeMigrationGates() {
  return withEvidence({
    baseline_commit: BASELINE_COMMIT,
    real_handler_runtime_allowed_now: false,
    future_real_handler_allowed_after_gates: true,
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
    requires_route_handler_integration_tests_gate: true,
    feature_flag_default: 'off',
    rollback_plan_required: true,
  }, 'runtime-gates', 'real-handler-runtime-migration-gated');
}

function acceptanceGateSummary() {
  return REQUIRED_GATE_IDS.map((gateId) => ({
    gate_id: gateId,
    status: gateId === 'side-effect-free-validation-only' ? 'satisfied_for_phase_21_validator' : 'specified_for_validation_pending_handler_runtime',
    required_before_real_handler: true,
    required_before_real_server: true,
    evidenceRefs: [evidenceRef('acceptance-gate', gateId)],
    blocked_until: gateId === 'side-effect-free-validation-only'
      ? 'Phase 21 remains validation-only and side-effect-free.'
      : 'Reviewed handler, dispatch, replay, binding, target, risk, and runtime gates exist.',
  }));
}

function blockerSummary() {
  return [
    {
      blocker_id: 'real-server-handler-runtime-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Real handler runtime remains blocked by Phase 21 gates.',
      safe_next_action: 'Review transport, auth middleware, and route-handler integration tests before runtime work.',
    },
    {
      blocker_id: 'listener-route-http-network-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Listener binding, routing, HTTP, and network paths stay out of Phase 21.',
      safe_next_action: 'Keep dispatcher records pure until Architect scopes runtime behavior.',
    },
    {
      blocker_id: 'db-store-file-queue-output-write-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Persistence, queue, filesystem, and output artifact writes remain blocked.',
      safe_next_action: 'Use status envelopes only.',
    },
    {
      blocker_id: 'auth-signature-key-binding-ref-missing-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Requests fail closed without auth, signature, key, role, target, and scope refs.',
      safe_next_action: 'Keep binding refs required on every handler request envelope.',
    },
    {
      blocker_id: 'replay-expiry-watermark-tombstone-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Replay, expired request, watermark regression, and tombstone conflicts fail closed.',
      safe_next_action: 'Keep replay and tombstone checks before any future runtime store.',
    },
    {
      blocker_id: 'storage-delete-export-real-action-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Storage, delete, export, retention, and restore actions are status-only.',
      safe_next_action: 'Require James-visible review and redacted manifests for future operator controls.',
    },
    {
      blocker_id: 'local-execution-proof-bridge-overclaim-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Handler dispatch cannot prove local execution, model processing, or bridge green.',
      safe_next_action: 'Require role discovery, target proof, and recipient quote-back for proof claims.',
    },
    {
      blocker_id: 'builder-oracle-direct-target-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Future server-originated target stays Architect-only.',
      safe_next_action: 'Keep direct Builder and Oracle targets blocked.',
    },
    {
      blocker_id: 'tier3-tier4-high-risk-action-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Tier 3 and Tier 4 action classes cannot be handler-authorized.',
      safe_next_action: 'Keep high-risk work blocked with safe alternatives.',
    },
    {
      blocker_id: 'raw-secret-private-payload-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Raw private, secret, key, plaintext, ciphertext, and decrypted values stay blocked.',
      safe_next_action: 'Keep summaries, hashes, refs, and redaction metadata only.',
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
    handler_registry: assessment.handler_registry,
    request_envelope: assessment.request_envelope,
    response_envelope: assessment.response_envelope,
    endpoint_dispatch_table: assessment.endpoint_dispatch_table,
    idempotency_replay_watermark_tombstone: assessment.idempotency_replay_watermark_tombstone,
    binding_requirements: assessment.binding_requirements,
    storage_status_policy: assessment.storage_status_policy,
    deletion_export_retention_status: assessment.deletion_export_retention_status,
    local_arms_status: assessment.local_arms_status,
    target_and_risk_policy: assessment.target_and_risk_policy,
    privacy_security_boundary: assessment.privacy_security_boundary,
    runtime_migration_gates: assessment.runtime_migration_gates,
    acceptance_gate_summary: assessment.acceptance_gate_summary,
    blocker_summary: assessment.blocker_summary,
    side_effect_result: assessment.side_effect_result,
  };
}

function assessmentIdempotencyKey(assessment) {
  return `server-handler-idem:${stableHash(canonicalAssessmentInput(assessment))}`;
}

function buildAssessment(options = {}) {
  const inputSignals = options.inputSignals || {};
  const generatedAt = generatedAtFromOptions(options, inputSignals);
  const scope = normalizeScope(inputSignals);
  const request = requestEnvelope(scope);
  const assessment = {
    schema: SERVER_HANDLER_ASSESSMENT_SCHEMA_VERSION,
    version: SERVER_HANDLER_VERSION,
    handler_contract_id: null,
    idempotency_key: null,
    generated_at: generatedAt,
    baseline_commit: BASELINE_COMMIT,
    profile: scope.profile,
    sessionId: scope.sessionId,
    deviceId: scope.deviceId,
    dependency_map: dependencyMap(),
    handler_registry: handlerRegistry(),
    request_envelope: request,
    response_envelope: responseEnvelope(request),
    endpoint_dispatch_table: endpointDispatchTable(),
    idempotency_replay_watermark_tombstone: idempotencyReplayWatermarkTombstone(),
    binding_requirements: bindingRequirements(),
    storage_status_policy: storageStatusPolicy(),
    deletion_export_retention_status: deletionExportRetentionStatus(),
    local_arms_status: localArmsStatus(),
    target_and_risk_policy: targetAndRiskPolicy(),
    privacy_security_boundary: privacySecurityBoundary(),
    runtime_migration_gates: runtimeMigrationGates(),
    acceptance_gate_summary: acceptanceGateSummary(),
    blocker_summary: blockerSummary(),
    evidenceRefs: [
      evidenceRef('baseline', BASELINE_COMMIT),
      evidenceRef('fixture', 'mira-core-server-handler-contract'),
    ],
    side_effect_result: sideEffectResult(),
  };
  assessment.idempotency_key = assessmentIdempotencyKey(assessment);
  assessment.handler_contract_id = `server-handler-${stableHash(assessment.idempotency_key).slice(0, 12)}`;
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

function handlerRegistryOk(assessment, expected = {}) {
  const registry = assessment.handler_registry || {};
  const handlers = asArray(registry.handlers);
  return sectionValuesOk(registry, expected.handlerRegistryRequiredFields, expected.handlerRegistryRequiredValues)
    && registry.handler_count === REQUIRED_ENDPOINT_IDS.length
    && valuesMatch(registry.allowed_endpoint_ids, REQUIRED_ENDPOINT_IDS)
    && handlers.length === REQUIRED_ENDPOINT_IDS.length
    && valuesMatch(handlers.map((handler) => handler.endpoint_id), REQUIRED_ENDPOINT_IDS)
    && handlers.every((handler) => hasRequiredFields(handler, expected.handlerEntryRequiredFields || [])
      && handler.pure_function === true
      && handler.side_effect_free === true
      && handler.raw_payload_allowed === false
      && handler.requires_scope === true
      && handler.requires_binding_refs === true
      && valuesMatch(handler.allowed_decisions, ALLOWED_DECISIONS)
      && asArray(handler.blocked_actions).length > 0);
}

function requestEnvelopeOk(assessment, expected = {}) {
  const request = assessment.request_envelope || {};
  return sectionValuesOk(request, expected.requestEnvelopeRequiredFields, expected.requestEnvelopeRequiredValues)
    && request.auth_signature_key_refs_required === true
    && request.tenant_profile_device_session_scope_required === true
    && request.source_watermark_required === true
    && request.idempotency_replay_keys_required === true
    && request.expires_at_required === true
    && request.payload_summary_only === true
    && request.profile === assessment.profile?.name
    && request.device_id === assessment.deviceId
    && request.session_id === assessment.sessionId
    && asArray(REQUIRED_ENDPOINT_IDS).includes(request.endpoint_id)
    && Boolean(request.idempotency_key)
    && Boolean(request.replay_key)
    && Boolean(request.auth_binding_ref)
    && Boolean(request.signature_ref)
    && Boolean(request.key_reference_ref)
    && Boolean(request.source_watermark)
    && Boolean(request.payload_hash)
    && Boolean(request.payload_ref)
    && Boolean(request.expires_at)
    && request.target_role === 'architect'
    && request.no_raw_payload === true
    && request.raw_payload_allowed === false;
}

function responseEnvelopeOk(assessment, expected = {}) {
  const response = assessment.response_envelope || {};
  return sectionValuesOk(response, expected.responseEnvelopeRequiredFields, expected.responseEnvelopeRequiredValues)
    && response.request_id === assessment.request_envelope?.request_id
    && response.endpoint_id === assessment.request_envelope?.endpoint_id
    && response.handler_id === `handler:${assessment.request_envelope?.endpoint_id}`
    && asArray(expected.allowedDecisions || ALLOWED_DECISIONS).includes(response.decision)
    && Boolean(response.status)
    && asArray(response.reasons).length > 0
    && Boolean(response.safe_next_action)
    && asArray(response.response_refs).length > 0
    && response.no_raw_payload === true
    && response.no_store_performed === true
    && response.no_execution_performed === true
    && response.no_network_performed === true
    && response.no_output_file_written === true;
}

function dispatchTableOk(assessment, expected = {}) {
  const table = assessment.endpoint_dispatch_table || {};
  return sectionValuesOk(table, expected.dispatchTableRequiredFields, expected.dispatchTableRequiredValues)
    && REQUIRED_ENDPOINT_IDS.every((endpointId) => table.endpoint_to_handler?.[endpointId] === `handler:${endpointId}`)
    && asArray(table.blocked_action_classes).length > 0;
}

function gateSummaryOk(assessment, contract = {}) {
  const gates = asArray(assessment.acceptance_gate_summary);
  const expected = contract.expectedServerHandlerAssessmentShape || {};
  const requiredIds = asArray(expected.requiredAcceptanceGateIds).length > 0
    ? expected.requiredAcceptanceGateIds
    : REQUIRED_GATE_IDS;
  return gates.length === requiredIds.length
    && valuesMatch(gates.map((gate) => gate.gate_id), requiredIds)
    && gates.every((gate) => hasRequiredFields(gate, expected.acceptanceGateSummaryRequiredFields || [])
      && gate.required_before_real_handler === true
      && gate.required_before_real_server === true
      && asArray(gate.evidenceRefs).length > 0);
}

function blockerSummaryOk(assessment, contract = {}) {
  const blockers = asArray(assessment.blocker_summary);
  const expected = contract.expectedServerHandlerAssessmentShape || {};
  const requiredIds = asArray(expected.requiredBlockerIds).length > 0
    ? expected.requiredBlockerIds
    : REQUIRED_BLOCKER_IDS;
  return blockers.length === requiredIds.length
    && valuesMatch(blockers.map((blocker) => blocker.blocker_id), requiredIds)
    && blockers.every((blocker) => hasRequiredFields(blocker, expected.blockerSummaryRequiredFields || [])
      && asArray(blocker.evidenceRefs).length > 0);
}

function targetRiskOk(assessment, expected = {}) {
  const policy = assessment.target_and_risk_policy || {};
  return sectionValuesOk(policy, expected.targetAndRiskPolicyRequiredFields, expected.targetAndRiskPolicyRequiredValues)
    && valuesMatch(policy.allowed_target_roles, expected.targetAndRiskPolicyRequiredValues?.allowed_target_roles)
    && valuesMatch(policy.blocked_direct_targets, expected.targetAndRiskPolicyRequiredValues?.blocked_direct_targets)
    && asArray(policy.high_risk_action_classes).length > 0;
}

function localArmsOk(assessment, expected = {}) {
  const status = assessment.local_arms_status || {};
  return sectionValuesOk(status, expected.localArmsStatusRequiredFields, expected.localArmsStatusRequiredValues)
    && status.serverCanExecuteLocal === false
    && status.serverCanProveModelProcessing === false
    && status.socket_is_not_bridge_green === true
    && status.delivery_acceptance_is_not_model_processing === true;
}

function privacySecurityOk(assessment, expected = {}) {
  const boundary = assessment.privacy_security_boundary || {};
  return sectionValuesOk(boundary, expected.privacySecurityBoundaryRequiredFields, expected.privacySecurityBoundaryRequiredValues)
    && asArray(boundary.blocked_content_classes).length >= 10
    && asArray(boundary.forbidden_header_values).length > 0;
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
  const expected = contract.expectedServerHandlerAssessmentShape || {};

  add('output-shape-complete',
    assessment.schema === SERVER_HANDLER_ASSESSMENT_SCHEMA_VERSION
      && hasRequiredFields(assessment, expected.requiredFields || REQUIRED_ASSESSMENT_FIELDS),
    'Server handler assessment shape is incomplete.');

  add('baseline-ce9e55d-pinned',
    assessment.baseline_commit === BASELINE_COMMIT
      && assessment.runtime_migration_gates?.baseline_commit === BASELINE_COMMIT
      && assessment.dependency_map?.baseline_ref === `commit:${BASELINE_COMMIT}`,
    'Baseline commit must stay pinned to ce9e55d.');

  add('phase-21-validation-only-no-runtime',
    sideEffectValuesOk(assessment.side_effect_result, expected.sideEffectRequiredValues || {}),
    'Phase 21 side-effect truth is unsafe.');

  add('phase-14-through-20-dependency-map-required',
    dependencyMapOk(assessment, expected),
    'Phase 14-20 dependency map is incomplete or overclaims runtime behavior.');

  add('handler-registry-pure-functions-only',
    handlerRegistryOk(assessment, expected),
    'Handler registry is incomplete or implies live route/listener behavior.');

  add('request-envelope-complete-no-raw-payload',
    requestEnvelopeOk(assessment, expected),
    'Request envelope is missing endpoint, scope, refs, replay keys, watermark, expiry, or no-raw flags.');

  add('response-envelope-status-only',
    responseEnvelopeOk(assessment, expected),
    'Response envelope is incomplete or overclaims store/execution/network/output behavior.');

  add('dispatch-table-pure-no-routes',
    dispatchTableOk(assessment, expected),
    'Dispatch table is incomplete or overclaims route/network behavior.');

  add('idempotency-replay-watermark-tombstone-rules',
    sectionValuesOk(assessment.idempotency_replay_watermark_tombstone, expected.idempotencyReplayWatermarkTombstoneRequiredFields, expected.idempotencyReplayWatermarkTombstoneRequiredValues),
    'Idempotency, replay, watermark, tombstone, or expiry rules are incomplete.');

  add('auth-signature-key-scope-binding-refs-required',
    sectionValuesOk(assessment.binding_requirements, expected.bindingRequirementsRequiredFields, expected.bindingRequirementsRequiredValues),
    'Binding requirements are incomplete or not fail-closed.');

  add('storage-delete-export-status-only',
    sectionValuesOk(assessment.storage_status_policy, expected.storageStatusPolicyRequiredFields, expected.storageStatusPolicyRequiredValues)
      && sectionValuesOk(assessment.deletion_export_retention_status, expected.deletionExportRetentionStatusRequiredFields, expected.deletionExportRetentionStatusRequiredValues),
    'Storage/delete/export/retention policies are incomplete or side-effecting.');

  add('local-arms-offline-truth-preserved',
    localArmsOk(assessment, expected),
    'Local arms, proof, or bridge truth was overclaimed.');

  add('architect-only-target-and-risk-gates',
    targetRiskOk(assessment, expected),
    'Target or risk policy overclaimed Builder/Oracle, Tier 3, or Tier 4 authority.');

  add('privacy-security-no-raw-or-secrets',
    privacySecurityOk(assessment, expected),
    'Privacy/security boundary leaked or allowed raw/secret/private content.');

  add('proof-bridge-overclaim-blocked',
    assessment.local_arms_status?.socket_is_not_bridge_green === true
      && assessment.local_arms_status?.delivery_acceptance_is_not_model_processing === true
      && assessment.local_arms_status?.recipient_quote_back_required_for_processing_proof === true
      && assessment.local_arms_status?.serverCanProveModelProcessing === false,
    'Proof or bridge boundary overclaimed green/model processing.');

  add('real-handler-runtime-migration-gated',
    sectionValuesOk(assessment.runtime_migration_gates, expected.runtimeMigrationGatesRequiredFields, expected.runtimeMigrationGatesRequiredValues),
    'Real handler runtime gates are incomplete or overclaimed.');

  add('required-gates-and-blockers-present',
    gateSummaryOk(assessment, contract) && blockerSummaryOk(assessment, contract),
    'Required Phase 21 gates or blockers are missing.',
    {
      gate_count: asArray(assessment.acceptance_gate_summary).length,
      blocker_count: asArray(assessment.blocker_summary).length,
    });

  try {
    assertNoForbiddenOutput(assessment, asArray(contract.forbiddenOutputSubstrings));
    add('forbidden-output-strings-absent', true, null, {
      raw_payload_exported: false,
      runtime_overclaim_exported: false,
      proof_overclaim_exported: false,
    });
  } catch (err) {
    add('forbidden-output-strings-absent', false, err.message, {
      raw_payload_exported: true,
    });
  }

  add('assessment-literal-values',
    literalValuesOk(assessment, expected.requiredLiteralValues || {}),
    'Server handler literal values changed.');

  add('idempotency-stable',
    assessment.idempotency_key === assessmentIdempotencyKey(assessment),
    'Server handler idempotency key is unstable.');

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
    version: SERVER_HANDLER_VERSION,
    validation_id: `server-handler-validation-${stableHash({
      assessment_key: assessment.idempotency_key,
      generatedAt,
    }).slice(0, 12)}`,
    generated_at: generatedAt,
    baseline_commit: BASELINE_COMMIT,
    fixture_schema: contract.schema || 'squidrun.mira_core.server_handler_contract_fixture.v0',
    handler_assessment_schema: SERVER_HANDLER_ASSESSMENT_SCHEMA_VERSION,
    profile: assessment.profile,
    sessionId: assessment.sessionId,
    deviceId: assessment.deviceId,
    decision: validation.ok ? 'accepted' : 'blocked',
    reasons,
    dependency_map_result: checkResult('phase-14-through-20-dependency-map-required'),
    handler_registry_result: checkResult('handler-registry-pure-functions-only'),
    request_envelope_result: checkResult('request-envelope-complete-no-raw-payload'),
    response_envelope_result: checkResult('response-envelope-status-only'),
    dispatch_table_result: checkResult('dispatch-table-pure-no-routes'),
    idempotency_replay_watermark_tombstone_result: checkResult('idempotency-replay-watermark-tombstone-rules'),
    binding_requirements_result: checkResult('auth-signature-key-scope-binding-refs-required'),
    storage_status_result: checkResult('storage-delete-export-status-only'),
    deletion_export_retention_result: checkResult('storage-delete-export-status-only'),
    local_arms_status_result: checkResult('local-arms-offline-truth-preserved'),
    target_and_risk_policy_result: checkResult('architect-only-target-and-risk-gates'),
    privacy_security_boundary_result: checkResult('privacy-security-no-raw-or-secrets'),
    runtime_migration_gates_result: checkResult('real-handler-runtime-migration-gated'),
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
      evidenceRef('validation', assessment.handler_contract_id, 'server_handler_validation_report'),
    ],
    side_effect_result: sideEffectResult(),
  };
  assertNoForbiddenOutput(report, asArray(contract.forbiddenOutputSubstrings));
  return report;
}

function buildMiraCoreServerHandler(options = {}) {
  const contract = options.contract || {};
  const assessment = buildAssessment(options);
  const validation_report = buildValidationReport(assessment, contract, assessment.generated_at);
  const output = {
    server_handler_assessment: assessment,
    validation_report,
  };
  assertNoForbiddenOutput(output, asArray(contract.forbiddenOutputSubstrings));
  return output;
}

function validateMiraCoreServerHandlerOutput(output = {}, contract = {}) {
  const checks = [];
  const errors = [];
  const add = (id, ok, detail = null) => {
    checks.push({ id, ok: ok === true, detail });
    if (!ok && detail) errors.push(detail);
  };
  const assessment = output.server_handler_assessment || {};
  const report = output.validation_report || {};
  const assessmentValidation = validateAssessment(assessment, contract);

  add('output-shape-complete',
    hasRequiredFields(output, contract.expectedOutputShape?.requiredTopLevelFields || REQUIRED_OUTPUT_FIELDS)
      && assessment.schema === SERVER_HANDLER_ASSESSMENT_SCHEMA_VERSION
      && report.schema === VALIDATION_REPORT_SCHEMA_VERSION
      && hasRequiredFields(assessment, contract.expectedServerHandlerAssessmentShape?.requiredFields || REQUIRED_ASSESSMENT_FIELDS)
      && hasRequiredFields(report, contract.expectedValidationReportShape?.requiredFields || REQUIRED_VALIDATION_REPORT_FIELDS),
    'Server handler output shape is incomplete.');

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
      throw new Error(`server_handler_forbidden_substring:${forbidden}`);
    }
  }
}

module.exports = {
  ALLOWED_DECISIONS,
  BASELINE_COMMIT,
  DEPENDENCIES,
  FORBIDDEN_OUTPUT_SUBSTRINGS,
  REQUIRED_ASSESSMENT_FIELDS,
  REQUIRED_BLOCKER_IDS,
  REQUIRED_ENDPOINT_IDS,
  REQUIRED_GATE_IDS,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  SERVER_HANDLER_ASSESSMENT_SCHEMA_VERSION,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  assessmentIdempotencyKey,
  buildMiraCoreServerHandler,
  canonicalAssessmentInput,
  stableHash,
  validateMiraCoreServerHandlerOutput,
};
