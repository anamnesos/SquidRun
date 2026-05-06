'use strict';

const crypto = require('crypto');

const RUNTIME_SLICE_CANDIDATE_REPORT_SCHEMA_VERSION = 'squidrun.mira_core.runtime_slice_candidate_report.v0';
const VALIDATION_REPORT_SCHEMA_VERSION = 'squidrun.mira_core.runtime_slice_candidate_validation_report.v0';
const RUNTIME_SLICE_VERSION = 'v0';
const BASELINE_COMMIT = 'e062d16';
const CANDIDATE_SLICE_ID = 'runtime_slice_0_local_in_process_status_only';

const REQUIRED_OUTPUT_FIELDS = Object.freeze([
  'runtime_slice_candidate_report',
  'validation_report',
]);

const REQUIRED_REPORT_FIELDS = Object.freeze([
  'schema',
  'version',
  'candidate_report_id',
  'idempotency_key',
  'generated_at',
  'profile',
  'sessionId',
  'deviceId',
  'baseline_commit',
  'phase_24_dependency',
  'candidate_slice_identity',
  'phase25_non_authorization',
  'missing_gates_carried_forward',
  'future_eligibility_checklist',
  'blocked_now_checklist',
  'out_of_scope_now',
  'proof_boundaries',
  'safe_first_slice_constraints',
  'tamper_case_coverage',
  'next_safe_actions',
  'evidenceRefs',
  'side_effect_result',
]);

const REQUIRED_VALIDATION_REPORT_FIELDS = Object.freeze([
  'schema',
  'version',
  'report_id',
  'generated_at',
  'baseline_commit',
  'decision',
  'reasons',
  'phase_24_dependency_result',
  'candidate_identity_result',
  'non_authorization_result',
  'missing_gate_result',
  'future_eligibility_result',
  'blocked_now_result',
  'proof_boundary_result',
  'safe_constraint_result',
  'side_effect_result',
  'acceptance_checks',
  'failed_checks',
  'evidenceRefs',
]);

const REQUIRED_SIDE_EFFECT_FIELDS = Object.freeze([
  'no_runtime_performed',
  'no_server_performed',
  'no_listener_or_route_bound',
  'no_network_performed',
  'no_database_write_performed',
  'no_store_write_performed',
  'no_file_write_performed',
  'no_migration_executed',
  'no_queue_created',
  'no_lease_created',
  'no_auth_change_performed',
  'no_key_secret_operation_performed',
  'no_local_execution_performed',
  'no_send_performed',
  'no_deploy_performed',
  'no_trade_performed',
  'no_output_file_written',
]);

const SIDE_EFFECT_COUNTER_FIELDS = Object.freeze([
  'runtimeAttempts',
  'serverAttempts',
  'listenerRouteAttempts',
  'networkRequestsAttempted',
  'databaseWritesAttempted',
  'storeWritesAttempted',
  'fileWritesAttempted',
  'migrationsAttempted',
  'queuesCreated',
  'leasesCreated',
  'authChangesAttempted',
  'keySecretOperationsAttempted',
  'localExecutionAttempted',
  'sendsAttempted',
  'deploysAttempted',
  'tradesAttempted',
  'outputFilesWritten',
]);

const DEFAULT_MISSING_GATE_IDS = Object.freeze([
  'explicit-runtime-mode-flag',
  'local-only-dev-binding',
  'operator-kill-switch',
  'dry-run-fallback',
  'phase15-identity-signing-ref',
  'phase16-auth-binding-ref',
  'phase17-storage-retention-boundary-ref',
  'phase18-persistence-audit-boundary-ref',
  'phase19-encryption-key-ref',
  'phase20-server-api-ref',
  'phase21-server-handler-ref',
  'phase22-runtime-harness-ref',
  'phase23-milestone-readiness-current',
  'phase24-runtime-promotion-gate-current',
  'port-binding-plan-ref',
  'auth-secret-presence-ref',
  'storage-path-ref',
  'migration-plan-ref',
  'telemetry-audit-plan-ref',
  'rollback-disable-plan-ref',
]);

const DEFAULT_FUTURE_ELIGIBILITY_IDS = Object.freeze([
  'phase24-remains-current-and-reviewed',
  'all-missing-gates-satisfied-by-reference',
  'candidate-still-disabled-by-default',
  'operator-kill-switch-tested',
  'dry-run-fallback-tested',
  'rollback-disable-plan-reviewed',
  'telemetry-audit-plan-reviewed',
  'single-idempotent-status-request-only',
  'deterministic-status-response-only',
  'audit-preview-only-no-write',
  'no-raw-private-secret-content',
  'no-external-or-local-execution-side-effects',
]);

const DEFAULT_BLOCKED_NOW_IDS = Object.freeze([
  'runtime-availability-blocked-now',
  'server-listener-network-blocked-now',
  'store-queue-lease-blocked-now',
  'auth-key-secret-blocked-now',
  'local-execution-blocked-now',
  'send-deploy-trade-customer-blocked-now',
  'output-file-blocked-now',
  'eligibility-authorization-blocked-now',
]);

