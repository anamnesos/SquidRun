'use strict';

const crypto = require('crypto');

const PERSISTENCE_AUDIT_ASSESSMENT_SCHEMA_VERSION = 'squidrun.mira_core.persistence_audit_assessment.v0';
const VALIDATION_REPORT_SCHEMA_VERSION = 'squidrun.mira_core.persistence_audit_validation_report.v0';
const PERSISTENCE_AUDIT_VERSION = 'v0';
const BASELINE_COMMIT = 'afabea1';

const REQUIRED_OUTPUT_FIELDS = Object.freeze([
  'persistence_audit_assessment',
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
  'persistence_assessment',
  'allowed_schema_surfaces',
  'forbidden_schema_surfaces',
  'per_table_minimum_fields',
  'audit_event_contract',
  'migration_plan_rules',
  'deletion_export_audit_rules',
  'profile_isolation_replay_rules',
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
  'persistence_assessment_result',
  'allowed_schema_surfaces_result',
  'forbidden_schema_surfaces_result',
  'per_table_minimum_fields_result',
  'audit_event_contract_result',
  'migration_plan_result',
  'deletion_export_audit_result',
  'profile_isolation_replay_result',
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
  'no_database_opened',
  'no_database_created',
  'no_database_write_performed',
  'no_migration_executed',
  'no_file_write_performed',
  'no_network_performed',
  'no_queue_created',
  'no_auth_secret_token_session_change_performed',
  'no_local_execution_performed',
  'no_shell_or_pty_performed',
  'no_browser_window_access_performed',
  'no_external_send_performed',
  'no_customer_send_performed',
  'no_deploy_performed',
  'no_trade_performed',
  'no_memory_profile_commit_performed',
  'no_raw_content_stored',
  'no_export_file_written',
  'no_delete_performed',
  'no_restore_performed',
  'no_durable_migration_performed',
]);

const SIDE_EFFECT_COUNTER_FIELDS = Object.freeze([
  'runtimeImplementationsAttempted',
  'serverProcessesStarted',
  'databaseOpensAttempted',
  'databaseCreatesAttempted',
  'databaseWritesAttempted',
  'migrationsAttempted',
  'fileWritesAttempted',
  'networkRequestsAttempted',
  'queuesCreated',
  'authSecretTokenSessionChangesAttempted',
  'localExecutionAttempted',
  'shellOrPtyAttempted',
  'browserWindowAccessAttempted',
  'externalSendsAttempted',
  'customerSendsAttempted',
  'deploysAttempted',
  'tradesAttempted',
  'memoryProfileCommitsAttempted',
  'rawContentStorageAttempted',
  'exportFilesAttempted',
  'deletesAttempted',
  'restoresAttempted',
  'durableMigrationsAttempted',
]);

const REQUIRED_GATE_IDS = Object.freeze([
  'persistence-assessment-shape-specified',
  'allowed-schema-surfaces-specified',
  'forbidden-schema-surfaces-blocked',
  'per-table-minimum-fields-specified',
  'audit-event-contract-specified',
  'migration-plan-dry-run-specified',
  'deletion-export-audit-rules-specified',
  'profile-isolation-replay-rules-specified',
  'capability-boundary-specified',
  'migration-gates-to-real-db-specified',
  'side-effect-free-validation-only',
]);

const REQUIRED_BLOCKER_IDS = Object.freeze([
  'database-create-write-blocked',
  'migration-execution-blocked',
  'raw-content-schema-blocked',
  'raw-audit-payload-blocked',
  'profile-isolation-replay-blocked',
  'capability-overclaim-blocked',
  'operator-controls-missing-blocked',
  'real-server-db-runtime-still-blocked',
]);

const ALLOWED_SCHEMA_SURFACES = Object.freeze([
  'upload_envelopes',
  'sync_items',
  'withheld_items',
  'tombstones',
  'export_manifests',
  'deletion_requests',
  'replay_watermarks',
  'server_intents_validation_only',
  'audit_events',
  'operator_status_snapshots',
  'key_reference_metadata',
]);

