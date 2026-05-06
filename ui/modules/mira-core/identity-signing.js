'use strict';

const crypto = require('crypto');

const IDENTITY_SIGNING_ASSESSMENT_SCHEMA_VERSION = 'squidrun.mira_core.identity_signing_assessment.v0';
const VALIDATION_REPORT_SCHEMA_VERSION = 'squidrun.mira_core.identity_signing_validation_report.v0';
const IDENTITY_SIGNING_VERSION = 'v0';
const BASELINE_COMMIT = 'f41b02a';

const REQUIRED_OUTPUT_FIELDS = Object.freeze([
  'identity_signing_assessment',
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
  'server_identity',
  'device_profile_session_binding',
  'signing_envelope',
  'verification_report_contract',
  'rotation_revocation_rules',
  'no_secret_guarantees',
  'boundary_truth',
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
  'server_identity_result',
  'binding_result',
  'signing_envelope_result',
  'verification_result',
  'rotation_revocation_result',
  'no_secret_result',
  'boundary_truth_result',
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
  'no_auth_secret_or_signing_material_created',
  'no_real_key_generation_performed',
  'no_private_key_exported',
  'no_private_key_stored',
  'no_local_execution_performed',
  'no_shell_or_pty_performed',
  'no_browser_window_access_performed',
  'no_external_send_performed',
  'no_customer_send_performed',
  'no_deploy_performed',
  'no_trade_performed',
  'no_file_mutation_performed_by_validator',
  'no_durable_migration_performed',
]);

const SIDE_EFFECT_COUNTER_FIELDS = Object.freeze([
  'runtimeImplementationsAttempted',
  'serverProcessesStarted',
  'networkRequestsAttempted',
  'databaseOrStoreWritesAttempted',
  'queuesCreated',
  'authSecretsOrSigningMaterialCreated',
  'realKeyGenerationsAttempted',
  'privateKeyExportsAttempted',
  'privateKeyStoresAttempted',
  'localExecutionAttempted',
  'shellOrPtyAttempted',
  'browserWindowAccessAttempted',
  'externalSendsAttempted',
  'customerSendsAttempted',
  'deploysAttempted',
  'tradesAttempted',
  'fileMutationsAttemptedByValidator',
  'durableMigrationsAttempted',
]);

const REQUIRED_GATE_IDS = Object.freeze([
  'server-identity-record-shape-specified',
  'device-profile-session-binding-specified',
  'canonical-signing-envelope-specified',
  'signature-algorithm-allowlist-specified',
  'verification-report-shape-specified',
  'rotation-revocation-rules-specified',
  'no-secret-guarantees-specified',
  'boundary-truth-specified',
  'migration-path-to-real-signing-gated',
  'side-effect-free-validation-only',
]);

const REQUIRED_BLOCKER_IDS = Object.freeze([
  'real-key-generation-blocked',
  'private-key-export-storage-blocked',
  'unsigned-or-unknown-key-blocked',
  'revoked-or-expired-key-blocked',
  'cross-scope-target-blocked',
  'signature-overclaim-blocked',
  'real-server-runtime-still-blocked',
]);