const DEFAULT_OUT_OF_SCOPE_IDS = Object.freeze([
  'real-runtime',
  'server-listener-routes',
  'network',
  'db-store-file-migration',
  'queue-lease',
  'auth-key-secret',
  'local-execution-shell-pty-browser',
  'send-deploy-trade-customer',
  'output-file',
]);

const DEFAULT_SAFE_FIRST_SLICE_CONSTRAINT_IDS = Object.freeze([
  'no-external-sends',
  'no-deploy-trade-customer-actions',
  'no-raw-private-secret-content',
  'no-durable-store-writes',
  'no-queue-lease-creation',
  'no-local-pty-shell-browser',
  'single-idempotent-request-only',
  'deterministic-status-response-only',
  'audit-preview-only',
]);

const DEFAULT_NEXT_SAFE_ACTION_IDS = Object.freeze([
  'implement-phase25-validator-only',
  'review-runtime-slice-0-spec-before-runtime',
]);

const DEFAULT_TAMPER_CASE_IDS = Object.freeze([
  'tamper-runtime-available-now',
  'tamper-eligibility-authorizes-runtime',
  'tamper-hidden-listener-network-store-queue',
  'tamper-unsafe-tier-or-action',
  'tamper-fake-proof',
  'tamper-missing-kill-switch-rollback-audit',
  'tamper-raw-secret-leak',
  'tamper-stale-phase24-baseline',
]);

const DEFAULT_FORBIDDEN_OUTPUT_SUBSTRINGS = Object.freeze([
  'runtime available now',
  'runtime authorized',
  'runtime enabled',
  'phase 25 satisfies phase 24',
  'candidate proves runtime',
  'runtime started',
  'daemon started',
  'server started',
  'listener bound',
  'route registered',
  'http server listening',
  'websocket listening',
  'network request performed',
  'database write performed',
  'store write performed',
  'file write performed',
  'migration executed',
  'queue created',
  'lease created',
  'auth changed',
  'key generated',
  'secret read',
  'local execution performed',
  'shell executed',
  'pty executed',
  'browser state captured',
  'screenshot captured',
  'ocr captured',
  'customer send performed',
  'external send performed',
  'deploy performed',
  'trade performed',
  'output file written',
  'socket proves bridge green',
  'delivery acceptance proves model processing',
  'server can execute local arms',
  'direct builder target allowed',
  'direct oracle target allowed',
  'eligible authorizes runtime',
  'tier3 promoted',
  'tier4 promoted',
  'raw terminal scrollback',
  'raw browser state',
  'raw screenshot',
  'raw ocr',
  'raw customer private',
  'side-profile payload',
  'source-store payload',
  'bearer token',
  'session secret',
  'auth secret value',
  'private key',
  'data key',
  'plaintext payload',
  'ciphertext payload',
  'decrypted payload',
]);

const UNSAFE_ACTION_PATTERN = /tier2|tier3|tier4|customer[_-]?send|deploy|trade|financial|local[_-]?execution/i;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function sortedValue(value) {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, key) => {
      acc[key] = sortedValue(value[key]);
      return acc;
    }, {});
  }
  return value;
}

function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(sortedValue(value))).digest('hex');
}

function pathValue(value, dottedPath) {
  return String(dottedPath || '').split('.').reduce((acc, key) => (
    acc && Object.prototype.hasOwnProperty.call(acc, key) ? acc[key] : undefined
  ), value);
}

function valuesMatch(a, b) {
  return JSON.stringify(sortedValue(a)) === JSON.stringify(sortedValue(b));
}

function hasRequiredFields(value, fields = []) {
  return Boolean(value) && asArray(fields).every((field) => Object.prototype.hasOwnProperty.call(value, field));
}

function idsEqual(items = [], field, expectedIds = []) {
  return valuesMatch(asArray(items).map((item) => item[field]), asArray(expectedIds));
}

function evidenceRef(store, eventId, relation = 'runtime_slice_candidate_validation') {
  return { store, eventId, relation };
}

function normalizeScope(inputSignals = {}) {
  const profile = inputSignals.profile || {};
  const profileName = inputSignals.profileName || profile.name || 'main';
  return {
    profile: {
      name: profileName,
      sessionScopeId: profile.sessionScopeId || profileName,
      windowKey: profile.windowKey || profileName,
    },
    sessionId: inputSignals.sessionId || 'session-328',
    deviceId: inputSignals.deviceId || 'VIGIL',
  };
}

function generatedAtFromOptions(options = {}, inputSignals = {}) {
  if (options.generatedAt) return options.generatedAt;
  if (inputSignals.generatedAt) return inputSignals.generatedAt;
  if (typeof options.nowMs === 'number') return new Date(options.nowMs).toISOString();
  return new Date().toISOString();
}

function runtimeSliceExpected(contract = {}) {
  return contract.expectedRuntimeSliceCandidateReportShape || {};
}

function requiredMissingGateIds(contract = {}) {
  return asArray(runtimeSliceExpected(contract).requiredMissingGateIds).length > 0
    ? runtimeSliceExpected(contract).requiredMissingGateIds
    : DEFAULT_MISSING_GATE_IDS;
}

