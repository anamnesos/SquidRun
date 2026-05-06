'use strict';

const crypto = require('crypto');

const GAP_ASSESSMENT_SCHEMA_VERSION = 'squidrun.mira_core.server_runtime_gap_assessment.v0';
const VALIDATION_REPORT_SCHEMA_VERSION = 'squidrun.mira_core.server_runtime_gap_validation_report.v0';
const SERVER_RUNTIME_GAP_VERSION = 'v0';
const BASELINE_COMMIT = '785dbec';

const REQUIRED_OUTPUT_FIELDS = Object.freeze([
  'server_runtime_gap_assessment',
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
  'baseline_refs',
  'server_identity',
  'signing_envelope',
  'auth_binding',
  'receive_store_policy',
  'deletion_export_retention',
  'replay_idempotency_watermarks',
  'offline_local_arms_status',
  'server_to_local_intent_limits',
  'bridge_delivery_proof_truth',
  'migration_boundary',
  'acceptance_gate_summary',
  'blocker_summary',
  'evidenceRefs',
  'side_effect_result',
]);

const REQUIRED_VALIDATION_REPORT_FIELDS = Object.freeze([
  'schema',
  'version',
  'validation_run_id',
  'generated_at',
  'fixture_schema',
  'gap_assessment_schema',
  'baseline_commit',
  'required_shape_count',
  'static_rule_count',
  'acceptance_check_count',
  'required_gate_count',
  'required_blocker_count',
  'identity_signing_result',
  'auth_binding_result',
  'receive_store_result',
  'deletion_export_retention_result',
  'replay_watermark_result',
  'offline_local_arms_result',
  'server_to_local_intent_result',
  'bridge_delivery_proof_result',
  'migration_boundary_result',
  'forbidden_output_result',
  'side_effect_result',
  'passed',
  'reasons',
  'evidenceRefs',
]);

const REQUIRED_SIDE_EFFECT_FIELDS = Object.freeze([
  'no_runtime_implementation_performed',
  'no_server_process_started',
  'no_network_performed',
  'no_database_or_store_write_performed',
  'no_queue_created',
  'no_auth_secret_or_signing_material_created',
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
  'server-identity-and-signing-specified',
  'auth-session-device-profile-binding-specified',
  'redacted-receive-store-policy-specified',
  'deletion-export-retention-controls-specified',
  'replay-idempotency-watermarks-specified',
  'offline-local-arms-status-truth-specified',
  'server-to-local-intent-limitations-specified',
  'bridge-delivery-proof-truth-specified',
  'migration-boundary-from-phase-1-13-specified',
  'side-effect-free-validation-only',
]);

const REQUIRED_BLOCKER_IDS = Object.freeze([
  'real-server-runtime-blocked-pending-identity-signing',
  'receive-store-blocked-pending-auth-redaction-storage-contract',
  'server-intents-blocked-pending-local-acceptance-contract',
  'deletion-export-retention-blocked-pending-controls',
  'migration-blocked-pending-phase-14-gates',
]);

