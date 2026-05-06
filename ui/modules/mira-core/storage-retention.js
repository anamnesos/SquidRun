'use strict';

const crypto = require('crypto');

const STORAGE_RETENTION_ASSESSMENT_SCHEMA_VERSION = 'squidrun.mira_core.storage_retention_assessment.v0';
const VALIDATION_REPORT_SCHEMA_VERSION = 'squidrun.mira_core.storage_retention_validation_report.v0';
const STORAGE_RETENTION_VERSION = 'v0';
const BASELINE_COMMIT = '6f97287';

const REQUIRED_OUTPUT_FIELDS = Object.freeze([
  'storage_retention_assessment',
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
  'storage_assessment_plan',
  'allowed_storage_classes',
  'item_storage_eligibility',
  'retention_rules',
  'deletion_rules',
  'export_rules',
  'restore_replay_rules',
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
  'storage_plan_result',
  'allowed_classes_result',
  'item_eligibility_result',
  'retention_result',
  'deletion_result',
  'export_result',
  'restore_replay_result',
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
  'no_database_write_performed',
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
  'no_export_file_written',
  'no_delete_performed',
  'no_restore_performed',
  'no_raw_content_stored',
  'no_durable_migration_performed',
]);

const SIDE_EFFECT_COUNTER_FIELDS = Object.freeze([
  'runtimeImplementationsAttempted',
  'serverProcessesStarted',
  'databaseWritesAttempted',
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
  'exportFilesAttempted',
  'deletesAttempted',
  'restoresAttempted',
  'rawContentStorageAttempted',
  'durableMigrationsAttempted',
]);

const REQUIRED_GATE_IDS = Object.freeze([
  'storage-assessment-plan-shape-specified',
  'allowed-storage-classes-specified',
  'item-storage-eligibility-specified',
  'retention-rules-specified',
  'deletion-rules-specified',
  'export-rules-specified',
  'restore-replay-rules-specified',
  'capability-boundary-specified',
  'migration-gates-to-real-storage-specified',
  'side-effect-free-validation-only',
]);

const REQUIRED_BLOCKER_IDS = Object.freeze([
  'database-write-blocked',
  'file-export-write-blocked',
  'raw-content-storage-blocked',
  'profile-mismatch-storage-blocked',
  'delete-restore-side-effect-blocked',
  'retention-without-controls-blocked',
  'capability-overclaim-blocked',
  'real-server-storage-runtime-still-blocked',
]);