function futureEligibilityIds(contract = {}) {
  return asArray(runtimeSliceExpected(contract).futureEligibilityChecklistRequiredIds).length > 0
    ? runtimeSliceExpected(contract).futureEligibilityChecklistRequiredIds
    : DEFAULT_FUTURE_ELIGIBILITY_IDS;
}

function blockedNowIds(contract = {}) {
  return asArray(runtimeSliceExpected(contract).blockedNowChecklistRequiredIds).length > 0
    ? runtimeSliceExpected(contract).blockedNowChecklistRequiredIds
    : DEFAULT_BLOCKED_NOW_IDS;
}

function outOfScopeIds(contract = {}) {
  return asArray(runtimeSliceExpected(contract).outOfScopeNowRequiredIds).length > 0
    ? runtimeSliceExpected(contract).outOfScopeNowRequiredIds
    : DEFAULT_OUT_OF_SCOPE_IDS;
}

function safeConstraintIds(contract = {}) {
  return asArray(runtimeSliceExpected(contract).safeFirstSliceConstraintRequiredIds).length > 0
    ? runtimeSliceExpected(contract).safeFirstSliceConstraintRequiredIds
    : DEFAULT_SAFE_FIRST_SLICE_CONSTRAINT_IDS;
}

function nextSafeActionIds(contract = {}) {
  return asArray(runtimeSliceExpected(contract).nextSafeActionRequiredIds).length > 0
    ? runtimeSliceExpected(contract).nextSafeActionRequiredIds
    : DEFAULT_NEXT_SAFE_ACTION_IDS;
}

function sideEffectResult() {
  return {
    no_runtime_performed: true,
    no_server_performed: true,
    no_listener_or_route_bound: true,
    no_network_performed: true,
    no_database_write_performed: true,
    no_store_write_performed: true,
    no_file_write_performed: true,
    no_migration_executed: true,
    no_queue_created: true,
    no_lease_created: true,
    no_auth_change_performed: true,
    no_key_secret_operation_performed: true,
    no_local_execution_performed: true,
    no_send_performed: true,
    no_deploy_performed: true,
    no_trade_performed: true,
    no_output_file_written: true,
    runtimeAttempts: 0,
    serverAttempts: 0,
    listenerRouteAttempts: 0,
    networkRequestsAttempted: 0,
    databaseWritesAttempted: 0,
    storeWritesAttempted: 0,
    fileWritesAttempted: 0,
    migrationsAttempted: 0,
    queuesCreated: 0,
    leasesCreated: 0,
    authChangesAttempted: 0,
    keySecretOperationsAttempted: 0,
    localExecutionAttempted: 0,
    sendsAttempted: 0,
    deploysAttempted: 0,
    tradesAttempted: 0,
    outputFilesWritten: 0,
    outputFileWritten: false,
  };
}

function phase24Dependency() {
  return {
    dependency_id: 'phase_24_runtime_promotion_gate',
    fixture_path: 'ui/__tests__/fixtures/mira-core-runtime-promotion-gate-contract.json',
    module_path: 'ui/modules/mira-core/runtime-promotion-gate.js',
    cli_path: 'ui/scripts/hm-mira-core-runtime-promotion-gate.js',
    test_path: 'ui/__tests__/mira-core-runtime-promotion-gate.test.js',
    baseline_commit: BASELINE_COMMIT,
    status: 'promotion_gate_green_remain_validation_only',
    current_decision: 'remain_validation_only',
    eligible_is_authorization: false,
    runtime_started: false,
    no_runtime_performed: true,
    phase23_dependency_current_through_phase: 22,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-promotion-gate', 'phase24-current-remain-validation-only'),
      evidenceRef('git', BASELINE_COMMIT, 'phase24_baseline_commit'),
    ],
  };
}

function candidateSliceIdentity() {
  return {
    slice_id: CANDIDATE_SLICE_ID,
    title: 'Local in-process status-only candidate slice',
    local_only: true,
    dev_only: true,
    disabled_by_default: true,
    operator_visible: true,
    read_only_status_control_plane_validation_only: true,
    runtime_available_now: false,
    allowed_future_request_count: 1,
    future_request_semantics: 'single_idempotent_status_request_after_future_review',
    future_response_semantics: 'deterministic_status_metadata_only_with_audit_preview',
    evidenceRefs: [
      evidenceRef('mira-core-runtime-slice', CANDIDATE_SLICE_ID),
    ],
  };
}

function phase25NonAuthorization(missingGateCount) {
  return {
    does_not_satisfy_phase24_prerequisites: true,
    does_not_authorize_runtime: true,
    does_not_enable_runtime: true,
    eligibility_is_future_review_only: true,
    missing_gate_count: missingGateCount,
    safe_next_action: 'Keep this as a validator-only candidate review.',
    evidenceRefs: [
      evidenceRef('mira-core-runtime-slice', 'phase25-non-authorization'),
    ],
  };
}

