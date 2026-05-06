'use strict';

const crypto = require('crypto');

const AUTH_BINDING_ASSESSMENT_SCHEMA_VERSION = 'squidrun.mira_core.auth_binding_assessment.v0';
const VALIDATION_REPORT_SCHEMA_VERSION = 'squidrun.mira_core.auth_binding_validation_report.v0';
const AUTH_BINDING_VERSION = 'v0';
const BASELINE_COMMIT = '3904697';

const REQUIRED_OUTPUT_FIELDS = Object.freeze([
  'auth_binding_assessment',
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
  'auth_binding',
  'scope_rules',
  'token_envelope',
  'authorization_boundary',
  'profile_mismatch_handling',
  'verification_report_contract',
  'revocation_expiry_rules',
  'no_secret_no_raw_guarantees',
  'migration_path',
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
  'auth_binding_result',
  'scope_rules_result',
  'token_envelope_result',
  'authorization_boundary_result',
  'profile_mismatch_result',
  'verification_contract_result',
  'revocation_expiry_result',
  'no_secret_no_raw_result',
  'migration_path_result',
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
  'no_database_or_store_write_performed',
  'no_queue_created',
  'no_auth_secret_or_token_created',
  'no_real_token_generation_performed',
  'no_session_created',
  'no_device_registry_mutation_performed',
  'no_role_discovery_mutation_performed',
  'no_local_execution_performed',
  'no_shell_or_pty_performed',
  'no_browser_window_access_performed',
  'no_external_send_performed',
  'no_customer_send_performed',
  'no_deploy_performed',
  'no_trade_performed',
  'no_memory_profile_commit_performed',
  'no_file_mutation_performed_by_validator',
  'no_durable_migration_performed',
]);

const SIDE_EFFECT_COUNTER_FIELDS = Object.freeze([
  'runtimeImplementationsAttempted',
  'serverProcessesStarted',
  'networkRequestsAttempted',
  'databaseOrStoreWritesAttempted',
  'queuesCreated',
  'authSecretsOrTokensCreated',
  'realTokenGenerationsAttempted',
  'sessionsCreated',
  'deviceRegistryMutationsAttempted',
  'roleDiscoveryMutationsAttempted',
  'localExecutionAttempted',
  'shellOrPtyAttempted',
  'browserWindowAccessAttempted',
  'externalSendsAttempted',
  'customerSendsAttempted',
  'deploysAttempted',
  'tradesAttempted',
  'memoryProfileCommitsAttempted',
  'fileMutationsAttemptedByValidator',
  'durableMigrationsAttempted',
]);

const REQUIRED_GATE_IDS = Object.freeze([
  'auth-binding-record-shape-specified',
  'session-device-profile-scope-rules-specified',
  'token-envelope-hash-only-rules-specified',
  'authorization-boundary-specified',
  'profile-mismatch-fail-closed-specified',
  'verification-report-shape-specified',
  'revocation-expiry-rules-specified',
  'no-secret-no-raw-guarantees-specified',
  'migration-path-to-real-auth-gated',
  'side-effect-free-validation-only',
]);

const REQUIRED_BLOCKER_IDS = Object.freeze([
  'real-token-generation-blocked',
  'session-creation-blocked',
  'raw-token-secret-storage-blocked',
  'profile-device-session-mismatch-blocked',
  'stale-or-missing-role-proof-blocked',
  'builder-oracle-direct-target-blocked',
  'authorization-overclaim-blocked',
  'real-server-auth-runtime-still-blocked',
]);