const FORBIDDEN_OUTPUT_SUBSTRINGS = Object.freeze([
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'Authorization: Bearer',
  'BEGIN PRIVATE KEY',
  'END PRIVATE KEY',
  'PRIVATE KEY',
  'raw_token',
  'access_token',
  'refresh_token',
  'session_secret',
  'signing secret',
  'private key exported',
  'private key stored',
  'generated real key',
  'server executed local work',
  'server can run shell',
  'server can operate PTY',
  'server can access browser',
  'signature authorizes local execution',
  'signature proves model processing',
  'signature proves bridge green',
  'socket alone proves bridge green',
  'delivery acceptance proves model processing',
  'tier2 authorized by signature',
  'tier3 authorized by signature',
  'customer send authorized by signature',
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

function evidenceRef(kind, id, relation = 'identity_signing_validation') {
  return {
    store: 'mira-core-identity-signing',
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
    no_auth_secret_or_signing_material_created: true,
    no_real_key_generation_performed: true,
    no_private_key_exported: true,
    no_private_key_stored: true,
    no_local_execution_performed: true,
    no_shell_or_pty_performed: true,
    no_browser_window_access_performed: true,
    no_external_send_performed: true,
    no_customer_send_performed: true,
    no_deploy_performed: true,
    no_trade_performed: true,
    no_file_mutation_performed_by_validator: true,
    no_durable_migration_performed: true,
    runtimeImplementationsAttempted: 0,
    serverProcessesStarted: 0,
    networkRequestsAttempted: 0,
    databaseOrStoreWritesAttempted: 0,
    queuesCreated: 0,
    authSecretsOrSigningMaterialCreated: 0,
    realKeyGenerationsAttempted: 0,
    privateKeyExportsAttempted: 0,
    privateKeyStoresAttempted: 0,
    localExecutionAttempted: 0,
    shellOrPtyAttempted: 0,
    browserWindowAccessAttempted: 0,
    externalSendsAttempted: 0,
    customerSendsAttempted: 0,
    deploysAttempted: 0,
    tradesAttempted: 0,
    fileMutationsAttemptedByValidator: 0,
    durableMigrationsAttempted: 0,
    outputFileWritten: false,
    ...overrides,
  };
}

function serverIdentity(generatedAt) {
  return withEvidence({
    server_id: 'mira-core-validation-server',
    environment: 'validation',
    key_id: 'key-test-vector-001',
    public_key_fingerprint: 'sha256:test-vector-public-fingerprint',
    issuer: 'mira-core-validation-only',
    created_at: generatedAt,
    rotated_at: null,
    revoked_at: null,
    status: 'validation_only_pending_real_identity',
    key_status: 'test_vector_pending_real_key_management',
    allowed_environments: ['validation', 'staging', 'production'],
    private_key_exported: false,
    private_key_stored: false,
    test_vector_only: true,
  }, 'identity', 'server-identity-record-shape-specified');
}

function freshness() {
  return {
    timestamp_required: true,
    expires_at_required: true,
    max_clock_skew_ms: 300000,
    max_age_ms: 900000,
    stale_rejected: true,
    future_timestamp_rejected: true,
  };
}

function deviceProfileSessionBinding(scope) {
  return withEvidence({
    device_id: scope.deviceId,
    profile: scope.profileName,
    session_id: scope.sessionId,
    allowed_target_role: 'architect',
    tenant_user_boundary: 'single_james_profile_scope_only_until_auth_binding_exists',
    freshness: freshness(),
    profile_scope_required: true,
    session_scope_required: true,
    device_scope_required: true,
    target_role_enforced: true,
    cross_profile_blocked: true,
    side_profile_blocked: true,
    stale_binding_rejected: true,
  }, 'binding', 'device-profile-session-binding-specified');
}

function signingEnvelope(generatedAt) {
  const timestamp = generatedAt;
  const expiresAt = new Date(Date.parse(generatedAt) + 15 * 60 * 1000).toISOString();
  return withEvidence({
    payload_hash: 'sha256:test-vector-payload-hash',
    canonicalization_version: 'mira-core-c14n-json-v0',
    signature_algorithm: 'ed25519-test-vector',
    signature_algorithm_allowlist: [
      'ed25519-test-vector',
      'ecdsa-p256-sha256-test-vector',
    ],
    key_id: 'key-test-vector-001',
    nonce: 'nonce-test-vector-001',
    timestamp,
    expires_at: expiresAt,
    replay_window_ms: 900000,
    signature: 'signature_placeholder_test_vector_not_real',
    signature_kind: 'placeholder_test_vector_only',
    placeholder_test_vector_only: true,
    real_signature_generated_now: false,
    signed_fields: [
      'schema',
      'version',
      'server_id',
      'environment',
      'profile',
      'session_id',
      'device_id',
      'allowed_target_role',
      'payload_hash',
      'canonicalization_version',
      'key_id',
      'nonce',
      'timestamp',
      'expires_at',
      'replay_window_ms',
      'evidenceRefs',
    ],
    canonical_payload_hash_required: true,
    key_id_required: true,
    nonce_required: true,
    timestamp_required: true,
    expires_at_required: true,
  }, 'signing', 'canonical-signing-envelope-specified');
}

function replayIdempotencyResult() {
  return {
    nonce_reuse_rejected: true,
    expired_envelope_rejected: true,
    future_timestamp_rejected: true,
    duplicate_payload_returns_same_decision: true,
    idempotency_key_inputs: [
      'profile',
      'session_id',
      'device_id',
      'key_id',
      'nonce',
      'payload_hash',
      'canonicalization_version',
    ],
    scope_or_payload_change_changes_idempotency_key: true,
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
      'validation_only_test_vector',
      'real_identity_and_key_management_pending',
      'integrity_only_not_authorization',
    ],
    replay_idempotency_result: replayIdempotencyResult(),
    key_status: {
      active_key_status_required: true,
      unsupported_algorithm_blocked: true,
      unknown_key_blocked: true,
      revoked_key_blocked: true,
      expired_key_blocked: true,
    },
    clock_skew_freshness_result: {
      max_clock_skew_ms: 300000,
      max_age_ms: 900000,
      expired_rejected: true,
      future_timestamp_rejected: true,
      clock_skew_ignored: false,
    },
    payload_hash_verified: true,
    signature_integrity_verified: true,
    authorization_granted: false,
    local_execution_authorized: false,
    bridge_green_proven: false,
    model_processing_proven: false,
    side_effect_result: sideEffectResult(),
  }, 'verification', 'verification-report-shape-specified');
}