function sourcePhaseForGate(gateId) {
  if (/phase15/.test(gateId)) return 'phase_15_identity_signing';
  if (/phase16/.test(gateId)) return 'phase_16_auth_binding';
  if (/phase17/.test(gateId)) return 'phase_17_storage_retention';
  if (/phase18/.test(gateId)) return 'phase_18_persistence_audit';
  if (/phase19/.test(gateId)) return 'phase_19_encryption_key';
  if (/phase20/.test(gateId)) return 'phase_20_server_api';
  if (/phase21/.test(gateId)) return 'phase_21_server_handler';
  if (/phase22/.test(gateId)) return 'phase_22_runtime_harness';
  if (/phase23/.test(gateId)) return 'phase_23_milestone_readiness';
  if (/phase24/.test(gateId)) return 'phase_24_runtime_promotion_gate';
  return 'phase_24_runtime_promotion_gate';
}

function missingGates(contract = {}) {
  return requiredMissingGateIds(contract).map((gateId) => ({
    gate_id: gateId,
    source_phase: sourcePhaseForGate(gateId),
    status: 'required_reference_missing',
    required_before_future_eligibility: true,
    blocks_runtime_now: true,
    reference_only: true,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-slice', `missing-gate:${gateId}`),
    ],
  }));
}

function futureEligibilityChecklist(contract = {}) {
  return futureEligibilityIds(contract).map((checkId) => ({
    check_id: checkId,
    status: 'future_review_required',
    future_only: true,
    non_authorizing: true,
    satisfied_now: false,
    required_before_future_eligibility: true,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-slice', `future-eligibility:${checkId}`),
    ],
  }));
}

function blockedNowChecklist(contract = {}) {
  return blockedNowIds(contract).map((blockId) => ({
    block_id: blockId,
    blocked_now: true,
    decision: 'blocked_now',
    safe_alternative: 'Represent the boundary in validation metadata only.',
    evidenceRefs: [
      evidenceRef('mira-core-runtime-slice', `blocked-now:${blockId}`),
    ],
  }));
}

function outOfScopeNow(contract = {}) {
  return outOfScopeIds(contract).map((scopeId) => ({
    scope_id: scopeId,
    out_of_scope_now: true,
    allowed_in_phase25: false,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-slice', `out-of-scope:${scopeId}`),
    ],
  }));
}

function proofBoundaries() {
  return {
    socket_is_bridge_green_proof: false,
    delivery_acceptance_is_model_processing_proof: false,
    runtime_candidate_is_runtime_proof: false,
    server_can_execute_local_arms: false,
    builder_direct_server_target_allowed: false,
    oracle_direct_server_target_allowed: false,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-slice', 'proof-boundaries'),
    ],
  };
}

function safeFirstSliceConstraints(contract = {}) {
  return safeConstraintIds(contract).map((constraintId) => ({
    constraint_id: constraintId,
    required: true,
    enforced_for_future_review: true,
    currently_validation_only: true,
    evidenceRefs: [
      evidenceRef('mira-core-runtime-slice', `constraint:${constraintId}`),
    ],
  }));
}

function tamperCaseCoverage(contract = {}) {
  const fixtureCases = asArray(contract.tamperCases);
  const ids = fixtureCases.length > 0 ? fixtureCases.map((item) => item.id) : DEFAULT_TAMPER_CASE_IDS;
  return ids.map((caseId) => ({
    tamper_case_id: caseId,
    covered: true,
    expected_failure_checks: clone(fixtureCases.find((item) => item.id === caseId)?.expected_failure_checks || []),
    evidenceRefs: [
      evidenceRef('mira-core-runtime-slice-tests', caseId),
    ],
  }));
}

function nextSafeActions(contract = {}) {
  const titles = {
    'implement-phase25-validator-only': 'Finish the Phase 25 validator',
    'review-runtime-slice-0-spec-before-runtime': 'Review the slice 0 candidate before any later implementation',
  };
  return nextSafeActionIds(contract).map((actionId) => ({
    action_id: actionId,
    title: titles[actionId] || actionId.replace(/-/g, ' '),
    risk_tier: 'tier0_read_only',
    allowed: true,
    why_safe: 'This only inspects the candidate contract and reports readiness gaps.',
    evidenceRefs: [
      evidenceRef('mira-core-runtime-slice', `next-safe-action:${actionId}`),
    ],
  }));
}

function canonicalCandidateReportInput(report) {
  return {
    baseline_commit: report.baseline_commit,
    profile: report.profile,
    sessionId: report.sessionId,
    deviceId: report.deviceId,
    phase_24_dependency: report.phase_24_dependency,
    candidate_slice_identity: report.candidate_slice_identity,
    phase25_non_authorization: report.phase25_non_authorization,
    missing_gates_carried_forward: report.missing_gates_carried_forward,
    future_eligibility_checklist: report.future_eligibility_checklist,
    blocked_now_checklist: report.blocked_now_checklist,
    out_of_scope_now: report.out_of_scope_now,
    proof_boundaries: report.proof_boundaries,
    safe_first_slice_constraints: report.safe_first_slice_constraints,
    tamper_case_coverage: report.tamper_case_coverage,
    next_safe_actions: report.next_safe_actions,
    side_effect_result: report.side_effect_result,
  };
}