const FORBIDDEN_OUTPUT_SUBSTRINGS = Object.freeze([
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'Authorization: Bearer',
  'BEGIN PRIVATE KEY',
  'raw comms body',
  'raw terminal scrollback',
  'screenshot OCR text',
  'browser session state',
  'BrowserProfile\\Cookies',
  'customer private note',
  'customer phone',
  'customer address',
  'side-profile private note',
  'profile mismatch payload',
  'raw database payload',
  'database write complete',
  'file write complete',
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
  'storage authorizes local execution',
  'storage proves model processing',
  'storage proves bridge green',
  'socket alone proves bridge green',
  'delivery acceptance proves model processing',
  'builder direct target authorized',
  'oracle direct target authorized',
  'tier2 authorized by storage',
  'memory commit authorized by storage',
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

function evidenceRef(kind, id, relation = 'storage_retention_validation') {
  return {
    store: 'mira-core-storage-retention',
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
    no_database_write_performed: true,
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
    no_export_file_written: true,
    no_delete_performed: true,
    no_restore_performed: true,
    no_raw_content_stored: true,
    no_durable_migration_performed: true,
    runtimeImplementationsAttempted: 0,
    serverProcessesStarted: 0,
    databaseWritesAttempted: 0,
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
    exportFilesAttempted: 0,
    deletesAttempted: 0,
    restoresAttempted: 0,
    rawContentStorageAttempted: 0,
    durableMigrationsAttempted: 0,
    outputFileWritten: false,
    ...overrides,
  };
}

function storageAssessmentPlan(scope) {
  return withEvidence({
    baseline_ref: `commit:${BASELINE_COMMIT}`,
    authenticated_receive_ref: 'auth-binding-validation:validation-only',
    upload_envelope_ref: 'server-upload-envelope:validation-only',
    profile: scope.profileName,
    device_id: scope.deviceId,
    session_id: scope.sessionId,
    tenant_boundary: 'single_james_profile_scope_only_until_real_storage_exists',
    item_count: 6,
    accepted_count: 2,
    withheld_count: 4,
    tombstoned_count: 1,
    decision: 'validation_only_future_storage_plan',
    status: 'future_storage_blocked_until_gates',
    write_performed_now: false,
  }, 'storage-plan', 'storage-assessment-plan-shape-specified');
}

function allowedStorageClasses() {
  return withEvidence({
    allowed: [
      'metadata_only',
      'redacted_payload',
      'hash_reference',
      'encrypted_future_placeholder',
      'tombstone_only',
      'export_manifest_only',
    ],
    blocked_raw_classes: [
      'raw_comms',
      'raw_terminal',
      'raw_screenshot_ocr',
      'raw_browser_state',
      'customer_private_content',
      'secret_content',
      'raw_profile_mismatch_content',
      'side_profile_content',
      'raw_database_payload',
    ],
    raw_content_storage_allowed: false,
    profile_mismatch_storage_allowed: false,
    secret_storage_allowed: false,
    customer_private_storage_allowed: false,
    side_profile_storage_allowed: false,
  }, 'storage-class', 'allowed-storage-classes-specified');
}

function itemStorageEligibility() {
  return withEvidence({
    eligible_syncEligibility: [
      'core_sync_safe',
      'core_sync_redacted',
    ],
    eligible_redactionStatus: [
      'none',
      'applied',
    ],
    blocked_syncEligibility: [
      'blocked',
      'local_only',
      'approval_required',
    ],
    withheld_reason_codes: [
      'blocked',
      'local_only',
      'approval_required',
      'profile_mismatch',
      'side_profile_blocked',
      'unredacted_core_sync_redacted',
      'raw_private_content',
      'secret_content',
      'missing_scope',
      'stale_snapshot',
      'watermark_regression',
      'replay_detected',
    ],
    only_core_sync_safe_or_redacted_eligible: true,
    future_store_mark_only: true,
    requires_profile_session_device_scope: true,
    requires_auth_receive_ref: true,
    requires_evidence_refs: true,
    requires_payload_hash: true,
    raw_or_private_items_withheld: true,
  }, 'eligibility', 'item-storage-eligibility-specified');
}

function retentionRules() {
  return withEvidence({
    default_ttl_days: 30,
    expiry_classes: [
      'session_ephemeral',
      'project_memory_redacted',
      'audit_ref',
      'tombstone',
    ],
    max_retention_days: 365,
    profile_session_device_scoping_required: true,
    stale_snapshot_handling: 'warn_or_reject_no_write',
    watermark_binding_required: true,
    replay_binding_required: true,
    backup_retention_warning_required: true,
    deletion_propagation_required: true,
    retention_applied_now: false,
  }, 'retention', 'retention-rules-specified');
}

function deletionRules() {
  return withEvidence({
    delete_request_shape: {
      schema: 'squidrun.mira_core.storage_delete_request.v0',
      required_fields: ['idempotency_key', 'deletion_scope', 'profile', 'device_id', 'reason', 'audit_refs', 'purge_deadline'],
    },
    tombstone_record_shape: {
      schema: 'squidrun.mira_core.storage_tombstone.v0',
      required_fields: ['tombstone_id', 'scope_hash', 'deleted_ref_hash', 'created_at', 'purge_deadline', 'evidenceRefs'],
    },
    idempotency_key_required: true,
    deletion_scope_required: true,
    profile_device_binding_required: true,
    reason_required: true,
    audit_refs_required: true,
    purge_deadline_required: true,
    tombstone_allowed: true,
    raw_payload_available: false,
    deletion_performed_now: false,
  }, 'deletion', 'deletion-rules-specified');
}

function exportRules() {
  return withEvidence({
    export_request_shape: {
      schema: 'squidrun.mira_core.storage_export_request.v0',
      required_fields: ['profile', 'device_id', 'requested_scope', 'review_ref', 'idempotency_key'],
    },
    export_manifest_shape: {
      schema: 'squidrun.mira_core.storage_export_manifest.v0',
      required_fields: ['manifest_id', 'redacted_summaries', 'hashes', 'evidenceRefs'],
    },
    redacted_only: true,
    payload_summary_only: true,
    evidence_refs_required: true,
    hashes_required: true,
    raw_secret_private_content_exported: false,
    profile_isolation_required: true,
    james_visible_review_controls_required: true,
    export_file_written_now: false,
  }, 'export', 'export-rules-specified');
}

function restoreReplayRules() {
  return withEvidence({
    raw_restore_from_server_allowed: false,
    replay_protection_required: true,
    watermark_monotonicity_required: true,
    tombstone_beats_stale_upload: true,
    server_can_resurrect_deleted_local_memory_profile_state: false,
    restore_performed_now: false,
    restore_requires_local_review: true,
  }, 'restore-replay', 'restore-replay-rules-specified');
}

function capabilityBoundary() {
  return withEvidence({
    valid_storage_auth_permits: 'future_storage_plan_validation_only',
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
    allowed_target_role: 'architect',
    local_acceptance_required: true,
  }, 'capability', 'capability-boundary-specified');
}

function migrationGates() {
  return withEvidence({
    baseline_commit: BASELINE_COMMIT,
    phase_14_gap_blocker_id: 'redacted-receive-store-policy-specified',
    real_storage_allowed_now: false,
    future_real_storage_allowed_after_gates: true,
    requires_db_schema_gate: true,
    requires_encryption_key_policy_gate: true,
    requires_audit_logging_gate: true,
    requires_deletion_export_api_gate: true,
    requires_backup_purge_strategy_gate: true,
    requires_profile_isolation_tests_gate: true,
    requires_replay_idempotency_tests_gate: true,
    requires_operator_visible_controls_gate: true,
    feature_flag_default: 'off',
    rollback_plan_required: true,
  }, 'migration', 'migration-gates-to-real-storage-specified');
}

function acceptanceGateSummary() {
  return REQUIRED_GATE_IDS.map((gateId) => ({
    gate_id: gateId,
    status: gateId === 'side-effect-free-validation-only' ? 'satisfied_for_phase_17_validator' : 'specified_for_validation_pending_real_storage',
    required_before_real_server: true,
    required_before_real_storage: true,
    evidenceRefs: [evidenceRef('acceptance-gate', gateId)],
    blocked_until: gateId === 'side-effect-free-validation-only'
      ? 'Phase 17 remains validation-only and side-effect-free.'
      : 'Reviewed database, deletion, export, replay, and operator-control gates exist.',
  }));
}

function blockerSummary() {
  return [
    {
      blocker_id: 'database-write-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Phase 17 defines a future storage plan only; database mutation is blocked.',
      safe_next_action: 'Review schema, encryption policy, and audit gates before any storage runtime build.',
    },
    {
      blocker_id: 'file-export-write-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Export is represented as a redacted manifest contract only; no file artifact is produced.',
      safe_next_action: 'Keep export tests on manifest shape and stdout validation output.',
    },
    {
      blocker_id: 'raw-content-storage-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Raw, private, secret, customer, profile-mismatch, and side-profile payloads are withheld.',
      safe_next_action: 'Keep future-store eligibility limited to safe or already redacted items.',
    },
    {
      blocker_id: 'profile-mismatch-storage-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Profile, session, device, tenant, and side-profile mismatch cases cannot be storage eligible.',
      safe_next_action: 'Keep mismatch reason codes redacted and require scope evidence.',
    },
    {
      blocker_id: 'delete-restore-side-effect-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Delete and restore are contract shapes only in Phase 17.',
      safe_next_action: 'Keep tombstone precedence and review-required restore semantics in validation tests.',
    },
    {
      blocker_id: 'retention-without-controls-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Retention cannot become live before backup, purge, audit, and operator-visible controls exist.',
      safe_next_action: 'Keep retention policy in validation mode until controls are reviewed.',
    },
    {
      blocker_id: 'capability-overclaim-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Storage/auth validation cannot grant execution, direct Builder/Oracle targeting, proof, or external side effects.',
      safe_next_action: 'Keep capability-boundary regressions covering all overclaims.',
    },
    {
      blocker_id: 'real-server-storage-runtime-still-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Real server storage remains blocked by Phase 14 runtime gates.',
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
    storage_assessment_plan: assessment.storage_assessment_plan,
    allowed_storage_classes: assessment.allowed_storage_classes,
    item_storage_eligibility: assessment.item_storage_eligibility,
    retention_rules: assessment.retention_rules,
    deletion_rules: assessment.deletion_rules,
    export_rules: assessment.export_rules,
    restore_replay_rules: assessment.restore_replay_rules,
    capability_boundary: assessment.capability_boundary,
    migration_gates: assessment.migration_gates,
    acceptance_gate_summary: assessment.acceptance_gate_summary,
    blocker_summary: assessment.blocker_summary,
    side_effect_result: assessment.side_effect_result,
  };
}

function assessmentIdempotencyKey(assessment) {
  return `storage-retention-idem:${stableHash(canonicalAssessmentInput(assessment))}`;
}

function buildAssessment(options = {}) {
  const inputSignals = options.inputSignals || {};
  const generatedAt = generatedAtFromOptions(options, inputSignals);
  const scope = normalizeScope(inputSignals);
  const assessment = {
    schema: STORAGE_RETENTION_ASSESSMENT_SCHEMA_VERSION,
    version: STORAGE_RETENTION_VERSION,
    assessment_id: null,
    idempotency_key: null,
    generated_at: generatedAt,
    baseline_commit: BASELINE_COMMIT,
    profile: scope.profile,
    sessionId: scope.sessionId,
    deviceId: scope.deviceId,
    storage_assessment_plan: storageAssessmentPlan(scope),
    allowed_storage_classes: allowedStorageClasses(),
    item_storage_eligibility: itemStorageEligibility(),
    retention_rules: retentionRules(),
    deletion_rules: deletionRules(),
    export_rules: exportRules(),
    restore_replay_rules: restoreReplayRules(),
    capability_boundary: capabilityBoundary(),
    migration_gates: migrationGates(),
    acceptance_gate_summary: acceptanceGateSummary(),
    blocker_summary: blockerSummary(),
    evidenceRefs: [
      evidenceRef('baseline', BASELINE_COMMIT),
      evidenceRef('fixture', 'mira-core-storage-retention-contract'),
    ],
    side_effect_result: sideEffectResult(),
  };
  assessment.idempotency_key = assessmentIdempotencyKey(assessment);
  assessment.assessment_id = `storage-retention-${stableHash(assessment.idempotency_key).slice(0, 12)}`;
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
  const expected = contract.expectedStorageRetentionAssessmentShape || {};
  const requiredIds = asArray(expected.requiredAcceptanceGateIds).length > 0
    ? expected.requiredAcceptanceGateIds
    : REQUIRED_GATE_IDS;
  return gates.length === requiredIds.length
    && valuesMatch(gates.map((gate) => gate.gate_id), requiredIds)
    && gates.every((gate) => hasRequiredFields(gate, expected.acceptanceGateSummaryRequiredFields || [])
      && gate.required_before_real_server === true
      && gate.required_before_real_storage === true
      && asArray(gate.evidenceRefs).length > 0);
}

function blockerSummaryOk(assessment, contract = {}) {
  const blockers = asArray(assessment.blocker_summary);
  const expected = contract.expectedStorageRetentionAssessmentShape || {};
  const requiredIds = asArray(expected.requiredBlockerIds).length > 0
    ? expected.requiredBlockerIds
    : REQUIRED_BLOCKER_IDS;
  return blockers.length === requiredIds.length
    && valuesMatch(blockers.map((blocker) => blocker.blocker_id), requiredIds)
    && blockers.every((blocker) => hasRequiredFields(blocker, expected.blockerSummaryRequiredFields || [])
      && asArray(blocker.evidenceRefs).length > 0);
}

function allowedClassesOk(assessment, expected) {
  const classes = assessment.allowed_storage_classes || {};
  return sectionValuesOk(classes, expected.allowedStorageClassesRequiredFields, expected.allowedStorageClassesRequiredValues)
    && valuesMatch(classes.allowed, expected.allowedStorageClassesRequiredValues?.allowed)
    && valuesMatch(classes.blocked_raw_classes, expected.allowedStorageClassesRequiredValues?.blocked_raw_classes);
}

function itemEligibilityOk(assessment, expected) {
  const eligibility = assessment.item_storage_eligibility || {};
  return sectionValuesOk(eligibility, expected.itemStorageEligibilityRequiredFields, expected.itemStorageEligibilityRequiredValues)
    && valuesMatch(eligibility.eligible_syncEligibility, expected.itemStorageEligibilityRequiredValues?.eligible_syncEligibility)
    && valuesMatch(eligibility.eligible_redactionStatus, expected.itemStorageEligibilityRequiredValues?.eligible_redactionStatus)
    && valuesMatch(eligibility.blocked_syncEligibility, expected.itemStorageEligibilityRequiredValues?.blocked_syncEligibility)
    && valuesMatch(eligibility.withheld_reason_codes, expected.itemStorageEligibilityRequiredValues?.withheld_reason_codes);
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
  const expected = contract.expectedStorageRetentionAssessmentShape || {};

  add('output-shape-complete',
    assessment.schema === STORAGE_RETENTION_ASSESSMENT_SCHEMA_VERSION
      && hasRequiredFields(assessment, expected.requiredFields || REQUIRED_ASSESSMENT_FIELDS),
    'Storage retention assessment shape is incomplete.');

  add('phase-17-baseline-6f97287-pinned',
    assessment.baseline_commit === BASELINE_COMMIT
      && assessment.migration_gates?.baseline_commit === BASELINE_COMMIT
      && assessment.storage_assessment_plan?.baseline_ref === `commit:${BASELINE_COMMIT}`,
    'Baseline commit must stay pinned to 6f97287.');

  add('validation-only-no-real-storage',
    sideEffectValuesOk(assessment.side_effect_result, expected.sideEffectRequiredValues || {}),
    'Phase 17 side-effect truth is unsafe.');

  add('storage-assessment-plan-shape-required',
    sectionValuesOk(assessment.storage_assessment_plan, expected.storageAssessmentPlanRequiredFields, expected.storageAssessmentPlanRequiredValues),
    'Storage assessment plan is incomplete or overclaimed.');

  add('allowed-storage-classes-required',
    allowedClassesOk(assessment, expected),
    'Allowed storage classes changed or raw/private classes became eligible.');

  add('raw-private-storage-blocked',
    assessment.allowed_storage_classes?.raw_content_storage_allowed === false
      && assessment.allowed_storage_classes?.profile_mismatch_storage_allowed === false
      && assessment.allowed_storage_classes?.secret_storage_allowed === false
      && assessment.allowed_storage_classes?.customer_private_storage_allowed === false
      && assessment.allowed_storage_classes?.side_profile_storage_allowed === false
      && assessment.item_storage_eligibility?.raw_or_private_items_withheld === true
      && assessment.side_effect_result?.no_raw_content_stored === true,
    'Raw/private/profile-mismatch storage boundary is unsafe.');

  add('item-storage-eligibility-required',
    itemEligibilityOk(assessment, expected),
    'Item storage eligibility permits unsafe, stale, replayed, or missing-scope items.');

  add('retention-rules-required',
    sectionValuesOk(assessment.retention_rules, expected.retentionRulesRequiredFields, expected.retentionRulesRequiredValues),
    'Retention rules are incomplete or applied prematurely.');

  add('deletion-rules-required',
    sectionValuesOk(assessment.deletion_rules, expected.deletionRulesRequiredFields, expected.deletionRulesRequiredValues)
      && hasRequiredFields(assessment.deletion_rules?.delete_request_shape, ['schema', 'required_fields'])
      && hasRequiredFields(assessment.deletion_rules?.tombstone_record_shape, ['schema', 'required_fields']),
    'Deletion/tombstone contract is incomplete or side-effectful.');

  add('export-rules-required',
    sectionValuesOk(assessment.export_rules, expected.exportRulesRequiredFields, expected.exportRulesRequiredValues)
      && hasRequiredFields(assessment.export_rules?.export_request_shape, ['schema', 'required_fields'])
      && hasRequiredFields(assessment.export_rules?.export_manifest_shape, ['schema', 'required_fields']),
    'Export manifest contract is incomplete or side-effectful.');

  add('restore-replay-rules-required',
    sectionValuesOk(assessment.restore_replay_rules, expected.restoreReplayRulesRequiredFields, expected.restoreReplayRulesRequiredValues),
    'Restore/replay/tombstone boundary is incomplete or unsafe.');

  add('capability-boundary-validation-only',
    sectionValuesOk(assessment.capability_boundary, expected.capabilityBoundaryRequiredFields, expected.capabilityBoundaryRequiredValues),
    'Capability boundary overclaimed execution, proof, target, Tier 2+, or side-effect authority.');

  add('migration-real-storage-gated',
    sectionValuesOk(assessment.migration_gates, expected.migrationGatesRequiredFields, expected.migrationGatesRequiredValues),
    'Real storage migration gates are incomplete or overclaimed.');

  add('required-gates-and-blockers-present',
    gateSummaryOk(assessment, contract) && blockerSummaryOk(assessment, contract),
    'Required Phase 17 gates or blockers are missing.',
    {
      gate_count: asArray(assessment.acceptance_gate_summary).length,
      blocker_count: asArray(assessment.blocker_summary).length,
    });

  try {
    assertNoForbiddenOutput(assessment, asArray(contract.forbiddenOutputSubstrings));
    add('forbidden-output-strings-absent', true, null, {
      raw_private_content_exported: false,
      side_effect_claim_exported: false,
      proof_overclaim_exported: false,
    });
  } catch (err) {
    add('forbidden-output-strings-absent', false, err.message, {
      raw_private_content_exported: true,
    });
  }

  add('assessment-literal-values',
    literalValuesOk(assessment, expected.requiredLiteralValues || {}),
    'Storage retention literal values changed.');

  add('idempotency-stable',
    assessment.idempotency_key === assessmentIdempotencyKey(assessment),
    'Storage retention idempotency key is unstable.');

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
    version: STORAGE_RETENTION_VERSION,
    validation_id: `storage-retention-validation-${stableHash({
      assessment_key: assessment.idempotency_key,
      generatedAt,
    }).slice(0, 12)}`,
    generated_at: generatedAt,
    baseline_commit: BASELINE_COMMIT,
    fixture_schema: contract.schema || 'squidrun.mira_core.storage_retention_contract_fixture.v0',
    assessment_schema: STORAGE_RETENTION_ASSESSMENT_SCHEMA_VERSION,
    profile: assessment.profile,
    sessionId: assessment.sessionId,
    deviceId: assessment.deviceId,
    decision: validation.ok ? 'accepted' : 'blocked',
    reasons,
    storage_plan_result: checkResult('storage-assessment-plan-shape-required'),
    allowed_classes_result: checkResult('allowed-storage-classes-required'),
    item_eligibility_result: checkResult('item-storage-eligibility-required'),
    retention_result: checkResult('retention-rules-required'),
    deletion_result: checkResult('deletion-rules-required'),
    export_result: checkResult('export-rules-required'),
    restore_replay_result: checkResult('restore-replay-rules-required'),
    capability_boundary_result: checkResult('capability-boundary-validation-only'),
    migration_gates_result: checkResult('migration-real-storage-gated'),
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
      evidenceRef('validation', assessment.assessment_id, 'storage_retention_validation_report'),
    ],
    side_effect_result: sideEffectResult(),
  };
  assertNoForbiddenOutput(report, asArray(contract.forbiddenOutputSubstrings));
  return report;
}

function buildMiraCoreStorageRetention(options = {}) {
  const contract = options.contract || {};
  const assessment = buildAssessment(options);
  const validation_report = buildValidationReport(assessment, contract, assessment.generated_at);
  const output = {
    storage_retention_assessment: assessment,
    validation_report,
  };
  assertNoForbiddenOutput(output, asArray(contract.forbiddenOutputSubstrings));
  return output;
}

function validateMiraCoreStorageRetentionOutput(output = {}, contract = {}) {
  const checks = [];
  const errors = [];
  const add = (id, ok, detail = null) => {
    checks.push({ id, ok: ok === true, detail });
    if (!ok && detail) errors.push(detail);
  };
  const assessment = output.storage_retention_assessment || {};
  const report = output.validation_report || {};
  const assessmentValidation = validateAssessment(assessment, contract);

  add('output-shape-complete',
    hasRequiredFields(output, contract.expectedOutputShape?.requiredTopLevelFields || REQUIRED_OUTPUT_FIELDS)
      && assessment.schema === STORAGE_RETENTION_ASSESSMENT_SCHEMA_VERSION
      && report.schema === VALIDATION_REPORT_SCHEMA_VERSION
      && hasRequiredFields(assessment, contract.expectedStorageRetentionAssessmentShape?.requiredFields || REQUIRED_ASSESSMENT_FIELDS)
      && hasRequiredFields(report, contract.expectedValidationReportShape?.requiredFields || REQUIRED_VALIDATION_REPORT_FIELDS),
    'Storage retention output shape is incomplete.');

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
      throw new Error(`storage_retention_forbidden_substring:${forbidden}`);
    }
  }
}

module.exports = {
  BASELINE_COMMIT,
  FORBIDDEN_OUTPUT_SUBSTRINGS,
  REQUIRED_ASSESSMENT_FIELDS,
  REQUIRED_BLOCKER_IDS,
  REQUIRED_GATE_IDS,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  STORAGE_RETENTION_ASSESSMENT_SCHEMA_VERSION,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  assessmentIdempotencyKey,
  buildMiraCoreStorageRetention,
  canonicalAssessmentInput,
  stableHash,
  validateMiraCoreStorageRetentionOutput,
};