const FORBIDDEN_OUTPUT_SUBSTRINGS = Object.freeze([
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'Authorization: Bearer',
  'BEGIN PRIVATE KEY',
  'private key exported',
  'raw comms transcript',
  'raw terminal scrollback',
  'raw screenshot OCR',
  'browser profile',
  'customer phone',
  'customer address',
  'side profile',
  'server executed local work',
  'server can run shell',
  'server can operate PTY',
  'server can access browser',
  'server sent customer message',
  'server deployed',
  'server placed trade',
  'socket alone proves bridge green',
  'delivery acceptance proves model processing',
  'lease proves model processing',
  'phase 1-13 migrated to server store',
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

function evidenceRef(kind, id, relation = 'server_runtime_gap_assessment') {
  return {
    store: 'mira-core-server-runtime-gap',
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

function baselineRefs() {
  return withEvidence({
    commit: BASELINE_COMMIT,
    phase_range: '1-13',
    readiness_fixture_path: 'ui/__tests__/fixtures/mira-core-readiness-contract.json',
    readiness_manifest_schema: 'squidrun.mira_core.readiness_manifest.v0',
    server_upload_fixture_path: 'ui/__tests__/fixtures/mira-core-server-upload-contract.json',
    intent_queue_fixture_path: 'ui/__tests__/fixtures/mira-core-intent-queue-contract.json',
    local_acceptance_fixture_path: 'ui/__tests__/fixtures/mira-core-local-acceptance-contract.json',
    server_boundary_fixture_path: 'ui/__tests__/fixtures/mira-core-server-boundary-contract.json',
    known_green_report_refs: [
      'Phase 1-13 combined PASS 182/182 across 13 suites',
      'Architect accepted baseline commit 785dbec',
    ],
    boundary_summary: 'Phase 1-13 is a read-only validation package; Phase 14 assesses gaps before any future runtime.',
  }, 'baseline', BASELINE_COMMIT);
}

function serverIdentity() {
  return withEvidence({
    status: 'blocked_until_specified_and_reviewed',
    server_instance_id_required: true,
    environment_required: true,
    public_key_ref_required: true,
    private_key_exported: false,
    key_rotation_policy_required: true,
    identity_document_schema: 'squidrun.mira_core.server_identity_document.v0',
    issuer: 'mira-core-server-runtime-gap',
    audience: 'squidrun-local-architect',
    allowed_clock_skew_ms: 300000,
    revocation_policy_required: true,
    not_implemented_now: true,
    blocking_gaps: [
      'server_instance_identity_contract',
      'public_key_reference_contract',
      'rotation_and_revocation_policy',
    ],
  }, 'gate', 'server-identity');
}

function signingEnvelope() {
  return withEvidence({
    status: 'blocked_until_canonical_signing_contract',
    envelope_schema: 'squidrun.mira_core.server_receive_signature_envelope.v0',
    algorithm_allowlist: ['ed25519', 'p256'],
    canonicalization_required: true,
    signed_fields: [
      'profile',
      'sessionId',
      'deviceId',
      'idempotency_key',
      'nonce',
      'timestamp',
      'source_watermarks',
      'redaction_audit',
    ],
    signature_required_for_receive: true,
    unsigned_payload_rejected: true,
    key_id_required: true,
    nonce_required: true,
    timestamp_required: true,
    watermarks_signed: true,
    idempotency_key_signed: true,
    profile_session_device_signed: true,
    redaction_audit_signed: true,
    not_implemented_now: true,
    blocking_gaps: [
      'canonical_json_contract',
      'signature_verification_contract',
      'nonce_and_timestamp_contract',
    ],
  }, 'gate', 'signing-envelope');
}

function authBinding() {
  return withEvidence({
    status: 'blocked_until_auth_session_device_profile_contract',
    auth_subject_required: true,
    session_binding_required: true,
    device_binding_required: true,
    profile_binding_required: true,
    scope_allowlist_required: true,
    token_audience_required: true,
    expiry_required: true,
    profile_mismatch_rejected: true,
    session_mismatch_rejected: true,
    device_mismatch_rejected: true,
    cross_profile_access_blocked: true,
    side_profile_access_blocked: true,
    not_implemented_now: true,
    blocking_gaps: [
      'auth_subject_binding_contract',
      'profile_session_device_scope_contract',
      'expiry_and_audience_contract',
    ],
  }, 'gate', 'auth-binding');
}

function receiveStorePolicy(contract = {}) {
  const expected = contract.expectedGapAssessmentShape || {};
  return withEvidence({
    status: 'blocked_until_real_receive_store_contract',
    eligible_syncEligibility: clone(expected.eligibleSyncEligibility || ['core_sync_safe', 'core_sync_redacted']),
    eligible_redactionStatus: clone(expected.eligibleRedactionStatus || ['none', 'applied']),
    required_item_fields: [
      'id',
      'kind',
      'summary',
      'source',
      'authority',
      'syncEligibility',
      'redactionStatus',
      'profile',
      'sessionId',
      'deviceId',
      'freshnessAt',
      'evidenceRefs',
      'source_trace',
      'source_watermark_ref',
      'payload_hash',
    ],
    blocked_syncEligibility: clone(expected.blockedSyncEligibility || ['blocked', 'local_only', 'approval_required']),
    blocked_raw_classes: clone(expected.blockedRawClasses || [
      'raw_comms',
      'raw_terminal',
      'raw_screenshot_ocr',
      'raw_browser_state',
      'secrets_auth_material',
      'customer_private_data',
      'side_profile_content',
      'raw_database_payload',
    ]),
    profile_session_device_scope_required: true,
    signature_verified_required: true,
    auth_binding_verified_required: true,
    redaction_audit_required: true,
    store_shape_allowed: 'redacted_summaries_refs_hashes_only_after_future_gates',
    raw_storage_allowed: false,
    withheld_summary_required: true,
    no_store_write_now: true,
    blocking_gaps: [
      'real_receive_store_contract',
      'redacted_storage_schema',
      'withheld_summary_audit_contract',
    ],
  }, 'gate', 'receive-store');
}

function deletionExportRetention() {
  return withEvidence({
    status: 'blocked_until_deletion_export_retention_contract',
    delete_request_shape_required: true,
    export_request_shape_required: true,
    retention_policy_required: true,
    tombstone_policy_required: true,
    audit_log_required: true,
    james_visible_controls_required: true,
    redacted_export_only: true,
    delete_is_idempotent: true,
    delete_requires_scope_binding: true,
    export_excludes_raw_private_content: true,
    retention_default_days_max: 30,
    no_deletion_or_export_now: true,
    blocking_gaps: [
      'delete_request_contract',
      'export_request_contract',
      'retention_and_tombstone_contract',
    ],
  }, 'gate', 'deletion-export-retention');
}

function replayIdempotencyWatermarks() {
  return withEvidence({
    status: 'blocked_until_replay_and_watermark_contract',
    idempotency_key_inputs: [
      'server_instance_id',
      'profile',
      'sessionId',
      'deviceId',
      'source_watermarks',
      'content_hash',
      'redaction_policy_hash',
      'scope_hash',
    ],
    replay_cache_required: true,
    nonce_reuse_rejected: true,
    watermark_regression_rejected: true,
    stale_snapshot_rejected_or_warned: true,
    duplicate_receive_returns_same_decision: true,
    content_hash_required: true,
    redaction_policy_hash_required: true,
    scope_hash_required: true,
    clock_skew_policy_required: true,
    blocking_gaps: [
      'replay_cache_contract',
      'watermark_regression_contract',
      'stale_snapshot_policy',
    ],
  }, 'gate', 'replay-idempotency-watermarks');
}

function offlineLocalArmsStatus() {
  return withEvidence({
    status: 'truthful_status_only_no_execution',
    serverCanExecuteLocal: false,
    serverCanOperatePTY: false,
    serverCanRunShell: false,
    serverCanAccessBrowserOrWindow: false,
    serverCanProveModelProcessing: false,
    localArmsOnlineProofRequired: true,
    architectRoleDiscoveryRequired: true,
    architectToArchitectTargetProofRequired: true,
    offline_status_allowed: true,
    unknown_status_allowed: true,
    socket_is_not_green: true,
    blocking_gaps: [
      'local_architect_role_discovery',
      'architect_to_architect_target_proof',
      'non_architect_cross_device_rejection',
    ],
  }, 'gate', 'offline-local-arms');
}

function serverToLocalIntentLimits() {
  return withEvidence({
    status: 'future_intent_preparation_only_until_local_acceptance',
    serverOriginatedTarget: 'architect',
    allowed_target_roles: ['architect'],
    blocked_direct_targets: ['builder', 'oracle'],
    allowed_risk_tiers: ['tier0_read_only', 'tier1_local_reversible'],
    blocked_risk_tiers: [
      'tier2_repo_mutation',
      'tier3_external_side_effect',
      'tier4_financial_or_irreversible',
    ],
    localAcceptanceRequired: true,
    accepted_status_allowed: 'pending_local_acceptance',
    queue_write_allowed_now: false,
    route_allowed_now: false,
    execution_allowed_now: false,
    payload_redaction_required: true,
    expires_at_required: true,
    dedupe_key_required: true,
    safe_next_action_required: true,
    blocking_gaps: [
      'future_intent_contract_review',
      'local_acceptance_gate',
      'dedupe_expiry_redaction_contract',
    ],
  }, 'gate', 'server-to-local-intents');
}

function bridgeDeliveryProofTruth() {
  return withEvidence({
    status: 'proof_boundaries_required',
    socketIsBridgeGreenProof: false,
    deliveryAcceptanceIsModelProcessingProof: false,
    bridge_green_requires: [
      'registered_architect_role_discovery',
      'architect_to_architect_target_proof',
      'non_architect_cross_device_targets_rejected',
    ],
    model_processing_proof_requires: [
      'recipient_quote_back',
      'or_equivalent_model_response_evidence',
    ],
    manual_enter_delivery_green_requires: [
      'no_visible_codex_input_stuck',
      'no_manual_unlock_focus_enter',
      'recipient_quote_back_via_hm_send',
    ],
    delivery_ack_statuses_not_enough: [
      'accepted',
      'accepted.daemon_pty_unverified',
      'routed_unverified_timeout',
    ],
    blocked_overclaims: [
      'socket_is_not_bridge_green',
      'accepted_delivery_is_not_model_proof',
      'dry_run_lease_is_not_model_proof',
    ],
  }, 'gate', 'bridge-delivery-proof');
}

function migrationBoundary() {
  return withEvidence({
    status: 'blocked_until_phase_14_gates_green',
    phase_1_13_baseline_commit: BASELINE_COMMIT,
    phase_1_13_remains_validation_only: true,
    real_server_runtime_blocked: true,
    feature_flag_default: 'off',
    requires_new_contracts: [
      'identity',
      'signing',
      'auth',
      'storage',
      'deletion_export_retention',
      'replay_watermarks',
    ],
    requires_test_gates: [
      'fixture_static_validation',
      'tamper_regressions',
      'side_effect_proof',
    ],
    requires_operator_review: true,
    raw_backfill_forbidden: true,
    durable_store_migration_forbidden_now: true,
    rollback_plan_required: true,
    audit_export_required: true,
    blocking_gaps: [
      'phase_14_gate_review',
      'rollback_plan_contract',
      'audit_export_contract',
    ],
  }, 'gate', 'migration-boundary');
}

function acceptanceGateSummary() {
  return REQUIRED_GATE_IDS.map((gateId) => ({
    gate_id: gateId,
    status: gateId === 'side-effect-free-validation-only' ? 'satisfied_for_phase_14_validator' : 'blocked_before_real_server',
    required_before_real_server: true,
    evidenceRefs: [evidenceRef('acceptance-gate', gateId)],
    blocked_until: gateId === 'side-effect-free-validation-only'
      ? 'Phase 14 remains validation-only and side-effect-free.'
      : 'Reviewed contract and fixture-backed implementation evidence exists.',
  }));
}

function blockerSummary() {
  return [
    {
      blocker_id: 'real-server-runtime-blocked-pending-identity-signing',
      severity: 'high',
      summary: 'Real server runtime remains blocked until server identity and canonical signing contracts are reviewed.',
      blocked_capability: 'real_server_runtime',
      unblocks_when: 'Server identity, public key refs, key rotation, revocation, and signing verification are specified and tested.',
    },
    {
      blocker_id: 'receive-store-blocked-pending-auth-redaction-storage-contract',
      severity: 'high',
      summary: 'Receive/store remains blocked until auth binding, redaction eligibility, and redacted storage shape are specified.',
      blocked_capability: 'receive_store',
      unblocks_when: 'Auth/session/device/profile binding plus redacted storage and withheld-summary contracts are green.',
    },
    {
      blocker_id: 'server-intents-blocked-pending-local-acceptance-contract',
      severity: 'high',
      summary: 'Server-originated local intents remain Architect-only and blocked before local acceptance.',
      blocked_capability: 'server_to_local_intents',
      unblocks_when: 'Tier 0/Tier 1 intent preparation and local acceptance gates are reviewed.',
    },
    {
      blocker_id: 'deletion-export-retention-blocked-pending-controls',
      severity: 'high',
      summary: 'Durable storage is blocked until deletion, export, retention, tombstone, and audit controls exist.',
      blocked_capability: 'durable_server_store',
      unblocks_when: 'James-visible deletion/export/retention controls and tests are approved.',
    },
    {
      blocker_id: 'migration-blocked-pending-phase-14-gates',
      severity: 'high',
      summary: 'Migration from the Phase 1-13 validation package remains blocked until all Phase 14 gates are reviewed.',
      blocked_capability: 'server_migration',
      unblocks_when: 'Phase 14 gate set, rollback plan, and audit export are complete.',
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
    baseline_refs: assessment.baseline_refs,
    server_identity: assessment.server_identity,
    signing_envelope: assessment.signing_envelope,
    auth_binding: assessment.auth_binding,
    receive_store_policy: assessment.receive_store_policy,
    deletion_export_retention: assessment.deletion_export_retention,
    replay_idempotency_watermarks: assessment.replay_idempotency_watermarks,
    offline_local_arms_status: assessment.offline_local_arms_status,
    server_to_local_intent_limits: assessment.server_to_local_intent_limits,
    bridge_delivery_proof_truth: assessment.bridge_delivery_proof_truth,
    migration_boundary: assessment.migration_boundary,
    acceptance_gate_summary: assessment.acceptance_gate_summary,
    blocker_summary: assessment.blocker_summary,
    side_effect_result: assessment.side_effect_result,
  };
}

function assessmentIdempotencyKey(assessment) {
  return `server-runtime-gap-idem:${stableHash(canonicalAssessmentInput(assessment))}`;
}

function buildGapAssessment(options = {}) {
  const inputSignals = options.inputSignals || {};
  const contract = options.contract || {};
  const generatedAt = generatedAtFromOptions(options, inputSignals);
  const scope = normalizeScope(inputSignals);
  const assessment = {
    schema: GAP_ASSESSMENT_SCHEMA_VERSION,
    version: SERVER_RUNTIME_GAP_VERSION,
    assessment_id: null,
    idempotency_key: null,
    generated_at: generatedAt,
    baseline_commit: BASELINE_COMMIT,
    profile: scope.profile,
    sessionId: scope.sessionId,
    deviceId: scope.deviceId,
    baseline_refs: baselineRefs(),
    server_identity: serverIdentity(),
    signing_envelope: signingEnvelope(),
    auth_binding: authBinding(),
    receive_store_policy: receiveStorePolicy(contract),
    deletion_export_retention: deletionExportRetention(),
    replay_idempotency_watermarks: replayIdempotencyWatermarks(),
    offline_local_arms_status: offlineLocalArmsStatus(),
    server_to_local_intent_limits: serverToLocalIntentLimits(),
    bridge_delivery_proof_truth: bridgeDeliveryProofTruth(),
    migration_boundary: migrationBoundary(),
    acceptance_gate_summary: acceptanceGateSummary(),
    blocker_summary: blockerSummary(),
    evidenceRefs: [
      evidenceRef('baseline', BASELINE_COMMIT),
      evidenceRef('fixture', 'mira-core-server-runtime-gap-contract'),
    ],
    side_effect_result: sideEffectResult(),
  };
  assessment.idempotency_key = assessmentIdempotencyKey(assessment);
  assessment.assessment_id = `server-runtime-gap-${stableHash(assessment.idempotency_key).slice(0, 12)}`;
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
  const expected = contract.expectedGapAssessmentShape || {};
  const requiredIds = asArray(expected.requiredAcceptanceGateIds).length > 0
    ? expected.requiredAcceptanceGateIds
    : REQUIRED_GATE_IDS;
  return gates.length === requiredIds.length
    && requiredIds.every((id) => gates.some((gate) => gate.gate_id === id))
    && gates.every((gate) => hasRequiredFields(gate, expected.acceptanceGateSummaryRequiredFields || [])
      && gate.required_before_real_server === true
      && asArray(gate.evidenceRefs).length > 0);
}

function blockerSummaryOk(assessment, contract = {}) {
  const blockers = asArray(assessment.blocker_summary);
  const expected = contract.expectedGapAssessmentShape || {};
  const requiredIds = asArray(expected.requiredBlockerIds).length > 0
    ? expected.requiredBlockerIds
    : REQUIRED_BLOCKER_IDS;
  return blockers.length >= requiredIds.length
    && requiredIds.every((id) => blockers.some((blocker) => blocker.blocker_id === id))
    && blockers.every((blocker) => hasRequiredFields(blocker, expected.blockerSummaryRequiredFields || [])
      && asArray(blocker.evidenceRefs).length > 0);
}

function validateGapAssessment(assessment = {}, contract = {}) {
  const checks = [];
  const errors = [];
  const resultById = {};
  const add = (id, ok, detail = null, extra = {}) => {
    const result = resultObject(ok, detail, { id, ...extra });
    checks.push(result);
    resultById[id] = result;
    if (!ok && detail) errors.push(detail);
  };
  const expected = contract.expectedGapAssessmentShape || {};
  const reportExpected = contract.expectedValidationReportShape || {};

  add('output-shape-complete',
    assessment.schema === GAP_ASSESSMENT_SCHEMA_VERSION
      && hasRequiredFields(assessment, expected.requiredFields || REQUIRED_ASSESSMENT_FIELDS),
    'Server-runtime gap assessment shape is incomplete.');

  add('baseline-commit-pinned',
    assessment.baseline_commit === BASELINE_COMMIT
      && assessment.baseline_refs?.commit === BASELINE_COMMIT
      && assessment.migration_boundary?.phase_1_13_baseline_commit === BASELINE_COMMIT,
    'Baseline commit must stay pinned to 785dbec.');

  add('phase-14-validation-only',
    sideEffectValuesOk(assessment.side_effect_result, reportExpected.sideEffectRequiredValues || {}),
    'Phase 14 side-effect truth is unsafe.');

  add('server-identity-required-before-receive',
    sectionValuesOk(assessment.server_identity, expected.serverIdentityRequiredFields, expected.serverIdentityRequiredValues),
    'Server identity gate is incomplete or overclaimed.');

  add('signing-envelope-required-before-receive',
    sectionValuesOk(assessment.signing_envelope, expected.signingEnvelopeRequiredFields, expected.signingEnvelopeRequiredValues),
    'Signing envelope gate is incomplete or overclaimed.');

  add('auth-session-device-profile-binding-required',
    sectionValuesOk(assessment.auth_binding, expected.authBindingRequiredFields, expected.authBindingRequiredValues),
    'Auth binding gate is incomplete or overclaimed.');

  add('redacted-receive-store-eligibility-only',
    sectionValuesOk(assessment.receive_store_policy, expected.receiveStorePolicyRequiredFields, expected.receiveStorePolicyRequiredValues)
      && valuesMatch(assessment.receive_store_policy?.eligible_syncEligibility, expected.eligibleSyncEligibility)
      && valuesMatch(assessment.receive_store_policy?.eligible_redactionStatus, expected.eligibleRedactionStatus)
      && valuesMatch(assessment.receive_store_policy?.blocked_syncEligibility, expected.blockedSyncEligibility)
      && valuesMatch(assessment.receive_store_policy?.blocked_raw_classes, expected.blockedRawClasses),
    'Receive/store policy permits unsafe or unredacted items.');

  try {
    assertNoForbiddenOutput(assessment, asArray(contract.forbiddenOutputSubstrings));
    add('raw-private-content-blocked', true, null, {
      forbidden_output_result: 'blocked',
      raw_private_content_exported: false,
      secret_like_content_exported: false,
      side_profile_content_exported: false,
    });
  } catch (err) {
    add('raw-private-content-blocked', false, err.message, {
      forbidden_output_result: 'failed',
      raw_private_content_exported: true,
    });
  }

  add('deletion-export-retention-controls-required',
    sectionValuesOk(assessment.deletion_export_retention, expected.deletionExportRetentionRequiredFields, expected.deletionExportRetentionRequiredValues),
    'Deletion/export/retention gate is incomplete or overclaimed.');

  add('replay-idempotency-watermark-rules-required',
    sectionValuesOk(assessment.replay_idempotency_watermarks, expected.replayIdempotencyWatermarksRequiredFields, expected.replayIdempotencyWatermarksRequiredValues),
    'Replay/idempotency/watermark gate is incomplete or overclaimed.');

  add('offline-local-arms-truth-preserved',
    sectionValuesOk(assessment.offline_local_arms_status, expected.offlineLocalArmsStatusRequiredFields, expected.offlineLocalArmsStatusRequiredValues),
    'Offline local-arms status overclaimed execution or proof.');

  add('server-to-local-intents-architect-only',
    sectionValuesOk(assessment.server_to_local_intent_limits, expected.serverToLocalIntentLimitsRequiredFields, expected.serverToLocalIntentLimitsRequiredValues),
    'Server-to-local intent limits permit unsafe target, risk, queue, route, or execution.');

  add('bridge-delivery-proof-boundaries-preserved',
    sectionValuesOk(assessment.bridge_delivery_proof_truth, expected.bridgeDeliveryProofTruthRequiredFields, expected.bridgeDeliveryProofTruthRequiredValues),
    'Bridge or delivery proof boundary overclaimed.');

  add('migration-boundary-from-phase-1-13',
    sectionValuesOk(assessment.migration_boundary, expected.migrationBoundaryRequiredFields, expected.migrationBoundaryRequiredValues),
    'Migration boundary from Phase 1-13 is incomplete or overclaimed.');

  add('required-gates-and-blockers-present',
    gateSummaryOk(assessment, contract) && blockerSummaryOk(assessment, contract),
    'Required acceptance gates or blockers are missing.',
    {
      gate_count: asArray(assessment.acceptance_gate_summary).length,
      blocker_count: asArray(assessment.blocker_summary).length,
    });

  try {
    assertNoForbiddenOutput(assessment, asArray(contract.forbiddenOutputSubstrings));
    add('forbidden-output-strings-absent', true, null);
  } catch (err) {
    add('forbidden-output-strings-absent', false, err.message);
  }

  add('assessment-literal-values',
    literalValuesOk(assessment, expected.requiredLiteralValues || {}),
    'Gap assessment literal values changed.');

  add('idempotency-stable',
    assessment.idempotency_key === assessmentIdempotencyKey(assessment),
    'Gap assessment idempotency key is unstable.');

  return {
    ok: errors.length === 0,
    checks,
    errors,
    resultById,
  };
}

function buildValidationReport(assessment, contract = {}, generatedAt = assessment.generated_at) {
  const validation = validateGapAssessment(assessment, contract);
  const reasons = validation.checks.filter((check) => !check.ok).map((check) => check.detail || check.id);
  const report = {
    schema: VALIDATION_REPORT_SCHEMA_VERSION,
    version: SERVER_RUNTIME_GAP_VERSION,
    validation_run_id: `server-runtime-gap-validation-${stableHash({
      assessment_key: assessment.idempotency_key,
      generatedAt,
    }).slice(0, 12)}`,
    generated_at: generatedAt,
    fixture_schema: contract.schema || 'squidrun.mira_core.server_runtime_gap_contract_fixture.v0',
    gap_assessment_schema: GAP_ASSESSMENT_SCHEMA_VERSION,
    baseline_commit: BASELINE_COMMIT,
    required_shape_count: 12,
    static_rule_count: asArray(contract.staticValidationRules).length,
    acceptance_check_count: asArray(contract.acceptanceChecks).length,
    required_gate_count: asArray(contract.expectedGapAssessmentShape?.requiredAcceptanceGateIds || REQUIRED_GATE_IDS).length,
    required_blocker_count: asArray(contract.expectedGapAssessmentShape?.requiredBlockerIds || REQUIRED_BLOCKER_IDS).length,
    identity_signing_result: resultObject(
      validation.resultById['server-identity-required-before-receive']?.ok
        && validation.resultById['signing-envelope-required-before-receive']?.ok,
      null,
      {
        server_identity: validation.resultById['server-identity-required-before-receive'],
        signing_envelope: validation.resultById['signing-envelope-required-before-receive'],
      },
    ),
    auth_binding_result: validation.resultById['auth-session-device-profile-binding-required'] || resultObject(false),
    receive_store_result: validation.resultById['redacted-receive-store-eligibility-only'] || resultObject(false),
    deletion_export_retention_result: validation.resultById['deletion-export-retention-controls-required'] || resultObject(false),
    replay_watermark_result: validation.resultById['replay-idempotency-watermark-rules-required'] || resultObject(false),
    offline_local_arms_result: validation.resultById['offline-local-arms-truth-preserved'] || resultObject(false),
    server_to_local_intent_result: validation.resultById['server-to-local-intents-architect-only'] || resultObject(false),
    bridge_delivery_proof_result: validation.resultById['bridge-delivery-proof-boundaries-preserved'] || resultObject(false),
    migration_boundary_result: validation.resultById['migration-boundary-from-phase-1-13'] || resultObject(false),
    forbidden_output_result: validation.resultById['raw-private-content-blocked'] || resultObject(false),
    side_effect_result: sideEffectResult(),
    passed: validation.ok,
    reasons,
    evidenceRefs: [
      evidenceRef('validation', assessment.assessment_id, 'server_runtime_gap_validation'),
    ],
  };
  assertNoForbiddenOutput(report, asArray(contract.forbiddenOutputSubstrings));
  return report;
}

function buildMiraCoreServerRuntimeGap(options = {}) {
  const contract = options.contract || {};
  const assessment = buildGapAssessment(options);
  const validation_report = buildValidationReport(assessment, contract, assessment.generated_at);
  const output = {
    server_runtime_gap_assessment: assessment,
    validation_report,
  };
  assertNoForbiddenOutput(output, asArray(contract.forbiddenOutputSubstrings));
  return output;
}

function validateMiraCoreServerRuntimeGapOutput(output = {}, contract = {}) {
  const checks = [];
  const errors = [];
  const add = (id, ok, detail = null) => {
    checks.push({ id, ok: ok === true, detail });
    if (!ok && detail) errors.push(detail);
  };
  const assessment = output.server_runtime_gap_assessment || {};
  const report = output.validation_report || {};
  const assessmentValidation = validateGapAssessment(assessment, contract);

  add('output-shape-complete',
    hasRequiredFields(output, contract.expectedOutputShape?.requiredTopLevelFields || REQUIRED_OUTPUT_FIELDS)
      && assessment.schema === GAP_ASSESSMENT_SCHEMA_VERSION
      && report.schema === VALIDATION_REPORT_SCHEMA_VERSION
      && hasRequiredFields(assessment, contract.expectedGapAssessmentShape?.requiredFields || REQUIRED_ASSESSMENT_FIELDS)
      && hasRequiredFields(report, contract.expectedValidationReportShape?.requiredFields || REQUIRED_VALIDATION_REPORT_FIELDS),
    'Server-runtime gap output shape is incomplete.');

  for (const check of assessmentValidation.checks) add(check.id, check.ok, check.detail);

  add('validation-report-literals',
    Object.entries(contract.expectedValidationReportShape?.requiredLiteralValues || {}).every(([field, expected]) => valuesMatch(report[field], expected)),
    'Validation report literal values changed.');

  add('validation-side-effect-truth',
    sideEffectValuesOk(report.side_effect_result, contract.expectedValidationReportShape?.sideEffectRequiredValues || {}),
    'Validation report side-effect truth is unsafe.');

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

function assertNoForbiddenOutput(value, extraForbidden = []) {
  const output = JSON.stringify(value);
  for (const forbidden of [...FORBIDDEN_OUTPUT_SUBSTRINGS, ...extraForbidden]) {
    if (forbidden && output.includes(forbidden)) {
      throw new Error(`server_runtime_gap_forbidden_substring:${forbidden}`);
    }
  }
}

module.exports = {
  BASELINE_COMMIT,
  FORBIDDEN_OUTPUT_SUBSTRINGS,
  GAP_ASSESSMENT_SCHEMA_VERSION,
  REQUIRED_ASSESSMENT_FIELDS,
  REQUIRED_BLOCKER_IDS,
  REQUIRED_GATE_IDS,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  assessmentIdempotencyKey,
  buildMiraCoreServerRuntimeGap,
  canonicalAssessmentInput,
  stableHash,
  validateMiraCoreServerRuntimeGapOutput,
};