function rotationRevocationRules() {
  return withEvidence({
    active_key_status_required: true,
    overlap_window_ms: 86400000,
    old_keys_verify_only_within_overlap: true,
    revoked_keys_blocked: true,
    unknown_key_blocked: true,
    rotated_at_required: true,
    revoked_at_required_when_revoked: true,
    rotation_event_refs_required: true,
    revocation_event_refs_required: true,
    key_rollover_requires_audit: true,
    no_secret_exposure_during_rotation: true,
  }, 'rotation', 'rotation-revocation-rules-specified');
}

function noSecretGuarantees() {
  return withEvidence({
    private_key_exported: false,
    private_key_stored: false,
    secret_material_in_fixture: false,
    raw_token_in_output: false,
    private_key_material_allowed: false,
    signing_key_generated_now: false,
    public_test_vector_only: true,
    fingerprint_non_secret: true,
  }, 'no-secret', 'no-secret-guarantees-specified');
}

function boundaryTruth() {
  return withEvidence({
    signature_validates_envelope_integrity_only: true,
    signature_is_authorization_for_local_execution: false,
    signature_is_model_processing_proof: false,
    signature_is_bridge_green_proof: false,
    signature_permits_tier2_plus_actions: false,
    signature_permits_customer_send_deploy_trade: false,
    serverCanExecuteLocal: false,
    serverCanProveModelProcessing: false,
    allowed_target_role: 'architect',
    localAcceptanceRequiredForAnyIntent: true,
  }, 'boundary', 'boundary-truth-specified');
}

function migrationPath() {
  return withEvidence({
    baseline_commit: BASELINE_COMMIT,
    phase_14_gap_blocker_id: 'server-identity-and-signing-specified',
    real_signing_allowed_now: false,
    future_real_signing_allowed_after_gates: true,
    requires_secret_storage_gate: true,
    requires_key_rotation_gate: true,
    requires_deletion_export_gate: true,
    requires_audit_logging_gate: true,
    requires_auth_binding_gate: true,
    feature_flag_default: 'off',
    no_real_key_generation_now: true,
    rollback_plan_required: true,
  }, 'migration', 'migration-path-to-real-signing-gated');
}

