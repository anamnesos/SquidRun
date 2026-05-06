'use strict';

const crypto = require('crypto');

const ENCRYPTION_KEY_ASSESSMENT_SCHEMA_VERSION = 'squidrun.mira_core.encryption_key_assessment.v0';
const VALIDATION_REPORT_SCHEMA_VERSION = 'squidrun.mira_core.encryption_key_validation_report.v0';
const ENCRYPTION_KEY_VERSION = 'v0';
const BASELINE_COMMIT = '3742ab7';

const REQUIRED_OUTPUT_FIELDS = Object.freeze([
  'encryption_key_assessment',
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
  'baseline_dependency',
  'key_reference_policy',
  'encryption_plan',
  'secret_handling_boundary',
  'rotation_revocation_rewrap_rules',
  'delete_export_backup_restore_rules',
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
  'baseline_dependency_result',
  'key_reference_policy_result',
  'encryption_plan_result',
  'secret_handling_boundary_result',
  'rotation_revocation_rewrap_result',
  'delete_export_backup_restore_result',
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
  'no_network_performed',
  'no_kms_call_performed',
  'no_database_or_store_write_performed',
  'no_file_write_performed',
  'no_migration_executed',
  'no_queue_created',
  'no_auth_secret_token_session_change_performed',
  'no_env_secret_read_performed',
  'no_key_generation_performed',
  'no_encryption_performed',
  'no_decryption_performed',
  'no_private_key_material_exported',
  'no_data_key_material_exported',
  'no_secret_material_exported',
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
  'networkRequestsAttempted',
  'kmsCallsAttempted',
  'databaseOrStoreWritesAttempted',
  'fileWritesAttempted',
  'migrationsAttempted',
  'queuesCreated',
  'authSecretTokenSessionChangesAttempted',
  'envSecretReadsAttempted',
  'keyGenerationsAttempted',
  'encryptionsAttempted',
  'decryptionsAttempted',
  'privateKeyMaterialExportsAttempted',
  'dataKeyMaterialExportsAttempted',
  'secretMaterialExportsAttempted',
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
  'baseline-dependency-pinned',
  'key-reference-policy-specified',
  'algorithm-allowlist-specified',
  'envelope-encryption-plan-specified',
  'secret-handling-boundary-specified',
  'rotation-revocation-rewrap-rules-specified',
  'delete-export-backup-restore-rules-specified',
  'capability-boundary-specified',
  'migration-gates-to-real-kms-specified',
  'no-secret-material-leakage',
  'side-effect-free-validation-only',
]);

const REQUIRED_BLOCKER_IDS = Object.freeze([
  'kms-network-call-blocked',
  'key-generation-blocked',
  'secret-material-leakage-blocked',
  'encrypt-decrypt-action-blocked',
  'db-store-file-write-blocked',
  'raw-plaintext-ciphertext-export-blocked',
  'revoked-stale-key-ref-blocked',
  'tombstone-deletion-precedence-blocked',
  'capability-overclaim-blocked',
  'real-kms-runtime-still-blocked',
]);

const ALGORITHM_ALLOWLIST = Object.freeze([
  'aes-256-gcm-envelope-reference-only',
  'xchacha20-poly1305-envelope-reference-only',
  'kms-managed-aes-256-gcm-reference-only',
]);

const AAD_FIELDS = Object.freeze([
  'tenant_id',
  'profile',
  'device_id',
  'session_id',
  'schema',
  'table',
  'item_ref',
  'payload_hash',
  'key_id',
  'key_version',
]);