function runtimeSliceIdempotencyKey(report) {
  return `runtime-slice-candidate:${stableHash(canonicalCandidateReportInput(report))}`;
}

function buildCandidateReport(options = {}) {
  const contract = options.contract || {};
  const inputSignals = options.inputSignals || {};
  const scope = normalizeScope(inputSignals);
  const generatedAt = generatedAtFromOptions(options, inputSignals);
  const gates = missingGates(contract);
  const report = {
    schema: RUNTIME_SLICE_CANDIDATE_REPORT_SCHEMA_VERSION,
    version: RUNTIME_SLICE_VERSION,
    candidate_report_id: null,
    idempotency_key: null,
    generated_at: generatedAt,
    profile: scope.profile,
    sessionId: scope.sessionId,
    deviceId: scope.deviceId,
    baseline_commit: BASELINE_COMMIT,
    phase_24_dependency: phase24Dependency(),
    candidate_slice_identity: candidateSliceIdentity(),
    phase25_non_authorization: phase25NonAuthorization(gates.length),
    missing_gates_carried_forward: gates,
    future_eligibility_checklist: futureEligibilityChecklist(contract),
    blocked_now_checklist: blockedNowChecklist(contract),
    out_of_scope_now: outOfScopeNow(contract),
    proof_boundaries: proofBoundaries(),
    safe_first_slice_constraints: safeFirstSliceConstraints(contract),
    tamper_case_coverage: tamperCaseCoverage(contract),
    next_safe_actions: nextSafeActions(contract),
    evidenceRefs: [
      evidenceRef('mira-core-runtime-slice', 'phase25-candidate-report'),
      evidenceRef('git', BASELINE_COMMIT, 'phase24_baseline_commit'),
    ],
    side_effect_result: sideEffectResult(),
  };
  report.idempotency_key = runtimeSliceIdempotencyKey(report);
  report.candidate_report_id = `runtime-slice-candidate-${stableHash(report.idempotency_key).slice(0, 12)}`;
  assertNoForbiddenOutput(report, asArray(contract.forbiddenOutputSubstrings));
  return report;
}

function resultObject(ok, detail = null, extra = {}) {
  return {
    ok: ok === true,
    detail,
    ...extra,
  };
}

function literalValuesOk(value, literals = {}) {
  return Object.entries(literals || {}).every(([field, expected]) => valuesMatch(pathValue(value, field), expected));
}

function sideEffectValuesOk(value = {}) {
  return REQUIRED_SIDE_EFFECT_FIELDS.every((field) => value[field] === true)
    && SIDE_EFFECT_COUNTER_FIELDS.every((field) => value[field] === undefined || Number(value[field]) === 0)
    && value.outputFileWritten !== true;
}

function phase24DependencyOk(report, contract = {}) {
  const dependency = report.phase_24_dependency || {};
  const expected = runtimeSliceExpected(contract);
  return hasRequiredFields(dependency, expected.phase24DependencyRequiredFields || [])
    && Object.entries(expected.phase24DependencyRequiredValues || {}).every(([field, value]) => valuesMatch(dependency[field], value))
    && dependency.baseline_commit === BASELINE_COMMIT
    && dependency.current_decision === 'remain_validation_only'
    && dependency.eligible_is_authorization === false
    && dependency.runtime_started === false
    && dependency.no_runtime_performed === true
    && asArray(dependency.evidenceRefs).length > 0;
}

function candidateIdentityOk(report, contract = {}) {
  const candidate = report.candidate_slice_identity || {};
  const expected = runtimeSliceExpected(contract);
  return hasRequiredFields(candidate, expected.candidateSliceIdentityRequiredFields || [])
    && candidate.slice_id === CANDIDATE_SLICE_ID
    && candidate.local_only === true
    && candidate.dev_only === true
    && candidate.disabled_by_default === true
    && candidate.operator_visible === true
    && candidate.read_only_status_control_plane_validation_only === true
    && candidate.runtime_available_now === false
    && candidate.allowed_future_request_count === 1
    && typeof candidate.future_request_semantics === 'string'
    && typeof candidate.future_response_semantics === 'string'
    && asArray(candidate.evidenceRefs).length > 0;
}

function nonAuthorizationOk(report, contract = {}) {
  const nonAuth = report.phase25_non_authorization || {};
  const expected = runtimeSliceExpected(contract);
  const requiredGateCount = requiredMissingGateIds(contract).length;
  return hasRequiredFields(nonAuth, expected.phase25NonAuthorizationRequiredFields || [])
    && nonAuth.does_not_satisfy_phase24_prerequisites === true
    && nonAuth.does_not_authorize_runtime === true
    && nonAuth.does_not_enable_runtime === true
    && nonAuth.eligibility_is_future_review_only === true
    && nonAuth.missing_gate_count === requiredGateCount
    && typeof nonAuth.safe_next_action === 'string'
    && asArray(nonAuth.evidenceRefs).length > 0;
}