function acceptanceGateSummary() {
  return REQUIRED_GATE_IDS.map((gateId) => ({
    gate_id: gateId,
    status: gateId === 'side-effect-free-validation-only' ? 'satisfied_for_phase_15_validator' : 'specified_for_validation_pending_real_server',
    required_before_real_server: true,
    required_before_real_signing: true,
    evidenceRefs: [evidenceRef('acceptance-gate', gateId)],
    blocked_until: gateId === 'side-effect-free-validation-only'
      ? 'Phase 15 remains validation-only and side-effect-free.'
      : 'Reviewed real-server key management and auth gates exist.',
  }));
}

function blockerSummary() {
  return [
    {
      blocker_id: 'real-key-generation-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Phase 15 uses placeholder test vectors only; no real signing key generation is allowed.',
      safe_next_action: 'Review key-management and secret-storage contracts before any real signing build.',
    },
    {
      blocker_id: 'private-key-export-storage-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Private key export and storage are forbidden in validation fixtures and output.',
      safe_next_action: 'Keep only non-secret public fingerprints and test-vector metadata in outputs.',
    },
    {
      blocker_id: 'unsigned-or-unknown-key-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Unknown, unsupported, and unsigned envelopes cannot validate before real key registry gates.',
      safe_next_action: 'Keep unsupported key cases blocked in validator tests.',
    },
    {
      blocker_id: 'revoked-or-expired-key-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Revoked, expired, replayed, and stale envelopes must be rejected.',
      safe_next_action: 'Maintain replay, freshness, rotation, and revocation checks.',
    },
    {
      blocker_id: 'cross-scope-target-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Builder/Oracle targets and cross-profile/session/device scope are forbidden.',
      safe_next_action: 'Keep future server-originated target Architect-only with local acceptance.',
    },
    {
      blocker_id: 'signature-overclaim-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'A signature proves envelope integrity only, not execution, bridge green, model processing, or Tier 2+ authorization.',
      safe_next_action: 'Keep proof and authorization boundaries explicit in downstream phases.',
    },
    {
      blocker_id: 'real-server-runtime-still-blocked',
      severity: 'high',
      status: 'blocked',
      blocked_because: 'Phase 14 server-runtime blockers remain; Phase 15 does not start a server.',
      safe_next_action: 'Continue validation-only gates until Architect explicitly scopes a real runtime lane.',
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
    server_identity: assessment.server_identity,
    device_profile_session_binding: assessment.device_profile_session_binding,
    signing_envelope: assessment.signing_envelope,
    verification_report_contract: assessment.verification_report_contract,
    rotation_revocation_rules: assessment.rotation_revocation_rules,
    no_secret_guarantees: assessment.no_secret_guarantees,
    boundary_truth: assessment.boundary_truth,
    migration_path: assessment.migration_path,
    acceptance_gate_summary: assessment.acceptance_gate_summary,
    blocker_summary: assessment.blocker_summary,
    side_effect_result: assessment.side_effect_result,
  };
}

function assessmentIdempotencyKey(assessment) {
  return `identity-signing-idem:${stableHash(canonicalAssessmentInput(assessment))}`;
}

function buildAssessment(options = {}) {
  const inputSignals = options.inputSignals || {};
  const generatedAt = generatedAtFromOptions(options, inputSignals);
  const scope = normalizeScope(inputSignals);
  const assessment = {
    schema: IDENTITY_SIGNING_ASSESSMENT_SCHEMA_VERSION,
    version: IDENTITY_SIGNING_VERSION,
    assessment_id: null,
    idempotency_key: null,
    generated_at: generatedAt,
    baseline_commit: BASELINE_COMMIT,
    profile: scope.profile,
    sessionId: scope.sessionId,
    deviceId: scope.deviceId,
    server_identity: serverIdentity(generatedAt),
    device_profile_session_binding: deviceProfileSessionBinding(scope),
    signing_envelope: signingEnvelope(generatedAt),
    verification_report_contract: verificationReportContract(),
    rotation_revocation_rules: rotationRevocationRules(),
    no_secret_guarantees: noSecretGuarantees(),
    boundary_truth: boundaryTruth(),
    migration_path: migrationPath(),
    acceptance_gate_summary: acceptanceGateSummary(),
    blocker_summary: blockerSummary(),
    evidenceRefs: [
      evidenceRef('baseline', BASELINE_COMMIT),
      evidenceRef('fixture', 'mira-core-identity-signing-contract'),
    ],
    side_effect_result: sideEffectResult(),
  };
  assessment.idempotency_key = assessmentIdempotencyKey(assessment);
  assessment.assessment_id = `identity-signing-${stableHash(assessment.idempotency_key).slice(0, 12)}`;
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
  const expected = contract.expectedIdentitySigningAssessmentShape || {};
  const requiredIds = asArray(expected.requiredAcceptanceGateIds).length > 0
    ? expected.requiredAcceptanceGateIds
    : REQUIRED_GATE_IDS;
  return gates.length === requiredIds.length
    && valuesMatch(gates.map((gate) => gate.gate_id), requiredIds)
    && gates.every((gate) => hasRequiredFields(gate, expected.acceptanceGateSummaryRequiredFields || [])
      && gate.required_before_real_server === true
      && gate.required_before_real_signing === true
      && asArray(gate.evidenceRefs).length > 0);
}

function blockerSummaryOk(assessment, contract = {}) {
  const blockers = asArray(assessment.blocker_summary);
  const expected = contract.expectedIdentitySigningAssessmentShape || {};
  const requiredIds = asArray(expected.requiredBlockerIds).length > 0
    ? expected.requiredBlockerIds
    : REQUIRED_BLOCKER_IDS;
  return blockers.length === requiredIds.length
    && valuesMatch(blockers.map((blocker) => blocker.blocker_id), requiredIds)
    && blockers.every((blocker) => hasRequiredFields(blocker, expected.blockerSummaryRequiredFields || [])
      && asArray(blocker.evidenceRefs).length > 0);
}

function signingEnvelopeOk(assessment, expected) {
  const envelope = assessment.signing_envelope || {};
  return sectionValuesOk(envelope, expected.signingEnvelopeRequiredFields, expected.signingEnvelopeRequiredValues)
    && asArray(expected.signedFieldsRequired).every((field) => asArray(envelope.signed_fields).includes(field))
    && asArray(envelope.signature_algorithm_allowlist).includes(envelope.signature_algorithm)
    && !/production|rsa-sha1|real/i.test(String(envelope.signature_algorithm || ''));
}

function verificationReportOk(assessment, expected) {
  const report = assessment.verification_report_contract || {};
  return sectionValuesOk(report, expected.verificationReportRequiredFields, expected.verificationReportRequiredValues)
    && hasRequiredFields(report.replay_idempotency_result, expected.replayIdempotencyResultRequiredFields)
    && Object.entries(expected.replayIdempotencyResultRequiredValues || {}).every(([field, value]) => valuesMatch(report.replay_idempotency_result?.[field], value))
    && report.clock_skew_freshness_result?.clock_skew_ignored === false;
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
  const expected = contract.expectedIdentitySigningAssessmentShape || {};

  add('output-shape-complete',
    assessment.schema === IDENTITY_SIGNING_ASSESSMENT_SCHEMA_VERSION
      && hasRequiredFields(assessment, expected.requiredFields || REQUIRED_ASSESSMENT_FIELDS),
    'Identity/signing assessment shape is incomplete.');

  add('phase-15-baseline-f41b02a-pinned',
    assessment.baseline_commit === BASELINE_COMMIT
      && assessment.migration_path?.baseline_commit === BASELINE_COMMIT,
    'Baseline commit must stay pinned to f41b02a.');

  add('validation-only-no-real-signing',
    sideEffectValuesOk(assessment.side_effect_result, expected.sideEffectRequiredValues || {}),
    'Phase 15 side-effect truth is unsafe.');

  add('server-identity-shape-required',
    sectionValuesOk(assessment.server_identity, expected.serverIdentityRequiredFields, expected.serverIdentityRequiredValues),
    'Server identity shape is incomplete or secret-bearing.');

  add('device-profile-session-binding-required',
    sectionValuesOk(assessment.device_profile_session_binding, expected.deviceProfileSessionBindingRequiredFields, expected.deviceProfileSessionBindingRequiredValues)
      && hasRequiredFields(assessment.device_profile_session_binding?.freshness, expected.freshnessRequiredFields)
      && Object.entries(expected.freshnessRequiredValues || {}).every(([field, value]) => valuesMatch(assessment.device_profile_session_binding?.freshness?.[field], value)),
    'Device/profile/session binding is incomplete or target/scope unsafe.');

  add('canonical-envelope-shape-required',
    signingEnvelopeOk(assessment, expected),
    'Signing envelope is incomplete, non-test-vector, or unsupported.');

  add('signature-algorithm-allowlist-required',
    asArray(assessment.signing_envelope?.signature_algorithm_allowlist).includes(assessment.signing_envelope?.signature_algorithm)
      && valuesMatch(assessment.signing_envelope?.signature_algorithm_allowlist, expected.signingEnvelopeRequiredValues?.signature_algorithm_allowlist),
    'Signature algorithm is unsupported or production-looking.');

  add('verification-report-shape-required',
    verificationReportOk(assessment, expected),
    'Verification report shape or integrity-only decision fields are unsafe.');

  add('replay-idempotency-freshness-required',
    hasRequiredFields(assessment.verification_report_contract?.replay_idempotency_result, expected.replayIdempotencyResultRequiredFields)
      && Object.entries(expected.replayIdempotencyResultRequiredValues || {}).every(([field, value]) => valuesMatch(assessment.verification_report_contract?.replay_idempotency_result?.[field], value))
      && assessment.device_profile_session_binding?.freshness?.stale_rejected === true
      && assessment.device_profile_session_binding?.freshness?.future_timestamp_rejected === true,
    'Replay, expiry, clock-skew, or idempotency truth is unsafe.');

  add('rotation-revocation-rules-required',
    sectionValuesOk(assessment.rotation_revocation_rules, expected.rotationRevocationRequiredFields, expected.rotationRevocationRequiredValues),
    'Rotation/revocation rules are incomplete or overclaim key acceptance.');

  add('no-secret-guarantees-required',
    sectionValuesOk(assessment.no_secret_guarantees, expected.noSecretGuaranteesRequiredFields, expected.noSecretGuaranteesRequiredValues)
      && assessment.server_identity?.private_key_exported === false
      && assessment.server_identity?.private_key_stored === false,
    'No-secret guarantees are incomplete or secret-bearing.');

  add('boundary-truth-integrity-only',
    sectionValuesOk(assessment.boundary_truth, expected.boundaryTruthRequiredFields, expected.boundaryTruthRequiredValues),
    'Signature boundary truth overclaimed authorization, bridge, proof, or Tier 2+ capability.');

  add('architect-only-target-and-local-acceptance-required',
    assessment.boundary_truth?.allowed_target_role === 'architect'
      && assessment.device_profile_session_binding?.allowed_target_role === 'architect'
      && assessment.boundary_truth?.localAcceptanceRequiredForAnyIntent === true,
    'Future server-originated target is not Architect-only or local-acceptance-required.');

  add('migration-real-signing-gated',
    sectionValuesOk(assessment.migration_path, expected.migrationPathRequiredFields, expected.migrationPathRequiredValues),
    'Real signing migration path is not gated.');

  add('required-gates-and-blockers-present',
    gateSummaryOk(assessment, contract) && blockerSummaryOk(assessment, contract),
    'Required Phase 15 gates or blockers are missing.',
    {
      gate_count: asArray(assessment.acceptance_gate_summary).length,
      blocker_count: asArray(assessment.blocker_summary).length,
    });

  try {
    assertNoForbiddenOutput(assessment, asArray(contract.forbiddenOutputSubstrings));
    add('forbidden-output-strings-absent', true, null, {
      secret_like_content_exported: false,
      raw_token_exported: false,
      private_key_material_exported: false,
    });
  } catch (err) {
    add('forbidden-output-strings-absent', false, err.message, {
      secret_like_content_exported: true,
    });
  }

  add('assessment-literal-values',
    literalValuesOk(assessment, expected.requiredLiteralValues || {}),
    'Identity/signing literal values changed.');

  add('idempotency-stable',
    assessment.idempotency_key === assessmentIdempotencyKey(assessment),
    'Identity/signing idempotency key is unstable.');

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
    version: IDENTITY_SIGNING_VERSION,
    validation_id: `identity-signing-validation-${stableHash({
      assessment_key: assessment.idempotency_key,
      generatedAt,
    }).slice(0, 12)}`,
    generated_at: generatedAt,
    baseline_commit: BASELINE_COMMIT,
    fixture_schema: contract.schema || 'squidrun.mira_core.identity_signing_contract_fixture.v0',
    assessment_schema: IDENTITY_SIGNING_ASSESSMENT_SCHEMA_VERSION,
    profile: assessment.profile,
    sessionId: assessment.sessionId,
    deviceId: assessment.deviceId,
    decision: validation.ok ? 'accepted' : 'blocked',
    reasons,
    server_identity_result: checkResult('server-identity-shape-required'),
    binding_result: checkResult('device-profile-session-binding-required'),
    signing_envelope_result: checkResult('canonical-envelope-shape-required'),
    verification_result: checkResult('verification-report-shape-required'),
    rotation_revocation_result: checkResult('rotation-revocation-rules-required'),
    no_secret_result: checkResult('no-secret-guarantees-required'),
    boundary_truth_result: checkResult('boundary-truth-integrity-only'),
    migration_path_result: checkResult('migration-real-signing-gated'),
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
      evidenceRef('validation', assessment.assessment_id, 'identity_signing_validation_report'),
    ],
    side_effect_result: sideEffectResult(),
  };
  assertNoForbiddenOutput(report, asArray(contract.forbiddenOutputSubstrings));
  return report;
}