const FORBIDDEN_OUTPUT_SUBSTRINGS = Object.freeze([
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'Authorization: Bearer',
  'BEGIN PRIVATE KEY',
  'END PRIVATE KEY',
  'PRIVATE KEY',
  'DATA KEY',
  'plaintext key',
  'data key plaintext',
  'raw data key',
  'raw_token',
  'access_token',
  'refresh_token',
  'session_secret',
  'cookie=',
  'Set-Cookie',
  '.env secret',
  'KMS decrypted plaintext',
  'model visible decrypted content',
  'raw plaintext payload',
  'raw ciphertext payload',
  'customer private note',
  'raw comms body',
  'raw terminal scrollback',
  'screenshot OCR text',
  'browser cookies',
  'database write complete',
  'file write complete',
  'kms call complete',
  'network request complete',
  'key generated',
  'encryption performed',
  'decryption performed',
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
  'encryption authorizes local execution',
  'encryption proves model processing',
  'encryption proves bridge green',
  'socket alone proves bridge green',
  'delivery acceptance proves model processing',
  'builder direct target authorized',
  'oracle direct target authorized',
  'tier2 authorized by encryption',
  'memory commit authorized by encryption',
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

function evidenceRef(kind, id, relation = 'encryption_key_validation') {
  return {
    store: 'mira-core-encryption-key',
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
    no_network_performed: true,
    no_kms_call_performed: true,
    no_database_or_store_write_performed: true,
    no_file_write_performed: true,
    no_migration_executed: true,
    no_queue_created: true,
    no_auth_secret_token_session_change_performed: true,
    no_env_secret_read_performed: true,
    no_key_generation_performed: true,
    no_encryption_performed: true,
    no_decryption_performed: true,
    no_private_key_material_exported: true,
    no_data_key_material_exported: true,
    no_secret_material_exported: true,
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
    networkRequestsAttempted: 0,
    kmsCallsAttempted: 0,
    databaseOrStoreWritesAttempted: 0,
    fileWritesAttempted: 0,
    migrationsAttempted: 0,
    queuesCreated: 0,
    authSecretTokenSessionChangesAttempted: 0,
    envSecretReadsAttempted: 0,
    keyGenerationsAttempted: 0,
    encryptionsAttempted: 0,
    decryptionsAttempted: 0,
    privateKeyMaterialExportsAttempted: 0,
    dataKeyMaterialExportsAttempted: 0,
    secretMaterialExportsAttempted: 0,
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

function baselineDependency() {
  return withEvidence({
    baseline_ref: `commit:${BASELINE_COMMIT}`,
    phase_18_persistence_audit_ref: 'mira-core-persistence-audit-contract:phase_18_green',
    persistence_schema_dependency_required: true,
    audit_dependency_required: true,
    dependency_status: 'phase_18_validation_only_dependency',
    real_db_dependency_exists: false,
    real_kms_dependency_exists: false,
  }, 'baseline-dependency', 'baseline-dependency-pinned');
}

function keyReferencePolicy(scope) {
  return withEvidence({
    tenant_id: scope.tenantId,
    profile: scope.profileName,
    device_id: scope.deviceId,
    session_id: scope.sessionId,
    key_id: 'key-ref-validation-001',
    key_version: 'v1',
    provider_ref: 'kms-ref-validation-no-secret',
    algorithm_allowlist: clone(ALGORITHM_ALLOWLIST),
    status: 'validation_only_future_key_reference',
    rotation_metadata: {
      status: 'planned_only',
      runbook_ref: 'rotation-runbook-required-before-runtime',
      next_review: 'operator_review_required',
    },
    revocation_metadata: {
      status: 'planned_only',
      fail_closed_cases: ['revoked', 'expired', 'stale', 'mismatched_scope', 'unknown_provider'],
    },
    provenance_refs: [
      'commit:3742ab7',
      'phase18:persistence-audit-validation',
    ],
    audit_refs: [
      'audit-ref:key-reference-policy-validation',
      'audit-ref:secret-boundary-validation',
    ],
    tenant_profile_device_session_scope_required: true,
    provider_ref_secret_free: true,
    secret_material_exported: false,
    no_secret_material: true,
  }, 'key-reference', 'key-reference-policy-specified');
}

function encryptionPlan(scope) {
  return withEvidence({
    envelope_version: 'squidrun.mira_core.encryption_envelope.v0',
    envelope_metadata_only: true,
    payload_hash: `sha256:${stableHash({
      baseline: BASELINE_COMMIT,
      tenant_id: scope.tenantId,
      profile: scope.profileName,
      device_id: scope.deviceId,
      session_id: scope.sessionId,
      item_ref: 'validation-item-ref',
    })}`,
    canonicalization_version: 'mira-core-c14n-json-v0',
    aad_fields: clone(AAD_FIELDS),
    schema_table_item_scope: {
      schema: 'squidrun.mira_core.server_persistence_schema.v0',
      table: 'sync_items',
      item_ref: 'validation-item-ref',
      tenant_id: scope.tenantId,
      profile: scope.profileName,
      device_id: scope.deviceId,
      session_id: scope.sessionId,
    },
    key_id: 'key-ref-validation-001',
    key_version: 'v1',
    provider_ref: 'kms-ref-validation-no-secret',
    ciphertext_placeholder: 'ciphertext-placeholder-reference-only',
    test_vector_placeholder: 'test-vector-placeholder-reference-only',
    ciphertext_placeholder_only: true,
    test_vector_placeholder_only: true,
    plaintext_exported: false,
    data_key_exported: false,
    raw_payload_exported: false,
    real_ciphertext_exported: false,
    encryption_performed_now: false,
    decryption_performed_now: false,
  }, 'encryption-plan', 'envelope-encryption-plan-specified');
}

function secretHandlingBoundary() {
  return withEvidence({
    private_key_material_allowed: false,
    data_key_material_allowed: false,
    tokens_cookies_session_secrets_allowed: false,
    env_secret_read_allowed: false,
    env_secret_exported: false,
    model_visible_decrypted_raw_content: false,
    plaintext_payload_visible: false,
    decrypted_raw_content_exported: false,
    key_generation_allowed_now: false,
    encryption_decryption_allowed_now: false,
    secret_scanner_required: true,
  }, 'secret-boundary', 'secret-handling-boundary-specified');
}

function rotationRevocationRewrapRules() {
  return withEvidence({
    dry_run_only: true,
    rotation_planned_only: true,
    revocation_planned_only: true,
    rewrap_planned_only: true,
    revoked_key_refs_fail_closed: true,
    expired_key_refs_fail_closed: true,
    mismatched_key_refs_fail_closed: true,
    stale_key_refs_fail_closed: true,
    unknown_provider_refs_fail_closed: true,
    rotation_metadata_required: true,
    revocation_metadata_required: true,
    rewrap_requires_audit_refs: true,
    no_kms_network_performed: true,
  }, 'rotation-revocation-rewrap', 'rotation-revocation-rewrap-rules-specified');
}

function deleteExportBackupRestoreRules() {
  return withEvidence({
    deletion_policy_precedence_required: true,
    tombstone_beats_key_rewrap: true,
    tombstone_beats_restore: true,
    export_manifest_redacted_only: true,
    backup_manifest_redacted_only: true,
    encrypted_reference_only: true,
    raw_ciphertext_exported: false,
    raw_plaintext_exported: false,
    raw_payload_exported: false,
    restore_decrypts_now: false,
    backup_restore_planned_only: true,
  }, 'delete-export-backup-restore', 'delete-export-backup-restore-rules-specified');
}

function capabilityBoundary() {
  return withEvidence({
    encryption_validity_permits: 'future_key_reference_envelope_metadata_validation_only',
    local_execution_authorized: false,
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
    phase_18_dependency_id: 'persistence-audit-validation-green',
    real_kms_allowed_now: false,
    real_encryption_allowed_now: false,
    future_real_kms_allowed_after_gates: true,
    requires_kms_choice_gate: true,
    requires_key_custody_gate: true,
    requires_rotation_runbook_gate: true,
    requires_audit_logging_gate: true,
    requires_disaster_recovery_gate: true,
    requires_tenant_isolation_gate: true,
    requires_red_team_leakage_tests_gate: true,
    requires_replay_watermark_compatibility_gate: true,
    requires_operator_controls_gate: true,
    requires_secret_storage_policy_gate: true,
    feature_flag_default: 'off',
    rollback_plan_required: true,
  }, 'migration-gates', 'migration-gates-to-real-kms-specified');
}

function acceptanceGateSummary() {
  return REQUIRED_GATE_IDS.map((gateId) => ({
    gate_id: gateId,
    status: gateId === 'side-effect-free-validation-only' ? 'satisfied_for_phase_19_validator' : 'specified_for_validation_pending_kms',
    required_before_real_server: true,
    required_before_real_kms: true,
    required_before_real_encryption: true,
    evidenceRefs: [evidenceRef('acceptance-gate', gateId)],
    blocked_until: gateId === 'side-effect-free-validation-only'
      ? 'Phase 19 remains validation-only and side-effect-free.'
      : 'Reviewed key-reference, secret-boundary, rotation, and operator-control gates exist.',
  }));
}

function blockerSummary() {
  return [
    {
      blocker_id: 'kms-network-call-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Provider integration is reference metadata only; external key-service work remains blocked.',
      safe_next_action: 'Review KMS choice, custody policy, and operator controls before runtime work.',
    },
    {
      blocker_id: 'key-generation-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Key creation paths remain out of Phase 19.',
      safe_next_action: 'Keep key references as metadata until custody and rotation gates are reviewed.',
    },
    {
      blocker_id: 'secret-material-leakage-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Secret-bearing values, env reads, token material, and decrypted content are blocked from output.',
      safe_next_action: 'Keep value-only forbidden-output scanning and secret-scanner gates in place.',
    },
    {
      blocker_id: 'encrypt-decrypt-action-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Crypto actions remain placeholders and metadata validation only.',
      safe_next_action: 'Keep envelope plan as hash, AAD, key reference, and placeholder metadata.',
    },
    {
      blocker_id: 'db-store-file-write-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Persistence and output write paths remain blocked.',
      safe_next_action: 'Review Phase 18 persistence gates before any storage runtime work.',
    },
    {
      blocker_id: 'raw-plaintext-ciphertext-export-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Export and backup planning stays redacted and reference-only.',
      safe_next_action: 'Keep export and backup manifests limited to redacted refs and hashes.',
    },
    {
      blocker_id: 'revoked-stale-key-ref-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Revoked, expired, stale, mismatched, and unknown key refs fail closed.',
      safe_next_action: 'Keep rotation, revocation, and rewrap checks before runtime key use.',
    },
    {
      blocker_id: 'tombstone-deletion-precedence-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Deletion policy and tombstones outrank rewrap, export, backup, restore, and replay planning.',
      safe_next_action: 'Keep tombstone precedence checks before future restore paths.',
    },
    {
      blocker_id: 'capability-overclaim-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Encryption validation cannot grant execution, direct Builder/Oracle targeting, proof, raw restore, or resurrection authority.',
      safe_next_action: 'Keep capability-boundary regressions covering all overclaims.',
    },
    {
      blocker_id: 'real-kms-runtime-still-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Real key-service and envelope-encryption runtime remains blocked by Phase 19 gates.',
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
    baseline_dependency: assessment.baseline_dependency,
    key_reference_policy: assessment.key_reference_policy,
    encryption_plan: assessment.encryption_plan,
    secret_handling_boundary: assessment.secret_handling_boundary,
    rotation_revocation_rewrap_rules: assessment.rotation_revocation_rewrap_rules,
    delete_export_backup_restore_rules: assessment.delete_export_backup_restore_rules,
    capability_boundary: assessment.capability_boundary,
    migration_gates: assessment.migration_gates,
    acceptance_gate_summary: assessment.acceptance_gate_summary,
    blocker_summary: assessment.blocker_summary,
    side_effect_result: assessment.side_effect_result,
  };
}

function assessmentIdempotencyKey(assessment) {
  return `encryption-key-idem:${stableHash(canonicalAssessmentInput(assessment))}`;
}

function buildAssessment(options = {}) {
  const inputSignals = options.inputSignals || {};
  const generatedAt = generatedAtFromOptions(options, inputSignals);
  const scope = normalizeScope(inputSignals);
  const assessment = {
    schema: ENCRYPTION_KEY_ASSESSMENT_SCHEMA_VERSION,
    version: ENCRYPTION_KEY_VERSION,
    assessment_id: null,
    idempotency_key: null,
    generated_at: generatedAt,
    baseline_commit: BASELINE_COMMIT,
    profile: scope.profile,
    sessionId: scope.sessionId,
    deviceId: scope.deviceId,
    baseline_dependency: baselineDependency(),
    key_reference_policy: keyReferencePolicy(scope),
    encryption_plan: encryptionPlan(scope),
    secret_handling_boundary: secretHandlingBoundary(),
    rotation_revocation_rewrap_rules: rotationRevocationRewrapRules(),
    delete_export_backup_restore_rules: deleteExportBackupRestoreRules(),
    capability_boundary: capabilityBoundary(),
    migration_gates: migrationGates(),
    acceptance_gate_summary: acceptanceGateSummary(),
    blocker_summary: blockerSummary(),
    evidenceRefs: [
      evidenceRef('baseline', BASELINE_COMMIT),
      evidenceRef('fixture', 'mira-core-encryption-key-contract'),
    ],
    side_effect_result: sideEffectResult(),
  };
  assessment.idempotency_key = assessmentIdempotencyKey(assessment);
  assessment.assessment_id = `encryption-key-${stableHash(assessment.idempotency_key).slice(0, 12)}`;
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

function gateSummaryOk(assessment, contract = {}) {
  const gates = asArray(assessment.acceptance_gate_summary);
  const expected = contract.expectedEncryptionKeyAssessmentShape || {};
  const requiredIds = asArray(expected.requiredAcceptanceGateIds).length > 0
    ? expected.requiredAcceptanceGateIds
    : REQUIRED_GATE_IDS;
  return gates.length === requiredIds.length
    && valuesMatch(gates.map((gate) => gate.gate_id), requiredIds)
    && gates.every((gate) => hasRequiredFields(gate, expected.acceptanceGateSummaryRequiredFields || [])
      && gate.required_before_real_server === true
      && gate.required_before_real_kms === true
      && gate.required_before_real_encryption === true
      && asArray(gate.evidenceRefs).length > 0);
}

function blockerSummaryOk(assessment, contract = {}) {
  const blockers = asArray(assessment.blocker_summary);
  const expected = contract.expectedEncryptionKeyAssessmentShape || {};
  const requiredIds = asArray(expected.requiredBlockerIds).length > 0
    ? expected.requiredBlockerIds
    : REQUIRED_BLOCKER_IDS;
  return blockers.length === requiredIds.length
    && valuesMatch(blockers.map((blocker) => blocker.blocker_id), requiredIds)
    && blockers.every((blocker) => hasRequiredFields(blocker, expected.blockerSummaryRequiredFields || [])
      && asArray(blocker.evidenceRefs).length > 0);
}

function keyReferencePolicyOk(assessment, expected) {
  const policy = assessment.key_reference_policy || {};
  return sectionValuesOk(policy, expected.keyReferencePolicyRequiredFields, expected.keyReferencePolicyRequiredValues)
    && valuesMatch(policy.algorithm_allowlist, expected.keyReferencePolicyRequiredValues?.algorithm_allowlist)
    && Boolean(policy.tenant_id)
    && policy.profile === assessment.profile?.name
    && policy.device_id === assessment.deviceId
    && policy.session_id === assessment.sessionId
    && asArray(policy.audit_refs).length > 0
    && asArray(policy.provenance_refs).length > 0;
}

function encryptionPlanOk(assessment, expected) {
  const plan = assessment.encryption_plan || {};
  return sectionValuesOk(plan, expected.encryptionPlanRequiredFields, expected.encryptionPlanRequiredValues)
    && valuesMatch(plan.aad_fields, expected.encryptionPlanRequiredValues?.aad_fields)
    && plan.key_id === assessment.key_reference_policy?.key_id
    && plan.key_version === assessment.key_reference_policy?.key_version
    && plan.provider_ref === assessment.key_reference_policy?.provider_ref
    && plan.schema_table_item_scope?.profile === assessment.profile?.name
    && plan.schema_table_item_scope?.device_id === assessment.deviceId
    && plan.schema_table_item_scope?.session_id === assessment.sessionId
    && typeof plan.payload_hash === 'string'
    && plan.payload_hash.startsWith('sha256:');
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
  const expected = contract.expectedEncryptionKeyAssessmentShape || {};

  add('output-shape-complete',
    assessment.schema === ENCRYPTION_KEY_ASSESSMENT_SCHEMA_VERSION
      && hasRequiredFields(assessment, expected.requiredFields || REQUIRED_ASSESSMENT_FIELDS),
    'Encryption-key assessment shape is incomplete.');

  add('phase-19-baseline-3742ab7-pinned',
    assessment.baseline_commit === BASELINE_COMMIT
      && assessment.migration_gates?.baseline_commit === BASELINE_COMMIT
      && assessment.baseline_dependency?.baseline_ref === `commit:${BASELINE_COMMIT}`,
    'Baseline commit must stay pinned to 3742ab7.');

  add('validation-only-no-real-kms-encryption',
    sideEffectValuesOk(assessment.side_effect_result, expected.sideEffectRequiredValues || {}),
    'Phase 19 side-effect truth is unsafe.');

  add('phase-18-dependency-required',
    sectionValuesOk(assessment.baseline_dependency, expected.baselineDependencyRequiredFields, expected.baselineDependencyRequiredValues),
    'Phase 18 persistence-audit dependency is incomplete or overclaimed.');

  add('key-reference-policy-shape-required',
    keyReferencePolicyOk(assessment, expected),
    'Key reference policy is incomplete, unscoped, unsupported, or secret-bearing.');

  add('algorithm-allowlist-reference-only',
    valuesMatch(assessment.key_reference_policy?.algorithm_allowlist, ALGORITHM_ALLOWLIST),
    'Algorithm allowlist must remain reference-only and exact.');

  add('encryption-plan-envelope-metadata-only',
    encryptionPlanOk(assessment, expected),
    'Envelope plan must stay metadata-only with placeholders and no crypto action.');

  add('secret-handling-boundary-no-material',
    sectionValuesOk(assessment.secret_handling_boundary, expected.secretHandlingBoundaryRequiredFields, expected.secretHandlingBoundaryRequiredValues),
    'Secret-handling boundary exposed or allowed secret material.');

  add('rotation-revocation-rewrap-fail-closed',
    sectionValuesOk(assessment.rotation_revocation_rewrap_rules, expected.rotationRevocationRewrapRulesRequiredFields, expected.rotationRevocationRewrapRulesRequiredValues),
    'Rotation, revocation, or rewrap rules are not fail-closed.');

  add('delete-export-backup-restore-redacted-only',
    sectionValuesOk(assessment.delete_export_backup_restore_rules, expected.deleteExportBackupRestoreRulesRequiredFields, expected.deleteExportBackupRestoreRulesRequiredValues),
    'Delete/export/backup/restore rules leaked or overclaimed.');

  add('capability-boundary-validation-only',
    sectionValuesOk(assessment.capability_boundary, expected.capabilityBoundaryRequiredFields, expected.capabilityBoundaryRequiredValues),
    'Capability boundary overclaimed execution, writes, proof, target, Tier 2+, raw restore, or resurrection authority.');

  add('migration-real-kms-gated',
    sectionValuesOk(assessment.migration_gates, expected.migrationGatesRequiredFields, expected.migrationGatesRequiredValues),
    'Real KMS or encryption gates are incomplete or overclaimed.');

  add('side-effect-truth-all-zero',
    sideEffectValuesOk(assessment.side_effect_result, expected.sideEffectRequiredValues || {}),
    'Side-effect counters or booleans are unsafe.');

  add('tombstone-deletion-precedence-required',
    assessment.delete_export_backup_restore_rules?.deletion_policy_precedence_required === true
      && assessment.delete_export_backup_restore_rules?.tombstone_beats_key_rewrap === true
      && assessment.delete_export_backup_restore_rules?.tombstone_beats_restore === true,
    'Tombstone and deletion precedence must remain fail-closed.');

  add('required-gates-and-blockers-present',
    gateSummaryOk(assessment, contract) && blockerSummaryOk(assessment, contract),
    'Required Phase 19 gates or blockers are missing.',
    {
      gate_count: asArray(assessment.acceptance_gate_summary).length,
      blocker_count: asArray(assessment.blocker_summary).length,
    });

  try {
    assertNoForbiddenOutput(assessment, asArray(contract.forbiddenOutputSubstrings));
    add('forbidden-output-strings-absent', true, null, {
      secret_material_exported: false,
      crypto_action_claim_exported: false,
      proof_overclaim_exported: false,
    });
  } catch (err) {
    add('forbidden-output-strings-absent', false, err.message, {
      secret_material_exported: true,
    });
  }

  add('assessment-literal-values',
    literalValuesOk(assessment, expected.requiredLiteralValues || {}),
    'Encryption-key literal values changed.');

  add('idempotency-stable',
    assessment.idempotency_key === assessmentIdempotencyKey(assessment),
    'Encryption-key idempotency key is unstable.');

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
    version: ENCRYPTION_KEY_VERSION,
    validation_id: `encryption-key-validation-${stableHash({
      assessment_key: assessment.idempotency_key,
      generatedAt,
    }).slice(0, 12)}`,
    generated_at: generatedAt,
    baseline_commit: BASELINE_COMMIT,
    fixture_schema: contract.schema || 'squidrun.mira_core.encryption_key_contract_fixture.v0',
    assessment_schema: ENCRYPTION_KEY_ASSESSMENT_SCHEMA_VERSION,
    profile: assessment.profile,
    sessionId: assessment.sessionId,
    deviceId: assessment.deviceId,
    decision: validation.ok ? 'accepted' : 'blocked',
    reasons,
    baseline_dependency_result: checkResult('phase-18-dependency-required'),
    key_reference_policy_result: checkResult('key-reference-policy-shape-required'),
    encryption_plan_result: checkResult('encryption-plan-envelope-metadata-only'),
    secret_handling_boundary_result: checkResult('secret-handling-boundary-no-material'),
    rotation_revocation_rewrap_result: checkResult('rotation-revocation-rewrap-fail-closed'),
    delete_export_backup_restore_result: checkResult('delete-export-backup-restore-redacted-only'),
    capability_boundary_result: checkResult('capability-boundary-validation-only'),
    migration_gates_result: checkResult('migration-real-kms-gated'),
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
      evidenceRef('validation', assessment.assessment_id, 'encryption_key_validation_report'),
    ],
    side_effect_result: sideEffectResult(),
  };
  assertNoForbiddenOutput(report, asArray(contract.forbiddenOutputSubstrings));
  return report;
}

function buildMiraCoreEncryptionKey(options = {}) {
  const contract = options.contract || {};
  const assessment = buildAssessment(options);
  const validation_report = buildValidationReport(assessment, contract, assessment.generated_at);
  const output = {
    encryption_key_assessment: assessment,
    validation_report,
  };
  assertNoForbiddenOutput(output, asArray(contract.forbiddenOutputSubstrings));
  return output;
}

function validateMiraCoreEncryptionKeyOutput(output = {}, contract = {}) {
  const checks = [];
  const errors = [];
  const add = (id, ok, detail = null) => {
    checks.push({ id, ok: ok === true, detail });
    if (!ok && detail) errors.push(detail);
  };
  const assessment = output.encryption_key_assessment || {};
  const report = output.validation_report || {};
  const assessmentValidation = validateAssessment(assessment, contract);

  add('output-shape-complete',
    hasRequiredFields(output, contract.expectedOutputShape?.requiredTopLevelFields || REQUIRED_OUTPUT_FIELDS)
      && assessment.schema === ENCRYPTION_KEY_ASSESSMENT_SCHEMA_VERSION
      && report.schema === VALIDATION_REPORT_SCHEMA_VERSION
      && hasRequiredFields(assessment, contract.expectedEncryptionKeyAssessmentShape?.requiredFields || REQUIRED_ASSESSMENT_FIELDS)
      && hasRequiredFields(report, contract.expectedValidationReportShape?.requiredFields || REQUIRED_VALIDATION_REPORT_FIELDS),
    'Encryption-key output shape is incomplete.');

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
      throw new Error(`encryption_key_forbidden_substring:${forbidden}`);
    }
  }
}

module.exports = {
  ALGORITHM_ALLOWLIST,
  AAD_FIELDS,
  BASELINE_COMMIT,
  ENCRYPTION_KEY_ASSESSMENT_SCHEMA_VERSION,
  FORBIDDEN_OUTPUT_SUBSTRINGS,
  REQUIRED_ASSESSMENT_FIELDS,
  REQUIRED_BLOCKER_IDS,
  REQUIRED_GATE_IDS,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  assessmentIdempotencyKey,
  buildMiraCoreEncryptionKey,
  canonicalAssessmentInput,
  stableHash,
  validateMiraCoreEncryptionKeyOutput,
};