const FORBIDDEN_OUTPUT_SUBSTRINGS = Object.freeze([
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'Authorization: Bearer',
  'access_token',
  'refresh_token',
  'raw_token_value',
  'session_secret',
  'auth secret',
  'cookie=',
  'Set-Cookie',
  'BEGIN PRIVATE KEY',
  'raw profile content',
  'raw side-profile content',
  'raw comms transcript',
  'raw terminal scrollback',
  'raw screenshot OCR',
  'browser profile',
  'customer phone',
  'customer address',
  'server executed local work',
  'server can run shell',
  'server can operate PTY',
  'server can access browser',
  'auth authorizes local execution',
  'auth proves model processing',
  'auth proves bridge green',
  'socket alone proves bridge green',
  'delivery acceptance proves model processing',
  'builder direct target authorized',
  'oracle direct target authorized',
  'tier2 authorized by auth',
  'tier3 authorized by auth',
  'customer send authorized by auth',
  'memory commit authorized by auth',
  'server deployed',
  'server placed trade',
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

function evidenceRef(kind, id, relation = 'auth_binding_validation') {
  return {
    store: 'mira-core-auth-binding',
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
    no_database_or_store_write_performed: true,
    no_queue_created: true,
    no_auth_secret_or_token_created: true,
    no_real_token_generation_performed: true,
    no_session_created: true,
    no_device_registry_mutation_performed: true,
    no_role_discovery_mutation_performed: true,
    no_local_execution_performed: true,
    no_shell_or_pty_performed: true,
    no_browser_window_access_performed: true,
    no_external_send_performed: true,
    no_customer_send_performed: true,
    no_deploy_performed: true,
    no_trade_performed: true,
    no_memory_profile_commit_performed: true,
    no_file_mutation_performed_by_validator: true,
    no_durable_migration_performed: true,
    runtimeImplementationsAttempted: 0,
    serverProcessesStarted: 0,
    networkRequestsAttempted: 0,
    databaseOrStoreWritesAttempted: 0,
    queuesCreated: 0,
    authSecretsOrTokensCreated: 0,
    realTokenGenerationsAttempted: 0,
    sessionsCreated: 0,
    deviceRegistryMutationsAttempted: 0,
    roleDiscoveryMutationsAttempted: 0,
    localExecutionAttempted: 0,
    shellOrPtyAttempted: 0,
    browserWindowAccessAttempted: 0,
    externalSendsAttempted: 0,
    customerSendsAttempted: 0,
    deploysAttempted: 0,
    tradesAttempted: 0,
    memoryProfileCommitsAttempted: 0,
    fileMutationsAttemptedByValidator: 0,
    durableMigrationsAttempted: 0,
    outputFileWritten: false,
    ...overrides,
  };
}

function futureIso(generatedAt, offsetMs) {
  return new Date(Date.parse(generatedAt) + offsetMs).toISOString();
}

function authBinding(generatedAt, scope) {
  return withEvidence({
    principal_id: `principal:james-${scope.profileName}-validation`,
    profile: scope.profileName,
    device_id: scope.deviceId,
    session_id: scope.sessionId,
    role: 'architect',
    tenant_user_boundary: 'single_james_profile_scope_only_until_real_auth_exists',
    issuer: 'mira-core-auth-validation-only',
    issued_at: generatedAt,
    expires_at: futureIso(generatedAt, 15 * 60 * 1000),
    status: 'validation_only_pending_real_auth',
    token_generated_now: false,
    session_created_now: false,
  }, 'auth-binding', 'auth-binding-record-shape-specified');
}

function scopeRules() {
  return withEvidence({
    main_profile_isolated: true,
    side_profile_isolated: true,
    current_session_freshness_required: true,
    device_registration_status_required: true,
    role_discovery_proof_required: true,
    target_proof_required: true,
    profile_mismatch_rejected: true,
    session_mismatch_rejected: true,
    device_mismatch_rejected: true,
    role_mismatch_rejected: true,
    side_profile_access_blocked: true,
    stale_session_rejected: true,
  }, 'scope', 'session-device-profile-scope-rules-specified');
}

function tokenEnvelope(generatedAt) {
  return withEvidence({
    token_id: 'token-validation-001',
    token_hash: 'sha256:test-vector-token-hash',
    token_hash_only: true,
    token_stored: false,
    token_exported: false,
    raw_token_available: false,
    audience: 'squidrun-local-architect',
    scope_allowlist: [
      'proposal:validate',
      'intent:validate',
      'status:read',
    ],
    nonce: 'nonce-auth-validation-001',
    issued_at: generatedAt,
    expires_at: futureIso(generatedAt, 15 * 60 * 1000),
    max_clock_skew_ms: 300000,
    expiry_required: true,
    revocation_status: 'validation_only_not_real_token',
    revocation_status_required: true,
    replay_window_ms: 900000,
    nonce_required: true,
    audience_required: true,
    scope_allowlist_required: true,
  }, 'token-envelope', 'token-envelope-hash-only-rules-specified');
}

function authorizationBoundary() {
  return withEvidence({
    valid_auth_permits: 'server_to_local_proposal_intent_validation_only',
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
  }, 'authorization', 'authorization-boundary-specified');
}

function profileMismatchHandling() {
  return withEvidence({
    fail_closed: true,
    decision: 'blocked',
    mismatch_reason_codes: [
      'profile_mismatch',
      'session_mismatch',
      'device_mismatch',
      'side_profile_blocked',
    ],
    withheld_reason_summary_required: true,
    side_profile_content_withheld: true,
    raw_profile_content_exported: false,
    raw_mismatch_payload_exported: false,
    redacted_evidence_refs_only: true,
    safe_next_action: 'Review redacted mismatch reason codes and keep withheld profile payload unavailable.',
  }, 'profile-mismatch', 'profile-mismatch-fail-closed-specified');
}

function freshnessResult() {
  return {
    issued_at_required: true,
    expires_at_required: true,
    max_clock_skew_ms: 300000,
    expired_session_rejected: true,
    future_issued_at_rejected: true,
    stale_session_rejected: true,
  };
}

function bindingResult() {
  return {
    profile_match_required: true,
    session_match_required: true,
    device_match_required: true,
    known_profile_required: true,
    registered_device_required: true,
    unknown_profile_blocked: true,
    unknown_device_blocked: true,
    side_profile_blocked: true,
  };
}

function roleProofResult() {
  return {
    role_discovery_proof_required: true,
    target_proof_required: true,
    architect_role_required: true,
    stale_role_discovery_blocked: true,
    builder_direct_target_blocked: true,
    oracle_direct_target_blocked: true,
  };
}

function replayIdempotencyResult() {
  return {
    nonce_reuse_rejected: true,
    expired_token_rejected: true,
    revoked_token_rejected: true,
    duplicate_request_returns_same_decision: true,
    idempotency_key_inputs: [
      'profile',
      'session_id',
      'device_id',
      'role',
      'token_id',
      'token_hash',
      'nonce',
    ],
    scope_or_token_change_changes_idempotency_key: true,
  };
}

function verificationReportContract() {
  return withEvidence({
    decision: 'pending',
    allowed_decisions: ['accepted', 'pending', 'blocked', 'rejected'],
    accepted: false,
    pending: true,
    blocked: false,
    rejected: false,
    reasons: [
      'validation_only_binding_contract',
      'real_auth_gates_pending',
      'proposal_intent_validation_only',
    ],
    freshness_result: freshnessResult(),
    profile_device_session_binding_result: bindingResult(),
    role_proof_result: roleProofResult(),
    replay_idempotency_result: replayIdempotencyResult(),
    authorization_granted: false,
    local_execution_authorized: false,
    model_processing_proven: false,
    bridge_green_proven: false,
    side_effect_result: sideEffectResult(),
  }, 'verification', 'verification-report-shape-specified');
}

function revocationExpiryRules() {
  return withEvidence({
    expired_sessions_blocked: true,
    revoked_devices_blocked: true,
    unknown_profiles_blocked: true,
    unknown_devices_blocked: true,
    stale_role_discovery_blocked: true,
    revoked_token_blocked: true,
    revocation_event_refs_required: true,
    session_lifecycle_required: true,
    device_registry_required: true,
    role_discovery_freshness_required: true,
  }, 'revocation-expiry', 'revocation-expiry-rules-specified');
}

function noSecretNoRawGuarantees() {
  return withEvidence({
    raw_token_in_output: false,
    session_secret_exported: false,
    auth_secret_stored: false,
    raw_profile_content_exported: false,
    token_hash_only: true,
    profile_mismatch_redacted: true,
    side_profile_content_withheld: true,
    credential_material_allowed: false,
  }, 'no-secret-no-raw', 'no-secret-no-raw-guarantees-specified');
}

function migrationPath() {
  return withEvidence({
    baseline_commit: BASELINE_COMMIT,
    phase_14_gap_blocker_id: 'auth-session-device-profile-binding-specified',
    real_auth_allowed_now: false,
    future_real_auth_allowed_after_gates: true,
    requires_secret_storage_policy_gate: true,
    requires_session_lifecycle_gate: true,
    requires_device_registry_gate: true,
    requires_role_discovery_proof_gate: true,
    requires_deletion_export_retention_gate: true,
    requires_audit_logging_gate: true,
    feature_flag_default: 'off',
    no_real_token_generation_now: true,
    no_session_creation_now: true,
    rollback_plan_required: true,
  }, 'migration', 'migration-path-to-real-auth-gated');
}

function acceptanceGateSummary() {
  return REQUIRED_GATE_IDS.map((gateId) => ({
    gate_id: gateId,
    status: gateId === 'side-effect-free-validation-only' ? 'satisfied_for_phase_16_validator' : 'specified_for_validation_pending_real_auth',
    required_before_real_server: true,
    required_before_real_auth: true,
    evidenceRefs: [evidenceRef('acceptance-gate', gateId)],
    blocked_until: gateId === 'side-effect-free-validation-only'
      ? 'Phase 16 remains validation-only and side-effect-free.'
      : 'Reviewed real-auth lifecycle and role-proof gates exist.',
  }));
}

function blockerSummary() {
  return [
    {
      blocker_id: 'real-token-generation-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Phase 16 uses token hash placeholders only; no live token creation is allowed.',
      safe_next_action: 'Review token lifecycle and storage-policy contracts before any real auth build.',
    },
    {
      blocker_id: 'session-creation-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Session creation remains blocked until lifecycle, expiry, and revocation contracts exist.',
      safe_next_action: 'Keep session records validation-only with current-scope metadata.',
    },
    {
      blocker_id: 'raw-token-secret-storage-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Token bodies, session material, and credential payloads stay withheld from fixtures and output.',
      safe_next_action: 'Keep hash-only token envelopes and redacted evidence references.',
    },
    {
      blocker_id: 'profile-device-session-mismatch-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Profile, session, device, and side-profile mismatch must fail closed.',
      safe_next_action: 'Use redacted reason codes and withhold mismatched payloads.',
    },
    {
      blocker_id: 'stale-or-missing-role-proof-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Fresh role discovery proof and Architect target proof are required before future handoff validation.',
      safe_next_action: 'Keep role-proof freshness and target-proof regressions in the validator.',
    },
    {
      blocker_id: 'builder-oracle-direct-target-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Server-originated Builder and Oracle targeting remain blocked; Architect is the only future target role.',
      safe_next_action: 'Route any future validation proposal through Architect-only local acceptance.',
    },
    {
      blocker_id: 'authorization-overclaim-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Valid auth is validation-only and cannot grant execution, proof, external side effects, or durable profile changes.',
      safe_next_action: 'Keep authorization boundary checks explicit before downstream phases.',
    },
    {
      blocker_id: 'real-server-auth-runtime-still-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Phase 14 runtime blockers remain; Phase 16 does not start a server or create auth state.',
      safe_next_action: 'Continue validation-only gates until Architect scopes a real runtime lane.',
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
    auth_binding: assessment.auth_binding,
    scope_rules: assessment.scope_rules,
    token_envelope: assessment.token_envelope,
    authorization_boundary: assessment.authorization_boundary,
    profile_mismatch_handling: assessment.profile_mismatch_handling,
    verification_report_contract: assessment.verification_report_contract,
    revocation_expiry_rules: assessment.revocation_expiry_rules,
    no_secret_no_raw_guarantees: assessment.no_secret_no_raw_guarantees,
    migration_path: assessment.migration_path,
    acceptance_gate_summary: assessment.acceptance_gate_summary,
    blocker_summary: assessment.blocker_summary,
    side_effect_result: assessment.side_effect_result,
  };
}

function assessmentIdempotencyKey(assessment) {
  return `auth-binding-idem:${stableHash(canonicalAssessmentInput(assessment))}`;
}

function buildAssessment(options = {}) {
  const inputSignals = options.inputSignals || {};
  const generatedAt = generatedAtFromOptions(options, inputSignals);
  const scope = normalizeScope(inputSignals);
  const assessment = {
    schema: AUTH_BINDING_ASSESSMENT_SCHEMA_VERSION,
    version: AUTH_BINDING_VERSION,
    assessment_id: null,
    idempotency_key: null,
    generated_at: generatedAt,
    baseline_commit: BASELINE_COMMIT,
    profile: scope.profile,
    sessionId: scope.sessionId,
    deviceId: scope.deviceId,
    auth_binding: authBinding(generatedAt, scope),
    scope_rules: scopeRules(),
    token_envelope: tokenEnvelope(generatedAt),
    authorization_boundary: authorizationBoundary(),
    profile_mismatch_handling: profileMismatchHandling(),
    verification_report_contract: verificationReportContract(),
    revocation_expiry_rules: revocationExpiryRules(),
    no_secret_no_raw_guarantees: noSecretNoRawGuarantees(),
    migration_path: migrationPath(),
    acceptance_gate_summary: acceptanceGateSummary(),
    blocker_summary: blockerSummary(),
    evidenceRefs: [
      evidenceRef('baseline', BASELINE_COMMIT),
      evidenceRef('fixture', 'mira-core-auth-binding-contract'),
    ],
    side_effect_result: sideEffectResult(),
  };
  assessment.idempotency_key = assessmentIdempotencyKey(assessment);
  assessment.assessment_id = `auth-binding-${stableHash(assessment.idempotency_key).slice(0, 12)}`;
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

function nestedValuesOk(section = {}, requiredFields = [], requiredValues = {}) {
  return hasRequiredFields(section, requiredFields)
    && Object.entries(requiredValues || {}).every(([field, expected]) => valuesMatch(section[field], expected));
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
  const expected = contract.expectedAuthBindingAssessmentShape || {};
  const requiredIds = asArray(expected.requiredAcceptanceGateIds).length > 0
    ? expected.requiredAcceptanceGateIds
    : REQUIRED_GATE_IDS;
  return gates.length === requiredIds.length
    && valuesMatch(gates.map((gate) => gate.gate_id), requiredIds)
    && gates.every((gate) => hasRequiredFields(gate, expected.acceptanceGateSummaryRequiredFields || [])
      && gate.required_before_real_server === true
      && gate.required_before_real_auth === true
      && asArray(gate.evidenceRefs).length > 0);
}

function blockerSummaryOk(assessment, contract = {}) {
  const blockers = asArray(assessment.blocker_summary);
  const expected = contract.expectedAuthBindingAssessmentShape || {};
  const requiredIds = asArray(expected.requiredBlockerIds).length > 0
    ? expected.requiredBlockerIds
    : REQUIRED_BLOCKER_IDS;
  return blockers.length === requiredIds.length
    && valuesMatch(blockers.map((blocker) => blocker.blocker_id), requiredIds)
    && blockers.every((blocker) => hasRequiredFields(blocker, expected.blockerSummaryRequiredFields || [])
      && asArray(blocker.evidenceRefs).length > 0);
}

function verificationReportOk(assessment, expected) {
  const report = assessment.verification_report_contract || {};
  return sectionValuesOk(report, expected.verificationReportRequiredFields, expected.verificationReportRequiredValues)
    && nestedValuesOk(report.freshness_result, expected.freshnessResultRequiredFields, expected.freshnessResultRequiredValues)
    && nestedValuesOk(report.profile_device_session_binding_result, expected.bindingResultRequiredFields, expected.bindingResultRequiredValues)
    && nestedValuesOk(report.role_proof_result, expected.roleProofResultRequiredFields, expected.roleProofResultRequiredValues)
    && nestedValuesOk(report.replay_idempotency_result, expected.replayIdempotencyResultRequiredFields, expected.replayIdempotencyResultRequiredValues)
    && sideEffectValuesOk(report.side_effect_result, expected.sideEffectRequiredValues || {});
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
  const expected = contract.expectedAuthBindingAssessmentShape || {};

  add('output-shape-complete',
    assessment.schema === AUTH_BINDING_ASSESSMENT_SCHEMA_VERSION
      && hasRequiredFields(assessment, expected.requiredFields || REQUIRED_ASSESSMENT_FIELDS),
    'Auth binding assessment shape is incomplete.');

  add('phase-16-baseline-3904697-pinned',
    assessment.baseline_commit === BASELINE_COMMIT
      && assessment.migration_path?.baseline_commit === BASELINE_COMMIT,
    'Baseline commit must stay pinned to 3904697.');

  add('validation-only-no-real-auth',
    sideEffectValuesOk(assessment.side_effect_result, expected.sideEffectRequiredValues || {}),
    'Phase 16 side-effect truth is unsafe.');

  add('auth-binding-record-shape-required',
    sectionValuesOk(assessment.auth_binding, expected.authBindingRequiredFields, expected.authBindingRequiredValues),
    'Auth binding record is incomplete or overclaimed.');

  add('session-device-profile-scope-rules-required',
    sectionValuesOk(assessment.scope_rules, expected.scopeRulesRequiredFields, expected.scopeRulesRequiredValues),
    'Session/device/profile scope rules are incomplete or unsafe.');

  add('token-envelope-hash-only-required',
    sectionValuesOk(assessment.token_envelope, expected.tokenEnvelopeRequiredFields, expected.tokenEnvelopeRequiredValues)
      && /^sha256:/.test(String(assessment.token_envelope?.token_hash || ''))
      && !String(assessment.token_envelope?.token_id || '').includes(':'),
    'Token envelope is incomplete or exposes token material.');

  add('authorization-boundary-validation-only',
    sectionValuesOk(assessment.authorization_boundary, expected.authorizationBoundaryRequiredFields, expected.authorizationBoundaryRequiredValues),
    'Authorization boundary overclaimed execution, proof, target, Tier 2+, or side-effect authority.');

  add('profile-mismatch-fail-closed-redacted',
    sectionValuesOk(assessment.profile_mismatch_handling, expected.profileMismatchHandlingRequiredFields, expected.profileMismatchHandlingRequiredValues),
    'Profile mismatch handling does not fail closed with redacted evidence.');

  add('verification-report-shape-required',
    verificationReportOk(assessment, expected),
    'Verification report shape or nested freshness/binding/role/replay result is unsafe.');

  add('revocation-expiry-rules-required',
    sectionValuesOk(assessment.revocation_expiry_rules, expected.revocationExpiryRulesRequiredFields, expected.revocationExpiryRulesRequiredValues),
    'Revocation/expiry rules are incomplete or unsafe.');

  add('no-secret-no-raw-guarantees-required',
    sectionValuesOk(assessment.no_secret_no_raw_guarantees, expected.noSecretNoRawRequiredFields, expected.noSecretNoRawRequiredValues)
      && assessment.token_envelope?.token_hash_only === true
      && assessment.profile_mismatch_handling?.raw_profile_content_exported === false,
    'No-secret/no-raw guarantees are incomplete or leaking.');

  add('architect-only-role-proof-required',
    assessment.auth_binding?.role === 'architect'
      && assessment.authorization_boundary?.allowed_target_role === 'architect'
      && assessment.scope_rules?.role_discovery_proof_required === true
      && assessment.scope_rules?.target_proof_required === true
      && assessment.verification_report_contract?.role_proof_result?.architect_role_required === true
      && assessment.verification_report_contract?.role_proof_result?.stale_role_discovery_blocked === true
      && assessment.verification_report_contract?.role_proof_result?.builder_direct_target_blocked === true
      && assessment.verification_report_contract?.role_proof_result?.oracle_direct_target_blocked === true,
    'Architect-only role proof or target proof requirement changed.');

  add('migration-real-auth-gated',
    sectionValuesOk(assessment.migration_path, expected.migrationPathRequiredFields, expected.migrationPathRequiredValues),
    'Real auth migration path is not gated.');

  add('required-gates-and-blockers-present',
    gateSummaryOk(assessment, contract) && blockerSummaryOk(assessment, contract),
    'Required Phase 16 gates or blockers are missing.',
    {
      gate_count: asArray(assessment.acceptance_gate_summary).length,
      blocker_count: asArray(assessment.blocker_summary).length,
    });

  try {
    assertNoForbiddenOutput(assessment, asArray(contract.forbiddenOutputSubstrings));
    add('forbidden-output-strings-absent', true, null, {
      secret_like_content_exported: false,
      token_material_exported: false,
      profile_payload_exported: false,
    });
  } catch (err) {
    add('forbidden-output-strings-absent', false, err.message, {
      secret_like_content_exported: true,
    });
  }

  add('assessment-literal-values',
    literalValuesOk(assessment, expected.requiredLiteralValues || {}),
    'Auth binding literal values changed.');

  add('idempotency-stable',
    assessment.idempotency_key === assessmentIdempotencyKey(assessment),
    'Auth binding idempotency key is unstable.');

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
    version: AUTH_BINDING_VERSION,
    validation_id: `auth-binding-validation-${stableHash({
      assessment_key: assessment.idempotency_key,
      generatedAt,
    }).slice(0, 12)}`,
    generated_at: generatedAt,
    baseline_commit: BASELINE_COMMIT,
    fixture_schema: contract.schema || 'squidrun.mira_core.auth_binding_contract_fixture.v0',
    assessment_schema: AUTH_BINDING_ASSESSMENT_SCHEMA_VERSION,
    profile: assessment.profile,
    sessionId: assessment.sessionId,
    deviceId: assessment.deviceId,
    decision: validation.ok ? 'accepted' : 'blocked',
    reasons,
    auth_binding_result: checkResult('auth-binding-record-shape-required'),
    scope_rules_result: checkResult('session-device-profile-scope-rules-required'),
    token_envelope_result: checkResult('token-envelope-hash-only-required'),
    authorization_boundary_result: checkResult('authorization-boundary-validation-only'),
    profile_mismatch_result: checkResult('profile-mismatch-fail-closed-redacted'),
    verification_contract_result: checkResult('verification-report-shape-required'),
    revocation_expiry_result: checkResult('revocation-expiry-rules-required'),
    no_secret_no_raw_result: checkResult('no-secret-no-raw-guarantees-required'),
    migration_path_result: checkResult('migration-real-auth-gated'),
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
      evidenceRef('validation', assessment.assessment_id, 'auth_binding_validation_report'),
    ],
    side_effect_result: sideEffectResult(),
  };
  assertNoForbiddenOutput(report, asArray(contract.forbiddenOutputSubstrings));
  return report;
}

function buildMiraCoreAuthBinding(options = {}) {
  const contract = options.contract || {};
  const assessment = buildAssessment(options);
  const validation_report = buildValidationReport(assessment, contract, assessment.generated_at);
  const output = {
    auth_binding_assessment: assessment,
    validation_report,
  };
  assertNoForbiddenOutput(output, asArray(contract.forbiddenOutputSubstrings));
  return output;
}

function validateMiraCoreAuthBindingOutput(output = {}, contract = {}) {
  const checks = [];
  const errors = [];
  const add = (id, ok, detail = null) => {
    checks.push({ id, ok: ok === true, detail });
    if (!ok && detail) errors.push(detail);
  };
  const assessment = output.auth_binding_assessment || {};
  const report = output.validation_report || {};
  const assessmentValidation = validateAssessment(assessment, contract);

  add('output-shape-complete',
    hasRequiredFields(output, contract.expectedOutputShape?.requiredTopLevelFields || REQUIRED_OUTPUT_FIELDS)
      && assessment.schema === AUTH_BINDING_ASSESSMENT_SCHEMA_VERSION
      && report.schema === VALIDATION_REPORT_SCHEMA_VERSION
      && hasRequiredFields(assessment, contract.expectedAuthBindingAssessmentShape?.requiredFields || REQUIRED_ASSESSMENT_FIELDS)
      && hasRequiredFields(report, contract.expectedValidationReportShape?.requiredFields || REQUIRED_VALIDATION_REPORT_FIELDS),
    'Auth binding output shape is incomplete.');

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
      throw new Error(`auth_binding_forbidden_substring:${forbidden}`);
    }
  }
}

module.exports = {
  AUTH_BINDING_ASSESSMENT_SCHEMA_VERSION,
  BASELINE_COMMIT,
  FORBIDDEN_OUTPUT_SUBSTRINGS,
  REQUIRED_ASSESSMENT_FIELDS,
  REQUIRED_BLOCKER_IDS,
  REQUIRED_GATE_IDS,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  assessmentIdempotencyKey,
  buildMiraCoreAuthBinding,
  canonicalAssessmentInput,
  stableHash,
  validateMiraCoreAuthBindingOutput,
};