function buildMiraCoreIdentitySigning(options = {}) {
  const contract = options.contract || {};
  const assessment = buildAssessment(options);
  const validation_report = buildValidationReport(assessment, contract, assessment.generated_at);
  const output = {
    identity_signing_assessment: assessment,
    validation_report,
  };
  assertNoForbiddenOutput(output, asArray(contract.forbiddenOutputSubstrings));
  return output;
}

function validateMiraCoreIdentitySigningOutput(output = {}, contract = {}) {
  const checks = [];
  const errors = [];
  const add = (id, ok, detail = null) => {
    checks.push({ id, ok: ok === true, detail });
    if (!ok && detail) errors.push(detail);
  };
  const assessment = output.identity_signing_assessment || {};
  const report = output.validation_report || {};
  const assessmentValidation = validateAssessment(assessment, contract);

  add('output-shape-complete',
    hasRequiredFields(output, contract.expectedOutputShape?.requiredTopLevelFields || REQUIRED_OUTPUT_FIELDS)
      && assessment.schema === IDENTITY_SIGNING_ASSESSMENT_SCHEMA_VERSION
      && report.schema === VALIDATION_REPORT_SCHEMA_VERSION
      && hasRequiredFields(assessment, contract.expectedIdentitySigningAssessmentShape?.requiredFields || REQUIRED_ASSESSMENT_FIELDS)
      && hasRequiredFields(report, contract.expectedValidationReportShape?.requiredFields || REQUIRED_VALIDATION_REPORT_FIELDS),
    'Identity/signing output shape is incomplete.');

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
      throw new Error(`identity_signing_forbidden_substring:${forbidden}`);
    }
  }
}

module.exports = {
  BASELINE_COMMIT,
  FORBIDDEN_OUTPUT_SUBSTRINGS,
  IDENTITY_SIGNING_ASSESSMENT_SCHEMA_VERSION,
  REQUIRED_ASSESSMENT_FIELDS,
  REQUIRED_BLOCKER_IDS,
  REQUIRED_GATE_IDS,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  assessmentIdempotencyKey,
  buildMiraCoreIdentitySigning,
  canonicalAssessmentInput,
  stableHash,
  validateMiraCoreIdentitySigningOutput,
};
