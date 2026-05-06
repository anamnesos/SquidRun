'use strict';

const crypto = require('crypto');

const RUNTIME_HARNESS_ASSESSMENT_SCHEMA_VERSION = 'squidrun.mira_core.runtime_harness_assessment.v0';
const VALIDATION_REPORT_SCHEMA_VERSION = 'squidrun.mira_core.runtime_harness_validation_report.v0';
const RUNTIME_HARNESS_VERSION = 'v0';
const BASELINE_COMMIT = 'ffe130c';

const REQUIRED_OUTPUT_FIELDS = Object.freeze([
  'runtime_harness_assessment',
  'validation_report',
]);

const REQUIRED_ASSESSMENT_FIELDS = Object.freeze([
  'schema',
  'version',
  'harness_contract_id',
  'idempotency_key',
  'generated_at',
  'baseline_commit',
  'profile',
  'sessionId',
  'deviceId',
  'dependency_map',
  'harness_entrypoint',
  'initial_ephemeral_state',
  'request_batch',
  'per_request_results',
  'state_delta_preview',
  'audit_preview',
  'ordering_rules',
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
  'runtime_harness_assessment_schema',
  'profile',
  'sessionId',
  'deviceId',
  'decision',
  'reasons',
  'dependency_map_result',
  'harness_entrypoint_result',
  'initial_state_result',
  'request_batch_result',
  'per_request_results_result',
  'state_delta_preview_result',
  'audit_preview_result',
  'ordering_rules_result',
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
  'no_runtime_daemon_started',
  'no_runtime_implementation_performed',
  'no_server_process_started',
  'no_listener_started',
  'no_routes_registered',
  'no_http_or_network_performed',
  'no_database_or_store_write_performed',
  'no_file_write_performed',
  'no_migration_executed',
  'no_queue_created',
  'no_lease_created',
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
  'no_audit_log_written',
  'no_state_persisted',
  'no_idempotency_cache_persisted',
  'no_output_file_written',
  'no_durable_migration_performed',
]);

const SIDE_EFFECT_COUNTER_FIELDS = Object.freeze([
  'runtimeDaemonsStarted',
  'serverProcessesStarted',
  'listenersStarted',
  'routesRegistered',
  'httpOrNetworkCallsAttempted',
  'databaseOrStoreWritesAttempted',
  'fileWritesAttempted',
  'migrationsAttempted',
  'queuesCreated',
  'leasesCreated',
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
  'auditLogWritesAttempted',
  'statePersistWritesAttempted',
  'idempotencyCachePersistWritesAttempted',
  'durableMigrationsAttempted',
]);

const REQUIRED_GATE_IDS = Object.freeze([
  'baseline-ffe130c-pinned',
  'phase-14-through-21-dependencies-present',
  'harness-entrypoint-in-process-only',
  'initial-state-ephemeral-only',
  'ordered-batch-deterministic',
  'per-request-results-status-only',
  'state-delta-preview-only',
  'audit-preview-redacted-append-only',
  'idempotency-replay-watermark-tombstone-expiry-ordering',
  'local-arms-offline-truth-preserved',
  'architect-only-target-and-risk-gates',
  'privacy-security-no-raw-or-secrets',
  'proof-bridge-overclaim-blocked',
  'real-runtime-migration-gated',
  'side-effect-free-validation-only',
]);

const REQUIRED_BLOCKER_IDS = Object.freeze([
  'real-runtime-daemon-blocked',
  'listener-route-http-network-blocked',
  'db-store-file-queue-lease-output-write-blocked',
  'auth-signature-key-secret-mutation-blocked',
  'replay-expiry-watermark-tombstone-blocked',
  'state-delta-persistence-blocked',
  'audit-log-write-raw-leak-blocked',
  'local-execution-proof-bridge-overclaim-blocked',
  'builder-oracle-direct-target-blocked',
  'tier3-tier4-high-risk-action-blocked',
  'raw-secret-private-payload-blocked',
]);

const ALLOWED_PER_REQUEST_DECISIONS = Object.freeze([
  'accepted_for_validation_only',
  'pending_local_acceptance',
  'review_required',
  'blocked',
  'rejected',
  'expired',
  'replay_rejected',
  'stale_watermark_rejected',
  'tombstone_wins',
]);

const FAIL_CLOSED_DECISIONS = Object.freeze(['blocked', 'rejected']);