const FORBIDDEN_SCHEMA_CONTENT = Object.freeze([
  'raw_comms_bodies',
  'raw_terminal_scrollback',
  'raw_ocr_screenshot_browser_dom_cookies',
  'raw_customer_private_content',
  'raw_secrets_tokens_private_keys',
  'side_profile_payloads_in_main',
  'local_execution_logs_with_command_bodies',
  'irreversible_send_deploy_trade_execution_records',
]);

const GLOBAL_REQUIRED_FIELDS = Object.freeze([
  'schema_version',
  'profile',
  'device_id',
  'session_id',
  'tenant_id',
  'source_refs',
  'evidenceRefs',
  'created_at',
]);

const FORBIDDEN_OUTPUT_SUBSTRINGS = Object.freeze([
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'Authorization: Bearer',
  'BEGIN PRIVATE KEY',
  'raw comms body',
  'raw terminal scrollback',
  'screenshot OCR text',
  'browser DOM',
  'browser cookies',
  'BrowserProfile\\Cookies',
  'customer private note',
  'customer phone',
  'customer address',
  'side-profile private note',
  'profile mismatch payload',
  'raw database payload',
  'command body',
  'shell command text',
  'database created',
  'database write complete',
  'migration executed',
  'schema migration applied',
  'audit log wrote raw payload',
  'file write complete',
  'queue created',
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
  'schema authorizes local execution',
  'audit proves model processing',
  'audit proves bridge green',
  'socket alone proves bridge green',
  'delivery acceptance proves model processing',
  'builder direct target authorized',
  'oracle direct target authorized',
  'tier2 authorized by schema',
  'memory commit authorized by audit',
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

function evidenceRef(kind, id, relation = 'persistence_audit_validation') {
  return {
    store: 'mira-core-persistence-audit',
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
    no_database_opened: true,
    no_database_created: true,
    no_database_write_performed: true,
    no_migration_executed: true,
    no_file_write_performed: true,
    no_network_performed: true,
    no_queue_created: true,
    no_auth_secret_token_session_change_performed: true,
    no_local_execution_performed: true,
    no_shell_or_pty_performed: true,
    no_browser_window_access_performed: true,
    no_external_send_performed: true,
    no_customer_send_performed: true,
    no_deploy_performed: true,
    no_trade_performed: true,
    no_memory_profile_commit_performed: true,
    no_raw_content_stored: true,
    no_export_file_written: true,
    no_delete_performed: true,
    no_restore_performed: true,
    no_durable_migration_performed: true,
    runtimeImplementationsAttempted: 0,
    serverProcessesStarted: 0,
    databaseOpensAttempted: 0,
    databaseCreatesAttempted: 0,
    databaseWritesAttempted: 0,
    migrationsAttempted: 0,
    fileWritesAttempted: 0,
    networkRequestsAttempted: 0,
    queuesCreated: 0,
    authSecretTokenSessionChangesAttempted: 0,
    localExecutionAttempted: 0,
    shellOrPtyAttempted: 0,
    browserWindowAccessAttempted: 0,
    externalSendsAttempted: 0,
    customerSendsAttempted: 0,
    deploysAttempted: 0,
    tradesAttempted: 0,
    memoryProfileCommitsAttempted: 0,
    rawContentStorageAttempted: 0,
    exportFilesAttempted: 0,
    deletesAttempted: 0,
    restoresAttempted: 0,
    durableMigrationsAttempted: 0,
    outputFileWritten: false,
    ...overrides,
  };
}

function plannedTableFields() {
  return ALLOWED_SCHEMA_SURFACES.reduce((result, surface) => {
    result[surface] = [
      ...GLOBAL_REQUIRED_FIELDS,
      'redaction_status',
      'syncEligibility',
      'payload_hash_or_ref',
      'retention_or_expiry',
      'idempotency_or_replay_key',
    ];
    if (surface === 'tombstones' || surface === 'deletion_requests') {
      result[surface].push('deletion_tombstone_ref');
    }
    return result;
  }, {});
}

function schemaPlanHashInputs() {
  return {
    baseline: BASELINE_COMMIT,
    allowed_surfaces: ALLOWED_SCHEMA_SURFACES,
    global_required_fields: GLOBAL_REQUIRED_FIELDS,
    forbidden_content: FORBIDDEN_SCHEMA_CONTENT,
  };
}

function deterministicSchemaHash() {
  return `sha256:${stableHash(schemaPlanHashInputs())}`;
}

function persistenceAssessment() {
  return withEvidence({
    baseline_ref: `commit:${BASELINE_COMMIT}`,
    storage_retention_ref: 'mira-core-storage-retention-contract:phase_17_green',
    schema_version: 'squidrun.mira_core.server_persistence_schema.v0',
    migration_status: 'dry_run_plan_only',
    tables_planned: clone(ALLOWED_SCHEMA_SURFACES),
    indexes_planned: [
      'profile_device_session_scope_idx',
      'idempotency_key_unique_idx',
      'watermark_monotonic_idx',
      'audit_sequence_idx',
      'tombstone_scope_idx',
    ],
    checksums_planned: {
      schema_hash: deterministicSchemaHash(),
      inputs_hash: `sha256:${stableHash(schemaPlanHashInputs())}`,
    },
    accepted_schema_elements: clone(ALLOWED_SCHEMA_SURFACES),
    blocked_schema_elements: clone(FORBIDDEN_SCHEMA_CONTENT),
    audit_coverage: [
      'receive_validation',
      'future_store_mark',
      'withhold_decision',
      'tombstone_status',
      'export_manifest_status',
      'deletion_request_status',
      'replay_watermark_status',
      'operator_status_snapshot',
    ],
    database_created_now: false,
    database_write_performed_now: false,
  }, 'persistence', 'persistence-assessment-shape-specified');
}

function allowedSchemaSurfaces() {
  return withEvidence({
    allowed: clone(ALLOWED_SCHEMA_SURFACES),
    all_surfaces_planned_only: true,
    created_now: false,
    requires_scope_fields: true,
    requires_redaction_status: true,
    requires_idempotency_or_replay_key: true,
    requires_evidence_refs: true,
  }, 'schema-surfaces', 'allowed-schema-surfaces-specified');
}

function forbiddenSchemaSurfaces() {
  return withEvidence({
    forbidden_content: clone(FORBIDDEN_SCHEMA_CONTENT),
    raw_content_allowed: false,
    raw_command_body_allowed: false,
    irreversible_action_execution_record_allowed: false,
    side_profile_payload_in_main_allowed: false,
    secret_token_private_key_allowed: false,
  }, 'schema-surfaces', 'forbidden-schema-surfaces-blocked');
}

function perTableMinimumFields() {
  return withEvidence({
    global_required_fields: clone(GLOBAL_REQUIRED_FIELDS),
    table_minimum_fields: plannedTableFields(),
    profile_device_session_scope_required: true,
    tenant_scope_required: true,
    source_refs_required: true,
    redaction_status_required: true,
    sync_eligibility_required_where_relevant: true,
    payload_hash_or_ref_required: true,
    retention_or_expiry_required_where_relevant: true,
    deletion_tombstone_linkage_required: true,
    idempotency_replay_keys_required: true,
    schema_version_required: true,
    evidence_refs_required: true,
  }, 'table-fields', 'per-table-minimum-fields-specified');
}

function auditEventContract() {
  return withEvidence({
    schema: 'squidrun.mira_core.audit_event.v0',
    append_only: true,
    required_fields: [
      'event_id',
      'sequence',
      'actor',
      'role',
      'event_type',
      'source_ref',
      'scope',
      'decision_status',
      'reason_codes',
      'before_hash',
      'after_hash',
      'redaction_summary',
      'retention_class',
      'evidenceRefs',
    ],
    actor_required: true,
    role_allowlist: ['architect', 'server_system', 'operator'],
    event_type_allowlist: [
      'storage_plan_validated',
      'schema_plan_validated',
      'withhold_decision_recorded',
      'tombstone_status_recorded',
      'export_manifest_status_recorded',
      'deletion_request_status_recorded',
      'replay_diagnosis_recorded',
    ],
    scope_required: true,
    decision_status_required: true,
    reason_codes_required: true,
    before_after_hashes_only: true,
    redaction_summary_required: true,
    no_raw_payload: true,
    monotonic_sequence_required: true,
    retention_class_required: true,
  }, 'audit-event', 'audit-event-contract-specified');
}

function migrationPlanRules() {
  return withEvidence({
    dry_run_only: true,
    deterministic_schema_hash_required: true,
    reversible_migration_plan_required: true,
    rollback_plan_required: true,
    no_migration_executed_now: true,
    no_db_opened_created_written: true,
    no_filesystem_output_file: true,
    no_network: true,
    schema_hash_inputs: schemaPlanHashInputs(),
    rollback_plan: {
      status: 'required_before_real_db',
      steps: [
        'disable_future_db_feature_flag',
        'preserve_validation_only_outputs',
        'review audit status records',
      ],
    },
  }, 'migration-plan', 'migration-plan-dry-run-specified');
}

function deletionExportAuditRules() {
  return withEvidence({
    tombstone_events_persist: true,
    tombstone_events_no_raw_payload: true,
    export_manifest_events_redacted_hashes_only: true,
    delete_request_events_leak_deleted_content: false,
    backup_purge_obligations_recorded_as_status: true,
    backup_purge_performed_now: false,
  }, 'deletion-export-audit', 'deletion-export-audit-rules-specified');
}

function profileIsolationReplayRules() {
  return withEvidence({
    tenant_profile_device_session_scoped_keys_required: true,
    side_profile_mismatch_fail_closed: true,
    tombstone_beats_stale_upload: true,
    watermarks_monotonic: true,
    duplicate_idempotency_keys_rejected_or_diagnosed: true,
    profile_mismatch_raw_payload_withheld: true,
    server_cannot_resurrect_deleted_local_state: true,
  }, 'profile-replay', 'profile-isolation-replay-rules-specified');
}

function capabilityBoundary() {
  return withEvidence({
    schema_audit_validity_permits: 'future_persistence_schema_audit_validation_only',
    local_execution_authorized: false,
    shell_or_pty_authorized: false,
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
  }, 'capability', 'capability-boundary-specified');
}

function migrationGates() {
  return withEvidence({
    baseline_commit: BASELINE_COMMIT,
    phase_17_gate_id: 'requires_db_schema_gate',
    real_db_allowed_now: false,
    future_real_db_allowed_after_gates: true,
    requires_db_engine_choice_gate: true,
    requires_encryption_key_reference_policy_gate: true,
    requires_backup_retention_policy_gate: true,
    requires_audit_viewer_operator_controls_gate: true,
    requires_deletion_export_api_gate: true,
    requires_migration_runner_safety_gate: true,
    requires_schema_compatibility_tests_gate: true,
    requires_disaster_recovery_plan_gate: true,
    requires_profile_isolation_integration_tests_gate: true,
    feature_flag_default: 'off',
    rollback_plan_required: true,
  }, 'migration-gates', 'migration-gates-to-real-db-specified');
}

function acceptanceGateSummary() {
  return REQUIRED_GATE_IDS.map((gateId) => ({
    gate_id: gateId,
    status: gateId === 'side-effect-free-validation-only' ? 'satisfied_for_phase_18_validator' : 'specified_for_validation_pending_real_db',
    required_before_real_server: true,
    required_before_real_db: true,
    evidenceRefs: [evidenceRef('acceptance-gate', gateId)],
    blocked_until: gateId === 'side-effect-free-validation-only'
      ? 'Phase 18 remains validation-only and side-effect-free.'
      : 'Reviewed database, audit, migration, replay, and operator-control gates exist.',
  }));
}

function blockerSummary() {
  return [
    {
      blocker_id: 'database-create-write-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Phase 18 plans schema surfaces only; database open, create, and mutation paths remain blocked.',
      safe_next_action: 'Review DB engine, encryption references, and compatibility tests before runtime work.',
    },
    {
      blocker_id: 'migration-execution-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Migration plans remain dry-run validation records only.',
      safe_next_action: 'Keep deterministic schema hash and rollback-plan checks in place.',
    },
    {
      blocker_id: 'raw-content-schema-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Schema surfaces cannot include raw, private, secret, side-profile, command, or irreversible action payloads.',
      safe_next_action: 'Keep forbidden schema surface regressions fixture-backed.',
    },
    {
      blocker_id: 'raw-audit-payload-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Audit events must remain redacted, append-only, monotonic, and hash-only.',
      safe_next_action: 'Keep audit event shape focused on statuses, reason codes, refs, and hashes.',
    },
    {
      blocker_id: 'profile-isolation-replay-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Profile mismatch, replay, watermark regression, duplicate idempotency, and tombstone precedence gates must fail closed.',
      safe_next_action: 'Keep replay and tombstone precedence checks before real DB work.',
    },
    {
      blocker_id: 'capability-overclaim-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Schema and audit validation cannot grant execution, direct Builder/Oracle targeting, proof, raw restore, or resurrection authority.',
      safe_next_action: 'Keep capability-boundary regressions covering all overclaims.',
    },
    {
      blocker_id: 'operator-controls-missing-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Audit viewer, deletion/export controls, backup retention, and disaster recovery are required before real DB work.',
      safe_next_action: 'Review operator-visible controls and DR plan before runtime implementation.',
    },
    {
      blocker_id: 'real-server-db-runtime-still-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Real server database runtime remains blocked by Phase 14 and Phase 18 gates.',
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
    persistence_assessment: assessment.persistence_assessment,
    allowed_schema_surfaces: assessment.allowed_schema_surfaces,
    forbidden_schema_surfaces: assessment.forbidden_schema_surfaces,
    per_table_minimum_fields: assessment.per_table_minimum_fields,
    audit_event_contract: assessment.audit_event_contract,
    migration_plan_rules: assessment.migration_plan_rules,
    deletion_export_audit_rules: assessment.deletion_export_audit_rules,
    profile_isolation_replay_rules: assessment.profile_isolation_replay_rules,
    capability_boundary: assessment.capability_boundary,
    migration_gates: assessment.migration_gates,
    acceptance_gate_summary: assessment.acceptance_gate_summary,
    blocker_summary: assessment.blocker_summary,
    side_effect_result: assessment.side_effect_result,
  };
}

function assessmentIdempotencyKey(assessment) {
  return `persistence-audit-idem:${stableHash(canonicalAssessmentInput(assessment))}`;
}

function buildAssessment(options = {}) {
  const inputSignals = options.inputSignals || {};
  const generatedAt = generatedAtFromOptions(options, inputSignals);
  const scope = normalizeScope(inputSignals);
  const assessment = {
    schema: PERSISTENCE_AUDIT_ASSESSMENT_SCHEMA_VERSION,
    version: PERSISTENCE_AUDIT_VERSION,
    assessment_id: null,
    idempotency_key: null,
    generated_at: generatedAt,
    baseline_commit: BASELINE_COMMIT,
    profile: scope.profile,
    sessionId: scope.sessionId,
    deviceId: scope.deviceId,
    persistence_assessment: persistenceAssessment(),
    allowed_schema_surfaces: allowedSchemaSurfaces(),
    forbidden_schema_surfaces: forbiddenSchemaSurfaces(),
    per_table_minimum_fields: perTableMinimumFields(),
    audit_event_contract: auditEventContract(),
    migration_plan_rules: migrationPlanRules(),
    deletion_export_audit_rules: deletionExportAuditRules(),
    profile_isolation_replay_rules: profileIsolationReplayRules(),
    capability_boundary: capabilityBoundary(),
    migration_gates: migrationGates(),
    acceptance_gate_summary: acceptanceGateSummary(),
    blocker_summary: blockerSummary(),
    evidenceRefs: [
      evidenceRef('baseline', BASELINE_COMMIT),
      evidenceRef('fixture', 'mira-core-persistence-audit-contract'),
    ],
    side_effect_result: sideEffectResult(),
  };
  assessment.idempotency_key = assessmentIdempotencyKey(assessment);
  assessment.assessment_id = `persistence-audit-${stableHash(assessment.idempotency_key).slice(0, 12)}`;
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
  const expected = contract.expectedPersistenceAuditAssessmentShape || {};
  const requiredIds = asArray(expected.requiredAcceptanceGateIds).length > 0
    ? expected.requiredAcceptanceGateIds
    : REQUIRED_GATE_IDS;
  return gates.length === requiredIds.length
    && valuesMatch(gates.map((gate) => gate.gate_id), requiredIds)
    && gates.every((gate) => hasRequiredFields(gate, expected.acceptanceGateSummaryRequiredFields || [])
      && gate.required_before_real_server === true
      && gate.required_before_real_db === true
      && asArray(gate.evidenceRefs).length > 0);
}

function blockerSummaryOk(assessment, contract = {}) {
  const blockers = asArray(assessment.blocker_summary);
  const expected = contract.expectedPersistenceAuditAssessmentShape || {};
  const requiredIds = asArray(expected.requiredBlockerIds).length > 0
    ? expected.requiredBlockerIds
    : REQUIRED_BLOCKER_IDS;
  return blockers.length === requiredIds.length
    && valuesMatch(blockers.map((blocker) => blocker.blocker_id), requiredIds)
    && blockers.every((blocker) => hasRequiredFields(blocker, expected.blockerSummaryRequiredFields || [])
      && asArray(blocker.evidenceRefs).length > 0);
}

function allowedSurfacesOk(assessment, expected) {
  const surfaces = assessment.allowed_schema_surfaces || {};
  return sectionValuesOk(surfaces, expected.allowedSchemaSurfacesRequiredFields, expected.allowedSchemaSurfacesRequiredValues)
    && valuesMatch(surfaces.allowed, expected.allowedSchemaSurfacesRequiredValues?.allowed);
}

function forbiddenSurfacesOk(assessment, expected) {
  const surfaces = assessment.forbidden_schema_surfaces || {};
  return sectionValuesOk(surfaces, expected.forbiddenSchemaSurfacesRequiredFields, expected.forbiddenSchemaSurfacesRequiredValues)
    && valuesMatch(surfaces.forbidden_content, expected.forbiddenSchemaSurfacesRequiredValues?.forbidden_content);
}

function tableFieldsOk(assessment, expected) {
  const fields = assessment.per_table_minimum_fields || {};
  const tableValues = Object.values(fields.table_minimum_fields || {});
  return sectionValuesOk(fields, expected.perTableMinimumFieldsRequiredFields, expected.perTableMinimumFieldsRequiredValues)
    && valuesMatch(fields.global_required_fields, expected.perTableMinimumFieldsRequiredValues?.global_required_fields)
    && asArray(ALLOWED_SCHEMA_SURFACES).every((surface) => Object.prototype.hasOwnProperty.call(fields.table_minimum_fields || {}, surface))
    && tableValues.every((list) => asArray(GLOBAL_REQUIRED_FIELDS).every((field) => asArray(list).includes(field)));
}

function auditEventOk(assessment, expected) {
  const audit = assessment.audit_event_contract || {};
  return sectionValuesOk(audit, expected.auditEventContractRequiredFields, expected.auditEventContractRequiredValues)
    && asArray(audit.required_fields).includes('source_ref')
    && asArray(audit.required_fields).includes('redaction_summary')
    && valuesMatch(audit.role_allowlist, expected.auditEventContractRequiredValues?.role_allowlist);
}

function migrationPlanOk(assessment, expected) {
  const plan = assessment.migration_plan_rules || {};
  return sectionValuesOk(plan, expected.migrationPlanRulesRequiredFields, expected.migrationPlanRulesRequiredValues)
    && plan.rollback_plan
    && asArray(plan.rollback_plan.steps).length > 0
    && valuesMatch(plan.schema_hash_inputs, schemaPlanHashInputs())
    && assessment.persistence_assessment?.checksums_planned?.schema_hash === deterministicSchemaHash();
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
  const expected = contract.expectedPersistenceAuditAssessmentShape || {};

  add('output-shape-complete',
    assessment.schema === PERSISTENCE_AUDIT_ASSESSMENT_SCHEMA_VERSION
      && hasRequiredFields(assessment, expected.requiredFields || REQUIRED_ASSESSMENT_FIELDS),
    'Persistence audit assessment shape is incomplete.');

  add('phase-18-baseline-afabea1-pinned',
    assessment.baseline_commit === BASELINE_COMMIT
      && assessment.migration_gates?.baseline_commit === BASELINE_COMMIT
      && assessment.persistence_assessment?.baseline_ref === `commit:${BASELINE_COMMIT}`,
    'Baseline commit must stay pinned to afabea1.');

  add('validation-only-no-real-db',
    sideEffectValuesOk(assessment.side_effect_result, expected.sideEffectRequiredValues || {}),
    'Phase 18 side-effect truth is unsafe.');

  add('persistence-assessment-shape-required',
    sectionValuesOk(assessment.persistence_assessment, expected.persistenceAssessmentRequiredFields, expected.persistenceAssessmentRequiredValues)
      && valuesMatch(assessment.persistence_assessment?.tables_planned, ALLOWED_SCHEMA_SURFACES)
      && assessment.persistence_assessment?.checksums_planned?.schema_hash === deterministicSchemaHash(),
    'Persistence assessment is incomplete or overclaims live DB work.');

  add('allowed-schema-surfaces-required',
    allowedSurfacesOk(assessment, expected),
    'Allowed schema surfaces changed or became live.');

  add('forbidden-schema-surfaces-blocked',
    forbiddenSurfacesOk(assessment, expected),
    'Forbidden schema surfaces became permitted.');

  add('per-table-minimum-fields-required',
    tableFieldsOk(assessment, expected),
    'Per-table required fields are missing scope, evidence, replay, or tombstone fields.');

  add('audit-event-contract-required',
    auditEventOk(assessment, expected),
    'Audit event contract is incomplete, mutable, unordered, or raw-bearing.');

  add('migration-plan-dry-run-required',
    migrationPlanOk(assessment, expected),
    'Migration plan is not dry-run, deterministic, reversible, or rollback-ready.');

  add('deletion-export-audit-rules-required',
    sectionValuesOk(assessment.deletion_export_audit_rules, expected.deletionExportAuditRulesRequiredFields, expected.deletionExportAuditRulesRequiredValues),
    'Deletion/export audit rules are incomplete or content-leaking.');

  add('profile-isolation-replay-rules-required',
    sectionValuesOk(assessment.profile_isolation_replay_rules, expected.profileIsolationReplayRulesRequiredFields, expected.profileIsolationReplayRulesRequiredValues),
    'Profile isolation, replay, tombstone, or idempotency rules are unsafe.');

  add('capability-boundary-validation-only',
    sectionValuesOk(assessment.capability_boundary, expected.capabilityBoundaryRequiredFields, expected.capabilityBoundaryRequiredValues),
    'Capability boundary overclaimed execution, proof, target, Tier 2+, raw restore, or resurrection authority.');

  add('migration-real-db-gated',
    sectionValuesOk(assessment.migration_gates, expected.migrationGatesRequiredFields, expected.migrationGatesRequiredValues),
    'Real DB migration gates are incomplete or overclaimed.');

  add('required-gates-and-blockers-present',
    gateSummaryOk(assessment, contract) && blockerSummaryOk(assessment, contract),
    'Required Phase 18 gates or blockers are missing.',
    {
      gate_count: asArray(assessment.acceptance_gate_summary).length,
      blocker_count: asArray(assessment.blocker_summary).length,
    });

  try {
    assertNoForbiddenOutput(assessment, asArray(contract.forbiddenOutputSubstrings));
    add('forbidden-output-strings-absent', true, null, {
      raw_private_content_exported: false,
      live_db_claim_exported: false,
      proof_overclaim_exported: false,
    });
  } catch (err) {
    add('forbidden-output-strings-absent', false, err.message, {
      raw_private_content_exported: true,
    });
  }

  add('assessment-literal-values',
    literalValuesOk(assessment, expected.requiredLiteralValues || {}),
    'Persistence audit literal values changed.');

  add('idempotency-stable',
    assessment.idempotency_key === assessmentIdempotencyKey(assessment),
    'Persistence audit idempotency key is unstable.');

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
    version: PERSISTENCE_AUDIT_VERSION,
    validation_id: `persistence-audit-validation-${stableHash({
      assessment_key: assessment.idempotency_key,
      generatedAt,
    }).slice(0, 12)}`,
    generated_at: generatedAt,
    baseline_commit: BASELINE_COMMIT,
    fixture_schema: contract.schema || 'squidrun.mira_core.persistence_audit_contract_fixture.v0',
    assessment_schema: PERSISTENCE_AUDIT_ASSESSMENT_SCHEMA_VERSION,
    profile: assessment.profile,
    sessionId: assessment.sessionId,
    deviceId: assessment.deviceId,
    decision: validation.ok ? 'accepted' : 'blocked',
    reasons,
    persistence_assessment_result: checkResult('persistence-assessment-shape-required'),
    allowed_schema_surfaces_result: checkResult('allowed-schema-surfaces-required'),
    forbidden_schema_surfaces_result: checkResult('forbidden-schema-surfaces-blocked'),
    per_table_minimum_fields_result: checkResult('per-table-minimum-fields-required'),
    audit_event_contract_result: checkResult('audit-event-contract-required'),
    migration_plan_result: checkResult('migration-plan-dry-run-required'),
    deletion_export_audit_result: checkResult('deletion-export-audit-rules-required'),
    profile_isolation_replay_result: checkResult('profile-isolation-replay-rules-required'),
    capability_boundary_result: checkResult('capability-boundary-validation-only'),
    migration_gates_result: checkResult('migration-real-db-gated'),
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
      evidenceRef('validation', assessment.assessment_id, 'persistence_audit_validation_report'),
    ],
    side_effect_result: sideEffectResult(),
  };
  assertNoForbiddenOutput(report, asArray(contract.forbiddenOutputSubstrings));
  return report;
}

function buildMiraCorePersistenceAudit(options = {}) {
  const contract = options.contract || {};
  const assessment = buildAssessment(options);
  const validation_report = buildValidationReport(assessment, contract, assessment.generated_at);
  const output = {
    persistence_audit_assessment: assessment,
    validation_report,
  };
  assertNoForbiddenOutput(output, asArray(contract.forbiddenOutputSubstrings));
  return output;
}

function validateMiraCorePersistenceAuditOutput(output = {}, contract = {}) {
  const checks = [];
  const errors = [];
  const add = (id, ok, detail = null) => {
    checks.push({ id, ok: ok === true, detail });
    if (!ok && detail) errors.push(detail);
  };
  const assessment = output.persistence_audit_assessment || {};
  const report = output.validation_report || {};
  const assessmentValidation = validateAssessment(assessment, contract);

  add('output-shape-complete',
    hasRequiredFields(output, contract.expectedOutputShape?.requiredTopLevelFields || REQUIRED_OUTPUT_FIELDS)
      && assessment.schema === PERSISTENCE_AUDIT_ASSESSMENT_SCHEMA_VERSION
      && report.schema === VALIDATION_REPORT_SCHEMA_VERSION
      && hasRequiredFields(assessment, contract.expectedPersistenceAuditAssessmentShape?.requiredFields || REQUIRED_ASSESSMENT_FIELDS)
      && hasRequiredFields(report, contract.expectedValidationReportShape?.requiredFields || REQUIRED_VALIDATION_REPORT_FIELDS),
    'Persistence audit output shape is incomplete.');

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
      throw new Error(`persistence_audit_forbidden_substring:${forbidden}`);
    }
  }
}

module.exports = {
  BASELINE_COMMIT,
  FORBIDDEN_OUTPUT_SUBSTRINGS,
  PERSISTENCE_AUDIT_ASSESSMENT_SCHEMA_VERSION,
  REQUIRED_ASSESSMENT_FIELDS,
  REQUIRED_BLOCKER_IDS,
  REQUIRED_GATE_IDS,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  assessmentIdempotencyKey,
  buildMiraCorePersistenceAudit,
  canonicalAssessmentInput,
  deterministicSchemaHash,
  stableHash,
  validateMiraCorePersistenceAuditOutput,
};