function missingGatesOk(report, contract = {}) {
  const gates = asArray(report.missing_gates_carried_forward);
  const expected = runtimeSliceExpected(contract);
  const requiredIds = requiredMissingGateIds(contract);
  return gates.length === requiredIds.length
    && idsEqual(gates, 'gate_id', requiredIds)
    && gates.every((gate) => hasRequiredFields(gate, expected.missingGateRequiredFields || [])
      && gate.status === 'required_reference_missing'
      && gate.required_before_future_eligibility === true
      && gate.blocks_runtime_now === true
      && gate.reference_only === true
      && typeof gate.source_phase === 'string'
      && asArray(gate.evidenceRefs).length > 0);
}

function futureEligibilityOk(report, contract = {}) {
  const checks = asArray(report.future_eligibility_checklist);
  const requiredIds = futureEligibilityIds(contract);
  return checks.length === requiredIds.length
    && idsEqual(checks, 'check_id', requiredIds)
    && checks.every((check) => check.future_only === true
      && check.non_authorizing === true
      && check.satisfied_now === false
      && check.required_before_future_eligibility === true
      && asArray(check.evidenceRefs).length > 0);
}

function blockedNowOk(report, contract = {}) {
  const blocks = asArray(report.blocked_now_checklist);
  const requiredIds = blockedNowIds(contract);
  return blocks.length === requiredIds.length
    && idsEqual(blocks, 'block_id', requiredIds)
    && blocks.every((block) => block.blocked_now === true
      && block.decision === 'blocked_now'
      && asArray(block.evidenceRefs).length > 0);
}

function outOfScopeOk(report, contract = {}) {
  const scopes = asArray(report.out_of_scope_now);
  const requiredIds = outOfScopeIds(contract);
  return scopes.length === requiredIds.length
    && idsEqual(scopes, 'scope_id', requiredIds)
    && scopes.every((scope) => scope.out_of_scope_now === true
      && scope.allowed_in_phase25 === false
      && asArray(scope.evidenceRefs).length > 0)
    && sideEffectValuesOk(report.side_effect_result);
}

function proofBoundariesOk(report, contract = {}) {
  const proof = report.proof_boundaries || {};
  const expected = runtimeSliceExpected(contract);
  return hasRequiredFields(proof, expected.proofBoundaryRequiredFields || [])
    && proof.socket_is_bridge_green_proof === false
    && proof.delivery_acceptance_is_model_processing_proof === false
    && proof.runtime_candidate_is_runtime_proof === false
    && proof.server_can_execute_local_arms === false
    && proof.builder_direct_server_target_allowed === false
    && proof.oracle_direct_server_target_allowed === false
    && asArray(proof.evidenceRefs).length > 0;
}

function safeConstraintsOk(report, contract = {}) {
  const constraints = asArray(report.safe_first_slice_constraints);
  const requiredIds = safeConstraintIds(contract);
  return constraints.length === requiredIds.length
    && idsEqual(constraints, 'constraint_id', requiredIds)
    && constraints.every((constraint) => constraint.required === true
      && constraint.enforced_for_future_review === true
      && constraint.currently_validation_only === true
      && asArray(constraint.evidenceRefs).length > 0);
}

function nextSafeActionsOk(report, contract = {}) {
  const actions = asArray(report.next_safe_actions);
  const requiredIds = nextSafeActionIds(contract);
  return actions.length === requiredIds.length
    && idsEqual(actions, 'action_id', requiredIds)
    && actions.every((action) => action.allowed === true
      && /^tier[01]_/.test(action.risk_tier)
      && typeof action.why_safe === 'string'
      && asArray(action.evidenceRefs).length > 0);
}

function tamperCoverageOk(report, contract = {}) {
  const requiredIds = asArray(contract.tamperCases).length > 0
    ? contract.tamperCases.map((item) => item.id)
    : DEFAULT_TAMPER_CASE_IDS;
  const coverage = asArray(report.tamper_case_coverage);
  return coverage.length === requiredIds.length
    && idsEqual(coverage, 'tamper_case_id', requiredIds)
    && coverage.every((item) => item.covered === true && asArray(item.evidenceRefs).length > 0);
}

function killSwitchRollbackAuditOk(report) {
  const gateIds = asArray(report.missing_gates_carried_forward).map((gate) => gate.gate_id);
  return gateIds.includes('operator-kill-switch')
    && gateIds.includes('dry-run-fallback')
    && gateIds.includes('rollback-disable-plan-ref')
    && gateIds.includes('telemetry-audit-plan-ref');
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
  const strings = collectStringValues(value);
  for (const forbidden of [...DEFAULT_FORBIDDEN_OUTPUT_SUBSTRINGS, ...extraForbidden]) {
    if (!forbidden) continue;
    if (strings.some((entry) => entry.includes(forbidden))) {
      throw new Error(`runtime_slice_forbidden_substring:${forbidden}`);
    }
  }
}

function collectKeyedValues(value, acc = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectKeyedValues(item, acc);
    return acc;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      acc.push({ key, value: item });
      collectKeyedValues(item, acc);
    }
  }
  return acc;
}