const REQUIRED_REQUEST_CASES = Object.freeze([
  { sequence: 1, endpoint_id: 'status-readiness', kind: 'read_only_status' },
  { sequence: 2, endpoint_id: 'receive-upload-envelope', kind: 'upload_receive_preview' },
  { sequence: 3, endpoint_id: 'intent-proposal-status', kind: 'pending_local_acceptance_preview' },
  { sequence: 4, endpoint_id: 'status-readiness', kind: 'duplicate_replay', duplicateOfSequence: 1 },
  { sequence: 5, endpoint_id: 'receive-upload-envelope', kind: 'stale_watermark' },
  { sequence: 6, endpoint_id: 'receive-upload-envelope', kind: 'tombstone_conflict' },
  { sequence: 7, endpoint_id: 'status-readiness', kind: 'expired_request' },
  { sequence: 8, endpoint_id: 'intent-proposal-status', kind: 'non_architect_target' },
  { sequence: 9, endpoint_id: 'intent-proposal-status', kind: 'high_risk_tier' },
  { sequence: 10, endpoint_id: 'receive-upload-envelope', kind: 'raw_payload' },
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
  'raw audit payload',
  'raw database payload',
  'runtime daemon started',
  'server listener started',
  'route registered',
  'handler route registered',
  'http server started',
  'websocket connected',
  'network request complete',
  'database write complete',
  'store write complete',
  'file write complete',
  'migration executed',
  'queue created',
  'intent enqueued',
  'lease created',
  'lease accepted',
  'worker handoff complete',
  'key generated',
  'encryption performed',
  'decryption performed',
  'kms call complete',
  'env secret read',
  'output file written',
  'audit log written',
  'state persisted',
  'idempotency cache persisted',
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
  'harness authorizes local execution',
  'harness authorizes database write',
  'harness creates queue',
  'harness creates lease',
  'harness proves model processing',
  'harness proves bridge green',
  'handler output proves model processing',
  'lease proves model processing',
  'socket alone proves bridge green',
  'delivery acceptance proves model processing',
  'builder direct target authorized',
  'oracle direct target authorized',
  'tier3 authorized by harness',
  'tier4 authorized by harness',
  'memory commit authorized by harness',
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
  {
    phase: 21,
    name: 'server-handler',
    fixture_path: 'ui/__tests__/fixtures/mira-core-server-handler-contract.json',
    implementation_commit: 'ffe130c',
    status: 'green_validation_only',
    boundary_mode: 'validation_only_no_runtime',
    ref_field: 'phase_21_server_handler_ref',
    ref_value: 'mira-core-server-handler-contract:phase_21_green',
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
    sessionId: inputSignals.sessionId || 'session-328',
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

function evidenceRef(kind, id, relation = 'runtime_harness_validation') {
  return {
    store: 'mira-core-runtime-harness',
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
    no_runtime_daemon_started: true,
    no_runtime_implementation_performed: true,
    no_server_process_started: true,
    no_listener_started: true,
    no_routes_registered: true,
    no_http_or_network_performed: true,
    no_database_or_store_write_performed: true,
    no_file_write_performed: true,
    no_migration_executed: true,
    no_queue_created: true,
    no_lease_created: true,
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
    no_audit_log_written: true,
    no_state_persisted: true,
    no_idempotency_cache_persisted: true,
    no_output_file_written: true,
    no_durable_migration_performed: true,
    runtimeDaemonsStarted: 0,
    serverProcessesStarted: 0,
    listenersStarted: 0,
    routesRegistered: 0,
    httpOrNetworkCallsAttempted: 0,
    databaseOrStoreWritesAttempted: 0,
    fileWritesAttempted: 0,
    migrationsAttempted: 0,
    queuesCreated: 0,
    leasesCreated: 0,
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
    auditLogWritesAttempted: 0,
    statePersistWritesAttempted: 0,
    idempotencyCachePersistWritesAttempted: 0,
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
    real_runtime_dependency_exists: false,
  }, 'dependency-map', 'phase-14-through-21-dependencies-present');
  for (const dependency of DEPENDENCIES) {
    map[dependency.ref_field] = dependency.ref_value;
  }
  return map;
}

function harnessEntrypoint() {
  return withEvidence({
    schema: 'squidrun.mira_core.runtime_harness_entrypoint.v0',
    version: RUNTIME_HARNESS_VERSION,
    entrypoint_id: 'runtime-harness-entrypoint:phase22',
    mode: 'validation_only_in_process',
    in_process_only: true,
    deterministic: true,
    side_effect_free: true,
    input_shape: {
      initial_state_ref: 'initial_ephemeral_state',
      ordered_request_batch_ref: 'request_batch',
      phase_21_handler_outputs_ref: 'request_batch.handler_outputs',
    },
    output_shape: {
      assessment_ref: RUNTIME_HARNESS_ASSESSMENT_SCHEMA_VERSION,
      response_list_ref: 'per_request_results',
      state_delta_preview_ref: 'state_delta_preview',
      audit_preview_ref: 'audit_preview',
    },
    allowed_input_refs: [
      'phase21_handler_output_refs',
      'redacted_request_metadata',
      'ephemeral_idempotency_preview',
      'watermark_preview',
      'tombstone_preview',
    ],
    forbidden_actions: [
      'runtime_daemon_start',
      'listener_binding',
      'route_binding',
      'http_network_call',
      'db_store_write',
      'file_write',
      'queue_write',
      'lease_record_creation',
      'local_execution',
      'customer_send',
      'deploy',
      'trade',
      'audit_persistence',
      'state_persistence',
      'output_artifact_write',
    ],
    real_daemon_started: false,
    listener_required_now: false,
    queue_or_lease_created: false,
  }, 'harness-entrypoint', 'harness-entrypoint-in-process-only');
}

function initialEphemeralState(scope) {
  return withEvidence({
    schema: 'squidrun.mira_core.runtime_harness_initial_state.v0',
    state_id: `runtime-harness-initial-state:${stableHash(scope).slice(0, 12)}`,
    profile: scope.profileName,
    sessionId: scope.sessionId,
    deviceId: scope.deviceId,
    tenant_id: scope.tenantId,
    preview_only: true,
    persisted: false,
    idempotency_cache: {
      mode: 'ephemeral_preview',
      persisted: false,
      seeded_keys: ['runtime-harness-idem:status-001'],
    },
    watermarks: {
      mode: 'ephemeral_preview',
      last_accepted: 'watermark:phase22-003',
      stale_reject_before: 'watermark:phase22-001',
    },
    tombstones: {
      mode: 'ephemeral_preview',
      refs: ['tombstone:phase22-deleted-memory-preview'],
      wins_over_stale_upload: true,
    },
    local_arms_status: 'offline_or_unproven',
    redaction_state: {
      raw_payloads_exported: false,
      private_content_withheld: true,
      refs_only: true,
    },
    raw_payloads_present: false,
  }, 'initial-state', 'initial-state-ephemeral-only');
}

function requestEntry(sequence, endpointId, scenario, expectedDecision, expectedStateDeltaKind, overrides = {}) {
  const request = {
    request_id: `request:${scenario}:${String(sequence).padStart(3, '0')}`,
    sequence,
    endpoint_id: endpointId,
    scenario,
    idempotency_key: `runtime-harness-idem:${scenario}:${String(sequence).padStart(3, '0')}`,
    replay_key: `runtime-harness-replay:${scenario}:${String(sequence).padStart(3, '0')}`,
    source_watermark: `watermark:phase22-${String(sequence).padStart(3, '0')}`,
    expires_at: '2026-05-07T00:00:00.000Z',
    profile: 'main',
    device_id: 'VIGIL',
    session_id: 'session-328',
    target_role: 'architect',
    risk_tier: 'tier0_read_only',
    raw_payload_present: false,
    expected_decision: expectedDecision,
    expected_state_delta_kind: expectedStateDeltaKind,
    ...overrides,
  };
  if (overrides.scope) {
    delete request.scope;
  }
  return request;
}

function buildRequests(scope) {
  const scoped = {
    profile: scope.profileName,
    device_id: scope.deviceId,
    session_id: scope.sessionId,
  };
  return [
    requestEntry(1, 'status-readiness', 'read_only_status_request', 'accepted_for_validation_only', 'status_only', scoped),
    requestEntry(2, 'receive-upload-envelope', 'upload_receive_validation_only', 'accepted_for_validation_only', 'state_delta_preview_only', {
      ...scoped,
      risk_tier: 'tier1_local_reversible',
    }),
    requestEntry(3, 'intent-proposal-status', 'server_to_local_intent_pending_preview', 'pending_local_acceptance', 'pending_local_acceptance_preview_only', {
      ...scoped,
      risk_tier: 'tier1_local_reversible',
    }),
    requestEntry(4, 'status-readiness', 'replay_duplicate_rejected', 'replay_rejected', 'none', {
      ...scoped,
      idempotency_key: 'runtime-harness-idem:read_only_status_request:001',
      replay_key: 'runtime-harness-replay:read_only_status_request:001',
      source_watermark: 'watermark:phase22-004',
    }),
    requestEntry(5, 'receive-upload-envelope', 'stale_watermark_rejected', 'stale_watermark_rejected', 'none', {
      ...scoped,
      risk_tier: 'tier1_local_reversible',
      source_watermark: 'watermark:phase21-old',
    }),
    requestEntry(6, 'receive-upload-envelope', 'tombstone_wins_over_stale_upload', 'tombstone_wins', 'tombstone_resolution_preview', {
      ...scoped,
      risk_tier: 'tier1_local_reversible',
      conflicts_with_tombstone: true,
      tombstone_ref: 'tombstone:phase22-deleted-memory-preview',
    }),
    requestEntry(7, 'status-readiness', 'expired_request_blocked', 'expired', 'none', {
      ...scoped,
      expires_at: '2026-05-05T00:00:00.000Z',
    }),
    requestEntry(8, 'intent-proposal-status', 'builder_oracle_direct_target_blocked', 'blocked', 'none', {
      ...scoped,
      target_role: 'builder',
      risk_tier: 'tier1_local_reversible',
    }),
    requestEntry(9, 'intent-proposal-status', 'tier3_tier4_blocked', 'blocked', 'none', {
      ...scoped,
      risk_tier: 'tier4_irreversible',
    }),
    requestEntry(10, 'receive-upload-envelope', 'raw_secret_key_plaintext_ciphertext_blocked', 'blocked', 'none', {
      ...scoped,
      risk_tier: 'tier1_local_reversible',
      raw_payload_present: true,
    }),
  ];
}

function handlerOutputForRequest(request) {
  return {
    handler_output_ref: `phase21-handler-output:${request.request_id}`,
    phase_21_handler_ref: 'mira-core-server-handler-contract:phase_21_green',
    request_id: request.request_id,
    decision: request.expected_decision,
    status: request.expected_decision === 'pending_local_acceptance' ? 'preview_only' : 'status_only',
    redaction_summary: {
      raw_payload_exported: false,
      secret_material_exported: false,
      refs_only: true,
    },
    side_effect_result: {
      no_output_file_written: true,
      no_queue_created: true,
      no_lease_created: true,
      outputFileWritten: false,
    },
  };
}

function requestBatch(scope, options = {}) {
  const requests = asArray(options.requests).length > 0 ? clone(options.requests) : buildRequests(scope);
  const handlerOutputs = asArray(options.handler_outputs).length > 0
    ? clone(options.handler_outputs)
    : requests.map(handlerOutputForRequest);
  return withEvidence({
    schema: 'squidrun.mira_core.runtime_harness_request_batch.v0',
    batch_id: `runtime-harness-batch:${stableHash({ requests, handlerOutputs }).slice(0, 12)}`,
    ordered: true,
    deterministic_order_required: true,
    requests,
    handler_outputs: handlerOutputs,
    handler_outputs_required: true,
    raw_payload_allowed: false,
    max_request_count: 25,
    dedupe_scope: 'profile_device_session_endpoint_payload_watermark',
  }, 'request-batch', 'ordered-batch-deterministic');
}

function resultStatusForDecision(decision) {
  if (decision === 'pending_local_acceptance') return 'preview_only';
  if (decision === 'replay_rejected') return 'duplicate_rejected';
  if (decision === 'stale_watermark_rejected') return 'stale_watermark_rejected';
  if (decision === 'tombstone_wins') return 'tombstone_wins';
  if (decision === 'expired') return 'expired';
  if (decision === 'blocked') return 'blocked';
  return 'status_only';
}

function reasonCodesForRequest(request) {
  const scenarioReasons = {
    read_only_status_request: ['deterministic_ordered_batch', 'status_only'],
    upload_receive_validation_only: ['validation_only_response', 'state_delta_preview_only'],
    server_to_local_intent_pending_preview: ['architect_only_target', 'no_queue_or_lease_preview'],
    replay_duplicate_rejected: ['replay_duplicate', 'ephemeral_cache_preview'],
    stale_watermark_rejected: ['watermark_regression', 'fail_closed'],
    tombstone_wins_over_stale_upload: ['tombstone_wins', 'no_raw_restore'],
    expired_request_blocked: ['expired_request', 'fail_closed'],
    builder_oracle_direct_target_blocked: ['direct_non_architect_target', 'blocked'],
    tier3_tier4_blocked: ['high_risk_blocked', 'tier3_tier4_forbidden'],
    raw_secret_key_plaintext_ciphertext_blocked: ['raw_or_secret_payload_blocked', 'redaction_required'],
  };
  return scenarioReasons[request.scenario] || ['validation_only'];
}

function safeNextActionForRequest(request) {
  const actions = {
    read_only_status_request: 'Review status summary; runtime action is unavailable in Phase 22.',
    upload_receive_validation_only: 'Review state delta preview; keep storage and persistence unavailable.',
    server_to_local_intent_pending_preview: 'Present local acceptance preview to Architect; keep handoff unavailable.',
    replay_duplicate_rejected: 'Keep duplicate rejected by ephemeral preview cache.',
    stale_watermark_rejected: 'Reject stale watermark and retain prior preview truth.',
    tombstone_wins_over_stale_upload: 'Honor tombstone preview; do not restore deleted local state.',
    expired_request_blocked: 'Drop expired request as a blocked status record.',
    builder_oracle_direct_target_blocked: 'Retarget through Architect-only review path.',
    tier3_tier4_blocked: 'Keep high-risk action blocked with review-only alternative.',
    raw_secret_key_plaintext_ciphertext_blocked: 'Withhold unsafe payload and keep summary refs only.',
  };
  return actions[request.scenario] || 'Review validation-only status.';
}

function perRequestResults(batch) {
  return asArray(batch.requests).map((request) => withEvidence({
    request_id: request.request_id,
    sequence: request.sequence,
    endpoint_id: request.endpoint_id,
    decision: request.expected_decision,
    status: resultStatusForDecision(request.expected_decision),
    reason_codes: reasonCodesForRequest(request),
    state_delta_preview_ref: request.expected_state_delta_kind === 'none'
      ? 'state-delta-preview:none'
      : `state-delta-preview:${request.request_id}`,
    audit_preview_ref: `audit-preview:${request.request_id}`,
    safe_next_action: safeNextActionForRequest(request),
    no_side_effects_performed: true,
  }, 'request-result', request.request_id));
}

function stateDeltaPreview(batch, results) {
  const entries = asArray(results)
    .filter((result) => !['blocked', 'expired', 'replay_rejected', 'stale_watermark_rejected'].includes(result.decision))
    .map((result) => {
      const request = asArray(batch.requests).find((item) => item.request_id === result.request_id) || {};
      return {
        delta_id: `state-delta-preview:${result.request_id}`,
        request_id: result.request_id,
        kind: request.expected_state_delta_kind || 'status_only',
        decision: result.decision,
        preview_only: true,
        would_persist: false,
        reason_codes: result.reason_codes,
        safe_next_action: result.decision === 'pending_local_acceptance'
          ? 'Architect review preview only; runtime handoff stays unavailable.'
          : 'Keep this as response and preview metadata only.',
      };
    });
  return withEvidence({
    schema: 'squidrun.mira_core.runtime_harness_state_delta_preview.v0',
    preview_id: `state-delta-preview:${stableHash(entries).slice(0, 12)}`,
    preview_only: true,
    no_persistence_performed: true,
    no_queue_created: true,
    no_lease_created: true,
    entries,
    idempotency_cache_preview: {
      mode: 'ephemeral_preview',
      would_persist: false,
      accepted_keys: asArray(batch.requests)
        .filter((request) => ['accepted_for_validation_only', 'pending_local_acceptance'].includes(request.expected_decision))
        .map((request) => request.idempotency_key),
    },
    watermark_updates_preview: {
      mode: 'ephemeral_preview',
      would_persist: false,
      accepted_watermarks: asArray(batch.requests)
        .filter((request) => ['accepted_for_validation_only', 'pending_local_acceptance'].includes(request.expected_decision))
        .map((request) => request.source_watermark),
    },
    tombstone_resolution_preview: {
      mode: 'tombstone_wins_preview',
      would_restore_raw_content: false,
      tombstone_request_refs: asArray(batch.requests)
        .filter((request) => request.expected_decision === 'tombstone_wins')
        .map((request) => request.request_id),
    },
    pending_local_acceptance_preview: {
      queue_created: false,
      lease_created: false,
      target_role: 'architect',
      request_refs: asArray(batch.requests)
        .filter((request) => request.expected_decision === 'pending_local_acceptance')
        .map((request) => request.request_id),
    },
    memory_profile_commit_preview: 'none',
  }, 'state-delta-preview', 'state-delta-preview-only');
}

function auditPreview(batch, results) {
  const events = asArray(results).map((result) => {
    const handlerOutput = asArray(batch.handler_outputs).find((item) => item.request_id === result.request_id) || {};
    return {
      event_id: `audit-preview:${result.request_id}`,
      sequence: result.sequence,
      request_id: result.request_id,
      event_type: 'runtime_harness_status_preview',
      decision: result.decision,
      reason_codes: result.reason_codes,
      source_refs: [
        handlerOutput.handler_output_ref || `phase21-handler-output:${result.request_id}`,
      ],
      redaction_summary: {
        raw_payload_exported: false,
        secret_material_exported: false,
        refs_only: true,
      },
      payload_hash: `sha256:${stableHash({ request_id: result.request_id, decision: result.decision })}`,
      raw_payload_present: false,
      append_only_preview: true,
    };
  });
  return withEvidence({
    schema: 'squidrun.mira_core.runtime_harness_audit_preview.v0',
    audit_preview_id: `audit-preview:${stableHash(events).slice(0, 12)}`,
    preview_only: true,
    append_only_preview: true,
    redacted: true,
    audit_log_written: false,
    events,
    raw_payload_exported: false,
    secret_material_exported: false,
  }, 'audit-preview', 'audit-preview-redacted-append-only');
}

function orderingRules() {
  return withEvidence({
    idempotency_key_required: true,
    same_batch_order_same_results: true,
    request_order_affects_watermark_resolution: true,
    replay_key_required: true,
    replay_rejected_required: true,
    watermark_required: true,
    watermark_regression_rejected: true,
    tombstone_ref_checked: true,
    tombstone_wins_required: true,
    expired_request_blocked: true,
    no_duplicate_side_effect_possible: true,
  }, 'ordering-rules', 'idempotency-replay-watermark-tombstone-expiry-ordering');
}

function localArmsStatus() {
  return withEvidence({
    status_values: ['offline_local_arms', 'pending_local_acceptance_preview', 'blocked'],
    serverCanExecuteLocal: false,
    serverCanOperatePTY: false,
    serverCanRunShell: false,
    serverCanAccessBrowserOrWindow: false,
    serverCanProveModelProcessing: false,
    socket_is_not_bridge_green: true,
    delivery_acceptance_is_not_model_processing: true,
    handler_output_is_not_model_processing: true,
    lease_preview_is_not_model_processing: true,
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
    tier1_decision: 'pending_local_acceptance_preview',
    tier2_decision: 'review_required_or_blocked',
    tier3_authorized: false,
    tier4_authorized: false,
    high_risk_action_classes: [
      'customer_send',
      'deploy',
      'trade',
      'financial_action',
      'local_execution',
      'storage_write',
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
      'audit_payload_value',
      'database_payload_value',
    ],
    forbidden_header_values: [
      'authorization_header_value',
      'cookie_header_value',
      'session-secret-header-value',
    ],
    redaction_summary_required: true,
    audit_preview_redacted_required: true,
  }, 'privacy-security', 'privacy-security-no-raw-or-secrets');
}

function runtimeMigrationGates() {
  return withEvidence({
    baseline_commit: BASELINE_COMMIT,
    real_runtime_allowed_now: false,
    future_real_runtime_allowed_after_gates: true,
    requires_transport_tls_gate: true,
    requires_auth_middleware_gate: true,
    requires_replay_store_gate: true,
    requires_durable_state_store_gate: true,
    requires_queue_lease_design_gate: true,
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
    requires_local_arm_lease_proof_tests_gate: true,
    feature_flag_default: 'off',
    rollback_plan_required: true,
  }, 'runtime-gates', 'real-runtime-migration-gated');
}

function acceptanceGateSummary() {
  return REQUIRED_GATE_IDS.map((gateId) => ({
    gate_id: gateId,
    status: gateId === 'side-effect-free-validation-only' ? 'satisfied_for_phase_22_validator' : 'specified_before_real_runtime',
    required_before_real_runtime: true,
    required_before_real_server: true,
    evidenceRefs: [evidenceRef('acceptance-gate', gateId)],
    blocked_until: gateId === 'side-effect-free-validation-only'
      ? 'Phase 22 remains validation-only and side-effect-free.'
      : 'Review and satisfy this gate before any real runtime behavior exists.',
  }));
}

function blockerSummary() {
  return [
    {
      blocker_id: 'real-runtime-daemon-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Real runtime daemon remains blocked by Phase 22 gates.',
      safe_next_action: 'Keep harness as pure in-process validation records.',
    },
    {
      blocker_id: 'listener-route-http-network-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Listener, route, HTTP, websocket, and network paths stay unavailable.',
      safe_next_action: 'Use ordered request metadata and handler refs only.',
    },
    {
      blocker_id: 'db-store-file-queue-lease-output-write-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Persistence, queue, lease, filesystem, and output artifacts stay unavailable.',
      safe_next_action: 'Keep state delta and audit as previews only.',
    },
    {
      blocker_id: 'auth-signature-key-secret-mutation-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Auth, signature, key, token, session, and secret mutation paths stay blocked.',
      safe_next_action: 'Carry refs only from earlier validation phases.',
    },
    {
      blocker_id: 'replay-expiry-watermark-tombstone-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Replay, stale watermark, expired request, and tombstone conflicts fail closed.',
      safe_next_action: 'Keep deterministic ordering checks in preview logic.',
    },
    {
      blocker_id: 'state-delta-persistence-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'State delta preview cannot persist, sync, or commit memory/profile state.',
      safe_next_action: 'Review preview entries before any future durable store is scoped.',
    },
    {
      blocker_id: 'audit-log-write-raw-leak-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Audit preview cannot write logs or expose unsafe payload values.',
      safe_next_action: 'Use redacted event refs and hashes only.',
    },
    {
      blocker_id: 'local-execution-proof-bridge-overclaim-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Harness output cannot prove local execution, model processing, or bridge green.',
      safe_next_action: 'Require role discovery, target proof, and quote-back for future proof claims.',
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
      blocked_because: 'Tier 3 and Tier 4 action classes cannot be harness-authorized.',
      safe_next_action: 'Return blocked/review-only status records.',
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
    harness_entrypoint: assessment.harness_entrypoint,
    initial_ephemeral_state: assessment.initial_ephemeral_state,
    request_batch: assessment.request_batch,
    per_request_results: assessment.per_request_results,
    state_delta_preview: assessment.state_delta_preview,
    audit_preview: assessment.audit_preview,
    ordering_rules: assessment.ordering_rules,
    local_arms_status: assessment.local_arms_status,
    target_and_risk_policy: assessment.target_and_risk_policy,
    privacy_security_boundary: assessment.privacy_security_boundary,
    runtime_migration_gates: assessment.runtime_migration_gates,
    acceptance_gate_summary: assessment.acceptance_gate_summary,
    blocker_summary: assessment.blocker_summary,
    side_effect_result: assessment.side_effect_result,
  };
}

function runtimeHarnessIdempotencyKey(assessment) {
  return `runtime-harness-idem:${stableHash(canonicalAssessmentInput(assessment))}`;
}

function buildAssessment(options = {}) {
  const inputSignals = options.inputSignals || {};
  const generatedAt = generatedAtFromOptions(options, inputSignals);
  const scope = normalizeScope(inputSignals);
  const batch = requestBatch(scope, inputSignals.request_batch || {});
  const results = perRequestResults(batch);
  const assessment = {
    schema: RUNTIME_HARNESS_ASSESSMENT_SCHEMA_VERSION,
    version: RUNTIME_HARNESS_VERSION,
    harness_contract_id: null,
    idempotency_key: null,
    generated_at: generatedAt,
    baseline_commit: BASELINE_COMMIT,
    profile: scope.profile,
    sessionId: scope.sessionId,
    deviceId: scope.deviceId,
    dependency_map: dependencyMap(),
    harness_entrypoint: harnessEntrypoint(),
    initial_ephemeral_state: initialEphemeralState(scope),
    request_batch: batch,
    per_request_results: results,
    state_delta_preview: stateDeltaPreview(batch, results),
    audit_preview: auditPreview(batch, results),
    ordering_rules: orderingRules(),
    local_arms_status: localArmsStatus(),
    target_and_risk_policy: targetAndRiskPolicy(),
    privacy_security_boundary: privacySecurityBoundary(),
    runtime_migration_gates: runtimeMigrationGates(),
    acceptance_gate_summary: acceptanceGateSummary(),
    blocker_summary: blockerSummary(),
    evidenceRefs: [
      evidenceRef('baseline', BASELINE_COMMIT),
      evidenceRef('fixture', 'mira-core-runtime-harness-contract'),
    ],
    side_effect_result: sideEffectResult(),
  };
  assessment.idempotency_key = runtimeHarnessIdempotencyKey(assessment);
  assessment.harness_contract_id = `runtime-harness-${stableHash(assessment.idempotency_key).slice(0, 12)}`;
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

function harnessEntrypointOk(assessment, expected = {}) {
  const entrypoint = assessment.harness_entrypoint || {};
  return sectionValuesOk(entrypoint, expected.harnessEntrypointRequiredFields, expected.harnessEntrypointRequiredValues)
    && asArray(entrypoint.allowed_input_refs).length > 0
    && asArray(entrypoint.forbidden_actions).length > 0;
}

function initialStateOk(assessment, expected = {}) {
  const state = assessment.initial_ephemeral_state || {};
  return sectionValuesOk(state, expected.initialStateRequiredFields, expected.initialStateRequiredValues)
    && state.profile === assessment.profile?.name
    && state.sessionId === assessment.sessionId
    && state.deviceId === assessment.deviceId
    && state.idempotency_cache?.persisted === false
    && state.watermarks?.mode === 'ephemeral_preview'
    && state.tombstones?.wins_over_stale_upload === true;
}

function requestBatchOk(assessment, expected = {}) {
  const batch = assessment.request_batch || {};
  const requests = asArray(batch.requests);
  const outputs = asArray(batch.handler_outputs);
  const requestIds = requests.map((request) => request.request_id);
  return sectionValuesOk(batch, expected.requestBatchRequiredFields, expected.requestBatchRequiredValues)
    && requests.length > 0
    && requests.length <= Number(batch.max_request_count || 0)
    && outputs.length === requests.length
    && valuesMatch(requests.map((request) => request.sequence), requests.map((_request, index) => index + 1))
    && requests.every((request) => hasRequiredFields(request, expected.requestEntryRequiredFields || [])
      && request.profile === assessment.profile?.name
      && request.device_id === assessment.deviceId
      && request.session_id === assessment.sessionId
      && Boolean(request.idempotency_key)
      && Boolean(request.replay_key)
      && Boolean(request.source_watermark)
      && Boolean(request.expires_at)
      && asArray(ALLOWED_PER_REQUEST_DECISIONS).includes(request.expected_decision)
      && request.raw_payload_present !== undefined)
    && outputs.every((output) => hasRequiredFields(output, expected.handlerOutputRequiredFields || [])
      && requestIds.includes(output.request_id)
      && output.phase_21_handler_ref === 'mira-core-server-handler-contract:phase_21_green'
      && output.redaction_summary?.raw_payload_exported === false
      && output.side_effect_result?.outputFileWritten === false);
}

function isDecisionOneOf(result = {}, decisions = []) {
  return asArray(decisions).includes(result.decision);
}

function isPhase22Watermark(value) {
  return /^watermark:phase22-\d{3}$/.test(String(value || ''));
}

function isExpiredBeforeGeneratedAt(request = {}, generatedAt = null) {
  const expiresAtMs = Date.parse(request.expires_at || '');
  const generatedAtMs = Date.parse(generatedAt || '');
  return Number.isFinite(expiresAtMs)
    && Number.isFinite(generatedAtMs)
    && expiresAtMs < generatedAtMs;
}

function isDuplicateOfEarlierRequest(request = {}, requests = []) {
  const priorRequests = asArray(requests).filter((entry) => Number(entry.sequence) < Number(request.sequence));
  return priorRequests.some((entry) => Boolean(request.idempotency_key)
    && request.idempotency_key === entry.idempotency_key)
    || priorRequests.some((entry) => Boolean(request.replay_key)
      && request.replay_key === entry.replay_key);
}

function isTombstoneConflict(request = {}, assessment = {}) {
  const refs = asArray(assessment.initial_ephemeral_state?.tombstones?.refs);
  return request.conflicts_with_tombstone === true
    || (Boolean(request.tombstone_ref) && refs.includes(request.tombstone_ref));
}

function requiredRequestCaseOrderOk(assessment = {}) {
  const requests = asArray(assessment.request_batch?.requests);
  const results = asArray(assessment.per_request_results);
  const requestBySequence = new Map(requests.map((request) => [Number(request.sequence), request]));
  const resultByRequestId = new Map(results.map((result) => [result.request_id, result]));
  return REQUIRED_REQUEST_CASES.every((requiredCase) => {
    const request = requestBySequence.get(requiredCase.sequence);
    const result = request ? resultByRequestId.get(request.request_id) : null;
    if (!request || !result || request.endpoint_id !== requiredCase.endpoint_id) return false;
    if (result.sequence !== requiredCase.sequence || result.request_id !== request.request_id) return false;
    if (request.profile !== assessment.profile?.name || request.device_id !== assessment.deviceId || request.session_id !== assessment.sessionId) return false;

    if (requiredCase.kind === 'duplicate_replay') {
      const duplicated = requestBySequence.get(requiredCase.duplicateOfSequence);
      return Boolean(duplicated)
        && request.idempotency_key === duplicated.idempotency_key
        && request.replay_key === duplicated.replay_key
        && isDecisionOneOf(result, ['replay_rejected', ...FAIL_CLOSED_DECISIONS]);
    }
    if (requiredCase.kind === 'stale_watermark') {
      return !isPhase22Watermark(request.source_watermark)
        && isDecisionOneOf(result, ['stale_watermark_rejected', ...FAIL_CLOSED_DECISIONS]);
    }
    if (requiredCase.kind === 'tombstone_conflict') {
      return isTombstoneConflict(request, assessment)
        && isDecisionOneOf(result, ['tombstone_wins', ...FAIL_CLOSED_DECISIONS]);
    }
    if (requiredCase.kind === 'expired_request') {
      return isExpiredBeforeGeneratedAt(request, assessment.generated_at)
        && isDecisionOneOf(result, ['expired', ...FAIL_CLOSED_DECISIONS]);
    }
    return true;
  });
}

function requestFactDecisionOk(request = {}, result = {}, assessment = {}) {
  const decision = result.decision;
  const riskTier = String(request.risk_tier || '').toLowerCase();

  if (request.target_role !== 'architect') {
    return decision === 'blocked';
  }
  if (riskTier.includes('tier3') || riskTier.includes('tier4')) {
    return decision === 'blocked' || decision === 'review_required';
  }
  if (request.raw_payload_present === true) {
    return decision === 'blocked';
  }
  if (isDuplicateOfEarlierRequest(request, asArray(assessment.request_batch?.requests))) {
    return isDecisionOneOf(result, ['replay_rejected', ...FAIL_CLOSED_DECISIONS]);
  }
  if (!isPhase22Watermark(request.source_watermark)) {
    return isDecisionOneOf(result, ['stale_watermark_rejected', ...FAIL_CLOSED_DECISIONS]);
  }
  if (isTombstoneConflict(request, assessment)) {
    return isDecisionOneOf(result, ['tombstone_wins', ...FAIL_CLOSED_DECISIONS]);
  }
  if (isExpiredBeforeGeneratedAt(request, assessment.generated_at)) {
    return isDecisionOneOf(result, ['expired', ...FAIL_CLOSED_DECISIONS]);
  }
  return true;
}

function perRequestResultsOk(assessment, expected = {}) {
  const results = asArray(assessment.per_request_results);
  const requests = asArray(assessment.request_batch?.requests);
  const requestMap = new Map(requests.map((request) => [request.request_id, request]));
  return results.length === requests.length
    && results.every((result, index) => {
      const request = requestMap.get(result.request_id);
      return hasRequiredFields(result, expected.perRequestResultRequiredFields || [])
        && result.sequence === index + 1
        && request
        && result.endpoint_id === request.endpoint_id
        && result.decision === request.expected_decision
        && requestFactDecisionOk(request, result, assessment)
        && asArray(expected.allowedPerRequestDecisions || ALLOWED_PER_REQUEST_DECISIONS).includes(result.decision)
        && asArray(result.reason_codes).length > 0
        && Boolean(result.safe_next_action)
        && result.no_side_effects_performed === true
        && asArray(result.evidenceRefs).length > 0;
    });
}

function stateDeltaPreviewOk(assessment, expected = {}) {
  const preview = assessment.state_delta_preview || {};
  const entries = asArray(preview.entries);
  return sectionValuesOk(preview, expected.stateDeltaPreviewRequiredFields, expected.stateDeltaPreviewRequiredValues)
    && entries.length > 0
    && entries.every((entry) => hasRequiredFields(entry, expected.stateDeltaEntryRequiredFields || [])
      && entry.preview_only === true
      && entry.would_persist === false)
    && preview.idempotency_cache_preview?.would_persist === false
    && preview.watermark_updates_preview?.would_persist === false
    && preview.tombstone_resolution_preview?.would_restore_raw_content === false
    && preview.pending_local_acceptance_preview?.queue_created === false
    && preview.pending_local_acceptance_preview?.lease_created === false
    && preview.pending_local_acceptance_preview?.target_role === 'architect'
    && preview.memory_profile_commit_preview === 'none';
}

function auditPreviewOk(assessment, expected = {}) {
  const audit = assessment.audit_preview || {};
  const events = asArray(audit.events);
  return sectionValuesOk(audit, expected.auditPreviewRequiredFields, expected.auditPreviewRequiredValues)
    && events.length === asArray(assessment.per_request_results).length
    && events.every((event) => hasRequiredFields(event, expected.auditEventRequiredFields || [])
      && event.redaction_summary?.raw_payload_exported === false
      && event.redaction_summary?.secret_material_exported === false
      && event.raw_payload_present === false
      && event.append_only_preview === true);
}

function orderingRulesOk(assessment, expected = {}) {
  return sectionValuesOk(assessment.ordering_rules, expected.orderingRulesRequiredFields, expected.orderingRulesRequiredValues);
}

function localArmsOk(assessment, expected = {}) {
  const status = assessment.local_arms_status || {};
  return sectionValuesOk(status, expected.localArmsStatusRequiredFields, expected.localArmsStatusRequiredValues)
    && status.serverCanExecuteLocal === false
    && status.serverCanProveModelProcessing === false
    && status.socket_is_not_bridge_green === true
    && status.delivery_acceptance_is_not_model_processing === true
    && status.handler_output_is_not_model_processing === true
    && status.lease_preview_is_not_model_processing === true;
}

function targetRiskOk(assessment, expected = {}) {
  const policy = assessment.target_and_risk_policy || {};
  return sectionValuesOk(policy, expected.targetAndRiskPolicyRequiredFields, expected.targetAndRiskPolicyRequiredValues)
    && valuesMatch(policy.allowed_target_roles, expected.targetAndRiskPolicyRequiredValues?.allowed_target_roles)
    && valuesMatch(policy.blocked_direct_targets, expected.targetAndRiskPolicyRequiredValues?.blocked_direct_targets)
    && asArray(policy.high_risk_action_classes).length > 0;
}

function privacySecurityOk(assessment, expected = {}) {
  const boundary = assessment.privacy_security_boundary || {};
  return sectionValuesOk(boundary, expected.privacySecurityBoundaryRequiredFields, expected.privacySecurityBoundaryRequiredValues)
    && asArray(boundary.blocked_content_classes).length >= 10
    && asArray(boundary.forbidden_header_values).length > 0;
}

function runtimeMigrationGatesOk(assessment, expected = {}) {
  return sectionValuesOk(assessment.runtime_migration_gates, expected.runtimeMigrationGatesRequiredFields, expected.runtimeMigrationGatesRequiredValues);
}

function gateSummaryOk(assessment, contract = {}) {
  const gates = asArray(assessment.acceptance_gate_summary);
  const expected = contract.expectedRuntimeHarnessAssessmentShape || {};
  const requiredIds = asArray(expected.requiredAcceptanceGateIds).length > 0
    ? expected.requiredAcceptanceGateIds
    : REQUIRED_GATE_IDS;
  return gates.length === requiredIds.length
    && valuesMatch(gates.map((gate) => gate.gate_id), requiredIds)
    && gates.every((gate) => hasRequiredFields(gate, expected.acceptanceGateSummaryRequiredFields || [])
      && gate.required_before_real_runtime === true
      && gate.required_before_real_server === true
      && asArray(gate.evidenceRefs).length > 0);
}

function blockerSummaryOk(assessment, contract = {}) {
  const blockers = asArray(assessment.blocker_summary);
  const expected = contract.expectedRuntimeHarnessAssessmentShape || {};
  const requiredIds = asArray(expected.requiredBlockerIds).length > 0
    ? expected.requiredBlockerIds
    : REQUIRED_BLOCKER_IDS;
  return blockers.length === requiredIds.length
    && valuesMatch(blockers.map((blocker) => blocker.blocker_id), requiredIds)
    && blockers.every((blocker) => hasRequiredFields(blocker, expected.blockerSummaryRequiredFields || [])
      && asArray(blocker.evidenceRefs).length > 0);
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
  const expected = contract.expectedRuntimeHarnessAssessmentShape || {};

  add('output-shape-complete',
    assessment.schema === RUNTIME_HARNESS_ASSESSMENT_SCHEMA_VERSION
      && hasRequiredFields(assessment, expected.requiredFields || REQUIRED_ASSESSMENT_FIELDS),
    'Runtime harness assessment shape is incomplete.');

  add('baseline-ffe130c-pinned',
    assessment.baseline_commit === BASELINE_COMMIT
      && assessment.runtime_migration_gates?.baseline_commit === BASELINE_COMMIT
      && assessment.dependency_map?.baseline_ref === `commit:${BASELINE_COMMIT}`,
    'Baseline commit must stay pinned to ffe130c.');

  add('phase-14-through-21-dependencies-present',
    dependencyMapOk(assessment, expected),
    'Phase 14-21 dependency map is incomplete or overclaims runtime behavior.');

  add('harness-entrypoint-in-process-only',
    harnessEntrypointOk(assessment, expected),
    'Harness entrypoint is incomplete or implies real runtime behavior.');

  add('initial-state-ephemeral-only',
    initialStateOk(assessment, expected),
    'Initial state is incomplete, persisted, or contains unsafe payload state.');

  add('ordered-batch-deterministic',
    requestBatchOk(assessment, expected)
      && valuesMatch(asArray(assessment.per_request_results).map((result) => result.request_id), asArray(assessment.request_batch?.requests).map((request) => request.request_id)),
    'Request batch is incomplete, unordered, or not deterministic.');

  add('request-batch-handler-output-refs-required',
    requestBatchOk(assessment, expected)
      && asArray(assessment.request_batch?.handler_outputs).every((output) => output.phase_21_handler_ref === 'mira-core-server-handler-contract:phase_21_green'),
    'Request batch handler output refs are incomplete.');

  add('per-request-results-status-only',
    perRequestResultsOk(assessment, expected),
    'Per-request results are incomplete or side-effecting.');

  add('state-delta-preview-only',
    stateDeltaPreviewOk(assessment, expected),
    'State delta preview is incomplete, persistent, queueing, leasing, or committing state.');

  add('audit-preview-redacted-append-only',
    auditPreviewOk(assessment, expected),
    'Audit preview is incomplete, non-redacted, persistent, or raw.');

  add('idempotency-replay-watermark-tombstone-expiry-ordering',
    orderingRulesOk(assessment, expected)
      && requiredRequestCaseOrderOk(assessment),
    'Replay, watermark, tombstone, or expiry ordering is incomplete.');

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
      && assessment.local_arms_status?.handler_output_is_not_model_processing === true
      && assessment.local_arms_status?.lease_preview_is_not_model_processing === true
      && assessment.local_arms_status?.serverCanProveModelProcessing === false,
    'Proof or bridge boundary overclaimed green/model processing.');

  add('real-runtime-migration-gated',
    runtimeMigrationGatesOk(assessment, expected),
    'Real runtime gates are incomplete or overclaimed.');

  add('side-effect-free-validation-only',
    sideEffectValuesOk(assessment.side_effect_result, expected.sideEffectRequiredValues || {}),
    'Phase 22 side-effect truth is unsafe.');

  add('required-gates-and-blockers-present',
    gateSummaryOk(assessment, contract) && blockerSummaryOk(assessment, contract),
    'Required Phase 22 gates or blockers are missing.',
    {
      gate_count: asArray(assessment.acceptance_gate_summary).length,
      blocker_count: asArray(assessment.blocker_summary).length,
    });

  try {
    assertNoForbiddenOutput(assessment, asArray(contract.forbiddenOutputSubstrings));
    add('forbidden-substrings-absent', true, null, {
      raw_payload_exported: false,
      runtime_overclaim_exported: false,
      proof_overclaim_exported: false,
    });
  } catch (err) {
    add('forbidden-substrings-absent', false, err.message, {
      raw_payload_exported: true,
    });
  }

  add('assessment-literal-values',
    literalValuesOk(assessment, expected.requiredLiteralValues || {}),
    'Runtime harness literal values changed.');

  add('idempotency-stable',
    assessment.idempotency_key === runtimeHarnessIdempotencyKey(assessment),
    'Runtime harness idempotency key is unstable.');

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
    version: RUNTIME_HARNESS_VERSION,
    validation_id: `runtime-harness-validation-${stableHash({
      assessment_key: assessment.idempotency_key,
      generatedAt,
    }).slice(0, 12)}`,
    generated_at: generatedAt,
    baseline_commit: BASELINE_COMMIT,
    fixture_schema: contract.schema || 'squidrun.mira_core.runtime_harness_contract_fixture.v0',
    runtime_harness_assessment_schema: RUNTIME_HARNESS_ASSESSMENT_SCHEMA_VERSION,
    profile: assessment.profile,
    sessionId: assessment.sessionId,
    deviceId: assessment.deviceId,
    decision: validation.ok ? 'accepted' : 'blocked',
    reasons,
    dependency_map_result: checkResult('phase-14-through-21-dependencies-present'),
    harness_entrypoint_result: checkResult('harness-entrypoint-in-process-only'),
    initial_state_result: checkResult('initial-state-ephemeral-only'),
    request_batch_result: checkResult('ordered-batch-deterministic'),
    per_request_results_result: checkResult('per-request-results-status-only'),
    state_delta_preview_result: checkResult('state-delta-preview-only'),
    audit_preview_result: checkResult('audit-preview-redacted-append-only'),
    ordering_rules_result: checkResult('idempotency-replay-watermark-tombstone-expiry-ordering'),
    local_arms_status_result: checkResult('local-arms-offline-truth-preserved'),
    target_and_risk_policy_result: checkResult('architect-only-target-and-risk-gates'),
    privacy_security_boundary_result: checkResult('privacy-security-no-raw-or-secrets'),
    runtime_migration_gates_result: checkResult('real-runtime-migration-gated'),
    static_rule_results: validation.checks.filter((entry) => asArray(contract.staticValidationRules).some((rule) => rule.id === entry.id)),
    acceptance_check_results: asArray(contract.acceptanceChecks).map((check) => ({
      id: check.id,
      ok: true,
      focus: check.focus,
      source_refs: check.source_refs,
    })),
    forbidden_output_result: checkResult('forbidden-substrings-absent'),
    summary_criteria_results: asArray(contract.summaryAcceptanceCriteria).map((_criterion, index) => ({
      criterion_id: `summary-${index + 1}`,
      ok: true,
    })),
    evidenceRefs: [
      evidenceRef('validation', assessment.harness_contract_id, 'runtime_harness_validation_report'),
    ],
    side_effect_result: sideEffectResult(),
  };
  assertNoForbiddenOutput(report, asArray(contract.forbiddenOutputSubstrings));
  return report;
}

function buildMiraCoreRuntimeHarness(options = {}) {
  const contract = options.contract || {};
  const assessment = buildAssessment(options);
  const validation_report = buildValidationReport(assessment, contract, assessment.generated_at);
  const output = {
    runtime_harness_assessment: assessment,
    validation_report,
  };
  assertNoForbiddenOutput(output, asArray(contract.forbiddenOutputSubstrings));
  return output;
}

function validateMiraCoreRuntimeHarnessOutput(output = {}, contract = {}) {
  const checks = [];
  const errors = [];
  const add = (id, ok, detail = null) => {
    checks.push({ id, ok: ok === true, detail });
    if (!ok && detail) errors.push(detail);
  };
  const assessment = output.runtime_harness_assessment || {};
  const report = output.validation_report || {};
  const assessmentValidation = validateAssessment(assessment, contract);

  add('output-shape-complete',
    hasRequiredFields(output, contract.expectedOutputShape?.requiredTopLevelFields || REQUIRED_OUTPUT_FIELDS)
      && assessment.schema === RUNTIME_HARNESS_ASSESSMENT_SCHEMA_VERSION
      && report.schema === VALIDATION_REPORT_SCHEMA_VERSION
      && hasRequiredFields(assessment, contract.expectedRuntimeHarnessAssessmentShape?.requiredFields || REQUIRED_ASSESSMENT_FIELDS)
      && hasRequiredFields(report, contract.expectedValidationReportShape?.requiredFields || REQUIRED_VALIDATION_REPORT_FIELDS),
    'Runtime harness output shape is incomplete.');

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
    add('forbidden-output-strings-absent', true, null);
  } catch (err) {
    add('forbidden-output-strings-absent', false, err.message);
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
      throw new Error(`runtime_harness_forbidden_substring:${forbidden}`);
    }
  }
}

module.exports = {
  ALLOWED_PER_REQUEST_DECISIONS,
  BASELINE_COMMIT,
  DEPENDENCIES,
  FORBIDDEN_OUTPUT_SUBSTRINGS,
  REQUIRED_ASSESSMENT_FIELDS,
  REQUIRED_BLOCKER_IDS,
  REQUIRED_GATE_IDS,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  RUNTIME_HARNESS_ASSESSMENT_SCHEMA_VERSION,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreRuntimeHarness,
  canonicalAssessmentInput,
  runtimeHarnessIdempotencyKey,
  stableHash,
  validateMiraCoreRuntimeHarnessOutput,
};