function unsafeTierOrActionOk(report) {
  const keyedValues = collectKeyedValues(report);
  return !keyedValues.some(({ key, value }) => {
    if (!/(risk|requested|allowed|action|tier|promotion|authorize|enable)/i.test(key)) return false;
    if (Array.isArray(value)) return value.some((item) => typeof item === 'string' && UNSAFE_ACTION_PATTERN.test(item));
    if (typeof value === 'string') return UNSAFE_ACTION_PATTERN.test(value);
    return false;
  }) && safeConstraintsOk(report, {});
}

function validateCandidateReport(report = {}, contract = {}) {
  const checks = [];
  const errors = [];
  const resultById = {};
  const add = (id, ok, detail = null, extra = {}) => {
    const result = resultObject(ok, detail, { id, ...extra });
    checks.push(result);
    resultById[id] = result;
    if (!ok && detail) errors.push(detail);
  };
  const expected = runtimeSliceExpected(contract);

  add('output-shape-complete',
    report.schema === RUNTIME_SLICE_CANDIDATE_REPORT_SCHEMA_VERSION
      && hasRequiredFields(report, expected.requiredFields || REQUIRED_REPORT_FIELDS),
    'Runtime slice candidate report shape is incomplete.');

  add('baseline-e062d16-pinned',
    report.baseline_commit === BASELINE_COMMIT,
    'Baseline commit must stay pinned to e062d16.');

  add('phase24-remain-validation-only-required',
    phase24DependencyOk(report, contract),
    'Phase 24 dependency must remain current and validation-only.');

  add('candidate-identity-status-only',
    candidateIdentityOk(report, contract),
    'Candidate identity overclaims or changed.');

  add('phase25-non-authorization-explicit',
    nonAuthorizationOk(report, contract),
    'Phase 25 non-authorization statement is missing or unsafe.');

  add('missing-gates-carried-forward-complete',
    missingGatesOk(report, contract),
    'Required missing gates are not carried forward.');

  add('future-eligibility-checklist-complete',
    futureEligibilityOk(report, contract),
    'Future eligibility checklist is incomplete or authorizing.');

  add('blocked-now-checklist-complete',
    blockedNowOk(report, contract),
    'Blocked-now checklist is incomplete.');

  add('out-of-scope-side-effects-blocked',
    outOfScopeOk(report, contract),
    'Out-of-scope behavior or side-effect truth is unsafe.');

  add('proof-boundaries-preserved',
    proofBoundariesOk(report, contract),
    'Proof boundaries were overclaimed.');

  add('safe-first-slice-constraints-complete',
    safeConstraintsOk(report, contract),
    'Safe first-slice constraints are incomplete.');

  add('unsafe-tier-action-drift-rejected',
    unsafeTierOrActionOk(report),
    'Unsafe tier or action drift was accepted.');

  try {
    assertNoForbiddenOutput(report, asArray(contract.forbiddenOutputSubstrings));
    add('raw-private-secret-leakage-rejected', true, null);
  } catch (err) {
    add('raw-private-secret-leakage-rejected', false, err.message);
  }

  add('fake-proof-rejected',
    proofBoundariesOk(report, contract)
      && report.phase25_non_authorization?.does_not_authorize_runtime === true
      && report.candidate_slice_identity?.runtime_available_now === false,
    'Fake proof or runtime overclaim was accepted.');

  add('kill-switch-rollback-audit-required',
    killSwitchRollbackAuditOk(report),
    'Kill switch, dry-run, rollback, or audit gates are missing.');

  add('tamper-coverage-complete',
    tamperCoverageOk(report, contract),
    'Tamper case coverage is incomplete.');

  add('next-safe-actions-complete',
    nextSafeActionsOk(report, contract),
    'Next safe actions are missing or unsafe.');

  add('side-effects-blocked-now',
    sideEffectValuesOk(report.side_effect_result),
    'Phase 25 side-effect truth is unsafe.');

  add('overclaiming-runtime-availability-rejected',
    report.candidate_slice_identity?.runtime_available_now === false
      && report.candidate_slice_identity?.disabled_by_default === true
      && report.proof_boundaries?.runtime_candidate_is_runtime_proof === false,
    'Runtime availability overclaim was accepted.');

  add('eligibility-as-authorization-rejected',
    report.phase25_non_authorization?.does_not_authorize_runtime === true
      && report.phase25_non_authorization?.eligibility_is_future_review_only === true,
    'Eligibility was treated as authorization.');

  add('stale-phase24-baseline-rejected',
    report.phase_24_dependency?.baseline_commit === BASELINE_COMMIT
      && report.phase_24_dependency?.current_decision === 'remain_validation_only',
    'Stale Phase 24 baseline or decision was accepted.');

  add('idempotency-sensitive-to-candidate-gates',
    report.idempotency_key === runtimeSliceIdempotencyKey(report),
    'Runtime slice candidate idempotency key is unstable.');

  add('report-literal-values',
    literalValuesOk(report, expected.requiredLiteralValues || {}),
    'Runtime slice candidate literal values changed.');

  return {
    ok: errors.length === 0,
    checks,
    errors,
    resultById,
  };
}

function buildValidationReport(candidateReport, contract = {}, generatedAt = candidateReport.generated_at) {
  const validation = validateCandidateReport(candidateReport, contract);
  const failed = validation.checks.filter((check) => !check.ok);
  const checkResult = (id) => validation.resultById[id] || resultObject(false, `${id} missing`);
  const report = {
    schema: VALIDATION_REPORT_SCHEMA_VERSION,
    version: RUNTIME_SLICE_VERSION,
    report_id: `runtime-slice-validation-${stableHash({
      candidate_key: candidateReport.idempotency_key,
      generatedAt,
    }).slice(0, 12)}`,
    generated_at: generatedAt,
    baseline_commit: BASELINE_COMMIT,
    decision: validation.ok ? 'accepted' : 'blocked',
    reasons: failed.map((check) => check.detail || check.id),
    phase_24_dependency_result: checkResult('phase24-remain-validation-only-required'),
    candidate_identity_result: checkResult('candidate-identity-status-only'),
    non_authorization_result: checkResult('phase25-non-authorization-explicit'),
    missing_gate_result: checkResult('missing-gates-carried-forward-complete'),
    future_eligibility_result: checkResult('future-eligibility-checklist-complete'),
    blocked_now_result: checkResult('blocked-now-checklist-complete'),
    proof_boundary_result: checkResult('proof-boundaries-preserved'),
    safe_constraint_result: checkResult('safe-first-slice-constraints-complete'),
    side_effect_result: sideEffectResult(),
    acceptance_checks: asArray(contract.acceptanceChecks).map((check) => ({
      id: check.id,
      ok: validation.ok,
      focus: check.focus,
    })),
    failed_checks: failed.map((check) => check.id),
    evidenceRefs: [
      evidenceRef('mira-core-runtime-slice', 'phase25-validation-report'),
    ],
  };
  assertNoForbiddenOutput(report, asArray(contract.forbiddenOutputSubstrings));
  return report;
}

function buildMiraCoreRuntimeSlice(options = {}) {
  const contract = options.contract || {};
  const candidateReport = buildCandidateReport(options);
  const validation_report = buildValidationReport(candidateReport, contract, candidateReport.generated_at);
  const output = {
    runtime_slice_candidate_report: candidateReport,
    validation_report,
  };
  assertNoForbiddenOutput(output, asArray(contract.forbiddenOutputSubstrings));
  return output;
}

function validateMiraCoreRuntimeSliceOutput(output = {}, contract = {}) {
  const checks = [];
  const errors = [];
  const add = (id, ok, detail = null) => {
    checks.push({ id, ok: ok === true, detail });
    if (!ok && detail) errors.push(detail);
  };
  const candidateReport = output.runtime_slice_candidate_report || {};
  const validationReport = output.validation_report || {};
  const candidateValidation = validateCandidateReport(candidateReport, contract);

  add('output-shape-complete',
    hasRequiredFields(output, contract.expectedOutputShape?.requiredTopLevelFields || REQUIRED_OUTPUT_FIELDS)
      && candidateReport.schema === RUNTIME_SLICE_CANDIDATE_REPORT_SCHEMA_VERSION
      && validationReport.schema === VALIDATION_REPORT_SCHEMA_VERSION
      && hasRequiredFields(candidateReport, contract.expectedRuntimeSliceCandidateReportShape?.requiredFields || REQUIRED_REPORT_FIELDS)
      && hasRequiredFields(validationReport, contract.expectedValidationReportShape?.requiredFields || REQUIRED_VALIDATION_REPORT_FIELDS),
    'Runtime slice candidate output shape is incomplete.');

  for (const check of candidateValidation.checks) add(check.id, check.ok, check.detail);

  add('validation-report-literal-values',
    validationReport.schema === VALIDATION_REPORT_SCHEMA_VERSION
      && validationReport.baseline_commit === BASELINE_COMMIT
      && literalValuesOk(validationReport, contract.expectedValidationReportShape?.requiredLiteralValues || {}),
    'Validation report literal values changed.');

  add('validation-report-side-effect-truth',
    sideEffectValuesOk(validationReport.side_effect_result),
    'Validation report side-effect truth is unsafe.');

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

module.exports = {
  BASELINE_COMMIT,
  CANDIDATE_SLICE_ID,
  DEFAULT_BLOCKED_NOW_IDS,
  DEFAULT_FUTURE_ELIGIBILITY_IDS,
  DEFAULT_MISSING_GATE_IDS,
  DEFAULT_OUT_OF_SCOPE_IDS,
  DEFAULT_SAFE_FIRST_SLICE_CONSTRAINT_IDS,
  DEFAULT_TAMPER_CASE_IDS,
  REQUIRED_OUTPUT_FIELDS,
  REQUIRED_REPORT_FIELDS,
  REQUIRED_SIDE_EFFECT_FIELDS,
  REQUIRED_VALIDATION_REPORT_FIELDS,
  RUNTIME_SLICE_CANDIDATE_REPORT_SCHEMA_VERSION,
  VALIDATION_REPORT_SCHEMA_VERSION,
  assertNoForbiddenOutput,
  buildMiraCoreRuntimeSlice,
  runtimeSliceIdempotencyKey,
  stableHash,
  validateMiraCoreRuntimeSliceOutput,
};
